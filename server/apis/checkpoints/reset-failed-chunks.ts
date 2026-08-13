import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountSchema = z.object({ count: z.coerce.number() });

export default api({
  name: "ResetFailedChunks",
  description: "Deletes specific failed extraction rows so the pipeline re-extracts them on next run",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    /** Array of { documentId, chunkIndex } pairs to reset */
    chunks: z.array(z.object({
      documentId: z.string(),
      chunkIndex: z.number(),
    })).min(1).max(10),
  }),

  output: z.object({
    deletedCount: z.number(),
    requestedCount: z.number(),
  }),

  async run(ctx, { dealId, chunks }) {
    // Build a composite key filter: (document_id, chunk_index) IN (...)
    // Only delete rows that are actually marked as failed to prevent accidental data loss.
    const conditions = chunks
      .map((_, i) => `(document_id = $${i * 2 + 2}::uuid AND chunk_index = $${i * 2 + 3}::int)`)
      .join(" OR ");

    const params: (string | number)[] = [dealId];
    for (const chunk of chunks) {
      params.push(chunk.documentId, chunk.chunkIndex);
    }

    // Count how many of these are actually failed rows
    const [{ count }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS count FROM universal_extractions
       WHERE deal_id = $1
         AND (extraction_json->>'failed')::boolean = true
         AND (${conditions})`,
      CountSchema,
      params,
      { label: `Count failed chunks to reset (${chunks.length} targets)` }
    );

    if (count === 0) {
      ctx.log.info(`[ResetFailedChunks] No failed rows found for ${chunks.length} target chunk(s)`);
      return { deletedCount: 0, requestedCount: chunks.length };
    }

    // Delete only the failed rows
    await ctx.integrations.db.execute(
      `DELETE FROM universal_extractions
       WHERE deal_id = $1
         AND (extraction_json->>'failed')::boolean = true
         AND (${conditions})`,
      params,
      { label: `Reset ${count} failed chunk(s)` }
    );

    ctx.log.info(
      `[ResetFailedChunks] Deleted ${count} failed extraction row(s) for deal ${dealId}`
    );

    return { deletedCount: count, requestedCount: chunks.length };
  },
});
