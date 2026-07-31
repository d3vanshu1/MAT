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
 *   3. Coordinate matching — uses metric+period when available, falls back to value proximity.
 *   4. Configurable tolerance — default 2% relative, £0.5m absolute floor.
 *
 * Version history:
 *   v1: Initial cited-value verification (Fix 6 — Commit 2)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CitedValueStatus = "verified" | "mismatched" | "unresolved" | "ambiguous";

export interface CitedValue {
  /** Raw text as found in the finding (e.g. "£184.4m", "£19k") */
  rawText: string;
  /** Normalized value in base units (e.g. 184_400_000 for £184.4m) */
  normalizedValue: number;
  /** Currency detected */
  currency: "GBP" | "USD" | "EUR" | "other";
  /** Source field where this value was found */
  sourceField: "evidence" | "severity_anchor" | "detail" | "structured_impact";
  /** Metric coordinate if extractable (e.g. "revenue") */
  metric?: string;
  /** Period coordinate if extractable (e.g. "FY2024") */
  period?: string;
}

export interface CitedValueResolution {
  citedValue: CitedValue;
  status: CitedValueStatus;
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
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Relative tolerance for value matching (2% — handles rounding differences) */
const RELATIVE_TOLERANCE = 0.02;

/** Absolute tolerance floor in base units (£500k — prevents micro-differences from triggering mismatches) */
const ABSOLUTE_TOLERANCE = 500_000;

/** Minimum citation count before applying the unverified flag.
 *  Findings with 0-1 citations aren't meaningfully testable. */
const MIN_CITATIONS_FOR_FLAG = 2;

/** Maximum allowed unresolved ratio before flagging */
const UNRESOLVED_THRESHOLD = 0.5;

/** Maximum allowed mismatched ratio before flagging */
const MISMATCHED_THRESHOLD = 0.3;

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
 * Parse a monetary/numeric string into a normalized base-unit value.
 * Handles: £184.4m, £19k, $2.1bn, £19,000, 184.4 million, etc.
 *
 * Returns null if the string doesn't contain a parseable numeric value.
 */
export function parseMonetaryValue(text: string): { value: number; currency: CitedValue["currency"]; rawMatch: string } | null {
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
    return { value: num * multiplier, currency, rawMatch: match[0] };
  }

  // Try word pattern
  match = wordPattern.exec(text);
  if (match) {
    const num = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(num)) return null;
    const multiplier = getMultiplier(match[2]);
    return { value: num * multiplier, currency: "other", rawMatch: match[0] };
  }

  // Try plain pattern (currency + large number)
  match = plainPattern.exec(text);
  if (match) {
    const currency = CURRENCY_MAP[match[1]] ?? "other";
    const num = parseFloat(match[2].replace(/,/g, ""));
    if (isNaN(num)) return null;
    // Only consider as monetary if >= 1000 (avoid matching page numbers etc.)
    if (num < 1000) return null;
    return { value: num, currency, rawMatch: match[0] };
  }

  return null;
}

/**
 * Extract ALL monetary values from a text string.
 */
export function extractAllMonetaryValues(text: string): Array<{ value: number; currency: CitedValue["currency"]; rawMatch: string }> {
  const results: Array<{ value: number; currency: CitedValue["currency"]; rawMatch: string }> = [];
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
    results.push({ value, currency, rawMatch: raw });
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
// Coordinate Matching
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
 * Find matching figures for a cited value using coordinate-based resolution.
 *
 * Priority:
 *   1. Exact coordinate match (metric + period both match)
 *   2. Partial coordinate match (metric matches, period absent/different)
 *   3. Value proximity match (no coordinates, but value is within 5%)
 */
function findMatchingFigures(
  cited: CitedValue,
  figures: VerifiedFigure[]
): { matches: VerifiedFigure[]; matchType: "coordinate" | "partial" | "proximity" } {
  // Try exact coordinate match
  if (cited.metric && cited.period) {
    const normMetric = normalizeMetric(cited.metric);
    const normPeriod = normalizePeriod(cited.period);
    const exact = figures.filter(f =>
      normalizeMetric(f.name) === normMetric &&
      normalizePeriod(f.period) === normPeriod
    );
    if (exact.length > 0) return { matches: exact, matchType: "coordinate" };
  }

  // Try partial coordinate match (metric only)
  if (cited.metric) {
    const normMetric = normalizeMetric(cited.metric);
    const partial = figures.filter(f => normalizeMetric(f.name) === normMetric);
    if (partial.length > 0) return { matches: partial, matchType: "partial" };
  }

  // Try value proximity (within 5% of the cited value — looser than verification tolerance)
  const PROXIMITY_THRESHOLD = 0.05;
  const proximity = figures.filter(f => {
    const absDiff = Math.abs(f.value - cited.normalizedValue);
    const maxVal = Math.max(Math.abs(f.value), Math.abs(cited.normalizedValue));
    return maxVal > 0 && (absDiff / maxVal) <= PROXIMITY_THRESHOLD;
  });
  if (proximity.length > 0) return { matches: proximity, matchType: "proximity" };

  return { matches: [], matchType: "proximity" };
}

// ---------------------------------------------------------------------------
// Finding-Level Resolution
// ---------------------------------------------------------------------------

/**
 * Extract all cited numeric values from a finding's fields.
 */
function extractCitedValues(finding: {
  evidence?: Array<{ figure: string; verbatim_snippet: string; metric?: string; period?: string }>;
  severity_anchor?: string;
  detail?: string;
  structured_impact?: Array<{ amount: number; currency: string; unit_multiplier: number; role: string }>;
}): CitedValue[] {
  const results: CitedValue[] = [];

  // From evidence items
  if (finding.evidence) {
    for (const ev of finding.evidence) {
      const parsed = parseMonetaryValue(ev.figure);
      if (parsed) {
        results.push({
          rawText: ev.figure,
          normalizedValue: parsed.value,
          currency: parsed.currency,
          sourceField: "evidence",
          metric: ev.metric,
          period: ev.period,
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
          sourceField: "structured_impact",
        });
      }
    }
  }

  return results;
}

/**
 * Resolve a single cited value against the verified figure set.
 */
function resolveCitedValue(
  cited: CitedValue,
  figures: VerifiedFigure[]
): CitedValueResolution {
  const { matches, matchType } = findMatchingFigures(cited, figures);

  if (matches.length === 0) {
    return { citedValue: cited, status: "unresolved" };
  }

  // Check for ambiguity: multiple matches with conflicting values
  if (matches.length > 1) {
    const uniqueValues = new Set(matches.map(m => Math.round(m.value)));
    if (uniqueValues.size > 1) {
      // Multiple different values → ambiguous
      return { citedValue: cited, status: "ambiguous" };
    }
  }

  // Single match (or multiple consistent matches) — check tolerance
  const bestMatch = matches[0];
  if (valuesWithinTolerance(cited.normalizedValue, bestMatch.value)) {
    return {
      citedValue: cited,
      status: "verified",
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
    evidence?: Array<{ figure: string; verbatim_snippet: string; metric?: string; period?: string }>;
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

    // Determine whether to flag as unverified
    const totalCitations = citations.length;
    let shouldFlagUnverified = false;
    if (totalCitations >= MIN_CITATIONS_FOR_FLAG) {
      const unresolvedRatio = unresolved / totalCitations;
      const mismatchedRatio = mismatched / totalCitations;
      shouldFlagUnverified = unresolvedRatio >= UNRESOLVED_THRESHOLD || mismatchedRatio >= MISMATCHED_THRESHOLD;
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
