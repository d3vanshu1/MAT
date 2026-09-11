import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration057",
  description: "Adds chain_break_reason to workbook_cells for Phase 7 break classification",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({ dryRun: z.boolean().optional() }),
  output: z.object({ added: z.array(z.string()), dryRun: z.boolean() }),

  async run(ctx, { dryRun }) {
    const isDry = dryRun ?? true;
    const added: string[] = [];
    const q = ctx.integrations.ic_db;
    const Check = z.object({ ok: z.number() });

    // ---- chain_break_reason on workbook_cells ----
    // Distinguishes:
    //   hardcoded_leaf     — chain legitimately ends at a typed assumption
    //   runtime_indirect   — OFFSET/INDIRECT/INDEX — can't see through; what's beneath is unknown
    //   null               — not a break point (formula cell with known dependencies)
    const [colExists] = await q.query(
      "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'workbook_cells' AND column_name = 'chain_break_reason' LIMIT 1",
      Check, [], { label: "Check chain_break_reason col" },
    );
    if (!colExists) {
      if (!isDry) {
        await q.query(
          "ALTER TABLE workbook_cells ADD COLUMN chain_break_reason text",
          z.any(), [], { label: "Add chain_break_reason" },
        );
      }
      added.push("workbook_cells.chain_break_reason");
    }

    return { added, dryRun: isDry };
  },
});
