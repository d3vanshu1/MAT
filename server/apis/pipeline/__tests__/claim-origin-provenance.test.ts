/**
 * Fix 1 — Globally Unique Claim IDs and Explicit Provenance
 *
 * Validates:
 * 1. Two documents' first claims receive different IDs (no collision)
 * 2. Reprocessing identical input produces identical IDs (determinism)
 * 3. Routed-array reordering does not change provenance
 * 4. Pre-existing source_docs remain intact (union, not replace)
 * 5. Duplicate global IDs fail explicitly
 * 6. Legacy ambiguous IDs do not receive fabricated provenance
 * 7. Checkpoint serialization/reload preserves IDs and origin mapping
 *
 * Run: npx tsx server/apis/pipeline/__tests__/claim-origin-provenance.test.ts
 *
 * Parent: 2bb9bfa9f46c4705c661b3ed315bb3c530129cb5
 * Expected: FAIL on parent (claim-origin-map.ts does not exist), PASS after fix.
 */

import { injectClaimIds, injectClaimIdsLegacy } from "../extraction-prompt.js";
import {
  generateClaimId,
  parseClaimId,
  isGlobalClaimId,
  isLegacyClaimId,
  buildClaimOriginMap,
  buildOriginMapFromRoutedArray,
  resolveProvenance,
  serializeOriginMap,
  deserializeOriginMap,
  type ClaimOriginEntry,
} from "../claim-origin-map.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`  FAIL: ${msg}`); failed++; } else { passed++; }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { console.error(`  FAIL [${label}]: expected ${b}, got ${a}`); failed++; }
  else { passed++; }
}

function assertThrows(fn: () => void, pattern: RegExp, label: string): void {
  try {
    fn();
    console.error(`  FAIL [${label}]: expected throw matching ${pattern}, but no error thrown`);
    failed++;
  } catch (err: any) {
    if (pattern.test(err.message)) {
      passed++;
    } else {
      console.error(`  FAIL [${label}]: expected error matching ${pattern}, got: ${err.message}`);
      failed++;
    }
  }
}

function section(name: string): void {
  console.log(`\n=== ${name} ===`);
}

// ─── Test data ──────────────────────────────────────────────────────────────

const DOC_A_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const DOC_B_ID = "bbbbbbbb-5555-6666-7777-888888888888";
const DOC_A_FILE = "IC_Memo_Alpha.pdf";
const DOC_B_FILE = "Financial_Model_Beta.xlsx";

function makeFakeExtractionJson(documentId: string, chunkIndex: number, claimCount: number): string {
  const claims = Array.from({ length: claimCount }, (_, i) => ({
    claim: `Claim ${i} content`,
    location: `Page ${i + 1}`,
  }));
  const raw = JSON.stringify({ key_claims: claims, raw_summary: "Test summary" });
  return injectClaimIds(raw, chunkIndex, documentId);
}

// ─── Test 1: Collision prevention ───────────────────────────────────────────

section("Test 1: Two documents' first claims receive different IDs");
{
  const rawA = JSON.stringify({ key_claims: [{ claim: "Revenue is £10m" }] });
  const taggedA = injectClaimIds(rawA, 0, DOC_A_ID);
  const parsedA = JSON.parse(taggedA);

  const rawB = JSON.stringify({ key_claims: [{ claim: "EBITDA is £5m" }] });
  const taggedB = injectClaimIds(rawB, 0, DOC_B_ID);
  const parsedB = JSON.parse(taggedB);

  const idA = parsedA.key_claims[0].id;
  const idB = parsedB.key_claims[0].id;

  assert(idA !== idB, `IDs must differ: got "${idA}" and "${idB}"`);
  assert(isGlobalClaimId(idA), `ID A must be global format: "${idA}"`);
  assert(isGlobalClaimId(idB), `ID B must be global format: "${idB}"`);
  assert(idA.startsWith(DOC_A_ID), `ID A must contain doc A id`);
  assert(idB.startsWith(DOC_B_ID), `ID B must contain doc B id`);

  // Show the before/after:
  // BEFORE: both would be "c0-0" (COLLISION)
  const oldA = JSON.parse(injectClaimIdsLegacy(rawA, 0)); // no documentId = legacy
  const oldB = JSON.parse(injectClaimIdsLegacy(rawB, 0));
  assert(oldA.key_claims[0].id === "c0-0", `Legacy A should be c0-0`);
  assert(oldB.key_claims[0].id === "c0-0", `Legacy B should be c0-0`);
  assert(oldA.key_claims[0].id === oldB.key_claims[0].id, `Legacy IDs collide (expected behavior under old format)`);
  // AFTER: idA = "aaaaaaaa-1111-2222-3333-444444444444:0:0"
  //         idB = "bbbbbbbb-5555-6666-7777-888888888888:0:0"
  console.log(`  Before (legacy): both = "${oldA.key_claims[0].id}" — COLLISION`);
  console.log(`  After (global): A = "${idA}", B = "${idB}" — NO COLLISION`);
}

