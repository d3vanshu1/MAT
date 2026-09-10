/**
 * Workbook Map — Round-Trip Reconstruction Test
 *
 * Rebuilds a sheet grid from WorkbookMapResult alone (cells + style tables)
 * and diffs it against the live SheetJS parse of the same file.
 *
 * This is the Phase 1 acceptance test: the map is complete when a sheet can
 * be reconstructed from the database and matches what Excel shows a human.
 *
 * Also includes an independent cell count to verify workbook_cells row count
 * matches the number of non-empty cells in the file.
 */

import * as XLSX from "xlsx";
import type { WorkbookMapResult, CellRecord, SheetRecord } from "./workbookMapBuilder.js";
import type { StyleTables } from "./ooxmlStyleExtractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CellDiff {
  cellRef: string;
  field: string;
  expected: string;
  actual: string;
}

export interface SheetReconResult {
  sheetName: string;
  totalCells: number;
  matchedCells: number;
  mismatches: CellDiff[];
  passed: boolean;
}

export interface IndependentCountResult {
  sheetName: string;
  fileCount: number;      // non-empty cells from SheetJS parse
  mapCount: number;       // cells in WorkbookMapResult
  match: boolean;
}

export interface RoundTripReport {
  sheets: SheetReconResult[];
  independentCounts: IndependentCountResult[];
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Built-in number formats — single source of truth in shared/excelBuiltinFormats
// ---------------------------------------------------------------------------
import { BUILTIN_NUM_FMTS } from "../../shared/excelBuiltinFormats.js";

// ---------------------------------------------------------------------------
// Number format application (simplified — enough for round-trip diff)
// ---------------------------------------------------------------------------

function formatValue(raw: string | null, numFmt: string | null): string {
  if (raw == null) return "";
  if (!numFmt || numFmt === "General") return raw;

  const num = Number(raw);
  if (isNaN(num)) return raw;

  // Percentage formats
  if (numFmt.includes("%")) {
    const pct = num * 100;
    const decimals = (numFmt.match(/0\.(0+)%/) || [])[1]?.length ?? 0;
    return `${pct.toFixed(decimals)}%`;
  }

  // Comma-separated thousands
  if (numFmt.includes("#,##0")) {
    const decimals = (numFmt.match(/#,##0\.(0+)/) || [])[1]?.length ?? 0;
    return num.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  // Fixed decimal
  const fixedMatch = numFmt.match(/^0\.(0+)$/);
  if (fixedMatch) {
    return num.toFixed(fixedMatch[1].length);
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Resolve display value from map data
// ---------------------------------------------------------------------------

function resolveDisplayValue(cell: CellRecord, styleTables: StyleTables): string {
  if (cell.valueRaw == null) return "";
  if (cell.valueType === "text" || cell.valueType === "bool" || cell.valueType === "error") {
    return cell.valueRaw;
  }

  // Try cell-level number format first
  if (cell.numberFormat) {
    return formatValue(cell.valueRaw, cell.numberFormat);
  }

  // Fall back to style-index-resolved format
  if (cell.styleIndex != null && cell.styleIndex < styleTables.cellXfs.length) {
    const xf = styleTables.cellXfs[cell.styleIndex];
    const fmtId = xf.numFmtId;
    const customFmt = styleTables.numFmts.find((f) => f.numFmtId === fmtId);
    const fmt = customFmt?.formatCode ?? BUILTIN_NUM_FMTS[fmtId] ?? null;
    if (fmt) return formatValue(cell.valueRaw, fmt);
  }

  return cell.valueRaw;
}

function resolveIndent(cell: CellRecord, styleTables: StyleTables): number {
  if (cell.styleIndex == null) return 0;
  if (cell.styleIndex >= styleTables.cellXfs.length) return 0;
  return styleTables.cellXfs[cell.styleIndex].indent;
}

function resolveBold(cell: CellRecord, styleTables: StyleTables): boolean {
  if (cell.styleIndex == null) return false;
  if (cell.styleIndex >= styleTables.cellXfs.length) return false;
  const xf = styleTables.cellXfs[cell.styleIndex];
  if (xf.fontId >= styleTables.fonts.length) return false;
  return styleTables.fonts[xf.fontId].bold;
}

// ---------------------------------------------------------------------------
// SheetJS reference extraction
// ---------------------------------------------------------------------------

interface FileCell {
  cellRef: string;
  displayValue: string;
}

function extractFileCells(sheet: XLSX.WorkSheet): FileCell[] {
  const cells: FileCell[] = [];
  if (!sheet || !sheet["!ref"]) return cells;

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (!cell || (cell.v == null && !cell.f)) continue;

      // Get display value — what the user sees in Excel
      let display = "";
      if (cell.w) {
        // SheetJS formatted text (when cellNF is on)
        display = cell.w;
      } else if (cell.v != null) {
        display = String(cell.v);
      }

      cells.push({ cellRef: addr, displayValue: display });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Independent non-empty cell count from SheetJS
// ---------------------------------------------------------------------------

function countNonEmptyCells(sheet: XLSX.WorkSheet): number {
  if (!sheet || !sheet["!ref"]) return 0;
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  let count = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (cell && (cell.v != null || cell.f)) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Round-trip reconstruction
// ---------------------------------------------------------------------------

/**
 * Run round-trip reconstruction on selected sheets.
 *
 * @param buffer     Raw xlsx bytes (for SheetJS reference parse)
 * @param mapResult  The WorkbookMapResult from buildWorkbookMap
 * @param sheetNames Which sheets to test (empty = auto-select 4)
 */
export function runRoundTripTest(
  buffer: ArrayBuffer,
  mapResult: WorkbookMapResult,
  sheetNames?: string[],
): RoundTripReport {
  // Parse the file independently with SheetJS for reference
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: true,
    cellNF: true,
    cellFormula: true,
  });

  const styleTables = mapResult.workbook.styleTables;

  // Auto-select sheets if not specified: pick up to 4 matched sheets
  // with highest cell counts (most likely to be P&L, build, drivers, summary)
  const testSheets = sheetNames ?? autoSelectSheets(mapResult.sheets);

  const results: SheetReconResult[] = [];
  const counts: IndependentCountResult[] = [];

  // Run independent count on ALL sheets
  for (const sheetRec of mapResult.sheets) {
    const sheet = workbook.Sheets[sheetRec.sheetName];
    const fileCount = sheet ? countNonEmptyCells(sheet) : 0;
    const mapCount = mapResult.cells.filter((c) => c.sheetName === sheetRec.sheetName).length;
    counts.push({
      sheetName: sheetRec.sheetName,
      fileCount,
      mapCount,
      match: fileCount === mapCount,
    });
  }

  // Run reconstruction diff on selected sheets
  for (const sheetName of testSheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      results.push({
        sheetName,
        totalCells: 0,
        matchedCells: 0,
        mismatches: [{ cellRef: "-", field: "sheet", expected: "exists", actual: "missing in file" }],
        passed: false,
      });
      continue;
    }

    const fileCells = extractFileCells(sheet);
    const mapCells = mapResult.cells.filter((c) => c.sheetName === sheetName);
    const mapByRef = new Map<string, CellRecord>();
    for (const c of mapCells) mapByRef.set(c.cellRef, c);

    const mismatches: CellDiff[] = [];
    let matched = 0;

    // Check every file cell has a corresponding map cell with matching display value
    for (const fc of fileCells) {
      const mc = mapByRef.get(fc.cellRef);
      if (!mc) {
        mismatches.push({
          cellRef: fc.cellRef,
          field: "presence",
          expected: fc.displayValue,
          actual: "(missing from map)",
        });
        continue;
      }

      // Compare raw value presence
      if (mc.valueRaw == null && fc.displayValue !== "") {
        mismatches.push({
          cellRef: fc.cellRef,
          field: "value_raw",
          expected: fc.displayValue,
          actual: "(null)",
        });
        continue;
      }

      // For numeric cells, compare the reconstructed display value
      if (mc.valueType === "number" || mc.valueType === "date") {
        const reconstructed = resolveDisplayValue(mc, styleTables);
        // Normalize for comparison (trim whitespace, collapse spaces)
        const normExpected = fc.displayValue.trim().replace(/\s+/g, " ");
        const normActual = reconstructed.trim().replace(/\s+/g, " ");

        if (normExpected !== normActual) {
          // Check if they're numerically equal (formatting may differ slightly)
          const numExpected = Number(normExpected.replace(/[,%$£€()]/g, ""));
          const numActual = Number(normActual.replace(/[,%$£€()]/g, ""));
          if (isNaN(numExpected) || isNaN(numActual) || Math.abs(numExpected - numActual) > 0.005) {
            mismatches.push({
              cellRef: fc.cellRef,
              field: "display_value",
              expected: normExpected,
              actual: normActual,
            });
            continue;
          }
        }
      }

      matched++;
    }

    // Check for cells in map but not in file (shouldn't happen)
    for (const mc of mapCells) {
      const inFile = fileCells.some((fc) => fc.cellRef === mc.cellRef);
      if (!inFile) {
        mismatches.push({
          cellRef: mc.cellRef,
          field: "extra",
          expected: "(not in file)",
          actual: mc.valueRaw ?? "(null)",
        });
      }
    }

    results.push({
      sheetName,
      totalCells: fileCells.length,
      matchedCells: matched,
      mismatches: mismatches.slice(0, 20), // cap at 20 to keep output readable
      passed: mismatches.length === 0,
    });
  }

  return {
    sheets: results,
    independentCounts: counts,
    allPassed: results.every((r) => r.passed) && counts.every((c) => c.match),
  };
}

// ---------------------------------------------------------------------------
// Auto-select 4 sheets for round-trip testing
// ---------------------------------------------------------------------------

function autoSelectSheets(sheets: SheetRecord[]): string[] {
  // Pick the 4 matched sheets with highest cell counts
  return sheets
    .filter((s) => s.includeInMatching && s.loadStatus === "ok")
    .sort((a, b) => b.cellCountTotal - a.cellCountTotal)
    .slice(0, 4)
    .map((s) => s.sheetName);
}

// ---------------------------------------------------------------------------
// Format report for console output
// ---------------------------------------------------------------------------

export function formatRoundTripReport(report: RoundTripReport): string {
  const lines: string[] = [];

  lines.push("=== Round-Trip Reconstruction Test ===");
  lines.push("");

  for (const r of report.sheets) {
    const status = r.passed ? "✓ PASS" : `✗ FAIL (${r.mismatches.length} mismatches)`;
    lines.push(`${r.sheetName}: ${status}  [${r.matchedCells}/${r.totalCells} cells matched]`);
    if (!r.passed) {
      for (const d of r.mismatches.slice(0, 5)) {
        lines.push(`  ${d.cellRef} [${d.field}]: expected "${d.expected}" got "${d.actual}"`);
      }
      if (r.mismatches.length > 5) {
        lines.push(`  ... and ${r.mismatches.length - 5} more`);
      }
    }
  }

  lines.push("");
  lines.push("=== Independent Cell Counts ===");
  lines.push("");

  let countMismatches = 0;
  for (const c of report.independentCounts) {
    if (!c.match) {
      lines.push(`${c.sheetName}: ✗ file=${c.fileCount} map=${c.mapCount} (Δ${c.mapCount - c.fileCount})`);
      countMismatches++;
    }
  }

  if (countMismatches === 0) {
    lines.push(`All ${report.independentCounts.length} sheets: ✓ counts match`);
  } else {
    const matching = report.independentCounts.filter((c) => c.match).length;
    lines.push(`${matching}/${report.independentCounts.length} sheets match, ${countMismatches} mismatched`);
  }

  lines.push("");
  lines.push(report.allPassed ? "=== ALL TESTS PASSED ===" : "=== SOME TESTS FAILED ===");

  return lines.join("\n");
}
