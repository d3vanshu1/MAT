/**
 * mast-extract.ts
 *
 * MAST v2 — extract stage.
 *
 * Merges register_memo (phase 1: chunk extraction) and register_assemble
 * (phase 2: dedup) into a single stage. The register produced is identical
 * to running the two stages in sequence.
 *
 * Phase 1 (chunks): port of register_memo — reads IC memo chunks, extracts
 * forward-looking propositions behind a quote gate, one LLM call per chunk.
 * Resumable via cursor.
 *
 * Phase 2 (dedup): port of register_assemble — applies Rules A, B, D and
 * assigns dedup_group_id. Single-shot within one invocation.
 *
 * Resume encoding:
 *   resumePosition 0             → fresh start, phase 1 from chunk 0
 *   resumePosition 1..chunkCount → resume phase 1 at that chunk index
 *   resumePosition chunkCount+1  → phase 2 (dedup)
 *
 * Counters are cumulative across invocations using the seeding pattern
 * from mast-support-search.ts.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-EXTRACT]";

const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const PROPOSITIONS_PER_CHUNK_CAP = 15;
const STAGE_NAME = "extract";

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

const AssumptionRowSchema = z.object({
  id: z.string(),
  origin_type: z.string(),
  origin_locator: z.string().nullable(),
  proposition: z.string(),
  value: z.any().nullable(),
  period: z.string().nullable(),
});

type AssumptionRow = z.infer<typeof AssumptionRowSchema>;

const PayloadRow = z.object({ payload: z.any().nullable() });
const CountSchema = z.object({ cnt: z.coerce.number() });

// ---------------------------------------------------------------------------
// Normalization (shared by quote gate and Rule D)
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Prompt (verbatim from register_memo)
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
// Locator parser (verbatim from register_assemble)
// ---------------------------------------------------------------------------

function parseLocator(
  locator: string | null,
): { sheet: string; row: number; raw: string } | null {
  if (!locator) return null;
  const bangIdx = locator.lastIndexOf("!");
  if (bangIdx < 0) return null;
  const sheet = locator.slice(0, bangIdx);
  const cellRef = locator.slice(bangIdx + 1);
  const m = cellRef.match(/(\d+)$/);
  if (!m) return null;
  return { sheet, row: parseInt(m[1], 10), raw: locator };
}

// ---------------------------------------------------------------------------
// Payload seeding (pattern from mast-support-search.ts)
// ---------------------------------------------------------------------------

async function readPriorPayload(
  db: StageContext["db"],
  runId: string,
): Promise<Record<string, any>> {
  try {
    const rows = await db.query(
      `SELECT payload FROM mast_pipeline_state
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'
       LIMIT 1`,
      PayloadRow,
      [runId, STAGE_NAME],
      { label: `${LOG_PREFIX} read prior payload for counter seeding` },
    );
    if (rows.length > 0 && rows[0].payload && typeof rows[0].payload === "object") {
      return rows[0].payload as Record<string, any>;
    }
  } catch (seedErr) {
    console.log(`${LOG_PREFIX} Failed to read prior payload for seeding: ${String(seedErr)}`);
  }
  return {};
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
      [runId, STAGE_NAME, JSON.stringify(payload)],
      { label: `${LOG_PREFIX} persist stage summary` },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const extract: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 0. Seed counters from prior payload ────────────────────────────
  const priorPayload = resumePosition > 0
    ? await readPriorPayload(db, runId)
    : {};

  const seedNum = (key: string): number =>
    typeof priorPayload[key] === "number" ? priorPayload[key] : 0;

  let totalAccepted = seedNum("totalAccepted");
  let totalInputTokens = seedNum("totalInputTokens");
  let totalOutputTokens = seedNum("totalOutputTokens");
  let rejectEmptyProposition = seedNum("rejectEmptyProposition");
  let rejectShortProposition = seedNum("rejectShortProposition");
  let rejectEmptyQuote = seedNum("rejectEmptyQuote");
  let rejectShortQuote = seedNum("rejectShortQuote");
  let rejectQuoteNotFound = seedNum("rejectQuoteNotFound");
  let chunksAllCallsFailed = seedNum("chunksAllCallsFailed");
  let chunksAllParsesFailed = seedNum("chunksAllParsesFailed");
  let chunksTruncated = seedNum("chunksTruncated");
  let invocationCount = seedNum("invocationCount") + 1;

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: CHUNK EXTRACTION (ported verbatim from register_memo)
  // ══════════════════════════════════════════════════════════════════

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
    { label: `${LOG_PREFIX} load IC memo chunks` },
  );

  const totalChunks = allChunks.length;

  if (totalChunks === 0) {
    console.log(`${LOG_PREFIX} No IC memo chunks found for deal ${dealId}. Stage complete with 0 propositions.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // Determine phase from resumePosition
  const DEDUP_RESUME_POS = totalChunks + 1;
  const chunksComplete = resumePosition > totalChunks;
  let chunkIdx = chunksComplete ? totalChunks : resumePosition;

  console.log(
    `${LOG_PREFIX} ${totalChunks} memo chunks loaded. resumePosition=${resumePosition}, ` +
    `phase=${chunksComplete ? "dedup" : "chunks"}, chunkIdx=${chunkIdx}.`,
  );

  // ── 2. Process chunks with resume support ──────────────────────────
  let acceptedThisInvocation = 0;

  if (!chunksComplete) {
    while (chunkIdx < totalChunks) {
      // Budget check
      if (Date.now() - startTime > STAGE_BUDGET_MS) {
        console.log(
          `${LOG_PREFIX} Budget exceeded after ${chunkIdx - resumePosition} chunks. Pausing at chunk ${chunkIdx}/${totalChunks}.`,
        );

        await persistPayload(db, runId, {
          phase: "chunks",
          chunkIndex: chunkIdx,
          totalAccepted,
          totalInputTokens,
          totalOutputTokens,
          rejectEmptyProposition,
          rejectShortProposition,
          rejectEmptyQuote,
          rejectShortQuote,
          rejectQuoteNotFound,
          chunksAllCallsFailed,
          chunksAllParsesFailed,
          chunksTruncated,
          invocationCount,
          countersCumulative: true,
        });

        return {
          complete: false,
          itemsDone: chunkIdx,
          itemsTotal: totalChunks,
          resumePosition: chunkIdx,
        };
      }

      const chunk = allChunks[chunkIdx];
      const locator = `${chunk.file_name} chunk ${chunk.chunk_index}`;

      // ── 2b. LLM call ──────────────────────────────────────────────
      const userPrompt = buildUserPrompt(chunk.content);
      let propositions: Array<{ proposition: string; quote: string }> = [];
      let attempts = 0;
      const MAX_ATTEMPTS = 2;
      let lastAttemptWasError = false;
      let lastAttemptWasParseFailure = false;
      let lastAttemptWasTruncated = false;
      let chunkCallErrors = 0;
      let chunkParseErrors = 0;
      let chunkWasTruncated = false;
      let chunkParsedSuccessfully = false;

      while (attempts < MAX_ATTEMPTS) {
        if (attempts > 0 && !lastAttemptWasError && !lastAttemptWasParseFailure && !lastAttemptWasTruncated) {
          break;
        }
        attempts++;
        lastAttemptWasError = false;
        lastAttemptWasParseFailure = false;
        lastAttemptWasTruncated = false;

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
            { label: `${LOG_PREFIX} extract chunk ${chunkIdx} attempt ${attempts}` },
          );

          totalInputTokens += llmResponse.usage.input_tokens;
          totalOutputTokens += llmResponse.usage.output_tokens;

          if (llmResponse.stop_reason === "max_tokens") {
            console.log(
              `${LOG_PREFIX} Chunk ${chunkIdx}: TRUNCATED (stop_reason=max_tokens, attempt ${attempts}).`,
            );
            lastAttemptWasTruncated = true;
            chunkWasTruncated = true;
          }

          const responseText = llmResponse.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");

          try {
            const parsed = JSON.parse(responseText);
            if (!Array.isArray(parsed)) {
              console.log(
                `${LOG_PREFIX} Chunk ${chunkIdx}: response is not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
              );
              lastAttemptWasParseFailure = true;
              chunkParseErrors++;
              continue;
            }
            propositions = parsed.filter(
              (el: any) =>
                el &&
                typeof el === "object" &&
                typeof el.proposition === "string" &&
                typeof el.quote === "string",
            );
            chunkParsedSuccessfully = true;
            break;
          } catch (_parseErr) {
            console.log(
              `${LOG_PREFIX} Chunk ${chunkIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastAttemptWasParseFailure = true;
            chunkParseErrors++;
            continue;
          }
        } catch (llmErr) {
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
          );
          lastAttemptWasError = true;
          chunkCallErrors++;
          continue;
        }
      }

      if (chunkCallErrors >= attempts) {
        chunksAllCallsFailed++;
      } else if (chunkParseErrors >= attempts) {
        chunksAllParsesFailed++;
      }

      if (chunkWasTruncated) {
        chunksTruncated++;
      }

      if (propositions.length > PROPOSITIONS_PER_CHUNK_CAP) {
        console.log(
          `${LOG_PREFIX} Chunk ${chunkIdx}: ${propositions.length} propositions returned — capping at ${PROPOSITIONS_PER_CHUNK_CAP}.`,
        );
        propositions = propositions.slice(0, PROPOSITIONS_PER_CHUNK_CAP);
      }

      // ── 2c. Quote gate — enforce in code ───────────────────────────
      const normalizedChunkContent = normalize(chunk.content);
      const acceptedProps: Array<{ proposition: string; quote: string }> = [];

      for (const prop of propositions) {
        if (!prop.proposition || prop.proposition.trim().length === 0) {
          rejectEmptyProposition++;
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT empty proposition. Quote (120): ${(prop.quote ?? "").slice(0, 120)}`,
          );
          continue;
        }

        const propWords = prop.proposition.trim().split(/\s+/);
        if (propWords.length < 4) {
          rejectShortProposition++;
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT proposition <4 words: "${prop.proposition}". Quote (120): ${prop.quote.slice(0, 120)}`,
          );
          continue;
        }

        if (!prop.quote || prop.quote.trim().length === 0) {
          rejectEmptyQuote++;
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT empty quote. Proposition: "${prop.proposition}"`,
          );
          continue;
        }

        const quoteWords = prop.quote.trim().split(/\s+/);
        if (quoteWords.length < 6) {
          rejectShortQuote++;
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT quote <6 words. Quote (120): ${prop.quote.slice(0, 120)}`,
          );
          continue;
        }

        const normalizedQuote = normalize(prop.quote);
        if (!normalizedChunkContent.includes(normalizedQuote)) {
          rejectQuoteNotFound++;
          console.log(
            `${LOG_PREFIX} Chunk ${chunkIdx}: REJECT quote not found in chunk. Quote (120): ${prop.quote.slice(0, 120)}`,
          );
          continue;
        }

        acceptedProps.push(prop);
      }

      // D1: idempotency delete runs only after successful parse, before inserts
      if (chunkParsedSuccessfully) {
        await db.execute(
          `DELETE FROM mast_assumptions
           WHERE run_id = $1::uuid
             AND origin_type = 'memo_prose'
             AND origin_locator = $2`,
          [runId, locator],
          { label: `${LOG_PREFIX} clear existing rows for ${locator}` },
        );

        for (const prop of acceptedProps) {
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
            { label: `${LOG_PREFIX} insert proposition from ${locator}` },
          );
        }
      }

      totalAccepted += acceptedProps.length;
      acceptedThisInvocation += acceptedProps.length;
      console.log(
        `${LOG_PREFIX} Chunk ${chunkIdx} (${locator}): ${acceptedProps.length} accepted of ${propositions.length} returned.`,
      );

      chunkIdx++;
    }

    // Budget check before entering dedup
    if (chunkIdx < totalChunks) {
      // Already returned above in the budget check; this is unreachable
      // but kept for safety.
      return {
        complete: false,
        itemsDone: chunkIdx,
        itemsTotal: totalChunks,
        resumePosition: chunkIdx,
      };
    }

    // ── Chunk completion checks ─────────────────────────────────────
    // D2: if >25% of chunks failed (call errors + parse errors), throw
    const failedChunks = chunksAllCallsFailed + chunksAllParsesFailed;
    if (failedChunks > totalChunks / 4) {
      throw new Error(
        `${LOG_PREFIX} ${failedChunks} of ${totalChunks} chunks failed to process ` +
        `(call_errors=${chunksAllCallsFailed}, parse_errors=${chunksAllParsesFailed}). ` +
        `Exceeds 25% threshold — run is not complete.`,
      );
    }

    // Fail closed if zero accepted CUMULATIVELY
    if (totalAccepted === 0) {
      const [{ cnt: dbTotal }] = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_assumptions
         WHERE run_id = $1::uuid AND origin_type = 'memo_prose'`,
        CountSchema,
        [runId],
        { label: `${LOG_PREFIX} check cumulative proposition count` },
      );

      if (dbTotal === 0) {
        throw new Error(
          `${LOG_PREFIX} All ${totalChunks} memo chunks processed but zero propositions accepted (cumulative). ` +
          `Extraction is broken. Rejections: empty_proposition=${rejectEmptyProposition}, ` +
          `short_proposition=${rejectShortProposition}, empty_quote=${rejectEmptyQuote}, ` +
          `short_quote=${rejectShortQuote}, quote_not_found=${rejectQuoteNotFound}.`,
        );
      }

      console.log(
        `${LOG_PREFIX} This invocation accepted 0 propositions, but ${dbTotal} exist from prior invocations. Proceeding.`,
      );
    }

    console.log(
      `${LOG_PREFIX} Phase 1 complete: ${totalAccepted} propositions across ${totalChunks} chunks.`,
    );

    // Check budget before starting dedup
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(`${LOG_PREFIX} Budget exceeded after chunk completion. Deferring dedup to next invocation.`);
      await persistPayload(db, runId, {
        phase: "dedup",
        chunkIndex: totalChunks,
        totalAccepted,
        totalInputTokens,
        totalOutputTokens,
        rejectEmptyProposition,
        rejectShortProposition,
        rejectEmptyQuote,
        rejectShortQuote,
        rejectQuoteNotFound,
        chunksAllCallsFailed,
        chunksAllParsesFailed,
        chunksTruncated,
        invocationCount,
        countersCumulative: true,
      });

      return {
        complete: false,
        itemsDone: totalChunks,
        itemsTotal: totalChunks,
        resumePosition: DEDUP_RESUME_POS,
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: DEDUP (ported verbatim from register_assemble)
  // ══════════════════════════════════════════════════════════════════

  console.log(`${LOG_PREFIX} Entering phase 2: dedup.`);

  // ── 1. Reset all dedup_group_ids for this run (idempotent) ──────────
  await db.execute(
    `UPDATE mast_assumptions SET dedup_group_id = NULL WHERE run_id = $1`,
    [runId],
    { label: `${LOG_PREFIX} reset dedup_group_ids` },
  );

  // ── 2. Read all rows in batches of 5000, ordered by id ─────────────
  const allRows: AssumptionRow[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  const BATCH_SIZE = 5000;

  while (true) {
    const batch = await db.query(
      `SELECT id, origin_type, origin_locator, proposition, value, period
         FROM mast_assumptions
        WHERE run_id = $1 AND id > $2
        ORDER BY id
        LIMIT $3`,
      AssumptionRowSchema,
      [runId, lastId, BATCH_SIZE],
      { label: `${LOG_PREFIX} fetch batch after ${lastId.slice(0, 8)}` },
    );
    if (batch.length === 0) break;
    allRows.push(...batch);
    lastId = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
  }

  console.log(`${LOG_PREFIX} Dedup: ${allRows.length} total rows loaded.`);

  // ── 3. Partition by origin_type ────────────────────────────────────
  const modelExplicit: AssumptionRow[] = [];
  const modelImplicit: AssumptionRow[] = [];
  const memoProse: AssumptionRow[] = [];

  for (const row of allRows) {
    switch (row.origin_type) {
      case "model_explicit":
        modelExplicit.push(row);
        break;
      case "model_implicit":
        modelImplicit.push(row);
        break;
      case "memo_prose":
        memoProse.push(row);
        break;
    }
  }

  console.log(
    `${LOG_PREFIX} model_explicit=${modelExplicit.length}  model_implicit=${modelImplicit.length}  memo_prose=${memoProse.length}`,
  );

  // ── Fail closed: memo_prose is required; model types may be absent ──
  if (memoProse.length === 0) {
    throw new Error(
      `${LOG_PREFIX} Fail-closed: memo_prose has zero rows. ` +
        `Cannot assemble dedup groups without memo-derived assumptions.`,
    );
  }
  if (modelExplicit.length === 0) {
    console.log(`${LOG_PREFIX} model_explicit has zero rows (model side removed — expected).`);
  }
  if (modelImplicit.length === 0) {
    console.log(`${LOG_PREFIX} model_implicit has zero rows (model side removed — expected).`);
  }

  // ── Map: rowId → assigned groupId ──────────────────────────────────
  const groupAssignment = new Map<string, string>();

  // ── 4. Rule A — model_explicit clustering ──────────────────────────
  const ruleAClusters = new Map<
    string,
    { rows: AssumptionRow[]; locators: string[] }
  >();

  for (const row of modelExplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    const valStr = row.value != null ? String(row.value) : "null";
    const key = `${parsed.sheet}|${valStr}`;
    let cluster = ruleAClusters.get(key);
    if (!cluster) {
      cluster = { rows: [], locators: [] };
      ruleAClusters.set(key, cluster);
    }
    cluster.rows.push(row);
    cluster.locators.push(row.origin_locator!);
  }

  let ruleAGroupCount = 0;
  const ruleAGroupForRow = new Map<string, string>();
  const ruleAGroupMembers = new Map<string, string[]>();

  for (const [, cluster] of ruleAClusters) {
    if (cluster.rows.length < 3) continue;
    ruleAGroupCount++;
    cluster.locators.sort();
    const canonicalId = cluster.rows.find(
      (r) => r.origin_locator === cluster.locators[0],
    )!.id;

    const memberIds: string[] = [];
    for (const row of cluster.rows) {
      groupAssignment.set(row.id, canonicalId);
      ruleAGroupForRow.set(row.id, canonicalId);
      memberIds.push(row.id);
    }
    ruleAGroupMembers.set(canonicalId, memberIds);
  }

  console.log(`${LOG_PREFIX} Rule A: ${ruleAGroupCount} groups from model_explicit`);

  // ── 5. Rule B — model_implicit + model_explicit by sheet+row ───────
  const ruleBClusters = new Map<
    string,
    { implicitRows: AssumptionRow[]; explicitRows: AssumptionRow[] }
  >();

  for (const row of modelImplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    const key = `${parsed.sheet}|${parsed.row}`;
    let cluster = ruleBClusters.get(key);
    if (!cluster) {
      cluster = { implicitRows: [], explicitRows: [] };
      ruleBClusters.set(key, cluster);
    }
    cluster.implicitRows.push(row);
  }

  for (const row of modelExplicit) {
    const parsed = parseLocator(row.origin_locator);
    if (!parsed) continue;
    const key = `${parsed.sheet}|${parsed.row}`;
    let cluster = ruleBClusters.get(key);
    if (!cluster) {
      cluster = { implicitRows: [], explicitRows: [] };
      ruleBClusters.set(key, cluster);
    }
    cluster.explicitRows.push(row);
  }

  let ruleBGroupCount = 0;

  for (const [, cluster] of ruleBClusters) {
    if (cluster.implicitRows.length === 0) continue;
    const totalRows =
      cluster.implicitRows.length + cluster.explicitRows.length;
    if (totalRows < 2) continue;

    ruleBGroupCount++;

    const implicitLocators = cluster.implicitRows
      .map((r) => r.origin_locator ?? "")
      .sort();
    const canonicalId = cluster.implicitRows.find(
      (r) => (r.origin_locator ?? "") === implicitLocators[0],
    )!.id;

    for (const row of cluster.implicitRows) {
      groupAssignment.set(row.id, canonicalId);
    }

    for (const row of cluster.explicitRows) {
      groupAssignment.set(row.id, canonicalId);

      const ruleAGroupId = ruleAGroupForRow.get(row.id);
      if (ruleAGroupId) {
        const clusterMembers = ruleAGroupMembers.get(ruleAGroupId);
        if (clusterMembers) {
          for (const memberId of clusterMembers) {
            groupAssignment.set(memberId, canonicalId);
          }
        }
      }
    }
  }

  console.log(`${LOG_PREFIX} Rule B: ${ruleBGroupCount} groups from model_implicit + model_explicit`);

  // ── 6. Rule D — memo_prose clustering by normalized proposition ────
  const ruleDClusters = new Map<
    string,
    { rows: AssumptionRow[]; locators: string[] }
  >();

  for (const row of memoProse) {
    const key = normalize(row.proposition);
    if (key.length === 0) continue;
    let cluster = ruleDClusters.get(key);
    if (!cluster) {
      cluster = { rows: [], locators: [] };
      ruleDClusters.set(key, cluster);
    }
    cluster.rows.push(row);
    cluster.locators.push(row.origin_locator ?? "");
  }

  let ruleDGroupCount = 0;

  for (const [, cluster] of ruleDClusters) {
    if (cluster.rows.length < 2) {
      if (cluster.rows.length === 1) {
        groupAssignment.set(cluster.rows[0].id, cluster.rows[0].id);
      }
      continue;
    }
    ruleDGroupCount++;
    cluster.locators.sort();
    const canonicalId = cluster.rows.find(
      (r) => (r.origin_locator ?? "") === cluster.locators[0],
    )!.id;
    for (const row of cluster.rows) {
      groupAssignment.set(row.id, canonicalId);
    }
  }

  // Assign singletons that weren't grouped (self-reference)
  for (const row of allRows) {
    if (!groupAssignment.has(row.id)) {
      groupAssignment.set(row.id, row.id);
    }
  }

  console.log(`${LOG_PREFIX} Rule D: ${ruleDGroupCount} groups from memo_prose`);

  // ── 7. Write back dedup_group_id in batches ───────────────────────
  const entries = Array.from(groupAssignment.entries());
  const WRITE_BATCH = 500;
  let writtenCount = 0;

  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    const batch = entries.slice(i, i + WRITE_BATCH);

    const valuesClauses: string[] = [];
    const params: unknown[] = [];
    for (let j = 0; j < batch.length; j++) {
      const [rowId, groupId] = batch[j];
      const pIdx = j * 2;
      valuesClauses.push(`($${pIdx + 1}::uuid, $${pIdx + 2}::uuid)`);
      params.push(rowId, groupId);
    }

    await db.execute(
      `UPDATE mast_assumptions AS a
          SET dedup_group_id = v.group_id
         FROM (VALUES ${valuesClauses.join(", ")}) AS v(row_id, group_id)
        WHERE a.id = v.row_id`,
      params,
      {
        label: `${LOG_PREFIX} write dedup_group_id batch ${Math.floor(i / WRITE_BATCH) + 1}`,
      },
    );
    writtenCount += batch.length;
  }

  // ── 8. Summary ─────────────────────────────────────────────────────
  const canonicalCount = new Set(groupAssignment.values()).size;
  let largestGroupSize = 0;
  let largestGroupCanonical = "";
  const groupSizes = new Map<string, number>();
  for (const [, gid] of groupAssignment) {
    groupSizes.set(gid, (groupSizes.get(gid) ?? 0) + 1);
  }
  for (const [gid, size] of groupSizes) {
    if (size > largestGroupSize) {
      largestGroupSize = size;
      largestGroupCanonical = gid;
    }
  }

  let largestLocator = "unknown";
  if (largestGroupCanonical) {
    const found = allRows.find((r) => r.id === largestGroupCanonical);
    if (found) largestLocator = found.origin_locator ?? "null";
  }

  console.log(
    `${LOG_PREFIX} Dedup summary: ${allRows.length} total rows, ` +
      `${canonicalCount} canonical groups, ` +
      `${writtenCount} dedup_group_ids written. ` +
      `Rule A=${ruleAGroupCount} Rule B=${ruleBGroupCount} Rule D=${ruleDGroupCount}. ` +
      `Largest group: ${largestGroupSize} rows (canonical: ${largestLocator}).`,
  );

  // ── 9. Persist merged payload ──────────────────────────────────────
  await persistPayload(db, runId, {
    phase: "complete",
    chunkIndex: totalChunks,
    totalAccepted,
    totalInputTokens,
    totalOutputTokens,
    rejectEmptyProposition,
    rejectShortProposition,
    rejectEmptyQuote,
    rejectShortQuote,
    rejectQuoteNotFound,
    chunksAllCallsFailed,
    chunksAllParsesFailed,
    chunksTruncated,
    invocationCount,
    countersCumulative: true,
    // Dedup counters
    rowCountByOriginType: {
      model_explicit: modelExplicit.length,
      model_implicit: modelImplicit.length,
      memo_prose: memoProse.length,
    },
    ruleAGroups: ruleAGroupCount,
    ruleBGroups: ruleBGroupCount,
    ruleDGroups: ruleDGroupCount,
    totalRows: allRows.length,
    canonicalGroups: canonicalCount,
  });

  console.log(`${LOG_PREFIX} Extract stage complete. Elapsed: ${Date.now() - startTime}ms.`);

  return {
    complete: true,
    itemsDone: totalChunks,
    itemsTotal: totalChunks,
    resumePosition: DEDUP_RESUME_POS,
  };
};

export default extract;
