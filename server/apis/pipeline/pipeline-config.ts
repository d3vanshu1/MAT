/**
 * Pipeline Configuration — single source of truth for platform-aware timing constants.
 *
 * All timing-related constants are derived from PLATFORM_CAP_MS so the pipeline
 * self-adjusts when the platform timeout changes (env: SB_API_TIMEOUT_MS).
 *
 * Invariant: No single LLM call or retry sequence can exceed
 * PLATFORM_CAP_MS − elapsed − PLATFORM_HEADROOM_MS at the point it starts.
 * This is enforced by callLLMWithHeadroom(), the sole entry point for all LLM calls.
 */
import type { z } from "@superblocksteam/sdk-api";

// ===========================================================================
// Platform Envelope
// ===========================================================================

/** Platform hard-kill timeout (ms).
 *
 *  SB_API_TIMEOUT_MS is NOT a user-settable env var in Superblocks.
 *  The Application API duration quota is 5 minutes (Pro/Enterprise):
 *    https://docs.superblocks.com/development-lifecycle/build/rate-limits-and-quotas
 *
 *  NOTE: Clark's testApi path has a DIFFERENT (higher) timeout than client-invoked
 *  APIs (executeSdkApiV3). DiagTimeoutProbe survived 570s via testApi, but actual
 *  client-invoked RunModulePipeline is killed at 300s. The platform quota governs
 *  the client path; testApi runs through the orchestrator with relaxed limits.
 *
 *  Fallback: if the env var IS ever exposed, it overrides (fail-safe: lower
 *  values make the pipeline more conservative, never less safe). */
export const PLATFORM_CAP_MS = Number(process.env.SB_API_TIMEOUT_MS) || 300_000;

/** Effective cap override.
 *
 *  REVERTED 2026-07-28: The 305s DiagTimeoutProbe was a false positive — it
 *  self-reports via DB heartbeat (measures function completion, not client-
 *  invocation survival). RunModulePipeline was hard-killed at 300s on the
 *  client-invoked path, confirming the Application API quota is still 5 min.
 *  The 600s override set graceful exit to 500s — past the 300s kill — so no
 *  checkpoint was written and the run was destroyed.
 *
 *  With override=undefined, EFFECTIVE_CAP_MS=300s:
 *    TIME_BUDGET_MS = 200_000 (graceful exit 200s, safe under 300s kill)
 *    EXTRACTION_TIME_BUDGET_MS = 130_000 (42% of 300s)
 *    RESUME_JOB_TIME_BUDGET_MS = 270_000 (300s - 30s headroom)
 *    STALENESS_THRESHOLD_MINUTES = 7 (ceil(5min) + 2)
 */
const PIPELINE_CAP_OVERRIDE_MS: number | undefined = undefined;

/** The actual cap used for all derived constants. Override wins if set. */
export const EFFECTIVE_CAP_MS = PIPELINE_CAP_OVERRIDE_MS ?? PLATFORM_CAP_MS;

/** Safety buffer subtracted from remaining headroom before starting any
 *  long-running operation. Covers final checkpoint writes + DB overhead.
 *  At 300s cap this leaves 270s usable; at the graceful exit point (200s)
 *  there's 100s of headroom for post-extraction work. */
export const PLATFORM_HEADROOM_MS = 30_000;

// ===========================================================================
// Derived Time Budgets (all flow from PLATFORM_CAP_MS)
// ===========================================================================

/** Pipeline's own graceful exit point — derived from effective cap.
 *  100s headroom: enough for post-extraction work (DB writes, checkpoint saves)
 *  even in worst-case paths. Floor of 120s prevents nonsensical sub-minute budgets. */
export const TIME_BUDGET_MS = Math.max(120_000, EFFECTIVE_CAP_MS - 100_000);

/** Minimum budget (ms) required to even attempt an LLM call.
 *  Below this, the call is virtually certain to timeout → wastes an attempt.
 *  Based on observed solo extraction times: median 40-60s, hard chunks 80-120s.
 *  60s gives a realistic shot at success for most chunks. */
export const MIN_VIABLE_LLM_BUDGET_MS = 60_000;

/** Reserve (ms) for post-batch work before the platform kills the invocation.
 *  Covers: N checkpoint DB writes (5-8s each under load) + heartbeat + return overhead.
 *  At MERGE_CONCURRENCY=5: 5 writes × 6s + heartbeat + serialization = ~35s. Rounded up.
 *  The batch-aware exit guard subtracts this from available time before launching work. */
export const CHECKPOINT_RESERVE_MS = 40_000;

/** Extraction phase's own budget (ms). At 300s cap this is 130s — leaves
 *  headroom for clean-parsed-text (Step 0.4), doc-tables (0.6), numeric-inline (0.7).
 *  Formula: effective_cap × 0.42 (rounded to nearest 10s). */
export const EXTRACTION_TIME_BUDGET_MS = Math.round((EFFECTIVE_CAP_MS * 0.42) / 10_000) * 10_000;

/** ResumeStalePipelines job budget (ms). Derived as effective cap minus headroom for
 *  DB writes after pipeline completes (same 30s). */
export const RESUME_JOB_TIME_BUDGET_MS = EFFECTIVE_CAP_MS - PLATFORM_HEADROOM_MS;

/** Staleness threshold (minutes) for the background sweeper.
 *  Must exceed the longest possible legitimate invocation so the sweeper never
 *  claims a still-running pipeline.
 *  Formula: ceil(effective_cap_in_minutes) + 2 (2 min grace for clock skew + DB latency). */
export const STALENESS_THRESHOLD_MINUTES = Math.ceil(EFFECTIVE_CAP_MS / 60_000) + 2; // 7 at 300s cap

