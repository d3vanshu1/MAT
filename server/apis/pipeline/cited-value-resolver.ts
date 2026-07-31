/**
 * Cited-Value Resolver — coordinate-based verification of numeric claims in findings.
 *
 * For each finding in the pipeline output, extracts cited monetary/numeric values
 * from evidence and severity_anchor fields, then matches them against the verified
 * figures from NumericVerifyInline. Produces a per-citation verification status:
 *
 *   verified   — value matches a verified source figure within tolerance
 *   mismatched — value matches a coordinate (metric+period) but differs in magnitude
 *   unresolved — no matching coordinate found in the verified figure set
 *   ambiguous  — multiple figures match the coordinate with conflicting values
 *
 * Findings with high unresolved/mismatched ratios receive the `numeric_unverified`
 * flag so downstream formatting can flag them appropriately.
 *
 * Design principles:
 *   1. Pure function — no DB calls, no side effects. Takes findings + figures, returns annotated findings.
 *   2. Tolerant parsing — handles £19k, £184.4m, $2.1bn, 19,000, etc.
 *   3. Coordinate resolution in descending strength:
 *      a. Exact document + sheet/page + cell/coordinate
 *      b. Document + metric + period + scope
 *      c. Document + metric + period
 *      d. Metric + period + scope (only when unique)
 *      e. Metric + period (only when unique and no stronger supplied context)
 *   4. Value comparison AFTER coordinate resolution (not before).
 *   5. Currency and unit safety (GBP ≠ USD, percentages ≠ monetary, basis points ≠ monetary).
 *   6. Configurable tolerance — default 2% relative, £0.5m absolute floor.
 *
 * Version history:
 *   v1: Initial cited-value verification (Fix 6 — Commit 2)
 *   v2: Corrective B — tighter flagging (MIN_CITATIONS=1, MISMATCHED_THRESHOLD=0)
 *   v3: Fix 9 — Full coordinate resolution with evidence metadata preservation
 *   v3.1: Fix 9D — Consume canonical EvidenceItem type directly (schema closure)
 */

import type { EvidenceItem } from "./canonical-finding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CitedValueStatus = "verified" | "mismatched" | "unresolved" | "ambiguous";

/** Unit type for distinguishing monetary from rate values */
export type ValueUnit = "monetary" | "percentage" | "basis_points" | "ratio" | "count" | "unknown";

export interface CitedValue {
  /** Raw text as found in the finding (e.g. "£184.4m", "£19k") */
  rawText: string;
  /** Normalized value in base units (e.g. 184_400_000 for £184.4m) */
  normalizedValue: number;
  /** Currency detected */
  currency: "GBP" | "USD" | "EUR" | "other";
  /** Value unit type */
  unit: ValueUnit;
  /** Source field where this value was found */
  sourceField: "evidence" | "severity_anchor" | "detail" | "structured_impact";

  // --- Full evidence coordinates (Fix 9) ---
  /** Source document ID */
  documentId?: string;
  /** Source filename */
  sourceFilename?: string;
  /** Document role (e.g. "ic_memo", "financial_model") */
  documentRole?: string;
  /** Sheet or page identifier */
  sheetOrPage?: string;
  /** Cell or table coordinate (e.g. "B12", "row:Revenue/col:FY2026") */
  cellCoordinate?: string;
  /** Metric coordinate if extractable (e.g. "revenue") */
  metric?: string;
  /** Period coordinate if extractable (e.g. "FY2024") */
  period?: string;
  /** Scope (e.g. "group", "UK", "segment_A") */
  scope?: string;
  /** Accounting basis (e.g. "actual", "forecast", "budget") */
  accountingBasis?: string;
}

export interface CitedValueResolution {
  citedValue: CitedValue;
  status: CitedValueStatus;
  /** Resolution tier that produced the match */
  matchTier?: "exact_cell" | "doc_metric_period_scope" | "doc_metric_period" | "unique_metric_period_scope" | "unique_metric_period";
  /** Matched verified figure value (when status is verified or mismatched) */
  matchedValue?: number;
  /** Source document of the matched figure */
  matchedSource?: string;
  /** Relative difference when mismatched */
  relativeDiff?: number;
}

export interface FindingVerificationResult {
  /** Finding ID */
  findingId: string;
  /** All cited values found in this finding */
  citations: CitedValueResolution[];
  /** Summary counts */
  verified: number;
  mismatched: number;
  unresolved: number;
  ambiguous: number;
  /** Whether this finding should be flagged as numeric_unverified */
  shouldFlagUnverified: boolean;
}

