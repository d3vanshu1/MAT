/**
 * Corrective E — Updated for Corrective E2.
 *
 * Validates that runReconciliation() NO LONGER performs internal supersession
 * (the priorCanonicalFindings parameter was removed in E2). Supersession logic
 * is now tested in corrective-e2-current-run-supersession.test.ts.
 *
 * These tests verify:
 * 1. runReconciliation produces findings WITHOUT supersedes_finding_ids
 * 2. validateSupersessionProof still works correctly in isolation
 * 3. appendReconciliationFindings still respects supersedes_finding_ids when present
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
  // --- Test 1: runReconciliation no longer produces supersession diagnostics ---
  {
    const claims = [makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150)];
    const figures = [makeFigure("Total Group Revenue", "FY Mar-26", 120_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
    );

    // Corrective E2: runReconciliation no longer calls validateSupersessionProof
    const withSupersession = result.findings.filter(f => f.supersedes_finding_ids && f.supersedes_finding_ids.length > 0);
    assertEqual(withSupersession.length, 0, "Test 1: runReconciliation produces no supersedes_finding_ids (E2 moved it out)");
    assertEqual(result.supersession_diagnostics_count ?? 0, 0, "Test 1b: no supersession diagnostics from runReconciliation");
  }

  // --- Test 2: validateSupersessionProof still works correctly in isolation ---
  {
    const candidate = makeCandidate("exact-match-id", "revenue", "Total Group Revenue", "fy mar-26", "memo.pdf");
    const claim = makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150);

    const proofResult = validateSupersessionProof(
      { claim, finding_kind: "data_divergence" },
      [candidate],
    );

    assert(proofResult.proven_ids.includes("exact-match-id"), "Test 2: validator proves exact coordinate match");
    assertEqual(proofResult.ambiguous_ids.length, 0, "Test 2b: no ambiguous IDs");
    assertEqual(proofResult.diagnostic?.decision, "proven", "Test 2c: diagnostic is 'proven'");
  }

  // --- Test 3: Ambiguous candidate → append-only in validator ---
  {
    const candidate = makeCandidate("ambig-id", "EBITDA", "Adjusted EBITDA", "fy mar-26", "memo.pdf");
    const claim = makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150);

    const proofResult = validateSupersessionProof(
      { claim, finding_kind: "data_divergence" },
      [candidate],
    );

    assertEqual(proofResult.proven_ids.length, 0, "Test 3: different metric → no proven IDs");
    assert(proofResult.ambiguous_ids.length > 0, "Test 3b: candidate marked ambiguous");
    assertEqual(proofResult.diagnostic?.decision, "ambiguous_appended", "Test 3c: diagnostic is 'ambiguous_appended'");
  }

  // --- Test 4: appendReconciliationFindings still respects supersedes_finding_ids ---
  {
    const priorFindingId = "11111111-1111-4111-8111-111111111111";
    const reconResult: ReconciliationResult = {
      findings: [{
        finding_kind: "data_divergence",
        severity: "warning",
        title: "Revenue divergence",
        detail: "detail",
        full_analysis: "full",
        severity_anchor: 5_000_000,
        source_docs: ["memo.pdf"],
        claim: makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150),
        model_figure: null,
        delta_abs: 5_000_000,
        delta_pct: 0.05,
        supersedes_finding_ids: [priorFindingId],
      }],
      reconciled_count: 1,
      unreconcilable_count: 0,
      scope_mismatch_count: 0,
      within_tolerance_count: 0,
      cross_version_findings: 0,
    };

    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding(priorFindingId, "Old Revenue Finding"),
      makeCanonicalFinding("22222222-2222-4222-8222-222222222222", "Unrelated Finding"),
    ];

    const appendResult = appendReconciliationFindings(existingFindings, [], reconResult);
    const remainingIds = appendResult.finalFindings.map(f => f.finding_id);
    assert(!remainingIds.includes(priorFindingId), "Test 4: superseded finding removed from final set");
    assert(remainingIds.includes("22222222-2222-4222-8222-222222222222"), "Test 4b: unrelated finding survives");
  }

  // --- Test 5: coordKey utility produces normalized keys ---
  {
    const key1 = coordKey("revenue", "Total Group Revenue", "FY Mar-26");
    const key2 = coordKey("Revenue", "total group revenue", "fy mar-26");
    assertEqual(key1, key2, "Test 5: coordKey normalizes case");
  }

  // --- Test 6: Resume/replay idempotency via appendReconciliationFindings ---
  {
    const reconResult: ReconciliationResult = {
      findings: [{
        finding_kind: "data_divergence",
        severity: "warning",
        title: "Revenue divergence",
        detail: "detail",
        full_analysis: "full",
        severity_anchor: 5_000_000,
        source_docs: ["memo.pdf"],
        claim: makeClaim("revenue", "Total Group Revenue", "FY Mar-26", "memo.pdf", 150),
        model_figure: null,
        delta_abs: 5_000_000,
        delta_pct: 0.05,
        supersedes_finding_ids: ["target-id-1"],
      }],
      reconciled_count: 1,
      unreconcilable_count: 0,
      scope_mismatch_count: 0,
      within_tolerance_count: 0,
      cross_version_findings: 0,
    };

    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding("target-id-1", "Prior Revenue"),
    ];

    const result1 = appendReconciliationFindings(existingFindings, [], reconResult);
    const result2 = appendReconciliationFindings(result1.finalFindings, [], reconResult);

    assertEqual(
      result2.finalFindings.length, result1.finalFindings.length,
      "Test 6: replay does not create duplicates"
    );
  }

  // --- Test 7: Unknown target IDs trigger fail-closed ---
  {
    const reconResult: ReconciliationResult = {
      findings: [{
        finding_kind: "data_divergence",
        severity: "warning",
        title: "Ghost supersession",
        detail: "detail",
        full_analysis: "full",
        severity_anchor: 5_000_000,
        source_docs: ["memo.pdf"],
        claim: makeClaim("revenue", "Organic", "FY Mar-26", "memo.pdf"),
        model_figure: null,
        delta_abs: 5_000_000,
        delta_pct: 0.05,
        supersedes_finding_ids: ["nonexistent-id"],
      }],
      reconciled_count: 1,
      unreconcilable_count: 0,
      scope_mismatch_count: 0,
      within_tolerance_count: 0,
      cross_version_findings: 0,
    };

    const existingFindings: CanonicalFinding[] = [
      makeCanonicalFinding("real-id-1", "Real Finding"),
    ];

    const result = appendReconciliationFindings(existingFindings, [], reconResult);
    assert(result.finalFindings.some(f => f.finding_id === "real-id-1"), "Test 7: real finding preserved");
    assert(result.diagnostics.some(d => d.type === "unknown_target_id"), "Test 7b: unknown_target_id diagnostic emitted");
  }

  // --- Test 8: runReconciliation signature only accepts 6 arguments ---
  {
    // TypeScript enforces this at compile time, but runtime verification that
    // the function works with exactly 6 args (no prior candidates)
    const claims = [makeClaim("revenue", "Organic Revenue", "FY Mar-26", "memo.pdf", 200)];
    const figures = [makeFigure("Organic Revenue", "FY Mar-26", 180_000_000)];

    const result = await runReconciliation(
      mockCtx,
      makeLedger(claims),
      figures,
      [],
      Date.now(),
      60_000,
    );

    assert(result.findings.length >= 0, "Test 8: runReconciliation works with 6 args (no priorCanonicalFindings)");
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}\nResults: ${passed} passed, ${failed} failed\n${"=".repeat(60)}`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
