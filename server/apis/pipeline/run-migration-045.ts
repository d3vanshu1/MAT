import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration045",
  description: "Creates sri_target_identity table for SRI entity identity tracking.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({}),
  output: z.object({
    success: z.boolean(),
    tablesCreated: z.array(z.string()),
    tablesAlreadyPresent: z.array(z.string()),
    indexesCreated: z.array(z.string()),
    message: z.string(),
  }),
  async run(ctx) {
    var db = ctx.integrations.db;
    var tablesCreated: string[] = [];
    var tablesAlreadyPresent: string[] = [];
    var indexesCreated: string[] = [];

    // Check pre-existence
    var existing = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sri_target_identity' LIMIT 1",
      z.object({ table_name: z.string() }),
      [],
      { label: "Migration045: check sri_target_identity" },
    );

    if (existing.length > 0) {
      tablesAlreadyPresent.push("sri_target_identity");
    } else {
      await db.execute(
        "CREATE TABLE IF NOT EXISTS sri_target_identity (identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, identity_type TEXT NOT NULL, identity_value TEXT NOT NULL, confidence TEXT, occurrence_count INT, source_document_id UUID, verbatim_snippet TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT sri_target_identity_uq UNIQUE (run_id, identity_type, identity_value))",
        [],
        { label: "Migration045: create sri_target_identity" },
      );
      tablesCreated.push("sri_target_identity");

      await db.execute(
        "CREATE INDEX IF NOT EXISTS sri_target_identity_run_idx ON sri_target_identity(run_id, identity_type)",
        [],
        { label: "Migration045: create index" },
      );
      indexesCreated.push("sri_target_identity_run_idx");
    }

    var total = tablesCreated.length + tablesAlreadyPresent.length;
    return {
      success: true,
      tablesCreated: tablesCreated,
      tablesAlreadyPresent: tablesAlreadyPresent,
      indexesCreated: indexesCreated,
      message: "Migration 045 complete. " + tablesCreated.length + " table(s) created, " + tablesAlreadyPresent.length + " already present.",
    };
  },
});
