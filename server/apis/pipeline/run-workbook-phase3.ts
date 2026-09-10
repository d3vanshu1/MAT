import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Period parsing
// ---------------------------------------------------------------------------

interface ParsedPeriod {
  periodType: string;   // FY | CY | Q | M | LTM | YTD | stub | point_date
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  periodBasis: string;  // actual | budget | forecast | estimate | unknown
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function inferFullYear(twoDigit: number): number {
  return twoDigit < 50 ? 2000 + twoDigit : 1900 + twoDigit;
}

function parseBasis(token: string): string {
  const t = token.toUpperCase().trim();
  if (t === "A" || t === "ACTUAL" || t === "ACTUALS") return "actual";
  if (t === "B" || t === "BUDGET") return "budget";
  if (t === "F" || t === "FORECAST" || t === "FCST") return "forecast";
  if (t === "E" || t === "ESTIMATE" || t === "EST") return "estimate";
  return "unknown";
}

function parsePeriodToken(raw: string, fyEndMonth: number): ParsedPeriod | null {
  const s = raw.trim();
  if (!s) return null;

  // Date-typed ISO string: "2023-12-31T05:00:00.000Z"
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // If it looks like a year-end date, treat as FY
    if (month === fyEndMonth && day >= 28) {
      const fyYear = fyEndMonth === 12 ? year : year;
      return {
        periodType: "FY", periodStart: `${fyYear}-01-01`, periodEnd: dateStr,
        periodLabel: `FY${fyYear}`, periodBasis: "unknown",
      };
    }
    return {
      periodType: "point_date", periodStart: dateStr, periodEnd: dateStr,
      periodLabel: dateStr, periodBasis: "unknown",
    };
  }

