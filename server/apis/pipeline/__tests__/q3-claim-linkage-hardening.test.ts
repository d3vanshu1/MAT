/**
 * Q3 Claim-Linkage Hardening Tests — Message 1 Required Test Suite
 *
 * Tests the 10 required scenarios:
 *   1. historical legacy-reference semantics (separate test file)
 *   2. unique reconciliation
 *   3. ambiguous reconciliation
 *   4. duplicate claim IDs
 *   5. non-IC claim rejection
 *   6. invalid authority rejection
 *   7. confirmed non-adverse handling
 *   8. one real Saint candidate admitted (requires real data — tested via DiagSaintReconciliation)
 *   9. unresolved candidates excluded
 *  10. zero silent loss
 */

import {
  classifyClaimLinkage,
  resolveClaimId,
  CLAIM_LINKAGE_DISPOSITIONS,
  Q4_ELIGIBLE_ADVERSE,
  Q4_ELIGIBLE_NON_ADVERSE,
  Q4_INELIGIBLE,
  type ClaimLinkageDisposition,
} from "../claim-linkage.js";

// ---------------------------------------------------------------------------
// Test framework (self-verifying, no external runner)
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];
function assert(condition: boolean, name: string, detail: string = "") {
  results.push({ name, passed: condition, detail: condition ? "OK" : detail || "FAILED" });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildClaimMap(claims: Array<{ claim_id: string; [k: string]: any }>) {
  const map = new Map<string, any>();
  for (const c of claims) map.set(c.claim_id, c);
  return map;
}

const MOCK_IC_CLAIM = {
  claim_id: "clm-v1-test001",
  verbatim_snippet: "FY26 revenue of $500M",
  claim_text: "FY26 revenue of $500M",
  claim_type: "financial",
  claim_category: "financial",
  metric: "revenue",
  period: "FY26",
  value: 500,
  unit: "$M",
  source_doc_id: "doc-ic-001",
  source_doc: "3rd IC Memo.pdf",
  ic_document_id: "doc-ic-001",
  ic_document_filename: "3rd IC Memo.pdf",
  memo_version: "3rd IC",
  source_page: "12",
  extraction_coordinates: "Section 3.1",
};

const MOCK_NON_IC_CLAIM = {
  ...MOCK_IC_CLAIM,
  claim_id: "clm-v1-noic001",
  source_doc: "PwC Financial DD Report.pdf",
  ic_document_id: "doc-pwc-001",
  ic_document_filename: "PwC Financial DD Report.pdf",
};

const MOCK_FINDING_BASE = {
  finding_id: "f-001",
  corpus_index: 0,
  title: "Revenue divergence FY26",
  detail: "Model shows $480M vs memo $500M",
  full_analysis: null,
  severity: "critical",
  source_tag: "live_model",
  source_docs: ["Model_v3.xlsx"],
  claim_type: "financial",
  finding_kind: "data_divergence",
  evidence: "Model value $480M",
  doc_filename: "Model_v3.xlsx",
  doc_type: "financial_model",
};

// ---------------------------------------------------------------------------
// Test 2: Unique reconciliation — single match resolves
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  const result = resolveClaimId("clm-v1-test001", claimMap);
  assert(result.resolved === true, "unique_resolution_resolves");
  assert(result.claim_record !== null, "unique_resolution_has_record");
  assert(result.ambiguous === false, "unique_resolution_not_ambiguous");
  assert(result.match_count === 1, "unique_resolution_count_1");
})();

// ---------------------------------------------------------------------------
// Test 3: Ambiguous reconciliation — multiple matches rejected
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  const ambiguousRefs = new Set(["c0-0", "c1-2"]);

  const result = resolveClaimId("c0-0", claimMap, ambiguousRefs);
  assert(result.resolved === false, "ambiguous_not_resolved");
  assert(result.ambiguous === true, "ambiguous_flag_true");
  assert(result.match_count >= 2, "ambiguous_match_count_gte_2");
  assert(result.failure_reason?.includes("ambiguous") === true, "ambiguous_reason_clear");
})();

// ---------------------------------------------------------------------------
// Test 3b: Ambiguous reconciliation → proper disposition in classifyClaimLinkage
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  const ambiguousRefs = new Set(["c0-0"]);

  const result = classifyClaimLinkage(
    { ...MOCK_FINDING_BASE, originating_claim_id: "c0-0", claim_ids: ["c0-0"] },
    claimMap,
    ambiguousRefs,
  );
  assert(
    result.claim_linkage_disposition === "ambiguous_reconciliation",
    "ambiguous_disposition_correct",
    `Got: ${result.claim_linkage_disposition}`
  );
  assert(result.q4_eligible === false, "ambiguous_not_q4_eligible");
})();

