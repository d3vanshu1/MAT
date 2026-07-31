/**
 * Corrective E3: Exact-match supersession semantics
 *
 * Validates that:
 * 1. Exact match plus unrelated same-document findings supersedes correctly
 * 2. Matching and nonmatching evidence on one finding still resolves that finding
 * 3. Two distinct exact current findings are ambiguous
 * 4. No exact match is append-only
 * 5. Stage 3.5 through append produces A, C and replacement D when B is sole match
 *
 * Run: npx tsx server/apis/pipeline/__tests__/corrective-e3-exact-match-supersession.test.ts
 */

import { validateSupersessionProof, type SupersessionCandidate, type ReconciliationResult } from "../claims-reconciliation.js";
import { appendReconciliationFindings } from "../pipeline-core.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) { console.error(`FAIL: ${msg}`); process.exit(1); }
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) { console.error(`FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); process.exit(1); }
}

// Helper: build a reconciliation claim (cast to any to bypass strict Claim schema in test context)
function makeClaim(metric: string, period: string, scope: string, sourceDoc: string): any {
  return {
    metric, period, scope_qualifier: scope, source_doc: sourceDoc,
    value: 100, unit: "£m", basis_note: "test", source_page: null,
    verbatim_snippet: "test snippet", claim_category: "operating_metric",
  };
}

// ---------------------------------------------------------------------------
// Test 1: Exact match + unrelated same-doc findings → supersedes correctly
// ---------------------------------------------------------------------------
console.log("Test 1: Exact match + unrelated same-doc findings");
{
  const candidates: SupersessionCandidate[] = [
    // Finding B: exact match to reconciliation claim
    { canonical_id: "finding-B", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
    // Finding X: SAME document but different coordinates — should be IGNORED not ambiguous
    { canonical_id: "finding-X", claim_metric: "EBITDA", claim_scope: "UK", claim_period: "FY2022", claim_source_doc: "memo.pdf" },
    // Finding Y: also same doc, also different coordinates
    { canonical_id: "finding-Y", claim_metric: "Net Income", claim_scope: "Group", claim_period: "FY2024", claim_source_doc: "memo.pdf" },
  ];

  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "memo.pdf"), finding_kind: "data_divergence" },
    candidates,
  );

  // Only finding-B should be proven; X and Y are irrelevant (not ambiguous)
  assertEqual(result.proven_ids.length, 1, "Should have exactly 1 proven ID");
  assertEqual(result.proven_ids[0], "finding-B", "Proven ID should be finding-B");
  assertEqual(result.ambiguous_ids.length, 0, "No ambiguous IDs — non-matching candidates are ignored");
  assert(result.diagnostic !== null, "Diagnostic should be emitted");
  assertEqual(result.diagnostic!.decision, "proven", "Decision should be 'proven'");
}

// ---------------------------------------------------------------------------
// Test 2: Matching + nonmatching evidence rows on ONE finding → resolves
// ---------------------------------------------------------------------------
console.log("Test 2: Matching + nonmatching evidence on one finding still resolves");
{
  // Finding A has multiple evidence rows: one matches, one doesn't
  const candidates: SupersessionCandidate[] = [
    // Evidence row 1 from finding A: MATCHES the reconciliation claim
    { canonical_id: "finding-A", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "report.pdf" },
    // Evidence row 2 from finding A: different metric — does NOT match
    { canonical_id: "finding-A", claim_metric: "EBITDA", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "report.pdf" },
  ];

  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "report.pdf"), finding_kind: "data_divergence" },
    candidates,
  );

  // finding-A should still be proven (deduplication by canonical_id)
  assertEqual(result.proven_ids.length, 1, "Should have 1 proven ID");
  assertEqual(result.proven_ids[0], "finding-A", "finding-A should be proven despite nonmatching evidence row");
  assertEqual(result.ambiguous_ids.length, 0, "No ambiguity");
  assertEqual(result.diagnostic!.decision, "proven", "Decision is proven");
}

// ---------------------------------------------------------------------------
// Test 3: Two distinct findings with exact match → ambiguous
// ---------------------------------------------------------------------------
console.log("Test 3: Two distinct exact current findings are ambiguous");
{
  const candidates: SupersessionCandidate[] = [
    { canonical_id: "finding-P", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
    { canonical_id: "finding-Q", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
  ];

  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "memo.pdf"), finding_kind: "data_divergence" },
    candidates,
  );

  assertEqual(result.proven_ids.length, 0, "No proven IDs when ambiguous");
  assertEqual(result.ambiguous_ids.length, 2, "Both findings are ambiguous");
  assert(result.ambiguous_ids.includes("finding-P"), "finding-P in ambiguous");
  assert(result.ambiguous_ids.includes("finding-Q"), "finding-Q in ambiguous");
  assertEqual(result.diagnostic!.decision, "ambiguous_appended", "Decision is ambiguous_appended");
}

// ---------------------------------------------------------------------------
// Test 4: No exact match → append-only with no_proven_candidate
// ---------------------------------------------------------------------------
console.log("Test 4: No exact match is append-only");
{
  const candidates: SupersessionCandidate[] = [
    // Same doc but different metric
    { canonical_id: "finding-Z", claim_metric: "EBITDA", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
    // Same metric but different doc
    { canonical_id: "finding-W", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "other.pdf" },
  ];

  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "memo.pdf"), finding_kind: "data_divergence" },
    candidates,
  );

  assertEqual(result.proven_ids.length, 0, "No proven IDs");
  assertEqual(result.ambiguous_ids.length, 0, "No ambiguous IDs (non-matching are ignored)");
  assert(result.diagnostic !== null, "Diagnostic should still be emitted");
  assertEqual(result.diagnostic!.decision, "no_proven_candidate", "Decision is no_proven_candidate");
}

// ---------------------------------------------------------------------------
// Test 5: Full production path — Stage 3.5 through appendReconciliationFindings
// Findings A, B, C exist; reconciliation replaces B → output = A, C, D
// ---------------------------------------------------------------------------
console.log("Test 5: Full Stage 3.5 → appendReconciliationFindings path");
{
  // Current-run findings
  const findings: any[] = [
    {
      finding_id: "id-A",
      title: "Finding A",
      category: "financial",
      detail: "A detail",
      evidence: [{ metric: "Cost", scope: "UK", period: "FY2022" }],
      source_docs: ["memo.pdf"],
    },
    {
      finding_id: "id-B",
      title: "Finding B — will be superseded",
      category: "financial",
      detail: "B detail",
      evidence: [{ metric: "Revenue", scope: "Group", period: "FY2023" }],
      source_docs: ["memo.pdf"],
    },
    {
      finding_id: "id-C",
      title: "Finding C",
      category: "legal",
      detail: "C detail",
      evidence: [{ metric: "Obligation", scope: "EU", period: "FY2023" }],
      source_docs: ["contract.pdf"],
    },
  ];

  // Build candidates from current findings (mimicking Stage 3.5 logic)
  const currentCandidates: SupersessionCandidate[] = [];
  for (const f of findings) {
    if (!f.finding_id || !f.evidence || f.evidence.length === 0) continue;
    const sourceDocs = f.source_docs && f.source_docs.length > 0 ? f.source_docs : [""];
    for (const ev of f.evidence) {
      const metric = ev.metric ?? "";
      const scope = ev.scope ?? "";
      const period = ev.period ?? "";
      if (!metric && !scope && !period) continue;
      for (const doc of sourceDocs) {
        currentCandidates.push({
          canonical_id: f.finding_id,
          claim_metric: metric,
          claim_scope: scope,
          claim_period: period,
          claim_source_doc: doc,
        });
      }
    }
  }

  // Reconciliation finding D replaces B (same metric/scope/period/source)
  const reconciliationFinding: any = {
    finding_id: "id-D",
    title: "Finding D — reconciled replacement",
    finding_kind: "data_divergence",
    category: "financial",
    detail: "D detail — supersedes B",
    claim: { metric: "Revenue", scope_qualifier: "Group", period: "FY2023", source_doc: "memo.pdf", value: "£200m", claim_type: "revenue" },
    supersedes_finding_ids: undefined as string[] | undefined,
    _supersession_diagnostic: undefined as any,
  };

  // Run proof against candidates from same source doc
  const eligibleCandidates = currentCandidates.filter(c => c.claim_source_doc === reconciliationFinding.claim.source_doc);
  const proofResult = validateSupersessionProof(
    { claim: reconciliationFinding.claim, finding_kind: reconciliationFinding.finding_kind },
    eligibleCandidates,
  );

  // Assign results
  if (proofResult.diagnostic) reconciliationFinding._supersession_diagnostic = proofResult.diagnostic;
  if (proofResult.proven_ids.length > 0 && proofResult.ambiguous_ids.length === 0) {
    reconciliationFinding.supersedes_finding_ids = proofResult.proven_ids;
  }

  // Verify supersession identified B
  assertEqual(reconciliationFinding.supersedes_finding_ids!.length, 1, "Should supersede 1 finding");
  assertEqual(reconciliationFinding.supersedes_finding_ids![0], "id-B", "Should supersede id-B");

  // Now run appendReconciliationFindings
  const claimsReconciliation = {
    findings: [reconciliationFinding],
    reconciled_count: 1,
    unreconcilable_count: 0,
    scope_mismatch_count: 0,
    within_tolerance_count: 0,
    cross_version_findings: 0,
  } as ReconciliationResult;
  const housekeepingFindings: any[] = [];
  const result = appendReconciliationFindings(findings, housekeepingFindings, claimsReconciliation);

  // Output should be A, C, D (B removed)
  const finalIds = result.finalFindings.map((f: any) => f.finding_id);
  assert(!finalIds.includes("id-B"), "B should be removed from final findings");
  assert(finalIds.includes("id-A"), "A should remain");
  assert(finalIds.includes("id-C"), "C should remain");
  assert(finalIds.includes("id-D"), "D should be appended");
  assertEqual(result.finalFindings.length, 3, "Final count should be 3: A, C, D");
}

// ---------------------------------------------------------------------------
// Test 6: Multiple evidence rows for same finding count once (deduplication)
// ---------------------------------------------------------------------------
console.log("Test 6: Multiple matching evidence rows for one finding count once");
{
  // Same finding-B has 3 evidence entries all matching the reconciliation claim coordinates
  const candidates: SupersessionCandidate[] = [
    { canonical_id: "finding-B", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
    { canonical_id: "finding-B", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
    { canonical_id: "finding-B", claim_metric: "Revenue", claim_scope: "Group", claim_period: "FY2023", claim_source_doc: "memo.pdf" },
  ];

  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "memo.pdf"), finding_kind: "data_divergence" },
    candidates,
  );

  // Should deduplicate to 1 proven ID
  assertEqual(result.proven_ids.length, 1, "Deduplicated to 1 proven");
  assertEqual(result.proven_ids[0], "finding-B", "Proven is finding-B");
  assertEqual(result.ambiguous_ids.length, 0, "No ambiguity");
}

// ---------------------------------------------------------------------------
// Test 7: Empty candidates → no diagnostic emitted
// ---------------------------------------------------------------------------
console.log("Test 7: Empty candidates returns cleanly");
{
  const result = validateSupersessionProof(
    { claim: makeClaim("Revenue", "FY2023", "Group", "memo.pdf"), finding_kind: "data_divergence" },
    [],
  );

  assertEqual(result.proven_ids.length, 0, "No proven");
  assertEqual(result.ambiguous_ids.length, 0, "No ambiguous");
  assert(result.diagnostic === null, "No diagnostic for empty candidates");
}

console.log("\n✓ All 7 Corrective E3 tests passed");
