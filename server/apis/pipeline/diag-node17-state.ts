/**
 * Quick diagnostic: read the current state of a specific merge checkpoint node,
 * plus overall L1 stats.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagNode17State",
  description: "Reads current state of a specific merge checkpoint node plus L1 summary",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string(),
    treeLevel: z.number(),
    nodeIndex: z.number(),
  }),
  output: z.object({
    found: z.boolean(),
    status: z.string().nullable(),
    truncated: z.boolean().nullable(),
    truncationCount: z.number().nullable(),
    findingsCount: z.number(),
    modelUsed: z.string().nullable(),
    promptVersion: z.string().nullable(),
    updatedAt: z.string().nullable(),
    jsonByteLength: z.number(),
    l1Summary: z.object({
      totalNodes: z.number(),
      completeNodes: z.number(),
      partialNodes: z.number(),
      maxNodeIndex: z.number(),
      analysisResultCount: z.number(),
    }),
  }),
  async run(ctx, { runId, treeLevel, nodeIndex }) {
    const rows = await ctx.integrations.db.query(
      `SELECT status,
              (merged_json->>'truncated')::boolean AS truncated,
              (merged_json->>'truncation_count')::int AS truncation_count,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
              model_used,
              prompt_version,
              updated_at::text AS updated_at,
              octet_length(merged_json::text) AS json_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
       LIMIT 1`,
      z.object({
        status: z.string().nullable(),
        truncated: z.boolean().nullable(),
        truncation_count: z.coerce.number().nullable(),
        findings_count: z.coerce.number(),
        model_used: z.string().nullable(),
        prompt_version: z.string().nullable(),
        updated_at: z.string().nullable(),
        json_bytes: z.coerce.number(),
      }),
      [runId, treeLevel, nodeIndex],
      { label: `Diag: read node L${treeLevel}:N${nodeIndex}` }
    );

    // L1 summary
    const [summary] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS total_nodes,
              COUNT(*) FILTER (WHERE status = 'complete')::int AS complete_nodes,
              COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_nodes,
              MAX(node_index)::int AS max_node_index
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = $2 AND node_index >= 0`,
      z.object({
        total_nodes: z.coerce.number(),
        complete_nodes: z.coerce.number(),
        partial_nodes: z.coerce.number(),
        max_node_index: z.coerce.number(),
      }),
      [runId, treeLevel],
      { label: `Diag: L${treeLevel} summary` }
    );

    // Analysis results count
    const [analysisCount] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Diag: analysis result count" }
    );

    if (rows.length === 0) {
      return {
        found: false,
        status: null,
        truncated: null,
        truncationCount: null,
        findingsCount: 0,
        modelUsed: null,
        promptVersion: null,
        updatedAt: null,
        jsonByteLength: 0,
        l1Summary: {
          totalNodes: summary.total_nodes,
          completeNodes: summary.complete_nodes,
          partialNodes: summary.partial_nodes,
          maxNodeIndex: summary.max_node_index,
          analysisResultCount: analysisCount.cnt,
        },
      };
    }

    const r = rows[0];
    return {
      found: true,
      status: r.status,
      truncated: r.truncated,
      truncationCount: r.truncation_count,
      findingsCount: r.findings_count,
      modelUsed: r.model_used,
      promptVersion: r.prompt_version,
      updatedAt: r.updated_at,
      jsonByteLength: r.json_bytes,
      l1Summary: {
        totalNodes: summary.total_nodes,
        completeNodes: summary.complete_nodes,
        partialNodes: summary.partial_nodes,
        maxNodeIndex: summary.max_node_index,
        analysisResultCount: analysisCount.cnt,
      },
    };
  },
});
