/**
 * Claims Reconciliation Engine — code-verified delta computation.
 *
 * ARCHITECTURE PRINCIPLE (non-negotiable):
 *   LLM proposes which model line a claim maps to.
 *   CODE pulls the model cell and computes the delta.
 *   No LLM-computed numbers anywhere.
 *
 * For each claim in the ledger (operating_metric category only):
 *   1. LLM proposes the matching model line by metric + scope_qualifier + period,
 *      or returns "no matching model line."
 *   2. Code pulls that model cell value from the verified figures set.
 *   3. Code computes the delta and classifies:
 *      - Matched scope + delta above materiality floor → data_divergence finding
 *      - Matched scope + within tolerance → no finding (or housekeeping)
 *      - No model counterpart → unreconcilable (info)
 *      - Scope mismatch → NEVER assert contradiction; flag "confirm like-for-like basis"
 *
 * Also runs the existing live-vs-hardcoded cross-version check and surfaces
 * it as a data_divergence finding.
 */
import { z } from "@superblocksteam/sdk-api";
import type { Claim, ClaimsLedger } from "./claims-extraction.js";
import type { Figure, Discrepancy } from "./numeric-verify-inline.js";
import type { PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// UUID helper (cross-environment — avoids Node `crypto` import that Vite externalizes)
// ---------------------------------------------------------------------------

function generateUUID(): string {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).crypto?.randomUUID === "function") {
    return (globalThis as any).crypto.randomUUID() as string;
  }
  // Fallback: v4-like UUID from Math.random (sufficient for report IDs)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationFinding {
  finding_kind: "data_divergence" | "unreconcilable" | "scope_mismatch" | "cross_version";
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  full_analysis: string;
  /** Numeric magnitude — for materiality-based severity tiering */
  severity_anchor: number | null;
  /** Source documents — derived in code, not LLM free-listed */
  source_docs: string[];
  /** The original claim that triggered this finding */
  claim: Claim;
  /** The matched model figure (null if unreconcilable) */
  model_figure: Figure | null;
  /** Computed delta (code-verified, never LLM-computed) */
  delta_abs: number | null;
  delta_pct: number | null;
  /**
   * Fix 11 + Fix 20: Explicit IDs of canonical findings this reconciliation finding supersedes.
   * Only these exact IDs may be removed from the canonical set. If absent or empty,
   * the finding is append-only (no existing findings removed).
   *
   * Fix 20 RULE: supersedes_finding_ids MUST be populated ONLY when the reconciliation
   * engine can prove exact canonical ID replacement — meaning the new finding is a
   * strictly more-accurate version of the same underlying claim/divergence.
   * Category, title, issue_key, or text similarity are NOT sufficient proof.
   * Ambiguous relationships MUST remain append-only with a diagnostic.
   */
  supersedes_finding_ids?: string[];
  /**
   * Fix 20: Diagnostic emitted when supersession was considered but rejected
   * as ambiguous. Records the candidate IDs and reason for append-only decision.
   */
  _supersession_diagnostic?: SupersessionDiagnostic;
}

/**
 * Fix 20: Diagnostic metadata for supersession decisions.
 * Persisted in the finding so auditors can trace why IDs were/weren't removed.
 */
export interface SupersessionDiagnostic {
  decision: "proven" | "ambiguous_appended" | "no_proven_candidate";
  candidate_ids: string[];
  proven_ids: string[];
  ambiguous_ids: string[];
  reason: string;
}

export interface ReconciliationResult {
  findings: ReconciliationFinding[];
  reconciled_count: number;
  unreconcilable_count: number;
  scope_mismatch_count: number;
  within_tolerance_count: number;
  cross_version_findings: number;
  /** U7: Near-miss (same metric+period, different scope) count */
  near_miss_count: number;
  /** F1: Claims that hit an ambiguous multi-figure key (fail-closed, no assertion) */
  ambiguous_reference_count: number;
  /** Internal error from LLM matching step (null if LLM succeeded or wasn't attempted) */
  matching_error?: string | null;
  /** Fix 20: Total supersession diagnostics emitted during this reconciliation.
   *  Corrective E2: No longer populated here — supersession moved to Stage 3.5. */
  supersession_diagnostics_count?: number;
  /** U5: Stable pointer to persisted findings dump */
  findings_report_id: string;
  /** U5: True if findings were truncated to meet 3MB persistence guard */
  findings_truncated?: boolean;
  /** U6: Coverage denominator breakdown */
  coverage: CoverageDenominator;
}

/** U6: Coverage denominator breakdown */
export interface CoverageDenominator {
  raw_claims: number;
  distinct_claims: number;
  scenario_excluded: number;
  /** Informational: claims with NONE_STATED scope (routed to near-miss, NOT deducted from adjudicable) */
  no_scope_count: number;
  /** Claims with NONE_STATED scope that found a near-miss candidate */
  no_scope_near_miss_eligible: number;
  /** Claims with UNDATED period (excluded from adjudicable) */
  no_period_count: number;
  /** F1: Claims hitting ambiguous multi-figure key (in adjudicable, not in matched) */
  ambiguous_reference_count: number;
  adjudicable: number;
  matched: number;
  near_miss: number;
  unmatched: number;
  coverage_pct: number;
  coverage_with_near_miss_pct: number;
}

/** LLM match proposal for a single claim */
interface MatchProposal {
  claim_index: number;
  match_status: "matched" | "no_model_line" | "scope_mismatch";
  /** When matched: the exact figure label from the verified figures list */
  matched_label: string | null;
  /** When matched: the period to look up */
  matched_period: string | null;
  /** When scope_mismatch: explanation of why scopes differ */
  mismatch_reason: string | null;
}

// ---------------------------------------------------------------------------
// Unit compatibility & basis alignment guards (Fix 3)
// ---------------------------------------------------------------------------

/** Coarse unit families for compatibility checking */
type UnitFamily = "absolute_gbp" | "rate_pct" | "multiplier" | "count" | "unknown";

function classifyClaimUnit(unit: string): UnitFamily {
  const u = unit.trim().toLowerCase();
  if (u === "£m" || u === "£k" || u === "£" || u === "£bn") return "absolute_gbp";
  if (u === "%" || u === "bps" || u === "pp") return "rate_pct";
  if (u === "x" || u === "turns") return "multiplier";
  if (u === "#" || u === "headcount" || u === "units") return "count";
  return "unknown";
}

/**
 * Classify what unit family a model figure likely represents.
 * Model figures store raw £ values (absolute) unless the label/context
 * clearly indicates a percentage or multiple.
 */
function classifyModelFigureUnit(fig: Figure): UnitFamily {
  const label = fig.name.toLowerCase();
  // Rate indicators in the figure label
  if (label.includes("margin") || label.includes("growth") || label.includes("%") ||
      label.includes("nrr") || label.includes("churn") || label.includes("recurring %") ||
      label.includes("retention") || label.includes("conversion rate") ||
      label.includes("yield")) {
    return "rate_pct";
  }
  // Multiplier indicators
  if (label.includes(" multiple") || label.includes(" x ") || label.includes("ev/") ||
      label.includes("turns")) {
    return "multiplier";
  }
  // Headcount / count
  if (label.includes("headcount") || label.includes("fte") || label.includes("# of")) {
    return "count";
  }
  // Default: model figures are £ absolutes (stored in raw £)
  return "absolute_gbp";
}

/**
 * Returns true if claim unit and model figure unit families are compatible.
 * Incompatible pairs should NEVER be reconciled — they'd produce false divergences.
 */
function unitsAreCompatible(claimFamily: UnitFamily, modelFamily: UnitFamily): boolean {
  // If either is unknown, we can't assert incompatibility — allow match (be conservative)
  if (claimFamily === "unknown" || modelFamily === "unknown") return true;
  // Same family is always compatible
  if (claimFamily === modelFamily) return true;
  // All other cross-family combinations are incompatible
  return false;
}

/**
 * Basis alignment check: even when the LLM says "matched" and units technically align,
 * verify that a scope_qualifier of "Total Group Revenue" on a rate/percentage claim
 * is not being matched to an absolute revenue figure. This catches the lazy-default
 * scenario where extraction tagged "96% recurring" with scope "Total Group Revenue"
 * and reconciliation matches it to the actual revenue line.
 */
function basisGenuinelyAligns(claim: Claim, modelFig: Figure): boolean {
  const claimFamily = classifyClaimUnit(claim.unit);
  const modelFamily = classifyModelFigureUnit(modelFig);

  // Cross-family match that slipped past unit guard (shouldn't happen, but defense in depth)
  if (!unitsAreCompatible(claimFamily, modelFamily)) return false;

  // Rate claim matched to a revenue/absolute model line by coincidental scope string
  // e.g., claim "96% recurring" scope="Total Group Revenue" matched to model "Total Revenue"
  if (claimFamily === "rate_pct" && modelFamily === "absolute_gbp") return false;
  if (claimFamily === "absolute_gbp" && modelFamily === "rate_pct") return false;

  return true;
}

