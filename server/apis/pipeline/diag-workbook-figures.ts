/**
 * diag-workbook-figures.ts — Diagnostic API for Phase 4.5
 *
 * Runs the workbook-figures adapter and diffs against existing reference_figures.
 * Validates that the adapter is a strict superset of the old LLM extractor.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { loadWorkbookFigures } from "./workbook-figures-adapter.js";
import { normalizeFigures, normalizePeriod } from "./claims-reconciliation.js";

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
      normalizedFigures: z.number(),
      stubsExcluded: z.number(),
      byUnitClass: z.record(z.number()),
      topSheets: z.array(z.object({ sheet: z.string(), count: z.number() })),
      sampleFigures: z.array(z.object({
        name: z.string(),
        period: z.string(),
        value: z.number(),
        sheet: z.string(),
        cellRef: z.string().nullable(),
        unitTag: z.string().nullable(),
      })),
    }),
    oldExtractor: z.object({
      totalFigures: z.number(),
      normalizedFigures: z.number(),
    }),
    diff: z.object({
      adapterNormalized: z.number(),
      oldNormalized: z.number(),
      oldCoveredByAdapter: z.number(),
      oldMissedByAdapter: z.number(),
      coveragePct: z.number(),
      missedSamples: z.array(z.object({
        metric: z.string(),
        scope: z.string(),
        period: z.string(),
        value: z.number(),
        rowLabel: z.string().nullable(),
      })),
    }),
  }),

  async run(ctx, { dealId, role }) {
    const q = ctx.integrations.ic_db;

    // Wrap the query function to match the expected signature
    const queryFn = async (sql: string, schema: z.ZodTypeAny, params: unknown[], meta?: { label: string }) => {
      return q.query(sql, schema, params, meta ? { label: meta.label } : undefined);
    };

    // --- 1. Run adapter ---
    const adapterResult = await loadWorkbookFigures(queryFn, dealId, role);

    // Normalize adapter figures through LABEL_MAPPINGS
    const adapterNormalized = normalizeFigures(adapterResult.figures);

    // --- 2. Load old extractor figures ---
    const OldFigRow = z.object({
      row_label: z.string().nullable(),
      metric: z.string(),
      scope_qualifier: z.string(),
      period: z.string(),
      value: z.string(), // numeric as string from PG
      basis: z.string().nullable(),
    });

    const oldRows = await q.query(
      "SELECT row_label, metric, scope_qualifier, period, value::text, basis FROM reference_figures WHERE deal_id = $1",
      OldFigRow,
      [dealId],
      { label: "Load old reference_figures for diff" },
    );

    // Normalize old figures — they use prenorm format
    const oldAsFigures = oldRows.map((r: z.infer<typeof OldFigRow>) => ({
      name: "[prenorm:" + r.metric + ":" + (r.basis ?? "") + "]" + r.scope_qualifier,
      period: r.period,
      value: parseFloat(r.value),
      source_doc: "old_extractor",
      source_cell: r.row_label ?? "ref_fig",
      source_sheet: "LLM_Excel_Extract",
    }));

    const oldNormalized = normalizeFigures(oldAsFigures);

    // --- 3. Diff ---
    // Build a coordinate index from adapter: metric + scope + normalizedPeriod → values[]
    type CoordKey = string;
    const makeKey = (metric: string, scope: string, period: string): CoordKey =>
      metric + "|" + scope + "|" + normalizePeriod(period);

    const adapterIndex = new Map<CoordKey, number[]>();
    for (const nf of adapterNormalized) {
      const key = makeKey(nf.metric, nf.scope_qualifier, nf.raw.period);
      const arr = adapterIndex.get(key) ?? [];
      arr.push(nf.raw.value);
      adapterIndex.set(key, arr);
    }

    // Check each old figure against the adapter index
    let covered = 0;
    let missed = 0;
    const missedSamples: Array<{
      metric: string;
      scope: string;
      period: string;
      value: number;
      rowLabel: string | null;
    }> = [];

    for (const onf of oldNormalized) {
      const key = makeKey(onf.metric, onf.scope_qualifier, onf.raw.period);
      const adapterValues = adapterIndex.get(key);

      if (adapterValues) {
        // Check if adapter has a matching value (within 1% tolerance for rounding)
        const oldVal = onf.raw.value;
        const hasMatch = adapterValues.some(av => {
          if (oldVal === 0 && av === 0) return true;
          if (oldVal === 0 || av === 0) return false;
          return Math.abs(av - oldVal) / Math.abs(oldVal) < 0.01;
        });
        if (hasMatch) {
          covered++;
        } else {
          missed++;
          if (missedSamples.length < 10) {
            missedSamples.push({
              metric: onf.metric,
              scope: onf.scope_qualifier,
              period: onf.raw.period,
              value: oldVal,
              rowLabel: onf.raw.source_cell ?? null,
            });
          }
        }
      } else {
        missed++;
        if (missedSamples.length < 10) {
          missedSamples.push({
            metric: onf.metric,
            scope: onf.scope_qualifier,
            period: onf.raw.period,
            value: onf.raw.value,
            rowLabel: onf.raw.source_cell ?? null,
          });
        }
      }
    }

    // Top sheets by figure count
    const topSheets = Object.entries(adapterResult.stats.bySheet)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sheet, count]) => ({ sheet, count }));

    // Sample adapter figures (10 random)
    const sampleIndices = new Set<number>();
    const maxSamples = Math.min(10, adapterResult.figures.length);
    while (sampleIndices.size < maxSamples) {
      sampleIndices.add(Math.floor(Math.random() * adapterResult.figures.length));
    }
    const sampleFigures = [...sampleIndices].map(i => {
      const f = adapterResult.figures[i];
      return {
        name: f.name,
        period: f.period,
        value: f.value,
        sheet: f.source_sheet,
        cellRef: f.cell_ref ?? null,
        unitTag: f.unit_tag ?? null,
      };
    });

    const totalOldNorm = oldNormalized.length;
    const coveragePct = totalOldNorm > 0 ? Math.round((covered / totalOldNorm) * 10000) / 100 : 100;

    return {
      adapter: {
        totalFigures: adapterResult.figures.length,
        normalizedFigures: adapterNormalized.length,
        stubsExcluded: adapterResult.stats.stubsExcluded,
        byUnitClass: adapterResult.stats.byUnitClass,
        topSheets,
        sampleFigures,
      },
      oldExtractor: {
        totalFigures: oldRows.length,
        normalizedFigures: oldNormalized.length,
      },
      diff: {
        adapterNormalized: adapterNormalized.length,
        oldNormalized: totalOldNorm,
        oldCoveredByAdapter: covered,
        oldMissedByAdapter: missed,
        coveragePct,
        missedSamples,
      },
    };
  },
});
