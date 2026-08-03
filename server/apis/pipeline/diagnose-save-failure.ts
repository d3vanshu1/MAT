import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Diagnostic API: Examines merge tree structure for a given run.
 */
export default api({
  name: "DiagnoseSaveFailure",
  description: "Diagnoses merge tree structure and module_outputs for a run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    mergeTreeLevels: z.array(z.object({
      tree_level: z.number(),
      count: z.number(),
    })),
    topNodeFindings: z.number(),
    totalCheckpoints: z.number(),
    runStatus: z.string(),
    outputExists: z.boolean(),
  }),

  async run(ctx, { runId }) {
    // Get merge tree level distribution
    const levels = await ctx.integrations.db.query(
      `SELECT tree_level, count(*)::int AS count
       FROM merge_checkpoints
       WHERE module_run_id = $1
       GROUP BY tree_level
       ORDER BY tree_level ASC`,
      z.object({ tree_level: z.coerce.number(), count: z.number() }),
      [runId],
      { label: "Diag: merge tree levels" }
    );

    // Get total count
    const [total] = await ctx.integrations.db.query(
      `SELECT count(*)::int AS cnt FROM merge_checkpoints WHERE module_run_id = $1`,
      z.object({ cnt: z.number() }),
      [runId],
      { label: "Diag: total checkpoints" }
    );

    // Get top node findings count
    const [topNode] = await ctx.integrations.db.query(
      `SELECT jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS fcount
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      z.object({ fcount: z.coerce.number() }),
      [runId],
      { label: "Diag: top node findings count" }
    );

    // Run status
    const [run] = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Diag: run status" }
    );

    // Output exists?
    const outputRows = await ctx.integrations.db.query(
      `SELECT id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
      z.object({ id: z.string() }),
      [runId],
      { label: "Diag: check output" }
    );

    return {
      mergeTreeLevels: levels,
      topNodeFindings: topNode?.fcount ?? 0,
      totalCheckpoints: total?.cnt ?? 0,
      runStatus: run?.status ?? "unknown",
      outputExists: outputRows.length > 0,
    };
  },
});
