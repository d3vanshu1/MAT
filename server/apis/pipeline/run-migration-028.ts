/**
 * Migration 028 — Add has_ledger_counterpart boolean to reference_figures.
 *
 * When true, the reference figure's scope_qualifier exists in the claims ledger
 * (i.e., at least one operating_metric claim cites the same scope). Figures
 * without ledger counterparts can be suppressed from near-miss matching to reduce
 * noise from model scopes the memo never mentions.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration028",
  description: "Add has_ledger_counterpart boolean to reference_figures",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    /** If provided, backfill flag for this deal using diag_claims_ledger */
    dealId: z.string().uuid().nullable().default(null),
  }),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    backfilled_count: z.number().nullable(),
  }),

  async run(ctx, { dealId }) {
    // Step 1: Add column if not exists
    await ctx.integrations.db.query(
      `ALTER TABLE reference_figures
       ADD COLUMN IF NOT EXISTS has_ledger_counterpart boolean DEFAULT false`,
      z.any(),
      [],
      { label: "Add has_ledger_counterpart column" }
    );

    // Step 2: Backfill for a specific deal if provided
    let backfilledCount: number | null = null;
    if (dealId) {
      // Load the claims ledger to get distinct scopes
      const LedgerRow = z.object({ ledger: z.any() });
      const ledgerRows = await ctx.integrations.db.query(
        `SELECT ledger FROM diag_claims_ledger WHERE deal_id = $1 LIMIT 1`,
        LedgerRow,
        [dealId],
        { label: "Load claims ledger for backfill" }
      );

      if (ledgerRows.length > 0) {
        const rawLedger = ledgerRows[0].ledger;
        const ledger = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;
        
        // Extract distinct scope_qualifiers from operating_metric claims
        const claimScopes = new Set<string>();
        for (const c of ledger.claims ?? []) {
          if (c.claim_category === "operating_metric" && c.scope_qualifier) {
            claimScopes.add(c.scope_qualifier.toLowerCase());
          }
        }

        if (claimScopes.size > 0) {
          // Build array for IN clause
          const scopeArray = [...claimScopes];
          const placeholders = scopeArray.map((_, i) => `$${i + 2}`).join(", ");
          
          const CountRow = z.object({ cnt: z.coerce.number() });
          const updateResult = await ctx.integrations.db.query(
            `WITH updated AS (
               UPDATE reference_figures
               SET has_ledger_counterpart = true
               WHERE deal_id = $1
                 AND lower(scope_qualifier) IN (${placeholders})
               RETURNING id
             )
             SELECT count(*)::int AS cnt FROM updated`,
            CountRow,
            [dealId, ...scopeArray],
            { label: "Backfill has_ledger_counterpart" }
          );
          backfilledCount = updateResult[0]?.cnt ?? 0;
        }
      }
    }

    return {
      success: true,
      message: dealId
        ? `Column added; backfilled ${backfilledCount ?? 0} rows for deal ${dealId}`
        : "Column added (no backfill requested)",
      backfilled_count: backfilledCount,
    };
  },
});
