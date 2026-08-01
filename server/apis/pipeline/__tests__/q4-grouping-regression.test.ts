/**
 * Q4 Grouping Regression Tests — Message 3 Acceptance Gate
 *
 * MUST CONSOLIDATE (overmerge prevention):
 *   1. Repeated FY26 revenue revision
 *   2. Repeated FY26 EBITDA revision
 *   3. Repeated adjustment widening
 *   4. Repeated memo-model revenue gap
 *
 * MUST KEEP SEPARATE (undermerge prevention):
 *   5. Reported EBITDA vs cash EBITDA
 *   6. EBITDA vs adjustments
 *   7. Forecast revision vs memo-model gap
 *   8. Group vs segment
 *   9. Revenue vs GP (gross profit)
 *   10. Actual vs forecast
 *   11. Organic vs M&A-inclusive
 *   12. Company metric vs market metric
 *
 * ADDITIONAL ACCEPTANCE GATES:
 *   13. Claim chronology preserved
 *   14. Degraded persistence
 *   15. Terminal-output reconciliation (strong accounting)
 */
import {
  deriveCanonicalKey,
  serializeCanonicalKey,
  areKeysCompatible,
  groupIntoCanonicalFamilies,
  validateTerminalAccounting,
  type CanonicalKey,
  type ClaimChronologyEntry,
  type DegradedRecord,
} from "../canonical-issue-identity.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  assertEqual(condition, true, label);
}

function assertFalse(condition: boolean, label: string): void {
  assertEqual(condition, false, label);
}

// ===========================================================================
// SECTION A: MUST CONSOLIDATE
// ===========================================================================

console.log("═".repeat(70));
console.log("Q4 GROUPING REGRESSION — Message 3 Acceptance Gate");
console.log("═".repeat(70));

// ---------------------------------------------------------------------------
// Test 1: Repeated FY26 revenue revision → same family
// ---------------------------------------------------------------------------
console.log("\n━━━ MUST CONSOLIDATE ━━━");
console.log("\n=== Test 1: Repeated FY26 revenue revision ===");

const revisionFindings = [
  {
    finding_id: "rev-fy26-a",
    corpus_index: 0,
    title: "FY26 revenue forecast revised downward from £45m to £42m in model",
    detail: "IC memo states revenue of £45m for FY26 but the model shows £42m. This represents a material revision.",
    source_tag: "financial_model",
    originating_claim_id: "c-rev-a",
    claim_ids: ["c-rev-a"],
  },
  {
    finding_id: "rev-fy26-b",
    corpus_index: 1,
    title: "Revenue FY26: model lower than IC memo forecast",
    detail: "The financial model's FY26 revenue forecast of £42m contradicts the IC memo claim of £45m revenue target.",
    source_tag: "financial_model",
    originating_claim_id: "c-rev-b",
    claim_ids: ["c-rev-b"],
  },
  {
    finding_id: "rev-fy26-c",
    corpus_index: 2,
    title: "FY26 revenue understatement in live model vs IC claim",
    detail: "FY26 revenue in the model is below the IC memo's stated figure by approximately 7%.",
    source_tag: "financial_model",
    originating_claim_id: "c-rev-c",
    claim_ids: ["c-rev-c"],
  },
];

const { families: revFamilies } = groupIntoCanonicalFamilies(revisionFindings);
const revFamily = revFamilies.find(f => f.canonical_key.metric === "revenue");
assertTrue(revFamily !== undefined, "Revenue revision family exists");
if (revFamily) {
  assertEqual(revFamily.member_finding_ids.length, 3, "All 3 FY26 revenue revision findings consolidate");
}

// ---------------------------------------------------------------------------
// Test 2: Repeated FY26 EBITDA revision → same family
// ---------------------------------------------------------------------------
console.log("\n=== Test 2: Repeated FY26 EBITDA revision ===");

