/**
 * Shared Universal Extraction prompt and helpers.
 *
 * Used by:
 *  - server/apis/modules/universal-extract.ts (single-chunk API called from browser)
 *  - server/apis/pipeline/pipeline-core.ts (inline extraction phase for server-side runs)
 */

// ---------------------------------------------------------------------------
// Universal Extraction Prompt
//
// This single prompt consolidates the extraction needs of ALL 8 analysis
// modules. Each chunk is processed ONCE instead of 8 times. The per-module
// merge prompts then receive the relevant sections of this extraction.
// ---------------------------------------------------------------------------
export const UNIVERSAL_EXTRACTION_PROMPT = `You are a senior private equity due diligence analyst performing a comprehensive extraction on a document chunk from a deal data room. You must extract ALL information relevant to investment committee (IC) review in a single pass.

You will receive extracted text from a document chunk. Analyse the text thoroughly — pay close attention to tables, lists, and structured data that may have been flattened during PDF text extraction.

## Extraction Framework

Extract everything relevant across ALL of the following dimensions simultaneously. Be comprehensive — downstream analysis modules depend on the completeness of your extraction.

### 1. Document Classification
- Document type (CIM, IC_MEMO, CUSTOMER_DATA, CONSULTANT_REPORT, FINANCIAL_MODEL, LEGAL, OTHER)
- Source perspective (deal_team, management, third_party, unclear)

### 2. Key Claims & Assertions
For each claim found, capture:
- The claim itself (precise statement)
- Claim type: "thesis" | "risk_mitigant" | "explicit_assumption" | "implicit_assumption" | "narrative" | "data_point" | "weak_point"
- Source type: "narrative" (CIM, IC memo, management presentation) or "data" (financial model, customer data, consultant report, QoE)
- Location within the document (section, page, table name)
- Confidence in your extraction accuracy ("high" | "medium" | "low")
- Which PE diligence dimension it relates to: "commercial" | "financial" | "management" | "technology" | "legal" | "competitive" | "customer" | "operational" | "exit" | "esg" | "multiple"

### 3. Quantitative Data Points
For each metric/data point:
- Metric name
- Value (exact figure)
- Context (why this matters)
- Category: "revenue" | "margin" | "customer" | "cost" | "capital" | "financing" | "entry_exit" | "returns" | "operational" | "other"
- Whether stated explicitly or derived
- Perspective: "deal_team" | "management" | "unclear"
- Scope qualifier (required, never null): the cohort, time window, scenario, or perimeter the value applies to. Record the scope exactly as the source states it — do not normalise, do not invent, do not infer a scope that is not written. Scope qualifiers frequently appear in footnotes, table headers, column labels, and parentheticals — not in the sentence containing the number. Look for them there. If the source states no scope for this figure, emit "NONE_STATED". If scope is meaningless for the fact (e.g. a founding date, a person's name), emit "UNSCOPED_BY_NATURE". Keep scope text brief but do not cap word count.
  NONE_STATED and UNSCOPED_BY_NATURE are exclusive values. Emit one of them as the ENTIRE field value, or do not use them at all. Never append them to descriptive scope text. Never combine them with other words. Never create variants such as NONE_STATED_GEOGRAPHY. If you have any scope information at all, record that information alone and do not add a sentinel.

### 4. Flags & Risks
For each flag identified:
- Type: "risk" | "gap" | "contradiction" | "assumption" | "omission"
- Description (direct statement of the issue)
- Severity: "critical" | "moderate" | "low"
- Adviser severity: "high" | "medium" | "low" | null. Emit the rating ONLY when the source explicitly assigns a priority/severity/materiality grade to this flag. Do not synthesise a rating that was not assigned. Null when the document does not rate the flag.
- Adviser disposition (string or null): the adviser's stated recommendation or stance toward the flag, in their own words. Examples: "For information only", "We recommend that the Group obtains a confirmatory deed of assignment", "we expect that the risk of enforcement is low". Null when the source offers no recommendation.

Structured diligence findings
Legal and financial DD reports commonly present each finding in a fixed four-part structure:
    Concern              — what the issue is
    Potential Impact     — the risk, AND the mitigating factors
    Suggested Resolution — the adviser's recommendation, often "For information only"
    Severity             — a High / Medium / Low priority indicator

When extracting from such a document, capture ALL FOUR parts. The severity rating and the suggested resolution are as material as the concern itself.

Do NOT extract the risk statement in isolation. Where the Potential Impact section lists mitigating factors or concludes that the risk is low, capture that conclusion — it is part of the finding, not commentary on it.

### 5. Omissions & Missing Information
- Missing data, sections, time periods, benchmarks, or risk factors that should be present
- Cross-reference against PE checklist: customer concentration, churn/retention, key man risk, revenue recognition, regulatory exposure, competitive response, management incentives, exit assumptions, QoE items, capex requirements

### 6. Competitive & Market Context
- Named competitors and positioning claims
- Market size/TAM figures and their basis
- Industry trend narratives

### 7. Management & Leadership
- Named individuals, titles, background claims
- Key person dependencies
- Retention arrangements

### 8. Customer & Revenue Details
- Named customers, concentration data
- Contract durations, churn/retention figures
- NPS, CSAT, or satisfaction scores

### 9. Reputation & Social Signals
- Social media or web presence references
- Employee/culture claims (headcount, satisfaction, Glassdoor mentions)
- Brand/marketing claims
- Any acknowledged reputation risks

### 10. Legal & Regulatory
- Compliance status, pending litigation
- Regulatory risk, licensing requirements

## Output Rules

Return ONLY a valid JSON object. No text before or after.

Be precise and dense — every word should carry information:
- Each claim should be a single clear statement — no filler, no restating context.
- "claim" states WHAT is claimed. "location" states WHERE. Do not repeat one in the other.
- "description" in flags states the gap directly — do not explain why it matters.

Required top-level keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "source_perspective" (string): deal_team | management | third_party | unclear
- "key_claims" (array): each with "id" (leave as empty string — will be assigned post-extraction), "claim", "claim_type", "source_type", "location", "confidence", "dimension"
- "data_points" (array): each with "metric", "value", "context", "scope_qualifier" (string, required, never null), "category", "stated_or_derived", "perspective"
- "flags" (array): each with "type", "description", "severity", "adviser_severity" ("high" | "medium" | "low" | null), "adviser_disposition" (string or null)
- "omissions" (array of strings): missing items relative to PE diligence standards
- "competitive_market" (array): each with "claim", "named_competitors" (string[]), "figures_cited" (string or null)
- "management_leadership" (array): each with "name", "title", "background_claims" (string or null), "retention_detail" (string or null)
- "customer_revenue" (array): each with "customer" (string or null), "revenue_share" (string or null), "contract_detail" (string or null), "metric_cited" (string or null)
- "reputation_social" (array): each with "claim", "platform_or_source" (string or null), "metric_cited" (string or null)
- "legal_regulatory" (array): each with "topic", "detail"
- "stated_risks" (array): each with "risk", "mitigant_offered" (string or null)
- "raw_summary" (string): 3-4 dense sentences covering the most material findings`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject stable, globally unique claim IDs into the extraction JSON.
 *
 * PRODUCTION FORMAT: "{documentId}:{chunkIndex}:{claimIndex}" (0-based).
 * This is deterministic (based only on stable document identity + position)
 * and collision-free across documents.
 *
 * @param documentId REQUIRED in production paths. Must be a non-empty canonical UUID.
 * @throws Error if documentId is missing (production must not generate legacy IDs)
 * @throws Error if the extraction cannot be parsed as JSON (fail-closed: never return unparsed text)
 *
 * This happens post-extraction so IDs are deterministic and don't depend on
 * the model remembering to output them.
 */
