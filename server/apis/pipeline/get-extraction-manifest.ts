/**
 * GetExtractionManifest: Returns the list of documents and chunk counts
 * for a deal, used by the frontend export button to know what to fetch.
 *
 * READ-ONLY. No mutations.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "GetExtractionManifest",
  description: "Returns document extraction index for a deal's export",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(z.object({
      documentId: z.string(),
      fileName: z.string(),
      documentTag: z.string(),
      chunkCount: z.number(),
    })),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT
         ue.document_id,
         d.file_name,
         d.document_tag,
         COUNT(*)::int AS chunk_count
       FROM universal_extractions ue
       JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
       GROUP BY ue.document_id, d.file_name, d.document_tag
       ORDER BY d.file_name
       LIMIT 200`,
      z.object({
        document_id: z.string(),
        file_name: z.string(),
        document_tag: z.string(),
        chunk_count: z.number(),
      }),
      [dealId],
      { label: "Get extraction manifest" }
    );

    return {
      documents: rows.map(r => ({
        documentId: r.document_id,
        fileName: r.file_name,
        documentTag: r.document_tag,
        chunkCount: r.chunk_count,
      })),
    };
  },
});
