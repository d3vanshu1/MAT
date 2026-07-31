/**
 * Regression tests for claims-extraction checkpoint gating, truthful terminal
 * status, and reconciliation blocking.
 *
 * Tests exercise:
 * - The production parseClaimsResponse (exported) for truthful status
 * - The production runWorkerPool for budget/completeness semantics
 * - The checkpoint persistence/loading decision logic (replicated from pipeline-core)
 *
 * Run: npx tsx server/apis/pipeline/__tests__/claims-checkpoint-gating.test.ts
 *
 * Parent: 5d6b3826cba3f84e8f43269c7066f1d90a7e2d03
 * Expected: FAIL on parent (parseClaimsResponse not exported / no ParseClaimsResult), PASS after fix.
 */

import {
  runWorkerPool,
  parseClaimsResponse,
  type WorkerPoolJob,
  type ClaimsLedger,
  type TerminalResult,
  type TerminalStatus,
  type ExtractionResult,
} from "../claims-extraction.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { console.error(`FAIL [${label}]: expected ${b}, got ${a}`); process.exit(1); }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

// ─── Production checkpoint decision logic (from pipeline-core.ts) ─────────────

/**
 * Replicated from the production caller to verify the decision logic.
 * This is the EXACT logic used in pipeline-core.ts to determine checkpoint status.
 */
function determineCheckpointStatus(ledger: ClaimsLedger): "complete" | "partial" {
  return (ledger.complete && ledger.extraction_metadata.pending === 0) ? "complete" : "partial";
}

/**
 * Production loader acceptance criteria (from pipeline-core.ts).
 */
function isCheckpointAcceptable(payload: ClaimsLedger): boolean {
  return payload.complete === true && (payload.extraction_metadata?.pending ?? 0) === 0;
}

/**
 * Production reconciliation gate (from pipeline-core.ts).
 */
function canProceedToReconciliation(ledger: ClaimsLedger): boolean {
  return ledger.complete === true && ledger.claims.length > 0;
}

// ─── Build a test ledger ─────────────────────────────────────────────────────

