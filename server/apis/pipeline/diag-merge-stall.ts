/**
 * Diagnostic API — Merge Stall Investigation
 *
 * Checks the state of claims/reconciliation checkpoints and merge budget gates
 * to identify why merges are stuck at a specific tree level.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagMergeStall",
  description: "Diagnoses merge stall by checking claims status, checkpoint counts, and timing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    // Claims checkpoint status
    claimsStatus: z.object({
      exists: z.boolean(),
      status: z.string().nullable(),
      complete: z.boolean().nullable(),
      pending_memos: z.number().nullable(),
      consecutive_no_progress: z.number().nullable(),
      total_claims: z.number().nullable(),
      docs_processed: z.number().nullable(),
    }),
    // Reconciliation checkpoint status
    reconciliationStatus: z.object({
      exists: z.boolean(),
      status: z.string().nullable(),
    }),
    // Merge checkpoint details per tree_level
    mergeByLevel: z.array(z.object({
      tree_level: z.number(),
      total_checkpoints: z.number(),
      complete_count: z.number(),
      error_count: z.number(),
      manifest_count: z.number(),
      partial_count: z.number(),
      max_node_index: z.number(),
    })),
    // Run timing
    runTiming: z.object({
      triggered_at: z.string().nullable(),
      minutes_since_trigger: z.number().nullable(),
    }),
    // Analysis count
    analysisCount: z.number(),
    // Total extractions available (routed chunks)
    extractionCount: z.number(),
  }),

  async run(ctx, { runId }) {
    // 1. Claims checkpoint status
    let claimsStatus: any = { exists: false, status: null, complete: null, pending_memos: null, consecutive_no_progress: null, total_claims: null, docs_processed: null };
    try {
      const claimsRows = await ctx.integrations.db.query(
        `SELECT status, 
                (payload->>'complete')::boolean AS complete,
                (payload->'extraction_metadata'->>'pending')::int AS pending_memos,
                (payload->'extraction_metadata'->>'consecutive_no_progress')::int AS consecutive_no_progress,
                (payload->'extraction_metadata'->>'total_claims')::int AS total_claims,
                (payload->'extraction_metadata'->>'docs_processed')::int AS docs_processed
         FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
         LIMIT 1`,
        z.object({
          status: z.string().nullable(),
          complete: z.boolean().nullable(),
          pending_memos: z.coerce.number().nullable(),
          consecutive_no_progress: z.coerce.number().nullable(),
          total_claims: z.coerce.number().nullable(),
          docs_processed: z.coerce.number().nullable(),
        }),
        [runId],
        { label: "Check claims ledger status" }
      );
      if (claimsRows.length > 0) {
        const r = claimsRows[0];
        claimsStatus = {
          exists: true,
          status: r.status,
          complete: r.complete,
          pending_memos: r.pending_memos,
          consecutive_no_progress: r.consecutive_no_progress,
          total_claims: r.total_claims,
          docs_processed: r.docs_processed,
        };
      }
    } catch { /* table may not exist */ }

    // 2. Reconciliation checkpoint status
    let reconciliationStatus: any = { exists: false, status: null };
    try {
      const reconRows = await ctx.integrations.db.query(
        `SELECT status FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
         LIMIT 1`,
        z.object({ status: z.string().nullable() }),
        [runId],
        { label: "Check reconciliation status" }
      );
      if (reconRows.length > 0) {
        reconciliationStatus = { exists: true, status: reconRows[0].status };
      }
    } catch { /* table may not exist */ }

    // 3. Merge checkpoint details by tree_level
    const mergeByLevel = await ctx.integrations.db.query(
      `SELECT tree_level,
              COUNT(*)::int AS total_checkpoints,
              COUNT(*) FILTER (WHERE COALESCE(status, 'complete') = 'complete')::int AS complete_count,
              COUNT(*) FILTER (WHERE COALESCE(status, 'complete') = 'error')::int AS error_count,
              COUNT(*) FILTER (WHERE COALESCE(status, 'complete') = 'manifest')::int AS manifest_count,
              COUNT(*) FILTER (WHERE COALESCE(status, 'complete') = 'partial')::int AS partial_count,
              MAX(node_index)::int AS max_node_index
       FROM merge_checkpoints
       WHERE module_run_id = $1
       GROUP BY tree_level
       ORDER BY tree_level
       LIMIT 10`,
      z.object({
        tree_level: z.coerce.number(),
        total_checkpoints: z.coerce.number(),
        complete_count: z.coerce.number(),
        error_count: z.coerce.number(),
        manifest_count: z.coerce.number(),
        partial_count: z.coerce.number(),
        max_node_index: z.coerce.number(),
      }),
      [runId],
      { label: "Merge checkpoints by tree level" }
    );

    // 4. Run timing
    const runTimingRows = await ctx.integrations.db.query(
      `SELECT triggered_at::text,
              EXTRACT(epoch FROM (now() - triggered_at)) / 60.0 AS minutes_since_trigger
       FROM module_runs WHERE id = $1
       LIMIT 1`,
      z.object({
        triggered_at: z.string().nullable(),
        minutes_since_trigger: z.coerce.number().nullable(),
      }),
      [runId],
      { label: "Run timing" }
    );
    const runTiming = runTimingRows[0] ?? { triggered_at: null, minutes_since_trigger: null };

    // 5. Analysis count
    const analysisRows = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Count analysis" }
    );
    const analysisCount = analysisRows[0]?.cnt ?? 0;

    // 6. Extraction count for the deal
    const dealIdRows = await ctx.integrations.db.query(
      `SELECT deal_id FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ deal_id: z.string() }),
      [runId],
      { label: "Get deal_id from run" }
    );
    const dealId = dealIdRows[0]?.deal_id;
    let extractionCount = 0;
    if (dealId) {
      const extRows = await ctx.integrations.db.query(
        `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id = $1`,
        z.object({ cnt: z.coerce.number() }),
        [dealId],
        { label: "Count extractions" }
      );
      extractionCount = extRows[0]?.cnt ?? 0;
    }

    return {
      claimsStatus,
      reconciliationStatus,
      mergeByLevel,
      runTiming,
      analysisCount,
      extractionCount,
    };
  },
});
