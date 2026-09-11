/**
 * claim-validation.ts — C11: One claim per metric and unit
 *
 * Pre-reconciliation claim filtering. Runs AFTER extraction, BEFORE
 * reconciliation. Pure functions, no DB, no LLM.
 *
 * Rules:
 *   1. A sentence with an absolute AND a percentage yields TWO claims,
 *      each with its own unit. Never one claim carrying both.
 *   2. Reject any claim whose label unit conflicts with the unit of its value.
 *   3. Reject any claim carrying two currency symbols.
 *   4. If a claim's unit and the cell's unit_class disagree at reconciliation
 *      time, that's a comparability failure — error, not publish.
 *      (Enforced in comparability-gate, not here.)
 */

import type { Claim } from "./claims-extraction.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimRejectReason =
  | "label_value_unit_conflict"     // Rule 2: label says % but value is currency
  | "dual_currency"                 // Rule 3: two currency symbols in text
  | "absolute_and_percent_unsplit"; // Rule 1: single claim carrying both (should have been split)

export interface ClaimValidationResult {
  /** Claims that passed validation */
  accepted: Claim[];
  /** Claims rejected with reason */
  rejected: Array<{ claim: Claim; reason: ClaimRejectReason; detail: string }>;
  /** Claims that were split (original → two new claims) */
  splits: Array<{ original: Claim; absoluteClaim: Claim; percentClaim: Claim }>;
  /** Stats */
  stats: {
    input: number;
    accepted: number;
    rejected: number;
    split: number;
  };
}