export function injectClaimIds(rawJson: string, chunkIndex: number, documentId: string): string {
  if (!documentId) {
    throw new Error(
      "[injectClaimIds] documentId is REQUIRED for production claim ID generation. " +
      "Use injectClaimIdsLegacy() for backward-compatible legacy format."
    );
  }

  let jsonStr = rawJson.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    throw new Error(
      `[injectClaimIds] Failed to parse extraction JSON for chunk ${chunkIndex} ` +
      `(documentId: ${documentId}). The model returned unparseable output. ` +
      `Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
      `First 200 chars: "${rawJson.slice(0, 200)}"`
    );
  }

  if (Array.isArray(parsed.key_claims)) {
    parsed.key_claims = (parsed.key_claims as Record<string, unknown>[]).map(
      (claim, idx) => ({
        ...claim,
        id: `${documentId}:${chunkIndex}:${idx}`,
      })
    );
  }
  return JSON.stringify(parsed);
}

/**
 * LEGACY COMPATIBILITY HELPER — generates document-local IDs (c{N}-{M}).
 *
 * DEPRECATED: Produces IDs that collide across documents and cause incorrect
 * provenance when decoded against the global routed array.
 *
 * Only use in test utilities that explicitly exercise legacy behavior.
 * Production extraction paths MUST use injectClaimIds() with a documentId.
 */
export function injectClaimIdsLegacy(rawJson: string, chunkIndex: number): string {
  try {
    let jsonStr = rawJson.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "");
    }

    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed.key_claims)) {
      parsed.key_claims = parsed.key_claims.map(
        (claim: Record<string, unknown>, idx: number) => ({
          ...claim,
          id: `c${chunkIndex}-${idx}`,
        })
      );
    }
    return JSON.stringify(parsed);
  } catch {
    return rawJson;
  }
}

/**
 * Replace curly braces with fullwidth equivalents to avoid template injection.
 */
export function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

// ---------------------------------------------------------------------------
// Spreadsheet detection (matches pipelineConfig.ts on the client)
// ---------------------------------------------------------------------------
const SPREADSHEET_FILE_PATTERN = /\.(xlsx|xls|xlsm|csv)$/i;

export function isSpreadsheetFile(fileName: string): boolean {
  return SPREADSHEET_FILE_PATTERN.test(fileName);
}

// ---------------------------------------------------------------------------
// Content hashing (same algorithm as client)
// ---------------------------------------------------------------------------
export function computeContentHash(text: string): string {
  // Simple fast hash — same as the client's computeContentHash
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Extraction settings (single source of truth for server-side extraction)
// ---------------------------------------------------------------------------

/** Claude model used for universal extraction. */
export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

/** Number of concurrent LLM extraction calls per batch. */
export const EXTRACTION_CONCURRENCY = 8; // Reduced from 12 to limit account-level rate-limit pressure

// ---------------------------------------------------------------------------
// Chunking
// ⚠️  KEEP IN SYNC with client/lib/pipelineConfig.ts CHUNK_CHARS.
//     Client and server cannot share an import across the build boundary.
//     If these diverge, chunk-index mismatches corrupt the extraction cache.
// ---------------------------------------------------------------------------
export const CHUNK_CHARS = 5_000;

export interface TextChunk {
  label: string;
  sourceFile: string;
  text: string;
  documentId: string;
  chunkIndex: number;
  contentHash: string;
}

/**
 * Split a document's parsed_text into fixed-size chunks (no overlap).
 * Used by the production extraction pipeline — do NOT change stride logic.
 */
export function chunkDocument(
  fileName: string,
  documentId: string,
  parsedText: string
): TextChunk[] {
  const chunks: TextChunk[] = [];
  if (parsedText.length <= CHUNK_CHARS) {
    chunks.push({
      label: fileName,
      sourceFile: fileName,
      text: parsedText,
      documentId,
      chunkIndex: 0,
      contentHash: computeContentHash(parsedText),
    });
  } else {
    let start = 0;
    let idx = 0;
    while (start < parsedText.length) {
      const end = Math.min(start + CHUNK_CHARS, parsedText.length);
      const slice = parsedText.slice(start, end);
      chunks.push({
        label: `${fileName} (part ${idx + 1})`,
        sourceFile: fileName,
        text: slice,
        documentId,
        chunkIndex: idx,
        contentHash: computeContentHash(slice),
      });
      start = end;
      idx++;
    }
  }
  return chunks;
}

/**
 * Split a document's parsed_text into fixed-size chunks with optional overlap.
 * Overlap ensures figures near chunk boundaries appear in both adjacent chunks,
 * allowing downstream dedup to collapse duplicates.
 *
 * Default overlap = 0 (backward compatible with chunkDocument behavior).
 * Default chunkSize = CHUNK_CHARS (5000). Pass a smaller value for dense memos.
 * Each chunk records its char_start and char_end for diagnostic reporting.
 */
export function chunkDocumentWithOverlap(
  fileName: string,
  documentId: string,
  parsedText: string,
  options?: { overlap?: number; chunkSize?: number }
): (TextChunk & { charStart: number; charEnd: number })[] {
  const chunkSize = options?.chunkSize ?? CHUNK_CHARS;
  const overlap = options?.overlap ?? 0;
  const stride = chunkSize - overlap;
  if (stride <= 0) throw new Error(`overlap (${overlap}) must be less than chunkSize (${chunkSize})`);

  const chunks: (TextChunk & { charStart: number; charEnd: number })[] = [];

  if (parsedText.length <= chunkSize) {
    chunks.push({
      label: fileName,
      sourceFile: fileName,
      text: parsedText,
      documentId,
      chunkIndex: 0,
      contentHash: computeContentHash(parsedText),
      charStart: 0,
      charEnd: parsedText.length,
    });
  } else {
    let start = 0;
    let idx = 0;
    while (start < parsedText.length) {
      const end = Math.min(start + chunkSize, parsedText.length);
      const slice = parsedText.slice(start, end);
      chunks.push({
        label: `${fileName} (part ${idx + 1})`,
        sourceFile: fileName,
        text: slice,
        documentId,
        chunkIndex: idx,
        contentHash: computeContentHash(slice),
        charStart: start,
        charEnd: end,
      });
      start += stride;
      idx++;
    }
  }
  return chunks;
}
