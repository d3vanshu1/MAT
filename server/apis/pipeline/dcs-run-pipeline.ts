/**
 * DCS Rebuild — Packet 5A: Resumable Orchestrator.
 *
 * DcsRunPipeline — single entry-point that creates or resumes a
 * `diligence_completeness` run and advances it through all six stages:
 *
 *   1. extract        → DcsExtractPresence (cursor-resumable)
 *   2. verdicts       → DcsComputeVerdicts
 *   3. summary        → DcsComputeSummary
 *   4. overlay        → DcsComputeMaterialityOverlay
 *   5. render         → DcsRenderReport
 *   6. complete       → marks module_runs row completed
 *
 * EXECUTION MODEL  (mirrors BssRunPipeline):
 *   - Each invocation finds the first non-done stage.
 *   - Runs ONE stage, marks it done, and returns.
 *   - The UI re-invokes to advance — the orchestrator never loops across stages.
 *   - Extract is the only loop stage (cursor-based); all others are atomic.
 *
 * CONCURRENCY:
 *   - Owner-token CAS on dcs_pipeline_state.owner_token prevents concurrent runs.
 *   - 10-minute staleness threshold enables recovery after platform kill.
 *
 * STAGE TRACKING:
 *   - dcs_pipeline_state rows are constrained to: extract, verdicts, render.
 *   - summary/overlay/complete are logical stages tracked via the verdicts
 *     row's detail JSON: { summary_done, overlay_done }.
 *   - complete is inferred from module_runs.status = 'completed'.
 *
 * BUDGET:
 *   - INVOCATION_BUDGET_MS = 240 000 ms (60 s margin before 300 s kill).
 *   - MIN_HEADROOM_MS = 60 000 ms — non-extract stages are skipped if
 *     less than 60 s remain, returning `stage_partial` so the UI re-invokes.
 *
 * SCOPE FENCE — this file MUST NOT contain:
 *   - getModuleModel / callLLMWithHeadroom
 *   - computeHeadlineScore / computeDimensionState
 *   - Direct INSERT into dcs_evidence / dcs_dimension_verdicts / dcs_summaries
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

// ── Child API imports (compiled) ─────────────────────────────────
import DcsExtractPresence from "./dcs-extract-presence.js";
import DcsComputeVerdicts from "./dcs-compute-verdicts.js";
import DcsComputeSummary from "./dcs-compute-summary.js";
import DcsComputeMaterialityOverlay from "./dcs-compute-materiality-overlay.js";
import DcsRenderReport from "./dcs-render-report.js";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[DCS-PIPELINE]";

// ── Pipeline constants ───────────────────────────────────────────

/** Ordered logical stages. */
const DCS_STAGES = [
  "extract",
  "verdicts",
  "summary",
  "overlay",
  "render",
  "complete",
] as const;
type DcsStageName = (typeof DCS_STAGES)[number];

/**
 * Physical stages that have rows in dcs_pipeline_state.
 * Constrained by CHECK (stage IN ('extract','verdicts','render')).
 */
const PHYSICAL_STAGES: ReadonlySet<string> = new Set(["extract", "verdicts", "render"]);

/** Budget: stop starting new work past this. */
const INVOCATION_BUDGET_MS = 240_000;

/** Non-extract stages need at least this much headroom. */
const MIN_HEADROOM_MS = 60_000;

/** Staleness threshold for lock reclaim. */
const STALENESS_MS = 10 * 60 * 1000; // 10 minutes

const MODULE_ID = "diligence_completeness";

// ── Row schemas ──────────────────────────────────────────────────

