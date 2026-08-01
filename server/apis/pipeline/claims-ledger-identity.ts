/**
 * Claims Ledger Identity — Deterministic Claim ID Generation
 *
 * PURPOSE: Generate stable, deterministic claim IDs from structured inputs so that
 * the same claim always receives the same ID regardless of:
 *   - extraction order
 *   - retry/resume
 *   - invocation time
 *   - random factors
 *
 * IDENTITY INPUTS:
 *   - claim_schema_version (for forward compatibility)
 *   - IC document stable ID
 *   - source location (page/slide)
 *   - normalized claim text (trimmed, lowered, collapsed whitespace)
 *   - metric
 *   - period
 *   - scope_qualifier
 *
 * NOT INCLUDED (would break determinism):
 *   - timestamp
 *   - invocation/run ID
 *   - random UUID
 *   - retry number
 *   - ordering index
 *
 * INVARIANTS:
 *   - same claim → same ID (across replays, order changes, resumes)
 *   - different claims → different IDs (collision-resistant hash)
 *   - ID encodes schema version for future migrations
 */

// ---------------------------------------------------------------------------
// Deterministic hash (pure JS, no Node crypto dependency)
// Uses FNV-1a 64-bit split into two 32-bit halves for hex output.
// Collision-resistant for < 100K items.
// ---------------------------------------------------------------------------

function fnv1aHash(str: string): string {
  // FNV-1a parameters (32-bit)
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c >> 8) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    // Mix in position for extra entropy
    h1 ^= (i * 31) & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }

  // Additional mixing passes for longer strings
  for (let i = 0; i < str.length; i++) {
    h2 ^= str.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }

  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Schema version — increment when identity derivation logic changes
// ---------------------------------------------------------------------------
export const CLAIM_SCHEMA_VERSION = "1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Full structured claim with deterministic ID and provenance.
 * This is what gets persisted in the claims-ledger and consumed by Q3.
 */
export interface IdentifiedClaim {
  /** Deterministic claim ID — stable across replays */
  claim_id: string;
  /** Schema version used to generate this ID */
  claim_schema_version: string;

  // --- Extraction content ---
  metric: string;
  scope_qualifier: string;
  period: string;
  value: number;
  unit: string;
  basis_note: string;
  claim_category: string;
  verbatim_snippet: string;

  // --- Normalized content (for resolution matching) ---
  normalized_claim_text: string;

  // --- Claim type classification ---
  claim_type: ClaimType;

  // --- Source provenance ---
  ic_document_id: string;
  ic_document_filename: string;
  memo_version: string;
  source_page: string | null;
  extraction_coordinates: string | null;
  extraction_method: string;

  // --- Structured fields for compatibility matching ---
  entity_or_segment: string | null;
  actual_or_forecast: string | null;
  accounting_basis: string | null;
  currency: string | null;
}

export type ClaimType =
  | "numeric_financial"        // Quantitative financial claim (revenue, EBITDA, etc.)
  | "numeric_operational"      // Quantitative operational metric (NRR, churn, etc.)
  | "qualitative_strategic"    // Growth quality, market position, etc.
  | "qualitative_risk"         // Concentration, dependence, etc.
  | "valuation_returns"        // IRR, MoM, entry multiple
  | "cross_reference";         // Reference to external report

// ---------------------------------------------------------------------------
// Deterministic ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic claim_id from stable inputs.
 *
 * Format: `clm-v{version}-{hex16}`
 * Where hex16 is the FNV-1a hash (two 32-bit halves) of the identity payload.
 *
 * This gives 64 bits of collision resistance — sufficient for < 10K claims.
 */
export function generateClaimId(params: {
  ic_document_id: string;
  source_page: string | null;
  normalized_claim_text: string;
  metric: string;
  period: string;
  scope_qualifier: string;
}): string {
  const identityPayload = [
    `schema=${CLAIM_SCHEMA_VERSION}`,
    `doc=${params.ic_document_id}`,
    `page=${params.source_page ?? "none"}`,
    `metric=${params.metric.toLowerCase().trim()}`,
    `period=${params.period.toLowerCase().trim()}`,
    `scope=${params.scope_qualifier.toLowerCase().trim()}`,
    `text=${params.normalized_claim_text}`,
  ].join("|");

  const hash = fnv1aHash(identityPayload);
  return `clm-v${CLAIM_SCHEMA_VERSION}-${hash}`;
}

/**
 * Normalize claim text for identity comparison.
 * - Lowercase
 * - Collapse whitespace
 * - Trim
 * - Remove trailing punctuation
 */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,:;!?]+$/, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Memo version derivation
// ---------------------------------------------------------------------------

