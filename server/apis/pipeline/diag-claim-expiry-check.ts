/**
 * DiagClaimExpiryCheck — Read-only: returns database now(), N8 claimed_at, computed expiry, and boolean.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ResultSchema = z.object({
  db_now: z.string(),
  n8_claimed_at: z.string().nullable(),
  claim_expiry: z.string().nullable(),
  claim_expired: z.boolean().nullable(),
});

export default api({
  name: "DiagClaimExpiryCheck",
  description: "Read-only check of N8 claim expiry vs database clock",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    treeLevel: z.number(),
    nodeIndex: z.number(),
  }),

  output: z.object({
    db_now: z.string(),
    n8_claimed_at: z.string().nullable(),
    claim_expiry: z.string().nullable(),
    claim_expired: z.boolean().nullable(),
  }),

  async run(ctx, { runId, treeLevel, nodeIndex }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
         now()::text AS db_now,
         claimed_at::text AS n8_claimed_at,
         (claimed_at + interval '10 minutes')::text AS claim_expiry,
         (now() > claimed_at + interval '10 minutes') AS claim_expired
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
       LIMIT 1`,
      ResultSchema,
      [runId, treeLevel, nodeIndex],
      { label: "Check claim expiry for node" }
    );

    if (rows.length === 0) {
      return { db_now: new Date().toISOString(), n8_claimed_at: null, claim_expiry: null, claim_expired: null };
    }

    return rows[0];
  },
});
