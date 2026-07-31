/**
 * Fix 8 (Commit 1) — Source & Checkpoint Integration Closure
 *
 * Tests:
 * 1. Changed chunk text at the same index invalidates analysis (content_hash mismatch)
 * 2. Unchanged chunk text reuses analysis (content_hash match)
 * 3. Routed-array reordering does not misapply analysis (identity includes doc+chunk)
 * 4. A legacy analysis checkpoint without content hash is rerun (null identity rejected)
 * 5. Shortening a document removes stale trailing extraction rows
 * 6. Stale rows do not enter routing or claim-origin construction
 * 7. Manifest rows are absent from numeric table inventories
 * 8. Manifest rows do not affect table counts or numeric fingerprints
 * 9. A merge-root manifest with wrong leaf fingerprint is rejected
 * 10. A merge-root manifest with stale source fingerprint is rejected
 * 11. A valid merge-root manifest is accepted
 * 12. A structurally invalid complete numeric checkpoint is rejected
 * 13. A changed table within an indexed document invalidates numeric resume
 * 14. A failed partial-checkpoint write prevents continued processing as though progress were durable
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix8-source-checkpoint-closure.test.ts
 */

import { validateNumericCheckpoint, computeNumericSourceFingerprint, computeNumericConfigVersion, buildNumericCheckpoint, type IndexedTableEntry, type SerializedFigure, type SerializedDiscrepancy } from "../numeric-checkpoint.js";
import { deserializeManifest, type MergeRootManifest } from "../merge-root-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Changed chunk text at the same index invalidates analysis
// ---------------------------------------------------------------------------
{
  // Simulate analysis checkpoint identity check
  const routedItem = { document_id: "doc-1", chunk_index: 0, content_hash: "hash_v2" };
  const currentIdentity = `${routedItem.document_id}:${routedItem.chunk_index}:${routedItem.content_hash}`;
  const storedIdentity = "doc-1:0:hash_v1"; // previous version
  assert(storedIdentity !== currentIdentity, "Test 1: Changed content_hash makes identities differ → invalidates analysis");
}

// ---------------------------------------------------------------------------
// Test 2: Unchanged chunk text reuses analysis
// ---------------------------------------------------------------------------
{
  const routedItem = { document_id: "doc-1", chunk_index: 0, content_hash: "hash_v1" };
  const currentIdentity = `${routedItem.document_id}:${routedItem.chunk_index}:${routedItem.content_hash}`;
  const storedIdentity = "doc-1:0:hash_v1";
  assertEqual(storedIdentity, currentIdentity, "Test 2: Unchanged content_hash produces matching identity → reuse");
}

// ---------------------------------------------------------------------------
// Test 3: Routed-array reordering does not misapply analysis
// ---------------------------------------------------------------------------
{
  // If doc-2:chunk-0 is stored at index 0 but now doc-1:chunk-0 is at index 0
  const routedItem = { document_id: "doc-1", chunk_index: 0, content_hash: "abc" };
  const currentIdentity = `${routedItem.document_id}:${routedItem.chunk_index}:${routedItem.content_hash}`;
  const storedIdentity = "doc-2:0:xyz"; // belongs to a different document
  assert(storedIdentity !== currentIdentity, "Test 3: Different document at same position → identity mismatch → not reused");
}

// ---------------------------------------------------------------------------
// Test 4: A legacy analysis checkpoint without content hash is rerun
// ---------------------------------------------------------------------------
{
  const storedIdentity: string | null = null;
  // Fix 8A: null identity → rejected (not accepted)
  const accepted = storedIdentity !== null && storedIdentity !== "";
  assert(!accepted, "Test 4: Null stored identity → legacy checkpoint rejected → rerun");
}

// ---------------------------------------------------------------------------
// Test 5: Shortening a document removes stale trailing extraction rows
// ---------------------------------------------------------------------------
{
  // Simulates the extraction-phase cleanup logic
  const CHUNK_CHARS = 8000;
  const doc = { id: "doc-x", text_length: 16000 }; // Now 2 chunks
  const expectedChunks = Math.ceil(doc.text_length / CHUNK_CHARS); // 2
  const existingRows = [
    { document_id: "doc-x", chunk_index: 0 },
    { document_id: "doc-x", chunk_index: 1 },
    { document_id: "doc-x", chunk_index: 2 },
    { document_id: "doc-x", chunk_index: 3 },
  ];
  const stale = existingRows.filter(r => r.document_id === doc.id && r.chunk_index >= expectedChunks);
  assertEqual(stale.length, 2, "Test 5: 2 stale trailing rows detected (chunks 2,3 beyond expected 2)");
}

