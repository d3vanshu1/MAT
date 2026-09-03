/**
 * mast-purge-run.ts
 *
 * Deletes all MAST data for a single run_id across five tables:
 *   mast_findings, mast_support_evidence, mast_reliance_links,
 *   mast_assumptions, mast_pipeline_state.
 *
 * Order respects foreign keys:
 *   mast_findings.assumption_id → mast_assumptions.id
 *   mast_support_evidence.assumption_id → mast_assumptions.id
 *   Therefore findings and evidence are deleted before assumptions.
 *
 * Does NOT touch module_runs, module_outputs, documents, document_chunks,
 * doc_tables, or any non-MAST table.
 *
 * No transaction wrapper — if a delete fails, the error surfaces with the
 * table name and how far the purge got.
 *
 * MAST owns this API end to end. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const LOG_PREFIX = "[MAST-PURGE]";

const BeforeCountRow = z.object({
  origin_type: z.string(),
  cnt: z.coerce.number(),
});

export default api({
  name: "MastPurgeRun",
  description: "Purges all MAST data for one run across findings, evidence, links, assumptions, and pipeline state",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    confirm: z.boolean(),
  }),

  output: z.object({
    beforeCounts: z.array(z.object({
      origin_type: z.string(),
      count: z.number(),
    })),
    deletedFindings: z.number(),
    deletedSupportEvidence: z.number(),
    deletedRelianceLinks: z.number(),
    deletedAssumptions: z.number(),
    deletedPipelineState: z.number(),
    message: z.string(),
  }),

  async run(ctx, { runId, confirm }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── 1. Pre-delete audit: count assumptions by origin_type ────────
    const beforeRows = await db.query(
      `SELECT origin_type, COUNT(*)::int AS cnt
       FROM mast_assumptions
       WHERE run_id = $1::uuid
       GROUP BY origin_type
       ORDER BY origin_type`,
      BeforeCountRow,
      [runId],
      { label: `${LOG_PREFIX} count assumptions by origin_type` },
    );

    const beforeCounts = beforeRows.map((r) => ({
      origin_type: r.origin_type,
      count: r.cnt,
    }));

    console.log(
      `${LOG_PREFIX} Run ${runId} before-counts: ${JSON.stringify(beforeCounts)}`,
    );

    // ── 2. Guard: require explicit confirmation ─────────────────────
    if (confirm !== true) {
      return {
        beforeCounts,
        deletedFindings: 0,
        deletedSupportEvidence: 0,
        deletedRelianceLinks: 0,
        deletedAssumptions: 0,
        deletedPipelineState: 0,
        message: `Confirmation was not given. No data was deleted. Run ${runId} has ${beforeRows.length} origin_type(s).`,
      };
    }

    // ── 3. Delete in FK-safe order ──────────────────────────────────
    const deleteAndCount = async (table: string): Promise<number> => {
      const result = await db.execute(
        `DELETE FROM ${table} WHERE run_id = $1::uuid`,
        [runId],
        { label: `${LOG_PREFIX} delete from ${table}` },
      );
      const count = typeof result?.rowCount === "number" ? result.rowCount : 0;
      console.log(`${LOG_PREFIX} ${table}: deleted ${count} rows.`);
      return count;
    };

    // FK children first: mast_findings and mast_support_evidence
    // reference mast_assumptions.id via assumption_id.
    const deletedFindings = await deleteAndCount("mast_findings");
    const deletedSupportEvidence = await deleteAndCount("mast_support_evidence");
    const deletedRelianceLinks = await deleteAndCount("mast_reliance_links");
    const deletedAssumptions = await deleteAndCount("mast_assumptions");
    const deletedPipelineState = await deleteAndCount("mast_pipeline_state");

    const totalDeleted =
      deletedFindings + deletedSupportEvidence + deletedRelianceLinks +
      deletedAssumptions + deletedPipelineState;

    console.log(
      `${LOG_PREFIX} Purge complete for run ${runId}. Total rows deleted: ${totalDeleted}.`,
    );

    return {
      beforeCounts,
      deletedFindings,
      deletedSupportEvidence,
      deletedRelianceLinks,
      deletedAssumptions,
      deletedPipelineState,
      message: `Purged run ${runId}: ${totalDeleted} total rows deleted across 5 tables.`,
    };
  },
});
