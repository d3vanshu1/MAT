/**
 * mast-run-pipeline.ts
 *
 * MAST v2 orchestrator — one stage per invocation.
 *
 * Concurrency: compare-and-set lock via payload.owner_token in the _lock row
 * of mast_pipeline_state. Only one invocation may advance stages at a time.
 *
 * MAST owns this orchestrator end to end. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  STAGES,
  type StageName,
  getStageHandler,
} from "./mast-stages.js";
import {
  EFFECTIVE_CAP_MS,
  PLATFORM_HEADROOM_MS,
} from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[MAST-PIPELINE]";

// ---------------------------------------------------------------------------
// Cross-environment UUID v4 — globalThis.crypto.randomUUID is not reliably available in this runtime
// ---------------------------------------------------------------------------
function mastRandomUUID(): string {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).crypto?.randomUUID === "function") {
    return (globalThis as any).crypto.randomUUID() as string;
  }
  // RFC 4122 v4 UUID — pure JS fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Staleness threshold for lock reclaim (ms).
 *
 * Must exceed the longest possible legitimate invocation so a concurrent
 * poll never claims a still-running lock.  Same reasoning as
 * STALENESS_THRESHOLD_MINUTES in pipeline-config.ts: effective cap plus
 * a generous grace margin for clock skew and DB latency.
 *
 * Formula: EFFECTIVE_CAP_MS + (PLATFORM_HEADROOM_MS × 2)
 *          = 300 000 + 60 000 = 360 000 ms (6 min) at the current cap.
 */
const LOCK_STALENESS_MS = EFFECTIVE_CAP_MS + (PLATFORM_HEADROOM_MS * 2);

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const CasResultRow = z.object({ run_id: z.string() });
const RunIdRow = z.object({ id: z.string() });
const ModuleRunRow = z.object({ id: z.string(), status: z.string() });

const MAST_MODULE_ID = "model_assumptions_stress";

