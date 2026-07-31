/**
 * Migration 015 — Durable Analysis Workers (Stabilization Batch, Commit 1 Corrective)
 *
 * Creates TWO application-owned tables (no ALTER on existing tables):
 *
 * 1. pipeline_run_config — per-run opt-in configuration (replaces the need to
 *    ALTER module_runs). Stores analysis_worker_enabled and merge_strategy.
 *
 * 2. analysis_work_items — bounded lease-based work coordination with stable
 *    identity. Unique on the full identity tuple:
 *      (run_id, document_id, chunk_index, chunk_hash, analysis_version)
 *    A deterministic `work_identity` hash is stored and UNIQUE-constrained so
 *    changed content or version produces new work without conflicting.
 *
 * State machine: pending → claimed → complete | failed_retryable | failed_permanent
 *
 * This migration is idempotent (IF NOT EXISTS on all DDL). Partial success
 * is safe — rerun to complete any missing objects.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration015",
  description: "Creates pipeline_run_config and analysis_work_items tables",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    steps: z.array(z.string()),
  }),

  async run(ctx) {
    const steps: string[] = [];

    // 1. pipeline_run_config — application-owned per-run settings
    //    No ALTER on module_runs required.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS pipeline_run_config (
        run_id                  UUID PRIMARY KEY,
        analysis_worker_enabled BOOLEAN NOT NULL DEFAULT false,
        merge_strategy          TEXT CHECK (
                                  merge_strategy IS NULL
                                  OR merge_strategy IN ('legacy_tree', 'canonical_group_v1')
                                ),
        created_at              TIMESTAMPTZ DEFAULT now(),
        updated_at              TIMESTAMPTZ DEFAULT now()
      )`,
      [],
      { label: "Create pipeline_run_config table" }
    );
    steps.push("Created pipeline_run_config table");

    // 2. analysis_work_items — coordination queue
    //    Unique constraint on the FULL identity tuple via work_identity hash.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS analysis_work_items (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id            UUID NOT NULL,
        document_id       TEXT NOT NULL,
        chunk_index       INT NOT NULL,
        chunk_hash        TEXT NOT NULL,
        analysis_version  TEXT NOT NULL,

        -- Deterministic identity hash: md5(run_id || document_id || chunk_index || chunk_hash || analysis_version)
        -- UNIQUE constraint ensures changed identity produces new work.
        work_identity     TEXT NOT NULL,

        -- State machine
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','claimed','complete','failed_retryable','failed_permanent')),
        claim_owner       TEXT,
        claimed_at        TIMESTAMPTZ,
        lease_expires     TIMESTAMPTZ,
        attempt_count     INT NOT NULL DEFAULT 0,

        -- Result tracking
        completed_at      TIMESTAMPTZ,
        error_message     TEXT,
        result_hash       TEXT,

        -- Timestamps
        created_at        TIMESTAMPTZ DEFAULT now(),
        updated_at        TIMESTAMPTZ DEFAULT now(),

        -- Identity uniqueness
        UNIQUE (work_identity)
      )`,
      [],
      { label: "Create analysis_work_items table" }
    );
    steps.push("Created analysis_work_items table");

    // 3. Index: find claimable items efficiently
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_claimable
       ON analysis_work_items (run_id, status, chunk_index)
       WHERE status IN ('pending', 'failed_retryable')`,
      [],
      { label: "Create claimable items index" }
    );
    steps.push("Created idx_awi_claimable index");

    // 4. Index: expired lease recovery
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_expired_leases
       ON analysis_work_items (run_id, lease_expires)
       WHERE status = 'claimed'`,
      [],
      { label: "Create expired leases index" }
    );
    steps.push("Created idx_awi_expired_leases index");

    // 5. Index: progress counts by status (current identity only)
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_status_counts
       ON analysis_work_items (run_id, analysis_version, status)`,
      [],
      { label: "Create status counts index" }
    );
    steps.push("Created idx_awi_status_counts index");

    // 6. Index: lookup by run_id + chunk_index for reconciliation
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_run_chunk
       ON analysis_work_items (run_id, chunk_index, analysis_version)`,
      [],
      { label: "Create run+chunk lookup index" }
    );
    steps.push("Created idx_awi_run_chunk index");

    return {
      success: true,
      message: `Migration 015 completed: ${steps.length} steps`,
      steps,
    };
  },
});
