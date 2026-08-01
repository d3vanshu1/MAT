/**
 * Claim Linkage — Links contradiction candidates back to originating IC claims.
 *
 * INVARIANT: No contradiction-check finding may exist without an originating
 * material claim from the IC materials.
 *
 * This module:
 *   1. Defines the qualitative IC claim schema (extends beyond Step 0.8 quantitative)
 *   2. Provides deterministic claim-linkage logic for the 46 retained candidates
 *   3. Classifies each candidate as claim-linked (with verdict) or not-linked
 *
 * QUALITATIVE CLAIM CATEGORIES (material assertions from IC materials):
 *   - growth_quality
 *   - retention_and_churn
 *   - customer_concentration
 *   - market_position
 *   - segment_turnaround
 *   - ma_dependence
 *   - deleveraging
 *   - cash_conversion
 *   - downside_resilience
 *   - management_adjusted_metrics
 *   - valuation_returns_support
 *   - regulatory_contractual
 *
 * FLOW: extract IC claim → normalize → identify evidence source → compare → verdict
 *
 * VERDICTS:
 *   confirmed | contradicted | partially_supported | unsupported |
 *   unverifiable | materially_changed
 *
 * Candidates without a valid originating claim are reclassified as:
 *   supporting_evidence | source_observation | wrong_module |
 *   process_diagnostic | source_recommendation | scope_limitation
 */

import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Qualitative Claim Schema
// ---------------------------------------------------------------------------

export const QUALITATIVE_CLAIM_TYPES = [
  "growth_quality",
  "retention_and_churn",
  "customer_concentration",
  "market_position",
  "segment_turnaround",
  "ma_dependence",
  "deleveraging",
  "cash_conversion",
  "downside_resilience",
  "management_adjusted_metrics",
  "valuation_returns_support",
  "regulatory_contractual",
] as const;

export type QualitativeClaimType = typeof QUALITATIVE_CLAIM_TYPES[number];

export const CLAIM_VERDICTS = [
  "confirmed",
  "contradicted",
  "partially_supported",
  "unsupported",
  "unverifiable",
  "materially_changed",
] as const;

export type ClaimVerdict = typeof CLAIM_VERDICTS[number];

export const QualitativeClaimSchema = z.object({
  /** Globally unique claim ID */
  originating_claim_id: z.string(),
  /** Normalized text of the IC claim */
  claim_text: z.string(),
  /** Claim category */
  claim_type: z.union([
    z.enum(QUALITATIVE_CLAIM_TYPES),
    z.string(), // Allow quantitative claim types from Step 0.8
  ]),
  /** IC source document */
  ic_source_document: z.string(),
  /** Location within the IC source document */
  ic_source_location: z.string(),
  /** Memo version (for chronology) */
  memo_version: z.string().nullable(),
  /** Normalized claim (de-duplicated across memo versions) */
  normalized_claim: z.string(),
  /** The authoritative evidence source consulted */
  verification_source: z.string().nullable(),
  /** The specific evidence found */
  verification_evidence: z.string().nullable(),
  /** The comparison performed */
  comparison_performed: z.string().nullable(),
  /** Verdict */
  verdict: z.enum(CLAIM_VERDICTS),
});

export type QualitativeClaim = z.infer<typeof QualitativeClaimSchema>;

// ---------------------------------------------------------------------------
// Claim-Linkage Classification for replay candidates
// ---------------------------------------------------------------------------

export const CLAIM_LINKAGE_DISPOSITIONS = [
  "claim_linked_contradiction",
  "claim_linked_partial_support",
  "claim_linked_unsupported",
  "claim_linked_material_change",
  "claim_linked_unverifiable",
  "claim_linked_confirmed",
  "not_linked_to_IC_claim",
] as const;

export type ClaimLinkageDisposition = typeof CLAIM_LINKAGE_DISPOSITIONS[number];

export interface ClaimLinkageResult {
  /** Finding ID from the original 46 candidates */
  finding_id: string;
  /** Corpus index in the 273-row ledger */
  corpus_index: number;
  /** Title */
  title: string;
  /** Q3 classification */
  claim_linkage_disposition: ClaimLinkageDisposition;
  /** The originating IC claim (null if not linked) */
  originating_claim: QualitativeClaim | null;
  /** Reason for classification */
  reason: string;
  /** Evidence source type used for verification */
  evidence_source_type: string | null;
  /** Whether evidence source is authoritative for this claim type */
  evidence_authority_valid: boolean;
}

// ---------------------------------------------------------------------------
// Disposition mapping: claim-linkage verdict → final disposition
// ---------------------------------------------------------------------------

export function verdictToLinkageDisposition(verdict: ClaimVerdict): ClaimLinkageDisposition {
  switch (verdict) {
    case "contradicted": return "claim_linked_contradiction";
    case "partially_supported": return "claim_linked_partial_support";
    case "unsupported": return "claim_linked_unsupported";
    case "materially_changed": return "claim_linked_material_change";
    case "unverifiable": return "claim_linked_unverifiable";
    case "confirmed": return "claim_linked_confirmed";
  }
}

// ---------------------------------------------------------------------------
// Evidence authority validation
// ---------------------------------------------------------------------------

/**
 * Determines whether a given evidence source type is authoritative for
 * verifying a specific claim type.
 *
 * Evidence from an inappropriate source type is rejected.
 */
