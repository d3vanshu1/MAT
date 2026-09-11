import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration056",
  description: "Creates workbook_manifests and workbook_precedents tables for Phase 6+7",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({ dryRun: z.boolean().optional() }),
  output: z.object({ added: z.array(z.string()), dryRun: z.boolean() }),

  async run(ctx, { dryRun }) {
    const isDry = dryRun ?? true;
    const added: string[] = [];
    const q = ctx.integrations.ic_db;
    const Check = z.object({ ok: z.number() });

    // ---- workbook_manifests ----
    const [mExists] = await q.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'workbook_manifests' LIMIT 1",
      Check, [], { label: "Check workbook_manifests" },
    );
    if (!mExists) {
      if (!isDry) {
        await q.query(`
          CREATE TABLE workbook_manifests (
            id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            workbook_id    uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
            version        int NOT NULL DEFAULT 1,
            manifest       jsonb NOT NULL,
            digest         jsonb NOT NULL,
            reviewed_by    text,
            reviewed_at    timestamptz,
            overrides      jsonb DEFAULT '{}'::jsonb,
            is_stale       boolean DEFAULT false,
            created_at     timestamptz DEFAULT now(),
            UNIQUE(workbook_id, version)
          )
        `, z.any(), [], { label: "Create workbook_manifests" });
      }
      added.push("workbook_manifests");
    }

    // ---- workbook_precedents ----
    const [pExists] = await q.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'workbook_precedents' LIMIT 1",
      Check, [], { label: "Check workbook_precedents" },
    );
    if (!pExists) {
      if (!isDry) {
        await q.query(`
          CREATE TABLE workbook_precedents (
            id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            workbook_id    uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
            from_sheet     text NOT NULL,
            from_cell_ref  text NOT NULL,
            to_sheet       text NOT NULL,
            to_cell_ref    text NOT NULL,
            ref_kind       text NOT NULL,
            range_size     int
          )
        `, z.any(), [], { label: "Create workbook_precedents" });

        await q.query(`
          CREATE INDEX idx_precedents_from ON workbook_precedents (workbook_id, from_sheet, from_cell_ref)
        `, z.any(), [], { label: "Index from" });
        await q.query(`
          CREATE INDEX idx_precedents_to ON workbook_precedents (workbook_id, to_sheet, to_cell_ref)
        `, z.any(), [], { label: "Index to" });
      }
      added.push("workbook_precedents");
    }

    // ---- Add feeds_entry_value / feeds_returns / distance_to_anchor to workbook_cells ----
    const cols = [
      { name: "feeds_entry_value", type: "boolean" },
      { name: "feeds_returns", type: "boolean" },
      { name: "distance_to_anchor", type: "int" },
      { name: "is_hardcoded_input", type: "boolean" },
    ];
    for (const col of cols) {
      const [exists] = await q.query(
        "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'workbook_cells' AND column_name = $1 LIMIT 1",
        Check, [col.name], { label: "Check " + col.name },
      );
      if (!exists) {
        if (!isDry) {
          await q.query(
            "ALTER TABLE workbook_cells ADD COLUMN " + col.name + " " + col.type,
            z.any(), [], { label: "Add " + col.name },
          );
        }
        added.push("workbook_cells." + col.name);
      }
    }

    return { added, dryRun: isDry };
  },
});
