import { api, z, postgres } from "@superblocksteam/sdk-api";
import { normalizePeriod } from "./claims-reconciliation.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Cell {
  r: number;
  c: number;
  value: any;
  type: string;
  formula?: string;
}

interface DocTableRow {
  id: string;
  document_id: string;
  sheet_or_page: string;
  data: {
    row_headers: string[];
    col_headers: string[];
    cells: Cell[];
  };
}

interface SectionContext {
  category: string | null;
  segment: string | null;
}

interface ExtractedFigure {
  document_id: string;
  sheet_name: string;
  segment: string | null;
  row_label: string;
  metric: string;
  scope_qualifier: string;
  period: string;
  value: number;
  basis: string | null;
  scenario: string | null;
}

// ---------------------------------------------------------------------------
// LABEL_MAPPINGS — Extended for segment-qualified revenue
// ---------------------------------------------------------------------------

interface LabelMapping {
  pattern: RegExp;
  metric: string;
  scope_qualifier: string;
  basis?: string;
  /** If true, compose scope as "metric (segment: <segment>)" */
  segmentQualified?: boolean;
}

/**
 * Segment-aware LABEL_MAPPINGS.
 *
 * When `segmentQualified: true`, the scope_qualifier is a template.
 * At resolution time, if a segment context is active, the scope becomes:
 *   `Revenue (segment: <segment>)` or `Gross Profit (segment: <segment>)`
 *
 * When `segmentQualified: false` or unset, the scope is used as-is.
 */
