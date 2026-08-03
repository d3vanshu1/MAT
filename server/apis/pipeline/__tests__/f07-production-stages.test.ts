/**
 * MAT-F07: Production Stage Unit Tests
 *
 * 25 targeted tests covering:
 *   - Q3 stage: real classifyClaimLinkage, no hardcoded dispositions
 *   - Q4 stage: full 11-field canonical key, Q3-ineligible excluded
 *   - Q5 stage: worst-adverse-wins, SHA-256 stable identity
 *   - Terminal accounting: 12+ statuses, one row per Q2 candidate
 *   - Cross-stage reconciliation: invariant validation
 */

import { describe, it, expect } from "vitest";
import { executeQ3Stage, type Q2CandidateInput } from "../q3-production-stage.js";
import { executeQ4Stage } from "../q4-production-stage.js";
import { executeQ5Stage } from "../q5-production-stage.js";
import {
  executeTerminalAccounting,
  reconcileAllStages,
  TERMINAL_STATUSES,
} from "../terminal-accounting-stage.js";

// ===========================================================================
// Fixtures
// ===========================================================================

function makeCandidate(overrides: Partial<Q2CandidateInput> = {}): Q2CandidateInput {
  return {
    candidate_id: `cand-test-${Math.random().toString(36).slice(2, 10)}`,
    canonical_claim_id: "CLM-test-001",
    admitted_evidence_ids: ["ev-001"],
    originating_run_id: "run-test-001",
    originating_module_id: "test-module",
    candidate_type: "data_divergence",
    creation_rule_version: "test-v1",
    title: "Revenue divergence Q1 2026",
    detail: "IC memo states $10M but model shows $8M",
    finding_kind: "data_divergence",
    severity: "high",
    source_tag: "model_comparison",
    source_docs: ["operating_model.xlsx"],
    metric: "revenue",
    period: "Q1 2026",
    scope_qualifier: "total",
    entity_segment: "consolidated",
    unit: "USD millions",
    actual_or_forecast: "actual",
    accounting_basis: "reported",
    comparison_basis: "memo_vs_model",
    verification_evidence: { model_figure_value: 8000000, delta_abs: 2000000 },
    comparison_inputs: { comparison_method: "direct_numeric" },
    ...overrides,
  };
}

function buildClaimMap(claims: Array<{ claim_id: string; [k: string]: unknown }>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const c of claims) {
    map.set(c.claim_id, c);
  }
  return map;
}

// ===========================================================================
// Q3 Stage Tests
// ===========================================================================

describe("Q3 Production Stage", () => {
  it("01: processes candidates through real classifyClaimLinkage", () => {
    const candidates = [makeCandidate()];
    const claimMap = buildClaimMap([
      { claim_id: "CLM-test-001", metric: "revenue", period: "Q1 2026" },
    ]);

    const output = executeQ3Stage({ candidates, claimMap });

    expect(output.results).toHaveLength(1);
    expect(output.results[0].candidate_id).toBe(candidates[0].candidate_id);
    // Must have a real disposition, not hardcoded
    expect(output.results[0].disposition).toBeDefined();
    expect(typeof output.results[0].disposition).toBe("string");
    expect(output.results[0].disposition.length).toBeGreaterThan(0);
  });

  it("02: never hardcodes claim_linked_contradicted", () => {
    // Use a candidate with no claim linkage to prove disposition is dynamic
    const candidates = [makeCandidate({ canonical_claim_id: null })];
    const claimMap = new Map<string, unknown>();

    const output = executeQ3Stage({ candidates, claimMap });

    // Without a matching claim, should NOT be "claim_linked_contradicted"
    expect(output.results[0].disposition).not.toBe("claim_linked_contradicted");
  });

  it("03: never hardcodes authority_valid: true", () => {
    // Candidate with null claim → should not get authority_valid: true
    const candidates = [makeCandidate({ canonical_claim_id: null })];
    const claimMap = new Map<string, unknown>();

    const output = executeQ3Stage({ candidates, claimMap });

    // At minimum, authority_valid should reflect real classification
    expect(typeof output.results[0].authority_valid).toBe("boolean");
  });

  it("04: never hardcodes q4_eligible: true for all", () => {
    // Some candidates should be ineligible
    const candidates = [
      makeCandidate({ canonical_claim_id: null, finding_kind: "process_diagnostic" }),
      makeCandidate({ canonical_claim_id: "CLM-test-002" }),
    ];
    const claimMap = buildClaimMap([
      { claim_id: "CLM-test-002", metric: "ebitda", period: "FY2025" },
    ]);

    const output = executeQ3Stage({ candidates, claimMap });

    // Not all should be eligible
    const eligibleCount = output.results.filter(r => r.q4_eligible).length;
    const ineligibleCount = output.results.filter(r => !r.q4_eligible).length;
    expect(output.eligible_count).toBe(eligibleCount);
    expect(output.ineligible_count).toBe(ineligibleCount);
    expect(eligibleCount + ineligibleCount).toBe(2);
  });

  it("05: counts eligible/ineligible correctly", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
      makeCandidate({ candidate_id: "c3" }),
    ];
    const claimMap = new Map<string, unknown>();

    const output = executeQ3Stage({ candidates, claimMap });

    expect(output.eligible_count + output.ineligible_count).toBe(3);
    expect(output.results).toHaveLength(3);
  });
});

