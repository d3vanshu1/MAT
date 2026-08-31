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

/** Staleness threshold for lock reclaim (ms). */
const LOCK_STALENESS_MS = 300_000; // 300 seconds

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const CasResultRow = z.object({ run_id: z.string() });

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
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
  }),

  output: z.object({
    status: z.enum(["advanced", "stage_partial", "done", "failed", "owned_elsewhere"]),
    stage: z.string().nullable(),
    resumePosition: z.number(),
    itemsTotal: z.number(),
    message: z.string(),
  }),

  async run(ctx, { runId, dealId }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.ai;

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
      console.log(`${LOG_PREFIX} Lock held by another invocation for run ${runId}.`);
      return {
        status: "owned_elsewhere" as const,
        stage: null,
        resumePosition: 0,
        itemsTotal: 0,
        message: "Lock held by another invocation.",
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
        console.log(`${LOG_PREFIX} All ${STAGES.length} stages complete for run ${runId}.`);
        await releaseLock();
        return {
          status: "done" as const,
          stage: null,
          resumePosition: 0,
          itemsTotal: 0,
          message: `All ${STAGES.length} stages complete.`,
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
      const result = await handler({
        db,
        ai,
        runId,
        dealId,
        resumePosition,
      });

      if (result.complete) {
        // ── Stage complete ────────────────────────────────────────────
        await db.execute(
          `UPDATE mast_pipeline_state
           SET status = 'complete', resume_position = $3, updated_at = now()
           WHERE run_id = $1::uuid AND stage = $2`,
          [runId, currentStage, result.resumePosition],
          { label: `MAST mark complete: ${currentStage}` },
        );

        console.log(
          `${LOG_PREFIX} Stage ${currentStage} complete (${result.itemsDone}/${result.itemsTotal}).`,
        );
        await releaseLock();
        return {
          status: "advanced" as const,
          stage: currentStage,
          resumePosition: result.resumePosition,
          itemsTotal: result.itemsTotal,
          message: `Stage ${currentStage} complete.`,
        };
      }

      // ── Stage partial (loop stage hit budget) ───────────────────────
      await db.execute(
        `UPDATE mast_pipeline_state
         SET resume_position = $3, updated_at = now()
         WHERE run_id = $1::uuid AND stage = $2`,
        [runId, currentStage, result.resumePosition],
        { label: `MAST persist partial: ${currentStage}` },
      );

      console.log(
        `${LOG_PREFIX} Stage ${currentStage} partial: ${result.itemsDone}/${result.itemsTotal} (resume_position=${result.resumePosition}).`,
      );
      await releaseLock();
      return {
        status: "stage_partial" as const,
        stage: currentStage,
        resumePosition: result.resumePosition,
        itemsTotal: result.itemsTotal,
        message: `Stage ${currentStage} partial: ${result.itemsDone}/${result.itemsTotal} items done.`,
      };
    } catch (err) {
      // ── Error path: mark stage failed, release lock ─────────────────
      const msg = err instanceof Error ? err.message : String(err);
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
      };
    }
  },
});
