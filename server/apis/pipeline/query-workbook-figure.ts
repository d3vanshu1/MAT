/**
 * query-workbook-figure.ts — Phase 5.1 API
 *
 * Exposes findFigure as an API for testing and for CC integration.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { findFigure, routeRole } from "../../lib/findFigure.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "QueryWorkbookFigure",
  description: "Finds a workbook cell matching a claim's metric text, period, and constraints",
  integrations: {
    ic_db: postgres(IC_DB),
  },
  input: z.object({
    dealId: z.string(),
    metricText: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    periodType: z.string().default("FY"),
    caseKey: z.string().nullable().optional(),
    unitClass: z.string().nullable().optional(),
    workbookRole: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
  }),
  output: z.object({
    status: z.enum(["resolved", "declined"]),
    routedRole: z.string().nullable(),
    declineReason: z.string().nullable(),
    candidatesConsidered: z.number(),
    filtersApplied: z.array(z.string()),
    candidate: z.object({
      cellRef: z.string(),
      sheet: z.string(),
      workbookRole: z.string(),
      rowLabel: z.string(),
      rowLabelPath: z.string(),
      valueRaw: z.number(),
      scaledValue: z.number(),
      scaleMultiplier: z.number(),
      unitClass: z.string().nullable(),
      currency: z.string().nullable(),
      periodLabel: z.string(),
      caseLabel: z.string().nullable(),
      isAggregate: z.boolean(),
      score: z.number(),
    }).nullable(),
    topCandidates: z.array(z.object({
      cellRef: z.string(),
      sheet: z.string(),
      workbookRole: z.string(),
      rowLabel: z.string(),
      score: z.number(),
      scaledValue: z.number(),
      unitClass: z.string().nullable(),
    })),
  }),

  async run(ctx, input) {
    const q = ctx.integrations.ic_db;
    const queryFn = async (sql: string, schema: z.ZodTypeAny, params: unknown[], meta?: { label: string }) => {
      return q.query(sql, schema, params, meta ? { label: meta.label } : undefined);
    };

    const routedRole = input.workbookRole || routeRole(input.metricText);

    const result = await findFigure(queryFn, {
      dealId: input.dealId,
      metricText: input.metricText,
      period: {
        type: input.periodType,
        start: input.periodStart,
        end: input.periodEnd,
      },
      caseKey: input.caseKey ?? null,
      unitClass: input.unitClass ?? null,
      workbookRole: input.workbookRole ?? null,
      scope: input.scope ?? null,
    });

    return {
      status: result.status,
      routedRole,
      declineReason: result.declineReason,
      candidatesConsidered: result.candidatesConsidered,
      filtersApplied: result.filtersApplied,
      candidate: result.candidate ? {
        cellRef: result.candidate.cellRef,
        sheet: result.candidate.sheet,
        workbookRole: result.candidate.workbookRole,
        rowLabel: result.candidate.rowLabel,
        rowLabelPath: result.candidate.rowLabelPath,
        valueRaw: result.candidate.valueRaw,
        scaledValue: result.candidate.scaledValue,
        scaleMultiplier: result.candidate.scaleMultiplier,
        unitClass: result.candidate.unitClass,
        currency: result.candidate.currency,
        periodLabel: result.candidate.periodLabel,
        caseLabel: result.candidate.caseLabel,
        isAggregate: result.candidate.isAggregate,
        score: result.candidate.score,
      } : null,
      topCandidates: result.topCandidates.map((c) => ({
        cellRef: c.cellRef,
        sheet: c.sheet,
        workbookRole: c.workbookRole,
        rowLabel: c.rowLabel,
        score: c.score,
        scaledValue: c.scaledValue,
        unitClass: c.unitClass,
      })),
    };
  },
});
