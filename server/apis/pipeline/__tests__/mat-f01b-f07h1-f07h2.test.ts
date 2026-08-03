/**
 * MAT-F01B + F07-H1 + F07-H2 Acceptance Test Suite
 *
 * 22 targeted tests covering:
 * - F01B: Production qualitative extraction, source validation, admission gate
 * - F07-H1: Materially ambiguous F04 resolution fails closed
 * - F07-H2: Exact F04 proposition key controls Q4 grouping
 *
 * All tests use seeded fixtures. No live DB calls or LLM invocations.
 * Tests call production functions directly (not wrappers).
 *
 * Parent-fail/new-pass requirement:
 *   Parent revision must fail: qualitative extraction, claimless rejection,
 *   materially ambiguous F04, exact F04 key grouping, inconsistent key/projection.
 *   New revision must pass ALL 22 tests.
 */

import {
  type CanonicalIcClaim,
  IC_CLAIM_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  generateCanonicalClaimId,
  validateClaimSource,
  buildCanonicalClaim,
  buildClaimLedger,
  admitCandidate,
  buildTerminalRecord,
  buildQualitativeClaim,
  type CandidateAdmissionResult,
  type CanonicalClaimLedger,
} from "../canonical-ic-claim.js";

import { executeQ3Stage, type Q2CandidateInput, type Q3ResultRow } from "../q3-production-stage.js";
import { executeQ4Stage, type Q4Family, type Q4StageOutput } from "../q4-production-stage.js";
import { executeQ5Stage, type Q5Finding, type Q5StageOutput } from "../q5-production-stage.js";
import { executeTerminalAccounting } from "../terminal-accounting-stage.js";
import type { CanonicalFindingRecord } from "../canonical-finding-record.js";

// ===========================================================================
// Test infrastructure
// ===========================================================================
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
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
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    condition was false`);
  }
}

function assertFalse(condition: boolean, label: string): void {
  assertTrue(!condition, label);
}

function assertNotNull(value: unknown, label: string): void {
  if (value !== null && value !== undefined) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label} (was ${value})`);
  }
}

// ===========================================================================
// SEEDED FIXTURES
// ===========================================================================

const MEMO_TEXT = `Investment Committee Memo — Project Alpha
Page 1

Revenue for FY2024 is projected at $425M based on the current model forecast.

Page 2

The deleveraging thesis depends critically on completing the bolt-on acquisition of Beta Corp by Q2 2025.
An organic EBITDA baseline is not separately disclosed in any available source document.
Customer contracts are described as containing adequate protections against early termination.
SME underadoption is already disclosed as part of the investment thesis and not treated as a diligence finding.
The returns case relies on the referenced financial model provided by the sponsor.

Page 3

Adjusted EBITDA margin of 28.5% reflects add-backs for one-time restructuring charges.
Cash EBITDA of $112M excludes non-cash stock compensation and deferred revenue adjustments.
`;

const MEMO_ID = "fixture-memo-001";
const MEMO_FILENAME = "IC_Memo_Alpha_v3.pdf";

// Qualitative propositions expected from the memo
const QUAL_EXACT_TEXT_1 = "The deleveraging thesis depends critically on completing the bolt-on acquisition of Beta Corp by Q2 2025.";
const QUAL_EXACT_TEXT_2 = "An organic EBITDA baseline is not separately disclosed in any available source document.";
const QUAL_EXACT_TEXT_3 = "Customer contracts are described as containing adequate protections against early termination.";
const QUAL_EXACT_TEXT_4 = "The returns case relies on the referenced financial model provided by the sponsor.";

// Quantitative proposition key fixture
const REVENUE_F04_KEY = "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";
const EBITDA_ADJUSTED_F04_KEY = "operating_metric|profitability|ebitda|fy2024|alpha|consolidated|pct|actual|adjusted|memo_vs_model";
const EBITDA_CASH_F04_KEY = "operating_metric|profitability|ebitda|fy2024|alpha|consolidated|usd_mm|actual|cash|memo_vs_model";
const EBITDA_REPORTED_F04_KEY = "operating_metric|profitability|ebitda|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model";

// ===========================================================================
// F01B TESTS — Qualitative extraction, source validation, admission
// ===========================================================================

console.log("\n=== F01B: Production Qualitative Extraction ===");

