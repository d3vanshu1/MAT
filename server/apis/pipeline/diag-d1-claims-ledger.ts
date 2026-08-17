/**
 * D1 Diagnostic — Read the cached claims_ledger checkpoint from the most recent
 * contradiction_check run for a deal. Pure read — no LLM calls.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ClaimSummary = z.object({
  metric: z.string(),
  scope_qualifier: z.string(),
  period: z.string(),
  value: z.coerce.number(),
  unit: z.string(),
  claim_category: z.string(),
  basis_note: z.string(),
  source_doc: z.string(),
});

export default api({
  name: "DiagD1ClaimsLedger",
  description: "Read cached claims_ledger checkpoint for D1 diagnostic",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    page: z.number().default(0),
  }),

  output: z.object({
    found: z.boolean(),
    runId: z.string().nullable(),
    totalClaims: z.number(),
    nonNullCounts: z.object({
      scope_qualifier: z.number(),
      claim_category: z.number(),
      basis_note: z.number(),
      unit: z.number(),
    }),
    // Top 20 claims by value desc (proxy for materiality)
    topClaims: z.array(ClaimSummary),
  }),

  async run(ctx, { dealId, page }) {
    // Find the most recent completed contradiction_check run
    const runs = await ctx.integrations.db.query(
      `SELECT id FROM module_runs
       WHERE deal_id = $1 AND module_id = 'contradiction_check'
       ORDER BY triggered_at DESC NULLS LAST
       LIMIT 1`,
      z.object({ id: z.string() }),
      [dealId],
      { label: "D1: find latest CC run" }
    );

    if (runs.length === 0) {
      return { found: false, runId: null, totalClaims: 0, nonNullCounts: { scope_qualifier: 0, claim_category: 0, basis_note: 0, unit: 0 }, topClaims: [] };
    }

    const runId = runs[0].id;

    // Load claims_ledger checkpoint
    const cpRows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
       LIMIT 1`,
      z.object({ payload: z.any() }),
      [runId],
      { label: "D1: load claims_ledger checkpoint" }
    );

    if (cpRows.length === 0 || !cpRows[0].payload) {
      return { found: false, runId, totalClaims: 0, nonNullCounts: { scope_qualifier: 0, claim_category: 0, basis_note: 0, unit: 0 }, topClaims: [] };
    }

    const ledger = typeof cpRows[0].payload === "string"
      ? JSON.parse(cpRows[0].payload)
      : cpRows[0].payload;

    const claims: any[] = ledger.claims ?? [];
    const total = claims.length;

    // Count non-null fields
    let sqCount = 0, ccCount = 0, bnCount = 0, uCount = 0;
    for (const c of claims) {
      if (c.scope_qualifier && c.scope_qualifier !== "" && c.scope_qualifier !== "null") sqCount++;
      if (c.claim_category && c.claim_category !== "" && c.claim_category !== "null") ccCount++;
      if (c.basis_note && c.basis_note !== "" && c.basis_note !== "null") bnCount++;
      if (c.unit && c.unit !== "" && c.unit !== "null") uCount++;
    }

    // Top 20 by absolute value descending
    const sorted = [...claims].sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
    const topClaims = sorted.slice(page * 20, (page + 1) * 20).map((c: any) => ({
      metric: c.metric ?? "",
      scope_qualifier: c.scope_qualifier ?? "",
      period: c.period ?? "",
      value: c.value ?? 0,
      unit: c.unit ?? "",
      claim_category: c.claim_category ?? "",
      basis_note: c.basis_note ?? "",
      source_doc: c.source_doc ?? "",
    }));

    return {
      found: true,
      runId,
      totalClaims: total,
      nonNullCounts: {
        scope_qualifier: sqCount,
        claim_category: ccCount,
        basis_note: bnCount,
        unit: uCount,
      },
      topClaims,
    };
  },
});
