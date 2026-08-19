import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * GetRunnableRuns — dedicated watchdog/polling driver query.
 *
 * Returns all module_runs in 'running' status for a deal, WITH NO
 * module_run_flags filter. This is the query the client poll loop and
 * auto-resume mechanism use to decide which pipelines need driving.
 *
 * Separated from LoadModuleResults (which filters diagnostic runs for
 * the dashboard display) because filtering the driver query kills the
 * only mechanism that completes long-running pipelines.
 *
 * One consumer, one purpose, no mode switch.
 */

const RunnableRunSchema = z.object({
  module_id: z.string(),
  run_id: z.string(),
  triggered_at: z.string(),
});

export default api({
  name: "GetRunnableRuns",
  description: "Returns running module_runs for a deal (no display filter, used by watchdog)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runs: z.array(RunnableRunSchema),
  }),

  async run(ctx, { dealId }) {
    const runs = await ctx.integrations.db.query(
      `SELECT mr.module_id, mr.id AS run_id, mr.triggered_at::text
       FROM module_runs mr
       WHERE mr.deal_id = $1
         AND mr.status = 'running'::module_status
       ORDER BY mr.triggered_at DESC
       LIMIT 20`,
      RunnableRunSchema,
      [dealId],
      { label: "GetRunnableRuns: find all running runs for deal (unfiltered)" }
    );

    return { runs };
  },
});
