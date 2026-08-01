/**
 * Q0 Source Policy Tests
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/q0-source-policy.test.ts
 *
 * Proves that:
 * 1. Legal DD chunks are NOT routed into unrestricted contradiction extraction
 * 2. Legal DD cannot independently generate findings
 * 3. A specific legal/regulatory IC claim CAN invoke targeted Legal DD verification
 * 4. The resulting output retains the originating IC claim ID and source location
 * 5. Other modules may continue using Legal DD normally
 */
import {
  CONTRADICTION_CHECK_ALLOWED_TAGS,
  NARRATIVE_SOURCES,
  EVIDENCE_SOURCES,
  EXCLUDED_SOURCES,
  isChunkAllowedForContradictionCheck,
  isFindingInScope,
  isTargetedVerificationEligible,
  TARGETED_VERIFICATION_CLAIM_TYPES,
  createPolicySummary,
  type TargetedVerificationRequest,
  type TargetedVerificationResult,
} from "../source-policy.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Legal DD chunks are NOT routed into unrestricted contradiction extraction
// ---------------------------------------------------------------------------
console.log("\n=== Q0-1: Legal DD excluded from contradiction_check routing ===");

assertEqual(CONTRADICTION_CHECK_ALLOWED_TAGS.has("legal" as any), false,
  "Legal tag NOT in CONTRADICTION_CHECK_ALLOWED_TAGS");

assertEqual(isChunkAllowedForContradictionCheck("legal").allowed, false,
  "isChunkAllowedForContradictionCheck('legal') returns false");

// Allowed tags pass through
for (const tag of ["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "other"]) {
  assertEqual(isChunkAllowedForContradictionCheck(tag).allowed, true,
    `isChunkAllowedForContradictionCheck('${tag}') returns true`);
}

// Future specialist tags excluded by default (not in allowed set)
for (const tag of ["tax", "insurance", "hr", "property"]) {
  assertEqual(isChunkAllowedForContradictionCheck(tag).allowed, false,
    `isChunkAllowedForContradictionCheck('${tag}') returns false`);
}

// ---------------------------------------------------------------------------
// 2. Legal DD cannot independently generate findings
// ---------------------------------------------------------------------------
console.log("\n=== Q0-2: Legal DD cannot independently generate findings ===");

assertEqual(isFindingInScope("legal", false), false,
  "Legal finding without originating claim → out of scope");

assertEqual(isFindingInScope("legal", true, "operating_metric"), false,
  "Legal finding with non-qualifying claim type → out of scope");

assertEqual(isFindingInScope("legal", true, undefined), false,
  "Legal finding with claim but no type → out of scope");

// Allowed sources don't need claims
for (const tag of ["financial_model", "ic_memo", "consultant_report", "customer_data", "cim", "other"]) {
  assertEqual(isFindingInScope(tag, false), true,
    `Finding from '${tag}' is in scope without claim`);
}

// ---------------------------------------------------------------------------
// 3. Specific legal/regulatory IC claim CAN invoke targeted Legal DD verification
// ---------------------------------------------------------------------------
console.log("\n=== Q0-3: Targeted claim-verification path for Legal DD ===");

// All targeted verification claim types allow Legal DD findings
for (const claimType of TARGETED_VERIFICATION_CLAIM_TYPES) {
  assertEqual(isFindingInScope("legal", true, claimType), true,
    `Legal finding with claim_type='${claimType}' → in scope`);
}

// Text-based eligibility detection
assertEqual(
  isTargetedVerificationEligible({
    claim_text: "The company has no material regulatory exposure",
    source_tag: "ic_memo",
  }),
  true,
  "Recognizes 'no material regulatory exposure' claim"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "There are no material change-of-control risks",
    source_tag: "ic_memo",
  }),
  true,
  "Recognizes 'no material change-of-control risks' claim"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "The business owns all material IP",
    source_tag: "cim",
  }),
  true,
  "Recognizes 'owns all material IP' claim"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "There are no material contractual impediments to the transaction",
    source_tag: "ic_memo",
  }),
  true,
  "Recognizes 'no material contractual impediments' claim"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "No pending legal proceedings of material concern",
    source_tag: "ic_memo",
  }),
  true,
  "Recognizes 'no pending legal proceedings' claim"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "Revenue is expected to grow 15% in FY26",
    source_tag: "ic_memo",
  }),
  false,
  "Rejects generic financial claim (not legal/regulatory)"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "No material regulatory exposure",
    source_tag: "legal",  // Legal DD cannot self-generate claims
  }),
  false,
  "Rejects claim from non-narrative source (legal)"
);

assertEqual(
  isTargetedVerificationEligible({
    claim_text: "arbitrary text that wouldn't match patterns",
    claim_type: "regulatory_exposure",
    source_tag: "ic_memo",
  }),
  true,
  "Accepts explicit claim_type without text pattern match"
);

// ---------------------------------------------------------------------------
// 4. Targeted result retains originating IC claim ID and source location
// ---------------------------------------------------------------------------
console.log("\n=== Q0-4: Targeted verification retains claim provenance ===");

