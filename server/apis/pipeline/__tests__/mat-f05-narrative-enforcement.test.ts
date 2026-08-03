/**
 * MAT-F05 Integration: Narrative Enforcement Production-Path Tests
 *
 * These 10 tests exercise `enforceNarrativeBoundary()` — the actual production
 * function called by merge-findings.ts, complete-merge-tree.ts, and
 * finalize-pipeline-output.ts.
 *
 * Parent revision must FAIL tests 1, 2, 3, 6, 9.
 * Current revision must PASS all 10.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f05-narrative-enforcement.test.ts
 */

import { enforceNarrativeBoundary } from "../narrative-enforcement.js";
import type { CanonicalFinding } from "../canonical-finding.js";
import type { CanonicalFindingRecord } from "../canonical-finding-record.js";

// ===========================================================================
// Test harness
// ===========================================================================

let passed = 0;
let failed = 0;

function assertTrue(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

// ===========================================================================
// Shared Fixtures
// ===========================================================================

/**
 * Canonical F04 record for the SCG £194m revenue finding.
 * Provides the authority against which LLM narratives are validated.
 */
const SCG_CANONICAL_RECORD: CanonicalFindingRecord = {
  schema_version: "canonical-finding-v1" as any,
  identity: {
    finding_id: "cfr-v1-abc123def456",
    proposition_key: "SCG|revenue|FY_Mar-26|memo_claim__current_model",
    semantic_hash: "sha256-test-scg-revenue",
    identity_version: "identity-v1.0" as any,
  },
  claim: {
    claim_id: "clm-v1-scg-revenue-194m",
    verbatim_snippet: "Management projects FY Mar-26 revenue of £194m for the group",
    metric: "revenue",
    period: "FY Mar-26",
    entity_or_segment: "SCG",
    value: 194_000_000,
    unit: "GBP_millions",
    source_document_id: "doc-ic-memo-01",
    source_document_name: "IC_Memo_v3.pdf",
    extraction_id: "ext-001",
  },
  evidence: [
    {
      evidence_id: "ev-001",
      source_document_id: "doc-financial-model",
      source_document_name: "SCG_Financial_Model_v3.xlsx",
      evidence_role: "contradicting",
      authority_class: "current_financial_model",
      target_entity: "SCG",
      target_segment: null,
      coordinate: { type: "cell", label: "P&L/B12", sheet: "P&L", cell: "B12" } as any,
      canonical_record: {
        proposition: {
          value: 184_391_535,
          unit: "GBP",
          period: "FY Mar-26",
          description: "Total revenue",
        },
        coordinate: {
          kind: "workbook" as const,
          sheet: "P&L",
          cell_or_range: "B12",
          displayed_value: 184_391_535,
        },
      },
    },
  ],
  comparisons: [
    {
      claim_comparison_basis: "memo_claim__current_model",
      evidence_comparison_basis: "current_financial_model",
      compatibility: { allowed: true, reason: "same_metric_same_period" },
      calculation: {
        normalized_claim_value: 194_000_000,
        normalized_fact_value: 184_391_535,
        signed_delta: -9_608_465,
        percentage_delta: -4.95,
        direction: "claim_higher",
      },
    },
  ],
  disposition: {
    verdict: "contradicted" as any,
    reportable: true,
    reason_codes: ["numeric_divergence_above_threshold"],
    rule_version: "disposition-v1.0",
  },
} as any;

/** Build canonical record map keyed by claim_id */
function buildCanonicalMap(): Map<string, CanonicalFindingRecord> {
  const map = new Map<string, CanonicalFindingRecord>();
  map.set("clm-v1-scg-revenue-194m", SCG_CANONICAL_RECORD);
  return map;
}

/** Build a finding linked to the SCG canonical record */
function buildLinkedFinding(overrides?: Partial<CanonicalFinding>): CanonicalFinding {
  return {
    finding_id: "f-test-linked-001",
    severity: "critical",
    title: "Revenue Projection Variance",
    detail: "The IC memo states £194m of FY Mar-26 revenue. The current model records £184.4m at P&L/B12.",
    full_analysis: "The IC memo projects group revenue of £194m for FY Mar-26. The current financial model (SCG_Financial_Model_v3.xlsx) shows £184,391,535 in cell B12. This is a shortfall of approximately £9.6m (−4.95%). The deterministic verdict is contradicted.",
    source_docs: ["SCG_Financial_Model_v3.xlsx"],
    claim_ids: ["clm-v1-scg-revenue-194m"],
    ...overrides,
  };
}

/** Build a finding NOT linked to any canonical record */
function buildUnlinkedFinding(overrides?: Partial<CanonicalFinding>): CanonicalFinding {
  return {
    finding_id: "f-test-unlinked-001",
    severity: "critical",
    title: "Revenue Risk Assessment",
    detail: "Revenue targets appear ambitious.",
    full_analysis: "Based on market conditions, revenue targets appear ambitious.",
    source_docs: ["Market_Report.pdf"],
    claim_ids: ["clm-v1-no-match-xyz"],
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

console.log("\n=== MAT-F05 Integration: Narrative Enforcement Tests ===\n");

// ── Test 1: Invented £195m is absent from final persisted narrative ─────────
console.log("Test 1 — invented £195m absent from final persisted narrative");
{
  const finding = buildLinkedFinding({
    title: "Revenue Variance",
    detail: "The IC memo states £195m of revenue, while the model shows £180m.",
    full_analysis: "Revenue is £195m in the memo but only £180m in the model, a major shortfall.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  // £195m and £180m are invented — must not appear in output narrative
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    assertTrue(!outputFinding.detail.includes("195m"), "detail does not contain invented £195m");
    assertTrue(!outputFinding.detail.includes("180m"), "detail does not contain invented £180m");
    assertTrue(!(outputFinding.full_analysis || "").includes("195m"), "full_analysis does not contain £195m");
  }
}

// ── Test 2: Invented 5–15pp range absent from final persisted narrative ─────
console.log("\nTest 2 — invented 5–15pp range absent from final persisted narrative");
{
  const finding = buildLinkedFinding({
    title: "Revenue Shortfall",
    detail: "The variance is 5-15 percentage points below expectation.",
    full_analysis: "Revenue is 5-15 percentage points below projection, indicating significant risk.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    assertTrue(!outputFinding.detail.includes("5-15"), "detail does not contain invented 5-15pp range");
    assertTrue(!(outputFinding.full_analysis || "").includes("5-15"), "full_analysis does not contain 5-15pp range");
  }
}

// ── Test 3: Synthesized quotation absent from final persisted narrative ─────
console.log("\nTest 3 — synthesized quotation absent from final persisted narrative");
{
  const finding = buildLinkedFinding({
    title: "Revenue Statement",
    detail: 'The IC memo states \u201cManagement expects strong revenue growth to reach approximately £194m in FY Mar-26\u201d.',
    full_analysis: 'The memo says \u201cManagement expects strong revenue growth to reach approximately £194m in FY Mar-26\u201d which is an overstatement.',
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    assertTrue(!outputFinding.detail.includes("expects strong revenue growth"), "detail does not contain synthesized quotation");
    assertTrue(!(outputFinding.full_analysis || "").includes("expects strong revenue growth"), "full_analysis does not contain synthesized quotation");
  }
}

// ── Test 4: Unsupported Gamma-to-SCG EBITDA implication absent ─────────────
console.log("\nTest 4 — unsupported Gamma-to-SCG EBITDA implication absent");
{
  const finding = buildLinkedFinding({
    title: "Revenue Comparison",
    detail: "Gamma Holdings Ltd revenue demonstrates that SCG EBITDA is materially overstated.",
    full_analysis: "Based on Gamma Holdings Ltd comparables, the SCG EBITDA projection of £194m is materially overstated.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    assertTrue(!outputFinding.detail.includes("Gamma Holdings"), "detail does not contain unknown entity Gamma Holdings");
    assertTrue(!(outputFinding.full_analysis || "").includes("Gamma Holdings"), "full_analysis does not contain Gamma Holdings");
  }
}

// ── Test 5: LLM "confirmed" cannot override contradicted canonical verdict ──
console.log("\nTest 5 — LLM 'confirmed' cannot override contradicted canonical verdict");
{
  const finding = buildLinkedFinding({
    title: "Revenue Confirmed",
    detail: "The model confirms the IC memo revenue of £194m.",
    full_analysis: "After analysis, the figure is confirmed by the current financial model.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    // Narrative was rejected (verdict contradiction) → replaced with fallback
    assertTrue(!outputFinding.detail.includes("confirms"), "detail does not contain 'confirms'");
    assertTrue(!(outputFinding.full_analysis || "").includes("confirmed by the current"), "full_analysis does not contain 'confirmed by the current'");
    // Fallback must reference actual verdict
    assertTrue((outputFinding.full_analysis || "").includes("contradicted"), "fallback references canonical verdict 'contradicted'");
  }
}

// ── Test 6: Invalid output replaced with deterministic fallback text ───────
console.log("\nTest 6 — invalid output replaced with deterministic fallback text");
{
  const finding = buildLinkedFinding({
    title: "Revenue Issue",
    detail: "The variance is approximately 12.3% below target, indicating a £15m gap.",
    full_analysis: "Revenue is 12.3% below projection with a £15m gap, which is critical.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    // 12.3% and £15m are invented → must be replaced with fallback
    assertTrue(!outputFinding.detail.includes("12.3%"), "invented 12.3% absent from final detail");
    assertTrue(!outputFinding.detail.includes("£15m"), "invented £15m absent from final detail");
    // Fallback references canonical verdict
    assertTrue((outputFinding.full_analysis || "").includes("contradicted"), "fallback references canonical verdict");
  }
  // Check diagnostic
  const diag = result.diagnostics.find(d => d.finding_id === "f-test-linked-001");
  assertTrue(diag !== undefined, "diagnostic entry exists");
  if (diag) {
    assertEqual(diag.status, "rejected", "diagnostic status is 'rejected'");
  }
}

// ── Test 7: Validation reason codes are persisted ────────────────────────
console.log("\nTest 7 — validation reason codes are persisted");
{
  const finding = buildLinkedFinding({
    title: "Revenue Confirmed",
    detail: "The model confirms £194m. Also, Gamma Holdings shows £250m.",
    full_analysis: "According to FY2028 data and Management_Presentation.pdf, the result is confirmed.",
  });
  const result = enforceNarrativeBoundary([finding], buildCanonicalMap());
  const diag = result.diagnostics.find(d => d.finding_id === "f-test-linked-001");
  assertTrue(diag !== undefined, "diagnostic entry exists");
  if (diag) {
    assertEqual(diag.status, "rejected", "diagnostic status is 'rejected'");
    assertTrue(diag.reason_codes.length > 0, "reason_codes array is not empty");
    // Should contain at least one of: RULE_1, RULE_4, RULE_5, RULE_6, RULE_7
    const hasKnownRule = diag.reason_codes.some(rc =>
      rc.startsWith("RULE_")
    );
    assertTrue(hasKnownRule, "reason_codes contain validator rule references");
  }
}

// ── Test 8: Valid narrative passes unchanged ────────────────────────────
console.log("\nTest 8 — valid narrative passes unchanged");
{
  const validFinding = buildLinkedFinding(); // uses the valid narrative fixture
  const result = enforceNarrativeBoundary([validFinding], buildCanonicalMap());
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-linked-001");
  assertTrue(outputFinding !== undefined, "finding is present in output");
  if (outputFinding) {
    // Title, detail, full_analysis should match original (valid narrative passes through)
    assertTrue(outputFinding.title.includes("Revenue"), "title preserved");
    assertTrue(outputFinding.detail.includes("£194m"), "detail contains canonical value");
    assertTrue((outputFinding.full_analysis || "").includes("184,391,535"), "full_analysis contains canonical evidence value");
  }
  const diag = result.diagnostics.find(d => d.finding_id === "f-test-linked-001");
  if (diag) {
    assertEqual(diag.status, "accepted", "diagnostic status is 'accepted'");
  }
}

// ── Test 9: Finding without F04 canonical record is non-reportable/excluded ─
console.log("\nTest 9 — finding without F04 canonical record is non-reportable");
{
  const unlinkedFinding = buildUnlinkedFinding();
  const result = enforceNarrativeBoundary([unlinkedFinding], buildCanonicalMap());
  
  // The unlinked finding should be demoted to non-reportable
  const diag = result.diagnostics.find(d => d.finding_id === "f-test-unlinked-001");
  assertTrue(diag !== undefined, "diagnostic entry exists for unlinked finding");
  if (diag) {
    assertEqual(diag.status, "no_canonical_record", "diagnostic status is 'no_canonical_record'");
  }

  // If it appears in output, it must be severity=info and marked as housekeeping
  const outputFinding = result.findings.find(f => f.finding_id === "f-test-unlinked-001");
  if (outputFinding) {
    assertEqual(outputFinding.severity, "info", "severity demoted to info");
    assertTrue(outputFinding.title.includes("[Unlinked]"), "title marked as unlinked");
    assertTrue(!outputFinding.detail.includes("Revenue targets appear ambitious"), "original LLM narrative removed");
  } else {
    // Excluded entirely is also acceptable (fail-closed)
    assertTrue(true, "finding excluded from output (fail-closed)");
  }
}

// ── Test 10: Final report markdown contains no rejected narrative text ─────
console.log("\nTest 10 — final report markdown contains no rejected narrative text");
{
  // Simulate a batch with one valid and one invalid finding
  const validFinding = buildLinkedFinding({
    finding_id: "f-valid-001",
  });
  const invalidFinding = buildLinkedFinding({
    finding_id: "f-invalid-001",
    title: "Revenue Gap",
    detail: "The variance is £195m vs £180m, a 12.3% gap.",
    full_analysis: "Revenue of £195m in memo vs £180m in model represents a 12.3% shortfall. According to Management_Presentation.pdf this is critical.",
  });

  const result = enforceNarrativeBoundary([validFinding, invalidFinding], buildCanonicalMap());

  // Build report markdown from output (same as production formatReportMechanical)
  const reportLines: string[] = [];
  for (const f of result.findings) {
    reportLines.push(f.title);
    reportLines.push(f.detail);
    if (f.full_analysis) reportLines.push(f.full_analysis);
  }
  const reportMarkdown = reportLines.join("\n");

  // Rejected text must NOT appear in report
  assertTrue(!reportMarkdown.includes("£195m"), "report does not contain invented £195m");
  assertTrue(!reportMarkdown.includes("£180m"), "report does not contain invented £180m");
  assertTrue(!reportMarkdown.includes("12.3%"), "report does not contain invented 12.3%");
  assertTrue(!reportMarkdown.includes("Management_Presentation.pdf"), "report does not contain unknown source");

  // Valid finding text SHOULD appear
  assertTrue(reportMarkdown.includes("£194m"), "report contains valid canonical value £194m");
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n" + "=".repeat(60));
console.log(`MAT-F05 Integration Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED \u2713");
}