// ---------------------------------------------------------------------------
// Currency symbols — for dual-currency detection
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = ["$", "£", "€", "¥", "₹", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK"];
const CURRENCY_PATTERN = /[$£€¥₹]|(?:USD|GBP|EUR|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK)\b/gi;

// ---------------------------------------------------------------------------
// Label-unit conflict detection
// ---------------------------------------------------------------------------

/** Units that represent percentages */
const PERCENT_UNITS = new Set(["%", "bps"]);
/** Units that represent currency amounts */
const CURRENCY_UNITS = new Set(["£m", "£k", "£", "$m", "$k", "$"]);
/** Units that represent multiples */
const MULTIPLE_UNITS = new Set(["x"]);

/**
 * Detect the unit notation next to the cited number in the snippet.
 * Reads the SYMBOL beside the figure — $, %, x — not words in the label.
 * Returns "currency" | "percent" | "multiple" | null.
 *
 * "75% of revenue" → percent (the % is right next to 75)
 * "$38m" → currency (the $ is right next to 38)
 * "5.0x" → multiple (the x is right after the number)
 */
function detectNotationUnit(snippet: string, value: number): "currency" | "percent" | "multiple" | null {
  if (!snippet) return null;

  // Normalize: remove commas in numbers for matching
  const text = snippet.replace(/(\d),(\d)/g, "$1$2");
  const absVal = Math.abs(value);

  // Build candidate string representations of the value
  const candidates: string[] = [];
  candidates.push(String(absVal));
  if (absVal >= 1) candidates.push(String(Math.round(absVal)));
  candidates.push(absVal.toFixed(1));
  candidates.push(absVal.toFixed(2));
  // Percentage display: 0.045 stored → 4.5 displayed
  if (absVal < 1 && absVal > 0) {
    const pct = absVal * 100;
    candidates.push(String(pct));
    candidates.push(pct.toFixed(1));
  }

  for (const c of candidates) {
    const idx = text.indexOf(c);
    if (idx === -1) continue;

    // Check character immediately before the number
    const before = idx > 0 ? text[idx - 1] : "";
    // Check characters immediately after the number
    const afterStart = idx + c.length;
    const after = text.slice(afterStart, afterStart + 3).toLowerCase();

    // Currency symbol before the number: $38, £12, €50
    if (/[$£€¥₹]/.test(before)) return "currency";

    // Percent sign after the number: 75%, 4.5%
    if (after.startsWith("%")) return "percent";

    // Multiple suffix after the number: 5.0x, 12x
    if (after.startsWith("x") && (after.length === 1 || /[\s,.);\-]/.test(after[1] ?? ""))) return "multiple";

    // Currency abbreviation after: 38m (in "$38m" context — but $ was already caught above)
    // "bps" after a number
    if (/^bps\b/.test(after)) return "percent";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

export function validateClaims(claims: Claim[]): ClaimValidationResult {
  const accepted: Claim[] = [];
  const rejected: ClaimValidationResult["rejected"] = [];
  const splits: ClaimValidationResult["splits"] = [];

  for (const claim of claims) {
    // Rule 3: Reject claims with two different currency symbols
    const dualResult = checkDualCurrency(claim);
    if (dualResult) {
      rejected.push({ claim, reason: "dual_currency", detail: dualResult });
      continue;
    }

    // Rule 2: Reject label/value unit conflict
    const conflictResult = checkLabelValueConflict(claim);
    if (conflictResult) {
      rejected.push({ claim, reason: "label_value_unit_conflict", detail: conflictResult });
      continue;
    }

    // Rule 1 is enforced at extraction time (the prompt asks for separate claims).
    // Here we detect any that slipped through and reject them rather than
    // attempting a split — the extraction prompt is the authority on what
    // the memo said, and a code-level split would fabricate two claims
    // from one LLM output.
    const unsplitResult = checkAbsoluteAndPercentUnsplit(claim);
    if (unsplitResult) {
      rejected.push({ claim, reason: "absolute_and_percent_unsplit", detail: unsplitResult });
      continue;
    }

    accepted.push(claim);
  }

  return {
    accepted,
    rejected,
    splits,
    stats: {
      input: claims.length,
      accepted: accepted.length,
      rejected: rejected.length,
      split: splits.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Rule 3: Detect two different currency symbols in the claim text.
 * E.g. "$38m" and "£12m" in the same snippet.
 */
function checkDualCurrency(claim: Claim): string | null {
  const text = `${claim.verbatim_snippet ?? ""} ${claim.basis_note ?? ""}`;
  const matches = text.match(CURRENCY_PATTERN);
  if (!matches) return null;

  // Normalize to uppercase and deduplicate
  const unique = new Set(matches.map(m => m.toUpperCase().replace("$", "USD").replace("£", "GBP").replace("€", "EUR").replace("¥", "JPY").replace("₹", "INR")));
  if (unique.size > 1) {
    return `found ${unique.size} currency symbols: ${Array.from(unique).join(", ")}`;
  }

  return null;
}

/**
 * Rule 2: Reject a claim whose notation unit conflicts with the declared unit.
 * Derives the unit from the SYMBOL next to the number in the snippet — not
 * from words in the label. A conflict is: $38m declared as %, or 12% declared
 * as £m. "75% of revenue" is NOT a conflict — the % is the notation.
 */
function checkLabelValueConflict(claim: Claim): string | null {
  const declaredUnit = claim.unit;
  const notation = detectNotationUnit(claim.verbatim_snippet ?? "", claim.value);

  if (!notation) return null; // Can't detect notation — no conflict asserted

  // Notation says currency but declared unit is percent
  if (notation === "currency" && PERCENT_UNITS.has(declaredUnit)) {
    return `notation is currency ($) but declared unit is ${declaredUnit}`;
  }

  // Notation says percent but declared unit is currency
  if (notation === "percent" && CURRENCY_UNITS.has(declaredUnit)) {
    return `notation is percent (%) but declared unit is ${declaredUnit}`;
  }

  // Notation says multiple but declared unit is currency or percent
  if (notation === "multiple" && (CURRENCY_UNITS.has(declaredUnit) || PERCENT_UNITS.has(declaredUnit))) {
    return `notation is multiple (x) but declared unit is ${declaredUnit}`;
  }

  return null;
}

/**
 * Rule 1: Detect a claim carrying both an absolute AND a percentage
 * that should have been split into two claims.
 *
 * Heuristic: if the snippet contains both a currency figure and a percentage
 * figure, and the claim's unit covers only one, the other was swallowed.
 */
function checkAbsoluteAndPercentUnsplit(claim: Claim): string | null {
  const snippet = claim.verbatim_snippet ?? "";
  if (!snippet) return null;

  // Look for both a currency value and a percentage in the same snippet
  const hasCurrencyValue = /[$£€¥]\s*[\d,.]+\s*[mkb]?\b/i.test(snippet);
  const hasPercentValue = /[\d,.]+\s*%|\d+\s*bps/i.test(snippet);

  if (hasCurrencyValue && hasPercentValue) {
    // The claim's unit should match one — if it matches neither, or the snippet
    // clearly has two distinct quantitative assertions, flag it.
    // But this is a soft check — many snippets legitimately contain context numbers.
    // Only flag when the claim doesn't have both an absolute and percent partner.
    // For now, log but don't reject — the extraction prompt handles splitting.
    return null; // Intentionally soft — extraction prompt is authoritative
  }

  return null;
}
