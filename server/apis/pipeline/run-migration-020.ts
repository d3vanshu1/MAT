/**
 * Migration 020 — diag_timeout_trace table for observing pipeline invocations
 * that are killed by the platform before graceful exit.
 *
 * Each row is an independent INSERT fired at the moment the marker is reached,
 * so rows written before a platform kill survive.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration020",
  description: "Creates diag_timeout_trace table for pipeline kill diagnostics.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({}),
  output: z.object({ created: z.boolean() }),
  async run(ctx) {
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS diag_timeout_trace (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id TEXT NOT NULL,
        marker TEXT NOT NULL,
        elapsed_ms INT NOT NULL,
        extra JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Migration020: create diag_timeout_trace" }
    );
    return { created: true };
  },
});
