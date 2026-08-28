/**
 * ERO v2 — Test harness for hypothesis generation
 *
 * Takes an EXISTING runId (must have completed build_deal_profile with
 * entities and profile already populated) and calls generateHypotheses
 * directly. Returns all ero_hypotheses rows grouped by family plus a
 * checks object.
 *
 * Does NOT create a new run — requires an existing Phase 2 run.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { generateHypotheses } from "./ero-hypotheses.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
  question: z.string(),
  confirming_evidence: z.string(),
  refuting_evidence: z.string(),
  execution_rank: z.coerce.number(),
  status: z.string(),
  round: z.coerce.number(),
});

const DealIdRow = z.object({ deal_id: z.string() });

export default api({
  name: "EroTestHypotheses",
  description: "Test harness for ERO hypothesis generation against an existing Phase 2 run",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
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
    hypothesesByFamily: z.record(z.string(), z.array(z.object({
      hypothesis_id: z.string(),
      entity_id: z.string().nullable(),
      thesis_link: z.string().nullable(),
      question: z.string(),
      confirming_evidence: z.string(),
      refuting_evidence: z.string(),
    }))),
    checks: z.object({
      total: z.number(),
      byFamily: z.record(z.string(), z.number()),
      regulatory_present: z.boolean(),
      acquisition_programme_present: z.boolean(),
    }),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.ic_diligence_db;

    // Look up dealId from the run
    const dealRows = await db.query(
      `SELECT deal_id FROM ero_pipeline_state WHERE run_id = $1`,
      DealIdRow,
      [runId],
      { label: "TestHypotheses: get dealId" },
    );
    if (dealRows.length === 0) {
      throw new Error(`Run not found: ${runId}`);
    }
    const dealId = dealRows[0].deal_id;

    // Run hypothesis generation
    const stageResult = await generateHypotheses(ctx, runId, dealId);

    // Read back all hypotheses from the table
    const allRows = await db.query(
      `SELECT hypothesis_id, family, entity_id, thesis_link,
              question, confirming_evidence, refuting_evidence,
              execution_rank, status, round
       FROM ero_hypotheses
       WHERE run_id = $1
       ORDER BY family, execution_rank`,
      HypothesisRow,
      [runId],
      { label: "TestHypotheses: read all hypotheses" },
    );

    // Group by family
    const hypothesesByFamily: Record<string, {
      hypothesis_id: string;
      entity_id: string | null;
      thesis_link: string | null;
      question: string;
      confirming_evidence: string;
      refuting_evidence: string;
    }[]> = {};

    const byFamilyCount: Record<string, number> = {};

    for (const row of allRows) {
      if (!hypothesesByFamily[row.family]) {
        hypothesesByFamily[row.family] = [];
        byFamilyCount[row.family] = 0;
      }
      hypothesesByFamily[row.family].push({
        hypothesis_id: row.hypothesis_id,
        entity_id: row.entity_id,
        thesis_link: row.thesis_link,
        question: row.question,
        confirming_evidence: row.confirming_evidence,
        refuting_evidence: row.refuting_evidence,
      });
      byFamilyCount[row.family]++;
    }

    return {
      stageResult,
      hypothesesByFamily,
      checks: {
        total: allRows.length,
        byFamily: byFamilyCount,
        regulatory_present: (byFamilyCount["regulatory"] ?? 0) > 0,
        acquisition_programme_present: (byFamilyCount["valuation"] ?? 0) > 0,
      },
    };
  },
});
