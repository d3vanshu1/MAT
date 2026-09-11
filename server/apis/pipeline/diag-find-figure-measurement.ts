/**
 * diag-find-figure-measurement.ts — Phase 5.4
 *
 * Runs all extracted memo claims through findFigure and reports resolve rate.
 * The measurement that replaces the old-extractor diff.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { findFigure, routeRole, type FindFigureResult } from "../../lib/findFigure.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Period parser: "2026E" → { type, start, end }
// ---------------------------------------------------------------------------

function parseClaimPeriod(raw: string): { type: string; start: string; end: string } | null {
  if (!raw || raw === "NONE_STATED" || raw === "UNDATED" || /^(current|ongoing|historical|next \d+ years?|multiple years?)$/i.test(raw.trim())) return null;

  const s = raw.trim();

  // FY/CY year: "2026E", "2026A", "FY2026", "FY 2026", "CY 2025A", "FY2026E", "FY26", "FY25"
  let m = s.match(/^(?:(?:FY|CY)\s*)?(\d{4})[AEFafe]?$/);
  if (m) {
    const y = parseInt(m[1]);
    return { type: "FY", start: y + "-01-01", end: y + "-12-31" };
  }
  m = s.match(/^(?:FY|CY)\s*(\d{2})[AEFafe]?$/);
  if (m) {
    const y = 2000 + parseInt(m[1]);
    return { type: "FY", start: y + "-01-01", end: y + "-12-31" };
  }

  // Range: "FY23-26", "2023-2026", "2026E-2031E"
  m = s.match(/^(?:(?:FY|CY)\s*)?(\d{2,4})[AEFafe]?\s*[-–]\s*(?:(?:FY|CY)\s*)?(\d{2,4})[AEFafe]?$/);
  if (m) {
    const y1 = parseInt(m[1]) < 100 ? 2000 + parseInt(m[1]) : parseInt(m[1]);
    const y2 = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
    return { type: "FY", start: y1 + "-01-01", end: y2 + "-12-31" };
  }

  // LTM: "LTM Sep-26", "LTM September 2026"
  m = s.match(/^LTM\s+(\w+)[-\s](\d{2,4})/i);
  if (m) {
    const monthNames: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
      january: 1, february: 2, march: 3, april: 4, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    };
    const mon = monthNames[m[1].toLowerCase()];
    if (mon) {
      const yr = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
      const endDate = new Date(yr, mon, 0); // last day of month
      const startDate = new Date(yr - 1, mon, 1); // 12 months prior
      return {
        type: "LTM",
        start: startDate.toISOString().slice(0, 10),
        end: endDate.toISOString().slice(0, 10),
      };
    }
  }

  // Monthly: "Jan-26", "Oct-24", "Mar-25"
  m = s.match(/^(\w{3,})[-\s](\d{2,4})$/);
  if (m) {
    const monthNames: Record<string, number> = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const mon = monthNames[m[1].toLowerCase().slice(0, 3)];
    if (mon) {
      const yr = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
      const startDate = new Date(yr, mon - 1, 1);
      const endDate = new Date(yr, mon, 0);
      return {
        type: "M",
        start: startDate.toISOString().slice(0, 10),
        end: endDate.toISOString().slice(0, 10),
      };
    }
  }

  // Quarter: "Q1 2026", "Q4-25"
  m = s.match(/^Q([1-4])[\s-](\d{2,4})$/i);
  if (m) {
    const q = parseInt(m[1]);
    const yr = parseInt(m[2]) < 100 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
    const startMonth = (q - 1) * 3;
    const endMonth = q * 3;
    const startDate = new Date(yr, startMonth, 1);
    const endDate = new Date(yr, endMonth, 0);
    return {
      type: "Q",
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10),
    };
  }

  return null;
}

// Map claim unit to findFigure unit_class
function claimUnitToUnitClass(unit: string): string | null {
  switch (unit) {
    case "£m": case "£k": case "£": return "currency";
    case "%": case "bps": return "percent";
    case "x": return "multiple";
    default: return null;
  }
}

export default api({
  name: "DiagFindFigureMeasurement",
  description: "Runs all extracted memo claims through findFigure and reports resolve rate",
  integrations: {
    ic_db: postgres(IC_DB),
  },
  input: z.object({
    dealId: z.string(),
    maxClaims: z.number().nullable().optional(),
    categoryFilter: z.string().nullable().optional(),
  }),
  output: z.object({
    totalClaims: z.number(),
    parsedPeriod: z.number(),
    unparsedPeriod: z.number(),
    resolved: z.number(),
    declinedAmbiguous: z.number(),
    declinedNoCandidates: z.number(),
    declinedOther: z.number(),
    resolveRate: z.string(),
    byDeclineReason: z.record(z.number()),
    byCategory: z.record(z.object({
      total: z.number(),
      resolved: z.number(),
      declined: z.number(),
    })),
    resolvedSample: z.array(z.object({
      claimMetric: z.string(),
      claimScope: z.string(),
      claimPeriod: z.string(),
      claimValue: z.number(),
      claimUnit: z.string(),
      cellRef: z.string(),
      sheet: z.string(),
      rowLabel: z.string(),
      scaledValue: z.number(),
      score: z.number(),
      role: z.string(),
    })),
    declinedSample: z.array(z.object({
      claimMetric: z.string(),
      claimScope: z.string(),
      claimPeriod: z.string(),
      claimValue: z.number(),
      reason: z.string(),
      topCandidateLabel: z.string().nullable(),
      topCandidateScore: z.number().nullable(),
    })),
  }),

  async run(ctx, { dealId, maxClaims, categoryFilter }) {
    const q = ctx.integrations.ic_db;
    const queryFn = async (sql: string, schema: z.ZodTypeAny, params: unknown[], meta?: { label: string }) => {
      return q.query(sql, schema, params, meta ? { label: meta.label } : undefined);
    };

    // Load claims from ledger
    const LedgerRow = z.object({ ledger: z.any() });
    const [ledgerRow] = await q.query(
      "SELECT ledger FROM diag_claims_ledger WHERE deal_id = $1",
      LedgerRow,
      [dealId],
      { label: "Load claims ledger" },
    );
    if (!ledgerRow) throw new Error("No claims ledger for deal " + dealId);

    let claims: any[] = ledgerRow.ledger?.claims ?? [];
    if (categoryFilter) {
      claims = claims.filter((c: any) => c.claim_category === categoryFilter);
    }
    if (maxClaims) claims = claims.slice(0, maxClaims);

    let parsedPeriod = 0;
    let unparsedPeriod = 0;
    let resolved = 0;
    let declinedAmbiguous = 0;
    let declinedNoCandidates = 0;
    let declinedOther = 0;
    const byDeclineReason: Record<string, number> = {};
    const byCategory: Record<string, { total: number; resolved: number; declined: number }> = {};
    const resolvedSample: any[] = [];
    const declinedSample: any[] = [];

    for (const claim of claims) {
      const cat = claim.claim_category ?? "unknown";
      if (!byCategory[cat]) byCategory[cat] = { total: 0, resolved: 0, declined: 0 };
      byCategory[cat].total++;

      const period = parseClaimPeriod(claim.period);
      if (!period) {
        unparsedPeriod++;
        byCategory[cat].declined++;
        continue;
      }
      parsedPeriod++;

      const unitClass = claimUnitToUnitClass(claim.unit);
      const searchText = claim.scope_qualifier && claim.scope_qualifier !== "NONE_STATED"
        ? claim.scope_qualifier
        : claim.basis_note || claim.metric;

      let result: FindFigureResult;
      try {
        result = await findFigure(queryFn, {
          dealId,
          metricText: searchText,
          period,
          unitClass,
          workbookRole: null,
        });
      } catch (e) {
        declinedOther++;
        byCategory[cat].declined++;
        continue;
      }

      if (result.status === "resolved" && result.candidate) {
        resolved++;
        byCategory[cat].resolved++;
        if (resolvedSample.length < 20) {
          resolvedSample.push({
            claimMetric: claim.metric,
            claimScope: claim.scope_qualifier,
            claimPeriod: claim.period,
            claimValue: claim.value,
            claimUnit: claim.unit,
            cellRef: result.candidate.cellRef,
            sheet: result.candidate.sheet,
            rowLabel: result.candidate.rowLabel,
            scaledValue: result.candidate.scaledValue,
            score: result.candidate.score,
            role: result.candidate.workbookRole,
          });
        }
      } else {
        byCategory[cat].declined++;
        const reason = result.declineReason ?? "unknown";
        byDeclineReason[reason] = (byDeclineReason[reason] ?? 0) + 1;

        if (reason === "no_candidates") declinedNoCandidates++;
        else if (reason === "tie" || reason === "case_ambiguity") declinedAmbiguous++;
        else declinedOther++;

        if (declinedSample.length < 10) {
          declinedSample.push({
            claimMetric: claim.metric,
            claimScope: claim.scope_qualifier,
            claimPeriod: claim.period,
            claimValue: claim.value,
            reason,
            topCandidateLabel: result.topCandidates[0]?.rowLabel ?? null,
            topCandidateScore: result.topCandidates[0]?.score ?? null,
          });
        }
      }
    }

    const totalWithPeriod = parsedPeriod;
    const resolveRate = totalWithPeriod > 0
      ? (resolved / totalWithPeriod * 100).toFixed(1) + "%"
      : "0%";

    return {
      totalClaims: claims.length,
      parsedPeriod,
      unparsedPeriod,
      resolved,
      declinedAmbiguous,
      declinedNoCandidates,
      declinedOther,
      resolveRate,
      byDeclineReason,
      byCategory,
      resolvedSample,
      declinedSample,
    };
  },
});
