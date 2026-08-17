/**
 * DiagReconcileOnly — reconciliation-only harness.
 *
 * Loads a pre-existing claims ledger and numeric figures from the database,
 * then runs runReconciliation directly. Zero LLM calls. Expected runtime: seconds.
 *
 * Inputs:
 *   - dealId: deal to load ledger for (from diag_claims_ledger)
 *   - numericReportId: UUID of the numeric_reports row to load figures from
 *
 * Use case: verify F1/F2/F3 logic on a real dataset without burning 180s on
 * claims extraction.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runReconciliation, type ReconciliationFinding } from "./claims-reconciliation.js";
import type { Figure, Discrepancy } from "./numeric-verify-inline.js";
import type { ClaimsLedger } from "./claims-extraction.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "DiagReconcileOnly",
  description: "Run reconciliation on pre-loaded ledger + figures (no LLM calls)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    // ai declared for PipelineContext type satisfaction — never called
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    numericReportId: z.string(),
    /** 0-based page for findings (50/page). Null = page 0. */
    page: z.number().nullable(),
  }),

  output: z.object({
    // Load diagnostics
    ledger_found: z.boolean(),
    ledger_claims_count: z.number(),
    figures_found: z.boolean(),
    figures_count: z.number(),
    discrepancies_count: z.number(),
    // Reconciliation result
    findings_report_id: z.string().nullable(),
    findings_truncated: z.boolean(),
    total_findings: z.number(),
    reconciled_count: z.number(),
    unreconcilable_count: z.number(),
    scope_mismatch_count: z.number(),
    within_tolerance_count: z.number(),
    cross_version_findings: z.number(),
    near_miss_count: z.number(),
    ambiguous_reference_count: z.number(),
    matching_error: z.string().nullable(),
    // Coverage table
    coverage: z.object({
      raw_claims: z.number(),
      distinct_claims: z.number(),
      scenario_excluded: z.number(),
      no_scope_count: z.number(),
      no_scope_near_miss_eligible: z.number(),
      no_period_count: z.number(),
      ambiguous_reference_count: z.number(),
      adjudicable: z.number(),
      matched: z.number(),
      near_miss: z.number(),
      unmatched: z.number(),
      coverage_pct: z.number(),
      coverage_with_near_miss_pct: z.number(),
    }).nullable(),
    // Paginated findings
    pagination: z.object({
      page: z.number(),
      page_size: z.number(),
      total_findings: z.number(),
      total_pages: z.number(),
    }),
    findings: z.array(z.object({
      finding_kind: z.string(),
      severity: z.string(),
      title: z.string(),
      detail: z.string(),
      full_analysis: z.string(),
      claim_metric: z.string().nullable(),
      claim_scope: z.string().nullable(),
      claim_period: z.string().nullable(),
      claim_value: z.string().nullable(),
      claim_source_doc: z.string().nullable(),
      model_label: z.string().nullable(),
      model_period: z.string().nullable(),
      model_value_m: z.string().nullable(),
      delta_abs_m: z.string().nullable(),
      delta_pct: z.string().nullable(),
      source_docs: z.array(z.string()),
    })),
    elapsed_ms: z.number(),
  }),

  async run(ctx, { dealId, numericReportId, page }) {
    const startTime = Date.now();
    const PAGE_SIZE = 50;
    const pageNum = page ?? 0;

    // --- Step 1: Load ledger from diag_claims_ledger ---
    const LedgerRow = z.object({ ledger: z.any() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT ledger FROM diag_claims_ledger WHERE deal_id = $1 LIMIT 1`,
      LedgerRow,
      [dealId],
      { label: "Load claims ledger" }
    );

    if (ledgerRows.length === 0) {
      return emptyResult(pageNum, PAGE_SIZE, Date.now() - startTime, false, true);
    }

    const rawLedger = ledgerRows[0].ledger;
    const ledger: ClaimsLedger = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;

    // --- Step 2: Load figures from numeric_reports ---
    const ReportRow = z.object({ figures: z.any(), discrepancies: z.any() });
    const reportRows = await ctx.integrations.db.query(
      `SELECT figures, discrepancies FROM numeric_reports WHERE id = $1 LIMIT 1`,
      ReportRow,
      [numericReportId],
      { label: "Load numeric report figures" }
    );

    if (reportRows.length === 0) {
      return emptyResult(pageNum, PAGE_SIZE, Date.now() - startTime, true, false, ledger.claims.length);
    }

    const rawFigures = typeof reportRows[0].figures === "string"
      ? JSON.parse(reportRows[0].figures)
      : reportRows[0].figures;
    const rawDisc = typeof reportRows[0].discrepancies === "string"
      ? JSON.parse(reportRows[0].discrepancies)
      : reportRows[0].discrepancies;

    const figures: Figure[] = Array.isArray(rawFigures) ? rawFigures : [];
    const discrepancies: Discrepancy[] = Array.isArray(rawDisc) ? rawDisc : [];

    console.log(
      `[DiagReconcileOnly] Loaded: ${ledger.claims.length} claims, ${figures.length} figures, ${discrepancies.length} discrepancies`
    );

    // --- Step 3: Run reconciliation (pure in-memory — no LLM) ---
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    const result = await runReconciliation(
      pipelineCtx,
      ledger,
      figures,
      discrepancies,
      startTime,
      60_000, // 60s budget (reconciliation is <1s in practice)
      dealId,
    );

    // --- Step 4: Paginate findings ---
    const totalPages = Math.ceil(result.findings.length / PAGE_SIZE);
    const pagedFindings = result.findings.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    const formatted = pagedFindings.map((rf: ReconciliationFinding) => ({
      finding_kind: rf.finding_kind,
      severity: rf.severity,
      title: rf.title,
      detail: rf.detail,
      full_analysis: rf.full_analysis,
      claim_metric: rf.claim?.metric ?? null,
      claim_scope: rf.claim?.scope_qualifier ?? null,
      claim_period: rf.claim?.period ?? null,
      claim_value: rf.claim ? `${rf.claim.value}${rf.claim.unit}` : null,
      claim_source_doc: rf.claim?.source_doc ?? null,
      model_label: rf.model_figure?.name ?? null,
      model_period: rf.model_figure?.period ?? null,
      model_value_m: rf.model_figure ? `£${(rf.model_figure.value / 1_000_000).toFixed(2)}m` : null,
      delta_abs_m: rf.delta_abs != null ? `£${(rf.delta_abs / 1_000_000).toFixed(2)}m` : null,
      delta_pct: rf.delta_pct != null ? `${(rf.delta_pct * 100).toFixed(1)}%` : null,
      source_docs: rf.source_docs,
    }));

    const elapsed = Date.now() - startTime;
    console.log(`[DiagReconcileOnly] Complete in ${elapsed}ms`);

    return {
      ledger_found: true,
      ledger_claims_count: ledger.claims.length,
      figures_found: true,
      figures_count: figures.length,
      discrepancies_count: discrepancies.length,
      findings_report_id: result.findings_report_id,
      findings_truncated: result.findings_truncated ?? false,
      total_findings: result.findings.length,
      reconciled_count: result.reconciled_count,
      unreconcilable_count: result.unreconcilable_count,
      scope_mismatch_count: result.scope_mismatch_count,
      within_tolerance_count: result.within_tolerance_count,
      cross_version_findings: result.cross_version_findings,
      near_miss_count: result.near_miss_count,
      ambiguous_reference_count: result.ambiguous_reference_count,
      matching_error: result.matching_error ?? null,
      coverage: result.coverage,
      pagination: {
        page: pageNum,
        page_size: PAGE_SIZE,
        total_findings: result.findings.length,
        total_pages: totalPages,
      },
      findings: formatted,
      elapsed_ms: elapsed,
    };
  },
});

// --- Helper: empty result for early returns ---
function emptyResult(
  page: number,
  pageSize: number,
  elapsed: number,
  ledgerFound: boolean,
  figuresFound: boolean,
  claimsCount = 0,
) {
  return {
    ledger_found: ledgerFound,
    ledger_claims_count: claimsCount,
    figures_found: figuresFound,
    figures_count: 0,
    discrepancies_count: 0,
    findings_report_id: null,
    findings_truncated: false,
    total_findings: 0,
    reconciled_count: 0,
    unreconcilable_count: 0,
    scope_mismatch_count: 0,
    within_tolerance_count: 0,
    cross_version_findings: 0,
    near_miss_count: 0,
    ambiguous_reference_count: 0,
    matching_error: ledgerFound ? null : "No ledger found for deal",
    coverage: null,
    pagination: { page, page_size: pageSize, total_findings: 0, total_pages: 0 },
    findings: [],
    elapsed_ms: elapsed,
  };
}
