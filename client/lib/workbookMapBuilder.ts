/**
 * Workbook Map Builder — Phase 1 (v3)
 *
 * Takes a raw .xlsx ArrayBuffer and produces the complete workbook map:
 *   - workbook-level metadata (role, hash, style tables, defined names)
 *   - per-sheet metadata (state, merges, row/col props, cell counts, matching scope)
 *   - per-cell data (value_raw, value_num, value_type, formula, style_index, number_format)
 *
 * Design principles from the spec:
 *   1. Store every non-empty cell — text as well as numeric
 *   2. Never modify value_raw — store exactly as Excel stores it
 *   3. Merged ranges: record, don't resolve
 *   4. Hidden sheets and rows are read like any other
 *   5. Role is detected from content, not decoration
 *   6. Fail loudly on workbooks with >5% formula cells missing cached values
 */

import * as XLSX from "xlsx";
import { extractFormulasFromXlsx } from "./ooxmlFormulaExtractor.js";
import {
  extractWorkbookMap,
  resolveNumberFormat,
  type StyleTables,
  type SheetProperties,
  type DefinedName,
  type WorkbookMapExtraction,
} from "./ooxmlStyleExtractor.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WorkbookRole = "buy_side" | "sell_side";

export interface WorkbookRecord {
  documentId: string;
  workbookRole: WorkbookRole;
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
  mergedRanges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
  freezePanes: string | null;
  rowProperties: Record<string, unknown>;
  colProperties: Record<string, unknown>;
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
  cellRef: string;
  rowIdx: number;
  colIdx: number;
  valueRaw: string | null;
  valueNum: number | null;
  valueType: "number" | "text" | "date" | "bool" | "error" | "formula_no_cache";
  formula: string | null;
  styleIndex: number | null;
  numberFormat: string | null;
}

