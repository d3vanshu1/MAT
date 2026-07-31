/**
 * Corrective commit test: ambiguous legacy IDs + durable origin map persistence.
 *
 * Tests fail on parent 3602bb7 and pass after the correction.
 *
 * Parent: 3602bb7362168f22bd66d9ccdf6148baeacff117
 *
 * Run: npx tsx server/apis/pipeline/__tests__/claim-origin-corrective.test.ts
 */

import {
  buildClaimOriginMap,
  buildOriginMapFromRoutedArray,
  resolveProvenance,
  serializeOriginMap,
  deserializeOriginMap,
  generateClaimId,
  parseClaimId,
  isLegacyClaimId,
  isGlobalClaimId,
  CLAIM_ORIGIN_MAP_VERSION,
  type ClaimOriginEntry,
  type ClaimOriginMap,
} from "../claim-origin-map.js";
import { injectClaimIds, injectClaimIdsLegacy } from "../extraction-prompt.js";

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
function assertThrows(fn: () => void, msg: string, expectedSubstring?: string) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${msg} — expected throw, got no error`);
    failed++;
  } catch (err: any) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      console.error(`  ✗ FAIL: ${msg} — got "${err.message}", expected substring "${expectedSubstring}"`);
      failed++;
    } else {
      console.log(`  ✓ ${msg}`);
      passed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const DOC_A = "aaaaaaaa-1111-2222-3333-444444444444";
const DOC_B = "bbbbbbbb-5555-6666-7777-888888888888";
const FILE_A = "FinancialStatements.pdf";
const FILE_B = "TenantRoll.xlsx";

function makeLegacyExtraction(docId: string, chunkIndex: number, claimCount: number): string {
  const claims = Array.from({ length: claimCount }, (_, i) => ({
    id: `c${chunkIndex}-${i}`,
    claim: `Claim ${i} from ${docId}`,
  }));
  return JSON.stringify({ key_claims: claims });
}

function makeGlobalExtraction(docId: string, chunkIndex: number, claimCount: number): string {
  const claims = Array.from({ length: claimCount }, (_, i) => ({
    id: `${docId}:${chunkIndex}:${i}`,
    claim: `Claim ${i} from ${docId} chunk ${chunkIndex}`,
  }));
  return JSON.stringify({ key_claims: claims });
}

function buildRoutedArray(items: Array<{ docId: string; chunkIndex: number; extraction: string }>) {
  return items.map(i => ({
    document_id: i.docId,
    chunk_index: i.chunkIndex,
    extraction_json: `### Universal Extraction from: test\n\n${i.extraction}`,
  }));
}

// ===========================================================================
// TEST 1: Two documents with legacy c0-0 yield no derived source
// ===========================================================================
section("Test 1: Two documents with legacy c0-0 yield NO derived source (ambiguous)");
{
  const routed = buildRoutedArray([
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) },
    { docId: DOC_B, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_B, 0, 2) },
  ]);
  const idToFileName = new Map([[DOC_A, FILE_A], [DOC_B, FILE_B]]);
  const map = buildOriginMapFromRoutedArray(routed, idToFileName);

  // c0-0 and c0-1 should be AMBIGUOUS (different documents)
  assert(map.ambiguousLegacyIds.has("c0-0"), "c0-0 is ambiguous");
  assert(map.ambiguousLegacyIds.has("c0-1"), "c0-1 is ambiguous");
  assert(!map.entries.has("c0-0"), "c0-0 NOT in resolvable entries");
  assert(!map.entries.has("c0-1"), "c0-1 NOT in resolvable entries");

  // resolveProvenance returns them as unresolved
  const resolution = resolveProvenance(["c0-0", "c0-1"], map);
  assertEq(resolution.derivedSources.size, 0, "no derived sources from ambiguous IDs");
  assertEq(resolution.unresolvedLegacy.length, 2, "both IDs unresolved");
}

