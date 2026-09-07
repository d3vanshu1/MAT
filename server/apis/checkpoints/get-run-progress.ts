import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RunRowSchema = z.object({
  id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string(),
  completed_at: z.string().nullable(),
  documents_included: z.any(),
});

const CountSchema = z.object({ cnt: z.coerce.number() });

const ExtractionCountSchema = z.object({
  total: z.coerce.number(),
});

const ErrorCheckpointSchema = z.object({
  error_text: z.string().nullable(),
});

export default api({
  name: "GetRunProgress",
  description: "Returns per-module run progress with extraction/merge counts and checkpoint errors",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractionCount: z.number(),
    dcsEvidenceCount: z.number(),
    runs: z.array(
      z.object({
        runId: z.string(),
        moduleId: z.string(),
        status: z.string(),
        triggeredAt: z.string(),
        completedAt: z.string().nullable(),
        documentsIncluded: z.array(z.string()),
        analysisCheckpointCount: z.number(),
        mergeCheckpointCount: z.number(),
        // Stage checkpoints (pipeline_checkpoints). Reported SEPARATELY and never
        // folded into the two counts above — those retain their exact prior
        // meaning for the four merge-tree modules.
        //
        // This is the only progress signal the CC reconciliation path emits:
        // analysis and merge checkpoints are structurally zero there because both
        // phases are skipped by design.
        stageCheckpointCount: z.number(),
        // MAST-specific: completed stages from mast_pipeline_state (0 for non-MAST)
        mastStagesComplete: z.number(),
        // OA v2 stage progress
        oaV2StagesComplete: z.number(),
        oaV2CurrentStage: z.string().nullable(),
        // CC v2 stage progress
        ccV2StagesComplete: z.number(),
        ccV2CurrentStage: z.string().nullable(),
        // Errors surfaced from checkpoint JSONB (if any)
        checkpointErrors: z.array(z.string()),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    // Count legacy universal extractions for this deal
    const extRows = await ctx.integrations.db.query(
      `SELECT COUNT(*) AS total FROM universal_extractions WHERE deal_id = $1`,
      ExtractionCountSchema,
      [dealId],
      { label: "Count legacy extractions" }
    );
    const extractionCount = extRows[0]?.total ?? 0;

    // Count DCS evidence rows (the new pipeline) — join through module_runs
    const dcsRows = await ctx.integrations.db.query(
      `SELECT COUNT(*) AS total
       FROM dcs_evidence de
       JOIN module_runs mr ON mr.id = de.run_id
       WHERE mr.deal_id = $1 AND mr.module_id = 'diligence_completeness'`,
      ExtractionCountSchema,
      [dealId],
      { label: "Count DCS evidence" }
    );
    const dcsEvidenceCount = dcsRows[0]?.total ?? 0;

    // Get in-progress / recent runs (only existing enum values)
    const runs = await ctx.integrations.db.query(
      `SELECT id, module_id, status, triggered_at, completed_at, documents_included
       FROM module_runs
       WHERE deal_id = $1
         AND status IN ('running', 'pending', 'failed')
       ORDER BY triggered_at DESC
       LIMIT 50`,
      RunRowSchema,
      [dealId],
      { label: "Get active/recent runs" }
    );

    // For each run, count analysis + merge checkpoints + surface errors from JSONB
    const result = [];
    for (const run of runs) {
      // Count analysis checkpoints for this run
      const analysisRows = await ctx.integrations.db.query(
        `SELECT COUNT(*) AS cnt FROM pipeline_analysis WHERE run_id = $1`,
        CountSchema,
        [run.id],
        { label: `Count analysis checkpoints for ${run.module_id}` }
      );

      const ckptRows = await ctx.integrations.db.query(
        `SELECT COUNT(*) AS cnt FROM merge_checkpoints WHERE module_run_id = $1`,
        CountSchema,
        [run.id],
        { label: `Count merge checkpoints for ${run.module_id}` }
      );

      // Stage checkpoints — claims_ledger, reconciliation, gate, finalization.
      //
      // GUARDED DELIBERATELY: pipeline_checkpoints is created by migration 013,
      // but the pipeline's own writes to it are wrapped in try/catch with the
      // comment "table may not exist yet — non-fatal", so the codebase does not
      // assume the migration has run everywhere. An unguarded count here would
      // throw for EVERY run in the loop and take down progress reporting for all
      // five modules. Degrade to 0 instead: CC loses its new signal, no module
      // loses its existing one.
      //
      // Consequence for callers: a persistent 0 is INCONCLUSIVE, not proof that
      // the reconciliation path failed to checkpoint.
      let stageCheckpointCount = 0;
      try {
        const stageRows = await ctx.integrations.db.query(
          `SELECT COUNT(*) AS cnt FROM pipeline_checkpoints WHERE module_run_id = $1`,
          CountSchema,
          [run.id],
          { label: `Count stage checkpoints for ${run.module_id}` }
        );
        stageCheckpointCount = stageRows[0]?.cnt ?? 0;
      } catch {
        // Table absent or unreadable — leave at 0.
      }

      // MAST-specific: count completed stages from mast_pipeline_state
      let mastStagesComplete = 0;
      if (run.module_id === "model_assumptions_stress") {
        try {
          const mastRows = await ctx.integrations.db.query(
            `SELECT COUNT(*)::int AS cnt FROM mast_pipeline_state
             WHERE run_id = $1::uuid AND status = 'complete' AND stage != '_lock'`,
            CountSchema,
            [run.id],
            { label: "Count MAST completed stages" },
          );
          mastStagesComplete = mastRows[0]?.cnt ?? 0;
        } catch {
          // mast_pipeline_state may not exist — leave at 0
        }
      }

      // OA v2: count orchestrator-level stage checkpoints
      let oaV2StagesComplete = 0;
      let oaV2CurrentStage: string | null = null;
      if (run.module_id === "omission_audit") {
        try {
          const oaStageOrder = ["fact_normalization", "topic_assignment", "index_assembly", "absence_probe", "gap_comparison", "materiality", "finding_assembly", "render", "publish"];
          const oaRows = await ctx.integrations.db.query(
            "SELECT unit_key FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'orchestrator' AND status = 'complete'",
            z.object({ unit_key: z.string() }),
            [run.id],
            { label: "OA v2: count orchestrator stages" },
          );
          const completedSet = new Set(oaRows.map((r: { unit_key: string }) => r.unit_key));
          oaV2StagesComplete = completedSet.size;
          for (const stage of oaStageOrder) {
            if (!completedSet.has(stage)) {
              oaV2CurrentStage = stage;
              break;
            }
          }
          if (!oaV2CurrentStage && oaV2StagesComplete > 0) oaV2CurrentStage = "publish";
        } catch { /* table may not exist */ }
      }

      // CC v2: count completed pipeline checkpoint stages
      let ccV2StagesComplete = 0;
      let ccV2CurrentStage: string | null = null;
      if (run.module_id === "contradiction_check") {
        try {
          const ccStageOrder = ["claims_ledger", "figure_extraction", "reconciliation", "canonical_finalize_done"];
          const ccStageLabels = ["claims_extraction", "figure_extraction", "reconciliation", "finalization"];
          const ccRows = await ctx.integrations.db.query(
            "SELECT checkpoint_key, status FROM pipeline_checkpoints WHERE module_run_id = $1 AND checkpoint_key IN ('claims_ledger', 'figure_extraction', 'reconciliation', 'canonical_finalize_done') AND status = 'complete'",
            z.object({ checkpoint_key: z.string(), status: z.string() }),
            [run.id],
            { label: "CC v2: count stage checkpoints" },
          );
          const ccCompleted = new Set(ccRows.map((r: { checkpoint_key: string }) => r.checkpoint_key));
          ccV2StagesComplete = ccCompleted.size;
          for (let si = 0; si < ccStageOrder.length; si++) {
            if (!ccCompleted.has(ccStageOrder[si])) {
              ccV2CurrentStage = ccStageLabels[si];
              break;
            }
          }
          if (!ccV2CurrentStage && ccV2StagesComplete > 0) ccV2CurrentStage = "finalization";
        } catch { /* table may not exist */ }
      }

      // Surface errors from merge checkpoint JSONB
      const errorRows = await ctx.integrations.db.query(
        `SELECT merged_json->>'error' AS error_text
         FROM merge_checkpoints
         WHERE module_run_id = $1
           AND merged_json ? 'error'
         LIMIT 10`,
        ErrorCheckpointSchema,
        [run.id],
        { label: `Get checkpoint errors for ${run.module_id}` }
      );

      const docsIncluded = Array.isArray(run.documents_included)
        ? run.documents_included.map(String)
        : [];

      result.push({
        runId: run.id,
        moduleId: run.module_id,
        status: run.status,
        triggeredAt: run.triggered_at,
        completedAt: run.completed_at,
        documentsIncluded: docsIncluded,
        analysisCheckpointCount: analysisRows[0]?.cnt ?? 0,
        mergeCheckpointCount: ckptRows[0]?.cnt ?? 0,
        stageCheckpointCount,
        mastStagesComplete,
        oaV2StagesComplete,
        oaV2CurrentStage,
        ccV2StagesComplete,
        ccV2CurrentStage,
        checkpointErrors: errorRows
          .map((r) => r.error_text)
          .filter((e): e is string => e !== null),
      });
    }

    return { extractionCount, dcsEvidenceCount, runs: result };
  },
});
