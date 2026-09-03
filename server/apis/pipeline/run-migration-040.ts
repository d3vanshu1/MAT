/**
 * Migration 040 — Add `relation` column to mast_support_evidence.
 *
 * Stores the relation type returned by the sweep prompt (Arm B):
 * supports, undermines, constrains, defines.
 *
 * Nullable text. Not used in scoring or clustering — recorded only.
 * Idempotent (IF NOT EXISTS via DO block).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration040",
  description: "Adds relation column to mast_support_evidence",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    columnAdded: z.boolean(),
  }),

  async run(ctx) {
    const db = ctx.integrations.ic_diligence_db;

    // Check if column already exists
    const checkResult = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mast_support_evidence' AND column_name = 'relation'
       LIMIT 1`,
      z.object({ column_name: z.string() }),
      [],
      { label: "Migration 040: check if relation column exists" },
    );

    if (checkResult.length > 0) {
      return {
        success: true,
        message: "Column 'relation' already exists on mast_support_evidence. No action taken.",
        columnAdded: false,
      };
    }

    await db.execute(
      `ALTER TABLE mast_support_evidence ADD COLUMN relation text`,
      [],
      { label: "Migration 040: add relation column" },
    );

    console.log("[MIGRATION-040] Added column 'relation' (text, nullable) to mast_support_evidence.");

    return {
      success: true,
      message: "Added column 'relation' (text, nullable) to mast_support_evidence.",
      columnAdded: true,
    };
  },
});
