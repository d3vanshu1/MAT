/**
 * Fix 11 — ID-Scoped Reconciliation Replacement
 *
 * Regression tests for the production defect where reconciliation-generated
 * replacements could remove findings too broadly (text-pattern matching)
 * instead of removing only explicitly identified findings by ID.
 *
 * Each test is labelled with the pre-fix behaviour it catches:
 *   REGRESSION: test that would FAIL on the parent commit (1d80e3c)
 *   NEW:        test for new post-fix behaviour only
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix11-id-scoped-reconciliation.test.ts
 */

import { appendReconciliationFindings } from "../pipeline-core.js";
import type { ReconReplacementDiagnostic } from "../pipeline-core.js";
import type { ReconciliationResult, ReconciliationFinding } from "../claims-reconciliation.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// ---------------------------------------------------------------------------
// Helpers
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

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertContains(arr: string[], item: string, msg: string): void {
  assert(arr.includes(item), `${msg} (expected "${item}" in [${arr.join(", ")}])`);
}

function assertNotContains(arr: string[], item: string, msg: string): void {
  assert(!arr.includes(item), `${msg} (expected "${item}" NOT in [${arr.join(", ")}])`);
}

// ---------------------------------------------------------------------------
// Minimal fixture factories
// ---------------------------------------------------------------------------

const MOCK_CLAIM = {
  metric: "revenue" as const,
  scope_qualifier: "Group Total",
  period: "FY2026",
  value: 184.4,
  unit: "£m" as const,
  basis_note: "test",
  source_doc: "Model.xlsx",
  source_page: null,
  verbatim_snippet: "Revenue for FY26 is £184.4m",
  claim_category: "operating_metric" as const,
};

function makeFinding(overrides: Partial<CanonicalFinding> & { finding_id: string; title: string }): CanonicalFinding {
  return {
    severity: "warning",
    detail: "Detail text.",
    full_analysis: "Analysis.",
    source_docs: ["Source.pdf"],
    category: "principal_finding",
    numeric_unverified: false,
    finding_kind: "data_divergence",
    // overrides last — finding_id and title come from overrides only
    ...overrides,
  } as CanonicalFinding;
}

function makeReconFinding(
  title: string,
  supersedes_finding_ids?: string[],
): ReconciliationFinding {
  return {
    finding_kind: "data_divergence",
    severity: "warning",
    title,
    detail: `Code-verified: ${title}`,
    full_analysis: `Full analysis for ${title}`,
    severity_anchor: null,
    source_docs: ["Model.xlsx"],
    claim: MOCK_CLAIM,
    model_figure: null,
    delta_abs: null,
    delta_pct: null,
    supersedes_finding_ids,
  };
}

function makeReconResult(findings: ReconciliationFinding[]): ReconciliationResult {
  return {
    findings,
    reconciled_count: findings.filter(f => f.finding_kind === "data_divergence").length,
    unreconcilable_count: 0,
    scope_mismatch_count: 0,
    within_tolerance_count: 0,
    cross_version_findings: 0,
    matching_error: null,
  };
}

// ---------------------------------------------------------------------------
// Before-and-after trace helper
// ---------------------------------------------------------------------------

interface Trace {
  inputIds: string[];
  targetIds: string[];
  removedIds: string[];
  retainedIds: string[];
  appendedIds: string[];
  finalIds: string[];
  replacementMergedFromIds: string[];
  diagnostics: ReconReplacementDiagnostic[];
}

