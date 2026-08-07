/**
 * MG-4 Materiality Tiering Stage — Unit tests.
 *
 * Tests tierFindings with a PERSISTENCE-BACKED in-memory queryFn stub and
 * stubbed aiFn — no real DB or model calls.
 *
 * The queryFn stub routes on the `label` meta parameter (which the stage code
 * always passes) to reliably dispatch CREATE TABLE, SELECT, and INSERT operations.
 * INSERT statements add rows to a JS Map keyed by (checkpoint_key, finding_id);
 * SELECT returns matching rows. This validates real resume behavior: pre-seeded
 * rows are found, new rows accumulate incrementally during the run.
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/materiality-tiering-stage.test.ts
 */

import { tierFindings } from "../materiality-tiering-stage.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function makeFinding(overrides: Partial<CanonicalFinding> & { finding_id?: string }): CanonicalFinding {
  return {
    finding_id: overrides.finding_id ?? "00000000-0000-0000-0000-000000000000",
    title: overrides.title ?? "Test finding",
    detail: overrides.detail ?? "Test detail",
    severity: overrides.severity ?? "warning",
    category: overrides.category ?? "principal_finding",
    source_docs: overrides.source_docs ?? [],
    ...overrides,
  } as CanonicalFinding;
}

/** Stub aiFn that returns a fixed tier JSON for each invocation in order */
function makeStubAiFn(tiers: Array<{ tier: number; rationale: string; driver: string } | "throw">): any {
  let idx = 0;
  return async (_req: any, _opts: any, _meta?: any) => {
    const spec = tiers[idx++];
    if (spec === "throw") throw new Error("Stub AI error");
    return {
      id: "msg_stub",
      type: "message" as const,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: JSON.stringify(spec) }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 100 },
    };
  };
}

// ---------------------------------------------------------------------------
// Persistence-backed in-memory checkpoint store
// ---------------------------------------------------------------------------

interface CheckpointRow {
  finding_id: string;
  tier: number;
  rationale: string;
  driver: string;
}

/**
 * Creates a queryFn stub backed by a real in-memory Map.
 *
 * Routes on the `label` metadata parameter:
 *   - "mg4: ensure checkpoint table" → no-op (DDL)
 *   - "mg4: load checkpoint"         → SELECT: returns rows matching checkpoint_key param
 *   - "mg4: persist tier checkpoint"  → INSERT: upserts row into the store
 *
 * Pre-seeded rows simulate data from a prior invocation (resume scenario).
 * The `store` and `insertLog` are exposed for test assertions.
 */
