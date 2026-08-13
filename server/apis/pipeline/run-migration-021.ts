/**
 * Migration 021 — Omission Audit (OA) rebuild storage layer.
 *
 * Creates six tables that form the persistence substrate for the redesigned
 * omission_audit module: oa_facts, oa_topics, oa_topic_facts, oa_findings,
 * oa_stage_checkpoints, and oa_chunk_map.
 *
 * This migration is additive only — no existing tables are altered or dropped.
 * All statements are idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration021",
  description: "Creates OA rebuild storage tables: oa_facts, oa_topics, oa_topic_facts, oa_findings, oa_stage_checkpoints, oa_chunk_map.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({
    created: z.boolean(),
    tables: z.array(z.string()),
    indexes: z.array(z.string()),
  }),
  async run(ctx) {
    const tables: string[] = [];
    const indexes: string[] = [];

    // ─── TABLE 1: oa_facts ───────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_facts (
        fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id            UUID NOT NULL,
        claim_id           TEXT NOT NULL,
        document_id        UUID NOT NULL,
        document_name      TEXT NOT NULL,
        document_role      TEXT NOT NULL,
        document_tag       TEXT NOT NULL,
        chunk_index        INT  NOT NULL,
        char_start         INT  NOT NULL,
        char_end           INT  NOT NULL,
        fact_type          TEXT NOT NULL,
        subject_entity     TEXT,
        predicate          TEXT,
        value              TEXT,
        unit               TEXT,
        period             TEXT,
        scope_qualifier    TEXT NOT NULL,
        verbatim_snippet   TEXT,
        adviser_severity   TEXT,
        adviser_disposition TEXT,
        stated_or_derived  TEXT NOT NULL,
        memo_order         INT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT oa_facts_document_role_chk CHECK (document_role IN ('subject','reference')),
        CONSTRAINT oa_facts_stated_or_derived_chk CHECK (stated_or_derived IN ('stated','derived')),
        CONSTRAINT oa_facts_adviser_severity_chk CHECK (adviser_severity IN ('high','medium','low'))
      )`,
      [],
      { label: "Migration021: create oa_facts" }
    );
    tables.push("oa_facts");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_oa_facts_deal_document ON oa_facts (deal_id, document_id)`,
      [],
      { label: "Migration021: index oa_facts deal_document" }
    );
    indexes.push("idx_oa_facts_deal_document");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_oa_facts_deal_predicate ON oa_facts (deal_id, predicate)`,
      [],
      { label: "Migration021: index oa_facts deal_predicate" }
    );
    indexes.push("idx_oa_facts_deal_predicate");

    // ─── TABLE 2: oa_topics ──────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_topics (
        topic_id           TEXT NOT NULL,
        deal_id            UUID NOT NULL,
        run_id             UUID NOT NULL,
        topic_label        TEXT NOT NULL,
        parent_topic_id    TEXT,
        obligation_class   TEXT NOT NULL,
        obligation_basis   TEXT,
        subject_coverage   TEXT,
        coverage_basis     TEXT,
        checklist_version  TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, topic_id),
        CONSTRAINT oa_topics_obligation_class_chk CHECK (obligation_class IN ('required','conditional','optional','not_memo_relevant'))
      )`,
      [],
      { label: "Migration021: create oa_topics" }
    );
    tables.push("oa_topics");

    // ─── TABLE 3: oa_topic_facts ─────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_topic_facts (
        run_id             UUID NOT NULL,
        topic_id           TEXT NOT NULL,
        fact_id            UUID NOT NULL,
        fact_role          TEXT NOT NULL,
        supersession       TEXT,
        CONSTRAINT oa_topic_facts_uniq UNIQUE (run_id, topic_id, fact_id)
      )`,
      [],
      { label: "Migration021: create oa_topic_facts" }
    );
    tables.push("oa_topic_facts");

    await ctx.integrations.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_oa_topic_facts_run_topic ON oa_topic_facts (run_id, topic_id)`,
      [],
      { label: "Migration021: index oa_topic_facts run_topic" }
    );
    indexes.push("idx_oa_topic_facts_run_topic");

    // ─── TABLE 4: oa_findings ────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_findings (
        finding_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id               UUID NOT NULL,
        deal_id              UUID NOT NULL,
        topic_id             TEXT NOT NULL,
        gap_kind             TEXT NOT NULL,
        materiality_tier     INT  NOT NULL,
        materiality_basis    TEXT NOT NULL,
        absence_basis        TEXT,
        retrieval_probe      JSONB,
        subject_evidence     JSONB NOT NULL,
        reference_evidence   JSONB NOT NULL,
        adviser_severity_max TEXT,
        narrative            TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT oa_findings_gap_kind_chk CHECK (gap_kind IN ('not_disclosed','scope_mismatch','unreconciled_divergence','stale_supersession','unquantified')),
        CONSTRAINT oa_findings_materiality_tier_chk CHECK (materiality_tier IN (1,2,3)),
        CONSTRAINT oa_findings_absence_basis_chk CHECK (absence_basis IN ('no_subject_facts_and_probe_null','probe_not_run','scope_narrower_than_reference','superseded_not_carried_forward','qualitative_only_no_quantification'))
      )`,
      [],
      { label: "Migration021: create oa_findings" }
    );
    tables.push("oa_findings");

    // ─── TABLE 5: oa_stage_checkpoints ───────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_stage_checkpoints (
        run_id       UUID NOT NULL,
        stage        TEXT NOT NULL,
        unit_key     TEXT NOT NULL,
        status       TEXT NOT NULL,
        reason       TEXT,
        payload_json JSONB,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT oa_stage_checkpoints_uniq UNIQUE (run_id, stage, unit_key),
        CONSTRAINT oa_stage_checkpoints_status_chk CHECK (status IN ('pending','running','complete','skipped','failed'))
      )`,
      [],
      { label: "Migration021: create oa_stage_checkpoints" }
    );
    tables.push("oa_stage_checkpoints");

    // ─── TABLE 6: oa_chunk_map ───────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS oa_chunk_map (
        deal_id      UUID NOT NULL,
        document_id  UUID NOT NULL,
        chunk_index  INT  NOT NULL,
        char_start   INT  NOT NULL,
        char_end     INT  NOT NULL,
        content_hash TEXT,
        CONSTRAINT oa_chunk_map_uniq UNIQUE (document_id, chunk_index)
      )`,
      [],
      { label: "Migration021: create oa_chunk_map" }
    );
    tables.push("oa_chunk_map");

    return { created: true, tables, indexes };
  },
});