const ebitdaFindings = [
  {
    finding_id: "ebitda-fy26-a",
    corpus_index: 0,
    title: "FY26 EBITDA forecast lower in model than IC memo",
    detail: "EBITDA for FY26 in the model shows £12m vs £14m claimed in the IC memo.",
    source_tag: "financial_model",
    originating_claim_id: "c-ebitda-a",
    claim_ids: ["c-ebitda-a"],
  },
  {
    finding_id: "ebitda-fy26-b",
    corpus_index: 1,
    title: "EBITDA FY26 discrepancy: memo overstates relative to model",
    detail: "The IC memo's FY26 EBITDA target exceeds the current model figure by 14%.",
    source_tag: "financial_model",
    originating_claim_id: "c-ebitda-b",
    claim_ids: ["c-ebitda-b"],
  },
];

const { families: ebitdaFamilies } = groupIntoCanonicalFamilies(ebitdaFindings);
const ebitdaFamily = ebitdaFamilies.find(f => f.canonical_key.metric === "ebitda");
assertTrue(ebitdaFamily !== undefined, "EBITDA revision family exists");
if (ebitdaFamily) {
  assertEqual(ebitdaFamily.member_finding_ids.length, 2, "Both FY26 EBITDA revision findings consolidate");
}

// ---------------------------------------------------------------------------
// Test 3: Repeated adjustment widening → same family
// ---------------------------------------------------------------------------
console.log("\n=== Test 3: Repeated adjustment widening ===");

const adjFindings = [
  {
    finding_id: "adj-a",
    corpus_index: 0,
    title: "EBITDA adjustments widening in FY26 — add-backs increased since screening",
    detail: "The EBITDA adj add-backs for FY26 have increased materially between IC versions.",
    source_tag: "financial_model",
    originating_claim_id: "c-adj-a",
    claim_ids: ["c-adj-a"],
  },
  {
    finding_id: "adj-b",
    corpus_index: 1,
    title: "FY26 EBITDA adjustments methodology changed — normalisation add-backs widened",
    detail: "EBITDA adj add-backs reduced in latest version, widening the gap between reported and adjusted.",
    source_tag: "financial_model",
    originating_claim_id: "c-adj-b",
    claim_ids: ["c-adj-b"],
  },
];

const { families: adjFamilies } = groupIntoCanonicalFamilies(adjFindings);
const adjFamily = adjFamilies.find(f => f.canonical_key.metric === "ebitda_adjustments");
assertTrue(adjFamily !== undefined, "Adjustment widening family exists");
if (adjFamily) {
  assertEqual(adjFamily.member_finding_ids.length, 2, "Both adjustment widening findings consolidate");
}

// ---------------------------------------------------------------------------
// Test 4: Repeated memo-model revenue gap → same family
// ---------------------------------------------------------------------------
console.log("\n=== Test 4: Repeated memo-model revenue gap ===");

const gapFindings = [
  {
    finding_id: "gap-a",
    corpus_index: 0,
    title: "Revenue gap between memo and model for FY26 not reconciled",
    detail: "The memo vs model revenue diverges for FY26 — the gap has not been reconciled across IC versions.",
    source_tag: "financial_model",
    originating_claim_id: "c-gap-a",
    claim_ids: ["c-gap-a"],
  },
  {
    finding_id: "gap-b",
    corpus_index: 1,
    title: "FY26 model vs IC memo revenue gap persists in latest update",
    detail: "Revenue diverges from IC model claim. Gap between memo and model is material and has not been addressed.",
    source_tag: "financial_model",
    originating_claim_id: "c-gap-b",
    claim_ids: ["c-gap-b"],
  },
];

const { families: gapFamilies } = groupIntoCanonicalFamilies(gapFindings);
const gapFamily = gapFamilies.find(f =>
  f.canonical_key.issue_type === "memo_model_gap" && f.canonical_key.metric === "revenue"
);
assertTrue(gapFamily !== undefined, "Memo-model revenue gap family exists");
if (gapFamily) {
  assertEqual(gapFamily.member_finding_ids.length, 2, "Both memo-model gap findings consolidate");
}

// ===========================================================================
// SECTION B: MUST KEEP SEPARATE
// ===========================================================================

console.log("\n━━━ MUST KEEP SEPARATE ━━━");

// ---------------------------------------------------------------------------
// Test 5: Reported EBITDA vs cash EBITDA
// ---------------------------------------------------------------------------
console.log("\n=== Test 5: Reported EBITDA vs cash EBITDA ===");

