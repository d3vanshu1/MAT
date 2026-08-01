/**
 * Canonical Issue Identity — Q4 (Message 3)
 *
 * Groups Q3-admitted findings into canonical economic issues using STRICT
 * structured identity compatibility. No defaults, no inference, no fallbacks.
 *
 * CANONICAL KEY FIELDS (all required for identity):
 *   issue_domain
 *   issue_type
 *   metric
 *   period
 *   entity_or_segment
 *   scope
 *   unit
 *   actual_or_forecast
 *   accounting_basis
 *   comparison_basis
 *   direction_of_difference
 *
 * IDENTITY RULES:
 *   - Unknown MUST remain "unknown" — never default to a concrete value
 *   - Two candidates group ONLY when compatible on ALL relevant identity fields
 *   - Source overlap and title similarity are INSUFFICIENT for grouping
 *   - Ambiguous families are bounded and locally adjudicated, never giant-merged
 *
 * PROHIBITED DEFAULTS (from Message 3):
 *   - unknown → financial
 *   - unknown scope → group
 *   - missing basis → reported
 *   - missing period → nearby year
 *   - consultant → FDD
 *
 * TERMINAL OUTCOMES (every input has exactly one):
 *   retained_as_canonical_finding
 *   merged_into_canonical_finding
 *   excluded_with_reason
 *   degraded_family_preserved
 *
 * STRONG ACCOUNTING INVARIANTS (hard-fail on violation):
 *   - Every input has exactly one terminal outcome
 *   - Every canonical/degraded terminal reference has a real output record
 *   - Every output has terminal lineage
 *   - No member enters multiple families
 *   - No duplicate canonical IDs
 *   - Merged counts reconcile
 */

import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Canonical key schema — extended with unit, actual/forecast, accounting_basis
// ---------------------------------------------------------------------------

export const ISSUE_DOMAINS = ["financial", "operational", "commercial", "returns", "regulatory", "unknown"] as const;
export type IssueDomain = typeof ISSUE_DOMAINS[number];

export const ISSUE_TYPES = [
  "forecast_revision",
  "adjustment_change",
  "memo_model_gap",
  "segment_decline",
  "lbo_support",
  "retention_claim",
  "concentration_risk",
  "ma_integration",
  "cash_conversion",
  "market_position",
  "regulatory_compliance",
  "cross_version",
  "other",
  "unknown",
] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export const COMPARISON_BASES = [
  "memo_vs_model",
  "memo_vs_fdd",
  "memo_vs_cdd",
  "memo_vs_actual",
  "model_vs_fdd",
  "memo_versions",
  "ic_vs_external",
  "unknown",
] as const;
export type ComparisonBasis = typeof COMPARISON_BASES[number];

export const DIRECTIONS = [
  "overstatement",
  "understatement",
  "omission",
  "discrepancy",
  "unknown",
] as const;
export type Direction = typeof DIRECTIONS[number];

export const ACTUAL_OR_FORECAST = ["actual", "forecast", "unknown"] as const;
export type ActualOrForecast = typeof ACTUAL_OR_FORECAST[number];

export const CanonicalKeySchema = z.object({
  issue_domain: z.enum(ISSUE_DOMAINS),
  issue_type: z.enum(ISSUE_TYPES),
  metric: z.string(),
  period: z.string(),
  entity_or_segment: z.string(),
  scope: z.string().nullable(),
  unit: z.string().nullable(),
  actual_or_forecast: z.enum(ACTUAL_OR_FORECAST),
  accounting_basis: z.string().nullable(),
  comparison_basis: z.enum(COMPARISON_BASES),
  direction_of_difference: z.enum(DIRECTIONS),
});

export type CanonicalKey = z.infer<typeof CanonicalKeySchema>;

/**
 * Serializes a canonical key to a stable string for identity.
 */
