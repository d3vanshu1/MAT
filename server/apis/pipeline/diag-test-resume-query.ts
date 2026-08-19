import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagTestResumeQuery",
  description: "Minimal test: runs the exact resume-status-check query that is failing",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    status: z.string(),
    is_cancelled: z.string(),
  }),

  async run(ctx, { runId }) {
    // Schema audit: get actual columns on the three core tables
    const cols = await ctx.integrations.db.query(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('module_runs', 'module_outputs', 'pipeline_checkpoints')
       ORDER BY table_name, ordinal_position`,
      z.object({ table_name: z.string(), column_name: z.string(), data_type: z.string(), is_nullable: z.string() }),
      [],
      { label: "Schema audit" }
    );

    return { status: JSON.stringify(cols), is_cancelled: "schema_audit" };
  },
});
