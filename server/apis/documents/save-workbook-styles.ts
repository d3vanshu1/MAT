import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SaveWorkbookStyles",
  description: "Saves style tables and defined names for a workbook.",
  integrations: {
    ic_diligence: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
    styleTables: z.any(),
    definedNames: z.any(),
  }),
  output: z.object({ updated: z.boolean() }),
  async run(ctx, { workbookId, styleTables, definedNames }) {
    const db = ctx.integrations.ic_diligence;
    await db.execute(
      `UPDATE workbooks SET style_tables = $1, defined_names = $2 WHERE id = $3`,
      [JSON.stringify(styleTables), JSON.stringify(definedNames), workbookId],
      { label: "SaveWorkbookStyles: update style tables" },
    );
    return { updated: true };
  },
});