// ─── Test 2: Determinism ────────────────────────────────────────────────────

section("Test 2: Reprocessing identical input produces identical IDs");
{
  const raw = JSON.stringify({
    key_claims: [
      { claim: "Revenue grew 15%" },
      { claim: "Margins expanded 200bps" },
    ],
  });

  const result1 = JSON.parse(injectClaimIds(raw, 3, DOC_A_ID));
  const result2 = JSON.parse(injectClaimIds(raw, 3, DOC_A_ID));

  assertEq(result1.key_claims[0].id, result2.key_claims[0].id, "claim 0 stable");
  assertEq(result1.key_claims[1].id, result2.key_claims[1].id, "claim 1 stable");
  assertEq(result1.key_claims[0].id, `${DOC_A_ID}:3:0`, "expected format c[0]");
  assertEq(result1.key_claims[1].id, `${DOC_A_ID}:3:1`, "expected format c[1]");
}

// ─── Test 3: Routed-array reordering independence ───────────────────────────

section("Test 3: Routed-array reordering does not change provenance");
{
  const taggedA = makeFakeExtractionJson(DOC_A_ID, 0, 2);
  const taggedB = makeFakeExtractionJson(DOC_B_ID, 0, 2);

  const rowA = {
    document_id: DOC_A_ID,
    chunk_index: 0,
    extraction_json: { extraction: taggedA, documentId: DOC_A_ID, sourceFile: DOC_A_FILE },
  };
  const rowB = {
    document_id: DOC_B_ID,
    chunk_index: 0,
    extraction_json: { extraction: taggedB, documentId: DOC_B_ID, sourceFile: DOC_B_FILE },
  };

  const idToFileName = new Map([
    [DOC_A_ID, DOC_A_FILE],
    [DOC_B_ID, DOC_B_FILE],
  ]);

  // Order 1: [A, B]
  const map1 = buildOriginMapFromRoutedArray([rowA, rowB], idToFileName);
  // Order 2: [B, A] — reversed
  const map2 = buildOriginMapFromRoutedArray([rowB, rowA], idToFileName);

  const claimIdA = `${DOC_A_ID}:0:0`;
  const claimIdB = `${DOC_B_ID}:0:0`;

  const resA1 = resolveProvenance([claimIdA], map1);
  const resA2 = resolveProvenance([claimIdA], map2);
  assert(resA1.derivedSources.has(DOC_A_FILE), "A resolves to A file in order 1");
  assert(resA2.derivedSources.has(DOC_A_FILE), "A resolves to A file in order 2");
  assertEq([...resA1.derivedSources].sort(), [...resA2.derivedSources].sort(), "A provenance same both orders");

  const resB1 = resolveProvenance([claimIdB], map1);
  const resB2 = resolveProvenance([claimIdB], map2);
  assert(resB1.derivedSources.has(DOC_B_FILE), "B resolves to B file in order 1");
  assert(resB2.derivedSources.has(DOC_B_FILE), "B resolves to B file in order 2");
  assertEq([...resB1.derivedSources].sort(), [...resB2.derivedSources].sort(), "B provenance same both orders");
}

