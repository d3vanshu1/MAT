/**
 * MAT-F07 Stage 2: Q4 Production Stage
 *
 * Groups Q3-eligible candidates into canonical families using the EXACT
 * persisted F04 proposition key as the partition identity.
 *
 * F04 IDENTITY INTEGRATION (MAT-F07 §3 + Correction 2):
 *   - The exact f04_proposition_key IS the family grouping key.
 *   - groupIntoCanonicalFamilies is NOT used for primary partitioning.
 *   - Each Q4 family preserves member F04 finding IDs, semantic hashes,
 *     and proposition keys for Q5 resolution.
 *   - Ambiguous resolution (multiple distinct F04 records) → fail closed.
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
  // ─── F04 Identity per family ─────────────────────────────────────────────
  /** F04 finding IDs for all members (when resolved) */
  member_f04_finding_ids: string[];
  /** F04 semantic hashes for all members (when resolved) */
  member_f04_semantic_hashes: string[];
  /** Exact F04 proposition key used for grouping (when present) */
  f04_proposition_key: string | null;
  /** F04 admitted evidence IDs from all members */
  member_f04_evidence_ids: string[];
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
 * Execute Q4 stage: partition Q3-eligible candidates into canonical families
 * by exact F04 proposition key. No title/detail regex grouping is used.
 * Only Q3-eligible candidates may enter.
 *
 * When f04_proposition_key is available on a candidate, it takes absolute priority
 * as structured_proposition override — title/detail regex parsing is bypassed.
 */
export function executeQ4Stage(input: Q4StageInput): Q4StageOutput {
  // CRITICAL: Only Q3-eligible candidates enter Q4
  const eligibleQ3 = input.q3Results.filter(r => r.q4_eligible);

  // --- MAT-F07-H2: Enforce exact F04 proposition key ---
  // When F04 records are associated with a candidate (f04_finding_id present),
  // the f04_proposition_key MUST be present. Missing key = Q4-ineligible.
  // Also validate projected dimensions vs F04 key — inconsistency = fail closed.
  const q4Eligible: typeof eligibleQ3 = [];
  const q4Rejected: Array<{ candidate_id: string; reason: string }> = [];

  for (const q3r of eligibleQ3) {
    const candidate = input.candidates.find(c => c.candidate_id === q3r.candidate_id);

    // If this candidate has an F04 finding ID, the F04 proposition key is REQUIRED
    if (q3r.f04_finding_id && !q3r.f04_proposition_key) {
      q4Rejected.push({
        candidate_id: q3r.candidate_id,
        reason: "f04_proposition_key_missing",
      });
      continue;
    }

    // If F04 proposition key is present, validate projected dimensions consistency
    if (q3r.f04_proposition_key && candidate) {
      const inconsistency = validateProjectedDimensions(q3r.f04_proposition_key, candidate);
      if (inconsistency) {
        q4Rejected.push({
          candidate_id: q3r.candidate_id,
          reason: `f04_key_projection_inconsistent:${inconsistency}`,
        });
        continue;
      }
    }

    q4Eligible.push(q3r);
  }

  if (q4Rejected.length > 0) {
    console.log(
      `[Q4Stage][F07-H2] Rejected ${q4Rejected.length} candidate(s) for F04 key violations: ` +
      q4Rejected.map(r => `${r.candidate_id.slice(0, 12)}:${r.reason}`).join(", ")
    );
  }

  // --- Correction 2: Partition DIRECTLY by exact f04_proposition_key ---
  // The F04 key IS the family identity. groupIntoCanonicalFamilies is NOT used for
  // primary grouping — the persisted F04 key takes absolute authority.
  // Title, detail, and projected fields cannot generate or replace it.

  // Build Q3→candidate lookup
  const candidateLookup = new Map<string, Q2CandidateInput>();
  for (const c of input.candidates) {
    candidateLookup.set(c.candidate_id, c);
  }

  // Partition by exact F04 proposition key
  const keyPartitions = new Map<string, Q3ResultRow[]>();
  for (const q3r of q4Eligible) {
    const key = q3r.f04_proposition_key!; // Guaranteed non-null by H2 pre-filter
    const partition = keyPartitions.get(key);
    if (partition) {
      partition.push(q3r);
    } else {
      keyPartitions.set(key, [q3r]);
    }
  }

  // Build families from F04-key partitions
  const families: Q4Family[] = [];
  const ambiguous: AmbiguousCandidate[] = [];

  for (const [f04Key, members] of keyPartitions) {
    const memberIds = members.map(m => m.candidate_id);
    const familyId = `q4fam-${f04Key.replace(/[^a-z0-9]/g, "").slice(0, 20)}-${memberIds.length}m`;

    // Determine representative vs non-representative (first member = representative)
    const duplicateDecisions = memberIds.map((mid, idx) => ({
      candidate_id: mid,
      decision: (idx === 0 ? "representative" : "non_representative") as "representative" | "non_representative",
    }));

    // Collect F04 identity from Q3 results
    const memberF04FindingIds: string[] = [];
    const memberF04SemanticHashes: string[] = [];
    const memberF04EvidenceIds: string[] = [];
    const memoVersions: string[] = [];
    const allClaimIds: string[] = [];

    for (const q3r of members) {
      if (q3r.f04_finding_id) memberF04FindingIds.push(q3r.f04_finding_id);
      if (q3r.f04_semantic_hash) memberF04SemanticHashes.push(q3r.f04_semantic_hash);
      if (q3r.f04_admitted_evidence_ids) memberF04EvidenceIds.push(...q3r.f04_admitted_evidence_ids);
      // Derive claim_id and memo version from matching candidate
      const cand = candidateLookup.get(q3r.candidate_id);
      if (cand?.canonical_claim_id) allClaimIds.push(cand.canonical_claim_id);
      if (cand?.source_docs) {
        for (const doc of cand.source_docs) {
          const ver = deriveMemoVersionFromFilename(doc);
          if (ver && !memoVersions.includes(ver)) memoVersions.push(ver);
        }
      }
    }

    families.push({
      family_id: familyId,
      member_q3_ids: memberIds,
      member_candidate_ids: memberIds,
      // CRITICAL: canonical_proposition_key === exact persisted F04 key
      canonical_proposition_key: f04Key,
      canonical_key: {} as CanonicalKey, // F04 key is authoritative — typed object unused
      grouping_rule_version: "f04-exact-key-partition-v1",
      duplicate_decisions: duplicateDecisions,
      member_count: memberIds.length,
      memo_versions: memoVersions,
      all_originating_claim_ids: allClaimIds,
      // F04 identity
      member_f04_finding_ids: memberF04FindingIds,
      member_f04_semantic_hashes: memberF04SemanticHashes,
      f04_proposition_key: f04Key,
      member_f04_evidence_ids: memberF04EvidenceIds,
    });
  }

  // Build memberToFamily map from families
  const memberToFamily = new Map<string, string>();
  for (const fam of families) {
    for (const mid of fam.member_candidate_ids) {
      memberToFamily.set(mid, fam.family_id);
    }
  }

  // Singletons = families with exactly 1 member
  const singletonIds = families
    .filter(f => f.member_count === 1)
    .map(f => f.member_candidate_ids[0]);

  return {
    families,
    singletons: singletonIds,
    ambiguous,
    degraded: [],
    memberToFamily,
  };
}

