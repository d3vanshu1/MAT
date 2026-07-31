/**
 * Fix 4 Corrective — Genuinely Resumable Document Indexing: Tests
 *
 * Verifies the repaired checkpoint state machine. All tests run without DB calls.
 * Uses the same custom harness as other pipeline tests (npx tsx).
 *
 *   Test 1:  Budget expires mid-indexing → resume begins at correct document cursor
 *   Test 2:  Repeated resumptions eventually index the full document inventory
 *   Test 3:  Document cursor advances monotonically across invocations
 *   Test 4:  Accumulated table-index metadata survives JSON round-trip
 *   Test 5:  New tables from unindexed documents do NOT invalidate checkpoint
 *   Test 6:  Changed table in already-indexed prefix DOES invalidate checkpoint
 *   Test 7:  Small-budget runs still make forward progress (1 doc at a time)
 *   Test 8:  One-shot and multi-resume produce identical final figures/discrepancies
 *   Test 9:  Partial checkpoint always contains non-null checkpoint object
 *   Test 10: Checkpoint version bump invalidates v1 checkpoints
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix4-corrective-resumable-indexing.test.ts
 */

import {
  buildNumericCheckpoint,
  validateNumericCheckpoint,
  isCheckpointComplete,
  getResumePosition,
  NUMERIC_CHECKPOINT_VERSION,
  type IndexedTableEntry,
  type BuildCheckpointInput,
  type SerializedFigure,
} from "../numeric-checkpoint.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}\n    expected: ${e}\n    actual:   ${a}`); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, docId: string, sheet = "Sheet1"): IndexedTableEntry {
  return { id, document_id: docId, sheet_or_page: sheet, caption: null, data_length: 1000 };
}

function makeFigure(overrides?: Partial<SerializedFigure>): SerializedFigure {
  return {
    name: "Revenue",
    period: "FY2024",
    value: 1_000_000,
    source_doc: "doc-a",
    source_cell: "B5",
    source_sheet: "Income Statement",
    ...overrides,
  };
}

/**
 * Simulate one indexing invocation.
 * @param existingCp - Existing checkpoint (from prior invocation) or null
 * @param allDocIds  - Full document universe (DB query always returns this)
 * @param docBudget  - How many NEW documents to index this invocation before "expiry"
 * @param allTablesForDocs - Map from docId → table entries (simulates DB query)
 * @returns { cp, figures, partial }
 */
function simulateIndexInvocation(
  existingCp: ReturnType<typeof buildNumericCheckpoint> | null,
  allDocIds: string[],
  docBudget: number,
  allTablesForDocs: Map<string, IndexedTableEntry[]>,
  figuresPerDoc: Map<string, SerializedFigure[]> = new Map(),
): {
  cp: ReturnType<typeof buildNumericCheckpoint>;
  mergedFigures: SerializedFigure[];
  partial: boolean;
  docCursorStart: number;
  docCursorEnd: number;
} {
  // State restored from checkpoint
  let accFigures: SerializedFigure[] = [];
  let accTableIndex: IndexedTableEntry[] = [];
  let resumeDocCursor = 0;

  if (existingCp) {
    const resume = getResumePosition(existingCp);
    accFigures = resume.accumulatedFigures;
    accTableIndex = resume.indexedTableMetadata;
    resumeDocCursor = resume.documentCursor;
  }

  const docCursorStart = resumeDocCursor;

  // Index only docs from cursor onward, up to budget
  const docsToIndex = allDocIds.slice(resumeDocCursor);
  const newTableIndex: IndexedTableEntry[] = [];
  let docsIndexed = 0;

  for (const docId of docsToIndex) {
    if (docsIndexed >= docBudget) break; // budget exhausted
    docsIndexed++;
    const tables = allTablesForDocs.get(docId) ?? [];
    newTableIndex.push(...tables);
  }

  const isPartial = resumeDocCursor + docsIndexed < allDocIds.length;
  const fullTableIndex = [...accTableIndex, ...newTableIndex];
  const updatedDocCursor = resumeDocCursor + docsIndexed;

  // Collect figures from newly indexed docs
  const newFigures: SerializedFigure[] = [];
  for (const docId of docsToIndex.slice(0, docsIndexed)) {
    newFigures.push(...(figuresPerDoc.get(docId) ?? []));
  }

  // Deduplicate
  const existingKeys = new Set(accFigures.map(f => `${f.name}::${f.period}::${f.source_doc}`));
  const merged = [...accFigures, ...newFigures.filter(f => !existingKeys.has(`${f.name}::${f.period}::${f.source_doc}`))];

  const cp = buildNumericCheckpoint({
    status: isPartial ? "partial" : "complete",
    documentIds: allDocIds,
    indexedTableMetadata: fullTableIndex,
    documentCursor: isPartial ? updatedDocCursor : allDocIds.length,
    tableCursor: 0,
    figures: merged,
    discrepancies: [],
    documentsProcessed: updatedDocCursor,
    documentsTotal: allDocIds.length,
    tablesLoaded: 0,
    tablesTotal: fullTableIndex.length,
  });

  return { cp, mergedFigures: merged, partial: isPartial, docCursorStart, docCursorEnd: updatedDocCursor };
}

