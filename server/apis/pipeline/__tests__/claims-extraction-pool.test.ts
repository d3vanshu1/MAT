/**
 * Regression tests for claims-extraction concurrency, terminal accounting,
 * and time-budget gating.
 *
 * Tests the PRODUCTION `runWorkerPool` helper directly — no hand-copied replica.
 * Uses deferred promises and injectable budget predicate for determinism.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/claims-extraction-pool.test.ts
 *
 * Parent: 5bf40ba739d632dccffd5f18989b8d77ed574fe2
 * Expected: FAIL on parent (runWorkerPool does not exist), PASS after fix.
 */

import { runWorkerPool, type WorkerPoolJob, type WorkerPoolResult } from "../claims-extraction.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeJob<T>(id: string, exec: () => Promise<T>): WorkerPoolJob<T> {
  return { id, label: `memo_${id}`, execute: exec };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testSingleMemo(): Promise<void> {
  console.log("  [1] Single memo processed exactly once...");
  let callCount = 0;
  const job = makeJob("A", async () => { callCount++; return ["claim_A"]; });
  const result = await runWorkerPool([job], { concurrency: 2 });

  assertEq(callCount, 1, "single memo call count");
  assertEq(result.results.length, 1, "single memo result count");
  assertEq(result.results[0].status, "fulfilled", "single memo status");
  assertEq(result.results[0].value, ["claim_A"], "single memo value");
  assertEq(result.pending.length, 0, "single memo pending");
  console.log("    PASS");
}

async function testTwoAtConcurrencyTwo(): Promise<void> {
  console.log("  [2] Two memos at concurrency=2 both awaited...");
  const dA = deferred<string[]>();
  const dB = deferred<string[]>();
  const jobs = [
    makeJob("A", () => dA.promise),
    makeJob("B", () => dB.promise),
  ];

  const poolPromise = runWorkerPool(jobs, { concurrency: 2 });

  // Resolve in reverse order
  dB.resolve(["b1"]);
  dA.resolve(["a1"]);
  const result = await poolPromise;

  assertEq(result.results.length, 2, "two memos result count");
  assertEq(result.pending.length, 0, "two memos pending");
  // Order preserved despite out-of-order resolution
  assertEq(result.results[0].job.id, "A", "order idx 0");
  assertEq(result.results[1].job.id, "B", "order idx 1");
  console.log("    PASS");
}

async function testFiveAtConcurrencyTwo(): Promise<void> {
  console.log("  [3] Five memos at concurrency=2 all awaited and collected...");
  const deferreds = ["A", "B", "C", "D", "E"].map(id => ({ id, d: deferred<string[]>() }));
  const jobs = deferreds.map(({ id, d }) => makeJob(id, () => d.promise));

  const poolPromise = runWorkerPool(jobs, { concurrency: 2 });

  // Resolve in shuffled order: C, A, E, B, D
  deferreds[2].d.resolve(["c1"]);
  await tick();
  deferreds[0].d.resolve(["a1"]);
  await tick();
  deferreds[4].d.resolve(["e1"]);
  await tick();
  deferreds[1].d.resolve(["b1"]);
  await tick();
  deferreds[3].d.resolve(["d1"]);

  const result = await poolPromise;

  assertEq(result.results.length, 5, "five memos result count");
  assertEq(result.pending.length, 0, "five memos pending");
  // All results present
  const ids = result.results.map(r => r.job.id);
  assertEq(ids, ["A", "B", "C", "D", "E"], "five memos order");
  console.log("    PASS");
}

async function testLateJobsInFinalLedger(): Promise<void> {
  console.log("  [4] Later jobs resolving after first batch appear in final ledger...");
  const dA = deferred<string[]>();
  const dB = deferred<string[]>();
  const dC = deferred<string[]>();
  const jobs = [
    makeJob("A", () => dA.promise),
    makeJob("B", () => dB.promise),
    makeJob("C", () => dC.promise),
  ];

  const poolPromise = runWorkerPool(jobs, { concurrency: 2 });

  // A finishes first — slot opens for C
  dA.resolve(["a1"]);
  await tick();
  // C resolves long after B
  dB.resolve(["b1"]);
  await tick();
  dC.resolve(["c1", "c2"]);

  const result = await poolPromise;

  assertEq(result.results.length, 3, "late job: all 3 results");
  assertEq(result.results[2].job.id, "C", "late job: C present");
  assertEq(result.results[2].value, ["c1", "c2"], "late job: C value");
  console.log("    PASS");
}

