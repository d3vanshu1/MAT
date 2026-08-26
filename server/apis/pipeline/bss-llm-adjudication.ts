/**
 * BSS v2 — Packet 4: LLM coverage adjudication.
 *
 * Replaces the count-based coverage verdict entirely. For each of the 37 live
 * candidates, retrieves matching chunks via FTS, then asks the LLM to read
 * them and judge whether the risk is ADDRESSED, MENTIONED, or ABSENT.
 *
 * SECTIONS:
 *   0. Schema migration (ADD COLUMN IF NOT EXISTS on bss_coverage)
 *   1. Retrieve + Read (FTS → LLM adjudication per candidate)
 *   2. Dependency filter (IC memo hit check for non-ADDRESSED candidates)
 *   3. Dispositions (finding / dropped_covered / dropped_no_dependency)
 *
 * RETIRED: MIN_TERM_COVERAGE, hit-count floors, breadth thresholds.
 * The counting rule was a proxy for reading comprehension — now done directly.
 *
 * RUN AUTHORIZATION: read-only queries; LLM calls (Sonnet); UPDATEs to
 * bss_coverage; INSERTs to bss_dependencies and bss_dispositions.
 * Deal c46b4129-8a16-48ae-ad3a-1da061255445.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-ADJUDICATE]";

/** Max chunks fed to the LLM per candidate (by ts_rank). */
const MAX_CHUNKS_PER_CANDIDATE = 8;

/** Max FTS results per query before ranking. */
const MAX_HITS_PER_QUERY = 15;

/** LLM max output tokens — short structured answer. */
const MAX_OUTPUT_TOKENS = 1024;

/**
 * IC memo document IDs for the dependency check.
 * "thesis_hit" = any of these 4; "latest_memo_hit" = 3rd IC or IC Update.
 */
const IC_MEMO_DOC_IDS = [
  "8fb7f474-18ed-46dc-be55-dd3c30b86f5f", // 2nd IC Memo
  "31b3df2f-f8a1-41d8-b2a8-1c2b7b4eb69e", // 3rd IC Memo
  "6197a6b2-38ce-4cbf-8df9-5d2e68edf5f3", // IC Update
  "440a86fb-6a0b-4fd8-ada4-b4b8e7d5cf10", // Screening Memo
];
const LATEST_MEMO_DOC_IDS = [
  "31b3df2f-f8a1-41d8-b2a8-1c2b7b4eb69e", // 3rd IC Memo
  "6197a6b2-38ce-4cbf-8df9-5d2e68edf5f3", // IC Update
];

// ---------------------------------------------------------------------------
// FTS helper — same sanitisation as bss-absence-sweep
// ---------------------------------------------------------------------------

