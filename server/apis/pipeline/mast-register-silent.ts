/**
 * mast-register-silent.ts
 *
 * Stage handler for register_silent.
 *
 * Scans every sheet in the deal team financial model for three silent
 * assumption patterns in spreadsheet rows:
 *   1. all_zero_forecast  — every forecast cell is exactly 0
 *   2. constant_forecast  — every forecast cell is the same non-zero value
 *   3. trend_break        — a forecast growth rate falls outside the
 *                           historical rate range
 *
 * Writes one mast_assumptions row per firing.
 *
 * Pure code. No LLM anywhere.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import {
  buildReferenceIndex,
  detectPeriodHeaderRows,
  selectPeriodRow,
  resolveModelDocument,
} from "./mast-register-model-drivers.js";
import type { ParsedCell } from "./mast-register-model-drivers.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-SILENT]";

// ---------------------------------------------------------------------------
// DB row schema for doc_tables
// ---------------------------------------------------------------------------

const DocTableRow = z.object({
  id: z.string(),
  sheet_or_page: z.string(),
  data: z.any(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DETECTOR_CAP = 500;
const DENOMINATOR_FLOOR = 1000;

/** Set of lowercased tokens that classify a column as actual or forecast. */
const ACTUAL_TOKENS = new Set(["actual", "act"]);
const FORECAST_TOKENS = new Set(["forecast", "budget", "plan", "fcst"]);

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
// Actual/forecast column classification
// ---------------------------------------------------------------------------

interface ColumnClassification {
  historicalCols: number[]; // sorted ascending by col index
  forecastCols: number[];   // sorted ascending by col index
  hasActualForecastRow: boolean;
}

/**
 * Scan the first 6 rows for a row where >50% of non-empty cells (lowercased,
 * trimmed) belong to {actual, forecast, budget, plan, act, fcst}. Use it to
 * classify each column as historical or forecast.
 */
function classifyColumns(
  cells: ParsedCell[],
  periodRow: Map<number, string> | null,
): ColumnClassification {
  // Scan first 6 rows for the actual/forecast classification row
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
      // Found the classification row
      const historical: number[] = [];
      const forecast: number[] = [];

      for (const c of nonEmpty) {
        const tok = String(c.value).trim().toLowerCase();
        if (ACTUAL_TOKENS.has(tok)) {
          historical.push(c.c);
        } else if (FORECAST_TOKENS.has(tok)) {
          forecast.push(c.c);
        }
      }

      historical.sort((a, b) => a - b);
      forecast.sort((a, b) => a - b);

      return {
        historicalCols: historical,
        forecastCols: forecast,
        hasActualForecastRow: true,
      };
    }
  }

  // No actual/forecast row found — treat all period columns as forecast
  if (periodRow !== null) {
    const allCols = [...periodRow.keys()].sort((a, b) => a - b);
    return {
      historicalCols: [],
      forecastCols: allCols,
      hasActualForecastRow: false,
    };
  }

  return {
    historicalCols: [],
    forecastCols: [],
    hasActualForecastRow: false,
  };
}

// ---------------------------------------------------------------------------
// Detector result
// ---------------------------------------------------------------------------

interface DetectorHit {
  detector: string;
  row: number;
  locatorCol: number; // column index for origin_locator A1 address
  label: string;
  verbatim: string;
  proposition: string;
  value: number;
  period: string | null;
  /** Sum of refCountMap values for the row's cells — used for cap ordering. */
  rowRefScore: number;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const registerSilent: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  // ── 1. Resolve the model document ──────────────────────────────────
  const modelDoc = await resolveModelDocument(db, dealId);

