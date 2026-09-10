/**
 * GetModuleReport — loads full report + full findings for one module run.
 *
 * Called on-demand when the user expands a module card to view the
 * full report. Separated from LoadModuleResults to keep the listing
 * query under the 4MB gRPC limit.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const OutputRow = z.object({
  findings: z.any(),
  full_report_markdown: z.string().nullable(),
  executive_header: z.string().nullable(),
});

export default api({
  name: "GetModuleReport",
  description: "Loads full findings + report markdown for one module run",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    findings: z.any(),
    fullReport: z.string().nullable(),
    executiveHeader: z.string().nullable(),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.ic_diligence_db;

    const rows = await db.query(
      "SELECT mo.findings, mo.full_report_markdown, mo.executive_header FROM module_outputs mo WHERE mo.module_run_id = $1::uuid LIMIT 1",
      OutputRow,
      [runId],
      { label: "GetModuleReport: load full output" },
    );

    if (rows.length === 0) {
      return { findings: [], fullReport: null, executiveHeader: null };
    }

    const row = rows[0];
    const findings = typeof row.findings === "string" ? JSON.parse(row.findings) : (row.findings ?? []);

    return {
      findings,
      fullReport: row.full_report_markdown,
      executiveHeader: row.executive_header,
    };
  },
});
