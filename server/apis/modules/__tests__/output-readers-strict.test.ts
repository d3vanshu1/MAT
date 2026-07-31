/**
 * Regression test: output reader APIs fail closed on corrupt findings
 *
 * Run via: npx tsx server/apis/modules/__tests__/output-readers-strict.test.ts
 *
 * Verifies that strictReloadFindings — used by GetRunOutput, LoadModuleResults,
 * and ExportFindings — throws when persisted findings have identity corruption
 * (invalid.length > 0) or malformed entries (malformed_count > 0).
 *
 * REGRESSION: Previously all three APIs only checked malformed_count > 0 and
 * ignored invalid findings. This meant identity-corrupt findings were silently
 * dropped from the output, serving a reduced set without surfacing the error.
 *
 * After fix: strictReloadFindings throws on ANY corruption, and each API
 * returns null/empty findings (fail closed) rather than a partial set.
 */
import { strictReloadFindings } from "../strict-reload-findings.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  ✓ ${message}`);
    passed++;
  }
}

function assertThrows(fn: () => unknown, expectedSubstring: string, message: string) {
  try {
    fn();
    console.error(`  ✗ FAIL: Expected throw but none occurred — ${message}`);
    failed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message} — got error "${msg}" but expected substring "${expectedSubstring}"`);
      failed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validFinding(overrides?: Partial<Record<string, unknown>>) {
  return {
    finding_id: randomUUID(),
    title: "Test finding",
    severity: "warning",
    gap_type: "diligence_gap",
    category: "Test",
    description: "A test finding",
    source_documents: ["doc1.pdf"],
    evidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== strictReloadFindings: fail-closed behavior ===\n");

// --- 1. Healthy findings pass through ---
console.log("1. Healthy findings pass through");
{
  const findings = [validFinding(), validFinding()];
  const result = strictReloadFindings(findings, "test-healthy");
  assert(result.findings.length === 2, "returns 2 findings");
}

// --- 2. Missing finding_id → identity corrupt → throw ---
console.log("\n2. Missing finding_id causes throw (identity corruption)");
{
  const findings = [
    validFinding(),
    validFinding({ finding_id: undefined }), // missing ID
  ];
  assertThrows(
    () => strictReloadFindings(findings, "test-missing-id"),
    "identity-corrupt",
    "throws with identity-corrupt message"
  );
}

// --- 3. Invalid finding_id (not UUID) → identity corrupt → throw ---
console.log("\n3. Invalid finding_id (not UUID) causes throw");
{
  const findings = [
    validFinding({ finding_id: "not-a-uuid" }),
  ];
  assertThrows(
    () => strictReloadFindings(findings, "test-bad-uuid"),
    "identity-corrupt",
    "throws on non-UUID finding_id"
  );
}

// --- 4. Completely malformed entry → malformed_count > 0 → throw ---
console.log("\n4. Completely malformed entry causes throw");
{
  const findings = [
    validFinding(),
    "this is not an object", // malformed
  ];
  assertThrows(
    () => strictReloadFindings(findings, "test-malformed"),
    "malformed",
    "throws with malformed message"
  );
}

// --- 5. Non-array input → malformed → throw ---
console.log("\n5. Non-array input causes throw");
{
  assertThrows(
    () => strictReloadFindings("not an array", "test-not-array"),
    "malformed",
    "throws on string input"
  );
  assertThrows(
    () => strictReloadFindings({ some: "object" }, "test-obj-input"),
    "malformed",
    "throws on object input"
  );
}

// --- 6. JSON string input is parsed correctly ---
console.log("\n6. JSON string input is parsed correctly");
{
  const findings = [validFinding()];
  const result = strictReloadFindings(JSON.stringify(findings), "test-json-string");
  assert(result.findings.length === 1, "parses JSON string and returns 1 finding");
}

// --- 7. Empty array is valid (no throw) ---
console.log("\n7. Empty array is valid");
{
  const result = strictReloadFindings([], "test-empty");
  assert(result.findings.length === 0, "returns empty array without throwing");
}

// --- 8. Mix of valid + identity-corrupt → still throws (fail closed, not partial) ---
console.log("\n8. Mix of valid + corrupt still throws (no partial delivery)");
{
  const findings = [
    validFinding(),
    validFinding(),
    validFinding({ finding_id: "" }), // empty string = invalid UUID
  ];
  assertThrows(
    () => strictReloadFindings(findings, "test-mixed"),
    "Corrupt persisted findings",
    "does not return partial valid set"
  );
}

// --- 9. Source name is included in error message ---
console.log("\n9. Source name appears in error message");
{
  const findings = [validFinding({ finding_id: "nope" })];
  try {
    strictReloadFindings(findings, "MySpecificSource:run=abc");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes("MySpecificSource:run=abc"), "error message contains source identifier");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
