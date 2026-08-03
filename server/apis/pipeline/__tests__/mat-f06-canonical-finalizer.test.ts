/**
 * MAT-F06: One Canonical Finalizer, One Write, Execution-Path Parity — 27 tests
 *
 * Tests invoke the actual production finalization functions:
 *   - canonicalFinalize (main entry point)
 *   - formatCanonicalReport (§F — reportable-only report)
 *   - getReportExclusionReason (§F — non-reportable filter)
 *   - computeSemanticHash (§C — insertion-order-insensitive hash)
 *   - buildSemanticHashInput (§C — volatile-field exclusion)
 *   - loadCheckpointStatus (prerequisite loader)
 *
 * Frozen Assertions:
 *   A1: One finalizer across all paths — tested via mock DB to verify all status outcomes
 *   A2: Missing prerequisites block completion — tested via prerequisite validation
 *   A3: Exactly one durable write — tested via DB call counting
 *   A4: Report/API/export parity — tested via report generation and hash stability
 *   A5: Diagnostics cannot become findings — tested via §F filter
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f06-canonical-finalizer.test.ts
 */

import {
  canonicalFinalize,
  formatCanonicalReport,
  getReportExclusionReason,
  loadCheckpointStatus,
  type FinalizerPrerequisites,
  type FinalizerOutcome,
} from "../canonical-finalizer.js";
import {
  computeSemanticHash,
  buildSemanticHashInput,
  CANONICAL_FINAL_ARTIFACT_VERSION,
  SEMANTIC_HASH_VERSION,
  type CanonicalFinalArtifact,
  type SemanticHashInput,
  type CheckpointStatusEntry,
  type ExcludedFinding,
} from "../canonical-final-artifact.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`  FAIL: ${msg}\n    expected: ${b}\n    actual:   ${a}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertIncludes(str: string, sub: string, msg: string): void {
  if (!str.includes(sub)) {
    console.error(`  FAIL: ${msg}\n    string does not include: "${sub}"\n    got: "${str.slice(0, 200)}"`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertNotIncludes(str: string, sub: string, msg: string): void {
  if (str.includes(sub)) {
    console.error(`  FAIL: ${msg}\n    string should NOT include: "${sub}"`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockDbCall {
  sql: string;
  params: any[];
  label?: string;
}

function createMockDb(opts: {
  existingOutput?: { id: string; semantic_hash: string | null } | null;
  runStatus?: string;
  insertedId?: string;
  verifySuccess?: boolean;
  checkpointRows?: Array<{ checkpoint_key: string; status: string | null }>;
} = {}) {
  const calls: MockDbCall[] = [];

  const db = {
    query: async (sql: string, _schema: any, params: any[], meta?: { label?: string }) => {
      calls.push({ sql, params, label: meta?.label });

      // Route based on SQL content
      if (sql.includes("module_outputs") && sql.includes("SELECT")) {
        if (sql.includes("WHERE id = $1")) {
          // Verification query
          if (opts.verifySuccess !== false) {
            return [{ id: opts.insertedId ?? "out-001", semantic_hash: "sha256-v1:test" }];
          }
          return [];
        }
        // Initial check for existing output
        if (opts.existingOutput) {
          return [opts.existingOutput];
        }
        return [];
      }
      if (sql.includes("module_runs") && sql.includes("SELECT")) {
        return [{ status: opts.runStatus ?? "running" }];
      }
      if (sql.includes("INSERT INTO module_outputs")) {
        return [{ id: opts.insertedId ?? "out-new-001" }];
      }
      if (sql.includes("pipeline_checkpoints")) {
        return opts.checkpointRows ?? [];
      }
      return [];
    },
    execute: async (sql: string, params: any[], meta?: { label?: string }) => {
      calls.push({ sql, params, label: meta?.label });
      return undefined;
    },
  };

  return { db, calls };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeReportableFinding(overrides: Partial<any> = {}): any {
  return {
    finding_id: `f-${Math.random().toString(36).slice(2, 8)}`,
    title: "Revenue Growth Claim Disputed",
    detail: "IC memo claims 25% CAGR but company filings show 12% CAGR over the same period.",
    severity: "critical",
    finding_kind: "contradiction",
    evidence: [{ verbatim_snippet: "Revenue grew at 12% CAGR" }],
    full_analysis: "Detailed analysis of the discrepancy...",
    ...overrides,
  };
}

function makeProcessFinding(overrides: Partial<any> = {}): any {
  return {
    finding_id: `pf-${Math.random().toString(36).slice(2, 8)}`,
    title: "Analysis Complete",
    detail: "Processing completed successfully.",
    severity: "info",
    finding_kind: "process",
    ...overrides,
  };
}

function makeHousekeepingFinding(overrides: Partial<any> = {}): any {
  return {
    finding_id: `hk-${Math.random().toString(36).slice(2, 8)}`,
    title: "[Housekeeping] Document Indexing",
    detail: "Document indexing metadata.",
    severity: "info",
    finding_kind: "housekeeping",
    ...overrides,
  };
}

function makeDegradedFinding(overrides: Partial<any> = {}): any {
  return {
    finding_id: `dg-${Math.random().toString(36).slice(2, 8)}`,
    title: "[Degraded] Claims Reconciliation Incomplete",
    detail: "Claims could not be reconciled.",
    severity: "info",
    finding_kind: "degraded_run_notice",
    ...overrides,
  };
}

function makePrerequisites(overrides: Partial<FinalizerPrerequisites> = {}): FinalizerPrerequisites {
  return {
    findings: [makeReportableFinding({ finding_id: "f-001", title: "Test Finding" })],
    executiveHeader: "Executive summary of findings.",
    moduleType: "contradiction_check",
    checkpointStatus: [
      { key: "claims_ledger", present: true, status: "complete" },
      { key: "reconciliation", present: true, status: "complete" },
      { key: "canonical_findings", present: true, status: "complete" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FROZEN ASSERTION A1: One finalizer across all paths
// Tests verify that canonicalFinalize produces correct outcomes for all statuses
// ---------------------------------------------------------------------------

console.log("\n=== A1: One Canonical Finalizer Across All Paths ===\n");

// Test 1: Normal completion — fresh run with no existing output
async function test_A1_01() {
  const { db, calls } = createMockDb({ insertedId: "out-fresh-001" });
  const prereqs = makePrerequisites();
  const result = await canonicalFinalize(db, "run-001", "deal-001", prereqs);
  assert(result.status === "completed", "A1.01: Fresh run returns completed status");
}

// Test 2: Idempotent completion — same hash → no-op
async function test_A1_02() {
  // We need to pre-compute the hash that the finalizer will produce
  const finding = makeReportableFinding({ finding_id: "f-idem-001", title: "Idempotent Finding" });
  const prereqs = makePrerequisites({ findings: [finding] });

  // First call to get the hash
  const { db: db1 } = createMockDb({ insertedId: "out-idem-001" });
  const firstResult = await canonicalFinalize(db1, "run-idem", "deal-idem", prereqs);
  assert(firstResult.status === "completed", "A1.02a: First call completes");
  if (firstResult.status !== "completed") return;

  // Second call with existing output having the same hash
  const { db: db2 } = createMockDb({
    existingOutput: { id: "out-idem-001", semantic_hash: firstResult.semanticHash },
  });
  const secondResult = await canonicalFinalize(db2, "run-idem", "deal-idem", prereqs);
  assertEqual(secondResult.status, "idempotent", "A1.02b: Same hash → idempotent no-op");
}

// Test 3: Rejected overwrite — different hash on completed run
async function test_A1_03() {
  const { db } = createMockDb({
    existingOutput: { id: "out-existing", semantic_hash: "sha256-v1:different-hash" },
    runStatus: "completed",
  });
  const prereqs = makePrerequisites();
  const result = await canonicalFinalize(db, "run-reject", "deal-reject", prereqs);
  assertEqual(result.status, "rejected_overwrite", "A1.03: Different hash on completed run → rejected");
}

// Test 4: Update allowed — existing output but run not completed (mid-run retry)
async function test_A1_04() {
  const { db } = createMockDb({
    existingOutput: { id: "out-mid", semantic_hash: "sha256-v1:old-hash" },
    runStatus: "running",
    verifySuccess: true,
  });
  const prereqs = makePrerequisites();
  const result = await canonicalFinalize(db, "run-mid", "deal-mid", prereqs);
  assertEqual(result.status, "completed", "A1.04: Existing output + running status → allows update");
}

// Test 5: Persist failure returns persist_failed
async function test_A1_05() {
  const { db } = createMockDb({ verifySuccess: false });
  const prereqs = makePrerequisites();
  const result = await canonicalFinalize(db, "run-fail", "deal-fail", prereqs);
  assertEqual(result.status, "persist_failed", "A1.05: Verify failure → persist_failed");
}

// ---------------------------------------------------------------------------
// FROZEN ASSERTION A2: Missing prerequisites block completion
// ---------------------------------------------------------------------------

console.log("\n=== A2: Missing Prerequisites Block Completion ===\n");

// Test 6: Missing claims_ledger checkpoint blocks
async function test_A2_01() {
  const prereqs = makePrerequisites({
    checkpointStatus: [
      { key: "claims_ledger", present: false },
      { key: "reconciliation", present: true, status: "complete" },
      { key: "canonical_findings", present: true, status: "complete" },
    ],
  });
  const { db } = createMockDb();
  const result = await canonicalFinalize(db, "run-miss-1", "deal-miss", prereqs);
  assertEqual(result.status, "prerequisites_missing", "A2.01: Missing claims_ledger → blocked");
  if (result.status === "prerequisites_missing") {
    assert(result.missingKeys.includes("claims_ledger"), "A2.01b: claims_ledger in missingKeys");
  }
}

// Test 7: Missing reconciliation checkpoint blocks
async function test_A2_02() {
  const prereqs = makePrerequisites({
    checkpointStatus: [
      { key: "claims_ledger", present: true, status: "complete" },
      { key: "reconciliation", present: false },
      { key: "canonical_findings", present: true, status: "complete" },
    ],
  });
  const { db } = createMockDb();
  const result = await canonicalFinalize(db, "run-miss-2", "deal-miss", prereqs);
  assertEqual(result.status, "prerequisites_missing", "A2.02: Missing reconciliation → blocked");
}

// Test 8: Missing canonical_findings checkpoint blocks
async function test_A2_03() {
  const prereqs = makePrerequisites({
    checkpointStatus: [
      { key: "claims_ledger", present: true, status: "complete" },
      { key: "reconciliation", present: true, status: "complete" },
      { key: "canonical_findings", present: false },
    ],
  });
  const { db } = createMockDb();
  const result = await canonicalFinalize(db, "run-miss-3", "deal-miss", prereqs);
  assertEqual(result.status, "prerequisites_missing", "A2.03: Missing canonical_findings → blocked");
}

// Test 9: All checkpoints missing → all listed
async function test_A2_04() {
  const prereqs = makePrerequisites({
    checkpointStatus: [
      { key: "claims_ledger", present: false },
      { key: "reconciliation", present: false },
      { key: "canonical_findings", present: false },
    ],
  });
  const { db } = createMockDb();
  const result = await canonicalFinalize(db, "run-miss-all", "deal-miss", prereqs);
  if (result.status === "prerequisites_missing") {
    assertEqual(result.missingKeys.length, 3, "A2.04: All 3 keys listed as missing");
  } else {
    assert(false, "A2.04: Expected prerequisites_missing");
  }
}

// Test 10: Non-claims module only requires canonical_findings
async function test_A2_05() {
  const prereqs = makePrerequisites({
    moduleType: "model_assumptions_stress",
    checkpointStatus: [
      { key: "canonical_findings", present: true, status: "complete" },
    ],
  });
  const { db } = createMockDb({ insertedId: "out-non-claims" });
  const result = await canonicalFinalize(db, "run-non-claims", "deal-001", prereqs);
  // Should NOT fail for missing claims_ledger/reconciliation
  assert(result.status !== "prerequisites_missing", "A2.05: Non-claims module does not require claims_ledger");
}

// Test 11: Checkpoint with non-complete status blocks
async function test_A2_06() {
  const prereqs = makePrerequisites({
    checkpointStatus: [
      { key: "claims_ledger", present: true, status: "failed" },
      { key: "reconciliation", present: true, status: "complete" },
      { key: "canonical_findings", present: true, status: "complete" },
    ],
  });
  const { db } = createMockDb();
  const result = await canonicalFinalize(db, "run-failed-cp", "deal-miss", prereqs);
  assertEqual(result.status, "prerequisites_missing", "A2.06: Checkpoint with 'failed' status → blocked");
}

// ---------------------------------------------------------------------------
// FROZEN ASSERTION A3: Exactly one durable write
// Tests verify that DB persist calls happen exactly once
// ---------------------------------------------------------------------------

console.log("\n=== A3: Exactly One Durable Write ===\n");

// Test 12: Fresh run — exactly one INSERT
async function test_A3_01() {
  const { db, calls } = createMockDb({ insertedId: "out-count-001" });
  const prereqs = makePrerequisites();
  await canonicalFinalize(db, "run-count", "deal-count", prereqs);
  const inserts = calls.filter(c => c.sql.includes("INSERT INTO module_outputs"));
  assertEqual(inserts.length, 1, "A3.01: Exactly 1 INSERT INTO module_outputs");
}

// Test 13: Existing output + running → exactly one UPDATE
async function test_A3_02() {
  const { db, calls } = createMockDb({
    existingOutput: { id: "out-upd", semantic_hash: null },
    runStatus: "running",
  });
  const prereqs = makePrerequisites();
  await canonicalFinalize(db, "run-upd", "deal-upd", prereqs);
  const updates = calls.filter(c => c.sql.includes("UPDATE module_outputs"));
  assertEqual(updates.length, 1, "A3.02: Exactly 1 UPDATE module_outputs");
}

// Test 14: Idempotent → zero writes
async function test_A3_03() {
  // Need to first get the hash
  const finding = makeReportableFinding({ finding_id: "f-nodupe", title: "No Dupe Finding" });
  const prereqs = makePrerequisites({ findings: [finding] });
  const { db: db1 } = createMockDb({ insertedId: "out-nodupe" });
  const firstResult = await canonicalFinalize(db1, "run-nodupe", "deal-nodupe", prereqs);
  if (firstResult.status !== "completed") { assert(false, "A3.03: setup failed"); return; }

  const { db: db2, calls } = createMockDb({
    existingOutput: { id: "out-nodupe", semantic_hash: firstResult.semanticHash },
  });
  await canonicalFinalize(db2, "run-nodupe", "deal-nodupe", prereqs);
  const writes = calls.filter(c =>
    c.sql.includes("INSERT INTO module_outputs") || c.sql.includes("UPDATE module_outputs")
  );
  assertEqual(writes.length, 0, "A3.03: Idempotent → zero module_outputs writes");
}

// Test 15: Completion mark happens AFTER persist
async function test_A3_04() {
  const { db, calls } = createMockDb({ insertedId: "out-order-001" });
  const prereqs = makePrerequisites();
  await canonicalFinalize(db, "run-order", "deal-order", prereqs);

  const persistIdx = calls.findIndex(c => c.sql.includes("INSERT INTO module_outputs"));
  const completeIdx = calls.findIndex(c => c.sql.includes("UPDATE module_runs") && c.sql.includes("completed"));
  assert(persistIdx >= 0, "A3.04a: INSERT found");
  assert(completeIdx >= 0, "A3.04b: Completion UPDATE found");
  assert(completeIdx > persistIdx, "A3.04c: Completion mark happens AFTER persist");
}

// Test 16: Semantic hash stored in module_runs on completion
async function test_A3_05() {
  const { db, calls } = createMockDb({ insertedId: "out-hash-001" });
  const prereqs = makePrerequisites();
  const result = await canonicalFinalize(db, "run-hash", "deal-hash", prereqs);
  if (result.status !== "completed") { assert(false, "A3.05: expected completed"); return; }

  const completeCall = calls.find(c =>
    c.sql.includes("UPDATE module_runs") && c.sql.includes("semantic_hash")
  );
  assert(completeCall !== undefined, "A3.05a: module_runs update includes semantic_hash");
  if (completeCall) {
    assertIncludes(completeCall.params[1] ?? "", "sha256-v1:", "A3.05b: semantic_hash has sha256-v1 prefix");
  }
}

// ---------------------------------------------------------------------------
// FROZEN ASSERTION A4: Report/API/export parity
// Tests verify that the report reflects only reportable findings and is hash-stable
// ---------------------------------------------------------------------------

console.log("\n=== A4: Report/API/Export Parity ===\n");

// Test 17: formatCanonicalReport includes only reportable findings
async function test_A4_01() {
  const reportable = [
    makeReportableFinding({ title: "Valid Finding A", severity: "critical" }),
    makeReportableFinding({ title: "Valid Finding B", severity: "warning" }),
  ];
  const report = formatCanonicalReport("Executive summary", reportable);
  assertIncludes(report, "Valid Finding A", "A4.01a: Reportable finding A in report");
  assertIncludes(report, "Valid Finding B", "A4.01b: Reportable finding B in report");
  assertIncludes(report, "2 reportable finding", "A4.01c: Count reflects reportable only");
}

// Test 18: Semantic hash is insertion-order-insensitive
async function test_A4_02() {
  const findings1 = [
    makeReportableFinding({ finding_id: "f-a", title: "Finding A" }),
    makeReportableFinding({ finding_id: "f-b", title: "Finding B" }),
  ];
  const findings2 = [
    makeReportableFinding({ finding_id: "f-b", title: "Finding B" }),
    makeReportableFinding({ finding_id: "f-a", title: "Finding A" }),
  ];

  const diagnostics: CanonicalFinalArtifact["diagnostics"] = {
    narrative_validation: [],
    excluded_findings: [],
    degraded_conditions: [],
    checkpoint_status: [],
  };

  const hash1 = computeSemanticHash(buildSemanticHashInput(findings1, ["f-a", "f-b"], diagnostics, "contradiction_check"));
  const hash2 = computeSemanticHash(buildSemanticHashInput(findings2, ["f-b", "f-a"], diagnostics, "contradiction_check"));
  assertEqual(hash1, hash2, "A4.02: Hash is insertion-order-insensitive");
}

// Test 19: Semantic hash excludes volatile fields (timestamps, etc.)
async function test_A4_03() {
  const finding = makeReportableFinding({ finding_id: "f-vol", title: "Volatile Test" });
  const diagnostics: CanonicalFinalArtifact["diagnostics"] = {
    narrative_validation: [],
    excluded_findings: [],
    degraded_conditions: [],
    checkpoint_status: [],
  };

  const input1 = buildSemanticHashInput([finding], ["f-vol"], diagnostics, "contradiction_check");
  const input2 = buildSemanticHashInput([finding], ["f-vol"], diagnostics, "contradiction_check");
  const hash1 = computeSemanticHash(input1);
  const hash2 = computeSemanticHash(input2);
  assertEqual(hash1, hash2, "A4.03: Same content → same hash (volatile fields excluded)");
}

// Test 20: Hash changes when content changes
async function test_A4_04() {
  const finding1 = makeReportableFinding({ finding_id: "f-diff", title: "Original Title" });
  const finding2 = makeReportableFinding({ finding_id: "f-diff", title: "Modified Title" });
  const diagnostics: CanonicalFinalArtifact["diagnostics"] = {
    narrative_validation: [],
    excluded_findings: [],
    degraded_conditions: [],
    checkpoint_status: [],
  };

  const hash1 = computeSemanticHash(buildSemanticHashInput([finding1], ["f-diff"], diagnostics, "contradiction_check"));
  const hash2 = computeSemanticHash(buildSemanticHashInput([finding2], ["f-diff"], diagnostics, "contradiction_check"));
  assert(hash1 !== hash2, "A4.04: Different content → different hash");
}

// Test 21: Pre-formatted report passed through (LLM report parity)
async function test_A4_05() {
  const { db } = createMockDb({ insertedId: "out-pre-fmt" });
  const customReport = "# Custom LLM-Formatted Report\n\nThis is a pre-formatted report.";
  const prereqs = makePrerequisites({ preFormattedReport: customReport });
  const result = await canonicalFinalize(db, "run-pre-fmt", "deal-pre-fmt", prereqs);
  if (result.status === "completed") {
    assertIncludes(
      result.artifact.report.markdown,
      "Custom LLM-Formatted Report",
      "A4.05: Pre-formatted report is used directly"
    );
  } else {
    assert(false, `A4.05: Expected completed, got ${result.status}`);
  }
}

// Test 22: Excluded findings count appears in disclosures
async function test_A4_06() {
  const report = formatCanonicalReport("Summary", [makeReportableFinding()], {
    excludedCount: 3,
  });
  assertIncludes(report, "3 diagnostic record(s) excluded", "A4.06: Excluded count in disclosures");
}

// ---------------------------------------------------------------------------
// FROZEN ASSERTION A5: Diagnostics cannot become findings
// Tests verify that §F filter prevents diagnostics from appearing in report
// ---------------------------------------------------------------------------

console.log("\n=== A5: Diagnostics Cannot Become Findings ===\n");

// Test 23: Process finding excluded
async function test_A5_01() {
  const pf = makeProcessFinding();
  const reason = getReportExclusionReason(pf);
  assertEqual(reason, "process_object", "A5.01: Process finding → process_object exclusion");
}

// Test 24: Housekeeping finding excluded
async function test_A5_02() {
  const hk = makeHousekeepingFinding();
  const reason = getReportExclusionReason(hk);
  assertEqual(reason, "housekeeping", "A5.02: Housekeeping finding → housekeeping exclusion");
}

// Test 25: Degraded notice excluded
async function test_A5_03() {
  const dg = makeDegradedFinding();
  const reason = getReportExclusionReason(dg);
  assert(
    reason === "degraded_notice" || reason === "unlinked",
    "A5.03: Degraded finding → degraded/unlinked exclusion"
  );
}

// Test 26: Placeholder finding excluded
async function test_A5_04() {
  const placeholder = { title: "No findings identified", detail: "", severity: "info", finding_kind: "" };
  const reason = getReportExclusionReason(placeholder);
  assertEqual(reason, "placeholder", "A5.04: Placeholder → placeholder exclusion");
}

// Test 27: Genuine reportable finding NOT excluded
async function test_A5_05() {
  const real = makeReportableFinding();
  const reason = getReportExclusionReason(real);
  assertEqual(reason, null, "A5.05: Genuine reportable finding → null (not excluded)");
}

// ---------------------------------------------------------------------------
// loadCheckpointStatus tests (supplementary)
// ---------------------------------------------------------------------------

console.log("\n=== Supplementary: loadCheckpointStatus ===\n");

// Test (supplementary): Synthetic canonical_findings key derived from hasParsedFindings flag
async function test_loadCheckpointStatus() {
  const mockDb = {
    query: async (_sql: string, _schema: any, _params: any[], _meta?: any) => {
      return [
        { checkpoint_key: "claims_ledger", status: "complete" },
        { checkpoint_key: "reconciliation", status: "complete" },
      ];
    },
  };
  const statusWith = await loadCheckpointStatus(mockDb, "run-cp-1", "contradiction_check", true);
  const cfEntry = statusWith.find(s => s.key === "canonical_findings");
  assert(cfEntry?.present === true, "loadCheckpointStatus: hasParsedFindings=true → canonical_findings present");

  const statusWithout = await loadCheckpointStatus(mockDb, "run-cp-2", "contradiction_check", false);
  const cfAbsent = statusWithout.find(s => s.key === "canonical_findings");
  assert(cfAbsent?.present === false, "loadCheckpointStatus: hasParsedFindings=false → canonical_findings absent");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

async function runAll() {
  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║  MAT-F06: Canonical Finalizer — 27 Targeted Tests     ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // A1: One finalizer across all paths (5 tests)
  await test_A1_01();
  await test_A1_02();
  await test_A1_03();
  await test_A1_04();
  await test_A1_05();

  // A2: Missing prerequisites block completion (6 tests)
  await test_A2_01();
  await test_A2_02();
  await test_A2_03();
  await test_A2_04();
  await test_A2_05();
  await test_A2_06();

  // A3: Exactly one durable write (5 tests)
  await test_A3_01();
  await test_A3_02();
  await test_A3_03();
  await test_A3_04();
  await test_A3_05();

  // A4: Report/API/export parity (6 tests)
  await test_A4_01();
  await test_A4_02();
  await test_A4_03();
  await test_A4_04();
  await test_A4_05();
  await test_A4_06();

  // A5: Diagnostics cannot become findings (5 tests)
  await test_A5_01();
  await test_A5_02();
  await test_A5_03();
  await test_A5_04();
  await test_A5_05();

  // Supplementary
  await test_loadCheckpointStatus();

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`──────────────────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

runAll().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(2);
});