function buildTrace(
  inputFindings: CanonicalFinding[],
  reconResult: ReconciliationResult,
): Trace {
  const inputIds = inputFindings.map(f => f.finding_id);
  const targetIds = reconResult.findings
    .flatMap(f => f.supersedes_finding_ids ?? []);

  const result = appendReconciliationFindings(
    inputFindings,
    [],
    reconResult,
  );

  const finalIds = result.finalFindings.map(f => f.finding_id);
  const inputIdSet = new Set(inputIds);
  const finalIdSet = new Set(finalIds);

  const removedIds = inputIds.filter(id => !finalIdSet.has(id));
  const retainedIds = inputIds.filter(id => finalIdSet.has(id));
  const appendedIds = finalIds.filter(id => !inputIdSet.has(id));

  const replacementMergedFromIds = result.finalFindings
    .filter(f => appendedIds.includes(f.finding_id) && f.merged_from_finding_ids)
    .flatMap(f => f.merged_from_finding_ids ?? []);

  return {
    inputIds,
    targetIds,
    removedIds,
    retainedIds,
    appendedIds,
    finalIds,
    replacementMergedFromIds,
    diagnostics: result.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Fixed IDs for deterministic tracing
// ---------------------------------------------------------------------------

const ID_A = "aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4000-8000-cccccccccccc";
const UNKNOWN_ID = "99999999-9999-4000-8000-999999999999";

// ---------------------------------------------------------------------------
// Test 1: A/B/C with B replaced by D → final set is A/C/D
// ---------------------------------------------------------------------------
console.log("\n=== Test 1: A/B/C with B replaced by D → A/C/D ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — lease obligation" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B — FCA authorisation risk" });
  const findingC = makeFinding({ finding_id: ID_C, title: "Finding C — working capital gap" });

  // D supersedes B explicitly
  const reconD = makeReconFinding("Finding D — code-verified FCA authorisation risk", [ID_B]);
  const trace = buildTrace([findingA, findingB, findingC], makeReconResult([reconD]));

  console.log("  Trace:", JSON.stringify(trace, null, 2));

  assertEqual(trace.removedIds, [ID_B], "Test 1a: Only B is removed");
  assertContains(trace.retainedIds, ID_A, "Test 1b: A is retained");
  assertContains(trace.retainedIds, ID_C, "Test 1c: C is retained");
  assertEqual(trace.appendedIds.length, 1, "Test 1d: Exactly one finding appended (D)");
  assert(trace.finalIds.length === 3, "Test 1e: Final set has 3 findings (A, C, D)");
  assertContains(trace.replacementMergedFromIds, ID_B, "Test 1f: D records B in merged_from_finding_ids");
}

// ---------------------------------------------------------------------------
// Test 2: B and C share category/issue_key, only B explicitly replaced → C survives
// REGRESSION: Pre-fix, if B and C both contained matching £-amounts, C would be deleted
// ---------------------------------------------------------------------------
console.log("\n=== Test 2 (REGRESSION): B/C share issue key, only B replaced → C survives ===");
{
  // Both mention "£184.4m" and "£191.2m" in detail — the pre-fix text match would remove both
  const findingB = makeFinding({
    finding_id: ID_B,
    title: "Revenue divergence — LLM paraphrase",
    detail: "Revenue gap: £184.4m vs £191.2m",
    issue_key: "revenue_divergence",
    category: "principal_finding",
  });
  const findingC = makeFinding({
    finding_id: ID_C,
    title: "Revenue guidance disclosure gap",
    detail: "Memo cites £191.2m guidance but model shows £184.4m as base case",
    issue_key: "revenue_divergence",   // Same issue key
    category: "principal_finding",
  });

  const reconD = makeReconFinding(
    "Revenue divergence — code-verified £184.4m vs £191.2m",
    [ID_B],  // Only B
  );

  const trace = buildTrace([findingB, findingC], makeReconResult([reconD]));

  assertContains(trace.removedIds, ID_B, "Test 2a: B is removed (explicit target)");
  assertNotContains(trace.removedIds, ID_C, "Test 2b (REGRESSION): C is NOT removed despite sharing issue key and amounts");
  assertContains(trace.retainedIds, ID_C, "Test 2c: C is retained in final output");
  assertEqual(trace.finalIds.length, 2, "Test 2d: Final set has 2 findings (C + D)");
}

// ---------------------------------------------------------------------------
// Test 3: D replacing both B and C → only B and C removed
// ---------------------------------------------------------------------------
console.log("\n=== Test 3: D replaces B and C → only B and C removed ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — independent" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B" });
  const findingC = makeFinding({ finding_id: ID_C, title: "Finding C" });

  // D supersedes both B and C
  const reconD = makeReconFinding("Finding D — replaces B and C", [ID_B, ID_C]);
  const trace = buildTrace([findingA, findingB, findingC], makeReconResult([reconD]));

  assertContains(trace.removedIds, ID_B, "Test 3a: B removed");
  assertContains(trace.removedIds, ID_C, "Test 3b: C removed");
  assertContains(trace.retainedIds, ID_A, "Test 3c: A retained");
  assertEqual(trace.finalIds.length, 2, "Test 3d: Final set has 2 (A + D)");
  assert(
    trace.replacementMergedFromIds.includes(ID_B) && trace.replacementMergedFromIds.includes(ID_C),
    "Test 3e: D records both B and C in merged_from_finding_ids",
  );
}

// ---------------------------------------------------------------------------
// Test 4: D replacing nothing (no supersedes_finding_ids) → append-only
// ---------------------------------------------------------------------------
console.log("\n=== Test 4: D has no supersedes → append-only ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B" });

  // No supersedes_finding_ids
  const reconD = makeReconFinding("Finding D — new, no replacement");
  const trace = buildTrace([findingA, findingB], makeReconResult([reconD]));

  assertEqual(trace.removedIds, [], "Test 4a: No findings removed");
  assertEqual(trace.retainedIds, [ID_A, ID_B], "Test 4b: A and B both retained");
  assertEqual(trace.appendedIds.length, 1, "Test 4c: D appended");
  assertEqual(trace.finalIds.length, 3, "Test 4d: Final set has 3 (A + B + D)");
  assert(trace.replacementMergedFromIds.length === 0, "Test 4e: D has no merged_from_finding_ids");
}

