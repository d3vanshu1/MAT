/**
 * Legacy Reference Semantics — Regression Test
 *
 * PROVEN FROM CODE: The historical producer of `c{N}-{M}` references is
 * `extraction-prompt.ts:injectClaimIdsLegacy()`.
 *
 * SEMANTICS:
 *   - N = chunkIndex (0-based per-document sequential chunk number)
 *   - M = idx (0-based position in that chunk's `key_claims` array)
 *
 * The chunkIndex is DOCUMENT-LOCAL: it's the sequential chunk created by
 * `chunkDocument(fileName, documentId, parsedText)`. If a document has
 * 4 chunks, they are numbered 0, 1, 2, 3. A different document ALSO
 * starts at 0. Therefore, `c0-0` from Document A and `c0-0` from
 * Document B are DIFFERENT claims — the legacy format COLLIDES across documents.
 *
 * This test directly exercises the original generation logic to prove
 * the semantic invariants.
 */

import { injectClaimIdsLegacy, chunkDocument } from "../extraction-prompt.js";
import { parseLegacyRef } from "../legacy-claim-reconciler.js";
import { parseClaimId, isLegacyClaimId, isGlobalClaimId } from "../claim-origin-map.js";

// ---------------------------------------------------------------------------
// Test framework (no external runner — self-verifying)
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];
function assert(condition: boolean, name: string, detail: string = "") {
  results.push({ name, passed: condition, detail: condition ? "OK" : detail || "FAILED" });
}

// ---------------------------------------------------------------------------
// Test 1: injectClaimIdsLegacy produces c{chunkIndex}-{idx} format
// ---------------------------------------------------------------------------
(() => {
  const rawJson = JSON.stringify({
    key_claims: [
      { metric: "Revenue", value: 100, period: "FY26" },
      { metric: "EBITDA", value: 50, period: "FY26" },
      { metric: "NRR", value: 110, period: "FY26" },
    ],
  });

  // chunkIndex=0 (first chunk of a document)
  const result0 = JSON.parse(injectClaimIdsLegacy(rawJson, 0));
  assert(result0.key_claims[0].id === "c0-0", "chunk0_claim0_id", `Expected c0-0, got ${result0.key_claims[0].id}`);
  assert(result0.key_claims[1].id === "c0-1", "chunk0_claim1_id", `Expected c0-1, got ${result0.key_claims[1].id}`);
  assert(result0.key_claims[2].id === "c0-2", "chunk0_claim2_id", `Expected c0-2, got ${result0.key_claims[2].id}`);

  // chunkIndex=3 (fourth chunk of a document)
  const result3 = JSON.parse(injectClaimIdsLegacy(rawJson, 3));
  assert(result3.key_claims[0].id === "c3-0", "chunk3_claim0_id", `Expected c3-0, got ${result3.key_claims[0].id}`);
  assert(result3.key_claims[1].id === "c3-1", "chunk3_claim1_id", `Expected c3-1, got ${result3.key_claims[1].id}`);
  assert(result3.key_claims[2].id === "c3-2", "chunk3_claim2_id", `Expected c3-2, got ${result3.key_claims[2].id}`);

  // chunkIndex=12 (large chunk index)
  const result12 = JSON.parse(injectClaimIdsLegacy(rawJson, 12));
  assert(result12.key_claims[0].id === "c12-0", "chunk12_claim0_id", `Expected c12-0, got ${result12.key_claims[0].id}`);
})();