// ===========================================================================
// Merge Tree Topology
// ===========================================================================

/** Merge tree fan-in: how many child nodes feed one parent node.
 *
 *  SINGLE SOURCE OF TRUTH. Every path that walks, builds, validates or resumes
 *  the merge tree MUST import this constant. Do not re-declare it locally.
 *
 *  ── Why 2 (2026-08-23) ────────────────────────────────────────────────────
 *  The live merge path (pipeline-core) and the publication gate
 *  (tree-completion-validator) have always used 2 — a binary tree. The round
 *  manifests written by real runs confirm it: run 13e9c0d6's eight round
 *  manifests all record group-size-2 math (round 6: groupCount=4 with 1
 *  singleton carry).
 *
 *  The recovery paths (resume-merge-recovery, adaptive-merge-recovery) had
 *  independently drifted to 4. That drift silently corrupted run 13e9c0d6:
 *  rebuilding L6:0 with fan-in 4 assigned it children L5:0–L5:3 instead of
 *  L5:0–L5:1, so it absorbed L6:1's rightful children. The result was a
 *  double-counted node (129 findings vs the ~50 its true children hold), an
 *  oversized L7:0, and a truncated L8:0 root that the Fix 25 gate correctly
 *  refused to publish. Four nodes had to be deleted and rebuilt.
 *
 *  A recovery path whose fan-in disagrees with the path that built the tree
 *  does not repair the tree — it rewrites it into a different, wrong shape.
 *  Hence: one constant, imported everywhere.
 *
 *  NOTE: validate-tree-root.ts is a known remaining exception. It still
 *  declares 4 locally because it also hardcodes a 4-level topology
 *  (expectedL1..expectedL4). Pointing it here without generalizing its level
 *  handling would make it silently ignore levels 5-8 on deeper trees, which is
 *  worse than its current state. Tracked separately. */
export const MERGE_GROUP_SIZE = 2;

// ===========================================================================
// Feature Flags (Stabilization Batch)
// ===========================================================================

/** Enable durable analysis workers (Commit 1).
 *  When true, new runs use lease-based work items instead of inline analysis loop.
 *  Existing in-progress runs without analysis_worker_enabled=true on their module_runs
 *  row continue on the legacy inline path. */
export const ANALYSIS_WORKER_ENABLED = true;

/** Worker batch size: chunks per invocation.
 *  Priority-weighted budget (Q2): analysis gets 130-140s, each call ~120s worst case.
 *  With ANALYSIS_CONCURRENCY=15 in legacy path, worker uses a bounded 8 to stay
 *  within lease timeout and allow concurrent workers. */
export const ANALYSIS_WORKER_BATCH_SIZE = 8;

// ===========================================================================
// contradiction_check Execution Path
// ===========================================================================

/** Which execution path contradiction_check takes.
 *
 *  ── History ───────────────────────────────────────────────────────────────
 *  P2.1 built the claims-reconciliation path (Step 0.8/0.8b of pipeline-core)
 *  and verified it in the harness, but never gave it a switch. Reconciliation
 *  ran *additively*: the merge tree executed in full, then reconciliation
 *  findings were appended on top at post-merge Stage 4
 *  (appendReconciliationFindings). Every production contradiction_check run
 *  therefore paid for hours of tree-reduce merging to produce findings that the
 *  code-verified reconciliation path derives deterministically in seconds.
 *
 *  ── "reconciliation" (default) ────────────────────────────────────────────
 *  Steps 1–5 of pipeline-core (routing, sub-agent analysis, tree-reduce merge,
 *  root assembly/promotion) are SKIPPED for contradiction_check. Reconciliation
 *  findings are the sole findings source. No merge_checkpoints rows are written.
 *  The publication gate — the only guard that requires a complete tree — is
 *  bypassed for this module on this path via the pre-existing
 *  bypassPublicationGate flag on FinalizerPrerequisites.
 *
 *  ── "merge_tree" ──────────────────────────────────────────────────────────
 *  Pre-P2.1-flip behaviour: full tree, reconciliation additive. Retained so the
 *  old path can be re-selected without reverting code.
 *
 *  SCOPE: read ONLY inside `moduleId === "contradiction_check"` guards. The
 *  other four tree modules (omission_audit, blind_spot_scanner,
 *  diligence_completeness, and the web-research module) never evaluate it and
 *  are structurally unaffected.
 *
 *  FROZEN: the merge tree constants (MERGE_GROUP_SIZE, MERGE_MAX_TOKENS,
 *  MERGE_NODE_TEXT_CAP) are unchanged — the tree is bypassed, not tuned. */
export const CONTRADICTION_CHECK_PATH: "reconciliation" | "merge_tree" = "reconciliation";

/** True when contradiction_check should bypass the merge tree.
 *  Callers MUST still gate on moduleId — this constant answers "which path",
 *  not "which module". */
export const CC_RECONCILIATION_PATH_ENABLED = CONTRADICTION_CHECK_PATH === "reconciliation";

/** How many ranked reconciliation findings the report presents in the main body.
 *
 *  PRESENTATION PARAMETER ONLY. Nothing is discarded: every finding is persisted
 *  in canonical_findings and rendered in the report appendix with its rank and
 *  score. This constant decides what *leads*, not what survives. */
export const RECONCILIATION_REPORT_TOP_N = 2;

// ===========================================================================
// Types (shared across pipeline files — lives here to avoid circular imports)
// ===========================================================================

/** Integration context required by the pipeline core */
export interface PipelineContext {
  integrations: {
    db: {
      query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
      execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<{ rowCount: number } | void>;
    };
    ai: {
      apiRequest: (req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>;
    };
  };
}
