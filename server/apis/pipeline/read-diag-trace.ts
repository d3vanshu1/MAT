/**
 * Reads rows from diag_timeout_trace for a specific run_id.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ReadDiagTrace",
  description: "Reads diag_timeout_trace rows for a given run_id.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string(),
  }),
  output: z.object({
    rows: z.array(z.object({
      id: z.string(),
      run_id: z.string(),
      marker: z.string(),
      elapsed_ms: z.number(),
      extra: z.any().nullable(),
      created_at: z.string(),
    })),
  }),
  async run(ctx, { runId }) {
    const rows = await ctx.integrations.db.query(
      `SELECT id, run_id, marker, elapsed_ms, extra, created_at::text
       FROM diag_timeout_trace
       WHERE run_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      z.object({
        id: z.string(),
        run_id: z.string(),
        marker: z.string(),
        elapsed_ms: z.number(),
        extra: z.any().nullable(),
        created_at: z.string(),
      }),
      [runId],
      { label: "Read diag_timeout_trace" }
    );
    return { rows };
  },
});
