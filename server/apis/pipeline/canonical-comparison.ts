/**
 * MAT-F03: Canonical Comparison Engine
 *
 * Fail-Closed Compatibility, Deterministic Normalization, Calculation, and Verdict.
 *
 * Architecture:
 *   1. Compatibility engine — evaluates 10 dimensions between claim and evidence
 *   2. Normalization engine — deterministic unit/scale normalization
 *   3. Calculation engine — signed/absolute/percentage deltas
 *   4. Verdict engine — deterministic verdict from rules (no LLM)
 *
 * All functions are pure, stateless, and versioned.
 */

import { sha256hex } from "./sha256-pure.js";

// ===========================================================================
// Schema Version
// ===========================================================================

export const COMPARISON_SCHEMA_VERSION = "comparison-v1" as const;
export const COMPATIBILITY_RULE_VERSION = "compat-v1.0" as const;
export const NORMALIZATION_RULE_VERSION = "norm-v1.0" as const;
export const VERDICT_RULE_VERSION = "verdict-v1.0" as const;

// ===========================================================================
// Types
// ===========================================================================

export type CompatibilityDecision =
  | "compatible"
  | "incompatible"
  | "unknown"
  | "not_applicable";

export interface DimensionCompatibility {
  entity: CompatibilityDecision;
  metric: CompatibilityDecision;
  period: CompatibilityDecision;
  segment: CompatibilityDecision;
  scope: CompatibilityDecision;
  unit_scale: CompatibilityDecision;
  currency: CompatibilityDecision;
  actual_forecast: CompatibilityDecision;
  accounting_basis: CompatibilityDecision;
  comparison_basis: CompatibilityDecision;

  allowed: boolean;
  rejection_reasons: string[];
  rule_version: string;
}

export type CalculationType = "numeric" | "qualitative" | "not_performed";
export type Direction = "claim_higher" | "claim_lower" | "equal" | "not_applicable";

export interface Calculation {
  calculation_type: CalculationType;

  normalized_claim_value: number | null;
  normalized_fact_value: number | null;

  signed_delta: number | null;
  absolute_delta: number | null;
  percentage_delta: number | null;

  direction: Direction;

  normalization_rule_version: string;
}

export type VerdictValue =
  | "confirmed"
  | "contradicted"
  | "materially_changed"
  | "partially_supported"
  | "unsupported"
  | "unverifiable";

export interface Verdict {
  value: VerdictValue;
  rule_version: string;
  reason_codes: string[];
}

export interface CanonicalComparison {
  schema_version: typeof COMPARISON_SCHEMA_VERSION;
  comparison_id: string;

  claim_id: string;
  evidence_id: string;

  compatibility: DimensionCompatibility;
  calculation: Calculation;
  verdict: Verdict;

  reportable: boolean;
}

// ===========================================================================
// Comparison Inputs
// ===========================================================================

/**
 * Claim input for comparison — fields from CanonicalIcClaim or resolved claim
 */
export interface ComparisonClaimInput {
  claim_id: string;
  entity: string | null;
  metric: string | null;
  period: string | null;
  segment: string | null;
  scope: string | null;
  unit: string | null;
  currency: string | null;
  scale: string | null;
  actual_or_forecast: string | null;
  accounting_basis: string | null;
  comparison_basis: string | null;
  value: number | string | null;
  ic_document_id: string | null;
}

/**
 * Evidence input for comparison — fields from admitted canonical evidence
 */
export interface ComparisonEvidenceInput {
  evidence_id: string;
  entity: string | null;
  metric: string | null;
  period: string | null;
  segment: string | null;
  scope: string | null;
  unit: string | null;
  currency: string | null;
  scale: string | null;
  actual_or_forecast: string | null;
  accounting_basis: string | null;
  comparison_basis: string | null;
  value: number | string | null;
  source_document_id: string | null;
  /** Whether entity bridge from F02 admits this evidence for the claim entity */
  has_entity_bridge: boolean;
}

// ===========================================================================
// A. Compatibility Engine
// ===========================================================================

/**
 * Evaluate all 10 compatibility dimensions between claim and evidence.
 * Fail-closed: unknown required dimensions reject comparison.
 */
