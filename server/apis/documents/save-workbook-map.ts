import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SheetInputSchema = z.object({
  sheetName: z.string(),
  sheetIndex: z.number(),
  sheetState: z.string(),
  maxRow: z.number(),
  maxCol: z.number(),
  mergedRanges: z.any(),
  freezePanes: z.string().nullable(),
  rowProperties: z.any(),
  colProperties: z.any(),
  cellCountTotal: z.number(),
  cellCountNumeric: z.number(),
  cellCountText: z.number(),
  cellCountFormula: z.number(),
  cellCountHardcoded: z.number(),
  includeInMatching: z.boolean(),
  exclusionRule: z.string().nullable(),
  loadStatus: z.string(),
  loadReason: z.string().nullable(),
});

const CellInputSchema = z.object({
  sheetName: z.string(),
  cellRef: z.string(),
  rowIdx: z.number(),
  colIdx: z.number(),
  valueRaw: z.string().nullable(),
  valueNum: z.number().nullable(),
  valueType: z.string(),
  formula: z.string().nullable(),
  styleIndex: z.number().nullable(),
  numberFormat: z.string().nullable(),
});

const WorkbookInputSchema = z.object({
  documentId: z.string().uuid(),
  workbookRole: z.string(),
  roleSource: z.string(),
  fileHash: z.string(),
  captureVersion: z.number(),
  styleTables: z.any(),
  definedNames: z.any(),
  loadStatus: z.string(),
  loadReason: z.string().nullable(),
});

const WorkbookIdSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "SaveWorkbookMap",
  description: "Persists workbook map data (workbooks + sheets + cells)",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    workbook: WorkbookInputSchema,
    sheets: z.array(SheetInputSchema),
    cells: z.array(CellInputSchema),
  }),

  output: z.object({
    workbookId: z.string(),
    sheetsInserted: z.number(),
    cellsInserted: z.number(),
    skippedByHash: z.boolean(),
  }),

  async run(ctx, { workbook, sheets, cells }) {
    const db = ctx.integrations.ic_diligence_db;

    // -----------------------------------------------------------------------
    // Hash check — skip if unchanged
    // -----------------------------------------------------------------------
    const existingRows = await db.query(
      `SELECT id FROM workbooks WHERE document_id = $1 AND file_hash = $2`,
      WorkbookIdSchema,
      [workbook.documentId, workbook.fileHash],
      { label: "SaveWorkbookMap: hash check" },
    );

    if (existingRows.length > 0) {
      console.log(`[SaveWorkbookMap] Hash match for ${workbook.documentId} — skipping re-parse`);
      return {
        workbookId: existingRows[0].id,
        sheetsInserted: 0,
        cellsInserted: 0,
        skippedByHash: true,
      };
    }

    // -----------------------------------------------------------------------
    // Delete any existing workbook for this document (cascade deletes sheets + cells)
    // -----------------------------------------------------------------------
    await db.execute(
      `DELETE FROM workbooks WHERE document_id = $1`,
      [workbook.documentId],
      { label: "SaveWorkbookMap: clear previous workbook" },
    );

    // -----------------------------------------------------------------------
    // Insert workbook
    // -----------------------------------------------------------------------
    const wbRows = await db.query(
      `INSERT INTO workbooks (document_id, workbook_role, role_source, file_hash,
         capture_version, style_tables, defined_names, load_status, load_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      WorkbookIdSchema,
      [
        workbook.documentId,
        workbook.workbookRole,
        workbook.roleSource,
        workbook.fileHash,
        workbook.captureVersion,
        JSON.stringify(workbook.styleTables),
        JSON.stringify(workbook.definedNames),
        workbook.loadStatus,
        workbook.loadReason,
      ],
      { label: "SaveWorkbookMap: insert workbook" },
    );

    const workbookId = wbRows[0].id;

    // -----------------------------------------------------------------------
    // Insert sheets
    // -----------------------------------------------------------------------
    for (const sheet of sheets) {
      await db.execute(
        `INSERT INTO workbook_sheets (
           workbook_id, sheet_name, sheet_index, sheet_state,
           max_row, max_col, merged_ranges, freeze_panes,
           row_properties, col_properties,
           cell_count_total, cell_count_numeric, cell_count_text,
           cell_count_formula, cell_count_hardcoded,
           include_in_matching, exclusion_rule,
           load_status, load_reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19
         )`,
        [
          workbookId,
          sheet.sheetName,
          sheet.sheetIndex,
          sheet.sheetState,
          sheet.maxRow,
          sheet.maxCol,
          JSON.stringify(sheet.mergedRanges),
          sheet.freezePanes,
          JSON.stringify(sheet.rowProperties),
          JSON.stringify(sheet.colProperties),
          sheet.cellCountTotal,
          sheet.cellCountNumeric,
          sheet.cellCountText,
          sheet.cellCountFormula,
          sheet.cellCountHardcoded,
          sheet.includeInMatching,
          sheet.exclusionRule,
          sheet.loadStatus,
          sheet.loadReason,
        ],
        { label: `SaveWorkbookMap: insert sheet ${sheet.sheetName}` },
      );
    }

    // -----------------------------------------------------------------------
    // Insert cells in batches
    // -----------------------------------------------------------------------
    const BATCH_SIZE = 200;
    let cellsInserted = 0;

    for (let i = 0; i < cells.length; i += BATCH_SIZE) {
      const batch = cells.slice(i, i + BATCH_SIZE);

      // Build multi-row INSERT for performance
      const valueClauses: string[] = [];
      const params: unknown[] = [workbookId, workbook.workbookRole];
      let paramIdx = 3;

      for (const cell of batch) {
        valueClauses.push(
          `($1, $2, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3},` +
          ` $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7},` +
          ` $${paramIdx + 8}, $${paramIdx + 9})`
        );
        params.push(
          cell.sheetName,
          cell.cellRef,
          cell.rowIdx,
          cell.colIdx,
          cell.valueRaw,
          cell.valueNum,
          cell.valueType,
          cell.formula,
          cell.styleIndex,
          cell.numberFormat,
        );
        paramIdx += 10;
      }

      await db.execute(
        `INSERT INTO workbook_cells (
           workbook_id, workbook_role, sheet_name, cell_ref,
           row_idx, col_idx, value_raw, value_num, value_type,
           formula, style_index, number_format
         ) VALUES ${valueClauses.join(", ")}`,
        params,
        { label: `SaveWorkbookMap: cells batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(cells.length / BATCH_SIZE)}` },
      );
      cellsInserted += batch.length;
    }

    console.log(
      `[SaveWorkbookMap] Saved: workbook ${workbookId}, ` +
      `${sheets.length} sheets, ${cellsInserted} cells, ` +
      `role=${workbook.workbookRole} (${workbook.roleSource}), ` +
      `status=${workbook.loadStatus}`
    );

    return {
      workbookId,
      sheetsInserted: sheets.length,
      cellsInserted,
      skippedByHash: false,
    };
  },
});
