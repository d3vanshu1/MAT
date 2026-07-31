/**
 * Regression test: Partial (truncated) merge checkpoint livelock
 *
 * Scenario: Round 2 merge groups at higher tree levels produce responses that
 * always hit max_tokens (input is too large). RC12 validation rejects the
 * 'partial' checkpoint on each resume → infinite retry loop.
 *
 * The fix: After MAX_PARTIAL_RETRIES (2) truncation attempts, the checkpoint
 * is accepted as-is. Findings are preserved via Fix 16 zero-tolerance accounting;
 * only the narrative text may be incomplete.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/partial-checkpoint-livelock.test.ts
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) { console.error(`FAIL [${label}]: expected ${b}, got ${a}`); process.exit(1); }
}

// ─── Constants matching production ───────────────────────────────────────────

const MAX_PARTIAL_RETRIES = 2;
const MERGE_GROUP_SIZE = 4;

// ─── Types ───────────────────────────────────────────────────────────────────

interface MergeNode {
  text: string;
  executiveHeader: string;
  findings: Array<{ finding_id: string; title: string; severity: string }>;
  truncated?: boolean;
}

interface MergeCheckpoint {
  tree_level: number;
  node_index: number;
  merged_json: any;
  prompt_version: string;
  status: string;
}

// ─── Simulate checkpoint loading logic (mirrors pipeline-core.ts) ────────────

function loadCheckpointsWithPartialAcceptance(
  checkpoints: MergeCheckpoint[],
  currentVersion: string
): {
  checkpointMap: Map<string, MergeNode>;
  truncationCountMap: Map<string, number>;
  rejectedForRetry: string[];
  acceptedPartials: string[];
} {
  const checkpointMap = new Map<string, MergeNode>();
  const truncationCountMap = new Map<string, number>();
  const rejectedForRetry: string[] = [];
  const acceptedPartials: string[] = [];

  for (const cp of checkpoints) {
    const data = cp.merged_json;
    const cpKey = `${cp.tree_level}:${cp.node_index}`;

    if (cp.node_index < 0) continue; // manifest

    const cpStatus = cp.status;

    // Error checkpoints
    if (data.error || cpStatus === "failed_retryable" || cpStatus === "error") {
      continue;
    }

    // Validation: only 'complete' is reusable
    const isComplete = cpStatus === "complete";
    const isTruncated = data.truncated === true;

    if (!isComplete) {
      // Check if this is a partial that should be accepted
      if (cpStatus === "partial" && isTruncated) {
        const truncCount = typeof data.truncation_count === "number" ? data.truncation_count : 1;
        truncationCountMap.set(cpKey, truncCount);

        if (truncCount >= MAX_PARTIAL_RETRIES) {
          // Accept the partial
          acceptedPartials.push(cpKey);
          checkpointMap.set(cpKey, {
            text: data.text ?? "",
            executiveHeader: data.executiveHeader ?? "",
            findings: data.findings ?? [],
            truncated: true,
          });
          continue;
        }
      }

      rejectedForRetry.push(cpKey);
      continue;
    }

    // Complete checkpoint — always accept
    checkpointMap.set(cpKey, {
      text: data.text ?? "",
      executiveHeader: data.executiveHeader ?? "",
      findings: data.findings ?? [],
      truncated: isTruncated,
    });
  }

  return { checkpointMap, truncationCountMap, rejectedForRetry, acceptedPartials };
}

// ─── Simulate checkpoint write after merge ───────────────────────────────────

function simulateMergeCheckpointWrite(
  truncated: boolean,
  priorTruncCount: number
): { status: string; truncation_count?: number } {
  const cpStatus = truncated ? "partial" : "complete";
  const newTruncCount = truncated ? priorTruncCount + 1 : 0;
  return {
    status: cpStatus,
    truncation_count: truncated ? newTruncCount : undefined,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("=== Partial Checkpoint Livelock Regression Tests ===\n");

// Test 1: Fresh partial (no truncation_count) is rejected but defaults to count=1
{
  console.log("Test 1: Fresh partial without truncation_count defaults to 1...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 2,
      node_index: 0,
      merged_json: {
        text: "Some merged text",
        executiveHeader: "Header",
        findings: [{ finding_id: "f1", title: "Test finding", severity: "warning" }],
        truncated: true,
        // No truncation_count — simulates existing partial from before the fix
      },
      prompt_version: "v1.0",
      status: "partial",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  assertEq(result.rejectedForRetry.length, 1, "Fresh partial should be rejected");
  assertEq(result.acceptedPartials.length, 0, "Fresh partial should NOT be accepted");
  assertEq(result.truncationCountMap.get("2:0"), 1, "Default truncation count should be 1");
  console.log("  ✓ PASS\n");
}

// Test 2: Partial with truncation_count=1 (one prior retry) is still rejected
{
  console.log("Test 2: Partial with truncation_count=1 is still rejected (needs one more retry)...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 2,
      node_index: 0,
      merged_json: {
        text: "Merged text",
        executiveHeader: "Header",
        findings: [{ finding_id: "f1", title: "Finding", severity: "info" }],
        truncated: true,
        truncation_count: 1,
      },
      prompt_version: "v1.0",
      status: "partial",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  assertEq(result.rejectedForRetry.length, 1, "Count=1 partial should be rejected");
  assertEq(result.acceptedPartials.length, 0, "Count=1 should NOT be accepted yet");
  console.log("  ✓ PASS\n");
}

// Test 3: Partial with truncation_count=2 (at threshold) IS accepted
{
  console.log("Test 3: Partial with truncation_count=2 (= MAX_PARTIAL_RETRIES) IS accepted...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 2,
      node_index: 0,
      merged_json: {
        text: "Merged but truncated text",
        executiveHeader: "Analysis complete (partial)",
        findings: [
          { finding_id: "f1", title: "Revenue discrepancy", severity: "warning" },
          { finding_id: "f2", title: "EBITDA mismatch", severity: "critical" },
        ],
        truncated: true,
        truncation_count: 2,
      },
      prompt_version: "v1.0",
      status: "partial",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  assertEq(result.rejectedForRetry.length, 0, "Count=2 should NOT be rejected");
  assertEq(result.acceptedPartials.length, 1, "Count=2 should be accepted");
  assert(result.checkpointMap.has("2:0"), "Accepted partial should be in checkpointMap");
  const node = result.checkpointMap.get("2:0")!;
  assertEq(node.findings.length, 2, "Findings should be preserved in accepted partial");
  assertEq(node.truncated, true, "Truncated flag should be preserved");
  console.log("  ✓ PASS\n");
}

// Test 4: Partial with truncation_count > MAX is accepted (3 > 2)
{
  console.log("Test 4: Partial with truncation_count=3 (> MAX) is also accepted...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 2,
      node_index: 1,
      merged_json: {
        text: "Long truncated",
        executiveHeader: "Header",
        findings: [{ finding_id: "f3", title: "Something", severity: "info" }],
        truncated: true,
        truncation_count: 3,
      },
      prompt_version: "v1.0",
      status: "partial",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  assertEq(result.acceptedPartials.length, 1, "Count=3 should be accepted");
  console.log("  ✓ PASS\n");
}

// Test 5: Complete checkpoints are always accepted regardless
{
  console.log("Test 5: Complete checkpoints always accepted...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 1,
      node_index: 0,
      merged_json: {
        text: "Full text",
        executiveHeader: "Complete",
        findings: [{ finding_id: "f4", title: "Good finding", severity: "warning" }],
        truncated: false,
      },
      prompt_version: "v1.0",
      status: "complete",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  assertEq(result.rejectedForRetry.length, 0, "Complete should not be rejected");
  assertEq(result.acceptedPartials.length, 0, "Complete is not a 'partial' acceptance");
  assert(result.checkpointMap.has("1:0"), "Complete should be in checkpointMap");
  console.log("  ✓ PASS\n");
}

// Test 6: Simulate full livelock scenario — 3 invocations breaks the livelock
{
  console.log("Test 6: Full livelock simulation — 3 invocations breaks the cycle...");

  // State: simulates what the DB holds
  let storedCheckpoints: MergeCheckpoint[] = [];

  // Invocation 1: First merge attempt — produces partial (truncated)
  // (No prior checkpoint exists, so group is processed fresh)
  {
    const truncated = true; // AI always truncates at this round
    const write = simulateMergeCheckpointWrite(truncated, 0);
    storedCheckpoints = [{
      tree_level: 2,
      node_index: 0,
      merged_json: {
        text: "Truncated...",
        executiveHeader: "Partial",
        findings: [{ finding_id: "f1", title: "Finding A", severity: "warning" }],
        truncated: true,
        truncation_count: write.truncation_count,
      },
      prompt_version: "v1.0",
      status: write.status,
    }];

    assertEq(write.status, "partial", "Inv1: should write partial");
    assertEq(write.truncation_count, 1, "Inv1: truncation_count=1");
  }

  // Invocation 2: Load checkpoint — truncation_count=1 < MAX(2) → reject → re-merge → truncates again
  {
    const loadResult = loadCheckpointsWithPartialAcceptance(storedCheckpoints, "v1.0");
    assertEq(loadResult.rejectedForRetry.length, 1, "Inv2: count=1 rejected");
    assertEq(loadResult.acceptedPartials.length, 0, "Inv2: not accepted yet");

    // Re-merge happens, truncates again
    const priorCount = loadResult.truncationCountMap.get("2:0") ?? 0;
    const write = simulateMergeCheckpointWrite(true, priorCount);
    storedCheckpoints = [{
      tree_level: 2,
      node_index: 0,
      merged_json: {
        text: "Truncated again...",
        executiveHeader: "Still partial",
        findings: [
          { finding_id: "f1", title: "Finding A", severity: "warning" },
          { finding_id: "f2", title: "Finding B", severity: "info" },
        ],
        truncated: true,
        truncation_count: write.truncation_count,
      },
      prompt_version: "v1.0",
      status: write.status,
    }];

    assertEq(write.status, "partial", "Inv2: should write partial");
    assertEq(write.truncation_count, 2, "Inv2: truncation_count=2");
  }

  // Invocation 3: Load checkpoint — truncation_count=2 >= MAX(2) → ACCEPT!
  {
    const loadResult = loadCheckpointsWithPartialAcceptance(storedCheckpoints, "v1.0");
    assertEq(loadResult.rejectedForRetry.length, 0, "Inv3: should NOT reject");
    assertEq(loadResult.acceptedPartials.length, 1, "Inv3: ACCEPTED!");
    assert(loadResult.checkpointMap.has("2:0"), "Inv3: in checkpointMap");

    const node = loadResult.checkpointMap.get("2:0")!;
    assertEq(node.findings.length, 2, "Inv3: findings preserved");
    assertEq(node.truncated, true, "Inv3: truncated flag preserved");
  }

  console.log("  ✓ PASS — Livelock broken after 3 invocations (1 initial + 1 retry + 1 accept)\n");
}

// Test 7: Mixed checkpoints — some complete, some partial-ready, some still retrying
{
  console.log("Test 7: Mixed checkpoint states in same round...");
  const checkpoints: MergeCheckpoint[] = [
    // Group 0: complete — accepted immediately
    {
      tree_level: 2, node_index: 0,
      merged_json: { text: "Done", executiveHeader: "OK", findings: [{ finding_id: "a", title: "A", severity: "info" }], truncated: false },
      prompt_version: "v1.0", status: "complete",
    },
    // Group 1: partial, truncation_count=2 — should be accepted
    {
      tree_level: 2, node_index: 1,
      merged_json: { text: "Cut off", executiveHeader: "Partial", findings: [{ finding_id: "b", title: "B", severity: "warning" }], truncated: true, truncation_count: 2 },
      prompt_version: "v1.0", status: "partial",
    },
    // Group 2: partial, truncation_count=1 — still needs retry
    {
      tree_level: 2, node_index: 2,
      merged_json: { text: "Cut", executiveHeader: "Partial", findings: [{ finding_id: "c", title: "C", severity: "critical" }], truncated: true, truncation_count: 1 },
      prompt_version: "v1.0", status: "partial",
    },
    // Group 3: error — skipped
    {
      tree_level: 2, node_index: 3,
      merged_json: { error: "timeout", failureCount: 2 },
      prompt_version: "v1.0", status: "error",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  // Group 0: in checkpointMap (complete)
  // Group 1: in checkpointMap (accepted partial)
  // Group 2: rejected for retry
  // Group 3: skipped (error)
  assertEq(result.checkpointMap.size, 2, "2 should be in map (complete + accepted partial)");
  assert(result.checkpointMap.has("2:0"), "Complete group in map");
  assert(result.checkpointMap.has("2:1"), "Accepted partial in map");
  assertEq(result.rejectedForRetry.length, 1, "1 rejected for retry (count=1)");
  assertEq(result.rejectedForRetry[0], "2:2", "Group 2 rejected");
  assertEq(result.acceptedPartials.length, 1, "1 accepted partial");
  assertEq(result.acceptedPartials[0], "2:1", "Group 1 accepted");
  console.log("  ✓ PASS\n");
}

// Test 8: Verify non-truncated partials (if they somehow exist) don't get the fast-path
{
  console.log("Test 8: Non-truncated partial (edge case) still rejected normally...");
  const checkpoints: MergeCheckpoint[] = [
    {
      tree_level: 2, node_index: 0,
      merged_json: {
        text: "Incomplete but not from max_tokens",
        executiveHeader: "Hmm",
        findings: [],
        truncated: false, // Not from max_tokens
        truncation_count: 5,
      },
      prompt_version: "v1.0",
      status: "partial",
    },
  ];

  const result = loadCheckpointsWithPartialAcceptance(checkpoints, "v1.0");
  // The partial-acceptance path requires BOTH cpStatus=partial AND data.truncated=true
  assertEq(result.rejectedForRetry.length, 1, "Non-truncated partial should be rejected");
  assertEq(result.acceptedPartials.length, 0, "Non-truncated partial should NOT be accepted");
  console.log("  ✓ PASS\n");
}

console.log("=== ALL 8 TESTS PASSED ===");
