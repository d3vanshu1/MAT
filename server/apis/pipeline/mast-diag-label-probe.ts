/**
 * mast-diag-label-probe.ts
 *
 * Diagnostic probe: sends canonical assumptions to a model and asks it to
 * classify each into one of five labels. Writes nothing. Returns the full
 * labelling result for offline analysis.
 *
 * Uses the cached-system-block pattern from mast-support-search.ts.
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

const RunIdRow = z.object({
  id: z.string(),
});

const TotalCountRow = z.object({
  cnt: z.coerce.number(),
});

const FindingSeverityRow = z.object({
  assumption_id: z.string(),
  severity: z.string(),
});

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
  }),

  output: z.object({
    runId: z.string(),
    totalCanonical: z.number(),
    sampled: z.number(),
    batchCount: z.number(),
    labelCounts: z.record(z.string(), z.number()),
    labelRejected: z.number(),
    rejectedValues: z.array(z.string()),
    unmentioned: z.number(),
    batchFailed: z.number(),
    batchFailedIndices: z.array(z.array(z.number())),
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

  async run(ctx, { dealId, limit }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.ai;
    const model = getModuleModel(MODULE_ID);

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

    // ── 3. Load assumptions ─────────────────────────────────────────
    const allRows = await db.query(
      `SELECT id, proposition, dependence_tier
       FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id
       ORDER BY id
       LIMIT $2`,
      AssumptionRow,
      [runId, limit],
      { label: `${LOG_PREFIX} load canonical assumptions` },
    );

    const sampled = allRows.length;
    console.log(`${LOG_PREFIX} Run ${runId}: ${totalCanonical} canonical, ${sampled} sampled.`);

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
        index: i + j + 1,
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
    const batchFailedIndices: number[][] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

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
      let lastWasError = false;
      let lastWasParseFailure = false;
      let lastWasTruncated = false;

      while (attempts < MAX_ATTEMPTS) {
        if (attempts > 0 && !lastWasError && !lastWasParseFailure && !lastWasTruncated) break;
        attempts++;
        lastWasError = false;
        lastWasParseFailure = false;
        lastWasTruncated = false;

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

          totalInputTokens += llmResponse.usage.input_tokens;
          totalOutputTokens += llmResponse.usage.output_tokens;

          console.log(
            `${LOG_PREFIX} CACHE batch=${bIdx + 1} ` +
            `created=${llmResponse.usage.cache_creation_input_tokens ?? 0} ` +
            `read=${llmResponse.usage.cache_read_input_tokens ?? 0} ` +
            `input=${llmResponse.usage.input_tokens}`,
          );

          if (llmResponse.stop_reason === "max_tokens") {
            lastWasTruncated = true;
            console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: TRUNCATED (attempt ${attempts}).`);
            continue;
          }

          const responseText = llmResponse.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");

          try {
            const arr = JSON.parse(responseText);
            if (!Array.isArray(arr)) {
              lastWasParseFailure = true;
              console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: not an array (attempt ${attempts}).`);
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
            lastWasParseFailure = true;
            console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: JSON parse failure (attempt ${attempts}).`);
            continue;
          }
        } catch (err) {
          lastWasError = true;
          console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: LLM call failed (attempt ${attempts}): ${String(err)}`);
          continue;
        }
      }

      if (!batchSuccess) {
        batchFailed++;
        batchFailedIndices.push(batch.map((a) => a.index));
        console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: FAILED after ${attempts} attempts.`);
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
    }

    console.log(
      `${LOG_PREFIX} Complete. Labels: ${JSON.stringify(labelCounts)}. ` +
      `labelRejected=${labelRejected}, unmentioned=${unmentioned}, batchFailed=${batchFailed}. ` +
      `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out.`,
    );

    return {
      runId,
      totalCanonical,
      sampled,
      batchCount,
      labelCounts,
      labelRejected,
      rejectedValues,
      unmentioned,
      batchFailed,
      batchFailedIndices,
      labelled,
      totalInputTokens,
      totalOutputTokens,
    };
  },
});
