import { api, z, postgres } from "@superblocksteam/sdk-api";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import { runPublicationGate, toCompactDiagnostic } from "./tree-completion-validator.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * One-off utility: Saves root merge findings directly to module_outputs.
 * Used when the canonicalFinalize path fails due to schema mismatches
 * but the merge tree is complete and findings are ready.
 */
export default api({
  name: "PromoteRootFindings",
  description: "Saves the top-level merge checkpoint findings to module_outputs.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    runId: z.string(),
    moduleId: z.string(),
  }),
  output: z.object({
    success: z.boolean(),
    message: z.string(),
    findingCount: z.number(),
    outputId: z.string().nullable(),
  }),
  async run(ctx, { runId, moduleId }) {
    // Step 1: Find the highest-level complete node (the root)
    const rootNodes = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS finding_count
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      z.object({
        tree_level: z.coerce.number(),
        node_index: z.coerce.number(),
        findings_json: z.string(),
        executive_header: z.string(),
        finding_count: z.number(),
      }),
      [runId],
      { label: "Find root checkpoint" }
    );

    if (rootNodes.length === 0) {
      return { success: false, message: "No complete merge checkpoints found", findingCount: 0, outputId: null };
    }

    const root = rootNodes[0];
    console.log(`[PromoteRootFindings] Found root at L${root.tree_level}:N${root.node_index} with ${root.finding_count} findings`);

    // Publication Gate: block promotion of sub-root checkpoints
    const gateResult = await runPublicationGate(ctx.integrations.db, runId, root.tree_level, root.node_index);
    if (!gateResult.eligible) {
      const compact = toCompactDiagnostic(gateResult.diagnostic);
      return {
        success: false,
        message: `Publication gate BLOCKED: ${compact.blocking_reasons.join("; ")}. Coverage: ${compact.coverage_pct}%`,
        findingCount: 0,
        outputId: null,
      };
    }

    // OA-03: For omission_audit, run family dedup on the raw root findings
    // and persist the family artifact alongside findings.
    // Promotion rejects a raw root finding array that lacks validated family metadata.
    let findingsJson = root.findings_json;
    if (moduleId === "omission_audit") {
      try {
        const rawFindings = JSON.parse(root.findings_json);
        if (Array.isArray(rawFindings) && rawFindings.length > 0) {
          const familyResult = deduplicateFindings(rawFindings);
          // Persist family artifact as __familyDedupArtifact on the findings JSON
          const enrichedOutput = {
            findings: rawFindings,
            __familyDedupArtifact: familyResult,
          };
          findingsJson = JSON.stringify(enrichedOutput);
          console.log(`[PromoteRootFindings][OA-03] Family dedup: ${rawFindings.length} findings → ${familyResult.totalFamiliesCreated} families, ${familyResult.ungroupedFindingIds.length} ungrouped`);
        }
      } catch (e) {
        console.warn(`[PromoteRootFindings][OA-03] Family dedup failed, promoting raw findings: ${e}`);
      }
    }

    // Step 2: Check if module_outputs already exists for this run
    const existing = await ctx.integrations.db.query(
      `SELECT id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
      z.object({ id: z.string() }),
      [runId],
      { label: "Check existing module_outputs" }
    );

    let outputId: string;

    if (existing.length > 0) {
      // Update existing
      outputId = existing[0].id;
      await ctx.integrations.db.execute(
        `UPDATE module_outputs
         SET executive_header = $2,
             findings = $3::jsonb,
             full_report_markdown = $4
         WHERE id = $1`,
        [outputId, root.executive_header, findingsJson, `# ${moduleId} Analysis\n\n${root.finding_count} findings identified.`],
        { label: "Update module_outputs" }
      );
    } else {
      // Insert new
      const inserted = await ctx.integrations.db.query(
        `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id`,
        z.object({ id: z.string() }),
        [runId, root.executive_header, findingsJson, `# ${moduleId} Analysis\n\n${root.finding_count} findings identified.`],
        { label: "Insert module_outputs" }
      );
      outputId = inserted[0]?.id ?? "unknown";
    }

    // Step 3: Update module_runs finding count
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET completed_at = NOW() WHERE id = $1`,
      [runId],
      { label: "Update run completed_at" }
    );

    return {
      success: true,
      message: `Saved ${root.finding_count} findings from L${root.tree_level}:N${root.node_index} to module_outputs (id: ${outputId})`,
      findingCount: root.finding_count,
      outputId,
    };
  },
});