// ─── Test 4: source_docs union ──────────────────────────────────────────────

section("Test 4: Pre-existing source_docs remain intact (union, not replace)");
{
  const entries: ClaimOriginEntry[] = [{
    claim_id: `${DOC_A_ID}:0:0`,
    document_id: DOC_A_ID,
    filename: DOC_A_FILE,
    chunk_index: 0,
    claim_index: 0,
    source_page: null,
  }];
  const originMap = buildClaimOriginMap(entries);

  const finding = {
    title: "Test Finding",
    source_docs: ["Existing_Report.pdf", "Another_Doc.pdf"],
    claim_ids: [`${DOC_A_ID}:0:0`],
  };

  const resolution = resolveProvenance(finding.claim_ids, originMap);

  // Simulate the pipeline's union logic
  const existingSources = new Set(finding.source_docs);
  for (const src of resolution.derivedSources) existingSources.add(src);
  const merged = Array.from(existingSources);

  assert(merged.includes("Existing_Report.pdf"), "original source preserved");
  assert(merged.includes("Another_Doc.pdf"), "original source preserved (2)");
  assert(merged.includes(DOC_A_FILE), "derived source added");
  assertEq(merged.length, 3, "union has 3 entries");
}

// ─── Test 5: Duplicate IDs fail closed ──────────────────────────────────────

section("Test 5: Duplicate IDs fail explicitly");
{
  const entries: ClaimOriginEntry[] = [
    {
      claim_id: `${DOC_A_ID}:0:0`,
      document_id: DOC_A_ID,
      filename: DOC_A_FILE,
      chunk_index: 0,
      claim_index: 0,
      source_page: null,
    },
    {
      claim_id: `${DOC_A_ID}:0:0`, // DUPLICATE
      document_id: DOC_B_ID,
      filename: DOC_B_FILE,
      chunk_index: 0,
      claim_index: 0,
      source_page: null,
    },
  ];

  assertThrows(() => buildClaimOriginMap(entries), /DUPLICATE claim_id/, "duplicate global ID throws");

  // Also verify deserialization rejects duplicates
  const serialized = {
    version: 1,
    entries: [
      { claim_id: `${DOC_A_ID}:0:0`, document_id: DOC_A_ID, filename: DOC_A_FILE, chunk_index: 0, claim_index: 0, source_page: null },
      { claim_id: `${DOC_A_ID}:0:0`, document_id: DOC_A_ID, filename: DOC_A_FILE, chunk_index: 0, claim_index: 0, source_page: null },
    ],
  };
  assertThrows(() => deserializeOriginMap(serialized), /DUPLICATE/, "deserialize rejects duplicates");
}

// ─── Test 6: Legacy IDs — no fabricated provenance ──────────────────────────

section("Test 6: Legacy ambiguous IDs do not receive fabricated provenance");
{
  // Origin map with only new-format IDs
  const entries: ClaimOriginEntry[] = [{
    claim_id: `${DOC_A_ID}:0:0`,
    document_id: DOC_A_ID,
    filename: DOC_A_FILE,
    chunk_index: 0,
    claim_index: 0,
    source_page: null,
  }];
  const originMap = buildClaimOriginMap(entries);

  // Legacy IDs not in map
  const resolution = resolveProvenance(["c0-0", "c5-2", "c12-0"], originMap);
  assertEq(resolution.derivedSources.size, 0, "no fabricated provenance");
  assertEq(resolution.unresolvedLegacy.length, 3, "all legacy IDs unresolved");
  assert(resolution.unresolvedLegacy.includes("c0-0"), "c0-0 unresolved");
  assert(resolution.unresolvedLegacy.includes("c5-2"), "c5-2 unresolved");
  assert(resolution.unresolvedLegacy.includes("c12-0"), "c12-0 unresolved");

  // Legacy IDs that ARE in the map (from scanning) resolve correctly
  const entriesWithLegacy: ClaimOriginEntry[] = [{
    claim_id: "c0-0",
    document_id: DOC_A_ID,
    filename: DOC_A_FILE,
    chunk_index: 0,
    claim_index: 0,
    source_page: null,
  }];
  const mapWithLegacy = buildClaimOriginMap(entriesWithLegacy);
  const resLegacy = resolveProvenance(["c0-0"], mapWithLegacy);
  assert(resLegacy.derivedSources.has(DOC_A_FILE), "known legacy ID resolves");
  assertEq(resLegacy.unresolvedLegacy.length, 0, "known legacy not unresolved");
}

