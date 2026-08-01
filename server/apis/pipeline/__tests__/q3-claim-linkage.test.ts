/**
 * Q3 Claim-Linkage Regression Tests
 *
 * Tests proving:
 * 1. Adverse FDD observation with no IC claim → not_linked_to_IC_claim
 * 2. IC claim contradicted by live model → claim_linked_contradiction
 * 3. IC claim partially supported by CDD → claim_linked_partial_support
 * 4. Missing evidence → claim_linked_unverifiable
 * 5. Wrong evidence source → evidence_authority_valid = false
 * 6. Same evidence supporting two distinct claims → retained separately
 * 7. Same claim in several memo versions → one normalized claim with chronology
 * 8. All candidates receive exactly one disposition (no silent loss)
 * 9. Deterministic repeated replay
 * 10. No input mutation
 *
 * Uses the SHARED claim-linkage.ts module — no mirrored logic.
 */

import {
  classifyClaimLinkage,
  isEvidenceSourceAuthoritative,
  verdictToLinkageDisposition,
  type QualitativeClaim,
  type ClaimLinkageResult,
  QUALITATIVE_CLAIM_TYPES,
  CLAIM_VERDICTS,
} from "../claim-linkage.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  assertEqual(condition, true, label);
}

// ===========================================================================
// TEST CASES
// ===========================================================================

console.log("═".repeat(60));
console.log("Q3 Claim-Linkage Regression Tests");
console.log("═".repeat(60));

// ---------------------------------------------------------------------------
// Test 1: Adverse FDD observation with no IC claim → not a contradiction
// ---------------------------------------------------------------------------
console.log("\n=== Test 1: FDD observation without IC claim ===");

const fddObservation = classifyClaimLinkage({
  finding_id: "fdd-1",
  corpus_index: 0,
  title: "Revenue growth deceleration observed in FDD",
  source_tag: "consultant_report",
  source_docs: ["Vendor FDD Report.pdf"],
  originating_claim_id: null,
  claim_ids: null,
}, null);

assertEqual(fddObservation.claim_linkage_disposition, "not_linked_to_IC_claim",
  "FDD observation without IC claim is not linked");
assertTrue(fddObservation.reason.includes("FDD/CDD"),
  "Reason mentions FDD/CDD standalone observation");

// ---------------------------------------------------------------------------
// Test 2: IC claim contradicted by live model → contradiction
// ---------------------------------------------------------------------------
console.log("\n=== Test 2: IC claim contradicted by model ===");

const modelContradiction = classifyClaimLinkage(
  {
    finding_id: "model-c-1",
    corpus_index: 5,
    title: "FY26 Revenue forecast contradicted by current model",
    source_tag: "financial_model",
    source_docs: ["Operating Model v3.xlsx"],
    originating_claim_id: "claim-123",
    claim_ids: ["claim-123"],
    severity: "warning",
  },
  {
    originating_claim_id: "claim-123",
    claim_text: "Revenue will reach £45m in FY26",
    claim_type: "growth_quality",
    ic_source_document: "IC Memo v3.pdf",
    ic_source_location: "page 4, paragraph 2",
    memo_version: "v3",
    normalized_claim: "revenue FY26 £45m",
    verification_source: "Operating Model v3.xlsx",
    verification_evidence: "Model shows £42m revenue for FY26",
    comparison_performed: "Direct comparison: memo claims £45m, model shows £42m",
    verdict: "contradicted",
  }
);

assertEqual(modelContradiction.claim_linkage_disposition, "claim_linked_contradiction",
  "IC claim contradicted by model is classified as contradiction");
assertTrue(modelContradiction.originating_claim !== null,
  "Has resolved originating claim");
assertEqual(modelContradiction.originating_claim!.verdict, "contradicted",
  "Verdict is contradicted");

// ---------------------------------------------------------------------------
// Test 3: IC claim partially supported by CDD → partial support
// ---------------------------------------------------------------------------
console.log("\n=== Test 3: IC claim partially supported ===");

