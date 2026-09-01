/**
 * mast-propositionalize.ts
 *
 * Stage handler for propositionalize.
 *
 * Rewrites the proposition column of model_explicit and model_implicit
 * assumption rows from cell-dump format into natural-language sentences
 * that a corpus sweep can match against. One LLM call per batch of 40.
 *
 * Writes only to mast_assumptions.proposition. Changes no other column.
 * No new tables or columns.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-PROP]";

const MODULE_ID = "mast_v2";

// ---------------------------------------------------------------------------
// Subjectless proposition filter (FIX 4)
// ---------------------------------------------------------------------------

/** Common assumption vocabulary — words that appear in any financial rewrite. */
const ASSUMPTION_VOCAB = new Set([
  "assumes", "assume", "assumed", "assumption",
  "rate", "percent", "percentage", "growth", "decline",
  "increase", "decrease", "value", "total", "amount",
  "margin", "multiple", "ratio", "factor",
  "annual", "monthly", "quarterly", "yearly",
  "period", "forecast", "projected", "estimated",
  "approximately", "constant", "fixed", "flat",
  "overlay", "adjustment", "applied",
  "times", "basis", "points",
]);

/** English stop words — short function words. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "of", "for", "by", "from", "with", "and",
  "or", "not", "no", "but", "if", "as", "its", "it", "this", "that",
  "than", "has", "have", "had", "will", "would", "shall", "should",
  "may", "might", "can", "could", "each", "all", "per", "over",
]);

/** Metric-only words — labels consisting only of these are too generic. */
const METRIC_ONLY_WORDS = new Set([
  "growth", "value", "total", "amount", "percent",
  "rate", "margin", "ratio", "multiple", "factor",
  "change", "delta", "count", "sum", "net",
]);

/**
 * Returns true when the rewritten sentence is subjectless — its only
 * substantive tokens are sheet-name fragments, assumption vocabulary,
 * stop words, and numbers.  Conservative: when in doubt, return false
 * (keep the row).
 */
function isSubjectlessSentence(
  sentence: string,
  sheetName: string,
  label: string,
): boolean {
  // Condition 2: label must be fewer than 3 chars or consist only of metric words
  const labelWords = label.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  const labelIsShort = label.replace(/[^a-zA-Z]/g, "").length < 3;
  const labelIsMetricOnly = labelWords.length > 0 && labelWords.every((w) => METRIC_ONLY_WORDS.has(w));
  if (!labelIsShort && !labelIsMetricOnly) return false;

  // Condition 1: sentence contains no alphabetic token of 4+ chars
  // other than sheet name tokens, assumption vocab, and stop words
  const sheetTokens = new Set(
    sheetName.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 0),
  );

  const sentenceTokens = sentence
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  for (const tok of sentenceTokens) {
    if (sheetTokens.has(tok)) continue;
    if (ASSUMPTION_VOCAB.has(tok)) continue;
    if (STOP_WORDS.has(tok)) continue;
    // Found a substantive token — sentence is NOT subjectless
    return false;
  }

  return true;
}
const BATCH_SIZE = 40;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Anthropic response schema
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
  }),
});

// ---------------------------------------------------------------------------
// DB row schema
// ---------------------------------------------------------------------------

