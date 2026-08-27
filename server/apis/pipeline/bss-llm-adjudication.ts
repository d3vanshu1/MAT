/**
 * BSS v2 — Adjudication mechanism (Reference Spec implementation).
 *
 * Four stages per candidate:
 *   Stage 2 — Retrieve widely (FTS, over-fetch, two scopes)
 *   Stage 3a — Coverage adjudication (LLM + anti-fabrication)
 *   Stage 3b — Dependency adjudication (LLM + anti-fabrication)
 *   Stage 4 — Compose disposition (code only, no judgment)
 *
 * Design principles:
 *   - Retrieval gathers evidence, the LLM judges meaning, code composes.
 *   - No verdict of coverage or reliance without a verbatim quote.
 *   - Every quote code-verified as a substring of what was supplied.
 *   - A failed substring check downgrades to the safe verdict and logs.
 *   - Absence always means "absent from what was retrieved" — never absolute.
 *
 * pgvector: NOT installed in this Postgres. FTS-only mode.
 * All "absent" verdicts carry the standing caveat that retrieval may have
 * missed differently-worded coverage.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-ADJUDICATE]";

// ---------------------------------------------------------------------------
// Retrieval constants
// ---------------------------------------------------------------------------

/** Max chunks per candidate per scope after dedup + ranking. Generous — over-fetch. */
const MAX_CHUNKS_COVERAGE = 12;
const MAX_CHUNKS_DEPENDENCY = 12;

/** Max FTS results per query before ranking (per scope). */
const MAX_HITS_PER_QUERY = 20;

/** LLM max output tokens. */
const MAX_OUTPUT_TOKENS = 1024;

// ---------------------------------------------------------------------------
// IC memo document IDs — CORRECT values
// ---------------------------------------------------------------------------

const IC_MEMO_DOC_IDS = [
  "8fb7f474-9adf-4c02-b991-e180359812ea", // 2nd IC Memo
  "31b3df2f-1653-42e5-8ad1-e58ab74e0399", // 3rd IC Memo
  "6197a6b2-a26c-423a-84b3-2766b0710b10", // IC Update
  "440a86fb-93d6-4fd6-8d42-32f7047f8958", // Screening Memo
];
const LATEST_MEMO_DOC_IDS = [
  "31b3df2f-1653-42e5-8ad1-e58ab74e0399", // 3rd IC Memo
  "6197a6b2-a26c-423a-84b3-2766b0710b10", // IC Update
];

// ---------------------------------------------------------------------------
// Caveat (FTS-only mode)
// ---------------------------------------------------------------------------

const FTS_ONLY_CAVEAT =
  "Retrieval was FTS-only (no semantic/embedding search). " +
  "Absent verdicts carry the standing caveat that retrieval may have missed " +
  "differently-worded coverage.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseForFts(q: string): string {
  return q.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/** Collapse whitespace for substring matching. */
function normaliseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const CandidateSchema = z.object({
  candidate_id: z.string(),
  failure_mode: z.string(),
  pass_type: z.string(),
  implied_assumption: z.string(),
  hypothesis: z.string(),
  proposed_queries: z.any(),
});

const ChunkHitSchema = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  rank: z.coerce.number(),
  query_idx: z.coerce.number(),
});

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DbClient = {
  query: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]>;
  execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any>;
};
type AiClient = {
  apiRequest: (
    req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
    opts: { response: any },
    meta?: { label: string },
  ) => Promise<any>;
};

/** A retrieved chunk with its source metadata. */
interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  file_name: string;
  chunk_index: number;
  content: string;
  rank: number;
}

/** Stage 2 output — chunk sets per scope, no verdicts. */
export interface RetrievalResult {
  coverageChunks: RetrievedChunk[];
  dependencyChunks: RetrievedChunk[];
  coverageDocCount: number;
  dependencyDocCount: number;
}

/** Stage 3a output — coverage adjudication. */
export interface CoverageVerdict {
  verdict: "ADDRESSED" | "MENTIONED" | "ABSENT";
  quote: string | null;
  source_document: string | null;
  reason: string;
  overridden: boolean;
  overrideReason: string | null;
  chunksUsed: number;
}

/** Stage 3b output — dependency adjudication. */
export interface DependencyVerdict {
  verdict: "RELIED_UPON" | "INDEPENDENT";
  quote: string | null;
  source_memo: string | null;
  reason: string;
  overridden: boolean;
  overrideReason: string | null;
  chunksUsed: number;
}

/** Combined per-candidate row for orchestrator. */
export interface AdjudicationRow {
  candidate_id: string;
  failure_mode: string;
  pass_type: string;
  coverage: CoverageVerdict;
  dependency: DependencyVerdict | null; // null if ADDRESSED (skipped)
  retrievalSummary: {
    coverageChunks: number;
    coverageDocs: number;
    dependencyChunks: number;
    dependencyDocs: number;
  };
}

