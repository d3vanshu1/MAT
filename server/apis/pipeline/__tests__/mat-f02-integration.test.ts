/**
 * MAT-F02 Integration Tests — Coordinate-Backed Authority, Evidence, and Entity Routing
 *
 * 15 targeted tests covering:
 *   1-2. Authority classification (all classes + unknown fail-closed)
 *   3-4. PDF coordinate validation (valid + wrong-page rejection)
 *   5-6. Workbook coordinate validation (valid + missing-sheet rejection)
 *   7-8. Gamma-to-SCG entity routing (rejection + bridge)
 *   9-10. IC self-verification + management-material rejection
 *   11-12. Legal DD allowed/rejected by proposition
 *   13-14. Commercial CDD allowed/rejected by proposition
 *   15. Persistence/reload parity
 *
 * Uses same assertion pattern as existing pipeline tests.
 */

import {
  classifySourceAuthority,
  validatePdfCoordinate,
  validateWorkbookCoordinate,
  evaluateEntityApplicability,
  evaluateAuthority,
  admitEvidence,
  generateEvidenceId,
  serializeEvidenceRecord,
  deserializeEvidenceRecord,
  type CanonicalEvidenceRecord,
  type EvidenceAuthorityClass,
  type PdfCoordinate,
  type WorkbookCoordinate,
} from "../canonical-evidence.js";

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  assertEqual(value, true, label);
}

function assertFalse(value: boolean, label: string): void {
  assertEqual(value, false, label);
}

function assertNotNull(value: unknown, label: string): void {
  if (value !== null && value !== undefined) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} (was null/undefined)`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCG_MODEL_DOC_ID = "doc-model-001";
const SCG_MODEL_NAME = "SCG CT-to-Mar-26 Model v4.xlsm";
const PRIOR_MODEL_DOC_ID = "doc-model-prior-001";
const PRIOR_MODEL_NAME = "SCG Model v1 (Prior).xlsx";
const PWC_FDD_DOC_ID = "doc-fdd-001";
const PWC_FDD_NAME = "PwC Financial Due Diligence Report.pdf";
const LEGAL_DD_DOC_ID = "doc-legal-001";
const LEGAL_DD_NAME = "Legal DD Report — SCG.pdf";
const ALTMAN_CDD_DOC_ID = "doc-cdd-001";
const ALTMAN_CDD_NAME = "Altman Solon Commercial Due Diligence.pdf";
const IC_MEMO_DOC_ID = "doc-ic-001";
const IC_MEMO_NAME = "SCG 3rd IC Memo.pdf";
const IM_DOC_ID = "doc-im-001";
const IM_NAME = "Information Memorandum - SCG.pdf";
const UNKNOWN_DOC_ID = "doc-unknown-001";
const UNKNOWN_DOC_NAME = "Random Consultant Notes.pdf";

const FDD_SOURCE_TEXT = `
Page 47: Revenue Analysis

The FDD analysis confirms that SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year. The revenue bridge shows organic growth of 4.2% supplemented by contribution from acquired entities.

Page 62: EBITDA Quality

Cash EBITDA is confirmed at £52m after adjusting for non-recurring integration costs of £3.2m. The adjustments are well-supported by management documentation.
`;

const LEGAL_DD_SOURCE_TEXT = `
Page 23: Change of Control

The Share Purchase Agreement contains a standard change-of-control clause requiring counterparty consent for 3 of the 12 material customer contracts. These contracts represent approximately 18% of group revenue.

Page 31: IP Ownership

All intellectual property is held within the operating subsidiaries. No encumbrances or disputed ownership claims were identified during the review.
`;

const ALTMAN_SOURCE_TEXT = `
Page 8: Market Size — UK Managed Services

The UK managed services market is estimated at £12.4bn in 2025, growing at approximately 7% per annum. SCG competes primarily in the mid-market segment valued at approximately £3.8bn.

Page 14: Gamma Competitive Position

