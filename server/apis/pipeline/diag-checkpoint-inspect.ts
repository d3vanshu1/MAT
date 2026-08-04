/**
 * DiagCheckpointInspect — Read-only diagnostic to inspect specific merge checkpoint nodes.
 * Returns timestamps, status, finding counts, and payload metadata for requested nodes.
 * Used for safety verification before retry operations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const NodeQuerySchema = z.object({
  id: z.string(),
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  updated_at: z.string(),
  model_used: z.string().nullable(),
  prompt_version: z.string().nullable(),
  input_hash: z.string().nullable(),
  findings_count: z.coerce.number(),
  payload_bytes: z.coerce.number(),
  has_error: z.boolean(),
  error_text: z.string().nullable(),
  recovery_worker: z.boolean().nullable(),
  timestamp_in_payload: z.string().nullable(),
  checkpoint_version: z.coerce.number(),
  claimed_by: z.string().nullable(),
  claimed_at: z.string().nullable(),
  payload_hash: z.string().nullable(),
});

export default api({
  name: "DiagCheckpointInspect",
  description: "Read-only inspection of specific merge checkpoint nodes for safety verification",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    nodes: z.array(z.object({
      level: z.number(),
      index: z.number(),
    })).max(10),
  }),

  output: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      treeLevel: z.number(),
      nodeIndex: z.number(),
      status: z.string().nullable(),
      updatedAt: z.string(),
      modelUsed: z.string().nullable(),
      promptVersion: z.string().nullable(),
      inputHash: z.string().nullable(),
      findingsCount: z.number(),
      payloadBytes: z.number(),
      hasError: z.boolean(),
      errorText: z.string().nullable(),
      recoveryWorker: z.boolean().nullable(),
      timestampInPayload: z.string().nullable(),
      checkpointVersion: z.number(),
      claimedBy: z.string().nullable(),
      claimedAt: z.string().nullable(),
      payloadHash: z.string().nullable(),
    })),
    // All L1 nodes summary: level, index, status, updated_at
    allL1Summary: z.array(z.object({
      nodeIndex: z.coerce.number(),
      status: z.string().nullable(),
      updatedAt: z.string(),
      findingsCount: z.coerce.number(),
    })),
  }),

  async run(ctx, { runId, nodes }) {
    // Query specific requested nodes
    const results = [];
    for (const node of nodes) {
      const rows = await ctx.integrations.db.query(
        `SELECT id::text, tree_level, node_index, status, updated_at::text AS updated_at,
                model_used, prompt_version, input_hash,
                jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
                octet_length(merged_json::text) AS payload_bytes,
                (merged_json ? 'error') AS has_error,
                CASE WHEN merged_json ? 'error' THEN merged_json->>'error' ELSE NULL END AS error_text,
                (merged_json->>'recoveryWorker')::boolean AS recovery_worker,
                merged_json->>'timestamp' AS timestamp_in_payload,
                checkpoint_version,
                claimed_by,
                claimed_at::text AS claimed_at,
                payload_hash
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
         LIMIT 1`,
        NodeQuerySchema,
        [runId, node.level, node.index],
        { label: `Inspect node L${node.level}:N${node.index}` }
      );
      if (rows.length > 0) {
        const r = rows[0];
        results.push({
          id: r.id,
          treeLevel: r.tree_level,
          nodeIndex: r.node_index,
          status: r.status,
          updatedAt: r.updated_at,
          modelUsed: r.model_used,
          promptVersion: r.prompt_version,
          inputHash: r.input_hash,
          findingsCount: r.findings_count,
          payloadBytes: r.payload_bytes,
          hasError: r.has_error,
          errorText: r.error_text,
          recoveryWorker: r.recovery_worker,
          timestampInPayload: r.timestamp_in_payload,
          checkpointVersion: r.checkpoint_version,
          claimedBy: r.claimed_by,
          claimedAt: r.claimed_at,
          payloadHash: r.payload_hash,
        });
      }
    }

    // Get all L1 nodes summary
    const l1Summary = await ctx.integrations.db.query(
      `SELECT node_index,
              status,
              updated_at::text AS updated_at,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 1 AND node_index >= 0
       ORDER BY node_index
       LIMIT 100`,
      z.object({
        node_index: z.coerce.number(),
        status: z.string().nullable(),
        updated_at: z.string(),
        findings_count: z.coerce.number(),
      }),
      [runId],
      { label: "All L1 nodes summary" }
    );

    return {
      nodes: results,
      allL1Summary: l1Summary.map(r => ({
        nodeIndex: r.node_index,
        status: r.status,
        updatedAt: r.updated_at,
        findingsCount: r.findings_count,
      })),
    };
  },
});
