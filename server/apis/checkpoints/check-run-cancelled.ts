import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Lightweight check for run cancellation status.
 * Schema has no `is_cancelled` column — cancellation is represented by status='failed'.
 * The client-side killedModulesRef is the authoritative guard.
 */
export default api({
  name: "CheckRunCancelled",
  description: "Checks if a module run has been cancelled (status-based)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    cancelled: z.boolean(),
    status: z.string(),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: `Check cancellation: ${runId}` }
    );

    const status = rows[0]?.status ?? "unknown";
    // Without is_cancelled column, cancelled runs are indistinguishable from failures.
    // Client-side killedModulesRef is the real guard.
    return { cancelled: status === "failed", status };
  },
});
