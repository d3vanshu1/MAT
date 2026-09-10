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
// API — workbook + sheets only (no cells — those go via SaveWorkbookCellsBatch)
// ---------------------------------------------------------------------------

export default api({
  name: "SaveWorkbookMap",
  description: "Creates workbook + sheet records; cells saved separately via SaveWorkbookCellsBatch",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    workbook: WorkbookInputSchema,
    sheets: z.array(SheetInputSchema),
  }),

  output: z.object({
    workbookId: z.string(),
    sheetsInserted: z.number(),
    skippedByHash: z.boolean(),
  }),

  async run(ctx, { workbook, sheets }) {
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

    console.log(
      `[SaveWorkbookMap] Saved: workbook ${workbookId}, ` +
      `${sheets.length} sheets, role=${workbook.workbookRole} (${workbook.roleSource}), ` +
      `status=${workbook.loadStatus}`
    );

    return {
      workbookId,
      sheetsInserted: sheets.length,
      skippedByHash: false,
    };
  },
});
