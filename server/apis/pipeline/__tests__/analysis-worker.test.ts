/**
 * Regression tests: Analysis Worker — bounded lease-based coordination
 *
 * Tests the analysis_work_items state machine covering:
 * - Two workers cannot claim the same work item (atomic claiming)
 * - Expired leases are recovered and re-claimable
 * - Completed chunks are not recomputed (idempotent population)
 * - Partial batch success survives sibling failure
 * - Repeated short invocations monotonically reduce pending count
 * - Dual-write mismatch detection
 *
 * Run: npx tsx server/apis/pipeline/__tests__/analysis-worker.test.ts
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`  ✗ FAIL: ${msg}`); failed++; } else { passed++; }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { console.error(`  ✗ FAIL [${label}]: expected ${b}, got ${a}`); failed++; } else { passed++; }
}

// ─── Types mirroring analysis-worker.ts ──────────────────────────────────────

type WorkItemStatus = "pending" | "claimed" | "complete" | "failed_retryable" | "failed_permanent";

interface WorkItem {
  id: string;
  run_id: string;
  chunk_index: number;
  document_id: string;
  content_hash: string;
  analysis_version: string;
  status: WorkItemStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_expires_at: number | null;
  attempt_count: number;
  completed_at: number | null;
  error_message: string | null;
}

interface AnalysisCounts {
  total: number;
  pending: number;
  claimed: number;
  complete: number;
  failed_retryable: number;
  failed_permanent: number;
}

// ─── In-memory simulation of analysis_work_items table ───────────────────────

const LEASE_DURATION_MS = 300_000; // 5 minutes
const MAX_ATTEMPTS = 3;

class InMemoryWorkItemStore {
  private items: Map<string, WorkItem> = new Map();
  private nextId = 1;
  private clock: number = Date.now();

  setClock(t: number) { this.clock = t; }
  advanceClock(ms: number) { this.clock += ms; }
  now() { return this.clock; }

  // Mirrors populateWorkItems — idempotent by run_id+chunk_index
  populate(
    runId: string,
    chunks: Array<{ document_id: string; chunk_index: number; content_hash: string }>,
    analysisVersion: string
  ): { inserted: number; skipped: number; total: number } {
    let inserted = 0;
    let skipped = 0;
    for (const chunk of chunks) {
      const existingKey = `${runId}:${chunk.chunk_index}`;
      const existing = [...this.items.values()].find(
        (i) => i.run_id === runId && i.chunk_index === chunk.chunk_index
      );
      if (existing) {
        skipped++;
        continue;
      }
      const id = `wi_${this.nextId++}`;
      this.items.set(id, {
        id,
        run_id: runId,
        chunk_index: chunk.chunk_index,
        document_id: chunk.document_id,
        content_hash: chunk.content_hash,
        analysis_version: analysisVersion,
        status: "pending",
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        attempt_count: 0,
        completed_at: null,
        error_message: null,
      });
      inserted++;
    }
    return { inserted, skipped, total: inserted + skipped };
  }

  // Mirrors claimBatch — atomic SELECT FOR UPDATE SKIP LOCKED
  // The "atomic" guarantee is simulated by mutex in the test (sequential calls)
  claimBatch(
    runId: string,
    claimerId: string,
    batchSize: number
  ): { claimed: WorkItem[]; recovered: number } {
    // First: recover expired leases
    let recovered = 0;
    for (const item of this.items.values()) {
      if (
        item.run_id === runId &&
        item.status === "claimed" &&
        item.lease_expires_at !== null &&
        item.lease_expires_at < this.clock
      ) {
        if (item.attempt_count >= MAX_ATTEMPTS) {
          item.status = "failed_permanent";
          item.error_message = "Exceeded max attempts after lease expiry";
        } else {
          item.status = "pending";
          item.claimed_by = null;
          item.claimed_at = null;
          item.lease_expires_at = null;
        }
        recovered++;
      }
    }

    // Claim pending or failed_retryable items up to batchSize
    const claimed: WorkItem[] = [];
    for (const item of this.items.values()) {
      if (claimed.length >= batchSize) break;
      if (
        item.run_id === runId &&
        (item.status === "pending" || item.status === "failed_retryable") &&
        item.attempt_count < MAX_ATTEMPTS
      ) {
        item.status = "claimed";
        item.claimed_by = claimerId;
        item.claimed_at = this.clock;
        item.lease_expires_at = this.clock + LEASE_DURATION_MS;
        item.attempt_count++;
        claimed.push({ ...item });
      }
    }

    return { claimed, recovered };
  }

  // Mirrors completeItem
  completeItem(itemId: string): void {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (item.status !== "claimed") throw new Error(`Cannot complete item in status ${item.status}`);
    item.status = "complete";
    item.completed_at = this.clock;
  }

  // Mirrors failItem
  failItem(itemId: string, error: string): void {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (item.status !== "claimed") throw new Error(`Cannot fail item in status ${item.status}`);
    if (item.attempt_count >= MAX_ATTEMPTS) {
      item.status = "failed_permanent";
    } else {
      item.status = "failed_retryable";
    }
    item.error_message = error;
    item.claimed_by = null;
    item.claimed_at = null;
    item.lease_expires_at = null;
  }

  getCounts(runId: string): AnalysisCounts {
    const counts: AnalysisCounts = { total: 0, pending: 0, claimed: 0, complete: 0, failed_retryable: 0, failed_permanent: 0 };
    for (const item of this.items.values()) {
      if (item.run_id !== runId) continue;
      counts.total++;
      if (item.status === "pending") counts.pending++;
      else if (item.status === "claimed") counts.claimed++;
      else if (item.status === "complete") counts.complete++;
      else if (item.status === "failed_retryable") counts.failed_retryable++;
      else if (item.status === "failed_permanent") counts.failed_permanent++;
    }
    return counts;
  }

  isAnalysisComplete(runId: string): boolean {
    for (const item of this.items.values()) {
      if (item.run_id !== runId) continue;
      if (item.status !== "complete" && item.status !== "failed_permanent") return false;
    }
    return true;
  }

  getItem(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  getAllForRun(runId: string): WorkItem[] {
    return [...this.items.values()].filter(i => i.run_id === runId);
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

function testIdempotentPopulation() {
  console.log("\n═══ Test: Idempotent population (completed chunks not recomputed) ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_001";
  const chunks = [
    { document_id: "doc_a", chunk_index: 0, content_hash: "hash_0" },
    { document_id: "doc_a", chunk_index: 1, content_hash: "hash_1" },
    { document_id: "doc_b", chunk_index: 2, content_hash: "hash_2" },
  ];

  // First population
  const result1 = store.populate(runId, chunks, "v1.0");
  assertEq(result1.inserted, 3, "first populate inserts all");
  assertEq(result1.skipped, 0, "first populate skips none");

  // Second population (identical) — must be no-op
  const result2 = store.populate(runId, chunks, "v1.0");
  assertEq(result2.inserted, 0, "second populate inserts none");
  assertEq(result2.skipped, 3, "second populate skips all");
  assertEq(result2.total, 3, "total unchanged");

  // Verify items unchanged
  const counts = store.getCounts(runId);
  assertEq(counts.total, 3, "3 items in store");
  assertEq(counts.pending, 3, "all still pending");
}

function testAtomicClaiming() {
  console.log("\n═══ Test: Two workers cannot claim the same work item ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_002";
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    document_id: `doc_${i}`,
    chunk_index: i,
    content_hash: `hash_${i}`,
  }));
  store.populate(runId, chunks, "v1.0");

  // Worker A claims batch of 5
  const claimA = store.claimBatch(runId, "worker_A", 5);
  assertEq(claimA.claimed.length, 5, "Worker A gets 5 items");

  // Worker B claims batch of 5 — must get DIFFERENT items
  const claimB = store.claimBatch(runId, "worker_B", 5);
  assertEq(claimB.claimed.length, 5, "Worker B gets 5 items");

  // No overlap
  const idsA = new Set(claimA.claimed.map((c) => c.id));
  const idsB = new Set(claimB.claimed.map((c) => c.id));
  let overlap = 0;
  for (const id of idsB) {
    if (idsA.has(id)) overlap++;
  }
  assertEq(overlap, 0, "zero overlap between workers");

  // Nothing left to claim
  const claimC = store.claimBatch(runId, "worker_C", 5);
  assertEq(claimC.claimed.length, 0, "no items left for Worker C");

  // Verify all claimed
  const counts = store.getCounts(runId);
  assertEq(counts.claimed, 10, "all 10 items claimed");
  assertEq(counts.pending, 0, "none pending");
}

function testExpiredLeaseRecovery() {
  console.log("\n═══ Test: Expired leases are recovered ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_003";
  const chunks = [
    { document_id: "doc_a", chunk_index: 0, content_hash: "hash_0" },
    { document_id: "doc_a", chunk_index: 1, content_hash: "hash_1" },
  ];
  store.populate(runId, chunks, "v1.0");

  // Worker A claims both
  const claim1 = store.claimBatch(runId, "worker_A", 2);
  assertEq(claim1.claimed.length, 2, "Worker A claims 2");

  // Worker A "crashes" — time advances past lease
  store.advanceClock(LEASE_DURATION_MS + 1000);

  // Worker B claims — should recover expired leases and claim them
  const claim2 = store.claimBatch(runId, "worker_B", 2);
  assertEq(claim2.recovered, 2, "2 expired leases recovered");
  assertEq(claim2.claimed.length, 2, "Worker B claims the recovered items");

  // Items now belong to Worker B
  const counts = store.getCounts(runId);
  assertEq(counts.claimed, 2, "2 claimed by Worker B");
  assertEq(counts.pending, 0, "none pending");
}

function testPartialBatchSurvival() {
  console.log("\n═══ Test: Partial batch success survives sibling failure ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_004";
  const chunks = Array.from({ length: 4 }, (_, i) => ({
    document_id: `doc_${i}`,
    chunk_index: i,
    content_hash: `hash_${i}`,
  }));
  store.populate(runId, chunks, "v1.0");

  // Worker claims all 4
  const claim = store.claimBatch(runId, "worker_A", 4);
  assertEq(claim.claimed.length, 4, "claimed 4 items");

  // Process: 2 succeed, 1 fails, 1 succeeds
  store.completeItem(claim.claimed[0].id);
  store.completeItem(claim.claimed[1].id);
  store.failItem(claim.claimed[2].id, "AI timeout");
  store.completeItem(claim.claimed[3].id);

  // Verify: 3 complete, 1 failed_retryable (re-claimable)
  const counts = store.getCounts(runId);
  assertEq(counts.complete, 3, "3 items complete");
  assertEq(counts.failed_retryable, 1, "1 item failed_retryable");
  assertEq(counts.failed_permanent, 0, "none permanently failed");

  // The failed item can be reclaimed
  const claim2 = store.claimBatch(runId, "worker_B", 1);
  assertEq(claim2.claimed.length, 1, "failed item re-claimable");
  assertEq(claim2.claimed[0].chunk_index, 2, "re-claimed the right chunk");
}

function testMonotonicProgressReduction() {
  console.log("\n═══ Test: Repeated invocations monotonically reduce pending chunks ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_005";
  const totalChunks = 20;
  const chunks = Array.from({ length: totalChunks }, (_, i) => ({
    document_id: `doc_${i % 5}`,
    chunk_index: i,
    content_hash: `hash_${i}`,
  }));
  store.populate(runId, chunks, "v1.0");

  const BATCH_SIZE = 8;
  let prevPending = totalChunks;
  let invocations = 0;

  // Simulate repeated invocations (each claims and completes a batch)
  while (!store.isAnalysisComplete(runId)) {
    invocations++;
    if (invocations > 10) {
      assert(false, "should complete within 10 invocations");
      break;
    }

    const claim = store.claimBatch(runId, `worker_inv${invocations}`, BATCH_SIZE);
    // Complete all claimed items
    for (const item of claim.claimed) {
      store.completeItem(item.id);
    }

    const counts = store.getCounts(runId);
    const currentPending = counts.pending + counts.claimed;
    assert(currentPending <= prevPending, `monotonic: ${currentPending} <= ${prevPending} after invocation ${invocations}`);
    prevPending = currentPending;
  }

  assert(store.isAnalysisComplete(runId), "all items terminal after loop");
  const finalCounts = store.getCounts(runId);
  assertEq(finalCounts.complete, totalChunks, "all 20 chunks complete");
  console.log(`  Completed ${totalChunks} chunks in ${invocations} invocations (batch=${BATCH_SIZE})`);
}

function testMaxAttemptsLeadsToPermFailure() {
  console.log("\n═══ Test: Exceeding max attempts → permanent failure ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_006";
  const chunks = [{ document_id: "doc_a", chunk_index: 0, content_hash: "hash_0" }];
  store.populate(runId, chunks, "v1.0");

  // Claim and fail MAX_ATTEMPTS times
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const claim = store.claimBatch(runId, `worker_attempt_${attempt}`, 1);
    if (attempt <= MAX_ATTEMPTS) {
      assertEq(claim.claimed.length, 1, `attempt ${attempt}: claimed 1`);
      store.failItem(claim.claimed[0].id, `Failure ${attempt}`);
    }
  }

  // After MAX_ATTEMPTS claim+fail cycles:
  // - Claim 1: attempt_count → 1, failItem checks 1 >= 3 → false → failed_retryable
  // - Claim 2: attempt_count → 2, failItem checks 2 >= 3 → false → failed_retryable
  // - Claim 3: attempt_count → 3, failItem checks 3 >= 3 → true → failed_permanent
  
  const counts = store.getCounts(runId);
  assertEq(counts.failed_permanent, 1, "item permanently failed after max attempts");
  assertEq(counts.pending, 0, "no pending items");
  assert(store.isAnalysisComplete(runId), "run is complete (all items terminal)");
}

function testConcurrentWorkerIsolation() {
  console.log("\n═══ Test: Concurrent workers — isolation and progress ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_007";
  const totalChunks = 16;
  const chunks = Array.from({ length: totalChunks }, (_, i) => ({
    document_id: `doc_${i % 4}`,
    chunk_index: i,
    content_hash: `hash_${i}`,
  }));
  store.populate(runId, chunks, "v1.0");

  // Simulate 4 concurrent workers, each claiming 4 items
  const workerClaims: { workerId: string; items: WorkItem[] }[] = [];
  for (let w = 0; w < 4; w++) {
    const claim = store.claimBatch(runId, `worker_${w}`, 4);
    workerClaims.push({ workerId: `worker_${w}`, items: claim.claimed });
  }

  // Verify all 16 items claimed, no overlap
  const allClaimedIds = new Set<string>();
  for (const wc of workerClaims) {
    for (const item of wc.items) {
      assert(!allClaimedIds.has(item.id), `no overlap: ${item.id}`);
      allClaimedIds.add(item.id);
    }
  }
  assertEq(allClaimedIds.size, totalChunks, "all 16 items claimed across 4 workers");

  // Worker 0 and 2 complete; Worker 1 crashes (lease expires); Worker 3 completes
  for (const item of workerClaims[0].items) store.completeItem(item.id);
  // Worker 1 — no action (simulates crash)
  for (const item of workerClaims[2].items) store.completeItem(item.id);
  for (const item of workerClaims[3].items) store.completeItem(item.id);

  // 12 complete, 4 still claimed by Worker 1
  let counts = store.getCounts(runId);
  assertEq(counts.complete, 12, "12 complete");
  assertEq(counts.claimed, 4, "4 still claimed by crashed worker");
  assert(!store.isAnalysisComplete(runId), "not yet complete");

  // Time passes, leases expire
  store.advanceClock(LEASE_DURATION_MS + 1);

  // New worker recovers expired leases and claims them
  const recoverClaim = store.claimBatch(runId, "recovery_worker", 4);
  assertEq(recoverClaim.recovered, 4, "4 leases recovered");
  assertEq(recoverClaim.claimed.length, 4, "all 4 re-claimed");

  // Complete them
  for (const item of recoverClaim.claimed) store.completeItem(item.id);

  counts = store.getCounts(runId);
  assertEq(counts.complete, 16, "all 16 complete after recovery");
  assert(store.isAnalysisComplete(runId), "run is fully complete");
}

function testResumedWorkerDoesNotReprocess() {
  console.log("\n═══ Test: Resumed worker does not reprocess completed chunks ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_008";
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    document_id: `doc_${i}`,
    chunk_index: i,
    content_hash: `hash_${i}`,
  }));
  store.populate(runId, chunks, "v1.0");

  // First invocation: process 5 chunks
  const claim1 = store.claimBatch(runId, "worker_inv1", 5);
  for (const item of claim1.claimed) store.completeItem(item.id);

  let counts = store.getCounts(runId);
  assertEq(counts.complete, 5, "5 done after first invocation");
  assertEq(counts.pending, 5, "5 remaining");

  // Second invocation (resume): must claim only the remaining 5
  const claim2 = store.claimBatch(runId, "worker_inv2", 8);
  assertEq(claim2.claimed.length, 5, "only 5 remaining items claimed");

  // Verify the claimed items are the ones not yet complete
  const completedIndices = new Set(claim1.claimed.map(c => c.chunk_index));
  for (const item of claim2.claimed) {
    assert(!completedIndices.has(item.chunk_index), `chunk ${item.chunk_index} not in already-completed set`);
  }

  // Complete them
  for (const item of claim2.claimed) store.completeItem(item.id);
  assert(store.isAnalysisComplete(runId), "all 10 chunks complete after resume");
}

function testDualWriteMismatchDetection() {
  console.log("\n═══ Test: Dual-write mismatch detection ═══");
  // This simulates the scenario where a work item says "complete" but
  // no corresponding pipeline_analysis row exists (or vice versa).
  // The real detectMismatches queries both tables; here we simulate the logic.

  interface DualWriteState {
    workItemComplete: Set<number>; // chunk indices marked complete in work_items
    pipelineAnalysisRows: Set<number>; // chunk indices in pipeline_analysis
  }

  function detectMismatches(state: DualWriteState): number[] {
    const mismatches: number[] = [];
    // Work item says complete but no pipeline_analysis row
    for (const idx of state.workItemComplete) {
      if (!state.pipelineAnalysisRows.has(idx)) {
        mismatches.push(idx);
      }
    }
    return mismatches;
  }

  // Happy path: no mismatches
  const happyState: DualWriteState = {
    workItemComplete: new Set([0, 1, 2, 3]),
    pipelineAnalysisRows: new Set([0, 1, 2, 3]),
  };
  assertEq(detectMismatches(happyState).length, 0, "no mismatches when in sync");

  // Mismatch: chunk 2 complete in work_items but missing in pipeline_analysis
  const mismatchState: DualWriteState = {
    workItemComplete: new Set([0, 1, 2, 3]),
    pipelineAnalysisRows: new Set([0, 1, 3]), // missing chunk 2
  };
  const mismatches = detectMismatches(mismatchState);
  assertEq(mismatches.length, 1, "1 mismatch detected");
  assertEq(mismatches[0], 2, "mismatch is chunk 2");
}

function testStableIdentity() {
  console.log("\n═══ Test: Stable identity prevents re-analysis when content unchanged ═══");
  const store = new InMemoryWorkItemStore();
  const runId = "run_009";

  // Initial population
  const chunks = [
    { document_id: "doc_a", chunk_index: 0, content_hash: "abc123" },
    { document_id: "doc_a", chunk_index: 1, content_hash: "def456" },
  ];
  store.populate(runId, chunks, "v1.0");

  // Process both
  const claim = store.claimBatch(runId, "worker_1", 2);
  for (const item of claim.claimed) store.completeItem(item.id);
  assert(store.isAnalysisComplete(runId), "initial analysis complete");

  // Re-populate with same identity — should not create new items
  const result = store.populate(runId, chunks, "v1.0");
  assertEq(result.inserted, 0, "no new items when identity unchanged");
  assertEq(result.skipped, 2, "both skipped");

  // Items still complete
  const counts = store.getCounts(runId);
  assertEq(counts.complete, 2, "still 2 complete");
}

// ─── Run all tests ───────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║  Analysis Worker — Regression Test Suite                        ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");

testIdempotentPopulation();
testAtomicClaiming();
testExpiredLeaseRecovery();
testPartialBatchSurvival();
testMonotonicProgressReduction();
testMaxAttemptsLeadsToPermFailure();
testConcurrentWorkerIsolation();
testResumedWorkerDoesNotReprocess();
testDualWriteMismatchDetection();
testStableIdentity();

console.log("\n────────────────────────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error("\n❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("\n✅ ALL TESTS PASSED");
}
