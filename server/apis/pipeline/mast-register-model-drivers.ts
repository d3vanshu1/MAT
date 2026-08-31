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
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-DRIVERS]";

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
    if (cell.type === "number" && typeof cell.value === "number") {
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
      if (cell.type !== "number" || typeof cell.value !== "number") continue;
      if (forwardCols.has(cell.c)) {
        forwardNumericCount++;
      }
    }
  }

  const hasForwardValues = forwardNumericCount >= 5;

  const isInputSheet =
    numericDensity < 0.55 &&
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

      // Driver test: type is number, value is a number
      if (cell.type !== "number") continue;
      if (typeof cell.value !== "number") continue;

      // Label: nearest non-empty string cell to the left in the same row
      let label: string | null = null;
      for (let lc = cell.c - 1; lc >= 0; lc--) {
        const leftCell = cellGrid.get(`${cell.r},${lc}`);
        if (leftCell && leftCell.type === "string" && leftCell.value != null && String(leftCell.value).trim().length > 0) {
          label = String(leftCell.value).trim();
          break;
        }
      }
      // Fallback: row_headers
      if (label === null && cell.r < rowHeaders.length && rowHeaders[cell.r]?.trim()) {
        label = rowHeaders[cell.r].trim();
      }

      // Driver must have a non-empty label
      if (label === null) continue;

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
        value: cell.value,
        label,
        period,
        locator: `${sheetName}!${addr}`,
      });
    }

    // ── 4d. Cap at DRIVER_CAP, ordered by abs value ascending ────────
    let driversToWrite = drivers;
    if (drivers.length > DRIVER_CAP) {
      console.log(
        `${LOG_PREFIX} Sheet "${sheetName}" has ${drivers.length} drivers — capping at ${DRIVER_CAP}, dropping ${drivers.length - DRIVER_CAP}.`,
      );
      driversToWrite = drivers
        .sort((a, b) => Math.abs(a.value) - Math.abs(b.value))
        .slice(0, DRIVER_CAP);
    }

    // ── 4e. Write to mast_assumptions ────────────────────────────────
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

    console.log(
      `${LOG_PREFIX} Sheet "${sheetName}": ${driversToWrite.length} drivers written.`,
    );
    totalDriversWritten += driversToWrite.length;
    sheetIdx++;
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