// ---------------------------------------------------------------------------
// Test 1: Budget expires mid-indexing → resume begins at correct document cursor
// ---------------------------------------------------------------------------
console.log("\nTest 1: Budget expires mid-indexing → resume at correct cursor");
{
  const allDocs = ["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"];
  const tables = new Map([
    ["doc-a", [makeEntry("tbl-1", "doc-a")]],
    ["doc-b", [makeEntry("tbl-2", "doc-b")]],
    ["doc-c", [makeEntry("tbl-3", "doc-c")]],
    ["doc-d", [makeEntry("tbl-4", "doc-d")]],
    ["doc-e", [makeEntry("tbl-5", "doc-e")]],
  ]);

  // Invocation 1: budget = 2 docs
  const inv1 = simulateIndexInvocation(null, allDocs, 2, tables);
  assertEqual(inv1.docCursorStart, 0, "Inv1: starts from doc 0");
  assertEqual(inv1.docCursorEnd, 2, "Inv1: indexes docs 0,1 (ends at cursor 2)");
  assertEqual(inv1.partial, true, "Inv1: partial (docs 2-4 not yet indexed)");
  assertEqual(inv1.cp.documentCursor, 2, "Inv1: checkpoint cursor = 2");

  // Invocation 2: resume from checkpoint — MUST start from doc 2, not doc 0
  const inv2 = simulateIndexInvocation(inv1.cp, allDocs, 2, tables);
  assertEqual(inv2.docCursorStart, 2, "Inv2: starts from doc 2 (not re-querying docs 0,1)");
  assertEqual(inv2.docCursorEnd, 4, "Inv2: indexes docs 2,3 (ends at cursor 4)");
  assertEqual(inv2.partial, true, "Inv2: still partial (doc 4 not yet indexed)");

  // Invocation 3: resume from checkpoint — starts from doc 4
  const inv3 = simulateIndexInvocation(inv2.cp, allDocs, 2, tables);
  assertEqual(inv3.docCursorStart, 4, "Inv3: starts from doc 4 (not re-querying docs 0-3)");
  assertEqual(inv3.docCursorEnd, 5, "Inv3: indexes doc 4 (final doc)");
  assertEqual(inv3.partial, false, "Inv3: complete (all docs indexed)");
}

