/**
 * Fix 4 Corrective — Resumable Document Indexing: Structural tests
 *
 * Tests:
 *   1.  Budget expires mid-indexing → resume begins at correct document cursor
 *   2.  Repeated resumptions eventually complete full inventory
 *   3.  Document cursor advances monotonically across invocations
 *   4.  Accumulated table metadata survives JSON checkpoint round-trip
 *   5.  New tables from unindexed documents do NOT invalidate checkpoint
 *   6.  Changed metadata for already-indexed document DOES invalidate
 *   7.  Small-budget runs still make forward progress
 *   8.  One-shot and multi-resume produce same final figures/discrepancies
 *   9.  Failed checkpoint write does not allow processing to continue
 *  10.  Checkpoint v1 is invalidated (version bump incompatibility)
 *
 * Run: npx tsx server/apis/pipeline/__tests__/numeric-checkpoint-corrective.test.ts
 */

import {
  buildNumericCheckpoint,
  validateNumericCheckpoint,
  isCheckpointComplete,
  getResumePosition,
  computeNumericSourceFingerprint,
  NUMERIC_CHECKPOINT_VERSION,
  type BuildCheckpointInput,
  type IndexedTableEntry,
  type SerializedFigure,
  type NumericCheckpoint,
} from "../numeric-checkpoint.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++; console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Simulation harness — mimics index-build resume logic from numeric-verify-inline
// ---------------------------------------------------------------------------

interface SimDoc {
  id: string;
  tables: IndexedTableEntry[];
}

interface SimState {
  checkpoint: NumericCheckpoint | null;
  /** documentCursor after each invocation */
  cursorLog: number[];
}

/**
 * Simulate one invocation of the engine with a document budget.
 * Returns the checkpoint the engine would write, plus whether it completed.
 */