export function evaluateCompatibility(
  claim: ComparisonClaimInput,
  evidence: ComparisonEvidenceInput,
): DimensionCompatibility {
  const reasons: string[] = [];

  // 1. Entity
  const entity = evaluateEntityCompat(claim, evidence);
  if (entity === "incompatible") reasons.push("entity_incompatible");
  if (entity === "unknown") reasons.push("entity_unknown");

  // 2. Metric
  const metric = evaluateMetricCompat(claim.metric, evidence.metric);
  if (metric === "incompatible") reasons.push("metric_incompatible");
  if (metric === "unknown") reasons.push("metric_unknown");

  // 3. Period
  const period = evaluatePeriodCompat(claim.period, evidence.period);
  if (period === "incompatible") reasons.push("period_incompatible");
  if (period === "unknown") reasons.push("period_unknown");

  // 4. Segment
  const segment = evaluateSegmentCompat(claim.segment, evidence.segment);
  if (segment === "incompatible") reasons.push("segment_incompatible");

  // 5. Scope
  const scope = evaluateScopeCompat(claim.scope, evidence.scope);
  if (scope === "incompatible") reasons.push("scope_incompatible");
  if (scope === "unknown") reasons.push("scope_unknown");

  // 6. Unit/Scale
  const unit_scale = evaluateUnitScaleCompat(claim.unit, claim.scale, evidence.unit, evidence.scale);
  if (unit_scale === "incompatible") reasons.push("unit_scale_incompatible");
  if (unit_scale === "unknown") reasons.push("unit_scale_unknown");

  // 7. Currency
  const currency = evaluateCurrencyCompat(claim.currency, evidence.currency);
  if (currency === "incompatible") reasons.push("currency_incompatible");
  if (currency === "unknown") reasons.push("currency_unknown");

  // 8. Actual/Forecast
  const actual_forecast = evaluateActualForecastCompat(
    claim.actual_or_forecast, evidence.actual_or_forecast
  );
  if (actual_forecast === "incompatible") reasons.push("actual_forecast_incompatible");
  if (actual_forecast === "unknown") reasons.push("actual_forecast_unknown");

  // 9. Accounting basis
  const accounting_basis = evaluateAccountingBasisCompat(
    claim.accounting_basis, evidence.accounting_basis
  );
  if (accounting_basis === "incompatible") reasons.push("accounting_basis_incompatible");

  // 10. Comparison basis
  const comparison_basis = evaluateComparisonBasisCompat(
    claim.comparison_basis, evidence.comparison_basis
  );
  // comparison_basis incompatibility doesn't block — it changes the verdict category

  const allowed = reasons.length === 0;

  return {
    entity,
    metric,
    period,
    segment,
    scope,
    unit_scale,
    currency,
    actual_forecast,
    accounting_basis,
    comparison_basis,
    allowed,
    rejection_reasons: reasons,
    rule_version: COMPATIBILITY_RULE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Entity compatibility
// ---------------------------------------------------------------------------

function evaluateEntityCompat(
  claim: ComparisonClaimInput,
  evidence: ComparisonEvidenceInput,
): CompatibilityDecision {
  const ce = normalizeEntityName(claim.entity);
  const ee = normalizeEntityName(evidence.entity);

  if (!ce || !ee) return "unknown"; // Fail closed
  if (ce === ee) return "compatible";

  // Gamma→SCG bridge: only if F02 admitted bridge
  if (evidence.has_entity_bridge) return "compatible";

  // Market-level vs company-specific: incompatible unless bridged
  if (isMarketLevel(ee) && !isMarketLevel(ce)) return "incompatible";

  return "incompatible";
}

function normalizeEntityName(entity: string | null): string | null {
  if (!entity) return null;
  return entity.trim().toLowerCase().replace(/\s+/g, "_");
}

function isMarketLevel(entity: string): boolean {
  const marketTerms = ["market", "tam", "sam", "industry", "sector"];
  return marketTerms.some(t => entity.includes(t));
}

// ---------------------------------------------------------------------------
// Metric compatibility
// ---------------------------------------------------------------------------

/**
 * STRICT metric compatibility. Revenue ≠ gross profit. Reported EBITDA ≠ cash EBITDA.
 * Only true semantic equivalents allowed.
 */

const METRIC_CANONICAL_GROUPS: Record<string, string> = {
  // Revenue group
  "revenue": "revenue",
  "total_revenue": "revenue",
  "total_group_revenue": "revenue",
  "net_revenue": "net_revenue", // Distinct from revenue
  "recurring_revenue": "recurring_revenue",
  "arr": "recurring_revenue",
  "mrr": "recurring_revenue",

  // Gross profit group — DISTINCT from revenue and gross margin %
  "gross_profit": "gross_profit",
  "total_gross_profit": "gross_profit",
  "gp": "gross_profit",

  // Gross margin (percentage) — DISTINCT from gross profit (absolute)
  "gross_margin": "gross_margin_pct",
  "gross_margin_pct": "gross_margin_pct",
  "gross_margin_percentage": "gross_margin_pct",
  "gm_pct": "gross_margin_pct",

  // EBITDA — each basis is DISTINCT
  "adjusted_ebitda": "adjusted_ebitda",
  "adj_ebitda": "adjusted_ebitda",

  "reported_ebitda": "reported_ebitda",
  "ebitda_reported": "reported_ebitda",

  "cash_ebitda": "cash_ebitda",
  "ebitda_cash": "cash_ebitda",

  "adjusted_cash_ebitda": "adjusted_cash_ebitda",
  "adj_cash_ebitda": "adjusted_cash_ebitda",

  "organic_ebitda": "organic_ebitda",
  "organic_cash_ebitda": "organic_ebitda",

  "run_rate_ebitda": "run_rate_ebitda",

  "ebitda": "cash_ebitda", // Plain "EBITDA" defaults to cash EBITDA in this deal context
  "ebitda_adjustments": "ebitda_adjustments", // DISTINCT from EBITDA itself

  // Market metrics — DISTINCT from company KPIs
  "tam": "tam",
  "total_addressable_market": "tam",
  "sam": "sam",
  "market_size": "market_size",
  "market_share": "market_share",

  // Company KPIs
  "revenue_growth": "revenue_growth",
  "customer_count": "customer_count",
  "nrr": "nrr",
  "churn": "churn",
};

function evaluateMetricCompat(
  claimMetric: string | null,
  evidenceMetric: string | null,
): CompatibilityDecision {
  if (!claimMetric || !evidenceMetric) return "unknown";

  const cn = canonicalizeMetric(claimMetric);
  const en = canonicalizeMetric(evidenceMetric);

  if (!cn || !en) return "unknown";
  if (cn === en) return "compatible";
  return "incompatible";
}

function canonicalizeMetric(metric: string): string | null {
  const normalized = metric.trim().toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  return METRIC_CANONICAL_GROUPS[normalized] ?? null;
}

// ---------------------------------------------------------------------------
// Period compatibility
// ---------------------------------------------------------------------------

function evaluatePeriodCompat(
  claimPeriod: string | null,
  evidencePeriod: string | null,
): CompatibilityDecision {
  if (!claimPeriod || !evidencePeriod) return "unknown";

  const cn = canonicalizePeriod(claimPeriod);
  const en = canonicalizePeriod(evidencePeriod);

  if (!cn || !en) return "unknown";
  if (cn === en) return "compatible";
  return "incompatible";
}

/**
 * Canonicalize period to deterministic form.
 * "FY26", "FY2026", "FY Mar-26", "Mar-26" → "fy-mar-26"
 * "FY25", "FY2025", "FY Mar-25" → "fy-mar-25"
 */
function canonicalizePeriod(period: string): string | null {
  const p = period.trim().toLowerCase();

  // FY Mar-XX format
  const fyMarMatch = p.match(/fy\s*mar[-\s]?(\d{2,4})(f|b|le|a)?/i);
  if (fyMarMatch) {
    let yr = parseInt(fyMarMatch[1], 10);
    if (yr >= 100) yr = yr - 2000;
    const suffix = fyMarMatch[2]?.toLowerCase() ?? "";
    const cleanSuffix = (suffix === "le" || suffix === "a") ? "" : suffix;
    return `fy-mar-${yr}${cleanSuffix}`;
  }

  // FY XX format
  const fyMatch = p.match(/fy\s*(\d{2,4})(f|b|le|a)?/i);
  if (fyMatch) {
    let yr = parseInt(fyMatch[1], 10);
    if (yr >= 100) yr = yr - 2000;
    const suffix = fyMatch[2]?.toLowerCase() ?? "";
    const cleanSuffix = (suffix === "le" || suffix === "a") ? "" : suffix;
    return `fy-mar-${yr}${cleanSuffix}`;
  }

  // Plain year
  const yearMatch = p.match(/^(\d{4})(f|b)?$/);
  if (yearMatch) {
    let yr = parseInt(yearMatch[1], 10) - 2000;
    const suffix = yearMatch[2]?.toLowerCase() ?? "";
    return `fy-mar-${yr}${suffix}`;
  }

  // 2-digit year shorthand: "26", "25"
  const shortMatch = p.match(/^(\d{2})(f|b)?$/);
  if (shortMatch) {
    const yr = parseInt(shortMatch[1], 10);
    const suffix = shortMatch[2]?.toLowerCase() ?? "";
    return `fy-mar-${yr}${suffix}`;
  }

  // Q1/Q2/Q3/Q4 periods
  const qMatch = p.match(/q([1-4])\s*(\d{2,4})/);
  if (qMatch) {
    let yr = parseInt(qMatch[2], 10);
    if (yr >= 100) yr = yr - 2000;
    return `q${qMatch[1]}-${yr}`;
  }

  return null; // Unknown period format — fail closed
}

// ---------------------------------------------------------------------------
// Segment compatibility
// ---------------------------------------------------------------------------

function evaluateSegmentCompat(
  claimSegment: string | null,
  evidenceSegment: string | null,
): CompatibilityDecision {
  // Both null → not_applicable (whole-entity comparison)
  if (!claimSegment && !evidenceSegment) return "not_applicable";

  // One has segment, other doesn't → scope mismatch
  if (!claimSegment || !evidenceSegment) return "incompatible";

  const cn = claimSegment.trim().toLowerCase();
  const en = evidenceSegment.trim().toLowerCase();
  if (cn === en) return "compatible";

  return "incompatible";
}

// ---------------------------------------------------------------------------
// Scope compatibility (group vs segment)
// ---------------------------------------------------------------------------

function evaluateScopeCompat(
  claimScope: string | null,
  evidenceScope: string | null,
): CompatibilityDecision {
  if (!claimScope && !evidenceScope) return "compatible"; // Both unqualified
  if (!claimScope || !evidenceScope) return "unknown"; // One missing

  const cn = claimScope.trim().toLowerCase();
  const en = evidenceScope.trim().toLowerCase();

  if (cn === en) return "compatible";

  // Group vs segment: incompatible
  const groupTerms = ["group", "total", "consolidated", "total_group"];
  const cnIsGroup = groupTerms.some(t => cn.includes(t));
  const enIsGroup = groupTerms.some(t => en.includes(t));

  if (cnIsGroup !== enIsGroup) return "incompatible";

  // Both are group-level terms → compatible
  if (cnIsGroup && enIsGroup) return "compatible";

  return "incompatible";
}

// ---------------------------------------------------------------------------
// Unit/Scale compatibility
// ---------------------------------------------------------------------------

export type UnitFamily = "currency" | "percentage" | "percentage_point" | "basis_point" | "count" | "ratio" | "unknown";

function classifyUnitFamily(unit: string | null): UnitFamily {
  if (!unit) return "unknown";
  const u = unit.trim().toLowerCase();

  if (u.includes("percentage_point") || u.includes("pp") || u === "ppts") return "percentage_point";
  if (u.includes("basis_point") || u === "bps" || u === "bp") return "basis_point";
  if (u.includes("percent") || u === "%" || u === "pct") return "percentage";
  if (u.includes("gbp") || u.includes("usd") || u.includes("eur") ||
      u.includes("£") || u.includes("$") || u.includes("€") ||
      u.includes("_millions") || u.includes("_thousands") ||
      u === "currency") return "currency";
  if (u === "count" || u === "units" || u === "x" || u === "times") return "count";
  if (u === "ratio" || u === "multiple") return "ratio";

  return "unknown";
}

function evaluateUnitScaleCompat(
  claimUnit: string | null,
  claimScale: string | null,
  evidenceUnit: string | null,
  evidenceScale: string | null,
): CompatibilityDecision {
  const cf = classifyUnitFamily(claimUnit);
  const ef = classifyUnitFamily(evidenceUnit);

  // Unknown unit → fail closed
  if (cf === "unknown" || ef === "unknown") return "unknown";

  // Different unit families are incompatible
  if (cf !== ef) return "incompatible";

  // Same family — scale differences are handled in normalization
  return "compatible";
}

// ---------------------------------------------------------------------------
// Currency compatibility
// ---------------------------------------------------------------------------

function evaluateCurrencyCompat(
  claimCurrency: string | null,
  evidenceCurrency: string | null,
): CompatibilityDecision {
  if (!claimCurrency && !evidenceCurrency) return "not_applicable";
  if (!claimCurrency || !evidenceCurrency) return "unknown";

  const cn = claimCurrency.trim().toLowerCase();
  const en = evidenceCurrency.trim().toLowerCase();
  if (cn === en) return "compatible";

  // GBP equivalents
  const gbpAliases = ["gbp", "£", "gbp_millions", "gbp_thousands"];
  if (gbpAliases.includes(cn) && gbpAliases.includes(en)) return "compatible";

  return "incompatible";
}

// ---------------------------------------------------------------------------
// Actual vs Forecast
// ---------------------------------------------------------------------------

function evaluateActualForecastCompat(
  claimStatus: string | null,
  evidenceStatus: string | null,
): CompatibilityDecision {
  if (!claimStatus && !evidenceStatus) return "not_applicable";
  if (!claimStatus || !evidenceStatus) return "unknown";

  const cn = normalizeActualForecast(claimStatus);
  const en = normalizeActualForecast(evidenceStatus);

  if (!cn || !en) return "unknown";
  if (cn === en) return "compatible";
  return "incompatible";
}

function normalizeActualForecast(status: string): string | null {
  const s = status.trim().toLowerCase();
  if (s === "actual" || s === "actuals" || s === "reported" || s === "le" || s === "latest_estimate") return "actual";
  if (s === "forecast" || s === "budget" || s === "plan" || s === "projected") return "forecast";
  return null;
}

// ---------------------------------------------------------------------------
// Accounting Basis
// ---------------------------------------------------------------------------

function evaluateAccountingBasisCompat(
  claimBasis: string | null,
  evidenceBasis: string | null,
): CompatibilityDecision {
  if (!claimBasis && !evidenceBasis) return "not_applicable";
  if (!claimBasis || !evidenceBasis) return "not_applicable"; // If one is absent, don't block

  const cn = claimBasis.trim().toLowerCase();
  const en = evidenceBasis.trim().toLowerCase();
  if (cn === en) return "compatible";

  // Reported vs adjusted — INCOMPATIBLE
  const reported = ["reported", "statutory", "gaap", "ifrs"];
  const adjusted = ["adjusted", "non-gaap", "pro_forma", "underlying"];
  const cnIsReported = reported.some(t => cn.includes(t));
  const cnIsAdjusted = adjusted.some(t => cn.includes(t));
  const enIsReported = reported.some(t => en.includes(t));
  const enIsAdjusted = adjusted.some(t => en.includes(t));

  if ((cnIsReported && enIsAdjusted) || (cnIsAdjusted && enIsReported)) {
    return "incompatible";
  }

  return "compatible"; // Same or unknown basis — allow (don't fail closed on accounting basis alone)
}

// ---------------------------------------------------------------------------
// Comparison Basis
// ---------------------------------------------------------------------------

/**
 * Determines the comparison basis:
 * - memo_vs_model: IC memo claim vs current financial model
 * - live_vs_reference: current model vs hardcoded/frozen model
 * - same_basis: both from same source type
 */
function evaluateComparisonBasisCompat(
  claimBasis: string | null,
  evidenceBasis: string | null,
): CompatibilityDecision {
  // Comparison basis doesn't block — it changes verdict category
  if (!claimBasis || !evidenceBasis) return "not_applicable";

  const cn = claimBasis.trim().toLowerCase();
  const en = evidenceBasis.trim().toLowerCase();
  if (cn === en) return "compatible";

  // These represent different valid comparison types — "compatible" in the sense
  // that a comparison can proceed, but verdict interpretation differs
  return "compatible";
}

// ===========================================================================
// B. Normalization Engine
// ===========================================================================

export interface NormalizationResult {
  normalized_value: number;
  original_value: number | string;
  original_unit: string | null;
  original_scale: string | null;
  normalized_unit: string;
  rule_applied: string;
}

/**
 * Normalize a value to its base unit.
 * £194m → 194000000
 * £184,391,535 → 184391535
 * 16.7% → 0.167
 * 100bp → 0.01
 * 10pp → 0.10
 */
export function normalizeValue(
  value: number | string | null,
  unit: string | null,
  scale: string | null,
): NormalizationResult | null {
  if (value === null || value === undefined) return null;

  const numericValue = typeof value === "string" ? parseNumericString(value) : value;
  if (numericValue === null || !isFinite(numericValue)) return null;

  const unitLower = (unit ?? "").trim().toLowerCase();
  const scaleLower = (scale ?? "").trim().toLowerCase();

  // Percentage family
  if (unitLower.includes("percent") || unitLower === "%" || unitLower === "pct") {
    // If the value looks like it's already 0-1 (e.g., 0.167), keep it
    // If it looks like a display percentage (e.g., 16.7), divide by 100
    const normalizedPct = Math.abs(numericValue) <= 1 ? numericValue : numericValue / 100;
    return {
      normalized_value: normalizedPct,
      original_value: value,
      original_unit: unit,
      original_scale: scale,
      normalized_unit: "ratio",
      rule_applied: "percentage_to_ratio",
    };
  }

  // Percentage points → ratio
  if (unitLower.includes("percentage_point") || unitLower === "pp" || unitLower === "ppts") {
    const normalizedPp = numericValue / 100;
    return {
      normalized_value: normalizedPp,
      original_value: value,
      original_unit: unit,
      original_scale: scale,
      normalized_unit: "ratio",
      rule_applied: "percentage_points_to_ratio",
    };
  }

  // Basis points → ratio
  if (unitLower.includes("basis_point") || unitLower === "bps" || unitLower === "bp") {
    const normalizedBp = numericValue / 10000;
    return {
      normalized_value: normalizedBp,
      original_value: value,
      original_unit: unit,
      original_scale: scale,
      normalized_unit: "ratio",
      rule_applied: "basis_points_to_ratio",
    };
  }

  // Currency/count with scale
  const scaleFactor = resolveScaleFactor(scaleLower, unitLower);
  if (scaleFactor === null) return null; // Unknown scale — fail closed

  return {
    normalized_value: numericValue * scaleFactor,
    original_value: value,
    original_unit: unit,
    original_scale: scale,
    normalized_unit: "base_currency",
    rule_applied: scaleFactor === 1 ? "raw_value" : `scale_${scaleLower || "from_unit"}`,
  };
}

/**
 * Resolve scale multiplier. Returns null for unknown/ambiguous scales.
 */
function resolveScaleFactor(scale: string, unit: string): number | null {
  // Explicit scale field
  if (scale === "millions" || scale === "m") return 1_000_000;
  if (scale === "thousands" || scale === "k") return 1_000;
  if (scale === "billions" || scale === "b") return 1_000_000_000;
  if (scale === "raw" || scale === "units" || scale === "absolute" || scale === "") {
    // Check if unit contains scale info
    if (unit.includes("_millions") || unit.includes("m")) {
      // Distinguish: "gbp_millions" means millions
      if (unit.includes("_millions")) return 1_000_000;
      // Plain "m" in unit might be ambiguous — only accept if it's a suffix pattern
    }
    if (unit.includes("_thousands")) return 1_000;
    return 1; // Raw value
  }

  // Scale from unit suffix
  if (unit.includes("_millions")) return 1_000_000;
  if (unit.includes("_thousands")) return 1_000;

  // Unknown scale — fail closed
  if (scale && scale !== "raw" && scale !== "units" && scale !== "absolute") return null;

  return 1;
}

/**
 * Parse numeric string values (handling commas, currency symbols, suffixes).
 * "£194m" → 194000000
 * "£184,391,535" → 184391535
 * "194.4" → 194.4
 */
function parseNumericString(value: string): number | null {
  let s = value.trim();

  // Remove currency symbols
  s = s.replace(/[£$€¥]/g, "");

  // Check for suffix multipliers
  const suffixMatch = s.match(/^([0-9,._\-]+)\s*(m|mm|k|bn|b|million|thousand|billion)s?$/i);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1].replace(/,/g, ""));
    const suffix = suffixMatch[2].toLowerCase();
    if (isNaN(num)) return null;
    if (suffix === "m" || suffix === "mm" || suffix === "million") return num * 1_000_000;
    if (suffix === "k" || suffix === "thousand") return num * 1_000;
    if (suffix === "bn" || suffix === "b" || suffix === "billion") return num * 1_000_000_000;
  }

  // Remove commas and try to parse
  s = s.replace(/,/g, "");

  // Remove trailing % if present
  if (s.endsWith("%")) {
    const num = parseFloat(s.slice(0, -1));
    return isNaN(num) ? null : num;
  }

  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

