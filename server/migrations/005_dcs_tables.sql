-- Migration 005: DCS (Diligence Completeness Score) rebuild tables.
-- Four tables for the extract→verdicts→render pipeline.
-- All FK to module_runs(id) ON DELETE CASCADE.
-- Idempotent: uses IF NOT EXISTS throughout.

-- ══════════════════════════════════════════════════════════════════
-- 1. dcs_evidence
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dcs_evidence (
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
);

CREATE INDEX IF NOT EXISTS dcs_evidence_run_dim_idx
  ON dcs_evidence (run_id, dimension_id);

CREATE INDEX IF NOT EXISTS dcs_evidence_run_chunk_idx
  ON dcs_evidence (run_id, chunk_id);

-- ══════════════════════════════════════════════════════════════════
-- 2. dcs_dimension_verdicts
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dcs_dimension_verdicts (
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
);

-- ══════════════════════════════════════════════════════════════════
-- 3. dcs_run_summary
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dcs_run_summary (
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
);

-- ══════════════════════════════════════════════════════════════════
-- 4. dcs_pipeline_state
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dcs_pipeline_state (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID        NOT NULL REFERENCES module_runs(id) ON DELETE CASCADE,
  stage         TEXT        NOT NULL CHECK (stage IN ('extract','verdicts','render')),
  status        TEXT        NOT NULL CHECK (status IN ('pending','running','done','failed')),
  detail        TEXT,
  cursor_value  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, stage)
);
