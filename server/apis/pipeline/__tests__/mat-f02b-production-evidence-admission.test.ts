/**
 * MAT-F02B: Production Evidence Admission Integration Tests
 *
 * These tests invoke the SAME production boundary function used by
 * ReplayClaimLinkage — admitCandidateEvidence from evidence-admission-boundary.ts.
 *
 * They are NOT direct calls to admitEvidence (which was tested in MAT-F02).
 * They prove that the production route correctly:
 *   1. Converts legacy evidence to canonical inputs
 *   2. Invokes the canonical admission gate
 *   3. Produces admitted/rejected outcomes with stable IDs
 *   4. Persists provenance in the downstream record
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f02b-production-evidence-admission.test.ts
 */

import {
  admitCandidateEvidence,
  admitEvidenceAtProductionBoundary,
  adaptLegacyEvidence,
  serializeEvidenceAdmissionLedger,
  deserializeEvidenceAdmissionLedger,
  type LegacyEvidenceEntry,
  type EvidenceAdmissionContext,
  type CandidateEvidenceAdmissionResult,
  type EvidenceAdmissionLedger,
} from "../evidence-admission-boundary.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures — mirror what ReplayClaimLinkage would pass from findings
// ---------------------------------------------------------------------------

const SCG_CLAIM_ENTITY = "SCG";
const GAMMA_ENTITY = "Gamma";
const SCG_IC_DOC_ID = "aaaaaaaa-1111-4000-8000-111111111111";
const MODEL_DOC_ID = "bbbbbbbb-2222-4000-8000-222222222222";
const LEGAL_DD_DOC_ID = "cccccccc-3333-4000-8000-333333333333";
const ALTMAN_CDD_DOC_ID = "dddddddd-4444-4000-8000-444444444444";

const VALID_MODEL_EVIDENCE: LegacyEvidenceEntry = {
  figure: "£184.4m",
  source_doc: "Financial Model v3.2",
  verbatim_snippet: "Revenue total FY26: £184.4m",
  verified: true,
  metric: "revenue",
  period: "FY2026",
  document_id: MODEL_DOC_ID,
  source_filename: "SCG Model v3.2.xlsx",
  document_role: "financial_model",
  sheet_or_page: "FS Summary",
  cell_coordinate: "B12",
  scope: "group",
  unit: "GBP_millions",
  currency: "GBP",
  accounting_basis: "forecast",
  actual_or_forecast: "forecast",
  entity: "SCG",
};

const VALID_LEGAL_DD_EVIDENCE: LegacyEvidenceEntry = {
  figure: "",
  source_doc: "Legal DD Report",
  verbatim_snippet: "The lease assignment clause requires 90 days' written notice to the landlord per Section 4.2 of the agreement",
  verified: true,
  metric: "lease_assignment_notice",
  period: "current",
  document_id: LEGAL_DD_DOC_ID,
  source_filename: "SCG Legal DD Final.pdf",
  document_role: "legal_dd",
  sheet_or_page: "Page 14",
  cell_coordinate: null,
  scope: "group",
  entity: "SCG",
};

const GAMMA_CDD_EVIDENCE: LegacyEvidenceEntry = {
  figure: "25%",
  source_doc: "Altman Solon CDD",
  verbatim_snippet: "Gamma's market share in the North region is approximately 25%",
  verified: true,
  metric: "market_share",
  period: "FY2025",
  document_id: ALTMAN_CDD_DOC_ID,
  source_filename: "Altman Solon CDD - Gamma.pdf",
  document_role: "commercial_cdd",
  sheet_or_page: "Page 42",
  cell_coordinate: null,
  scope: "North region",
  entity: "Gamma",
  segment: "North",
};

const IC_MEMO_SELF_EVIDENCE: LegacyEvidenceEntry = {
  figure: "£191.2m",
  source_doc: "IC Memo",
  verbatim_snippet: "Total revenue for FY2026 is projected at £191.2m based on management's latest forecast",
  verified: false,
  metric: "revenue",
  period: "FY2026",
  document_id: SCG_IC_DOC_ID,
  source_filename: "SCG IC Memo - Final.pdf",
  document_role: "ic_memo",
  sheet_or_page: "Page 7",
  cell_coordinate: null,
  entity: "SCG",
};