// ---------------------------------------------------------------------------
// Test 2: chunkDocument produces 0-based per-document sequential chunks
// ---------------------------------------------------------------------------
(() => {
  // Short document → single chunk at index 0
  const shortChunks = chunkDocument("short.pdf", "uuid-short", "Hello world");
  assert(shortChunks.length === 1, "short_single_chunk", `Expected 1 chunk, got ${shortChunks.length}`);
  assert(shortChunks[0].chunkIndex === 0, "short_chunk_index_0", `Expected chunkIndex=0, got ${shortChunks[0].chunkIndex}`);

  // Long document → multiple chunks, sequential from 0
  const longText = "A".repeat(25001); // Exceeds CHUNK_CHARS (25000)
  const longChunks = chunkDocument("long.pdf", "uuid-long", longText);
  assert(longChunks.length === 2, "long_two_chunks", `Expected 2 chunks, got ${longChunks.length}`);
  assert(longChunks[0].chunkIndex === 0, "long_chunk0_index", `Expected 0, got ${longChunks[0].chunkIndex}`);
  assert(longChunks[1].chunkIndex === 1, "long_chunk1_index", `Expected 1, got ${longChunks[1].chunkIndex}`);

  // Very long document → 3+ chunks
  const veryLongText = "B".repeat(60000);
  const veryLongChunks = chunkDocument("vlong.pdf", "uuid-vlong", veryLongText);
  assert(veryLongChunks.length === 3, "vlong_three_chunks", `Expected 3 chunks, got ${veryLongChunks.length}`);
  for (let i = 0; i < veryLongChunks.length; i++) {
    assert(veryLongChunks[i].chunkIndex === i, `vlong_chunk${i}_sequential`, `Expected ${i}, got ${veryLongChunks[i].chunkIndex}`);
  }
})();

// ---------------------------------------------------------------------------
// Test 3: Document-local collision — same positions in different docs yield same IDs
// ---------------------------------------------------------------------------
(() => {
  const claims = JSON.stringify({
    key_claims: [{ metric: "Revenue", value: 200, period: "FY26" }],
  });

  // Document A, chunk 0
  const docA = JSON.parse(injectClaimIdsLegacy(claims, 0));
  // Document B, chunk 0 (different document, same chunk index)
  const docB = JSON.parse(injectClaimIdsLegacy(claims, 0));

  // Both produce c0-0 — COLLISION BY DESIGN (legacy flaw)
  assert(
    docA.key_claims[0].id === docB.key_claims[0].id,
    "cross_document_collision",
    `Expected collision: ${docA.key_claims[0].id} === ${docB.key_claims[0].id}`
  );
  assert(
    docA.key_claims[0].id === "c0-0",
    "collision_value_is_c0_0",
    `Expected c0-0, got ${docA.key_claims[0].id}`
  );
})();

// ---------------------------------------------------------------------------
// Test 4: parseLegacyRef correctly decodes positional format
// ---------------------------------------------------------------------------
(() => {
  const parsed = parseLegacyRef("c3-7");
  assert(parsed.type === "positional", "parse_type_positional", `Got ${parsed.type}`);
  assert(parsed.chunkIndex === 3, "parse_chunkIndex_3", `Got ${parsed.chunkIndex}`);
  assert(parsed.claimIndex === 7, "parse_claimIndex_7", `Got ${parsed.claimIndex}`);

  const parsed2 = parseLegacyRef("c0-0");
  assert(parsed2.type === "positional", "parse_c0_0_type", `Got ${parsed2.type}`);
  assert(parsed2.chunkIndex === 0, "parse_c0_0_chunk", `Got ${parsed2.chunkIndex}`);
  assert(parsed2.claimIndex === 0, "parse_c0_0_claim", `Got ${parsed2.claimIndex}`);

  // Canonical format detected
  const canonical = parseLegacyRef("clm-v1-abc123def456");
  assert(canonical.type === "canonical", "parse_canonical", `Got ${canonical.type}`);

  // Slug format
  const slug = parseLegacyRef("revenue_fy26_divergence");
  assert(slug.type === "slug", "parse_slug", `Got ${slug.type}`);

  // Malformed
  const malformed = parseLegacyRef("x");
  assert(malformed.type === "malformed", "parse_malformed", `Got ${malformed.type}`);
})();

