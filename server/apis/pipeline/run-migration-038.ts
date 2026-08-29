/**
 * Migration 038 — DCS (Diligence Completeness Score) rebuild tables.
 *
 * Creates four tables for the extract→verdicts→render pipeline:
 *   1. dcs_evidence          — extracted evidence snippets per dimension/chunk.
 *   2. dcs_dimension_verdicts — per-dimension verdict (absent/asserted/evidenced).
 *   3. dcs_run_summary       — headline score + coverage basis per run.
 *   4. dcs_pipeline_state    — stage-level orchestration checkpoint.
 *
 * All FK to module_runs(id) ON DELETE CASCADE.
 * Additive only. Idempotent (IF NOT EXISTS).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration038",
  description: "Creates DCS rebuild tables (evidence, verdicts, summary, pipeline state)",

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
      "dcs_evidence",
      "dcs_dimension_verdicts",
      "dcs_run_summary",
      "dcs_pipeline_state",
    ];

    // ── Pre-existence check ───────────────────────────────────────
    const preExisting = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration038: check existing DCS tables" },
    );
    const tablesAlreadyPresent = preExisting.map((r) => r.table_name);

    const tables: string[] = [];
    const indexes: string[] = [];

    // ── TABLE 1: dcs_evidence ─────────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS dcs_evidence (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id          UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        dimension_id    TEXT        NOT NULL,
        chunk_id        TEXT        NOT NULL,
        source_file     TEXT        NOT NULL,
        document_tag    TEXT        NOT NULL,
        doc_class       TEXT        NOT NULL CHECK (doc_class IN ('narrative','workproduct')),
        is_substantive  BOOLEAN     NOT NULL,
        snippet         TEXT        NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration038: create dcs_evidence" },
    );
    tables.push("dcs_evidence");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS dcs_evidence_run_dim_idx
        ON dcs_evidence (run_id, dimension_id)`,
      [],
      { label: "Migration038: index dcs_evidence (run_id, dimension_id)" },
    );
    indexes.push("dcs_evidence_run_dim_idx");

    await db.execute(
      `CREATE INDEX IF NOT EXISTS dcs_evidence_run_chunk_idx
        ON dcs_evidence (run_id, chunk_id)`,
      [],
      { label: "Migration038: index dcs_evidence (run_id, chunk_id)" },
    );
    indexes.push("dcs_evidence_run_chunk_idx");

    // ── TABLE 2: dcs_dimension_verdicts ───────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS dcs_dimension_verdicts (
        id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        dimension_id          TEXT        NOT NULL,
        state                 TEXT        NOT NULL CHECK (state IN ('absent','asserted','evidenced')),
        score_value           NUMERIC     NOT NULL CHECK (score_value IN (0, 0.5, 1.0)),
        promoting_chunk_id    TEXT,
        promoting_source_file TEXT,
        evidence_count        INT         NOT NULL DEFAULT 0,
        rationale             TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, dimension_id)
      )`,
      [],
      { label: "Migration038: create dcs_dimension_verdicts" },
    );
    tables.push("dcs_dimension_verdicts");

    // ── TABLE 3: dcs_run_summary ──────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS dcs_run_summary (
        run_id            UUID        PRIMARY KEY REFERENCES module_runs(id) ON DELETE CASCADE,
        headline_score    NUMERIC     NOT NULL,
        evidenced_count   INT         NOT NULL,
        asserted_count    INT         NOT NULL,
        absent_count      INT         NOT NULL,
        dimension_count   INT         NOT NULL DEFAULT 10,
        coverage_basis    JSONB       NOT NULL,
        materiality_overlay TEXT,
        computed_in_code  BOOLEAN     NOT NULL DEFAULT true,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration038: create dcs_run_summary" },
    );
    tables.push("dcs_run_summary");

    // ── TABLE 4: dcs_pipeline_state ───────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS dcs_pipeline_state (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id        UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
        stage         TEXT        NOT NULL CHECK (stage IN ('extract','verdicts','render')),
        status        TEXT        NOT NULL CHECK (status IN ('pending','running','done','failed')),
        detail        TEXT,
        cursor_value  TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, stage)
      )`,
      [],
      { label: "Migration038: create dcs_pipeline_state" },
    );
    tables.push("dcs_pipeline_state");

    // ── Post-existence verification ───────────────────────────────
    const postCheck = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      z.object({ table_name: z.string() }),
      [TARGET_TABLES],
      { label: "Migration038: verify DCS tables exist" },
    );

    const created = postCheck.map((r) => r.table_name);
    const missing = TARGET_TABLES.filter((t) => !created.includes(t));

    if (missing.length > 0) {
      return {
        success: false,
        message: `Migration 038 failed: missing tables after creation: ${missing.join(", ")}`,
        tables,
        indexes,
        tablesAlreadyPresent,
      };
    }

    return {
      success: true,
      message: `Migration 038 complete. ${tables.length} tables, ${indexes.length} indexes. Pre-existing: ${tablesAlreadyPresent.length > 0 ? tablesAlreadyPresent.join(", ") : "none"}.`,
      tables,
      indexes,
      tablesAlreadyPresent,
    };
  },
});