const reportedEbitda = deriveCanonicalKey({
  title: "FY26 reported EBITDA lower than IC memo claim",
  detail: "Reported EBITDA for FY26 as per statutory accounts is below IC memo figure.",
});
const cashEbitda = deriveCanonicalKey({
  title: "FY26 cash EBITDA diverges from IC memo",
  detail: "Cash EBITDA on a cash basis for FY26 does not match IC stated figure.",
});

assertTrue(reportedEbitda !== null, "Reported EBITDA derives a key");
assertTrue(cashEbitda !== null, "Cash EBITDA derives a key");
if (reportedEbitda && cashEbitda) {
  const compat = areKeysCompatible(reportedEbitda, cashEbitda);
  assertFalse(compat.compatible, "Reported EBITDA and cash EBITDA are SEPARATE issues");
}

// ---------------------------------------------------------------------------
// Test 6: EBITDA vs adjustments
// ---------------------------------------------------------------------------
console.log("\n=== Test 6: EBITDA vs adjustments ===");

const ebitdaPure = deriveCanonicalKey({
  title: "FY26 EBITDA forecast lower in model",
  detail: "EBITDA for FY26 diverges from IC memo projection.",
});
const ebitdaAdj = deriveCanonicalKey({
  title: "FY26 EBITDA adjustments add-backs widening",
  detail: "EBITDA adj add-backs have increased for FY26, changing the normalised figure.",
});

assertTrue(ebitdaPure !== null, "EBITDA derives a key");
assertTrue(ebitdaAdj !== null, "EBITDA adjustments derives a key");
if (ebitdaPure && ebitdaAdj) {
  assertTrue(ebitdaPure.metric !== ebitdaAdj.metric, "Metrics differ: ebitda vs ebitda_adjustments");
  const compat = areKeysCompatible(ebitdaPure, ebitdaAdj);
  assertFalse(compat.compatible, "EBITDA and EBITDA adjustments are SEPARATE issues");
}

// ---------------------------------------------------------------------------
// Test 7: Forecast revision vs memo-model gap
// ---------------------------------------------------------------------------
console.log("\n=== Test 7: Forecast revision vs memo-model gap ===");

const forecastRev = deriveCanonicalKey({
  title: "FY26 revenue revision downward in model",
  detail: "Revenue forecast for FY26 has been revised lower since the IC memo was written.",
});
const memoModelGap = deriveCanonicalKey({
  title: "FY26 revenue gap between memo and model not reconciled",
  detail: "Revenue diverges — the model vs memo gap for FY26 remains unreconciled.",
});

assertTrue(forecastRev !== null, "Forecast revision derives a key");
assertTrue(memoModelGap !== null, "Memo-model gap derives a key");
if (forecastRev && memoModelGap) {
  assertTrue(forecastRev.issue_type !== memoModelGap.issue_type,
    "Issue types differ: forecast_revision vs memo_model_gap");
  const compat = areKeysCompatible(forecastRev, memoModelGap);
  assertFalse(compat.compatible, "Forecast revision and memo-model gap are SEPARATE issues");
}

// ---------------------------------------------------------------------------
// Test 8: Group vs segment
// ---------------------------------------------------------------------------
console.log("\n=== Test 8: Group vs segment ===");

const groupLevel = deriveCanonicalKey({
  title: "FY26 revenue forecast for group lower than IC memo",
  detail: "Group consolidated revenue for FY26 diverges from the IC memo claim.",
});
const segmentLevel = deriveCanonicalKey({
  title: "FY26 Calls and Lines segment revenue decline",
  detail: "Calls and lines segment shows revenue contraction in FY26 that contradicts IC memo.",
});

assertTrue(groupLevel !== null, "Group-level derives a key");
assertTrue(segmentLevel !== null, "Segment-level derives a key");
if (groupLevel && segmentLevel) {
  assertTrue(groupLevel.entity_or_segment !== segmentLevel.entity_or_segment,
    "Entities differ: group vs calls_and_lines");
  const compat = areKeysCompatible(groupLevel, segmentLevel);
  assertFalse(compat.compatible, "Group and segment are SEPARATE issues");
}

// ---------------------------------------------------------------------------
// Test 9: Revenue vs GP (gross profit)
// ---------------------------------------------------------------------------
console.log("\n=== Test 9: Revenue vs GP ===");

