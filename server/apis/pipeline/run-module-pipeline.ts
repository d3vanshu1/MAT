import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore, type PipelineResult } from "./pipeline-core.js";
import { OA_V2_ENABLED } from "./pipeline-config.js";
import { runOaPipeline } from "./oa-orchestrator.js";

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// API — Thin wrapper around the shared pipeline core.
//
// This is the API the client poll loop calls. It:
//   1. Creates or resumes a run (via runId)
//   2. Processes as many chunks/merges as fit in the time budget
//   3. Returns in_progress (so the client can re-invoke) or completed
//
// The actual logic lives in pipeline-core.ts so that the background
// safety-net API (ResumeStalePipelines) calls the identical code path.
// ---------------------------------------------------------------------------
export default api({
  name: "RunModulePipeline",
  description: "Server-side module pipeline: analysis → merge → report, with checkpointing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string(),
    runId: z.string().nullable().optional(),
    useOpus: z.boolean().nullable().optional(),
    /** IDs of the memo(s) under review. Required for modules that need subject exclusion. */
    subjectDocumentIds: z.array(z.string()).nullable().optional(),
    // Numeric report (pre-computed by client before kicking off pipeline)
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    // True when NumericVerify hit its time budget and only processed a subset of tables
    numericPartial: z.boolean().nullable().optional(),
    // When true, the resulting module_run is hidden from dashboards and resume logic
    diagnosticOnly: z.boolean().nullable().optional(),
    // B2 FIX — claim token for ownership continuity across resumes
    ownerToken: z.string().nullable().optional(),
  }),

  output: z.object({
    status: z.enum(["completed", "in_progress", "failed", "cancelled"]),
    runId: z.string(),
    phase: z.string(),
    progress: z.object({
      analysisTotal: z.number(),
      analysisCompleted: z.number(),
      mergeRound: z.number(),
      mergeTotal: z.number(),
      mergeGroupsDone: z.number().optional(),
      mergeGroupsTotal: z.number().optional(),
    }),
    // Only populated when status === "completed"
    result: z.object({
      executiveHeader: z.string(),
      findings: z.array(z.any()),
      mergedText: z.string(),
      fullReport: z.string().nullable().optional(),
    }).nullable(),
    // Failure & quality diagnostics
    failedChunks: z.number().optional(),
    truncatedChunks: z.number().optional(),
    truncatedMerges: z.number().optional(),
    firstError: z.string().nullable().optional(),
    // Per-invocation extraction observability
    extractionPassStats: z.object({
      attemptedThisPass: z.number(),
      succeededThisPass: z.number(),
      failedThisPass: z.number(),
      skippedDueToBudget: z.number(),
    }).optional(),
    // B2 FIX — owner token for the caller to pass back on resume
    ownerToken: z.string().nullable().optional(),
  }),

  async run(ctx, input): Promise<PipelineResult> {
    // ── OA v2: extraction only through v1, then skip merge → v2 orchestrator ──
    if (input.moduleId === "omission_audit" && OA_V2_ENABLED) {
      var db = ctx.integrations.db;
      var runId = input.runId || "";

      // Check if extraction is already complete for this deal.
      // universal_extractions > 0 means chunks have been extracted.
      // Skip pipeline-core entirely to avoid the expensive merge phase.
      var extractionRows = await db.query(
        "SELECT count(*)::int AS cnt FROM universal_extractions WHERE deal_id = $1",
        z.object({ cnt: z.coerce.number() }),
        [input.dealId],
        { label: "OA v2: check extraction completion" },
      );
      var extractionDone = extractionRows[0]?.cnt > 0;

      if (!extractionDone) {
        // Extraction not started/incomplete — run through v1 pipeline-core
        // for chunk analysis only. On the next invocation after extraction
        // finishes, we'll skip pipeline-core and go to v2 orchestrator.
        var v1Result = await runPipelineCore(ctx, {
          dealId: input.dealId,
          moduleId: input.moduleId,
          runId: runId || undefined,
          useOpus: input.useOpus,
          subjectDocumentIds: input.subjectDocumentIds,
          numericReport: input.numericReport,
          numericPartial: input.numericPartial,
          diagnosticOnly: input.diagnosticOnly,
          ownerToken: input.ownerToken,
        });
        // Capture the runId created by pipeline-core
        runId = v1Result.runId || runId;
        // Always return — let the client re-invoke. On next call,
        // extraction will be done and we'll skip to v2.
        return v1Result;
      }

      // If no runId provided, find the active run for this deal
      if (!runId) {
        var activeRuns = await db.query(
          "SELECT id FROM module_runs WHERE deal_id = $1 AND module_id = 'omission_audit' AND status IN ('running', 'failed') ORDER BY triggered_at DESC LIMIT 1",
          z.object({ id: z.string() }),
          [input.dealId],
          { label: "OA v2: find active run" },
        );
        if (activeRuns.length > 0) {
          runId = activeRuns[0].id;
        }
      }

      // Extraction complete — skip merge, go straight to v2 orchestrator
      var oaResult = await runOaPipeline(
        ctx as any,
        input.dealId,
        runId,
        input.subjectDocumentIds || [],
      );
      // Map OaPipelineResult → PipelineResult (cast through unknown)
      return {
        status: oaResult.status === "complete" ? "completed" : oaResult.status,
        runId: oaResult.runId || runId,
        moduleId: input.moduleId,
        dealId: input.dealId,
        message: oaResult.message,
        phase: oaResult.currentStage,
        progress: {
          stagesComplete: oaResult.stagesComplete,
          stagesFailed: oaResult.stagesFailed,
          currentStage: oaResult.currentStage,
        },
        result: null,
      } as unknown as PipelineResult;
    }

    return runPipelineCore(ctx, {
      dealId: input.dealId,
      moduleId: input.moduleId,
      runId: input.runId,
      useOpus: input.useOpus,
      subjectDocumentIds: input.subjectDocumentIds,
      numericReport: input.numericReport,
      numericPartial: input.numericPartial,
      diagnosticOnly: input.diagnosticOnly,
      ownerToken: input.ownerToken,
    });
  },
});
