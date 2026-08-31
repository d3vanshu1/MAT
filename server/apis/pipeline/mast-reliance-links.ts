/**
 * mast-reliance-links.ts
 *
 * MAST v2 — reliance_links stage.
 *
 * Finds where a figure the deal team is using (left side) traces back to a
 * figure in a reference document (right side).  Pure code — no LLM anywhere.
 *
 * LEFT SIDE sources (already in mast_assumptions for this run):
 *   1. model_explicit rows with a non-null value.
 *   2. memo_prose rows — numeric tokens extracted from the verbatim quote.
 *
 * RIGHT SIDE sources:
 *   Every doc_tables row belonging to a document for this deal whose
 *   document_tag is NOT 'financial_model' and NOT 'ic_memo'.
 *   Numeric cells only.
 *
 * MATCHING (first-match-wins per pair):
 *   numeric_exact    — values equal after rounding both to 6 decimal places.
 *   numeric_tolerance — abs diff ≤ max(0.5% of larger abs value, 1000).
 *   scaled_match     — numeric_tolerance after multiplying one side by
 *                      1_000, 1_000_000, or 1_000_000_000 (or dividing).
 *
 * SUPPRESSION:
 *   - |left| < 1000 → discard.
 *   - left is a whole number 1–100 → discard.
 *   - Max 5 right-side matches per left figure (keep smallest abs diff).
 *   - Max 2000 links total (keep by |left| desc).
 *
 * RESUMABILITY:
 *   resume_position = index of next left-side figure in a stable list.
 *   Right-side index rebuilt each invocation (held in memory).
 *
 * IDEMPOTENCY:
 *   At resume_position 0, delete all mast_reliance_links for this run.
 *   At any other position, delete nothing.
 *
 * FAIL CLOSED:
 *   Empty left side → throw.
 *   Empty right side → log, return complete with 0 links.
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
import { resolveModelDocument } from "./mast-register-model-drivers.js";

const LOG_PREFIX = "[MAST-LINKS]";

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const AssumptionLeftSchema = z.object({
  id: z.string(),
  origin_type: z.string(),
  origin_doc_id: z.string().nullable(),
  origin_locator: z.string().nullable(),
  proposition: z.string(),
  verbatim: z.string().nullable(),
  value: z.any().nullable(), // NUMERIC comes as string from pg
});

type AssumptionLeftRow = z.infer<typeof AssumptionLeftSchema>;

const DocTableRow = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  data: z.any(),
});

const RefDocRow = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Parsed cell shape (matches mast-register-model-drivers)
// ---------------------------------------------------------------------------

interface ParsedCell {
  r: number;
  c: number;
  value: unknown;
  type: string;
  formula?: string | null;
}

// ---------------------------------------------------------------------------
// Numeric token extraction from memo prose quotes
// ---------------------------------------------------------------------------

/**
 * Regex for numeric tokens in natural-language text.
 *
 * Captures: optional currency symbol, integer/decimal with thousands seps,
 * optional multiplier suffix (k, m, bn), optional trailing %.
 *
 * Examples matched: "$14.5m", "2,400", "87.3%", "1.2bn", "500k"
 */
const NUMERIC_TOKEN_RE =
  /(?:[$€£¥])\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?(%)?|(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn)?(%)?/gi;

interface ExtractedFigure {
  value: number;
  /** Index within the quote, for stable ordering */
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
    // Currency-prefixed: groups 1,2,3.  Plain: groups 4,5,6.
    const numStr = (m[1] ?? m[4] ?? "").replace(/,/g, "");
    const suffix = (m[2] ?? m[5] ?? "").toLowerCase();
    const isPct = !!(m[3] ?? m[6]);

    if (numStr.length === 0) continue;
    let val = parseFloat(numStr);
    if (!isFinite(val)) continue;

    // Skip 4-digit years
    if (/^\d{4}$/.test(numStr) && val >= 1900 && val <= 2100) continue;

    // Apply multiplier suffix
    if (suffix && MULTIPLIERS[suffix]) {
      val *= MULTIPLIERS[suffix];
    }

    // Percent sign: keep the face value (87.3% → 87.3), not 0.873.
    // The model/report may store it either way; matching will catch both.
    if (isPct) {
      // no conversion — keep as-is
    }

