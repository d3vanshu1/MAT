/**
 * Q2→Q5 Positive-Path Integration Test
 *
 * Validates the complete pipeline from claims-ledger population through
 * canonical finding assembly using a compact synthetic fixture.
 *
 * FIXTURE CONTENTS:
 *   - 2 IC memo claims (from 2 different documents)
 *   - 1 legacy reference mapping uniquely (positional c0-0)
 *   - 1 ambiguous legacy reference (slug matching multiple claims)
 *   - 1 live-model evidence record (financial_model authority)
 *   - 1 FDD supporting record (vendor_financial_dd authority)
 *   - 1 invalid commercial/legal authority pairing
 *   - 1 confirmed result
 *   - 1 contradicted result
 *
 * EXPECTED OUTPUTS:
 *   - Source claims: 2+
 *   - Unique reconciled legacy references: ≥1
 *   - Ambiguous references: ≥1 rejected
 *   - Q3 eligible adverse candidates: ≥1
 *   - Confirmed non-adverse rows: ≥1
 *   - Q4 families: ≥1
 *   - Q5 canonical findings: ≥1
 *   - Evidence coordinates preserved: 100%
 *   - Duplicate claim IDs: hard failure (tested separately)
 *   - Silent losses: 0
 */
import {
  generateClaimId,
  normalizeClaimText,
  enrichClaimWithIdentity,
  detectDuplicateClaimIds,
  deriveMemoVersion,
  type IdentifiedClaim,
} from "../claims-ledger-identity.js";
import {
  buildReconciliationIndex,
  resolveViaReconciliation,
  parseLegacyRef,
  type ReconciliationIndex,
} from "../legacy-claim-reconciler.js";
import {
  classifyClaimLinkage,
  resolveClaimId,
  Q4_ELIGIBLE_ADVERSE,
  type ClaimLinkageDisposition,
} from "../claim-linkage.js";
import {
  buildEvidenceSnapshot,
  generateCanonicalFindingId,
  type EvidenceSnapshot,
} from "../finding-identity.js";
import {
  constructCanonicalFinding,
  type CanonicalFinding,
} from "../canonical-finding-construction.js";
import type { CanonicalKey } from "../canonical-issue-identity.js";

// ===========================================================================
// Test infrastructure (same pattern as other pipeline tests)
// ===========================================================================
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}`);
  }
}

function assertMatch(value: string, pattern: RegExp, label: string): void {
  if (pattern.test(value)) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} — '${value}' does not match ${pattern}`);
  }
}