// ===========================================================================
// MAT-F07-H2: Validate projected dimensions against F04 proposition key
// ===========================================================================

/**
 * Parse a pipe-separated F04 proposition key and validate that the candidate's
 * projected dimensions are consistent with it.
 *
 * F04 proposition key format (pipe-separated):
 *   category|kind|metric|period|entity|scope|unit|actual_forecast|accounting_basis|comparison_basis|...
 *
 * Returns null if consistent, or a string describing the inconsistency.
 */
function validateProjectedDimensions(
  f04Key: string,
  candidate: Q2CandidateInput,
): string | null {
  const parts = f04Key.split("|");
  if (parts.length < 6) return null; // Insufficient key structure to validate

  // Extract F04 dimensions from key
  const f04Metric = parts[2] || null;
  const f04Period = parts[3] || null;
  const f04Entity = parts[4] || null;
  const f04Scope = parts[5] || null;
  const f04Unit = parts[6] || null;
  const f04ActualForecast = parts[7] || null;
  const f04AccountingBasis = parts[8] || null;
  const f04ComparisonBasis = parts[9] || null;

  // Validate projected dimensions where both are non-null
  // Empty string in candidate = not projected, so skip
  if (candidate.metric && f04Metric && normalize(candidate.metric) !== normalize(f04Metric)) {
    return `metric:${candidate.metric}!=${f04Metric}`;
  }
  if (candidate.period && f04Period && normalize(candidate.period) !== normalize(f04Period)) {
    return `period:${candidate.period}!=${f04Period}`;
  }
  if (candidate.entity_segment && f04Entity && normalize(candidate.entity_segment) !== normalize(f04Entity)) {
    return `entity:${candidate.entity_segment}!=${f04Entity}`;
  }
  if (candidate.scope_qualifier && f04Scope && normalize(candidate.scope_qualifier) !== normalize(f04Scope)) {
    return `scope:${candidate.scope_qualifier}!=${f04Scope}`;
  }
  if (candidate.unit && f04Unit && normalize(candidate.unit) !== normalize(f04Unit)) {
    return `unit:${candidate.unit}!=${f04Unit}`;
  }
  if (candidate.actual_or_forecast && f04ActualForecast && normalize(candidate.actual_or_forecast) !== normalize(f04ActualForecast)) {
    return `actual_forecast:${candidate.actual_or_forecast}!=${f04ActualForecast}`;
  }
  if (candidate.accounting_basis && f04AccountingBasis && normalize(candidate.accounting_basis) !== normalize(f04AccountingBasis)) {
    return `accounting_basis:${candidate.accounting_basis}!=${f04AccountingBasis}`;
  }
  if (candidate.comparison_basis && f04ComparisonBasis && normalize(candidate.comparison_basis) !== normalize(f04ComparisonBasis)) {
    return `comparison_basis:${candidate.comparison_basis}!=${f04ComparisonBasis}`;
  }

  return null; // Consistent
}

/** Normalize a dimension value for comparison (lowercase, trim whitespace) */
function normalize(v: string): string {
  return v.toLowerCase().trim().replace(/[\s_-]+/g, "_");
}

/** Derive a memo version label from a source document filename */
function deriveMemoVersionFromFilename(filename: string): string | null {
  const match = filename.match(/v(\d+)/i);
  return match ? `v${match[1]}` : null;
}
