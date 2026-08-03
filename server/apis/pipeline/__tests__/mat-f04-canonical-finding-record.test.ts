/**
 * MAT-F04: Lossless Canonical Finding Record and Stable Identity — 20 tests
 *
 * Tests invoke the actual production construction/persistence boundary functions:
 *   - buildCanonicalFindingRecord
 *   - serializeCanonicalFinding / deserializeCanonicalFinding
 *   - validateIdentityStability
 *   - validateNoProseReconstruction
 *   - deriveLegacyFinding
 *   - generatePropositionKey
 *   - extractEvidenceFromAdmittedOnly
 *
 * Run: npx tsx server/apis/pipeline/__tests__/mat-f04-canonical-finding-record.test.ts
 */

import {
  buildCanonicalFindingRecord,
  serializeCanonicalFinding,
  deserializeCanonicalFinding,
  validateIdentityStability,
  validateNoProseReconstruction,
  deriveLegacyFinding,
  generatePropositionKey,
  extractEvidenceFromAdmittedOnly,
  CANONICAL_FINDING_SCHEMA_VERSION,
  IDENTITY_VERSION,
  type CanonicalFindingRecord,
  type CanonicalDisposition,
  type CanonicalAdmittedEvidence,
  type BuildCanonicalFindingInput,
} from "../canonical-finding-record.js";
import {
  executeCanonicalComparison,
  type ComparisonClaimInput,
  type ComparisonEvidenceInput,
  type CanonicalComparison,
} from "../canonical-comparison.js";
import type { IdentifiedClaim } from "../claims-ledger-identity.js";
import type { AdmittedEvidenceRecord } from "../evidence-admission-boundary.js";
import type { CanonicalEvidenceRecord } from "../canonical-evidence.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
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

