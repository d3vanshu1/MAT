/**
 * Migration 015 — Durable Analysis Workers (Stabilization Batch, Commit 1)
 *
 * Creates the `analysis_work_items` table that enables bounded, lease-based
 * chunk analysis with stable identity, concurrent workers, and failure recovery.
 *
 * This table coordinates work — `pipeline_analysis` remains the authoritative
 * result store consumed by the merge phase (dual-write pattern).
 *
 * Identity tuple: (run_id, document_id, chunk_index, chunk_hash, analysis_version)
 * State machine: pending → claimed → complete | failed_retryable | failed_permanent
 *
 * Also adds a `merge_strategy` column to `module_runs` for per-run routing
 * (Q5: sticky merge strategy — legacy_tree vs canonical_group_v1).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration015",
  description: "Creates analysis_work_items table for durable bounded analysis workers",

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

    // 1. Create analysis_work_items table
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS analysis_work_items (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID NOT NULL,
        document_id     UUID NOT NULL,
        chunk_index     INT NOT NULL,
        chunk_hash      TEXT NOT NULL,
        analysis_version TEXT NOT NULL,

        -- Claim/lease state
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','claimed','complete','failed_retryable','failed_permanent')),
        claim_owner     TEXT,
        claimed_at      TIMESTAMPTZ,
        lease_expires   TIMESTAMPTZ,
        attempt_count   INT NOT NULL DEFAULT 0,

        -- Result tracking (lightweight — full result lives in pipeline_analysis)
        completed_at    TIMESTAMPTZ,
        error_message   TEXT,
        result_hash     TEXT,

        -- Timestamps
        created_at      TIMESTAMPTZ DEFAULT now(),
        updated_at      TIMESTAMPTZ DEFAULT now(),

        -- Constraints
        UNIQUE (run_id, chunk_index)
      )`,
      [],
      { label: "Create analysis_work_items table" }
    );
    steps.push("Created analysis_work_items table");

    // 2. Index: find claimable items efficiently (pending + expired leases)
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_claimable
       ON analysis_work_items (run_id, status, lease_expires)
       WHERE status IN ('pending', 'claimed')`,
      [],
      { label: "Create claimable items index" }
    );
    steps.push("Created idx_awi_claimable index");

    // 3. Index: expired lease recovery
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_expired_leases
       ON analysis_work_items (lease_expires)
       WHERE status = 'claimed'`,
      [],
      { label: "Create expired leases index" }
    );
    steps.push("Created idx_awi_expired_leases index");

    // 4. Index: progress counts by status
    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_awi_status_counts
       ON analysis_work_items (run_id, status)`,
      [],
      { label: "Create status counts index" }
    );
    steps.push("Created idx_awi_status_counts index");

    // 5. Add merge_strategy column to module_runs (Q5: sticky per-run routing)
    await ctx.integrations.db.execute(
      `ALTER TABLE module_runs
       ADD COLUMN IF NOT EXISTS merge_strategy TEXT
       CHECK (merge_strategy IS NULL OR merge_strategy IN ('legacy_tree', 'canonical_group_v1'))`,
      [],
      { label: "Add merge_strategy to module_runs" }
    );
    steps.push("Added merge_strategy column to module_runs");

    // 6. Add analysis_worker_enabled column to module_runs (per-run opt-in)
    await ctx.integrations.db.execute(
      `ALTER TABLE module_runs
       ADD COLUMN IF NOT EXISTS analysis_worker_enabled BOOLEAN DEFAULT false`,
      [],
      { label: "Add analysis_worker_enabled to module_runs" }
    );
    steps.push("Added analysis_worker_enabled column to module_runs");

    return {
      success: true,
      message: `Migration 015 completed: ${steps.length} steps`,
      steps,
    };
  },
});
