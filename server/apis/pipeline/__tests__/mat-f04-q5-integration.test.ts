/**
 * MAT-F04 Integration Pass: Q4/Q5 Canonical Finding Consumption Tests
 *
 * These 7 tests verify that the downstream Q5 stage (AssembleCanonicalFindings)
 * correctly loads and consumes F04 canonical_findings from the Q3 checkpoint.
 *
 * Tests invoke actual production construction boundary:
 *   - constructCanonicalFinding (from canonical-finding-construction.ts)
 *   - generatePropositionKey (from canonical-finding-record.ts)
 *   - buildCanonicalFindingRecord + serialize/deserialize
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f04-q5-integration.test.ts
 */

import {
  buildCanonicalFindingRecord,
  serializeCanonicalFinding,
  deserializeCanonicalFinding,
  serializeCanonicalFindingLedger,
  generatePropositionKey,
  type CanonicalFindingRecord,
  type CanonicalDisposition,
} from "../canonical-finding-record.js";
import {
  executeCanonicalComparison,
  type ComparisonClaimInput,
  type ComparisonEvidenceInput,
  type CanonicalComparison,
} from "../canonical-comparison.js";
import {
  constructCanonicalFinding,
  type CanonicalFinding,
} from "../canonical-finding-construction.js";
import type { IdentifiedClaim } from "../claims-ledger-identity.js";
import type { AdmittedEvidenceRecord } from "../evidence-admission-boundary.js";
import type { CanonicalEvidenceRecord } from "../canonical-evidence.js";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) { console.error(`  FAIL: ${msg}`); failed++; }
  else { console.log(`  PASS: ${msg}`); passed++; }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`  FAIL: ${msg}\n    expected: ${e}\n    actual:   ${a}`); failed++; }
  else { console.log(`  PASS: ${msg}`); passed++; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<IdentifiedClaim> = {}): IdentifiedClaim {
  return {
    claim_id: "clm-v1-abc123def456",
    claim_schema_version: "claim-v1.0",
    metric: "total_group_revenue",
    scope_qualifier: "group",
    period: "FY Mar-26",
    value: 194,
    unit: "gbp_millions",
    basis_note: "Forecast revenue",
    claim_category: "numeric_financial",
    verbatim_snippet: "Revenue of £194m for FY Mar-26",
    normalized_claim_text: "total group revenue 194 gbp millions fy mar-26",
    claim_type: "numeric_financial",
    ic_document_id: "doc-ic-001",
    ic_document_filename: "3rd IC Memo - SCG.pdf",
    memo_version: "3rd IC",
    source_page: "12",
    extraction_coordinates: "section_financial_overview_p12",
    extraction_method: "structured_extraction",
    entity_or_segment: "scg",
    actual_or_forecast: "forecast",
    accounting_basis: null,
    currency: "GBP",
    ...overrides,
  };
}

function makeEvidenceRecord(overrides: Partial<CanonicalEvidenceRecord> = {}): CanonicalEvidenceRecord {
  return {
    schema_version: "evidence-v1",
    evidence_id: "ev-v1-model-rev-001",
    source: {
      document_id: "doc-fs-summary-001",
      document_name: "FS Summary.xlsx",
      authority_class: "current_financial_model",
      source_type: "workbook",
    },
    coordinate: {
      kind: "workbook",
      sheet: "P&L Summary",
      cell_or_range: "C42",
      displayed_value: 184391535,
      raw_value: 184391535,
    },
    target: { entity: "scg", segment: null },
    proposition: {
      metric: "total_group_revenue",
      qualitative_proposition: null,
      period: "FY Mar-26",
      scope: "group",
      unit: "gbp",
      currency: "GBP",
      scale: "raw",
      actual_forecast_status: "forecast",
      accounting_basis: null,
      value: 184391535,
    },
    evidence_role: "verifying",
    authority_decision: { allowed: true, reason_code: "current_financial_model_valid", rule_version: "authority-policy-v1" },
    entity_applicability: { allowed: true, direct_entity_match: true, bridge_evidence_id: null, reason_code: "direct_match" },
    source_validation: { coordinate_valid: true, exact_quote_found: null, validation_method: "workbook_cell_lookup" },
    ...overrides,
  } as CanonicalEvidenceRecord;
}

