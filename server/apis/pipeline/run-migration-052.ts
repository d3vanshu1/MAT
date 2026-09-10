import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * Migration 052 — Workbook Map Phase 2 columns
 *
 * Adds row-identity columns to workbook_cells:
 *   row_label_source, row_depth, row_depth_source,
 *   is_section_header, is_aggregate, aggregate_evidence,
 *   component_range, sign_convention
 *
 * Adds sheet-level label metadata to workbook_sheets:
 *   label_col, label_col_confidence, header_band_rows,
 *   data_region_start
 */
export default api({
  name: "RunMigration052",
  description: "Adds Phase 2 label/depth/aggregate columns.",
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

    // Helper: add column if not exists
    async function addCol(table: string, col: string, type: string): Promise<void> {
      const check = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
        z.object({}),
        [table, col],
        { label: `Migration052: check ${table}.${col}` },
      );
      if (check.length > 0) return; // already exists
      if (dryRun) {
        added.push(`${table}.${col} (dry run)`);
        return;
      }
      await db.execute(
        `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`,
        [],
        { label: `Migration052: add ${table}.${col}` },
      );
      added.push(`${table}.${col}`);
    }

    // workbook_cells columns
    await addCol("workbook_cells", "row_label_source", "text");
    await addCol("workbook_cells", "row_depth", "int");
    await addCol("workbook_cells", "row_depth_source", "text");
    await addCol("workbook_cells", "is_section_header", "boolean");
    await addCol("workbook_cells", "is_aggregate", "boolean");
    await addCol("workbook_cells", "aggregate_evidence", "text");
    await addCol("workbook_cells", "component_range", "text");
    await addCol("workbook_cells", "sign_convention", "text");

    // workbook_sheets columns
    await addCol("workbook_sheets", "label_col", "int");
    await addCol("workbook_sheets", "label_col_confidence", "numeric");
    await addCol("workbook_sheets", "header_band_rows", "jsonb");
    await addCol("workbook_sheets", "data_region_start", "int");

    return { added, dryRun };
  },
});
