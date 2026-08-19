/**
 * Migration 029 — Create `module_run_flags` side table.
 *
 * Purpose:
 *   The integration role cannot ALTER tables it does not own (e.g. module_runs).
 *   This side table stores per-run flags (starting with diagnostic_only) and is
 *   joined at read time by LoadModuleResults, list-deals, get-deal, and
 *   ResumeStalePipelines.
 *
 * After this migration:
 *   - A row in module_run_flags with diagnostic_only = TRUE suppresses that run
 *     from user-facing views.
 *   - Runs with no flag row default to visible (COALESCE on the LEFT JOIN).
 *   - No foreign key to module_runs (we don't own that table).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration029",
  description: "Creates module_run_flags side table for diagnostic_only flag",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tableCreated: z.boolean(),
  }),

  async run(ctx) {
    // Check if table already exists
    const existing = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'module_run_flags'
       LIMIT 1`,
      z.object({ table_name: z.string() }),
      [],
      { label: "Check if module_run_flags table exists" }
    );

    if (existing.length > 0) {
      return {
        success: true,
        message: "'module_run_flags' table already exists — no migration needed.",
        tableCreated: false,
      };
    }

    // Create the side table
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS module_run_flags (
         module_run_id   uuid PRIMARY KEY,
         diagnostic_only boolean NOT NULL DEFAULT FALSE,
         created_at      timestamptz NOT NULL DEFAULT now()
       )`,
      [],
      { label: "Create module_run_flags table" }
    );

    return {
      success: true,
      message: "Created 'module_run_flags' table (module_run_id PK, diagnostic_only, created_at).",
      tableCreated: true,
    };
  },
});