async function testResultOrderPreserved(): Promise<void> {
  console.log("  [5] Result records retain original memo order despite out-of-order completion...");
  const deferreds = ["X", "Y", "Z"].map(id => ({ id, d: deferred<number[]>() }));
  const jobs = deferreds.map(({ id, d }) => makeJob(id, () => d.promise));

  const poolPromise = runWorkerPool(jobs, { concurrency: 3 });

  // Resolve Z first, then X, then Y
  deferreds[2].d.resolve([3]);
  await tick();
  deferreds[0].d.resolve([1]);
  await tick();
  deferreds[1].d.resolve([2]);

  const result = await poolPromise;

  assertEq(result.results.map(r => r.job.id), ["X", "Y", "Z"], "order preserved");
  assertEq(result.results.map(r => r.index), [0, 1, 2], "indices correct");
  console.log("    PASS");
}

async function testFailedMemoTerminalRecord(): Promise<void> {
  console.log("  [6] Failed memo receives a 'failed' terminal record while later jobs still run...");
  const dA = deferred<string[]>();
  const dB = deferred<string[]>();
  const dC = deferred<string[]>();
  const jobs = [
    makeJob("A", () => dA.promise),
    makeJob("B", () => dB.promise),
    makeJob("C", () => dC.promise),
  ];

  const poolPromise = runWorkerPool(jobs, { concurrency: 2 });

  // A fails
  dA.reject(new Error("LLM rate limit"));
  await tick();
  // B and C still succeed
  dB.resolve(["b1"]);
  await tick();
  dC.resolve(["c1"]);

  const result = await poolPromise;

  assertEq(result.results.length, 3, "failed: all 3 results present");
  assertEq(result.results[0].status, "rejected", "failed: A rejected");
  assert(result.results[0].reason instanceof Error, "failed: A has Error");
  assertEq(result.results[1].status, "fulfilled", "failed: B fulfilled");
  assertEq(result.results[2].status, "fulfilled", "failed: C fulfilled");
  assertEq(result.pending.length, 0, "failed: none pending");
  console.log("    PASS");
}

async function testTimedOutMemoCannotDisappear(): Promise<void> {
  console.log("  [7] A timed-out or rejected memo cannot silently disappear...");
  const jobs = [
    makeJob("A", async () => { throw new Error("Connection timeout"); }),
    makeJob("B", async () => ["b1"]),
  ];

  const result = await runWorkerPool(jobs, { concurrency: 2 });

  assertEq(result.results.length, 2, "timeout: both present");
  assertEq(result.results[0].status, "rejected", "timeout: A rejected");
  assertEq(result.results[1].status, "fulfilled", "timeout: B fulfilled");
  console.log("    PASS");
}

async function testMaxConcurrencyRespected(): Promise<void> {
  console.log("  [8] Maximum observed concurrency never exceeds configured limit...");
  let currentConcurrency = 0;
  let maxObserved = 0;
  const LIMIT = 2;

  const jobs = ["A", "B", "C", "D", "E"].map(id =>
    makeJob(id, async () => {
      currentConcurrency++;
      maxObserved = Math.max(maxObserved, currentConcurrency);
      // Simulate async work
      await new Promise(r => setTimeout(r, 5));
      currentConcurrency--;
      return [`${id}_claim`];
    })
  );

  await runWorkerPool(jobs, { concurrency: LIMIT });

  assert(maxObserved <= LIMIT, `max concurrency ${maxObserved} exceeds limit ${LIMIT}`);
  assert(maxObserved === LIMIT, `max concurrency ${maxObserved} should reach ${LIMIT} with 5 jobs`);
  console.log(`    PASS (max observed: ${maxObserved})`);
}

async function testDocsProcessedEqualsTerminalCount(): Promise<void> {
  console.log("  [9] docs_processed equals terminal records count, not input count...");
  let launchCount = 0;
  const jobs = ["A", "B", "C"].map(id =>
    makeJob(id, async () => { launchCount++; return [`${id}_claim`]; })
  );

  // Budget expires after first 2 jobs launch
  const canLaunch = (): boolean => launchCount < 2;

  const result = await runWorkerPool(jobs, { concurrency: 1, canLaunch });

  const terminalCount = result.results.length;
  const pendingCount = result.pending.length;

  assertEq(terminalCount, 2, "terminal records = 2");
  assertEq(pendingCount, 1, "pending = 1");
  assertEq(terminalCount + pendingCount, 3, "terminal + pending = total N");
  console.log("    PASS");
}

