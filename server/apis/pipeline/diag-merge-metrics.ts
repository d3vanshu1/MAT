/**
 * Diagnostic API — Merge Metrics (MR-0)
 *
 * Measures the merge tree's input-size / output / carry-forward picture
 * on an EXISTING checkpointed run. Read-only — no mutations, no pipeline
 * triggers, no schema changes.
 *
 * Per node: input/output/carried-forward finding counts, truncation,
 *   JSON byte sizes, model used, status, persistence timestamp.
 * Per level: aggregates + collapse ratio + persistence-span proxy.
 * Run-wide rollup: total nodes, truncated count, carry-forward totals.
 *
 * IMPORTANT LIMITATION (encoded in output):
 *   updated_at is stamped at persistence time. Nodes in a batch
 *   (MERGE_CONCURRENCY=5) write near-simultaneously, so updated_at
 *   deltas are NOT per-call LLM latency. The field "level_persist_span_ms"
 *   is a persistence-span proxy only.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Row-level schema from the query
// ---------------------------------------------------------------------------
const NodeMetricRowSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  model_used: z.string().nullable(),
  updated_at: z.string().nullable(),
  input_finding_count: z.coerce.number().nullable(),
  output_finding_count: z.coerce.number().nullable(),
  carried_forward_count: z.coerce.number().nullable(),
  truncated: z.boolean(),
  truncation_count: z.coerce.number().nullable(),
  merged_json_bytes: z.coerce.number(),
  node_text_bytes: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------
const NodeMetricSchema = z.object({
  tree_level: z.number(),
  node_index: z.number(),
  status: z.string().nullable(),
  model_used: z.string().nullable(),
  updated_at: z.string().nullable(),
  input_finding_count: z.number().nullable(),
  output_finding_count: z.number().nullable(),
  carried_forward_count: z.number().nullable(),
  truncated: z.boolean(),
  truncation_count: z.number().nullable(),
  merged_json_bytes: z.number(),
  node_text_bytes: z.number(),
});

const LevelAggregateSchema = z.object({
  tree_level: z.number(),
  node_count: z.number(),
  nodes_complete: z.number(),
  nodes_partial: z.number(),
  nodes_error: z.number(),
  nodes_other: z.number(),
  sum_input_findings: z.number(),
  sum_output_findings: z.number(),
  collapse_ratio: z.number().nullable().describe("output/input ratio for this level (null if input=0)"),
  sum_carried_forward: z.number(),
  nodes_with_carry_forward: z.number(),
  truncated_node_count: z.number(),
  level_persist_span_ms: z.number().nullable().describe(
    "max(updated_at) - min(updated_at) for this level in milliseconds. " +
    "This is a PERSISTENCE-SPAN PROXY, NOT summed per-call LLM latency. " +
    "Nodes in a batch (MERGE_CONCURRENCY=5) write near-simultaneously."
  ),
});

const RunRollupSchema = z.object({
  total_nodes: z.number(),
  nodes_by_status: z.record(z.string(), z.number()),
  truncated_node_count: z.number(),
  total_carried_forward: z.number(),
  pct_nodes_with_carry_forward: z.number().nullable(),
  level_count: z.number(),
  latency_note: z.string().describe(
    "Explicit statement that per-call LLM latency cannot be recovered from stored checkpoints."
  ),
});

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------
export default api({
  name: "DiagMergeMetrics",
  description: "Read-only merge-tree metrics: per-node sizes, carry-forward, truncation, and persistence-span proxy",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    nodes: z.array(NodeMetricSchema),
    levels: z.array(LevelAggregateSchema),
    rollup: RunRollupSchema,
  }),

  async run(ctx, { runId }) {
    // -----------------------------------------------------------------
    // Single query: pull every node for the run with the 10 required fields
    // -----------------------------------------------------------------
    const rows = await ctx.integrations.db.query(
      `SELECT
         tree_level,
         node_index,
         status,
         model_used,
         updated_at::text AS updated_at,
         (merged_json->'_accounting'->>'inputFindingCount')::int   AS input_finding_count,
         (merged_json->'_accounting'->>'outputFindingCount')::int  AS output_finding_count,
         (merged_json->'_accounting'->>'carriedForwardCount')::int AS carried_forward_count,
         COALESCE(merged_json->>'truncated', 'false') = 'true'    AS truncated,
         (merged_json->>'truncation_count')::int                   AS truncation_count,
         octet_length(merged_json::text)                           AS merged_json_bytes,
         octet_length(COALESCE(merged_json->>'text', ''))          AS node_text_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level ASC, node_index ASC`,
      NodeMetricRowSchema,
      [runId],
      { label: "DiagMergeMetrics: fetch all nodes" }
    );

    // -----------------------------------------------------------------
    // Build per-node output
    // -----------------------------------------------------------------
    const nodes = rows.map((r) => ({
      tree_level: r.tree_level,
      node_index: r.node_index,
      status: r.status,
      model_used: r.model_used,
      updated_at: r.updated_at,
      input_finding_count: r.input_finding_count,
      output_finding_count: r.output_finding_count,
      carried_forward_count: r.carried_forward_count,
      truncated: r.truncated,
      truncation_count: r.truncation_count,
      merged_json_bytes: r.merged_json_bytes,
      node_text_bytes: r.node_text_bytes,
    }));

    // -----------------------------------------------------------------
    // Build per-level aggregates
    // -----------------------------------------------------------------
    const levelMap = new Map<number, typeof rows>();
    for (const r of rows) {
      if (!levelMap.has(r.tree_level)) levelMap.set(r.tree_level, []);
      levelMap.get(r.tree_level)!.push(r);
    }

    const levels: Array<z.infer<typeof LevelAggregateSchema>> = [];
    for (const [treeLevel, levelRows] of Array.from(levelMap.entries()).sort((a, b) => a[0] - b[0])) {
      const nodeCount = levelRows.length;
      const nodesComplete = levelRows.filter((r) => r.status === "complete").length;
      const nodesPartial = levelRows.filter((r) => r.status === "partial").length;
      const nodesError = levelRows.filter((r) => r.status === "error").length;
      const nodesOther = nodeCount - nodesComplete - nodesPartial - nodesError;

      const sumInput = levelRows.reduce((s, r) => s + (r.input_finding_count ?? 0), 0);
      const sumOutput = levelRows.reduce((s, r) => s + (r.output_finding_count ?? 0), 0);
      const collapseRatio = sumInput > 0
        ? Math.round((sumOutput / sumInput) * 10000) / 10000
        : null;

      const sumCarried = levelRows.reduce((s, r) => s + (r.carried_forward_count ?? 0), 0);
      const nodesWithCarry = levelRows.filter((r) => (r.carried_forward_count ?? 0) > 0).length;
      const truncatedCount = levelRows.filter((r) => r.truncated).length;

      // Persistence-span proxy
      let persistSpanMs: number | null = null;
      const timestamps = levelRows
        .map((r) => r.updated_at)
        .filter((t): t is string => t != null)
        .map((t) => new Date(t).getTime())
        .filter((n) => !isNaN(n));
      if (timestamps.length >= 2) {
        persistSpanMs = Math.max(...timestamps) - Math.min(...timestamps);
      }

      levels.push({
        tree_level: treeLevel,
        node_count: nodeCount,
        nodes_complete: nodesComplete,
        nodes_partial: nodesPartial,
        nodes_error: nodesError,
        nodes_other: nodesOther,
        sum_input_findings: sumInput,
        sum_output_findings: sumOutput,
        collapse_ratio: collapseRatio,
        sum_carried_forward: sumCarried,
        nodes_with_carry_forward: nodesWithCarry,
        truncated_node_count: truncatedCount,
        level_persist_span_ms: persistSpanMs,
      });
    }

    // -----------------------------------------------------------------
    // Run-wide rollup
    // -----------------------------------------------------------------
    const totalNodes = rows.length;
    const statusCounts: Record<string, number> = {};
    for (const r of rows) {
      const key = r.status ?? "null";
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }
    const truncatedTotal = rows.filter((r) => r.truncated).length;
    const totalCarried = rows.reduce((s, r) => s + (r.carried_forward_count ?? 0), 0);
    const nodesWithCarryTotal = rows.filter((r) => (r.carried_forward_count ?? 0) > 0).length;
    const pctWithCarry = totalNodes > 0
      ? Math.round((nodesWithCarryTotal / totalNodes) * 10000) / 100
      : null;

    const rollup: z.infer<typeof RunRollupSchema> = {
      total_nodes: totalNodes,
      nodes_by_status: statusCounts,
      truncated_node_count: truncatedTotal,
      total_carried_forward: totalCarried,
      pct_nodes_with_carry_forward: pctWithCarry,
      level_count: levels.length,
      latency_note:
        "Per-call LLM latency CANNOT be recovered from stored checkpoints. " +
        "updated_at is stamped at persistence time and nodes in a batch (MERGE_CONCURRENCY=5) " +
        "write near-simultaneously. level_persist_span_ms is a persistence-span proxy only.",
    };

    return { nodes, levels, rollup };
  },
});
