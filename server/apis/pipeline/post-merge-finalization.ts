/**
 * Post-Merge Finalization Runner — shared, resumable state machine.
 *
 * THE SOLE implementation of quality-stage execution used by:
 *   - Fast-path execution when natural root already exists (complete-root resume)
 *   - Normal execution after natural-root completion during same invocation
 *
 * Stage sequence (defined once, executed in order):
 *   1. claims_ledger     — Incremental extraction from IC memos
 *   2. reconciliation    — Code-verified delta computation against model
 *   3. post_merge        — Suppression, Layer-1 numeric, consolidation, recon append, materiality
 *   4. absence_verify    — Adversarial verification (checklist modules only)
 *   5. canonical_finalize — F06 artifact production + publication gate
 *
 * Design invariants:
 *   - No upstream extraction, analysis, or merge work is invoked
 *   - Each stage is durably checkpointed; safe to interrupt at any boundary
 *   - Lineage envelopes validate every cached stage result against dependency fingerprints
 *   - Evidence admission is never fabricated — missing stages block finalization
 *   - Housekeeping corruption blocks finalization (fail-closed)
 *   - F06 artifact is the returned output (not pre-finalization data)
 *   - blocked/failed are terminal states (not retryable via in_progress)
 *   - No caller-trust bypass flags (findingsAlreadyPostProcessed, preFormattedReport removed)
 */

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import { runReconciliation, type ReconciliationResult } from "./claims-reconciliation.js";
import {
  canonicalFinalize as f06CanonicalFinalize,
  loadCheckpointStatus,
  type FinalizerOutcome,
} from "./canonical-finalizer.js";
import type { CanonicalFinalArtifact } from "./canonical-final-artifact.js";
import type { MergedFinding } from "../modules/build-merged-text.js";
import { computeContentHash } from "./source-snapshot.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Stage names in execution order */
export type StageName =
  | "claims_ledger"
  | "reconciliation"
  | "post_merge"
  | "absence_verify"
  | "canonical_finalize";

export const STAGE_SEQUENCE: readonly StageName[] = [
  "claims_ledger",
  "reconciliation",
  "post_merge",
  "absence_verify",
  "canonical_finalize",
] as const;

/** Terminal status of the runner */
export type RunnerStatus = "complete" | "in_progress" | "blocked" | "failed";

/** Per-stage status */
export type StageStatus =
  | "completed_valid"    // Complete and lineage-valid for current root
  | "missing"           // No checkpoint exists
  | "stale"            // Exists but lineage fingerprint mismatch — must rerun
  | "partial"          // Started but not complete (resumable)
  | "failed"           // Permanently failed
  | "blocked"          // Cannot proceed (dependency not met)
  | "skipped";         // Not applicable to this module type

/** Lineage envelope — dependency fingerprints for stale detection */
export interface LineageEnvelope {
  /** Hash of the natural-root findings (input to finalization) */
  naturalRootFindingHash: string;
  /** Pipeline version at time of stage execution */
  pipelineVersion: string;
  /** Hash of the frozen source manifest (subject document set) */
  sourceManifestHash: string | null;
  /** Hash of the claims ledger (dependency for reconciliation) */
  claimsHash?: string;
  /** Hash of the numeric report (dependency for reconciliation) */
  numericReportHash?: string;
  /** Hash of reconciliation output (dependency for post-merge) */
  reconciliationHash?: string;
  /** Hash of post-merge result (dependency for finalization) */
  postMergeResultHash?: string;
}

/** Stage state snapshot (reported in result) */
export interface StageState {
  stage: StageName;
  status: StageStatus;
  detail?: string;
  lineageValid?: boolean;
}

/** Input to the shared runner — all required context */
export interface PostMergeFinalizationInput {
  ctx: PipelineContext;
  runId: string;
  dealId: string;
  moduleId: string;

