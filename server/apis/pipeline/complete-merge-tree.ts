import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { MERGE_PROMPTS, FINDINGS_RULE_FINAL } from "../modules/merge-findings.js";
import { parseCanonicalFindings } from "./canonical-finding.js";
import { getModuleModel } from "./model-config.js";
import { enforceNarrativeBoundary } from "./narrative-enforcement.js";
import { validateMergeContract } from "./merge-contract-validator.js";
import { deduplicateFindings } from "./canonical-family-dedup.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

/**
 * Targeted merge-finalizer: completes an incomplete merge tree by merging
 * the remaining top-level nodes into a single root, then persists the output.
 *
 * For run 1c5e9191: 3 nodes at level 4 need to be merged into 1 root.
 * This API does exactly that in a single Anthropic call, then saves.
 */
export default api({
  name: "CompleteMergeTree",
  description: "Merges remaining top-level nodes into root and saves final output",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    moduleId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    phase: z.string(),
    topLevel: z.number(),
    nodesAtTop: z.number(),
    mergedFindings: z.number(),
    reportLength: z.number(),
    outputId: z.string().nullable(),
    error: z.string().nullable(),
  }),

  async run(ctx, { runId, dealId, moduleId }) {
    // Step 1: Find the incomplete top level
    const levels = await ctx.integrations.db.query(
      `SELECT tree_level, count(*)::int AS count
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete'
       GROUP BY tree_level
       ORDER BY tree_level DESC
       LIMIT 5`,
      z.object({ tree_level: z.coerce.number(), count: z.number() }),
      [runId],
      { label: "CompleteMerge: find top levels" }
    );

    if (levels.length === 0) {
      return { success: false, phase: "no_checkpoints", topLevel: 0, nodesAtTop: 0, mergedFindings: 0, reportLength: 0, outputId: null, error: "No merge checkpoints found" };
    }

    const topLevel = levels[0].tree_level;
    const nodesAtTop = levels[0].count;

    if (nodesAtTop === 1) {
      // Tree already has a single root — just save the output
      return { success: true, phase: "already_complete", topLevel, nodesAtTop: 1, mergedFindings: 0, reportLength: 0, outputId: null, error: null };
    }

    console.log(`[CompleteMerge] Top level=${topLevel} has ${nodesAtTop} nodes — need to merge to 1 root`);

    // Step 2: Load the top-level nodes
    const TopNodeSchema = z.object({
      node_index: z.coerce.number(),
      executive_header: z.string(),
      findings_json: z.string(),
      text_preview: z.string(),
    });

    const topNodes = await ctx.integrations.db.query(
      `SELECT node_index,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
              LEFT(COALESCE(merged_json->>'text', ''), 50000) AS text_preview
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND tree_level = $2
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY node_index ASC`,
      TopNodeSchema,
      [runId, topLevel],
      { label: `CompleteMerge: load ${nodesAtTop} top nodes` }
    );

    if (topNodes.length < 2) {
      return { success: false, phase: "insufficient_nodes", topLevel, nodesAtTop: topNodes.length, mergedFindings: 0, reportLength: 0, outputId: null, error: `Expected ${nodesAtTop} nodes but loaded ${topNodes.length}` };
    }

    // Step 3: Build merge prompt input (same format as pipeline)
    const setBlocks = topNodes.map((n, i) => {
      const findings = JSON.parse(n.findings_json);
      const structuredFindings = findings.map((f: any) => ({
        finding_id: f.finding_id,
        severity: f.severity,
        title: f.title,
        issue_key: f.issue_key,
        claim_ids: f.claim_ids,
      }));
      const findingsBlock = findings.length > 0
        ? `\n\n### Structured Findings from Set ${i + 1} (reference by finding_id in merged_from_finding_ids)\n\`\`\`json\n${JSON.stringify(structuredFindings)}\n\`\`\``
        : "";
      return `## Analysis Set ${i + 1}\n\n${n.text_preview}${findingsBlock}`;
    });

    const mergeInput = setBlocks.join("\n\n---\n\n");

    // Build system prompt (same as pipeline does for final round)
    const rawMergePrompt = MERGE_PROMPTS[moduleId];
    if (!rawMergePrompt) {
      return { success: false, phase: "no_merge_prompt", topLevel, nodesAtTop, mergedFindings: 0, reportLength: 0, outputId: null, error: `No merge prompt for module ${moduleId}` };
    }
    const mergePrompt = rawMergePrompt
      .replace("{{FINDINGS_REQUIREMENT}}", FINDINGS_RULE_FINAL)
      .replace("{{NUMERIC_VERIFICATION_BLOCK}}", "")
      .replace("{{NUMERIC_TASK_STEP_1}}", "");

    const model = getModuleModel(moduleId);
    console.log(`[CompleteMerge] Calling ${model} with ${mergeInput.length} char input, ${nodesAtTop} sets`);

    // Step 4: Call Anthropic for the final merge
    const MessageResponseSchema = z.object({
      id: z.string(),
      type: z.literal("message"),
      role: z.literal("assistant"),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      model: z.string(),
      stop_reason: z.string().nullable(),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
    });

    let mergeResult;
    try {
      mergeResult = await ctx.integrations.ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model,
            max_tokens: 16000,
            system: [{ type: "text", text: mergePrompt }],
            messages: [{ role: "user", content: mergeInput }],
          },
        },
        { response: MessageResponseSchema },
        { label: "CompleteMerge: final merge call" }
      );
    } catch (aiErr: any) {
      return { success: false, phase: "ai_call_failed", topLevel, nodesAtTop, mergedFindings: 0, reportLength: 0, outputId: null, error: aiErr?.message ?? String(aiErr) };
    }

    const mergeText = mergeResult.content.find((c: any) => c.type === "text")?.text ?? "";
    console.log(`[CompleteMerge] AI response: ${mergeText.length} chars, stop=${mergeResult.stop_reason}, tokens=${mergeResult.usage.input_tokens}+${mergeResult.usage.output_tokens}`);

    // Step 5: Parse findings from response
    const executiveHeader = extractTag(mergeText, "executive_header") || "Analysis complete.";
    const findingsRaw = extractTag(mergeText, "findings_json");

    let findings: any[] = [];
    if (findingsRaw) {
      try {
        const parsed = JSON.parse(findingsRaw);
        const parseResult = parseCanonicalFindings(parsed, {
          mode: "fresh",
          source: `complete-merge-tree:${runId}`,
        });
        findings = parseResult.findings;
      } catch { /* use empty findings */ }
    }

    // OA-02: Merge contract enforcement (omission_audit only)
    if (moduleId === "omission_audit" && findings.length > 0) {
      const inputFindings = topNodes.flatMap(n => {
        try { return JSON.parse(n.findings_json); } catch { return []; }
      });
      const contractResult = validateMergeContract(inputFindings, findings);
      if (!contractResult.valid) {
        console.warn(`[CompleteMerge][OA-02] Merge contract REJECTED: ${contractResult.violationCodes.join(",")}. Preserving ${inputFindings.length} input findings.`);
        findings = contractResult.acceptedFindings;
      } else {
        console.log(`[CompleteMerge][OA-02] Merge contract passed for ${findings.length} findings.`);
      }
    }

    // OA-03: Canonical family dedup (omission_audit only)
    // Preserves full family artifact for promotion
    let familyDedupArtifact: ReturnType<typeof deduplicateFindings> | null = null;
    if (moduleId === "omission_audit" && findings.length > 1) {
      const preDedupCount = findings.length;
      familyDedupArtifact = deduplicateFindings(findings as any);
      const retainedIds = new Set<string>([
        ...familyDedupArtifact.ungroupedFindingIds,
        ...familyDedupArtifact.families.map(f => f.representativeFindingId),
      ]);
      findings = findings.filter(f => retainedIds.has(f.finding_id));
      if (findings.length < preDedupCount) {
        console.log(`[CompleteMerge][OA-03] Family dedup: ${preDedupCount} → ${findings.length} (families=${familyDedupArtifact.totalFamiliesCreated})`);
      }
      // Attach artifact for downstream preservation
      (findings as any).__familyDedupArtifact = familyDedupArtifact;
    }

    console.log(`[CompleteMerge] Parsed ${findings.length} findings, executive header: ${executiveHeader.slice(0, 100)}...`);

    // Step 5b (MAT-F05): Full narrative enforcement sequence
    // Load canonical records from Q3 checkpoint for this run
    let canonicalRecordMap: Map<string, any> | undefined;
    try {
      const q3Checkpoints = await ctx.integrations.db.query(
        `SELECT checkpoint_data FROM pipeline_checkpoints
         WHERE run_id = $1 AND stage = 'q3_claim_linkage'
         ORDER BY created_at DESC LIMIT 1`,
        z.object({ checkpoint_data: z.any() }),
        [runId],
        { label: "CompleteMerge: load Q3 canonical records" }
      );
      if (q3Checkpoints.length > 0) {
        const cpData = typeof q3Checkpoints[0].checkpoint_data === "string"
          ? JSON.parse(q3Checkpoints[0].checkpoint_data)
          : q3Checkpoints[0].checkpoint_data;
        if (cpData?.canonical_findings && Array.isArray(cpData.canonical_findings)) {
          canonicalRecordMap = new Map();
          for (const rec of cpData.canonical_findings) {
            if (rec?.claim?.claim_id) {
              canonicalRecordMap.set(rec.claim.claim_id, rec);
            }
          }
          console.log(`[CompleteMerge][F05] Loaded ${canonicalRecordMap.size} canonical records from Q3`);
        }
      }
    } catch (q3Err: any) {
      console.warn(`[CompleteMerge][F05] Could not load Q3 canonical records: ${q3Err?.message}`);
    }

    const enforcement = enforceNarrativeBoundary(findings, canonicalRecordMap);
    findings = enforcement.findings;
    console.log(`[CompleteMerge][F05] Enforcement: ${enforcement.counts.input} in → ${enforcement.counts.output} out (narrative_rejected=${enforcement.counts.narrative_rejected})`);
    if (enforcement.diagnostics.length > 0) {
      console.log(`[CompleteMerge][F05] Diagnostics: ${JSON.stringify(enforcement.diagnostics)}`);
    }

    // Step 6: Save root checkpoint
    const newLevel = topLevel + 1;
    const rootNodeJson = JSON.stringify({
      text: mergeText,
      executiveHeader,
      findings,
    });

    await ctx.integrations.db.execute(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
       VALUES ($1, $2, 0, $3::jsonb, $4, 'manual-finalize', 'complete')
       ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $3::jsonb, model_used = $4, status = 'complete'`,
      [runId, newLevel, rootNodeJson, model],
      { label: `CompleteMerge: save root at level ${newLevel}` }
    );

    // Step 7: Format and save output
    const fullReport = formatReportMechanical(executiveHeader, findings);

    // Delete old partial output if exists
    await ctx.integrations.db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1`,
      [runId],
      { label: "CompleteMerge: delete partial output" }
    );

    // Insert complete output
    const inserted = await ctx.integrations.db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id`,
      z.object({ id: z.string() }),
      [runId, executiveHeader, JSON.stringify(findings), fullReport],
      { label: "CompleteMerge: insert complete output" }
    );

    const outputId = inserted[0].id;

    // Bump deal
    await ctx.integrations.db.execute(
      `UPDATE deals SET updated_at = now() WHERE id = $1`,
      [dealId],
      { label: "CompleteMerge: bump deal" }
    );

    console.log(`[CompleteMerge] Done! Output ${outputId}, ${findings.length} findings, ${fullReport.length} char report`);

    return {
      success: true,
      phase: "completed",
      topLevel: newLevel,
      nodesAtTop: 1,
      mergedFindings: findings.length,
      reportLength: fullReport.length,
      outputId,
      error: null,
    };
  },
});

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function formatReportMechanical(executiveHeader: string, findings: any[]): string {
  if (findings.length === 0) {
    return `# Diligence Report\n\n> 0 findings. No material contradictions identified.\n`;
  }

  const criticals = findings.filter((f: any) => f.severity === "critical");
  const warnings = findings.filter((f: any) => f.severity === "warning");
  const infos = findings.filter((f: any) => f.severity === "info");

  const lines: string[] = [];
  lines.push(`# Contradiction Check — Final Report`);
  lines.push(``);
  lines.push(`> **${findings.length} findings** — ${criticals.length} critical, ${warnings.length} warning, ${infos.length} info.`);
  lines.push(``);

  if (executiveHeader) {
    lines.push(`## Executive Summary`);
    lines.push(``);
    lines.push(executiveHeader);
    lines.push(``);
  }

  const renderSection = (title: string, items: any[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title} (${items.length})`);
    lines.push(``);
    for (const f of items) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push(``);
      if (f.detail) lines.push(f.detail);
      if (f.full_analysis) {
        lines.push(``);
        lines.push(f.full_analysis);
      }
      if (f.source_docs?.length > 0) {
        lines.push(``);
        lines.push(`**Source Documents:** ${f.source_docs.join(", ")}`);
      }
      lines.push(``);
    }
  };

  renderSection("Critical Findings", criticals);
  renderSection("Warnings", warnings);
  renderSection("Informational", infos);

  return lines.join("\n");
}
