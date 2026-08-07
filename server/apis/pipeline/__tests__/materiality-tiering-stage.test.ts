/**
 * MG-4 Materiality Tiering Stage — Unit tests.
 *
 * Tests tierFindings with stubbed queryFn and aiFn — no real DB or model calls.
 * Run via: npx tsx server/apis/pipeline/__tests__/materiality-tiering-stage.test.ts
 */

import { tierFindings } from "../materiality-tiering-stage.js";
import type { CanonicalFinding } from "../canonical-finding.js";

let _uuidCounter = 0;
function randomUUID(): string {
  _uuidCounter++;
  return `00000000-0000-4000-a000-${String(_uuidCounter).padStart(12, "0")}`;
}

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
    finding_id: overrides.finding_id ?? randomUUID(),
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

/** Stub queryFn that handles checkpoint table operations */
function makeStubQueryFn(
  checkpointRows: Array<{ finding_id: string; tier: number; rationale: string; driver: string }> = []
): { queryFn: any; insertedRows: Array<{ finding_id: string; tier: number; rationale: string; driver: string }> } {
  const insertedRows: Array<{ finding_id: string; tier: number; rationale: string; driver: string }> = [];
  const queryFn = async (sql: string, _schema: any, params: unknown[], _meta?: any): Promise<any[]> => {
    if (/CREATE TABLE/i.test(sql)) return [];
    if (/SELECT.*checkpoint_key/i.test(sql)) return checkpointRows;
    if (/INSERT INTO/i.test(sql)) {
      // params: [checkpointKey, finding_id, tier, rationale, driver]
      insertedRows.push({
        finding_id: params[1] as string,
        tier: params[2] as number,
        rationale: params[3] as string,
        driver: params[4] as string,
      });
      return [];
    }
    return [];
  };
  return { queryFn, insertedRows };
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
  // Also has absence_verification
  ...({"absence_verification": "memo_absent_confirmed"} as any),
});

const f3: CanonicalFinding = makeFinding({
  finding_id: F3_ID,
  title: "Thesis drift: risk dropped between memo versions",
  // Thesis drift via absence_verification
  ...({"absence_verification": "thesis_drift"} as any),
});

// Non-absence finding — should NOT be tiered
const f4: CanonicalFinding = makeFinding({
  finding_id: F4_ID,
  title: "Revenue reconciliation discrepancy",
  finding_kind: "data_divergence",
  // No gap_type or absence_verification
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
    const { queryFn, insertedRows } = makeStubQueryFn();
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

    assert(insertedRows.length === 3, `3 checkpoint rows inserted (got ${insertedRows.length})`);
  }

  // --- Test 2: Non-absence finding is NOT tiered ---
  console.log("\nTest 2: Non-absence finding NOT tiered");
  {
    const findings = [f4].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn } = makeStubQueryFn();
    let aiFnCalled = 0;
    const aiFn = makeStubAiFn([]);
    const wrappedAiFn = async (req: any, opts: any, meta?: any) => { aiFnCalled++; return aiFn(req, opts, meta); };

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

    // Pre-seed checkpoint with f1 already tiered
    const preSeeded = [{ finding_id: F1_ID, tier: 1, rationale: "Pre-tiered rationale", driver: "Pre-tiered driver" }];
    const { queryFn, insertedRows } = makeStubQueryFn(preSeeded);

    let aiFnCallCount = 0;
    const aiFnBase = makeStubAiFn([
      { tier: 2, rationale: "New tier for f2", driver: "driver2" },
      { tier: 3, rationale: "New tier for f3", driver: "none" },
    ]);
    const aiFn = async (req: any, opts: any, meta?: any) => { aiFnCallCount++; return aiFnBase(req, opts, meta); };

    const result = await tierFindings(findings, queryFn, aiFn, "test-run-3:materiality");

    // f1 should be applied from checkpoint without calling AI
    const ff1 = findings.find(f => f.finding_id === F1_ID)!;
    assert(ff1.materiality_tier === 1, `f1 tier = 1 from checkpoint (got ${ff1.materiality_tier})`);
    assert(ff1.tier_rationale === "Pre-tiered rationale", `f1 rationale from checkpoint`);

    // f2, f3 should be tiered fresh
    const ff2 = findings.find(f => f.finding_id === F2_ID)!;
    const ff3 = findings.find(f => f.finding_id === F3_ID)!;
    assert(ff2.materiality_tier === 2, `f2 tier = 2 (got ${ff2.materiality_tier})`);
    assert(ff3.materiality_tier === 3, `f3 tier = 3 (got ${ff3.materiality_tier})`);

    // AI called only for f2 and f3 (not f1)
    assert(aiFnCallCount === 2, `aiFn called 2 times (not for pre-seeded f1), got ${aiFnCallCount}`);
    assert(result.skippedFromCheckpoint === 1, `1 skipped from checkpoint (got ${result.skippedFromCheckpoint})`);
    assert(insertedRows.length === 2, `Only 2 new checkpoint rows inserted (got ${insertedRows.length})`);
  }

  // --- Test 4: SAFETY FLOOR — aiFn throws → defaults to tier 2, not dropped, not tier 3 ---
  console.log("\nTest 4: Safety floor — failed AI call defaults to tier 2 (not 3, not dropped)");
  {
    const findings = [f1, f2].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn } = makeStubQueryFn();
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
    // Critically, NOT tier 3 (would silently bury in appendix)
    assert(ff2.materiality_tier !== 3, `f2 is NOT tier 3 (must not silently bury)`);
  }

  // --- Test 5: TieredResult shape and counts ---
  console.log("\nTest 5: TieredResult shape and counts");
  {
    const findings = [f1, f2, f3, f4].map(f => ({ ...f } as CanonicalFinding));
    const { queryFn } = makeStubQueryFn();
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
    const { queryFn } = makeStubQueryFn();
    const aiFn = makeStubAiFn([]);
    const result = await tierFindings([], queryFn, aiFn, "test-run-6:materiality");

    assert(result.totalEligible === 0, `totalEligible = 0`);
    assert(result.tieredCount === 0, `tieredCount = 0`);
    assert(result.partial === false, `partial = false for empty input`);
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
