/**
 * mast-sweep.ts
 *
 * MAST v2 — sweep stage.
 *
 * Two phases:
 *   Phase 1 (search): support_search — LLM sweep of reference corpus (Arm B prompt)
 *   Phase 2 (recurse): forecast_recursion — promote forecast evidence to assumptions
 *
 * reliance_links and inheritance were removed: all reference documents are
 * PDFs with no doc_tables rows, so the numeric right-side index was always
 * empty.  inheritance's fallback read 15 of 1,038 chunks (1.4%).  Both
 * phases are retained on disk but no longer in STAGES.
 *
 * Resume encoding:
 *   resumePosition = 0 → fresh start (phase search, cursor 0)
 *   resumePosition > 0 → read payload.phase and payload.phaseCursor
 *
 * Counters are cumulative across invocations via seedNum pattern.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */

import { z } from "@superblocksteam/sdk-api";
import type {
  StageContext,
  StageResult,
  StageHandler,
} from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";

const LOG_PREFIX = "[MAST-SWEEP]";
const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;

type SweepPhase = "search" | "recurse" | "complete";

// ---------------------------------------------------------------------------
// Shared DB schemas
// ---------------------------------------------------------------------------

const PayloadRow = z.object({ payload: z.any() });
const CountRow = z.object({ cnt: z.coerce.number() });

// ---------------------------------------------------------------------------
// Payload seeding
// ---------------------------------------------------------------------------

async function readPriorPayload(
  db: StageContext["db"],
  runId: string,
): Promise<Record<string, any>> {
  try {
    const rows = await db.query(
      `SELECT payload FROM mast_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'sweep' AND stage != '_lock'
       LIMIT 1`,
      PayloadRow,
      [runId],
      { label: `${LOG_PREFIX} read prior payload for seeding` },
    );
    if (rows.length > 0 && rows[0].payload && typeof rows[0].payload === "object") {
      return rows[0].payload as Record<string, any>;
    }
  } catch (err) {
    console.log(`${LOG_PREFIX} Failed to read prior payload: ${String(err)}`);
  }
  return {};
}

function seedNum(prior: Record<string, any>, key: string): number {
  return typeof prior[key] === "number" ? prior[key] : 0;
}

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
      [runId, "sweep", JSON.stringify(payload)],
      { label: `${LOG_PREFIX} persist stage summary` },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }
}

// =========================================================================
// PHASE 1: SEARCH (ported from mast-support-search.ts — Arm B prompt)
// =========================================================================

// reliance_links and inheritance code removed.  Source handlers retained
// on disk at mast-reliance-links.ts and mast-inheritance.ts.

const CHUNKS_PER_CALL = 8;
const MIN_QUOTE_WORDS = 6;
const PREFIX_GATE_LEN = 40;
const MAX_ASSUMPTION_LIST_CHARS = 60_000;

const SEARCH_SYSTEM_PROMPT =
  "You are an investment diligence analyst reviewing passages from deal documents against a numbered list of assumptions. Return only valid JSON.";

function buildCachedPrefix(
  assumptions: Array<{ index: number; proposition: string }>,
): string {
  const assumptionList = assumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  return `ASSUMPTIONS
${assumptionList}

TASK
For each passage, determine whether it bears on any of the numbered assumptions.

A passage bears on an assumption when it:
- Supports it with measured data, a forecast, or an assertion
- Undermines it with contradicting evidence
- Constrains it by describing a legal, regulatory, contractual, or operational condition that would make the assumption harder to achieve, even when the passage does not restate the assumption's wording
- Defines it by establishing a scope, methodology, or threshold the assumption depends on

Most passages will speak to none of them. Returning an empty array is the expected and correct answer for most chunks. Do not stretch to find a connection. Only report an assumption when the passage genuinely bears on it.

A consultant's projection is "forecast", not "measured", regardless of the credibility of the source.

For each hit return five fields:
- "chunk": the chunk label number (integer)
- "index": the assumption number from the list above (integer)
- "quote": copied character for character from that passage
- "kind": one of "measured", "forecast", or "asserted"
  - "measured" means someone collected or observed this
  - "forecast" means it is a projection or expectation
  - "asserted" means it is stated without support
- "relation": one of "supports", "undermines", "constrains", "defines"

Respond with a JSON array only. No prose, no markdown fences. An empty array [] is valid.`;
}