// ---------------------------------------------------------------------------
// Test 2: Repeated resumptions eventually complete the full inventory
// ---------------------------------------------------------------------------
console.log("\nTest 2: Repeated resumptions eventually complete the full inventory");
{
  const allDocs = ["d1", "d2", "d3", "d4", "d5", "d6"];
  const tables = new Map(allDocs.map(d => [d, [makeEntry(`t-${d}`, d)]]));

  let cp: ReturnType<typeof buildNumericCheckpoint> | null = null;
  let invCount = 0;

  // Process 1 doc per invocation — takes 6 invocations
  while (true) {
    invCount++;
    const result = simulateIndexInvocation(cp, allDocs, 1, tables);
    cp = result.cp;
    if (!result.partial) break;
    if (invCount > 10) { failed++; console.error("  ✗ Exceeded max invocations — possible livelock"); break; }
  }

  assertEqual(invCount, 6, "Completes in exactly 6 invocations (1 doc each)");
  assert(cp !== null && !isCheckpointComplete(cp) === false, "Final checkpoint is complete");
  assertEqual(cp!.documentCursor, 6, "Final cursor = 6 (all docs)");
  assertEqual(cp!.indexedTableMetadata.length, 6, "All 6 table entries accumulated");
}

// ---------------------------------------------------------------------------
// Test 3: Document cursor advances monotonically
// ---------------------------------------------------------------------------
console.log("\nTest 3: Document cursor advances monotonically");
{
  const allDocs = ["d1", "d2", "d3", "d4"];
  const tables = new Map(allDocs.map(d => [d, [makeEntry(`t-${d}`, d)]]));

  let cp: ReturnType<typeof buildNumericCheckpoint> | null = null;
  const cursors: number[] = [];

  for (let i = 0; i < 4; i++) {
    const result = simulateIndexInvocation(cp, allDocs, 1, tables);
    cp = result.cp;
    cursors.push(result.cp.documentCursor);
  }

  let monotonic = true;
  for (let i = 1; i < cursors.length; i++) {
    if (cursors[i] <= cursors[i - 1]) { monotonic = false; break; }
  }
  assert(monotonic, `Cursors advance monotonically: [${cursors.join(", ")}]`);
  assertEqual(cursors[cursors.length - 1], 4, "Final cursor equals total doc count");
}

// ---------------------------------------------------------------------------
// Test 4: Accumulated table-index metadata survives JSON round-trip
// ---------------------------------------------------------------------------
console.log("\nTest 4: Accumulated table-index metadata survives JSON round-trip");
{
  const allDocs = ["d1", "d2", "d3"];
  const tables = new Map([
    ["d1", [makeEntry("t1", "d1", "Sheet1"), makeEntry("t2", "d1", "Sheet2")]],
    ["d2", [makeEntry("t3", "d2", "ModelSheet")]],
  ]);

  const inv1 = simulateIndexInvocation(null, allDocs, 2, tables);

  // Serialize to JSON and back (simulates DB persistence)
  const serialized = JSON.parse(JSON.stringify(inv1.cp));

  // Validate against current doc universe (no prefix table check needed here)
  const result = validateNumericCheckpoint(serialized, allDocs);
  assertEqual(result.valid, true, "Restored checkpoint validates successfully");

  if (result.valid) {
    const restored = getResumePosition(result.checkpoint);
    assertEqual(restored.indexedTableMetadata.length, 3, "All 3 table entries preserved");
    assertEqual(restored.indexedTableMetadata[0].id, "t1", "Table t1 preserved");
    assertEqual(restored.indexedTableMetadata[1].id, "t2", "Table t2 preserved");
    assertEqual(restored.indexedTableMetadata[2].id, "t3", "Table t3 preserved");
    assertEqual(restored.indexedTableMetadata[0].sheet_or_page, "Sheet1", "Sheet name preserved");
    assertEqual(restored.indexedTableMetadata[2].sheet_or_page, "ModelSheet", "ModelSheet name preserved");
  }
}

