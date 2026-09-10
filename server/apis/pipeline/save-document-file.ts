/**
 * save-document-file.ts — Stores raw file binary in 1MB chunks.
 *
 * Called from the client after upload. Accepts base64-encoded chunks
 * and stores them in document_files table. SHA-256 hash is stored
 * on the documents row for integrity verification.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const CHUNK_SIZE = 1_048_576; // 1MB

export default api({
  name: "SaveDocumentFile",
  description: "Stores raw file binary as 1MB chunks in document_files",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    chunkIndex: z.number(),
    base64Data: z.string(),
    byteCount: z.number(),
    fileHash: z.string().nullable().optional(),
    totalChunks: z.number().optional(),
  }),

  output: z.object({
    stored: z.boolean(),
    chunkIndex: z.number(),
    byteCount: z.number(),
    hashStored: z.boolean(),
  }),

  async run(ctx, { documentId, chunkIndex, base64Data, byteCount, fileHash, totalChunks }) {
    // Store chunk as bytea using decode(base64, 'base64')
    await ctx.integrations.db.execute(
      `INSERT INTO document_files (document_id, chunk_index, bytes, byte_count)
       VALUES ($1::uuid, $2, decode($3, 'base64'), $4)
       ON CONFLICT (document_id, chunk_index) DO UPDATE SET
         bytes = decode($3, 'base64'),
         byte_count = $4,
         created_at = now()`,
      [documentId, chunkIndex, base64Data, byteCount],
      { label: `Store file chunk ${chunkIndex}` }
    );

    // On last chunk, store the file hash on all chunks for this document
    let hashStored = false;
    if (fileHash && totalChunks != null && chunkIndex === totalChunks - 1) {
      await ctx.integrations.db.execute(
        `UPDATE document_files SET file_hash = $1 WHERE document_id = $2::uuid`,
        [fileHash, documentId],
        { label: "Store file hash on chunks" }
      );
      hashStored = true;
    }

    return { stored: true, chunkIndex, byteCount, hashStored };
  },
});