const PipelineStateRow = z.object({
  run_id: z.string(),
  stage: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  cursor_value: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const RunIdRow = z.object({ id: z.string() });

const ModuleRunRow = z.object({
  id: z.string(),
  status: z.string(),
});

const ClaimedRow = z.object({ id: z.string() });

const CountRow = z.object({ cnt: z.coerce.number() });

const ModuleOutputRow = z.object({
  id: z.string(),
  executive_header: z.string().nullable(),
  full_report_markdown: z.string().nullable(),
});

const OutputIdRow = z.object({ id: z.string() });

/**
 * Verdicts detail JSON — tracks logical sub-stages that
 * don't have physical dcs_pipeline_state rows.
 */
interface VerdictsDetail {
  summary_done?: boolean;
  overlay_done?: boolean;
}

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════

export default api({
  name: "DcsRunPipeline",
  description: "Resumable one-stage-per-invocation orchestrator for DCS rebuild pipeline",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    runId: z.string().uuid().optional().nullable(),
    ownerToken: z.string().uuid().optional().nullable(),
    batchSize: z.number().int().min(1).max(8).default(8),
  }),

  output: z.object({
    runId: z.string(),
    ownerToken: z.string(),
    status: z.enum([
      "created",
      "stage_partial",
      "advanced",
      "owned_elsewhere",
      "in_progress",
      "done",
      "failed",
    ]),
    stage: z.string().nullable(),
    nextStage: z.string().nullable(),
    resumeRequired: z.boolean(),
    savedCursor: z.string().nullable(),
    remainingChunks: z.number().nullable(),
    elapsedMs: z.number(),
    error: z.string().nullable(),
    reportOverride: z.string().nullable(),
    headerOverride: z.string().nullable(),
    reportHash: z.string().nullable(),
    headlineScore: z.number().nullable(),
  }),

  async run(ctx, input) {
    const startTime = Date.now();
    const db = ctx.integrations.ic_diligence_db;
    const { dealId, batchSize } = input;

    // ── Helper: elapsed ──────────────────────────────────────────
    const elapsed = () => Date.now() - startTime;
    const remaining = () => INVOCATION_BUDGET_MS - elapsed();

    // ── Helper: build result ─────────────────────────────────────
    function mkResult(
      overrides: Partial<{
        runId: string;
        ownerToken: string;
        status: "created" | "stage_partial" | "advanced" | "owned_elsewhere" | "in_progress" | "done" | "failed";
        stage: string | null;
        nextStage: string | null;
        resumeRequired: boolean;
        savedCursor: string | null;
        remainingChunks: number | null;
        error: string | null;
        reportOverride: string | null;
        headerOverride: string | null;
        reportHash: string | null;
        headlineScore: number | null;
      }>,
    ) {
      return {
        runId: overrides.runId ?? "",
        ownerToken: overrides.ownerToken ?? "",
        status: overrides.status ?? "failed",
        stage: overrides.stage ?? null,
        nextStage: overrides.nextStage ?? null,
        resumeRequired: overrides.resumeRequired ?? false,
        savedCursor: overrides.savedCursor ?? null,
        remainingChunks: overrides.remainingChunks ?? null,
        elapsedMs: elapsed(),
        error: overrides.error ?? null,
        reportOverride: overrides.reportOverride ?? null,
        headerOverride: overrides.headerOverride ?? null,
        reportHash: overrides.reportHash ?? null,
        headlineScore: overrides.headlineScore ?? null,
      };
    }

    // ════════════════════════════════════════════════════════════
    // 1. CREATE OR RESUME run
    // ════════════════════════════════════════════════════════════

    let runId: string;
    let ownerToken: string;
    let isNewRun = false;

    // Ensure owner_token column exists on dcs_pipeline_state (we own this table)
    await db.execute(
      `ALTER TABLE dcs_pipeline_state ADD COLUMN IF NOT EXISTS owner_token UUID NULL`,
      [],
      { label: "Ensure owner_token column on dcs_pipeline_state" },
    );

    if (input.runId) {
      // ── Resume existing run ──────────────────────────────────
      runId = input.runId;
      ownerToken = input.ownerToken ?? crypto.randomUUID();

      // Validate the run exists and check if already completed
      const runCheck = await db.query(
        `SELECT id, status FROM module_runs
         WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = $3
         LIMIT 1`,
        ModuleRunRow,
        [runId, dealId, MODULE_ID],
        { label: "Validate module_runs row" },
      );
      if (runCheck.length === 0) {
        throw new Error(
          `No module_runs row for runId=${runId} deal=${dealId} module=${MODULE_ID}`,
        );
      }

      // ── Completed-run readback ────────────────────────────────
      if (runCheck[0].status === "completed") {
        const existingOutput = await db.query(
          `SELECT id, executive_header, full_report_markdown
           FROM module_outputs
           WHERE module_run_id = $1::uuid
           LIMIT 1`,
          ModuleOutputRow,
          [runId],
          { label: "Readback: check module_outputs for completed run" },
        );
        if (existingOutput.length > 0) {
          console.log(`${LOG_PREFIX} Run ${runId} already completed with published output ${existingOutput[0].id}.`);
          return mkResult({
            runId,
            ownerToken,
            status: "done",
            stage: "complete",
            nextStage: null,
            resumeRequired: false,
            reportOverride: existingOutput[0].full_report_markdown,
            headerOverride: existingOutput[0].executive_header,
          });
        }
        // Completed but no module_outputs — integrity error
        throw new Error(
          `Integrity error: module_runs ${runId} is completed but no module_outputs row exists. ` +
          `Manual investigation required.`,
        );
      }
    } else {
      // ── Create new run ───────────────────────────────────────
      ownerToken = input.ownerToken ?? crypto.randomUUID();

      // Check for an existing non-completed run
      const existingRun = await db.query(
        `SELECT id FROM module_runs
         WHERE deal_id = $1::uuid AND module_id = $2 AND status != 'completed'::module_status
         ORDER BY triggered_at DESC
         LIMIT 1`,
        RunIdRow,
        [dealId, MODULE_ID],
        { label: "Check existing active run" },
      );

      if (existingRun.length > 0) {
        // Resume the existing run
        runId = existingRun[0].id;
        console.log(`${LOG_PREFIX} Resuming existing run ${runId}`);
      } else {
        // Create a new module_runs row
        const newRunRows = await db.query(
          `INSERT INTO module_runs (deal_id, module_id, status, documents_included)
           VALUES ($1::uuid, $2, 'running'::module_status, '{}'::text[])
           RETURNING id`,
          RunIdRow,
          [dealId, MODULE_ID],
          { label: "Create module_runs row" },
        );
        runId = newRunRows[0].id;
        isNewRun = true;
        console.log(`${LOG_PREFIX} Created new run ${runId}`);
      }
    }

    // ════════════════════════════════════════════════════════════
    // 2. ENSURE dcs_pipeline_state rows exist (physical stages only)
    // ════════════════════════════════════════════════════════════

    for (const stage of PHYSICAL_STAGES) {
      await db.execute(
        `INSERT INTO dcs_pipeline_state (run_id, stage, status)
         VALUES ($1::uuid, $2, 'pending')
         ON CONFLICT (run_id, stage) DO NOTHING`,
        [runId, stage],
        { label: `Init stage: ${stage}` },
      );
    }

    // ════════════════════════════════════════════════════════════
    // 3. OWNERSHIP CAS on dcs_pipeline_state.extract row
    //    (we own this table; module_runs is owned by another role)
    // ════════════════════════════════════════════════════════════

    const claimed = await db.query(
      `UPDATE dcs_pipeline_state
       SET owner_token = $2::uuid,
           updated_at  = now()
       WHERE run_id = $1::uuid
         AND stage = 'extract'
         AND (
           owner_token IS NULL
           OR owner_token = $2::uuid
           OR updated_at < now() - interval '${Math.floor(STALENESS_MS / 1000)} seconds'
         )
       RETURNING run_id AS id`,
      ClaimedRow,
      [runId, ownerToken],
      { label: "CAS ownership claim on dcs_pipeline_state.extract" },
    );

    if (claimed.length === 0) {
      console.log(`${LOG_PREFIX} Ownership CAS failed — another owner holds the lock.`);
      return mkResult({
        runId,
        ownerToken,
        status: "owned_elsewhere",
      });
    }

    // Ensure module_runs reflects running state
    await db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status
       WHERE id = $1::uuid AND status != 'completed'::module_status`,
      [runId],
      { label: "Ensure module_runs running" },
    );

    // If this is a brand-new run, return "created" immediately
    if (isNewRun) {
      return mkResult({
        runId,
        ownerToken,
        status: "created",
        stage: "extract",
        nextStage: "extract",
        resumeRequired: true,
      });
    }

    // ════════════════════════════════════════════════════════════
    // 4. READ PIPELINE STATE — find first non-done logical stage
    // ════════════════════════════════════════════════════════════

    const stateRows = await db.query(
      `SELECT run_id, stage, status, detail, cursor_value, updated_at::text
       FROM dcs_pipeline_state
       WHERE run_id = $1::uuid
       ORDER BY stage`,
      PipelineStateRow,
      [runId],
      { label: "Read pipeline state" },
    );
    const stateMap = new Map(stateRows.map((r) => [r.stage, r]));

    // Determine the current logical stage.
    // Physical stages: extract, verdicts, render (have dcs_pipeline_state rows).
    // Logical stages summary, overlay, complete are tracked via:
    //   - verdicts detail JSON: { summary_done, overlay_done }
    //   - module_runs.status for complete
    const currentStage = determineCurrentStage(stateMap);

    // Check if already done
    if (currentStage === null) {
      console.log(`${LOG_PREFIX} All stages already complete for run ${runId}.`);
      return mkResult({
        runId,
        ownerToken,
        status: "done",
        stage: "complete",
        nextStage: null,
        resumeRequired: false,
      });
    }

    // ════════════════════════════════════════════════════════════
    // 5. DISPATCH current stage
    // ════════════════════════════════════════════════════════════

    console.log(`${LOG_PREFIX} Current stage: ${currentStage}`);

    try {
      switch (currentStage) {
        // ── A. Extract ─────────────────────────────────────────
        case "extract": {
          // Get cursor from pipeline state
          const extractRow = stateMap.get("extract");
          const resumeCursor = extractRow?.cursor_value ?? undefined;

          // Mark running
          await markPhysicalStageRunning(db, runId, "extract");

          // Call DcsExtractPresence
          const extractResult = await DcsExtractPresence.run(ctx, {
            runId,
            dealId,
            batchSize,
            resumeCursor: resumeCursor || undefined,
            verificationChunkId: undefined,
            debug: false,
          });

          if (extractResult.resumeRequired) {
            // Partial — save cursor, stay in extract
            await db.execute(
              `UPDATE dcs_pipeline_state
               SET cursor_value = $2, detail = $3, updated_at = now()
               WHERE run_id = $1::uuid AND stage = 'extract'`,
              [
                runId,
                extractResult.savedCursor,
                JSON.stringify({
                  processed_count: extractResult.cumulativeProcessed,
                  evidence_rows_written: extractResult.cumulativeRowsWritten,
                  total_chunks: extractResult.remainingChunks + extractResult.cumulativeProcessed,
                  last_chunk_id: extractResult.savedCursor,
                }),
              ],
              { label: "Save extract cursor" },
            );

            await heartbeatOwner(db, runId);

            return mkResult({
              runId,
              ownerToken,
              status: "stage_partial",
              stage: "extract",
              nextStage: "extract",
              resumeRequired: true,
              savedCursor: extractResult.savedCursor,
              remainingChunks: extractResult.remainingChunks,
            });
          }

          // Extract complete
          const totalChunks = extractResult.cumulativeProcessed;
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET status = 'done',
                 cursor_value = $2,
                 detail = $3,
                 updated_at = now()
             WHERE run_id = $1::uuid AND stage = 'extract'`,
            [
              runId,
              extractResult.savedCursor,
              JSON.stringify({
                processed_count: totalChunks,
                evidence_rows_written: extractResult.cumulativeRowsWritten,
                total_chunks: totalChunks,
                last_chunk_id: extractResult.savedCursor,
              }),
            ],
            { label: "Mark extract done" },
          );

          await heartbeatOwner(db, runId);

          return mkResult({
            runId,
            ownerToken,
            status: "advanced",
            stage: "extract",
            nextStage: "verdicts",
            resumeRequired: true,
            savedCursor: extractResult.savedCursor,
            remainingChunks: 0,
          });
        }

        // ── B. Verdicts ────────────────────────────────────────
        case "verdicts": {
          if (remaining() < MIN_HEADROOM_MS) {
            console.log(`${LOG_PREFIX} Insufficient headroom for verdicts (${remaining()}ms).`);
            return mkResult({
              runId,
              ownerToken,
              status: "stage_partial",
              stage: "verdicts",
              nextStage: "verdicts",
              resumeRequired: true,
            });
          }

          await markPhysicalStageRunning(db, runId, "verdicts");

          const verdictsResult = await DcsComputeVerdicts.run(ctx, {
            runId,
            dealId,
            verificationMode: false,
          });

          await markPhysicalStageDone(db, runId, "verdicts");
          await heartbeatOwner(db, runId);

          console.log(
            `${LOG_PREFIX} Verdicts complete: ${verdictsResult.stateCounts.evidenced}E / ${verdictsResult.stateCounts.asserted}A / ${verdictsResult.stateCounts.absent}Ab`,
          );

          return mkResult({
            runId,
            ownerToken,
            status: "advanced",
            stage: "verdicts",
            nextStage: "summary",
            resumeRequired: true,
          });
        }

        // ── C. Summary ─────────────────────────────────────────
        case "summary": {
          if (remaining() < MIN_HEADROOM_MS) {
            console.log(`${LOG_PREFIX} Insufficient headroom for summary (${remaining()}ms).`);
            return mkResult({
              runId,
              ownerToken,
              status: "stage_partial",
              stage: "summary",
              nextStage: "summary",
              resumeRequired: true,
            });
          }

          const summaryResult = await DcsComputeSummary.run(ctx, {
            runId,
            dealId,
            verificationMode: false,
            verificationVerdicts: null,
          });

          // Mark summary_done in verdicts detail
          await setVerdictsDetailFlag(db, runId, "summary_done", true);
          await heartbeatOwner(db, runId);

          console.log(
            `${LOG_PREFIX} Summary complete: headlineScore=${summaryResult.headlineScore}`,
          );

          return mkResult({
            runId,
            ownerToken,
            status: "advanced",
            stage: "summary",
            nextStage: "overlay",
            resumeRequired: true,
            headlineScore: summaryResult.headlineScore,
          });
        }

        // ── D. Overlay ─────────────────────────────────────────
        case "overlay": {
          if (remaining() < MIN_HEADROOM_MS) {
            console.log(`${LOG_PREFIX} Insufficient headroom for overlay (${remaining()}ms).`);
            return mkResult({
              runId,
              ownerToken,
              status: "stage_partial",
              stage: "overlay",
              nextStage: "overlay",
              resumeRequired: true,
            });
          }

          const overlayResult = await DcsComputeMaterialityOverlay.run(ctx, {
            runId,
            dealId,
            verificationMode: false,
            verificationVerdicts: undefined,
            verificationOverlayCandidate: undefined,
          });

          // Mark overlay_done in verdicts detail
          await setVerdictsDetailFlag(db, runId, "overlay_done", true);
          await heartbeatOwner(db, runId);

          console.log(
            `${LOG_PREFIX} Overlay complete: accepted=${overlayResult.overlayAccepted}, modelCalled=${overlayResult.modelCalled}`,
          );

          return mkResult({
            runId,
            ownerToken,
            status: "advanced",
            stage: "overlay",
            nextStage: "render",
            resumeRequired: true,
          });
        }

        // ── E. Render ──────────────────────────────────────────
        case "render": {
          if (remaining() < MIN_HEADROOM_MS) {
            console.log(`${LOG_PREFIX} Insufficient headroom for render (${remaining()}ms).`);
            return mkResult({
              runId,
              ownerToken,
              status: "stage_partial",
              stage: "render",
              nextStage: "render",
              resumeRequired: true,
            });
          }

          await markPhysicalStageRunning(db, runId, "render");

          const renderResult = await DcsRenderReport.run(ctx, {
            runId,
            dealId,
            verificationMode: false,
            verificationVerdicts: undefined,
            verificationSummary: undefined,
            verificationMaterialityOverlay: undefined,
          });

          await markPhysicalStageDone(db, runId, "render");
          await heartbeatOwner(db, runId);

          console.log(
            `${LOG_PREFIX} Render complete: hash=${renderResult.reportHash}, score=${renderResult.headlineScore}`,
          );

          return mkResult({
            runId,
            ownerToken,
            status: "advanced",
            stage: "render",
            nextStage: "complete",
            resumeRequired: true,
            reportOverride: renderResult.fullReportMarkdown,
            headerOverride: renderResult.executiveHeader,
            reportHash: renderResult.reportHash,
            headlineScore: renderResult.headlineScore,
          });
        }

        // ── F. Complete (publish → verify → mark done) ──────────
        case "complete": {
          // Check if module_outputs already exists (publication recovery)
          const existingPub = await db.query(
            `SELECT id FROM module_outputs
             WHERE module_run_id = $1::uuid
             LIMIT 1`,
            OutputIdRow,
            [runId],
            { label: "Complete: check existing module_outputs" },
          );

          let publishedHeader: string | null = null;
          let publishedReport: string | null = null;

          if (existingPub.length === 0) {
            // ── Publish to module_outputs ────────────────────────
            // Need the render output — re-call DcsRenderReport to reconstruct.
            // This is the publication-recovery path: render stage is done but
            // module_outputs was never written (crash between render and complete).
            console.log(`${LOG_PREFIX} No module_outputs for ${runId} — rendering for publication.`);

            const renderResult = await DcsRenderReport.run(ctx, {
              runId,
              dealId,
              verificationMode: false,
              verificationVerdicts: undefined,
              verificationSummary: undefined,
              verificationMaterialityOverlay: undefined,
            });

            publishedHeader = renderResult.executiveHeader;
            publishedReport = renderResult.fullReportMarkdown;

            // DELETE + INSERT (matches ERO pattern)
            await db.execute(
              `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
              [runId],
              { label: "Publish: clear existing module_outputs" },
            );

            await db.query(
              `INSERT INTO module_outputs
                 (module_run_id, executive_header, findings, full_report_markdown)
               VALUES ($1::uuid, $2, $3::jsonb, $4)
               RETURNING id`,
              OutputIdRow,
              [runId, renderResult.executiveHeader, JSON.stringify([]), renderResult.fullReportMarkdown],
              { label: "Publish: insert module_outputs row" },
            );

            console.log(`${LOG_PREFIX} Published module_outputs for run ${runId}.`);
          } else {
            console.log(`${LOG_PREFIX} module_outputs already exists for ${runId} (id=${existingPub[0].id}).`);
          }

          // ── Readback verification ──────────────────────────────
          const readback = await db.query(
            `SELECT id, executive_header, full_report_markdown
             FROM module_outputs
             WHERE module_run_id = $1::uuid
             LIMIT 1`,
            ModuleOutputRow,
            [runId],
            { label: "Publish: readback verification" },
          );

          if (readback.length === 0) {
            throw new Error(
              `Publication verification failed: module_outputs row not found after insert for run ${runId}`,
            );
          }

          // Use readback values if we didn't just publish (pre-existing)
          if (!publishedHeader) publishedHeader = readback[0].executive_header;
          if (!publishedReport) publishedReport = readback[0].full_report_markdown;

          // ── Mark module_runs completed ─────────────────────────
          await db.execute(
            `UPDATE module_runs
             SET status = 'completed'::module_status,
                 completed_at = now()
             WHERE id = $1::uuid`,
            [runId],
            { label: "Mark module_runs completed" },
          );

          // ── Bump deals.updated_at ─────────────────────────────
          await db.execute(
            `UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid`,
            [dealId],
            { label: "Publish: bump deal updated_at" },
          );

          // ── Release CAS lock ──────────────────────────────────
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET owner_token = NULL, updated_at = now()
             WHERE run_id = $1::uuid AND stage = 'extract'`,
            [runId],
            { label: "Release ownership lock" },
          );

          console.log(`${LOG_PREFIX} Run ${runId} COMPLETE.`);

          return mkResult({
            runId,
            ownerToken,
            status: "done",
            stage: "complete",
            nextStage: null,
            resumeRequired: false,
            reportOverride: publishedReport,
            headerOverride: publishedHeader,
          });
        }

        default: {
          throw new Error(`Unknown stage: ${currentStage}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Stage ${currentStage} FAILED: ${msg}`);

      // Mark the physical stage as failed if applicable
      if (currentStage && PHYSICAL_STAGES.has(currentStage)) {
        await db.execute(
          `UPDATE dcs_pipeline_state
           SET status = 'failed', detail = $3, updated_at = now()
           WHERE run_id = $1::uuid AND stage = $2`,
          [runId, currentStage, msg.slice(0, 2000)],
          { label: `Mark failed: ${currentStage}` },
        ).catch(() => { /* best-effort */ });
      }

      // Mark module_runs as failed
      await db.execute(
        `UPDATE module_runs
         SET status = 'failed'::module_status
         WHERE id = $1::uuid AND status != 'completed'::module_status`,
        [runId],
        { label: "Mark module_runs failed" },
      ).catch(() => { /* best-effort */ });

      return mkResult({
        runId,
        ownerToken,
        status: "failed",
        stage: currentStage,
        nextStage: null,
        error: msg.slice(0, 2000),
      });
    }
  },
});