// ===========================================================================
// C. Calculation Engine
// ===========================================================================

/**
 * Zero-denominator tolerance for percentage calculations
 */
const ZERO_THRESHOLD = 1e-10;

/**
 * Materiality threshold for confirmed/contradicted distinction
 */
const CONFIRMED_TOLERANCE_PCT = 1.0; // 1% tolerance for "confirmed"
const MATERIAL_THRESHOLD_PCT = 5.0;  // 5% for "materially different"

/**
 * Calculate deterministic numeric deltas.
 *
 * signed_delta = normalized_claim_value - normalized_fact_value
 * absolute_delta = abs(signed_delta)
 * percentage_delta = signed_delta / abs(normalized_fact_value) * 100
 */
export function calculateDeltas(
  normalizedClaimValue: number,
  normalizedFactValue: number,
): Pick<Calculation, "signed_delta" | "absolute_delta" | "percentage_delta" | "direction"> {
  const signed_delta = normalizedClaimValue - normalizedFactValue;
  const absolute_delta = Math.abs(signed_delta);

  let percentage_delta: number | null;
  if (Math.abs(normalizedFactValue) < ZERO_THRESHOLD) {
    // Zero denominator: percentage is undefined
    percentage_delta = null;
  } else {
    percentage_delta = (signed_delta / Math.abs(normalizedFactValue)) * 100;
  }

  let direction: Direction;
  if (Math.abs(signed_delta) < ZERO_THRESHOLD) {
    direction = "equal";
  } else if (signed_delta > 0) {
    direction = "claim_higher";
  } else {
    direction = "claim_lower";
  }

  return { signed_delta, absolute_delta, percentage_delta, direction };
}