// ─── Test 7: Checkpoint serialization/reload roundtrip ──────────────────────

section("Test 7: Checkpoint serialization/reload preserves IDs and origin mapping");
{
  const entries: ClaimOriginEntry[] = [
    { claim_id: `${DOC_A_ID}:0:0`, document_id: DOC_A_ID, filename: DOC_A_FILE, chunk_index: 0, claim_index: 0, source_page: "p.3" },
    { claim_id: `${DOC_A_ID}:0:1`, document_id: DOC_A_ID, filename: DOC_A_FILE, chunk_index: 0, claim_index: 1, source_page: null },
    { claim_id: `${DOC_B_ID}:2:0`, document_id: DOC_B_ID, filename: DOC_B_FILE, chunk_index: 2, claim_index: 0, source_page: "Table 4" },
  ];
  const original = buildClaimOriginMap(entries);
  const serialized = serializeOriginMap(original);
  const reloaded = deserializeOriginMap(serialized);

  assertEq(reloaded.entries.size, 3, "roundtrip preserves size");
  assertEq(reloaded.version, original.version, "roundtrip preserves version");

  const entry0 = reloaded.entries.get(`${DOC_A_ID}:0:0`);
  assert(entry0 !== undefined, "entry A:0:0 exists after reload");
  assertEq(entry0!.document_id, DOC_A_ID, "entry A:0:0 doc_id");
  assertEq(entry0!.filename, DOC_A_FILE, "entry A:0:0 filename");
  assertEq(entry0!.source_page, "p.3", "entry A:0:0 source_page");

  const entryB = reloaded.entries.get(`${DOC_B_ID}:2:0`);
  assert(entryB !== undefined, "entry B:2:0 exists after reload");
  assertEq(entryB!.document_id, DOC_B_ID, "entry B:2:0 doc_id");
  assertEq(entryB!.chunk_index, 2, "entry B:2:0 chunk_index");

  // Provenance resolution same after roundtrip
  const resOrig = resolveProvenance([`${DOC_A_ID}:0:0`], original);
  const resReloaded = resolveProvenance([`${DOC_A_ID}:0:0`], reloaded);
  assertEq([...resOrig.derivedSources].sort(), [...resReloaded.derivedSources].sort(), "provenance same after roundtrip");
}

// ─── Additional: parseClaimId + generateClaimId ─────────────────────────────

section("Utility: parseClaimId and generateClaimId");
{
  const global = parseClaimId(`${DOC_A_ID}:3:7`);
  assert(global !== null, "global parsed");
  assertEq(global!.format, "global", "format=global");
  assertEq(global!.document_id, DOC_A_ID, "doc_id parsed");
  assertEq(global!.chunk_index, 3, "chunk_index");
  assertEq(global!.claim_index, 7, "claim_index");

  const legacy = parseClaimId("c5-2");
  assert(legacy !== null, "legacy parsed");
  assertEq(legacy!.format, "legacy", "format=legacy");
  assertEq(legacy!.chunk_index, 5, "legacy chunk_index");
  assertEq(legacy!.claim_index, 2, "legacy claim_index");

  assert(parseClaimId("invalid") === null, "invalid returns null");
  assert(parseClaimId("") === null, "empty returns null");

  const generated = generateClaimId(DOC_A_ID, 2, 5);
  assertEq(generated, `${DOC_A_ID}:2:5`, "generateClaimId format");
  assert(isGlobalClaimId(generated), "generated is global format");
  assert(!isLegacyClaimId(generated), "generated is not legacy format");
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} assertions passed`);
}
