/**
 * Fix 19 Closure: Narrow arithmetic suppression
 *
 * Validates that:
 * 1. Fabricated arithmetic finding IS suppressed
 * 2. "Irreconcilable shareholder dispute" survives
 * 3. "Accounts cannot be reconciled due to control deficiencies" survives
 * 4. Deterministic reconciliation finding survives
 * 5. Source-stated legal risk survives
 * 6. A non-numeric finding containing a regex phrase survives
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix19-closure-narrow-arithmetic-suppression.test.ts
 */

import { shouldSuppressArithmeticFinding, FABRICATED_ARITHMETIC_PATTERNS } from "../fabricated-arithmetic-patterns.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// ---------------------------------------------------------------------------
// Test 1: Fabricated arithmetic finding IS suppressed
// ---------------------------------------------------------------------------
console.log("Test 1: Fabricated arithmetic finding is suppressed");
{
  const finding = {
    title: "Revenue Summation Discrepancy",
    detail: "The periodic values sum to £450m but the total shows £420m — arithmetic mismatch",
    full_analysis: "Manual reconciliation of the column sums reveals a £30m gap.",
    // LLM-generated — no finding_kind (not deterministic)
    category: "financial",
  };

  assert(
    shouldSuppressArithmeticFinding(finding),
    "Fabricated arithmetic finding (summation discrepancy) should be suppressed"
  );
}

// ---------------------------------------------------------------------------
// Test 2: "Irreconcilable shareholder dispute" survives
// ---------------------------------------------------------------------------
console.log("Test 2: 'Irreconcilable shareholder dispute' survives");
{
  const finding = {
    title: "Irreconcilable Shareholder Dispute",
    detail: "The minority shareholders have an irreconcilable disagreement with the board regarding dividend policy.",
    full_analysis: "This dispute creates material governance risk.",
    category: "legal",
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "'Irreconcilable shareholder dispute' (legal risk) must NOT be suppressed"
  );
}

// ---------------------------------------------------------------------------
// Test 3: "Accounts cannot be reconciled due to control deficiencies" survives
// ---------------------------------------------------------------------------
console.log("Test 3: 'Accounts cannot be reconciled due to control deficiencies' survives");
{
  const finding = {
    title: "Internal Control Weakness in Financial Reporting",
    detail: "Accounts cannot be reconciled due to control deficiencies in the subsidiary's ERP system.",
    full_analysis: "The FDD report identifies a significant deficiency in internal controls.",
    category: "control",
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "Control deficiency finding must NOT be suppressed"
  );
}

// ---------------------------------------------------------------------------
// Test 4: Deterministic reconciliation finding survives
// ---------------------------------------------------------------------------
console.log("Test 4: Deterministic reconciliation finding survives");
{
  const finding = {
    title: "Revenue Reconciliation: Model vs Memo",
    detail: "Revenue does not reconcile: memo states £500m, model shows £480m",
    full_analysis: "The periodic values sum to a total that does not match the model output.",
    finding_kind: "data_divergence" as const,
    category: "financial",
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "Deterministic reconciliation finding (data_divergence) must NOT be suppressed"
  );
}

// ---------------------------------------------------------------------------
// Test 5: Source-stated legal risk survives
// ---------------------------------------------------------------------------
console.log("Test 5: Source-stated legal risk survives");
{
  const finding = {
    title: "Regulatory Compliance Failure",
    detail: "Manual reconciliation reveals that the entity fails to reconcile tax obligations under the new regulatory framework.",
    full_analysis: "This represents a legal risk with potential fines exceeding £10m.",
    category: "legal",
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "Source-stated legal risk must NOT be suppressed even if it matches arithmetic patterns"
  );
}

// ---------------------------------------------------------------------------
// Test 6: Non-numeric finding containing a regex phrase survives
// (Finding has "do not reconcile" but is about governance, not arithmetic)
// ---------------------------------------------------------------------------
console.log("Test 6: Non-numeric finding with regex phrase in governance context survives");
{
  const finding = {
    title: "Board Governance Failure",
    detail: "The board positions do not reconcile with the stated strategy.",
    full_analysis: "Multiple stakeholder dispute indicators present. Material governance failure.",
    category: "governance",
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "Governance finding containing 'do not reconcile' must NOT be suppressed"
  );
}

// ---------------------------------------------------------------------------
// Test 7: Verified finding survives even if it matches arithmetic patterns
// ---------------------------------------------------------------------------
console.log("Test 7: Verified finding with arithmetic language survives");
{
  const finding = {
    title: "Arithmetic Discrepancy in Revenue",
    detail: "The periodic values sum to £450m but report states £420m",
    full_analysis: "arithmetic error confirmed by numeric verification",
    category: "financial",
    verification: { status: "verified" },
  };

  assert(
    !shouldSuppressArithmeticFinding(finding),
    "Verified finding must NOT be suppressed even with arithmetic patterns"
  );
}

// ---------------------------------------------------------------------------
// Test 8: Broad patterns no longer exist in the pattern set
// ---------------------------------------------------------------------------
console.log("Test 8: Overly broad patterns removed from pattern set");
{
  const patternsAsStrings = FABRICATED_ARITHMETIC_PATTERNS.map(p => p.source);

  assert(
    !patternsAsStrings.some(s => s === "\\birreconcil"),
    "/\\birreconcil/i should be removed"
  );
  assert(
    !patternsAsStrings.some(s => s.includes("cannot\\s+be\\s+reconciled")),
    "/\\bcannot\\s+be\\s+reconciled\\b/i should be removed"
  );
  assert(
    !patternsAsStrings.some(s => s.includes("fails?\\s+to\\s+reconcile")),
    "/\\bfails?\\s+to\\s+reconcile\\b/i should be removed"
  );
}

console.log("\n✓ All 8 Fix 19 closure tests passed");