// ===========================================================================
// D. Verdict Engine
// ===========================================================================

/**
 * Assign deterministic verdict based on comparison type and calculation results.
 */
export function assignVerdict(
  compatibility: DimensionCompatibility,
  calculation: Calculation,
  comparisonBasisInfo: { claim_basis: string | null; evidence_basis: string | null },
): Verdict {
  // If compatibility is rejected → unverifiable
  if (!compatibility.allowed) {
    return {
      value: "unverifiable",
      rule_version: VERDICT_RULE_VERSION,
      reason_codes: ["compatibility_rejected", ...compatibility.rejection_reasons],
    };
  }

  // If calculation was not performed (qualitative or not_performed)
  if (calculation.calculation_type !== "numeric") {
    return {
      value: "unverifiable",
      rule_version: VERDICT_RULE_VERSION,
      reason_codes: ["no_numeric_calculation"],
    };
  }

  // Null deltas (shouldn't happen if numeric, but guard)
  if (calculation.percentage_delta === null && calculation.signed_delta === null) {
    return {
      value: "unverifiable",
      rule_version: VERDICT_RULE_VERSION,
      reason_codes: ["null_delta"],
    };
  }

  // Determine if this is a forecast revision (live vs reference)
  const isForcastRevision = isLiveVsReferenceComparison(
    comparisonBasisInfo.claim_basis,
    comparisonBasisInfo.evidence_basis,
  );

  // Use percentage delta if available, otherwise absolute for verdict
  const pctDelta = calculation.percentage_delta;

  if (pctDelta !== null) {
    const absPct = Math.abs(pctDelta);

    // Within tolerance → confirmed
    if (absPct <= CONFIRMED_TOLERANCE_PCT) {
      return {
        value: "confirmed",
        rule_version: VERDICT_RULE_VERSION,
        reason_codes: ["within_tolerance", `pct_delta_${pctDelta.toFixed(4)}`],
      };
    }

    // Forecast revision → materially_changed
    if (isForcastRevision) {
      return {
        value: "materially_changed",
        rule_version: VERDICT_RULE_VERSION,
        reason_codes: ["forecast_revision", `pct_delta_${pctDelta.toFixed(4)}`],
      };
    }

    // Material difference in memo-vs-model → contradicted
    if (absPct > CONFIRMED_TOLERANCE_PCT) {
      return {
        value: "contradicted",
        rule_version: VERDICT_RULE_VERSION,
        reason_codes: ["material_difference", `pct_delta_${pctDelta.toFixed(4)}`],
      };
    }
  }

  // Zero denominator but non-zero signed delta
  if (calculation.signed_delta !== null && Math.abs(calculation.signed_delta) > ZERO_THRESHOLD) {
    if (isForcastRevision) {
      return {
        value: "materially_changed",
        rule_version: VERDICT_RULE_VERSION,
        reason_codes: ["forecast_revision", "zero_denominator"],
      };
    }
    return {
      value: "contradicted",
      rule_version: VERDICT_RULE_VERSION,
      reason_codes: ["non_zero_delta_zero_denominator"],
    };
  }

  return {
    value: "confirmed",
    rule_version: VERDICT_RULE_VERSION,
    reason_codes: ["zero_delta"],
  };
}

