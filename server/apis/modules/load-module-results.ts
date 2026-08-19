import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";
import { strictReloadFindings } from "./strict-reload-findings.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ModuleStatusRowSchema = z.object({
  module_id: z.string(),
  run_id: z.string(),
  status: z.string(),
  is_cancelled: z.boolean(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  executive_header: z.string().nullable(),
  findings: z.any(), // JSONB — validated via canonical parser below
  full_report_markdown: z.string().nullable(),
  output_created_at: z.string().nullable(),
});

const BASE_QUERY = `SELECT DISTINCT ON (mr.module_id)
  mr.module_id,
  mr.id AS run_id,
  mr.status,
  {{IS_CANCELLED_EXPR}}
  mr.triggered_at,
  mr.completed_at,
  mo.executive_header,
  mo.findings,
  mo.full_report_markdown,
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
  description: "Loads the latest module run + output for each module of a deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  // RC1: output uses CanonicalFindingSchema — all fields preserved
  output: z.object({
    modules: z.array(
      z.object({
        moduleId: z.string(),
        latestRun: z.object({
          id: z.string(),
          status: z.string(),
          isCancelled: z.boolean(),
          triggeredAt: z.string(),
          completedAt: z.string().nullable(),
        }),
        latestOutput: z
          .object({
            executiveHeader: z.string().nullable(),
            findings: z.array(CanonicalFindingSchema),
            fullReport: z.string(),
            createdAt: z.string(),
          })
          .nullable(),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    // Try with is_cancelled column (post-migration-009)
    let rows: Array<z.infer<typeof ModuleStatusRowSchema>>;

    try {
      rows = await ctx.integrations.db.query(
        BASE_QUERY.replace("{{IS_CANCELLED_EXPR}}", "COALESCE(mr.is_cancelled, FALSE) AS is_cancelled,"),
        ModuleStatusRowSchema,
        [dealId],
        { label: "Load latest module results (with is_cancelled)" }
      );
    } catch {
      // Pre-migration fallback: column doesn't exist
      const legacyRows = await ctx.integrations.db.query(
        BASE_QUERY.replace("{{IS_CANCELLED_EXPR}}", "FALSE AS is_cancelled,"),
        ModuleStatusRowSchema,
        [dealId],
        { label: "Load latest module results (pre-migration)" }
      );
      rows = legacyRows;
    }

    const modules = rows.map((row) => {
      // RC1 + Fix 3: strict reload — fail closed on any corruption
      let findings: Array<z.infer<typeof CanonicalFindingSchema>> = [];
      let outputCorrupt = false;
      try {
        if (row.findings) {
          findings = strictReloadFindings(
            row.findings,
            `LoadModuleResults module_id=${row.module_id} run_id=${row.run_id}`
          ).findings;
        }
      } catch (err) {
        console.error(`[LoadModuleResults] Fail-closed:`, err instanceof Error ? err.message : err);
        const d = (err as { detail?: { invalid?: Array<{ title: string; issues: string }>; malformed_count?: number } })?.detail;
        if (d) {
          console.error(
            `[LoadModuleResults] Module dropped from results — module_id=${row.module_id} run_id=${row.run_id} malformed=${d.malformed_count ?? 0}`,
            (d.invalid ?? []).slice(0, 10)
          );
        }
        outputCorrupt = true;
      }

      return {
        moduleId: row.module_id,
        latestRun: {
          id: row.run_id,
          status: row.status,
          isCancelled: row.is_cancelled,
          triggeredAt: row.triggered_at,
          completedAt: row.completed_at,
        },
        latestOutput:
          outputCorrupt
            ? null // fail closed — do not serve corrupt findings
            : row.full_report_markdown != null
              ? {
                  executiveHeader: row.executive_header,
                  findings,
                  fullReport: row.full_report_markdown,
                  createdAt: row.output_created_at ?? row.completed_at ?? row.triggered_at,
                }
              : null,
      };
    });

    return { modules };
  },
});
