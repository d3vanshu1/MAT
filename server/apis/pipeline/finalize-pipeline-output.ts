import { api, z, postgres } from "@superblocksteam/sdk-api";
import { parseCanonicalFindings } from "./canonical-finding.js";
import { applyBatchAuthorityGate } from "./narrative-authority-gate.js";
import { shouldExcludeAsProcessObject } from "./narrative-boundary.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Lightweight finalizer: completes a stuck pipeline run by reading only the
 * final merge checkpoint, formatting the report, and saving to module_outputs.
 * 
 * This runs in a CLEAN execution context (no prior 200+ extraction/checkpoint loads)
 * so the integration isn't exhausted when it reaches the save step.
 * 
 * Prerequisites: All merges must be complete (final root node saved to merge_checkpoints).
 */
export default api({
  name: "FinalizePipelineOutput",
  description: "Lightweight finalizer for stuck pipeline runs — reads final checkpoint and saves output",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    moduleId: z.string(),
  }),

  output: z.object({
    success: z.boolean(),
    phase: z.string(),
    outputId: z.string().nullable(),
    reportLength: z.number(),
    findingsCount: z.number(),
    error: z.string().nullable(),
  }),

  async run(ctx, { runId, dealId, moduleId }) {
    // Step 1: Check if output already exists
    const existingOutput = await ctx.integrations.db.query(
      `SELECT id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
      z.object({ id: z.string() }),
      [runId],
      { label: "Finalize: check existing output" }
    );

    if (existingOutput.length > 0) {
      // Output already saved — just mark completed
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
        [runId],
        { label: "Finalize: mark completed (output exists)" }
      );
      return {
        success: true,
        phase: "already_saved",
        outputId: existingOutput[0].id,
        reportLength: 0,
        findingsCount: 0,
        error: null,
      };
    }

    // Step 2: Load the final merge checkpoint (top-level root node)
    const TopNodeSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      executive_header: z.string(),
      findings_json: z.string(),
    });

    const topNodes = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      TopNodeSchema,
      [runId],
      { label: "Finalize: load final checkpoint" }
    );

    if (topNodes.length === 0) {
      return {
        success: false,
        phase: "no_final_checkpoint",
        outputId: null,
        reportLength: 0,
        findingsCount: 0,
        error: "No complete merge checkpoint found — run may not have finished merging",
      };
    }

    const topNode = topNodes[0];
    console.log(`[Finalize] Found top node: level=${topNode.tree_level}, index=${topNode.node_index}`);

    // Step 3: Parse findings
    let findings: any[];
    try {
      const rawFindings = JSON.parse(topNode.findings_json);
      const parseResult = parseCanonicalFindings(rawFindings, {
        mode: "reload",
        source: `finalize-pipeline:${runId}`,
      });
      findings = parseResult.findings as any[];
    } catch (parseErr: any) {
      return {
        success: false,
        phase: "findings_parse_error",
        outputId: null,
        reportLength: 0,
        findingsCount: 0,
        error: `Failed to parse findings: ${parseErr?.message}`,
      };
    }

    console.log(`[Finalize] Parsed ${findings.length} findings`);

    // Step 3b (MAT-F05): Apply authority gate — strip LLM-originated authoritative fields,
    // exclude process objects, and enforce rule-based caps.
    // Canonical records are loaded from Q3 checkpoint if available.
    let canonicalRecordMap: Map<string, any> | undefined;
    try {
      const q3Checkpoints = await ctx.integrations.db.query(
        `SELECT checkpoint_data FROM pipeline_checkpoints
         WHERE run_id = $1 AND stage = 'q3_claim_linkage'
         ORDER BY created_at DESC LIMIT 1`,
        z.object({ checkpoint_data: z.any() }),
        [runId],
        { label: "Finalize: load Q3 canonical records" }
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
          console.log(`[Finalize][F05] Loaded ${canonicalRecordMap.size} canonical records from Q3`);
        }
      }
    } catch (q3Err: any) {
      console.warn(`[Finalize][F05] Could not load Q3 canonical records: ${q3Err?.message}`);
    }

    // Exclude process/fallback objects (MAT-F05 §H)
    const substantiveFindings = findings.filter((f: any) => {
      if (shouldExcludeAsProcessObject(f)) {
        console.log(`[Finalize][F05] Excluded process object: "${f.title}"`);
        return false;
      }
      return true;
    });

    // Apply batch authority gate (MAT-F05 §E) — enforces canonical record over LLM
    const gateResult = applyBatchAuthorityGate(
      substantiveFindings,
      canonicalRecordMap ?? undefined
    );
    const gatedFindings = gateResult.accepted;
    console.log(`[Finalize][F05] Authority gate: ${findings.length} → ${gatedFindings.length} findings`);

    // Step 4: Format report (pure mechanical — no AI) using gated findings
    const fullReport = formatReportMechanical(topNode.executive_header, gatedFindings);
    console.log(`[Finalize] Formatted report: ${fullReport.length} chars`);

    // Step 5: Save to module_outputs (direct minimal INSERT — bypasses upsertModuleOutput)
    try {
      // First: check if exists
      const checkExisting = await ctx.integrations.db.query(
        `SELECT id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
        z.object({ id: z.string() }),
        [runId],
        { label: "Finalize: check existing output (v2)" }
      );

      let savedOutputId: string;
      if (checkExisting.length > 0) {
        // Already exists — update
        savedOutputId = checkExisting[0].id;
        await ctx.integrations.db.execute(
          `UPDATE module_outputs SET executive_header = $2, findings = $3::jsonb, full_report_markdown = $4 WHERE id = $1`,
          [savedOutputId, topNode.executive_header, JSON.stringify(gatedFindings), fullReport],
          { label: "Finalize: update existing output" }
        );
      } else {
        // Insert new
        const inserted = await ctx.integrations.db.query(
          `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING id`,
          z.object({ id: z.string() }),
          [runId, topNode.executive_header, JSON.stringify(gatedFindings), fullReport],
          { label: "Finalize: insert new output" }
        );
        savedOutputId = inserted[0].id;
      }

      // Step 6: Mark run completed
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'completed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
        [runId],
        { label: "Finalize: mark run completed" }
      );

      return {
        success: true,
        phase: "completed",
        outputId: savedOutputId,
        reportLength: fullReport.length,
        findingsCount: findings.length,
        error: null,
      };
    } catch (saveErr: any) {
      return {
        success: false,
        phase: "save_failed",
        outputId: null,
        reportLength: fullReport.length,
        findingsCount: findings.length,
        error: saveErr?.message ?? String(saveErr),
      };
    }
  },
});

