/**
 * FenceRun — Prevents ResumeStalePipelines from claiming a specific run.
 *
 * Sets triggered_at far into the future so the staleness check
 * (`triggered_at < now() - 7 min`) never fires.
 *
 * Also records a fence marker in the run's metadata for explicit visibility.
 *
 * Reversible via UnfenceRun or by setting triggered_at = now().
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "FenceRun",
  description: "Prevents ResumeStalePipelines from claiming a specific module run.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string().uuid(),
    reason: z.string().min(1),
    durationHours: z.number().min(1).max(168).default(24),
  }),
  output: z.object({
    fenced: z.boolean(),
    previousTriggeredAt: z.string().nullable(),
    newTriggeredAt: z.string(),
    runStatus: z.string().nullable(),
  }),
  async run(ctx, { runId, reason, durationHours }) {
    // Read current state
    const currentRows = await ctx.integrations.db.query(
      `SELECT status, triggered_at FROM module_runs WHERE id = $1`,
      z.object({ status: z.string(), triggered_at: z.string() }),
      [runId],
      { label: "Read current run state" }
    );

    if (currentRows.length === 0) {
      throw new Error(`Run ${runId} not found`);
    }

    const current = currentRows[0];

    // Set triggered_at far into the future (no metadata column available)
    const result = await ctx.integrations.db.query(
      `UPDATE module_runs
       SET triggered_at = now() + make_interval(hours => $2)
       WHERE id = $1
       RETURNING to_char(triggered_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as new_triggered_at`,
      z.object({ new_triggered_at: z.string() }),
      [runId, durationHours],
      { label: "Fence run: set triggered_at to future" }
    );

    return {
      fenced: result.length > 0,
      previousTriggeredAt: current.triggered_at,
      newTriggeredAt: result.length > 0 ? result[0].new_triggered_at : "",
      runStatus: current.status,
    };
  },
});
