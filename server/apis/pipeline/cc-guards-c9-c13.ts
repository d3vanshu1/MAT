/**
 * CC Guards C9–C13
 *
 * C9  — Double-read: model-side verify table join + memo-side snippet re-parse
 * C11 — One claim per metric+unit: split abs+pct, reject conflicts, reject dual currency
 * C12 — Approximation bands: model-side decimals, interval arithmetic
 * C13 — Case/basis enforcement on adjusted metrics
 *
 * C10 is verify-only (cell_ref on findings, no row_idx in output).
 *
 * All guards are pure functions — no DB, no LLM, no side-effects.
 */

import type { ReconciliationFinding } from "./claims-reconciliation.js";
import type { Claim } from "./claims-extraction.js";
import { detectStatedPrecision } from "./comparability-gate.js";

// ═══════════════════════════════════════════════════════════════════════════
// C9 — Double-Read Guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verification record from workbook_cells_verify — the second-parse values.
 */
export interface VerifyCell {
  sheet_name: string;
  cell_ref: string;
  value_num_v2: number | null;
  value_raw_v2: string | null;
}

/**
 * C9 mismatch record — logged when the two parsers disagree.
 */
export interface C9Mismatch {
  cellRef: string;
  sheet: string;
  /** value from the primary map (workbook_cells.value_num) */
  primaryValue: number | null;
  /** value from the verification table (workbook_cells_verify.value_num_v2) */
  verifyValue: number | null;
  side: "model" | "memo";
  reason: string;
}

/**
 * C9 result for a set of findings.
 */
export interface C9Result {
  passed: ReconciliationFinding[];
  dropped: ReconciliationFinding[];
  mismatches: C9Mismatch[];
}

/**
 * Build a lookup key for the verify table.
 */
function verifyKey(sheet: string, cellRef: string): string {
  return `${sheet}\0${cellRef}`;
}

/**
 * C9 Model-side: compare workbook_cells.value_num vs workbook_cells_verify.value_num_v2.
 * Exact match. No tolerance, no fuzzy compare.
 * A cell present in the map but missing from the verification table is a mismatch.
 */
export function runC9DoubleRead(
  findings: ReconciliationFinding[],
  verifyRows: VerifyCell[],
): C9Result {
  // Build verify lookup
  const verifyMap = new Map<string, VerifyCell>();
  for (const v of verifyRows) {
    verifyMap.set(verifyKey(v.sheet_name, v.cell_ref), v);
  }

  const passed: ReconciliationFinding[] = [];
  const dropped: ReconciliationFinding[] = [];
  const mismatches: C9Mismatch[] = [];

  for (const f of findings) {
    const checks: C9Mismatch[] = [];

    // --- Model-side double-read ---
    if (f.model_figure) {
      const sheet = f.model_figure.source_sheet;
      const cellRef = f.model_figure.cell_ref;
      const primaryVal = f.model_figure.value_raw ?? f.model_figure.value;

      if (sheet && cellRef) {
        const vr = verifyMap.get(verifyKey(sheet, cellRef));
        if (!vr) {
          checks.push({
            cellRef: cellRef,
            sheet,
            primaryValue: primaryVal,
            verifyValue: null,
            side: "model",
            reason: "cell absent from verification table",
          });
        } else if (vr.value_num_v2 !== null && primaryVal !== null) {
          // Exact numeric compare (both as numbers)
          const p = typeof primaryVal === "number" ? primaryVal : parseFloat(String(primaryVal));
          const v = vr.value_num_v2;
          if (!isNaN(p) && !isNaN(v) && p !== v) {
            checks.push({
              cellRef: cellRef,
              sheet,
              primaryValue: p,
              verifyValue: v,
              side: "model",
              reason: `primary=${p}, verify=${v}`,
            });
          }
        }
      }
    }

    // --- Memo-side: snippet contains its own cited number ---
    if (f.claim) {
      const snippet = f.claim.verbatim_snippet ?? "";
      const claimValue = f.claim.value;
      if (snippet.length > 0 && claimValue !== null && claimValue !== undefined) {
        // The snippet should contain the cited number.
        // Normalise: 38.2 should match "38.2", "$38.2m", "38.2%", etc.
        const absStr = Math.abs(claimValue).toString();
        // Also check common display forms
        const displayForms = [absStr];
        // Add comma-separated form (e.g. 1,234 for 1234)
        if (Math.abs(claimValue) >= 1000) {
          displayForms.push(Math.abs(claimValue).toLocaleString("en-US"));
        }
        // Check if any form appears in snippet
        const snippetClean = snippet.replace(/\s/g, "");
        const found = displayForms.some(form =>
          snippetClean.includes(form) || snippet.includes(form)
        );
        if (!found) {
          checks.push({
            cellRef: "",
            sheet: "",
            primaryValue: claimValue,
            verifyValue: null,
            side: "memo",
            reason: `snippet does not contain cited value ${claimValue}: "${snippet.slice(0, 80)}"`,
          });
        }
      }
    }

    if (checks.length > 0) {
      dropped.push(f);
      mismatches.push(...checks);
    } else {
      passed.push(f);
    }
  }

  return { passed, dropped, mismatches };
}

