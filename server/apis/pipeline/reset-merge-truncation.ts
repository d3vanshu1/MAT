/**
 * One-off: Reset truncation_count inside merged_json for specific merge_checkpoints
 * so they get another continuation pass with the new 15000 token limit.
 *
 * Target: SCG run 461db6c0, L1 nodes 0,1,2,3,17,20 (all at truncation_count=2)
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ResetMergeTruncation",
  description: "Resets truncation_count in merge_checkpoints so partial nodes get retried with higher token limit",

  integrations: {
    db: postgres(DB_ID),
  },

  input: z.object({
    runId: z.string(),
    treeLevel: z.number(),
    nodeIndices: z.array(z.number()),
  }),

  output: z.object({
    updated: z.number(),
    details: z.array(z.object({
      nodeIndex: z.number(),
      oldTruncCount: z.number(),
      newStatus: z.string(),
    })),
  }),

  async run(ctx, { runId, treeLevel, nodeIndices }) {
    const details: { nodeIndex: number; oldTruncCount: number; newStatus: string }[] = [];

    for (const nodeIndex of nodeIndices) {
      // Read current checkpoint
      const rows = await ctx.integrations.db.query(
        `SELECT merged_json, status FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        z.object({ merged_json: z.any(), status: z.string() }),
        [runId, treeLevel, nodeIndex],
        { label: `Read checkpoint L${treeLevel}:N${nodeIndex}` }
      );

      if (rows.length === 0) continue;

      const data = typeof rows[0].merged_json === "string"
        ? JSON.parse(rows[0].merged_json)
        : rows[0].merged_json;

      const oldTruncCount = data.truncation_count ?? 0;

      // Reset truncation_count to 0 and status back to 'partial'
      data.truncation_count = 0;

      await ctx.integrations.db.execute(
        `UPDATE merge_checkpoints
         SET merged_json = $4::jsonb, status = 'partial'
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
        [runId, treeLevel, nodeIndex, JSON.stringify(data)],
        { label: `Reset truncation L${treeLevel}:N${nodeIndex}` }
      );

      details.push({ nodeIndex, oldTruncCount, newStatus: "partial" });
    }

    return { updated: details.length, details };
  },
});
