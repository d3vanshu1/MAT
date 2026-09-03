/**
 * mast-contract.ts
 *
 * Leaf module — imports nothing from any other MAST file.
 * Imports ONLY from pipeline-config.ts (which imports nothing from mast-*).
 *
 * Contains the canonical stage list, types, and constants shared across
 * the MAST pipeline. Extracted from mast-stages.ts to break the import
 * cycle between the stage registry and handler modules.
 */
import {
  EFFECTIVE_CAP_MS,
  PLATFORM_HEADROOM_MS,
  MIN_VIABLE_LLM_BUDGET_MS,
} from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Stage list — the canonical pipeline sequence
// ---------------------------------------------------------------------------

export const STAGES = [
  // register_model_drivers — removed: model-derived rows no longer enter the register.
  // register_silent — removed: same reason.
  "extract",
  // propositionalize — removed: rewrote model_explicit/model_implicit text; no model rows to rewrite.
  // register_memo, register_assemble — merged into extract.
  "sweep",
  // reliance_links, inheritance, support_search, forecast_recursion — merged into sweep.
  // emergent — removed: detects emergent properties from model_explicit drivers; no drivers.
  "lineage",
  "dependence",
  "severity",
  "fragility",
  "synthesize",
  "render",
] as const;

export type StageName = (typeof STAGES)[number];

/**
 * Stages that iterate per item and must resume mid-stage.
 * The orchestrator uses this to decide whether a "running" stage
 * should be re-entered rather than restarted.
 */
export const LOOP_STAGES: ReadonlySet<string> = new Set([
  // register_model_drivers — removed (see STAGES comment)
  // register_silent — removed (see STAGES comment)
  "extract",
  // register_memo, register_assemble — merged into extract.
  // propositionalize — removed (see STAGES comment)
  "sweep",
  // reliance_links, inheritance, support_search, forecast_recursion — merged into sweep.
  "lineage",
  "fragility",
  "synthesize",
]);

/**
 * Budget (ms) for loop stages — stop starting new items past this.
 *
 * Derivation:
 *   EFFECTIVE_CAP_MS          — platform hard-kill (300 000 ms at 5-min quota)
 * − PLATFORM_HEADROOM_MS      — safety buffer for checkpoint writes (30 000 ms)
 * − MIN_VIABLE_LLM_BUDGET_MS  — worst-case in-flight LLM call (60 000 ms)
 * = STAGE_BUDGET_MS            (210 000 ms at current cap)
 *
 * Why subtract MIN_VIABLE_LLM_BUDGET_MS: MAST stage handlers check elapsed
 * time BEFORE dispatching work but do not check remaining headroom once a
 * call is in flight. The budget must therefore leave room for one worst-case
 * LLM call that has already been dispatched when the budget check last passed.
 *
 * History: the previous value (55 000 ms) rested on a claim of a "120s
 * language-step platform kill." That 120s figure had no documented source;
 * it was confirmed fabricated on 2026-09-02. The actual platform cap is
 * 300s (pipeline-config.ts, sourced from Superblocks rate-limits docs).
 * BSS and ERO both use 240 000 ms against the same 300s cap.
 */
export const STAGE_BUDGET_MS = EFFECTIVE_CAP_MS - PLATFORM_HEADROOM_MS - MIN_VIABLE_LLM_BUDGET_MS;

console.log(
  `[MAST-CONTRACT] STAGE_BUDGET_MS=${STAGE_BUDGET_MS} ` +
  `(EFFECTIVE_CAP=${EFFECTIVE_CAP_MS} − HEADROOM=${PLATFORM_HEADROOM_MS} − LLM_RESERVE=${MIN_VIABLE_LLM_BUDGET_MS})`,
);

// ---------------------------------------------------------------------------
// Handler signature
// ---------------------------------------------------------------------------

/**
 * Every stage handler receives the same arguments and returns the same shape.
 * The orchestrator never inspects internals beyond this contract.
 */
export interface StageContext {
  db: {
    query: (sql: string, schema: any, params: unknown[], meta?: { label?: string }) => Promise<any[]>;
    execute: (sql: string, params: unknown[], meta?: { label?: string }) => Promise<any>;
  };
  /** Anthropic integration client — required for LLM stages. */
  ai: {
    apiRequest: (request: any, schemas: any, meta?: { label?: string }) => Promise<any>;
  };
  runId: string;
  dealId: string;
  resumePosition: number;
}

export interface StageResult {
  complete: boolean;
  itemsDone: number;
  itemsTotal: number;
  /** New resume_position to persist — only meaningful when complete is false. */
  resumePosition: number;
}

export type StageHandler = (ctx: StageContext) => Promise<StageResult>;
