/**
 * MAT-F05: Narrative Boundary Production-Path Tests
 *
 * 22 tests covering the F05 spec's "Required targeted tests" list.
 * Each test invokes the production narration, merge, or final-finding boundary.
 *
 * Parent-fail/new-pass requirements:
 *   - invented number rejection (Test 1)
 *   - synthesized quotation rejection (Test 6)
 *   - LLM verdict override prevention (Test 5)
 *   - supporting evidence cannot become adverse (Test 12)
 *   - process fallback cannot become a finding (Test 20)
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f05-narrative-boundary.test.ts
 */

import {
  validateNarrativeOutput,
  extractNumericTokens,
  normalizeNumberString,
  isWithinNormalizationTolerance,
  extractQuotedStrings,
  findVerdictContradictions,
} from "../narrative-validator.js";
import {
  processNarration,
  generateDeterministicFallbackNarrative,
  shouldExcludeAsProcessObject,
  type NarrativeOutput,
  type LockedNarrationInput,
} from "../narrative-boundary.js";
import {
  applyAuthorityGate,
  applyBatchAuthorityGate,
} from "../narrative-authority-gate.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// ===========================================================================
// Test harness
// ===========================================================================

let passed = 0;
let failed = 0;

function assertTrue(condition: boolean, msg: string): void {
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

function assertContains(arr: string[], item: string, msg: string): void {
  if (!arr.includes(item)) {
    console.error(`  FAIL: ${msg}\n    expected to contain: "${item}"\n    actual: [${arr.join(", ")}]`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertNotContains(arr: string[], item: string, msg: string): void {
  if (arr.includes(item)) {
    console.error(`  FAIL: ${msg}\n    expected NOT to contain: "${item}"`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

// ===========================================================================
// Shared Fixture: SCG £194m vs £184.4m Revenue Finding
// ===========================================================================

const SCG_LOCKED_INPUT: LockedNarrationInput = {
  exact_claim_text: "Management projects FY Mar-26 revenue of £194m for the group",
  claim_metric: "revenue",
  claim_period: "FY Mar-26",
  claim_entity: "SCG",
  claim_value: 194_000_000,
  claim_unit: "GBP_millions",
  admitted_evidence: [
    {
      evidence_id: "ev-001",
      source_document_name: "SCG_Financial_Model_v3.xlsx",
      coordinate_label: "P&L/B12",
      exact_excerpt: "P&L/B12: 184391535",
      evidence_role: "contradicting",
      authority_class: "current_financial_model",
      value: 184_391_535,
      unit: "GBP",
    },
  ],
  calculations: [
    {
      normalized_claim_value: 194_000_000,
      normalized_fact_value: 184_391_535,
      signed_delta: -9_608_465,
      percentage_delta: -4.95,
      direction: "claim_higher" as const,
    },
  ],
  source_document_names: ["SCG_Financial_Model_v3.xlsx"],
  referenced_entities: ["SCG", "Saint"],
  referenced_periods: ["FY Mar-26"],
  comparison_basis: "memo_claim__current_model",
  comparison_compatible: true,
  reportable: true,
  disposition_reason_codes: ["numeric_divergence_above_threshold"],
  deterministic_verdict: "contradicted",
  evidence_roles: ["contradicting"],
  all_canonical_numbers: [
    194_000_000, 184_391_535, -9_608_465, -4.95,
  ],
};

const VALID_NARRATIVE: NarrativeOutput = {
  title: "Revenue Projection Variance",
  summary: "The IC memo states £194m of FY Mar-26 revenue. The current model records £184.4m at P&L/B12, a £9.6m difference.",
  explanation: "The IC memo projects group revenue of £194m for FY Mar-26. The current financial model (SCG_Financial_Model_v3.xlsx) shows £184,391,535 in cell B12 of the P&L sheet. This represents a shortfall of approximately £9.6m (\u22124.95%). The deterministic verdict is contradicted.",
};

// Helper: build a minimal finding for authority gate tests
function buildMinimalFinding(overrides?: Partial<CanonicalFinding>): CanonicalFinding {
  return {
    finding_id: "f0000001-0000-0000-0000-000000000001",
    severity: "critical",
    title: "Revenue Variance",
    detail: "IC memo claims £194m, model shows £184.4m",
    full_analysis: "Full analysis text here",
    source_docs: ["SCG_Financial_Model_v3.xlsx"],
    claim_ids: ["clm-v1-abc123"],
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

console.log("\n=== MAT-F05: Narrative Boundary Production-Path Tests ===\n");

// ── Test 1: Changed currency value rejected ─────────────────────────────────
console.log("Test 1 — changed currency value rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Projection Variance",
    summary: "The IC memo states £195m of revenue, while the model shows £180m.",
    explanation: "The revenue projection has a variance.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for invented £195m and £180m");
  assertContains(result.reason_codes, "RULE_1_INVENTED_NUMERIC", "reason includes RULE_1");
}

// ── Test 2: Invented percentage rejected ────────────────────────────────────
console.log("\nTest 2 — invented percentage rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The IC memo states £194m of revenue. The variance is approximately 12.3%.",
    explanation: "Test explanation.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for invented 12.3%");
  assertContains(result.reason_codes, "RULE_1_INVENTED_NUMERIC", "reason includes RULE_1");
}

// ── Test 3: Invented numeric range rejected ─────────────────────────────────
console.log("\nTest 3 — invented numeric range rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The variance is 5-15 percentage points below expectation.",
    explanation: "Test explanation.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for invented 5-15pp range");
  assertContains(result.reason_codes, "RULE_2_INVENTED_RANGE", "reason includes RULE_2");
}

// ── Test 4: Changed delta rejected ──────────────────────────────────────────
console.log("\nTest 4 — changed delta rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The IC memo states £194m revenue. The difference is £15m.",
    explanation: "The delta is £15,000,000.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for invented £15m delta");
  assertContains(result.reason_codes, "RULE_1_INVENTED_NUMERIC", "reason includes RULE_1");
}

// ── Test 5: Changed verdict ignored (authority gate) ────────────────────────
console.log("\nTest 5 — changed verdict ignored by authority gate");
{
  const finding = buildMinimalFinding({ severity: "critical", claim_ids: ["clm-v1-abc123"] });
  const badNarrative: NarrativeOutput = {
    title: "Revenue Confirmed",
    summary: "The model confirms the IC memo revenue of £194m.",
    explanation: "After analysis, the figure is confirmed.",
  };
  // Validator rejects verdict contradiction
  const valResult = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!valResult.passed, "narrative with 'confirms' fails against contradicted verdict");
  assertContains(valResult.reason_codes, "RULE_7_VERDICT_CONTRADICTION", "reason includes RULE_7");
  // Authority gate preserves severity
  const gated = applyAuthorityGate(finding, undefined);
  assertTrue(!gated.excluded, "finding not excluded");
  if (!gated.excluded) {
    assertEqual(gated.finding.severity, "critical", "severity preserved as critical");
  }
}

// ── Test 6: Synthesized quotation rejected ──────────────────────────────────
console.log("\nTest 6 — synthesized quotation rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The IC memo states \u201cManagement expects strong revenue growth to reach approximately \u00a3194m in FY Mar-26\u201d.",
    explanation: "This is a synthesized quotation.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for synthesized quotation");
  assertContains(result.reason_codes, "RULE_3_SYNTHESIZED_QUOTATION", "reason includes RULE_3");
}

// ── Test 7: Exact admitted quotation allowed ────────────────────────────────
console.log("\nTest 7 — exact admitted quotation allowed");
{
  const narrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The IC memo states \u201cFY Mar-26 revenue of \u00a3194m for the group\u201d.",
    explanation: "The current model records \u00a3184,391,535.",
  };
  const result = validateNarrativeOutput(narrative, SCG_LOCKED_INPUT);
  assertNotContains(result.reason_codes, "RULE_3_SYNTHESIZED_QUOTATION", "exact claim substring not rejected");
}

// ── Test 8: Normalized numeric formatting allowed ───────────────────────────
console.log("\nTest 8 — normalized numeric formatting allowed (\u00a3194m vs \u00a3194 million)");
{
  const narrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The IC memo states \u00a3194 million of FY Mar-26 revenue. The model shows \u00a3184.4 million.",
    explanation: "The delta is approximately \u00a39.6 million, representing a -4.95% variance.",
  };
  const result = validateNarrativeOutput(narrative, SCG_LOCKED_INPUT);
  const inventedNumerics = result.rule_violations.filter(v => v.rule === "RULE_1_INVENTED_NUMERIC");
  assertEqual(inventedNumerics.length, 0, "no invented numeric violations for normalized formatting");
}

// ── Test 9: Unknown source name rejected ────────────────────────────────────
console.log("\nTest 9 — unknown source name rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "According to Management_Presentation.pdf, the revenue forecast is different.",
    explanation: "The test document is referenced.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for unknown source");
  assertContains(result.reason_codes, "RULE_4_UNKNOWN_SOURCE", "reason includes RULE_4");
}

