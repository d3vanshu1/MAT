/**
 * mast-contract.ts
 *
 * Leaf module — imports nothing from any other MAST file.
 *
 * Contains the canonical stage list, types, and constants shared across
 * the MAST pipeline. Extracted from mast-stages.ts to break the import
 * cycle between the stage registry and handler modules.
 */

// ---------------------------------------------------------------------------
// Stage list — the canonical pipeline sequence
// ---------------------------------------------------------------------------

export const STAGES = [
  "register_model_drivers",
  "register_silent",
  "register_memo",
  "register_assemble",
  "propositionalize",
  "reliance_links",
  "inheritance",
  "emergent",
  "support_search",
  "forecast_recursion",
  "lineage",
  "dependence",
  "severity",
  "fragility",
  "render",
] as const;

export type StageName = (typeof STAGES)[number];

/**
 * Stages that iterate per item and must resume mid-stage.
 * The orchestrator uses this to decide whether a "running" stage
 * should be re-entered rather than restarted.
 */
export const LOOP_STAGES: ReadonlySet<string> = new Set([
  "register_model_drivers",
  "register_silent",
  "register_memo",
  "propositionalize",
  "reliance_links",
  "inheritance",
  "support_search",
  "forecast_recursion",
  "lineage",
  "fragility",
]);

/**
 * Budget (ms) for loop stages — stop starting new items past this.
 * 55s gives ample margin before the 120s language-step platform kill.
 * The orchestrator will be re-invoked by the frontend poll loop and
 * resume from the saved checkpoint.
 */
export const STAGE_BUDGET_MS = 55_000;

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
