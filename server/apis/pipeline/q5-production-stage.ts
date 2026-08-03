/**
 * MAT-F07 Stage 3 (Q5): Production Q5 — Canonical Finding Resolution
 *
 * For every Q4 family, resolves members to existing F04 canonical finding records.
 * Retains real F04 finding IDs, semantic hashes, admitted evidence IDs, and proposition keys.
 *
 * CRITICAL CONSTRAINTS:
 *   - Does NOT fabricate canonical records — resolves existing ones
 *   - When no F04 record resolves → fail closed with deterministic reason
 *   - Retains exact admitted evidence IDs from F04
 *   - Retains original proposition key and comparison records
 *   - Each Q5 finding maps 1:1 to a Q4 family
 *
 * NO: API registration, UI/client imports, pipeline-core.ts import
 */

import type { CanonicalFindingRecord, CanonicalDisposition } from "./canonical-finding-record.js";
import type { Q4Family, Q4StageOutput } from "./q4-production-stage.js";

// ===========================================================================
// Types
// ===========================================================================

export interface Q5StageInput {
  q4Output: Q4StageOutput;
  /** F04 canonical finding records indexed by candidate_id */
  f04RecordsByCandidate: Map<string, CanonicalFindingRecord>;
}

export interface Q5Finding {
  /** Real F04 finding ID when resolved, otherwise generated for unresolved */
  canonical_finding_id: string;
  /** Real F04 semantic hash when resolved, otherwise null */
  semantic_hash: string | null;
  /** Real F04 proposition key when resolved */
  proposition_key: string | null;
  /** Source Q4 family */
  source_q4_family_id: string;
  /** All Q4 member candidate IDs in this family */
  member_ids: string[];
  /** Representative candidate ID */
  representative_id: string;
  /** Whether this finding is reportable */
  reportable: boolean;
  /** Canonical disposition from F04 */
  disposition: CanonicalDisposition;
  /** Admitted evidence IDs from F04 canonical record */
  admitted_evidence_ids: string[];
  /** Full canonical record when resolved, null when not */
  canonical_record: CanonicalFindingRecord | null;
  /** Reason for non-resolution (null if resolved) */
  resolution_failure?: string | null;
}

export interface Q5StageOutput {
  findings: Q5Finding[];
  unresolved_families: number;
}

// ===========================================================================
// Production execution
// ===========================================================================

/**
 * For each Q4 family:
 *   1. Resolve members to existing F04 canonical finding records
 *   2. Select representative using deterministic rule
 *   3. Retain real finding_id, semantic_hash, evidence_ids, proposition_key
 *   4. If no F04 record resolves → fail closed
 */
export function executeQ5Stage(input: Q5StageInput): Q5StageOutput {
  const findings: Q5Finding[] = [];
  let unresolved = 0;

  for (const family of input.q4Output.families) {
    const finding = resolveQ4FamilyToFinding(family, input.f04RecordsByCandidate);
    if (finding.resolution_failure) {
      unresolved++;
    }
    findings.push(finding);
  }

  return { findings, unresolved_families: unresolved };
}

// ===========================================================================
// Internal Helpers
// ===========================================================================

/**
 * Resolve a Q4 family to its canonical finding record from F04.
 *
 * If multiple F04 records exist for family members, select representative
 * using deterministic rule: earliest finding_id alphabetically.
 * Retain all member F04 IDs for duplicate tracking.
 */
function resolveQ4FamilyToFinding(
  family: Q4Family,
  f04RecordsByCandidate: Map<string, CanonicalFindingRecord>,
): Q5Finding {
  // Collect all F04 records for this family's members
  const memberRecords: Array<{ candidateId: string; record: CanonicalFindingRecord }> = [];

  for (const candidateId of family.member_candidate_ids) {
    const record = f04RecordsByCandidate.get(candidateId);
    if (record) {
      memberRecords.push({ candidateId, record });
    }
  }

  // FAIL CLOSED: No F04 record resolves for any member
  if (memberRecords.length === 0) {
    return {
      canonical_finding_id: `unresolved-${family.family_id}`,
      semantic_hash: null,
      proposition_key: null,
      source_q4_family_id: family.family_id,
      member_ids: family.member_candidate_ids,
      representative_id: getRepresentativeId(family),
      reportable: false,
      disposition: {
        verdict: "unverifiable",
        reportable: false,
        reason_codes: ["canonical_finding_not_resolved"],
        rule_version: "f07-q5-v2",
      },
      admitted_evidence_ids: [],
      canonical_record: null,
      resolution_failure: "canonical_finding_not_resolved",
    };
  }

  // Select representative F04 record deterministically:
  // If multiple unique F04 records, pick the one with the earliest finding_id (alphabetical)
  const uniqueRecords = deduplicateF04Records(memberRecords);
  const representative = uniqueRecords.sort((a, b) =>
    a.record.identity.finding_id.localeCompare(b.record.identity.finding_id)
  )[0];

  const record = representative.record;

  // Extract admitted evidence IDs
  const admittedEvidenceIds = record.evidence.map(e => e.evidence_id);

  return {
    canonical_finding_id: record.identity.finding_id,
    semantic_hash: record.identity.semantic_hash,
    proposition_key: record.identity.proposition_key,
    source_q4_family_id: family.family_id,
    member_ids: family.member_candidate_ids,
      representative_id: getRepresentativeId(family),
      reportable: record.disposition.reportable,
    disposition: record.disposition,
    admitted_evidence_ids: admittedEvidenceIds,
    canonical_record: record,
    resolution_failure: null,
  };
}

/**
 * Deduplicate F04 records by finding_id.
 * Multiple candidates may map to the same F04 record (true duplicates).
 */
function deduplicateF04Records(
  memberRecords: Array<{ candidateId: string; record: CanonicalFindingRecord }>,
): Array<{ candidateId: string; record: CanonicalFindingRecord }> {
  const seen = new Map<string, { candidateId: string; record: CanonicalFindingRecord }>();
  for (const entry of memberRecords) {
    const fid = entry.record.identity.finding_id;
    if (!seen.has(fid)) {
      seen.set(fid, entry);
    }
  }
  return [...seen.values()];
}

/**
 * Get the representative candidate ID from a Q4 family.
 * Uses duplicate_decisions to find the representative.
 */
function getRepresentativeId(family: Q4Family): string {
  const rep = family.duplicate_decisions.find(d => d.decision === "representative");
  return rep ? rep.candidate_id : family.member_candidate_ids[0];
}