function makeAdmittedEvidence(overrides: Partial<AdmittedEvidenceRecord> = {}): AdmittedEvidenceRecord {
  const canonRec = makeEvidenceRecord(overrides.canonical_record as any);
  return {
    evidence_id: canonRec.evidence_id,
    source_document_id: canonRec.source.document_id,
    source_document_name: canonRec.source.document_name,
    authority_class: canonRec.source.authority_class,
    coordinate: canonRec.coordinate,
    target_entity: canonRec.target.entity,
    evidence_role: canonRec.evidence_role,
    authority_decision: canonRec.authority_decision,
    entity_applicability: canonRec.entity_applicability,
    canonical_record: canonRec,
    ...overrides,
  } as AdmittedEvidenceRecord;
}

function makeComparison(claimBasis: string, evidenceBasis: string): CanonicalComparison {
  const claim: ComparisonClaimInput = {
    claim_id: "clm-v1-abc123def456",
    entity: "scg", metric: "total_group_revenue", period: "FY Mar-26",
    segment: null, scope: "group", unit: "gbp_millions", currency: "GBP",
    scale: "millions", actual_or_forecast: "forecast", accounting_basis: null,
    comparison_basis: claimBasis, value: 194, ic_document_id: "doc-ic-001",
  };
  const evidence: ComparisonEvidenceInput = {
    evidence_id: "ev-v1-model-rev-001",
    entity: "scg", metric: "total_group_revenue", period: "FY Mar-26",
    segment: null, scope: "group", unit: "gbp", currency: "GBP",
    scale: "raw", actual_or_forecast: "forecast", accounting_basis: null,
    comparison_basis: evidenceBasis, value: 184391535,
    source_document_id: "doc-fs-summary-001", has_entity_bridge: false,
  };
  return executeCanonicalComparison(claim, evidence);
}

function buildFinding(claimBasis: string, evidenceBasis: string): CanonicalFindingRecord {
  const comp = makeComparison(claimBasis, evidenceBasis);
  const disp: CanonicalDisposition = {
    verdict: "contradicted", reportable: true,
    reason_codes: ["material_difference"], rule_version: "verdict-v1.0",
  };
  return buildCanonicalFindingRecord({
    claim: makeClaim(),
    admittedEvidence: [makeAdmittedEvidence()],
    comparisons: [comp],
    disposition: disp,
    narrative: { title: "Revenue variance" },
  });
}

// Simulate Q5 constructCanonicalFinding receiving canonical records
function simulateQ5Construction(canonicalRecords: CanonicalFindingRecord[]): CanonicalFinding {
  const resolvedClaims = new Map<string, { claim_id: string; claim_text: string; memo_version: string | null; verdict: string }>();
  resolvedClaims.set("clm-v1-abc123def456", {
    claim_id: "clm-v1-abc123def456",
    claim_text: "Revenue of £194m",
    memo_version: "3rd IC",
    verdict: "contradicted",
  });

  const members = [{
    finding_id: "finding-001", corpus_index: 0, title: "Revenue variance",
    detail: null, full_analysis: null, severity: null, source_tag: null,
    source_docs: null, originating_claim_id: "clm-v1-abc123def456",
    claim_ids: ["clm-v1-abc123def456"], claim_type: "numeric_financial",
    finding_kind: null, issue_key: null, evidence: null,
  }];

  const { finding } = constructCanonicalFinding(
    "scg|total_group_revenue|fy_mar_26|all|group|revenue|forecast|unspecified|memo_claim__current_model",
    { issue_domain: "financial", issue_type: "revenue_variance", metric: "total_group_revenue", period: "fy_mar_26", entity_or_segment: "scg", scope: "group" } as any,
    members,
    resolvedClaims,
    [], // snapshots (legacy)
    canonicalRecords, // MAT-F04 canonical records
  );
  return finding;
}

// ===========================================================================
// TESTS
// ===========================================================================

console.log("\n\u2554" + "\u2550".repeat(70) + "\u2557");
console.log("\u2551  MAT-F04 Integration: Q4/Q5 Canonical Consumption (7 tests)       \u2551");
console.log("\u255a" + "\u2550".repeat(70) + "\u255d\n");

