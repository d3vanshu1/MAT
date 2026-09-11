/**
 * findFigure.ts — Phase 5.1 + 5.2 + 5.3
 *
 * Query layer over workbook_cells. Given a claim's wording, period, and
 * optional constraints, returns ranked candidates with full provenance —
 * or a structured decline with reason and top candidates.
 *
 * No LLM in the matching path. Label similarity is token overlap +
 * normalised string distance.
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindFigureInput {
  metricText: string;           // the claim's wording, verbatim
  period: {
    type: string;               // "FY" | "Q" | "M" | "LTM" | etc.
    start: string;              // ISO date
    end: string;                // ISO date
  };
  caseKey?: string | null;      // optional case filter
  unitClass?: string | null;    // optional unit filter
  workbookRole?: string | null; // "buy_side" | "sell_side" — from 5.3 routing
  scope?: string | null;        // optional segment/member filter
  dealId: string;
}

export interface FigureCandidate {
  cellRef: string;
  sheet: string;
  workbookRole: string;
  rowLabelPath: string;
  rowLabel: string;
  valueRaw: number;
  scaleMultiplier: number;
  scaledValue: number;
  unitClass: string | null;
  currency: string | null;
  displayValue: string | null;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  periodType: string | null;
  caseLabel: string | null;
  caseKey: string | null;
  isAggregate: boolean;
  signConvention: string | null;
  score: number;
  scoreBreakdown: {
    tokenOverlap: number;
    pathBonus: number;
    aggregateNudge: number;
    editDistance: number;
  };
}

export type DeclineReason =
  | "tie"
  | "below_floor"
  | "unit_conflict_only"
  | "case_ambiguity"
  | "stub_vs_annual"
  | "no_candidates";

export interface FindFigureResult {
  status: "resolved" | "declined";
  candidate: FigureCandidate | null;
  declineReason: DeclineReason | null;
  topCandidates: FigureCandidate[];   // always top 3 for logging
  candidatesConsidered: number;
  filtersApplied: string[];
}

// ---------------------------------------------------------------------------
// Query function type (same as adapter)
// ---------------------------------------------------------------------------

type QueryFn = (
  sql: string,
  schema: z.ZodTypeAny,
  params: unknown[],
  meta?: { label: string },
) => Promise<any[]>;

// ---------------------------------------------------------------------------
// DB row schema
// ---------------------------------------------------------------------------

const CandidateRow = z.object({
  cell_ref: z.string(),
  sheet_name: z.string(),
  workbook_role: z.string(),
  row_label: z.string(),
  row_label_path: z.string().nullable(),
  value_raw: z.string().nullable(),
  value_num: z.string().nullable(),
  scale_multiplier: z.string().nullable(),
  unit_class: z.string().nullable(),
  currency: z.string().nullable(),
  display_value: z.string().nullable(),
  period_label: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  period_type: z.string().nullable(),
  period_basis: z.string().nullable(),
  case_label: z.string().nullable(),
  case_key: z.string().nullable(),
  is_aggregate: z.boolean().nullable(),
  sign_convention: z.string().nullable(),
  col_header_raw: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIE_THRESHOLD = 0.10;     // top two within 10% → decline
const FLOOR_SCORE = 0.15;       // below this → decline
const MAX_CANDIDATES = 200;     // SQL LIMIT for initial fetch

// ---------------------------------------------------------------------------
// Label similarity (no LLM)
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function tokenOverlapScore(query: string, target: string): number {
  const qTokens = tokenize(query);
  const tTokens = tokenize(target);
  if (qTokens.size === 0 || tTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of qTokens) {
    if (tTokens.has(t)) overlap++;
  }
  // Jaccard-like: overlap / union
  const union = new Set([...qTokens, ...tTokens]).size;
  return overlap / union;
}

function normalizedEditDistance(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  const maxLen = Math.max(al.length, bl.length);
  if (maxLen === 0) return 0;

  // Levenshtein
  const m = al.length;
  const n = bl.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = al[i - 1] === bl[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[m][n] / maxLen; // 1 = identical, 0 = no similarity
}

function labelScore(
  queryText: string,
  rowLabel: string,
  rowLabelPath: string | null,
  isAggregate: boolean,
  claimLooksLikeTotal: boolean,
): { total: number; tokenOverlap: number; pathBonus: number; aggregateNudge: number; editDistance: number } {
  const tokenOvl = tokenOverlapScore(queryText, rowLabel);

  // Path bonus: if query matches full path better than leaf
  let pathBonus = 0;
  if (rowLabelPath && rowLabelPath !== rowLabel) {
    const pathOvl = tokenOverlapScore(queryText, rowLabelPath);
    if (pathOvl > tokenOvl) {
      pathBonus = (pathOvl - tokenOvl) * 0.3;
    }
  }

  // Edit distance component (weighted lower — token overlap is primary)
  const editDist = normalizedEditDistance(queryText, rowLabel) * 0.3;

  // Aggregate nudge
  let aggregateNudge = 0;
  if (claimLooksLikeTotal && isAggregate) aggregateNudge = 0.05;
  if (!claimLooksLikeTotal && !isAggregate) aggregateNudge = 0.02;

  const total = tokenOvl * 0.5 + editDist + pathBonus + aggregateNudge;

  return { total, tokenOverlap: tokenOvl, pathBonus, aggregateNudge, editDistance: editDist };
}

function looksLikeTotal(text: string): boolean {
  return /\b(total|aggregate|sum|gross|net|overall)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Unit compatibility
// ---------------------------------------------------------------------------

function unitCompatible(claimUnit: string | null, cellUnit: string | null): boolean {
  if (!claimUnit || !cellUnit) return true; // null is compatible with anything
  // currency ↔ currency, percent ↔ percent, multiple ↔ multiple
  return claimUnit === cellUnit;
}

// ---------------------------------------------------------------------------
// Role routing (5.3)
// ---------------------------------------------------------------------------

const DEAL_KEYWORDS = /\b(irr|moic|money\s*multiple|entry\s*multiple|exit\s*multiple|leverage|debt|equity\s*check|sources?\s*(and|&)\s*uses?|returns?\s*analysis|net\s*returns?|gross\s*returns?|cap\s*table|fees?|waterfall)\b/i;

const BUSINESS_KEYWORDS = /\b(revenue|margin|ebitda|customers?|headcount|sites?|bookings?|churn|retention|growth|employees?|payroll|salaries?|rent|advertising|marketing)\b/i;

export function routeRole(metricText: string): "buy_side" | "sell_side" | "both" {
  const isDeal = DEAL_KEYWORDS.test(metricText);
  const isBusiness = BUSINESS_KEYWORDS.test(metricText);
  if (isDeal && !isBusiness) return "buy_side";
  if (isBusiness && !isDeal) return "sell_side";
  return "both"; // ambiguous → query both, decline on conflict
}

// ---------------------------------------------------------------------------
// Core: findFigure
// ---------------------------------------------------------------------------

export async function findFigure(
  queryFn: QueryFn,
  input: FindFigureInput,
): Promise<FindFigureResult> {
  const filtersApplied: string[] = [];

  // Determine role
  let role = input.workbookRole;
  if (!role) {
    role = routeRole(input.metricText);
    if (role === "both") role = null; // query both
  }

  // Build SQL filters
  const params: unknown[] = [input.dealId, input.period.start, input.period.end];
  let whereClauses = `
    d.deal_id = $1
    AND c.value_type = 'number'
    AND c.value_num IS NOT NULL
    AND c.row_label IS NOT NULL
    AND c.period_start IS NOT NULL
    AND c.period_start = $2
    AND c.period_end::date BETWEEN ($3::date - INTERVAL '3 days') AND ($3::date + INTERVAL '3 days')
  `;
  filtersApplied.push("period_start_exact+end_3day");

  // Period type: stub filter
  // Never match a stub cell against a non-stub claim
  if (input.period.type === "FY" || input.period.type === "CY") {
    whereClauses += " AND (c.period_type IS NULL OR c.period_type != 'stub')";
    filtersApplied.push("exclude_stubs");
  }

  // Role filter
  if (role && role !== "both") {
    params.push(role);
    whereClauses += ` AND w.workbook_role = $${params.length}`;
    filtersApplied.push(`role:${role}`);
  }

  // Case filter
  if (input.caseKey) {
    params.push(input.caseKey);
    whereClauses += ` AND c.case_key = $${params.length}`;
    filtersApplied.push(`case:${input.caseKey}`);
  }

  // Unit class filter (hard gate)
  if (input.unitClass) {
    // Allow null unit_class (compatible with anything)
    params.push(input.unitClass);
    whereClauses += ` AND (c.unit_class = $${params.length} OR c.unit_class IS NULL)`;
    filtersApplied.push(`unit:${input.unitClass}`);
  }

  // Query
  const sql = `
    SELECT
      c.cell_ref,
      c.sheet_name,
      w.workbook_role,
      c.row_label,
      c.row_label_path,
      c.value_raw::text,
      c.value_num::text,
      c.scale_multiplier::text,
      c.unit_class,
      c.currency,
      c.display_value,
      c.period_label,
      c.period_start::text,
      c.period_end::text,
      c.period_type,
      c.period_basis,
      c.case_label,
      c.case_key,
      c.is_aggregate,
      c.sign_convention,
      c.col_header_raw
    FROM workbook_cells c
    JOIN workbooks w ON w.id = c.workbook_id
    JOIN documents d ON d.id = w.document_id
    WHERE ${whereClauses}
    LIMIT ${MAX_CANDIDATES}
  `;

  const rows = await queryFn(sql, CandidateRow, params, {
    label: `findFigure: "${input.metricText.slice(0, 40)}"`,
  });

  if (rows.length === 0) {
    return {
      status: "declined",
      candidate: null,
      declineReason: "no_candidates",
      topCandidates: [],
      candidatesConsidered: 0,
      filtersApplied,
    };
  }

  // Score each candidate
  const claimIsTotal = looksLikeTotal(input.metricText);

  const scored: FigureCandidate[] = rows.map((r) => {
    const rawNum = parseFloat(r.value_num ?? "0");
    const scale = parseFloat(r.scale_multiplier ?? "1");
    const uc = r.unit_class;
    let scaledValue: number;
    if (uc === "percent") {
      scaledValue = rawNum * 100;
    } else {
      scaledValue = rawNum * scale;
    }

    const scores = labelScore(
      input.metricText,
      r.row_label,
      r.row_label_path,
      r.is_aggregate === true,
      claimIsTotal,
    );

    return {
      cellRef: r.cell_ref,
      sheet: r.sheet_name,
      workbookRole: r.workbook_role,
      rowLabelPath: r.row_label_path ?? r.row_label,
      rowLabel: r.row_label,
      valueRaw: rawNum,
      scaleMultiplier: scale,
      scaledValue,
      unitClass: r.unit_class,
      currency: r.currency,
      displayValue: r.display_value,
      periodLabel: r.period_label,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      periodType: r.period_type,
      caseLabel: r.case_label,
      caseKey: r.case_key,
      isAggregate: r.is_aggregate === true,
      signConvention: r.sign_convention,
      score: scores.total,
      scoreBreakdown: {
        tokenOverlap: scores.tokenOverlap,
        pathBonus: scores.pathBonus,
        aggregateNudge: scores.aggregateNudge,
        editDistance: scores.editDistance,
      },
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3);
  const best = scored[0];

  // --- Decline checks (5.2) ---

  // Floor check
  if (best.score < FLOOR_SCORE) {
    return {
      status: "declined",
      candidate: null,
      declineReason: "below_floor",
      topCandidates: top3,
      candidatesConsidered: scored.length,
      filtersApplied,
    };
  }

  // Unit conflict: only candidates have null unit_class and claim has definite unit
  if (input.unitClass && scored.every((c) => c.unitClass === null)) {
    return {
      status: "declined",
      candidate: null,
      declineReason: "unit_conflict_only",
      topCandidates: top3,
      candidatesConsidered: scored.length,
      filtersApplied,
    };
  }

  // Stub vs annual
  if (
    (input.period.type === "FY" || input.period.type === "CY") &&
    best.periodType === "stub"
  ) {
    return {
      status: "declined",
      candidate: null,
      declineReason: "stub_vs_annual",
      topCandidates: top3,
      candidatesConsidered: scored.length,
      filtersApplied,
    };
  }

  // Tie check
  if (scored.length >= 2) {
    const second = scored[1];
    const margin = best.score * TIE_THRESHOLD;
    if (best.score - second.score < margin) {
      // Check case ambiguity specifically
      if (!input.caseKey && best.caseKey !== second.caseKey) {
        return {
          status: "declined",
          candidate: null,
          declineReason: "case_ambiguity",
          topCandidates: top3,
          candidatesConsidered: scored.length,
          filtersApplied,
        };
      }
      return {
        status: "declined",
        candidate: null,
        declineReason: "tie",
        topCandidates: top3,
        candidatesConsidered: scored.length,
        filtersApplied,
      };
    }
  }

  // Cross-role conflict check (5.3)
  // If we queried both roles and top candidates come from different roles with close scores
  if (!input.workbookRole && role === null && scored.length >= 2) {
    const second = scored[1];
    if (best.workbookRole !== second.workbookRole) {
      const margin = best.score * TIE_THRESHOLD;
      if (best.score - second.score < margin) {
        return {
          status: "declined",
          candidate: null,
          declineReason: "tie",
          topCandidates: top3,
          candidatesConsidered: scored.length,
          filtersApplied,
        };
      }
    }
  }

  // Resolved
  return {
    status: "resolved",
    candidate: best,
    declineReason: null,
    topCandidates: top3,
    candidatesConsidered: scored.length,
    filtersApplied,
  };
}
