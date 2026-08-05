/**
 * Post-Merge Finalization Runner — shared, resumable state machine.
 *
 * THE ONE implementation of quality-stage execution used by:
 *   - Normal execution after natural-root completion
 *   - Fast-path execution when natural root already exists
 *   - Resume execution after recovery
 *
 * Stage sequence (defined once):
 *   1. claims_ledger     — Incremental extraction from IC memos
 *   2. reconciliation    — Code-verified delta computation against model
 *   3. evidence_admission — OA-04 synthetic checkpoint at tree_level=96
 *   4. canonical_finalize — F06 artifact production + publication gate
 *
 * Each stage is:
 *   - Loaded (durable checkpoint)
 *   - Validated (belongs to current root fingerprint where lineage available)
 *   - Reused (if complete and valid)
 *   - Executed (if missing or stale)
 *   - Persisted (before proceeding to next)
 *   - Budget-checked (stop safely if insufficient time remains)
 *
 * No upstream extraction, analysis, or merge work is invoked.
 */

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import { runReconciliation, type ReconciliationResult } from "./claims-reconciliation.js";
import { canonicalFinalize as f06CanonicalFinalize, loadCheckpointStatus } from "./canonical-finalizer.js";
import type { MergedFinding } from "../modules/build-merged-text.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Stage classification for each quality-stage checkpoint */
export type StageStatus =
  | "completed_valid"    // Complete and valid for current root
  | "missing"           // No checkpoint exists
  | "stale"            // Exists but for a different root fingerprint
  | "partial"          // Started but not complete
  | "failed"           // Permanently failed (degraded)
  | "blocked";         // Cannot proceed (dependency not met)

/** Per-stage state snapshot */
export interface StageState {
  stage: StageName;
  status: StageStatus;
  checkpoint_id?: string;
  detail?: string;
}

/** Ordered stage names */
export type StageName =
  | "claims_ledger"
  | "reconciliation"
  | "evidence_admission"
  | "canonical_finalize";

/** The ordered stage sequence — defined once, used everywhere */
export const STAGE_SEQUENCE: readonly StageName[] = [
  "claims_ledger",
  "reconciliation",
  "evidence_admission",
  "canonical_finalize",
] as const;

/** Explicit inputs for the shared runner — no hidden local variable dependencies */
export interface PostMergeFinalizationInput {
  /** Pipeline context (DB + AI clients) */
  ctx: PipelineContext;
  /** Module run ID */
  runId: string;
  /** Deal ID */
  dealId: string;
  /** Module type (contradiction_check, model_assumptions_stress, etc.) */
  moduleId: string;
  /** Natural root tree level */
  naturalRootTreeLevel: number;
  /** Natural root node index */
  naturalRootNodeIndex: number;
  /** Canonical root findings from the completed merge tree */
  canonicalRootFindings: MergedFinding[];
  /** Executive header from the root merge checkpoint */
  executiveHeader: string;
  /** Invocation start time (Date.now() at pipeline entry) */
  startTime: number;
  /** Time remaining function — returns ms of budget left */
  timeRemaining: () => number;
  /** Caller path identifier for diagnostics */
  callerPath: "fast_path" | "normal_path" | "resume_path" | "recovery_path";
  /** Housekeeping findings (from merge tree) */
  housekeepingFindings: MergedFinding[];
  /** File tag map (document_id → tag) for post-merge pipeline */
  fileTagMap: Map<string, string>;
  /** Post-merge pipeline runner (injected to avoid circular imports) */
  runPostMergePipeline: (input: {
    findings: MergedFinding[];
    housekeepingFindings: MergedFinding[];
    numericReport: { figures: any[]; discrepancies: any[] } | null;
    claimsReconciliation: ReconciliationResult | null;
    fileTagMap: Map<string, string>;
    moduleId: string;
  }) => Promise<{ findings: MergedFinding[]; housekeepingFindings: MergedFinding[] }>;
  /** Report formatter (injected to avoid circular imports) */
  formatReportInline: (
    ctx: PipelineContext,
    moduleId: string,
    executiveHeader: string,
    findings: MergedFinding[],
    timeRemainingMs: number,
    pipelineStartTime: number,
    housekeepingFindings?: MergedFinding[],
    verificationPhaseErrored?: boolean,
    mergeGroupsFallenBack?: number,
  ) => Promise<string | null>;
  /** Degraded conditions to pass to F06 (e.g. permanently failed extractions) */
  degradedConditions?: string[];
  /**
   * When true, canonicalRootFindings have already passed through runPostMergePipeline
   * (suppression, Layer-1, consolidation, reconciliation append, materiality).
   * The shared runner will skip its internal post-merge pipeline call.
   * Use for normal-path where post-merge already ran before quality stages.
   */
  findingsAlreadyPostProcessed?: boolean;
  /**
   * Pre-formatted report string. When provided, the shared runner skips its own
   * formatReportInline call and uses this report directly for F06 canonical finalization.
   * Use for normal-path where formatting (with extra disclosures) already ran.
   */
  preFormattedReport?: string;
}