const partialSupport = classifyClaimLinkage(
  {
    finding_id: "partial-1",
    corpus_index: 10,
    title: "Customer retention claim partially supported by CDD",
    source_tag: "consultant_report",
    originating_claim_id: "claim-456",
    claim_ids: ["claim-456"],
  },
  {
    originating_claim_id: "claim-456",
    claim_text: "Customer retention above 95%",
    claim_type: "retention_and_churn",
    ic_source_document: "IC Memo v2.pdf",
    ic_source_location: "page 7",
    memo_version: "v2",
    normalized_claim: "customer retention >95%",
    verification_source: "Commercial DD Report.pdf",
    verification_evidence: "Gross retention 93%, net retention 97%",
    comparison_performed: "Gross below threshold but net above",
    verdict: "partially_supported",
  }
);

assertEqual(partialSupport.claim_linkage_disposition, "claim_linked_partial_support",
  "Partial support correctly classified");

// ---------------------------------------------------------------------------
// Test 4: Missing evidence → unverifiable (not invented contradiction)
// ---------------------------------------------------------------------------
console.log("\n=== Test 4: Missing evidence → unverifiable ===");

const missingEvidence = classifyClaimLinkage(
  {
    finding_id: "missing-ev-1",
    corpus_index: 15,
    title: "Downside case resilience claim — no evidence available",
    source_tag: "other",
    originating_claim_id: "claim-789",
    claim_ids: ["claim-789"],
  },
  {
    originating_claim_id: "claim-789",
    claim_text: "Business resilient to 20% revenue downside",
    claim_type: "downside_resilience",
    ic_source_document: "IC Memo v1.pdf",
    ic_source_location: "page 12",
    memo_version: "v1",
    normalized_claim: "downside resilience 20% revenue decline",
    verification_source: null,
    verification_evidence: null,
    comparison_performed: null,
    verdict: "unverifiable",
  }
);

assertEqual(missingEvidence.claim_linkage_disposition, "claim_linked_unverifiable",
  "Missing evidence produces unverifiable, not invented contradiction");

// ---------------------------------------------------------------------------
// Test 5: Wrong evidence source → evidence_authority_valid = false
// ---------------------------------------------------------------------------
console.log("\n=== Test 5: Wrong evidence source rejected ===");

// Growth quality claim verified against legal source (wrong)
assertTrue(!isEvidenceSourceAuthoritative("growth_quality", "legal"),
  "Legal is not authoritative for growth_quality claims");
assertTrue(isEvidenceSourceAuthoritative("growth_quality", "financial_model"),
  "Financial model IS authoritative for growth_quality claims");
assertTrue(!isEvidenceSourceAuthoritative("retention_and_churn", "ic_memo"),
  "IC memo is not authoritative for retention claims");
assertTrue(isEvidenceSourceAuthoritative("retention_and_churn", "consultant_report"),
  "Consultant report IS authoritative for retention claims");

// ---------------------------------------------------------------------------
// Test 6: Same evidence supporting two distinct claims → retained separately
// ---------------------------------------------------------------------------
console.log("\n=== Test 6: Distinct claims retained separately ===");

const claim1 = classifyClaimLinkage(
  { finding_id: "f-a", corpus_index: 20, title: "Revenue claim", originating_claim_id: "c1", source_tag: "financial_model" },
  { originating_claim_id: "c1", claim_text: "Revenue £45m", claim_type: "growth_quality", ic_source_document: "IC Memo.pdf", ic_source_location: "p4", memo_version: "v3", normalized_claim: "revenue £45m FY26", verification_source: "Model.xlsx", verification_evidence: "Shows £42m", comparison_performed: "Direct", verdict: "contradicted" }
);
const claim2 = classifyClaimLinkage(
  { finding_id: "f-b", corpus_index: 21, title: "EBITDA claim", originating_claim_id: "c2", source_tag: "financial_model" },
  { originating_claim_id: "c2", claim_text: "EBITDA £12m", claim_type: "growth_quality", ic_source_document: "IC Memo.pdf", ic_source_location: "p5", memo_version: "v3", normalized_claim: "EBITDA £12m FY26", verification_source: "Model.xlsx", verification_evidence: "Shows £10m", comparison_performed: "Direct", verdict: "contradicted" }
);

assertTrue(claim1.finding_id !== claim2.finding_id, "Two findings with same source retained separately");
assertEqual(claim1.claim_linkage_disposition, "claim_linked_contradiction", "First claim linked");
assertEqual(claim2.claim_linkage_disposition, "claim_linked_contradiction", "Second claim linked");

