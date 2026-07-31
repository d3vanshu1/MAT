/**
 * Commit 2 — Numeric Cited-Value Verification: Tests
 *
 *   Test 1:  £184.4m parses to 184_400_000
 *   Test 2:  £19k parses to 19_000
 *   Test 3:  $2.1bn parses to 2_100_000_000
 *   Test 4:  £19,000 (plain) parses to 19_000
 *   Test 5:  Values within 2% tolerance are "verified"
 *   Test 6:  Values outside tolerance are "mismatched"
 *   Test 7:  No matching figure returns "unresolved"
 *   Test 8:  Multiple conflicting matches return "ambiguous"
 *   Test 9:  Coordinate-based matching uses metric+period
 *   Test 10: Findings with >50% unresolved are flagged
 *   Test 11: Findings with <2 citations are NOT flagged regardless of match rate
 *   Test 12: applyVerificationToFindings sets numeric_unverified flag
 *
 * Run: npx tsx server/apis/pipeline/__tests__/cited-value-resolver.test.ts
 */

import {
  parseMonetaryValue,
  extractAllMonetaryValues,
  valuesWithinTolerance,
  resolveCitedValues,
  applyVerificationToFindings,
  formatVerificationDiagnostic,
  type VerifiedFigure,
} from "../cited-value-resolver.js";

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

