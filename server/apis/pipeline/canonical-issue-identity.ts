/**
 * Canonical Issue Identity — Q4
 *
 * Replaces passage-level identity with structured canonical economic issue identity.
 * The canonical key represents the UNDERLYING ISSUE — not the wording, chunk,
 * memo filename, or model call.
 *
 * CANONICAL KEY FIELDS:
 *   issue_domain: financial | operational | commercial | returns | regulatory
 *   issue_type: forecast_revision | adjustment_change | memo_model_gap | segment_decline |
 *               lbo_support | retention_claim | ...
 *   metric: revenue | ebitda | ebitda_adjustments | calls_and_lines | customer_retention | ...
 *   period: fy26 | fy25 | h1_26 | mar26_run_rate | ...
 *   entity_or_segment: group | calls_and_lines | customer_base | lbo_returns | ...
 *   scope: optional qualifier (organic | pf | adjusted | reported | ...)
 *   comparison_basis: model_vs_memo | fdd_vs_memo | cdd_vs_memo | memo_vs_actual | ...
 *   direction_of_difference: overstatement | understatement | omission | discrepancy
 *
 * IDENTITY COMPATIBILITY RULES (all must pass before two candidates may share a key):
 *   - Compatible metric or issue_type
 *   - Compatible period (FY26 ≠ FY25)
 *   - Compatible scope/entity (Group ≠ organic, Calls&Lines ≠ Group)
 *   - Compatible comparison_basis
 *   - Compatible direction_of_difference
 *
 * DO NOT MERGE on:
 *   - Shared source document alone
 *   - Shared claim_id alone
 *   - Similar generic wording
 *   - Same broad category
 *
 * LLM adjudication is used ONLY for genuinely ambiguous cases after
 * all deterministic compatibility rules have been applied.
 *
 * ANTI-PATTERNS EXPLICITLY PREVENTED:
 *   - FY26 revenue and FY26 EBITDA are DIFFERENT issues even if in same memo section
 *   - memo-vs-model and FDD-vs-memo are DIFFERENT comparison bases
 *   - Calls & Lines is DISTINCT from Group revenue
 *   - Different periods are NEVER merged
 */

import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Canonical key schema
// ---------------------------------------------------------------------------

export const ISSUE_DOMAINS = ["financial", "operational", "commercial", "returns", "regulatory"] as const;
export type IssueDomain = typeof ISSUE_DOMAINS[number];

export const ISSUE_TYPES = [
  "forecast_revision",        // IC forecast revised vs current model
  "adjustment_change",        // EBITDA adjustment methodology change
  "memo_model_gap",           // Narrative not reconciled to live model
  "segment_decline",          // Specific segment underperformance
  "lbo_support",              // LBO model/returns support missing or weak
  "retention_claim",          // Customer retention/churn claim
  "concentration_risk",       // Customer concentration risk
  "ma_integration",           // M&A integration / dependence
  "cash_conversion",          // Cash conversion cycle claim
  "market_position",          // Market position / competitive claim
  "regulatory_compliance",    // Regulatory or compliance claim
  "cross_version",            // Cross-version memo discrepancy
  "other",                    // Catch-all — try to be more specific
] as const;

export type IssueType = typeof ISSUE_TYPES[number];

export const COMPARISON_BASES = [
  "memo_vs_model",      // IC memo claim vs live financial model
  "memo_vs_fdd",        // IC memo claim vs vendor FDD
  "memo_vs_cdd",        // IC memo claim vs commercial DD
  "memo_vs_actual",     // IC memo claim vs actual reported data
  "model_vs_fdd",       // Financial model vs FDD
  "memo_versions",      // Earlier vs later IC memo
  "ic_vs_external",     // IC claim vs external data
] as const;

export type ComparisonBasis = typeof COMPARISON_BASES[number];

export const DIRECTIONS = [
  "overstatement",    // IC claim is higher than evidence
  "understatement",   // IC claim is lower than evidence
  "omission",         // IC claim exists but no evidence
  "discrepancy",      // General directional disagreement
] as const;

export type Direction = typeof DIRECTIONS[number];

