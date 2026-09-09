/**
 * Migration 049 — ero_hypotheses: research_attempts + failure_reason.
 *
 * Supports the ERO research-stage defect fix (D-01 through D-05):
 *   - research_attempts: incremented each time the research stage attempts
 *     a hypothesis. Hypotheses exceeding MAX_HYP_ATTEMPTS are retired to
 *     'error' so they don't re-queue forever.
 *   - failure_reason: explicit label distinguishing "never searched /
 *     attempts exhausted" from "searched but adjudication failed."
 *     Removes the implicit overload of status='error' for two unrelated
 *     failure modes.
 *
 * Both columns are backwards-compatible: existing rows get 0 attempts
 * and NULL failure_reason, which is correct — they pre-date the fix.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration049",
  description: "Add research_attempts + failure_reason to ero_hypotheses",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dryRun: z.boolean().default(true),
  }),

  output: z.object({
    columnsAdded: z.boolean(),
    dryRun: z.boolean(),
  }),

  async run(ctx, { dryRun }) {
    const db = ctx.integrations.ic_diligence_db;

    if (dryRun) {
      console.log("[Migration049] DRY RUN — no changes will be made.");
      return { columnsAdded: false, dryRun: true };
    }

    await db.execute(
      `ALTER TABLE ero_hypotheses
         ADD COLUMN IF NOT EXISTS research_attempts INT NOT NULL DEFAULT 0`,
      [],
      { label: "Migration049: add research_attempts column" },
    );

    await db.execute(
      `ALTER TABLE ero_hypotheses
         ADD COLUMN IF NOT EXISTS failure_reason TEXT NULL`,
      [],
      { label: "Migration049: add failure_reason column" },
    );

    console.log("[Migration049] ero_hypotheses: research_attempts + failure_reason added.");
    return { columnsAdded: true, dryRun: false };
  },
});
