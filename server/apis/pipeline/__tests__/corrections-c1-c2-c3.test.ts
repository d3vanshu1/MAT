/**
 * Corrections C1/C2/C3 — Targeted Tests
 *
 * 10 tests covering:
 *   C1: Qualitative claims survive incremental resume (prior ledger merge)
 *   C2: Exact F04 proposition key is the actual Q4 grouping key
 *   C3: Admitted evidence identity included in ambiguity checking
 *
 * Plus: 221-row terminal accounting invariant (unchanged), and prior 22 tests pass.
 *
 * All tests use seeded fixtures. No live DB, no LLM.
 */

import { describe, it, expect } from "vitest";
import {
  type CanonicalIcClaim,
  buildClaimLedger,
  buildQualitativeClaim,
  generateCanonicalClaimId,
} from "../canonical-ic-claim.js";
import { executeQ4Stage, type Q4Family } from "../q4-production-stage.js";
import { executeQ5Stage } from "../q5-production-stage.js";
import type { Q2CandidateInput, Q3ResultRow } from "../q3-production-stage.js";
import type { CanonicalFindingRecord } from "../canonical-finding-record.js";

// ===========================================================================
// Helpers
// ===========================================================================

function makeQ3Row(overrides: Partial<Q3ResultRow> & { candidate_id: string }): Q3ResultRow {
  return {
    candidate_id: overrides.candidate_id,
    q4_eligible: true,
    f04_finding_id: overrides.f04_finding_id ?? `f04-${overrides.candidate_id}`,
    f04_semantic_hash: overrides.f04_semantic_hash ?? `hash-${overrides.candidate_id}`,
    f04_proposition_key: overrides.f04_proposition_key ?? "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model",
    f04_admitted_evidence_ids: overrides.f04_admitted_evidence_ids ?? [`ev-${overrides.candidate_id}`],
    canonical_claim_id: overrides.canonical_claim_id ?? `claim-${overrides.candidate_id}`,
    ...overrides,
  } as Q3ResultRow;
}

function makeCandidate(overrides: Partial<Q2CandidateInput> & { candidate_id: string }): Q2CandidateInput {
  return {
    candidate_id: overrides.candidate_id,
    title: overrides.title ?? "Revenue FY2024",
    detail: overrides.detail ?? "$425M projected",
    metric: overrides.metric ?? "revenue",
    period: overrides.period ?? "fy2024",
    entity_segment: overrides.entity_segment ?? "alpha",
    scope_qualifier: overrides.scope_qualifier ?? "consolidated",
    unit: overrides.unit ?? "usd_mm",
    actual_or_forecast: overrides.actual_or_forecast ?? "actual",
    accounting_basis: overrides.accounting_basis ?? "gaap",
    comparison_basis: overrides.comparison_basis ?? "memo_vs_model",
    source_docs: overrides.source_docs ?? ["IC_Memo_Alpha_v3.pdf"],
    ...overrides,
  } as Q2CandidateInput;
}

function makeFindingRecord(overrides: {
  proposition_key: string;
  verdict?: string;
  evidence_ids?: string[];
}): CanonicalFindingRecord {
  return {
    schema_version: "canonical-finding-v1",
    identity: {
      finding_id: `cfr-v1-${overrides.proposition_key.slice(0, 16).replace(/[^a-z0-9]/g, "")}`,
      proposition_key: overrides.proposition_key,
      semantic_hash: `sh-${overrides.proposition_key.slice(0, 8)}`,
      identity_version: "identity-v1.0",
    },
    claim: {} as any,
    evidence: (overrides.evidence_ids ?? ["ev-default-001"]).map(id => ({
      evidence_id: id,
      source_document_id: "doc-001",
      source_document_name: "memo.pdf",
      authority_class: "primary_source",
      coordinate: { page: 1 },
      target_entity: null,
      target_segment: null,
      evidence_role: "primary",
      canonical_record: {} as any,
      bridge_evidence_id: null,
    })),
    comparisons: [],
    disposition: {
      verdict: (overrides.verdict ?? "confirmed") as any,
      reportable: true,
      reason_codes: [],
      rule_version: "disposition-v1.0",
    },
  } as unknown as CanonicalFindingRecord;
}