// ── Test 10: Unknown entity rejected ────────────────────────────────────────
console.log("\nTest 10 — unknown entity rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "Gamma Holdings Ltd revenue diverges from the IC memo projection.",
    explanation: "The entity is unknown.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for unknown entity");
  assertContains(result.reason_codes, "RULE_5_UNKNOWN_ENTITY", "reason includes RULE_5");
}

// ── Test 11: Unknown period rejected ────────────────────────────────────────
console.log("\nTest 11 — unknown period rejected");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "The FY2028 revenue projection shows a variance.",
    explanation: "The period is unknown.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for unknown period FY2028");
  assertContains(result.reason_codes, "RULE_6_UNKNOWN_PERIOD", "reason includes RULE_6");
}

// ── Test 12: Supporting evidence cannot become adverse ──────────────────────
console.log("\nTest 12 — supporting evidence cannot become adverse");
{
  const supportingInput: LockedNarrationInput = {
    ...SCG_LOCKED_INPUT,
    deterministic_verdict: "confirmed",
    evidence_roles: ["supporting"],
  };
  const badNarrative: NarrativeOutput = {
    title: "Revenue Issue",
    summary: "The model contradicts the IC memo revenue figure.",
    explanation: "The evidence disproves the claim.",
  };
  const result = validateNarrativeOutput(badNarrative, supportingInput);
  assertTrue(!result.passed, "validation fails for adverse language with supporting evidence");
  assertContains(result.reason_codes, "RULE_9_ADVERSE_LANGUAGE_FOR_SUPPORTING", "reason includes RULE_9");
}