  if (modelDoc === null) {
    console.log(`${LOG_PREFIX} No financial_model document. Stage complete with 0 hits.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 2. Load all sheets ─────────────────────────────────────────────
  const allSheets = await db.query(
    `SELECT id, sheet_or_page, data
     FROM doc_tables
     WHERE document_id = $1::uuid
     ORDER BY sheet_or_page ASC`,
    DocTableRow,
    [modelDoc.id],
    { label: "MAST-SILENT: load all sheets for model" },
  );

  if (allSheets.length === 0) {
    console.log(`${LOG_PREFIX} No sheets found. Stage complete.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 3. Build workbook-wide reference index ─────────────────────────
  const { refSet, refCountMap } = buildReferenceIndex(allSheets);

  // ── 4. Process sheets with resume support ──────────────────────────
  const totalSheets = allSheets.length;
  let sheetIdx = resumePosition;
  let totalHitsWritten = 0;

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

    // ── 4a. Idempotency: delete existing silent rows for this sheet ──
    await db.execute(
      `DELETE FROM mast_assumptions
       WHERE run_id = $1::uuid
         AND origin_type = 'model_implicit'
         AND origin_locator LIKE $2`,
      [runId, `${sheetName}!%`],
      { label: `MAST-SILENT: clear implicit rows for sheet ${sheetName}` },
    );

    // ── 4b. Detect periods and classify columns ──────────────────────
    const periodHeaders = detectPeriodHeaderRows(cells);
    const headerRowIndices = new Set(periodHeaders.keys());
    const selectedPeriodRow = selectPeriodRow(periodHeaders);

    const { historicalCols, forecastCols, hasActualForecastRow } =
      classifyColumns(cells, selectedPeriodRow);

    if (forecastCols.length === 0) {
      console.log(`${LOG_PREFIX} Sheet "${sheetName}": no forecast columns identified. Skipping.`);
      sheetIdx++;
      continue;
    }

    // ── 4c. Build per-row data structures ────────────────────────────
    // Group cells by row, build cell grid, collect row labels
    const cellsByRow = new Map<number, ParsedCell[]>();
    const cellGrid = new Map<string, ParsedCell>();
    for (const cell of cells) {
      cellGrid.set(`${cell.r},${cell.c}`, cell);
      let arr = cellsByRow.get(cell.r);
      if (!arr) {
        arr = [];
        cellsByRow.set(cell.r, arr);
      }
      arr.push(cell);
    }

    const hits: DetectorHit[] = [];

    for (const [rowIdx, _rowCells] of cellsByRow) {
      // Skip header rows
      if (headerRowIndices.has(rowIdx)) continue;

      // ── Relevance filter ───────────────────────────────────────────
      // Row must have a non-empty label
      let label: string | null = null;
      // Find leftmost non-empty string cell in the row
      const sortedRowCells = _rowCells.slice().sort((a, b) => a.c - b.c);
      for (const rc of sortedRowCells) {
        if (
          rc.type === "string" &&
          rc.value != null &&
          String(rc.value).trim().length > 0
        ) {
          label = String(rc.value).trim();
          break;
        }
      }
      // Fallback: row_headers
      if (label === null && rowIdx < rowHeaders.length && rowHeaders[rowIdx]?.trim()) {
        label = rowHeaders[rowIdx].trim();
      }
      if (label === null) continue;

      // At least one cell in the row must appear in refSet
      let hasRef = false;
      let rowRefScore = 0;
      for (const rc of _rowCells) {
        const addr = toA1(rc.r, rc.c);
        const key = `${sheetName}!${addr}`;
        const cnt = refCountMap.get(key);
        if (cnt !== undefined) {
          hasRef = true;
          rowRefScore += cnt;
        }
      }
      if (!hasRef) continue;

      // ── Gather forecast and historical numeric values ──────────────
      const forecastValues: { col: number; value: number }[] = [];
      for (const fc of forecastCols) {
        const cell = cellGrid.get(`${rowIdx},${fc}`);
        if (
          cell &&
          cell.type === "number" &&
          typeof cell.value === "number"
        ) {
          forecastValues.push({ col: fc, value: cell.value });
        }
      }

      // ── Helper: period for a column ────────────────────────────────
      const periodFor = (col: number): string | null => {
        if (selectedPeriodRow === null) return null;
        return selectedPeriodRow.get(col) ?? null;
      };

      // ── Helper: forecast values as comma-joined string (≤500 chars) ─
      const forecastValStr = (vals: { col: number; value: number }[]): string => {
        const raw = vals.map((v) => String(v.value)).join(", ");
        return raw.length > 500 ? raw.slice(0, 500) : raw;
      };

      // ── DETECTOR 1: all_zero_forecast ──────────────────────────────
      if (forecastValues.length >= 2) {
        const allZero = forecastValues.every((fv) => fv.value === 0);
        if (allZero) {
          const locatorCol = forecastValues[0].col;
          const period = periodFor(locatorCol);
          const periods = forecastValues
            .map((fv) => periodFor(fv.col))
            .filter((p) => p !== null)
            .join(", ");

          hits.push({
            detector: "all_zero_forecast",
            row: rowIdx,
            locatorCol,
            label,
            verbatim: `${label} = ${forecastValStr(forecastValues)}`,
            proposition: periods.length > 0
              ? `"${label}" is zero across all forecast periods (${periods})`
              : `"${label}" is zero across all forecast periods`,
            value: 0,
            period,
            rowRefScore,
          });
          // If detector 1 fires, detector 2 does not run on this row
          continue;
        }
      }

      // ── DETECTOR 2: constant_forecast ──────────────────────────────
      if (forecastValues.length >= 2) {
        const first = forecastValues[0].value;
        const allEqual = forecastValues.every((fv) => fv.value === first);
        if (allEqual && first !== 0) {
          const locatorCol = forecastValues[0].col;
          const period = periodFor(locatorCol);
          const periods = forecastValues
            .map((fv) => periodFor(fv.col))
            .filter((p) => p !== null)
            .join(", ");

          hits.push({
            detector: "constant_forecast",
            row: rowIdx,
            locatorCol,
            label,
            verbatim: `${label} = ${forecastValStr(forecastValues)}`,
            proposition: periods.length > 0
              ? `"${label}" is constant at ${first} across all forecast periods (${periods})`
              : `"${label}" is constant at ${first} across all forecast periods`,
            value: first,
            period,
            rowRefScore,
          });
        }
      }

      // ── DETECTOR 3: trend_break ────────────────────────────────────
      if (!hasActualForecastRow) {
        // No actual/forecast split — cannot compute trend break on this sheet
        // (logged once per sheet below)
      } else if (historicalCols.length >= 3 && forecastValues.length >= 1) {
        // Gather historical numeric values in column order
        const historicalValues: { col: number; value: number }[] = [];
        for (const hc of historicalCols) {
          const cell = cellGrid.get(`${rowIdx},${hc}`);
          if (
            cell &&
            cell.type === "number" &&
            typeof cell.value === "number"
          ) {
            historicalValues.push({ col: hc, value: cell.value });
          }
        }

        if (historicalValues.length >= 3) {
          // Compute historical period-over-period rates
          const historicalRates: number[] = [];
          let denominatorSkip = false;
          for (let i = 1; i < historicalValues.length; i++) {
            const denom = historicalValues[i - 1].value;
            if (Math.abs(denom) < DENOMINATOR_FLOOR) {
              denominatorSkip = true;
              break;
            }
            historicalRates.push(
              (historicalValues[i].value - denom) / denom,
            );
          }

          if (denominatorSkip) {
            // Skip logged at trace level — not an error
          } else if (historicalRates.length >= 2) {
            const minRate = Math.min(...historicalRates);
            const maxRate = Math.max(...historicalRates);

            // Last historical value is the base for forecast rates
            const lastHistorical =
              historicalValues[historicalValues.length - 1].value;

            if (Math.abs(lastHistorical) >= DENOMINATOR_FLOOR) {
              for (const fv of forecastValues) {
                const forecastRate =
                  (fv.value - lastHistorical) / lastHistorical;
                if (forecastRate < minRate || forecastRate > maxRate) {
                  const period = periodFor(fv.col);
                  hits.push({
                    detector: "trend_break",
                    row: rowIdx,
                    locatorCol: fv.col,
                    label,
                    verbatim: `${label} = ${forecastValStr(forecastValues)}`,
                    proposition: period !== null
                      ? `"${label}" forecast for ${period} breaks the historical growth trend (rate ${(forecastRate * 100).toFixed(1)}% vs historical range ${(minRate * 100).toFixed(1)}%–${(maxRate * 100).toFixed(1)}%)`
                      : `"${label}" forecast breaks the historical growth trend (rate ${(forecastRate * 100).toFixed(1)}% vs historical range ${(minRate * 100).toFixed(1)}%–${(maxRate * 100).toFixed(1)}%)`,
                    value: fv.value,
                    period,
                    rowRefScore,
                  });
                }
              }
            }
          }
        }
      }
    } // end row loop

    // Log trend_break skip if no actual/forecast row on this sheet
    if (!hasActualForecastRow) {
      console.log(
        `${LOG_PREFIX} Sheet "${sheetName}": no actual/forecast classification row found. Detector 3 (trend_break) skipped.`,
      );
    }

    // ── 4d. Cap at DETECTOR_CAP, ordered by rowRefScore desc ─────────
    let hitsToWrite = hits;
    if (hits.length > DETECTOR_CAP) {
      console.log(
        `${LOG_PREFIX} Sheet "${sheetName}": ${hits.length} detector hits — capping at ${DETECTOR_CAP}, dropping ${hits.length - DETECTOR_CAP}.`,
      );
      hitsToWrite = hits
        .sort((a, b) => b.rowRefScore - a.rowRefScore)
        .slice(0, DETECTOR_CAP);
    }

    // ── 4e. Write to mast_assumptions ────────────────────────────────
    for (const h of hitsToWrite) {
      const locator = `${sheetName}!${toA1(h.row, h.locatorCol)}`;
      const period = h.period;

      await db.execute(
        `INSERT INTO mast_assumptions (
           run_id, deal_id, proposition, origin_type, origin_doc_id,
           origin_locator, verbatim, quantified, value, unit, period,
           detector, recursion_depth
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'model_implicit', $4::uuid,
           $5, $6, true, $7, NULL, $8,
           $9, 0
         )`,
        [
          runId, dealId, h.proposition, modelDoc.id,
          locator, h.verbatim, h.value, period,
          h.detector,
        ],
        { label: `MAST-SILENT: insert ${h.detector} ${locator}` },
      );
    }

    console.log(
      `${LOG_PREFIX} Sheet "${sheetName}": ${hitsToWrite.length} silent detector hits written.`,
    );
    totalHitsWritten += hitsToWrite.length;
    sheetIdx++;
  }

  console.log(
    `${LOG_PREFIX} register_silent complete: ${totalHitsWritten} hits across ${totalSheets} sheets.`,
  );
  return {
    complete: true,
    itemsDone: totalSheets,
    itemsTotal: totalSheets,
    resumePosition: totalSheets,
  };
};

export default registerSilent;