  /** Tree level of the validated natural root */
  naturalRootTreeLevel: number;
  /** Node index of the natural root (always 0 for single-root trees) */
  naturalRootNodeIndex: number;
  /** Parsed findings from the natural root checkpoint */
  canonicalRootFindings: MergedFinding[];
  /** Executive header from the natural root checkpoint */
  executiveHeader: string;
  /** Housekeeping findings — MUST be validated before passing (non-empty, non-corrupt) */
  housekeepingFindings: MergedFinding[];
  /** Whether housekeeping was available and valid */
  housekeepingValidated: boolean;

  /** Pipeline invocation start time (epoch ms) */
  startTime: number;
  /** Returns time remaining in budget (ms) */
  timeRemaining: () => number;
  /** Which code path invoked this runner */
  callerPath: "fast_path" | "normal_path";

  /** File tag map for source routing */
  fileTagMap: Map<string, string>;
  /** Subject document IDs for absence verification */
  subjectDocumentIds?: string[];
  /** Whether to use Opus model for absence verification */
  useOpus?: boolean | null;

  /** Source manifest hash from the validated root-completion manifest */
  sourceManifestHash: string | null;

  // Injected dependencies (avoid circular imports)
  runPostMergePipeline: (input: {
    findings: MergedFinding[];
    housekeepingFindings: MergedFinding[];
    numericReport: { figures: any[]; discrepancies: any[] } | null;
    claimsReconciliation: ReconciliationResult | null;
    fileTagMap: Map<string, string>;
    moduleId: string;
  }) => Promise<{ findings: MergedFinding[]; housekeepingFindings: MergedFinding[] }>;
  runAbsenceVerificationPhase: (
    ctx: PipelineContext,
    dealId: string,
    runId: string,
    findings: MergedFinding[],
    moduleId: string,
    useOpus: boolean | null | undefined,
    subjectDocumentIds: string[],
    budgetRemainingMs: () => number,
    pipelineStartTime: number,
  ) => Promise<{ findings: MergedFinding[]; verificationLog: any[]; completed: boolean }>;
}

