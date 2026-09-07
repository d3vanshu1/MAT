/**
 * cc-orchestrator.ts — Contradiction Check v2 orchestrator
 *
 * Sequences the CC pipeline stages without going through pipeline-core's
 * merge tree. Uses existing stage functions directly.
 *
 * Stages:
 *   1. claims_extraction  — Extract numeric claims from IC memos
 *   2. reconciliation     — Match claims against numeric report, run quality gates
 *   3. finalization       — Post-merge finding filter + canonical publish
 *
 * Extraction (chunk analysis) is handled by the v1 pipeline-core BEFORE
 * this orchestrator is entered — same pattern as OA v2.
 *
 * Checkpoints: pipeline_checkpoints (keyed by module_run_id + checkpoint_key)
 */
import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import { runClaimsExtraction } from "./claims-extraction.js";
import type { ClaimsLedger } from "./claims-extraction.js";
import { runReconciliationPipeline } from "./reconciliation-pipeline.js";
import type { ReconciliationResult } from "./claims-reconciliation.js";
import { runPostMergeFinalizationStages } from "./post-merge-finalization.js";
import { getPipelineVersion } from "./pipeline-version.js";

// ── Budget constants ─────────────────────────────────────────────
const TOTAL_BUDGET_MS = 450_000;
const STAGE_SAFETY_MARGIN_MS = 15_000;

// ── Stage sequence ───────────────────────────────────────────────
const CC_STAGES = [
  "claims_extraction",
  "reconciliation",
  "finalization",
] as const;

type CcStageName = typeof CC_STAGES[number];

// ── Result type ──────────────────────────────────────────────────
export interface CcPipelineResult {
  status: "complete" | "in_progress" | "failed";
  runId: string;
  currentStage: string;
  stagesComplete: string[];
  stagesFailed: string[];
  message: string;
}

