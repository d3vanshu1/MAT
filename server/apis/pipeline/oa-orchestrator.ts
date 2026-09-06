/**
 * oa-orchestrator.ts — OA v2 Pipeline Orchestrator
 *
 * Sequences the ten OA stages end-to-end within RunModulePipeline's budget.
 * Each invocation picks up from the first incomplete stage and runs as many
 * stages as the budget permits, yielding cleanly at stage boundaries.
 *
 * Stages:
 *   1. extraction        (v1 pipeline-core — NOT called from here)
 *   2. fact_normalization
 *   3. topic_assignment
 *   4. index_assembly
 *   5. absence_probe
 *   6. gap_comparison
 *   7. materiality
 *   8. finding_assembly
 *   9. render
 *  10. publish
 *
 * NOTE: Extraction (stage 1) is handled by the v1 pipeline-core before
 * the OA v2 path activates. The orchestrator enters at stage 2.
 *
 * Resume logic: each stage writes checkpoints. The orchestrator determines
 * completion from oa_stage_checkpoints alone. Stage-boundary records are
 * written to oa_stage_checkpoints with stage='orchestrator'.
 */

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";

// ── Budget constants ─────────────────────────────────────────────
const STAGE_SAFETY_MARGIN_MS = 60_000;   // do not START a stage inside this window
const TOTAL_BUDGET_MS = 450_000;         // conservative total — below platform kill

// ── Stage definitions ────────────────────────────────────────────
const OA_STAGES = [
  "fact_normalization",
  "topic_assignment",
  "index_assembly",
  "absence_probe",
  "gap_comparison",
  "materiality",
  "finding_assembly",
  "render",
  "publish",
] as const;

type OaStageName = typeof OA_STAGES[number];

// Stages that are hard dependencies for downstream stages.
// If a hard-dep fails, the pipeline halts.
const HARD_DEPS: Record<string, string[]> = {
  topic_assignment: ["fact_normalization"],
  index_assembly: ["topic_assignment"],
  absence_probe: ["index_assembly"],
  gap_comparison: ["absence_probe"],
  materiality: ["gap_comparison"],
  finding_assembly: ["materiality"],
  render: ["finding_assembly"],
  publish: ["render"],
};

// ── Completion test for each stage ───────────────────────────────
// Returns true if the stage is complete based on checkpoint data alone.
async function isStageComplete(db: any, runId: string, dealId: string, stage: OaStageName): Promise<boolean> {
  // First check if the orchestrator already recorded completion
  const orchCp = await db.query(
    "SELECT status FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'orchestrator' AND unit_key = $2 LIMIT 1",
    z.object({ status: z.string() }),
    [runId, stage],
    { label: "Orch: check boundary " + stage },
  );
  if (orchCp.length > 0 && (orchCp[0].status === "complete" || orchCp[0].status === "skipped")) {
    return true;
  }

  // Stage-specific completion tests
  switch (stage) {
    case "fact_normalization": {
      // Complete when every document for the deal has a checkpoint row
      const docCount = await db.query(
        "SELECT count(DISTINCT d.id)::int AS cnt FROM documents d WHERE d.deal_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [dealId],
        { label: "Orch: doc count for fact_norm" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'fact_normalization'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: fact_norm checkpoint count" },
      );
      return cpCount[0].cnt >= docCount[0].cnt && docCount[0].cnt > 0;
    }
    case "topic_assignment": {
      // Complete when the stage has at least one complete checkpoint
      // AND there are no facts without topic assignments
      const cpRows = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'topic_assignment' AND status = 'complete'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: topic_assignment cp count" },
      );
      if (cpRows[0].cnt === 0) return false;
      const unassigned = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_facts f WHERE f.deal_id = $1::uuid AND NOT EXISTS (SELECT 1 FROM oa_topic_facts tf WHERE tf.fact_id = f.fact_id)",
        z.object({ cnt: z.coerce.number() }),
        [dealId],
        { label: "Orch: unassigned facts" },
      );
      return unassigned[0].cnt === 0;
    }
    case "index_assembly": {
      const topicCount = await db.query(
        "SELECT count(DISTINCT topic_id)::int AS cnt FROM oa_topics WHERE run_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: topic count for index" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'index_assembly'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: index_assembly cp count" },
      );
      return cpCount[0].cnt >= topicCount[0].cnt && topicCount[0].cnt > 0;
    }
    case "absence_probe": {
      const topicCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_topics WHERE run_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: topic count for probe" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'absence_probe'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: absence_probe cp count" },
      );
      return cpCount[0].cnt >= topicCount[0].cnt && topicCount[0].cnt > 0;
    }
    case "gap_comparison": {
      const topicCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_topics WHERE run_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: topic count for gap" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'gap_comparison'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: gap_comparison cp count" },
      );
      return cpCount[0].cnt >= topicCount[0].cnt && topicCount[0].cnt > 0;
    }
    case "materiality": {
      const findingCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_findings WHERE run_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: finding count for materiality" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'materiality' AND status = 'complete'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: materiality cp count" },
      );
      return findingCount[0].cnt > 0 && cpCount[0].cnt >= findingCount[0].cnt;
    }
    case "finding_assembly": {
      const findingCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_findings WHERE run_id = $1::uuid",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: finding count for assembly" },
      );
      const cpCount = await db.query(
        "SELECT count(*)::int AS cnt FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'finding_assembly'",
        z.object({ cnt: z.coerce.number() }),
        [runId],
        { label: "Orch: finding_assembly cp count" },
      );
      return findingCount[0].cnt > 0 && cpCount[0].cnt >= findingCount[0].cnt;
    }
    case "render": {
      const cpRows = await db.query(
        "SELECT status FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'render' AND unit_key = 'report_markdown' LIMIT 1",
        z.object({ status: z.string() }),
        [runId],
        { label: "Orch: render cp check" },
      );
      return cpRows.length > 0 && cpRows[0].status === "complete";
    }
    case "publish": {
      const cpRows = await db.query(
        "SELECT status FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'orchestrator' AND unit_key = 'publish' LIMIT 1",
        z.object({ status: z.string() }),
        [runId],
        { label: "Orch: publish cp check" },
      );
      return cpRows.length > 0 && cpRows[0].status === "complete";
    }
    default:
      return false;
  }
}

