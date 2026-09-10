import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Migration 053 — Workbook Map Phase 3 columns
 *
 * Adds header/period/case columns to workbook_cells, workbook_sheets, and workbooks.
 */
export default api({
  name: "RunMigration053",
  description: "Adds Phase 3 header/period/case columns.",
  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    dryRun: z.boolean().optional().default(false),
  }),
  output: z.object({
    added: z.array(z.string()),
    dryRun: z.boolean(),
  }),
  async run(ctx, { dryRun }) {
    const db = ctx.integrations.ic_diligence_db;
    const added: string[] = [];

    async function addCol(table: string, col: string, type: string): Promise<void> {
      const check = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
        z.object({}),
        [table, col],
        { label: `Migration053: check ${table}.${col}` },
      );
      if (check.length > 0) return;
      if (dryRun) { added.push(`${table}.${col} (dry run)`); return; }
      await db.execute(
        `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`,
        [],
        { label: `Migration053: add ${table}.${col}` },
      );
      added.push(`${table}.${col}`);
    }

    // workbook_cells
    await addCol("workbook_cells", "col_header_raw", "text");
    await addCol("workbook_cells", "period_basis", "text");
    await addCol("workbook_cells", "case_source", "text");

    // workbook_sheets
    await addCol("workbook_sheets", "orientation", "text");
    await addCol("workbook_sheets", "header_band_confidence", "numeric");
    await addCol("workbook_sheets", "structure_reason", "text");
    await addCol("workbook_sheets", "sheet_case_label", "text");
    await addCol("workbook_sheets", "scenario_switch_cell", "text");

    // workbooks
    await addCol("workbooks", "fiscal_year_end_month", "int");
    await addCol("workbooks", "fiscal_year_end_source", "text");
    await addCol("workbooks", "active_case_label", "text");
    await addCol("workbooks", "active_case_source", "text");

    return { added, dryRun };
  },
});