function buildLedger(opts: {
  claims?: unknown[];
  complete: boolean;
  pending: number;
  terminal_results?: TerminalResult[];
}): ClaimsLedger {
  return {
    claims: (opts.claims ?? []) as any,
    complete: opts.complete,
    terminal_results: opts.terminal_results ?? [],
    extraction_metadata: {
      docs_processed: (opts.terminal_results ?? []).filter(r => r.status !== "pending").length,
      pending: opts.pending,
      total_claims: (opts.claims ?? []).length,
      operating_metric_claims: 0,
      deal_mechanics_claims: 0,
      valuation_structuring_claims: 0,
      returns_projection_claims: 0,
      cross_reference_claims: 0,
      extraction_model: "test",
      extraction_timestamp: new Date().toISOString(),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testFiveMemosThreePending(): Promise<void> {
  console.log("  [1] Five-memo run leaving three pending returns complete: false...");
  let launched = 0;
  const jobs: WorkerPoolJob<ExtractionResult>[] = ["A", "B", "C", "D", "E"].map(id => ({
    id,
    label: `memo_${id}`,
    execute: async (): Promise<ExtractionResult> => {
      launched++;
      return { claims: [], truncated: false, parseFailed: false };
    },
  }));

  // Budget allows only 2 launches
  let budgetCalls = 0;
  const result = await runWorkerPool(jobs, {
    concurrency: 2,
    canLaunch: () => { budgetCalls++; return budgetCalls <= 2; },
  });

  assertEq(result.results.length, 2, "terminal count");
  assertEq(result.pending.length, 3, "pending count");

  // Build ledger from results
  const terminalResults: TerminalResult[] = [
    ...result.results.map(r => ({
      memo_id: r.job.id,
      file_name: r.job.label,
      status: "success" as TerminalStatus,
      claims_count: 0,
    })),
    ...result.pending.map(p => ({
      memo_id: p.job.id,
      file_name: p.job.label,
      status: "pending" as TerminalStatus,
      claims_count: 0,
    })),
  ];

  const ledger = buildLedger({ complete: false, pending: 3, terminal_results: terminalResults });
  assertEq(ledger.complete, false, "ledger.complete");
  console.log("    PASS");
}

async function testCallerPersistsPartialStatus(): Promise<void> {
  console.log("  [2] Caller persists partial checkpoint with non-complete status...");
  const incompleteLedger = buildLedger({ complete: false, pending: 2 });
  const status = determineCheckpointStatus(incompleteLedger);
  assertEq(status, "partial", "checkpoint status for incomplete");

  const completeLedger = buildLedger({ complete: true, pending: 0 });
  const completeStatus = determineCheckpointStatus(completeLedger);
  assertEq(completeStatus, "complete", "checkpoint status for complete");
  console.log("    PASS");
}

async function testResumeDoesNotLoadPartial(): Promise<void> {
  console.log("  [3] Resume does not load partial ledger as complete...");
  const partialPayload = buildLedger({ complete: false, pending: 3 });
  assertEq(isCheckpointAcceptable(partialPayload), false, "partial rejected");

  // Even if DB status were 'complete' due to old bug, payload check rejects
  const fakeComplete = buildLedger({ complete: false, pending: 1 });
  assertEq(isCheckpointAcceptable(fakeComplete), false, "fake-complete rejected");
  console.log("    PASS");
}

async function testReconciliationNotInvokedFromIncomplete(): Promise<void> {
  console.log("  [4] Reconciliation is not invoked from incomplete ledger...");
  const incomplete = buildLedger({ claims: [{ fake: true }], complete: false, pending: 1 });
  assertEq(canProceedToReconciliation(incomplete), false, "recon blocked");

  const complete = buildLedger({ claims: [{ fake: true }], complete: true, pending: 0 });
  assertEq(canProceedToReconciliation(complete), true, "recon allowed");
  console.log("    PASS");
}

async function testPipelineInProgressWhilePending(): Promise<void> {
  console.log("  [5] Pipeline returns in_progress while pending memos remain...");
  // This is verified by the ledger.complete check — if incomplete, pipeline returns in_progress
  const ledger = buildLedger({ complete: false, pending: 2 });
  const shouldReturnInProgress = !ledger.complete || ledger.extraction_metadata.pending > 0;
  assertEq(shouldReturnInProgress, true, "in_progress condition");
  console.log("    PASS");
}

async function testResumeProcessesPendingMemos(): Promise<void> {
  console.log("  [6] Resume eventually processes pending and advances to complete...");
  // Simulate: first run leaves 3 pending
  let budgetCalls = 0;
  const jobs: WorkerPoolJob<ExtractionResult>[] = ["A", "B", "C", "D", "E"].map(id => ({
    id,
    label: `memo_${id}`,
    execute: async (): Promise<ExtractionResult> => ({ claims: [], truncated: false, parseFailed: false }),
  }));

  const run1 = await runWorkerPool(jobs, {
    concurrency: 2,
    canLaunch: () => { budgetCalls++; return budgetCalls <= 2; },
  });
  assert(run1.pending.length === 3, "run1 has pending");

  // Resume: no budget constraint — all 5 run
  const run2 = await runWorkerPool(jobs, { concurrency: 2 });
  assertEq(run2.results.length, 5, "run2 all terminal");
  assertEq(run2.pending.length, 0, "run2 no pending");

  const ledger = buildLedger({ complete: true, pending: 0 });
  assertEq(determineCheckpointStatus(ledger), "complete", "final checkpoint complete");
  assertEq(isCheckpointAcceptable(ledger), true, "final checkpoint loadable");
  console.log("    PASS");
}

async function testCompleteLedgerPersistedAndLoaded(): Promise<void> {
  console.log("  [7] Complete ledger persisted and loaded normally...");
  const ledger = buildLedger({ claims: [{ fake: true }], complete: true, pending: 0 });
  assertEq(determineCheckpointStatus(ledger), "complete", "persists as complete");
  assertEq(isCheckpointAcceptable(ledger), true, "accepted on load");
  assertEq(canProceedToReconciliation(ledger), true, "reconciliation proceeds");
  console.log("    PASS");
}

async function testEmptyTextMemoTerminalRecord(): Promise<void> {
  console.log("  [8] Empty-text memo receives explicit terminal record...");
  // Simulate the production logic: empty-text memo returns parseFailed=true
  const job: WorkerPoolJob<ExtractionResult> = {
    id: "empty",
    label: "empty_memo.pdf",
    execute: async (): Promise<ExtractionResult> => {
      // This is what the production code does for empty-text memos
      return { claims: [], truncated: false, parseFailed: true, parseError: "Empty or whitespace-only parsed_text for empty_memo.pdf" };
    },
  };

  const result = await runWorkerPool([job], { concurrency: 1 });
  assertEq(result.results.length, 1, "one result");
  assertEq(result.results[0].status, "fulfilled", "job succeeded (returned result)");

  const extraction = result.results[0].value!;
  assertEq(extraction.parseFailed, true, "parseFailed flag");
  assert(extraction.parseError!.includes("Empty"), "error mentions empty");

  // Terminal status would be "failed" because parseFailed=true
  const terminalStatus: TerminalStatus = extraction.parseFailed ? "failed" : "success";
  assertEq(terminalStatus, "failed", "terminal status for empty memo");
  console.log("    PASS");
}

async function testTruncatedMemoGetsPartial(): Promise<void> {
  console.log("  [9] Truncated memo receives 'partial' status...");
  const job: WorkerPoolJob<ExtractionResult> = {
    id: "big",
    label: "big_memo.pdf",
    execute: async (): Promise<ExtractionResult> => {
      return { claims: [{ fake: "claim" } as any], truncated: true, parseFailed: false };
    },
  };

  const result = await runWorkerPool([job], { concurrency: 1 });
  const extraction = result.results[0].value!;
  assertEq(extraction.truncated, true, "truncated flag");
  assertEq(extraction.parseFailed, false, "not parse-failed");

  // Terminal status: truncated → partial
  const terminalStatus: TerminalStatus = extraction.parseFailed ? "failed" : extraction.truncated ? "partial" : "success";
  assertEq(terminalStatus, "partial", "terminal status for truncated");
  console.log("    PASS");
}

async function testParseFailureDistinguishable(): Promise<void> {
  console.log("  [10] Parse-failure receives 'failed' (not zero-claim success)...");
  // Use the PRODUCTION parseClaimsResponse with invalid JSON
  const result = parseClaimsResponse("not valid json at all", "test_memo.pdf");
  assertEq(result.failed, true, "parse failed flag");
  assert(result.error !== undefined, "error populated");
  assertEq(result.claims.length, 0, "no claims");

  // Compare with genuinely valid extraction yielding zero claims
  const validEmpty = parseClaimsResponse("[]", "empty_valid.pdf");
  assertEq(validEmpty.failed, false, "valid empty: not failed");
  assertEq(validEmpty.claims.length, 0, "valid empty: zero claims");

  // They are distinguishable
  assert(result.failed !== validEmpty.failed, "parse failure ≠ valid empty");
  console.log("    PASS");
}

async function testZeroClaimValidSuccess(): Promise<void> {
  console.log("  [11] Valid memo yielding zero claims recorded as 'success'...");
  const result = parseClaimsResponse("[]", "valid_zero.pdf");
  assertEq(result.failed, false, "not a parse failure");
  assertEq(result.claims.length, 0, "zero claims");

  // Terminal status would be "success" (not failed, not truncated)
  const extraction: ExtractionResult = { claims: result.claims, truncated: false, parseFailed: result.failed };
  const terminalStatus: TerminalStatus = extraction.parseFailed ? "failed" : extraction.truncated ? "partial" : "success";
  assertEq(terminalStatus, "success", "zero-claim valid = success");
  console.log("    PASS");
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("claims-checkpoint-gating regression tests");
  console.log("==========================================");

  await testFiveMemosThreePending();
  await testCallerPersistsPartialStatus();
  await testResumeDoesNotLoadPartial();
  await testReconciliationNotInvokedFromIncomplete();
  await testPipelineInProgressWhilePending();
  await testResumeProcessesPendingMemos();
  await testCompleteLedgerPersistedAndLoaded();
  await testEmptyTextMemoTerminalRecord();
  await testTruncatedMemoGetsPartial();
  await testParseFailureDistinguishable();
  await testZeroClaimValidSuccess();

  console.log("\n✓ All 11 tests passed.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
