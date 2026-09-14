/**
 * growth-companion-detection.ts — Detect growth/rate rows by arithmetic
 *
 * For each numeric row M in a workbook, search adjacent rows (±3) for a
 * companion R where R[t] ≈ M[t]/M[t-1] - 1 for most periods.
 * Also detect CAGR columns at the right edge.
 *
 * Outputs:
 * - Growth companion relationships (metric_row → companion_row)
 * - Match rate: our computed rate vs model's stored rate
 * - Mismatch patterns (shifted period, skipped column, wrong row, etc.)
 * - is_rate_row flag for hard blocking in findFigure
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CellRow = z.object({
  sheet_name: z.string(),
  row_idx: z.coerce.number(),
  col_idx: z.coerce.number(),
  cell_ref: z.string(),
  value_num: z.coerce.number(),
  row_label: z.string().nullable(),
  period_start: z.string().nullable(),
  unit_class: z.string().nullable(),
});
type Cell = z.infer<typeof CellRow>;

interface RowSeries {
  sheet: string;
  rowIdx: number;
  label: string | null;
  // Values keyed by period_start (ISO date)
  values: Map<string, number>;
  // Ordered periods
  periods: string[];
  cellRefs: Map<string, string>;
  unitClass: string | null;
}

interface GrowthCompanion {
  metricSheet: string;
  metricRowIdx: number;
  metricLabel: string | null;
  companionRowIdx: number;
  companionLabel: string | null;
  kind: "poP" | "CAGR";
  periodsMatched: number;
  periodsTested: number;
  matchRate: number;
}

interface GradeResult {
  metricSheet: string;
  metricLabel: string | null;
  metricRowIdx: number;
  companionLabel: string | null;
  companionRowIdx: number;
  ourRate: number;
  modelRate: number;
  delta: number;
  period: string;
  pattern: string; // "match" | "shifted_one" | "skipped_column" | "wrong_row" | "no_match"
}

const TOLERANCE = 0.015; // 1.5% tolerance for growth rate matching
const SEARCH_WINDOW = 2; // rows above and below to search

export default api({
  name: "GrowthCompanionDetection",
  description: "Detect growth/rate rows by arithmetic, grade our reading",

  integrations: {
    ic_db: postgres(IC_DB),
  },

  input: z.object({
    workbookId: z.string(),
    markRateRows: z.boolean().default(false), // if true, update chain_break_reason
  }),

  output: z.object({
    companions: z.array(z.object({
      metricSheet: z.string(),
      metricRowIdx: z.number(),
      metricLabel: z.string().nullable(),
      companionRowIdx: z.number(),
      companionLabel: z.string().nullable(),
      kind: z.string(),
      periodsMatched: z.number(),
      periodsTested: z.number(),
      matchRate: z.number(),
    })),
    grading: z.object({
      totalMetricRowsWithCompanion: z.number(),
      rateMatchCount: z.number(),
      rateMatchPct: z.number(),
      mismatchByPattern: z.record(z.number()),
    }),
    rateRowsMarked: z.number(),
    mismatchSamples: z.array(z.object({
      sheet: z.string(),
      metricLabel: z.string().nullable(),
      companionLabel: z.string().nullable(),
      period: z.string(),
      ourRate: z.number(),
      modelRate: z.number(),
      pattern: z.string(),
    })),
  }),

  async run(ctx, { workbookId, markRateRows }) {
    const q = ctx.integrations.ic_db;

    // Load numeric cells with periods, paged to stay under gRPC 4MB limit
    const PAGE = 8000;
    let cells: Cell[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await q.query(
        `SELECT sheet_name, row_idx, col_idx, cell_ref, value_num::float AS value_num,
                row_label, period_start::text AS period_start, unit_class
         FROM workbook_cells
         WHERE workbook_id = $1
           AND value_type = 'number'
           AND value_num IS NOT NULL
           AND period_start IS NOT NULL
         ORDER BY sheet_name, row_idx, col_idx
         LIMIT ${PAGE} OFFSET ${offset}`,
        CellRow, [workbookId],
        { label: "Load cells page " + (offset / PAGE) },
      );
      cells = cells.concat(page);
      hasMore = page.length === PAGE;
      offset += PAGE;
    }
    console.log(`[GrowthCompanion] Loaded ${cells.length} cells`);

    // Group cells into row series by (sheet, row_idx)
    const rowMap = new Map<string, RowSeries>();
    for (const c of cells) {
      if (c.period_start == null) continue;
      const key = `${c.sheet_name}|${c.row_idx}`;
      let row = rowMap.get(key);
      if (!row) {
        row = {
          sheet: c.sheet_name,
          rowIdx: c.row_idx,
          label: c.row_label,
          values: new Map(),
          periods: [],
          cellRefs: new Map(),
          unitClass: c.unit_class,
        };
        rowMap.set(key, row);
      }
      if (!row.values.has(c.period_start)) {
        row.values.set(c.period_start, c.value_num);
        row.periods.push(c.period_start);
        row.cellRefs.set(c.period_start, c.cell_ref);
      }
      if (!row.label && c.row_label) row.label = c.row_label;
    }

    // Sort periods within each row
    for (const row of rowMap.values()) {
      row.periods.sort();
    }

    // Group rows by sheet for adjacency search
    const sheetRows = new Map<string, RowSeries[]>();
    for (const row of rowMap.values()) {
      if (row.periods.length < 2) continue; // need at least 2 periods
      let list = sheetRows.get(row.sheet);
      if (!list) { list = []; sheetRows.set(row.sheet, list); }
      list.push(row);
    }
    for (const list of sheetRows.values()) {
      list.sort((a, b) => a.rowIdx - b.rowIdx);
    }

    // Detect growth companions
    const companions: GrowthCompanion[] = [];
    const rateRowIndices = new Set<string>(); // "sheet|rowIdx"

    for (const [sheet, rows] of sheetRows) {
      for (let i = 0; i < rows.length; i++) {
        const candidate = rows[i];
        // Search nearby rows (within SEARCH_WINDOW) for a metric this could be the growth of
        for (let j = Math.max(0, i - SEARCH_WINDOW); j < Math.min(rows.length, i + SEARCH_WINDOW + 1); j++) {
          if (j === i) continue;
          const metric = rows[j];
          // Skip if candidate has fewer than 2 shared periods with metric
          const sharedPeriods = candidate.periods.filter(p => metric.values.has(p));
          if (sharedPeriods.length < 2) continue;

          // Check: is candidate[t] ≈ metric[t] / metric[t-1] - 1 ?
          let matched = 0;
          let tested = 0;
          for (let k = 1; k < sharedPeriods.length; k++) {
            const prevPeriod = sharedPeriods[k - 1];
            const curPeriod = sharedPeriods[k];
            const metricPrev = metric.values.get(prevPeriod)!;
            const metricCur = metric.values.get(curPeriod)!;
            const candidateVal = candidate.values.get(curPeriod)!;

            if (Math.abs(metricPrev) < 1e-9) continue; // skip zero denominators
            tested++;

            const expectedRate = (metricCur / metricPrev) - 1;
            // Candidate might store as decimal (0.15) or percent (15)
            let actualRate = candidateVal;
            // Try decimal first
            if (Math.abs(actualRate - expectedRate) <= TOLERANCE) {
              matched++;
            }
            // Try percent (candidateVal/100)
            else if (Math.abs(candidateVal / 100 - expectedRate) <= TOLERANCE) {
              matched++;
            }
          }

          if (tested >= 3 && matched / tested >= 0.8) {
            companions.push({
              metricSheet: sheet,
              metricRowIdx: metric.rowIdx,
              metricLabel: metric.label,
              companionRowIdx: candidate.rowIdx,
              companionLabel: candidate.label,
              kind: "poP",
              periodsMatched: matched,
              periodsTested: tested,
              matchRate: matched / tested,
            });
            rateRowIndices.add(`${sheet}|${candidate.rowIdx}`);
          }
        }
      }
    }

    // Grade our reading: compute rate from our values, compare to model's stored rate
    const gradeResults: GradeResult[] = [];
    let totalGraded = 0;
    let rateMatches = 0;
    const mismatchByPattern: Record<string, number> = {};

    for (const comp of companions) {
      const metricKey = `${comp.metricSheet}|${comp.metricRowIdx}`;
      const compKey = `${comp.metricSheet}|${comp.companionRowIdx}`;
      const metric = rowMap.get(metricKey);
      const companion = rowMap.get(compKey);
      if (!metric || !companion) continue;

      const sharedPeriods = metric.periods.filter(p => companion.values.has(p));
      for (let k = 1; k < sharedPeriods.length; k++) {
        const prevP = sharedPeriods[k - 1];
        const curP = sharedPeriods[k];
        const mPrev = metric.values.get(prevP)!;
        const mCur = metric.values.get(curP)!;
        if (Math.abs(mPrev) < 1e-9) continue;

        const ourRate = (mCur / mPrev) - 1;
        let modelRate = companion.values.get(curP)!;
        // Normalize: if model stores as percent, convert
        if (Math.abs(modelRate) > 1 && Math.abs(modelRate / 100 - ourRate) < Math.abs(modelRate - ourRate)) {
          modelRate = modelRate / 100;
        }

        totalGraded++;
        const delta = Math.abs(ourRate - modelRate);
        let pattern = "match";
        if (delta <= TOLERANCE) {
          rateMatches++;
        } else {
          // Check shifted-one pattern
          if (k >= 2) {
            const prevPrev = sharedPeriods[k - 2];
            const mPrevPrev = metric.values.get(prevPrev);
            if (mPrevPrev && Math.abs(mPrevPrev) > 1e-9) {
              const shiftedRate = (mPrev / mPrevPrev) - 1;
              if (Math.abs(shiftedRate - modelRate) <= TOLERANCE) {
                pattern = "shifted_one";
              }
            }
          }
          if (pattern === "match") pattern = "no_match";
          mismatchByPattern[pattern] = (mismatchByPattern[pattern] ?? 0) + 1;
        }

        if (pattern !== "match") {
          gradeResults.push({
            metricSheet: comp.metricSheet,
            metricLabel: metric.label,
            metricRowIdx: metric.rowIdx,
            companionLabel: companion.label,
            companionRowIdx: companion.rowIdx,
            ourRate,
            modelRate,
            delta,
            period: curP,
            pattern,
          });
        }
      }
    }

    // Mark rate rows if requested
    let rateRowsMarked = 0;
    if (markRateRows && rateRowIndices.size > 0) {
      // Update chain_break_reason to include |rate_row for detected rate rows
      const rateEntries = [...rateRowIndices].map(k => {
        const [sheet, ridx] = k.split("|");
        return { sheet, rowIdx: parseInt(ridx) };
      });

      const BATCH = 100;
      for (let i = 0; i < rateEntries.length; i += BATCH) {
        const chunk = rateEntries.slice(i, i + BATCH);
        const conditions: string[] = [];
        const params: unknown[] = [workbookId];
        let pi = 2;
        for (const e of chunk) {
          conditions.push(`(sheet_name = $${pi} AND row_idx = $${pi + 1})`);
          params.push(e.sheet, e.rowIdx);
          pi += 2;
        }
        await q.execute(
          `UPDATE workbook_cells
           SET chain_break_reason = CASE
             WHEN chain_break_reason IS NULL THEN 'rate_row'
             WHEN chain_break_reason NOT LIKE '%rate_row%' THEN chain_break_reason || '|rate_row'
             ELSE chain_break_reason
           END
           WHERE workbook_id = $1 AND (${conditions.join(" OR ")})`,
          params,
          { label: `Mark rate rows batch ${i / BATCH}` },
        );
        rateRowsMarked += chunk.length;
      }
    }

    // Limit mismatch samples for output
    const mismatchSamples = gradeResults.slice(0, 20).map(g => ({
      sheet: g.metricSheet,
      metricLabel: g.metricLabel,
      companionLabel: g.companionLabel,
      period: g.period,
      ourRate: Math.round(g.ourRate * 10000) / 10000,
      modelRate: Math.round(g.modelRate * 10000) / 10000,
      pattern: g.pattern,
    }));

    return {
      companions: companions.map(c => ({
        ...c,
        matchRate: Math.round(c.matchRate * 1000) / 1000,
      })),
      grading: {
        totalMetricRowsWithCompanion: totalGraded,
        rateMatchCount: rateMatches,
        rateMatchPct: totalGraded > 0 ? Math.round(rateMatches / totalGraded * 1000) / 10 : 0,
        mismatchByPattern,
      },
      rateRowsMarked,
      mismatchSamples,
    };
  },
});
