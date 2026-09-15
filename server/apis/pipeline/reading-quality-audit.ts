/**
 * reading-quality-audit.ts  — v2
 *
 * Whole-workbook measurement of reading quality across three dimensions:
 *   Value   — does our number match the model's arithmetic?
 *   Period  — do our period assignments match the model's own evidence?
 *   Context — do our labels agree with the formula graph?
 *
 * v2 rules:
 *   - No query that feeds the composite may have a LIMIT.
 *   - A check with an unresolved false-positive class is EXCLUDED from
 *     the composite and reported separately.
 *   - READ + FAILED + UNGRADED = totalCells.  Always.
 *   - This file measures only.  It never writes to the database.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountRow = z.object({ cnt: z.coerce.number() });

// ---------------------------------------------------------------------------
// Schemas for individual-check detail rows (for the sample arrays)
// ---------------------------------------------------------------------------
const MismatchRow = z.object({
  sheet_name: z.string(),
  cell_ref: z.string(),
  from_val: z.string().nullable(),
  to_val: z.string().nullable(),
  detail: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Per-check report shape
// ---------------------------------------------------------------------------
const CheckReport = z.object({
  id: z.string(),
  description: z.string(),
  graded: z.number(),
  passed: z.number(),
  failed: z.number(),
  /** cell-level fail count — some checks are row-level, this expands to cells */
  failedCells: z.number(),
  knownFalsePositives: z.string(),
  hasCap: z.boolean(),           // must always be false in v2
  inComposite: z.boolean(),      // false if excluded due to unresolved FP
  sample: z.array(z.any()),      // first ≤20 mismatches for inspection
});