// ---------------------------------------------------------------------------
// Test 5: Unknown target ID → no deletion, structured diagnostic emitted
// ---------------------------------------------------------------------------
console.log("\n=== Test 5: Unknown target ID → preserve all + diagnostic ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B" });

  // References UNKNOWN_ID which is not in the canonical set
  const reconD = makeReconFinding("Finding D — references unknown ID", [UNKNOWN_ID]);
  const trace = buildTrace([findingA, findingB], makeReconResult([reconD]));

  assertEqual(trace.removedIds, [], "Test 5a: No findings removed (unknown ID → preserve all)");
  assertContains(trace.retainedIds, ID_A, "Test 5b: A retained");
  assertContains(trace.retainedIds, ID_B, "Test 5c: B retained");

  // D is still appended (replacement finding preserved even when target unknown)
  assertEqual(trace.appendedIds.length, 1, "Test 5d: D appended despite unknown target");

  // Structured diagnostic must be emitted
  const diag = trace.diagnostics.find(d => d.type === "unknown_target_id");
  assert(diag !== undefined, "Test 5e: unknown_target_id diagnostic emitted");
  assert(diag?.unknown_ids?.includes(UNKNOWN_ID) ?? false, "Test 5f: diagnostic lists the unknown ID");
  assert(diag?.message.includes("No findings removed") ?? false, "Test 5g: diagnostic message is explicit");
}

// ---------------------------------------------------------------------------
// Test 6: Same reconciliation output applied twice → stable IDs, no duplicate D
// ---------------------------------------------------------------------------
console.log("\n=== Test 6: Idempotent replay → stable IDs, no duplicate ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — stable" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B — replaced" });

  const reconD = makeReconFinding("Finding D — code-verified replacement", [ID_B]);
  const reconResult = makeReconResult([reconD]);

  // First application
  const result1 = appendReconciliationFindings([findingA, findingB], [], reconResult);
  const finalSet1 = result1.finalFindings;

  // Second application on the already-transformed set
  const result2 = appendReconciliationFindings([...finalSet1], [], reconResult);
  const finalSet2 = result2.finalFindings;

  assertEqual(finalSet2.length, finalSet1.length, "Test 6a: Same number of findings after replay");
  assertEqual(
    finalSet2.map(f => f.title).sort(),
    finalSet1.map(f => f.title).sort(),
    "Test 6b: Same titles after replay (no duplicate D)",
  );

  const dCount = finalSet2.filter(f => f.title === "Finding D — code-verified replacement").length;
  assertEqual(dCount, 1, "Test 6c: Exactly one D in output (no duplicate)");

  // Idempotent skip diagnostic on second pass
  const idempotentDiag = result2.diagnostics.find(d => d.type === "idempotent_skip");
  assert(idempotentDiag !== undefined, "Test 6d: idempotent_skip diagnostic emitted on second application");
}

