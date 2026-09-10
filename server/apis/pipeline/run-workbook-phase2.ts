import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CellRow {
  id: string;
  row_idx: number;
  col_idx: number;
  value_raw: string | null;
  value_type: string;
  formula: string | null;
  style_index: number | null;
}

interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

interface SheetMeta {
  sheet_name: string;
  merged_ranges: MergeRange[];
  cell_count_numeric: number;
}

interface RowUpdate {
  cellId: string;
  rowLabel: string | null;
  rowLabelSource: string | null;
  rowLabelPath: string | null;
  rowDepth: number;
  isSectionHeader: boolean;
  isAggregate: boolean;
  aggregateEvidence: string;
  componentRange: string | null;
  signConvention: string | null;
}

interface SheetReport {
  sheetName: string;
  labelCol: number;
  labelColConf: number;
  labelled: number;
  nullLabel: number;
  sections: number;
  aggregates: number;
  depthSource: string;
  dataRegionStart: number;
}

// ---------------------------------------------------------------------------
// Formula parsing for aggregate detection
// ---------------------------------------------------------------------------

/** Parse a formula to detect if it's summing a contiguous range of rows above */
function detectSumAggregate(
  formula: string | null,
  currentRow: number,
  currentCol: number,
  sheetName: string,
): { isAggregate: boolean; evidence: string; componentRange: string | null } {
  if (!formula) return { isAggregate: false, evidence: "none", componentRange: null };

  const f = formula.trim();

  // Pattern 1: =SUM(X5:X10) or =SUBTOTAL(9,X5:X10)
  const sumRangeMatch = f.match(
    /^(?:SUM|SUBTOTAL\s*\(\s*\d+\s*,)\s*\(?([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)\)?$/i
  );
  if (sumRangeMatch) {
    const startRow = parseInt(sumRangeMatch[2], 10) - 1;
    const endRow = parseInt(sumRangeMatch[4], 10) - 1;
    // Must be above current row, same column range
    if (endRow < currentRow && startRow <= endRow) {
      return {
        isAggregate: true,
        evidence: "formula_sum",
        componentRange: `${startRow + 1}:${endRow + 1}`,
      };
    }
  }

  // Pattern 2: =SUM(ref, ref, ref, ...) where refs are individual cells in same column
  const sumListMatch = f.match(/^SUM\s*\(([^)]+)\)$/i);
  if (sumListMatch) {
    const refs = sumListMatch[1].split(",").map((s) => s.trim());
    const rows: number[] = [];
    let allSameSheet = true;
    for (const ref of refs) {
      // Skip cross-sheet references
      if (ref.includes("!")) {
        allSameSheet = false;
        break;
      }
      // Handle ranges like D5:D10
      const rangeMatch = ref.match(/^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/i);
      if (rangeMatch) {
        const startR = parseInt(rangeMatch[2], 10) - 1;
        const endR = parseInt(rangeMatch[4], 10) - 1;
        for (let r = startR; r <= endR; r++) rows.push(r);
        continue;
      }
      const cellMatch = ref.match(/^\$?([A-Z]{1,3})\$?(\d+)$/i);
      if (cellMatch) {
        rows.push(parseInt(cellMatch[2], 10) - 1);
      }
    }
    if (allSameSheet && rows.length >= 2 && rows.every((r) => r < currentRow)) {
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      return {
        isAggregate: true,
        evidence: "formula_sum",
        componentRange: `${minRow + 1}:${maxRow + 1}`,
      };
    }
  }

  // Pattern 3: Addition chain e.g. =D5+D6+D7+D8 (allow subtraction too)
  // Must be 3+ cell refs in same column, all above current row, no cross-sheet
  const addChainMatch = f.match(/^([A-Z]{1,3}\d+(?:\s*[+-]\s*[A-Z]{1,3}\d+){2,})$/i);
  if (addChainMatch && !f.includes("!")) {
    const cellRefs = f.match(/[A-Z]{1,3}\d+/gi) || [];
    const rows: number[] = [];
    for (const ref of cellRefs) {
      const m = ref.match(/([A-Z]{1,3})(\d+)/i);
      if (m) rows.push(parseInt(m[2], 10) - 1);
    }
    if (rows.length >= 3 && rows.every((r) => r < currentRow)) {
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      return {
        isAggregate: true,
        evidence: "formula_sum",
        componentRange: `${minRow + 1}:${maxRow + 1}`,
      };
    }
  }

  return { isAggregate: false, evidence: "none", componentRange: null };
}

// ---------------------------------------------------------------------------
// Total-type label tokens
// ---------------------------------------------------------------------------

const TOTAL_TOKENS = /\b(total|subtotal|sum|net|gross|grand total|aggregate)\b/i;

function hasSignPrefix(label: string): boolean {
  return /^\s*\([-–]\)\s*/i.test(label) || /^\s*[-–]\s+/i.test(label);
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export default api({
  name: "RunWorkbookPhase2",
  description: "Labels rows, computes depth/hierarchy, classifies aggregates.",
  integrations: {
    ic_diligence_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
  }),
  output: z.object({
    sheetsProcessed: z.number(),
    cellsUpdated: z.number(),
    report: z.array(z.object({
      sheetName: z.string(),
      labelCol: z.number(),
      labelColConf: z.number(),
      labelled: z.number(),
      nullLabel: z.number(),
      sections: z.number(),
      aggregates: z.number(),
      depthSource: z.string(),
      dataRegionStart: z.number(),
    })),
  }),
  async run(ctx, { workbookId }) {
    const db = ctx.integrations.ic_diligence_db;

    // Load workbook style tables
    const wbRows = await db.query(
      `SELECT style_tables FROM workbooks WHERE id = $1`,
      z.object({ style_tables: z.any() }),
      [workbookId],
      { label: "Phase2: load style tables" },
    );
    if (wbRows.length === 0) throw new Error("Workbook not found");
    const styleTables = wbRows[0].style_tables;
    const cellXfs: Array<{ indent: number; fontId: number; borderId: number }> =
      styleTables?.cellXfs ?? [];
    const fonts: Array<{ bold: boolean }> = styleTables?.fonts ?? [];
    const borders: Array<{ top: string | null; bottom: string | null }> =
      styleTables?.borders ?? [];

    // Load sheet metadata
    const sheets = await db.query(
      `SELECT sheet_name, merged_ranges, cell_count_numeric
       FROM workbook_sheets WHERE workbook_id = $1
       ORDER BY sheet_index`,
      z.object({
        sheet_name: z.string(),
        merged_ranges: z.any(),
        cell_count_numeric: z.number().nullable(),
      }),
      [workbookId],
      { label: "Phase2: load sheets" },
    );

    const allReports: SheetReport[] = [];
    let totalCellsUpdated = 0;

    for (const sheet of sheets) {
      const sheetName = sheet.sheet_name;
      const mergedRanges: MergeRange[] = Array.isArray(sheet.merged_ranges)
        ? sheet.merged_ranges
        : [];

      // Build merge lookup: for any cell within a merge, return the top-left cell's value
      // We'll resolve this after loading cells
      const mergeMap = new Map<string, { topLeftR: number; topLeftC: number }>();
      for (const mr of mergedRanges) {
        for (let r = mr.s.r; r <= mr.e.r; r++) {
          for (let c = mr.s.c; c <= mr.e.c; c++) {
            if (r === mr.s.r && c === mr.s.c) continue; // skip top-left itself
            mergeMap.set(`${r}:${c}`, { topLeftR: mr.s.r, topLeftC: mr.s.c });
          }
        }
      }

      // Load cells for this sheet (paginated to stay under 4MB)
      const cellRows: CellRow[] = [];
      let offset = 0;
      const PAGE = 5000;
      while (true) {
        const page = await db.query(
          `SELECT id, row_idx, col_idx, value_raw, value_type, formula, style_index
           FROM workbook_cells
           WHERE workbook_id = $1 AND sheet_name = $2
           ORDER BY row_idx, col_idx
           LIMIT $3 OFFSET $4`,
          z.object({
            id: z.string(),
            row_idx: z.number(),
            col_idx: z.number(),
            value_raw: z.string().nullable(),
            value_type: z.string(),
            formula: z.string().nullable(),
            style_index: z.number().nullable(),
          }),
          [workbookId, sheetName, PAGE, offset],
          { label: `Phase2: cells ${sheetName} offset ${offset}` },
        );
        cellRows.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }

      if (cellRows.length === 0) {
        allReports.push({
          sheetName, labelCol: -1, labelColConf: 0,
          labelled: 0, nullLabel: 0, sections: 0, aggregates: 0,
          depthSource: "none", dataRegionStart: 0,
        });
        continue;
      }

      // Organize cells by row
      const rowMap = new Map<number, CellRow[]>();
      const cellById = new Map<string, CellRow>();
      const cellByRC = new Map<string, CellRow>();
      for (const cell of cellRows) {
        cellById.set(cell.id, cell);
        cellByRC.set(`${cell.row_idx}:${cell.col_idx}`, cell);
        const arr = rowMap.get(cell.row_idx) ?? [];
        arr.push(cell);
        rowMap.set(cell.row_idx, arr);
      }

      // --- Step 2.1: Find label column ---
      // data_region_start: first row with at least one numeric cell
      const sortedRows = Array.from(rowMap.keys()).sort((a, b) => a - b);
      let dataRegionStart = sortedRows[0] ?? 0;
      for (const r of sortedRows) {
        const cells = rowMap.get(r)!;
        if (cells.some((c) => c.value_type === "number")) {
          dataRegionStart = r;
          break;
        }
      }

      // Count text cells per column in data rows
      const colTextCount = new Map<number, number>();
      const colTotalDataRows = new Map<number, number>();
      let dataRowCount = 0;
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        dataRowCount++;
        const cells = rowMap.get(r)!;
        const seenCols = new Set<number>();
        for (const c of cells) {
          if (!seenCols.has(c.col_idx)) {
            colTotalDataRows.set(c.col_idx, (colTotalDataRows.get(c.col_idx) ?? 0) + 1);
            seenCols.add(c.col_idx);
          }
          if (c.value_type === "text" || c.value_type === "string") {
            colTextCount.set(c.col_idx, (colTextCount.get(c.col_idx) ?? 0) + 1);
          }
        }
      }

      // Pick label column: highest text density >= 30%, tie-break leftmost
      let labelCol = 0;
      let labelColConf = 0;
      for (const [col, textCount] of colTextCount) {
        const total = colTotalDataRows.get(col) ?? 1;
        const density = textCount / Math.max(dataRowCount, 1);
        if (density >= 0.3 && (density > labelColConf || (density === labelColConf && col < labelCol))) {
          labelCol = col;
          labelColConf = density;
        }
      }
      // Fallback: if no column has >=30% text density, pick col 0
      if (labelColConf === 0) {
        labelCol = 0;
        labelColConf = 0;
      }

      // --- Assign row_label ---
      // Get the text value at a given (row, col), resolving merges
      function getTextAt(row: number, col: number): string | null {
        // Check if this cell is part of a merge — resolve to top-left
        const mergeKey = `${row}:${col}`;
        const merged = mergeMap.get(mergeKey);
        const lookupR = merged ? merged.topLeftR : row;
        const lookupC = merged ? merged.topLeftC : col;
        const cell = cellByRC.get(`${lookupR}:${lookupC}`);
        if (!cell) return null;
        if (cell.value_type === "text" || cell.value_type === "string") {
          return cell.value_raw;
        }
        return null;
      }

      const rowLabels = new Map<number, { label: string | null; source: string | null }>();
      for (const r of sortedRows) {
        // Don't take labels from above data_region_start
        if (r < dataRegionStart) {
          rowLabels.set(r, { label: null, source: "above_data_region" });
          continue;
        }

        // Try 1: text in label_col
        let label = getTextAt(r, labelCol);
        let source: string | null = null;
        if (label) {
          source = `col_${labelCol}`;
        } else {
          // Try 2: walk left from label_col to col 0
          for (let c = labelCol - 1; c >= 0; c--) {
            label = getTextAt(r, c);
            if (label) {
              source = `col_${c}_fallback`;
              break;
            }
          }
        }
        if (!label) {
          source = "no_text";
        }
        rowLabels.set(r, { label: label?.trim() ?? null, source });
      }

      // --- Step 2.2: Depth ---
      // Determine depth source for the sheet
      // Signal 1: indent from style tables
      let hasAnyIndent = false;
      const rowIndents = new Map<number, number>();
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        const cells = rowMap.get(r)!;
        // Check the label column cell for indent
        const labelCell = cells.find((c) => c.col_idx === labelCol);
        if (labelCell?.style_index != null && labelCell.style_index < cellXfs.length) {
          const xf = cellXfs[labelCell.style_index];
          if (xf.indent > 0) {
            hasAnyIndent = true;
            rowIndents.set(r, xf.indent);
          }
        }
      }

      // Signal 2: leading spaces
      let hasLeadingSpaces = false;
      const rowLeadingSpaces = new Map<number, number>();
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        const lbl = rowLabels.get(r)?.label;
        if (lbl) {
          const leadingMatch = lbl.match(/^(\s+)/);
          if (leadingMatch && leadingMatch[1].length >= 2) {
            hasLeadingSpaces = true;
            rowLeadingSpaces.set(r, leadingMatch[1].length);
          }
        }
      }

      // Signal 3: column offset (label came from column right of labelCol)
      let depthSource = "none";
      const rowDepths = new Map<number, number>();

      if (hasAnyIndent) {
        depthSource = "indent_attr";
        for (const r of sortedRows) {
          rowDepths.set(r, rowIndents.get(r) ?? 0);
        }
      } else if (hasLeadingSpaces) {
        depthSource = "leading_space";
        // Infer step size from the distribution
        const spaceCounts = Array.from(rowLeadingSpaces.values()).filter((v) => v > 0);
        const minSpaces = spaceCounts.length > 0 ? Math.min(...spaceCounts) : 2;
        const step = Math.max(minSpaces, 2);
        for (const r of sortedRows) {
          const spaces = rowLeadingSpaces.get(r) ?? 0;
          rowDepths.set(r, Math.floor(spaces / step));
        }
      } else {
        depthSource = "column_offset";
        for (const r of sortedRows) {
          const src = rowLabels.get(r)?.source;
          if (src && src.startsWith("col_") && src !== `col_${labelCol}`) {
            // label came from a column left of labelCol — that's depth 0
            // label in labelCol is also depth 0; column right would be deeper
            rowDepths.set(r, 0);
          } else {
            rowDepths.set(r, 0);
          }
        }
      }

      // --- Section headers ---
      const sectionHeaders = new Set<number>();
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        const lbl = rowLabels.get(r)?.label;
        if (!lbl) continue;
        const cells = rowMap.get(r)!;
        const hasNumeric = cells.some(
          (c) => c.col_idx !== labelCol && c.value_type === "number"
        );
        if (!hasNumeric) {
          sectionHeaders.add(r);
        }
      }

      // --- Build row_label_path ---
      // Walk top to bottom with a stack
      const rowPaths = new Map<number, string>();
      const stack: Array<{ depth: number; label: string }> = [];
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        const lbl = rowLabels.get(r)?.label;
        if (!lbl) continue;
        const depth = rowDepths.get(r) ?? 0;
        // Pop stack until top is at lesser depth
        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
          stack.pop();
        }
        // Section headers go on the stack but don't get a path entry for themselves
        if (sectionHeaders.has(r)) {
          stack.push({ depth, label: lbl });
          const pathParts = stack.map((s) => s.label);
          rowPaths.set(r, pathParts.join(" > "));
          continue;
        }
        stack.push({ depth, label: lbl });
        const pathParts = stack.map((s) => s.label);
        rowPaths.set(r, pathParts.join(" > "));
      }

      // --- Step 2.3: Aggregate classification ---
      // For each data row, check if it's an aggregate
      const aggregateRows = new Map<number, { evidence: string; componentRange: string | null }>();
      for (const r of sortedRows) {
        if (r < dataRegionStart) continue;
        if (sectionHeaders.has(r)) continue;
        const cells = rowMap.get(r)!;
        // Check numeric cells for SUM formulas
        let bestEvidence = "none";
        let bestRange: string | null = null;

        for (const cell of cells) {
          if (cell.col_idx === labelCol) continue; // skip label column
          if (!cell.formula) continue;
          const result = detectSumAggregate(cell.formula, cell.row_idx, cell.col_idx, sheetName);
          if (result.isAggregate && result.evidence === "formula_sum") {
            bestEvidence = "formula_sum";
            bestRange = result.componentRange;
            break; // one formula_sum is enough
          }
        }

        // Fallback: formatting (bold + border)
        if (bestEvidence === "none") {
          const labelCell = cells.find((c) => c.col_idx === labelCol);
          if (labelCell?.style_index != null && labelCell.style_index < cellXfs.length) {
            const xf = cellXfs[labelCell.style_index];
            const font = xf.fontId < fonts.length ? fonts[xf.fontId] : null;
            const border = xf.borderId < borders.length ? borders[xf.borderId] : null;
            const isBold = font?.bold ?? false;
            const hasBorder = (border?.top != null || border?.bottom != null);
            if (isBold && hasBorder) {
              bestEvidence = "formatting";
            }
          }
        }

        // Fallback: label token
        if (bestEvidence === "none") {
          const lbl = rowLabels.get(r)?.label;
          if (lbl && TOTAL_TOKENS.test(lbl)) {
            bestEvidence = "label_token";
          }
        }

        if (bestEvidence !== "none") {
          aggregateRows.set(r, { evidence: bestEvidence, componentRange: bestRange });
        }
      }

      // --- Sign convention ---
      const signRows = new Map<number, string>();
      for (const r of sortedRows) {
        const lbl = rowLabels.get(r)?.label;
        if (lbl && hasSignPrefix(lbl)) {
          signRows.set(r, "negative_displayed");
        }
      }

      // --- Build updates ---
      const updates: RowUpdate[] = [];
      for (const cell of cellRows) {
        const r = cell.row_idx;
        const lbl = rowLabels.get(r);
        const agg = aggregateRows.get(r);
        updates.push({
          cellId: cell.id,
          rowLabel: lbl?.label ?? null,
          rowLabelSource: lbl?.source ?? null,
          rowLabelPath: rowPaths.get(r) ?? null,
          rowDepth: rowDepths.get(r) ?? 0,
          isSectionHeader: sectionHeaders.has(r),
          isAggregate: agg != null,
          aggregateEvidence: agg?.evidence ?? "none",
          componentRange: agg?.componentRange ?? null,
          signConvention: signRows.get(r) ?? null,
        });
      }

      // --- Write updates in batched CTEs ---
      // Deduplicate by row_idx (all cells in a row share the same values)
      const rowUpdateMap = new Map<number, RowUpdate>();
      for (const u of updates) {
        const cell = cellById.get(u.cellId);
        if (cell && !rowUpdateMap.has(cell.row_idx)) {
          rowUpdateMap.set(cell.row_idx, u);
        }
      }
      const rowUpdates = Array.from(rowUpdateMap.entries()); // [rowIdx, update][]

      const ROW_BATCH = 50;
      for (let bi = 0; bi < rowUpdates.length; bi += ROW_BATCH) {
        const batch = rowUpdates.slice(bi, bi + ROW_BATCH);
        const valueClauses: string[] = [];
        const params: unknown[] = [workbookId, sheetName, depthSource];
        let idx = 4;

        for (const [rowIdx, u] of batch) {
          valueClauses.push(
            `($${idx}::int, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}::int,` +
            ` $${idx+5}::boolean, $${idx+6}::boolean, $${idx+7}, $${idx+8}, $${idx+9})`
          );
          params.push(
            rowIdx, u.rowLabel, u.rowLabelSource, u.rowLabelPath, u.rowDepth,
            u.isSectionHeader, u.isAggregate,
            u.aggregateEvidence, u.componentRange, u.signConvention,
          );
          idx += 10;
        }

        await db.execute(
          `WITH vals(ri, rl, rls, rlp, rd, ish, ia, ae, cr, sc) AS (
             VALUES ${valueClauses.join(", ")}
           )
           UPDATE workbook_cells c SET
             row_label = v.rl,
             row_label_source = v.rls,
             row_label_path = v.rlp,
             row_depth = v.rd,
             row_depth_source = $3,
             is_section_header = v.ish,
             is_aggregate = v.ia,
             aggregate_evidence = v.ae,
             component_range = v.cr,
             sign_convention = v.sc
           FROM vals v
           WHERE c.workbook_id = $1 AND c.sheet_name = $2 AND c.row_idx = v.ri`,
          params,
          { label: `Phase2: update ${sheetName} rows ${bi+1}-${bi+batch.length}` },
        );
      }
      totalCellsUpdated += cellRows.length;

      // --- Update sheet metadata ---
      await db.execute(
        `UPDATE workbook_sheets SET
           label_col = $2,
           label_col_confidence = $3,
           data_region_start = $4
         WHERE workbook_id = $1 AND sheet_name = $5`,
        [workbookId, labelCol, Math.round(labelColConf * 100) / 100, dataRegionStart, sheetName],
        { label: `Phase2: update sheet ${sheetName}` },
      );

      allReports.push({
        sheetName,
        labelCol,
        labelColConf: Math.round(labelColConf * 100) / 100,
        labelled: Array.from(rowLabels.values()).filter((l) => l.label != null).length,
        nullLabel: Array.from(rowLabels.values()).filter((l) => l.label == null).length,
        sections: sectionHeaders.size,
        aggregates: aggregateRows.size,
        depthSource,
        dataRegionStart,
      });
    }

    return {
      sheetsProcessed: sheets.length,
      cellsUpdated: totalCellsUpdated,
      report: allReports,
    };
  },
});