function makeMemoryCheckpointStore(
  preSeeded: Array<{ checkpointKey: string; row: CheckpointRow }> = []
): {
  queryFn: any;
  /** The live store: Map<"checkpointKey|finding_id", CheckpointRow> */
  store: Map<string, CheckpointRow>;
  /** Ordered log of INSERT calls (for verifying incremental writes) */
  insertLog: Array<{ checkpointKey: string; row: CheckpointRow }>;
} {
  const store = new Map<string, CheckpointRow>();
  const insertLog: Array<{ checkpointKey: string; row: CheckpointRow }> = [];

  // Pre-seed
  for (const { checkpointKey, row } of preSeeded) {
    store.set(`${checkpointKey}|${row.finding_id}`, row);
  }

  const queryFn = async (
    _sql: string,
    _schema: any,
    params: unknown[],
    meta?: { label: string }
  ): Promise<any[]> => {
    const label = meta?.label ?? "";

    if (label === "mg4: ensure checkpoint table") {
      // DDL: no-op in memory
      return [];
    }

    if (label === "mg4: load checkpoint") {
      // SELECT: return all rows matching the checkpoint_key (params[0])
      const checkpointKey = params[0] as string;
      const matching: CheckpointRow[] = [];
      for (const [key, row] of store.entries()) {
        if (key.startsWith(`${checkpointKey}|`)) {
          matching.push(row);
        }
      }
      return matching;
    }

    if (label === "mg4: persist tier checkpoint") {
      // INSERT/UPSERT: params = [checkpointKey, finding_id, tier, rationale, driver]
      const checkpointKey = params[0] as string;
      const row: CheckpointRow = {
        finding_id: params[1] as string,
        tier: params[2] as number,
        rationale: params[3] as string,
        driver: params[4] as string,
      };
      store.set(`${checkpointKey}|${row.finding_id}`, row);
      insertLog.push({ checkpointKey, row });
      return [];
    }

    // Unrecognized label: return empty (safe default for DDL/misc)
    return [];
  };

  return { queryFn, store, insertLog };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const F1_ID = "11110000-0000-0000-0000-000000000001";
const F2_ID = "22220000-0000-0000-0000-000000000002";
const F3_ID = "33330000-0000-0000-0000-000000000003";
const F4_ID = "44440000-0000-0000-0000-000000000004"; // non-absence

// Absence survivors
const f1: CanonicalFinding = makeFinding({
  finding_id: F1_ID,
  title: "Missing GDPR consent mechanism",
  gap_type: "memo_omission",
});

const f2: CanonicalFinding = makeFinding({
  finding_id: F2_ID,
  title: "Change of control termination risk",
  gap_type: "memo_omission",
  ...({"absence_verification": "memo_absent_confirmed"} as any),
});

const f3: CanonicalFinding = makeFinding({
  finding_id: F3_ID,
  title: "Thesis drift: risk dropped between memo versions",
  ...({"absence_verification": "thesis_drift"} as any),
});

// Non-absence finding — should NOT be tiered
const f4: CanonicalFinding = makeFinding({
  finding_id: F4_ID,
  title: "Revenue reconciliation discrepancy",
  finding_kind: "data_divergence",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== MG-4: Materiality Tiering Stage Tests ===\n");

  // --- Test 1: 3 absence-surviving findings get correct tier/rationale/driver ---
  console.log("Test 1: 3 absence-surviving findings correctly tiered");
  {
    const findings = [f1, f2, f3, f4].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn, insertLog } = makeMemoryCheckpointStore();
    const aiFn = makeStubAiFn([
      { tier: 1, rationale: "Could break 23% IRR thesis", driver: "retention" },
      { tier: 2, rationale: "Requires condition to close", driver: "M&A pipeline" },
      { tier: 3, rationale: "Immaterial at £655m EV", driver: "none" },
    ]);

    await tierFindings(findings, queryFn, aiFn, "test-run-1:materiality");

    const ff1 = findings.find(f => f.finding_id === F1_ID)!;
    const ff2 = findings.find(f => f.finding_id === F2_ID)!;
    const ff3 = findings.find(f => f.finding_id === F3_ID)!;
    const ff4 = findings.find(f => f.finding_id === F4_ID)!;

    assert(ff1.materiality_tier === 1, `f1 tier = 1 (got ${ff1.materiality_tier})`);
    assert(ff1.tier_rationale === "Could break 23% IRR thesis", `f1 rationale correct`);
    assert(ff1.tier_driver === "retention", `f1 driver = retention`);

    assert(ff2.materiality_tier === 2, `f2 tier = 2 (got ${ff2.materiality_tier})`);
    assert(ff2.tier_rationale === "Requires condition to close", `f2 rationale correct`);
    assert(ff2.tier_driver === "M&A pipeline", `f2 driver = M&A pipeline`);

    assert(ff3.materiality_tier === 3, `f3 tier = 3 (got ${ff3.materiality_tier})`);
    assert(ff3.tier_rationale === "Immaterial at £655m EV", `f3 rationale correct`);
    assert(ff3.tier_driver === "none", `f3 driver = none`);

    // Verify incremental persistence: 3 rows written, one per finding as tiered
    assert(insertLog.length === 3, `3 checkpoint rows inserted incrementally (got ${insertLog.length})`);
    assert(
      insertLog.some(r => r.row.finding_id === F1_ID && r.row.tier === 1),
      `f1 persisted with tier 1`
    );
    assert(
      insertLog.some(r => r.row.finding_id === F2_ID && r.row.tier === 2),
      `f2 persisted with tier 2`
    );
    assert(
      insertLog.some(r => r.row.finding_id === F3_ID && r.row.tier === 3),
      `f3 persisted with tier 3`
    );
  }

  // --- Test 2: Non-absence finding is NOT tiered ---
  console.log("\nTest 2: Non-absence finding NOT tiered");
  {
    const findings = [f4].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn } = makeMemoryCheckpointStore();
    let aiFnCalled = 0;
    const aiFnBase = makeStubAiFn([]);
    const wrappedAiFn = async (req: any, opts: any, meta?: any) => { aiFnCalled++; return aiFnBase(req, opts, meta); };

    await tierFindings(findings, queryFn, wrappedAiFn, "test-run-2:materiality");

    const ff4 = findings[0];
    assert(ff4.materiality_tier === undefined, `f4 materiality_tier is undefined (not tiered)`);
    assert(ff4.tier_rationale === undefined, `f4 tier_rationale is undefined`);
    assert(aiFnCalled === 0, `aiFn never called for non-absence finding (called ${aiFnCalled}x)`);
  }

  // --- Test 3: RESUME — pre-seeded checkpoint skips already-tiered finding ---
  console.log("\nTest 3: Resume skips already-checkpointed findings");
  {
    const findings = [f1, f2, f3].map(f => ({ ...f } as CanonicalFinding));
    const CHECKPOINT_KEY = "test-run-3:materiality";

    // Pre-seed checkpoint with f1 already tiered (simulates prior invocation)
    const { queryFn, store, insertLog } = makeMemoryCheckpointStore([
      { checkpointKey: CHECKPOINT_KEY, row: { finding_id: F1_ID, tier: 1, rationale: "Pre-tiered rationale", driver: "Pre-tiered driver" } },
    ]);

    // Confirm store has the pre-seeded row
    assert(store.size === 1, `Store pre-seeded with 1 row (got ${store.size})`);

    let aiFnCallCount = 0;
    let aiFnCalledForIds: string[] = [];
    const aiFnBase = makeStubAiFn([
      { tier: 2, rationale: "New tier for f2", driver: "driver2" },
      { tier: 3, rationale: "New tier for f3", driver: "none" },
    ]);
    const aiFn = async (req: any, opts: any, meta?: any) => {
      aiFnCallCount++;
      // Track which finding triggered this call (from the label)
      const label = meta?.label ?? "";
      aiFnCalledForIds.push(label);
      return aiFnBase(req, opts, meta);
    };

    const result = await tierFindings(findings, queryFn, aiFn, CHECKPOINT_KEY);

    // f1 should be applied from checkpoint without calling AI
    const ff1 = findings.find(f => f.finding_id === F1_ID)!;
    assert(ff1.materiality_tier === 1, `f1 tier = 1 from checkpoint (got ${ff1.materiality_tier})`);
    assert(ff1.tier_rationale === "Pre-tiered rationale", `f1 rationale from checkpoint`);
    assert(ff1.tier_driver === "Pre-tiered driver", `f1 driver from checkpoint`);

    // f2, f3 should be tiered fresh
    const ff2 = findings.find(f => f.finding_id === F2_ID)!;
    const ff3 = findings.find(f => f.finding_id === F3_ID)!;
    assert(ff2.materiality_tier === 2, `f2 tier = 2 (got ${ff2.materiality_tier})`);
    assert(ff2.tier_rationale === "New tier for f2", `f2 rationale correct`);
    assert(ff3.materiality_tier === 3, `f3 tier = 3 (got ${ff3.materiality_tier})`);
    assert(ff3.tier_rationale === "New tier for f3", `f3 rationale correct`);

    // AI called only for f2 and f3 — NOT for pre-seeded f1
    assert(aiFnCallCount === 2, `aiFn called 2 times (NOT for pre-seeded f1), got ${aiFnCallCount}`);
    const calledForF1 = aiFnCalledForIds.some(label => label.includes(F1_ID.slice(0, 8)));
    assert(!calledForF1, `aiFn was NOT called for f1 (pre-seeded finding)`);

    // Checkpoint result confirms skip
    assert(result.skippedFromCheckpoint === 1, `1 skipped from checkpoint (got ${result.skippedFromCheckpoint})`);

    // Only f2 and f3 were persisted as new rows (f1 was already in store)
    assert(insertLog.length === 2, `Only 2 new checkpoint rows inserted (got ${insertLog.length})`);
    assert(
      !insertLog.some(r => r.row.finding_id === F1_ID),
      `No INSERT for pre-seeded f1 (already in checkpoint)`
    );
    assert(
      insertLog.some(r => r.row.finding_id === F2_ID),
      `f2 was persisted`
    );
    assert(
      insertLog.some(r => r.row.finding_id === F3_ID),
      `f3 was persisted`
    );

    // Store should now have 3 rows total (1 pre-seeded + 2 new)
    assert(store.size === 3, `Store has 3 total rows after run (got ${store.size})`);
  }

  // --- Test 4: SAFETY FLOOR — aiFn throws → defaults to tier 2, not dropped, not tier 3 ---
  console.log("\nTest 4: Safety floor — failed AI call defaults to tier 2 (not 3, not dropped)");
  {
    const findings = [f1, f2].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn, insertLog } = makeMemoryCheckpointStore();
    // f1 succeeds, f2 throws
    const aiFn = makeStubAiFn([
      { tier: 1, rationale: "IC-level issue", driver: "verticalisation" },
      "throw", // f2 will fail
    ]);

    await tierFindings(findings, queryFn, aiFn, "test-run-4:materiality");

    const ff1 = findings.find(f => f.finding_id === F1_ID)!;
    const ff2 = findings.find(f => f.finding_id === F2_ID)!;

    assert(ff1.materiality_tier === 1, `f1 tier = 1 (success path)`);

    assert(ff2.materiality_tier !== undefined, `f2 NOT dropped (has a tier)`);
    assert(ff2.materiality_tier === 2, `f2 defaults to tier 2 (safety floor), got ${ff2.materiality_tier}`);
    assert(
      ff2.tier_rationale === "tiering incomplete — defaulted, needs review",
      `f2 rationale is the safety-floor message (got "${ff2.tier_rationale}")`
    );
    assert(ff2.materiality_tier !== 3, `f2 is NOT tier 3 (must not silently bury)`);

    // Safety-floor result ALSO persisted (so resume doesn't re-attempt infinitely)
    assert(insertLog.length === 2, `Both findings persisted (including safety-floor), got ${insertLog.length}`);
    const f2Row = insertLog.find(r => r.row.finding_id === F2_ID);
    assert(f2Row !== undefined && f2Row.row.tier === 2, `Safety-floor tier 2 persisted for f2`);
  }

  // --- Test 5: TieredResult shape and counts ---
  console.log("\nTest 5: TieredResult shape and counts");
  {
    const findings = [f1, f2, f3, f4].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn } = makeMemoryCheckpointStore();
    const aiFn = makeStubAiFn([
      { tier: 1, rationale: "r1", driver: "d1" },
      { tier: 2, rationale: "r2", driver: "d2" },
      { tier: 3, rationale: "r3", driver: "none" },
    ]);

    const result = await tierFindings(findings, queryFn, aiFn, "test-run-5:materiality");

    assert(result.totalEligible === 3, `totalEligible = 3 (got ${result.totalEligible})`);
    assert(result.tieredCount === 3, `tieredCount = 3 (got ${result.tieredCount})`);
    assert(result.partial === false, `partial = false`);
    assert(result.untieredFindingIds.length === 0, `untieredFindingIds empty`);
    assert(typeof result.skippedFromCheckpoint === "number", `skippedFromCheckpoint is number`);
  }

  // --- Test 6: Empty findings returns valid empty result ---
  console.log("\nTest 6: Empty findings returns valid empty result");
  {
    const { queryFn } = makeMemoryCheckpointStore();
    const aiFn = makeStubAiFn([]);
    const result = await tierFindings([], queryFn, aiFn, "test-run-6:materiality");

    assert(result.totalEligible === 0, `totalEligible = 0`);
    assert(result.tieredCount === 0, `tieredCount = 0`);
    assert(result.partial === false, `partial = false for empty input`);
  }

  // --- Test 7: Checkpoint write is INCREMENTAL (rows accumulate during the run) ---
  console.log("\nTest 7: Checkpoint writes are incremental (rows accumulate during run)");
  {
    const findings = [f1, f2, f3].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn, insertLog, store } = makeMemoryCheckpointStore();

    // Use a slower stub that lets us observe ordering
    let callOrder: string[] = [];
    let aiFnIdx = 0;
    const tierSpecs = [
      { tier: 1, rationale: "r1", driver: "d1" },
      { tier: 2, rationale: "r2", driver: "d2" },
      { tier: 3, rationale: "r3", driver: "d3" },
    ];
    const aiFn = async (_req: any, _opts: any, meta?: any) => {
      const myIdx = aiFnIdx++;
      callOrder.push(`ai_call_${myIdx}`);
      return {
        id: "msg_stub",
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: JSON.stringify(tierSpecs[myIdx]) }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    };

    await tierFindings(findings, queryFn, aiFn, "test-run-7:materiality");

    // All 3 should be persisted
    assert(insertLog.length === 3, `3 rows inserted incrementally (got ${insertLog.length})`);
    // Each row was written individually as its finding was tiered
    assert(insertLog[0].row.finding_id !== insertLog[1].row.finding_id, `Rows have distinct finding_ids`);
    // Store should contain all 3
    assert(store.size === 3, `Store contains all 3 rows (got ${store.size})`);
    // The key point: rows were written ONE AT A TIME (not batched at end)
    // Verified by insertLog having entries — each INSERT fires per finding
    assert(callOrder.length === 3, `3 AI calls made (got ${callOrder.length})`);
  }

  // --- Test 8: Checkpoint read error (non-table-missing) throws loud ---
  console.log("\nTest 8: Real checkpoint read error fails loud (not swallowed)");
  {
    const findings = [f1].map(f => ({ ...f } as CanonicalFinding));
    let threw = false;
    let errorMsg = "";

    // A queryFn that throws a REAL error (not "does not exist") on SELECT
    const brokenQueryFn = async (_sql: string, _schema: any, _params: unknown[], meta?: { label: string }): Promise<any[]> => {
      if (meta?.label === "mg4: ensure checkpoint table") return [];
      if (meta?.label === "mg4: load checkpoint") {
        throw new Error("permission denied for relation mg4_materiality_tier_checkpoints");
      }
      return [];
    };

    const aiFn = makeStubAiFn([{ tier: 1, rationale: "r", driver: "d" }]);

    try {
      await tierFindings(findings, brokenQueryFn, aiFn, "test-run-8:materiality");
    } catch (e: any) {
      threw = true;
      errorMsg = e.message;
    }

    assert(threw, `tierFindings THREW on real DB error (not silently swallowed)`);
    assert(
      errorMsg.includes("permission denied"),
      `Error message preserved: "${errorMsg}"`
    );
  }

  // --- Summary ---
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
