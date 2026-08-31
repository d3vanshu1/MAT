/**
 * One-shot helper: re-render the DCS report and republish module_outputs
 * with v2 data. Use after rationales have been persisted to the verdicts
 * detail JSONB (e.g. via DcsPersistRationalesOneshot).
 *
 * Flow:
 * 1. Call DcsRenderReport (reads from DB, no model calls)
 * 2. DELETE + INSERT module_outputs with v2 findings payload
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import DcsRenderReport from "./dcs-render-report.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const OutputIdRow = z.object({ id: z.string() });

export default api({
  name: "DcsRepublishV2",
  description: "Re-renders DCS report and republishes module_outputs with v2 data",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    runId: z.string().uuid(),
  }),

  output: z.object({
    success: z.boolean(),
    reportVersion: z.number(),
    reportLength: z.number(),
    headerPreview: z.string(),
    message: z.string(),
  }),

  async run(ctx, { dealId, runId }) {
    const db = ctx.integrations.ic_diligence_db;

    // 1. Render report (reads verdicts + rationales from DB)
    console.log(`[REPUBLISH] Rendering report for run=${runId}`);
    const renderResult = await DcsRenderReport.run(ctx, {
      runId,
      dealId,
      verificationMode: false,
      verificationVerdicts: undefined,
      verificationSummary: undefined,
      verificationMaterialityOverlay: undefined,
      verificationRationales: undefined,
    });

    console.log(`[REPUBLISH] Report version=${renderResult.reportVersion}, hash=${renderResult.reportHash}`);

    // 2. Build findings payload (v2-aware)
    const findings = renderResult.reportVersion === 2
      ? [{
          reportVersion: renderResult.reportVersion,
          coverageOverview: renderResult.coverageOverview,
          dimensionRationales: renderResult.dimensionRationales,
          corpusScope: renderResult.corpusScope,
          reportMarkdown: renderResult.fullReportMarkdown,
          reportHash: renderResult.reportHash,
          rationaleHash: renderResult.rationaleHash,
          priorityGaps: renderResult.priorityGaps,
        }]
      : [];

    // 3. DELETE + INSERT (matches pipeline complete case pattern)
    await db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
      [runId],
      { label: "Republish: clear existing module_outputs" },
    );

    await db.query(
      `INSERT INTO module_outputs
         (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1::uuid, $2, $3::jsonb, $4)
       RETURNING id`,
      OutputIdRow,
      [runId, renderResult.executiveHeader, JSON.stringify(findings), renderResult.fullReportMarkdown],
      { label: "Republish: insert v2 module_outputs" },
    );

    console.log(`[REPUBLISH] Module outputs republished with v${renderResult.reportVersion} data`);

    return {
      success: true,
      reportVersion: renderResult.reportVersion,
      reportLength: renderResult.fullReportMarkdown.length,
      headerPreview: renderResult.executiveHeader.slice(0, 200),
      message: `Republished module_outputs with v${renderResult.reportVersion} report (${renderResult.fullReportMarkdown.length} chars).`,
    };
  },
});