export interface DispositionResult {
  outcome: string;
  gate: string;
  reason: string;
  caveats: string[];
}

// ---------------------------------------------------------------------------
// LLM response parsers
// ---------------------------------------------------------------------------

function parseCoverageResponse(text: string): {
  verdict: string;
  quote: string;
  source_document: string;
  reason: string;
} {
  const upper = text.toUpperCase();
  let verdict = "MENTIONED"; // safe default

  if (upper.includes("ADDRESSED")) verdict = "ADDRESSED";
  else if (upper.includes("ABSENT")) verdict = "ABSENT";
  else if (upper.includes("MENTIONED")) verdict = "MENTIONED";

  // Extract quote
  let quote = "";
  const quotePatterns = [
    /[Qq]uote:\s*"([^"]+)"/,
    /[Qq]uote:\s*["""]([^"""]+)["""]/,
    /[Pp]assage:\s*"([^"]+)"/,
    /"([^"]{20,})"/,
    /["""]([^"""]{20,})["""]/,
  ];
  for (const pat of quotePatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      quote = m[1].trim();
      break;
    }
  }

  // Extract source document
  let source_document = "";
  const srcMatch = text.match(/[Ss]ource[_ ]?[Dd]ocument:\s*"?([^"\n]+)"?/);
  if (srcMatch) source_document = srcMatch[1].trim();

  // Extract reason
  let reason = "";
  const reasonMatch = text.match(/[Rr]eason(?:ing)?:\s*(.+)/s);
  if (reasonMatch) {
    reason = reasonMatch[1].trim().split("\n")[0].trim();
  } else {
    const lines = text.trim().split("\n").filter(l => l.trim().length > 0);
    if (lines.length > 0) reason = lines[lines.length - 1].trim();
  }

  return { verdict, quote, source_document, reason };
}

function parseDependencyResponse(text: string): {
  verdict: string;
  quote: string;
  source_memo: string;
  reason: string;
} {
  const upper = text.toUpperCase();
  let verdict = "INDEPENDENT"; // safe default

  if (upper.includes("RELIED_UPON") || upper.includes("RELIED UPON")) verdict = "RELIED_UPON";
  else if (upper.includes("INDEPENDENT")) verdict = "INDEPENDENT";

  // Extract quote
  let quote = "";
  const quotePatterns = [
    /[Qq]uote:\s*"([^"]+)"/,
    /[Qq]uote:\s*["""]([^"""]+)["""]/,
    /[Pp]assage:\s*"([^"]+)"/,
    /"([^"]{20,})"/,
    /["""]([^"""]{20,})["""]/,
  ];
  for (const pat of quotePatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      quote = m[1].trim();
      break;
    }
  }

  // Extract source memo
  let source_memo = "";
  const srcMatch = text.match(/[Ss]ource[_ ]?[Mm]emo:\s*"?([^"\n]+)"?/);
  if (srcMatch) source_memo = srcMatch[1].trim();

  // Extract reason
  let reason = "";
  const reasonMatch = text.match(/[Rr]eason(?:ing)?:\s*(.+)/s);
  if (reasonMatch) {
    reason = reasonMatch[1].trim().split("\n")[0].trim();
  } else {
    const lines = text.trim().split("\n").filter(l => l.trim().length > 0);
    if (lines.length > 0) reason = lines[lines.length - 1].trim();
  }

  return { verdict, quote, source_memo, reason };
}

// ---------------------------------------------------------------------------
// Anti-fabrication: verbatim substring check
// ---------------------------------------------------------------------------

/**
 * Verify a quote is a verbatim substring of the supplied chunks.
 * Returns true if the whitespace-normalised quote appears in any chunk.
 */
