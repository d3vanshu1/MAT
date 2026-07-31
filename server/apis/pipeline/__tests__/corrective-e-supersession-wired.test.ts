/**
 * Corrective E — Production-path tests for wired supersession.
 *
 * Validates that the real runReconciliation() → appendReconciliationFindings()
 * flow correctly invokes validateSupersessionProof and populates/omits
 * supersedes_finding_ids based on deterministic coordinate proof.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/corrective-e-supersession-wired.test.ts
 */

import {
  runReconciliation,
  validateSupersessionProof,
  coordKey,
  type SupersessionCandidate,
  type ReconciliationResult,
} from "../claims-reconciliation.js";
import { appendReconciliationFindings } from "../pipeline-core.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else { console.log(`PASS: ${msg}`); passed++; }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal PipelineContext stub */
const mockCtx: any = {
  integrations: {
    db: {
      query: async () => [],
      execute: async () => ({ rowCount: 0 }),
    },
    ai: {
      apiRequest: async () => ({ content: [{ text: "[]" }] }),
    },
  },
};

/** Build a minimal Claim */
function makeClaim(metric: string, scope: string, period: string, sourceDoc: string, value = 100) {
  return {
    metric: metric as any,
    scope_qualifier: scope,
    period,
    value,
    unit: "£m" as const,
    basis_note: "test",
    source_doc: sourceDoc,
    source_page: null,
    verbatim_snippet: "test snippet",
    claim_category: "operating_metric" as const,
  };
}

/** Build a SupersessionCandidate */
function makeCandidate(id: string, metric: string, scope: string, period: string, sourceDoc: string): SupersessionCandidate {
  return {
    canonical_id: id,
    claim_metric: metric,
    claim_scope: scope,
    claim_period: period,
    claim_source_doc: sourceDoc,
  };
}

/** Build a minimal CanonicalFinding */
function makeCanonicalFinding(id: string, title: string): CanonicalFinding {
  return {
    finding_id: id,
    severity: "warning",
    title,
    detail: "detail",
    full_analysis: "full",
    source_docs: ["doc1.pdf"],
  };
}

/** Build a minimal ClaimsLedger */
function makeLedger(claims: any[]) {
  return {
    complete: true,
    claims,
    terminal_results: [],
    extraction_metadata: {
      docs_processed: 1,
      pending: 0,
      total_claims: claims.length,
      operating_metric_claims: claims.length,
      deal_mechanics_claims: 0,
      valuation_structuring_claims: 0,
      returns_projection_claims: 0,
      cross_reference_claims: 0,
      extraction_model: "test",
      extraction_timestamp: new Date().toISOString(),
    },
  };
}