/**
 * Detect live-vs-reference (hardcoded) comparison basis.
 * FS Summary vs FS Summary (hardcoded) = forecast revision.
 */
function isLiveVsReferenceComparison(
  claimBasis: string | null,
  evidenceBasis: string | null,
): boolean {
  if (!claimBasis || !evidenceBasis) return false;
  const cb = claimBasis.trim().toLowerCase();
  const eb = evidenceBasis.trim().toLowerCase();

  // Live vs hardcoded/frozen/reference
  const liveTerms = ["live", "current", "fs_summary", "fs summary"];
  const refTerms = ["hardcoded", "frozen", "reference", "fs summary (hardcoded)", "fs_summary_hardcoded"];

  const cbIsLive = liveTerms.some(t => cb.includes(t));
  const cbIsRef = refTerms.some(t => cb.includes(t));
  const ebIsLive = liveTerms.some(t => eb.includes(t));
  const ebIsRef = refTerms.some(t => eb.includes(t));

  return (cbIsLive && ebIsRef) || (cbIsRef && ebIsLive);
}

// ===========================================================================
// E. Complete Comparison Orchestration
// ===========================================================================

/**
 * Execute a complete canonical comparison between a claim and evidence.
 * This is the production boundary function.
 */
export function executeCanonicalComparison(
  claim: ComparisonClaimInput,
  evidence: ComparisonEvidenceInput,
): CanonicalComparison {
  // 1. Evaluate compatibility
  const compatibility = evaluateCompatibility(claim, evidence);

  // 2. Determine calculation type and perform if compatible
  let calculation: Calculation;

  if (!compatibility.allowed) {
    calculation = {
      calculation_type: "not_performed",
      normalized_claim_value: null,
      normalized_fact_value: null,
      signed_delta: null,
      absolute_delta: null,
      percentage_delta: null,
      direction: "not_applicable",
      normalization_rule_version: NORMALIZATION_RULE_VERSION,
    };
  } else {
    // Attempt numeric normalization
    const claimNorm = normalizeValue(claim.value, claim.unit, claim.scale);
    const evidenceNorm = normalizeValue(evidence.value, evidence.unit, evidence.scale);

    if (claimNorm && evidenceNorm) {
      const deltas = calculateDeltas(claimNorm.normalized_value, evidenceNorm.normalized_value);
      calculation = {
        calculation_type: "numeric",
        normalized_claim_value: claimNorm.normalized_value,
        normalized_fact_value: evidenceNorm.normalized_value,
        signed_delta: deltas.signed_delta,
        absolute_delta: deltas.absolute_delta,
        percentage_delta: deltas.percentage_delta,
        direction: deltas.direction,
        normalization_rule_version: NORMALIZATION_RULE_VERSION,
      };
    } else {
      // Qualitative comparison — values can't be normalized to numbers
      calculation = {
        calculation_type: "qualitative",
        normalized_claim_value: null,
        normalized_fact_value: null,
        signed_delta: null,
        absolute_delta: null,
        percentage_delta: null,
        direction: "not_applicable",
        normalization_rule_version: NORMALIZATION_RULE_VERSION,
      };
    }
  }

  // 3. Assign verdict
  const verdict = assignVerdict(
    compatibility,
    calculation,
    { claim_basis: claim.comparison_basis, evidence_basis: evidence.comparison_basis },
  );

  // 4. Determine reportability
  const reportable = compatibility.allowed && calculation.calculation_type === "numeric";

  // 5. Generate comparison ID (content-derived, deterministic)
  const comparison_id = generateComparisonId(claim.claim_id, evidence.evidence_id);

  return {
    schema_version: COMPARISON_SCHEMA_VERSION,
    comparison_id,
    claim_id: claim.claim_id,
    evidence_id: evidence.evidence_id,
    compatibility,
    calculation,
    verdict,
    reportable,
  };
}

/**
 * Generate a content-derived comparison ID.
 */
function generateComparisonId(claimId: string, evidenceId: string): string {
  const input = `${COMPARISON_SCHEMA_VERSION}|${claimId}|${evidenceId}`;
  const hash = sha256hex(input);
  return `cmp-v1-${hash.slice(0, 16)}`;
}

// ===========================================================================
// F. Persistence
// ===========================================================================

export function serializeComparison(comparison: CanonicalComparison): string {
  return JSON.stringify(comparison);
}

export function deserializeComparison(json: string): CanonicalComparison {
  return JSON.parse(json) as CanonicalComparison;
}

export function serializeComparisonLedger(comparisons: CanonicalComparison[]): string {
  return JSON.stringify(comparisons);
}

export function deserializeComparisonLedger(json: string): CanonicalComparison[] {
  return JSON.parse(json) as CanonicalComparison[];
}
