/**
 * mast-diag-formula-coverage.ts
 *
 * Read-only diagnostic: reports formula coverage per sheet for a document.
 * Writes nothing. Exists to verify that driver detection is viable before
 * building on it.
 *
 * MAST owns this API. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { loadAllSheets } from "./mast-doc-tables.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DocTableRow = z.object({
  sheet_or_page: z.string(),
  data: z.any(),
});

const SheetEntry = z.object({
  sheet_or_page: z.string(),
  totalCells: z.number(),
  cellsWithFormula: z.number(),
  numericCellsNoFormula: z.number(),
  distinctCellRefsInFormulas: z.number(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastDiagFormulaCoverage",
  description: "Reports formula coverage per sheet for a document",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string().uuid(),
  }),

  output: z.object({
    sheets: z.array(SheetEntry),
    workbookTotals: z.object({
      totalCells: z.number(),
      cellsWithFormula: z.number(),
      numericCellsNoFormula: z.number(),
      distinctCellRefsInFormulas: z.number(),
    }),
  }),

  async run(ctx, { documentId }) {
    const db = ctx.integrations.ic_diligence_db;

    const { sheets: loadedSheets, skipped } = await loadAllSheets(db, documentId);

    if (skipped > 0) {
      console.log(`[MAST-DIAG] ${skipped} sheet(s) skipped due to size limit.`);
    }

    const rows = loadedSheets;

    const sheets: z.infer<typeof SheetEntry>[] = [];

    let wbTotalCells = 0;
    let wbCellsWithFormula = 0;
    let wbNumericNoFormula = 0;
    let wbDistinctRefs = 0;

    for (const row of rows) {
      const data = row.data as {
        cells?: Array<{
          r: number;
          c: number;
          value: unknown;
          type: string;
          formula?: string | null;
        }>;
      };

      const cells = data?.cells ?? [];
      let totalCells = 0;
      let cellsWithFormula = 0;
      let numericNoFormula = 0;
      const refSet = new Set<string>();

      for (const cell of cells) {
        totalCells++;
        const hasFormula = typeof cell.formula === "string" && cell.formula.length > 0;
        if (hasFormula) {
          cellsWithFormula++;
          // Extract cell references from formula
          extractCellRefs(cell.formula!, row.sheet_or_page, refSet);
        } else if (cell.type === "number") {
          numericNoFormula++;
        }
      }

      sheets.push({
        sheet_or_page: row.sheet_or_page,
        totalCells,
        cellsWithFormula,
        numericCellsNoFormula: numericNoFormula,
        distinctCellRefsInFormulas: refSet.size,
      });

      wbTotalCells += totalCells;
      wbCellsWithFormula += cellsWithFormula;
      wbNumericNoFormula += numericNoFormula;
      wbDistinctRefs += refSet.size;
    }

    return {
      sheets,
      workbookTotals: {
        totalCells: wbTotalCells,
        cellsWithFormula: wbCellsWithFormula,
        numericCellsNoFormula: wbNumericNoFormula,
        distinctCellRefsInFormulas: wbDistinctRefs,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Cell reference extraction (shared logic with mast-register-model-drivers)
// ---------------------------------------------------------------------------

/** Matches A1-style cell refs: optional sheet prefix, column letters, row digits. */
const CELL_REF_RE =
  /(?:(?:'([^']+)'|([A-Za-z0-9_]+))!)?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/g;

function colToIndex(col: string): number {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx;
}

function extractCellRefs(
  formula: string,
  currentSheet: string,
  refSet: Set<string>,
): void {
  CELL_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_REF_RE.exec(formula)) !== null) {
    const sheet = m[1] ?? m[2] ?? currentSheet;
    const startCol = m[3].toUpperCase();
    const startRow = parseInt(m[4], 10);
    const endCol = m[5]?.toUpperCase();
    const endRow = m[6] ? parseInt(m[6], 10) : undefined;

    if (endCol && endRow !== undefined) {
      // Range — expand
      const sc = colToIndex(startCol);
      const ec = colToIndex(endCol);
      const sr = startRow;
      const er = endRow;
      const totalCells = (Math.abs(ec - sc) + 1) * (Math.abs(er - sr) + 1);
      if (totalCells > 5000) {
        // Skip oversized range
        continue;
      }
      const minC = Math.min(sc, ec);
      const maxC = Math.max(sc, ec);
      const minR = Math.min(sr, er);
      const maxR = Math.max(sr, er);
      for (let c = minC; c <= maxC; c++) {
        const colStr = indexToCol(c);
        for (let r = minR; r <= maxR; r++) {
          refSet.add(`${sheet}!${colStr}${r}`);
        }
      }
    } else {
      refSet.add(`${sheet}!${startCol}${startRow}`);
    }
  }
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
