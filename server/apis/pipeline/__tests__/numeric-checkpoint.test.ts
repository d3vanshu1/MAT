/**
 * Fix 4 — Resumable Numeric Verification: Checkpoint unit tests (v2 schema)
 *
 * Updated for v2 checkpoint schema (indexedTableMetadata replaces tableIds,
 * forward-progress-safe validation, prefix-based structural checks).
 *
 * Run: npx tsx server/apis/pipeline/__tests__/numeric-checkpoint.test.ts
 */

import {
  buildNumericCheckpoint,
  validateNumericCheckpoint,
  isCheckpointComplete,
  getResumePosition,
  computeNumericSourceFingerprint,
  NUMERIC_CHECKPOINT_VERSION,
  type IndexedTableEntry,
  type BuildCheckpointInput,
  type SerializedFigure,
  type SerializedDiscrepancy,
} from "../numeric-checkpoint.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_IDS = ["doc-aaa", "doc-bbb", "doc-ccc"];

function makeEntry(id: string, docId: string, sheet = "Sheet1"): IndexedTableEntry {
  return { id, document_id: docId, sheet_or_page: sheet, caption: null, data_length: 1000 };
}

const INDEX_META: IndexedTableEntry[] = [
  makeEntry("tbl-111", "doc-aaa"),
  makeEntry("tbl-222", "doc-bbb"),
];

function makeFigure(overrides?: Partial<SerializedFigure>): SerializedFigure {
  return {
    name: "Revenue",
    period: "Q1 2024",
    value: 1_000_000,
    source_doc: "doc-aaa",
    source_cell: "B5",
    source_sheet: "Income Statement",
    ...overrides,
  };
}

function makeDiscrepancy(overrides?: Partial<SerializedDiscrepancy>): SerializedDiscrepancy {
  return {
    description: "Revenue differs",
    severity: "critical",
    check_type: "cross_doc_agreement",
    sources: ["Sheet A", "Sheet B"],
    period: "Q1 2024",
    headline: "Revenue mismatch",
    materialityFloor: { abs: 50000, rel: 5 },
    metrics: [{
      label: "Revenue", sourceA: 1_000_000, sourceB: 1_100_000,
      absDiff: 100_000, relDiffPct: 10,
      tier: "material", isAggregate: false, isDuplicateLabel: false,
    }],
    ...overrides,
  };
}

