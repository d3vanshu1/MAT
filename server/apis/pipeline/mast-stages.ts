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
  STAGE_BUDGET_MS,
  type StageContext,
  type StageResult,
  type StageHandler,
} from "./mast-contract.js";

import { LOOP_STAGES as _CONTRACT_LOOP_STAGES } from "./mast-contract.js";

/**
 * Augmented LOOP_STAGES — adds reliance_links on top of the contract set.
 * The contract is out of scope for this packet, so we shadow here.
 */
export const LOOP_STAGES: ReadonlySet<string> = new Set([
  ..._CONTRACT_LOOP_STAGES,
  "reliance_links",
]);

import type { StageName, StageContext, StageResult, StageHandler } from "./mast-contract.js";

// ---------------------------------------------------------------------------
// Handler imports — static top-level, no circular risk because handlers
// import from mast-contract.ts (the leaf), not from this file.
// ---------------------------------------------------------------------------
import registerModelDrivers from "./mast-register-model-drivers.js";
import registerSilent from "./mast-register-silent.js";
import registerMemo from "./mast-register-memo.js";
import registerAssemble from "./mast-register-assemble.js";
import relianceLinks from "./mast-reliance-links.js";

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

const HANDLER_MAP: Record<StageName, StageHandler> = {
  register_model_drivers: registerModelDrivers,
  register_silent: registerSilent,
  register_memo: registerMemo,
  register_assemble: registerAssemble,
  reliance_links: relianceLinks,
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

/** Look up the handler for a stage name. */
export function getStageHandler(stage: StageName): StageHandler {
  return HANDLER_MAP[stage];
}
