/**
 * Migration 017 — Checkpoint Concurrency Guards
 *
 * Adds columns required for compare-and-swap protection on merge_checkpoints:
 *
 * - checkpoint_version: monotonically incrementing integer for optimistic locking.
 *   Every successful write increments this. CAS writes compare against the version
 *   observed at claim time.
 *
 * - claimed_by: text identifier of the worker/attempt that owns this node.
 *   NULL when no active claim exists.
 *
 * - claimed_at: timestamp when the claim was established.
 *   Used for stale-claim expiry (claims older than CLAIM_EXPIRY_MINUTES can be reclaimed).
 *
 * - payload_hash: SHA-256 hash of merged_json at time of completion.
 *   Allows post-hoc verification that a completed checkpoint was not silently overwritten.
 *
 * Also backfills checkpoint_version = 1 for all existing rows and computes
 * payload_hash for all existing complete checkpoints.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration017",
  description: "Adds concurrency guard columns to merge_checkpoints.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({
    migrated: z.boolean(),
    columnsAdded: z.array(z.string()),
    backfillStats: z.object({
      totalRows: z.number(),
      hashesComputed: z.number(),
    }),
  }),
  async run(ctx) {
    const columnsAdded: string[] = [];

    // Add checkpoint_version column
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS checkpoint_version INTEGER NOT NULL DEFAULT 1`,
      [],
      { label: "Add checkpoint_version column" }
    );
    columnsAdded.push("checkpoint_version");

    // Add claimed_by column
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS claimed_by TEXT`,
      [],
      { label: "Add claimed_by column" }
    );
    columnsAdded.push("claimed_by");

    // Add claimed_at column
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
      [],
      { label: "Add claimed_at column" }
    );
    columnsAdded.push("claimed_at");

    // Add payload_hash column
    await ctx.integrations.db.execute(
      `ALTER TABLE merge_checkpoints ADD COLUMN IF NOT EXISTS payload_hash TEXT`,
      [],
      { label: "Add payload_hash column" }
    );
    columnsAdded.push("payload_hash");

    // Backfill payload_hash for existing complete checkpoints using MD5 of merged_json
    // (SHA-256 not available natively in all PG without pgcrypto; MD5 is sufficient for
    // integrity detection — not security)
    const backfillResult = await ctx.integrations.db.query(
      `WITH updated AS (
         UPDATE merge_checkpoints
         SET payload_hash = md5(merged_json::text)
         WHERE status = 'complete' AND payload_hash IS NULL
         RETURNING id
       )
       SELECT count(*)::int as updated_count FROM updated`,
      z.object({ updated_count: z.number() }),
      [],
      { label: "Backfill payload_hash for complete checkpoints" }
    );

    // Get total row count
    const countResult = await ctx.integrations.db.query(
      `SELECT count(*)::int as total FROM merge_checkpoints`,
      z.object({ total: z.number() }),
      [],
      { label: "Count total checkpoints" }
    );

    return {
      migrated: true,
      columnsAdded,
      backfillStats: {
        totalRows: countResult[0]?.total ?? 0,
        hashesComputed: backfillResult[0]?.updated_count ?? 0,
      },
    };
  },
});