// ---------------------------------------------------------------------------
// Test 7: Interrupted/resumed application equals uninterrupted application
// (Simulates: apply reconciliation on original set vs apply on partially-modified set)
// ---------------------------------------------------------------------------
console.log("\n=== Test 7: Interrupted/resumed equals uninterrupted ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — retained" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B — superseded" });
  const findingC = makeFinding({ finding_id: ID_C, title: "Finding C — retained" });

  const reconD = makeReconFinding("Finding D — replaces B", [ID_B]);
  const reconResult = makeReconResult([reconD]);

  // Uninterrupted: apply on full set
  const uninterrupted = appendReconciliationFindings(
    [findingA, findingB, findingC],
    [],
    reconResult,
  );

  // Interrupted: B was already removed before the reconciliation step resumed
  // (simulates a checkpoint reload where B was partially deleted)
  const interrupted = appendReconciliationFindings(
    [findingA, findingC], // B already gone
    [],
    reconResult,
  );

  // D must appear in both. The ID will differ (fresh UUID each time when B not present)
  // but the titles and set composition must be equivalent.
  const unintTitles = uninterrupted.finalFindings.map(f => f.title).sort();
  const intTitles = interrupted.finalFindings.map(f => f.title).sort();

  assertEqual(intTitles, unintTitles, "Test 7a: Interrupted/resumed produces identical title set");
  assertEqual(
    uninterrupted.finalFindings.length,
    interrupted.finalFindings.length,
    "Test 7b: Same finding count regardless of interruption",
  );
}

// ---------------------------------------------------------------------------
// Test 8: Replacement metadata contains exactly the IDs actually removed
// ---------------------------------------------------------------------------
console.log("\n=== Test 8: merged_from_finding_ids is exactly the removed set ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — retained" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B — removed" });
  const findingC = makeFinding({ finding_id: ID_C, title: "Finding C — retained (not targeted)" });

  // D supersedes B and also references UNKNOWN_ID (one valid, one unknown)
  // → unknown causes NO removal → merged_from_finding_ids must be empty
  const reconD_mixedTarget = makeReconFinding("Finding D — mixed targets", [ID_B, UNKNOWN_ID]);
  const traceMixed = buildTrace([findingA, findingB, findingC], makeReconResult([reconD_mixedTarget]));

  assertEqual(traceMixed.removedIds, [], "Test 8a: No removal when any target is unknown");
  assertEqual(traceMixed.replacementMergedFromIds, [], "Test 8b: merged_from_finding_ids is empty when no removal");

  // D supersedes only B (clean case)
  const reconD_clean = makeReconFinding("Finding D — clean replacement", [ID_B]);
  const traceClean = buildTrace([findingA, findingB, findingC], makeReconResult([reconD_clean]));

  assertEqual(traceClean.removedIds, [ID_B], "Test 8c: Only B removed");
  assertEqual(traceClean.replacementMergedFromIds, [ID_B], "Test 8d: merged_from_finding_ids = [ID_B] exactly");
  assertNotContains(traceClean.removedIds, ID_A, "Test 8e: A not in removed");
  assertNotContains(traceClean.removedIds, ID_C, "Test 8f: C not in removed");

  // Verify replacement_applied diagnostic has correct metadata
  const appliedDiag = traceClean.diagnostics.find(d => d.type === "replacement_applied");
  assert(appliedDiag !== undefined, "Test 8g: replacement_applied diagnostic emitted");
  assertEqual(appliedDiag?.removed_ids, [ID_B], "Test 8h: diagnostic.removed_ids = [ID_B]");
  assertEqual(appliedDiag?.target_ids, [ID_B], "Test 8i: diagnostic.target_ids = [ID_B]");
}

// ---------------------------------------------------------------------------
// Before-and-after ID trace (full summary)
// ---------------------------------------------------------------------------
console.log("\n=== Before-and-After ID Trace (Test 1 scenario) ===");
{
  const findingA = makeFinding({ finding_id: ID_A, title: "Finding A — lease obligation" });
  const findingB = makeFinding({ finding_id: ID_B, title: "Finding B — FCA authorisation risk (LLM)" });
  const findingC = makeFinding({ finding_id: ID_C, title: "Finding C — working capital gap" });
  const reconD = makeReconFinding("Finding D — code-verified FCA authorisation risk", [ID_B]);

  const trace = buildTrace([findingA, findingB, findingC], makeReconResult([reconD]));

  console.log("  Input canonical finding IDs:     ", trace.inputIds);
  console.log("  Explicit replacement target IDs: ", trace.targetIds);
  console.log("  Removed IDs:                     ", trace.removedIds);
  console.log("  Retained IDs:                    ", trace.retainedIds);
  console.log("  Appended IDs:                    ", trace.appendedIds);
  console.log("  Final canonical finding IDs:     ", trace.finalIds);
  console.log("  Replacement merged_from IDs:     ", trace.replacementMergedFromIds);
  console.log("  Diagnostics:                     ", JSON.stringify(trace.diagnostics));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Fix 11 (ID-Scoped Reconciliation) tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
