/**
 * Migration 018 — Canonical Finalizer Columns
 *
 * Adds columns required by MAT-F06 canonicalFinalize:
 *
 * module_outputs:
 * - semantic_hash: TEXT — deterministic hash of the reportable finding set
 * - reportable_finding_ids: JSONB — array of finding IDs in the substantive report
 * - schema_version: INTEGER — artifact schema version (currently 2)
 * - finalized_at: TIMESTAMPTZ — when finalization completed
 * - f06_diagnostics: JSONB — narrative validation, exclusion, degradation diagnostics
 *
 * module_runs:
 * - semantic_hash: TEXT — mirrors the output hash for fast status lookups
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration018",
  description: "Adds canonical finalizer columns to module_outputs and module_runs.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({
    migrated: z.boolean(),
    columnsAdded: z.array(z.string()),
  }),
  async run(ctx) {
    const columnsAdded: string[] = [];

    // ── module_outputs columns ──────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS semantic_hash TEXT`,
      [],
      { label: "Add semantic_hash to module_outputs" }
    );
    columnsAdded.push("module_outputs.semantic_hash");

    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS reportable_finding_ids JSONB`,
      [],
      { label: "Add reportable_finding_ids to module_outputs" }
    );
    columnsAdded.push("module_outputs.reportable_finding_ids");

    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS schema_version INTEGER`,
      [],
      { label: "Add schema_version to module_outputs" }
    );
    columnsAdded.push("module_outputs.schema_version");

    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`,
      [],
      { label: "Add finalized_at to module_outputs" }
    );
    columnsAdded.push("module_outputs.finalized_at");

    await ctx.integrations.db.execute(
      `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS f06_diagnostics JSONB`,
      [],
      { label: "Add f06_diagnostics to module_outputs" }
    );
    columnsAdded.push("module_outputs.f06_diagnostics");

    // ── module_runs columns ─────────────────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE module_runs ADD COLUMN IF NOT EXISTS semantic_hash TEXT`,
      [],
      { label: "Add semantic_hash to module_runs" }
    );
    columnsAdded.push("module_runs.semantic_hash");

    console.log(`[Migration018] Added columns: ${columnsAdded.join(", ")}`);

    return {
      migrated: true,
      columnsAdded,
    };
  },
});
