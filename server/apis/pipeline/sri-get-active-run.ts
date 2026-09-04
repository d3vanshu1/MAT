/**
 * ERO v2 — Check for active (non-terminal) run for a deal.
 *
 * Lightweight read-only query used by the DealDashboard to detect
 * an in-progress ERO run on mount so it can auto-resume polling.
 * Does NOT create or modify any run state.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ActiveRunRow = z.object({
  run_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  heartbeat_age_secs: z.coerce.number().nullable(),
});

export default api({
  name: "EroGetActiveRun",
  description: "Checks for an active ERO run for a deal (read-only)",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    activeRun: z.object({
      runId: z.string(),
      currentStage: z.string(),
      stageStatus: z.string(),
      invocationCount: z.number(),
      heartbeatAgeSecs: z.number().nullable(),
    }).nullable(),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    const rows = await db.query(
      `SELECT run_id, current_stage, stage_status, invocation_count,
              extract(epoch FROM (now() - heartbeat_at))::int AS heartbeat_age_secs
       FROM ero_pipeline_state
       WHERE deal_id = $1
         AND stage_status != 'failed'
         AND NOT (stage_status = 'complete' AND current_stage = 'render')
       ORDER BY created_at DESC
       LIMIT 1`,
      ActiveRunRow,
      [dealId],
      { label: "EroGetActiveRun: check for non-terminal run" },
    );

    if (rows.length === 0) {
      return { activeRun: null };
    }

    const r = rows[0];
    return {
      activeRun: {
        runId: r.run_id,
        currentStage: r.current_stage,
        stageStatus: r.stage_status,
        invocationCount: r.invocation_count,
        heartbeatAgeSecs: r.heartbeat_age_secs,
      },
    };
  },
});
