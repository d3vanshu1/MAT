import { api, z, postgres } from "@superblocksteam/sdk-api";
import { parseExcelFormat, formatDisplayValue } from "../../lib/excelFormatParser.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Unit / currency / scale detection from text (column headers, sheet titles)
// ---------------------------------------------------------------------------

/** What a text source tells us about unit, currency, and scale. */
interface TextUnitInfo {
  unitClass: "currency" | "percent" | "multiple" | "count" | "text" | null;
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
// Unit / scale detection from row labels (R1 precedence level 2)
// ---------------------------------------------------------------------------

/** What a row label tells us about unit and scale. */
interface LabelUnitInfo {
  unitClass: "currency" | "percent" | "multiple" | "count" | "text" | null;
  currency: string | null;
  multiplier: number;
}

/**
 * Parse a row label for explicit unit/scale indicators.
 * Level 2 in the precedence chain — overrides sheet title, overridden by cell format.
 */
function detectUnitFromLabel(label: string): LabelUnitInfo | null {
  if (!label) return null;

  // --- Explicit currency + scale in label (CHECK FIRST) ---
  // "($k)", "($ in thousands)", "($m)", "($ in millions)", "(£m)"
  // Must come before count detection so "per Head ($k)" is currency, not count.
  const labelCurrencyScale = label.match(/\(\s*([\$£€])\s*(?:in\s+)?(k|m|mm|thousands?|millions?|billions?)?\s*\)/i);
  if (labelCurrencyScale) {
    const sym = labelCurrencyScale[1];
    const currency = CURRENCY_SYMBOLS_TEXT[sym] ?? "USD";
    const scaleWord = (labelCurrencyScale[2] ?? "").toLowerCase();
    let multiplier = 1;
    if (scaleWord === "k" || scaleWord.startsWith("thousand")) multiplier = 1_000;
    else if (scaleWord === "m" || scaleWord === "mm" || scaleWord.startsWith("million")) multiplier = 1_000_000;
    else if (scaleWord.startsWith("billion")) multiplier = 1_000_000_000;
    return { unitClass: "currency", currency, multiplier };
  }

  // --- Count / non-currency indicators ---
  // Labels beginning with '#' or containing count-family words → count, never currency
  // Checked AFTER explicit currency so "per Head ($k)" gets currency, not count.
  if (/^#\s|\bnumber of\b|\bcount\b|\bsites\b|\b(?:head|heads|headcount)\b|\bFTE\b|\bper\s+(?:site|head|FTE|rep|unit)\b/i.test(label)) {
    return { unitClass: "count", currency: null, multiplier: 1 };
  }

  // --- Percent in label ---
  // "(%)", "% YoY", "% of Total", "margin %"
  if (/\(%\)|%\s+(?:YoY|of|change|margin)|margin\s*%|\b%\b/i.test(label)) {
    return { unitClass: "percent", currency: null, multiplier: 1 };
  }

  // --- Multiple in label ---
  // "(x)", "turns"
  if (/\(x\)|\bturns\b/i.test(label)) {
    return { unitClass: "multiple", currency: null, multiplier: 1 };
  }

  return null;
}

/**
 * Check whether a cell's number format is a literal-text identifier
 * (e.g. '"Sales Rep" "#"General') rather than a real numeric format.
 * If more than half the positive section is literal text, it's an identifier.
 */
function isLiteralTextFormat(fmt: string | null): boolean {
  if (!fmt) return false;
  const pos = fmt.split(";")[0] ?? "";
  // Count characters inside quotes
  let quotedLen = 0;
  let inQuote = false;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] === '"' && (i === 0 || pos[i-1] !== '\\')) {
      inQuote = !inQuote;
    } else if (inQuote) {
      quotedLen++;
    }
  }
  // If more than half the positive section is quoted text, it's an identifier
  const nonQuoteLen = pos.length - quotedLen - (pos.split('"').length - 1);
  return quotedLen > 0 && quotedLen >= nonQuoteLen;
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
          `SELECT id, value_type, number_format, col_header_raw, row_label, value_num::float AS value_num
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
            row_label: z.string().nullable(),
            value_num: z.number().nullable(),
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
            // --- R1: Literal-text format guard ---
            // Formats like '"Sales Rep" "#"General' are identifiers, not numbers.
            if (isLiteralTextFormat(cell.number_format)) {
              // For text formats, display_value is the formatted text
              const textDisplay = formatDisplayValue(cell.value_num, cell.number_format);
              valueClauses.push(
                `($${idx}::uuid, $${idx+1}, $${idx+2}, $${idx+3}::int, $${idx+4}::numeric, $${idx+5}, $${idx+6}, $${idx+7})`
              );
              params.push(cell.id, "text", null, 0, 1, "none", "cell_format", textDisplay);
              idx += 8;
              unitClassCounts["text"] = (unitClassCounts["text"] ?? 0) + 1;
              unitSourceCounts["cell_format"] = (unitSourceCounts["cell_format"] ?? 0) + 1;
              scaleCounts["1x"] = (scaleCounts["1x"] ?? 0) + 1;
              scaleSourceCounts["none"] = (scaleSourceCounts["none"] ?? 0) + 1;
              continue;
            }

            const parsed = parseExcelFormat(cell.number_format, cell.value_type);

            let unitClass: string | null = null;
            let currency: string | null = null;
            let decimals: number | null = null;
            let scaleMultiplier: number = 1;
            let scaleSource: string = "none";
            let unitSource: string = "none";

            // --- Level 1: Cell's own number format (strongest) ---
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

            // Which cells are self-describing? percent, multiple, date, text
            // from the format are definitive — they never inherit external context.
            const selfDescribing = unitClass === "percent" || unitClass === "multiple"
              || unitClass === "date" || unitClass === "text";

            // --- Level 2: Row label (R1 — overrides sheet title, not cell format) ---
            // A label that states its own units wins over the sheet title.
            // Labels beginning with '#' or containing count-family words → count, not currency.
            let labelInfo: LabelUnitInfo | null = null;
            if (!selfDescribing && cell.row_label) {
              labelInfo = detectUnitFromLabel(cell.row_label);
              if (labelInfo) {
                // Label-detected count/percent/multiple override format-level count/ratio/null
                if (labelInfo.unitClass === "count") {
                  // Count from label is definitive — never upgrade to currency
                  unitClass = "count";
                  unitSource = "row_label";
                  // Count rows don't inherit scale from sheet title
                  scaleMultiplier = 1;
                  scaleSource = "none";
                } else if (labelInfo.unitClass === "percent") {
                  unitClass = "percent";
                  unitSource = "row_label";
                  scaleMultiplier = 1;
                  scaleSource = "none";
                } else if (labelInfo.unitClass === "multiple") {
                  unitClass = "multiple";
                  unitSource = "row_label";
                  scaleMultiplier = 1;
                  scaleSource = "none";
                } else if (labelInfo.unitClass === "currency") {
                  // Label says currency with explicit scale (e.g. "($k)")
                  if (!unitClass || unitClass === "count" || unitClass === "ratio") {
                    unitClass = "currency";
                    unitSource = "row_label";
                  }
                  if (!currency && labelInfo.currency) currency = labelInfo.currency;
                  if (labelInfo.multiplier > 1 && scaleSource === "none") {
                    scaleMultiplier = labelInfo.multiplier;
                    scaleSource = "row_label";
                  }
                }
              }
            }

            // Can this cell's unit_class still be upgraded by context (col header / sheet title)?
            // After label processing: only if still generic (count/ratio/null from format)
            // AND the label didn't override to a definitive type.
            const labelDecided = labelInfo !== null;
            const canUpgradeClass = !selfDescribing && !labelDecided
              && (unitClass === "count" || unitClass === "ratio" || !unitClass);

            // --- Level 3: Column header ---
            if (!selfDescribing && !labelDecided && cell.col_header_raw) {
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

            // --- Level 4: Sheet title (weakest) ---
            if (!selfDescribing && !labelDecided && sheetUnitInfo) {
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

            // --- Plausibility trip-wire (R1) ---
            // If scale came from sheet_title and makes this cell implausibly large,
            // reject it. Two checks:
            //   1. Absolute ceiling: any single cell > $500M is suspect for a sub-$200M company
            //   2. Relative ceiling: value_raw > 100 with 1M scale → $100M+, suspicious
            //      for non-aggregate rows (the value is already large in absolute terms)
            // Only trip if the cell format doesn't contain a currency symbol.
            if (scaleSource === "sheet_title" && cell.value_num !== null && scaleMultiplier > 1) {
              const absRaw = Math.abs(cell.value_num);
              const scaledAbs = absRaw * scaleMultiplier;
              const formatHasCurrency = parsed?.currency != null;
              if (!formatHasCurrency) {
                // Trip-wire 1: absolute ceiling at $500M
                if (scaledAbs > 500_000_000) {
                  scaleMultiplier = 1;
                  scaleSource = "rejected_implausible";
                }
                // Trip-wire 2: raw value already large (>100) and scale is 1M+
                // → the cell's own magnitude suggests it's already in display units.
                // E.g., 160 on a "$M" sheet → $160M, but the cell is probably $160K.
                // Only trip if raw > 100 AND scale >= 1M (raw 0–100 is normal for $M sheets).
                else if (absRaw > 100 && scaleMultiplier >= 1_000_000) {
                  scaleMultiplier = 1;
                  scaleSource = "rejected_implausible";
                }
              }
            }

            // R4: compute display_value
            const displayVal = formatDisplayValue(cell.value_num, cell.number_format);

            valueClauses.push(
              `($${idx}::uuid, $${idx+1}, $${idx+2}, $${idx+3}::int, $${idx+4}::numeric, $${idx+5}, $${idx+6}, $${idx+7})`
            );
            params.push(
              cell.id,
              unitClass, currency, decimals,
              scaleMultiplier, scaleSource, unitSource, displayVal,
            );
            idx += 8;

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
            `WITH vals(cid, uc, cur, dec, sm, ss, us, dv) AS (
               VALUES ${valueClauses.join(", ")}
             )
             UPDATE workbook_cells c SET
               unit_class = v.uc,
               currency = v.cur,
               decimals = v.dec,
               scale_multiplier = v.sm,
               scale_source = v.ss,
               unit_source = v.us,
               display_value = v.dv
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
