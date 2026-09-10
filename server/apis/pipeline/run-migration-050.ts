import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration050",
  description: "Add cell_ref, column_header, formula to reference_figures",
  integrations: { ic_diligence_db: postgres(IC_DILIGENCE_DB) },
  input: z.object({ dryRun: z.boolean().default(true) }),
  output: z.object({ columnsAdded: z.boolean(), dryRun: z.boolean() }),
  async run(ctx, { dryRun }) {
    const db = ctx.integrations.ic_diligence_db;
    if (dryRun) {
      console.log("[Migration050] DRY RUN");
      return { columnsAdded: false, dryRun: true };
    }
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS cell_ref TEXT`,
      [], { label: "Migration050: add cell_ref" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS column_header TEXT`,
      [], { label: "Migration050: add column_header" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS formula TEXT`,
      [], { label: "Migration050: add formula" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS unit_tag TEXT`,
      [], { label: "Migration050: add unit_tag" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS scale TEXT`,
      [], { label: "Migration050: add scale" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS value_raw NUMERIC`,
      [], { label: "Migration050: add value_raw" },
    );
    await db.execute(
      `ALTER TABLE reference_figures ADD COLUMN IF NOT EXISTS transform TEXT`,
      [], { label: "Migration050: add transform" },
    );
    console.log("[Migration050] All columns added.");
    return { columnsAdded: true, dryRun: false };
  },
});
