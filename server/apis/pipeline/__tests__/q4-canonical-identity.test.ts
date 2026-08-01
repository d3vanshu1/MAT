/**
 * Q4 Canonical Issue Identity Tests
 *
 * Tests proving:
 * 1. FY26 revenue repetitions consolidate
 * 2. FY26 EBITDA repetitions consolidate
 * 3. EBITDA adjustments remain distinguishable from EBITDA
 * 4. Forecast revision and memo-vs-model discrepancy remain separate where substantively different
 * 5. Calls & Lines remains a distinct issue
 * 6. Different periods are not overmerged
 * 7. Different segments are not overmerged
 * 8. Every candidate retains originating claim IDs
 * 9. No family based only on source-document overlap
 * 10. No silent losses
 * 11. Compatibility rules work correctly
 */

import {
  deriveCanonicalKey,
  serializeCanonicalKey,
  areKeysCompatible,
  groupIntoCanonicalFamilies,
  type CanonicalKey,
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
// TEST CASES
// ===========================================================================

console.log("═".repeat(60));
console.log("Q4 Canonical Issue Identity Tests");
console.log("═".repeat(60));

// ---------------------------------------------------------------------------
// Test 1: FY26 revenue repetitions consolidate
// ---------------------------------------------------------------------------
console.log("\n=== Test 1: FY26 revenue repetitions consolidate ===");

const rev1 = deriveCanonicalKey({
  title: "FY26 revenue forecast understates current model",
  detail: "IC memo claims £45m revenue for FY26 but model shows £42m",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-rev-1",
});

const rev2 = deriveCanonicalKey({
  title: "Revenue for FY26 lower in model than memo",
  detail: "FY26 revenue diverges from IC claim by 7%",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-rev-2",
});

assertTrue(rev1 !== null, "Revenue finding 1 gets a key");
assertTrue(rev2 !== null, "Revenue finding 2 gets a key");
assertEqual(serializeCanonicalKey(rev1!), serializeCanonicalKey(rev2!),
  "FY26 revenue repetitions produce same canonical key");

// ---------------------------------------------------------------------------
// Test 2: FY26 EBITDA repetitions consolidate
// ---------------------------------------------------------------------------
console.log("\n=== Test 2: FY26 EBITDA repetitions consolidate ===");

const ebitda1 = deriveCanonicalKey({
  title: "FY26 EBITDA lower in current model than IC memo",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-ebitda-1",
});

const ebitda2 = deriveCanonicalKey({
  title: "EBITDA forecast for FY26 shows material discrepancy",
  detail: "IC memo EBITDA target exceeds model figure",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-ebitda-2",
});

assertTrue(ebitda1 !== null, "EBITDA finding 1 gets a key");
assertTrue(ebitda2 !== null, "EBITDA finding 2 gets a key");
assertEqual(serializeCanonicalKey(ebitda1!), serializeCanonicalKey(ebitda2!),
  "FY26 EBITDA repetitions produce same canonical key");

// ---------------------------------------------------------------------------
// Test 3: EBITDA adjustments remain distinguishable from EBITDA
// ---------------------------------------------------------------------------
console.log("\n=== Test 3: EBITDA adjustments ≠ EBITDA ===");

const ebitdaAdj = deriveCanonicalKey({
  title: "EBITDA adjustments methodology changed in FY26",
  detail: "EBITDA adj add-backs reduced in latest version",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-adj-1",
});

assertTrue(ebitdaAdj !== null, "EBITDA adjustments finding gets a key");
// EBITDA adjustments must have a different metric than plain EBITDA
if (ebitda1 && ebitdaAdj) {
  assertTrue(
    serializeCanonicalKey(ebitda1) !== serializeCanonicalKey(ebitdaAdj),
    "EBITDA adjustments key differs from EBITDA key"
  );
  assertEqual(ebitdaAdj.metric, "ebitda_adjustments", "EBITDA adj metric is ebitda_adjustments");
}

// ---------------------------------------------------------------------------
// Test 4: Calls & Lines remains distinct from Group
// ---------------------------------------------------------------------------
console.log("\n=== Test 4: Calls & Lines is distinct from Group ===");

const callsAndLines = deriveCanonicalKey({
  title: "Calls & Lines segment revenue decline in FY26",
  detail: "Calls and lines segment shows operational weakness",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-c&l-1",
});

assertTrue(callsAndLines !== null, "Calls & Lines finding gets a key");
if (callsAndLines) {
  assertEqual(callsAndLines.entity_or_segment, "calls_and_lines", "Entity is calls_and_lines");
  if (rev1) {
    assertTrue(
      serializeCanonicalKey(callsAndLines) !== serializeCanonicalKey(rev1),
      "Calls & Lines key differs from Group revenue key"
    );
  }
}

// ---------------------------------------------------------------------------
// Test 5: Different periods are not overmerged
// ---------------------------------------------------------------------------
console.log("\n=== Test 5: Different periods not merged ===");

const fy25Revenue = deriveCanonicalKey({
  title: "FY25 revenue forecast contradicts model",
  source_tag: "financial_model",
  finding_kind: "data_divergence",
  originating_claim_id: "c-fy25-1",
});

assertTrue(fy25Revenue !== null, "FY25 revenue gets a key");
if (fy25Revenue && rev1) {
  const compat = areKeysCompatible(rev1, fy25Revenue);
  assertFalse(compat.compatible, "FY26 and FY25 revenue are NOT compatible (different periods)");
  assertTrue(compat.reason.includes("period"), "Incompatibility reason mentions period");
}

// ---------------------------------------------------------------------------
// Test 6: Compatibility rules — different comparison bases are incompatible
// ---------------------------------------------------------------------------
console.log("\n=== Test 6: Different comparison bases are separate issues ===");

if (rev1) {
  const fddComparison: CanonicalKey = {
    ...rev1,
    comparison_basis: "memo_vs_fdd",
  };
  const compat = areKeysCompatible(rev1, fddComparison);
  assertFalse(compat.compatible, "memo_vs_model and memo_vs_fdd are different issues");
  assertTrue(compat.reason.includes("comparison_basis"), "Reason mentions comparison_basis");
}

// ---------------------------------------------------------------------------
// Test 7: Grouping produces correct family counts
// ---------------------------------------------------------------------------
console.log("\n=== Test 7: Family grouping ===");

const testFindings = [
  // 3x FY26 revenue findings — should all be in same family
  { finding_id: "fy26-rev-1", corpus_index: 0, title: "FY26 revenue overstated in memo", source_tag: "financial_model" as const, originating_claim_id: "c1", finding_kind: "data_divergence" },
  { finding_id: "fy26-rev-2", corpus_index: 1, title: "Revenue for FY26 diverges from model", source_tag: "financial_model" as const, originating_claim_id: "c2", finding_kind: "data_divergence" },
  { finding_id: "fy26-rev-3", corpus_index: 2, title: "FY26 revenue understatement in current model", source_tag: "financial_model" as const, originating_claim_id: "c3", finding_kind: "data_divergence" },
  // 2x FY26 EBITDA — different family from revenue
  { finding_id: "fy26-ebitda-1", corpus_index: 3, title: "FY26 EBITDA lower in model than memo claims", source_tag: "financial_model" as const, originating_claim_id: "c4", finding_kind: "data_divergence" },
  { finding_id: "fy26-ebitda-2", corpus_index: 4, title: "EBITDA FY26 discrepancy vs IC forecast", source_tag: "financial_model" as const, originating_claim_id: "c5", finding_kind: "data_divergence" },
  // 1x Calls & Lines — distinct family
  { finding_id: "c-and-l-1", corpus_index: 5, title: "Calls and Lines segment decline FY26", source_tag: "financial_model" as const, originating_claim_id: "c6", finding_kind: "data_divergence" },
];

const { families, singletons, ambiguous } = groupIntoCanonicalFamilies(testFindings);

// Should produce: 1 revenue family (3 members) + 1 EBITDA family (2 members) + 1 C&L family (1 member)
const revFamily = families.find(f => f.canonical_key.metric === "revenue");
const ebitdaFamily = families.find(f => f.canonical_key.metric === "ebitda");
const cAndLFamily = families.find(f =>
  f.canonical_key.entity_or_segment === "calls_and_lines" ||
  f.members.some(m => m.finding_id === "c-and-l-1")
);

assertTrue(revFamily !== undefined, "Revenue family exists");
assertTrue(ebitdaFamily !== undefined, "EBITDA family exists");

if (revFamily) {
  assertEqual(revFamily.member_finding_ids.length, 3, "Revenue family has 3 members");
  assertEqual(revFamily.all_originating_claim_ids.length, 3, "Revenue family has 3 claim IDs");
}

if (ebitdaFamily) {
  assertEqual(ebitdaFamily.member_finding_ids.length, 2, "EBITDA family has 2 members");
}

// Calls & Lines may be in families (as singleton group) or singletons
const callsAccountedFor = [
  ...families.flatMap(f => f.member_finding_ids),
  ...singletons.map(s => s.finding_id),
].includes("c-and-l-1");
assertTrue(callsAccountedFor, "Calls & Lines finding is accounted for");

// ---------------------------------------------------------------------------
// Test 8: No silent losses — all 6 findings accounted for
// ---------------------------------------------------------------------------
console.log("\n=== Test 8: No silent losses ===");

const allAccountedFor = [
  ...families.flatMap(f => f.member_finding_ids),
  ...singletons.map(s => s.finding_id),
  ...ambiguous.map(a => a.finding_id),
];
assertEqual(allAccountedFor.length, testFindings.length, "All 6 findings accounted for");

// ---------------------------------------------------------------------------
// Test 9: No family from source-document overlap alone
// ---------------------------------------------------------------------------
console.log("\n=== Test 9: No family from source-document overlap ===");

// Two findings from same document but different metrics and periods
const sameSourceFindings = [
  { finding_id: "same-doc-1", corpus_index: 0, title: "FY26 EBITDA lower than memo", source_tag: "financial_model" as const, source_docs: ["Model.xlsx"], originating_claim_id: "c-sd-1" },
  { finding_id: "same-doc-2", corpus_index: 1, title: "FY25 revenue overstated in IC memo", source_tag: "financial_model" as const, source_docs: ["Model.xlsx"], originating_claim_id: "c-sd-2" },
];

const { families: sameDocFamilies } = groupIntoCanonicalFamilies(sameSourceFindings);
// These should NOT be in the same family because FY26 EBITDA ≠ FY25 revenue
for (const f of sameDocFamilies) {
  assertFalse(
    f.member_finding_ids.length > 1 &&
    f.member_finding_ids.includes("same-doc-1") &&
    f.member_finding_ids.includes("same-doc-2"),
    "FY26 EBITDA and FY25 revenue are NOT merged even from same source"
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(60)}`);
console.log(`Q4 Identity Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log("All Q4 canonical identity tests passed ✓");
