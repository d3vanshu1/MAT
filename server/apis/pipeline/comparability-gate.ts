/**
 * Comparability Gate — CC Pipeline Defect Packet D-02 through D-07, D-09, D-10.
 *
 * Implements the comparability contract (§4 of the defect packet):
 *   A pair is admitted only when every coordinate field is equal, or
 *   reconciled with the operation logged.
 *
 * Coordinate:
 *   metric · unit_class(denom) · scope{dimension, member} · period{type, start, end}
 *   basis · case · currency · scale
 *
 * Each guard emits a structured reason code (never free text), the fields
 * that matched, the fields that were reconciled, and a comparability confidence ∈[0,1].
 *
 * All guards are pure functions — no DB, no LLM, no side-effects.
 */

import type { Claim } from "./claims-extraction.js";
import type { Figure } from "./numeric-verify-inline.js";
import type { NormalizedFigure } from "./claims-reconciliation.js";

// ---------------------------------------------------------------------------
// Reason codes — enum, never free text (D-07)
// ---------------------------------------------------------------------------

export type ComparabilityReasonCode =
  | "unit_class_mismatch"       // D-02: per-unit vs aggregate, % vs currency
  | "denominator_mismatch"      // D-02 variant: per_site vs per_brand
  | "implausible_ratio"         // D-03: Δ% ≥ 95% AND ≥2 orders of magnitude apart
  | "period_mismatch"           // D-04: FY vs month, YTD vs FY, LTM vs CY
  | "frequency_mismatch"        // C1: incompatible frequencies (e.g. quarterly vs LTM)
  | "scope_mismatch"            // D-05: brand vs company total
  | "figure_fanout"             // D-06: one figure serving >1 claim with differing scope/period
  | "case_mismatch"             // D-09: management vs risk_adjusted vs base
  | "basis_mismatch"            // existing: reported vs PEP vs organic
  | "currency_mismatch";        // D-08: mismatched currency

// ---------------------------------------------------------------------------
// Frequency (C1) — month ↔ annual treated as a declared scale transform
// ---------------------------------------------------------------------------

export type Frequency = "month" | "quarter" | "year" | "ltm" | "unknown";

/** Detect frequency from a period string. */
export function detectFrequency(period: string): Frequency {
  if (!period) return "unknown";
  const p = period.toLowerCase().trim();
  // Monthly: Jan-26, 01/2026, Jan 2026, M1 2026
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[-\s]/i.test(p)) return "month";
  if (/^\d{2}\/\d{4}$/.test(p)) return "month";
  if (/\bm\d{1,2}\b/i.test(p)) return "month";
  // Quarterly: Q1 2026, 1Q26
  if (/\bq[1-4]\b/i.test(p) || /\b[1-4]q\d{2}\b/i.test(p)) return "quarter";
  // LTM / NTM / TTM
  if (/\b(ltm|ntm|ttm)\b/i.test(p)) return "ltm";
  // Annual: FY2026, 2026E, CY2026, 2026A
  if (/\b(fy|cy)?\d{4}[ea]?\b/i.test(p)) return "year";
  return "unknown";
}

/**
 * C1: Can two frequencies be compared?
 * - Same frequency: always compatible
 * - month ↔ year: compatible with ×12 or ÷12 scale transform, logged
 * - quarter ↔ year: compatible with ×4 or ÷4 scale transform, logged
 * - month ↔ quarter: compatible with ×3 or ÷3 scale transform, logged
 * - ltm ↔ year: compatible (LTM ≈ annual)
 * - unknown: compatible (don't block on missing data)
 */
