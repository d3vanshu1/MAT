/**
 * MAT-F07 Final Corrections: 12 Targeted Tests
 *
 * These tests verify the three corrections:
 *   1. Terminal accounting covers ALL 221 Q2 candidates
 *   2. Q5 retains real F04 canonical findings
 *   3. Q4 groups by F04 proposition key (not title/detail)
 *
 * Required: parent revision fails tests 1, 4, 5, 8, 12.
 *           New revision passes all twelve.
 */
import { describe, it, expect } from "vitest";
import { executeQ3Stage, type Q2CandidateInput, type Q3ResultRow } from "../q3-production-stage.js";
import { executeQ4Stage, type Q4StageOutput } from "../q4-production-stage.js";
import { executeQ5Stage, type Q5Finding } from "../q5-production-stage.js";
import { executeTerminalAccounting, reconcileAllStages, type TerminalRecord } from "../terminal-accounting-stage.js";
import type { CanonicalFindingRecord, CanonicalDisposition } from "../canonical-finding-record.js";

// ===========================================================================
// Test Fixtures
// ===========================================================================

/** Build a minimal Q2 candidate */
function makeQ2Candidate(overrides: Partial<Q2CandidateInput> & { candidate_id: string }): Q2CandidateInput {
  return {
    candidate_id: overrides.candidate_id,
    title: overrides.title ?? "Test finding",
    detail: overrides.detail ?? "Test detail",
    finding_kind: overrides.finding_kind ?? "data_divergence",
    severity: overrides.severity ?? "warning",
    source_tag: overrides.source_tag ?? "ic_memo",
    source_docs: overrides.source_docs ?? ["doc1.pdf"],
    canonical_claim_id: overrides.canonical_claim_id ?? "clm-v1-test",
    metric: overrides.metric ?? "revenue",
    period: overrides.period ?? "FY Mar-26",
    entity_segment: overrides.entity_segment ?? "Total Group",
    scope_qualifier: overrides.scope_qualifier ?? null,
    unit: overrides.unit ?? "£m",
    actual_or_forecast: overrides.actual_or_forecast ?? "forecast",
    accounting_basis: overrides.accounting_basis ?? null,
    comparison_basis: overrides.comparison_basis ?? "memo_vs_model",
    q2_disposition: overrides.q2_disposition ?? "reportable_q3_eligible",
    q2_reason: overrides.q2_reason ?? "full evidence",
    reportable: overrides.reportable ?? true,
  };
}

/** Build 221-candidate fixture: 12 reportable + 209 non-reportable with varied dispositions */
function build221CandidateFixture(): {
  allQ2: Q2CandidateInput[];
  reportable: Q2CandidateInput[];
  nonReportable: Q2CandidateInput[];
} {
  const reportable: Q2CandidateInput[] = [];
  const nonReportable: Q2CandidateInput[] = [];

  // 12 reportable candidates
  for (let i = 0; i < 12; i++) {
    reportable.push(makeQ2Candidate({
      candidate_id: `cand-reportable-${i}`,
      title: `Revenue divergence finding ${i}`,
      reportable: true,
      q2_disposition: "reportable_q3_eligible",
      q2_reason: "data_divergence with full evidence",
      metric: "revenue",
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    }));
  }

  // 209 non-reportable with VARIED dispositions (not generic catch-all)
  const dispositionVariants = [
    { q2_disposition: "non_reportable", q2_reason: "no_claim_linkage", count: 40 },
    { q2_disposition: "unverifiable", q2_reason: "no_structured_verification", count: 35 },
    { q2_disposition: "duplicate_candidate_identity", q2_reason: "duplicate_candidate_identity", count: 30 },
    { q2_disposition: "non_reportable", q2_reason: "invalid_evidence_authority", count: 25 },
    { q2_disposition: "non_reportable", q2_reason: "wrong_module", count: 20 },
    { q2_disposition: "incompatible_claim_evidence", q2_reason: "incompatible_claim_evidence", count: 15 },
    { q2_disposition: "non_reportable", q2_reason: "non_reportable_finding_kind", count: 15 },
    { q2_disposition: "non_reportable", q2_reason: "source_recommendation", count: 14 },
    { q2_disposition: "confirmed", q2_reason: "claim_linked_confirmed", count: 8 },
    { q2_disposition: "supporting_only", q2_reason: "supporting_evidence_only", count: 7 },
  ];

  let idx = 0;
  for (const variant of dispositionVariants) {
    for (let j = 0; j < variant.count; j++) {
      nonReportable.push(makeQ2Candidate({
        candidate_id: `cand-nonreportable-${idx}`,
        title: `Non-reportable finding ${idx}`,
        reportable: false,
        q2_disposition: variant.q2_disposition,
        q2_reason: variant.q2_reason,
        metric: "unknown",
        period: "unknown",
      }));
      idx++;
    }
  }

  const allQ2 = [...reportable, ...nonReportable];
  expect(allQ2.length).toBe(221);

  return { allQ2, reportable, nonReportable };
}