const LABEL_MAPPINGS: LabelMapping[] = [
  // --- Revenue family (specific patterns first) ---
  { pattern: /^total\s+group\s+revenue/i, metric: "revenue", scope_qualifier: "Total Group Revenue" },
  { pattern: /^total\s+revenue\s*\(excl/i, metric: "revenue", scope_qualifier: "Total Revenue (excl. adjustments)" },
  { pattern: /^total\s+revenue$/i, metric: "revenue", scope_qualifier: "Revenue", segmentQualified: true },
  { pattern: /^revenue$/i, metric: "revenue", scope_qualifier: "Revenue", segmentQualified: true },
  { pattern: /^net\s+revenue$/i, metric: "revenue", scope_qualifier: "Net Revenue" },
  { pattern: /^recurring\s+revenue|^arr$|^mrr$/i, metric: "revenue", scope_qualifier: "Recurring Revenue" },

  // --- EBITDA family ---
  { pattern: /^adj(usted)?\.?\s+cash\s+ebitda/i, metric: "ebitda", scope_qualifier: "Adjusted EBITDA" },
  { pattern: /^adj(usted)?\.?\s+ebitda/i, metric: "ebitda", scope_qualifier: "Adjusted EBITDA" },
  { pattern: /^reported\s+ebitda|^ebitda.*reported|^non.?pro.?forma.*ebitda|^ebitda.*non.?pro.?forma/i, metric: "ebitda", scope_qualifier: "Reported EBITDA (Non Pro Forma)" },
  { pattern: /^cash\s+ebitda$/i, metric: "ebitda", scope_qualifier: "Cash EBITDA" },
  { pattern: /^run.?rate\s+ebitda/i, metric: "ebitda", scope_qualifier: "Run-rate EBITDA" },
  { pattern: /^organic.*ebitda|^ebitda.*organic/i, metric: "ebitda", scope_qualifier: "Organic Cash EBITDA" },
  { pattern: /^pep.*ebitda|^ebitda.*pep/i, metric: "ebitda", scope_qualifier: "PEP Cash EBITDA" },
  { pattern: /^ebitda$/i, metric: "ebitda", scope_qualifier: "Cash EBITDA" },

  // --- Gross Profit family ---
  { pattern: /^total\s+gross\s+profit$/i, metric: "gross_margin", scope_qualifier: "Gross Profit", segmentQualified: true },
  { pattern: /^gross\s+profit$/i, metric: "gross_margin", scope_qualifier: "Gross Profit", segmentQualified: true },
  { pattern: /^gross\s+margin$/i, metric: "gross_margin", scope_qualifier: "Total Gross Profit" },

  // --- Direct Costs / Overheads ---
  { pattern: /^total\s+direct\s+costs?$/i, metric: "direct_costs", scope_qualifier: "Direct Costs", segmentQualified: true },
  { pattern: /^direct\s+costs?$/i, metric: "direct_costs", scope_qualifier: "Direct Costs", segmentQualified: true },
  { pattern: /^total\s+overheads?$/i, metric: "overheads", scope_qualifier: "Overheads" },
  { pattern: /^overheads?$/i, metric: "overheads", scope_qualifier: "Overheads" },
];

// ---------------------------------------------------------------------------
// Section-context parser
// ---------------------------------------------------------------------------

/**
 * Deterministic section-context tracker for Revenue_&_GP_Build-style sheets.
 *
 * Signal rules (from the actual sheet structure):
 * - col 0 == "x" AND col 2 has a non-empty string → CATEGORY header (name in col 2)
 * - col 1 == "x" AND col 3 has a non-empty string → SEGMENT header (name in col 3)
 * - Category resets segment to null.
 *
 * Returns a map: row index → { category, segment }
 */
function buildSectionContextMap(cells: Cell[], rowCount: number): Map<number, SectionContext> {
  // Build quick lookups
  const cellMap = new Map<string, string>();
  for (const cell of cells) {
    if (cell.type === "string" && cell.value != null && cell.c <= 5) {
      cellMap.set(`${cell.r},${cell.c}`, String(cell.value).trim());
    }
  }

  let currentCategory: string | null = null;
  let currentSegment: string | null = null;
  const contextMap = new Map<number, SectionContext>();

  for (let ri = 0; ri < rowCount; ri++) {
    const col0 = cellMap.get(`${ri},0`);
    const col1 = cellMap.get(`${ri},1`);
    const col2 = cellMap.get(`${ri},2`);
    const col3 = cellMap.get(`${ri},3`);

    // Category marker: col 0 == "x" AND col 2 non-empty
    if (col0 === "x" && col2 && col2 !== "x" && col2.length > 1) {
      currentCategory = col2;
      currentSegment = null; // reset segment on new category
    }

    // Segment marker: col 1 == "x" AND col 3 non-empty
    if (col1 === "x" && col3 && col3 !== "x" && col3.length > 1) {
      currentSegment = col3;
    }

    contextMap.set(ri, { category: currentCategory, segment: currentSegment });
  }

  return contextMap;
}

// ---------------------------------------------------------------------------
// Column header enrichment (matches numeric-verify-inline.ts logic)
// ---------------------------------------------------------------------------

function enrichColHeadersWithYears(headers: string[], cells: Cell[]): string[] {
  const enriched = [...headers];
  const maxCol = headers.length;
  const row0Cells = cells.filter((c) => c.r === 0 && c.c < maxCol).sort((a, b) => a.c - b.c);

  let currentYear: string | null = null;
  const colYears: (string | null)[] = new Array(maxCol).fill(null);

  for (const cell of row0Cells) {
    if (
      cell.type === "number" &&
      typeof cell.value === "number" &&
      cell.value >= 2000 &&
      cell.value <= 2099 &&
      Number.isInteger(cell.value)
    ) {
      colYears[cell.c] = String(cell.value);
    }
  }

  for (let ci = 0; ci < maxCol; ci++) {
    if (colYears[ci] !== null) {
      currentYear = colYears[ci];
    }
    colYears[ci] = currentYear;
  }

  const hasYearPattern = /\b20\d{2}\b/;
  for (let ci = 0; ci < maxCol; ci++) {
    const year = colYears[ci];
    if (!year) continue;
    if (hasYearPattern.test(enriched[ci])) continue;
    enriched[ci] = `${year} ${enriched[ci]}`;
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Period detection
// ---------------------------------------------------------------------------

const PERIOD_COL_PATTERN = /\b(20\d{2}|FY\s*\d{2,4}|Mar|Apr|Jan|Feb|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i;

function isPeriodCol(label: string): boolean {
  return PERIOD_COL_PATTERN.test(label.trim());
}

// ---------------------------------------------------------------------------
// Row label derivation (matches numeric-verify-inline.ts logic)
// ---------------------------------------------------------------------------

function deriveRowLabelsFromCells(originalHeaders: string[], cells: Cell[]): string[] {
  const maxRow = originalHeaders.length;
  const derived: string[] = new Array(maxRow).fill("");

  const colStringFreq = new Map<number, number>();
  for (const cell of cells) {
    if (cell.r < maxRow && cell.type === "string" && cell.value != null && String(cell.value).trim() !== "" && cell.c < 6) {
      colStringFreq.set(cell.c, (colStringFreq.get(cell.c) ?? 0) + 1);
    }
  }

  const labelCols = [...colStringFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([col]) => col);

  const cellsByRowCol = new Map<string, string>();
  for (const cell of cells) {
    if (cell.r < maxRow && cell.type === "string" && cell.value != null && cell.c < 6) {
      const val = String(cell.value).trim();
      if (val && val !== "x") {
        cellsByRowCol.set(`${cell.r},${cell.c}`, val);
      }
    }
  }

  for (const col of labelCols) {
    for (let ri = 0; ri < maxRow; ri++) {
      if (derived[ri]) continue;
      const val = cellsByRowCol.get(`${ri},${col}`);
      if (val) {
        derived[ri] = val;
      }
    }
  }

  for (let i = 0; i < maxRow; i++) {
    if (!derived[i] && originalHeaders[i] && originalHeaders[i] !== "" && originalHeaders[i] !== "x") {
      derived[i] = originalHeaders[i];
    }
  }

  return derived;
}

// ---------------------------------------------------------------------------
// Scope composition
// ---------------------------------------------------------------------------

function composeScope(mapping: LabelMapping, segment: string | null): string {
  if (!mapping.segmentQualified || !segment) {
    return mapping.scope_qualifier;
  }
  // Compose: "Revenue (segment: Surgery Connect)", "Gross Profit (segment: Fixed Data)"
  const metricDisplay =
    mapping.metric === "revenue" ? "Revenue" :
    mapping.metric === "gross_margin" ? "Gross Profit" :
    mapping.metric === "direct_costs" ? "Direct Costs" :
    mapping.scope_qualifier;
  return `${metricDisplay} (segment: ${segment})`;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export default api({
  name: "Stage5ExtractReferenceFigures",
  description: "Extract reference figures from doc_tables using section-context parser + LABEL_MAPPINGS",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
    dryRun: z.boolean().default(true),
    /** Limit to specific document (null = all docs for deal) */
    documentId: z.string().uuid().nullable().default(null),
  }),

  output: z.object({
    documentsProcessed: z.number(),
    sheetsProcessed: z.number(),
    figuresExtracted: z.number(),
    figuresWritten: z.number(),
    skippedUnmappedLabel: z.number(),
    skippedUnparseablePeriod: z.number(),
    skippedUnresolvedSection: z.number(),
    skippedNonNumeric: z.number(),
    /** Per-sheet breakdown */
    sheetBreakdown: z.array(z.object({
      document_id: z.string(),
      sheet_name: z.string(),
      figures_count: z.number(),
      skipped_unmapped: z.number(),
      skipped_period: z.number(),
      skipped_section: z.number(),
    })),
    /** Distinct scopes with frequency */
    scopeDistribution: z.array(z.object({
      scope: z.string(),
      metric: z.string(),
      count: z.number(),
    })),
    /** 30 sample figures for audit */
    sampleFigures: z.array(z.object({
      sheet_name: z.string(),
      segment: z.string().nullable(),
      row_label: z.string(),
      period: z.string(),
      value: z.number(),
      scope_qualifier: z.string(),
    })),
    /** New mappings applied */
    mappingsUsed: z.array(z.object({
      label: z.string(),
      metric: z.string(),
      scope: z.string(),
      inLedger: z.boolean(),
    })),
    /** Unresolved section rows */
    unresolvedSectionSamples: z.array(z.object({
      sheet_name: z.string(),
      row: z.number(),
      label: z.string(),
    })),
    elapsed_ms: z.number(),
  }),

  async run(ctx, { dealId, dryRun, documentId }) {
    const startTime = Date.now();

    // Load doc_tables
    // First, get the list of sheet IDs (lightweight — no data column)
    const SheetListSchema = z.object({
      id: z.string(),
      document_id: z.string(),
      sheet_or_page: z.string(),
    });

    const filterClause = documentId
      ? `AND dt.document_id = '${documentId}'::uuid`
      : "";

    const sheetList = await ctx.integrations.db.query(
      `SELECT dt.id, dt.document_id, dt.sheet_or_page
       FROM doc_tables dt
       JOIN documents d ON dt.document_id = d.id
       WHERE d.deal_id = $1::uuid
         AND dt.sheet_or_page NOT IN ('__generation_manifest__', 'Disclaimer', 'Sheet1', 'Sheet3', 'Sheet5')
         ${filterClause}
       ORDER BY dt.document_id, dt.sheet_or_page`,
      SheetListSchema,
      [dealId],
      { label: "Stage5: List doc_tables sheets" }
    );

    console.log(`[Stage5] Found ${sheetList.length} sheets for deal ${dealId}`);

    // Load ledger scopes for the inLedger check
    const LedgerScopeSchema = z.object({ scope: z.string() });
    const ledgerScopes = await ctx.integrations.db.query(
      `SELECT DISTINCT c->>'scope_qualifier' as scope
       FROM diag_claims_ledger, jsonb_array_elements(ledger->'claims') AS c
       WHERE deal_id = $1::uuid`,
      LedgerScopeSchema,
      [dealId],
      { label: "Stage5: Load ledger scopes" }
    );
    const ledgerScopeSet = new Set(ledgerScopes.map((r) => r.scope));

    // Process sheets one at a time (avoids gRPC 4MB limit)
    const allFigures: ExtractedFigure[] = [];
    let totalSkippedUnmapped = 0;
    let totalSkippedPeriod = 0;
    let totalSkippedSection = 0;
    let totalSkippedNonNumeric = 0;
    const sheetBreakdown: Array<{
      document_id: string;
      sheet_name: string;
      figures_count: number;
      skipped_unmapped: number;
      skipped_period: number;
      skipped_section: number;
    }> = [];
    const unresolvedSectionSamples: Array<{ sheet_name: string; row: number; label: string }> = [];
    const documentIds = new Set<string>();

    for (const sheetInfo of sheetList) {
      // Load headers (small) separately from cells (potentially large)
      const HeaderSchema = z.object({
        row_headers: z.any(),
        col_headers: z.any(),
      });
      const [headerRow] = await ctx.integrations.db.query(
        `SELECT data->'row_headers' as row_headers, data->'col_headers' as col_headers
         FROM doc_tables WHERE id = $1::uuid`,
        HeaderSchema,
        [sheetInfo.id],
        { label: `Stage5: Headers ${sheetInfo.sheet_or_page}` }
      );
      if (!headerRow) continue;

      const rowHeaders: string[] = (typeof headerRow.row_headers === "string"
        ? JSON.parse(headerRow.row_headers) : headerRow.row_headers) ?? [];
      const colHeaders: string[] = (typeof headerRow.col_headers === "string"
        ? JSON.parse(headerRow.col_headers) : headerRow.col_headers) ?? [];
      if (rowHeaders.length === 0 || colHeaders.length === 0) continue;

      // Load cells in two chunks: structure cols (0-6) and value cols (7-15)
      // This keeps each query under the 4MB gRPC limit
      const CellSchema = z.object({ r: z.number(), c: z.number(), value: z.any(), type: z.string() });
      const structureCells = await ctx.integrations.db.query(
        `SELECT (cell->>'r')::int as r, (cell->>'c')::int as c, cell->'value' as value, cell->>'type' as type
         FROM doc_tables, jsonb_array_elements(data->'cells') AS cell
         WHERE id = $1::uuid AND (cell->>'c')::int <= 6`,
        CellSchema,
        [sheetInfo.id],
        { label: `Stage5: Struct cells ${sheetInfo.sheet_or_page}` }
      );
      const valueCells = await ctx.integrations.db.query(
        `SELECT (cell->>'r')::int as r, (cell->>'c')::int as c, cell->'value' as value, cell->>'type' as type
         FROM doc_tables, jsonb_array_elements(data->'cells') AS cell
         WHERE id = $1::uuid AND (cell->>'c')::int > 6 AND (cell->>'c')::int <= 15`,
        CellSchema,
        [sheetInfo.id],
        { label: `Stage5: Value cells ${sheetInfo.sheet_or_page}` }
      );

      // Also load row 0 and row 1 cells for period detection (may be in higher cols)
      const headerCells = await ctx.integrations.db.query(
        `SELECT (cell->>'r')::int as r, (cell->>'c')::int as c, cell->'value' as value, cell->>'type' as type
         FROM doc_tables, jsonb_array_elements(data->'cells') AS cell
         WHERE id = $1::uuid AND (cell->>'r')::int <= 1 AND (cell->>'c')::int > 6`,
        CellSchema,
        [sheetInfo.id],
        { label: `Stage5: Header row cells ${sheetInfo.sheet_or_page}` }
      );

      const cells = [...structureCells, ...valueCells, ...headerCells] as Cell[];
      if (cells.length === 0) continue;

      documentIds.add(sheetInfo.document_id);
      const sheetName = sheetInfo.sheet_or_page;
      const rowCount = rowHeaders.length;

      // Derive effective row labels
      const meaningfulCount = rowHeaders.filter(
        (h: string) => h !== "" && h !== "x" && h.length > 1
      ).length;
      const derivationNeeded = rowCount > 0 && meaningfulCount / rowCount < 0.3;
      const effectiveRowHeaders = derivationNeeded
        ? deriveRowLabelsFromCells(rowHeaders, cells)
        : rowHeaders;

      // Enrich col headers with years
      const effectiveColHeaders = enrichColHeadersWithYears(colHeaders, cells);

      // Build section-context map
      const sectionMap = buildSectionContextMap(cells, rowCount);

      // Identify period columns (only annual summary cols: those in the first ~15 positions with period data)
      const periodCols: Array<{ colIdx: number; period: string }> = [];
      for (let ci = 0; ci < effectiveColHeaders.length && ci < 15; ci++) {
        const header = effectiveColHeaders[ci];
        if (isPeriodCol(header)) {
          const normalized = normalizePeriod(header);
          if (normalized && normalized !== header.toLowerCase().trim()) {
            periodCols.push({ colIdx: ci, period: normalized });
          }
        }
      }

      if (periodCols.length === 0) {
        // No period columns detected — skip this sheet entirely
        continue;
      }

      // Build grid for quick cell lookup
      const grid = new Map<string, Cell>();
      for (const cell of cells) {
        grid.set(`${cell.r},${cell.c}`, cell);
      }

      let sheetFigures = 0;
      let sheetSkippedUnmapped = 0;
      let sheetSkippedPeriod = 0;
      let sheetSkippedSection = 0;

      // Iterate all rows that have a derived label
      for (let ri = 0; ri < rowCount; ri++) {
        // First try the derived row header; fall back to col 6 cell value
        // (Revenue_&_GP_Build stores labels in col 6, which deriveRowLabelsFromCells skips)
        let label = effectiveRowHeaders[ri];
        if (!label || label === "x") {
          const col6Cell = grid.get(`${ri},6`);
          if (col6Cell && col6Cell.type === "string" && col6Cell.value != null) {
            const col6Val = String(col6Cell.value).trim();
            if (col6Val && col6Val !== "x") {
              label = col6Val;
            }
          }
        }
        if (!label || label === "x") continue;

        // Check if this row has numeric values in period columns
        let hasNumeric = false;
        for (const { colIdx } of periodCols) {
          const cell = grid.get(`${ri},${colIdx}`);
          if (cell && cell.type === "number" && typeof cell.value === "number") {
            hasNumeric = true;
            break;
          }
        }
        if (!hasNumeric) {
          totalSkippedNonNumeric++;
          continue;
        }

        // Try to match label against LABEL_MAPPINGS
        let matchedMapping: LabelMapping | null = null;
        for (const mapping of LABEL_MAPPINGS) {
          if (mapping.pattern.test(label)) {
            matchedMapping = mapping;
            break;
          }
        }

        if (!matchedMapping) {
          sheetSkippedUnmapped++;
          totalSkippedUnmapped++;
          continue;
        }

        // Section-context check for segment-qualified mappings
        const sectionCtx = sectionMap.get(ri) ?? { category: null, segment: null };

        if (matchedMapping.segmentQualified && !sectionCtx.segment) {
          // Fail closed: no resolvable segment header above this row
          sheetSkippedSection++;
          totalSkippedSection++;
          if (unresolvedSectionSamples.length < 20) {
            unresolvedSectionSamples.push({ sheet_name: sheetName, row: ri, label });
          }
          continue;
        }

        const scope = composeScope(matchedMapping, sectionCtx.segment);

        // Extract values from period columns
        for (const { colIdx, period } of periodCols) {
          const cell = grid.get(`${ri},${colIdx}`);
          if (!cell || cell.type !== "number" || typeof cell.value !== "number") continue;
          if (cell.value === 0) continue; // Skip zero values

          allFigures.push({
            document_id: sheetInfo.document_id,
            sheet_name: sheetName,
            segment: sectionCtx.segment,
            row_label: label,
            metric: matchedMapping.metric,
            scope_qualifier: scope,
            period,
            value: cell.value,
            basis: matchedMapping.basis ?? null,
            scenario: null,
          });
          sheetFigures++;
        }
      }

      sheetBreakdown.push({
        document_id: sheetInfo.document_id,
        sheet_name: sheetName,
        figures_count: sheetFigures,
        skipped_unmapped: sheetSkippedUnmapped,
        skipped_period: sheetSkippedPeriod,
        skipped_section: sheetSkippedSection,
      });
    }

    // Build scope distribution
    const scopeMap = new Map<string, { metric: string; count: number }>();
    for (const fig of allFigures) {
      const key = `${fig.metric}|${fig.scope_qualifier}`;
      const existing = scopeMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        scopeMap.set(key, { metric: fig.metric, count: 1 });
      }
    }
    const scopeDistribution = [...scopeMap.entries()]
      .map(([key, val]) => ({
        scope: key.split("|")[1],
        metric: val.metric,
        count: val.count,
      }))
      .sort((a, b) => b.count - a.count);

    // Build mappings used report
    const mappingsUsedMap = new Map<string, { label: string; metric: string; scope: string; inLedger: boolean }>();
    for (const fig of allFigures) {
      const key = `${fig.metric}|${fig.scope_qualifier}`;
      if (!mappingsUsedMap.has(key)) {
        mappingsUsedMap.set(key, {
          label: fig.row_label,
          metric: fig.metric,
          scope: fig.scope_qualifier,
          inLedger: ledgerScopeSet.has(fig.scope_qualifier),
        });
      }
    }
    const mappingsUsed = [...mappingsUsedMap.values()];

    // Sample 30 figures across sheets
    const sampleFigures: Array<{
      sheet_name: string;
      segment: string | null;
      row_label: string;
      period: string;
      value: number;
      scope_qualifier: string;
    }> = [];
    const stride = Math.max(1, Math.floor(allFigures.length / 30));
    for (let i = 0; i < allFigures.length && sampleFigures.length < 30; i += stride) {
      const f = allFigures[i];
      sampleFigures.push({
        sheet_name: f.sheet_name,
        segment: f.segment,
        row_label: f.row_label,
        period: f.period,
        value: f.value,
        scope_qualifier: f.scope_qualifier,
      });
    }

    // Write to database if not dry run
    let figuresWritten = 0;
    if (!dryRun && allFigures.length > 0) {
      // Clear existing figures for this deal (idempotent)
      await ctx.integrations.db.query(
        `DELETE FROM reference_figures WHERE deal_id = $1::uuid`,
        z.any(),
        [dealId],
        { label: "Stage5: Clear existing figures" }
      );

      // Batch insert (50 per batch to stay within query limits)
      const batchSize = 50;
      for (let i = 0; i < allFigures.length; i += batchSize) {
        const batch = allFigures.slice(i, i + batchSize);
        const values = batch.map((f, idx) => {
          const offset = idx * 10;
          return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::numeric, $${offset + 10})`;
        }).join(", ");

        const params = batch.flatMap((f) => [
          dealId,
          f.document_id,
          f.sheet_name,
          f.segment ?? null,
          f.row_label,
          f.metric,
          f.scope_qualifier,
          f.period,
          String(f.value),
          f.basis ?? null,
        ]);

        await ctx.integrations.db.query(
          `INSERT INTO reference_figures (deal_id, document_id, sheet_name, segment, row_label, metric, scope_qualifier, period, value, basis)
           VALUES ${values}`,
          z.any(),
          params,
          { label: `Stage5: Insert batch ${Math.floor(i / batchSize) + 1}` }
        );
        figuresWritten += batch.length;
      }
    }

    return {
      documentsProcessed: documentIds.size,
      sheetsProcessed: sheetBreakdown.length,
      figuresExtracted: allFigures.length,
      figuresWritten,
      skippedUnmappedLabel: totalSkippedUnmapped,
      skippedUnparseablePeriod: totalSkippedPeriod,
      skippedUnresolvedSection: totalSkippedSection,
      skippedNonNumeric: totalSkippedNonNumeric,
      sheetBreakdown,
      scopeDistribution,
      sampleFigures,
      mappingsUsed,
      unresolvedSectionSamples,
      elapsed_ms: Date.now() - startTime,
    };
  },
});
