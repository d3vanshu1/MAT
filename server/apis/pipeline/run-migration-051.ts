import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Migration 051 — Workbook Map Phase 1
 *
 * Creates three tables:
 *   workbooks          — one row per uploaded xlsx, carries role + style tables
 *   workbook_sheets    — one row per sheet, carries merge ranges + cell counts
 *   workbook_cells     — one row per non-empty cell, carries value + formula + style
 *
 * Later-phase columns (row_label, period_*, case_*, unit_*, etc.) are created
 * now as NULLable so we need one migration, not five.
 */
export default api({
  name: "RunMigration051",
  description: "Create workbooks, workbook_sheets, workbook_cells tables",
  integrations: { ic_diligence_db: postgres(IC_DILIGENCE_DB) },
  input: z.object({ dryRun: z.boolean().default(true) }),
  output: z.object({ created: z.array(z.string()), dryRun: z.boolean() }),

  async run(ctx, { dryRun }) {
    const db = ctx.integrations.ic_diligence_db;
    const created: string[] = [];

    if (dryRun) {
      console.log("[Migration051] DRY RUN — would create workbooks, workbook_sheets, workbook_cells");
      return { created: [], dryRun: true };
    }

    // -----------------------------------------------------------------------
    // 1. workbooks
    // -----------------------------------------------------------------------
    await db.execute(
      `CREATE TABLE IF NOT EXISTS workbooks (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        workbook_role   TEXT,            -- buy_side | sell_side
        role_source     TEXT,            -- detected | override
        file_hash       TEXT,
        capture_version INT NOT NULL DEFAULT 1,
        parsed_at       TIMESTAMPTZ DEFAULT now(),
        style_tables    JSONB,           -- cellXfs, fonts, fills, borders, numFmts verbatim
        defined_names   JSONB,           -- named ranges from workbook XML
        load_status     TEXT NOT NULL DEFAULT 'ok',
        load_reason     TEXT,
        UNIQUE (document_id)
      )`,
      [],
      { label: "Migration051: create workbooks table" },
    );
    created.push("workbooks");

    // -----------------------------------------------------------------------
    // 2. workbook_sheets
    // -----------------------------------------------------------------------
    await db.execute(
      `CREATE TABLE IF NOT EXISTS workbook_sheets (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workbook_id           UUID NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
        sheet_name            TEXT NOT NULL,
        sheet_index           INT NOT NULL,
        sheet_state           TEXT NOT NULL DEFAULT 'visible',  -- visible | hidden | veryHidden
        max_row               INT,
        max_col               INT,
        merged_ranges         JSONB,     -- array of {s:{r,c}, e:{r,c}}
        freeze_panes          TEXT,      -- e.g. "A2" or null
        row_properties        JSONB,     -- {rowIdx: {hidden, outlineLevel, height, customFormat, ...}}
        col_properties        JSONB,     -- {colIdx: {hidden, outlineLevel, width, customFormat, ...}}
        cell_count_total      INT NOT NULL DEFAULT 0,
        cell_count_numeric    INT NOT NULL DEFAULT 0,
        cell_count_text       INT NOT NULL DEFAULT 0,
        cell_count_formula    INT NOT NULL DEFAULT 0,
        cell_count_hardcoded  INT NOT NULL DEFAULT 0,
        include_in_matching   BOOLEAN NOT NULL DEFAULT true,
        exclusion_rule        TEXT,      -- rule 1..4 or null
        load_status           TEXT NOT NULL DEFAULT 'ok',
        load_reason           TEXT,
        UNIQUE (workbook_id, sheet_name)
      )`,
      [],
      { label: "Migration051: create workbook_sheets table" },
    );
    created.push("workbook_sheets");

    // -----------------------------------------------------------------------
    // 3. workbook_cells
    // -----------------------------------------------------------------------
    await db.execute(
      `CREATE TABLE IF NOT EXISTS workbook_cells (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workbook_id     UUID NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
        workbook_role   TEXT,            -- denormalised from workbooks
        sheet_name      TEXT NOT NULL,
        cell_ref        TEXT NOT NULL,   -- A1 notation
        row_idx         INT NOT NULL,
        col_idx         INT NOT NULL,
        value_raw       TEXT,            -- exactly as read, never modified
        value_num       NUMERIC,         -- numeric convenience copy
        value_type      TEXT NOT NULL,   -- number | text | date | bool | error | formula_no_cache
        formula         TEXT,
        style_index     INT,             -- OOXML s attribute
        number_format   TEXT,            -- verbatim format string

        -- phase 2: row labels
        row_label       TEXT,
        row_label_path  TEXT,
        -- phase 3: column headers / periods / cases
        col_header_path TEXT,
        period_type     TEXT,
        period_start    TEXT,
        period_end      TEXT,
        period_label    TEXT,
        case_label      TEXT,
        case_key        TEXT,
        -- phase 4: units
        unit_class      TEXT,
        currency        TEXT,
        scale_multiplier NUMERIC,
        decimals        INT,
        -- reason is never null when something is missing
        reason          TEXT
      )`,
      [],
      { label: "Migration051: create workbook_cells table" },
    );
    created.push("workbook_cells");

    // -----------------------------------------------------------------------
    // 4. Indexes
    // -----------------------------------------------------------------------
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_wb_cells_workbook_sheet
       ON workbook_cells (workbook_id, sheet_name)`,
      [],
      { label: "Migration051: index workbook_cells(workbook_id, sheet_name)" },
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_wb_cells_workbook_sheet_row
       ON workbook_cells (workbook_id, sheet_name, row_idx)`,
      [],
      { label: "Migration051: index workbook_cells(workbook_id, sheet_name, row_idx)" },
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_wb_cells_role
       ON workbook_cells (workbook_role)`,
      [],
      { label: "Migration051: index workbook_cells(workbook_role)" },
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_wb_cells_value_type
       ON workbook_cells (value_type)`,
      [],
      { label: "Migration051: index workbook_cells(value_type)" },
    );
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_wb_sheets_workbook
       ON workbook_sheets (workbook_id, sheet_name)`,
      [],
      { label: "Migration051: index workbook_sheets(workbook_id, sheet_name)" },
    );

    console.log(`[Migration051] Created: ${created.join(", ")}`);
    return { created, dryRun: false };
  },
});
