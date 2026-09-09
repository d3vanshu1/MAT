/**
 * Deal Config Inference — D2
 *
 * Reads Excel sheet captions and column headers to infer deal-level settings:
 *   - currency (from "$", "£", "€", "US$", "GBP" in captions)
 *   - scale (from "in millions", "in 000s", "in thousands" in captions)
 *   - fiscal calendar (from column headers — month names or period labels)
 *   - case names (from sheet names — "Base Case", "Upside Case", etc.)
 *
 * Returns InferredDealConfig with confidence levels and source citations.
 * Every inference prints its source so a wrong guess is visible on day one.
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferredSetting<T> {
  value: T;
  confidence: "high" | "medium" | "low";
  source: string; // e.g. "Financial Summary caption: '($ in millions)'"
  conflicting?: Array<{ value: T; source: string }>; // D4: cross-check failures
}

export interface InferredDealConfig {
  currency: InferredSetting<string> | null;
  scale: InferredSetting<string> | null;
  fiscalYearEnd: InferredSetting<number> | null; // month number 1-12, null if calendar year
  caseNames: InferredSetting<string[]> | null;
}

// ---------------------------------------------------------------------------
// Caption row schema
// ---------------------------------------------------------------------------

const CaptionRow = z.object({
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Currency inference
// ---------------------------------------------------------------------------

const CURRENCY_PATTERNS: Array<{ pattern: RegExp; symbol: string }> = [
  { pattern: /\(\s*(?:US)?\$\s+in\b/i, symbol: "$" },
  { pattern: /\(\s*\$\s+in\b/i, symbol: "$" },
  { pattern: /\(\s*£\s+in\b/i, symbol: "£" },
  { pattern: /\(\s*€\s+in\b/i, symbol: "€" },
  { pattern: /\(\s*US\$\b/i, symbol: "$" },
  { pattern: /\bUSD\b/i, symbol: "$" },
  { pattern: /\bGBP\b/i, symbol: "£" },
  { pattern: /\bEUR\b/i, symbol: "€" },
];

function inferCurrency(captions: Array<{ sheet: string; caption: string }>): InferredSetting<string> | null {
  const votes: Map<string, Array<{ sheet: string; caption: string }>> = new Map();
  for (const c of captions) {
    for (const { pattern, symbol } of CURRENCY_PATTERNS) {
      if (pattern.test(c.caption)) {
        if (!votes.has(symbol)) votes.set(symbol, []);
        votes.get(symbol)!.push(c);
        break; // one vote per caption
      }
    }
  }
  if (votes.size === 0) return null;
  // Majority wins
  const sorted = [...votes.entries()].sort((a, b) => b[1].length - a[1].length);
  const winner = sorted[0];
  const conflicting = sorted.slice(1).map(([sym, sources]) => ({
    value: sym,
    source: sources[0].sheet + " caption",
  }));
  return {
    value: winner[0],
    confidence: conflicting.length > 0 ? "medium" : "high",
    source: `${winner[1][0].sheet} caption: "${winner[1][0].caption.slice(0, 80)}"`,
    conflicting: conflicting.length > 0 ? conflicting : undefined,
  };
}

// ---------------------------------------------------------------------------
// Scale inference
// ---------------------------------------------------------------------------

const SCALE_PATTERNS: Array<{ pattern: RegExp; scale: string }> = [
  { pattern: /in\s+millions/i, scale: "millions" },
  { pattern: /in\s+000s/i, scale: "thousands" },
  { pattern: /in\s+thousands/i, scale: "thousands" },
  { pattern: /in\s+units/i, scale: "units" },
  { pattern: /in\s+billions/i, scale: "billions" },
];

function inferScale(captions: Array<{ sheet: string; caption: string }>): InferredSetting<string> | null {
  const votes: Map<string, Array<{ sheet: string; caption: string }>> = new Map();
  for (const c of captions) {
    for (const { pattern, scale } of SCALE_PATTERNS) {
      if (pattern.test(c.caption)) {
        if (!votes.has(scale)) votes.set(scale, []);
        votes.get(scale)!.push(c);
        break;
      }
    }
  }
  if (votes.size === 0) return null;
  const sorted = [...votes.entries()].sort((a, b) => b[1].length - a[1].length);
  const winner = sorted[0];
  const conflicting = sorted.slice(1).map(([s, sources]) => ({
    value: s,
    source: sources[0].sheet + ` caption ("${sources[0].caption.slice(0, 40)}…")`,
  }));
  return {
    value: winner[0],
    confidence: conflicting.length > 0 ? "medium" : "high",
    source: `${winner[1][0].sheet} caption: "${winner[1][0].caption.slice(0, 80)}"`,
    conflicting: conflicting.length > 0 ? conflicting : undefined,
  };
}

// ---------------------------------------------------------------------------
// Case name inference (from sheet names)
// ---------------------------------------------------------------------------

const CASE_PATTERNS = [
  /base\s*case/i,
  /upside\s*case/i,
  /downside\s*case/i,
  /management\s*case/i,
  /pep\s*case/i,
  /risk[\s-]*adjusted/i,
  /severe[\s-]*downside/i,
  /budget\s*case/i,
];

function inferCaseNames(sheets: string[]): InferredSetting<string[]> | null {
  const cases: string[] = [];
  const sourceSheets: string[] = [];
  for (const sheet of sheets) {
    for (const p of CASE_PATTERNS) {
      const match = sheet.match(p);
      if (match) {
        cases.push(match[0]);
        sourceSheets.push(sheet);
        break;
      }
    }
  }
  if (cases.length === 0) return null;
  return {
    value: [...new Set(cases)],
    confidence: "high",
    source: `Sheet names: ${sourceSheets.slice(0, 3).join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Fiscal calendar inference (from column headers in data)
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function inferFiscalYearEnd(captions: Array<{ sheet: string; caption: string }>): InferredSetting<number> | null {
  // Look for date-like column headers in captions (e.g. "Mar-24", "June 2024", "FYE March")
  for (const c of captions) {
    const fyeMatch = c.caption.match(/FY(?:E|ear[\s-]*end)\s*(\w+)/i);
    if (fyeMatch) {
      const monthIdx = MONTH_NAMES.findIndex(m => fyeMatch[1].toLowerCase().startsWith(m));
      if (monthIdx >= 0) {
        return {
          value: monthIdx + 1,
          confidence: "high",
          source: `${c.sheet} caption: "${c.caption.slice(0, 60)}"`,
        };
      }
    }
  }
  // Default: calendar year (December)
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function inferDealConfig(
  db: { query: (...args: any[]) => Promise<any[]> },
  dealId: string,
): Promise<InferredDealConfig> {
  // Load all captions from model documents
  const rows = await db.query(
    `SELECT dt.sheet_or_page, dt.caption
     FROM doc_tables dt
     JOIN documents d ON d.id = dt.document_id
     WHERE d.deal_id = $1::uuid
       AND d.document_tag IN ('financial_model', 'returns_model')
       AND dt.caption IS NOT NULL
       AND dt.caption != ''`,
    CaptionRow,
    [dealId],
    { label: "Load model captions for config inference" },
  );

  const captions = rows.map(r => ({ sheet: r.sheet_or_page, caption: r.caption ?? "" }));
  const sheets = [...new Set(rows.map(r => r.sheet_or_page))];

  return {
    currency: inferCurrency(captions),
    scale: inferScale(captions),
    fiscalYearEnd: inferFiscalYearEnd(captions),
    caseNames: inferCaseNames(sheets),
  };
}
