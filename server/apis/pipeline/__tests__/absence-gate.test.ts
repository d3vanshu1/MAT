/**
 * FP-1 Absence Verification Gate — Unit tests.
 *
 * Tests verifyAbsenceClaims with stubbed DB retrieval.
 * Run via: npx tsx server/apis/pipeline/__tests__/absence-gate.test.ts
 *
 * Fixture A: absence finding whose topic IS retrievable from memo chunks → DEMOTED
 * Fixture B: absence finding whose topic returns ZERO memo matches → RETAINED
 * Fixture C: non-absence finding → UNTOUCHED
 * Fixture D: single memo chunk matching only ONE keyword → NOT demoted (threshold guard)
 * Fixture E: change-of-control (generic terms match many chunks, but distinctive
 *            term absent from all) → NOT demoted
 */

import { verifyAbsenceClaims, extractSalientKeywords, extractDistinctiveKeywords, type AbsenceGateQueryFn } from "../pipeline-core.js";
import type { CanonicalFinding } from "../canonical-finding.js";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseFinding(overrides: Partial<MergedFinding>): MergedFinding {
  return {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    title: "Test Finding",
    detail: "Detail text",
    severity: "warning",
    source_chunks: [],
    source_docs: [],
    ...overrides,
  } as MergedFinding;
}

// Fixture A: NRR absence claim — memo DOES disclose NRR (3 matching memo chunks)
const FIXTURE_A = baseFinding({
  title: "NRR Trough at 94.4% FY24 Not Disclosed in IC Memos",
  detail: "The net revenue retention rate dropped to 94.4% in FY24, but this decline is not discussed or disclosed in any IC memo.",
  gap_type: "memo_omission",
  severity: "critical",
});

// Fixture B: absence finding with zero memo matches
const FIXTURE_B = baseFinding({
  title: "Board Succession Plan Not Disclosed in IC Memos",
  detail: "No IC memo discusses the board succession planning arrangements.",
  gap_type: "memo_omission",
  severity: "warning",
});

// Fixture C: non-absence finding (legal, no absence language)
const FIXTURE_C = baseFinding({
  title: "Change-of-Control Clause in Key Supplier Contract",
  detail: "The primary supplier contract includes a change-of-control termination clause that triggers upon majority ownership transfer.",
  finding_kind: "source_stated_risk",
  severity: "critical",
});

// Fixture D: single chunk matching only ONE keyword — should NOT demote
const FIXTURE_D = baseFinding({
  title: "Gamma Single-Supplier Concentration Not Disclosed in Memos",
  detail: "The deal's reliance on Gamma as sole supplier is not flagged in any IC memo.",
  gap_type: "memo_omission",
  severity: "warning",
});

// Fixture E: change-of-control — generic terms (customer, contracts, key) match
// many memo chunks, but the DISTINCTIVE term "change-of-control" is absent.
// On the old OR-based code this wrongly demotes; on the fixed AND + generic-stoplist code it retains.
const FIXTURE_E = baseFinding({
  title: "Change-of-Control Termination Rights in Key Customer Contracts Unquantified",
  detail: "Key customer contracts contain change-of-control termination clauses allowing counterparties to exit upon majority ownership transfer, but the IC memos do not quantify exposure.",
  gap_type: "memo_omission",
  severity: "critical",
});

// ---------------------------------------------------------------------------
// Stubbed query functions
// ---------------------------------------------------------------------------

/**
 * Stub A: returns 3 memo-file chunks matching NRR-related content.
 */
const queryStubA: AbsenceGateQueryFn = async (_sql, _schema, params, _meta) => {
  const searchQuery = params[1] as string;
  // If query contains NRR-related terms, return memo chunks
  if (/nrr|retention|revenue/i.test(searchQuery)) {
    return [
      { file_name: "2026-05-18 SCG - 2nd IC Memo vS.pdf", chunk_index: 12, content: "Net revenue retention (NRR) stood at 104% in FY25, recovering from the 94.4% trough observed in FY24. GRR remained stable at 93%." },
      { file_name: "2026-05-18 SCG - 2nd IC Memo vS.pdf", chunk_index: 15, content: "The NRR improvement was driven by net expansion revenue of 108% among existing customers." },
      { file_name: "2026-06-15 SCG - 3rd IC Memo vS.pdf", chunk_index: 8, content: "NRR trends confirm recovery: 94.4% (FY24) → 104% (FY25). Net revenue retention methodology uses cohort-based measurement." },
    ];
  }
  return [];
};

