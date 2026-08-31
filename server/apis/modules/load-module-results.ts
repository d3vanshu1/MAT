import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";
import { strictReloadFindings } from "./strict-reload-findings.js";
import { isDcsV2Report, mapDcsV2ToCanonical } from "./dcs-v2-compat.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ModuleStatusRowSchema = z.object({
  module_id: z.string(),
  run_id: z.string(),
  status: z.string(),
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
    const rows = await ctx.integrations.db.query(
      BASE_QUERY,
      ModuleStatusRowSchema,
      [dealId],
      { label: "Load latest module results" }
    );

    const modules = rows.map((row) => {
      // RC1 + Fix 3: strict reload — fail closed on any corruption
      let findings: Array<z.infer<typeof CanonicalFindingSchema>> = [];
      let outputCorrupt = false;
      try {
        if (row.findings) {
          // DCS v2 bypass: detect report-envelope format and map to canonical
          const parsed = typeof row.findings === "string" ? JSON.parse(row.findings) : row.findings;
          if (isDcsV2Report(parsed)) {
            findings = mapDcsV2ToCanonical(parsed[0]);
          } else {
            findings = strictReloadFindings(
              row.findings,
              `LoadModuleResults module_id=${row.module_id} run_id=${row.run_id}`
            ).findings;
          }
        }
      } catch (err) {
        console.warn(`[LoadModuleResults] Fail-closed:`, err instanceof Error ? err.message : err);
        const d = (err as { detail?: { invalid?: Array<{ title: string; issues: string }>; malformed_count?: number } })?.detail;
        if (d) {
          console.warn(
            `[LoadModuleResults] Module dropped from results — module_id=${row.module_id} run_id=${row.run_id} malformed=${d.malformed_count ?? 0}`,
            JSON.stringify((d.invalid ?? []).slice(0, 10))
          );
        }
        outputCorrupt = true;
      }

      return {
        moduleId: row.module_id,
        latestRun: {
          id: row.run_id,
          status: row.status,

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