/** Verified figure from NumericVerifyInline */
export interface VerifiedFigure {
  name: string;
  period: string;
  value: number;
  source_doc: string;
  source_cell: string;
  source_sheet: string;
  /** Currency of the figure (optional — when present, enables cross-currency rejection) */
  currency?: "GBP" | "USD" | "EUR" | "other";
  /** Document ID (UUID) when available */
  document_id?: string;
  /** Scope of the figure (e.g. "group", "UK") */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Relative tolerance for value matching (2% — handles rounding differences) */
const RELATIVE_TOLERANCE = 0.02;

/** Absolute tolerance floor in base units (£500k — prevents micro-differences from triggering mismatches) */
const ABSOLUTE_TOLERANCE = 500_000;

/** One mismatched or ambiguous central citation is enough to flag.
 *  Findings with 0 citations (no numeric content) are NOT flagged. */
const MIN_CITATIONS_FOR_FLAG = 1;

/** Maximum allowed unresolved ratio before flagging */
const UNRESOLVED_THRESHOLD = 0.5;

/** Maximum allowed mismatched ratio before flagging */
const MISMATCHED_THRESHOLD = 0.0; // Any mismatch at all triggers flag

// ---------------------------------------------------------------------------
// Value Parsing
// ---------------------------------------------------------------------------

/** Currency symbols and their canonical codes */
const CURRENCY_MAP: Record<string, CitedValue["currency"]> = {
  "£": "GBP",
  "$": "USD",
  "€": "EUR",
};

/**
 * Detect if a text string represents a percentage or basis-point value.
 */
function detectUnit(text: string): ValueUnit {
  const trimmed = text.trim();
  if (/\d+\s*%/.test(trimmed)) return "percentage";
  if (/\d+\s*bps\b/i.test(trimmed)) return "basis_points";
  if (/\d+\s*bp\b/i.test(trimmed)) return "basis_points";
  if (/\d+\s*basis\s*points?\b/i.test(trimmed)) return "basis_points";
  if (/[£$€]/.test(trimmed)) return "monetary";
  if (/\d+\s*(k|m|mn|million|bn|billion)\b/i.test(trimmed)) return "monetary";
  return "unknown";
}

/**
 * Parse a monetary/numeric string into a normalized base-unit value.
 * Handles: £184.4m, £19k, $2.1bn, £19,000, 184.4 million, etc.
 *
 * Returns null if the string doesn't contain a parseable numeric value.
 */
export function parseMonetaryValue(text: string): { value: number; currency: CitedValue["currency"]; rawMatch: string; unit: ValueUnit } | null {
  const unit = detectUnit(text);

  // Reject percentage and basis-point values from monetary parsing
  if (unit === "percentage" || unit === "basis_points") {
    // Still parse for test purposes but mark as non-monetary
    const numPattern = /([\d,.]+)\s*(%|bps?|basis\s*points?)/gi;
    const match = numPattern.exec(text);
    if (match) {
      const num = parseFloat(match[1].replace(/,/g, ""));
      if (isNaN(num)) return null;
      return { value: num, currency: "other", rawMatch: match[0], unit };
    }
    return null;
  }

  // Pattern 1: Currency symbol + number + suffix (£184.4m, $2.1bn, €19k)
  const suffixPattern = /([£$€])\s*([\d,.]+)\s*(k|m|mn|million|bn|billion|b)?\b/gi;

  // Pattern 2: Number + "million"/"billion"/"thousand" (184.4 million)
  const wordPattern = /([\d,.]+)\s+(thousand|million|billion)/gi;

  // Pattern 3: Currency symbol + plain number (£19,000, $2,100,000)
  const plainPattern = /([£$€])\s*([\d,]+(?:\.\d+)?)\b/gi;

  // Try suffix pattern first (most specific)
  let match = suffixPattern.exec(text);
  if (match) {
    const currency = CURRENCY_MAP[match[1]] ?? "other";
    const num = parseFloat(match[2].replace(/,/g, ""));
    if (isNaN(num)) return null;
    const multiplier = getMultiplier(match[3]);
    return { value: num * multiplier, currency, rawMatch: match[0], unit: "monetary" };
  }

  // Try word pattern
  match = wordPattern.exec(text);
  if (match) {
    const num = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(num)) return null;
    const multiplier = getMultiplier(match[2]);
    return { value: num * multiplier, currency: "other", rawMatch: match[0], unit: "monetary" };
  }