/**
 * Stub B: returns zero results for any query.
 */
const queryStubB: AbsenceGateQueryFn = async () => [];

/**
 * Stub D: returns a SINGLE memo chunk that matches only "gamma" but NOT "supplier" or "concentration".
 */
const queryStubD: AbsenceGateQueryFn = async (_sql, _schema, params, _meta) => {
  const searchQuery = params[1] as string;
  if (/gamma|supplier|concentration/i.test(searchQuery)) {
    // Single chunk, content only mentions "gamma" once — does NOT contain "supplier" or "concentration"
    return [
      { file_name: "2026-05-18 SCG - 2nd IC Memo vS.pdf", chunk_index: 42, content: "The Gamma network provides connectivity infrastructure for the UK enterprise segment. Revenue from this channel grew 8% YoY." },
    ];
  }
  return [];
};

/**
 * Stub E: Simulates many memo chunks matching GENERIC terms ("customer", "contracts", "key")
 * but NONE containing the distinctive term "change-of-control" or "change of control".
 * Under the old OR code, 327 chunks would fire threshold A and wrongly demote.
 * Under the fixed AND+generic-stoplist code, the query uses only "change-of-control"
 * (the distinctive term), so it returns 0 matches.
 */
const queryStubE: AbsenceGateQueryFn = async (_sql, _schema, params, _meta) => {
  const searchQuery = (params[1] as string).toLowerCase();
  // The distinctive term is "change-of-control" (after generic-stoplist filtering).
  // If the query contains "change-of-control" or "change" — return 0 chunks
  // (memo never discusses change of control).
  if (/change/.test(searchQuery)) {
    return [];
  }
  // If somehow generic terms leaked through (old OR code path), return many memo chunks
  if (/customer|contract|key/.test(searchQuery)) {
    const chunks = [];
    for (let i = 0; i < 50; i++) {
      chunks.push({
        file_name: i < 30 ? "2026-05-18 SCG - 2nd IC Memo vS.pdf" : "2026-06-15 SCG - 3rd IC Memo vS.pdf",
        chunk_index: i,
        content: `The key customer contracts include Openwork Group, BT, and Vodafone. Customer revenue concentration is 34% for the top 3 contracts.`,
      });
    }
    return chunks;
  }
  return [];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\n=== FP-1 Absence Verification Gate Tests ===\n");

  // -- Test: extractSalientKeywords --
  console.log("extractSalientKeywords:");
  const kw1 = extractSalientKeywords("NRR Trough at 94.4% FY24 Not Disclosed in IC Memos");
  assert(kw1.includes("nrr"), "extracts 'nrr'");
  assert(kw1.includes("trough"), "extracts 'trough'");
  assert(kw1.includes("94.4"), "extracts '94.4'");
  assert(kw1.includes("fy24"), "extracts 'fy24'");
  assert(!kw1.includes("disclosed"), "'disclosed' is a stopword");
  assert(!kw1.includes("memo"), "'memo' is a stopword");
  assert(!kw1.includes("memos"), "'memos' is a stopword");
  console.log(`  → keywords: [${kw1.join(", ")}]\n`);

  // -- Fixture A: memo DOES disclose → DEMOTED --
  console.log("Fixture A: Absence claim contradicted by memo (should demote):");
  {
    const findings = [{ ...FIXTURE_A }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubA, "deal-123", findings, housekeeping, "omission_audit");

    assertEq(result.demotedCount, 1, "1 finding demoted");
    assertEq(result.survivingFindings.length, 0, "0 surviving findings");
    assertEq(result.housekeepingFindings.length, 1, "1 housekeeping finding");
    assertEq(result.housekeepingFindings[0].absence_verification, "contradicted_by_memo", "absence_verification = contradicted_by_memo");
    assertEq(result.housekeepingFindings[0].severity, "info", "severity demoted to info");
    assertEq(result.housekeepingFindings[0].category, "housekeeping", "category set to housekeeping");
    assert((result.housekeepingFindings[0].materiality_rationale ?? "").includes("[CODE_ENFORCED:absenceGate]"), "materiality_rationale contains gate tag");
  }
  console.log("");

  // -- Fixture B: topic NOT in memos → RETAINED --
  console.log("Fixture B: Absence claim confirmed (topic genuinely not in memos):");
  {
    const findings = [{ ...FIXTURE_B }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubB, "deal-123", findings, housekeeping, "omission_audit");

    assertEq(result.demotedCount, 0, "0 findings demoted");
    assertEq(result.survivingFindings.length, 1, "1 surviving finding");
    assertEq(result.housekeepingFindings.length, 0, "0 housekeeping findings");
    assertEq(result.survivingFindings[0].absence_verification, "memo_absent_confirmed", "absence_verification = memo_absent_confirmed");
    assertEq(result.survivingFindings[0].severity, "warning", "severity unchanged");
  }
  console.log("");

  // -- Fixture C: non-absence finding → UNTOUCHED --
  console.log("Fixture C: Non-absence finding (should be completely untouched):");
  {
    const findings = [{ ...FIXTURE_C }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubA, "deal-123", findings, housekeeping, "omission_audit");

    assertEq(result.demotedCount, 0, "0 findings demoted");
    assertEq(result.survivingFindings.length, 1, "1 surviving finding");
    assertEq(result.housekeepingFindings.length, 0, "0 housekeeping findings");
    assert(result.survivingFindings[0].absence_verification === undefined, "no absence_verification set");
    assertEq(result.survivingFindings[0].severity, "critical", "severity unchanged");
  }
  console.log("");

  // -- Fixture D: single chunk matching only ONE keyword → NOT demoted --
  console.log("Fixture D: Threshold guard (single chunk, one keyword match — should NOT demote):");
  {
    const findings = [{ ...FIXTURE_D }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubD, "deal-123", findings, housekeeping, "omission_audit");

    assertEq(result.demotedCount, 0, "0 findings demoted (threshold not met)");
    assertEq(result.survivingFindings.length, 1, "1 surviving finding");
    assertEq(result.housekeepingFindings.length, 0, "0 housekeeping findings");
    assertEq(result.survivingFindings[0].absence_verification, "memo_absent_confirmed", "absence_verification = memo_absent_confirmed (below threshold)");
  }
  console.log("");

  // -- Fixture E: change-of-control with generic term over-match → NOT demoted --
  console.log("Fixture E: Change-of-control (generic terms match, distinctive term absent — should NOT demote):");
  {
    const findings = [{ ...FIXTURE_E }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubE, "deal-123", findings, housekeeping, "omission_audit");

    assertEq(result.demotedCount, 0, "0 findings demoted (distinctive term not in memos)");
    assertEq(result.survivingFindings.length, 1, "1 surviving finding");
    assertEq(result.housekeepingFindings.length, 0, "0 housekeeping findings");
    assertEq(result.survivingFindings[0].absence_verification, "memo_absent_confirmed", "absence_verification = memo_absent_confirmed");
    assertEq(result.survivingFindings[0].severity, "critical", "severity unchanged (still critical)");
  }
  console.log("");

  // -- extractDistinctiveKeywords test --
  console.log("extractDistinctiveKeywords:");
  {
    const all = extractSalientKeywords("Change-of-Control Termination Rights in Key Customer Contracts Unquantified");
    const distinctive = extractDistinctiveKeywords(all);
    console.log(`  all keywords: [${all.join(", ")}]`);
    console.log(`  distinctive:  [${distinctive.join(", ")}]`);
    assert(!distinctive.includes("customer"), "'customer' filtered as generic");
    assert(!distinctive.includes("contracts"), "'contracts' filtered as generic");
    assert(!distinctive.includes("key"), "'key' filtered as generic");
    assert(!distinctive.includes("termination"), "'termination' filtered as generic");
    assert(!distinctive.includes("unquantified"), "'unquantified' filtered as generic");
    assert(distinctive.includes("change-of-control"), "'change-of-control' is distinctive");
  }
  console.log("");

  // -- Non-checklist module → no-op --
  console.log("Edge case: Non-checklist module (should no-op):");
  {
    const findings = [{ ...FIXTURE_A }];
    const housekeeping: MergedFinding[] = [];
    const result = await verifyAbsenceClaims(queryStubA, "deal-123", findings, housekeeping, "financial_model");

    assertEq(result.demotedCount, 0, "0 findings demoted (non-checklist module)");
    assertEq(result.survivingFindings.length, 1, "findings pass through unchanged");
    assert(result.survivingFindings[0].absence_verification === undefined, "no absence_verification set for non-checklist");
  }
  console.log("");

  // -- Summary --
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED ✓\n");
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
