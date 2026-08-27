/**
 * BssGetFindings — loads BSS v2 findings + funnel stats for the dashboard.
 *
 * Called once when the orchestrator returns 'done'. Returns:
 * - findings: candidates whose disposition.outcome = 'finding'
 * - funnel: total candidates, findings, dropped_covered, dropped_no_dependency
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Row schemas ───────────────────────────────────────────────────────────

const FindingRow = z.object({
  candidate_id: z.string(),
  pass_type: z.string(),
  failure_mode: z.string(),
  implied_assumption: z.string(),
  hypothesis: z.string(),
  rationale: z.string().nullable(),
  adjudicated_verdict: z.string().nullable(),
  adjudication_quote: z.string().nullable(),
  adjudication_reason: z.string().nullable(),
  // dependency columns
  thesis_hit: z.boolean().nullable(),
  latest_memo_hit: z.boolean().nullable(),
  // disposition
  gate: z.string().nullable(),
  reason: z.string().nullable(),
});

const FunnelRow = z.object({
  outcome: z.string(),
  cnt: z.coerce.number(),
});

const TotalRow = z.object({
  cnt: z.coerce.number(),
});

// ── API ───────────────────────────────────────────────────────────────────

export default api({
  name: "BssGetFindings",
  description: "Loads BSS v2 findings and funnel stats for dashboard render",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    findings: z.array(FindingRow),
    funnel: z.object({
      totalCandidates: z.number(),
      findings: z.number(),
      droppedCovered: z.number(),
      droppedNotReliedUpon: z.number(),
    }),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.db;

    // 1. Total active candidates
    const totalRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM bss_candidates
       WHERE deal_id = $1::uuid AND superseded_by IS NULL`,
      TotalRow,
      [dealId],
      { label: "Count total BSS candidates" },
    );
    const totalCandidates = totalRows[0]?.cnt ?? 0;

    // 2. Funnel breakdown by outcome
    const funnelRows = await db.query(
      `SELECT d.outcome, COUNT(*)::int AS cnt
       FROM bss_dispositions d
       JOIN bss_candidates c ON c.candidate_id = d.candidate_id
       WHERE d.deal_id = $1::uuid AND c.superseded_by IS NULL
       GROUP BY d.outcome`,
      FunnelRow,
      [dealId],
      { label: "BSS funnel by outcome" },
    );

    const funnelMap: Record<string, number> = {};
    for (const row of funnelRows) {
      funnelMap[row.outcome] = row.cnt;
    }

    // 3. Findings: join candidates + coverage + dependencies + dispositions
    const findings = await db.query(
      `SELECT
         c.candidate_id,
         c.pass_type,
         c.failure_mode,
         c.implied_assumption,
         c.hypothesis,
         c.rationale,
         cv.adjudicated_verdict,
         cv.adjudication_quote,
         cv.adjudication_reason,
         dep.thesis_hit,
         dep.latest_memo_hit,
         disp.gate,
         disp.reason AS reason
       FROM bss_dispositions disp
       JOIN bss_candidates c ON c.candidate_id = disp.candidate_id
       LEFT JOIN bss_coverage cv ON cv.candidate_id = c.candidate_id
       LEFT JOIN bss_dependencies dep ON dep.candidate_id = c.candidate_id AND dep.deal_id = c.deal_id
       WHERE disp.deal_id = $1::uuid
         AND disp.outcome = 'finding'
         AND c.superseded_by IS NULL
       ORDER BY c.pass_type, c.failure_mode`,
      FindingRow,
      [dealId],
      { label: "Load BSS findings" },
    );

    return {
      findings,
      funnel: {
        totalCandidates,
        findings: funnelMap["finding"] ?? 0,
        droppedCovered: funnelMap["dropped_covered"] ?? 0,
        droppedNotReliedUpon: (funnelMap["dropped_not_relied_upon"] ?? 0) + (funnelMap["dropped_no_dependency"] ?? 0),
      },
    };
  },
});
