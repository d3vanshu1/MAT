/**
 * MAT-F02B Gate Enforcement Tests
 *
 * Proves that the evidence admission gate CONTROLS the claim-linkage outcome:
 *   - Rejected evidence cannot produce Q4-eligible results
 *   - Only admitted evidence reaches classifyClaimLinkage
 *   - Admitted evidence IDs and coordinates survive downstream
 *
 * These tests simulate the exact production logic from ReplayClaimLinkage's
 * candidate loop, including the gate-override and filtered-evidence paths.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f02b-gate-enforcement.test.ts
 */

import {
  admitCandidateEvidence,
  type LegacyEvidenceEntry,
  type EvidenceAdmissionContext,
  type CandidateEvidenceAdmissionResult,
} from "../evidence-admission-boundary.js";
import {
  classifyClaimLinkage,
  type ClaimLinkageResult,
} from "../claim-linkage.js";

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
// Fixtures
// ---------------------------------------------------------------------------

const SCG_CLAIM_ENTITY = "SCG";
const SCG_IC_DOC_ID = "aaaaaaaa-1111-4000-8000-111111111111";
const MODEL_DOC_ID = "bbbbbbbb-2222-4000-8000-222222222222";
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

// Claim map fixture — mimics what ReplayClaimLinkage builds
const CLAIM_ID = "claim-scg-rev-fy26-001";
const claimMap = new Map<string, any>([
  [CLAIM_ID, {
    claim_id: CLAIM_ID,
    verbatim_snippet: "Revenue for FY2026 is projected at £191.2m",
    metric: "revenue",
    period: "FY2026",
    scope_qualifier: "group",
    entity: "SCG",
    value: 191.2,
    unit: "GBP_millions",
    claim_category: "financial",
    claim_type: "growth_quality",
    ic_document_id: SCG_IC_DOC_ID,
    ic_document_filename: "SCG IC Memo - Final.pdf",
    memo_version: "3rd IC",
  }],
]);

/**
 * Simulates the exact production logic from ReplayClaimLinkage's candidate loop.
 * This is the function under test — it mirrors what happens in production.
 */
function simulateProductionCandidateLoop(params: {
  finding_id: string;
  corpus_index: number;
  title: string;
  source_tag: string | null;
  finding_kind: string | null;
  originating_claim_id: string | null;
  evidence: LegacyEvidenceEntry[];
  source_docs: string[];
  claim_type: string | null;
}): { result: ClaimLinkageResult; evidenceAdmission: CandidateEvidenceAdmissionResult | null; admittedEvidenceIds: string[] } {
  const { finding_id, corpus_index, title, source_tag, finding_kind, originating_claim_id, evidence, source_docs, claim_type } = params;

  // Step 1: Admission gate (same as production)
  const rawEvidenceEntries = evidence;
  let evidenceAdmission: CandidateEvidenceAdmissionResult | null = null;

  if (rawEvidenceEntries.length > 0) {
    const primaryClaimId = originating_claim_id;
    const resolvedClaim = primaryClaimId ? claimMap.get(primaryClaimId) : null;

    evidenceAdmission = admitCandidateEvidence(
      rawEvidenceEntries,
      {
        claim_entity: resolvedClaim?.entity ?? resolvedClaim?.scope_qualifier ?? "SCG",
        claim_source_document_id: resolvedClaim?.ic_document_id ?? null,
        proposition_type: resolvedClaim?.claim_category ?? resolvedClaim?.claim_type ?? claim_type ?? "unclassified",
        candidate_reference: finding_id,
        source_text: "",
      },
      {
        finding_kind,
        finding_id,
      },
    );
  }

  // Step 2: Gate enforcement — all rejected → override
  if (evidenceAdmission && rawEvidenceEntries.length > 0 && !evidenceAdmission.has_admitted_evidence) {
    const authorityClass = evidenceAdmission.rejected.length > 0
      ? evidenceAdmission.rejected[0].authority_class
      : "unknown_or_other" as const;
    const rejectionReasons = evidenceAdmission.rejected.map(r => r.rejection_reason).join(", ");

    const gatedResult: ClaimLinkageResult = {
      finding_id,
      corpus_index,
      title,
      claim_linkage_disposition: "invalid_evidence_authority",
      q4_eligible: false,
      claim_provenance: null,
      authority_class: authorityClass as any,
      authority_valid: false,
      authority_rationale: `MAT-F02B: All evidence rejected by canonical admission gate — ${rejectionReasons}`,
      reason: `Evidence admission gate: all ${rawEvidenceEntries.length} entries rejected (${rejectionReasons})`,
      evidence_source_type: source_tag,
    };

    return { result: gatedResult, evidenceAdmission, admittedEvidenceIds: [] };
  }

  // Step 3: Derive filtered evidence for classifyClaimLinkage
  let filteredEvidence: string | null = null;
  let filteredDocFilename: string | null = source_docs[0] ?? null;
  let admittedEvidenceIds: string[] = [];

  if (evidenceAdmission && evidenceAdmission.has_admitted_evidence) {
    const admittedTexts = evidenceAdmission.admitted.map(a => {
      if (a.coordinate.kind === "workbook") {
        return `[${a.source_document_name}] ${a.coordinate.sheet}!${a.coordinate.cell_or_range}: ${a.canonical_record.proposition.value ?? ""}`;
      }
      if (a.coordinate.kind === "pdf") {
        return `[${a.source_document_name}] p.${a.coordinate.page}: "${a.coordinate.exact_quote}"`;
      }
      return `[${a.source_document_name}]`;
    });
    filteredEvidence = admittedTexts.join(" | ");
    filteredDocFilename = evidenceAdmission.admitted[0].source_document_name;
    admittedEvidenceIds = evidenceAdmission.admitted.map(a => a.evidence_id);
  }

  // Step 4: classifyClaimLinkage with filtered evidence only
  const result = classifyClaimLinkage(
    {
      finding_id,
      corpus_index,
      title,
      source_tag,
      source_docs,
      originating_claim_id,
      claim_ids: originating_claim_id ? [originating_claim_id] : null,
      claim_type,
      finding_kind,
      evidence: filteredEvidence,
      doc_filename: filteredDocFilename,
      doc_type: null,
    },
    claimMap,
    new Set(),
    null,
  );

  return { result, evidenceAdmission, admittedEvidenceIds };
}

