/**
 * Diagnostic API: test Excel figure extraction on a single table.
 * Loads one doc_table, converts to text, sends to LLM, returns parsed figures.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { MessageResponseSchema } from "./call-llm.js";
import { HAIKU_MODEL } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const EXCEL_EXTRACTION_PROMPT = "You are a financial data extraction specialist. Given a spreadsheet table rendered as plaintext, extract ALL numeric financial figures into structured JSON.\n\nRULES:\n1. Extract every row that contains a numeric financial value\n2. Each figure needs: row_label, metric, scope_qualifier, period, value, basis (unit scale like \"millions\" or null), scenario (null usually)\n3. metric must be one of: revenue, EBITDA, gross_margin, net_income, cost, capex, cash_flow, growth_rate, headcount, sites, multiple, returns, margin_pct, other_financial\n4. Pay attention to the caption for unit scale\n5. For percentage values store as decimal (15% -> 0.15)\n\nOUTPUT: Return a JSON array. No markdown, no explanation.\n[{\"row_label\": \"Total Revenue\", \"metric\": \"revenue\", \"scope_qualifier\": \"Total Revenue\", \"period\": \"2024A\", \"value\": 25.3, \"basis\": \"millions\", \"scenario\": null}]";

export default api({
  name: "TestExcelExtraction",
  description: "Diagnostic: test extraction on one Excel table",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    tableId: z.string(),
  }),

  output: z.object({
    sheetName: z.string(),
    caption: z.string().nullable(),
    cellCount: z.number(),
    tableTextLength: z.number(),
    figuresExtracted: z.number(),
    figures: z.array(z.any()),
    elapsedMs: z.number(),
  }),

  async run(ctx, { tableId }) {
    var startTime = Date.now();

    // Load single table
    var rows = await ctx.integrations.db.query(
      "SELECT sheet_or_page, caption, data FROM doc_tables WHERE id = $1 LIMIT 1",
      z.object({ sheet_or_page: z.string(), caption: z.string().nullable(), data: z.any() }),
      [tableId],
      { label: "Test: load single doc_table" },
    );

    if (rows.length === 0) throw new Error("Table not found: " + tableId);
    var tbl = rows[0];
    var cells = tbl.data && tbl.data.cells;
    if (!cells || !Array.isArray(cells)) throw new Error("No cells in table");

    // Convert to text
    var maxR = 0;
    var maxC = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].r > maxR) maxR = cells[i].r;
      if (cells[i].c > maxC) maxC = cells[i].c;
    }
    if (maxR > 200) maxR = 200;
    if (maxC > 30) maxC = 30;

    var grid: string[][] = [];
    for (var r = 0; r <= maxR; r++) {
      var row: string[] = [];
      for (var c = 0; c <= maxC; c++) row.push("");
      grid.push(row);
    }
    for (var j = 0; j < cells.length; j++) {
      var cell = cells[j];
      if (cell.r > maxR || cell.c > maxC) continue;
      if (cell.value !== null && cell.value !== undefined) grid[cell.r][cell.c] = String(cell.value);
    }

    var lines: string[] = [];
    if (tbl.caption) { lines.push("## " + tbl.caption); lines.push(""); }
    for (var rr = 0; rr <= maxR; rr++) {
      var rowLine = grid[rr].join(" | ");
      if (rowLine.replace(/\s*\|\s*/g, "").trim() === "") continue;
      lines.push(rowLine);
    }
    var tableText = lines.join("\n");

    // LLM call
    var response = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: HAIKU_MODEL,
          max_tokens: 8192,
          temperature: 0,
          system: EXCEL_EXTRACTION_PROMPT,
          messages: [{ role: "user", content: "Extract financial figures:\n\n" + tableText }],
        },
      },
      { response: MessageResponseSchema },
      { label: "Test: extract figures from " + tbl.sheet_or_page },
    );

    var respText = response.content[0]?.text ?? "";
    var cleaned = respText.trim();
    if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

    var figures: any[] = [];
    try { figures = JSON.parse(cleaned); } catch { /* parse error */ }
    if (!Array.isArray(figures)) figures = [];

    return {
      sheetName: tbl.sheet_or_page,
      caption: tbl.caption,
      cellCount: cells.length,
      tableTextLength: tableText.length,
      figuresExtracted: figures.length,
      figures: figures.length > 0 ? figures.slice(0, 30) : [{ raw_response: respText.slice(0, 2000), table_text_preview: tableText.slice(0, 1000) }],
      elapsedMs: Date.now() - startTime,
    };
  },
});
