/**
 * Regression test: canonical finding identity on persistence reload
 *
 * Run via: npx tsx server/apis/pipeline/__tests__/canonical-finding-identity.test.ts
 *
 * Verifies that reload mode NEVER generates new UUIDs for persisted findings
 * with missing or invalid finding_id, and that validation functions correctly
 * report such cases as failures.
 *
 * REGRESSION: On parent commit 45498d0, reload mode would assign randomUUID()
 * to findings with missing/invalid finding_id and include them in the usable
 * findings collection. This silently corrupted provenance chains.
 *
 * After fix: reload mode excludes identity-lost findings from parseResult.findings
 * and reports them via parseResult.invalid.
 */
import {
  parseCanonicalFindings,
  validateFindingsFromDB,
  deserializeFindings,
  serializeFindings,
  type CanonicalFinding,
} from "../canonical-finding.js";

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

function assertThrows(fn: () => void, substringMatch: string, msg: string): void {
  try {
    fn();
    failed++;
    console.error(`  ❌ FAIL: ${msg} — expected throw but none occurred`);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (message.includes(substringMatch)) {
      passed++;
      console.log(`  ✅ ${msg}`);
    } else {
      failed++;
      console.error(`  ❌ FAIL: ${msg} — threw but message didn't match. Got: "${message}"`);
    }
  }
}

