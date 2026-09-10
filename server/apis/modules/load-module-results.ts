import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Listing query — returns header + SQL-computed counts only.
 *
 * CRITICAL: Do NOT add mo.findings or mo.full_report_markdown to this query.
 * ERO alone produces 4.1 MB of findings JSONB + 1.2 MB markdown.
 * Loading all modules in one response exceeds the 4 MB wire limit and
 * crashes the entire dashboard — all module cards vanish, not just the
 * oversized one.
 *
 * Full payload is loaded on-demand via GetRunOutput when a user expands
 * a module card.
 *
 * The jsonb_typeof guard is required: DCS v2 writes a report envelope
 * (object), not an array. jsonb_array_length on an object would throw
 * and take the query down — a different flavor of the same outage.
 */
const ModuleStatusRowSchema = z.object({
  module_id: z.string(),
  run_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  executive_header: z.string().nullable(),
  has_output: z.boolean().nullable(),
  findings_count: z.coerce.number(),
  critical_count: z.coerce.number(),
  warning_count: z.coerce.number(),
  info_count: z.coerce.number(),
  critical_assessed_count: z.coerce.number(),
  output_created_at: z.string().nullable(),
});

const BASE_QUERY = `SELECT DISTINCT ON (mr.module_id)
  mr.module_id,
  mr.id AS run_id,
  mr.status,
  mr.triggered_at,
  mr.completed_at,
  mo.executive_header,
  (mo.id IS NOT NULL AND mo.full_report_markdown IS NOT NULL) AS has_output,
  CASE WHEN jsonb_typeof(mo.findings) = 'array'
       THEN jsonb_array_length(mo.findings) ELSE 0 END AS findings_count,
  CASE WHEN jsonb_typeof(mo.findings) = 'array' THEN (
    SELECT count(*) FROM jsonb_array_elements(mo.findings) f
    WHERE f->>'severity' = 'critical') ELSE 0 END AS critical_count,
  CASE WHEN jsonb_typeof(mo.findings) = 'array' THEN (
    SELECT count(*) FROM jsonb_array_elements(mo.findings) f
    WHERE f->>'severity' = 'warning') ELSE 0 END AS warning_count,
  CASE WHEN jsonb_typeof(mo.findings) = 'array' THEN (
    SELECT count(*) FROM jsonb_array_elements(mo.findings) f
    WHERE f->>'severity' = 'info') ELSE 0 END AS info_count,
  CASE WHEN jsonb_typeof(mo.findings) = 'array' THEN (
    SELECT count(*) FROM jsonb_array_elements(mo.findings) f
    WHERE COALESCE(f->>'severity_assessed', f->>'severity') = 'critical') ELSE 0 END
    AS critical_assessed_count,
  mo.created_at AS output_created_at
FROM module_runs mr
LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
LEFT JOIN module_run_flags mrf ON mrf.module_run_id = mr.id
WHERE mr.deal_id = $1
  AND COALESCE(mrf.diagnostic_only, FALSE) = FALSE
ORDER BY mr.module_id,
  CASE WHEN mr.status = 'running' THEN 0
       WHEN mo.id IS NOT NULL THEN 1
       ELSE 2
  END,
  mr.triggered_at DESC
LIMIT 50`;

export default api({
  name: "LoadModuleResults",
  description: "Loads the latest module run status + counts for each module of a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    modules: z.array(
      z.object({
        moduleId: z.string(),
        latestRun: z.object({
          id: z.string(),
          status: z.string(),
          triggeredAt: z.string(),
          completedAt: z.string().nullable(),
        }),
        latestOutput: z
          .object({
            executiveHeader: z.string().nullable(),
            findingsCount: z.number(),
            criticalCount: z.number(),
            warningCount: z.number(),
            infoCount: z.number(),
            criticalAssessedCount: z.number(),
            createdAt: z.string(),
          })
          .nullable(),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      BASE_QUERY,
      ModuleStatusRowSchema,
      [dealId],
      { label: "Load latest module results (counts only)" }
    );

    const modules = rows.map((row: z.infer<typeof ModuleStatusRowSchema>) => {
      return {
        moduleId: row.module_id,
        latestRun: {
          id: row.run_id,
          status: row.status,
          triggeredAt: row.triggered_at,
          completedAt: row.completed_at,
        },
        latestOutput: row.has_output
          ? {
              executiveHeader: row.executive_header,
              findingsCount: row.findings_count,
              criticalCount: row.critical_count,
              warningCount: row.warning_count,
              infoCount: row.info_count,
              criticalAssessedCount: row.critical_assessed_count,
              createdAt: row.output_created_at ?? row.completed_at ?? row.triggered_at,
            }
          : null,
      };
    });

    return { modules };
  },
});
