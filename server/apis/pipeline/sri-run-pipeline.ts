/**
 * ERO v2 — Orchestrator shell (Packet 1.2)
 *
 * Single-stage-per-invocation orchestrator.  Every stage handler is a
 * stub returning 'not_implemented'.  The shell proves
 * start → checkpoint → resume → advance across seven invocations.
 *
 * No entity extraction, no profile, no hypotheses, no search.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  ERO_STAGES,
  STAGE_BUDGET_MS,
  type EroStageName,
  type StageHandler,
  type StageResult,
} from "./ero-stage-contract.js";
import { buildEntityManifest } from "./ero-entity-manifest.js";
import { buildDealProfile } from "./ero-deal-profile.js";
import { generateHypotheses } from "./ero-hypotheses.js";
import { rankHypotheses } from "./ero-ranking.js";
import { researchExecution } from "./ero-research-stage.js";
import { adjudicateFindings } from "./ero-adjudication.js";
import { corpusConfrontation } from "./ero-corpus-confrontation.js";
import { renderReport } from "./ero-render.js";

// ── Integration ─────────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Schemas ─────────────────────────────────────────────────────────
const STALE_HEARTBEAT_SECS = 300; // 5 minutes — if heartbeat is older, prior execution is dead

const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  heartbeat_age_secs: z.coerce.number().nullable(),
});

const InsertedRow = z.object({
  run_id: z.string(),
});

// ── Stub handlers ───────────────────────────────────────────────────
function makeStub(stage: EroStageName): StageHandler {
  return async (_ctx, _runId, _dealId): Promise<StageResult> => ({
    stage,
    status: "not_implemented",
    message: "stub",
  });
}

const DISPATCH: Record<EroStageName, StageHandler> = {
  build_entity_manifest: (ctx, runId, dealId) => buildEntityManifest(ctx, runId, dealId),
  build_deal_profile: (ctx, runId, dealId) => buildDealProfile(ctx, runId, dealId),
  generate_hypotheses: (ctx, runId, dealId) => generateHypotheses(ctx, runId, dealId),
  rank_hypotheses: (ctx, runId, dealId) => rankHypotheses(ctx, runId, dealId),
  research_execution: (ctx, runId, dealId) => researchExecution(ctx, runId, dealId),
  adjudicate_findings: (ctx, runId, dealId) => adjudicateFindings(ctx, runId, dealId),
  corpus_confrontation: (ctx, runId, dealId) => corpusConfrontation(ctx, runId, dealId),
  render: (ctx, runId, dealId) => renderReport(ctx, runId, dealId),
};

// ── API ─────────────────────────────────────────────────────────────
export default api({
  name: "EroRunPipeline",
  description: "ERO v2 orchestrator — single stage per invocation, stub handlers",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
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
    const db = ctx.integrations.ic_diligence_db;
    const invocationStart = Date.now();

    // ── 0. Ensure stages_completed column exists ──────────────────
    // Added inline (no migration file) — idempotent. This column carries
    // per-stage completion markers for stages 1-3 so they can detect a
    // true full completion vs. a partial-row state.
    await db.execute(
      `ALTER TABLE ero_pipeline_state
         ADD COLUMN IF NOT EXISTS stages_completed TEXT[] NOT NULL DEFAULT '{}'`,
      [],
      { label: "EroRunPipeline: ensure stages_completed column" },
    );

    // ── 1. Resume or create run ───────────────────────────────────
    if (!runId) {
      // Check for an existing incomplete run for this deal that can be resumed.
      // This prevents orphaned runs when the client loses its poll loop
      // (tab close, network timeout) and re-clicks "Run Analysis".
      const existingRows = await db.query(
        `SELECT run_id, current_stage, stage_status
         FROM ero_pipeline_state
         WHERE deal_id = $1
           AND NOT (
             stage_status = 'complete'
             AND current_stage = $2
           )
         ORDER BY created_at DESC
         LIMIT 1`,
        z.object({ run_id: z.string(), current_stage: z.string(), stage_status: z.string() }),
        [dealId, ERO_STAGES[ERO_STAGES.length - 1]],
        { label: "Check for resumable ERO run" },
      );

      if (existingRows.length > 0 && existingRows[0].stage_status !== "failed") {
        const existing = existingRows[0];
        return {
          runId: existing.run_id,
          stage: existing.current_stage,
          status: "pending",
          invocationCount: 0,
          message: `Resuming existing run at stage ${existing.current_stage}.`,
          stageData: null,
        };
      }

      // No resumable run — create fresh
      const rows = await db.query(
        `INSERT INTO ero_pipeline_state
           (run_id, deal_id, current_stage, stage_status,
            invocation_count, heartbeat_at, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1, $2, 'pending',
            0, now(), now(), now())
         RETURNING run_id`,
        InsertedRow,
        [dealId, ERO_STAGES[0]],
        { label: "Create ERO run" },
      );

      const newRunId = rows[0].run_id;
      return {
        runId: newRunId,
        stage: ERO_STAGES[0],
        status: "pending",
        invocationCount: 0,
        message: "Run created. Invoke again with this runId to begin.",
        stageData: null,
      };
    }

    // ── 2. Load existing run ────────────────────────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id, current_stage, stage_status, invocation_count,
              extract(epoch FROM (now() - heartbeat_at))::int AS heartbeat_age_secs
       FROM ero_pipeline_state
       WHERE run_id = $1`,
      PipelineStateRow,
      [runId],
      { label: "Load ERO pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(
        `ERO run not found: ${runId}. Pass a valid runId or omit it to create a new run.`,
      );
    }

    const state = stateRows[0];
    const currentStage = state.current_stage as EroStageName;

    // ── 3. Already fully complete? ──────────────────────────────────
    if (
      state.stage_status === "complete" &&
      currentStage === ERO_STAGES[ERO_STAGES.length - 1]
    ) {
      return {
        runId,
        stage: currentStage,
        status: "complete",
        invocationCount: state.invocation_count,
        message: "Pipeline already complete. No further stages to run.",
        stageData: null,
      };
    }

    // ── 3b. Guard against double-execution / recover stale runs ──
    // If the stage is 'running', check the heartbeat age:
    //   - Fresh heartbeat (< 5 min): another invocation is still alive.
    //     Return 'in_progress' so the poll loop waits.
    //   - Stale heartbeat (≥ 5 min): prior execution is dead (timeout,
    //     crash). Reset to 'pending' so this invocation can resume it.
    if (state.stage_status === "running") {
      const age = state.heartbeat_age_secs ?? 9999;
      if (age < STALE_HEARTBEAT_SECS) {
        // Still alive — back off
        return {
          runId,
          stage: currentStage,
          status: "in_progress",
          invocationCount: state.invocation_count,
          message: `Stage ${currentStage} is still executing (heartbeat ${age}s ago). Waiting…`,
          stageData: null,
        };
      }
      // Stale — prior execution is dead. Reset to 'pending' to allow resume.
      await db.execute(
        `UPDATE ero_pipeline_state
         SET stage_status = 'pending',
             updated_at   = now()
         WHERE run_id = $1`,
        [runId],
        { label: `Reset stale stage ${currentStage} (heartbeat ${age}s ago)` },
      );
      // Fall through to execute the stage
    }

    // ── 4. Increment invocation (heartbeat is NOT set here) ────────
    // CRITICAL: heartbeat_at is updated ONLY inside stage handlers
    // during per-item progress (research, adjudication, confrontation).
    // Setting it here at orchestrator entry would defeat the stale-
    // heartbeat guard: every retry would refresh the heartbeat even
    // when the stage itself is failing, preventing stale detection.
    await db.execute(
      `UPDATE ero_pipeline_state
       SET invocation_count = invocation_count + 1,
           updated_at       = now()
       WHERE run_id = $1`,
      [runId],
      { label: "Increment invocation (no heartbeat)" },
    );
    const invocationCount = state.invocation_count + 1;

    // ── 5. Determine stage to run ───────────────────────────────────
    // If current stage is already complete, advance to next first.
    let stageToRun = currentStage;
    if (state.stage_status === "complete") {
      const idx = ERO_STAGES.indexOf(currentStage);
      if (idx < ERO_STAGES.length - 1) {
        stageToRun = ERO_STAGES[idx + 1];
        await db.execute(
          `UPDATE ero_pipeline_state
           SET current_stage = $2,
               stage_status  = 'pending',
               updated_at    = now()
           WHERE run_id = $1`,
          [runId, stageToRun],
          { label: `Advance to ${stageToRun}` },
        );
      }
    }

    // ── 6. Budget guard ─────────────────────────────────────────────
    const elapsed = Date.now() - invocationStart;
    if (elapsed >= STAGE_BUDGET_MS) {
      return {
        runId,
        stage: stageToRun,
        status: "in_progress",
        invocationCount,
        message: `Budget exhausted (${elapsed}ms). Re-invoke to continue.`,
        stageData: null,
      };
    }

    // ── 7. Set stage_status = 'running' ─────────────────────────────
    await db.execute(
      `UPDATE ero_pipeline_state
       SET stage_status = 'running',
           updated_at   = now()
       WHERE run_id = $1`,
      [runId],
      { label: `Mark ${stageToRun} running` },
    );

    // ── 8. Dispatch to stub handler ─────────────────────────────────
    const handler = DISPATCH[stageToRun];
    if (!handler) {
      throw new Error(`No handler registered for stage: ${stageToRun}`);
    }

    let result: StageResult;
    try {
      result = await handler(ctx, runId, dealId);
    } catch (stageError: unknown) {
      // ── Transient failure: reset to 'pending' so the next poll
      //    retries immediately instead of waiting for the 5-min
      //    stale-heartbeat timeout. ──────────────────────────────
      try {
        await db.execute(
          `UPDATE ero_pipeline_state
           SET stage_status = 'pending',
               updated_at   = now()
           WHERE run_id = $1`,
          [runId],
          { label: `Reset ${stageToRun} to pending after transient error` },
        );
      } catch {
        // If even the reset fails (DB fully down), leave as 'running'
        // and let stale-heartbeat handle it on recovery.
      }
      // Re-throw so the client sees the error and retries via poll loop
      throw stageError;
    }

    // ── 9. Process result ───────────────────────────────────────────
    if (result.status === "not_implemented" || result.status === "complete") {
      // Advance to next stage, or mark pipeline complete if last.
      const idx = ERO_STAGES.indexOf(stageToRun);
      if (idx < ERO_STAGES.length - 1) {
        const nextStage = ERO_STAGES[idx + 1];
        await db.execute(
          `UPDATE ero_pipeline_state
           SET current_stage = $2,
               stage_status  = 'pending',
               updated_at    = now()
           WHERE run_id = $1`,
          [runId, nextStage],
          { label: `Advance to ${nextStage}` },
        );
      } else {
        // Last stage finished — pipeline complete.
        await db.execute(
          `UPDATE ero_pipeline_state
           SET stage_status = 'complete',
               updated_at   = now()
           WHERE run_id = $1`,
          [runId],
          { label: "Mark pipeline complete" },
        );
      }
    } else if (result.status === "in_progress") {
      // Stage needs more time; leave current_stage unchanged.
      await db.execute(
        `UPDATE ero_pipeline_state
         SET stage_status = 'pending',
             updated_at   = now()
         WHERE run_id = $1`,
        [runId],
        { label: `${stageToRun} in_progress — reset to pending` },
      );
    } else if (result.status === "failed") {
      await db.execute(
        `UPDATE ero_pipeline_state
         SET stage_status = 'failed',
             updated_at   = now()
         WHERE run_id = $1`,
        [runId],
        { label: `${stageToRun} failed` },
      );
    }

    return {
      runId,
      stage: result.stage,
      status: result.status,
      invocationCount,
      message: result.message,
      stageData: result.stageData ?? null,
    };
  },
});