// ===========================================================================
// TEST 2: Reversing routed order produces the same unresolved result
// ===========================================================================
section("Test 2: Reversing routed order produces SAME unresolved result");
{
  // Order A, B
  const routedAB = buildRoutedArray([
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) },
    { docId: DOC_B, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_B, 0, 2) },
  ]);
  // Order B, A (reversed)
  const routedBA = buildRoutedArray([
    { docId: DOC_B, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_B, 0, 2) },
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) },
  ]);
  const idToFileName = new Map([[DOC_A, FILE_A], [DOC_B, FILE_B]]);

  const mapAB = buildOriginMapFromRoutedArray(routedAB, idToFileName);
  const mapBA = buildOriginMapFromRoutedArray(routedBA, idToFileName);

  // Both must have the same ambiguous set
  assert(mapAB.ambiguousLegacyIds.has("c0-0"), "AB: c0-0 ambiguous");
  assert(mapBA.ambiguousLegacyIds.has("c0-0"), "BA: c0-0 ambiguous");

  const resAB = resolveProvenance(["c0-0"], mapAB);
  const resBA = resolveProvenance(["c0-0"], mapBA);

  assertEq(resAB.derivedSources.size, 0, "AB: no derived source");
  assertEq(resBA.derivedSources.size, 0, "BA: no derived source");
  assertEq(resAB.unresolvedLegacy.length, 1, "AB: unresolved");
  assertEq(resBA.unresolvedLegacy.length, 1, "BA: unresolved");
}

// ===========================================================================
// TEST 3: A unique legacy ID follows compatibility behavior
// ===========================================================================
section("Test 3: Unique legacy ID resolves via compatibility path");
{
  // DOC_A has chunk 0, DOC_B has chunk 1 — no collision since different chunk indices
  const routed = buildRoutedArray([
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) },
    { docId: DOC_B, chunkIndex: 1, extraction: makeLegacyExtraction(DOC_B, 1, 2) },
  ]);
  const idToFileName = new Map([[DOC_A, FILE_A], [DOC_B, FILE_B]]);
  const map = buildOriginMapFromRoutedArray(routed, idToFileName);

  // c0-0 is unique (only from DOC_A), c1-0 is unique (only from DOC_B)
  assert(map.ambiguousLegacyIds.size === 0, "no ambiguous IDs");
  assert(map.entries.has("c0-0"), "c0-0 resolvable (unique)");
  assert(map.entries.has("c1-0"), "c1-0 resolvable (unique)");

  const res0 = resolveProvenance(["c0-0"], map);
  assert(res0.derivedSources.has(FILE_A), "c0-0 resolves to FILE_A");
  assertEq(res0.unresolvedLegacy.length, 0, "no unresolved");

  const res1 = resolveProvenance(["c1-0"], map);
  assert(res1.derivedSources.has(FILE_B), "c1-0 resolves to FILE_B");
}

// ===========================================================================
// TEST 4: Ambiguous legacy IDs survive serialization/reload
// ===========================================================================
section("Test 4: Ambiguous legacy IDs survive serialization/reload");
{
  const routed = buildRoutedArray([
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 3) },
    { docId: DOC_B, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_B, 0, 3) },
  ]);
  const idToFileName = new Map([[DOC_A, FILE_A], [DOC_B, FILE_B]]);
  const original = buildOriginMapFromRoutedArray(routed, idToFileName);

  // Serialize and deserialize
  const serialized = serializeOriginMap(original);
  const restored = deserializeOriginMap(serialized);

  // Ambiguous set must be preserved
  assert(restored.ambiguousLegacyIds.has("c0-0"), "restored: c0-0 ambiguous");
  assert(restored.ambiguousLegacyIds.has("c0-1"), "restored: c0-1 ambiguous");
  assert(restored.ambiguousLegacyIds.has("c0-2"), "restored: c0-2 ambiguous");
  assert(!restored.entries.has("c0-0"), "restored: c0-0 NOT resolvable");

  // Provenance still unresolved
  const res = resolveProvenance(["c0-0", "c0-1", "c0-2"], restored);
  assertEq(res.derivedSources.size, 0, "no derived sources after reload");
  assertEq(res.unresolvedLegacy.length, 3, "all 3 unresolved after reload");
}