// ── Stage dispatcher ─────────────────────────────────────────────
// Calls the stage handler and returns its status.
async function runStage(
  ctx: PipelineContext,
  db: any,
  dealId: string,
  runId: string,
  stage: OaStageName,
): Promise<{ status: "complete" | "in_progress" | "failed" | "skipped"; reason?: string }> {

  switch (stage) {
    case "fact_normalization": {
      const mod = await import("./oa-fact-normalization.js");
      const result = await mod.default.run(ctx as any, { dealId, dryRun: false, reset: false });
      // fact_normalization always runs to completion in one call (no budget guard)
      return { status: "complete" };
    }
    case "topic_assignment": {
      const mod = await import("./oa-topic-assignment.js");
      const result = await mod.default.run(ctx as any, { dealId, runId, reset: false });
      return { status: result.status as "complete" | "in_progress" };
    }
    case "index_assembly": {
      const mod = await import("./oa-index-assembly.js");
      await mod.default.run(ctx as any, { dealId, runId, reset: false });
      return { status: "complete" };
    }
    case "absence_probe": {
      const mod = await import("./oa-absence-probe.js");
      const result = await mod.default.run(ctx as any, { dealId, runId, reset: false });
      return { status: result.status as "complete" | "in_progress" };
    }
    case "gap_comparison": {
      const mod = await import("./oa-gap-comparison.js");
      const result = await mod.default.run(ctx as any, { dealId, runId, reset: false });
      return { status: result.status as "complete" | "in_progress" };
    }
    case "materiality": {
      const mod = await import("./oa-materiality.js");
      const result = await mod.default.run(ctx as any, { dealId, runId, reset: false });
      return { status: result.status as "complete" | "in_progress" };
    }
    case "finding_assembly": {
      const mod = await import("./oa-finding-assembly.js");
      const result = await mod.default.run(ctx as any, { dealId, runId, reset: false, retryFailed: false, dryRun: false });
      return { status: result.status as "complete" | "in_progress" };
    }
    case "render": {
      const mod = await import("./oa-render.js");
      await mod.default.run(ctx as any, { dealId, runId, sample: false, section: "full" });
      return { status: "complete" };
    }
    case "publish": {
      const mod = await import("./publish-oa-to-module-outputs.js");
      await mod.default.run(ctx as any, { dealId, runId });
      return { status: "complete" };
    }
    default:
      return { status: "skipped", reason: "unknown stage" };
  }
}

// ── Write stage boundary checkpoint ──────────────────────────────
async function writeOrchestratorCheckpoint(
  db: any,
  runId: string,
  stage: string,
  status: string,
  reason?: string,
): Promise<void> {
  await db.execute(
    "INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason, updated_at) " +
    "VALUES ($1::uuid, 'orchestrator', $2, $3, $4, now()) " +
    "ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = $3, reason = $4, updated_at = now()",
    [runId, stage, status, reason || null],
    { label: "Orch: write boundary " + stage + "=" + status },
  );
}

// ── Main orchestrator ────────────────────────────────────────────
export interface OaPipelineResult {
  status: "complete" | "in_progress" | "failed";
  runId: string;
  currentStage: string;
  stagesComplete: string[];
  stagesFailed: string[];
  message: string;
}

