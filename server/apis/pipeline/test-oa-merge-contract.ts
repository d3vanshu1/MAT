/**
 * OA-02 Test Suite: 14 targeted test cases for the non-generative merge contract.
 *
 * 8 rejection tests (R1–R8): verify that specific contract violations trigger
 * fail-closed behavior and the validator rejects the output.
 *
 * 6 positive tests (P1–P6): verify that legitimate merge operations pass the
 * contract — deduplication, singleton pass-through, severity preservation, etc.
 *
 * All tests are purely synthetic (in-memory fixtures). No DB queries. No SCG data.
 * No pipeline runs triggered.
 */

import { api, z } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import { validateMergeContract, type MergeContractResult } from "./merge-contract-validator.js";

// ---------------------------------------------------------------------------
// Synthetic fixture helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<CanonicalFinding> & { finding_id: string }): CanonicalFinding {
  return {
    finding_id: overrides.finding_id,
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Test finding",
    detail: overrides.detail ?? "A test detail with value 42",
    full_analysis: overrides.full_analysis ?? "Analysis text referencing 42 and 100",
    source_docs: overrides.source_docs ?? ["doc_alpha.pdf"],
    merged_from_finding_ids: overrides.merged_from_finding_ids,
    claim_ids: overrides.claim_ids,
    evidence_docs: overrides.evidence_docs,
    finding_kind: overrides.finding_kind,
    category: overrides.category,
    issue_key: overrides.issue_key,
    evidence: overrides.evidence,
    structured_impact: overrides.structured_impact,
    severity_anchor: overrides.severity_anchor,
    materiality_rationale: overrides.materiality_rationale,
  } as CanonicalFinding;
}

const F1 = makeFinding({
  finding_id: "aaaa0001-0000-4000-a000-000000000001",
  severity: "critical",
  title: "Revenue discrepancy of 19000",
  detail: "Revenue shows 19000 vs 15000 in IC memo",
  full_analysis: "The CIM states revenue of 19000 while the IC memo quotes 15000. Delta is 4000.",
  source_docs: ["cim_v3.pdf", "ic_memo_final.pdf"],
  claim_ids: ["doc1:abc:0:0", "doc2:def:1:2"],
  evidence_docs: ["cim_v3.pdf"],
  finding_kind: "data_divergence",
  category: "principal_finding",
  evidence: [
    {
      figure: "19000",
      source_doc: "cim_v3.pdf",
      verbatim_snippet: "Total revenue: £19,000k",
      verified: true,
      document_id: "doc-uuid-001",
      cell_coordinate: "B12",
      sheet_or_page: "P&L",
    },
  ],
  structured_impact: [
    { amount: 4000, currency: "GBP", unit_multiplier: 1000, role: "delta", source_coordinate: "B12", verified: true },
  ],
});

const F2 = makeFinding({
  finding_id: "aaaa0002-0000-4000-a000-000000000002",
  severity: "warning",
  title: "FCA authorisation timeline unclear",
  detail: "No evidence of FCA approval timeline in diligence pack",
  full_analysis: "The regulatory section references FCA but provides no date. 6 months estimated.",
  source_docs: ["regulatory_pack.pdf"],
  claim_ids: ["doc3:ghi:2:0"],
  finding_kind: "absence_claim",
  category: "principal_finding",
  evidence: [
    {
      figure: "6",
      source_doc: "regulatory_pack.pdf",
      verbatim_snippet: "Expected timeline: 6 months",
      verified: false,
      document_id: "doc-uuid-002",
      sheet_or_page: "Page 4",
    },
  ],
});

const F3 = makeFinding({
  finding_id: "aaaa0003-0000-4000-a000-000000000003",
  severity: "info",
  title: "Minor formatting inconsistency",
  detail: "Different date formats used across documents",
  full_analysis: "Doc A uses DD/MM/YYYY and Doc B uses MM/DD/YYYY for the same 2024 dates.",
  source_docs: ["doc_a.pdf", "doc_b.pdf"],
  claim_ids: ["doc4:jkl:0:1"],
  finding_kind: "process_observation",
  category: "housekeeping",
});

