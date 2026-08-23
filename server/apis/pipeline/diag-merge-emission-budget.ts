/**
 * Diagnostic API — Merge Emission Budget (READ ONLY)
 *
 * Answers: how many output tokens does a merge node actually need?
 *
 * A merge checkpoint's stored `findings` array is a MIX of two sources:
 *   1. Model-emitted findings  — came out of the LLM call, cost output tokens
 *   2. Code-carried findings   — pushed in by the Fix 16 carry-forward path when
 *                                the model omitted inputs (tagged
 *                                `_merge_accounting.status = 'carried_forward'`)
 *
 * Only (1) consumes the max_tokens budget. Sizing MERGE_MAX_TOKENS off the total
 * stored payload therefore massively overestimates the requirement. This API
 * separates the two and estimates emitted output tokens at ~4 bytes/token so the
 * budget can be set from measurement rather than from the payload size.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const BYTES_PER_TOKEN = 4;

const RowSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  truncated: z.boolean(),
  truncation_count: z.coerce.number(),
  total_findings: z.coerce.number(),
  carried_findings: z.coerce.number(),
  emitted_bytes: z.coerce.number(),
  carried_bytes: z.coerce.number(),
  header_bytes: z.coerce.number(),
});

const NodeBudget = z.object({
  node: z.string(),
  status: z.string().nullable(),
  truncated: z.boolean(),
  truncationCount: z.number(),
  totalFindings: z.number(),
  emittedFindings: z.number(),
  carriedFindings: z.number(),
  emittedBytes: z.number(),
  carriedBytes: z.number(),
  headerBytes: z.number(),
  /** Estimated output tokens the model actually spent on this node */
  estEmittedTokens: z.number(),
  /** Estimated bytes per emitted finding — the unit cost that drives scaling */
  bytesPerEmittedFinding: z.number(),
  /** What it would have cost to emit ALL findings (emitted + carried) in one call */
  estTokensToEmitAll: z.number(),
});

export default api({
  name: "DiagMergeEmissionBudget",
  description: "Measures model-emitted vs code-carried findings per merge node to size the token budget",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    minLevel: z.number().default(5).describe("Only inspect nodes at or above this tree level"),
  }),

  output: z.object({
    nodes: z.array(NodeBudget),
    /** Max estimated tokens needed to emit all findings at any single inspected node */
    peakEstTokensToEmitAll: z.number(),
    /** Median bytes per emitted finding across nodes that emitted anything */
    medianBytesPerEmittedFinding: z.number(),
    notes: z.array(z.string()),
  }),

  async run(ctx, { runId, minLevel }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
         tree_level,
         node_index,
         status,
         COALESCE((merged_json->>'truncated')::boolean, false) AS truncated,
         COALESCE((merged_json->>'truncation_count')::int, 0) AS truncation_count,
         jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb))::int AS total_findings,
         (SELECT COUNT(*)::int
            FROM jsonb_array_elements(COALESCE(merged_json->'findings', '[]'::jsonb)) f
           WHERE f->'_merge_accounting'->>'status' = 'carried_forward') AS carried_findings,
         (SELECT COALESCE(SUM(octet_length(f::text)), 0)::int
            FROM jsonb_array_elements(COALESCE(merged_json->'findings', '[]'::jsonb)) f
           WHERE f->'_merge_accounting'->>'status' IS DISTINCT FROM 'carried_forward') AS emitted_bytes,
         (SELECT COALESCE(SUM(octet_length(f::text)), 0)::int
            FROM jsonb_array_elements(COALESCE(merged_json->'findings', '[]'::jsonb)) f
           WHERE f->'_merge_accounting'->>'status' = 'carried_forward') AS carried_bytes,
         octet_length(COALESCE(merged_json->>'executiveHeader', ''))::int AS header_bytes
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND node_index >= 0
         AND tree_level >= $2
       ORDER BY tree_level, node_index
       LIMIT 10`,
      RowSchema,
      [runId, minLevel],
      { label: `Emission budget for nodes at level >= ${minLevel}` }
    );

    const nodes = rows.map((r) => {
      const emittedFindings = r.total_findings - r.carried_findings;
      const bytesPerEmittedFinding =
        emittedFindings > 0 ? Math.round(r.emitted_bytes / emittedFindings) : 0;
      const allBytes = r.emitted_bytes + r.carried_bytes + r.header_bytes;

      return {
        node: `L${r.tree_level}:${r.node_index}`,
        status: r.status,
        truncated: r.truncated,
        truncationCount: r.truncation_count,
        totalFindings: r.total_findings,
        emittedFindings,
        carriedFindings: r.carried_findings,
        emittedBytes: r.emitted_bytes,
        carriedBytes: r.carried_bytes,
        headerBytes: r.header_bytes,
        estEmittedTokens: Math.round((r.emitted_bytes + r.header_bytes) / BYTES_PER_TOKEN),
        bytesPerEmittedFinding,
        estTokensToEmitAll: Math.round(allBytes / BYTES_PER_TOKEN),
      };
    });

    const peakEstTokensToEmitAll = nodes.reduce(
      (max, n) => Math.max(max, n.estTokensToEmitAll),
      0
    );

    const perFinding = nodes
      .map((n) => n.bytesPerEmittedFinding)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const medianBytesPerEmittedFinding =
      perFinding.length === 0
        ? 0
        : perFinding[Math.floor(perFinding.length / 2)];

    const notes: string[] = [
      `Token estimate uses ${BYTES_PER_TOKEN} bytes/token on serialized JSON.`,
      "estEmittedTokens excludes code-carried findings, which cost no output tokens.",
      "estTokensToEmitAll is the budget a single call would need to emit every finding at that node with no carry-forward.",
    ];
    if (nodes.some((n) => n.truncated && n.carriedFindings === 0)) {
      notes.push(
        "WARNING: a truncated node shows zero carried findings — carry-forward may not have tagged, so emitted/carried split is unreliable for it."
      );
    }

    return {
      nodes,
      peakEstTokensToEmitAll,
      medianBytesPerEmittedFinding,
      notes,
    };
  },
});