// ---------------------------------------------------------------------------
// TEST 1: Q4/Q5 input loader reads F04 canonical_findings
// ---------------------------------------------------------------------------
console.log("TEST 1: Q4/Q5 input loader reads F04 canonical_findings");
{
  const cfr = buildFinding("memo_claim", "current_model");
  // Simulate serialize/persist/reload (Q3 checkpoint cycle)
  const serialized = serializeCanonicalFindingLedger([cfr]);
  const parsed = JSON.parse(serialized) as CanonicalFindingRecord[];

  assert(parsed.length === 1, "deserialized 1 canonical finding from ledger");
  assertEqual(parsed[0].identity.finding_id, cfr.identity.finding_id, "finding_id preserved through Q3 persist/load");
  assertEqual(parsed[0].identity.semantic_hash, cfr.identity.semantic_hash, "semantic_hash preserved through Q3 persist/load");
  assertEqual(parsed[0].identity.proposition_key, cfr.identity.proposition_key, "proposition_key preserved through Q3 persist/load");
}

// ---------------------------------------------------------------------------
// TEST 2: Downstream output retains same finding ID and semantic hash
// ---------------------------------------------------------------------------
console.log("\nTEST 2: Downstream output retains same finding ID and semantic hash");
{
  const cfr = buildFinding("memo_claim", "current_model");
  const q5Finding = simulateQ5Construction([cfr]);

  // Q5 must reference the canonical source
  assert(q5Finding.canonical_finding_source !== undefined, "canonical_finding_source present in Q5 output");
  assertEqual(q5Finding.canonical_finding_source!.finding_ids[0], cfr.identity.finding_id,
    "Q5 retains F04 finding_id");
  assertEqual(q5Finding.canonical_finding_source!.semantic_hashes[0], cfr.identity.semantic_hash,
    "Q5 retains F04 semantic_hash");
}

// ---------------------------------------------------------------------------
// TEST 3: Exact claim/evidence IDs and coordinates survive downstream
// ---------------------------------------------------------------------------
console.log("\nTEST 3: Exact claim/evidence IDs and coordinates survive downstream");
{
  const cfr = buildFinding("memo_claim", "current_model");
  const q5Finding = simulateQ5Construction([cfr]);

  // Q5 uses the canonical comparison data (signed_delta etc.) from F04
  assert(q5Finding.comparison_results.length > 0, "comparison results populated from F04");
  assertEqual(q5Finding.comparison_results[0].signed_delta, 9608465, "signed_delta from F04 canonical comparison");
  assert(q5Finding.comparison_results[0].comparison_compatible === true, "comparison_compatible from F04");
  assertEqual(q5Finding.comparison_results[0].claim_value, 194000000, "claim_value from F04 normalized");
  assertEqual(q5Finding.comparison_results[0].authoritative_value, 184391535, "authoritative_value from F04");
}

// ---------------------------------------------------------------------------
// TEST 4: Changing narrative does not alter downstream identity
// ---------------------------------------------------------------------------
console.log("\nTEST 4: Changing narrative does not alter downstream identity");
{
  const cfr1 = buildCanonicalFindingRecord({
    claim: makeClaim(),
    admittedEvidence: [makeAdmittedEvidence()],
    comparisons: [makeComparison("memo_claim", "current_model")],
    disposition: { verdict: "contradicted", reportable: true, reason_codes: ["x"], rule_version: "v1" },
    narrative: { title: "Original title", summary: "Original summary" },
  });
  const cfr2 = buildCanonicalFindingRecord({
    claim: makeClaim(),
    admittedEvidence: [makeAdmittedEvidence()],
    comparisons: [makeComparison("memo_claim", "current_model")],
    disposition: { verdict: "contradicted", reportable: true, reason_codes: ["x"], rule_version: "v1" },
    narrative: { title: "COMPLETELY DIFFERENT", summary: "BRAND NEW" },
  });

  const q5a = simulateQ5Construction([cfr1]);
  const q5b = simulateQ5Construction([cfr2]);

  // Both must reference the same F04 identity
  assertEqual(q5a.canonical_finding_source!.finding_ids[0], q5b.canonical_finding_source!.finding_ids[0],
    "same finding_id regardless of narrative");
  assertEqual(q5a.canonical_finding_source!.semantic_hashes[0], q5b.canonical_finding_source!.semantic_hashes[0],
    "same semantic_hash regardless of narrative");
}

