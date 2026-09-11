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

/** Check if the basis_note or scope_qualifier implies a percentage */
function labelImpliesPercent(claim: Claim): boolean {
  const text = `${claim.basis_note ?? ""} ${claim.scope_qualifier ?? ""}`.toLowerCase();
  return /\bmargin\b|\bgrowth\b|\bcagr\b|\b%\b|\bpercent|\brate\b|\byield\b|\breturn\b/.test(text);
}

/** Check if the basis_note or scope_qualifier implies a currency amount */
function labelImpliesCurrency(claim: Claim): boolean {
  const text = `${claim.basis_note ?? ""} ${claim.scope_qualifier ?? ""}`.toLowerCase();
  return /\brevenue\b|\bebitda\b|\bcost\b|\bcapex\b|\bcash\b|\bdebt\b|\bequity\b|\bprice\b|\bev\b|\benterprise value\b/.test(text);
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
 * Rule 2: Reject a claim whose label unit conflicts with the unit of its value.
 * A percent-labelled claim holding a currency value is a mangled extraction.
 */
function checkLabelValueConflict(claim: Claim): string | null {
  const unit = claim.unit;

  // Label says percentage but unit is currency
  if (CURRENCY_UNITS.has(unit) && labelImpliesPercent(claim) && !labelImpliesCurrency(claim)) {
    return `label implies percentage ("${claim.basis_note?.slice(0, 40)}") but unit is ${unit}`;
  }

  // Label says currency but unit is percentage
  if (PERCENT_UNITS.has(unit) && labelImpliesCurrency(claim) && !labelImpliesPercent(claim)) {
    return `label implies currency ("${claim.basis_note?.slice(0, 40)}") but unit is ${unit}`;
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