// ---------------------------------------------------------------------------
// Test 5: isLegacyClaimId vs isGlobalClaimId classification
// ---------------------------------------------------------------------------
(() => {
  assert(isLegacyClaimId("c0-0") === true, "isLegacy_c0_0");
  assert(isLegacyClaimId("c12-5") === true, "isLegacy_c12_5");
  assert(isLegacyClaimId("abc") === false, "isLegacy_abc_false");
  assert(isLegacyClaimId("clm-v1-abc123") === false, "isLegacy_canonical_false");

  const globalId = "a1b2c3d4-5678-90ab-cdef-111111111111:2:5";
  assert(isGlobalClaimId(globalId) === true, "isGlobal_uuid_format");
  assert(isGlobalClaimId("c0-0") === false, "isGlobal_legacy_false");
})();

// ---------------------------------------------------------------------------
// Test 6: parseClaimId extracts correct components from legacy format
// ---------------------------------------------------------------------------
(() => {
  const result = parseClaimId("c7-3");
  assert(result !== null, "parseClaimId_not_null");
  if (result) {
    assert(result.chunk_index === 7, "parseClaimId_chunk_7", `Got ${result.chunk_index}`);
    assert(result.claim_index === 3, "parseClaimId_claim_3", `Got ${result.claim_index}`);
  }

  // Non-legacy returns null
  const nonLegacy = parseClaimId("not-a-claim-id");
  assert(nonLegacy === null, "parseClaimId_null_for_nonlegacy");
})();

// ---------------------------------------------------------------------------
// Test 7: Semantic invariant — N is per-document chunk, NOT document index
// ---------------------------------------------------------------------------
(() => {
  // Simulate: Document with 3 chunks, each with 2 claims
  const chunk0Claims = JSON.parse(injectClaimIdsLegacy(
    JSON.stringify({ key_claims: [{ metric: "A" }, { metric: "B" }] }), 0
  ));
  const chunk1Claims = JSON.parse(injectClaimIdsLegacy(
    JSON.stringify({ key_claims: [{ metric: "C" }, { metric: "D" }] }), 1
  ));
  const chunk2Claims = JSON.parse(injectClaimIdsLegacy(
    JSON.stringify({ key_claims: [{ metric: "E" }] }), 2
  ));

  // Chunk 0: c0-0, c0-1
  assert(chunk0Claims.key_claims[0].id === "c0-0", "semantic_chunk0_first");
  assert(chunk0Claims.key_claims[1].id === "c0-1", "semantic_chunk0_second");
  // Chunk 1: c1-0, c1-1
  assert(chunk1Claims.key_claims[0].id === "c1-0", "semantic_chunk1_first");
  assert(chunk1Claims.key_claims[1].id === "c1-1", "semantic_chunk1_second");
  // Chunk 2: c2-0
  assert(chunk2Claims.key_claims[0].id === "c2-0", "semantic_chunk2_first");

  // KEY INVARIANT: The first number is chunk index, NOT document index
  // Document A: chunks [0,1,2] → refs c0-*, c1-*, c2-*
  // Document B: chunks [0,1] → refs c0-*, c1-*
  // c0-0 from A ≠ c0-0 from B (but same string → collision)
})();

// ---------------------------------------------------------------------------
// Test 8: injectClaimIdsLegacy handles edge cases
// ---------------------------------------------------------------------------
(() => {
  // Empty claims array
  const empty = JSON.parse(injectClaimIdsLegacy(JSON.stringify({ key_claims: [] }), 5));
  assert(empty.key_claims.length === 0, "empty_claims_handled");

  // JSON in code fence
  const fenced = "```json\n" + JSON.stringify({ key_claims: [{ m: "X" }] }) + "\n```";
  const fencedResult = JSON.parse(injectClaimIdsLegacy(fenced, 2));
  assert(fencedResult.key_claims[0].id === "c2-0", "fenced_json_handled", `Got ${fencedResult.key_claims[0]?.id}`);

  // Malformed JSON returns raw input
  const badJson = "not json at all";
  assert(injectClaimIdsLegacy(badJson, 0) === badJson, "malformed_json_passthrough");
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const total = results.length;

console.log(`\n=== Legacy Reference Semantics Regression Test ===`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log("FAILURES:");
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.detail}`);
  }
}

// Export for programmatic verification
export const testResults = { passed, failed, total, results };
export default { passed, failed, total };
