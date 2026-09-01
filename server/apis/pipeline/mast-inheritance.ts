/**
 * mast-inheritance.ts
 *
 * MAST v2 — inheritance stage.
 *
 * For each reliance link, collects the judgments sitting behind the linked
 * figure and writes them into the register as inherited assumptions.
 * One hop only.
 *
 * The canonical case: the entry multiple rests on Adjusted EBITDA, which
 * the accountants built by adding back costs they judged non-recurring.
 * Each add-back is a judgment the deal team is betting on. The memo never
 * restates them, because adopting someone else's number feels like using
 * a fact rather than making an assumption. This stage makes them visible.
 *
 * WORK LIST:
 *   Primary: one item per distinct (to_doc_id, to_locator) pair in
 *   mast_reliance_links for this run, ordered by link count DESC then
 *   to_locator ASC.
 *
 *   Fallback (when no links exist): one item per reference document whose
 *   document_tag is neither financial_model nor ic_memo, ordered by
 *   file_name ASC.
 *
 * CONTEXT RETRIEVAL:
 *   Table path — neighbourhood of the linked cell (same row + ±10/5 rows
 *   in same column band), capped at 6000 chars.
 *
 *   Text path — document_chunks for the document, anchored by to_value
 *   when available, capped at 3 chunks / 12000 chars.
 *
 * LLM CALL:
 *   One per work item. Model via getModuleModel("mast_v2"). Extracts
 *   judgments with verbatim quotes. Same call handling as register_memo.
 *
 * QUOTE GATE:
 *   judgment ≥ 4 words, quote ≥ 6 words, normalized quote is a substring
 *   of normalized retrieved context. Same normalize function.
 *
 * ROWS WRITTEN to mast_assumptions with origin_type = 'inherited'.
 *
 * ONE HOP ONLY: reads mast_reliance_links, never reads its own output.
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
import { loadSheetByName } from "./mast-doc-tables.js";
import { getModuleModel } from "./model-config.js";

const LOG_PREFIX = "[MAST-INHERIT]";

const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const JUDGMENTS_PER_ITEM_CAP = 10;

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const LinkPairRow = z.object({
  to_doc_id: z.string(),
  to_locator: z.string().nullable(),
  link_count: z.coerce.number(),
  min_link_id: z.string(),
  to_value: z.any().nullable(),
  to_label: z.string().nullable(),
});

const RefDocRow = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
});

const DocTableRow = z.object({
  id: z.string(),
  sheet_or_page: z.string(),
  data: z.any(),
});

const ChunkRow = z.object({
  chunk_id: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

// ---------------------------------------------------------------------------
// Parsed cell shape
// ---------------------------------------------------------------------------

interface ParsedCell {
  r: number;
  c: number;
  value: unknown;
  type: string;
  formula?: string | null;
}

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
// Normalization for quote-gating (own copy — no import from register-memo)
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// A1 address helpers
// ---------------------------------------------------------------------------

function parseA1(locator: string): { sheet: string; row: number; col: number } | null {
  // locator format: "SheetName!A1"
  const bangIdx = locator.lastIndexOf("!");
  if (bangIdx < 0) return null;
  const sheet = locator.slice(0, bangIdx);
  const addr = locator.slice(bangIdx + 1);
  const match = addr.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const colStr = match[1];
  const rowNum = parseInt(match[2], 10) - 1; // 0-indexed
  let colNum = 0;
  for (let i = 0; i < colStr.length; i++) {
    colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
  }
  colNum -= 1; // 0-indexed
  return { sheet, row: rowNum, col: colNum };
}

function cellToString(cell: ParsedCell): string {
  if (cell.value == null) return "";
  return String(cell.value).trim();
}

// ---------------------------------------------------------------------------
// Table-path neighbourhood builder
// ---------------------------------------------------------------------------

function buildNeighbourhood(
  cells: ParsedCell[],
  targetRow: number,
  targetCol: number,
): string {
  const ROW_ABOVE = 10;
  const ROW_BELOW = 5;
  const COL_BAND = 3; // columns within ±3 of target

  const minRow = Math.max(0, targetRow - ROW_ABOVE);
  const maxRow = targetRow + ROW_BELOW;
  const minCol = Math.max(0, targetCol - COL_BAND);
  const maxCol = targetCol + COL_BAND;

  // Collect relevant cells
  const relevant: ParsedCell[] = [];
  for (const cell of cells) {
    // Same row — all columns
    if (cell.r === targetRow) {
      relevant.push(cell);
      continue;
    }
    // Column band, within row range
    if (cell.r >= minRow && cell.r <= maxRow && cell.c >= minCol && cell.c <= maxCol) {
      relevant.push(cell);
    }
  }

  // Sort by row then col
  relevant.sort((a, b) => a.r - b.r || a.c - b.c);

  // Render as text
  const lines: string[] = [];
  let currentRow = -1;
  let rowCells: string[] = [];

  for (const cell of relevant) {
    if (cell.r !== currentRow) {
      if (rowCells.length > 0) {
        lines.push(`Row ${currentRow + 1}: ${rowCells.join(" | ")}`);
      }
      currentRow = cell.r;
      rowCells = [];
    }
    const val = cellToString(cell);
    if (val.length > 0) {
      rowCells.push(val);
    }
  }
  if (rowCells.length > 0) {
    lines.push(`Row ${currentRow + 1}: ${rowCells.join(" | ")}`);
  }

  let text = lines.join("\n");
  if (text.length > 6000) {
    text = text.slice(0, 6000);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment diligence analyst. Extract the judgments behind a linked figure exactly as instructed. Return only valid JSON.";

function buildUserPrompt(
  context: string,
  linkedValue: number | null,
  linkedLabel: string | null,
): string {
  let figureDesc = "";
  if (linkedValue != null) {
    figureDesc += `The linked figure has a value of ${linkedValue}`;
    if (linkedLabel) {
      figureDesc += ` and is labeled "${linkedLabel}"`;
    }
    figureDesc += ".\n\n";
  }

  return `Below is context from a reference document used in a deal. ${figureDesc}Extract the judgments that this figure (or the document's conclusions) depend on: choices someone made that could have been made differently, and that would change the figure if made differently.

Look for:
- Normalization adjustments
- Add-backs and exclusions
- Pro forma treatments
- Stated bases and methodological choices
- Classification decisions
- Cut-off and threshold selections

DO NOT extract any of the following:
- The linked figure itself as a judgment
- Historical facts or reported outcomes
- Descriptions of what the business does
- Computed or derived numbers
- Figures restated in different units
- Paraphrased quotes — every quote must be copied character for character

Each quote must be copied character for character from the context below. A quote that does not appear verbatim will be discarded.

Return the most load-bearing judgments first. Return at most ${JUDGMENTS_PER_ITEM_CAP}.

Return a JSON array only. No prose. No markdown fences. Each element has exactly two string fields: "judgment" and "quote".

Example format:
[{"judgment":"Management classified $2.1M in restructuring costs as non-recurring","quote":"restructuring costs of $2.1 million were excluded as non-recurring items"}]

--- CONTEXT ---
${context}
--- END CONTEXT ---`;
}

// ---------------------------------------------------------------------------
// Numeric value rendering for anchor search
// ---------------------------------------------------------------------------

function renderValueForms(value: number): string[] {
  const forms: string[] = [];
  // Plain integer
  if (Number.isInteger(value)) {
    forms.push(String(value));
  } else {
    forms.push(String(value));
  }
  // With thousands separators
  const intPart = Math.trunc(value);
  const formatted = Math.abs(intPart).toLocaleString("en-US");
  if (value < 0) {
    forms.push(`-${formatted}`);
  } else {
    forms.push(formatted);
  }
  // With 1 decimal
  forms.push(value.toFixed(1));
  // With 2 decimals
  forms.push(value.toFixed(2));
  return [...new Set(forms)];
}

// ---------------------------------------------------------------------------
// Work item types
// ---------------------------------------------------------------------------

interface LinkWorkItem {
  kind: "link";
  toDocId: string;
  toLocator: string | null;
  linkCount: number;
  minLinkId: string;
  toValue: number | null;
  toLabel: string | null;
}

interface FallbackWorkItem {
  kind: "fallback";
  docId: string;
  fileName: string;
}

type WorkItem = LinkWorkItem | FallbackWorkItem;

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const inheritance: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  const model = getModuleModel(MODULE_ID);

  // ── 1. Build work list ─────────────────────────────────────────────

  const linkPairs = await db.query(
    `SELECT to_doc_id, to_locator,
            COUNT(*)::int AS link_count,
            MIN(id::text) AS min_link_id,
            (ARRAY_AGG(to_value ORDER BY id))[1] AS to_value,
            (ARRAY_AGG(to_label ORDER BY id))[1] AS to_label
       FROM mast_reliance_links
      WHERE run_id = $1
      GROUP BY to_doc_id, to_locator
      ORDER BY COUNT(*) DESC, to_locator ASC`,
    LinkPairRow,
    [runId],
    { label: `${LOG_PREFIX} load link pairs` },
  );

  let workList: WorkItem[];
  let usingFallback = false;

  if (linkPairs.length > 0) {
    workList = linkPairs.map((lp) => ({
      kind: "link" as const,
      toDocId: lp.to_doc_id,
      toLocator: lp.to_locator,
      linkCount: lp.link_count,
      minLinkId: lp.min_link_id,
      toValue: lp.to_value != null ? (typeof lp.to_value === "number" ? lp.to_value : parseFloat(String(lp.to_value))) : null,
      toLabel: lp.to_label,
    }));
    console.log(`${LOG_PREFIX} Work list: ${workList.length} link pairs (link-based).`);
  } else {
    // Fallback: reference documents
    const refDocs = await db.query(
      `SELECT id, file_name, document_tag
         FROM documents
        WHERE deal_id = $1::uuid
          AND document_tag IS NOT NULL
          AND document_tag NOT IN ('financial_model', 'ic_memo')
        ORDER BY file_name ASC`,
      RefDocRow,
      [dealId],
      { label: `${LOG_PREFIX} load fallback reference documents` },
    );

    if (refDocs.length === 0) {
      throw new Error(
        `${LOG_PREFIX} Fail-closed: both work lists empty. ` +
          `Link pairs: 0. Reference documents (non-model, non-memo): 0.`,
      );
    }

    workList = refDocs.map((d) => ({
      kind: "fallback" as const,
      docId: d.id,
      fileName: d.file_name,
    }));
    usingFallback = true;
    console.log(`${LOG_PREFIX} Work list: ${workList.length} reference documents (fallback — no links).`);
  }

  // ── 2. Idempotency — clear inherited rows on first invocation ──────
  if (resumePosition === 0) {
    await db.execute(
      `DELETE FROM mast_assumptions
       WHERE run_id = $1::uuid AND origin_type = 'inherited'`,
      [runId],
      { label: `${LOG_PREFIX} idempotent delete inherited rows` },
    );
  }

  // ── 3. Process work items ──────────────────────────────────────────
  let itemIdx = resumePosition;
  let totalAccepted = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Rejection counters
  let rejectEmptyJudgment = 0;
  let rejectShortJudgment = 0;
  let rejectEmptyQuote = 0;
  let rejectShortQuote = 0;
  let rejectQuoteNotFound = 0;

  // Failure counters
  let itemsAllCallsFailed = 0;
  let itemsAllParsesFailed = 0;
  let itemsTruncated = 0;
  let itemsNoContext = 0;

  while (itemIdx < workList.length) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded after ${itemIdx - resumePosition} items. ` +
          `Pausing at item ${itemIdx}/${workList.length}.`,
      );
      break;
    }

    const item = workList[itemIdx];
    const itemLabel = item.kind === "link"
      ? `link(${item.toDocId.slice(0, 8)}:${item.toLocator ?? "null"})`
      : `fallback(${item.fileName.slice(0, 40)})`;

    // ── 3a. Retrieve context ─────────────────────────────────────────
    let context = "";
    let linkedValue: number | null = null;
    let linkedLabel: string | null = null;
    let docId: string;
    let originLocator: string;
    let relianceLinkId: string | null;

    if (item.kind === "link") {
      docId = item.toDocId;
      originLocator = item.toLocator ?? "";
      relianceLinkId = item.minLinkId;
      linkedValue = item.toValue != null && isFinite(item.toValue) ? item.toValue : null;
      linkedLabel = item.toLabel;

      // Try table path first
      const parsed = item.toLocator ? parseA1(item.toLocator) : null;
      if (parsed) {
        const loadedSheet = await loadSheetByName(db, item.toDocId, parsed.sheet);

        if (loadedSheet) {
          const data = loadedSheet.data as { cells?: ParsedCell[] };
          const cells = data?.cells ?? [];
          if (cells.length > 0) {
            context = buildNeighbourhood(cells, parsed.row, parsed.col);
          }
        }
      }

      // Fall back to text path if table path yielded nothing
      if (context.length === 0) {
        context = await retrieveTextContext(db, item.toDocId, linkedValue);
      }
    } else {
      // Fallback work item
      docId = item.docId;
      originLocator = item.fileName;
      relianceLinkId = null;

      context = await retrieveTextContext(db, item.docId, null);
    }

    if (context.length === 0) {
      console.log(`${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): no context retrieved. Skipping.`);
      itemsNoContext++;
      itemIdx++;
      continue;
    }

    // ── 3b. LLM call ────────────────────────────────────────────────
    const userPrompt = buildUserPrompt(context, linkedValue, linkedLabel);
    let judgments: Array<{ judgment: string; quote: string }> = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 2;
    let lastAttemptWasError = false;
    let lastAttemptWasParseFailure = false;
    let lastAttemptWasTruncated = false;
    let itemCallErrors = 0;
    let itemParseErrors = 0;
    let itemWasTruncated = false;
    let itemParsedSuccessfully = false;

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
          { label: `${LOG_PREFIX} extract item ${itemIdx} attempt ${attempts}` },
        );

        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;

        // Detect truncation
        if (llmResponse.stop_reason === "max_tokens") {
          console.log(
            `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): TRUNCATED (stop_reason=max_tokens, attempt ${attempts}).`,
          );
          lastAttemptWasTruncated = true;
          itemWasTruncated = true;
        }

        const responseText = llmResponse.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");

        try {
          const parsed = JSON.parse(responseText);
          if (!Array.isArray(parsed)) {
            console.log(
              `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): response not array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastAttemptWasParseFailure = true;
            itemParseErrors++;
            continue;
          }
          judgments = parsed.filter(
            (el: any) =>
              el &&
              typeof el === "object" &&
              typeof el.judgment === "string" &&
              typeof el.quote === "string",
          );
          itemParsedSuccessfully = true;
          break;
        } catch (_parseErr) {
          console.log(
            `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
          );
          lastAttemptWasParseFailure = true;
          itemParseErrors++;
          continue;
        }
      } catch (llmErr) {
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
        );
        lastAttemptWasError = true;
        itemCallErrors++;
        continue;
      }
    }

    // Track failures
    if (itemCallErrors >= attempts) {
      itemsAllCallsFailed++;
    } else if (itemParseErrors >= attempts) {
      itemsAllParsesFailed++;
    }
    if (itemWasTruncated) {
      itemsTruncated++;
    }

    // Cap
    if (judgments.length > JUDGMENTS_PER_ITEM_CAP) {
      judgments = judgments.slice(0, JUDGMENTS_PER_ITEM_CAP);
    }

    // ── 3c. Quote gate ───────────────────────────────────────────────
    const normalizedContext = normalize(context);
    const acceptedJudgments: Array<{ judgment: string; quote: string }> = [];

    for (const j of judgments) {
      // Gate: judgment not empty
      if (!j.judgment || j.judgment.trim().length === 0) {
        rejectEmptyJudgment++;
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): REJECT empty judgment. Quote (120): ${(j.quote ?? "").slice(0, 120)}`,
        );
        continue;
      }

      // Gate: judgment at least 4 words
      const judgmentWords = j.judgment.trim().split(/\s+/);
      if (judgmentWords.length < 4) {
        rejectShortJudgment++;
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): REJECT judgment <4 words: "${j.judgment}". Quote (120): ${j.quote.slice(0, 120)}`,
        );
        continue;
      }

      // Gate: quote not empty
      if (!j.quote || j.quote.trim().length === 0) {
        rejectEmptyQuote++;
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): REJECT empty quote. Judgment: "${j.judgment}"`,
        );
        continue;
      }

      // Gate: quote at least 6 words
      const quoteWords = j.quote.trim().split(/\s+/);
      if (quoteWords.length < 6) {
        rejectShortQuote++;
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): REJECT quote <6 words. Quote (120): ${j.quote.slice(0, 120)}`,
        );
        continue;
      }

      // Gate: normalized quote is substring of normalized context
      const normalizedQuote = normalize(j.quote);
      if (!normalizedContext.includes(normalizedQuote)) {
        rejectQuoteNotFound++;
        console.log(
          `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): REJECT quote not found in context. Quote (120): ${j.quote.slice(0, 120)}`,
        );
        continue;
      }

      acceptedJudgments.push(j);
    }

    // ── 3d. Write accepted judgments ─────────────────────────────────
    if (itemParsedSuccessfully) {
      for (const j of acceptedJudgments) {
        // For fallback items, build origin_locator as "filename chunk chunk_index"
        // We need the chunk index — for link items use the link's to_locator
        let rowOriginLocator = originLocator;
        // originLocator is already set above

        await db.execute(
          `INSERT INTO mast_assumptions (
             run_id, deal_id, proposition, origin_type, origin_doc_id,
             origin_locator, verbatim, quantified, value, unit, period,
             detector, reliance_link_id, recursion_depth
           ) VALUES (
             $1::uuid, $2::uuid, $3, 'inherited', $4::uuid,
             $5, $6, false, NULL, NULL, NULL,
             NULL, $7, 1
           )`,
          [
            runId, dealId, j.judgment, docId,
            rowOriginLocator, j.quote, relianceLinkId,
          ],
          { label: `${LOG_PREFIX} insert inherited judgment from ${itemLabel}` },
        );
      }
    }

    totalAccepted += acceptedJudgments.length;
    console.log(
      `${LOG_PREFIX} Item ${itemIdx} (${itemLabel}): ${acceptedJudgments.length} accepted of ${judgments.length} returned.`,
    );

    itemIdx++;
  }

  // ── 4. Stage summary ──────────────────────────────────────────────
  const isComplete = itemIdx >= workList.length;

  console.log(
    `${LOG_PREFIX} Processed items ${resumePosition}–${itemIdx - 1} of ${workList.length} ` +
      `(${usingFallback ? "fallback" : "link-based"}). ` +
      `Accepted: ${totalAccepted}. Tokens: ${totalInputTokens} in / ${totalOutputTokens} out. ` +
      `Rejections: empty_judgment=${rejectEmptyJudgment}, short_judgment=${rejectShortJudgment}, ` +
      `empty_quote=${rejectEmptyQuote}, short_quote=${rejectShortQuote}, quote_not_found=${rejectQuoteNotFound}. ` +
      `Failures: call_errors=${itemsAllCallsFailed}, parse_errors=${itemsAllParsesFailed}, ` +
      `truncated=${itemsTruncated}, no_context=${itemsNoContext}.`,
  );

  if (isComplete && totalAccepted === 0) {
    console.log(
      `${LOG_PREFIX} WARNING: All ${workList.length} items processed but zero judgments accepted. ` +
        `This may indicate the reference documents carry no recoverable judgments. ` +
        `Rejection totals: empty_judgment=${rejectEmptyJudgment}, short_judgment=${rejectShortJudgment}, ` +
        `empty_quote=${rejectEmptyQuote}, short_quote=${rejectShortQuote}, quote_not_found=${rejectQuoteNotFound}. ` +
        `Returning complete — this is a corpus finding, not a code failure.`,
    );
  }

  return {
    complete: isComplete,
    itemsDone: itemIdx,
    itemsTotal: workList.length,
    resumePosition: itemIdx,
  };
};

// ---------------------------------------------------------------------------
// Text-path context retrieval helper
// ---------------------------------------------------------------------------

async function retrieveTextContext(
  db: StageContext["db"],
  documentId: string,
  anchorValue: number | null,
): Promise<string> {
  const MAX_CHUNKS = 3;
  const MAX_CHARS = 12000;

  // Load all chunks for this document
  const allChunks = await db.query(
    `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content,
            dc.document_id, dc.file_name
       FROM document_chunks dc
      WHERE dc.document_id = $1::uuid
      ORDER BY dc.chunk_index ASC`,
    ChunkRow,
    [documentId],
    { label: `${LOG_PREFIX} text path chunks for doc ${documentId.slice(0, 8)}` },
  );

  if (allChunks.length === 0) return "";

  let selected: Array<z.infer<typeof ChunkRow>>;

  if (anchorValue != null && isFinite(anchorValue)) {
    // Prefer chunks containing the anchor value in any rendered form
    const valueForms = renderValueForms(anchorValue);
    const anchored = allChunks.filter((ch) =>
      valueForms.some((form) => ch.content.includes(form)),
    );

    if (anchored.length > 0) {
      selected = anchored.slice(0, MAX_CHUNKS);
    } else {
      // No anchor match — take by chunk_index order
      selected = allChunks.slice(0, MAX_CHUNKS);
    }
  } else {
    selected = allChunks.slice(0, MAX_CHUNKS);
  }

  // Combine, capping at MAX_CHARS
  let combined = "";
  for (const ch of selected) {
    const remaining = MAX_CHARS - combined.length;
    if (remaining <= 0) break;
    if (combined.length > 0) combined += "\n\n---\n\n";
    combined += ch.content.slice(0, remaining);
  }

  return combined;
}

export default inheritance;
