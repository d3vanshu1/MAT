import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagDeleteCheckpointRow",
  description: "Deletes a single merge_checkpoints row by run/level/index",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    treeLevel: z.number(),
    nodeIndex: z.number(),
  }),

  output: z.object({
    deleted: z.boolean(),
    message: z.string(),
  }),

  async run(ctx, { runId, treeLevel, nodeIndex }) {
    await ctx.integrations.db.execute(
      `DELETE FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
      [runId, treeLevel, nodeIndex],
      { label: `Delete checkpoint row L${treeLevel}:${nodeIndex}` }
    );

    return {
      deleted: true,
      message: `Deleted merge_checkpoints row: run=${runId}, tree_level=${treeLevel}, node_index=${nodeIndex}`,
    };
  },
});