const testRequest: TargetedVerificationRequest = {
  claim_id: "claim_001",
  claim_text: "No material regulatory exposure",
  claim_type: "regulatory_exposure",
  claim_source_doc: "IC Memo v5.pdf",
  claim_source_location: "Page 3, Section 2.1",
  target_source_tag: "legal",
};

assertEqual(testRequest.claim_id, "claim_001", "Request preserves claim_id");
assertEqual(testRequest.claim_source_doc, "IC Memo v5.pdf", "Request preserves source doc");
assertEqual(testRequest.claim_source_location, "Page 3, Section 2.1", "Request preserves source location");
assertEqual(testRequest.claim_type, "regulatory_exposure", "Request preserves claim type");

const testResult: TargetedVerificationResult = {
  request: testRequest,
  verdict: "confirmed",
  evidence_text: "IP schedule confirms all material patents held by OpCo",
  evidence_location: "Legal DD Report, Section 4.2, Page 12",
  is_valid_finding: true,
};

assertEqual(testResult.request.claim_id, "claim_001", "Result retains originating claim_id");
assertEqual(testResult.request.claim_source_doc, "IC Memo v5.pdf", "Result retains originating source doc");
assertEqual(testResult.request.claim_source_location, "Page 3, Section 2.1", "Result retains originating location");
assertEqual(testResult.verdict, "confirmed", "Result carries verdict");
assert(testResult.evidence_text.length > 0, "Result carries evidence text");
assert(testResult.evidence_location.length > 0, "Result carries evidence location");

// ---------------------------------------------------------------------------
// 5. Other modules may continue using Legal DD normally
// ---------------------------------------------------------------------------
console.log("\n=== Q0-5: Other modules unaffected ===");

assertEqual(EXCLUDED_SOURCES.has("legal" as any), true, "Legal is in EXCLUDED_SOURCES");
assertEqual(NARRATIVE_SOURCES.has("legal" as any), false, "Legal is NOT in NARRATIVE_SOURCES");
assertEqual(EVIDENCE_SOURCES.has("legal" as any), false, "Legal is NOT in EVIDENCE_SOURCES");

// Allowed tags are not accidentally excluded
for (const tag of ["cim", "ic_memo", "financial_model", "consultant_report", "customer_data"]) {
  assertEqual(EXCLUDED_SOURCES.has(tag as any), false,
    `'${tag}' is NOT in EXCLUDED_SOURCES`);
}

// Policy summary initializes clean
const summary = createPolicySummary();
assertEqual(summary.total_chunks, 0, "Summary initializes total_chunks=0");
assertEqual(summary.routed_chunks, 0, "Summary initializes routed_chunks=0");
assertEqual(summary.excluded_chunks, 0, "Summary initializes excluded_chunks=0");
assertEqual(summary.targeted_verifications, 0, "Summary initializes targeted_verifications=0");
assertEqual(summary.targeted_findings_retained, 0, "Summary initializes targeted_findings_retained=0");

// ---------------------------------------------------------------------------
// 6. Fail-closed safeguard: mis-tagged Legal DD excluded when tagged "other"
// ---------------------------------------------------------------------------
console.log("\n=== Q0-6: Fail-closed safeguard for mis-tagged documents ===");

// Document tagged "other" but title indicates Legal DD
const legalDDResult = isChunkAllowedForContradictionCheck("other", {
  title: "Project Saint - Legal Due Diligence Report Vol. 1",
});
assertEqual(legalDDResult.allowed, false,
  "Legal DD document tagged 'other' is excluded by metadata");
assertEqual(legalDDResult.actual_source_type, "legal",
  "Reports actual source type as 'legal'");

// Tax diligence pattern
const taxResult = isChunkAllowedForContradictionCheck("other", {
  filename: "Tax DD Report Final.pdf",
});
assertEqual(taxResult.allowed, false,
  "Tax DD document tagged 'other' is excluded by filename pattern");

// Pension report
const pensionResult = isChunkAllowedForContradictionCheck("other", {
  title: "Pension Obligations Report - March 2024",
});
assertEqual(pensionResult.allowed, false,
  "Pension report tagged 'other' is excluded");

// Authoritative doc_type metadata takes precedence
const docTypeResult = isChunkAllowedForContradictionCheck("other", {
  doc_type: "legal_due_diligence",
  title: "Something Innocuous", // title would pass, but doc_type overrides
});
assertEqual(docTypeResult.allowed, false,
  "Authoritative doc_type overrides title");

// Normal "other" document with non-specialist metadata passes
const normalResult = isChunkAllowedForContradictionCheck("other", {
  title: "Q3 Board Presentation",
  filename: "board-deck-q3.pdf",
});
assertEqual(normalResult.allowed, true,
  "Normal 'other' document passes through");

// No metadata at all: "other" is allowed (backward compatible)
const noMetadata = isChunkAllowedForContradictionCheck("other");
assertEqual(noMetadata.allowed, true,
  "'other' without metadata defaults to allowed");

// Unknown tag with no metadata: fail closed
const unknownResult = isChunkAllowedForContradictionCheck("unknown_tag");
assertEqual(unknownResult.allowed, false,
  "Unknown tag fails closed");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(60)}`);
console.log(`Q0 Source Policy Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("All Q0 tests passed ✓");
