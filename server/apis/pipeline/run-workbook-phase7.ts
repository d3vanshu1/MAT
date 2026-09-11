/**
 * run-workbook-phase7.ts — Precedent Graph
 *
 * Step 7.1: Parse formula strings → cell references → workbook_precedents table
 * Step 7.2: Mark hardcoded leaves (numeric cells with no formula, blue font corroboration)
 * Step 7.3-7.4: Walk chains to anchors, compute distance_to_anchor
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { parseFormulaRefs, expandFormulaRefs } from "../../lib/formulaRefParser.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CellRow = z.object({
  sheet_name: z.string(),
  cell_ref: z.string(),
  formula: z.string().nullable(),
  value_type: z.string().nullable(),
});

const CountRow = z.object({ cnt: z.string() });

const PrecRow = z.object({
  from_sheet: z.string(),
  from_cell_ref: z.string(),
  to_sheet: z.string(),
  to_cell_ref: z.string(),
});

// Anchor labels for returns / entry value detection
// TypeScript regexes (support \b) — used for classification AFTER SQL fetch
const ENTRY_VALUE_LABELS = /\b(purchase price|enterprise value|entry.*(?:tev|ev)|total sources|total uses|equity.*(?:value|check)|sponsor equity)\b/i;
const RETURNS_LABELS = /\b(irr|moic|money multiple|gross.*irr|net.*irr|levered.*irr|return.*multiple|cash.*on.*cash|pep returns|ldi multiple|exit multiple)\b/i;

// SQL ILIKE patterns — Postgres POSIX regex does NOT support \b word boundaries,
// so we use ILIKE for the initial broad fetch, then classify with TS regexes above.
const ANCHOR_ILIKE_SQL = `(
  row_label ILIKE '%purchase price%'
  OR row_label ILIKE '%enterprise value%'
  OR row_label ILIKE '%entry tev%'
  OR row_label ILIKE '%entry ev%'
  OR row_label ILIKE '%total sources%'
  OR row_label ILIKE '%total uses%'
  OR row_label ILIKE '%equity value%'
  OR row_label ILIKE '%equity check%'
  OR row_label ILIKE '%sponsor equity%'
  OR row_label ILIKE '%entry equity%'
  OR row_label ILIKE '%exit equity%'
  OR row_label ILIKE '%irr%'
  OR row_label ILIKE '%moic%'
  OR row_label ILIKE '%money multiple%'
  OR row_label ILIKE '%return%multiple%'
  OR row_label ILIKE '%cash%on%cash%'
  OR row_label ILIKE '%pep returns%'
  OR row_label ILIKE '%ldi multiple%'
  OR row_label ILIKE '%exit multiple%'
  OR row_label = 'TEV'
)`;

export default api({
  name: "RunWorkbookPhase7",
  description: "Builds the formula precedent graph, marks hardcoded inputs, and computes anchor distances",

  integrations: { ic_db: postgres(IC_DB) },

  input: z.object({
    workbookId: z.string(),
    skipAnchorWalk: z.boolean().optional(),
    skipPrecedentRebuild: z.boolean().optional(),
  }),

  output: z.object({
    precedentsInserted: z.number(),
    hardcodedInputs: z.number(),
    anchorsFound: z.number(),
    cellsWithDistance: z.number(),
    externalRefs: z.number(),
  }),

  async run(ctx, { workbookId, skipAnchorWalk, skipPrecedentRebuild }) {
    const q = ctx.integrations.ic_db;

    // -----------------------------------------------------------------------
    // Step 7.1 — Parse formulas → precedents
    // -----------------------------------------------------------------------

    let totalPrecedents = 0;
    let totalExternal = 0;
    let hardcodedInputs = 0;

    if (skipPrecedentRebuild) {
      // Reuse existing precedents — just count them
      const [precCount] = await q.query(
        "SELECT count(*) AS cnt FROM workbook_precedents WHERE workbook_id = $1",
        CountRow, [workbookId], { label: "Count existing precedents" },
      );
      totalPrecedents = parseInt(precCount?.cnt ?? "0");
      const [extCount] = await q.query(
        "SELECT count(*) AS cnt FROM workbook_precedents WHERE workbook_id = $1 AND ref_kind = 'external'",
        CountRow, [workbookId], { label: "Count external refs" },
      );
      totalExternal = parseInt(extCount?.cnt ?? "0");
      const [hcCount] = await q.query(
        "SELECT count(*) AS cnt FROM workbook_cells WHERE workbook_id = $1 AND is_hardcoded_input = true",
        CountRow, [workbookId], { label: "Count hardcoded inputs" },
      );
      hardcodedInputs = parseInt(hcCount?.cnt ?? "0");
    } else {

    // Clear existing precedents for this workbook
    await q.query(
      "DELETE FROM workbook_precedents WHERE workbook_id = $1",
      z.any(), [workbookId], { label: "Clear old precedents" },
    );

    // Fetch all cells with formulas (batched by sheet)
    const sheetNames = await q.query(
      "SELECT DISTINCT sheet_name FROM workbook_cells WHERE workbook_id = $1 AND formula IS NOT NULL ORDER BY sheet_name",
      z.object({ sheet_name: z.string() }), [workbookId], { label: "Sheets with formulas" },
    );

    for (const { sheet_name } of sheetNames) {
      const cells = await q.query(
        "SELECT sheet_name, cell_ref, formula, value_type FROM workbook_cells WHERE workbook_id = $1 AND sheet_name = $2 AND formula IS NOT NULL",
        CellRow, [workbookId, sheet_name], { label: "Formulas: " + sheet_name },
      );

      // Parse and expand all refs
      const batch: Array<{ fromSheet: string; fromCellRef: string; toSheet: string; toCellRef: string; kind: string; rangeSize: number | null }> = [];

      for (const cell of cells) {
        if (!cell.formula) continue;
        const rawRefs = parseFormulaRefs(cell.formula, cell.sheet_name);
        const expanded = expandFormulaRefs(rawRefs, cell.sheet_name);

        for (const ref of expanded) {
          if (ref.kind === "external") totalExternal++;
          batch.push({
            fromSheet: cell.sheet_name,
            fromCellRef: cell.cell_ref,
            toSheet: ref.toSheet,
            toCellRef: ref.toCellRef,
            kind: ref.kind,
            rangeSize: ref.rangeSize,
          });
        }
      }

      // Batch insert (500 at a time)
      const BATCH_SIZE = 500;
      for (let i = 0; i < batch.length; i += BATCH_SIZE) {
        const chunk = batch.slice(i, i + BATCH_SIZE);
        const values: string[] = [];
        const params: unknown[] = [workbookId];
        let paramIdx = 2;

        for (const r of chunk) {
          values.push("($1, $" + paramIdx + ", $" + (paramIdx + 1) + ", $" + (paramIdx + 2) + ", $" + (paramIdx + 3) + ", $" + (paramIdx + 4) + ", $" + (paramIdx + 5) + ")");
          params.push(r.fromSheet, r.fromCellRef, r.toSheet, r.toCellRef, r.kind, r.rangeSize);
          paramIdx += 6;
        }

        await q.query(
          "INSERT INTO workbook_precedents (workbook_id, from_sheet, from_cell_ref, to_sheet, to_cell_ref, ref_kind, range_size) VALUES " + values.join(", "),
          z.any(), params, { label: "Insert precedents batch" },
        );
        totalPrecedents += chunk.length;
      }
    }

    // -----------------------------------------------------------------------
    // Step 7.2 — Hardcoded leaf detection
    // -----------------------------------------------------------------------

    // A numeric cell with no formula is a hardcoded input
    // Blue font (rgb close to 0000FF or 0070C0) corroborates
    const [hcResult] = await q.query(
      `WITH result AS (
        UPDATE workbook_cells SET is_hardcoded_input = true
        WHERE workbook_id = $1
          AND value_type = 'number'
          AND (formula IS NULL OR formula = '')
          AND value_num IS NOT NULL
        RETURNING id
      ) SELECT count(*) AS cnt FROM result`,
      CountRow, [workbookId], { label: "Mark hardcoded inputs" },
    );
    hardcodedInputs = parseInt(hcResult?.cnt ?? "0");

    // Clear non-hardcoded
    await q.query(
      "UPDATE workbook_cells SET is_hardcoded_input = false WHERE workbook_id = $1 AND is_hardcoded_input IS NULL",
      z.any(), [workbookId], { label: "Clear non-hardcoded" },
    );

    } // end else (full precedent rebuild)

    if (skipAnchorWalk) {
      return {
        precedentsInserted: totalPrecedents,
        hardcodedInputs,
        anchorsFound: 0,
        cellsWithDistance: 0,
        externalRefs: totalExternal,
      };
    }

    // -----------------------------------------------------------------------
    // Step 7.3-7.4 — Find anchors and walk backwards
    // -----------------------------------------------------------------------

    // Reset distance columns
    await q.query(
      "UPDATE workbook_cells SET feeds_entry_value = NULL, feeds_returns = NULL, distance_to_anchor = NULL WHERE workbook_id = $1",
      z.any(), [workbookId], { label: "Reset anchor distances" },
    );

    // Find anchor cells by row_label matching (ILIKE for Postgres compatibility)
    const anchorCells = await q.query(
      `SELECT sheet_name, cell_ref, row_label
       FROM workbook_cells
       WHERE workbook_id = $1 AND row_label IS NOT NULL
         AND ${ANCHOR_ILIKE_SQL}`,
      z.object({ sheet_name: z.string(), cell_ref: z.string(), row_label: z.string() }),
      [workbookId],
      { label: "Find anchor cells" },
    );

    // Classify anchors
    const entryAnchors = new Set<string>();
    const returnsAnchors = new Set<string>();

    for (const a of anchorCells) {
      const key = a.sheet_name + "!" + a.cell_ref;
      if (ENTRY_VALUE_LABELS.test(a.row_label)) entryAnchors.add(key);
      if (RETURNS_LABELS.test(a.row_label)) returnsAnchors.add(key);
    }

    const totalAnchors = new Set([...entryAnchors, ...returnsAnchors]).size;

    if (totalAnchors === 0) {
      return {
        precedentsInserted: totalPrecedents,
        hardcodedInputs,
        anchorsFound: 0,
        cellsWithDistance: 0,
        externalRefs: totalExternal,
      };
    }

    // Mark anchor cells themselves (distance = 0)
    for (const anchor of [...entryAnchors, ...returnsAnchors]) {
      const [sheet, cellRef] = anchor.split("!");
      const feedsEntry = entryAnchors.has(anchor);
      const feedsReturns = returnsAnchors.has(anchor);
      await q.query(
        `UPDATE workbook_cells
         SET feeds_entry_value = $3, feeds_returns = $4, distance_to_anchor = 0
         WHERE workbook_id = $1 AND sheet_name = $5 AND cell_ref = $2`,
        z.any(),
        [workbookId, cellRef, feedsEntry, feedsReturns, sheet],
        { label: "Mark anchor: " + anchor },
      );
    }

    // BFS backwards through precedent graph
    // Load precedents per-sheet to stay under gRPC 4MB limit
    const precSheets = await q.query(
      "SELECT DISTINCT from_sheet AS sheet_name FROM workbook_precedents WHERE workbook_id = $1 AND ref_kind != 'external' ORDER BY from_sheet",
      z.object({ sheet_name: z.string() }), [workbookId], { label: "Precedent sheets" },
    );

    // Build forward adjacency: from_cell → [to_cells]
    // Edge semantics: from_cell's formula references to_cell
    //   → data flows FROM to_cell INTO from_cell
    //   → to_cell is a DEPENDENCY of from_cell
    // BFS from anchor follows fwdAdj to walk the dependency chain
    //   → anchor → what it depends on → what those depend on → ... → hardcoded inputs
    // Paginate within each sheet (gRPC 4MB limit — ~30K rows per page)
    const PAGE_SIZE = 25000;
    const fwdAdj = new Map<string, string[]>();
    for (const { sheet_name } of precSheets) {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const sheetPrecs = await q.query(
          "SELECT from_sheet, from_cell_ref, to_sheet, to_cell_ref FROM workbook_precedents WHERE workbook_id = $1 AND from_sheet = $2 AND ref_kind != 'external' ORDER BY id LIMIT $3 OFFSET $4",
          PrecRow, [workbookId, sheet_name, PAGE_SIZE, offset], { label: "Precs: " + sheet_name + " @" + offset },
        );
        for (const p of sheetPrecs) {
          const fromKey = p.from_sheet + "!" + p.from_cell_ref;
          const toKey = p.to_sheet + "!" + p.to_cell_ref;
          if (!fwdAdj.has(fromKey)) fwdAdj.set(fromKey, []);
          fwdAdj.get(fromKey)!.push(toKey);
        }
        hasMore = sheetPrecs.length === PAGE_SIZE;
        offset += PAGE_SIZE;
      }
    }

    // BFS from anchors through their dependencies
    const MAX_DEPTH = 20;
    const visited = new Map<string, { feedsEntry: boolean; feedsReturns: boolean; distance: number }>();

    // Initialize with anchors
    type BfsItem = { key: string; depth: number; feedsEntry: boolean; feedsReturns: boolean };
    const queue: BfsItem[] = [];

    for (const a of entryAnchors) {
      visited.set(a, { feedsEntry: true, feedsReturns: returnsAnchors.has(a), distance: 0 });
      queue.push({ key: a, depth: 0, feedsEntry: true, feedsReturns: returnsAnchors.has(a) });
    }
    for (const a of returnsAnchors) {
      if (!visited.has(a)) {
        visited.set(a, { feedsEntry: false, feedsReturns: true, distance: 0 });
        queue.push({ key: a, depth: 0, feedsEntry: false, feedsReturns: true });
      }
    }

    // BFS
    let head = 0;
    while (head < queue.length) {
      const item = queue[head++];
      if (item.depth >= MAX_DEPTH) continue;

      const deps = fwdAdj.get(item.key) ?? [];
      for (const depKey of deps) {
        const existing = visited.get(depKey);
        if (existing) {
          // Already visited — merge flags, keep shorter distance
          let changed = false;
          if (item.feedsEntry && !existing.feedsEntry) { existing.feedsEntry = true; changed = true; }
          if (item.feedsReturns && !existing.feedsReturns) { existing.feedsReturns = true; changed = true; }
          if (item.depth + 1 < existing.distance) { existing.distance = item.depth + 1; changed = true; }
          if (changed) {
            queue.push({ key: depKey, depth: item.depth + 1, feedsEntry: existing.feedsEntry, feedsReturns: existing.feedsReturns });
          }
        } else {
          visited.set(depKey, {
            feedsEntry: item.feedsEntry,
            feedsReturns: item.feedsReturns,
            distance: item.depth + 1,
          });
          queue.push({
            key: depKey,
            depth: item.depth + 1,
            feedsEntry: item.feedsEntry,
            feedsReturns: item.feedsReturns,
          });
        }
      }
    }

    // Batch update cells with distance info (skip anchors, already set)
    let cellsWithDistance = 0;
    const updates: Array<{ sheet: string; cellRef: string; feedsEntry: boolean; feedsReturns: boolean; distance: number }> = [];

    for (const [key, info] of visited) {
      if (info.distance === 0) continue; // anchors already set
      const [sheet, cellRef] = key.split("!");
      updates.push({ sheet, cellRef, feedsEntry: info.feedsEntry, feedsReturns: info.feedsReturns, distance: info.distance });
    }

    // Batch update in chunks of 200
    const UPDATE_BATCH = 200;
    for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
      const chunk = updates.slice(i, i + UPDATE_BATCH);
      const cases: string[] = [];
      const params: unknown[] = [workbookId];
      let pi = 2;

      for (const u of chunk) {
        cases.push("($" + pi + ", $" + (pi + 1) + ", $" + (pi + 2) + ", $" + (pi + 3) + ", $" + (pi + 4) + ")");
        params.push(u.sheet, u.cellRef, u.feedsEntry, u.feedsReturns, u.distance);
        pi += 5;
      }

      await q.query(
        `UPDATE workbook_cells c SET
           feeds_entry_value = v.feeds_entry::boolean,
           feeds_returns = v.feeds_returns::boolean,
           distance_to_anchor = v.distance::int
         FROM (VALUES ${cases.join(", ")}) AS v(sheet, cell_ref, feeds_entry, feeds_returns, distance)
         WHERE c.workbook_id = $1 AND c.sheet_name = v.sheet AND c.cell_ref = v.cell_ref`,
        z.any(), params, { label: "Update anchor distances" },
      );
      cellsWithDistance += chunk.length;
    }

    return {
      precedentsInserted: totalPrecedents,
      hardcodedInputs,
      anchorsFound: totalAnchors,
      cellsWithDistance,
      externalRefs: totalExternal,
    };
  },
});
