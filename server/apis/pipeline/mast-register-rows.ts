/**
 * mast-register-rows.ts
 *
 * Diagnostic probe: reads a financial model workbook and returns
 * what a row-level extractor would produce.  Four stages:
 *
 *   1  Header scan — locate "Financial year" / "Month" (and optional
 *      "Actual / Forecast") rows.  Build a column map.  Classify each
 *      column as annual or monthly.
 *   2  Hierarchy tracking — maintain a stack of the last non-empty text
 *      value seen in columns A–F (0-indexed: 0–5).
 *   3  Row emission — for each row, find the rightmost non-empty text
 *      cell in columns A–G.  Emit one record per row with hierarchy
 *      path, row label, locator, and annual-column values.
 *   4  Actual / Forecast split — report each emitted row's annual
 *      values split into actual and forecast series.
 *
 * Pure code.  No LLM calls.  No writes to mast_assumptions.
 *
 * MAST owns this handler.  No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { loadAllSheets, type LoadedSheet } from "./mast-doc-tables.js";

const LOG_PREFIX = "[MAST-ROWS-PROBE]";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Cell type (matches ParsedCell in mast-register-model-drivers.ts)
// ---------------------------------------------------------------------------

interface Cell {
  r: number;
  c: number;
  value: unknown;
  type: string;
}

// ---------------------------------------------------------------------------
// Column map entry
// ---------------------------------------------------------------------------

interface ColumnInfo {
  col: number;
  financialYear: number;
  monthLabel: string;
  actualOrForecast: "actual" | "forecast" | "unknown";
  isAnnual: boolean;
}

// ---------------------------------------------------------------------------
// Header scan result (per sheet)
// ---------------------------------------------------------------------------

interface HeaderScanResult {
  recognized: boolean;
  reason?: string;
  afRowIndex: number | null; // null if no Actual/Forecast row
  fyRowIndex: number | null;
  monthRowIndex: number | null;
  columns: ColumnInfo[];
  annualCount: number;
  monthlyCount: number;
  annualColumns: { col: number; year: number; flag: string }[];
}

// ---------------------------------------------------------------------------
// Emitted row
// ---------------------------------------------------------------------------

interface EmittedRow {
  sheet: string;
  hierarchyPath: string;
  rowLabel: string;
  labelAddress: string; // A1-style
  rowIndex: number;
  annualValues: { year: number; value: unknown; flag: string }[];
  hasAnyForecast: boolean;
  hasAnyActual: boolean;
}

// ---------------------------------------------------------------------------
// A1 address helper
// ---------------------------------------------------------------------------

function toA1(row: number, col: number): string {
  let colStr = "";
  let c = col;
  while (c >= 0) {
    colStr = String.fromCharCode(65 + (c % 26)) + colStr;
    c = Math.floor(c / 26) - 1;
  }
  return `${colStr}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Month-label fiscal-year-end detection
//
// Annual columns are those whose Month value is the fiscal year end for
// that financial year.  For SCG the fiscal year end is March, so
// "Mar-23" is the FY2023 annual column.
//
// We detect the fiscal year end month by looking at which month string
// appears on the first annual column and checking that it matches for
// all columns sharing the same pattern.
// ---------------------------------------------------------------------------

/**
 * Parse "Mon-YY" or "Mon-YYYY" into { month, year2d }.
 * Returns null if the string doesn't match.
 */
