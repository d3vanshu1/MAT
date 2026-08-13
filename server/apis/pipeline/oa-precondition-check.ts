import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "OaPreconditionCheck",
  description: "Verification queries for migration 021.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    step: z.enum(["v1", "v2", "v3", "v4"]),
  }),
  output: z.object({
    rows: z.array(z.record(z.unknown())),
  }),
  async run(ctx, { step }) {
    const GenericRow = z.record(z.unknown());
    let rows: Record<string, unknown>[] = [];

    if (step === "v1") {
      rows = await ctx.integrations.db.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('oa_facts','oa_topics','oa_topic_facts','oa_findings','oa_stage_checkpoints','oa_chunk_map')
         ORDER BY table_name`,
        GenericRow, [], { label: "V1: verify tables exist" }
      );
    } else if (step === "v2") {
      rows = await ctx.integrations.db.query(
        `SELECT indexname FROM pg_indexes
         WHERE indexname LIKE 'idx_oa_%' ORDER BY indexname`,
        GenericRow, [], { label: "V2: verify indexes exist" }
      );
    } else if (step === "v3") {
      rows = await ctx.integrations.db.query(
        `SELECT conname, contype FROM pg_constraint
         WHERE conrelid::regclass::text LIKE 'oa_%'
         ORDER BY conrelid::regclass::text, conname`,
        GenericRow, [], { label: "V3: verify constraints" }
      );
    } else if (step === "v4") {
      rows = await ctx.integrations.db.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns WHERE table_name = 'oa_facts'
         AND column_name IN ('scope_qualifier','verbatim_snippet')`,
        GenericRow, [], { label: "V4: verify column types" }
      );
    }

    return { rows };
  },
});
