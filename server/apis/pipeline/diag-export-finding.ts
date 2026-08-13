/**
 * Diagnostic Export: Raw Finding
 *
 * Returns a specific finding's VERBATIM stored data from merge_checkpoints
 * and module_outputs. Every field, every evidence pointer, untouched.
 *
 * READ-ONLY. No mutations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagExportFinding",
  description: "Returns raw finding data from merge checkpoints and module outputs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    findingId: z.string(),
  }),

  output: z.object({
    // From module_outputs findings array (final persisted)
    finalFinding: z.any().nullable(),
    // From merge_checkpoints — all checkpoint nodes that reference this finding
    mergeNodes: z.array(z.object({
      tree_level: z.number(),
      node_index: z.number(),
      raw_json: z.string(),  // The FULL merged_json::text for this node (may be large)
    })),
    // Full module_outputs row metadata
    outputMeta: z.object({
      executive_header: z.string().nullable(),
      findings_count: z.number(),
      report_length: z.number().nullable(),
      created_at: z.string().nullable(),
    }).nullable(),
  }),

  async run(ctx, { runId, findingId }) {
    // 1. Get the final finding from module_outputs
    const outputRows = await ctx.integrations.db.query(
      `SELECT
         mo.executive_header,
         jsonb_array_length(COALESCE(mo.findings, '[]'::jsonb)) AS findings_count,
         LENGTH(mo.full_report_markdown) AS report_length,
         mo.created_at::text
       FROM module_outputs mo
       WHERE mo.module_run_id = $1
       LIMIT 1`,
      z.object({
        executive_header: z.string().nullable(),
        findings_count: z.number(),
        report_length: z.number().nullable(),
        created_at: z.string().nullable(),
      }),
      [runId],
      { label: "Module output metadata" }
    );

    // Extract the specific finding from the findings JSONB array
    const findingRows = await ctx.integrations.db.query(
      `SELECT elem::text AS finding_json
       FROM module_outputs mo,
            jsonb_array_elements(COALESCE(mo.findings, '[]'::jsonb)) AS elem
       WHERE mo.module_run_id = $1
         AND elem->>'finding_id' = $2
       LIMIT 1`,
      z.object({ finding_json: z.string() }),
      [runId, findingId],
      { label: `Extract finding ${findingId}` }
    );

    let finalFinding: any = null;
    if (findingRows.length > 0) {
      try {
        finalFinding = JSON.parse(findingRows[0].finding_json);
      } catch {
        finalFinding = findingRows[0].finding_json;
      }
    }

    // 2. Get merge checkpoint nodes that contain this finding
    // Search merged_json for the finding_id string
    const mergeNodes = await ctx.integrations.db.query(
      `SELECT
         tree_level,
         node_index,
         merged_json::text AS raw_json
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND merged_json::text LIKE '%' || $2 || '%'
       ORDER BY tree_level, node_index
       LIMIT 20`,
      z.object({
        tree_level: z.number(),
        node_index: z.number(),
        raw_json: z.string(),
      }),
      [runId, findingId],
      { label: `Merge nodes containing ${findingId}` }
    );

    return {
      finalFinding,
      mergeNodes,
      outputMeta: outputRows.length > 0 ? outputRows[0] : null,
    };
  },
});
