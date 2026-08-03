/**
 * MAT-F01 Integration Tests — Production Orchestration Paths
 *
 * These tests exercise the ACTUAL production functions:
 *   - fromLegacyClaim / buildQualitativeClaim (canonical extraction path)
 *   - classifyClaimLinkage with canonicalLedger (admission gate)
 *   - generateCanonicalClaimId (atomic identity stability)
 *
 * Required by MAT-F01 completion standard:
 *   1. Real production extraction persists both quant + qual canonical claims
 *   2. Real claimless candidate is rejected at production admission boundary
 *   3. Fresh-versus-resume produces identical claim IDs
 *   4. Revenue and cash EBITDA from same sentence receive different stable IDs
 *
 * Uses the same test harness pattern as q2-claims-ledger.test.ts (custom assertions,
 * no external test runner dependency).
 */

import {
  type CanonicalIcClaim,
  fromLegacyClaim,
  buildQualitativeClaim,
  buildClaimLedger,
  generateCanonicalClaimId,
} from "../canonical-ic-claim.js";
import {
  classifyClaimLinkage,
  buildCanonicalLedgerFromCheckpoint,
} from "../claim-linkage.js";

// ---------------------------------------------------------------------------
// Assertion helpers (same pattern as existing test files)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertNotEqual<T>(actual: T, unexpected: T, label: string): void {
  if (actual !== unexpected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    must NOT equal: ${JSON.stringify(unexpected)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

function assertContains(str: string | null | undefined, substr: string, label: string): void {
  if (str && str.includes(substr)) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    expected to contain: "${substr}"`);
    console.log(`    actual: "${str}"`);
  }
}

function assertMatch(str: string, regex: RegExp, label: string): void {
  if (regex.test(str)) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    expected to match: ${regex}`);
    console.log(`    actual: "${str}"`);
  }
}