// ═════════════════════════════════════════════════════════════════
// Stage determination
// ═════════════════════════════════════════════════════════════════

/**
 * Walk the logical stage sequence and return the first non-done stage.
 * Returns null if all stages are complete.
 *
 * Physical stages (extract, verdicts, render) → checked via dcs_pipeline_state.
 * Logical stages (summary, overlay) → checked via verdicts row detail JSON.
 * Complete → checked via render being done (module_runs update is the action).
 */
function determineCurrentStage(
  stateMap: Map<string, { status: string; detail: string | null }>,
): DcsStageName | null {
  // 1. extract
  const extractRow = stateMap.get("extract");
  if (!extractRow || extractRow.status !== "done") return "extract";

  // 2. verdicts
  const verdictsRow = stateMap.get("verdicts");
  if (!verdictsRow || verdictsRow.status !== "done") return "verdicts";

  // 3. summary (logical — tracked in verdicts detail)
  const verdictsDetail = parseVerdictsDetail(verdictsRow.detail);
  if (!verdictsDetail.summary_done) return "summary";

  // 4. overlay (logical — tracked in verdicts detail)
  if (!verdictsDetail.overlay_done) return "overlay";

  // 5. render
  const renderRow = stateMap.get("render");
  if (!renderRow || renderRow.status !== "done") return "render";

  // 6. complete (module_runs needs to be marked completed)
  return "complete";
}