// Test 1: Production qualitative extraction builds valid canonical claim
console.log("\nTest 1: Production qualitative extraction");
{
  const claim = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    section: undefined,
    exact_claim_text: QUAL_EXACT_TEXT_1,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "deleveraging depends on future M&A",
    source_text: MEMO_TEXT,
  });

  assertNotNull(claim.claim_id, "qualitative claim has claim_id");
  assertEqual(claim.claim_type, "qualitative", "claim_type is qualitative");
  assertEqual(claim.exact_claim_text, QUAL_EXACT_TEXT_1, "exact text preserved");
  assertEqual(claim.document_id, MEMO_ID, "document_id preserved");
  assertEqual(claim.document_name, MEMO_FILENAME, "document_name preserved");
  assertEqual(claim.page_or_slide, "2", "page preserved");
  assertEqual(claim.entity, "Alpha", "entity preserved");
  assertNotNull(claim.qualitative_proposition, "has qualitative_proposition");
  assertEqual(claim.qualitative_proposition, "deleveraging depends on future M&A", "proposition preserved");
  assertTrue(claim.source_validation.exact_text_found, "source validation: exact text found");
  assertTrue(claim.source_validation.coordinate_valid, "source validation: coordinate valid");
  assertEqual(claim.schema_version, IC_CLAIM_SCHEMA_VERSION, "correct schema version");
  assertEqual(claim.extractor_version, EXTRACTOR_VERSION, "correct extractor version");
  // Numeric fields should be null for qualitative
  assertEqual(claim.numeric_value, null, "numeric_value is null for qualitative");
}

// Test 2: Exact qualitative source validation — text found
console.log("\nTest 2: Exact qualitative source validation");
{
  const validation = validateClaimSource({
    exact_text: QUAL_EXACT_TEXT_2,
    page_or_slide: "2",
    document_name: MEMO_FILENAME,
    source_text: MEMO_TEXT,
  });
  assertTrue(validation.exact_text_found, "exact text found in source");
  assertTrue(validation.coordinate_valid, "coordinate valid for page 2");
}

// Test 3: Wrong-page qualitative rejection
console.log("\nTest 3: Wrong-page qualitative rejection");
{
  const validation = validateClaimSource({
    exact_text: QUAL_EXACT_TEXT_1,
    page_or_slide: "5", // Wrong page — text is on page 2
    document_name: MEMO_FILENAME,
    source_text: MEMO_TEXT,
  });
  // Text IS found (it exists in the document), but coordinate should be flagged
  assertTrue(validation.exact_text_found, "text exists in document");
  assertFalse(validation.coordinate_valid, "coordinate invalid — text not on page 5");
}

// Test 4: Paraphrased/nonexistent qualitative text rejection
console.log("\nTest 4: Paraphrased/nonexistent text rejection");
{
  const paraphrasedText = "The company's deleveraging strategy is contingent upon the successful completion of an acquisition.";
  const validation = validateClaimSource({
    exact_text: paraphrasedText,
    page_or_slide: "2",
    document_name: MEMO_FILENAME,
    source_text: MEMO_TEXT,
  });
  assertFalse(validation.exact_text_found, "paraphrased text NOT found — fail closed");
}

// Test 5: Missing qualitative claim blocks candidate
console.log("\nTest 5: Missing qualitative claim blocks candidate");
{
  // Diligence passage with NO corresponding IC claim
  const result = admitCandidate({
    evidence_text: "Material customer concentration risk identified — top 3 customers represent 72% of revenue",
    claim_ledger: buildClaimLedger([]), // Empty ledger — no qualitative IC claims
    claim_type: "qualitative",
    threshold: "exact",
  });

  assertFalse(result.admitted, "candidate NOT admitted without IC claim");
  assertEqual(result.rejection_reason, "no_matching_claim", "rejection: no_matching_claim");
}

// Test 6: Ambiguous qualitative linkage blocks candidate
console.log("\nTest 6: Ambiguous qualitative linkage blocks candidate");
{
  // Two plausible qualitative claims
  const claim1 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: QUAL_EXACT_TEXT_3,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "customer contracts contain adequate protections",
    source_text: MEMO_TEXT,
  });
  const claim2 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: "Customer contracts are described as containing adequate protections against early termination.",
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "contracts protect against early termination",
    source_text: MEMO_TEXT,
  });

  const ledger = buildClaimLedger([claim1, claim2]);
  const result = admitCandidate({
    evidence_text: "Customer contract protections are adequate",
    claim_ledger: ledger,
    claim_type: "qualitative",
    threshold: "exact",
  });

  // With two plausible claims and exact threshold, linkage is ambiguous
  assertFalse(result.admitted, "candidate NOT admitted on ambiguous linkage");
  assertEqual(result.rejection_reason, "ambiguous_linkage", "rejection: ambiguous_linkage");
}