export function frequenciesAreComparable(
  claimFreq: Frequency,
  figFreq: Frequency,
): { compatible: boolean; transform?: { op: string; factor: number } } {
  if (claimFreq === figFreq) return { compatible: true };
  if (claimFreq === "unknown" || figFreq === "unknown") return { compatible: true };
  // LTM ≈ year
  if ((claimFreq === "ltm" && figFreq === "year") || (claimFreq === "year" && figFreq === "ltm")) {
    return { compatible: true };
  }
  // month ↔ year
  if (claimFreq === "month" && figFreq === "year") return { compatible: true, transform: { op: "annualize", factor: 12 } };
  if (claimFreq === "year" && figFreq === "month") return { compatible: true, transform: { op: "monthize", factor: 1 / 12 } };
  // quarter ↔ year
  if (claimFreq === "quarter" && figFreq === "year") return { compatible: true, transform: { op: "annualize", factor: 4 } };
  if (claimFreq === "year" && figFreq === "quarter") return { compatible: true, transform: { op: "quarterize", factor: 1 / 4 } };
  // month ↔ quarter
  if (claimFreq === "month" && figFreq === "quarter") return { compatible: true, transform: { op: "quarterize", factor: 3 } };
  if (claimFreq === "quarter" && figFreq === "month") return { compatible: true, transform: { op: "monthize", factor: 1 / 3 } };
  // Incompatible (shouldn't normally reach here, but fail closed)
  return { compatible: false };
}

// ---------------------------------------------------------------------------
// 2.5: Approximation bands
// ---------------------------------------------------------------------------

/**
 * Detect stated precision from claim text.
 * Returns the precision band (± range) in the same units as the value.
 * "~$38M" → precision = 500_000 (±$0.5M for a value stated to nearest $M)
 * "approximately 12%" → precision = 0.005 (±0.5pp)
 */
export function detectStatedPrecision(
  verbatim: string,
  value: number,
): { isApproximate: boolean; band: number } {
  const text = (verbatim ?? "").toLowerCase();

  // Approximate markers
  const isApproximate = /~|approximately|about|circa|roughly|around|≈/.test(text);

  if (!isApproximate) {
    return { isApproximate: false, band: 0 };
  }

  // Determine precision from trailing zeros / rounding
  const absVal = Math.abs(value);
  let band: number;

  if (absVal >= 1_000_000) {
    // Stated in millions — ± $500k
    band = 500_000;
  } else if (absVal >= 1_000) {
    // Stated in thousands — ± $500
    band = 500;
  } else if (absVal >= 1) {
    // Stated in units — ± 0.5
    band = 0.5;
  } else {
    // Stated as a ratio/percentage — ± 0.005 (0.5pp)
    band = 0.005;
  }

  return { isApproximate, band };
}

/**
 * Check if a delta clears a materiality floor given approximation bands.
 * A finding clears the floor only if the ENTIRE band clears it.
 * Returns false if the band straddles the floor.
 */
export function bandedFloorClearance(
  deltaAbs: number,
  band: number,
  floor: number,
): boolean {
  // The minimum possible delta (conservative end of band)
  const minDelta = Math.max(0, deltaAbs - band);
  return minDelta >= floor;
}

// ---------------------------------------------------------------------------
// Ratio reconstruction
// ---------------------------------------------------------------------------

export type UnitClass =
  | "aggregate"            // absolute currency value (revenue, EBITDA, etc.)
  | "per_unit"             // per-site, per-customer, per-deal, etc.
  | "ratio"                // x multiple
  | "percent_of"           // % of something (margin, growth)
  | "count";               // headcount, sites, units

export interface UnitClassification {
  unit_class: UnitClass;
  /** For per_unit: what the denominator is (site, customer, brand, deal). Null otherwise. */
  denominator: string | null;
}

/**
 * Classify a claim's unit into a structured unit class.
 * Goes beyond the existing UnitFamily by detecting per-unit denominators.
 */