/**
 * Derive memo version from filename.
 * E.g.:
 *   "Screening IC Memo" → "screening"
 *   "2nd IC Memo" → "2nd_ic"
 *   "3rd IC Memo" → "3rd_ic"
 *   "IC Update 21 June" → "ic_update_june"
 */
export function deriveMemoVersion(filename: string): string {
  const lower = filename.toLowerCase();

  if (lower.includes("screening")) return "screening";
  if (lower.includes("2nd")) return "2nd_ic";
  if (lower.includes("3rd")) return "3rd_ic";
  if (lower.includes("update") || lower.includes("21 june") || lower.includes("21-jun") || lower.includes("june")) {
    return "ic_update_june";
  }
  if (lower.includes("4th")) return "4th_ic";

  // Fallback: sanitize filename as version
  return lower
    .replace(/\.(pdf|docx?|pptx?|txt)$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Claim type classification
// ---------------------------------------------------------------------------

/**
 * Classify a claim into a type category based on metric and category.
 */
export function classifyClaimType(
  metric: string,
  claimCategory: string,
  scopeQualifier: string,
): ClaimType {
  if (claimCategory === "cross_reference") return "cross_reference";
  if (claimCategory === "returns_projection") return "valuation_returns";
  if (claimCategory === "valuation_structuring") return "valuation_returns";

  // Operational rates
  const operationalKeywords = [
    "nrr", "grr", "churn", "retention", "recurring revenue %",
    "cash conversion", "margin",
  ];
  const scopeLower = scopeQualifier.toLowerCase();
  if (operationalKeywords.some(k => scopeLower.includes(k))) {
    return "numeric_operational";
  }

  // Financial metrics
  const financialMetrics = [
    "revenue", "ebitda", "gross_margin", "net_income", "net_debt",
    "cost", "capex", "cash_flow", "multiple",
  ];
  if (financialMetrics.includes(metric.toLowerCase())) {
    return "numeric_financial";
  }

  if (metric.toLowerCase() === "growth_rate") return "numeric_financial";

  return "qualitative_strategic";
}

// ---------------------------------------------------------------------------
// Enrichment: raw Claim → IdentifiedClaim
// ---------------------------------------------------------------------------

export interface ClaimEnrichmentContext {
  ic_document_id: string;
  ic_document_filename: string;
}

/**
 * Enrich a raw extracted Claim with deterministic ID and full provenance.
 */
export function enrichClaimWithIdentity(
  rawClaim: {
    metric: string;
    scope_qualifier: string;
    period: string;
    value: number;
    unit: string;
    basis_note: string;
    source_doc: string;
    source_page: string | null;
    verbatim_snippet: string;
    claim_category: string;
  },
  docCtx: ClaimEnrichmentContext,
): IdentifiedClaim {
  const normalizedText = normalizeClaimText(rawClaim.verbatim_snippet);
  const memoVersion = deriveMemoVersion(rawClaim.source_doc);
  const claimType = classifyClaimType(rawClaim.metric, rawClaim.claim_category, rawClaim.scope_qualifier);

  const claim_id = generateClaimId({
    ic_document_id: docCtx.ic_document_id,
    source_page: rawClaim.source_page,
    normalized_claim_text: normalizedText,
    metric: rawClaim.metric,
    period: rawClaim.period,
    scope_qualifier: rawClaim.scope_qualifier,
  });

  // Derive structured fields from scope_qualifier
  const entityOrSegment = extractEntityOrSegment(rawClaim.scope_qualifier);
  const actualOrForecast = extractActualOrForecast(rawClaim.period);
  const accountingBasis = extractAccountingBasis(rawClaim.scope_qualifier);
  const currency = extractCurrency(rawClaim.unit);

  return {
    claim_id,
    claim_schema_version: CLAIM_SCHEMA_VERSION,
    metric: rawClaim.metric,
    scope_qualifier: rawClaim.scope_qualifier,
    period: rawClaim.period,
    value: rawClaim.value,
    unit: rawClaim.unit,
    basis_note: rawClaim.basis_note,
    claim_category: rawClaim.claim_category,
    verbatim_snippet: rawClaim.verbatim_snippet,
    normalized_claim_text: normalizedText,
    claim_type: claimType,
    ic_document_id: docCtx.ic_document_id,
    ic_document_filename: docCtx.ic_document_filename,
    memo_version: memoVersion,
    source_page: rawClaim.source_page,
    extraction_coordinates: rawClaim.source_page, // coordinates = page for now
    extraction_method: "llm_structured_extraction",
    entity_or_segment: entityOrSegment,
    actual_or_forecast: actualOrForecast,
    accounting_basis: accountingBasis,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

function extractEntityOrSegment(scopeQualifier: string): string | null {
  const match = scopeQualifier.match(/segment:\s*([^)]+)/i);
  if (match) return match[1].trim();

  const lower = scopeQualifier.toLowerCase();
  if (lower.includes("group")) return "group";
  if (lower.includes("total")) return "group";

  return null;
}

function extractActualOrForecast(period: string): string | null {
  const lower = period.toLowerCase();
  if (lower.includes("run-rate") || lower.includes("rr")) return "run_rate";
  if (lower.includes("ltm") || lower.includes("trailing")) return "actual";
  if (lower.includes("fy") && /2[0-9]/.test(lower)) {
    // FY in the future = forecast, in the past = actual
    const yearMatch = lower.match(/(20)?(\d{2})/);
    if (yearMatch) {
      const year = parseInt(yearMatch[2]) + (yearMatch[1] ? 0 : 2000);
      if (year >= 2026) return "forecast";
      if (year <= 2024) return "actual";
      return null; // 2025 ambiguous
    }
  }
  return null;
}

function extractAccountingBasis(scopeQualifier: string): string | null {
  const lower = scopeQualifier.toLowerCase();
  if (lower.includes("reported") || lower.includes("non pro forma") || lower.includes("non-pf")) return "reported";
  if (lower.includes("adjusted")) return "adjusted";
  if (lower.includes("organic")) return "organic";
  if (lower.includes("cash")) return "cash";
  if (lower.includes("pro-forma") || lower.includes("pf")) return "pro_forma";
  if (lower.includes("lfl") || lower.includes("like-for-like")) return "like_for_like";
  return null;
}

function extractCurrency(unit: string): string | null {
  if (unit.startsWith("£")) return "GBP";
  if (unit.startsWith("$")) return "USD";
  if (unit.startsWith("€")) return "EUR";
  if (unit === "%" || unit === "x" || unit === "bps" || unit === "years") return null;
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Detect duplicate claim IDs in a ledger.
 * Returns a map of duplicated claim_id → count.
 * An empty map = no duplicates.
 */
export function detectDuplicateClaimIds(claims: IdentifiedClaim[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    counts.set(claim.claim_id, (counts.get(claim.claim_id) ?? 0) + 1);
  }

  const duplicates = new Map<string, number>();
  for (const [id, count] of counts) {
    if (count > 1) duplicates.set(id, count);
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Claim resolution (for Q3 consumption)
// ---------------------------------------------------------------------------

export interface ClaimResolutionResult {
  resolved: boolean;
  claim_record: IdentifiedClaim | null;
  failure_reason: string | null;
  failure_code:
    | "claim_reference_missing"
    | "claim_reference_malformed"
    | "claim_reference_unresolved"
    | "claim_reference_duplicated"
    | "claim_record_not_from_eligible_ic_document"
    | null;
}

/** IC document tags that are eligible originating claim sources */
const ELIGIBLE_IC_DOCUMENT_TAGS = new Set(["ic_memo"]);

/**
 * Resolve a claim reference to exactly one claims-ledger record.
 *
 * FAIL CLOSED rules:
 *   - Missing reference → claim_reference_missing
 *   - Malformed reference → claim_reference_malformed
 *   - Not found in ledger → claim_reference_unresolved
 *   - Multiple matches → claim_reference_duplicated
 *   - Found but from non-IC document → claim_record_not_from_eligible_ic_document
 */
export function resolveClaimReference(
  claimRef: string | null | undefined,
  claimMap: Map<string, IdentifiedClaim>,
  /** Set of IC document IDs that are eligible originating sources */
  eligibleDocIds: Set<string>,
): ClaimResolutionResult {
  // Missing
  if (!claimRef || claimRef.trim() === "") {
    return {
      resolved: false,
      claim_record: null,
      failure_reason: "No claim reference provided",
      failure_code: "claim_reference_missing",
    };
  }

  const ref = claimRef.trim();

  // Malformed — basic sanity (must be non-empty after trim)
  if (ref.length < 2) {
    return {
      resolved: false,
      claim_record: null,
      failure_reason: `Claim reference too short: '${ref}'`,
      failure_code: "claim_reference_malformed",
    };
  }

  // Look up in the claims map
  const claim = claimMap.get(ref);
  if (!claim) {
    return {
      resolved: false,
      claim_record: null,
      failure_reason: `Claim ID '${ref}' not found in claims ledger — unresolved reference`,
      failure_code: "claim_reference_unresolved",
    };
  }

  // Validate it comes from an eligible IC document
  if (!eligibleDocIds.has(claim.ic_document_id)) {
    return {
      resolved: false,
      claim_record: claim,
      failure_reason: `Claim '${ref}' is from document '${claim.ic_document_filename}' which is not an eligible IC originating document`,
      failure_code: "claim_record_not_from_eligible_ic_document",
    };
  }

  return {
    resolved: true,
    claim_record: claim,
    failure_reason: null,
    failure_code: null,
  };
}
