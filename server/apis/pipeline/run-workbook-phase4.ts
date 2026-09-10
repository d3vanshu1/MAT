import { api, z, postgres } from "@superblocksteam/sdk-api";
import { parseExcelFormat } from "../../lib/excelFormatParser.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Unit / currency / scale detection from text (column headers, sheet titles)
// ---------------------------------------------------------------------------

/** What a text source tells us about unit, currency, and scale. */
interface TextUnitInfo {
  unitClass: "currency" | null;  // only currency is inferable from text
  currency: string | null;       // USD, GBP, EUR, etc.
  multiplier: number;            // 1, 1000, 1000000
}

const CURRENCY_SYMBOLS_TEXT: Record<string, string> = {
  "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY",
  "US$": "USD", "A$": "AUD", "C$": "CAD", "R$": "BRL",
};

/**
 * Parse a text string (column header, sheet title, note row) for
 * unit, currency, and scale information.
 *
 * Returns null if no signal found.
 */
function detectUnitFromText(text: string): TextUnitInfo | null {
  // Detect currency symbol
  let currency: string | null = null;
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS_TEXT)) {
    if (text.includes(sym)) { currency = code; break; }
  }

  // Detect scale
  let multiplier = 1;
  if (/\b(?:in\s+)?millions?\b|\$m\b|\([$£€]m\)|mm\b/i.test(text)) {
    multiplier = 1_000_000;
  } else if (/\$000|\b(?:in\s+)?thousands?\b|\$k\b|\([$£€]k\)/i.test(text)) {
    multiplier = 1_000;
  } else if (/\b(?:in\s+)?billions?\b|\$b\b/i.test(text)) {
    multiplier = 1_000_000_000;
  }

  if (!currency && multiplier === 1) return null;

  return {
    unitClass: currency ? "currency" : null,
    currency,
    multiplier,
  };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export default api({
  name: "RunWorkbookPhase4",
  description: "Classifies unit, currency, scale, and decimals per cell.",
  integrations: {
    ic_diligence_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
    sheetNames: z.array(z.string()).optional(),
  }),
  output: z.object({
    sheetsProcessed: z.number(),
    cellsUpdated: z.number(),
    unitClassCounts: z.record(z.string(), z.number()),
    unitSourceCounts: z.record(z.string(), z.number()),
    currencyCounts: z.record(z.string(), z.number()),
    scaleCounts: z.record(z.string(), z.number()),
    scaleSourceCounts: z.record(z.string(), z.number()),
    debug: z.array(z.any()).optional(),
  }),
  async run(ctx, { workbookId, sheetNames }) {
    const db = ctx.integrations.ic_diligence_db;

    // Load workbook metadata
    const wbMeta = await db.query(
      `SELECT file_hash, capture_version, parsed_at, workbook_role
       FROM workbooks WHERE id = $1`,
      z.object({
        file_hash: z.string().nullable(),
        capture_version: z.number().nullable(),
        parsed_at: z.string().nullable(),
        workbook_role: z.string().nullable(),
      }),
      [workbookId],
      { label: "Phase4: load workbook meta" },
    );

    // Load sheet list
    const allSheets = await db.query(
      `SELECT sheet_name, data_region_start, label_col, header_band_rows
       FROM workbook_sheets WHERE workbook_id = $1 ORDER BY sheet_index`,
      z.object({
        sheet_name: z.string(),
        data_region_start: z.number().nullable(),
        label_col: z.number().nullable(),
        header_band_rows: z.any(),
      }),
      [workbookId],
      { label: "Phase4: load sheets" },
    );

    const filterSet = sheetNames ? new Set(sheetNames) : null;
    const sheets = filterSet
      ? allSheets.filter((s) => filterSet.has(s.sheet_name))
      : allSheets;

    // Aggregate counters
    const unitClassCounts: Record<string, number> = {};
    const unitSourceCounts: Record<string, number> = {};
    const currencyCounts: Record<string, number> = {};
    const scaleCounts: Record<string, number> = {};
    const scaleSourceCounts: Record<string, number> = {};
    let totalCellsUpdated = 0;
    const debugInfo: Array<Record<string, unknown>> = [];

    for (const sheet of sheets) {
      const sheetName = sheet.sheet_name;
      const labelCol = sheet.label_col ?? 0;

      // --- Step 4.2: Detect scale from column headers ---
      // Check header band rows for scale indicators
      const headerBandRows: number[] = Array.isArray(sheet.header_band_rows)
        ? sheet.header_band_rows
        : [];
      // Sheet-level unit info: unit_class, currency, and scale from
      // the sheet title or header band text. Applied to cells that don't
      // have their own format-level signals (percent, multiple, date, text).
      let sheetUnitInfo: (TextUnitInfo & { source: string }) | null = null;

      // Check sheet title (first few rows) AND header band rows.
      // Multi-section sheets like LBO Model have "($ in Millions)" at the
      // header band row (e.g. B72), not in the first few rows.
      const hdrRowFilter = headerBandRows.length > 0
        ? ` OR row_idx IN (${headerBandRows.map((_, i) => "$" + (4 + i)).join(", ")})`
        : "";
      const titleParams: unknown[] = [workbookId, sheetName, labelCol + 3];
      for (const hr of headerBandRows) titleParams.push(hr);

      const titleCells = await db.query(
        `SELECT value_raw FROM workbook_cells
         WHERE workbook_id = $1 AND sheet_name = $2
           AND col_idx <= $3
           AND value_type IN ('text', 'string')
           AND (row_idx < 5${hdrRowFilter})
         ORDER BY row_idx LIMIT 20`,
        z.object({ value_raw: z.string().nullable() }),
        titleParams,
        { label: `Phase4: title cells ${sheetName}` },
      );

      // Scan ALL title cells and prefer the one with the most complete info.
      // A bare "$" column label should not beat "($ in Millions)" which has
      // both currency and scale. Priority: scale+currency > scale > currency.
      let bestTitleInfo: (TextUnitInfo & { source: string }) | null = null;
      let bestTitleScore = 0;
      for (const tc of titleCells) {
        if (tc.value_raw) {
          const info = detectUnitFromText(tc.value_raw);
          if (info) {
            const score = (info.currency ? 1 : 0) + (info.multiplier > 1 ? 2 : 0);
            if (score > bestTitleScore) {
              bestTitleScore = score;
              bestTitleInfo = { ...info, source: "sheet_title" };
            }
          }
        }
      }
      if (bestTitleInfo) sheetUnitInfo = bestTitleInfo;

      // Check column header text for unit/scale
      if (!sheetUnitInfo && headerBandRows.length > 0) {
        const headerCells = await db.query(
          `SELECT col_idx, col_header_raw FROM workbook_cells
           WHERE workbook_id = $1 AND sheet_name = $2
             AND col_idx > $3 AND col_header_raw IS NOT NULL
           GROUP BY col_idx, col_header_raw
           LIMIT 50`,
          z.object({ col_idx: z.number(), col_header_raw: z.string() }),
          [workbookId, sheetName, labelCol],
          { label: `Phase4: header unit ${sheetName}` },
        );
        for (const hc of headerCells) {
          const info = detectUnitFromText(hc.col_header_raw);
          if (info) {
            sheetUnitInfo = { ...info, source: "column_header" };
            break;
          }
        }
      }

      // --- Step 4.1 + 4.2: Process cells in batches ---
      let offset = 0;
      const PAGE = 2000;
      let sheetCellsUpdated = 0;

      while (true) {
        const cells = await db.query(
          `SELECT id, value_type, number_format, col_header_raw
           FROM workbook_cells
           WHERE workbook_id = $1 AND sheet_name = $2
             AND value_type IN ('number', 'date')
           ORDER BY row_idx, col_idx
           LIMIT $3 OFFSET $4`,
          z.object({
            id: z.string(),
            value_type: z.string(),
            number_format: z.string().nullable(),
            col_header_raw: z.string().nullable(),
          }),
          [workbookId, sheetName, PAGE, offset],
          { label: `Phase4: cells ${sheetName} off ${offset}` },
        );

        if (cells.length === 0) break;

        // Build batch update values
        const BATCH_SIZE = 200;
        for (let bi = 0; bi < cells.length; bi += BATCH_SIZE) {
          const batch = cells.slice(bi, bi + BATCH_SIZE);
          const valueClauses: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          for (const cell of batch) {
            const parsed = parseExcelFormat(cell.number_format, cell.value_type);

            let unitClass: string | null = null;
            let currency: string | null = null;
            let decimals: number | null = null;
            let scaleMultiplier: number = 1;
            let scaleSource: string = "none";
            let unitSource: string = "none";

            if (parsed) {
              unitClass = parsed.unitClass;
              currency = parsed.currency;
              decimals = parsed.decimals;
              unitSource = "cell_format";

              // Scale from format trailing commas
              if (parsed.scaleFromFormat > 1) {
                scaleMultiplier = parsed.scaleFromFormat;
                scaleSource = "cell_format";
              }
            } else if (cell.value_type === "date") {
              unitClass = "date";
              unitSource = "value_type";
            }
            // No format string and number type → unknown. General tells you
            // nothing — unit, currency, and scale all come from context.
            // Never default a unit class without evidence.

            // Which cells can inherit unit/currency/scale from text context?
            // Cells already classified as percent, multiple, date, or text
            // are self-describing — they never inherit external context.
            const selfDescribing = unitClass === "percent" || unitClass === "multiple"
              || unitClass === "date" || unitClass === "text";

            // Can this cell's unit_class be upgraded by context?
            // count/ratio from format are generic — a "#,##0" cell on a
            // sheet titled "($ in Millions)" is a dollar amount, not a count.
            // Only percent/multiple/date/text are immune to context upgrade.
            const canUpgradeClass = !selfDescribing
              && (unitClass === "count" || unitClass === "ratio" || !unitClass);

            // Apply column header unit/scale
            if (!selfDescribing && cell.col_header_raw) {
              const colInfo = detectUnitFromText(cell.col_header_raw);
              if (colInfo) {
                if (colInfo.unitClass && canUpgradeClass) {
                  unitClass = colInfo.unitClass;
                  unitSource = "column_header";
                }
                if (colInfo.currency && !currency) currency = colInfo.currency;
                if (colInfo.multiplier > 1 && scaleSource === "none") {
                  scaleMultiplier = colInfo.multiplier;
                  scaleSource = "column_header";
                }
              }
            }

            // Apply sheet-level unit/scale as last fallback
            if (!selfDescribing && sheetUnitInfo) {
              if (sheetUnitInfo.unitClass && canUpgradeClass && unitSource !== "column_header") {
                unitClass = sheetUnitInfo.unitClass;
                unitSource = sheetUnitInfo.source;
              }
              if (sheetUnitInfo.currency && !currency) {
                currency = sheetUnitInfo.currency;
              }
              if (sheetUnitInfo.multiplier > 1 && scaleSource === "none") {
                scaleMultiplier = sheetUnitInfo.multiplier;
                scaleSource = sheetUnitInfo.source;
              }
            }

            valueClauses.push(
              `($${idx}::uuid, $${idx+1}, $${idx+2}, $${idx+3}::int, $${idx+4}::numeric, $${idx+5}, $${idx+6})`
            );
            params.push(
              cell.id,
              unitClass, currency, decimals,
              scaleMultiplier, scaleSource, unitSource,
            );
            idx += 7;

            // Aggregate stats
            if (unitClass) unitClassCounts[unitClass] = (unitClassCounts[unitClass] ?? 0) + 1;
            if (unitSource) unitSourceCounts[unitSource] = (unitSourceCounts[unitSource] ?? 0) + 1;
            if (currency) currencyCounts[currency] = (currencyCounts[currency] ?? 0) + 1;
            const scaleLabel = scaleMultiplier === 1 ? "1x" : scaleMultiplier === 1000 ? "1000x" : scaleMultiplier === 1_000_000 ? "1000000x" : String(scaleMultiplier) + "x";
            scaleCounts[scaleLabel] = (scaleCounts[scaleLabel] ?? 0) + 1;
            if (scaleSource) scaleSourceCounts[scaleSource] = (scaleSourceCounts[scaleSource] ?? 0) + 1;
          }

          // Batch UPDATE via CTE
          await db.execute(
            `WITH vals(cid, uc, cur, dec, sm, ss, us) AS (
               VALUES ${valueClauses.join(", ")}
             )
             UPDATE workbook_cells c SET
               unit_class = v.uc,
               currency = v.cur,
               decimals = v.dec,
               scale_multiplier = v.sm,
               scale_source = v.ss,
               unit_source = v.us
             FROM vals v
             WHERE c.id = v.cid`,
            params,
            { label: `Phase4: update ${sheetName} batch ${bi}` },
          );

          sheetCellsUpdated += batch.length;
        }

        if (cells.length < PAGE) break;
        offset += PAGE;
      }

      totalCellsUpdated += sheetCellsUpdated;

      if (debugInfo.length < 5) {
        debugInfo.push({
          sheetName,
          cellsProcessed: sheetCellsUpdated,
          sheetUnitInfo,
        });
      }
    }

    return {
      sheetsProcessed: sheets.length,
      cellsUpdated: totalCellsUpdated,
      unitClassCounts,
      unitSourceCounts,
      currencyCounts,
      scaleCounts,
      scaleSourceCounts,
      debug: debugInfo,
    };
  },
});
