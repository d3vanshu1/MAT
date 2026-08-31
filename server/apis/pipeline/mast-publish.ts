/**
 * mast-publish.ts
 *
 * Publishes a completed MAST v2 run to module_runs + module_outputs so the
 * dashboard renders it. Follows the same pattern as PublishEroToModuleOutputs.
 *
 * Idempotent for a run: publishing the same run twice replaces rather than
 * duplicates.
 *
 * No LLM. No web requests. Pure row reads and writes.
 *
 * MAST owns this file. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const MAST_MODULE_ID = "model_assumptions_stress";
const LOG_PREFIX = "[MAST-PUBLISH]";

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const RenderPayloadRow = z.object({
  payload: z.any().nullable(),
});

const OutputIdRow = z.object({
  id: z.string(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastPublish",
  description: "Publishes a MAST v2 run to module_outputs for the dashboard",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
  }),

  output: z.object({
    moduleRunId: z.string(),
    outputId: z.string(),
    reportLength: z.number(),
  }),

  async run(ctx, { runId, dealId }) {
    const db = ctx.integrations.db;

    // ── 1. Read the render stage payload ─────────────────────────────
    const rows = await db.query(
      `SELECT payload
       FROM mast_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'render'
       LIMIT 1`,
      RenderPayloadRow,
      [runId],
      { label: "MAST-PUBLISH: read render payload" },
    );

    if (rows.length === 0 || !rows[0].payload) {
      throw new Error(
        `${LOG_PREFIX} No render payload found for run ${runId}, stage render. ` +
        `Cannot publish without a rendered report.`,
      );
    }

    const payload = rows[0].payload as {
      report?: string;
      sectionCounts?: {
        totalFindings?: number;
        critical?: number;
        nothingCount?: number;
      };
    };

    const report = payload.report;
    if (!report || typeof report !== "string" || report.trim().length === 0) {
      throw new Error(
        `${LOG_PREFIX} Render payload for run ${runId} has no report or report is empty. ` +
        `Cannot publish a placeholder.`,
      );
    }

    const counts = payload.sectionCounts ?? {};
    const totalFindings = counts.totalFindings ?? 0;
    const criticalCount = counts.critical ?? 0;
    const nothingCount = counts.nothingCount ?? 0;

    console.log(
      `${LOG_PREFIX} Publishing run ${runId}. Report: ${report.length} chars, ` +
      `${totalFindings} findings, ${criticalCount} critical, ${nothingCount} unsupported.`,
    );

    // ── 2. Assemble header in code ──────────────────────────────────
    const headerParts: string[] = [
      `Model Assumptions Stress Test: ${totalFindings} assumptions assessed`,
    ];
    if (criticalCount > 0) {
      headerParts.push(`${criticalCount} critical finding${criticalCount === 1 ? "" : "s"}`);
    }
    if (nothingCount > 0) {
      headerParts.push(`${nothingCount} with no support located`);
    }
    const executiveHeader = headerParts.join(", ") + ".";

    // ── 3. Upsert module_runs ───────────────────────────────────────
    await db.execute(
      `INSERT INTO module_runs
         (id, deal_id, module_id, status, triggered_at, completed_at, documents_included)
       VALUES ($1::uuid, $2::uuid, $3, 'completed', NOW(), NOW(), '{}')
       ON CONFLICT (id) DO UPDATE
         SET status = 'completed', completed_at = NOW()`,
      [runId, dealId, MAST_MODULE_ID],
      { label: "MAST-PUBLISH: upsert module_runs" },
    );

    // ── 4. DELETE then INSERT module_outputs ─────────────────────────
    await db.execute(
      `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
      [runId],
      { label: "MAST-PUBLISH: clear existing module_output" },
    );

    // findings column: empty JSON array — MAST findings live in mast_findings,
    // but module_outputs.findings is NOT NULL with a default of '[]'::jsonb
    const findingsJson = JSON.stringify([]);

    const insertResult = await db.query(
      `INSERT INTO module_outputs
         (module_run_id, executive_header, findings, full_report_markdown)
       VALUES ($1::uuid, $2, $3::jsonb, $4)
       RETURNING id`,
      OutputIdRow,
      [runId, executiveHeader, findingsJson, report],
      { label: "MAST-PUBLISH: insert module_outputs row" },
    );

    const outputId = insertResult[0]?.id ?? "unknown";

    // ── 5. Bump deals.updated_at ────────────────────────────────────
    await db.execute(
      `UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid`,
      [dealId],
      { label: "MAST-PUBLISH: bump deal updated_at" },
    );

    console.log(
      `${LOG_PREFIX} Published. module_run_id=${runId}, output_id=${outputId}, ` +
      `header="${executiveHeader}"`,
    );

    return {
      moduleRunId: runId,
      outputId,
      reportLength: report.length,
    };
  },
});