  // Try plain pattern (currency + large number)
  match = plainPattern.exec(text);
  if (match) {
    const currency = CURRENCY_MAP[match[1]] ?? "other";
    const num = parseFloat(match[2].replace(/,/g, ""));
    if (isNaN(num)) return null;
    // Only consider as monetary if >= 1000 (avoid matching page numbers etc.)
    if (num < 1000) return null;
    return { value: num, currency, rawMatch: match[0], unit: "monetary" };
  }

  return null;
}

/**
 * Extract ALL monetary values from a text string.
 */
export function extractAllMonetaryValues(text: string): Array<{ value: number; currency: CitedValue["currency"]; rawMatch: string; unit: ValueUnit }> {
  const results: Array<{ value: number; currency: CitedValue["currency"]; rawMatch: string; unit: ValueUnit }> = [];
  const seen = new Set<string>();

  // Pattern: Currency + number + optional suffix
  const pattern = /([£$€])\s*([\d,.]+)\s*(k|m|mn|million|bn|billion|b)?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const currency = CURRENCY_MAP[match[1]] ?? "other";
    const num = parseFloat(match[2].replace(/,/g, ""));
    if (isNaN(num)) continue;
    const multiplier = getMultiplier(match[3]);
    // Filter out tiny values that are likely not monetary (page numbers, etc.)
    const value = num * multiplier;
    if (value < 1000) continue;
    results.push({ value, currency, rawMatch: raw, unit: "monetary" });
  }

  return results;
}

