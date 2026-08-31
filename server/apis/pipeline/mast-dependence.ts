/**
 * mast-dependence.ts
 *
 * Stage handler for dependence.
 *
 * Assigns a dependence tier (critical / high / moderate / low) to every
 * canonical assumption, answering how much of the return rides on it.
 *
 * Pure code. No LLM. Tier is assigned by a rule table matched against
 * the normalized proposition text. The first matching entry wins. This
 * is weaker than a formula-graph computation and the report must disclose
 * it. The table is fully enumerable, reviewable, and arguable.
 *
 * dependence is a single-shot stage and stays out of LOOP_STAGES.
 *
 * Writes only to mast_assumptions.dependence_tier, dependence_basis, and
 * dependence_share (set to null). Changes no other column. No new tables.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-DEP]";

const UPDATE_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// DB row schema
// ---------------------------------------------------------------------------

const CanonicalRow = z.object({
  id: z.string(),
  proposition: z.string(),
  origin_type: z.string(),
});

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

export interface DependenceRule {
  tier: "critical" | "high" | "moderate" | "low";
  name: string;
  phrases: readonly string[];
}

export const DEPENDENCE_RULE_TABLE: readonly DependenceRule[] = [
  // ── CRITICAL ──────────────────────────────────────────────────────
  {
    tier: "critical",
    name: "valuation_multiple",
    phrases: [
      "entry multiple",
      "exit multiple",
      "ebitda multiple",
      "ev ebitda",
      "purchase price",
      "enterprise value",
    ],
  },
  {
    tier: "critical",
    name: "adjusted_earnings",
    phrases: [
      "adjusted ebitda",
      "normalised ebitda",
      "normalized ebitda",
    ],
  },
  {
    tier: "critical",
    name: "exit_horizon",
    phrases: [
      "exit year",
      "hold period",
      "terminal value",
    ],
  },
  {
    tier: "critical",
    name: "return_metric",
    phrases: [
      "irr",
      "moic",
      "money multiple",
    ],
  },
  {
    tier: "critical",
    name: "capital_structure",
    phrases: [
      "leverage",
      "net debt",
      "interest rate",
      "coupon rate",
      "covenant",
      "refinanc",
      "debt service",
    ],
  },
  // ── HIGH ──────────────────────────────────────────────────────────
  {
    tier: "high",
    name: "revenue_growth",
    phrases: [
      "revenue growth",
      "organic growth",
      "price increase",
      "price rise",
      "escalator",
      "arpu",
    ],
  },
  {
    tier: "high",
    name: "churn_retention",
    phrases: [
      "churn",
      "retention",
    ],
  },
  {
    tier: "high",
    name: "margin",
    phrases: [
      "gross margin",
      "ebitda margin",
      "contribution margin",
    ],
  },
  {
    tier: "high",
    name: "synergy_cost",
    phrases: [
      "synergy",
      "cost saving",
      "opex efficiency",
    ],
  },
  {
    tier: "high",
    name: "m_and_a",
    phrases: [
      "m and a",
      "acquisition multiple",
      "bolt on",
      "pipeline",
    ],
  },
  {
    tier: "high",
    name: "management",
    phrases: [
      "management retention",
      "key man",
      "integration",
    ],
  },
  // ── MODERATE ──────────────────────────────────────────────────────
  {
    tier: "moderate",
    name: "conversion_penetration",
    phrases: [
      "migration",
      "conversion",
      "penetration",
      "attach rate",
      "cross sell",
      "upsell",
    ],
  },
  {
    tier: "moderate",
    name: "workforce",
    phrases: [
      "headcount",
      "fte",
      "offshor",
    ],
  },
  {
    tier: "moderate",
    name: "capital_working",
    phrases: [
      "capex",
      "working capital",
      "day sales",
      "creditor",
      "debtor",
    ],
  },
  {
    tier: "moderate",
    name: "cost_environment",
    phrases: [
      "inflation",
      "supplier",
      "contract renewal",
      "framework",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Normalization — same logic as other MAST handlers
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function matchRule(
  normalizedProposition: string,
): { tier: string; basis: string } {
  for (const rule of DEPENDENCE_RULE_TABLE) {
    for (const phrase of rule.phrases) {
      if (normalizedProposition.includes(phrase)) {
        return { tier: rule.tier, basis: rule.name };
      }
    }
  }
  return { tier: "low", basis: "rule_table_default" };
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const dependence: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId } = ctx;

  // ── 1. Load all canonical rows ────────────────────────────────────
  const allRows = await db.query(
    `SELECT id, proposition, origin_type
     FROM mast_assumptions
     WHERE run_id = $1::uuid AND dedup_group_id = id
     ORDER BY id`,
    CanonicalRow,
    [runId],
    { label: "MAST-DEP: load canonical assumptions" },
  );

  if (allRows.length === 0) {
    throw new Error(
      `${LOG_PREFIX} No canonical assumptions found for run ${runId}. Cannot proceed.`,
    );
  }

  const totalRows = allRows.length;
  console.log(`${LOG_PREFIX} ${totalRows} canonical assumptions loaded.`);

  // ── 2. Classify every row ─────────────────────────────────────────
  const tierCounts: Record<string, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
  };
  const tierByOrigin: Record<string, number> = {};
  const ruleHitCounts: Record<string, number> = {};
  let defaultCount = 0;

  const classified = allRows.map((row) => {
    const norm = normalize(row.proposition);
    const { tier, basis } = matchRule(norm);

    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    ruleHitCounts[basis] = (ruleHitCounts[basis] || 0) + 1;
    if (basis === "rule_table_default") defaultCount++;

    // Track origin_type within each tier
    const originKey = `${tier}:${row.origin_type}`;
    tierByOrigin[originKey] = (tierByOrigin[originKey] || 0) + 1;

    return { id: row.id, tier, basis };
  });

  // ── 3. Write in batches ───────────────────────────────────────────
  for (let i = 0; i < classified.length; i += UPDATE_BATCH_SIZE) {
    const batch = classified.slice(i, i + UPDATE_BATCH_SIZE);

    for (const row of batch) {
      await db.execute(
        `UPDATE mast_assumptions
         SET dependence_tier = $2, dependence_basis = $3, dependence_share = NULL
         WHERE id = $1::uuid`,
        [row.id, row.tier, row.basis],
        { label: `MAST-DEP: update ${row.id}` },
      );
    }
  }

  // ── 4. Log prominently ────────────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Dependence scoring complete. ${totalRows} canonical rows. ` +
    `critical=${tierCounts.critical}, high=${tierCounts.high}, ` +
    `moderate=${tierCounts.moderate}, low=${tierCounts.low}. ` +
    `rule_table_default=${defaultCount}.`,
  );

  if (tierCounts.critical === 0 && tierCounts.high === 0 && tierCounts.moderate === 0) {
    console.log(
      `${LOG_PREFIX} WARNING: Every row landed in low. The register may contain ` +
      `propositions the rule table does not recognise. Review the rule table.`,
    );
  }

  // Top 10 most frequently matched rules
  const sortedRules = Object.entries(ruleHitCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(
    `${LOG_PREFIX} Top rules: ${sortedRules.map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );

  // ── 5. Build per-tier origin_type breakdown ───────────────────────
  const tierOriginBreakdown: Record<string, Record<string, number>> = {};
  for (const [key, count] of Object.entries(tierByOrigin)) {
    const [tier, originType] = key.split(":");
    if (!tierOriginBreakdown[tier]) tierOriginBreakdown[tier] = {};
    tierOriginBreakdown[tier][originType] = count;
  }

  // ── 6. Persist payload ────────────────────────────────────────────
  const summaryPayload = {
    totalCanonicalRows: totalRows,
    tierCounts,
    tierOriginBreakdown,
    topRules: Object.fromEntries(sortedRules),
    ruleTableDefaultCount: defaultCount,
    ruleTableApplied: DEPENDENCE_RULE_TABLE.map((r) => ({
      tier: r.tier,
      name: r.name,
      phrases: [...r.phrases],
    })),
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "dependence", JSON.stringify(summaryPayload)],
      { label: "MAST-DEP: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  return {
    complete: true,
    itemsDone: totalRows,
    itemsTotal: totalRows,
    resumePosition: 0,
  };
};

export default dependence;
