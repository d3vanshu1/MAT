/**
 * mast-support-search.ts
 *
 * Stage handler for support_search.
 *
 * Sweeps every reference-corpus chunk against the assumption register.
 * Each call presents one pass-group's assumptions plus 8 chunks and asks
 * which assumptions the passages speak to, supporting or undermining.
 *
 * Produces only positive claims. Absence is computed later in code: if
 * every chunk has been swept and none claimed an assumption, that is an
 * unsupported verdict.
 *
 * Writes to mast_support_evidence. Reads mast_assumptions. Changes no
 * other table or column.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-SWEEP]";

const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;
const CHUNKS_PER_CALL = 8;
const MAX_ASSUMPTION_LIST_CHARS = 60_000;

// Position encoding: passIndex * PASS_MULTIPLIER + batchIndex
const PASS_MULTIPLIER = 100_000;

// Minimum word count for a quote to be accepted
const MIN_QUOTE_WORDS = 6;

// Prefix gate length — match first N normalized characters
const PREFIX_GATE_LEN = 40;

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
// DB row schemas
// ---------------------------------------------------------------------------

const AssumptionRow = z.object({
  id: z.string(),
  proposition: z.string(),
  origin_type: z.string(),
});

const ChunkRow = z.object({
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

// ---------------------------------------------------------------------------
// Normalization — local copy from mast-register-memo.ts
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment diligence analyst reviewing passages from deal documents against a numbered list of assumptions. Return only valid JSON.";

function buildSweepPrompt(
  assumptions: Array<{ index: number; proposition: string }>,
  chunks: Array<{ label: number; content: string }>,
): string {
  const assumptionList = assumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  const chunkList = chunks
    .map((c) => `--- CHUNK ${c.label} ---\n${c.content}\n--- END CHUNK ${c.label} ---`)
    .join("\n\n");

  return `Below is a numbered list of assumptions that a deal model depends on, followed by ${chunks.length} passages from deal documents, each labelled with its number.

ASSUMPTIONS
${assumptionList}

PASSAGES
${chunkList}

TASK
Which of the numbered assumptions does each passage say something about — supporting or undermining?

Most passages will speak to none of them. Returning an empty array is the expected and correct answer for most chunks. Do not stretch to find a connection. Only report an assumption when the passage genuinely bears on it.

A consultant's projection is "forecast", not "measured", regardless of the credibility of the source.

For each hit return four fields:
- "chunk": the chunk label number (integer)
- "index": the assumption number from the list above (integer)
- "quote": copied character for character from that passage
- "kind": one of "measured", "forecast", or "asserted"
  - "measured" means someone collected or observed this
  - "forecast" means it is a projection or expectation
  - "asserted" means it is stated without support

Respond with a JSON array only. No prose, no markdown fences. An empty array [] is valid.`;
}

// ---------------------------------------------------------------------------
// Hit shape for parsing
// ---------------------------------------------------------------------------

interface RawHit {
  chunk: number;
  index: number;
  quote: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const supportSearch: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 1. Load all canonical assumptions ─────────────────────────────
  const allAssumptions = await db.query(
    `SELECT id, proposition, origin_type
     FROM mast_assumptions
     WHERE run_id = $1::uuid AND dedup_group_id = id
     ORDER BY origin_type, id`,
    AssumptionRow,
    [runId],
    { label: "MAST-SWEEP: load canonical assumptions" },
  );

  if (allAssumptions.length === 0) {
    throw new Error(
      `${LOG_PREFIX} No canonical assumptions found for run ${runId}. Cannot proceed.`,
    );
  }

  // Number them 1..N
  const numberedAssumptions = allAssumptions.map((row, i) => ({
    index: i + 1,
    id: row.id,
    proposition: row.proposition,
  }));

  console.log(`${LOG_PREFIX} ${numberedAssumptions.length} canonical assumptions loaded.`);

  // ── 2. Split assumption list into pass groups ─────────────────────
  const serializedFull = numberedAssumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  let passGroups: Array<Array<{ index: number; id: string; proposition: string }>>;

  if (serializedFull.length <= MAX_ASSUMPTION_LIST_CHARS) {
    passGroups = [numberedAssumptions];
  } else {
    // Find fewest equal groups that each fit
    const totalLen = serializedFull.length;
    const groupCount = Math.ceil(totalLen / MAX_ASSUMPTION_LIST_CHARS);
    const groupSize = Math.ceil(numberedAssumptions.length / groupCount);
    passGroups = [];
    for (let g = 0; g < groupCount; g++) {
      const start = g * groupSize;
      const end = Math.min(start + groupSize, numberedAssumptions.length);
      if (start < numberedAssumptions.length) {
        passGroups.push(numberedAssumptions.slice(start, end));
      }
    }
  }

  console.log(
    `${LOG_PREFIX} ${passGroups.length} pass group(s). Serialized length: ${serializedFull.length} chars.`,
  );

  // ── 3. Load all reference-corpus chunks ───────────────────────────
  const allChunks = await db.query(
    `SELECT dc.chunk_index, dc.content, dc.document_id, d.file_name
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE d.deal_id = $1::uuid
       AND d.document_tag NOT IN ('financial_model', 'ic_memo')
     ORDER BY d.file_name, dc.chunk_index`,
    ChunkRow,
    [dealId],
    { label: "MAST-SWEEP: load reference corpus chunks" },
  );

  if (allChunks.length === 0) {
    throw new Error(
      `${LOG_PREFIX} No reference-corpus chunks found for deal ${dealId}. Cannot proceed.`,
    );
  }

  const totalChunks = allChunks.length;
  const totalBatches = Math.ceil(totalChunks / CHUNKS_PER_CALL);

  console.log(
    `${LOG_PREFIX} ${totalChunks} reference chunks in ${totalBatches} batches.`,
  );

  // ── 4. Decode resume position ─────────────────────────────────────
  let passIdx = Math.floor(resumePosition / PASS_MULTIPLIER);
  let batchIdx = resumePosition % PASS_MULTIPLIER;

  // ── 5. Idempotency — delete on fresh start ────────────────────────
  if (resumePosition === 0) {
    await db.execute(
      `DELETE FROM mast_support_evidence WHERE run_id = $1::uuid`,
      [runId],
      { label: "MAST-SWEEP: idempotency delete" },
    );
    console.log(`${LOG_PREFIX} Idempotency delete: cleared mast_support_evidence for run.`);
  }

  // ── 6. Build assumption ID lookup ─────────────────────────────────
  // We need to map from assumption index to assumption UUID
  const assumptionIdByIndex = new Map<number, string>();
  for (const a of numberedAssumptions) {
    assumptionIdByIndex.set(a.index, a.id);
  }

  // ── 7. Sweep ──────────────────────────────────────────────────────
  let totalHitsReturned = 0;
  let hitsPassedGate = 0;
  let rejectQuoteTooShort = 0;
  let rejectPrefixNotFound = 0;
  let rejectBadIndex = 0;
  let callFailures = 0;
  let truncations = 0;
  let chunksProcessed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const hitsByKind: Record<string, number> = {};
  const assumptionsHit = new Set<number>();

  while (passIdx < passGroups.length) {
    const passGroup = passGroups[passIdx];

    // Build the assumption entries for this pass group
    const passAssumptions = passGroup.map((a) => ({
      index: a.index,
      proposition: a.proposition,
    }));

    while (batchIdx < totalBatches) {
      // Budget check
      if (Date.now() - startTime > STAGE_BUDGET_MS) {
        const encodedPos = passIdx * PASS_MULTIPLIER + batchIdx;
        console.log(
          `${LOG_PREFIX} Budget exceeded at pass ${passIdx}, batch ${batchIdx}. Pausing at position ${encodedPos}.`,
        );

        // Persist payload before returning
        await persistPayload(db, runId, {
          chunksProcessed,
          totalHitsReturned,
          hitsPassedGate,
          rejectQuoteTooShort,
          rejectPrefixNotFound,
          rejectBadIndex,
          hitsByKind,
          distinctAssumptionsHit: assumptionsHit.size,
          callFailures,
          truncations,
          totalInputTokens,
          totalOutputTokens,
        });

        return {
          complete: false,
          itemsDone: chunksProcessed,
          itemsTotal: totalChunks * passGroups.length,
          resumePosition: encodedPos,
        };
      }

      // Build chunk batch
      const chunkStart = batchIdx * CHUNKS_PER_CALL;
      const chunkEnd = Math.min(chunkStart + CHUNKS_PER_CALL, totalChunks);
      const chunkBatch = allChunks.slice(chunkStart, chunkEnd);

      const labelledChunks = chunkBatch.map((c, i) => ({
        label: i + 1,
        content: c.content,
      }));

      const userPrompt = buildSweepPrompt(passAssumptions, labelledChunks);

      // ── LLM call with retry ──────────────────────────────────────
      let rawHits: RawHit[] = [];
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
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: userPrompt }],
              },
            },
            { response: MessageResponseSchema },
            { label: `MAST-SWEEP: pass ${passIdx} batch ${batchIdx} attempt ${attempts}` },
          );

          totalInputTokens += llmResponse.usage.input_tokens;
          totalOutputTokens += llmResponse.usage.output_tokens;

          if (llmResponse.stop_reason === "max_tokens") {
            console.log(
              `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx}: TRUNCATED (attempt ${attempts}).`,
            );
            lastWasTruncated = true;
            truncations++;
          }

          const responseText = llmResponse.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");

          try {
            const parsed = JSON.parse(responseText);
            if (!Array.isArray(parsed)) {
              console.log(
                `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx}: not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
              );
              lastWasParseFailure = true;
              continue;
            }
            rawHits = parsed.filter(
              (el: any): el is RawHit =>
                el &&
                typeof el === "object" &&
                typeof el.chunk === "number" &&
                typeof el.index === "number" &&
                typeof el.quote === "string" &&
                typeof el.kind === "string",
            );
            // Successfully parsed
            break;
          } catch (_parseErr) {
            console.log(
              `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastWasParseFailure = true;
            continue;
          }
        } catch (llmErr) {
          console.log(
            `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
          );
          lastWasError = true;
          callFailures++;
          continue;
        }
      }

      // ── Quote gate and write ──────────────────────────────────────
      for (const hit of rawHits) {
        totalHitsReturned++;

        // Validate chunk label
        if (hit.chunk < 1 || hit.chunk > chunkBatch.length) {
          rejectBadIndex++;
          continue;
        }

        // Validate assumption index exists in this pass group
        const validIndex = passGroup.some((a) => a.index === hit.index);
        if (!validIndex) {
          rejectBadIndex++;
          continue;
        }

        // Quote word count gate
        const quoteWords = hit.quote.trim().split(/\s+/);
        if (quoteWords.length < MIN_QUOTE_WORDS) {
          rejectQuoteTooShort++;
          console.log(
            `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx} chunk ${hit.chunk}: REJECT quote <${MIN_QUOTE_WORDS} words. Quote (120): ${hit.quote.slice(0, 120)}`,
          );
          continue;
        }

        // Prefix gate — corrected from full-string to prefix match
        const chunkContent = chunkBatch[hit.chunk - 1].content;
        const normalizedChunk = normalize(chunkContent);
        const normalizedQuote = normalize(hit.quote);

        let passedGate: boolean;
        if (normalizedQuote.length <= PREFIX_GATE_LEN) {
          // Short quote: require full normalized match
          passedGate = normalizedChunk.includes(normalizedQuote);
        } else {
          // Long quote: match on the first PREFIX_GATE_LEN chars as a prefix
          const prefix = normalizedQuote.slice(0, PREFIX_GATE_LEN);
          passedGate = normalizedChunk.includes(prefix);
        }

        if (!passedGate) {
          rejectPrefixNotFound++;
          console.log(
            `${LOG_PREFIX} Pass ${passIdx} batch ${batchIdx} chunk ${hit.chunk}: REJECT prefix not found. Quote (120): ${hit.quote.slice(0, 120)}`,
          );
          continue;
        }

        // Passed all gates — write to mast_support_evidence
        hitsPassedGate++;
        hitsByKind[hit.kind] = (hitsByKind[hit.kind] || 0) + 1;
        assumptionsHit.add(hit.index);

        const assumptionId = assumptionIdByIndex.get(hit.index);
        const chunkData = chunkBatch[hit.chunk - 1];
        const locator = `${chunkData.file_name}:chunk_${chunkData.chunk_index}`;
        const classifierReason = `pass_${passIdx}_batch_${batchIdx}`;

        await db.execute(
          `INSERT INTO mast_support_evidence (
             run_id, assumption_id, doc_id, locator, verbatim,
             statement_type, classifier_reason, spawned_assumption_id
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5,
             $6, $7, NULL
           )`,
          [
            runId,
            assumptionId,
            chunkData.document_id,
            locator,
            hit.quote,
            hit.kind,
            classifierReason,
          ],
          { label: `MAST-SWEEP: insert evidence for assumption ${hit.index}` },
        );
      }

      chunksProcessed += chunkBatch.length;
      batchIdx++;
    }

    // Finished all batches for this pass — advance to next pass
    passIdx++;
    batchIdx = 0;
  }

  // ── 8. Complete — log and persist ─────────────────────────────────
  console.log(
    `${LOG_PREFIX} support_search complete. ` +
    `chunksProcessed=${chunksProcessed}, totalHitsReturned=${totalHitsReturned}, ` +
    `hitsPassedGate=${hitsPassedGate}, rejectQuoteTooShort=${rejectQuoteTooShort}, ` +
    `rejectPrefixNotFound=${rejectPrefixNotFound}, rejectBadIndex=${rejectBadIndex}, ` +
    `callFailures=${callFailures}, truncations=${truncations}, ` +
    `distinctAssumptionsHit=${assumptionsHit.size}/${numberedAssumptions.length}. ` +
    `hitsByKind=${JSON.stringify(hitsByKind)}.`,
  );

  await persistPayload(db, runId, {
    chunksProcessed,
    totalHitsReturned,
    hitsPassedGate,
    rejectQuoteTooShort,
    rejectPrefixNotFound,
    rejectBadIndex,
    hitsByKind,
    distinctAssumptionsHit: assumptionsHit.size,
    callFailures,
    truncations,
    totalInputTokens,
    totalOutputTokens,
  });

  return {
    complete: true,
    itemsDone: totalChunks * passGroups.length,
    itemsTotal: totalChunks * passGroups.length,
    resumePosition: passGroups.length * PASS_MULTIPLIER,
  };
};

// ---------------------------------------------------------------------------
// Persist payload helper
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
      [runId, "support_search", JSON.stringify(payload)],
      { label: "MAST-SWEEP: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }
}

export default supportSearch;
