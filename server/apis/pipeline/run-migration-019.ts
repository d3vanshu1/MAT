/**
 * Migration 019 — Artifact Lifecycle Columns + Active-Artifact Uniqueness Index
 *
 * Adds columns that implement the artifact supersession / invalidation protocol:
 *
 * module_outputs:
 * - artifact_status: TEXT        — 'active' (default) | 'superseded' | 'invalidated'
 * - superseded_by_output_id: UUID — FK to the row that supersedes this one
 * - invalidated_at: TIMESTAMPTZ  — when the row was invalidated
 * - invalidation_reason: TEXT    — human-readable reason for invalidation
 *
 * Indexes:
 * - UNIQUE partial index: one active artifact per module_run_id
 *   (module_run_id) WHERE artifact_status = 'active'
 *   → prevents duplicate active artifacts for the same run; silent on INSERT
 *     of superseded/invalidated rows (they are legitimate audit history).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration019",
  description: "Adds artifact lifecycle columns and uniqueness index to module_outputs.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({
    migrated: z.boolean(),
    columnsAdded: z.array(z.string()),
    indexesAdded: z.array(z.string()),
  }),
  async run(ctx) {
    const columnsAdded: string[] = [];
    const indexesAdded: string[] = [];

    // ── artifact_status ─────────────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS artifact_status TEXT NOT NULL DEFAULT 'active'`,
      [],
      { label: "Migration019: add artifact_status" }
    );
    columnsAdded.push("module_outputs.artifact_status");

    // ── superseded_by_output_id ──────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS superseded_by_output_id UUID`,
      [],
      { label: "Migration019: add superseded_by_output_id" }
    );
    columnsAdded.push("module_outputs.superseded_by_output_id");

    // ── invalidated_at ───────────────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ`,
      [],
      { label: "Migration019: add invalidated_at" }
    );
    columnsAdded.push("module_outputs.invalidated_at");

    // ── invalidation_reason ──────────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS invalidation_reason TEXT`,
      [],
      { label: "Migration019: add invalidation_reason" }
    );
    columnsAdded.push("module_outputs.invalidation_reason");

    // ── Partial unique index: exactly one active artifact per run ────────────
    // CREATE UNIQUE INDEX IF NOT EXISTS requires Postgres 9.5+.
    // We use IF NOT EXISTS to make the migration idempotent.
    await ctx.integrations.db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_module_outputs_one_active_per_run
       ON module_outputs (module_run_id)
       WHERE artifact_status = 'active'`,
      [],
      { label: "Migration019: create partial unique index (one active per run)" }
    );
    indexesAdded.push("uq_module_outputs_one_active_per_run");

    // ── Back-fill: existing rows get artifact_status = 'active' ─────────────
    // The DEFAULT above handles new inserts; existing rows with NULL need patching.
    await ctx.integrations.db.execute(
      `UPDATE module_outputs SET artifact_status = 'active' WHERE artifact_status IS NULL`,
      [],
      { label: "Migration019: back-fill artifact_status = 'active' for existing rows" }
    );

    console.log(
      `[Migration019] columns=${columnsAdded.join(", ")} | indexes=${indexesAdded.join(", ")}`
    );

    return {
      migrated: true,
      columnsAdded,
      indexesAdded,
    };
  },
});
