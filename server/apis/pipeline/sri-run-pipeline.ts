import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  SRI_STAGES,
  STAGE_BUDGET_MS,
  type SriStageName,
  type StageHandler,
  type StageResult,
} from "./sri-stage-contract.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
var STALE_HEARTBEAT_SECS = 300;
var LAST_STAGE = SRI_STAGES[SRI_STAGES.length - 1];
var FIRST_STAGE = SRI_STAGES[0];

var PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  heartbeat_age_secs: z.coerce.number().nullable(),
});

var InsertedRow = z.object({ run_id: z.string() });

function makeStub(stage: SriStageName): StageHandler {
  return async function (_ctx, _runId, _dealId): Promise<StageResult> {
    return { stage: stage, status: "not_implemented", message: "stub" };
  };
}

var DISPATCH: Record<SriStageName, StageHandler> = {
  build_entity_manifest: makeStub("build_entity_manifest"),
  build_claim_register: makeStub("build_claim_register"),
  plan_research: makeStub("plan_research"),
  research_execution: makeStub("research_execution"),
  adjudicate_findings: makeStub("adjudicate_findings"),
  claim_confrontation: makeStub("claim_confrontation"),
  render: makeStub("render"),
};

// NOTE: No inline ALTER TABLE for stages_completed. Migration 042 creates that column,
// so the inline ALTER used in the external_risk_overlay orchestrator is unnecessary here.

