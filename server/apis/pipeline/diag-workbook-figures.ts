/**
 * diag-workbook-figures.ts — Diagnostic API for Phase 4.5
 *
 * Runs the workbook-figures adapter and diffs against existing reference_figures.
 * Validates that the adapter is a strict superset of the old LLM extractor.
 *
 * Diff methodology:
 *   - Match on sheet + row_label + normalizedPeriod (or cell_ref when available)
 *   - Compare value_raw (unscaled) — not post-scaling values
 *   - Three buckets: present+matching, present+differing, absent
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { loadWorkbookFigures } from "./workbook-figures-adapter.js";
import { normalizePeriod } from "./claims-reconciliation.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagWorkbookFigures",
  description: "Runs workbook-figures adapter and diffs against old extractor output",
  integrations: {
    ic_db: postgres(IC_DB),
  },
  input: z.object({
    dealId: z.string(),
    role: z.string().nullable().optional(),
  }),
  output: z.object({
    adapter: z.object({
      totalFigures: z.number(),
      stubCount: z.number(),
      byUnitClass: z.record(z.number()),
      topSheets: z.array(z.object({ sheet: z.string(), count: z.number() })),
    }),
    oldExtractor: z.object({
      totalFigures: z.number(),
    }),
    diff: z.object({
      presentMatching: z.number(),
      presentDiffering: z.number(),
      absent: z.number(),
      differingSamples: z.array(z.object({
        rowLabel: z.string(),
        period: z.string(),
        oldValue: z.number(),
        mapValueRaw: z.number(),
        oldBasis: z.string().nullable(),
      })),
      absentSamples: z.array(z.object({
        rowLabel: z.string(),
        period: z.string(),
        oldValue: z.number(),
        oldBasis: z.string().nullable(),
        metric: z.string(),
      })),
    }),
  }),

  async run(ctx, { dealId, role }) {
    const q = ctx.integrations.ic_db;

    const queryFn = async (sql: string, schema: z.ZodTypeAny, params: unknown[], meta?: { label: string }) => {
      return q.query(sql, schema, params, meta ? { label: meta.label } : undefined);
    };

    // --- 1. Run adapter ---
    const adapterResult = await loadWorkbookFigures(queryFn, dealId, role);

    // --- 2. Build map index: sheet + rowLabel + normalizedPeriod → value_raw[] ---
    // Also index by cell_ref for direct coordinate matches
    const mapByLabel = new Map<string, number[]>();
    const mapByCellRef = new Map<string, number[]>();

    for (const fig of adapterResult.figures) {
      const normPeriod = normalizePeriod(fig.period);
      const labelKey = fig.source_sheet + "|" + fig.source_cell + "|" + normPeriod;
      const arr = mapByLabel.get(labelKey) ?? [];
      arr.push(fig.value_raw ?? fig.value);
      mapByLabel.set(labelKey, arr);

      if (fig.cell_ref) {
        const refKey = fig.source_sheet + "|" + fig.cell_ref;
        const refArr = mapByCellRef.get(refKey) ?? [];
        refArr.push(fig.value_raw ?? fig.value);
        mapByCellRef.set(refKey, refArr);
      }
    }

    // --- 3. Load old extractor figures ---
    const OldFigRow = z.object({
      row_label: z.string().nullable(),
      metric: z.string(),
      scope_qualifier: z.string(),
      period: z.string(),
      value: z.string(),
      basis: z.string().nullable(),
      cell_ref: z.string().nullable(),
      value_raw: z.string().nullable(),
    });

    const oldRows = await q.query(
      "SELECT row_label, metric, scope_qualifier, period, value::text, basis, cell_ref, value_raw::text FROM reference_figures WHERE deal_id = $1",
      OldFigRow,
      [dealId],
      { label: "Load old reference_figures for diff" },
    );

    // --- 4. Diff ---
    // For each old figure, try to find it in the map
    // The old extractor stores pre-scaled values (value = raw * multiplier)
    // We compare against the map's value_raw (unscaled)
    // Need to reverse the old scaling to get the unscaled value for comparison
    let presentMatching = 0;
    let presentDiffering = 0;
    let absent = 0;
    const differingSamples: Array<{
      rowLabel: string; period: string; oldValue: number;
      mapValueRaw: number; oldBasis: string | null;
    }> = [];
    const absentSamples: Array<{
      rowLabel: string; period: string; oldValue: number;
      oldBasis: string | null; metric: string;
    }> = [];

    for (const oldRow of oldRows) {
      const oldVal = parseFloat(oldRow.value);
      const oldRawVal = oldRow.value_raw ? parseFloat(oldRow.value_raw) : null;
      if (isNaN(oldVal)) continue;

      // Reverse the old scaling to get the unscaled value
      let oldUnscaled: number;
      if (oldRawVal !== null && !isNaN(oldRawVal)) {
        oldUnscaled = oldRawVal;
      } else {
        // Guess the old scale from basis
        let oldScale = 1;
        if (oldRow.basis === "millions") oldScale = 1_000_000;
        else if (oldRow.basis === "thousands") oldScale = 1_000;
        else if (oldRow.basis === "billions") oldScale = 1_000_000_000;
        oldUnscaled = oldScale > 1 ? oldVal / oldScale : oldVal;
      }

      // Try cell_ref match first (most precise)
      let mapValues: number[] | undefined;
      if (oldRow.cell_ref) {
        // Old cell_refs use "LLM_Excel_Extract" as sheet — need the real sheet
        // Fall through to label matching
      }

      // Label + period match
      if (!mapValues) {
        // Normalize old period — old extractor uses "2023A", "2026E" format
        // which normalizePeriod doesn't handle (it wants "FY2023" or "2023 actual")
        // Pre-convert bare year+suffix to FY format before normalizing
        let oldPeriod = oldRow.period;
        const bareYearSuffix = oldPeriod.match(/^(\d{4})(A|E|F|B)$/i);
        if (bareYearSuffix) {
          const suffixMap: Record<string, string> = { A: "", E: "F", F: "F", B: "B" };
          const s = suffixMap[bareYearSuffix[2].toUpperCase()] ?? "";
          oldPeriod = "FY" + bareYearSuffix[1] + s;
        }
        const normPeriod = normalizePeriod(oldPeriod);
        const label = oldRow.row_label ?? oldRow.scope_qualifier;

        // Try exact label match across all sheets
        for (const [key, vals] of mapByLabel) {
          const parts = key.split("|");
          const mapLabel = parts[1];
          const mapPeriod = parts[2];
          if (mapPeriod === normPeriod && mapLabel === label) {
            mapValues = vals;
            break;
          }
        }

        // Try fuzzy label match (case-insensitive, trim)
        if (!mapValues) {
          const labelLower = label.toLowerCase().trim();
          for (const [key, vals] of mapByLabel) {
            const parts = key.split("|");
            const mapLabel = parts[1].toLowerCase().trim();
            const mapPeriod = parts[2];
            if (mapPeriod === normPeriod && mapLabel === labelLower) {
              mapValues = vals;
              break;
            }
          }
        }
      }

      if (mapValues && mapValues.length > 0) {
        // Check if any map value matches (within 1% tolerance)
        const hasMatch = mapValues.some(mv => {
          if (oldUnscaled === 0 && mv === 0) return true;
          if (oldUnscaled === 0 || mv === 0) return Math.abs(oldUnscaled - mv) < 0.01;
          return Math.abs(mv - oldUnscaled) / Math.abs(oldUnscaled) < 0.01;
        });
        if (hasMatch) {
          presentMatching++;
        } else {
          presentDiffering++;
          if (differingSamples.length < 10) {
            differingSamples.push({
              rowLabel: oldRow.row_label ?? oldRow.scope_qualifier,
              period: oldRow.period,
              oldValue: oldUnscaled,
              mapValueRaw: mapValues[0],
              oldBasis: oldRow.basis,
            });
          }
        }
      } else {
        absent++;
        if (absentSamples.length < 10) {
          absentSamples.push({
            rowLabel: oldRow.row_label ?? oldRow.scope_qualifier,
            period: oldRow.period,
            oldValue: oldUnscaled,
            oldBasis: oldRow.basis,
            metric: oldRow.metric,
          });
        }
      }
    }

    // Top sheets by figure count
    const topSheets = Object.entries(adapterResult.stats.bySheet)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sheet, count]) => ({ sheet, count }));

    return {
      adapter: {
        totalFigures: adapterResult.figures.length,
        stubCount: adapterResult.stats.stubCount,
        byUnitClass: adapterResult.stats.byUnitClass,
        topSheets,
      },
      oldExtractor: {
        totalFigures: oldRows.length,
      },
      diff: {
        presentMatching,
        presentDiffering,
        absent,
        differingSamples,
        absentSamples,
      },
    };
  },
});
