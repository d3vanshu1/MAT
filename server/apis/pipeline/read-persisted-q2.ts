/**
 * ReadPersistedQ2Artifact — Reads the persisted Q2 artifact for artifact export
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ReadPersistedQ2Artifact",
  description: "Reads persisted Q2 candidates artifact from tree_level=100",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    offset: z.number().default(0),
    limit: z.number().default(50),
  }),

  output: z.object({
    artifact_id: z.string(),
    total_candidates: z.number(),
    reportable_count: z.number(),
    offset: z.number(),
    limit: z.number(),
    returned: z.number(),
    has_more: z.boolean(),
    candidates: z.array(z.any()),
  }),

  async run(ctx, { runId, offset, limit }) {
    const Row = z.object({ id: z.string(), merged_json: z.any() });
    const rows = await ctx.integrations.db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 100 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      Row,
      [runId],
      { label: "Read persisted Q2 artifact" }
    );

    if (rows.length === 0) {
      return { artifact_id: "", total_candidates: 0, reportable_count: 0, offset, limit, returned: 0, has_more: false, candidates: [] };
    }

    const artifact = rows[0].merged_json;
    const allCandidates = artifact.candidates || [];
    const page = allCandidates.slice(offset, offset + limit);

    return {
      artifact_id: rows[0].id,
      total_candidates: allCandidates.length,
      reportable_count: artifact.reportable_count || 0,
      offset,
      limit,
      returned: page.length,
      has_more: offset + limit < allCandidates.length,
      candidates: page,
    };
  },
});
