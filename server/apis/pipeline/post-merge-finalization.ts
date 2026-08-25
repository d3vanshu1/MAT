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
import { runReconciliationPipeline, type ReconciliationPipelineResult } from "./reconciliation-pipeline.js";
import {
  canonicalFinalize as f06CanonicalFinalize,
  loadCheckpointStatus,
  loadRunDiagnostics,
  type FinalizerOutcome,
} from "./canonical-finalizer.js";
import type { CanonicalFinalArtifact } from "./canonical-final-artifact.js";
import { CANONICAL_FINAL_ARTIFACT_VERSION, SEMANTIC_HASH_VERSION } from "./canonical-final-artifact.js";
import type { MergedFinding } from "../modules/build-merged-text.js";
import type { ICQuestionsArtifact } from "./ic-questions-contract.js";
import { renderICQuestionsReport } from "./ic-questions-render.js";
import { computeContentHash } from "./source-snapshot.js";
import { applyReductionGates } from "./finding-reduction-gate.js";
import {
  buildReconciliationReportMarkdown,
  type ReconciliationP21Meta,
  type ReductionGateSummary,
} from "./reconciliation-report-builder.js";

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
  callerPath: "fast_path" | "normal_path" | "reconciliation_path" | "ic_questions_path";

  /** File tag map for source routing */
  fileTagMap: Map<string, string>;
  /** Subject document IDs for absence verification */
  subjectDocumentIds?: string[];
  /** Whether to use Opus model for absence verification */
  useOpus?: boolean | null;
  /**
   * IC Questions (v2) synthesis artifact. Present only on `ic_questions_path`;
   * optional and null-defaulted so no existing caller changes.
   */
  icQuestionsArtifact?: ICQuestionsArtifact | null;

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
    queryFn?: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]>;
    dealId?: string;
    aiFn?: (req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: any }, meta?: { label: string }) => Promise<any>;
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
// Durable Stage Checkpoints (stages 3–5)
// ─────────────────────────────────────────────────────────────────────────────
//
// Stages 1 (claims_ledger) and 2 (reconciliation) were already durable. Stages 3
// (post_merge), the finding reduction gate, and 5 (canonical_finalize) were not:
// they re-executed on EVERY invocation of this runner. The reduction-gate ledger
// was written to pipeline_checkpoints but never read back. The result was that
// each resume spent its whole budget redoing identical work, ran out, and yielded
// in_progress again — a restart loop that could never reach finalization.
//
// Every stage checkpoint carries a lineage envelope. A checkpoint is only reused
// when BOTH the pipeline version AND the natural-root finding hash match, so a
// changed pipeline or a changed merge root forces the stage to re-run.

/** Checkpoint keys for the newly-durable stages */
const POST_MERGE_DONE_KEY = "post_merge_done";
const REDUCTION_GATE_DONE_KEY = "reduction_gate_done";
const CANONICAL_FINALIZE_DONE_KEY = "canonical_finalize_done";

interface StageCheckpointEnvelope<T> {
  pipelineVersion: string;
  naturalRootFindingHash: string;
  sourceManifestHash: string | null;
  payload: T;
}

/**
 * Load a stage checkpoint and validate its lineage.
 * Returns the payload only when the checkpoint exists, is complete, and its
 * lineage matches the current invocation. Never throws.
 */
async function loadStageCheckpoint<T>(
  ctx: PipelineContext,
  runId: string,
  key: string,
  pipelineVersion: string,
  naturalRootFindingHash: string,
  logPrefix: string,
): Promise<T | null> {
  try {
    const rows = await ctx.integrations.db.query(
      `SELECT payload, status, version_hash FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = $2
       LIMIT 1`,
      z.object({ payload: z.any(), status: z.string().nullable(), version_hash: z.string().nullable() }),
      [runId, key],
      { label: `${logPrefix} Load ${key}` },
    );
    if (rows.length === 0 || !rows[0].payload) return null;
    if (rows[0].status !== "complete") {
      console.log(`${logPrefix} ${key}: present but status=${rows[0].status} — ignoring`);
      return null;
    }
    if (rows[0].version_hash !== pipelineVersion) {
      console.warn(`${logPrefix} ${key}: STALE — version ${rows[0].version_hash} != current ${pipelineVersion}`);
      return null;
    }
    const envelope = rows[0].payload as StageCheckpointEnvelope<T>;
    if (envelope?.naturalRootFindingHash !== naturalRootFindingHash) {
      console.warn(
        `${logPrefix} ${key}: STALE — root hash ${String(envelope?.naturalRootFindingHash).slice(0, 8)} != ` +
        `current ${naturalRootFindingHash.slice(0, 8)}`
      );
      return null;
    }
    if (envelope.payload === undefined || envelope.payload === null) {
      console.warn(`${logPrefix} ${key}: envelope has no payload — ignoring`);
      return null;
    }
    return envelope.payload;
  } catch (e: any) {
    // pipeline_checkpoints unreadable — treat as missing and re-run the stage.
    // Failing toward re-execution is safe; failing toward "done" would skip work.
    console.warn(`${logPrefix} ${key}: load failed (${e?.message}) — treating as missing`);
    return null;
  }
}