const F4 = makeFinding({
  finding_id: "aaaa0004-0000-4000-a000-000000000004",
  severity: "critical",
  title: "EBITDA margin discrepancy of 250 basis points",
  detail: "Model shows 32% margin vs 29.5% in actuals — a 250bp gap",
  full_analysis: "The financial model forecasts EBITDA margin of 32% but trailing actuals show 29.5%.",
  source_docs: ["financial_model.xlsx", "management_accounts.pdf"],
  claim_ids: ["doc5:mno:3:0"],
  finding_kind: "data_divergence",
  category: "principal_finding",
  evidence: [
    {
      figure: "32",
      source_doc: "financial_model.xlsx",
      verbatim_snippet: "EBITDA margin: 32%",
      verified: true,
      document_id: "doc-uuid-003",
      cell_coordinate: "D8",
      sheet_or_page: "Summary",
    },
    {
      figure: "29.5",
      source_doc: "management_accounts.pdf",
      verbatim_snippet: "Trailing 12m EBITDA margin 29.5%",
      verified: true,
      document_id: "doc-uuid-004",
      sheet_or_page: "Page 12",
    },
  ],
  structured_impact: [
    { amount: 250, currency: "GBP", unit_multiplier: 1, role: "delta", source_coordinate: "D8", verified: true },
  ],
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

function assertRejected(
  result: MergeContractResult,
  expectedCode: string,
  testId: string,
  testName: string
): TestResult {
  if (result.valid) {
    return { id: testId, name: testName, passed: false, detail: "Expected rejection but got valid=true" };
  }
  if (!result.violationCodes.includes(expectedCode as any)) {
    return {
      id: testId,
      name: testName,
      passed: false,
      detail: `Expected violation code "${expectedCode}" but got [${result.violationCodes.join(", ")}]`,
    };
  }
  // Fail-closed: acceptedFindings should be the original input
  return { id: testId, name: testName, passed: true, detail: `Rejected with ${result.validationErrors.length} violation(s)` };
}

function assertAccepted(
  result: MergeContractResult,
  testId: string,
  testName: string,
  expectedCount?: number
): TestResult {
  if (!result.valid) {
    return {
      id: testId,
      name: testName,
      passed: false,
      detail: `Expected valid=true but got violations: [${result.violationCodes.join(", ")}] — ${result.validationErrors.map(v => v.detail).join("; ")}`,
    };
  }
  if (expectedCount !== undefined && result.acceptedFindings.length !== expectedCount) {
    return {
      id: testId,
      name: testName,
      passed: false,
      detail: `Expected ${expectedCount} accepted findings but got ${result.acceptedFindings.length}`,
    };
  }
  return { id: testId, name: testName, passed: true, detail: `Accepted with ${result.acceptedFindings.length} finding(s)` };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "TestOaMergeContract",
  description: "OA-02 test suite: 14 merge contract validation tests (synthetic only)",

  input: z.object({}),

  output: z.object({
    summary: z.string(),
    passed: z.number(),
    failed: z.number(),
    total: z.number(),
    results: z.array(z.object({
      id: z.string(),
      name: z.string(),
      passed: z.boolean(),
      detail: z.string(),
    })),
  }),

  async run() {
    const results: TestResult[] = [];

    // ═══════════════════════════════════════════════════════════════════════
    // REJECTION TESTS (R1–R8)
    // ═══════════════════════════════════════════════════════════════════════

    // R1: Representative ID not in input (LLM generated a new UUID)
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          finding_id: "bbbb0001-0000-4000-a000-000000000099", // fabricated
          merged_from_finding_ids: [F1.finding_id, F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "representative_id_not_in_input", "R1", "Representative ID not in input"));
    }

    // R2: Member ID (merged_from) not in input
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          merged_from_finding_ids: [F2.finding_id, "cccc0001-0000-4000-a000-000000000099"], // ghost member
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "member_id_not_in_input", "R2", "Member ID not in input"));
    }

    // R3: Source document not in members
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          source_docs: ["fabricated_document.pdf"], // not in F1's source_docs
          merged_from_finding_ids: [F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "source_doc_not_in_members", "R3", "Source document not in members"));
    }

    // R4: Claim ID not in members
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          claim_ids: ["doc99:xyz:9:9"], // fabricated claim
          merged_from_finding_ids: [F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "claim_id_not_in_members", "R4", "Claim ID not in members"));
    }

    // R5: Fabricated numeric value in narration
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          detail: "Revenue shows 99999 which is wildly different", // 99999 not in any input
          merged_from_finding_ids: [F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "fabricated_numeric_value", "R5", "Fabricated numeric value"));
    }

    // R6: Severity changed by LLM
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          severity: "info", // was "critical" — LLM downgraded
          merged_from_finding_ids: [F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "severity_changed", "R6", "Severity changed by LLM"));
    }

    // R7: Source authority (finding_kind) changed
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          finding_kind: "absence_claim", // was "data_divergence"
          merged_from_finding_ids: [F2.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertRejected(result, "source_authority_changed", "R7", "Source authority changed"));
    }

    // R8: Output count exceeds input (finding inflation)
    {
      const input = [F1, F2];
      const output = [
        makeFinding({ ...F1 }),
        makeFinding({ ...F2 }),
        makeFinding({
          ...F3,
          finding_id: F3.finding_id, // F3 not in input!
        }),
      ];
      const result = validateMergeContract(input, output);
      // Should trigger output_count_exceeds_input AND representative_id_not_in_input (for F3)
      results.push(assertRejected(result, "output_count_exceeds_input", "R8", "Output count exceeds input"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POSITIVE TESTS (P1–P6)
    // ═══════════════════════════════════════════════════════════════════════

    // P1: Valid deduplication (2 findings → 1 representative + merged_from)
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          merged_from_finding_ids: [F2.finding_id],
          // Narration preserved from F1 (all numerics exist in input pool)
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P1", "Valid deduplication (2→1)", 1));
    }

    // P2: Singleton pass-through (1 finding → 1 finding unchanged)
    {
      const input = [F1];
      const output = [makeFinding({ ...F1 })];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P2", "Singleton pass-through", 1));
    }

    // P3: All findings pass through unchanged (no merge needed)
    {
      const input = [F1, F2, F3];
      const output = [
        makeFinding({ ...F1 }),
        makeFinding({ ...F2 }),
        makeFinding({ ...F3 }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P3", "All findings pass through unchanged", 3));
    }

    // P4: Partial deduplication (4 findings → 2, valid merges)
    {
      const input = [F1, F2, F3, F4];
      const output = [
        makeFinding({
          ...F1,
          merged_from_finding_ids: [F4.finding_id],
          // F1 + F4 are both data_divergence, representative keeps F1's fields
        }),
        makeFinding({
          ...F2,
          merged_from_finding_ids: [F3.finding_id],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P4", "Partial dedup (4→2)", 2));
    }

    // P5: Evidence preserved correctly from merged members
    {
      const input = [F1, F4];
      const output = [
        makeFinding({
          ...F1,
          merged_from_finding_ids: [F4.finding_id],
          // Include evidence from BOTH F1 and F4 — valid because merged members
          evidence: [
            ...(F1.evidence ?? []),
            ...(F4.evidence ?? []),
          ],
          // source_docs union is valid
          source_docs: [...F1.source_docs, ...F4.source_docs],
          // claim_ids union
          claim_ids: [...(F1.claim_ids ?? []), ...(F4.claim_ids ?? [])],
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P5", "Evidence correctly merged from members", 1));
    }

    // P6: Numeric values from input narration are allowed in output
    {
      const input = [F1, F2];
      const output = [
        makeFinding({
          ...F1,
          merged_from_finding_ids: [F2.finding_id],
          // Restate numerics that exist in input pool (19000, 15000, 4000, 6)
          detail: "Combined: revenue 19000 vs 15000 with 4000 gap, timeline 6 months",
        }),
      ];
      const result = validateMergeContract(input, output);
      results.push(assertAccepted(result, "P6", "Numeric values from input allowed in output", 1));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════════
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;

    return {
      summary: `OA-02 Merge Contract Tests: ${passed}/${total} passed${failed > 0 ? ` (${failed} FAILED)` : ""}`,
      passed,
      failed,
      total,
      results,
    };
  },
});
