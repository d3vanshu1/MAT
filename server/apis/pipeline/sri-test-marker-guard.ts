/**
 * sri-test-marker-guard.ts
 *
 * Test-only API that calls buildClaimRegister directly, bypassing the
 * orchestrator's stage routing. This reproduces the server-side
 * re-execution path that caused the 70-claim overwrite.
 *
 * It writes nothing itself. Whatever the handler does is the handler's behaviour.
 */

import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildClaimRegister } from "./sri-claim-register.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "SriTestMarkerGuard",
  description: "Positive control: calls buildClaimRegister directly to test marker guard",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    countBefore: z.number(),
    countAfter: z.number(),
    handlerResult: z.object({
      stage: z.string(),
      status: z.string(),
      message: z.string(),
      stageData: z.record(z.unknown()).optional(),
    }),
  }),

  async run(ctx, { dealId }) {
    var db = ctx.integrations.db;

    // Find the current run for this deal
    var runRows = await db.query(
      "SELECT run_id FROM sri_pipeline_state WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1",
      z.object({ run_id: z.string() }),
      [dealId],
      { label: "SriTestMarkerGuard: find run" },
    );

    if (runRows.length === 0) {
      throw new Error("No SRI run found for deal " + dealId);
    }

    var runId = runRows[0].run_id;

    // Count claims BEFORE calling the handler
    var beforeRows = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "SriTestMarkerGuard: count before" },
    );
    var countBefore = beforeRows.length > 0 ? beforeRows[0].cnt : 0;

    // Call the handler directly — bypasses orchestrator stage routing
    var result = await buildClaimRegister(ctx, runId, dealId);

    // Count claims AFTER calling the handler
    var afterRows = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "SriTestMarkerGuard: count after" },
    );
    var countAfter = afterRows.length > 0 ? afterRows[0].cnt : 0;

    return {
      countBefore: countBefore,
      countAfter: countAfter,
      handlerResult: {
        stage: result.stage,
        status: result.status,
        message: result.message,
        stageData: result.stageData,
      },
    };
  },
});
