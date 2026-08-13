/**
 * Diagnostic Export: Index Map
 *
 * Returns the ground-truth pipeline_analysis ordering for a run.
 * JOINs with documents table to resolve document_id from the label field.
 * Paginated to avoid response size issues.
 *
 * READ-ONLY. No mutations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const IndexEntrySchema = z.object({
  global_index: z.number(),
  document_id: z.string().nullable(),
  filename: z.string().nullable(),
  local_chunk_index: z.number().nullable(),
});

export default api({
  name: "DiagExportIndexMap",
  description: "Returns pipeline_analysis index map with document_id resolved from label",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
    offset: z.number(),
    limit: z.number(),
  }),

  output: z.object({
    rows: z.array(IndexEntrySchema),
    totalCount: z.number(),
  }),

  async run(ctx, { runId, dealId, offset, limit }) {
    // Count total
    const countResult = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.number() }),
      [runId],
      { label: "Count pipeline_analysis rows" }
    );
    const totalCount = countResult[0]?.cnt ?? 0;

    // Get rows with document_id resolved by JOIN on filename parsed from label
    // Label format: "<filename> (part N)" — extract filename and part number
    const rows = await ctx.integrations.db.query(
      `SELECT
         pa.chunk_index AS global_index,
         d.id AS document_id,
         d.file_name AS filename,
         (regexp_match(pa.result_json->>'label', '\\(part (\\d+)\\)$'))[1]::int - 1 AS local_chunk_index
       FROM pipeline_analysis pa
       LEFT JOIN documents d
         ON d.deal_id = $2
         AND d.file_name = regexp_replace(pa.result_json->>'label', ' \\(part \\d+\\)$', '')
       WHERE pa.run_id = $1
       ORDER BY pa.chunk_index
       OFFSET $3
       LIMIT $4`,
      IndexEntrySchema,
      [runId, dealId, offset, limit],
      { label: `Index map offset=${offset} limit=${limit}` }
    );

    return { rows, totalCount };
  },
});
