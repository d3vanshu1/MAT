import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const TARGET_TABLES = ["sri_pipeline_state","sri_entities","sri_claims","sri_research_plan","sri_evidence","sri_findings"];

const DDL = [
["sri_pipeline_state", "CREATE TABLE IF NOT EXISTS sri_pipeline_state (run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), deal_id UUID NOT NULL, current_stage TEXT NOT NULL, stage_status TEXT NOT NULL, invocation_count INT NOT NULL DEFAULT 0, stages_completed TEXT[] NOT NULL DEFAULT '{}', heartbeat_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT sri_pipeline_state_status_chk CHECK (stage_status IN ('pending','running','complete','failed')))"],
["sri_entities", "CREATE TABLE IF NOT EXISTS sri_entities (entity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, entity_type TEXT NOT NULL, legal_name TEXT NOT NULL, role TEXT, source_document_id UUID, verbatim_snippet TEXT NOT NULL, rank_signal JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
["sri_claims", "CREATE TABLE IF NOT EXISTS sri_claims (claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, claim_text TEXT NOT NULL, verbatim_snippet TEXT NOT NULL, claim_type TEXT NOT NULL, metric_value TEXT, thesis_dependence TEXT NOT NULL, document_id UUID, chunk_index INT, locator TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
["sri_research_plan", "CREATE TABLE IF NOT EXISTS sri_research_plan (plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, entity_id UUID REFERENCES sri_entities(entity_id) ON DELETE SET NULL, platform TEXT NOT NULL, execution_rank INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
["sri_evidence", "CREATE TABLE IF NOT EXISTS sri_evidence (evidence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), plan_id UUID NOT NULL REFERENCES sri_research_plan(plan_id) ON DELETE CASCADE, url TEXT NOT NULL, domain TEXT, publisher TEXT, publication_date DATE, source_tier INT, snippet TEXT, retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT sri_evidence_plan_url_uq UNIQUE (plan_id, url))"],
["sri_findings", "CREATE TABLE IF NOT EXISTS sri_findings (finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES sri_pipeline_state(run_id) ON DELETE CASCADE, claim_id UUID REFERENCES sri_claims(claim_id) ON DELETE SET NULL, verdict TEXT NOT NULL, severity TEXT, title TEXT, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"],
];

const INDEXES = [
["sri_entities_run_idx", "CREATE INDEX IF NOT EXISTS sri_entities_run_idx ON sri_entities(run_id)"],
["sri_claims_run_idx", "CREATE INDEX IF NOT EXISTS sri_claims_run_idx ON sri_claims(run_id)"],
["sri_research_plan_run_idx", "CREATE INDEX IF NOT EXISTS sri_research_plan_run_idx ON sri_research_plan(run_id)"],
["sri_evidence_plan_idx", "CREATE INDEX IF NOT EXISTS sri_evidence_plan_idx ON sri_evidence(plan_id)"],
["sri_findings_run_idx", "CREATE INDEX IF NOT EXISTS sri_findings_run_idx ON sri_findings(run_id)"],
["sri_pipeline_state_deal_idx", "CREATE INDEX IF NOT EXISTS sri_pipeline_state_deal_idx ON sri_pipeline_state(deal_id)"],
];

export default api({
  name: "RunMigration042",
  description: "Creates SRI v2 tables",

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
      { label: "Migration042: check existing SRI tables" },
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tablesCreated: string[] = [];
    for (const [name, sql] of DDL) {
      await db.execute(sql, [], { label: "Migration042: create " + name });
      if (!tablesAlreadyPresent.includes(name)) tablesCreated.push(name);
    }

    const indexesCreated: string[] = [];
    for (const [name, sql] of INDEXES) {
      await db.execute(sql, [], { label: "Migration042: index " + name });
      if (tablesCreated.length > 0) indexesCreated.push(name);
    }

    return {
      success: true,
      message: "SRI v2 migration complete. " + String(tablesCreated.length) + " table(s) created, " + String(tablesAlreadyPresent.length) + " already present.",
      tablesAlreadyPresent,
      tablesCreated,
      indexesCreated,
    };
  },
});
