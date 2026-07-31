import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";
import { strictReloadFindings } from "./strict-reload-findings.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunOutputRowSchema = z.object({
  run_id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  documents_included: z.any(), // TEXT[]
  executive_header: z.string().nullable(),
  findings: z.any(), // JSONB — validated via canonical parser below
  full_report_markdown: z.string().nullable(),
});

export default api({
  name: "GetRunOutput",
  description: "Loads the full output (findings JSON + report) for a specific module run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  // RC1: output uses CanonicalFindingSchema — all fields including finding_kind,
  // severity_anchor, issue_key, structured_impact, evidence, etc.
  output: z.object({
    run: z.object({
      id: z.string(),
      moduleId: z.string(),
      status: z.string(),
      triggeredAt: z.string(),
      completedAt: z.string().nullable(),
      documentsIncluded: z.array(z.string()),
    }).nullable(),
    output: z.object({
      executiveHeader: z.string(),
      findings: z.array(CanonicalFindingSchema),
      fullReport: z.string(),
    }).nullable(),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
        mr.id AS run_id,
        mr.module_id,
        mr.status,
        mr.triggered_at,
        mr.completed_at,
        mr.documents_included,
        mo.executive_header,
        mo.findings,
        mo.full_report_markdown
      FROM module_runs mr
      LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
      WHERE mr.id = $1
      LIMIT 1`,
      RunOutputRowSchema,
      [runId],
      { label: "Get run output by ID" }
    );

    if (rows.length === 0) {
      return { run: null, output: null };
    }

    const row = rows[0];

    // RC1 + Fix 3: strict reload — fail closed on any corruption
    let findings;
    try {
      findings = row.findings
        ? strictReloadFindings(row.findings, `GetRunOutput run_id=${runId}`).findings
        : [];
    } catch (err) {
      console.error(`[GetRunOutput] Fail-closed:`, err instanceof Error ? err.message : err);
      return {
        run: {
          id: row.run_id,
          moduleId: row.module_id,
          status: row.status,
          triggeredAt: row.triggered_at,
          completedAt: row.completed_at,
          documentsIncluded: Array.isArray(row.documents_included)
            ? row.documents_included.map(String)
            : [],
        },
        output: null, // fail closed — do not serve corrupt findings
      };
    }

    const docsIncluded = Array.isArray(row.documents_included)
      ? row.documents_included.map(String)
      : [];

    return {
      run: {
        id: row.run_id,
        moduleId: row.module_id,
        status: row.status,
        triggeredAt: row.triggered_at,
        completedAt: row.completed_at,
        documentsIncluded: docsIncluded,
      },
      output: row.full_report_markdown != null
        ? {
            executiveHeader: row.executive_header ?? "",
            findings,
            fullReport: row.full_report_markdown,
          }
        : null,
    };
  },
});