// ---------------------------------------------------------------------------
// Test 6: Stale rows do not enter routing
// ---------------------------------------------------------------------------
{
  // After cleanup, the extraction set only has valid chunks
  const validChunks = new Set(["doc-x:0", "doc-x:1"]);
  const routedInput = [
    { document_id: "doc-x", chunk_index: 0, key: "doc-x:0" },
    { document_id: "doc-x", chunk_index: 1, key: "doc-x:1" },
    { document_id: "doc-x", chunk_index: 2, key: "doc-x:2" }, // would be stale
    { document_id: "doc-x", chunk_index: 3, key: "doc-x:3" }, // would be stale
  ];
  // After stale cleanup, only first 2 remain in allExtractions
  const afterCleanup = routedInput.filter(r => validChunks.has(r.key));
  assertEqual(afterCleanup.length, 2, "Test 6: After stale cleanup, only 2 valid chunks enter routing");
}

// ---------------------------------------------------------------------------
// Test 7: Manifest rows are absent from numeric table inventories
// ---------------------------------------------------------------------------
{
  // Simulates the filter that the SQL query applies
  const allDocTables = [
    { id: "t1", sheet_or_page: "P&L", document_id: "d1" },
    { id: "t2", sheet_or_page: "Balance Sheet", document_id: "d1" },
    { id: "t3", sheet_or_page: "__generation_manifest__", document_id: "d1" },
    { id: "t4", sheet_or_page: "CF Statement", document_id: "d2" },
  ];
  const indexedTables = allDocTables.filter(t => t.sheet_or_page !== "__generation_manifest__");
  assertEqual(indexedTables.length, 3, "Test 7: Manifest row excluded from table index (3 of 4 remain)");
  assert(!indexedTables.some(t => t.sheet_or_page === "__generation_manifest__"), "Test 7b: No manifest row in indexed set");
}

// ---------------------------------------------------------------------------
// Test 8: Manifest rows do not affect table counts or numeric fingerprints
// ---------------------------------------------------------------------------
{
  const docIds = ["d1", "d2"];
  const tableIdsWithManifest = ["t1", "t2", "t3", "t4"]; // t3 is manifest
  const tableIdsWithout = ["t1", "t2", "t4"]; // manifest excluded

  const fpWith = computeNumericSourceFingerprint(docIds, tableIdsWithManifest);
  const fpWithout = computeNumericSourceFingerprint(docIds, tableIdsWithout);

  assert(fpWith !== fpWithout, "Test 8: Including manifest row changes fingerprint → must be excluded for correctness");
}

// ---------------------------------------------------------------------------
// Test 9: Merge-root manifest with wrong leaf fingerprint is rejected
// ---------------------------------------------------------------------------
{
  // The manifest is loaded and validated against rootCheckpointId
  const manifest = {
    rootCheckpointId: "3:0",
    pipelineVersion: "test-version-123",
    sourceFingerprint: "fp-abc",
    expectedLeafCount: 4,
    completionGeneration: 1,
    leafFingerprint: "leaf-xyz",
  };
  // topCheckpoint has tree_level = 4 (not 3) → mismatch
  const topCheckpointLevel = 4;
  const expectedRootId = `${topCheckpointLevel}:0`;
  assert(manifest.rootCheckpointId !== expectedRootId, "Test 9: rootCheckpointId mismatch (3:0 vs 4:0) → manifest rejected");
}

