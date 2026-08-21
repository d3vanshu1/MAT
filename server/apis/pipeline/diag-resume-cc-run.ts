import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore } from "./pipeline-core.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

/**
 * Diagnostic API: directly resumes the CC diagnostic run through runPipelineCore.
 * Used when RunModulePipeline has a stale integration connection issue.
 *
 * When `resetCheckpoints` is provided, those checkpoint keys are deleted BEFORE
 * running — forcing the pipeline to re-execute those stages from scratch.
 * Use case: re-running reconciliation with P2.1 evidence wiring after code changes.
 */
export default api({
  name: "DiagResumeCcRun",
  description: "Directly resumes the CC diagnostic run bc6b519f via runPipelineCore",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    /** Optional: checkpoint keys to delete before running (forces re-execution of those stages) */
    resetCheckpoints: z.array(z.string()).default([]),
  }),

  output: z.object({
    status: z.string(),
    phase: z.string(),
    runId: z.string(),
    progress: z.any(),
    result: z.any().nullable(),
    firstError: z.string().nullable().optional(),
    resetted: z.array(z.string()).optional(),
  }),

  async run(ctx, { runId, dealId, resetCheckpoints }) {
    // Optionally delete specific checkpoints to force re-execution
    const resetted: string[] = [];
    if (resetCheckpoints.length > 0) {
      // Reset run status to 'running' so pipeline-core doesn't short-circuit
      // on the "already completed" early-exit check (L2223 in pipeline-core.ts)
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET status = 'running'::module_status, triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Reset run status to running for re-execution" }
      );
      console.log(`[DiagResumeCcRun] Reset run status to 'running'`);

      for (const key of resetCheckpoints) {
        try {
          await ctx.integrations.db.execute(
            `DELETE FROM pipeline_checkpoints WHERE module_run_id = $1 AND checkpoint_key = $2`,
            [runId, key],
            { label: `Reset checkpoint: ${key}` }
          );
          resetted.push(key);
          console.log(`[DiagResumeCcRun] Reset checkpoint: ${key}`);
        } catch (err) {
          console.warn(`[DiagResumeCcRun] Failed to reset ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const result = await runPipelineCore(ctx, {
      dealId,
      moduleId: "contradiction_check",
      runId,
      useOpus: false,
      subjectDocumentIds: ["3bdc4854-71e5-4c7b-8b3a-f68da47a7649"],
      numericReport: null,
      numericPartial: null,
      diagnosticOnly: true,
    });

    return {
      status: result.status,
      phase: result.phase,
      runId: result.runId,
      progress: result.progress,
      result: result.result ?? null,
      firstError: result.firstError ?? null,
      resetted: resetted.length > 0 ? resetted : undefined,
    };
  },
});
