import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore, type PipelineResult } from "./pipeline-core.js";
import { OA_V2_ENABLED, CC_V2_ENABLED } from "./pipeline-config.js";
import { runOaPipeline } from "./oa-orchestrator.js";
import { runCcPipeline } from "./cc-orchestrator.js";

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
    // ── OA v2 — no v1 extraction prerequisite ────────────────────
    // OA v2 orchestrator handles all 9 stages directly.
    // Extraction (universal_extractions) must already exist for the deal.
    if (input.moduleId === "omission_audit" && OA_V2_ENABLED) {
      var db = ctx.integrations.db;

      // Resolve runId: use provided, find in-progress, or create fresh row
      var runId = input.runId || "";
      if (!runId) {
        var activeRuns = await db.query(
          "SELECT id FROM module_runs WHERE deal_id = $1 AND module_id = 'omission_audit' AND status = 'running' ORDER BY triggered_at DESC LIMIT 1",
          z.object({ id: z.string() }),
          [input.dealId],
          { label: "OA v2: find active run" },
        );
        if (activeRuns.length > 0) {
          runId = activeRuns[0].id;
        } else {
          // No running run found — create a fresh module_runs row
          var newOaRunRows = await db.query(
            "INSERT INTO module_runs (id, deal_id, module_id, status, triggered_at) " +
            "VALUES (gen_random_uuid(), $1, 'omission_audit', 'running', now()) " +
            "RETURNING id",
            z.object({ id: z.string() }),
            [input.dealId],
            { label: "OA v2: create new module_run row" },
          );
          runId = newOaRunRows[0].id;
          console.log("[OA v2] Created new module_run: " + runId);
        }
      }

      var oaResult = await runOaPipeline(
        ctx as any,
        input.dealId,
        runId,
        input.subjectDocumentIds || [],
      );

      // Update module_runs status to match orchestrator result
      if (oaResult.status === "complete") {
        await db.execute(
          "UPDATE module_runs SET status = 'completed', completed_at = now() WHERE id = $1",
          [runId],
          { label: "OA v2: mark run completed" },
        );
      } else if (oaResult.status === "failed") {
        await db.execute(
          "UPDATE module_runs SET status = 'failed', completed_at = now() WHERE id = $1",
          [runId],
          { label: "OA v2: mark run failed" },
        );
      }

      // Map OaPipelineResult → PipelineResult with v2 phase prefix
      var totalStages = 9; // fact_norm through publish
      var doneStages = oaResult.stagesComplete.length;
      return {
        status: oaResult.status === "complete" ? "completed" : oaResult.status,
        runId: oaResult.runId || runId,
        moduleId: input.moduleId,
        dealId: input.dealId,
        message: oaResult.message,
        phase: "oa_v2_" + oaResult.currentStage,
        progress: {
          analysisTotal: totalStages,
          analysisCompleted: doneStages,
          mergeRound: 0,
          mergeTotal: 0,
        },
        result: null,
      } as unknown as PipelineResult;
    }

    // ── CC v2 path — no v1 extraction prerequisite ─────────────────
    // CC v2 orchestrator handles everything: claims extraction from IC memos,
    // figure extraction from Excel/DD reports, reconciliation, and finalization.
    // No dependency on universal_extractions or pipeline-core.
    if (input.moduleId === "contradiction_check" && CC_V2_ENABLED) {
      // Resolve runId: use provided, find in-progress, or create fresh row
      var ccRunId = input.runId || "";
      if (!ccRunId) {
        var ccActiveRuns = await ctx.integrations.db.query(
          "SELECT id FROM module_runs WHERE deal_id = $1 AND module_id = 'contradiction_check' AND status = 'running' ORDER BY triggered_at DESC LIMIT 1",
          z.object({ id: z.string() }),
          [input.dealId],
          { label: "CC v2: find active run" },
        );
        if (ccActiveRuns.length > 0) {
          ccRunId = ccActiveRuns[0].id;
        } else {
          // No running run found — create a fresh module_runs row
          var newRunRows = await ctx.integrations.db.query(
            "INSERT INTO module_runs (id, deal_id, module_id, status, triggered_at) " +
            "VALUES (gen_random_uuid(), $1, 'contradiction_check', 'running', now()) " +
            "RETURNING id",
            z.object({ id: z.string() }),
            [input.dealId],
            { label: "CC v2: create new module_run row" },
          );
          ccRunId = newRunRows[0].id;
          console.log("[CC v2] Created new module_run: " + ccRunId);
        }
      }

      var ccResult = await runCcPipeline(
        ctx as any,
        input.dealId,
        ccRunId,
        input.subjectDocumentIds || [],
        input.numericReport || null,
      );

      // Update module_runs status to match orchestrator result
      if (ccResult.status === "complete") {
        await ctx.integrations.db.execute(
          "UPDATE module_runs SET status = 'completed', completed_at = now() WHERE id = $1",
          [ccRunId],
          { label: "CC v2: mark run completed" },
        );
      } else if (ccResult.status === "failed") {
        await ctx.integrations.db.execute(
          "UPDATE module_runs SET status = 'failed', completed_at = now() WHERE id = $1",
          [ccRunId],
          { label: "CC v2: mark run failed" },
        );
      }

      var ccTotalStages = 4;
      var ccDoneStages = ccResult.stagesComplete.length;
      return {
        status: ccResult.status === "complete" ? "completed" : ccResult.status,
        runId: ccResult.runId || ccRunId,
        moduleId: input.moduleId,
        dealId: input.dealId,
        message: ccResult.message,
        phase: "cc_v2_" + ccResult.currentStage,
        progress: {
          analysisTotal: ccTotalStages,
          analysisCompleted: ccDoneStages,
          mergeRound: 0,
          mergeTotal: 0,
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
