/**
 * Migration 014 — adds finding_id TEXT column to absence_verification_checkpoints.
 *
 * RC2 (Explicit Checkpoint State Machine): Using finding_index (array position) as
 * the checkpoint key is fragile — if findings are reordered between invocations
 * (e.g. by dedup/merge), the wrong verdict gets applied to the wrong finding.
 *
 * This migration adds finding_id (UUID) as the stable key. The unique constraint
 * shifts from (module_run_id, finding_index) to (module_run_id, finding_id).
 * Old rows with NULL finding_id are preserved for backward compat; the code falls
 * back to index-based lookup only for legacy rows.
 *
 * Also adds a `status` column to merge_checkpoints (complete/partial/error) and
 * a `version_hash` column to pipeline_checkpoints for integrity checking.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration014",
  description: "Adds finding_id to absence checkpoints, status to merge checkpoints, version_hash to pipeline checkpoints",

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

    // 1. Add finding_id column to absence_verification_checkpoints
    await ctx.integrations.db.execute(
      `ALTER TABLE absence_verification_checkpoints
       ADD COLUMN IF NOT EXISTS finding_id TEXT`,
      [],
      { label: "Add finding_id to absence_verification_checkpoints" }
    );
    steps.push("Added finding_id column to absence_verification_checkpoints");

    // 2. Create new unique constraint on (module_run_id, finding_id) — only for non-null finding_id rows
    // Use a partial unique index so NULL finding_id rows (legacy) keep the old constraint
    await ctx.integrations.db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_abs_verify_by_finding_id
       ON absence_verification_checkpoints (module_run_id, finding_id)
       WHERE finding_id IS NOT NULL`,
      [],
      { label: "Create unique index on (module_run_id, finding_id)" }
    );
    steps.push("Created partial unique index idx_abs_verify_by_finding_id");

    // 3. Add status column to merge_checkpoints (tracks completion state explicitly)
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints
       ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'`,
      [],
      { label: "Add status column to merge_checkpoints" }
    );
    steps.push("Added status column to merge_checkpoints (default: complete)");

    // 4. Add input_hash column to merge_checkpoints (integrity check: hash of input batches)
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints
       ADD COLUMN IF NOT EXISTS input_hash TEXT`,
      [],
      { label: "Add input_hash column to merge_checkpoints" }
    );
    steps.push("Added input_hash column to merge_checkpoints");

    // 5. Add version_hash column to pipeline_checkpoints (integrity check)
    await ctx.integrations.db.execute(
      `ALTER TABLE pipeline_checkpoints
       ADD COLUMN IF NOT EXISTS version_hash TEXT`,
      [],
      { label: "Add version_hash column to pipeline_checkpoints" }
    );
    steps.push("Added version_hash column to pipeline_checkpoints");

    // 6. Add status column to pipeline_checkpoints
    await ctx.integrations.db.execute(
      `ALTER TABLE pipeline_checkpoints
       ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'`,
      [],
      { label: "Add status column to pipeline_checkpoints" }
    );
    steps.push("Added status column to pipeline_checkpoints (default: complete)");

    return {
      success: true,
      message: "Migration 014 complete — checkpoint state machine columns added.",
      steps,
    };
  },
});