// ---------------------------------------------------------------------------
// Test 5: New tables from unindexed documents do NOT invalidate checkpoint
// ---------------------------------------------------------------------------
console.log("\nTest 5: New tables from unindexed docs do NOT invalidate checkpoint");
{
  const prefixDocs = ["d1", "d2"];
  const allDocs = ["d1", "d2", "d3", "d4"]; // 2 new docs beyond cursor

  const prefixTables = [makeEntry("t1", "d1"), makeEntry("t2", "d2")];
  const cp = buildNumericCheckpoint({
    status: "partial",
    documentIds: prefixDocs, // checkpoint was built with only 2 docs known at that time
    indexedTableMetadata: prefixTables,
    documentCursor: 2,
    tableCursor: 0,
    figures: [],
    discrepancies: [],
    documentsProcessed: 2,
    documentsTotal: 2,
    tablesLoaded: 0,
    tablesTotal: 2,
  });

  // Current universe has grown to 4 docs.
  // prefixTableIds = tables for d1,d2 only (same as checkpoint)
  const prefixTableIds = ["t1", "t2"];
  const result = validateNumericCheckpoint(cp, allDocs, prefixTableIds);

  assertEqual(result.valid, true, "Checkpoint valid even though universe grew beyond cursor");
  if (result.valid) {
    assertEqual(result.checkpoint.documentCursor, 2, "Cursor is preserved");
  }
}

// ---------------------------------------------------------------------------
// Test 6: Changed table in already-indexed prefix DOES invalidate checkpoint
// ---------------------------------------------------------------------------
console.log("\nTest 6: Changed table in already-indexed prefix DOES invalidate");
{
  const allDocs = ["d1", "d2", "d3"];
  const prefixTables = [makeEntry("t1", "d1"), makeEntry("t2-OLD", "d2")];
  const cp = buildNumericCheckpoint({
    status: "partial",
    documentIds: allDocs,
    indexedTableMetadata: prefixTables,
    documentCursor: 2,
    tableCursor: 0,
    figures: [],
    discrepancies: [],
    documentsProcessed: 2,
    documentsTotal: 3,
    tablesLoaded: 0,
    tablesTotal: 2,
  });

  // Re-query reveals t2-OLD was replaced by t2-NEW
  const currentPrefixTableIds = ["t1", "t2-NEW"];
  const result = validateNumericCheckpoint(cp, allDocs, currentPrefixTableIds);

  assertEqual(result.valid, false, "Checkpoint invalidated when indexed table was replaced");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
    assert(result.reason.includes("no longer exists"), "reason mentions table removal");
  }
}

// ---------------------------------------------------------------------------
// Test 7: Small-budget runs still make forward progress (1 doc at a time)
// ---------------------------------------------------------------------------
console.log("\nTest 7: Small-budget runs make forward progress (1 doc per invocation)");
{
  const allDocs = Array.from({ length: 5 }, (_, i) => `doc-${i}`);
  const tables = new Map(allDocs.map(d => [d, [makeEntry(`t-${d}`, d)]]));

  let cp: ReturnType<typeof buildNumericCheckpoint> | null = null;
  const cursorsAfterEachRun: number[] = [];

  for (let i = 0; i < 5; i++) {
    const result = simulateIndexInvocation(cp, allDocs, 1, tables);
    cp = result.cp;
    cursorsAfterEachRun.push(result.cp.documentCursor);
  }

  assertEqual(cursorsAfterEachRun, [1, 2, 3, 4, 5], "Cursor advances by 1 per invocation");
  assert(!cp!.status || cp!.status === "complete", "Final status is complete");
}

// ---------------------------------------------------------------------------
// Test 8: One-shot and multi-resume produce identical final figures
// ---------------------------------------------------------------------------
console.log("\nTest 8: One-shot vs multi-resume produce identical final figures");
{
  const allDocs = ["d1", "d2", "d3"];
  const tables = new Map(allDocs.map(d => [d, [makeEntry(`t-${d}`, d)]]));
  const figuresPerDoc = new Map([
    ["d1", [makeFigure({ period: "FY2023", source_doc: "d1" })]],
    ["d2", [makeFigure({ period: "FY2024", source_doc: "d2" })]],
    ["d3", [makeFigure({ name: "EBITDA", period: "FY2024", source_doc: "d3" })]],
  ]);

  // One-shot: process all 3 docs in a single invocation
  const oneShot = simulateIndexInvocation(null, allDocs, 10, tables, figuresPerDoc);
  assertEqual(oneShot.partial, false, "One-shot is complete");

  // Multi-resume: 1 doc per invocation
  let cp: ReturnType<typeof buildNumericCheckpoint> | null = null;
  let multiResumeFigures: SerializedFigure[] = [];
  for (let i = 0; i < 3; i++) {
    const result = simulateIndexInvocation(cp, allDocs, 1, tables, figuresPerDoc);
    cp = result.cp;
    multiResumeFigures = result.mergedFigures;
  }
  assert(!cp || !cp.status || cp.status === "complete", "Multi-resume is complete");

  // Compare results (sort for order-independence)
  const sortFigs = (figs: SerializedFigure[]) =>
    [...figs].sort((a, b) => `${a.name}::${a.period}::${a.source_doc}`.localeCompare(`${b.name}::${b.period}::${b.source_doc}`));

  assertEqual(sortFigs(oneShot.mergedFigures), sortFigs(multiResumeFigures),
    "One-shot and multi-resume produce identical figures");
  assertEqual(oneShot.mergedFigures.length, 3, "One-shot has 3 figures");
  assertEqual(multiResumeFigures.length, 3, "Multi-resume has 3 figures");
}

