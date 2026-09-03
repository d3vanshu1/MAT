/**
 * mast-reset-stage.ts
 *
 * Resets a single MAST pipeline stage for a run so it can be re-run
 * without re-running every preceding stage.
 *
 * Deletes the mast_pipeline_state row for the specified stage only,
 * clears that stage's outputs (scoped to the run), and sets
 * module_runs.status to 'running' so the orchestrator re-enters.
 *
 * Does NOT touch documents, document_chunks, doc_tables, the _lock row,
 * or any table not explicitly listed in the per-stage branches below.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { STAGES } from "./mast-contract.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const LOG_PREFIX = "[MAST-RESET-STAGE]";

const CountRow = z.object({ cnt: z.coerce.number() });
const StatusRow = z.object({ status: z.string() });

export default api({
  name: "MastResetStage",
  description: "Resets one MAST stage for a run so it can be re-executed",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    stage: z.string(),
    confirm: z.boolean(),
  }),

  output: z.object({
    success: z.boolean(),
    stage: z.string(),
    pipelineStateDeleted: z.number(),
    outputAction: z.string(),
    beforeCounts: z.record(z.string(), z.number()),
    affectedCounts: z.record(z.string(), z.number()),
    priorModuleRunStatus: z.string(),
  }),

  async run(ctx, { runId, stage, confirm }) {
    if (!confirm) {
      throw new Error("confirm must be true to proceed.");
    }

    const db = ctx.integrations.ic_diligence_db;

    // ── Validate stage against STAGES ───────────────────────────────
    const validStages = STAGES as readonly string[];
    if (!validStages.includes(stage)) {
      throw new Error(
        `${LOG_PREFIX} Invalid stage "${stage}". Valid stages: ${validStages.join(", ")}`,
      );
    }

    // ── 1. Count and delete mast_pipeline_state row for this stage ──
    const [{ cnt: psBefore }] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM mast_pipeline_state
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      CountRow,
      [runId, stage],
      { label: `${LOG_PREFIX} count pipeline_state` },
    );

    await db.execute(
      `DELETE FROM mast_pipeline_state
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, stage],
      { label: `${LOG_PREFIX} delete pipeline_state for ${stage}` },
    );

    console.log(`${LOG_PREFIX} Deleted ${psBefore} mast_pipeline_state row(s) for stage=${stage}.`);

    // ── 2. Clear stage outputs ──────────────────────────────────────
    const beforeCounts: Record<string, number> = {};
    const affectedCounts: Record<string, number> = {};
    let outputAction = "none";

    if (stage === "extract") {
      // Delete memo_prose assumptions
      outputAction = "delete mast_assumptions where origin_type='memo_prose'";

      const [{ cnt: before }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_assumptions
         WHERE run_id = $1::uuid AND origin_type = 'memo_prose'`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count extract assumptions` },
      );
      beforeCounts["mast_assumptions(memo_prose)"] = before;

      await db.execute(
        `DELETE FROM mast_assumptions
         WHERE run_id = $1::uuid AND origin_type = 'memo_prose'`,
        [runId],
        { label: `${LOG_PREFIX} delete extract assumptions` },
      );
      affectedCounts["mast_assumptions(memo_prose)"] = before;

    } else if (stage === "sweep") {
      // Delete support evidence
      outputAction = "delete mast_support_evidence + mast_assumptions(forecast_recursed)";

      const [{ cnt: evBefore }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_support_evidence
         WHERE run_id = $1::uuid`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count sweep evidence` },
      );
      beforeCounts["mast_support_evidence"] = evBefore;

      await db.execute(
        `DELETE FROM mast_support_evidence WHERE run_id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} delete sweep evidence` },
      );
      affectedCounts["mast_support_evidence"] = evBefore;

      // Delete forecast_recursed assumptions
      const [{ cnt: frBefore }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_assumptions
         WHERE run_id = $1::uuid AND origin_type = 'forecast_recursed'`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count forecast_recursed` },
      );
      beforeCounts["mast_assumptions(forecast_recursed)"] = frBefore;

      await db.execute(
        `DELETE FROM mast_assumptions
         WHERE run_id = $1::uuid AND origin_type = 'forecast_recursed'`,
        [runId],
        { label: `${LOG_PREFIX} delete forecast_recursed` },
      );
      affectedCounts["mast_assumptions(forecast_recursed)"] = frBefore;

    } else if (stage === "label") {
      // Null out label columns + dependence columns
      outputAction = "update mast_assumptions: null label/dependence columns";

      const [{ cnt: before }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_assumptions
         WHERE run_id = $1::uuid AND (assumption_label IS NOT NULL OR dependence_tier IS NOT NULL)`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count labelled assumptions` },
      );
      beforeCounts["mast_assumptions(labelled)"] = before;

      await db.execute(
        `UPDATE mast_assumptions
         SET assumption_label = NULL,
             label_reason = NULL,
             dependence_tier = NULL,
             dependence_basis = NULL
         WHERE run_id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} null label columns` },
      );
      affectedCounts["mast_assumptions(updated)"] = before;

    } else if (stage === "severity") {
      // Delete findings
      outputAction = "delete mast_findings";

      const [{ cnt: before }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_findings
         WHERE run_id = $1::uuid`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count findings` },
      );
      beforeCounts["mast_findings"] = before;

      await db.execute(
        `DELETE FROM mast_findings WHERE run_id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} delete findings` },
      );
      affectedCounts["mast_findings"] = before;

    } else if (stage === "fragility") {
      // Update findings: null fragility columns
      outputAction = "update mast_findings: null fragility columns";

      const [{ cnt: before }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_findings
         WHERE run_id = $1::uuid AND fragility_generated = true`,
        CountRow,
        [runId],
        { label: `${LOG_PREFIX} count fragility-generated findings` },
      );
      beforeCounts["mast_findings(fragility_generated)"] = before;

      await db.execute(
        `UPDATE mast_findings
         SET falsification_condition = NULL,
             monitoring_trigger = NULL,
             fragility_generated = false
         WHERE run_id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} null fragility columns` },
      );
      affectedCounts["mast_findings(updated)"] = before;

    } else if (stage === "synthesize" || stage === "render" || stage === "lineage") {
      outputAction = "pipeline_state deletion only (no output table)";
    }

    console.log(
      `${LOG_PREFIX} Stage ${stage}: outputAction=${outputAction}, ` +
      `before=${JSON.stringify(beforeCounts)}, affected=${JSON.stringify(affectedCounts)}.`,
    );

    // ── 3. Set module_runs.status to 'running' ──────────────────────
    const statusRows = await db.query(
      `SELECT status::text AS status FROM module_runs WHERE id = $1::uuid LIMIT 1`,
      StatusRow,
      [runId],
      { label: `${LOG_PREFIX} read module_runs status` },
    );

    const priorStatus = statusRows.length > 0 ? statusRows[0].status : "not_found";

    if (statusRows.length > 0) {
      await db.execute(
        `UPDATE module_runs SET status = 'running' WHERE id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} set module_runs status to running` },
      );
      console.log(`${LOG_PREFIX} module_runs.status: ${priorStatus} → running.`);
    } else {
      console.log(`${LOG_PREFIX} WARNING: No module_runs row found for run ${runId}.`);
    }

    return {
      success: true,
      stage,
      pipelineStateDeleted: psBefore,
      outputAction,
      beforeCounts,
      affectedCounts,
      priorModuleRunStatus: priorStatus,
    };
  },
});