function assertNull(value: unknown, label: string): void {
  if (value === null || value === undefined) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    expected null/undefined, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures — real IC memo content
// ---------------------------------------------------------------------------

const IC_MEMO_SOURCE_TEXT = `
Investment Committee Paper — SCG Group — 3rd IC Review

Page 12: Financial Projections

The management case projects that SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26, representing 8% year-on-year growth driven by the organic revenue trajectory and contribution from the four completed bolt-on acquisitions.

Page 15: Strategic Thesis

The fund thesis acknowledges the inherent execution risk in the M&A pipeline. Organic growth alone is not sufficient to support the return case; the fund's thesis depends on the M&A pipeline delivering at least £15m incremental EBITDA by FY28. Three active targets in the pipeline are at varying stages of exclusivity.
`;

const DOCUMENT_ID = "test-doc-01026268-c2ff-44e8-8650-5b8570fc8ea3";
const DOCUMENT_NAME = "SCG 3rd IC Memo.pdf";
const MEMO_VERSION = "3rd_ic";

// ---------------------------------------------------------------------------
// TEST 1: Production extraction persists quantitative + qualitative canonical claims
// ---------------------------------------------------------------------------

function testProductionExtraction(): void {
  console.log("\n═══ TEST 1: Production Extraction → Canonical Claims ═══");

  console.log("\n  [1a] Quantitative claims with source validation:");

  const revenueClaim = fromLegacyClaim({
    legacyClaim: {
      metric: "revenue",
      scope_qualifier: "Total Group Revenue",
      period: "FY Mar-26",
      value: 194,
      unit: "£m",
      basis_note: "management case projection",
      source_doc: DOCUMENT_NAME,
      source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  const ebitdaClaim = fromLegacyClaim({
    legacyClaim: {
      metric: "EBITDA",
      scope_qualifier: "Cash EBITDA",
      period: "FY Mar-26",
      value: 57,
      unit: "£m",
      basis_note: "management case cash EBITDA projection",
      source_doc: DOCUMENT_NAME,
      source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  assertEqual(revenueClaim.schema_version, "ic-claim-v1", "Revenue claim schema version");
  assertEqual(revenueClaim.claim_type, "quantitative", "Revenue claim type");
  assertTrue(revenueClaim.source_validation.exact_text_found, "Revenue source text found");
  assertTrue(revenueClaim.source_validation.coordinate_valid, "Revenue coordinate valid");
  assertEqual(revenueClaim.proposition.metric, "revenue", "Revenue metric");
  assertEqual(revenueClaim.proposition.stated_value, 194, "Revenue stated value");
  assertEqual(revenueClaim.proposition.period, "FY Mar-26", "Revenue period");

  assertEqual(ebitdaClaim.schema_version, "ic-claim-v1", "EBITDA claim schema version");
  assertEqual(ebitdaClaim.claim_type, "quantitative", "EBITDA claim type");
  assertTrue(ebitdaClaim.source_validation.exact_text_found, "EBITDA source text found");
  assertEqual(ebitdaClaim.proposition.metric, "EBITDA", "EBITDA metric");
  assertEqual(ebitdaClaim.proposition.stated_value, 57, "EBITDA stated value");

  // Ledger dedup
  const ledger = buildClaimLedger([revenueClaim, ebitdaClaim]);
  assertEqual(ledger.claims.length, 2, "Ledger contains 2 claims");
  assertEqual(ledger.claimMap.size, 2, "ClaimMap has 2 entries");

  console.log("\n  [1b] Qualitative claims with source validation:");

  const qualClaim = buildQualitativeClaim({
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    page_or_slide: 15,
    section: "Strategic Thesis",
    exact_claim_text: "Organic growth alone is not sufficient to support the return case; the fund's thesis depends on the M&A pipeline delivering at least £15m incremental EBITDA by FY28.",
    entity: "SCG",
    segment: null,
    qualitative_proposition: "Deleveraging and returns depend on future M&A pipeline execution, not organic growth alone",
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  assertEqual(qualClaim.schema_version, "ic-claim-v1", "Qual claim schema version");
  assertEqual(qualClaim.claim_type, "qualitative", "Qual claim type");
  assertTrue(qualClaim.source_validation.exact_text_found, "Qual source text found");
  assertTrue(qualClaim.source_validation.coordinate_valid, "Qual coordinate valid");
  assertContains(qualClaim.proposition.qualitative_proposition!, "M&A pipeline", "Qual proposition content");
  assertNull(qualClaim.proposition.metric, "Qual metric is null");
  assertNull(qualClaim.proposition.stated_value, "Qual stated_value is null");
  assertMatch(qualClaim.claim_id, /^ic-v1-[a-f0-9]{32}$/, "Qual claim ID format");
}

// ---------------------------------------------------------------------------
// TEST 2: Claimless candidate rejected at production admission boundary
// ---------------------------------------------------------------------------

function testAdmissionBoundary(): void {
  console.log("\n═══ TEST 2: Production Admission Boundary ═══");

  // Build canonical ledger with one real claim
  const revClaim = fromLegacyClaim({
    legacyClaim: {
      metric: "revenue",
      scope_qualifier: "Total Group Revenue",
      period: "FY Mar-26",
      value: 194,
      unit: "£m",
      basis_note: "projection",
      source_doc: DOCUMENT_NAME,
      source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  const canonicalLedger = buildClaimLedger([revClaim]);

  console.log("\n  [2a] Claimless diligence passage rejected:");

  // A finding from FDD with no claim_id — pure diligence passage
  const rejectedResult = classifyClaimLinkage(
    {
      finding_id: "finding-no-claim-001",
      corpus_index: 0,
      title: "Revenue growth deceleration observed in FDD appendix",
      detail: "The FDD appendix shows revenue growth slowing from 12% to 6%",
      severity: "moderate",
      source_tag: "consultant_report",
      source_docs: ["PwC FDD Report.pdf"],
      originating_claim_id: null,
      claim_ids: null,
      claim_type: null,
      finding_kind: "data_divergence",
      evidence: null,
      doc_filename: "PwC FDD Report.pdf",
      doc_type: "fdd",
    },
    new Map(), // empty legacy claim map
    undefined,
    canonicalLedger, // MAT-F01 admission gate
  );

  assertEqual(rejectedResult.q4_eligible, false, "Claimless candidate not Q4 eligible");
  assertEqual(rejectedResult.claim_linkage_disposition, "not_linked_to_IC_claim", "Disposition: not_linked");
  assertContains(rejectedResult.reason, "claim", "Reason mentions claim");

  console.log("\n  [2b] Candidate with valid canonical claim_id admitted:");

  const validClaimId = revClaim.claim_id;

  const admittedResult = classifyClaimLinkage(
    {
      finding_id: "finding-with-claim-001",
      corpus_index: 1,
      title: "Revenue projection contradicted by financial model",
      detail: "Model shows £178m vs IC memo £194m",
      severity: "high",
      source_tag: "financial_model",
      source_docs: ["SCG Model v3.xlsx"],
      originating_claim_id: validClaimId,
      claim_ids: [validClaimId],
      claim_type: "operating_metric",
      finding_kind: "data_divergence",
      evidence: null,
      doc_filename: "SCG Model v3.xlsx",
      doc_type: null,
    },
    new Map([[validClaimId, {
      claim_id: validClaimId,
      verbatim_snippet: revClaim.exact_claim_text,
      metric: "revenue",
      period: "FY Mar-26",
      scope_qualifier: "Total Group Revenue",
      claim_category: "operating_metric",
      source_doc: DOCUMENT_NAME,
      source_page: "12",
      ic_document_id: DOCUMENT_ID,
      ic_document_filename: DOCUMENT_NAME,
      memo_version: MEMO_VERSION,
    }]]),
    undefined,
    canonicalLedger,
  );

  // Must pass the canonical gate
  assertNotEqual(admittedResult.claim_linkage_disposition, "not_linked_to_IC_claim" as any, "Admitted candidate not 'not_linked'");
  assertNotEqual(admittedResult.claim_linkage_disposition, "invalid_or_unresolved_claim_reference" as any, "Admitted candidate not 'invalid_reference'");
}

// ---------------------------------------------------------------------------
// TEST 3: Fresh-versus-resume produces identical claim IDs
// ---------------------------------------------------------------------------

function testFreshVsResumeIdentity(): void {
  console.log("\n═══ TEST 3: Fresh vs Resume Identity Stability ═══");

  // Run 1 (fresh)
  const run1Revenue = fromLegacyClaim({
    legacyClaim: {
      metric: "revenue", scope_qualifier: "Total Group Revenue", period: "FY Mar-26",
      value: 194, unit: "£m", basis_note: "projection",
      source_doc: DOCUMENT_NAME, source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  const run1Qual = buildQualitativeClaim({
    document_id: DOCUMENT_ID, document_name: DOCUMENT_NAME, memo_version: MEMO_VERSION,
    page_or_slide: 15,
    exact_claim_text: "Organic growth alone is not sufficient to support the return case; the fund's thesis depends on the M&A pipeline delivering at least £15m incremental EBITDA by FY28.",
    entity: "SCG", segment: null,
    qualitative_proposition: "Deleveraging and returns depend on future M&A pipeline execution, not organic growth alone",
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  // Run 2 (resume — identical inputs)
  const run2Revenue = fromLegacyClaim({
    legacyClaim: {
      metric: "revenue", scope_qualifier: "Total Group Revenue", period: "FY Mar-26",
      value: 194, unit: "£m", basis_note: "projection",
      source_doc: DOCUMENT_NAME, source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID,
    document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION,
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  const run2Qual = buildQualitativeClaim({
    document_id: DOCUMENT_ID, document_name: DOCUMENT_NAME, memo_version: MEMO_VERSION,
    page_or_slide: 15,
    exact_claim_text: "Organic growth alone is not sufficient to support the return case; the fund's thesis depends on the M&A pipeline delivering at least £15m incremental EBITDA by FY28.",
    entity: "SCG", segment: null,
    qualitative_proposition: "Deleveraging and returns depend on future M&A pipeline execution, not organic growth alone",
    source_text: IC_MEMO_SOURCE_TEXT,
  });

  assertEqual(run1Revenue.claim_id, run2Revenue.claim_id, "Revenue claim ID stable across runs");
  assertEqual(run1Qual.claim_id, run2Qual.claim_id, "Qual claim ID stable across runs");
  assertEqual(run1Revenue.exact_claim_text, run2Revenue.exact_claim_text, "Revenue exact_text stable");
  assertEqual(run1Qual.exact_claim_text, run2Qual.exact_claim_text, "Qual exact_text stable");
  assertEqual(run1Revenue.source_validation.exact_text_found, run2Revenue.source_validation.exact_text_found, "Revenue source_validation stable");
  assertEqual(run1Qual.source_validation.exact_text_found, run2Qual.source_validation.exact_text_found, "Qual source_validation stable");

  // Ledger dedup produces same count and IDs
  const ledger1 = buildClaimLedger([run1Revenue, run1Qual]);
  const ledger2 = buildClaimLedger([run2Revenue, run2Qual]);
  assertEqual(ledger1.claims.length, ledger2.claims.length, "Ledger sizes match");

  const ids1 = ledger1.claims.map(c => c.claim_id).sort().join(",");
  const ids2 = ledger2.claims.map(c => c.claim_id).sort().join(",");
  assertEqual(ids1, ids2, "Sorted claim IDs are identical");
}

// ---------------------------------------------------------------------------
// TEST 4: Revenue and cash EBITDA from same sentence get different stable IDs
// ---------------------------------------------------------------------------

function testAtomicClaimIdentity(): void {
  console.log("\n═══ TEST 4: Atomic Claim Identity — Same Sentence, Different Metrics ═══");

  const revenueClaim = fromLegacyClaim({
    legacyClaim: {
      metric: "revenue", scope_qualifier: "Total Group Revenue", period: "FY Mar-26",
      value: 194, unit: "£m", basis_note: "projection",
      source_doc: DOCUMENT_NAME, source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID, document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION, source_text: IC_MEMO_SOURCE_TEXT,
  });

  const ebitdaClaim = fromLegacyClaim({
    legacyClaim: {
      metric: "EBITDA", scope_qualifier: "Cash EBITDA", period: "FY Mar-26",
      value: 57, unit: "£m", basis_note: "projection",
      source_doc: DOCUMENT_NAME, source_page: "12",
      verbatim_snippet: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
      claim_category: "operating_metric",
    },
    document_id: DOCUMENT_ID, document_name: DOCUMENT_NAME,
    memo_version: MEMO_VERSION, source_text: IC_MEMO_SOURCE_TEXT,
  });

  // CRITICAL: same source sentence, same page → DIFFERENT claim IDs
  assertNotEqual(revenueClaim.claim_id, ebitdaClaim.claim_id, "Revenue ≠ EBITDA claim ID");

  // Both have ic-v1 format
  assertMatch(revenueClaim.claim_id, /^ic-v1-[a-f0-9]{32}$/, "Revenue claim ID format");
  assertMatch(ebitdaClaim.claim_id, /^ic-v1-[a-f0-9]{32}$/, "EBITDA claim ID format");

  // Both share source text
  assertEqual(revenueClaim.exact_claim_text, ebitdaClaim.exact_claim_text, "Same source sentence");
  assertEqual(revenueClaim.source.page_or_slide, ebitdaClaim.source.page_or_slide, "Same page");

  // Differ in proposition
  assertEqual(revenueClaim.proposition.metric, "revenue", "Revenue metric correct");
  assertEqual(ebitdaClaim.proposition.metric, "EBITDA", "EBITDA metric correct");
  assertEqual(revenueClaim.proposition.stated_value, 194, "Revenue value");
  assertEqual(ebitdaClaim.proposition.stated_value, 57, "EBITDA value");

  // Re-derivation produces same IDs (stability)
  const revenueId2 = generateCanonicalClaimId({
    document_id: DOCUMENT_ID,
    memo_version: MEMO_VERSION,
    exact_claim_text: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
    page_or_slide: "12",
    claim_type: "quantitative",
    proposition_key: "revenue",
    scope: "Total Group Revenue",
    stated_value: 194,
    unit_key: "£m/GBP/millions",
  });
  assertEqual(revenueClaim.claim_id, revenueId2, "Revenue ID stable on re-derivation");

  const ebitdaId2 = generateCanonicalClaimId({
    document_id: DOCUMENT_ID,
    memo_version: MEMO_VERSION,
    exact_claim_text: "SCG is expected to deliver £194m revenue and £57m cash EBITDA for FY Mar-26",
    page_or_slide: "12",
    claim_type: "quantitative",
    proposition_key: "EBITDA",
    scope: "Cash EBITDA",
    stated_value: 57,
    unit_key: "£m/GBP/millions",
  });
  assertEqual(ebitdaClaim.claim_id, ebitdaId2, "EBITDA ID stable on re-derivation");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

export function runMatF01IntegrationTests(): { passed: number; failed: number } {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║   MAT-F01 Integration Tests — Production Orchestration   ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");

  passed = 0;
  failed = 0;

  testProductionExtraction();
  testAdmissionBoundary();
  testFreshVsResumeIdentity();
  testAtomicClaimIdentity();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed === 0) {
    console.log("  ✅ ALL MAT-F01 INTEGRATION TESTS PASSED");
  } else {
    console.log("  ❌ SOME TESTS FAILED");
  }
  console.log(`${"─".repeat(60)}\n`);

  return { passed, failed };
}