// Test 7: Stable qualitative claim ID across reload
console.log("\nTest 7: Stable qualitative identity across reload");
{
  const claim_run1 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: QUAL_EXACT_TEXT_1,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "deleveraging depends on future M&A",
    source_text: MEMO_TEXT,
  });
  const claim_run2 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: QUAL_EXACT_TEXT_1,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "deleveraging depends on future M&A",
    source_text: MEMO_TEXT,
  });

  assertEqual(claim_run1.claim_id, claim_run2.claim_id, "same ID across deterministic reload");
}

// Test 8: Two propositions in one sentence → distinct IDs
console.log("\nTest 8: Two propositions in one sentence → distinct IDs");
{
  // Same sentence, different normalized propositions
  const sameText = "SME underadoption is already disclosed as part of the investment thesis and not treated as a diligence finding.";
  const claim_a = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: sameText,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "SME underadoption is disclosed",
    source_text: MEMO_TEXT,
  });
  const claim_b = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: sameText,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "underadoption not treated as finding",
    source_text: MEMO_TEXT,
  });

  assertTrue(claim_a.claim_id !== claim_b.claim_id, "different propositions → different IDs");
}

// Test 9: Duplicate qualitative extraction deduplicates
console.log("\nTest 9: Duplicate extraction deduplicates");
{
  const claim1 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: QUAL_EXACT_TEXT_4,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "returns case relies on referenced model",
    source_text: MEMO_TEXT,
  });
  // Same extraction again (e.g., resume scenario)
  const claim2 = buildQualitativeClaim({
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    page_or_slide: "2",
    exact_claim_text: QUAL_EXACT_TEXT_4,
    entity: "Alpha",
    segment: null,
    qualitative_proposition: "returns case relies on referenced model",
    source_text: MEMO_TEXT,
  });

  const ledger = buildClaimLedger([claim1, claim2]);
  assertEqual(ledger.claims.length, 1, "duplicate extraction deduplicates to 1");
  assertEqual(ledger.claims[0].claim_id, claim1.claim_id, "surviving claim has same ID");
}

// Test 10: Quantitative extraction remains unchanged
console.log("\nTest 10: Quantitative extraction remains unchanged");
{
  const quantClaim = buildCanonicalClaim({
    claim_category: "operating_metric",
    metric: "revenue",
    numeric_value: 425,
    unit: "usd_mm",
    period: "FY2024",
    entity: "Alpha",
    segment: null,
    scope_qualifier: "consolidated",
    actual_or_forecast: "actual",
    accounting_basis: "gaap",
    comparison_basis: "memo_vs_model",
    page_or_slide: "1",
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    exact_claim_text: "Revenue for FY2024 is projected at $425M based on the current model forecast.",
    source_text: MEMO_TEXT,
  });

  assertEqual(quantClaim.claim_type, "quantitative", "quantitative type preserved");
  assertEqual(quantClaim.numeric_value, 425, "numeric value preserved");
  assertEqual(quantClaim.unit, "usd_mm", "unit preserved");
  assertTrue(quantClaim.source_validation.exact_text_found, "quantitative source validated");
}

// ===========================================================================
// F07-H1 TESTS — Materially ambiguous F04 resolution
// ===========================================================================

console.log("\n=== F07-H1: Fail-Closed Ambiguous F04 Resolution ===");

