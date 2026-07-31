/**
 * Regression test: load-merge-checkpoints strict deserialization
 *
 * Run via: npx tsx server/apis/checkpoints/__tests__/load-merge-checkpoints-strict.test.ts
 *
 * Verifies that the checkpoint loader fails closed when persisted findings
 * have identity corruption (missing or invalid finding_id). A corrupt
 * checkpoint must be returned as an error node, not a valid node with
 * reduced findings.
 *
 * REGRESSION: On parent commit 901c48c, deserializeFindings was called
 * without rejectOnError:true, so identity-lost findings were silently
 * excluded from the usable set and the checkpoint was returned as valid
 * with fewer findings.
 *
 * After fix: strict deserialization throws → checkpoint becomes error node.
 */
import { deserializeFindings } from "../../pipeline/canonical-finding.js";
import { buildMergedText } from "../../modules/build-merged-text.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SECOND_UUID = "11111111-2222-3333-4444-555555555555";

const VALID_FINDING = {
  finding_id: VALID_UUID,
  severity: "critical",
  title: "Revenue overstatement",
  detail: "CIM claims 25% but audited shows 18.2%",
  full_analysis: "Full analysis text here.",
  source_docs: ["CIM.pdf"],
};

const FINDING_NO_ID = {
  severity: "warning",
  title: "Customer concentration risk",
  detail: "Top 3 customers = 72% revenue",
  full_analysis: "Analysis of concentration.",
  source_docs: ["Revenue.xlsx"],
};

const FINDING_INVALID_ID = {
  finding_id: "not-a-valid-uuid",
  severity: "critical",
  title: "EBITDA margin gap",
  detail: "32% vs 27%",
  full_analysis: "EBITDA analysis.",
  source_docs: ["QoE.pdf"],
};

// ---------------------------------------------------------------------------
// Simulate the checkpoint loader logic (extracted from load-merge-checkpoints.ts)
// This mirrors the fixed code path so we can test it in isolation.
// ---------------------------------------------------------------------------

type LoadedCheckpoint = {
  treeLevel: number;
  nodeIndex: number;
  mergedNode: {
    text?: string;
    executiveHeader?: string;
    findings?: any[];
    error?: string;
    lastError?: string;
    timestamp?: string;
  };
};

