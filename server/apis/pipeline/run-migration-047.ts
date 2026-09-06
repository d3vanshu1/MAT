/**
 * Migration 047 — Create oa_deal_config table for per-deal materiality thresholds.
 *
 * Replaces the hardcoded DEAL_CONFIG in oa-materiality.ts with a DB-backed
 * lookup. Each deal must have a row before materiality can run. No defaults —
 * a missing row is a hard failure, not a silent fallback to another deal's EV.
 *
 * Seeds the SCG (Project Saint) row with known values.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration047",
  description: "Create oa_deal_config table and seed SCG row",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),
  output: z.object({ status: z.string(), tables: z.array(z.string()) }),

  async run(ctx) {
    const db = ctx.integrations.db;

    await db.execute(
      "CREATE TABLE IF NOT EXISTS oa_deal_config (" +
      "  deal_id              UUID PRIMARY KEY," +
      "  enterprise_value_gbp BIGINT," +
      "  runrate_ebitda_gbp   BIGINT," +
      "  tier1_pct_of_ev      NUMERIC NOT NULL DEFAULT 0.01," +
      "  tier2_lower_pct      NUMERIC NOT NULL DEFAULT 0.0025," +
      "  checklist_version    TEXT    NOT NULL DEFAULT 'v1.1.0'," +
      "  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()," +
      "  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()" +
      ")",
      [],
      { label: "M047: create oa_deal_config" },
    );

    // Seed the SCG (Project Saint) row
    await db.execute(
      "INSERT INTO oa_deal_config (deal_id, enterprise_value_gbp, runrate_ebitda_gbp, tier1_pct_of_ev, tier2_lower_pct, checklist_version) " +
      "VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT (deal_id) DO NOTHING",
      [
        "c46b4129-8a16-48ae-ad3a-1da061255445",
        655000000,
        55000000,
        0.01,
        0.0025,
        "v1.1.0",
      ],
      { label: "M047: seed SCG deal config" },
    );

    // Verify
    const rows = await db.query(
      "SELECT deal_id, enterprise_value_gbp, runrate_ebitda_gbp, tier1_pct_of_ev, tier2_lower_pct, checklist_version FROM oa_deal_config LIMIT 5",
      z.object({
        deal_id: z.string(),
        enterprise_value_gbp: z.coerce.number().nullable(),
        runrate_ebitda_gbp: z.coerce.number().nullable(),
        tier1_pct_of_ev: z.coerce.number(),
        tier2_lower_pct: z.coerce.number(),
        checklist_version: z.string(),
      }),
      [],
      { label: "M047: verify" },
    );

    console.log("[M047] oa_deal_config rows:", JSON.stringify(rows));

    return {
      status: "complete",
      tables: ["oa_deal_config"],
    };
  },
});