async function assertRejects(fn: () => Promise<any>, substringMatch: string, msg: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`  ❌ FAIL: ${msg} — expected rejection but resolved`);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (message.includes(substringMatch)) {
      passed++;
      console.log(`  ✅ ${msg}`);
    } else {
      failed++;
      console.error(`  ❌ FAIL: ${msg} — rejected but message didn't match. Got: "${message}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(s: string): boolean {
  return UUID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ANOTHER_UUID = "11111111-2222-3333-4444-555555555555";

const FINDING_WITH_VALID_ID = {
  finding_id: VALID_UUID,
  severity: "critical",
  title: "Revenue growth overstatement",
  detail: "CIM claims 25% but audited shows 18.2%",
  full_analysis: "Full analysis of revenue growth discrepancy.",
  source_docs: ["CIM.pdf", "Audited_Financials.pdf"],
};

const FINDING_WITHOUT_ID = {
  severity: "warning",
  title: "Customer concentration risk",
  detail: "Top 3 customers represent 72% of revenue",
  full_analysis: "Analysis of customer concentration.",
  source_docs: ["Revenue_Breakdown.xlsx"],
};

const FINDING_WITH_INVALID_ID = {
  finding_id: "not-a-uuid-at-all",
  severity: "critical",
  title: "EBITDA margin discrepancy",
  detail: "32% claimed vs 27% QoE-adjusted",
  full_analysis: "Detailed analysis of EBITDA margin gap.",
  source_docs: ["QoE_Report.pdf"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== canonical-finding identity regression tests ===\n");

  // -------------------------------------------------------------------------
  // Test 1: Fresh mode assigns a UUID to a finding without one
  // -------------------------------------------------------------------------
  console.log("Test 1: Fresh mode assigns an ID to a finding without one");
  {
    const result = parseCanonicalFindings([FINDING_WITHOUT_ID], {
      mode: "fresh",
      source: "test-fresh",
    });

    assertEq(result.findings.length, 1, "one finding in result");
    assert(isValidUUID(result.findings[0].finding_id), "finding_id is a valid UUID");
    assert(result.findings[0].finding_id !== VALID_UUID, "assigned ID differs from test constant");
    assertEq(result.malformed_count, 0, "no malformed items");
  }

  // -------------------------------------------------------------------------
  // Test 2: Reload mode preserves a valid existing ID
  // -------------------------------------------------------------------------
  console.log("\nTest 2: Reload mode preserves a valid existing ID");
  {
    const result = parseCanonicalFindings([FINDING_WITH_VALID_ID], {
      mode: "reload",
      source: "test-reload-valid",
    });

    assertEq(result.findings.length, 1, "one finding in result");
    assertEq(result.findings[0].finding_id, VALID_UUID, "finding_id preserved unchanged");
    assertEq(result.invalid.length, 0, "no validation issues");
    assertEq(result.malformed_count, 0, "no malformed items");
  }

  // -------------------------------------------------------------------------
  // Test 3: Reload mode does NOT generate a new ID for a missing ID
  //
  // REGRESSION: On parent 45498d0, this would produce 1 finding with a
  // newly generated UUID — violating stable identity for persisted data.
  // -------------------------------------------------------------------------
  console.log("\nTest 3: Reload mode does NOT generate new ID for missing finding_id");
  {
    const result = parseCanonicalFindings([FINDING_WITHOUT_ID], {
      mode: "reload",
      source: "test-reload-missing",
    });

    assertEq(result.findings.length, 0, "finding EXCLUDED from usable findings (not 1)");
    assertEq(result.invalid.length, 1, "one identity failure reported in invalid");
    assert(
      result.invalid[0].issues[0].includes("identity lost"),
      "issue message mentions identity lost"
    );
    // Verify no valid UUID was generated for it
    assert(
      !isValidUUID(result.invalid[0].finding.finding_id),
      "placeholder ID is NOT a valid UUID (no new UUID generated)"
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: Reload mode does NOT generate a new ID for an invalid ID
  //
  // REGRESSION: On parent 45498d0, this would produce 1 finding with a
  // newly generated UUID instead of rejecting it.
  // -------------------------------------------------------------------------
  console.log("\nTest 4: Reload mode does NOT generate new ID for invalid finding_id");
  {
    const result = parseCanonicalFindings([FINDING_WITH_INVALID_ID], {
      mode: "reload",
      source: "test-reload-invalid",
    });

    assertEq(result.findings.length, 0, "finding EXCLUDED from usable findings (not 1)");
    assertEq(result.invalid.length, 1, "one identity failure reported in invalid");
    assert(
      result.invalid[0].issues[0].includes("not-a-uuid-at-all"),
      "issue message contains the invalid ID value"
    );
    assert(
      result.invalid[0].issues[0].includes("identity lost"),
      "issue message mentions identity lost"
    );
    assert(
      !isValidUUID(result.invalid[0].finding.finding_id),
      "placeholder ID is NOT a valid UUID"
    );
  }

  // -------------------------------------------------------------------------
  // Test 5: deserializeFindings with rejectOnError=true rejects missing ID
  // -------------------------------------------------------------------------
  console.log("\nTest 5: deserializeFindings({ rejectOnError: true }) rejects missing ID");
  {
    const json = JSON.stringify([FINDING_WITHOUT_ID]);

    // Should throw
    let threw = false;
    try {
      deserializeFindings(json, "test-deser-missing", { rejectOnError: true });
    } catch (e: any) {
      threw = true;
      assert(
        e.message.includes("Validation failed"),
        "error message includes 'Validation failed'"
      );
    }
    assert(threw, "deserializeFindings threw for missing finding_id");
  }

  // -------------------------------------------------------------------------
  // Test 5b: deserializeFindings with rejectOnError=true rejects invalid ID
  // -------------------------------------------------------------------------
  console.log("\nTest 5b: deserializeFindings({ rejectOnError: true }) rejects invalid ID");
  {
    const json = JSON.stringify([FINDING_WITH_INVALID_ID]);

    let threw = false;
    try {
      deserializeFindings(json, "test-deser-invalid", { rejectOnError: true });
    } catch (e: any) {
      threw = true;
      assert(
        e.message.includes("Validation failed"),
        "error message includes 'Validation failed'"
      );
    }
    assert(threw, "deserializeFindings threw for invalid finding_id");
  }

  // -------------------------------------------------------------------------
  // Test 6: validateFindingsFromDB returns ok:false for missing ID
  //
  // REGRESSION: On parent 45498d0, validateFindingsFromDB ignored
  // parseResult.invalid and returned ok:true with a UUID-replaced finding.
  // -------------------------------------------------------------------------
  console.log("\nTest 6: validateFindingsFromDB returns ok:false for missing finding_id");
  {
    const result = validateFindingsFromDB([FINDING_WITHOUT_ID]);
    assertEq(result.ok, false, "ok is false");
    assert(
      !result.ok && result.errors.length > 0,
      "errors array is non-empty"
    );
    assert(
      !result.ok && result.errors[0].includes("identity lost"),
      "error mentions identity lost"
    );
  }

  // -------------------------------------------------------------------------
  // Test 6b: validateFindingsFromDB returns ok:false for invalid ID
  // -------------------------------------------------------------------------
  console.log("\nTest 6b: validateFindingsFromDB returns ok:false for invalid finding_id");
  {
    const result = validateFindingsFromDB([FINDING_WITH_INVALID_ID]);
    assertEq(result.ok, false, "ok is false");
    assert(
      !result.ok && result.errors[0].includes("identity lost"),
      "error mentions identity lost"
    );
  }

  // -------------------------------------------------------------------------
  // Test 7: Valid persisted finding round-trips unchanged
  // -------------------------------------------------------------------------
  console.log("\nTest 7: Valid persisted finding round-trips through serialize→deserialize unchanged");
  {
    // Parse fresh to get a canonical finding
    const freshResult = parseCanonicalFindings([FINDING_WITH_VALID_ID], {
      mode: "fresh",
      source: "test-roundtrip",
    });
    assertEq(freshResult.findings.length, 1, "fresh parse produces 1 finding");
    const canonical = freshResult.findings[0];

    // Serialize
    const { json } = serializeFindings([canonical]);

    // Deserialize (reload mode via deserializeFindings)
    const { findings, issues } = deserializeFindings(json, "test-roundtrip-reload");
    assertEq(findings.length, 1, "roundtrip produces 1 finding");
    assertEq(findings[0].finding_id, VALID_UUID, "finding_id preserved through roundtrip");
    assertEq(findings[0].title, "Revenue growth overstatement", "title preserved");
    assertEq(findings[0].severity, "critical", "severity preserved");
    assertEq(findings[0].detail, "CIM claims 25% but audited shows 18.2%", "detail preserved");
    assertEq(issues.length, 0, "no issues on roundtrip");
  }

  // -------------------------------------------------------------------------
  // Test 8: Mixed findings — valid one passes, identity-lost one excluded
  //
  // Confirms findings count is exactly right when batch contains both
  // -------------------------------------------------------------------------
  console.log("\nTest 8: Mixed batch — valid finding passes, identity-lost excluded");
  {
    const result = parseCanonicalFindings(
      [FINDING_WITH_VALID_ID, FINDING_WITHOUT_ID, FINDING_WITH_INVALID_ID],
      { mode: "reload", source: "test-mixed" }
    );

    assertEq(result.findings.length, 1, "only 1 finding in usable collection");
    assertEq(result.findings[0].finding_id, VALID_UUID, "the valid finding is the one retained");
    assertEq(result.invalid.length, 2, "2 identity failures in invalid collection");
    assertEq(result.malformed_count, 0, "no malformed items");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) {
    console.log("PARENT COMMIT BEHAVIOR (45498d0):");
    console.log("  - Reload mode: missing/invalid finding_id → randomUUID() assigned, included in findings");
    console.log("  - validateFindingsFromDB: ignored invalid array → returned ok:true");
    console.log("");
    console.log("FIXED BEHAVIOR:");
    console.log("  - Reload mode: missing/invalid finding_id → excluded from findings, reported as identity failure");
    console.log("  - validateFindingsFromDB: returns ok:false for any validation issue\n");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
