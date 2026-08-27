/**
 * Migration 034 — BSS v2 idempotency keys, claim token, and pipeline state.
 *
 * Four schema changes in one idempotent migration:
 *
 *   1. owner_token UUID NULL on module_runs — B2 claim token for race prevention.
 *   2. Unique constraint on bss_coverage (candidate_id) — one row per candidate,
 *      replacing the old (candidate_id, swept_at) key.
 *   3. Unique constraint on bss_dependencies (deal_id, candidate_id) — one row
 *      per candidate per deal.
 *   4. Unique constraint on bss_dispositions (candidate_id) — one disposition
 *      per candidate.
 *   5. CREATE TABLE bss_pipeline_state — checkpoint table for the v2 orchestrator.
 *
 * All statements are idempotent (IF NOT EXISTS / DO NOTHING patterns).
 * Existing data is preserved. Re-running this migration is a no-op.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration034",
  description: "Adds owner_token, stable upsert keys, and bss_pipeline_state for BSS v2",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    steps: z.array(z.object({
      name: z.string(),
      status: z.string(),
    })),
    readback: z.any(),
  }),

  async run(ctx) {
    const steps: Array<{ name: string; status: string }> = [];

    // ── 1. owner_token on module_runs ──────────────────────────────────
    // Wrapped in try/catch: the connected DB user may not own module_runs,
    // and this column is only for v1's RunModulePipeline B2 fix — not
    // required by BssRunPipeline, which uses bss_pipeline_state._lock.
    try {
      await ctx.integrations.db.execute(
        `ALTER TABLE module_runs ADD COLUMN IF NOT EXISTS owner_token UUID NULL`,
        [],
        { label: "Mig034: add owner_token to module_runs" },
      );
      steps.push({ name: "owner_token on module_runs", status: "done" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Mig034] owner_token on module_runs skipped: ${msg}`);
      steps.push({ name: "owner_token on module_runs", status: `skipped: ${msg.slice(0, 200)}` });
    }

    // ── 2. Unique on bss_coverage(candidate_id) ──────────────────────
    // First drop the old (candidate_id, swept_at) unique if it exists,
    // then add the new one. Using DO $$ block for idempotency.
    await ctx.integrations.db.execute(
      `DO $$ BEGIN
         -- Drop old timestamp-based unique if present
         IF EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE indexname = 'bss_coverage_candidate_swept_uniq'
         ) THEN
           ALTER TABLE bss_coverage DROP CONSTRAINT IF EXISTS bss_coverage_candidate_swept_uniq;
         END IF;
         -- Add new candidate-only unique
         IF NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE indexname = 'bss_coverage_candidate_uniq'
         ) THEN
           CREATE UNIQUE INDEX bss_coverage_candidate_uniq ON bss_coverage (candidate_id);
         END IF;
       END $$`,
      [],
      { label: "Mig034: unique on bss_coverage(candidate_id)" },
    );
    steps.push({ name: "unique bss_coverage(candidate_id)", status: "done" });

    // ── 3. Unique on bss_dependencies(deal_id, candidate_id) ─────────
    await ctx.integrations.db.execute(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE indexname = 'bss_dependencies_deal_candidate_uniq'
         ) THEN
           CREATE UNIQUE INDEX bss_dependencies_deal_candidate_uniq
             ON bss_dependencies (deal_id, candidate_id);
         END IF;
       END $$`,
      [],
      { label: "Mig034: unique on bss_dependencies(deal_id, candidate_id)" },
    );
    steps.push({ name: "unique bss_dependencies(deal_id, candidate_id)", status: "done" });

    // ── 4. Unique on bss_dispositions(candidate_id) ──────────────────
    // Drop the old (candidate_id, decided_at) unique if present
    await ctx.integrations.db.execute(
      `DO $$ BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE indexname = 'bss_dispositions_candidate_decided_uniq'
         ) THEN
           ALTER TABLE bss_dispositions DROP CONSTRAINT IF EXISTS bss_dispositions_candidate_decided_uniq;
         END IF;
         IF NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE indexname = 'bss_dispositions_candidate_uniq'
         ) THEN
           CREATE UNIQUE INDEX bss_dispositions_candidate_uniq ON bss_dispositions (candidate_id);
         END IF;
       END $$`,
      [],
      { label: "Mig034: unique on bss_dispositions(candidate_id)" },
    );
    steps.push({ name: "unique bss_dispositions(candidate_id)", status: "done" });

    // ── 5. bss_pipeline_state ─────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_pipeline_state (
         deal_id      UUID NOT NULL,
         stage        TEXT NOT NULL,
         status       TEXT NOT NULL DEFAULT 'pending',
         started_at   TIMESTAMPTZ NULL,
         completed_at TIMESTAMPTZ NULL,
         error        TEXT NULL,
         items_total  INT NULL,
         items_done   INT NULL,
         UNIQUE (deal_id, stage)
       )`,
      [],
      { label: "Mig034: create bss_pipeline_state" },
    );
    steps.push({ name: "bss_pipeline_state table", status: "done" });

    // ── Readback: verify all objects exist ─────────────────────────────
    const readback: Record<string, unknown> = {};

    // owner_token column
    const ownerTokenCol = await ctx.integrations.db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'module_runs' AND column_name = 'owner_token' LIMIT 1`,
      z.object({ column_name: z.string(), data_type: z.string() }),
      [],
      { label: "Mig034: readback owner_token" },
    );
    readback.owner_token = ownerTokenCol.length > 0
      ? { exists: true, type: ownerTokenCol[0].data_type }
      : { exists: false };

    // Unique indexes
    const indexes = await ctx.integrations.db.query(
      `SELECT indexname, tablename, indexdef FROM pg_indexes
       WHERE indexname IN (
         'bss_coverage_candidate_uniq',
         'bss_dependencies_deal_candidate_uniq',
         'bss_dispositions_candidate_uniq'
       ) ORDER BY indexname`,
      z.object({ indexname: z.string(), tablename: z.string(), indexdef: z.string() }),
      [],
      { label: "Mig034: readback unique indexes" },
    );
    readback.unique_indexes = indexes;

    // Old indexes should be gone
    const oldIndexes = await ctx.integrations.db.query(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN (
         'bss_coverage_candidate_swept_uniq',
         'bss_dispositions_candidate_decided_uniq'
       )`,
      z.object({ indexname: z.string() }),
      [],
      { label: "Mig034: check old indexes removed" },
    );
    readback.old_indexes_remaining = oldIndexes.map(i => i.indexname);

    // bss_pipeline_state table
    const pipelineStateCols = await ctx.integrations.db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'bss_pipeline_state' ORDER BY ordinal_position`,
      z.object({ column_name: z.string(), data_type: z.string() }),
      [],
      { label: "Mig034: readback bss_pipeline_state schema" },
    );
    readback.bss_pipeline_state = pipelineStateCols;

    return {
      success: true,
      steps,
      readback,
    };
  },
});