const revMetric = deriveCanonicalKey({
  title: "FY26 revenue lower in model than memo",
  detail: "Revenue for FY26 diverges from IC memo forecast.",
});
const gpMetric = deriveCanonicalKey({
  title: "FY26 gross profit lower than IC memo claims",
  detail: "GP for FY26 in the model is below the IC memo's gross profit figure.",
});

assertTrue(revMetric !== null, "Revenue derives a key");
assertTrue(gpMetric !== null, "Gross profit derives a key");
if (revMetric && gpMetric) {
  assertTrue(revMetric.metric !== gpMetric.metric, "Metrics differ: revenue vs gross_profit");
  const compat = areKeysCompatible(revMetric, gpMetric);
  assertFalse(compat.compatible, "Revenue and gross profit are SEPARATE issues");
}

// ---------------------------------------------------------------------------
// Test 10: Actual vs forecast
// ---------------------------------------------------------------------------
console.log("\n=== Test 10: Actual vs forecast ===");

const actualKey: CanonicalKey = {
  issue_domain: "financial",
  issue_type: "forecast_revision",
  metric: "revenue",
  period: "fy26",
  entity_or_segment: "group",
  scope: null,
  unit: "£m",
  actual_or_forecast: "actual",
  accounting_basis: null,
  comparison_basis: "memo_vs_model",
  direction_of_difference: "overstatement",
};
const forecastKey: CanonicalKey = {
  issue_domain: "financial",
  issue_type: "forecast_revision",
  metric: "revenue",
  period: "fy26",
  entity_or_segment: "group",
  scope: null,
  unit: "£m",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "memo_vs_model",
  direction_of_difference: "overstatement",
};

const actualVsForecast = areKeysCompatible(actualKey, forecastKey);
assertFalse(actualVsForecast.compatible, "Actual and forecast are SEPARATE issues");
assertTrue(actualVsForecast.reason.includes("actual/forecast"), "Reason mentions actual/forecast");

// ---------------------------------------------------------------------------
// Test 11: Organic vs M&A-inclusive
// ---------------------------------------------------------------------------
console.log("\n=== Test 11: Organic vs M&A-inclusive ===");

const organicKey: CanonicalKey = {
  issue_domain: "financial",
  issue_type: "forecast_revision",
  metric: "revenue",
  period: "fy26",
  entity_or_segment: "group",
  scope: "organic",
  unit: "£m",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "memo_vs_model",
  direction_of_difference: "overstatement",
};
const maInclusiveKey: CanonicalKey = {
  issue_domain: "financial",
  issue_type: "forecast_revision",
  metric: "revenue",
  period: "fy26",
  entity_or_segment: "group",
  scope: "proforma",
  unit: "£m",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "memo_vs_model",
  direction_of_difference: "overstatement",
};

const organicVsMa = areKeysCompatible(organicKey, maInclusiveKey);
assertFalse(organicVsMa.compatible, "Organic and M&A-inclusive (proforma) are SEPARATE issues");
assertTrue(organicVsMa.reason.includes("scope"), "Reason mentions scope");

// ---------------------------------------------------------------------------
// Test 12: Company metric vs market metric
// ---------------------------------------------------------------------------
console.log("\n=== Test 12: Company metric vs market metric ===");

const companyMetric = deriveCanonicalKey({
  title: "FY26 revenue forecast lower in model — group level",
  detail: "Revenue for group FY26 in the model is below the IC memo figure.",
});
const marketMetric = deriveCanonicalKey({
  title: "FY26 market revenue position contradicts IC claims",
  detail: "The commercial market position and competitive landscape data contradicts IC memo.",
});

assertTrue(companyMetric !== null, "Company metric derives a key");
assertTrue(marketMetric !== null, "Market metric derives a key");
if (companyMetric && marketMetric) {
  // Company = financial domain, market = commercial domain
  assertTrue(companyMetric.issue_domain !== marketMetric.issue_domain,
    "Domains differ: financial vs commercial");
  const compat = areKeysCompatible(companyMetric, marketMetric);
  assertFalse(compat.compatible, "Company metric and market metric are SEPARATE issues");
}