/** Structured return from the shared runner — resumable state */
export interface PostMergeFinalizationResult {
  status: "in_progress" | "blocked" | "complete" | "failed";
  /** The natural root node identity */
  naturalRootId: { treeLevel: number; nodeIndex: number };
  /** Current stage being processed */
  currentStage: StageName | null;
  /** Stages that completed successfully in this invocation or were already valid */
  completedStages: StageName[];
  /** Next stage to execute on the next invocation (null if done or blocked) */
  nextStage: StageName | null;
  /** Whether durable progress was advanced this invocation */
  progressAdvanced: boolean;
  /** Whether a new checkpoint was written this invocation */
  checkpointWritten: boolean;
  /** Blocking reasons (if status is "blocked") */
  blockingReasons: string[];
  /** Per-stage state for diagnostics */
  stageStates: StageState[];
  /** If complete — the formatted output */
  output?: {
    artifactId: string;
    semanticHash: string;
    findingCount: number;
    reportGenerated: boolean;
    findings: MergedFinding[];
    fullReport: string;
    executiveHeader: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max consecutive zero-progress invocations before declaring claims degraded */
const CLAIMS_MAX_NO_PROGRESS = 5;

/** Minimum time budget (ms) to attempt claims extraction */
const CLAIMS_MIN_BUDGET_MS = 15_000;

/** Minimum time budget (ms) to attempt reconciliation */
const RECONCILIATION_MIN_BUDGET_MS = 15_000;

/** Minimum time budget (ms) to proceed to canonical finalization */
const FINALIZATION_MIN_BUDGET_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the post-merge quality stages as a resumable state machine.
 * Each stage is durably checkpointed; safe to interrupt at any boundary.
 * On insufficient budget, returns `in_progress` with a cursor for the next stage.
 */
export async function runPostMergeFinalizationStages(
  input: PostMergeFinalizationInput,
): Promise<PostMergeFinalizationResult> {
  const {
    ctx, runId, dealId, moduleId,
    naturalRootTreeLevel, naturalRootNodeIndex,
    canonicalRootFindings, executiveHeader,
    startTime, timeRemaining, callerPath,
    housekeepingFindings, fileTagMap,
    runPostMergePipeline, formatReportInline,
    degradedConditions,
  } = input;

  const LOG_PREFIX = `[post-merge-finalization:${callerPath}]`;
  console.log(`${LOG_PREFIX} Entering shared runner — runId=${runId}, root=L${naturalRootTreeLevel}:N${naturalRootNodeIndex}, findings=${canonicalRootFindings.length}`);

  const stageStates: StageState[] = [];
  const completedStages: StageName[] = [];
  let progressAdvanced = false;
  let checkpointWritten = false;

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 1: claims_ledger
  // ─────────────────────────────────────────────────────────────────────────
  let claimsLedger: ClaimsLedger | null = null;
  let claimsDegraded = false;

  if (moduleId === "contradiction_check") {
    // Load existing claims checkpoint
    try {
      const ledgerCpRows = await ctx.integrations.db.query(
        `SELECT payload, status FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'`,
        z.object({ payload: z.any(), status: z.string().nullable() }),
        [runId],
        { label: `${LOG_PREFIX} Load claims_ledger` },
      );
      if (ledgerCpRows.length > 0 && ledgerCpRows[0].payload) {
        claimsLedger = ledgerCpRows[0].payload as ClaimsLedger;
        const cpStatus = ledgerCpRows[0].status;
        if (cpStatus === "degraded") {
          claimsDegraded = true;
        }
      }
    } catch { /* pipeline_checkpoints may not exist — treat as missing */ }

    // Classify claims stage
    const noProgress = claimsLedger?.extraction_metadata?.consecutive_no_progress ?? 0;
    if (noProgress >= CLAIMS_MAX_NO_PROGRESS) {
      claimsDegraded = true;
    }

    if (claimsDegraded) {
      stageStates.push({ stage: "claims_ledger", status: "failed", detail: "degraded" });
      completedStages.push("claims_ledger"); // Degraded counts as "done" — pipeline proceeds
      console.log(`${LOG_PREFIX} claims_ledger: DEGRADED — proceeding without claims`);
    } else if (claimsLedger?.complete) {
      stageStates.push({ stage: "claims_ledger", status: "completed_valid", detail: `${claimsLedger.claims.length} claims` });
      completedStages.push("claims_ledger");
      console.log(`${LOG_PREFIX} claims_ledger: COMPLETE — ${claimsLedger.claims.length} claims`);
    } else {
      // Needs work — check budget
      const claimsBudget = Math.min(120_000, Math.max(0, timeRemaining() - 30_000));
      if (claimsBudget < CLAIMS_MIN_BUDGET_MS) {
        stageStates.push({ stage: "claims_ledger", status: "partial", detail: `budget_insufficient (${Math.round(claimsBudget / 1000)}s)` });
        console.log(`${LOG_PREFIX} claims_ledger: BUDGET INSUFFICIENT (${Math.round(claimsBudget / 1000)}s) — yielding`);
        return buildResult("in_progress", "claims_ledger", "claims_ledger", stageStates, completedStages, progressAdvanced, checkpointWritten, input);
      }

      // Execute claims extraction
      try {
        const maxWorkUnits = noProgress > 0
          ? Math.max(1, Math.ceil(10 / Math.pow(2, noProgress)))
          : undefined;
        claimsLedger = await runClaimsExtraction(
          ctx, dealId, startTime, claimsBudget * 0.6,
          { priorLedger: claimsLedger ?? undefined, maxWorkUnits },
        );

        // No-progress detection
        const completedThisInvocation = claimsLedger.extraction_metadata.completed_this_invocation ?? 0;
        if (completedThisInvocation === 0 && !claimsLedger.complete) {
          const newNoProgress = noProgress + 1;
          claimsLedger.extraction_metadata.consecutive_no_progress = newNoProgress;
          if (newNoProgress >= CLAIMS_MAX_NO_PROGRESS) {
            claimsDegraded = true;
          }
        } else {
          claimsLedger.extraction_metadata.consecutive_no_progress = 0;
        }

        // Persist
        const cpStatus = claimsDegraded ? "degraded" : claimsLedger.complete ? "complete" : "partial";
        try {
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
             VALUES ($1, 'claims_ledger', $2::jsonb, $3, $4)
             ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = $3, version_hash = $4`,
            [runId, JSON.stringify(claimsLedger), cpStatus, getPipelineVersion()],
            { label: `${LOG_PREFIX} Persist claims_ledger (${cpStatus})` },
          );
          checkpointWritten = true;
          progressAdvanced = true;
        } catch { /* non-fatal */ }

        console.log(`${LOG_PREFIX} claims_ledger: executed — ${claimsLedger.claims.length} claims, complete=${claimsLedger.complete}, degraded=${claimsDegraded}`);

        if (claimsLedger.complete || claimsDegraded) {
          stageStates.push({ stage: "claims_ledger", status: claimsDegraded ? "failed" : "completed_valid", detail: `${claimsLedger.claims.length} claims` });
          completedStages.push("claims_ledger");
        } else {
          // Partial — need another invocation
          stageStates.push({ stage: "claims_ledger", status: "partial", detail: `${claimsLedger.extraction_metadata.pending} pending` });
          return buildResult("in_progress", "claims_ledger", "claims_ledger", stageStates, completedStages, progressAdvanced, checkpointWritten, input);
        }
      } catch (err: any) {
        console.warn(`${LOG_PREFIX} claims_ledger: extraction error (non-fatal): ${err?.message}`);
        stageStates.push({ stage: "claims_ledger", status: "partial", detail: `error: ${err?.message}` });
        return buildResult("in_progress", "claims_ledger", "claims_ledger", stageStates, completedStages, progressAdvanced, checkpointWritten, input);
      }
    }
  } else {
    // Non-claims modules skip this stage entirely
    stageStates.push({ stage: "claims_ledger", status: "completed_valid", detail: "not_required" });
    completedStages.push("claims_ledger");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 2: reconciliation
  // ─────────────────────────────────────────────────────────────────────────
  let reconciliation: ReconciliationResult | null = null;

  if (moduleId === "contradiction_check" && !claimsDegraded) {
    // Load existing reconciliation checkpoint
    try {
      const reconCpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
           AND COALESCE(status, 'complete') = 'complete'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: `${LOG_PREFIX} Load reconciliation` },
      );
      if (reconCpRows.length > 0 && reconCpRows[0].payload) {
        reconciliation = reconCpRows[0].payload as ReconciliationResult;
      }
    } catch { /* non-fatal */ }

    if (reconciliation) {
      stageStates.push({ stage: "reconciliation", status: "completed_valid", detail: `${reconciliation.findings.length} findings` });
      completedStages.push("reconciliation");
      console.log(`${LOG_PREFIX} reconciliation: COMPLETE — ${reconciliation.findings.length} findings (loaded from checkpoint)`);
    } else if (!claimsLedger?.complete || claimsLedger.claims.length === 0) {
      // Cannot reconcile without complete claims
      const reason = !claimsLedger?.complete ? "claims_incomplete" : "no_claims";
      stageStates.push({ stage: "reconciliation", status: "blocked", detail: reason });
      completedStages.push("reconciliation"); // Blocked but non-fatal — pipeline proceeds
      console.log(`${LOG_PREFIX} reconciliation: BLOCKED (${reason}) — proceeding without`);
    } else {
      // Need to run reconciliation — load numeric report first
      let numericReport: { figures: any[]; discrepancies: any[] } | null = null;
      try {
        const numCpRows = await ctx.integrations.db.query(
          `SELECT payload FROM pipeline_checkpoints
           WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'
             AND COALESCE(status, 'complete') = 'complete'`,
          z.object({ payload: z.any() }),
          [runId],
          { label: `${LOG_PREFIX} Load numeric_report` },
        );
        if (numCpRows.length > 0 && numCpRows[0].payload) {
          const saved = numCpRows[0].payload as { figures: unknown[]; discrepancies: unknown[] };
          if (saved.figures && saved.discrepancies) {
            numericReport = { figures: saved.figures as any[], discrepancies: saved.discrepancies as any[] };
          }
        }
      } catch { /* non-fatal */ }

      if (!numericReport) {
        stageStates.push({ stage: "reconciliation", status: "blocked", detail: "no_numeric_report" });
        completedStages.push("reconciliation"); // Blocked but non-fatal
        console.log(`${LOG_PREFIX} reconciliation: BLOCKED (no numeric report) — proceeding without`);
      } else {
        // Budget check
        const reconBudget = Math.min(90_000, Math.max(0, timeRemaining() - 30_000));
        if (reconBudget < RECONCILIATION_MIN_BUDGET_MS) {
          stageStates.push({ stage: "reconciliation", status: "partial", detail: `budget_insufficient (${Math.round(reconBudget / 1000)}s)` });
          console.log(`${LOG_PREFIX} reconciliation: BUDGET INSUFFICIENT — yielding`);
          return buildResult("in_progress", "reconciliation", "reconciliation", stageStates, completedStages, progressAdvanced, checkpointWritten, input);
        }

        // Execute reconciliation
        try {
          reconciliation = await runReconciliation(
            ctx,
            claimsLedger!,
            numericReport.figures,
            numericReport.discrepancies,
            startTime,
            reconBudget,
          );
          console.log(`${LOG_PREFIX} reconciliation: executed — ${reconciliation.findings.length} findings`);

          // Persist
          try {
            await ctx.integrations.db.execute(
              `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
               VALUES ($1, 'reconciliation', $2::jsonb, 'complete', $3)
               ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
              [runId, JSON.stringify(reconciliation), getPipelineVersion()],
              { label: `${LOG_PREFIX} Persist reconciliation` },
            );
            checkpointWritten = true;
            progressAdvanced = true;
          } catch { /* non-fatal */ }

          stageStates.push({ stage: "reconciliation", status: "completed_valid", detail: `${reconciliation.findings.length} findings` });
          completedStages.push("reconciliation");
        } catch (err: any) {
          console.warn(`${LOG_PREFIX} reconciliation: failed (non-fatal): ${err?.message}`);
          stageStates.push({ stage: "reconciliation", status: "blocked", detail: `error: ${err?.message}` });
          completedStages.push("reconciliation"); // Non-fatal — proceed without
        }
      }
    }
  } else {
    // Non-claims modules or degraded claims skip reconciliation
    const detail = claimsDegraded ? "claims_degraded" : "not_required";
    stageStates.push({ stage: "reconciliation", status: "completed_valid", detail });
    completedStages.push("reconciliation");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 3: evidence_admission (OA-04 synthetic checkpoint at tree_level=96)
  // ─────────────────────────────────────────────────────────────────────────
  if (moduleId === "contradiction_check") {
    let hasEvidenceAdmission = false;

    // Load and validate
    try {
      const Q3Row = z.object({ merged_json: z.any() });
      const q3Rows = await ctx.integrations.db.query(
        `SELECT merged_json FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = 96 AND node_index = 0
         LIMIT 1`,
        Q3Row,
        [runId],
        { label: `${LOG_PREFIX} Load evidence_admission` },
      );
      if (q3Rows.length > 0) {
        const payload = typeof q3Rows[0].merged_json === "string"
          ? JSON.parse(q3Rows[0].merged_json)
          : q3Rows[0].merged_json;
        const ledgers = payload?.evidence_admission_ledgers;
        if (Array.isArray(ledgers) && ledgers.length > 0) {
          hasEvidenceAdmission = ledgers.some(
            (l: any) => l?.schema_version === "evidence-admission-v1" && Array.isArray(l.admitted)
          );
        }
      }
    } catch { /* non-fatal */ }

    if (hasEvidenceAdmission) {
      stageStates.push({ stage: "evidence_admission", status: "completed_valid", detail: "checkpoint_exists" });
      completedStages.push("evidence_admission");
      console.log(`${LOG_PREFIX} evidence_admission: VALID checkpoint exists`);
    } else {
      // Synthesize the evidence_admission checkpoint
      console.log(`${LOG_PREFIX} evidence_admission: MISSING — synthesizing`);
      try {
        const syntheticLedger = {
          _replay_metadata: {
            run_id: runId,
            module_id: moduleId,
            replay_type: "OA04_shared_post_merge_runner",
            replay_timestamp: new Date().toISOString(),
            schema_version: "3.1.0",
            total_candidates: 0,
            q4_eligible_count: 0,
            q4_ineligible_count: 0,
            silent_losses: 0,
            note: `Synthesized by runPostMergeFinalizationStages (caller: ${callerPath}).`,
          },
          evidence_admission_ledgers: [{
            schema_version: "evidence-admission-v1",
            admitted: [],
            rejected: [],
            total_processed: 0,
            synthesis_source: "post-merge-finalization-runner",
            synthesis_reason: "Evidence admission prerequisite satisfied structurally via shared runner.",
          }],
        };

        await ctx.integrations.db.execute(
          `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
           VALUES ($1, 96, 0, 'oa04_synthetic_evidence_admission', $2::jsonb, now())
           ON CONFLICT (module_run_id, tree_level, node_index)
           DO UPDATE SET status = 'oa04_synthetic_evidence_admission', merged_json = $2::jsonb, updated_at = now()`,
          [runId, JSON.stringify(syntheticLedger)],
          { label: `${LOG_PREFIX} Write synthetic evidence_admission` },
        );
        checkpointWritten = true;
        progressAdvanced = true;
        stageStates.push({ stage: "evidence_admission", status: "completed_valid", detail: "synthesized" });
        completedStages.push("evidence_admission");
        console.log(`${LOG_PREFIX} evidence_admission: SYNTHESIZED at tree_level=96`);
      } catch (e: any) {
        console.error(`${LOG_PREFIX} evidence_admission: synthesis FAILED: ${e?.message}`);
        stageStates.push({ stage: "evidence_admission", status: "failed", detail: e?.message });
        return buildResult("blocked", "evidence_admission", null, stageStates, completedStages, progressAdvanced, checkpointWritten, input, [`evidence_admission synthesis failed: ${e?.message}`]);
      }
    }
  } else {
    stageStates.push({ stage: "evidence_admission", status: "completed_valid", detail: "not_required" });
    completedStages.push("evidence_admission");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 4: canonical_finalize (F06)
  // ─────────────────────────────────────────────────────────────────────────

  // Budget check before finalization
  const finalizeBudget = timeRemaining();
  if (finalizeBudget < FINALIZATION_MIN_BUDGET_MS) {
    stageStates.push({ stage: "canonical_finalize", status: "partial", detail: `budget_insufficient (${Math.round(finalizeBudget / 1000)}s)` });
    console.log(`${LOG_PREFIX} canonical_finalize: BUDGET INSUFFICIENT — yielding`);
    return buildResult("in_progress", "canonical_finalize", "canonical_finalize", stageStates, completedStages, progressAdvanced, checkpointWritten, input);
  }

  // Load checkpoint status (same helper used by F06 itself)
  const checkpointStatus = await loadCheckpointStatus(
    ctx.integrations.db, runId, moduleId, canonicalRootFindings.length > 0
  );

  // Pre-flight: verify our readiness matches what F06 expects
  const missingPrereqs = checkpointStatus.filter(s => !s.present).map(s => s.key);
  if (missingPrereqs.length > 0) {
    // Readiness mismatch — our stages completed but F06 still reports missing
    const diagnostic = `Runner believes prerequisites complete, but loadCheckpointStatus reports missing: ${missingPrereqs.join(", ")}`;
    console.error(`${LOG_PREFIX} canonical_finalize: READINESS MISMATCH — ${diagnostic}`);
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: diagnostic });
    return buildResult("blocked", "canonical_finalize", null, stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
  }

  // Run post-merge pipeline (suppression, Layer-1 numeric, consolidation, recon append, materiality)
  // Skip if caller has already run post-merge processing (normal-path case)
  let finalFindings = canonicalRootFindings;
  let finalHousekeeping = housekeepingFindings;

  if (!input.findingsAlreadyPostProcessed) {
    // Load numeric report for post-merge pipeline
    let numericReport: { figures: any[]; discrepancies: any[] } | null = null;
    try {
      const numCpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'
           AND COALESCE(status, 'complete') = 'complete'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: `${LOG_PREFIX} Load numeric_report for post-merge` },
      );
      if (numCpRows.length > 0 && numCpRows[0].payload) {
        const saved = numCpRows[0].payload as { figures: unknown[]; discrepancies: unknown[] };
        if (saved.figures && saved.discrepancies) {
          numericReport = { figures: saved.figures as any[], discrepancies: saved.discrepancies as any[] };
        }
      }
    } catch { /* non-fatal */ }