export async function runOaPipeline(
  ctx: PipelineContext,
  dealId: string,
  runId: string,
  subjectDocumentIds: string[],
): Promise<OaPipelineResult> {
  const db = ctx.integrations.db;
  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;
  const budgetRemaining = () => TOTAL_BUDGET_MS - elapsed();

  const stagesComplete: string[] = [];
  const stagesFailed: string[] = [];
  var currentStage: string = OA_STAGES[0];

  console.log("[OA-ORCH] Starting orchestrator for run " + runId + " deal " + dealId);

  // ── Determine entry point from checkpoint state ────────────────
  for (var si = 0; si < OA_STAGES.length; si++) {
    var stage = OA_STAGES[si];
    var complete = await isStageComplete(db, runId, dealId, stage);
    if (complete) {
      stagesComplete.push(stage);
      console.log("[OA-ORCH] Stage " + stage + " already complete — skipping");
    } else {
      currentStage = stage;
      break;
    }
    if (si === OA_STAGES.length - 1) {
      // All stages complete
      return {
        status: "complete",
        runId: runId,
        currentStage: stage,
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "All " + OA_STAGES.length + " stages complete.",
      };
    }
  }

  // ── Run stages sequentially ────────────────────────────────────
  for (var ri = OA_STAGES.indexOf(currentStage as OaStageName); ri < OA_STAGES.length; ri++) {
    var stageName = OA_STAGES[ri];
    currentStage = stageName;

    // Budget guard: do not START a stage if insufficient budget
    if (budgetRemaining() < STAGE_SAFETY_MARGIN_MS) {
      console.log("[OA-ORCH] Budget exhausted (" + budgetRemaining() + "ms remaining). Yielding before " + stageName);
      return {
        status: "in_progress",
        runId: runId,
        currentStage: stageName,
        stagesComplete: stagesComplete,
        stagesFailed: stagesFailed,
        message: "Budget exhausted at stage " + stageName + ". " + stagesComplete.length + " stages complete. Re-invoke to continue.",
      };
    }

    // Skip if already complete (e.g. after a partial run that completed some stages)
    var alreadyDone = await isStageComplete(db, runId, dealId, stageName);
    if (alreadyDone) {
      stagesComplete.push(stageName);
      continue;
    }

    // Check hard dependencies
    var deps = HARD_DEPS[stageName] || [];
    var depsFailed = false;
    for (var di = 0; di < deps.length; di++) {
      if (stagesFailed.indexOf(deps[di]) !== -1) {
        console.log("[OA-ORCH] Stage " + stageName + " skipped: hard dependency " + deps[di] + " failed");
        await writeOrchestratorCheckpoint(db, runId, stageName, "skipped", "hard dependency " + deps[di] + " failed");
        stagesFailed.push(stageName);
        depsFailed = true;
        break;
      }
    }
    if (depsFailed) continue;

    // Execute stage
    console.log("[OA-ORCH] Entering stage " + stageName + " (" + budgetRemaining() + "ms remaining)");
    try {
      var result = await runStage(ctx, db, dealId, runId, stageName);

      if (result.status === "complete") {
        await writeOrchestratorCheckpoint(db, runId, stageName, "complete");
        stagesComplete.push(stageName);
        console.log("[OA-ORCH] Stage " + stageName + " complete (" + elapsed() + "ms elapsed)");
      } else if (result.status === "in_progress") {
        // Stage yielded for budget — return in_progress, will resume on next invocation
        console.log("[OA-ORCH] Stage " + stageName + " yielded (in_progress). Returning.");
        return {
          status: "in_progress",
          runId: runId,
          currentStage: stageName,
          stagesComplete: stagesComplete,
          stagesFailed: stagesFailed,
          message: "Stage " + stageName + " in progress. " + stagesComplete.length + " stages complete. Re-invoke to continue.",
        };
      } else if (result.status === "skipped") {
        await writeOrchestratorCheckpoint(db, runId, stageName, "skipped", result.reason);
        stagesComplete.push(stageName);
        console.log("[OA-ORCH] Stage " + stageName + " skipped: " + (result.reason || ""));
      } else {
        // failed
        await writeOrchestratorCheckpoint(db, runId, stageName, "failed", result.reason);
        stagesFailed.push(stageName);
        console.log("[OA-ORCH] Stage " + stageName + " FAILED: " + (result.reason || ""));
      }
    } catch (err: unknown) {
      var errMsg = err instanceof Error ? err.message : String(err);
      await writeOrchestratorCheckpoint(db, runId, stageName, "failed", errMsg.slice(0, 500));
      stagesFailed.push(stageName);
      console.log("[OA-ORCH] Stage " + stageName + " THREW: " + errMsg.slice(0, 200));
      // Check if this is a hard dependency for remaining stages — if so, they'll be skipped in the loop
    }
  }

  // All stages processed
  var finalStatus: "complete" | "failed" = stagesFailed.length === 0 ? "complete" : "failed";
  return {
    status: finalStatus,
    runId: runId,
    currentStage: OA_STAGES[OA_STAGES.length - 1],
    stagesComplete: stagesComplete,
    stagesFailed: stagesFailed,
    message: stagesComplete.length + " stages complete, " + stagesFailed.length + " failed. Total elapsed: " + elapsed() + "ms.",
  };
}