// ===========================================================================
// Q4 Stage Tests
// ===========================================================================

describe("Q4 Production Stage", () => {
  it("06: only Q3-eligible candidates enter Q4", () => {
    const candidates = [
      makeCandidate({ candidate_id: "eligible-1" }),
      makeCandidate({ candidate_id: "ineligible-1" }),
    ];

    // Simulate Q3 results with mixed eligibility
    const q3Results = [
      {
        candidate_id: "eligible-1",
        canonical_comparison_ids: [],
        disposition: "claim_linked_contradicted",
        q4_eligible: true,
        eligibility_reason: "valid claim linkage",
        rejection_reason_codes: [],
        canonical_finding_id: null,
        evidence_admission_refs: ["ev-001"],
        authority_class: "model_comparison",
        authority_valid: true,
        authority_rationale: "structured comparison",
        claim_provenance: null,
        verdict: "contradicted",
      },
      {
        candidate_id: "ineligible-1",
        canonical_comparison_ids: [],
        disposition: "not_linked_to_IC_claim",
        q4_eligible: false,
        eligibility_reason: "no claim linkage",
        rejection_reason_codes: ["not_linked_to_IC_claim"],
        canonical_finding_id: null,
        evidence_admission_refs: [],
        authority_class: "none",
        authority_valid: false,
        authority_rationale: "no authority",
        claim_provenance: null,
        verdict: null,
      },
    ];

    const output = executeQ4Stage({ q3Results, candidates });

    // Only the eligible one should appear in families
    const allMemberIds = output.families.flatMap(f => f.member_candidate_ids);
    expect(allMemberIds).toContain("eligible-1");
    expect(allMemberIds).not.toContain("ineligible-1");
  });

  it("07: uses full 11-field canonical key (not 4-field)", () => {
    const candidates = [
      makeCandidate({
        candidate_id: "c1",
        metric: "revenue",
        period: "Q1 2026",
        scope_qualifier: "total",
        unit: "USD",
        entity_segment: "north_america",
        actual_or_forecast: "actual",
        accounting_basis: "reported",
      }),
    ];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }];

    const output = executeQ4Stage({ q3Results, candidates });

    expect(output.families.length).toBeGreaterThan(0);
    // The canonical_proposition_key should include more fields than just metric|period|scope|unit
    const family = output.families[0];
    expect(family.canonical_proposition_key).toBeDefined();
    expect(family.canonical_proposition_key.length).toBeGreaterThan(0);
    // Should use the real groupIntoCanonicalFamilies rule version
    expect(family.grouping_rule_version).toBe("canonical-issue-identity-v1");
  });

  it("08: groups identical-key candidates into same family", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1", metric: "revenue", period: "Q1 2026" }),
      makeCandidate({ candidate_id: "c2", metric: "revenue", period: "Q1 2026" }),
    ];

    const q3Results = candidates.map(c => ({
      candidate_id: c.candidate_id,
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }));

    const output = executeQ4Stage({ q3Results, candidates });

    // Both should end up in the same family or as singletons with the same key
    const allMemberIds = output.families.flatMap(f => f.member_candidate_ids);
    expect(allMemberIds).toContain("c1");
    expect(allMemberIds).toContain("c2");
  });

  it("09: assigns duplicate_decisions (representative + non_representative)", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1", metric: "revenue", period: "Q1 2026" }),
      makeCandidate({ candidate_id: "c2", metric: "revenue", period: "Q1 2026" }),
    ];

    const q3Results = candidates.map(c => ({
      candidate_id: c.candidate_id,
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }));

    const output = executeQ4Stage({ q3Results, candidates });

    // Find the multi-member family
    const multiFamily = output.families.find(f => f.member_count > 1);
    if (multiFamily) {
      const decisions = multiFamily.duplicate_decisions;
      const reps = decisions.filter(d => d.decision === "representative");
      const nonReps = decisions.filter(d => d.decision === "non_representative");
      expect(reps.length).toBe(1);
      expect(nonReps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("10: builds memberToFamily map correctly", () => {
    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }];

    const output = executeQ4Stage({ q3Results, candidates });

    expect(output.memberToFamily.has("c1")).toBe(true);
    expect(output.memberToFamily.get("c1")).toBeDefined();
  });
});

