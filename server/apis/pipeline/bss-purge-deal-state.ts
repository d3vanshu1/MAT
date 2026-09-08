/**
 * BssPurgeDealState — Admin API to cleanly reset all BSS v2 state for a deal.
 *
 * Deletes across seven tables in correct FK order:
 *   1. NULL self-reference (bss_candidates.superseded_by)
 *   2. bss_dispositions  (FK → bss_candidates)
 *   3. bss_coverage      (FK → bss_candidates)
 *   4. bss_dependencies  (FK → bss_candidates)
 *   5. bss_candidates    (FK → bss_profiles, self-ref now NULL)
 *   6. bss_profiles      (independent after candidates gone)
 *   7. bss_claims_index  (deal-keyed, independent)
 *   8. bss_pipeline_state (deal-keyed, includes _lock row)
 *
 * Guards:
 *   - dryRun defaults to true — returns planned deletions without executing
 *   - Hard-refuses the SCG deal (c46b4129-8a16-48ae-ad3a-1da061255445)
 *
 * Returns before/after row counts per table.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

const CountRow = z.object({ cnt: z.coerce.number() });

const TABLE_NAMES = [
  "bss_dispositions",
  "bss_coverage",
  "bss_dependencies",
  "bss_candidates",
  "bss_profiles",
  "bss_claims_index",
  "bss_pipeline_state",
] as const;

type TableName = typeof TABLE_NAMES[number];

export default api({
  name: "BssPurgeDealState",
  description: "Admin: purge all BSS v2 state for a deal (dry-run by default).",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    dryRun: z.boolean().default(true),
  }),

  output: z.object({
    dealId: z.string(),
    dryRun: z.boolean(),
    blocked: z.boolean(),
    blockReason: z.string().nullable(),
    before: z.record(z.string(), z.number()),
    after: z.record(z.string(), z.number()),
    deleted: z.record(z.string(), z.number()),
  }),

  async run(ctx, { dealId, dryRun }) {
    var db = ctx.integrations.db;

    // ── Guard: hard-refuse SCG ──
    if (dealId === SCG_DEAL_ID) {
      return {
        dealId: dealId,
        dryRun: dryRun,
        blocked: true,
        blockReason: "SCG deal is protected — purge refused per policy.",
        before: {},
        after: {},
        deleted: {},
      };
    }

    // ── Before counts ──
    var before: Record<string, number> = {};
    for (var i = 0; i < TABLE_NAMES.length; i++) {
      var tbl = TABLE_NAMES[i];
      var countSql = tbl === "bss_dispositions" || tbl === "bss_coverage"
        ? "SELECT count(*) AS cnt FROM " + tbl + " WHERE candidate_id IN (SELECT candidate_id FROM bss_candidates WHERE deal_id = $1)"
        : "SELECT count(*) AS cnt FROM " + tbl + " WHERE deal_id = $1";
      var rows = await db.query(countSql, CountRow, [dealId], { label: "BSS-PURGE: before count " + tbl });
      before[tbl] = rows[0]?.cnt ?? 0;
    }

    if (dryRun) {
      return {
        dealId: dealId,
        dryRun: true,
        blocked: false,
        blockReason: null,
        before: before,
        after: before, // unchanged in dry-run
        deleted: Object.fromEntries(Object.entries(before).map(function(e) { return [e[0], 0]; })),
      };
    }

    // ── Execute deletions in FK order ──

    // 1. Break self-reference
    await db.execute(
      "UPDATE bss_candidates SET superseded_by = NULL WHERE deal_id = $1 AND superseded_by IS NOT NULL",
      [dealId],
      { label: "BSS-PURGE: null superseded_by" },
    );

    // 2. Children of bss_candidates (FK with NO ACTION)
    await db.execute(
      "DELETE FROM bss_dispositions WHERE candidate_id IN (SELECT candidate_id FROM bss_candidates WHERE deal_id = $1)",
      [dealId],
      { label: "BSS-PURGE: delete dispositions" },
    );
    await db.execute(
      "DELETE FROM bss_coverage WHERE candidate_id IN (SELECT candidate_id FROM bss_candidates WHERE deal_id = $1)",
      [dealId],
      { label: "BSS-PURGE: delete coverage" },
    );
    await db.execute(
      "DELETE FROM bss_dependencies WHERE deal_id = $1",
      [dealId],
      { label: "BSS-PURGE: delete dependencies" },
    );

    // 3. Candidates then profiles
    await db.execute(
      "DELETE FROM bss_candidates WHERE deal_id = $1",
      [dealId],
      { label: "BSS-PURGE: delete candidates" },
    );
    await db.execute(
      "DELETE FROM bss_profiles WHERE deal_id = $1",
      [dealId],
      { label: "BSS-PURGE: delete profiles" },
    );

    // 4. Deal-keyed independent tables
    await db.execute(
      "DELETE FROM bss_claims_index WHERE deal_id = $1",
      [dealId],
      { label: "BSS-PURGE: delete claims_index" },
    );
    await db.execute(
      "DELETE FROM bss_pipeline_state WHERE deal_id = $1",
      [dealId],
      { label: "BSS-PURGE: delete pipeline_state (incl. _lock)" },
    );

    // ── After counts ──
    var after: Record<string, number> = {};
    var deleted: Record<string, number> = {};
    for (var j = 0; j < TABLE_NAMES.length; j++) {
      var tbl2 = TABLE_NAMES[j];
      var countSql2 = tbl2 === "bss_dispositions" || tbl2 === "bss_coverage"
        ? "SELECT count(*) AS cnt FROM " + tbl2 + " WHERE candidate_id IN (SELECT candidate_id FROM bss_candidates WHERE deal_id = $1)"
        : "SELECT count(*) AS cnt FROM " + tbl2 + " WHERE deal_id = $1";
      var rows2 = await db.query(countSql2, CountRow, [dealId], { label: "BSS-PURGE: after count " + tbl2 });
      after[tbl2] = rows2[0]?.cnt ?? 0;
      deleted[tbl2] = before[tbl2] - after[tbl2];
    }

    console.log("[BSS-PURGE] Purged deal " + dealId + ": " + JSON.stringify(deleted));

    return {
      dealId: dealId,
      dryRun: false,
      blocked: false,
      blockReason: null,
      before: before,
      after: after,
      deleted: deleted,
    };
  },
});
