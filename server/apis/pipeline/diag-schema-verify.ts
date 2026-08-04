/**
 * DiagSchemaVerify — Confirms merge_checkpoints table schema from information_schema.
 * Used to verify migration 017 deployment.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagSchemaVerify",
  description: "Verifies merge_checkpoints schema and concurrency column state.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string().uuid().optional(),
  }),
  output: z.object({
    columns: z.array(z.object({
      column_name: z.string(),
      data_type: z.string(),
      is_nullable: z.string(),
      column_default: z.string().nullable(),
    })),
    indexes: z.array(z.object({
      indexname: z.string(),
      indexdef: z.string(),
    })),
    concurrencyState: z.object({
      totalRows: z.number(),
      withVersion: z.number(),
      withPayloadHash: z.number(),
      withActiveClaim: z.number(),
      versionDistribution: z.array(z.object({
        checkpoint_version: z.number(),
        count: z.number(),
      })),
    }),
    sampleCompleteHashes: z.array(z.object({
      tree_level: z.number(),
      node_index: z.number(),
      status: z.string(),
      checkpoint_version: z.number(),
      payload_hash: z.string().nullable(),
      claimed_by: z.string().nullable(),
      claimed_at: z.string().nullable(),
      updated_at: z.string(),
    })),
  }),
  async run(ctx, { runId }) {
    // 1. Get column definitions
    const columns = await ctx.integrations.db.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'merge_checkpoints'
       ORDER BY ordinal_position`,
      z.object({
        column_name: z.string(),
        data_type: z.string(),
        is_nullable: z.string(),
        column_default: z.string().nullable(),
      }),
      [],
      { label: "Get merge_checkpoints columns" }
    );

    // 2. Get indexes
    const indexes = await ctx.integrations.db.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = 'merge_checkpoints'`,
      z.object({
        indexname: z.string(),
        indexdef: z.string(),
      }),
      [],
      { label: "Get merge_checkpoints indexes" }
    );

    // 3. Get concurrency state
    const stats = await ctx.integrations.db.query(
      `SELECT
         count(*)::int as total_rows,
         count(*) FILTER (WHERE checkpoint_version IS NOT NULL)::int as with_version,
         count(*) FILTER (WHERE payload_hash IS NOT NULL)::int as with_hash,
         count(*) FILTER (WHERE claimed_by IS NOT NULL)::int as with_active_claim
       FROM merge_checkpoints
       ${runId ? 'WHERE module_run_id = $1' : ''}`,
      z.object({
        total_rows: z.number(),
        with_version: z.number(),
        with_hash: z.number(),
        with_active_claim: z.number(),
      }),
      runId ? [runId] : [],
      { label: "Get concurrency column stats" }
    );

    const versionDist = await ctx.integrations.db.query(
      `SELECT checkpoint_version, count(*)::int as count
       FROM merge_checkpoints
       ${runId ? 'WHERE module_run_id = $1' : ''}
       GROUP BY checkpoint_version
       ORDER BY checkpoint_version
       LIMIT 10`,
      z.object({ checkpoint_version: z.number(), count: z.number() }),
      runId ? [runId] : [],
      { label: "Version distribution" }
    );

    // 4. Sample complete node hashes for the run (first 10)
    const sampleHashes = runId ? await ctx.integrations.db.query(
      `SELECT tree_level, node_index, status, checkpoint_version,
              payload_hash, claimed_by,
              to_char(claimed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as claimed_at,
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND status = 'complete'
       ORDER BY tree_level, node_index
       LIMIT 10`,
      z.object({
        tree_level: z.number(),
        node_index: z.number(),
        status: z.string(),
        checkpoint_version: z.number(),
        payload_hash: z.string().nullable(),
        claimed_by: z.string().nullable(),
        claimed_at: z.string().nullable(),
        updated_at: z.string(),
      }),
      [runId],
      { label: "Sample complete node hashes" }
    ) : [];

    return {
      columns,
      indexes,
      concurrencyState: {
        totalRows: stats[0]?.total_rows ?? 0,
        withVersion: stats[0]?.with_version ?? 0,
        withPayloadHash: stats[0]?.with_hash ?? 0,
        withActiveClaim: stats[0]?.with_active_claim ?? 0,
        versionDistribution: versionDist,
      },
      sampleCompleteHashes: sampleHashes,
    };
  },
});