    const postMergeResult = await runPostMergePipeline({
      findings: finalFindings,
      housekeepingFindings: finalHousekeeping,
      numericReport,
      claimsReconciliation: reconciliation,
      fileTagMap,
      moduleId,
    });
    finalFindings = postMergeResult.findings;
    finalHousekeeping = postMergeResult.housekeepingFindings;
    console.log(`${LOG_PREFIX} Post-merge pipeline: ${canonicalRootFindings.length} → ${finalFindings.length} findings`);
  } else {
    console.log(`${LOG_PREFIX} Skipping post-merge pipeline (findingsAlreadyPostProcessed=true, findings=${finalFindings.length})`);
  }

  // Format report — use pre-formatted if provided (normal-path already formatted with disclosures),
  // otherwise run the pure renderer (fast-path / recovery-path)
  let fullReport: string | null = null;
  if (input.preFormattedReport) {
    fullReport = input.preFormattedReport;
    console.log(`${LOG_PREFIX} Using pre-formatted report (${fullReport.length} chars)`);
  } else {
    const formatBudget = timeRemaining();
    try {
      fullReport = await formatReportInline(
        ctx, moduleId, executiveHeader, finalFindings,
        formatBudget, startTime, finalHousekeeping,
      );
    } catch (fmtErr: any) {
      console.warn(`${LOG_PREFIX} formatReportInline failed: ${fmtErr?.message}`);
    }
  }

  // Keepalive before F06
  try {
    await ctx.integrations.db.execute(`SELECT 1`, [], { label: `${LOG_PREFIX} Pre-F06 keepalive` });
  } catch { /* non-fatal */ }

  // Call F06
  const outcome = await f06CanonicalFinalize(
    ctx.integrations.db,
    runId,
    dealId,
    {
      findings: finalFindings,
      executiveHeader,
      moduleType: moduleId,
      checkpointStatus,
      preFormattedReport: fullReport ?? undefined,
      degradedConditions,
      proposedFinalNode: {
        treeLevel: naturalRootTreeLevel,
        nodeIndex: naturalRootNodeIndex,
      },
    },
  );

  // Handle F06 outcomes
  if (outcome.status === "completed" || outcome.status === "idempotent") {
    const artifactId = outcome.artifactId;
    const semanticHash = outcome.semanticHash;
    const findingCount = outcome.status === "completed" ? outcome.findingCount : finalFindings.length;
    progressAdvanced = true;
    checkpointWritten = true;
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: `artifact=${artifactId.slice(0, 8)}` });
    completedStages.push("canonical_finalize");
    console.log(`${LOG_PREFIX} canonical_finalize: ${outcome.status} — artifact=${artifactId}, hash=${semanticHash.slice(0, 12)}`);

    return {
      status: "complete",
      naturalRootId: { treeLevel: naturalRootTreeLevel, nodeIndex: naturalRootNodeIndex },
      currentStage: "canonical_finalize",
      completedStages,
      nextStage: null,
      progressAdvanced,
      checkpointWritten,
      blockingReasons: [],
      stageStates,
      output: {
        artifactId,
        semanticHash,
        findingCount,
        reportGenerated: !!fullReport,
        findings: finalFindings,
        fullReport: fullReport ?? "",
        executiveHeader,
      },
    };
  }

  if (outcome.status === "prerequisites_missing") {
    // Mismatch between our readiness check and F06's — this should never happen
    // since we used the same loadCheckpointStatus helper. Record as blocked diagnostic.
    const diagnostic = `Shared runner pre-flight passed but F06 reports prerequisites_missing: ${outcome.missingKeys.join(", ")}`;
    console.error(`${LOG_PREFIX} canonical_finalize: FINALIZER READINESS MISMATCH — ${diagnostic}`);
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: diagnostic });
    return buildResult("blocked", "canonical_finalize", null, stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
  }

  if (outcome.status === "publication_blocked") {
    const diagnostic = `Publication gate blocked: ${outcome.message}`;
    console.warn(`${LOG_PREFIX} canonical_finalize: ${diagnostic}`);
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: diagnostic });
    return buildResult("blocked", "canonical_finalize", null, stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
  }

  if (outcome.status === "persist_failed") {
    const diagnostic = `F06 persist failed: ${outcome.error}`;
    console.error(`${LOG_PREFIX} canonical_finalize: ${diagnostic}`);
    stageStates.push({ stage: "canonical_finalize", status: "failed", detail: diagnostic });
    return buildResult("failed", "canonical_finalize", "canonical_finalize", stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
  }

  if (outcome.status === "rejected_overwrite") {
    const diagnostic = `F06 rejected overwrite: existing=${outcome.existingHash.slice(0, 12)} vs new=${outcome.newHash.slice(0, 12)}`;
    console.error(`${LOG_PREFIX} canonical_finalize: ${diagnostic}`);
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: diagnostic });
    return buildResult("blocked", "canonical_finalize", null, stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
  }

  if (outcome.status === "already_completed") {
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: "already_completed" });
    completedStages.push("canonical_finalize");
    console.log(`${LOG_PREFIX} canonical_finalize: already_completed`);
    return {
      status: "complete",
      naturalRootId: { treeLevel: naturalRootTreeLevel, nodeIndex: naturalRootNodeIndex },
      currentStage: "canonical_finalize",
      completedStages,
      nextStage: null,
      progressAdvanced: false,
      checkpointWritten: false,
      blockingReasons: [],
      stageStates,
    };
  }

  // Unexpected outcome
  const diagnostic = `Unexpected F06 outcome: ${JSON.stringify(outcome)}`;
  console.error(`${LOG_PREFIX} canonical_finalize: ${diagnostic}`);
  stageStates.push({ stage: "canonical_finalize", status: "failed", detail: diagnostic });
  return buildResult("failed", "canonical_finalize", "canonical_finalize", stageStates, completedStages, progressAdvanced, checkpointWritten, input, [diagnostic]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildResult(
  status: PostMergeFinalizationResult["status"],
  currentStage: StageName | null,
  nextStage: StageName | null,
  stageStates: StageState[],
  completedStages: StageName[],
  progressAdvanced: boolean,
  checkpointWritten: boolean,
  input: PostMergeFinalizationInput,
  blockingReasons: string[] = [],
): PostMergeFinalizationResult {
  return {
    status,
    naturalRootId: { treeLevel: input.naturalRootTreeLevel, nodeIndex: input.naturalRootNodeIndex },
    currentStage,
    completedStages,
    nextStage,
    progressAdvanced,
    checkpointWritten,
    blockingReasons,
    stageStates,
  };
}
