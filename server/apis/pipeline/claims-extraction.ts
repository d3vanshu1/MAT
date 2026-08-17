/**
 * Claims Extraction — Structured claim ledger from IC memos.
 *
 * PURPOSE: Extract every quantitative financial claim from IC memos into a typed
 * ledger with precise scope classification. This is the backbone of the
 * claims-reconciliation loop: LLM locates and classifies; code verifies arithmetic.
 *
 * KEY DESIGN PRINCIPLE: The scope_qualifier field is what prevents fabrication.
 * "£4m EBITDA acquired p.a. at 5.5x" → scope: "acquired-via-M&A (deal-sizing)"
 * This is NOT organic EBITDA and must NEVER be compared to the model's organic EBITDA.
 *
 * The extraction prompt enforces scope-family awareness:
 *   EBITDA: Adjusted / Reported / Cash / Organic Cash / Run-rate / Entry / acquired-via-M&A
 *   Revenue: Total Group / Pro-forma (PF) / excl-future-M&A / organic (excl recent acq)
 *   Multiples/Returns: structuring basis / entry basis / exit basis
 *
 * Architecture: Called as Step 0.8 in pipeline-core for contradiction_check runs,
 * after numeric-verify-inline (Step 0.7) and before the merge phase.
 */
import { z } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom, MessageResponseSchema, type LLMResponse } from "./call-llm.js";
import { SONNET_MODEL } from "./model-config.js";
import type { PipelineContext } from "./pipeline-config.js";
import {
  type CanonicalIcClaim,
  fromLegacyClaim,
  buildQualitativeClaim,
  buildClaimLedger as buildCanonicalLedger,
  type CanonicalClaimLedger,
} from "./canonical-ic-claim.js";
import { QUALITATIVE_EXTRACTION_PROMPT } from "./extract-canonical-claims.js";
import { chunkDocumentWithOverlap } from "./extraction-prompt.js";

// ---------------------------------------------------------------------------
// Claim Schema — the typed ledger
// ---------------------------------------------------------------------------

export const ClaimSchema = z.object({
  metric: z.enum([
    "revenue",
    "EBITDA",
    "gross_margin",
    "net_income",
    "net_debt",
    "multiple",
    "growth_rate",
    "cost",
    "capex",
    "cash_flow",
    "returns",
    "other_financial",
  ]),
  scope_qualifier: z.string().describe(
    "The EXACT basis/scope — e.g. 'Organic Cash EBITDA', 'PF Revenue', " +
    "'acquired-via-M&A (deal-sizing)', 'PEP Cash EBITDA (Organic)', 'Group Revenue (excl-future-M&A)'. " +
    "This field PREVENTS fabrication by distinguishing metrics that share a name but have different scopes. " +
    "MUST NEVER be a metric enum value (e.g. never 'other_financial', 'net_debt'). Use 'NONE_STATED' if no qualifier is stated."
  ),
  period: z.string().describe(
    "Temporal reference ONLY — e.g. 'FY Mar-26', 'LTM Sep-26', 'FY23-26', 'FY31F'. " +
    "NO parentheticals, scenarios, or basis descriptors. Those go in 'scenario' or 'basis'."
  ),
  value: z.number(),
  unit: z.enum(["£m", "%", "x", "£k", "£", "p", "years", "bps", "other"]),
  basis: z.string().nullable().describe(
    "The measurement basis when explicitly stated — e.g. 'OCF basis', 'Cash EBITDA basis', " +
    "'ARR', 'contracted GP', 'opening ARR'. Null when the document states no explicit basis qualifier."
  ),
  scenario: z.string().nullable().describe(
    "The sensitivity or scenario parameter — e.g. '14.2% CAGR', 'no M&A', '£8m M&A p.a.', " +
    "'Management Plan', 'PEP Base Case', 'Ares package'. Null for unconditional/base-case claims."
  ),
  basis_note: z.string().describe(
    "Free-text: what the number refers to. E.g. 'avg EBITDA acquired per M&A deal', " +
    "'pro-forma revenue including completed acquisitions', 'entry EV / Adj EBITDA'"
  ),
  source_doc: z.string(),
  source_page: z.string().nullable(),
  verbatim_snippet: z.string().describe("The EXACT memo text containing this claim — REQUIRED for auditability"),
  source_locations: z.array(z.object({
    source_page: z.string(),
    verbatim_snippet: z.string(),
  })).nullable().default(null).describe(
    "Additional locations where this same figure appears in the memo. " +
    "The primary location stays in source_page + verbatim_snippet at top level. " +
    "This array captures EXTRA occurrences (same metric, scope, period, value, unit) from other sections. " +
    "Null when the figure appears only once."
  ),
  claim_category: z.enum([
    "operating_metric",       // Revenue, EBITDA, margins, costs — reconcilable against operating model
    "deal_mechanics",         // M&A pacing, deal-sizing multiples, IRR targets, exit assumptions
    "valuation_structuring",  // Entry EV, equity check, leverage, structuring EBITDA
    "returns_projection",     // IRR, MoM, DPI — depend on returns model not provided
    "cross_reference",        // Figures referencing external reports (FDD, legal DD, QoE)
  ]).describe(
    "Classification determining whether this claim is reconcilable against the operating model. " +
    "Only 'operating_metric' claims are matched to model lines. Others are tagged but not reconciled."
  ),
});

export type Claim = z.infer<typeof ClaimSchema>;

// ---------------------------------------------------------------------------
// Terminal Result — one record per input memo
// ---------------------------------------------------------------------------

export type TerminalStatus = "success" | "failed" | "timed_out" | "partial" | "pending";

export interface TerminalResult {
  memo_id: string;
  file_name: string;
  status: TerminalStatus;
  claims_count: number;
  /** True when ANY chunk hit max_tokens — claims are partial */
  output_truncated?: boolean;
  /** Total output tokens consumed across all chunks for this memo */
  output_tokens?: number;
  error?: string;
  /** Per-chunk extraction metrics */
  chunk_results?: ChunkResult[];
}

/**
 * Internal result from a single memo extraction — carries enough context
 * to assign truthful terminal status.
 */
export interface ExtractionResult {
  claims: Claim[];
  /** Qualitative canonical claims extracted from the same memo */
  qualitativeClaims: CanonicalIcClaim[];
  truncated: boolean;
  /** True when ANY chunk's LLM response hit max_tokens (stop_reason = "max_tokens"). */
  output_truncated: boolean;
  /** Total output tokens across all chunks */
  output_tokens: number;
  parseFailed: boolean;
  parseError?: string;
  /** Per-chunk extraction metrics (populated when document is chunked) */
  chunk_results?: ChunkResult[];
}

export interface ChunkResult {
  index: number;
  charStart: number;
  charEnd: number;
  claims: number;
  output_tokens: number;
  output_truncated: boolean;
  elapsed_ms: number;
  /** True when 0 claims extracted despite >500 output tokens — indicates silent parse loss */
  parse_recovered_empty?: boolean;
  /** True when this chunk was truncated and qualifies for subdivision but subdivision was deferred */
  needs_subdivide?: boolean;
}

export interface ClaimsLedger {
  claims: Claim[];
  /** true only when every input memo has a terminal result and pending = 0 */
  complete: boolean;
  terminal_results: TerminalResult[];
  extraction_metadata: {
    /** Number of memos with a non-pending terminal result */
    docs_processed: number;
    /** Number of memos not yet processed (budget expired before launch) */
    pending: number;
    /** Number of memos newly processed THIS invocation (for no-progress detection) */
    completed_this_invocation?: number;
    total_claims: number;
    operating_metric_claims: number;
    deal_mechanics_claims: number;
    valuation_structuring_claims: number;
    returns_projection_claims: number;
    cross_reference_claims: number;
    extraction_model: string;
    extraction_timestamp: string;
    /** Consecutive zero-progress invocations (for adaptive work-unit sizing) */
    consecutive_no_progress?: number;
  };
  /**
   * MAT-F01: Canonical claim records produced by converting legacy Claim[] through
   * source validation. This is the production canonical ledger — used by the
   * claim-first admission gate. Persisted alongside the legacy claims for
   * backward compatibility. Only populated after conversion step completes.
   */
  canonical_claims?: CanonicalIcClaim[];
}

// ---------------------------------------------------------------------------
// B3: Code-level dedup — collapse on (metric, scope_qualifier, basis, period, value, unit)
// ---------------------------------------------------------------------------

/**
 * Deduplicates claims by coordinate identity: (metric, scope_qualifier, basis, period, value, unit).
 * When duplicates are found, the first occurrence is kept as-is and subsequent occurrences'
 * source locations are merged into the first's source_locations array.
 *
 * This is a BACKSTOP for the prompt-level dedup instruction (B2).
 * DO NOT confuse with the claim_id dedup in buildCanonicalLedger — that one
 * keys on (exact_claim_text, page) and is an idempotency guard for re-extraction.
 */
