/**
 * MAT-F07 Stage 2: Q4 Production Stage
 *
 * Groups Q3-eligible candidates into canonical families using the REAL
 * production handler (groupIntoCanonicalFamilies) with the full 11-field
 * canonical proposition key.
 *
 * NO hardcoded:
 *   - Reduced 4-field grouping key
 *   - Forced family assignment
 *   - Default verification_status
 *
 * CONSTRAINTS:
 *   - No API registration (no `api()` call)
 *   - No UI/client imports
 *   - No pipeline-core.ts import
 *   - No module-initialization side effects
 *   - Only Q3-eligible candidates enter
 *   - Returns plain typed outputs
 */

import {
  groupIntoCanonicalFamilies,
  type CanonicalFamily,
  type CanonicalIdentityResult,
  type AmbiguousCandidate,
  type DegradedRecord,
  type CanonicalKey,
} from "./canonical-issue-identity.js";
import type { Q2CandidateInput, Q3ResultRow } from "./q3-production-stage.js";

// ===========================================================================
// Types
// ===========================================================================

export interface Q4Family {
  family_id: string;
  member_q3_ids: string[];
  member_candidate_ids: string[];
  canonical_proposition_key: string;
  canonical_key: CanonicalKey;
  grouping_rule_version: string;
  duplicate_decisions: Array<{ candidate_id: string; decision: "representative" | "non_representative" }>;
  member_count: number;
  memo_versions: string[];
  all_originating_claim_ids: string[];
}

export interface Q4StageInput {
  q3Results: Q3ResultRow[];
  candidates: Q2CandidateInput[];
}

export interface Q4StageOutput {
  families: Q4Family[];
  singletons: string[];
  ambiguous: AmbiguousCandidate[];
  degraded: DegradedRecord[];
  memberToFamily: Map<string, string>;
}

// ===========================================================================
// Production execution
// ===========================================================================

/**
 * Execute Q4 stage using the REAL production handler (groupIntoCanonicalFamilies).
 * Uses full 11-field canonical proposition key. No reduced grouping.
 * Only Q3-eligible candidates may enter.
 */
export function executeQ4Stage(input: Q4StageInput): Q4StageOutput {
  // CRITICAL: Only Q3-eligible candidates enter Q4
  const eligibleQ3 = input.q3Results.filter(r => r.q4_eligible);

  // Build the finding objects for groupIntoCanonicalFamilies
  const findingsForGrouping = eligibleQ3.map((q3r, idx) => {
    const candidate = input.candidates.find(c => c.candidate_id === q3r.candidate_id);
    return {
      finding_id: q3r.candidate_id,
      corpus_index: idx,
      title: candidate?.title ?? "",
      detail: candidate?.detail ?? null,
      full_analysis: null as string | null,
      severity: candidate?.severity ?? null,
      source_tag: candidate?.source_tag ?? null,
      finding_kind: candidate?.finding_kind ?? null,
      issue_key: null as string | null,
      originating_claim_id: candidate?.canonical_claim_id ?? null,
      claim_ids: candidate?.canonical_claim_id ? [candidate.canonical_claim_id] : null,
      source_docs: candidate?.source_docs ?? null,
      claim_type: null as string | null,
    };
  });

  // Call the REAL production Q4 grouper
  const groupResult = groupIntoCanonicalFamilies(findingsForGrouping);

  // Map internal families to Q4Family schema
  const families: Q4Family[] = groupResult.families.map(fam => {
    const familyId = `q4fam-${fam.canonical_key_str.replace(/[^a-z0-9]/g, "").slice(0, 20)}-${fam.member_finding_ids.length}m`;

    // Determine representative vs non-representative (first member = representative)
    const duplicateDecisions = fam.member_finding_ids.map((mid, idx) => ({
      candidate_id: mid,
      decision: (idx === 0 ? "representative" : "non_representative") as "representative" | "non_representative",
    }));

    return {
      family_id: familyId,
      member_q3_ids: fam.member_finding_ids,
      member_candidate_ids: fam.member_finding_ids,
      canonical_proposition_key: fam.canonical_key_str,
      canonical_key: fam.canonical_key,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: duplicateDecisions,
      member_count: fam.member_finding_ids.length,
      memo_versions: fam.memo_versions,
      all_originating_claim_ids: fam.all_originating_claim_ids,
    };
  });

  // Add singletons as single-member families
  for (const singleton of groupResult.singletons) {
    const familyId = `q4fam-singleton-${singleton.finding_id.slice(0, 16)}`;
    families.push({
      family_id: familyId,
      member_q3_ids: [singleton.finding_id],
      member_candidate_ids: [singleton.finding_id],
      canonical_proposition_key: singleton.canonical_key_str,
      canonical_key: singleton.canonical_key,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [{ candidate_id: singleton.finding_id, decision: "representative" }],
      member_count: 1,
      memo_versions: singleton.memo_versions,
      all_originating_claim_ids: singleton.originating_claim_ids,
    });
  }

  // Build memberToFamily map from families
  const memberToFamily = new Map<string, string>();
  for (const fam of families) {
    for (const mid of fam.member_candidate_ids) {
      memberToFamily.set(mid, fam.family_id);
    }
  }

  return {
    families,
    singletons: groupResult.singletons.map(s => s.finding_id),
    ambiguous: groupResult.ambiguous,
    degraded: groupResult.degraded,
    memberToFamily,
  };
}