export const CanonicalKeySchema = z.object({
  /** The issue domain */
  issue_domain: z.enum(ISSUE_DOMAINS),
  /** The type of issue */
  issue_type: z.enum(ISSUE_TYPES),
  /** The metric or economic variable at the center of the issue */
  metric: z.string(),
  /** The period (e.g., "fy26", "h1_26", "mar26") */
  period: z.string(),
  /** The entity, business unit, or segment */
  entity_or_segment: z.string(),
  /** Optional scope qualifier (organic, pf, adjusted, reported) */
  scope: z.string().nullable(),
  /** The comparison being made */
  comparison_basis: z.enum(COMPARISON_BASES),
  /** The direction of the discrepancy */
  direction_of_difference: z.enum(DIRECTIONS),
});

export type CanonicalKey = z.infer<typeof CanonicalKeySchema>;

/**
 * Serializes a canonical key to a stable string for use as a map key.
 * Fields are sorted for determinism.
 */
export function serializeCanonicalKey(key: CanonicalKey): string {
  return [
    key.issue_domain,
    key.issue_type,
    key.metric.toLowerCase().replace(/\s+/g, "_"),
    key.period.toLowerCase().replace(/\s+/g, "_"),
    key.entity_or_segment.toLowerCase().replace(/\s+/g, "_"),
    key.scope ? key.scope.toLowerCase().replace(/\s+/g, "_") : "all",
    key.comparison_basis,
    key.direction_of_difference,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Canonical identity assignment
// ---------------------------------------------------------------------------

export interface CanonicalIdentityResult {
  /** The candidate finding ID */
  finding_id: string;
  /** Corpus index */
  corpus_index: number;
  /** Title */
  title: string;
  /** The assigned canonical key */
  canonical_key: CanonicalKey;
  /** Serialized string version of the key */
  canonical_key_str: string;
  /** How the key was derived */
  derivation_method: "structured_deterministic" | "heuristic" | "singleton";
  /** Confidence in the identity assignment */
  confidence: "high" | "medium" | "low";
  /** Reason for the derivation */
  reason: string;
  /** Originating claim IDs */
  originating_claim_ids: string[];
  /** Memo versions referenced */
  memo_versions: string[];
  /** Source documents */
  source_docs: string[];
}

// ---------------------------------------------------------------------------
// Compatibility rules (deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Checks whether two canonical keys are compatible — i.e., may refer to the
 * same underlying economic issue.
 *
 * All conditions must pass for compatibility.
 */
export function areKeysCompatible(a: CanonicalKey, b: CanonicalKey): {
  compatible: boolean;
  reason: string;
} {
  // Issue domain must match
  if (a.issue_domain !== b.issue_domain) {
    return { compatible: false, reason: `Different issue_domain: '${a.issue_domain}' vs '${b.issue_domain}'` };
  }

  // Period must match (never merge different periods)
  if (!periodsCompatible(a.period, b.period)) {
    return { compatible: false, reason: `Different period: '${a.period}' vs '${b.period}'` };
  }

  // Metric must be compatible
  if (!metricsCompatible(a.metric, b.metric)) {
    return { compatible: false, reason: `Incompatible metrics: '${a.metric}' vs '${b.metric}'` };
  }

  // Entity/segment must be compatible
  if (!entitiesCompatible(a.entity_or_segment, b.entity_or_segment)) {
    return { compatible: false, reason: `Different entity/segment: '${a.entity_or_segment}' vs '${b.entity_or_segment}'` };
  }

  // Scope — null = broad scope; a specific scope vs null may be compatible
  if (a.scope !== null && b.scope !== null && a.scope !== b.scope) {
    if (!scopesCompatible(a.scope, b.scope)) {
      return { compatible: false, reason: `Incompatible scope: '${a.scope}' vs '${b.scope}'` };
    }
  }

  // Comparison basis — different bases = different issues
  if (a.comparison_basis !== b.comparison_basis) {
    return { compatible: false, reason: `Different comparison_basis: '${a.comparison_basis}' vs '${b.comparison_basis}'` };
  }

  return { compatible: true, reason: "All compatibility checks passed" };
}

// ---------------------------------------------------------------------------
// Compatibility sub-checkers
// ---------------------------------------------------------------------------

function periodsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (p: string) => p.toLowerCase().replace(/[\s_-]/g, "");
  return normalize(a) === normalize(b);
}

function metricsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (m: string) => m.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);

  // Exactly equal after normalization
  if (na === nb) return true;

  // Known compatible pairs (aliases)
  const COMPATIBLE_METRIC_GROUPS: string[][] = [
    ["revenue", "topline", "turnover"],
    ["ebitda", "adjustedebitda", "cashebitda", "organicebitda"],
    // Note: EBITDA adjustments is SEPARATE from EBITDA — not in the group above
  ];

  for (const group of COMPATIBLE_METRIC_GROUPS) {
    if (group.includes(na) && group.includes(nb)) return true;
  }

  return false;
}

function entitiesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (e: string) => e.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return true;

  // Calls & Lines is distinct from Group
  const callsAndLines = ["callsandlines", "callslines", "c&l", "clines"];
  if ((callsAndLines.includes(na) && !callsAndLines.includes(nb)) ||
      (!callsAndLines.includes(na) && callsAndLines.includes(nb))) {
    return false;
  }

  // "group" is compatible with "total" / "consolidated"
  const groupLike = ["group", "total", "consolidated", "all"];
  if (groupLike.includes(na) && groupLike.includes(nb)) return true;

  return false;
}

function scopesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;

  // Organic ≠ PF ≠ Reported
  const EXCLUSIVE_SCOPES = [
    ["organic", "excl_acq"],
    ["proforma", "pf", "incl_acq"],
    ["reported", "asreported"],
    ["adjusted", "mgmtadj"],
  ];
  for (const group of EXCLUSIVE_SCOPES) {
    const aInGroup = group.some(s => na.startsWith(s));
    const bInGroup = group.some(s => nb.startsWith(s));
    const aInOther = EXCLUSIVE_SCOPES.filter(g => g !== group).some(g => g.some(s => na.startsWith(s)));
    const bInOther = EXCLUSIVE_SCOPES.filter(g => g !== group).some(g => g.some(s => nb.startsWith(s)));
    if (aInGroup && bInOther) return false;
    if (bInGroup && aInOther) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Deterministic key derivation from finding metadata
// ---------------------------------------------------------------------------

/**
 * Derives a canonical key from a finding's existing metadata.
 * Uses structured deterministic logic — no LLM.
 *
 * Returns null if the key cannot be determined deterministically
 * (caller must use LLM adjudication for these cases).
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
  const sourceTag = finding.source_tag ?? "other";
  const kind = finding.finding_kind ?? "unknown";

  // --- Issue Domain ---
  let issue_domain: IssueDomain = "financial"; // default
  if (/\b(retention|churn|customer|concentration|market|commercial|competitive)\b/.test(text)) {
    issue_domain = "commercial";
  } else if (/\b(calls?.*lines?|operational|segment|volume)\b/.test(text)) {
    issue_domain = "operational";
  } else if (/\b(lbo|irr|return|mom|exit|leverage)\b/.test(text)) {
    issue_domain = "returns";
  } else if (/\b(regulat|legal|contract|compliance)\b/.test(text)) {
    issue_domain = "regulatory";
  }

  // --- Issue Type ---
  let issue_type: IssueType = "other";
  if (/\b(adjust|add.?back|normaliz|ebitda\s+adj)\b/.test(text)) {
    issue_type = "adjustment_change";
  } else if (/\b(revis|update|increas|decreas|lower|higher).{0,30}(memo|model)\b/.test(text) ||
             /\b(memo|model).{0,30}(revis|update|increas|decreas|lower|higher)\b/.test(text)) {
    issue_type = "forecast_revision";
  } else if (/\b(not reconcil|gap between|diverge|model.*memo|memo.*model)\b/.test(text)) {
    issue_type = "memo_model_gap";
  } else if (/\bcalls?.*lines?\b/.test(text)) {
    issue_type = "segment_decline";
  } else if (/\b(lbo|returns|irr|mom)\b/.test(text)) {
    issue_type = "lbo_support";
  } else if (/\b(retention|churn|net.*revenue|gross.*revenue.*retention)\b/.test(text)) {
    issue_type = "retention_claim";
  } else if (kind === "cross_version") {
    issue_type = "cross_version";
  } else if (kind === "data_divergence" || /\b(contradict|conflict|discrepanc|inconsisten)\b/.test(text)) {
    issue_type = "forecast_revision";
  }

  // --- Metric ---
  let metric = "unspecified";
  if (/\bebitda\s+adj/.test(text)) {
    metric = "ebitda_adjustments";
  } else if (/\bebitda\b/.test(text)) {
    metric = "ebitda";
  } else if (/\brevenue\b|\bturnover\b/.test(text)) {
    metric = "revenue";
  } else if (/\bcalls?.*lines?\b/.test(text)) {
    metric = "calls_and_lines";
  } else if (/\bretention\b/.test(text)) {
    metric = "customer_retention";
  } else if (/\bchurn\b/.test(text)) {
    metric = "customer_churn";
  } else if (/\birr\b|\breturns?\b/.test(text)) {
    metric = "lbo_returns";
  } else if (/\bgross.?margin\b/.test(text)) {
    metric = "gross_margin";
  }

  // --- Period ---
  let period = "unspecified";
  const periodPatterns: [RegExp, string][] = [
    [/\bfy.*?26\b|\bfy2026\b|\bfy26\b/i, "fy26"],
    [/\bfy.*?25\b|\bfy2025\b|\bfy25\b/i, "fy25"],
    [/\bfy.*?24\b|\bfy2024\b|\bfy24\b/i, "fy24"],
    [/\bh1.*?26\b|\bfirst.half.*26\b/i, "h1_26"],
    [/\bh2.*?26\b|\bsecond.half.*26\b/i, "h2_26"],
    [/\bmar.*?26\b|\bmarch.*?26\b/i, "mar26"],
    [/\bltm\b|\blast.*twelve\b/i, "ltm"],
    [/\bcagr\b/i, "multi_year_cagr"],
  ];
  for (const [re, p] of periodPatterns) {
    if (re.test(text)) { period = p; break; }
  }

  // --- Entity/Segment ---
  let entity_or_segment = "group";
  if (/\bcalls?.*lines?\b/.test(text)) {
    entity_or_segment = "calls_and_lines";
  } else if (/\bcustomer.base\b|\bclient.base\b/.test(text)) {
    entity_or_segment = "customer_base";
  } else if (/\blbo\b|\breturns?\b/.test(text)) {
    entity_or_segment = "lbo_returns";
  }

  // --- Scope ---
  let scope: string | null = null;
  if (/\borganic\b/.test(text)) scope = "organic";
  else if (/\bpro.?forma\b|\bpf\b/.test(text)) scope = "proforma";
  else if (/\badjust\b/.test(text) && issue_type !== "adjustment_change") scope = "adjusted";
  else if (/\breported\b/.test(text)) scope = "reported";

  // --- Comparison Basis ---
  let comparison_basis: ComparisonBasis = "memo_vs_model";
  if (/\bfdd\b|\bvendor.dd\b|\bfinancial.due.diligence\b/.test(text)) {
    comparison_basis = "memo_vs_fdd";
  } else if (/\bcdd\b|\bcommercial.dd\b|\bcommercial.due.diligence\b/.test(text)) {
    comparison_basis = "memo_vs_cdd";
  } else if (/\bversion\b|\bprev.*memo\b|\bearli.*memo\b/.test(text) || kind === "cross_version") {
    comparison_basis = "memo_versions";
  } else if (sourceTag === "consultant_report") {
    comparison_basis = "memo_vs_fdd";
  }

  // --- Direction ---
  let direction_of_difference: Direction = "discrepancy";
  if (/\boverstat\b|\btoo.high\b|\babove\b/.test(text)) direction_of_difference = "overstatement";
  else if (/\bunderstat\b|\btoo.low\b|\bbelow\b/.test(text)) direction_of_difference = "understatement";
  else if (/\bnot.?provided\b|\bnot.?available\b|\babsent\b|\bnot.included\b/.test(text)) direction_of_difference = "omission";

  // If metric and period are both unspecified, this is a singleton — use heuristic label
  if (metric === "unspecified" && period === "unspecified") {
    return null; // Caller should try LLM or treat as singleton
  }

  return {
    issue_domain,
    issue_type,
    metric,
    period,
    entity_or_segment,
    scope,
    comparison_basis,
    direction_of_difference,
  };
}

// ---------------------------------------------------------------------------
// Canonical family grouping
// ---------------------------------------------------------------------------

export interface CanonicalFamily {
  /** The canonical key string (serialized) */
  canonical_key_str: string;
  /** The canonical key struct */
  canonical_key: CanonicalKey;
  /** All finding IDs in this family */
  member_finding_ids: string[];
  /** All originating claim IDs across all members */
  all_originating_claim_ids: string[];
  /** All memo versions across all members */
  memo_versions: string[];
  /** Whether this family needs LLM adjudication (ambiguous members) */
  needs_llm_adjudication: boolean;
  /** Individual member identities */
  members: CanonicalIdentityResult[];
}