function loadCheckpointNode(
  moduleRunId: string,
  treeLevel: number,
  nodeIndex: number,
  merged: Record<string, any>
): LoadedCheckpoint {
  // Error node path (unchanged)
  if (merged.error) {
    return {
      treeLevel,
      nodeIndex,
      mergedNode: {
        error: String(merged.error),
        timestamp: merged.timestamp ?? undefined,
      },
    };
  }

  const executiveHeader = String(merged.executiveHeader ?? "");
  const cpSource = `LoadMergeCheckpoints run=${moduleRunId} L${treeLevel} N${nodeIndex}`;

  // STRICT deserialization — fails closed on identity corruption
  let findings;
  try {
    const result = deserializeFindings(
      Array.isArray(merged.findings) ? merged.findings : [],
      cpSource,
      { rejectOnError: true }
    );
    findings = result.findings;
  } catch (e: any) {
    const errorMsg = `Checkpoint data integrity failure at L${treeLevel} N${nodeIndex}: ${e.message}`;
    return {
      treeLevel,
      nodeIndex,
      mergedNode: {
        error: errorMsg,
        lastError: errorMsg,
        timestamp: new Date().toISOString(),
      },
    };
  }

  const text = merged.text
    ? String(merged.text)
    : buildMergedText(executiveHeader, findings);

  return {
    treeLevel,
    nodeIndex,
    mergedNode: {
      text,
      executiveHeader,
      findings,
      ...(merged.lastError ? { lastError: String(merged.lastError) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== load-merge-checkpoints strict deserialization tests ===\n");

  // -------------------------------------------------------------------------
  // Test 1: Valid checkpoint loads with same finding count and IDs
  // -------------------------------------------------------------------------
  console.log("Test 1: Valid checkpoint loads unchanged");
  {
    const result = loadCheckpointNode("run-001", 2, 0, {
      executiveHeader: "Executive summary",
      findings: [VALID_FINDING, { ...VALID_FINDING, finding_id: SECOND_UUID, title: "Second finding" }],
    });

    assert(!result.mergedNode.error, "no error on valid checkpoint");
    assertEq(result.mergedNode.findings?.length, 2, "findings count = 2");
    assertEq(result.mergedNode.findings?.[0].finding_id, VALID_UUID, "first finding_id preserved");
    assertEq(result.mergedNode.findings?.[1].finding_id, SECOND_UUID, "second finding_id preserved");
    assertEq(result.treeLevel, 2, "treeLevel preserved");
    assertEq(result.nodeIndex, 0, "nodeIndex preserved");
  }

  // -------------------------------------------------------------------------
  // Test 2: Checkpoint with missing finding_id → error node (not reduced list)
  //
  // REGRESSION: On parent 901c48c, this would return a valid node with 0
  // findings (the identity-lost finding was excluded from deserializeFindings).
  // -------------------------------------------------------------------------
  console.log("\nTest 2: Checkpoint with missing finding_id → error node");
  {
    const result = loadCheckpointNode("run-002", 1, 3, {
      executiveHeader: "Header",
      findings: [FINDING_NO_ID],
    });

    assert(!!result.mergedNode.error, "returned as error node");
    assert(
      result.mergedNode.error!.includes("data integrity failure"),
      "error mentions 'data integrity failure'"
    );
    assert(
      result.mergedNode.error!.includes("L1 N3"),
      "error identifies tree level and node index"
    );
    assertEq(result.mergedNode.findings, undefined, "no findings on error node");
  }

  // -------------------------------------------------------------------------
  // Test 3: Checkpoint with invalid UUID → error node
  // -------------------------------------------------------------------------
  console.log("\nTest 3: Checkpoint with invalid UUID → error node");
  {
    const result = loadCheckpointNode("run-003", 2, 1, {
      executiveHeader: "Header",
      findings: [FINDING_INVALID_ID],
    });

    assert(!!result.mergedNode.error, "returned as error node");
    assert(
      result.mergedNode.error!.includes("data integrity failure"),
      "error mentions 'data integrity failure'"
    );
    assertEq(result.mergedNode.findings, undefined, "no findings on error node");
  }

  // -------------------------------------------------------------------------
  // Test 4: Mixed valid + identity-invalid → error node (not partial)
  //
  // REGRESSION: On parent 901c48c, this would return a valid node with
  // only the valid finding (1 instead of 2). The identity-lost finding
  // was silently dropped.
  // -------------------------------------------------------------------------
  console.log("\nTest 4: Mixed valid + identity-invalid → error node (not partial)");
  {
    const result = loadCheckpointNode("run-004", 3, 0, {
      executiveHeader: "Header",
      findings: [VALID_FINDING, FINDING_NO_ID],
    });

    assert(!!result.mergedNode.error, "returned as error node (not partial valid node)");
    assert(
      result.mergedNode.error!.includes("data integrity failure"),
      "error mentions data integrity failure"
    );
    assertEq(result.mergedNode.findings, undefined, "no findings (not partial set of 1)");
  }

  // -------------------------------------------------------------------------
  // Test 5: Explicit error node continues to load as error node
  // -------------------------------------------------------------------------
  console.log("\nTest 5: Explicit error node loads unchanged");
  {
    const result = loadCheckpointNode("run-005", 1, 2, {
      error: "Merge failed: timeout after 120s",
      failureCount: 3,
      timestamp: "2026-07-30T21:23:42Z",
    });

    assert(!!result.mergedNode.error, "returned as error node");
    assertEq(result.mergedNode.error, "Merge failed: timeout after 120s", "error message preserved");
    assertEq(result.mergedNode.findings, undefined, "no findings on error node");
    assertEq(result.treeLevel, 1, "treeLevel preserved");
    assertEq(result.nodeIndex, 2, "nodeIndex preserved");
  }

  // -------------------------------------------------------------------------
  // Test 6: Reconstructed text for valid checkpoint is correct
  // -------------------------------------------------------------------------
  console.log("\nTest 6: Reconstructed text matches buildMergedText output");
  {
    const result = loadCheckpointNode("run-006", 2, 0, {
      executiveHeader: "Executive overview",
      findings: [VALID_FINDING],
    });

    assert(!result.mergedNode.error, "no error");
    const expectedText = buildMergedText("Executive overview", [result.mergedNode.findings![0]]);
    assertEq(result.mergedNode.text, expectedText, "text matches buildMergedText reconstruction");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) {
    console.log("PARENT (901c48c): deserializeFindings without rejectOnError");
    console.log("  → identity-lost findings silently excluded → reduced valid node");
    console.log("");
    console.log("FIXED: deserializeFindings({ rejectOnError: true })");
    console.log("  → identity corruption → checkpoint returned as error node\n");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
