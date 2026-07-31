/**
 * Final Corrective Tests for Fix 1 — Claim Origin Map
 *
 * Covers all 5 corrections:
 *   1. Distinguish missing checkpoint from corrupt checkpoint
 *   2. Tie the map to its source/extraction generation (fingerprint)
 *   3. Remove production fallback to legacy IDs (documentId REQUIRED)
 *   4. Generated ID format and parser agreement (UUID validation)
 *   5. Fail explicitly when claim-ID injection cannot parse the extraction
 *
 * Parent: 2086c6d
 *
 * Run: npx tsx server/apis/pipeline/__tests__/claim-origin-final-corrective.test.ts
 */

import {
  generateClaimId,
  parseClaimId,
  isGlobalClaimId,
  CANONICAL_UUID_PATTERN,
  CLAIM_ORIGIN_MAP_VERSION,
  buildClaimOriginMap,
  serializeOriginMap,
  deserializeOriginMap,
  computeOriginMapFingerprint,
  compareFingerprints,
  type OriginMapFingerprint,
  type ClaimOriginEntry,
} from "../claim-origin-map.js";
import { injectClaimIds } from "../extraction-prompt.js";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function section(label: string) { console.log(`\n═══ ${label} ═══`); }
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); failed++; }
  else { console.log(`  ✓ ${msg}`); passed++; }
}
function assertEq(a: unknown, b: unknown, msg: string) {
  assert(a === b, `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function assertThrows(fn: () => unknown, msg: string, pattern?: string) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${msg} (did not throw)`);
    failed++;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (pattern && !errMsg.includes(pattern)) {
      console.error(`  ✗ FAIL: ${msg} — threw but message did not include "${pattern}". Got: "${errMsg.slice(0, 200)}"`);
      failed++;
    } else {
      console.log(`  ✓ ${msg}`);
      passed++;
    }
  }
}
function assertNoThrow(fn: () => unknown, msg: string) {
  try {
    fn();
    console.log(`  ✓ ${msg}`);
    passed++;
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ FAIL: ${msg} — unexpectedly threw: "${errMsg.slice(0, 200)}"`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const UUID_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_B = "11111111-2222-3333-4444-555555555555";
const NON_UUID = "test-doc-id-123";

// ===========================================================================
// 4. Generated ID format and parser agreement (UUID validation)
// ===========================================================================
section("Correction 4: generateClaimId UUID validation");

{
  const id = generateClaimId(UUID_A, 0, 0);
  assertEq(id, `${UUID_A}:0:0`, "accepts canonical lowercase UUID");
  assert(isGlobalClaimId(id), "generated ID is recognized by isGlobalClaimId");
  const parsed = parseClaimId(id);
  assert(parsed !== null && parsed.format === "global", "parseClaimId returns global format");
  assertEq(parsed?.document_id, UUID_A, "parseClaimId extracts correct document_id");
}

assertThrows(
  () => generateClaimId(NON_UUID, 0, 0),
  "rejects non-UUID documentId",
  "canonical lowercase UUID"
);

assertThrows(
  () => generateClaimId(UUID_A.toUpperCase(), 0, 0),
  "rejects uppercase UUID",
  "canonical lowercase UUID"
);

assertThrows(
  () => generateClaimId("", 0, 0),
  "rejects empty string",
  "non-empty documentId"
);

assert(CANONICAL_UUID_PATTERN.test(UUID_A), "CANONICAL_UUID_PATTERN matches UUID_A");
assert(CANONICAL_UUID_PATTERN.test(UUID_B), "CANONICAL_UUID_PATTERN matches UUID_B");
assert(!CANONICAL_UUID_PATTERN.test(NON_UUID), "CANONICAL_UUID_PATTERN rejects NON_UUID");
assert(!CANONICAL_UUID_PATTERN.test("not-a-uuid"), "CANONICAL_UUID_PATTERN rejects arbitrary string");

{
  const id = generateClaimId(UUID_A, 3, 7);
  const parsed = parseClaimId(id);
  assertEq(parsed?.chunk_index, 3, "chunk_index round-trips through generate+parse");
  assertEq(parsed?.claim_index, 7, "claim_index round-trips through generate+parse");
}

// ===========================================================================
// 5. Fail explicitly when claim-ID injection cannot parse the extraction
// ===========================================================================
section("Correction 5: injectClaimIds throws on parse failure");

assertThrows(
  () => injectClaimIds("This is not JSON at all.", 0, UUID_A),
  "throws on non-JSON input",
  "Failed to parse extraction JSON"
);

assertThrows(
  () => injectClaimIds('{"key_claims": [{"text": "unfinished', 2, UUID_A),
  "throws on truncated JSON",
  "Failed to parse extraction JSON"
);

assertThrows(
  () => injectClaimIds("not json", 0, UUID_A),
  "error message includes documentId",
  UUID_A
);

{
  const valid = JSON.stringify({
    key_claims: [{ text: "Revenue grew 20%" }, { text: "Margins stable" }],
  });
  const result = injectClaimIds(valid, 1, UUID_A);
  const parsed = JSON.parse(result);
  assertEq(parsed.key_claims[0].id, `${UUID_A}:1:0`, "valid JSON: injects correct ID for claim 0");
  assertEq(parsed.key_claims[1].id, `${UUID_A}:1:1`, "valid JSON: injects correct ID for claim 1");
}

{
  const valid = JSON.stringify({ key_claims: [], other: "data" });
  const result = injectClaimIds(valid, 0, UUID_A);
  const parsed = JSON.parse(result);
  assertEq(parsed.key_claims.length, 0, "empty key_claims: succeeds without error");
  assertEq(parsed.other, "data", "empty key_claims: preserves other fields");
}

{
  const valid = JSON.stringify({ summary: "no claims" });
  const result = injectClaimIds(valid, 0, UUID_A);
  const parsed = JSON.parse(result);
  assertEq(parsed.summary, "no claims", "JSON without key_claims: succeeds and preserves data");
}

{
  const fenced = '```json\n{"key_claims": [{"text": "claim"}]}\n```';
  const result = injectClaimIds(fenced, 0, UUID_A);
  const parsed = JSON.parse(result);
  assertEq(parsed.key_claims[0].id, `${UUID_A}:0:0`, "strips markdown fences before parsing");
}

// ===========================================================================
// 2. Tie the map to its source/extraction generation (fingerprint)
// ===========================================================================
section("Correction 2: Fingerprint computation and verification");

const routed = [
  { document_id: UUID_A, chunk_index: 0 },
  { document_id: UUID_A, chunk_index: 1 },
  { document_id: UUID_B, chunk_index: 0 },
];
const pipelineVersion = "abc123def456";

{
  const fp = computeOriginMapFingerprint(routed, pipelineVersion);
  const sortedDocIds = [UUID_A, UUID_B].sort();
  assertEq(fp.documentIds[0], sortedDocIds[0], "fingerprint: first documentId sorted correctly");
  assertEq(fp.documentIds[1], sortedDocIds[1], "fingerprint: second documentId sorted correctly");
  assertEq(fp.chunkCount, 3, "fingerprint: chunkCount correct");
  assertEq(fp.pipelineVersion, pipelineVersion, "fingerprint: pipelineVersion correct");
  assertEq(fp.schemaVersion, CLAIM_ORIGIN_MAP_VERSION, "fingerprint: schemaVersion correct");
}

{
  const fp = computeOriginMapFingerprint(routed, pipelineVersion);
  assertEq(compareFingerprints(fp, fp), null, "compareFingerprints returns null for identical");
}

{
  const fp1 = computeOriginMapFingerprint(routed, pipelineVersion);
  const fp2 = { ...fp1, pipelineVersion: "different999" };
  const mismatch = compareFingerprints(fp1, fp2);
  assert(mismatch !== null && mismatch.includes("pipelineVersion"), "detects pipeline version mismatch");
}

{
  const fp1 = computeOriginMapFingerprint(routed, pipelineVersion);
  const fp2 = { ...fp1, chunkCount: 99 };
  const mismatch = compareFingerprints(fp1, fp2);
  assert(mismatch !== null && mismatch.includes("chunkCount"), "detects chunk count mismatch");
}

{
  const fp1 = computeOriginMapFingerprint(routed, pipelineVersion);
  const fp2 = { ...fp1, documentIds: [...fp1.documentIds.slice(0, -1), "zzzzzzzz-0000-0000-0000-000000000000"] };
  const mismatch = compareFingerprints(fp1, fp2);
  assert(mismatch !== null && mismatch.includes("documentIds diverge"), "detects document ID divergence");
}

{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${UUID_A}:0:0`, document_id: UUID_A, filename: "a.pdf", chunk_index: 0, claim_index: 0, source_page: null },
  ];
  const map = buildClaimOriginMap(entries);
  const fp = computeOriginMapFingerprint(routed, pipelineVersion);
  const serialized = serializeOriginMap(map, fp);
  assertEq(serialized.fingerprint?.pipelineVersion, pipelineVersion, "serializeOriginMap embeds fingerprint");
}