function assertContains<T>(arr: T[], item: T, label: string): void {
  if (arr.includes(item)) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} — array does not contain ${JSON.stringify(item)}`);
  }
}

// ===========================================================================
// FIXTURE: Compact synthetic dataset
// ===========================================================================

const DOC_ID_SCREENING = "doc-screening-001";
const DOC_ID_2ND_IC = "doc-2nd-ic-002";
const DOCUMENT_ORDER = [DOC_ID_SCREENING, DOC_ID_2ND_IC];

const RAW_CLAIMS = [
  // Claim 0: Revenue FY2025 from Screening Memo (chunk 0, claim 0)
  {
    metric: "revenue",
    scope_qualifier: "Group ARR",
    period: "FY2025",
    value: 120,
    unit: "$m",
    basis_note: "Management forecast",
    source_doc: "Screening IC Memo.pdf",
    source_page: "4",
    verbatim_snippet: "Management projects ARR of $120m for FY2025 based on current pipeline conversion rates",
    claim_category: "financial_projection",
  },
  // Claim 1: EBITDA margin from Screening Memo (chunk 0, claim 1)
  {
    metric: "ebitda",
    scope_qualifier: "Group adjusted",
    period: "FY2025",
    value: 25,
    unit: "%",
    basis_note: "Adjusted basis excluding one-offs",
    source_doc: "Screening IC Memo.pdf",
    source_page: "5",
    verbatim_snippet: "Adjusted EBITDA margin expected at 25% for FY2025 on a pro-forma basis",
    claim_category: "financial_projection",
  },
  // Claim 2: NRR from 2nd IC Memo (chunk 1, claim 0)
  {
    metric: "nrr",
    scope_qualifier: "NRR trailing 12m",
    period: "LTM Dec-2024",
    value: 115,
    unit: "%",
    basis_note: "Management calculation",
    source_doc: "2nd IC Memo.pdf",
    source_page: "8",
    verbatim_snippet: "Net Revenue Retention was 115% on a trailing 12-month basis through December 2024",
    claim_category: "operating_metric",
  },
  // Claim 3: Revenue FY2026 from 2nd IC (chunk 1, claim 1)
  {
    metric: "revenue",
    scope_qualifier: "Group ARR",
    period: "FY2026",
    value: 165,
    unit: "$m",
    basis_note: "Management forecast v2",
    source_doc: "2nd IC Memo.pdf",
    source_page: "10",
    verbatim_snippet: "Updated ARR forecast of $165m for FY2026 reflecting accelerated enterprise adoption",
    claim_category: "financial_projection",
  },
];

const DOC_CONTEXT_MAP: Record<string, { id: string; file_name: string }> = {
  "screening ic memo.pdf": { id: DOC_ID_SCREENING, file_name: "Screening IC Memo.pdf" },
  "2nd ic memo.pdf": { id: DOC_ID_2ND_IC, file_name: "2nd IC Memo.pdf" },
};

const FINDINGS = [
  // Finding 0: References c0-0 (positional → claim 0 Revenue FY2025)
  {
    finding_id: "f-001",
    corpus_index: 0,
    title: "Revenue FY2025: Model shows $105m vs. IC memo $120m",
    detail: "The live financial model projects ARR of $105m for FY2025, representing a $15m shortfall against the Screening IC memo projection of $120m",
    full_analysis: null as string | null,
    severity: "high",
    source_tag: "financial_model",
    source_docs: ["Live Model v3.xlsx"],
    originating_claim_id: "c0-0" as string | null,
    claim_ids: ["c0-0"],
    claim_type: "numeric_financial" as string | null,
    finding_kind: "contradiction",
    evidence: "Model cell B42 shows $105m ARR" as string | null,
    doc_filename: "Live Model v3.xlsx",
    doc_type: "financial_model" as string | null,
  },
  // Finding 1: References c1-0 (positional → claim 2 NRR, confirmed)
  {
    finding_id: "f-002",
    corpus_index: 1,
    title: "NRR confirmed at 115% by vendor FDD",
    detail: "PwC FDD workpaper confirms trailing 12m NRR of 115% through December 2024, consistent with IC memo",
    full_analysis: null as string | null,
    severity: "low",
    source_tag: "consultant_report",
    source_docs: ["PwC FDD Report.pdf"],
    originating_claim_id: "c1-0" as string | null,
    claim_ids: ["c1-0"],
    claim_type: "numeric_operational" as string | null,
    finding_kind: "confirmation",
    evidence: "FDD Schedule 4.2 shows NRR 115%" as string | null,
    doc_filename: "PwC FDD Report.pdf",
    doc_type: "vendor_financial_dd" as string | null,
  },
  // Finding 2: Ambiguous slug reference
  {
    finding_id: "f-003",
    corpus_index: 2,
    title: "Revenue forecast divergence across memo versions",
    detail: "Revenue forecasts diverge between screening and 2nd IC memo — potential restatement",
    full_analysis: null as string | null,
    severity: "medium",
    source_tag: "financial_model",
    source_docs: ["Live Model v3.xlsx"],
    originating_claim_id: "revenue_arr_group_divergence" as string | null,
    claim_ids: ["revenue_arr_group_divergence"],
    claim_type: "numeric_financial" as string | null,
    finding_kind: "contradiction",
    evidence: "Model shows divergent revenue trajectories" as string | null,
    doc_filename: "Live Model v3.xlsx",
    doc_type: "financial_model" as string | null,
  },
  // Finding 3: Invalid authority (legal DD for financial claim)
  {
    finding_id: "f-004",
    corpus_index: 3,
    title: "EBITDA margin concern from legal review",
    detail: "Legal DD notes mention EBITDA margin adjustments in SPA negotiations",
    full_analysis: null as string | null,
    severity: "medium",
    source_tag: "legal_dd",
    source_docs: ["Legal DD Report.pdf"],
    originating_claim_id: "c0-1" as string | null,
    claim_ids: ["c0-1"],
    claim_type: "numeric_financial" as string | null,
    finding_kind: "contradiction",
    evidence: "SPA clause 4.3 references margin adjustments" as string | null,
    doc_filename: "Legal DD Report.pdf",
    doc_type: "legal_dd" as string | null,
  },
  // Finding 4: No claim reference
  {
    finding_id: "f-005",
    corpus_index: 4,
    title: "General market observation without IC claim",
    detail: "Market report suggests TAM is smaller than presented",
    full_analysis: null as string | null,
    severity: "low",
    source_tag: "commercial_dd",
    source_docs: ["Market Study.pdf"],
    originating_claim_id: null as string | null,
    claim_ids: [] as string[],
    claim_type: null as string | null,
    finding_kind: "observation",
    evidence: null as string | null,
    doc_filename: "Market Study.pdf",
    doc_type: "commercial_dd" as string | null,
  },
];

// ===========================================================================
// TESTS
// ===========================================================================

// --- Q2: Enrich claims ---
const enrichedClaims = RAW_CLAIMS.map(raw => {
  const docCtx = DOC_CONTEXT_MAP[raw.source_doc.toLowerCase()];
  return enrichClaimWithIdentity(raw, {
    ic_document_id: docCtx.id,
    ic_document_filename: docCtx.file_name,
  });
});

assertTrue(enrichedClaims.length >= 2, "Q2: Source claims ≥ 2");
for (const claim of enrichedClaims) {
  assertMatch(claim.claim_id, /^clm-v1-[a-f0-9]{32}$/, `Q2: claim ${claim.metric} has 128-bit ID`);
}

// Duplicate detection
const duplicates = detectDuplicateClaimIds(enrichedClaims);
assertEqual(duplicates.size, 0, "Q2: No duplicates in valid fixture");

// Quality gates
const docIds = new Set(enrichedClaims.map(c => c.ic_document_id));
assertTrue(docIds.size >= 2, "Q2: ≥2 IC documents represented");

// --- Q3-prep: Legacy reconciliation ---
const claimMap = new Map<string, any>(enrichedClaims.map(c => [c.claim_id, c]));

const legacyRefsSet = new Set<string>();
for (const f of FINDINGS) {
  if (f.originating_claim_id) legacyRefsSet.add(f.originating_claim_id);
  for (const cid of f.claim_ids ?? []) legacyRefsSet.add(cid);
}

const reconciliation = buildReconciliationIndex(
  [...legacyRefsSet],
  enrichedClaims,
  DOCUMENT_ORDER,
  claimMap as Map<string, IdentifiedClaim>,
);

assertTrue(reconciliation.summary.total_attempted > 0, "Reconciliation: attempted > 0");
assertTrue(reconciliation.summary.bridged_positional >= 1, "Reconciliation: ≥1 positional bridge");
assertTrue(
  reconciliation.summary.unresolved_ambiguous + reconciliation.summary.unresolved_no_match >= 1,
  "Reconciliation: ≥1 ambiguous/unresolved ref rejected"
);

// c0-0 positional resolution
const c0Record = reconciliation.records.find(r => r.legacy_ref === "c0-0");
assertTrue(c0Record !== undefined, "c0-0 reconciliation record exists");
assertEqual(c0Record!.outcome, "bridged_positional", "c0-0 resolved via positional bridge");
assertEqual(c0Record!.resolved_claim_id, enrichedClaims[0].claim_id, "c0-0 → first claim");

// Slug ambiguity
const slugRecord = reconciliation.records.find(r => r.legacy_ref === "revenue_arr_group_divergence");
assertTrue(slugRecord !== undefined, "Slug reconciliation record exists");
assertTrue(
  slugRecord!.outcome === "unresolved_ambiguous" || slugRecord!.outcome === "unresolved_no_match",
  "Slug reference rejected (ambiguous or no match)"
);
assertEqual(slugRecord!.resolved_claim_id, null, "Slug has no resolved claim_id");

// --- Q3: Claim linkage ---
// Augment claimMap with bridged entries
for (const [legacyRef, canonicalId] of reconciliation.bridge) {
  if (!claimMap.has(legacyRef)) {
    claimMap.set(legacyRef, claimMap.get(canonicalId));
  }
}

// f-001: Contradicted (live model vs IC memo) → Q4-eligible
const r1 = classifyClaimLinkage(FINDINGS[0], claimMap);
assertTrue(r1.q4_eligible, "Q3 f-001: Q4-eligible (adverse, claim resolved)");
assertTrue(
  r1.claim_linkage_disposition !== "not_linked_to_IC_claim" &&
  r1.claim_linkage_disposition !== "invalid_or_unresolved_claim_reference",
  "Q3 f-001: claim resolved via reconciliation bridge"
);

// f-002: Confirmed → NOT Q4-eligible
const r2 = classifyClaimLinkage(FINDINGS[1], claimMap);
assertEqual(r2.claim_linkage_disposition, "claim_linked_confirmed", "Q3 f-002: confirmed");
assertEqual(r2.q4_eligible, false, "Q3 f-002: not Q4-eligible");

// f-003: Ambiguous slug → invalid_or_unresolved
const r3 = classifyClaimLinkage(FINDINGS[2], claimMap);
assertEqual(r3.claim_linkage_disposition, "invalid_or_unresolved_claim_reference", "Q3 f-003: unresolved slug");
assertEqual(r3.q4_eligible, false, "Q3 f-003: not Q4-eligible");

// f-004: Legal DD for financial claim → invalid_evidence_authority
const r4 = classifyClaimLinkage(FINDINGS[3], claimMap);
assertEqual(r4.claim_linkage_disposition, "invalid_evidence_authority", "Q3 f-004: invalid authority");
assertEqual(r4.q4_eligible, false, "Q3 f-004: not Q4-eligible");

// f-005: No claim ref → not linked
const r5 = classifyClaimLinkage(FINDINGS[4], claimMap);
assertEqual(r5.claim_linkage_disposition, "not_linked_to_IC_claim", "Q3 f-005: not linked");
assertEqual(r5.q4_eligible, false, "Q3 f-005: not Q4-eligible");

// --- Q4: At least 1 eligible → at least 1 family ---
const q3Results = FINDINGS.map(f => classifyClaimLinkage(f, claimMap));
const eligible = q3Results.filter(r => r.q4_eligible);
assertTrue(eligible.length >= 1, "Q4: ≥1 Q4-eligible finding");

// --- Q5: Canonical finding construction ---
const resolvedClaimId = reconciliation.bridge.get("c0-0")!;
const resolvedClaim = claimMap.get(resolvedClaimId)!;

const snapshot = buildEvidenceSnapshot({
  claim_id: resolvedClaimId,
  claim_record: {
    metric: resolvedClaim.metric,
    period: resolvedClaim.period,
    scope_qualifier: resolvedClaim.scope_qualifier,
    value: resolvedClaim.value,
    unit: resolvedClaim.unit,
    verbatim_snippet: resolvedClaim.verbatim_snippet,
    memo_version: resolvedClaim.memo_version,
    ic_document_id: resolvedClaim.ic_document_id,
    ic_document_filename: resolvedClaim.ic_document_filename,
    claim_type: resolvedClaim.claim_type,
  },
  authority_class: "live_financial_model",
  verdict: "contradicted",
  evidence_text: "Model cell B42 shows $105m ARR",
  originating_claim_ids: ["c0-0"],
});

// No timestamp in snapshot (deterministic)
assertEqual((snapshot as any).snapshot_timestamp, undefined, "Q5: snapshot has no timestamp");
assertTrue(snapshot.originating_claim_ids.length > 0, "Q5: snapshot has originating_claim_ids");

// Construct canonical finding
const resolvedClaimsMap = new Map<string, { claim_id: string; claim_text: string; memo_version: string | null; verdict: string }>();
resolvedClaimsMap.set(resolvedClaimId, {
  claim_id: resolvedClaimId,
  claim_text: resolvedClaim.verbatim_snippet,
  memo_version: resolvedClaim.memo_version,
  verdict: "contradicted",
});

const canonicalKey: CanonicalKey = {
  issue_domain: "financial",
  issue_type: "memo_model_gap",
  metric: "revenue",
  period: "fy2025",
  entity_or_segment: "group",
  scope: "arr",
  unit: "$m",
  actual_or_forecast: "forecast",
  accounting_basis: null,
  comparison_basis: "memo_vs_model",
  direction_of_difference: "overstatement",
};

const { finding, memberOutcomes } = constructCanonicalFinding(
  "financial|memo_model_gap|revenue|fy2025|group|arr|memo_vs_model|overstatement",
  canonicalKey,
  [{
    finding_id: "f-001",
    corpus_index: 0,
    title: "Revenue FY2025: Model shows $105m vs. IC memo $120m",
    detail: "The live financial model projects ARR of $105m for FY2025",
    source_tag: "financial_model",
    source_docs: ["Live Model v3.xlsx"],
    originating_claim_id: resolvedClaimId,
    claim_ids: [resolvedClaimId],
    claim_type: "numeric_financial",
    finding_kind: "contradiction",
    evidence: "Model cell B42 shows $105m ARR",
  }],
  resolvedClaimsMap,
  [snapshot],
);

assertMatch(finding.canonical_finding_id, /^cfnd-v2-[a-f0-9]{32}$/, "Q5: SHA-256 canonical finding ID");
assertEqual(finding.verification_status, "contradicted", "Q5: verification_status = contradicted");
assertTrue(finding.originating_claims.length >= 1, "Q5: ≥1 originating claim");
assertTrue(finding.verification_evidence.length >= 1, "Q5: ≥1 verification evidence record");
assertTrue(finding.memo_versions.length >= 1, "Q5: ≥1 memo version");
assertContains(finding.merged_from_finding_ids, "f-001", "Q5: merged_from includes f-001");

// Evidence coordinates preserved (strict schema)
const authEvidence = finding.verification_evidence.find((e: { authority_class: string }) => e.authority_class === "live_financial_model");
assertTrue(authEvidence !== undefined, "Q5: financial_model evidence record exists");
if (authEvidence) {
  assertTrue(authEvidence.metric === "revenue", "Q5: evidence.metric preserved");
  assertTrue(authEvidence.period === "FY2025", "Q5: evidence.period preserved");
  assertTrue(authEvidence.value === 120, "Q5: evidence.value preserved");
}

// Member outcomes
assertEqual(memberOutcomes.length, 1, "Q5: 1 member outcome");
assertEqual(memberOutcomes[0].terminal_outcome, "retained_as_canonical_finding", "Q5: retained");

// --- E2E: Zero silent losses ---
assertEqual(q3Results.length, FINDINGS.length, "E2E: every input has Q3 result (0 silent losses)");

// --- Hash determinism ---
const id1 = generateClaimId({
  ic_document_id: DOC_ID_SCREENING,
  source_page: "4",
  normalized_claim_text: "test claim text",
  metric: "revenue",
  period: "fy2025",
  scope_qualifier: "group",
});
const id2 = generateClaimId({
  ic_document_id: DOC_ID_SCREENING,
  source_page: "4",
  normalized_claim_text: "test claim text",
  metric: "revenue",
  period: "fy2025",
  scope_qualifier: "group",
});
assertEqual(id1, id2, "Hash determinism: same inputs → same ID");
assertMatch(id1, /^clm-v1-[a-f0-9]{32}$/, "Hash output: 128-bit");

const cfId1 = generateCanonicalFindingId({
  canonical_key_str: "test|key",
  member_finding_ids: ["f-001", "f-002"],
});
const cfId2 = generateCanonicalFindingId({
  canonical_key_str: "test|key",
  member_finding_ids: ["f-002", "f-001"],
});
assertEqual(cfId1, cfId2, "Canonical finding ID: order-independent");
assertMatch(cfId1, /^cfnd-v1-[a-f0-9]{32}$/, "Canonical finding ID: 128-bit");

// --- Legacy ref parsing ---
assertEqual(parseLegacyRef("c0-0").type, "positional", "parseLegacyRef: c0-0 is positional");
assertEqual(parseLegacyRef("c12-45").type, "positional", "parseLegacyRef: c12-45 is positional");
assertEqual(
  parseLegacyRef("clm-v1-abcdef0123456789abcdef0123456789").type,
  "canonical",
  "parseLegacyRef: clm-v1-* is canonical"
);
assertEqual(parseLegacyRef("revenue_arr_divergence").type, "slug", "parseLegacyRef: slug detected");
assertEqual(parseLegacyRef("x").type, "malformed", "parseLegacyRef: single char is malformed");

// --- Duplicate hard failure ---
const dupRaw = [RAW_CLAIMS[0], RAW_CLAIMS[0]];
const dupEnriched = dupRaw.map(raw => {
  const docCtx = DOC_CONTEXT_MAP[raw.source_doc.toLowerCase()];
  return enrichClaimWithIdentity(raw, {
    ic_document_id: docCtx.id,
    ic_document_filename: docCtx.file_name,
  });
});
const dupDetected = detectDuplicateClaimIds(dupEnriched);
assertTrue(dupDetected.size > 0, "Duplicate detection: finds duplicates in identical claims");

// ===========================================================================
// SUMMARY
// ===========================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`Q2→Q5 POSITIVE PATH INTEGRATION TEST`);
console.log(`${"=".repeat(60)}`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) {
    console.log(`    ${f}`);
  }
}
console.log(`${"=".repeat(60)}\n`);

if (failed > 0) {
  throw new Error(`${failed} assertion(s) failed. See output above.`);
}

export { passed, failed };
