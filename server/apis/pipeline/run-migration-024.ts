/**
 * Migration 024 — Add quantified_impact and source_fact_id to oa_findings.
 *
 * P7 now writes a verified monetary figure + the source fact UUID alongside
 * the finding's materiality tier. These must be persisted for audit trail.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration024",
  description: "Adds quantified_impact and source_fact_id columns to oa_findings.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    columns_added: z.array(z.string()),
  }),

  async run(ctx) {
    const added: string[] = [];

    // Add quantified_impact (nullable numeric — GBP amount)
    await ctx.integrations.db.execute(
      `ALTER TABLE oa_findings ADD COLUMN IF NOT EXISTS quantified_impact NUMERIC`,
      [],
      { label: "Migration024: add quantified_impact column" }
    );
    added.push("quantified_impact");

    // Add source_fact_id (nullable UUID — FK back to oa_facts)
    await ctx.integrations.db.execute(
      `ALTER TABLE oa_findings ADD COLUMN IF NOT EXISTS source_fact_id UUID`,
      [],
      { label: "Migration024: add source_fact_id column" }
    );
    added.push("source_fact_id");

    return { columns_added: added };
  },
});