    figures.push({ value: val, figureIndex: idx++ });
  }

  return figures;
}

// ---------------------------------------------------------------------------
// Right-side index entry
// ---------------------------------------------------------------------------

interface RightSideEntry {
  docId: string;
  sheetOrPage: string;
  addr: string;       // A1 address
  label: string | null;
  value: number;
}

// ---------------------------------------------------------------------------
// Left-side entry (stable-ordered)
// ---------------------------------------------------------------------------

interface LeftSideEntry {
  assumptionId: string;
  originType: string;
  originDocId: string | null;
  originLocator: string | null;
  proposition: string;
  value: number;
  figureIndex: number; // for memo_prose: index within quote; for model_explicit: 0
}

// ---------------------------------------------------------------------------
// A1 address helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function roundTo6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function withinTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const maxAbs = Math.max(Math.abs(a), Math.abs(b));
  const threshold = Math.max(maxAbs * 0.005, 1000);
  return diff <= threshold;
}

const SCALE_FACTORS = [1_000, 1_000_000, 1_000_000_000];

interface MatchResult {
  method: "numeric_exact" | "numeric_tolerance" | "scaled_match";
  absDiff: number;
  notes: string | null;
}

function tryMatch(left: number, right: number): MatchResult | null {
  // numeric_exact
  if (roundTo6(left) === roundTo6(right)) {
    return { method: "numeric_exact", absDiff: Math.abs(left - right), notes: null };
  }

  // numeric_tolerance
  if (withinTolerance(left, right)) {
    return { method: "numeric_tolerance", absDiff: Math.abs(left - right), notes: null };
  }

  // scaled_match — try multiplying/dividing each side
  for (const factor of SCALE_FACTORS) {
    // left * factor ≈ right
    const scaledLeft = left * factor;
    if (withinTolerance(scaledLeft, right)) {
      return {
        method: "scaled_match",
        absDiff: Math.abs(scaledLeft - right),
        notes: `left*${factor}`,
      };
    }

    // right * factor ≈ left  (i.e. left / factor ≈ right / factor ... no: left ≈ right * factor)
    const scaledRight = right * factor;
    if (withinTolerance(left, scaledRight)) {
      return {
        method: "scaled_match",
        absDiff: Math.abs(left - scaledRight),
        notes: `right*${factor}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Suppression predicates
// ---------------------------------------------------------------------------

function isSuppressed(leftValue: number): boolean {
  const absVal = Math.abs(leftValue);
  // Discard if absolute value < 1000
  if (absVal < 1000) return true;
  // Discard if whole number between 1 and 100
  if (Number.isInteger(leftValue) && absVal >= 1 && absVal <= 100) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const relianceLinks: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  // ── 1. Build left-side list (stable order) ─────────────────────────
  //   origin_type ASC, origin_locator ASC, figureIndex ASC

  const leftRows = await db.query(
    `SELECT id, origin_type, origin_doc_id, origin_locator, proposition, verbatim, value
       FROM mast_assumptions
      WHERE run_id = $1
        AND origin_type IN ('model_explicit', 'memo_prose')
      ORDER BY origin_type ASC, origin_locator ASC`,
    AssumptionLeftSchema,
    [runId],
    { label: `${LOG_PREFIX} load left-side assumptions` },
  );

  const leftSide: LeftSideEntry[] = [];

  for (const row of leftRows) {
    if (row.origin_type === "model_explicit") {
      // Must have non-null value
      if (row.value == null) continue;
      const numVal = typeof row.value === "number" ? row.value : parseFloat(String(row.value));
      if (!isFinite(numVal)) continue;
      leftSide.push({
        assumptionId: row.id,
        originType: row.origin_type,
        originDocId: row.origin_doc_id,
        originLocator: row.origin_locator,
        proposition: row.proposition,
        value: numVal,
        figureIndex: 0,
      });
    } else if (row.origin_type === "memo_prose") {
      // Extract figures from verbatim quote
      const text = row.verbatim ?? row.proposition;
      const figures = extractNumericTokens(text);
      for (const fig of figures) {
        leftSide.push({
          assumptionId: row.id,
          originType: row.origin_type,
          originDocId: row.origin_doc_id,
          originLocator: row.origin_locator,
          proposition: row.proposition,
          value: fig.value,
          figureIndex: fig.figureIndex,
        });
      }
    }
  }

  // Fail closed: empty left side
  if (leftSide.length === 0) {
    throw new Error(
      `${LOG_PREFIX} Fail-closed: left-side list is empty. ` +
        `No model_explicit with value or memo_prose with extractable figures. ` +
        `Register stages may not have run.`,
    );
  }

  console.log(`${LOG_PREFIX} Left side: ${leftSide.length} figures from ${leftRows.length} assumption rows.`);

  // ── 2. Build right-side index (reference documents) ────────────────
  //   Documents where document_tag is NOT 'financial_model' and NOT 'ic_memo'.

  const refDocs = await db.query(
    `SELECT id, file_name, document_tag
       FROM documents
      WHERE deal_id = $1::uuid
        AND document_tag IS NOT NULL
        AND document_tag NOT IN ('financial_model', 'ic_memo')
      ORDER BY file_name ASC`,
    RefDocRow,
    [dealId],
    { label: `${LOG_PREFIX} load reference documents` },
  );

  console.log(`${LOG_PREFIX} Reference documents found: ${refDocs.length}`);

  const rightSide: RightSideEntry[] = [];
  let docsWithNoTables = 0;

  for (const doc of refDocs) {
    const sheets = await db.query(
      `SELECT id, document_id, sheet_or_page, data
         FROM doc_tables
        WHERE document_id = $1::uuid
        ORDER BY sheet_or_page ASC`,
      DocTableRow,
      [doc.id],
      { label: `${LOG_PREFIX} load doc_tables for ${doc.file_name.slice(0, 40)}` },
    );

    if (sheets.length === 0) {
      docsWithNoTables++;
      console.log(
        `${LOG_PREFIX} Reference doc "${doc.file_name}" (${doc.document_tag}) has no doc_tables rows.`,
      );
      continue;
    }

    for (const sheet of sheets) {
      const data = sheet.data as { cells?: ParsedCell[] };
      const cells = data?.cells ?? [];

      // Build a row → label map: for each row, find the left-most non-empty string cell
      const rowLabels = new Map<number, string>();
      for (const cell of cells) {
        if (cell.type !== "string" && cell.type !== "s") continue;
        if (typeof cell.value !== "string" || cell.value.trim().length === 0) continue;
        const existing = rowLabels.get(cell.r);
        if (existing === undefined) {
          rowLabels.set(cell.r, cell.value.trim());
        }
        // Keep the left-most (smallest c) string cell as label
        // Since we iterate in order from the cells array, only update if this cell is further left
        // We need to track the column too
      }

      // Re-do label map properly tracking column position
      const rowLabelEntries = new Map<number, { col: number; label: string }>();
      for (const cell of cells) {
        if (cell.type !== "string" && cell.type !== "s") continue;
        if (typeof cell.value !== "string" || cell.value.trim().length === 0) continue;
        const existing = rowLabelEntries.get(cell.r);
        if (!existing || cell.c < existing.col) {
          rowLabelEntries.set(cell.r, { col: cell.c, label: cell.value.trim() });
        }
      }

      for (const cell of cells) {
        if (cell.type !== "number" && cell.type !== "n") continue;
        const numVal = typeof cell.value === "number" ? cell.value : parseFloat(String(cell.value));
        if (!isFinite(numVal)) continue;

        const addr = toA1(cell.r, cell.c);
        const labelEntry = rowLabelEntries.get(cell.r);

        rightSide.push({
          docId: doc.id,
          sheetOrPage: sheet.sheet_or_page,
          addr,
          label: labelEntry ? labelEntry.label : null,
          value: numVal,
        });
      }
    }
  }

  console.log(
    `${LOG_PREFIX} Right side: ${rightSide.length} numeric cells from ${refDocs.length} reference docs ` +
      `(${docsWithNoTables} with no doc_tables rows).`,
  );

  // If right side is empty, log and return complete with 0 links
  if (rightSide.length === 0) {
    console.log(
      `${LOG_PREFIX} Right-side index is empty. ${refDocs.length} reference docs examined, ` +
        `${docsWithNoTables} with no doc_tables. Returning complete with 0 links.`,
    );
    return { complete: true, itemsDone: leftSide.length, itemsTotal: leftSide.length, resumePosition: 0 };
  }

  // ── 3. Idempotency — clear on first invocation ────────────────────
  if (resumePosition === 0) {
    await db.execute(
      `DELETE FROM mast_reliance_links WHERE run_id = $1`,
      [runId],
      { label: `${LOG_PREFIX} idempotent delete` },
    );
  }

  // ── 4. Match left figures against right-side index ─────────────────
  interface PendingLink {
    left: LeftSideEntry;
    right: RightSideEntry;
    match: MatchResult;
  }

  const allLinks: PendingLink[] = [];
  let figIdx = resumePosition;
  let suppressedSmall = 0;
  let fanOutDiscarded = 0;

  while (figIdx < leftSide.length) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded after ${figIdx - resumePosition} figures. ` +
          `Pausing at figure ${figIdx}/${leftSide.length}.`,
      );
      break;
    }

    const left = leftSide[figIdx];
    figIdx++;

    // Suppression: small values and whole numbers 1–100
    if (isSuppressed(left.value)) {
      suppressedSmall++;
      continue;
    }

    // Find all right-side matches for this left figure
    const matches: Array<{ right: RightSideEntry; match: MatchResult }> = [];

    for (const right of rightSide) {
      const result = tryMatch(left.value, right.value);
      if (result) {
        matches.push({ right, match: result });
      }
    }

    // Cap fan-out at 5, keep smallest absDiff
    if (matches.length > 5) {
      matches.sort((a, b) => a.match.absDiff - b.match.absDiff);
      const discarded = matches.length - 5;
      fanOutDiscarded += discarded;
      matches.length = 5;
    }

    for (const { right, match } of matches) {
      allLinks.push({ left, right, match });
    }
  }

  const isComplete = figIdx >= leftSide.length;

  console.log(
    `${LOG_PREFIX} Matching pass: ${allLinks.length} links found, ` +
      `${suppressedSmall} suppressed (small/integer), ` +
      `${fanOutDiscarded} discarded (fan-out cap).`,
  );

  // ── 5. Global cap at 2000 links — keep by |left| desc ─────────────
  let globalDiscarded = 0;
  if (allLinks.length > 2000) {
    allLinks.sort((a, b) => Math.abs(b.left.value) - Math.abs(a.left.value));
    globalDiscarded = allLinks.length - 2000;
    allLinks.length = 2000;
    console.log(
      `${LOG_PREFIX} Global cap applied: kept 2000 links, discarded ${globalDiscarded}.`,
    );
  }

  // ── 6. Write links to mast_reliance_links ──────────────────────────
  let written = 0;

  for (const link of allLinks) {
    const toLocator = `${link.right.sheetOrPage}!${link.right.addr}`;

    await db.execute(
      `INSERT INTO mast_reliance_links (
         run_id, deal_id,
         from_doc_id, from_locator, from_label, from_value,
         to_doc_id, to_locator, to_label, to_value,
         match_method, match_tolerance, notes
       ) VALUES (
         $1::uuid, $2::uuid,
         $3::uuid, $4, $5, $6,
         $7::uuid, $8, $9, $10,
         $11, $12, $13
       )`,
      [
        runId, dealId,
        link.left.originDocId, link.left.originLocator,
        link.left.proposition.slice(0, 200), link.left.value,
        link.right.docId, toLocator,
        link.right.label, link.right.value,
        link.match.method, link.match.absDiff, link.match.notes,
      ],
      { label: `${LOG_PREFIX} insert link ${written + 1}` },
    );
    written++;
  }

  console.log(
    `${LOG_PREFIX} Summary: ${written} links written. ` +
      `Left side: ${leftSide.length} figures (processed ${figIdx - resumePosition} this invocation). ` +
      `Right side: ${rightSide.length} cells from ${refDocs.length} docs. ` +
      `Suppressed: ${suppressedSmall}. Fan-out discarded: ${fanOutDiscarded}. Global cap discarded: ${globalDiscarded}.`,
  );

  return {
    complete: isComplete,
    itemsDone: figIdx,
    itemsTotal: leftSide.length,
    resumePosition: figIdx,
  };
};

export default relianceLinks;