/**
 * Recompute delta from the two verified values.
 * Every number a finding cites — both sides, including the difference —
 * recomputes from the two verified values rather than being carried through.
 */
export function recomputeDelta(
  finding: ReconciliationFinding,
): ReconciliationFinding {
  if (!finding.claim || !finding.model_figure) return finding;

  const claimVal = finding.claim.value;
  const modelVal = finding.model_figure.value;

  if (claimVal === null || claimVal === undefined || modelVal === null || modelVal === undefined) {
    return finding;
  }

  const deltaAbs = Math.abs(claimVal - modelVal);
  const deltaPct = modelVal !== 0 ? ((claimVal - modelVal) / Math.abs(modelVal)) * 100 : null;

  return {
    ...finding,
    delta_abs: deltaAbs,
    delta_pct: deltaPct,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// C11 — One Claim Per Metric and Unit
// ═══════════════════════════════════════════════════════════════════════════

/**
 * C11 rejection record.
 */
export interface C11Rejection {
  claim: Claim;
  reason: "label_unit_conflict" | "dual_currency" | "split_abs_pct";
  detail: string;
}

/**
 * C11 result.
 */
export interface C11Result {
  /** Claims that passed validation (may include split claims) */
  passed: Claim[];
  /** Claims that were rejected */
  rejected: C11Rejection[];
  /** Claims that were split (abs + pct from one sentence) */
  splits: number;
}

const CURRENCY_SYMBOLS = /[$£€¥₹₩₽₺₴₸₹₪₫₮₲₵₡₢₣₤₥₦₧₨₩₱₲₳₴₵]/g;
const CURRENCY_CODES = /\b(USD|GBP|EUR|JPY|CNY|INR|AUD|CAD|CHF|HKD|SGD|NZD|SEK|NOK|DKK|KRW|BRL|ZAR|MXN|PLN|CZK|HUF|TRY|THB|IDR|MYR|PHP|VND|TWD|ARS|CLP|COP|PEN|ILS|AED|SAR|QAR|KWD|BHD|OMR|EGP|NGN|KES|GHS|TZS|UGX|MAD|TND|LKR|PKR|BDT|MMK|KHR|LAK|NPR)\b/g;

/**
 * Detect if a claim's label implies a unit that conflicts with its value's unit.
 * E.g. a claim labelled "revenue growth" (implies %) but holding a currency value.
 */
function hasLabelUnitConflict(claim: Claim): boolean {
  const label = (claim.basis_note ?? "").toLowerCase();
  const unit = claim.unit;

  // Label implies percentage but value is currency
  const pctLabels = /\bgrowth\s+rate\b|\bcagr\b|\bmargin\b|\byoy\b|\bgrowth\b.*%|\bpercent/;
  if (pctLabels.test(label) && (unit === "£m" || unit === "£k" || unit === "£" || unit === "other")) {
    return true;
  }

  // Label implies currency but value is percentage
  const currLabels = /\brevenue\b|\bebitda\b|\bcash\s+flow\b|\bnet\s+income\b|\bcapex\b|\bcost\b|\bdebt\b/;
  if (currLabels.test(label) && unit === "%") {
    // Exception: "revenue margin" or "ebitda margin" IS a percentage
    if (/margin|ratio|yield|rate|percent/.test(label)) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Detect if a claim contains two different currency symbols.
 */
function hasDualCurrency(claim: Claim): boolean {
  const snippet = claim.verbatim_snippet ?? "";
  const symbols = new Set((snippet.match(CURRENCY_SYMBOLS) || []).map(s => s));
  const codes = new Set((snippet.match(CURRENCY_CODES) || []).map(s => s.toUpperCase()));

  // Map symbols to code families
  const families = new Set<string>();
  for (const s of symbols) {
    if (s === "$") families.add("USD_FAMILY"); // Could be AUD/CAD/etc but same symbol
    else if (s === "£") families.add("GBP");
    else if (s === "€") families.add("EUR");
    else if (s === "¥") families.add("JPY_FAMILY");
    else families.add(s);
  }
  for (const c of codes) {
    if (["USD", "AUD", "CAD", "NZD", "SGD", "HKD"].includes(c)) families.add("USD_FAMILY");
    else if (c === "GBP") families.add("GBP");
    else if (c === "EUR") families.add("EUR");
    else if (["JPY", "CNY"].includes(c)) families.add("JPY_FAMILY");
    else families.add(c);
  }

  return families.size > 1;
}

/**
 * Run C11 validation on a set of claims.
 * - Rejects claims with label/unit conflicts
 * - Rejects claims with dual currency symbols
 * - (Split detection is informational — the extraction prompt should handle splitting)
 */
export function runC11ClaimValidation(claims: Claim[]): C11Result {
  const passed: Claim[] = [];
  const rejected: C11Rejection[] = [];
  let splits = 0;

  for (const claim of claims) {
    // Check 1: Label/unit conflict
    if (hasLabelUnitConflict(claim)) {
      rejected.push({
        claim,
        reason: "label_unit_conflict",
        detail: `label "${claim.basis_note}" conflicts with unit "${claim.unit}"`,
      });
      continue;
    }

    // Check 2: Dual currency symbols
    if (hasDualCurrency(claim)) {
      rejected.push({
        claim,
        reason: "dual_currency",
        detail: `snippet contains multiple currency symbols: "${(claim.verbatim_snippet ?? "").slice(0, 80)}"`,
      });
      continue;
    }

    passed.push(claim);
  }

  return { passed, rejected, splits };
}


// ═══════════════════════════════════════════════════════════════════════════
// C12 — Approximation Bands
// ═══════════════════════════════════════════════════════════════════════════

/**
 * C12 result for a finding — precision-aware delta.
 */
export interface C12BandedDelta {
  /** Original delta_abs */
  rawDeltaAbs: number;
  /** Claim-side precision band from stated_precision */
  claimBand: number;
  /** Model-side precision band from cell decimals / format */
  modelBand: number;
  /** Combined band (max of both) */
  combinedBand: number;
  /** Minimum possible delta (delta - combined band, floored at 0) */
  minDelta: number;
  /** Maximum possible delta (delta + combined band) */
  maxDelta: number;
  /** Whether the claim used approximate language */
  isApproximate: boolean;
  /** Whether the model value is formatted to fewer decimals than the difference */
  modelPrecisionLimited: boolean;
}

/**
 * Compute the precision band from the model side.
 * A cell formatted to 0 decimal places has precision ± 0.5.
 * A cell formatted to 1 decimal place has precision ± 0.05.
 *
 * Scale matters: if the cell is in thousands (scale=1000) and formatted to 1 decimal,
 * the precision is ± 50 (0.05 * 1000).
 */
export function modelPrecisionBand(
  decimals: number | null | undefined,
  scaleMultiplier: number,
): number {
  if (decimals === null || decimals === undefined || decimals < 0) {
    return 0; // No format info — no band, not a guess
  }
  // Precision = 0.5 * 10^(-decimals) * scale
  return 0.5 * Math.pow(10, -decimals) * scaleMultiplier;
}

/**
 * Compute banded delta for a finding.
 * Returns null if the finding doesn't have the required fields.
 */
export function computeBandedDelta(
  finding: ReconciliationFinding,
): C12BandedDelta | null {
  if (!finding.claim || !finding.model_figure) return null;
  if (finding.delta_abs === null || finding.delta_abs === undefined) return null;

  const snippet = finding.claim.verbatim_snippet ?? "";
  const claimValue = finding.claim.value;
  const { isApproximate, band: claimBand } = detectStatedPrecision(snippet, claimValue);

  // Model-side precision from decimals + scale
  const modelDecimals = (finding.model_figure as any).decimals ?? null;
  const modelScale = parseFloat(String((finding.model_figure as any).scale ?? "1")) || 1;
  const modelBand = modelPrecisionBand(modelDecimals, modelScale);

  const modelPrecisionLimited = modelBand > 0 && modelBand >= finding.delta_abs * 0.1;

  // Combined band: max of both (conservative — either side's imprecision)
  const combinedBand = Math.max(claimBand, modelBand);
  const minDelta = Math.max(0, finding.delta_abs - combinedBand);
  const maxDelta = finding.delta_abs + combinedBand;

  return {
    rawDeltaAbs: finding.delta_abs,
    claimBand,
    modelBand,
    combinedBand,
    minDelta,
    maxDelta,
    isApproximate,
    modelPrecisionLimited,
  };
}

/**
 * C12: A finding clears materiality only if the ENTIRE band clears it.
 * A band straddling the threshold does not publish.
 */
export function bandClearsMateriality(
  banded: C12BandedDelta,
  materialityFloor: number,
): boolean {
  // The ENTIRE band must clear: even the minimum possible delta must exceed the floor
  return banded.minDelta >= materialityFloor;
}

/**
 * Format a banded delta for display in the difference field.
 * "~$38m" with delta 1.2 and band 0.5 → "0.7–1.7"
 */
export function formatBandedDelta(
  banded: C12BandedDelta,
  unit: string,
): string {
  if (banded.combinedBand === 0) {
    // No approximation — return exact delta
    return formatNumber(banded.rawDeltaAbs, unit);
  }
  return `${formatNumber(banded.minDelta, unit)}–${formatNumber(banded.maxDelta, unit)}`;
}

function formatNumber(n: number, unit: string): string {
  if (unit === "%" || unit === "bps") {
    return `${n.toFixed(1)}${unit === "%" ? "pp" : "bps"}`;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(1);
}


// ═══════════════════════════════════════════════════════════════════════════
// C13 — Declare Case and Basis on Both Sides
// ═══════════════════════════════════════════════════════════════════════════

/**
 * C13 outcome for a finding.
 */
export type C13Outcome =
  | "pass"                     // both sides have case, they match
  | "basis_not_stated"         // one or both sides can't identify case → coverage, not finding
  | "different_basis"          // both identified, they differ → "appears to be on a different basis"
  | "case_ambiguous"           // model has multiple candidates, can't pick one → doesn't publish
  | "error_unit_mismatch";     // claim/cell unit mismatch reached here → error, not publish

/**
 * C13 result for a finding.
 */
export interface C13Result {
  outcome: C13Outcome;
  /** The active case label from the workbook switch, if known */
  activeCaseLabel: string | null;
  /** The case used on the model side, if resolved */
  modelCase: string | null;
  /** The case/basis from the claim side */
  claimBasis: string | null;
  /** Reason detail for non-pass outcomes */
  detail: string | null;
}

/** Patterns indicating an adjusted/normalised/pro-forma metric */
const ADJUSTED_PATTERNS = /\b(adj(?:usted)?|normalise?d|pro.?forma|run.?rate|organic|underlying|like.?for.?like|lfl)\b/i;

/**
 * Check if a metric is "adjusted" — meaning case and basis matter.
 */
export function isAdjustedMetric(claim: Claim): boolean {
  const text = [
    claim.basis_note ?? "",
    claim.scope_qualifier ?? "",
    claim.basis ?? "",
  ].join(" ").toLowerCase();

  return ADJUSTED_PATTERNS.test(text);
}

/**
 * Run C13 case/basis enforcement on a finding.
 *
 * Rules:
 * 1. Require case and basis on both sides of any adjusted metric.
 * 2. Where model has multiple candidate cases and can't pick one → doesn't publish.
 * 3. If either side's case can't be identified → route to coverage as "basis not stated".
 * 4. Where both identified and differ → "appears to be on a different basis".
 * 5. A case-dependent finding states the active case from the switch, not the column label.
 */
export function runC13CaseEnforcement(
  finding: ReconciliationFinding,
  activeCaseLabel: string | null,
): C13Result {
  if (!finding.claim || !finding.model_figure) {
    return { outcome: "pass", activeCaseLabel, modelCase: null, claimBasis: null, detail: null };
  }

  // Only enforce on adjusted metrics
  if (!isAdjustedMetric(finding.claim)) {
    return { outcome: "pass", activeCaseLabel, modelCase: null, claimBasis: null, detail: null };
  }

  // Claim-side case/basis
  const claimBasis = finding.claim.basis ?? finding.claim.scenario ?? null;

  // Model-side case from the figure
  const modelFig = finding.model_figure as any;
  const modelCase = modelFig.case_label ?? modelFig.case_key ?? null;

  // Rule 1: If either side's case can't be identified → coverage, not finding
  if (!claimBasis && !modelCase) {
    return {
      outcome: "basis_not_stated",
      activeCaseLabel,
      modelCase: null,
      claimBasis: null,
      detail: "Neither memo nor model state their case/basis for this adjusted metric",
    };
  }
  if (!claimBasis) {
    return {
      outcome: "basis_not_stated",
      activeCaseLabel,
      modelCase,
      claimBasis: null,
      detail: "Memo does not state basis for this adjusted metric",
    };
  }
  if (!modelCase) {
    // Model case unknown — but we may have the active case from the switch
    if (activeCaseLabel) {
      // Use the active case, but note it's from the switch, not the column
      return {
        outcome: "pass",
        activeCaseLabel,
        modelCase: activeCaseLabel,
        claimBasis,
        detail: `Model case from workbook switch: ${activeCaseLabel}`,
      };
    }
    return {
      outcome: "basis_not_stated",
      activeCaseLabel: null,
      modelCase: null,
      claimBasis,
      detail: "Model does not identify case for this adjusted metric and no switch cell found",
    };
  }

  // Both sides have case — check if they match
  const claimNorm = claimBasis.toLowerCase().trim();
  const modelNorm = modelCase.toLowerCase().trim();

  if (claimNorm === modelNorm) {
    return {
      outcome: "pass",
      activeCaseLabel,
      modelCase,
      claimBasis,
      detail: null,
    };
  }

  // Check if the active case resolves the model side differently
  if (activeCaseLabel) {
    const activeNorm = activeCaseLabel.toLowerCase().trim();
    if (claimNorm === activeNorm || activeNorm.includes(claimNorm) || claimNorm.includes(activeNorm)) {
      return {
        outcome: "pass",
        activeCaseLabel,
        modelCase: activeCaseLabel,
        claimBasis,
        detail: `Model case resolved from workbook switch (${activeCaseLabel}) matches claim basis`,
      };
    }
  }

  // Both identified, they differ — basis question, not an error
  return {
    outcome: "different_basis",
    activeCaseLabel,
    modelCase,
    claimBasis,
    detail: `Memo basis "${claimBasis}" appears to be on a different basis than model case "${modelCase}"`,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// Severity — Chain Position Replaces Dollar Floor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Chain state for a model figure.
 * Three states, not two. chain_break_reason distinguishes them.
 */
export type ChainState =
  | "reaches_anchor"       // established as feeding entry value or returns
  | "hardcoded_leaf"       // chain legitimately ends at a typed assumption
  | "runtime_indirect"     // can't see through it — unknown
  | "unknown";             // no chain data available

/**
 * Derive chain state from figure properties.
 */
export function deriveChainState(figure: {
  feedsEntryValue?: boolean | null;
  feedsReturns?: boolean | null;
  chainBreakReason?: string | null;
  distanceToAnchor?: number | null;
}): ChainState {
  if (figure.feedsEntryValue || figure.feedsReturns) {
    return "reaches_anchor";
  }
  if (figure.chainBreakReason === "hardcoded_leaf") {
    return "hardcoded_leaf";
  }
  if (figure.chainBreakReason === "runtime_indirect") {
    return "runtime_indirect";
  }
  // No chain data — treat as unknown
  return "unknown";
}

/**
 * Assess severity from chain position.
 * Replaces the fixed dollar materiality floor.
 *
 * | State              | Implication                                              |
 * |--------------------|----------------------------------------------------------|
 * | reaches_anchor     | Gap in a figure feeding entry value → price question     |
 * | hardcoded_leaf     | Chain ends at a typed assumption → presentation question |
 * | runtime_indirect   | Can't see through it → unknown, say so                   |
 * | unknown            | No chain data → use existing severity unchanged          |
 */
export function assessSeverityFromChain(
  chainState: ChainState,
  distanceToAnchor: number | null,
  deltaAbs: number | null,
): "critical" | "warning" | "info" {
  if (chainState === "reaches_anchor") {
    // Close to anchor (distance 0-2) and non-trivial delta → critical
    if (distanceToAnchor !== null && distanceToAnchor <= 2 && deltaAbs !== null && deltaAbs > 0) {
      return "critical";
    }
    // Further from anchor but still feeds it → warning
    return "warning";
  }

  if (chainState === "hardcoded_leaf") {
    // Terminal assumption — presentation question
    return "info";
  }

  if (chainState === "runtime_indirect") {
    // Can't see through → warning (not info, because unknown is not safe)
    return "warning";
  }

  // Unknown chain — fallback, do not change severity
  return "warning";
}

/**
 * Build severity.basis string for the run log (never the report).
 */
export function buildSeverityBasis(
  chainState: ChainState,
  distanceToAnchor: number | null,
  activeCaseLabel: string | null,
): string {
  const parts: string[] = [`chain_state=${chainState}`];
  if (distanceToAnchor !== null) parts.push(`distance=${distanceToAnchor}`);
  if (activeCaseLabel) parts.push(`active_case=${activeCaseLabel}`);
  return parts.join("; ");
}