{
  const entries: ClaimOriginEntry[] = [];
  const map = buildClaimOriginMap(entries);
  const serialized = serializeOriginMap(map);
  assertEq(serialized.fingerprint, null, "serializeOriginMap with no fingerprint sets null");
}

// ===========================================================================
// 1. Distinguish missing checkpoint from corrupt checkpoint (deserializeOriginMap)
// ===========================================================================
section("Correction 1: deserializeOriginMap fail-closed behavior");

const testFp: OriginMapFingerprint = {
  documentIds: [UUID_A],
  chunkCount: 1,
  pipelineVersion: "testver",
  schemaVersion: CLAIM_ORIGIN_MAP_VERSION,
};

{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${UUID_A}:0:0`, document_id: UUID_A, filename: "f.pdf", chunk_index: 0, claim_index: 0, source_page: null },
  ];
  const serialized = serializeOriginMap(buildClaimOriginMap(entries), testFp);
  assertNoThrow(
    () => deserializeOriginMap(serialized),
    "valid payload without expectedFingerprint succeeds"
  );
}

{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${UUID_A}:0:0`, document_id: UUID_A, filename: "f.pdf", chunk_index: 0, claim_index: 0, source_page: null },
  ];
  const serialized = serializeOriginMap(buildClaimOriginMap(entries), testFp);
  assertNoThrow(
    () => deserializeOriginMap(serialized, testFp),
    "valid payload with matching fingerprint succeeds"
  );
}