const WRONG_PAGE_EVIDENCE: LegacyEvidenceEntry = {
  figure: "£50m",
  source_doc: "PwC FDD",
  verbatim_snippet: "This quote does not exist anywhere in the document at all",
  verified: false,
  metric: "ebitda",
  period: "FY2025",
  document_id: "eeeeeeee-5555-4000-8000-555555555555",
  source_filename: "PwC FDD Report.pdf",
  document_role: "fdd",
  sheet_or_page: "Page 999",
  cell_coordinate: null,
  entity: "SCG",
};

const INVALID_WORKBOOK_EVIDENCE: LegacyEvidenceEntry = {
  figure: "£100m",
  source_doc: "Financial Model",
  verbatim_snippet: "Model shows £100m",
  verified: false,
  metric: "revenue",
  period: "FY2026",
  document_id: MODEL_DOC_ID,
  source_filename: "SCG Model v3.2.xlsx",
  document_role: "financial_model",
  sheet_or_page: "NonExistentSheet",
  cell_coordinate: "INVALID!REF",
  entity: "SCG",
};

const WRONG_AUTHORITY_EVIDENCE: LegacyEvidenceEntry = {
  figure: "",
  source_doc: "Legal DD Report",
  verbatim_snippet: "The competitive landscape analysis shows strong positioning in the North region with 25% market share",
  verified: true,
  metric: "market_size",
  period: "FY2025",
  document_id: LEGAL_DD_DOC_ID,
  source_filename: "SCG Legal DD Final.pdf",
  document_role: "legal_dd",
  sheet_or_page: "Page 8",
  cell_coordinate: null,
  entity: "SCG",
};

const GAMMA_WITH_BRIDGE_EVIDENCE: LegacyEvidenceEntry = {
  ...GAMMA_CDD_EVIDENCE,
  entity: "Gamma",
};

// ---------------------------------------------------------------------------
// Standard context for SCG claims
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<EvidenceAdmissionContext> = {}): EvidenceAdmissionContext {
  return {
    claim_entity: SCG_CLAIM_ENTITY,
    claim_source_document_id: SCG_IC_DOC_ID,
    proposition_type: "financial",
    candidate_reference: "test-finding-001",
    source_text: "",
    ...overrides,
  };
}

// ===========================================================================
// TEST 1: Valid current-model evidence admission
// ===========================================================================