/**
 * Persist a stage checkpoint with its lineage envelope.
 * Returns true when the write succeeded (durable progress was made).
 */
async function persistStageCheckpoint<T>(
  ctx: PipelineContext,
  runId: string,
  key: string,
  payload: T,
  lineage: { pipelineVersion: string; naturalRootFindingHash: string; sourceManifestHash: string | null },
  logPrefix: string,
): Promise<boolean> {
  const envelope: StageCheckpointEnvelope<T> = {
    pipelineVersion: lineage.pipelineVersion,
    naturalRootFindingHash: lineage.naturalRootFindingHash,
    sourceManifestHash: lineage.sourceManifestHash,
    payload,
  };
  try {
    await ctx.integrations.db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
       VALUES ($1, $2, $3::jsonb, 'complete', $4)
       ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
         SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = EXCLUDED.version_hash`,
      [runId, key, JSON.stringify(envelope), lineage.pipelineVersion],
      { label: `${logPrefix} Persist ${key}` },
    );
    console.log(`${logPrefix} ${key}: checkpoint persisted`);
    return true;
  } catch (e: any) {
    console.warn(`${logPrefix} ${key}: persist failed (non-fatal): ${e?.message}`);
    return false;
  }
}

/**
 * Rebuild a CanonicalFinalArtifact from the already-published module_outputs row.
 *
 * Used when finalization is known to have completed (canonical_finalize_done
 * checkpoint, or an F06 `idempotent` outcome) but the in-memory artifact object
 * is not available. Without this, the runner returned `complete` with a null
 * artifact, and BOTH callers in pipeline-core translate "complete with no
 * artifact" into `in_progress` — another way the run could never close.
 */
async function hydratePersistedArtifact(
  ctx: PipelineContext,
  runId: string,
  moduleId: string,
  fallbackExecutiveHeader: string,
  semanticHash: string,
  checkpointStatus: any[],
  logPrefix: string,
): Promise<CanonicalFinalArtifact | null> {
  try {
    const rows = await ctx.integrations.db.query(
      `SELECT executive_header, full_report_markdown, findings
       FROM module_outputs
       WHERE module_run_id = $1
         AND executive_header NOT LIKE '[INVALIDATED_PARTIAL]%'
       ORDER BY created_at DESC
       LIMIT 1`,
      z.object({
        executive_header: z.string().nullable(),
        full_report_markdown: z.string().nullable(),
        findings: z.any().nullable(),
      }),
      [runId],
      { label: `${logPrefix} Hydrate persisted artifact` },
    );
    if (rows.length === 0) {
      console.warn(`${logPrefix} Hydration failed: no non-invalidated module_outputs row for run ${runId}`);
      return null;
    }
    const row = rows[0];
    const persistedFindings: unknown[] = Array.isArray(row.findings) ? row.findings : [];
    const markdown = row.full_report_markdown ?? "";

    // The `findings` column intentionally carries only the reportable set (see canonical-finalizer
    // STEP 10). The suppression audit trail lives in the module_run_diagnostics side table, so
    // rehydration recovers excluded_findings / degraded_conditions from there rather than
    // returning an empty set and claiming diagnostics were not re-derived.
    const persistedDiagnostics = await loadRunDiagnostics(ctx.integrations.db as any, runId);
    const degradedConditions = persistedDiagnostics
      ? [...persistedDiagnostics.degradedConditions, "Artifact rehydrated from persisted module_outputs"]
      : ["Artifact rehydrated from persisted module_outputs — suppression audit trail unavailable (module_run_diagnostics missing or empty)"];

    return {
      schema_version: CANONICAL_FINAL_ARTIFACT_VERSION,
      run_id: runId,
      module_type: moduleId,
      canonical_findings: persistedFindings,
      reportable_finding_ids: persistedFindings
        .map((f: any) => f?.finding_id ?? f?.id)
        .filter((id: unknown): id is string => typeof id === "string"),
      diagnostics: {
        narrative_validation: [],
        excluded_findings: persistedDiagnostics?.excludedFindings ?? [],
        degraded_conditions: degradedConditions,
        checkpoint_status: checkpointStatus,
      },
      report: {
        markdown,
        finding_count: persistedFindings.length,
        executive_header: row.executive_header ?? fallbackExecutiveHeader,
      },
      identity: {
        semantic_hash: semanticHash,
        hash_version: SEMANTIC_HASH_VERSION,
      },
      finalized_at: new Date().toISOString(),
    };
  } catch (e: any) {
    console.warn(`${logPrefix} Hydration failed (${e?.message})`);
    return null;
  }
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
    icQuestionsArtifact,
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

  /** Payload shape for canonical_finalize_done (3c) */
  interface CanonicalFinalizeDonePayload {
    artifactId: string;
    semanticHash: string;
    findingCount: number;
    pipelineVersion: string;
    naturalRootFindingHash: string;
    finalizedAt: string;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3c (read on entry): canonical_finalize_done
  //
  // If F06 already produced and published an artifact for THIS pipeline version
  // and THIS natural-root finding hash, the run is finished. Re-invoking F06
  // cannot improve the outcome — at best it returns `idempotent`, at worst it
  // burns the entire budget and yields in_progress, which is exactly the restart
  // loop. Short-circuit: rehydrate the published artifact and return complete.
  //
  // This checkpoint is also what makes the corrected fast path in pipeline-core
  // safe: "valid manifest + valid artifact" may only be treated as completed
  // when canonical_finalize_done exists at the current pipeline version.
  // ─────────────────────────────────────────────────────────────────────────
  const finalizeDoneCp = await loadStageCheckpoint<CanonicalFinalizeDonePayload>(
    ctx, runId, CANONICAL_FINALIZE_DONE_KEY, pipelineVersion, naturalRootFindingHash, LOG_PREFIX,
  );

  if (finalizeDoneCp) {
    console.log(
      `${LOG_PREFIX} canonical_finalize: ALREADY DONE — artifact=${finalizeDoneCp.artifactId}, ` +
      `hash=${finalizeDoneCp.semanticHash}, findings=${finalizeDoneCp.findingCount}, ` +
      `finalizedAt=${finalizeDoneCp.finalizedAt}. Skipping all stages; rehydrating published artifact.`
    );

    for (const stage of STAGE_SEQUENCE) {
      stageStates.push({
        stage,
        status: "completed_valid",
        detail: stage === "canonical_finalize"
          ? `restored from canonical_finalize_done (artifact=${finalizeDoneCp.artifactId})`
          : "already completed in a prior invocation",
        lineageValid: true,
      });
      completedStages.push(stage);
    }

    const hydrated = await hydratePersistedArtifact(
      ctx, runId, moduleId, executiveHeader, finalizeDoneCp.semanticHash,
      stageStates.map(s => ({ key: s.stage, present: true })),
      LOG_PREFIX,
    );

    if (!hydrated) {
      // Checkpoint says finalization succeeded but the published row is gone
      // (invalidated or purged). Do NOT fabricate an artifact — clear the stale
      // checkpoint's authority by falling through to a genuine re-finalization.
      console.warn(
        `${LOG_PREFIX} canonical_finalize_done present but module_outputs row unavailable — ` +
        `ignoring checkpoint and re-running the finalization chain.`
      );
      stageStates.length = 0;
      completedStages.length = 0;
    } else {
      return {
        status: "complete",
        currentStage: "canonical_finalize",
        stageStates,
        completedStages,
        progressAdvanced: false,
        blockingReasons: [],
        artifact: hydrated,
        finalizerOutcome: null,
      };
    }
  }

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
  /**
   * P2.1 hold/gate counters for the reconciliation report's §4. Populated whether
   * reconciliation was executed this invocation or restored from its checkpoint,
   * so a resumed run reports the same funnel as a single-pass run.
   */
  let reconP21Meta: ReconciliationP21Meta | null = null;

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
          const meta = (reconCpRows[0].payload as any)?._p21_metadata;
          if (meta && typeof meta === "object") reconP21Meta = meta as ReconciliationP21Meta;
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
        // P2.1: Use the full reconciliation pipeline (magnitude guard, parallel-offset
        // detector, verification gate, coverage funnel) instead of bare runReconciliation.
        const pipelineResult: ReconciliationPipelineResult = await runReconciliationPipeline({
          ctx,
          dealId,
          ledger: claimsLedger!,
          baseFigures: numericReport?.figures ?? [],
          discrepancies: numericReport?.discrepancies ?? [],
          queryFn: (sql, schema, params, meta) => ctx.integrations.db.query(sql, schema, params, meta),
          timeBudgetMs: reconBudget,
          startTime,
        });

        // Use the full pipeline result — findings filtered through all gates
        reconciliationResult = pipelineResult.reconciliation;
        // Replace findings with only the verified set (post-magnitude, post-offset, post-gate)
        (reconciliationResult as any).findings = pipelineResult.verifiedFindings;

        console.log(
          `${LOG_PREFIX} reconciliation P2.1 pipeline: ` +
          `${pipelineResult.reconciliation.findings.length} raw → ` +
          `${pipelineResult.verifiedFindings.length} verified. ` +
          `Magnitude held: ${pipelineResult.magnitudeHeld}, ` +
          `Parallel-offset held: ${pipelineResult.parallelOffsetHeld}, ` +
          `Gate rejected: ${pipelineResult.gateResult.rejected.length}. ` +
          `Bridge figures: ${pipelineResult.bridgeFiguresCount}. ` +
          `Elapsed: ${pipelineResult.elapsedMs}ms.`
        );

        // Persist with P2.1 metadata
        try {
          reconP21Meta = {
            bridgeFiguresCount: pipelineResult.bridgeFiguresCount,
            magnitudeHeld: pipelineResult.magnitudeHeld,
            parallelOffsetHeld: pipelineResult.parallelOffsetHeld,
            gateVerified: pipelineResult.gateResult.verified.length,
            gateRejected: pipelineResult.gateResult.rejected.length,
            gateTotalSubmitted: pipelineResult.gateResult.total_submitted,
            gateRejectionCounts: pipelineResult.gateResult.rejection_counts as unknown as Record<string, number>,
            unmatchableScopeDetails: pipelineResult.unmatchableScopes,
            elapsedMs: pipelineResult.elapsedMs,
          };
          const checkpointPayload = {
            ...reconciliationResult,
            _p21_metadata: {
              ...reconP21Meta,
              metricDerivation: pipelineResult.metricDerivation,
              gateRejectionRate: pipelineResult.gateResult.rejection_rate,
              unmatchableScopes: pipelineResult.unmatchableScopes.length,
            },
          };
          await ctx.integrations.db.execute(
            `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
             VALUES ($1, 'reconciliation', $2::jsonb, 'complete', $3)
             ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
               SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
            [runId, JSON.stringify(checkpointPayload), pipelineVersion],
            { label: `${LOG_PREFIX} Persist reconciliation (P2.1 full pipeline)` },
          );
          progressAdvanced = true;
        } catch (e: any) {
          console.warn(`${LOG_PREFIX} reconciliation: persist failed: ${e?.message}`);
        }

        stageStates.push({ stage: "reconciliation", status: "completed_valid", detail: `${reconciliationResult.findings.length} findings (P2.1)` });
        completedStages.push("reconciliation");
        lineage.reconciliationHash = hashReconciliation(reconciliationResult);
        console.log(`${LOG_PREFIX} reconciliation: executed P2.1 — ${reconciliationResult.findings.length} verified findings`);
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

  const stageLineage = { pipelineVersion, naturalRootFindingHash, sourceManifestHash };

  /** Payload shape for post_merge_done */
  interface PostMergeDonePayload {
    findings: MergedFinding[];
    housekeepingFindings: MergedFinding[];
    postMergeResultHash: string;
  }
  /** Payload shape for reduction_gate_done */
  interface ReductionGateDonePayload {
    primaryFindings: MergedFinding[];
    housekeepingFindings: MergedFinding[];
    postMergeResultHash: string;
    gateStats?: unknown;
    groundTruthSignals?: string[];
  }

  // ── 3b (read first): reduction_gate_done supersedes post_merge_done ────────
  // If the gate already ran for this root at this pipeline version, its output IS
  // the input to absence_verify and F06 — both post_merge and the gate are skipped.
  const gateCp = await loadStageCheckpoint<ReductionGateDonePayload>(
    ctx, runId, REDUCTION_GATE_DONE_KEY, pipelineVersion, naturalRootFindingHash, LOG_PREFIX,
  );

  let gateAlreadyApplied = false;
  /** Ten-gate reduction filter outcome, for the reconciliation report's §4. */
  let reductionGateSummary: ReductionGateSummary | null = null;
  if (gateCp && Array.isArray(gateCp.primaryFindings)) {
    postMergeFindings = gateCp.primaryFindings;
    postMergeHousekeeping = Array.isArray(gateCp.housekeepingFindings)
      ? gateCp.housekeepingFindings
      : housekeepingFindings;
    lineage.postMergeResultHash = gateCp.postMergeResultHash;
    gateAlreadyApplied = true;
    reductionGateSummary = {
      admitted: postMergeFindings.length,
      // Not carried on this checkpoint. Left null so the report builder reads the
      // authoritative `finding_reduction_gate` ledger instead of printing 0.
      rejected: null,
      byGate: (gateCp.gateStats as ReductionGateSummary["byGate"]) ?? null,
    };
    stageStates.push({ stage: "post_merge", status: "completed_valid", detail: "restored from reduction_gate_done checkpoint", lineageValid: true });
    completedStages.push("post_merge");
    console.log(
      `${LOG_PREFIX} post_merge + finding_reduction_gate: RESTORED from checkpoint — ` +
      `${postMergeFindings.length} primary findings, housekeeping=${postMergeHousekeeping.length}. ` +
      `Both stages skipped this invocation.`
    );
  }

  // ── 3a: post_merge (skipped when the gate checkpoint already covered it) ───
  if (!gateAlreadyApplied) {
    const postMergeCp = await loadStageCheckpoint<PostMergeDonePayload>(
      ctx, runId, POST_MERGE_DONE_KEY, pipelineVersion, naturalRootFindingHash, LOG_PREFIX,
    );

    if (postMergeCp && Array.isArray(postMergeCp.findings)) {
      postMergeFindings = postMergeCp.findings;
      postMergeHousekeeping = Array.isArray(postMergeCp.housekeepingFindings)
        ? postMergeCp.housekeepingFindings
        : housekeepingFindings;
      lineage.postMergeResultHash = postMergeCp.postMergeResultHash;
      stageStates.push({ stage: "post_merge", status: "completed_valid", detail: `restored from post_merge_done checkpoint (${postMergeFindings.length} findings)`, lineageValid: true });
      completedStages.push("post_merge");
      console.log(`${LOG_PREFIX} post_merge: RESTORED from checkpoint — ${postMergeFindings.length} findings, runPostMergePipeline skipped`);
    } else {
      try {
        const postMergeResult = await runPostMergePipeline({
          findings: canonicalRootFindings,
          housekeepingFindings,
          numericReport: null, // Loaded internally by post-merge if needed
          claimsReconciliation: reconciliationResult,
          fileTagMap,
          moduleId,
          queryFn: ctx.integrations.db.query.bind(ctx.integrations.db),
          dealId,
          aiFn: ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
        });
        postMergeFindings = postMergeResult.findings;
        postMergeHousekeeping = postMergeResult.housekeepingFindings;
        lineage.postMergeResultHash = hashFindings(postMergeFindings);
        stageStates.push({ stage: "post_merge", status: "completed_valid", detail: `${postMergeFindings.length} findings after processing` });
        completedStages.push("post_merge");
        console.log(`${LOG_PREFIX} post_merge: ${canonicalRootFindings.length} → ${postMergeFindings.length} findings`);

        // 3a: durable checkpoint so the next invocation does not redo this work
        const wrote = await persistStageCheckpoint<PostMergeDonePayload>(
          ctx, runId, POST_MERGE_DONE_KEY,
          {
            findings: postMergeFindings,
            housekeepingFindings: postMergeHousekeeping,
            postMergeResultHash: lineage.postMergeResultHash!,
          },
          stageLineage, LOG_PREFIX,
        );
        if (wrote) progressAdvanced = true;
      } catch (err: any) {
        console.error(`${LOG_PREFIX} post_merge: FAILED: ${err?.message}`);
        stageStates.push({ stage: "post_merge", status: "failed", detail: err?.message });
        return buildResult("failed", "post_merge", stageStates, completedStages, progressAdvanced, [`Post-merge processing failed: ${err?.message}`]);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FINDING REDUCTION GATE — applied after post_merge, before absence_verify
  // Replaces postMergeFindings with primary findings; secondary/suppressed
  // findings are recorded in diagnostics but do NOT enter the IC-facing report.
  //
  // 3b: skipped entirely when reduction_gate_done was restored above. Re-running
  // the gate on already-gated findings is not free and not guaranteed idempotent
  // (confirmation matching reads the pre-gate population), so the checkpoint is
  // authoritative once written.
  // ─────────────────────────────────────────────────────────────────────────
  if (gateAlreadyApplied) {
    console.log(`${LOG_PREFIX} finding_reduction_gate: SKIPPED — restored from reduction_gate_done checkpoint (${postMergeFindings.length} primary findings)`);
  } else {
    // Captured before the gate replaces `postMergeFindings` with the primary set.
    // Used to attach titles to the suppression ledger below.
    const preGateFindings = postMergeFindings as any[];
    const reductionResult = applyReductionGates(postMergeFindings as any[]);
    const beforeCount = postMergeFindings.length;
    const afterCount = reductionResult.primaryFindings.length;

    console.log(
      `${LOG_PREFIX} finding_reduction_gate: ${beforeCount} → ${afterCount} primary ` +
      `(${reductionResult.confirmations.length} confirmations, ` +
      `${reductionResult.secondaryObservations.length} secondary, ` +
      `${reductionResult.suppressedLedger.length} suppressed, ` +
      `ground_truth=[${reductionResult.groundTruthSignals.join(",")}])`
    );

    // Persist reduction ledger as a pipeline checkpoint for audit / diagnostics.
    // The canonical finalizer reads this checkpoint at STEP 10.5 and copies the
    // per-finding gate attribution into `module_run_diagnostics`, which is not
    // purgeable. Titles are joined in here because FindingDisposition carries only
    // findingId — and an audit line reading "cf-7a21 suppressed by actual_forecast"
    // is not reviewable by a human without the title.
    const preGateTitleById = new Map<string, string>();
    for (const f of preGateFindings) {
      const id = (f as any)?.finding_id ?? (f as any)?.id;
      if (typeof id === "string" && id.length > 0) {
        preGateTitleById.set(id, String((f as any)?.title ?? ""));
      }
    }
    try {
      await input.ctx.integrations.db.execute(
        `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
         VALUES ($1, 'finding_reduction_gate', $2::jsonb, 'complete', $3)
         ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
        [
          runId,
          JSON.stringify({
            primaryCount: afterCount,
            confirmationCount: reductionResult.confirmations.length,
            secondaryCount: reductionResult.secondaryObservations.length,
            suppressedCount: reductionResult.suppressedLedger.length,
            suppressedLedger: reductionResult.suppressedLedger.map(d => ({
              ...d,
              title: preGateTitleById.get(d.findingId) ?? "",
            })),
            confirmations: reductionResult.confirmations.map(c => ({
              findingId: c.finding.finding_id ?? c.finding.id ?? "unknown",
              title: c.finding.title,
              originalKind: c.originalKind,
              signal: c.matchedSignal,
            })),
            gateStats: reductionResult.gateStats,
            groundTruthSignals: reductionResult.groundTruthSignals,
          }),
          pipelineVersion,
        ],
        { label: `${LOG_PREFIX} Persist finding_reduction_gate ledger` },
      );
      progressAdvanced = true;
    } catch (e: any) {
      console.warn(`${LOG_PREFIX} finding_reduction_gate: ledger persist failed (non-fatal): ${e?.message}`);
    }

    // Replace findings: only primary findings proceed into absence_verify and F06
    postMergeFindings = reductionResult.primaryFindings as any;

    reductionGateSummary = {
      admitted: afterCount,
      rejected: reductionResult.suppressedLedger.length,
      byGate: reductionResult.gateStats ?? null,
    };

    // 3b: durable checkpoint. This is the linchpin of the loop fix — the gate
    // output is what F06 consumes, so restoring it lets a resumed invocation
    // jump straight to absence_verify/finalization instead of rebuilding the
    // entire post_merge + gate chain and exhausting its budget again.
    const gateWrote = await persistStageCheckpoint<ReductionGateDonePayload>(
      ctx, runId, REDUCTION_GATE_DONE_KEY,
      {
        primaryFindings: postMergeFindings,
        housekeepingFindings: postMergeHousekeeping,
        postMergeResultHash: lineage.postMergeResultHash ?? hashFindings(postMergeFindings),
        gateStats: reductionResult.gateStats,
        groundTruthSignals: reductionResult.groundTruthSignals,
      },
      stageLineage, LOG_PREFIX,
    );
    if (gateWrote) {
      progressAdvanced = true;
      gateAlreadyApplied = true;
    }
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
  // NOTE: hasParsedFindings=true unconditionally because by this point all
  // quality stages (claims, reconciliation, post_merge, reduction gate) have
  // completed. An empty findings array is a legitimate terminal state (all
  // findings gated out), not a missing prerequisite.
  const checkpointStatus = await loadCheckpointStatus(
    ctx.integrations.db, runId, moduleId, true,
  );

  // Check evidence admission specifically — if required and missing, BLOCK
  // EXCEPTION: normal_path (old natural-merge-tree) runs do NOT have P2.1
  // reconstruction artifacts (tree_level=97/98/99) that ReplayClaimLinkage
  // requires to produce evidence_admission at tree_level=96. The check is
  // skipped for these runs — evidence admission is a P2.1 gate only.
  // EXCEPTION: reconciliation_path (CC direct-reconciliation) skips the merge
  // tree entirely, so no P2.1 reconstruction artifacts exist either.
  if (
    CLAIMS_REQUIRED_MODULES.has(moduleId) &&
    callerPath !== "normal_path" &&
    callerPath !== "reconciliation_path"
  ) {
    const evidenceEntry = checkpointStatus.find(s => s.key === "evidence_admission");
    if (evidenceEntry && !evidenceEntry.present) {
      console.error(`${LOG_PREFIX} canonical_finalize: BLOCKED — evidence_admission missing. Cannot fabricate.`);
      stageStates.push({ stage: "canonical_finalize", status: "blocked", detail: "evidence_admission prerequisite missing — cannot fabricate" });
      return buildResult("blocked", "canonical_finalize", stageStates, completedStages, progressAdvanced,
        ["Evidence admission (tree_level=96) checkpoint is missing. This stage must be executed by the production evidence-admission service. Finalization is blocked until genuine evidence admission data exists."]);
    }
  } else if (
    CLAIMS_REQUIRED_MODULES.has(moduleId) &&
    (callerPath === "normal_path" || callerPath === "reconciliation_path")
  ) {
    console.log(`${LOG_PREFIX} canonical_finalize: evidence_admission check SKIPPED for ${callerPath} — P2.1 reconstruction artifacts not available`);
  }

  // ── Reconciliation-path report ────────────────────────────────────────────
  // contradiction_check on the reconciliation path publishes a memo-vs-model
  // reconciliation document, not the tier-based canonical report. It is rendered
  // here — after the ten-gate reduction filter — so it can only ever present
  // findings that survived every quality check. Presentation-only: a failure
  // falls back to the canonical renderer and never fails the run.
  let reportOverride: string | null = null;
  // Caller-supplied executive header. Only the IC-questions path sets this; F06
  // falls back to its own regenerated/passed-through header when it stays null.
  let headerOverride: string | null = null;
  if (callerPath === "reconciliation_path" && reconciliationResult) {
    try {
      const survivingTitles = new Set(
        (postMergeFindings as any[]).map(f => String(f?.title ?? "")).filter(t => t.length > 0),
      );
      const built = await buildReconciliationReportMarkdown({
        db: ctx.integrations.db,
        dealId,
        runId,
        claimsLedger,
        reconciliation: reconciliationResult,
        p21: reconP21Meta,
        reductionGate: reductionGateSummary,
        survivingTitles,
        timings: {
          reconciliationMs: reconP21Meta?.elapsedMs ?? null,
          totalMs: Date.now() - startTime,
        },
      });
      if (built) {
        reportOverride = built.markdown;
        console.log(
          `${LOG_PREFIX} reconciliation report: rendered ${built.markdown.length} chars — ` +
          `${built.rankedCount} ranked, ${built.presentedCount} presented, ` +
          `${built.rankedCount - built.presentedCount} in appendix.`
        );
        for (const line of built.rankAudit) console.log(`${LOG_PREFIX} rank ${line}`);
      }
    } catch (e: any) {
      console.warn(
        `${LOG_PREFIX} reconciliation report render FAILED (non-fatal, falling back to ` +
        `canonical renderer): ${e?.message}`
      );
    }
  }

  // ── IC-questions-path report ──────────────────────────────────────────────
  // ic_challenge_mode v2 publishes a single-call synthesis over the IC memo
  // corpus. Unlike the reconciliation report above, a render failure here is
  // FATAL: the canonical renderer would silently emit a tier-based report over
  // findings projected from IC questions, which is a different document than
  // the one the module promises. Publishing that instead would be worse than
  // failing the run, so the error is rethrown.
  if (callerPath === "ic_questions_path" && icQuestionsArtifact) {
    try {
      const built = renderICQuestionsReport(icQuestionsArtifact);
      if (built) {
        reportOverride = built.markdown;
        headerOverride = built.executiveHeader;
        console.log(`${LOG_PREFIX} ic-questions report: rendered ${built.markdown.length} chars — ${built.questionCount} question(s).`);
      }
    } catch (e: any) {
      console.error(`${LOG_PREFIX} ic-questions report render FAILED: ${e?.message}`);
      throw e;
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
      // reconciliation_path and ic_questions_path write no merge nodes, so there
      // is no natural root to propose. F06's publication gate is bypassed for
      // these paths.
      proposedFinalNode:
        callerPath === "reconciliation_path" || callerPath === "ic_questions_path"
          ? undefined
          : {
              treeLevel: naturalRootTreeLevel,
              nodeIndex: naturalRootNodeIndex,
            },
      claimsDegraded,
      degradedConditions: verificationErrored
        ? [`Absence verification phase errored (${postMergeHousekeeping.length} housekeeping findings present)`]
        : undefined,
      // Natural-merge-tree runs never produce P2.1 reconstruction artifacts
      // (tree_level=97/98/99), so evidence_admission cannot exist. Skip it.
      // ic_questions_path skips the merge tree entirely for the same reason.
      skipEvidenceAdmission:
        callerPath === "normal_path" ||
        callerPath === "reconciliation_path" ||
        callerPath === "ic_questions_path",
      // No merge tree exists on the reconciliation or IC-questions paths — the
      // publication gate validates tree lineage, which is not applicable here.
      bypassPublicationGate:
        callerPath === "reconciliation_path" || callerPath === "ic_questions_path",
      reportOverride,
      headerOverride,
    },
  );

  // ── Translate F06 outcome to runner result ──────────────────────────────

  if (f06Outcome.status === "completed") {
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: `artifact=${f06Outcome.artifactId}, hash=${f06Outcome.semanticHash}` });
    completedStages.push("canonical_finalize");
    progressAdvanced = true;
    console.log(`${LOG_PREFIX} COMPLETE — artifact=${f06Outcome.artifactId}, hash=${f06Outcome.semanticHash}, findings=${f06Outcome.findingCount}`);

    // 3c (write): record that finalization succeeded for this lineage. Any later
    // invocation of this runner short-circuits on entry instead of re-invoking F06.
    await persistStageCheckpoint<CanonicalFinalizeDonePayload>(
      ctx, runId, CANONICAL_FINALIZE_DONE_KEY,
      {
        artifactId: f06Outcome.artifactId ?? "",
        semanticHash: f06Outcome.semanticHash ?? "",
        findingCount: f06Outcome.findingCount ?? postMergeFindings.length,
        pipelineVersion,
        naturalRootFindingHash,
        finalizedAt: new Date().toISOString(),
      },
      stageLineage, LOG_PREFIX,
    );

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
    // Already finalized with identical content — the artifact is persisted but F06
    // does not hand it back. Both callers in pipeline-core treat
    // "complete with a null artifact" as in_progress, so returning null here is
    // itself a loop condition. Rehydrate from module_outputs instead.
    stageStates.push({ stage: "canonical_finalize", status: "completed_valid", detail: `idempotent, artifact=${f06Outcome.artifactId}` });
    completedStages.push("canonical_finalize");
    console.log(`${LOG_PREFIX} IDEMPOTENT — artifact=${f06Outcome.artifactId}`);

    // 3c (write): idempotent is a successful finalization outcome — checkpoint it.
    await persistStageCheckpoint<CanonicalFinalizeDonePayload>(
      ctx, runId, CANONICAL_FINALIZE_DONE_KEY,
      {
        artifactId: f06Outcome.artifactId ?? "",
        semanticHash: f06Outcome.semanticHash ?? "",
        findingCount: postMergeFindings.length,
        pipelineVersion,
        naturalRootFindingHash,
        finalizedAt: new Date().toISOString(),
      },
      stageLineage, LOG_PREFIX,
    );

    const idempotentArtifact = await hydratePersistedArtifact(
      ctx, runId, moduleId, executiveHeader, f06Outcome.semanticHash ?? "",
      checkpointStatus, LOG_PREFIX,
    );
    if (!idempotentArtifact) {
      console.warn(`${LOG_PREFIX} IDEMPOTENT but persisted artifact could not be rehydrated — returning without artifact`);
    }

    return {
      status: "complete",
      currentStage: null,
      stageStates,
      completedStages,
      progressAdvanced: false,
      blockingReasons: [],
      artifact: idempotentArtifact,
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
