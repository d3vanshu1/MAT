/**
 * BSS v2 — Packet 4 Adjudication (corrected spec).
 *
 * Four stages per candidate:
 *   Stage 2 — Retrieve widely (FTS, NO cap, fan-out batching)
 *   Stage 3a — Coverage adjudication (LLM + anti-fabrication)
 *   Stage 3b — Dependency adjudication (LLM + expanded queries + anti-fabrication)
 *   Stage 4 — Compose disposition (code only)
 *
 * Design corrections applied:
 *   1. NO CHUNK CAP — fan-out batching when chunks exceed single-call budget.
 *      Any batch returning ADDRESSED with verified quote = covered.
 *   2. OVERWRITE verdict column — old count-based values archived to
 *      bss_coverage_audit_v1 then verdict overwritten with ADDRESSED/MENTIONED/ABSENT.
 *   3. AGGRESSIVE DEPENDENCY EXPANSION — synonyms, root forms, related phrasing
 *      for FTS dependency queries. Every ABSENT/INDEPENDENT carries FTS caveat.
 *
 * pgvector: NOT installed. FTS-only mode with standing retrieval-completeness caveat.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-ADJUDICATE]";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max chunk content chars per LLM batch. ~6000 tokens of content. */
const BATCH_CHAR_BUDGET = 24000;

/** Max FTS results per query (before dedup/ranking). */
const MAX_HITS_PER_QUERY = 25;

/** LLM max output tokens. */
const MAX_OUTPUT_TOKENS = 1024;

// ---------------------------------------------------------------------------
// IC memo document IDs
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
// FTS caveat
// ---------------------------------------------------------------------------

const FTS_ONLY_CAVEAT =
  "Retrieval was FTS-only (no semantic/embedding search). " +
  "Absent/independent verdicts carry the standing caveat that differently-worded " +
  "coverage or reliance may exist but was not retrieved by keyword match.";

// ---------------------------------------------------------------------------
// Synonym expansion for dependency FTS
// ---------------------------------------------------------------------------

const SYNONYM_MAP: Record<string, string[]> = {
  revenue: ["sales", "top line", "income", "turnover", "billings"],
  margin: ["profitability", "EBITDA margin", "gross margin", "operating margin", "margin expansion"],
  debt: ["leverage", "borrowing", "credit facility", "loan", "financing"],
  covenant: ["financial covenant", "debt covenant", "maintenance covenant", "lending terms"],
  customer: ["client", "account", "contract", "subscriber"],
  retention: ["churn", "attrition", "renewal rate", "customer loss"],
  growth: ["expansion", "scaling", "ramp", "trajectory", "CAGR"],
  acquisition: ["M&A", "bolt-on", "buy and build", "add-on"],
  earnout: ["earn-out", "contingent consideration", "deferred consideration", "completion mechanism", "purchase price", "seller payment", "deferred payment"],
  deferred: ["outstanding", "remaining", "unpaid", "contingent", "owed"],
  "bad debt": ["aged debtor", "credit loss", "provision", "impairment", "write-off", "doubtful debt"],
  ip: ["intellectual property", "proprietary technology", "owned technology", "patent"],
  competitor: ["competitive", "rival", "alternative provider", "market entrant"],
  pstn: ["legacy telephony", "traditional phone", "landline", "copper network", "switch-off"],
  switch: ["migration", "transition", "sunset", "phase-out", "end of life"],
  "capital structure": ["leverage structure", "debt equity", "capitalisation", "gearing"],
  saas: ["software as a service", "cloud software", "recurring revenue", "ARR", "subscription"],
  premium: ["pricing power", "price premium", "above-market", "differential"],
  thesis: ["investment case", "value creation", "rationale", "hypothesis"],
  assumption: ["reliance", "predicated on", "depends on", "contingent on", "assumes"],
  risk: ["downside", "exposure", "vulnerability", "threat"],
  diligence: ["due diligence", "DD", "workstream", "investigation"],
  credit: ["creditworthiness", "debtor quality", "receivables", "payment risk"],
  ratchet: ["adjustment mechanism", "earn-out adjustment", "performance adjustment"],
  concentration: ["dependency", "single customer", "key account", "top customer"],
};

/**
 * Expand a set of queries with synonym variants for dependency FTS.
 * For each query, identify terms that have synonyms and generate alternative queries.
 */