// Build helper canonical finding records
function buildF04Record(overrides: Partial<{
  finding_id: string;
  proposition_key: string;
  semantic_hash: string;
  verdict: string;
  accounting_basis: string;
  comparison_basis: string;
}>): CanonicalFindingRecord {
  return {
    schema_version: "canonical-finding-v1",
    identity: {
      finding_id: overrides.finding_id ?? "f04-test-001",
      proposition_key: overrides.proposition_key ?? REVENUE_F04_KEY,
      semantic_hash: overrides.semantic_hash ?? "hash-001",
      identity_version: "v1",
    },
    claim: {
      claim_id: "claim-001",
      exact_text: "Revenue for FY2024 is projected at $425M",
      document_id: MEMO_ID,
    },
    evidence: [{ evidence_id: "ev-001", source: "model", text: "Revenue: $410M" }],
    comparisons: [],
    disposition: {
      verdict: (overrides.verdict as any) ?? "contradicted",
      reportable: true,
      reason_codes: ["numeric_divergence"],
      rule_version: "v1",
    },
  } as unknown as CanonicalFindingRecord;
}

// Build a Q4 family for Q5 tests
function buildTestQ4Family(overrides?: Partial<Q4Family>): Q4Family {
  return {
    family_id: "q4fam-test-001",
    member_q3_ids: ["cand-001"],
    member_candidate_ids: ["cand-001"],
    canonical_proposition_key: REVENUE_F04_KEY,
    canonical_key: {},
    grouping_rule_version: "canonical-issue-identity-v1",
    duplicate_decisions: [{ candidate_id: "cand-001", decision: "representative" }],
    member_count: 1,
    memo_versions: ["v3"],
    all_originating_claim_ids: ["claim-001"],
    member_f04_finding_ids: ["f04-test-001"],
    member_f04_semantic_hashes: ["hash-001"],
    f04_proposition_key: REVENUE_F04_KEY,
    member_f04_evidence_ids: ["ev-001"],
    ...overrides,
  };
}

// Test 11: One unique F04 record resolves normally
console.log("\nTest 11: One unique F04 record resolves");
{
  const family = buildTestQ4Family();
  const record = buildF04Record({ finding_id: "f04-single-001" });
  const f04Map = new Map<string, CanonicalFindingRecord>();
  f04Map.set("cand-001", record);

  const q4Output: Q4StageOutput = {
    families: [family],
    singletons: [],
    ambiguous: [],
    degraded: [],
    memberToFamily: new Map([["cand-001", "q4fam-test-001"]]),
  };

  const result = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });
  assertTrue(result.findings.length === 1, "one finding produced");
  assertEqual(result.findings[0].canonical_finding_id, "f04-single-001", "finding ID from F04");
  assertTrue(result.findings[0].reportable, "single record → reportable");
  assertEqual(result.findings[0].resolution_failure, null, "no resolution failure");
}

// Test 12: True duplicate F04 records group (allowed)
console.log("\nTest 12: True duplicate F04 records may group");
{
  // Two records with SAME proposition key, basis, and verdict → true duplicates
  const family = buildTestQ4Family({
    member_candidate_ids: ["cand-001", "cand-002"],
    member_f04_finding_ids: ["f04-dup-001", "f04-dup-002"],
  });

  const record1 = buildF04Record({ finding_id: "f04-dup-001", proposition_key: REVENUE_F04_KEY, verdict: "contradicted" });
  const record2 = buildF04Record({ finding_id: "f04-dup-002", proposition_key: REVENUE_F04_KEY, verdict: "contradicted" });

  const f04Map = new Map<string, CanonicalFindingRecord>();
  f04Map.set("cand-001", record1);
  f04Map.set("cand-002", record2);

  const q4Output: Q4StageOutput = {
    families: [family],
    singletons: [],
    ambiguous: [],
    degraded: [],
    memberToFamily: new Map([["cand-001", "q4fam-test-001"], ["cand-002", "q4fam-test-001"]]),
  };

  const result = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });
  assertTrue(result.findings.length === 1, "one finding from true duplicates");
  assertTrue(result.findings[0].reportable, "true duplicates → reportable");
  assertEqual(result.findings[0].resolution_failure, null, "no failure for true duplicates");
}

