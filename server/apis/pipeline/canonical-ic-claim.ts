/**
 * Canonical IC Claim Ledger — MAT-F01
 *
 * PURPOSE: Every substantive MAT candidate must originate from one exact,
 * source-validated assertion in an IC memo. This module defines the versioned
 * canonical claim record, SHA-256 content-derived IDs, exact source validation,
 * and the claim-first admission gate.
 *
 * SCHEMA: ic-claim-v1
 *
 * KEY PRINCIPLES:
 *   1. Exact claim text must be a verbatim quotation from the source IC memo.
 *   2. Source validation verifies text presence and coordinate validity.
 *   3. Claim IDs are deterministic SHA-256 content hashes — stable across runs.
 *   4. No substantive candidate may be admitted without resolving to exactly
 *      one valid canonical claim.
 *   5. Qualitative AND quantitative claims are first-class.
 */

import { z } from "@superblocksteam/sdk-api";
import { sha256hex } from "./sha256-pure.js";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const IC_CLAIM_SCHEMA_VERSION = "ic-claim-v1";

// ---------------------------------------------------------------------------
// Canonical IC Claim Type
// ---------------------------------------------------------------------------

export interface CanonicalIcClaim {
  schema_version: "ic-claim-v1";
  claim_id: string;

  source: {
    document_id: string;
    document_name: string;
    memo_version: string;
    page_or_slide: number | string;
    section?: string;
    source_start?: number;
    source_end?: number;
  };

  exact_claim_text: string;
  claim_type: "quantitative" | "qualitative";

  target: {
    entity: string | null;
    segment: string | null;
  };

  proposition: {
    metric: string | null;
    qualitative_proposition: string | null;
    period: string | null;
    scope: string | null;
    unit: string | null;
    currency: string | null;
    scale: string | null;
    actual_forecast_status:
      | "actual"
      | "forecast"
      | "mixed"
      | "not_applicable"
      | "unknown";
    accounting_basis: string | null;
    stated_value: number | string | null;
  };

  source_validation: {
    exact_text_found: boolean;
    coordinate_valid: boolean;
    validation_method: string;
  };

  extraction: {
    extractor_version: string;
    extracted_at: string;
  };
}

// ---------------------------------------------------------------------------
// Zod schema for runtime validation
// ---------------------------------------------------------------------------

