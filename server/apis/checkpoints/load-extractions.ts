import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const StoredExtractionSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  content_hash: z.string(),
  extraction_json: z.any(),
});

export default api({
  name: "LoadExtractions",
  description: "Loads cached universal extractions for a deal from the DB",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    extractions: z.array(
      z.object({
        documentId: z.string(),
        chunkIndex: z.number(),
        contentHash: z.string(),
        extraction: z.object({
          label: z.string(),
          extraction: z.string(),
          chunkIndex: z.number(),
          sourceFile: z.string(),
          documentTag: z.string(),
          failed: z.boolean().optional(),
        }),
      })
    ),
  }),

  async run(ctx, { dealId }) {
    // Paginated load: rows are 5-38KB (mean ~21.5KB), 50 rows ≈ 1.05MB,
    // well under the 4MB gRPC ceiling. Matches pipeline-core.ts page size.
    const PAGE_SIZE = 50;
    let offset = 0;
    const rows: Array<{ document_id: string; chunk_index: number; content_hash: string; extraction_json?: any }> = [];

    while (true) {
      const page = await ctx.integrations.db.query(
        `SELECT document_id, chunk_index, content_hash, extraction_json
         FROM universal_extractions
         WHERE deal_id = $1
         ORDER BY document_id, chunk_index
         LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        StoredExtractionSchema,
        [dealId],
        { label: `Load cached extractions page offset=${offset}` }
      );
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    const extractions = rows.map((row) => {
      const ext = typeof row.extraction_json === "string"
        ? JSON.parse(row.extraction_json)
        : row.extraction_json;
      return {
        documentId: row.document_id,
        chunkIndex: row.chunk_index,
        contentHash: row.content_hash,
        extraction: {
          label: String(ext.label ?? ""),
          extraction: String(ext.extraction ?? ""),
          chunkIndex: Number(ext.chunkIndex ?? row.chunk_index),
          sourceFile: String(ext.sourceFile ?? ""),
          documentTag: String(ext.documentTag ?? "other"),
          ...(ext.failed ? { failed: true } : {}),
        },
      };
    });

    return { extractions };
  },
});
