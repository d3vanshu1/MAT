/**
 * Migration 041 — Add `assumption_label` and `label_reason` columns to mast_assumptions.
 *
 * Stores the model-assigned label (exit_multiple, revenue_growth, financing,
 * operational, unclassified) and the model's short reason string.
 *
 * Both nullable text. Written by the label stage. Read nowhere else in the
 * pipeline — tier mapping is written to the existing dependence_tier column.
 *
 * Idempotent: checks information_schema before each ALTER.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration041",
  description: "Adds assumption_label and label_reason columns to mast_assumptions",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    assumptionLabelAdded: z.boolean(),
    labelReasonAdded: z.boolean(),
  }),

  async run(ctx) {
    const db = ctx.integrations.ic_diligence_db;
    const ColRow = z.object({ column_name: z.string() });

    // Check assumption_label
    const checkLabel = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mast_assumptions' AND column_name = 'assumption_label'
       LIMIT 1`,
      ColRow,
      [],
      { label: "Migration 041: check assumption_label" },
    );

    let assumptionLabelAdded = false;
    if (checkLabel.length === 0) {
      await db.execute(
        `ALTER TABLE mast_assumptions ADD COLUMN assumption_label TEXT NULL`,
        [],
        { label: "Migration 041: add assumption_label" },
      );
      assumptionLabelAdded = true;
    }

    // Check label_reason
    const checkReason = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mast_assumptions' AND column_name = 'label_reason'
       LIMIT 1`,
      ColRow,
      [],
      { label: "Migration 041: check label_reason" },
    );

    let labelReasonAdded = false;
    if (checkReason.length === 0) {
      await db.execute(
        `ALTER TABLE mast_assumptions ADD COLUMN label_reason TEXT NULL`,
        [],
        { label: "Migration 041: add label_reason" },
      );
      labelReasonAdded = true;
    }

    const parts: string[] = [];
    if (assumptionLabelAdded) parts.push("assumption_label");
    if (labelReasonAdded) parts.push("label_reason");

    const message = parts.length > 0
      ? `Added columns: ${parts.join(", ")}.`
      : "Both columns already exist. No action taken.";

    return { success: true, message, assumptionLabelAdded, labelReasonAdded };
  },
});
