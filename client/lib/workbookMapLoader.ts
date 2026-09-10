/**
 * Workbook Map Loader — Phase 1
 *
 * Takes an xlsx ArrayBuffer and produces a complete cell-level map ready for
 * DB storage. Captures every non-empty cell on every sheet with:
 *   - Raw value (never modified), numeric copy, type
 *   - Formula (from OOXML extraction)
 *   - Style index (from OOXML s attribute)
 *   - Number format (resolved from style tables)
 *
 * Also captures per-sheet metadata (merges, freeze, row/col properties, counts)
 * and per-workbook metadata (style tables, defined names, file hash).
 *
 * Role detection (buy_side / sell_side) runs on sheet names and first-column
 * labels. Returns machinery present → buy_side; otherwise sell_side.
 */

import * as XLSX from "xlsx";
import { extractFormulasFromXlsx } from "./ooxmlFormulaExtractor";
import {
  extractWorkbookMap,
  resolveNumberFormat,
  type StyleTables,
  type SheetProperties,
  type DefinedName,
  type MergeRange,
  type RowProperty,
  type ColProperty,
} from "./ooxmlStyleExtractor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkbookMapResult {
  workbook: WorkbookRecord;
  sheets: SheetRecord[];
  cells: CellRecord[];
  /** Diagnostic summary for the status report */
  summary: WorkbookSummary;
}

export interface WorkbookRecord {
  documentId: string;
  workbookRole: "buy_side" | "sell_side";
  roleSource: "detected" | "override";
  fileHash: string;
  captureVersion: number;
  styleTables: StyleTables;
  definedNames: DefinedName[];
  loadStatus: "ok" | "failed";
  loadReason: string | null;
}

export interface SheetRecord {
  sheetName: string;
  sheetIndex: number;
  sheetState: "visible" | "hidden" | "veryHidden";
  maxRow: number;
  maxCol: number;
  mergedRanges: MergeRange[];
  freezePanes: string | null;
  rowProperties: Record<string, RowProperty>;
  colProperties: Record<string, ColProperty>;
  cellCountTotal: number;
  cellCountNumeric: number;
  cellCountText: number;
  cellCountFormula: number;
  cellCountHardcoded: number;
  includeInMatching: boolean;
  exclusionRule: string | null;
  loadStatus: "ok" | "failed";
  loadReason: string | null;
}

export interface CellRecord {
  sheetName: string;
  cellRef: string;      // A1 notation
  rowIdx: number;
  colIdx: number;
  valueRaw: string | null;    // exactly as read
  valueNum: number | null;    // numeric convenience
  valueType: string;          // number | text | date | bool | error | formula_no_cache
  formula: string | null;
  styleIndex: number | null;
  numberFormat: string | null;
}

