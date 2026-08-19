/**
 * Migration 027 — Create reference_figures table for Stage 5.
 *
 * Stores figures extracted from doc_tables with section-context qualification.
 * Each row is a single numeric value with resolved metric, scope, period,
 * and traceability anchors (sheet_name, segment, row_label).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration027",
  description: "Create reference_figures table for Stage 5 doc_tables extraction",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
  }),

  async run(ctx) {
    await ctx.integrations.db.query(
      `CREATE TABLE IF NOT EXISTS reference_figures (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id uuid NOT NULL,
        document_id uuid NOT NULL,
        sheet_name text NOT NULL,
        segment text,
        row_label text NOT NULL,
        metric text NOT NULL,
        scope_qualifier text NOT NULL,
        period text NOT NULL,
        value numeric NOT NULL,
        basis text,
        scenario text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      z.any(),
      [],
      { label: "Create reference_figures table" }
    );

    await ctx.integrations.db.query(
      `CREATE INDEX IF NOT EXISTS idx_reference_figures_deal_id
       ON reference_figures(deal_id)`,
      z.any(),
      [],
      { label: "Create deal_id index" }
    );

    await ctx.integrations.db.query(
      `CREATE INDEX IF NOT EXISTS idx_reference_figures_document_id
       ON reference_figures(document_id)`,
      z.any(),
      [],
      { label: "Create document_id index" }
    );

    return { success: true, message: "reference_figures table created with indexes" };
  },
});
