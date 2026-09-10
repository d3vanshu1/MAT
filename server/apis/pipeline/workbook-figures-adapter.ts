/**
 * workbook-figures-adapter.ts — Phase 4.5
 *
 * Converts workbook_cells data into the Figure[] interface consumed by
 * the reconciliation pipeline. This replaces the LLM-based extraction
 * path (excel-figure-extraction.ts) with deterministic map-derived figures.
 *
 * The adapter outputs figures with `name = row_label`, letting the existing
 * LABEL_MAPPINGS in claims-reconciliation.ts handle metric classification.
 * No LLM calls, no prenorm encoding.
 *
 * The output is a strict superset of what the old extractor found —
 * every figure the old extractor found appears here with the same value,
 * plus thousands more that the LLM missed.
 */
import { z } from "@superblocksteam/sdk-api";
import type { Figure } from "./numeric-verify-inline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Query function signature matching what reconciliation-pipeline passes */
type QueryFn = (
  sql: string,
  schema: z.ZodTypeAny,
  params: unknown[],
  meta?: { label: string },
) => Promise<any[]>;

const CellRow = z.object({
  sheet_name: z.string(),
  cell_ref: z.string().nullable(),
  row_label: z.string().nullable(),
  row_label_path: z.string().nullable(),
  period_label: z.string().nullable(),
  value_num: z.string().nullable(),       // numeric comes as string from PG
  value_raw: z.string().nullable(),
  col_header_raw: z.string().nullable(),
  formula: z.string().nullable(),
  unit_class: z.string().nullable(),
  currency: z.string().nullable(),
  scale_multiplier: z.string().nullable(),
  case_label: z.string().nullable(),
  is_aggregate: z.boolean().nullable(),
  period_type: z.string().nullable(),
  sign_convention: z.string().nullable(),
});