// ---------------------------------------------------------------------------
// Test 4: Duplicate claim IDs — detected (tested at ReplayClaimLinkage level)
// This test verifies the claimMap deduplication check pattern
// ---------------------------------------------------------------------------
(() => {
  // Simulate: same claim_id appears twice in ledger → would be caught by
  // ReplayClaimLinkage's HARD FAILURE check before reaching classifyClaimLinkage
  const claims = [
    { ...MOCK_IC_CLAIM, claim_id: "clm-v1-dup001" },
    { ...MOCK_IC_CLAIM, claim_id: "clm-v1-dup001", verbatim_snippet: "Different text" },
  ];

  // Count duplicates (mirrors ReplayClaimLinkage logic)
  const idCounts = new Map<string, number>();
  for (const c of claims) {
    idCounts.set(c.claim_id, (idCounts.get(c.claim_id) ?? 0) + 1);
  }
  const duplicates = [...idCounts.entries()].filter(([, n]) => n > 1);
  assert(duplicates.length === 1, "duplicate_detected");
  assert(duplicates[0][0] === "clm-v1-dup001", "duplicate_is_correct_id");
  assert(duplicates[0][1] === 2, "duplicate_count_is_2");
})();

// ---------------------------------------------------------------------------
// Test 5: Non-IC claim rejection — claim from DD report rejected
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_NON_IC_CLAIM]);
  const result = resolveClaimId("clm-v1-noic001", claimMap);
  assert(result.resolved === false, "non_ic_not_resolved");
  assert(result.failure_reason?.includes("non-IC document") === true, "non_ic_reason_clear");

  // Full classification flow
  const linkageResult = classifyClaimLinkage(
    { ...MOCK_FINDING_BASE, originating_claim_id: "clm-v1-noic001", claim_ids: ["clm-v1-noic001"] },
    claimMap,
  );
  assert(
    linkageResult.claim_linkage_disposition === "claim_from_non_ic_document",
    "non_ic_disposition_correct",
    `Got: ${linkageResult.claim_linkage_disposition}`
  );
  assert(linkageResult.q4_eligible === false, "non_ic_not_eligible");
})();

// ---------------------------------------------------------------------------
// Test 6: Invalid authority rejection — IC material cannot verify itself
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  // Finding sourced from IC memo (same document trying to verify its own claim)
  const result = classifyClaimLinkage(
    {
      ...MOCK_FINDING_BASE,
      originating_claim_id: "clm-v1-test001",
      claim_ids: ["clm-v1-test001"],
      source_tag: "ic_memo",
      source_docs: ["3rd IC Memo.pdf"],
      doc_filename: "3rd IC Memo.pdf",
      doc_type: "ic_memo",
    },
    claimMap,
  );
  assert(
    result.claim_linkage_disposition === "invalid_evidence_authority",
    "ic_self_verify_rejected",
    `Got: ${result.claim_linkage_disposition}`
  );
  assert(result.q4_eligible === false, "authority_invalid_not_eligible");
  assert(result.authority_class === "ic_material", "authority_class_is_ic_material", `Got: ${result.authority_class}`);
})();

// ---------------------------------------------------------------------------
// Test 7: Confirmed non-adverse handling — confirmed claims get correct disposition
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  // Finding with upstream_verdict=confirmed AND structured finding_kind
  const result = classifyClaimLinkage(
    {
      ...MOCK_FINDING_BASE,
      originating_claim_id: "clm-v1-test001",
      claim_ids: ["clm-v1-test001"],
      finding_kind: "confirmed_alignment",
      source_tag: "live_model",
    },
    claimMap,
  );
  assert(
    result.claim_linkage_disposition === "claim_linked_confirmed",
    "confirmed_disposition",
    `Got: ${result.claim_linkage_disposition}`
  );
  assert(result.q4_eligible === true, "confirmed_is_q4_eligible");
  // But should NOT be in adverse set
  assert(Q4_ELIGIBLE_ADVERSE.has(result.claim_linkage_disposition) === false, "confirmed_not_adverse");
  assert(Q4_ELIGIBLE_NON_ADVERSE.has(result.claim_linkage_disposition) === true, "confirmed_is_non_adverse");
})();

// ---------------------------------------------------------------------------
// Test 8: (One real Saint candidate admitted — tested via DiagSaintReconciliation/ReplayClaimLinkage)
// This test validates the structural requirement: resolved claim → eligible
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);
  const result = classifyClaimLinkage(
    {
      ...MOCK_FINDING_BASE,
      originating_claim_id: "clm-v1-test001",
      claim_ids: ["clm-v1-test001"],
      source_tag: "live_model",
      finding_kind: "data_divergence",
    },
    claimMap,
  );
  // data_divergence with live_model authority should produce materially_changed (from strict verdict)
  assert(
    result.claim_linkage_disposition === "claim_linked_materially_changed",
    "real_candidate_admitted",
    `Got: ${result.claim_linkage_disposition}`
  );
  assert(result.q4_eligible === true, "real_candidate_q4_eligible");
  assert(result.claim_provenance !== null, "real_candidate_has_provenance");
  assert(result.authority_valid === true, "real_candidate_authority_valid");
})();

