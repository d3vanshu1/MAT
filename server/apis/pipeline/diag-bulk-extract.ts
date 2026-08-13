/**
 * Diagnostic Bulk Extract: Document-level extraction export
 *
 * Returns the 'extraction' text field (markdown) from extraction_json
 * for multiple chunks of a document. Uses ->> to extract as plain text,
 * avoiding the double-escaping that kills chunked transfer throughput.
 *
 * Returns chunks in order. Each chunk's extraction is a separate array element.
 * If content is too large, caller paginates via chunkStart/chunkEnd.
 *
 * READ-ONLY. No mutations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagBulkExtract",
  description: "Returns extraction markdown for multiple chunks of a document",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    documentId: z.string(),
    chunkStart: z.number(),   // inclusive, 0-based local chunk index
    chunkEnd: z.number(),     // inclusive
  }),

  output: z.object({
    documentId: z.string(),
    fileName: z.string().nullable(),
    documentTag: z.string().nullable(),
    chunks: z.array(z.object({
      chunkIndex: z.number(),
      extractionLength: z.number(),
      extraction: z.string(),
    })),
    totalChunksInDoc: z.number(),
  }),

  async run(ctx, { dealId, documentId, chunkStart, chunkEnd }) {
    // Get total chunk count for this document
    const countRows = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM universal_extractions
       WHERE deal_id = $1 AND document_id = $2`,
      z.object({ cnt: z.number() }),
      [dealId, documentId],
      { label: "Count chunks" }
    );
    const totalChunksInDoc = countRows[0]?.cnt ?? 0;

    // Get extraction text for requested chunk range
    // Use ->> to extract as plain text (no JSON escaping layer)
    const rows = await ctx.integrations.db.query(
      `SELECT
         ue.document_id,
         d.file_name,
         d.document_tag,
         ue.chunk_index,
         ue.extraction_json->>'extraction' AS extraction_text,
         LENGTH(ue.extraction_json->>'extraction') AS extraction_length
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
         AND ue.document_id = $2
         AND ue.chunk_index >= $3
         AND ue.chunk_index <= $4
       ORDER BY ue.chunk_index
       LIMIT 50`,
      z.object({
        document_id: z.string(),
        file_name: z.string().nullable(),
        document_tag: z.string().nullable(),
        chunk_index: z.number(),
        extraction_text: z.string().nullable(),
        extraction_length: z.number(),
      }),
      [dealId, documentId, chunkStart, chunkEnd],
      { label: `Bulk extract ${documentId} chunks ${chunkStart}-${chunkEnd}` }
    );

    const fileName = rows[0]?.file_name ?? null;
    const documentTag = rows[0]?.document_tag ?? null;

    return {
      documentId,
      fileName,
      documentTag,
      chunks: rows.map(r => ({
        chunkIndex: r.chunk_index,
        extractionLength: r.extraction_length,
        extraction: r.extraction_text ?? "",
      })),
      totalChunksInDoc,
    };
  },
});
