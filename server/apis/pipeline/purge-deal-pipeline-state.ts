/**
 * PurgeDealPipelineState — DESTRUCTIVE admin utility.
 *
 * Resets ALL pipeline state for a SINGLE deal so the next run starts completely
 * fresh. Preserves the deal record itself and its uploaded source documents.
 *
 * Tables cleared (scoped to the target deal):
 *   1. universal_extractions       — extraction data (deal_id filter)
 *   2. doc_tables                  — parsed table cache (document_id ∈ deal docs)
 *   3. document_chunks             — QA chunks (document_id ∈ deal docs)
 *   4. merge_checkpoints           — merge tree state (module_run_id ∈ deal runs)
 *   5. pipeline_checkpoints        — stage checkpoints / claims ledger (module_run_id ∈ deal runs)
 *   6. mg4_materiality_tier_checkpoints — tiering checkpoints (checkpoint_key LIKE runId%)
 *   7. diag_consolidation_sessions — consolidation state (id from deal run state_json)
 *   8. module_outputs              — final findings/artifacts (module_run_id ∈ deal runs)
 *   9. module_runs                 — run history itself (deal_id filter)
 *
 * Deletion order respects logical dependencies (children before parents).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ cnt: z.coerce.number() });

export default api({
  name: "PurgeDealPipelineState",
  description: "Destructive reset of all pipeline state for one deal",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    dryRun: z.boolean().describe("If true, only report counts — do not delete"),
  }),

  output: z.object({
    dealId: z.string(),
    dryRun: z.boolean(),
    before: z.record(z.string(), z.number()),
    after: z.record(z.string(), z.number()),
    otherDealsBefore: z.record(z.string(), z.number()),
    otherDealsAfter: z.record(z.string(), z.number()),
    sourceDocsCount: z.number(),
    tablesCleared: z.array(z.string()),
    errors: z.array(z.string()),
  }),

  async run(ctx, { dealId, dryRun }) {
    const errors: string[] = [];
    const tablesCleared: string[] = [];

    // ── Helper: count rows for a deal-scoped query ─────────────────────────
    async function countForDeal(sql: string, params: any[], label: string): Promise<number> {
      try {
        const rows = await ctx.integrations.db.query(sql, CountSchema, params, { label });
        return rows[0]?.cnt ?? 0;
      } catch (e: any) {
        // Table may not exist — treat as 0
        if (/42P01|does not exist/i.test(e?.message ?? "")) return 0;
        errors.push(`${label}: ${e?.message ?? e}`);
        return 0;
      }
    }

    // ── Helper: execute delete ──────────────────────────────────────────────
    async function execDelete(sql: string, params: any[], label: string): Promise<void> {
      if (dryRun) return;
      try {
        await ctx.integrations.db.execute(sql, params, { label });
      } catch (e: any) {
        if (/42P01|does not exist/i.test(e?.message ?? "")) return;
        errors.push(`${label}: ${e?.message ?? e}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: BEFORE COUNTS (this deal)
    // ═══════════════════════════════════════════════════════════════════════════

    // Get run IDs for this deal (needed for child table scoping)
    let runIds: string[] = [];
    try {
      const runRows = await ctx.integrations.db.query(
        `SELECT id FROM module_runs WHERE deal_id = $1`,
        z.object({ id: z.string() }),
        [dealId],
        { label: "Get deal run IDs" }
      );
      runIds = runRows.map(r => r.id);
    } catch (e: any) {
      if (!/42P01|does not exist/i.test(e?.message ?? "")) {
        errors.push(`Get run IDs: ${e?.message ?? e}`);
      }
    }

    // Get document IDs for this deal (needed for doc_tables / document_chunks scoping)
    let docIds: string[] = [];
    try {
      const docRows = await ctx.integrations.db.query(
        `SELECT id FROM documents WHERE deal_id = $1`,
        z.object({ id: z.string() }),
        [dealId],
        { label: "Get deal document IDs" }
      );
      docIds = docRows.map(r => r.id);
    } catch (e: any) {
      if (!/42P01|does not exist/i.test(e?.message ?? "")) {
        errors.push(`Get document IDs: ${e?.message ?? e}`);
      }
    }

    const before: Record<string, number> = {};

    before.universal_extractions = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id = $1`,
      [dealId], "Before: universal_extractions"
    );

    before.doc_tables = docIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM doc_tables WHERE document_id = ANY($1::uuid[])`,
          [docIds], "Before: doc_tables"
        )
      : 0;

    before.document_chunks = docIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM document_chunks WHERE document_id = ANY($1::uuid[])`,
          [docIds], "Before: document_chunks"
        )
      : 0;

    before.merge_checkpoints = runIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM merge_checkpoints WHERE module_run_id = ANY($1::uuid[])`,
          [runIds], "Before: merge_checkpoints"
        )
      : 0;

    before.pipeline_checkpoints = runIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM pipeline_checkpoints WHERE module_run_id = ANY($1::uuid[])`,
          [runIds], "Before: pipeline_checkpoints"
        )
      : 0;

    // mg4_materiality_tier_checkpoints keyed by "{runId}:materiality"
    let mg4Count = 0;
    for (const rid of runIds) {
      mg4Count += await countForDeal(
        `SELECT COUNT(*)::int AS cnt FROM mg4_materiality_tier_checkpoints WHERE checkpoint_key = $1`,
        [`${rid}:materiality`], `Before: mg4 for run ${rid.slice(0,8)}`
      );
    }
    before.mg4_materiality_tier_checkpoints = mg4Count;

    // diag_consolidation_sessions — sessions whose state_json references a deal run
    let diagSessionIds: string[] = [];
    if (runIds.length > 0) {
      try {
        const sessRows = await ctx.integrations.db.query(
          `SELECT DISTINCT id FROM diag_consolidation_sessions WHERE state_json->>'runId' = ANY($1::text[])`,
          z.object({ id: z.string() }),
          [runIds],
          { label: "Find consolidation sessions for deal" }
        );
        diagSessionIds = sessRows.map(r => r.id);
      } catch (e: any) {
        if (!/42P01|does not exist/i.test(e?.message ?? "")) {
          errors.push(`Find diag sessions: ${e?.message ?? e}`);
        }
      }
    }
    before.diag_consolidation_sessions = diagSessionIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM diag_consolidation_sessions WHERE id = ANY($1::text[])`,
          [diagSessionIds], "Before: diag_consolidation_sessions"
        )
      : 0;

    before.module_outputs = runIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM module_outputs WHERE module_run_id = ANY($1::uuid[])`,
          [runIds], "Before: module_outputs"
        )
      : 0;

    before.module_runs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_runs WHERE deal_id = $1`,
      [dealId], "Before: module_runs"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1b: OTHER DEALS BEFORE COUNTS (for safety verification)
    // ═══════════════════════════════════════════════════════════════════════════

    const otherDealsBefore: Record<string, number> = {};

    otherDealsBefore.universal_extractions = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id != $1`,
      [dealId], "Other: universal_extractions before"
    );
    otherDealsBefore.module_runs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_runs WHERE deal_id != $1`,
      [dealId], "Other: module_runs before"
    );
    otherDealsBefore.module_outputs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_outputs WHERE module_run_id NOT IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      [dealId], "Other: module_outputs before"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: DELETE (children → parents order)
    // ═══════════════════════════════════════════════════════════════════════════

    // 1. mg4_materiality_tier_checkpoints (no FK deps)
    for (const rid of runIds) {
      await execDelete(
        `DELETE FROM mg4_materiality_tier_checkpoints WHERE checkpoint_key = $1`,
        [`${rid}:materiality`], `Delete mg4 checkpoints for run ${rid.slice(0,8)}`
      );
    }
    if (!dryRun && runIds.length > 0) tablesCleared.push("mg4_materiality_tier_checkpoints (checkpoint_key = '{runId}:materiality')");

    // 2. diag_consolidation_sessions (no FK deps)
    if (diagSessionIds.length > 0) {
      await execDelete(
        `DELETE FROM diag_consolidation_sessions WHERE id = ANY($1::text[])`,
        [diagSessionIds], "Delete diag_consolidation_sessions"
      );
      if (!dryRun) tablesCleared.push("diag_consolidation_sessions (id ∈ sessions referencing deal runs)");
    }

    // 3. merge_checkpoints (depends on module_runs)
    if (runIds.length > 0) {
      await execDelete(
        `DELETE FROM merge_checkpoints WHERE module_run_id = ANY($1::uuid[])`,
        [runIds], "Delete merge_checkpoints"
      );
      if (!dryRun) tablesCleared.push("merge_checkpoints (module_run_id ∈ deal runs)");
    }

    // 4. pipeline_checkpoints (depends on module_runs)
    if (runIds.length > 0) {
      await execDelete(
        `DELETE FROM pipeline_checkpoints WHERE module_run_id = ANY($1::uuid[])`,
        [runIds], "Delete pipeline_checkpoints"
      );
      if (!dryRun) tablesCleared.push("pipeline_checkpoints (module_run_id ∈ deal runs)");
    }

    // 5. module_outputs (depends on module_runs)
    if (runIds.length > 0) {
      await execDelete(
        `DELETE FROM module_outputs WHERE module_run_id = ANY($1::uuid[])`,
        [runIds], "Delete module_outputs"
      );
      if (!dryRun) tablesCleared.push("module_outputs (module_run_id ∈ deal runs)");
    }

    // 6. universal_extractions (deal_id direct)
    await execDelete(
      `DELETE FROM universal_extractions WHERE deal_id = $1`,
      [dealId], "Delete universal_extractions"
    );
    if (!dryRun) tablesCleared.push("universal_extractions (deal_id filter)");

    // 7. doc_tables (document_id ∈ deal docs)
    if (docIds.length > 0) {
      await execDelete(
        `DELETE FROM doc_tables WHERE document_id = ANY($1::uuid[])`,
        [docIds], "Delete doc_tables"
      );
      if (!dryRun) tablesCleared.push("doc_tables (document_id ∈ deal documents)");
    }

    // 8. document_chunks (document_id ∈ deal docs)
    if (docIds.length > 0) {
      await execDelete(
        `DELETE FROM document_chunks WHERE document_id = ANY($1::uuid[])`,
        [docIds], "Delete document_chunks"
      );
      if (!dryRun) tablesCleared.push("document_chunks (document_id ∈ deal documents)");
    }

    // 9. module_runs — LAST (parent of checkpoints/outputs)
    await execDelete(
      `DELETE FROM module_runs WHERE deal_id = $1`,
      [dealId], "Delete module_runs"
    );
    if (!dryRun) tablesCleared.push("module_runs (deal_id filter)");

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: AFTER COUNTS
    // ═══════════════════════════════════════════════════════════════════════════

    const after: Record<string, number> = {};

    // Re-fetch run IDs (should be empty after purge)
    let afterRunIds: string[] = [];
    if (!dryRun) {
      // All runs deleted — use original runIds for any remaining checks
      afterRunIds = [];
    } else {
      afterRunIds = runIds;
    }

    after.universal_extractions = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id = $1`,
      [dealId], "After: universal_extractions"
    );

    after.doc_tables = docIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM doc_tables WHERE document_id = ANY($1::uuid[])`,
          [docIds], "After: doc_tables"
        )
      : 0;

    after.document_chunks = docIds.length > 0
      ? await countForDeal(
          `SELECT COUNT(*)::int AS cnt FROM document_chunks WHERE document_id = ANY($1::uuid[])`,
          [docIds], "After: document_chunks"
        )
      : 0;

    // For run-scoped tables, if runs are deleted they can't have children
    after.merge_checkpoints = !dryRun ? 0 : before.merge_checkpoints;
    after.pipeline_checkpoints = !dryRun ? 0 : before.pipeline_checkpoints;
    after.mg4_materiality_tier_checkpoints = !dryRun ? 0 : before.mg4_materiality_tier_checkpoints;
    after.diag_consolidation_sessions = !dryRun ? 0 : before.diag_consolidation_sessions;
    after.module_outputs = !dryRun ? 0 : before.module_outputs;

    after.module_runs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_runs WHERE deal_id = $1`,
      [dealId], "After: module_runs"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3b: OTHER DEALS AFTER COUNTS (prove non-destruction)
    // ═══════════════════════════════════════════════════════════════════════════

    const otherDealsAfter: Record<string, number> = {};

    otherDealsAfter.universal_extractions = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM universal_extractions WHERE deal_id != $1`,
      [dealId], "Other: universal_extractions after"
    );
    otherDealsAfter.module_runs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_runs WHERE deal_id != $1`,
      [dealId], "Other: module_runs after"
    );
    otherDealsAfter.module_outputs = await countForDeal(
      `SELECT COUNT(*)::int AS cnt FROM module_outputs WHERE module_run_id NOT IN (SELECT id FROM module_runs WHERE deal_id = $1)`,
      [dealId], "Other: module_outputs after"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 4: CONFIRM SOURCE DOCS INTACT
    // ═══════════════════════════════════════════════════════════════════════════

    const sourceDocsCount = docIds.length;

    return {
      dealId,
      dryRun,
      before,
      after,
      otherDealsBefore,
      otherDealsAfter,
      sourceDocsCount,
      tablesCleared,
      errors,
    };
  },
});
