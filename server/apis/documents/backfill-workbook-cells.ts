import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Backfills missing workbook_cells from doc_tables data.
 * Recovers from partial cell saves without requiring re-upload.
 * Style indices and number formats will be null (those require the xlsx binary).
 */
export default api({
  name: "BackfillWorkbookCells",
  description: "Recovers missing workbook cells from doc_tables.",
  integrations: {
    ic_diligence_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
  }),
  output: z.object({
    sheetsProcessed: z.number(),
    cellsInserted: z.number(),
    cellsSkipped: z.number(),
    errors: z.array(z.string()),
  }),
  async run(ctx, { workbookId }) {
    const db = ctx.integrations.ic_diligence_db;

    // Get workbook info
    const wbRows = await db.query(
      `SELECT w.document_id, w.workbook_role FROM workbooks w WHERE w.id = $1`,
      z.object({ document_id: z.string(), workbook_role: z.string() }),
      [workbookId],
      { label: "BackfillWorkbookCells: get workbook" },
    );
    if (wbRows.length === 0) throw new Error("Workbook not found: " + workbookId);
    const { document_id, workbook_role } = wbRows[0];

    // Get existing cell addresses to avoid duplicates
    const existingCells = await db.query(
      `SELECT sheet_name || ':' || cell_ref AS key FROM workbook_cells WHERE workbook_id = $1`,
      z.object({ key: z.string() }),
      [workbookId],
      { label: "BackfillWorkbookCells: get existing keys" },
    );
    const existingKeys = new Set(existingCells.map((r) => r.key));

    // Get doc_table IDs (not data — data can exceed 4MB gRPC limit)
    const docTableIds = await db.query(
      `SELECT id, sheet_or_page FROM doc_tables WHERE document_id = $1`,
      z.object({ id: z.string(), sheet_or_page: z.string() }),
      [document_id],
      { label: "BackfillWorkbookCells: list doc_tables" },
    );

    let sheetsProcessed = 0;
    let cellsInserted = 0;
    let cellsSkipped = 0;
    const errors: string[] = [];

    // Column index to A1 notation
    function colToLetter(col: number): string {
      let result = "";
      let c = col;
      while (c >= 0) {
        result = String.fromCharCode(65 + (c % 26)) + result;
        c = Math.floor(c / 26) - 1;
      }
      return result;
    }

    for (const tableRef of docTableIds) {
      const sheetName = tableRef.sheet_or_page;

      // Fetch one sheet's data at a time (stays under 4MB gRPC limit)
      const tableRows = await db.query(
        `SELECT data FROM doc_tables WHERE id = $1`,
        z.object({ data: z.any() }),
        [tableRef.id],
        { label: `BackfillWorkbookCells: fetch ${sheetName}` },
      );
      if (tableRows.length === 0) continue;
      const cells = tableRows[0].data?.cells;
      if (!Array.isArray(cells)) {
        errors.push(`${sheetName}: no cells array`);
        continue;
      }

      sheetsProcessed++;
      const newCells: Array<{
        sheetName: string;
        cellRef: string;
        rowIdx: number;
        colIdx: number;
        valueRaw: string | null;
        valueNum: number | null;
        valueType: string;
        formula: string | null;
      }> = [];

      for (const cell of cells) {
        const r = cell.r ?? cell.absR ?? 0;
        const c = cell.c ?? cell.absC ?? 0;
        const cellRef = colToLetter(c) + (r + 1);
        const key = sheetName + ":" + cellRef;

        if (existingKeys.has(key)) {
          cellsSkipped++;
          continue;
        }

        const value = cell.value;
        const valueRaw = value != null ? String(value) : null;
        const valueNum = typeof value === "number" ? value : null;
        const valueType = cell.type || (typeof value === "number" ? "number" : "text");
        const formula = cell.formula || null;

        if (valueRaw == null && formula == null) continue; // empty cell

        newCells.push({
          sheetName,
          cellRef,
          rowIdx: r,
          colIdx: c,
          valueRaw,
          valueNum,
          valueType,
          formula,
        });
      }

      // Insert in batches of 200
      const BATCH = 200;
      for (let i = 0; i < newCells.length; i += BATCH) {
        const batch = newCells.slice(i, i + BATCH);
        const valueClauses: string[] = [];
        const params: unknown[] = [workbookId, workbook_role];
        let idx = 3;

        for (const cell of batch) {
          valueClauses.push(
            `($1, $2, $${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3},` +
            ` $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, NULL, NULL)`
          );
          params.push(
            cell.sheetName, cell.cellRef, cell.rowIdx, cell.colIdx,
            cell.valueRaw, cell.valueNum, cell.valueType, cell.formula,
          );
          idx += 8;
        }

        if (valueClauses.length > 0) {
          await db.execute(
            `INSERT INTO workbook_cells (
               workbook_id, workbook_role, sheet_name, cell_ref, row_idx, col_idx,
               value_raw, value_num, value_type, formula, style_index, number_format
             ) VALUES ${valueClauses.join(", ")}
             ON CONFLICT DO NOTHING`,
            params,
            { label: `BackfillWorkbookCells: ${sheetName} batch ${Math.floor(i / BATCH) + 1}` },
          );
          cellsInserted += batch.length;
        }
      }
    }

    return { sheetsProcessed, cellsInserted, cellsSkipped, errors };
  },
});