function makeInput(overrides?: Partial<BuildCheckpointInput>): BuildCheckpointInput {
  return {
    status: "partial",
    documentIds: DOC_IDS,
    indexedTableMetadata: INDEX_META,
    documentCursor: 2,
    tableCursor: 3,
    figures: [makeFigure()],
    discrepancies: [makeDiscrepancy()],
    documentsProcessed: 2,
    documentsTotal: 3,
    tablesLoaded: 3,
    tablesTotal: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== Fix 4 v2: Numeric Checkpoint Tests ===\n");

// Test 1: buildNumericCheckpoint produces well-formed v2 checkpoint
console.log("Test 1: buildNumericCheckpoint produces well-formed v2 checkpoint");
{
  const cp = buildNumericCheckpoint(makeInput({ status: "complete" }));

  assertEqual(cp.version, NUMERIC_CHECKPOINT_VERSION, "version matches constant (2)");
  assertEqual(cp.status, "complete", "status is complete");
  assertEqual(cp.documentIds, DOC_IDS, "documentIds preserved");
  assertEqual(cp.indexedTableMetadata.length, 2, "indexedTableMetadata has 2 entries");
  assertEqual(cp.indexedTableMetadata[0].id, "tbl-111", "first table entry id preserved");
  assertEqual(cp.documentCursor, 2, "documentCursor preserved");
  assertEqual(cp.tableCursor, 3, "tableCursor preserved");
  assertEqual(cp.figures.length, 1, "figures count correct");
  assertEqual(cp.discrepancies.length, 1, "discrepancies count correct");
  assertEqual(cp.documentsProcessed, 2, "documentsProcessed correct");
  assertEqual(cp.documentsTotal, 3, "documentsTotal correct");
  assertEqual(cp.tablesLoaded, 3, "tablesLoaded correct");
  assertEqual(cp.tablesTotal, 4, "tablesTotal correct");
  assert(cp.sourceFingerprint.length > 0, "sourceFingerprint is non-empty");
  assert(cp.pipelineVersion.length > 0, "pipelineVersion is non-empty");
  assert(cp.configVersion.length > 0, "configVersion is non-empty");
  assert(/^\d{4}-\d{2}-\d{2}T/.test(cp.lastUpdated), "lastUpdated is ISO timestamp");
}

// Test 2: validateNumericCheckpoint accepts a valid checkpoint
console.log("\nTest 2: validateNumericCheckpoint accepts a valid checkpoint");
{
  const cp = buildNumericCheckpoint(makeInput());
  // Use the same doc universe; no prefix table check needed (no prefixTableIds)
  const result = validateNumericCheckpoint(cp, DOC_IDS);

  assertEqual(result.valid, true, "valid checkpoint is accepted");
  if (result.valid) {
    assertEqual(result.checkpoint.status, "partial", "status preserved through validation");
    assertEqual(result.checkpoint.figures.length, 1, "figures preserved");
    assertEqual(result.checkpoint.indexedTableMetadata.length, 2, "indexedTableMetadata preserved");
  }
}

// Test 3: Rejects when documents in the processed prefix are changed (action=invalidate)
console.log("\nTest 3: Rejects checkpoint when processed-prefix documents change (action=invalidate)");
{
  const cp = buildNumericCheckpoint(makeInput()); // built against DOC_IDS, cursor=2
  // Current universe has a different doc at position 0 in the prefix
  const alteredDocs = ["doc-REPLACED", "doc-bbb", "doc-ccc"];
  const result = validateNumericCheckpoint(cp, alteredDocs);

  assertEqual(result.valid, false, "checkpoint rejected");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
    assert(result.reason.includes("position 0"), "reason identifies position 0");
  }
}

// Test 4: Rejects when document universe shrank (documents removed)
console.log("\nTest 4: Rejects checkpoint when document universe shrank (action=invalidate)");
{
  const cp = buildNumericCheckpoint(makeInput()); // built against 3 docs
  // Current universe has only 1 doc
  const shrunkDocs = ["doc-aaa"];
  const result = validateNumericCheckpoint(cp, shrunkDocs);

  assertEqual(result.valid, false, "checkpoint rejected when universe shrank");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
    assert(result.reason.includes("shrunk"), "reason mentions shrinkage");
  }
}

// Test 5: Rejects checkpoint with missing required fields (action=error)
console.log("\nTest 5: Rejects checkpoint with missing required fields (action=error)");
{
  const cp: any = buildNumericCheckpoint(makeInput());
  delete cp.indexedTableMetadata;
  const result = validateNumericCheckpoint(cp, DOC_IDS);

  assertEqual(result.valid, false, "checkpoint rejected");
  if (!result.valid) {
    assertEqual(result.action, "error", "action is error");
    assert(result.reason.includes("Missing required field"), "reason mentions missing field");
  }
}

// Test 6: Rejects checkpoint with wrong version (action=invalidate)
console.log("\nTest 6: Rejects checkpoint with wrong version (action=invalidate)");
{
  const cp: any = buildNumericCheckpoint(makeInput());
  cp.version = 1; // old v1 version
  const result = validateNumericCheckpoint(cp, DOC_IDS);

  assertEqual(result.valid, false, "checkpoint rejected");
  if (!result.valid) {
    assertEqual(result.action, "invalidate", "action is invalidate");
    assert(result.reason.includes(String(NUMERIC_CHECKPOINT_VERSION)), "reason mentions expected version");
  }
}

// Test 7: isCheckpointComplete differentiates partial vs complete
console.log("\nTest 7: isCheckpointComplete differentiates partial vs complete");
{
  const partial = buildNumericCheckpoint(makeInput({ status: "partial" }));
  const complete = buildNumericCheckpoint(makeInput({ status: "complete" }));

  assertEqual(isCheckpointComplete(partial), false, "partial → false");
  assertEqual(isCheckpointComplete(complete), true, "complete → true");
}