export function classifyClaimUnitClass(claim: Claim): UnitClassification {
  const unit = claim.unit.trim().toLowerCase();
  const scope = claim.scope_qualifier.toLowerCase();
  const basis = (claim.basis_note ?? "").toLowerCase();

  // Percentage / rate
  if (unit === "%" || unit === "bps" || unit === "pp") {
    return { unit_class: "percent_of", denominator: null };
  }

  // Multiple
  if (unit === "x") {
    return { unit_class: "ratio", denominator: null };
  }

  // Count
  if (unit === "other" && (basis.includes("headcount") || basis.includes("fte") ||
      basis.includes("# of") || basis.includes("number of"))) {
    return { unit_class: "count", denominator: null };
  }

  // Per-unit detection: look for "per site", "per customer", etc. in scope or basis
  const perUnitPattern = /\bper[- ](\w+)/i;
  const perMatch = scope.match(perUnitPattern) ?? basis.match(perUnitPattern);
  if (perMatch) {
    return { unit_class: "per_unit", denominator: perMatch[1].toLowerCase() };
  }

  // "avg" + denominator pattern: "avg EBITDA acquired per M&A deal"
  const avgPattern = /\bavg\b.*\bper[- ](\w+)/i;
  const avgMatch = basis.match(avgPattern);
  if (avgMatch) {
    return { unit_class: "per_unit", denominator: avgMatch[1].toLowerCase() };
  }

  // Currency absolutes
  if (unit === "£m" || unit === "£k" || unit === "£" || unit === "£bn" ||
      unit === "$m" || unit === "$k" || unit === "$" || unit === "$bn" ||
      unit === "€m" || unit === "€k" || unit === "€") {
    // Check if scope hints at per-unit
    if (/\bper[- ](site|office|location|screen|unit|customer|subscriber|account|brand)\b/i.test(scope) ||
        /\bper[- ](site|office|location|screen|unit|customer|subscriber|account|brand)\b/i.test(basis)) {
      const denom = (scope.match(/\bper[- ](\w+)/i) ?? basis.match(/\bper[- ](\w+)/i))?.[1]?.toLowerCase() ?? "unit";
      return { unit_class: "per_unit", denominator: denom };
    }
    return { unit_class: "aggregate", denominator: null };
  }

  // Default: aggregate (conservative — don't refuse matches on unknown unit)
  return { unit_class: "aggregate", denominator: null };
}

/**
 * Classify a model figure's unit class.
 */
export function classifyFigureUnitClass(fig: Figure, nf?: NormalizedFigure): UnitClassification {
  const label = fig.name.toLowerCase();

  // Rate indicators
  if (label.includes("margin") || label.includes("growth") || label.includes("%") ||
      label.includes("nrr") || label.includes("churn") || label.includes("retention") ||
      label.includes("conversion rate") || label.includes("yield")) {
    return { unit_class: "percent_of", denominator: null };
  }

  // Multiplier
  if (label.includes(" multiple") || label.includes(" x ") || label.includes("ev/") ||
      label.includes("turns")) {
    return { unit_class: "ratio", denominator: null };
  }

  // Headcount / count
  if (label.includes("headcount") || label.includes("fte") || label.includes("# of") ||
      label.includes("number of") || label.includes("sites") || label.includes("offices")) {
    return { unit_class: "count", denominator: null };
  }

  // Per-unit
  if (/\bper[- ](site|office|location|screen|unit|customer|subscriber|account|brand)\b/i.test(label)) {
    const denom = label.match(/\bper[- ](\w+)/i)?.[1]?.toLowerCase() ?? "unit";
    return { unit_class: "per_unit", denominator: denom };
  }

  return { unit_class: "aggregate", denominator: null };
}

// ---------------------------------------------------------------------------
// Period key structure (D-04)
// ---------------------------------------------------------------------------

export type PeriodType = "month" | "quarter" | "fy" | "ltm" | "ytd_asof" | "range" | "unknown";

export interface StructuredPeriod {
  type: PeriodType;
  /** Canonical period key for equality comparison */
  key: string;
  /** Raw input period string */
  raw: string;
}

/**
 * Parse a normalized period string into a structured period with type.
 */
export function parsePeriodType(normalizedPeriod: string): StructuredPeriod {
  const p = normalizedPeriod.toLowerCase();

  // Range: "fy-mar-24_26" or "fy-mar-24f_26f"
  if (p.includes("_")) {
    return { type: "range", key: p, raw: normalizedPeriod };
  }

  // Monthly: "jan-26", "feb-25", "mar-26" (but NOT "fy-mar-26")
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{2}/.test(p) && !p.startsWith("fy-")) {
    return { type: "month", key: p, raw: normalizedPeriod };
  }

  // FY: "fy-mar-26", "fy-mar-26f"
  if (p.startsWith("fy-")) {
    return { type: "fy", key: p, raw: normalizedPeriod };
  }

  // LTM: "ltm-*"
  if (p.startsWith("ltm")) {
    return { type: "ltm", key: p, raw: normalizedPeriod };
  }

  // YTD: "ytd-*"
  if (p.startsWith("ytd")) {
    return { type: "ytd_asof", key: p, raw: normalizedPeriod };
  }

  // Quarter: "q1-26", "q2-25"
  if (/^q[1-4]-\d{2}/.test(p)) {
    return { type: "quarter", key: p, raw: normalizedPeriod };
  }

  return { type: "unknown", key: p, raw: normalizedPeriod };
}