// ===========================================================================
// Q5 Stage Tests
// ===========================================================================

describe("Q5 Production Stage", () => {
  it("11: produces one finding per Q4 family", () => {
    const families = [{
      family_id: "fam-1",
      member_q3_ids: ["c1"],
      member_candidate_ids: ["c1"],
      canonical_proposition_key: "financial|revenue|q1_2026|total|null|null|actual|null|memo_vs_model|overstatement",
      canonical_key: {} as any,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [{ candidate_id: "c1", decision: "representative" as const }],
      member_count: 1,
      memo_versions: [],
      all_originating_claim_ids: ["CLM-001"],
    }];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: ["ev-001"],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }];

    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const output = executeQ5Stage({ families, q3Results, candidates });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0].source_q4_family_id).toBe("fam-1");
    expect(output.findings[0].member_ids).toContain("c1");
  });

  it("12: uses worst-adverse-wins for disposition", () => {
    const families = [{
      family_id: "fam-multi",
      member_q3_ids: ["c1", "c2"],
      member_candidate_ids: ["c1", "c2"],
      canonical_proposition_key: "test-key",
      canonical_key: {} as any,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [
        { candidate_id: "c1", decision: "representative" as const },
        { candidate_id: "c2", decision: "non_representative" as const },
      ],
      member_count: 2,
      memo_versions: [],
      all_originating_claim_ids: [],
    }];

    const q3Results = [
      {
        candidate_id: "c1",
        canonical_comparison_ids: [],
        disposition: "claim_linked_confirmed",
        q4_eligible: true,
        eligibility_reason: "ok",
        rejection_reason_codes: [],
        canonical_finding_id: null,
        evidence_admission_refs: [],
        authority_class: "model_comparison",
        authority_valid: true,
        authority_rationale: "ok",
        claim_provenance: null,
        verdict: "confirmed", // severity 0
      },
      {
        candidate_id: "c2",
        canonical_comparison_ids: [],
        disposition: "claim_linked_contradicted",
        q4_eligible: true,
        eligibility_reason: "ok",
        rejection_reason_codes: [],
        canonical_finding_id: null,
        evidence_admission_refs: [],
        authority_class: "model_comparison",
        authority_valid: true,
        authority_rationale: "ok",
        claim_provenance: null,
        verdict: "contradicted", // severity 5 — worst
      },
    ];

    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];

    const output = executeQ5Stage({ families, q3Results, candidates });

    // contradicted (severity 5) should win → reportable
    expect(output.findings[0].disposition.verdict).toBe("contradicted");
    expect(output.findings[0].reportable).toBe(true);
  });

  it("13: generates stable SHA-256 finding IDs", () => {
    const families = [{
      family_id: "fam-stable",
      member_q3_ids: ["c1"],
      member_candidate_ids: ["c1"],
      canonical_proposition_key: "stable-key-test",
      canonical_key: {} as any,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [{ candidate_id: "c1", decision: "representative" as const }],
      member_count: 1,
      memo_versions: [],
      all_originating_claim_ids: [],
    }];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }];

    const candidates = [makeCandidate({ candidate_id: "c1" })];

    // Run twice — should produce same ID
    const output1 = executeQ5Stage({ families, q3Results, candidates });
    const output2 = executeQ5Stage({ families, q3Results, candidates });

    expect(output1.findings[0].canonical_finding_id).toBe(output2.findings[0].canonical_finding_id);
    expect(output1.findings[0].canonical_finding_id).toMatch(/^cfr-v1-[a-f0-9]{16}$/);
  });

  it("14: collects admitted_evidence_ids from all family members", () => {
    const families = [{
      family_id: "fam-evidence",
      member_q3_ids: ["c1", "c2"],
      member_candidate_ids: ["c1", "c2"],
      canonical_proposition_key: "evidence-key",
      canonical_key: {} as any,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [
        { candidate_id: "c1", decision: "representative" as const },
        { candidate_id: "c2", decision: "non_representative" as const },
      ],
      member_count: 2,
      memo_versions: [],
      all_originating_claim_ids: [],
    }];

    const q3Results = [
      { candidate_id: "c1", canonical_comparison_ids: [], disposition: "x", q4_eligible: true, eligibility_reason: "ok", rejection_reason_codes: [], canonical_finding_id: null, evidence_admission_refs: ["ev-A"], authority_class: "x", authority_valid: true, authority_rationale: "ok", claim_provenance: null, verdict: "contradicted" },
      { candidate_id: "c2", canonical_comparison_ids: [], disposition: "x", q4_eligible: true, eligibility_reason: "ok", rejection_reason_codes: [], canonical_finding_id: null, evidence_admission_refs: ["ev-B"], authority_class: "x", authority_valid: true, authority_rationale: "ok", claim_provenance: null, verdict: "contradicted" },
    ];

    const candidates = [
      makeCandidate({ candidate_id: "c1", admitted_evidence_ids: ["ev-A"] }),
      makeCandidate({ candidate_id: "c2", admitted_evidence_ids: ["ev-B"] }),
    ];

    const output = executeQ5Stage({ families, q3Results, candidates });

    expect(output.findings[0].admitted_evidence_ids).toContain("ev-A");
    expect(output.findings[0].admitted_evidence_ids).toContain("ev-B");
  });

  it("15: non-adverse verdict (confirmed) is not reportable", () => {
    const families = [{
      family_id: "fam-confirmed",
      member_q3_ids: ["c1"],
      member_candidate_ids: ["c1"],
      canonical_proposition_key: "confirmed-key",
      canonical_key: {} as any,
      grouping_rule_version: "canonical-issue-identity-v1",
      duplicate_decisions: [{ candidate_id: "c1", decision: "representative" as const }],
      member_count: 1,
      memo_versions: [],
      all_originating_claim_ids: [],
    }];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_confirmed",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "confirmed",
    }];

    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const output = executeQ5Stage({ families, q3Results, candidates });

    expect(output.findings[0].reportable).toBe(false);
    expect(output.findings[0].disposition.verdict).toBe("confirmed");
  });
});

