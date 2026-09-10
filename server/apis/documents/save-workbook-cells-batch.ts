import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

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

/**
 * Saves a batch of workbook cells for an existing workbook.
 * Called in chunks by the client to stay under the gRPC payload limit.
 * Typically ~5000 cells per call (~10-15 MB serialized).
 */
export default api({
  name: "SaveWorkbookCellsBatch",
  description: "Inserts a batch of workbook cells for an existing workbook",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    workbookId: z.string().uuid(),
    workbookRole: z.string(),
    cells: z.array(CellInputSchema),
  }),

  output: z.object({
    cellsInserted: z.number(),
  }),

  async run(ctx, { workbookId, workbookRole, cells }) {
    const db = ctx.integrations.ic_diligence_db;

    if (cells.length === 0) return { cellsInserted: 0 };

    // Insert in sub-batches of 200 for SQL param limits
    const BATCH_SIZE = 200;
    let cellsInserted = 0;

    for (let i = 0; i < cells.length; i += BATCH_SIZE) {
      const batch = cells.slice(i, i + BATCH_SIZE);

      const valueClauses: string[] = [];
      const params: unknown[] = [workbookId, workbookRole];
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
        { label: `SaveCellsBatch: ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(cells.length / BATCH_SIZE)}` },
      );
      cellsInserted += batch.length;
    }

    return { cellsInserted };
  },
});
