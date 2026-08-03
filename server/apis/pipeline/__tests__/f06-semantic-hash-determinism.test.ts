/**
 * MAT-F06 Semantic Hash Determinism Test
 *
 * Verifies:
 * 1. sha256hex produces genuine SHA-256 output (64 hex chars, matches known vector)
 * 2. Identical canonical content → identical semantic hash
 * 3. Changed canonical content → different semantic hash
 * 4. Volatile fields (timestamps, insertion order) excluded from hash input
 * 5. Uses real SHA-256 (not FNV, DJB2, or any weak hash)
 */

import { computeSemanticHash, buildSemanticHashInput } from "../canonical-final-artifact.js";
import { sha256hex } from "../sha256-pure.js";

// ==========================================================================
// Test Harness (no external test framework)
// ==========================================================================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
  }
}

// ==========================================================================
// Fixtures
// ==========================================================================

const SAMPLE_FINDINGS = [
  {
    finding_id: "f-001",
    id: "f-001",
    title: "Revenue growth overstated",
    detail: "Memo claims 25% growth but model shows 12%",
    severity: "high",
    verdict: "contradicted",
    _semantic_hash: "hash-f001",
    _canonical_verdict: "contradicted",
  },
  {
    finding_id: "f-002",
    id: "f-002",
    title: "EBITDA margin compression",
    detail: "Adjusted EBITDA dropped from 30% to 22%",
    severity: "medium",
    verdict: "materially_changed",
    _semantic_hash: "hash-f002",
    _canonical_verdict: "materially_changed",
  },
];

const REPORTABLE_IDS = ["f-001", "f-002"];
const DIAGNOSTICS = {
  excluded_findings: [] as any[],
  narrative_validation: [] as any[],
  degraded_conditions: [] as string[],
  checkpoint_status: [] as any[],
} as any;
const MODULE_TYPE = "contradiction_check";
const REPORT_MARKDOWN = "## Summary\nTwo material findings identified.";

// ==========================================================================
// Test 1: SHA-256 produces 64-char hex output matching known vector
// ==========================================================================

const testHash = sha256hex("hello world");
assert(testHash.length === 64, `SHA-256 output must be 64 hex chars, got ${testHash.length}`);
assert(/^[0-9a-f]{64}$/.test(testHash), `SHA-256 output must be lowercase hex, got: ${testHash}`);

// Known SHA-256 of "hello world"
assert(
  testHash === "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  `SHA-256("hello world") must match known value, got: ${testHash}`
);

// ==========================================================================
// Test 2: Identical content → identical semantic hash
// ==========================================================================

const input1 = buildSemanticHashInput(SAMPLE_FINDINGS, REPORTABLE_IDS, DIAGNOSTICS, MODULE_TYPE, REPORT_MARKDOWN);
const hash1 = computeSemanticHash(input1);

const input2 = buildSemanticHashInput(SAMPLE_FINDINGS, REPORTABLE_IDS, DIAGNOSTICS, MODULE_TYPE, REPORT_MARKDOWN);
const hash2 = computeSemanticHash(input2);

assert(hash1 === hash2, `Identical content must produce identical hash. Got: ${hash1} vs ${hash2}`);
assert(hash1.startsWith("sha256-v1:"), `Hash must have sha256-v1: prefix. Got: ${hash1}`);
assert(hash1.length === 10 + 64, `Hash must be prefix(10) + 64 hex chars. Got length: ${hash1.length}`);

// ==========================================================================
// Test 3: Changed content → different semantic hash
// ==========================================================================

const altFindings = [
  ...SAMPLE_FINDINGS,
  {
    finding_id: "f-003",
    id: "f-003",
    title: "Customer concentration risk",
    detail: "Top 3 customers = 78% of revenue",
    severity: "high",
    verdict: "contradicted",
    _semantic_hash: "hash-f003",
    _canonical_verdict: "contradicted",
  },
];

const inputAlt = buildSemanticHashInput(altFindings, [...REPORTABLE_IDS, "f-003"], DIAGNOSTICS, MODULE_TYPE, REPORT_MARKDOWN);
const hashAlt = computeSemanticHash(inputAlt);

assert(hashAlt !== hash1, `Different findings must produce different hash. Both: ${hash1}`);

// Changed report markdown
const inputAltReport = buildSemanticHashInput(SAMPLE_FINDINGS, REPORTABLE_IDS, DIAGNOSTICS, MODULE_TYPE, "## Summary\nThree findings.");
const hashAltReport = computeSemanticHash(inputAltReport);
assert(hashAltReport !== hash1, `Different report markdown must produce different hash`);

// ==========================================================================
// Test 4: Insertion order excluded (findings sorted by ID internally)
// ==========================================================================

const reversedFindings = [...SAMPLE_FINDINGS].reverse();
const inputReversed = buildSemanticHashInput(reversedFindings, REPORTABLE_IDS, DIAGNOSTICS, MODULE_TYPE, REPORT_MARKDOWN);
const hashReversed = computeSemanticHash(inputReversed);

assert(
  hashReversed === hash1,
  `Reversed finding order must produce same hash (order excluded). Got: ${hashReversed} vs ${hash1}`
);

// ==========================================================================
// Test 5: Hash is real SHA-256, not weak hash
// Verify the underlying sha256hex matches the known test vector for "abc"
// ==========================================================================

const abcHash = sha256hex("abc");
assert(
  abcHash === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  `SHA-256("abc") must match NIST test vector. Got: ${abcHash}`
);

// Empty string
const emptyHash = sha256hex("");
assert(
  emptyHash === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  `SHA-256("") must match NIST test vector. Got: ${emptyHash}`
);

// ==========================================================================
// Results
// ==========================================================================

console.log(`\n=== F06 Semantic Hash Determinism: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}

export { passed, failed, failures };
