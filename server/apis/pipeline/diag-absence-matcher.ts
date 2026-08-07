/**
 * EM-2 Diagnostic API — Absence Map Matcher Verification
 *
 * Standalone API that:
 *   1. Builds the engagement map (EM-1) for the deal
 *   2. Loads findings from the largest completed OA run
 *   3. Runs the per-finding absence matcher against the map
 *   4. Returns full dispositions for manual verification
 *
 * Read-only: no writes, no finding modifications, no pipeline changes.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildEngagementMap } from "./engagement-map.js";
import { matchAbsenceFindings, type FindingInput } from "./absence-map-matcher.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const MatchResultSchema = z.object({
  finding_id: z.string(),
  title: z.string(),
  is_absence_claim: z.boolean(),
  decision: z.string().nullable(),
  disposition: z.string(),
  matched_topic: z.string().nullable(),
  matched_memos: z.array(z.number()),
  reason: z.string().nullable(),
});

const SummarySchema = z.object({
  absence_total: z.number(),
  demote: z.number(),
  surface_thesis_drift: z.number(),
  surface_omission: z.number(),
  flag: z.number(),
  not_applicable: z.number(),
});

const OutputSchema = z.object({
  deal_id: z.string(),
  run_id: z.string(),
  latest_full_memo_order: z.number(),
  model_used: z.string(),
  results: z.array(MatchResultSchema),
  summary: SummarySchema,
  partial: z.boolean(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "DiagAbsenceMatcher",
  description: "Matches absence findings against engagement map via LLM",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().nullable().describe("Deal ID; null = SCG deal"),
    runId: z.string().nullable().describe("Module run ID; null = auto-select largest OA run"),
  }),

  output: OutputSchema,

  async run(ctx, { dealId, runId }) {
    const targetDeal = dealId ?? SCG_DEAL_ID;

    // Platform timeout ~300s; budget: ~120s for map build + ~140s for matching
    const deadlineMs = Date.now() + 260_000;

    // ── Step 1: Build engagement map ──────────────────────────────────────
    const engagementMap = await buildEngagementMap(
      ctx.integrations.db.query.bind(ctx.integrations.db),
      ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
      targetDeal,
      deadlineMs,
    );

    // ── Step 2: Resolve OA run ────────────────────────────────────────────
    let resolvedRunId: string;

    if (runId) {
      resolvedRunId = runId;
    } else {
      const AutoSelectRow = z.object({ id: z.string() });
      const autoRows = await ctx.integrations.db.query(
        `SELECT mr.id
         FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        AutoSelectRow,
        [targetDeal],
        { label: "Auto-select largest OA run" }
      );
      if (autoRows.length === 0) {
        throw new Error("No completed omission_audit runs found for this deal");
      }
      resolvedRunId = autoRows[0].id;
    }

    // ── Step 3: Load findings ─────────────────────────────────────────────
    const FindingsRow = z.object({ findings: z.any() });
    const findingsRows = await ctx.integrations.db.query(
      `SELECT findings FROM module_outputs WHERE module_run_id = $1`,
      FindingsRow,
      [resolvedRunId],
      { label: "Fetch module_outputs findings" }
    );

    if (findingsRows.length === 0) {
      throw new Error(`No module_outputs found for run ${resolvedRunId}`);
    }

    const rawFindings: Array<any> = Array.isArray(findingsRows[0].findings)
      ? findingsRows[0].findings
      : [];

    // Map to minimal FindingInput shape
    const findings: FindingInput[] = rawFindings.map((f: any) => ({
      finding_id: f.finding_id ?? f.id ?? "unknown",
      title: f.title ?? "",
      detail: f.detail ?? "",
      gap_type: f.gap_type,
      finding_kind: f.finding_kind,
    }));

    // ── Step 4: Run matcher ───────────────────────────────────────────────
    const result = await matchAbsenceFindings(
      findings,
      engagementMap,
      ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
      targetDeal,
      resolvedRunId,
      deadlineMs,
    );

    return result;
  },
});
