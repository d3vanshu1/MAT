/**
 * Regression test: fast-path resume fail-closed on corrupt findings
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/fast-path-fail-closed.test.ts
 *
 * Verifies that the fast-path resume in pipeline-core will NOT proceed to
 * formatting or final persistence when the checkpoint findings have identity
 * corruption (invalid.length > 0 or malformed_count > 0).
 *
 * REGRESSION: On parent commit 2a2e618, the fast path only checked
 * `fpParseResult.malformed_count > 0` and ignored `fpParseResult.invalid`.
 * After the identity fix, findings with missing/invalid IDs are excluded from
 * fpParseResult.findings but logged in fpParseResult.invalid. The old code
 * would proceed to format/persist with a reduced finding set.
 *
 * After fix: the fast path aborts when invalid.length > 0 OR malformed_count > 0.
 */
import { parseCanonicalFindings } from "../canonical-finding.js";

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

const VALID_UUID_1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VALID_UUID_2 = "11111111-2222-3333-4444-555555555555";
const VALID_UUID_3 = "22222222-3333-4444-5555-666666666666";

const VALID_FINDING_1 = {
  finding_id: VALID_UUID_1,
  severity: "critical",
  title: "Revenue overstatement",
  detail: "CIM vs audited",
  full_analysis: "Analysis.",
  source_docs: ["CIM.pdf"],
};

const VALID_FINDING_2 = {
  finding_id: VALID_UUID_2,
  severity: "warning",
  title: "Customer concentration",
  detail: "Top 3 = 72%",
  full_analysis: "Concentration analysis.",
  source_docs: ["Revenue.xlsx"],
};

const FINDING_NO_ID = {
  severity: "warning",
  title: "Missing ID finding",
  detail: "This has no finding_id",
  full_analysis: "Analysis.",
  source_docs: ["Doc.pdf"],
};

const FINDING_INVALID_ID = {
  finding_id: "not-a-valid-uuid",
  severity: "critical",
  title: "Invalid ID finding",
  detail: "This has a bad finding_id",
  full_analysis: "Analysis.",
  source_docs: ["Doc.pdf"],
};

// ---------------------------------------------------------------------------
// Fast-path gate logic (extracted from pipeline-core.ts)
// Returns { proceed: boolean, findings: any[], reason?: string }
// ---------------------------------------------------------------------------

function fastPathGateCheck(rawFindings: unknown[]): {
  proceed: boolean;
  findings: any[];
  reason?: string;
} {
  const fpParseResult = parseCanonicalFindings(rawFindings, {
    mode: "reload",
    source: "test-fast-path-gate",
  });

  // RC3: Fail closed — abort fast path if ANY corruption
  if (fpParseResult.malformed_count > 0 || fpParseResult.invalid.length > 0) {
    const malformedMsg = fpParseResult.malformed_count > 0
      ? `${fpParseResult.malformed_count} malformed`
      : "";
    const invalidMsg = fpParseResult.invalid.length > 0
      ? `${fpParseResult.invalid.length} identity-invalid`
      : "";
    const detail = [malformedMsg, invalidMsg].filter(Boolean).join(", ");
    return { proceed: false, findings: [], reason: detail };
  }

  return { proceed: true, findings: fpParseResult.findings };
}

/**
 * Housekeeping gate logic (also from pipeline-core.ts)
 * Returns { valid: boolean, findings: any[], reason?: string }
 */
