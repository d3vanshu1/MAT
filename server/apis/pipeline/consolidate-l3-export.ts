/**
 * ConsolidateL3Export — Loads all 6 L3 nodes for a run, assembles the complete
 * findings corpus, and writes it to a merge_checkpoint at tree_level=98 (export artifact).
 * Returns only metadata to avoid testApi truncation; the full payload lives in the DB.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CheckpointRowSchema = z.object({
  id: z.string(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
  updated_at_text: z.string().nullable(),
});

const UpsertResultSchema = z.object({
  id: z.string(),
});

export default api({
  name: "ConsolidateL3Export",
  description: "Assembles all L3 findings into a single export checkpoint.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    export_checkpoint_id: z.string(),
    total_findings: z.number(),
    node_counts: z.array(z.object({ node: z.string(), count: z.number(), checkpoint_id: z.string(), updated_at: z.string().nullable() })),
    payload_bytes: z.number(),
  }),

  async run(ctx, { runId, moduleId }) {
    // Load all 6 L3 nodes
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, node_index, merged_json, updated_at::text as updated_at_text
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 3 AND status = 'complete'
       ORDER BY node_index`,
      CheckpointRowSchema,
      [runId],
      { label: "Load all L3 checkpoints" }
    );

    if (rows.length === 0) {
      throw new Error("No complete L3 checkpoints found for this run.");
    }

    // Assemble all findings with provenance
    const allFindings: any[] = [];
    const nodeCounts: { node: string; count: number; checkpoint_id: string; updated_at: string | null }[] = [];

    for (const row of rows) {
      const merged = typeof row.merged_json === "string" ? JSON.parse(row.merged_json) : row.merged_json;
      const findings = Array.isArray(merged?.findings) ? merged.findings : [];

      // Annotate each finding with its L3 node provenance
      for (const f of findings) {
        allFindings.push({
          ...f,
          _l3_node_index: row.node_index,
          _l3_checkpoint_id: row.id,
        });
      }

      nodeCounts.push({
        node: `L3:N${row.node_index}`,
        count: findings.length,
        checkpoint_id: row.id,
        updated_at: row.updated_at_text,
      });
    }

    // Build the export payload
    const exportPayload = {
      _export_metadata: {
        run_id: runId,
        module_id: moduleId,
        export_timestamp: new Date().toISOString(),
        total_findings: allFindings.length,
        node_counts: nodeCounts,
        git_reference_commit: "bc01c41",
        export_format_version: "1.0.0",
      },
      findings: allFindings,
    };

    const payloadJson = JSON.stringify(exportPayload);

    // Write to checkpoint at tree_level=98, node_index=0
    const result = await ctx.integrations.ic_diligence_db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 98, 0, 'export', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'export', updated_at = now()
       RETURNING id`,
      UpsertResultSchema,
      [runId, payloadJson],
      { label: "Write consolidated L3 export checkpoint" }
    );

    return {
      export_checkpoint_id: result[0].id,
      total_findings: allFindings.length,
      node_counts: nodeCounts,
      payload_bytes: payloadJson.length,
    };
  },
});