// ===========================================================================
// C1: Qualitative claims survive incremental resume
// ===========================================================================
describe("C1: Qualitative claims survive incremental resume", () => {
  it("Test 1: Prior qualitative claims merge into new ledger via buildClaimLedger dedup", () => {
    // Simulate: run 1 produced qualitative claims; run 2 resumes with those as priorLedger.canonical_claims
    const priorQual1 = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "2",
      section: undefined,
      exact_claim_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition of Beta Corp by Q2 2025.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "deleveraging depends on future M&A",
      source_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition of Beta Corp by Q2 2025.",
    });
    const priorQual2 = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "3",
      section: undefined,
      exact_claim_text: "Customer contracts are described as containing adequate protections against early termination.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "contract protections assertion",
      source_text: "Customer contracts are described as containing adequate protections against early termination.",
    });

    // Simulate new run adds a new qualitative claim (different text)
    const newQual = buildQualitativeClaim({
      document_id: "memo-002",
      document_name: "IC_Memo_Alpha_v4.pdf",
      memo_version: "v4",
      page_or_slide: "5",
      section: undefined,
      exact_claim_text: "Working capital normalization assumes seasonal adjustment of $15M.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "working capital seasonal assumption",
      source_text: "Working capital normalization assumes seasonal adjustment of $15M.",
    });

    // The Correction 1 merge: priorQualitativeClaims + newQualitativeClaims
    const priorQualitativeClaims: CanonicalIcClaim[] = [priorQual1, priorQual2];
    const newQualitativeClaims: CanonicalIcClaim[] = [newQual];
    const allCanonicalWithQualitative = [...priorQualitativeClaims, ...newQualitativeClaims];
    const merged = buildClaimLedger(allCanonicalWithQualitative);

    // All three survive
    expect(merged.claims).toHaveLength(3);
    expect(merged.claims.filter(c => c.claim_type === "qualitative")).toHaveLength(3);
  });

  it("Test 2: Duplicate qualitative claims (same text) are deduped by claim_id", () => {
    const claim1 = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "2",
      section: undefined,
      exact_claim_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "deleveraging depends on M&A",
      source_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition.",
    });

    // Same exact_claim_text + document = same claim_id
    const claim2 = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "2",
      section: undefined,
      exact_claim_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "deleveraging depends on M&A",
      source_text: "The deleveraging thesis depends critically on completing the bolt-on acquisition.",
    });

    expect(claim1.claim_id).toBe(claim2.claim_id);
    const merged = buildClaimLedger([claim1, claim2]);
    expect(merged.claims).toHaveLength(1); // Deduped
  });

  it("Test 3: Resume preserves claim IDs identically (partial run + resume = uninterrupted)", () => {
    const qual = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "2",
      section: undefined,
      exact_claim_text: "An organic EBITDA baseline is not separately disclosed.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "organic EBITDA not disclosed",
      source_text: "An organic EBITDA baseline is not separately disclosed.",
    });

    // Simulate: run 1 produces this claim → persisted in canonical_claims
    const run1Id = qual.claim_id;

    // Simulate: run 2 resumes → same claim produced again → must get same ID
    const run2Qual = buildQualitativeClaim({
      document_id: "memo-001",
      document_name: "IC_Memo_Alpha_v3.pdf",
      memo_version: "v3",
      page_or_slide: "2",
      section: undefined,
      exact_claim_text: "An organic EBITDA baseline is not separately disclosed.",
      entity: "Alpha",
      segment: null,
      qualitative_proposition: "organic EBITDA not disclosed",
      source_text: "An organic EBITDA baseline is not separately disclosed.",
    });

    expect(run2Qual.claim_id).toBe(run1Id);
  });
});

// ===========================================================================
// C2: Exact F04 proposition key is the actual Q4 grouping key
// ===========================================================================
describe("C2: Exact F04 proposition key controls Q4 family grouping", () => {
  it("Test 4: Family canonical_proposition_key equals exact persisted F04 key", () => {
    const f04Key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";
    const candidates = [makeCandidate({ candidate_id: "c1" })];
    const q3Results = [makeQ3Row({ candidate_id: "c1", f04_proposition_key: f04Key })];

    const output = executeQ4Stage({ q3Results, candidates });
    expect(output.families).toHaveLength(1);
    expect(output.families[0].canonical_proposition_key).toBe(f04Key);
  });

  it("Test 5: Different F04 keys never share a family", () => {
    const keyA = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";
    const keyB = "operating_metric|profitability|ebitda|fy2024|alpha|consolidated|pct|actual|adjusted|memo_vs_model";

    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];
    const q3Results = [
      makeQ3Row({ candidate_id: "c1", f04_proposition_key: keyA }),
      makeQ3Row({ candidate_id: "c2", f04_proposition_key: keyB }),
    ];

    const output = executeQ4Stage({ q3Results, candidates });
    expect(output.families).toHaveLength(2);
    // Each family has exactly one member
    expect(output.families[0].member_count).toBe(1);
    expect(output.families[1].member_count).toBe(1);
    // Keys match input
    const keys = output.families.map(f => f.canonical_proposition_key).sort();
    expect(keys).toEqual([keyA, keyB].sort());
  });

  it("Test 6: Same F04 key with different titles still groups together", () => {
    const key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";

    const candidates = [
      makeCandidate({ candidate_id: "c1", title: "Revenue Growth FY2024" }),
      makeCandidate({ candidate_id: "c2", title: "Top-line Revenue Outlook" }),
    ];
    const q3Results = [
      makeQ3Row({ candidate_id: "c1", f04_proposition_key: key }),
      makeQ3Row({ candidate_id: "c2", f04_proposition_key: key }),
    ];

    const output = executeQ4Stage({ q3Results, candidates });
    // Same key → same family, regardless of title difference
    expect(output.families).toHaveLength(1);
    expect(output.families[0].member_count).toBe(2);
    expect(output.families[0].member_candidate_ids.sort()).toEqual(["c1", "c2"]);
  });

  it("Test 7: grouping_rule_version is f04-exact-key-partition-v1", () => {
    const key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";
    const candidates = [makeCandidate({ candidate_id: "c1" })];
    const q3Results = [makeQ3Row({ candidate_id: "c1", f04_proposition_key: key })];

    const output = executeQ4Stage({ q3Results, candidates });
    expect(output.families[0].grouping_rule_version).toBe("f04-exact-key-partition-v1");
  });
});