function buildPassagesBlock(
  chunks: Array<{ label: number; content: string }>,
): string {
  const chunkList = chunks
    .map((c) => `--- CHUNK ${c.label} ---\n${c.content}\n--- END CHUNK ${c.label} ---`)
    .join("\n\n");

  return `Below is a numbered list of assumptions that a deal model depends on, followed by ${chunks.length} passages from deal documents, each labelled with its number.

Passages are labelled 1 through ${chunks.length} for this request only. The "chunk" field in your response must be that label. Do not use document page numbers, corpus indices, or any other numbering.

PASSAGES
${chunkList}`;
}

interface RawHit {
  chunk: number;
  index: number;
  quote: string;
  kind: string;
  relation?: string;
}

const SearchAssumptionRow = z.object({
  row_num: z.coerce.number(),
  id: z.string(),
  proposition: z.string(),
});

const SearchChunkRow = z.object({
  chunk_id: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

const SearchMessageResponseSchema = z.object({
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

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// =========================================================================
// PHASE 2: RECURSE (ported from mast-forecast-recursion.ts)
// =========================================================================

const RECURSE_BATCH_SIZE = 20;

const EvidenceGroupRow = z.object({
  verbatim: z.string(),
  doc_id: z.string(),
  locator: z.string(),
  citation_count: z.coerce.number(),
});

const DepthRow = z.object({
  assumption_id: z.string(),
  recursion_depth: z.coerce.number().nullable(),
});

const NewIdRow = z.object({ id: z.string() });

const RecurseMessageResponseSchema = z.object({
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

function buildRecursionPrompt(
  entries: Array<{ index: number; quote: string; fileName: string }>,
): string {
  const numberedList = entries
    .map((e) => `${e.index}. [${e.fileName}]: "${e.quote}"`)
    .join("\n\n");

  return `Below is a numbered list of quotes from deal documents. Each quote has been identified as a forward-looking projection or forecast.

For each quote, state the underlying proposition being projected, as a single sentence in the language an investment memo would use.

You MUST NOT:
- Introduce any number not present in the quote
- Change any value
- Add justification not present in the quote
- Speculate about who made the projection or why

If a quote is NOT actually a forward-looking projection (e.g. it is a historical observation or a statement of fact), return skip: true for that entry rather than inventing a proposition.

Return a JSON array only. No prose. No markdown fences. Each element has exactly three fields: "index" (integer matching the numbered entry), "sentence" (the restated proposition, or empty string if skipped), and "skip" (boolean, true if this quote is not actually a projection).

--- QUOTES ---
${numberedList}
--- END QUOTES ---`;
}

// =========================================================================
// STAGE HANDLER
// =========================================================================

const sweep: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── Seed counters from prior payload ──────────────────────────────
  let priorPayload: Record<string, any> = {};
  if (resumePosition > 0) {
    priorPayload = await readPriorPayload(db, runId);
  }

  let invocationCount = seedNum(priorPayload, "invocationCount") + 1;

  // Search counters
  let search_chunksProcessed = seedNum(priorPayload, "search_chunksProcessed");
  let search_totalHitsReturned = seedNum(priorPayload, "search_totalHitsReturned");
  let search_hitsPassedGate = seedNum(priorPayload, "search_hitsPassedGate");
  let search_rejectQuoteTooShort = seedNum(priorPayload, "search_rejectQuoteTooShort");
  let search_rejectPrefixNotFound = seedNum(priorPayload, "search_rejectPrefixNotFound");
  let search_rejectBadIndex = seedNum(priorPayload, "search_rejectBadIndex");
  let search_remappedChunkLabel = seedNum(priorPayload, "search_remappedChunkLabel");
  let search_callFailures = seedNum(priorPayload, "search_callFailures");
  let search_batchesParseFailed = seedNum(priorPayload, "search_batchesParseFailed");
  let search_insertFailures = seedNum(priorPayload, "search_insertFailures");
  let search_rejectBadRelation = seedNum(priorPayload, "search_rejectBadRelation");
  let search_truncations = seedNum(priorPayload, "search_truncations");
  let search_totalInputTokens = seedNum(priorPayload, "search_totalInputTokens");
  let search_totalOutputTokens = seedNum(priorPayload, "search_totalOutputTokens");
  let search_totalCacheCreationTokens = seedNum(priorPayload, "search_totalCacheCreationTokens");
  let search_totalCacheReadTokens = seedNum(priorPayload, "search_totalCacheReadTokens");
  const search_hitsByKind: Record<string, number> = {};
  if (priorPayload.search_hitsByKind && typeof priorPayload.search_hitsByKind === "object") {
    for (const [k, v] of Object.entries(priorPayload.search_hitsByKind)) {
      if (typeof v === "number") search_hitsByKind[k] = v;
    }
  }

  // Recurse counters
  let recurse_rowsWritten = seedNum(priorPayload, "recurse_rowsWritten");
  let recurse_skippedByModel = seedNum(priorPayload, "recurse_skippedByModel");
  let recurse_depthBlocked = seedNum(priorPayload, "recurse_depthBlocked");
  let recurse_batchFailures = seedNum(priorPayload, "recurse_batchFailures");
  let recurse_truncations = seedNum(priorPayload, "recurse_truncations");
  let recurse_totalInputTokens = seedNum(priorPayload, "recurse_totalInputTokens");
  let recurse_totalOutputTokens = seedNum(priorPayload, "recurse_totalOutputTokens");

  // ── Determine current phase ───────────────────────────────────────
  let phase: SweepPhase = "search";
  let phaseCursor = 0;

  if (resumePosition > 0 && priorPayload.phase && typeof priorPayload.phase === "string") {
    const storedPhase = priorPayload.phase as string;
    // Runs checkpointed at removed phases (links, inherit) resume at search
    if (storedPhase === "search" || storedPhase === "recurse" || storedPhase === "complete") {
      phase = storedPhase as SweepPhase;
      phaseCursor = typeof priorPayload.phaseCursor === "number" ? priorPayload.phaseCursor : 0;
    } else {
      console.log(`${LOG_PREFIX} Stored phase "${storedPhase}" is removed. Resuming at search.`);
      phase = "search";
      phaseCursor = 0;
    }
  }

  console.log(`${LOG_PREFIX} Invocation ${invocationCount}: phase=${phase}, phaseCursor=${phaseCursor}, resumePosition=${resumePosition}`);

  // Helper to build payload object
  const buildPayload = (): Record<string, unknown> => ({
    phase,
    phaseCursor,
    invocationCount,
    countersCumulative: true,
    // Search
    search_chunksProcessed,
    search_totalHitsReturned,
    search_hitsPassedGate,
    search_rejectQuoteTooShort,
    search_rejectPrefixNotFound,
    search_rejectBadIndex,
    search_remappedChunkLabel,
    search_callFailures,
    search_batchesParseFailed,
    search_insertFailures,
    search_rejectBadRelation,
    search_truncations,
    search_totalInputTokens,
    search_totalOutputTokens,
    search_totalCacheCreationTokens,
    search_totalCacheReadTokens,
    search_hitsByKind,
    // Recurse
    recurse_rowsWritten,
    recurse_skippedByModel,
    recurse_depthBlocked,
    recurse_batchFailures,
    recurse_truncations,
    recurse_totalInputTokens,
    recurse_totalOutputTokens,
  });

  let nextResumePosition = resumePosition > 0 ? resumePosition : 1;

  // ====================================================================
  // PHASE 1: SEARCH
  // ====================================================================
  if (phase === "search") {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      await persistPayload(db, runId, buildPayload());
      return { complete: false, itemsDone: 0, itemsTotal: 1, resumePosition: nextResumePosition };
    }

    console.log(`${LOG_PREFIX} Phase 1 (search): starting at cursor ${phaseCursor}`);

    // Load canonical assumptions
    const assumptions = await db.query(
      `SELECT ROW_NUMBER() OVER (ORDER BY id) AS row_num, id, proposition
       FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id
       ORDER BY id`,
      SearchAssumptionRow, [runId],
      { label: `${LOG_PREFIX} load canonical assumptions` },
    );

    if (assumptions.length === 0) {
      console.log(`${LOG_PREFIX} No canonical assumptions. Advancing to recurse.`);
      phase = "recurse"; phaseCursor = 0;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
    } else {
      // Build assumption ID index
      const assumptionIdByIndex = new Map<number, string>();
      for (const a of assumptions) {
        assumptionIdByIndex.set(a.row_num, a.id);
      }

      // Split into pass groups
      const passGroups: Array<Array<{ index: number; proposition: string }>> = [];
      let currentGroup: Array<{ index: number; proposition: string }> = [];
      let currentLen = 0;
      for (const a of assumptions) {
        const entry = { index: a.row_num, proposition: a.proposition };
        const entryLen = `${a.row_num}. ${a.proposition}\n`.length;
        if (currentLen + entryLen > MAX_ASSUMPTION_LIST_CHARS && currentGroup.length > 0) {
          passGroups.push(currentGroup);
          currentGroup = [];
          currentLen = 0;
        }
        currentGroup.push(entry);
        currentLen += entryLen;
      }
      if (currentGroup.length > 0) passGroups.push(currentGroup);

      // Load eligible chunks
      const allChunks = await db.query(
        `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content, dc.document_id, dc.file_name
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE d.deal_id = $1::uuid
           AND d.document_tag NOT IN ('financial_model', 'ic_memo')
         ORDER BY dc.file_name ASC, dc.chunk_index ASC`,
        SearchChunkRow, [dealId],
        { label: `${LOG_PREFIX} load eligible chunks` },
      );

      console.log(`${LOG_PREFIX} ${assumptions.length} assumptions, ${passGroups.length} pass group(s), ${allChunks.length} eligible chunks.`);

      // Idempotency
      if (phaseCursor === 0) {
        await db.execute(`DELETE FROM mast_support_evidence WHERE run_id = $1::uuid`, [runId], { label: `${LOG_PREFIX} idempotent delete evidence` });
      }

      // Compute total batches across all pass groups
      const batchesPerPass = Math.ceil(allChunks.length / CHUNKS_PER_CALL);
      const totalBatches = passGroups.length * batchesPerPass;

      for (let passIdx = 0; passIdx < passGroups.length; passIdx++) {
        const passAssumptions = passGroups[passIdx];
        const cachedPrefix = buildCachedPrefix(passAssumptions);

        for (let chunkStart = 0; chunkStart < allChunks.length; chunkStart += CHUNKS_PER_CALL) {
          const currentBatchInPass = Math.floor(chunkStart / CHUNKS_PER_CALL);
          const globalBatch = passIdx * batchesPerPass + currentBatchInPass;

          if (globalBatch < phaseCursor) continue;

          if (Date.now() - startTime > STAGE_BUDGET_MS) {
            console.log(`${LOG_PREFIX} Phase 1 budget exceeded at batch ${globalBatch}/${totalBatches}.`);
            phaseCursor = globalBatch;
            nextResumePosition++;
            // Compute distinctAssumptionsHit from DB
            let distinctHit: number | undefined;
            try {
              const [{ cnt }] = await db.query(
                `SELECT COUNT(DISTINCT assumption_id)::int AS cnt FROM mast_support_evidence WHERE run_id = $1::uuid`,
                CountRow, [runId], { label: `${LOG_PREFIX} count distinct assumptions with evidence` },
              );
              distinctHit = cnt;
            } catch { /* skip */ }
            const payload = buildPayload();
            if (distinctHit !== undefined) (payload as any).search_distinctAssumptionsHit = distinctHit;
            await persistPayload(db, runId, payload);
            return { complete: false, itemsDone: globalBatch, itemsTotal: totalBatches, resumePosition: nextResumePosition };
          }

          const chunkBatch = allChunks.slice(chunkStart, chunkStart + CHUNKS_PER_CALL);
          const labelledChunks = chunkBatch.map((c, i) => ({ label: i + 1, content: c.content }));
          const userPrompt = buildPassagesBlock(labelledChunks);

          // LLM call with retry
          let attempts = 0;
          let lastWasErr = false, lastWasParse = false, lastWasTrunc = false;

          while (attempts < MAX_ATTEMPTS) {
            if (attempts > 0 && !lastWasErr && !lastWasParse && !lastWasTrunc) break;
            attempts++; lastWasErr = false; lastWasParse = false; lastWasTrunc = false;

            try {
              const llmResp = await ai.apiRequest(
                { method: "POST", path: "/v1/messages", body: {
                  model, max_tokens: MAX_OUTPUT_TOKENS,
                  system: [
                    { type: "text", text: SEARCH_SYSTEM_PROMPT },
                    { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
                  ],
                  messages: [{ role: "user", content: userPrompt }],
                }},
                { response: SearchMessageResponseSchema },
                { label: `${LOG_PREFIX} search pass ${passIdx} batch ${globalBatch} attempt ${attempts}` },
              );

              search_totalInputTokens += llmResp.usage.input_tokens;
              search_totalOutputTokens += llmResp.usage.output_tokens;
              if (llmResp.usage.cache_creation_input_tokens) search_totalCacheCreationTokens += llmResp.usage.cache_creation_input_tokens;
              if (llmResp.usage.cache_read_input_tokens) search_totalCacheReadTokens += llmResp.usage.cache_read_input_tokens;

              if (llmResp.stop_reason === "max_tokens") { lastWasTrunc = true; search_truncations++; }

              let responseText = llmResp.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

              // Strip markdown fences
              const fenceMatch = responseText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
              if (fenceMatch) responseText = fenceMatch[1];

              // ── Parse LLM response ──
              let parsedHits: RawHit[] = [];
              try {
                const parsed = JSON.parse(responseText);
                if (!Array.isArray(parsed)) { lastWasParse = true; continue; }

                parsedHits = parsed.filter(
                  (el: any) => el && typeof el === "object" && typeof el.chunk === "number" && typeof el.index === "number" && typeof el.quote === "string" && typeof el.kind === "string",
                );
              } catch { lastWasParse = true; search_batchesParseFailed++; continue; }

              // ── Process hits through gate and INSERT ──
              try {
                for (const hit of parsedHits) {
                  search_totalHitsReturned++;

                  // Validate chunk label
                  let resolvedChunkLabel = hit.chunk;
                  if (resolvedChunkLabel < 1 || resolvedChunkLabel > chunkBatch.length) {
                    search_rejectBadIndex++;
                    continue;
                  }

                  // Validate assumption index
                  const assumptionId = assumptionIdByIndex.get(hit.index);
                  if (!assumptionId) { search_rejectBadIndex++; continue; }

                  // Quote word count gate
                  const quoteWords = hit.quote.trim().split(/\s+/);
                  if (quoteWords.length < MIN_QUOTE_WORDS) { search_rejectQuoteTooShort++; continue; }

                  // Prefix gate
                  const chunkContent = chunkBatch[resolvedChunkLabel - 1].content;
                  const normalizedChunk = normalize(chunkContent);
                  const normalizedQuote = normalize(hit.quote);

                  let passedGate: boolean;
                  if (normalizedQuote.length <= PREFIX_GATE_LEN) {
                    passedGate = normalizedChunk.includes(normalizedQuote);
                  } else {
                    const prefix = normalizedQuote.slice(0, PREFIX_GATE_LEN);
                    passedGate = normalizedChunk.includes(prefix);
                  }
                  if (!passedGate) { search_rejectPrefixNotFound++; continue; }

                  search_hitsPassedGate++;

                  // Track hitsByKind
                  const kind = hit.kind;
                  search_hitsByKind[kind] = (search_hitsByKind[kind] ?? 0) + 1;

                  // Enum check on relation
                  const VALID_RELATIONS = ["supports", "undermines", "constrains", "defines"];
                  const relation = typeof hit.relation === "string" && VALID_RELATIONS.includes(hit.relation)
                    ? hit.relation
                    : null;
                  if (relation === null && hit.relation !== undefined) {
                    search_rejectBadRelation++;
                  }

                  // Write evidence row
                  const sourceChunk = chunkBatch[resolvedChunkLabel - 1];
                  await db.execute(
                    `INSERT INTO mast_support_evidence (
                       run_id, assumption_id, doc_id, locator, verbatim,
                       statement_type, classifier_reason, spawned_assumption_id, relation
                     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL, NULL, $7)`,
                    [runId, assumptionId, sourceChunk.document_id,
                     `${sourceChunk.file_name}:chunk_${sourceChunk.chunk_index}`,
                     hit.quote, kind, relation],
                    { label: `${LOG_PREFIX} insert evidence` },
                  );
                }

                break; // success — parse + inserts all succeeded
              } catch (insertErr: unknown) {
                search_insertFailures++;
                const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
                const firstHit = parsedHits[0];
                console.error(`${LOG_PREFIX} INSERT failed (batch globalIdx=${globalBatch}): ${errMsg}`);
                console.error(`${LOG_PREFIX}   first hit values: chunk=${firstHit?.chunk}, index=${firstHit?.index}, kind=${firstHit?.kind}, relation=${firstHit?.relation}, quote=${firstHit?.quote?.slice(0, 80)}`);
                // Do NOT retry — a failing INSERT will fail identically on retry
                break;
              }
            } catch { lastWasErr = true; search_callFailures++; continue; }
          }

          // Increment chunk count once per batch regardless of parse outcome
          search_chunksProcessed += chunkBatch.length;
        }
      }

      // Compute distinctAssumptionsHit from DB
      let distinctHitFinal: number | undefined;
      try {
        const [{ cnt }] = await db.query(
          `SELECT COUNT(DISTINCT assumption_id)::int AS cnt FROM mast_support_evidence WHERE run_id = $1::uuid`,
          CountRow, [runId], { label: `${LOG_PREFIX} count distinct assumptions with evidence (final)` },
        );
        distinctHitFinal = cnt;
      } catch { /* skip */ }

      console.log(`${LOG_PREFIX} Phase 1 complete: ${search_hitsPassedGate} hits passed gate, ${search_chunksProcessed} chunks processed.`);
      phase = "recurse"; phaseCursor = 0;
      nextResumePosition++;
      const payload = buildPayload();
      if (distinctHitFinal !== undefined) (payload as any).search_distinctAssumptionsHit = distinctHitFinal;
      await persistPayload(db, runId, payload);
    }
  }

  // ====================================================================
  // PHASE 2: RECURSE
  // ====================================================================
  if (phase === "recurse") {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      await persistPayload(db, runId, buildPayload());
      return { complete: false, itemsDone: 0, itemsTotal: 1, resumePosition: nextResumePosition };
    }

    console.log(`${LOG_PREFIX} Phase 2 (recurse): starting at cursor ${phaseCursor}`);

    // Idempotency
    if (phaseCursor === 0) {
      await db.execute(`DELETE FROM mast_assumptions WHERE run_id = $1::uuid AND origin_type = 'forecast_recursed'`, [runId], { label: `${LOG_PREFIX} idempotency delete recursed` });
      await db.execute(`UPDATE mast_support_evidence SET spawned_assumption_id = NULL WHERE run_id = $1::uuid`, [runId], { label: `${LOG_PREFIX} idempotency clear spawned_assumption_id` });
    }

    const groups = await db.query(
      `SELECT verbatim, MIN(doc_id::text) AS doc_id, MIN(locator) AS locator, COUNT(DISTINCT assumption_id)::int AS citation_count
       FROM mast_support_evidence WHERE run_id = $1::uuid AND statement_type = 'forecast'
       GROUP BY verbatim ORDER BY COUNT(DISTINCT assumption_id) DESC, MIN(locator) ASC`,
      EvidenceGroupRow, [runId], { label: `${LOG_PREFIX} load forecast evidence groups` },
    );

    if (groups.length === 0) {
      console.log(`${LOG_PREFIX} No forecast evidence. Phase 2 complete.`);
      phase = "complete"; phaseCursor = 0;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
    } else {
      // Depth guard
      const depthLookup = await db.query(
        `SELECT DISTINCT se.assumption_id, a.recursion_depth
         FROM mast_support_evidence se JOIN mast_assumptions a ON a.id = se.assumption_id
         WHERE se.run_id = $1::uuid AND se.statement_type = 'forecast'`,
        DepthRow, [runId], { label: `${LOG_PREFIX} load parent recursion depths` },
      );
      const depthByAssumption = new Map<string, number>();
      for (const row of depthLookup) depthByAssumption.set(row.assumption_id, row.recursion_depth ?? 0);

      let groupIdx = phaseCursor;

      while (groupIdx < groups.length) {
        if (Date.now() - startTime > STAGE_BUDGET_MS) {
          console.log(`${LOG_PREFIX} Phase 2 budget exceeded at group ${groupIdx}/${groups.length}.`);
          phaseCursor = groupIdx;
          nextResumePosition++;
          await persistPayload(db, runId, buildPayload());
          return { complete: false, itemsDone: groupIdx, itemsTotal: groups.length, resumePosition: nextResumePosition };
        }

        const batchEnd = Math.min(groupIdx + RECURSE_BATCH_SIZE, groups.length);
        const batch = groups.slice(groupIdx, batchEnd);

        const eligibleEntries: Array<{ index: number; group: (typeof groups)[0] }> = [];
        for (let i = 0; i < batch.length; i++) {
          const group = batch[i];
          const citations = await db.query(
            `SELECT DISTINCT assumption_id FROM mast_support_evidence
             WHERE run_id = $1::uuid AND statement_type = 'forecast' AND verbatim = $2`,
            z.object({ assumption_id: z.string() }), [runId, group.verbatim],
            { label: `${LOG_PREFIX} citations for group ${groupIdx + i}` },
          );
          const allBlocked = citations.every((c) => (depthByAssumption.get(c.assumption_id) ?? 0) >= 1);
          if (allBlocked) { recurse_depthBlocked++; continue; }
          eligibleEntries.push({ index: i + 1, group });
        }

        if (eligibleEntries.length === 0) { groupIdx = batchEnd; continue; }

        const promptEntries = eligibleEntries.map((e) => ({
          index: e.index, quote: e.group.verbatim,
          fileName: e.group.locator.split(":")[0] || "unknown",
        }));
        const userPrompt = buildRecursionPrompt(promptEntries);

        let sentenceMap: Map<number, { sentence: string; skip: boolean }> | null = null;
        let attempts = 0;
        let lastWasErr = false, lastWasParse = false, lastWasTrunc = false;

        while (attempts < MAX_ATTEMPTS) {
          if (attempts > 0 && !lastWasErr && !lastWasParse && !lastWasTrunc) break;
          attempts++; lastWasErr = false; lastWasParse = false; lastWasTrunc = false;
          try {
            const llmResp = await ai.apiRequest(
              { method: "POST", path: "/v1/messages", body: { model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: userPrompt }] } },
              { response: RecurseMessageResponseSchema },
              { label: `${LOG_PREFIX} recurse batch ${groupIdx}-${batchEnd - 1} attempt ${attempts}` },
            );
            recurse_totalInputTokens += llmResp.usage.input_tokens;
            recurse_totalOutputTokens += llmResp.usage.output_tokens;
            if (llmResp.stop_reason === "max_tokens") { lastWasTrunc = true; recurse_truncations++; }
            const text = llmResp.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            try {
              const parsed = JSON.parse(text);
              if (!Array.isArray(parsed)) { lastWasParse = true; continue; }
              sentenceMap = new Map();
              for (const el of parsed) {
                if (el && typeof el === "object" && typeof el.index === "number" && typeof el.skip === "boolean") {
                  sentenceMap.set(el.index, { sentence: typeof el.sentence === "string" ? el.sentence.trim() : "", skip: el.skip });
                }
              }
              break;
            } catch { lastWasParse = true; continue; }
          } catch { lastWasErr = true; continue; }
        }

        if (sentenceMap === null) {
          recurse_batchFailures++;
        } else {
          for (const entry of eligibleEntries) {
            const result = sentenceMap.get(entry.index);
            if (!result || result.skip || result.sentence.length === 0) { recurse_skippedByModel++; continue; }
            const group = entry.group;
            const newRows = await db.query(
              `INSERT INTO mast_assumptions (run_id, deal_id, proposition, origin_type, origin_doc_id, origin_locator, verbatim, quantified, value, unit, period, detector, reliance_link_id, recursion_depth, dedup_group_id)
               VALUES ($1::uuid, $2::uuid, $3, 'forecast_recursed', $4::uuid, $5, $6, false, NULL, NULL, NULL, NULL, NULL, 1, gen_random_uuid()) RETURNING id`,
              NewIdRow, [runId, dealId, result.sentence, group.doc_id, group.locator, group.verbatim],
              { label: `${LOG_PREFIX} insert recursed assumption` },
            );
            if (newRows.length === 0) continue;
            const newId = newRows[0].id;
            await db.execute(`UPDATE mast_assumptions SET dedup_group_id = id WHERE id = $1::uuid`, [newId], { label: `${LOG_PREFIX} set dedup_group_id for recursed` });
            await db.execute(
              `UPDATE mast_support_evidence SET spawned_assumption_id = $3::uuid
               WHERE run_id = $1::uuid AND statement_type = 'forecast' AND verbatim = $2`,
              [runId, group.verbatim, newId], { label: `${LOG_PREFIX} link evidence to recursed` },
            );
            recurse_rowsWritten++;
          }
        }
        groupIdx = batchEnd;
      }

      console.log(`${LOG_PREFIX} Phase 2 complete: ${recurse_rowsWritten} written, ${recurse_skippedByModel} skipped.`);
      phase = "complete"; phaseCursor = 0;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
    }
  }

  // ====================================================================
  // ALL PHASES COMPLETE
  // ====================================================================
  console.log(`${LOG_PREFIX} Sweep stage complete after ${invocationCount} invocation(s).`);
  return { complete: true, itemsDone: 1, itemsTotal: 1, resumePosition: nextResumePosition };
};

export default sweep;