export default api({
  name: "SriRunPipeline",
  description: "SRI v2 orchestrator — single stage per invocation, stub handlers",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    runId: z.string().nullable().optional(),
  }),

  output: z.object({
    runId: z.string(),
    stage: z.string(),
    status: z.string(),
    invocationCount: z.number(),
    message: z.string(),
    stageData: z.record(z.unknown()).nullable(),
  }),

  async run(ctx, { dealId, runId }) {
    var db = ctx.integrations.db;
    var invocationStart = Date.now();

    // 1. Resume or create run
    if (!runId) {
      var existingRows = await db.query(
        "SELECT run_id, current_stage, stage_status FROM sri_pipeline_state WHERE deal_id = $1 AND NOT (stage_status = 'complete' AND current_stage = $2) ORDER BY created_at DESC LIMIT 1",
        z.object({ run_id: z.string(), current_stage: z.string(), stage_status: z.string() }),
        [dealId, LAST_STAGE],
        { label: "Check for resumable SRI run" },
      );

      if (existingRows.length > 0 && existingRows[0].stage_status !== "failed") {
        var existing = existingRows[0];
        return {
          runId: existing.run_id,
          stage: existing.current_stage,
          status: "pending",
          invocationCount: 0,
          message: "Resuming existing run at stage " + existing.current_stage + ".",
          stageData: null,
        };
      }

      var rows = await db.query(
        "INSERT INTO sri_pipeline_state (run_id, deal_id, current_stage, stage_status, invocation_count, heartbeat_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'pending', 0, now(), now(), now()) RETURNING run_id",
        InsertedRow,
        [dealId, FIRST_STAGE],
        { label: "Create SRI run" },
      );

      return {
        runId: rows[0].run_id,
        stage: FIRST_STAGE,
        status: "pending",
        invocationCount: 0,
        message: "Run created. Invoke again with this runId to begin.",
        stageData: null,
      };
    }

    // 2. Load existing run
    var stateRows = await db.query(
      "SELECT run_id, deal_id, current_stage, stage_status, invocation_count, extract(epoch FROM (now() - heartbeat_at))::int AS heartbeat_age_secs FROM sri_pipeline_state WHERE run_id = $1",
      PipelineStateRow,
      [runId],
      { label: "Load SRI pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error("SRI run not found: " + runId);
    }

    var state = stateRows[0];
    var currentStage = state.current_stage as SriStageName;

    // 3. Already fully complete?
    if (state.stage_status === "complete" && currentStage === LAST_STAGE) {
      return {
        runId: runId,
        stage: currentStage,
        status: "complete",
        invocationCount: state.invocation_count,
        message: "Pipeline already complete. No further stages to run.",
        stageData: null,
      };
    }

    // 3b. Stale heartbeat guard
    if (state.stage_status === "running") {
      var age = state.heartbeat_age_secs ?? 9999;
      if (age < STALE_HEARTBEAT_SECS) {
        return {
          runId: runId,
          stage: currentStage,
          status: "in_progress",
          invocationCount: state.invocation_count,
          message: "Stage " + currentStage + " is still executing (heartbeat " + age + "s ago). Waiting.",
          stageData: null,
        };
      }
      await db.execute(
        "UPDATE sri_pipeline_state SET stage_status = 'pending', updated_at = now() WHERE run_id = $1",
        [runId],
        { label: "Reset stale stage " + currentStage },
      );
    }

    // 4. Increment invocation and update heartbeat
    await db.execute(
      "UPDATE sri_pipeline_state SET invocation_count = invocation_count + 1, heartbeat_at = now(), updated_at = now() WHERE run_id = $1",
      [runId],
      { label: "Increment invocation" },
    );
    var invocationCount = state.invocation_count + 1;

    // 5. Determine stage to run
    var stageToRun: SriStageName = currentStage;
    if (state.stage_status === "complete") {
      var idx = SRI_STAGES.indexOf(currentStage);
      if (idx < SRI_STAGES.length - 1) {
        stageToRun = SRI_STAGES[idx + 1];
        await db.execute(
          "UPDATE sri_pipeline_state SET current_stage = $2, stage_status = 'pending', updated_at = now() WHERE run_id = $1",
          [runId, stageToRun],
          { label: "Advance to " + stageToRun },
        );
      }
    }

    // 6. Budget guard
    var elapsed = Date.now() - invocationStart;
    if (elapsed >= STAGE_BUDGET_MS) {
      return {
        runId: runId,
        stage: stageToRun,
        status: "in_progress",
        invocationCount: invocationCount,
        message: "Budget exhausted (" + elapsed + "ms). Re-invoke to continue.",
        stageData: null,
      };
    }

    // 7. Mark running
    await db.execute(
      "UPDATE sri_pipeline_state SET stage_status = 'running', updated_at = now() WHERE run_id = $1",
      [runId],
      { label: "Mark " + stageToRun + " running" },
    );

    // 8. Dispatch
    var handler = DISPATCH[stageToRun];
    if (!handler) {
      throw new Error("No handler registered for stage: " + stageToRun);
    }

    var result: StageResult;
    try {
      result = await handler(ctx, runId, dealId);
    } catch (stageErr: unknown) {
      try {
        await db.execute(
          "UPDATE sri_pipeline_state SET stage_status = 'pending', updated_at = now() WHERE run_id = $1",
          [runId],
          { label: "Reset " + stageToRun + " after error" },
        );
      } catch { /* leave as running for stale-heartbeat recovery */ }
      throw stageErr;
    }

    // 9. Process result
    // NOTE: stages_completed is written only by stage handlers, not by the orchestrator.
    // Each handler appends its own marker after all writes succeed. Stub handlers do not
    // write it, so stages_completed remains empty until real handlers are implemented.
    if (result.status === "not_implemented" || result.status === "complete") {
      var stageIdx = SRI_STAGES.indexOf(stageToRun);
      if (stageIdx < SRI_STAGES.length - 1) {
        var nextStage = SRI_STAGES[stageIdx + 1];
        await db.execute(
          "UPDATE sri_pipeline_state SET current_stage = $2, stage_status = 'pending', updated_at = now() WHERE run_id = $1",
          [runId, nextStage],
          { label: "Advance to " + nextStage },
        );
      } else {
        await db.execute(
          "UPDATE sri_pipeline_state SET stage_status = 'complete', updated_at = now() WHERE run_id = $1",
          [runId],
          { label: "Mark pipeline complete" },
        );
      }
    } else if (result.status === "in_progress") {
      await db.execute(
        "UPDATE sri_pipeline_state SET stage_status = 'pending', updated_at = now() WHERE run_id = $1",
        [runId],
        { label: stageToRun + " in_progress — reset to pending" },
      );
    } else if (result.status === "failed") {
      await db.execute(
        "UPDATE sri_pipeline_state SET stage_status = 'failed', updated_at = now() WHERE run_id = $1",
        [runId],
        { label: stageToRun + " failed" },
      );
    }

    return {
      runId: runId,
      stage: result.stage,
      status: result.status,
      invocationCount: invocationCount,
      message: result.message,
      stageData: result.stageData ?? null,
    };
  },
});
