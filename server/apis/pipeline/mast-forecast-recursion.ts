/**
 * mast-forecast-recursion.ts
 *
 * Stage handler for forecast_recursion.
 *
 * When support_search classifies evidence as "forecast", that evidence
 * is another bet, not a measurement. This stage turns each unique
 * forecast quote into a register row of its own (origin_type =
 * forecast_recursed) so it can be reported honestly: an assumption
 * that rests on a projection which itself has no located support.
 *
 * Depth guard: one level only. A projection supporting a projection
 * stops here. recursion_depth >= 1 on the parent assumption blocks
 * further recursion.
 *
 * Writes to mast_assumptions and mast_support_evidence.spawned_assumption_id.
 * Changes no other table or column. No new tables or columns.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-FRECUR]";

const MODULE_ID = "mast_v2";
const BATCH_SIZE = 20;
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
// DB row schemas
// ---------------------------------------------------------------------------

const EvidenceGroupRow = z.object({
  verbatim: z.string(),
  doc_id: z.string(),
  locator: z.string(),
  citation_count: z.coerce.number(),
});

const EvidenceIdRow = z.object({
  id: z.string(),
  assumption_id: z.string(),
});

const DepthRow = z.object({
  assumption_id: z.string(),
  recursion_depth: z.coerce.number().nullable(),
});

const NewIdRow = z.object({
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const forecastRecursion: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 1. Idempotency ────────────────────────────────────────────────
  if (resumePosition === 0) {
    await db.execute(
      `DELETE FROM mast_assumptions
       WHERE run_id = $1::uuid AND origin_type = 'forecast_recursed'`,
      [runId],
      { label: "MAST-FRECUR: idempotency delete recursed assumptions" },
    );
    await db.execute(
      `UPDATE mast_support_evidence
       SET spawned_assumption_id = NULL
       WHERE run_id = $1::uuid`,
      [runId],
      { label: "MAST-FRECUR: idempotency clear spawned_assumption_id" },
    );
    console.log(`${LOG_PREFIX} Idempotency: cleared forecast_recursed rows and spawned_assumption_id.`);
  }

  // ── 2. Load forecast evidence groups ──────────────────────────────
  //    Group by verbatim so identical projections cited against
  //    multiple assumptions are processed once.
  const groups = await db.query(
    `SELECT verbatim, MIN(doc_id) AS doc_id, MIN(locator) AS locator,
            COUNT(DISTINCT assumption_id)::int AS citation_count
     FROM mast_support_evidence
     WHERE run_id = $1::uuid AND statement_type = 'forecast'
     GROUP BY verbatim
     ORDER BY COUNT(DISTINCT assumption_id) DESC, MIN(locator) ASC`,
    EvidenceGroupRow,
    [runId],
    { label: "MAST-FRECUR: load forecast evidence groups" },
  );

  if (groups.length === 0) {
    console.log(`${LOG_PREFIX} No forecast evidence rows found. Returning complete with zero written.`);

    await persistPayload(db, runId, {
      groupsProcessed: 0,
      rowsWritten: 0,
      skippedByModel: 0,
      depthBlocked: 0,
      batchFailures: 0,
      truncations: 0,
    });

    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 3. Depth guard — preload recursion_depth for parent assumptions ──
  //    For each evidence group, check if ANY citing assumption has
  //    recursion_depth >= 1. If ALL citations are depth-blocked, skip.
  const depthLookup = await db.query(
    `SELECT DISTINCT se.assumption_id, a.recursion_depth
     FROM mast_support_evidence se
     JOIN mast_assumptions a ON a.id = se.assumption_id
     WHERE se.run_id = $1::uuid AND se.statement_type = 'forecast'`,
    DepthRow,
    [runId],
    { label: "MAST-FRECUR: load parent recursion depths" },
  );

  const depthByAssumption = new Map<string, number>();
  for (const row of depthLookup) {
    depthByAssumption.set(row.assumption_id, row.recursion_depth ?? 0);
  }

  console.log(
    `${LOG_PREFIX} ${groups.length} forecast evidence groups. Resume position: ${resumePosition}.`,
  );

  // ── 4. Process in batches ─────────────────────────────────────────
  let groupIdx = resumePosition;
  let rowsWritten = 0;
  let skippedByModel = 0;
  let depthBlocked = 0;
  let batchFailures = 0;
  let truncations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (groupIdx < groups.length) {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded at group ${groupIdx}/${groups.length}. Pausing.`,
      );
      break;
    }

    const batchEnd = Math.min(groupIdx + BATCH_SIZE, groups.length);
    const batch = groups.slice(groupIdx, batchEnd);

    // ── Pre-filter: depth guard per group ───────────────────────────
    //    For each group, load its citing assumption IDs and check depth.
    //    A group is blocked only if ALL of its citations are depth >= 1.
    const eligibleEntries: Array<{
      index: number;
      group: (typeof groups)[0];
    }> = [];

    for (let i = 0; i < batch.length; i++) {
      const group = batch[i];

      // Load all assumption_ids citing this verbatim
      const citations = await db.query(
        `SELECT DISTINCT assumption_id
         FROM mast_support_evidence
         WHERE run_id = $1::uuid AND statement_type = 'forecast' AND verbatim = $2`,
        z.object({ assumption_id: z.string() }),
        [runId, group.verbatim],
        { label: `MAST-FRECUR: citations for group ${groupIdx + i}` },
      );

      const allBlocked = citations.every((c) => {
        const depth = depthByAssumption.get(c.assumption_id) ?? 0;
        return depth >= 1;
      });

      if (allBlocked) {
        depthBlocked++;
        continue;
      }

      eligibleEntries.push({ index: i + 1, group });
    }

    if (eligibleEntries.length === 0) {
      groupIdx = batchEnd;
      continue;
    }

    // ── Build prompt entries ─────────────────────────────────────────
    const promptEntries = eligibleEntries.map((e) => ({
      index: e.index,
      quote: e.group.verbatim,
      fileName: e.group.locator.split(":")[0] || "unknown",
    }));

    const userPrompt = buildRecursionPrompt(promptEntries);

    // ── LLM call with retry ─────────────────────────────────────────
    let sentenceMap: Map<number, { sentence: string; skip: boolean }> | null = null;
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
          { label: `MAST-FRECUR: batch ${groupIdx}–${batchEnd - 1} attempt ${attempts}` },
        );

        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;

        if (llmResponse.stop_reason === "max_tokens") {
          console.log(
            `${LOG_PREFIX} Batch ${groupIdx}: TRUNCATED (attempt ${attempts}).`,
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
              `${LOG_PREFIX} Batch ${groupIdx}: not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastWasParseFailure = true;
            continue;
          }
          sentenceMap = new Map();
          for (const el of parsed) {
            if (
              el &&
              typeof el === "object" &&
              typeof el.index === "number" &&
              typeof el.skip === "boolean"
            ) {
              sentenceMap.set(el.index, {
                sentence: typeof el.sentence === "string" ? el.sentence.trim() : "",
                skip: el.skip,
              });
            }
          }
          break;
        } catch (_parseErr) {
          console.log(
            `${LOG_PREFIX} Batch ${groupIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
          );
          lastWasParseFailure = true;
          continue;
        }
      } catch (llmErr) {
        console.log(
          `${LOG_PREFIX} Batch ${groupIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
        );
        lastWasError = true;
        continue;
      }
    }

    // ── Apply results ───────────────────────────────────────────────
    if (sentenceMap === null) {
      batchFailures++;
      console.log(
        `${LOG_PREFIX} Batch ${groupIdx}: all attempts failed. ${eligibleEntries.length} groups unchanged.`,
      );
    } else {
      for (const entry of eligibleEntries) {
        const result = sentenceMap.get(entry.index);
        if (!result || result.skip || result.sentence.length === 0) {
          skippedByModel++;
          continue;
        }

        const group = entry.group;

        // Insert new assumption row
        const newRows = await db.query(
          `INSERT INTO mast_assumptions (
             run_id, deal_id, proposition, origin_type, origin_doc_id,
             origin_locator, verbatim, quantified, value, unit, period,
             detector, reliance_link_id, recursion_depth, dedup_group_id
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'forecast_recursed', $4::uuid,
             $5, $6, false, NULL, NULL, NULL,
             NULL, NULL, 1, gen_random_uuid()
           )
           RETURNING id`,
          NewIdRow,
          [runId, dealId, result.sentence, group.doc_id, group.locator, group.verbatim],
          { label: `MAST-FRECUR: insert recursed assumption for group ${entry.index}` },
        );

        if (newRows.length === 0) continue;
        const newId = newRows[0].id;

        // Set dedup_group_id = id (self-referencing canonical)
        await db.execute(
          `UPDATE mast_assumptions SET dedup_group_id = id WHERE id = $1::uuid`,
          [newId],
          { label: `MAST-FRECUR: set dedup_group_id = id for ${newId}` },
        );

        // Update all evidence rows in this group with spawned_assumption_id
        await db.execute(
          `UPDATE mast_support_evidence
           SET spawned_assumption_id = $3::uuid
           WHERE run_id = $1::uuid AND statement_type = 'forecast' AND verbatim = $2`,
          [runId, group.verbatim, newId],
          { label: `MAST-FRECUR: link evidence to recursed assumption ${newId}` },
        );

        rowsWritten++;
      }
    }

    groupIdx = batchEnd;
  }

  // ── 5. Log and persist payload ────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Processed groups ${resumePosition}–${groupIdx - 1} of ${groups.length}. ` +
    `Written: ${rowsWritten}, skippedByModel: ${skippedByModel}, depthBlocked: ${depthBlocked}, ` +
    `batchFailures: ${batchFailures}, truncations: ${truncations}. ` +
    `Tokens: ${totalInputTokens} in / ${totalOutputTokens} out.`,
  );

  await persistPayload(db, runId, {
    groupsProcessed: groupIdx - resumePosition,
    rowsWritten,
    skippedByModel,
    depthBlocked,
    batchFailures,
    truncations,
    totalInputTokens,
    totalOutputTokens,
  });

  // ── 6. Completion check ───────────────────────────────────────────
  if (groupIdx < groups.length) {
    return {
      complete: false,
      itemsDone: groupIdx,
      itemsTotal: groups.length,
      resumePosition: groupIdx,
    };
  }

  console.log(
    `${LOG_PREFIX} forecast_recursion complete: ${rowsWritten} written, ${skippedByModel} skipped, ${depthBlocked} depth-blocked across ${groups.length} groups.`,
  );
  return {
    complete: true,
    itemsDone: groups.length,
    itemsTotal: groups.length,
    resumePosition: groups.length,
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
      [runId, "forecast_recursion", JSON.stringify(payload)],
      { label: "MAST-FRECUR: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }
}

export default forecastRecursion;