  // FY/CY year patterns: "FY2026E", "FY26", "2026A", "2026", "CY2026"
  const fyMatch = s.match(/^(?:FY|CY)?\s*'?(\d{2,4})\s*([ABEF])?$/i);
  if (fyMatch) {
    let year = parseInt(fyMatch[1], 10);
    if (year < 100) year = inferFullYear(year);
    const basisChar = fyMatch[2] ?? "";
    const basis = basisChar ? parseBasis(basisChar) : "unknown";
    const prefix = s.toUpperCase().startsWith("CY") ? "CY" : "FY";
    const endMonth = prefix === "CY" ? 12 : fyEndMonth;
    const endDate = `${year}-${String(endMonth).padStart(2, "0")}-28`;
    const startDate = endMonth === 12 ? `${year}-01-01` : `${year - 1}-${String(endMonth + 1).padStart(2, "0")}-01`;
    return {
      periodType: prefix, periodStart: startDate, periodEnd: endDate,
      periodLabel: `${prefix}${year}${basisChar.toUpperCase()}`, periodBasis: basis,
    };
  }

  // Quarter patterns: "Q1-26", "1Q26", "Q1 FY26", "Q1'26"
  const qMatch = s.match(/^(?:Q(\d)|(\d)Q)\s*[-' ]?\s*(?:FY)?\s*'?(\d{2,4})\s*([ABEF])?$/i);
  if (qMatch) {
    const quarter = parseInt(qMatch[1] ?? qMatch[2], 10);
    let year = parseInt(qMatch[3], 10);
    if (year < 100) year = inferFullYear(year);
    const basisChar = qMatch[4] ?? "";
    const basis = basisChar ? parseBasis(basisChar) : "unknown";
    const qStartMonth = (quarter - 1) * 3 + 1;
    const qEndMonth = quarter * 3;
    return {
      periodType: "Q", periodStart: `${year}-${String(qStartMonth).padStart(2, "0")}-01`,
      periodEnd: `${year}-${String(qEndMonth).padStart(2, "0")}-28`,
      periodLabel: `Q${quarter} ${year}`, periodBasis: basis,
    };
  }

  // Month patterns: "Jan-23", "January 2023", "01/23"
  const monthMatch = s.match(/^([A-Za-z]+)\s*[-' ]?\s*'?(\d{2,4})$/);
  if (monthMatch) {
    const monthName = monthMatch[1].toLowerCase();
    const month = MONTH_NAMES[monthName];
    if (month) {
      let year = parseInt(monthMatch[2], 10);
      if (year < 100) year = inferFullYear(year);
      return {
        periodType: "M",
        periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
        periodEnd: `${year}-${String(month).padStart(2, "0")}-28`,
        periodLabel: `${monthMatch[1]} ${year}`, periodBasis: "unknown",
      };
    }
  }

  // Numeric month/year: "01/23" or "1/23"
  const numMonthMatch = s.match(/^(\d{1,2})\/(\d{2,4})$/);
  if (numMonthMatch) {
    const month = parseInt(numMonthMatch[1], 10);
    if (month >= 1 && month <= 12) {
      let year = parseInt(numMonthMatch[2], 10);
      if (year < 100) year = inferFullYear(year);
      return {
        periodType: "M",
        periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
        periodEnd: `${year}-${String(month).padStart(2, "0")}-28`,
        periodLabel: `${month}/${year}`, periodBasis: "unknown",
      };
    }
  }

  // LTM / TTM patterns: "LTM Mar-26", "TTM"
  const ltmMatch = s.match(/^(?:LTM|TTM)\s*(?:([A-Za-z]+)\s*[-']?\s*'?(\d{2,4}))?$/i);
  if (ltmMatch) {
    if (ltmMatch[1] && ltmMatch[2]) {
      const month = MONTH_NAMES[ltmMatch[1].toLowerCase()];
      let year = parseInt(ltmMatch[2], 10);
      if (year < 100) year = inferFullYear(year);
      if (month) {
        return {
          periodType: "LTM",
          periodStart: `${month === 1 ? year - 1 : year}-${String(month === 1 ? 1 : month - 11).padStart(2, "0")}-01`,
          periodEnd: `${year}-${String(month).padStart(2, "0")}-28`,
          periodLabel: `LTM ${ltmMatch[1]} ${year}`, periodBasis: "actual",
        };
      }
    }
    return {
      periodType: "LTM", periodStart: "", periodEnd: "",
      periodLabel: s, periodBasis: "actual",
    };
  }

  // YTD patterns
  if (/^YTD/i.test(s)) {
    return {
      periodType: "YTD", periodStart: "", periodEnd: "",
      periodLabel: s, periodBasis: "actual",
    };
  }

  // Stub
  if (/stub/i.test(s)) {
    return {
      periodType: "stub", periodStart: "", periodEnd: "",
      periodLabel: s, periodBasis: "unknown",
    };
  }

  // Bare 4-digit year as number: "2023", "2024"
  const bareYearMatch = s.match(/^(\d{4})$/);
  if (bareYearMatch) {
    const year = parseInt(bareYearMatch[1], 10);
    if (year >= 1990 && year <= 2060) {
      const endDate = `${year}-${String(fyEndMonth).padStart(2, "0")}-28`;
      const startDate = fyEndMonth === 12 ? `${year}-01-01` : `${year - 1}-${String(fyEndMonth + 1).padStart(2, "0")}-01`;
      return {
        periodType: "FY", periodStart: startDate, periodEnd: endDate,
        periodLabel: `FY${year}`, periodBasis: "unknown",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Case detection helpers
// ---------------------------------------------------------------------------

const CASE_TOKENS = /\b(management|mgmt|base|upside|downside|sponsor|bank|street|sensitivity|pep|budget|ltm[- ]?adjusted|bull|bear|consensus)\b/i;
const SWITCH_TOKENS = /\b(case|scenario|toggle|switch|live\s*case)\b/i;
const BASIS_TOKENS = /\b(historical|historicals|actual|actuals|projected|projections|forecast|budget|estimate)\b/i;

function extractCase(text: string): { label: string; key: string } | null {
  const m = text.match(CASE_TOKENS);
  if (!m) return null;
  const label = m[1];
  const key = label.toLowerCase().replace(/[\s-]+/g, "_");
  return { label, key };
}

function extractBasis(text: string): string | null {
  const m = text.match(BASIS_TOKENS);
  if (!m) return null;
  const t = m[1].toLowerCase();
  if (t === "historical" || t === "historicals" || t === "actual" || t === "actuals") return "actual";
  if (t === "projected" || t === "projections") return "estimate";
  if (t === "forecast") return "forecast";
  if (t === "budget") return "budget";
  if (t === "estimate") return "estimate";
  return null;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export default api({
  name: "RunWorkbookPhase3",
  description: "Detects header bands, parses periods and cases per column.",
  integrations: {
    ic_diligence_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
    sheetNames: z.array(z.string()).optional(), // process only these sheets; null = all
    skipFiscalYearInference: z.boolean().optional(), // set true on batch 2+ calls
  }),
  output: z.object({
    sheetsProcessed: z.number(),
    cellsUpdated: z.number(),
    periodsFound: z.number(),
    casesFound: z.number(),
    fiscalYearEnd: z.number().nullable(),
    fiscalYearEndSource: z.string().nullable(),
    debug: z.array(z.any()).optional(), // temporary diagnostic field
  }),
  async run(ctx, { workbookId, sheetNames, skipFiscalYearInference }) {
    const db = ctx.integrations.ic_diligence_db;

    // Load sheet metadata
    const allSheets = await db.query(
      `SELECT sheet_name, merged_ranges, data_region_start, label_col, cell_count_numeric
       FROM workbook_sheets WHERE workbook_id = $1 ORDER BY sheet_index`,
      z.object({
        sheet_name: z.string(),
        merged_ranges: z.any(),
        data_region_start: z.number().nullable(),
        label_col: z.number().nullable(),
        cell_count_numeric: z.number().nullable(),
      }),
      [workbookId],
      { label: "Phase3: load sheets" },
    );

    // Filter to requested sheets if specified
    const filterSet = sheetNames ? new Set(sheetNames) : null;
    const sheets = filterSet
      ? allSheets.filter((s) => filterSet.has(s.sheet_name))
      : allSheets;

    // Infer fiscal year end from date headers across ALL sheets (not just filtered)
    let fyEndMonth = 12;
    let fyEndSource = "default_december";

    // Collect date headers to infer fiscal year end (use allSheets, skip if told to)
    if (!skipFiscalYearInference) {
    const dateHeaders: number[] = [];
    for (const sheet of allSheets) {
      const drs = sheet.data_region_start ?? 0;
      if (drs <= 0) continue;
      const headerCells = await db.query(
        `SELECT value_raw, value_type FROM workbook_cells
         WHERE workbook_id = $1 AND sheet_name = $2 AND row_idx < $3
         AND value_type IN ('date') AND col_idx > $4
         LIMIT 50`,
        z.object({ value_raw: z.string().nullable(), value_type: z.string() }),
        [workbookId, sheet.sheet_name, drs, sheet.label_col ?? 0],
        { label: `Phase3: date headers ${sheet.sheet_name}` },
      );
      for (const c of headerCells) {
        const isoMatch = c.value_raw?.match(/^(\d{4})-(\d{2})-(\d{2})T/);
        if (isoMatch) {
          dateHeaders.push(parseInt(isoMatch[2], 10));
        }
      }
    }
    if (dateHeaders.length >= 3) {
      // Most common month in date headers
      const monthCounts = new Map<number, number>();
      for (const m of dateHeaders) monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
      let maxMonth = 12;
      let maxCount = 0;
      for (const [month, count] of monthCounts) {
        if (count > maxCount) { maxMonth = month; maxCount = count; }
      }
      fyEndMonth = maxMonth;
      fyEndSource = "inferred_from_headers";
    }

    // Update workbook fiscal year end
    await db.execute(
      `UPDATE workbooks SET fiscal_year_end_month = $2, fiscal_year_end_source = $3 WHERE id = $1`,
      [workbookId, fyEndMonth, fyEndSource],
      { label: "Phase3: set fiscal year end" },
    );
    } else {
      // Load existing FY end for period parsing
      const existingFy = await db.query(
        `SELECT fiscal_year_end_month FROM workbooks WHERE id = $1`,
        z.object({ fiscal_year_end_month: z.number().nullable() }),
        [workbookId],
        { label: "Phase3: load existing FY end" },
      );
      if (existingFy.length > 0 && existingFy[0].fiscal_year_end_month) {
        fyEndMonth = existingFy[0].fiscal_year_end_month;
        fyEndSource = "existing";
      }
    }

    let totalCellsUpdated = 0;
    let totalPeriodsFound = 0;
    let totalCasesFound = 0;
    const debugInfo: Array<Record<string, unknown>> = [];

    for (const sheet of sheets) {
      const sheetName = sheet.sheet_name;
      const drs = sheet.data_region_start ?? 0;
      const labelCol = sheet.label_col ?? 0;
      const mergedRanges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> =
        Array.isArray(sheet.merged_ranges) ? sheet.merged_ranges : [];

      // Load cells for this sheet
      const cellRows: Array<{
        id: string; row_idx: number; col_idx: number;
        value_raw: string | null; value_type: string;
      }> = [];
      let offset = 0;
      const PAGE = 5000;
      while (true) {
        const page = await db.query(
          `SELECT id, row_idx, col_idx, value_raw, value_type
           FROM workbook_cells WHERE workbook_id = $1 AND sheet_name = $2
           ORDER BY row_idx, col_idx LIMIT $3 OFFSET $4`,
          z.object({
            id: z.string(), row_idx: z.number(), col_idx: z.number(),
            value_raw: z.string().nullable(), value_type: z.string(),
          }),
          [workbookId, sheetName, PAGE, offset],
          { label: `Phase3: cells ${sheetName} off ${offset}` },
        );
        cellRows.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }

      if (cellRows.length === 0) {
        await db.execute(
          `UPDATE workbook_sheets SET orientation = 'none', header_band_confidence = 0,
           structure_reason = 'no cells' WHERE workbook_id = $1 AND sheet_name = $2`,
          [workbookId, sheetName],
          { label: `Phase3: skip empty ${sheetName}` },
        );
        continue;
      }

      // Organize by (row, col)
      const cellByRC = new Map<string, typeof cellRows[0]>();
      for (const c of cellRows) cellByRC.set(`${c.row_idx}:${c.col_idx}`, c);

      // Build merge expansion map: for cells within a merge, resolve to top-left value
      const mergeExpansion = new Map<string, string | null>();
      for (const mr of mergedRanges) {
        const topLeft = cellByRC.get(`${mr.s.r}:${mr.s.c}`);
        const val = topLeft?.value_raw ?? null;
        for (let c = mr.s.c; c <= mr.e.c; c++) {
          for (let r = mr.s.r; r <= mr.e.r; r++) {
            if (r === mr.s.r && c === mr.s.c) continue;
            mergeExpansion.set(`${r}:${c}`, val);
          }
        }
      }

      function getCellValue(row: number, col: number): string | null {
        const expanded = mergeExpansion.get(`${row}:${col}`);
        if (expanded !== undefined) return expanded;
        return cellByRC.get(`${row}:${col}`)?.value_raw ?? null;
      }

      function getCellType(row: number, col: number): string {
        return cellByRC.get(`${row}:${col}`)?.value_type ?? "empty";
      }

      // Find data columns: columns right of labelCol with at least one numeric cell in data region
      const dataCols = new Set<number>();
      for (const c of cellRows) {
        if (c.col_idx > labelCol && c.row_idx >= drs && c.value_type === "number") {
          dataCols.add(c.col_idx);
        }
      }

      if (dataCols.size === 0) {
        await db.execute(
          `UPDATE workbook_sheets SET orientation = 'none', header_band_confidence = 0,
           structure_reason = 'no data columns' WHERE workbook_id = $1 AND sheet_name = $2`,
          [workbookId, sheetName],
          { label: `Phase3: no data cols ${sheetName}` },
        );
        totalCellsUpdated += cellRows.length;
        continue;
      }

      // Check if drs row itself is a year-header row (year-like values across data columns)
      // This happens when years are stored as numbers (2023, 2024) — Phase 2 treats them as data
      let effectiveDrs = drs;
      {
        let yearLikeCount = 0;
        let totalInDrs = 0;
        for (const col of dataCols) {
          const val = getCellValue(drs, col);
          if (!val) continue;
          totalInDrs++;
          const typ = getCellType(drs, col);
          const isYearNum = typ === "number" && /^\d{4}$/.test(val) && parseInt(val) >= 1990 && parseInt(val) <= 2060;
          const isYearText = (typ === "text" || typ === "string") && /^\d{4}[AEBFaebf]?$/.test(val.trim());
          if (isYearNum || isYearText) yearLikeCount++;
        }
        if (totalInDrs > 0 && yearLikeCount / totalInDrs >= 0.5) {
          // drs row is a year-header — shift effective drs down and find the real start
          let newDrs = drs + 1;
          while (newDrs < drs + 5) {
            let hasNumeric = false;
            for (const col of dataCols) {
              const t = getCellType(newDrs, col);
              if (t === "number") { hasNumeric = true; break; }
            }
            if (hasNumeric) break;
            newDrs++;
          }
          effectiveDrs = newDrs;
        }
      }

      // Find header band: rows above effectiveDrs with text/date in data columns
      // Allow up to 2 blank rows gap between data and the header band
      const headerBandRows: number[] = [];
      let blankGap = 0;
      const MAX_GAP = 2;
      for (let r = Math.max(0, effectiveDrs - 1); r >= Math.max(0, effectiveDrs - 8); r--) {
        let textDateCount = 0;
        for (const col of dataCols) {
          const val = getCellValue(r, col);
          const typ = getCellType(r, col);
          if (val && (typ === "text" || typ === "string" || typ === "date" ||
              (typ === "number" && /^\d{4}$/.test(val) && parseInt(val) >= 1990 && parseInt(val) <= 2060))) {
            textDateCount++;
          }
        }
        if (textDateCount >= Math.min(3, Math.ceil(dataCols.size * 0.3))) {
          headerBandRows.unshift(r);
          blankGap = 0; // reset gap counter once we find a header row
        } else if (headerBandRows.length === 0 && blankGap < MAX_GAP) {
          blankGap++; // allow gap before the band starts
        } else if (headerBandRows.length > 0) {
          break; // band is contiguous once started
        } else {
          break;
        }
      }

      // Check orientation: if period tokens are found in rows (label col) rather than columns
      // For now, mark as periods_across_columns unless we detect transposition
      let orientation = "periods_across_columns";
      let structureReason: string | null = null;

      // --- Section-level header fallback ---
      // When no sheet-wide header band is found, look for multi-section
      // structure: a "Date" row with ISO dates, a "Stub" row with period
      // fractions, and year-header rows that define section boundaries.
      // Rows above the first year-header row are non-temporal.

      // sectionBands: array of { headerRows, startRow, endRow } describing
      // each section's column mapping. Built only for multi-section sheets.
      interface SectionBand {
        headerRows: number[];         // row indices used as header source
        dateRow: number | null;       // row with ISO dates (preferred)
        stubRow: number | null;       // row with stub fractions
        startRow: number;             // first data row (inclusive)
        endRow: number;               // last data row (inclusive, Infinity = end)
      }
      let sectionBands: SectionBand[] = [];
      let nonTemporalEndRow = -1; // rows 0..nonTemporalEndRow have no time axis

      if (headerBandRows.length === 0) {
        // 1. Find all year-header rows across the sheet
        const yearHeaderRows: number[] = [];
        const maxRow = cellRows.reduce((mx, c) => Math.max(mx, c.row_idx), 0);
        const checkedRows = new Set<number>();
        for (const c of cellRows) {
          if (checkedRows.has(c.row_idx)) continue;
          checkedRows.add(c.row_idx);
          let yearLikeCount = 0;
          let totalInRow = 0;
          for (const col of dataCols) {
            const val = getCellValue(c.row_idx, col);
            if (!val) continue;
            totalInRow++;
            const typ = getCellType(c.row_idx, col);
            const isYearNum = typ === "number" && /^\d{4}$/.test(val)
              && parseInt(val) >= 1990 && parseInt(val) <= 2060;
            const isYearText = (typ === "text" || typ === "string")
              && /^\d{4}[AEBFaebf]?$/.test(val.trim());
            if (isYearNum || isYearText) yearLikeCount++;
          }
          if (totalInRow >= 3 && yearLikeCount / totalInRow >= 0.5) {
            yearHeaderRows.push(c.row_idx);
          }
        }
        yearHeaderRows.sort((a, b) => a - b);

        // 2. Find "Date" row and "Stub" row by scanning label column
        //    These are metadata rows with specific labels and date/numeric content.
        let globalDateRow: number | null = null;
        let globalStubRow: number | null = null;
        for (const c of cellRows) {
          if (c.col_idx !== labelCol) continue;
          const lbl = (c.value_raw ?? "").trim().toLowerCase();
          if (lbl === "date" && !globalDateRow) {
            // Verify this row actually has date-typed cells in data columns
            let hasDate = false;
            for (const col of dataCols) {
              if (getCellType(c.row_idx, col) === "date") { hasDate = true; break; }
            }
            if (hasDate) globalDateRow = c.row_idx;
          }
          if (lbl === "stub" && !globalStubRow) {
            // Verify this row has numeric fractions (not years)
            let hasFraction = false;
            for (const col of dataCols) {
              const v = getCellValue(c.row_idx, col);
              if (v && getCellType(c.row_idx, col) === "number") {
                const n = parseFloat(v);
                if (n >= 0 && n <= 1.01 && !/^\d{4}$/.test(v)) { hasFraction = true; break; }
              }
            }
            if (hasFraction) globalStubRow = c.row_idx;
          }
        }

        // 3. De-duplicate year header rows: if a year-header row is the same
        //    as a section-label row (like P&L at row 66 which has years AND
        //    a label), prefer a subsequent year-header row if one exists
        //    within 10 rows. The section-label row has the title in col 1
        //    plus years in data cols; the real header has "($ in Millions)"
        //    or similar plus years. Distinguish by checking if a Date row
        //    or another year-header row follows within 10 rows.
        const validYearHeaders: number[] = [];
        for (let i = 0; i < yearHeaderRows.length; i++) {
          const r = yearHeaderRows[i];
          const nextYH = yearHeaderRows[i + 1] ?? null;
          // If the next year-header row is within 10 rows, this row is
          // likely a section label — skip it in favor of the next one
          if (nextYH !== null && nextYH - r <= 10) {
            // Skip this one; the next iteration will pick up nextYH
            continue;
          }
          validYearHeaders.push(r);
        }

        if (validYearHeaders.length > 0) {
          // 4. Build section bands from valid year-header rows
          nonTemporalEndRow = validYearHeaders[0] - 1;

          for (let i = 0; i < validYearHeaders.length; i++) {
            const hdrRow = validYearHeaders[i];
            // Find Date row and Stub row near this header (within 5 rows above)
            let dateRow = globalDateRow;
            let stubRow = globalStubRow;
            // Only associate the global Date/Stub with the first section
            // if they fall within its neighborhood
            if (dateRow !== null && Math.abs(dateRow - hdrRow) > 10) dateRow = null;
            if (stubRow !== null && Math.abs(stubRow - hdrRow) > 10) stubRow = null;

            const startRow = hdrRow + 1;
            const endRow = (i + 1 < validYearHeaders.length)
              ? validYearHeaders[i + 1] - 1
              : maxRow;

            sectionBands.push({
              headerRows: dateRow !== null ? [dateRow, hdrRow] : [hdrRow],
              dateRow,
              stubRow,
              startRow,
              endRow,
            });
          }

          // Use the first valid header row as the canonical band for metadata
          headerBandRows.push(validYearHeaders[0]);
          if (globalDateRow !== null) headerBandRows.push(globalDateRow);
          orientation = "periods_across_columns";
          structureReason = "multi_section_headers_" + validYearHeaders.join("_");
        } else {
          orientation = "none";
          structureReason = "no header band found";
        }
      }

      // Confidence & debug capture (after section-level fallback)
      const bandConf = headerBandRows.length > 0
        ? Math.min(1, headerBandRows.length / 3)
        : 0;

      if (debugInfo.length < 5) {
        const sampleCols = Array.from(dataCols).slice(0, 5);
        const sampleHeaders: Record<string, string | null> = {};
        for (const col of sampleCols) {
          for (const r of headerBandRows) {
            const v = getCellValue(r, col);
            if (v) sampleHeaders[`r${r}c${col}`] = v;
          }
        }
        debugInfo.push({
          sheetName, drs, effectiveDrs, labelCol,
          dataColCount: dataCols.size,
          headerBandRows, bandConf, sampleHeaders,
          structureReason,
          sectionBands: sectionBands.map(b => ({
            headerRows: b.headerRows, dateRow: b.dateRow, stubRow: b.stubRow,
            startRow: b.startRow, endRow: b.endRow,
          })),
          nonTemporalEndRow,
        });
      }

      // Build column header path and parse periods/cases per data column.
      // For multi-section sheets (sectionBands.length > 0), build separate
      // maps per section. For normal sheets, one map covers all rows.
      interface ColMapping {
        period: ParsedPeriod | null;
        caseInfo: { label: string; key: string; source: string } | null;
        headerRaw: string | null;
      }
      // sectionColMaps[i] = per-column mapping for sectionBands[i]
      // If sectionBands is empty, colMapsDefault is used for all rows.
      const sectionColMaps: Map<number, ColMapping>[] = [];
      let colMapsDefault: Map<number, ColMapping> | null = null;

      function buildColMap(bandRows: number[], dateRow: number | null, stubRow: number | null): Map<number, ColMapping> {
        const m = new Map<number, ColMapping>();
        for (const col of dataCols) {
          const headerParts: string[] = [];
          let period: ParsedPeriod | null = null;
          let caseInfo: { label: string; key: string; source: string } | null = null;
          let basisFromBandRow: string | null = null;

          // Prefer Date row for period if available
          if (dateRow !== null) {
            const dateVal = getCellValue(dateRow, col);
            if (dateVal && getCellType(dateRow, col) === "date") {
              const parsed = parsePeriodToken(dateVal, fyEndMonth);
              if (parsed) period = parsed;
            }
          }

          for (const r of bandRows) {
            const val = getCellValue(r, col);
            if (!val || !val.trim()) continue;
            headerParts.push(val.trim());

            // Try period parse from year row (only if Date row didn't provide one)
            if (!period) {
              const parsed = parsePeriodToken(val, fyEndMonth);
              if (parsed) period = parsed;
            }

            // Try case extract
            if (!caseInfo) {
              const c = extractCase(val);
              if (c) caseInfo = { ...c, source: "band_row" };
            }

            // Try basis from band row
            if (!basisFromBandRow) {
              const b = extractBasis(val);
              if (b) basisFromBandRow = b;
            }
          }

          const headerRaw = headerParts.join(" | ") || null;

          // Apply basis
          if (period && basisFromBandRow && period.periodBasis === "unknown") {
            period.periodBasis = basisFromBandRow;
          }

          // Detect stub period from Stub row
          if (period && stubRow !== null) {
            const stubVal = getCellValue(stubRow, col);
            if (stubVal && getCellType(stubRow, col) === "number") {
              const frac = parseFloat(stubVal);
              if (frac > 0 && frac < 1) {
                period = { ...period, periodType: "stub" };
                // Adjust period label to indicate sub-annual
                const months = Math.round(frac * 12);
                period.periodLabel = period.periodLabel + ` (${months}mo stub)`;
              }
            }
          }

          m.set(col, { period, caseInfo, headerRaw });
        }
        return m;
      }

      if (sectionBands.length > 0) {
        for (const band of sectionBands) {
          sectionColMaps.push(buildColMap(band.headerRows, band.dateRow, band.stubRow));
        }
      } else {
        // Normal sheet: one column map from headerBandRows
        colMapsDefault = buildColMap(headerBandRows, null, null);
      }

      // Sheet-level case from sheet name
      let sheetCaseLabel: string | null = null;
      const sheetCase = extractCase(sheetName);
      if (sheetCase) {
        sheetCaseLabel = sheetCase.label;
        // Apply to all section maps / default map
        const allMaps = sectionColMaps.length > 0 ? sectionColMaps : (colMapsDefault ? [colMapsDefault] : []);
        for (const m of allMaps) {
          for (const col of dataCols) {
            const entry = m.get(col);
            if (entry && !entry.caseInfo) {
              entry.caseInfo = { label: sheetCase.label, key: sheetCase.key, source: "sheet_name" };
            }
          }
        }
      }

      // Scenario switch detection (look for switch-like cells)
      // A switch cell contains a switch token ("case", "scenario", "toggle",
      // "switch", "live case") and the adjacent cell to its right holds
      // the active state as a non-numeric text value.
      let scenarioSwitchCell: string | null = null;
      for (const c of cellRows) {
        if (c.value_type === "text" || c.value_type === "string") {
          const raw = (c.value_raw ?? "").trim();
          if (raw.length > 60 || !SWITCH_TOKENS.test(raw)) continue;
          const nextCell = cellByRC.get(`${c.row_idx}:${c.col_idx + 1}`);
          if (nextCell?.value_raw) {
            const adj = nextCell.value_raw.trim();
            // Skip pure numeric values (toggle flags like 0/1)
            if (/^-?\d+(\.\d+)?$/.test(adj)) continue;
            // Skip if the adjacent value is too long (likely a label, not a state)
            if (adj.length > 30) continue;
            scenarioSwitchCell = adj;
            break;
          }
        }
      }

      // Count stats from all maps
      let sheetPeriodsFound = 0;
      let sheetCasesFound = 0;
      const countedPeriodCols = new Set<number>();
      const countedCaseCols = new Set<number>();
      const allColMaps = sectionColMaps.length > 0 ? sectionColMaps : (colMapsDefault ? [colMapsDefault] : []);
      for (const m of allColMaps) {
        for (const [col, entry] of m) {
          if (entry.period && !countedPeriodCols.has(col)) { sheetPeriodsFound++; countedPeriodCols.add(col); }
          if (entry.caseInfo && !countedCaseCols.has(col)) { sheetCasesFound++; countedCaseCols.add(col); }
        }
      }

      // --- Batch update ---
      // For multi-section sheets, we update per-section with row range filters.
      // For normal sheets, one column-wide update covers all rows.

      async function batchUpdateCols(
        colMap: Map<number, ColMapping>,
        rowFilterSql: string,
        extraParams: unknown[],
        labelSuffix: string,
      ) {
        const dataColArr = Array.from(dataCols);
        const COL_BATCH = 10;
        for (let bi = 0; bi < dataColArr.length; bi += COL_BATCH) {
          const batch = dataColArr.slice(bi, bi + COL_BATCH);
          const valueClauses: string[] = [];
          const params: unknown[] = [workbookId, sheetName, ...extraParams];
          let idx = 3 + extraParams.length;
          for (const col of batch) {
            const entry = colMap.get(col);
            const period = entry?.period ?? null;
            const caseInfo = entry?.caseInfo ?? null;
            const headerRaw = entry?.headerRaw ?? null;
            valueClauses.push(
              `($${idx}::int, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10})`
            );
            params.push(
              col, headerRaw, headerRaw,
              period?.periodType ?? null, period?.periodStart ?? null,
              period?.periodEnd ?? null, period?.periodLabel ?? null,
              period?.periodBasis ?? null,
              caseInfo?.label ?? null, caseInfo?.key ?? null, caseInfo?.source ?? null,
            );
            idx += 11;
          }
          await db.execute(
            `WITH vals(ci, chp, chr, pt, ps, pe, pl, pb, cl, ck, cs) AS (
               VALUES ${valueClauses.join(", ")}
             )
             UPDATE workbook_cells c SET
               col_header_path = v.chp,
               col_header_raw = v.chr,
               period_type = v.pt,
               period_start = v.ps,
               period_end = v.pe,
               period_label = v.pl,
               period_basis = v.pb,
               case_label = v.cl,
               case_key = v.ck,
               case_source = v.cs
             FROM vals v
             WHERE c.workbook_id = $1 AND c.sheet_name = $2 AND c.col_idx = v.ci
               AND ${rowFilterSql}`,
            params,
            { label: `Phase3: update ${sheetName} ${labelSuffix} cols ${bi+1}-${bi+batch.length}` },
          );
        }
      }

      if (sectionBands.length > 0) {
        // 1. Null out non-temporal rows (above first year-header)
        if (nonTemporalEndRow >= 0) {
          await db.execute(
            `UPDATE workbook_cells SET
               col_header_path = NULL, col_header_raw = NULL,
               period_type = NULL, period_start = NULL, period_end = NULL,
               period_label = NULL, period_basis = NULL,
               case_label = NULL, case_key = NULL, case_source = NULL,
               reason = 'non_temporal_section'
             WHERE workbook_id = $1 AND sheet_name = $2 AND row_idx <= $3`,
            [workbookId, sheetName, nonTemporalEndRow],
            { label: `Phase3: null non-temporal ${sheetName} rows 0-${nonTemporalEndRow}` },
          );
        }

        // 2. Update each section band
        for (let si = 0; si < sectionBands.length; si++) {
          const band = sectionBands[si];
          const colMap = sectionColMaps[si];
          await batchUpdateCols(
            colMap,
            `c.row_idx >= $3 AND c.row_idx <= $4`,
            [band.startRow, band.endRow],
            `sect${si}(r${band.startRow}-${band.endRow})`,
          );
        }

        // 3. Null out rows between non-temporal end and first section start
        //    (metadata rows like Stub, Live?, Date)
        const metaStart = nonTemporalEndRow + 1;
        const metaEnd = sectionBands[0].startRow - 1;
        if (metaEnd >= metaStart) {
          await db.execute(
            `UPDATE workbook_cells SET
               period_type = NULL, period_start = NULL, period_end = NULL,
               period_label = NULL, period_basis = NULL,
               reason = CASE WHEN reason IS NULL THEN 'header_row' ELSE reason END
             WHERE workbook_id = $1 AND sheet_name = $2
               AND row_idx >= $3 AND row_idx <= $4`,
            [workbookId, sheetName, metaStart, metaEnd],
            { label: `Phase3: null meta rows ${sheetName} ${metaStart}-${metaEnd}` },
          );
        }
      } else if (colMapsDefault) {
        // Normal sheet: column-wide update
        await batchUpdateCols(colMapsDefault, `TRUE`, [], `all`);
      }

      totalCellsUpdated += cellRows.length;
      totalPeriodsFound += sheetPeriodsFound;
      totalCasesFound += sheetCasesFound;

      // Update sheet metadata
      await db.execute(
        `UPDATE workbook_sheets SET
           header_band_rows = $3::jsonb,
           header_band_confidence = $4,
           orientation = $5,
           structure_reason = $6,
           sheet_case_label = $7,
           scenario_switch_cell = $8
         WHERE workbook_id = $1 AND sheet_name = $2`,
        [
          workbookId, sheetName,
          JSON.stringify(headerBandRows), bandConf,
          orientation, structureReason,
          sheetCaseLabel, scenarioSwitchCell,
        ],
        { label: `Phase3: update sheet meta ${sheetName}` },
      );
    }

    // --- Active case label ---
    // Collect scenario_switch_cell values across all processed sheets.
    // These represent the live/active case state of the workbook.
    const switchValues = await db.query(
      `SELECT sheet_name, scenario_switch_cell FROM workbook_sheets
       WHERE workbook_id = $1 AND scenario_switch_cell IS NOT NULL
       ORDER BY sheet_index`,
      z.object({ sheet_name: z.string(), scenario_switch_cell: z.string() }),
      [workbookId],
      { label: "Phase3: collect switch cells" },
    );
    if (switchValues.length > 0) {
      // Build a composite label from all switch values
      const parts = switchValues.map(s => s.scenario_switch_cell);
      const activeCaseLabel = parts.join("; ");
      await db.execute(
        `UPDATE workbooks SET active_case_label = $2, active_case_source = 'scenario_switch_cells'
         WHERE id = $1`,
        [workbookId, activeCaseLabel],
        { label: "Phase3: set active case label" },
      );
    }

    return {
      sheetsProcessed: sheets.length,
      cellsUpdated: totalCellsUpdated,
      periodsFound: totalPeriodsFound,
      casesFound: totalCasesFound,
      fiscalYearEnd: fyEndMonth,
      fiscalYearEndSource: fyEndSource,
      debug: debugInfo,
    };
  },
});
