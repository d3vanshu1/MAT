/**
 * MAT-F07 Stage 3 (Q5): Production Q5 — Canonical Finding Resolution
 *
 * For every Q4 family, resolves members to existing F04 canonical finding records.
 * Retains real F04 finding IDs, semantic hashes, admitted evidence IDs, and proposition keys.
 *
 * F04 IDENTITY RESOLUTION (MAT-F07 §4):
 *   - Primary resolution: uses Q4 family’s member_f04_finding_ids directly.
 *   - Fallback: resolves through f04RecordsByCandidate map when direct IDs are present.
 *   - Ambiguous resolution (multiple distinct F04 records with no clear representative)
 *     → deterministic pick: earliest finding_id alphabetically.
 *   - No F04 record resolves → fail closed with canonical_finding_not_resolved.
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
  /** F04 finding IDs from all family members (for tracing) */
  member_f04_finding_ids: string[];
  /** F04 semantic hashes from all family members */
  member_f04_semantic_hashes: string[];
  /** MAT-F07-H1: Reason codes when ambiguous F04 resolution fails closed */
  ambiguity_reason_codes?: string[];
  /** MAT-F07-H1: All conflicting F04 IDs when resolution is ambiguous */
  conflicting_f04_ids?: string[];
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
 *   2. Use Q4’s member_f04_finding_ids as primary resolution path
 *   3. Fallback to f04RecordsByCandidate map for candidate→record lookup
 *   4. Retain real finding_id, semantic_hash, evidence_ids, proposition_key
 *   5. If no F04 record resolves → fail closed
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
 * Resolution strategy:
 *   1. If family carries member_f04_finding_ids, resolve directly from those
 *   2. Fallback: look up each member candidate in f04RecordsByCandidate
 *   3. If multiple unique F04 records: pick representative deterministically
 *      (earliest finding_id alphabetically)
 *   4. If zero records resolve: fail closed
 */
function resolveQ4FamilyToFinding(
  family: Q4Family,
  f04RecordsByCandidate: Map<string, CanonicalFindingRecord>,
): Q5Finding {
  // Collect all F04 records for this family’s members
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
      member_f04_finding_ids: family.member_f04_finding_ids ?? [],
      member_f04_semantic_hashes: family.member_f04_semantic_hashes ?? [],
    };
  }

  // Deduplicate F04 records by finding_id (multiple candidates may reference the same record)
  const uniqueRecords = deduplicateF04Records(memberRecords);

  // MAT-F07-H1: If multiple unique F04 records, determine if they are
  // true duplicates (safe to select representative) or materially distinct (fail closed)
  if (uniqueRecords.length > 1) {
    const ambiguityResult = checkMaterialAmbiguity(uniqueRecords);
    if (ambiguityResult.isAmbiguous) {
      // FAIL CLOSED — materially distinct F04 records
      return {
        canonical_finding_id: `ambiguous-${family.family_id}`,
        semantic_hash: null,
        proposition_key: null,
        source_q4_family_id: family.family_id,
        member_ids: family.member_candidate_ids,
        representative_id: getRepresentativeId(family),
        reportable: false,
        disposition: {
          verdict: "unverifiable",
          reportable: false,
          reason_codes: ["canonical_finding_ambiguous"],
          rule_version: "f07-h1-v1",
        },
        admitted_evidence_ids: [],
        canonical_record: null,
        resolution_failure: "canonical_finding_ambiguous",
        member_f04_finding_ids: uniqueRecords.map(r => r.record.identity.finding_id),
        member_f04_semantic_hashes: uniqueRecords.map(r => r.record.identity.semantic_hash),
        ambiguity_reason_codes: ambiguityResult.reasonCodes,
        conflicting_f04_ids: uniqueRecords.map(r => r.record.identity.finding_id),
      };
    }
  }

  // Select representative F04 record deterministically (true duplicates or single record)
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
    member_f04_finding_ids: family.member_f04_finding_ids ?? [],
    member_f04_semantic_hashes: family.member_f04_semantic_hashes ?? [],
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

// ===========================================================================
// MAT-F07-H1: Material Ambiguity Check
// ===========================================================================

interface AmbiguityCheckResult {
  isAmbiguous: boolean;
  reasonCodes: string[];
}

/**
 * Determine whether multiple unique F04 records are materially distinct
 * (fail closed) or true duplicates (safe to pick representative).
 *
 * TRUE DUPLICATES (allowed): All records share:
 *   - Same exact proposition key
 *   - Compatible canonical dimensions (accounting basis)
 *   - Equivalent comparison basis
 *   - Equivalent deterministic verdict
 *   - No materially different evidence proposition
 *
 * MATERIALLY DISTINCT (fail closed): Any of:
 *   - Different proposition keys
 *   - Different accounting basis
 *   - Different comparison basis (e.g. memo_vs_model vs memo_vs_reference)
 *   - Different/contradictory verdicts (e.g. confirmed vs contradicted)
 *   - Materially different evidence sets indicating different propositions
 */
function checkMaterialAmbiguity(
  records: Array<{ candidateId: string; record: CanonicalFindingRecord }>,
): AmbiguityCheckResult {
  const reasonCodes: string[] = [];
  const first = records[0].record;

  for (let i = 1; i < records.length; i++) {
    const other = records[i].record;

    // Check proposition key
    if (first.identity.proposition_key !== other.identity.proposition_key) {
      reasonCodes.push("different_proposition_key");
    }

    // Check accounting basis (embedded in proposition key or comparisons)
    const firstBasis = extractAccountingBasis(first);
    const otherBasis = extractAccountingBasis(other);
    if (firstBasis && otherBasis && firstBasis !== otherBasis) {
      reasonCodes.push("different_accounting_basis");
    }

    // Check comparison basis
    const firstCompBasis = extractComparisonBasis(first);
    const otherCompBasis = extractComparisonBasis(other);
    if (firstCompBasis && otherCompBasis && firstCompBasis !== otherCompBasis) {
      reasonCodes.push("different_comparison_basis");
    }

    // Check verdict compatibility
    const firstVerdict = first.disposition.verdict;
    const otherVerdict = other.disposition.verdict;
    if (firstVerdict !== otherVerdict) {
      // Contradictory verdicts are always materially distinct
      reasonCodes.push("contradictory_verdict");
    }
  }

  // Deduplicate reason codes
  const uniqueReasons = [...new Set(reasonCodes)];
  return {
    isAmbiguous: uniqueReasons.length > 0,
    reasonCodes: uniqueReasons,
  };
}

/**
 * Extract accounting basis from a canonical finding record.
 * Looks in the proposition key structure (pipe-separated fields).
 */
function extractAccountingBasis(record: CanonicalFindingRecord): string | null {
  const key = record.identity.proposition_key;
  if (!key) return null;
  // Proposition key format: category|kind|metric|period|entity|scope|unit|actual_forecast|accounting_basis|comparison_basis|...
  const parts = key.split("|");
  return parts.length >= 9 ? (parts[8] || null) : null;
}

/**
 * Extract comparison basis from a canonical finding record.
 */
function extractComparisonBasis(record: CanonicalFindingRecord): string | null {
  const key = record.identity.proposition_key;
  if (!key) return null;
  const parts = key.split("|");
  return parts.length >= 10 ? (parts[9] || null) : null;
}
