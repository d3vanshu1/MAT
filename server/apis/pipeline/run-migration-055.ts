import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration055",
  description: "Creates document_files table for chunked binary file storage",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dryRun: z.boolean().optional(),
  }),

  output: z.object({
    added: z.array(z.string()),
    dryRun: z.boolean(),
  }),

  async run(ctx, { dryRun }) {
    const isDry = dryRun ?? true;
    const added: string[] = [];

    // Check if table exists
    const existing = await ctx.integrations.db.query(
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'document_files' LIMIT 1`,
      z.object({ ok: z.number() }),
      [],
      { label: "Check document_files exists" }
    );

    if (existing.length === 0) {
      if (!isDry) {
        await ctx.integrations.db.execute(
          `CREATE TABLE document_files (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            chunk_index int NOT NULL DEFAULT 0,
            bytes bytea NOT NULL,
            byte_count int NOT NULL,
            file_hash text,
            created_at timestamptz DEFAULT now(),
            UNIQUE(document_id, chunk_index)
          )`,
          [],
          { label: "Create document_files table" }
        );
        await ctx.integrations.db.execute(
          `CREATE INDEX idx_document_files_doc ON document_files(document_id, chunk_index)`,
          [],
          { label: "Create document_files index" }
        );
      }
      added.push("document_files table");
    }

    // Add file_hash column to document_files table itself
    // (can't ALTER documents — no owner permission)
    const hashCol = await ctx.integrations.db.query(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = 'document_files' AND column_name = 'file_hash' LIMIT 1`,
      z.object({ ok: z.number() }),
      [],
      { label: "Check document_files.file_hash" }
    );

    if (hashCol.length === 0 && existing.length === 0) {
      // Already included in CREATE TABLE above — skip
      added.push("document_files.file_hash (in CREATE)");
    }

    return { added, dryRun: isDry };
  },
});