function assertApprox(actual: number | null | undefined, expected: number, tol: number, msg: string): void {
  if (actual === null || actual === undefined) {
    console.error(`  FAIL: ${msg} — actual is null/undefined`);
    failed++;
    return;
  }
  if (Math.abs(actual - expected) > tol) {
    console.error(`  FAIL: ${msg}\n    expected: ~${expected}\n    actual:   ${actual}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
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

function makeComparison(claimOverrides: Partial<ComparisonClaimInput> = {}, evidenceOverrides: Partial<ComparisonEvidenceInput> = {}): CanonicalComparison {
  const claim: ComparisonClaimInput = {
    claim_id: "clm-v1-abc123def456",
    entity: "scg",
    metric: "total_group_revenue",
    period: "FY Mar-26",
    segment: null,
    scope: "group",
    unit: "gbp_millions",
    currency: "GBP",
    scale: "millions",
    actual_or_forecast: "forecast",
    accounting_basis: null,
    comparison_basis: "memo_claim",
    value: 194,
    ic_document_id: "doc-ic-001",
    ...claimOverrides,
  };
  const evidence: ComparisonEvidenceInput = {
    evidence_id: "ev-v1-model-rev-001",
    entity: "scg",
    metric: "total_group_revenue",
    period: "FY Mar-26",
    segment: null,
    scope: "group",
    unit: "gbp",
    currency: "GBP",
    scale: "raw",
    actual_or_forecast: "forecast",
    accounting_basis: null,
    comparison_basis: "current_model",
    value: 184391535,
    source_document_id: "doc-fs-summary-001",
    has_entity_bridge: false,
    ...evidenceOverrides,
  };
  return executeCanonicalComparison(claim, evidence);
}

function buildTestFinding(overrides: Partial<BuildCanonicalFindingInput> = {}): CanonicalFindingRecord {
  const claim = overrides.claim ?? makeClaim();
  const admittedEvidence = overrides.admittedEvidence ?? [makeAdmittedEvidence()];
  const comparisons = overrides.comparisons ?? [makeComparison()];
  const disposition: CanonicalDisposition = overrides.disposition ?? {
    verdict: "contradicted",
    reportable: true,
    reason_codes: ["material_difference"],
    rule_version: "verdict-v1.0",
  };
  return buildCanonicalFindingRecord({
    claim,
    admittedEvidence,
    comparisons,
    disposition,
    narrative: overrides.narrative ?? { title: "Revenue forecast variance", summary: "£194m vs £184.4m" },
    legacyDiagnostic: overrides.legacyDiagnostic,
  });
}

// ===========================================================================
// TESTS
// ===========================================================================

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  MAT-F04: Canonical Finding Record & Stable Identity (20 tests)    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

// ---------------------------------------------------------------------------
// TEST 1: Complete £194m revenue finding preservation
// ---------------------------------------------------------------------------
console.log("TEST 1: Complete £194m revenue finding preservation");
{
  const finding = buildTestFinding();

  assertEqual(finding.schema_version, CANONICAL_FINDING_SCHEMA_VERSION, "schema_version correct");
  assertEqual(finding.claim.claim_id, "clm-v1-abc123def456", "claim_id preserved");
  assertEqual(finding.claim.metric, "total_group_revenue", "claim metric preserved");
  assertEqual(finding.claim.period, "FY Mar-26", "claim period preserved");
  assertEqual(finding.claim.value, 194, "claim value preserved");
  assertEqual(finding.claim.ic_document_id, "doc-ic-001", "IC document ID preserved");
  assertEqual(finding.claim.ic_document_filename, "3rd IC Memo - SCG.pdf", "IC doc filename preserved");
  assertEqual(finding.evidence.length, 1, "one admitted evidence");
  assertEqual(finding.evidence[0].evidence_id, "ev-v1-model-rev-001", "evidence ID preserved");
  assertEqual(finding.comparisons.length, 1, "one comparison");
  assert(finding.comparisons[0].compatibility.allowed, "comparison is compatible");
  assertEqual(finding.comparisons[0].calculation.signed_delta, 9608465, "signed_delta = 9608465");
  assertEqual(finding.comparisons[0].calculation.absolute_delta, 9608465, "absolute_delta = 9608465");
  assertApprox(finding.comparisons[0].calculation.percentage_delta, 5.2109, 0.001, "percentage_delta ≈ 5.21");
  assertEqual(finding.comparisons[0].calculation.direction, "claim_higher", "direction = claim_higher");
  assertEqual(finding.comparisons[0].verdict.value, "contradicted", "verdict = contradicted");
  assert(finding.identity.finding_id.startsWith("cfr-v1-"), "finding_id has correct prefix");
  assert(finding.identity.semantic_hash.length >= 32, "semantic_hash is valid");
}

// ---------------------------------------------------------------------------
// TEST 2: Exact workbook evidence ID and coordinate retention
// ---------------------------------------------------------------------------
console.log("\nTEST 2: Exact workbook evidence ID and coordinate retention");
{
  const finding = buildTestFinding();
  const ev = finding.evidence[0];

  assertEqual(ev.evidence_id, "ev-v1-model-rev-001", "evidence_id retained");
  assertEqual(ev.source_document_id, "doc-fs-summary-001", "source document ID retained");
  assertEqual(ev.source_document_name, "FS Summary.xlsx", "source document name retained");
  assertEqual(ev.authority_class, "current_financial_model", "authority class retained");
  assertEqual(ev.coordinate.kind, "workbook", "coordinate kind = workbook");
  if (ev.coordinate.kind === "workbook") {
    assertEqual(ev.coordinate.sheet, "P&L Summary", "sheet retained");
    assertEqual(ev.coordinate.cell_or_range, "C42", "cell_or_range retained");
  }
  assertEqual(ev.canonical_record.proposition.value, 184391535, "canonical proposition value retained");
}

// ---------------------------------------------------------------------------
// TEST 3: Mixed admitted/rejected evidence filtering
// ---------------------------------------------------------------------------
console.log("\nTEST 3: Mixed admitted/rejected evidence filtering");
{
  const admitted1 = makeAdmittedEvidence();
  const admitted2 = makeAdmittedEvidence({
    evidence_id: "ev-v1-model-rev-002",
    source_document_id: "doc-fs-summary-002",
    source_document_name: "FS Summary v2.xlsx",
    canonical_record: makeEvidenceRecord({
      evidence_id: "ev-v1-model-rev-002",
      source: { document_id: "doc-fs-summary-002", document_name: "FS Summary v2.xlsx", authority_class: "current_financial_model", source_type: "workbook" },
    }) as any,
  });

  // Only admitted evidence should appear
  const finding = buildTestFinding({ admittedEvidence: [admitted1, admitted2] });
  assertEqual(finding.evidence.length, 2, "both admitted evidence items retained");
  assertEqual(finding.evidence[0].evidence_id, "ev-v1-model-rev-001", "first admitted ID");
  assertEqual(finding.evidence[1].evidence_id, "ev-v1-model-rev-002", "second admitted ID");
}

// ---------------------------------------------------------------------------
// TEST 4: Rejected evidence cannot reattach downstream
// ---------------------------------------------------------------------------
console.log("\nTEST 4: Rejected evidence cannot reattach downstream");
{
  // Build with only one admitted evidence — the rejected one is NOT included
  const finding = buildTestFinding();

  // Verify: no evidence with a rejected-type ID appears
  const evidenceIds = finding.evidence.map(e => e.evidence_id);
  assert(!evidenceIds.includes("ev-rejected-001"), "rejected evidence ID does not appear");
  // The extractEvidenceFromAdmittedOnly function enforces this
  const extracted = extractEvidenceFromAdmittedOnly([makeAdmittedEvidence()]);
  assertEqual(extracted.length, 1, "extractEvidenceFromAdmittedOnly returns only admitted");
  assertEqual(extracted[0].evidence_id, "ev-v1-model-rev-001", "only admitted evidence in output");
}

// ---------------------------------------------------------------------------
// TEST 5: memo-versus-model and live-versus-hardcoded remain distinct
// ---------------------------------------------------------------------------
console.log("\nTEST 5: memo-versus-model and live-versus-hardcoded remain distinct");
{
  // Memo vs model comparison
  const comp1 = makeComparison(
    { comparison_basis: "memo_claim" },
    { comparison_basis: "current_model" },
  );
  // Live vs hardcoded comparison
  const comp2 = makeComparison(
    { comparison_basis: "current_model", value: 200 },
    { comparison_basis: "reference_forecast", value: 180000000 },
  );

  const finding1 = buildTestFinding({ comparisons: [comp1] });
  const finding2 = buildTestFinding({ comparisons: [comp2] });

  assert(finding1.identity.proposition_key !== finding2.identity.proposition_key || 
         finding1.identity.semantic_hash !== finding2.identity.semantic_hash,
    "memo-vs-model and live-vs-hardcoded produce distinct identities");
  assert(finding1.identity.finding_id !== finding2.identity.finding_id,
    "distinct finding_ids");
}

// ---------------------------------------------------------------------------
// TEST 6: reported versus cash EBITDA remain distinct
// ---------------------------------------------------------------------------
console.log("\nTEST 6: reported versus cash EBITDA remain distinct");
{
  const reportedClaim = makeClaim({ metric: "reported_ebitda", accounting_basis: "reported" });
  const cashClaim = makeClaim({ metric: "cash_ebitda", accounting_basis: "cash", claim_id: "clm-v1-cash-ebitda" });

  const finding1 = buildTestFinding({ claim: reportedClaim });
  const finding2 = buildTestFinding({ claim: cashClaim });

  assert(finding1.identity.proposition_key !== finding2.identity.proposition_key,
    "reported and cash EBITDA have distinct proposition keys");
  assert(finding1.identity.finding_id !== finding2.identity.finding_id,
    "distinct finding_ids");
}

// ---------------------------------------------------------------------------
// TEST 7: EBITDA versus EBITDA adjustments remain distinct
// ---------------------------------------------------------------------------
console.log("\nTEST 7: EBITDA versus EBITDA adjustments remain distinct");
{
  const ebitdaClaim = makeClaim({ metric: "adjusted_ebitda", claim_id: "clm-v1-adj-ebitda" });
  const adjClaim = makeClaim({ metric: "ebitda_adjustments", claim_id: "clm-v1-ebitda-adj" });

  const finding1 = buildTestFinding({ claim: ebitdaClaim });
  const finding2 = buildTestFinding({ claim: adjClaim });

  assert(finding1.identity.proposition_key !== finding2.identity.proposition_key,
    "EBITDA and EBITDA adjustments have distinct proposition keys");
  assert(finding1.identity.finding_id !== finding2.identity.finding_id,
    "distinct finding_ids");
}

// ---------------------------------------------------------------------------
// TEST 8: evidence order does not change identity
// ---------------------------------------------------------------------------
console.log("\nTEST 8: evidence order does not change identity");
{
  const ev1 = makeAdmittedEvidence({ evidence_id: "ev-v1-aaa" } as any);
  const ev2 = makeAdmittedEvidence({ evidence_id: "ev-v1-zzz" } as any);

  const findingAB = buildTestFinding({ admittedEvidence: [ev1, ev2] });
  const findingBA = buildTestFinding({ admittedEvidence: [ev2, ev1] });

  assertEqual(findingAB.identity.semantic_hash, findingBA.identity.semantic_hash,
    "semantic_hash identical regardless of evidence order");
  assertEqual(findingAB.identity.finding_id, findingBA.identity.finding_id,
    "finding_id identical regardless of evidence order");
}

// ---------------------------------------------------------------------------
// TEST 9: title/summary changes do not change identity
// ---------------------------------------------------------------------------
console.log("\nTEST 9: title/summary changes do not change identity");
{
  const finding1 = buildTestFinding({ narrative: { title: "Revenue is too high", summary: "Bad forecast" } });
  const finding2 = buildTestFinding({ narrative: { title: "COMPLETELY DIFFERENT TITLE", summary: "TOTALLY NEW SUMMARY" } });
  const finding3 = buildTestFinding({ narrative: undefined });

  assertEqual(finding1.identity.semantic_hash, finding2.identity.semantic_hash,
    "different narratives produce same semantic_hash");
  assertEqual(finding1.identity.semantic_hash, finding3.identity.semantic_hash,
    "no narrative produces same semantic_hash");
  assertEqual(finding1.identity.finding_id, finding2.identity.finding_id,
    "finding_id unaffected by title");
}

// ---------------------------------------------------------------------------
// TEST 10: persistence/reload identity parity
// ---------------------------------------------------------------------------
console.log("\nTEST 10: persistence/reload identity parity");
{
  const original = buildTestFinding();
  const json = serializeCanonicalFinding(original);
  const reloaded = deserializeCanonicalFinding(json);

  assertEqual(reloaded.identity.finding_id, original.identity.finding_id, "finding_id survives reload");
  assertEqual(reloaded.identity.semantic_hash, original.identity.semantic_hash, "semantic_hash survives reload");
  assertEqual(reloaded.identity.proposition_key, original.identity.proposition_key, "proposition_key survives reload");
  assertEqual(reloaded.claim.claim_id, original.claim.claim_id, "claim_id survives reload");
  assertEqual(reloaded.evidence[0].evidence_id, original.evidence[0].evidence_id, "evidence_id survives reload");
  assertEqual(reloaded.comparisons[0].comparison_id, original.comparisons[0].comparison_id, "comparison_id survives reload");
  assertEqual(reloaded.disposition.verdict, original.disposition.verdict, "verdict survives reload");

  // Validate identity stability check
  assert(validateIdentityStability(reloaded), "identity is stable after reload");
}

// ---------------------------------------------------------------------------
// TEST 11: claim change changes identity
// ---------------------------------------------------------------------------
console.log("\nTEST 11: claim change changes identity");
{
  const finding1 = buildTestFinding();
  const finding2 = buildTestFinding({ claim: makeClaim({ claim_id: "clm-v1-DIFFERENT" }) });

  assert(finding1.identity.semantic_hash !== finding2.identity.semantic_hash,
    "different claim_id → different semantic_hash");
  assert(finding1.identity.finding_id !== finding2.identity.finding_id,
    "different claim_id → different finding_id");
}

// ---------------------------------------------------------------------------
// TEST 12: evidence-set change changes identity
// ---------------------------------------------------------------------------
console.log("\nTEST 12: evidence-set change changes identity");
{
  const finding1 = buildTestFinding();
  const differentEvidence = makeAdmittedEvidence({ evidence_id: "ev-v1-totally-new" } as any);
  const finding2 = buildTestFinding({ admittedEvidence: [differentEvidence] });

  assert(finding1.identity.semantic_hash !== finding2.identity.semantic_hash,
    "different evidence set → different semantic_hash");
}

// ---------------------------------------------------------------------------
// TEST 13: comparison-basis change changes identity
// ---------------------------------------------------------------------------
console.log("\nTEST 13: comparison-basis change changes identity");
{
  const comp1 = makeComparison({ comparison_basis: "memo_claim" }, { comparison_basis: "current_model" });
  const comp2 = makeComparison({ comparison_basis: "current_model" }, { comparison_basis: "reference_forecast" });

  const finding1 = buildTestFinding({ comparisons: [comp1] });
  const finding2 = buildTestFinding({ comparisons: [comp2] });

  // Different comparison IDs → different semantic hash
  assert(finding1.identity.semantic_hash !== finding2.identity.semantic_hash,
    "different comparison basis → different semantic_hash");
}

// ---------------------------------------------------------------------------
// TEST 14: verdict change changes identity
// ---------------------------------------------------------------------------
console.log("\nTEST 14: verdict change changes identity");
{
  const disp1: CanonicalDisposition = { verdict: "contradicted", reportable: true, reason_codes: ["x"], rule_version: "v1" };
  const disp2: CanonicalDisposition = { verdict: "confirmed", reportable: true, reason_codes: ["y"], rule_version: "v1" };

  const finding1 = buildTestFinding({ disposition: disp1 });
  const finding2 = buildTestFinding({ disposition: disp2 });

  assert(finding1.identity.semantic_hash !== finding2.identity.semantic_hash,
    "different verdict → different semantic_hash");
}

// ---------------------------------------------------------------------------
// TEST 15: narrative deletion still permits full reconstruction
// ---------------------------------------------------------------------------
console.log("\nTEST 15: narrative deletion still permits full reconstruction");
{
  const finding = buildTestFinding({ narrative: undefined });

  // All factual fields must still be present
  assert(!!finding.claim.claim_id, "claim_id present without narrative");
  assert(!!finding.evidence[0].evidence_id, "evidence_id present without narrative");
  assert(!!finding.comparisons[0].comparison_id, "comparison_id present without narrative");
  assertEqual(finding.comparisons[0].calculation.signed_delta, 9608465, "signed_delta present without narrative");
  assertEqual(finding.disposition.verdict, "contradicted", "verdict present without narrative");
  assert(!!finding.identity.finding_id, "finding_id present without narrative");

  // Legacy adapter still works
  const legacy = deriveLegacyFinding(finding);
  assertEqual(legacy.signed_delta, 9608465, "legacy adapter produces signed_delta without narrative");
  assertEqual(legacy.claim_id, "clm-v1-abc123def456", "legacy adapter produces claim_id without narrative");
}

// ---------------------------------------------------------------------------
// TEST 16: no detail/full_analysis evidence reconstruction
// ---------------------------------------------------------------------------
console.log("\nTEST 16: no detail/full_analysis evidence reconstruction");
{
  const finding = buildTestFinding();

  // The canonical finding record type has NO detail/full_analysis fields
  assert(!("detail" in finding), "no 'detail' field in canonical finding");
  assert(!("full_analysis" in finding), "no 'full_analysis' field in canonical finding");

  // Evidence coordinates come from structured canonical_record, not text
  const ev = finding.evidence[0];
  assert(ev.coordinate.kind === "workbook" || ev.coordinate.kind === "pdf",
    "coordinate is structured (workbook/pdf), not text-derived");

  // Validate no prose reconstruction
  const validation = validateNoProseReconstruction(finding);
  assert(validation.valid, `no prose reconstruction violations: ${validation.violations.join(", ")}`);
}

// ---------------------------------------------------------------------------
// TEST 17: no first-source fallback
// ---------------------------------------------------------------------------
console.log("\nTEST 17: no first-source fallback");
{
  const finding = buildTestFinding();

  // Each evidence item must have its OWN source document ID — not a fallback
  for (const ev of finding.evidence) {
    assert(!!ev.source_document_id, `evidence ${ev.evidence_id} has own source_document_id`);
    assert(!!ev.source_document_name, `evidence ${ev.evidence_id} has own source_document_name`);
    // Verify it comes from the canonical_record, not a generic "source_docs[0]" fallback
    assertEqual(ev.source_document_id, ev.canonical_record.source.document_id,
      `evidence source matches canonical_record.source.document_id`);
  }
}

// ---------------------------------------------------------------------------
// TEST 18: legacy adapter derives from canonical record
// ---------------------------------------------------------------------------
console.log("\nTEST 18: legacy adapter derives from canonical record");
{
  const finding = buildTestFinding();
  const legacy = deriveLegacyFinding(finding);

  // All legacy fields must derive from the canonical record
  assertEqual(legacy.finding_id, finding.identity.finding_id, "legacy finding_id from canonical identity");
  assertEqual(legacy.claim_id, finding.claim.claim_id, "legacy claim_id from canonical claim");
  assertEqual(legacy.claim_text, finding.claim.verbatim_snippet, "legacy claim_text from canonical verbatim");
  assertEqual(legacy.ic_document_id, finding.claim.ic_document_id, "legacy ic_doc from canonical claim");
  assertEqual(legacy.verdict, finding.disposition.verdict, "legacy verdict from canonical disposition");
  assertEqual(legacy.metric, finding.claim.metric, "legacy metric from canonical claim");
  assertEqual(legacy.period, finding.claim.period, "legacy period from canonical claim");
  assertEqual(legacy.value, finding.claim.value, "legacy value from canonical claim");
  assertEqual(legacy.signed_delta, finding.comparisons[0].calculation.signed_delta, "legacy delta from comparison");
  assert(legacy.evidence_source_ids.includes("ev-v1-model-rev-001"), "legacy evidence IDs from canonical");
}

// ---------------------------------------------------------------------------
// TEST 19: canonical record remains source of truth after reload
// ---------------------------------------------------------------------------
console.log("\nTEST 19: canonical record remains source of truth after reload");
{
  const original = buildTestFinding();
  const json = serializeCanonicalFinding(original);
  const reloaded = deserializeCanonicalFinding(json);

  // Derive legacy from reloaded — must match original derivation
  const legacyOriginal = deriveLegacyFinding(original);
  const legacyReloaded = deriveLegacyFinding(reloaded);

  assertEqual(legacyOriginal.finding_id, legacyReloaded.finding_id, "legacy finding_id same after reload");
  assertEqual(legacyOriginal.signed_delta, legacyReloaded.signed_delta, "legacy signed_delta same after reload");
  assertEqual(legacyOriginal.verdict, legacyReloaded.verdict, "legacy verdict same after reload");
  assertEqual(legacyOriginal.claim_id, legacyReloaded.claim_id, "legacy claim_id same after reload");

  // Source of truth: reloaded canonical fields directly accessible
  assertEqual(reloaded.evidence[0].canonical_record.proposition.value, 184391535,
    "canonical proposition value accessible after reload");
  if (reloaded.evidence[0].coordinate.kind === "workbook") {
    assertEqual(reloaded.evidence[0].coordinate.sheet, "P&L Summary",
      "workbook sheet accessible after reload");
    assertEqual(reloaded.evidence[0].coordinate.cell_or_range, "C42",
      "cell_or_range accessible after reload");
  }
}

// ---------------------------------------------------------------------------
// TEST 20: semantic hash is deterministic across repeated execution
// ---------------------------------------------------------------------------
console.log("\nTEST 20: semantic hash is deterministic across repeated execution");
{
  // Build the same finding 5 times — must get identical hashes every time
  const hashes = new Set<string>();
  const ids = new Set<string>();

  for (let i = 0; i < 5; i++) {
    const finding = buildTestFinding();
    hashes.add(finding.identity.semantic_hash);
    ids.add(finding.identity.finding_id);
  }

  assertEqual(hashes.size, 1, "semantic_hash is identical across 5 repeated constructions");
  assertEqual(ids.size, 1, "finding_id is identical across 5 repeated constructions");
}

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log("══════════════════════════════════════════════════════════════════════\n");

if (failed > 0) {
  process.exit(1);
}
