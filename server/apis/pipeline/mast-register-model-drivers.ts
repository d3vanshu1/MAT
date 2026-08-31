/**
 * mast-register-model-drivers.ts
 *
 * Stage handler for register_model_drivers.
 *
 * Reads the deal team financial model out of doc_tables and writes one
 * mast_assumptions row per driver cell. A driver is a hardcoded constant
 * that is referenced by at least one formula somewhere in the workbook.
 *
 * Pure code. No LLM anywhere.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-stages.js";
import { STAGE_BUDGET_MS } from "./mast-stages.js";
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
// Cell reference extraction
// ---------------------------------------------------------------------------

/** Matches A1-style refs: optional sheet prefix, col letters, row digits, optional range end. */
const CELL_REF_RE =
  /(?:(?:'([^']+)'|([A-Za-z0-9_]+))!)?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/g;

const RANGE_CAP = 5000;

function colToIndex(col: string): number {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx;
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

/** A1 address from 0-based row/col. */
function toA1(row: number, col: number): string {
  return `${indexToCol(col + 1)}${row + 1}`;
}

interface CellRef {
  sheet: string;
  addr: string; // e.g. "C23"
}

/**
 * Extract all cell references from a formula string.
 * Ranges are expanded up to RANGE_CAP cells. Oversized ranges are logged and skipped.
 */
function extractCellRefs(
  formula: string,
  currentSheet: string,
): CellRef[] {
  const refs: CellRef[] = [];
  CELL_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_REF_RE.exec(formula)) !== null) {
    const sheet = m[1] ?? m[2] ?? currentSheet;
    const startCol = m[3].toUpperCase();
    const startRow = parseInt(m[4], 10);
    const endCol = m[5]?.toUpperCase();
    const endRow = m[6] ? parseInt(m[6], 10) : undefined;

    if (endCol && endRow !== undefined) {
      const sc = colToIndex(startCol);
      const ec = colToIndex(endCol);
      const sr = startRow;
      const er = endRow;
      const totalCells = (Math.abs(ec - sc) + 1) * (Math.abs(er - sr) + 1);
      if (totalCells > RANGE_CAP) {
        console.log(
          `${LOG_PREFIX} Skipping oversized range ${startCol}${startRow}:${endCol}${endRow} (${totalCells} cells) on sheet ${sheet}`,
        );
        continue;
      }
      const minC = Math.min(sc, ec);
      const maxC = Math.max(sc, ec);
      const minR = Math.min(sr, er);
      const maxR = Math.max(sr, er);
      for (let c = minC; c <= maxC; c++) {
        const colStr = indexToCol(c);
        for (let r = minR; r <= maxR; r++) {
          refs.push({ sheet, addr: `${colStr}${r}` });
        }
      }
    } else {
      refs.push({ sheet, addr: `${startCol}${startRow}` });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Period header detection
// ---------------------------------------------------------------------------

interface ParsedCell {
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
function detectPeriodHeaderRows(
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
// Stage handler
// ---------------------------------------------------------------------------

const DRIVER_CAP = 2000;

const registerModelDrivers: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId, resumePosition } = ctx;
  const startTime = Date.now();

  // ── 1. Resolve the model document ──────────────────────────────────
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
    console.log(`${LOG_PREFIX} No financial_model document found for deal ${dealId}. Stage complete with 0 drivers.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  const modelDoc = modelDocs[0];
  console.log(
    `${LOG_PREFIX} Chosen model document: ${modelDoc.file_name} (id=${modelDoc.id}, ${modelDoc.table_count} sheets)`,
  );

  // ── 2. Load all sheets for the document ────────────────────────────
  const allSheets = await db.query(
    `SELECT id, sheet_or_page, data
     FROM doc_tables
     WHERE document_id = $1::uuid
     ORDER BY sheet_or_page ASC`,
    DocTableRow,
    [modelDoc.id],
    { label: "MAST: load all sheets for model" },
  );

  if (allSheets.length === 0) {
    console.log(`${LOG_PREFIX} No sheets found. Stage complete.`);
    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // ── 3. Build workbook-wide reference index ─────────────────────────
  //    Scan every formula in every sheet to build the set of referenced addresses.
  const refSet = new Set<string>(); // "SheetName!A1" normalized keys
  const refCountMap = new Map<string, number>(); // key → count of distinct formulas referencing it

  for (const sheet of allSheets) {
    const data = sheet.data as { cells?: ParsedCell[] };
    const cells = data?.cells ?? [];
    for (const cell of cells) {
      if (typeof cell.formula !== "string" || cell.formula.length === 0) continue;
      const refs = extractCellRefs(cell.formula, sheet.sheet_or_page);
      // Deduplicate refs within a single formula to count distinct formulas
      const seen = new Set<string>();
      for (const ref of refs) {
        const key = `${ref.sheet}!${ref.addr}`;
        refSet.add(key);
        if (!seen.has(key)) {
          seen.add(key);
          refCountMap.set(key, (refCountMap.get(key) ?? 0) + 1);
        }
      }
    }
  }

  console.log(`${LOG_PREFIX} Reference index built: ${refSet.size} distinct cell addresses referenced across all formulas.`);

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

    // ── 4c. Identify drivers ─────────────────────────────────────────
    interface DriverCandidate {
      row: number;
      col: number;
      value: number;
      refKey: string;
      refCount: number;
      label: string | null;
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

      // Driver test: type is number, formula is null or empty, address is referenced
      if (cell.type !== "number") continue;
      if (typeof cell.formula === "string" && cell.formula.length > 0) continue;
      if (typeof cell.value !== "number") continue;

      const addr = toA1(cell.r, cell.c);
      const refKey = `${sheetName}!${addr}`;
      if (!refSet.has(refKey)) continue;

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

      // Period: value from period header row at the same column index
      let period: string | null = null;
      for (const [_rowIdx, colMap] of periodHeaders) {
        const val = colMap.get(cell.c);
        if (val !== undefined) {
          period = val;
          break; // use first matching header row
        }
      }

      drivers.push({
        row: cell.r,
        col: cell.c,
        value: cell.value,
        refKey,
        refCount: refCountMap.get(refKey) ?? 0,
        label,
        period,
        locator: `${sheetName}!${addr}`,
      });
    }

    // ── 4d. Cap at DRIVER_CAP, ordered by refCount desc ──────────────
    let driversToWrite = drivers;
    if (drivers.length > DRIVER_CAP) {
      console.log(
        `${LOG_PREFIX} Sheet "${sheetName}" has ${drivers.length} drivers — capping at ${DRIVER_CAP}, dropping ${drivers.length - DRIVER_CAP}.`,
      );
      driversToWrite = drivers
        .sort((a, b) => b.refCount - a.refCount)
        .slice(0, DRIVER_CAP);
    }

    // ── 4e. Write to mast_assumptions ────────────────────────────────
    for (const d of driversToWrite) {
      const verbatim =
        d.label != null ? `${d.label} = ${d.value}` : `= ${d.value}`;
      const proposition =
        d.label != null
          ? d.period != null
            ? `${d.label} = ${d.value} (${d.period})`
            : `${d.label} = ${d.value}`
          : d.period != null
            ? `= ${d.value} (${d.period})`
            : `= ${d.value}`;

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
