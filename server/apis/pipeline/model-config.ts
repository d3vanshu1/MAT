/**
 * Model Configuration — single source of truth for all LLM model selection.
 *
 * Every file that picks a Claude model MUST import from here.
 * No hardcoded model strings elsewhere in the pipeline.
 */

// ---------------------------------------------------------------------------
// Model identifiers
// ---------------------------------------------------------------------------
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";
export const OPUS_MODEL = "claude-opus-4-7";

// ---------------------------------------------------------------------------
// Per-module model policy
// ---------------------------------------------------------------------------

/** Default model for extraction, sub-agent analysis, and merge — fast/cheap */
export const DEFAULT_MODEL = HAIKU_MODEL;

/**
 * Modules that use Sonnet for sub-agent analysis and merge.
 * These modules assert absence or require high-fidelity reasoning
 * where cheaper models produce unacceptable fabrication rates.
 */
export const SONNET_MODULES = new Set([
  "omission_audit",
  "blind_spot_scanner",
  // blind_spot_scanner_v2 registers here so its structural/thesis profile calls
  // resolve to Sonnet rather than silently falling through to DEFAULT_MODEL.
  // Parts 3 and 4 pass useOpus: true where generating failure modes from a bare
  // profile is the reasoning that warrants Opus; profile extraction does not.
  "blind_spot_scanner_v2",
  "diligence_completeness",
  // ic_challenge_mode synthesises IC questions in a single call over the full
  // memo corpus. Haiku produces generic, non-anchored questions at that context
  // size; the module's output is read directly by deal teams.
  "ic_challenge_mode",
]);

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Returns the appropriate model for a given module.
 * - useOpus=true → Opus (explicit user override)
 * - Module in SONNET_MODULES → Sonnet
 * - Otherwise → Haiku (default)
 */
export function getModuleModel(moduleId: string, useOpus?: boolean | null): string {
  if (useOpus) return OPUS_MODEL;
  return SONNET_MODULES.has(moduleId) ? SONNET_MODEL : DEFAULT_MODEL;
}