// ===========================================================================
// TEST 1: Gamma evidence rejected by gate cannot produce Q4-eligible result
// ===========================================================================

console.log("\n=== Test 1: Gamma evidence rejected → Q4-ineligible ===");
{
  const { result, evidenceAdmission } = simulateProductionCandidateLoop({
    finding_id: "f-gate-001",
    corpus_index: 0,
    title: "Market share divergence",
    source_tag: "consultant_report",
    finding_kind: "data_divergence",
    originating_claim_id: CLAIM_ID,
    evidence: [GAMMA_CDD_EVIDENCE],
    source_docs: ["Altman Solon CDD - Gamma.pdf"],
    claim_type: "commercial",
  });

  assertEqual(result.q4_eligible, false, "Gamma evidence → Q4-ineligible");
  assertEqual(result.claim_linkage_disposition, "invalid_evidence_authority", "Disposition is invalid_evidence_authority");
  assert(result.authority_rationale.includes("MAT-F02B"), "Rationale mentions MAT-F02B gate");
  assert(result.reason.includes("entity_bridge_missing"), "Reason includes entity_bridge_missing");
  assertEqual(evidenceAdmission!.has_admitted_evidence, false, "No evidence admitted");
  assertEqual(evidenceAdmission!.rejected.length, 1, "1 rejection recorded");
  assertEqual(evidenceAdmission!.rejected[0].rejection_reason, "entity_bridge_missing", "Rejection reason preserved");
}

// ===========================================================================
// TEST 2: IC self-verification cannot produce Q4-eligible result
// ===========================================================================

console.log("\n=== Test 2: IC memo self-verification → Q4-ineligible ===");
{
  const { result, evidenceAdmission } = simulateProductionCandidateLoop({
    finding_id: "f-gate-002",
    corpus_index: 1,
    title: "Revenue claim from IC memo",
    source_tag: "ic_memo",
    finding_kind: "data_divergence",
    originating_claim_id: CLAIM_ID,
    evidence: [IC_MEMO_SELF_EVIDENCE],
    source_docs: ["SCG IC Memo - Final.pdf"],
    claim_type: "financial",
  });

  assertEqual(result.q4_eligible, false, "IC self-verification → Q4-ineligible");
  assertEqual(result.claim_linkage_disposition, "invalid_evidence_authority", "Disposition is invalid_evidence_authority");
  assert(result.reason.includes("ic_memo_self_verification"), "Reason includes ic_memo_self_verification");
  assertEqual(evidenceAdmission!.has_admitted_evidence, false, "No evidence admitted");
}

// ===========================================================================
// TEST 3: Mixed admitted+rejected uses only admitted evidence
// ===========================================================================

