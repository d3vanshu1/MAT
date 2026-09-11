import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const VerifyCellSchema = z.object({
  sheetName: z.string(),
  cellRef: z.string(),
  valueRawV2: z.string().nullable(),
  valueNumV2: z.number().nullable(),
  valueTypeV2: z.string(),
});

/**
 * C9 Double-Read — saves a batch of second-parse (verify) cell values.
 * Called by the client after the primary map save, using values extracted
 * from an independent OOXML parse (raw <v> tags, not SheetJS).
 */
export default api({
  name: "SaveVerifyCellsBatch",
  description: "Saves C9 second-parse cell values for the double-read guard",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({
    workbookId: z.string().uuid(),
    cells: z.array(VerifyCellSchema),
  }),

  output: z.object({ cellsInserted: z.number() }),

  async run(ctx, { workbookId, cells }) {
    const db = ctx.integrations.ic_db;
    if (cells.length === 0) return { cellsInserted: 0 };

    const BATCH_SIZE = 200;
    let cellsInserted = 0;

    for (let i = 0; i < cells.length; i += BATCH_SIZE) {
      const batch = cells.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: unknown[] = [workbookId];
      let pi = 2;

      for (const c of batch) {
        values.push(`($1, $${pi}, $${pi + 1}, $${pi + 2}, $${pi + 3}, $${pi + 4})`);
        params.push(c.sheetName, c.cellRef, c.valueNumV2, c.valueRawV2, c.valueTypeV2);
        pi += 5;
      }

      await db.query(
        `INSERT INTO workbook_cells_verify (workbook_id, sheet_name, cell_ref, value_num_v2, value_raw_v2, value_type_v2)
         VALUES ${values.join(", ")}
         ON CONFLICT (workbook_id, sheet_name, cell_ref)
         DO UPDATE SET value_num_v2 = EXCLUDED.value_num_v2,
                       value_raw_v2 = EXCLUDED.value_raw_v2,
                       value_type_v2 = EXCLUDED.value_type_v2,
                       created_at = now()`,
        z.any(), params, { label: "Insert verify cells" },
      );
      cellsInserted += batch.length;
    }

    return { cellsInserted };
  },
});