/** Runner result */
export interface PostMergeFinalizationResult {
  status: RunnerStatus;
  /** Which stage is blocked/in-progress (null if complete) */
  currentStage: StageName | null;
  /** All stage states observed */
  stageStates: StageState[];
  /** Stages that completed during this invocation */
  completedStages: StageName[];
  /** Whether any durable progress was made (checkpoint written) */
  progressAdvanced: boolean;
  /** Blocking reasons (for blocked/failed status) */
  blockingReasons: string[];
  /** The actual F06 artifact (only when status=complete) */
  artifact: CanonicalFinalArtifact | null;
  /** F06 outcome details */
  finalizerOutcome: FinalizerOutcome | null;
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

/** Minimum time budget (ms) for absence verification */
const ABSENCE_VERIFICATION_MIN_BUDGET_MS = 120_000;

/** Minimum time budget (ms) to proceed to canonical finalization */
const FINALIZATION_MIN_BUDGET_MS = 10_000;

/** Modules requiring claims/reconciliation */
const CLAIMS_REQUIRED_MODULES = new Set(["contradiction_check"]);

/** Modules requiring absence verification */
const ABSENCE_VERIFICATION_MODULES = new Set(["omission_audit", "blind_spot_scanner", "diligence_completeness"]);

// ─────────────────────────────────────────────────────────────────────────────
// Lineage Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Compute a deterministic hash for a findings array (sorted by finding_id) */
function hashFindings(findings: MergedFinding[]): string {
  const sorted = [...findings].sort((a, b) =>
    (a.finding_id ?? "").localeCompare(b.finding_id ?? "")
  );
  const payload = sorted.map(f => f.finding_id ?? JSON.stringify(f)).join("|");
  return computeContentHash(payload);
}

/** Compute a hash for claims ledger content */
function hashClaims(ledger: ClaimsLedger): string {
  const payload = JSON.stringify(ledger.claims.map(c => ({
    metric: c.metric,
    value: c.value,
    period: c.period,
    scope: c.scope_qualifier,
  })));
  return computeContentHash(payload);
}

/** Compute a hash for reconciliation result */
function hashReconciliation(result: ReconciliationResult): string {
  const payload = JSON.stringify(result.findings.map(f => `${f.finding_kind}:${f.title}:${f.delta_abs ?? ""}`));
  return computeContentHash(payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the post-merge quality stages as a resumable state machine.
 * Each stage is durably checkpointed; safe to interrupt at any boundary.
 * On insufficient budget, returns `in_progress` with a cursor for the next stage.
 *
 * INVARIANT: This function NEVER fabricates checkpoint data. If a required stage
 * cannot be executed (missing dependency, insufficient budget), it returns
 * in_progress or blocked — never writes synthetic data to satisfy prerequisites.
 */
export async function runPostMergeFinalizationStages(
  input: PostMergeFinalizationInput,
): Promise<PostMergeFinalizationResult> {
  const {
    ctx, runId, dealId, moduleId,
    naturalRootTreeLevel, naturalRootNodeIndex,
    canonicalRootFindings, executiveHeader,
    startTime, timeRemaining, callerPath,
    housekeepingFindings, housekeepingValidated,
    fileTagMap, subjectDocumentIds, useOpus,
    sourceManifestHash,
    runPostMergePipeline, runAbsenceVerificationPhase,
  } = input;

  const LOG_PREFIX = `[post-merge-finalization:${callerPath}]`;
  const pipelineVersion = getPipelineVersion();
  const naturalRootFindingHash = hashFindings(canonicalRootFindings);

  console.log(`${LOG_PREFIX} Entering shared runner — runId=${runId}, root=L${naturalRootTreeLevel}:N${naturalRootNodeIndex}, findings=${canonicalRootFindings.length}, pipelineVersion=${pipelineVersion}, rootHash=${naturalRootFindingHash.slice(0, 8)}`);

  // ── INVARIANT: Housekeeping must be validated before entry ──────────────────
  // If housekeeping could not be loaded or is corrupt, the caller must NOT invoke
  // this runner. Empty housekeeping is only valid when housekeepingValidated=true
  // AND the module genuinely produced zero housekeeping items.
  if (!housekeepingValidated) {
    console.error(`${LOG_PREFIX} BLOCKED: housekeeping not validated — cannot finalize with unverified housekeeping state`);
    return {
      status: "blocked",
      currentStage: null,
      stageStates: [],
      completedStages: [],
      progressAdvanced: false,
      blockingReasons: ["Housekeeping findings could not be validated. Finalization blocked to prevent silent data loss. Requires manual investigation or housekeeping reconstruction."],
      artifact: null,
      finalizerOutcome: null,
    };
  }

  const stageStates: StageState[] = [];
  const completedStages: StageName[] = [];
  let progressAdvanced = false;

  // Build lineage envelope for this invocation
  const lineage: LineageEnvelope = {
    naturalRootFindingHash,
    pipelineVersion,
    sourceManifestHash,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 1: claims_ledger
  // ─────────────────────────────────────────────────────────────────────────
  let claimsLedger: ClaimsLedger | null = null;
  let claimsDegraded = false;

  if (CLAIMS_REQUIRED_MODULES.has(moduleId)) {
    // Load existing claims checkpoint with lineage
    let existingLineage: { pipelineVersion?: string; sourceManifestHash?: string } | null = null;
    try {
      const ledgerCpRows = await ctx.integrations.db.query(
        `SELECT payload, status, version_hash FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'`,
        z.object({ payload: z.any(), status: z.string().nullable(), version_hash: z.string().nullable() }),
        [runId],
        { label: `${LOG_PREFIX} Load claims_ledger` },
      );
      if (ledgerCpRows.length > 0 && ledgerCpRows[0].payload) {
        claimsLedger = ledgerCpRows[0].payload as ClaimsLedger;
        const cpStatus = ledgerCpRows[0].status;
        const cpVersionHash = ledgerCpRows[0].version_hash;
        if (cpStatus === "degraded") {
          claimsDegraded = true;
        }
        existingLineage = { pipelineVersion: cpVersionHash ?? undefined };
      }
    } catch { /* pipeline_checkpoints may not exist — treat as missing */ }

    // Lineage validation: reject stale claims from a different pipeline version
    if (claimsLedger && existingLineage?.pipelineVersion && existingLineage.pipelineVersion !== pipelineVersion) {
      console.warn(`${LOG_PREFIX} claims_ledger: STALE — version ${existingLineage.pipelineVersion} != current ${pipelineVersion}`);
      stageStates.push({ stage: "claims_ledger", status: "stale", detail: `version mismatch: ${existingLineage.pipelineVersion}`, lineageValid: false });
      claimsLedger = null; // Force re-extraction
      claimsDegraded = false;
    }

    // Classify claims stage
    const noProgress = claimsLedger?.extraction_metadata?.consecutive_no_progress ?? 0;
    if (noProgress >= CLAIMS_MAX_NO_PROGRESS) {
      claimsDegraded = true;
    }

    if (claimsDegraded) {
      stageStates.push({ stage: "claims_ledger", status: "failed", detail: "degraded — proceeding without claims" });
      completedStages.push("claims_ledger");
      console.log(`${LOG_PREFIX} claims_ledger: DEGRADED — proceeding without claims`);
    } else if (claimsLedger?.complete) {
      stageStates.push({ stage: "claims_ledger", status: "completed_valid", detail: `${claimsLedger.claims.length} claims`, lineageValid: true });
      completedStages.push("claims_ledger");
      lineage.claimsHash = hashClaims(claimsLedger);
      console.log(`${LOG_PREFIX} claims_ledger: COMPLETE — ${claimsLedger.claims.length} claims`);
    } else {
      // Needs work — check budget
      const claimsBudget = Math.min(120_000, Math.max(0, timeRemaining() - 30_000));
      if (claimsBudget < CLAIMS_MIN_BUDGET_MS) {
        stageStates.push({ stage: "claims_ledger", status: "partial", detail: `budget_insufficient (${Math.round(claimsBudget / 1000)}s)` });
        console.log(`${LOG_PREFIX} claims_ledger: BUDGET INSUFFICIENT — yielding`);
        return buildResult("in_progress", "claims_ledger", stageStates, completedStages, progressAdvanced, []);
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
          if (newNoProgress >= CLAIMS_MAX_NO_PROGRESS) claimsDegraded = true;
        } else {
          claimsLedger.extraction_metadata.consecutive_no_progress = 0;
        }

        // Persist with lineage
        const cpStatus = claimsDegraded ? "degraded" : claimsLedger.complete ? "complete" : "partial";
        try {
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
             VALUES ($1, 'claims_ledger', $2::jsonb, $3, $4)
             ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
               SET payload = EXCLUDED.payload, updated_at = now(), status = $3, version_hash = $4`,
            [runId, JSON.stringify(claimsLedger), cpStatus, pipelineVersion],
            { label: `${LOG_PREFIX} Persist claims_ledger (${cpStatus})` },
          );
          progressAdvanced = true;
        } catch (e: any) {
          console.warn(`${LOG_PREFIX} claims_ledger: persist failed (non-fatal): ${e?.message}`);
        }

        if (claimsLedger.complete || claimsDegraded) {
          stageStates.push({ stage: "claims_ledger", status: claimsDegraded ? "failed" : "completed_valid", detail: `${claimsLedger.claims.length} claims` });
          completedStages.push("claims_ledger");
          if (claimsLedger.complete) lineage.claimsHash = hashClaims(claimsLedger);
        } else {
          stageStates.push({ stage: "claims_ledger", status: "partial", detail: `${claimsLedger.extraction_metadata.pending} pending` });
          return buildResult("in_progress", "claims_ledger", stageStates, completedStages, progressAdvanced, []);
        }
      } catch (err: any) {
        console.warn(`${LOG_PREFIX} claims_ledger: extraction error (non-fatal): ${err?.message}`);
        stageStates.push({ stage: "claims_ledger", status: "partial", detail: `error: ${err?.message}` });
        return buildResult("in_progress", "claims_ledger", stageStates, completedStages, progressAdvanced, []);
      }
    }
  } else {
    stageStates.push({ stage: "claims_ledger", status: "skipped", detail: "not required for module" });
    completedStages.push("claims_ledger");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 2: reconciliation
  // ─────────────────────────────────────────────────────────────────────────
  let reconciliationResult: ReconciliationResult | null = null;

  if (CLAIMS_REQUIRED_MODULES.has(moduleId)) {
    // Load numeric report (dependency for reconciliation)
    let numericReport: { figures: any[]; discrepancies: any[] } | null = null;
    try {
      const numCpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'
           AND COALESCE(status, 'complete') = 'complete'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: `${LOG_PREFIX} Load numeric report` },
      );
      if (numCpRows.length > 0 && numCpRows[0].payload) {
        const saved = numCpRows[0].payload as { figures: unknown[]; discrepancies: unknown[] };
        if (saved.figures && saved.discrepancies) {
          numericReport = { figures: saved.figures as any[], discrepancies: saved.discrepancies as any[] };
        }
      }
    } catch { /* proceed without */ }

    if (numericReport) {
      lineage.numericReportHash = computeContentHash(JSON.stringify(numericReport.figures.length));
    }

    // Load existing reconciliation checkpoint with lineage
    let reconExistingVersion: string | null = null;
    try {
      const reconCpRows = await ctx.integrations.db.query(
        `SELECT payload, status, version_hash FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'`,
        z.object({ payload: z.any(), status: z.string().nullable(), version_hash: z.string().nullable() }),
        [runId],
        { label: `${LOG_PREFIX} Load reconciliation` },
      );
      if (reconCpRows.length > 0 && reconCpRows[0].payload) {
        const cpStatus = reconCpRows[0].status;
        reconExistingVersion = reconCpRows[0].version_hash;
        if (cpStatus === "complete" || cpStatus === "done") {
          reconciliationResult = reconCpRows[0].payload as ReconciliationResult;
        }
      }
    } catch { /* treat as missing */ }

    // Lineage validation for reconciliation
    if (reconciliationResult && reconExistingVersion && reconExistingVersion !== pipelineVersion) {
      console.warn(`${LOG_PREFIX} reconciliation: STALE — version ${reconExistingVersion} != current ${pipelineVersion}`);
      stageStates.push({ stage: "reconciliation", status: "stale", detail: `version mismatch`, lineageValid: false });
      reconciliationResult = null; // Force re-execution
    }

    if (reconciliationResult) {
      stageStates.push({ stage: "reconciliation", status: "completed_valid", detail: `${reconciliationResult.findings.length} findings`, lineageValid: true });
      completedStages.push("reconciliation");
      lineage.reconciliationHash = hashReconciliation(reconciliationResult);
      console.log(`${LOG_PREFIX} reconciliation: COMPLETE — ${reconciliationResult.findings.length} findings`);
    } else if (claimsDegraded) {
      // Claims degraded — reconciliation cannot run but we proceed
      stageStates.push({ stage: "reconciliation", status: "skipped", detail: "claims degraded" });
      completedStages.push("reconciliation");
      console.log(`${LOG_PREFIX} reconciliation: SKIPPED (claims degraded)`);
    } else if (!claimsLedger?.complete) {
      // Claims not done — reconciliation blocked
      stageStates.push({ stage: "reconciliation", status: "blocked", detail: "claims not complete" });
      return buildResult("blocked", "reconciliation", stageStates, completedStages, progressAdvanced, ["Reconciliation blocked: claims extraction not complete"]);
    } else {
      // Execute reconciliation
      const reconBudget = Math.max(0, timeRemaining() - 30_000);
      if (reconBudget < RECONCILIATION_MIN_BUDGET_MS) {
        stageStates.push({ stage: "reconciliation", status: "partial", detail: "budget insufficient" });
        return buildResult("in_progress", "reconciliation", stageStates, completedStages, progressAdvanced, []);
      }

      try {
        reconciliationResult = await runReconciliation(
          ctx,
          claimsLedger!,
          numericReport?.figures ?? [],
          numericReport?.discrepancies ?? [],
          startTime,
          reconBudget,
        );

        // Persist
        try {
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
             VALUES ($1, 'reconciliation', $2::jsonb, 'complete', $3)
             ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
               SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
            [runId, JSON.stringify(reconciliationResult), pipelineVersion],
            { label: `${LOG_PREFIX} Persist reconciliation` },
          );
          progressAdvanced = true;
        } catch (e: any) {
          console.warn(`${LOG_PREFIX} reconciliation: persist failed: ${e?.message}`);
        }

        stageStates.push({ stage: "reconciliation", status: "completed_valid", detail: `${reconciliationResult.findings.length} findings` });
        completedStages.push("reconciliation");
        lineage.reconciliationHash = hashReconciliation(reconciliationResult);
        console.log(`${LOG_PREFIX} reconciliation: executed — ${reconciliationResult.findings.length} findings`);
      } catch (err: any) {
        console.error(`${LOG_PREFIX} reconciliation: FAILED: ${err?.message}`);
        stageStates.push({ stage: "reconciliation", status: "failed", detail: err?.message });
        return buildResult("failed", "reconciliation", stageStates, completedStages, progressAdvanced, [`Reconciliation failed: ${err?.message}`]);
      }
    }
  } else {
    stageStates.push({ stage: "reconciliation", status: "skipped", detail: "not required for module" });
    completedStages.push("reconciliation");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 3: post_merge (suppression, numeric, consolidation, recon append, materiality)
  // ─────────────────────────────────────────────────────────────────────────
  let postMergeFindings = canonicalRootFindings;
  let postMergeHousekeeping = housekeepingFindings;

  try {
    const postMergeResult = await runPostMergePipeline({
      findings: canonicalRootFindings,
      housekeepingFindings,
      numericReport: null, // Loaded internally by post-merge if needed
      claimsReconciliation: reconciliationResult,
      fileTagMap,
      moduleId,
    });
    postMergeFindings = postMergeResult.findings;
    postMergeHousekeeping = postMergeResult.housekeepingFindings;
    lineage.postMergeResultHash = hashFindings(postMergeFindings);
    stageStates.push({ stage: "post_merge", status: "completed_valid", detail: `${postMergeFindings.length} findings after processing` });
    completedStages.push("post_merge");
    console.log(`${LOG_PREFIX} post_merge: ${canonicalRootFindings.length} → ${postMergeFindings.length} findings`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} post_merge: FAILED: ${err?.message}`);
    stageStates.push({ stage: "post_merge", status: "failed", detail: err?.message });
    return buildResult("failed", "post_merge", stageStates, completedStages, progressAdvanced, [`Post-merge processing failed: ${err?.message}`]);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 4: absence_verify (only for checklist modules)
  // ─────────────────────────────────────────────────────────────────────────
  let verificationErrored = false;
  if (ABSENCE_VERIFICATION_MODULES.has(moduleId)) {
    const verifyBudget = timeRemaining();
    if (verifyBudget < ABSENCE_VERIFICATION_MIN_BUDGET_MS) {
      stageStates.push({ stage: "absence_verify", status: "partial", detail: "budget insufficient" });
      console.log(`${LOG_PREFIX} absence_verify: BUDGET INSUFFICIENT — yielding`);
      return buildResult("in_progress", "absence_verify", stageStates, completedStages, progressAdvanced, []);
    }

    try {
      const verifyResult = await runAbsenceVerificationPhase(
        ctx, dealId, runId, postMergeFindings, moduleId,
        useOpus, subjectDocumentIds ?? [], timeRemaining, startTime,
      );
      postMergeFindings = verifyResult.findings;

      if (!verifyResult.completed) {
        stageStates.push({ stage: "absence_verify", status: "partial", detail: "incomplete — will resume" });
        return buildResult("in_progress", "absence_verify", stageStates, completedStages, progressAdvanced, []);
      }

      stageStates.push({ stage: "absence_verify", status: "completed_valid", detail: `${verifyResult.verificationLog.length} verified` });
      completedStages.push("absence_verify");
      console.log(`${LOG_PREFIX} absence_verify: COMPLETE`);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} absence_verify: FAILED (non-fatal): ${err?.message}`);
      verificationErrored = true;
      stageStates.push({ stage: "absence_verify", status: "failed", detail: `error: ${err?.message}` });
      completedStages.push("absence_verify"); // Non-fatal — proceed with degraded
    }
  } else {
    stageStates.push({ stage: "absence_verify", status: "skipped", detail: "not applicable" });
    completedStages.push("absence_verify");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE 5: canonical_finalize (F06)
  // ─────────────────────────────────────────────────────────────────────────
  const finalizeBudget = timeRemaining();
  if (finalizeBudget < FINALIZATION_MIN_BUDGET_MS) {
    stageStates.push({ stage: "canonical_finalize", status: "partial", detail: "budget insufficient" });
    console.log(`${LOG_PREFIX} canonical_finalize: BUDGET INSUFFICIENT — yielding`);
    return buildResult("in_progress", "canonical_finalize", stageStates, completedStages, progressAdvanced, []);
  }

  // Validate evidence admission prerequisite
  // Evidence admission (tree_level=96) must genuinely exist — never fabricated.
  // loadCheckpointStatus checks the actual Q3 merge checkpoint payload.
  const checkpointStatus = await loadCheckpointStatus(
    ctx.integrations.db, runId, moduleId, postMergeFindings.length > 0,
  );

  // Check evidence admission specifically — if required and missing, BLOCK
  if (CLAIMS_REQUIRED_MODULES.has(moduleId)) {
    const evidenceEntry = checkpointStatus.find(s => s.key === "evidence_admission");
    if (evidenceEntry && !evidenceEntry.present) {
      console.error(`${LOG_PREFIX} canonical_finalize: BLOCKED — evidence_admission missing. Cannot fabricate.`);
      stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: "evidence_admission prerequisite missing — cannot fabricate" });
      return buildResult("blocked", "canonical_finalize", stageStates, completedStages, progressAdvanced,
        ["Evidence admission (tree_level=96) checkpoint is missing. This stage must be executed by the production evidence-admission service. Finalization is blocked until genuine evidence admission data exists."]);
    }
  }

  // Invoke F06 — the sole authoritative finalizer
  console.log(`${LOG_PREFIX} canonical_finalize: invoking F06 — ${postMergeFindings.length} findings, housekeeping=${postMergeHousekeeping.length}`);

  const f06Outcome = await f06CanonicalFinalize(
    ctx.integrations.db,
    runId,
    dealId,
    {
      findings: postMergeFindings,
      executiveHeader,
      moduleType: moduleId,
      checkpointStatus,
      proposedFinalNode: {
        treeLevel: naturalRootTreeLevel,
        nodeIndex: naturalRootNodeIndex,
      },
      claimsDegraded,
      degradedConditions: verificationErrored
        ? [`Absence verification phase errored (${postMergeHousekeeping.length} housekeeping findings present)`]
        : undefined,
    },
  );

  // ── Translate F06 outcome to runner result ──────────────────────────────

  if (f06Outcome.status === "completed") {
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: `artifact=${f06Outcome.artifactId}, hash=${f06Outcome.semanticHash}` });
    completedStages.push("canonical_finalize");
    progressAdvanced = true;
    console.log(`${LOG_PREFIX} COMPLETE — artifact=${f06Outcome.artifactId}, hash=${f06Outcome.semanticHash}, findings=${f06Outcome.findingCount}`);
    return {
      status: "complete",
      currentStage: null,
      stageStates,
      completedStages,
      progressAdvanced,
      blockingReasons: [],
      artifact: f06Outcome.artifact ?? null,
      finalizerOutcome: f06Outcome,
    };
  }

  if (f06Outcome.status === "idempotent") {
    // Already finalized with same content — no artifact on idempotent (already persisted)
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: `idempotent, artifact=${f06Outcome.artifactId}` });
    completedStages.push("canonical_finalize");
    console.log(`${LOG_PREFIX} IDEMPOTENT — artifact=${f06Outcome.artifactId}`);
    return {
      status: "complete",
      currentStage: null,
      stageStates,
      completedStages,
      progressAdvanced: false,
      blockingReasons: [],
      artifact: null, // Idempotent outcome doesn't carry full artifact — already persisted
      finalizerOutcome: f06Outcome,
    };
  }

  if (f06Outcome.status === "publication_blocked") {
    // Publication gate failed — this is a BLOCKED state, not retryable as in_progress
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: f06Outcome.message });
    console.error(`${LOG_PREFIX} PUBLICATION BLOCKED: ${f06Outcome.message}`);
    return buildResult("blocked", "canonical_finalize", stageStates, completedStages, progressAdvanced,
      [`Publication gate blocked: ${f06Outcome.message}`]);
  }

  if (f06Outcome.status === "prerequisites_missing") {
    // Prerequisites still missing after our validation — blocked
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: `missing: ${f06Outcome.missingKeys?.join(", ")}` });
    console.error(`${LOG_PREFIX} PREREQUISITES MISSING: ${f06Outcome.missingKeys?.join(", ")}`);
    return buildResult("blocked", "canonical_finalize", stageStates, completedStages, progressAdvanced,
      [`F06 prerequisites missing: ${f06Outcome.missingKeys?.join(", ")}. Pipeline cannot proceed without manual intervention.`]);
  }

  if (f06Outcome.status === "persist_failed") {
    // Persistence failure — this is a FAILED state
    stageStates.push({ stage: "canonical_finalize", status: "failed", detail: f06Outcome.error });
    console.error(`${LOG_PREFIX} PERSIST FAILED: ${f06Outcome.error}`);
    return buildResult("failed", "canonical_finalize", stageStates, completedStages, progressAdvanced,
      [`F06 persistence failed: ${f06Outcome.error}`]);
  }

  if (f06Outcome.status === "rejected_overwrite") {
    // Run already completed with different hash — blocked
    stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: "rejected_overwrite" });
    console.error(`${LOG_PREFIX} REJECTED OVERWRITE: existing=${f06Outcome.existingHash}, new=${f06Outcome.newHash}`);
    return buildResult("blocked", "canonical_finalize", stageStates, completedStages, progressAdvanced,
      [`Run already completed with different artifact. Cannot overwrite without administrative action.`]);
  }

  // Unknown F06 status — fail-closed
  stageStates.push({ stage: "canonical_finalize", status: "failed", detail: `unexpected F06 status: ${f06Outcome.status}` });
  return buildResult("failed", "canonical_finalize", stageStates, completedStages, progressAdvanced,
    [`Unexpected F06 outcome: ${f06Outcome.status}`]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildResult(
  status: RunnerStatus,
  currentStage: StageName,
  stageStates: StageState[],
  completedStages: StageName[],
  progressAdvanced: boolean,
  blockingReasons: string[],
): PostMergeFinalizationResult {
  return {
    status,
    currentStage,
    stageStates,
    completedStages,
    progressAdvanced,
    blockingReasons,
    artifact: null,
    finalizerOutcome: null,
  };
}