async function testLedgerCompleteOnlyWhenAllTerminal(): Promise<void> {
  console.log("  [10] Ledger is complete only when all memos have terminal records...");
  const jobs = ["A", "B", "C", "D", "E"].map(id =>
    makeJob(id, async () => [`${id}_claim`])
  );

  // All pass — no budget constraint
  const result = await runWorkerPool(jobs, { concurrency: 2 });

  assertEq(result.results.length, 5, "complete: all 5 terminal");
  assertEq(result.pending.length, 0, "complete: none pending");

  // Now with budget expiry
  let launched = 0;
  const budgetJobs = ["A", "B", "C", "D", "E"].map(id =>
    makeJob(id, async () => { launched++; return [`${id}_claim`]; })
  );
  const limited = await runWorkerPool(budgetJobs, {
    concurrency: 2,
    canLaunch: () => launched < 3,
  });

  assert(limited.pending.length > 0, "budget: has pending");
  assert(limited.results.length + limited.pending.length === 5, "budget: total = 5");
  console.log("    PASS");
}

async function testBudgetExpiry(): Promise<void> {
  console.log("  [11] Budget expiry: launched jobs awaited, no further launches, remaining pending...");
  const dA = deferred<string[]>();
  const dB = deferred<string[]>();
  const resolveOrder: string[] = [];

  let launchCount = 0;
  const jobs: WorkerPoolJob<string[]>[] = [
    makeJob("A", () => { launchCount++; return dA.promise; }),
    makeJob("B", () => { launchCount++; return dB.promise; }),
    makeJob("C", () => { launchCount++; return Promise.resolve(["c1"]); }),
    makeJob("D", () => { launchCount++; return Promise.resolve(["d1"]); }),
    makeJob("E", () => { launchCount++; return Promise.resolve(["e1"]); }),
  ];

  // Budget allows launching only the first 2 jobs
  // canLaunch is checked BEFORE each launch
  let budgetCalls = 0;
  const canLaunch = (): boolean => {
    budgetCalls++;
    return budgetCalls <= 2; // Allow first 2 calls, deny 3rd
  };

  const poolPromise = runWorkerPool(jobs, { concurrency: 2, canLaunch });

  // Let event loop process initial launches
  await tick();

  // Resolve the launched jobs
  dA.resolve(["a1"]);
  await tick();
  dB.resolve(["b1"]);

  const result = await poolPromise;

  // Verify launched jobs were awaited
  assertEq(result.results.length, 2, "budget: 2 terminal results");
  assertEq(result.results[0].status, "fulfilled", "budget: A fulfilled");
  assertEq(result.results[1].status, "fulfilled", "budget: B fulfilled");
  assertEq(result.results[0].value, ["a1"], "budget: A value");
  assertEq(result.results[1].value, ["b1"], "budget: B value");

  // Verify no further jobs launched
  assertEq(launchCount, 2, "budget: only 2 launched");

  // Verify remaining are pending
  assertEq(result.pending.length, 3, "budget: 3 pending");
  assertEq(result.pending.map(p => p.job.id), ["C", "D", "E"], "budget: pending IDs");

  // Verify invariants
  assertEq(result.results.length + result.pending.length, 5, "budget: terminal + pending = N");

  console.log("    PASS");
}

async function testNoLeakedPromises(): Promise<void> {
  console.log("  [12] No launched promise remains running after the function returns...");
  let runningCount = 0;
  const jobs = ["A", "B", "C"].map(id =>
    makeJob(id, async () => {
      runningCount++;
      await new Promise(r => setTimeout(r, 10));
      runningCount--;
      return [`${id}`];
    })
  );

  await runWorkerPool(jobs, { concurrency: 2 });

  assertEq(runningCount, 0, "no leaked promises: running count = 0 after return");
  console.log("    PASS");
}

// ─── Runner ─────────────────────────────────────────────────────────────────

function tick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

async function main(): Promise<void> {
  console.log("claims-extraction-pool regression tests");
  console.log("========================================");

  await testSingleMemo();
  await testTwoAtConcurrencyTwo();
  await testFiveAtConcurrencyTwo();
  await testLateJobsInFinalLedger();
  await testResultOrderPreserved();
  await testFailedMemoTerminalRecord();
  await testTimedOutMemoCannotDisappear();
  await testMaxConcurrencyRespected();
  await testDocsProcessedEqualsTerminalCount();
  await testLedgerCompleteOnlyWhenAllTerminal();
  await testBudgetExpiry();
  await testNoLeakedPromises();

  console.log("\n✓ All 12 tests passed.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
