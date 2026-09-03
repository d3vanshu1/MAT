/**
 * mast-sweep.ts
 *
 * MAST v2 — sweep stage.
 *
 * Merges four former stages into one:
 *   Phase 1 (links):   reliance_links — numeric figure matching
 *   Phase 2 (inherit): inheritance — LLM extraction from linked figures
 *   Phase 3 (search):  support_search — LLM sweep of reference corpus
 *   Phase 4 (recurse): forecast_recursion — promote forecast evidence to assumptions
 *
 * Resume encoding:
 *   resumePosition = 0 → fresh start (phase links, cursor 0)
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
import { loadAllSheets, loadSheetByName } from "./mast-doc-tables.js";
import { resolveModelDocument } from "./mast-register-model-drivers.js";
import { getModuleModel } from "./model-config.js";

const LOG_PREFIX = "[MAST-SWEEP]";
const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;

type SweepPhase = "links" | "inherit" | "search" | "recurse" | "complete";

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
// PHASE 1: LINKS (ported from mast-reliance-links.ts)
// =========================================================================

// --- Links DB schemas ---

const AssumptionLeftSchema = z.object({
  id: z.string(),
  origin_type: z.string(),
  origin_doc_id: z.string().nullable(),
  origin_locator: z.string().nullable(),
  proposition: z.string(),
  verbatim: z.string().nullable(),
  value: z.any().nullable(),
});

type AssumptionLeftRow = z.infer<typeof AssumptionLeftSchema>;

const RefDocRow = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
});

// --- Links types and helpers (verbatim from mast-reliance-links.ts) ---

interface ParsedCell {
  r: number;
  c: number;
  value: unknown;
  type: string;
  formula?: string | null;
}

const NUMERIC_TOKEN_RE =
  /(?:[$\u20AC\u00A3\u00A5])\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?(%)?|(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?(%)?/gi;

interface ExtractedFigure {
  value: number;
  figureIndex: number;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  bn: 1_000_000_000,
};

function extractNumericTokens(text: string): ExtractedFigure[] {
  const figures: ExtractedFigure[] = [];
  NUMERIC_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = NUMERIC_TOKEN_RE.exec(text)) !== null) {
    const numStr = (m[1] ?? m[4] ?? "").replace(/,/g, "");
    const suffix = (m[2] ?? m[5] ?? "").toLowerCase();
    const isPct = !!(m[3] ?? m[6]);

    if (numStr.length === 0) continue;
    let val = parseFloat(numStr);
    if (!isFinite(val)) continue;

    if (/^\d{4}$/.test(numStr) && val >= 1900 && val <= 2100) continue;

    if (suffix && MULTIPLIERS[suffix]) {
      val *= MULTIPLIERS[suffix];
    }

    figures.push({ value: val, figureIndex: idx++ });
  }

  return figures;
}

interface RightSideEntry {
  docId: string;
  sheetOrPage: string;
  addr: string;
  label: string | null;
  value: number;
}

interface LeftSideEntry {
  assumptionId: string;
  originType: string;
  originDocId: string | null;
  originLocator: string | null;
  proposition: string;
  value: number;
  figureIndex: number;
}

function indexToCol(idx: number): string {
  let col = "";
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    idx = Math.floor((idx - 1) / 26);
  }
  return col;
}

function toA1(row: number, col: number): string {
  return `${indexToCol(col + 1)}${row + 1}`;
}

function roundTo6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function toleranceThreshold(a: number, b: number): number {
  const maxAbs = Math.max(Math.abs(a), Math.abs(b));
  return Math.max(maxAbs * 0.005, 1000);
}

function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= toleranceThreshold(a, b);
}

const SCALE_FACTORS = [1_000, 1_000_000, 1_000_000_000];

interface MatchResult {
  method: "numeric_exact" | "numeric_tolerance" | "scaled_match";
  absDiff: number;
  notes: string | null;
}

interface RightSideIndex {
  sorted: RightSideEntry[];
  exactMap: Map<number, RightSideEntry[]>;
}

function buildRightSideIndex(entries: RightSideEntry[]): RightSideIndex {
  const sorted = entries.slice().sort((a, b) => a.value - b.value);
  const exactMap = new Map<number, RightSideEntry[]>();
  for (const e of entries) {
    const key = roundTo6(e.value);
    let bucket = exactMap.get(key);
    if (!bucket) { bucket = []; exactMap.set(key, bucket); }
    bucket.push(e);
  }
  return { sorted, exactMap };
}

function lowerBound(sorted: RightSideEntry[], target: number): number {
  let lo = 0; let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid].value < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function windowedLookup(sorted: RightSideEntry[], lo: number, hi: number): RightSideEntry[] {
  const results: RightSideEntry[] = [];
  const startIdx = lowerBound(sorted, lo);
  for (let i = startIdx; i < sorted.length; i++) {
    if (sorted[i].value > hi) break;
    results.push(sorted[i]);
  }
  return results;
}

function findMatches(leftValue: number, index: RightSideIndex): Array<{ right: RightSideEntry; match: MatchResult }> {
  const results: Array<{ right: RightSideEntry; match: MatchResult }> = [];
  const matched = new Set<RightSideEntry>();

  const exactKey = roundTo6(leftValue);
  const exactBucket = index.exactMap.get(exactKey);
  if (exactBucket) {
    for (const right of exactBucket) {
      if (roundTo6(right.value) === exactKey) {
        matched.add(right);
        results.push({ right, match: { method: "numeric_exact", absDiff: Math.abs(leftValue - right.value), notes: null } });
      }
    }
  }

  const leftAbs = Math.abs(leftValue);
  const minThreshold = Math.max(leftAbs * 0.005, 1000);
  const windowLo = leftValue - minThreshold;
  const windowHi = leftValue + minThreshold;
  const toleranceCandidates = windowedLookup(index.sorted, windowLo, windowHi);
  for (const right of toleranceCandidates) {
    if (matched.has(right)) continue;
    if (withinTolerance(leftValue, right.value)) {
      matched.add(right);
      results.push({ right, match: { method: "numeric_tolerance", absDiff: Math.abs(leftValue - right.value), notes: null } });
    }
  }

  for (const factor of SCALE_FACTORS) {
    const scaledLeft = leftValue * factor;
    const slAbs = Math.abs(scaledLeft);
    const slThreshold = Math.max(slAbs * 0.005, 1000);
    const slCandidates = windowedLookup(index.sorted, scaledLeft - slThreshold, scaledLeft + slThreshold);
    for (const right of slCandidates) {
      if (matched.has(right)) continue;
      if (withinTolerance(scaledLeft, right.value)) {
        matched.add(right);
        results.push({ right, match: { method: "scaled_match", absDiff: Math.abs(scaledLeft - right.value), notes: `left*${factor}` } });
      }
    }

    const targetRight = leftValue / factor;
    const trAbs = Math.abs(targetRight);
    const trThreshold = Math.max(Math.max(leftAbs, trAbs * factor) * 0.005, 1000) / factor;
    const trWindowThreshold = Math.max(trThreshold, Math.max(trAbs * 0.005, 1000));
    const trCandidates = windowedLookup(index.sorted, targetRight - trWindowThreshold, targetRight + trWindowThreshold);
    for (const right of trCandidates) {
      if (matched.has(right)) continue;
      const scaledRight = right.value * factor;
      if (withinTolerance(leftValue, scaledRight)) {
        matched.add(right);
        results.push({ right, match: { method: "scaled_match", absDiff: Math.abs(leftValue - scaledRight), notes: `right*${factor}` } });
      }
    }
  }

  return results;
}

function isSuppressed(leftValue: number): boolean {
  const absVal = Math.abs(leftValue);
  if (absVal < 1000) return true;
  if (Number.isInteger(leftValue) && absVal >= 1 && absVal <= 100) return true;
  return false;
}

const GLOBAL_LINK_CAP = 2000;
const FAN_OUT_CAP = 5;

// =========================================================================
// PHASE 2: INHERIT (ported from mast-inheritance.ts)
// =========================================================================

const LinkPairRow = z.object({
  to_doc_id: z.string(),
  to_locator: z.string().nullable(),
  link_count: z.coerce.number(),
  min_link_id: z.string(),
  to_value: z.any().nullable(),
  to_label: z.string().nullable(),
});

const InheritChunkRow = z.object({
  chunk_id: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

const JUDGMENTS_PER_ITEM_CAP = 10;

const INHERIT_SYSTEM_PROMPT =
  "You are an investment diligence analyst. Extract the judgments behind a linked figure exactly as instructed. Return only valid JSON.";

function buildInheritUserPrompt(
  context: string,
  linkedValue: number | null,
  linkedLabel: string | null,
): string {
  let figureDesc = "";
  if (linkedValue != null) {
    figureDesc += `The linked figure has a value of ${linkedValue}`;
    if (linkedLabel) figureDesc += ` and is labeled "${linkedLabel}"`;
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

function parseA1(locator: string): { sheet: string; row: number; col: number } | null {
  const bangIdx = locator.lastIndexOf("!");
  if (bangIdx < 0) return null;
  const sheet = locator.slice(0, bangIdx);
  const addr = locator.slice(bangIdx + 1);
  const match = addr.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const colStr = match[1];
  const rowNum = parseInt(match[2], 10) - 1;
  let colNum = 0;
  for (let i = 0; i < colStr.length; i++) {
    colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
  }
  colNum -= 1;
  return { sheet, row: rowNum, col: colNum };
}

function cellToString(cell: ParsedCell): string {
  if (cell.value == null) return "";
  return String(cell.value).trim();
}

function buildNeighbourhood(cells: ParsedCell[], targetRow: number, targetCol: number): string {
  const ROW_ABOVE = 10; const ROW_BELOW = 5; const COL_BAND = 3;
  const minRow = Math.max(0, targetRow - ROW_ABOVE);
  const maxRow = targetRow + ROW_BELOW;
  const minCol = Math.max(0, targetCol - COL_BAND);
  const maxCol = targetCol + COL_BAND;

  const relevant: ParsedCell[] = [];
  for (const cell of cells) {
    if (cell.r === targetRow) { relevant.push(cell); continue; }
    if (cell.r >= minRow && cell.r <= maxRow && cell.c >= minCol && cell.c <= maxCol) relevant.push(cell);
  }
  relevant.sort((a, b) => a.r - b.r || a.c - b.c);

  const lines: string[] = [];
  let currentRow = -1; let rowCells: string[] = [];
  for (const cell of relevant) {
    if (cell.r !== currentRow) {
      if (rowCells.length > 0) lines.push(`Row ${currentRow + 1}: ${rowCells.join(" | ")}`);
      currentRow = cell.r; rowCells = [];
    }
    const val = cellToString(cell);
    if (val.length > 0) rowCells.push(val);
  }
  if (rowCells.length > 0) lines.push(`Row ${currentRow + 1}: ${rowCells.join(" | ")}`);

  let text = lines.join("\n");
  if (text.length > 6000) text = text.slice(0, 6000);
  return text;
}

function renderValueForms(value: number): string[] {
  const forms: string[] = [];
  forms.push(String(value));
  const intPart = Math.trunc(value);
  const formatted = Math.abs(intPart).toLocaleString("en-US");
  forms.push(value < 0 ? `-${formatted}` : formatted);
  forms.push(value.toFixed(1));
  forms.push(value.toFixed(2));
  return [...new Set(forms)];
}

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

type InheritWorkItem = LinkWorkItem | FallbackWorkItem;

async function retrieveTextContext(
  db: StageContext["db"],
  documentId: string,
  anchorValue: number | null,
): Promise<string> {
  const MAX_CHUNKS = 3; const MAX_CHARS = 12000;
  const allChunks = await db.query(
    `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content, dc.document_id, dc.file_name
       FROM document_chunks dc WHERE dc.document_id = $1::uuid ORDER BY dc.chunk_index ASC`,
    InheritChunkRow, [documentId],
    { label: `${LOG_PREFIX} text path chunks for doc ${documentId.slice(0, 8)}` },
  );
  if (allChunks.length === 0) return "";

  let selected: Array<z.infer<typeof InheritChunkRow>>;
  if (anchorValue != null && isFinite(anchorValue)) {
    const valueForms = renderValueForms(anchorValue);
    const anchored = allChunks.filter((ch) => valueForms.some((form) => ch.content.includes(form)));
    selected = anchored.length > 0 ? anchored.slice(0, MAX_CHUNKS) : allChunks.slice(0, MAX_CHUNKS);
  } else {
    selected = allChunks.slice(0, MAX_CHUNKS);
  }

  let combined = "";
  for (const ch of selected) {
    const remaining = MAX_CHARS - combined.length;
    if (remaining <= 0) break;
    if (combined.length > 0) combined += "\n\n---\n\n";
    combined += ch.content.slice(0, remaining);
  }
  return combined;
}

// =========================================================================
// PHASE 3: SEARCH (ported from mast-support-search.ts — Arm B prompt)
// =========================================================================

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
// PHASE 4: RECURSE (ported from mast-forecast-recursion.ts)
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
// Shared Anthropic response schema (for inherit and recurse)
// =========================================================================

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

  // Phase 1 counters
  let links_linksWritten = seedNum(priorPayload, "links_linksWritten");
  let links_suppressedSmall = seedNum(priorPayload, "links_suppressedSmall");
  let links_fanOutDiscarded = seedNum(priorPayload, "links_fanOutDiscarded");
  let links_globalDiscarded = seedNum(priorPayload, "links_globalDiscarded");

  // Phase 2 counters
  let inherit_totalAccepted = seedNum(priorPayload, "inherit_totalAccepted");
  let inherit_rejectEmptyJudgment = seedNum(priorPayload, "inherit_rejectEmptyJudgment");
  let inherit_rejectShortJudgment = seedNum(priorPayload, "inherit_rejectShortJudgment");
  let inherit_rejectEmptyQuote = seedNum(priorPayload, "inherit_rejectEmptyQuote");
  let inherit_rejectShortQuote = seedNum(priorPayload, "inherit_rejectShortQuote");
  let inherit_rejectQuoteNotFound = seedNum(priorPayload, "inherit_rejectQuoteNotFound");
  let inherit_itemsAllCallsFailed = seedNum(priorPayload, "inherit_itemsAllCallsFailed");
  let inherit_itemsAllParsesFailed = seedNum(priorPayload, "inherit_itemsAllParsesFailed");
  let inherit_itemsTruncated = seedNum(priorPayload, "inherit_itemsTruncated");
  let inherit_itemsNoContext = seedNum(priorPayload, "inherit_itemsNoContext");
  let inherit_totalInputTokens = seedNum(priorPayload, "inherit_totalInputTokens");
  let inherit_totalOutputTokens = seedNum(priorPayload, "inherit_totalOutputTokens");

  // Phase 3 counters
  let search_chunksProcessed = seedNum(priorPayload, "search_chunksProcessed");
  let search_totalHitsReturned = seedNum(priorPayload, "search_totalHitsReturned");
  let search_hitsPassedGate = seedNum(priorPayload, "search_hitsPassedGate");
  let search_rejectQuoteTooShort = seedNum(priorPayload, "search_rejectQuoteTooShort");
  let search_rejectPrefixNotFound = seedNum(priorPayload, "search_rejectPrefixNotFound");
  let search_rejectBadIndex = seedNum(priorPayload, "search_rejectBadIndex");
  let search_remappedChunkLabel = seedNum(priorPayload, "search_remappedChunkLabel");
  let search_callFailures = seedNum(priorPayload, "search_callFailures");
  let search_batchesParseFailed = seedNum(priorPayload, "search_batchesParseFailed");
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

  // Phase 4 counters
  let recurse_rowsWritten = seedNum(priorPayload, "recurse_rowsWritten");
  let recurse_skippedByModel = seedNum(priorPayload, "recurse_skippedByModel");
  let recurse_depthBlocked = seedNum(priorPayload, "recurse_depthBlocked");
  let recurse_batchFailures = seedNum(priorPayload, "recurse_batchFailures");
  let recurse_truncations = seedNum(priorPayload, "recurse_truncations");
  let recurse_totalInputTokens = seedNum(priorPayload, "recurse_totalInputTokens");
  let recurse_totalOutputTokens = seedNum(priorPayload, "recurse_totalOutputTokens");

  // ── Determine current phase ───────────────────────────────────────
  let phase: SweepPhase = "links";
  let phaseCursor = 0;

  if (resumePosition > 0 && priorPayload.phase && typeof priorPayload.phase === "string") {
    phase = priorPayload.phase as SweepPhase;
    phaseCursor = typeof priorPayload.phaseCursor === "number" ? priorPayload.phaseCursor : 0;
  }

  console.log(`${LOG_PREFIX} Invocation ${invocationCount}: phase=${phase}, phaseCursor=${phaseCursor}, resumePosition=${resumePosition}`);

  // Helper to build payload object
  const buildPayload = (): Record<string, unknown> => ({
    phase,
    phaseCursor,
    invocationCount,
    countersCumulative: true,
    // Phase 1
    links_linksWritten,
    links_suppressedSmall,
    links_fanOutDiscarded,
    links_globalDiscarded,
    // Phase 2
    inherit_totalAccepted,
    inherit_rejectEmptyJudgment,
    inherit_rejectShortJudgment,
    inherit_rejectEmptyQuote,
    inherit_rejectShortQuote,
    inherit_rejectQuoteNotFound,
    inherit_itemsAllCallsFailed,
    inherit_itemsAllParsesFailed,
    inherit_itemsTruncated,
    inherit_itemsNoContext,
    inherit_totalInputTokens,
    inherit_totalOutputTokens,
    // Phase 3
    search_chunksProcessed,
    search_totalHitsReturned,
    search_hitsPassedGate,
    search_rejectQuoteTooShort,
    search_rejectPrefixNotFound,
    search_rejectBadIndex,
    search_remappedChunkLabel,
    search_callFailures,
    search_batchesParseFailed,
    search_rejectBadRelation,
    search_truncations,
    search_totalInputTokens,
    search_totalOutputTokens,
    search_totalCacheCreationTokens,
    search_totalCacheReadTokens,
    search_hitsByKind,
    // Phase 4
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
  // PHASE 1: LINKS
  // ====================================================================
  if (phase === "links") {
    console.log(`${LOG_PREFIX} Phase 1 (links): starting at cursor ${phaseCursor}`);

    const leftRows = await db.query(
      `SELECT id, origin_type, origin_doc_id, origin_locator, proposition, verbatim, value
         FROM mast_assumptions
        WHERE run_id = $1
          AND origin_type = 'memo_prose'
        ORDER BY origin_locator ASC`,
      AssumptionLeftSchema, [runId],
      { label: `${LOG_PREFIX} load left-side assumptions` },
    );

    const leftSide: LeftSideEntry[] = [];
    for (const row of leftRows) {
      if (row.origin_type === "model_explicit") {
        if (row.value == null) continue;
        const numVal = typeof row.value === "number" ? row.value : parseFloat(String(row.value));
        if (!isFinite(numVal)) continue;
        leftSide.push({ assumptionId: row.id, originType: row.origin_type, originDocId: row.origin_doc_id, originLocator: row.origin_locator, proposition: row.proposition, value: numVal, figureIndex: 0 });
      } else if (row.origin_type === "memo_prose") {
        const text = row.verbatim ?? row.proposition;
        const figures = extractNumericTokens(text);
        for (const fig of figures) {
          leftSide.push({ assumptionId: row.id, originType: row.origin_type, originDocId: row.origin_doc_id, originLocator: row.origin_locator, proposition: row.proposition, value: fig.value, figureIndex: fig.figureIndex });
        }
      }
    }

    if (leftSide.length === 0) {
      throw new Error(`${LOG_PREFIX} Phase 1 fail-closed: left-side list is empty.`);
    }

    console.log(`${LOG_PREFIX} Left side: ${leftSide.length} figures from ${leftRows.length} rows.`);

    if (phaseCursor === 0) {
      await db.execute(`DELETE FROM mast_reliance_links WHERE run_id = $1`, [runId], { label: `${LOG_PREFIX} idempotent delete links` });
    }

    const refDocs = await db.query(
      `SELECT id, file_name, document_tag FROM documents
        WHERE deal_id = $1::uuid AND document_tag IS NOT NULL
          AND document_tag NOT IN ('financial_model', 'ic_memo')
        ORDER BY file_name ASC`,
      RefDocRow, [dealId], { label: `${LOG_PREFIX} load reference documents` },
    );

    const rightSideRaw: RightSideEntry[] = [];
    let docsWithNoTables = 0;

    for (const doc of refDocs) {
      const { sheets, skipped } = await loadAllSheets(db, doc.id);
      if (skipped > 0) console.log(`${LOG_PREFIX} ${skipped} sheet(s) skipped for "${doc.file_name.slice(0, 40)}" due to size limit.`);
      if (sheets.length === 0) { docsWithNoTables++; continue; }

      for (const sheet of sheets) {
        const data = sheet.data as { cells?: ParsedCell[] };
        const cells = data?.cells ?? [];
        const rowLabelEntries = new Map<number, { col: number; label: string }>();
        for (const cell of cells) {
          if (cell.type !== "string" && cell.type !== "s") continue;
          if (typeof cell.value !== "string" || cell.value.trim().length === 0) continue;
          const existing = rowLabelEntries.get(cell.r);
          if (!existing || cell.c < existing.col) rowLabelEntries.set(cell.r, { col: cell.c, label: cell.value.trim() });
        }
        for (const cell of cells) {
          if (cell.type !== "number" && cell.type !== "n") continue;
          const numVal = typeof cell.value === "number" ? cell.value : parseFloat(String(cell.value));
          if (!isFinite(numVal)) continue;
          const addr = toA1(cell.r, cell.c);
          const labelEntry = rowLabelEntries.get(cell.r);
          rightSideRaw.push({ docId: doc.id, sheetOrPage: sheet.sheet_or_page, addr, label: labelEntry ? labelEntry.label : null, value: numVal });
        }
      }
    }

    console.log(`${LOG_PREFIX} Right side: ${rightSideRaw.length} cells from ${refDocs.length} docs (${docsWithNoTables} with no tables).`);

    if (rightSideRaw.length === 0) {
      console.log(`${LOG_PREFIX} Right-side index empty. Advancing to phase inherit.`);
      phase = "inherit"; phaseCursor = 0;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
      // fall through to inherit below
    } else {
      const rightIndex = buildRightSideIndex(rightSideRaw);

      const existingCountRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM mast_reliance_links WHERE run_id = $1`, CountRow, [runId],
        { label: `${LOG_PREFIX} count existing links` },
      );
      const existingLinkCount = existingCountRows.length > 0 ? existingCountRows[0].cnt : 0;
      let remainingAllowance = GLOBAL_LINK_CAP - existingLinkCount;

      interface PendingLink { left: LeftSideEntry; right: RightSideEntry; match: MatchResult; }
      const allLinks: PendingLink[] = [];
      let figIdx = phaseCursor;

      while (figIdx < leftSide.length) {
        if (Date.now() - startTime > STAGE_BUDGET_MS) {
          console.log(`${LOG_PREFIX} Phase 1 budget exceeded at figure ${figIdx}/${leftSide.length}.`);
          phaseCursor = figIdx;
          nextResumePosition += figIdx - phaseCursor + 1;
          await persistPayload(db, runId, buildPayload());
          // Write accumulated links before returning
          for (const link of allLinks) {
            const toLocator = `${link.right.sheetOrPage}!${link.right.addr}`;
            await db.execute(
              `INSERT INTO mast_reliance_links (run_id, deal_id, from_doc_id, from_locator, from_label, from_value, to_doc_id, to_locator, to_label, to_value, match_method, match_tolerance, notes)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13)`,
              [runId, dealId, link.left.originDocId, link.left.originLocator, link.left.proposition.slice(0, 200), link.left.value, link.right.docId, toLocator, link.right.label, link.right.value, link.match.method, link.match.absDiff, link.match.notes],
              { label: `${LOG_PREFIX} insert link` },
            );
            links_linksWritten++;
          }
          await persistPayload(db, runId, buildPayload());
          return { complete: false, itemsDone: figIdx, itemsTotal: leftSide.length, resumePosition: nextResumePosition };
        }

        const left = leftSide[figIdx];
        figIdx++;

        if (isSuppressed(left.value)) { links_suppressedSmall++; continue; }
        if (remainingAllowance <= 0) continue;

        const matches = findMatches(left.value, rightIndex);
        if (matches.length > FAN_OUT_CAP) {
          matches.sort((a, b) => a.match.absDiff - b.match.absDiff);
          links_fanOutDiscarded += matches.length - FAN_OUT_CAP;
          matches.length = FAN_OUT_CAP;
        }
        for (const { right, match } of matches) allLinks.push({ left, right, match });
      }

      // Apply global cap
      if (allLinks.length > remainingAllowance) {
        if (remainingAllowance <= 0) { links_globalDiscarded += allLinks.length; allLinks.length = 0; }
        else { allLinks.sort((a, b) => Math.abs(b.left.value) - Math.abs(a.left.value)); links_globalDiscarded += allLinks.length - remainingAllowance; allLinks.length = remainingAllowance; }
      }

      // Write links
      for (const link of allLinks) {
        const toLocator = `${link.right.sheetOrPage}!${link.right.addr}`;
        await db.execute(
          `INSERT INTO mast_reliance_links (run_id, deal_id, from_doc_id, from_locator, from_label, from_value, to_doc_id, to_locator, to_label, to_value, match_method, match_tolerance, notes)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13)`,
          [runId, dealId, link.left.originDocId, link.left.originLocator, link.left.proposition.slice(0, 200), link.left.value, link.right.docId, toLocator, link.right.label, link.right.value, link.match.method, link.match.absDiff, link.match.notes],
          { label: `${LOG_PREFIX} insert link` },
        );
        links_linksWritten++;
      }

      console.log(`${LOG_PREFIX} Phase 1 complete: ${links_linksWritten} links written.`);
      phase = "inherit"; phaseCursor = 0;
      nextResumePosition++;
      await persistPayload(db, runId, buildPayload());
    }
  }

  // ====================================================================
  // PHASE 2: INHERIT
  // ====================================================================
  if (phase === "inherit") {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      await persistPayload(db, runId, buildPayload());
      return { complete: false, itemsDone: 0, itemsTotal: 1, resumePosition: nextResumePosition };
    }

    console.log(`${LOG_PREFIX} Phase 2 (inherit): starting at cursor ${phaseCursor}`);

    const linkPairs = await db.query(
      `SELECT to_doc_id, to_locator, COUNT(*)::int AS link_count, MIN(id::text) AS min_link_id,
              (ARRAY_AGG(to_value ORDER BY id))[1] AS to_value, (ARRAY_AGG(to_label ORDER BY id))[1] AS to_label
         FROM mast_reliance_links WHERE run_id = $1
         GROUP BY to_doc_id, to_locator ORDER BY COUNT(*) DESC, to_locator ASC`,
      LinkPairRow, [runId], { label: `${LOG_PREFIX} load link pairs` },
    );

    let inheritWorkList: InheritWorkItem[];
    let usingFallback = false;

    if (linkPairs.length > 0) {
      inheritWorkList = linkPairs.map((lp) => ({
        kind: "link" as const, toDocId: lp.to_doc_id, toLocator: lp.to_locator,
        linkCount: lp.link_count, minLinkId: lp.min_link_id,
        toValue: lp.to_value != null ? (typeof lp.to_value === "number" ? lp.to_value : parseFloat(String(lp.to_value))) : null,
        toLabel: lp.to_label,
      }));
    } else {
      const refDocs = await db.query(
        `SELECT id, file_name, document_tag FROM documents
          WHERE deal_id = $1::uuid AND document_tag IS NOT NULL AND document_tag NOT IN ('financial_model', 'ic_memo')
          ORDER BY file_name ASC`,
        RefDocRow, [dealId], { label: `${LOG_PREFIX} load fallback reference documents` },
      );
      if (refDocs.length === 0) {
        throw new Error(`${LOG_PREFIX} Phase 2 fail-closed: both work lists empty.`);
      }
      inheritWorkList = refDocs.map((d) => ({ kind: "fallback" as const, docId: d.id, fileName: d.file_name }));
      usingFallback = true;
    }

    if (phaseCursor === 0) {
      await db.execute(`DELETE FROM mast_assumptions WHERE run_id = $1::uuid AND origin_type = 'inherited'`, [runId], { label: `${LOG_PREFIX} idempotent delete inherited` });
    }

    let itemIdx = phaseCursor;

    while (itemIdx < inheritWorkList.length) {
      if (Date.now() - startTime > STAGE_BUDGET_MS) {
        console.log(`${LOG_PREFIX} Phase 2 budget exceeded at item ${itemIdx}/${inheritWorkList.length}.`);
        phaseCursor = itemIdx;
        nextResumePosition++;
        await persistPayload(db, runId, buildPayload());
        return { complete: false, itemsDone: itemIdx, itemsTotal: inheritWorkList.length, resumePosition: nextResumePosition };
      }

      const item = inheritWorkList[itemIdx];
      const itemLabel = item.kind === "link" ? `link(${item.toDocId.slice(0, 8)}:${item.toLocator ?? "null"})` : `fallback(${item.fileName.slice(0, 40)})`;

      let context = "";
      let linkedValue: number | null = null;
      let linkedLabel: string | null = null;
      let docId: string;
      let originLocator: string;
      let relianceLinkId: string | null;

      if (item.kind === "link") {
        docId = item.toDocId; originLocator = item.toLocator ?? ""; relianceLinkId = item.minLinkId;
        linkedValue = item.toValue != null && isFinite(item.toValue) ? item.toValue : null;
        linkedLabel = item.toLabel;
        const parsed = item.toLocator ? parseA1(item.toLocator) : null;
        if (parsed) {
          const loadedSheet = await loadSheetByName(db, item.toDocId, parsed.sheet);
          if (loadedSheet) {
            const data = loadedSheet.data as { cells?: ParsedCell[] };
            const cells = data?.cells ?? [];
            if (cells.length > 0) context = buildNeighbourhood(cells, parsed.row, parsed.col);
          }
        }
        if (context.length === 0) context = await retrieveTextContext(db, item.toDocId, linkedValue);
      } else {
        docId = item.docId; originLocator = item.fileName; relianceLinkId = null;
        context = await retrieveTextContext(db, item.docId, null);
      }

      if (context.length === 0) { inherit_itemsNoContext++; itemIdx++; continue; }

      const userPrompt = buildInheritUserPrompt(context, linkedValue, linkedLabel);
      let judgments: Array<{ judgment: string; quote: string }> = [];
      let attempts = 0; const MAX_ATTEMPTS = 2;
      let lastWasErr = false, lastWasParse = false, lastWasTrunc = false;
      let itemCallErrors = 0, itemParseErrors = 0, itemWasTruncated = false, itemParsedOk = false;

      while (attempts < MAX_ATTEMPTS) {
        if (attempts > 0 && !lastWasErr && !lastWasParse && !lastWasTrunc) break;
        attempts++; lastWasErr = false; lastWasParse = false; lastWasTrunc = false;
        try {
          const llmResp = await ai.apiRequest(
            { method: "POST", path: "/v1/messages", body: { model, max_tokens: MAX_OUTPUT_TOKENS, system: INHERIT_SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] } },
            { response: MessageResponseSchema },
            { label: `${LOG_PREFIX} inherit item ${itemIdx} attempt ${attempts}` },
          );
          inherit_totalInputTokens += llmResp.usage.input_tokens;
          inherit_totalOutputTokens += llmResp.usage.output_tokens;
          if (llmResp.stop_reason === "max_tokens") { lastWasTrunc = true; itemWasTruncated = true; }
          const text = llmResp.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          try {
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) { lastWasParse = true; itemParseErrors++; continue; }
            judgments = parsed.filter((el: any) => el && typeof el === "object" && typeof el.judgment === "string" && typeof el.quote === "string");
            itemParsedOk = true; break;
          } catch { lastWasParse = true; itemParseErrors++; continue; }
        } catch (e) { lastWasErr = true; itemCallErrors++; continue; }
      }

      if (itemCallErrors >= attempts) inherit_itemsAllCallsFailed++;
      else if (itemParseErrors >= attempts) inherit_itemsAllParsesFailed++;
      if (itemWasTruncated) inherit_itemsTruncated++;

      if (judgments.length > JUDGMENTS_PER_ITEM_CAP) judgments = judgments.slice(0, JUDGMENTS_PER_ITEM_CAP);

      const normalizedContext = normalize(context);
      const acceptedJ: Array<{ judgment: string; quote: string }> = [];

      for (const j of judgments) {
        if (!j.judgment || j.judgment.trim().length === 0) { inherit_rejectEmptyJudgment++; continue; }
        if (j.judgment.trim().split(/\s+/).length < 4) { inherit_rejectShortJudgment++; continue; }
        if (!j.quote || j.quote.trim().length === 0) { inherit_rejectEmptyQuote++; continue; }
        if (j.quote.trim().split(/\s+/).length < 6) { inherit_rejectShortQuote++; continue; }
        if (!normalizedContext.includes(normalize(j.quote))) { inherit_rejectQuoteNotFound++; continue; }
        acceptedJ.push(j);
      }

      if (itemParsedOk) {
        for (const j of acceptedJ) {
          const insertedRows = await db.query(
            `INSERT INTO mast_assumptions (run_id, deal_id, proposition, origin_type, origin_doc_id, origin_locator, verbatim, quantified, value, unit, period, detector, reliance_link_id, recursion_depth)
             VALUES ($1::uuid, $2::uuid, $3, 'inherited', $4::uuid, $5, $6, false, NULL, NULL, NULL, NULL, $7, 1) RETURNING id`,
            z.object({ id: z.string() }),
            [runId, dealId, j.judgment, docId, originLocator, j.quote, relianceLinkId],
            { label: `${LOG_PREFIX} insert inherited judgment` },
          );
          if (insertedRows.length > 0) {
            await db.execute(`UPDATE mast_assumptions SET dedup_group_id = id WHERE id = $1::uuid`, [insertedRows[0].id], { label: `${LOG_PREFIX} set dedup_group_id for inherited` });
          }
        }
      }

      inherit_totalAccepted += acceptedJ.length;
      itemIdx++;
    }

    console.log(`${LOG_PREFIX} Phase 2 complete: ${inherit_totalAccepted} inherited judgments.`);
    phase = "search"; phaseCursor = 0;
    nextResumePosition++;
    await persistPayload(db, runId, buildPayload());
  }

  // ====================================================================
  // PHASE 3: SEARCH
  // ====================================================================
  if (phase === "search") {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      await persistPayload(db, runId, buildPayload());
      return { complete: false, itemsDone: 0, itemsTotal: 1, resumePosition: nextResumePosition };
    }

    console.log(`${LOG_PREFIX} Phase 3 (search): starting at cursor ${phaseCursor}`);

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
            console.log(`${LOG_PREFIX} Phase 3 budget exceeded at batch ${globalBatch}/${totalBatches}.`);
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

          while (attempts < 2) {
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

              try {
                const parsed = JSON.parse(responseText);
                if (!Array.isArray(parsed)) { lastWasParse = true; continue; }

                const hits: RawHit[] = parsed.filter(
                  (el: any) => el && typeof el === "object" && typeof el.chunk === "number" && typeof el.index === "number" && typeof el.quote === "string" && typeof el.kind === "string",
                );

                // Process hits through gate
                for (const hit of hits) {
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
                       statement_type, confidence, relation
                     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULL, $7)`,
                    [runId, assumptionId, sourceChunk.document_id,
                     `${sourceChunk.file_name}:chunk_${sourceChunk.chunk_index}`,
                     hit.quote, kind, relation],
                    { label: `${LOG_PREFIX} insert evidence` },
                  );
                }

                break; // success
              } catch { lastWasParse = true; search_batchesParseFailed++; continue; }
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

      console.log(`${LOG_PREFIX} Phase 3 complete: ${search_hitsPassedGate} hits passed gate, ${search_chunksProcessed} chunks processed.`);
      phase = "recurse"; phaseCursor = 0;
      nextResumePosition++;
      const payload = buildPayload();
      if (distinctHitFinal !== undefined) (payload as any).search_distinctAssumptionsHit = distinctHitFinal;
      await persistPayload(db, runId, payload);
    }
  }

  // ====================================================================
  // PHASE 4: RECURSE
  // ====================================================================
  if (phase === "recurse") {
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      await persistPayload(db, runId, buildPayload());
      return { complete: false, itemsDone: 0, itemsTotal: 1, resumePosition: nextResumePosition };
    }

    console.log(`${LOG_PREFIX} Phase 4 (recurse): starting at cursor ${phaseCursor}`);

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
      console.log(`${LOG_PREFIX} No forecast evidence. Phase 4 complete.`);
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
          console.log(`${LOG_PREFIX} Phase 4 budget exceeded at group ${groupIdx}/${groups.length}.`);
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

      console.log(`${LOG_PREFIX} Phase 4 complete: ${recurse_rowsWritten} written, ${recurse_skippedByModel} skipped.`);
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

const MAX_ATTEMPTS = 2;

export default sweep;
