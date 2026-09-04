/**
 * SRI v2 — Stage contract
 *
 * Declares the ordered stage sequence, wall-clock budget, and the
 * handler / result types used by the SRI orchestrator.
 */

// ── Stage sequence (order matters) ──────────────────────────────────
export const SRI_STAGES = [
  "build_entity_manifest",
  "build_claim_register",
  "plan_research",
  "research_execution",
  "adjudicate_findings",
  "claim_confrontation",
  "render",
] as const;

export type SriStageName = (typeof SRI_STAGES)[number];

// ── Wall-clock budget per invocation ────────────────────────────────
export const STAGE_BUDGET_MS = 240_000;

// ── Stage handler result ────────────────────────────────────────────
export type StageResult = {
  stage: string;
  status: "complete" | "in_progress" | "not_implemented" | "failed";
  message: string;
  /** Opaque stage-specific payload forwarded to the caller. */
  stageData?: Record<string, unknown>;
};

// ── Stage handler signature ─────────────────────────────────────────
// `ctx` is intentionally `any` so callers don't need to import the
// full SDK context type — the orchestrator passes its own `ctx` through.
export type StageHandler = (
  ctx: any,
  runId: string,
  dealId: string,
) => Promise<StageResult>;
