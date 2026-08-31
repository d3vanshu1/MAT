/**
 * mast-reset-pipeline.ts
 *
 * Deletes all mast_pipeline_state rows for a given runId, including the _lock row.
 * Exists so the resume behaviour can be tested repeatedly.
 *
 * Touches mast_pipeline_state only — no other MAST table.
 * MAST owns this API end to end. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "MastResetPipeline",
  description: "Resets MAST pipeline state for a run",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
  }),

  output: z.object({
    deleted: z.number(),
    message: z.string(),
  }),

  async run(ctx, { runId }) {
    const result = await ctx.integrations.ic_diligence_db.execute(
      `DELETE FROM mast_pipeline_state WHERE run_id = $1::uuid`,
      [runId],
      { label: "MAST reset pipeline state" },
    );

    const deleted = typeof result?.rowCount === "number" ? result.rowCount : 0;
    console.log(`[MAST-RESET] Deleted ${deleted} rows for run ${runId}.`);

    return {
      deleted,
      message: `Deleted ${deleted} mast_pipeline_state rows for run ${runId}.`,
    };
  },
});
