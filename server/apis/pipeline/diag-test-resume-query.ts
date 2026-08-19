import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagTestResumeQuery",
  description: "Minimal test: runs the resume-status-check query against a run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    status: z.string(),
    message: z.string(),
  }),

  async run(ctx, { runId }) {
    // This is the exact query the resume path now uses
    const rows = await ctx.integrations.db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ status: z.string() }),
      [runId],
      { label: "Diag: resume status check" }
    );

    if (rows.length === 0) {
      return { status: "not_found", message: `No module_run with id ${runId}` };
    }

    return { status: rows[0].status, message: "Query succeeded — resume path is clear" };
  },
});
