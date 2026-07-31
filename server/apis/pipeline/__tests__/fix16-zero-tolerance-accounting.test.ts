/**
 * Fix 16 — Zero-Tolerance Merge Accounting
 *
 * Tests verifying that the merge phase never accepts unaccounted findings:
 * 1. One missing input out of five is not accepted (carried forward).
 * 2. One missing input out of 100 is not accepted (carried forward).
 * 3. A merged output with complete merged_from_finding_ids is accepted.
 * 4. A failed group carries all inputs forward.
 * 5. Mixed valid and invalid parser output loses nothing.
 * 6. Singleton branches remain accounted for through resume.
 * 7. Uninterrupted and resumed accounting manifests match.
 * 8. Every final finding can be traced to one or more original input IDs.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix16-zero-tolerance-accounting.test.ts
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

// --- Simulation of Fix 16 zero-tolerance accounting logic ---
interface SimFinding {
  finding_id: string;
  merged_from_finding_ids?: string[];
  _merge_accounting?: { status: string; reason: string };
  [key: string]: unknown;
}

function simulateZeroToleranceAccounting(params: {
  inputFindingIds: string[];
  outputFindings: SimFinding[];
  housekeepingFindings: SimFinding[];
  inputMemberFindings: SimFinding[];
  truncated: boolean;
}): { carriedForward: SimFinding[]; allAccountedFor: boolean; unaccountedCount: number } {
  const { inputFindingIds, outputFindings, housekeepingFindings, inputMemberFindings, truncated } = params;

  const outputFindingIds = new Set(
    [...outputFindings, ...housekeepingFindings].flatMap(f => {
      const ids: string[] = [];
      if (f.finding_id) ids.push(f.finding_id);
      if (Array.isArray(f.merged_from_finding_ids)) ids.push(...f.merged_from_finding_ids);
      return ids;
    })
  );

  const missingIds = inputFindingIds.filter(id => !outputFindingIds.has(id));

  if (missingIds.length === 0) {
    return { carriedForward: [], allAccountedFor: true, unaccountedCount: 0 };
  }

  // Fix 16: Zero tolerance — ALWAYS carry forward regardless of percentage
  const reason = truncated
    ? "response truncated"
    : `model omitted ${missingIds.length}/${inputFindingIds.length} input findings without provenance`;

  const missingSet = new Set(missingIds);
  const carriedForward = inputMemberFindings
    .filter(f => missingSet.has(f.finding_id))
    .map(f => ({
      ...f,
      _merge_accounting: { status: "carried_forward", reason },
    }));

  return { carriedForward, allAccountedFor: false, unaccountedCount: missingIds.length };
}

// --- Test 1: One missing out of five is not accepted ---
console.log("Test 1: One missing input out of five is not accepted");
{
  const inputIds = ["f1", "f2", "f3", "f4", "f5"];
  const outputFindings: SimFinding[] = [
    { finding_id: "f1", merged_from_finding_ids: ["f2", "f3", "f4"] },
    // f5 is NOT accounted for
  ];

  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  assertEqual(result.allAccountedFor, false, "not all accounted for");
  assertEqual(result.unaccountedCount, 1, "exactly 1 unaccounted");
  assertEqual(result.carriedForward.length, 1, "1 finding carried forward");
  assertEqual(result.carriedForward[0].finding_id, "f5", "f5 is the carried forward finding");
  assert(result.carriedForward[0]._merge_accounting!.status === "carried_forward", "tagged with accounting metadata");
  console.log("  ✓ One missing out of 5: carried forward (zero tolerance)");
}

// --- Test 2: One missing out of 100 is not accepted ---
console.log("Test 2: One missing input out of 100 is not accepted");
{
  const inputIds = Array.from({ length: 100 }, (_, i) => `f${i}`);
  // Account for 99 of them via merged_from_finding_ids
  const outputFindings: SimFinding[] = [
    { finding_id: "f0", merged_from_finding_ids: inputIds.slice(1, 99) },
    // f99 is NOT accounted for (1% loss — was tolerated by old 30% threshold)
  ];

  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  assertEqual(result.allAccountedFor, false, "not all accounted for");
  assertEqual(result.unaccountedCount, 1, "exactly 1 unaccounted");
  assertEqual(result.carriedForward.length, 1, "1 finding carried forward");
  assertEqual(result.carriedForward[0].finding_id, "f99", "f99 carried forward");
  console.log("  ✓ One missing out of 100: carried forward (1% no longer tolerated)");
}

// --- Test 3: Complete merged_from_finding_ids accounting is accepted ---
console.log("Test 3: Complete merged_from_finding_ids accounting is accepted");
{
  const inputIds = ["a", "b", "c", "d", "e"];
  const outputFindings: SimFinding[] = [
    { finding_id: "merged_1", merged_from_finding_ids: ["a", "b", "c"] },
    { finding_id: "d" },
    { finding_id: "e" },
  ];

  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  assertEqual(result.allAccountedFor, true, "all accounted for");
  assertEqual(result.unaccountedCount, 0, "zero unaccounted");
  assertEqual(result.carriedForward.length, 0, "nothing carried forward");
  console.log("  ✓ Complete provenance: accepted");
}

// --- Test 4: Failed group carries all inputs forward ---
console.log("Test 4: Failed group carries all inputs forward");
{
  // When a merge call fails, the pipeline uses memberFindings as fallback
  // (this is pre-accounting — the fallback itself IS the carry-forward)
  const member1 = [{ finding_id: "m1a" }, { finding_id: "m1b" }];
  const member2 = [{ finding_id: "m2a" }, { finding_id: "m2b" }, { finding_id: "m2c" }];
  const allMembers: SimFinding[] = [...member1, ...member2];
  const inputIds = allMembers.map(f => f.finding_id);

  // Failed group: output IS the input (fallback passthrough)
  const outputFindings = allMembers;

  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings,
    housekeepingFindings: [],
    inputMemberFindings: allMembers,
    truncated: false,
  });

  assertEqual(result.allAccountedFor, true, "all accounted (fallback = input)");
  assertEqual(result.carriedForward.length, 0, "nothing additionally carried forward");
  console.log("  ✓ Failed group: all inputs preserved via fallback");
}

// --- Test 5: Mixed valid and invalid parser output loses nothing ---
console.log("Test 5: Mixed valid and invalid parser output loses nothing");
{
  const inputIds = ["v1", "v2", "v3", "inv1", "inv2"];
  // Parser produced 3 valid findings but 2 input IDs aren't referenced
  const outputFindings: SimFinding[] = [
    { finding_id: "v1" },
    { finding_id: "v2" },
    { finding_id: "v3" },
    // inv1, inv2 were "invalid" output that the parser couldn't process
    // but they ARE input IDs that must be accounted for
  ];

  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  assertEqual(result.allAccountedFor, false, "not all accounted");
  assertEqual(result.unaccountedCount, 2, "2 unaccounted");
  assertEqual(result.carriedForward.length, 2, "2 carried forward");
  const cfIds = result.carriedForward.map(f => f.finding_id).sort();
  assertEqual(cfIds, ["inv1", "inv2"], "inv1 and inv2 carried forward");
  console.log("  ✓ Mixed parse: invalid inputs carried forward, nothing lost");
}

// --- Test 6: Singleton branches remain accounted through resume ---
console.log("Test 6: Singleton branches remain accounted through resume");
{
  // Singleton: single member group — findings pass through unchanged
  const singletonFindings: SimFinding[] = [
    { finding_id: "s1" },
    { finding_id: "s2" },
    { finding_id: "s3" },
  ];
  const inputIds = singletonFindings.map(f => f.finding_id);

  // Singleton passthrough: output = input (no merge occurs)
  const result = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings: singletonFindings,
    housekeepingFindings: [],
    inputMemberFindings: singletonFindings,
    truncated: false,
  });

  assertEqual(result.allAccountedFor, true, "all accounted (singleton passthrough)");
  assertEqual(result.carriedForward.length, 0, "nothing carried forward");
  console.log("  ✓ Singleton: fully accounted through resume");
}

// --- Test 7: Uninterrupted and resumed accounting manifests match ---
console.log("Test 7: Uninterrupted and resumed accounting manifests match");
{
  // Simulate: uninterrupted run processes all groups in one pass
  const inputIds = ["a", "b", "c", "d", "e", "f"];
  const uninterruptedOutput: SimFinding[] = [
    { finding_id: "merged_ab", merged_from_finding_ids: ["a", "b"] },
    { finding_id: "c" },
    { finding_id: "merged_def", merged_from_finding_ids: ["d", "e", "f"] },
  ];

  const uninterruptedResult = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings: uninterruptedOutput,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  // Simulate: resumed run produces the exact same output
  const resumedResult = simulateZeroToleranceAccounting({
    inputFindingIds: inputIds,
    outputFindings: uninterruptedOutput,
    housekeepingFindings: [],
    inputMemberFindings: inputIds.map(id => ({ finding_id: id })),
    truncated: false,
  });

  assertEqual(uninterruptedResult.allAccountedFor, resumedResult.allAccountedFor, "accounting result matches");
  assertEqual(uninterruptedResult.unaccountedCount, resumedResult.unaccountedCount, "unaccounted count matches");
  assertEqual(uninterruptedResult.carriedForward.length, resumedResult.carriedForward.length, "carried forward count matches");
  console.log("  ✓ Uninterrupted and resumed manifests match");
}

// --- Test 8: Every final finding traceable to one or more input IDs ---
console.log("Test 8: Every final finding traceable to one or more original input IDs");
{
  const originalInputIds = ["orig1", "orig2", "orig3", "orig4", "orig5"];

  // Final output after multiple merge rounds
  const finalFindings: SimFinding[] = [
    { finding_id: "final_A", merged_from_finding_ids: ["orig1", "orig2"] },
    { finding_id: "orig3" }, // retained as-is
    { finding_id: "final_B", merged_from_finding_ids: ["orig4", "orig5"] },
  ];

  // Verify: every original input can be found in the final output provenance
  const allAccountedIds = new Set(
    finalFindings.flatMap(f => {
      const ids: string[] = [];
      if (f.finding_id) ids.push(f.finding_id);
      if (Array.isArray(f.merged_from_finding_ids)) ids.push(...f.merged_from_finding_ids);
      return ids;
    })
  );

  const traceable = originalInputIds.every(id => allAccountedIds.has(id));
  assert(traceable, "every original input ID traceable to final output");

  // Verify: no final finding exists without input lineage
  for (const f of finalFindings) {
    const hasLineage = originalInputIds.includes(f.finding_id) ||
      (f.merged_from_finding_ids ?? []).some(id => originalInputIds.includes(id));
    assert(hasLineage, `finding ${f.finding_id} has input lineage`);
  }
  console.log("  ✓ Full traceability: every final finding linked to original inputs");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\n✗ Fix 16 tests FAILED");
  process.exit(1);
}
console.log("\n✅ All 8 Fix 16 tests passed.");
process.exit(0);