// ===========================================================================
// TEST 5: Checkpoint write persists the origin map (structure validation)
// ===========================================================================
section("Test 5: Checkpoint payload structure is correct for persistence");
{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 0, source_page: "p.3" },
    { claim_id: `${DOC_A}:0:1`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 1, source_page: null },
    { claim_id: `${DOC_B}:1:0`, document_id: DOC_B, filename: FILE_B, chunk_index: 1, claim_index: 0, source_page: "Table 2" },
  ];
  const map = buildClaimOriginMap(entries);
  const serialized = serializeOriginMap(map);

  // Validate the payload structure that would be stored in pipeline_checkpoints
  assertEq(serialized.version, CLAIM_ORIGIN_MAP_VERSION, "version present");
  assertEq(serialized.entries.length, 3, "3 entries");
  assert(Array.isArray(serialized.ambiguousLegacyIds), "ambiguousLegacyIds is array");
  assertEq(serialized.ambiguousLegacyIds.length, 0, "no ambiguous IDs in this case");

  // Verify JSON serialization is clean (what gets stored in jsonb)
  const jsonPayload = JSON.stringify(serialized);
  const parsed = JSON.parse(jsonPayload);
  assertEq(parsed.version, CLAIM_ORIGIN_MAP_VERSION, "version survives JSON roundtrip");
  assertEq(parsed.entries.length, 3, "entries survive JSON roundtrip");
  assertEq(parsed.entries[0].source_page, "p.3", "source_page preserved");
}

// ===========================================================================
// TEST 6: Resume loads persisted map and resolves same provenance
// ===========================================================================
section("Test 6: Deserialize produces same resolution as original");
{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 0, source_page: null },
    { claim_id: `${DOC_A}:1:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 1, claim_index: 0, source_page: null },
    { claim_id: `${DOC_B}:0:0`, document_id: DOC_B, filename: FILE_B, chunk_index: 0, claim_index: 0, source_page: null },
  ];
  const original = buildClaimOriginMap(entries);
  const serialized = JSON.parse(JSON.stringify(serializeOriginMap(original)));
  const restored = deserializeOriginMap(serialized);

  // Resolve same claim_ids
  const resOrig = resolveProvenance([`${DOC_A}:0:0`, `${DOC_B}:0:0`], original);
  const resRestore = resolveProvenance([`${DOC_A}:0:0`, `${DOC_B}:0:0`], restored);

  assert(resOrig.derivedSources.has(FILE_A) && resOrig.derivedSources.has(FILE_B), "original resolves both");
  assert(resRestore.derivedSources.has(FILE_A) && resRestore.derivedSources.has(FILE_B), "restored resolves both");
  assertEq(resOrig.derivedSources.size, resRestore.derivedSources.size, "same source count");
  assertEq(resOrig.unresolvedLegacy.length, resRestore.unresolvedLegacy.length, "same unresolved count");
}

// ===========================================================================
// TEST 7: Malformed or duplicate persisted map fails closed
// ===========================================================================
section("Test 7: Malformed/duplicate persisted map fails closed");
{
  // Null payload
  assertThrows(
    () => deserializeOriginMap(null),
    "null payload rejects",
    "not an object"
  );

  // Missing entries
  assertThrows(
    () => deserializeOriginMap({ version: CLAIM_ORIGIN_MAP_VERSION }),
    "missing entries rejects",
    "entries is not an array"
  );

  // Unsupported version (too high)
  assertThrows(
    () => deserializeOriginMap({ version: 999, entries: [] }),
    "unsupported version rejects",
    "Unsupported origin map version"
  );

  // Version 0 (too low)
  assertThrows(
    () => deserializeOriginMap({ version: 0, entries: [] }),
    "version 0 rejects",
    "Unsupported origin map version"
  );

  // Duplicate global IDs
  const dupEntries = [
    { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 0, source_page: null },
    { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 0, source_page: null },
  ];
  assertThrows(
    () => deserializeOriginMap({ version: CLAIM_ORIGIN_MAP_VERSION, entries: dupEntries, ambiguousLegacyIds: [] }),
    "duplicate global ID rejects",
    "DUPLICATE global claim_id"
  );

  // Malformed entry (missing claim_id)
  assertThrows(
    () => deserializeOriginMap({ version: CLAIM_ORIGIN_MAP_VERSION, entries: [{ document_id: DOC_A }], ambiguousLegacyIds: [] }),
    "missing claim_id rejects",
    "missing claim_id"
  );
}

// ===========================================================================
// TEST 8: Global ID coordinate mismatch fails validation
// ===========================================================================
section("Test 8: Global ID coordinate mismatch fails validation");
{
  // document_id mismatch
  assertThrows(
    () => buildClaimOriginMap([
      { claim_id: `${DOC_A}:0:0`, document_id: DOC_B, filename: FILE_B, chunk_index: 0, claim_index: 0, source_page: null },
    ]),
    "document_id mismatch rejects",
    "coordinate mismatch"
  );

  // chunk_index mismatch
  assertThrows(
    () => buildClaimOriginMap([
      { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 5, claim_index: 0, source_page: null },
    ]),
    "chunk_index mismatch rejects",
    "coordinate mismatch"
  );

  // claim_index mismatch
  assertThrows(
    () => buildClaimOriginMap([
      { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 7, source_page: null },
    ]),
    "claim_index mismatch rejects",
    "coordinate mismatch"
  );
}

// ===========================================================================
// TEST 9: Existing valid source_docs remain preserved
// ===========================================================================
section("Test 9: Existing source_docs union behavior");
{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${DOC_A}:0:0`, document_id: DOC_A, filename: FILE_A, chunk_index: 0, claim_index: 0, source_page: null },
    { claim_id: `${DOC_B}:1:0`, document_id: DOC_B, filename: FILE_B, chunk_index: 1, claim_index: 0, source_page: null },
  ];
  const map = buildClaimOriginMap(entries);

  // Simulate a finding that already has source_docs with a manually-specified doc
  const existingDocs = ["ManuallyTagged.pdf", FILE_A];
  const finding = { claim_ids: [`${DOC_A}:0:0`, `${DOC_B}:1:0`], source_docs: [...existingDocs] };

  const resolution = resolveProvenance(finding.claim_ids, map);

  // Union: existing + derived
  const merged = new Set([...finding.source_docs, ...resolution.derivedSources]);
  assert(merged.has("ManuallyTagged.pdf"), "existing manual doc preserved");
  assert(merged.has(FILE_A), "FILE_A in merged");
  assert(merged.has(FILE_B), "FILE_B derived from claim");
  assertEq(merged.size, 3, "3 total unique sources (no narrowing)");
}