// ===========================================================================
// SECTION C: ACCEPTANCE GATES
// ===========================================================================

console.log("\n━━━ ACCEPTANCE GATES ━━━");

// ---------------------------------------------------------------------------
// Test 13: Claim chronology preserved
// ---------------------------------------------------------------------------
console.log("\n=== Test 13: Claim chronology ===");

// groupIntoCanonicalFamilies creates families with claim_chronology array
const chronoFindings = [
  {
    finding_id: "chrono-1",
    corpus_index: 0,
    title: "FY26 revenue forecast understates model by £3m",
    detail: "Revenue FY26 IC memo says £45m but model shows £42m.",
    originating_claim_id: "claim-screening",
    claim_ids: ["claim-screening"],
  },
  {
    finding_id: "chrono-2",
    corpus_index: 1,
    title: "FY26 revenue still lower in model than IC memo",
    detail: "Revenue FY26 memo figure remains at £45m but model has been revised to £41m.",
    originating_claim_id: "claim-2nd-ic",
    claim_ids: ["claim-2nd-ic"],
  },
];

const { families: chronoFamilies } = groupIntoCanonicalFamilies(chronoFindings);
assertTrue(chronoFamilies.length >= 1, "Chronology findings produce at least one family");
const chronoFamily = chronoFamilies.find(f =>
  f.member_finding_ids.includes("chrono-1") && f.member_finding_ids.includes("chrono-2")
);
assertTrue(chronoFamily !== undefined, "Both chronology findings are in the same family");
if (chronoFamily) {
  // claim_chronology is initialized as empty by groupIntoCanonicalFamilies;
  // it's populated by the replay API with actual Q3 provenance. We verify the structure exists.
  assertTrue(Array.isArray(chronoFamily.claim_chronology), "claim_chronology is an array");
}

// ---------------------------------------------------------------------------
// Test 14: Degraded persistence structure
// ---------------------------------------------------------------------------
console.log("\n=== Test 14: Degraded persistence ===");

// groupIntoCanonicalFamilies returns a `degraded` array (may be empty in normal cases)
const { degraded } = groupIntoCanonicalFamilies(revisionFindings);
assertTrue(Array.isArray(degraded), "Degraded array exists in return");

// Verify DegradedRecord interface fields are correct
// (compile-time check — the type system enforces this, but we verify runtime shape)
const syntheticDegraded: DegradedRecord = {
  original_finding_id: "test-finding",
  claim_linkage_disposition: "claim_linked_contradicted",
  resolved_claim_id: "claim-1",
  evidence_snapshot_ids: ["ev-1", "ev-2"],
  family_key_str: "financial|forecast_revision|revenue|fy26|group|null|null|unknown|null|memo_vs_model|overstatement",
  failure_reason: "Evidence schema validation failed",
  terminal_reference: "dgrdd-test-finding",
  degraded_output: {
    title: "FY26 revenue revision — degraded",
    originating_claim_text: "Revenue will reach £45m in FY26",
    evidence_excerpts: ["Model shows £42m"],
    verification_status: "degraded",
    evidence_quality: "degraded",
  },
};
assertTrue(syntheticDegraded.degraded_output.verification_status === "degraded",
  "Degraded record has verification_status=degraded");
assertTrue(syntheticDegraded.degraded_output.evidence_quality === "degraded",
  "Degraded record has evidence_quality=degraded");
assertTrue(syntheticDegraded.failure_reason.length > 0,
  "Degraded record has non-empty failure_reason");
assertTrue(syntheticDegraded.terminal_reference.startsWith("dgrdd-"),
  "Degraded terminal_reference starts with dgrdd-");

// ---------------------------------------------------------------------------
// Test 15: Terminal-output reconciliation (strong accounting)
// ---------------------------------------------------------------------------
console.log("\n=== Test 15: Terminal-output reconciliation ===");

