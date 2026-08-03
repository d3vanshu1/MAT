import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Migration: Add a composite index on merge_checkpoints to prevent query timeouts
 * when loading checkpoints for large runs (75+ checkpoints with big JSONB payloads).
 * 
 * The existing index (module_run_id alone) forces full heap fetches + sort
 * for ORDER BY tree_level DESC queries. A composite index on
 * (module_run_id, tree_level DESC, node_index, status) allows index-only
 * scan for the fast-path queries without touching TOAST data.
 */
export default api({
  name: "RunMigration016",
  description: "Add composite index on merge_checkpoints for fast-path checkpoint loading",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    indexesCreated: z.array(z.string()),
  }),

  async run(ctx) {
    const indexesCreated: string[] = [];

    try {
      // Composite index for the fast-path checkpoint lookup:
      // SELECT ... FROM merge_checkpoints WHERE module_run_id = $1 AND status = 'complete' ORDER BY tree_level DESC LIMIT 1
      await ctx.integrations.db.execute(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_merge_ckpt_run_level 
         ON merge_checkpoints(module_run_id, tree_level DESC, node_index, status)`,
        [],
        { label: "Create composite index on merge_checkpoints" }
      );
      indexesCreated.push("idx_merge_ckpt_run_level");
    } catch (e: any) {
      // CONCURRENTLY can't run inside a transaction — try without
      if (e?.message?.includes("cannot run inside a transaction")) {
        await ctx.integrations.db.execute(
          `CREATE INDEX IF NOT EXISTS idx_merge_ckpt_run_level 
           ON merge_checkpoints(module_run_id, tree_level DESC, node_index, status)`,
          [],
          { label: "Create composite index (non-concurrent)" }
        );
        indexesCreated.push("idx_merge_ckpt_run_level (non-concurrent)");
      } else {
        throw e;
      }
    }

    try {
      // Index for count/exists queries on run_id with inline values
      // Also covers: WHERE run_id = $1 queries (merge checkpoint loading in bulk)
      await ctx.integrations.db.execute(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_merge_ckpt_run_id_status
         ON merge_checkpoints(module_run_id, status)
         INCLUDE (tree_level, node_index)`,
        [],
        { label: "Create covering index for checkpoint status queries" }
      );
      indexesCreated.push("idx_merge_ckpt_run_id_status");
    } catch (e: any) {
      if (e?.message?.includes("cannot run inside a transaction")) {
        await ctx.integrations.db.execute(
          `CREATE INDEX IF NOT EXISTS idx_merge_ckpt_run_id_status
           ON merge_checkpoints(module_run_id, status)
           INCLUDE (tree_level, node_index)`,
          [],
          { label: "Create covering index (non-concurrent)" }
        );
        indexesCreated.push("idx_merge_ckpt_run_id_status (non-concurrent)");
      } else {
        // Non-fatal — first index may be sufficient
        console.warn("[migration016] Second index creation failed:", e?.message);
      }
    }

    return {
      success: true,
      message: `Created ${indexesCreated.length} index(es) on merge_checkpoints`,
      indexesCreated,
    };
  },
});
