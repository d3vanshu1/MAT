/**
 * D1 Diagnostic — List deal documents with tags for source-policy verification.
 * Read-only. No pipeline writes.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const DocRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
  text_length: z.coerce.number(),
});

export default api({
  name: "DiagD1Documents",
  description: "List deal documents with tags for D1 source-policy verification",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    documents: z.array(DocRowSchema),
  }),

  async run(ctx, { dealId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT id, file_name, document_tag, COALESCE(LENGTH(parsed_text), 0)::int AS text_length
       FROM documents
       WHERE deal_id = $1
       ORDER BY uploaded_at ASC
       LIMIT 10`,
      DocRowSchema,
      [dealId],
      { label: "D1: List documents with tags" }
    );
    return { documents: rows };
  },
});