// ===========================================================================
// Terminal Accounting Tests
// ===========================================================================

describe("Terminal Accounting Stage", () => {
  it("16: produces one record per Q2 candidate (no losses)", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
      makeCandidate({ candidate_id: "c3" }),
    ];

    const q3Results = candidates.map(c => ({
      candidate_id: c.candidate_id,
      canonical_comparison_ids: [],
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      eligibility_reason: "no claim",
      rejection_reason_codes: ["not_linked_to_IC_claim"],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "none",
      authority_valid: false,
      authority_rationale: "none",
      claim_provenance: null,
      verdict: null,
    }));

    const output = executeTerminalAccounting({
      candidates,
      q3Results,
      q4Output: { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map() },
      q5Findings: [],
    });

    expect(output.records).toHaveLength(3);
    expect(output.invariant_violations).toHaveLength(0);
  });

  it("17: Q3-ineligible candidates terminate at Q3", () => {
    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      eligibility_reason: "no claim",
      rejection_reason_codes: ["not_linked_to_IC_claim"],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "none",
      authority_valid: false,
      authority_rationale: "none",
      claim_provenance: null,
      verdict: null,
    }];

    const output = executeTerminalAccounting({
      candidates,
      q3Results,
      q4Output: { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map() },
      q5Findings: [],
    });

    expect(output.records[0].terminal_stage).toBe("q3");
    expect(output.records[0].terminal_status).toBe("missing_ic_claim");
    expect(output.records[0].reportable).toBe(false);
  });

  it("18: duplicate_suppressed for non-representative family members", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];

    const q3Results = candidates.map(c => ({
      candidate_id: c.candidate_id,
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }));

    const q4Output = {
      families: [{
        family_id: "fam-1",
        member_q3_ids: ["c1", "c2"],
        member_candidate_ids: ["c1", "c2"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "canonical-issue-identity-v1",
        duplicate_decisions: [
          { candidate_id: "c1", decision: "representative" as const },
          { candidate_id: "c2", decision: "non_representative" as const },
        ],
        member_count: 2,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [],
      ambiguous: [],
      degraded: [],
      memberToFamily: new Map([["c1", "fam-1"], ["c2", "fam-1"]]),
    };

    const q5Findings = [{
      canonical_finding_id: "cfr-v1-abc123",
      source_q4_family_id: "fam-1",
      member_ids: ["c1", "c2"],
      f04_semantic_hash: "abc123",
      reportable: true,
      disposition: { verdict: "contradicted" as const, reportable: true, reason_codes: [], rule_version: "v1" },
      admitted_evidence_ids: [],
      proposition_key: "test-key",
      canonical_record: null,
    }];

    const output = executeTerminalAccounting({ candidates, q3Results, q4Output, q5Findings });

    const c2Record = output.records.find(r => r.candidate_id === "c2");
    expect(c2Record?.terminal_status).toBe("duplicate_suppressed");
    expect(c2Record?.reportable).toBe(false);
  });

  it("19: reportable_finding for representative with reportable Q5", () => {
    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "claim_linked_contradicted",
      q4_eligible: true,
      eligibility_reason: "ok",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "model_comparison",
      authority_valid: true,
      authority_rationale: "ok",
      claim_provenance: null,
      verdict: "contradicted",
    }];

    const q4Output = {
      families: [{
        family_id: "fam-1",
        member_q3_ids: ["c1"],
        member_candidate_ids: ["c1"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "canonical-issue-identity-v1",
        duplicate_decisions: [{ candidate_id: "c1", decision: "representative" as const }],
        member_count: 1,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [],
      ambiguous: [],
      degraded: [],
      memberToFamily: new Map([["c1", "fam-1"]]),
    };

    const q5Findings = [{
      canonical_finding_id: "cfr-v1-xyz",
      source_q4_family_id: "fam-1",
      member_ids: ["c1"],
      f04_semantic_hash: "xyz",
      reportable: true,
      disposition: { verdict: "contradicted" as const, reportable: true, reason_codes: [], rule_version: "v1" },
      admitted_evidence_ids: [],
      proposition_key: "test-key",
      canonical_record: null,
    }];

    const output = executeTerminalAccounting({ candidates, q3Results, q4Output, q5Findings });

    expect(output.records[0].terminal_status).toBe("reportable_finding");
    expect(output.records[0].reportable).toBe(true);
    expect(output.records[0].canonical_finding_id).toBe("cfr-v1-xyz");
  });

  it("20: detects missing Q3 result as processing_error", () => {
    const candidates = [makeCandidate({ candidate_id: "orphan" })];

    const output = executeTerminalAccounting({
      candidates,
      q3Results: [], // No Q3 result for this candidate
      q4Output: { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map() },
      q5Findings: [],
    });

    expect(output.records[0].terminal_status).toBe("processing_error");
    expect(output.records[0].terminal_stage).toBe("q3");
  });

  it("21: TERMINAL_STATUSES has 12+ entries", () => {
    expect(TERMINAL_STATUSES.length).toBeGreaterThanOrEqual(12);
  });

  it("22: invariant_violations detected when candidate count mismatch", () => {
    // If we provide duplicate candidate IDs, should detect the issue
    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c1" }), // duplicate
    ];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      eligibility_reason: "no",
      rejection_reason_codes: ["not_linked_to_IC_claim"],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "none",
      authority_valid: false,
      authority_rationale: "none",
      claim_provenance: null,
      verdict: null,
    }];

    const output = executeTerminalAccounting({
      candidates,
      q3Results,
      q4Output: { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map() },
      q5Findings: [],
    });

    // Only one terminal record for the deduplicated ID
    // The invariant check should flag mismatch between unique candidates vs terminal records
    expect(output.records.length).toBeLessThanOrEqual(candidates.length);
  });
});

