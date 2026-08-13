/**
 * Diagnostic API — Dumps raw pipeline_analysis rows for a run in paginated batches.
 * Returns ALL stored columns verbatim for evidence preservation.
 * READ-ONLY. NOT production code.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const RawAnalysisRowSchema = z.object({
  chunk_index: z.coerce.number(),
  model_used: z.string().nullable(),
  prompt_version: z.string().nullable(),
  label: z.string().nullable(),
  truncated: z.coerce.boolean(),
  extraction_length: z.coerce.number(),
  extraction_text: z.string().nullable(),
  created_at: z.string().nullable(),
});

export default api({
  name: "DiagDumpAnalysisRows",
  description: "Paginated dump of raw pipeline_analysis rows for evidence preservation",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    offset: z.number().min(0),
    limit: z.number().min(1).max(20),
    extractionStart: z.number().min(1).optional().describe("Start position for substring of extraction (1-based, default 1)"),
    extractionLen: z.number().min(1).optional().describe("Length of extraction substring to return (default 8000)"),
  }),

  output: z.object({
    rows: z.array(RawAnalysisRowSchema),
    rowCount: z.number(),
    totalAvailable: z.number(),
  }),

  async run(ctx, { runId, offset, limit, extractionStart, extractionLen }) {
    const extStart = extractionStart ?? 1;
    const extLen = extractionLen ?? 8000;

    // First get total count
    const countResult = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Count pipeline_analysis rows" }
    );
    const totalAvailable = countResult[0]?.cnt ?? 0;

    // This run uses the old schema: result_json JSONB with label/extraction/truncated inside.
    const rows = await ctx.integrations.db.query(
      `SELECT
        chunk_index,
        model_used,
        prompt_version,
        result_json->>'label' AS label,
        COALESCE((result_json->>'truncated')::boolean, false) AS truncated,
        COALESCE(LENGTH(result_json->>'extraction'), 0)::int AS extraction_length,
        SUBSTRING(result_json->>'extraction' FROM ${extStart} FOR ${extLen}) AS extraction_text,
        created_at::text AS created_at
      FROM pipeline_analysis
      WHERE run_id = $1
      ORDER BY chunk_index
      OFFSET $2
      LIMIT $3`,
      RawAnalysisRowSchema,
      [runId, offset, limit],
      { label: `Dump analysis rows offset=${offset} limit=${limit}` }
    );

    return {
      rows,
      rowCount: rows.length,
      totalAvailable,
    };
  },
});
