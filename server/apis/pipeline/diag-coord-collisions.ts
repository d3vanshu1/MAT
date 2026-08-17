/**
 * Diagnostic: coordKey collision analysis on persisted claims ledger.
 * Applies normalizePeriod + coordKey from claims-reconciliation to all claims
 * in diag_claims_ledger and reports collisions.
 *
 * Read-only. Does NOT write to any table. Safe without consent gate.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { coordKey } from "./claims-reconciliation.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

interface StoredClaim {
  metric: string;
  scope_qualifier: string;
  period: string;
  value: number;
  unit: string;
  source_doc: string;
  claim_category: string;
  basis_note: string;
  basis: string | null;
  scenario: string | null;
  source_page: string | null;
  verbatim_snippet: string;
}

export default api({
  name: "DiagCoordCollisions",
  description: "Analyse coordKey collisions across persisted claims ledger",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    // D1: all multi-claim coordKeys
    collisions: z.array(z.object({
      key: z.string(),
      count: z.number(),
      min_value: z.number(),
      max_value: z.number(),
      spread_pct: z.number(), // (max - min) / min * 100, or 0 if min === 0
      claims: z.array(z.object({
        period: z.string(),
        value: z.number(),
        unit: z.string(),
        source_doc: z.string(),
        claim_category: z.string(),
      })),
    })),
    // D2: classification counts
    classification: z.object({
      true_duplicates: z.number(),
      scenario_collisions: z.number(),
      genuine_divergence: z.number(),
    }),
    // D3: distinct claim count
    total_claims: z.number(),
    distinct_claims: z.number(), // deduped on (metric, scope_qualifier, period, value, unit)
    // Summary
    total_collision_keys: z.number(),
    total_claims_in_collisions: z.number(),
  }),

  async run(ctx, { dealId }) {
    // Load ledger
    const rows = await ctx.integrations.db.query(
      `SELECT ledger FROM diag_claims_ledger WHERE deal_id = $1 LIMIT 1`,
      z.object({ ledger: z.any() }),
      [dealId],
      { label: "DiagCC: load ledger" },
    );

    if (rows.length === 0) {
      throw new Error(`No ledger found for deal ${dealId}`);
    }

    const claims: StoredClaim[] = rows[0].ledger.claims ?? [];

    // Apply coordKey to each claim (null key = scenario claim, excluded)
    const keyMap = new Map<string, { claims: StoredClaim[]; key: string }>();
    let scenarioExcluded = 0;
    for (const c of claims) {
      const key = coordKey(c.metric, c.scope_qualifier, c.period, c.basis ?? null, c.scenario ?? null);
      if (key === null) {
        scenarioExcluded++;
        continue;
      }
      if (!keyMap.has(key)) {
        keyMap.set(key, { key, claims: [] });
      }
      keyMap.get(key)!.claims.push(c);
    }

    // Filter to multi-claim keys
    const collisions = Array.from(keyMap.values())
      .filter(g => g.claims.length > 1)
      .sort((a, b) => b.claims.length - a.claims.length)
      .map(g => {
        const values = g.claims.map(c => c.value);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const spread = minVal !== 0 ? ((maxVal - minVal) / Math.abs(minVal)) * 100 : (maxVal !== 0 ? Infinity : 0);
        return {
          key: g.key,
          count: g.claims.length,
          min_value: minVal,
          max_value: maxVal,
          spread_pct: isFinite(spread) ? Math.round(spread * 10) / 10 : 9999,
          claims: g.claims.map(c => ({
            period: c.period,
            value: c.value,
            unit: c.unit,
            source_doc: c.source_doc,
            claim_category: c.claim_category,
          })),
        };
      });

    // D2: Classify each collision group
    let trueDuplicates = 0;
    let scenarioCollisions = 0;
    let genuineDivergence = 0;

    for (const group of collisions) {
      // Check if all values are identical (true duplicate)
      const uniqueValues = new Set(group.claims.map(c => `${c.value}|${c.unit}`));
      if (uniqueValues.size === 1) {
        trueDuplicates++;
        continue;
      }

      // Check if raw periods differ (scenario collision)
      const uniquePeriods = new Set(group.claims.map(c => c.period));
      if (uniquePeriods.size > 1) {
        scenarioCollisions++;
        continue;
      }

      // Same raw period, different values = genuine divergence
      genuineDivergence++;
    }

    // D3: Distinct claims by (metric, scope_qualifier, period, value, unit)
    const dedupSet = new Set<string>();
    for (const c of claims) {
      dedupSet.add(`${c.metric}|${c.scope_qualifier}|${c.period}|${c.value}|${c.unit}`);
    }

    return {
      collisions,
      classification: {
        true_duplicates: trueDuplicates,
        scenario_collisions: scenarioCollisions,
        genuine_divergence: genuineDivergence,
      },
      total_claims: claims.length,
      distinct_claims: dedupSet.size,
      total_collision_keys: collisions.length,
      total_claims_in_collisions: collisions.reduce((sum, g) => sum + g.count, 0),
    };
  },
});
