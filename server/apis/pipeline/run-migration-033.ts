/**
 * Migration 033 — Add supersession columns to bss_candidates.
 *
 * Adds two nullable columns for within-pass dedup:
 *
 *   - superseded_by   UUID NULL — points at the surviving candidate
 *   - superseded_reason TEXT NULL — one-line judgment that retired this row
 *
 * Design constraints:
 *
 *   - No backfill — columns are added NULL with no default.
 *   - No existing rows are altered.
 *   - Both statements are idempotent (ADD COLUMN IF NOT EXISTS).
 *   - FK on superseded_by references bss_candidates(candidate_id).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration033",
  description: "Adds superseded_by and superseded_reason columns to bss_candidates",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    columnsAdded: z.array(z.string()),
    columnsAlreadyPresent: z.array(z.string()),
  }),

  async run(ctx) {
    const TARGET_COLUMNS = ["superseded_by", "superseded_reason"];

    // Check which columns already exist
    const preExisting = await ctx.integrations.db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bss_candidates'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      z.object({ column_name: z.string() }),
      [TARGET_COLUMNS],
      { label: "Migration033: check which supersession columns already exist" },
    );
    const columnsAlreadyPresent = preExisting.map((r) => r.column_name);

    const columnsAdded: string[] = [];

    // Add superseded_by — UUID FK to the surviving candidate
    await ctx.integrations.db.execute(
      `ALTER TABLE bss_candidates
         ADD COLUMN IF NOT EXISTS superseded_by UUID NULL
           REFERENCES bss_candidates (candidate_id)`,
      [],
      { label: "Migration033: add superseded_by column" },
    );
    if (!columnsAlreadyPresent.includes("superseded_by")) {
      columnsAdded.push("superseded_by");
    }

    // Add superseded_reason — one-line judgment text
    await ctx.integrations.db.execute(
      `ALTER TABLE bss_candidates
         ADD COLUMN IF NOT EXISTS superseded_reason TEXT NULL`,
      [],
      { label: "Migration033: add superseded_reason column" },
    );
    if (!columnsAlreadyPresent.includes("superseded_reason")) {
      columnsAdded.push("superseded_reason");
    }

    return {
      success: true,
      message:
        columnsAlreadyPresent.length === TARGET_COLUMNS.length
          ? "Both supersession columns already existed — migration re-ran idempotently."
          : `Migration 033 applied. Columns added: ${columnsAdded.join(", ")}.` +
            (columnsAlreadyPresent.length > 0
              ? ` Already present: ${columnsAlreadyPresent.join(", ")}.`
              : ""),
      columnsAdded,
      columnsAlreadyPresent,
    };
  },
});
