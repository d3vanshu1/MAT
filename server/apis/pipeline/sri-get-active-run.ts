import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

var ActiveRunRow = z.object({
  run_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  heartbeat_age_secs: z.coerce.number().nullable(),
});

export default api({
  name: "SriGetActiveRun",
  description: "Checks for an active SRI run for a deal (read-only)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
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
    var db = ctx.integrations.db;

    var rows = await db.query(
      "SELECT run_id, current_stage, stage_status, invocation_count, extract(epoch FROM (now() - heartbeat_at))::int AS heartbeat_age_secs FROM sri_pipeline_state WHERE deal_id = $1 AND stage_status != 'failed' AND NOT (stage_status = 'complete' AND current_stage = 'render') ORDER BY created_at DESC LIMIT 1",
      ActiveRunRow,
      [dealId],
      { label: "SriGetActiveRun: check for non-terminal run" },
    );

    if (rows.length === 0) {
      return { activeRun: null };
    }

    var r = rows[0];
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