export interface WorkbookSummary {
  totalSheets: number;
  matchedSheets: number;
  excludedSheets: number;
  totalCells: number;
  totalNumeric: number;
  totalText: number;
  totalFormula: number;
  totalHardcoded: number;
  formulaNoCacheCount: number;
  formulaNoCachePercent: number;
  styleTablesCapture: {
    cellXfs: number;
    fonts: number;
    borders: number;
    numFmts: number;
    fills: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPTURE_VERSION = 1;

/**
 * If more than 5% of formula cells have no cached value, the workbook is
 * considered unreliable and should fail loudly.
 */
const MAX_FORMULA_NO_CACHE_PERCENT = 5;

// ---------------------------------------------------------------------------
// Role detection
// ---------------------------------------------------------------------------

/** Patterns that indicate a buy-side (returns/LBO) model */
const BUY_SIDE_SHEET_PATTERNS = [
  /\birr\b/i,
  /\bmoic\b/i,
  /\bmoney\s*multiple/i,
  /\bentry\s*multiple/i,
  /\bexit\s*multiple/i,
  /\bsources?\s*(and|&)\s*uses?\b/i,
  /\bsponsor\s*equity/i,
  /\bdebt\s*schedule/i,
  /\blbo\b/i,
  /\bequity\s*cheque/i,
  /\bequity\s*check/i,
  /\bhold\s*period/i,
  /\breturn/i,
  /\bleverage/i,
];

/** Patterns checked against first-column labels (row headers) */
const BUY_SIDE_LABEL_PATTERNS = [
  /\birr\b/i,
  /\bmoic\b/i,
  /\bentry\s*(ev|multiple|price)/i,
  /\bexit\s*(ev|multiple|price)/i,
  /\bequity\s*(value|invest|cheque|check)/i,
  /\blbo\b/i,
  /\bsources?\s*(and|&)\s*uses?\b/i,
  /\bsponsor/i,
];

/**
 * Detect workbook role from sheet names and row labels.
 * Returns buy_side if returns machinery is present; sell_side otherwise.
 */
export function detectWorkbookRole(
  sheetNames: string[],
  firstColumnLabels: string[][],
): "buy_side" | "sell_side" {
  // Check sheet names
  for (const name of sheetNames) {
    for (const pattern of BUY_SIDE_SHEET_PATTERNS) {
      if (pattern.test(name)) return "buy_side";
    }
  }

  // Check first-column labels across all sheets
  for (const labels of firstColumnLabels) {
    for (const label of labels) {
      if (!label) continue;
      for (const pattern of BUY_SIDE_LABEL_PATTERNS) {
        if (pattern.test(label)) return "buy_side";
      }
    }
  }

  return "sell_side";
}

// ---------------------------------------------------------------------------
// Sheet exclusion rules (Step 1.4)
// ---------------------------------------------------------------------------

/** Archive / scratch name markers */
const EXCLUSION_NAME_PATTERNS = [
  />>>$/,                                           // trailing >>>
  /\b(archive|old|backup|temp|scratch|wip)\b/i,    // explicit markers
  /\bdo\s*not\s*use\b/i,                           // "do not use"
];

function classifySheetExclusion(
  sheetState: "visible" | "hidden" | "veryHidden",
  numericCellCount: number,
  sheetName: string,
): { included: boolean; rule: string | null } {
  // Rule 1: hidden or veryHidden
  if (sheetState === "hidden" || sheetState === "veryHidden") {
    return { included: false, rule: `rule 1: ${sheetState}` };
  }

  // Rule 2: zero numeric cells
  if (numericCellCount === 0) {
    return { included: false, rule: "rule 2: zero numeric cells" };
  }

  // Rule 3: name carries an explicit exclusion marker
  for (const pattern of EXCLUSION_NAME_PATTERNS) {
    if (pattern.test(sheetName)) {
      return { included: false, rule: `rule 3: name match (${pattern.source})` };
    }
  }

  // Rule 4: included
  return { included: true, rule: null };
}

// ---------------------------------------------------------------------------
// File hash
// ---------------------------------------------------------------------------

/** Fast 32-bit hash of binary content for change detection */
function computeBinaryHash(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) - hash + bytes[i]) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Cell address helpers
// ---------------------------------------------------------------------------

function idxToColLetter(idx: number): string {
  let result = "";
  let n = idx + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function cellRefFromIdx(row: number, col: number): string {
  return `${idxToColLetter(col)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

/**
 * Parse an xlsx buffer into a complete workbook map.
 *
 * @param buffer   Raw xlsx file as ArrayBuffer
 * @param documentId  The document UUID in the DB
 * @param roleOverride  If set, skip detection and use this role
 */
export function loadWorkbookMap(
  buffer: ArrayBuffer,
  documentId: string,
  roleOverride?: "buy_side" | "sell_side",
): WorkbookMapResult {
  // 1. Extract OOXML data: styles, sheet properties, defined names
  const ooxmlData = extractWorkbookMap(buffer);

  // 2. Extract formulas via existing OOXML extractor
  const ooxmlFormulas = extractFormulasFromXlsx(buffer);

  // 3. Read with SheetJS for cell values + number formats
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: true,
    cellNF: true,       // capture number formats
    cellFormula: true,   // capture formulas (fallback)
  });

  // 4. File hash
  const fileHash = computeBinaryHash(buffer);

  // 5. Build cell records sheet by sheet
  const allCells: CellRecord[] = [];
  const allSheets: SheetRecord[] = [];
  const firstColumnLabels: string[][] = [];
  let totalFormulaNoCacheCount = 0;
  let totalFormulaCount = 0;

  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const sheet = workbook.Sheets[sheetName];
    const sheetProps = ooxmlData.sheetProperties.get(sheetName);
    const sheetFormulas = ooxmlFormulas.get(sheetName);

    if (!sheet) {
      // Empty sheet — still record it
      allSheets.push({
        sheetName,
        sheetIndex: sheetIdx,
        sheetState: sheetProps?.sheetState ?? "visible",
        maxRow: 0,
        maxCol: 0,
        mergedRanges: sheetProps?.mergedRanges ?? [],
        freezePanes: sheetProps?.freezePanes ?? null,
        rowProperties: sheetProps?.rowProperties ?? {},
        colProperties: sheetProps?.colProperties ?? {},
        cellCountTotal: 0,
        cellCountNumeric: 0,
        cellCountText: 0,
        cellCountFormula: 0,
        cellCountHardcoded: 0,
        includeInMatching: false,
        exclusionRule: "rule 2: zero numeric cells",
        loadStatus: "ok",
        loadReason: null,
      });
      firstColumnLabels.push([]);
      continue;
    }

    // Determine range
    const ref = sheet["!ref"];
    if (!ref) {
      allSheets.push({
        sheetName,
        sheetIndex: sheetIdx,
        sheetState: sheetProps?.sheetState ?? "visible",
        maxRow: 0,
        maxCol: 0,
        mergedRanges: sheetProps?.mergedRanges ?? [],
        freezePanes: sheetProps?.freezePanes ?? null,
        rowProperties: sheetProps?.rowProperties ?? {},
        colProperties: sheetProps?.colProperties ?? {},
        cellCountTotal: 0,
        cellCountNumeric: 0,
        cellCountText: 0,
        cellCountFormula: 0,
        cellCountHardcoded: 0,
        includeInMatching: false,
        exclusionRule: "rule 2: zero numeric cells",
        loadStatus: "ok",
        loadReason: null,
      });
      firstColumnLabels.push([]);
      continue;
    }

    const range = XLSX.utils.decode_range(ref);
    let maxRow = 0;
    let maxCol = 0;
    let countTotal = 0;
    let countNumeric = 0;
    let countText = 0;
    let countFormula = 0;
    let countHardcoded = 0;
    let sheetFormulaNoCacheCount = 0;
    const sheetFirstColLabels: string[] = [];
    const sheetCells: CellRecord[] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        if (!cell) continue;

        // Skip truly empty cells
        if (cell.t === "z" && !cell.f && cell.v == null) continue;

        // Track max extent
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;

        // Determine formula (prefer OOXML, fall back to SheetJS)
        const ooxmlFormula = sheetFormulas?.get(addr) ?? null;
        const formula = ooxmlFormula ?? (cell.f ? cell.f : null);
        const hasFormula = formula !== null;

        // Determine value_raw and value_type
        let valueRaw: string | null = null;
        let valueNum: number | null = null;
        let valueType: string;

        if (hasFormula && cell.v == null && cell.w == null) {
          // Formula with no cached value
          valueType = "formula_no_cache";
          sheetFormulaNoCacheCount++;
        } else if (cell.t === "n") {
          valueType = "number";
          valueRaw = cell.v != null ? String(cell.v) : null;
          valueNum = typeof cell.v === "number" ? cell.v : null;
        } else if (cell.t === "s") {
          valueType = "text";
          valueRaw = cell.v != null ? String(cell.v) : null;
          // Collect first-column labels for role detection
          if (c === range.s.c && valueRaw) {
            sheetFirstColLabels.push(valueRaw);
          }
        } else if (cell.t === "d") {
          valueType = "date";
          valueRaw = cell.v instanceof Date
            ? cell.v.toISOString()
            : cell.v != null ? String(cell.v) : null;
        } else if (cell.t === "b") {
          valueType = "bool";
          valueRaw = cell.v != null ? String(cell.v) : null;
          valueNum = cell.v ? 1 : 0;
        } else if (cell.t === "e") {
          valueType = "error";
          valueRaw = cell.w ?? (cell.v != null ? String(cell.v) : null);
        } else {
          // z (blank with style) or unknown — skip
          continue;
        }

        // Style index from OOXML
        const styleIndex = sheetProps?.cellStyleIndices.get(addr) ?? null;

        // Number format — resolve from style tables
        let numberFormat: string | null = null;
        if (styleIndex !== null) {
          numberFormat = resolveNumberFormat(ooxmlData.styleTables, styleIndex);
        }
        // Also check SheetJS cell.z as fallback
        if (!numberFormat && cell.z && String(cell.z) !== "General") {
          numberFormat = String(cell.z);
        }

        // Cell counts
        countTotal++;
        if (hasFormula) {
          countFormula++;
        }
        if (valueType === "number") {
          countNumeric++;
          if (!hasFormula) countHardcoded++;
        } else if (valueType === "text") {
          countText++;
        }

        sheetCells.push({
          sheetName,
          cellRef: addr,
          rowIdx: r,
          colIdx: c,
          valueRaw,
          valueNum,
          valueType,
          formula,
          styleIndex,
          numberFormat,
        });
      }
    }

    totalFormulaNoCacheCount += sheetFormulaNoCacheCount;
    totalFormulaCount += countFormula + sheetFormulaNoCacheCount;

    // Apply exclusion rules
    const { included, rule } = classifySheetExclusion(
      sheetProps?.sheetState ?? "visible",
      countNumeric,
      sheetName,
    );

    allSheets.push({
      sheetName,
      sheetIndex: sheetIdx,
      sheetState: sheetProps?.sheetState ?? "visible",
      maxRow,
      maxCol,
      mergedRanges: sheetProps?.mergedRanges ?? [],
      freezePanes: sheetProps?.freezePanes ?? null,
      rowProperties: sheetProps?.rowProperties ?? {},
      colProperties: sheetProps?.colProperties ?? {},
      cellCountTotal: countTotal,
      cellCountNumeric: countNumeric,
      cellCountText: countText,
      cellCountFormula: countFormula,
      cellCountHardcoded: countHardcoded,
      includeInMatching: included,
      exclusionRule: rule,
      loadStatus: "ok",
      loadReason: null,
    });
    firstColumnLabels.push(sheetFirstColLabels);
    allCells.push(...sheetCells);
  }

  // 6. Role detection
  const detectedRole = detectWorkbookRole(workbook.SheetNames, firstColumnLabels);
  const workbookRole = roleOverride ?? detectedRole;
  const roleSource = roleOverride ? "override" as const : "detected" as const;

  // 7. Check formula-no-cache threshold
  const formulaNoCachePercent = totalFormulaCount > 0
    ? (totalFormulaNoCacheCount / totalFormulaCount) * 100
    : 0;

  let loadStatus: "ok" | "failed" = "ok";
  let loadReason: string | null = null;

  if (formulaNoCachePercent > MAX_FORMULA_NO_CACHE_PERCENT) {
    loadStatus = "failed";
    loadReason = `${totalFormulaNoCacheCount} formula cells (${formulaNoCachePercent.toFixed(1)}%) have no cached value — above ${MAX_FORMULA_NO_CACHE_PERCENT}% threshold. File may not have been saved by Excel.`;
  }

  // 8. Build summary
  const matchedSheets = allSheets.filter((s) => s.includeInMatching).length;
  const excludedSheets = allSheets.length - matchedSheets;

  const summary: WorkbookSummary = {
    totalSheets: allSheets.length,
    matchedSheets,
    excludedSheets,
    totalCells: allCells.length,
    totalNumeric: allSheets.reduce((s, sh) => s + sh.cellCountNumeric, 0),
    totalText: allSheets.reduce((s, sh) => s + sh.cellCountText, 0),
    totalFormula: allSheets.reduce((s, sh) => s + sh.cellCountFormula, 0),
    totalHardcoded: allSheets.reduce((s, sh) => s + sh.cellCountHardcoded, 0),
    formulaNoCacheCount: totalFormulaNoCacheCount,
    formulaNoCachePercent,
    styleTablesCapture: {
      cellXfs: ooxmlData.styleTables.cellXfs.length,
      fonts: ooxmlData.styleTables.fonts.length,
      borders: ooxmlData.styleTables.borders.length,
      numFmts: ooxmlData.styleTables.numFmts.length,
      fills: ooxmlData.styleTables.fills.length,
    },
  };

  return {
    workbook: {
      documentId,
      workbookRole,
      roleSource,
      fileHash,
      captureVersion: CAPTURE_VERSION,
      styleTables: ooxmlData.styleTables,
      definedNames: ooxmlData.definedNames,
      loadStatus,
      loadReason,
    },
    sheets: allSheets,
    cells: loadStatus === "failed" ? [] : allCells,  // No partial map on failure
    summary,
  };
}