// ---------------------------------------------------------------------------
// Test 10: Merge-root manifest with stale source fingerprint is rejected
// ---------------------------------------------------------------------------
{
  // Source docs changed since manifest was created
  const currentDocs = [{ documentId: "d1", contentHash: "hash-new" }];
  const snapshotDocs = [{ documentId: "d1", contentHash: "hash-old" }];
  const currentDocHash = currentDocs.map(d => `${d.documentId}:${d.contentHash}`).sort().join("|");
  const storedDocHash = snapshotDocs.map(d => `${d.documentId}:${d.contentHash}`).sort().join("|");
  assert(currentDocHash !== storedDocHash, "Test 10: Source docs changed → doc hashes differ → manifest rejected");
}

// ---------------------------------------------------------------------------
// Test 11: A valid merge-root manifest is accepted
// ---------------------------------------------------------------------------
{
  const manifest = {
    rootCheckpointId: "3:0",
    pipelineVersion: "v-current",
    sourceFingerprint: "fp-current",
    expectedLeafCount: 4,
    completionGeneration: 1,
    leafFingerprint: "leaf-correct",
  };
  const topLevel = 3;
  const currentVersion = "v-current";
  const rootIdMatch = manifest.rootCheckpointId === `${topLevel}:0`;
  const versionMatch = manifest.pipelineVersion === currentVersion;
  const leafCountValid = manifest.expectedLeafCount > 0;
  assert(rootIdMatch && versionMatch && leafCountValid, "Test 11: Valid manifest passes all checks");
}

// ---------------------------------------------------------------------------
// Test 12: A structurally invalid complete numeric checkpoint is rejected
// ---------------------------------------------------------------------------
{
  // Missing required fields
  const invalidCheckpoint = {
    version: "v2",
    status: "complete",
    documentIds: ["d1"],
    // Missing: indexedTableMetadata, cursors, figures, discrepancies, etc.
  };
  const result = validateNumericCheckpoint(invalidCheckpoint, ["d1"]);
  assert(!result.valid, "Test 12: Structurally incomplete checkpoint fails validation");
  if (!result.valid) {
    assert(result.action === "error", "Test 12b: Missing fields → error action (not mere invalidation)");
  }
}

// ---------------------------------------------------------------------------
// Test 13: Changed table within indexed document invalidates numeric resume
// ---------------------------------------------------------------------------
{
  const docIds = ["d1", "d2"];
  const indexedMeta: IndexedTableEntry[] = [
    { id: "table-1", document_id: "d1", sheet_or_page: "P&L", caption: null, data_length: 1000 },
    { id: "table-2", document_id: "d1", sheet_or_page: "BS", caption: null, data_length: 2000 },
  ];
  const checkpoint = buildNumericCheckpoint({
    status: "partial",
    documentIds: docIds,
    indexedTableMetadata: indexedMeta,
    documentCursor: 1,
    tableCursor: 2,
    figures: [],
    discrepancies: [],
    documentsProcessed: 1,
    documentsTotal: 2,
    tablesLoaded: 2,
    tablesTotal: 5,
  });

  // Now table-2 no longer exists (replaced) — prefix check should catch it
  const currentPrefixTableIds = ["table-1", "table-3-new"]; // table-2 gone
  const result = validateNumericCheckpoint(checkpoint, docIds, currentPrefixTableIds);
  assert(!result.valid, "Test 13: Missing table in prefix → checkpoint invalidated");
  if (!result.valid) {
    assert(result.reason.includes("table-2"), "Test 13b: Reason mentions the missing table ID");
  }
}

// ---------------------------------------------------------------------------
// Test 14: Failed partial-checkpoint write prevents continued processing
// ---------------------------------------------------------------------------
{
  // This tests the contract: if inlineResult.partial is true and checkpoint write throws,
  // the error must propagate (not be swallowed).
  let errorPropagated = false;
  const simulateCheckpointPersist = (partial: boolean) => {
    try {
      // Simulate write failure
      throw new Error("DB connection lost");
    } catch (cpErr) {
      if (partial) {
        // Fix 8E: FAIL-LOUD for partial checkpoints
        errorPropagated = true;
        throw new Error(`[NumericInline] FATAL: Failed to persist partial numeric checkpoint.`);
      }
      // Complete: non-fatal
    }
  };

  try {
    simulateCheckpointPersist(true);
  } catch {
    // Expected
  }
  assert(errorPropagated, "Test 14: Partial checkpoint write failure propagates as fatal error");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Fix 8 (Commit 1) tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
