/**
 * EM-3 Engagement Map Absence Gate — Unit tests.
 *
 * Tests applyEngagementAbsenceGate with stubbed buildEngagementMap + matchAbsenceFindings.
 * Run via: npx tsx server/apis/pipeline/__tests__/engagement-gate.test.ts
 *
 * Fixture A (demote): absence finding, matcher returns decision A → moved to housekeeping
 * Fixture B (omission): matcher returns C → RETAINED, "memo_absent_confirmed"
 * Fixture C (thesis drift): matcher returns B → RETAINED, "thesis_drift", note with earlier memo
 * Fixture D (flag): matcher returns D → RETAINED, "memo_disclosure_uncertain"
 * Fixture E (no map): buildEngagementMap returns empty → NOTHING demoted, all retained
 * Fixture F (unprocessed): time-budget cutoff → absence finding RETAINED as flag
 * Fixture G (non-absence): legal finding → untouched, "not_applicable"
 */

import { applyEngagementAbsenceGate } from "../pipeline-core.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// We need to mock the engagement-map and absence-map-matcher modules.
// Since we can't easily mock ESM imports in a simple test runner, we'll
// test the function by passing pre-configured stubs via a different approach:
// We'll mock at the module level using dynamic import interception.
//
// APPROACH: Since applyEngagementAbsenceGate internally calls buildEngagementMap
// and matchAbsenceFindings as direct imports, we need to mock those modules.
// We'll use a module-level mock approach compatible with tsx.