function sanitiseForFts(q: string): string {
  return q.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalise whitespace for quote substring matching.
 * Collapses runs of any whitespace (including newlines) to a single space.
 */
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
  proposed_queries: z.any(), // JSONB → string[]
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
// LLM response parser
// ---------------------------------------------------------------------------

interface AdjudicationResult {
  verdict: "ADDRESSED" | "MENTIONED" | "ABSENT";
  quote: string;
  reason: string;
  overridden: boolean;
  overrideReason?: string;
}

function parseAdjudicationResponse(text: string): {
  verdict: string;
  quote: string;
  reason: string;
} {
  // The model should respond with ADDRESSED/MENTIONED/ABSENT, an optional quote, and a reason.
  // Be flexible in parsing — look for the verdict keyword first.
  const upper = text.toUpperCase();
  let verdict = "MENTIONED"; // default if unparseable

  if (upper.includes("ADDRESSED")) verdict = "ADDRESSED";
  else if (upper.includes("ABSENT")) verdict = "ABSENT";
  else if (upper.includes("MENTIONED")) verdict = "MENTIONED";

  // Extract quote — look for text between quotes or after "Quote:" / "Passage:"
  let quote = "";
  // Try explicit quote markers
  const quotePatterns = [
    /[Qq]uote:\s*"([^"]+)"/,
    /[Qq]uote:\s*["""]([^"""]+)["""]/,
    /[Pp]assage:\s*"([^"]+)"/,
    /"([^"]{20,})"/,         // any substantial quoted text
    /["""]([^"""]{20,})["""]/, // smart quotes
  ];
  for (const pat of quotePatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      quote = m[1].trim();
      break;
    }
  }

  // Extract reason — last sentence or after "Reason:" / "Reasoning:"
  let reason = "";
  const reasonMatch = text.match(/[Rr]eason(?:ing)?:\s*(.+)/s);
  if (reasonMatch) {
    reason = reasonMatch[1].trim().split("\n")[0].trim();
  } else {
    // Fall back: last non-empty line
    const lines = text.trim().split("\n").filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      reason = lines[lines.length - 1].trim();
    }
  }

  return { verdict, quote, reason };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "BssLlmAdjudication",
  description: "LLM reading-comprehension adjudication for BSS candidates with dependency and disposition",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    section0: z.object({
      candidateCount: z.number(),
      columnsAdded: z.boolean(),
      dependenciesEmpty: z.boolean(),
      dispositionsEmpty: z.boolean(),
    }),
    section1: z.object({
      adjudications: z.array(z.object({
        failure_mode: z.string(),
        pass_type: z.string(),
        adjudicated_verdict: z.string(),
        old_verdict: z.string(),
        quote: z.string(),
        reason: z.string(),
        chunks_retrieved: z.number(),
        docs_retrieved: z.number(),
        overridden: z.boolean(),
        overrideReason: z.string().nullable(),
      })),
      verdictDistribution: z.object({
        ADDRESSED: z.number(),
        MENTIONED: z.number(),
        ABSENT: z.number(),
      }),
      disagreements: z.array(z.any()),
    }),
    section2: z.object({
      dependencyRows: z.number(),
      results: z.array(z.any()),
    }),
    section3: z.object({
      dispositionRows: z.number(),
      findings: z.array(z.any()),
      distribution: z.object({
        finding: z.number(),
        dropped_covered: z.number(),
        dropped_no_dependency: z.number(),
      }),
    }),
    runtimeMs: z.number(),
    llmCalls: z.number(),
    totalTokens: z.object({ input: z.number(), output: z.number() }),
  }),

  async run(ctx, { dealId }) {
    const startTime = Date.now();
    let llmCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 0 — State checks & schema migration
    // ═══════════════════════════════════════════════════════════════════════

    // 0a. Add adjudication columns if not present
    await ctx.integrations.db.execute(
      `ALTER TABLE bss_coverage
         ADD COLUMN IF NOT EXISTS adjudicated_verdict text,
         ADD COLUMN IF NOT EXISTS adjudication_quote text,
         ADD COLUMN IF NOT EXISTS adjudication_reason text`,
      [],
      { label: "Add adjudication columns" },
    );
    console.log(`${LOG_PREFIX} Adjudication columns ensured`);

    // 0b. Load candidates
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
    console.log(`${LOG_PREFIX} Loaded ${candidates.length} live candidates`);

    // 0c. Load existing coverage verdicts for comparison
    const oldVerdicts = await ctx.integrations.db.query(
      `SELECT candidate_id, verdict FROM bss_coverage WHERE deal_id = $1::uuid`,
      z.object({ candidate_id: z.string(), verdict: z.string() }),
      [dealId],
      { label: "Load old coverage verdicts" },
    );
    const oldVerdictMap = new Map(oldVerdicts.map(r => [r.candidate_id, r.verdict]));

    // 0d. Verify dependencies and dispositions are empty
    const depCount = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM bss_dependencies WHERE deal_id = $1::uuid`,
      z.object({ cnt: z.coerce.number() }),
      [dealId],
      { label: "Check bss_dependencies empty" },
    );
    const dispCount = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM bss_dispositions WHERE deal_id = $1::uuid`,
      z.object({ cnt: z.coerce.number() }),
      [dealId],
      { label: "Check bss_dispositions empty" },
    );

    const dependenciesEmpty = depCount[0].cnt === 0;
    const dispositionsEmpty = dispCount[0].cnt === 0;

    if (!dependenciesEmpty || !dispositionsEmpty) {
      throw new Error(
        `STOP: bss_dependencies has ${depCount[0].cnt} rows, bss_dispositions has ${dispCount[0].cnt} rows. ` +
        `Both must be empty before adjudication.`
      );
    }

    console.log(`${LOG_PREFIX} Section 0 OK: ${candidates.length} candidates, deps/disps empty, columns added`);

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 1 — Retrieve + Read (FTS → LLM adjudication)
    // ═══════════════════════════════════════════════════════════════════════

    const adjudications: Array<{
      candidate_id: string;
      failure_mode: string;
      pass_type: string;
      adjudicated_verdict: string;
      old_verdict: string;
      quote: string;
      reason: string;
      chunks_retrieved: number;
      docs_retrieved: number;
      overridden: boolean;
      overrideReason: string | null;
      retrievedDocNames: string[];
    }> = [];

    for (const cand of candidates) {
      const queries: string[] = Array.isArray(cand.proposed_queries)
        ? cand.proposed_queries
        : JSON.parse(String(cand.proposed_queries));

      // ── FTS retrieval across all documents ──────────────────────────────
      const queryInput = queries.map((qt, idx) => ({
        idx,
        qt: sanitiseForFts(qt),
      }));

      let hitRows: Array<z.infer<typeof ChunkHitSchema>> = [];
      try {
        hitRows = await ctx.integrations.db.query(
          `WITH qi AS (
             SELECT (j->>'idx')::int AS query_idx,
                    j->>'qt'         AS query_text
             FROM jsonb_array_elements($1::jsonb) AS j
           ),
           matched AS (
             SELECT qi.query_idx,
                    dc.id        AS chunk_id,
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
          [JSON.stringify(queryInput), dealId],
          { label: `FTS: ${cand.failure_mode}` },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} FTS error for ${cand.failure_mode}: ${msg}`);
        // Treat FTS error as absent
        hitRows = [];
      }

      // Deduplicate chunks by chunk_id (same chunk may match multiple queries)
      const seenChunks = new Map<string, z.infer<typeof ChunkHitSchema>>();
      for (const hit of hitRows) {
        const existing = seenChunks.get(hit.chunk_id);
        if (!existing || hit.rank > existing.rank) {
          seenChunks.set(hit.chunk_id, hit);
        }
      }

      // Take top MAX_CHUNKS_PER_CANDIDATE by rank
      const uniqueHits = Array.from(seenChunks.values())
        .sort((a, b) => b.rank - a.rank)
        .slice(0, MAX_CHUNKS_PER_CANDIDATE);

      const docsRetrieved = new Set(uniqueHits.map(h => h.document_id));
      const docNames = [...new Set(uniqueHits.map(h => h.file_name))];

      const oldVerdict = oldVerdictMap.get(cand.candidate_id) ?? "unknown";

      // ── If zero chunks, verdict is ABSENT with no LLM call ─────────────
      if (uniqueHits.length === 0) {
        adjudications.push({
          candidate_id: cand.candidate_id,
          failure_mode: cand.failure_mode,
          pass_type: cand.pass_type,
          adjudicated_verdict: "ABSENT",
          old_verdict: oldVerdict,
          quote: "",
          reason: "no retrieval",
          chunks_retrieved: 0,
          docs_retrieved: 0,
          overridden: false,
          overrideReason: null,
          retrievedDocNames: [],
        });
        console.log(`${LOG_PREFIX} ${cand.failure_mode}: ABSENT (no retrieval)`);
        continue;
      }

      // ── Build context for LLM ──────────────────────────────────────────
      const chunkTexts = uniqueHits.map(
        (h, i) => `[Passage ${i + 1}, from "${h.file_name}", chunk ${h.chunk_index}]\n${h.content}`
      ).join("\n\n---\n\n");

      // The full retrieved text for quote verification
      const allRetrievedText = normaliseWs(uniqueHits.map(h => h.content).join(" "));

      const systemPrompt = `You are a diligence analyst reviewing whether a specific risk assumption has been addressed in deal documents. Be precise and ground your answer in the supplied text only.`;

      const userPrompt = `Here is a risk assumption an investor is relying on, and passages retrieved from the deal's diligence documents.

RISK / FAILURE MODE: ${cand.failure_mode}
IMPLIED ASSUMPTION: ${cand.implied_assumption}
HYPOTHESIS: ${cand.hypothesis}

RETRIEVED PASSAGES (${uniqueHits.length} passages from ${docsRetrieved.size} documents):

${chunkTexts}

---

Does the diligence ADDRESS this risk — does it investigate, test, or provide evidence bearing on whether the assumption holds? Or does it merely MENTION the topic without engaging the risk? Answer with one of: ADDRESSED, MENTIONED, ABSENT.

If ADDRESSED, quote the single sentence or passage that most directly engages the risk — verbatim, from the supplied text. If you cannot quote such a passage, the answer is not ADDRESSED.

Then one sentence of reasoning.

Format your response as:
Verdict: [ADDRESSED/MENTIONED/ABSENT]
Quote: "[verbatim quote if ADDRESSED, otherwise empty]"
Reason: [one sentence]`;

      // ── LLM call ──────────────────────────────────────────────────────
      let adjResult: AdjudicationResult;
      try {
        const llmResponse = await ctx.integrations.ai.apiRequest(
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
          { label: `Adjudicate: ${cand.failure_mode}` },
        );

        llmCalls++;
        totalInputTokens += llmResponse.usage.input_tokens;
        totalOutputTokens += llmResponse.usage.output_tokens;

        const responseText = llmResponse.content
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join("");

        const parsed = parseAdjudicationResponse(responseText);

        // ── Quote verification (ADDRESSED only) ─────────────────────────
        let overridden = false;
        let overrideReason: string | undefined;
        let finalVerdict = parsed.verdict as "ADDRESSED" | "MENTIONED" | "ABSENT";
        let finalQuote = parsed.quote;

        if (finalVerdict === "ADDRESSED") {
          if (!finalQuote || finalQuote.length < 10) {
            // No meaningful quote → override to MENTIONED
            overridden = true;
            overrideReason = "ADDRESSED without quote — overridden to MENTIONED";
            finalVerdict = "MENTIONED";
            finalQuote = "";
          } else {
            // Verify quote is a substring of retrieved text
            const normQuote = normaliseWs(finalQuote);
            if (!allRetrievedText.includes(normQuote)) {
              // Try a looser match: check each chunk individually
              let found = false;
              for (const hit of uniqueHits) {
                const normChunk = normaliseWs(hit.content);
                if (normChunk.includes(normQuote)) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                overridden = true;
                overrideReason = `Quote not found in retrieved chunks (first 80 chars: "${normQuote.slice(0, 80)}…") — overridden to MENTIONED`;
                finalVerdict = "MENTIONED";
                // Keep the quote in the record for audit but override verdict
              }
            }
          }
        }

        adjResult = {
          verdict: finalVerdict,
          quote: finalQuote,
          reason: parsed.reason,
          overridden,
          overrideReason,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} LLM error for ${cand.failure_mode}: ${msg}`);
        // On LLM error, fall back to MENTIONED (conservative)
        adjResult = {
          verdict: "MENTIONED",
          quote: "",
          reason: `LLM call failed: ${msg.slice(0, 200)}`,
          overridden: true,
          overrideReason: `LLM error — defaulted to MENTIONED`,
        };
      }

      adjudications.push({
        candidate_id: cand.candidate_id,
        failure_mode: cand.failure_mode,
        pass_type: cand.pass_type,
        adjudicated_verdict: adjResult.verdict,
        old_verdict: oldVerdict,
        quote: adjResult.quote,
        reason: adjResult.reason,
        chunks_retrieved: uniqueHits.length,
        docs_retrieved: docsRetrieved.size,
        overridden: adjResult.overridden,
        overrideReason: adjResult.overrideReason ?? null,
        retrievedDocNames: docNames,
      });

      console.log(
        `${LOG_PREFIX} ${cand.failure_mode}: ${adjResult.verdict}` +
        `${adjResult.overridden ? " [OVERRIDDEN]" : ""}` +
        ` (${uniqueHits.length} chunks, ${docsRetrieved.size} docs)` +
        ` old=${oldVerdict}`
      );
    }

    // ── Write adjudication results to bss_coverage ────────────────────────
    for (const adj of adjudications) {
      await ctx.integrations.db.execute(
        `UPDATE bss_coverage
         SET adjudicated_verdict = $1,
             adjudication_quote = $2,
             adjudication_reason = $3
         WHERE candidate_id = $4::uuid AND deal_id = $5::uuid`,
        [adj.adjudicated_verdict, adj.quote, adj.reason, adj.candidate_id, dealId],
        { label: `Update coverage: ${adj.failure_mode}` },
      );
    }
    console.log(`${LOG_PREFIX} Updated ${adjudications.length} bss_coverage rows`);

    // ── Verdict distribution & disagreements ──────────────────────────────
    const verdictDist = { ADDRESSED: 0, MENTIONED: 0, ABSENT: 0 };
    for (const a of adjudications) {
      verdictDist[a.adjudicated_verdict as keyof typeof verdictDist]++;
    }

    // Map adjudicated to coverage tier for comparison
    const tierMap: Record<string, string> = {
      ADDRESSED: "covered",
      MENTIONED: "thin",
      ABSENT: "absent",
    };
    const disagreements = adjudications
      .filter(a => {
        const newTier = tierMap[a.adjudicated_verdict] ?? "unknown";
        return newTier !== a.old_verdict;
      })
      .map(a => ({
        failure_mode: a.failure_mode,
        old_verdict: a.old_verdict,
        adjudicated_verdict: a.adjudicated_verdict,
        new_tier: tierMap[a.adjudicated_verdict],
        reason: a.reason,
      }));

    console.log(
      `${LOG_PREFIX} Section 1 DONE: ADDRESSED=${verdictDist.ADDRESSED} ` +
      `MENTIONED=${verdictDist.MENTIONED} ABSENT=${verdictDist.ABSENT} ` +
      `disagreements=${disagreements.length}`
    );

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 2 — Dependency filter (non-ADDRESSED candidates only)
    // ═══════════════════════════════════════════════════════════════════════

    const nonAddressed = adjudications.filter(a => a.adjudicated_verdict !== "ADDRESSED");
    const dependencyResults: Array<{
      candidate_id: string;
      failure_mode: string;
      thesis_hit: boolean;
      latest_memo_hit: boolean;
      memo_hits: Array<{ document_id: string; file_name: string; hit_count: number }>;
    }> = [];

    for (const adj of nonAddressed) {
      // Get the candidate's queries
      const cand = candidates.find(c => c.candidate_id === adj.candidate_id)!;
      const queries: string[] = Array.isArray(cand.proposed_queries)
        ? cand.proposed_queries
        : JSON.parse(String(cand.proposed_queries));

      const queryInput = queries.map((qt, idx) => ({
        idx,
        qt: sanitiseForFts(qt),
      }));

      // Search only IC memo documents
      let memoHits: Array<{ document_id: string; file_name: string; hit_count: number }> = [];
      try {
        const rows = await ctx.integrations.db.query(
          `WITH qi AS (
             SELECT (j->>'idx')::int AS query_idx,
                    j->>'qt'         AS query_text
             FROM jsonb_array_elements($1::jsonb) AS j
           )
           SELECT dc.document_id,
                  dc.file_name,
                  COUNT(DISTINCT dc.id)::int AS hit_count
           FROM qi
           JOIN document_chunks dc
             ON dc.deal_id = $2::uuid
            AND dc.document_id = ANY($3::uuid[])
            AND dc.tsv @@ websearch_to_tsquery('english', qi.query_text)
           GROUP BY dc.document_id, dc.file_name
           ORDER BY hit_count DESC`,
          z.object({
            document_id: z.string(),
            file_name: z.string(),
            hit_count: z.coerce.number(),
          }),
          [JSON.stringify(queryInput), dealId, IC_MEMO_DOC_IDS],
          { label: `Dependency: ${adj.failure_mode}` },
        );
        memoHits = rows;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} Dependency FTS error for ${adj.failure_mode}: ${msg}`);
      }

      const thesis_hit = memoHits.length > 0;
      const latest_memo_hit = memoHits.some(h =>
        LATEST_MEMO_DOC_IDS.includes(h.document_id)
      );

      dependencyResults.push({
        candidate_id: adj.candidate_id,
        failure_mode: adj.failure_mode,
        thesis_hit,
        latest_memo_hit,
        memo_hits: memoHits,
      });

      console.log(
        `${LOG_PREFIX} Dependency: ${adj.failure_mode}: thesis_hit=${thesis_hit} latest_memo_hit=${latest_memo_hit} ` +
        `(${memoHits.length} memo docs matched)`
      );
    }

    // ── Insert dependency rows ────────────────────────────────────────────
    if (dependencyResults.length > 0) {
      await ctx.integrations.db.execute(
        `INSERT INTO bss_dependencies
           (deal_id, candidate_id, thesis_hit, latest_memo_hit,
            queries_run, memo_documents_searched, hits, swept_at)
         SELECT
           $1::uuid,
           (j->>'candidate_id')::uuid,
           (j->>'thesis_hit')::boolean,
           (j->>'latest_memo_hit')::boolean,
           j->'queries_run',
           j->'memo_documents_searched',
           j->'memo_hits',
           NOW()
         FROM jsonb_array_elements($2::jsonb) AS j`,
        [
          dealId,
          JSON.stringify(dependencyResults.map(d => {
            const cand = candidates.find(c => c.candidate_id === d.candidate_id)!;
            const queries: string[] = Array.isArray(cand.proposed_queries)
              ? cand.proposed_queries
              : JSON.parse(String(cand.proposed_queries));
            return {
              candidate_id: d.candidate_id,
              thesis_hit: d.thesis_hit,
              latest_memo_hit: d.latest_memo_hit,
              queries_run: queries,
              memo_documents_searched: IC_MEMO_DOC_IDS,
              memo_hits: d.memo_hits,
            };
          })),
        ],
        { label: "Insert bss_dependencies" },
      );
      console.log(`${LOG_PREFIX} Inserted ${dependencyResults.length} dependency rows`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 3 — Dispositions
    // ═══════════════════════════════════════════════════════════════════════

    const depMap = new Map(dependencyResults.map(d => [d.candidate_id, d]));

    const dispositions: Array<{
      candidate_id: string;
      failure_mode: string;
      outcome: string;
      gate: string;
      reason: string;
      adjudicated_verdict: string;
      pass_type: string;
    }> = [];

    for (const adj of adjudications) {
      if (adj.adjudicated_verdict === "ADDRESSED") {
        dispositions.push({
          candidate_id: adj.candidate_id,
          failure_mode: adj.failure_mode,
          outcome: "dropped_covered",
          gate: "coverage",
          reason: `ADDRESSED — ${adj.reason}`,
          adjudicated_verdict: adj.adjudicated_verdict,
          pass_type: adj.pass_type,
        });
      } else {
        // MENTIONED or ABSENT — check dependency
        const dep = depMap.get(adj.candidate_id);
        if (!dep || !dep.thesis_hit) {
          dispositions.push({
            candidate_id: adj.candidate_id,
            failure_mode: adj.failure_mode,
            outcome: "dropped_no_dependency",
            gate: "dependency",
            reason: `${adj.adjudicated_verdict} — no thesis dependency in IC memos; ${adj.reason}`,
            adjudicated_verdict: adj.adjudicated_verdict,
            pass_type: adj.pass_type,
          });
        } else {
          dispositions.push({
            candidate_id: adj.candidate_id,
            failure_mode: adj.failure_mode,
            outcome: "finding",
            gate: "dependency",
            reason: `${adj.adjudicated_verdict} — ${adj.reason}; thesis relies on this per ${dep.latest_memo_hit ? "3rd IC/Update" : "IC memos"}`,
            adjudicated_verdict: adj.adjudicated_verdict,
            pass_type: adj.pass_type,
          });
        }
      }
    }

    // ── Insert disposition rows ────────────────────────────────────────────
    if (dispositions.length > 0) {
      await ctx.integrations.db.execute(
        `INSERT INTO bss_dispositions
           (deal_id, candidate_id, outcome, gate, reason, decided_at)
         SELECT
           $1::uuid,
           (j->>'candidate_id')::uuid,
           j->>'outcome',
           j->>'gate',
           j->>'reason',
           NOW()
         FROM jsonb_array_elements($2::jsonb) AS j`,
        [
          dealId,
          JSON.stringify(dispositions.map(d => ({
            candidate_id: d.candidate_id,
            outcome: d.outcome,
            gate: d.gate,
            reason: d.reason,
          }))),
        ],
        { label: "Insert bss_dispositions" },
      );
      console.log(`${LOG_PREFIX} Inserted ${dispositions.length} disposition rows`);
    }

    // ── Distribution ──────────────────────────────────────────────────────
    const distrib = { finding: 0, dropped_covered: 0, dropped_no_dependency: 0 };
    for (const d of dispositions) {
      distrib[d.outcome as keyof typeof distrib]++;
    }

    // ── Build findings list ───────────────────────────────────────────────
    const findings = dispositions
      .filter(d => d.outcome === "finding")
      .map(d => {
        const adj = adjudications.find(a => a.candidate_id === d.candidate_id)!;
        const dep = depMap.get(d.candidate_id);
        const cand = candidates.find(c => c.candidate_id === d.candidate_id)!;
        return {
          failure_mode: d.failure_mode,
          implied_assumption: cand.implied_assumption,
          hypothesis: cand.hypothesis,
          pass_type: d.pass_type,
          adjudicated_verdict: d.adjudicated_verdict,
          quote: adj.quote,
          adjudication_reason: adj.reason,
          thesis_hit: dep?.thesis_hit ?? false,
          latest_memo_hit: dep?.latest_memo_hit ?? false,
          dependency_evidence: dep?.memo_hits ?? [],
          disposition_reason: d.reason,
        };
      });

    const elapsed = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} COMPLETE — ${elapsed}ms, ${llmCalls} LLM calls, ` +
      `tokens: ${totalInputTokens}in/${totalOutputTokens}out. ` +
      `Findings: ${distrib.finding}, dropped_covered: ${distrib.dropped_covered}, ` +
      `dropped_no_dependency: ${distrib.dropped_no_dependency}`
    );

    return {
      section0: {
        candidateCount: candidates.length,
        columnsAdded: true,
        dependenciesEmpty,
        dispositionsEmpty,
      },
      section1: {
        adjudications: adjudications.map(a => ({
          failure_mode: a.failure_mode,
          pass_type: a.pass_type,
          adjudicated_verdict: a.adjudicated_verdict,
          old_verdict: a.old_verdict,
          quote: a.quote,
          reason: a.reason,
          chunks_retrieved: a.chunks_retrieved,
          docs_retrieved: a.docs_retrieved,
          overridden: a.overridden,
          overrideReason: a.overrideReason,
        })),
        verdictDistribution: verdictDist,
        disagreements,
      },
      section2: {
        dependencyRows: dependencyResults.length,
        results: dependencyResults.map(d => ({
          failure_mode: d.failure_mode,
          thesis_hit: d.thesis_hit,
          latest_memo_hit: d.latest_memo_hit,
          memo_docs_matched: d.memo_hits.length,
        })),
      },
      section3: {
        dispositionRows: dispositions.length,
        findings,
        distribution: distrib,
      },
      runtimeMs: elapsed,
      llmCalls,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    };
  },
});