// ===========================================================================
// TEST 10: Production claim creation without documentId fails
// ===========================================================================
section("Test 10: Production injectClaimIds without documentId fails");
{
  const raw = JSON.stringify({ key_claims: [{ claim: "Test" }] });

  // Production path requires documentId
  assertThrows(
    () => injectClaimIds(raw, 0, ""),
    "empty string documentId fails",
    "documentId is REQUIRED"
  );

  // Legacy helper still works
  const legacyResult = JSON.parse(injectClaimIdsLegacy(raw, 0));
  assertEq(legacyResult.key_claims[0].id, "c0-0", "legacy helper produces c0-0");

  // Production path with valid documentId works
  const prodResult = JSON.parse(injectClaimIds(raw, 0, DOC_A));
  assertEq(prodResult.key_claims[0].id, `${DOC_A}:0:0`, "production path produces global ID");
}

// ===========================================================================
// BONUS TEST: Legacy IDs from same document are NOT ambiguous (dedup)
// ===========================================================================
section("Bonus: Same-document legacy IDs are deduplicated, not ambiguous");
{
  // Two chunks from same document both at index 0 (unlikely but tests dedup logic)
  const routed = buildRoutedArray([
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) },
    { docId: DOC_A, chunkIndex: 0, extraction: makeLegacyExtraction(DOC_A, 0, 2) }, // duplicate from same doc
  ]);
  const idToFileName = new Map([[DOC_A, FILE_A]]);
  const map = buildOriginMapFromRoutedArray(routed, idToFileName);

  // Same document → NOT ambiguous, just deduplicated
  assert(map.ambiguousLegacyIds.size === 0, "no ambiguous IDs (same doc)");
  assert(map.entries.has("c0-0"), "c0-0 resolvable (same doc dedup)");

  const res = resolveProvenance(["c0-0"], map);
  assert(res.derivedSources.has(FILE_A), "resolves to FILE_A");
  assertEq(res.unresolvedLegacy.length, 0, "no unresolved");
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${"═".repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}
