/**
 * MAT-F07 Stage 2: Q4 Production Stage
 *
 * Groups Q3-eligible candidates into canonical families using the REAL
 * production handler (groupIntoCanonicalFamilies) with the full 11-field
 * canonical proposition key.
 *
 * F04 IDENTITY INTEGRATION (MAT-F07 §3):
 *   - When f04_proposition_key is present on a candidate, Q4 groups by that
 *     exact key — title/detail regex is NOT used for identity derivation.
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
 * Execute Q4 stage using the REAL production handler (groupIntoCanonicalFamilies).
 * Uses full 11-field canonical proposition key. No reduced grouping.
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

  // Build the finding objects for groupIntoCanonicalFamilies
  // Pass structured_proposition from Q2 so Q4 groups by F04 proposition key, not title/detail
  const findingsForGrouping = q4Eligible.map((q3r, idx) => {
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
      // F04 structured proposition key — takes priority over title/detail regex
      structured_proposition: candidate ? {
        metric: candidate.metric,
        period: candidate.period,
        entity_or_segment: candidate.entity_segment,
        scope: candidate.scope_qualifier,
        unit: candidate.unit,
        actual_or_forecast: candidate.actual_or_forecast,
        accounting_basis: candidate.accounting_basis,
        comparison_basis: candidate.comparison_basis,
      } : null,
    };
  });

  // Call the REAL production Q4 grouper
  const groupResult = groupIntoCanonicalFamilies(findingsForGrouping);

  // Build Q3→F04 lookup for enriching families
  const q3F04Lookup = new Map<string, Q3ResultRow>();
  for (const q3r of q4Eligible) {
    q3F04Lookup.set(q3r.candidate_id, q3r);
  }

  // Map internal families to Q4Family schema
  const families: Q4Family[] = groupResult.families.map(fam => {
    const familyId = `q4fam-${fam.canonical_key_str.replace(/[^a-z0-9]/g, "").slice(0, 20)}-${fam.member_finding_ids.length}m`;

    // Determine representative vs non-representative (first member = representative)
    const duplicateDecisions = fam.member_finding_ids.map((mid, idx) => ({
      candidate_id: mid,
      decision: (idx === 0 ? "representative" : "non_representative") as "representative" | "non_representative",
    }));

    // Collect F04 identity from Q3 results
    const memberF04FindingIds: string[] = [];
    const memberF04SemanticHashes: string[] = [];
    const memberF04EvidenceIds: string[] = [];
    let familyF04Key: string | null = null;

    for (const mid of fam.member_finding_ids) {
      const q3r = q3F04Lookup.get(mid);
      if (q3r?.f04_finding_id) {
        memberF04FindingIds.push(q3r.f04_finding_id);
      }
      if (q3r?.f04_semantic_hash) {
        memberF04SemanticHashes.push(q3r.f04_semantic_hash);
      }
      if (q3r?.f04_admitted_evidence_ids) {
        memberF04EvidenceIds.push(...q3r.f04_admitted_evidence_ids);
      }
      if (q3r?.f04_proposition_key && !familyF04Key) {
        familyF04Key = q3r.f04_proposition_key;
      }
    }

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
      // F04 identity
      member_f04_finding_ids: memberF04FindingIds,
      member_f04_semantic_hashes: memberF04SemanticHashes,
      f04_proposition_key: familyF04Key,
      member_f04_evidence_ids: memberF04EvidenceIds,
    };
  });

  // Add singletons as single-member families
  for (const singleton of groupResult.singletons) {
    const familyId = `q4fam-singleton-${singleton.finding_id.slice(0, 16)}`;

    // Collect F04 identity for singleton
    const q3r = q3F04Lookup.get(singleton.finding_id);
    const memberF04FindingIds: string[] = q3r?.f04_finding_id ? [q3r.f04_finding_id] : [];
    const memberF04SemanticHashes: string[] = q3r?.f04_semantic_hash ? [q3r.f04_semantic_hash] : [];
    const memberF04EvidenceIds: string[] = q3r?.f04_admitted_evidence_ids ?? [];
    const familyF04Key: string | null = q3r?.f04_proposition_key ?? null;

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
      // F04 identity
      member_f04_finding_ids: memberF04FindingIds,
      member_f04_semantic_hashes: memberF04SemanticHashes,
      f04_proposition_key: familyF04Key,
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

  return {
    families,
    singletons: groupResult.singletons.map(s => s.finding_id),
    ambiguous: groupResult.ambiguous,
    degraded: groupResult.degraded,
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
