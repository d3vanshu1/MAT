/**
 * workbookDigest.ts — Phase 6.1
 *
 * Builds a compact structural summary of a workbook from stored metadata.
 * No cell values — only structure, counts, labels, and detected attributes.
 * Used as input for manifest generation (Phase 6.2).
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SheetDigest {
  name: string;
  sheetIndex: number;
  cellCount: number;
  cellCountByType: Record<string, number>;
  headerBandRows: number[];
  labelCol: number;
  dataRegionStart: number;
  orientation: string | null;
  structureReason: string | null;
  sampleLabels: string[];       // up to 10 row_label_path values
  distinctPeriods: string[];    // up to 10 period_label values
  distinctCases: string[];
  dominantUnitClass: string | null;
  dominantScale: number | null;
  unitSource: string | null;
  scaleSource: string | null;
  aggregateCount: number;
  includeInMatching: boolean;
  exclusionRule: string | null;
}

export interface WorkbookDigest {
  workbookId: string;
  role: string;
  fileName: string;
  fileHash: string;
  sheetCount: number;
  fiscalYearEnd: number | null;
  fiscalYearEndSource: string | null;
  activeCaseLabel: string | null;
  dateSystem: number | null;
  sheets: SheetDigest[];
}

// ---------------------------------------------------------------------------
// Schema for DB rows
// ---------------------------------------------------------------------------

const WorkbookRow = z.object({
  id: z.string(),
  workbook_role: z.string(),
  file_name: z.string().nullable(),
  file_hash: z.string().nullable(),
  fiscal_year_end_month: z.number().nullable(),
  fiscal_year_end_source: z.string().nullable(),
  active_case_label: z.string().nullable(),
  date_system: z.number().nullable(),
});

const SheetRow = z.object({
  sheet_name: z.string(),
  sheet_index: z.number(),
  header_band_rows: z.any().nullable(),
  label_col: z.number().nullable(),
  data_region_start: z.number().nullable(),
  orientation: z.string().nullable(),
  structure_reason: z.string().nullable(),
});

const CellCountRow = z.object({
  sheet_name: z.string(),
  value_type: z.string().nullable(),
  cnt: z.string(),
});

const LabelRow = z.object({
  sheet_name: z.string(),
  row_label_path: z.string(),
});

const PeriodRow = z.object({
  sheet_name: z.string(),
  period_label: z.string(),
});

const CaseRow = z.object({
  sheet_name: z.string(),
  case_label: z.string(),
});

const UnitRow = z.object({
  sheet_name: z.string(),
  unit_class: z.string().nullable(),
  unit_source: z.string().nullable(),
  scale_multiplier: z.string().nullable(),
  scale_source: z.string().nullable(),
  cnt: z.string(),
});

const AggRow = z.object({
  sheet_name: z.string(),
  cnt: z.string(),
});

// ---------------------------------------------------------------------------
// QueryFn type (same as findFigure)
// ---------------------------------------------------------------------------

type QueryFn = (
  sql: string,
  schema: z.ZodTypeAny,
  params: unknown[],
  meta?: { label: string },
) => Promise<any[]>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildWorkbookDigest(
  queryFn: QueryFn,
  workbookId: string,
): Promise<WorkbookDigest> {
  // Workbook metadata (join documents for file_name)
  const [wb] = await queryFn(
    "SELECT w.id, w.workbook_role, d.file_name, w.file_hash, w.fiscal_year_end_month, w.fiscal_year_end_source, w.active_case_label, w.date_system FROM workbooks w LEFT JOIN documents d ON d.id = w.document_id WHERE w.id = $1",
    WorkbookRow, [workbookId], { label: "Digest: workbook" },
  );
  if (!wb) throw new Error("Workbook not found: " + workbookId);

  // All sheets
  const sheets = await queryFn(
    "SELECT sheet_name, sheet_index, header_band_rows, label_col, data_region_start, orientation, structure_reason FROM workbook_sheets WHERE workbook_id = $1 ORDER BY sheet_index",
    SheetRow, [workbookId], { label: "Digest: sheets" },
  );

  // Cell counts by type per sheet
  const cellCounts = await queryFn(
    "SELECT sheet_name, value_type, count(*)::text AS cnt FROM workbook_cells WHERE workbook_id = $1 GROUP BY sheet_name, value_type",
    CellCountRow, [workbookId], { label: "Digest: cell counts" },
  );

  // Sample labels per sheet (10 per sheet, via subquery)
  const labels = await queryFn(
    `SELECT DISTINCT ON (sheet_name, row_label_path) sheet_name, row_label_path
     FROM workbook_cells
     WHERE workbook_id = $1 AND row_label_path IS NOT NULL
     ORDER BY sheet_name, row_label_path
     LIMIT 500`,
    LabelRow, [workbookId], { label: "Digest: labels" },
  );

  // Distinct periods per sheet
  const periods = await queryFn(
    `SELECT DISTINCT sheet_name, period_label
     FROM workbook_cells
     WHERE workbook_id = $1 AND period_label IS NOT NULL
     LIMIT 500`,
    PeriodRow, [workbookId], { label: "Digest: periods" },
  );

  // Distinct cases per sheet
  const cases = await queryFn(
    `SELECT DISTINCT sheet_name, case_label
     FROM workbook_cells
     WHERE workbook_id = $1 AND case_label IS NOT NULL
     LIMIT 200`,
    CaseRow, [workbookId], { label: "Digest: cases" },
  );

  // Dominant unit/scale per sheet
  const units = await queryFn(
    `SELECT sheet_name, unit_class, unit_source, scale_multiplier::text, scale_source, count(*)::text AS cnt
     FROM workbook_cells
     WHERE workbook_id = $1 AND value_type = 'number'
     GROUP BY sheet_name, unit_class, unit_source, scale_multiplier, scale_source
     ORDER BY sheet_name, count(*) DESC
     LIMIT 500`,
    UnitRow, [workbookId], { label: "Digest: units" },
  );

  // Aggregate counts per sheet
  const aggs = await queryFn(
    `SELECT sheet_name, count(*)::text AS cnt
     FROM workbook_cells
     WHERE workbook_id = $1 AND is_aggregate = true
     GROUP BY sheet_name`,
    AggRow, [workbookId], { label: "Digest: aggregates" },
  );

  // Index lookups
  const cellCountMap = new Map<string, Record<string, number>>();
  for (const r of cellCounts) {
    if (!cellCountMap.has(r.sheet_name)) cellCountMap.set(r.sheet_name, {});
    cellCountMap.get(r.sheet_name)![r.value_type ?? "null"] = parseInt(r.cnt);
  }

  const labelMap = new Map<string, string[]>();
  for (const r of labels) {
    if (!labelMap.has(r.sheet_name)) labelMap.set(r.sheet_name, []);
    const arr = labelMap.get(r.sheet_name)!;
    if (arr.length < 10) arr.push(r.row_label_path);
  }

  const periodMap = new Map<string, string[]>();
  for (const r of periods) {
    if (!periodMap.has(r.sheet_name)) periodMap.set(r.sheet_name, []);
    const arr = periodMap.get(r.sheet_name)!;
    if (arr.length < 10) arr.push(r.period_label);
  }

  const caseMap = new Map<string, string[]>();
  for (const r of cases) {
    if (!caseMap.has(r.sheet_name)) caseMap.set(r.sheet_name, []);
    caseMap.get(r.sheet_name)!.push(r.case_label);
  }

  const unitMap = new Map<string, { unitClass: string | null; unitSource: string | null; scale: number | null; scaleSource: string | null }>();
  for (const r of units) {
    if (!unitMap.has(r.sheet_name)) {
      unitMap.set(r.sheet_name, {
        unitClass: r.unit_class,
        unitSource: r.unit_source,
        scale: r.scale_multiplier ? parseFloat(r.scale_multiplier) : null,
        scaleSource: r.scale_source,
      });
    }
  }

  const aggMap = new Map<string, number>();
  for (const r of aggs) aggMap.set(r.sheet_name, parseInt(r.cnt));

  // Build per-sheet digest
  const sheetDigests: SheetDigest[] = sheets.map((s) => {
    const countByType = cellCountMap.get(s.sheet_name) ?? {};
    const totalCells = Object.values(countByType).reduce((a, b) => a + b, 0);
    const unitInfo = unitMap.get(s.sheet_name);

    // Exclusion rules: divider tabs (no cells), non-temporal sheets
    let includeInMatching = true;
    let exclusionRule: string | null = null;
    if (totalCells === 0) {
      includeInMatching = false;
      exclusionRule = "zero_cells";
    }

    return {
      name: s.sheet_name,
      sheetIndex: s.sheet_index,
      cellCount: totalCells,
      cellCountByType: countByType,
      headerBandRows: Array.isArray(s.header_band_rows) ? s.header_band_rows : [],
      labelCol: s.label_col ?? -1,
      dataRegionStart: s.data_region_start ?? 0,
      orientation: s.orientation,
      structureReason: s.structure_reason,
      sampleLabels: labelMap.get(s.sheet_name) ?? [],
      distinctPeriods: periodMap.get(s.sheet_name) ?? [],
      distinctCases: caseMap.get(s.sheet_name) ?? [],
      dominantUnitClass: unitInfo?.unitClass ?? null,
      dominantScale: unitInfo?.scale ?? null,
      unitSource: unitInfo?.unitSource ?? null,
      scaleSource: unitInfo?.scaleSource ?? null,
      aggregateCount: aggMap.get(s.sheet_name) ?? 0,
      includeInMatching,
      exclusionRule,
    };
  });

  return {
    workbookId: wb.id,
    role: wb.workbook_role,
    fileName: wb.file_name ?? "",
    fileHash: wb.file_hash ?? "",
    sheetCount: sheets.length,
    fiscalYearEnd: wb.fiscal_year_end_month,
    fiscalYearEndSource: wb.fiscal_year_end_source,
    activeCaseLabel: wb.active_case_label,
    dateSystem: wb.date_system,
    sheets: sheetDigests,
  };
}
