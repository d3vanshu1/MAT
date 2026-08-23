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
  truncated: z.boolean(),
  truncation_count: z.coerce.number(),
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
  truncated: z.boolean(),
  truncationCount: z.number(),
  // Computed fields
  hasCompleteOutput: z.boolean(),
  recommendedAction: z.string(),
});

const LevelBreakdown = z.object({
  treeLevel: z.number(),
  complete: z.number(),
  partial: z.number(),
  errored: z.number(),
  other: z.number(),
  total: z.number(),
  findingsSum: z.number(),
  findingsMax: z.number(),
  payloadMaxBytes: z.number(),
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
    maxLevel: z.number().default(4).describe("Upper bound on tree_level for the node listing"),
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
    // Full-tree status breakdown across ALL levels (not capped)
    levels: z.array(LevelBreakdown),
  }),

  async run(ctx, { runId, level, maxLevel, offset }) {
    // Full-tree status breakdown across every level — aggregate, so no row cap needed.
    const levelRows = await ctx.integrations.db.query(
      `SELECT tree_level,
              COUNT(*) FILTER (WHERE status = 'complete' OR status IS NULL)::int AS complete,
              COUNT(*) FILTER (WHERE status = 'partial')::int AS partial,
              COUNT(*) FILTER (WHERE status IN ('error','failed'))::int AS errored,
              COUNT(*)::int AS total,
              COALESCE(SUM(jsonb_array_length(COALESCE(merged_json->'findings','[]'::jsonb))),0)::int AS findings_sum,
              COALESCE(MAX(jsonb_array_length(COALESCE(merged_json->'findings','[]'::jsonb))),0)::int AS findings_max,
              COALESCE(MAX(octet_length(merged_json::text)),0)::int AS payload_max
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index >= 0
       GROUP BY tree_level
       ORDER BY tree_level`,
      z.object({
        tree_level: z.coerce.number(),
        complete: z.coerce.number(),
        partial: z.coerce.number(),
        errored: z.coerce.number(),
        total: z.coerce.number(),
        findings_sum: z.coerce.number(),
        findings_max: z.coerce.number(),
        payload_max: z.coerce.number(),
      }),
      [runId],
      { label: "Full-tree status breakdown by level" }
    );

    const levels = levelRows.map(r => ({
      treeLevel: r.tree_level,
      complete: r.complete,
      partial: r.partial,
      errored: r.errored,
      other: r.total - r.complete - r.partial - r.errored,
      total: r.total,
      findingsSum: r.findings_sum,
      findingsMax: r.findings_max,
      payloadMaxBytes: r.payload_max,
    }));

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
    const levelFilter = level !== undefined
      ? `AND tree_level = ${Math.trunc(level)}`
      : `AND tree_level <= ${Math.trunc(maxLevel)}`;
    
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
        COALESCE((merged_json->>'attempt_count')::int, 1) AS attempt_count,
        COALESCE((merged_json->>'truncated')::boolean, false) AS truncated,
        COALESCE((merged_json->>'truncation_count')::int, 0) AS truncation_count
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

      // Deadlock signature: the merge loop ACCEPTS partial+truncated nodes once
      // truncation_count >= MAX_PARTIAL_RETRIES (2) and stops retrying them, but
      // never promotes the DB row to 'complete'. The publication gate reads DB
      // status, so these block publication forever.
      if (row.status === "partial" && row.truncated && row.truncation_count >= 2) {
        recommendedAction = "accepted_partial_blocks_gate";
      } else if (row.findings_count > 0 && row.has_executive_header) {
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
        truncated: row.truncated,
        truncationCount: row.truncation_count,
        hasCompleteOutput: row.findings_count > 0 && row.has_executive_header,
        recommendedAction,
      };
    });

    return { nodes, totalPartialCount, summary, levels };
  },
});