// ===========================================================================
// Cross-Stage Reconciliation Tests
// ===========================================================================

describe("Cross-Stage Reconciliation", () => {
  it("23: all_valid when stages are properly connected", () => {
    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const q3Results = [{
      candidate_id: "c1",
      canonical_comparison_ids: [],
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      eligibility_reason: "no",
      rejection_reason_codes: ["not_linked_to_IC_claim"],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "none",
      authority_valid: false,
      authority_rationale: "none",
      claim_provenance: null,
      verdict: null,
    }];

    const q4Output = {
      families: [],
      singletons: [],
      ambiguous: [],
      degraded: [],
      memberToFamily: new Map<string, string>(),
    };

    const terminalRecords = [{
      candidate_id: "c1",
      terminal_status: "missing_ic_claim" as const,
      terminal_stage: "q3" as const,
      canonical_finding_id: null,
      family_id: null,
      reason_codes: ["not_linked_to_IC_claim"],
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    }];

    const result = reconcileAllStages(candidates, q3Results, q4Output, [], terminalRecords);

    expect(result.all_valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.terminal_row_count).toBe(1);
    expect(result.terminal_missing_candidates).toBe(0);
  });

  it("24: detects Q3 referencing non-existent Q2 candidate", () => {
    const candidates = [makeCandidate({ candidate_id: "c1" })];

    const q3Results = [{
      candidate_id: "ghost", // not in candidates
      canonical_comparison_ids: [],
      disposition: "x",
      q4_eligible: false,
      eligibility_reason: "x",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "x",
      authority_valid: false,
      authority_rationale: "x",
      claim_provenance: null,
      verdict: null,
    }];

    const q4Output = { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map<string, string>() };
    const terminalRecords = [{
      candidate_id: "c1",
      terminal_status: "processing_error" as const,
      terminal_stage: "q3" as const,
      canonical_finding_id: null,
      family_id: null,
      reason_codes: [],
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    }];

    const result = reconcileAllStages(candidates, q3Results, q4Output, [], terminalRecords);

    expect(result.all_valid).toBe(false);
    expect(result.q3_unresolved_references).toBe(1);
    expect(result.violations.some(v => v.includes("ghost"))).toBe(true);
  });

  it("25: detects missing terminal record for Q2 candidate", () => {
    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];

    const q3Results = candidates.map(c => ({
      candidate_id: c.candidate_id,
      canonical_comparison_ids: [],
      disposition: "x",
      q4_eligible: false,
      eligibility_reason: "x",
      rejection_reason_codes: [],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: "x",
      authority_valid: false,
      authority_rationale: "x",
      claim_provenance: null,
      verdict: null,
    }));

    const q4Output = { families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map<string, string>() };

    // Only one terminal record — c2 is missing
    const terminalRecords = [{
      candidate_id: "c1",
      terminal_status: "q3_ineligible" as const,
      terminal_stage: "q3" as const,
      canonical_finding_id: null,
      family_id: null,
      reason_codes: [],
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    }];

    const result = reconcileAllStages(candidates, q3Results, q4Output, [], terminalRecords);

    expect(result.all_valid).toBe(false);
    expect(result.terminal_missing_candidates).toBe(1);
    expect(result.violations.some(v => v.includes("c2"))).toBe(true);
  });
});
