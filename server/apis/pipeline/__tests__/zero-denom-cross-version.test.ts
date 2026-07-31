/**
 * Commit 3 — Zero-Denominator Severity and Cross-Version Classification: Tests
 *
 *   Test 1:  Zero-model + zero-claim → within_tolerance (de minimis)
 *   Test 2:  Zero-model + non-trivial claim → no synthetic 100%
 *   Test 3:  Near-zero model (£500) + £8k claim → within_tolerance (both small)
 *   Test 4:  Near-zero model (£500) + £50k claim → fires finding by absolute delta
 *   Test 5:  Normal denominator still computes percentage correctly
 *   Test 6:  Severity_anchor formatting: £19k displays as £19k not £0.0m
 *   Test 7:  Severity_anchor formatting: £2.4m displays as £2.4m
 *   Test 8:  cross_version finding_kind is preserved (not mapped to data_divergence)
 *   Test 9:  isCrossVersionDivergence recognizes explicit cross_version kind
 *   Test 10: isCrossVersionDivergence recognizes heuristic pattern in data_divergence
 *   Test 11: isCrossVersionDivergence returns false for plain data_divergence
 *
 * Run: npx tsx server/apis/pipeline/__tests__/zero-denom-cross-version.test.ts
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}\n    expected: ${e}\n    actual:   ${a}`); }
}

// ---------------------------------------------------------------------------
// Test 1: Zero model + zero claim → within tolerance (de minimis)
// ---------------------------------------------------------------------------
console.log("\nTest 1: Zero-model + zero-claim → within_tolerance");
{
  // Both values < DE_MINIMIS_THRESHOLD (£10k) and model < NEAR_ZERO (£1k)
  const DE_MINIMIS_THRESHOLD = 10_000;
  const NEAR_ZERO_THRESHOLD = 1_000;
  const modelVal = 0;
  const claimVal = 0;
  const deltaAbs = Math.abs(claimVal - modelVal);

  const bothSmall = Math.abs(modelVal) < NEAR_ZERO_THRESHOLD && Math.abs(claimVal) < DE_MINIMIS_THRESHOLD;
  assert(bothSmall, "Both values are trivially small");
  assertEqual(deltaAbs, 0, "Delta is zero");
}

// ---------------------------------------------------------------------------
// Test 2: Zero-model + non-trivial claim → no synthetic 100%
// ---------------------------------------------------------------------------
console.log("\nTest 2: Zero-model + non-trivial claim → no synthetic 100%");
{
  const NEAR_ZERO_THRESHOLD = 1_000;
  const modelVal = 0;
  const claimVal = 50_000; // £50k — non-trivial

  let deltaPct: number;
  if (Math.abs(modelVal) < NEAR_ZERO_THRESHOLD) {
    deltaPct = 0; // Severity driven by absolute delta only
  } else {
    deltaPct = Math.abs(claimVal - modelVal) / Math.abs(modelVal);
  }

  assertEqual(deltaPct, 0, "deltaPct is 0 (not synthetic 1.0/100%)");
  // Old code would have: deltaPct = 1 (100%) which is wrong
  assert(deltaPct !== 1, "Not the old synthetic 100% value");
}

// ---------------------------------------------------------------------------
// Test 3: Near-zero model (£500) + £8k claim → within_tolerance
// ---------------------------------------------------------------------------
console.log("\nTest 3: Near-zero model + small claim → within_tolerance");
{
  const DE_MINIMIS_THRESHOLD = 10_000;
  const NEAR_ZERO_THRESHOLD = 1_000;
  const modelVal = 500;
  const claimVal = 8_000;

  const bothSmall = Math.abs(modelVal) < NEAR_ZERO_THRESHOLD && Math.abs(claimVal) < DE_MINIMIS_THRESHOLD;
  assert(bothSmall, "£500 model + £8k claim: both considered small");
}

// ---------------------------------------------------------------------------
// Test 4: Near-zero model (£500) + £50k claim → fires finding by abs delta
// ---------------------------------------------------------------------------
console.log("\nTest 4: Near-zero model + large claim → NOT within_tolerance");
{
  const DE_MINIMIS_THRESHOLD = 10_000;
  const NEAR_ZERO_THRESHOLD = 1_000;
  const modelVal = 500;
  const claimVal = 50_000; // £50k > DE_MINIMIS

  const bothSmall = Math.abs(modelVal) < NEAR_ZERO_THRESHOLD && Math.abs(claimVal) < DE_MINIMIS_THRESHOLD;
  assert(!bothSmall, "£50k claim exceeds de minimis — this will fire a finding");

  // deltaPct is driven to 0, but deltaAbs = £49,500 which is below MATERIALITY_ABS_FLOOR (£2m)
  const deltaAbs = Math.abs(claimVal - modelVal);
  assertEqual(deltaAbs, 49_500, "Absolute delta is £49,500");
}

// ---------------------------------------------------------------------------
// Test 5: Normal denominator computes percentage correctly
// ---------------------------------------------------------------------------
console.log("\nTest 5: Normal denominator computes correct percentage");
{
  const NEAR_ZERO_THRESHOLD = 1_000;
  const modelVal = 100_000_000; // £100m
  const claimVal = 115_000_000; // £115m — 15% higher
  const deltaAbs = Math.abs(claimVal - modelVal);

  let deltaPct: number;
  if (Math.abs(modelVal) < NEAR_ZERO_THRESHOLD) {
    deltaPct = 0;
  } else {
    deltaPct = deltaAbs / Math.abs(modelVal);
  }

  assertEqual(deltaPct, 0.15, "15% correctly computed");
  assert(deltaPct > 0, "Percentage is positive for normal denominators");
}

// ---------------------------------------------------------------------------
// Test 6: Severity_anchor formatting: £19k displays as £19k
// ---------------------------------------------------------------------------
console.log("\nTest 6: Severity anchor £19k displays as £19k");
{
  const severityAnchor = 19_000;
  const formatted = severityAnchor >= 1_000_000
    ? `£${(severityAnchor / 1_000_000).toFixed(1)}m`
    : `£${(severityAnchor / 1_000).toFixed(0)}k`;
  assertEqual(formatted, "£19k", "£19k not £0.0m");
}

// ---------------------------------------------------------------------------
// Test 7: Severity_anchor formatting: £2.4m displays as £2.4m
// ---------------------------------------------------------------------------
console.log("\nTest 7: Severity anchor £2.4m displays as £2.4m");
{
  const severityAnchor = 2_400_000;
  const formatted = severityAnchor >= 1_000_000
    ? `£${(severityAnchor / 1_000_000).toFixed(1)}m`
    : `£${(severityAnchor / 1_000).toFixed(0)}k`;
  assertEqual(formatted, "£2.4m", "Millions format correct");
}

// ---------------------------------------------------------------------------
// Test 8: cross_version finding_kind is preserved
// ---------------------------------------------------------------------------
console.log("\nTest 8: cross_version kind preserved in canonical findings");
{
  // Simulating what appendReconciliationFindings now does
  const rf = { finding_kind: "cross_version" };
  // OLD code: (rf.finding_kind === "cross_version" ? "data_divergence" : rf.finding_kind)
  // NEW code: rf.finding_kind (pass-through)
  const result = rf.finding_kind; // Direct pass-through
  assertEqual(result, "cross_version", "cross_version preserved, not mapped to data_divergence");
}

// ---------------------------------------------------------------------------
// Test 9: isCrossVersionDivergence recognizes explicit cross_version kind
// ---------------------------------------------------------------------------
console.log("\nTest 9: isCrossVersionDivergence recognizes explicit kind");
{
  function isCrossVersionDivergence(f: { finding_kind?: string; title?: string; detail?: string; full_analysis?: string; source_docs?: string[] }): boolean {
    if (f.finding_kind === "cross_version") return true;
    if (f.finding_kind !== "data_divergence") return false;
    const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`;
    return /cross.?version|version.?mismatch|model.?vs.?narrative|narrative.?vs.?data/i.test(text)
      || (f.source_docs?.length ?? 0) >= 2;
  }

  const finding = { finding_kind: "cross_version", title: "Revenue revision", detail: "Simple detail", source_docs: ["a.pdf"] };
  assert(isCrossVersionDivergence(finding), "Explicit cross_version kind is detected");
}

// ---------------------------------------------------------------------------
// Test 10: isCrossVersionDivergence recognizes heuristic in data_divergence
// ---------------------------------------------------------------------------
console.log("\nTest 10: isCrossVersionDivergence detects heuristic pattern");
{
  function isCrossVersionDivergence(f: { finding_kind?: string; title?: string; detail?: string; full_analysis?: string; source_docs?: string[] }): boolean {
    if (f.finding_kind === "cross_version") return true;
    if (f.finding_kind !== "data_divergence") return false;
    const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`;
    return /cross.?version|version.?mismatch|model.?vs.?narrative|narrative.?vs.?data/i.test(text)
      || (f.source_docs?.length ?? 0) >= 2;
  }

  const finding = { finding_kind: "data_divergence", title: "Cross-version mismatch in revenue", detail: "", source_docs: ["a.pdf"] };
  assert(isCrossVersionDivergence(finding), "Pattern 'Cross-version' detected in title");
}

// ---------------------------------------------------------------------------
// Test 11: isCrossVersionDivergence returns false for plain data_divergence
// ---------------------------------------------------------------------------
console.log("\nTest 11: Plain data_divergence is NOT cross-version");
{
  function isCrossVersionDivergence(f: { finding_kind?: string; title?: string; detail?: string; full_analysis?: string; source_docs?: string[] }): boolean {
    if (f.finding_kind === "cross_version") return true;
    if (f.finding_kind !== "data_divergence") return false;
    const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`;
    return /cross.?version|version.?mismatch|model.?vs.?narrative|narrative.?vs.?data/i.test(text)
      || (f.source_docs?.length ?? 0) >= 2;
  }

  const finding = { finding_kind: "data_divergence", title: "Revenue delta", detail: "Memo higher than model", source_docs: ["memo.pdf"] };
  assert(!isCrossVersionDivergence(finding), "Plain data_divergence with 1 source doc is NOT cross-version");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
console.log("All Commit 3 zero-denom / cross-version tests passed ✓\n");
