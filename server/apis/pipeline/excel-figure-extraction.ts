/**
 * excel-figure-extraction.ts — Extract reference figures from Excel doc_tables
 * and Financial DD report narratives for the CC pipeline.
 *
 * Two extraction paths:
 *   1. Excel tables (doc_tables) — financial_model tagged documents
 *      Converts cell JSON to plaintext table, LLM extracts structured figures.
 *   2. DD report narratives (parsed_text) — consultant_report tagged documents
 *      LLM extracts numeric figures from narrative text of Financial DD reports.
 *
 * Both paths insert into `reference_figures` table, which is consumed by
 * the reconciliation pipeline's `loadReferenceFigures()`.
 *
 * Checkpoint: keyed by "excel_figure_extraction" on the module_run_id.
 */
import { z } from "@superblocksteam/sdk-api";
import { MessageResponseSchema, type LLMResponse } from "./call-llm.js";
import { HAIKU_MODEL } from "./model-config.js";
import type { PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sheets that are metadata / cover pages — skip these */
const SKIP_SHEETS = new Set([
  "__generation_manifest__",
  "Cover",
  "cover",
  "Table of Contents",
  "Instructions",
]);

/** Max characters of table text per LLM call */
const MAX_TABLE_TEXT_CHARS = 60_000;

/** Max characters of narrative text per LLM call */
const MAX_NARRATIVE_CHARS = 80_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocTableRow {
  id: string;
  document_id: string;
  sheet_or_page: string;
  caption: string | null;
  data: { cells: Array<{ r: number; c: number; type: string; value: string | number | null }> };
}

interface ExtractedFigure {
  row_label: string;
  metric: string;
  scope_qualifier: string;
  period: string;
  value: number;
  basis: string | null;
  scenario: string | null;
}

export interface ExcelExtractionResult {
  tablesProcessed: number;
  narrativesProcessed: number;
  figuresInserted: number;
  figuresSkipped: number;
  errors: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// LLM prompt for Excel table extraction
// ---------------------------------------------------------------------------

const EXCEL_EXTRACTION_PROMPT = `You are a financial data extraction specialist. Given a spreadsheet table rendered as plaintext, extract ALL numeric financial figures into structured JSON.

RULES:
1. Extract every row that contains a numeric financial value (revenue, EBITDA, costs, margins, growth rates, capex, headcount, sites, etc.)
2. Each figure needs: row_label (the label from column A/B), metric (category), scope_qualifier (what it measures), period (e.g. "2024A", "2025E"), value (the number), basis (unit scale like "millions", "thousands", or null), scenario (e.g. "base", "upside", or null)
3. The metric field must be one of: revenue, EBITDA, gross_margin, net_income, cost, capex, cash_flow, growth_rate, headcount, sites, multiple, returns, margin_pct, other_financial
4. The scope_qualifier should be descriptive: "Total Revenue", "Revenue (segment: Oncology)", "Adjusted EBITDA", "SG&A Expenses", etc.
5. Pay attention to the caption for unit scale (e.g. "$ in millions" means all values are in millions)
6. For percentage values (margins, growth rates), store as decimal (e.g. 15% → 0.15)
7. Distinguish actual (A) vs estimate (E) vs budget (B) periods from column headers
8. Skip subtotals/totals ONLY if the constituent line items are also present — if only the total is shown, extract it
9. Skip purely formulaic rows (e.g. "% Growth" between two line items that just compute the delta)

OUTPUT FORMAT: Return a JSON array of objects. No markdown, no explanation, just the array.
Example:
[
  {"row_label": "Total Revenue", "metric": "revenue", "scope_qualifier": "Total Revenue", "period": "2024A", "value": 25.3, "basis": "millions", "scenario": null},
  {"row_label": "Adjusted EBITDA", "metric": "EBITDA", "scope_qualifier": "Adjusted EBITDA", "period": "2024A", "value": 8.1, "basis": "millions", "scenario": null}
]

If no extractable figures exist, return an empty array: []`;

// ---------------------------------------------------------------------------
// LLM prompt for DD report narrative extraction
// ---------------------------------------------------------------------------

const NARRATIVE_EXTRACTION_PROMPT = `You are a financial data extraction specialist. Given a section of a Financial Due Diligence report, extract ALL numeric financial figures mentioned in the narrative text.

RULES:
1. Extract every quantitative financial figure (revenue, EBITDA, costs, margins, growth, headcount, deal multiples, etc.)
2. Each figure needs: row_label (descriptive label from context), metric (category), scope_qualifier (what it measures), period (year or date range), value (the number), basis (unit scale like "millions", "thousands", or null), scenario (e.g. "management case" or null)
3. The metric field must be one of: revenue, EBITDA, gross_margin, net_income, cost, capex, cash_flow, growth_rate, headcount, sites, multiple, returns, margin_pct, other_financial
4. Convert all values to their stated unit: "$25.3 million" → value: 25.3, basis: "millions"
5. For percentage values, store as decimal (15% → 0.15, metric should be margin_pct or growth_rate)
6. Scope qualifier should capture the full context: "Revenue (segment: Digital Advertising)", "Adjusted EBITDA (pro forma)", "Management Case Revenue"
7. If a figure has no clear period, use "unspecified"
8. Extract figures from tables embedded in the narrative as well
9. Do NOT extract ranges — extract each bound separately with a note in scope_qualifier (e.g. "Revenue (low case)" and "Revenue (high case)")

OUTPUT FORMAT: Return a JSON array of objects. No markdown, no explanation, just the array.
[
  {"row_label": "Pro Forma Revenue", "metric": "revenue", "scope_qualifier": "Pro Forma Revenue", "period": "2024A", "value": 45.2, "basis": "millions", "scenario": null}
]

If no extractable figures exist, return an empty array: []`;

// ---------------------------------------------------------------------------
// Cell grid → plaintext table
// ---------------------------------------------------------------------------

function cellGridToText(
  cells: Array<{ r: number; c: number; type: string; value: string | number | null }>,
  caption: string | null,
): string {
  if (!cells || cells.length === 0) return "";

  // Build sparse grid
  var maxR = 0;
  var maxC = 0;
  for (var i = 0; i < cells.length; i++) {
    if (cells[i].r > maxR) maxR = cells[i].r;
    if (cells[i].c > maxC) maxC = cells[i].c;
  }

  // Cap dimensions to prevent memory blowup on malformed data
  if (maxR > 500) maxR = 500;
  if (maxC > 50) maxC = 50;

  var grid: string[][] = [];
  for (var r = 0; r <= maxR; r++) {
    var row: string[] = [];
    for (var c = 0; c <= maxC; c++) {
      row.push("");
    }
    grid.push(row);
  }

  for (var j = 0; j < cells.length; j++) {
    var cell = cells[j];
    if (cell.r > maxR || cell.c > maxC) continue;
    var val = cell.value;
    if (val === null || val === undefined) continue;
    grid[cell.r][cell.c] = String(val);
  }

  // Render as pipe-delimited table
  var lines: string[] = [];
  if (caption) {
    lines.push("## " + caption);
    lines.push("");
  }

  for (var rr = 0; rr <= maxR; rr++) {
    var rowLine = grid[rr].join(" | ");
    // Skip entirely empty rows
    if (rowLine.replace(/\s*\|\s*/g, "").trim() === "") continue;
    lines.push(rowLine);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse LLM JSON response
// ---------------------------------------------------------------------------

function parseFiguresResponse(text: string): ExtractedFigure[] {
  // Strip markdown code fence if present
  var cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    // Strip opening fence: ```json or ``` followed by whitespace/newlines
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "");
    // Strip closing fence: ``` at end (possibly with trailing whitespace)
    cleaned = cleaned.replace(/\n?\s*```\s*$/, "");
  }

  try {
    var parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // JSON may be truncated (max_tokens hit). Try to salvage by closing the array.
      // Find the last complete object (ends with })
      var lastBrace = cleaned.lastIndexOf("}");
      if (lastBrace > 0) {
        var salvaged = cleaned.slice(0, lastBrace + 1) + "]";
        // Make sure it starts with [
        if (!salvaged.trimStart().startsWith("[")) salvaged = "[" + salvaged;
        try {
          parsed = JSON.parse(salvaged);
          console.log("[EXCEL-EXTRACT] Salvaged truncated JSON: " + (Array.isArray(parsed) ? parsed.length : 0) + " figures recovered");
        } catch {
          console.log("[EXCEL-EXTRACT] Could not salvage truncated JSON, length=" + cleaned.length);
          return [];
        }
      } else {
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];

    var figures: ExtractedFigure[] = [];
    for (var i = 0; i < parsed.length; i++) {
      var item = parsed[i];
      if (!item || typeof item !== "object") continue;
      if (typeof item.value !== "number" || isNaN(item.value)) continue;
      if (!item.row_label || !item.metric || !item.period) continue;

      figures.push({
        row_label: String(item.row_label),
        metric: String(item.metric),
        scope_qualifier: String(item.scope_qualifier || item.row_label),
        period: String(item.period),
        value: item.value,
        basis: item.basis ? String(item.basis) : null,
        scenario: item.scenario ? String(item.scenario) : null,
      });
    }
    return figures;
  } catch {
    console.log("[EXCEL-EXTRACT] Failed to parse LLM response as JSON, length=" + text.length);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalize extracted value to raw numeric (apply basis multiplier)
// ---------------------------------------------------------------------------

function normalizeValue(value: number, basis: string | null): number {
  if (!basis) return value;
  var b = basis.toLowerCase();
  if (b === "millions" || b === "million" || b === "mm" || b === "m") return value * 1_000_000;
  if (b === "thousands" || b === "thousand" || b === "k" || b === "000s" || b === "000") return value * 1_000;
  if (b === "billions" || b === "billion" || b === "b" || b === "bn") return value * 1_000_000_000;
  return value;
}

// ---------------------------------------------------------------------------
// Detect unit scale from caption text
// ---------------------------------------------------------------------------

function detectBasisFromCaption(caption: string | null): string | null {
  if (!caption) return null;
  var lower = caption.toLowerCase();
  if (lower.indexOf("in millions") !== -1 || lower.indexOf("in mm") !== -1 || lower.indexOf("$ in m") !== -1) return "millions";
  if (lower.indexOf("in thousands") !== -1 || lower.indexOf("in 000s") !== -1 || lower.indexOf("in 000") !== -1 || lower.indexOf("$ in 000") !== -1) return "thousands";
  if (lower.indexOf("in billions") !== -1) return "billions";
  return null;
}

// ---------------------------------------------------------------------------
// Main: Extract figures from Excel doc_tables
// ---------------------------------------------------------------------------

export async function extractFiguresFromExcel(
  ctx: PipelineContext,
  dealId: string,
  pipelineStartTime: number,
  timeBudgetMs: number,
): Promise<{ figures: ExtractedFigure[]; tablesProcessed: number; errors: string[] }> {
  var db = ctx.integrations.db;
  var startTime = Date.now();

  // Load all doc_tables for financial_model tagged documents
  var tables = await db.query(
    "SELECT dt.id, dt.document_id, dt.sheet_or_page, dt.caption, dt.data " +
    "FROM doc_tables dt " +
    "JOIN documents d ON d.id = dt.document_id " +
    "WHERE d.deal_id = $1 AND d.document_tag = 'financial_model' " +
    "AND dt.sheet_or_page NOT IN ('__generation_manifest__') " +
    "ORDER BY d.file_name, dt.sheet_or_page",
    z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
      caption: z.string().nullable(),
      data: z.any(),
    }),
    [dealId],
    { label: "EXCEL-EXTRACT: load doc_tables for financial_model docs" },
  );

  console.log("[EXCEL-EXTRACT] Loaded " + tables.length + " table sheets for deal " + dealId);

  var allFigures: ExtractedFigure[] = [];
  var tablesProcessed = 0;
  var errors: string[] = [];

  // Group tables by document_id to batch LLM calls
  var tablesByDoc = new Map<string, typeof tables>();
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i];
    if (SKIP_SHEETS.has(t.sheet_or_page)) continue;
    var cells = t.data && t.data.cells;
    if (!cells || !Array.isArray(cells) || cells.length === 0) continue;

    var arr = tablesByDoc.get(t.document_id);
    if (!arr) {
      arr = [];
      tablesByDoc.set(t.document_id, arr);
    }
    arr.push(t);
  }

  // Process each document's tables
  for (var entry of tablesByDoc.entries()) {
    var docId = entry[0];
    var docTables = entry[1];

    // Check budget
    if (Date.now() - startTime > timeBudgetMs) {
      console.log("[EXCEL-EXTRACT] Budget exhausted after " + tablesProcessed + " tables");
      break;
    }

    // Build combined text for all sheets in this document
    // Group into batches that fit within MAX_TABLE_TEXT_CHARS
    var batchText = "";
    var batchSheets: string[] = [];

    for (var ti = 0; ti < docTables.length; ti++) {
      var tbl = docTables[ti];
      var captionBasis = detectBasisFromCaption(tbl.caption);
      var tableText = cellGridToText(tbl.data.cells, tbl.caption);

      if (!tableText || tableText.trim().length < 20) continue;

      // If adding this table would exceed limit, process current batch first
      if (batchText.length + tableText.length > MAX_TABLE_TEXT_CHARS && batchText.length > 0) {
        var batchFigures = await extractFiguresBatch(
          ctx, batchText, batchSheets, docId, captionBasis, pipelineStartTime,
        );
        for (var fi = 0; fi < batchFigures.length; fi++) {
          allFigures.push(batchFigures[fi]);
        }
        tablesProcessed += batchSheets.length;
        batchText = "";
        batchSheets = [];
      }

      batchText += "\n\n---\n\n" + tableText;
      batchSheets.push(tbl.sheet_or_page);
    }

    // Process remaining batch
    if (batchText.length > 0) {
      try {
        var captionBasisLast = detectBasisFromCaption(docTables[docTables.length - 1].caption);
        var remaining = await extractFiguresBatch(
          ctx, batchText, batchSheets, docId, captionBasisLast, pipelineStartTime,
        );
        for (var ri = 0; ri < remaining.length; ri++) {
          allFigures.push(remaining[ri]);
        }
        tablesProcessed += batchSheets.length;
      } catch (err) {
        var errMsg = err instanceof Error ? err.message : String(err);
        errors.push("Doc " + docId + " batch error: " + errMsg.slice(0, 200));
        console.log("[EXCEL-EXTRACT] Error processing doc " + docId + ": " + errMsg.slice(0, 200));
      }
    }
  }

  console.log("[EXCEL-EXTRACT] Extracted " + allFigures.length + " figures from " + tablesProcessed + " tables");
  return { figures: allFigures, tablesProcessed: tablesProcessed, errors: errors };
}

// ---------------------------------------------------------------------------
// Extract figures from a batch of table text via LLM
// ---------------------------------------------------------------------------

async function extractFiguresBatch(
  ctx: PipelineContext,
  tableText: string,
  sheetNames: string[],
  docId: string,
  captionBasis: string | null,
  pipelineStartTime: number,
): Promise<ExtractedFigure[]> {
  var llmBody = {
    model: HAIKU_MODEL,
    max_tokens: 8_192,
    temperature: 0,
    system: EXCEL_EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: "Extract all financial figures from these spreadsheet tables:\n\n" + tableText,
      },
    ],
  };

  var response: LLMResponse = await ctx.integrations.ai.apiRequest(
    { method: "POST", path: "/v1/messages", body: llmBody },
    { response: MessageResponseSchema },
    { label: "EXCEL-EXTRACT: " + sheetNames.join(", ").slice(0, 80) },
  );

  var responseText = response.content[0]?.text ?? "";
  var figures = parseFiguresResponse(responseText);

  // Apply caption-level basis if the LLM did not assign one
  if (captionBasis) {
    for (var i = 0; i < figures.length; i++) {
      if (!figures[i].basis) {
        figures[i].basis = captionBasis;
      }
    }
  }

  console.log(
    "[EXCEL-EXTRACT] Batch (" + sheetNames.join(", ").slice(0, 60) + "): " +
    figures.length + " figures, " +
    response.usage.input_tokens + " in / " + response.usage.output_tokens + " out tokens"
  );

  return figures;
}

// ---------------------------------------------------------------------------
// Main: Extract figures from DD report narratives
// ---------------------------------------------------------------------------

export async function extractFiguresFromDdReports(
  ctx: PipelineContext,
  dealId: string,
  pipelineStartTime: number,
  timeBudgetMs: number,
): Promise<{ figures: ExtractedFigure[]; narrativesProcessed: number; errors: string[] }> {
  var db = ctx.integrations.db;
  var startTime = Date.now();

  // Load consultant_report documents with parsed_text
  var reports = await db.query(
    "SELECT id, file_name, parsed_text FROM documents " +
    "WHERE deal_id = $1 AND document_tag = 'consultant_report' " +
    "AND parsed_text IS NOT NULL AND length(parsed_text) > 100 " +
    "ORDER BY file_name",
    z.object({
      id: z.string(),
      file_name: z.string(),
      parsed_text: z.string(),
    }),
    [dealId],
    { label: "EXCEL-EXTRACT: load consultant_report docs for DD figure extraction" },
  );

  console.log("[DD-EXTRACT] Loaded " + reports.length + " consultant reports for deal " + dealId);

  var allFigures: ExtractedFigure[] = [];
  var narrativesProcessed = 0;
  var errors: string[] = [];

  for (var i = 0; i < reports.length; i++) {
    var report = reports[i];

    // Check budget
    if (Date.now() - startTime > timeBudgetMs) {
      console.log("[DD-EXTRACT] Budget exhausted after " + narrativesProcessed + " reports");
      break;
    }

    // Check if this is a financial/commercial DD report (skip legal, technical, etc.)
    var lowerName = report.file_name.toLowerCase();
    var isFinancialDd = lowerName.indexOf("financial") !== -1
      || lowerName.indexOf("commercial") !== -1
      || lowerName.indexOf("diligence findings") !== -1
      || lowerName.indexOf("diligence report") !== -1
      || lowerName.indexOf("capstone") !== -1
      || lowerName.indexOf("pep") !== -1;

    // If we cannot tell from filename, check the first 500 chars of content
    if (!isFinancialDd) {
      var preview = report.parsed_text.slice(0, 500).toLowerCase();
      isFinancialDd = preview.indexOf("revenue") !== -1
        || preview.indexOf("ebitda") !== -1
        || preview.indexOf("financial") !== -1;
    }

    if (!isFinancialDd) {
      console.log("[DD-EXTRACT] Skipping non-financial report: " + report.file_name);
      continue;
    }

    try {
      // Chunk the narrative if too long
      var text = report.parsed_text;
      var chunks: string[] = [];

      if (text.length <= MAX_NARRATIVE_CHARS) {
        chunks.push(text);
      } else {
        // Split into chunks at paragraph boundaries
        var chunkSize = MAX_NARRATIVE_CHARS;
        var pos = 0;
        while (pos < text.length) {
          var end = Math.min(pos + chunkSize, text.length);
          // Try to break at a paragraph boundary
          if (end < text.length) {
            var lastPara = text.lastIndexOf("\n\n", end);
            if (lastPara > pos + chunkSize * 0.5) {
              end = lastPara;
            }
          }
          chunks.push(text.slice(pos, end));
          pos = end;
        }
      }

      for (var ci = 0; ci < chunks.length; ci++) {
        var chunkLabel = report.file_name.slice(0, 60) + (chunks.length > 1 ? " chunk " + (ci + 1) + "/" + chunks.length : "");

        var llmBody = {
          model: HAIKU_MODEL,
          max_tokens: 8_192,
          temperature: 0,
          system: NARRATIVE_EXTRACTION_PROMPT,
          messages: [
            {
              role: "user",
              content: "Extract all numeric financial figures from this Due Diligence report section:\n\nDocument: " + report.file_name + "\n\n" + chunks[ci],
            },
          ],
        };

        var response: LLMResponse = await ctx.integrations.ai.apiRequest(
          { method: "POST", path: "/v1/messages", body: llmBody },
          { response: MessageResponseSchema },
          { label: "DD-EXTRACT: " + chunkLabel },
        );

        var responseText = response.content[0]?.text ?? "";
        var chunkFigures = parseFiguresResponse(responseText);

        // Tag figures with document_id for insertion
        for (var fi = 0; fi < chunkFigures.length; fi++) {
          (chunkFigures[fi] as any)._document_id = report.id;
          allFigures.push(chunkFigures[fi]);
        }

        console.log(
          "[DD-EXTRACT] " + chunkLabel + ": " + chunkFigures.length + " figures, " +
          response.usage.input_tokens + " in / " + response.usage.output_tokens + " out tokens"
        );
      }

      narrativesProcessed++;
    } catch (err) {
      var errMsg = err instanceof Error ? err.message : String(err);
      errors.push("Report " + report.file_name + ": " + errMsg.slice(0, 200));
      console.log("[DD-EXTRACT] Error processing " + report.file_name + ": " + errMsg.slice(0, 200));
    }
  }

  console.log("[DD-EXTRACT] Extracted " + allFigures.length + " figures from " + narrativesProcessed + " reports");
  return { figures: allFigures, narrativesProcessed: narrativesProcessed, errors: errors };
}

// ---------------------------------------------------------------------------
// Insert figures into reference_figures table (deduped by coordinate)
// ---------------------------------------------------------------------------

export async function insertExtractedFigures(
  db: PipelineContext["integrations"]["db"],
  dealId: string,
  documentId: string,
  sheetName: string,
  figures: ExtractedFigure[],
): Promise<{ inserted: number; skipped: number }> {
  if (figures.length === 0) return { inserted: 0, skipped: 0 };

  var inserted = 0;
  var skipped = 0;

  for (var i = 0; i < figures.length; i++) {
    var fig = figures[i];
    var normalizedValue = normalizeValue(fig.value, fig.basis);

    try {
      // Use ON CONFLICT to deduplicate by (deal_id, document_id, metric, scope_qualifier, period)
      await db.execute(
        "INSERT INTO reference_figures (id, deal_id, document_id, sheet_name, segment, row_label, metric, scope_qualifier, period, value, basis, scenario) " +
        "VALUES (gen_random_uuid(), $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10) " +
        "ON CONFLICT DO NOTHING",
        [
          dealId,
          documentId,
          sheetName,
          fig.row_label,
          fig.metric,
          fig.scope_qualifier,
          fig.period,
          normalizedValue,
          fig.basis,
          fig.scenario,
        ],
        { label: "EXCEL-EXTRACT: insert reference_figure " + fig.scope_qualifier + " " + fig.period },
      );
      inserted++;
    } catch (err) {
      // Log but continue — individual insert failure should not abort the batch
      skipped++;
    }
  }

  return { inserted: inserted, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Combined orchestration: run both Excel + DD extraction and persist
// ---------------------------------------------------------------------------

export async function runFigureExtraction(
  ctx: PipelineContext,
  dealId: string,
  runId: string,
  pipelineStartTime: number,
  timeBudgetMs: number,
): Promise<ExcelExtractionResult> {
  var db = ctx.integrations.db;
  var startTime = Date.now();
  var totalInserted = 0;
  var totalSkipped = 0;
  var allErrors: string[] = [];

  // ── Phase 1: Excel doc_tables ──────────────────────────────────
  var excelBudget = Math.floor(timeBudgetMs * 0.6);
  var excelResult = await extractFiguresFromExcel(ctx, dealId, pipelineStartTime, excelBudget);
  allErrors = allErrors.concat(excelResult.errors);

  // Group extracted figures by document_id for insertion
  var figsByDoc = new Map<string, { sheetName: string; figures: ExtractedFigure[] }[]>();

  // For Excel figures, we need to tag them with document_id
  // We loaded tables with document_id, so we need to associate
  // Since extractFiguresFromExcel doesn't track per-figure doc provenance through the batch,
  // we need to re-query which docs contributed. Insert all as financial_model source.
  var fmDocs = await db.query(
    "SELECT DISTINCT d.id FROM documents d " +
    "JOIN doc_tables dt ON dt.document_id = d.id " +
    "WHERE d.deal_id = $1 AND d.document_tag = 'financial_model'",
    z.object({ id: z.string() }),
    [dealId],
    { label: "EXCEL-EXTRACT: resolve financial_model doc IDs" },
  );

  // Use the first financial_model doc as the source (primary model)
  var primaryFmDocId = fmDocs.length > 0 ? fmDocs[0].id : null;

  if (primaryFmDocId && excelResult.figures.length > 0) {
    var excelInsert = await insertExtractedFigures(
      db, dealId, primaryFmDocId, "LLM_Excel_Extract", excelResult.figures,
    );
    totalInserted += excelInsert.inserted;
    totalSkipped += excelInsert.skipped;
    console.log("[FIGURE-EXTRACT] Excel insert: " + excelInsert.inserted + " inserted, " + excelInsert.skipped + " skipped");
  }

  // ── Phase 2: DD report narratives ──────────────────────────────
  var ddBudget = Math.max(0, timeBudgetMs - (Date.now() - startTime) - 5000);
  var ddResult = await extractFiguresFromDdReports(ctx, dealId, pipelineStartTime, ddBudget);
  allErrors = allErrors.concat(ddResult.errors);

  // DD figures carry _document_id from the extraction phase
  if (ddResult.figures.length > 0) {
    // Group by document
    var ddByDoc = new Map<string, ExtractedFigure[]>();
    for (var i = 0; i < ddResult.figures.length; i++) {
      var fig = ddResult.figures[i];
      var docId = (fig as any)._document_id || "unknown";
      var existing = ddByDoc.get(docId);
      if (!existing) {
        existing = [];
        ddByDoc.set(docId, existing);
      }
      existing.push(fig);
    }

    for (var ddEntry of ddByDoc.entries()) {
      var ddDocId = ddEntry[0];
      var ddFigs = ddEntry[1];
      var ddInsert = await insertExtractedFigures(
        db, dealId, ddDocId, "LLM_DD_Extract", ddFigs,
      );
      totalInserted += ddInsert.inserted;
      totalSkipped += ddInsert.skipped;
    }
    console.log("[FIGURE-EXTRACT] DD insert: " + totalInserted + " total inserted");
  }

  var elapsedMs = Date.now() - startTime;
  console.log(
    "[FIGURE-EXTRACT] Complete: " + totalInserted + " figures inserted, " +
    totalSkipped + " skipped, " + allErrors.length + " errors, " +
    excelResult.tablesProcessed + " tables + " + ddResult.narrativesProcessed + " narratives processed in " +
    elapsedMs + "ms"
  );

  return {
    tablesProcessed: excelResult.tablesProcessed,
    narrativesProcessed: ddResult.narrativesProcessed,
    figuresInserted: totalInserted,
    figuresSkipped: totalSkipped,
    errors: allErrors,
    elapsedMs: elapsedMs,
  };
}
