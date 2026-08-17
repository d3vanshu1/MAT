/**
 * Extract Canonical Claims — MAT-F01
 *
 * Production claim extraction path that captures:
 *  - Numeric assertions (revenue, EBITDA, margins, costs)
 *  - Forecasts and historical statements
 *  - Valuation and returns assertions
 *  - Operating assumptions
 *  - Strategic assertions
 *  - Risk disclosures
 *  - Legal or contractual assertions
 *  - Claimed mitigants
 *  - Claims of sufficiency, absence, dependence, or support
 *
 * This is the unified extractor that produces CanonicalIcClaim records for both
 * quantitative and qualitative propositions, enforcing exact source validation.
 */

import {
  type CanonicalIcClaim,
  IC_CLAIM_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  fromLegacyClaim,
  buildQualitativeClaim,
  validateClaimSource,
  buildClaimLedger,
  type CanonicalClaimLedger,
} from "./canonical-ic-claim.js";

// ---------------------------------------------------------------------------
// Qualitative Extraction Categories
// ---------------------------------------------------------------------------

export const QUALITATIVE_CATEGORIES = [
  "strategic_assertion",        // Growth quality, M&A strategy, market position
  "operating_assumption",       // Key operating dependencies, revenue concentration
  "risk_disclosure",            // Identified risks, customer concentration, churn
  "valuation_returns_assertion",// Returns supported by model, valuation basis
  "contractual_legal",          // Legal obligations, contract quality, IP
  "dependence_assertion",       // Deleveraging depends on M&A, organic growth depends on X
  "sufficiency_absence_claim",  // Baseline disclosed/not disclosed, data available/not available
  "mitigant_claim",             // Risks mitigated by X, concentration offset by Y
] as const;

export type QualitativeCategory = typeof QUALITATIVE_CATEGORIES[number];

// ---------------------------------------------------------------------------
// Extraction input/output types
// ---------------------------------------------------------------------------

export interface MemoSource {
  document_id: string;
  document_name: string;
  memo_version: string;
  parsed_text: string;
}

