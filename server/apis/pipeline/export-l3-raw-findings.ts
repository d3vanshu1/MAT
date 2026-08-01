/**
 * ExportL3RawFindings — Dumps all raw L3 findings for a run as-is from the database.
 * No parsing, normalization, or deduplication. Pure evidence preservation.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CheckpointRowSchema = z.object({
  id: z.string(),
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  merged_json: z.any(),
  updated_at_text: z.string().nullable(),
});

export default api({
  name: "ExportL3RawFindings",
  description: "Dumps all raw L3 checkpoint findings for evidence preservation.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    nodeIndex: z.number().min(0).max(5),
  }),

  output: z.object({
    node: z.string(),
    checkpoint_id: z.string(),
    tree_level: z.number(),
    node_index: z.number(),
    status: z.string().nullable(),
    updated_at: z.string().nullable(),
    raw_findings: z.any(),
    finding_count: z.number(),
    payload_bytes: z.number(),
  }),

  async run(ctx, { runId, nodeIndex }) {
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, tree_level, node_index, status, merged_json,
              updated_at::text as updated_at_text
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 3 AND node_index = $2 AND status = 'complete'
       LIMIT 1`,
      CheckpointRowSchema,
      [runId, nodeIndex],
      { label: `Load L3:N${nodeIndex} raw checkpoint` }
    );

    if (rows.length === 0) {
      throw new Error(`No complete L3 checkpoint found for node_index=${nodeIndex}`);
    }

    const row = rows[0];
    const merged = typeof row.merged_json === "string" ? JSON.parse(row.merged_json) : row.merged_json;
    const rawFindings = Array.isArray(merged?.findings) ? merged.findings : [];
    const payloadBytes = JSON.stringify(rawFindings).length;

    return {
      node: `L3:N${nodeIndex}`,
      checkpoint_id: row.id,
      tree_level: row.tree_level,
      node_index: row.node_index,
      status: row.status,
      updated_at: row.updated_at_text,
      raw_findings: rawFindings,
      finding_count: rawFindings.length,
      payload_bytes: payloadBytes,
    };
  },
});
