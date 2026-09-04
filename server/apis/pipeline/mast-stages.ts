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
// Retained for possible reinstatement — currently merged into extract.
import extract from "./mast-extract.js";
// Retained for possible reinstatement — currently merged into sweep.
import relianceLinks from "./mast-reliance-links.js";
// Retained for possible reinstatement — currently merged into sweep.
import inheritance from "./mast-inheritance.js";
// Retained for possible reinstatement — currently not in STAGES.
import emergent from "./mast-emergent.js";
// Retained for possible reinstatement — currently not in STAGES.
import propositionalize from "./mast-propositionalize.js";
// Retained for possible reinstatement — currently merged into sweep.
import supportSearch from "./mast-support-search.js";
// Retained for possible reinstatement — currently merged into sweep.
import forecastRecursion from "./mast-forecast-recursion.js";
import sweep from "./mast-sweep.js";
// Retained but no longer in STAGES — replaced by label.
import dependence from "./mast-dependence.js";
import label from "./mast-label.js";
import severity from "./mast-severity.js";
import fragility from "./mast-fragility.js";
import synthesize from "./mast-synthesize.js";
import render from "./mast-render.js";

// ---------------------------------------------------------------------------
// Stub handlers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const HANDLER_MAP: Partial<Record<StageName, StageHandler>> = {
  // register_model_drivers, register_silent, propositionalize, emergent:
  // removed from STAGES — handlers retained in imports for reinstatement.
  // register_memo, register_assemble: merged into extract.
  extract: extract,
  // reliance_links, inheritance, support_search, forecast_recursion: merged into sweep.
  sweep: sweep,
  // lineage: removed from STAGES — all reference docs are PDFs, drift detection is inert.
  // dependence: removed from STAGES — replaced by label. Handler retained on disk.
  label: label,
  severity: severity,
  fragility: fragility,
  synthesize: synthesize,
  render: render,
};

/** Look up the handler for a stage name. Returns undefined for stages with no handler (e.g. lineage). */
export function getStageHandler(stage: StageName): StageHandler | undefined {
  return HANDLER_MAP[stage];
}
