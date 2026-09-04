/**
 * ERO v2 — Purge all ERO state for a deal.
 *
 * Deletes ero_pipeline_state rows for the given deal_id.
 * ON DELETE CASCADE in migration 035 removes all child rows:
 *   ero_entities, ero_profile, ero_hypotheses →
 *   ero_evidence, ero_findings → ero_corpus_checks.
 *
 * HARD SCOPE FENCE: the ONLY table named in any DELETE is
 * ero_pipeline_state. No other table is touched.
 *
 * Returns before/after counts for audit.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountRow = z.object({ cnt: z.coerce.number() });

export default api({
  name: "EroPurgeDealState",
  description: "Purge all ERO pipeline state for a deal (cascade deletes children)",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    dealId: z.string(),
    before: z.object({
      runs: z.number(),
      entities: z.number(),
      profile: z.number(),
      hypotheses: z.number(),
      evidence: z.number(),
      findings: z.number(),
      corpus_checks: z.number(),
    }),
    deletedRuns: z.number(),
    after: z.object({
      runs: z.number(),
      entities: z.number(),
      profile: z.number(),
      hypotheses: z.number(),
      evidence: z.number(),
      findings: z.number(),
      corpus_checks: z.number(),
    }),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── Helper: count rows for a deal across ERO tables ─────────────
    async function countAll(label: string) {
      const [runs] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_pipeline_state WHERE deal_id = $1`,
        CountRow, [dealId],
        { label: `${label}: count runs` },
      );
      const [entities] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_entities
         WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)`,
        CountRow, [dealId],
        { label: `${label}: count entities` },
      );
      const [profile] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_profile
         WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)`,
        CountRow, [dealId],
        { label: `${label}: count profile` },
      );
      const [hypotheses] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_hypotheses
         WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)`,
        CountRow, [dealId],
        { label: `${label}: count hypotheses` },
      );
      const [evidence] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_evidence
         WHERE hypothesis_id IN (
           SELECT hypothesis_id FROM ero_hypotheses
           WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)
         )`,
        CountRow, [dealId],
        { label: `${label}: count evidence` },
      );
      const [findings] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_findings
         WHERE hypothesis_id IN (
           SELECT hypothesis_id FROM ero_hypotheses
           WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)
         )`,
        CountRow, [dealId],
        { label: `${label}: count findings` },
      );
      const [corpus_checks] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ero_corpus_checks
         WHERE finding_id IN (
           SELECT finding_id FROM ero_findings
           WHERE hypothesis_id IN (
             SELECT hypothesis_id FROM ero_hypotheses
             WHERE run_id IN (SELECT run_id FROM ero_pipeline_state WHERE deal_id = $1)
           )
         )`,
        CountRow, [dealId],
        { label: `${label}: count corpus_checks` },
      );

      return {
        runs: runs.cnt,
        entities: entities.cnt,
        profile: profile.cnt,
        hypotheses: hypotheses.cnt,
        evidence: evidence.cnt,
        findings: findings.cnt,
        corpus_checks: corpus_checks.cnt,
      };
    }

    // ── 1. Before-counts ────────────────────────────────────────────
    const before = await countAll("Before purge");

    if (before.runs === 0) {
      return {
        dealId,
        before,
        deletedRuns: 0,
        after: before,
      };
    }

    // ── 2. DELETE — only ero_pipeline_state, cascade handles rest ───
    const DeletedCountRow = z.object({ deleted: z.coerce.number() });
    const [deleteResult] = await db.query(
      `WITH deleted AS (
        DELETE FROM ero_pipeline_state
        WHERE deal_id = $1
        RETURNING run_id
      ) SELECT COUNT(*)::int AS deleted FROM deleted`,
      DeletedCountRow,
      [dealId],
      { label: "Purge: DELETE ero_pipeline_state for deal" },
    );

    // ── 3. After-counts ─────────────────────────────────────────────
    const after = await countAll("After purge");

    return {
      dealId,
      before,
      deletedRuns: deleteResult.deleted,
      after,
    };
  },
});
