import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SaveWorkbookSheet",
  description: "Inserts a single workbook sheet record.",
  integrations: {
    ic_diligence: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
    sheet: z.object({
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
    }),
  }),
  output: z.object({ inserted: z.boolean() }),
  async run(ctx, { workbookId, sheet }) {
    const db = ctx.integrations.ic_diligence;
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
      { label: `SaveWorkbookSheet: ${sheet.sheetName}` },
    );
    return { inserted: true };
  },
});