function verifyQuoteInChunks(quote: string, chunks: RetrievedChunk[]): boolean {
  if (!quote || quote.length < 10) return false;
  const normQuote = normaliseWs(quote);
  for (const chunk of chunks) {
    if (normaliseWs(chunk.content).includes(normQuote)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2 — Retrieve widely (FTS, two scopes, over-fetch)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Retrieve chunks for a single candidate across both scopes.
 * COVERAGE scope: all documents on the deal.
 * DEPENDENCY scope: IC memo documents only.
 * Returns chunk sets — no verdicts.
 */
export async function retrieveChunks(
  db: DbClient,
  cand: { candidate_id: string; failure_mode: string; proposed_queries: any },
  dealId: string,
): Promise<RetrievalResult> {
  const queries: string[] = Array.isArray(cand.proposed_queries)
    ? cand.proposed_queries
    : JSON.parse(String(cand.proposed_queries));

  const queryInput = JSON.stringify(
    queries.map((qt, idx) => ({ idx, qt: sanitiseForFts(qt) })),
  );

  // ── COVERAGE scope (all documents) ─────────────────────────────────────
  let coverageHits: RetrievedChunk[] = [];
  try {
    coverageHits = await db.query(
      `WITH qi AS (
         SELECT (j->>'idx')::int AS query_idx,
                j->>'qt'         AS query_text
         FROM jsonb_array_elements($1::jsonb) AS j
       ),
       matched AS (
         SELECT qi.query_idx,
                dc.id            AS chunk_id,
                dc.document_id,
                dc.file_name,
                dc.chunk_index,
                dc.content,
                ts_rank(dc.tsv, websearch_to_tsquery('english', qi.query_text)) AS rank,
                ROW_NUMBER() OVER (
                  PARTITION BY qi.query_idx
                  ORDER BY ts_rank(dc.tsv, websearch_to_tsquery('english', qi.query_text)) DESC
                ) AS rn
         FROM qi
         JOIN document_chunks dc
           ON dc.deal_id = $2::uuid
          AND dc.tsv @@ websearch_to_tsquery('english', qi.query_text)
       )
       SELECT query_idx AS query_idx, chunk_id, document_id, file_name,
              chunk_index, content, rank
       FROM matched
       WHERE rn <= ${MAX_HITS_PER_QUERY}
       ORDER BY rank DESC`,
      ChunkHitSchema,
      [queryInput, dealId],
      { label: `Stage2 coverage: ${cand.failure_mode}` },
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Stage2 coverage FTS error for ${cand.failure_mode}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── DEPENDENCY scope (IC memo documents only) ──────────────────────────
  let dependencyHits: RetrievedChunk[] = [];
  try {
    dependencyHits = await db.query(
      `WITH qi AS (
         SELECT (j->>'idx')::int AS query_idx,
                j->>'qt'         AS query_text
         FROM jsonb_array_elements($1::jsonb) AS j
       ),
       matched AS (
         SELECT qi.query_idx,
                dc.id            AS chunk_id,
                dc.document_id,
                dc.file_name,
                dc.chunk_index,
                dc.content,
                ts_rank(dc.tsv, websearch_to_tsquery('english', qi.query_text)) AS rank,
                ROW_NUMBER() OVER (
                  PARTITION BY qi.query_idx
                  ORDER BY ts_rank(dc.tsv, websearch_to_tsquery('english', qi.query_text)) DESC
                ) AS rn
         FROM qi
         JOIN document_chunks dc
           ON dc.deal_id = $2::uuid
          AND dc.document_id = ANY($3::uuid[])
          AND dc.tsv @@ websearch_to_tsquery('english', qi.query_text)
       )
       SELECT query_idx AS query_idx, chunk_id, document_id, file_name,
              chunk_index, content, rank
       FROM matched
       WHERE rn <= ${MAX_HITS_PER_QUERY}
       ORDER BY rank DESC`,
      ChunkHitSchema,
      [queryInput, dealId, IC_MEMO_DOC_IDS],
      { label: `Stage2 dependency: ${cand.failure_mode}` },
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} Stage2 dependency FTS error for ${cand.failure_mode}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Dedup + rank-cap per scope ─────────────────────────────────────────
  const dedupAndCap = (hits: Array<{ chunk_id: string; document_id: string; file_name: string; chunk_index: number; content: string; rank: number }>, maxChunks: number): RetrievedChunk[] => {
    const seen = new Map<string, RetrievedChunk>();
    for (const h of hits) {
      const existing = seen.get(h.chunk_id);
      if (!existing || h.rank > existing.rank) {
        seen.set(h.chunk_id, {
          chunk_id: h.chunk_id,
          document_id: h.document_id,
          file_name: h.file_name,
          chunk_index: h.chunk_index,
          content: h.content,
          rank: h.rank,
        });
      }
    }
    return Array.from(seen.values())
      .sort((a, b) => b.rank - a.rank)
      .slice(0, maxChunks);
  };

  const covChunks = dedupAndCap(coverageHits, MAX_CHUNKS_COVERAGE);
  const depChunks = dedupAndCap(dependencyHits, MAX_CHUNKS_DEPENDENCY);

  console.log(
    `${LOG_PREFIX} Stage2: ${cand.failure_mode}: ` +
    `coverage=${covChunks.length} chunks from ${new Set(covChunks.map(c => c.document_id)).size} docs, ` +
    `dependency=${depChunks.length} chunks from ${new Set(depChunks.map(c => c.document_id)).size} docs`,
  );

  return {
    coverageChunks: covChunks,
    dependencyChunks: depChunks,
    coverageDocCount: new Set(covChunks.map(c => c.document_id)).size,
    dependencyDocCount: new Set(depChunks.map(c => c.document_id)).size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3a — Coverage adjudication (one LLM call per candidate)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LLM judges whether the diligence corpus ADDRESSes, MENTIONs, or is ABSENT
 * on this risk. ADDRESSED requires a verbatim quote verified by code.
 */
export async function adjudicateCoverage(
  ai: AiClient,
  cand: { failure_mode: string; implied_assumption: string; hypothesis: string },
  chunks: RetrievedChunk[],
): Promise<{ verdict: CoverageVerdict; tokens: { input: number; output: number } }> {
  // Zero chunks → ABSENT, no LLM call
  if (chunks.length === 0) {
    return {
      verdict: {
        verdict: "ABSENT",
        quote: null,
        source_document: null,
        reason: `No retrieval hits. ${FTS_ONLY_CAVEAT}`,
        overridden: false,
        overrideReason: null,
        chunksUsed: 0,
      },
      tokens: { input: 0, output: 0 },
    };
  }

  const docsUsed = new Set(chunks.map(c => c.document_id));
  const chunkTexts = chunks.map(
    (h, i) => `[Passage ${i + 1}, from "${h.file_name}", chunk ${h.chunk_index}]\n${h.content}`,
  ).join("\n\n---\n\n");

  const systemPrompt =
    `You are a diligence analyst. Be precise and ground your answer in the supplied text only.`;

  const userPrompt =
    `Here is a risk an investor is relying on, and passages from the deal's diligence documents. ` +
    `Do the documents ADDRESS this risk — investigate it, test it, quantify it, or provide evidence ` +
    `bearing on whether the assumption holds? Or do they merely MENTION the topic without engaging ` +
    `the risk? Answer ADDRESSED, MENTIONED, or ABSENT.

If ADDRESSED, quote the single passage that most directly engages the risk, verbatim, from the ` +
    `supplied text. If you cannot quote such a passage, it is not ADDRESSED.

RISK / FAILURE MODE: ${cand.failure_mode}
IMPLIED ASSUMPTION: ${cand.implied_assumption}
HYPOTHESIS: ${cand.hypothesis}

RETRIEVED PASSAGES (${chunks.length} passages from ${docsUsed.size} documents):

${chunkTexts}

---

Format your response as:
Verdict: [ADDRESSED/MENTIONED/ABSENT]
Quote: "[verbatim quote if ADDRESSED, otherwise empty]"
Source document: "[filename of the document the quote is from]"
Reason: [one sentence]`;

  try {
    const llmResponse = await ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SONNET_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
      },
      { response: MessageResponseSchema },
      { label: `3a coverage: ${cand.failure_mode}` },
    );

    const responseText = llmResponse.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");

    const parsed = parseCoverageResponse(responseText);

    let finalVerdict = parsed.verdict as "ADDRESSED" | "MENTIONED" | "ABSENT";
    let finalQuote: string | null = parsed.quote || null;
    let overridden = false;
    let overrideReason: string | null = null;

    // ── Anti-fabrication (ADDRESSED only) ────────────────────────────────
    if (finalVerdict === "ADDRESSED") {
      if (!finalQuote || finalQuote.length < 10) {
        overridden = true;
        overrideReason = "ADDRESSED without substantive quote — overridden to MENTIONED";
        finalVerdict = "MENTIONED";
        finalQuote = null;
      } else if (!verifyQuoteInChunks(finalQuote, chunks)) {
        overridden = true;
        overrideReason = `Fabricated quote (not a substring of supplied chunks) — overridden to MENTIONED. ` +
          `First 80 chars: "${normaliseWs(finalQuote).slice(0, 80)}…"`;
        finalVerdict = "MENTIONED";
        // Keep quote in record for audit trail
      }
    }

    return {
      verdict: {
        verdict: finalVerdict,
        quote: finalQuote,
        source_document: parsed.source_document || null,
        reason: parsed.reason,
        overridden,
        overrideReason,
        chunksUsed: chunks.length,
      },
      tokens: {
        input: llmResponse.usage.input_tokens,
        output: llmResponse.usage.output_tokens,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} 3a LLM error for ${cand.failure_mode}: ${msg}`);
    return {
      verdict: {
        verdict: "MENTIONED",
        quote: null,
        source_document: null,
        reason: `LLM call failed: ${msg.slice(0, 200)}`,
        overridden: true,
        overrideReason: "LLM error — defaulted to MENTIONED (conservative)",
        chunksUsed: chunks.length,
      },
      tokens: { input: 0, output: 0 },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3b — Dependency adjudication (one LLM call per candidate)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LLM judges whether the investment thesis RELIES on this assumption —
 * does the case's logic, returns, or rationale depend on it, whether or
 * not the memo states it explicitly.
 *
 * Key design principle: "An unstated reliance is still a reliance."
 * A blind spot is by definition unstated. Dependency is about reliance,
 * not statement.
 */
export async function adjudicateDependency(
  ai: AiClient,
  cand: { failure_mode: string; implied_assumption: string; hypothesis: string },
  chunks: RetrievedChunk[],
): Promise<{ verdict: DependencyVerdict; tokens: { input: number; output: number } }> {
  // Zero chunks → INDEPENDENT (no memo material to judge from), but caveated
  if (chunks.length === 0) {
    return {
      verdict: {
        verdict: "INDEPENDENT",
        quote: null,
        source_memo: null,
        reason: `No IC memo chunks retrieved for this candidate's queries. ${FTS_ONLY_CAVEAT}`,
        overridden: false,
        overrideReason: null,
        chunksUsed: 0,
      },
      tokens: { input: 0, output: 0 },
    };
  }

  const memosUsed = new Set(chunks.map(c => c.file_name));
  const chunkTexts = chunks.map(
    (h, i) => `[Passage ${i + 1}, from "${h.file_name}", chunk ${h.chunk_index}]\n${h.content}`,
  ).join("\n\n---\n\n");

  const systemPrompt =
    `You are an investment analyst assessing whether an investment thesis relies on an assumption. ` +
    `Be precise and ground your answer in the supplied memo text only.`;

  const userPrompt =
    `Here is an assumption. Here are passages from the investment memos. ` +
    `Does the investment thesis RELY on this assumption being true — does the case's logic, ` +
    `returns, or rationale depend on it, whether or not the memo states it explicitly?

Answer RELIED_UPON or INDEPENDENT.

If RELIED_UPON, quote the passage showing the thesis leaning on this territory, verbatim, ` +
    `from the supplied text. A thesis relies on an assumption when the case would weaken if ` +
    `the assumption were false — it need NOT be stated as an assumption in the memo. ` +
    `An unstated reliance is still a reliance.

ASSUMPTION / FAILURE MODE: ${cand.failure_mode}
IMPLIED ASSUMPTION: ${cand.implied_assumption}
HYPOTHESIS: ${cand.hypothesis}

IC MEMO PASSAGES (${chunks.length} passages from ${memosUsed.size} memos):

${chunkTexts}

---

Format your response as:
Verdict: [RELIED_UPON/INDEPENDENT]
Quote: "[verbatim quote if RELIED_UPON, otherwise empty]"
Source memo: "[filename of the memo the quote is from]"
Reason: [one sentence]`;

  try {
    const llmResponse = await ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SONNET_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
      },
      { response: MessageResponseSchema },
      { label: `3b dependency: ${cand.failure_mode}` },
    );

    const responseText = llmResponse.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");

    const parsed = parseDependencyResponse(responseText);

    let finalVerdict = parsed.verdict as "RELIED_UPON" | "INDEPENDENT";
    let finalQuote: string | null = parsed.quote || null;
    let overridden = false;
    let overrideReason: string | null = null;

    // ── Anti-fabrication (RELIED_UPON only) ──────────────────────────────
    if (finalVerdict === "RELIED_UPON") {
      if (!finalQuote || finalQuote.length < 10) {
        overridden = true;
        overrideReason = "RELIED_UPON without substantive quote — overridden to INDEPENDENT";
        finalVerdict = "INDEPENDENT";
        finalQuote = null;
      } else if (!verifyQuoteInChunks(finalQuote, chunks)) {
        overridden = true;
        overrideReason = `Fabricated quote (not a substring of supplied memo chunks) — overridden to INDEPENDENT. ` +
          `First 80 chars: "${normaliseWs(finalQuote).slice(0, 80)}…"`;
        finalVerdict = "INDEPENDENT";
        // Keep quote for audit
      }
    }

    return {
      verdict: {
        verdict: finalVerdict,
        quote: finalQuote,
        source_memo: parsed.source_memo || null,
        reason: parsed.reason,
        overridden,
        overrideReason,
        chunksUsed: chunks.length,
      },
      tokens: {
        input: llmResponse.usage.input_tokens,
        output: llmResponse.usage.output_tokens,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} 3b LLM error for ${cand.failure_mode}: ${msg}`);
    return {
      verdict: {
        verdict: "INDEPENDENT",
        quote: null,
        source_memo: null,
        reason: `LLM call failed: ${msg.slice(0, 200)}`,
        overridden: true,
        overrideReason: "LLM error — defaulted to INDEPENDENT (conservative)",
        chunksUsed: chunks.length,
      },
      tokens: { input: 0, output: 0 },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 4 — Compose disposition (code only, no judgment)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mechanical composition from coverage + dependency verdicts.
 *   RELIED_UPON + (MENTIONED or ABSENT)  → FINDING
 *   RELIED_UPON + ADDRESSED              → dropped_covered
 *   INDEPENDENT + anything               → dropped_not_relied_upon
 */
export function composeDisposition(
  coverage: CoverageVerdict,
  dependency: DependencyVerdict | null,
): DispositionResult {
  const caveats: string[] = [];

  // Add FTS-only caveat when relevant
  if (coverage.verdict !== "ADDRESSED") {
    caveats.push(FTS_ONLY_CAVEAT);
  }

  // If no dependency verdict (ADDRESSED candidates skip 3b in the batch API,
  // but per-candidate orchestrator path always runs 3b), treat as dropped_covered
  if (!dependency) {
    return {
      outcome: "dropped_covered",
      gate: "coverage",
      reason: `ADDRESSED — ${coverage.reason}`,
      caveats,
    };
  }

  if (dependency.verdict === "INDEPENDENT") {
    return {
      outcome: "dropped_not_relied_upon",
      gate: "dependency",
      reason: `${coverage.verdict}, INDEPENDENT — thesis does not rely on this assumption; ${dependency.reason}`,
      caveats,
    };
  }

  // RELIED_UPON
  if (coverage.verdict === "ADDRESSED") {
    return {
      outcome: "dropped_covered",
      gate: "coverage",
      reason: `ADDRESSED + RELIED_UPON — risk is thesis-relevant but diligence engages it; ${coverage.reason}`,
      caveats,
    };
  }

  // RELIED_UPON + (MENTIONED or ABSENT) → FINDING
  return {
    outcome: "finding",
    gate: "dependency",
    reason: `${coverage.verdict} + RELIED_UPON — thesis relies on this assumption but diligence ` +
      `does not address it; coverage: ${coverage.reason}; dependency: ${dependency.reason}`,
    caveats,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-candidate orchestrator function (all 4 stages)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run Stages 2→3a→3b→4 for a single candidate.
 * Writes coverage, dependency, and disposition rows.
 * Called by the pipeline orchestrator in per-candidate loop.
 */
export async function adjudicateAndDisposeOneCandidate(
  db: DbClient,
  ai: AiClient,
  cand: {
    candidate_id: string;
    failure_mode: string;
    pass_type: string;
    implied_assumption: string;
    hypothesis: string;
    proposed_queries: any;
  },
  dealId: string,
  oldVerdict: string,
): Promise<{
  adjudication: AdjudicationRow;
  disposition: DispositionResult;
  tokens: { input: number; output: number };
}> {
  let totalIn = 0;
  let totalOut = 0;

  // ── Stage 2: Retrieve ──────────────────────────────────────────────────
  const retrieval = await retrieveChunks(db, cand, dealId);

  // ── Stage 3a: Coverage adjudication ────────────────────────────────────
  const cov = await adjudicateCoverage(ai, cand, retrieval.coverageChunks);
  totalIn += cov.tokens.input;
  totalOut += cov.tokens.output;

  // ── Stage 3b: Dependency adjudication (all candidates — spec says
  //    coverage and dependency are separate questions, both always run) ───
  const dep = await adjudicateDependency(ai, cand, retrieval.dependencyChunks);
  totalIn += dep.tokens.input;
  totalOut += dep.tokens.output;

  const adjRow: AdjudicationRow = {
    candidate_id: cand.candidate_id,
    failure_mode: cand.failure_mode,
    pass_type: cand.pass_type,
    coverage: cov.verdict,
    dependency: dep.verdict,
    retrievalSummary: {
      coverageChunks: retrieval.coverageChunks.length,
      coverageDocs: retrieval.coverageDocCount,
      dependencyChunks: retrieval.dependencyChunks.length,
      dependencyDocs: retrieval.dependencyDocCount,
    },
  };

  // ── Stage 4: Compose disposition ───────────────────────────────────────
  const disposition = composeDisposition(cov.verdict, dep.verdict);

  // ── Persist: bss_coverage ──────────────────────────────────────────────
  await db.execute(
    `UPDATE bss_coverage
     SET adjudicated_verdict = $1,
         adjudication_quote = $2,
         adjudication_reason = $3
     WHERE candidate_id = $4::uuid AND deal_id = $5::uuid`,
    [
      cov.verdict.verdict,
      cov.verdict.quote ?? "",
      cov.verdict.reason,
      cand.candidate_id,
      dealId,
    ],
    { label: `Write coverage: ${cand.failure_mode}` },
  );

  // ── Persist: bss_dependencies ──────────────────────────────────────────
  const thesis_hit = dep.verdict.verdict === "RELIED_UPON";
  const latest_memo_hit = thesis_hit && retrieval.dependencyChunks.some(
    c => LATEST_MEMO_DOC_IDS.includes(c.document_id),
  );

  await db.execute(
    `INSERT INTO bss_dependencies
       (deal_id, candidate_id, thesis_hit, latest_memo_hit,
        queries_run, memo_documents_searched, hits, swept_at)
     VALUES ($1::uuid, $2::uuid, $3::boolean, $4::boolean,
             $5::jsonb, $6::jsonb, $7::jsonb, NOW())
     ON CONFLICT (deal_id, candidate_id) DO UPDATE SET
       thesis_hit = EXCLUDED.thesis_hit,
       latest_memo_hit = EXCLUDED.latest_memo_hit,
       queries_run = EXCLUDED.queries_run,
       memo_documents_searched = EXCLUDED.memo_documents_searched,
       hits = EXCLUDED.hits,
       swept_at = now()`,
    [
      dealId,
      cand.candidate_id,
      thesis_hit,
      latest_memo_hit,
      JSON.stringify(Array.isArray(cand.proposed_queries) ? cand.proposed_queries : JSON.parse(String(cand.proposed_queries))),
      JSON.stringify(IC_MEMO_DOC_IDS),
      JSON.stringify({
        verdict: dep.verdict.verdict,
        quote: dep.verdict.quote,
        source_memo: dep.verdict.source_memo,
        reason: dep.verdict.reason,
        overridden: dep.verdict.overridden,
        overrideReason: dep.verdict.overrideReason,
        chunksUsed: dep.verdict.chunksUsed,
      }),
    ],
    { label: `Write dependency: ${cand.failure_mode}` },
  );

  // ── Persist: bss_dispositions ──────────────────────────────────────────
  await db.execute(
    `INSERT INTO bss_dispositions
       (deal_id, candidate_id, outcome, gate, reason, decided_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW())
     ON CONFLICT (candidate_id) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       gate = EXCLUDED.gate,
       reason = EXCLUDED.reason,
       decided_at = now()`,
    [dealId, cand.candidate_id, disposition.outcome, disposition.gate, disposition.reason],
    { label: `Write disposition: ${cand.failure_mode}` },
  );

  console.log(
    `${LOG_PREFIX} ${cand.failure_mode}: ` +
    `coverage=${cov.verdict.verdict}${cov.verdict.overridden ? "[OVR]" : ""} ` +
    `dependency=${dep.verdict.verdict}${dep.verdict.overridden ? "[OVR]" : ""} ` +
    `→ ${disposition.outcome} ` +
    `(cov: ${retrieval.coverageChunks.length}ch/${retrieval.coverageDocCount}d, ` +
    `dep: ${retrieval.dependencyChunks.length}ch/${retrieval.dependencyDocCount}d)`,
  );

  return { adjudication: adjRow, disposition, tokens: { input: totalIn, output: totalOut } };
}

// ═══════════════════════════════════════════════════════════════════════════
// Batch API (standalone — runs all candidates in one invocation)
// ═══════════════════════════════════════════════════════════════════════════

export default api({
  name: "BssLlmAdjudication",
  description: "Stages 2-4 adjudication: retrieve → LLM coverage → LLM dependency → compose",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    candidateCount: z.number(),
    findings: z.array(z.object({
      failure_mode: z.string(),
      pass_type: z.string(),
      implied_assumption: z.string(),
      coverage_verdict: z.string(),
      coverage_quote: z.string().nullable(),
      coverage_reason: z.string(),
      dependency_verdict: z.string(),
      dependency_quote: z.string().nullable(),
      dependency_reason: z.string(),
      disposition_reason: z.string(),
      caveats: z.array(z.string()),
    })),
    distribution: z.object({
      finding: z.number(),
      dropped_covered: z.number(),
      dropped_not_relied_upon: z.number(),
    }),
    overrides: z.array(z.object({
      failure_mode: z.string(),
      stage: z.string(),
      overrideReason: z.string(),
    })),
    runtimeMs: z.number(),
    llmCalls: z.number(),
    totalTokens: z.object({ input: z.number(), output: z.number() }),
    ftsOnlyCaveat: z.string(),
  }),

  async run(ctx, { dealId }) {
    const startTime = Date.now();
    let llmCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // ── Ensure adjudication columns ──────────────────────────────────────
    await ctx.integrations.db.execute(
      `ALTER TABLE bss_coverage
         ADD COLUMN IF NOT EXISTS adjudicated_verdict text,
         ADD COLUMN IF NOT EXISTS adjudication_quote text,
         ADD COLUMN IF NOT EXISTS adjudication_reason text`,
      [],
      { label: "Ensure adjudication columns" },
    );

    // ── Load candidates ──────────────────────────────────────────────────
    const candidates = await ctx.integrations.db.query(
      `SELECT c.candidate_id, c.failure_mode, c.pass_type,
              c.implied_assumption, c.hypothesis, c.proposed_queries
       FROM bss_candidates c
       WHERE c.deal_id = $1::uuid AND c.superseded_by IS NULL
       ORDER BY c.pass_type, c.failure_mode`,
      CandidateSchema,
      [dealId],
      { label: "Load live BSS candidates" },
    );
    console.log(`${LOG_PREFIX} Loaded ${candidates.length} candidates`);

    // ── Load old coverage verdicts for comparison ────────────────────────
    const oldVerdicts = await ctx.integrations.db.query(
      `SELECT candidate_id, verdict FROM bss_coverage WHERE deal_id = $1::uuid`,
      z.object({ candidate_id: z.string(), verdict: z.string() }),
      [dealId],
      { label: "Load old coverage verdicts" },
    );
    const oldVerdictMap = new Map(oldVerdicts.map(r => [r.candidate_id, r.verdict]));

    // ── Process each candidate through Stages 2→3a→3b→4 ─────────────────
    const results: Array<{
      adjudication: AdjudicationRow;
      disposition: DispositionResult;
    }> = [];
    const overrides: Array<{ failure_mode: string; stage: string; overrideReason: string }> = [];

    for (const cand of candidates) {
      const oldVerdict = oldVerdictMap.get(cand.candidate_id) ?? "unknown";
      const result = await adjudicateAndDisposeOneCandidate(
        ctx.integrations.db,
        ctx.integrations.ai,
        {
          candidate_id: cand.candidate_id,
          failure_mode: cand.failure_mode,
          pass_type: cand.pass_type,
          implied_assumption: cand.implied_assumption,
          hypothesis: cand.hypothesis,
          proposed_queries: cand.proposed_queries,
        },
        dealId,
        oldVerdict,
      );

      results.push({ adjudication: result.adjudication, disposition: result.disposition });
      totalInputTokens += result.tokens.input;
      totalOutputTokens += result.tokens.output;

      // Count LLM calls (coverage + dependency = 2, minus skips for 0 chunks)
      if (result.adjudication.coverage.chunksUsed > 0) llmCalls++;
      if (result.adjudication.dependency && result.adjudication.dependency.chunksUsed > 0) llmCalls++;

      // Track overrides
      if (result.adjudication.coverage.overridden && result.adjudication.coverage.overrideReason) {
        overrides.push({
          failure_mode: cand.failure_mode,
          stage: "3a_coverage",
          overrideReason: result.adjudication.coverage.overrideReason,
        });
      }
      if (result.adjudication.dependency?.overridden && result.adjudication.dependency.overrideReason) {
        overrides.push({
          failure_mode: cand.failure_mode,
          stage: "3b_dependency",
          overrideReason: result.adjudication.dependency.overrideReason,
        });
      }
    }

    // ── Distribution ─────────────────────────────────────────────────────
    const distrib = { finding: 0, dropped_covered: 0, dropped_not_relied_upon: 0 };
    for (const r of results) {
      const key = r.disposition.outcome as keyof typeof distrib;
      if (key in distrib) distrib[key]++;
    }

    // ── Build findings list ──────────────────────────────────────────────
    const findings = results
      .filter(r => r.disposition.outcome === "finding")
      .map(r => {
        const cand = candidates.find(c => c.candidate_id === r.adjudication.candidate_id)!;
        return {
          failure_mode: r.adjudication.failure_mode,
          pass_type: r.adjudication.pass_type,
          implied_assumption: cand.implied_assumption,
          coverage_verdict: r.adjudication.coverage.verdict,
          coverage_quote: r.adjudication.coverage.quote,
          coverage_reason: r.adjudication.coverage.reason,
          dependency_verdict: r.adjudication.dependency?.verdict ?? "N/A",
          dependency_quote: r.adjudication.dependency?.quote ?? null,
          dependency_reason: r.adjudication.dependency?.reason ?? "N/A",
          disposition_reason: r.disposition.reason,
          caveats: r.disposition.caveats,
        };
      });

    const elapsed = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} COMPLETE — ${elapsed}ms, ${llmCalls} LLM calls, ` +
      `tokens: ${totalInputTokens}in/${totalOutputTokens}out. ` +
      `Findings: ${distrib.finding}, dropped_covered: ${distrib.dropped_covered}, ` +
      `dropped_not_relied_upon: ${distrib.dropped_not_relied_upon}. ` +
      `Overrides: ${overrides.length}`,
    );

    return {
      candidateCount: candidates.length,
      findings,
      distribution: distrib,
      overrides,
      runtimeMs: elapsed,
      llmCalls,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
      ftsOnlyCaveat: FTS_ONLY_CAVEAT,
    };
  },
});
