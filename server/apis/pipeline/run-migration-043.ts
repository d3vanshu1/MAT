import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

var EVIDENCE_DDL = "CREATE TABLE IF NOT EXISTS sri_evidence (evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), claim_id UUID NOT NULL REFERENCES sri_claims(claim_id) ON DELETE CASCADE, platform TEXT NOT NULL, url TEXT NOT NULL, domain TEXT, publisher TEXT, publication_date DATE, snippet TEXT, retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT sri_evidence_claim_url_uq UNIQUE (claim_id, url))";

var EVIDENCE_IDX = "CREATE INDEX IF NOT EXISTS sri_evidence_claim_idx ON sri_evidence(claim_id)";

var TableExistsRow = z.object({ table_name: z.string() });
var ColumnExistsRow = z.object({ column_name: z.string() });

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
    alreadyCorrect: z.array(z.string()),
  }),

  async run(ctx) {
    var db = ctx.integrations.db;

    // Pre-existence check
    var existingTables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('sri_entities', 'sri_research_plan', 'sri_evidence')",
      TableExistsRow,
      [],
      { label: "Migration043: check existing tables" },
    );
    var existingSet = new Set(existingTables.map(function (r) { return r.table_name; }));

    // Check whether sri_evidence has a plan_id column (old shape)
    var evidenceCols = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sri_evidence' AND column_name = 'plan_id'",
      ColumnExistsRow,
      [],
      { label: "Migration043: check sri_evidence for plan_id" },
    );
    var evidenceHasPlanId = evidenceCols.length > 0;

    var tablesDropped: string[] = [];
    var tablesCreated: string[] = [];
    var alreadyCorrect: string[] = [];

    // Drop sri_entities if present
    if (existingSet.has("sri_entities")) {
      await db.execute("DROP TABLE IF EXISTS sri_entities CASCADE", [], { label: "Migration043: drop sri_entities" });
      tablesDropped.push("sri_entities");
    }

    // Drop sri_research_plan if present
    if (existingSet.has("sri_research_plan")) {
      await db.execute("DROP TABLE IF EXISTS sri_research_plan CASCADE", [], { label: "Migration043: drop sri_research_plan" });
      tablesDropped.push("sri_research_plan");
    }

    // sri_evidence: drop and recreate ONLY if old shape (has plan_id).
    // If it exists without plan_id, it is already the new shape — leave untouched.
    // If it does not exist, create it.
    if (existingSet.has("sri_evidence") && evidenceHasPlanId) {
      await db.execute("DROP TABLE IF EXISTS sri_evidence CASCADE", [], { label: "Migration043: drop old-shape sri_evidence" });
      tablesDropped.push("sri_evidence");
      await db.execute(EVIDENCE_DDL, [], { label: "Migration043: create sri_evidence (new shape)" });
      await db.execute(EVIDENCE_IDX, [], { label: "Migration043: index sri_evidence" });
      tablesCreated.push("sri_evidence");
    } else if (existingSet.has("sri_evidence") && !evidenceHasPlanId) {
      alreadyCorrect.push("sri_evidence");
    } else {
      await db.execute(EVIDENCE_DDL, [], { label: "Migration043: create sri_evidence (first time)" });
      await db.execute(EVIDENCE_IDX, [], { label: "Migration043: index sri_evidence" });
      tablesCreated.push("sri_evidence");
    }

    return {
      success: true,
      message: "Migration 043 complete. Dropped " + String(tablesDropped.length) + ", created " + String(tablesCreated.length) + ", already correct " + String(alreadyCorrect.length) + ".",
      tablesDropped: tablesDropped,
      tablesCreated: tablesCreated,
      alreadyCorrect: alreadyCorrect,
    };
  },
});
