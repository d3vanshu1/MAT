/**
 * ReadL3ExportChunk — Reads a paginated slice of findings from the consolidated
 * L3 export checkpoint (tree_level=98). Returns findings in batches to avoid
 * testApi output truncation.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExportCheckpointSchema = z.object({
  id: z.string(),
  merged_json: z.any(),
});

export default api({
  name: "ReadL3ExportChunk",
  description: "Reads paginated findings from consolidated L3 export checkpoint.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    offset: z.number().min(0).default(0),
    limit: z.number().min(1).max(20).default(15),
  }),

  output: z.object({
    findings: z.any(),
    offset: z.number(),
    limit: z.number(),
    total_findings: z.number(),
    has_more: z.boolean(),
    metadata: z.any().nullable(),
  }),

  async run(ctx, { runId, offset, limit }) {
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98 AND node_index = 0
       LIMIT 1`,
      ExportCheckpointSchema,
      [runId],
      { label: "Load L3 export checkpoint" }
    );

    if (rows.length === 0) {
      throw new Error("No L3 export checkpoint found. Run ConsolidateL3Export first.");
    }

    const payload = typeof rows[0].merged_json === "string"
      ? JSON.parse(rows[0].merged_json)
      : rows[0].merged_json;

    const allFindings = payload.findings || [];
    const total = allFindings.length;
    const slice = allFindings.slice(offset, offset + limit);

    return {
      findings: slice,
      offset,
      limit,
      total_findings: total,
      has_more: offset + limit < total,
      metadata: offset === 0 ? payload._export_metadata : null,
    };
  },
});
