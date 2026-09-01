/**
 * mast-register-model-drivers.ts
 *
 * Stage handler for register_model_drivers.
 *
 * Reads the deal team financial model out of doc_tables and writes one
 * mast_assumptions row per driver cell.  A driver is a numeric constant
 * on an input sheet — a sheet with moderate numeric density and forward-
 * looking values — that has a non-empty row label.
 *
 * Pure code. No LLM anywhere.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { loadAllSheets } from "./mast-doc-tables.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-DRIVERS]";

const MODULE_ID = "mast_v2";
const ADJUDICATION_BATCH_SIZE = 40;
const MAX_OUTPUT_TOKENS = 4096;

// Label values that are not real labels (case-insensitive exact match after trim)
const LABEL_BLACKLIST = new Set(["n.a.", "na", "n/a", "nm", "n.m.", "tbd"]);

// ---------------------------------------------------------------------------
// Date detection for label resolution (FIX 1)
// ---------------------------------------------------------------------------

/**
 * Returns true when a trimmed string value looks like a date rather than
 * a meaningful label.  Used by the walk-left label resolver to skip past
 * date cells that sit between the driver value and the real label.
 */
export function looksLikeDateString(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;
  // Month-year: "Jan-24", "January 2024", "Feb 2025", "Mar-2024"
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-\/]?\d{2,4}$/i.test(t)) return true;
  // Date with slashes or dashes: "1/15/2024", "2024-01-15", "15-01-2024"
  if (/^\d{1,4}[\-\/]\d{1,2}[\-\/]\d{1,4}$/.test(t)) return true;
  // Quarter: "Q1 2024", "1Q24", "Q1'24"
  if (/^[Qq]\d[\s\-']?\d{2,4}$/.test(t) || /^\d[Qq][\s\-']?\d{2,4}$/.test(t)) return true;
  // FY/CY/HY: "FY2024", "CY2024", "FY 2024"
  if (/^(?:FY|CY|HY)\s?\d{2,4}$/i.test(t)) return true;
  // Year-month: "2024-01", "2024/01"
  if (/^\d{4}[\-\/]\d{1,2}$/.test(t)) return true;
  // Month only: "January", "Feb", "September"
  if (/^(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)$/i.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Toggle keyword set for zero-value exception (FIX 2)
// ---------------------------------------------------------------------------

const TOGGLE_KEYWORDS = [
  "toggle", "switch", "flag", "on off", "on/off",
  "enable", "disable", "include", "exclude",
  "sensitivity", "scenario", "case",
];

/** Strip parens, percent signs, commas, currency symbols, and spaces, then
 *  test whether what remains parses as a finite number. */
function labelIsNumeric(label: string): boolean {
  const stripped = label.replace(/[()%,$ £€¥\s]/g, "");
  if (stripped.length === 0) return true;
  return Number.isFinite(Number(stripped));
}

/** True if the label consists solely of punctuation (no alphanumeric). */
function labelIsPunctuation(label: string): boolean {
  return !/[a-zA-Z0-9]/.test(label);
}

// Anthropic response schema (matches mast-register-memo pattern)
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

const DocTableRow = z.object({
  id: z.string(),
  sheet_or_page: z.string(),
  data: z.any(),
});

const ModelDocRow = z.object({
  id: z.string(),
  file_name: z.string(),
  table_count: z.coerce.number(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
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

/** A1 address from 0-based row/col. */
function toA1(row: number, col: number): string {
  return `${indexToCol(col + 1)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// resolveNumeric — coerce string cells that are actually numbers
// ---------------------------------------------------------------------------

/**
 * Return a numeric value from a cell, or null if the cell is not numeric.
 * Handles native numbers and string cells whose trimmed value, after stripping
 * commas, currency symbols, and surrounding parentheses, parses as finite.
 * A trailing percent sign divides the result by 100.
 * Parenthesised values are negative (accounting convention).
 */
export function resolveNumeric(
  cell: ParsedCell,
): number | null {
  if (cell.type === "number" && typeof cell.value === "number") {
    return cell.value;
  }
  if (cell.type === "string" && cell.value != null) {
    let s = String(cell.value).trim();
    if (s.length === 0) return null;

    // Detect negative accounting notation: (123) → -123
    let isNeg = false;
    if (s.startsWith("(") && s.endsWith(")")) {
      isNeg = true;
      s = s.slice(1, -1).trim();
    }

    // Strip commas and currency symbols
    s = s.replace(/[,$ £€¥]/g, "");

    // Detect trailing percent sign
    let pct = false;
    if (s.endsWith("%")) {
      pct = true;
      s = s.slice(0, -1).trim();
    }

    if (s.length === 0) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;

    let result = isNeg ? -Math.abs(n) : n;
    if (pct) result /= 100;
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Period header detection
// ---------------------------------------------------------------------------

export interface ParsedCell {
  r: number;
  c: number;
  value: unknown;
  type: string;
  formula?: string | null;
}

/**
 * Detect period header rows: scan the first 6 rows for rows where >50%
 * of non-empty cells parse as a 4-digit year (2000–2100) or a date.
 * Returns a Map from row index to an array of string period values by column.
 */
export function detectPeriodHeaderRows(
  cells: ParsedCell[],
): Map<number, Map<number, string>> {
  // Group cells by row for the first 6 rows
  const rowMap = new Map<number, ParsedCell[]>();
  for (const cell of cells) {
    if (cell.r > 5) continue; // only first 6 rows (0-indexed)
    let arr = rowMap.get(cell.r);
    if (!arr) {
      arr = [];
      rowMap.set(cell.r, arr);
    }
    arr.push(cell);
  }

  const headerRows = new Map<number, Map<number, string>>();

  for (const [rowIdx, rowCells] of rowMap) {
    const nonEmpty = rowCells.filter(
      (c) => c.type !== "empty" && c.value !== null && c.value !== "",
    );
    if (nonEmpty.length === 0) continue;

    let dateOrYearCount = 0;
    for (const c of nonEmpty) {
      if (c.type === "date") {
        dateOrYearCount++;
        continue;
      }
      const str = String(c.value).trim();
      const num = Number(str);
      if (Number.isInteger(num) && num >= 2000 && num <= 2100) {
        dateOrYearCount++;
        continue;
      }
      // Try parsing as date
      if (!isNaN(Date.parse(str)) && /\d{4}/.test(str)) {
        dateOrYearCount++;
      }
    }

    if (dateOrYearCount > nonEmpty.length / 2) {
      const colMap = new Map<number, string>();
      for (const c of nonEmpty) {
        colMap.set(c.c, String(c.value));
      }
      headerRows.set(rowIdx, colMap);
    }
  }

  return headerRows;
}

// ---------------------------------------------------------------------------
// selectPeriodRow — pick one header row from the map returned by
// detectPeriodHeaderRows.  Prefer the row whose values parse
// predominantly as 4-digit years (2000-2100) over one whose values
// parse as dates.  Tie-break: lowest row index.
// ---------------------------------------------------------------------------

export function selectPeriodRow(
  headerRows: Map<number, Map<number, string>>,
): Map<number, string> | null {
  if (headerRows.size === 0) return null;
  if (headerRows.size === 1) {
    return headerRows.values().next().value ?? null;
  }

  let bestRow: number | null = null;
  let bestYearFraction = -1;

  for (const [rowIdx, colMap] of headerRows) {
    let yearCount = 0;
    let total = 0;
    for (const val of colMap.values()) {
      total++;
      const num = Number(val);
      if (Number.isInteger(num) && num >= 2000 && num <= 2100) {
        yearCount++;
      }
    }
    const yearFraction = total > 0 ? yearCount / total : 0;
    if (
      yearFraction > bestYearFraction ||
      (yearFraction === bestYearFraction && (bestRow === null || rowIdx < bestRow))
    ) {
      bestYearFraction = yearFraction;
      bestRow = rowIdx;
    }
  }

  if (bestRow === null) return null;
  return headerRows.get(bestRow) ?? null;
}

// ---------------------------------------------------------------------------
// classifySheet — structural classification of a loaded sheet
// ---------------------------------------------------------------------------

/** Set of lowercased tokens that classify a column as actual. */
const ACTUAL_TOKENS = new Set(["actual", "act"]);
const FORECAST_TOKENS = new Set(["forecast", "budget", "plan", "fcst"]);

export interface SheetClassification {
  totalNonEmptyCells: number;
  numericCells: number;
  numericDensity: number;
  hasForwardValues: boolean;
  isInputSheet: boolean;
}

export function classifySheet(
  sheet: { sheet_or_page: string; data: any },
  selectedPeriodRow: Map<number, string> | null,
): SheetClassification {
  const data = sheet.data as { cells?: ParsedCell[] };
  const cells = data?.cells ?? [];

  let totalNonEmptyCells = 0;
  let numericCells = 0;

  for (const cell of cells) {
    if (cell.type === "empty" || cell.value === null || cell.value === "") continue;
    totalNonEmptyCells++;
    if (resolveNumeric(cell) !== null) {
      numericCells++;
    }
  }

  const numericDensity = totalNonEmptyCells > 0 ? numericCells / totalNonEmptyCells : 0;

  // ── Forward-value detection ────────────────────────────────────────
  // Find maximum actual year via actual/forecast classification row
  let maxActualYear = -1;
  let hasActualForecastRow = false;

  if (selectedPeriodRow !== null) {
    // Scan first 6 rows for actual/forecast classification row
    const rowMap = new Map<number, ParsedCell[]>();
    for (const cell of cells) {
      if (cell.r > 5) continue;
      let arr = rowMap.get(cell.r);
      if (!arr) {
        arr = [];
        rowMap.set(cell.r, arr);
      }
      arr.push(cell);
    }

    for (const [_rowIdx, rowCells] of rowMap) {
      const nonEmpty = rowCells.filter(
        (c) => c.type !== "empty" && c.value !== null && c.value !== "",
      );
      if (nonEmpty.length === 0) continue;

      let matchCount = 0;
      for (const c of nonEmpty) {
        const tok = String(c.value).trim().toLowerCase();
        if (ACTUAL_TOKENS.has(tok) || FORECAST_TOKENS.has(tok)) {
          matchCount++;
        }
      }

      if (matchCount > nonEmpty.length / 2) {
        hasActualForecastRow = true;
        // Identify actual columns and their max year
        for (const c of nonEmpty) {
          const tok = String(c.value).trim().toLowerCase();
          if (ACTUAL_TOKENS.has(tok)) {
            // Find the year value for this column from the period row
            const periodVal = selectedPeriodRow.get(c.c);
            if (periodVal !== undefined) {
              const yr = Number(periodVal);
              if (Number.isInteger(yr) && yr >= 2000 && yr <= 2100 && yr > maxActualYear) {
                maxActualYear = yr;
              }
            }
          }
        }
        break;
      }
    }
  }

  // Count numeric cells in forward columns
  let forwardNumericCount = 0;

  if (selectedPeriodRow !== null) {
    // Build set of forward columns
    const forwardCols = new Set<number>();
    for (const [col, val] of selectedPeriodRow) {
      const yr = Number(val);
      if (Number.isInteger(yr) && yr >= 2000 && yr <= 2100) {
        if (hasActualForecastRow) {
          // Only columns whose year > maxActualYear are forward
          if (yr > maxActualYear) {
            forwardCols.add(col);
          }
        } else {
          // No actual/forecast row — all period columns count
          forwardCols.add(col);
        }
      }
    }

    for (const cell of cells) {
      if (resolveNumeric(cell) === null) continue;
      if (forwardCols.has(cell.c)) {
        forwardNumericCount++;
      }
    }
  }

  const hasForwardValues = forwardNumericCount >= 5;

  const isInputSheet =
    numericDensity < 0.35 &&
    numericCells >= 20 &&
    hasForwardValues;

  return {
    totalNonEmptyCells,
    numericCells,
    numericDensity,
    hasForwardValues,
    isInputSheet,
  };
}

// ---------------------------------------------------------------------------
// resolveModelDocument — find the financial_model document with the
// most sheets, breaking ties by most recent upload.
// ---------------------------------------------------------------------------

export async function resolveModelDocument(
  db: any,
  dealId: string,
): Promise<z.infer<typeof ModelDocRow> | null> {
  const modelDocs = await db.query(
    `SELECT d.id, d.file_name, COUNT(dt.id)::int AS table_count, d.uploaded_at::text AS created_at
     FROM documents d
     JOIN doc_tables dt ON dt.document_id = d.id
     WHERE d.deal_id = $1::uuid
       AND d.document_tag = 'financial_model'
     GROUP BY d.id, d.file_name, d.uploaded_at
     ORDER BY COUNT(dt.id) DESC, d.uploaded_at DESC
     LIMIT 1`,
    ModelDocRow,
    [dealId],
    { label: "MAST: resolve financial model document" },
  );

  if (modelDocs.length === 0) {
    console.log(`${LOG_PREFIX} No financial_model document found for deal ${dealId}.`);
    return null;
  }

  const modelDoc = modelDocs[0];
  console.log(
    `${LOG_PREFIX} Chosen model document: ${modelDoc.file_name} (id=${modelDoc.id}, ${modelDoc.table_count} sheets)`,
  );
  return modelDoc;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const DRIVER_CAP = 2000;

const registerModelDrivers: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  // ── 1. Resolve the model document ──────────────────────────────────
  const modelDoc = await resolveModelDocument(db, dealId);

  if (modelDoc === null) {
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 2. Load all sheets for the document (one per query) ────────────
  const { sheets: allSheets, skipped } = await loadAllSheets(db, modelDoc.id);

  if (skipped > 0) {
    console.log(`${LOG_PREFIX} ${skipped} sheet(s) skipped due to size limit.`);
  }

  if (allSheets.length === 0) {
    console.log(`${LOG_PREFIX} No sheets found. Stage complete.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 3. Classify sheets ─────────────────────────────────────────────
  // Build a shared period row for each sheet, then classify
  const sheetClassifications = new Map<string, SheetClassification>();
  for (const sheet of allSheets) {
    const data = sheet.data as { cells?: ParsedCell[] };
    const cells = data?.cells ?? [];
    const periodHeaders = detectPeriodHeaderRows(cells);
    const periodRow = selectPeriodRow(periodHeaders);
    const classification = classifySheet(sheet, periodRow);
    sheetClassifications.set(sheet.sheet_or_page, classification);

    console.log(
      `${LOG_PREFIX} Sheet "${sheet.sheet_or_page}": ` +
      `totalNonEmpty=${classification.totalNonEmptyCells}, ` +
      `numeric=${classification.numericCells}, ` +
      `density=${classification.numericDensity.toFixed(2)}, ` +
      `hasForward=${classification.hasForwardValues}, ` +
      `isInput=${classification.isInputSheet}`,
    );
  }

  // ── 4. Process sheets with resume support ──────────────────────────
  const totalSheets = allSheets.length;
  let sheetIdx = resumePosition;
  let totalDriversWritten = 0;
  const sheetSummaries: Array<Record<string, unknown>> = [];

  while (sheetIdx < totalSheets) {
    // Budget check
    if (Date.now() - startTime > STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} Budget exceeded after ${sheetIdx - resumePosition} sheets. Pausing at sheet ${sheetIdx}/${totalSheets}.`,
      );
      return {
        complete: false,
        itemsDone: sheetIdx,
        itemsTotal: totalSheets,
        resumePosition: sheetIdx,
      };
    }

    const sheet = allSheets[sheetIdx];
    const sheetName = sheet.sheet_or_page;
    const data = sheet.data as {
      cells?: ParsedCell[];
      row_headers?: string[];
    };
    const cells = data?.cells ?? [];
    const rowHeaders = data?.row_headers ?? [];

    // Skip non-input sheets
    const classification = sheetClassifications.get(sheetName);
    if (!classification || !classification.isInputSheet) {
      console.log(`${LOG_PREFIX} Sheet "${sheetName}": not an input sheet. Skipping.`);
      sheetIdx++;
      continue;
    }

    // ── 4a. Idempotency: delete existing rows for this sheet ─────────
    await db.execute(
      `DELETE FROM mast_assumptions
       WHERE run_id = $1::uuid
         AND origin_type = 'model_explicit'
         AND origin_locator LIKE $2`,
      [runId, `${sheetName}!%`],
      { label: `MAST: clear drivers for sheet ${sheetName}` },
    );

    // ── 4b. Detect period header rows ────────────────────────────────
    const periodHeaders = detectPeriodHeaderRows(cells);
    const headerRowIndices = new Set(periodHeaders.keys());
    const selectedPeriodRow = selectPeriodRow(periodHeaders);

    // ── 4c. Identify drivers ─────────────────────────────────────────
    interface DriverCandidate {
      row: number;
      col: number;
      value: number;
      label: string;
      period: string | null;
      locator: string;
    }

    const drivers: DriverCandidate[] = [];
    let zeroSkipped = 0;
    let toggleZerosAdmitted = 0;
    let magnitudeExcluded = 0;
    let labelRejected = 0;
    let coercionRecovered = 0;

    // Build a quick lookup for cells by (row, col)
    const cellGrid = new Map<string, ParsedCell>();
    for (const cell of cells) {
      cellGrid.set(`${cell.r},${cell.c}`, cell);
    }

    for (const cell of cells) {
      // Exclusion: date type
      if (cell.type === "date") continue;

      // Exclusion: period header row
      if (headerRowIndices.has(cell.r)) continue;

      // Driver test: resolve numeric value (native number or coerced string)
      const resolvedValue = resolveNumeric(cell);
      if (resolvedValue === null) continue;

      const isZero = resolvedValue === 0;

      if (!isZero) {
        const wasCoerced = cell.type === "string";
        if (wasCoerced) coercionRecovered++;

        // Magnitude filter: only rates, percentages, multiples, margins, day counts
        const absVal = Math.abs(resolvedValue);
        if (absVal >= 10000) { magnitudeExcluded++; continue; }
      }

      // Label: nearest non-empty string cell to the left in the same row.
      // Skip date-type cells and string cells that parse as dates.
      // A cell that resolves numerically through coercion is never eligible.
      let label: string | null = null;
      for (let lc = cell.c - 1; lc >= 0; lc--) {
        const leftCell = cellGrid.get(`${cell.r},${lc}`);
        if (!leftCell) continue;
        // Skip date-type cells
        if (leftCell.type === "date") continue;
        if (leftCell.type === "string" && leftCell.value != null && String(leftCell.value).trim().length > 0) {
          const trimmed = String(leftCell.value).trim();
          // Skip if this string cell resolves as a number (coerced numeric)
          if (resolveNumeric(leftCell) !== null) continue;
          // Skip if this string cell looks like a date
          if (looksLikeDateString(trimmed)) continue;
          label = trimmed;
          break;
        }
      }
      // Fallback: row_headers
      if (label === null && cell.r < rowHeaders.length && rowHeaders[cell.r]?.trim()) {
        label = rowHeaders[cell.r].trim();
      }

      // Driver must have a real label
      if (label === null) continue;

      // Zero check with toggle exception (FIX 2)
      if (isZero) {
        const lbl = label.toLowerCase();
        const isToggle = TOGGLE_KEYWORDS.some((kw) => lbl.includes(kw));
        if (isToggle) {
          toggleZerosAdmitted++;
        } else {
          zeroSkipped++;
          continue;
        }
      }
      const alphaCount = (label.match(/[a-zA-Z0-9]/g) || []).length;
      if (alphaCount < 2) { labelRejected++; continue; }
      // Reject blacklisted tokens (n.a., na, n/a, nm, n.m., tbd)
      if (LABEL_BLACKLIST.has(label.toLowerCase())) { labelRejected++; continue; }
      // Reject labels that are purely punctuation
      if (labelIsPunctuation(label)) { labelRejected++; continue; }
      // Reject labels that are just a number in disguise
      if (labelIsNumeric(label)) { labelRejected++; continue; }

      // Period: value from the selected period header row at the same column index
      let period: string | null = null;
      if (selectedPeriodRow !== null) {
        const val = selectedPeriodRow.get(cell.c);
        if (val !== undefined) {
          period = val;
        }
      }

      const addr = toA1(cell.r, cell.c);

      drivers.push({
        row: cell.r,
        col: cell.c,
        value: resolvedValue,
        label,
        period,
        locator: `${sheetName}!${addr}`,
      });
    }

    // ── 4d. Cap at DRIVER_CAP, ordered by abs value descending ───────
    let cappedDrivers = drivers;
    if (drivers.length > DRIVER_CAP) {
      console.log(
        `${LOG_PREFIX} Sheet "${sheetName}" has ${drivers.length} drivers — capping at ${DRIVER_CAP}, dropping ${drivers.length - DRIVER_CAP}.`,
      );
      cappedDrivers = drivers
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, DRIVER_CAP);
    }

    // ── 4e. Adjudication — LLM filters non-assumptions ──────────────
    const model = getModuleModel(MODULE_ID);
    const sortedForAdj = [...cappedDrivers].sort((a, b) =>
      a.locator.localeCompare(b.locator),
    );
    const adjudicatedDrivers: DriverCandidate[] = [];
    let adjudicationRejected = 0;
    let unadjudicatedCount = 0;
    const sentToAdjudication = sortedForAdj.length;

    for (let batchStart = 0; batchStart < sortedForAdj.length; batchStart += ADJUDICATION_BATCH_SIZE) {
      // Budget check inside adjudication loop
      if (Date.now() - startTime > STAGE_BUDGET_MS) {
        // Keep remaining un-adjudicated entries (fail open)
        const remaining = sortedForAdj.slice(batchStart);
        adjudicatedDrivers.push(...remaining);
        unadjudicatedCount += remaining.length;
        console.log(
          `${LOG_PREFIX} Sheet "${sheetName}": budget exceeded during adjudication at batch offset ${batchStart}. Keeping ${remaining.length} entries unadjudicated.`,
        );
        break;
      }

      const batch = sortedForAdj.slice(
        batchStart,
        batchStart + ADJUDICATION_BATCH_SIZE,
      );

      // Build numbered list
      const numberedList = batch
        .map((d, i) => {
          const addr = d.locator; // already "SheetName!A1"
          return `${i + 1}. Sheet: ${sheetName}, Cell: ${addr.split("!")[1]}, Label: ${d.label}, Value: ${d.value}, Period: ${d.period ?? "none"}`;
        })
        .join("\n");

      const adjPrompt = `You are reviewing entries extracted from a financial model spreadsheet.

Below is a numbered list of entries. For each one, decide whether it is an underwriting assumption — a choice the deal team made that could have been made differently and that would change the outcome if made differently.

The following are NOT assumptions and MUST be rejected:
- Calendar or date arithmetic such as days in a period, working days, or day counts
- Counts of customers, connections, units, or headcount
- Account balances, brought-forward or carried-forward figures
- Historical actuals
- Index or reference numbers
- Any entry whose label is missing, meaningless, or is itself a number

You are judging entries, not producing new ones. Do not invent, rename, or reword any entry.

Return a JSON array only. No prose. No markdown fences. Each element has exactly two fields: "index" (integer matching the numbered entry) and "keep" (boolean). You must return one element for every entry in the list.

--- ENTRIES ---
${numberedList}
--- END ENTRIES ---`;

      let keepSet: Set<number> | null = null;
      let attempts = 0;
      const MAX_ATTEMPTS = 2;
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
          const llmResponse = await ctx.ai.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model,
                max_tokens: MAX_OUTPUT_TOKENS,
                messages: [{ role: "user", content: adjPrompt }],
              },
            },
            { response: MessageResponseSchema },
            { label: `MAST-DRIVERS: adjudicate ${sheetName} batch ${batchStart}–${batchStart + batch.length - 1} attempt ${attempts}` },
          );

          // Detect truncation
          if (llmResponse.stop_reason === "max_tokens") {
            console.log(
              `${LOG_PREFIX} Sheet "${sheetName}" adj batch ${batchStart}: TRUNCATED (attempt ${attempts}).`,
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
                `${LOG_PREFIX} Sheet "${sheetName}" adj batch ${batchStart}: response is not an array (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
              );
              lastWasParseFailure = true;
              continue;
            }
            // Build keep set from valid elements
            keepSet = new Set<number>();
            for (const el of parsed) {
              if (
                el &&
                typeof el === "object" &&
                typeof el.index === "number" &&
                typeof el.keep === "boolean" &&
                el.index >= 1 &&
                el.index <= batch.length
              ) {
                if (el.keep) {
                  keepSet.add(el.index);
                }
              }
            }
            // If the response omits entries, keep them (fail open)
            for (let i = 1; i <= batch.length; i++) {
              const mentioned = parsed.some(
                (el: any) => el && typeof el === "object" && el.index === i,
              );
              if (!mentioned) {
                keepSet.add(i);
              }
            }
            // Successfully parsed — done
            break;
          } catch (_parseErr) {
            console.log(
              `${LOG_PREFIX} Sheet "${sheetName}" adj batch ${batchStart}: JSON parse failure (attempt ${attempts}). Raw (300): ${responseText.slice(0, 300)}`,
            );
            lastWasParseFailure = true;
            continue;
          }
        } catch (llmErr) {
          console.log(
            `${LOG_PREFIX} Sheet "${sheetName}" adj batch ${batchStart}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
          );
          lastWasError = true;
          continue;
        }
      }

      // If all attempts failed, keep every entry (fail open)
      if (keepSet === null) {
        adjudicatedDrivers.push(...batch);
        unadjudicatedCount += batch.length;
        console.log(
          `${LOG_PREFIX} Sheet "${sheetName}" adj batch ${batchStart}: all attempts failed — keeping ${batch.length} entries unadjudicated.`,
        );
      } else {
        for (let i = 0; i < batch.length; i++) {
          if (keepSet.has(i + 1)) {
            adjudicatedDrivers.push(batch[i]);
          } else {
            adjudicationRejected++;
          }
        }
      }
    }

    // ── 4f. Write surviving entries to mast_assumptions ──────────────
    const driversToWrite = adjudicatedDrivers;
    const densityTag = `(${classification.numericDensity.toFixed(2)})`;

    for (const d of driversToWrite) {
      const verbatim = `${d.label} = ${d.value}`;
      const proposition =
        d.period != null
          ? `${d.label} = ${d.value} (${d.period}) ${densityTag}`
          : `${d.label} = ${d.value} ${densityTag}`;

      await db.execute(
        `INSERT INTO mast_assumptions (
           run_id, deal_id, proposition, origin_type, origin_doc_id,
           origin_locator, verbatim, quantified, value, unit, period,
           detector, recursion_depth
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'model_explicit', $4::uuid,
           $5, $6, true, $7, NULL, $8,
           NULL, 0
         )`,
        [runId, dealId, proposition, modelDoc.id, d.locator, verbatim, d.value, d.period],
        { label: `MAST: insert driver ${d.locator}` },
      );
    }

    // Accumulate per-sheet summary for payload persistence
    sheetSummaries.push({
      sheet: sheetName,
      candidates: drivers.length,
      labelRejected,
      magnitudeExcluded,
      toggleZerosAdmitted,
      coercionRecovered,
      sentToAdj: sentToAdjudication,
      kept: driversToWrite.length,
      adjRejected: adjudicationRejected,
      unadj: unadjudicatedCount,
      written: driversToWrite.length,
    });

    console.log(
      `${LOG_PREFIX} Sheet "${sheetName}": candidates=${drivers.length}, labelRejected=${labelRejected}, magnitudeExcluded=${magnitudeExcluded}, toggleZeros=${toggleZerosAdmitted}, coercionRecovered=${coercionRecovered}, sentToAdj=${sentToAdjudication}, kept=${driversToWrite.length}, adjRejected=${adjudicationRejected}, unadj=${unadjudicatedCount}, written=${driversToWrite.length}.`,
    );
    totalDriversWritten += driversToWrite.length;
    sheetIdx++;
  }

  // ── Persist summary to pipeline_state payload ──────────────────
  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [
        runId,
        "register_model_drivers",
        JSON.stringify({
          totalDriversWritten,
          totalSheets,
          sheets: sheetSummaries,
          classifications: Object.fromEntries(
            [...sheetClassifications.entries()].map(([k, v]) => [k, v]),
          ),
        }),
      ],
      { label: "MAST-DRIVERS: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  console.log(
    `${LOG_PREFIX} register_model_drivers complete: ${totalDriversWritten} drivers across ${totalSheets} sheets.`,
  );
  return {
    complete: true,
    itemsDone: totalSheets,
    itemsTotal: totalSheets,
    resumePosition: totalSheets,
  };
};

export default registerModelDrivers;
