/**
 * mast-stages.ts
 *
 * Stage registry for MAST v2 (Model Assumptions Stress Test).
 *
 * Re-exports the canonical types and constants from mast-contract.ts
 * (the leaf module) so existing importers keep working.
 *
 * Contains only the handler registry, stubs, and getStageHandler.
 *
 * MAST owns this registry end to end. No imports from OA, CC, BSS, ERO, or DCS.
 */

// ---------------------------------------------------------------------------
// Re-export all contract symbols so existing `from "./mast-stages.js"` work
// ---------------------------------------------------------------------------
export {
  STAGES,
  type StageName,
  LOOP_STAGES,
  STAGE_BUDGET_MS,
  type StageContext,
  type StageResult,
  type StageHandler,
} from "./mast-contract.js";

import type { StageName, StageContext, StageResult, StageHandler } from "./mast-contract.js";

// ---------------------------------------------------------------------------
// Handler imports — static top-level, no circular risk because handlers
// import from mast-contract.ts (the leaf), not from this file.
// ---------------------------------------------------------------------------
// Retained for possible reinstatement — currently not in STAGES.
import registerModelDrivers from "./mast-register-model-drivers.js";
// Retained for possible reinstatement — currently not in STAGES.
import registerSilent from "./mast-register-silent.js";
import registerMemo from "./mast-register-memo.js";
import registerAssemble from "./mast-register-assemble.js";
import relianceLinks from "./mast-reliance-links.js";
import inheritance from "./mast-inheritance.js";
// Retained for possible reinstatement — currently not in STAGES.
import emergent from "./mast-emergent.js";
// Retained for possible reinstatement — currently not in STAGES.
import propositionalize from "./mast-propositionalize.js";
import supportSearch from "./mast-support-search.js";
import forecastRecursion from "./mast-forecast-recursion.js";
import dependence from "./mast-dependence.js";
import severity from "./mast-severity.js";
import fragility from "./mast-fragility.js";
import synthesize from "./mast-synthesize.js";
import render from "./mast-render.js";

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


// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const HANDLER_MAP: Partial<Record<StageName, StageHandler>> = {
  // register_model_drivers, register_silent, propositionalize, emergent:
  // removed from STAGES — handlers retained in imports for reinstatement.
  register_memo: registerMemo,
  register_assemble: registerAssemble,
  reliance_links: relianceLinks,
  inheritance: inheritance,
  support_search: supportSearch,
  forecast_recursion: forecastRecursion,
  // lineage: removed — orchestrator auto-completes handler-less stages.
  dependence: dependence,
  severity: severity,
  fragility: fragility,
  synthesize: synthesize,
  render: render,
};

/** Look up the handler for a stage name. Returns undefined for stages with no handler (e.g. lineage). */
export function getStageHandler(stage: StageName): StageHandler | undefined {
  return HANDLER_MAP[stage];
}