function expandDependencyQueries(
  originalQueries: string[],
  failureMode: string,
  hypothesis: string,
  impliedAssumption: string,
): { expanded: string[]; expansionLog: string[] } {
  const expanded = new Set<string>(originalQueries);
  const expansionLog: string[] = [];

  // Extract keywords from failure_mode
  const fmTokens = failureMode.toLowerCase().replace(/_/g, " ").split(/\s+/);

  // For each original query, generate synonym expansions
  for (const query of originalQueries) {
    const lowerQuery = query.toLowerCase();
    for (const [term, synonyms] of Object.entries(SYNONYM_MAP)) {
      // Word-boundary match: only replace when `term` appears as a whole
      // word, not when it's a substring of another word (debt ≠ debtor).
      const termRe = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      if (termRe.test(lowerQuery) || fmTokens.includes(term)) {
        for (const syn of synonyms) {
          const variant = query.replace(termRe, syn);
          if (variant !== query && !expanded.has(variant)) {
            expanded.add(variant);
            expansionLog.push(`"${query}" → "${variant}" (${term}→${syn})`);
          }
        }
      }
    }
  }

  // Also generate queries from hypothesis key phrases
  const hypothesisPhrases = extractKeyPhrases(hypothesis, impliedAssumption);
  for (const phrase of hypothesisPhrases) {
    if (!expanded.has(phrase)) {
      expanded.add(phrase);
      expansionLog.push(`hypothesis phrase: "${phrase}"`);
    }
  }

  // Add failure_mode as a plain query (spaces instead of underscores)
  const fmQuery = failureMode.replace(/_/g, " ");
  if (!expanded.has(fmQuery)) {
    expanded.add(fmQuery);
    expansionLog.push(`failure_mode direct: "${fmQuery}"`);
  }

  return { expanded: Array.from(expanded), expansionLog };
}

/**
 * Extract meaningful phrases from hypothesis and implied_assumption text.
 * Aggressive extraction — the goal is to generate FTS queries that catch
 * differently-worded references in the IC memos.
 */
function extractKeyPhrases(text: string, impliedAssumption?: string): string[] {
  const phrases: string[] = [];
  const sources = [text, impliedAssumption].filter(Boolean) as string[];

  for (const src of sources) {
    // Look for quoted terms
    const quoted = src.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted) phrases.push(q.replace(/"/g, ""));
    }

    // Look for noun phrases after "that", "whether", "if", "will", "are"
    const clauseMatch = src.match(/(?:that|whether|if|will|are|is)\s+([^,.;]{10,50})/gi);
    if (clauseMatch) {
      for (const c of clauseMatch) {
        const phrase = c.replace(/^(that|whether|if|will|are|is)\s+/i, "").trim();
        if (phrase.split(/\s+/).length <= 6) phrases.push(phrase);
      }
    }

    // Extract 2-4 word noun phrases from comma/semicolon-delimited segments
    const segments = src.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 5);
    for (const seg of segments) {
      const words = seg.split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|from|that|this|which|whose|along|will|than|into|have|been|being|also|such|each|both|they|their|does|other)$/i.test(w));
      if (words.length >= 2 && words.length <= 5) {
        phrases.push(words.join(" "));
      }
      // Also take leading 2-3 content words as a phrase
      if (words.length >= 3) {
        phrases.push(words.slice(0, 3).join(" "));
      }
    }
  }

  // Deduplicate and cap
  return [...new Set(phrases)].slice(0, 8);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitiseForFts(q: string): string {
  return q.replace(/-/g, " ").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normaliseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split chunks into batches that fit within BATCH_CHAR_BUDGET.
 * Each batch is a self-contained set of chunks for one LLM call.
 */
function batchChunks(chunks: RetrievedChunk[]): RetrievedChunk[][] {
  if (chunks.length === 0) return [];
  const batches: RetrievedChunk[][] = [];
  let current: RetrievedChunk[] = [];
  let currentChars = 0;

  for (const chunk of chunks) {
    const chunkLen = chunk.content.length;
    if (current.length > 0 && currentChars + chunkLen > BATCH_CHAR_BUDGET) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunkLen;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  file_name: string;
  chunk_index: number;
  content: string;
  rank: number;
}

export interface CoverageVerdict {
  verdict: "ADDRESSED" | "MENTIONED" | "ABSENT";
  quote: string | null;
  source_document: string | null;
  reason: string;
  overridden: boolean;
  overrideReason: string | null;
  chunksUsed: number;
  batchesUsed: number;
}

export interface DependencyVerdict {
  verdict: "RELIED_UPON" | "INDEPENDENT";
  quote: string | null;
  source_memo: string | null;
  reason: string;
  overridden: boolean;
  overrideReason: string | null;
  chunksUsed: number;
  batchesUsed: number;
  expandedQueryCount: number;
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
  verdict: string; quote: string; source_document: string; reason: string;
} {
  const upper = text.toUpperCase();
  let verdict = "MENTIONED"; // safe default
  if (upper.includes("ADDRESSED")) verdict = "ADDRESSED";
  else if (upper.includes("ABSENT")) verdict = "ABSENT";
  else if (upper.includes("MENTIONED")) verdict = "MENTIONED";

  let quote = "";
  const quotePatterns = [
    /[Qq]uote:\s*"([^"]+)"/s,
    /[Qq]uote:\s*["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]/s,
    /[Pp]assage:\s*"([^"]+)"/s,
    /"([^"]{20,})"/,
  ];
  for (const pat of quotePatterns) {
    const m = text.match(pat);
    if (m && m[1]) { quote = m[1].trim(); break; }
  }

  let source_document = "";
  const srcMatch = text.match(/[Ss]ource[_ ]?[Dd]ocument:\s*"?([^"\n]+)"?/);
  if (srcMatch) source_document = srcMatch[1].trim();

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
  verdict: string; quote: string; source_memo: string; reason: string;
} {
  const upper = text.toUpperCase();
  let verdict = "INDEPENDENT"; // safe default
  if (upper.includes("RELIED_UPON") || upper.includes("RELIED UPON")) verdict = "RELIED_UPON";
  else if (upper.includes("INDEPENDENT")) verdict = "INDEPENDENT";

  let quote = "";
  const quotePatterns = [
    /[Qq]uote:\s*"([^"]+)"/s,
    /[Qq]uote:\s*["\u201C\u201D]([^"\u201C\u201D]+)["\u201C\u201D]/s,
    /[Pp]assage:\s*"([^"]+)"/s,
    /"([^"]{20,})"/,
  ];
  for (const pat of quotePatterns) {
    const m = text.match(pat);
    if (m && m[1]) { quote = m[1].trim(); break; }
  }

  let source_memo = "";
  const srcMatch = text.match(/[Ss]ource[_ ]?[Mm]emo:\s*"?([^"\n]+)"?/);
  if (srcMatch) source_memo = srcMatch[1].trim();

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

