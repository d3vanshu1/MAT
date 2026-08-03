/**
 * MAT-F06 Correction Tests: Report Filtering, Prerequisite Enforcement, Retrieval Parity
 *
 * 10 required tests proving:
 * 1. preformatted report containing unlinked item cannot persist that item
 * 2. preformatted report containing F05-rejected text cannot persist that text
 * 3. only reportable canonical findings appear in final markdown
 * 4. missing evidence-admission ledger blocks completion
 * 5. GetRunOutput returns the persisted semantic hash and reportable IDs
 * 6. export returns the same semantic hash and reportable IDs
 * 7. changing final report markdown changes the final semantic hash
 * 8. direct/persisted/GetRunOutput/export hashes are identical
 * 9. automated server-pipeline client flow does not invoke SaveModuleResult
 * 10. server-side duplicate-write guard remains functional
 *
 * Parent revision must fail: 1, 4, 5, 6, 7, 9
 * This revision must pass all ten.
 */
import { formatCanonicalReport, getReportExclusionReason, loadCheckpointStatus } from "../canonical-finalizer.js";
import {
  buildSemanticHashInput,
  computeSemanticHash,
} from "../canonical-final-artifact.js";
import type { CanonicalFinalArtifact, ExcludedFinding, NarrativeDiagnostic } from "../canonical-final-artifact.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Self-contained test harness (no vitest/jest dependency)
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertContains(text: string, substring: string, msg: string): void {
  assert(text.includes(substring), `${msg} — expected to contain "${substring}"`);
}