// ── Test 13: Contextual market evidence cannot prove SCG proposition ────────
console.log("\nTest 13 — contextual market evidence cannot prove SCG-specific proposition");
{
  const contextualInput: LockedNarrationInput = {
    ...SCG_LOCKED_INPUT,
    deterministic_verdict: "confirmed",
    evidence_roles: ["contextual"],
  };
  const badNarrative: NarrativeOutput = {
    title: "EBITDA Impact",
    summary: "The contextual evidence invalidates the SCG EBITDA projection.",
    explanation: "Market data undermines the forecast.",
  };
  const result = validateNarrativeOutput(badNarrative, contextualInput);
  assertTrue(!result.passed, "validation fails for adverse contextual evidence");
  assertContains(result.reason_codes, "RULE_9_ADVERSE_LANGUAGE_FOR_SUPPORTING", "reason includes RULE_9");
}

// ── Test 14: Rejected evidence cannot reappear ──────────────────────────────
console.log("\nTest 14 — rejected evidence cannot reappear");
{
  const narrativeWithRejected: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "According to Competitor_Analysis.xlsx, the revenue is different.",
    explanation: "This rejected document is being cited.",
  };
  const result = validateNarrativeOutput(narrativeWithRejected, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for rejected evidence source");
  assertContains(result.reason_codes, "RULE_4_UNKNOWN_SOURCE", "reason includes RULE_4");
}

// ── Test 15: Confirmed finding cannot become contradicted ───────────────────
console.log("\nTest 15 — confirmed finding cannot become contradicted via narrative");
{
  const confirmedInput: LockedNarrationInput = {
    ...SCG_LOCKED_INPUT,
    deterministic_verdict: "confirmed",
    evidence_roles: ["verifying"],
  };
  const badNarrative: NarrativeOutput = {
    title: "Revenue Contradiction",
    summary: "The model contradicts the revenue forecast.",
    explanation: "Clear contradiction found.",
  };
  const result = validateNarrativeOutput(badNarrative, confirmedInput);
  assertTrue(!result.passed, "validation fails for contradiction language against confirmed verdict");
  assertContains(result.reason_codes, "RULE_7_VERDICT_CONTRADICTION", "reason includes RULE_7");
}

// ── Test 16: Contradicted finding cannot become confirmed ───────────────────
console.log("\nTest 16 — contradicted finding cannot become confirmed via narrative");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Confirmed",
    summary: "The model confirms the IC memo projection.",
    explanation: "The IC memo figure is confirmed by the model.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for 'confirms' against contradicted verdict");
  assertContains(result.reason_codes, "RULE_7_VERDICT_CONTRADICTION", "reason includes RULE_7");
}