assertThrows(
  () => deserializeOriginMap(null),
  "throws on null payload (corrupt)",
  "not an object"
);

assertThrows(
  () => deserializeOriginMap({ version: 999, entries: [], ambiguousLegacyIds: [] }),
  "throws on unsupported version",
  "Unsupported origin map version"
);

{
  const noFpPayload = {
    version: CLAIM_ORIGIN_MAP_VERSION,
    entries: [],
    ambiguousLegacyIds: [],
    fingerprint: null,
  };
  assertThrows(
    () => deserializeOriginMap(noFpPayload, testFp),
    "throws when fingerprint expected but stored map has none",
    "persisted map has no fingerprint"
  );
}

{
  const staleFingerprint: OriginMapFingerprint = {
    ...testFp,
    pipelineVersion: "old-version",
  };
  const stalePayload = {
    version: CLAIM_ORIGIN_MAP_VERSION,
    entries: [],
    ambiguousLegacyIds: [],
    fingerprint: staleFingerprint,
  };
  assertThrows(
    () => deserializeOriginMap(stalePayload, testFp),
    "throws on fingerprint mismatch (stale map)",
    "fingerprint mismatch"
  );
}

{
  // A payload with a stale fingerprint should NOT throw when no expected fingerprint is given
  const staleFingerprint: OriginMapFingerprint = {
    ...testFp,
    pipelineVersion: "old-version",
  };
  const payload = {
    version: CLAIM_ORIGIN_MAP_VERSION,
    entries: [],
    ambiguousLegacyIds: [],
    fingerprint: staleFingerprint,
  };
  assertNoThrow(
    () => deserializeOriginMap(payload),
    "fingerprint check does NOT run when no expected fingerprint provided"
  );
}

// ===========================================================================
// 3. Remove production fallback to legacy IDs (injectClaimIds requires documentId)
// ===========================================================================
section("Correction 3: injectClaimIds requires documentId (no fallback)");

assertThrows(
  () => injectClaimIds(JSON.stringify({ key_claims: [{ text: "x" }] }), 0, ""),
  "throws when documentId is empty string",
  "documentId is REQUIRED"
);

assertThrows(
  () => injectClaimIds(JSON.stringify({ key_claims: [{ text: "x" }] }), 0, null as unknown as string),
  "throws when documentId is null cast",
  "documentId is REQUIRED"
);

// ===========================================================================
// Bonus: version bump
// ===========================================================================
section("Version bump");
assertEq(CLAIM_ORIGIN_MAP_VERSION, 3, "CLAIM_ORIGIN_MAP_VERSION is 3");

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`Final corrective tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED ✓");
}