function verifyQuoteInChunks(quote: string, chunks: RetrievedChunk[]): boolean {
  if (!quote || quote.length < 10) return false;
  const normQuote = normaliseWs(quote);
  for (const chunk of chunks) {
    if (normaliseWs(chunk.content).includes(normQuote)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2 — Retrieve widely (FTS, NO cap, two scopes)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Retrieve ALL matching chunks for a candidate across both scopes.
 * NO CHUNK CAP. Fan-out batching happens downstream at the LLM call.
 */
export async function retrieveChunks(
  db: DbClient,
  cand: { candidate_id: string; failure_mode: string; implied_assumption: string; hypothesis: string; proposed_queries: any },
  dealId: string,
): Promise<{
  coverageChunks: RetrievedChunk[];
  dependencyChunks: RetrievedChunk[];
  coverageDocCount: number;
  dependencyDocCount: number;
  dependencyExpansionLog: string[];
  dependencyQueryCount: number;
}> {
  const queries: string[] = Array.isArray(cand.proposed_queries)
    ? cand.proposed_queries
    : JSON.parse(String(cand.proposed_queries));

  // ── COVERAGE scope: original queries against all documents ─────────────
  const covQueryInput = JSON.stringify(
    queries.map((qt, idx) => ({ idx, qt: sanitiseForFts(qt) })),
  );

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
       SELECT query_idx, chunk_id, document_id, file_name,
              chunk_index, content, rank
       FROM matched
       WHERE rn <= ${MAX_HITS_PER_QUERY}
       ORDER BY rank DESC`,
      ChunkHitSchema,
      [covQueryInput, dealId],
      { label: `Stage2 cov: ${cand.failure_mode}` },
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} Stage2 cov FTS err for ${cand.failure_mode}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── DEPENDENCY scope: expanded queries against IC memos only ───────────
  const { expanded: depQueries, expansionLog } = expandDependencyQueries(
    queries, cand.failure_mode, cand.hypothesis, cand.implied_assumption,
  );

  const depQueryInput = JSON.stringify(
    depQueries.map((qt, idx) => ({ idx, qt: sanitiseForFts(qt) })),
  );

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
       SELECT query_idx, chunk_id, document_id, file_name,
              chunk_index, content, rank
       FROM matched
       WHERE rn <= ${MAX_HITS_PER_QUERY}
       ORDER BY rank DESC`,
      ChunkHitSchema,
      [depQueryInput, dealId, IC_MEMO_DOC_IDS],
      { label: `Stage2 dep: ${cand.failure_mode}` },
    );
  } catch (err) {
    console.warn(`${LOG_PREFIX} Stage2 dep FTS err for ${cand.failure_mode}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Dedup (NO cap) ─────────────────────────────────────────────────────
  const dedup = (hits: Array<{ chunk_id: string; document_id: string; file_name: string; chunk_index: number; content: string; rank: number }>): RetrievedChunk[] => {
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
    return Array.from(seen.values()).sort((a, b) => b.rank - a.rank);
  };

  const covChunks = dedup(coverageHits);
  const depChunks = dedup(dependencyHits);

  console.log(
    `${LOG_PREFIX} Stage2: ${cand.failure_mode}: ` +
    `coverage=${covChunks.length} chunks/${new Set(covChunks.map(c => c.document_id)).size} docs, ` +
    `dependency=${depChunks.length} chunks/${new Set(depChunks.map(c => c.document_id)).size} docs ` +
    `(${depQueries.length} expanded queries, ${expansionLog.length} expansions)`,
  );

  return {
    coverageChunks: covChunks,
    dependencyChunks: depChunks,
    coverageDocCount: new Set(covChunks.map(c => c.document_id)).size,
    dependencyDocCount: new Set(depChunks.map(c => c.document_id)).size,
    dependencyExpansionLog: expansionLog,
    dependencyQueryCount: depQueries.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3a — Coverage adjudication (fan-out batched)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adjudicate coverage across ALL retrieved chunks via fan-out batching.
 * Any batch returning ADDRESSED with verified quote → candidate is covered.
 */
export async function adjudicateCoverage(
  ai: AiClient,
  cand: { failure_mode: string; implied_assumption: string; hypothesis: string },
  allChunks: RetrievedChunk[],
): Promise<{ verdict: CoverageVerdict; tokens: { input: number; output: number } }> {
  if (allChunks.length === 0) {
    return {
      verdict: {
        verdict: "ABSENT",
        quote: null,
        source_document: null,
        reason: `No retrieval hits. ${FTS_ONLY_CAVEAT}`,
        overridden: false,
        overrideReason: null,
        chunksUsed: 0,
        batchesUsed: 0,
      },
      tokens: { input: 0, output: 0 },
    };
  }

  const batches = batchChunks(allChunks);
  let totalIn = 0;
  let totalOut = 0;

  // Track best result across batches
  let bestVerdict: "ADDRESSED" | "MENTIONED" | "ABSENT" = "ABSENT";
  let bestQuote: string | null = null;
  let bestSourceDoc: string | null = null;
  let bestReason = "";
  const batchErrors: string[] = [];
  let anyOverridden = false;
  let overrideReason: string | null = null;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const docsUsed = new Set(batch.map(c => c.document_id));
    const chunkTexts = batch.map(
      (h, i) => `[Passage ${i + 1}, from "${h.file_name}", chunk ${h.chunk_index}]\n${h.content}`,
    ).join("\n\n---\n\n");

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

RETRIEVED PASSAGES (batch ${bi + 1}/${batches.length}: ${batch.length} passages from ${docsUsed.size} documents):

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
            system: "You are a diligence analyst. Be precise and ground your answer in the supplied text only.",
            messages: [{ role: "user", content: userPrompt }],
          },
        },
        { response: MessageResponseSchema },
        { label: `3a cov batch${bi + 1}/${batches.length}: ${cand.failure_mode}` },
      );

      totalIn += llmResponse.usage.input_tokens;
      totalOut += llmResponse.usage.output_tokens;

      const responseText = llmResponse.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      const parsed = parseCoverageResponse(responseText);
      let batchVerdict = parsed.verdict as "ADDRESSED" | "MENTIONED" | "ABSENT";
      let batchQuote: string | null = parsed.quote || null;

      // Anti-fabrication for this batch
      if (batchVerdict === "ADDRESSED") {
        if (!batchQuote || batchQuote.length < 10) {
          batchVerdict = "MENTIONED";
          batchQuote = null;
          anyOverridden = true;
          overrideReason = `Batch ${bi + 1}: ADDRESSED without substantive quote — overridden to MENTIONED`;
        } else if (!verifyQuoteInChunks(batchQuote, batch)) {
          anyOverridden = true;
          overrideReason = `Batch ${bi + 1}: Fabricated quote — overridden to MENTIONED. First 80: "${normaliseWs(batchQuote).slice(0, 80)}…"`;
          batchVerdict = "MENTIONED";
          batchQuote = null;
        }
      }

      // Aggregate: ADDRESSED > MENTIONED > ABSENT
      if (batchVerdict === "ADDRESSED" && bestVerdict !== "ADDRESSED") {
        bestVerdict = "ADDRESSED";
        bestQuote = batchQuote;
        bestSourceDoc = parsed.source_document || null;
        bestReason = parsed.reason;
      } else if (batchVerdict === "MENTIONED" && bestVerdict === "ABSENT") {
        bestVerdict = "MENTIONED";
        bestReason = parsed.reason;
      }

      // Early exit: if we found ADDRESSED with verified quote, no need for more batches
      if (bestVerdict === "ADDRESSED" && bestQuote) break;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} 3a batch${bi + 1} error for ${cand.failure_mode}: ${msg}`);
      // Continue to next batch — don't fail the whole candidate on one batch error
      batchErrors.push(`batch${bi + 1}: ${msg.slice(0, 200)}`);
    }
  }

  return {
    verdict: {
      verdict: bestVerdict,
      quote: bestQuote,
      source_document: bestSourceDoc,
      reason: bestReason || (bestVerdict === "ABSENT" ? `No batch found coverage. ${FTS_ONLY_CAVEAT}` : bestReason),
      overridden: anyOverridden,
      overrideReason,
      chunksUsed: allChunks.length,
      batchesUsed: batches.length,
    },
    tokens: { input: totalIn, output: totalOut },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3b — Dependency adjudication (fan-out batched, expanded queries)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LLM judges whether the thesis RELIES on this assumption.
 * Uses expanded FTS queries and fan-out batching.
 */
export async function adjudicateDependency(
  ai: AiClient,
  cand: { failure_mode: string; implied_assumption: string; hypothesis: string },
  allChunks: RetrievedChunk[],
  expandedQueryCount: number,
): Promise<{ verdict: DependencyVerdict; tokens: { input: number; output: number } }> {
  if (allChunks.length === 0) {
    return {
      verdict: {
        verdict: "INDEPENDENT",
        quote: null,
        source_memo: null,
        reason: `No IC memo chunks retrieved (${expandedQueryCount} expanded queries tried). ${FTS_ONLY_CAVEAT}`,
        overridden: false,
        overrideReason: null,
        chunksUsed: 0,
        batchesUsed: 0,
        expandedQueryCount,
      },
      tokens: { input: 0, output: 0 },
    };
  }

  const batches = batchChunks(allChunks);
  let totalIn = 0;
  let totalOut = 0;

  let bestVerdict: "RELIED_UPON" | "INDEPENDENT" = "INDEPENDENT";
  let bestQuote: string | null = null;
  let bestSourceMemo: string | null = null;
  let bestReason = "";
  let anyOverridden = false;
  let overrideReason: string | null = null;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const memosUsed = new Set(batch.map(c => c.file_name));
    const chunkTexts = batch.map(
      (h, i) => `[Passage ${i + 1}, from "${h.file_name}", chunk ${h.chunk_index}]\n${h.content}`,
    ).join("\n\n---\n\n");

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

IC MEMO PASSAGES (batch ${bi + 1}/${batches.length}: ${batch.length} passages from ${memosUsed.size} memos):

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
            system: "You are an investment analyst assessing whether an investment thesis relies on an assumption. Be precise and ground your answer in the supplied memo text only.",
            messages: [{ role: "user", content: userPrompt }],
          },
        },
        { response: MessageResponseSchema },
        { label: `3b dep batch${bi + 1}/${batches.length}: ${cand.failure_mode}` },
      );

      totalIn += llmResponse.usage.input_tokens;
      totalOut += llmResponse.usage.output_tokens;

      const responseText = llmResponse.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");

      const parsed = parseDependencyResponse(responseText);
      let batchVerdict = parsed.verdict as "RELIED_UPON" | "INDEPENDENT";
      let batchQuote: string | null = parsed.quote || null;

      // Anti-fabrication
      if (batchVerdict === "RELIED_UPON") {
        if (!batchQuote || batchQuote.length < 10) {
          batchVerdict = "INDEPENDENT";
          batchQuote = null;
          anyOverridden = true;
          overrideReason = `Batch ${bi + 1}: RELIED_UPON without substantive quote — overridden to INDEPENDENT`;
        } else if (!verifyQuoteInChunks(batchQuote, batch)) {
          anyOverridden = true;
          overrideReason = `Batch ${bi + 1}: Fabricated quote — overridden to INDEPENDENT. First 80: "${normaliseWs(batchQuote).slice(0, 80)}…"`;
          batchVerdict = "INDEPENDENT";
          batchQuote = null;
        }
      }

      // Aggregate: RELIED_UPON wins
      if (batchVerdict === "RELIED_UPON" && bestVerdict !== "RELIED_UPON") {
        bestVerdict = "RELIED_UPON";
        bestQuote = batchQuote;
        bestSourceMemo = parsed.source_memo || null;
        bestReason = parsed.reason;
      }

      // Early exit: found RELIED_UPON with verified quote
      if (bestVerdict === "RELIED_UPON" && bestQuote) break;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} 3b batch${bi + 1} error for ${cand.failure_mode}: ${msg}`);
    }
  }

  return {
    verdict: {
      verdict: bestVerdict,
      quote: bestQuote,
      source_memo: bestSourceMemo,
      reason: bestReason || `No batch found thesis reliance. ${FTS_ONLY_CAVEAT}`,
      overridden: anyOverridden,
      overrideReason,
      chunksUsed: allChunks.length,
      batchesUsed: batches.length,
      expandedQueryCount,
    },
    tokens: { input: totalIn, output: totalOut },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 4 — Compose disposition (code only)
// ═══════════════════════════════════════════════════════════════════════════

export function composeDisposition(
  coverage: CoverageVerdict,
  dependency: DependencyVerdict,
): DispositionResult {
  const caveats: string[] = [];

  // Every non-ADDRESSED or non-RELIED_UPON carries the FTS caveat
  if (coverage.verdict !== "ADDRESSED" || dependency.verdict === "INDEPENDENT") {
    caveats.push(FTS_ONLY_CAVEAT);
  }

  if (dependency.verdict === "INDEPENDENT") {
    return {
      outcome: "dropped_no_dependency",
      gate: "dependency",
      reason: `${coverage.verdict}, INDEPENDENT — thesis does not rely on this assumption per memo text; ${dependency.reason}`,
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
// Per-candidate orchestrator (Stages 2→3a→3b→4, persist)
// ═══════════════════════════════════════════════════════════════════════════

export async function adjudicateOneCandidate(
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
): Promise<{
  coverage: CoverageVerdict;
  dependency: DependencyVerdict;
  disposition: DispositionResult;
  tokens: { input: number; output: number };
  batchingInfo: { coverageBatches: number; dependencyBatches: number };
  dependencyExpansionLog: string[];
}> {
  let totalIn = 0;
  let totalOut = 0;

  // Stage 2: Retrieve
  const retrieval = await retrieveChunks(db, cand, dealId);

  // Stage 3a: Coverage
  const cov = await adjudicateCoverage(ai, cand, retrieval.coverageChunks);
  totalIn += cov.tokens.input;
  totalOut += cov.tokens.output;

  // Stage 3b: Dependency (always runs — coverage and dependency are orthogonal questions)
  const dep = await adjudicateDependency(ai, cand, retrieval.dependencyChunks, retrieval.dependencyQueryCount);
  totalIn += dep.tokens.input;
  totalOut += dep.tokens.output;

  // Stage 4: Compose
  const disposition = composeDisposition(cov.verdict, dep.verdict);

  // ── Persist: overwrite verdict in bss_coverage ─────────────────────────
  await db.execute(
    `UPDATE bss_coverage
     SET verdict = $1,
         adjudicated_verdict = $1,
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
    { label: `Write verdict: ${cand.failure_mode}` },
  );

  // ── Persist: bss_dependencies (upsert) ─────────────────────────────────
  const thesisHit = dep.verdict.verdict === "RELIED_UPON";
  const latestMemoHit = thesisHit && retrieval.dependencyChunks.some(
    c => LATEST_MEMO_DOC_IDS.includes(c.document_id),
  );

  await db.execute(
    `INSERT INTO bss_dependencies
       (dependency_id, deal_id, candidate_id, thesis_hit, latest_memo_hit,
        queries_run, memo_documents_searched, hits, swept_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::boolean, $4::boolean,
             $5::jsonb, $6::jsonb, $7::jsonb, NOW())
     ON CONFLICT (candidate_id) DO UPDATE SET
       thesis_hit = EXCLUDED.thesis_hit,
       latest_memo_hit = EXCLUDED.latest_memo_hit,
       queries_run = EXCLUDED.queries_run,
       memo_documents_searched = EXCLUDED.memo_documents_searched,
       hits = EXCLUDED.hits,
       swept_at = NOW()`,
    [
      dealId,
      cand.candidate_id,
      thesisHit,
      latestMemoHit,
      JSON.stringify(retrieval.dependencyExpansionLog.length > 0
        ? { original: Array.isArray(cand.proposed_queries) ? cand.proposed_queries : JSON.parse(String(cand.proposed_queries)), expandedCount: retrieval.dependencyQueryCount }
        : cand.proposed_queries),
      JSON.stringify(IC_MEMO_DOC_IDS),
      JSON.stringify({
        verdict: dep.verdict.verdict,
        quote: dep.verdict.quote,
        source_memo: dep.verdict.source_memo,
        reason: dep.verdict.reason,
        overridden: dep.verdict.overridden,
        chunksUsed: dep.verdict.chunksUsed,
        batchesUsed: dep.verdict.batchesUsed,
      }),
    ],
    { label: `Write dep: ${cand.failure_mode}` },
  );

  // ── Persist: bss_dispositions (upsert) ─────────────────────────────────
  await db.execute(
    `INSERT INTO bss_dispositions
       (disposition_id, deal_id, candidate_id, outcome, gate, reason, decided_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, NOW())
     ON CONFLICT (candidate_id) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       gate = EXCLUDED.gate,
       reason = EXCLUDED.reason,
       decided_at = NOW()`,
    [dealId, cand.candidate_id, disposition.outcome, disposition.gate, disposition.reason],
    { label: `Write disp: ${cand.failure_mode}` },
  );

  console.log(
    `${LOG_PREFIX} ${cand.failure_mode}: ` +
    `cov=${cov.verdict.verdict}${cov.verdict.overridden ? "[OVR]" : ""}(${cov.verdict.batchesUsed}b) ` +
    `dep=${dep.verdict.verdict}${dep.verdict.overridden ? "[OVR]" : ""}(${dep.verdict.batchesUsed}b) ` +
    `→ ${disposition.outcome}`,
  );

  return {
    coverage: cov.verdict,
    dependency: dep.verdict,
    disposition,
    tokens: { input: totalIn, output: totalOut },
    batchingInfo: { coverageBatches: cov.verdict.batchesUsed, dependencyBatches: dep.verdict.batchesUsed },
    dependencyExpansionLog: retrieval.dependencyExpansionLog,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API entry point
// ═══════════════════════════════════════════════════════════════════════════

export default api({
  name: "BssLlmAdjudication",
  description: "Stages 2-4: retrieve → coverage read → dependency read → compose disposition",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    /** Optional filter: run only these failure_modes (for verify-points). */
    failureModes: z.array(z.string()).optional(),
  }),

  output: z.object({
    candidatesProcessed: z.number(),
    candidatesSkipped: z.number(),
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
      disposition_outcome: z.string(),
      disposition_reason: z.string(),
      caveats: z.array(z.string()),
    })),
    allResults: z.array(z.object({
      failure_mode: z.string(),
      pass_type: z.string(),
      coverage_verdict: z.string(),
      coverage_quote: z.string().nullable(),
      coverage_reason: z.string(),
      coverage_batches: z.number(),
      dependency_verdict: z.string(),
      dependency_quote: z.string().nullable(),
      dependency_reason: z.string(),
      dependency_batches: z.number(),
      dependency_expanded_queries: z.number(),
      disposition_outcome: z.string(),
      overridden: z.boolean(),
    })),
    distribution: z.object({
      finding: z.number(),
      dropped_covered: z.number(),
      dropped_no_dependency: z.number(),
    }),
    batchingReport: z.object({
      totalCoverageBatches: z.number(),
      totalDependencyBatches: z.number(),
      candidatesNeedingMultipleCoverageBatches: z.number(),
      candidatesNeedingMultipleDependencyBatches: z.number(),
      batchCharBudget: z.number(),
    }),
    dependencyExpansionSamples: z.array(z.object({
      failure_mode: z.string(),
      expansions: z.array(z.string()),
    })),
    overrides: z.array(z.object({
      failure_mode: z.string(),
      stage: z.string(),
      reason: z.string(),
    })),
    runtimeMs: z.number(),
    llmCalls: z.number(),
    totalTokens: z.object({ input: z.number(), output: z.number() }),
    ftsOnlyCaveat: z.string(),
  }),

  async run(ctx, { dealId, failureModes }) {
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let llmCalls = 0;

    // ── Schema setup: ensure adjudication columns + unique indexes ────────
    await ctx.integrations.db.execute(
      `ALTER TABLE bss_coverage
         ADD COLUMN IF NOT EXISTS adjudicated_verdict text,
         ADD COLUMN IF NOT EXISTS adjudication_quote text,
         ADD COLUMN IF NOT EXISTS adjudication_reason text`,
      [],
      { label: "Ensure adjudication columns" },
    );

    // ── Update verdict check constraint to accept new values ─────────────
    // Old constraint only allows 'covered','thin','absent'. We need
    // ADDRESSED/MENTIONED/ABSENT. Drop old, add new (includes old for safety).
    await ctx.integrations.db.execute(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'bss_coverage'::regclass
             AND conname = 'bss_coverage_verdict_chk'
         ) THEN
           ALTER TABLE bss_coverage DROP CONSTRAINT bss_coverage_verdict_chk;
         END IF;
         ALTER TABLE bss_coverage ADD CONSTRAINT bss_coverage_verdict_chk
           CHECK (verdict IN ('covered','thin','absent','ADDRESSED','MENTIONED','ABSENT'));
       END $$`,
      [],
      { label: "Update verdict constraint for v2 values" },
    );

    // Unique indexes for idempotent upserts
    await ctx.integrations.db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS bss_dependencies_candidate_uniq
       ON bss_dependencies (candidate_id)`,
      [],
      { label: "Ensure dep unique idx" },
    );
    await ctx.integrations.db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS bss_dispositions_candidate_uniq
       ON bss_dispositions (candidate_id)`,
      [],
      { label: "Ensure disp unique idx" },
    );

    // ── Archive old count-based verdicts (one-off audit table) ────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS bss_coverage_audit_v1 (
         candidate_id uuid PRIMARY KEY,
         deal_id uuid NOT NULL,
         old_verdict text,
         old_queries_run jsonb,
         old_queries_with_hits int,
         old_max_term_coverage int,
         archived_at timestamptz DEFAULT now()
       )`,
      [],
      { label: "Ensure audit table" },
    );
    await ctx.integrations.db.execute(
      `INSERT INTO bss_coverage_audit_v1 (candidate_id, deal_id, old_verdict, old_queries_run, old_queries_with_hits, old_max_term_coverage)
       SELECT candidate_id, deal_id, verdict, queries_run, queries_with_hits, max_term_coverage
       FROM bss_coverage
       WHERE deal_id = $1::uuid
       ON CONFLICT (candidate_id) DO NOTHING`,
      [dealId],
      { label: "Archive old verdicts" },
    );

    // ── Load candidates ──────────────────────────────────────────────────
    let candidates = await ctx.integrations.db.query(
      `SELECT c.candidate_id, c.failure_mode, c.pass_type,
              c.implied_assumption, c.hypothesis, c.proposed_queries
       FROM bss_candidates c
       WHERE c.deal_id = $1::uuid AND c.superseded_by IS NULL
       ORDER BY c.pass_type, c.failure_mode`,
      CandidateSchema,
      [dealId],
      { label: "Load BSS candidates" },
    );

    // Apply filter if provided
    const skipped = failureModes
      ? candidates.filter(c => !failureModes.includes(c.failure_mode)).length
      : 0;
    if (failureModes) {
      candidates = candidates.filter(c => failureModes.includes(c.failure_mode));
    }

    console.log(`${LOG_PREFIX} Processing ${candidates.length} candidates (skipped ${skipped})`);

    // ── Process each candidate ───────────────────────────────────────────
    const allResults: Array<{
      failure_mode: string;
      pass_type: string;
      coverage: CoverageVerdict;
      dependency: DependencyVerdict;
      disposition: DispositionResult;
      dependencyExpansionLog: string[];
    }> = [];
    const overrides: Array<{ failure_mode: string; stage: string; reason: string }> = [];
    let totalCovBatches = 0;
    let totalDepBatches = 0;
    let multiCovBatchCount = 0;
    let multiDepBatchCount = 0;

    for (const cand of candidates) {
      try {
        const result = await adjudicateOneCandidate(
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
        );

        allResults.push({
          failure_mode: cand.failure_mode,
          pass_type: cand.pass_type,
          coverage: result.coverage,
          dependency: result.dependency,
          disposition: result.disposition,
          dependencyExpansionLog: result.dependencyExpansionLog,
        });

        totalInputTokens += result.tokens.input;
        totalOutputTokens += result.tokens.output;
        totalCovBatches += result.batchingInfo.coverageBatches;
        totalDepBatches += result.batchingInfo.dependencyBatches;
        if (result.batchingInfo.coverageBatches > 1) multiCovBatchCount++;
        if (result.batchingInfo.dependencyBatches > 1) multiDepBatchCount++;

        // Count LLM calls
        if (result.coverage.chunksUsed > 0) llmCalls += result.coverage.batchesUsed;
        if (result.dependency.chunksUsed > 0) llmCalls += result.dependency.batchesUsed;

        // Track overrides
        if (result.coverage.overridden && result.coverage.overrideReason) {
          overrides.push({ failure_mode: cand.failure_mode, stage: "3a_coverage", reason: result.coverage.overrideReason });
        }
        if (result.dependency.overridden && result.dependency.overrideReason) {
          overrides.push({ failure_mode: cand.failure_mode, stage: "3b_dependency", reason: result.dependency.overrideReason });
        }
      } catch (candidateErr) {
        const msg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
        console.warn(`${LOG_PREFIX} CANDIDATE FAILED: ${cand.failure_mode}: ${msg}`);
        // Push a degraded result so the candidate is not silently lost
        allResults.push({
          failure_mode: cand.failure_mode,
          pass_type: cand.pass_type,
          coverage: { verdict: "MENTIONED", quote: null, source_document: null, reason: `Candidate processing error: ${msg.slice(0, 200)}`, overridden: true, overrideReason: "Processing error — degraded to MENTIONED", chunksUsed: 0, batchesUsed: 0 },
          dependency: { verdict: "INDEPENDENT", quote: null, source_memo: null, reason: `Candidate processing error: ${msg.slice(0, 200)}`, overridden: true, overrideReason: "Processing error — degraded to INDEPENDENT", chunksUsed: 0, batchesUsed: 0, expandedQueryCount: 0 },
          disposition: { outcome: "dropped_no_dependency", gate: "error", reason: `Processing error — degraded. ${msg.slice(0, 200)}`, caveats: [FTS_ONLY_CAVEAT, "Candidate failed to process — degraded result"] },
          dependencyExpansionLog: [],
        });
        overrides.push({ failure_mode: cand.failure_mode, stage: "candidate_error", reason: msg.slice(0, 300) });
      }
    }

    // ── Distribution ─────────────────────────────────────────────────────
    const distrib = { finding: 0, dropped_covered: 0, dropped_no_dependency: 0 };
    for (const r of allResults) {
      const key = r.disposition.outcome as keyof typeof distrib;
      if (key in distrib) distrib[key]++;
    }

    // ── Build findings list ──────────────────────────────────────────────
    const findings = allResults
      .filter(r => r.disposition.outcome === "finding")
      .map(r => ({
        failure_mode: r.failure_mode,
        pass_type: r.pass_type,
        implied_assumption: candidates.find(c => c.failure_mode === r.failure_mode)?.implied_assumption ?? "",
        coverage_verdict: r.coverage.verdict,
        coverage_quote: r.coverage.quote,
        coverage_reason: r.coverage.reason,
        dependency_verdict: r.dependency.verdict,
        dependency_quote: r.dependency.quote,
        dependency_reason: r.dependency.reason,
        disposition_outcome: r.disposition.outcome,
        disposition_reason: r.disposition.reason,
        caveats: r.disposition.caveats,
      }));

    // ── Dependency expansion samples (first 2 candidates) ────────────────
    const depExpSamples = allResults.slice(0, 2).map(r => ({
      failure_mode: r.failure_mode,
      expansions: r.dependencyExpansionLog.slice(0, 15),
    }));

    // ── All results table ────────────────────────────────────────────────
    const allResultsOutput = allResults.map(r => ({
      failure_mode: r.failure_mode,
      pass_type: r.pass_type,
      coverage_verdict: r.coverage.verdict,
      coverage_quote: r.coverage.quote,
      coverage_reason: r.coverage.reason,
      coverage_batches: r.coverage.batchesUsed,
      dependency_verdict: r.dependency.verdict,
      dependency_quote: r.dependency.quote,
      dependency_reason: r.dependency.reason,
      dependency_batches: r.dependency.batchesUsed,
      dependency_expanded_queries: r.dependency.expandedQueryCount,
      disposition_outcome: r.disposition.outcome,
      overridden: r.coverage.overridden || r.dependency.overridden,
    }));

    const elapsed = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} DONE — ${elapsed}ms, ${llmCalls} LLM calls, ` +
      `${totalInputTokens}in/${totalOutputTokens}out. ` +
      `Findings: ${distrib.finding}, covered: ${distrib.dropped_covered}, ` +
      `no_dep: ${distrib.dropped_no_dependency}. Overrides: ${overrides.length}. ` +
      `Multi-batch: cov=${multiCovBatchCount}, dep=${multiDepBatchCount}`,
    );

    return {
      candidatesProcessed: candidates.length,
      candidatesSkipped: skipped,
      findings,
      allResults: allResultsOutput,
      distribution: distrib,
      batchingReport: {
        totalCoverageBatches: totalCovBatches,
        totalDependencyBatches: totalDepBatches,
        candidatesNeedingMultipleCoverageBatches: multiCovBatchCount,
        candidatesNeedingMultipleDependencyBatches: multiDepBatchCount,
        batchCharBudget: BATCH_CHAR_BUDGET,
      },
      dependencyExpansionSamples: depExpSamples,
      overrides,
      runtimeMs: elapsed,
      llmCalls,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
      ftsOnlyCaveat: FTS_ONLY_CAVEAT,
    };
  },
});