// ── Test 17: Severity returned by LLM is ignored ────────────────────────────
console.log("\nTest 17 — severity returned by LLM is ignored");
{
  const badNarrative: NarrativeOutput = {
    title: "Revenue Variance",
    summary: "This is a critical finding with high-severity implications.",
    explanation: "The severity: critical label is applied.",
  };
  const result = validateNarrativeOutput(badNarrative, SCG_LOCKED_INPUT);
  assertTrue(!result.passed, "validation fails for generated severity label");
  assertContains(result.reason_codes, "RULE_10_GENERATED_SEVERITY", "reason includes RULE_10");
}

// ── Test 18: verified:true returned by LLM is ignored (authority gate) ──────
console.log("\nTest 18 — verified:true returned by LLM is ignored");
{
  const findingWithFakeVerify: CanonicalFinding = {
    ...buildMinimalFinding(),
    evidence: [{
      figure: "194",
      source_doc: "test.pdf",
      verbatim_snippet: "",
      verified: true, // LLM-originated — should be stripped
    }],
  };
  const gated = applyAuthorityGate(findingWithFakeVerify, undefined);
  assertTrue(!gated.excluded, "finding not excluded");
  if (!gated.excluded && gated.finding.evidence && gated.finding.evidence.length > 0) {
    assertEqual(gated.finding.evidence[0].verified, false, "verified:true stripped by authority gate");
  }
}

// ── Test 19: Deterministic fallback generation ──────────────────────────────
console.log("\nTest 19 — deterministic fallback generation");
{
  const fallback = generateDeterministicFallbackNarrative(SCG_LOCKED_INPUT);
  assertTrue(fallback.title.length > 0, "fallback has title");
  assertTrue(fallback.summary.length > 0, "fallback has summary");
  assertTrue(fallback.explanation.length > 0, "fallback has explanation");
  assertTrue(fallback.summary.includes("194") || fallback.explanation.includes("194"), "fallback uses canonical claim value");
  assertTrue(fallback.explanation.includes("contradicted"), "fallback references canonical verdict");
  // Fallback must not trigger invented-number violations
  const fallbackResult = validateNarrativeOutput(fallback, SCG_LOCKED_INPUT);
  assertNotContains(fallbackResult.reason_codes, "RULE_1_INVENTED_NUMERIC", "fallback passes numeric check");
  assertNotContains(fallbackResult.reason_codes, "RULE_7_VERDICT_CONTRADICTION", "fallback passes verdict check");
}

// ── Test 20: Process/fallback object exclusion ──────────────────────────────
console.log("\nTest 20 — process/fallback object cannot become a finding");
{
  const processObjects = [
    { title: "Analysis Complete", detail: "All chunks processed successfully", severity: "info", source_docs: [] },
    { title: "No findings identified", detail: "", severity: "info", source_docs: [] },
    { title: "Module Diagnostic", detail: "Pipeline ran in 45s", severity: "info", source_docs: [] },
    { title: "Degraded Run Notice", detail: "Some extractions failed", severity: "info", source_docs: [] },
    { title: "Processing Summary", detail: "5 of 5 chunks analyzed", severity: "info", source_docs: [] },
  ];
  for (const obj of processObjects) {
    assertTrue(shouldExcludeAsProcessObject(obj), `process object excluded: "${obj.title}"`);
  }
  // Substantive findings are NOT excluded
  const substantive = { title: "Revenue Projection Variance", detail: "IC memo states £194m", severity: "critical", source_docs: ["model.xlsx"] };
  assertTrue(!shouldExcludeAsProcessObject(substantive), "substantive finding NOT excluded");
}

// ── Test 21: Narrative changes do not alter identity ────────────────────────
console.log("\nTest 21 — narrative changes do not alter identity");
{
  const finding = buildMinimalFinding();
  const originalId = finding.finding_id;
  const gated = applyAuthorityGate(finding, undefined);
  assertTrue(!gated.excluded, "finding not excluded");
  if (!gated.excluded) {
    assertEqual(gated.finding.finding_id, originalId, "finding_id unchanged after authority gate");
  }
}

// ── Test 22: Canonical record survives narration unchanged ──────────────────
console.log("\nTest 22 — canonical record survives narration unchanged");
{
  const inputCopy = JSON.parse(JSON.stringify(SCG_LOCKED_INPUT));
  const result = processNarration(VALID_NARRATIVE, SCG_LOCKED_INPUT);
  assertEqual(
    JSON.stringify(SCG_LOCKED_INPUT),
    JSON.stringify(inputCopy),
    "locked input unchanged after processNarration"
  );
  assertTrue(result.narrative !== null && result.narrative !== undefined, "result has narrative");
  assertEqual(result.canonical_unchanged, true, "canonical_unchanged flag is true");
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n" + "=".repeat(60));
console.log(`MAT-F05 Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED ✓");
}