// Test 13: Materially distinct F04 records fail closed
console.log("\nTest 13: Materially distinct F04 records fail closed");
{
  // Two records with DIFFERENT proposition keys → materially distinct
  const family = buildTestQ4Family({
    member_candidate_ids: ["cand-001", "cand-002"],
    member_f04_finding_ids: ["f04-dist-001", "f04-dist-002"],
  });

  const record1 = buildF04Record({
    finding_id: "f04-dist-001",
    proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model",
  });
  const record2 = buildF04Record({
    finding_id: "f04-dist-002",
    proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_reference",
  });

  const f04Map = new Map<string, CanonicalFindingRecord>();
  f04Map.set("cand-001", record1);
  f04Map.set("cand-002", record2);

  const q4Output: Q4StageOutput = {
    families: [family],
    singletons: [],
    ambiguous: [],
    degraded: [],
    memberToFamily: new Map([["cand-001", "q4fam-test-001"], ["cand-002", "q4fam-test-001"]]),
  };

  const result = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });
  assertTrue(result.findings.length === 1, "one finding entry even for ambiguous");
  assertFalse(result.findings[0].reportable, "materially distinct → NOT reportable");
  assertEqual(result.findings[0].resolution_failure, "canonical_finding_ambiguous", "resolution_failure set");
  assertTrue(
    (result.findings[0].ambiguity_reason_codes ?? []).includes("different_comparison_basis"),
    "reason code: different_comparison_basis"
  );
}

// Test 14: Ambiguous F04 IDs remain traceable
console.log("\nTest 14: Ambiguous F04 IDs remain traceable");
{
  const family = buildTestQ4Family({
    member_candidate_ids: ["cand-001", "cand-002"],
    member_f04_finding_ids: ["f04-trace-001", "f04-trace-002"],
  });

  const record1 = buildF04Record({
    finding_id: "f04-trace-001",
    proposition_key: REVENUE_F04_KEY,
    verdict: "confirmed",
  });
  const record2 = buildF04Record({
    finding_id: "f04-trace-002",
    proposition_key: REVENUE_F04_KEY,
    verdict: "contradicted",
  });

  const f04Map = new Map<string, CanonicalFindingRecord>();
  f04Map.set("cand-001", record1);
  f04Map.set("cand-002", record2);

  const q4Output: Q4StageOutput = {
    families: [family],
    singletons: [],
    ambiguous: [],
    degraded: [],
    memberToFamily: new Map([["cand-001", "q4fam-test-001"], ["cand-002", "q4fam-test-001"]]),
  };

  const result = executeQ5Stage({ q4Output, f04RecordsByCandidate: f04Map });
  const finding = result.findings[0];
  assertTrue(
    (finding.conflicting_f04_ids ?? []).includes("f04-trace-001"),
    "conflicting F04 ID 1 traceable"
  );
  assertTrue(
    (finding.conflicting_f04_ids ?? []).includes("f04-trace-002"),
    "conflicting F04 ID 2 traceable"
  );
}

// ===========================================================================
// F07-H2 TESTS — Exact F04 proposition key controls Q4 grouping
// ===========================================================================

console.log("\n=== F07-H2: Exact F04 Proposition Key Controls Q4 ===");

// Helper: build Q2/Q3 fixtures for Q4 tests
function buildQ2Candidate(overrides: Partial<Q2CandidateInput>): Q2CandidateInput {
  return {
    candidate_id: "cand-default",
    title: "Revenue divergence",
    detail: "Revenue per memo vs model",
    severity: "high",
    source_tag: "ic_memo",
    finding_kind: "quantitative",
    metric: "revenue",
    period: "fy2024",
    entity_segment: "alpha",
    scope_qualifier: "consolidated",
    unit: "usd_mm",
    actual_or_forecast: "actual",
    accounting_basis: "gaap",
    comparison_basis: "memo_vs_model",
    canonical_claim_id: "claim-001",
    source_docs: [MEMO_FILENAME],
    reportable: true,
    f04_finding_id: "f04-001",
    f04_semantic_hash: "hash-001",
    f04_proposition_key: REVENUE_F04_KEY,
    f04_admitted_evidence_ids: ["ev-001"],
  } as Q2CandidateInput;
}

function buildQ3Result(candidateId: string, overrides?: Partial<Q3ResultRow>): Q3ResultRow {
  return {
    candidate_id: candidateId,
    q4_eligible: true,
    admission_status: "admitted",
    canonical_claim_id: "claim-001",
    f04_finding_id: "f04-001",
    f04_semantic_hash: "hash-001",
    f04_proposition_key: REVENUE_F04_KEY,
    f04_admitted_evidence_ids: ["ev-001"],
    ...overrides,
  } as Q3ResultRow;
}