const StateRow = z.object({
  stage: z.string(),
  status: z.string(),
  resume_position: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastRunPipeline",
  description: "Advances the MAST v2 pipeline by one stage",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string().uuid().nullish(),
    dealId: z.string().uuid(),
  }),

  output: z.object({
    status: z.enum(["advanced", "stage_partial", "done", "failed", "owned_elsewhere"]),
    stage: z.string().nullable(),
    resumePosition: z.number(),
    itemsTotal: z.number(),
    message: z.string(),
    runId: z.string(),
  }),

  async run(ctx, { runId: inputRunId, dealId }) {
    const invocationStart = Date.now();
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.ai;

    if (!ai) {
      throw new Error(
        `${LOG_PREFIX} Anthropic integration (ai) is missing from ctx.integrations. ` +
        `Ensure the anthropic integration (${ANTHROPIC_ID}) is configured and accessible.`,
      );
    }

    // ── 0. Resolve or create module_runs row ──────────────────────────
    let runId: string;

    if (inputRunId) {
      // Validate the supplied runId exists for this deal and module
      const runCheck = await db.query(
        `SELECT id, status FROM module_runs
         WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = $3
         LIMIT 1`,
        ModuleRunRow,
        [inputRunId, dealId, MAST_MODULE_ID],
        { label: "MAST: validate module_runs row" },
      );
      if (runCheck.length === 0) {
        throw new Error(
          `${LOG_PREFIX} No module_runs row for runId=${inputRunId} deal=${dealId} module=${MAST_MODULE_ID}`,
        );
      }
      runId = inputRunId;
      console.log(`${LOG_PREFIX} Using supplied run ${runId} (status=${runCheck[0].status}).`);
    } else {
      // Look for an existing non-completed run
      const existingRun = await db.query(
        `SELECT id FROM module_runs
         WHERE deal_id = $1::uuid AND module_id = $2 AND status != 'completed'::module_status
         ORDER BY triggered_at DESC
         LIMIT 1`,
        RunIdRow,
        [dealId, MAST_MODULE_ID],
        { label: "MAST: check existing active run" },
      );

      if (existingRun.length > 0) {
        runId = existingRun[0].id;
        console.log(`${LOG_PREFIX} Resuming existing run ${runId}.`);
      } else {
        // Create a new module_runs row
        const newRunRows = await db.query(
          `INSERT INTO module_runs (deal_id, module_id, status, documents_included)
           VALUES ($1::uuid, $2, 'running'::module_status, '{}'::text[])
           RETURNING id`,
          RunIdRow,
          [dealId, MAST_MODULE_ID],
          { label: "MAST: create module_runs row" },
        );
        runId = newRunRows[0].id;
        console.log(`${LOG_PREFIX} Created new run ${runId}.`);
      }
    }

    // Generate a unique token for this invocation
    const token = mastRandomUUID();

    // ── 1. Ensure rows exist for every stage + _lock ──────────────────
    const allStages = [...STAGES, "_lock"] as const;
    for (const stage of allStages) {
      await db.execute(
        `INSERT INTO mast_pipeline_state (run_id, deal_id, stage, status)
         VALUES ($1::uuid, $2::uuid, $3, 'pending')
         ON CONFLICT (run_id, stage) DO NOTHING`,
        [runId, dealId, stage],
        { label: `MAST init: ${stage}` },
      );
    }

    // ── 2. Acquire lock via CAS on _lock row's payload ────────────────
    //    Claim if: no owner_token, or lock is stale (updated_at older than threshold).
    const stalenessSeconds = Math.floor(LOCK_STALENESS_MS / 1000);
    const claimed = await db.query(
      `UPDATE mast_pipeline_state
       SET payload = jsonb_build_object('owner_token', $2::text),
           updated_at = now()
       WHERE run_id = $1::uuid
         AND stage = '_lock'
         AND (
           payload IS NULL
           OR payload->>'owner_token' IS NULL
           OR updated_at < now() - interval '${stalenessSeconds} seconds'
         )
       RETURNING run_id`,
      CasResultRow,
      [runId, token],
      { label: "MAST CAS lock acquire" },
    );

    if (claimed.length === 0) {
      const elapsed = Date.now() - invocationStart;
      console.log(
        `${LOG_PREFIX} INVOCATION_ELAPSED stage=none status=owned_elsewhere elapsed_ms=${elapsed} resume_position=0`,
      );
      return {
        status: "owned_elsewhere" as const,
        stage: null,
        resumePosition: 0,
        itemsTotal: 0,
        message: "Lock held by another invocation.",
        runId,
      };
    }

    // ── Helper: release lock (only if this invocation still owns it) ──
    const releaseLock = async () => {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = NULL, updated_at = now()
         WHERE run_id = $1::uuid
           AND stage = '_lock'
           AND payload->>'owner_token' = $2::text`,
        [runId, token],
        { label: "MAST release lock" },
      );
    };

    // Track stage for the error path
    let activeStage: StageName | null = null;

    try {
      // ── 3. Read all non-lock stage rows, ordered by registry ────────
      //    Use array_position to enforce canonical order.
      const stageArray = STAGES.map((s) => `'${s}'`).join(",");
      const stateRows = await db.query(
        `SELECT stage, status, resume_position
         FROM mast_pipeline_state
         WHERE run_id = $1::uuid AND stage != '_lock'
         ORDER BY array_position(ARRAY[${stageArray}], stage)`,
        StateRow,
        [runId],
        { label: "MAST read pipeline state" },
      );

      const stateMap = new Map(stateRows.map((r) => [r.stage, r]));

      // ── 4. Find first non-complete stage ────────────────────────────
      let currentStage: StageName | null = null;
      for (const stage of STAGES) {
        const row = stateMap.get(stage);
        if (!row || row.status !== "complete") {
          currentStage = stage;
          break;
        }
      }
      activeStage = currentStage;

      // All stages complete
      if (currentStage === null) {
        const elapsed = Date.now() - invocationStart;
        console.log(
          `${LOG_PREFIX} INVOCATION_ELAPSED stage=none status=done elapsed_ms=${elapsed} resume_position=0`,
        );
        await releaseLock();
        return {
          status: "done" as const,
          stage: null,
          resumePosition: 0,
          itemsTotal: 0,
          message: `All ${STAGES.length} stages complete.`,
          runId,
        };
      }

      // ── 5. Mark stage running, execute handler ──────────────────────
      const stageRow = stateMap.get(currentStage);
      const resumePosition = stageRow?.resume_position ?? 0;

      await db.execute(
        `UPDATE mast_pipeline_state
         SET status = 'running', started_at = now(), error_text = NULL, updated_at = now()
         WHERE run_id = $1::uuid AND stage = $2`,
        [runId, currentStage],
        { label: `MAST mark running: ${currentStage}` },
      );

      console.log(
        `${LOG_PREFIX} Entering stage: ${currentStage} (resume_position=${resumePosition})`,
      );

      const handler = getStageHandler(currentStage);
      if (!handler) {
        // Stage has no handler (e.g. lineage — removed, pending contract prune).
        // Treat as instantly complete so the orchestrator advances past it.
        const elapsed = Date.now() - invocationStart;
        console.log(`${LOG_PREFIX} Stage ${currentStage} has no handler — auto-completing.`);
        await db.execute(
          `UPDATE mast_pipeline_state
           SET status = 'complete', resume_position = 0, updated_at = now()
           WHERE run_id = $1::uuid AND stage = $2`,
          [runId, currentStage],
          { label: `MAST auto-complete handler-less stage: ${currentStage}` },
        );
        console.log(
          `${LOG_PREFIX} INVOCATION_ELAPSED stage=${currentStage} status=advanced elapsed_ms=${elapsed} resume_position=0`,
        );
        await releaseLock();
        return {
          status: "advanced" as const,
          stage: currentStage,
          resumePosition: 0,
          itemsTotal: 0,
          message: `Stage ${currentStage} auto-completed (no handler).`,
          runId,
        };
      }
      const result = await handler({
        db,
        ai,
        runId,
        dealId,
        resumePosition,
      });

      if (result.complete) {
        // ── Stage complete ────────────────────────────────────────────
        const elapsed = Date.now() - invocationStart;

        // Persist elapsed into the stage's payload under last_invocation_elapsed_ms
        await db.execute(
          `UPDATE mast_pipeline_state
           SET status = 'complete',
               resume_position = $3,
               payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('last_invocation_elapsed_ms', $4::int),
               updated_at = now()
           WHERE run_id = $1::uuid AND stage = $2`,
          [runId, currentStage, result.resumePosition, elapsed],
          { label: `MAST mark complete: ${currentStage}` },
        );

        console.log(
          `${LOG_PREFIX} INVOCATION_ELAPSED stage=${currentStage} status=advanced elapsed_ms=${elapsed} resume_position=${result.resumePosition}`,
        );
        await releaseLock();
        return {
          status: "advanced" as const,
          stage: currentStage,
          resumePosition: result.resumePosition,
          itemsTotal: result.itemsTotal,
          message: `Stage ${currentStage} complete.`,
          runId,
        };
      }

      // ── Stage partial (loop stage hit budget) ───────────────────────
      const elapsed = Date.now() - invocationStart;

      // Persist elapsed into the stage's payload under last_invocation_elapsed_ms
      await db.execute(
        `UPDATE mast_pipeline_state
         SET resume_position = $3,
             payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('last_invocation_elapsed_ms', $4::int),
             updated_at = now()
         WHERE run_id = $1::uuid AND stage = $2`,
        [runId, currentStage, result.resumePosition, elapsed],
        { label: `MAST persist partial: ${currentStage}` },
      );

      console.log(
        `${LOG_PREFIX} INVOCATION_ELAPSED stage=${currentStage} status=stage_partial elapsed_ms=${elapsed} resume_position=${result.resumePosition}`,
      );
      await releaseLock();
      return {
        status: "stage_partial" as const,
        stage: currentStage,
        resumePosition: result.resumePosition,
        itemsTotal: result.itemsTotal,
        message: `Stage ${currentStage} partial: ${result.itemsDone}/${result.itemsTotal} items done.`,
        runId,
      };
    } catch (err) {
      // ── Error path: mark stage failed, release lock ─────────────────
      const msg = err instanceof Error ? err.message : String(err);
      const elapsed = Date.now() - invocationStart;
      console.log(
        `${LOG_PREFIX} INVOCATION_ELAPSED stage=${activeStage ?? "none"} status=failed elapsed_ms=${elapsed} resume_position=0`,
      );
      console.warn(`${LOG_PREFIX} Stage FAILED: ${msg}`);

      if (activeStage !== null) {
        try {
          await db.execute(
            `UPDATE mast_pipeline_state
             SET status = 'failed', error_text = $3, updated_at = now()
             WHERE run_id = $1::uuid AND stage = $2`,
            [runId, activeStage, msg.slice(0, 2000)],
            { label: `MAST mark failed: ${activeStage}` },
          );
        } catch {
          // Ignore — lock release is more important
        }
      }

      await releaseLock();
      return {
        status: "failed" as const,
        stage: activeStage,
        resumePosition: 0,
        itemsTotal: 0,
        message: msg.slice(0, 2000),
        runId,
      };
    }
  },
});
