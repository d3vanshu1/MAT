/**
 * Diagnostic API — Full Partial Node Ledger
 *
 * Produces a complete diagnostic ledger for all partial/incomplete merge nodes
 * in a given run. Used for recovery planning — READ ONLY.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const PartialNodeSchema = z.object({
  id: z.string(),
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  updated_at: z.string(),
  input_hash: z.string().nullable(),
  findings_count: z.coerce.number(),
  payload_bytes: z.coerce.number(),
  error_text: z.string().nullable(),
  checkpoint_version: z.coerce.number(),
  claimed_by: z.string().nullable(),
  claimed_at: z.string().nullable(),
  model_used: z.string().nullable(),
  child_count: z.coerce.number(),
  has_executive_header: z.boolean(),
  has_findings: z.boolean(),
  attempt_count: z.coerce.number(),
});

const NodeLedgerEntry = z.object({
  id: z.string(),
  treeLevel: z.number(),
  nodeIndex: z.number(),
  status: z.string().nullable(),
  updatedAt: z.string(),
  inputHash: z.string().nullable(),
  findingsCount: z.number(),
  payloadBytes: z.number(),
  errorText: z.string().nullable(),
  checkpointVersion: z.number(),
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  modelUsed: z.string().nullable(),
  childCount: z.number(),
  hasExecutiveHeader: z.boolean(),
  hasFindings: z.boolean(),
  attemptCount: z.number(),
  // Computed fields
  hasCompleteOutput: z.boolean(),
  recommendedAction: z.string(),
});

export default api({
  name: "DiagPartialNodeLedger",
  description: "Full diagnostic ledger for all partial merge nodes in a run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    level: z.number().optional().describe("Filter to specific level; omit for all levels"),
    offset: z.number().default(0),
  }),

  output: z.object({
    nodes: z.array(NodeLedgerEntry),
    totalPartialCount: z.number(),
    summary: z.object({
      l1Partial: z.number(),
      l2Partial: z.number(),
      l3Partial: z.number(),
      l4Partial: z.number(),
    }),
  }),

  async run(ctx, { runId, level, offset }) {
    // Get total counts first
    const countRows = await ctx.integrations.db.query(
      `SELECT tree_level, COUNT(*)::int as cnt
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND node_index >= 0
         AND (status IS NULL OR status != 'complete')
         AND tree_level <= 4
       GROUP BY tree_level
       ORDER BY tree_level`,
      z.object({ tree_level: z.coerce.number(), cnt: z.coerce.number() }),
      [runId],
      { label: "Count partial nodes by level" }
    );

    const summary = {
      l1Partial: countRows.find(r => r.tree_level === 1)?.cnt ?? 0,
      l2Partial: countRows.find(r => r.tree_level === 2)?.cnt ?? 0,
      l3Partial: countRows.find(r => r.tree_level === 3)?.cnt ?? 0,
      l4Partial: countRows.find(r => r.tree_level === 4)?.cnt ?? 0,
    };
    const totalPartialCount = summary.l1Partial + summary.l2Partial + summary.l3Partial + summary.l4Partial;

    // Query the partial nodes (10 at a time due to limits)
    const levelFilter = level !== undefined ? `AND tree_level = ${level}` : `AND tree_level <= 4`;
    
    const rows = await ctx.integrations.db.query(
      `SELECT 
        id,
        tree_level,
        node_index,
        status,
        updated_at::text AS updated_at,
        input_hash,
        jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb))::int AS findings_count,
        octet_length(merged_json::text)::int AS payload_bytes,
        merged_json->>'error' AS error_text,
        COALESCE((merged_json->>'checkpoint_version')::int, 0) AS checkpoint_version,
        merged_json->>'claimed_by' AS claimed_by,
        merged_json->>'claimed_at' AS claimed_at,
        merged_json->>'model_used' AS model_used,
        COALESCE(jsonb_array_length(COALESCE(merged_json->'child_ids', '[]'::jsonb)), 0)::int AS child_count,
        (merged_json->>'executive_header' IS NOT NULL AND merged_json->>'executive_header' != '') AS has_executive_header,
        (jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) > 0) AS has_findings,
        COALESCE((merged_json->>'attempt_count')::int, 1) AS attempt_count
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND node_index >= 0
         AND (status IS NULL OR status != 'complete')
         ${levelFilter}
       ORDER BY tree_level, node_index
       LIMIT 10 OFFSET $2`,
      PartialNodeSchema,
      [runId, offset],
      { label: `Partial nodes (offset=${offset})` }
    );

    const nodes: z.infer<typeof NodeLedgerEntry>[] = rows.map(row => {
      // Determine recommended action
      let recommendedAction = "rebuild";
      
      if (row.findings_count > 0 && row.has_executive_header) {
        // Has output — might just need status update
        recommendedAction = "mark_complete_after_validation";
      } else if (row.error_text) {
        recommendedAction = "rebuild";
      } else if (row.findings_count === 0 && row.payload_bytes < 100) {
        recommendedAction = "rebuild";
      } else if (row.status === null) {
        // Never started
        recommendedAction = "wait_for_children";
      }

      return {
        id: row.id,
        treeLevel: row.tree_level,
        nodeIndex: row.node_index,
        status: row.status,
        updatedAt: row.updated_at,
        inputHash: row.input_hash,
        findingsCount: row.findings_count,
        payloadBytes: row.payload_bytes,
        errorText: row.error_text,
        checkpointVersion: row.checkpoint_version,
        claimedBy: row.claimed_by,
        claimedAt: row.claimed_at,
        modelUsed: row.model_used,
        childCount: row.child_count,
        hasExecutiveHeader: row.has_executive_header,
        hasFindings: row.has_findings,
        attemptCount: row.attempt_count,
        hasCompleteOutput: row.findings_count > 0 && row.has_executive_header,
        recommendedAction,
      };
    });

    return { nodes, totalPartialCount, summary };
  },
});
