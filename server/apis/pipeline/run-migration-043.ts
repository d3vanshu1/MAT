import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

var TABLES_TO_DROP = ["sri_evidence", "sri_research_plan", "sri_entities"];

var EVIDENCE_DDL = "CREATE TABLE IF NOT EXISTS sri_evidence (evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), claim_id UUID NOT NULL REFERENCES sri_claims(claim_id) ON DELETE CASCADE, platform TEXT NOT NULL, url TEXT NOT NULL, domain TEXT, publisher TEXT, publication_date DATE, snippet TEXT, retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT sri_evidence_claim_url_uq UNIQUE (claim_id, url))";

var EVIDENCE_IDX = "CREATE INDEX IF NOT EXISTS sri_evidence_claim_idx ON sri_evidence(claim_id)";

export default api({
  name: "RunMigration043",
  description: "Drops unused SRI tables and recreates sri_evidence keyed to claims",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tablesDropped: z.array(z.string()),
    tablesCreated: z.array(z.string()),
  }),

  async run(ctx) {
    var db = ctx.integrations.db;

    var tablesDropped: string[] = [];
    for (var i = 0; i < TABLES_TO_DROP.length; i++) {
      var name = TABLES_TO_DROP[i];
      await db.execute("DROP TABLE IF EXISTS " + name + " CASCADE", [], { label: "Migration043: drop " + name });
      tablesDropped.push(name);
    }

    var tablesCreated: string[] = [];
    await db.execute(EVIDENCE_DDL, [], { label: "Migration043: create sri_evidence" });
    tablesCreated.push("sri_evidence");
    await db.execute(EVIDENCE_IDX, [], { label: "Migration043: index sri_evidence" });

    return {
      success: true,
      message: "Migration 043 complete. Dropped " + String(tablesDropped.length) + " table(s), created " + String(tablesCreated.length) + ".",
      tablesDropped: tablesDropped,
      tablesCreated: tablesCreated,
    };
  },
});