function deduplicateClaimsByCoordinate(claims: Claim[]): Claim[] {
  const keyMap = new Map<string, Claim>();

  for (const claim of claims) {
    // Key: metric|scope_qualifier|basis|period|value|unit (all lowercased/normalized)
    const key = [
      claim.metric,
      claim.scope_qualifier.toLowerCase().trim(),
      (claim.basis ?? "").toLowerCase().trim(),
      claim.period.toLowerCase().trim(),
      String(claim.value),
      claim.unit,
    ].join("|");

    const existing = keyMap.get(key);
    if (!existing) {
      keyMap.set(key, claim);
    } else {
      // Merge this claim's location into existing's source_locations
      const newLocation = {
        source_page: claim.source_page ?? claim.source_doc,
        verbatim_snippet: claim.verbatim_snippet,
      };

      if (!existing.source_locations) {
        existing.source_locations = [newLocation];
      } else {
        existing.source_locations.push(newLocation);
      }

      // Also merge any source_locations the duplicate itself carried
      if (claim.source_locations) {
        existing.source_locations.push(...claim.source_locations);
      }
    }
  }

  const deduplicated = Array.from(keyMap.values());
  if (deduplicated.length < claims.length) {
    console.log(
      `[ClaimsExtraction][B3-dedup] Collapsed ${claims.length} → ${deduplicated.length} claims ` +
      `(${claims.length - deduplicated.length} coordinate-level duplicates merged)`
    );
  }
  return deduplicated;
}

// ---------------------------------------------------------------------------
// Bounded Worker Pool — exported for direct testing
// ---------------------------------------------------------------------------

export interface WorkerPoolJob<T> {
  id: string;
  label: string;
  execute: () => Promise<T>;
}

export interface WorkerPoolOptions {
  concurrency: number;
  /**
   * Called before launching each new job. Return false to stop launching
   * further work (budget expired). Already-launched jobs will still settle.
   */
  canLaunch?: () => boolean;
}

export interface WorkerPoolResult<T> {
  results: Array<{
    job: WorkerPoolJob<T>;
    index: number;
    status: "fulfilled" | "rejected";
    value?: T;
    reason?: unknown;
  }>;
  /** Jobs that were never launched (budget expired or queue not reached) */
  pending: Array<{ job: WorkerPoolJob<T>; index: number }>;
}

/**
 * Bounded concurrency worker pool that:
 * - Launches at most `concurrency` jobs simultaneously
 * - Awaits ALL launched promises before returning (no leaked promises)
 * - Preserves original job order in results
 * - Supports a budget predicate (canLaunch) to stop launching new work
 * - Never returns while a launched promise remains unsettled
 */
