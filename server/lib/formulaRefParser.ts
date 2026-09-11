/**
 * formulaRefParser.ts — Phase 7.1
 *
 * Parses Excel formula strings for cell/range references.
 * Handles: A1, $A$1, Sheet!A1, 'Sheet Name'!A1, ranges A1:B10,
 * cross-workbook [2]Sheet!A1 (recorded but not resolved).
 * Strips string literals before parsing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormulaRef {
  sheet: string | null;       // null = same sheet
  cellRef: string;            // "A1" or "A1:B10" for ranges
  kind: "single" | "range" | "external";
  rangeSize: number | null;   // for ranges, number of cells (capped at 500)
}

// ---------------------------------------------------------------------------
// Cell reference helpers
// ---------------------------------------------------------------------------

/** Parse "A1" → { col: 0, row: 0 } */
function parseA1(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]{1,3})(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]) - 1 };
}

/** Count cells in a range like "A1:C10" */
function rangeSize(startRef: string, endRef: string): number {
  const s = parseA1(startRef);
  const e = parseA1(endRef);
  if (!s || !e) return 1;
  const rows = Math.abs(e.row - s.row) + 1;
  const cols = Math.abs(e.col - s.col) + 1;
  return rows * cols;
}

/** Expand a range "A1:A10" into individual cell refs. Cap at maxCells. */
function expandRange(startRef: string, endRef: string, maxCells: number): string[] {
  const s = parseA1(startRef);
  const e = parseA1(endRef);
  if (!s || !e) return [startRef];

  const minRow = Math.min(s.row, e.row);
  const maxRow = Math.max(s.row, e.row);
  const minCol = Math.min(s.col, e.col);
  const maxCol = Math.max(s.col, e.col);

  const cells: string[] = [];
  for (let r = minRow; r <= maxRow && cells.length < maxCells; r++) {
    for (let c = minCol; c <= maxCol && cells.length < maxCells; c++) {
      let colStr = "";
      let cc = c + 1;
      while (cc > 0) {
        colStr = String.fromCharCode(((cc - 1) % 26) + 65) + colStr;
        cc = Math.floor((cc - 1) / 26);
      }
      cells.push(colStr + (r + 1));
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

const RANGE_EXPAND_CAP = 500;

/**
 * Parse all references from an Excel formula string.
 * Strips string literals first, then extracts references.
 */
export function parseFormulaRefs(formula: string, currentSheet: string): FormulaRef[] {
  if (!formula) return [];

  // Strip string literals: replace "..." with empty
  const cleaned = formula.replace(/"[^"]*"/g, "");

  const refs: FormulaRef[] = [];

  // Pattern 1: Cross-workbook — [N]Sheet!Ref or [N]'Sheet Name'!Ref
  // Record as external, never resolve
  const externalRe = /\[\d+\](?:'([^']+)'|([A-Za-z_]\w*))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = externalRe.exec(cleaned)) !== null) {
    const sheet = m[1] || m[2];
    const start = m[3] + m[4];
    const end = m[5] && m[6] ? m[5] + m[6] : null;
    refs.push({
      sheet,
      cellRef: end ? start + ":" + end : start,
      kind: "external",
      rangeSize: end ? rangeSize(start, end) : null,
    });
  }

  // Pattern 2: Cross-sheet — 'Sheet Name'!Ref or SheetName!Ref
  // Must not start with [ (already caught above)
  const crossSheetRe = /(?<!\[[\d\]])(?:'([^']+)'|([A-Za-z_][\w.]*))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g;
  while ((m = crossSheetRe.exec(cleaned)) !== null) {
    // Skip if this was already matched as external
    const fullMatch = m[0];
    if (fullMatch.startsWith("[")) continue;

    const sheet = m[1] || m[2];
    const start = m[3] + m[4];
    const end = m[5] && m[6] ? m[5] + m[6] : null;
    const size = end ? rangeSize(start, end) : null;
    refs.push({
      sheet,
      cellRef: end ? start + ":" + end : start,
      kind: end ? "range" : "single",
      rangeSize: size,
    });
  }

  // Pattern 3: Same-sheet — plain A1 or A1:B10 (not preceded by ! which means cross-sheet already caught)
  const sameSheetRe = /(?<![!A-Z])\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g;
  while ((m = sameSheetRe.exec(cleaned)) !== null) {
    const start = m[1] + m[2];
    const end = m[3] && m[4] ? m[3] + m[4] : null;

    // Skip if this position was already captured by cross-sheet pattern
    const startPos = m.index;
    const alreadyCaptured = refs.some(r =>
      r.kind !== "external" &&
      cleaned.indexOf((r.sheet ? r.sheet + "!" : "") + r.cellRef) <= startPos &&
      cleaned.indexOf((r.sheet ? r.sheet + "!" : "") + r.cellRef) + ((r.sheet ? r.sheet + "!" : "") + r.cellRef).length > startPos
    );
    if (alreadyCaptured) continue;

    // Skip function names that look like refs (e.g., IF, SUM, MAX, MIN, etc.)
    const funcNames = new Set(["IF", "SUM", "MAX", "MIN", "AND", "OR", "NOT", "ABS", "INT", "MOD", "ROW", "LEN", "LOG", "EXP", "AVG"]);
    if (funcNames.has(start)) continue;

    // Validate: row number should be reasonable (1-1048576)
    const rowNum = parseInt(m[2]);
    if (rowNum < 1 || rowNum > 1048576) continue;

    const size = end ? rangeSize(start, end) : null;
    refs.push({
      sheet: null, // same sheet
      cellRef: end ? start + ":" + end : start,
      kind: end ? "range" : "single",
      rangeSize: size,
    });
  }

  return refs;
}

/**
 * Expand ranges into individual cell references for the precedents table.
 * Ranges above RANGE_EXPAND_CAP are stored unexpanded with their size.
 */
export function expandFormulaRefs(
  refs: FormulaRef[],
  currentSheet: string,
): Array<{ toSheet: string; toCellRef: string; kind: string; rangeSize: number | null }> {
  const result: Array<{ toSheet: string; toCellRef: string; kind: string; rangeSize: number | null }> = [];

  for (const ref of refs) {
    const toSheet = ref.sheet ?? currentSheet;

    if (ref.kind === "external") {
      result.push({ toSheet, toCellRef: ref.cellRef, kind: "external", rangeSize: ref.rangeSize });
      continue;
    }

    if (ref.kind === "range") {
      const size = ref.rangeSize ?? 1;
      if (size > RANGE_EXPAND_CAP) {
        // Store unexpanded with size
        result.push({ toSheet, toCellRef: ref.cellRef, kind: "range", rangeSize: size });
      } else {
        // Expand
        const parts = ref.cellRef.split(":");
        const cells = expandRange(parts[0], parts[1], RANGE_EXPAND_CAP);
        for (const cell of cells) {
          result.push({ toSheet, toCellRef: cell, kind: "single", rangeSize: null });
        }
      }
      continue;
    }

    // Single
    result.push({ toSheet, toCellRef: ref.cellRef, kind: "single", rangeSize: null });
  }

  return result;
}