// Test 8: getResumePosition returns cursor + accumulated data + indexedTableMetadata
console.log("\nTest 8: getResumePosition extracts cursor, accumulated data, and indexedTableMetadata");
{
  const figures = [makeFigure(), makeFigure({ period: "Q2 2024" })];
  const discrepancies = [makeDiscrepancy()];
  const meta = [makeEntry("tbl-111", "doc-aaa"), makeEntry("tbl-222", "doc-bbb")];
  const cp = buildNumericCheckpoint(makeInput({
    status: "partial",
    documentCursor: 1,
    tableCursor: 2,
    figures,
    discrepancies,
    indexedTableMetadata: meta,
  }));

  const resume = getResumePosition(cp);
  assertEqual(resume.documentCursor, 1, "documentCursor correct");
  assertEqual(resume.tableCursor, 2, "tableCursor correct");
  assertEqual(resume.accumulatedFigures.length, 2, "accumulatedFigures count correct");
  assertEqual(resume.accumulatedDiscrepancies.length, 1, "accumulatedDiscrepancies count correct");
  assertEqual(resume.indexedTableMetadata.length, 2, "indexedTableMetadata returned");
  assertEqual(resume.indexedTableMetadata[0].id, "tbl-111", "first table entry preserved");
  assertEqual(resume.accumulatedFigures[1].period, "Q2 2024", "figure data preserved");
}

// Test 9: computeNumericSourceFingerprint is deterministic and order-insensitive
console.log("\nTest 9: Source fingerprint is deterministic and order-insensitive");
{
  const fp1 = computeNumericSourceFingerprint(["a", "b", "c"], ["x", "y"]);
  const fp2 = computeNumericSourceFingerprint(["c", "a", "b"], ["y", "x"]);
  const fp3 = computeNumericSourceFingerprint(["a", "b", "c"], ["x", "y"]);

  assertEqual(fp1, fp2, "same set different order → same fingerprint");
  assertEqual(fp1, fp3, "identical input → identical fingerprint");

  const fp4 = computeNumericSourceFingerprint(["a", "b", "d"], ["x", "y"]);
  assert(fp1 !== fp4, "different document set → different fingerprint");

  // Adding a table (forward progress) changes fingerprint
  const fp5 = computeNumericSourceFingerprint(["a", "b", "c"], ["x", "y", "z"]);
  assert(fp1 !== fp5, "growing table set changes fingerprint (expected)");
}

// Test 10: Build → validate round-trip preserves all data (JSON serialize/parse)
console.log("\nTest 10: Round-trip (build → serialize → validate) preserves all data");
{
  const meta = [makeEntry("tbl-1", "doc-aaa", "Income Statement"), makeEntry("tbl-2", "doc-bbb", "ModelSheet")];
  const input = makeInput({
    status: "complete",
    indexedTableMetadata: meta,
    figures: [makeFigure(), makeFigure({ period: "Q2 2024", value: 2_000_000 })],
    discrepancies: [makeDiscrepancy()],
    crossAgreementDebug: { matchedPeriods: 4, unmatchedPeriods: 0 },
  });
  const cp = buildNumericCheckpoint(input);

  // Simulate DB persistence: serialize to JSON and back
  const serialized = JSON.parse(JSON.stringify(cp));
  const result = validateNumericCheckpoint(serialized, DOC_IDS);

  assertEqual(result.valid, true, "round-tripped checkpoint still valid");
  if (result.valid) {
    const r = result.checkpoint;
    assertEqual(r.status, "complete", "status preserved");
    assertEqual(r.figures.length, 2, "figures preserved");
    assertEqual(r.discrepancies.length, 1, "discrepancies preserved");
    assertEqual(r.indexedTableMetadata.length, 2, "indexedTableMetadata preserved");
    assertEqual(r.indexedTableMetadata[0].sheet_or_page, "Income Statement", "sheet name preserved");
    assertEqual(r.documentsProcessed, 2, "documentsProcessed preserved");
    assertEqual(r.documentsTotal, 3, "documentsTotal preserved");
    assertEqual((r as any).crossAgreementDebug.matchedPeriods, 4, "crossAgreementDebug preserved");
  }
}

// Bonus: null checkpoint is invalidated
console.log("\nBonus: null checkpoint validates as invalid (action=invalidate)");
{
  const result = validateNumericCheckpoint(null, DOC_IDS);
  assertEqual(result.valid, false, "null checkpoint rejected");
  if (!result.valid) { assertEqual(result.action, "invalidate", "action is invalidate"); }
}

// Bonus: invalid status field triggers error
console.log("\nBonus: invalid status string triggers action=error");
{
  const cp: any = buildNumericCheckpoint(makeInput());
  cp.status = "unknown_status";
  const result = validateNumericCheckpoint(cp, DOC_IDS);
  assertEqual(result.valid, false, "invalid status rejected");
  if (!result.valid) {
    assertEqual(result.action, "error", "action is error");
    assert(result.reason.includes("Invalid status"), "reason mentions invalid status");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
console.log("All numeric checkpoint v2 tests passed ✓\n");