export async function runWorkerPool<T>(
  jobs: WorkerPoolJob<T>[],
  options: WorkerPoolOptions,
): Promise<WorkerPoolResult<T>> {
  const { concurrency, canLaunch } = options;

  const results: WorkerPoolResult<T>["results"] = [];
  const pending: WorkerPoolResult<T>["pending"] = [];
  const inFlight = new Set<Promise<void>>();
  let nextIndex = 0;

  while (nextIndex < jobs.length) {
    // Budget gate: stop launching if predicate returns false
    if (canLaunch && !canLaunch()) {
      for (let i = nextIndex; i < jobs.length; i++) {
        pending.push({ job: jobs[i], index: i });
      }
      break;
    }

    // Wait for a slot if at capacity
    if (inFlight.size >= concurrency) {
      await Promise.race([...inFlight]);
    }

    // Launch the next job
    const idx = nextIndex;
    const job = jobs[idx];
    nextIndex++;

    const tracked = (async () => {
      try {
        const value = await job.execute();
        results.push({ job, index: idx, status: "fulfilled", value });
      } catch (reason) {
        results.push({ job, index: idx, status: "rejected", reason });
      }
    })().then(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
  }

  // Await ALL remaining in-flight work — no leaked promises
  while (inFlight.size > 0) {
    await Promise.race([...inFlight]);
  }

  // Sort by original index for deterministic ordering
  results.sort((a, b) => a.index - b.index);

  return { results, pending };
}

// ---------------------------------------------------------------------------
// Extraction Prompt
// ---------------------------------------------------------------------------

export const CLAIMS_EXTRACTION_PROMPT = `You are a senior private equity analyst performing STRUCTURED CLAIM EXTRACTION from IC memos.

Your job: Extract every quantitative financial claim into a typed ledger with PRECISE scope classification.

## CRITICAL: Scope Classification Rules

The scope_qualifier field is the ANTI-FABRICATION field. It determines whether two numbers CAN be compared.
A wrong scope_qualifier causes false divergence findings — the exact failure mode we are eliminating.

⚠️ ABSOLUTE RULE: scope_qualifier must reflect the ACTUAL BASIS of the number as stated in the memo.
DO NOT default to "Total Group Revenue" or any other generic label. If in doubt, use a more specific scope.

### EBITDA Scope Families (all distinct, never interchangeable):
- "Reported EBITDA" — as per statutory accounts
- "Adjusted EBITDA" — post management adjustments (add-backs, one-offs removed). Use ONLY when the memo explicitly says "Adjusted" without "Non Pro Forma" qualifier.
- "Cash EBITDA (Reported / Non Pro Forma)" — the REPORTED (non-pro-forma) adjusted cash EBITDA from the financials table. ⚠️ When a table is labelled "Non Pro Forma" or "Non-PF", use THIS scope — it is DISTINCT from PEP/management case figures. E.g., "Adj. Cash EBITDA (Non Pro Forma) 33.5 38.7 44.5 54.9" → scope = "Cash EBITDA (Reported / Non Pro Forma)", NOT "Adjusted EBITDA".
- "Cash EBITDA" — standalone usage without "adjusted" or "non-PF" qualifier (e.g., "£55m Cash EBITDA" in deal scorecard)
- "Organic Cash EBITDA" — excludes contribution from recent/pending acquisitions
- "PEP Cash EBITDA (Organic)" — specific to the PEP methodology, organic only. Use when the context explicitly references the "PEP case" or "PEP plan" EBITDA.
- "Run-rate EBITDA" — annualised from a recent period (NOT a full-year actual)
- "Entry EBITDA" — the EBITDA used for entry multiple calculation (may differ from reported)
- "Structuring EBITDA" — basis for leverage/pricing in the deal structure
- "EBITDA acquired via M&A (deal-sizing)" — average per-deal acquired EBITDA for M&A pacing assumptions
  ⚠️ THIS IS NOT ORGANIC EBITDA. "~£4m EBITDA p.a. at 5.5x" in context of M&A deal-sizing = this category.

⚠️ CRITICAL EBITDA DISAMBIGUATION: The model's PEP case may show ~£57m for FY26, while the REPORTED (Non Pro Forma) table shows ~£54.9m for the same year. These are DIFFERENT figures with DIFFERENT scopes. If the table says "Non Pro Forma", scope it "Cash EBITDA (Reported / Non Pro Forma)" — NEVER "Adjusted EBITDA" which would false-match against the PEP figure.

### Revenue Scope Families (all distinct — DO NOT CONFLATE):
- "Total Group Revenue" — ONLY use when the figure explicitly represents all entities, all sources, REPORTED (not adjusted). The headline "£194m revenue" or "FY26 Revenue: £194m" = Total Group Revenue.
- "Revenue (PF / pro-forma)" — ONLY when explicitly labelled "pro-forma" or "PF" or the table header says "Pro Forma"
- "Revenue (LfL / like-for-like)" — organic revenue growth series stripped of acquisition effects. ⚠️ LfL figures are DIFFERENT from Total Group Revenue. E.g., if reported revenue is £125m/£145m/£168m but LfL shows £154m/£166m/£177m, these are DIFFERENT series with DIFFERENT scopes.
- "Revenue (excl-future-M&A)" — group revenue minus uncommitted future M&A
- "Revenue (organic, excl recent acquisitions)" — strips out recent M&A contribution
- "Revenue (run-rate)" — annualised from a recent sub-period
- "Revenue (segment: <segment_name>)" — segment-level revenue, MUST carry the segment name. E.g., "Revenue (segment: Surgery Connect)", "Revenue (segment: IT Services)"

### Operational Rates (NOT revenue, NOT EBITDA — these are distinct metrics):
- "Recurring Revenue %" — percentage of revenue that is recurring (e.g., "96% recurring revenue")
- "Net Revenue Retention (NRR)" — net retention rate (e.g., "102% NRR")
- "Gross Revenue Retention" — before upsell
- "Customer Churn Rate" — percentage of customers lost (e.g., "~5% churn", "7% churn L3Y")
- "Cash Conversion %" — OCF/EBITDA or similar ratio (e.g., "90% cash conversion")
⚠️ These are NEVER "Total Group Revenue" even though they relate to the revenue base. They are rates/percentages describing quality, not absolute revenue figures.

### Market / TAM (NOT company metrics):
- "TAM (market size)" — addressable market size (e.g., "£12.5bn UK B2B comms market")
- "TAM growth rate" — market growth rate (e.g., "growing 3%")
- "Segment TAM (<segment>)" — segment-level market (e.g., "UCaaS seats growing 5%")
⚠️ Market figures are NEVER "Total Group Revenue". They describe the market, not the company's revenue.

### Gross Profit Scope Families:
- "Total Gross Profit" — all-entity, all-source gross profit (reported)
- "Gross Profit (PF / pro-forma)" — pro-forma basis
- "Gross Profit (LfL / like-for-like)" — organic/LfL gross profit, excludes M&A
- "Gross Profit (segment: <segment_name>)" — segment-level GP
- "GP Margin" — gross profit margin as a percentage

### EBITDA Margin vs Absolute:
- "Cash EBITDA Margin" — percentage (e.g., "29% Cash EBITDA margin") — NOT "Cash EBITDA"
- "GP Margin" — gross profit margin percentage

### Valuation/Multiple Families:
- "EV/EBITDA (entry)" — entry valuation basis
- "EV/EBITDA (structuring)" — for leverage/pricing
- "EV/EBITDA (exit)" — assumed exit multiple
- "Per-deal M&A multiple" — price per M&A bolt-on (deal-sizing context)

### Returns:
- "Gross IRR" / "Net IRR" / "MoM" / "DPI" — these depend on a returns model

### Cost / Capex / Other:
- "DD Costs" — due diligence expenditure
- "Capex" — capital expenditure
- "OCF" — operating cash flow (EBITDA - Capex - WC typically)
- "EFCF" — equity free cash flow
- "Pro-forma adjustment" — bridge items (e.g., synergies, trading outperformance)

## CRITICAL: Claim Category Classification

Classify each claim into exactly one category:

1. **operating_metric** — Revenue, EBITDA, margins, costs that relate to the company's OPERATING performance.
   These are reconcilable against the operating/financial model.
   Examples: "£57m Cash EBITDA FY Mar-26", "£194m revenue", "£63m June RR EBITDA", "96% recurring revenue"
   ⚠️ Operational rates (NRR, churn, recurring %) ARE operating_metrics but their scope is the rate name, not "Total Group Revenue"

2. **deal_mechanics** — M&A pacing assumptions, per-deal sizes, bolt-on pipeline, DD costs.
   NOT reconcilable against the operating model (these describe deal activity, not current operations).
   Examples: "~£4m EBITDA acquired p.a. at 5.5x", "~£3m total DD cost"

3. **valuation_structuring** — Entry EV, equity check, leverage ratios, structuring EBITDA.
   May reference operating metrics but the claim itself is about deal structure.
   Examples: "£655m entry EV", "£400m equity at 6.0x", "4.9x net leverage"

4. **returns_projection** — IRR, MoM, DPI. Depend on a returns model not in the operating model.
   Examples: "23.4% gross IRR", "2.9x MoM base case"

5. **cross_reference** — Figures attributed to external reports (FDD findings, legal DD, QoE).
   Examples: "FDD identifies £2.1m normalisation"

## Context Signals for Classification

When a number appears in a sentence about M&A deal-sizing ("acquire ~£X EBITDA at Y.Yx", 
"bolt-on at Zx"), classify as deal_mechanics regardless of the metric name.

When a number is used to compute entry multiples, leverage, or equity sizing, 
classify as valuation_structuring.

When a number projects future returns (IRR, MoM, exit), classify as returns_projection.

## Scope Qualifier Self-Check (MANDATORY before outputting each claim)

Before writing each claim, ask yourself:
1. Is this a COMPANY metric or a MARKET metric? If market → "TAM (market size)" or "TAM growth rate"
2. Is this a RATE/PERCENTAGE describing business quality? If yes → use the specific rate name (NRR, churn, recurring %, cash conversion %, margin)
3. Is this from a LfL/like-for-like/organic series? If yes → "Revenue (LfL / like-for-like)" NOT "Total Group Revenue"
4. Is this from a pro-forma table? If yes → "(PF / pro-forma)"
5. Is this from a segment breakdown? If yes → carry the segment name
6. Only use "Total Group Revenue" if the number genuinely represents ALL reported revenue across the entire group

## Period vs Basis vs Scenario: Three Distinct Axes

Every claim has up to three temporal/conditional dimensions. They are NEVER merged into a single field.

| Verbatim text | period | basis | scenario |
|---|---|---|---|
| FY Mar-26 OCF basis | FY Mar-26 | OCF basis | null |
| FY31F (14.2% CAGR) | FY31F | null | 14.2% CAGR |
| FY31F (PEP Base Case: 8.7% organic CAGR) | FY31F | null | PEP Base Case: 8.7% organic CAGR |
| FY26-FY31 (base case) | FY26-FY31 | null | base case |
| FY Mar-26 contracted GP | FY Mar-26 | contracted GP | null |
| FY31F (no M&A) | FY31F | null | no M&A |
| FY26 ARR | FY26 | ARR | null |
| FY26 (Ares package) | FY26 | null | Ares package |

Rules:
- **period** = temporal reference ONLY (fiscal year, quarter, LTM window, range). Never contains parentheticals.
- **basis** = measurement methodology or accounting basis explicitly stated (OCF basis, ARR, contracted GP, opening ARR). Null if not stated.
- **scenario** = sensitivity case, assumption variant, or model parameter (CAGR rates, M&A pacing labels, package names, base/bull/bear). Null for unconditional/base-case figures.

⚠️ If a period string contains parenthetical content like "FY31F (14.2% CAGR)", SPLIT IT:
- period = "FY31F"
- scenario = "14.2% CAGR"
NEVER put the parenthetical into the period field.

## Sensitivity Grid Cells — DO NOT EXTRACT

Sensitivity tables show computed outputs (IRR, MoM, EBITDA, EV) for many scenario cells.
These are arithmetic the deal team performed — no reference document can contradict them.
Do NOT extract these computed grid cells.

### What to skip (examples):
- Entry multiple at each scenario cell ("11.1x at £57m", "12.2x at £54m")
- IRR/MoM at each exit-multiple × CAGR intersection
- FY31 EBITDA under each organic CAGR assumption
- Any value that appears inside a matrix body (row × column output)

### What to extract from sensitivity sections:
- The AXIS ASSUMPTIONS themselves: "organic CAGR range tested 8–14%", "exit multiples tested 11–15x", "leverage: 4.5–5.5x"
- Entry multiple, exit multiple, and leverage stated as THE DEAL's chosen assumption (not each scenario variant)
- The single LABELLED BASE/CENTRAL CASE if the memo explicitly highlights one row as "our base case"

### Self-check for sensitivity context:
If you are about to emit a claim and the source text is inside a table with BOTH row headers (e.g. CAGR %) AND column headers (e.g. exit multiple), it is a sensitivity grid cell — SKIP IT.
If the same metric appears 4+ times with different values in the same section, you are likely extracting grid cells — STOP and only take the axis labels and the one highlighted case.

## Extraction Rules

1. Extract the VERBATIM snippet — the exact text from the memo. This is required.
2. Do NOT invent claims or reinterpret. If a number appears, extract what it SAYS.
3. If the scope is ambiguous, use the most specific scope you can infer from context.
4. For run-rate vs full-year: "June RR" or "annualised from [month]" = run-rate. "FY Mar-26" = full-year.
5. For PF (pro-forma): any revenue/EBITDA explicitly labelled "pro-forma" or "PF" = PF scope.
6. Multiple claims from the same sentence are fine — extract each distinct metric separately.
7. If a claim references another document's finding (e.g. "FDD shows £X"), tag as cross_reference.
8. Preserve the period as a TEMPORAL REFERENCE ONLY — no parentheticals, scenarios, or basis qualifiers.
9. For growth rates (CAGRs), use the scope of what's growing: "Organic Cash EBITDA" CAGR → scope = "Organic Cash EBITDA", NOT "Total Group Revenue".
10. scope_qualifier must NEVER be a metric enum value (e.g. never "other_financial", "net_debt", "cash_flow"). If no qualifier is stated, emit "NONE_STATED".
11. Split compound period strings: temporal part → period, methodology → basis, assumption → scenario.

## Deduplication: Repeated Figures → One Claim with source_locations

IC memos repeat key figures across sections (Executive Summary, Scorecard, Deal Overview). When the SAME figure appears in multiple places with the same metric, scope, period, value, and unit — emit ONE claim with the primary location in source_page/verbatim_snippet and additional locations in source_locations[].

Example: "£192m Total Group Revenue FY Mar-26" appears in Overview (p2), Scorecard (p5), and Exec Summary (p8). Emit ONE claim:
- source_page: "Overview (p2)"  [first occurrence]
- verbatim_snippet: "Total Group Revenue of £192m..."
- source_locations: [{"source_page": "Scorecard (p5)", "verbatim_snippet": "Revenue: £192m"}, {"source_page": "Exec Summary (p8)", "verbatim_snippet": "...generating £192m revenue..."}]

This saves output tokens and avoids duplicate reconciliation. When in doubt about whether two mentions are the same claim, check: same metric + same scope + same period + same value + same unit → merge.

## Output Format

Return a JSON array of claim objects. Each claim:
{
  "metric": "revenue" | "EBITDA" | "gross_margin" | "net_income" | "net_debt" | "multiple" | "growth_rate" | "cost" | "capex" | "cash_flow" | "returns" | "other_financial",
  "scope_qualifier": "<exact scope — MUST reflect actual basis, never a lazy default. Use NONE_STATED if none. NEVER a metric enum value.>",
  "period": "<temporal reference ONLY — e.g. 'FY Mar-26', 'FY26-FY31', 'LTM Sep-26'. NO parentheticals.>",
  "value": <numeric value>,
  "unit": "£m" | "%" | "x" | "£k" | "£" | "p" | "years" | "bps" | "other",
  "basis": "<measurement basis if stated — e.g. 'OCF basis', 'ARR', 'contracted GP'. null if not stated>",
  "scenario": "<sensitivity/scenario parameter — e.g. '14.2% CAGR', 'no M&A', 'base case'. null if unconditional>",
  "basis_note": "<what this number refers to>",
  "source_page": "<page/section reference or null>",
  "verbatim_snippet": "<exact text from the memo>",
  "source_locations": [{"source_page": "...", "verbatim_snippet": "..."}] or null,
  "claim_category": "operating_metric" | "deal_mechanics" | "valuation_structuring" | "returns_projection" | "cross_reference"
}

Return ONLY the JSON array. No markdown fences, no commentary.`;

// ---------------------------------------------------------------------------
// DB Schemas
// ---------------------------------------------------------------------------

const MemoDocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  parsed_text: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Run structured claim extraction on all IC memos for a deal.
 *
 * @param ctx Pipeline context (db + ai integrations)
 * @param dealId The deal UUID
 * @param pipelineStartTime Pipeline start timestamp for headroom calculations
 * @param timeBudgetMs Maximum time budget for the entire extraction phase
 * @returns ClaimsLedger with all extracted claims
 */
export interface ClaimsExtractionOptions {
  /** When true, calls AI directly without headroom guard (for diagnostics with relaxed timeouts) */
  bypassHeadroom?: boolean;
  /**
   * Prior partial ledger to resume from. When provided, only memos with
   * terminal_results[].status === "pending" will be processed. Already-completed
   * claims are retained and never re-extracted or deleted.
   */
  priorLedger?: ClaimsLedger;
  /**
   * Maximum number of memos to attempt this invocation. Reduced by no-progress
   * detection in the caller to prevent repeated failures consuming the entire budget.
   * Defaults to all pending memos.
   */
  maxWorkUnits?: number;
  /**
   * When true, skips the qualitative extraction pass (extractQualitativeFromMemo).
   * Halves LLM time per memo. Quantitative extraction is unaffected.
   */
  skipQualitative?: boolean;
  /**
   * Concurrency for chunk-level LLM calls within a single memo.
   * Default: 2 (pipeline), override to 8 for diagnostics.
   */
  chunkConcurrency?: number;
  /**
   * Chunk cursor — tracks which chunks are already extracted per memo.
   * Map of memoId → array of completed chunk indices.
   * Used for resume: completed chunks are skipped on re-entry.
   */
  chunkCursor?: Record<string, number[]>;
  /**
   * Called after each chunk completes extraction (post-subdivide). The harness
   * uses this to persist the FINAL per-chunk claims so reconstruction works.
   * Fires only after adaptive subdivide has replaced truncated results.
   */
  onChunkComplete?: (event: ChunkCompleteEvent) => Promise<void>;
  /**
   * Called immediately when a chunk's LLM call returns (pre-subdivide).
   * Used for cursor-only progress persistence. Does NOT include claims —
   * those are in onChunkComplete which fires post-subdivide.
   */
  onChunkProgress?: (memoId: string, chunkIndex: number) => Promise<void>;
  /**
   * When true, truncated chunks are NOT subdivided inline. Instead, they are
   * emitted via onChunkComplete with output_truncated=true and
   * needs_subdivide=true on the ChunkResult. The caller persists them and
   * handles subdivision on the next invocation (deferred pattern).
   *
   * When false (default), the inline subdivide loop runs immediately.
   */
  deferSubdivide?: boolean;
  /**
   * Map of chunk indices that need deferred subdivision (from a prior invocation).
   * memoId → array of {parentIdx, charStart, charEnd}. When present, these are
   * processed as pre-split sub-chunks (2 halves each) instead of full chunks.
   */
  subdivideQueue?: Record<string, Array<{ parentIdx: number; charStart: number; charEnd: number }>>;
}

export interface ChunkCompleteEvent {
  memoId: string;
  memoFileName: string;
  chunkIndex: number;
  chunkClaims: Claim[];
  chunkResult: ChunkResult;
  /** All claims extracted so far for this memo (across all completed chunks) */
  accumulatedClaims: Claim[];
  /** All chunk results so far */
  accumulatedChunkResults: ChunkResult[];
  /** Raw LLM response text — populated only when parse_recovered_empty is true */
  rawResponseText?: string;
}

export async function runClaimsExtraction(
  ctx: PipelineContext,
  dealId: string,
  pipelineStartTime: number,
  timeBudgetMs: number,
  options?: ClaimsExtractionOptions,
): Promise<ClaimsLedger> {
  const phaseStart = Date.now();
  console.log(`[ClaimsExtraction] Starting — budget ${Math.round(timeBudgetMs / 1000)}s`);

  // Load all IC memos for this deal
  const memos = await ctx.integrations.db.query(
    `SELECT id, file_name, parsed_text
     FROM documents
     WHERE deal_id = $1 AND document_tag = 'ic_memo' AND parsed_text IS NOT NULL
     ORDER BY uploaded_at ASC`,
    MemoDocSchema,
    [dealId],
    { label: "ClaimsExtraction: load IC memos" },
  );

  if (memos.length === 0) {
    console.log(`[ClaimsExtraction] No IC memos found for deal — skipping`);
    return {
      claims: [],
      complete: true,
      terminal_results: [],
      extraction_metadata: {
        docs_processed: 0,
        pending: 0,
        total_claims: 0,
        operating_metric_claims: 0,
        deal_mechanics_claims: 0,
        valuation_structuring_claims: 0,
        returns_projection_claims: 0,
        cross_reference_claims: 0,
        extraction_model: SONNET_MODEL,
        extraction_timestamp: new Date().toISOString(),
      },
    };
  }

  console.log(`[ClaimsExtraction] Found ${memos.length} IC memo(s): ${memos.map(m => m.file_name).join(", ")}`);

  // --- Incremental Resume: Determine which memos still need processing ---
  const priorLedger = options?.priorLedger;
  const maxWorkUnits = options?.maxWorkUnits;

  // Claims retained from prior invocations (never deleted/reset)
  const retainedClaims: Claim[] = priorLedger ? [...priorLedger.claims] : [];
  const retainedTerminals: TerminalResult[] = [];

  // Build a set of memo IDs that already have non-pending terminal results
  const completedMemoIds = new Set<string>();
  if (priorLedger) {
    for (const tr of priorLedger.terminal_results) {
      if (tr.status !== "pending") {
        completedMemoIds.add(tr.memo_id);
        retainedTerminals.push(tr);
      }
    }
    console.log(
      `[ClaimsExtraction] Resuming: ${completedMemoIds.size}/${memos.length} memos already processed, ` +
      `${retainedClaims.length} claims retained from prior invocations`
    );
  }

  // Filter to only pending (not-yet-processed) memos
  let pendingMemos = memos.filter(m => !completedMemoIds.has(m.id));

  // Apply maxWorkUnits cap (adaptive work-unit sizing for no-progress recovery)
  if (maxWorkUnits !== undefined && maxWorkUnits > 0 && pendingMemos.length > maxWorkUnits) {
    console.log(`[ClaimsExtraction] Capping work units: ${pendingMemos.length} pending → ${maxWorkUnits} this invocation`);
    pendingMemos = pendingMemos.slice(0, maxWorkUnits);
  }

  if (pendingMemos.length === 0) {
    // All memos already processed — ledger is complete
    console.log(`[ClaimsExtraction] All memos already processed — returning complete ledger`);
    return priorLedger!; // priorLedger is defined and complete if we reach here
  }

  // Concurrency: memo-level pool stays at 1 (sequential memos),
  // chunk-level pool runs chunks in parallel within each memo.
  const MEMO_CONCURRENCY = 1; // Process one memo at a time (chunks run concurrently within)
  const CHUNK_CONCURRENCY = options?.chunkConcurrency ?? (options?.bypassHeadroom ? 8 : 2);

  // Time-budget reserve: stop launching new work when less than this remains
  const BUDGET_RESERVE_MS = 30_000;

  // Chunk cursor — which chunks are already done (for resume)
  const chunkCursor = options?.chunkCursor ?? {};

  const extractMemo = async (memo: { id: string; file_name: string; parsed_text: string | null }): Promise<ExtractionResult> => {
    // Truncate very long memos to fit in context window (Sonnet: ~200K tokens)
    // 150K chars ≈ 37K tokens, leaving plenty for prompt + output
    const rawText = memo.parsed_text ?? "";
    const truncated = rawText.length > 150_000;
    const text = truncated
      ? rawText.slice(0, 150_000) + "\n\n[TRUNCATED — document exceeds 150K chars]"
      : rawText;

    console.log(`[ClaimsExtraction] Processing: "${memo.file_name}" (${Math.round(text.length / 1000)}K chars)`);

    // --- C2: Chunk the document with overlap for extraction ---
    // Gate C sizing: 4,500 chars per chunk with 500-char overlap.
    // Adaptive subdivide: one halving to 2,250, floor 2,000. If a 2,000-char
    // chunk truncates, accept truncation — do not subdivide further.
    const EXTRACTION_CHUNK_CHARS = 4500;
    const OVERLAP = 500;
    const chunks = chunkDocumentWithOverlap(memo.file_name, memo.id, text, { overlap: OVERLAP, chunkSize: EXTRACTION_CHUNK_CHARS });

    // Resume: skip chunks already completed per cursor
    const completedIndices = new Set(chunkCursor[memo.id] ?? []);
    const pendingChunks = chunks.filter(c => !completedIndices.has(c.chunkIndex));

    console.log(
      `[ClaimsExtraction] "${memo.file_name}": ${chunks.length} chunk(s) (${EXTRACTION_CHUNK_CHARS} chars, ${OVERLAP} overlap), ` +
      `${completedIndices.size} already done, ${pendingChunks.length} pending — concurrency ${CHUNK_CONCURRENCY}`
    );

    // Shared accumulators (protected by sequential callback execution)
    const allChunkClaims: Claim[] = [];
    const chunkResults: ChunkResult[] = [];
    let totalOutputTokens = 0;
    let anyTruncated = false;

    // --- Deferred subdivide queue: process previously-truncated chunks as pre-split sub-chunks ---
    const subdivideQueue = options?.subdivideQueue?.[memo.id] ?? [];
    const subdivideParentIndices = new Set(subdivideQueue.map(q => q.parentIdx));

    // Filter out subdivide-queued chunks from normal pending (they'll be processed as sub-chunks)
    const normalPendingChunks = pendingChunks.filter(c => !subdivideParentIndices.has(c.chunkIndex));

    if (subdivideQueue.length > 0) {
      console.log(
        `[ClaimsExtraction] "${memo.file_name}": ${subdivideQueue.length} chunk(s) queued for deferred subdivide ` +
        `(indices: [${[...subdivideParentIndices].join(",")}])`
      );
    }

    // Build sub-chunk jobs for queued subdivide entries
    const subdivideJobs: WorkerPoolJob<{ claims: Claim[]; result: ChunkResult }>[] = subdivideQueue.flatMap(({ parentIdx, charStart, charEnd }) => {
      const halfWidth = Math.floor((charEnd - charStart) / 2);
      const midpoint = charStart + halfWidth;
      const subChunks = [
        { start: charStart, end: midpoint, subPart: 1 },
        { start: midpoint, end: charEnd, subPart: 2 },
      ];

      return subChunks.map(({ start, end, subPart }) => ({
        id: `${memo.id}:${parentIdx}:sub${subPart}`,
        label: `${memo.file_name} chunk ${parentIdx + 1} sub ${subPart}/2`,
        execute: async (): Promise<{ claims: Claim[]; result: ChunkResult }> => {
          const subStart = Date.now();
          const subText = text.slice(start, end);

          const subBody = {
            model: SONNET_MODEL,
            max_tokens: 16_384,
            temperature: 0,
            system: CLAIMS_EXTRACTION_PROMPT,
            messages: [
              {
                role: "user",
                content: `## Document: ${memo.file_name} (chunk ${parentIdx + 1}/${chunks.length}, sub-part ${subPart}/2)\n\nExtract all quantitative financial claims from this section:\n\n${subText}`,
              },
            ],
          };

          let subResp: LLMResponse;
          if (options?.bypassHeadroom) {
            subResp = await ctx.integrations.ai.apiRequest(
              { method: "POST", path: "/v1/messages", body: subBody },
              { response: MessageResponseSchema },
              { label: `ClaimsExtraction: deferred subdivide ${memo.file_name} chunk ${parentIdx + 1} sub ${subPart}/2` },
            );
          } else {
            subResp = await callLLMWithHeadroom(
              ctx, subBody,
              `ClaimsExtraction: deferred subdivide ${memo.file_name} chunk ${parentIdx + 1} sub ${subPart}/2`,
              { pipelineStartTime, maxPerCallTimeout: 180_000, retries: 1 },
            );
          }

          const subRespText = subResp.content[0]?.text ?? "";
          const subParse = parseClaimsResponse(subRespText, memo.file_name);
          const subTrunc = subResp.stop_reason === "max_tokens";
          const subTokens = subResp.usage.output_tokens;
          const subElapsed = Date.now() - subStart;

          // Notify cursor progress
          if (options?.onChunkProgress) {
            await options.onChunkProgress(memo.id, parentIdx);
          }

          return {
            claims: subParse.claims,
            result: {
              index: parentIdx,
              charStart: start,
              charEnd: end,
              claims: subParse.claims.length,
              output_tokens: subTokens,
              output_truncated: subTrunc,
              elapsed_ms: subElapsed,
            },
          };
        },
      }));
    });

    // Build chunk jobs for the worker pool (normal pending + subdivide queue)
    const chunkJobs: WorkerPoolJob<{ claims: Claim[]; result: ChunkResult }>[] = normalPendingChunks.map((chunk) => ({
      id: `${memo.id}:${chunk.chunkIndex}`,
      label: `${memo.file_name} chunk ${chunk.chunkIndex + 1}/${chunks.length}`,
      execute: async () => {
        const chunkStart = Date.now();

        const llmBody = {
          model: SONNET_MODEL,
          max_tokens: 16_384,
          temperature: 0, // Deterministic extraction — no sampling variance
          system: CLAIMS_EXTRACTION_PROMPT,
          messages: [
            {
              role: "user",
              content: `## Document: ${memo.file_name} (chunk ${chunk.chunkIndex + 1}/${chunks.length})\n\nExtract all quantitative financial claims from this section:\n\n${chunk.text}`,
            },
          ],
        };

        let response: LLMResponse;
        if (options?.bypassHeadroom) {
          response = await ctx.integrations.ai.apiRequest(
            { method: "POST", path: "/v1/messages", body: llmBody },
            { response: MessageResponseSchema },
            { label: `ClaimsExtraction: ${memo.file_name} chunk ${chunk.chunkIndex + 1}/${chunks.length}` },
          );
        } else {
          response = await callLLMWithHeadroom(
            ctx,
            llmBody,
            `ClaimsExtraction: ${memo.file_name} chunk ${chunk.chunkIndex + 1}/${chunks.length}`,
            { pipelineStartTime, maxPerCallTimeout: 180_000, retries: 1 },
          );
        }

        const responseText = response.content[0]?.text ?? "";
        const parseResult = parseClaimsResponse(responseText, memo.file_name);
        const chunkTruncated = response.stop_reason === "max_tokens";
        const chunkTokens = response.usage.output_tokens;
        const chunkElapsed = Date.now() - chunkStart;

        if (chunkTruncated) {
          console.warn(
            `[ClaimsExtraction] CHUNK TRUNCATED: "${memo.file_name}" chunk ${chunk.chunkIndex + 1}/${chunks.length} ` +
            `(chars ${chunk.charStart}-${chunk.charEnd}) hit max_tokens (${chunkTokens} tokens). ` +
            `${parseResult.claims.length} claims recovered via repair.`
          );
        }

        console.log(
          `[ClaimsExtraction] "${memo.file_name}" chunk ${chunk.chunkIndex + 1}/${chunks.length}: ` +
          `${parseResult.claims.length} claims, ${chunkTokens} tokens, ${Math.round(chunkElapsed / 1000)}s` +
          `${chunkTruncated ? " [TRUNCATED]" : ""}`
        );

        // Detect silent loss: model generated substantial output but 0 valid claims survived parsing
        const parseRecoveredEmpty = parseResult.claims.length === 0 && chunkTokens > 500 && !parseResult.failed;
        if (parseRecoveredEmpty) {
          console.warn(
            `[ClaimsExtraction] SILENT LOSS: "${memo.file_name}" chunk ${chunk.chunkIndex + 1}/${chunks.length} ` +
            `produced ${chunkTokens} tokens but 0 valid claims. Raw response preserved for diagnosis.`
          );
        }

        const cr: ChunkResult = {
          index: chunk.chunkIndex,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          claims: parseResult.claims.length,
          output_tokens: chunkTokens,
          output_truncated: chunkTruncated,
          elapsed_ms: chunkElapsed,
          parse_recovered_empty: parseRecoveredEmpty || undefined,
        };

        // Notify cursor progress (pre-subdivide — cursor only, no claims persist)
        if (options?.onChunkProgress) {
          await options.onChunkProgress(memo.id, chunk.chunkIndex);
        }

        return { claims: parseResult.claims, result: cr };
      },
    }));

    // Run chunk pool with bounded concurrency (normal chunks + deferred subdivide sub-chunks)
    const allJobs = [...chunkJobs, ...subdivideJobs];
    const poolResult = await runWorkerPool(allJobs, { concurrency: CHUNK_CONCURRENCY });

    // Collect results in chunk-index order for determinism
    // For deferred subdivide: multiple sub-chunk results share the same parent index — merge them
    const settledByIndex: Map<number, { claims: Claim[]; result: ChunkResult }> = new Map();
    for (const r of poolResult.results) {
      if (r.status === "fulfilled" && r.value) {
        const { result, claims } = r.value;
        const existing = settledByIndex.get(result.index);
        if (existing && subdivideParentIndices.has(result.index)) {
          // Merge sub-chunk results into the parent entry
          existing.claims.push(...claims);
          existing.result.claims += result.claims;
          existing.result.output_tokens += result.output_tokens;
          existing.result.elapsed_ms += result.elapsed_ms;
          existing.result.charEnd = Math.max(existing.result.charEnd, result.charEnd);
          existing.result.charStart = Math.min(existing.result.charStart, result.charStart);
          if (result.output_truncated) existing.result.output_truncated = true;
        } else {
          settledByIndex.set(result.index, { claims: [...claims], result: { ...result } });
        }
      } else if (r.status === "rejected") {
        const chunkIdx = parseInt(r.job.id.split(":")[1], 10);
        console.error(`[ClaimsExtraction] Chunk ${chunkIdx} failed: ${r.reason}`);
      }
    }

    // --- Adaptive subdivide: re-extract truncated chunks at half size ---
    // Gate C: one halving only. Floor 2,000 chars — if a 2,000-char chunk
    // truncates, stop and report. Do not subdivide further.
    const MIN_SUBDIVIDE_CHARS = 2000;
    const MAX_SUBDIVIDE_DEPTH = 1;
    let subdividePass = 0;

    // DEFERRED SUBDIVIDE: if enabled, mark truncated chunks and skip inline subdivide.
    // The caller persists these results and processes them as pre-split sub-chunks
    // on the next invocation (fresh time budget).
    if (options?.deferSubdivide) {
      const truncatedIndices = [...settledByIndex.entries()]
        .filter(([_, v]) => v.result.output_truncated)
        .map(([idx, v]) => ({ idx, charStart: v.result.charStart, charEnd: v.result.charEnd }));

      for (const { idx, charStart, charEnd } of truncatedIndices) {
        const chunkWidth = charEnd - charStart;
        const halfWidth = Math.floor(chunkWidth / 2);
        const qualifies = halfWidth >= MIN_SUBDIVIDE_CHARS;
        const entry = settledByIndex.get(idx)!;
        entry.result.needs_subdivide = qualifies;
        if (qualifies) {
          console.log(
            `[ClaimsExtraction] DEFERRED SUBDIVIDE: chunk ${idx} (${chunkWidth} chars) → marked for subdivision on next invocation`
          );
        } else {
          console.warn(
            `[ClaimsExtraction] CANNOT SUBDIVIDE: chunk ${idx} (${chunkWidth} chars) — half (${halfWidth}) below floor ${MIN_SUBDIVIDE_CHARS}. Accepting truncation.`
          );
        }
      }
    } else {
      // INLINE SUBDIVIDE (original behavior for callers without cursor-based resume)
    while (subdividePass < MAX_SUBDIVIDE_DEPTH) {
      const truncatedIndices = [...settledByIndex.entries()]
        .filter(([_, v]) => v.result.output_truncated)
        .map(([idx, v]) => ({ idx, charStart: v.result.charStart, charEnd: v.result.charEnd }));

      if (truncatedIndices.length === 0) break;

      const chunkWidth = truncatedIndices[0].charEnd - truncatedIndices[0].charStart;
      const halfWidth = Math.floor(chunkWidth / 2);
      if (halfWidth < MIN_SUBDIVIDE_CHARS) {
        console.warn(
          `[ClaimsExtraction] ${truncatedIndices.length} chunks still truncated at ${chunkWidth} chars — ` +
          `half (${halfWidth}) below minimum ${MIN_SUBDIVIDE_CHARS}. Accepting truncation.`
        );
        break;
      }

      subdividePass++;
      console.log(
        `[ClaimsExtraction] Subdivide pass ${subdividePass}: ${truncatedIndices.length} truncated chunk(s) ` +
        `(${chunkWidth} chars) → splitting to ${halfWidth} chars each`
      );

      // Build sub-chunk jobs for all truncated chunks
      const subJobs: WorkerPoolJob<{ parentIdx: number; claims: Claim[]; results: ChunkResult[] }>[] =
        truncatedIndices.map(({ idx: parentIdx, charStart, charEnd }) => ({
          id: `subdivide:${parentIdx}`,
          label: `${memo.file_name} subdivide chunk ${parentIdx}`,
          execute: async () => {
            const midpoint = charStart + halfWidth;
            const subChunks = [
              { start: charStart, end: midpoint, text: text.slice(charStart, midpoint) },
              { start: midpoint, end: charEnd, text: text.slice(midpoint, charEnd) },
            ];

            const subResults: ChunkResult[] = [];
            const subClaims: Claim[] = [];

            for (let si = 0; si < subChunks.length; si++) {
              const sc = subChunks[si];
              const subStart = Date.now();

              const subBody = {
                model: SONNET_MODEL,
                max_tokens: 16_384,
                temperature: 0,
                system: CLAIMS_EXTRACTION_PROMPT,
                messages: [
                  {
                    role: "user",
                    content: `## Document: ${memo.file_name} (chunk ${parentIdx + 1}/${chunks.length}, sub-part ${si + 1}/2)\n\nExtract all quantitative financial claims from this section:\n\n${sc.text}`,
                  },
                ],
              };

              let subResp: LLMResponse;
              if (options?.bypassHeadroom) {
                subResp = await ctx.integrations.ai.apiRequest(
                  { method: "POST", path: "/v1/messages", body: subBody },
                  { response: MessageResponseSchema },
                  { label: `ClaimsExtraction: subdivide ${memo.file_name} chunk ${parentIdx + 1} sub ${si + 1}/2` },
                );
              } else {
                subResp = await callLLMWithHeadroom(
                  ctx, subBody,
                  `ClaimsExtraction: subdivide ${memo.file_name} chunk ${parentIdx + 1} sub ${si + 1}/2`,
                  { pipelineStartTime, maxPerCallTimeout: 180_000, retries: 1 },
                );
              }

              const subText = subResp.content[0]?.text ?? "";
              const subParse = parseClaimsResponse(subText, memo.file_name);
              const subTrunc = subResp.stop_reason === "max_tokens";
              const subTokens = subResp.usage.output_tokens;
              const subElapsed = Date.now() - subStart;

              if (subTrunc) {
                console.warn(
                  `[ClaimsExtraction] SUBDIVIDE STILL TRUNCATED: chunk ${parentIdx} sub ${si + 1}/2 ` +
                  `(${sc.end - sc.start} chars) → ${subParse.claims.length} claims, ${subTokens} tokens`
                );
              }

              subClaims.push(...subParse.claims);
              subResults.push({
                index: parentIdx,
                charStart: sc.start,
                charEnd: sc.end,
                claims: subParse.claims.length,
                output_tokens: subTokens,
                output_truncated: subTrunc,
                elapsed_ms: subElapsed,
              });
            }

            return { parentIdx, claims: subClaims, results: subResults };
          },
        }));

      const subPoolResult = await runWorkerPool(subJobs, { concurrency: CHUNK_CONCURRENCY });

      // Replace truncated parent results with subdivide results
      for (const r of subPoolResult.results) {
        if (r.status === "fulfilled" && r.value) {
          const { parentIdx, claims, results } = r.value;
          // Merge sub-results into a single entry with combined stats
          const combinedTokens = results.reduce((sum, sr) => sum + sr.output_tokens, 0);
          const combinedMs = results.reduce((sum, sr) => sum + sr.elapsed_ms, 0);
          const stillTruncated = results.some((sr) => sr.output_truncated);
          settledByIndex.set(parentIdx, {
            claims,
            result: {
              index: parentIdx,
              charStart: results[0].charStart,
              charEnd: results[results.length - 1].charEnd,
              claims: claims.length,
              output_tokens: combinedTokens,
              output_truncated: stillTruncated,
              elapsed_ms: combinedMs,
            },
          });
        }
      }
    }
    } // end else (inline subdivide)

    // Process in index order — accumulate and fire onChunkComplete
    const sortedIndices = [...settledByIndex.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const { claims, result: cr } = settledByIndex.get(idx)!;
      allChunkClaims.push(...claims);
      chunkResults.push(cr);
      totalOutputTokens += cr.output_tokens;
      if (cr.output_truncated) anyTruncated = true;

      // Fire persistence callback
      if (options?.onChunkComplete) {
        await options.onChunkComplete({
          memoId: memo.id,
          memoFileName: memo.file_name,
          chunkIndex: idx,
          chunkClaims: claims,
          chunkResult: cr,
          accumulatedClaims: [...allChunkClaims],
          accumulatedChunkResults: [...chunkResults],
        });
      }
    }

    // Apply B3 coordinate dedup across chunks (overlap may produce duplicates)
    const dedupedClaims = deduplicateClaimsByCoordinate(allChunkClaims);

    console.log(
      `[ClaimsExtraction] "${memo.file_name}": ${allChunkClaims.length} raw claims → ${dedupedClaims.length} after dedup ` +
      `(${allChunkClaims.length - dedupedClaims.length} overlap duplicates removed). ` +
      `Total ${totalOutputTokens} output tokens.` +
      `${anyTruncated ? " [OUTPUT TRUNCATED]" : ""}${truncated ? " [INPUT TRUNCATED]" : ""}`
    );

    // --- skipQualitative gate ---
    let qualitativeClaims: CanonicalIcClaim[] = [];
    if (!options?.skipQualitative) {
      qualitativeClaims = await extractQualitativeFromMemo(
        ctx, memo, text, pipelineStartTime, options,
      );
      if (qualitativeClaims.length > 0) {
        console.log(`[ClaimsExtraction][Qualitative] "${memo.file_name}": ${qualitativeClaims.length} qualitative claims`);
      }
    } else {
      console.log(`[ClaimsExtraction][Qualitative] Skipped for "${memo.file_name}" (skipQualitative=true)`);
    }

    return {
      claims: dedupedClaims,
      qualitativeClaims,
      truncated,
      output_truncated: anyTruncated,
      output_tokens: totalOutputTokens,
      parseFailed: false,
      chunk_results: chunkResults,
    };
  };

  // Build job list for PENDING memos only (incremental — already-processed memos are retained)
  // Empty-text memos get explicit terminal records instead of being silently filtered
  const jobs: WorkerPoolJob<ExtractionResult>[] = pendingMemos.map((memo) => ({
    id: memo.id,
    label: memo.file_name,
    execute: async (): Promise<ExtractionResult> => {
      if (!memo.parsed_text || memo.parsed_text.trim().length === 0) {
        return { claims: [], qualitativeClaims: [], truncated: false, output_truncated: false, output_tokens: 0, parseFailed: true, parseError: `Empty or whitespace-only parsed_text for ${memo.file_name}` };
      }
      return extractMemo(memo);
    },
  }));

  // Budget predicate: stop launching when remaining time < reserve
  const canLaunch = (): boolean => {
    const elapsed = Date.now() - phaseStart;
    return elapsed + BUDGET_RESERVE_MS < timeBudgetMs;
  };

  // Run with bounded concurrency + budget gating
  // Memo-level concurrency = 1 (sequential) since chunks already run concurrently within
  const poolResult = await runWorkerPool(jobs, {
    concurrency: MEMO_CONCURRENCY,
    canLaunch: options?.bypassHeadroom ? undefined : canLaunch,
  });

  // Build terminal results and collect NEW claims from this invocation
  const newClaims: Claim[] = [];
  const newQualitativeClaims: CanonicalIcClaim[] = [];
  const newTerminals: TerminalResult[] = [];

  for (const r of poolResult.results) {
    if (r.status === "fulfilled") {
      const extraction = r.value!;
      newClaims.push(...extraction.claims);
      newQualitativeClaims.push(...extraction.qualitativeClaims);

      // Determine truthful terminal status
      let terminalStatus: TerminalStatus;
      if (extraction.parseFailed) {
        terminalStatus = "failed";
      } else if (extraction.truncated) {
        terminalStatus = "partial";
      } else {
        terminalStatus = "success";
      }

      newTerminals.push({
        memo_id: r.job.id,
        file_name: r.job.label,
        status: terminalStatus,
        claims_count: extraction.claims.length,
        output_truncated: extraction.output_truncated,
        output_tokens: extraction.output_tokens,
        error: extraction.parseError,
        chunk_results: extraction.chunk_results,
      });
    } else {
      const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // Detect timeout vs generic failure
      const isTimeout = errMsg.toLowerCase().includes("timeout") || errMsg.toLowerCase().includes("timed out");
      console.warn(`[ClaimsExtraction] Memo "${r.job.label}" ${isTimeout ? "timed out" : "failed"}: ${errMsg}`);
      newTerminals.push({
        memo_id: r.job.id,
        file_name: r.job.label,
        status: isTimeout ? "timed_out" : "failed",
        claims_count: 0,
        error: errMsg,
      });
    }
  }

  // Record pending memos (never launched due to budget) — includes both pool-pending
  // and memos beyond the maxWorkUnits cap that weren't even queued
  for (const p of poolResult.pending) {
    newTerminals.push({
      memo_id: p.job.id,
      file_name: p.job.label,
      status: "pending",
      claims_count: 0,
    });
  }

  // Also mark memos that were filtered out by maxWorkUnits but not in pendingMemos
  const queuedMemoIds = new Set(pendingMemos.map(m => m.id));
  for (const memo of memos) {
    if (!completedMemoIds.has(memo.id) && !queuedMemoIds.has(memo.id)) {
      newTerminals.push({
        memo_id: memo.id,
        file_name: memo.file_name,
        status: "pending",
        claims_count: 0,
      });
    }
  }

  // --- MERGE: Combine retained (prior invocations) + new (this invocation) ---
  // CRITICAL: Retained claims are NEVER deleted or reset.
  const rawAllClaims = [...retainedClaims, ...newClaims];
  const allTerminals = [...retainedTerminals, ...newTerminals];

  // --- B3: Code-level dedup on (metric, scope_qualifier, basis, period, value, unit) ---
  // Merges source_locations when the same figure is extracted multiple times.
  // This is a BACKSTOP for the prompt-level dedup (B2). Both are needed:
  //   - Prompt-level saves output tokens by not emitting duplicates
  //   - Code-level catches residual duplicates the model still emits
  // DO NOT conflate with the claim_id dedup at line ~865 (buildCanonicalLedger),
  // which keys on exact_text + page and is an idempotency guard.
  const allClaims = deduplicateClaimsByCoordinate(rawAllClaims);

  const docsProcessed = allTerminals.filter(r => r.status !== "pending").length;
  const pendingCount = allTerminals.filter(r => r.status === "pending").length;
  const isComplete = pendingCount === 0;
  const completedThisInvocation = newTerminals.filter(r => r.status !== "pending").length;

  const ledger: ClaimsLedger = {
    claims: allClaims,
    complete: isComplete,
    terminal_results: allTerminals,
    extraction_metadata: {
      docs_processed: docsProcessed,
      pending: pendingCount,
      completed_this_invocation: completedThisInvocation,
      total_claims: allClaims.length,
      operating_metric_claims: allClaims.filter(c => c.claim_category === "operating_metric").length,
      deal_mechanics_claims: allClaims.filter(c => c.claim_category === "deal_mechanics").length,
      valuation_structuring_claims: allClaims.filter(c => c.claim_category === "valuation_structuring").length,
      returns_projection_claims: allClaims.filter(c => c.claim_category === "returns_projection").length,
      cross_reference_claims: allClaims.filter(c => c.claim_category === "cross_reference").length,
      extraction_model: SONNET_MODEL,
      extraction_timestamp: new Date().toISOString(),
    },
  };

  console.log(
    `[ClaimsExtraction] ${isComplete ? "Complete" : "Incomplete (budget expired)"}: ` +
    `${allClaims.length} claims from ${docsProcessed}/${memos.length} memo(s) ` +
    `(${newClaims.length} new this invocation, ${retainedClaims.length} retained)` +
    `${pendingCount > 0 ? `, ${pendingCount} pending` : ""}. ` +
    `Elapsed: ${Math.round((Date.now() - phaseStart) / 1000)}s`
  );

  // --- MAT-F01: Convert to canonical claims with source validation ---
  // Build a memo text lookup for source validation
  const memoTextMap = new Map<string, string>();
  for (const memo of memos) {
    if (memo.parsed_text) {
      memoTextMap.set(memo.file_name, memo.parsed_text);
      memoTextMap.set(memo.id, memo.parsed_text);
    }
  }

  // Convert ALL claims to canonical format (both retained + new)
  const canonicalClaims: CanonicalIcClaim[] = [];
  for (const claim of allClaims) {
    const sourceText = memoTextMap.get(claim.source_doc) ?? "";
    // Derive document_id from memo lookup
    const matchedMemo = memos.find(m => m.file_name === claim.source_doc);
    const documentId = matchedMemo?.id ?? claim.source_doc;
    const documentName = claim.source_doc;

    // Derive memo version heuristic from filename
    const memoVersion = deriveMemoVersion(documentName);

    try {
      const canonical = fromLegacyClaim({
        legacyClaim: claim,
        document_id: documentId,
        document_name: documentName,
        memo_version: memoVersion,
        source_text: sourceText,
      });
      canonicalClaims.push(canonical);
    } catch (err) {
      // Non-fatal — skip claims that can't be converted
      console.warn(`[ClaimsExtraction][canonical] Failed to convert claim "${claim.metric}/${claim.scope_qualifier}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate by claim_id (deterministic — same source = same ID)
  // MAT-F01B: Include qualitative claims in the SAME canonical ledger
  // Correction 1: Retain prior qualitative claims from resumed ledger
  const priorQualitativeClaims: CanonicalIcClaim[] = priorLedger?.canonical_claims
    ? priorLedger.canonical_claims.filter(c => c.claim_type === "qualitative")
    : [];
  const allCanonicalWithQualitative = [...canonicalClaims, ...priorQualitativeClaims, ...newQualitativeClaims];
  const canonicalLedger = buildCanonicalLedger(allCanonicalWithQualitative);
  ledger.canonical_claims = canonicalLedger.claims;

  const qualCount = canonicalLedger.claims.filter(c => c.claim_type === "qualitative").length;
  const quantCount = canonicalLedger.claims.filter(c => c.claim_type === "quantitative").length;
  console.log(
    `[ClaimsExtraction][canonical] Converted ${allCanonicalWithQualitative.length} → ` +
    `${canonicalLedger.claims.length} unique canonical claims ` +
    `(${quantCount} quantitative, ${qualCount} qualitative, ` +
    `${canonicalLedger.claims.filter(c => c.source_validation.exact_text_found).length} source-validated)`
  );

  return ledger;
}

// ---------------------------------------------------------------------------
// MAT-F01B: Qualitative Extraction — live production path
// ---------------------------------------------------------------------------

/**
 * Extract qualitative propositions from a single IC memo.
 *
 * Uses the QUALITATIVE_EXTRACTION_PROMPT to find exact verbatim assertions about
 * strategic dependencies, operating assumptions, risk disclosures, mitigants, etc.
 *
 * Each qualitative claim is source-validated against the original memo text.
 * Invalid extractions (paraphrased, wrong coordinate, no exact text match) are rejected.
 *
 * Returns CanonicalIcClaim[] — these go directly into the same ledger as quantitative claims.
 */
async function extractQualitativeFromMemo(
  ctx: PipelineContext,
  memo: { id: string; file_name: string; parsed_text: string | null },
  text: string,
  pipelineStartTime: number,
  options?: ClaimsExtractionOptions,
): Promise<CanonicalIcClaim[]> {
  const llmBody = {
    model: SONNET_MODEL,
    max_tokens: 8_192,
    temperature: 0,
    system: QUALITATIVE_EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: `## Document: ${memo.file_name}\n\nExtract all qualitative propositions from this IC memo:\n\n${text}`,
      },
    ],
  };

  let response: LLMResponse;
  try {
    if (options?.bypassHeadroom) {
      response = await ctx.integrations.ai.apiRequest(
        { method: "POST", path: "/v1/messages", body: llmBody },
        { response: MessageResponseSchema },
        { label: `QualitativeExtraction: ${memo.file_name}` },
      );
    } else {
      response = await callLLMWithHeadroom(
        ctx,
        llmBody,
        `QualitativeExtraction: ${memo.file_name}`,
        { pipelineStartTime, maxPerCallTimeout: 120_000, retries: 1 },
      );
    }
  } catch (err) {
    console.warn(
      `[ClaimsExtraction][Qualitative] LLM call failed for "${memo.file_name}": ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const responseText = response.content[0]?.text ?? "";
  const rawResults = parseQualitativeResponse(responseText);
  if (rawResults.length === 0) return [];

  // Derive memo version for identity
  const memoVersion = deriveMemoVersion(memo.file_name);
  const sourceText = memo.parsed_text ?? "";

  // Convert to CanonicalIcClaim with source validation — fail closed on invalid
  const validClaims: CanonicalIcClaim[] = [];
  for (const raw of rawResults) {
    try {
      const claim = buildQualitativeClaim({
        document_id: memo.id,
        document_name: memo.file_name,
        memo_version: memoVersion,
        page_or_slide: raw.page_or_slide ?? "1",
        section: raw.section,
        exact_claim_text: raw.exact_text,
        entity: raw.entity,
        segment: raw.segment,
        qualitative_proposition: raw.qualitative_proposition,
        source_text: sourceText,
      });

      // FAIL CLOSED: Only admit source-validated claims
      if (!claim.source_validation.exact_text_found) {
        console.warn(
          `[ClaimsExtraction][Qualitative] Rejected (text not found): "${raw.exact_text.slice(0, 80)}..."`
        );
        continue;
      }
      if (!claim.source_validation.coordinate_valid) {
        console.warn(
          `[ClaimsExtraction][Qualitative] Rejected (invalid coordinate): "${raw.exact_text.slice(0, 80)}..."`
        );
        continue;
      }

      validClaims.push(claim);
    } catch (err) {
      console.warn(
        `[ClaimsExtraction][Qualitative] Build failed: "${raw.exact_text?.slice(0, 60) ?? "?"}" — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return validClaims;
}

/**
 * Parse qualitative extraction LLM response into structured records.
 */
function parseQualitativeResponse(responseText: string): Array<{
  exact_text: string;
  page_or_slide: string | number | null;
  section?: string;
  entity: string | null;
  segment: string | null;
  qualitative_proposition: string;
  category: string;
}> {
  let jsonStr = responseText.trim();
  if (!jsonStr) return [];

  // Strip markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Attempt repair for truncated JSON
    const lastObj = jsonStr.lastIndexOf("}");
    if (lastObj > 0) {
      try {
        parsed = JSON.parse(jsonStr.slice(0, lastObj + 1) + "]");
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  const rawArray = Array.isArray(parsed) ? parsed :
    (parsed && typeof parsed === "object" && "claims" in (parsed as any) && Array.isArray((parsed as any).claims))
      ? (parsed as any).claims : null;

  if (!rawArray) return [];

  const results: Array<{
    exact_text: string;
    page_or_slide: string | number | null;
    section?: string;
    entity: string | null;
    segment: string | null;
    qualitative_proposition: string;
    category: string;
  }> = [];

  for (const item of rawArray) {
    if (!item || typeof item !== "object") continue;
    const exactText = (item as any).exact_text;
    const proposition = (item as any).qualitative_proposition;
    if (!exactText || typeof exactText !== "string" || exactText.trim().length === 0) continue;
    if (!proposition || typeof proposition !== "string" || proposition.trim().length === 0) continue;

    results.push({
      exact_text: exactText,
      page_or_slide: (item as any).page_or_slide ?? null,
      section: (item as any).section ?? undefined,
      entity: (item as any).entity ?? null,
      segment: (item as any).segment ?? null,
      qualitative_proposition: proposition,
      category: (item as any).category ?? "strategic_assertion",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Response parser — robust to LLM formatting quirks
// ---------------------------------------------------------------------------

export interface ParseClaimsResult {
  claims: Claim[];
  failed: boolean;
  error?: string;
}

export function parseClaimsResponse(responseText: string, sourceFile: string): ParseClaimsResult {
  let jsonStr = responseText.trim();

  if (!jsonStr || jsonStr.length === 0) {
    return { claims: [], failed: true, error: `Empty response from LLM for ${sourceFile}` };
  }

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "");
  }

  // Handle case where LLM wraps in { "claims": [...] }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Attempt repair: if JSON array was truncated by max_tokens, find last complete object
    const lastCompleteObj = jsonStr.lastIndexOf("}");
    if (lastCompleteObj > 0) {
      const repaired = jsonStr.slice(0, lastCompleteObj + 1) + "]";
      try {
        parsed = JSON.parse(repaired);
        console.warn(`[ClaimsExtraction] Repaired truncated JSON for ${sourceFile} (cut at char ${lastCompleteObj + 1})`);
      } catch {
        console.warn(`[ClaimsExtraction] JSON parse failed for ${sourceFile} — repair also failed. First 500 chars: ${jsonStr.slice(0, 500)}`);
        return { claims: [], failed: true, error: `JSON parse failed for ${sourceFile} — repair also failed` };
      }
    } else {
      console.warn(`[ClaimsExtraction] JSON parse failed for ${sourceFile}. First 500 chars: ${jsonStr.slice(0, 500)}`);
      return { claims: [], failed: true, error: `JSON parse failed for ${sourceFile}` };
    }
  }

  let rawArray: unknown[];
  if (Array.isArray(parsed)) {
    rawArray = parsed;
  } else if (parsed && typeof parsed === "object" && "claims" in parsed && Array.isArray((parsed as any).claims)) {
    rawArray = (parsed as any).claims;
  } else {
    console.warn(`[ClaimsExtraction] Unexpected response structure for ${sourceFile}: ${typeof parsed}`);
    return { claims: [], failed: true, error: `Unexpected response structure for ${sourceFile}: ${typeof parsed}` };
  }

  // Validate each claim individually (don't let one bad claim kill the batch)
  const validClaims: Claim[] = [];
  for (const raw of rawArray) {
    try {
      // Pre-validation coercion: period null → "UNDATED"
      // The LLM sometimes returns null for claims with no temporal reference
      // (TAM figures, market share, etc.). The schema requires a string.
      const coerced = { ...raw as object };
      if ((coerced as any).period === null || (coerced as any).period === undefined) {
        (coerced as any).period = "UNDATED";
      }
      // Ensure source_doc is set correctly (LLM may omit or misname)
      const withSource = { ...coerced, source_doc: sourceFile };
      const claim = ClaimSchema.parse(withSource);
      validClaims.push(claim);
    } catch {
      // Log but don't fail — partial extraction is better than none
      const label = (raw as any)?.metric ?? "unknown";
      const snippet = (raw as any)?.verbatim_snippet?.slice(0, 60) ?? "";
      console.warn(`[ClaimsExtraction] Skipped invalid claim (${label}): "${snippet}..."`);
    }
  }

  return { claims: validClaims, failed: false };
}

// ---------------------------------------------------------------------------
// Memo version derivation from filename
// ---------------------------------------------------------------------------

/**
 * Derive memo version from document filename.
 * Used for canonical claim identity — must be deterministic.
 */
function deriveMemoVersion(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("3rd") || lower.includes("third")) return "3rd_ic";
  if (lower.includes("2nd") || lower.includes("second")) return "2nd_ic";
  if (lower.includes("1st") || lower.includes("first")) return "1st_ic";
  if (lower.includes("update")) return "ic_update";
  if (lower.includes("screening")) return "screening";
  if (lower.includes("cim")) return "cim";
  return "ic_memo";
}