function getMultiplier(suffix: string | undefined): number {
  if (!suffix) return 1;
  switch (suffix.toLowerCase()) {
    case "k": return 1_000;
    case "m":
    case "mn":
    case "million": return 1_000_000;
    case "bn":
    case "billion":
    case "b": return 1_000_000_000;
    case "thousand": return 1_000;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Coordinate Matching (Fix 9 — tiered resolution)
// ---------------------------------------------------------------------------

/** Normalize a metric name for fuzzy matching */
function normalizeMetric(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/ebitda/g, "ebitda")
    .replace(/revenue|sales|turnover/g, "revenue")
    .replace(/netincome|netprofit|pat/g, "netincome")
    .replace(/grossprofit|gp/g, "grossprofit");
}

/** Normalize a period string for fuzzy matching */
function normalizePeriod(period: string): string {
  return period.toLowerCase()
    .replace(/\s+/g, "")
    .replace(/fy(\d{2})(\d{2})?/g, (_, y1, y2) => y2 ? `fy${y1}${y2}` : `fy20${y1}`)
    .replace(/h(\d)\s*(\d{4})/g, "h$1$2");
}

/** Normalize a sheet/page identifier */
function normalizeSheet(sheet: string): string {
  return sheet.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Check if two values are within tolerance of each other.
 */
export function valuesWithinTolerance(a: number, b: number): boolean {
  const absDiff = Math.abs(a - b);
  if (absDiff <= ABSOLUTE_TOLERANCE) return true;
  const relDiff = Math.max(Math.abs(a), Math.abs(b)) > 0
    ? absDiff / Math.max(Math.abs(a), Math.abs(b))
    : 0;
  return relDiff <= RELATIVE_TOLERANCE;
}

/**
 * Check if a cited value's unit is compatible with a figure for comparison.
 * Percentages must not match monetary, basis points must not match monetary.
 */
function unitsCompatible(citedUnit: ValueUnit, figureIsMonetary: boolean): boolean {
  if (citedUnit === "percentage" || citedUnit === "basis_points") {
    // Rate values must NEVER match monetary figures
    return !figureIsMonetary;
  }
  if (citedUnit === "monetary" || citedUnit === "unknown") {
    return figureIsMonetary;
  }
  return true;
}

/**
 * Find matching figures for a cited value using tiered coordinate resolution.
 *
 * Fix 9: Resolution proceeds in descending coordinate strength.
 * Value comparison happens AFTER coordinate resolution (not before).
 *
 * Tiers:
 *   1. Exact document + sheet/page + cell/coordinate
 *   2. Document + metric + period + scope
 *   3. Document + metric + period
 *   4. Metric + period + scope (only when unique)
 *   5. Metric + period (only when unique and no stronger context)
 *
 * Returns the candidate set from the strongest matching tier.
 * Empty result means unresolved (no coordinates matched).
 */
function findCandidatesByCoordinate(
  cited: CitedValue,
  figures: VerifiedFigure[]
): { candidates: VerifiedFigure[]; tier: CitedValueResolution["matchTier"] } {

  // --- Tier 1: Exact document + sheet + cell ---
  if (cited.documentId && cited.sheetOrPage && cited.cellCoordinate) {
    const exact = figures.filter(f =>
      f.document_id === cited.documentId &&
      normalizeSheet(f.source_sheet) === normalizeSheet(cited.sheetOrPage!) &&
      f.source_cell.toLowerCase() === cited.cellCoordinate!.toLowerCase()
    );
    if (exact.length > 0) return { candidates: exact, tier: "exact_cell" };
  }

  // --- Tier 2: Document + metric + period + scope ---
  if (cited.documentId && cited.metric && cited.period && cited.scope) {
    const normMetric = normalizeMetric(cited.metric);
    const normPeriod = normalizePeriod(cited.period);
    const normScope = cited.scope.toLowerCase().replace(/\s+/g, "");
    const matches = figures.filter(f =>
      f.document_id === cited.documentId &&
      normalizeMetric(f.name) === normMetric &&
      normalizePeriod(f.period) === normPeriod &&
      (f.scope?.toLowerCase().replace(/\s+/g, "") === normScope)
    );
    if (matches.length > 0) return { candidates: matches, tier: "doc_metric_period_scope" };
  }

  // --- Tier 3: Document + metric + period ---
  if (cited.documentId && cited.metric && cited.period) {
    const normMetric = normalizeMetric(cited.metric);
    const normPeriod = normalizePeriod(cited.period);
    const matches = figures.filter(f =>
      f.document_id === cited.documentId &&
      normalizeMetric(f.name) === normMetric &&
      normalizePeriod(f.period) === normPeriod
    );
    if (matches.length > 0) return { candidates: matches, tier: "doc_metric_period" };
  }

  // --- Tier 4: Metric + period + scope (global, only when unique) ---
  if (cited.metric && cited.period && cited.scope) {
    const normMetric = normalizeMetric(cited.metric);
    const normPeriod = normalizePeriod(cited.period);
    const normScope = cited.scope.toLowerCase().replace(/\s+/g, "");
    const matches = figures.filter(f =>
      normalizeMetric(f.name) === normMetric &&
      normalizePeriod(f.period) === normPeriod &&
      (f.scope?.toLowerCase().replace(/\s+/g, "") === normScope)
    );
    if (matches.length === 1) return { candidates: matches, tier: "unique_metric_period_scope" };
    // If >1 match, fall through — multi-source metric+period+scope is ambiguous at this tier
    if (matches.length > 1) return { candidates: matches, tier: "unique_metric_period_scope" };
  }

  // --- Tier 5: Metric + period (global, only when unique) ---
  if (cited.metric && cited.period) {
    const normMetric = normalizeMetric(cited.metric);
    const normPeriod = normalizePeriod(cited.period);
    const matches = figures.filter(f =>
      normalizeMetric(f.name) === normMetric &&
      normalizePeriod(f.period) === normPeriod
    );
    // Only accept if unique — multiple values for same metric/period is ambiguous
    if (matches.length === 1) return { candidates: matches, tier: "unique_metric_period" };
    if (matches.length > 1) return { candidates: matches, tier: "unique_metric_period" };
  }

  // No coordinate matches — unresolved
  return { candidates: [], tier: undefined };
}

// ---------------------------------------------------------------------------
// Finding-Level Resolution
// ---------------------------------------------------------------------------

// Fix 9D: EvidenceItem is now imported from canonical-finding.ts — fields survive
// the full pipeline (raw → parse → checkpoint → reload → here) without stripping.

/**
 * Extract all cited numeric values from a finding's fields.
 * Fix 9: Preserves full evidence coordinates.
 */
function extractCitedValues(finding: {
  evidence?: EvidenceItem[];
  severity_anchor?: string;
  detail?: string;
  structured_impact?: Array<{ amount: number; currency: string; unit_multiplier: number; role: string }>;
}): CitedValue[] {
  const results: CitedValue[] = [];

  // From evidence items — preserve full coordinates
  if (finding.evidence) {
    for (const ev of finding.evidence) {
      const parsed = parseMonetaryValue(ev.figure);
      if (parsed) {
        results.push({
          rawText: ev.figure,
          normalizedValue: parsed.value,
          currency: parsed.currency,
          unit: parsed.unit,
          sourceField: "evidence",
          metric: ev.metric,
          period: ev.period,
          // Fix 9: Full coordinate preservation
          documentId: ev.document_id,
          sourceFilename: ev.source_filename,
          documentRole: ev.document_role,
          sheetOrPage: ev.sheet_or_page,
          cellCoordinate: ev.cell_coordinate,
          scope: ev.scope,
          accountingBasis: ev.accounting_basis,
        });
      }
    }
  }

  // From severity_anchor
  if (finding.severity_anchor) {
    const values = extractAllMonetaryValues(finding.severity_anchor);
    for (const v of values) {
      // Avoid duplicates already found in evidence
      if (!results.some(r => Math.abs(r.normalizedValue - v.value) < 1)) {
        results.push({
          rawText: v.rawMatch,
          normalizedValue: v.value,
          currency: v.currency,
          unit: v.unit,
          sourceField: "severity_anchor",
        });
      }
    }
  }

  // From structured_impact (already numeric — just need to normalize)
  if (finding.structured_impact) {
    for (const impact of finding.structured_impact) {
      const normalizedValue = impact.amount * impact.unit_multiplier;
      if (normalizedValue < 1000) continue; // Skip trivially small values
      // Avoid duplicates
      if (!results.some(r => Math.abs(r.normalizedValue - normalizedValue) < 1)) {
        results.push({
          rawText: `${impact.currency === "GBP" ? "£" : impact.currency === "USD" ? "$" : ""}${impact.amount}`,
          normalizedValue,
          currency: (impact.currency as CitedValue["currency"]) ?? "other",
          unit: "monetary",
          sourceField: "structured_impact",
        });
      }
    }
  }

  return results;
}

/**
 * Resolve a single cited value against the verified figure set.
 * Fix 9: Uses tiered coordinate resolution. Value comparison after coordinate match.
 */
function resolveCitedValue(
  cited: CitedValue,
  figures: VerifiedFigure[]
): CitedValueResolution {
  // --- Unit safety (Fix 9D) ---
  // Percentages and basis points must never match monetary figures.
  if (cited.unit === "percentage" || cited.unit === "basis_points") {
    // These are rate values — they cannot verify against the monetary figure inventory.
    // Mark as unresolved (they need a separate rate-figure verification path).
    return { citedValue: cited, status: "unresolved" };
  }

  // --- Currency pre-filter ---
  // When cited currency is known, exclude figures with a conflicting explicit currency
  const currencyCompatible = figures.filter(f => {
    if (cited.currency === "other") return true;
    if (!f.currency || f.currency === "other") return true;
    return f.currency === cited.currency;
  });

  if (currencyCompatible.length === 0 && figures.length > 0) {
    // All figures have conflicting currency → unresolved
    return { citedValue: cited, status: "unresolved" };
  }

  // --- Coordinate resolution (Fix 9B) ---
  const { candidates, tier } = findCandidatesByCoordinate(cited, currencyCompatible);

  if (candidates.length === 0) {
    return { citedValue: cited, status: "unresolved" };
  }

  // --- Ambiguity check: multiple candidates with different values ---
  const uniqueValues = new Set(candidates.map(c => Math.round(c.value)));
  if (uniqueValues.size > 1 && candidates.length > 1) {
    // Fix 9C: Multiple surviving candidates with conflicting values = ambiguous
    return { citedValue: cited, status: "ambiguous", matchTier: tier };
  }

  // --- Value comparison AFTER coordinate resolution (Fix 9C) ---
  const bestMatch = candidates[0];
  if (valuesWithinTolerance(cited.normalizedValue, bestMatch.value)) {
    return {
      citedValue: cited,
      status: "verified",
      matchTier: tier,
      matchedValue: bestMatch.value,
      matchedSource: bestMatch.source_doc,
    };
  }

  // Value doesn't match → mismatched
  const absDiff = Math.abs(cited.normalizedValue - bestMatch.value);
  const maxVal = Math.max(Math.abs(cited.normalizedValue), Math.abs(bestMatch.value));
  const relativeDiff = maxVal > 0 ? absDiff / maxVal : 0;

  return {
    citedValue: cited,
    status: "mismatched",
    matchTier: tier,
    matchedValue: bestMatch.value,
    matchedSource: bestMatch.source_doc,
    relativeDiff,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve all cited numeric values in a set of findings against the verified figure set.
 *
 * Returns per-finding verification results with individual citation statuses.
 * Does NOT mutate the input findings.
 */
export function resolveCitedValues(
  findings: Array<{
    finding_id: string;
    evidence?: EvidenceItem[];
    severity_anchor?: string;
    detail?: string;
    structured_impact?: Array<{ amount: number; currency: string; unit_multiplier: number; role: string }>;
  }>,
  figures: VerifiedFigure[]
): FindingVerificationResult[] {
  return findings.map(finding => {
    const citedValues = extractCitedValues(finding);
    const citations = citedValues.map(cv => resolveCitedValue(cv, figures));

    const verified = citations.filter(c => c.status === "verified").length;
    const mismatched = citations.filter(c => c.status === "mismatched").length;
    const unresolved = citations.filter(c => c.status === "unresolved").length;
    const ambiguous = citations.filter(c => c.status === "ambiguous").length;

    // Determine whether to flag as unverified.
    // One mismatched or ambiguous citation is sufficient.
    // Findings with NO citations (no numeric content) are NOT flagged.
    const totalCitations = citations.length;
    let shouldFlagUnverified = false;
    if (totalCitations >= MIN_CITATIONS_FOR_FLAG) {
      // Any mismatch at all → flag
      if (mismatched > 0) shouldFlagUnverified = true;
      // Any ambiguity → flag (treat as unverified/manual review)
      if (ambiguous > 0) shouldFlagUnverified = true;
      // High unresolved ratio → flag
      const unresolvedRatio = unresolved / totalCitations;
      if (unresolvedRatio >= UNRESOLVED_THRESHOLD) shouldFlagUnverified = true;
    }

    return {
      findingId: finding.finding_id,
      citations,
      verified,
      mismatched,
      unresolved,
      ambiguous,
      shouldFlagUnverified,
    };
  });
}

/**
 * Apply verification results to findings, setting the `numeric_unverified` flag
 * and enriching evidence items with verification status.
 *
 * Returns a NEW array of findings with modifications applied (does not mutate input).
 */
export function applyVerificationToFindings<T extends {
  finding_id: string;
  numeric_unverified?: boolean;
  evidence?: Array<{ figure: string; verbatim_snippet: string; verified: boolean; metric?: string; period?: string }>;
}>(
  findings: T[],
  results: FindingVerificationResult[]
): T[] {
  const resultMap = new Map(results.map(r => [r.findingId, r]));

  return findings.map(finding => {
    const result = resultMap.get(finding.finding_id);
    if (!result) return finding;

    const updated = { ...finding };

    // Set numeric_unverified flag
    if (result.shouldFlagUnverified) {
      updated.numeric_unverified = true;
    }

    // Enrich evidence items with verification status
    if (updated.evidence && result.citations.length > 0) {
      updated.evidence = updated.evidence.map(ev => {
        // Find the citation resolution for this evidence item
        const citation = result.citations.find(c =>
          c.citedValue.sourceField === "evidence" &&
          c.citedValue.rawText === ev.figure
        );
        if (citation && citation.status === "verified") {
          return { ...ev, verified: true };
        }
        return ev;
      });
    }

    return updated;
  });
}

/**
 * Format a verification diagnostic summary for the pipeline trace.
 */
export function formatVerificationDiagnostic(results: FindingVerificationResult[]): string {
  const total = results.reduce((sum, r) => sum + r.citations.length, 0);
  const verified = results.reduce((sum, r) => sum + r.verified, 0);
  const mismatched = results.reduce((sum, r) => sum + r.mismatched, 0);
  const unresolved = results.reduce((sum, r) => sum + r.unresolved, 0);
  const ambiguous = results.reduce((sum, r) => sum + r.ambiguous, 0);
  const flagged = results.filter(r => r.shouldFlagUnverified).length;

  return `CitedValueResolver: ${total} citations across ${results.length} findings — ` +
    `${verified} verified, ${mismatched} mismatched, ${unresolved} unresolved, ${ambiguous} ambiguous. ` +
    `${flagged} finding(s) flagged as numeric_unverified.`;
}
