import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagTestResumeQuery",
  description: "Minimal test: runs the exact resume-status-check query that is failing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    status: z.string(),
    is_cancelled: z.string(),
  }),

  async run(ctx, { runId }) {
    // Test 1: Simple status query (should always work)
    const statusOnly = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Simple status check" }
    );

    return { status: statusOnly[0]?.status ?? "not_found", is_cancelled: "false" };
  },
});