/**
 * EBITDA-basis code guard: prevents "Reported / Non Pro Forma" claims from
 * matching PEP/management-case model figures (and vice versa).
 *
 * This is the targeted protection for the £54.9m case: the memo's Non-PF reported
 * EBITDA (£54.9m) must NEVER match the model's PEP/management figure (£57m).
 * A £2.1m delta would be above materiality floor and emit a false data_divergence.
 *
 * Returns false (incompatible) when EBITDA bases conflict.
 * Returns true (compatible) for non-EBITDA claims or when bases genuinely match.
 */
function ebitdaBasisCompatible(claim: Claim, modelFig: Figure): boolean {
  const cs = claim.scope_qualifier.toLowerCase();
  const ml = modelFig.name.toLowerCase();

  // Only apply to EBITDA-family claims
  const isEbitdaClaim = cs.includes("ebitda");
  if (!isEbitdaClaim) return true; // Not an EBITDA claim — guard doesn't apply

  // "Reported" / "Non Pro Forma" / "Non-PF" basis indicators
  const claimIsReported = cs.includes("reported") || cs.includes("non pro forma") || cs.includes("non-pf");
  const modelIsReported = ml.includes("reported") || ml.includes("non pro forma") || ml.includes("non-pf");

  // "PEP" basis indicators
  const claimIsPep = cs.includes("pep");
  const modelIsPep = ml.includes("pep");

  // "Organic" basis indicators (distinct from plain Adjusted)
  const claimIsOrganic = cs.includes("organic");
  const modelIsOrganic = ml.includes("organic");

  // "Run-rate" basis indicators
  const claimIsRunRate = cs.includes("run-rate") || cs.includes("run rate");
  const modelIsRunRate = ml.includes("run-rate") || ml.includes("run rate");

  // Incompatible pairs:
  // Reported/Non-PF claim vs non-reported model figure (PEP, Adjusted, or unlabeled)
  if (claimIsReported && !modelIsReported) return false;
  // Non-reported claim vs reported model figure
  if (!claimIsReported && modelIsReported) return false;

  // PEP claim vs non-PEP model (or vice versa)
  if (claimIsPep && !modelIsPep) return false;
  if (!claimIsPep && modelIsPep) return false;

  // Organic vs non-organic (if one explicitly says organic and the other doesn't)
  if (claimIsOrganic && !modelIsOrganic) return false;
  if (!claimIsOrganic && modelIsOrganic) return false;

  // Run-rate vs non-run-rate
  if (claimIsRunRate && !modelIsRunRate) return false;
  if (!claimIsRunRate && modelIsRunRate) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Materiality thresholds
// ---------------------------------------------------------------------------
const MATERIALITY_ABS_FLOOR = 2_000_000; // £2m — below this, delta is not material
const MATERIALITY_REL_FLOOR = 0.05;      // 5% — below this, delta is not material
const CRITICAL_ABS_THRESHOLD = 10_000_000; // £10m — above this, finding is critical
const CRITICAL_REL_THRESHOLD = 0.15;       // 15%

// ---------------------------------------------------------------------------
// Coordinate normalization — model-side mapping into claims vocabulary
// ---------------------------------------------------------------------------

export interface NormalizedFigure {
  raw: Figure;
  metric: string;         // Canonical metric family: "revenue", "ebitda", "gross_margin", etc.
  scope_qualifier: string; // Claims-vocabulary scope: "Total Group Revenue", "Adjusted EBITDA", etc.
  period: string;         // Normalized period string
  basis: string | null;   // Measurement basis implied by the label mapping (null = not determinable)
}

/** Mapping rules: raw Excel label → {metric, scope_qualifier, basis} in claims vocabulary */
interface LabelMapping {
  pattern: RegExp;
  metric: string;
  scope_qualifier: string;
  basis?: string;  // Measurement basis implied by this label (e.g. "OCF basis", "ARR")
}

const LABEL_MAPPINGS: LabelMapping[] = [
  // Revenue family — order matters (more specific patterns first)
  { pattern: /^(lfl|like.for.like)\s+revenue/i, metric: "revenue", scope_qualifier: "Revenue (LfL)" },
  { pattern: /lfl|like.for.like/i, metric: "revenue", scope_qualifier: "Revenue (LfL)" },
  { pattern: /organic\s+revenue/i, metric: "revenue", scope_qualifier: "Revenue (Organic)" },
  { pattern: /pro.?forma\s+revenue|revenue.*pro.?forma|pf\s+revenue/i, metric: "revenue", scope_qualifier: "Revenue (Pro Forma)" },
  { pattern: /recurring\s+revenue|arr|mrr/i, metric: "revenue", scope_qualifier: "Recurring Revenue" },
  { pattern: /net\s+revenue/i, metric: "revenue", scope_qualifier: "Net Revenue" },
  // "Total Group revenue" is the headline reported revenue line — prefer it over the excl. lines
  { pattern: /total\s+group\s+revenue/i, metric: "revenue", scope_qualifier: "Total Group Revenue" },
  // "Total revenue (excl. ...)" variants are sub-aggregates — map to a distinct scope
  { pattern: /total\s+revenue\s*\(excl/i, metric: "revenue", scope_qualifier: "Total Revenue (excl. adjustments)" },
  { pattern: /total\s+revenue|^revenue$/i, metric: "revenue", scope_qualifier: "Total Group Revenue" },
  // EBITDA family — order matters
  { pattern: /adj(usted)?\.?\s+cash\s+ebitda/i, metric: "ebitda", scope_qualifier: "Adjusted EBITDA" },
  { pattern: /adj(usted)?\.?\s+ebitda/i, metric: "ebitda", scope_qualifier: "Adjusted EBITDA" },
  { pattern: /reported\s+ebitda|ebitda.*reported|non.?pro.?forma.*ebitda|ebitda.*non.?pro.?forma/i, metric: "ebitda", scope_qualifier: "Cash EBITDA (Reported / Non Pro Forma)" },
  { pattern: /cash\s+ebitda/i, metric: "ebitda", scope_qualifier: "Cash EBITDA" },
  { pattern: /run.?rate\s+ebitda/i, metric: "ebitda", scope_qualifier: "Run-rate EBITDA" },
  { pattern: /organic.*ebitda|ebitda.*organic/i, metric: "ebitda", scope_qualifier: "Organic Cash EBITDA" },
  { pattern: /pep.*ebitda|ebitda.*pep/i, metric: "ebitda", scope_qualifier: "PEP Cash EBITDA" },
  { pattern: /^ebitda$/i, metric: "ebitda", scope_qualifier: "Cash EBITDA" },
  // Gross Profit family
  { pattern: /surgery\s+intellect.*gp|gp.*surgery\s+intellect/i, metric: "gross_margin", scope_qualifier: "Gross Profit (segment: Surgery Intellect)" },
  { pattern: /(total\s+)?gross\s+profit/i, metric: "gross_margin", scope_qualifier: "Total Gross Profit" },
  { pattern: /gross\s+margin/i, metric: "gross_margin", scope_qualifier: "Total Gross Profit" },
];

/**
 * Normalize model figures into claims coordinate vocabulary.
 * Each raw figure is mapped to {metric, scope_qualifier, period} using deterministic rules.
 * Figures that don't match any known pattern are omitted (they can't match claims anyway).
 */
export function normalizeFigures(figures: Figure[]): NormalizedFigure[] {
  const results: NormalizedFigure[] = [];
  for (const fig of figures) {
    const label = fig.name.trim();
    let mapped = false;
    for (const mapping of LABEL_MAPPINGS) {
      if (mapping.pattern.test(label)) {
        results.push({
          raw: fig,
          metric: mapping.metric,
          scope_qualifier: mapping.scope_qualifier,
          period: normalizePeriod(fig.period),
          basis: mapping.basis ?? null,
        });
        mapped = true;
        break; // First matching pattern wins
      }
    }
    if (!mapped) {
      // Log unmapped figures for diagnostic visibility
      console.warn(`[Reconciliation] Unmapped figure label: "${label}" (period: ${fig.period})`);
    }
  }
  return results;
}

/**
 * Normalize period strings to canonical form for coordinate matching.
 * Both claims and model figures go through this before indexing.
 *
 * Canonical forms:
 *   "fy-mar-26" (for FY Mar-26, FY26, FY2026, 2026, Mar-26)
 *   "fy-mar-25" (for FY Mar-25, FY25, FY2025, 2025, Mar-25)
 *   "fy-mar-27f" (for forecasts: FY Mar-27F, FY27F, 2027F)
 */
function normalizePeriod(period: string): string {
  const p = period.trim().toLowerCase();

  // --- Helper: normalize a single year + optional suffix ---
  function normalizeYr(raw: string, rawSuffix: string | undefined): string {
    let yr = parseInt(raw, 10);
    if (yr >= 100) yr = yr - 2000; // 2026 → 26
    // "LE" (Latest Estimate) and "A" (Actual) are equivalent to no suffix
    const s = rawSuffix?.toLowerCase() ?? "";
    const suffix = (s === "le" || s === "a") ? "" : s;
    return `${yr}${suffix}`;
  }

  // --- Range detection: "FY Mar-26-FY31", "FY26-FY31", "FY23-25", "FY Mar-26-31" ---
  // Match: FY [Mar-]?XX[-–to ]FY? [Mar-]?YY with optional suffixes
  const rangeRe = /^fy\s*(?:mar[-\s]?)?(\d{2,4})(f|b|le|a)?\s*[-–to]+\s*(?:fy\s*)?(?:mar[-\s]?)?(\d{2,4})(f|b|le|a)?$/i;
  const rangeMatch = p.match(rangeRe);
  if (rangeMatch) {
    const start = normalizeYr(rangeMatch[1], rangeMatch[2]);
    const end = normalizeYr(rangeMatch[3], rangeMatch[4]);
    return `fy-mar-${start}_${end}`;
  }

  // --- Anchored single-period patterns ---
  // FY Mar-XX (anchored — nothing else in string)
  const fyMarAnchored = p.match(/^fy\s*mar[-\s]?(\d{2,4})(f|b|le|a)?$/i);
  if (fyMarAnchored) {
    return `fy-mar-${normalizeYr(fyMarAnchored[1], fyMarAnchored[2])}`;
  }

  // FY XX or FYXX (anchored)
  const fyAnchored = p.match(/^fy\s*(\d{2,4})(f|b|le|a)?$/i);
  if (fyAnchored) {
    return `fy-mar-${normalizeYr(fyAnchored[1], fyAnchored[2])}`;
  }

  // Mar-XX (anchored)
  const marAnchored = p.match(/^mar[-\s]?(\d{2,4})(f|b|le|a)?$/i);
  if (marAnchored) {
    return `fy-mar-${normalizeYr(marAnchored[1], marAnchored[2])}`;
  }

  // Plain year: "2026", "25", optionally followed by "actual", "forecast", "budget", "estimate"
  const yearWithSuffix = p.match(/^(\d{2,4})\s*(actual|forecast|budget|estimate)?$/i);
  if (yearWithSuffix) {
    let yr = parseInt(yearWithSuffix[1], 10);
    if (yr >= 100) yr = yr - 2000;
    let suffix = "";
    const desc = yearWithSuffix[2]?.toLowerCase();
    if (desc === "forecast") suffix = "f";
    else if (desc === "budget") suffix = "b";
    return `fy-mar-${yr}${suffix}`;
  }

  // --- Unanchored FY pattern with residue: try to extract FY portion, slug-ify rest ---
  // This catches "FY Mar-26 OCF basis" or "FY31F (14.2% CAGR)" that SHOULD have been
  // split by extraction, but if not, we at least don't silently discard the residue.
  const fyUnanchored = p.match(/fy\s*(?:mar[-\s]?)?(\d{2,4})(f|b|le|a)?/i);
  if (fyUnanchored) {
    // There's residue beyond the FY portion — slug-ify the WHOLE string to avoid silent collisions
    return p.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // Fallback: slug-ify (for "LTM", "L3Y", "CY", etc.)
  return p.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Build a coordinate lookup key from metric + scope + basis + period.
 * Returns null for claims with non-null scenario (scenario claims are
 * excluded from contradiction matching — they represent conditional cases).
 * All parts are lowercased and trimmed.
 */
export function coordKey(
  metric: string,
  scope: string,
  period: string,
  basis: string | null = null,
  scenario: string | null = null,
): string | null {
  // Scenario claims are not matchable — they represent sensitivity cells
  if (scenario) return null;

  const basisPart = basis ? basis.toLowerCase().trim() : "";
  return `${metric.toLowerCase().trim()}|${scope.toLowerCase().trim()}|${basisPart}|${normalizePeriod(period)}`;
}

/**
 * Fuzzy period lookup: if exact coordKey misses, try variations.
 * Handles cases where claim says "FY Mar-26" but model says "2026" etc.
 */
function fuzzyPeriodLookup(
  index: Map<string, NormalizedFigure[]>,
  metric: string,
  scope: string,
  period: string,
): NormalizedFigure[] {
  // The normalizePeriod function already handles most variation,
  // so if exact lookup failed, the metric+scope just doesn't exist.
  // But let's try scope-insensitive matching with period variations.
  const normalizedMetric = metric.toLowerCase().trim();
  const normalizedScope = scope.toLowerCase().trim();
  const normalizedPeriod = normalizePeriod(period);

  // Try: exact metric + scope but with the period canonicalized differently
  // This handles edge cases where claim period didn't normalize the same way
  const results: NormalizedFigure[] = [];
  for (const [key, nfs] of index.entries()) {
    const [km, ks, _kb, kp] = key.split("|");
    if (km === normalizedMetric && ks === normalizedScope && kp === normalizedPeriod) {
      results.push(...nfs);
    }
  }
  if (results.length > 0) return results;

  // Last resort: metric matches, period matches, scope is a substring match
  // (e.g., claim says "Adjusted EBITDA" but model normalized to "Cash EBITDA (Adjusted)")
  for (const [key, nfs] of index.entries()) {
    const [km, ks, _kb2, kp] = key.split("|");
    if (km === normalizedMetric && kp === normalizedPeriod) {
      // Check if either scope contains the other
      if (ks.includes(normalizedScope) || normalizedScope.includes(ks)) {
        results.push(...nfs);
      }
    }
  }
  return results;
}

/** Result from processMatch — caller updates counters */
interface MatchResult {
  kind: "reconciled" | "within_tolerance" | "scope_mismatch" | "unreconcilable";
  finding: ReconciliationFinding | null;
}

/**
 * Process a coordinate match: apply guards, compute delta, classify finding.
 * Pushes finding to the findings array and returns the classification.
 */
function processMatch(
  claim: Claim,
  nf: NormalizedFigure,
  figures: Figure[],
  findings: ReconciliationFinding[],
  options?: { basisUnconfirmed?: boolean },
): MatchResult {
  const modelFig = nf.raw;

  // Guard 1: Unit compatibility
  const claimFamily = classifyClaimUnit(claim.unit);
  const modelFamily = classifyModelFigureUnit(modelFig);
  if (!unitsAreCompatible(claimFamily, modelFamily)) {
    findings.push({
      finding_kind: "scope_mismatch",
      severity: "info",
      title: `${claim.scope_qualifier}: unit mismatch (${claim.unit} vs ${modelFamily})`,
      detail: `Claim unit "${claim.unit}" (${claimFamily}) incompatible with model figure ` +
        `"${modelFig.name}" unit family (${modelFamily}).`,
      full_analysis: `[SCOPE_MISMATCH] Unit incompatibility. Claim: "${claim.verbatim_snippet}" ` +
        `unit=${claim.unit} (${claimFamily}). Model: "${modelFig.name}" classified as ${modelFamily}. ` +
        `Cannot compute meaningful delta.`,
      severity_anchor: null,
      source_docs: [claim.source_doc],
      claim,
      model_figure: modelFig,
      delta_abs: null,
      delta_pct: null,
    });
    return { kind: "scope_mismatch", finding: findings[findings.length - 1] };
  }

  // Guard 2: Basis alignment
  if (!basisGenuinelyAligns(claim, modelFig)) {
    findings.push({
      finding_kind: "scope_mismatch",
      severity: "info",
      title: `${claim.scope_qualifier}: basis misalignment`,
      detail: `Claim basis (${claimFamily}) does not align with model figure ` +
        `"${modelFig.name}" (${modelFamily}).`,
      full_analysis: `[SCOPE_MISMATCH] Basis misalignment. Claim "${claim.verbatim_snippet}" ` +
        `classified as ${claimFamily} but model "${modelFig.name}" is ${modelFamily}. ` +
        `Not comparable.`,
      severity_anchor: null,
      source_docs: [claim.source_doc],
      claim,
      model_figure: modelFig,
      delta_abs: null,
      delta_pct: null,
    });
    return { kind: "scope_mismatch", finding: findings[findings.length - 1] };
  }

  // Guard 3: EBITDA basis compatibility
  if (!ebitdaBasisCompatible(claim, modelFig)) {
    findings.push({
      finding_kind: "scope_mismatch",
      severity: "info",
      title: `${claim.scope_qualifier}: EBITDA basis conflict with "${modelFig.name}"`,
      detail: `Claim EBITDA basis "${claim.scope_qualifier}" is incompatible with model figure ` +
        `"${modelFig.name}". Different adjustment/reporting basis.`,
      full_analysis: `[SCOPE_MISMATCH] EBITDA-basis guard fired. Claim: "${claim.verbatim_snippet}" ` +
        `(scope="${claim.scope_qualifier}") vs model "${modelFig.name}". ` +
        `These represent different EBITDA definitions and cannot be compared.`,
      severity_anchor: null,
      source_docs: [claim.source_doc],
      claim,
      model_figure: modelFig,
      delta_abs: null,
      delta_pct: null,
    });
    return { kind: "scope_mismatch", finding: findings[findings.length - 1] };
  }

  // ----- Compute delta (code-verified, never LLM-computed) -----
  const claimVal = normalizeClaimValue(claim);
  const modelVal = modelFig.value;

  const deltaAbs = Math.abs(claimVal - modelVal);

  // FIX 7: Zero/near-zero denominator handling.
  // When modelVal is zero or near-zero (< £1k), percentage computation is undefined.
  // Instead of synthesizing an arbitrary 100%, classify by absolute delta alone.
  // De minimis: if BOTH values are near-zero (< £10k), treat as within tolerance.
  const DE_MINIMIS_THRESHOLD = 10_000; // £10k — below this, both values are negligible
  const NEAR_ZERO_THRESHOLD = 1_000;   // £1k — denominator too small for meaningful %

  if (Math.abs(modelVal) < NEAR_ZERO_THRESHOLD && Math.abs(claimVal) < DE_MINIMIS_THRESHOLD) {
    // Both values are trivially small — no meaningful divergence
    return { kind: "within_tolerance", finding: null };
  }

  let deltaPct: number;
  if (Math.abs(modelVal) < NEAR_ZERO_THRESHOLD) {
    // Model is zero/near-zero but claim is non-trivial: use absolute delta only.
    // Set deltaPct to null-equivalent (will not drive severity via percentage threshold).
    deltaPct = 0; // Severity will be driven solely by deltaAbs
  } else {
    deltaPct = deltaAbs / Math.abs(modelVal);
  }

  // ----- Materiality classification -----
  const belowMateriality = deltaAbs < MATERIALITY_ABS_FLOOR && deltaPct < MATERIALITY_REL_FLOOR;

  // Historical-actuals backstop: for settled past years, a tight tolerance (1%)
  // should not fire — these are just rounding differences in settled accounts.
  const isHistorical = isHistoricalActualPeriod(claim.period);
  const historicalBackstopSafe = isHistorical && deltaPct < 0.01;

  if (belowMateriality || historicalBackstopSafe) {
    // Within tolerance — no finding, just count
    return { kind: "within_tolerance", finding: null };
  }

  // Material divergence — classify severity
  const severity: "critical" | "warning" = (deltaAbs >= CRITICAL_ABS_THRESHOLD || deltaPct >= CRITICAL_REL_THRESHOLD)
    ? "critical" : "warning";

  // Basis-unconfirmed guard: a relaxed-basis match must never assert contradiction.
  // Downgrade to scope_mismatch so it doesn't appear as a confirmed data_divergence.
  if (options?.basisUnconfirmed) {
    findings.push({
      finding_kind: "scope_mismatch",
      severity: "info",
      title: `${claim.scope_qualifier} (${claim.period}): basis unconfirmed — model figure has no explicit basis`,
      detail: `Claim carries basis "${claim.basis}" but model figure "${nf.raw.name}" has no confirmed basis. ` +
        `Matched on relaxed coordinates (basis omitted). Delta not asserted as contradiction.`,
      full_analysis: `[SCOPE_MISMATCH] Basis-relaxed match. Claim: "${claim.verbatim_snippet}" ` +
        `(basis="${claim.basis}"). Model: "${nf.raw.name}" (no basis mapping). ` +
        `Cannot confirm these measure the same thing.`,
      severity_anchor: null,
      source_docs: [claim.source_doc],
      claim,
      model_figure: nf.raw,
      delta_abs: deltaAbs,
      delta_pct: deltaPct,
    });
    return { kind: "scope_mismatch", finding: findings[findings.length - 1] };
  }

  const sign = claimVal > modelVal ? "higher" : "lower";
  const deltaFormatted = deltaAbs >= 1_000_000
    ? `£${(deltaAbs / 1_000_000).toFixed(1)}m`
    : `£${(deltaAbs / 1_000).toFixed(0)}k`;

  const finding: ReconciliationFinding = {
    finding_kind: "data_divergence",
    severity,
    title: `${claim.scope_qualifier} (${claim.period}): memo ${sign} than model by ${deltaFormatted} (${(deltaPct * 100).toFixed(1)}%)`,
    detail: `Memo cites ${formatValue(claim)} but model shows £${(modelVal / 1_000_000).toFixed(1)}m ` +
      `for "${modelFig.name}" (${modelFig.period}). Delta: ${deltaFormatted} (${(deltaPct * 100).toFixed(1)}%).`,
    full_analysis: `[DATA_DIVERGENCE] Code-verified delta computation.\n` +
      `  Claim: "${claim.verbatim_snippet}" → ${formatValue(claim)} (normalized: £${(claimVal / 1_000_000).toFixed(2)}m)\n` +
      `  Model: "${modelFig.name}" ${modelFig.period} → £${(modelVal / 1_000_000).toFixed(2)}m (source: ${modelFig.source_sheet}!${modelFig.source_cell})\n` +
      `  Delta: ${deltaFormatted} (${(deltaPct * 100).toFixed(1)}%) — memo is ${sign}\n` +
      `  Materiality: abs=${deltaAbs >= MATERIALITY_ABS_FLOOR ? "ABOVE" : "below"} floor (${MATERIALITY_ABS_FLOOR/1e6}m), ` +
      `rel=${deltaPct >= MATERIALITY_REL_FLOOR ? "ABOVE" : "below"} floor (${(MATERIALITY_REL_FLOOR*100)}%)\n` +
      `  Classification: ${severity} data_divergence`,
    severity_anchor: deltaAbs,
    source_docs: [claim.source_doc, modelFig.source_doc ?? "Financial Model"],
    claim,
    model_figure: modelFig,
    delta_abs: deltaAbs,
    delta_pct: deltaPct,
  };

  findings.push(finding);
  return { kind: "reconciled", finding };
}

// ---------------------------------------------------------------------------
// LLM Matching Prompt (legacy — retained for reference, not used in Step 3)
// ---------------------------------------------------------------------------

function buildMatchingPrompt(claims: Claim[], figures: Figure[]): string {
  // Build a de-duplicated figure reference list (label + period pairs)
  const figureEntries = new Map<string, Set<string>>();
  for (const fig of figures) {
    if (!figureEntries.has(fig.name)) figureEntries.set(fig.name, new Set());
    figureEntries.get(fig.name)!.add(fig.period);
  }

  const figureRef = Array.from(figureEntries.entries())
    .map(([label, periods]) => `  "${label}" → periods: [${Array.from(periods).join(", ")}]`)
    .join("\n");

  const claimsList = claims
    .map((c, i) => `  [${i}] metric="${c.metric}" scope="${c.scope_qualifier}" period="${c.period}" value=${c.value}${c.unit} basis="${c.basis_note}"`)
    .join("\n");

  return `You are matching IC memo financial claims against verified model figures.

## Available Model Figures (from the financial model, code-read cell values)

${figureRef}

## Claims to Match

${claimsList}

## Matching Rules

For each claim, determine:
1. **matched** — The claim's metric + scope maps to a specific model figure label AND the period aligns.
   Return the EXACT label string and period from the Available Model Figures list.
   
2. **no_model_line** — The claim describes a metric/scope that has NO counterpart in the model figures.
   Examples: "PEP Cash EBITDA (Organic)" when only "EBITDA" and "Adjusted EBITDA" exist;
   returns metrics (IRR, MoM); structuring EBITDA not in operating model.
   
3. **scope_mismatch** — The claim's BASE metric exists in the model (e.g., both say "revenue") 
   but the scope qualifiers are DIFFERENT and therefore not directly comparable.
   Examples: memo says "Revenue (PF)" but model has "Total revenue (excl. future M&A)";
   memo says "Run-rate EBITDA" but model has annual reported EBITDA.
   
## CRITICAL: Never force a match across scope boundaries.
- "Revenue (PF)" ≠ "Total revenue (excl. future M&A)" — these are DIFFERENT metrics
- "Run-rate" ≠ "FY actual" — different temporal basis
- "Organic Cash EBITDA" ≠ "Adjusted EBITDA" — different adjustments
- If the scope qualifiers differ AT ALL, return scope_mismatch, NOT matched

## Output Format

Return a JSON array with one object per claim (same order as input):
[
  { "claim_index": 0, "match_status": "matched", "matched_label": "Total Revenue", "matched_period": "2026", "mismatch_reason": null },
  { "claim_index": 1, "match_status": "no_model_line", "matched_label": null, "matched_period": null, "mismatch_reason": null },
  { "claim_index": 2, "match_status": "scope_mismatch", "matched_label": null, "matched_period": null, "mismatch_reason": "Claim is PF revenue, model is excl-M&A" }
]

Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// Fix 20: Deterministic supersession validation
// ---------------------------------------------------------------------------

/**
 * Candidate finding for supersession consideration.
 * Only used when reconciliation has prior-run findings available.
 */
export interface SupersessionCandidate {
  canonical_id: string;
  claim_metric: string;
  claim_scope: string;
  claim_period: string;
  claim_source_doc: string;
  claim_basis?: string | null;    // null for candidates predating the basis field
  claim_scenario?: string | null; // null for candidates predating the scenario field
}

/**
 * Fix 20 + Corrective E3: Validate supersession proof — deterministic ID replacement.
 *
 * RULES (non-negotiable):
 *   1. Only candidates with EXACT coordinate (metric + scope + period) AND exact source_doc
 *      match are considered. Non-matching candidates are IGNORED (not "ambiguous").
 *   2. Deduplicate exact matches by canonical_id (multiple evidence rows for one finding
 *      produce only one match entry).
 *   3. Zero exact match IDs → append-only with `no_proven_candidate` diagnostic.
 *   4. Exactly one unique canonical_id → proven supersession.
 *   5. Two+ distinct canonical_ids → genuinely ambiguous, append-only.
 *   6. Category, title, issue_key, and text similarity are NOT sufficient proof.
 *
 * Corrective E3: A nonmatching evidence row on the same finding must NOT cancel
 * a matching row. Nonmatching candidates are irrelevant, not ambiguous.
 *
 * @param newFinding The new reconciliation finding being produced
 * @param candidates Current-run findings (one entry per evidence×source_doc coordinate)
 * @returns Validated supersession result with diagnostics
 */
export function validateSupersessionProof(
  newFinding: { claim: Claim; finding_kind: string },
  candidates: SupersessionCandidate[],
): { proven_ids: string[]; ambiguous_ids: string[]; diagnostic: SupersessionDiagnostic | null } {
  if (!candidates || candidates.length === 0) {
    return { proven_ids: [], ambiguous_ids: [], diagnostic: null };
  }

  const claim = newFinding.claim;
  const claimCoord = coordKey(claim.metric, claim.scope_qualifier, claim.period, claim.basis ?? null, claim.scenario ?? null);

  // Corrective E3: Collect ONLY exact-match candidates; ignore non-matching entirely.
  const exactMatchIds = new Set<string>();
  for (const candidate of candidates) {
    const candidateCoord = coordKey(
      candidate.claim_metric ?? "",
      candidate.claim_scope ?? "",
      candidate.claim_period ?? "",
      candidate.claim_basis ?? null,
      candidate.claim_scenario ?? null,
    );
    const sourceMatch = claim.source_doc === candidate.claim_source_doc;

    if (claimCoord !== null && claimCoord === candidateCoord && sourceMatch) {
      exactMatchIds.add(candidate.canonical_id);
    }
    // Non-matching candidates are silently ignored — they are irrelevant, not ambiguous.
  }

  // Decision logic based on number of UNIQUE exact-match finding IDs
  const uniqueIds = [...exactMatchIds];
  let diagnostic: SupersessionDiagnostic | null = null;

  if (uniqueIds.length === 0) {
    // No exact match found → append-only
    diagnostic = {
      decision: "no_proven_candidate" as SupersessionDiagnostic["decision"],
      candidate_ids: candidates.map(c => c.canonical_id),
      proven_ids: [],
      ambiguous_ids: [],
      reason: `No candidate matched exact coordinate (${claimCoord}) + source_doc. Append-only.`,
    };
    return { proven_ids: [], ambiguous_ids: [], diagnostic };
  }

  if (uniqueIds.length === 1) {
    // Exactly one unique finding matches → proven supersession
    diagnostic = {
      decision: "proven",
      candidate_ids: candidates.map(c => c.canonical_id),
      proven_ids: uniqueIds,
      ambiguous_ids: [],
      reason: `Exactly 1 finding (${uniqueIds[0]}) matches coordinate + source_doc. Proven supersession.`,
    };
    return { proven_ids: uniqueIds, ambiguous_ids: [], diagnostic };
  }

  // Two+ distinct IDs with exact match → genuinely ambiguous
  diagnostic = {
    decision: "ambiguous_appended",
    candidate_ids: candidates.map(c => c.canonical_id),
    proven_ids: [],
    ambiguous_ids: uniqueIds,
    reason: `${uniqueIds.length} distinct findings match exact coordinate + source_doc. Cannot determine which to supersede. Append-only.`,
  };
  return { proven_ids: [], ambiguous_ids: uniqueIds, diagnostic };
}

// ---------------------------------------------------------------------------
// Main reconciliation function
// ---------------------------------------------------------------------------

/**
 * Reconcile extracted claims against verified model figures.
 *
 * Corrective E2: priorCanonicalFindings parameter removed. Supersession
 * is now performed in runPostMergePipeline() Stage 3.5 against current-run
 * findings where stable IDs are available.
 *
 * @param ctx Pipeline context
 * @param ledger The claims ledger from claim extraction
 * @param figures Verified figures from numeric-verify-inline
 * @param discrepancies Cross-version discrepancies from numeric-verify-inline
 * @param pipelineStartTime For headroom calculations
 * @param timeBudgetMs Max time for this phase
 * @param dealId Optional deal ID for findings table provenance
 */
export async function runReconciliation(
  ctx: PipelineContext,
  ledger: ClaimsLedger,
  figures: Figure[],
  discrepancies: Discrepancy[],
  pipelineStartTime: number,
  timeBudgetMs: number,
  dealId?: string,
): Promise<ReconciliationResult> {
  const phaseStart = Date.now();
  console.log(`[Reconciliation] Starting — ${ledger.claims.length} claims, ${figures.length} figures, budget ${Math.round(timeBudgetMs / 1000)}s`);

  const findings: ReconciliationFinding[] = [];
  let reconciled_count = 0;
  let unreconcilable_count = 0;
  let scope_mismatch_count = 0;
  let within_tolerance_count = 0;
  let near_miss_count = 0;
  let ambiguous_reference_count = 0;
  let matching_error: string | null = null;

  // --- U6: Coverage denominator tracking ---
  let scenario_excluded = 0;
  let no_coordinate_no_scope = 0;
  let no_coordinate_no_period = 0;
  let no_scope_near_miss_eligible = 0;

  // ----- Step 1: Filter to operating_metric claims only (reconcilable) -----
  const reconcilableClaims = ledger.claims.filter(c => c.claim_category === "operating_metric");
  const nonReconcilable = ledger.claims.filter(c => c.claim_category !== "operating_metric");

  // ----- Step 1b: Deduplicate reconcilable claims by coordinate key -----
  // Multiple memo passages may cite the same figure (e.g. revenue FY26 mentioned 3 times).
  // We match once per unique coordinate, keeping the first occurrence for traceability.
  // Scenario claims (coordKey → null) are separated — they are excluded from matching entirely.
  const scenarioClaims: typeof reconcilableClaims = [];
  const dedupedClaims: typeof reconcilableClaims = [];
  const seenCoordKeys = new Set<string>();
  for (const c of reconcilableClaims) {
    const key = coordKey(c.metric, c.scope_qualifier, c.period, c.basis ?? null, c.scenario ?? null);
    if (key === null) {
      scenarioClaims.push(c);
    } else if (!seenCoordKeys.has(key)) {
      seenCoordKeys.add(key);
      dedupedClaims.push(c);
    }
    // Duplicates (same coordKey, already seen) are silently dropped
  }
  scenario_excluded = scenarioClaims.length;

  console.log(
    `[Reconciliation] ${reconcilableClaims.length} operating_metric claims → ` +
    `${dedupedClaims.length} unique coordinates, ${scenarioClaims.length} scenario-excluded, ` +
    `${reconcilableClaims.length - dedupedClaims.length - scenarioClaims.length} duplicates removed`
  );

  // ----- Step 2: Emit unreconcilable findings for notable non-operating claims -----
  // Only valuation_structuring claims that reference specific £ amounts get INFO findings
  for (const claim of nonReconcilable) {
    if (claim.claim_category === "valuation_structuring" && claim.unit === "£m" && claim.value > 50) {
      findings.push({
        finding_kind: "unreconcilable",
        severity: "info",
        title: `${claim.scope_qualifier}: £${claim.value}m — basis not in provided model`,
        detail: `The memo cites ${claim.scope_qualifier} of £${claim.value}m (${claim.period}). ` +
          `This figure depends on a valuation/structuring model not included in the operating model files.`,
        full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" — This is a ${claim.claim_category} figure ` +
          `that references a model or methodology (${claim.basis_note}) not present in the uploaded financial model. ` +
          `Cannot verify — flagged for awareness only.`,
        severity_anchor: claim.value * 1_000_000,
        source_docs: [claim.source_doc],
        claim,
        model_figure: null,
        delta_abs: null,
        delta_pct: null,
      });
      unreconcilable_count++;
    }
    if (claim.claim_category === "returns_projection") {
      findings.push({
        finding_kind: "unreconcilable",
        severity: "info",
        title: `Returns projection: ${claim.value}${claim.unit} ${claim.scope_qualifier} — depends on model not provided`,
        detail: `The memo projects ${claim.scope_qualifier} of ${claim.value}${claim.unit} (${claim.period}). ` +
          `This depends on a returns model not included in the operating model files.`,
        full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" — Returns projections (${claim.basis_note}) ` +
          `cannot be verified against the operating/financial model. The returns model was not provided.`,
        severity_anchor: null,
        source_docs: [claim.source_doc],
        claim,
        model_figure: null,
        delta_abs: null,
        delta_pct: null,
      });
      unreconcilable_count++;
    }
  }

  // ----- Step 3: Deterministic coordinate matching -----
  // Normalize model figures into the same coordinate space as claims, then direct-lookup.
  // No LLM needed — matching is by {metric, scope_qualifier, period} coordinates.
  if (dedupedClaims.length > 0 && figures.length > 0) {
    const normalizedFigures = normalizeFigures(figures);
    console.log(`[Reconciliation] Normalized ${normalizedFigures.length} figure coordinates from ${figures.length} raw figures`);

    // Build lookup index: key = "metric|scope|basis|period" → NormalizedFigure[]
    const figureIndex = new Map<string, NormalizedFigure[]>();
    for (const nf of normalizedFigures) {
      const key = coordKey(nf.metric, nf.scope_qualifier, nf.period, nf.basis);
      if (key === null) continue; // should never happen for model figures
      if (!figureIndex.has(key)) figureIndex.set(key, []);
      figureIndex.get(key)!.push(nf);
    }

    // ----- Step 4: Coordinate-match each deduplicated claim and compute delta -----
    for (const claim of dedupedClaims) {
      // --- U3/F2: Exclude UNDATED period; route NONE_STATED scope to near-miss ---
      const normalizedClaimPeriod = normalizePeriod(claim.period);
      const isUndatedPeriod = claim.period === "UNDATED" || normalizedClaimPeriod === "undated";
      const isNoScope = claim.scope_qualifier === "NONE_STATED";
      if (isUndatedPeriod) { no_coordinate_no_period++; continue; }

      // F2: NONE_STATED scope — skip exact/fuzzy matching, route directly to U7 near-miss
      if (isNoScope) {
        no_coordinate_no_scope++;
        no_scope_near_miss_eligible++;
        // Jump to near-miss: search all figures at same metric+period, any scope
        const nearMissCandidates: Array<{ nf: NormalizedFigure; scopeDelta: string }> = [];
        const normalizedMetric = claim.metric.toLowerCase().trim();
        for (const [fkey, nfs] of figureIndex.entries()) {
          const [fm, _fs, _fb, fp] = fkey.split("|");
          if (fm === normalizedMetric && fp === normalizedClaimPeriod) {
            for (const nf of nfs) {
              nearMissCandidates.push({ nf, scopeDelta: nf.scope_qualifier });
            }
          }
        }

        if (nearMissCandidates.length > 0) {
          const claimVal = normalizeClaimValue(claim);
          const sorted = nearMissCandidates.sort((a, b) =>
            Math.abs(claimVal - a.nf.raw.value) - Math.abs(claimVal - b.nf.raw.value)
          );
          const capped = sorted.slice(0, 3);
          const suppressedCount = sorted.length - capped.length;

          for (const { nf, scopeDelta } of capped) {
            const modelFig = nf.raw;
            const deltaAbs = Math.abs(claimVal - modelFig.value);
            const deltaPct = Math.abs(modelFig.value) > 1000 ? deltaAbs / Math.abs(modelFig.value) : 0;
            findings.push({
              finding_kind: "scope_mismatch",
              severity: "info",
              title: `NONE_STATED (${claim.period}): near-miss — model has "${scopeDelta}"`,
              detail: `Memo cites ${claim.metric} (no scope): ${formatValue(claim)}. ` +
                `Model has "${nf.raw.name}" (scope: ${scopeDelta}) at ${nf.raw.period}: ` +
                `£${(modelFig.value / 1_000_000).toFixed(1)}m. Delta: £${(deltaAbs / 1_000_000).toFixed(1)}m (${(deltaPct * 100).toFixed(1)}%).` +
                (suppressedCount > 0 ? ` [${suppressedCount} additional candidate(s) suppressed]` : ""),
              full_analysis: `[NEAR_MISS:NO_SCOPE] Claim: "${claim.verbatim_snippet}" (NONE_STATED scope). ` +
                `Routed to near-miss. Model has figure at same metric+period: "${scopeDelta}". ` +
                `Not confirmed to be the same measure — no contradiction asserted.`,
              severity_anchor: null,
              source_docs: [claim.source_doc],
              claim,
              model_figure: modelFig,
              delta_abs: deltaAbs,
              delta_pct: deltaPct,
            });
          }
          near_miss_count++;
        } else {
          // No model figure at this metric+period at all
          findings.push({
            finding_kind: "unreconcilable",
            severity: "info",
            title: `NONE_STATED (${claim.period}): no model counterpart for metric "${claim.metric}"`,
            detail: `Memo cites ${claim.metric} (no scope): ${formatValue(claim)} (${claim.period}). ` +
              `No matching metric found in the operating model at any scope.`,
            full_analysis: `[UNRECONCILABLE:NO_SCOPE] Claim: "${claim.verbatim_snippet}" (NONE_STATED scope). ` +
              `No figure found for metric "${claim.metric}" at period "${claim.period}" at any scope.`,
            severity_anchor: null,
            source_docs: [claim.source_doc],
            claim,
            model_figure: null,
            delta_abs: null,
            delta_pct: null,
          });
          unreconcilable_count++;
        }
        continue;
      }

      const key = coordKey(claim.metric, claim.scope_qualifier, claim.period, claim.basis ?? null, claim.scenario ?? null);
      // Note: key should never be null here — scenario claims are pre-filtered in Step 1b
      if (key === null) continue;
      let matches = figureIndex.get(key) ?? null;
      let basisUnconfirmed = false;

      // Pass 2a: if exact key (with basis) found nothing and CLAIM carries a basis,
      // retry without basis. A basis-relaxed match must never assert a contradiction.
      if ((!matches || matches.length === 0) && claim.basis) {
        const relaxedKey = coordKey(claim.metric, claim.scope_qualifier, claim.period, null, claim.scenario ?? null);
        if (relaxedKey !== null) {
          matches = figureIndex.get(relaxedKey) ?? null;
          if (matches && matches.length > 0) {
            basisUnconfirmed = true;
          }
        }
      }

      // U4 — Pass 2b: if exact key found nothing and any FIGURE at same metric+scope+period
      // carries a basis that the claim does not, retry by matching that figure without basis.
      // This handles the case where the model label implies a basis the memo omits.
      if ((!matches || matches.length === 0) && !claim.basis) {
        // Look for any figure at same metric+scope+period with any basis
        const normalizedMetric = claim.metric.toLowerCase().trim();
        const normalizedScope = claim.scope_qualifier.toLowerCase().trim();
        for (const [fkey, nfs] of figureIndex.entries()) {
          const [fm, fs, fb, fp] = fkey.split("|");
          if (fm === normalizedMetric && fs === normalizedScope && fp === normalizedClaimPeriod && fb !== "") {
            matches = nfs;
            basisUnconfirmed = true;
            break;
          }
        }
      }

      if (!matches || matches.length === 0) {
        // Try fuzzy period matching (e.g., "FY Mar-26" vs "2026" or "Mar-26")
        const fuzzyMatches = fuzzyPeriodLookup(figureIndex, claim.metric, claim.scope_qualifier, claim.period);

        if (fuzzyMatches.length === 0) {
          // --- U7: Near-miss pass — same metric + same period, any scope ---
          const nearMissCandidates: Array<{ nf: NormalizedFigure; scopeDelta: string }> = [];
          for (const [fkey, nfs] of figureIndex.entries()) {
            const [fm, _fs, _fb, fp] = fkey.split("|");
            if (fm === claim.metric.toLowerCase().trim() && fp === normalizedClaimPeriod) {
              for (const nf of nfs) {
                if (nf.scope_qualifier.toLowerCase() !== claim.scope_qualifier.toLowerCase()) {
                  nearMissCandidates.push({ nf, scopeDelta: nf.scope_qualifier });
                }
              }
            }
          }

          if (nearMissCandidates.length > 0) {
            // Order by absolute delta ascending, cap at 3
            const claimVal = normalizeClaimValue(claim);
            const sorted = nearMissCandidates.sort((a, b) =>
              Math.abs(claimVal - a.nf.raw.value) - Math.abs(claimVal - b.nf.raw.value)
            );
            const capped = sorted.slice(0, 3);
            const suppressedCount = sorted.length - capped.length;

            for (const { nf, scopeDelta } of capped) {
              const modelFig = nf.raw;
              const deltaAbs = Math.abs(claimVal - modelFig.value);
              const deltaPct = Math.abs(modelFig.value) > 1000 ? deltaAbs / Math.abs(modelFig.value) : 0;
              findings.push({
                finding_kind: "scope_mismatch",
                severity: "info",
                title: `${claim.scope_qualifier} (${claim.period}): near-miss — model has "${scopeDelta}"`,
                detail: `Memo cites ${claim.scope_qualifier}: ${formatValue(claim)}. ` +
                  `Model has "${nf.raw.name}" (scope: ${scopeDelta}) at ${nf.raw.period}: ` +
                  `£${(modelFig.value / 1_000_000).toFixed(1)}m. Delta: £${(deltaAbs / 1_000_000).toFixed(1)}m (${(deltaPct * 100).toFixed(1)}%).` +
                  (suppressedCount > 0 ? ` [${suppressedCount} additional candidate(s) suppressed]` : ""),
                full_analysis: `[NEAR_MISS] Claim: "${claim.verbatim_snippet}" (${claim.scope_qualifier}). ` +
                  `Model has figure at same metric+period but different scope: "${scopeDelta}". ` +
                  `Not confirmed to be the same measure — no contradiction asserted.`,
                severity_anchor: null,
                source_docs: [claim.source_doc],
                claim,
                model_figure: modelFig,
                delta_abs: deltaAbs,
                delta_pct: deltaPct,
              });
            }
            near_miss_count++;
            continue;
          }

          // No model counterpart for this coordinate
          findings.push({
            finding_kind: "unreconcilable",
            severity: "info",
            title: `${claim.scope_qualifier}: no model counterpart`,
            detail: `Memo cites ${claim.scope_qualifier}: ${formatValue(claim)} (${claim.period}). ` +
              `No matching metric found in the operating model.`,
            full_analysis: `[UNRECONCILABLE] Claim: "${claim.verbatim_snippet}" ` +
              `→ ${claim.scope_qualifier} (${claim.period}) has no counterpart in the verified figures set. ` +
              `Coordinate lookup key: "${key}".`,
            severity_anchor: null,
            source_docs: [claim.source_doc],
            claim,
            model_figure: null,
            delta_abs: null,
            delta_pct: null,
          });
          unreconcilable_count++;
          continue;
        }

        // Use the fuzzy match
        const nf = fuzzyMatches[0];
        const fuzzyResult = processMatch(claim, nf, figures, findings);
        if (fuzzyResult.kind === "reconciled") reconciled_count++;
        else if (fuzzyResult.kind === "within_tolerance") within_tolerance_count++;
        else if (fuzzyResult.kind === "scope_mismatch") scope_mismatch_count++;
        else if (fuzzyResult.kind === "unreconcilable") unreconcilable_count++;
        continue;
      }

      // --- F1: Ambiguity guard — if multiple figures at this key disagree, fail closed ---
      if (matches.length > 1) {
        const values = matches.map(m => m.raw.value);
        const maxVal = Math.max(...values);
        const minVal = Math.min(...values);
        const spread = Math.abs(maxVal - minVal);
        const avgVal = (maxVal + minVal) / 2;
        const relSpread = Math.abs(avgVal) > 1000 ? spread / Math.abs(avgVal) : 0;
        // De minimis: £100k absolute AND 0.5% relative — same figure, rounding only
        if (spread > 100_000 || relSpread > 0.005) {
          findings.push({
            finding_kind: "unreconcilable",
            severity: "info",
            title: `${claim.scope_qualifier} (${claim.period}): ambiguous model reference — ${matches.length} figures at same coordinate`,
            detail: `Memo cites ${claim.scope_qualifier}: ${formatValue(claim)} (${claim.period}). ` +
              `Model has ${matches.length} figures at this coordinate with differing values: ` +
              matches.map(m => `"${m.raw.name}" = £${(m.raw.value / 1_000_000).toFixed(1)}m [${m.raw.source_cell}]`).join("; ") +
              `. Spread: £${(spread / 1_000_000).toFixed(1)}m (${(relSpread * 100).toFixed(1)}%). No assertion possible.`,
            full_analysis: `[AMBIGUOUS_REFERENCE] Claim: "${claim.verbatim_snippet}" (${claim.scope_qualifier}). ` +
              `Coordinate key "${key}" resolves to ${matches.length} model figures with materially different values. ` +
              `Cannot determine which is the correct reference. Figures: ` +
              matches.map(m => `${m.raw.name} (${m.raw.source_sheet}) = ${m.raw.value}`).join("; ") + ".",
            severity_anchor: null,
            source_docs: [claim.source_doc],
            claim,
            model_figure: null,
            delta_abs: null,
            delta_pct: null,
          });
          ambiguous_reference_count++;
          continue;
        }
      }

      // Direct coordinate match found — use first (all agree within de minimis)
      const nf = matches[0];
      const matchResult = processMatch(claim, nf, figures, findings, { basisUnconfirmed });
      if (matchResult.kind === "reconciled") reconciled_count++;
      else if (matchResult.kind === "within_tolerance") within_tolerance_count++;
      else if (matchResult.kind === "scope_mismatch") scope_mismatch_count++;
      else if (matchResult.kind === "unreconcilable") unreconcilable_count++;
    }
  } else if (figures.length === 0) {
    console.log(`[Reconciliation] No verified figures available — all claims unreconcilable`);
    unreconcilable_count += reconcilableClaims.length;
  }

  // ----- Step 5: Cross-version findings from numeric-verify discrepancies -----
  let cross_version_findings = 0;
  for (const disc of discrepancies) {
    const materialMetrics = (disc.metrics ?? []).filter(m => m.tier === "material");

    if (materialMetrics.length === 0) continue;

    // Determine severity based on magnitude
    const maxDelta = Math.max(...materialMetrics.map(m => m.absDiff));
    const severity: "critical" | "warning" | "info" = maxDelta >= 1_000_000 ? "warning" : "info";

    findings.push({
      finding_kind: "cross_version",
      severity,
      title: `Cross-version revision: ${disc.period} — ${materialMetrics.length} material movement${materialMetrics.length === 1 ? "" : "s"}`,
      detail: disc.headline ?? disc.description,
      full_analysis: `[CROSS_VERSION] ${disc.description}\n\nMaterial movements:\n` +
        materialMetrics.map(m => {
          const sign = m.sourceA > m.sourceB ? "+" : "−";
          const mag = m.absDiff >= 1_000_000 ? `£${(m.absDiff / 1_000_000).toFixed(1)}m` : `£${(m.absDiff / 1_000).toFixed(0)}k`;
          return `  - ${m.label}: ${sign}${mag} (${m.relDiffPct.toFixed(1)}%)`;
        }).join("\n") +
        "\n\nConfirm whether these reflect intentional model updates or stale references in the memo.",
      severity_anchor: maxDelta,
      source_docs: disc.sources,
      claim: null as any, // Cross-version findings don't originate from a memo claim
      model_figure: null,
      delta_abs: maxDelta,
      delta_pct: materialMetrics.length > 0 ? Math.max(...materialMetrics.map(m => m.relDiffPct / 100)) : null,
    });
    cross_version_findings++;
  }

  // ----- Step 6: REMOVED (Corrective E2) -----
  // Supersession logic moved to runPostMergePipeline() Stage 3.5 where
  // current-run finding IDs are available as deletion targets.
  // Prior-run IDs must NEVER be used as targets since they are unstable across runs.

  // ----- U5: Findings dump — generate stable report ID & apply 3MB guard -----
  const findings_report_id = generateUUID();
  const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024; // 3MB
  let findings_truncated = false;
  const payloadEstimate = JSON.stringify(findings).length;
  if (payloadEstimate > MAX_PAYLOAD_BYTES) {
    // Truncate findings to fit within 3MB — keep the first N findings
    // that fit under the cap. Priority: critical > warning > info.
    const sorted = [...findings].sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      return (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3);
    });
    let accum = 0;
    let cutoff = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      accum += JSON.stringify(sorted[i]).length + 50; // overhead per entry
      if (accum > MAX_PAYLOAD_BYTES * 0.9) { // leave 10% headroom for envelope
        cutoff = i;
        break;
      }
    }
    findings.length = 0;
    findings.push(...sorted.slice(0, cutoff));
    findings_truncated = true;
    console.log(
      `[Reconciliation] U5: Findings truncated from ${sorted.length} to ${cutoff} ` +
      `to fit 3MB guard (estimated ${(payloadEstimate / 1_048_576).toFixed(1)}MB)`
    );
  }

  // ----- F3: Persist findings to own table (non-fatal) -----
  try {
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS reconciliation_findings (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         report_id text NOT NULL,
         deal_id text,
         findings jsonb NOT NULL,
         findings_count integer NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      [],
      { label: "Ensure reconciliation_findings table exists" }
    );
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_report_id
       ON reconciliation_findings(report_id)`,
      [],
      { label: "Ensure report_id index" }
    );
    await ctx.integrations.db.execute(
      `INSERT INTO reconciliation_findings (report_id, deal_id, findings, findings_count)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [findings_report_id, dealId ?? null, JSON.stringify(findings), findings.length],
      { label: "Persist reconciliation findings" }
    );
  } catch (err) {
    console.warn(
      `[Reconciliation] F3: Failed to persist findings (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ----- U6: Coverage denominator math -----
  // Adjudicable = dedupedClaims (unique coordinates) − UNDATED period
  // Scenario claims already excluded in Step 1b. NONE_STATED scope IS adjudicable.
  const distinctClaims = dedupedClaims.length;
  const adjudicable = dedupedClaims.length - no_coordinate_no_period;
  const matched = reconciled_count + within_tolerance_count;
  const coverage_pct = adjudicable > 0 ? matched / adjudicable : 0;
  const coverage_with_near_miss_pct = adjudicable > 0 ? (matched + near_miss_count) / adjudicable : 0;

  console.log(
    `[Reconciliation] Complete: ${findings.length} findings ` +
    `(${reconciled_count} reconciled, ${within_tolerance_count} within tolerance, ` +
    `${unreconcilable_count} unreconcilable, ${scope_mismatch_count} scope mismatches, ` +
    `${near_miss_count} near-misses, ${ambiguous_reference_count} ambiguous, ${cross_version_findings} cross-version). ` +
    `Coverage: ${matched}/${adjudicable} = ${(coverage_pct * 100).toFixed(1)}% ` +
    `(with near-miss: ${(coverage_with_near_miss_pct * 100).toFixed(1)}%). ` +
    `Elapsed: ${Math.round((Date.now() - phaseStart) / 1000)}s`
  );

  return {
    findings,
    findings_report_id,
    findings_truncated,
    reconciled_count,
    unreconcilable_count,
    scope_mismatch_count,
    within_tolerance_count,
    cross_version_findings,
    near_miss_count,
    ambiguous_reference_count,
    matching_error,
    coverage: {
      raw_claims: ledger.claims.length,
      distinct_claims: distinctClaims,
      scenario_excluded,
      no_scope_count: no_coordinate_no_scope,
      no_scope_near_miss_eligible,
      no_period_count: no_coordinate_no_period,
      ambiguous_reference_count,
      adjudicable,
      matched,
      near_miss: near_miss_count,
      unmatched: adjudicable - matched - near_miss_count,
      coverage_pct,
      coverage_with_near_miss_pct,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Historical-actuals backstop: determines if a claim's period represents a
 * PAST ACTUAL year (settled financials that don't change).
 *
 * Returns true for periods like "FY Mar-23A", "FY Mar-24", "FY23", "2023", "FY Mar-25"
 * Returns false for:
 *   - Current year (FY Mar-26) or any year >= 2026 (deal year)
 *   - Forecasts: "FY Mar-27F", "FY Mar-28F"
 *   - Budget/LE: "FY Mar-26LE", "FY Mar-26B"
 *   - Run-rates: "Jun-26 RR"
 *   - Multi-year ranges: "FY23-26", "FY26-31F" (these are growth rates, not actuals)
 *   - Non-year periods: "L3Y", "LTM", "current"
 *
 * The cutoff is conservative: anything that MIGHT be current or forward → false.
 * Only clearly settled past years trigger the backstop.
 */
function isHistoricalActualPeriod(period: string): boolean {
  const p = period.trim();

  // Exclude multi-year ranges (CAGRs) — these aren't single-year actuals
  if (p.includes("-") && /\d{2,4}.*-.*\d{2,4}/.test(p)) return false;

  // Exclude run-rates, LTM, L3Y, current
  const lp = p.toLowerCase();
  if (lp.includes("rr") || lp.includes("ltm") || lp.includes("l3y") || lp.includes("current")) return false;

  // Exclude budgets and forecasts (F, B, LE suffix)
  if (/[FfBb]$/.test(p) || /LE$/i.test(p)) return false;

  // Extract the year from the period string
  const yearMatch = p.match(/\b(20\d{2})\b/) || p.match(/\b(\d{2})\b/);
  if (!yearMatch) return false;

  let year = parseInt(yearMatch[1], 10);
  if (year < 100) year += 2000; // "23" → 2023

  // Current deal year is 2026 (FY Mar-26 is the current year in this deal context)
  // Anything before 2026 is a past actual; 2026+ is current/forward
  const CURRENT_DEAL_YEAR = 2026;
  return year < CURRENT_DEAL_YEAR;
}

function normalizeClaimValue(claim: Claim): number {
  // Convert claim value to the same units as model figures (raw £)
  switch (claim.unit) {
    case "£m": return claim.value * 1_000_000;
    case "£k": return claim.value * 1_000;
    case "£": return claim.value;
    default: return claim.value * 1_000_000; // Default assumption: £m for financial claims
  }
}

function formatValue(claim: Claim): string {
  return `${claim.value}${claim.unit}`;
}

function findModelFigure(figures: Figure[], label: string, period: string): Figure | null {
  // Exact match first
  const exact = figures.find(f =>
    f.name.trim().toLowerCase() === label.trim().toLowerCase() &&
    f.period.trim().toLowerCase() === period.trim().toLowerCase()
  );
  if (exact) return exact;

  // Fuzzy: label contains + period year match
  const labelLower = label.trim().toLowerCase();
  const periodYear = period.match(/\b(20\d{2})\b/)?.[1];
  if (periodYear) {
    const fuzzy = figures.find(f =>
      f.name.trim().toLowerCase().includes(labelLower) &&
      f.period.includes(periodYear)
    );
    if (fuzzy) return fuzzy;

    // Even fuzzier: model figure label contains claim label
    const fuzzy2 = figures.find(f =>
      labelLower.includes(f.name.trim().toLowerCase()) &&
      f.period.includes(periodYear)
    );
    if (fuzzy2) return fuzzy2;
  }

  return null;
}

function parseMatchProposals(responseText: string): MatchProposal[] {
  let jsonStr = responseText.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((p: any) => ({
      claim_index: typeof p.claim_index === "number" ? p.claim_index : -1,
      match_status: p.match_status === "matched" || p.match_status === "no_model_line" || p.match_status === "scope_mismatch"
        ? p.match_status : "no_model_line",
      matched_label: typeof p.matched_label === "string" ? p.matched_label : null,
      matched_period: typeof p.matched_period === "string" ? p.matched_period : null,
      mismatch_reason: typeof p.mismatch_reason === "string" ? p.mismatch_reason : null,
    }));
  } catch {
    console.warn(`[Reconciliation] Failed to parse match proposals. First 500: ${jsonStr.slice(0, 500)}`);
    return [];
  }
}