/**
 * D-04: Check if two periods are comparable.
 * A month ≠ a year, YTD-as-of ≠ FY, LTM ≠ CY.
 */
export function periodsAreComparable(claimPeriod: StructuredPeriod, figurePeriod: StructuredPeriod): boolean {
  // Exact key match is always comparable
  if (claimPeriod.key === figurePeriod.key) return true;

  // Same type: comparable (different year/suffix is a match issue, not a comparability issue)
  if (claimPeriod.type === figurePeriod.type) return true;

  // Cross-type: almost never comparable
  // Exception: "fy" and "unknown" are comparable (slug-ified periods may be FY)
  if (claimPeriod.type === "fy" && figurePeriod.type === "unknown") return true;
  if (claimPeriod.type === "unknown" && figurePeriod.type === "fy") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Scope structure (D-05)
// ---------------------------------------------------------------------------

export interface StructuredScope {
  /** Dimension: null = company-wide. E.g., "segment", "brand", "region" */
  dimension: string | null;
  /** Member: null = total. E.g., "Opdivo Qvantig", "North America" */
  member: string | null;
}

/**
 * Parse a scope qualifier into structured {dimension, member}.
 * "Revenue (segment: Opdivo Qvantig)" → { dimension: "segment", member: "Opdivo Qvantig" }
 * "Total Group Revenue" → { dimension: null, member: null }
 */
export function parseScope(scopeQualifier: string): StructuredScope {
  // Pattern: "MetricName (dimension: member)"
  const segmentMatch = scopeQualifier.match(/\((segment|brand|region|product|channel|division|geography):\s*(.+?)\)$/i);
  if (segmentMatch) {
    return { dimension: segmentMatch[1].toLowerCase(), member: segmentMatch[2].trim() };
  }

  // Pattern: "MetricName — Total" or just "Total Group X" / "Total X"
  if (/\btotal\b/i.test(scopeQualifier) || scopeQualifier.toUpperCase().includes("GROUP")) {
    return { dimension: null, member: null };
  }

  // No explicit scoping → treat as company-wide (conservative)
  return { dimension: null, member: null };
}

/**
 * D-05: Check if two scopes are comparable.
 * A brand-level scope vs company total → not comparable.
 */
export function scopesAreComparable(claimScope: StructuredScope, figureScope: StructuredScope): boolean {
  // Both company-wide
  if (claimScope.dimension === null && figureScope.dimension === null) return true;

  // Both segment-level with same dimension
  if (claimScope.dimension !== null && figureScope.dimension !== null) {
    if (claimScope.dimension === figureScope.dimension) {
      // Same dimension — member equality required for exact match
      // (different members are different segments, not comparable)
      if (claimScope.member?.toLowerCase() === figureScope.member?.toLowerCase()) return true;
      // Different members within same dimension = different segments = not comparable
      return false;
    }
    // Different dimensions = not comparable
    return false;
  }

  // One is segment-level, other is company-wide → not comparable
  return false;
}

// ---------------------------------------------------------------------------
// Case / basis (D-09)
// ---------------------------------------------------------------------------

export type CaseType =
  | "base" | "management" | "risk_adjusted"
  | "upside" | "downside" | "severe_downside"
  | "unstated";

/**
 * Detect the case from a claim's scenario field.
 */
export function detectClaimCase(claim: Claim): CaseType {
  const scenario = (claim.scenario ?? "").toLowerCase();
  const basis = (claim.basis_note ?? "").toLowerCase();
  const scope = claim.scope_qualifier.toLowerCase();

  // Management case indicators
  if (scenario.includes("management") || basis.includes("management") ||
      scope.includes("management")) {
    return "management";
  }

  // Risk-adjusted / base case
  if (scenario.includes("risk") || scenario.includes("base case") ||
      basis.includes("risk-adjusted") || basis.includes("risk adjusted")) {
    return "risk_adjusted";
  }

  // PEP / buyside case — treat as risk_adjusted
  if (scenario.includes("pep") || basis.includes("pep") || scope.includes("pep")) {
    return "risk_adjusted";
  }

  // Upside/downside
  if (scenario.includes("upside") || scenario.includes("bull")) return "upside";
  if (scenario.includes("downside") || scenario.includes("bear")) return "downside";
  if (scenario.includes("severe")) return "severe_downside";

  return "unstated";
}

/**
 * Detect the case from a model figure label.
 */
export function detectFigureCase(fig: Figure): CaseType {
  const label = fig.name.toLowerCase();

  if (label.includes("management") || label.includes("mgmt")) return "management";
  if (label.includes("risk") || label.includes("base case")) return "risk_adjusted";
  if (label.includes("pep")) return "risk_adjusted";
  if (label.includes("upside") || label.includes("bull")) return "upside";
  if (label.includes("downside") || label.includes("bear")) return "downside";

  return "unstated";
}

// ---------------------------------------------------------------------------
// Implausible ratio guard (D-03)
// ---------------------------------------------------------------------------

/**
 * D-03: Detect implausible ratios.
 * If Δ% ≥ 95% AND the two values differ by ≥2 orders of magnitude,
 * the match is implausible (scale or unit error, not a real divergence).
 */
export function isImplausibleRatio(claimValue: number, modelValue: number): boolean {
  if (modelValue === 0 || claimValue === 0) return false;

  const ratio = Math.abs(claimValue / modelValue);
  const deltaPct = Math.abs(claimValue - modelValue) / Math.abs(modelValue);

  // ≥2 orders of magnitude apart (ratio > 100 or < 0.01)
  const magnitudeDiff = Math.abs(Math.log10(ratio));

  return deltaPct >= 0.95 && magnitudeDiff >= 2;
}

// ---------------------------------------------------------------------------
// Comparability admission result
// ---------------------------------------------------------------------------

export interface ComparabilityResult {
  admitted: boolean;
  reason_code: ComparabilityReasonCode | null;
  /** Fields that matched exactly */
  fields_matched: string[];
  /** Fields that were reconciled (with transform log) */
  fields_reconciled: Array<{ field: string; op: string; from: string; to: string }>;
  /** Comparability confidence ∈ [0, 1] */
  comparability_confidence: number;
  /** For D-09: when case mismatch is detected, this is the specific sub-type */
  detail?: string;
}

/**
 * Full comparability gate (§4 of defect packet).
 *
 * Runs ALL guards in sequence. Returns the FIRST failure (fail-fast).
 * If all pass, returns admitted=true with confidence.
 *
 * Guard order (D-10): comparability BEFORE materiality floors.
 *   1. unit_class compatibility
 *   2. period compatibility
 *   3. scope compatibility
 *   4. case compatibility
 *   5. implausible ratio (after value alignment)
 *
 * Materiality floors are NOT checked here — they run only on survivors.
 */
export function checkComparability(
  claim: Claim,
  nf: NormalizedFigure,
  claimValueNormalized: number,
  modelValueAligned: number,
  options?: { dealCurrency?: string },
): ComparabilityResult {
  const fieldsMatched: string[] = [];
  const fieldsReconciled: Array<{ field: string; op: string; from: string; to: string }> = [];

  // 1. Metric (already matched by caller — just log it)
  fieldsMatched.push("metric");

  // 2. Unit class (D-02)
  const claimUC = classifyClaimUnitClass(claim);
  const figUC = classifyFigureUnitClass(nf.raw, nf);

  if (claimUC.unit_class !== figUC.unit_class) {
    return {
      admitted: false,
      reason_code: "unit_class_mismatch",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `claim=${claimUC.unit_class}(${claimUC.denominator ?? ""}) vs figure=${figUC.unit_class}(${figUC.denominator ?? ""})`,
    };
  }
  fieldsMatched.push("unit_class");

  // Denominator check for per_unit
  if (claimUC.unit_class === "per_unit" && figUC.unit_class === "per_unit") {
    if (claimUC.denominator !== figUC.denominator) {
      return {
        admitted: false,
        reason_code: "denominator_mismatch",
        fields_matched: fieldsMatched,
        fields_reconciled: fieldsReconciled,
        comparability_confidence: 0,
        detail: `per_${claimUC.denominator} vs per_${figUC.denominator}`,
      };
    }
    fieldsMatched.push("denominator");
  }

  // 3. Period (D-04) — already normalized by caller
  const claimPeriod = parsePeriodType(claim.period);
  const figPeriod = parsePeriodType(nf.period);

  if (!periodsAreComparable(claimPeriod, figPeriod)) {
    return {
      admitted: false,
      reason_code: "period_mismatch",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `claim_period=${claimPeriod.type}(${claimPeriod.key}) vs figure_period=${figPeriod.type}(${figPeriod.key})`,
    };
  }
  if (claimPeriod.key === figPeriod.key) {
    fieldsMatched.push("period");
  } else {
    fieldsReconciled.push({ field: "period", op: "type_match", from: claimPeriod.key, to: figPeriod.key });
  }

  // 3b. Frequency (C1) — month ↔ annual as declared scale transform
  const claimFreq = detectFrequency(claim.period);
  const figFreq = detectFrequency(nf.period);
  const freqCompat = frequenciesAreComparable(claimFreq, figFreq);
  if (!freqCompat.compatible) {
    return {
      admitted: false,
      reason_code: "frequency_mismatch",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `claim_freq=${claimFreq} vs figure_freq=${figFreq}`,
    };
  }
  if (claimFreq === figFreq || claimFreq === "unknown" || figFreq === "unknown") {
    fieldsMatched.push("frequency");
  } else if (freqCompat.transform) {
    fieldsReconciled.push({
      field: "frequency",
      op: freqCompat.transform.op,
      from: claimFreq,
      to: figFreq,
    });
  }

  // 4. Scope (D-05)
  const claimScope = parseScope(claim.scope_qualifier);
  const figScope = parseScope(nf.scope_qualifier);

  if (!scopesAreComparable(claimScope, figScope)) {
    return {
      admitted: false,
      reason_code: "scope_mismatch",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `claim_scope={${claimScope.dimension ?? "total"},${claimScope.member ?? "all"}} vs figure_scope={${figScope.dimension ?? "total"},${figScope.member ?? "all"}}`,
    };
  }
  if (claimScope.dimension === figScope.dimension &&
      (claimScope.member?.toLowerCase() ?? null) === (figScope.member?.toLowerCase() ?? null)) {
    fieldsMatched.push("scope");
  } else {
    fieldsReconciled.push({
      field: "scope",
      op: "normalized_match",
      from: `{${claimScope.dimension},${claimScope.member}}`,
      to: `{${figScope.dimension},${figScope.member}}`,
    });
  }

  // 5. Case (D-09)
  const claimCase = detectClaimCase(claim);
  const figCase = detectFigureCase(nf.raw);

  // Both unstated: compatible. One unstated: near-miss.
  if (claimCase !== "unstated" && figCase !== "unstated" && claimCase !== figCase) {
    return {
      admitted: false,
      reason_code: "case_mismatch",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `claim_case=${claimCase} vs figure_case=${figCase}`,
    };
  }
  if (claimCase === figCase || (claimCase === "unstated" && figCase === "unstated")) {
    fieldsMatched.push("case");
  } else {
    // One is unstated — reconcile, lower confidence
    fieldsReconciled.push({
      field: "case",
      op: "unstated_assumed",
      from: claimCase,
      to: figCase,
    });
  }

  // 6. Implausible ratio (D-03)
  if (isImplausibleRatio(claimValueNormalized, modelValueAligned)) {
    return {
      admitted: false,
      reason_code: "implausible_ratio",
      fields_matched: fieldsMatched,
      fields_reconciled: fieldsReconciled,
      comparability_confidence: 0,
      detail: `values differ by ≥2 orders of magnitude with Δ%≥95%: claim=${claimValueNormalized}, model=${modelValueAligned}`,
    };
  }
  fieldsMatched.push("magnitude_plausible");

  // All guards passed
  const totalFields = fieldsMatched.length + fieldsReconciled.length;
  const exactFraction = fieldsMatched.length / Math.max(totalFields, 1);
  const confidence = 0.5 + 0.5 * exactFraction; // Base 0.5 + up to 0.5 for all-exact

  return {
    admitted: true,
    reason_code: null,
    fields_matched: fieldsMatched,
    fields_reconciled: fieldsReconciled,
    comparability_confidence: confidence,
  };
}

// ---------------------------------------------------------------------------
// Figure fanout guard (D-06)
// ---------------------------------------------------------------------------

export interface FanoutResult {
  /** Figure key → list of claims that matched it */
  fanout: Map<string, Array<{ claimIndex: number; scope: string; period: string }>>;
  /** Max fanout across all figures */
  maxFanout: number;
  /** Figures with fanout > 1 where claims have differing scope or period */
  conflictingFanouts: Array<{
    figureKey: string;
    claimCount: number;
    claims: Array<{ claimIndex: number; scope: string; period: string }>;
  }>;
}

/**
 * Build a figure key for fanout tracking.
 * Uses source_sheet + source_cell (or row_label + period for LLM-extracted figures).
 */
export function figureKey(fig: Figure): string {
  if (fig.source_cell && fig.source_cell !== "ref_fig") {
    return `${fig.source_sheet}!${fig.source_cell}`;
  }
  // LLM-extracted: use sheet + name + period as proxy
  return `${fig.source_sheet}::${fig.name}::${fig.period}`;
}

/**
 * D-06: Check figure fanout after matching.
 * If one figure serves >1 claim with differing scope or period, fail closed on ALL.
 */
export function checkFigureFanout(
  matchedPairs: Array<{ claimIndex: number; claim: Claim; figure: Figure }>,
): FanoutResult {
  const fanout = new Map<string, Array<{ claimIndex: number; scope: string; period: string }>>();

  for (const pair of matchedPairs) {
    const key = figureKey(pair.figure);
    if (!fanout.has(key)) fanout.set(key, []);
    fanout.get(key)!.push({
      claimIndex: pair.claimIndex,
      scope: pair.claim.scope_qualifier,
      period: pair.claim.period,
    });
  }

  let maxFanout = 0;
  const conflictingFanouts: FanoutResult["conflictingFanouts"] = [];

  for (const [key, claims] of fanout.entries()) {
    maxFanout = Math.max(maxFanout, claims.length);

    if (claims.length > 1) {
      // Check if claims have differing scope or period
      const scopes = new Set(claims.map(c => c.scope.toLowerCase()));
      const periods = new Set(claims.map(c => c.period.toLowerCase()));

      if (scopes.size > 1 || periods.size > 1) {
        conflictingFanouts.push({ figureKey: key, claimCount: claims.length, claims });
      }
    }
  }

  return { fanout, maxFanout, conflictingFanouts };
}

// ---------------------------------------------------------------------------
// Run-level diagnostics (D-07)
// ---------------------------------------------------------------------------

export interface RunDiagnostics {
  /** D-07: findings > 0 with 0 not-comparable → suspicious */
  suspicious_zero_bucket: boolean;
  /** D-06: max figure fanout across all matched pairs */
  figure_fanout_max: number;
  /** D-01: any finding with placeholder coordinate */
  placeholder_coordinate_count: number;
  /** D-08: currency used in report */
  report_currency: string;
}

export function computeRunDiagnostics(
  findingsCount: number,
  notComparableCount: number,
  figureFanoutMax: number,
  placeholderCoordinateCount: number,
  reportCurrency: string,
): RunDiagnostics {
  return {
    suspicious_zero_bucket: findingsCount > 0 && notComparableCount === 0,
    figure_fanout_max: figureFanoutMax,
    placeholder_coordinate_count: placeholderCoordinateCount,
    report_currency: reportCurrency,
  };
}

// ---------------------------------------------------------------------------
// C2: Ratio Reconstruction
// ---------------------------------------------------------------------------

/**
 * C2: Try to match a per_unit claim by computing numerator ÷ denominator
 * from two resolved figures.
 *
 * Example: claim "revenue per site = $8.5k"
 *   → numerator: aggregate revenue figure at same period
 *   → denominator: site count figure at same period
 *   → computed = numerator / denominator
 *   → compare to claim value
 *
 * Returns null if either input is missing (fail closed).
 */
export interface RatioReconstructionResult {
  computed: number;
  numerator: { name: string; value: number; source: string };
  denominator: { name: string; value: number; source: string };
  claimValue: number;
  deltaPct: number;
  deltaAbs: number;
}

/** Common denominator keywords for per-unit metrics */
const DENOMINATOR_KEYWORDS: Record<string, string[]> = {
  site: ["site", "location", "practice", "office", "clinic"],
  fte: ["fte", "employee", "headcount", "head count", "staff"],
  customer: ["customer", "client", "account", "advertiser", "brand"],
  unit: ["unit", "subscriber", "user", "member"],
  deal: ["deal", "transaction"],
};

/**
 * Find the denominator metric keyword from a per_unit claim's denominator string.
 * Returns the canonical denominator key or null.
 */
export function canonicalizeDenominator(denom: string | null): string | null {
  if (!denom) return null;
  const d = denom.toLowerCase().trim();
  for (const [canonical, keywords] of Object.entries(DENOMINATOR_KEYWORDS)) {
    if (keywords.some((k) => d.includes(k))) return canonical;
  }
  return d; // Use as-is if no canonical match
}

/**
 * C2: Attempt ratio reconstruction for a per_unit claim.
 *
 * @param claim - The per-unit claim
 * @param claimValue - Normalized claim value
 * @param figures - All available figures for the deal
 * @param claimMetric - The claim's normalized metric
 * @param claimPeriod - The claim's normalized period
 * @returns RatioReconstructionResult if both inputs found, null otherwise
 */
export function tryRatioReconstruction(
  claim: Claim,
  claimValue: number,
  figures: NormalizedFigure[],
  claimMetric: string,
  claimPeriod: string,
): RatioReconstructionResult | null {
  const uc = classifyClaimUnitClass(claim);
  if (uc.unit_class !== "per_unit" || !uc.denominator) return null;

  const denomKey = canonicalizeDenominator(uc.denominator);
  if (!denomKey) return null;

  // Find numerator: aggregate figure with same metric and period
  const numerator = figures.find((f) => {
    const figUC = classifyFigureUnitClass(f.raw, f);
    if (figUC.unit_class !== "aggregate") return false;
    const metricMatch = f.metric.toLowerCase().includes(claimMetric.toLowerCase()) ||
                        claimMetric.toLowerCase().includes(f.metric.toLowerCase());
    const periodMatch = f.period.toLowerCase().includes(claimPeriod.toLowerCase()) ||
                        claimPeriod.toLowerCase().includes(f.period.toLowerCase());
    return metricMatch && periodMatch;
  });

  if (!numerator) return null;

  // Find denominator: count figure with matching denominator keyword and period
  const denominator = figures.find((f) => {
    const figUC = classifyFigureUnitClass(f.raw, f);
    if (figUC.unit_class !== "count" && figUC.unit_class !== "aggregate") return false;
    const nameLC = f.raw.name.toLowerCase();
    const keywords = DENOMINATOR_KEYWORDS[denomKey] ?? [denomKey];
    const nameMatch = keywords.some((k) => nameLC.includes(k));
    if (!nameMatch) return false;
    // Must also be a count-like metric (sites, FTEs, etc.) not another monetary figure
    if (figUC.unit_class === "aggregate") {
      // Only allow if name clearly indicates a count
      const countIndicators = ["count", "number", "total sites", "total locations", "headcount", "fte"];
      if (!countIndicators.some((ci) => nameLC.includes(ci))) return false;
    }
    const periodMatch = f.period.toLowerCase().includes(claimPeriod.toLowerCase()) ||
                        claimPeriod.toLowerCase().includes(f.period.toLowerCase());
    return periodMatch;
  });

  if (!denominator) return null;
  if (denominator.raw.value === 0) return null; // Division by zero guard

  const computed = numerator.raw.value / denominator.raw.value;
  const deltaAbs = Math.abs(claimValue - computed);
  const deltaPct = computed !== 0 ? deltaAbs / Math.abs(computed) : (deltaAbs === 0 ? 0 : 1);

  return {
    computed,
    numerator: {
      name: numerator.raw.name,
      value: numerator.raw.value,
      source: numerator.raw.source_sheet + (numerator.raw.source_cell ? "!" + numerator.raw.source_cell : ""),
    },
    denominator: {
      name: denominator.raw.name,
      value: denominator.raw.value,
      source: denominator.raw.source_sheet + (denominator.raw.source_cell ? "!" + denominator.raw.source_cell : ""),
    },
    claimValue,
    deltaPct,
    deltaAbs,
  };
}