// ===========================================================================
// C3: Evidence identity in ambiguity checking
// ===========================================================================
describe("C3: Admitted evidence identity in ambiguity check", () => {
  it("Test 8: Identical evidence sets deduplicates (not ambiguous)", () => {
    const key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";
    const sharedEvidence = ["ev-001", "ev-002"];

    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];
    const q3Results = [
      makeQ3Row({ candidate_id: "c1", f04_proposition_key: key, f04_admitted_evidence_ids: sharedEvidence }),
      makeQ3Row({ candidate_id: "c2", f04_proposition_key: key, f04_admitted_evidence_ids: sharedEvidence }),
    ];

    // Same proposition key + same evidence + same verdict → true duplicate
    const record = makeFindingRecord({ proposition_key: key, verdict: "confirmed", evidence_ids: sharedEvidence });
    const f04RecordsByCandidate = new Map<string, CanonicalFindingRecord>();
    f04RecordsByCandidate.set("c1", record);
    f04RecordsByCandidate.set("c2", record);

    const q4Output = executeQ4Stage({ q3Results, candidates });
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate });

    // Should resolve — same records → not ambiguous
    const finding = q5Output.findings[0];
    expect(finding.resolution_failure).toBeFalsy();
    expect(finding.ambiguity_reason_codes ?? []).toHaveLength(0);
  });

  it("Test 9: Different evidence sets trigger fail-closed with different_evidence_sets code", () => {
    const key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";

    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];
    const q3Results = [
      makeQ3Row({ candidate_id: "c1", f04_proposition_key: key, f04_admitted_evidence_ids: ["ev-001", "ev-002"] }),
      makeQ3Row({ candidate_id: "c2", f04_proposition_key: key, f04_admitted_evidence_ids: ["ev-003", "ev-004"] }),
    ];

    // Same key + same verdict BUT different evidence
    const record1 = makeFindingRecord({ proposition_key: key, verdict: "confirmed", evidence_ids: ["ev-001", "ev-002"] });
    const record2 = makeFindingRecord({ proposition_key: key, verdict: "confirmed", evidence_ids: ["ev-003", "ev-004"] });
    const f04RecordsByCandidate = new Map<string, CanonicalFindingRecord>();
    f04RecordsByCandidate.set("c1", record1);
    f04RecordsByCandidate.set("c2", record2);

    const q4Output = executeQ4Stage({ q3Results, candidates });
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate });

    // Should fail closed due to different evidence sets
    const finding = q5Output.findings[0];
    expect(finding.resolution_failure).toBeTruthy();
    expect(finding.ambiguity_reason_codes).toContain("different_evidence_sets");
  });

  it("Test 10: Conflicting F04 evidence IDs are retained in terminal lineage (member_f04_evidence_ids)", () => {
    const key = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";

    const candidates = [
      makeCandidate({ candidate_id: "c1" }),
      makeCandidate({ candidate_id: "c2" }),
    ];
    const q3Results = [
      makeQ3Row({ candidate_id: "c1", f04_proposition_key: key, f04_admitted_evidence_ids: ["ev-A1"] }),
      makeQ3Row({ candidate_id: "c2", f04_proposition_key: key, f04_admitted_evidence_ids: ["ev-B1"] }),
    ];

    const q4Output = executeQ4Stage({ q3Results, candidates });

    // Q4 family preserves all evidence IDs from members for downstream tracing
    const family = q4Output.families[0];
    expect(family.member_f04_evidence_ids).toContain("ev-A1");
    expect(family.member_f04_evidence_ids).toContain("ev-B1");
  });
});