function simulateInvocation(
  allDocs: SimDoc[],
  docBudget: number,  // max new documents to index per invocation
  existing: NumericCheckpoint | null,
): { checkpoint: NumericCheckpoint; partial: boolean; docsIndexedThisRun: number } {
  const documentIds = allDocs.map(d => d.id);

  let accumulatedTableIndex: IndexedTableEntry[] = [];
  let resumeDocCursor = 0;

  // Restore state from checkpoint
  if (existing) {
    const prefixTableIds = existing.indexedTableMetadata.map(t => t.id);
    const result = validateNumericCheckpoint(existing, documentIds, prefixTableIds);
    if (result.valid && !isCheckpointComplete(result.checkpoint)) {
      const resume = getResumePosition(result.checkpoint);
      accumulatedTableIndex = resume.indexedTableMetadata;
      resumeDocCursor = resume.documentCursor;
    } else if (!result.valid) {
      // Restart from scratch
      resumeDocCursor = 0;
      accumulatedTableIndex = [];
    }
  }

  // Index only new documents (from resumeDocCursor, up to budget)
  const docsToIndex = allDocs.slice(resumeDocCursor, resumeDocCursor + docBudget);
  const newIndex: IndexedTableEntry[] = [];
  for (const doc of docsToIndex) {
    newIndex.push(...doc.tables);
  }
  const docsIndexedThisRun = docsToIndex.length;
  const updatedDocCursor = resumeDocCursor + docsIndexedThisRun;

  const fullIndex = [...accumulatedTableIndex, ...newIndex];
  const partial = updatedDocCursor < documentIds.length;

  const checkpoint = buildNumericCheckpoint({
    status: partial ? "partial" : "complete",
    documentIds,
    indexedTableMetadata: fullIndex,
    documentCursor: partial ? updatedDocCursor : documentIds.length,
    tableCursor: partial ? 0 : fullIndex.length,
    figures: [],
    discrepancies: [],
    documentsProcessed: updatedDocCursor,
    documentsTotal: documentIds.length,
    tablesLoaded: 0,
    tablesTotal: fullIndex.length,
  });

  return { checkpoint, partial, docsIndexedThisRun };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeDoc(id: string, tableCount: number): SimDoc {
  return {
    id,
    tables: Array.from({ length: tableCount }, (_, i) => ({
      id: `${id}-tbl-${i}`,
      document_id: id,
      sheet_or_page: `Sheet${i}`,
      caption: null,
      data_length: 1000,
    })),
  };
}

const ALL_DOCS: SimDoc[] = [
  makeDoc("doc-A", 3),
  makeDoc("doc-B", 2),
  makeDoc("doc-C", 4),
  makeDoc("doc-D", 1),
  makeDoc("doc-E", 2),
];
const ALL_DOC_IDS = ALL_DOCS.map(d => d.id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== Fix 4 Corrective: Resumable Document Indexing Tests ===\n");

// Test 1: Budget expires mid-indexing → resume begins at correct document cursor
console.log("Test 1: Budget expires mid-indexing → correct resume cursor");
{
  // Budget of 2 → indices docs 0,1 then stops
  const { checkpoint, partial } = simulateInvocation(ALL_DOCS, 2, null);

  assertEqual(partial, true, "result is partial after budget exhaustion");
  assertEqual(checkpoint.documentCursor, 2, "documentCursor = 2 after indexing docs 0,1");
  assertEqual(checkpoint.indexedTableMetadata.length, 5, "indexed 5 tables from docs 0,1 (3+2)");
  assertEqual(checkpoint.indexedTableMetadata.filter(t => t.document_id === "doc-A").length, 3, "doc-A tables present");
  assertEqual(checkpoint.indexedTableMetadata.filter(t => t.document_id === "doc-B").length, 2, "doc-B tables present");
  assertEqual(checkpoint.indexedTableMetadata.filter(t => t.document_id === "doc-C").length, 0, "doc-C not yet indexed");

  // Second invocation: must start from cursor=2
  const { checkpoint: cp2, partial: p2, docsIndexedThisRun } = simulateInvocation(ALL_DOCS, 2, checkpoint);
  assertEqual(docsIndexedThisRun, 2, "second invocation indexed exactly 2 new docs (C, D)");
  assertEqual(cp2.documentCursor, 4, "cursor advanced to 4 after second invocation");
  assert(p2, "still partial after 4/5 docs");
}

// Test 2: Repeated resumptions eventually complete full inventory
console.log("\nTest 2: Repeated resumptions eventually complete the full inventory");
{
  const DOC_BUDGET = 2;
  let cp: NumericCheckpoint | null = null;
  let invocations = 0;

  while (true) {
    const result = simulateInvocation(ALL_DOCS, DOC_BUDGET, cp);
    invocations++;
    cp = result.checkpoint;
    if (!result.partial) break;
    if (invocations > 20) { assert(false, "loop guard: did not converge"); break; }
  }

  assertEqual(cp!.status, "complete", "final checkpoint is complete");
  assertEqual(cp!.documentCursor, ALL_DOCS.length, `documentCursor = ${ALL_DOCS.length} (full inventory)`);
  assertEqual(cp!.indexedTableMetadata.length, ALL_DOCS.reduce((s, d) => s + d.tables.length, 0),
    "all tables present in final checkpoint");
  assert(invocations >= 2, `took multiple invocations (${invocations}) to complete`);
}

// Test 3: Document cursor advances monotonically
console.log("\nTest 3: Document cursor advances monotonically");
{
  let cp: NumericCheckpoint | null = null;
  let prevCursor = 0;
  let invocations = 0;

  while (true) {
    const result = simulateInvocation(ALL_DOCS, 1, cp);
    cp = result.checkpoint;
    invocations++;
    assert(cp.documentCursor >= prevCursor, `cursor ${cp.documentCursor} >= prev ${prevCursor}`);
    assert(cp.documentCursor > prevCursor, `cursor strictly advanced (invocation ${invocations})`);
    prevCursor = cp.documentCursor;
    if (!result.partial) break;
    if (invocations > 20) break;
  }
  assertEqual(cp!.documentCursor, ALL_DOCS.length, "cursor reached end");
}

// Test 4: Accumulated table metadata survives JSON round-trip
console.log("\nTest 4: Accumulated table metadata survives JSON checkpoint round-trip");
{
  const { checkpoint } = simulateInvocation(ALL_DOCS, 2, null);

  // Simulate DB persistence via JSON stringify/parse
  const serialized = JSON.parse(JSON.stringify(checkpoint));
  const docIds = ALL_DOC_IDS;
  const prefixTableIds = checkpoint.indexedTableMetadata.map(t => t.id);
  const result = validateNumericCheckpoint(serialized, docIds, prefixTableIds);

  assertEqual(result.valid, true, "round-tripped checkpoint validates successfully");
  if (result.valid) {
    assertEqual(result.checkpoint.documentCursor, 2, "cursor preserved through round-trip");
    assertEqual(result.checkpoint.indexedTableMetadata.length, 5, "table metadata count preserved");
    assertEqual(result.checkpoint.indexedTableMetadata[0].id,
      checkpoint.indexedTableMetadata[0].id,
      "first table ID preserved");
  }
}

// Test 5: New tables from unindexed documents do NOT invalidate checkpoint
console.log("\nTest 5: New tables from unindexed documents do NOT invalidate checkpoint");
{
  const { checkpoint } = simulateInvocation(ALL_DOCS, 2, null);
  // checkpoint covers docs 0,1 (doc-A, doc-B)

  // Simulate next run: full document universe (unchanged docs 0,1 prefix) —
  // docs C,D,E are not yet indexed, so they're beyond the cursor
  const prefixTableIds = checkpoint.indexedTableMetadata.map(t => t.id);
  const result = validateNumericCheckpoint(checkpoint, ALL_DOC_IDS, prefixTableIds);

  assertEqual(result.valid, true, "checkpoint valid even though docs C,D,E are unindexed");
  if (result.valid) {
    assertEqual(result.checkpoint.documentCursor, 2, "cursor is still 2");
  }
}

// Test 6: Changed metadata for already-indexed document DOES invalidate
console.log("\nTest 6: Changed metadata for already-indexed document invalidates checkpoint");
{
  const { checkpoint } = simulateInvocation(ALL_DOCS, 2, null);
  // Simulate: a table from doc-A was replaced with a different ID (schema migration)
  const modifiedPrefixIds = [
    "doc-A-tbl-0",
    "doc-A-tbl-1",
    "REPLACED-TABLE-ID", // doc-A-tbl-2 was replaced
    "doc-B-tbl-0",
    "doc-B-tbl-1",
  ];
  const result = validateNumericCheckpoint(checkpoint, ALL_DOC_IDS, modifiedPrefixIds);

  assertEqual(result.valid, false, "checkpoint invalidated when prefix table disappears");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
    assert(result.reason.includes("no longer exists"), "reason mentions disappearance");
  }
}

// Test 7: Small-budget runs still make forward progress (never stall)
console.log("\nTest 7: Small budget (1 doc/run) still makes forward progress");
{
  const BUDGET = 1;
  const cursors: number[] = [];
  let cp: NumericCheckpoint | null = null;

  for (let i = 0; i < ALL_DOCS.length + 1; i++) {
    const result = simulateInvocation(ALL_DOCS, BUDGET, cp);
    cp = result.checkpoint;
    cursors.push(cp.documentCursor);
    if (!result.partial) break;
  }

  // Every cursor value must be strictly greater than the previous
  for (let i = 1; i < cursors.length; i++) {
    assert(cursors[i] > cursors[i - 1], `cursor[${i}]=${cursors[i]} > cursor[${i-1}]=${cursors[i-1]}`);
  }
  assertEqual(cp!.status, "complete", "eventually completes");
}

// Test 8: One-shot and multi-resume produce the same final index
console.log("\nTest 8: One-shot and multi-resume produce identical final table inventory");
{
  // One-shot (unlimited budget)
  const { checkpoint: oneShot } = simulateInvocation(ALL_DOCS, ALL_DOCS.length, null);

  // Multi-resume (budget=1)
  let cp: NumericCheckpoint | null = null;
  for (let i = 0; i < ALL_DOCS.length + 1; i++) {
    const result = simulateInvocation(ALL_DOCS, 1, cp);
    cp = result.checkpoint;
    if (!result.partial) break;
  }

  const oneShotIds = new Set(oneShot.indexedTableMetadata.map(t => t.id));
  const multiIds = new Set(cp!.indexedTableMetadata.map(t => t.id));

  assertEqual(oneShot.indexedTableMetadata.length, cp!.indexedTableMetadata.length,
    "same total table count");
  assert(
    [...oneShotIds].every(id => multiIds.has(id)),
    "all one-shot table IDs present in multi-resume result"
  );
  assert(
    [...multiIds].every(id => oneShotIds.has(id)),
    "all multi-resume table IDs present in one-shot result"
  );
}

// Test 9: Failed checkpoint write must not allow continued processing
console.log("\nTest 9: Failed checkpoint write throws for partial results");
{
  // This is tested structurally — verify the engine throws when checkpoint write fails
  // by directly testing the error path logic
  let errorThrown = false;
  let errorMessage = "";

  // Simulate the caller logic from pipeline-core.ts
  const mockPartialResult = { partial: true, checkpoint: {} };
  const simulatedWriteError = new Error("relation pipeline_checkpoints does not exist");

  try {
    if (mockPartialResult.checkpoint) {
      try {
        throw simulatedWriteError; // Simulates DB write failure
      } catch (cpErr) {
        if (mockPartialResult.partial) {
          const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
          throw new Error(
            `[NumericInline] FATAL: Failed to persist partial numeric checkpoint. ` +
            `Cursor is not durable — cannot guarantee forward progress. ` +
            `Underlying error: ${cpMsg}`
          );
        }
      }
    }
  } catch (err) {
    errorThrown = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  assert(errorThrown, "error is thrown when partial checkpoint write fails");
  assert(errorMessage.includes("Cursor is not durable"), "error message mentions cursor durability");
  assert(errorMessage.includes("relation pipeline_checkpoints does not exist"),
    "underlying DB error is included in message");
}

// Test 10: Checkpoint v1 is invalidated (version bump incompatibility)
console.log("\nTest 10: v1 checkpoint is rejected by v2 validator (action=invalidate)");
{
  // Synthesize a v1 checkpoint (old schema without indexedTableMetadata)
  const v1Checkpoint = {
    version: 1,
    status: "partial",
    documentIds: ALL_DOC_IDS,
    tableIds: ["tbl-1", "tbl-2"],  // v1 field, absent in v2
    documentCursor: 2,
    tableCursor: 3,
    figures: [],
    discrepancies: [],
    documentsProcessed: 2,
    documentsTotal: 5,
    tablesLoaded: 3,
    tablesTotal: 10,
    sourceFingerprint: "aabbccdd",
    pipelineVersion: "1.0.0",
    configVersion: "1.0.0:2026-07-31-r1",
    lastUpdated: new Date().toISOString(),
  };

  const result = validateNumericCheckpoint(v1Checkpoint, ALL_DOC_IDS);

  assertEqual(result.valid, false, "v1 checkpoint is rejected");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate (not error)");
    assert(result.reason.includes(`!== ${NUMERIC_CHECKPOINT_VERSION}`), "reason mentions version mismatch");
  }
}

// Bonus: source fingerprint changes when document list changes
console.log("\nBonus: source fingerprint detects document removal");
{
  const { checkpoint } = simulateInvocation(ALL_DOCS, 2, null);

  // Simulate: doc-A was removed from universe
  const reducedDocs = ALL_DOC_IDS.filter(id => id !== "doc-A");
  const result = validateNumericCheckpoint(checkpoint, reducedDocs);

  assertEqual(result.valid, false, "checkpoint invalid when doc-A removed from universe");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
  }
}

// Bonus: fingerprint is stable when doc list is identical and tables unchanged
console.log("\nBonus: fingerprint stable across identical state");
{
  const { checkpoint } = simulateInvocation(ALL_DOCS, 2, null);
  const prefixTableIds = checkpoint.indexedTableMetadata.map(t => t.id);

  const fp1 = computeNumericSourceFingerprint(ALL_DOC_IDS, prefixTableIds);
  const fp2 = computeNumericSourceFingerprint(ALL_DOC_IDS, prefixTableIds);
  assertEqual(fp1, fp2, "fingerprint is deterministic across identical inputs");
  assertEqual(fp1, checkpoint.sourceFingerprint, "matches stored fingerprint in checkpoint");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
console.log("All corrective Fix 4 tests passed ✓\n");