// ── Checkpoint helpers ───────────────────────────────────────────
async function loadCheckpoint(db: any, runId: string, key: string): Promise<any | null> {
  try {
    var rows = await db.query(
      "SELECT payload, COALESCE(status, 'complete') AS status FROM pipeline_checkpoints WHERE module_run_id = $1 AND checkpoint_key = $2 LIMIT 1",
      z.object({ payload: z.any(), status: z.string() }),
      [runId, key],
      { label: "CC-ORCH: load checkpoint " + key },
    );
    if (rows.length > 0) return rows[0];
    return null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(db: any, runId: string, key: string, payload: any, status: string): Promise<void> {
  var version = getPipelineVersion();
  await db.execute(
    "INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash) " +
    "VALUES ($1, $2, $3::jsonb, $4, $5) " +
    "ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, status = $4, version_hash = $5, updated_at = now()",
    [runId, key, JSON.stringify(payload), status, version],
    { label: "CC-ORCH: save checkpoint " + key + " (" + status + ")" },
  );
}

// ── Transient error detection ────────────────────────────────────
function isTransientError(errMsg: string): boolean {
  return errMsg.indexOf("overloaded") !== -1
    || errMsg.indexOf("529") !== -1
    || errMsg.indexOf("503") !== -1
    || errMsg.indexOf("ECONNRESET") !== -1
    || errMsg.indexOf("ETIMEDOUT") !== -1
    || errMsg.indexOf("failed during \"query\"") !== -1
    || errMsg.indexOf("connection") !== -1;
}

// ── Main orchestrator ────────────────────────────────────────────
export async function runCcPipeline(
  ctx: PipelineContext,
  dealId: string,
  runId: string,
  subjectDocumentIds: string[],
  numericReport: any | null,
): Promise<CcPipelineResult> {
  var db = ctx.integrations.db;
  var startTime = Date.now();
  var elapsed = function() { return Date.now() - startTime; };
  var budgetRemaining = function() { return TOTAL_BUDGET_MS - elapsed(); };

  var stagesComplete: string[] = [];
  var stagesFailed: string[] = [];

  console.log("[CC-ORCH] Starting orchestrator for run " + runId + " deal " + dealId);

  // ── Stage 1: Claims Extraction ─────────────────────────────────
  var claimsLedger: ClaimsLedger | null = null;

  // Check if already complete
  var claimsCp = await loadCheckpoint(db, runId, "claims_ledger");
  if (claimsCp && claimsCp.payload && claimsCp.payload.complete) {
    claimsLedger = claimsCp.payload as ClaimsLedger;
    stagesComplete.push("claims_extraction");
    console.log("[CC-ORCH] claims_extraction already complete: " + claimsLedger.claims.length + " claims");
  } else {
    // Check budget
    if (budgetRemaining() < STAGE_SAFETY_MARGIN_MS) {
      return {
        status: "in_progress",
        runId: runId,
        currentStage: "claims_extraction",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Budget exhausted before claims_extraction.",
      };
    }

    console.log("[CC-ORCH] Entering claims_extraction (" + budgetRemaining() + "ms remaining)");
    try {
      var priorLedger = (claimsCp && claimsCp.payload) ? claimsCp.payload as ClaimsLedger : undefined;
      var chunkCursor: Record<string, number[]> = { ...(priorLedger?.chunk_cursor || {}) };

      var onChunkComplete = async function(event: { memoId: string; chunkIndex: number }) {
        var arr = chunkCursor[event.memoId] || [];
        if (!arr.includes(event.chunkIndex)) arr.push(event.chunkIndex);
        chunkCursor[event.memoId] = arr;
        try {
          var snapshot = priorLedger ? { ...priorLedger, chunk_cursor: chunkCursor } : { chunk_cursor: chunkCursor };
          await saveCheckpoint(db, runId, "claims_ledger", snapshot, "partial");
        } catch { /* non-fatal */ }
      };

      var timeBudget = Math.min(120000, Math.max(0, budgetRemaining() - 15000));
      claimsLedger = await runClaimsExtraction(
        ctx, dealId, startTime, timeBudget * 0.6,
        { priorLedger: priorLedger, chunkCursor: chunkCursor, onChunkComplete: onChunkComplete },
      );
      claimsLedger.chunk_cursor = chunkCursor;

      var cpStatus = claimsLedger.complete ? "complete" : "partial";
      await saveCheckpoint(db, runId, "claims_ledger", claimsLedger, cpStatus);

      if (claimsLedger.complete) {
        stagesComplete.push("claims_extraction");
        console.log("[CC-ORCH] claims_extraction complete: " + claimsLedger.claims.length + " claims");
      } else {
        console.log("[CC-ORCH] claims_extraction partial: " + (claimsLedger.extraction_metadata?.pending || "?") + " memos pending");
        return {
          status: "in_progress",
          runId: runId,
          currentStage: "claims_extraction",
          stagesComplete: stagesComplete,
          stagesFailed: stagesFailed,
          message: "Claims extraction in progress. " + claimsLedger.claims.length + " claims extracted so far.",
        };
      }
    } catch (err: unknown) {
      var errMsg = err instanceof Error ? err.message : String(err);
      if (isTransientError(errMsg)) {
        console.log("[CC-ORCH] claims_extraction transient error: " + errMsg.slice(0, 200));
        return {
          status: "in_progress",
          runId: runId,
          currentStage: "claims_extraction",
          stagesComplete: stagesComplete,
          stagesFailed: stagesFailed,
          message: "Transient error in claims_extraction, will retry.",
        };
      }
      stagesFailed.push("claims_extraction");
      console.log("[CC-ORCH] claims_extraction FAILED: " + errMsg.slice(0, 200));
      return {
        status: "failed",
        runId: runId,
        currentStage: "claims_extraction",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Claims extraction failed: " + errMsg.slice(0, 200),
      };
    }
  }

  // ── Stage 2: Reconciliation ────────────────────────────────────
  var reconciliation: ReconciliationResult | null = null;

  var reconCp = await loadCheckpoint(db, runId, "reconciliation");
  if (reconCp && reconCp.status === "complete" && reconCp.payload) {
    reconciliation = reconCp.payload as ReconciliationResult;
    stagesComplete.push("reconciliation");
    console.log("[CC-ORCH] reconciliation already complete: " + reconciliation.findings.length + " findings");
  } else {
    if (budgetRemaining() < STAGE_SAFETY_MARGIN_MS) {
      return {
        status: "in_progress",
        runId: runId,
        currentStage: "reconciliation",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Budget exhausted before reconciliation.",
      };
    }

    if (!claimsLedger || claimsLedger.claims.length === 0) {
      console.log("[CC-ORCH] No claims to reconcile — skipping reconciliation");
      stagesComplete.push("reconciliation");
    } else if (!numericReport) {
      console.log("[CC-ORCH] No numeric report provided — skipping reconciliation");
      stagesComplete.push("reconciliation");
    } else {
      console.log("[CC-ORCH] Entering reconciliation (" + budgetRemaining() + "ms remaining)");
      try {
        var reconTimeBudget = Math.min(90000, Math.max(0, budgetRemaining() - 15000));
        var pipelineResult = await runReconciliationPipeline({
          ctx: ctx,
          dealId: dealId,
          ledger: claimsLedger,
          baseFigures: numericReport.figures || [],
          discrepancies: numericReport.discrepancies || [],
          queryFn: function(sql: string, schema: any, params: any[], meta: any) {
            return ctx.integrations.db.query(sql, schema, params, meta);
          },
          timeBudgetMs: reconTimeBudget,
          startTime: startTime,
        });

        reconciliation = pipelineResult.reconciliation;
        // Replace findings with verified set (post all gates)
        (reconciliation as any).findings = pipelineResult.verifiedFindings;

        var reconPayload = {
          ...reconciliation,
          _p21_metadata: {
            bridgeFiguresCount: pipelineResult.bridgeFiguresCount,
            metricDerivation: pipelineResult.metricDerivation,
            magnitudeHeld: pipelineResult.magnitudeHeld,
            parallelOffsetHeld: pipelineResult.parallelOffsetHeld,
            gateVerified: pipelineResult.gateResult.verified.length,
            gateRejected: pipelineResult.gateResult.rejected.length,
            elapsedMs: pipelineResult.elapsedMs,
          },
        };
        await saveCheckpoint(db, runId, "reconciliation", reconPayload, "complete");
        stagesComplete.push("reconciliation");
        console.log("[CC-ORCH] reconciliation complete: " + pipelineResult.verifiedFindings.length + " verified findings");
      } catch (err: unknown) {
        var errMsg2 = err instanceof Error ? err.message : String(err);
        if (isTransientError(errMsg2)) {
          console.log("[CC-ORCH] reconciliation transient error: " + errMsg2.slice(0, 200));
          return {
            status: "in_progress",
            runId: runId,
            currentStage: "reconciliation",
            stagesComplete: stagesComplete,
            stagesFailed: stagesFailed,
            message: "Transient error in reconciliation, will retry.",
          };
        }
        stagesFailed.push("reconciliation");
        console.log("[CC-ORCH] reconciliation FAILED: " + errMsg2.slice(0, 200));
        return {
          status: "failed",
          runId: runId,
          currentStage: "reconciliation",
          stagesComplete: stagesComplete,
          stagesFailed: stagesFailed,
          message: "Reconciliation failed: " + errMsg2.slice(0, 200),
        };
      }
    }
  }

  // ── Stage 3: Finalization (post-merge + canonical finalize) ────
  if (budgetRemaining() < STAGE_SAFETY_MARGIN_MS) {
    return {
      status: "in_progress",
      runId: runId,
      currentStage: "finalization",
      stagesComplete: stagesComplete,
      stagesFailed: stagesFailed,
      message: "Budget exhausted before finalization.",
    };
  }

  console.log("[CC-ORCH] Entering finalization (" + budgetRemaining() + "ms remaining)");
  try {
    // Build fileTagMap from documents
    var docs = await db.query(
      "SELECT id, document_tag FROM documents WHERE deal_id = $1",
      z.object({ id: z.string(), document_tag: z.string() }),
      [dealId],
      { label: "CC-ORCH: load doc tags for finalization" },
    );
    var fileTagMap: Map<string, string> = new Map();
    for (var di = 0; di < docs.length; di++) {
      fileTagMap.set(docs[di].id, docs[di].document_tag);
    }

    // Resolve subjectDocumentIds if empty (same as pipeline-core)
    var subjectIds = subjectDocumentIds;
    if (!subjectIds || subjectIds.length === 0) {
      var icMemoRows = await db.query(
        "SELECT id FROM documents WHERE deal_id = $1 AND document_tag = 'ic_memo'",
        z.object({ id: z.string() }),
        [dealId],
        { label: "CC-ORCH: resolve subject ids from ic_memo docs" },
      );
      subjectIds = icMemoRows.map(function(r: { id: string }) { return r.id; });
    }

    var finalizationResult = await runPostMergeFinalizationStages({
      ctx: ctx,
      runId: runId,
      dealId: dealId,
      moduleId: "contradiction_check",
      naturalRootTreeLevel: 0,
      naturalRootNodeIndex: 0,
      canonicalRootFindings: [],
      executiveHeader: "",
      housekeepingFindings: [],
      housekeepingValidated: true,
      startTime: startTime,
      timeRemaining: budgetRemaining,
      callerPath: "reconciliation_path",
      fileTagMap: fileTagMap,
      subjectDocumentIds: subjectIds,
      useOpus: false,
      sourceManifestHash: null,
      runPostMergePipeline: undefined as any,
      runAbsenceVerificationPhase: undefined as any,
    });

    if (finalizationResult.status === "complete") {
      stagesComplete.push("finalization");
      console.log("[CC-ORCH] finalization complete");
    } else if (finalizationResult.status === "in_progress") {
      console.log("[CC-ORCH] finalization in_progress — will resume on next invocation");
      return {
        status: "in_progress",
        runId: runId,
        currentStage: "finalization",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Finalization in progress. " + stagesComplete.length + " stages complete.",
      };
    } else {
      stagesFailed.push("finalization");
      var blockReasons = finalizationResult.blockingReasons || [];
      console.log("[CC-ORCH] finalization " + finalizationResult.status + ": " + blockReasons.join("; "));
      return {
        status: "failed",
        runId: runId,
        currentStage: "finalization",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Finalization " + finalizationResult.status + ": " + blockReasons.join("; "),
      };
    }
  } catch (err: unknown) {
    var errMsg3 = err instanceof Error ? err.message : String(err);
    if (isTransientError(errMsg3)) {
      console.log("[CC-ORCH] finalization transient error: " + errMsg3.slice(0, 200));
      return {
        status: "in_progress",
        runId: runId,
        currentStage: "finalization",
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Transient error in finalization, will retry.",
      };
    }
    stagesFailed.push("finalization");
    console.log("[CC-ORCH] finalization THREW: " + errMsg3.slice(0, 200));
    return {
      status: "failed",
      runId: runId,
      currentStage: "finalization",
      stagesComplete: stagesComplete,
      stagesFailed: stagesFailed,
      message: "Finalization error: " + errMsg3.slice(0, 200),
    };
  }

  // All stages complete
  return {
    status: "complete",
    runId: runId,
    currentStage: "finalization",
    stagesComplete: stagesComplete,
    stagesFailed: stagesFailed,
    message: stagesComplete.length + " stages complete. Total elapsed: " + elapsed() + "ms.",
  };
}
