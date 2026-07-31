/**
 * Fix 18 — Remove prose-driven severity escalation
 *
 * Validates that free-form prose (severity_anchor, detail, full_analysis)
 * may NEVER supply the controlling amount for severity escalation.
 * Only verified structured_impact entries drive the materiality figure.
 * When structured_impact is absent → safe degraded path (structured_impact_missing),
 * which cannot escalate numerically.
 */

import { enforceMaterialityGate } from "../pipeline-core.js";

// ---------- helpers ----------
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

function baseFinding(overrides: Record<string, unknown> = {}): any {
  return {
    id: "fix18-test-" + Math.random().toString(36).slice(2, 8),
    title: "Test finding",
    detail: "",
    severity: "critical",
    severity_anchor: "",
    full_analysis: "",
    finding_kind: "data_divergence",
    category: "financial",
    structured_impact: [],
    ...overrides,
  };
}

// ---------- Test 1: £19k structured + £655m prose → based on £19k only ----------
{
  const f = baseFinding({
    title: "Revenue shortfall",
    severity_anchor: "£655m total revenue at risk per audited accounts",
    detail: "The adjustment is £19k based on verified reconciliation",
    structured_impact: [
      { role: "delta", amount: 19000, unit_multiplier: 1, verified: true },
    ],
  });

  const { findings, housekeepingFindings } = enforceMaterialityGate([f], []);

  // £19k = £0.019m << £6.55m threshold → demoted to housekeeping (< £0.5m)
  assertEqual(findings.length, 0, "Test 1: should not survive in findings");
  assertEqual(housekeepingFindings.length, 1, "Test 1: should be demoted to housekeeping");
  assert(
    housekeepingFindings[0].severity === "info",
    "Test 1: severity should be info (housekeeping)"
  );
  assert(
    !housekeepingFindings[0].materiality_rationale?.includes("655"),
    "Test 1: rationale must NOT reference prose £655m"
  );
  console.log("PASS: Test 1 — £19k structured + £655m prose → based on £19k only");
}

// ---------- Test 2: Unrelated large prose amount cannot cause critical severity ----------
{
  const f = baseFinding({
    title: "Minor formatting inconsistency",
    severity: "critical",
    detail: "References transaction value of £655m but actual impact is negligible",
    severity_anchor: "£655m stated in memo",
    structured_impact: [], // No verified impact
  });

  const { findings } = enforceMaterialityGate([f], []);

  // No structured impact, no risk marker → safe degraded path → warning
  assertEqual(findings.length, 1, "Test 2: finding should survive");
  assertEqual(findings[0].severity, "warning", "Test 2: must be demoted to warning (not critical)");
  assert(
    findings[0].materiality_rationale?.includes("structured_impact_missing"),
    "Test 2: rationale must indicate structured_impact_missing"
  );
  console.log("PASS: Test 2 — Large prose amount cannot cause critical severity");
}

// ---------- Test 3: Missing structured impact → structured_impact_missing ----------
{
  const f = baseFinding({
    severity: "critical",
    detail: "Potential exposure discussed in management memo",
    structured_impact: undefined,
  });

  const { findings } = enforceMaterialityGate([f], []);

  assertEqual(findings.length, 1, "Test 3: finding should survive as warning");
  assertEqual(findings[0].severity, "warning", "Test 3: demoted to warning");
  assert(
    findings[0].materiality_rationale?.includes("structured_impact_missing"),
    "Test 3: rationale must cite structured_impact_missing"
  );
  assert(
    findings[0].materiality_rationale?.includes("Prose amounts are not permitted"),
    "Test 3: rationale must state prose amounts are not permitted"
  );
  console.log("PASS: Test 3 — Missing structured impact records structured_impact_missing");
}

// ---------- Test 4: Verified £2.7m revenue + £1.8m EBITDA remain material ----------
{
  const f = baseFinding({
    title: "Revenue recognition error",
    severity: "critical",
    structured_impact: [
      { role: "delta", amount: 2_700_000, unit_multiplier: 1, verified: true },
      { role: "annual_impact", amount: 1_800_000, unit_multiplier: 1, verified: true },
    ],
  });

  const { findings } = enforceMaterialityGate([f], []);

  // £2.7m > £0.5m so demoted to warning (not housekeeping), but < £6.55m threshold
  assertEqual(findings.length, 1, "Test 4: finding should survive in findings");
  assertEqual(findings[0].severity, "warning", "Test 4: demoted to warning (£2.7m < £6.55m threshold)");
  assert(
    findings[0].materiality_rationale?.includes("verified structured"),
    "Test 4: rationale confirms verified structured path"
  );
  console.log("PASS: Test 4 — Verified £2.7m structured correctly evaluated via structured path");
}

// ---------- Test 5: £999m numeric_unverified → no uplift ----------
{
  const f = baseFinding({
    title: "Unverified large claim",
    severity: "critical",
    structured_impact: [
      { role: "exposure", amount: 999_000_000, unit_multiplier: 1, verified: false },
    ],
  });

  const { findings } = enforceMaterialityGate([f], []);

  // verified=false → getStructuredMaterialityM returns null → safe degraded path
  assertEqual(findings.length, 1, "Test 5: finding should survive");
  assertEqual(findings[0].severity, "warning", "Test 5: unverified produces no uplift → warning");
  assert(
    findings[0].materiality_rationale?.includes("structured_impact_missing"),
    "Test 5: rationale must indicate structured_impact_missing (none verified)"
  );
  console.log("PASS: Test 5 — £999m numeric_unverified produces no uplift");
}

// ---------- Test 6: FCA section 19 remains high through risk marker ----------
{
  const f = baseFinding({
    title: "Potential FCA section 19 breach",
    severity: "critical",
    detail: "Analysis indicates potential section 19 criminal exposure from handling client money without authorization",
    structured_impact: [], // No structured impact
  });

  const { findings } = enforceMaterialityGate([f], []);

  // Risk marker (section 19) should keep it critical regardless of missing structured_impact
  assertEqual(findings.length, 1, "Test 6: finding should survive");
  assertEqual(findings[0].severity, "critical", "Test 6: remains critical via risk marker");
  assertEqual(findings[0].materiality_rationale, undefined, "Test 6: no demotion rationale");
  console.log("PASS: Test 6 — FCA section 19 remains critical through risk marker");
}

// ---------- Test 7: Large verified structured_impact survives as critical ----------
{
  const f = baseFinding({
    title: "Material revenue overstatement",
    severity: "critical",
    structured_impact: [
      { role: "delta", amount: 12_000_000, unit_multiplier: 1, verified: true },
    ],
  });

  const { findings, housekeepingFindings } = enforceMaterialityGate([f], []);

  // £12m > £6.55m threshold → remains critical
  assertEqual(findings.length, 1, "Test 7: finding should survive");
  assertEqual(findings[0].severity, "critical", "Test 7: remains critical (above threshold)");
  assertEqual(housekeepingFindings.length, 0, "Test 7: nothing demoted to housekeeping");
  console.log("PASS: Test 7 — Large verified structured impact correctly survives as critical");
}

console.log("\n✅ All 7 Fix 18 tests passed — prose-driven severity escalation removed");
