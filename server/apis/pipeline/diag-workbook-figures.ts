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
      // Re-match absent by value: how many absent figures have a cell
      // on the same period with matching value_raw (label differs)
      absentValueMatched: z.number(),
      absentTrulyMissing: z.number(),
      absentValueMatchedSamples: z.array(z.object({
        oldLabel: z.string(),
        mapLabel: z.string(),
        period: z.string(),
        valueRaw: z.number(),
        sheet: z.string(),
        cellRef: z.string().nullable(),
      })),
      absentTrulyMissingSamples: z.array(z.object({
        rowLabel: z.string(),
        period: z.string(),
        oldValue: z.number(),
        metric: z.string(),
      })),
      absentTrulyMissingByMetric: z.record(z.number()),
      // Units re-check: try value × {100, 0.01, 1e3, 1e6} for truly missing
      unitsRecheck: z.object({
        resolvedAt100: z.number(),
        resolvedAt001: z.number(),
        resolvedAt1e3: z.number(),
        resolvedAt1e6: z.number(),
        residualMissing: z.number(),
        residualByMetric: z.record(z.number()),
        resolvedSamples: z.array(z.object({
          oldLabel: z.string(),
          mapLabel: z.string(),
          period: z.string(),
          factor: z.string(),
          oldVal: z.number(),
          mapVal: z.number(),
        })),
      }),
      // Ratio distribution for differing values
      differingRatios: z.object({
        at1000x: z.number(),
        at1000000x: z.number(),
        atOther: z.number(),
        ratioSamples: z.array(z.object({
          rowLabel: z.string(),
          period: z.string(),
          ratio: z.number(),
          mapVal: z.number(),
          oldVal: z.number(),
        })),
      }),
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
    // Value-based index: normalizedPeriod → [{valueRaw, label, sheet, cellRef}]
    const mapByPeriodValue = new Map<string, Array<{valueRaw: number; label: string; sheet: string; cellRef: string | null}>>();

    for (const fig of adapterResult.figures) {
      const normPeriod = normalizePeriod(fig.period);
      const vr = fig.value_raw ?? fig.value;

      const labelKey = fig.source_sheet + "|" + fig.source_cell + "|" + normPeriod;
      const arr = mapByLabel.get(labelKey) ?? [];
      arr.push(vr);
      mapByLabel.set(labelKey, arr);

      if (fig.cell_ref) {
        const refKey = fig.source_sheet + "|" + fig.cell_ref;
        const refArr = mapByCellRef.get(refKey) ?? [];
        refArr.push(vr);
        mapByCellRef.set(refKey, refArr);
      }

      // Value index for absent re-matching
      const pvArr = mapByPeriodValue.get(normPeriod) ?? [];
      pvArr.push({ valueRaw: vr, label: fig.source_cell, sheet: fig.source_sheet, cellRef: fig.cell_ref ?? null });
      mapByPeriodValue.set(normPeriod, pvArr);
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
    const allDiffering: Array<{
      rowLabel: string; period: string; oldValue: number;
      mapValueRaw: number; oldBasis: string | null;
    }> = [];
    const allAbsent: Array<{
      rowLabel: string; period: string; normPeriod: string; oldValue: number;
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

      // Normalize old period upfront (needed for both label match and absent re-match)
      let oldPeriod = oldRow.period;
      const bareYearSuffix = oldPeriod.match(/^(\d{4})(A|E|F|B)$/i);
      if (bareYearSuffix) {
        const suffixMap: Record<string, string> = { A: "", E: "F", F: "F", B: "B" };
        const s = suffixMap[bareYearSuffix[2].toUpperCase()] ?? "";
        oldPeriod = "FY" + bareYearSuffix[1] + s;
      }
      const normPeriod = normalizePeriod(oldPeriod);
      const label = oldRow.row_label ?? oldRow.scope_qualifier;

      // Try cell_ref match first (most precise)
      let mapValues: number[] | undefined;
      if (oldRow.cell_ref) {
        // Old cell_refs use "LLM_Excel_Extract" as sheet — need the real sheet
        // Fall through to label matching
      }

      // Label + period match
      if (!mapValues) {

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
          // Track all differing for ratio analysis
          allDiffering.push({
            rowLabel: oldRow.row_label ?? oldRow.scope_qualifier,
            period: oldRow.period,
            oldValue: oldUnscaled,
            mapValueRaw: mapValues[0],
            oldBasis: oldRow.basis,
          });
        }
      } else {
        absent++;
        // Track all absent for value re-matching
        allAbsent.push({
          rowLabel: oldRow.row_label ?? oldRow.scope_qualifier,
          period: oldRow.period,
          normPeriod,
          oldValue: oldUnscaled,
          oldBasis: oldRow.basis,
          metric: oldRow.metric,
        });
      }
    }

    // --- 5. Re-match absent by value ---
    let absentValueMatched = 0;
    let absentTrulyMissing = 0;
    const trulyMissingByMetric: Record<string, number> = {};
    const absentValueMatchedSamples: Array<{
      oldLabel: string; mapLabel: string; period: string;
      valueRaw: number; sheet: string; cellRef: string | null;
    }> = [];
    const absentTrulyMissingSamples: Array<{
      rowLabel: string; period: string; oldValue: number; metric: string;
    }> = [];

    for (const ab of allAbsent) {
      const candidates = mapByPeriodValue.get(ab.normPeriod);
      if (!candidates) {
        absentTrulyMissing++;
        trulyMissingByMetric[ab.metric] = (trulyMissingByMetric[ab.metric] ?? 0) + 1;
        if (absentTrulyMissingSamples.length < 10) {
          absentTrulyMissingSamples.push({
            rowLabel: ab.rowLabel, period: ab.period,
            oldValue: ab.oldValue, metric: ab.metric,
          });
        }
        continue;
      }

      // Find a cell with matching value_raw
      // Use 2-significant-figure match OR 5% tolerance (whichever is more permissive)
      // to account for LLM rounding (4.949 → 4.9, 0.155 → 0.2)
      const match = candidates.find(c => {
        if (ab.oldValue === 0 && c.valueRaw === 0) return true;
        if (ab.oldValue === 0 || c.valueRaw === 0) return Math.abs(ab.oldValue - c.valueRaw) < 0.01;
        // 5% relative tolerance
        const relTol = Math.abs(c.valueRaw - ab.oldValue) / Math.abs(ab.oldValue) < 0.05;
        // 2-significant-figure match
        const sigFig = (v: number) => {
          if (v === 0) return "0";
          const mag = Math.floor(Math.log10(Math.abs(v)));
          return (Math.round(v / Math.pow(10, mag - 1)) * Math.pow(10, mag - 1)).toPrecision(2);
        };
        const sfMatch = sigFig(c.valueRaw) === sigFig(ab.oldValue);
        return relTol || sfMatch;
      });

      if (match) {
        absentValueMatched++;
        if (absentValueMatchedSamples.length < 10) {
          absentValueMatchedSamples.push({
            oldLabel: ab.rowLabel, mapLabel: match.label,
            period: ab.period, valueRaw: match.valueRaw,
            sheet: match.sheet, cellRef: match.cellRef,
          });
        }
      } else {
        absentTrulyMissing++;
        trulyMissingByMetric[ab.metric] = (trulyMissingByMetric[ab.metric] ?? 0) + 1;
        if (absentTrulyMissingSamples.length < 10) {
          absentTrulyMissingSamples.push({
            rowLabel: ab.rowLabel, period: ab.period,
            oldValue: ab.oldValue, metric: ab.metric,
          });
        }
      }
    }

    // --- 5b. Units re-check: try value × factors for truly missing ---
    const factors = [
      { factor: 100, label: "x100" },       // percent: 0.231 → 23.1
      { factor: 0.01, label: "x0.01" },     // inverse percent
      { factor: 1e3, label: "x1e3" },       // thousands
      { factor: 1e6, label: "x1e6" },       // millions
    ];
    let resolvedAt100 = 0, resolvedAt001 = 0, resolvedAt1e3 = 0, resolvedAt1e6 = 0;
    let residualMissing = 0;
    const residualByMetric: Record<string, number> = {};
    const resolvedSamples: Array<{
      oldLabel: string; mapLabel: string; period: string;
      factor: string; oldVal: number; mapVal: number;
    }> = [];

    // trulyMissingItems already identified during first pass — they're the ones
    // that incremented absentTrulyMissing. Collect them by re-checking.
    // (We need the normPeriod for the factor search)
    const trulyMissingItems: typeof allAbsent = [];
    for (const ab of allAbsent) {
      const candidates = mapByPeriodValue.get(ab.normPeriod);
      if (!candidates) { trulyMissingItems.push(ab); continue; }
      const matched = candidates.some(c => {
        if (ab.oldValue === 0 && c.valueRaw === 0) return true;
        if (ab.oldValue === 0 || c.valueRaw === 0) return Math.abs(ab.oldValue - c.valueRaw) < 0.01;
        return Math.abs(c.valueRaw - ab.oldValue) / Math.abs(ab.oldValue) < 0.05;
      });
      if (!matched) trulyMissingItems.push(ab);
    }

    for (const tm of trulyMissingItems) {
      if (tm.oldValue === 0) {
        residualMissing++;
        residualByMetric[tm.metric] = (residualByMetric[tm.metric] ?? 0) + 1;
        continue;
      }
      const candidates = mapByPeriodValue.get(tm.normPeriod);
      if (!candidates) {
        residualMissing++;
        residualByMetric[tm.metric] = (residualByMetric[tm.metric] ?? 0) + 1;
        continue;
      }

      let resolved = false;
      for (const { factor, label: fLabel } of factors) {
        const scaledOldVal = tm.oldValue * factor;
        const match = candidates.find(c => {
          if (c.valueRaw === 0) return false;
          return Math.abs(c.valueRaw - scaledOldVal) / Math.abs(scaledOldVal) < 0.05;
        });
        if (match) {
          resolved = true;
          if (factor === 100) resolvedAt100++;
          else if (factor === 0.01) resolvedAt001++;
          else if (factor === 1e3) resolvedAt1e3++;
          else if (factor === 1e6) resolvedAt1e6++;
          if (resolvedSamples.length < 10) {
            resolvedSamples.push({
              oldLabel: tm.rowLabel, mapLabel: match.label,
              period: tm.period, factor: fLabel,
              oldVal: tm.oldValue, mapVal: match.valueRaw,
            });
          }
          break;
        }
      }
      if (!resolved) {
        residualMissing++;
        residualByMetric[tm.metric] = (residualByMetric[tm.metric] ?? 0) + 1;
      }
    }

    // --- 6. Ratio distribution for differing values ---
    let at1000x = 0;
    let at1000000x = 0;
    let atOther = 0;
    const ratioSamples: Array<{
      rowLabel: string; period: string; ratio: number; mapVal: number; oldVal: number;
    }> = [];

    for (const d of allDiffering) {
      if (d.oldValue === 0 || d.mapValueRaw === 0) {
        atOther++;
        continue;
      }
      const ratio = d.mapValueRaw / d.oldValue;
      const absRatio = Math.abs(ratio);

      if (absRatio > 900 && absRatio < 1100) at1000x++;
      else if (absRatio > 900_000 && absRatio < 1_100_000) at1000000x++;
      else if (absRatio > 0.0009 && absRatio < 0.0011) at1000x++; // inverse 1000x
      else if (absRatio > 0.0000009 && absRatio < 0.0000011) at1000000x++; // inverse 1M
      else atOther++;

      if (ratioSamples.length < 15) {
        ratioSamples.push({
          rowLabel: d.rowLabel, period: d.period,
          ratio: Math.round(ratio * 1000) / 1000,
          mapVal: d.mapValueRaw, oldVal: d.oldValue,
        });
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
        differingSamples: allDiffering.slice(0, 10),
        absentSamples: allAbsent.slice(0, 10).map(a => ({
          rowLabel: a.rowLabel, period: a.period,
          oldValue: a.oldValue, oldBasis: a.oldBasis, metric: a.metric,
        })),
        absentValueMatched,
        absentTrulyMissing,
        absentValueMatchedSamples,
        absentTrulyMissingSamples,
        absentTrulyMissingByMetric: trulyMissingByMetric,
        unitsRecheck: {
          resolvedAt100,
          resolvedAt001,
          resolvedAt1e3,
          resolvedAt1e6,
          residualMissing,
          residualByMetric,
          resolvedSamples,
        },
        differingRatios: {
          at1000x,
          at1000000x,
          atOther,
          ratioSamples,
        },
      },
    };
  },
});