function parseVerdictsDetail(detail: string | null): VerdictsDetail {
  if (!detail) return {};
  try {
    return JSON.parse(detail) as VerdictsDetail;
  } catch {
    return {};
  }
}

// ═════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════

type DbClient = {
  query: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]>;
  execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any>;
};

async function markPhysicalStageRunning(db: DbClient, runId: string, stage: string): Promise<void> {
  await db.execute(
    `UPDATE dcs_pipeline_state
     SET status = 'running', updated_at = now()
     WHERE run_id = $1::uuid AND stage = $2`,
    [runId, stage],
    { label: `Mark running: ${stage}` },
  );
}

async function markPhysicalStageDone(db: DbClient, runId: string, stage: string): Promise<void> {
  await db.execute(
    `UPDATE dcs_pipeline_state
     SET status = 'done', updated_at = now()
     WHERE run_id = $1::uuid AND stage = $2`,
    [runId, stage],
    { label: `Mark done: ${stage}` },
  );
}

/**
 * Set a flag in the verdicts row's detail JSON.
 * Merges with existing detail to preserve other flags.
 */
async function setVerdictsDetailFlag(
  db: DbClient,
  runId: string,
  flag: keyof VerdictsDetail,
  value: boolean,
): Promise<void> {
  // Read current detail
  const rows = await db.query(
    `SELECT detail FROM dcs_pipeline_state
     WHERE run_id = $1::uuid AND stage = 'verdicts'
     LIMIT 1`,
    z.object({ detail: z.string().nullable() }),
    [runId],
    { label: `Read verdicts detail for ${flag}` },
  );

  const existing = parseVerdictsDetail(rows[0]?.detail ?? null);
  (existing as Record<string, boolean>)[flag] = value;

  await db.execute(
    `UPDATE dcs_pipeline_state
     SET detail = $2, updated_at = now()
     WHERE run_id = $1::uuid AND stage = 'verdicts'`,
    [runId, JSON.stringify(existing)],
    { label: `Set verdicts detail: ${flag}` },
  );
}

async function heartbeatOwner(db: DbClient, runId: string): Promise<void> {
  await db.execute(
    `UPDATE dcs_pipeline_state
     SET updated_at = now()
     WHERE run_id = $1::uuid AND stage = 'extract'`,
    [runId],
    { label: "Heartbeat owner on extract row" },
  );
}
