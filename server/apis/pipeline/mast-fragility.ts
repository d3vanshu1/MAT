/**
 * mast-fragility.ts
 *
 * Stage handler for fragility.
 *
 * For critical and warning findings, asks the model one question per
 * assumption: what specific, observable event in the real world would
 * show this assumption is not holding. Produces a falsification condition
 * and a monitoring trigger.
 *
 * The model must never state an impact on returns. There is no IRR, no
 * MOIC, and no exit multiple anywhere in the source workbook. A sentence
 * like "the IRR falls by four points" would be fabricated. A code-level
 * guard rejects any output containing return-impact language.
 *
 * fragility is a loop stage in LOOP_STAGES. Batch 15, resume by index.
 *
 * Writes only to mast_findings (falsification_condition, monitoring_trigger,
 * fragility_generated) and the payload column of mast_pipeline_state.
 * Does not write to mast_assumptions or mast_support_evidence.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-FRAG]";

const MODULE_ID = "mast_v2";
const BATCH_SIZE = 15;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;
const WORKLIST_CAP = 60;

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

const FindingRow = z.object({
  id: z.string(),
  assumption_id: z.string(),
  severity: z.string(),
  severity_basis: z.string(),
  proposition: z.string(),
  origin_type: z.string(),
  origin_locator: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Fabrication guard — banned phrases (lowercased substrings)
// ---------------------------------------------------------------------------

const BANNED_PHRASES = [
  "irr",
  "moic",
  "multiple of invested",
  "exit multiple",
  "enterprise value",
  "return on investment",
  "basis points of return",
];

function containsBannedPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Support state extraction from severity_basis string
// ---------------------------------------------------------------------------

function extractSupportState(severityBasis: string): string {
  // severity_basis is "dependence=<tier>;support=<state>"
  const match = severityBasis.match(/support=(\w+)/);
  return match ? match[1] : "unknown";
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildBatchPrompt(
  entries: { index: number; proposition: string; support: string }[],
): string {
  const numberedList = entries
    .map((e) => `${e.index}. Assumption: "${e.proposition}" [support: ${e.support}]`)
    .join("\n");

  return `You are a due diligence analyst reviewing assumptions from a private equity deal model. For each assumption below, provide two things:

1. FALSIFICATION CONDITION: One sentence describing a specific, observable event in the real world that would show this assumption is not holding. It must be concrete and checkable — for example, a renewal coming in flat rather than up, or a named contract not being renewed on its due date.

2. MONITORING TRIGGER: One short phrase naming what to watch and roughly when.

PROHIBITIONS — you must NOT:
- State any impact on IRR, MOIC, exit multiple, enterprise value, or returns of any kind
- Introduce any number not present in the assumption text
- Restate the assumption rather than describing how it would fail
- Use hedging language such as "may" or "could" without a specific observable event attached

Return a JSON array only. No prose. No markdown fences. Each element has exactly three fields: "index" (integer matching the numbered entry), "falsification" (string), and "trigger" (string).

--- ENTRIES ---
${numberedList}
--- END ENTRIES ---`;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const fragility: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 1. Load eligible findings (critical + warning) ────────────────
  const allEligible = await db.query(
    `SELECT f.id, f.assumption_id, f.severity, f.severity_basis,
            a.proposition, a.origin_type, a.origin_locator
     FROM mast_findings f
     JOIN mast_assumptions a ON a.id = f.assumption_id
     WHERE f.run_id = $1::uuid
       AND f.severity IN ('critical', 'warning')
     ORDER BY
       CASE f.severity WHEN 'critical' THEN 0 ELSE 1 END,
       f.assumption_id`,
    FindingRow,
    [runId],
    { label: "MAST-FRAG: load eligible findings" },
  );

  const totalEligible = allEligible.length;

  if (totalEligible === 0) {
    console.log(
      `${LOG_PREFIX} No critical or warning findings for run ${runId}. Nothing to do.`,
    );

    // Persist empty payload
    const emptyPayload = {
      eligible: 0,
      cappedOut: 0,
      processed: 0,
      written: 0,
      rejectionsByReason: {},
      batchFailures: 0,
      truncations: 0,
    };
    try {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
         WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
        [runId, "fragility", JSON.stringify(emptyPayload)],
        { label: "MAST-FRAG: persist empty payload" },
      );
    } catch (_) { /* best effort */ }

    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // Cap at WORKLIST_CAP
  const cappedOut = Math.max(0, totalEligible - WORKLIST_CAP);
  const workList = allEligible.slice(0, WORKLIST_CAP);
  const totalItems = workList.length;

  if (cappedOut > 0) {
    console.log(
      `${LOG_PREFIX} ${totalEligible} eligible findings. Capped to ${WORKLIST_CAP}; ${cappedOut} skipped.`,
    );
  } else {
    console.log(`${LOG_PREFIX} ${totalEligible} eligible findings. Processing all.`);
  }

  // ── 2. Idempotency reset at position 0 ────────────────────────────
  if (ctx.resumePosition === 0) {
    await db.execute(
      `UPDATE mast_findings
       SET falsification_condition = NULL,
           monitoring_trigger = NULL,
           fragility_generated = false
       WHERE run_id = $1::uuid`,
      [runId],
      { label: "MAST-FRAG: idempotency reset" },
    );
  }

  // ── 3. Process in batches ─────────────────────────────────────────
  let itemIdx = ctx.resumePosition;
  let processed = 0;
  let written = 0;
  let batchFailures = 0;
  let truncations = 0;
  const rejectionsByReason: Record<string, number> = {};

  function countRejection(reason: string): void {
    rejectionsByReason[reason] = (rejectionsByReason[reason] || 0) + 1;
  }

  while (itemIdx < totalItems) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded at item ${itemIdx}/${totalItems}. Pausing.`,
      );
      break;
    }

    const batchEnd = Math.min(itemIdx + BATCH_SIZE, totalItems);
    const batch = workList.slice(itemIdx, batchEnd);

    // Build prompt entries
    const entries = batch.map((row, i) => ({
      index: i + 1,
      proposition: row.proposition,
      support: extractSupportState(row.severity_basis),
    }));

    const userPrompt = buildBatchPrompt(entries);

    // ── LLM call with retry ─────────────────────────────────────────
    let resultMap: Map<number, { falsification: string; trigger: string }> | null = null;
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
          { label: `MAST-FRAG: batch ${itemIdx}–${batchEnd - 1} attempt ${attempts}` },
        );

        if (llmResponse.stop_reason === "max_tokens") {
          console.log(
            `${LOG_PREFIX} Batch ${itemIdx}: TRUNCATED (attempt ${attempts}).`,
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
              `${LOG_PREFIX} Batch ${itemIdx}: not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastWasParseFailure = true;
            continue;
          }
          resultMap = new Map();
          for (const el of parsed) {
            if (
              el &&
              typeof el === "object" &&
              typeof el.index === "number" &&
              typeof el.falsification === "string" &&
              typeof el.trigger === "string" &&
              el.index >= 1 &&
              el.index <= batch.length
            ) {
              resultMap.set(el.index, {
                falsification: el.falsification.trim(),
                trigger: el.trigger.trim(),
              });
            }
          }
          // Successfully parsed — done
          break;
        } catch (_parseErr) {
          console.log(
            `${LOG_PREFIX} Batch ${itemIdx}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
          );
          lastWasParseFailure = true;
          continue;
        }
      } catch (llmErr) {
        console.log(
          `${LOG_PREFIX} Batch ${itemIdx}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
        );
        lastWasError = true;
        continue;
      }
    }

    // ── Apply results ───────────────────────────────────────────────
    if (resultMap === null) {
      batchFailures++;
      processed += batch.length;
      console.log(
        `${LOG_PREFIX} Batch ${itemIdx}: all attempts failed. ${batch.length} findings skipped.`,
      );
    } else {
      for (let i = 0; i < batch.length; i++) {
        processed++;
        const finding = batch[i];
        const result = resultMap.get(i + 1);

        if (!result) continue;

        // ── Write-time gate ───────────────────────────────────────
        const { falsification, trigger } = result;

        // Empty check
        if (!falsification || !trigger) {
          console.log(
            `${LOG_PREFIX} REJECTED finding ${finding.id}: empty falsification or trigger.`,
          );
          countRejection("empty_field");
          continue;
        }

        // Word count check on falsification (< 6 words)
        const wordCount = falsification.split(/\s+/).filter(Boolean).length;
        if (wordCount < 6) {
          console.log(
            `${LOG_PREFIX} REJECTED finding ${finding.id}: falsification too short (${wordCount} words). Text: ${falsification.slice(0, 120)}`,
          );
          countRejection("too_short");
          continue;
        }

        // Fabrication guard — falsification
        const bannedInFalsification = containsBannedPhrase(falsification);
        if (bannedInFalsification) {
          console.log(
            `${LOG_PREFIX} REJECTED finding ${finding.id}: banned phrase "${bannedInFalsification}" in falsification. Text: ${falsification.slice(0, 120)}`,
          );
          countRejection("banned_phrase_falsification");
          continue;
        }

        // Fabrication guard — trigger
        const bannedInTrigger = containsBannedPhrase(trigger);
        if (bannedInTrigger) {
          console.log(
            `${LOG_PREFIX} REJECTED finding ${finding.id}: banned phrase "${bannedInTrigger}" in trigger. Text: ${trigger.slice(0, 120)}`,
          );
          countRejection("banned_phrase_trigger");
          continue;
        }

        // ── All gates passed — write ──────────────────────────────
        await db.execute(
          `UPDATE mast_findings
           SET falsification_condition = $2,
               monitoring_trigger = $3,
               fragility_generated = true
           WHERE id = $1::uuid`,
          [finding.id, falsification, trigger],
          { label: `MAST-FRAG: update finding ${finding.id}` },
        );
        written++;
      }
    }

    itemIdx = batchEnd;
  }

  const complete = itemIdx >= totalItems;

  // ── 4. Log prominently ────────────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Fragility ${complete ? "complete" : "paused"}. ` +
    `eligible=${totalEligible}, capped=${cappedOut}, ` +
    `processed=${processed}, written=${written}, ` +
    `batchFailures=${batchFailures}, truncations=${truncations}. ` +
    `rejections: ${JSON.stringify(rejectionsByReason)}`,
  );

  // ── 5. Persist payload ────────────────────────────────────────────
  const summaryPayload = {
    eligible: totalEligible,
    cappedOut,
    processed,
    written,
    rejectionsByReason,
    batchFailures,
    truncations,
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "fragility", JSON.stringify(summaryPayload)],
      { label: "MAST-FRAG: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  return {
    complete,
    itemsDone: itemIdx,
    itemsTotal: totalItems,
    resumePosition: itemIdx,
  };
};

export default fragility;