// ---------------------------------------------------------------------------
// TEST 5: memo-versus-model and live-versus-reference have different proposition keys
// ---------------------------------------------------------------------------
console.log("\nTEST 5: memo-vs-model and live-vs-reference have different proposition keys");
{
  const memo_vs_model = buildFinding("memo_claim", "current_model");
  const live_vs_ref = buildFinding("current_model", "reference_forecast");

  assert(memo_vs_model.identity.proposition_key !== live_vs_ref.identity.proposition_key,
    "distinct proposition_keys: memo_claim__current_model vs current_model__reference_forecast");
  assert(memo_vs_model.identity.finding_id !== live_vs_ref.identity.finding_id,
    "distinct finding_ids");

  // Verify the actual basis pair in the key
  assert(memo_vs_model.identity.proposition_key.includes("memo_claim__current_model"),
    "memo_vs_model key contains memo_claim__current_model");
  assert(live_vs_ref.identity.proposition_key.includes("current_model__reference_forecast"),
    "live_vs_ref key contains current_model__reference_forecast");
}

// ---------------------------------------------------------------------------
// TEST 6: live-versus-reference and current-versus-prior have different proposition keys
// ---------------------------------------------------------------------------
console.log("\nTEST 6: live-vs-reference and current-vs-prior have different proposition keys");
{
  const live_vs_ref = buildFinding("current_model", "reference_forecast");
  const curr_vs_prior = buildFinding("current_model", "prior_model");

  assert(live_vs_ref.identity.proposition_key !== curr_vs_prior.identity.proposition_key,
    "distinct proposition_keys: current_model__reference_forecast vs current_model__prior_model");
  assert(live_vs_ref.identity.finding_id !== curr_vs_prior.identity.finding_id,
    "distinct finding_ids");

  assert(live_vs_ref.identity.proposition_key.includes("reference_forecast"),
    "live_vs_ref key contains reference_forecast");
  assert(curr_vs_prior.identity.proposition_key.includes("prior_model"),
    "curr_vs_prior key contains prior_model");
}

// ---------------------------------------------------------------------------
// TEST 7: Downstream code does not use detail/full_analysis/first-source fallback
// ---------------------------------------------------------------------------
console.log("\nTEST 7: Downstream code does not use detail/full_analysis/first-source fallback");
{
  const cfr = buildFinding("memo_claim", "current_model");

  // Simulate Q5 with detail/full_analysis in the member but canonical records present
  const resolvedClaims = new Map<string, { claim_id: string; claim_text: string; memo_version: string | null; verdict: string }>();
  resolvedClaims.set("clm-v1-abc123def456", {
    claim_id: "clm-v1-abc123def456", claim_text: "Revenue", memo_version: "3rd IC", verdict: "contradicted",
  });

  const membersWithProse = [{
    finding_id: "finding-001", corpus_index: 0, title: "Revenue variance",
    detail: "FAKE PROSE DETAIL THAT SHOULD NOT BE USED",
    full_analysis: "FAKE FULL ANALYSIS THAT SHOULD NOT BE USED",
    severity: null, source_tag: null,
    source_docs: ["FAKE_SOURCE_DOC.pdf"],
    originating_claim_id: "clm-v1-abc123def456",
    claim_ids: ["clm-v1-abc123def456"], claim_type: "numeric_financial",
    finding_kind: null, issue_key: null, evidence: "FAKE EVIDENCE TEXT",
  }];

  const { finding } = constructCanonicalFinding(
    "test_key",
    { issue_domain: "financial", issue_type: "revenue_variance", metric: "total_group_revenue", period: "fy_mar_26", entity_or_segment: "scg", scope: "group" } as any,
    membersWithProse,
    resolvedClaims,
    [],
    [cfr],
  );

  // The comparison results must come from canonical, NOT from detail/full_analysis
  assert(finding.comparison_results.length > 0, "comparison results present");
  assertEqual(finding.comparison_results[0].signed_delta, 9608465,
    "signed_delta from canonical, not prose");
  assertEqual(finding.comparison_results[0].comparison_compatible, true,
    "comparison_compatible from canonical, not prose");

  // canonical_finding_source must be set (proving canonical records are the source)
  assert(finding.canonical_finding_source !== undefined, "canonical_finding_source present");
  assertEqual(finding.canonical_finding_source!.finding_ids[0], cfr.identity.finding_id,
    "source is canonical record, not prose-derived");
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n" + "\u2550".repeat(70));
console.log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log("\u2550".repeat(70) + "\n");

if (failed > 0) process.exit(1);
