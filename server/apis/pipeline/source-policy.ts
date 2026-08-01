/**
 * Source Policy — Contradiction-Check Module Scope Enforcement
 *
 * This module enforces the designed scope of the contradiction_check analysis:
 *
 *   "Which material claims made by the investment team are contradicted,
 *    weakened, unsupported, or materially changed by the underlying
 *    financial and commercial evidence?"
 *
 * It is NOT a general diligence-risk extractor.
 *
 * DESIGN:
 * - Narrative sources: IC memos, screening memos, IC updates, investment-team materials
 * - Evidence sources: financial model, vendor FDD, commercial DD, customer/revenue data,
 *   structured operating data
 * - Excluded from unrestricted scanning: Legal DD, tax, insurance, HR, property,
 *   specialist reports
 * - Excluded sources may only be accessed via targeted claim-verification when an IC
 *   claim specifically requires that source type
 *
 * ARCHITECTURE:
 * This policy is consulted at two points:
 *   1. Routing: Determines whether a chunk enters the extraction/analysis pipeline
 *   2. Finding classification: Determines whether an already-generated finding is
 *      within scope (for replay/remediation of the existing corpus)
 */

// ---------------------------------------------------------------------------
// Source categories
// ---------------------------------------------------------------------------

/** Document tags that contribute IC narrative claims */
export const NARRATIVE_SOURCES = new Set([
  "ic_memo",
  "cim",        // Screening memo / CIM
] as const);

/** Document tags providing authoritative verification evidence */
export const EVIDENCE_SOURCES = new Set([
  "financial_model",
  "consultant_report",  // Vendor FDD, Commercial DD, QoE
  "customer_data",      // Customer and revenue datasets
  "other",              // Structured operating datasets, misc financial
] as const);

/**
 * Document tags EXCLUDED from unrestricted contradiction-check scanning.
 * These may only enter via targeted claim-verification.
 */
export const EXCLUDED_SOURCES = new Set([
  "legal",              // Legal Due Diligence
  // Future expansion: "tax", "insurance", "hr", "property"
] as const);

/**
 * The complete set of tags allowed into contradiction_check routing
 * (narrative + evidence, excluding specialist reports).
 */
export const CONTRADICTION_CHECK_ALLOWED_TAGS = new Set([
  ...NARRATIVE_SOURCES,
  ...EVIDENCE_SOURCES,
]);

// ---------------------------------------------------------------------------
// Targeted claim-verification policy
// ---------------------------------------------------------------------------

/**
 * Claim categories that may trigger targeted verification against excluded sources.
 * Only claims of these types can invoke Legal DD or other excluded documents.
 */
export const TARGETED_VERIFICATION_CLAIM_TYPES = [
  "regulatory_exposure",
  "change_of_control_risk",
  "ip_ownership",
  "contractual_impediment",
  "material_litigation",
  "compliance_status",
] as const;

export type TargetedVerificationClaimType = typeof TARGETED_VERIFICATION_CLAIM_TYPES[number];

/**
 * Determines whether a specific IC claim qualifies for targeted verification
 * against an excluded source (e.g., Legal DD).
 *
 * Returns true only when:
 * 1. The claim asserts a specific legal, regulatory, contractual, or IP position
 * 2. The excluded source is the authoritative evidence needed to verify that claim
 *
 * This is the ONLY path through which Legal DD may contribute to contradiction-check.
 */
export function isTargetedVerificationEligible(claim: {
  claim_text: string;
  claim_type?: string;
  source_tag?: string;
}): boolean {
  // The claim must originate from a narrative source
  if (claim.source_tag && !NARRATIVE_SOURCES.has(claim.source_tag as any)) {
    return false;
  }

  // Check if claim type is in the allowed targeted-verification set
  if (claim.claim_type && TARGETED_VERIFICATION_CLAIM_TYPES.includes(claim.claim_type as TargetedVerificationClaimType)) {
    return true;
  }

  // Heuristic fallback: check claim text for legal/regulatory keyword patterns
  const lowerText = claim.claim_text.toLowerCase();
  const LEGAL_CLAIM_PATTERNS = [
    /no\s+material\s+regulatory\s+(exposure|risk)/,
    /no\s+material\s+change.of.control/,
    /owns?\s+(all\s+)?material\s+ip/,
    /no\s+material\s+contractual\s+(impediment|restriction)/,
    /no\s+material\s+litigation/,
    /no\s+pending\s+(legal|regulatory)\s+(action|proceeding)/,
    /compliance\s+(confirmed|verified|in\s+place)/,
    /ip\s+(protection|ownership)\s+(confirmed|in\s+place|secured)/,
  ];

  return LEGAL_CLAIM_PATTERNS.some(p => p.test(lowerText));
}