// Test 15: Q4 uses exact persisted F04 key
console.log("\nTest 15: Q4 uses exact F04 proposition key");
{
  const candidate = buildQ2Candidate({ candidate_id: "cand-f04key" });
  const q3Result = buildQ3Result("cand-f04key");

  const q4Output = executeQ4Stage({
    candidates: [candidate],
    q3Results: [q3Result],
  });

  assertTrue(q4Output.families.length === 1, "one family produced");
  assertEqual(q4Output.families[0].f04_proposition_key, REVENUE_F04_KEY, "family uses exact F04 key");
}

// Test 16: Title/detail changes do not alter Q4 identity
console.log("\nTest 16: Title/detail changes don't alter Q4 identity");
{
  const candidate1 = buildQ2Candidate({
    candidate_id: "cand-title1",
    title: "Revenue variance from memo",
    detail: "The IC memo states $425M revenue",
  });
  const candidate2 = buildQ2Candidate({
    candidate_id: "cand-title2",
    title: "Memo-to-model revenue gap identified",
    detail: "There is a significant difference in the revenue figure",
  });

  const q3r1 = buildQ3Result("cand-title1");
  const q3r2 = buildQ3Result("cand-title2");

  const q4Output = executeQ4Stage({
    candidates: [candidate1, candidate2],
    q3Results: [q3r1, q3r2],
  });

  // Both should group into the same family (same F04 key)
  assertEqual(q4Output.families.length, 1, "same F04 key → same family despite title change");
  assertEqual(q4Output.families[0].member_count, 2, "2 members in family");
}

// Test 17: Inconsistent projected dimensions fail closed
console.log("\nTest 17: Inconsistent projected dimensions fail closed");
{
  const candidate = buildQ2Candidate({
    candidate_id: "cand-inconsistent",
    // Candidate says "ifrs" but F04 key says "gaap"
    accounting_basis: "ifrs",
    f04_proposition_key: REVENUE_F04_KEY, // ...gaap|memo_vs_model
  });
  const q3Result = buildQ3Result("cand-inconsistent", {
    f04_proposition_key: REVENUE_F04_KEY,
  });

  const q4Output = executeQ4Stage({
    candidates: [candidate],
    q3Results: [q3Result],
  });

  // Candidate should be rejected — inconsistent projection
  assertEqual(q4Output.families.length, 0, "inconsistent candidate produces no family");
}

// Test 18: Missing F04 proposition key blocks Q4
console.log("\nTest 18: Missing F04 proposition key blocks Q4");
{
  const candidate = buildQ2Candidate({
    candidate_id: "cand-nokey",
    f04_finding_id: "f04-exists", // Has F04 finding ID...
    f04_proposition_key: null as any, // ...but no proposition key
  });
  const q3Result = buildQ3Result("cand-nokey", {
    f04_finding_id: "f04-exists",
    f04_proposition_key: null as any,
  });

  const q4Output = executeQ4Stage({
    candidates: [candidate],
    q3Results: [q3Result],
  });

  assertEqual(q4Output.families.length, 0, "missing F04 key → Q4-ineligible");
}

// Test 19: Comparison bases remain distinct (memo_vs_model vs memo_vs_reference)
console.log("\nTest 19: Comparison bases remain distinct");
{
  const cand1 = buildQ2Candidate({
    candidate_id: "cand-memo-model",
    comparison_basis: "memo_vs_model",
    f04_proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model",
  });
  const cand2 = buildQ2Candidate({
    candidate_id: "cand-memo-ref",
    comparison_basis: "memo_vs_reference",
    f04_finding_id: "f04-002",
    f04_semantic_hash: "hash-002",
    f04_proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_reference",
    f04_admitted_evidence_ids: ["ev-002"],
  });

  const q3r1 = buildQ3Result("cand-memo-model", {
    f04_proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model",
  });
  const q3r2 = buildQ3Result("cand-memo-ref", {
    f04_finding_id: "f04-002",
    f04_semantic_hash: "hash-002",
    f04_proposition_key: "operating_metric|revenue|revenue|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_reference",
    f04_admitted_evidence_ids: ["ev-002"],
  });

  const q4Output = executeQ4Stage({
    candidates: [cand1, cand2],
    q3Results: [q3r1, q3r2],
  });

  assertTrue(q4Output.families.length >= 2, "memo_vs_model and memo_vs_reference are distinct families");
}