export const CanonicalIcClaimSchema = z.object({
  schema_version: z.literal("ic-claim-v1"),
  claim_id: z.string(),

  source: z.object({
    document_id: z.string(),
    document_name: z.string(),
    memo_version: z.string(),
    page_or_slide: z.union([z.number(), z.string()]),
    section: z.string().optional(),
    source_start: z.number().optional(),
    source_end: z.number().optional(),
  }),

  exact_claim_text: z.string().min(1),
  claim_type: z.enum(["quantitative", "qualitative"]),

  target: z.object({
    entity: z.string().nullable(),
    segment: z.string().nullable(),
  }),

  proposition: z.object({
    metric: z.string().nullable(),
    qualitative_proposition: z.string().nullable(),
    period: z.string().nullable(),
    scope: z.string().nullable(),
    unit: z.string().nullable(),
    currency: z.string().nullable(),
    scale: z.string().nullable(),
    actual_forecast_status: z.enum([
      "actual", "forecast", "mixed", "not_applicable", "unknown",
    ]),
    accounting_basis: z.string().nullable(),
    stated_value: z.union([z.number(), z.string(), z.null()]),
  }),

  source_validation: z.object({
    exact_text_found: z.boolean(),
    coordinate_valid: z.boolean(),
    validation_method: z.string(),
  }),

  extraction: z.object({
    extractor_version: z.string(),
    extracted_at: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// EXTRACTOR_VERSION — tracks claim extraction logic version
// ---------------------------------------------------------------------------

export const EXTRACTOR_VERSION = "mat-f01-v1.0.0";

// ---------------------------------------------------------------------------
// Content-derived claim ID — SHA-256
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic claim ID using SHA-256 over canonical identity inputs.
 *
 * Identity inputs (all included to ensure atomic uniqueness):
 *   - source document ID
 *   - memo version
 *   - exact claim text (normalized whitespace, trimmed)
 *   - page/slide coordinate
 *   - claim type
 *   - atomic proposition discriminator (metric OR qualitative_proposition)
 *   - scope
 *   - stated_value
 *   - unit/currency/scale
 *
 * Two atomic claims from the same source sentence (e.g. £194m revenue and
 * £57m cash EBITDA) receive DIFFERENT IDs because metric/scope/value differ.
 *
 * Format: `ic-v1-{first 32 hex chars of SHA-256}`
 *
 * Reprocessing unchanged source content produces identical claim IDs.
 */
export function generateCanonicalClaimId(params: {
  document_id: string;
  memo_version: string;
  exact_claim_text: string;
  page_or_slide: number | string;
  claim_type: "quantitative" | "qualitative";
  /** Atomic proposition discriminator — metric name or qualitative proposition */
  proposition_key?: string | null;
  /** Scope qualifier — disambiguates same metric at different scopes */
  scope?: string | null;
  /** Stated value — disambiguates same metric/scope at different values */
  stated_value?: number | string | null;
  /** Unit/currency/scale combined — disambiguates unit differences */
  unit_key?: string | null;
}): string {
  // Normalize text: collapse whitespace, trim, lowercase for identity
  const normalizedText = params.exact_claim_text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // Build atomic proposition discriminator — ensures two claims from the same
  // sentence get different IDs when they have different metrics/propositions
  const propKey = (params.proposition_key ?? "").trim().toLowerCase();
  const scopeKey = (params.scope ?? "").trim().toLowerCase();
  const valueKey = params.stated_value != null ? String(params.stated_value).trim() : "";
  const unitKey = (params.unit_key ?? "").trim().toLowerCase();

  const identityPayload = [
    `schema=${IC_CLAIM_SCHEMA_VERSION}`,
    `doc=${params.document_id}`,
    `memo=${params.memo_version}`,
    `page=${String(params.page_or_slide)}`,
    `type=${params.claim_type}`,
    `text=${normalizedText}`,
    `prop=${propKey}`,
    `scope=${scopeKey}`,
    `value=${valueKey}`,
    `unit=${unitKey}`,
  ].join("|");

  const hash = sha256hex(identityPayload);
  // Use first 32 hex chars (128 bits) — collision-resistant for < 1B claims
  return `ic-v1-${hash.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Source Validation
// ---------------------------------------------------------------------------

/**
 * Validate that exact_claim_text exists in the source document text.
 *
 * Rules:
 *   - exact_claim_text must occur verbatim (case-sensitive) in sourceText
 *   - Empty, whitespace-only, or null text fails validation
 *   - Paraphrased or synthesized text that does not occur verbatim fails
 *   - Page/slide coordinate must be present and non-empty
 *
 * Returns the source_validation record.
 */
export function validateClaimSource(params: {
  exact_claim_text: string;
  source_text: string;
  page_or_slide: number | string;
  document_id: string;
  memo_version: string;
}): {
  exact_text_found: boolean;
  coordinate_valid: boolean;
  validation_method: string;
  source_start?: number;
  source_end?: number;
} {
  const { exact_claim_text, source_text, page_or_slide, document_id, memo_version } = params;

  // Validate coordinate
  const coordinateValid = page_or_slide !== null &&
    page_or_slide !== undefined &&
    String(page_or_slide).trim().length > 0;

  // Validate document_id and memo_version presence
  const docValid = document_id.trim().length > 0;
  const versionValid = memo_version.trim().length > 0;

  // Validate exact text presence
  if (!exact_claim_text || exact_claim_text.trim().length === 0) {
    return {
      exact_text_found: false,
      coordinate_valid: coordinateValid && docValid && versionValid,
      validation_method: "verbatim_substring_match",
    };
  }

  // Normalize whitespace for matching (but preserve case)
  const normalizedClaimText = exact_claim_text.replace(/\s+/g, " ").trim();
  const normalizedSourceText = source_text.replace(/\s+/g, " ");

  const startIndex = normalizedSourceText.indexOf(normalizedClaimText);
  const found = startIndex >= 0;

  return {
    exact_text_found: found,
    coordinate_valid: coordinateValid && docValid && versionValid,
    validation_method: "verbatim_substring_match",
    ...(found ? { source_start: startIndex, source_end: startIndex + normalizedClaimText.length } : {}),
  };
}

// ---------------------------------------------------------------------------
// Claim Construction
// ---------------------------------------------------------------------------

/**
 * Build a CanonicalIcClaim from extraction results + source validation.
 */
export function buildCanonicalClaim(params: {
  document_id: string;
  document_name: string;
  memo_version: string;
  page_or_slide: number | string;
  section?: string;
  exact_claim_text: string;
  claim_type: "quantitative" | "qualitative";
  entity: string | null;
  segment: string | null;
  metric: string | null;
  qualitative_proposition: string | null;
  period: string | null;
  scope: string | null;
  unit: string | null;
  currency: string | null;
  scale: string | null;
  actual_forecast_status: CanonicalIcClaim["proposition"]["actual_forecast_status"];
  accounting_basis: string | null;
  stated_value: number | string | null;
  source_validation: {
    exact_text_found: boolean;
    coordinate_valid: boolean;
    validation_method: string;
    source_start?: number;
    source_end?: number;
  };
}): CanonicalIcClaim {
  const claim_id = generateCanonicalClaimId({
    document_id: params.document_id,
    memo_version: params.memo_version,
    exact_claim_text: params.exact_claim_text,
    page_or_slide: params.page_or_slide,
    claim_type: params.claim_type,
    proposition_key: params.metric || params.qualitative_proposition,
    scope: params.scope,
    stated_value: params.stated_value,
    unit_key: [params.unit, params.currency, params.scale].filter(Boolean).join("/"),
  });

  return {
    schema_version: IC_CLAIM_SCHEMA_VERSION,
    claim_id,
    source: {
      document_id: params.document_id,
      document_name: params.document_name,
      memo_version: params.memo_version,
      page_or_slide: params.page_or_slide,
      section: params.section,
      source_start: params.source_validation.source_start,
      source_end: params.source_validation.source_end,
    },
    exact_claim_text: params.exact_claim_text,
    claim_type: params.claim_type,
    target: {
      entity: params.entity,
      segment: params.segment,
    },
    proposition: {
      metric: params.metric,
      qualitative_proposition: params.qualitative_proposition,
      period: params.period,
      scope: params.scope,
      unit: params.unit,
      currency: params.currency,
      scale: params.scale,
      actual_forecast_status: params.actual_forecast_status,
      accounting_basis: params.accounting_basis,
      stated_value: params.stated_value,
    },
    source_validation: {
      exact_text_found: params.source_validation.exact_text_found,
      coordinate_valid: params.source_validation.coordinate_valid,
      validation_method: params.source_validation.validation_method,
    },
    extraction: {
      extractor_version: EXTRACTOR_VERSION,
      extracted_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Claim Ledger — in-memory store
// ---------------------------------------------------------------------------

export interface CanonicalClaimLedger {
  schema_version: "ic-claim-v1";
  claims: CanonicalIcClaim[];
  /** Map for O(1) lookups by claim_id */
  claimMap: Map<string, CanonicalIcClaim>;
}

/**
 * Build a canonical claim ledger from a list of claims.
 * Deduplicates by claim_id (deterministic — same source = same ID).
 */
export function buildClaimLedger(claims: CanonicalIcClaim[]): CanonicalClaimLedger {
  const claimMap = new Map<string, CanonicalIcClaim>();
  const deduplicated: CanonicalIcClaim[] = [];

  for (const claim of claims) {
    if (!claimMap.has(claim.claim_id)) {
      claimMap.set(claim.claim_id, claim);
      deduplicated.push(claim);
    }
    // Duplicate claim_id = same content hash = same claim — skip silently
  }

  return {
    schema_version: IC_CLAIM_SCHEMA_VERSION,
    claims: deduplicated,
    claimMap,
  };
}

// ---------------------------------------------------------------------------
// Candidate Admission Gate — Claim-First Enforcement
// ---------------------------------------------------------------------------

/**
 * Terminal rejection reasons for candidates that lack a valid IC claim.
 */
export type CandidateRejectionReason =
  | "missing_ic_claim"
  | "ambiguous_ic_claim"
  | "invalid_claim_coordinate"
  | "claim_text_not_found"
  | "topic_only_linkage"
  | "claim_reference_not_resolved";

export interface CandidateAdmissionResult {
  admitted: boolean;
  claim_id: string | null;
  resolved_claim: CanonicalIcClaim | null;
  rejection_reason: CandidateRejectionReason | null;
  rejection_detail: string | null;
}

/**
 * Candidate admission gate — enforces claim-first requirement.
 *
 * A substantive candidate MUST:
 *   1. Reference exactly one claim_id
 *   2. Resolve that ID to exactly one canonical IC claim in the ledger
 *   3. The resolved claim must have passed source validation
 *   4. The reference must not be ambiguous (multiple matches)
 *   5. Topic-only linkage (no claim_id, only a topic match) is rejected
 *
 * Returns admission result with reason if rejected.
 */
export function admitCandidate(params: {
  candidate_claim_id: string | null | undefined;
  candidate_claim_ids?: string[] | null;
  candidate_topic?: string | null;
  ledger: CanonicalClaimLedger;
}): CandidateAdmissionResult {
  const { candidate_claim_id, candidate_claim_ids, candidate_topic, ledger } = params;

  // Collect all referenced claim IDs
  const allRefs = new Set<string>();
  if (candidate_claim_id && candidate_claim_id.trim()) {
    allRefs.add(candidate_claim_id.trim());
  }
  if (candidate_claim_ids) {
    for (const id of candidate_claim_ids) {
      if (id && id.trim()) allRefs.add(id.trim());
    }
  }

  // RULE: No claim reference at all → missing_ic_claim
  if (allRefs.size === 0) {
    // Check if this is topic-only linkage
    if (candidate_topic && candidate_topic.trim()) {
      return {
        admitted: false,
        claim_id: null,
        resolved_claim: null,
        rejection_reason: "topic_only_linkage",
        rejection_detail: `Candidate linked by topic '${candidate_topic}' only — no claim_id provided. Topic-only linkage is not sufficient for substantive admission.`,
      };
    }
    return {
      admitted: false,
      claim_id: null,
      resolved_claim: null,
      rejection_reason: "missing_ic_claim",
      rejection_detail: "No claim_id reference provided — candidate cannot be admitted without a persisted valid claim.",
    };
  }

  // RULE: Multiple distinct claim references → ambiguous
  if (allRefs.size > 1) {
    return {
      admitted: false,
      claim_id: null,
      resolved_claim: null,
      rejection_reason: "ambiguous_ic_claim",
      rejection_detail: `Candidate references ${allRefs.size} distinct claim IDs: [${[...allRefs].join(", ")}] — ambiguous reference not admitted.`,
    };
  }

  // Single claim reference — resolve it
  const claimId = [...allRefs][0];
  const resolvedClaim = ledger.claimMap.get(claimId);

  // RULE: Reference not found in ledger
  if (!resolvedClaim) {
    return {
      admitted: false,
      claim_id: claimId,
      resolved_claim: null,
      rejection_reason: "claim_reference_not_resolved",
      rejection_detail: `Claim ID '${claimId}' not found in canonical claim ledger — unresolved reference.`,
    };
  }

  // RULE: Claim failed source validation (text not found)
  if (!resolvedClaim.source_validation.exact_text_found) {
    return {
      admitted: false,
      claim_id: claimId,
      resolved_claim: resolvedClaim,
      rejection_reason: "claim_text_not_found",
      rejection_detail: `Claim '${claimId}' failed exact source validation — text not found verbatim in source document.`,
    };
  }

  // RULE: Claim has invalid coordinate
  if (!resolvedClaim.source_validation.coordinate_valid) {
    return {
      admitted: false,
      claim_id: claimId,
      resolved_claim: resolvedClaim,
      rejection_reason: "invalid_claim_coordinate",
      rejection_detail: `Claim '${claimId}' has invalid source coordinate — page/slide/document_id not valid.`,
    };
  }

  // Admitted — all validations passed
  return {
    admitted: true,
    claim_id: claimId,
    resolved_claim: resolvedClaim,
    rejection_reason: null,
    rejection_detail: null,
  };
}

// ---------------------------------------------------------------------------
// Terminal Candidate Record (for rejected candidates)
// ---------------------------------------------------------------------------

export interface TerminalCandidateRecord {
  candidate_id: string;
  candidate_title: string;
  attempted_claim_id: string | null;
  rejection_reason: CandidateRejectionReason;
  rejection_detail: string;
  timestamp: string;
  reportable: false;
}

/**
 * Build a terminal (non-reportable) record for a rejected candidate.
 */
export function buildTerminalRecord(params: {
  candidate_id: string;
  candidate_title: string;
  admission_result: CandidateAdmissionResult;
}): TerminalCandidateRecord {
  return {
    candidate_id: params.candidate_id,
    candidate_title: params.candidate_title,
    attempted_claim_id: params.admission_result.claim_id,
    rejection_reason: params.admission_result.rejection_reason!,
    rejection_detail: params.admission_result.rejection_detail!,
    timestamp: new Date().toISOString(),
    reportable: false,
  };
}

// ---------------------------------------------------------------------------
// Extraction helpers — for quantitative claims from existing pipeline
// ---------------------------------------------------------------------------

/**
 * Convert an existing pipeline Claim (from claims-extraction.ts) to a CanonicalIcClaim.
 * This preserves backward compatibility with existing numeric extraction.
 */
export function fromLegacyClaim(params: {
  legacyClaim: {
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
  };
  document_id: string;
  document_name: string;
  memo_version: string;
  source_text: string;
}): CanonicalIcClaim {
  const { legacyClaim, document_id, document_name, memo_version, source_text } = params;

  // Validate source
  const validation = validateClaimSource({
    exact_claim_text: legacyClaim.verbatim_snippet,
    source_text,
    page_or_slide: legacyClaim.source_page ?? "1",
    document_id,
    memo_version,
  });

  // Derive entity from scope qualifier
  const entity = deriveEntity(legacyClaim.scope_qualifier, document_name);

  // Derive currency from unit
  const currency = deriveCurrency(legacyClaim.unit);

  // Derive actual/forecast from period
  const actualForecast = deriveActualForecastStatus(legacyClaim.period);

  return buildCanonicalClaim({
    document_id,
    document_name,
    memo_version,
    page_or_slide: legacyClaim.source_page ?? "1",
    exact_claim_text: legacyClaim.verbatim_snippet,
    claim_type: "quantitative",
    entity,
    segment: deriveSegment(legacyClaim.scope_qualifier),
    metric: legacyClaim.metric,
    qualitative_proposition: null,
    period: legacyClaim.period,
    scope: legacyClaim.scope_qualifier,
    unit: legacyClaim.unit,
    currency,
    scale: deriveScale(legacyClaim.unit),
    actual_forecast_status: actualForecast,
    accounting_basis: deriveAccountingBasis(legacyClaim.scope_qualifier),
    stated_value: legacyClaim.value,
    source_validation: validation,
  });
}

// ---------------------------------------------------------------------------
// Qualitative claim construction
// ---------------------------------------------------------------------------

/**
 * Build a qualitative canonical claim from extraction output.
 */
export function buildQualitativeClaim(params: {
  document_id: string;
  document_name: string;
  memo_version: string;
  page_or_slide: number | string;
  section?: string;
  exact_claim_text: string;
  entity: string | null;
  segment: string | null;
  qualitative_proposition: string;
  source_text: string;
}): CanonicalIcClaim {
  const validation = validateClaimSource({
    exact_claim_text: params.exact_claim_text,
    source_text: params.source_text,
    page_or_slide: params.page_or_slide,
    document_id: params.document_id,
    memo_version: params.memo_version,
  });

  return buildCanonicalClaim({
    document_id: params.document_id,
    document_name: params.document_name,
    memo_version: params.memo_version,
    page_or_slide: params.page_or_slide,
    section: params.section,
    exact_claim_text: params.exact_claim_text,
    claim_type: "qualitative",
    entity: params.entity,
    segment: params.segment,
    metric: null,
    qualitative_proposition: params.qualitative_proposition,
    period: null,
    scope: null,
    unit: null,
    currency: null,
    scale: null,
    actual_forecast_status: "not_applicable",
    accounting_basis: null,
    stated_value: null,
    source_validation: validation,
  });
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function deriveEntity(scopeQualifier: string, documentName: string): string | null {
  // Try to extract entity from document name
  const docLower = documentName.toLowerCase();
  // Common deal entity patterns
  if (docLower.includes("scg")) return "SCG";
  if (docLower.includes("gamma")) return "Gamma";

  // From scope qualifier
  const scopeLower = scopeQualifier.toLowerCase();
  if (scopeLower.includes("group")) return "Group";
  if (scopeLower.includes("total")) return "Group";

  // Check for segment reference
  const segMatch = scopeQualifier.match(/segment:\s*([^)]+)/i);
  if (segMatch) return segMatch[1].trim();

  return null;
}

function deriveSegment(scopeQualifier: string): string | null {
  const segMatch = scopeQualifier.match(/segment:\s*([^)]+)/i);
  if (segMatch) return segMatch[1].trim();
  return null;
}

function deriveCurrency(unit: string): string | null {
  if (unit.startsWith("£")) return "GBP";
  if (unit.startsWith("$")) return "USD";
  if (unit.startsWith("€")) return "EUR";
  return null;
}

function deriveScale(unit: string): string | null {
  if (unit.includes("m")) return "millions";
  if (unit.includes("k")) return "thousands";
  if (unit.includes("bn")) return "billions";
  return null;
}

function deriveActualForecastStatus(
  period: string | null,
): CanonicalIcClaim["proposition"]["actual_forecast_status"] {
  if (!period) return "unknown";
  const lower = period.toLowerCase();
  if (lower.includes("forecast") || lower.includes("budget")) return "forecast";
  if (lower.includes("ltm") || lower.includes("trailing")) return "actual";
  if (lower.includes("run-rate") || lower.includes("rr")) return "mixed";

  // Check year-based heuristic
  const yearMatch = lower.match(/(20)?(\d{2})/);
  if (yearMatch) {
    const year = parseInt(yearMatch[2]) + (yearMatch[1] ? 0 : 2000);
    if (year >= 2026) return "forecast";
    if (year <= 2024) return "actual";
    return "mixed"; // 2025 ambiguous
  }
  return "unknown";
}

function deriveAccountingBasis(scopeQualifier: string): string | null {
  const lower = scopeQualifier.toLowerCase();
  if (lower.includes("reported") || lower.includes("non pro forma") || lower.includes("non-pf")) return "reported";
  if (lower.includes("adjusted")) return "adjusted";
  if (lower.includes("organic")) return "organic";
  if (lower.includes("cash")) return "cash";
  if (lower.includes("pro-forma") || lower.includes("pf")) return "pro_forma";
  if (lower.includes("lfl") || lower.includes("like-for-like")) return "like_for_like";
  return null;
}