export function serializeCanonicalKey(key: CanonicalKey): string {
  return [
    key.issue_domain,
    key.issue_type,
    key.metric.toLowerCase().replace(/\s+/g, "_"),
    key.period.toLowerCase().replace(/\s+/g, "_"),
    key.entity_or_segment.toLowerCase().replace(/\s+/g, "_"),
    key.scope ? key.scope.toLowerCase().replace(/\s+/g, "_") : "null",
    key.unit ? key.unit.toLowerCase().replace(/\s+/g, "_") : "null",
    key.actual_or_forecast,
    key.accounting_basis ? key.accounting_basis.toLowerCase().replace(/\s+/g, "_") : "null",
    key.comparison_basis,
    key.direction_of_difference,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Compatibility rules — STRICT, no defaults
// ---------------------------------------------------------------------------

/**
 * Checks whether two canonical keys are compatible.
 *
 * ALL conditions must pass. Source overlap and title similarity are INSUFFICIENT.
 */
export function areKeysCompatible(a: CanonicalKey, b: CanonicalKey): {
  compatible: boolean;
  reason: string;
  ambiguity?: string;
} {
  // Domain must match (but "unknown" is only compatible with itself)
  if (a.issue_domain !== b.issue_domain) {
    return { compatible: false, reason: `Different domain: '${a.issue_domain}' vs '${b.issue_domain}'` };
  }

  // Metric must be compatible (strict — no cross-metric aliases)
  if (!metricsCompatible(a.metric, b.metric)) {
    return { compatible: false, reason: `Incompatible metrics: '${a.metric}' vs '${b.metric}'` };
  }

  // Period must match — NEVER merge different periods
  if (!periodsCompatible(a.period, b.period)) {
    return { compatible: false, reason: `Different period: '${a.period}' vs '${b.period}'` };
  }

  // Entity/segment — strict match
  if (!entitiesCompatible(a.entity_or_segment, b.entity_or_segment)) {
    return { compatible: false, reason: `Different entity: '${a.entity_or_segment}' vs '${b.entity_or_segment}'` };
  }

  // Scope — exclusive scopes are never compatible
  if (a.scope !== null && b.scope !== null && !scopesCompatible(a.scope, b.scope)) {
    return { compatible: false, reason: `Incompatible scope: '${a.scope}' vs '${b.scope}'` };
  }

  // Actual vs Forecast — never merge actual with forecast
  if (a.actual_or_forecast !== "unknown" && b.actual_or_forecast !== "unknown" &&
      a.actual_or_forecast !== b.actual_or_forecast) {
    return { compatible: false, reason: `actual/forecast mismatch: '${a.actual_or_forecast}' vs '${b.actual_or_forecast}'` };
  }

  // Accounting basis — mutually exclusive when both specified
  if (a.accounting_basis !== null && b.accounting_basis !== null &&
      !accountingBasisCompatible(a.accounting_basis, b.accounting_basis)) {
    return { compatible: false, reason: `accounting_basis mismatch: '${a.accounting_basis}' vs '${b.accounting_basis}'` };
  }

  // Comparison basis — different bases = different issues
  if (a.comparison_basis !== "unknown" && b.comparison_basis !== "unknown" &&
      a.comparison_basis !== b.comparison_basis) {
    return { compatible: false, reason: `Different comparison_basis: '${a.comparison_basis}' vs '${b.comparison_basis}'` };
  }

  // Direction — opposite directions are never compatible
  if (a.direction_of_difference !== "unknown" && b.direction_of_difference !== "unknown" &&
      !directionsCompatible(a.direction_of_difference, b.direction_of_difference)) {
    return { compatible: false, reason: `Opposite directions: '${a.direction_of_difference}' vs '${b.direction_of_difference}'` };
  }

  // Issue type — forecast_revision ≠ memo_model_gap
  if (a.issue_type !== "unknown" && b.issue_type !== "unknown" &&
      !issueTypesCompatible(a.issue_type, b.issue_type)) {
    return { compatible: false, reason: `Incompatible issue_type: '${a.issue_type}' vs '${b.issue_type}'` };
  }

  return { compatible: true, reason: "All identity fields compatible" };
}

// ---------------------------------------------------------------------------
// Sub-checkers (STRICT — no aliases across distinct concepts)
// ---------------------------------------------------------------------------

function periodsCompatible(a: string, b: string): boolean {
  if (a === "unknown" || b === "unknown") return a === b; // unknown only groups with unknown
  const normalize = (p: string) => p.toLowerCase().replace(/[\s_-]/g, "");
  return normalize(a) === normalize(b);
}

function metricsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "unknown" || b === "unknown") return a === b;
  const normalize = (m: string) => m.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // STRICT metric groups — only true aliases
  // "reported ebitda" vs "cash ebitda" → SEPARATE (different accounting basis)
  // "ebitda" vs "ebitda_adjustments" → SEPARATE (different metric)
  // "revenue" vs "gp" → SEPARATE (different metric)
  const METRIC_ALIASES: string[][] = [
    ["revenue", "topline", "turnover", "sales"],
  ];
  for (const group of METRIC_ALIASES) {
    if (group.includes(na) && group.includes(nb)) return true;
  }
  return false;
}

function entitiesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "unknown" || b === "unknown") return a === b;
  const normalize = (e: string) => e.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // Group-like terms are compatible with each other
  const groupLike = ["group", "total", "consolidated"];
  if (groupLike.includes(na) && groupLike.includes(nb)) return true;

  // Everything else is distinct (segment ≠ group)
  return false;
}

function scopesCompatible(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // Mutually exclusive scope categories
  const EXCLUSIVE = [
    ["organic", "exclacq", "likeflike"],
    ["proforma", "pf", "inclacq", "maincl"],
    ["reported", "asreported", "statutory"],
    ["adjusted", "mgmtadj", "normalised"],
    ["cash", "cashbasis"],
  ];
  const findGroup = (s: string) => EXCLUSIVE.find(g => g.some(x => s.includes(x)));
  const ga = findGroup(na);
  const gb = findGroup(nb);
  if (ga && gb && ga !== gb) return false; // Different exclusive groups
  if (ga && gb && ga === gb) return true;  // Same group
  return false; // Unknown scope vs known → incompatible
}

function accountingBasisCompatible(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // GAAP ≠ IFRS ≠ management ≠ cash
  const EXCLUSIVE_BASES = [
    ["gaap", "usgaap"],
    ["ifrs"],
    ["management", "mgmt", "adjusted"],
    ["cash", "cashbasis"],
    ["statutory", "reported"],
  ];
  const findGroup = (s: string) => EXCLUSIVE_BASES.find(g => g.some(x => s.includes(x)));
  const ga = findGroup(na);
  const gb = findGroup(nb);
  if (ga && gb && ga !== gb) return false;
  return true;
}

function directionsCompatible(a: string, b: string): boolean {
  // Opposite directions are never compatible
  if ((a === "overstatement" && b === "understatement") ||
      (a === "understatement" && b === "overstatement")) return false;
  // omission is distinct from overstatement/understatement
  if ((a === "omission" && b !== "omission") || (b === "omission" && a !== "omission")) return false;
  return true;
}

function issueTypesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  // forecast_revision ≠ memo_model_gap (per Message 3 requirements)
  if ((a === "forecast_revision" && b === "memo_model_gap") ||
      (a === "memo_model_gap" && b === "forecast_revision")) return false;
  // adjustment_change ≠ forecast_revision
  if ((a === "adjustment_change" && b === "forecast_revision") ||
      (a === "forecast_revision" && b === "adjustment_change")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Identity result
// ---------------------------------------------------------------------------

export interface CanonicalIdentityResult {
  finding_id: string;
  corpus_index: number;
  title: string;
  canonical_key: CanonicalKey;
  canonical_key_str: string;
  derivation_method: "structured_deterministic" | "heuristic" | "singleton";
  confidence: "high" | "medium" | "low";
  reason: string;
  originating_claim_ids: string[];
  memo_versions: string[];
  source_docs: string[];
}

// ---------------------------------------------------------------------------
// Ambiguity types for bounded ambiguity path
// ---------------------------------------------------------------------------

export const AMBIGUITY_REASONS = [
  "conflicting_periods",
  "uncertain_scope",
  "metric_alias",
  "accounting_basis_conflict",
  "entity_ambiguity",
  "opposite_directions",
  "multi_issue_candidate",
] as const;
export type AmbiguityReason = typeof AMBIGUITY_REASONS[number];

export interface AmbiguousCandidate {
  finding_id: string;
  corpus_index: number;
  title: string;
  ambiguity_reasons: AmbiguityReason[];
  candidate_families: string[];
  resolution: "preserved_separate" | "degraded" | "adjudicated";
  adjudicated_key_str?: string;
}

// ---------------------------------------------------------------------------
// Claim chronology — for repeated claims across memo versions
// ---------------------------------------------------------------------------

export interface ClaimChronologyEntry {
  claim_id: string;
  claim_text: string;
  memo_version: string;
  /** Numeric value stated in this version */
  value: number | null;
  unit: string | null;
  /** Whether this claim was repeated, corrected, weakened, strengthened, or omitted */
  version_status: "introduced" | "repeated" | "corrected" | "weakened" | "strengthened" | "omitted";
}

// ---------------------------------------------------------------------------
// Degraded record persistence
// ---------------------------------------------------------------------------

export interface DegradedRecord {
  /** Original finding ID that failed construction */
  original_finding_id: string;
  /** The claim linkage from Q3 */
  claim_linkage_disposition: string;
  resolved_claim_id: string | null;
  /** Evidence that was available */
  evidence_snapshot_ids: string[];
  /** The family key it was assigned to */
  family_key_str: string | null;
  /** Why construction failed */
  failure_reason: string;
  /** Terminal reference for accounting */
  terminal_reference: string;
  /** Degraded output that is persisted (not just a terminal row) */
  degraded_output: {
    title: string;
    originating_claim_text: string | null;
    evidence_excerpts: string[];
    verification_status: "degraded";
    evidence_quality: "degraded";
  };
}

// ---------------------------------------------------------------------------
// Canonical Family
// ---------------------------------------------------------------------------

export interface CanonicalFamily {
  canonical_key_str: string;
  canonical_key: CanonicalKey;
  member_finding_ids: string[];
  all_originating_claim_ids: string[];
  memo_versions: string[];
  claim_chronology: ClaimChronologyEntry[];
  needs_llm_adjudication: boolean;
  members: CanonicalIdentityResult[];
}

// ---------------------------------------------------------------------------
// Strong accounting invariants
// ---------------------------------------------------------------------------

export interface AccountingResult {
  valid: boolean;
  violations: string[];
}

/**
 * Validates terminal accounting invariants. Hard-fails on ANY violation.
 */
export function validateTerminalAccounting(params: {
  inputs: string[];
  terminalOutcomes: Map<string, string[]>;
  canonicalOutputIds: string[];
  degradedOutputIds: string[];
  memberToFamily: Map<string, string>;
  mergedCounts: Map<string, number>;
}): AccountingResult {
  const violations: string[] = [];

  // 1. Every input has exactly one terminal outcome
  for (const inputId of params.inputs) {
    const outcomes = params.terminalOutcomes.get(inputId) ?? [];
    if (outcomes.length === 0) {
      violations.push(`Input '${inputId}' has ZERO terminal outcomes`);
    } else if (outcomes.length > 1) {
      violations.push(`Input '${inputId}' has MULTIPLE terminal outcomes: ${outcomes.join(", ")}`);
    }
  }

  // 2. Every canonical/degraded reference has a real output
  for (const [inputId, outcomes] of params.terminalOutcomes) {
    for (const outcome of outcomes) {
      if (outcome.startsWith("cfnd-") && !params.canonicalOutputIds.includes(outcome)) {
        violations.push(`Terminal reference '${outcome}' for input '${inputId}' has no canonical output`);
      }
      if (outcome.startsWith("dgrdd-") && !params.degradedOutputIds.includes(outcome)) {
        violations.push(`Terminal reference '${outcome}' for input '${inputId}' has no degraded output`);
      }
    }
  }

  // 3. Every output has terminal lineage (at least one input points to it)
  for (const outputId of params.canonicalOutputIds) {
    const hasLineage = Array.from(params.terminalOutcomes.values()).some(outcomes => outcomes.includes(outputId));
    if (!hasLineage) {
      violations.push(`Canonical output '${outputId}' has no terminal lineage (no input references it)`);
    }
  }

  // 4. No member enters multiple families
  const memberFamilies = new Map<string, string[]>();
  for (const [member, family] of params.memberToFamily) {
    if (!memberFamilies.has(member)) memberFamilies.set(member, []);
    memberFamilies.get(member)!.push(family);
  }
  for (const [member, families] of memberFamilies) {
    if (families.length > 1) {
      violations.push(`Member '${member}' appears in MULTIPLE families: ${families.join(", ")}`);
    }
  }

  // 5. No duplicate canonical IDs
  const idSet = new Set<string>();
  for (const id of params.canonicalOutputIds) {
    if (idSet.has(id)) {
      violations.push(`DUPLICATE canonical ID: '${id}'`);
    }
    idSet.add(id);
  }

  // 6. Merged counts reconcile
  for (const [canonicalId, expectedCount] of params.mergedCounts) {
    const actualMembers = Array.from(params.terminalOutcomes.entries())
      .filter(([, outcomes]) => outcomes.includes(canonicalId))
      .length;
    if (actualMembers !== expectedCount) {
      violations.push(`Canonical '${canonicalId}': expected ${expectedCount} merged members, found ${actualMembers}`);
    }
  }

  return { valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Deterministic key derivation — NO DEFAULTS
// ---------------------------------------------------------------------------

/**
 * Derives a canonical key. NEVER assigns a default for an unknown field.
 * Unknown MUST remain "unknown".
 */
export function deriveCanonicalKey(finding: {
  title: string;
  detail?: string | null;
  full_analysis?: string | null;
  severity?: string | null;
  source_tag?: string | null;
  finding_kind?: string | null;
  issue_key?: string | null;
  originating_claim_id?: string | null;
  claim_ids?: string[] | null;
  source_docs?: string[] | null;
  claim_type?: string | null;
}): CanonicalKey | null {
  const title = (finding.title ?? "").toLowerCase();
  const detail = (finding.detail ?? finding.full_analysis ?? "").toLowerCase();
  const text = `${title} ${detail}`;

  // --- Issue Domain (NO default to "financial") ---
  let issue_domain: IssueDomain = "unknown";
  if (/\b(revenue|ebitda|margin|cost|capex|opex|cash.*flow|debt|leverage|adj)\b/.test(text)) {
    issue_domain = "financial";
  } else if (/\b(retention|churn|customer|concentration|market|commercial|competitive)\b/.test(text)) {
    issue_domain = "commercial";
  } else if (/\b(calls?.*lines?|operational|segment|volume|headcount)\b/.test(text)) {
    issue_domain = "operational";
  } else if (/\b(lbo|irr|return|mom|exit|leverage|deleverag)\b/.test(text)) {
    issue_domain = "returns";
  } else if (/\b(regulat|legal|contract|compliance)\b/.test(text)) {
    issue_domain = "regulatory";
  }

  // --- Issue Type ---
  let issue_type: IssueType = "unknown";
  if (/\b(adjust|add.?back|normaliz|ebitda\s+adj)\b/.test(text)) {
    issue_type = "adjustment_change";
  } else if (/\b(revis|update|increas|decreas|lower|higher).{0,30}(forecast|model)\b/.test(text) ||
             /\b(forecast|model).{0,30}(revis|update|increas|decreas|lower|higher)\b/.test(text) ||
             /\brevision\b/.test(text)) {
    issue_type = "forecast_revision";
  } else if (/\b(not reconcil|gap between|diverge|model.*memo|memo.*model)\b/.test(text)) {
    issue_type = "memo_model_gap";
  } else if (/\bcalls?.*lines?\b.*\b(declin|shrink|contract)\b/.test(text)) {
    issue_type = "segment_decline";
  } else if (/\b(lbo|returns|irr|mom|deleverag)\b/.test(text)) {
    issue_type = "lbo_support";
  } else if (/\b(retention|churn)\b/.test(text)) {
    issue_type = "retention_claim";
  } else if (/\b(m&a|acquisition|integration)\b/.test(text)) {
    issue_type = "ma_integration";
  }

  // --- Metric ---
  let metric = "unknown";
  if (/\bebitda\s+adj/.test(text) || /\badjust.*ebitda\b/.test(text)) {
    metric = "ebitda_adjustments";
  } else if (/\bebitda\b/.test(text)) {
    metric = "ebitda";
  } else if (/\brevenue\b|\bturnover\b|\bsales\b/.test(text)) {
    metric = "revenue";
  } else if (/\bgross.?profit\b|\bgp\b/.test(text)) {
    metric = "gross_profit";
  } else if (/\bcalls?.*lines?\b/.test(text)) {
    metric = "calls_and_lines";
  } else if (/\bretention\b/.test(text)) {
    metric = "customer_retention";
  } else if (/\birr\b|\breturns?\b/.test(text)) {
    metric = "lbo_returns";
  } else if (/\bgross.?margin\b/.test(text)) {
    metric = "gross_margin";
  }

  // --- Period (NO default to nearby year) ---
  let period = "unknown";
  const periodPatterns: [RegExp, string][] = [
    [/\bfy.*?26\b|\bfy2026\b|\bfy26\b/i, "fy26"],
    [/\bfy.*?25\b|\bfy2025\b|\bfy25\b/i, "fy25"],
    [/\bfy.*?24\b|\bfy2024\b|\bfy24\b/i, "fy24"],
    [/\bh1.*?26\b|\bfirst.half.*26\b/i, "h1_26"],
    [/\bh2.*?26\b|\bsecond.half.*26\b/i, "h2_26"],
    [/\bltm\b|\blast.*twelve\b/i, "ltm"],
    [/\bcagr\b/i, "multi_year_cagr"],
  ];
  for (const [re, p] of periodPatterns) {
    if (re.test(text)) { period = p; break; }
  }

  // --- Entity/Segment (NO default to "group") ---
  let entity_or_segment = "unknown";
  if (/\bgroup\b|\bconsolidated\b|\btotal\b/.test(text)) {
    entity_or_segment = "group";
  } else if (/\bcalls?.*lines?\b/.test(text)) {
    entity_or_segment = "calls_and_lines";
  } else if (/\bcustomer.base\b/.test(text)) {
    entity_or_segment = "customer_base";
  } else if (/\borganic\b/.test(text)) {
    entity_or_segment = "organic";
  }

  // --- Scope (NO default) ---
  let scope: string | null = null;
  if (/\borganic\b/.test(text)) scope = "organic";
  else if (/\bpro.?forma\b|\bpf\b/.test(text)) scope = "proforma";
  else if (/\bcash\b/.test(text) && metric === "ebitda") scope = "cash";
  else if (/\breported\b/.test(text)) scope = "reported";

  // --- Unit ---
  let unit: string | null = null;
  if (/£m\b/.test(text) || /\bgbp\b/.test(text)) unit = "£m";
  else if (/\$m\b/.test(text) || /\busd\b/.test(text)) unit = "$m";
  else if (/%\b/.test(text)) unit = "%";

  // --- Actual/Forecast ---
  let actual_or_forecast: ActualOrForecast = "unknown";
  if (/\bforecast\b|\bbudget\b|\bplan\b|\bprojected\b/.test(text)) actual_or_forecast = "forecast";
  else if (/\bactual\b|\breported\b|\bhistoric\b/.test(text)) actual_or_forecast = "actual";

  // --- Accounting Basis (NO default) ---
  let accounting_basis: string | null = null;
  if (/\bgaap\b/.test(text)) accounting_basis = "gaap";
  else if (/\bifrs\b/.test(text)) accounting_basis = "ifrs";
  else if (/\bmanagement\b|\bmgmt\b/.test(text)) accounting_basis = "management";
  else if (/\bcash\b/.test(text) && metric === "ebitda") accounting_basis = "cash";

  // --- Comparison Basis (NO default, NO consultant → FDD) ---
  let comparison_basis: ComparisonBasis = "unknown";
  if (/\bfdd\b|\bvendor.dd\b|\bfinancial.due.diligence\b/.test(text)) {
    comparison_basis = "memo_vs_fdd";
  } else if (/\bcdd\b|\bcommercial.dd\b/.test(text)) {
    comparison_basis = "memo_vs_cdd";
  } else if (/\bmodel\b/.test(text) && /\b(memo|ic)\b/.test(text)) {
    comparison_basis = "memo_vs_model";
  } else if (/\bversion\b|\bprev.*memo\b|\bearli.*memo\b/.test(text)) {
    comparison_basis = "memo_versions";
  }
  // NOTE: Do NOT infer FDD from source_tag === "consultant_report"

  // --- Direction ---
  let direction_of_difference: Direction = "unknown";
  if (/\boverstat\b|\btoo.high\b|\babove\b|\bhigher\b/.test(text)) direction_of_difference = "overstatement";
  else if (/\bunderstat\b|\btoo.low\b|\bbelow\b|\blower\b/.test(text)) direction_of_difference = "understatement";
  else if (/\bnot.?provided\b|\bnot.?available\b|\babsent\b|\bmissing\b/.test(text)) direction_of_difference = "omission";
  else if (/\bdiscrepan\b|\bdiverge\b|\bcontradict\b|\binconsisten\b/.test(text)) direction_of_difference = "discrepancy";

  // If metric and period are both unknown, cannot determine key
  if (metric === "unknown" && period === "unknown") {
    return null;
  }

  return {
    issue_domain,
    issue_type,
    metric,
    period,
    entity_or_segment,
    scope,
    unit,
    actual_or_forecast,
    accounting_basis,
    comparison_basis,
    direction_of_difference,
  };
}

// ---------------------------------------------------------------------------
// Canonical family grouping — with ambiguous-family path
// ---------------------------------------------------------------------------

/**
 * Groups findings into canonical families using STRICT identity compatibility.
 *
 * No candidate disappears: every input has exactly one of:
 *   - assigned to a family
 *   - treated as singleton
 *   - flagged as ambiguous (and preserved separate or degraded)
 */
export function groupIntoCanonicalFamilies(
  findings: Array<{
    finding_id: string;
    corpus_index: number;
    title: string;
    detail?: string | null;
    full_analysis?: string | null;
    severity?: string | null;
    source_tag?: string | null;
    finding_kind?: string | null;
    issue_key?: string | null;
    originating_claim_id?: string | null;
    claim_ids?: string[] | null;
    source_docs?: string[] | null;
    claim_type?: string | null;
  }>,
): {
  families: CanonicalFamily[];
  singletons: CanonicalIdentityResult[];
  ambiguous: AmbiguousCandidate[];
  degraded: DegradedRecord[];
  memberToFamily: Map<string, string>;
} {
  const familyMap = new Map<string, CanonicalFamily>();
  const singletons: CanonicalIdentityResult[] = [];
  const ambiguous: AmbiguousCandidate[] = [];
  const degraded: DegradedRecord[] = [];
  const memberToFamily = new Map<string, string>();

  for (const finding of findings) {
    const derivedKey = deriveCanonicalKey(finding);

    if (!derivedKey) {
      // Cannot derive key → singleton (preserved, not lost)
      const singletonKeyStr = `singleton|${finding.finding_id}`;
      singletons.push({
        finding_id: finding.finding_id,
        corpus_index: finding.corpus_index,
        title: finding.title,
        canonical_key: buildSingletonKey(),
        canonical_key_str: singletonKeyStr,
        derivation_method: "singleton",
        confidence: "low",
        reason: "Cannot determine canonical key from structured metadata",
        originating_claim_ids: getClaimIds(finding),
        memo_versions: [],
        source_docs: finding.source_docs ?? [],
      });
      memberToFamily.set(finding.finding_id, singletonKeyStr);
      continue;
    }

    const keyStr = serializeCanonicalKey(derivedKey);

    // Check for multi-family ambiguity: could this finding match MULTIPLE existing families?
    const compatibleFamilies: string[] = [];
    for (const [existingKeyStr, family] of familyMap) {
      if (existingKeyStr === keyStr) {
        compatibleFamilies.push(existingKeyStr);
      } else {
        const compat = areKeysCompatible(derivedKey, family.canonical_key);
        if (compat.compatible) {
          compatibleFamilies.push(existingKeyStr);
        }
      }
    }

    if (compatibleFamilies.length > 1) {
      // Multi-family ambiguity: preserve as separate/degraded
      ambiguous.push({
        finding_id: finding.finding_id,
        corpus_index: finding.corpus_index,
        title: finding.title,
        ambiguity_reasons: ["multi_issue_candidate"],
        candidate_families: compatibleFamilies,
        resolution: "preserved_separate",
      });
      // Treat as singleton — never merge into giant family
      const singletonKeyStr = `ambiguous|${finding.finding_id}`;
      memberToFamily.set(finding.finding_id, singletonKeyStr);
      continue;
    }

    // Standard path: add to the matching family or create new one
    const identityResult: CanonicalIdentityResult = {
      finding_id: finding.finding_id,
      corpus_index: finding.corpus_index,
      title: finding.title,
      canonical_key: derivedKey,
      canonical_key_str: keyStr,
      derivation_method: "structured_deterministic",
      confidence: assessConfidence(derivedKey),
      reason: "Deterministic key from structured metadata",
      originating_claim_ids: getClaimIds(finding),
      memo_versions: [],
      source_docs: finding.source_docs ?? [],
    };

    if (familyMap.has(keyStr)) {
      const family = familyMap.get(keyStr)!;
      family.member_finding_ids.push(finding.finding_id);
      family.all_originating_claim_ids.push(...getClaimIds(finding));
      family.members.push(identityResult);
    } else {
      familyMap.set(keyStr, {
        canonical_key_str: keyStr,
        canonical_key: derivedKey,
        member_finding_ids: [finding.finding_id],
        all_originating_claim_ids: getClaimIds(finding),
        memo_versions: [],
        claim_chronology: [],
        needs_llm_adjudication: false,
        members: [identityResult],
      });
    }
    memberToFamily.set(finding.finding_id, keyStr);
  }

  // Deduplicate claim IDs within families
  for (const family of familyMap.values()) {
    family.all_originating_claim_ids = [...new Set(family.all_originating_claim_ids)];
  }

  return {
    families: Array.from(familyMap.values()),
    singletons,
    ambiguous,
    degraded,
    memberToFamily,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClaimIds(finding: {
  originating_claim_id?: string | null;
  claim_ids?: string[] | null;
}): string[] {
  const ids: string[] = [];
  if (finding.originating_claim_id) ids.push(finding.originating_claim_id);
  if (finding.claim_ids) ids.push(...finding.claim_ids);
  return [...new Set(ids)];
}

function buildSingletonKey(): CanonicalKey {
  return {
    issue_domain: "unknown",
    issue_type: "unknown",
    metric: "unknown",
    period: "unknown",
    entity_or_segment: "unknown",
    scope: null,
    unit: null,
    actual_or_forecast: "unknown",
    accounting_basis: null,
    comparison_basis: "unknown",
    direction_of_difference: "unknown",
  };
}

function assessConfidence(key: CanonicalKey): "high" | "medium" | "low" {
  let score = 0;
  if (key.metric !== "unknown") score++;
  if (key.period !== "unknown") score++;
  if (key.entity_or_segment !== "unknown") score++;
  if (key.issue_type !== "unknown") score++;
  if (key.scope !== null) score++;
  if (key.comparison_basis !== "unknown") score++;
  if (key.actual_or_forecast !== "unknown") score++;

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}
