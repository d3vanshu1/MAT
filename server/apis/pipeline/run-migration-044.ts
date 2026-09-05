import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

var TARGET_TABLES = ["sri_stage_diagnostics"];

var DDL: Array<[string, string]> = [
  ["sri_stage_diagnostics", "CREATE TABLE IF NOT EXISTS sri_stage_diagnostics (diag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, stage TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
];

var INDEXES: Array<[string, string]> = [
  ["sri_stage_diagnostics_run_idx", "CREATE INDEX IF NOT EXISTS sri_stage_diagnostics_run_idx ON sri_stage_diagnostics(run_id, stage)"],
];

export default api({
  name: "RunMigration044",
  description: "Creates sri_stage_diagnostics table for persisting stageData payloads",

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
    var db = ctx.integrations.db;

    var preExisting = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name",
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration044: check existing tables" },
    );
    var tablesAlreadyPresent = preExisting.map(function (r: any) { return r.table_name; });

    var tablesCreated: string[] = [];
    for (var di = 0; di < DDL.length; di++) {
      var name = DDL[di][0];
      var sql = DDL[di][1];
      await db.execute(sql, [], { label: "Migration044: create " + name });
      if (tablesAlreadyPresent.indexOf(name) === -1) tablesCreated.push(name);
    }

    var indexesCreated: string[] = [];
    for (var ii = 0; ii < INDEXES.length; ii++) {
      var idxName = INDEXES[ii][0];
      var idxSql = INDEXES[ii][1];
      await db.execute(idxSql, [], { label: "Migration044: index " + idxName });
      if (tablesCreated.length > 0) indexesCreated.push(idxName);
    }

    return {
      success: true,
      message: "Migration 044 complete. " + String(tablesCreated.length) + " table(s) created, " + String(tablesAlreadyPresent.length) + " already present.",
      tablesAlreadyPresent: tablesAlreadyPresent,
      tablesCreated: tablesCreated,
      indexesCreated: indexesCreated,
    };
  },
});
