/**
 * mast-diag-label-probe.ts
 *
 * Diagnostic probe: sends canonical assumptions to a model and asks it to
 * classify each into one of five labels. Writes nothing. Returns the full
 * labelling result for offline analysis.
 *
 * Uses the cached-system-block pattern from mast-support-search.ts.
 *
 * Resumable by offset: pass offset to skip rows already processed.
 * Budget-aware: stops after 200s and reports nextOffset.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[MAST-LABEL-PROBE]";
const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;
const BATCH_SIZE = 25;
const BUDGET_MS = 200_000;

const VALID_LABELS = new Set([
  "exit_multiple",
  "revenue_growth",
  "financing",
  "operational",
  "unclassified",
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }),
});

const AssumptionRow = z.object({
  id: z.string(),
  proposition: z.string(),
  dependence_tier: z.string().nullable(),
});

const RunIdRow = z.object({ id: z.string() });
const TotalCountRow = z.object({ cnt: z.coerce.number() });

const FindingSeverityRow = z.object({
  assumption_id: z.string(),
  severity: z.string(),
});

// ---------------------------------------------------------------------------
// Failure detail types
// ---------------------------------------------------------------------------

interface BatchFailureDetail {
  batchIndex: number;
  cause: "timeout_or_abort" | "http_error" | "truncation" | "parse_failure";
  attempt: number;
  elapsedMs: number;
  errorMessage?: string;
  httpStatus?: number;
  rawResponseHead?: string;
  assumptions: Array<{ id: string; propositionHead: string }>;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment analyst classifying deal assumptions. Return only valid JSON.";

const CACHED_INSTRUCTIONS = `TASK
You are given a numbered list of assumptions from an investment memorandum. For each assumption, assign exactly one label and a short reason (at most 15 words).

LABELS (use exactly these strings):
- "exit_multiple" — anything bearing on what the business is sold for: exit or entry multiples, valuation, comparable transactions, re-rating, the EBITDA base the multiple is applied to, and stated returns that depend on an exit assumption.
- "revenue_growth" — anything bearing on how fast the business grows: revenue or gross profit growth, ARPU, customer wins, churn and retention, migrations, cross-sell, market share, and the earnings contribution of acquisitions.
- "financing" — leverage, debt, refinancing, dividend recapitalisation, covenants, interest, cash conversion and capex.
- "operational" — everything else that is a real assumption but bears on none of the above.
- "unclassified" — text that is not a usable assumption at all, or where the label is genuinely unclear from the text.

Return "unclassified" rather than guessing.

RESPONSE FORMAT
A JSON array of objects, each with:
- "index": the assumption number from the list (integer)
- "label": one of the five strings above
- "reason": at most 15 words

JSON only. No prose, no markdown fences. Every assumption must appear exactly once.`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastDiagLabelProbe",
  description: "Diagnostic: model-labels canonical assumptions into exit_multiple/revenue_growth/financing/operational/unclassified",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    limit: z.number().int().min(1).max(1000).default(200),
    offset: z.number().int().min(0).default(0),
  }),

  output: z.object({
    runId: z.string(),
    totalCanonical: z.number(),
    offset: z.number(),
    limit: z.number(),
    sampled: z.number(),
    batchCount: z.number(),
    batchesCompleted: z.number(),
    stoppedEarly: z.boolean(),
    nextOffset: z.number().nullable(),
    labelCounts: z.record(z.string(), z.number()),
    labelRejected: z.number(),
    rejectedValues: z.array(z.string()),
    unmentioned: z.number(),
    batchFailed: z.number(),
    batchFailedDetails: z.array(z.any()),
    labelled: z.array(z.object({
      index: z.number(),
      assumptionId: z.string(),
      proposition: z.string(),
      label: z.string(),
      reason: z.string(),
      dependenceTier: z.string().nullable(),
      severity: z.string().nullable(),
    })),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
  }),

  async run(ctx, { dealId, limit, offset }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.ai;
    const model = getModuleModel(MODULE_ID);
    const handlerStart = Date.now();

    // ── 1. Find most recent completed MAST run ──────────────────────
    const runs = await db.query(
      `SELECT id FROM module_runs
       WHERE deal_id = $1::uuid AND module_id = 'model_assumptions_stress' AND status = 'completed'
       ORDER BY triggered_at DESC LIMIT 1`,
      RunIdRow,
      [dealId],
      { label: `${LOG_PREFIX} find latest completed MAST run` },
    );

    if (runs.length === 0) {
      throw new Error(`${LOG_PREFIX} No completed MAST run found for deal ${dealId}.`);
    }
    const runId = runs[0].id;

    // ── 2. Count total canonical ────────────────────────────────────
    const [{ cnt: totalCanonical }] = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id`,
      TotalCountRow,
      [runId],
      { label: `${LOG_PREFIX} count canonical` },
    );

    // ── 3. Load assumptions with offset ─────────────────────────────
    const allRows = await db.query(
      `SELECT id, proposition, dependence_tier
       FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id
       ORDER BY id
       OFFSET $2
       LIMIT $3`,
      AssumptionRow,
      [runId, offset, limit],
      { label: `${LOG_PREFIX} load canonical assumptions (offset=${offset}, limit=${limit})` },
    );

    const sampled = allRows.length;
    console.log(
      `${LOG_PREFIX} Run ${runId}: ${totalCanonical} canonical, offset=${offset}, limit=${limit}, sampled=${sampled}.`,
    );

    // ── 4. Load severity for each assumption ────────────────────────
    const severityRows = await db.query(
      `SELECT DISTINCT ON (f.assumption_id) f.assumption_id, f.severity
       FROM mast_findings f
       JOIN mast_assumptions a ON a.id = f.assumption_id AND a.run_id = f.run_id
       WHERE f.run_id = $1::uuid AND a.dedup_group_id = a.id
       ORDER BY f.assumption_id,
         CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
      FindingSeverityRow,
      [runId],
      { label: `${LOG_PREFIX} load severities` },
    );
    const severityMap = new Map(severityRows.map((r) => [r.assumption_id, r.severity]));

    // ── 5. Batch and label ──────────────────────────────────────────
    const batches: Array<Array<{ index: number; id: string; proposition: string; dependenceTier: string | null }>> = [];
    for (let i = 0; i < sampled; i += BATCH_SIZE) {
      const batch = allRows.slice(i, i + BATCH_SIZE).map((row, j) => ({
        index: offset + i + j + 1,
        id: row.id,
        proposition: row.proposition,
        dependenceTier: row.dependence_tier,
      }));
      batches.push(batch);
    }

    const batchCount = batches.length;
    console.log(`${LOG_PREFIX} ${batchCount} batches of up to ${BATCH_SIZE}.`);

    const labelCounts: Record<string, number> = {
      exit_multiple: 0,
      revenue_growth: 0,
      financing: 0,
      operational: 0,
      unclassified: 0,
    };
    let labelRejected = 0;
    const rejectedValues: string[] = [];
    let unmentioned = 0;
    let batchFailed = 0;
    const batchFailedDetails: BatchFailureDetail[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let batchesCompleted = 0;
    let stoppedEarly = false;

    const labelled: Array<{
      index: number;
      assumptionId: string;
      proposition: string;
      label: string;
      reason: string;
      dependenceTier: string | null;
      severity: string | null;
    }> = [];

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      // ── Budget check ──────────────────────────────────────────────
      if (Date.now() - handlerStart > BUDGET_MS) {
        stoppedEarly = true;
        console.log(
          `${LOG_PREFIX} Budget exceeded at batch ${bIdx + 1}/${batchCount} after ${Date.now() - handlerStart}ms. Stopping.`,
        );
        break;
      }

      const batch = batches[bIdx];

      // Build user prompt with numbered assumptions
      const assumptionList = batch
        .map((a) => `${a.index}. ${a.proposition}`)
        .join("\n");
      const userPrompt = `ASSUMPTIONS\n${assumptionList}`;

      // LLM call with retry
      interface RawEntry { index: number; label: string; reason: string }
      let parsed: RawEntry[] = [];
      let batchSuccess = false;
      let attempts = 0;
      let lastFailure: BatchFailureDetail | null = null;

      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        const callStart = Date.now();

        try {
          const llmResponse = await ai.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model,
                max_tokens: MAX_OUTPUT_TOKENS,
                system: [
                  { type: "text", text: SYSTEM_PROMPT },
                  { type: "text", text: CACHED_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
                ],
                messages: [{ role: "user", content: userPrompt }],
              },
            },
            { response: MessageResponseSchema },
            { label: `${LOG_PREFIX} batch ${bIdx + 1}/${batchCount} attempt ${attempts}` },
          );

          const callElapsed = Date.now() - callStart;
          totalInputTokens += llmResponse.usage.input_tokens;
          totalOutputTokens += llmResponse.usage.output_tokens;

          console.log(
            `${LOG_PREFIX} CACHE batch=${bIdx + 1} attempt=${attempts} elapsed=${callElapsed}ms ` +
            `created=${llmResponse.usage.cache_creation_input_tokens ?? 0} ` +
            `read=${llmResponse.usage.cache_read_input_tokens ?? 0} ` +
            `input=${llmResponse.usage.input_tokens}`,
          );

          if (llmResponse.stop_reason === "max_tokens") {
            lastFailure = {
              batchIndex: bIdx,
              cause: "truncation",
              attempt: attempts,
              elapsedMs: callElapsed,
              assumptions: batch.map((a) => ({ id: a.id, propositionHead: a.proposition.slice(0, 60) })),
            };
            console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: TRUNCATED (attempt ${attempts}, ${callElapsed}ms).`);
            continue;
          }

          let responseText = llmResponse.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");

          // Strip markdown fences — model sometimes wraps JSON in ```json ... ```
          responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

          try {
            const arr = JSON.parse(responseText);
            if (!Array.isArray(arr)) {
              lastFailure = {
                batchIndex: bIdx,
                cause: "parse_failure",
                attempt: attempts,
                elapsedMs: callElapsed,
                rawResponseHead: responseText.slice(0, 300),
                assumptions: batch.map((a) => ({ id: a.id, propositionHead: a.proposition.slice(0, 60) })),
              };
              console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: not an array (attempt ${attempts}, ${callElapsed}ms).`);
              continue;
            }
            parsed = arr.filter(
              (el: any): el is RawEntry =>
                el &&
                typeof el === "object" &&
                typeof el.index === "number" &&
                typeof el.label === "string" &&
                typeof el.reason === "string",
            );
            batchSuccess = true;
            break;
          } catch {
            lastFailure = {
              batchIndex: bIdx,
              cause: "parse_failure",
              attempt: attempts,
              elapsedMs: callElapsed,
              rawResponseHead: responseText.slice(0, 300),
              assumptions: batch.map((a) => ({ id: a.id, propositionHead: a.proposition.slice(0, 60) })),
            };
            console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: JSON parse failure (attempt ${attempts}, ${callElapsed}ms).`);
            continue;
          }
        } catch (err) {
          const callElapsed = Date.now() - callStart;
          const errMsg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);

          // Distinguish timeout/abort from HTTP errors
          const isTimeout = /timeout|abort|cancel|ECONNRESET|socket hang up/i.test(errMsg);
          const httpStatusMatch = errMsg.match(/status[:\s]+(\d{3})/i);
          const httpStatus = httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : undefined;

          lastFailure = {
            batchIndex: bIdx,
            cause: isTimeout ? "timeout_or_abort" : "http_error",
            attempt: attempts,
            elapsedMs: callElapsed,
            errorMessage: errMsg.slice(0, 500),
            httpStatus,
            assumptions: batch.map((a) => ({ id: a.id, propositionHead: a.proposition.slice(0, 60) })),
          };
          console.log(
            `${LOG_PREFIX} Batch ${bIdx + 1}: ${lastFailure.cause} (attempt ${attempts}, ${callElapsed}ms): ${errMsg.slice(0, 200)}`,
          );
          continue;
        }
      }

      if (!batchSuccess) {
        batchFailed++;
        if (lastFailure) {
          batchFailedDetails.push(lastFailure);
        }
        console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: FAILED after ${attempts} attempts. Cause: ${lastFailure?.cause ?? "unknown"}`);
        // Count all assumptions in the failed batch as neither labelled nor unmentioned
        // — they are tracked in batchFailedDetails
        batchesCompleted++;
        continue;
      }

      // Process parsed entries
      const batchIndices = new Set(batch.map((a) => a.index));
      const mentionedIndices = new Set<number>();

      for (const entry of parsed) {
        // Reject out-of-range index
        if (!batchIndices.has(entry.index)) continue;

        // Reject invalid label
        if (!VALID_LABELS.has(entry.label)) {
          labelRejected++;
          if (rejectedValues.length < 50) rejectedValues.push(entry.label);
          continue;
        }

        mentionedIndices.add(entry.index);
        labelCounts[entry.label] = (labelCounts[entry.label] || 0) + 1;

        const batchItem = batch.find((a) => a.index === entry.index)!;
        labelled.push({
          index: entry.index,
          assumptionId: batchItem.id,
          proposition: batchItem.proposition,
          label: entry.label,
          reason: entry.reason.slice(0, 100),
          dependenceTier: batchItem.dependenceTier,
          severity: severityMap.get(batchItem.id) ?? null,
        });
      }

      // Count unmentioned
      for (const a of batch) {
        if (!mentionedIndices.has(a.index)) {
          unmentioned++;
        }
      }

      batchesCompleted++;
    }

    // Compute nextOffset
    const rowsConsumed = stoppedEarly
      ? batchesCompleted * BATCH_SIZE
      : sampled;
    const nextOffset = (offset + rowsConsumed < totalCanonical)
      ? offset + rowsConsumed
      : null;

    console.log(
      `${LOG_PREFIX} Done. Labels: ${JSON.stringify(labelCounts)}. ` +
      `labelRejected=${labelRejected}, unmentioned=${unmentioned}, batchFailed=${batchFailed}. ` +
      `stoppedEarly=${stoppedEarly}, nextOffset=${nextOffset}. ` +
      `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out. Elapsed: ${Date.now() - handlerStart}ms.`,
    );

    return {
      runId,
      totalCanonical,
      offset,
      limit,
      sampled,
      batchCount,
      batchesCompleted,
      stoppedEarly,
      nextOffset,
      labelCounts,
      labelRejected,
      rejectedValues,
      unmentioned,
      batchFailed,
      batchFailedDetails,
      labelled,
      totalInputTokens,
      totalOutputTokens,
    };
  },
});
