/**
 * ERO v2 — Read-only state inspection (Packet 1.3)
 *
 * Returns the full pipeline_state row, child-table row counts,
 * and bounded sample rows (up to 5 per table) for a given run.
 * SELECT only — no writes of any kind.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Row schemas ─────────────────────────────────────────────────────
const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  heartbeat_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

export default api({
  name: "EroDiagState",
  description: "Read-only ERO pipeline state inspection",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable().optional(),
    dealId: z.string().nullable().optional(),
  }),

  output: z.object({
    run: z.any(),
    dealRunCount: z.number().nullable(),
    counts: z.object({
      ero_entities: z.number(),
      ero_profile: z.number(),
      ero_hypotheses: z.number(),
      ero_evidence: z.number(),
      ero_findings: z.number(),
      ero_corpus_checks: z.number(),
    }),
    samples: z.object({
      ero_entities: z.array(z.any()),
      ero_profile: z.array(z.any()),
      ero_hypotheses: z.array(z.any()),
      ero_evidence: z.array(z.any()),
      ero_findings: z.array(z.any()),
      ero_corpus_checks: z.array(z.any()),
    }),
  }),

  async run(ctx, { runId, dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    if (!runId && !dealId) {
      throw new Error(
        "At least one of runId or dealId is required. Pass runId for a specific run, or dealId to inspect the most recent run for that deal.",
      );
    }

    // ── 1. Resolve target run ───────────────────────────────────────
    let dealRunCount: number | null = null;
    let resolvedRunId: string;

    if (runId) {
      resolvedRunId = runId;
    } else {
      // Most recent run for this deal
      const countRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_pipeline_state WHERE deal_id = $1`,
        CountRow,
        [dealId],
        { label: "Count deal runs" },
      );
      dealRunCount = countRows[0].cnt;

      const latestRows = await db.query(
        `SELECT run_id FROM ero_pipeline_state
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        z.object({ run_id: z.string() }),
        [dealId],
        { label: "Find latest run for deal" },
      );

      if (latestRows.length === 0) {
        throw new Error(`No ERO runs found for deal ${dealId}.`);
      }
      resolvedRunId = latestRows[0].run_id;
    }

    // ── 2. Load full pipeline_state row ─────────────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id, current_stage, stage_status,
              invocation_count, heartbeat_at::text, created_at::text, updated_at::text
       FROM ero_pipeline_state
       WHERE run_id = $1`,
      PipelineStateRow,
      [resolvedRunId],
      { label: "Load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(
        `ERO run not found: ${resolvedRunId}. Check the runId or dealId.`,
      );
    }

    const run = stateRows[0];

    // ── 3. Child table counts ───────────────────────────────────────
    // Direct run_id FK tables
    const [entitiesCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_entities WHERE run_id = $1`,
      CountRow, [resolvedRunId],
      { label: "Count ero_entities" },
    );
    const [profileCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_profile WHERE run_id = $1`,
      CountRow, [resolvedRunId],
      { label: "Count ero_profile" },
    );
    const [hypothesesCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_hypotheses WHERE run_id = $1`,
      CountRow, [resolvedRunId],
      { label: "Count ero_hypotheses" },
    );

    // Joined through hypothesis chain
    const [evidenceCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_evidence
       WHERE hypothesis_id IN (SELECT hypothesis_id FROM ero_hypotheses WHERE run_id = $1)`,
      CountRow, [resolvedRunId],
      { label: "Count ero_evidence" },
    );
    const [findingsCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_findings
       WHERE hypothesis_id IN (SELECT hypothesis_id FROM ero_hypotheses WHERE run_id = $1)`,
      CountRow, [resolvedRunId],
      { label: "Count ero_findings" },
    );
    const [corpusCount] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM ero_corpus_checks
       WHERE finding_id IN (
         SELECT finding_id FROM ero_findings
         WHERE hypothesis_id IN (SELECT hypothesis_id FROM ero_hypotheses WHERE run_id = $1)
       )`,
      CountRow, [resolvedRunId],
      { label: "Count ero_corpus_checks" },
    );

    const counts = {
      ero_entities: entitiesCount.cnt,
      ero_profile: profileCount.cnt,
      ero_hypotheses: hypothesesCount.cnt,
      ero_evidence: evidenceCount.cnt,
      ero_findings: findingsCount.cnt,
      ero_corpus_checks: corpusCount.cnt,
    };

    // ── 4. Bounded samples (5 rows each, most recent first) ─────────
    const entitiesSample = await db.query(
      `SELECT * FROM ero_entities WHERE run_id = $1 ORDER BY created_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_entities" },
    );
    const profileSample = await db.query(
      `SELECT * FROM ero_profile WHERE run_id = $1 ORDER BY created_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_profile" },
    );
    const hypothesesSample = await db.query(
      `SELECT * FROM ero_hypotheses WHERE run_id = $1 ORDER BY created_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_hypotheses" },
    );
    const evidenceSample = await db.query(
      `SELECT e.* FROM ero_evidence e
       JOIN ero_hypotheses h ON e.hypothesis_id = h.hypothesis_id
       WHERE h.run_id = $1
       ORDER BY e.retrieved_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_evidence" },
    );
    const findingsSample = await db.query(
      `SELECT f.* FROM ero_findings f
       JOIN ero_hypotheses h ON f.hypothesis_id = h.hypothesis_id
       WHERE h.run_id = $1
       ORDER BY f.created_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_findings" },
    );
    const corpusSample = await db.query(
      `SELECT cc.* FROM ero_corpus_checks cc
       JOIN ero_findings f ON cc.finding_id = f.finding_id
       JOIN ero_hypotheses h ON f.hypothesis_id = h.hypothesis_id
       WHERE h.run_id = $1
       ORDER BY cc.checked_at DESC LIMIT 5`,
      z.any(), [resolvedRunId],
      { label: "Sample ero_corpus_checks" },
    );

    const samples = {
      ero_entities: Array.isArray(entitiesSample) ? entitiesSample : [],
      ero_profile: Array.isArray(profileSample) ? profileSample : [],
      ero_hypotheses: Array.isArray(hypothesesSample) ? hypothesesSample : [],
      ero_evidence: Array.isArray(evidenceSample) ? evidenceSample : [],
      ero_findings: Array.isArray(findingsSample) ? findingsSample : [],
      ero_corpus_checks: Array.isArray(corpusSample) ? corpusSample : [],
    };

    return { run, dealRunCount, counts, samples };
  },
});
