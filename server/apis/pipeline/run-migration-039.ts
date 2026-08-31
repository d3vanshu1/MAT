/**
 * Migration 039 — MAST v2 (Model Assumptions Stress Test) tables.
 *
 * Creates six tables:
 *   1. mast_assumptions      — extracted / inferred model assumptions.
 *   2. mast_reliance_links   — cross-document numeric / label linkages.
 *   3. mast_lineage          — hop-by-hop lineage chain per assumption.
 *   4. mast_support_evidence — supporting evidence per assumption.
 *   5. mast_findings         — stress-test findings per assumption.
 *   6. mast_pipeline_state   — stage-level orchestration checkpoint.
 *
 * All FK to module_runs(id) ON DELETE CASCADE.
 * Additive only. Idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration039",
  description: "Creates MAST v2 tables",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tables: z.array(z.string()),
    indexes: z.array(z.string()),
    tablesAlreadyPresent: z.array(z.string()),
  }),

  async run(ctx) {
    const db = ctx.integrations.ic_diligence_db;

    const TARGET_TABLES = [
      "mast_assumptions",
      "mast_reliance_links",
      "mast_lineage",
      "mast_support_evidence",
      "mast_findings",
      "mast_pipeline_state",
    ];

    // ── Pre-existence check ───────────────────────────────────────
    const preExisting = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration039: check existing MAST tables" },
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tables: string[] = [];
    const indexes: string[] = [];

    // ── TABLE 1: mast_assumptions ─────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_assumptions (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        deal_id               UUID        NOT NULL,
        proposition           TEXT        NOT NULL,
        origin_type           TEXT        NOT NULL,
        origin_doc_id         UUID        NULL,
        origin_locator        TEXT        NULL,
        verbatim              TEXT        NULL,
        quantified            BOOLEAN     NOT NULL DEFAULT false,
        value                 NUMERIC     NULL,
        unit                  TEXT        NULL,
        period                TEXT        NULL,
        detector              TEXT        NULL,
        reliance_link_id      UUID        NULL,
        recursion_depth       INTEGER     NOT NULL DEFAULT 0,
        dedup_group_id        UUID        NULL,
        support_verdict       TEXT        NULL,
        dependence_tier       TEXT        NULL,
        dependence_basis      TEXT        NULL,
        dependence_share      NUMERIC     NULL,
        lineage_drift_axes    TEXT        NULL,
        lineage_drift_summary TEXT        NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration039: create mast_assumptions" },
    );
    tables.push("mast_assumptions");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_assumptions_run_idx
        ON mast_assumptions (run_id)`,
      [],
      { label: "Migration039: index mast_assumptions (run_id)" },
    );
    indexes.push("mast_assumptions_run_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_assumptions_run_origin_idx
        ON mast_assumptions (run_id, origin_type)`,
      [],
      { label: "Migration039: index mast_assumptions (run_id, origin_type)" },
    );
    indexes.push("mast_assumptions_run_origin_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_assumptions_deal_idx
        ON mast_assumptions (deal_id)`,
      [],
      { label: "Migration039: index mast_assumptions (deal_id)" },
    );
    indexes.push("mast_assumptions_deal_idx");

    // ── TABLE 2: mast_reliance_links ──────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_reliance_links (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        deal_id         UUID        NOT NULL,
        from_doc_id     UUID        NOT NULL,
        from_locator    TEXT        NULL,
        from_label      TEXT        NULL,
        from_value      NUMERIC     NULL,
        to_doc_id       UUID        NOT NULL,
        to_locator      TEXT        NULL,
        to_label        TEXT        NULL,
        to_value        NUMERIC     NULL,
        match_method    TEXT        NOT NULL,
        match_tolerance NUMERIC     NULL,
        notes           TEXT        NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration039: create mast_reliance_links" },
    );
    tables.push("mast_reliance_links");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_reliance_links_run_idx
        ON mast_reliance_links (run_id)`,
      [],
      { label: "Migration039: index mast_reliance_links (run_id)" },
    );
    indexes.push("mast_reliance_links_run_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_reliance_links_run_from_idx
        ON mast_reliance_links (run_id, from_doc_id)`,
      [],
      { label: "Migration039: index mast_reliance_links (run_id, from_doc_id)" },
    );
    indexes.push("mast_reliance_links_run_from_idx");

    // ── TABLE 3: mast_lineage ─────────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_lineage (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        assumption_id   UUID        NOT NULL REFERENCES mast_assumptions(id) ON DELETE CASCADE,
        hop_index       INTEGER     NOT NULL,
        doc_id          UUID        NULL,
        locator         TEXT        NULL,
        doc_date        DATE        NULL,
        value           NUMERIC     NULL,
        scope           TEXT        NULL,
        caveats         TEXT        NULL,
        verbatim        TEXT        NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (assumption_id, hop_index)
      )`,
      [],
      { label: "Migration039: create mast_lineage" },
    );
    tables.push("mast_lineage");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_lineage_run_idx
        ON mast_lineage (run_id)`,
      [],
      { label: "Migration039: index mast_lineage (run_id)" },
    );
    indexes.push("mast_lineage_run_idx");

    // ── TABLE 4: mast_support_evidence ────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_support_evidence (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        assumption_id         UUID        NOT NULL REFERENCES mast_assumptions(id) ON DELETE CASCADE,
        doc_id                UUID        NULL,
        locator               TEXT        NULL,
        verbatim              TEXT        NOT NULL,
        statement_type        TEXT        NOT NULL,
        classifier_reason     TEXT        NULL,
        spawned_assumption_id UUID        NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration039: create mast_support_evidence" },
    );
    tables.push("mast_support_evidence");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_support_evidence_run_idx
        ON mast_support_evidence (run_id)`,
      [],
      { label: "Migration039: index mast_support_evidence (run_id)" },
    );
    indexes.push("mast_support_evidence_run_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_support_evidence_assumption_idx
        ON mast_support_evidence (assumption_id)`,
      [],
      { label: "Migration039: index mast_support_evidence (assumption_id)" },
    );
    indexes.push("mast_support_evidence_assumption_idx");

    // ── TABLE 5: mast_findings ────────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_findings (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        deal_id               UUID        NOT NULL,
        assumption_id         UUID        NOT NULL REFERENCES mast_assumptions(id) ON DELETE CASCADE,
        title                 TEXT        NOT NULL,
        severity              TEXT        NOT NULL,
        severity_basis        TEXT        NOT NULL,
        falsification_condition TEXT      NULL,
        monitoring_trigger    TEXT        NULL,
        fragility_generated   BOOLEAN     NOT NULL DEFAULT false,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration039: create mast_findings" },
    );
    tables.push("mast_findings");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_findings_run_idx
        ON mast_findings (run_id)`,
      [],
      { label: "Migration039: index mast_findings (run_id)" },
    );
    indexes.push("mast_findings_run_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_findings_run_severity_idx
        ON mast_findings (run_id, severity)`,
      [],
      { label: "Migration039: index mast_findings (run_id, severity)" },
    );
    indexes.push("mast_findings_run_severity_idx");

    // ── TABLE 6: mast_pipeline_state ──────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS mast_pipeline_state (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        deal_id         UUID        NOT NULL,
        stage           TEXT        NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'pending',
        resume_position INTEGER     NOT NULL DEFAULT 0,
        payload         JSONB       NULL,
        error_text      TEXT        NULL,
        started_at      TIMESTAMPTZ NULL,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, stage)
      )`,
      [],
      { label: "Migration039: create mast_pipeline_state" },
    );
    tables.push("mast_pipeline_state");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS mast_pipeline_state_run_idx
        ON mast_pipeline_state (run_id)`,
      [],
      { label: "Migration039: index mast_pipeline_state (run_id)" },
    );
    indexes.push("mast_pipeline_state_run_idx");

    // ── Post-existence verification ───────────────────────────────
    const postCheck = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration039: verify MAST tables exist" },
    );

    const created = postCheck.map((r) => r.table_name);
    const missing = TARGET_TABLES.filter((t) => !created.includes(t));

    if (missing.length > 0) {
      return {
        success: false,
        message: `Migration 039 failed: missing tables after creation: ${missing.join(", ")}`,
        tables,
        indexes,
        tablesAlreadyPresent,
      };
    }

    return {
      success: true,
      message: `Migration 039 complete. ${tables.length} tables, ${indexes.length} indexes. Pre-existing: ${tablesAlreadyPresent.length > 0 ? tablesAlreadyPresent.join(", ") : "none"}.`,
      tables,
      indexes,
      tablesAlreadyPresent,
    };
  },
});