export interface WorkbookMapResult {
  workbook: WorkbookRecord;
  sheets: SheetRecord[];
  cells: CellRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPTURE_VERSION = 1;

/** Threshold: if >5% of formula cells have no cached value, fail the workbook */
const MAX_NO_CACHE_RATIO = 0.05;

// ---------------------------------------------------------------------------
// Role detection (Step 1.1)
// ---------------------------------------------------------------------------

/** Sheet names or row labels that indicate buy-side (returns) machinery */
const BUY_SIDE_PATTERNS: RegExp[] = [
  /\birr\b/i,
  /\bmoic\b/i,
  /\bmoney\s*multiple/i,
  /\bentry\s*multiple/i,
  /\bexit\s*multiple/i,
  /\bsources?\s*(?:and|&)\s*uses?\b/i,
  /\bsponsor\s*equity/i,
  /\bdebt\s*schedule/i,
  /\blbo\b/i,
  /\bequity\s*che(?:ck|que)/i,
  /\bhold\s*period/i,
  /\breturns?\s*(?:model|analysis|summary)/i,
  /\bleverage\b/i,
  /\bcapitalisation\b/i,
  /\bcapitalization\b/i,
];

/**
 * Detect workbook role from sheet names and — as a lightweight second pass —
 * the first-column labels of the first few sheets.
 *
 * Rule: if any sheet name or top-level label matches BUY_SIDE_PATTERNS → buy_side.
 * Otherwise → sell_side.
 */
export function detectWorkbookRole(
  sheetNames: string[],
  firstColLabels: string[][],
): WorkbookRole {
  // Check sheet names
  for (const name of sheetNames) {
    for (const pat of BUY_SIDE_PATTERNS) {
      if (pat.test(name)) return "buy_side";
    }
  }

  // Check first-column labels (row labels) from each sheet
  for (const labels of firstColLabels) {
    for (const label of labels) {
      for (const pat of BUY_SIDE_PATTERNS) {
        if (pat.test(label)) return "buy_side";
      }
    }
  }

  return "sell_side";
}

// ---------------------------------------------------------------------------
// Matching scope (Step 1.4)
// ---------------------------------------------------------------------------

const EXCLUDE_NAME_MARKERS = [
  />>>$/,
  /\b(?:archive|old|backup|temp|scratch|wip)\b/i,
  /\bdo\s*not\s*use\b/i,
];

/**
 * Apply the four exclusion rules. Returns { include, rule } where rule is
 * the human-readable exclusion reason or null.
 */
function evaluateMatchingScope(
  sheet: {
    sheetState: string;
    cellCountNumeric: number;
    sheetName: string;
  },
): { include: boolean; rule: string | null } {
  // Rule 1: hidden or veryHidden
  if (sheet.sheetState === "hidden" || sheet.sheetState === "veryHidden") {
    return { include: false, rule: `rule 1: sheet state is ${sheet.sheetState}` };
  }

  // Rule 2: zero numeric cells
  if (sheet.cellCountNumeric === 0) {
    return { include: false, rule: "rule 2: zero numeric cells" };
  }

  // Rule 3: name carries explicit exclusion marker
  for (const marker of EXCLUDE_NAME_MARKERS) {
    if (marker.test(sheet.sheetName)) {
      return { include: false, rule: `rule 3: name matches ${marker.source}` };
    }
  }

  // Rule 4: everything else → included
  return { include: true, rule: null };
}

// ---------------------------------------------------------------------------
// File hash
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of the full xlsx binary.
 * Uses crypto.subtle.digest — async, built into the browser,
 * milliseconds for a few MB. Hashes every byte so any edit
 * to the file is detected and the map is never silently stale.
 */
async function computeFileHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// A1 notation helper
// ---------------------------------------------------------------------------

function colToA1(col: number): string {
  let result = "";
  let n = col + 1;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function cellToA1(row: number, col: number): string {
  return `${colToA1(col)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Populated range (same as pdfProcessor — avoids phantom columns)
// ---------------------------------------------------------------------------

function getPopulatedRange(sheet: XLSX.WorkSheet): XLSX.Range {
  const ref = sheet["!ref"];
  if (!ref) return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const decoded = XLSX.utils.decode_range(ref);

  let maxR = decoded.s.r;
  let maxC = decoded.s.c;
  let minR = decoded.e.r;
  let minC = decoded.e.c;

  for (let r = decoded.s.r; r <= decoded.e.r; r++) {
    for (let c = decoded.s.c; c <= decoded.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (cell && cell.v != null && cell.v !== "") {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }

  if (maxR < minR || maxC < minC) {
    return { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  }
  return { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the complete workbook map from a raw .xlsx ArrayBuffer.
 *
 * @param buffer  Raw xlsx bytes
 * @param documentId  UUID of the documents row
 * @param roleOverride  Optional role override (skip detection)
 * @returns WorkbookMapResult ready for persistence
 */
export async function buildWorkbookMap(
  buffer: ArrayBuffer,
  documentId: string,
  roleOverride?: WorkbookRole,
): Promise<WorkbookMapResult> {
  // -----------------------------------------------------------------------
  // 1. Parse with SheetJS (values + number formats)
  // -----------------------------------------------------------------------
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: true,
    cellNF: true,       // populate cell.z (number format string)
    cellFormula: true,   // populate cell.f (formula) — fallback to OOXML
  });

  // -----------------------------------------------------------------------
  // 2. Extract formulas (OOXML — handles shared formulas correctly)
  // -----------------------------------------------------------------------
  const ooxmlFormulas = extractFormulasFromXlsx(buffer);

  // -----------------------------------------------------------------------
  // 3. Extract styles, sheet properties, defined names (our own OOXML parse)
  // -----------------------------------------------------------------------
  let mapExtraction: WorkbookMapExtraction;
  try {
    mapExtraction = extractWorkbookMap(buffer);
  } catch (err) {
    console.warn("[WorkbookMap] OOXML extraction failed, continuing with empty styles:", err);
    mapExtraction = {
      styleTables: { numFmts: [], fonts: [], fills: [], borders: [], cellXfs: [] },
      sheetProperties: new Map(),
      definedNames: [],
    };
  }

  // -----------------------------------------------------------------------
  // 4. File hash
  // -----------------------------------------------------------------------
  const fileHash = await computeFileHash(buffer);

  // -----------------------------------------------------------------------
  // 5. Build cell records + sheet records
  // -----------------------------------------------------------------------
  const allCells: CellRecord[] = [];
  const sheets: SheetRecord[] = [];
  const firstColLabelsPerSheet: string[][] = [];

  let totalFormulaCells = 0;
  let totalNoCacheCells = 0;

  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const sheet = workbook.Sheets[sheetName];

    const sheetProps = mapExtraction.sheetProperties.get(sheetName);
    const sheetFormulas = ooxmlFormulas.get(sheetName);
    const cellStyleIndices = sheetProps?.cellStyleIndices ?? new Map<string, number>();
    // True addresses from the file's XML r attributes — authoritative source
    const trueAddresses = sheetProps?.cellTrueAddresses ?? new Set<string>();

    const sheetCells: CellRecord[] = [];
    const firstColLabels: string[] = [];

    let maxRow = 0;
    let maxCol = 0;
    let countNumeric = 0;
    let countText = 0;
    let countFormula = 0;
    let countHardcoded = 0;
    let sheetFormulaCells = 0;
    let sheetNoCacheCells = 0;

    if (sheet && sheet["!ref"]) {
      // Use true addresses from OOXML when available, falling back to SheetJS range scan.
      // True addresses come from the <c r="..."> attribute in the sheet XML — they are
      // the authoritative coordinates. SheetJS can compact blank rows, shifting all
      // subsequent row numbers and producing wrong cell references.
      const cellAddrs: string[] = trueAddresses.size > 0
        ? Array.from(trueAddresses).sort((a, b) => {
            const da = XLSX.utils.decode_cell(a);
            const db = XLSX.utils.decode_cell(b);
            return da.r !== db.r ? da.r - db.r : da.c - db.c;
          })
        : (() => {
            // Fallback: scan SheetJS range (original behavior)
            const range = getPopulatedRange(sheet);
            const addrs: string[] = [];
            for (let r = range.s.r; r <= range.e.r; r++) {
              for (let c = range.s.c; c <= range.e.c; c++) {
                addrs.push(XLSX.utils.encode_cell({ r, c }));
              }
            }
            return addrs;
          })();

      for (const addr of cellAddrs) {
          const { r, c } = XLSX.utils.decode_cell(addr);
          const cell = sheet[addr] as XLSX.CellObject | undefined;
          if (!cell || (cell.v == null && !cell.f)) continue; // truly empty

          // Track max bounds
          if (r > maxRow) maxRow = r;
          if (c > maxCol) maxCol = c;

          // --- Formula ---
          const ooxmlF = sheetFormulas?.get(addr);
          const formula = ooxmlF ?? cell.f ?? null;

          // --- Style index from OOXML ---
          const styleIndex = cellStyleIndices.get(addr) ?? null;

          // --- Number format ---
          let numberFormat: string | null = null;
          if (cell.z && typeof cell.z === "string" && cell.z !== "General") {
            numberFormat = cell.z;
          } else if (styleIndex != null) {
            numberFormat = resolveNumberFormat(mapExtraction.styleTables, styleIndex);
          }

          // --- Value type + raw value ---
          let valueRaw: string | null = null;
          let valueNum: number | null = null;
          let valueType: CellRecord["valueType"];

          if (formula && cell.v == null) {
            // Formula cell with no cached value
            valueType = "formula_no_cache";
            sheetNoCacheCells++;
            sheetFormulaCells++;
          } else if (cell.t === "n") {
            valueType = "number";
            valueRaw = cell.v != null ? String(cell.v) : null;
            valueNum = typeof cell.v === "number" ? cell.v : null;
            if (formula) {
              sheetFormulaCells++;
              countFormula++;
            } else {
              countHardcoded++;
            }
            countNumeric++;
          } else if (cell.t === "s" || cell.t === "z") {
            valueType = cell.t === "z" ? "text" : "text";
            valueRaw = cell.v != null ? String(cell.v) : null;
            countText++;
            if (formula) {
              sheetFormulaCells++;
              countFormula++;
            }
          } else if (cell.t === "b") {
            valueType = "bool";
            valueRaw = cell.v ? "TRUE" : "FALSE";
            if (formula) {
              sheetFormulaCells++;
              countFormula++;
            }
          } else if (cell.t === "d") {
            valueType = "date";
            valueRaw = cell.v instanceof Date
              ? cell.v.toISOString()
              : cell.v != null ? String(cell.v) : null;
            countNumeric++; // dates are numeric in Excel
            if (formula) {
              sheetFormulaCells++;
              countFormula++;
            }
          } else if (cell.t === "e") {
            valueType = "error";
            valueRaw = cell.v != null ? String(cell.v) : null;
            if (formula) {
              sheetFormulaCells++;
              countFormula++;
            }
          } else {
            // Unknown type — store as text
            valueType = "text";
            valueRaw = cell.v != null ? String(cell.v) : null;
            countText++;
          }

          // Use the address from the file (addr), not computed from position
          const cellRef = addr;

          sheetCells.push({
            sheetName,
            cellRef,
            rowIdx: r,
            colIdx: c,
            valueRaw,
            valueNum,
            valueType,
            formula,
            styleIndex,
            numberFormat,
          });

          // Collect first-column labels for role detection (col 0 or first populated col)
          if (c === 0 && valueType === "text" && valueRaw) {
            firstColLabels.push(valueRaw);
          }
      }
    }

    totalFormulaCells += sheetFormulaCells;
    totalNoCacheCells += sheetNoCacheCells;
    firstColLabelsPerSheet.push(firstColLabels);

    const totalCount = sheetCells.length;

    // Build sheet record
    const sheetRecord: SheetRecord = {
      sheetName,
      sheetIndex: sheetIdx,
      sheetState: sheetProps?.sheetState ?? "visible",
      maxRow,
      maxCol,
      mergedRanges: sheetProps?.mergedRanges ?? [],
      freezePanes: sheetProps?.freezePanes ?? null,
      rowProperties: sheetProps?.rowProperties ?? {},
      colProperties: sheetProps?.colProperties ?? {},
      cellCountTotal: totalCount,
      cellCountNumeric: countNumeric,
      cellCountText: countText,
      cellCountFormula: countFormula,
      cellCountHardcoded: countHardcoded,
      includeInMatching: true,
      exclusionRule: null,
      loadStatus: "ok",
      loadReason: null,
    };

    // Apply matching scope rules
    const scope = evaluateMatchingScope({
      sheetState: sheetRecord.sheetState,
      cellCountNumeric: countNumeric,
      sheetName,
    });
    sheetRecord.includeInMatching = scope.include;
    sheetRecord.exclusionRule = scope.rule;

    sheets.push(sheetRecord);
    allCells.push(...sheetCells);
  }

  // -----------------------------------------------------------------------
  // 6. Role detection
  // -----------------------------------------------------------------------
  const role: WorkbookRole = roleOverride ?? detectWorkbookRole(
    workbook.SheetNames,
    firstColLabelsPerSheet,
  );

  // -----------------------------------------------------------------------
  // 7. Check for missing cached values (>5% → fail loudly)
  // -----------------------------------------------------------------------
  let loadStatus: "ok" | "failed" = "ok";
  let loadReason: string | null = null;

  if (totalFormulaCells > 0) {
    const noCacheRatio = totalNoCacheCells / totalFormulaCells;
    if (noCacheRatio > MAX_NO_CACHE_RATIO) {
      loadStatus = "failed";
      loadReason =
        `${totalNoCacheCells} of ${totalFormulaCells} formula cells (${(noCacheRatio * 100).toFixed(1)}%) ` +
        `have no cached value — exceeds ${MAX_NO_CACHE_RATIO * 100}% threshold. ` +
        `File likely saved by non-Excel application without cached values.`;
    }
  }

  // -----------------------------------------------------------------------
  // 8. Build workbook record
  // -----------------------------------------------------------------------
  const workbookRecord: WorkbookRecord = {
    documentId,
    workbookRole: role,
    roleSource: roleOverride ? "override" : "detected",
    fileHash,
    captureVersion: CAPTURE_VERSION,
    styleTables: mapExtraction.styleTables,
    definedNames: mapExtraction.definedNames,
    loadStatus,
    loadReason,
  };

  return {
    workbook: workbookRecord,
    sheets,
    cells: loadStatus === "failed" ? [] : allCells, // no partial map on failure
  };
}

// ---------------------------------------------------------------------------
// Summary report (for console / diagnostics)
// ---------------------------------------------------------------------------

export function formatWorkbookSummary(result: WorkbookMapResult): string {
  const wb = result.workbook;
  const matched = result.sheets.filter((s) => s.includeInMatching).length;
  const excluded = result.sheets.length - matched;

  const lines: string[] = [];
  lines.push(`Workbook: ${wb.documentId}    Role: ${wb.workbookRole} (${wb.roleSource})    Capture v${wb.captureVersion}`);
  lines.push(`Sheets: ${result.sheets.length} — ${matched} matched, ${excluded} excluded`);
  lines.push("");
  lines.push(
    padRight("Sheet", 30) +
    padRight("Cells", 8) +
    padRight("Numeric", 9) +
    padRight("Text", 7) +
    padRight("Formula", 9) +
    padRight("Hardcoded", 11) +
    padRight("Match", 7) +
    "Status"
  );

  for (const s of result.sheets) {
    lines.push(
      padRight(s.sheetName.slice(0, 28), 30) +
      padRight(String(s.cellCountTotal), 8) +
      padRight(String(s.cellCountNumeric), 9) +
      padRight(String(s.cellCountText), 7) +
      padRight(String(s.cellCountFormula), 9) +
      padRight(String(s.cellCountHardcoded), 11) +
      padRight(s.includeInMatching ? "yes" : "no", 7) +
      (s.loadStatus === "ok"
        ? s.exclusionRule ? `excluded (${s.exclusionRule})` : "ok"
        : `FAILED: ${s.loadReason}`)
    );
  }

  const totals = result.sheets.reduce(
    (acc, s) => ({
      total: acc.total + s.cellCountTotal,
      numeric: acc.numeric + s.cellCountNumeric,
      text: acc.text + s.cellCountText,
      formula: acc.formula + s.cellCountFormula,
      hardcoded: acc.hardcoded + s.cellCountHardcoded,
    }),
    { total: 0, numeric: 0, text: 0, formula: 0, hardcoded: 0 },
  );

  lines.push("");
  lines.push(
    padRight("Totals", 30) +
    padRight(String(totals.total), 8) +
    padRight(String(totals.numeric), 9) +
    padRight(String(totals.text), 7) +
    padRight(String(totals.formula), 9) +
    padRight(String(totals.hardcoded), 11)
  );

  lines.push("");
  lines.push(`Load status: ${wb.loadStatus}${wb.loadReason ? ` — ${wb.loadReason}` : ""}`);

  const noCacheCount = result.sheets.reduce(
    (acc, s) => acc + (s.cellCountFormula > 0 ? 0 : 0), // tracked at workbook level
    0,
  );

  const st = wb.styleTables;
  lines.push(
    `Style tables: cellXfs ${st.cellXfs.length}, fonts ${st.fonts.length}, ` +
    `borders ${st.borders.length}, numFmts ${st.numFmts.length}`
  );

  return lines.join("\n");
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
