/**
 * Diagnostic: Pull the 9 suppressed findings with their full content from merge root.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagSuppressedFindings",
  description: "Reads suppressed findings content from merge root node",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string(),
  }),
  output: z.object({
    findingsJson: z.string().nullable(),
  }),
  async run(ctx, { runId }) {
    // Get merge root checkpoint merged_json->findings (node_index=0, highest tree_level)
    const Row = z.object({ findings_json: z.string().nullable() });
    const rows = await ctx.integrations.db.query(
      `SELECT (merged_json->'findings')::text AS findings_json
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index = 0
       ORDER BY tree_level DESC
       LIMIT 1`,
      Row,
      [runId],
      { label: "Diag: merge root findings" }
    );

    return {
      findingsJson: rows[0]?.findings_json ?? null,
    };
  },
});
