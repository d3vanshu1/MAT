import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";
import { strictReloadFindings } from "./strict-reload-findings.js";
import { isDcsV2Report, mapDcsV2ToCanonical } from "./dcs-v2-compat.js";

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
  semantic_hash: z.string().nullable(),
  reportable_finding_ids: z.any(), // JSONB text[]
  schema_version: z.coerce.number().nullable(),
});

/** Legacy schema — used when semantic_hash/reportable_finding_ids/schema_version columns don't exist yet */
const RunOutputRowSchemaLegacy = z.object({
  run_id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  documents_included: z.any(),
  executive_header: z.string().nullable(),
  findings: z.any(),
  full_report_markdown: z.string().nullable(),
});

type OutputRow = z.infer<typeof RunOutputRowSchema>;
type LegacyRow = z.infer<typeof RunOutputRowSchemaLegacy>;

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
      semanticHash: z.string().nullable(),
      reportableFindingIds: z.array(z.string()).nullable(),
      schemaVersion: z.number().nullable(),
    }).nullable(),
  }),

  async run(ctx, { runId }) {
    // MAT-F06 §3: Try with identity columns first; fall back to legacy query
    // if schema migration hasn't been applied yet (columns don't exist).
    let rows: OutputRow[];
    try {
      rows = await ctx.integrations.db.query(
        `SELECT
          mr.id AS run_id,
          mr.module_id,
          mr.status,
          mr.triggered_at,
          mr.completed_at,
          mr.documents_included,
          mo.executive_header,
          mo.findings,
          mo.full_report_markdown,
          mo.semantic_hash,
          mo.reportable_finding_ids,
          mo.schema_version
        FROM module_runs mr
        LEFT JOIN module_outputs mo ON mo.module_run_id = mr.id
        WHERE mr.id = $1
        LIMIT 1`,
        RunOutputRowSchema,
        [runId],
        { label: "Get run output by ID" }
      );
    } catch {
      // Column does not exist (schema not yet migrated) or other DB error —
      // fall back without identity columns
      const legacyRows: LegacyRow[] = await ctx.integrations.db.query(
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
        RunOutputRowSchemaLegacy,
        [runId],
        { label: "Get run output by ID (legacy)" }
      );
      rows = legacyRows.map(r => ({
        ...r,
        semantic_hash: null,
        reportable_finding_ids: null,
        schema_version: null,
      }));
    }

    if (rows.length === 0) {
      return { run: null, output: null };
    }

    const row = rows[0];

    // RC1 + Fix 3: strict reload — fail closed on any corruption
    let findings: z.infer<typeof CanonicalFindingSchema>[];
    try {
      if (row.findings) {
        const parsed = typeof row.findings === "string" ? JSON.parse(row.findings) : row.findings;
        if (isDcsV2Report(parsed)) {
          findings = mapDcsV2ToCanonical(parsed[0]);
        } else {
          findings = strictReloadFindings(row.findings, `GetRunOutput run_id=${runId}`).findings;
        }
      } else {
        findings = [];
      }
    } catch (err) {
      console.warn(`[GetRunOutput] Fail-closed:`, err instanceof Error ? err.message : err);
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
            semanticHash: row.semantic_hash ?? null,
            reportableFindingIds: Array.isArray(row.reportable_finding_ids)
              ? row.reportable_finding_ids.map(String)
              : null,
            schemaVersion: row.schema_version ?? null,
          }
        : null,
    };
  },
});
