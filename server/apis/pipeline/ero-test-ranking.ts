/**
 * ERO v2 — Test harness for hypothesis ranking
 *
 * Takes an EXISTING runId (must have completed generate_hypotheses with
 * hypotheses already populated) and calls rankHypotheses directly.
 * Returns the full ranked list with execution_rank and rank_reason,
 * plus determinism/placement checks.
 *
 * No Anthropic needed — ranking is deterministic, no LLM.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { rankHypotheses } from "./ero-ranking.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
  question: z.string(),
  execution_rank: z.coerce.number(),
});

const DealIdRow = z.object({ deal_id: z.string() });

export default api({
  name: "EroTestRanking",
  description: "Test harness for ERO hypothesis ranking against an existing run with hypotheses",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    stageResult: z.object({
      stage: z.string(),
      status: z.string(),
      message: z.string(),
      stageData: z.record(z.unknown()).nullable().optional(),
    }),
    rankedList: z.array(z.object({
      execution_rank: z.number(),
      family: z.string(),
      entity_id: z.string().nullable(),
      thesis_link: z.string().nullable(),
      question: z.string(),
      rank_reason: z.string(),
    })),
    checks: z.object({
      totalRanked: z.number(),
      top5: z.array(z.object({
        rank: z.number(),
        family: z.string(),
        reason: z.string(),
        question_preview: z.string(),
      })),
      programmeInTopTier: z.boolean(),
      regulatoryInTopTier: z.boolean(),
      macroBelowAllThesisLinked: z.boolean(),
      minMacroRank: z.number(),
      maxThesisLinkedRank: z.number(),
      determinismCheck: z.object({
        ranksAre1toN: z.boolean(),
        noGaps: z.boolean(),
        noDuplicates: z.boolean(),
        passed: z.boolean(),
      }),
    }),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.ic_diligence_db;

    // Look up dealId from the run
    const dealRows = await db.query(
      `SELECT deal_id FROM ero_pipeline_state WHERE run_id = $1`,
      DealIdRow,
      [runId],
      { label: "TestRanking: get dealId" },
    );
    if (dealRows.length === 0) {
      throw new Error(`Run not found: ${runId}`);
    }
    const dealId = dealRows[0].deal_id;

    // Run ranking
    const stageResult = await rankHypotheses(ctx, runId, dealId);

    // Read back all hypotheses with updated ranks
    const allRows = await db.query(
      `SELECT hypothesis_id, family, entity_id, thesis_link, question, execution_rank
       FROM ero_hypotheses
       WHERE run_id = $1
       ORDER BY execution_rank ASC`,
      HypothesisRow,
      [runId],
      { label: "TestRanking: read ranked hypotheses" },
    );

    // Extract rankedList from stageData (has rank_reason)
    const stageRankedList = (stageResult.stageData?.rankedList ?? []) as Array<{
      execution_rank: number;
      family: string;
      entity_id: string | null;
      thesis_link: string | null;
      question: string;
      rank_reason: string;
    }>;

    // Build rankedList from DB rows, enriched with rank_reason from stageData
    const rankReasonMap = new Map<number, string>();
    for (const sr of stageRankedList) {
      rankReasonMap.set(sr.execution_rank, sr.rank_reason);
    }

    const rankedList = allRows.map((row) => ({
      execution_rank: row.execution_rank,
      family: row.family,
      entity_id: row.entity_id,
      thesis_link: row.thesis_link,
      question: row.question,
      rank_reason: rankReasonMap.get(row.execution_rank) ?? "unknown",
    }));

    // ── Determinism check: ranks are exactly 1..N ───────────────────
    const ranks = allRows.map((r) => r.execution_rank).sort((a, b) => a - b);
    const expected = Array.from({ length: allRows.length }, (_, i) => i + 1);
    const ranksAre1toN =
      ranks.length === expected.length &&
      ranks.every((r, i) => r === expected[i]);

    const rankSet = new Set(ranks);
    const noDuplicates = rankSet.size === ranks.length;

    // Check for gaps: max - min + 1 should equal count
    const noGaps =
      ranks.length > 0
        ? ranks[ranks.length - 1] - ranks[0] + 1 === ranks.length
        : true;

    const determinismCheck = {
      ranksAre1toN,
      noGaps,
      noDuplicates,
      passed: ranksAre1toN && noGaps && noDuplicates,
    };

    // ── Extract checks from stageData ───────────────────────────────
    const sd = stageResult.stageData ?? {};
    const top5 = (sd.top5 ?? []) as Array<{
      rank: number;
      family: string;
      reason: string;
      question_preview: string;
    }>;

    return {
      stageResult,
      rankedList,
      checks: {
        totalRanked: allRows.length,
        top5,
        programmeInTopTier: (sd.programmeInTopTier as boolean) ?? false,
        regulatoryInTopTier: (sd.regulatoryInTopTier as boolean) ?? false,
        macroBelowAllThesisLinked: (sd.macroBelowAllThesisLinked as boolean) ?? false,
        minMacroRank: (sd.minMacroRank as number) ?? 0,
        maxThesisLinkedRank: (sd.maxThesisLinkedRank as number) ?? 0,
        determinismCheck,
      },
    };
  },
});