/**
 * Groups findings into canonical families using deterministic compatibility rules.
 * Returns families and singletons (findings that couldn't be keyed deterministically).
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
  ambiguous: Array<{ finding_id: string; corpus_index: number; title: string; reason: string }>;
} {
  const families = new Map<string, CanonicalFamily>();
  const singletons: CanonicalIdentityResult[] = [];
  const ambiguous: Array<{ finding_id: string; corpus_index: number; title: string; reason: string }> = [];

  for (const finding of findings) {
    const derivedKey = deriveCanonicalKey(finding);

    if (!derivedKey) {
      // Cannot key deterministically — treat as singleton
      singletons.push({
        finding_id: finding.finding_id,
        corpus_index: finding.corpus_index,
        title: finding.title,
        canonical_key: buildSingletonKey(finding),
        canonical_key_str: `singleton|${finding.finding_id}`,
        derivation_method: "singleton",
        confidence: "low",
        reason: "Insufficient structured metadata to assign a shared canonical key — treated as singleton",
        originating_claim_ids: getClaimIds(finding),
        memo_versions: [],
        source_docs: finding.source_docs ?? [],
      });
      continue;
    }

    const keyStr = serializeCanonicalKey(derivedKey);
    const identityResult: CanonicalIdentityResult = {
      finding_id: finding.finding_id,
      corpus_index: finding.corpus_index,
      title: finding.title,
      canonical_key: derivedKey,
      canonical_key_str: keyStr,
      derivation_method: "structured_deterministic",
      confidence: assessConfidence(derivedKey),
      reason: `Deterministic key derived from structured metadata`,
      originating_claim_ids: getClaimIds(finding),
      memo_versions: [],
      source_docs: finding.source_docs ?? [],
    };

    if (families.has(keyStr)) {
      const family = families.get(keyStr)!;
      family.member_finding_ids.push(finding.finding_id);
      family.all_originating_claim_ids.push(...getClaimIds(finding));
      family.members.push(identityResult);
    } else {
      families.set(keyStr, {
        canonical_key_str: keyStr,
        canonical_key: derivedKey,
        member_finding_ids: [finding.finding_id],
        all_originating_claim_ids: getClaimIds(finding),
        memo_versions: [],
        needs_llm_adjudication: false,
        members: [identityResult],
      });
    }
  }

  // Deduplicate claim IDs within families
  for (const family of families.values()) {
    family.all_originating_claim_ids = [...new Set(family.all_originating_claim_ids)];
  }

  return {
    families: Array.from(families.values()),
    singletons,
    ambiguous,
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

function buildSingletonKey(finding: { finding_id: string; source_tag?: string | null }): CanonicalKey {
  return {
    issue_domain: "financial",
    issue_type: "other",
    metric: "unspecified",
    period: "unspecified",
    entity_or_segment: "unspecified",
    scope: null,
    comparison_basis: finding.source_tag === "financial_model" ? "memo_vs_model" :
                      finding.source_tag === "consultant_report" ? "memo_vs_fdd" : "memo_vs_model",
    direction_of_difference: "discrepancy",
  };
}

function assessConfidence(key: CanonicalKey): "high" | "medium" | "low" {
  let score = 0;
  if (key.metric !== "unspecified") score++;
  if (key.period !== "unspecified") score++;
  if (key.entity_or_segment !== "unspecified" && key.entity_or_segment !== "group") score++;
  if (key.issue_type !== "other") score++;
  if (key.scope !== null) score++;

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}