function assertApproxEqual(actual: number, expected: number, tolerance: number, msg: string): void {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}\n    expected: ~${expected}\n    actual:   ${actual}\n    diff:     ${diff} (tolerance: ${tolerance})`); }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIGURES: VerifiedFigure[] = [
  { name: "Revenue", period: "FY2024", value: 184_400_000, source_doc: "financial_model.xlsx", source_cell: "B12", source_sheet: "P&L" },
  { name: "EBITDA", period: "FY2024", value: 57_000_000, source_doc: "financial_model.xlsx", source_cell: "B15", source_sheet: "P&L" },
  { name: "Revenue", period: "FY2025", value: 195_000_000, source_doc: "financial_model.xlsx", source_cell: "C12", source_sheet: "P&L" },
  { name: "EV", period: "FY2024", value: 655_000_000, source_doc: "ic_memo.pdf", source_cell: "p3", source_sheet: "" },
  { name: "Net Debt", period: "FY2024", value: 42_000_000, source_doc: "financial_model.xlsx", source_cell: "B30", source_sheet: "BS" },
];

// ---------------------------------------------------------------------------
// Test 1: £184.4m parses to 184_400_000
// ---------------------------------------------------------------------------
console.log("\nTest 1: £184.4m parses to 184,400,000");
{
  const result = parseMonetaryValue("£184.4m");
  assert(result !== null, "Parsed successfully");
  assertApproxEqual(result!.value, 184_400_000, 1, "Value is 184.4 million");
  assertEqual(result!.currency, "GBP", "Currency is GBP");
}

// ---------------------------------------------------------------------------
// Test 2: £19k parses to 19_000
// ---------------------------------------------------------------------------
console.log("\nTest 2: £19k parses to 19,000");
{
  const result = parseMonetaryValue("£19k");
  assert(result !== null, "Parsed successfully");
  assertApproxEqual(result!.value, 19_000, 1, "Value is 19 thousand");
  assertEqual(result!.currency, "GBP", "Currency is GBP");
}

// ---------------------------------------------------------------------------
// Test 3: $2.1bn parses to 2_100_000_000
// ---------------------------------------------------------------------------
console.log("\nTest 3: $2.1bn parses to 2,100,000,000");
{
  const result = parseMonetaryValue("$2.1bn");
  assert(result !== null, "Parsed successfully");
  assertApproxEqual(result!.value, 2_100_000_000, 1, "Value is 2.1 billion");
  assertEqual(result!.currency, "USD", "Currency is USD");
}

// ---------------------------------------------------------------------------
// Test 4: £19,000 (plain) parses to 19_000
// ---------------------------------------------------------------------------
console.log("\nTest 4: £19,000 plain parses to 19,000");
{
  const result = parseMonetaryValue("£19,000");
  assert(result !== null, "Parsed successfully");
  assertApproxEqual(result!.value, 19_000, 1, "Value is 19,000");
}

// ---------------------------------------------------------------------------
// Test 5: Values within 2% tolerance are "verified"
// ---------------------------------------------------------------------------
console.log("\nTest 5: Values within 2% tolerance are verified");
{
  // 184.4m vs 184.4m — exact match
  assert(valuesWithinTolerance(184_400_000, 184_400_000), "Exact match is within tolerance");
  // 184.4m vs 183.5m — 0.49% off, well within 2%
  assert(valuesWithinTolerance(184_400_000, 183_500_000), "0.49% difference is within tolerance");
  // 184.4m vs 181m — ~1.8% off, within 2%
  assert(valuesWithinTolerance(184_400_000, 181_000_000), "~1.8% difference is within tolerance");
}

// ---------------------------------------------------------------------------
// Test 6: Values outside tolerance are "mismatched"
// ---------------------------------------------------------------------------
console.log("\nTest 6: Values outside tolerance are mismatched");
{
  // 184.4m vs 170m — ~7.8% off, outside 2%
  assert(!valuesWithinTolerance(184_400_000, 170_000_000), "7.8% difference is outside tolerance");
  // 57m vs 50m — ~12% off
  assert(!valuesWithinTolerance(57_000_000, 50_000_000), "12% difference is outside tolerance");
}

// ---------------------------------------------------------------------------
// Test 7: No matching figure returns "unresolved"
// ---------------------------------------------------------------------------
console.log("\nTest 7: No matching figure returns unresolved");
{
  const findings = [{
    finding_id: "test-001",
    evidence: [{ figure: "£999m", verbatim_snippet: "Total of £999m", verified: false }],
  }];
  const results = resolveCitedValues(findings, FIGURES);
  assertEqual(results[0].citations[0].status, "unresolved", "Unmatched value is unresolved");
}

// ---------------------------------------------------------------------------
// Test 8: Multiple conflicting matches return "ambiguous"
// ---------------------------------------------------------------------------
console.log("\nTest 8: Multiple conflicting matches return ambiguous");
{
  // Create figures with same metric name but different periods and values both "close" to the cited value
  const ambiguousFigures: VerifiedFigure[] = [
    { name: "Revenue", period: "FY2024", value: 184_400_000, source_doc: "a.xlsx", source_cell: "B1", source_sheet: "S1" },
    { name: "Revenue", period: "FY2025", value: 195_000_000, source_doc: "b.xlsx", source_cell: "C1", source_sheet: "S1" },
  ];
  const findings = [{
    finding_id: "test-002",
    evidence: [{
      figure: "£190m",
      verbatim_snippet: "Revenue of £190m",
      verified: false,
      metric: "revenue", // matches both "Revenue" figures
    }],
  }];
  const results = resolveCitedValues(findings, ambiguousFigures);
  // Both revenues match the metric but have different values — should be ambiguous
  assertEqual(results[0].citations[0].status, "ambiguous", "Multiple conflicting matches are ambiguous");
}

// ---------------------------------------------------------------------------
// Test 9: Coordinate-based matching uses metric+period
// ---------------------------------------------------------------------------
console.log("\nTest 9: Coordinate matching resolves via metric+period");
{
  const findings = [{
    finding_id: "test-003",
    evidence: [{
      figure: "£184.4m",
      verbatim_snippet: "Revenue FY2024: £184.4m",
      verified: false,
      metric: "revenue",
      period: "FY2024",
    }],
  }];
  const results = resolveCitedValues(findings, FIGURES);
  assertEqual(results[0].citations[0].status, "verified", "Coordinate match finds exact figure");
  assertApproxEqual(results[0].citations[0].matchedValue!, 184_400_000, 1, "Matched value is correct");
}

// ---------------------------------------------------------------------------
// Test 10: Findings with >50% unresolved are flagged
// ---------------------------------------------------------------------------
console.log("\nTest 10: Findings with >50% unresolved citations are flagged");
{
  const findings = [{
    finding_id: "test-004",
    evidence: [
      { figure: "£999m", verbatim_snippet: "Unresolvable 1", verified: false },
      { figure: "£888m", verbatim_snippet: "Unresolvable 2", verified: false },
      { figure: "£184.4m", verbatim_snippet: "This one resolves", verified: false, metric: "revenue", period: "FY2024" },
    ],
  }];
  const results = resolveCitedValues(findings, FIGURES);
  // 2 out of 3 are unresolved (67%) — exceeds 50% threshold
  assertEqual(results[0].shouldFlagUnverified, true, "High unresolved ratio triggers flag");
  assertEqual(results[0].unresolved, 2, "2 unresolved");
  assertEqual(results[0].verified, 1, "1 verified");
}

// ---------------------------------------------------------------------------
// Test 11: Findings with <2 citations are NOT flagged
// ---------------------------------------------------------------------------
console.log("\nTest 11: Findings with <2 citations are not flagged");
{
  const findings = [{
    finding_id: "test-005",
    evidence: [
      { figure: "£999m", verbatim_snippet: "Single unresolved", verified: false },
    ],
  }];
  const results = resolveCitedValues(findings, FIGURES);
  // Only 1 citation — below MIN_CITATIONS_FOR_FLAG threshold
  assertEqual(results[0].shouldFlagUnverified, false, "Single citation doesn't trigger flag");
}

// ---------------------------------------------------------------------------
// Test 12: applyVerificationToFindings sets numeric_unverified flag
// ---------------------------------------------------------------------------
console.log("\nTest 12: applyVerificationToFindings sets numeric_unverified");
{
  const findings = [
    {
      finding_id: "test-006",
      numeric_unverified: undefined as boolean | undefined,
      evidence: [
        { figure: "£999m", verbatim_snippet: "x", verified: false },
        { figure: "£888m", verbatim_snippet: "y", verified: false },
        { figure: "£777m", verbatim_snippet: "z", verified: false },
      ],
    },
    {
      finding_id: "test-007",
      numeric_unverified: undefined as boolean | undefined,
      evidence: [
        { figure: "£184.4m", verbatim_snippet: "revenue", verified: false, metric: "revenue", period: "FY2024" },
        { figure: "£57m", verbatim_snippet: "ebitda", verified: false, metric: "ebitda", period: "FY2024" },
      ],
    },
  ];
  const results = resolveCitedValues(findings, FIGURES);
  const applied = applyVerificationToFindings(findings, results);

  assertEqual(applied[0].numeric_unverified, true, "High-unresolved finding is flagged");
  assert(applied[1].numeric_unverified !== true, "Fully-verified finding is NOT flagged");

  // Check evidence enrichment on finding 2
  assertEqual(applied[1].evidence![0].verified, true, "Revenue evidence marked verified");
  assertEqual(applied[1].evidence![1].verified, true, "EBITDA evidence marked verified");

  // Diagnostic formatting
  const diagnostic = formatVerificationDiagnostic(results);
  assert(diagnostic.includes("CitedValueResolver"), "Diagnostic includes module name");
  assert(diagnostic.includes("verified"), "Diagnostic includes verified count");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
console.log("All Commit 2 cited-value-resolver tests passed ✓\n");
