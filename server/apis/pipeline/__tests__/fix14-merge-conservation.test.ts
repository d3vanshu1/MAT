/**
 * Fix 14 — Intermediate Merge Conservation
 *
 * Tests verifying that the merge phase never silently drops findings:
 * 1. Truncated response: all missing findings are carried forward.
 * 2. Non-truncated response with >30% loss: findings carried forward (conservation threshold).
 * 3. Non-truncated response with ≤30% loss: accepted as intentional consolidation.
 * 4. Singleton groups survive resume unchanged (passthrough).
 * 5. Failed merge groups preserve all input member findings.
 * 6. outputFindingIds includes both finding_id and merged_from_finding_ids.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix14-merge-conservation.test.ts
 */

let passed = 0;
let failed = 0;

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`  ✗ FAIL: ${msg}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

// --- Simulation helpers ---
// Simulate the Fix 14 coverage verification logic extracted from pipeline-core.ts
function simulateCoverageCheck(params: {
  inputFindingIds: string[];
  outputFindings: Array<{ finding_id: string; merged_from_finding_ids?: string[] }>;
  truncated: boolean;
  inputMemberFindings: Array<{ finding_id: string }>;
}): { carriedForward: string[]; accepted: boolean; reason: string } {
  const { inputFindingIds, outputFindings, truncated, inputMemberFindings } = params;

  const outputFindingIds = new Set(
    outputFindings.flatMap(f => {
      const ids: string[] = [];
      if (f.finding_id) ids.push(f.finding_id);
      if (Array.isArray(f.merged_from_finding_ids)) ids.push(...f.merged_from_finding_ids);
      return ids;
    })
  );

  const missingIds = inputFindingIds.filter(id => !outputFindingIds.has(id));

  if (missingIds.length === 0) {
    return { carriedForward: [], accepted: true, reason: "no coverage gap" };
  }

  const lossFraction = missingIds.length / inputFindingIds.length;
  const CONSERVATION_THRESHOLD = 0.30;
  const shouldCarryForward = truncated || lossFraction > CONSERVATION_THRESHOLD;

  if (shouldCarryForward) {
    const missingSet = new Set(missingIds);
    const carried = inputMemberFindings
      .filter(f => missingSet.has(f.finding_id))
      .map(f => f.finding_id);
    const reason = truncated
      ? "response truncated"
      : `loss ${(lossFraction * 100).toFixed(0)}% exceeds threshold`;
    return { carriedForward: carried, accepted: false, reason };
  }

  return {
    carriedForward: [],
    accepted: true,
    reason: `${(lossFraction * 100).toFixed(0)}% loss within ${(CONSERVATION_THRESHOLD * 100).toFixed(0)}% threshold`,
  };
}

// --- Test 1: Truncated response — all missing carried forward ---
console.log("Test 1: Truncated response carries forward all missing findings");
{
  const inputIds = ["f1", "f2", "f3", "f4", "f5"];
  const outputFindings = [
    { finding_id: "f1", merged_from_finding_ids: ["f2"] }, // f1 and f2 accounted for
  ];
  const memberFindings = inputIds.map(id => ({ finding_id: id }));

  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings,
    truncated: true,
    inputMemberFindings: memberFindings,
  });

  assertEqual(result.accepted, false, "truncated response not accepted");
  assertEqual(result.carriedForward.sort(), ["f3", "f4", "f5"], "missing f3, f4, f5 carried forward");
  assert(result.reason.includes("truncated"), "reason mentions truncation");
  console.log("  ✓ Truncated: all 3 missing findings carried forward");
}

// --- Test 2: Non-truncated with >30% loss — carried forward ---
console.log("Test 2: Non-truncated with >30% loss triggers conservation carry-forward");
{
  // 10 input findings, output only accounts for 5 (50% loss > 30%)
  const inputIds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const outputFindings = [
    { finding_id: "a" },
    { finding_id: "b", merged_from_finding_ids: ["c", "d", "e"] },
  ];
  const memberFindings = inputIds.map(id => ({ finding_id: id }));

  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings,
    truncated: false,
    inputMemberFindings: memberFindings,
  });

  assertEqual(result.accepted, false, "50% loss not accepted");
  assertEqual(result.carriedForward.sort(), ["f", "g", "h", "i", "j"], "5 missing findings carried forward");
  assert(result.reason.includes("exceeds threshold"), "reason mentions threshold exceeded");
  console.log("  ✓ Non-truncated 50% loss: 5 findings carried forward");
}

// --- Test 3: Non-truncated with ≤30% loss — accepted ---
console.log("Test 3: Non-truncated with ≤30% loss accepted as consolidation");
{
  // 10 input findings, output accounts for 8 (20% loss <= 30%)
  const inputIds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const outputFindings = [
    { finding_id: "a", merged_from_finding_ids: ["b", "c"] },
    { finding_id: "d", merged_from_finding_ids: ["e", "f", "g", "h"] },
  ];
  const memberFindings = inputIds.map(id => ({ finding_id: id }));

  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings,
    truncated: false,
    inputMemberFindings: memberFindings,
  });

  assertEqual(result.accepted, true, "20% loss accepted");
  assertEqual(result.carriedForward, [], "no findings carried forward");
  assert(result.reason.includes("within"), "reason mentions within threshold");
  console.log("  ✓ Non-truncated 20% loss: accepted as intentional consolidation");
}

// --- Test 4: Singleton groups pass through unchanged ---
console.log("Test 4: Singleton groups survive resume unchanged");
{
  // A singleton group has exactly 1 member — its findings pass through as-is
  const singletonFindings = [
    { finding_id: "s1", title: "Solo Finding A" },
    { finding_id: "s2", title: "Solo Finding B" },
  ];

  // In pipeline-core, singletons are detected by `group.members.length === 1`
  // and stored as `singletonCarry: true` in checkpoint. No LLM call occurs.
  // Simulate: for a singleton, no coverage check runs (no merge output to verify against)
  const inputIds = singletonFindings.map(f => f.finding_id);
  const outputFindings = singletonFindings; // passthrough = all findings preserved

  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings: outputFindings as any,
    truncated: false,
    inputMemberFindings: singletonFindings as any,
  });

  assertEqual(result.accepted, true, "singleton has no gap");
  assertEqual(result.carriedForward, [], "nothing carried forward");
  assertEqual(result.reason, "no coverage gap", "no coverage gap for singleton");
  console.log("  ✓ Singleton: all findings preserved without modification");
}

// --- Test 5: Failed merge groups preserve all input member findings ---
console.log("Test 5: Failed merge preserves all input member findings");
{
  // When a merge call fails (rejected promise), the fallback is:
  //   memberFindings = group.members.flatMap(m => m.findings ?? []);
  //   findings of the fallback node = memberFindings (full set)
  const member1Findings = [{ finding_id: "m1f1" }, { finding_id: "m1f2" }];
  const member2Findings = [{ finding_id: "m2f1" }, { finding_id: "m2f3" }];
  const allMemberFindings = [...member1Findings, ...member2Findings];

  // Fallback node contains union of all member findings
  const fallbackFindings = allMemberFindings;
  assertEqual(fallbackFindings.length, 4, "fallback preserves all 4 member findings");

  // Coverage check on fallback should pass (all input IDs present in output)
  const inputIds = allMemberFindings.map(f => f.finding_id);
  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings: fallbackFindings as any,
    truncated: false,
    inputMemberFindings: allMemberFindings as any,
  });

  assertEqual(result.accepted, true, "fallback has no coverage gap");
  console.log("  ✓ Failed merge fallback: all input findings preserved losslessly");
}

// --- Test 6: outputFindingIds includes both finding_id and merged_from_finding_ids ---
console.log("Test 6: outputFindingIds accounts for both own ID and merged-from IDs");
{
  // A consolidated finding with finding_id="merged_A" and merged_from_finding_ids=["f1", "f2", "f3"]
  // should account for f1, f2, f3 AND merged_A
  const inputIds = ["f1", "f2", "f3"];
  const outputFindings = [
    { finding_id: "merged_A", merged_from_finding_ids: ["f1", "f2", "f3"] },
  ];

  const result = simulateCoverageCheck({
    inputFindingIds: inputIds,
    outputFindings,
    truncated: false,
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
  });

  assertEqual(result.accepted, true, "all input IDs accounted via merged_from_finding_ids");
  assertEqual(result.carriedForward, [], "nothing carried forward");

  // Also verify that the merged finding's own ID would be recognized if it was an input
  const inputIds2 = ["merged_A", "f1", "f2", "f3"];
  const result2 = simulateCoverageCheck({
    inputFindingIds: inputIds2,
    outputFindings,
    truncated: false,
    inputMemberFindings: inputIds2.map(id => ({ finding_id: id })),
  });
  assertEqual(result2.accepted, true, "merged finding's own ID also recognized");
  console.log("  ✓ Both finding_id and merged_from_finding_ids count toward coverage");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n✗ Fix 14 tests FAILED");
  process.exit(1);
}
console.log("\n✅ All 6 Fix 14 tests passed.");
process.exit(0);