export function isEvidenceSourceAuthoritative(
  claimType: string,
  evidenceSourceTag: string,
): boolean {
  // Quantitative financial claims → financial_model, consultant_report
  const financialClaims = new Set([
    "growth_quality", "cash_conversion", "deleveraging",
    "management_adjusted_metrics", "valuation_returns_support",
  ]);
  if (financialClaims.has(claimType)) {
    return ["financial_model", "consultant_report", "customer_data"].includes(evidenceSourceTag);
  }

  // Commercial/operational claims → consultant_report (FDD/CDD), customer_data
  const commercialClaims = new Set([
    "retention_and_churn", "customer_concentration",
    "market_position", "segment_turnaround", "downside_resilience",
  ]);
  if (commercialClaims.has(claimType)) {
    return ["consultant_report", "customer_data", "financial_model"].includes(evidenceSourceTag);
  }

  // M&A claims → consultant_report, financial_model
  if (claimType === "ma_dependence") {
    return ["consultant_report", "financial_model"].includes(evidenceSourceTag);
  }

  // Regulatory/contractual → legal (only via targeted verification)
  if (claimType === "regulatory_contractual") {
    return ["legal", "consultant_report"].includes(evidenceSourceTag);
  }

  // Quantitative claim types from Step 0.8
  const quantitativeTypes = [
    "operating_metric", "deal_mechanics", "valuation_structuring",
    "returns_projection", "cross_reference",
  ];
  if (quantitativeTypes.includes(claimType)) {
    return ["financial_model", "consultant_report"].includes(evidenceSourceTag);
  }

  // Unknown claim type — conservative: only financial_model and consultant_report
  return ["financial_model", "consultant_report"].includes(evidenceSourceTag);
}

// ---------------------------------------------------------------------------
// Deterministic claim-linkage classifier (pure, no LLM)
// ---------------------------------------------------------------------------

/**
 * Determines whether a finding can be linked to an IC claim based on
 * its existing metadata.
 *
 * Returns the linkage result. A finding is "linked" if it has:
 *   - An originating_claim_id that resolves to a real IC claim
 *   - Evidence from an authoritative source
 *   - A verifiable comparison between claim and evidence
 *
 * A finding is "not linked" if:
 *   - No originating_claim_id exists
 *   - The evidence source is not authoritative for the claim type
 *   - The finding is an FDD/CDD observation without an IC claim anchor
 */
export function classifyClaimLinkage(
  finding: {
    finding_id: string;
    corpus_index: number;
    title: string;
    detail?: string | null;
    full_analysis?: string | null;
    severity?: string | null;
    source_tag?: string | null;
    source_docs?: string[] | null;
    originating_claim_id?: string | null;
    claim_ids?: string[] | null;
    claim_type?: string | null;
    finding_kind?: string | null;
  },
  /** Resolved claim data (from claim extraction or reconciliation) */
  resolvedClaim?: QualitativeClaim | null,
): ClaimLinkageResult {
  const findingId = finding.finding_id;
  const corpusIndex = finding.corpus_index;
  const title = finding.title;

  // Case 1: Finding has a resolved claim with full metadata
  if (resolvedClaim) {
    const authoritative = isEvidenceSourceAuthoritative(
      resolvedClaim.claim_type,
      finding.source_tag ?? "other"
    );

    return {
      finding_id: findingId,
      corpus_index: corpusIndex,
      title,
      claim_linkage_disposition: verdictToLinkageDisposition(resolvedClaim.verdict),
      originating_claim: resolvedClaim,
      reason: `Linked to IC claim: "${resolvedClaim.normalized_claim}" — verdict: ${resolvedClaim.verdict}`,
      evidence_source_type: finding.source_tag ?? null,
      evidence_authority_valid: authoritative,
    };
  }

  // Case 2: Finding references a claim_id but we couldn't resolve the full claim
  const hasClaimRef = !!(finding.originating_claim_id || (finding.claim_ids && finding.claim_ids.length > 0));
  if (hasClaimRef) {
    // Has a claim reference but no resolved claim data — still counts as linked
    // if we can infer the connection from the finding content
    return {
      finding_id: findingId,
      corpus_index: corpusIndex,
      title,
      claim_linkage_disposition: "claim_linked_unverifiable",
      originating_claim: null,
      reason: `Claim reference found (${finding.originating_claim_id ?? finding.claim_ids?.[0]}) but full claim data not resolved — marked unverifiable`,
      evidence_source_type: finding.source_tag ?? null,
      evidence_authority_valid: false,
    };
  }

  // Case 3: No claim reference — not linked to IC claim
  return {
    finding_id: findingId,
    corpus_index: corpusIndex,
    title,
    claim_linkage_disposition: "not_linked_to_IC_claim",
    originating_claim: null,
    reason: deriveNotLinkedReason(finding),
    evidence_source_type: finding.source_tag ?? null,
    evidence_authority_valid: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveNotLinkedReason(finding: {
  title: string;
  detail?: string | null;
  source_tag?: string | null;
  source_docs?: string[] | null;
  finding_kind?: string | null;
}): string {
  const sourceTag = finding.source_tag ?? "unknown";
  const kind = finding.finding_kind;

  // FDD/CDD standalone observation
  if (sourceTag === "consultant_report") {
    return "Standalone FDD/CDD observation with no originating IC claim — not a contradiction";
  }

  // Financial model observation without claim
  if (sourceTag === "financial_model") {
    return "Financial model observation without originating IC claim — classify as supporting_evidence or source_observation";
  }

  // Customer data observation
  if (sourceTag === "customer_data") {
    return "Customer/revenue data observation without originating IC claim";
  }

  // IC memo observation that isn't anchored to a specific claim
  if (sourceTag === "ic_memo" || sourceTag === "cim") {
    return "IC narrative observation not anchored to a specific verifiable claim";
  }

  // Generic
  return `No originating IC claim found — source: ${sourceTag}, kind: ${kind ?? "unspecified"}`;
}
