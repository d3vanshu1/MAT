/**
 * run-workbook-phase4-display.ts — Phase 4.3
 *
 * Renders display_value for all cells with number_format.
 * Runs server-side over stored cells. No file access needed.
 *
 * value_raw is NEVER touched. display_value = null + reason when format
 * can't be resolved — never falls back to the raw number.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { renderDisplayValue } from "../../lib/excelDisplayRenderer.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CellForRender = z.object({
  id: z.string(),
  value_num: z.string().nullable(),
  value_raw: z.string().nullable(),
  number_format: z.string().nullable(),
  value_type: z.string().nullable(),
});

export default api({
  name: "RunWorkbookPhase4Display",
  description: "Renders display_value from value_raw + number_format for all formatted cells",
  integrations: {
    ic_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string(),
    sheetNames: z.array(z.string()).nullable().optional(),
  }),
  output: z.object({
    sheetsProcessed: z.number(),
    cellsRendered: z.number(),
    cellsWithDisplay: z.number(),
    cellsUnresolved: z.number(),
    unresolvedReasons: z.record(z.number()),
    samples: z.array(z.object({
      cellRef: z.string(),
      format: z.string(),
      valueRaw: z.number(),
      displayValue: z.string().nullable(),
      reason: z.string().nullable(),
    })),
  }),

  async run(ctx, { workbookId, sheetNames }) {
    const q = ctx.integrations.ic_db;

    // Get date system
    const WbRow = z.object({ date_system: z.number().nullable() });
    const [wb] = await q.query(
      "SELECT date_system FROM workbooks WHERE id = $1",
      WbRow,
      [workbookId],
      { label: "Get workbook date_system" },
    );
    const dateSystem1904 = wb?.date_system === 1904;

    // Get sheets to process
    const SheetRow = z.object({ sheet_name: z.string() });
    let sheets: z.infer<typeof SheetRow>[];
    if (sheetNames && sheetNames.length > 0) {
      sheets = sheetNames.map(s => ({ sheet_name: s }));
    } else {
      sheets = await q.query(
        "SELECT DISTINCT sheet_name FROM workbook_cells WHERE workbook_id = $1 AND number_format IS NOT NULL ORDER BY sheet_name",
        SheetRow,
        [workbookId],
        { label: "List sheets with formats" },
      );
    }

    let cellsRendered = 0;
    let cellsWithDisplay = 0;
    let cellsUnresolved = 0;
    const unresolvedReasons: Record<string, number> = {};
    const samples: Array<{
      cellRef: string; format: string; valueRaw: number;
      displayValue: string | null; reason: string | null;
    }> = [];

    for (const sheet of sheets) {
      // Paginate cells with formats
      const PAGE = 3000;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const cells = await q.query(
          `SELECT id, value_num::text AS value_num, value_raw::text AS value_raw,
                  number_format, value_type
           FROM workbook_cells
           WHERE workbook_id = $1 AND sheet_name = $2 AND number_format IS NOT NULL
           ORDER BY row_idx, col_idx
           LIMIT $3 OFFSET $4`,
          CellForRender,
          [workbookId, sheet.sheet_name, PAGE, offset],
          { label: `Render display: ${sheet.sheet_name} (offset ${offset})` },
        );

        // Batch: compute display values
        const updates: Array<{ id: string; displayValue: string | null; reason: string | null }> = [];
        for (const cell of cells) {
          const rawNum = cell.value_num ? parseFloat(cell.value_num) : (cell.value_raw ? parseFloat(cell.value_raw) : NaN);
          if (isNaN(rawNum)) continue;

          const result = renderDisplayValue(rawNum, cell.number_format, cell.value_type, dateSystem1904);
          updates.push({ id: cell.id, displayValue: result.displayValue, reason: result.reason });
          cellsRendered++;

          if (result.displayValue !== null) {
            cellsWithDisplay++;
          } else {
            cellsUnresolved++;
            const r = result.reason ?? "unknown";
            unresolvedReasons[r] = (unresolvedReasons[r] ?? 0) + 1;
          }

          // Collect samples (first 10 of each type)
          if (samples.length < 20 && cell.number_format) {
            samples.push({
              cellRef: cell.id.substring(0, 8), // placeholder, we'll fix below
              format: cell.number_format,
              valueRaw: rawNum,
              displayValue: result.displayValue,
              reason: result.reason,
            });
          }
        }

        // Batch UPDATE display_value
        if (updates.length > 0) {
          // Use a CTE with VALUES for batch update
          const BATCH = 500;
          for (let b = 0; b < updates.length; b += BATCH) {
            const batch = updates.slice(b, b + BATCH);
            const values = batch
              .map((u, i) => `($${i * 3 + 1}::uuid, $${i * 3 + 2}::text, $${i * 3 + 3}::text)`)
              .join(", ");
            const params = batch.flatMap(u => [u.id, u.displayValue, u.reason]);

            await q.query(
              `UPDATE workbook_cells AS c
               SET display_value = v.dv, reason = CASE WHEN v.reason IS NOT NULL THEN v.reason ELSE c.reason END
               FROM (VALUES ${values}) AS v(id, dv, reason)
               WHERE c.id = v.id::uuid`,
              z.object({}),
              params,
              { label: `Batch update display_value (${batch.length} cells)` },
            );
          }
        }

        hasMore = cells.length === PAGE;
        offset += PAGE;
      }
    }

    return {
      sheetsProcessed: sheets.length,
      cellsRendered,
      cellsWithDisplay,
      cellsUnresolved,
      unresolvedReasons,
      samples: samples.slice(0, 10),
    };
  },
});