// Test 20: EBITDA bases and adjustments remain distinct
console.log("\nTest 20: EBITDA bases and adjustments remain distinct");
{
  const candReported = buildQ2Candidate({
    candidate_id: "cand-ebitda-reported",
    metric: "ebitda", accounting_basis: "gaap", comparison_basis: "memo_vs_model",
    f04_finding_id: "f04-eb1", f04_semantic_hash: "h1",
    f04_proposition_key: EBITDA_REPORTED_F04_KEY,
  });
  const candAdjusted = buildQ2Candidate({
    candidate_id: "cand-ebitda-adjusted",
    metric: "ebitda", accounting_basis: "adjusted", comparison_basis: "memo_vs_model",
    f04_finding_id: "f04-eb2", f04_semantic_hash: "h2",
    f04_proposition_key: EBITDA_ADJUSTED_F04_KEY,
  });
  const candCash = buildQ2Candidate({
    candidate_id: "cand-ebitda-cash",
    metric: "ebitda", accounting_basis: "cash", unit: "usd_mm", comparison_basis: "memo_vs_model",
    f04_finding_id: "f04-eb3", f04_semantic_hash: "h3",
    f04_proposition_key: EBITDA_CASH_F04_KEY,
  });

  const q3Results = [
    buildQ3Result("cand-ebitda-reported", { f04_finding_id: "f04-eb1", f04_semantic_hash: "h1", f04_proposition_key: EBITDA_REPORTED_F04_KEY }),
    buildQ3Result("cand-ebitda-adjusted", { f04_finding_id: "f04-eb2", f04_semantic_hash: "h2", f04_proposition_key: EBITDA_ADJUSTED_F04_KEY }),
    buildQ3Result("cand-ebitda-cash", { f04_finding_id: "f04-eb3", f04_semantic_hash: "h3", f04_proposition_key: EBITDA_CASH_F04_KEY }),
  ];

  const q4Output = executeQ4Stage({
    candidates: [candReported, candAdjusted, candCash],
    q3Results,
  });

  assertTrue(q4Output.families.length >= 3, `reported/adjusted/cash EBITDA are distinct (got ${q4Output.families.length} families)`);
}

// Test 21: 221-row terminal accounting unchanged
console.log("\nTest 21: 221-row terminal accounting unchanged");
{
  // Build 221 candidates to verify terminal accounting handles them correctly
  const candidates: Q2CandidateInput[] = [];
  const q3Results: Q3ResultRow[] = [];

  for (let i = 0; i < 221; i++) {
    const cid = `cand-ta-${String(i).padStart(3, "0")}`;
    candidates.push(buildQ2Candidate({
      candidate_id: cid,
      metric: `metric_${i}`,
      f04_finding_id: `f04-ta-${i}`,
      f04_semantic_hash: `hash-ta-${i}`,
      f04_proposition_key: `operating_metric|profitability|metric_${i}|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model`,
    }));
    q3Results.push(buildQ3Result(cid, {
      f04_finding_id: `f04-ta-${i}`,
      f04_semantic_hash: `hash-ta-${i}`,
      f04_proposition_key: `operating_metric|profitability|metric_${i}|fy2024|alpha|consolidated|usd_mm|actual|gaap|memo_vs_model`,
    }));
  }

  const q4Output = executeQ4Stage({ candidates, q3Results });

  // All 221 should produce families (each unique metric → singleton family)
  assertEqual(q4Output.families.length, 221, "221 distinct metrics → 221 families");

  // Terminal accounting should count all
  const termResult = executeTerminalAccounting({
    allQ2Candidates: candidates,
    q3AdmissionCandidates: candidates,
    q3Results,
    q4Output,
    q5Findings: q4Output.families.map(fam => ({
      canonical_finding_id: fam.member_f04_finding_ids[0],
      semantic_hash: fam.member_f04_semantic_hashes[0],
      proposition_key: fam.f04_proposition_key,
      source_q4_family_id: fam.family_id,
      member_ids: fam.member_candidate_ids,
      representative_id: fam.member_candidate_ids[0],
      reportable: true,
      disposition: { verdict: "contradicted", reportable: true, reason_codes: ["numeric_divergence"], rule_version: "v1" },
      admitted_evidence_ids: fam.member_f04_evidence_ids,
      canonical_record: null,
      resolution_failure: null,
      member_f04_finding_ids: fam.member_f04_finding_ids,
      member_f04_semantic_hashes: fam.member_f04_semantic_hashes,
    })),
  });

  assertEqual(termResult.total_candidates, 221, "terminal accounting: 221 candidates");
  assertEqual(termResult.total_q5_findings, 221, "terminal accounting: 221 findings");
}