// ---------------------------------------------------------------------------
// Routing enforcement
// ---------------------------------------------------------------------------

/**
 * Determines whether a document chunk should be routed to contradiction_check.
 *
 * @param documentTag - The tag assigned to the source document
 * @returns true if the chunk should enter the contradiction-check pipeline
 */
export function isChunkAllowedForContradictionCheck(documentTag: string): boolean {
  return CONTRADICTION_CHECK_ALLOWED_TAGS.has(documentTag as any);
}

/**
 * Determines whether a finding derived from a specific source type is within
 * the contradiction-check module's scope.
 *
 * For findings from excluded sources (e.g., Legal DD), this returns false
 * UNLESS the finding is explicitly tied to a targeted claim verification.
 *
 * @param sourceTag - Document tag the finding originates from
 * @param hasOriginatingClaim - Whether this finding traces to a specific IC claim
 * @param claimType - The type of IC claim (if any) that originated this finding
 */
export function isFindingInScope(
  sourceTag: string,
  hasOriginatingClaim: boolean = false,
  claimType?: string,
): boolean {
  // Findings from allowed sources are always in scope
  if (CONTRADICTION_CHECK_ALLOWED_TAGS.has(sourceTag as any)) {
    return true;
  }

  // Findings from excluded sources require targeted claim verification
  if (EXCLUDED_SOURCES.has(sourceTag as any)) {
    if (!hasOriginatingClaim) return false;
    if (!claimType) return false;
    return TARGETED_VERIFICATION_CLAIM_TYPES.includes(claimType as TargetedVerificationClaimType);
  }

  // Unknown tags: exclude by default (fail closed)
  return false;
}

// ---------------------------------------------------------------------------
// Targeted verification result schema
// ---------------------------------------------------------------------------

export interface TargetedVerificationRequest {
  /** The IC claim being verified */
  claim_id: string;
  /** Normalized text of the claim */
  claim_text: string;
  /** Claim type (must be in TARGETED_VERIFICATION_CLAIM_TYPES) */
  claim_type: TargetedVerificationClaimType;
  /** Source document of the claim */
  claim_source_doc: string;
  /** Location within the source document */
  claim_source_location: string;
  /** The excluded source to query (e.g., "legal") */
  target_source_tag: string;
}

export interface TargetedVerificationResult {
  /** The originating request */
  request: TargetedVerificationRequest;
  /** Verdict */
  verdict: "confirmed" | "contradicted" | "partially_supported" | "unverifiable";
  /** Evidence found in the excluded source */
  evidence_text: string;
  /** Location of the evidence */
  evidence_location: string;
  /** Whether this result may become a contradiction-check finding */
  is_valid_finding: boolean;
}

// ---------------------------------------------------------------------------
// Module-level summary (for auditing)
// ---------------------------------------------------------------------------

export interface SourcePolicySummary {
  /** Total chunks considered */
  total_chunks: number;
  /** Chunks routed (allowed by policy) */
  routed_chunks: number;
  /** Chunks excluded by source policy */
  excluded_chunks: number;
  /** Breakdown by tag */
  excluded_by_tag: Record<string, number>;
  /** Targeted verifications performed */
  targeted_verifications: number;
  /** Findings retained through targeted verification */
  targeted_findings_retained: number;
}

/**
 * Creates an empty policy summary for accumulation during pipeline execution.
 */
export function createPolicySummary(): SourcePolicySummary {
  return {
    total_chunks: 0,
    routed_chunks: 0,
    excluded_chunks: 0,
    excluded_by_tag: {},
    targeted_verifications: 0,
    targeted_findings_retained: 0,
  };
}