const AssumptionRow = z.object({
  id: z.string(),
  proposition: z.string(),
  origin_locator: z.string().nullable(),
  value: z.coerce.string().nullable(),
  period: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the sheet name from an origin_locator like "SheetName!A1".
 * Falls back to "Unknown" if the format doesn't match.
 */
function sheetNameFrom(locator: string | null): string {
  if (!locator) return "Unknown";
  const idx = locator.lastIndexOf("!");
  return idx > 0 ? locator.slice(0, idx) : "Unknown";
}

/**
 * Extract the label from a proposition string.
 * model_explicit: "Label = value (period) (density)"
 * model_implicit: '"Label" is constant at ...' or '"Label" is zero ...'
 */
function extractLabel(proposition: string): string {
  // model_implicit: quoted label at the start
  if (proposition.startsWith('"')) {
    const endQuote = proposition.indexOf('"', 1);
    if (endQuote > 1) return proposition.slice(1, endQuote);
  }
  // model_explicit: everything before " = "
  const eqIdx = proposition.indexOf(" = ");
  if (eqIdx > 0) return proposition.slice(0, eqIdx).trim();
  return proposition;
}

/**
 * Strip the trailing density tag "(0.34)" from a proposition.
 * Density tags are the last parenthesised group matching (decimal).
 */
function stripDensityTag(proposition: string): string {
  return proposition.replace(/\s*\(\d+\.\d+\)\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildBatchPrompt(
  entries: Array<{
    index: number;
    sheet: string;
    label: string;
    value: string;
    period: string;
  }>,
): string {
  const numberedList = entries
    .map(
      (e) =>
        `${e.index}. Sheet: ${e.sheet}, Label: ${e.label}, Value: ${e.value}, Period: ${e.period}`,
    )
    .join("\n");

  return `Below is a numbered list of entries extracted from a financial model spreadsheet. Each entry represents an assumption the deal team has made.

For each entry, restate it as a single sentence describing what is being assumed, in the language an investment memo would use.

Formatting rules:
- A rate of 0.039 is stated as "3.9 percent"
- A multiple of 6 is stated as "6.0 times"
- A negative churn rate of -0.2 is stated as "20 percent annual churn"
- Percentages stored as decimals (e.g. 0.43) are stated as percentages (e.g. "43 percent")

You MUST NOT:
- Introduce any number not present in the entry
- Change any value
- Add context or justification not present in the entry
- Speculate about why the assumption was made

Return a JSON array only. No prose. No markdown fences. Each element has exactly two fields: "index" (integer matching the numbered entry) and "sentence" (the restated proposition).

--- ENTRIES ---
${numberedList}
--- END ENTRIES ---`;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const propositionalize: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 1. Load model_explicit and model_implicit rows ─────────────────
  //    Runs before register_assemble, so dedup_group_id is not yet set.
  const allRows = await db.query(
    `SELECT id, proposition, origin_locator, value, period
     FROM mast_assumptions
     WHERE run_id = $1::uuid
       AND origin_type IN ('model_explicit', 'model_implicit')
     ORDER BY id`,
    AssumptionRow,
    [runId],
    { label: "MAST-PROP: load model assumptions" },
  );

  const totalRows = allRows.length;
  console.log(
    `${LOG_PREFIX} ${totalRows} model assumptions loaded. Resume position: ${ctx.resumePosition}.`,
  );

  if (totalRows === 0) {
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 2. Process in batches ─────────────────────────────────────────
  let rowIdx = ctx.resumePosition;
  let rewritten = 0;
  let unchanged = 0;
  let subjectless = 0;
  let batchFailures = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (rowIdx < totalRows) {
    // Budget check — stop starting new batches past budget
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded at row ${rowIdx}/${totalRows}. Pausing.`,
      );
      break;
    }

    const batchEnd = Math.min(rowIdx + BATCH_SIZE, totalRows);
    const batch = allRows.slice(rowIdx, batchEnd);

    // Build entries for the prompt
    const entries = batch.map((row, i) => {
      const rawProp = stripDensityTag(row.proposition);
      return {
        index: i + 1,
        sheet: sheetNameFrom(row.origin_locator),
        label: extractLabel(rawProp),
        value: row.value ?? "N/A",
        period: row.period ?? "none",
      };
    });

    const userPrompt = buildBatchPrompt(entries);

    // ── LLM call with retry ─────────────────────────────────────────
    let sentenceMap: Map<number, string> | null = null;
    let attempts = 0;
    let lastWasError = false;
    let lastWasParseFailure = false;
    let lastWasTruncated = false;

    while (attempts < MAX_ATTEMPTS) {
      if (attempts > 0 && !lastWasError && !lastWasParseFailure && !lastWasTruncated) {
        break;
      }
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
              messages: [{ role: "user", content: userPrompt }],
            },
          },
          { response: MessageResponseSchema },
          { label: `MAST-PROP: batch ${rowIdx}–${batchEnd - 1} attempt ${attempts}` },
        );

        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;

        if (llmResponse.stop_reason === "max_tokens") {
          console.log(
            `${LOG_PREFIX} Batch ${rowIdx}: TRUNCATED (attempt ${attempts}).`,
          );
          lastWasTruncated = true;
        }

        const responseText = llmResponse.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");

        try {
          const parsed = JSON.parse(responseText);
          if (!Array.isArray(parsed)) {
            console.log(
              `${LOG_PREFIX} Batch ${rowIdx}: not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastWasParseFailure = true;
            continue;
          }
          sentenceMap = new Map<number, string>();
          for (const el of parsed) {
            if (
              el &&
              typeof el === "object" &&
              typeof el.index === "number" &&
              typeof el.sentence === "string" &&
              el.sentence.trim().length > 0 &&
              el.index >= 1 &&
              el.index <= batch.length
            ) {
              sentenceMap.set(el.index, el.sentence.trim());
            }
          }
          // Successfully parsed — done
          break;
        } catch (_parseErr) {
          console.log(
            `${LOG_PREFIX} Batch ${rowIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
          );
          lastWasParseFailure = true;
          continue;
        }
      } catch (llmErr) {
        console.log(
          `${LOG_PREFIX} Batch ${rowIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
        );
        lastWasError = true;
        continue;
      }
    }

    // ── Apply results ───────────────────────────────────────────────
    if (sentenceMap === null) {
      // All attempts failed — leave batch unchanged
      batchFailures++;
      unchanged += batch.length;
      console.log(
        `${LOG_PREFIX} Batch ${rowIdx}: all attempts failed. ${batch.length} rows unchanged.`,
      );
    } else {
      for (let i = 0; i < batch.length; i++) {
        const sentence = sentenceMap.get(i + 1);
        if (sentence) {
          // Reject any sentence containing a parenthesised decimal number
          // (density tags like "(0.34)" are build metadata, not content)
          const leakedTag = sentence.match(/\(\d+\.\d+\)/);
          if (leakedTag) {
            console.log(
              `${LOG_PREFIX} Row ${batch[i].id}: density-like tag "${leakedTag[0]}" found in rewritten proposition. Skipping.`,
            );
            unchanged++;
            continue;
          }

          // Reject subjectless propositions (FIX 4)
          const rowSheetName = sheetNameFrom(batch[i].origin_locator);
          const rowLabel = extractLabel(stripDensityTag(batch[i].proposition));
          if (isSubjectlessSentence(sentence, rowSheetName, rowLabel)) {
            console.log(
              `${LOG_PREFIX} Row ${batch[i].id}: subjectless proposition rejected. Sheet="${rowSheetName}", label="${rowLabel}".`,
            );
            subjectless++;
            continue;
          }

          await db.execute(
            `UPDATE mast_assumptions SET proposition = $2 WHERE id = $1::uuid`,
            [batch[i].id, sentence],
            { label: `MAST-PROP: rewrite ${batch[i].id}` },
          );
          rewritten++;
        } else {
          unchanged++;
        }
      }
    }

    rowIdx = batchEnd;
  }

  // ── 3. Log and persist payload ────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Processed rows ${ctx.resumePosition}–${rowIdx - 1} of ${totalRows}. ` +
    `Rewritten: ${rewritten}, unchanged: ${unchanged}, subjectless: ${subjectless}, batchFailures: ${batchFailures}. ` +
    `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out.`,
  );

  const summaryPayload = {
    rowsProcessed: rowIdx - ctx.resumePosition,
    rewritten,
    unchanged,
    subjectless,
    batchFailures,
    totalInputTokens,
    totalOutputTokens,
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "propositionalize", JSON.stringify(summaryPayload)],
      { label: "MAST-PROP: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  // ── 4. Completion check ───────────────────────────────────────────
  if (rowIdx < totalRows) {
    return {
      complete: false,
      itemsDone: rowIdx,
      itemsTotal: totalRows,
      resumePosition: rowIdx,
    };
  }

  console.log(
    `${LOG_PREFIX} propositionalize complete: ${rewritten} rewritten, ${unchanged} unchanged across ${totalRows} rows.`,
  );
  return {
    complete: true,
    itemsDone: totalRows,
    itemsTotal: totalRows,
    resumePosition: totalRows,
  };
};

export default propositionalize;
