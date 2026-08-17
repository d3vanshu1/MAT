import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const FactRowSchema = z.object({
  fact_id: z.string(),
  document_id: z.string(),
  predicate: z.string(),
  adviser_severity: z.string().nullable(),
  adviser_disposition: z.string().nullable(),
});

const CountSchema = z.object({ cnt: z.coerce.number() });

const SeverityDistSchema = z.object({
  document_id: z.string(),
  adviser_severity: z.string(),
  cnt: z.coerce.number(),
});

/**
 * RunMigration025 — Strip adviser_severity from non-Legal-DD facts.
 *
 * The normalization step stored severity values from extraction into
 * adviser_severity for ALL documents. Only Legal DD facts should carry
 * adviser_severity ratings (that firm explicitly assigns them).
 * Non-Legal-DD facts with adviser_severity floor materiality tiers spuriously.
 */
export default api({
  name: "RunMigration025",
  description: "NULLs adviser_severity on non-Legal-DD facts (only Legal DD assigns severity)",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    dealId: z.string(),
    dryRun: z.boolean().default(true),
  }),
  output: z.object({
    totalAffected: z.number(),
    severityDist: z.array(SeverityDistSchema),
    sampleRows: z.array(FactRowSchema),
    rowsUpdated: z.number(),
    dryRun: z.boolean(),
  }),
  async run(ctx, { dealId, dryRun }) {
    // Legal DD is the ONLY document whose authors assign severity ratings
    const LEGAL_DD_DOC = "e27d46c9-c384-42ed-bc8c-6f04ba8bc474";

    // 1. Count total affected
    const [{ cnt: totalAffected }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM oa_facts
       WHERE deal_id = $1
         AND document_id != $2
         AND adviser_severity IS NOT NULL`,
      CountSchema,
      [dealId, LEGAL_DD_DOC],
      { label: "Count non-Legal-DD facts with adviser_severity" }
    );

    // 2. Severity distribution by document
    const severityDist = await ctx.integrations.db.query(
      `SELECT document_id, adviser_severity, COUNT(*)::int AS cnt
       FROM oa_facts
       WHERE deal_id = $1
         AND document_id != $2
         AND adviser_severity IS NOT NULL
       GROUP BY document_id, adviser_severity
       ORDER BY document_id, adviser_severity
       LIMIT 50`,
      SeverityDistSchema,
      [dealId, LEGAL_DD_DOC],
      { label: "Severity distribution for non-Legal-DD" }
    );

    // 3. Sample rows
    const sampleRows = await ctx.integrations.db.query(
      `SELECT fact_id, document_id, predicate, adviser_severity, adviser_disposition
       FROM oa_facts
       WHERE deal_id = $1
         AND document_id != $2
         AND adviser_severity IS NOT NULL
       ORDER BY document_id, adviser_severity DESC
       LIMIT 10`,
      FactRowSchema,
      [dealId, LEGAL_DD_DOC],
      { label: "Sample non-Legal-DD facts with adviser_severity" }
    );

    let rowsUpdated = 0;

    if (!dryRun) {
      // 4. NULL out ALL non-Legal-DD adviser_severity
      await ctx.integrations.db.query(
        `UPDATE oa_facts
         SET adviser_severity = NULL
         WHERE deal_id = $1
           AND document_id != $2
           AND adviser_severity IS NOT NULL`,
        z.object({}),
        [dealId, LEGAL_DD_DOC],
        { label: "NULL non-Legal-DD adviser_severity" }
      );
      rowsUpdated = totalAffected;
    }

    return {
      totalAffected,
      severityDist,
      sampleRows,
      rowsUpdated,
      dryRun,
    };
  },
});