type MergedFinding = CanonicalFinding;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string) {
  assert(actual === expected, `${message} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
}

function assertIncludes(str: string, substring: string, message: string) {
  assert(str.includes(substring), `${message} (expected "${str.slice(0, 200)}" to include "${substring}")`);
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function baseFinding(overrides: Partial<MergedFinding>): MergedFinding {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    finding_id: "f-" + Math.random().toString(36).slice(2, 8),
    title: "Test Finding",
    detail: "Detail text",
    severity: "warning",
    source_chunks: [],
    source_docs: [],
    ...overrides,
  } as MergedFinding;
}

// Stubbed queryFn — never actually called because we mock buildEngagementMap
const stubQueryFn = async (_sql: string, _schema: any, _params: unknown[], _meta?: { label: string }) => {
  return [];
};

// Stubbed aiFn — never actually called because we mock matchAbsenceFindings
const stubAiFn = async (_req: any, _opts: any, _meta?: any) => {
  return { content: [{ type: "text", text: "{}" }] };
};

// ---------------------------------------------------------------------------
// Module mocking via global injection
// ---------------------------------------------------------------------------
// Since applyEngagementAbsenceGate imports buildEngagementMap and matchAbsenceFindings
// at the module level, we need to intercept those. The cleanest approach for these
// tests is to directly test the disposition-application logic by setting up controlled
// scenarios where we can predict what the internal functions will return.
//
// ALTERNATIVE: We re-implement the test at a higher level by mocking at the
// module boundary. For tsx without jest, we use Node's module hook or we
// restructure to test the disposition logic directly.
//
// CHOSEN APPROACH: We mock the modules using a loader hook in a separate file,
// OR we test with controlled inputs that make the real functions produce
// predictable outputs.
//
// SIMPLEST APPROACH: Since applyEngagementAbsenceGate calls the imported
// functions directly, and we can't easily mock them without jest, we'll
// create a thin wrapper test that patches the module namespace.

// We'll use a different strategy: create a mock version of the module that
// we can control via globals.
declare global {
  var __TEST_ENGAGEMENT_MAP_RESULT: any;
  var __TEST_MATCHER_RESULT: any;
}

// Since we cannot easily mock ESM imports in tsx, we'll test the logic by:
// 1. Verifying the function signature and module-check behavior directly
// 2. For the disposition logic, we create a standalone test helper

// ---------------------------------------------------------------------------
// TEST: Module check — non-checklist modules pass through
// ---------------------------------------------------------------------------
async function testFixtureG_NonChecklistModule() {
  console.log("\nFixture G: non-checklist module → pass-through");
  const finding = baseFinding({
    title: "Standard legal finding",
    detail: "A standard legal observation that is not absence-related.",
    finding_kind: "legal_risk",
  });

  // For a non-checklist module (e.g., "contradiction_check"), the gate should
  // be a no-op regardless of other inputs
  const result = await applyEngagementAbsenceGate(
    stubQueryFn, stubAiFn, "deal-123", [finding], [], "contradiction_check"
  );

  assertEq(result.survivingFindings.length, 1, "Finding retained in surviving");
  assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
  assertEq(result.demotedCount, 0, "Zero demotions");
  assertEq(result.flaggedCount, 0, "Zero flags");
  assertEq(result.thesisDriftCount, 0, "Zero thesis drift");
  assert(!(result.survivingFindings[0] as any).absence_verification, "No absence_verification field set");
}

// ---------------------------------------------------------------------------
// For fixtures A-F, we need to mock the imported modules.
// Strategy: Patch the engagement-map and absence-map-matcher modules at runtime.
// ---------------------------------------------------------------------------

// We'll use a dynamic import + module patching approach:
import * as engagementMapModule from "../engagement-map.js";
import * as absenceMatcherModule from "../absence-map-matcher.js";

// Helper to temporarily replace module exports
function mockBuildEngagementMap(mockFn: typeof engagementMapModule.buildEngagementMap) {
  const original = engagementMapModule.buildEngagementMap;
  (engagementMapModule as any).buildEngagementMap = mockFn;
  return () => { (engagementMapModule as any).buildEngagementMap = original; };
}

function mockMatchAbsenceFindings(mockFn: typeof absenceMatcherModule.matchAbsenceFindings) {
  const original = absenceMatcherModule.matchAbsenceFindings;
  (absenceMatcherModule as any).matchAbsenceFindings = mockFn;
  return () => { (absenceMatcherModule as any).matchAbsenceFindings = original; };
}

// ---------------------------------------------------------------------------
// Fixture A: Absence finding → decision A (DISCLOSED_LATEST) → DEMOTE
// ---------------------------------------------------------------------------
async function testFixtureA_Demote() {
  console.log("\nFixture A: absence finding, decision A → DEMOTE to housekeeping");

  const finding = baseFinding({
    finding_id: "f-nrr-001",
    title: "NRR Decline Not Disclosed",
    detail: "Net revenue retention dropped but is not discussed in IC memos.",
    finding_kind: "memo_gap",
  });
  (finding as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [
      { memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "NRR metrics", evidence: "NRR discussed at length" }] },
      { memo_file: "2nd IC Memo.pdf", memo_order: 2, engaged_topics: [{ topic: "NRR decline", evidence: "94.4% NRR addressed" }] },
    ],
    model_used: "claude-sonnet-4-6",
  }));

  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 2,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-nrr-001",
      title: "NRR Decline Not Disclosed",
      is_absence_claim: true,
      decision: "A" as const,
      disposition: "demote" as const,
      matched_topic: "NRR decline",
      matched_memos: [2],
      reason: "Latest memo substantively addresses NRR decline",
    }],
    summary: { absence_total: 1, demote: 1, surface_thesis_drift: 0, surface_omission: 0, flag: 0, not_applicable: 0 },
    partial: false,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 0, "Finding NOT in surviving (demoted)");
    assertEq(result.housekeepingFindings.length, 1, "Finding moved to housekeeping");
    assertEq(result.demotedCount, 1, "demotedCount = 1");
    const demoted = result.housekeepingFindings[0];
    assertEq((demoted as any).absence_verification, "contradicted_by_memo", "absence_verification = contradicted_by_memo");
    assertIncludes(demoted.materiality_rationale ?? "", "[CODE_ENFORCED:engagementGate]", "Materiality note contains gate tag");
    assertIncludes(demoted.materiality_rationale ?? "", "NRR decline", "Materiality note contains matched topic");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture B: Absence finding → decision C (NEVER_DISCLOSED) → surface_omission
// ---------------------------------------------------------------------------
async function testFixtureB_Omission() {
  console.log("\nFixture B: absence finding, decision C → RETAINED, memo_absent_confirmed");

  const finding = baseFinding({
    finding_id: "f-cap-table-001",
    title: "Cap Table Not Disclosed",
    detail: "No cap table analysis appears in the IC memos.",
    finding_kind: "memo_gap",
  });
  (finding as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [{ memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "Revenue growth", evidence: "Revenue discussed" }] }],
    model_used: "claude-sonnet-4-6",
  }));

  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 1,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-cap-table-001",
      title: "Cap Table Not Disclosed",
      is_absence_claim: true,
      decision: "C" as const,
      disposition: "surface_omission" as const,
      matched_topic: null,
      matched_memos: [],
      reason: "No memo engages with cap table analysis",
    }],
    summary: { absence_total: 1, demote: 0, surface_thesis_drift: 0, surface_omission: 1, flag: 0, not_applicable: 0 },
    partial: false,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 1, "Finding RETAINED in surviving");
    assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
    assertEq(result.demotedCount, 0, "demotedCount = 0");
    assertEq((result.survivingFindings[0] as any).absence_verification, "memo_absent_confirmed", "absence_verification = memo_absent_confirmed");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture C: Absence finding → decision B (DROPPED_FROM_LATEST) → thesis_drift
// ---------------------------------------------------------------------------
async function testFixtureC_ThesisDrift() {
  console.log("\nFixture C: absence finding, decision B → RETAINED, thesis_drift with note");

  const finding = baseFinding({
    finding_id: "f-churn-001",
    title: "Customer Churn Analysis Not Disclosed",
    detail: "Customer churn rates are not discussed in latest memo.",
    finding_kind: "memo_gap",
  });
  (finding as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [
      { memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "Customer churn", evidence: "Churn discussed in depth" }] },
      { memo_file: "2nd IC Memo.pdf", memo_order: 2, engaged_topics: [{ topic: "Revenue only", evidence: "Only revenue growth covered" }] },
    ],
    model_used: "claude-sonnet-4-6",
  }));

  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 2,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-churn-001",
      title: "Customer Churn Analysis Not Disclosed",
      is_absence_claim: true,
      decision: "B" as const,
      disposition: "surface_thesis_drift" as const,
      matched_topic: "Customer churn",
      matched_memos: [1],
      reason: "Churn discussed in memo 1 but absent from latest memo 2",
    }],
    summary: { absence_total: 1, demote: 0, surface_thesis_drift: 1, surface_omission: 0, flag: 0, not_applicable: 0 },
    partial: false,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 1, "Finding RETAINED in surviving");
    assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
    assertEq(result.thesisDriftCount, 1, "thesisDriftCount = 1");
    assertEq((result.survivingFindings[0] as any).absence_verification, "thesis_drift", "absence_verification = thesis_drift");
    assertIncludes(result.survivingFindings[0].detail ?? "", "[engagementGate:thesis_drift]", "Detail contains thesis_drift note");
    assertIncludes(result.survivingFindings[0].detail ?? "", "memo(s) 1", "Note references earlier memo order");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture D: Absence finding → decision D (UNSURE) → flag
// ---------------------------------------------------------------------------
async function testFixtureD_Flag() {
  console.log("\nFixture D: absence finding, decision D → RETAINED, memo_disclosure_uncertain");

  const finding = baseFinding({
    finding_id: "f-ambiguous-001",
    title: "Management Team Depth Not Disclosed",
    detail: "Depth of management bench is not confirmed in the IC memos.",
    finding_kind: "memo_gap",
  });
  (finding as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [{ memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "Management overview", evidence: "Brief overview of team" }] }],
    model_used: "claude-sonnet-4-6",
  }));

  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 1,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-ambiguous-001",
      title: "Management Team Depth Not Disclosed",
      is_absence_claim: true,
      decision: "D" as const,
      disposition: "flag" as const,
      matched_topic: "Management overview",
      matched_memos: [1],
      reason: "Memo discusses management but unclear if bench depth is covered",
    }],
    summary: { absence_total: 1, demote: 0, surface_thesis_drift: 0, surface_omission: 0, flag: 1, not_applicable: 0 },
    partial: false,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 1, "Finding RETAINED in surviving");
    assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
    assertEq(result.flaggedCount, 1, "flaggedCount = 1");
    assertEq((result.survivingFindings[0] as any).absence_verification, "memo_disclosure_uncertain", "absence_verification = memo_disclosure_uncertain");
    assertIncludes(result.survivingFindings[0].detail ?? "", "[engagementGate:uncertain]", "Detail contains uncertainty note");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture E: No map (build returns empty memos) → NOTHING demoted
// ---------------------------------------------------------------------------
async function testFixtureE_NoMap() {
  console.log("\nFixture E: empty engagement map → all findings retained, zero demotions");

  const finding = baseFinding({
    finding_id: "f-any-001",
    title: "Something Not Disclosed",
    detail: "Memo does not disclose this topic.",
    finding_kind: "memo_gap",
  });
  (finding as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [], // Empty — no memos found
    model_used: "claude-sonnet-4-6",
  }));

  // Matcher should never be called, but mock it as a safety net
  const restoreMatcher = mockMatchAbsenceFindings(async () => {
    throw new Error("Matcher should NOT be called when map is empty");
  });

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 1, "Finding RETAINED (no map = no demotion)");
    assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
    assertEq(result.demotedCount, 0, "demotedCount = 0");
    assertEq(result.flaggedCount, 0, "flaggedCount = 0");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture F: Partial result (time budget) → unprocessed absence findings flagged
// ---------------------------------------------------------------------------
async function testFixtureF_Unprocessed() {
  console.log("\nFixture F: partial matcher result → unprocessed absence finding RETAINED as flag");

  const finding1 = baseFinding({
    finding_id: "f-processed-001",
    title: "Topic A Not Disclosed",
    detail: "Topic A is not disclosed in the memo.",
    finding_kind: "memo_gap",
  });
  (finding1 as any).gap_type = "memo_omission";

  const finding2 = baseFinding({
    finding_id: "f-unprocessed-001",
    title: "Topic B Not Disclosed",
    detail: "Topic B is not disclosed in the memo.",
    finding_kind: "memo_gap",
  });
  (finding2 as any).gap_type = "memo_omission";

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [{ memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "Topic A", evidence: "Covered" }] }],
    model_used: "claude-sonnet-4-6",
  }));

  // Matcher returns partial=true, only first finding processed
  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 1,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-processed-001",
      title: "Topic A Not Disclosed",
      is_absence_claim: true,
      decision: "A" as const,
      disposition: "demote" as const,
      matched_topic: "Topic A",
      matched_memos: [1],
      reason: "Disclosed in memo 1",
    }],
    // finding2 is NOT in results — it was unprocessed due to time budget
    summary: { absence_total: 2, demote: 1, surface_thesis_drift: 0, surface_omission: 0, flag: 0, not_applicable: 0 },
    partial: true,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding1, finding2], [], "omission_audit"
    );

    // finding1 demoted, finding2 retained but flagged as unprocessed
    assertEq(result.demotedCount, 1, "demotedCount = 1 (finding1 demoted)");
    assertEq(result.survivingFindings.length, 1, "One finding surviving (unprocessed)");
    assertEq(result.housekeepingFindings.length, 1, "One in housekeeping (demoted)");
    // The unprocessed finding should be flagged
    const unprocessed = result.survivingFindings[0];
    assertEq((unprocessed as any).absence_verification, "memo_disclosure_uncertain", "Unprocessed → flagged as uncertain");
    assertIncludes(unprocessed.detail ?? "", "[engagementGate:unprocessed]", "Detail notes time budget exhaustion");
    assert(result.unprocessedCount >= 1, "unprocessedCount >= 1");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Fixture G (non-absence): legal finding → untouched
// ---------------------------------------------------------------------------
async function testFixtureG_NonAbsence() {
  console.log("\nFixture G: non-absence finding → untouched (not_applicable)");

  const finding = baseFinding({
    finding_id: "f-legal-001",
    title: "Change of Control Provision Missing",
    detail: "Standard change of control provision analysis.",
    finding_kind: "legal_risk",
  });

  const restoreMap = mockBuildEngagementMap(async () => ({
    deal_id: "deal-123",
    memos: [{ memo_file: "1st IC Memo.pdf", memo_order: 1, engaged_topics: [{ topic: "Legal risks", evidence: "Legal coverage" }] }],
    model_used: "claude-sonnet-4-6",
  }));

  const restoreMatcher = mockMatchAbsenceFindings(async () => ({
    deal_id: "deal-123",
    run_id: "gate",
    latest_full_memo_order: 1,
    model_used: "claude-sonnet-4-6",
    results: [{
      finding_id: "f-legal-001",
      title: "Change of Control Provision Missing",
      is_absence_claim: false,
      decision: null,
      disposition: "not_applicable" as const,
      matched_topic: null,
      matched_memos: [],
      reason: null,
    }],
    summary: { absence_total: 0, demote: 0, surface_thesis_drift: 0, surface_omission: 0, flag: 0, not_applicable: 1 },
    partial: false,
  }));

  try {
    const result = await applyEngagementAbsenceGate(
      stubQueryFn, stubAiFn, "deal-123", [finding], [], "omission_audit"
    );

    assertEq(result.survivingFindings.length, 1, "Finding RETAINED in surviving");
    assertEq(result.housekeepingFindings.length, 0, "Nothing in housekeeping");
    assertEq(result.demotedCount, 0, "demotedCount = 0");
    assert(!(result.survivingFindings[0] as any).absence_verification, "No absence_verification set on non-absence finding");
  } finally {
    restoreMap();
    restoreMatcher();
  }
}

// ---------------------------------------------------------------------------
// Run all fixtures
// ---------------------------------------------------------------------------
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("EM-3 Engagement Map Absence Gate — Unit Tests");
  console.log("═══════════════════════════════════════════════════════════════");

  // Fixture G (non-checklist module) first — no mocking needed
  await testFixtureG_NonChecklistModule();

  // Fixtures requiring mocks
  await testFixtureA_Demote();
  await testFixtureB_Omission();
  await testFixtureC_ThesisDrift();
  await testFixtureD_Flag();
  await testFixtureE_NoMap();
  await testFixtureF_Unprocessed();
  await testFixtureG_NonAbsence();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
