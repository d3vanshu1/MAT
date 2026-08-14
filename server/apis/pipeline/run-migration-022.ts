/**
 * Migration 022 — Add source_metadata JSONB column to oa_facts.
 *
 * Stores per-array-type metadata fields that don't have their own typed columns
 * but need to be preserved for provenance and downstream analysis.
 *
 * Tables are empty at time of execution — pure DDL, safe.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration022",
  description: "Adds source_metadata JSONB column to oa_facts.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({
    created: z.boolean(),
  }),
  async run(ctx) {
    await ctx.integrations.db.execute(
      `ALTER TABLE oa_facts ADD COLUMN IF NOT EXISTS source_metadata JSONB`,
      [],
      { label: "Migration022: add source_metadata JSONB to oa_facts" }
    );
    return { created: true };
  },
});
