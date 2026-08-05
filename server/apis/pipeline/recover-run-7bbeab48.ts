/**
 * Recover Run 7bbeab48 — Recovery Preparation API
 *
 * Purpose: Prepare the incomplete contradiction_check run 7bbeab48 for resumption.
 *
 * This run was incorrectly finalized from L3:0 of an incomplete merge tree
 * (only 205/381 analyses completed). The publication gate (Commit 1) now
 * prevents this class of defect. This API prepares the run for complete
 * re-processing:
 *
 * Steps:
 *   1. Invalidate the existing partial module_output (mark as invalidated_partial)
 *   2. Reset the run status from 'completed' back to 'running'
 *   3. Diagnose missing analyses and persist a recovery checkpoint
 *   4. Remove stale merge nodes above the highest complete tree level
 *      (merge nodes built from incomplete data are not trustworthy)
 *
 * After this API runs, the next invocation of RunModulePipeline will:
 *   - Detect the run is 'running' with existing analyses
 *   - Resume from the analysis phase (filling missing analyses)
 *   - Rebuild the merge tree from scratch (all L1+ nodes cleared)
 *   - Reach natural root and pass the publication gate
 *   - Persist a complete, validated final artifact
 *
 * IMPORTANT: This API does NOT re-run the pipeline — it prepares state.
 * The actual execution happens on the next RunModulePipeline invocation.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  loadExpectedAnalysisPopulation,
  loadCompletedAnalysisIds,
  loadMergeNodeRecords,
  toCompactDiagnostic,
  validateTreeCompletion,
} from "./tree-completion-validator.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const TARGET_RUN_ID = "7bbeab48-8c1c-46c8-8a25-02b1caa5a8fb";

export default api({
  name: "RecoverRun7bbeab48",
  description: "Prepares incomplete run 7bbeab48 for resumption by invalidating partial output",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    /** Safety: must match the target run ID to execute */
    confirmRunId: z.string(),
    /** If true, only diagnose — do not mutate any data */
    dryRun: z.boolean().default(true),
  }),

  output: z.object({
    success: z.boolean(),
    phase: z.string(),
    diagnosis: z.object({
      expected_analysis_count: z.number(),
      completed_analysis_count: z.number(),
      missing_analysis_count: z.number(),
      coverage_pct: z.number(),
      expected_root_level: z.number(),
      highest_complete_level: z.number(),
      tree_complete: z.boolean(),
      publication_eligible: z.boolean(),
      blocking_reasons: z.array(z.string()),
    }),
    actions_taken: z.array(z.string()),
    error: z.string().nullable(),
  }),

  async run(ctx, { confirmRunId, dryRun }) {
    // Safety guard: prevent misuse against wrong run
    if (confirmRunId !== TARGET_RUN_ID) {
      return {
        success: false,
        phase: "safety_guard_failed",
        diagnosis: {
          expected_analysis_count: 0,
          completed_analysis_count: 0,
          missing_analysis_count: 0,
          coverage_pct: 0,
          expected_root_level: 0,
          highest_complete_level: 0,
          tree_complete: false,
          publication_eligible: false,
          blocking_reasons: [],
        },
        actions_taken: [],
        error: `Run ID mismatch: expected ${TARGET_RUN_ID}, got ${confirmRunId}. This recovery API is scoped to a single run.`,
      };
    }

    const actions: string[] = [];

    // Step 1: Diagnose the current state
    console.log(`[RecoverRun] Diagnosing run ${TARGET_RUN_ID}...`);

    const expected = await loadExpectedAnalysisPopulation(ctx.integrations.db, TARGET_RUN_ID);
    const completedIds = await loadCompletedAnalysisIds(ctx.integrations.db, TARGET_RUN_ID);
    const mergeNodes = await loadMergeNodeRecords(ctx.integrations.db, TARGET_RUN_ID);

    if (!expected.found) {
      return {
        success: false,
        phase: "routing_diagnostics_missing",
        diagnosis: {
          expected_analysis_count: 0,
          completed_analysis_count: completedIds.length,
          missing_analysis_count: 0,
          coverage_pct: 0,
          expected_root_level: 0,
          highest_complete_level: 0,
          tree_complete: false,
          publication_eligible: false,
          blocking_reasons: ["routing_diagnostics checkpoint not found"],
        },
        actions_taken: [],
        error: "Cannot recover: routing diagnostics checkpoint missing for this run.",
      };
    }

    // Find highest complete merge node (for diagnosis)
    const regularNodes = mergeNodes.filter(n => n.node_index >= 0 && n.tree_level < 90);
    const completeNodes = regularNodes.filter(n => n.status === "complete" || n.status === null);
    const highestCompleteLevel = completeNodes.reduce((max, n) => Math.max(max, n.tree_level), 0);

    // Run the validator to get full diagnostic
    const diagnostic = validateTreeCompletion({
      expectedAnalysisIds: expected.ids,
      completedAnalysisIds: completedIds,
      mergeNodes,
      actualFinalNodeLevel: highestCompleteLevel,
      actualFinalNodeIndex: 0,
    });

    const compact = toCompactDiagnostic(diagnostic);

    const diagnosisOutput = {
      expected_analysis_count: compact.expected_analysis_count,
      completed_analysis_count: compact.completed_analysis_count,
      missing_analysis_count: compact.missing_analysis_count,
      coverage_pct: compact.coverage_pct,
      expected_root_level: compact.expected_root_level,
      highest_complete_level: highestCompleteLevel,
      tree_complete: compact.tree_complete,
      publication_eligible: compact.publication_eligible,
      blocking_reasons: compact.blocking_reasons,
    };

    console.log(`[RecoverRun] Diagnosis: ${compact.completed_analysis_count}/${compact.expected_analysis_count} analyses, ` +
      `root expected at L${compact.expected_root_level}, highest complete at L${highestCompleteLevel}, ` +
      `tree_complete=${compact.tree_complete}, eligible=${compact.publication_eligible}`);

    if (dryRun) {
      actions.push("DRY RUN: No mutations performed. Set dryRun=false to execute recovery.");
      return {
        success: true,
        phase: "diagnosis_only",
        diagnosis: diagnosisOutput,
        actions_taken: actions,
        error: null,
      };
    }

    // --- MUTATIONS (only if dryRun=false) ---

    // Step 2: Invalidate existing partial module_output
    const existingOutputs = await ctx.integrations.db.query(
      `SELECT id FROM module_outputs WHERE module_run_id = $1`,
      z.object({ id: z.string() }),
      [TARGET_RUN_ID],
      { label: "Recovery: find existing outputs" }
    );

    if (existingOutputs.length > 0) {
      for (const output of existingOutputs) {
        // Mark as invalidated — preserves evidence trail without deletion
        await ctx.integrations.db.execute(
          `UPDATE module_outputs
           SET executive_header = '[INVALIDATED_PARTIAL] ' || COALESCE(executive_header, ''),
               full_report_markdown = '# ⚠️ INVALIDATED — Incomplete Merge Tree\n\n' ||
                 'This output was produced from L3:0 of an incomplete tree (54% coverage). ' ||
                 'It has been invalidated by the publication gate recovery process.\n\n' ||
                 '---\n\n' || COALESCE(full_report_markdown, '')
           WHERE id = $1`,
          [output.id],
          { label: `Recovery: invalidate partial output ${output.id}` }
        );
        actions.push(`Invalidated partial output: ${output.id}`);
      }
    }

    // Step 3: Reset run status from 'completed' back to 'running'
    await ctx.integrations.db.execute(
      `UPDATE module_runs
       SET status = 'running'::module_status,
           completed_at = NULL
       WHERE id = $1 AND status = 'completed'::module_status`,
      [TARGET_RUN_ID],
      { label: "Recovery: reset run to running" }
    );
    actions.push("Reset run status: completed → running");

    // Step 4: Clear stale merge nodes (L1+) that were built from incomplete data
    // The analysis checkpoints (pipeline_analysis) are preserved — only the merge
    // tree is rebuilt. This is safe because merge is deterministic from analyses.
    const deletedMergeNodes = await ctx.integrations.db.query(
      `DELETE FROM merge_checkpoints
       WHERE module_run_id = $1
         AND tree_level >= 1
         AND tree_level < 90
       RETURNING tree_level, node_index`,
      z.object({ tree_level: z.coerce.number(), node_index: z.coerce.number() }),
      [TARGET_RUN_ID],
      { label: "Recovery: clear stale merge nodes" }
    );
    actions.push(`Cleared ${deletedMergeNodes.length} stale merge nodes (L1+ data-dependent nodes)`);

    // Step 5: Also clear the root manifest (it references the old incomplete tree)
    await ctx.integrations.db.execute(
      `DELETE FROM merge_checkpoints
       WHERE module_run_id = $1
         AND node_index IN (-1, -2)
         AND tree_level < 90`,
      [TARGET_RUN_ID],
      { label: "Recovery: clear old manifests" }
    );
    actions.push("Cleared stale root/round manifests");

    // Step 6: Persist recovery checkpoint for audit trail
    const recoveryPayload = {
      recovery_type: "publication_gate_rollback",
      recovered_at: new Date().toISOString(),
      original_state: {
        partial_output_ids: existingOutputs.map(o => o.id),
        highest_complete_level: highestCompleteLevel,
        completed_analyses: completedIds.length,
        expected_analyses: expected.ids.length,
        coverage_pct: compact.coverage_pct,
      },
      reason: "Run finalized from incomplete merge tree (L3:0, 54% coverage). " +
        "Publication gate Commit 1 now prevents this class of defect.",
      next_steps: [
        `Resume pipeline: ${compact.missing_analysis_count} analyses need to be created`,
        "Merge tree will be rebuilt from scratch (all L1+ nodes cleared)",
        "Natural root will be reached and publication gate will pass",
      ],
    };

    await ctx.integrations.db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, status, payload)
       VALUES ($1, 'publication_gate_recovery', 'complete', $2::jsonb)
       ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
       SET payload = $2::jsonb, status = 'complete'`,
      [TARGET_RUN_ID, JSON.stringify(recoveryPayload)],
      { label: "Recovery: persist audit checkpoint" }
    );
    actions.push("Persisted recovery audit checkpoint");

    console.log(`[RecoverRun] Recovery complete. Actions: ${actions.join("; ")}`);

    return {
      success: true,
      phase: "recovery_complete",
      diagnosis: diagnosisOutput,
      actions_taken: actions,
      error: null,
    };
  },
});
