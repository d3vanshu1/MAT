/**
 * DiagReconciliationFindings — loads reconciliation findings by report_id
 * from the dedicated reconciliation_findings table (F3), with pagination.
 *
 * Falls back to pipeline_checkpoints (legacy) if report_id not found in the
 * new table — backward-compatible with runs before F3 was deployed.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagReconciliationFindings",
  description: "Load reconciliation findings by report_id with pagination",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    /** The findings_report_id returned by reconciliation */
    reportId: z.string(),
    /** Legacy fallback: module_run_id for checkpoint lookup */
    runId: z.string().nullable(),
    /** 0-based page number (50 findings per page) */
    page: z.number().nullable(),
  }),

  output: z.object({
    found: z.boolean(),
    source: z.string(), // "reconciliation_findings" | "pipeline_checkpoints"
    findings_count: z.number(),
    reconciled_count: z.number(),
    unreconcilable_count: z.number(),
    cross_version_count: z.number(),
    within_tolerance_count: z.number(),
    scope_mismatch_count: z.number(),
    near_miss_count: z.number(),
    ambiguous_reference_count: z.number(),
    pagination: z.object({
      page: z.number(),
      page_size: z.number(),
      total_findings: z.number(),
      total_pages: z.number(),
    }),
    findings: z.array(z.any()),
  }),

  async run(ctx, { reportId, runId, page }) {
    const PAGE_SIZE = 50;
    const pageNum = page ?? 0;

    // --- Try dedicated table first ---
    const ReportRow = z.object({
      findings: z.any(),
      findings_count: z.number(),
    });

    let allFindings: any[] = [];
    let source = "reconciliation_findings";

    try {
      const rows = await ctx.integrations.db.query(
        `SELECT findings, findings_count FROM reconciliation_findings
         WHERE report_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        ReportRow,
        [reportId],
        { label: "Load findings from reconciliation_findings table" }
      );

      if (rows.length > 0) {
        const raw = rows[0].findings;
        allFindings = typeof raw === "string" ? JSON.parse(raw) : raw;
      }
    } catch {
      // Table may not exist yet — fall through to legacy
    }

    // --- Fallback to pipeline_checkpoints (legacy) ---
    if (allFindings.length === 0 && runId) {
      source = "pipeline_checkpoints";
      const CheckpointRow = z.object({ payload: z.any() });
      const rows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
         ORDER BY updated_at DESC LIMIT 1`,
        CheckpointRow,
        [runId],
        { label: "Load reconciliation checkpoint (legacy fallback)" }
      );

      if (rows.length > 0) {
        const payload = typeof rows[0].payload === "string"
          ? JSON.parse(rows[0].payload)
          : rows[0].payload;
        allFindings = payload.findings || [];
      }
    }

    if (allFindings.length === 0) {
      return {
        found: false,
        source,
        findings_count: 0,
        reconciled_count: 0,
        unreconcilable_count: 0,
        cross_version_count: 0,
        within_tolerance_count: 0,
        scope_mismatch_count: 0,
        near_miss_count: 0,
        ambiguous_reference_count: 0,
        pagination: { page: 0, page_size: PAGE_SIZE, total_findings: 0, total_pages: 0 },
        findings: [],
      };
    }

    // Count by kind
    const countByKind = (kind: string) => allFindings.filter((f: any) => f.finding_kind === kind).length;

    const totalPages = Math.ceil(allFindings.length / PAGE_SIZE);
    const pagedFindings = allFindings.slice(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE);

    // Format each finding for display
    const formatted = pagedFindings.map((f: any) => ({
      finding_kind: f.finding_kind,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      full_analysis: f.full_analysis,
      claim_metric: f.claim?.metric ?? null,
      claim_period: f.claim?.period ?? null,
      claim_scope: f.claim?.scope_qualifier ?? null,
      claim_value: f.claim?.value ?? null,
      claim_unit: f.claim?.unit ?? null,
      claim_source_doc: f.claim?.source_doc ?? null,
      claim_source_page: f.claim?.source_page ?? null,
      claim_verbatim: f.claim?.verbatim_snippet?.slice(0, 100) ?? null,
      model_figure_label: f.model_figure?.label ?? f.model_figure?.name ?? null,
      model_figure_value: f.model_figure?.value ?? null,
      model_figure_period: f.model_figure?.period ?? null,
      delta_abs: f.delta_abs ?? null,
      delta_pct: f.delta_pct ?? null,
      source_docs: f.source_docs ?? [],
    }));

    return {
      found: true,
      source,
      findings_count: allFindings.length,
      reconciled_count: countByKind("reconciled"),
      unreconcilable_count: countByKind("unreconcilable"),
      cross_version_count: countByKind("cross_version"),
      within_tolerance_count: countByKind("within_tolerance"),
      scope_mismatch_count: countByKind("scope_mismatch"),
      near_miss_count: countByKind("near_miss"),
      ambiguous_reference_count: countByKind("ambiguous_reference"),
      pagination: {
        page: pageNum,
        page_size: PAGE_SIZE,
        total_findings: allFindings.length,
        total_pages: totalPages,
      },
      findings: formatted,
    };
  },
});