console.log("\n=== Test 1: Valid current-model evidence admission ===");
{
  const context = makeContext({ proposition_type: "revenue" });
  const result = admitCandidateEvidence(
    [VALID_MODEL_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-001" },
  );

  assert(result.has_admitted_evidence === true, "Model evidence admitted");
  assertEqual(result.admitted.length, 1, "Exactly 1 admitted record");
  assertEqual(result.rejected.length, 0, "No rejections");
  assert(result.admitted[0].evidence_id.startsWith("ev-v1-"), "Evidence ID has canonical prefix");
  assertEqual(result.admitted[0].authority_class, "current_financial_model", "Authority class is current_financial_model");
  assertEqual(result.admitted[0].coordinate.kind, "workbook", "Coordinate is workbook type");
  if (result.admitted[0].coordinate.kind === "workbook") {
    assertEqual(result.admitted[0].coordinate.sheet, "FS Summary", "Sheet is FS Summary");
    assertEqual(result.admitted[0].coordinate.cell_or_range, "B12", "Cell is B12");
  }
  assertEqual(result.admitted[0].evidence_role, "contradicting", "Role is contradicting (data_divergence)");
  assertEqual(result.admitted[0].authority_decision.allowed, true, "Authority allowed");
  assertEqual(result.admitted[0].entity_applicability.allowed, true, "Entity applicability allowed");
  assertEqual(result.admitted[0].entity_applicability.direct_entity_match, true, "Direct entity match");
}

// ===========================================================================
// TEST 2: Valid Legal DD evidence admission
// ===========================================================================

console.log("\n=== Test 2: Valid Legal DD evidence admission ===");
{
  const context = makeContext({ proposition_type: "regulatory_contractual" });
  const result = admitCandidateEvidence(
    [VALID_LEGAL_DD_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-002" },
  );

  assert(result.has_admitted_evidence === true, "Legal DD evidence admitted");
  assertEqual(result.admitted.length, 1, "Exactly 1 admitted record");
  assertEqual(result.admitted[0].authority_class, "legal_dd", "Authority class is legal_dd");
  assertEqual(result.admitted[0].coordinate.kind, "pdf", "Coordinate is PDF type");
  if (result.admitted[0].coordinate.kind === "pdf") {
    assertEqual(result.admitted[0].coordinate.page, 14, "Page is 14");
    assert(
      result.admitted[0].coordinate.exact_quote.includes("lease assignment"),
      "Quote contains substantive text"
    );
  }
  assertEqual(result.admitted[0].authority_decision.allowed, true, "Authority allowed for legal proposition");
}

// ===========================================================================
// TEST 3: Gamma evidence rejected for SCG claim without bridge
// ===========================================================================

console.log("\n=== Test 3: Gamma evidence rejected for SCG claim without bridge ===");
{
  const context = makeContext({ proposition_type: "commercial" });
  const result = admitCandidateEvidence(
    [GAMMA_CDD_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-003" },
  );

  assert(result.has_admitted_evidence === false, "No evidence admitted");
  assertEqual(result.admitted.length, 0, "Zero admitted records");
  assertEqual(result.rejected.length, 1, "Exactly 1 rejection");
  assertEqual(result.rejected[0].rejection_reason, "entity_bridge_missing", "Reason is entity_bridge_missing");
  assert(result.rejected[0].evidence_id.startsWith("ev-v1-"), "Rejected record has stable evidence ID");
  assertEqual(result.rejected[0].candidate_or_claim_reference, "test-finding-001", "Candidate reference preserved");
  assertEqual(result.rejected[0].source_document_id, ALTMAN_CDD_DOC_ID, "Source document ID preserved");
}

// ===========================================================================
// TEST 4: Gamma evidence admitted with valid structured bridge
// ===========================================================================

console.log("\n=== Test 4: Gamma evidence admitted with valid structured bridge ===");
{
  const bridges = new Map([
    ["gamma→scg", { bridge_evidence_id: "bridge-ev-001", rationale: "Gamma is a subsidiary of SCG; consolidated financials" }],
  ]);
  const context = makeContext({ proposition_type: "commercial", bridges });
  const result = admitCandidateEvidence(
    [GAMMA_WITH_BRIDGE_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-004" },
  );

  assert(result.has_admitted_evidence === true, "Gamma evidence admitted with bridge");
  assertEqual(result.admitted.length, 1, "Exactly 1 admitted record");
  assertEqual(result.admitted[0].entity_applicability.direct_entity_match, false, "Not a direct entity match");
  assertEqual(result.admitted[0].entity_applicability.bridge_evidence_id, "bridge-ev-001", "Bridge evidence ID preserved");
  assertEqual(result.admitted[0].entity_applicability.reason_code, "entity_bridge_applied", "Bridge was applied");
}

// ===========================================================================
// TEST 5: IC memo self-verification rejection
// ===========================================================================

console.log("\n=== Test 5: IC memo self-verification rejection ===");
{
  const context = makeContext({ proposition_type: "revenue" });
  const result = admitCandidateEvidence(
    [IC_MEMO_SELF_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-005" },
  );

  assert(result.has_admitted_evidence === false, "IC memo evidence NOT admitted");
  assertEqual(result.rejected.length, 1, "Exactly 1 rejection");
  assertEqual(result.rejected[0].rejection_reason, "ic_memo_self_verification", "Reason is ic_memo_self_verification");
  assertEqual(result.rejected[0].authority_class, "ic_memo", "Authority class recorded as ic_memo");
}

// ===========================================================================
// TEST 6: Wrong-page PDF quotation rejection
// ===========================================================================

console.log("\n=== Test 6: Wrong-page PDF quotation rejection ===");
{
  // Provide source text that does NOT contain the quote
  const context = makeContext({
    proposition_type: "ebitda",
    source_text: "This is the actual document content which does not contain the alleged quote at all.",
  });
  const result = admitCandidateEvidence(
    [WRONG_PAGE_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-006" },
  );

  assert(result.has_admitted_evidence === false, "Wrong-page evidence NOT admitted");
  assertEqual(result.rejected.length, 1, "Exactly 1 rejection");
  assertEqual(result.rejected[0].rejection_reason, "quote_not_found", "Reason is quote_not_found");
}

// ===========================================================================
// TEST 7: Invalid workbook sheet/cell rejection
// ===========================================================================

console.log("\n=== Test 7: Invalid workbook sheet/cell rejection ===");
{
  const context = makeContext({ proposition_type: "revenue" });
  const result = admitCandidateEvidence(
    [INVALID_WORKBOOK_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-007" },
  );

  assert(result.has_admitted_evidence === false, "Invalid workbook evidence NOT admitted");
  assertEqual(result.rejected.length, 1, "Exactly 1 rejection");
  // The cell reference "INVALID!REF" doesn't match the regex pattern
  assertEqual(result.rejected[0].rejection_reason, "invalid_workbook_coordinate", "Reason is invalid_workbook_coordinate");
}

// ===========================================================================
// TEST 8: Wrong authority for proposition rejection (Legal DD for commercial)
// ===========================================================================

console.log("\n=== Test 8: Wrong authority for proposition rejection ===");
{
  const context = makeContext({ proposition_type: "market_size" });
  const result = admitCandidateEvidence(
    [WRONG_AUTHORITY_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-008" },
  );

  assert(result.has_admitted_evidence === false, "Wrong-authority evidence NOT admitted");
  assertEqual(result.rejected.length, 1, "Exactly 1 rejection");
  assertEqual(result.rejected[0].rejection_reason, "authority_not_valid_for_proposition", "Reason is authority_not_valid_for_proposition");
  assertEqual(result.rejected[0].authority_class, "legal_dd", "Authority class recorded");
}

// ===========================================================================
// TEST 9: Admitted provenance retained downstream
// ===========================================================================

console.log("\n=== Test 9: Admitted provenance retained downstream ===");
{
  const context = makeContext({ proposition_type: "revenue" });
  const result = admitCandidateEvidence(
    [VALID_MODEL_EVIDENCE],
    context,
    { finding_kind: "confirmed_alignment", finding_id: "f-009" },
  );

  assert(result.has_admitted_evidence === true, "Evidence admitted");
  const admitted = result.admitted[0];
  // Verify all required provenance fields are present
  assert(!!admitted.evidence_id, "evidence_id present");
  assert(!!admitted.source_document_id, "source_document_id present");
  assertEqual(admitted.source_document_id, MODEL_DOC_ID, "source_document_id matches");
  assert(!!admitted.source_document_name, "source_document_name present");
  assertEqual(admitted.authority_class, "current_financial_model", "authority_class present");
  assert(admitted.coordinate !== null, "coordinate present");
  assertEqual(admitted.target_entity, "SCG", "target_entity preserved");
  assertEqual(admitted.evidence_role, "verifying", "evidence_role is verifying (confirmed_alignment)");
  assert(admitted.authority_decision.allowed === true, "authority_decision.allowed present");
  assert(!!admitted.authority_decision.reason_code, "authority_decision.reason_code present");
  assert(admitted.entity_applicability.allowed === true, "entity_applicability.allowed present");
  assert(admitted.entity_applicability.direct_entity_match === true, "entity_applicability.direct_entity_match present");

  // Verify canonical record is complete
  const cr = admitted.canonical_record;
  assert(!!cr.schema_version, "canonical_record.schema_version present");
  assertEqual(cr.schema_version, "evidence-v1", "Schema version is evidence-v1");
  assert(!!cr.source.document_id, "canonical source.document_id");
  assert(!!cr.source.authority_class, "canonical source.authority_class");
  assert(cr.proposition.metric === "revenue", "canonical proposition.metric");
  assertEqual(cr.proposition.period, "FY2026", "canonical proposition.period");
  assertEqual(cr.proposition.currency, "GBP", "canonical proposition.currency");
}

// ===========================================================================
// TEST 10: Admitted/rejected evidence persistence and reload
// ===========================================================================

console.log("\n=== Test 10: Evidence persistence and reload ===");
{
  // Build a result set with mixed admitted + rejected
  const bridges = new Map([
    ["gamma→scg", { bridge_evidence_id: "bridge-ev-002", rationale: "Subsidiary link" }],
  ]);
  const context = makeContext({ proposition_type: "revenue" });
  const contextWithBridge = makeContext({ proposition_type: "commercial", bridges });

  // Admitted: valid model
  const modelResult = admitCandidateEvidence(
    [VALID_MODEL_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-10a" },
  );

  // Admitted: Legal DD for legal proposition
  const legalContext = makeContext({ proposition_type: "regulatory_contractual" });
  const legalResult = admitCandidateEvidence(
    [VALID_LEGAL_DD_EVIDENCE],
    legalContext,
    { finding_kind: "data_divergence", finding_id: "f-10b" },
  );

  // Rejected: Gamma without bridge
  const gammaContext = makeContext({ proposition_type: "commercial" });
  const gammaResult = admitCandidateEvidence(
    [GAMMA_CDD_EVIDENCE],
    gammaContext,
    { finding_kind: "data_divergence", finding_id: "f-10c" },
  );

  // Rejected: Invalid workbook
  const wbResult = admitCandidateEvidence(
    [INVALID_WORKBOOK_EVIDENCE],
    context,
    { finding_kind: "data_divergence", finding_id: "f-10d" },
  );

  // Serialize all four
  const ledger1 = serializeEvidenceAdmissionLedger(modelResult);
  const ledger2 = serializeEvidenceAdmissionLedger(legalResult);
  const ledger3 = serializeEvidenceAdmissionLedger(gammaResult);
  const ledger4 = serializeEvidenceAdmissionLedger(wbResult);

  // Simulate persistence: JSON.stringify → JSON.parse
  const persisted1 = JSON.parse(JSON.stringify(ledger1));
  const persisted2 = JSON.parse(JSON.stringify(ledger2));
  const persisted3 = JSON.parse(JSON.stringify(ledger3));
  const persisted4 = JSON.parse(JSON.stringify(ledger4));

  // Deserialize (reload)
  const reloaded1 = deserializeEvidenceAdmissionLedger(persisted1);
  const reloaded2 = deserializeEvidenceAdmissionLedger(persisted2);
  const reloaded3 = deserializeEvidenceAdmissionLedger(persisted3);
  const reloaded4 = deserializeEvidenceAdmissionLedger(persisted4);

  assert(reloaded1 !== null, "Model ledger reloaded");
  assert(reloaded2 !== null, "Legal DD ledger reloaded");
  assert(reloaded3 !== null, "Gamma rejection ledger reloaded");
  assert(reloaded4 !== null, "Invalid WB rejection ledger reloaded");

  // Verify reloaded model evidence
  assertEqual(reloaded1!.schema_version, "evidence-admission-v1", "Schema version preserved");
  assertEqual(reloaded1!.admitted.length, 1, "Model admitted count preserved");
  assertEqual(reloaded1!.admitted[0].evidence_id, modelResult.admitted[0].evidence_id, "Model evidence_id stable");
  assertEqual(reloaded1!.admitted[0].authority_class, "current_financial_model", "Model authority_class preserved");
  assertEqual(reloaded1!.admitted[0].coordinate.kind, "workbook", "Model coordinate.kind preserved");

  // Verify reloaded Legal DD evidence
  assertEqual(reloaded2!.admitted.length, 1, "Legal DD admitted count preserved");
  assertEqual(reloaded2!.admitted[0].evidence_id, legalResult.admitted[0].evidence_id, "Legal DD evidence_id stable");
  assertEqual(reloaded2!.admitted[0].authority_class, "legal_dd", "Legal DD authority_class preserved");

  // Verify reloaded Gamma rejection
  assertEqual(reloaded3!.rejected.length, 1, "Gamma rejection count preserved");
  assertEqual(reloaded3!.rejected[0].evidence_id, gammaResult.rejected[0].evidence_id, "Gamma evidence_id stable");
  assertEqual(reloaded3!.rejected[0].rejection_reason, "entity_bridge_missing", "Gamma rejection_reason preserved");
  assertEqual(reloaded3!.rejected[0].candidate_or_claim_reference, "test-finding-001", "Gamma candidate ref preserved");
  assertEqual(reloaded3!.rejected[0].authority_class, "commercial_cdd", "Gamma authority_class preserved");

  // Verify reloaded invalid workbook rejection
  assertEqual(reloaded4!.rejected.length, 1, "Invalid WB rejection count preserved");
  assertEqual(reloaded4!.rejected[0].evidence_id, wbResult.rejected[0].evidence_id, "Invalid WB evidence_id stable");
  assertEqual(reloaded4!.rejected[0].rejection_reason, "invalid_workbook_coordinate", "Invalid WB rejection_reason preserved");

  // Verify admission_timestamp present
  assert(!!reloaded1!.admission_timestamp, "Model admission_timestamp present");
  assert(!!reloaded3!.admission_timestamp, "Gamma admission_timestamp present");
}

// ===========================================================================
// Final summary
// ===========================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`MAT-F02B Production Evidence Admission Tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