function parseMonthLabel(label: string): { monthName: string; year2d: number } | null {
  const m = label.match(/^([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const monthName = m[1];
  const raw = parseInt(m[2], 10);
  const year2d = raw >= 100 ? raw % 100 : raw;
  return { monthName, year2d };
}

/**
 * Detect fiscal-year-end month from a set of ColumnInfo entries.
 * Returns the 3-letter month abbreviation (e.g. "Mar") or null.
 */
function detectFiscalYearEndMonth(columns: ColumnInfo[]): string | null {
  // For each financial year, collect the month labels.
  // The fiscal year end is the month that appears exactly once per FY
  // in the "first band" of columns (before any gap / monthly detail).
  const fyMonths = new Map<number, string[]>();
  for (const col of columns) {
    const parsed = parseMonthLabel(col.monthLabel);
    if (!parsed) continue;
    const arr = fyMonths.get(col.financialYear) ?? [];
    arr.push(parsed.monthName);
    fyMonths.set(col.financialYear, arr);
  }
  // The annual band is the contiguous run of columns before a gap.
  // In that band each FY should have exactly one month label = the FYE.
  // If any FY has >1 month we're already in the monthly band.
  // Take the first FY that has exactly one month and use it.
  for (const [_fy, months] of fyMonths) {
    if (months.length === 1) return months[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 1: Header scan
// ---------------------------------------------------------------------------

function scanHeaders(sheet: LoadedSheet): HeaderScanResult {
  const data = sheet.data as { cells?: Cell[] };
  const cells = data?.cells ?? [];

  // Build a quick row-col lookup for the first 10 rows, col >= 6
  const headerCells = new Map<string, Cell>();
  for (const cell of cells) {
    if (cell.r > 9) continue;
    headerCells.set(`${cell.r},${cell.c}`, cell);
  }

  // Find "Financial year" in column 6 within the first 10 rows
  let fyRowIndex: number | null = null;
  let afRowIndex: number | null = null;
  let monthRowIndex: number | null = null;

  for (let r = 0; r <= 9; r++) {
    const cell = headerCells.get(`${r},6`);
    if (!cell || cell.type === "empty") continue;
    const val = String(cell.value).trim();
    if (/^financial\s*year$/i.test(val)) {
      fyRowIndex = r;
      break;
    }
  }

  if (fyRowIndex === null) {
    return {
      recognized: false,
      reason: "No 'Financial year' cell found in column G (rows 0–9).",
      afRowIndex: null,
      fyRowIndex: null,
      monthRowIndex: null,
      columns: [],
      annualCount: 0,
      monthlyCount: 0,
      annualColumns: [],
    };
  }

  // Check for "Actual / Forecast" row immediately above
  if (fyRowIndex > 0) {
    const aboveCell = headerCells.get(`${fyRowIndex - 1},6`);
    if (aboveCell && /actual\s*\/\s*forecast/i.test(String(aboveCell.value).trim())) {
      afRowIndex = fyRowIndex - 1;
    }
  }

  // Check for "Month" row immediately below
  const belowCell = headerCells.get(`${fyRowIndex + 1},6`);
  if (belowCell && /^month$/i.test(String(belowCell.value).trim())) {
    monthRowIndex = fyRowIndex + 1;
  }

  if (monthRowIndex === null) {
    return {
      recognized: false,
      reason: `Found 'Financial year' at row ${fyRowIndex} but no 'Month' row immediately below.`,
      afRowIndex,
      fyRowIndex,
      monthRowIndex: null,
      columns: [],
      annualCount: 0,
      monthlyCount: 0,
      annualColumns: [],
    };
  }

  // Build column map: scan columns right of 6
  const columns: ColumnInfo[] = [];
  // Find max column in the header rows
  let maxCol = 6;
  for (const cell of cells) {
    if (cell.r === fyRowIndex || cell.r === monthRowIndex || (afRowIndex !== null && cell.r === afRowIndex)) {
      if (cell.c > maxCol) maxCol = cell.c;
    }
  }

  for (let col = 7; col <= maxCol; col++) {
    const fyCell = headerCells.get(`${fyRowIndex},${col}`);
    const monthCell = headerCells.get(`${monthRowIndex},${col}`);

    // Skip columns with no financial year value
    if (!fyCell || fyCell.type === "empty" || fyCell.value === null || fyCell.value === "") continue;

    const fyVal = Number(fyCell.value);
    if (!Number.isFinite(fyVal) || fyVal < 2000 || fyVal > 2100) continue;

    const monthLabel = monthCell ? String(monthCell.value ?? "").trim() : "";

    // Determine actual/forecast flag
    let flag: "actual" | "forecast" | "unknown" = "unknown";
    if (afRowIndex !== null) {
      const afCell = headerCells.get(`${afRowIndex},${col}`);
      if (afCell) {
        const afVal = String(afCell.value ?? "").trim().toLowerCase();
        if (afVal === "actual") flag = "actual";
        else if (afVal === "forecast") flag = "forecast";
      }
    }

    columns.push({
      col,
      financialYear: fyVal,
      monthLabel,
      actualOrForecast: flag,
      isAnnual: false, // will be set below
    });
  }

  // Classify annual vs monthly.
  // Annual columns: the FYE month for each year.
  // Detect FYE month from the data.
  //
  // Strategy: the "annual band" is the contiguous group of columns
  // starting right after col 6 before any gap.  In these, each FY
  // appears once.  Then there may be a gap (empty cols), then the
  // monthly detail band where each FY appears multiple times.
  //
  // Simpler heuristic: group columns by FY.  If a FY appears exactly
  // once in the entire column set, that column is annual.  If a FY
  // appears >1 times, the first occurrence (by col index) that sits
  // in the initial contiguous band is annual, the rest are monthly.

  // Detect the contiguous annual band: columns with no gap in FY row
  const annualBandEnd = (() => {
    let lastCol = 6;
    for (const ci of columns) {
      if (ci.col > lastCol + 6) break; // gap of >6 empty cols = end of annual band
      lastCol = ci.col;
    }
    return lastCol;
  })();

  // Within the annual band, detect the fiscal year end month
  const annualBandCols = columns.filter((c) => c.col <= annualBandEnd);
  const fyeMonth = detectFiscalYearEndMonth(annualBandCols);

  for (const ci of columns) {
    if (ci.col <= annualBandEnd) {
      // In the annual band — mark as annual
      // Double-check: if FYE month is known, verify this column's month matches
      if (fyeMonth) {
        const parsed = parseMonthLabel(ci.monthLabel);
        ci.isAnnual = parsed ? parsed.monthName.toLowerCase() === fyeMonth.toLowerCase() : true;
      } else {
        ci.isAnnual = true;
      }
    } else {
      ci.isAnnual = false;
    }
  }

  const annualCols = columns.filter((c) => c.isAnnual);
  const monthlyCols = columns.filter((c) => !c.isAnnual);

  // If no explicit A/F row, infer from year values.
  // The most recent completed fiscal year (and all before) = actual.
  // Current year and forward = forecast.
  // We'll use today's date to determine the boundary.
  if (afRowIndex === null && annualCols.length > 0) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed (0 = Jan)

    // Determine the fiscal year we are currently in.
    // If FYE is March (month index 2), then April 2025 – March 2026 = FY2026.
    // We need the FYE month index.
    const fyeMonthIndex = fyeMonth ? monthNameToIndex(fyeMonth) : 2; // default March

    // If current month > FYE month, we are in the FY = currentYear + 1.
    // Otherwise we are in the FY = currentYear.
    const currentFY = currentMonth > fyeMonthIndex ? currentYear + 1 : currentYear;

    // Any FY < currentFY is actual; currentFY and above is forecast.
    for (const ci of annualCols) {
      ci.actualOrForecast = ci.financialYear < currentFY ? "actual" : "forecast";
    }
    for (const ci of monthlyCols) {
      ci.actualOrForecast = ci.financialYear < currentFY ? "actual" : "forecast";
    }
  }

  return {
    recognized: true,
    afRowIndex,
    fyRowIndex,
    monthRowIndex,
    columns,
    annualCount: annualCols.length,
    monthlyCount: monthlyCols.length,
    annualColumns: annualCols.map((c) => ({
      col: c.col,
      year: c.financialYear,
      flag: c.actualOrForecast,
    })),
  };
}

function monthNameToIndex(name: string): number {
  const map: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  return map[name.slice(0, 3).toLowerCase()] ?? 2;
}

// ---------------------------------------------------------------------------
// Stages 2–4: Hierarchy tracking, row emission, A/F split
// ---------------------------------------------------------------------------

/**
 * Returns true if a cell value is a toggle marker ("x") rather than
 * a meaningful hierarchy label.
 */
function isToggleMarker(val: string): boolean {
  const t = val.trim().toLowerCase();
  return t === "x" || t === "xx" || t === "xxx";
}

function processSheet(
  sheet: LoadedSheet,
  headers: HeaderScanResult,
): EmittedRow[] {
  const data = sheet.data as { cells?: Cell[] };
  const cells = data?.cells ?? [];

  // Build a grid: Map<"r,c", Cell>
  const grid = new Map<string, Cell>();
  let maxRow = 0;
  for (const cell of cells) {
    grid.set(`${cell.r},${cell.c}`, cell);
    if (cell.r > maxRow) maxRow = cell.r;
  }

  // Determine header rows to skip
  const headerRows = new Set<number>();
  if (headers.afRowIndex !== null) headerRows.add(headers.afRowIndex);
  if (headers.fyRowIndex !== null) headerRows.add(headers.fyRowIndex);
  if (headers.monthRowIndex !== null) headerRows.add(headers.monthRowIndex);

  // Annual columns info
  const annualCols = headers.columns.filter((c) => c.isAnnual);
  if (annualCols.length === 0) return [];

  // Stage 2: Hierarchy tracking
  // Columns 0–5 (A–F) carry hierarchy labels.
  // Maintain an array of last non-empty text per column.
  const hierarchy: (string | null)[] = [null, null, null, null, null, null];

  const emitted: EmittedRow[] = [];

  for (let r = 0; r <= maxRow; r++) {
    if (headerRows.has(r)) continue;

    // Stage 2: update hierarchy from cols 0–5
    for (let c = 0; c <= 5; c++) {
      const cell = grid.get(`${r},${c}`);
      if (cell && cell.type !== "empty" && cell.value !== null && cell.value !== "") {
        const val = String(cell.value).trim();
        if (val.length > 0 && !isToggleMarker(val)) {
          hierarchy[c] = val;
          // Clear all entries at index > c
          for (let j = c + 1; j < 6; j++) {
            hierarchy[j] = null;
          }
        }
      }
    }

    // Stage 3: find row label — rightmost non-empty text cell in cols 0–6
    let labelCol = -1;
    let rowLabel = "";
    for (let c = 6; c >= 0; c--) {
      const cell = grid.get(`${r},${c}`);
      if (cell && cell.type !== "empty" && cell.value !== null && cell.value !== "") {
        const val = String(cell.value).trim();
        if (val.length > 0 && !isToggleMarker(val)) {
          labelCol = c;
          rowLabel = val;
          break;
        }
      }
    }

    if (labelCol < 0 || rowLabel.length === 0) continue;

    // Build hierarchy path: entries to the left of the label's column
    const pathParts: string[] = [];
    for (let c = 0; c < labelCol && c < 6; c++) {
      if (hierarchy[c] !== null) {
        pathParts.push(hierarchy[c]!);
      }
    }
    const hierarchyPath = pathParts.join(" > ");

    // Collect annual column values
    const annualValues: { year: number; value: unknown; flag: string }[] = [];
    let hasAnyValue = false;
    let hasAnyForecast = false;
    let hasAnyActual = false;

    for (const ac of annualCols) {
      const cell = grid.get(`${r},${ac.col}`);
      let val: unknown = null;
      if (cell && cell.type !== "empty" && cell.value !== null && cell.value !== "") {
        val = cell.value;
        hasAnyValue = true;
        if (ac.actualOrForecast === "forecast") hasAnyForecast = true;
        if (ac.actualOrForecast === "actual") hasAnyActual = true;
      }
      annualValues.push({
        year: ac.financialYear,
        value: val,
        flag: ac.actualOrForecast,
      });
    }

    // Skip rows with no annual values at all
    if (!hasAnyValue) continue;

    emitted.push({
      sheet: sheet.sheet_or_page,
      hierarchyPath,
      rowLabel,
      labelAddress: toA1(r, labelCol),
      rowIndex: r,
      annualValues,
      hasAnyForecast,
      hasAnyActual,
    });
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------

const DocumentIdRow = z.object({
  document_id: z.string(),
  file_name: z.string(),
});

export default api({
  name: "MastRegisterRowsProbe",
  description: "Diagnostic: row-level extraction probe for financial model sheets.",

  integrations: {
    ic_diligence: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    result: z.any(),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence;

    // Find all financial_model documents for this deal
    const docs = await db.query(
      `SELECT id AS document_id, file_name
       FROM documents
       WHERE deal_id = $1::uuid AND document_tag = 'financial_model'
       ORDER BY uploaded_at DESC`,
      DocumentIdRow,
      [dealId],
      { label: "ROWS-PROBE: find financial_model documents" },
    );

    if (docs.length === 0) {
      return { result: { error: "No financial_model documents found for this deal." } };
    }

    // Use the first (most recent) document
    const targetDoc = docs[0];
    console.log(
      `${LOG_PREFIX} Using document "${targetDoc.file_name}" (${targetDoc.document_id}).`,
    );

    // Load all sheets
    const { sheets, skipped } = await loadAllSheets(db, targetDoc.document_id);
    console.log(
      `${LOG_PREFIX} Loaded ${sheets.length} sheets, skipped ${skipped}.`,
    );

    // Process each sheet
    const sheetResults: {
      name: string;
      recognized: boolean;
      reason?: string;
      headerRows: { afRow: number | null; fyRow: number | null; monthRow: number | null };
      annualColumnCount: number;
      monthlyColumnCount: number;
      annualColumns: { col: number; year: number; flag: string }[];
      totalRowsEmitted: number;
      rowsWithForecast: number;
      rowsActualOnly: number;
    }[] = [];

    const allEmitted: EmittedRow[] = [];

    for (const sheet of sheets) {
      const headers = scanHeaders(sheet);

      if (!headers.recognized) {
        sheetResults.push({
          name: sheet.sheet_or_page,
          recognized: false,
          reason: headers.reason,
          headerRows: { afRow: null, fyRow: null, monthRow: null },
          annualColumnCount: 0,
          monthlyColumnCount: 0,
          annualColumns: [],
          totalRowsEmitted: 0,
          rowsWithForecast: 0,
          rowsActualOnly: 0,
        });
        continue;
      }

      const emitted = processSheet(sheet, headers);
      allEmitted.push(...emitted);

      const withForecast = emitted.filter((e) => e.hasAnyForecast).length;
      const actualOnly = emitted.filter((e) => e.hasAnyActual && !e.hasAnyForecast).length;

      sheetResults.push({
        name: sheet.sheet_or_page,
        recognized: true,
        headerRows: {
          afRow: headers.afRowIndex,
          fyRow: headers.fyRowIndex,
          monthRow: headers.monthRowIndex,
        },
        annualColumnCount: headers.annualCount,
        monthlyColumnCount: headers.monthlyCount,
        annualColumns: headers.annualColumns,
        totalRowsEmitted: emitted.length,
        rowsWithForecast: withForecast,
        rowsActualOnly: actualOnly,
      });

      console.log(
        `${LOG_PREFIX} Sheet "${sheet.sheet_or_page}": ` +
        `recognized=${headers.recognized}, annual=${headers.annualCount}, ` +
        `monthly=${headers.monthlyCount}, rows=${emitted.length}, ` +
        `forecast=${withForecast}, actualOnly=${actualOnly}`,
      );
    }

    // Collect samples
    const quantityInputRows = allEmitted.filter((e) => e.sheet === "Quantity input");
    const recentAcqRows = allEmitted.filter((e) => e.sheet === "Recent_acquisition_overlay");

    const sampleQuantityInput = quantityInputRows.slice(0, 15).map((e) => ({
      sheet: e.sheet,
      hierarchyPath: e.hierarchyPath,
      rowLabel: e.rowLabel,
      labelAddress: e.labelAddress,
      rowIndex: e.rowIndex,
      annualValues: e.annualValues,
      hasAnyForecast: e.hasAnyForecast,
      hasAnyActual: e.hasAnyActual,
    }));

    const sampleRecentAcq = recentAcqRows.slice(0, 15).map((e) => ({
      sheet: e.sheet,
      hierarchyPath: e.hierarchyPath,
      rowLabel: e.rowLabel,
      labelAddress: e.labelAddress,
      rowIndex: e.rowIndex,
      annualValues: e.annualValues,
      hasAnyForecast: e.hasAnyForecast,
      hasAnyActual: e.hasAnyActual,
    }));

    // Overall totals
    const totalRecognized = sheetResults.filter((s) => s.recognized).length;
    const totalUnrecognized = sheetResults.filter((s) => !s.recognized).length;
    const totalRowsEmitted = allEmitted.length;
    const totalWithForecast = allEmitted.filter((e) => e.hasAnyForecast).length;
    const totalActualOnly = allEmitted.filter((e) => e.hasAnyActual && !e.hasAnyForecast).length;

    console.log(
      `${LOG_PREFIX} TOTALS: sheets=${sheets.length}, recognized=${totalRecognized}, ` +
      `unrecognized=${totalUnrecognized}, rows=${totalRowsEmitted}, ` +
      `withForecast=${totalWithForecast}, actualOnly=${totalActualOnly}`,
    );

    return {
      result: {
        document: {
          id: targetDoc.document_id,
          fileName: targetDoc.file_name,
        },
        sheetsLoaded: sheets.length,
        sheetsSkipped: skipped,
        sheets: sheetResults,
        samples: {
          quantityInput: sampleQuantityInput,
          recentAcquisitionOverlay: sampleRecentAcq,
        },
        totals: {
          sheetsRecognized: totalRecognized,
          sheetsUnrecognized: totalUnrecognized,
          totalRowsEmitted,
          rowsWithAnyForecast: totalWithForecast,
          rowsActualOnly: totalActualOnly,
        },
      },
    };
  },
});