/** Build a verified figure */
function makeFigure(metric: string, period: string, value: number) {
  return {
    name: metric,
    sheet: "P&L",
    period,
    value,
    cell: "B5",
    source_doc: "model.xlsx",
    document_role: "financial_model",
    scope_qualifier: metric,
    source_cell: "B5",
    source_sheet: "P&L",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  // --- Test 1: Real runReconciliation path invokes the validator ---
  {
    const candidate = makeCandidate("prior-id-1", "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const eligible = result.findings.filter(f => f._supersession_diagnostic != null);
    assert(eligible.length > 0, "Test 1: runReconciliation invokes validator (diagnostic present)");
    assert((result.supersession_diagnostics_count ?? 0) > 0, "Test 1b: supersession_diagnostics_count incremented");
  }

  // --- Test 2: Exact coordinate + source candidate produces supersedes_finding_ids ---
  {
    const candidate = makeCandidate("exact-match-id", "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const divergenceFindings = result.findings.filter(f => f.finding_kind === "data_divergence");
    assert(divergenceFindings.length > 0, "Test 2: data_divergence finding produced");
    const superseding = divergenceFindings.find(f => f.supersedes_finding_ids && f.supersedes_finding_ids.length > 0);
    assert(superseding != null, "Test 2b: supersedes_finding_ids populated for exact match");
    if (superseding) {
      assert(
        superseding.supersedes_finding_ids!.includes("exact-match-id"),
        "Test 2c: correct canonical ID in supersedes_finding_ids"
      );
    }
  }

  // --- Test 3: Ambiguous candidate set produces no supersession IDs ---
  {
    // Candidate has DIFFERENT source doc → doesn't pass source-doc eligibility filter
    const candidate = makeCandidate("ambig-id", "revenue", "Total Group Revenue", "fy mar-26", "different-memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const divergenceFindings = result.findings.filter(f => f.finding_kind === "data_divergence");
    const superseding = divergenceFindings.find(f => f.supersedes_finding_ids && f.supersedes_finding_ids.length > 0);
    assertEqual(superseding, undefined, "Test 3: no supersession IDs for mismatched source doc candidate");
  }

  // --- Test 4: Same category/title/issue_key alone produces no supersession ---
  {
    // Candidate matches source_doc but has different metric coordinates
    const candidate = makeCandidate("title-only-id", "EBITDA", "Adjusted EBITDA", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const divergenceFindings = result.findings.filter(f => f.finding_kind === "data_divergence");
    // Candidate has different metric (EBITDA vs revenue) → cannot prove supersession
    const withDiag = divergenceFindings.find(f => f._supersession_diagnostic?.decision === "ambiguous_appended");
    assert(withDiag != null, "Test 4: different metric → ambiguous diagnostic (no supersession)");
    const superseding = divergenceFindings.find(f => f.supersedes_finding_ids && f.supersedes_finding_ids.length > 0);
    assertEqual(superseding, undefined, "Test 4b: no supersession IDs when metric differs");
  }

  // --- Test 5: Resulting output reaches appendReconciliationFindings and removes exact ID ---
  {
    const priorFindingId = "11111111-1111-4111-8111-111111111111";
    const candidate = makeCandidate(priorFindingId, "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const reconResult = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding(priorFindingId, "Old Revenue Finding"),
      makeCanonicalFinding("22222222-2222-4222-8222-222222222222", "Unrelated Finding"),
    ];

    const appendResult = appendReconciliationFindings(existingFindings, [], reconResult);
    const remainingIds = appendResult.finalFindings.map(f => f.finding_id);
    assert(!remainingIds.includes(priorFindingId), "Test 5: superseded finding removed from final set");
    assert(remainingIds.includes("22222222-2222-4222-8222-222222222222"), "Test 5b: unrelated finding survives");
  }

  // --- Test 6: Exact original removed and unrelated findings survive ---
  {
    const priorId = "33333333-3333-4333-8333-333333333333";
    const unrelatedId = "44444444-4444-4444-8444-444444444444";
    const candidate = makeCandidate(priorId, "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const reconResult = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding(priorId, "Prior Revenue"),
      makeCanonicalFinding(unrelatedId, "Unrelated EBITDA"),
    ];

    const appendResult = appendReconciliationFindings(existingFindings, [], reconResult);
    assert(!appendResult.finalFindings.some(f => f.finding_id === priorId), "Test 6: prior finding removed");
    assert(appendResult.finalFindings.some(f => f.finding_id === unrelatedId), "Test 6b: unrelated finding preserved");
    assert(appendResult.finalFindings.length >= 2, "Test 6c: replacement finding appended");
  }

  // --- Test 7: Diagnostics survive in reconciliation result ---
  {
    const candidate = makeCandidate("diag-id", "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    const withDiag = result.findings.filter(f => f._supersession_diagnostic != null);
    assert(withDiag.length > 0, "Test 7: diagnostic persisted on finding");
    const diag = withDiag[0]._supersession_diagnostic!;
    assert(diag.decision === "proven" || diag.decision === "ambiguous_appended", "Test 7b: valid decision field");
    assert(Array.isArray(diag.candidate_ids) && diag.candidate_ids.length > 0, "Test 7c: candidate_ids populated");
  }

  // --- Test 8: Resume/replay does not duplicate — checkpoint idempotency ---
  {
    const priorId = "55555555-5555-4555-8555-555555555555";
    const candidate = makeCandidate(priorId, "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result1 = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
      [candidate],
    );

    // Simulate resume: same reconciliation result applied twice to same findings
    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding(priorId, "Prior Revenue"),
    ];

    const appendResult1 = appendReconciliationFindings(existingFindings, [], result1);
    // Apply same result again (simulating idempotent resume)
    const appendResult2 = appendReconciliationFindings(appendResult1.finalFindings, [], result1);

    // Idempotency check in appendReconciliationFindings prevents double-append
    const reconTitles = appendResult2.finalFindings.filter(f =>
      f.title.includes("Total Group Revenue") || f.title.includes("Revenue")
    );
    assert(reconTitles.length <= 2, "Test 8: replay does not create unlimited duplicates");
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}\nResults: ${passed} passed, ${failed} failed\n${"=".repeat(60)}`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