/** Build a minimal F04 canonical finding record */
function makeF04Record(overrides: {
  findingId: string;
  semanticHash?: string;
  propositionKey?: string;
  evidenceIds?: string[];
  reportable?: boolean;
}): CanonicalFindingRecord {
  return {
    schema_version: "canonical_finding_v1" as any,
    identity: {
      finding_id: overrides.findingId,
      proposition_key: overrides.propositionKey ?? "financial|memo_model_gap|revenue|fy26|group|null|£m|forecast|null|memo_vs_model|unknown",
      semantic_hash: overrides.semanticHash ?? `hash-${overrides.findingId}`,
      identity_version: "v1" as any,
    },
    claim: {
      claim_id: `clm-for-${overrides.findingId}`,
      metric: "revenue",
      period: "FY Mar-26",
      scope_qualifier: "Total Group",
    } as any,
    evidence: (overrides.evidenceIds ?? [`ev-${overrides.findingId}`]).map(eid => ({
      evidence_id: eid,
      source_document_id: "doc-1",
      source_document_name: "memo.pdf",
      authority_class: "model_comparison",
      coordinate: {} as any,
      target_entity: null,
      target_segment: null,
      evidence_role: "primary",
      canonical_record: {} as any,
      bridge_evidence_id: null,
    })),
    comparisons: [],
    disposition: {
      verdict: overrides.reportable !== false ? "contradicted" : "confirmed",
      reportable: overrides.reportable !== false,
      reason_codes: [],
      rule_version: "verdict-v1.0",
    } as CanonicalDisposition,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("MAT-F07 Correction 1: Terminal accounts for ALL Q2 candidates", () => {
  it("Test 1: 221 persisted Q2 rows produce 221 terminal rows", () => {
    const { allQ2, reportable } = build221CandidateFixture();
    const q3AdmissionCandidates = reportable;

    // Run Q3 (simplified — all return ineligible for this test)
    const q3Results: Q3ResultRow[] = q3AdmissionCandidates.map(c => ({
      candidate_id: c.candidate_id,
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      rejection_reason_codes: ["no_claim_linkage"],
      canonical_references: {},
    }));

    const q4Output: Q4StageOutput = {
      families: [],
      singletons: [],
      ambiguous: [],
      degraded: [],
      memberToFamily: new Map(),
    };

    const terminalOutput = executeTerminalAccounting({
      allQ2Candidates: allQ2,
      q3AdmissionCandidates,
      q3Results,
      q4Output,
      q5Findings: [],
    });

    expect(terminalOutput.records.length).toBe(221);
    expect(terminalOutput.invariant_violations).toHaveLength(0);
  });

  it("Test 2: 209 candidates excluded before Q3 receive deterministic statuses", () => {
    const { allQ2, reportable, nonReportable } = build221CandidateFixture();
    const q3AdmissionCandidates = reportable;

    const q3Results: Q3ResultRow[] = q3AdmissionCandidates.map(c => ({
      candidate_id: c.candidate_id,
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      rejection_reason_codes: ["no_claim_linkage"],
      canonical_references: {},
    }));

    const q4Output: Q4StageOutput = {
      families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map(),
    };

    const terminalOutput = executeTerminalAccounting({
      allQ2Candidates: allQ2,
      q3AdmissionCandidates,
      q3Results,
      q4Output,
      q5Findings: [],
    });

    // All 209 non-reportable candidates must have terminal rows at stage "q2"
    const nonReportableIds = new Set(nonReportable.map(c => c.candidate_id));
    const nonReportableTerminal = terminalOutput.records.filter(r => nonReportableIds.has(r.candidate_id));
    expect(nonReportableTerminal.length).toBe(209);

    // They must NOT all have the same generic status
    const uniqueStatuses = new Set(nonReportableTerminal.map(r => r.terminal_status));
    expect(uniqueStatuses.size).toBeGreaterThanOrEqual(4);

    // Each must be terminal at Q2
    for (const r of nonReportableTerminal) {
      expect(r.terminal_stage).toBe("q2");
    }
  });

  it("Test 3: Cross-stage reconciliation reports zero missing terminal candidates", () => {
    const { allQ2, reportable } = build221CandidateFixture();
    const q3AdmissionCandidates = reportable;

    const q3Results: Q3ResultRow[] = q3AdmissionCandidates.map(c => ({
      candidate_id: c.candidate_id,
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      rejection_reason_codes: ["no_claim_linkage"],
      canonical_references: {},
    }));

    const q4Output: Q4StageOutput = {
      families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map(),
    };

    const terminalOutput = executeTerminalAccounting({
      allQ2Candidates: allQ2,
      q3AdmissionCandidates,
      q3Results,
      q4Output,
      q5Findings: [],
    });

    const reconciliation = reconcileAllStages(
      allQ2,
      q3Results,
      q4Output,
      [],
      terminalOutput.records,
    );

    expect(reconciliation.terminal_missing_candidates).toBe(0);
    expect(reconciliation.terminal_duplicate_ids).toBe(0);
    expect(reconciliation.q2_unique_ids).toBe(221);
    expect(reconciliation.terminal_row_count).toBe(221);
  });

  it("Test 12: Observed 12 Q3 inputs and zero Q4-eligible rows still produce 221-row terminal", () => {
    const { allQ2, reportable } = build221CandidateFixture();
    const q3AdmissionCandidates = reportable;
    expect(q3AdmissionCandidates.length).toBe(12);

    // All 12 Q3 inputs return ineligible (matching observed SCG behavior)
    const q3Results: Q3ResultRow[] = q3AdmissionCandidates.map(c => ({
      candidate_id: c.candidate_id,
      disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      rejection_reason_codes: ["no_claim_linkage"],
      canonical_references: {},
    }));

    const q4Output: Q4StageOutput = {
      families: [], singletons: [], ambiguous: [], degraded: [], memberToFamily: new Map(),
    };

    const terminalOutput = executeTerminalAccounting({
      allQ2Candidates: allQ2,
      q3AdmissionCandidates,
      q3Results,
      q4Output,
      q5Findings: [],
    });

    expect(terminalOutput.records.length).toBe(221);
    expect(terminalOutput.invariant_violations).toHaveLength(0);

    // Q3 admission is 12, Q4 eligible is 0
    const q3TerminalRows = terminalOutput.records.filter(r => r.terminal_stage === "q3");
    expect(q3TerminalRows.length).toBe(12);
    const q2TerminalRows = terminalOutput.records.filter(r => r.terminal_stage === "q2");
    expect(q2TerminalRows.length).toBe(209);
  });
});

describe("MAT-F07 Correction 2: Q5 retains real F04 canonical findings", () => {
  it("Test 4: Q5 retains an existing F04 finding ID", () => {
    const f04Record = makeF04Record({
      findingId: "cfr-v1-abc123def456",
      semanticHash: "hash-abc123",
      evidenceIds: ["ev-001", "ev-002"],
    });

    const q4Output: Q4StageOutput = {
      families: [{
        family_id: "fam-1",
        member_q3_ids: ["cand-1"],
        member_candidate_ids: ["cand-1"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "v2",
        duplicate_decisions: [{ candidate_id: "cand-1", decision: "representative" }],
        member_count: 1,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [],
      ambiguous: [],
      degraded: [],
      memberToFamily: new Map([["cand-1", "fam-1"]]),
    };

    const f04Map = new Map<string, CanonicalFindingRecord>([["cand-1", f04Record]]);
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });

    expect(q5Output.findings.length).toBe(1);
    expect(q5Output.findings[0].canonical_finding_id).toBe("cfr-v1-abc123def456");
  });

  it("Test 5: Q5 retains the existing F04 semantic hash", () => {
    const f04Record = makeF04Record({
      findingId: "cfr-v1-test",
      semanticHash: "deadbeef1234567890abcdef",
    });

    const q4Output: Q4StageOutput = {
      families: [{
        family_id: "fam-2",
        member_q3_ids: ["cand-2"],
        member_candidate_ids: ["cand-2"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "v2",
        duplicate_decisions: [{ candidate_id: "cand-2", decision: "representative" }],
        member_count: 1,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [], ambiguous: [], degraded: [],
      memberToFamily: new Map([["cand-2", "fam-2"]]),
    };

    const f04Map = new Map<string, CanonicalFindingRecord>([["cand-2", f04Record]]);
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });

    expect(q5Output.findings[0].semantic_hash).toBe("deadbeef1234567890abcdef");
  });

  it("Test 6: Q5 retains exact admitted evidence IDs", () => {
    const f04Record = makeF04Record({
      findingId: "cfr-v1-ev-test",
      evidenceIds: ["ev-alpha", "ev-beta", "ev-gamma"],
    });

    const q4Output: Q4StageOutput = {
      families: [{
        family_id: "fam-3",
        member_q3_ids: ["cand-3"],
        member_candidate_ids: ["cand-3"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "v2",
        duplicate_decisions: [{ candidate_id: "cand-3", decision: "representative" }],
        member_count: 1,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [], ambiguous: [], degraded: [],
      memberToFamily: new Map([["cand-3", "fam-3"]]),
    };

    const f04Map = new Map<string, CanonicalFindingRecord>([["cand-3", f04Record]]);
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });

    expect(q5Output.findings[0].admitted_evidence_ids).toEqual(["ev-alpha", "ev-beta", "ev-gamma"]);
  });

  it("Test 7: Missing F04 resolution fails closed with terminal reason", () => {
    const q4Output: Q4StageOutput = {
      families: [{
        family_id: "fam-4",
        member_q3_ids: ["cand-no-f04"],
        member_candidate_ids: ["cand-no-f04"],
        canonical_proposition_key: "test-key",
        canonical_key: {} as any,
        grouping_rule_version: "v2",
        duplicate_decisions: [{ candidate_id: "cand-no-f04", decision: "representative" }],
        member_count: 1,
        memo_versions: [],
        all_originating_claim_ids: [],
      }],
      singletons: [], ambiguous: [], degraded: [],
      memberToFamily: new Map([["cand-no-f04", "fam-4"]]),
    };

    // Empty F04 map — no canonical finding records available
    const f04Map = new Map<string, CanonicalFindingRecord>();
    const q5Output = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });

    expect(q5Output.findings[0].resolution_failure).toBe("canonical_finding_not_resolved");
    expect(q5Output.findings[0].canonical_record).toBeNull();
    expect(q5Output.findings[0].reportable).toBe(false);
    expect(q5Output.unresolved_families).toBe(1);
  });
});

describe("MAT-F07 Correction 3: Q4 groups by F04 proposition key", () => {
  it("Test 8: Q4 uses supplied F04 proposition key rather than title/detail", () => {
    // Two candidates with SAME title but DIFFERENT F04 proposition keys
    const candA = makeQ2Candidate({
      candidate_id: "cand-a",
      title: "Revenue divergence",
      detail: "Same detail for both",
      metric: "revenue",
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    });
    const candB = makeQ2Candidate({
      candidate_id: "cand-b",
      title: "Revenue divergence", // SAME title
      detail: "Same detail for both", // SAME detail
      metric: "revenue",
      period: "FY Mar-26",
      comparison_basis: "memo_versions", // DIFFERENT comparison basis
    });

    const q3Results: Q3ResultRow[] = [
      { candidate_id: "cand-a", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
      { candidate_id: "cand-b", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
    ];

    const q4Output = executeQ4Stage({ q3Results, candidates: [candA, candB] });

    // Should produce 2 separate families because comparison_basis differs
    const familyForA = q4Output.families.find(f => f.member_candidate_ids.includes("cand-a"));
    const familyForB = q4Output.families.find(f => f.member_candidate_ids.includes("cand-b"));
    expect(familyForA).toBeDefined();
    expect(familyForB).toBeDefined();
    expect(familyForA!.family_id).not.toBe(familyForB!.family_id);
  });

  it("Test 9: Memo-versus-model and live-versus-reference remain separate", () => {
    const candMemoModel = makeQ2Candidate({
      candidate_id: "cand-memo-model",
      title: "Revenue divergence",
      metric: "revenue",
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    });
    const candMemoVersions = makeQ2Candidate({
      candidate_id: "cand-memo-versions",
      title: "Revenue divergence",
      metric: "revenue",
      period: "FY Mar-26",
      comparison_basis: "memo_versions",
    });

    const q3Results: Q3ResultRow[] = [
      { candidate_id: "cand-memo-model", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
      { candidate_id: "cand-memo-versions", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
    ];

    const q4Output = executeQ4Stage({ q3Results, candidates: [candMemoModel, candMemoVersions] });

    const famA = q4Output.families.find(f => f.member_candidate_ids.includes("cand-memo-model"));
    const famB = q4Output.families.find(f => f.member_candidate_ids.includes("cand-memo-versions"));
    expect(famA!.family_id).not.toBe(famB!.family_id);
  });

  it("Test 10: Reported EBITDA, cash EBITDA, and EBITDA adjustments remain separate", () => {
    const candReported = makeQ2Candidate({
      candidate_id: "cand-reported-ebitda",
      title: "EBITDA finding",
      metric: "ebitda",
      scope_qualifier: "reported",
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    });
    const candCash = makeQ2Candidate({
      candidate_id: "cand-cash-ebitda",
      title: "EBITDA finding", // SAME title
      metric: "ebitda",
      scope_qualifier: "cash",
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    });
    const candAdjustments = makeQ2Candidate({
      candidate_id: "cand-ebitda-adjustments",
      title: "EBITDA finding", // SAME title
      metric: "ebitda_adjustments",
      scope_qualifier: null,
      period: "FY Mar-26",
      comparison_basis: "memo_vs_model",
    });

    const q3Results: Q3ResultRow[] = [
      { candidate_id: "cand-reported-ebitda", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
      { candidate_id: "cand-cash-ebitda", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
      { candidate_id: "cand-ebitda-adjustments", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
    ];

    const q4Output = executeQ4Stage({ q3Results, candidates: [candReported, candCash, candAdjustments] });

    // Each should be in a separate family (metric or scope differs)
    const famReported = q4Output.families.find(f => f.member_candidate_ids.includes("cand-reported-ebitda"));
    const famCash = q4Output.families.find(f => f.member_candidate_ids.includes("cand-cash-ebitda"));
    const famAdj = q4Output.families.find(f => f.member_candidate_ids.includes("cand-ebitda-adjustments"));
    expect(famReported).toBeDefined();
    expect(famCash).toBeDefined();
    expect(famAdj).toBeDefined();

    const familyIds = [famReported!.family_id, famCash!.family_id, famAdj!.family_id];
    const unique = new Set(familyIds);
    expect(unique.size).toBe(3);
  });

  it("Test 11: Changing title/detail does not change Q4 family identity", () => {
    // Two candidates with DIFFERENT titles but SAME proposition key
    const candA = makeQ2Candidate({
      candidate_id: "cand-title-a",
      title: "Total Group Revenue (FY Mar-26): memo higher than model by £9.6m",
      detail: "Very long detailed description about revenue divergence...",
      metric: "revenue",
      period: "FY Mar-26",
      entity_segment: "Total Group",
      comparison_basis: "memo_vs_model",
    });
    const candB = makeQ2Candidate({
      candidate_id: "cand-title-b",
      title: "Completely different title about revenue", // DIFFERENT title
      detail: "Completely different detail text", // DIFFERENT detail
      metric: "revenue", // SAME metric
      period: "FY Mar-26", // SAME period
      entity_segment: "Total Group", // SAME entity
      comparison_basis: "memo_vs_model", // SAME comparison basis
    });

    const q3Results: Q3ResultRow[] = [
      { candidate_id: "cand-title-a", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
      { candidate_id: "cand-title-b", disposition: "claim_linked_contradicted", q4_eligible: true, rejection_reason_codes: [], canonical_references: {} },
    ];

    const q4Output = executeQ4Stage({ q3Results, candidates: [candA, candB] });

    // Should be in SAME family because proposition key is identical
    const famA = q4Output.families.find(f => f.member_candidate_ids.includes("cand-title-a"));
    const famB = q4Output.families.find(f => f.member_candidate_ids.includes("cand-title-b"));
    expect(famA!.family_id).toBe(famB!.family_id);
  });
});
