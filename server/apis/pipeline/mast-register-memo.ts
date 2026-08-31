/**
 * mast-register-memo.ts
 *
 * Stage handler for register_memo.
 *
 * Reads IC memo chunks and extracts forward-looking propositions the deal
 * depends on, each anchored to a verbatim quote. One LLM call per chunk.
 *
 * This is the only path by which unquantified assumptions enter the register:
 * management retention, integration timelines, pipeline availability.
 *
 * No cross-chunk reasoning. Each chunk is processed independently.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-MEMO]";

const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const PROPOSITIONS_PER_CHUNK_CAP = 15;

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const MemoChunkRow = z.object({
  chunk_id: z.string(),
  chunk_index: z.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

// ---------------------------------------------------------------------------
// Anthropic response schema (matches bss-llm-adjudication pattern)
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
// Normalization for quote-gating
// ---------------------------------------------------------------------------

/**
 * Normalize text for substring matching:
 * lowercase, replace every non-letter/digit/space with a single space,
 * collapse all whitespace runs to one space, trim.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment diligence analyst. Extract forward-looking propositions from the text exactly as instructed. Return only valid JSON.";

function buildUserPrompt(chunkContent: string): string {
  return `Below is a section of an investment committee memo. Extract every forward-looking proposition the deal team is relying on that could turn out to be wrong.

Forms to look for include: "we expect", "we assume", "this depends on", "management will", "the plan requires", "we believe", "underwritten at", "our base case", "subject to".

DO NOT extract any of the following:
- Historical facts
- Descriptions of what the company does
- Past performance
- Derived or computed numbers
- Figures restated in different units
- Interpretations of what a statement implies
- Paraphrased quotes

Each quote must be copied character for character from the chunk text below. A quote that does not appear verbatim in the chunk will be discarded.

Return the most load-bearing propositions first. Return at most ${PROPOSITIONS_PER_CHUNK_CAP}.

Return a JSON array only. No prose. No markdown fences. Each element has exactly two string fields: "proposition" and "quote".

Example format:
[{"proposition":"Management will retain all key executives through close","quote":"we assume all key executives will remain through the transition period"}]

--- CHUNK TEXT ---
${chunkContent}
--- END CHUNK TEXT ---`;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const registerMemo: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  if (!ai) {
    throw new Error(
      `${LOG_PREFIX} StageContext.ai is required for register_memo but was not provided. ` +
      `The orchestrator must declare an anthropic integration and pass it in the context.`,
    );
  }

  const model = getModuleModel(MODULE_ID);

  // ── 1. Load all IC memo chunks ─────────────────────────────────────
  const allChunks = await db.query(
    `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content,
            dc.document_id, dc.file_name
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE d.deal_id = $1::uuid
       AND d.document_tag = 'ic_memo'
     ORDER BY dc.file_name ASC, dc.chunk_index ASC`,
    MemoChunkRow,
    [dealId],
    { label: "MAST-MEMO: load IC memo chunks" },
  );

  if (allChunks.length === 0) {
    console.log(`${LOG_PREFIX} No IC memo chunks found for deal ${dealId}. Stage complete with 0 propositions.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  console.log(`${LOG_PREFIX} ${allChunks.length} memo chunks loaded. Resuming from position ${resumePosition}.`);

  // ── 2. Process chunks with resume support ──────────────────────────
  const totalChunks = allChunks.length;
  let chunkIdx = resumePosition;
  let totalAccepted = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Rejection counters
  let rejectEmptyProposition = 0;
  let rejectShortProposition = 0;
  let rejectEmptyQuote = 0;
  let rejectShortQuote = 0;
  let rejectQuoteNotFound = 0;

  while (chunkIdx < totalChunks) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded after ${chunkIdx - resumePosition} chunks. Pausing at chunk ${chunkIdx}/${totalChunks}.`,
      );
      break;
    }

    const chunk = allChunks[chunkIdx];
    const locator = `${chunk.file_name} chunk ${chunk.chunk_index}`;

    // ── 2a. Idempotency: delete existing rows for this chunk ─────────
    await db.execute(
      `DELETE FROM mast_assumptions
       WHERE run_id = $1::uuid
         AND origin_type = 'memo_prose'
         AND origin_locator = $2`,
      [runId, locator],
      { label: `MAST-MEMO: clear existing rows for ${locator}` },
    );

    // ── 2b. LLM call ────────────────────────────────────────────────
    const userPrompt = buildUserPrompt(chunk.content);
    let propositions: Array<{ proposition: string; quote: string }> = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 2; // one retry on parse failure

    while (attempts < MAX_ATTEMPTS && propositions.length === 0) {
      attempts++;
      try {
        const llmResponse = await ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model,
              max_tokens: MAX_OUTPUT_TOKENS,
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userPrompt }],
            },
          },
          { response: MessageResponseSchema },
          { label: `MAST-MEMO: extract chunk ${chunkIdx} attempt ${attempts}` },
        );

        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;

        const responseText = llmResponse.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");

        // Parse JSON array strictly
        try {
          const parsed = JSON.parse(responseText);
          if (!Array.isArray(parsed)) {
            console.log(
              `${LOG_PREFIX} Chunk ${chunkIdx}: response is not an array. Raw (300): ${responseText.slice(0, 300)}`,
            );
            continue;
          }
          propositions = parsed.filter(
            (el: any) =>
              el &&
              typeof el === "object" &&
              typeof el.proposition === "string" &&
              typeof el.quote === "string",
          );
        } catch (_parseErr) {
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
          );
          continue;
        }
      } catch (llmErr) {
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
        );
        continue;
      }
    }

    // Cap at PROPOSITIONS_PER_CHUNK_CAP
    if (propositions.length > PROPOSITIONS_PER_CHUNK_CAP) {
      console.log(
        `${LOG_PREFIX} Chunk ${chunkIdx}: ${propositions.length} propositions returned — capping at ${PROPOSITIONS_PER_CHUNK_CAP}.`,
      );
      propositions = propositions.slice(0, PROPOSITIONS_PER_CHUNK_CAP);
    }

    // ── 2c. Quote gate — enforce in code ─────────────────────────────
    const normalizedChunkContent = normalize(chunk.content);
    let chunkAccepted = 0;

    for (const prop of propositions) {
      // Gate: proposition not empty
      if (!prop.proposition || prop.proposition.trim().length === 0) {
        rejectEmptyProposition++;
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT empty proposition. Quote (120): ${(prop.quote ?? "").slice(0, 120)}`,
        );
        continue;
      }

      // Gate: proposition at least 4 words
      const propWords = prop.proposition.trim().split(/\s+/);
      if (propWords.length < 4) {
        rejectShortProposition++;
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT proposition <4 words: "${prop.proposition}". Quote (120): ${prop.quote.slice(0, 120)}`,
        );
        continue;
      }

      // Gate: quote not empty
      if (!prop.quote || prop.quote.trim().length === 0) {
        rejectEmptyQuote++;
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT empty quote. Proposition: "${prop.proposition}"`,
        );
        continue;
      }

      // Gate: quote at least 6 words
      const quoteWords = prop.quote.trim().split(/\s+/);
      if (quoteWords.length < 6) {
        rejectShortQuote++;
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT quote <6 words. Quote (120): ${prop.quote.slice(0, 120)}`,
        );
        continue;
      }

      // Gate: normalized quote is a substring of normalized chunk content
      const normalizedQuote = normalize(prop.quote);
      if (!normalizedChunkContent.includes(normalizedQuote)) {
        rejectQuoteNotFound++;
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT quote not found in chunk. Quote (120): ${prop.quote.slice(0, 120)}`,
        );
        continue;
      }

      // ── 2d. Write accepted proposition ─────────────────────────────
      await db.execute(
        `INSERT INTO mast_assumptions (
           run_id, deal_id, proposition, origin_type, origin_doc_id,
           origin_locator, verbatim, quantified, value, unit, period,
           detector, recursion_depth
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'memo_prose', $4::uuid,
           $5, $6, false, NULL, NULL, NULL,
           NULL, 0
         )`,
        [
          runId, dealId, prop.proposition, chunk.document_id,
          locator, prop.quote,
        ],
        { label: `MAST-MEMO: insert proposition from ${locator}` },
      );

      chunkAccepted++;
    }

    totalAccepted += chunkAccepted;
    console.log(
      `${LOG_PREFIX} Chunk ${chunkIdx} (${locator}): ${chunkAccepted} accepted of ${propositions.length} returned.`,
    );

    chunkIdx++;
  }

  // ── 3. Stage log summary ───────────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Processed chunks ${resumePosition}–${chunkIdx - 1} of ${totalChunks}. ` +
    `Accepted: ${totalAccepted}. Tokens: ${totalInputTokens} in / ${totalOutputTokens} out. ` +
    `Rejections: empty_proposition=${rejectEmptyProposition}, short_proposition=${rejectShortProposition}, ` +
    `empty_quote=${rejectEmptyQuote}, short_quote=${rejectShortQuote}, quote_not_found=${rejectQuoteNotFound}.`,
  );

  // ── 4. Completion check ────────────────────────────────────────────
  if (chunkIdx < totalChunks) {
    return {
      complete: false,
      itemsDone: chunkIdx,
      itemsTotal: totalChunks,
      resumePosition: chunkIdx,
    };
  }

  // All chunks processed — fail closed if zero accepted
  if (totalAccepted === 0) {
    throw new Error(
      `${LOG_PREFIX} All ${totalChunks} memo chunks processed but zero propositions accepted. ` +
      `Extraction is broken. Rejections: empty_proposition=${rejectEmptyProposition}, ` +
      `short_proposition=${rejectShortProposition}, empty_quote=${rejectEmptyQuote}, ` +
      `short_quote=${rejectShortQuote}, quote_not_found=${rejectQuoteNotFound}.`,
    );
  }

  console.log(
    `${LOG_PREFIX} register_memo complete: ${totalAccepted} propositions across ${totalChunks} chunks.`,
  );
  return {
    complete: true,
    itemsDone: totalChunks,
    itemsTotal: totalChunks,
    resumePosition: totalChunks,
  };
};

export default registerMemo;