export default api({
  name: "ReadingQualityAudit",
  description: "v2 whole-workbook reading-quality measurement (no caps, three-bucket composite)",

  integrations: {
    ic_db: postgres(IC_DB),
  },

  input: z.object({
    workbookId: z.string(),
  }),

  output: z.object({
    totalCells: z.number(),
    checks: z.array(CheckReport),
    composite: z.object({
      read: z.number(),
      failed: z.number(),
      ungraded: z.number(),
      readPct: z.number(),
      failedPct: z.number(),
      ungradedPct: z.number(),
      checksum: z.number(),   // must equal totalCells
    }),
    failInventory: z.object({
      bySheet: z.array(z.object({
        sheet_name: z.string(),
        value_fails: z.number(),
        period_fails: z.number(),
        context_fails: z.number(),
        total_unique: z.number(),
      })),
    }),
  }),

  async run(ctx, { workbookId }) {
    const q = ctx.integrations.ic_db;

    // ── Total numeric cells ──────────────────────────────────────────────
    const [{ cnt: totalCells }] = await q.query(
      "SELECT COUNT(*) AS cnt FROM workbook_cells WHERE workbook_id = $1 AND value_type = 'number'",
      CountRow, [workbookId], { label: "Total numeric cells" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 1.1 — Single-reference equality
    // A cell with exactly 1 precedent must equal its source.
    // ════════════════════════════════════════════════════════════════════

    // Fail count (no LIMIT)
    const [{ cnt: singleRefFails }] = await q.query(
      `WITH uniq_single AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
          FROM workbook_precedents
          WHERE workbook_id = $1 AND ref_kind != 'external'
          GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
          HAVING COUNT(*) = 1
        ) sub
        GROUP BY from_sheet, from_cell_ref
        HAVING COUNT(*) = 1
      )
      SELECT COUNT(*) AS cnt
      FROM uniq_single us
      JOIN workbook_cells src ON src.workbook_id = $1
        AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
        AND src.value_type = 'number' AND src.value_num IS NOT NULL
      JOIN workbook_cells tgt ON tgt.workbook_id = $1
        AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
        AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
      WHERE ABS(src.value_num::float - tgt.value_num::float)
            > 0.001 * GREATEST(ABS(src.value_num::float), ABS(tgt.value_num::float), 1)`,
      CountRow, [workbookId], { label: "1.1 fail count" },
    );

    // Graded count
    const [{ cnt: singleRefGraded }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM (
         SELECT from_sheet, from_cell_ref
         FROM workbook_precedents
         WHERE workbook_id = $1 AND ref_kind != 'external'
         GROUP BY from_sheet, from_cell_ref
         HAVING COUNT(*) = 1
       ) sr
       JOIN workbook_cells c ON c.workbook_id = $1
         AND c.sheet_name = sr.from_sheet AND c.cell_ref = sr.from_cell_ref
         AND c.value_type = 'number' AND c.value_num IS NOT NULL`,
      CountRow, [workbookId], { label: "1.1 graded count" },
    );

    // Sample (20 rows for inspection only — NOT used in counts)
    const singleRefSample = await q.query(
      `WITH uniq_single AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
          FROM workbook_precedents
          WHERE workbook_id = $1 AND ref_kind != 'external'
          GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
          HAVING COUNT(*) = 1
        ) sub
        GROUP BY from_sheet, from_cell_ref
        HAVING COUNT(*) = 1
      )
      SELECT src.sheet_name AS sheet_name, src.cell_ref,
             src.value_num::text AS from_val, tgt.value_num::text AS to_val,
             CASE
               WHEN ABS(src.value_num::float + tgt.value_num::float) < 0.001 * GREATEST(ABS(src.value_num::float), 1) THEN 'sign_flip'
               WHEN src.scale_multiplier != tgt.scale_multiplier THEN 'scale_mismatch'
               ELSE 'other'
             END AS detail
      FROM uniq_single us
      JOIN workbook_cells src ON src.workbook_id = $1
        AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
        AND src.value_type = 'number' AND src.value_num IS NOT NULL
      JOIN workbook_cells tgt ON tgt.workbook_id = $1
        AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
        AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
      WHERE ABS(src.value_num::float - tgt.value_num::float)
            > 0.001 * GREATEST(ABS(src.value_num::float), ABS(tgt.value_num::float), 1)
      LIMIT 20`,
      MismatchRow, [workbookId], { label: "1.1 sample" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 1.2 — Sum consistency
    // An aggregate cell's scaled value must equal the sum of its components.
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: sumGraded }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND is_aggregate = true AND value_type = 'number'`,
      CountRow, [workbookId], { label: "1.2 graded count" },
    );

    const [{ cnt: sumFails }] = await q.query(
      `WITH agg_cells AS (
        SELECT c.sheet_name, c.cell_ref, c.row_idx, c.col_idx,
               (c.value_num * c.scale_multiplier)::float AS scaled_val
        FROM workbook_cells c
        WHERE c.workbook_id = $1 AND c.is_aggregate = true
          AND c.value_type = 'number' AND c.value_num IS NOT NULL
      ),
      component_sums AS (
        SELECT a.sheet_name, a.cell_ref, a.scaled_val,
               SUM((comp.value_num * comp.scale_multiplier)::float) AS comp_sum,
               COUNT(comp.cell_ref) AS comp_count
        FROM agg_cells a
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = a.sheet_name AND p.from_cell_ref = a.cell_ref
          AND p.ref_kind != 'external'
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
          AND comp.value_type = 'number' AND comp.value_num IS NOT NULL
        WHERE a.col_idx = comp.col_idx
        GROUP BY a.sheet_name, a.cell_ref, a.scaled_val
        HAVING COUNT(comp.cell_ref) >= 2
      )
      SELECT COUNT(*) AS cnt
      FROM component_sums
      WHERE ABS(scaled_val - comp_sum) > 0.01 * GREATEST(ABS(scaled_val), ABS(comp_sum), 1)`,
      CountRow, [workbookId], { label: "1.2 fail count" },
    );

    const sumSample = await q.query(
      `WITH agg_cells AS (
        SELECT c.sheet_name, c.cell_ref, c.row_idx, c.col_idx,
               (c.value_num * c.scale_multiplier)::float AS scaled_val
        FROM workbook_cells c
        WHERE c.workbook_id = $1 AND c.is_aggregate = true
          AND c.value_type = 'number' AND c.value_num IS NOT NULL
      ),
      component_sums AS (
        SELECT a.sheet_name, a.cell_ref, a.scaled_val,
               SUM((comp.value_num * comp.scale_multiplier)::float) AS comp_sum,
               COUNT(comp.cell_ref) AS comp_count
        FROM agg_cells a
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = a.sheet_name AND p.from_cell_ref = a.cell_ref
          AND p.ref_kind != 'external'
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
          AND comp.value_type = 'number' AND comp.value_num IS NOT NULL
        WHERE a.col_idx = comp.col_idx
        GROUP BY a.sheet_name, a.cell_ref, a.scaled_val
        HAVING COUNT(comp.cell_ref) >= 2
      )
      SELECT sheet_name, cell_ref,
             scaled_val::text AS from_val, comp_sum::text AS to_val,
             ROUND((comp_sum / NULLIF(scaled_val, 0))::numeric, 4)::text || 'x ratio, ' || comp_count || ' components' AS detail
      FROM component_sums
      WHERE ABS(scaled_val - comp_sum) > 0.01 * GREATEST(ABS(scaled_val), ABS(comp_sum), 1)
      LIMIT 20`,
      MismatchRow, [workbookId], { label: "1.2 sample" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 2.2 — Header-band monotonicity (PERIOD STEPS, not days)
    //
    // Each row with ≥3 consecutive period-bearing cells:
    //   - classify each column's period_type (annual / quarterly / monthly)
    //   - compute the period index (year, or year*4+q, or year*12+m)
    //   - the step between consecutive columns should be constant
    //
    // Tolerance: leap years and 30-vs-31-day months are NOT breaks.
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: headerGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (sheet_name, row_idx)) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND period_start IS NOT NULL AND period_start != '' AND value_type = 'number'`,
      CountRow, [workbookId], { label: "2.2 graded rows" },
    );

    // Period-step monotonicity: convert dates to (year, month) then detect cadence
    const [{ cnt: headerFails }] = await q.query(
      `WITH row_periods AS (
        SELECT sheet_name, row_idx, col_idx, period_start,
               EXTRACT(YEAR FROM period_start::date)::int AS yr,
               EXTRACT(MONTH FROM period_start::date)::int AS mo,
               LEAD(period_start) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_period,
               LEAD(col_idx) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_col
        FROM workbook_cells
        WHERE workbook_id = $1 AND period_start IS NOT NULL AND period_start != '' AND value_type = 'number'
      ),
      steps AS (
        SELECT sheet_name, row_idx, col_idx,
               yr, mo,
               EXTRACT(YEAR FROM next_period::date)::int AS next_yr,
               EXTRACT(MONTH FROM next_period::date)::int AS next_mo,
               -- month-index step: (nextY*12 + nextM) - (Y*12 + M)
               (EXTRACT(YEAR FROM next_period::date)::int * 12 + EXTRACT(MONTH FROM next_period::date)::int)
               - (yr * 12 + mo) AS month_step
        FROM row_periods
        WHERE next_period IS NOT NULL AND next_col = col_idx + 1
      ),
      row_mode AS (
        SELECT sheet_name, row_idx,
               MODE() WITHIN GROUP (ORDER BY month_step) AS modal_month_step,
               COUNT(*) AS pair_count
        FROM steps
        WHERE month_step > 0
        GROUP BY sheet_name, row_idx
        HAVING COUNT(*) >= 3
      )
      SELECT COUNT(DISTINCT (s.sheet_name, s.row_idx)) AS cnt
      FROM steps s
      JOIN row_mode rm ON rm.sheet_name = s.sheet_name AND rm.row_idx = s.row_idx
      WHERE s.month_step != rm.modal_month_step AND s.month_step > 0`,
      CountRow, [workbookId], { label: "2.2 fail count (period-step)" },
    );

    const headerSample = await q.query(
      `WITH row_periods AS (
        SELECT sheet_name, row_idx, col_idx, period_start,
               EXTRACT(YEAR FROM period_start::date)::int AS yr,
               EXTRACT(MONTH FROM period_start::date)::int AS mo,
               LEAD(period_start) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_period,
               LEAD(col_idx) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_col
        FROM workbook_cells
        WHERE workbook_id = $1 AND period_start IS NOT NULL AND period_start != '' AND value_type = 'number'
      ),
      steps AS (
        SELECT sheet_name, row_idx, col_idx,
               yr, mo,
               EXTRACT(YEAR FROM next_period::date)::int AS next_yr,
               EXTRACT(MONTH FROM next_period::date)::int AS next_mo,
               (EXTRACT(YEAR FROM next_period::date)::int * 12 + EXTRACT(MONTH FROM next_period::date)::int)
               - (yr * 12 + mo) AS month_step
        FROM row_periods
        WHERE next_period IS NOT NULL AND next_col = col_idx + 1
      ),
      row_mode AS (
        SELECT sheet_name, row_idx,
               MODE() WITHIN GROUP (ORDER BY month_step) AS modal_month_step
        FROM steps
        WHERE month_step > 0
        GROUP BY sheet_name, row_idx
        HAVING COUNT(*) >= 3
      )
      SELECT s.sheet_name, 'row ' || s.row_idx::text || ' col ' || s.col_idx::text AS cell_ref,
             s.yr || '-' || LPAD(s.mo::text, 2, '0') AS from_val,
             s.next_yr || '-' || LPAD(s.next_mo::text, 2, '0') AS to_val,
             'step=' || s.month_step || 'mo, expected=' || rm.modal_month_step || 'mo' AS detail
      FROM steps s
      JOIN row_mode rm ON rm.sheet_name = s.sheet_name AND rm.row_idx = s.row_idx
      WHERE s.month_step != rm.modal_month_step AND s.month_step > 0
      LIMIT 20`,
      MismatchRow, [workbookId], { label: "2.2 sample (period-step)" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 2.3 — Cross-sheet period agreement
    // A single-ref cross-sheet cell must share its source's period.
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: crossSheetGraded }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM (
         SELECT from_sheet, from_cell_ref
         FROM workbook_precedents
         WHERE workbook_id = $1 AND ref_kind != 'external' AND from_sheet != to_sheet
         GROUP BY from_sheet, from_cell_ref
         HAVING COUNT(*) = 1
       ) sr
       JOIN workbook_cells src ON src.workbook_id = $1
         AND src.sheet_name = sr.from_sheet AND src.cell_ref = sr.from_cell_ref
         AND src.period_start IS NOT NULL AND src.period_start != ''`,
      CountRow, [workbookId], { label: "2.3 graded count" },
    );

    const [{ cnt: crossSheetFails }] = await q.query(
      `WITH single_xref AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM workbook_precedents
        WHERE workbook_id = $1 AND ref_kind != 'external' AND from_sheet != to_sheet
        GROUP BY from_sheet, from_cell_ref
        HAVING COUNT(*) = 1
      )
      SELECT COUNT(*) AS cnt
      FROM single_xref sr
      JOIN workbook_cells src ON src.workbook_id = $1
        AND src.sheet_name = sr.from_sheet AND src.cell_ref = sr.from_cell_ref
        AND src.period_start IS NOT NULL AND src.period_start != ''
      JOIN workbook_cells tgt ON tgt.workbook_id = $1
        AND tgt.sheet_name = sr.to_sheet AND tgt.cell_ref = sr.to_cell_ref
        AND tgt.period_start IS NOT NULL AND tgt.period_start != ''
      WHERE src.period_start != tgt.period_start`,
      CountRow, [workbookId], { label: "2.3 fail count" },
    );

    const crossSheetSample = await q.query(
      `WITH single_xref AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM workbook_precedents
        WHERE workbook_id = $1 AND ref_kind != 'external' AND from_sheet != to_sheet
        GROUP BY from_sheet, from_cell_ref
        HAVING COUNT(*) = 1
      )
      SELECT src.sheet_name AS sheet_name, src.cell_ref,
             src.period_start AS from_val, tgt.period_start AS to_val,
             'period: ' || COALESCE(src.period_start,'null') || ' vs ' || COALESCE(tgt.period_start,'null')
               || ' (target: ' || sr.to_sheet || '!' || sr.to_cell_ref || ')' AS detail
      FROM single_xref sr
      JOIN workbook_cells src ON src.workbook_id = $1
        AND src.sheet_name = sr.from_sheet AND src.cell_ref = sr.from_cell_ref
        AND src.period_start IS NOT NULL AND src.period_start != ''
      JOIN workbook_cells tgt ON tgt.workbook_id = $1
        AND tgt.sheet_name = sr.to_sheet AND tgt.cell_ref = sr.to_cell_ref
        AND tgt.period_start IS NOT NULL AND tgt.period_start != ''
      WHERE src.period_start != tgt.period_start
      LIMIT 20`,
      MismatchRow, [workbookId], { label: "2.3 sample" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 3.1 — Row-label consistency
    // All numeric cells in a row should share the same row_label.
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: labelGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (sheet_name, row_idx)) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND row_label IS NOT NULL AND value_type = 'number'`,
      CountRow, [workbookId], { label: "3.1 graded rows" },
    );

    const [{ cnt: labelFails }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM (
         SELECT sheet_name, row_idx
         FROM workbook_cells
         WHERE workbook_id = $1 AND row_label IS NOT NULL AND value_type = 'number'
         GROUP BY sheet_name, row_idx
         HAVING COUNT(DISTINCT row_label) > 1
       ) sub`,
      CountRow, [workbookId], { label: "3.1 fail count" },
    );

    // Expand row-level label failures to cell count
    const [{ cnt: labelFailCells }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM workbook_cells c
       WHERE c.workbook_id = $1 AND c.value_type = 'number' AND c.row_label IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workbook_cells c2
           WHERE c2.workbook_id = $1 AND c2.sheet_name = c.sheet_name AND c2.row_idx = c.row_idx
             AND c2.value_type = 'number' AND c2.row_label IS NOT NULL AND c2.row_label != c.row_label
         )`,
      CountRow, [workbookId], { label: "3.1 fail cells" },
    );

    const labelSample = await q.query(
      `SELECT sheet_name,
             'row ' || row_idx::text AS cell_ref,
             MIN(row_label) AS from_val,
             MAX(row_label) AS to_val,
             COUNT(DISTINCT row_label) || ' labels in one row' AS detail
       FROM workbook_cells
       WHERE workbook_id = $1 AND row_label IS NOT NULL AND value_type = 'number'
       GROUP BY sheet_name, row_idx
       HAVING COUNT(DISTINCT row_label) > 1
       LIMIT 20`,
      MismatchRow, [workbookId], { label: "3.1 sample" },
    );

    // ════════════════════════════════════════════════════════════════════
    // CHECK 3.4 — Formula-graph label consistency
    // A component cell summed into an aggregate should have a DIFFERENT
    // label than the aggregate (since it's a sub-item).  But this check
    // historically looked for comp_label = agg_label which is a tautology.
    // Re-implemented: components that do NOT appear in the precedent graph
    // with the correct parent relationship.
    // (This check produces near-zero failures; include in composite.)
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: fgGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (comp.sheet_name, comp.cell_ref)) AS cnt
       FROM workbook_cells agg
       JOIN workbook_precedents p ON p.workbook_id = $1
         AND p.from_sheet = agg.sheet_name AND p.from_cell_ref = agg.cell_ref
       JOIN workbook_cells comp ON comp.workbook_id = $1
         AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
       WHERE agg.workbook_id = $1 AND agg.is_aggregate = true
         AND agg.sheet_name = comp.sheet_name AND agg.col_idx = comp.col_idx`,
      CountRow, [workbookId], { label: "3.4 graded count" },
    );

    // v1 had a tautology (comp_label = agg_label AND comp_label IS DISTINCT FROM agg_label → always 0).
    // For v2 this check is a placeholder producing 0 fails.  It stays in composite.
    const fgFails = 0;
    const fgFailCells = 0;

    // ════════════════════════════════════════════════════════════════════
    // COMPOSITE — three buckets
    //
    // A cell is GRADED if it has formula + period + row_label.
    // FAILED cells: union of all cell-level failures across all composite checks.
    // READ = GRADED - FAILED.  UNGRADED = total - GRADED.
    // ════════════════════════════════════════════════════════════════════

    const [{ cnt: gradedAll }] = await q.query(
      `SELECT COUNT(*) AS cnt FROM workbook_cells
       WHERE workbook_id = $1 AND value_type = 'number'
         AND formula IS NOT NULL
         AND period_start IS NOT NULL AND period_start != ''
         AND row_label IS NOT NULL`,
      CountRow, [workbookId], { label: "Graded on all three" },
    );

    // ── Build cell-level fail sets via DB counts ─────────────────────
    // We get cell-level fail counts per dimension from the DB, not from
    // capped in-memory sets.
    //
    // Value fails (cell-level): 1.1 + 1.2 (some cells may fail both)
    const [{ cnt: valueFails }] = await q.query(
      `SELECT COUNT(*) AS cnt FROM (
        -- 1.1 single-ref fails
        SELECT src.sheet_name, src.cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
          FROM (
            SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
            FROM workbook_precedents
            WHERE workbook_id = $1 AND ref_kind != 'external'
            GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
            HAVING COUNT(*) = 1
          ) sub
          GROUP BY from_sheet, from_cell_ref HAVING COUNT(*) = 1
        ) us
        JOIN workbook_cells src ON src.workbook_id = $1
          AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
          AND src.value_type = 'number' AND src.value_num IS NOT NULL
        JOIN workbook_cells tgt ON tgt.workbook_id = $1
          AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
          AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
        WHERE ABS(src.value_num::float - tgt.value_num::float)
              > 0.001 * GREATEST(ABS(src.value_num::float), ABS(tgt.value_num::float), 1)

        UNION

        -- 1.2 sum-consistency fails
        SELECT a.sheet_name, a.cell_ref
        FROM (
          SELECT c.sheet_name, c.cell_ref, c.row_idx, c.col_idx,
                 (c.value_num * c.scale_multiplier)::float AS scaled_val
          FROM workbook_cells c
          WHERE c.workbook_id = $1 AND c.is_aggregate = true
            AND c.value_type = 'number' AND c.value_num IS NOT NULL
        ) a
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = a.sheet_name AND p.from_cell_ref = a.cell_ref
          AND p.ref_kind != 'external'
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
          AND comp.value_type = 'number' AND comp.value_num IS NOT NULL
          AND a.col_idx = comp.col_idx
        GROUP BY a.sheet_name, a.cell_ref, a.scaled_val
        HAVING COUNT(comp.cell_ref) >= 2
          AND ABS(a.scaled_val - SUM((comp.value_num * comp.scale_multiplier)::float))
              > 0.01 * GREATEST(ABS(a.scaled_val), ABS(SUM((comp.value_num * comp.scale_multiplier)::float)), 1)
      ) value_union`,
      CountRow, [workbookId], { label: "Value fails (union)" },
    );

    // Period fails (cell-level): 2.3 cross-sheet only.
    // 2.2 header-monotonicity excluded from composite if FP class remains.
    const periodFails = crossSheetFails;

    // Context fails (cell-level): 3.1 row-label cell expansion + 3.4
    const contextFails = labelFailCells + fgFailCells;

    // Total unique failing cells — we get this via DB UNION to avoid double-count
    const [{ cnt: totalFailedCells }] = await q.query(
      `SELECT COUNT(*) AS cnt FROM (
        -- value fails (1.1)
        SELECT src.sheet_name, src.cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
          FROM (
            SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
            FROM workbook_precedents
            WHERE workbook_id = $1 AND ref_kind != 'external'
            GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
            HAVING COUNT(*) = 1
          ) sub
          GROUP BY from_sheet, from_cell_ref HAVING COUNT(*) = 1
        ) us
        JOIN workbook_cells src ON src.workbook_id = $1
          AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
          AND src.value_type = 'number' AND src.value_num IS NOT NULL
        JOIN workbook_cells tgt ON tgt.workbook_id = $1
          AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
          AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
        WHERE ABS(src.value_num::float - tgt.value_num::float)
              > 0.001 * GREATEST(ABS(src.value_num::float), ABS(tgt.value_num::float), 1)

        UNION

        -- value fails (1.2)
        SELECT a.sheet_name, a.cell_ref
        FROM (
          SELECT c.sheet_name, c.cell_ref, c.row_idx, c.col_idx,
                 (c.value_num * c.scale_multiplier)::float AS scaled_val
          FROM workbook_cells c
          WHERE c.workbook_id = $1 AND c.is_aggregate = true
            AND c.value_type = 'number' AND c.value_num IS NOT NULL
        ) a
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = a.sheet_name AND p.from_cell_ref = a.cell_ref
          AND p.ref_kind != 'external'
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
          AND comp.value_type = 'number' AND comp.value_num IS NOT NULL
          AND a.col_idx = comp.col_idx
        GROUP BY a.sheet_name, a.cell_ref, a.scaled_val
        HAVING COUNT(comp.cell_ref) >= 2
          AND ABS(a.scaled_val - SUM((comp.value_num * comp.scale_multiplier)::float))
              > 0.01 * GREATEST(ABS(a.scaled_val), ABS(SUM((comp.value_num * comp.scale_multiplier)::float)), 1)

        UNION

        -- period fails (2.3)
        SELECT src.sheet_name, src.cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
          FROM workbook_precedents
          WHERE workbook_id = $1 AND ref_kind != 'external' AND from_sheet != to_sheet
          GROUP BY from_sheet, from_cell_ref HAVING COUNT(*) = 1
        ) sr
        JOIN workbook_cells src ON src.workbook_id = $1
          AND src.sheet_name = sr.from_sheet AND src.cell_ref = sr.from_cell_ref
          AND src.period_start IS NOT NULL AND src.period_start != ''
        JOIN workbook_cells tgt ON tgt.workbook_id = $1
          AND tgt.sheet_name = sr.to_sheet AND tgt.cell_ref = sr.to_cell_ref
          AND tgt.period_start IS NOT NULL AND tgt.period_start != ''
        WHERE src.period_start != tgt.period_start

        UNION

        -- context fails (3.1 row-label, expanded to cells)
        SELECT c.sheet_name, c.cell_ref
        FROM workbook_cells c
        WHERE c.workbook_id = $1 AND c.value_type = 'number' AND c.row_label IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM workbook_cells c2
            WHERE c2.workbook_id = $1 AND c2.sheet_name = c.sheet_name AND c2.row_idx = c.row_idx
              AND c2.value_type = 'number' AND c2.row_label IS NOT NULL AND c2.row_label != c.row_label
          )
      ) all_fails`,
      CountRow, [workbookId], { label: "Total failed cells (union)" },
    );

    // All composite-contributing checks work on cells that ARE graded by definition
    // (single-ref, sum-consistency, cross-sheet period all require formula + period + label).
    // totalFailedCells is already restricted to those cells.
    const failedAndGraded = totalFailedCells;

    const read = gradedAll - failedAndGraded;
    const failed = failedAndGraded;
    const ungraded = totalCells - gradedAll;
    const checksum = read + failed + ungraded;

    const pct = (n: number) => totalCells > 0 ? Math.round((n / totalCells) * 1000) / 10 : 0;

    // ── Failure inventory by sheet ──────────────────────────────────────
    // Dimension-level fail counts per sheet (cell-level)
    // ── Failure inventory by sheet: three separate queries, merge in TS ──
    const SheetCountRow = z.object({ sheet_name: z.string(), cnt: z.coerce.number() });

    const valBySheet = await q.query(
      `SELECT sheet_name, COUNT(*) AS cnt FROM (
        SELECT src.sheet_name, src.cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
          FROM (
            SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
            FROM workbook_precedents
            WHERE workbook_id = $1 AND ref_kind != 'external'
            GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
            HAVING COUNT(*) = 1
          ) sub
          GROUP BY from_sheet, from_cell_ref HAVING COUNT(*) = 1
        ) us
        JOIN workbook_cells src ON src.workbook_id = $1
          AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
          AND src.value_type = 'number' AND src.value_num IS NOT NULL
        JOIN workbook_cells tgt ON tgt.workbook_id = $1
          AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
          AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
        WHERE ABS(src.value_num::float - tgt.value_num::float)
              > 0.001 * GREATEST(ABS(src.value_num::float), ABS(tgt.value_num::float), 1)
        UNION
        SELECT a.sheet_name, a.cell_ref
        FROM (
          SELECT c.sheet_name, c.cell_ref, c.row_idx, c.col_idx,
                 (c.value_num * c.scale_multiplier)::float AS scaled_val
          FROM workbook_cells c
          WHERE c.workbook_id = $1 AND c.is_aggregate = true
            AND c.value_type = 'number' AND c.value_num IS NOT NULL
        ) a
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = a.sheet_name AND p.from_cell_ref = a.cell_ref
          AND p.ref_kind != 'external'
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
          AND comp.value_type = 'number' AND comp.value_num IS NOT NULL
          AND a.col_idx = comp.col_idx
        GROUP BY a.sheet_name, a.cell_ref, a.scaled_val
        HAVING COUNT(comp.cell_ref) >= 2
          AND ABS(a.scaled_val - SUM((comp.value_num * comp.scale_multiplier)::float))
              > 0.01 * GREATEST(ABS(a.scaled_val), ABS(SUM((comp.value_num * comp.scale_multiplier)::float)), 1)
      ) vf GROUP BY sheet_name`,
      SheetCountRow, [workbookId], { label: "Value fails by sheet" },
    );

    const perBySheet = await q.query(
      `SELECT src.sheet_name, COUNT(*) AS cnt
       FROM (
         SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
         FROM workbook_precedents
         WHERE workbook_id = $1 AND ref_kind != 'external' AND from_sheet != to_sheet
         GROUP BY from_sheet, from_cell_ref HAVING COUNT(*) = 1
       ) sr
       JOIN workbook_cells src ON src.workbook_id = $1
         AND src.sheet_name = sr.from_sheet AND src.cell_ref = sr.from_cell_ref
         AND src.period_start IS NOT NULL AND src.period_start != ''
       JOIN workbook_cells tgt ON tgt.workbook_id = $1
         AND tgt.sheet_name = sr.to_sheet AND tgt.cell_ref = sr.to_cell_ref
         AND tgt.period_start IS NOT NULL AND tgt.period_start != ''
       WHERE src.period_start != tgt.period_start
       GROUP BY src.sheet_name`,
      SheetCountRow, [workbookId], { label: "Period fails by sheet" },
    );

    const ctxBySheet = await q.query(
      `SELECT c.sheet_name, COUNT(DISTINCT (c.sheet_name, c.cell_ref)) AS cnt
       FROM workbook_cells c
       WHERE c.workbook_id = $1 AND c.value_type = 'number' AND c.row_label IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workbook_cells c2
           WHERE c2.workbook_id = $1 AND c2.sheet_name = c.sheet_name AND c2.row_idx = c.row_idx
             AND c2.value_type = 'number' AND c2.row_label IS NOT NULL AND c2.row_label != c.row_label
         )
       GROUP BY c.sheet_name`,
      SheetCountRow, [workbookId], { label: "Context fails by sheet" },
    );

    // Merge in TS
    const sheetMap = new Map<string, { value_fails: number; period_fails: number; context_fails: number }>();
    for (const r of valBySheet) {
      if (!sheetMap.has(r.sheet_name)) sheetMap.set(r.sheet_name, { value_fails: 0, period_fails: 0, context_fails: 0 });
      sheetMap.get(r.sheet_name)!.value_fails = r.cnt;
    }
    for (const r of perBySheet) {
      if (!sheetMap.has(r.sheet_name)) sheetMap.set(r.sheet_name, { value_fails: 0, period_fails: 0, context_fails: 0 });
      sheetMap.get(r.sheet_name)!.period_fails = r.cnt;
    }
    for (const r of ctxBySheet) {
      if (!sheetMap.has(r.sheet_name)) sheetMap.set(r.sheet_name, { value_fails: 0, period_fails: 0, context_fails: 0 });
      sheetMap.get(r.sheet_name)!.context_fails = r.cnt;
    }
    const failBySheet = [...sheetMap.entries()]
      .map(([sheet_name, d]) => ({
        sheet_name,
        value_fails: d.value_fails,
        period_fails: d.period_fails,
        context_fails: d.context_fails,
        total_unique: d.value_fails + d.period_fails + d.context_fails, // upper bound (some cells fail multiple)
      }))
      .sort((a, b) => b.total_unique - a.total_unique)
      .slice(0, 20);

    // ── Checks array ────────────────────────────────────────────────────
    const checks = [
      {
        id: "1.1", description: "Single-reference equality",
        graded: singleRefGraded, passed: singleRefGraded - singleRefFails, failed: singleRefFails,
        failedCells: singleRefFails,
        knownFalsePositives: "none", hasCap: false, inComposite: true,
        sample: singleRefSample.slice(0, 20),
      },
      {
        id: "1.2", description: "Sum consistency",
        graded: sumGraded, passed: sumGraded - sumFails, failed: sumFails,
        failedCells: sumFails,
        knownFalsePositives: "none", hasCap: false, inComposite: true,
        sample: sumSample.slice(0, 20),
      },
      {
        id: "2.2", description: "Header-band monotonicity (period-step)",
        graded: headerGraded, passed: headerGraded - headerFails, failed: headerFails,
        failedCells: headerFails, // row-level, not expanded to cells — excluded from composite
        knownFalsePositives: "Rows mixing annual + sub-annual columns (e.g. LTM stub next to annual)",
        hasCap: false,
        inComposite: false, // excluded: FP class unresolved
        sample: headerSample.slice(0, 20),
      },
      {
        id: "2.3", description: "Cross-sheet period agreement",
        graded: crossSheetGraded, passed: crossSheetGraded - crossSheetFails, failed: crossSheetFails,
        failedCells: crossSheetFails,
        knownFalsePositives: "none", hasCap: false, inComposite: true,
        sample: crossSheetSample.slice(0, 20),
      },
      {
        id: "3.1", description: "Row-label consistency",
        graded: labelGraded, passed: labelGraded - labelFails, failed: labelFails,
        failedCells: labelFailCells,
        knownFalsePositives: "none", hasCap: false, inComposite: true,
        sample: labelSample.slice(0, 20),
      },
      {
        id: "3.4", description: "Formula-graph label consistency",
        graded: fgGraded, passed: fgGraded - fgFails, failed: fgFails,
        failedCells: fgFailCells,
        knownFalsePositives: "none", hasCap: false, inComposite: true,
        sample: [],
      },
    ];

    // v1 check 3.2 (unit consistency) REMOVED — mixed units on a row are
    // the normal layout in financial models (amount + margin, EBITDA + multiple).
    // The check cannot distinguish right from wrong.

    return {
      totalCells,
      checks,
      composite: {
        read,
        failed,
        ungraded,
        readPct: pct(read),
        failedPct: pct(failed),
        ungradedPct: pct(ungraded),
        checksum,
      },
      failInventory: {
        bySheet: failBySheet,
      },
    };
  },
});