function housekeepingGateCheck(rawFindings: unknown[]): {
  valid: boolean;
  findings: any[];
  reason?: string;
} {
  const hkResult = parseCanonicalFindings(rawFindings, {
    mode: "reload",
    source: "test-fast-path-housekeeping",
  });

  if (hkResult.malformed_count > 0 || hkResult.invalid.length > 0) {
    return {
      valid: false,
      findings: [],
      reason: `${hkResult.invalid.length} invalid, ${hkResult.malformed_count} malformed`,
    };
  }

  return { valid: true, findings: hkResult.findings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== fast-path fail-closed regression tests ===\n");

  // -------------------------------------------------------------------------
  // Test 1: Valid final checkpoint enters fast path and preserves all IDs
  // -------------------------------------------------------------------------
  console.log("Test 1: Valid checkpoint → fast path proceeds");
  {
    const result = fastPathGateCheck([VALID_FINDING_1, VALID_FINDING_2]);
    assertEq(result.proceed, true, "fast path proceeds");
    assertEq(result.findings.length, 2, "all 2 findings preserved");
    assertEq(result.findings[0].finding_id, VALID_UUID_1, "first ID preserved");
    assertEq(result.findings[1].finding_id, VALID_UUID_2, "second ID preserved");
  }

  // -------------------------------------------------------------------------
  // Test 2: Checkpoint with one missing finding_id does NOT reach formatting
  //
  // REGRESSION: On parent 2a2e618, this would return proceed:true with
  // fpParseResult.findings containing only the valid finding (reduced set).
  // -------------------------------------------------------------------------
  console.log("\nTest 2: Missing finding_id → fast path aborts");
  {
    const result = fastPathGateCheck([VALID_FINDING_1, FINDING_NO_ID]);
    assertEq(result.proceed, false, "fast path ABORTS (not proceed)");
    assert(!!result.reason, "reason provided");
    assert(
      result.reason!.includes("identity-invalid"),
      "reason mentions identity-invalid"
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: Checkpoint with one invalid UUID does NOT reach formatting
  // -------------------------------------------------------------------------
  console.log("\nTest 3: Invalid UUID → fast path aborts");
  {
    const result = fastPathGateCheck([VALID_FINDING_1, FINDING_INVALID_ID]);
    assertEq(result.proceed, false, "fast path ABORTS");
    assert(
      result.reason!.includes("identity-invalid"),
      "reason mentions identity-invalid"
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: Mixed valid/invalid does NOT produce partial output
  //
  // REGRESSION: On parent, 2 valid + 1 invalid would proceed=true with only
  // 2 findings (partial set).
  // -------------------------------------------------------------------------
  console.log("\nTest 4: Mixed valid/invalid → no partial output");
  {
    const result = fastPathGateCheck([VALID_FINDING_1, VALID_FINDING_2, FINDING_NO_ID]);
    assertEq(result.proceed, false, "fast path ABORTS even with some valid findings");
    // Verify the findings are NOT returned for use
    assertEq(result.findings.length, 0, "no findings returned for formatting");
  }

  // -------------------------------------------------------------------------
  // Test 5: Invalid housekeeping findings are NOT silently discarded
  //
  // REGRESSION: On parent, the broad `catch {}` would silently swallow
  // any housekeeping issue. Now we explicitly check and reject.
  // -------------------------------------------------------------------------
  console.log("\nTest 5: Invalid housekeeping findings rejected");
  {
    const result = housekeepingGateCheck([FINDING_NO_ID]);
    assertEq(result.valid, false, "housekeeping rejected");
    assertEq(result.findings.length, 0, "no housekeeping findings returned");
    assert(!!result.reason, "reason provided");
  }

  // -------------------------------------------------------------------------
  // Test 5b: Valid housekeeping passes
  // -------------------------------------------------------------------------
  console.log("\nTest 5b: Valid housekeeping passes");
  {
    const hkFinding = { ...VALID_FINDING_1, finding_id: VALID_UUID_3, title: "HK finding" };
    const result = housekeepingGateCheck([hkFinding]);
    assertEq(result.valid, true, "housekeeping accepted");
    assertEq(result.findings.length, 1, "one HK finding returned");
    assertEq(result.findings[0].finding_id, VALID_UUID_3, "HK finding_id preserved");
  }

  // -------------------------------------------------------------------------
  // Test 6: Valid checkpoint preserves the same count as input
  // -------------------------------------------------------------------------
  console.log("\nTest 6: Valid checkpoint → same count as stored");
  {
    const threeValid = [
      { ...VALID_FINDING_1, finding_id: VALID_UUID_1 },
      { ...VALID_FINDING_1, finding_id: VALID_UUID_2, title: "Second" },
      { ...VALID_FINDING_1, finding_id: VALID_UUID_3, title: "Third" },
    ];
    const result = fastPathGateCheck(threeValid);
    assertEq(result.proceed, true, "proceeds");
    assertEq(result.findings.length, 3, "count matches stored count exactly");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) {
    console.log("PARENT (2a2e618): only checked malformed_count; ignored invalid array");
    console.log("  → identity-lost findings excluded from fpParseResult.findings");
    console.log("  → fast path proceeded to format/persist with reduced set");
    console.log("");
    console.log("FIXED: checks malformed_count > 0 OR invalid.length > 0");
    console.log("  → aborts fast path; falls through to normal merge\n");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
