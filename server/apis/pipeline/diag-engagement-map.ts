/**
 * EM-1 Diagnostic API — Engagement Map Verification
 *
 * Standalone API that builds the per-memo engagement map for the SCG deal
 * (or any deal) and returns the full structured result for manual verification.
 *
 * Read-only: no writes, no finding modifications, no pipeline changes.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildEngagementMap } from "./engagement-map.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const EngagedTopicSchema = z.object({
  topic: z.string(),
  evidence: z.string(),
});

const MemoEntrySchema = z.object({
  memo_file: z.string(),
  memo_order: z.number(),
  chunk_count: z.number(),
  truncated: z.boolean(),
  engaged_topics: z.array(EngagedTopicSchema),
  error: z.string().optional(),
});

const OutputSchema = z.object({
  deal_id: z.string(),
  memos: z.array(MemoEntrySchema),
  model_used: z.string(),
  partial: z.boolean(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "DiagEngagementMap",
  description: "Builds per-memo engagement map via LLM for verification",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().nullable().describe("Deal ID; null = SCG deal"),
  }),

  output: OutputSchema,

  async run(ctx, { dealId }) {
    const targetDeal = dealId ?? SCG_DEAL_ID;

    // Platform timeout is ~300s; set deadline with 40s safety margin
    const deadlineMs = Date.now() + 260_000;

    const result = await buildEngagementMap(
      ctx.integrations.db.query.bind(ctx.integrations.db),
      ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
      targetDeal,
      deadlineMs,
    );

    return result;
  },
});