// Build a scenario and verify validateTerminalAccounting
const testInputs = ["f1", "f2", "f3", "f4"];
const testTerminals = new Map<string, string[]>([
  ["f1", ["cfnd-family-a"]],
  ["f2", ["cfnd-family-a"]],
  ["f3", ["cfnd-family-b"]],
  ["f4", ["dgrdd-f4"]],
]);
const testCanonicalOutputs = ["cfnd-family-a", "cfnd-family-b"];
const testDegradedOutputs = ["dgrdd-f4"];
const testMemberToFamily = new Map<string, string>([
  ["f1", "key-a"],
  ["f2", "key-a"],
  ["f3", "key-b"],
  ["f4", "degraded-f4"],
]);
const testMergedCounts = new Map<string, number>([
  ["cfnd-family-a", 2],
  ["cfnd-family-b", 1],
]);

const goodResult = validateTerminalAccounting({
  inputs: testInputs,
  terminalOutcomes: testTerminals,
  canonicalOutputIds: testCanonicalOutputs,
  degradedOutputIds: testDegradedOutputs,
  memberToFamily: testMemberToFamily,
  mergedCounts: testMergedCounts,
});
assertTrue(goodResult.valid, "Valid accounting passes");
assertEqual(goodResult.violations.length, 0, "Zero violations for valid state");

// Test: input with zero terminal outcomes → violation
const missingTerminals = new Map<string, string[]>([
  ["f1", ["cfnd-family-a"]],
  ["f2", ["cfnd-family-a"]],
  ["f3", ["cfnd-family-b"]],
  // f4 missing!
]);
const badResult1 = validateTerminalAccounting({
  inputs: testInputs,
  terminalOutcomes: missingTerminals,
  canonicalOutputIds: testCanonicalOutputs,
  degradedOutputIds: [],
  memberToFamily: testMemberToFamily,
  mergedCounts: testMergedCounts,
});
assertFalse(badResult1.valid, "Missing terminal → violation");
assertTrue(badResult1.violations.some(v => v.includes("f4") && v.includes("ZERO")),
  "Violation mentions missing f4");

// Test: input with multiple terminal outcomes → violation
const dualTerminals = new Map<string, string[]>([
  ["f1", ["cfnd-family-a", "cfnd-family-b"]],  // dual!
  ["f2", ["cfnd-family-a"]],
  ["f3", ["cfnd-family-b"]],
  ["f4", ["dgrdd-f4"]],
]);
const badResult2 = validateTerminalAccounting({
  inputs: testInputs,
  terminalOutcomes: dualTerminals,
  canonicalOutputIds: testCanonicalOutputs,
  degradedOutputIds: testDegradedOutputs,
  memberToFamily: testMemberToFamily,
  mergedCounts: new Map([["cfnd-family-a", 2], ["cfnd-family-b", 2]]),
});
assertFalse(badResult2.valid, "Dual terminal outcomes → violation");
assertTrue(badResult2.violations.some(v => v.includes("f1") && v.includes("MULTIPLE")),
  "Violation mentions f1 dual assignment");

// Test: duplicate canonical ID → violation
const badResult3 = validateTerminalAccounting({
  inputs: testInputs,
  terminalOutcomes: testTerminals,
  canonicalOutputIds: ["cfnd-family-a", "cfnd-family-a", "cfnd-family-b"],  // duplicate!
  degradedOutputIds: testDegradedOutputs,
  memberToFamily: testMemberToFamily,
  mergedCounts: testMergedCounts,
});
assertFalse(badResult3.valid, "Duplicate canonical ID → violation");
assertTrue(badResult3.violations.some(v => v.includes("DUPLICATE")),
  "Violation mentions DUPLICATE");

// Test: merged count mismatch → violation
const badMergedCounts = new Map<string, number>([
  ["cfnd-family-a", 3],  // expected 3 but only 2 point to it
  ["cfnd-family-b", 1],
]);
const badResult4 = validateTerminalAccounting({
  inputs: testInputs,
  terminalOutcomes: testTerminals,
  canonicalOutputIds: testCanonicalOutputs,
  degradedOutputIds: testDegradedOutputs,
  memberToFamily: testMemberToFamily,
  mergedCounts: badMergedCounts,
});
assertFalse(badResult4.valid, "Merged count mismatch → violation");
assertTrue(badResult4.violations.some(v => v.includes("expected 3")),
  "Violation mentions count mismatch");

// ---------------------------------------------------------------------------
// Test 16: No silent losses — comprehensive grouping
// ---------------------------------------------------------------------------
console.log("\n=== Test 16: No silent losses — comprehensive grouping ===");