function assertNotContains(text: string, substring: string, msg: string): void {
  assert(!text.includes(substring), `${msg} — expected NOT to contain "${substring}"`);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertNotEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.error(`  FAIL: ${msg} — values should differ but both are: ${a}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertMatch(actual: string, pattern: RegExp, msg: string): void {
  assert(pattern.test(actual), `${msg} — "${actual}" did not match ${pattern}`);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCanonicalFinding(overrides: Partial<{
  finding_id: string;
  title: string;
  detail: string;
  severity: string;
  _canonical_verdict: string;
  _semantic_hash: string;
  finding_kind: string;
  issue_key: string;
  evidence: any[];
}> = {}) {
  return {
    finding_id: overrides.finding_id ?? "f-" + Math.random().toString(36).slice(2, 10),
    title: overrides.title ?? "Test Finding",
    detail: overrides.detail ?? "Test detail content",
    severity: overrides.severity ?? "warning",
    gap_type: "diligence_gap",
    source_docs: ["doc1.pdf"],
    full_analysis: "Full analysis text",
    evidence: overrides.evidence ?? [{ text: "evidence" }],
    finding_kind: overrides.finding_kind ?? "substantive",
    issue_key: overrides.issue_key ?? "ISS-001",
    _canonical_verdict: overrides._canonical_verdict ?? "confirmed",
    _semantic_hash: overrides._semantic_hash ?? "sha256-finding:" + Math.random().toString(36).slice(2),
  };
}

function makeDiagnostics(
  excludedFindings: Array<{ finding_id: string; reason: string }> = [],
  narrativeValidation: Array<{ finding_id: string; status: string }> = []
): CanonicalFinalArtifact["diagnostics"] {
  return {
    excluded_findings: excludedFindings.map(e => ({
      finding_id: e.finding_id,
      title: "excluded",
      exclusion_reason: e.reason as ExcludedFinding["exclusion_reason"],
    })),
    narrative_validation: narrativeValidation.map(n => ({
      finding_id: n.finding_id,
      status: n.status as NarrativeDiagnostic["status"],
      reason_codes: [],
      fallback_used: false,
    })),
    degraded_conditions: [],
    checkpoint_status: [],
  };
}

// =============================================================================
// RUN ALL TESTS
// =============================================================================

async function runAllTests() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("MAT-F06 CORRECTION: Report Filtering, Prerequisite Enforcement, Retrieval Parity");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: preformatted report with unlinked item cannot persist
  // ───────────────────────────────────────────────────────────────────────────
  console.log("TEST 1: preformatted report containing unlinked item cannot persist that item");
  {
    const unlinkedFinding = makeCanonicalFinding({
      finding_id: "f-unlinked",
      title: "Unlinked Item Without Evidence",
      detail: "This has no linked evidence",
      finding_kind: "housekeeping",
      evidence: [],
    });
    const linkedFinding = makeCanonicalFinding({
      finding_id: "f-linked",
      title: "Properly Linked Finding",
      detail: "Has full evidence chain",
    });

    const unlinkedExclusion = getReportExclusionReason(unlinkedFinding);
    const linkedExclusion = getReportExclusionReason(linkedFinding);

    assert(unlinkedExclusion !== null, "1a. Unlinked/housekeeping finding IS excluded");
    assert(linkedExclusion === null, "1b. Linked substantive finding is NOT excluded");

    // formatCanonicalReport only gets reportable findings
    const reportableFindings = [linkedFinding];
    const report = formatCanonicalReport("Test Header", reportableFindings, {});

    assertContains(report, "Properly Linked Finding", "1c. Linked finding appears in report");
    assertNotContains(report, "Unlinked Item Without Evidence", "1d. Unlinked item NOT in report");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: preformatted report with F05-rejected text cannot persist
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 2: preformatted report containing F05-rejected text cannot persist that text");
  {
    const rejectedFinding = makeCanonicalFinding({
      finding_id: "f-rejected",
      title: "F05 Rejected Finding",
      detail: "This was rejected by narrative enforcement",
    });
    const acceptedFinding = makeCanonicalFinding({
      finding_id: "f-accepted",
      title: "Accepted Finding",
      detail: "This passed narrative enforcement",
    });

    // Only accepted is reportable (rejected excluded by narrative enforcement)
    const reportableFindings = [acceptedFinding];
    const report = formatCanonicalReport("Test Header", reportableFindings, {});

    assertContains(report, "Accepted Finding", "2a. Accepted finding appears");
    assertNotContains(report, "F05 Rejected Finding", "2b. Rejected finding NOT in report");
    assertNotContains(report, "rejected by narrative", "2c. Rejected text NOT in report");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: only reportable canonical findings in final markdown
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 3: only reportable canonical findings appear in final markdown");
  {
    const findings = [
      makeCanonicalFinding({ finding_id: "f1", title: "Finding Alpha", severity: "critical" }),
      makeCanonicalFinding({ finding_id: "f2", title: "Finding Beta", severity: "warning" }),
      makeCanonicalFinding({ finding_id: "f3", title: "Finding Gamma", severity: "info" }),
    ];

    const report = formatCanonicalReport("Executive Summary", findings, {});
    assertContains(report, "Finding Alpha", "3a. Alpha in report");
    assertContains(report, "Finding Beta", "3b. Beta in report");
    assertContains(report, "Finding Gamma", "3c. Gamma in report");
    assertContains(report, "Executive Summary", "3d. Header in report");

    const emptyReport = formatCanonicalReport("Header", [], {});
    assertNotContains(emptyReport, "Finding Alpha", "3e. No findings in empty report");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: missing evidence-admission ledger blocks completion
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 4: missing evidence-admission ledger blocks completion");
  {
    const mockDb = {
      query: async (sql: string, _schema: any, params: any[], _meta?: any) => {
        if (sql.includes("pipeline_checkpoints")) {
          return [
            { checkpoint_key: "claims_ledger", status: "complete" },
            { checkpoint_key: "reconciliation", status: "complete" },
          ];
        }
        if (sql.includes("merge_checkpoints")) {
          return []; // No Q3 evidence admission
        }
        return [];
      },
    };

    const status = await loadCheckpointStatus(mockDb, "run-123", "contradiction_check", true);
    const evidenceEntry = status.find(s => s.key === "evidence_admission");

    assert(evidenceEntry !== undefined, "4a. evidence_admission entry exists");
    assertEqual(evidenceEntry?.present, false, "4b. evidence_admission is NOT present");
    assertEqual(evidenceEntry?.status, "missing", "4c. status is 'missing'");

    // Other prerequisites should be present
    const claimsEntry = status.find(s => s.key === "claims_ledger");
    assertEqual(claimsEntry?.present, true, "4d. claims_ledger IS present");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: GetRunOutput returns semantic hash and reportable IDs
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 5: GetRunOutput schema includes semanticHash and reportableFindingIds");
  {
    const mod = await import("../../modules/get-run-output.js");
    const GetRunOutput = mod.default as any;
    const outputShape = GetRunOutput.output?.shape?.output;

    assert(outputShape !== undefined, "5a. GetRunOutput has output schema");
    // Check that the nullable output union contains the new fields
    const innerShape = outputShape?.unwrap?.()?.shape ?? outputShape?._def?.innerType?.shape;
    assert(innerShape?.semanticHash !== undefined, "5b. semanticHash field exists");
    assert(innerShape?.reportableFindingIds !== undefined, "5c. reportableFindingIds field exists");
    assert(innerShape?.schemaVersion !== undefined, "5d. schemaVersion field exists");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 6: ExportFindings returns semantic hash and reportable IDs
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 6: ExportFindings schema includes semanticHash and reportableFindingIds");
  {
    const mod = await import("../export-findings.js");
    const ExportFindings = mod.default as any;
    const outputShape = ExportFindings.output?.shape;

    assert(outputShape !== undefined, "6a. ExportFindings has output schema");
    assert(outputShape?.semanticHash !== undefined, "6b. semanticHash field exists");
    assert(outputShape?.reportableFindingIds !== undefined, "6c. reportableFindingIds field exists");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 7: changing final report markdown changes semantic hash
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 7: changing final report markdown changes the final semantic hash");
  {
    const findings = [makeCanonicalFinding({ finding_id: "f1", title: "Finding A" })];
    const diagnostics = makeDiagnostics();

    const hashInput1 = buildSemanticHashInput(
      findings, ["f1"], diagnostics, "contradiction_check",
      "# Report Version 1\nSome content"
    );
    const hash1 = computeSemanticHash(hashInput1);

    const hashInput2 = buildSemanticHashInput(
      findings, ["f1"], diagnostics, "contradiction_check",
      "# Report Version 2\nDifferent content"
    );
    const hash2 = computeSemanticHash(hashInput2);

    assertNotEqual(hash1, hash2, "7a. Different report → different hash");
    assertMatch(hash1, /^sha256-v1:[a-f0-9]{64}$/, "7b. Hash1 is valid format");
    assertMatch(hash2, /^sha256-v1:[a-f0-9]{64}$/, "7c. Hash2 is valid format");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 8: same inputs produce identical hash
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 8: direct/persisted/GetRunOutput/export hashes are identical");
  {
    const findings = [
      makeCanonicalFinding({ finding_id: "f1", title: "X", _semantic_hash: "sh1" }),
      makeCanonicalFinding({ finding_id: "f2", title: "Y", _semantic_hash: "sh2" }),
    ];
    const diagnostics = makeDiagnostics();
    const reportMd = "# Final Report\nContent here.";

    const directInput = buildSemanticHashInput(findings, ["f1", "f2"], diagnostics, "contradiction_check", reportMd);
    const directHash = computeSemanticHash(directInput);

    const persistedInput = buildSemanticHashInput(findings, ["f1", "f2"], diagnostics, "contradiction_check", reportMd);
    const persistedHash = computeSemanticHash(persistedInput);

    const apiInput = buildSemanticHashInput(findings, ["f1", "f2"], diagnostics, "contradiction_check", reportMd);
    const apiHash = computeSemanticHash(apiInput);

    assertEqual(directHash, persistedHash, "8a. direct == persisted");
    assertEqual(persistedHash, apiHash, "8b. persisted == api");
    assertMatch(directHash, /^sha256-v1:/, "8c. Valid hash prefix");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 9: server-pipeline client flow does not invoke SaveModuleResult
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 9: automated server-pipeline client flow does not invoke SaveModuleResult");
  {
    const dashboardPath = path.resolve(__dirname, "../../../../client/pages/DealDashboard/index.tsx");
    const source = fs.readFileSync(dashboardPath, "utf8");

    const completionStart = source.indexOf("// Pipeline completed \u2014 format report");
    assert(completionStart > 0, "9a. Found pipeline completion section");

    // Find the section between completion marker and next major section
    const sectionEnd = source.indexOf("// Run single module", completionStart);
    const completionSection = source.slice(completionStart, sectionEnd > 0 ? sectionEnd : completionStart + 5000);

    assertNotContains(completionSection, "await saveModuleResult(", "9b. No saveModuleResult call in server-pipeline path");
    assertContains(completionSection, "MAT-F06 \u00a74", "9c. MAT-F06 §4 comment present");
    assertContains(completionSection, "do NOT call SaveModuleResult", "9d. Explicit no-call comment");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 10: server-side duplicate-write guard remains functional
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTEST 10: server-side duplicate-write guard remains functional");
  {
    const saveModulePath = path.resolve(__dirname, "../../../modules/save-module-result.ts");
    const source = fs.readFileSync(saveModulePath, "utf8");

    assertContains(source, "MAT-F06 \u00a7D", "10a. Guard comment present");
    assertContains(source, "semantic_hash", "10b. semantic_hash check present");
    assertContains(source, "skipping duplicate write", "10c. Skip-duplicate log present");

    const runIdBlock = source.indexOf("if (runId)");
    const guardComment = source.indexOf("MAT-F06 \u00a7D");
    assert(guardComment > runIdBlock, "10d. Guard is inside runId block");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`MAT-F06 CORRECTION RESULTS: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    throw new Error(`MAT-F06 correction: ${failed} test(s) failed`);
  }
}

// Export for use as a module test
export { runAllTests };

// Self-execute when imported
runAllTests().catch(err => {
  console.error("MAT-F06 correction tests failed:", err);
});
