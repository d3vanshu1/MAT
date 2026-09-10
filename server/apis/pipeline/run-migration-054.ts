import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Migration 054 — Workbook Map Phase 4 columns
 *
 * Adds unit/scale/display columns to workbook_cells and date_system to workbooks.
 *
 * workbook_cells:
 *   scale_source   text  — cell_format | column_header | sheet_title | manifest | none
 *   display_value  text  — what Excel shows a human (rendered from value_raw + number_format)
 *   unit_source    text  — which level decided unit_class (cell_format | column_header | none)
 *
 * workbooks:
 *   date_system    int   — 1900 | 1904 (Excel date serial base)
 */
export default api({
  name: "RunMigration054",
  description: "Adds Phase 4 unit/scale/display columns.",
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
        { label: `Migration054: check ${table}.${col}` },
      );
      if (check.length > 0) return;
      if (dryRun) { added.push(`${table}.${col} (dry run)`); return; }
      await db.execute(
        `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`,
        [],
        { label: `Migration054: add ${table}.${col}` },
      );
      added.push(`${table}.${col}`);
    }

    // workbook_cells — Phase 4 columns
    await addCol("workbook_cells", "scale_source", "text");
    await addCol("workbook_cells", "display_value", "text");
    await addCol("workbook_cells", "unit_source", "text");

    // workbooks — date system
    await addCol("workbooks", "date_system", "int");

    return { added, dryRun };
  },
});
