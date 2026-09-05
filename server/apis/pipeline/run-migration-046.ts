import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const TARGET_TABLES = ["sri_dropped_evidence"];

const DDL = [
  ["sri_dropped_evidence", "CREATE TABLE IF NOT EXISTS sri_dropped_evidence (drop_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, claim_id UUID, platform TEXT, url TEXT, domain TEXT, drop_stage TEXT NOT NULL, drop_reason TEXT, entity_match TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
];

const INDEXES = [
  ["sri_dropped_evidence_run_idx", "CREATE INDEX IF NOT EXISTS sri_dropped_evidence_run_idx ON sri_dropped_evidence(run_id, drop_stage)"],
];

export default api({
  name: "RunMigration046",
  description: "Creates sri_dropped_evidence table for SRI drop records.",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tablesAlreadyPresent: z.array(z.string()),
    tablesCreated: z.array(z.string()),
    indexesCreated: z.array(z.string()),
  }),

  async run(ctx) {
    const db = ctx.integrations.db;

    const preExisting = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name",
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration046: check existing tables" },
    );
    const alreadyPresent = preExisting.map(function (r) { return r.table_name; });

    const tablesCreated: string[] = [];
    for (var i = 0; i < DDL.length; i++) {
      var entry = DDL[i];
      await db.execute(entry[1], [], { label: "Migration046: " + entry[0] });
      if (alreadyPresent.indexOf(entry[0]) === -1) {
        tablesCreated.push(entry[0]);
      }
    }

    const indexesCreated: string[] = [];
    for (var j = 0; j < INDEXES.length; j++) {
      var idx = INDEXES[j];
      await db.execute(idx[1], [], { label: "Migration046: " + idx[0] });
      indexesCreated.push(idx[0]);
    }

    return {
      success: true,
      message: tablesCreated.length > 0
        ? "Created " + tablesCreated.length + " table(s) and " + indexesCreated.length + " index(es)."
        : "All tables already present. No changes made.",
      tablesAlreadyPresent: alreadyPresent,
      tablesCreated: tablesCreated,
      indexesCreated: indexesCreated,
    };
  },
});
