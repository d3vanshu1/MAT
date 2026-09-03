/**
 * mast-label.ts
 *
 * Stage handler for label.
 *
 * Replaces the keyword-rule-table dependence classifier. Sends canonical
 * assumptions to a model in batches of 25, asks for one of five labels
 * per assumption, and writes assumption_label + label_reason.
 *
 * Also derives dependence_tier from the label using a fixed mapping so
 * that severity (unchanged) can read the tier as before.
 *
 * label is a loop stage: it checkpoints after each batch and resumes
 * mid-stage via cursor / resumePosition.
 *
 * Prompt, labels, batch size, and enum check ported verbatim from
 * MastDiagLabelProbe.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { z } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";

const LOG_PREFIX = "[MAST-LABEL]";
const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;
const BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Valid labels — ported verbatim from MastDiagLabelProbe
// ---------------------------------------------------------------------------

const VALID_LABELS = new Set([
  "exit_multiple",
  "revenue_growth",
  "financing",
  "operational",
  "unclassified",
]);

// ---------------------------------------------------------------------------
// Label → dependence_tier mapping
// ---------------------------------------------------------------------------

const LABEL_TO_TIER: Record<string, string> = {
  exit_multiple: "critical",
  revenue_growth: "high",
  financing: "moderate",
  operational: "low",
  unclassified: "low",
};

// ---------------------------------------------------------------------------
// Prompt — ported verbatim from MastDiagLabelProbe
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
// DB row schemas
// ---------------------------------------------------------------------------

const CanonicalRow = z.object({
  id: z.string(),
  proposition: z.string(),
});

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

// ---------------------------------------------------------------------------
// Helper — seed cumulative counters from prior payload
// ---------------------------------------------------------------------------

function seedNum(prior: Record<string, any>, key: string): number {
  return typeof prior[key] === "number" ? prior[key] : 0;
}

// ---------------------------------------------------------------------------
// Helper — persist payload to pipeline state
// ---------------------------------------------------------------------------

async function persistPayload(
  db: StageContext["db"],
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "label", JSON.stringify(payload)],
      { label: `${LOG_PREFIX} persist stage summary` },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const label: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── Prior payload for cumulative counters ────────────────────────
  let priorPayload: Record<string, any> = {};
  if (resumePosition > 0) {
    try {
      const [row] = await db.query(
        `SELECT payload FROM mast_pipeline_state
         WHERE run_id = $1::uuid AND stage = 'label' LIMIT 1`,
        z.object({ payload: z.any() }),
        [runId],
        { label: `${LOG_PREFIX} load prior payload` },
      );
      if (row?.payload && typeof row.payload === "object") {
        priorPayload = row.payload as Record<string, any>;
      }
    } catch { /* first invocation — no prior payload */ }
  }

  // ── Cumulative counters ──────────────────────────────────────────
  let invocationCount = seedNum(priorPayload, "invocationCount") + 1;
  let labelled = seedNum(priorPayload, "labelled");
  let labelRejected = seedNum(priorPayload, "labelRejected");
  let indexRejected = seedNum(priorPayload, "indexRejected");
  let unmentioned = seedNum(priorPayload, "unmentioned");
  let batchFailed = seedNum(priorPayload, "batchFailed");
  let totalInputTokens = seedNum(priorPayload, "totalInputTokens");
  let totalOutputTokens = seedNum(priorPayload, "totalOutputTokens");
  let totalCacheCreationTokens = seedNum(priorPayload, "totalCacheCreationTokens");
  let totalCacheReadTokens = seedNum(priorPayload, "totalCacheReadTokens");
  const labelCounts: Record<string, number> = {
    exit_multiple: seedNum(priorPayload?.labelCounts ?? {}, "exit_multiple"),
    revenue_growth: seedNum(priorPayload?.labelCounts ?? {}, "revenue_growth"),
    financing: seedNum(priorPayload?.labelCounts ?? {}, "financing"),
    operational: seedNum(priorPayload?.labelCounts ?? {}, "operational"),
    unclassified: seedNum(priorPayload?.labelCounts ?? {}, "unclassified"),
  };
  const rejectedValues: string[] = Array.isArray(priorPayload.rejectedValues)
    ? [...priorPayload.rejectedValues]
    : [];
  const unmentionedIds: string[] = Array.isArray(priorPayload.unmentionedIds)
    ? [...priorPayload.unmentionedIds]
    : [];
  const batchFailedIds: string[] = Array.isArray(priorPayload.batchFailedIds)
    ? [...priorPayload.batchFailedIds]
    : [];

  // ── Cursor from prior payload ────────────────────────────────────
  let cursor = typeof priorPayload.cursor === "number" ? priorPayload.cursor : 0;

  // ── Load canonical assumptions ───────────────────────────────────
  const allRows = await db.query(
    `SELECT id, proposition
     FROM mast_assumptions
     WHERE run_id = $1::uuid AND dedup_group_id = id
     ORDER BY id`,
    CanonicalRow,
    [runId],
    { label: `${LOG_PREFIX} load canonical assumptions` },
  );

  if (allRows.length === 0) {
    throw new Error(`${LOG_PREFIX} No canonical assumptions found for run ${runId}.`);
  }

  const totalRows = allRows.length;
  const totalBatches = Math.ceil(totalRows / BATCH_SIZE);

  console.log(
    `${LOG_PREFIX} Invocation ${invocationCount}: ${totalRows} canonical, ` +
    `cursor=${cursor}, totalBatches=${totalBatches}, resumePosition=${resumePosition}`,
  );

  let nextResumePosition = resumePosition > 0 ? resumePosition : 1;

  // ── Helper to build payload ──────────────────────────────────────
  const buildPayload = (): Record<string, unknown> => ({
    invocationCount,
    countersCumulative: true,
    cursor,
    labelled,
    labelRejected,
    indexRejected,
    unmentioned,
    batchFailed,
    labelCounts,
    rejectedValues: rejectedValues.slice(0, 50),
    unmentionedIds: unmentionedIds.slice(0, 200),
    batchFailedIds: batchFailedIds.slice(0, 200),
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    last_invocation_elapsed_ms: Date.now() - startTime,
  });

  // ── Process batches ──────────────────────────────────────────────
  for (let bIdx = cursor; bIdx < totalBatches; bIdx++) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded at batch ${bIdx}/${totalBatches} after ${Date.now() - startTime}ms.`,
      );
      cursor = bIdx;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
      return {
        complete: false,
        itemsDone: bIdx,
        itemsTotal: totalBatches,
        resumePosition: nextResumePosition,
      };
    }

    const batchStart = bIdx * BATCH_SIZE;
    const batch = allRows.slice(batchStart, batchStart + BATCH_SIZE);

    // Build numbered assumption list — 1-indexed within this batch
    const assumptionList = batch
      .map((a, j) => `${j + 1}. ${a.proposition}`)
      .join("\n");
    const userPrompt = `ASSUMPTIONS\n${assumptionList}`;

    // LLM call with retry
    interface RawEntry { index: number; label: string; reason: string }
    let parsed: RawEntry[] = [];
    let batchSuccess = false;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;

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
          { label: `${LOG_PREFIX} batch ${bIdx + 1}/${totalBatches} attempt ${attempts}` },
        );

        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;
        totalCacheCreationTokens += llmResponse.usage.cache_creation_input_tokens ?? 0;
        totalCacheReadTokens += llmResponse.usage.cache_read_input_tokens ?? 0;

        if (llmResponse.stop_reason === "max_tokens") {
          console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: TRUNCATED (attempt ${attempts}).`);
          continue;
        }

        let responseText = llmResponse.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");

        // Strip markdown fences
        responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

        try {
          const arr = JSON.parse(responseText);
          if (!Array.isArray(arr)) {
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
          console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: JSON parse failure (attempt ${attempts}).`);
          continue;
        }
      } catch (err) {
        const errMsg = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
        console.log(`${LOG_PREFIX} Batch ${bIdx + 1}: call error (attempt ${attempts}): ${errMsg.slice(0, 200)}`);
        continue;
      }
    }

    if (!batchSuccess) {
      // ── Batch failed: record assumption IDs, do not assign labels ──
      batchFailed++;
      for (const a of batch) {
        batchFailedIds.push(a.id);
      }
      console.log(
        `${LOG_PREFIX} Batch ${bIdx + 1}: FAILED after ${attempts} attempts. ` +
        `${batch.length} assumptions recorded as batchFailedIds.`,
      );

      // Write dependence_tier = low, dependence_basis = label_unavailable for failed batch
      for (const a of batch) {
        await db.execute(
          `UPDATE mast_assumptions
           SET dependence_tier = 'low',
               dependence_basis = 'label_unavailable',
               dependence_share = NULL
           WHERE id = $1::uuid`,
          [a.id],
          { label: `${LOG_PREFIX} fallback tier for failed batch` },
        );
      }

      cursor = bIdx + 1;
      continue;
    }

    // ── Process parsed entries ────────────────────────────────────────
    const batchIndices = new Set(batch.map((_, j) => j + 1));
    const mentionedIndices = new Set<number>();

    for (const entry of parsed) {
      // Reject out-of-range index
      if (!batchIndices.has(entry.index)) {
        indexRejected++;
        continue;
      }

      // Reject invalid label
      if (!VALID_LABELS.has(entry.label)) {
        labelRejected++;
        if (rejectedValues.length < 50) rejectedValues.push(entry.label);
        continue;
      }

      mentionedIndices.add(entry.index);
      labelCounts[entry.label] = (labelCounts[entry.label] || 0) + 1;
      labelled++;

      const assumption = batch[entry.index - 1];
      const tier = LABEL_TO_TIER[entry.label];
      const reason = entry.reason.slice(0, 100);

      // Write assumption_label, label_reason, and derived dependence_tier
      await db.execute(
        `UPDATE mast_assumptions
         SET assumption_label = $2,
             label_reason = $3,
             dependence_tier = $4,
             dependence_basis = 'model_label',
             dependence_share = NULL
         WHERE id = $1::uuid`,
        [assumption.id, entry.label, reason, tier],
        { label: `${LOG_PREFIX} update ${assumption.id}` },
      );
    }

    // ── Count unmentioned ────────────────────────────────────────────
    for (let j = 0; j < batch.length; j++) {
      if (!mentionedIndices.has(j + 1)) {
        unmentioned++;
        unmentionedIds.push(batch[j].id);

        // Write dependence_tier = low, dependence_basis = label_unavailable
        await db.execute(
          `UPDATE mast_assumptions
           SET dependence_tier = 'low',
               dependence_basis = 'label_unavailable',
               dependence_share = NULL
           WHERE id = $1::uuid`,
          [batch[j].id],
          { label: `${LOG_PREFIX} fallback tier for unmentioned ${batch[j].id}` },
        );
      }
    }

    cursor = bIdx + 1;
  }

  // ── All batches processed ────────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Complete. labelled=${labelled}, labelRejected=${labelRejected}, ` +
    `indexRejected=${indexRejected}, unmentioned=${unmentioned}, batchFailed=${batchFailed}. ` +
    `Labels: ${JSON.stringify(labelCounts)}. Elapsed: ${Date.now() - startTime}ms.`,
  );

  await persistPayload(db, runId, buildPayload());

  return {
    complete: true,
    itemsDone: totalBatches,
    itemsTotal: totalBatches,
    resumePosition: nextResumePosition,
  };
};

export default label;