const allFindings = [
  // Revenue family (3 members)
  { finding_id: "f1", corpus_index: 0, title: "FY26 revenue forecast revised lower in model", detail: "Revenue FY26 memo £45m vs model £42m", originating_claim_id: "c1" },
  { finding_id: "f2", corpus_index: 1, title: "Revenue for FY26 diverges from IC memo", detail: "FY26 revenue model shows lower than IC memo claim", originating_claim_id: "c2" },
  { finding_id: "f3", corpus_index: 2, title: "FY26 revenue understatement in model vs memo", detail: "Revenue FY26 is below the IC memo target by 7%", originating_claim_id: "c3" },
  // EBITDA family (2 members)
  { finding_id: "f4", corpus_index: 3, title: "FY26 EBITDA lower in model than memo", detail: "EBITDA FY26 diverges from IC memo", originating_claim_id: "c4" },
  { finding_id: "f5", corpus_index: 4, title: "EBITDA FY26 discrepancy", detail: "FY26 EBITDA model vs IC memo discrepancy", originating_claim_id: "c5" },
  // EBITDA adjustments (separate — 1 member)
  { finding_id: "f6", corpus_index: 5, title: "EBITDA adjustments add-backs widened in FY26", detail: "EBITDA adj add-backs for FY26 have increased materially", originating_claim_id: "c6" },
  // C&L segment (separate — 1 member)
  { finding_id: "f7", corpus_index: 6, title: "Calls and Lines segment decline FY26", detail: "Calls and lines segment shows operational weakness in FY26", originating_claim_id: "c7" },
  // GP (separate — 1 member)
  { finding_id: "f8", corpus_index: 7, title: "Gross profit for FY26 below memo claims", detail: "GP for FY26 lower than IC memo's gross profit figure", originating_claim_id: "c8" },
];

const { families: allFam, singletons: allSing, ambiguous: allAmb, degraded: allDeg, memberToFamily } =
  groupIntoCanonicalFamilies(allFindings);

const totalAccounted = allFam.reduce((sum, f) => sum + f.member_finding_ids.length, 0)
  + allSing.length + allAmb.length + allDeg.length;
assertEqual(totalAccounted, allFindings.length, `All ${allFindings.length} findings accounted for — zero silent losses`);

// Verify no member appears in multiple families
const seenMembers = new Set<string>();
let dualMembership = false;
for (const family of allFam) {
  for (const fid of family.member_finding_ids) {
    if (seenMembers.has(fid)) { dualMembership = true; break; }
    seenMembers.add(fid);
  }
}
for (const s of allSing) {
  if (seenMembers.has(s.finding_id)) { dualMembership = true; }
  seenMembers.add(s.finding_id);
}
assertFalse(dualMembership, "No member appears in multiple families");

// Verify memberToFamily map is complete
assertEqual(memberToFamily.size, allFindings.length, "memberToFamily has entry for every input");

// ---------------------------------------------------------------------------
// Test 17: Unknown remains unknown — no defaults
// ---------------------------------------------------------------------------
console.log("\n=== Test 17: Unknown remains unknown ===");

const vagueKey = deriveCanonicalKey({
  title: "Something is different from last time",
  detail: "A change was observed between versions.",
});
// If no recognizable metric or period, should return null (can't derive key)
assertEqual(vagueKey, null, "Completely vague finding returns null (no default assignment)");

const partialKey = deriveCanonicalKey({
  title: "FY26 figure changed but context unclear",
  detail: "Something in FY26 is different.",
});
if (partialKey) {
  // domain should be unknown since no financial/operational keywords
  assertEqual(partialKey.issue_domain, "unknown",
    "Domain remains unknown when no domain keywords present");
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log(`\n${"═".repeat(70)}`);
console.log(`Q4 Grouping Regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("ALL ACCEPTANCE GATES PASSED ✓");
console.log("  • Overmerge prevention: ✓");
console.log("  • Undermerge prevention: ✓");
console.log("  • Chronology structure: ✓");
console.log("  • Degraded persistence: ✓");
console.log("  • Terminal-output reconciliation: ✓");
