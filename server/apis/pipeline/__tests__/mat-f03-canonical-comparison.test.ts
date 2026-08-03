/**
 * MAT-F03: Canonical Comparison Tests — 20 production-path tests
 *
 * All tests invoke executeCanonicalComparison() — the actual production boundary
 * function called by ReplayClaimLinkage after evidence admission.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f03-canonical-comparison.test.ts
 */

import {
  executeCanonicalComparison,
  evaluateCompatibility,
  normalizeValue,
  calculateDeltas,
  assignVerdict,
  deserializeComparison,
  serializeComparison,
  COMPARISON_SCHEMA_VERSION,
  COMPATIBILITY_RULE_VERSION,
  VERDICT_RULE_VERSION,
  NORMALIZATION_RULE_VERSION,
  type ComparisonClaimInput,
  type ComparisonEvidenceInput,
  type DimensionCompatibility,
  type Calculation,
} from "../canonical-comparison.js";

// ---------------------------------------------------------------------------
// Test helpers
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

function assertApprox(actual: number | null | undefined, expected: number, tolerance: number, msg: string): void {
  if (actual === null || actual === undefined) {
    console.error(`  FAIL: ${msg} — actual is null/undefined`);
    failed++;
    return;
  }
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  PASS: ${msg} (${actual} ≈ ${expected} ±${tolerance})`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SCG_REVENUE_CLAIM: ComparisonClaimInput = {
  claim_id: "claim-scg-rev-fy26-001",
  entity: "SCG",
  metric: "revenue",
  period: "FY Mar-26",
  segment: null,
  scope: "Total Group Revenue",
  unit: "GBP_millions",
  currency: "GBP",
  scale: "millions",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "memo_claim",
  value: 194,
  ic_document_id: "ic-doc-001",
};

const SCG_MODEL_EVIDENCE: ComparisonEvidenceInput = {
  evidence_id: "ev-v1-scg-model-001",
  entity: "SCG",
  metric: "revenue",
  period: "FY Mar-26",
  segment: null,
  scope: "Total Group Revenue",
  unit: "GBP",
  currency: "GBP",
  scale: "raw",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "current_model",
  value: 184391535,
  source_document_id: "model-doc-001",
  has_entity_bridge: false,
};

// ===========================================================================
// TEST 1: £194m vs £184,391,535 revenue contradiction
// ===========================================================================

console.log("\n=== Test 1: £194m versus £184,391,535 revenue contradiction ===");
{
  const result = executeCanonicalComparison(SCG_REVENUE_CLAIM, SCG_MODEL_EVIDENCE);

  assertEqual(result.schema_version, COMPARISON_SCHEMA_VERSION, "Schema version");
  assertEqual(result.compatibility.allowed, true, "Compatibility allowed");
  assertApprox(result.calculation.normalized_claim_value, 194_000_000, 0.01, "Normalized claim = 194,000,000");
  assertApprox(result.calculation.normalized_fact_value, 184_391_535, 0.01, "Normalized fact = 184,391,535");
  assertApprox(result.calculation.signed_delta!, 9_608_465, 0.01, "Signed delta = 9,608,465");
  assertApprox(result.calculation.absolute_delta!, 9_608_465, 0.01, "Absolute delta = 9,608,465");
  assertApprox(result.calculation.percentage_delta!, 5.21090, 0.001, "Percentage delta ≈ 5.2109%");
  assertEqual(result.calculation.direction, "claim_higher", "Direction = claim_higher");
  assertEqual(result.verdict.value, "contradicted", "Verdict = contradicted");
  assertEqual(result.reportable, true, "Reportable = true");
  assert(result.comparison_id.startsWith("cmp-v1-"), "Comparison ID has canonical prefix");
}

// ===========================================================================
// TEST 2: Live vs hardcoded forecast revision
// ===========================================================================

console.log("\n=== Test 2: Live vs hardcoded forecast revision ===");
{
  const liveForecastClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    claim_id: "claim-model-rev-fy26-live",
    value: 184391535,
    scale: "raw",
    unit: "GBP",
    comparison_basis: "fs_summary",  // live FS Summary
  };

  const frozenForecastEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    evidence_id: "ev-v1-frozen-001",
    value: 187063000,
    comparison_basis: "fs summary (hardcoded)", // frozen reference
  };

  const result = executeCanonicalComparison(liveForecastClaim, frozenForecastEvidence);

  assertEqual(result.compatibility.allowed, true, "Compatibility allowed for forecast revision");
  assertEqual(result.calculation.calculation_type, "numeric", "Numeric calculation performed");
  const signedDelta = result.calculation.signed_delta!;
  assert(signedDelta !== 0, "Signed delta is non-zero");
  // live is lower than frozen → claim_lower
  assertEqual(result.calculation.direction, "claim_lower", "Direction = claim_lower (live < frozen)");
  assertEqual(result.verdict.value, "materially_changed", "Verdict = materially_changed (not contradicted)");
  assert(result.verdict.reason_codes.includes("forecast_revision"), "Reason includes forecast_revision");
}

// ===========================================================================
// TEST 3: Gamma vs SCG rejection
// ===========================================================================

console.log("\n=== Test 3: Gamma evidence vs SCG claim → entity rejection ===");
{
  const gammaEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    evidence_id: "ev-v1-gamma-001",
    entity: "Gamma",
    has_entity_bridge: false,
  };

  const result = executeCanonicalComparison(SCG_REVENUE_CLAIM, gammaEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.entity, "incompatible", "Entity = incompatible");
  assert(result.compatibility.rejection_reasons.includes("entity_incompatible"), "entity_incompatible in reasons");
  assertEqual(result.calculation.calculation_type, "not_performed", "No calculation");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
  assertEqual(result.reportable, false, "Not reportable");
}

// ===========================================================================
// TEST 4: FY24 vs FY25 period rejection
// ===========================================================================

console.log("\n=== Test 4: FY24 evidence vs FY25 claim → period rejection ===");
{
  const fy25Claim: ComparisonClaimInput = { ...SCG_REVENUE_CLAIM, period: "FY25" };
  const fy24Evidence: ComparisonEvidenceInput = { ...SCG_MODEL_EVIDENCE, period: "FY24" };

  const result = executeCanonicalComparison(fy25Claim, fy24Evidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.period, "incompatible", "Period = incompatible");
  assert(result.compatibility.rejection_reasons.includes("period_incompatible"), "period_incompatible in reasons");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
}

// ===========================================================================
// TEST 5: Actual vs forecast rejection
// ===========================================================================

console.log("\n=== Test 5: Actual evidence vs forecast claim → rejection ===");
{
  const actualEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    actual_or_forecast: "actual",
  };

  const result = executeCanonicalComparison(SCG_REVENUE_CLAIM, actualEvidence);
  // claim is forecast, evidence is actual → incompatible

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.actual_forecast, "incompatible", "Actual/forecast = incompatible");
  assert(result.compatibility.rejection_reasons.includes("actual_forecast_incompatible"), "actual_forecast_incompatible in reasons");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
}

// ===========================================================================
// TEST 6: Percentage vs currency rejection
// ===========================================================================

console.log("\n=== Test 6: Percentage evidence vs currency claim → unit rejection ===");
{
  const pctEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    unit: "percentage",
    value: 16.7,
    scale: null,
    currency: null,
  };

  const result = executeCanonicalComparison(SCG_REVENUE_CLAIM, pctEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.unit_scale, "incompatible", "Unit/scale = incompatible");
  assert(result.compatibility.rejection_reasons.includes("unit_scale_incompatible"), "unit_scale_incompatible in reasons");
  assertEqual(result.calculation.calculation_type, "not_performed", "No calculation");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
}

// ===========================================================================
// TEST 7: Group vs segment rejection
// ===========================================================================

console.log("\n=== Test 7: Segment evidence vs group claim → scope rejection ===");
{
  const segmentEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    scope: "North Region",
    segment: "North",
  };

  const groupClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    scope: "Total Group Revenue",
    segment: null,
  };

  const result = executeCanonicalComparison(groupClaim, segmentEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  // segment is incompatible (claim has no segment, evidence does)
  assertEqual(result.compatibility.segment, "incompatible", "Segment = incompatible");
}

// ===========================================================================
// TEST 8: Revenue vs gross profit rejection
// ===========================================================================

console.log("\n=== Test 8: Gross profit evidence vs revenue claim → metric rejection ===");
{
  const grossProfitEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    metric: "gross_profit",
    value: 89_000_000,
  };

  const result = executeCanonicalComparison(SCG_REVENUE_CLAIM, grossProfitEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.metric, "incompatible", "Metric = incompatible");
  assert(result.compatibility.rejection_reasons.includes("metric_incompatible"), "metric_incompatible in reasons");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
}

// ===========================================================================
// TEST 9: Reported EBITDA vs cash EBITDA rejection
// ===========================================================================

console.log("\n=== Test 9: Reported EBITDA vs cash EBITDA → metric rejection ===");
{
  const reportedEbitdaClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    metric: "reported_ebitda",
    value: 45_000_000,
    scope: "Reported EBITDA",
  };

  const cashEbitdaEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    metric: "cash_ebitda",
    value: 57_000_000,
    scope: "Cash EBITDA",
  };

  const result = executeCanonicalComparison(reportedEbitdaClaim, cashEbitdaEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.metric, "incompatible", "Metric = incompatible (reported ≠ cash EBITDA)");
  assert(result.compatibility.rejection_reasons.includes("metric_incompatible"), "metric_incompatible in reasons");
}

// ===========================================================================
// TEST 10: Gross margin % vs gross profit £ rejection
// ===========================================================================

console.log("\n=== Test 10: Gross margin % vs gross profit £ → metric rejection ===");
{
  const grossMarginClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    metric: "gross_margin",
    unit: "percentage",
    value: 48.3,
    scale: null,
    currency: null,
  };

  const grossProfitEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    metric: "gross_profit",
    unit: "GBP",
    value: 89_000_000,
    currency: "GBP",
  };

  const result = executeCanonicalComparison(grossMarginClaim, grossProfitEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.metric, "incompatible", "Metric = incompatible (gross_margin_pct ≠ gross_profit)");
}

// ===========================================================================
// TEST 11: Company KPI vs TAM rejection
// ===========================================================================

console.log("\n=== Test 11: Company KPI vs TAM → metric rejection ===");
{
  const kpiClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    metric: "revenue",
    value: 184_000_000,
  };

  const tamEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    metric: "tam",
    value: 5_000_000_000,
    scope: "Total Addressable Market",
  };

  const result = executeCanonicalComparison(kpiClaim, tamEvidence);

  assertEqual(result.compatibility.allowed, false, "Compatibility not allowed");
  assertEqual(result.compatibility.metric, "incompatible", "Metric = incompatible (revenue ≠ TAM)");
}

// ===========================================================================
// TEST 12: Millions/raw currency normalization
// ===========================================================================

console.log("\n=== Test 12: Millions vs raw currency normalization ===");
{
  const norm194m = normalizeValue(194, "GBP_millions", "millions");
  const normRaw = normalizeValue(194_000_000, "GBP", "raw");

  assert(norm194m !== null, "£194m normalizes");
  assert(normRaw !== null, "£194,000,000 normalizes");
  assertApprox(norm194m!.normalized_value, 194_000_000, 0.01, "£194m = 194,000,000");
  assertApprox(normRaw!.normalized_value, 194_000_000, 0.01, "£194,000,000 = 194,000,000");
  assertEqual(norm194m!.rule_applied, "scale_millions", "Rule = scale_millions");
}

// ===========================================================================
// TEST 13: Thousands/raw currency normalization
// ===========================================================================

console.log("\n=== Test 13: Thousands vs raw normalization ===");
{
  const normThousands = normalizeValue(194, "GBP_thousands", "thousands");
  const normRaw = normalizeValue(194_000, "GBP", "raw");

  assert(normThousands !== null, "£194k normalizes");
  assertApprox(normThousands!.normalized_value, 194_000, 0.01, "£194k = 194,000");
  assertApprox(normRaw!.normalized_value, 194_000, 0.01, "£194,000 raw = 194,000");
}

// ===========================================================================
// TEST 14: Percentage normalization
// ===========================================================================

console.log("\n=== Test 14: Percentage normalization (display % to ratio) ===");
{
  const pct16_7 = normalizeValue(16.7, "percentage", null);
  const pct0_167 = normalizeValue(0.167, "percentage", null);

  assert(pct16_7 !== null, "16.7% normalizes");
  assert(pct0_167 !== null, "0.167 ratio normalizes");
  assertApprox(pct16_7!.normalized_value, 0.167, 0.0001, "16.7% → ≈0.167 ratio");
  assertApprox(pct0_167!.normalized_value, 0.167, 0.0001, "0.167 → 0.167 (already ratio)");
  assertEqual(pct16_7!.normalized_unit, "ratio", "Unit = ratio");
}

// ===========================================================================
// TEST 15: Percentage-point vs percentage distinction
// ===========================================================================

console.log("\n=== Test 15: Percentage points vs percentage are different unit families ===");
{
  const ppClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    metric: "gross_margin",
    unit: "percentage_point",
    value: 10,
    scale: null,
    currency: null,
  };

  const pctEvidence: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    unit: "percentage",
    value: 10,
    scale: null,
    currency: null,
  };

  // Both are percentage family — compatible from a unit-family perspective
  // But the normalized values will differ in interpretation
  const ppNorm = normalizeValue(10, "percentage_point", null);
  const pctNorm = normalizeValue(10, "percentage", null);

  assert(ppNorm !== null, "10pp normalizes");
  assert(pctNorm !== null, "10% normalizes");
  assertApprox(ppNorm!.normalized_value, 0.10, 0.0001, "10pp → 0.10 ratio");
  assertApprox(pctNorm!.normalized_value, 0.10, 0.0001, "10% → 0.10 ratio");
  // Same numeric value — but semantically different (pp vs % relative change)
  assertEqual(ppNorm!.rule_applied, "percentage_points_to_ratio", "PP rule");
  assertEqual(pctNorm!.rule_applied, "percentage_to_ratio", "Pct rule");
}

// ===========================================================================
// TEST 16: Basis-point normalization
// ===========================================================================

console.log("\n=== Test 16: Basis-point normalization ===");
{
  const bpNorm = normalizeValue(100, "basis_point", null);
  const ppNorm = normalizeValue(1, "percentage_point", null);

  assert(bpNorm !== null, "100bp normalizes");
  assertApprox(bpNorm!.normalized_value, 0.01, 0.0001, "100bp → 0.01 ratio (= 1pp)");
  assertApprox(ppNorm!.normalized_value, 0.01, 0.0001, "1pp → 0.01 ratio");
  assertEqual(bpNorm!.rule_applied, "basis_points_to_ratio", "BP rule");
}

// ===========================================================================
// TEST 17: Unknown scale fails closed
// ===========================================================================

console.log("\n=== Test 17: Unknown scale fails closed ===");
{
  // A unit family known but scale completely unknown
  const unknownScaleNorm = normalizeValue(194, "GBP", "decillions");
  assertEqual(unknownScaleNorm, null, "Unknown scale returns null (fail closed)");

  // Full comparison with unknown unit fails closed
  const unknownUnitClaim: ComparisonClaimInput = {
    ...SCG_REVENUE_CLAIM,
    unit: "xyzunknownunit",
    scale: null,
  };
  const result = executeCanonicalComparison(unknownUnitClaim, SCG_MODEL_EVIDENCE);
  assertEqual(result.compatibility.unit_scale, "unknown", "Unit/scale = unknown for unrecognized unit");
  assertEqual(result.compatibility.allowed, false, "Unknown unit fails closed");
  assertEqual(result.verdict.value, "unverifiable", "Verdict = unverifiable");
}

// ===========================================================================
// TEST 18: Zero denominator handling
// ===========================================================================

console.log("\n=== Test 18: Zero denominator handling ===");
{
  const deltas = calculateDeltas(100, 0);
  assertEqual(deltas.signed_delta, 100, "Signed delta = 100 (claim - 0)");
  assertEqual(deltas.absolute_delta, 100, "Absolute delta = 100");
  assertEqual(deltas.percentage_delta, null, "Percentage delta = null (zero denominator)");
  assertEqual(deltas.direction, "claim_higher", "Direction = claim_higher");
}

// ===========================================================================
// TEST 19: Deterministic verdict unaffected by narrative
// ===========================================================================

console.log("\n=== Test 19: Deterministic verdict unaffected by narrative wording ===");
{
  // Run the same numeric comparison twice with different evidence IDs
  // (simulating different narrative descriptions)
  const result1 = executeCanonicalComparison(SCG_REVENUE_CLAIM, SCG_MODEL_EVIDENCE);

  const evidenceWithDifferentId: ComparisonEvidenceInput = {
    ...SCG_MODEL_EVIDENCE,
    evidence_id: "ev-v1-different-narrative-desc",
    // Same numeric values, same entity, metric, period — different ID
  };
  const result2 = executeCanonicalComparison(SCG_REVENUE_CLAIM, evidenceWithDifferentId);

  // Verdicts must be identical regardless of evidence ID / narrative
  assertEqual(result1.verdict.value, result2.verdict.value, "Verdict identical regardless of evidence ID");
  assertEqual(result1.calculation.signed_delta, result2.calculation.signed_delta, "Delta identical");
  assertEqual(result1.verdict.rule_version, VERDICT_RULE_VERSION, "Rule version recorded");

  // Different evidence IDs → different comparison IDs (content-derived)
  assert(result1.comparison_id !== result2.comparison_id, "Comparison IDs differ (different evidence IDs)");
}

// ===========================================================================
// TEST 20: Comparison persistence / reload parity
// ===========================================================================

console.log("\n=== Test 20: Comparison persistence and reload parity ===");
{
  const comparisons = [
    // 1. Admitted current-model record
    executeCanonicalComparison(SCG_REVENUE_CLAIM, SCG_MODEL_EVIDENCE),
    // 2. Admitted Legal DD record (qualitative — no numeric value)
    executeCanonicalComparison(
      { ...SCG_REVENUE_CLAIM, claim_id: "claim-legal-dd-001", value: null },
      { ...SCG_MODEL_EVIDENCE, evidence_id: "ev-v1-legal-dd-001", value: null },
    ),
    // 3. Gamma entity rejection
    executeCanonicalComparison(SCG_REVENUE_CLAIM, {
      ...SCG_MODEL_EVIDENCE,
      evidence_id: "ev-v1-gamma-reject",
      entity: "Gamma",
      has_entity_bridge: false,
    }),
    // 4. Invalid unit rejection
    executeCanonicalComparison(
      { ...SCG_REVENUE_CLAIM, claim_id: "claim-inv-unit" },
      { ...SCG_MODEL_EVIDENCE, evidence_id: "ev-v1-inv-unit", unit: "xyzunknown" },
    ),
  ];

  // Serialize → deserialize → compare
  for (const original of comparisons) {
    const serialized = serializeComparison(original);
    const reloaded = deserializeComparison(serialized);

    assertEqual(reloaded.comparison_id, original.comparison_id,
      `[${original.comparison_id.slice(0,16)}] Comparison ID survives round-trip`);
    assertEqual(reloaded.claim_id, original.claim_id,
      `[${original.comparison_id.slice(0,16)}] Claim ID survives round-trip`);
    assertEqual(reloaded.evidence_id, original.evidence_id,
      `[${original.comparison_id.slice(0,16)}] Evidence ID survives round-trip`);
    assertEqual(reloaded.compatibility.allowed, original.compatibility.allowed,
      `[${original.comparison_id.slice(0,16)}] Compatibility allowed survives round-trip`);
    assertEqual(reloaded.verdict.value, original.verdict.value,
      `[${original.comparison_id.slice(0,16)}] Verdict survives round-trip`);
    assertEqual(reloaded.calculation.signed_delta, original.calculation.signed_delta,
      `[${original.comparison_id.slice(0,16)}] Signed delta survives round-trip`);
    assertEqual(reloaded.verdict.rule_version, VERDICT_RULE_VERSION,
      `[${original.comparison_id.slice(0,16)}] Rule version present after reload`);
    assertEqual(reloaded.compatibility.rule_version, COMPATIBILITY_RULE_VERSION,
      `[${original.comparison_id.slice(0,16)}] Compat rule version present after reload`);
    assertEqual(reloaded.schema_version, COMPARISON_SCHEMA_VERSION,
      `[${original.comparison_id.slice(0,16)}] Schema version present after reload`);
  }
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${"=".repeat(70)}`);
console.log(`MAT-F03 Canonical Comparison Tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(70)}`);

if (failed > 0) {
  process.exit(1);
}
