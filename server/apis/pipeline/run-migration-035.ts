/**
 * Migration 035 — ERO v2 schema.
 *
 * Creates seven additive tables for the External Risk Overlay module:
 *
 *   1. ero_pipeline_state  — run root / orchestrator checkpoint.
 *   2. ero_entities         — extracted counterparties and principals.
 *   3. ero_profile          — structured deal profile (business shape + thesis deps).
 *   4. ero_hypotheses       — generated risk hypotheses with execution rank.
 *   5. ero_evidence         — web research evidence per hypothesis.
 *   6. ero_findings         — adjudicated findings with severity.
 *   7. ero_corpus_checks    — corpus cross-reference per finding.
 *
 * Design constraints:
 *
 *   - No severity, tier, priority, or score column on ero_hypotheses or
 *     ero_entities. Severity lives only on ero_findings and is set by code
 *     in Phase 4, never by the model directly. Same discipline as BSS.
 *
 *   - Every FK points only at tables created in this migration. Zero FK to
 *     deals, documents, module_runs, module_outputs, universal_extractions.
 *     source_document_id and best_hit_document_id are plain UUID columns,
 *     not FKs — they reference documents we do not own.
 *
 *   - entity_id on ero_hypotheses is ON DELETE SET NULL because a non-entity
 *     hypothesis (macro, regulatory regime) legitimately has none.
 *
 *   - No ALTER of any table we do not own.
 *
 * This migration is additive only — no existing table is altered or dropped.
 * All statements are idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration035",
  description: "Creates ERO v2 tables",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tables: z.array(z.string()),
    indexes: z.array(z.string()),
    objectCount: z.number(),
    tablesAlreadyPresent: z.array(z.string()),
  }),

  async run(ctx) {
    const TARGET_TABLES = [
      "ero_pipeline_state",
      "ero_entities",
      "ero_profile",
      "ero_hypotheses",
      "ero_evidence",
      "ero_findings",
      "ero_corpus_checks",
    ];

    // ── Pre-existence check ───────────────────────────────────────────
    const preExisting = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration035: check which ERO v2 tables already exist" },
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tables: string[] = [];
    const indexes: string[] = [];

    // ─── TABLE 1: ero_pipeline_state ──────────────────────────────────
    // The run root. All other ERO tables FK here via run_id.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_pipeline_state (
        run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id         UUID NOT NULL,
        current_stage   TEXT NOT NULL,
        stage_status    TEXT NOT NULL,
        invocation_count INT NOT NULL DEFAULT 0,
        heartbeat_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_pipeline_state_status_chk
          CHECK (stage_status IN ('pending', 'running', 'complete', 'failed'))
      )`,
      [],
      { label: "Migration035: create ero_pipeline_state" },
    );
    tables.push("ero_pipeline_state");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_pipeline_state_deal
         ON ero_pipeline_state (deal_id)`,
      [],
      { label: "Migration035: index ero_pipeline_state deal" },
    );
    indexes.push("idx_ero_pipeline_state_deal");

    // ─── TABLE 2: ero_entities ────────────────────────────────────────
    // Extracted counterparties, principals, subsidiaries.
    // source_document_id is a plain UUID, not a FK — we do not own documents.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_entities (
        entity_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id              UUID NOT NULL REFERENCES ero_pipeline_state (run_id) ON DELETE CASCADE,
        entity_type         TEXT NOT NULL,
        legal_name          TEXT NOT NULL,
        registration_number TEXT,
        jurisdiction        TEXT,
        role                TEXT,
        source_document_id  UUID NOT NULL,
        verbatim_snippet    TEXT NOT NULL,
        rank_signal         JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration035: create ero_entities" },
    );
    tables.push("ero_entities");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_entities_run
         ON ero_entities (run_id)`,
      [],
      { label: "Migration035: index ero_entities run" },
    );
    indexes.push("idx_ero_entities_run");

    // ─── TABLE 3: ero_profile ─────────────────────────────────────────
    // Structured deal profile: business shape and thesis dependencies.
    // source_document_id is a plain UUID, not a FK.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_profile (
        profile_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id              UUID NOT NULL REFERENCES ero_pipeline_state (run_id) ON DELETE CASCADE,
        field_group         TEXT NOT NULL,
        field_name          TEXT NOT NULL,
        field_value         TEXT NOT NULL,
        source_document_id  UUID NOT NULL,
        verbatim_snippet    TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_profile_field_group_chk
          CHECK (field_group IN ('business_shape', 'thesis_dependency')),
        CONSTRAINT ero_profile_run_field_uniq
          UNIQUE (run_id, field_name)
      )`,
      [],
      { label: "Migration035: create ero_profile" },
    );
    tables.push("ero_profile");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_profile_run
         ON ero_profile (run_id)`,
      [],
      { label: "Migration035: index ero_profile run" },
    );
    indexes.push("idx_ero_profile_run");

    // ─── TABLE 4: ero_hypotheses ──────────────────────────────────────
    // Generated risk hypotheses with execution rank.
    // entity_id is ON DELETE SET NULL — non-entity hypotheses (macro,
    // regulatory regime) legitimately have none.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_hypotheses (
        hypothesis_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id              UUID NOT NULL REFERENCES ero_pipeline_state (run_id) ON DELETE CASCADE,
        family              TEXT NOT NULL,
        entity_id           UUID REFERENCES ero_entities (entity_id) ON DELETE SET NULL,
        thesis_link         TEXT,
        question            TEXT NOT NULL,
        confirming_evidence TEXT NOT NULL,
        refuting_evidence   TEXT NOT NULL,
        execution_rank      INT  NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        round               INT  NOT NULL DEFAULT 1,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_hypotheses_status_chk
          CHECK (status IN ('pending', 'researched', 'no_evidence_found', 'error')),
        CONSTRAINT ero_hypotheses_run_rank_uniq
          UNIQUE (run_id, execution_rank)
      )`,
      [],
      { label: "Migration035: create ero_hypotheses" },
    );
    tables.push("ero_hypotheses");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_hypotheses_run_status
         ON ero_hypotheses (run_id, status)`,
      [],
      { label: "Migration035: index ero_hypotheses run_status" },
    );
    indexes.push("idx_ero_hypotheses_run_status");

    // ─── TABLE 5: ero_evidence ────────────────────────────────────────
    // Web research evidence per hypothesis.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_evidence (
        evidence_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hypothesis_id     UUID NOT NULL REFERENCES ero_hypotheses (hypothesis_id) ON DELETE CASCADE,
        url               TEXT NOT NULL,
        domain            TEXT,
        publisher         TEXT,
        publication_date  DATE,
        source_tier       INT  NOT NULL,
        verbatim_snippet  TEXT NOT NULL,
        retrieved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_evidence_tier_chk
          CHECK (source_tier IN (1, 2, 3)),
        CONSTRAINT ero_evidence_hyp_url_uniq
          UNIQUE (hypothesis_id, url)
      )`,
      [],
      { label: "Migration035: create ero_evidence" },
    );
    tables.push("ero_evidence");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_evidence_hypothesis
         ON ero_evidence (hypothesis_id)`,
      [],
      { label: "Migration035: index ero_evidence hypothesis" },
    );
    indexes.push("idx_ero_evidence_hypothesis");

    // ─── TABLE 6: ero_findings ────────────────────────────────────────
    // Adjudicated findings with severity. Severity is assigned by code
    // in Phase 4, never by the model directly.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_findings (
        finding_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hypothesis_id         UUID NOT NULL REFERENCES ero_hypotheses (hypothesis_id) ON DELETE CASCADE,
        verdict               TEXT NOT NULL,
        severity              TEXT NOT NULL,
        ceiling_reason        TEXT NOT NULL,
        title                 TEXT NOT NULL,
        detail                TEXT NOT NULL,
        materiality_rationale TEXT NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_findings_verdict_chk
          CHECK (verdict IN ('confirmed', 'refuted')),
        CONSTRAINT ero_findings_severity_chk
          CHECK (severity IN ('critical', 'warning', 'info'))
      )`,
      [],
      { label: "Migration035: create ero_findings" },
    );
    tables.push("ero_findings");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_findings_hypothesis
         ON ero_findings (hypothesis_id)`,
      [],
      { label: "Migration035: index ero_findings hypothesis" },
    );
    indexes.push("idx_ero_findings_hypothesis");

    // ─── TABLE 7: ero_corpus_checks ───────────────────────────────────
    // Corpus cross-reference per finding. best_hit_document_id is a plain
    // UUID, not a FK — it references documents we do not own.
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS ero_corpus_checks (
        check_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        finding_id            UUID NOT NULL REFERENCES ero_findings (finding_id) ON DELETE CASCADE,
        query_text            TEXT NOT NULL,
        hit_count             INT  NOT NULL,
        best_hit_snippet      TEXT,
        best_hit_document_id  UUID,
        classification        TEXT,
        checked_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ero_corpus_checks_class_chk
          CHECK (classification IS NULL OR classification IN (
            'unknown_to_deal_team',
            'known_and_assessed',
            'known_but_understated'
          ))
      )`,
      [],
      { label: "Migration035: create ero_corpus_checks" },
    );
    tables.push("ero_corpus_checks");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_ero_corpus_checks_finding
         ON ero_corpus_checks (finding_id)`,
      [],
      { label: "Migration035: index ero_corpus_checks finding" },
    );
    indexes.push("idx_ero_corpus_checks_finding");

    // ── Result ────────────────────────────────────────────────────────
    const objectCount = tables.length + indexes.length;

    return {
      success: true,
      message:
        tablesAlreadyPresent.length === TARGET_TABLES.length
          ? `All ${TARGET_TABLES.length} ERO v2 tables already existed — migration re-ran idempotently, no schema change.`
          : `Migration 035 applied. Tables ensured: ${tables.join(", ")}. Indexes ensured: ${indexes.join(", ")}.` +
            (tablesAlreadyPresent.length > 0
              ? ` Already present before this run: ${tablesAlreadyPresent.join(", ")}.`
              : " No ERO v2 tables existed before this run."),
      tables,
      indexes,
      objectCount,
      tablesAlreadyPresent,
    };
  },
});
