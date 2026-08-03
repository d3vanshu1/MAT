/**
 * MAT-F07 Stage 1: Q3 Production Stage
 *
 * Determines eligibility and disposition for each Q2 candidate using
 * the real classifyClaimLinkage production handler.
 *
 * NO hardcoded:
 *   - claim_linked_contradicted
 *   - authority_valid: true
 *   - q4_eligible: true
 *   - verification_status: "verified"
 *
 * CONSTRAINTS:
 *   - No API registration (no `api()` call)
 *   - No UI/client imports
 *   - No pipeline-core.ts import
 *   - No module-initialization side effects
 *   - Accepts plain typed inputs + repository adapter
 *   - Returns plain typed row-level outputs
 *   - Callable by normal, proof, and replay routes
 */

import {
  classifyClaimLinkage,
  type ClaimLinkageResult,
} from "./claim-linkage.js";
import type { CanonicalClaimLedger } from "./canonical-ic-claim.js";

// ===========================================================================
// Types
// ===========================================================================

export interface Q2CandidateInput {
  candidate_id: string;
  canonical_claim_id: string | null;
  admitted_evidence_ids: string[];
  originating_run_id: string;
  originating_module_id: string;
  candidate_type: string;
  creation_rule_version: string;
  title: string;
  detail: string | null;
  finding_kind: string | null;
  severity: string | null;
  source_tag: string | null;
  source_docs: string[];
  metric: string | null;
  period: string | null;
  scope_qualifier: string | null;
  entity_segment: string | null;
  unit: string | null;
  actual_or_forecast: string | null;
  accounting_basis: string | null;
  comparison_basis: string | null;
  verification_evidence: unknown;
  comparison_inputs: unknown;
  /** Q2-level disposition for terminal mapping of candidates that never enter Q3 */
  q2_disposition?: string | null;
  /** Q2-level reason for non-reportability */
  q2_reason?: string | null;
  /** Whether Q2 deemed this candidate reportable */
  q2_reportable?: boolean;
}

export interface Q3ResultRow {
  candidate_id: string;
  canonical_comparison_ids: string[];
  disposition: string;
  q4_eligible: boolean;
  eligibility_reason: string;
  rejection_reason_codes: string[];
  canonical_finding_id: string | null;
  evidence_admission_refs: string[];
  authority_class: string;
  authority_valid: boolean;
  authority_rationale: string;
  claim_provenance: unknown;
  verdict: string | null;
}

export interface Q3StageInput {
  candidates: Q2CandidateInput[];
  claimMap: Map<string, unknown>;
  ambiguousRefs?: ReadonlySet<string>;
  canonicalLedger?: CanonicalClaimLedger | null;
}

export interface Q3StageOutput {
  results: Q3ResultRow[];
  eligible_count: number;
  ineligible_count: number;
}

// ===========================================================================
// Production execution
// ===========================================================================

/**
 * Execute Q3 stage using the REAL production handler (classifyClaimLinkage).
 *
 * For each Q2 candidate, builds the finding object that classifyClaimLinkage
 * expects and maps the result to a row-level Q3 output.
 *
 * No hardcoded dispositions. No hardcoded authority_valid. No hardcoded q4_eligible.
 */
export function executeQ3Stage(input: Q3StageInput): Q3StageOutput {
  const results: Q3ResultRow[] = [];

  for (const candidate of input.candidates) {
    // Build the finding object that classifyClaimLinkage expects
    const findingForQ3 = {
      finding_id: candidate.candidate_id,
      corpus_index: 0,
      title: candidate.title,
      detail: candidate.detail,
      full_analysis: null as string | null,
      severity: candidate.severity,
      source_tag: candidate.source_tag,
      source_docs: candidate.source_docs,
      originating_claim_id: candidate.canonical_claim_id,
      claim_ids: candidate.canonical_claim_id ? [candidate.canonical_claim_id] : null,
      claim_type: null as string | null,
      finding_kind: candidate.finding_kind,
      evidence: candidate.detail,
      doc_filename: candidate.source_docs?.[0] ?? null,
      doc_type: null as string | null,
    };

    // Call the REAL production Q3 classifier
    const q3Result: ClaimLinkageResult = classifyClaimLinkage(
      findingForQ3,
      input.claimMap,
      input.ambiguousRefs,
      input.canonicalLedger ?? null,
    );

    // Map to Q3ResultRow — no fabrication
    const rejectionReasonCodes: string[] = [];
    if (!q3Result.q4_eligible) {
      rejectionReasonCodes.push(q3Result.claim_linkage_disposition);
    }

    results.push({
      candidate_id: candidate.candidate_id,
      canonical_comparison_ids: [],
      disposition: q3Result.claim_linkage_disposition,
      q4_eligible: q3Result.q4_eligible,
      eligibility_reason: q3Result.reason,
      rejection_reason_codes: rejectionReasonCodes,
      canonical_finding_id: null, // Assigned in Q5
      evidence_admission_refs: candidate.admitted_evidence_ids,
      authority_class: q3Result.authority_class,
      authority_valid: q3Result.authority_valid,
      authority_rationale: q3Result.authority_rationale,
      claim_provenance: q3Result.claim_provenance,
      verdict: q3Result.claim_provenance?.verdict ?? null,
    });
  }

  const eligible_count = results.filter(r => r.q4_eligible).length;
  const ineligible_count = results.filter(r => !r.q4_eligible).length;

  return { results, eligible_count, ineligible_count };
}