export interface ExtractionOutput {
  claims: CanonicalIcClaim[];
  ledger: CanonicalClaimLedger;
  extraction_metadata: {
    docs_processed: number;
    quantitative_claims: number;
    qualitative_claims: number;
    valid_claims: number;
    invalid_claims: number;
    extractor_version: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Qualitative claim extraction prompt (for LLM-based extraction)
// ---------------------------------------------------------------------------

export const QUALITATIVE_EXTRACTION_PROMPT = `You are extracting QUALITATIVE propositions from an IC memo.

Your job: Extract every qualitative assertion that states a substantive proposition about the target company, deal, or investment thesis.

## WHAT TO EXTRACT

Extract EXACT VERBATIM sentences that assert:
1. **Strategic assertions** — growth quality, market position, organic vs M&A-driven growth
2. **Operating assumptions** — key dependencies, revenue quality, customer dynamics
3. **Risk disclosures** — concentration risks, churn, technology risks, regulatory
4. **Valuation/returns assertions** — returns supported by model, valuation basis
5. **Contractual/legal** — contract quality, IP protection, lease terms
6. **Dependence claims** — "X depends on Y", "growth requires Z"
7. **Sufficiency/absence** — "baseline is/is not disclosed", "model is/is not available"
8. **Mitigant claims** — "risk is offset by X", "concentration mitigated by Y"

## CRITICAL RULES

1. **EXACT VERBATIM TEXT ONLY** — The \`exact_text\` field must be the EXACT sentence or phrase from the memo. Do NOT paraphrase, summarize, or rewrite.
2. **One proposition per entry** — If a sentence contains multiple propositions, extract each separately but use the same exact_text.
3. **Skip purely numeric claims** — Those are handled by the quantitative extractor. Only extract qualitative propositions here.
4. **Include source coordinates** — page/section where the text appears.
5. **Entity identification** — Identify the target entity (company name, "Group", segment name).

## OUTPUT FORMAT

Return a JSON array:
[
  {
    "exact_text": "<EXACT verbatim sentence from the memo>",
    "page_or_slide": "<page number or section>",
    "section": "<section heading if identifiable>",
    "entity": "<target entity name or null>",
    "segment": "<segment if applicable or null>",
    "qualitative_proposition": "<normalized one-sentence proposition>",
    "category": "strategic_assertion" | "operating_assumption" | "risk_disclosure" | "valuation_returns_assertion" | "contractual_legal" | "dependence_assertion" | "sufficiency_absence_claim" | "mitigant_claim"
  }
]

Return ONLY the JSON array. No markdown fences, no commentary.`;

// ---------------------------------------------------------------------------
// Core extraction function (operates on pre-extracted claims + source text)
// ---------------------------------------------------------------------------

/**
 * Extract canonical claims from a set of IC memos.
 * 
 * This function:
 * 1. Takes existing quantitative claims (from claims-extraction.ts pipeline)
 * 2. Takes qualitative extraction results (from LLM)
 * 3. Validates all claims against source text
 * 4. Produces a unified CanonicalClaimLedger
 *
 * @param memos - IC memo documents with parsed text
 * @param quantitativeClaims - Pre-extracted quantitative claims from existing pipeline
 * @param qualitativeResults - Raw qualitative extraction results from LLM
 */
export function buildCanonicalLedgerFromExtractions(params: {
  memos: MemoSource[];
  quantitativeClaims: Array<{
    metric: string;
    scope_qualifier: string;
    period: string;
    value: number;
    unit: string;
    basis: string | null;
    scenario: string | null;
    basis_note: string;
    source_doc: string;
    source_page: string | null;
    verbatim_snippet: string;
    claim_category: string;
  }>;
  qualitativeResults: Array<{
    document_id: string;
    document_name: string;
    memo_version: string;
    exact_text: string;
    page_or_slide: number | string;
    section?: string;
    entity: string | null;
    segment: string | null;
    qualitative_proposition: string;
    category: QualitativeCategory;
  }>;
}): ExtractionOutput {
  const { memos, quantitativeClaims, qualitativeResults } = params;
  const allClaims: CanonicalIcClaim[] = [];

  // Build memo lookup
  const memoByName = new Map<string, MemoSource>();
  const memoById = new Map<string, MemoSource>();
  for (const memo of memos) {
    memoByName.set(memo.document_name.toLowerCase(), memo);
    memoById.set(memo.document_id, memo);
  }

  // --- Convert quantitative claims ---
  let quantCount = 0;
  for (const legacyClaim of quantitativeClaims) {
    // Find the matching memo
    const memoKey = legacyClaim.source_doc.toLowerCase();
    const memo = memoByName.get(memoKey) || [...memoByName.values()].find(m =>
      m.document_name.toLowerCase().includes(memoKey) ||
      memoKey.includes(m.document_name.toLowerCase())
    );

    if (!memo) continue; // Cannot validate without source text

    const canonical = fromLegacyClaim({
      legacyClaim,
      document_id: memo.document_id,
      document_name: memo.document_name,
      memo_version: memo.memo_version,
      source_text: memo.parsed_text,
    });

    allClaims.push(canonical);
    quantCount++;
  }

  // --- Convert qualitative claims ---
  let qualCount = 0;
  for (const qualResult of qualitativeResults) {
    const memo = memoById.get(qualResult.document_id);
    const sourceText = memo?.parsed_text ?? "";

    const canonical = buildQualitativeClaim({
      document_id: qualResult.document_id,
      document_name: qualResult.document_name,
      memo_version: qualResult.memo_version,
      page_or_slide: qualResult.page_or_slide,
      section: qualResult.section,
      exact_claim_text: qualResult.exact_text,
      entity: qualResult.entity,
      segment: qualResult.segment,
      qualitative_proposition: qualResult.qualitative_proposition,
      source_text: sourceText,
    });

    allClaims.push(canonical);
    qualCount++;
  }

  // --- Build ledger (deduplicates by claim_id) ---
  const ledger = buildClaimLedger(allClaims);

  // --- Compute validation stats ---
  const validClaims = ledger.claims.filter(c =>
    c.source_validation.exact_text_found && c.source_validation.coordinate_valid
  );
  const invalidClaims = ledger.claims.filter(c =>
    !c.source_validation.exact_text_found || !c.source_validation.coordinate_valid
  );

  return {
    claims: ledger.claims,
    ledger,
    extraction_metadata: {
      docs_processed: memos.length,
      quantitative_claims: quantCount,
      qualitative_claims: qualCount,
      valid_claims: validClaims.length,
      invalid_claims: invalidClaims.length,
      extractor_version: EXTRACTOR_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
}
