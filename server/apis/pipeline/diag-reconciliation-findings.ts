/**
 * DiagReconciliationFindings — loads the pipeline's reconciliation findings
 * for the SCG run and reports counts/structure for readiness verification.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagReconciliationFindings",
  description: "Load pipeline reconciliation findings for a run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    found: z.boolean(),
    findings_count: z.number(),
    reconciled_count: z.number(),
    unreconcilable_count: z.number(),
    cross_version_count: z.number(),
    within_tolerance_count: z.number(),
    scope_mismatch_count: z.number(),
    sample_findings: z.array(z.any()),
  }),

  async run(ctx, { runId }) {
    const Row = z.object({ payload: z.any() });
    const rows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
       ORDER BY updated_at DESC LIMIT 1`,
      Row,
      [runId],
      { label: "Load reconciliation checkpoint" }
    );

    if (rows.length === 0) {
      return {
        found: false,
        findings_count: 0,
        reconciled_count: 0,
        unreconcilable_count: 0,
        cross_version_count: 0,
        within_tolerance_count: 0,
        scope_mismatch_count: 0,
        sample_findings: [],
      };
    }

    const payload = typeof rows[0].payload === "string"
      ? JSON.parse(rows[0].payload)
      : rows[0].payload;

    const findings = payload.findings || [];

    // Return first 5 findings with claim details
    const sample = findings.slice(0, 5).map((f: any) => ({
      finding_kind: f.finding_kind,
      severity: f.severity,
      title: f.title,
      claim_metric: f.claim?.metric,
      claim_period: f.claim?.period,
      claim_scope: f.claim?.scope_qualifier,
      claim_value: f.claim?.value,
      claim_unit: f.claim?.unit,
      claim_source_doc: f.claim?.source_doc,
      claim_source_page: f.claim?.source_page,
      claim_verbatim: f.claim?.verbatim_snippet?.slice(0, 100),
      model_figure_label: f.model_figure?.label,
      model_figure_value: f.model_figure?.value,
      delta_abs: f.delta_abs,
      delta_pct: f.delta_pct,
      source_docs: f.source_docs,
    }));

    return {
      found: true,
      findings_count: findings.length,
      reconciled_count: payload.reconciled_count ?? 0,
      unreconcilable_count: payload.unreconcilable_count ?? 0,
      cross_version_count: payload.cross_version_findings ?? 0,
      within_tolerance_count: payload.within_tolerance_count ?? 0,
      scope_mismatch_count: payload.scope_mismatch_count ?? 0,
      sample_findings: sample,
    };
  },
});