/**
 * Pure mechanical report formatter — no AI, no DB calls.
 * Simplified version of pipeline-core.ts formatReportInline.
 */
function formatReportMechanical(executiveHeader: string, findings: any[]): string {
  if (findings.length === 0) {
    return `# Diligence Report\n\n> 0 findings. No analysis output.\n`;
  }

  const criticals = findings.filter(f => f.severity === "critical");
  const warnings = findings.filter(f => f.severity === "warning");
  const infos = findings.filter(f => f.severity === "info");
  const totalCount = findings.length;

  const lines: string[] = [];
  lines.push(`# Diligence Report`);
  lines.push(``);
  lines.push(`> **${totalCount} findings — mechanically rendered.**`);
  lines.push(`> Severity: ${criticals.length} critical, ${warnings.length} warning, ${infos.length} info.`);
  lines.push(``);

  if (executiveHeader) {
    lines.push(`## Executive Summary`);
    lines.push(``);
    lines.push(executiveHeader);
    lines.push(``);
  }

  // Render by severity
  const renderSection = (title: string, items: any[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title} (${items.length})`);
    lines.push(``);
    for (const f of items) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push(``);
      if (f.detail) lines.push(f.detail);
      if ((f as any).evidence && (f as any).evidence.length > 0) {
        lines.push(``);
        lines.push(`**Evidence:**`);
        for (const ev of (f as any).evidence.slice(0, 5)) {
          lines.push(`- ${typeof ev === "string" ? ev : JSON.stringify(ev)}`);
        }
      }
      lines.push(``);
    }
  };

  renderSection("Critical Findings", criticals);
  renderSection("Warnings", warnings);
  renderSection("Informational", infos);

  return lines.join("\n");
}