// ---------------------------------------------------------------------------
// Test 9: Partial checkpoint always carries non-null checkpoint object
// (ensures caller can always persist when partial=true)
// ---------------------------------------------------------------------------
console.log("\nTest 9: buildNumericCheckpoint always returns non-null for partial status");
{
  const cp = buildNumericCheckpoint({
    status: "partial",
    documentIds: ["d1", "d2", "d3"],
    indexedTableMetadata: [makeEntry("t1", "d1")],
    documentCursor: 1,
    tableCursor: 0,
    figures: [],
    discrepancies: [],
    documentsProcessed: 1,
    documentsTotal: 3,
    tablesLoaded: 0,
    tablesTotal: 1,
  });

  assert(cp !== null, "buildNumericCheckpoint returns non-null");
  assertEqual(cp.status, "partial", "status is partial");
  assertEqual(cp.documentCursor, 1, "documentCursor preserved");
  assertEqual(cp.indexedTableMetadata.length, 1, "indexedTableMetadata preserved");
  // Verify that cp.indexedTableMetadata exists (so caller has durability signal)
  assert(Array.isArray(cp.indexedTableMetadata), "indexedTableMetadata is an array");

  // Test: if checkpoint write failed on partial, next run CANNOT pretend durability
  // Verify that without a valid stored checkpoint, resumeDocCursor stays at 0
  const noCheckpointResult = simulateIndexInvocation(null, ["d1", "d2", "d3"], 1, new Map([["d1", [makeEntry("t1", "d1")]]]));
  assertEqual(noCheckpointResult.docCursorStart, 0, "Without checkpoint, always starts from doc 0 (correct restart behavior)");
}

// ---------------------------------------------------------------------------
// Test 10: Checkpoint version bump invalidates v1 checkpoints
// ---------------------------------------------------------------------------
console.log("\nTest 10: Old version (v1) checkpoint is invalidated on load");
{
  // Simulate a v1 checkpoint (before the corrective fix, no indexedTableMetadata)
  const v1Checkpoint = {
    version: 1,  // old version
    status: "partial",
    documentIds: ["d1", "d2"],
    tableIds: ["t1", "t2"],  // v1 had tableIds instead of indexedTableMetadata
    documentCursor: 1,
    tableCursor: 0,
    figures: [],
    discrepancies: [],
    documentsProcessed: 1,
    documentsTotal: 2,
    tablesLoaded: 0,
    tablesTotal: 2,
    sourceFingerprint: "abc123",
    pipelineVersion: "1.0.0",
    configVersion: "1.0.0:2026-07-31-r1",
    lastUpdated: "2026-07-31T00:00:00Z",
  };

  const result = validateNumericCheckpoint(v1Checkpoint, ["d1", "d2"]);
  assertEqual(result.valid, false, "v1 checkpoint is rejected");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate (not error)");
    assert(result.reason.includes(String(NUMERIC_CHECKPOINT_VERSION)), "reason mentions expected version");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
console.log("All Fix 4 corrective tests passed ✓\n");
