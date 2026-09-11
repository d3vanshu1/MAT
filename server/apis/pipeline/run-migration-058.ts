import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration058",
  description: "Creates workbook_cells_verify for C9 double-read guard",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({ dryRun: z.boolean().optional() }),
  output: z.object({ added: z.array(z.string()), dryRun: z.boolean() }),

  async run(ctx, { dryRun }) {
    const isDry = dryRun ?? true;
    const added: string[] = [];
    const q = ctx.integrations.ic_db;
    const Check = z.object({ ok: z.number() });

    // ---- workbook_cells_verify ----
    // Second-parse values from an independent code path (raw OOXML <v> tags).
    // C9 compares workbook_cells.value_num vs workbook_cells_verify.value_num_v2.
    // Disagreement drops the finding; no tie-breaking.
    //
    // What this covers: parser and transcription errors (different parser, same bytes).
    // What it doesn't: storage corruption (covered by file hash on document_files chunks).
    const [tExists] = await q.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'workbook_cells_verify' LIMIT 1",
      Check, [], { label: "Check workbook_cells_verify" },
    );
    if (!tExists) {
      if (!isDry) {
        await q.query(`
          CREATE TABLE workbook_cells_verify (
            workbook_id    uuid NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
            sheet_name     text NOT NULL,
            cell_ref       text NOT NULL,
            value_num_v2   numeric,
            value_raw_v2   text,
            value_type_v2  text,
            parser         text NOT NULL DEFAULT 'ooxml_raw',
            created_at     timestamptz DEFAULT now(),
            PRIMARY KEY (workbook_id, sheet_name, cell_ref)
          )
        `, z.any(), [], { label: "Create workbook_cells_verify" });
      }
      added.push("workbook_cells_verify");
    }

    return { added, dryRun: isDry };
  },
});