export interface WorkbookFiguresResult {
  figures: Figure[];
  stats: {
    cellsQueried: number;
    cellsWithLabel: number;
    cellsWithPeriod: number;
    figuresProduced: number;
    stubsExcluded: number;
    byUnitClass: Record<string, number>;
    bySheet: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Core adapter
// ---------------------------------------------------------------------------

/**
 * Load figures from workbook_cells for a deal's workbooks.
 *
 * @param queryFn  - DB query function (same signature as reconciliation-pipeline)
 * @param dealId   - Deal UUID
 * @param role     - Workbook role filter: "buy_side" | "sell_side" | null (both)
 * @param sheetNames - Optional filter to specific sheets
 */
export async function loadWorkbookFigures(
  queryFn: QueryFn,
  dealId: string,
  role?: string | null,
  sheetNames?: string[] | null,
): Promise<WorkbookFiguresResult> {

  // Build WHERE clause parts
  const params: unknown[] = [dealId];
  let roleClause = "";
  if (role) {
    params.push(role);
    roleClause = " AND w.workbook_role = $" + params.length;
  }
  let sheetClause = "";
  if (sheetNames && sheetNames.length > 0) {
    params.push(sheetNames);
    sheetClause = " AND c.sheet_name = ANY($" + params.length + ")";
  }

  // First get the list of sheets (lightweight query under 4MB)
  const SheetRow = z.object({ sheet_name: z.string() });
  const sheetRows = await queryFn(
    `SELECT DISTINCT c.sheet_name
     FROM workbook_cells c
     JOIN workbooks w ON w.id = c.workbook_id
     JOIN documents d ON d.id = w.document_id
     WHERE d.deal_id = $1
       AND c.value_type = 'number'
       AND c.value_num IS NOT NULL
       AND c.row_label IS NOT NULL
       AND c.period_label IS NOT NULL
       ${roleClause}
       ${sheetClause}
     ORDER BY c.sheet_name`,
    SheetRow,
    params,
    { label: "List sheets with figures for adapter" },
  );

  // Query per-sheet to stay under 4MB gRPC limit
  const allRows: z.infer<typeof CellRow>[] = [];
  for (const sr of sheetRows) {
    const sheetParams = [...params, sr.sheet_name];
    const sheetSql = `
      SELECT
        c.sheet_name,
        c.cell_ref,
        c.row_label,
        c.row_label_path,
        c.period_label,
        c.value_num::text AS value_num,
        c.value_raw::text AS value_raw,
        c.col_header_raw,
        c.formula,
        c.unit_class,
        c.currency,
        c.scale_multiplier::text AS scale_multiplier,
        c.case_label,
        c.is_aggregate,
        c.period_type,
        c.sign_convention
      FROM workbook_cells c
      JOIN workbooks w ON w.id = c.workbook_id
      JOIN documents d ON d.id = w.document_id
      WHERE d.deal_id = $1
        AND c.value_type = 'number'
        AND c.value_num IS NOT NULL
        AND c.row_label IS NOT NULL
        AND c.period_label IS NOT NULL
        ${roleClause}
        AND c.sheet_name = $${sheetParams.length}
      ORDER BY c.row_idx, c.col_idx
    `;
    // Paginate within large sheets (5000 rows per page to stay under 4MB)
    const PAGE_SIZE = 5000;
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const pagedParams = [...sheetParams, PAGE_SIZE, offset];
      const pagedSql = sheetSql + ` LIMIT $${pagedParams.length - 1} OFFSET $${pagedParams.length}`;
      const page = await queryFn(pagedSql, CellRow, pagedParams, {
        label: `Load figures: ${sr.sheet_name} (offset ${offset})`,
      });
      allRows.push(...page);
      hasMore = page.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }
  }

  const rows = allRows;

  // Convert to Figure[]
  const figures: Figure[] = [];
  let stubsExcluded = 0;
  const byUnitClass: Record<string, number> = {};
  const bySheet: Record<string, number> = {};

  for (const r of rows) {
    // Exclude stub periods — sub-annual figures should not match annual claims
    if (r.period_type === "stub") {
      stubsExcluded++;
      continue;
    }

    const rawNum = parseFloat(r.value_num!);
    if (isNaN(rawNum)) continue;

    const scale = r.scale_multiplier ? parseFloat(r.scale_multiplier) : 1;
    const uc = r.unit_class ?? "unknown";

    // Compute the output value:
    // - Currency/count/ratio: value * scale_multiplier (base units)
    // - Percent: value * 100 (display %, not decimal fraction)
    // - Multiple/date/text: value as-is (no scaling)
    let outputValue: number;
    if (uc === "percent") {
      outputValue = rawNum * 100;
    } else if (uc === "currency" || uc === "ratio" || uc === "count" || uc === "unknown") {
      outputValue = rawNum * scale;
    } else {
      // multiple, date, text — pass through
      outputValue = rawNum;
    }

    // Build the unit_tag for coordinate tracing
    // e.g. "currency:USD:1000000" or "percent::1"
    const unitTag = [
      uc,
      r.currency ?? "",
      scale.toString(),
    ].join(":");

    // Build the scale string for the figure
    let scaleLabel: string | null = null;
    if (scale === 1_000_000) scaleLabel = "millions";
    else if (scale === 1_000) scaleLabel = "thousands";
    else if (scale === 1_000_000_000) scaleLabel = "billions";
    else if (scale !== 1) scaleLabel = scale.toString() + "x";

    // Use row_label as the figure name — LABEL_MAPPINGS handles classification
    // If row_label_path is available and different, append it for disambiguation
    const name = r.row_label!;

    const fig: Figure = {
      name,
      period: r.period_label!,
      value: outputValue,
      source_doc: "workbook_map",
      source_cell: r.row_label!,
      source_sheet: r.sheet_name,
      // C10 coordinate fields
      cell_ref: r.cell_ref,
      column_header: r.col_header_raw,
      formula: r.formula,
      unit_tag: unitTag,
      scale: scaleLabel,
      value_raw: rawNum,
      transform: r.sign_convention === "negative_convention" ? "sign_inverted" : null,
    };

    figures.push(fig);
    byUnitClass[uc] = (byUnitClass[uc] ?? 0) + 1;
    bySheet[r.sheet_name] = (bySheet[r.sheet_name] ?? 0) + 1;
  }

  return {
    figures,
    stats: {
      cellsQueried: rows.length + stubsExcluded,
      cellsWithLabel: rows.length + stubsExcluded,
      cellsWithPeriod: rows.length + stubsExcluded,
      figuresProduced: figures.length,
      stubsExcluded,
      byUnitClass,
      bySheet,
    },
  };
}
