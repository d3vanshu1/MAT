/**
 * Migration 030 — Create `module_run_diagnostics` side table.
 *
 * Purpose:
 *   `module_outputs` has a fixed six-column schema
 *   (id, module_run_id, executive_header, findings, full_report_markdown, created_at)
 *   and the integration role cannot ALTER it. The canonical finalizer therefore had
 *   nowhere to durably record its suppression diagnostics: `excluded_findings` and
 *   `degraded_conditions` were computed at finalization and thrown away, and the
 *   rehydration path returned `excluded_findings: []` with a note that diagnostics
 *   were not re-derived.
 *
 *   That made suppression inferable only from absence. A finding dropped by a gate
 *   and a risk that synthesis never grounded look identical in the artifact.
 *
 * After this migration:
 *   - The finalizer writes one row per module run carrying the full exclusion
 *     ledger (per finding: layer, gate name, reason string, other gates that also
 *     failed) plus degraded conditions and a suppression summary.
 *   - `findings` in `module_outputs` stays the reportable set only, so nothing
 *     downstream starts rendering suppressed findings by accident.
 *   - Rehydrated artifacts recover real diagnostics instead of an empty array.
 *   - No foreign key to `module_runs` (we don't own that table) — same pattern as
 *     `module_run_flags` (migration 029).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration030",
  description: "Creates module_run_diagnostics side table for suppression audit trail",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    tableCreated: z.boolean(),
    indexCreated: z.boolean(),
  }),

  async run(ctx) {
    const existing = await ctx.integrations.db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'module_run_diagnostics'
       LIMIT 1`,
      z.object({ table_name: z.string() }),
      [],
      { label: "Check if module_run_diagnostics table exists" }
    );

    const tableAlreadyExists = existing.length > 0;

    if (!tableAlreadyExists) {
      await ctx.integrations.db.execute(
        `CREATE TABLE IF NOT EXISTS module_run_diagnostics (
           module_run_id       uuid PRIMARY KEY,
           excluded_findings   jsonb NOT NULL DEFAULT '[]'::jsonb,
           degraded_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
           suppression_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
           created_at          timestamptz NOT NULL DEFAULT now(),
           updated_at          timestamptz NOT NULL DEFAULT now()
         )`,
        [],
        { label: "Create module_run_diagnostics table" }
      );
    }

    // Index supports deal-level audit queries that scan recent diagnostics rows.
    let indexCreated = false;
    try {
      await ctx.integrations.db.execute(
        `CREATE INDEX IF NOT EXISTS idx_module_run_diagnostics_created
           ON module_run_diagnostics (created_at DESC)`,
        [],
        { label: "Create module_run_diagnostics created_at index" }
      );
      indexCreated = true;
    } catch {
      // Non-fatal: primary-key lookup by module_run_id is the main access path.
    }

    return {
      success: true,
      message: tableAlreadyExists
        ? "'module_run_diagnostics' table already exists — no table creation needed."
        : "Created 'module_run_diagnostics' (module_run_id PK, excluded_findings, degraded_conditions, suppression_summary, created_at, updated_at).",
      tableCreated: !tableAlreadyExists,
      indexCreated,
    };
  },
});
