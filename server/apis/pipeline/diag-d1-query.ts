/**
 * D1 Diagnostic — ad-hoc read-only queries for the D1 diagnostic packet.
 * Returns up to 50 rows as JSON. No writes.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagD1Query",
  description: "Ad-hoc read-only query for D1 diagnostic",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    sql: z.string(),
    params: z.array(z.string()).default([]),
  }),

  output: z.object({
    rows: z.array(z.any()),
    rowCount: z.number(),
  }),

  async run(ctx, { sql, params }) {
    // Safety: only allow SELECT
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
      throw new Error("Only SELECT/WITH queries allowed");
    }

    const rows = await ctx.integrations.db.query(
      sql,
      z.any(),
      params,
      { label: "D1 diagnostic query" }
    );

    return {
      rows: Array.isArray(rows) ? rows.slice(0, 50) : [rows],
      rowCount: Array.isArray(rows) ? rows.length : 1,
    };
  },
});