console.log("\n=== Test 3: Mixed evidence — only admitted item used ===");
{
  const { result, evidenceAdmission, admittedEvidenceIds } = simulateProductionCandidateLoop({
    finding_id: "f-gate-003",
    corpus_index: 2,
    title: "Revenue FY26 model vs memo",
    source_tag: "financial_model",
    finding_kind: "data_divergence",
    originating_claim_id: CLAIM_ID,
    evidence: [VALID_MODEL_EVIDENCE, IC_MEMO_SELF_EVIDENCE], // one valid, one self-ref
    source_docs: ["Financial Model v3.2", "SCG IC Memo - Final.pdf"],
    claim_type: "financial",
  });

  // The model evidence should be admitted, IC memo rejected
  assertEqual(evidenceAdmission!.admitted.length, 1, "1 evidence admitted (model)");
  assertEqual(evidenceAdmission!.rejected.length, 1, "1 evidence rejected (IC memo)");
  assertEqual(evidenceAdmission!.admitted[0].authority_class, "current_financial_model", "Admitted is model");
  assertEqual(evidenceAdmission!.rejected[0].rejection_reason, "ic_memo_self_verification", "Rejected is IC self-ref");

  // The result should NOT be gate-overridden (has admitted evidence)
  assert(result.claim_linkage_disposition !== "invalid_evidence_authority", "Not overridden to invalid_evidence_authority");
  // The filtered evidence text should contain only the model entry
  // (It went through classifyClaimLinkage with admitted-only evidence)
  assert(admittedEvidenceIds.length === 1, "1 admitted evidence ID");
  assert(admittedEvidenceIds[0].startsWith("ev-v1-"), "Admitted evidence ID has canonical prefix");
}

// ===========================================================================
// TEST 4: Valid admitted model evidence remains eligible under linkage rules
// ===========================================================================

console.log("\n=== Test 4: Valid model evidence → claim-linked eligible ===");
{
  const { result, evidenceAdmission, admittedEvidenceIds } = simulateProductionCandidateLoop({
    finding_id: "f-gate-004",
    corpus_index: 3,
    title: "Revenue £184.4m vs £191.2m",
    source_tag: "financial_model",
    finding_kind: "data_divergence",
    originating_claim_id: CLAIM_ID,
    evidence: [VALID_MODEL_EVIDENCE],
    source_docs: ["Financial Model v3.2"],
    claim_type: "financial",
  });

  // All evidence admitted
  assertEqual(evidenceAdmission!.has_admitted_evidence, true, "Evidence admitted");
  assertEqual(evidenceAdmission!.admitted.length, 1, "Exactly 1 admitted");

  // classifyClaimLinkage should produce a claim-linked result (not gate-overridden)
  assert(result.claim_linkage_disposition !== "invalid_evidence_authority", "Not gate-overridden");
  // It should be Q4-eligible (data_divergence → materially_changed or similar)
  assert(
    result.claim_linkage_disposition.startsWith("claim_linked_"),
    `Disposition is claim-linked (got: ${result.claim_linkage_disposition})`
  );
  // Authority should be valid
  assertEqual(result.authority_valid, true, "Authority valid for financial model");
  // Admitted evidence IDs should be present
  assert(admittedEvidenceIds.length === 1, "1 admitted evidence ID available downstream");
  assert(admittedEvidenceIds[0].startsWith("ev-v1-"), "Evidence ID has canonical format");
}

// ===========================================================================
// TEST 5: Linkage result retains admitted evidence ID and coordinate
// ===========================================================================

console.log("\n=== Test 5: Admitted evidence ID and coordinate retained ===");
{
  const { result, evidenceAdmission, admittedEvidenceIds } = simulateProductionCandidateLoop({
    finding_id: "f-gate-005",
    corpus_index: 4,
    title: "Revenue model check",
    source_tag: "financial_model",
    finding_kind: "confirmed_alignment",
    originating_claim_id: CLAIM_ID,
    evidence: [VALID_MODEL_EVIDENCE],
    source_docs: ["Financial Model v3.2"],
    claim_type: "financial",
  });

  // Verify admitted evidence ID is stable and content-derived
  const evidenceId = admittedEvidenceIds[0];
  assert(!!evidenceId, "Evidence ID present");
  assert(evidenceId.startsWith("ev-v1-"), "Evidence ID has version prefix");
  assert(evidenceId.length > 10, "Evidence ID has sufficient entropy");

  // Verify coordinate is retained in the admission record
  const admittedRecord = evidenceAdmission!.admitted[0];
  assertEqual(admittedRecord.coordinate.kind, "workbook", "Coordinate type preserved");
  if (admittedRecord.coordinate.kind === "workbook") {
    assertEqual(admittedRecord.coordinate.sheet, "FS Summary", "Sheet preserved");
    assertEqual(admittedRecord.coordinate.cell_or_range, "B12", "Cell preserved");
  }

  // Verify the same evidence ID would be produced on a re-run (idempotent)
  const { admittedEvidenceIds: rerunIds } = simulateProductionCandidateLoop({
    finding_id: "f-gate-005",
    corpus_index: 4,
    title: "Revenue model check",
    source_tag: "financial_model",
    finding_kind: "confirmed_alignment",
    originating_claim_id: CLAIM_ID,
    evidence: [VALID_MODEL_EVIDENCE],
    source_docs: ["Financial Model v3.2"],
    claim_type: "financial",
  });
  assertEqual(rerunIds[0], evidenceId, "Evidence ID is stable across re-runs (content-derived)");
}

// ===========================================================================
// Final summary
// ===========================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`MAT-F02B Gate Enforcement Tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
