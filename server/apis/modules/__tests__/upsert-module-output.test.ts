/**
 * Regression test: upsert-module-output deduplication
 *
 * Run via: npx tsx server/apis/modules/__tests__/upsert-module-output.test.ts
 *
 * Verifies that findings are persisted exactly ONCE, even when the canonical
 * parser flags them with validation issues (which adds them to both
 * parseResult.findings AND parseResult.invalid).
 *
 * REGRESSION: On parent commit 3b9e595c, validatedFindings was built as:
 *   [...parseResult.findings, ...parseResult.invalid.map(inv => inv.finding)]
 * This caused findings with diagnostics to appear twice in the persisted array.
 *
 * After fix: validatedFindings = parseResult.findings (no concatenation).
 */
import { upsertModuleOutput } from "../upsert-module-output.js";

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
// Mock DB — captures persisted findings for assertion
// ---------------------------------------------------------------------------

interface CapturedWrite {
  sql: string;
  params: any[];
  findingsJson: string;
  findingsCount: number;
}

function createMockDb(existingOutputId?: string): {
  db: { query: (...args: any[]) => Promise<any[]>; execute: (...args: any[]) => Promise<any> };
  writes: CapturedWrite[];
} {
  const writes: CapturedWrite[] = [];

  const db = {
    query: async (...args: any[]): Promise<any[]> => {
      const sql: string = args[0];
      const params: any[] = args[2] ?? [];

      // "check existing" query
      if (sql.includes("SELECT id AS output_id FROM module_outputs")) {
        return existingOutputId ? [{ output_id: existingOutputId }] : [];
      }

      // INSERT ... RETURNING
      if (sql.includes("INSERT INTO module_outputs")) {
        const findingsJson = params[2] as string;
        const parsed = JSON.parse(findingsJson);
        writes.push({
          sql,
          params,
          findingsJson,
          findingsCount: parsed.length,
        });
        return [{ output_id: "new-output-id-001" }];
      }

      return [];
    },
    execute: async (...args: any[]): Promise<any> => {
      const sql: string = args[0];
      const params: any[] = args[1] ?? [];

      // UPDATE module_outputs
      if (sql.includes("UPDATE module_outputs")) {
        const findingsJson = params[2] as string;
        const parsed = JSON.parse(findingsJson);
        writes.push({
          sql,
          params,
          findingsJson,
          findingsCount: parsed.length,
        });
      }
      // Bump deal updated_at — no-op
    },
  };

  return { db, writes };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A fully valid finding — no issues expected */
const VALID_FINDING = {
  finding_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  severity: "critical",
  title: "Revenue growth overstatement",
  detail: "CIM claims 25% but audited shows 18.2%",
  full_analysis: "Full analysis of revenue growth discrepancy.",
  source_docs: ["CIM.pdf", "Audited_Financials.pdf"],
};

/**
 * A finding that triggers itemIssues via the numeric_unverified severity cap.
 * severity="critical" + numeric_unverified=true → severity capped to "info"
 * → itemIssues populated → finding lands in BOTH findings[] and invalid[].
 *
 * This is the exact scenario that caused the duplication bug.
 */
const FINDING_WITH_SEVERITY_CAP = {
  finding_id: "11111111-2222-3333-4444-555555555555",
  severity: "critical",
  title: "EBITDA margin discrepancy",
  detail: "32% claimed vs 27% QoE-adjusted",
  full_analysis: "Detailed analysis of EBITDA margin gap.",
  source_docs: ["QoE_Report.pdf"],
  numeric_unverified: true, // ← triggers severity cap → itemIssues
};

/**
 * A finding that triggers itemIssues via missing source_docs.
 * source_docs is coerced to [] and an issue is logged.
 */
const FINDING_WITH_MISSING_SOURCE_DOCS = {
  finding_id: "22222222-3333-4444-5555-666666666666",
  severity: "warning",
  title: "Customer concentration risk",
  detail: "Top 3 customers represent 72% of revenue",
  full_analysis: "Analysis of customer concentration.",
  source_docs: null, // ← triggers "source_docs missing" issue
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== upsert-module-output deduplication regression tests ===\n");

  // -------------------------------------------------------------------------
  // Test 1: Fully valid finding is persisted exactly once
  // -------------------------------------------------------------------------
  console.log("Test 1: Fully valid finding persisted once");
  {
    const { db, writes } = createMockDb();
    const result = await upsertModuleOutput(db, {
      runId: "run-001",
      dealId: "deal-001",
      executiveHeader: "Test header",
      findings: [VALID_FINDING],
      fullReport: "Test report",
    });

    assertEq(writes.length, 1, "exactly one DB write occurred");
    assertEq(writes[0].findingsCount, 1, "persisted findings count = 1");
    assertEq(result.validationIssues, 0, "zero validation issues");
    assertEq(result.wasUpdate, false, "was an insert, not update");
  }

  // -------------------------------------------------------------------------
  // Test 2: Finding with itemIssues (severity cap) persisted exactly once
  //
  // REGRESSION: On parent commit 3b9e595c this would persist 2 findings
  // because the same finding appears in both parseResult.findings AND
  // parseResult.invalid, and the old code concatenated both.
  // -------------------------------------------------------------------------
  console.log("\nTest 2: Finding with itemIssues (severity cap) persisted once — NOT twice");
  {
    const { db, writes } = createMockDb();
    const result = await upsertModuleOutput(db, {
      runId: "run-002",
      dealId: "deal-001",
      executiveHeader: "Test header",
      findings: [FINDING_WITH_SEVERITY_CAP],
      fullReport: "Test report",
    });

    assertEq(writes.length, 1, "exactly one DB write occurred");
    assertEq(writes[0].findingsCount, 1, "persisted findings count = 1 (not 2)");
    assertEq(result.validationIssues, 1, "one validation issue reported");

    // Verify the finding was coerced (severity capped to "info")
    const persisted = JSON.parse(writes[0].findingsJson);
    assertEq(persisted[0].severity, "info", "severity was capped from critical to info");
    assertEq(persisted[0].finding_id, "11111111-2222-3333-4444-555555555555", "finding_id preserved");
  }

  // -------------------------------------------------------------------------
  // Test 3: Two distinct findings (one valid, one with diagnostics) produce
  // exactly two persisted findings — not three.
  //
  // REGRESSION: On parent 3b9e595c this would persist 3 findings:
  //   findings=[valid, capped] + invalid.map(...)=[capped] = 3 total
  // -------------------------------------------------------------------------
  console.log("\nTest 3: Two findings (one valid, one with issues) → exactly 2 persisted");
  {
    const { db, writes } = createMockDb();
    const result = await upsertModuleOutput(db, {
      runId: "run-003",
      dealId: "deal-001",
      executiveHeader: "Test header",
      findings: [VALID_FINDING, FINDING_WITH_SEVERITY_CAP],
      fullReport: "Test report",
    });

    assertEq(writes.length, 1, "exactly one DB write occurred");
    assertEq(writes[0].findingsCount, 2, "persisted findings count = 2 (not 3)");
    assertEq(result.validationIssues, 1, "one validation issue reported");

    // Verify both findings are distinct
    const persisted = JSON.parse(writes[0].findingsJson);
    const ids = persisted.map((f: any) => f.finding_id);
    assert(
      ids.includes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") &&
      ids.includes("11111111-2222-3333-4444-555555555555"),
      "both finding IDs present and distinct"
    );
    assert(new Set(ids).size === 2, "no duplicate finding_ids in persisted array");
  }

  // -------------------------------------------------------------------------
  // Test 4: Validation warning counts remain correct
  //
  // Three findings: one valid, two with different diagnostic issues.
  // validationIssues should be 2, persisted count should be 3.
  // -------------------------------------------------------------------------
  console.log("\nTest 4: Validation warning counts correct with multiple diagnostic findings");
  {
    const { db, writes } = createMockDb();
    const result = await upsertModuleOutput(db, {
      runId: "run-004",
      dealId: "deal-001",
      executiveHeader: "Test header",
      findings: [VALID_FINDING, FINDING_WITH_SEVERITY_CAP, FINDING_WITH_MISSING_SOURCE_DOCS],
      fullReport: "Test report",
    });

    assertEq(writes[0].findingsCount, 3, "persisted findings count = 3 (not 5)");
    assertEq(result.validationIssues, 2, "two validation issues reported");
  }

  // -------------------------------------------------------------------------
  // Test 5: Update path (existing module_outputs row) also persists each
  // finding exactly once.
  // -------------------------------------------------------------------------
  console.log("\nTest 5: UPDATE path persists each finding once");
  {
    const { db, writes } = createMockDb("existing-output-id-999");
    const result = await upsertModuleOutput(db, {
      runId: "run-005",
      dealId: "deal-001",
      executiveHeader: "Updated header",
      findings: [VALID_FINDING, FINDING_WITH_SEVERITY_CAP],
      fullReport: "Updated report",
    });

    assertEq(writes.length, 1, "exactly one DB write occurred (UPDATE)");
    assertEq(writes[0].findingsCount, 2, "persisted findings count = 2 (not 3)");
    assertEq(result.wasUpdate, true, "was an update, not insert");
    assertEq(result.validationIssues, 1, "one validation issue reported");
    assert(writes[0].sql.includes("UPDATE module_outputs"), "used UPDATE SQL");
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}\n`);

  if (failed > 0) {
    console.log("BEFORE fix (parent 3b9e595c): findings with diagnostics would be persisted TWICE.");
    console.log("AFTER  fix: each finding persisted exactly ONCE regardless of diagnostic status.\n");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