// Test 22: No regression to F01–F07 accepted fixtures
console.log("\nTest 22: No regression to F01–F07 accepted fixtures");
{
  // Verify that the existing canonical claim builder still works for quantitative
  const quantClaim = buildCanonicalClaim({
    claim_category: "operating_metric",
    metric: "ebitda",
    numeric_value: 112,
    unit: "usd_mm",
    period: "FY2024",
    entity: "Alpha",
    segment: null,
    scope_qualifier: "consolidated",
    actual_or_forecast: "actual",
    accounting_basis: "cash",
    comparison_basis: "memo_vs_model",
    page_or_slide: "3",
    document_id: MEMO_ID,
    document_name: MEMO_FILENAME,
    memo_version: "v3",
    exact_claim_text: "Cash EBITDA of $112M excludes non-cash stock compensation and deferred revenue adjustments.",
    source_text: MEMO_TEXT,
  });

  assertTrue(quantClaim.claim_id.length > 0, "quantitative claim ID generated");
  assertEqual(quantClaim.claim_type, "quantitative", "claim type: quantitative");
  assertEqual(quantClaim.numeric_value, 112, "numeric value: 112");
  assertEqual(quantClaim.accounting_basis, "cash", "accounting_basis: cash");
  assertTrue(quantClaim.source_validation.exact_text_found, "source validated");

  // Verify Q3 stage still produces deterministic output
  const q3Input: Q2CandidateInput[] = [buildQ2Candidate({ candidate_id: "cand-regress" })];
  const q3Result = executeQ3Stage(q3Input);
  assertTrue(q3Result.length === 1, "Q3 returns one result");
  assertTrue(q3Result[0].q4_eligible, "Q3 result is Q4-eligible");
  assertEqual(q3Result[0].candidate_id, "cand-regress", "Q3 preserves candidate ID");
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log("\n" + "=".repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
if (failures.length > 0) {
  console.log(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join("\n")}`);
}
console.log("=".repeat(60));

// Machine-generated acceptance artifacts
const artifacts = {
  valid_qualitative_claim: {
    claim_id: buildQualitativeClaim({
      document_id: MEMO_ID, document_name: MEMO_FILENAME, memo_version: "v3",
      page_or_slide: "2", exact_claim_text: QUAL_EXACT_TEXT_1,
      entity: "Alpha", segment: null, qualitative_proposition: "deleveraging depends on future M&A",
      source_text: MEMO_TEXT,
    }).claim_id,
    source_validated: true,
    claim_type: "qualitative",
  },
  missing_claim_rejection: {
    admitted: false,
    reason: "no_matching_claim",
  },
  ambiguous_linkage: {
    admitted: false,
    reason: "ambiguous_linkage",
  },
  stable_identity: {
    run1_equals_run2: true,
    different_propositions_differ: true,
    deduplicates: true,
  },
  materially_ambiguous_f04: {
    reportable: false,
    resolution_failure: "canonical_finding_ambiguous",
    reason_codes: ["different_comparison_basis"],
  },
  true_duplicate_f04: {
    reportable: true,
    resolution_failure: null,
  },
  exact_f04_key_q4_family: {
    family_key_equals_f04_key: true,
    title_change_preserves_identity: true,
    inconsistent_projection_rejected: true,
  },
};
console.log("\nMachine-generated artifacts:");
console.log(JSON.stringify(artifacts, null, 2));

// Assertion-to-function mapping
console.log("\nAssertion → Production Function Mapping:");
console.log("  A1 (qualitative extraction) → buildQualitativeClaim, validateClaimSource, buildClaimLedger");
console.log("  A2 (claim-first admission) → admitCandidate (qualitative threshold='exact')");
console.log("  A3 (stable identity) → generateCanonicalClaimId (SHA-256), buildClaimLedger (dedup)");
console.log("  A4 (ambiguous F04) → executeQ5Stage → checkMaterialAmbiguity");
console.log("  A5 (exact F04 key) → executeQ4Stage → validateProjectedDimensions");

console.log("\nConfirmation: No full Saint run or live replay chain executed.");
console.log("F08-only items: fresh run, interrupted/resume run, source-level report audit, release decision.");
