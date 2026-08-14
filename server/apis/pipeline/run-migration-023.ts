/**
 * Migration 023 — extraction_diag table for durable extraction diagnostics.
 *
 * Console.log has 10-minute retention and is lost on platform kill.
 * This table captures per-chunk extraction metrics (tokens, truncation)
 * durably so truncation events are observable after the fact.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration023",
  description: "Creates extraction_diag table for durable extraction metrics.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    created: z.boolean(),
  }),

  async run(ctx) {
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS extraction_diag (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id       UUID NOT NULL,
        document_id   UUID NOT NULL,
        chunk_index   INT  NOT NULL,
        output_tokens INT,
        input_tokens  INT,
        char_count    INT,
        pct_cap       INT,
        truncated     BOOLEAN NOT NULL,
        stop_reason   TEXT,
        attempt       INT,
        path          TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration023: create extraction_diag table" }
    );

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_extraction_diag_deal
       ON extraction_diag (deal_id, truncated)`,
      [],
      { label: "Migration023: create extraction_diag index" }
    );

    return { created: true };
  },
});
