import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore } from "./pipeline-core.js";
import { STALENESS_THRESHOLD_MINUTES, RESUME_JOB_TIME_BUDGET_MS } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Background Pipeline Runner (Safety Net)
//
// Design:
//   - Intended to run on a 5-minute schedule (external cron or manual trigger)
//   - Finds module_runs in 'running' status where triggered_at > 6 minutes old
//     (meaning no client tab or previous invocation is actively driving it)
//   - Processes ALL stale runs within its own time budget (not just one),
//     claiming each atomically before processing
//   - Uses the existing runId so it resumes from checkpoints — zero data loss
//
// Why a time-bounded batch instead of one-per-tick?
//   - A "Run All" + walk away scenario creates multiple stale runs at once
//   - If we only process one per 5-min tick, later runs can sit long enough to
//     cross the PurgeStaleRuns 30-min threshold and be marked failed before
//     this job ever touches them — permanently losing checkpointed progress
//   - With batching, we drain the backlog within a few invocations
//
// Coexistence with client poll loop:
//   - Client refreshes triggered_at per batch (heartbeat)
//   - So actively-driven runs always have triggered_at < 6 min and are skipped
//   - If client disconnects, triggered_at goes stale → this picks it up next cycle
//
// On completion:
//   - Verifies that canonical output was persisted by runPipelineCore()
//   - Does NOT write to module_outputs itself (Fix 18 closure: sole-writer principle)
//   - If canonical output is missing, marks run failed for manual investigation
// ---------------------------------------------------------------------------

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// These modules run on v2 orchestrators and must never be routed to runPipelineCore.
const RESUME_EXCLUDED_MODULE_IDS = ["model_assumptions_stress", "external_risk_overlay", "social_reputation"];

const StaleRunSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  module_id: z.string(),
});

export default api({
  name: "ResumeStalePipelines",
  description: "Background safety net: finds stale running pipelines and resumes them (batched)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({}),

  output: z.object({
    found: z.number(),
    mastRunsExcluded: z.number(),
    excludedByModule: z.array(z.object({
      module_id: z.string(),
      cnt: z.number(),
    })),
    processed: z.array(z.object({
      runId: z.string(),
      moduleId: z.string(),
      outcome: z.string(),
    })),
  }),

  async run(ctx) {
    const jobStart = Date.now();
    const timeRemaining = () => RESUME_JOB_TIME_BUDGET_MS - (Date.now() - jobStart);

    // Find all stale runs: status='running' and triggered_at older than threshold
    // Excludes v2-orchestrated modules and runs with active recovery claims
    const excludedList = RESUME_EXCLUDED_MODULE_IDS.map((_, i) => `$${i + 1}`).join(", ");
    const staleRuns = await ctx.integrations.db.query(
      `SELECT mr.id, mr.deal_id, mr.module_id
       FROM module_runs mr
       WHERE mr.status = 'running'::module_status
         AND mr.module_id NOT IN (${excludedList})
         AND mr.triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
         AND NOT EXISTS (
           SELECT 1 FROM merge_checkpoints mc
           WHERE mc.module_run_id = mr.id
             AND mc.claimed_by IS NOT NULL
             AND mc.claimed_at > now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
         )
       ORDER BY mr.triggered_at ASC
       LIMIT 10`,
      StaleRunSchema,
      RESUME_EXCLUDED_MODULE_IDS,
      { label: "Find stale running pipelines (excludes v2 modules)" }
    );

    // -----------------------------------------------------------------------
    // Exclusion diagnostic — count stale runs per excluded module so
    // operators can confirm the filter is working and no v2 run is stuck.
    // -----------------------------------------------------------------------
    const excludedDiag = await ctx.integrations.db.query(
      `SELECT mr.module_id, count(*)::int AS cnt
       FROM module_runs mr
       WHERE mr.status = 'running'::module_status
         AND mr.module_id IN (${excludedList})
         AND mr.triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
       GROUP BY mr.module_id`,
      z.object({ module_id: z.string(), cnt: z.number() }),
      RESUME_EXCLUDED_MODULE_IDS,
      { label: "Count excluded stale runs by module" }
    );
    const excludedByModule = excludedDiag;
    const mastRunsExcluded =
      excludedDiag.find((r) => r.module_id === "model_assumptions_stress")?.cnt ?? 0;
    if (excludedDiag.length > 0) {
      console.log(`[RESUME] EXCLUDED ${JSON.stringify(excludedDiag)}`);
    }

    if (staleRuns.length === 0) {
      return { found: 0, processed: [], mastRunsExcluded, excludedByModule };
    }

    const processed: Array<{ runId: string; moduleId: string; outcome: string }> = [];

    for (const target of staleRuns) {
      // Check time budget — need at least 60s to make meaningful progress
      if (timeRemaining() < 60_000) {
        break;
      }

      // Atomically claim this run (CAS on triggered_at to prevent double-pickup)
      const claimed = await ctx.integrations.db.query(
        `UPDATE module_runs
         SET triggered_at = now()
         WHERE id = $1 AND status = 'running'::module_status
           AND triggered_at < now() - interval '${STALENESS_THRESHOLD_MINUTES} minutes'
         RETURNING id`,
        z.object({ id: z.string() }),
        [target.id],
        { label: `Claim stale run ${target.id}` }
      );

      if (claimed.length === 0) {
        // Another process already claimed it — skip
        continue;
      }

      // Numeric report is loaded from checkpoints inside runPipelineCore —
      // no need to query it from module_runs (column doesn't exist in schema).

      try {
        const result = await runPipelineCore(ctx, {
          dealId: target.deal_id,
          moduleId: target.module_id,
          runId: target.id,
          useOpus: false,
          numericReport: null,
        });

        // Fix 18 closure: runPipelineCore() is the sole final-output writer.
        // We only VERIFY that canonical output was persisted — never reconstruct or overwrite.
        if (result.status === "completed") {
          const outputCheck = await ctx.integrations.db.query(
            `SELECT id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
            z.object({ id: z.string() }),
            [target.id],
            { label: `Verify canonical output exists for ${target.id}` }
          );

          if (outputCheck.length === 0) {
            // Canonical output missing after core completion — this is an error state.
            // Mark run incomplete so it can be diagnosed rather than silently lost.
            console.error(
              `[resume-stale] Run ${target.id} completed but no canonical output found in module_outputs. ` +
              `Marking run as failed — manual investigation required.`
            );
            await ctx.integrations.db.execute(
              `UPDATE module_runs SET status = 'failed'::module_status, error_message = 'Background completion: canonical output missing after core completion' WHERE id = $1`,
              [target.id],
              { label: `Mark run failed: missing canonical output` }
            );
            processed.push({
              runId: target.id,
              moduleId: target.module_id,
              outcome: "error: canonical output missing after core completion",
            });
            continue;
          }
        }

        processed.push({
          runId: target.id,
          moduleId: target.module_id,
          outcome: result.status === "completed"
            ? `completed (${result.failedChunks ?? 0} failed chunks)`
            : result.status === "in_progress"
              ? `in_progress: ${result.phase}`
              : `failed: ${result.firstError ?? result.phase}`,
        });
      } catch (err) {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
        processed.push({
          runId: target.id,
          moduleId: target.module_id,
          outcome: `error: ${msg.slice(0, 200)}`,
        });
      }
    }

    return {
      found: staleRuns.length,
      mastRunsExcluded,
      excludedByModule,
      processed,
    };
  },
});
