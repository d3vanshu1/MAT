/**
 * Diagnostic Export: Single Extraction (chunked transfer)
 *
 * Returns a segment of one universal_extractions row's extraction_json.
 * Caller reassembles segments to get the full content.
 *
 * READ-ONLY. No mutations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagExportExtraction",
  description: "Returns a segment of one extraction_json for chunked transfer",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    documentId: z.string(),
    chunkIndex: z.number(),
    segStart: z.number(),    // 1-based char position
    segLength: z.number(),   // chars to return (max ~8000 for safe transfer)
  }),

  output: z.object({
    documentId: z.string(),
    fileName: z.string().nullable(),
    documentTag: z.string().nullable(),
    chunkIndex: z.number(),
    contentHash: z.string().nullable(),
    totalLength: z.number(),
    segStart: z.number(),
    segEnd: z.number(),
    segment: z.string(),
  }),

  async run(ctx, { dealId, documentId, chunkIndex, segStart, segLength }) {
    // Get metadata + segment of extraction_json
    const rows = await ctx.integrations.db.query(
      `SELECT
         ue.document_id,
         d.file_name,
         d.document_tag,
         ue.chunk_index,
         ue.content_hash,
         LENGTH(ue.extraction_json::text) AS total_length,
         substr(ue.extraction_json::text, $4::int, $5::int) AS segment
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
         AND ue.document_id = $2
         AND ue.chunk_index = $3
       LIMIT 1`,
      z.object({
        document_id: z.string(),
        file_name: z.string().nullable(),
        document_tag: z.string().nullable(),
        chunk_index: z.number(),
        content_hash: z.string().nullable(),
        total_length: z.number(),
        segment: z.string(),
      }),
      [dealId, documentId, chunkIndex, segStart, segLength],
      { label: `Extraction ${documentId}:${chunkIndex} seg@${segStart}` }
    );

    if (rows.length === 0) {
      throw new Error(`No extraction found for doc=${documentId} chunk=${chunkIndex}`);
    }

    const r = rows[0];
    const actualEnd = segStart + r.segment.length - 1;

    return {
      documentId: r.document_id,
      fileName: r.file_name,
      documentTag: r.document_tag,
      chunkIndex: r.chunk_index,
      contentHash: r.content_hash,
      totalLength: r.total_length,
      segStart,
      segEnd: actualEnd,
      segment: r.segment,
    };
  },
});