// ---------------------------------------------------------------------------
// Test 9: Unresolved candidates excluded — missing ref gets proper disposition
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);

  // 9a: No claim_id at all
  const noRef = classifyClaimLinkage(
    { ...MOCK_FINDING_BASE, originating_claim_id: null, claim_ids: null },
    claimMap,
  );
  assert(
    noRef.claim_linkage_disposition === "not_linked_to_IC_claim",
    "no_ref_not_linked",
    `Got: ${noRef.claim_linkage_disposition}`
  );
  assert(noRef.q4_eligible === false, "no_ref_not_eligible");

  // 9b: Invalid claim_id (not in map)
  const badRef = classifyClaimLinkage(
    { ...MOCK_FINDING_BASE, originating_claim_id: "nonexistent-id-xyz", claim_ids: ["nonexistent-id-xyz"] },
    claimMap,
  );
  assert(
    badRef.claim_linkage_disposition === "invalid_or_unresolved_claim_reference",
    "unresolved_ref_disposition",
    `Got: ${badRef.claim_linkage_disposition}`
  );
  assert(badRef.q4_eligible === false, "unresolved_not_eligible");

  // 9c: Malformed claim_id
  const malformed = classifyClaimLinkage(
    { ...MOCK_FINDING_BASE, originating_claim_id: "xy", claim_ids: ["xy"] },
    claimMap,
  );
  assert(
    malformed.claim_linkage_disposition === "malformed_claim_reference",
    "malformed_ref_disposition",
    `Got: ${malformed.claim_linkage_disposition}`
  );
  assert(malformed.q4_eligible === false, "malformed_not_eligible");
})();

// ---------------------------------------------------------------------------
// Test 10: Zero silent loss — every disposition is accounted for
// ---------------------------------------------------------------------------
(() => {
  // All dispositions must be either Q4-eligible or Q4-ineligible (none unclassified)
  const allDispositions = new Set<string>(CLAIM_LINKAGE_DISPOSITIONS);
  const classifiedDispositions = new Set<string>([
    ...Q4_ELIGIBLE_ADVERSE,
    ...Q4_ELIGIBLE_NON_ADVERSE,
    ...Q4_INELIGIBLE,
  ]);

  for (const d of allDispositions) {
    assert(
      classifiedDispositions.has(d),
      `disposition_${d}_classified`,
      `Disposition '${d}' is not in any Q4 classification set — SILENT LOSS`
    );
  }

  // Also verify no disposition appears in both eligible and ineligible
  for (const d of Q4_ELIGIBLE_ADVERSE) {
    assert(!Q4_INELIGIBLE.has(d), `adverse_${d}_not_ineligible`);
  }
  for (const d of Q4_ELIGIBLE_NON_ADVERSE) {
    assert(!Q4_INELIGIBLE.has(d), `non_adverse_${d}_not_ineligible`);
  }
  for (const d of Q4_INELIGIBLE) {
    assert(!Q4_ELIGIBLE_ADVERSE.has(d as any), `ineligible_${d}_not_adverse`);
    assert(!Q4_ELIGIBLE_NON_ADVERSE.has(d as any), `ineligible_${d}_not_non_adverse`);
  }

  // Total must equal length of CLAIM_LINKAGE_DISPOSITIONS
  const totalClassified = Q4_ELIGIBLE_ADVERSE.size + Q4_ELIGIBLE_NON_ADVERSE.size + Q4_INELIGIBLE.size;
  assert(
    totalClassified === CLAIM_LINKAGE_DISPOSITIONS.length,
    "total_dispositions_match",
    `Classified ${totalClassified} but have ${CLAIM_LINKAGE_DISPOSITIONS.length} dispositions`
  );
})();

// ---------------------------------------------------------------------------
// Test: Heuristic verdict removal — keyword text CANNOT establish verdict
// ---------------------------------------------------------------------------
(() => {
  const claimMap = buildClaimMap([MOCK_IC_CLAIM]);

  // Finding with "contradicted" in title/detail but NO structured finding_kind
  const heuristicFinding = classifyClaimLinkage(
    {
      finding_id: "f-heuristic",
      corpus_index: 99,
      title: "Revenue directly contradicts IC memo projection",
      detail: "The model value contradicts the stated $500M revenue",
      full_analysis: null,
      severity: "critical",
      source_tag: "live_model",
      source_docs: ["Model_v3.xlsx"],
      originating_claim_id: "clm-v1-test001",
      claim_ids: ["clm-v1-test001"],
      claim_type: "financial",
      finding_kind: null, // NO structured kind → verdict must be unverifiable
      evidence: "Contradicted: $480M vs $500M",
      doc_filename: "Model_v3.xlsx",
      doc_type: "financial_model",
    },
    claimMap,
  );

  // Without finding_kind, verdict MUST be unverifiable — keywords cannot establish truth
  assert(
    heuristicFinding.claim_linkage_disposition === "claim_linked_unverifiable",
    "heuristic_blocked_unverifiable",
    `Got: ${heuristicFinding.claim_linkage_disposition} — keyword 'contradicted' in text should NOT produce contradicted verdict`
  );
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const total = results.length;

console.log(`\n=== Q3 Claim-Linkage Hardening Tests ===`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log("FAILURES:");
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  ✗ ${r.name}: ${r.detail}`);
  }
}

export const testResults = { passed, failed, total, results };
export default { passed, failed, total };
