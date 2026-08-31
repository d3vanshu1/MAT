/**
 * mast-stages.ts
 *
 * Canonical stage registry for MAST v2 (Model Assumptions Stress Test).
 *
 * Every stage handler shares one signature so that later packets swap a stub
 * for a real implementation without changing the orchestrator.
 *
 * MAST owns this registry end to end. No imports from OA, CC, BSS, ERO, or DCS.
 */

// ---------------------------------------------------------------------------
// Stage list — the canonical pipeline sequence
// ---------------------------------------------------------------------------

export const STAGES = [
  "register_model_drivers",
  "register_silent",
  "register_memo",
  "register_assemble",
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
  "inheritance",
  "support_search",
  "forecast_recursion",
  "lineage",
  "fragility",
]);

/**
 * Budget (ms) for loop stages — stop starting new items past this.
 * 180s gives a 120s margin before the 300s platform kill.
 */
export const STAGE_BUDGET_MS = 180_000;

// ---------------------------------------------------------------------------
// Handler signature
// ---------------------------------------------------------------------------

/**
 * Every stage handler receives the same arguments and returns the same shape.
 * The orchestrator never inspects internals beyond this contract.
 */
export interface StageContext {
  db: {
    query: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]>;
    execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any>;
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

// ---------------------------------------------------------------------------
// Stub handlers
// ---------------------------------------------------------------------------

/**
 * Single-shot stub: returns immediately, reports 0 items, complete.
 * Used for stages that are NOT in LOOP_STAGES.
 */
function singleShotStub(_ctx: StageContext): Promise<StageResult> {
  // STUB — replaced in a later packet
  return Promise.resolve({
    complete: true,
    itemsDone: 0,
    itemsTotal: 0,
    resumePosition: 0,
  });
}

/**
 * Loop stub: simulates a worklist of 5 items, processes exactly 2 per
 * invocation, advances resume_position by 2, and reports complete only
 * when resume_position reaches 5.
 *
 * This exercises the resume path so that the orchestrator's partial-stage
 * logic is proven, not assumed.
 */
function loopStub(ctx: StageContext): Promise<StageResult> {
  // STUB — replaced in a later packet
  const WORKLIST_SIZE = 5;
  const BATCH_SIZE = 2;

  const pos = ctx.resumePosition;
  const newPos = Math.min(pos + BATCH_SIZE, WORKLIST_SIZE);
  const complete = newPos >= WORKLIST_SIZE;

  return Promise.resolve({
    complete,
    itemsDone: newPos,
    itemsTotal: WORKLIST_SIZE,
    resumePosition: newPos,
  });
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/**
 * Real handler imports are late-bound to avoid circular initialization.
 * Stage handler modules import types from this file, so a top-level import
 * here would create a TDZ reference error.
 */
let _realHandlersLoaded = false;
const HANDLER_MAP: Record<StageName, StageHandler> = {
  register_model_drivers: singleShotStub, // replaced at first lookup
  register_silent: singleShotStub,
  register_memo: singleShotStub,
  register_assemble: singleShotStub,
  reliance_links: singleShotStub,
  inheritance: loopStub,
  emergent: singleShotStub,
  support_search: loopStub,
  forecast_recursion: loopStub,
  lineage: loopStub,
  dependence: singleShotStub,
  severity: singleShotStub,
  fragility: loopStub,
  render: singleShotStub,
};

function loadRealHandlers(): void {
  if (_realHandlersLoaded) return;
  _realHandlersLoaded = true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: registerModelDrivers } = require("./mast-register-model-drivers.js");
  HANDLER_MAP.register_model_drivers = registerModelDrivers;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: registerSilent } = require("./mast-register-silent.js");
  HANDLER_MAP.register_silent = registerSilent;
}

/** Look up the handler for a stage name. */
export function getStageHandler(stage: StageName): StageHandler {
  loadRealHandlers();
  return HANDLER_MAP[stage];
}