// ---------------------------------------------------------------------------
// Test 7: Same claim in several memo versions → uses latest normalized form
// ---------------------------------------------------------------------------
console.log("\n=== Test 7: Multiple memo versions → normalized ===");

const v2Claim = classifyClaimLinkage(
  { finding_id: "f-v2", corpus_index: 30, title: "Revenue from v2", originating_claim_id: "c-rev", source_tag: "financial_model" },
  { originating_claim_id: "c-rev", claim_text: "Revenue £44m FY26", claim_type: "growth_quality", ic_source_document: "IC Memo v2.pdf", ic_source_location: "p3", memo_version: "v2", normalized_claim: "revenue FY26 group", verification_source: "Model.xlsx", verification_evidence: "£42m", comparison_performed: "compare", verdict: "contradicted" }
);
const v3Claim = classifyClaimLinkage(
  { finding_id: "f-v3", corpus_index: 31, title: "Revenue from v3", originating_claim_id: "c-rev", source_tag: "financial_model" },
  { originating_claim_id: "c-rev", claim_text: "Revenue £45m FY26", claim_type: "growth_quality", ic_source_document: "IC Memo v3.pdf", ic_source_location: "p4", memo_version: "v3", normalized_claim: "revenue FY26 group", verification_source: "Model.xlsx", verification_evidence: "£42m", comparison_performed: "compare", verdict: "contradicted" }
);

assertEqual(v2Claim.originating_claim!.normalized_claim, v3Claim.originating_claim!.normalized_claim,
  "Same normalized claim across memo versions");
assertTrue(v2Claim.originating_claim!.memo_version !== v3Claim.originating_claim!.memo_version,
  "Different memo versions tracked");

// ---------------------------------------------------------------------------
// Test 8: All candidates receive exactly one disposition
// ---------------------------------------------------------------------------
console.log("\n=== Test 8: No silent losses ===");

const batch = Array.from({ length: 20 }, (_, i) => ({
  finding_id: `batch-${i}`,
  corpus_index: i,
  title: `Finding ${i}`,
  source_tag: i % 2 === 0 ? "consultant_report" : "financial_model",
}));

const batchResults = batch.map(f => classifyClaimLinkage(f, null));
assertEqual(batchResults.length, 20, "20 inputs → 20 results");
assertTrue(batchResults.every(r => r.claim_linkage_disposition !== undefined),
  "Every result has a disposition");

// ---------------------------------------------------------------------------
// Test 9: Deterministic repeated replay
// ---------------------------------------------------------------------------
console.log("\n=== Test 9: Deterministic ===");

const run1 = batch.map(f => classifyClaimLinkage(f, null));
const run2 = batch.map(f => classifyClaimLinkage(f, null));
assertEqual(JSON.stringify(run1), JSON.stringify(run2), "Two runs produce identical output");

// ---------------------------------------------------------------------------
// Test 10: No input mutation
// ---------------------------------------------------------------------------
console.log("\n=== Test 10: Input immutability ===");

const immutableInput = { finding_id: "imm-1", corpus_index: 0, title: "Test", source_tag: "other" as const };
const frozen = JSON.stringify(immutableInput);
classifyClaimLinkage(immutableInput, null);
assertEqual(JSON.stringify(immutableInput), frozen, "Input not mutated");

// ---------------------------------------------------------------------------
// Test: verdictToLinkageDisposition covers all verdicts
// ---------------------------------------------------------------------------
console.log("\n=== Test: Verdict → Disposition mapping ===");

assertEqual(verdictToLinkageDisposition("contradicted"), "claim_linked_contradiction", "contradicted → contradiction");
assertEqual(verdictToLinkageDisposition("partially_supported"), "claim_linked_partial_support", "partially_supported → partial");
assertEqual(verdictToLinkageDisposition("unsupported"), "claim_linked_unsupported", "unsupported → unsupported");
assertEqual(verdictToLinkageDisposition("materially_changed"), "claim_linked_material_change", "materially_changed → material_change");
assertEqual(verdictToLinkageDisposition("unverifiable"), "claim_linked_unverifiable", "unverifiable → unverifiable");
assertEqual(verdictToLinkageDisposition("confirmed"), "claim_linked_confirmed", "confirmed → confirmed");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(60)}`);
console.log(`Q3 Claim-Linkage Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("All Q3 claim-linkage regression tests passed ✓");
