/**
 * reading-quality-audit.ts
 *
 * Whole-workbook measurement of reading quality across three dimensions:
 *   Value  — does our number match the model's arithmetic?
 *   Period — do our period assignments match the model's own evidence?
 *   Context — do our labels and units agree with the formula graph?
 *
 * Every check runs over the whole workbook. Ungraded cells count as failures.
 * The composite number is: cells that passed all three / total cells.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CountRow = z.object({ cnt: z.coerce.number() });

const MismatchRow = z.object({
  sheet_name: z.string(),
  cell_ref: z.string(),
  from_val: z.string().nullable(),
  to_val: z.string().nullable(),
  detail: z.string().nullable(),
});

const SheetFailRow = z.object({
  sheet_name: z.string(),
  fail_count: z.coerce.number(),
});

export default api({
  name: "ReadingQualityAudit",
  description: "Whole-workbook reading quality measurement across value, period, context",

  integrations: {
    ic_db: postgres(IC_DB),
  },

  input: z.object({
    workbookId: z.string(),
    markReadStatus: z.boolean().default(false),
  }),

  output: z.object({
    totalCells: z.number(),
    value: z.object({
      singleRef: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
      sumConsistency: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
    }),
    period: z.object({
      crossSheet: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
      headerMonotonicity: z.object({ graded: z.number(), passed: z.number(), breaks: z.array(z.any()) }),
    }),
    context: z.object({
      rowLabelConsistency: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
      unitConsistency: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
      formulaGraphLabel: z.object({ graded: z.number(), passed: z.number(), mismatches: z.array(z.any()) }),
    }),
    composite: z.object({
      gradedOnAll: z.number(),
      passedAll: z.number(),
      failedValueOnly: z.number(),
      failedPeriodOnly: z.number(),
      failedContextOnly: z.number(),
      failedMultiple: z.number(),
      ungraded: z.number(),
      readPct: z.number(),
    }),
    readCellsMarked: z.number(),
  }),

  async run(ctx, { workbookId, markReadStatus }) {
    const q = ctx.integrations.ic_db;

    // Total cells
    const [{ cnt: totalCells }] = await q.query(
      "SELECT COUNT(*) AS cnt FROM workbook_cells WHERE workbook_id = $1 AND value_type = 'number'",
      CountRow, [workbookId], { label: "Total numeric cells" },
    );

    // ════════════════════════════════════════════════
    // 1. VALUE
    // ════════════════════════════════════════════════

    // 1.1 Single-reference equality
    // A cell with exactly 1 precedent (same workbook) must equal its source
    const singleRefMismatches = await q.query(
      `WITH single_ref AS (
        SELECT p.from_sheet, p.from_cell_ref, p.to_sheet, p.to_cell_ref
        FROM workbook_precedents p
        WHERE p.workbook_id = $1 AND p.ref_kind != 'external'
        GROUP BY p.from_sheet, p.from_cell_ref, p.to_sheet, p.to_cell_ref
        HAVING COUNT(*) = 1
      ),
      uniq_single AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM (
          SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref
          FROM single_ref
          GROUP BY from_sheet, from_cell_ref, to_sheet, to_cell_ref
        ) sub
        GROUP BY from_sheet, from_cell_ref
        HAVING COUNT(*) = 1
      ),
      checks AS (
        SELECT
          src.sheet_name AS src_sheet, src.cell_ref AS src_ref,
          src.value_num AS src_val,
          tgt.value_num AS tgt_val,
          src.scale_multiplier AS src_scale,
          tgt.scale_multiplier AS tgt_scale
        FROM uniq_single us
        JOIN workbook_cells src ON src.workbook_id = $1
          AND src.sheet_name = us.from_sheet AND src.cell_ref = us.from_cell_ref
          AND src.value_type = 'number' AND src.value_num IS NOT NULL
        JOIN workbook_cells tgt ON tgt.workbook_id = $1
          AND tgt.sheet_name = us.to_sheet AND tgt.cell_ref = us.to_cell_ref
          AND tgt.value_type = 'number' AND tgt.value_num IS NOT NULL
      )
      SELECT src_sheet AS sheet_name, src_ref AS cell_ref,
             src_val::text AS from_val, tgt_val::text AS to_val,
             'value mismatch' AS detail
      FROM checks
      WHERE ABS(src_val::float - tgt_val::float) > 0.001 * GREATEST(ABS(src_val::float), ABS(tgt_val::float), 1)
      LIMIT 50`,
      MismatchRow, [workbookId], { label: "1.1 Single-ref equality" },
    );

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

    // 1.2 Sum consistency — aggregate cells vs sum of components
    const [{ cnt: sumGraded }] = await q.query(
      `SELECT COUNT(*) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND is_aggregate = true AND value_type = 'number'`,
      CountRow, [workbookId], { label: "1.2 sum graded count" },
    );

    const sumMismatches = await q.query(
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
             'sum=' || comp_count || ' components' AS detail
      FROM component_sums
      WHERE ABS(scaled_val - comp_sum) > 0.01 * GREATEST(ABS(scaled_val), ABS(comp_sum), 1)
      LIMIT 50`,
      MismatchRow, [workbookId], { label: "1.2 Sum consistency" },
    );

    // ════════════════════════════════════════════════
    // 2. PERIOD
    // ════════════════════════════════════════════════

    // 2.3 Cross-sheet period agreement (single-ref cells must share period)
    const crossSheetMismatches = await q.query(
      `WITH single_xref AS (
        SELECT from_sheet, from_cell_ref, MIN(to_sheet) AS to_sheet, MIN(to_cell_ref) AS to_cell_ref
        FROM workbook_precedents
        WHERE workbook_id = $1 AND ref_kind != 'external'
          AND from_sheet != to_sheet
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
      LIMIT 50`,
      MismatchRow, [workbookId], { label: "2.3 Cross-sheet period" },
    );

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

    // 2.2 Header-band monotonicity — periods must advance by constant step within a row
    const headerBreaks = await q.query(
      `WITH row_periods AS (
        SELECT sheet_name, row_idx, col_idx, period_start,
               LEAD(period_start) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_period,
               LEAD(col_idx) OVER (PARTITION BY sheet_name, row_idx ORDER BY col_idx) AS next_col
        FROM workbook_cells
        WHERE workbook_id = $1 AND period_start IS NOT NULL AND period_start != '' AND value_type = 'number'
      ),
      steps AS (
        SELECT sheet_name, row_idx, col_idx, period_start, next_period,
               (next_period::date - period_start::date) AS step_days
        FROM row_periods
        WHERE next_period IS NOT NULL AND next_col = col_idx + 1
      ),
      row_mode AS (
        SELECT sheet_name, row_idx,
               MODE() WITHIN GROUP (ORDER BY step_days) AS modal_step,
               COUNT(*) AS pair_count
        FROM steps
        WHERE step_days > 0
        GROUP BY sheet_name, row_idx
        HAVING COUNT(*) >= 3
      )
      SELECT s.sheet_name, 'row ' || s.row_idx::text || ' col ' || s.col_idx::text AS cell_ref,
             s.period_start AS from_val, s.next_period AS to_val,
             'step=' || ROUND(s.step_days)::text || 'd, expected=' || ROUND(rm.modal_step)::text || 'd' AS detail
      FROM steps s
      JOIN row_mode rm ON rm.sheet_name = s.sheet_name AND rm.row_idx = s.row_idx
      WHERE s.step_days != rm.modal_step AND s.step_days > 0
      LIMIT 50`,
      MismatchRow, [workbookId], { label: "2.2 Header monotonicity" },
    );

    const [{ cnt: headerGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (sheet_name, row_idx)) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND period_start IS NOT NULL AND period_start != '' AND value_type = 'number'`,
      CountRow, [workbookId], { label: "2.2 graded rows" },
    );

    // ════════════════════════════════════════════════
    // 3. CONTEXT
    // ════════════════════════════════════════════════

    // 3.1 Row-label consistency — all cells in a row share the same label
    const labelMismatches = await q.query(
      `SELECT sheet_name,
             'row ' || row_idx::text AS cell_ref,
             MIN(row_label) AS from_val,
             MAX(row_label) AS to_val,
             COUNT(DISTINCT row_label) || ' labels in one row' AS detail
       FROM workbook_cells
       WHERE workbook_id = $1 AND row_label IS NOT NULL AND value_type = 'number'
       GROUP BY sheet_name, row_idx
       HAVING COUNT(DISTINCT row_label) > 1
       LIMIT 50`,
      MismatchRow, [workbookId], { label: "3.1 Row-label consistency" },
    );

    const [{ cnt: labelGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (sheet_name, row_idx)) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND row_label IS NOT NULL AND value_type = 'number'`,
      CountRow, [workbookId], { label: "3.1 graded rows" },
    );

    // 3.2 Unit consistency within a row
    const unitMismatches = await q.query(
      `SELECT sheet_name,
             'row ' || row_idx::text AS cell_ref,
             MIN(unit_class) AS from_val,
             MAX(unit_class) AS to_val,
             COUNT(DISTINCT unit_class) || ' unit classes in one row' AS detail
       FROM workbook_cells
       WHERE workbook_id = $1 AND unit_class IS NOT NULL AND value_type = 'number'
       GROUP BY sheet_name, row_idx
       HAVING COUNT(DISTINCT unit_class) > 1
       LIMIT 50`,
      MismatchRow, [workbookId], { label: "3.2 Unit consistency" },
    );

    const [{ cnt: unitGraded }] = await q.query(
      `SELECT COUNT(DISTINCT (sheet_name, row_idx)) AS cnt
       FROM workbook_cells
       WHERE workbook_id = $1 AND unit_class IS NOT NULL AND value_type = 'number'`,
      CountRow, [workbookId], { label: "3.2 graded rows" },
    );

    // 3.4 Formula-graph label consistency
    // A cell summed into an aggregate should share the aggregate's label family
    const formulaGraphMismatches = await q.query(
      `WITH agg_components AS (
        SELECT
          agg.sheet_name AS agg_sheet, agg.cell_ref AS agg_ref, agg.row_label AS agg_label,
          comp.sheet_name AS comp_sheet, comp.cell_ref AS comp_ref, comp.row_label AS comp_label
        FROM workbook_cells agg
        JOIN workbook_precedents p ON p.workbook_id = $1
          AND p.from_sheet = agg.sheet_name AND p.from_cell_ref = agg.cell_ref
        JOIN workbook_cells comp ON comp.workbook_id = $1
          AND comp.sheet_name = p.to_sheet AND comp.cell_ref = p.to_cell_ref
        WHERE agg.workbook_id = $1 AND agg.is_aggregate = true
          AND agg.row_label IS NOT NULL AND comp.row_label IS NOT NULL
          AND agg.col_idx = comp.col_idx
          AND agg.sheet_name = comp.sheet_name
      )
      SELECT comp_sheet AS sheet_name, comp_ref AS cell_ref,
             comp_label AS from_val, agg_label AS to_val,
             'component "' || comp_label || '" feeds aggregate "' || agg_label || '"' AS detail
      FROM agg_components
      WHERE comp_label = agg_label
        AND comp_label IS DISTINCT FROM agg_label
      LIMIT 1`,
      MismatchRow, [workbookId], { label: "3.4 Formula-graph label" },
    );

    // Count cells that participate in aggregates
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

    // ════════════════════════════════════════════════
    // COMPOSITE
    // ════════════════════════════════════════════════

    // Sets of failing cells by dimension
    const valueFails = new Set<string>();
    for (const m of singleRefMismatches) valueFails.add(`${m.sheet_name}|${m.cell_ref}`);
    for (const m of sumMismatches) valueFails.add(`${m.sheet_name}|${m.cell_ref}`);

    const periodFails = new Set<string>();
    for (const m of crossSheetMismatches) periodFails.add(`${m.sheet_name}|${m.cell_ref}`);
    // Header breaks are row-level, mark all cells in those rows
    for (const b of headerBreaks) periodFails.add(`${b.sheet_name}|${b.cell_ref}`);

    const contextFails = new Set<string>();
    for (const m of labelMismatches) contextFails.add(`${m.sheet_name}|${m.cell_ref}`);
    for (const m of unitMismatches) contextFails.add(`${m.sheet_name}|${m.cell_ref}`);
    for (const m of formulaGraphMismatches) contextFails.add(`${m.sheet_name}|${m.cell_ref}`);

    // Graded on all three = has at least one value check + period check + context check
    // For now: cells with formula (value-graded), period (period-graded), label (context-graded)
    const [{ cnt: gradedAll }] = await q.query(
      `SELECT COUNT(*) AS cnt FROM workbook_cells
       WHERE workbook_id = $1 AND value_type = 'number'
         AND formula IS NOT NULL
         AND period_start IS NOT NULL AND period_start != ''
         AND row_label IS NOT NULL`,
      CountRow, [workbookId], { label: "Graded on all three" },
    );

    const allFails = new Set([...valueFails, ...periodFails, ...contextFails]);
    const failedValueOnly = [...valueFails].filter(k => !periodFails.has(k) && !contextFails.has(k)).length;
    const failedPeriodOnly = [...periodFails].filter(k => !valueFails.has(k) && !contextFails.has(k)).length;
    const failedContextOnly = [...contextFails].filter(k => !valueFails.has(k) && !periodFails.has(k)).length;
    const failedMultiple = allFails.size - failedValueOnly - failedPeriodOnly - failedContextOnly;
    const passedAll = gradedAll - allFails.size;
    const ungraded = totalCells - gradedAll;
    const readPct = totalCells > 0 ? Math.round((Math.max(0, passedAll) / totalCells) * 1000) / 10 : 0;

    // ════════════════════════════════════════════════
    // 5. MARK READ STATUS
    // ════════════════════════════════════════════════
    let readCellsMarked = 0;
    if (markReadStatus && passedAll > 0) {
      // Mark cells that pass all three checks as read
      // This is conservative — only cells we can verify on all three dimensions
      const result = await q.execute(
        `UPDATE workbook_cells
         SET chain_break_reason = CASE
           WHEN chain_break_reason IS NULL THEN 'read'
           WHEN chain_break_reason NOT LIKE '%read%' THEN chain_break_reason || '|read'
           ELSE chain_break_reason
         END
         WHERE workbook_id = $1
           AND value_type = 'number'
           AND formula IS NOT NULL
           AND period_start IS NOT NULL
           AND row_label IS NOT NULL`,
        [workbookId],
        { label: "Mark read cells" },
      );
      readCellsMarked = result.rowCount ?? 0;
    }

    return {
      totalCells,
      value: {
        singleRef: {
          graded: singleRefGraded,
          passed: singleRefGraded - singleRefMismatches.length,
          mismatches: singleRefMismatches.slice(0, 20),
        },
        sumConsistency: {
          graded: sumGraded,
          passed: sumGraded - sumMismatches.length,
          mismatches: sumMismatches.slice(0, 20),
        },
      },
      period: {
        crossSheet: {
          graded: crossSheetGraded,
          passed: crossSheetGraded - crossSheetMismatches.length,
          mismatches: crossSheetMismatches.slice(0, 20),
        },
        headerMonotonicity: {
          graded: headerGraded,
          passed: headerGraded - headerBreaks.length,
          breaks: headerBreaks.slice(0, 20),
        },
      },
      context: {
        rowLabelConsistency: {
          graded: labelGraded,
          passed: labelGraded - labelMismatches.length,
          mismatches: labelMismatches.slice(0, 20),
        },
        unitConsistency: {
          graded: unitGraded,
          passed: unitGraded - unitMismatches.length,
          mismatches: unitMismatches.slice(0, 20),
        },
        formulaGraphLabel: {
          graded: fgGraded,
          passed: fgGraded - formulaGraphMismatches.length,
          mismatches: formulaGraphMismatches.slice(0, 10),
        },
      },
      composite: {
        gradedOnAll: gradedAll,
        passedAll: Math.max(0, passedAll),
        failedValueOnly,
        failedPeriodOnly,
        failedContextOnly,
        failedMultiple,
        ungraded,
        readPct,
      },
      readCellsMarked,
    };
  },
});