Gamma holds an estimated 4.2% share of the UK unified communications market with a strong brand position in the SME segment. Its channel model provides structural advantages in customer acquisition costs versus direct-sales competitors.
`;

// ---------------------------------------------------------------------------
// TEST 1: Correct source-authority classification (all classes)
// ---------------------------------------------------------------------------

function testAuthorityClassification(): void {
  console.log("\n═══ TEST 1-2: Source Authority Classification ═══");

  // Current model
  assertEqual(
    classifySourceAuthority({ document_tag: "financial_model", document_name: SCG_MODEL_NAME }),
    "current_financial_model",
    "Current model by tag"
  );

  // Prior model
  assertEqual(
    classifySourceAuthority({ document_tag: "prior_model", document_name: PRIOR_MODEL_NAME }),
    "prior_financial_model",
    "Prior model by tag"
  );

  // PwC FDD
  assertEqual(
    classifySourceAuthority({ document_tag: "fdd", document_name: PWC_FDD_NAME }),
    "vendor_financial_dd",
    "Vendor FDD by tag"
  );

  // Legal DD
  assertEqual(
    classifySourceAuthority({ document_tag: "legal_dd", document_name: LEGAL_DD_NAME }),
    "legal_dd",
    "Legal DD by tag"
  );

  // Altman Solon CDD
  assertEqual(
    classifySourceAuthority({ document_tag: "cdd", document_name: ALTMAN_CDD_NAME }),
    "commercial_cdd",
    "Commercial CDD by tag"
  );

  // IC Memo
  assertEqual(
    classifySourceAuthority({ document_tag: "ic_memo", document_name: IC_MEMO_NAME }),
    "ic_memo",
    "IC Memo by tag"
  );

  // Information Memorandum
  assertEqual(
    classifySourceAuthority({ document_tag: "cim", document_name: IM_NAME }),
    "information_memorandum",
    "Information Memorandum by tag"
  );

  // Unknown document — MUST remain unknown
  assertEqual(
    classifySourceAuthority({ document_name: UNKNOWN_DOC_NAME }),
    "unknown",
    "Unknown document fails closed"
  );

  // Filename fallback for model
  assertEqual(
    classifySourceAuthority({ document_name: "SCG Model Final.xlsx" }),
    "current_financial_model",
    "Model by filename fallback"
  );
}

// ---------------------------------------------------------------------------
// TEST 3-4: PDF coordinate validation
// ---------------------------------------------------------------------------

function testPdfCoordinate(): void {
  console.log("\n═══ TEST 3-4: PDF Coordinate Validation ═══");

  // Valid: exact quote in document
  const validResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year",
    },
    source_text: FDD_SOURCE_TEXT,
  });
  assertTrue(validResult.valid, "Valid PDF: quote found in document");
  assertTrue(validResult.exact_quote_found, "Valid PDF: exact_quote_found=true");

  // Valid with page-level text
  const pageTexts = new Map<number, string>();
  pageTexts.set(47, "Page 47: Revenue Analysis\n\nThe FDD analysis confirms that SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year.");
  pageTexts.set(62, "Page 62: EBITDA Quality\n\nCash EBITDA is confirmed at £52m.");

  const validPageResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "SCG reported revenue of £181m for FY Mar-25",
    },
    source_text: FDD_SOURCE_TEXT,
    page_texts: pageTexts,
  });
  assertTrue(validPageResult.valid, "Valid PDF with page texts: quote on correct page");

  // Invalid: correct quote but WRONG page
  const wrongPageResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 62, // wrong page—quote is on page 47
      exact_quote: "SCG reported revenue of £181m for FY Mar-25",
    },
    source_text: FDD_SOURCE_TEXT,
    page_texts: pageTexts,
  });
  assertFalse(wrongPageResult.valid, "Wrong page: coordinate invalid");
  assertEqual(wrongPageResult.validation_method, "quote_not_on_stated_page", "Wrong page method");

  // Invalid: paraphrased quotation not in source
  const paraphrasedResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "Revenue was approximately 181 million for the fiscal year ending March 2025",
    },
    source_text: FDD_SOURCE_TEXT,
  });
  assertFalse(paraphrasedResult.valid, "Paraphrased quote: rejected");

  // Invalid: missing page
  const missingPageResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 0,
      exact_quote: "SCG reported revenue",
    },
    source_text: FDD_SOURCE_TEXT,
  });
  assertFalse(missingPageResult.valid, "Missing/invalid page: rejected");

  // Invalid: too-short quote (section title only)
  const shortQuoteResult = validatePdfCoordinate({
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "Revenue",
    },
    source_text: FDD_SOURCE_TEXT,
  });
  assertFalse(shortQuoteResult.valid, "Section-title-only quote: rejected");
}

// ---------------------------------------------------------------------------
// TEST 5-6: Workbook coordinate validation
// ---------------------------------------------------------------------------

function testWorkbookCoordinate(): void {
  console.log("\n═══ TEST 5-6: Workbook Coordinate Validation ═══");

  const sheets = ["FS Summary", "FS Summary (hardcoded)", "Revenue Build", "Assumptions"];

  // Valid: known sheet + valid cell
  const validResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "FS Summary",
      cell_or_range: "E42",
      displayed_value: 194,
      raw_value: 194000000,
    },
    available_sheets: sheets,
  });
  assertTrue(validResult.valid, "Valid workbook: sheet exists + cell format OK");

  // Valid: hardcoded sheet (prior/reference)
  const hardcodedResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "FS Summary (hardcoded)",
      cell_or_range: "E42",
    },
    available_sheets: sheets,
  });
  assertTrue(hardcodedResult.valid, "Hardcoded sheet: valid coordinate");

  // Invalid: missing sheet
  const missingSheetResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "",
      cell_or_range: "E42",
    },
  });
  assertFalse(missingSheetResult.valid, "Missing sheet: rejected");
  assertEqual(missingSheetResult.validation_method, "missing_sheet", "Missing sheet method");

  // Invalid: sheet not in workbook
  const unknownSheetResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "NonexistentTab",
      cell_or_range: "A1",
    },
    available_sheets: sheets,
  });
  assertFalse(unknownSheetResult.valid, "Unknown sheet: rejected");
  assertEqual(unknownSheetResult.validation_method, "sheet_not_in_workbook", "Unknown sheet method");

  // Invalid: missing cell
  const missingCellResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "FS Summary",
      cell_or_range: "",
    },
  });
  assertFalse(missingCellResult.valid, "Missing cell: rejected");

  // Invalid: bad cell format
  const badCellResult = validateWorkbookCoordinate({
    coordinate: {
      kind: "workbook",
      sheet: "FS Summary",
      cell_or_range: "total revenue row", // not a cell reference
    },
  });
  assertFalse(badCellResult.valid, "Invalid cell format: rejected");
}

// ---------------------------------------------------------------------------
// TEST 7-8: Gamma evidence against SCG claim (entity routing)
// ---------------------------------------------------------------------------

function testEntityRouting(): void {
  console.log("\n═══ TEST 7-8: Entity Applicability — Gamma vs SCG ═══");

  // Test 7: Gamma evidence against SCG claim — NO bridge → rejected
  const gammaToScgNoBridge = evaluateEntityApplicability({
    claim_entity: "SCG",
    evidence_entity: "Gamma",
    evidence_segment: null,
    evidence_role: "contradicting",
    bridges: undefined,
  });
  assertFalse(gammaToScgNoBridge.allowed, "Gamma→SCG without bridge: rejected");
  assertEqual(gammaToScgNoBridge.reason_code, "entity_bridge_missing", "Reason: entity_bridge_missing");
  assertFalse(gammaToScgNoBridge.direct_entity_match, "Not a direct match");

  // Test 8: Gamma evidence against SCG claim — WITH structured bridge
  const bridges = new Map<string, { bridge_evidence_id: string; rationale: string }>();
  bridges.set("gamma→scg", {
    bridge_evidence_id: "bridge-ev-001",
    rationale: "Gamma and SCG share channel distribution model per CDD section 4.2",
  });

  const gammaToScgWithBridge = evaluateEntityApplicability({
    claim_entity: "SCG",
    evidence_entity: "Gamma",
    evidence_segment: null,
    evidence_role: "contradicting",
    bridges,
  });
  assertTrue(gammaToScgWithBridge.allowed, "Gamma→SCG with bridge: allowed");
  assertEqual(gammaToScgWithBridge.bridge_evidence_id, "bridge-ev-001", "Bridge evidence ID preserved");
  assertEqual(gammaToScgWithBridge.reason_code, "entity_bridge_applied", "Reason: bridge_applied");

  // Market evidence as verifying → rejected
  const marketVerifying = evaluateEntityApplicability({
    claim_entity: "SCG",
    evidence_entity: "Market",
    evidence_segment: null,
    evidence_role: "verifying",
  });
  assertFalse(marketVerifying.allowed, "Market evidence as verifying: rejected");
  assertEqual(marketVerifying.reason_code, "market_evidence_not_company_specific", "Market reason");

  // Market evidence as contextual → allowed
  const marketContextual = evaluateEntityApplicability({
    claim_entity: "SCG",
    evidence_entity: "Market",
    evidence_segment: null,
    evidence_role: "contextual",
  });
  assertTrue(marketContextual.allowed, "Market evidence as contextual: allowed");

  // Direct match
  const directMatch = evaluateEntityApplicability({
    claim_entity: "SCG",
    evidence_entity: "SCG",
    evidence_segment: null,
    evidence_role: "contradicting",
  });
  assertTrue(directMatch.allowed, "Direct entity match: allowed");
  assertTrue(directMatch.direct_entity_match, "Direct match flag");
}

// ---------------------------------------------------------------------------
// TEST 9-10: IC self-verification + management material rejection
// ---------------------------------------------------------------------------

function testSourceRoleRestrictions(): void {
  console.log("\n═══ TEST 9-10: Source Role Restrictions ═══");

  // Test 9: IC memo verifying its own claim
  const icSelfVerify = evaluateAuthority({
    authority_class: "ic_memo",
    proposition_type: "financial",
    evidence_role: "verifying",
    claim_source_document_id: IC_MEMO_DOC_ID,
    evidence_document_id: IC_MEMO_DOC_ID,
  });
  assertFalse(icSelfVerify.allowed, "IC memo self-verification: rejected");
  assertEqual(icSelfVerify.reason_code, "ic_memo_self_verification", "IC self-verify reason");

  // Also rejected even if doc IDs differ (authority class check)
  const icDifferentDoc = evaluateAuthority({
    authority_class: "ic_memo",
    proposition_type: "financial",
    evidence_role: "contradicting",
    evidence_document_id: "other-doc",
  });
  assertFalse(icDifferentDoc.allowed, "IC memo as authority (any doc): rejected");

  // Test 10: Management material as independent authority
  const mgmtVerify = evaluateAuthority({
    authority_class: "management_material",
    proposition_type: "financial",
    evidence_role: "verifying",
    evidence_document_id: "mgmt-doc-001",
  });
  assertFalse(mgmtVerify.allowed, "Management material verifying: rejected");
  assertEqual(mgmtVerify.reason_code, "management_source_not_independent", "Mgmt reason");

  // Management material as supporting → allowed
  const mgmtSupporting = evaluateAuthority({
    authority_class: "management_material",
    proposition_type: "financial",
    evidence_role: "supporting",
    evidence_document_id: "mgmt-doc-001",
  });
  assertTrue(mgmtSupporting.allowed, "Management material supporting: allowed");

  // Information Memorandum contradicting → rejected
  const imContradict = evaluateAuthority({
    authority_class: "information_memorandum",
    proposition_type: "operating_metric",
    evidence_role: "contradicting",
    evidence_document_id: IM_DOC_ID,
  });
  assertFalse(imContradict.allowed, "Information Memorandum contradicting: rejected");
}

// ---------------------------------------------------------------------------
// TEST 11-12: Legal DD proposition-specific rules
// ---------------------------------------------------------------------------

function testLegalDdRules(): void {
  console.log("\n═══ TEST 11-12: Legal DD Proposition Rules ═══");

  // Test 11: Legal DD for change-of-control → allowed
  const legalForCoc = evaluateAuthority({
    authority_class: "legal_dd",
    proposition_type: "change_of_control",
    evidence_role: "verifying",
    evidence_document_id: LEGAL_DD_DOC_ID,
  });
  assertTrue(legalForCoc.allowed, "Legal DD for change-of-control: allowed");
  assertEqual(legalForCoc.reason_code, "legal_dd_for_legal_proposition", "Legal DD reason");

  // Legal DD for IP → allowed
  const legalForIp = evaluateAuthority({
    authority_class: "legal_dd",
    proposition_type: "ip",
    evidence_role: "verifying",
    evidence_document_id: LEGAL_DD_DOC_ID,
  });
  assertTrue(legalForIp.allowed, "Legal DD for IP: allowed");

  // Test 12: Legal DD for market-size proposition → rejected
  const legalForMarket = evaluateAuthority({
    authority_class: "legal_dd",
    proposition_type: "market_size",
    evidence_role: "verifying",
    evidence_document_id: LEGAL_DD_DOC_ID,
  });
  assertFalse(legalForMarket.allowed, "Legal DD for market_size: rejected");
  assertEqual(legalForMarket.reason_code, "authority_not_valid_for_proposition", "Legal for market reason");

  // Legal DD for financial proposition → rejected
  const legalForFinancial = evaluateAuthority({
    authority_class: "legal_dd",
    proposition_type: "revenue",
    evidence_role: "contradicting",
    evidence_document_id: LEGAL_DD_DOC_ID,
  });
  assertFalse(legalForFinancial.allowed, "Legal DD for revenue: rejected");
}

// ---------------------------------------------------------------------------
// TEST 13-14: Commercial CDD proposition-specific rules
// ---------------------------------------------------------------------------

function testCommercialCddRules(): void {
  console.log("\n═══ TEST 13-14: Commercial CDD Proposition Rules ═══");

  // Test 13: Commercial CDD for market-level commercial proposition → allowed
  const cddForMarket = evaluateAuthority({
    authority_class: "commercial_cdd",
    proposition_type: "market_position",
    evidence_role: "verifying",
    evidence_document_id: ALTMAN_CDD_DOC_ID,
  });
  assertTrue(cddForMarket.allowed, "Commercial CDD for market_position: allowed");
  assertEqual(cddForMarket.reason_code, "commercial_cdd_for_market_proposition", "CDD market reason");

  // Test 14: Commercial CDD for legal proposition → rejected
  const cddForLegal = evaluateAuthority({
    authority_class: "commercial_cdd",
    proposition_type: "contractual",
    evidence_role: "verifying",
    evidence_document_id: ALTMAN_CDD_DOC_ID,
  });
  assertFalse(cddForLegal.allowed, "Commercial CDD for contractual: rejected");

  // Commercial CDD for financial proposition → rejected
  const cddForFinancial = evaluateAuthority({
    authority_class: "commercial_cdd",
    proposition_type: "revenue",
    evidence_role: "contradicting",
    evidence_document_id: ALTMAN_CDD_DOC_ID,
  });
  assertFalse(cddForFinancial.allowed, "Commercial CDD for revenue: rejected");

  // Current model for financial → allowed
  const modelForFinancial = evaluateAuthority({
    authority_class: "current_financial_model",
    proposition_type: "current_forecast",
    evidence_role: "verifying",
    evidence_document_id: SCG_MODEL_DOC_ID,
  });
  assertTrue(modelForFinancial.allowed, "Current model for current_forecast: allowed");
}

// ---------------------------------------------------------------------------
// TEST 15: Canonical evidence persistence/reload parity
// ---------------------------------------------------------------------------

function testPersistenceReload(): void {
  console.log("\n═══ TEST 15: Persistence / Reload Parity ═══");

  // Create a canonical evidence record via admitEvidence
  const result = admitEvidence({
    document_id: PWC_FDD_DOC_ID,
    document_name: PWC_FDD_NAME,
    authority_class: "vendor_financial_dd",
    source_type: "pdf",
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year",
    },
    target_entity: "SCG",
    target_segment: null,
    claim_entity: "SCG",
    proposition_type: "financial",
    evidence_role: "verifying",
    source_text: FDD_SOURCE_TEXT,
    proposition: {
      metric: "revenue",
      qualitative_proposition: null,
      period: "FY Mar-25",
      scope: "Total Group",
      unit: "£m",
      currency: "GBP",
      scale: "millions",
      actual_forecast_status: "actual",
      accounting_basis: null,
      value: 181,
    },
  });

  assertTrue(result.admitted, "Admitted for persistence test");
  assertNotNull(result.evidence_record, "Record created");

  // Serialize → Deserialize
  const serialized = serializeEvidenceRecord(result.evidence_record!);
  const jsonStr = JSON.stringify(serialized);
  const parsed = JSON.parse(jsonStr);
  const reloaded = deserializeEvidenceRecord(parsed);

  assertNotNull(reloaded, "Deserialized successfully");
  assertEqual(reloaded!.evidence_id, result.evidence_record!.evidence_id, "evidence_id stable");
  assertEqual(reloaded!.source.document_id, PWC_FDD_DOC_ID, "document_id preserved");
  assertEqual(reloaded!.source.authority_class, "vendor_financial_dd", "authority_class preserved");
  assertEqual((reloaded!.coordinate as PdfCoordinate).page, 47, "page preserved");
  assertEqual(
    (reloaded!.coordinate as PdfCoordinate).exact_quote,
    "SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year",
    "exact_quote preserved"
  );
  assertEqual(reloaded!.target.entity, "SCG", "entity preserved");
  assertEqual(reloaded!.evidence_role, "verifying", "evidence_role preserved");
  assertTrue(reloaded!.authority_decision.allowed, "authority_decision preserved");
  assertTrue(reloaded!.entity_applicability.allowed, "entity_applicability preserved");
  assertTrue(reloaded!.entity_applicability.direct_entity_match, "direct_entity_match preserved");
  assertEqual(reloaded!.proposition.value, 181, "proposition.value preserved");

  // Re-derive ID from same inputs → stable
  const id2 = generateEvidenceId({
    document_id: PWC_FDD_DOC_ID,
    coordinate: {
      kind: "pdf",
      page: 47,
      exact_quote: "SCG reported revenue of £181m for FY Mar-25, representing growth of 6.8% year-on-year",
    },
    proposition_type: "financial",
    evidence_role: "verifying",
  });
  assertEqual(result.evidence_record!.evidence_id, id2, "ID deterministic on re-derivation");
}

// ---------------------------------------------------------------------------
// JSON FIXTURE OUTPUT (6 representative records)
// ---------------------------------------------------------------------------

function generateFixtureOutput(): void {
  console.log("\n═══ JSON Fixture Output ═══");

  const fixtures: object[] = [];

  // 1. Admitted model record
  const modelResult = admitEvidence({
    document_id: SCG_MODEL_DOC_ID,
    document_name: SCG_MODEL_NAME,
    authority_class: "current_financial_model",
    source_type: "workbook",
    coordinate: { kind: "workbook", sheet: "FS Summary", cell_or_range: "E42", displayed_value: 194, raw_value: 194000000 },
    target_entity: "SCG", target_segment: null, claim_entity: "SCG",
    proposition_type: "current_forecast", evidence_role: "verifying",
    available_sheets: ["FS Summary", "FS Summary (hardcoded)", "Revenue Build"],
    proposition: { metric: "revenue", qualitative_proposition: null, period: "FY Mar-26", scope: "Total Group", unit: "£m", currency: "GBP", scale: "millions", actual_forecast_status: "forecast", accounting_basis: null, value: 194 },
  });
  fixtures.push({ label: "admitted_model", ...modelResult });

  // 2. Admitted Legal DD record
  const legalResult = admitEvidence({
    document_id: LEGAL_DD_DOC_ID,
    document_name: LEGAL_DD_NAME,
    authority_class: "legal_dd",
    source_type: "pdf",
    coordinate: { kind: "pdf", page: 23, exact_quote: "standard change-of-control clause requiring counterparty consent for 3 of the 12 material customer contracts" },
    target_entity: "SCG", target_segment: null, claim_entity: "SCG",
    proposition_type: "change_of_control", evidence_role: "verifying",
    source_text: LEGAL_DD_SOURCE_TEXT,
    proposition: { metric: null, qualitative_proposition: "Change-of-control requires consent for 3/12 contracts", period: null, scope: null, unit: null, currency: null, scale: null, actual_forecast_status: "not_applicable", accounting_basis: null, value: null },
  });
  fixtures.push({ label: "admitted_legal_dd", ...legalResult });

  // 3. Admitted commercial CDD record
  const cddResult = admitEvidence({
    document_id: ALTMAN_CDD_DOC_ID,
    document_name: ALTMAN_CDD_NAME,
    authority_class: "commercial_cdd",
    source_type: "pdf",
    coordinate: { kind: "pdf", page: 8, exact_quote: "The UK managed services market is estimated at £12.4bn in 2025, growing at approximately 7% per annum" },
    target_entity: "SCG", target_segment: null, claim_entity: "SCG",
    proposition_type: "market_size", evidence_role: "verifying",
    source_text: ALTMAN_SOURCE_TEXT,
    proposition: { metric: "market_size", qualitative_proposition: null, period: "2025", scope: "UK Managed Services", unit: "£bn", currency: "GBP", scale: "billions", actual_forecast_status: "actual", accounting_basis: null, value: 12.4 },
  });
  fixtures.push({ label: "admitted_commercial_cdd", ...cddResult });

  // 4. Gamma-to-SCG rejection (no bridge)
  const gammaRejection = admitEvidence({
    document_id: ALTMAN_CDD_DOC_ID,
    document_name: ALTMAN_CDD_NAME,
    authority_class: "commercial_cdd",
    source_type: "pdf",
    coordinate: { kind: "pdf", page: 14, exact_quote: "Gamma holds an estimated 4.2% share of the UK unified communications market" },
    target_entity: "Gamma", target_segment: null, claim_entity: "SCG",
    proposition_type: "market_position", evidence_role: "contradicting",
    source_text: ALTMAN_SOURCE_TEXT,
    proposition: { metric: "market_share", qualitative_proposition: null, period: "2025", scope: "UK UCaaS", unit: "%", currency: null, scale: null, actual_forecast_status: "actual", accounting_basis: null, value: 4.2 },
  });
  fixtures.push({ label: "rejected_gamma_to_scg", ...gammaRejection });

  // 5. IC self-verification rejection
  const icSelfResult = admitEvidence({
    document_id: IC_MEMO_DOC_ID,
    document_name: IC_MEMO_NAME,
    authority_class: "ic_memo",
    source_type: "pdf",
    coordinate: { kind: "pdf", page: 12, exact_quote: "SCG is expected to deliver £194m revenue" },
    target_entity: "SCG", target_segment: null, claim_entity: "SCG",
    proposition_type: "financial", evidence_role: "verifying",
    claim_source_document_id: IC_MEMO_DOC_ID,
    source_text: "Page 12:\nSCG is expected to deliver £194m revenue",
    proposition: { metric: "revenue", qualitative_proposition: null, period: "FY Mar-26", scope: null, unit: "£m", currency: "GBP", scale: "millions", actual_forecast_status: "forecast", accounting_basis: null, value: 194 },
  });
  fixtures.push({ label: "rejected_ic_self_verification", ...icSelfResult });

  // 6. Invalid coordinate rejection
  const invalidCoordResult = admitEvidence({
    document_id: PWC_FDD_DOC_ID,
    document_name: PWC_FDD_NAME,
    authority_class: "vendor_financial_dd",
    source_type: "pdf",
    coordinate: { kind: "pdf", page: 99, exact_quote: "This quote does not exist in the FDD report" },
    target_entity: "SCG", target_segment: null, claim_entity: "SCG",
    proposition_type: "financial", evidence_role: "verifying",
    source_text: FDD_SOURCE_TEXT,
    proposition: { metric: "revenue", qualitative_proposition: null, period: "FY Mar-25", scope: null, unit: "£m", currency: "GBP", scale: "millions", actual_forecast_status: "actual", accounting_basis: null, value: 181 },
  });
  fixtures.push({ label: "rejected_invalid_coordinate", ...invalidCoordResult });

  console.log(JSON.stringify(fixtures, null, 2));
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

export function runMatF02IntegrationTests(): { passed: number; failed: number } {
  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║   MAT-F02 Integration Tests — Coordinate-Backed Evidence     ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝");

  passed = 0;
  failed = 0;

  testAuthorityClassification();
  testPdfCoordinate();
  testWorkbookCoordinate();
  testEntityRouting();
  testSourceRoleRestrictions();
  testLegalDdRules();
  testCommercialCddRules();
  testPersistenceReload();
  generateFixtureOutput();

  console.log(`\n${"─".repeat(68)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed === 0) {
    console.log("  ✅ ALL MAT-F02 INTEGRATION TESTS PASSED");
  } else {
    console.log("  ❌ SOME TESTS FAILED");
  }
  console.log(`${"─".repeat(68)}\n`);

  return { passed, failed };
}
