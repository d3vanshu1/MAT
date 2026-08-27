/**
 * BSS v2 — Packet 3: absence sweep.
 *
 * For each live BSS candidate, runs every proposed_query via
 * websearch_to_tsquery against ALL document_chunks for the deal (no tag
 * filter, no document subset). A chunk counts as a HIT only if it clears
 * MIN_TERM_COVERAGE — how many of the query's content terms (lowercased,
 * stopwords removed) appear as whole words in the chunk text.
 *
 * Verdict by counting queries that produced at least one hit:
 *   0 queries hit → absent
 *   1 query hit   → thin
 *   2+ queries hit → covered
 *
 * Writes one bss_coverage row per candidate. Does not delete or overwrite —
 * a duplicate sweep is caught by Section 0's count check before this runs.
 *
 * DOES NOT run an alternate-wording guard. Absence is deliberately
 * over-reported. Every "absent" verdict is provisional pending that guard
 * in a later packet.
 *
 * BOILERPLATE TRACKING: if ALL of a candidate's hits land in chunks the
 * boilerplate classifier flags, boilerplate_only is set true — a real signal
 * even without the alternate-wording guard.
 *
 * expansion_ran and expansion_overturned are set false throughout — no
 * alternate-wording expansion in this packet.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { contentTerms } from "./bss-generate.js";
import { classifyChunk } from "./bss-chunk-quality.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const LOG_PREFIX = "[BSS-SWEEP]";

// ---------------------------------------------------------------------------
// Threshold — calibrated in Section 4 before trusting any verdict
// ---------------------------------------------------------------------------

/**
 * Minimum fraction of a query's content terms (lowercased, stopwords removed)
 * that must appear as whole words in a matching chunk for that chunk to count
 * as a HIT.
 *
 * 0.3 = at least 30% of content terms must appear.
 *   4-term query → need ≥ 2 terms (2/4=0.50 ≥ 0.3)
 *   3-term query → need ≥ 1 term  (1/3=0.33 ≥ 0.3)
 *   5-term query → need ≥ 2 terms (2/5=0.40 ≥ 0.3)
 *
 * This is a starting value. Section 4 calibration against
 * pstn_switch_off_exposure (must come back covered) determines whether this
 * value separates correctly. If pstn is absent, this value or the query
 * mechanics are broken and no verdict is trustworthy.
 */
export const MIN_TERM_COVERAGE = 0.3;

/**
 * Max FTS results per query. Limits data transfer per candidate. Top hits by
 * ts_rank are the most likely to pass term coverage; the tail is noise.
 */
const MAX_HITS_PER_QUERY = 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape special regex characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitise a query string for websearch_to_tsquery.
 *
 * websearch_to_tsquery interprets `-word` as NOT, which would suppress
 * legitimate hits on queries like "switch-off". Replace hyphens with spaces
 * so all terms are ANDed.
 */
function sanitiseForFts(q: string): string {
  return q.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Compute term coverage: how many of the query's content terms appear as
 * whole words in the chunk text. Uses the same contentTerms + stopword logic
 * as the generator (exported from bss-generate.ts, not reimplemented).
 */
function computeTermCoverage(
  queryText: string,
  chunkContent: string,
): {
  matched: number;
  total: number;
  ratio: number;
  matchedTerms: string[];
} {
  const terms = contentTerms(queryText);
  if (terms.size === 0) {
    return { matched: 0, total: 0, ratio: 0, matchedTerms: [] };
  }

  const contentLower = chunkContent.toLowerCase();
  const matchedTerms: string[] = [];

  for (const term of terms) {
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`);
    if (regex.test(contentLower)) {
      matchedTerms.push(term);
    }
  }

  return {
    matched: matchedTerms.length,
    total: terms.size,
    ratio: terms.size > 0 ? matchedTerms.length / terms.size : 0,
    matchedTerms,
  };
}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const CandidateSchema = z.object({
  candidate_id: z.string(),
  failure_mode: z.string(),
  pass_type: z.string(),
  proposed_queries: z.any(), // JSONB → JS array of strings
});

const DocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
});

const InsertedCountSchema = z.object({
  cnt: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "BssAbsenceSweep",
  description: "Searches corpus for each BSS candidate and records coverage verdicts",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    totalCandidates: z.number(),
    totalSearches: z.number(),
    verdicts: z.object({
      covered: z.number(),
      thin: z.number(),
      absent: z.number(),
    }),
    byPassType: z.any(),
    runtimeMs: z.number(),
    checkpointingNeeded: z.boolean(),
  }),

  async run(ctx, { dealId }) {
    const startTime = Date.now();

    // ── 1. Load all live candidates ──────────────────────────────────────
    const candidates = await ctx.integrations.db.query(
      `SELECT candidate_id, failure_mode, pass_type, proposed_queries
       FROM bss_candidates
       WHERE deal_id = $1::uuid AND superseded_by IS NULL
       ORDER BY pass_type, failure_mode`,
      CandidateSchema,
      [dealId],
      { label: "Load live BSS candidates" },
    );
    console.log(`${LOG_PREFIX} Loaded ${candidates.length} live candidates`);

    // ── 2. Load documents that have indexed chunks (= actually searched) ─
    const docs = await ctx.integrations.db.query(
      `SELECT DISTINCT d.id, d.file_name
       FROM documents d
       JOIN document_chunks dc ON dc.document_id = d.id
       WHERE d.deal_id = $1::uuid
       ORDER BY d.file_name`,
      DocSchema,
      [dealId],
      { label: "Load searchable documents" },
    );
    const documentsSearched = docs.map((d) => ({ id: d.id, file_name: d.file_name }));
    console.log(`${LOG_PREFIX} ${docs.length} searchable documents in corpus`);

    // ── 3. Sweep each candidate ──────────────────────────────────────────
    const coverageRows: any[] = [];
    let totalSearches = 0;

    for (const cand of candidates) {
      const queries: string[] = Array.isArray(cand.proposed_queries)
        ? cand.proposed_queries
        : JSON.parse(String(cand.proposed_queries));

      totalSearches += queries.length;

      // Prepare JSONB input: sanitised query text + original for recording
      const queryInput = queries.map((qt, idx) => ({
        idx,
        qt: sanitiseForFts(qt),
      }));

      let hitRows: any[] = [];
      try {
        const raw = await ctx.integrations.db.query(
          `WITH qi AS (
             SELECT (j->>'idx')::int AS query_idx,
                    j->>'qt'         AS query_text
             FROM jsonb_array_elements($1::jsonb) AS j
           ),
           matched AS (
             SELECT qi.query_idx, qi.query_text,
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
           SELECT query_idx, query_text, chunk_id, document_id,
                  file_name, chunk_index, content, rank
           FROM matched
           WHERE rn <= ${MAX_HITS_PER_QUERY}
           ORDER BY query_idx, rank DESC`,
          z.any(),
          [JSON.stringify(queryInput), dealId],
          { label: `FTS: ${cand.failure_mode}` },
        );
        hitRows = Array.isArray(raw) ? raw : [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} FTS error for ${cand.failure_mode}: ${msg}`);
        coverageRows.push({
          candidate_id: cand.candidate_id,
          deal_id: dealId,
          verdict: "absent",
          queries_run: queries,
          queries_with_hits: 0,
          documents_searched: documentsSearched,
          documents_with_hits: 0,
          max_term_coverage: 0,
          hits: [{ error: msg }],
          boilerplate_only: false,
          expansion_ran: false,
          expansion_overturned: false,
        });
        continue;
      }

      // ── Process hits: term coverage + boilerplate ────────────────────
      const queriesWithHitSet = new Set<number>();
      const docsWithHitSet = new Set<string>();
      let maxCovRatio = 0;
      let allBoilerplate = true;
      let anyHit = false;
      const processedHits: any[] = [];

      for (const row of hitRows) {
        const qIdx = Number(row.query_idx);
        // Use the ORIGINAL (unsanitised) query for term coverage so terms
        // like "switch-off" decompose into ["switch", "off"] naturally
        const originalQuery = queries[qIdx] ?? row.query_text;
        const content = String(row.content ?? "");

        const cov = computeTermCoverage(originalQuery, content);
        if (cov.ratio < MIN_TERM_COVERAGE) continue;

        // Valid hit
        anyHit = true;
        queriesWithHitSet.add(qIdx);
        docsWithHitSet.add(row.document_id);
        if (cov.ratio > maxCovRatio) maxCovRatio = cov.ratio;

        const bp = classifyChunk(content);
        if (!bp.isBoilerplate) allBoilerplate = false;

        processedHits.push({
          document_id: row.document_id,
          file_name: row.file_name,
          chunk_index: Number(row.chunk_index),
          matched_terms: cov.matchedTerms,
          term_coverage: Math.round(cov.ratio * 100),
          rank: Number(row.rank),
          is_boilerplate: bp.isBoilerplate,
          query_idx: qIdx,
        });
      }

      const qwh = queriesWithHitSet.size;
      const verdict =
        qwh === 0 ? "absent" : qwh === 1 ? "thin" : "covered";

      coverageRows.push({
        candidate_id: cand.candidate_id,
        deal_id: dealId,
        verdict,
        queries_run: queries,
        queries_with_hits: qwh,
        documents_searched: documentsSearched,
        documents_with_hits: docsWithHitSet.size,
        max_term_coverage: Math.round(maxCovRatio * 100),
        hits: processedHits,
        boilerplate_only: anyHit && allBoilerplate,
        expansion_ran: false,
        expansion_overturned: false,
      });

      console.log(
        `${LOG_PREFIX} ${cand.failure_mode}: ${verdict} ` +
          `(${qwh}/${queries.length} qHits, ${processedHits.length} chunks, ` +
          `maxCov=${Math.round(maxCovRatio * 100)}%)`,
      );
    }

    // ── 4. Bulk upsert coverage rows (idempotent on candidate_id) ──────
    await ctx.integrations.db.execute(
      `INSERT INTO bss_coverage
         (candidate_id, deal_id, verdict, queries_run, queries_with_hits,
          documents_searched, documents_with_hits, max_term_coverage, hits,
          boilerplate_only, expansion_ran, expansion_overturned)
       SELECT
         (j->>'candidate_id')::uuid,
         (j->>'deal_id')::uuid,
         j->>'verdict',
         j->'queries_run',
         (j->>'queries_with_hits')::int,
         j->'documents_searched',
         (j->>'documents_with_hits')::int,
         (j->>'max_term_coverage')::int,
         j->'hits',
         (j->>'boilerplate_only')::boolean,
         (j->>'expansion_ran')::boolean,
         (j->>'expansion_overturned')::boolean
       FROM jsonb_array_elements($1::jsonb) AS j
       ON CONFLICT (candidate_id) DO UPDATE SET
         verdict = EXCLUDED.verdict,
         queries_run = EXCLUDED.queries_run,
         queries_with_hits = EXCLUDED.queries_with_hits,
         documents_searched = EXCLUDED.documents_searched,
         documents_with_hits = EXCLUDED.documents_with_hits,
         max_term_coverage = EXCLUDED.max_term_coverage,
         hits = EXCLUDED.hits,
         boilerplate_only = EXCLUDED.boilerplate_only,
         expansion_ran = EXCLUDED.expansion_ran,
         expansion_overturned = EXCLUDED.expansion_overturned,
         swept_at = now()`,
      [JSON.stringify(coverageRows)],
      { label: "Bulk upsert bss_coverage rows" },
    );

    console.log(`${LOG_PREFIX} Inserted ${coverageRows.length} coverage rows`);

    // ── 5. Summary ─────────────────────────────────────────────────────
    const verdicts = { covered: 0, thin: 0, absent: 0 };
    const byPassType: Record<
      string,
      { covered: number; thin: number; absent: number }
    > = {};

    for (let i = 0; i < candidates.length; i++) {
      const v = coverageRows[i].verdict as "covered" | "thin" | "absent";
      verdicts[v]++;
      const pt = candidates[i].pass_type;
      if (!byPassType[pt])
        byPassType[pt] = { covered: 0, thin: 0, absent: 0 };
      byPassType[pt][v]++;
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} DONE — ${candidates.length} candidates, ` +
        `${totalSearches} searches, ${elapsed}ms. ` +
        `covered=${verdicts.covered} thin=${verdicts.thin} absent=${verdicts.absent}`,
    );

    return {
      totalCandidates: candidates.length,
      totalSearches,
      verdicts,
      byPassType,
      runtimeMs: elapsed,
      checkpointingNeeded: false,
    };
  },
});

// ---------------------------------------------------------------------------
// Exported per-candidate function for orchestrator use
// ---------------------------------------------------------------------------

export interface SweepCoverageRow {
  candidate_id: string;
  deal_id: string;
  verdict: "covered" | "thin" | "absent";
  queries_run: string[];
  queries_with_hits: number;
  documents_searched: Array<{ id: string; file_name: string }>;
  documents_with_hits: number;
  max_term_coverage: number;
  hits: any[];
  boilerplate_only: boolean;
  expansion_ran: boolean;
  expansion_overturned: boolean;
}

/**
 * Sweep a single candidate — FTS + term coverage + verdict.
 * Callable from both the standalone API loop and the orchestrator's
 * per-candidate resume loop.
 */
export async function sweepOneCandidate(
  db: { query: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]> },
  candidate: { candidate_id: string; failure_mode: string; pass_type: string; proposed_queries: any },
  dealId: string,
  documentsSearched: Array<{ id: string; file_name: string }>,
): Promise<SweepCoverageRow> {
  const queries: string[] = Array.isArray(candidate.proposed_queries)
    ? candidate.proposed_queries
    : JSON.parse(String(candidate.proposed_queries));

  const queryInput = queries.map((qt, idx) => ({
    idx,
    qt: sanitiseForFts(qt),
  }));

  let hitRows: any[] = [];
  try {
    const raw = await db.query(
      `WITH qi AS (
         SELECT (j->>'idx')::int AS query_idx,
                j->>'qt'         AS query_text
         FROM jsonb_array_elements($1::jsonb) AS j
       ),
       matched AS (
         SELECT qi.query_idx, qi.query_text,
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
       SELECT query_idx, query_text, chunk_id, document_id,
              file_name, chunk_index, content, rank
       FROM matched
       WHERE rn <= ${MAX_HITS_PER_QUERY}
       ORDER BY query_idx, rank DESC`,
      z.any(),
      [JSON.stringify(queryInput), dealId],
      { label: `FTS: ${candidate.failure_mode}` },
    );
    hitRows = Array.isArray(raw) ? raw : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BSS-SWEEP] FTS error for ${candidate.failure_mode}: ${msg}`);
    return {
      candidate_id: candidate.candidate_id,
      deal_id: dealId,
      verdict: "absent",
      queries_run: queries,
      queries_with_hits: 0,
      documents_searched: documentsSearched,
      documents_with_hits: 0,
      max_term_coverage: 0,
      hits: [{ error: msg }],
      boilerplate_only: false,
      expansion_ran: false,
      expansion_overturned: false,
    };
  }

  const queriesWithHitSet = new Set<number>();
  const docsWithHitSet = new Set<string>();
  let maxCovRatio = 0;
  let allBoilerplate = true;
  let anyHit = false;
  const processedHits: any[] = [];

  for (const row of hitRows) {
    const qIdx = Number(row.query_idx);
    const originalQuery = queries[qIdx] ?? row.query_text;
    const content = String(row.content ?? "");

    const cov = computeTermCoverage(originalQuery, content);
    if (cov.ratio < MIN_TERM_COVERAGE) continue;

    anyHit = true;
    queriesWithHitSet.add(qIdx);
    docsWithHitSet.add(row.document_id);
    if (cov.ratio > maxCovRatio) maxCovRatio = cov.ratio;

    const bp = classifyChunk(content);
    if (!bp.isBoilerplate) allBoilerplate = false;

    processedHits.push({
      document_id: row.document_id,
      file_name: row.file_name,
      chunk_index: Number(row.chunk_index),
      matched_terms: cov.matchedTerms,
      term_coverage: Math.round(cov.ratio * 100),
      rank: Number(row.rank),
      is_boilerplate: bp.isBoilerplate,
      query_idx: qIdx,
    });
  }

  const qwh = queriesWithHitSet.size;
  const verdict: "covered" | "thin" | "absent" =
    qwh === 0 ? "absent" : qwh === 1 ? "thin" : "covered";

  console.log(
    `[BSS-SWEEP] ${candidate.failure_mode}: ${verdict} ` +
      `(${qwh}/${queries.length} qHits, ${processedHits.length} chunks, ` +
      `maxCov=${Math.round(maxCovRatio * 100)}%)`,
  );

  return {
    candidate_id: candidate.candidate_id,
    deal_id: dealId,
    verdict,
    queries_run: queries,
    queries_with_hits: qwh,
    documents_searched: documentsSearched,
    documents_with_hits: docsWithHitSet.size,
    max_term_coverage: Math.round(maxCovRatio * 100),
    hits: processedHits,
    boilerplate_only: anyHit && allBoilerplate,
    expansion_ran: false,
    expansion_overturned: false,
  };
}

/**
 * Upsert a single coverage row — idempotent on candidate_id.
 */
export async function upsertOneCoverageRow(
  db: { execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any> },
  row: SweepCoverageRow,
): Promise<void> {
  await db.execute(
    `INSERT INTO bss_coverage
       (candidate_id, deal_id, verdict, queries_run, queries_with_hits,
        documents_searched, documents_with_hits, max_term_coverage, hits,
        boilerplate_only, expansion_ran, expansion_overturned)
     VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::int,
             $6::jsonb, $7::int, $8::int, $9::jsonb,
             $10::boolean, $11::boolean, $12::boolean)
     ON CONFLICT (candidate_id) DO UPDATE SET
       verdict = EXCLUDED.verdict,
       queries_run = EXCLUDED.queries_run,
       queries_with_hits = EXCLUDED.queries_with_hits,
       documents_searched = EXCLUDED.documents_searched,
       documents_with_hits = EXCLUDED.documents_with_hits,
       max_term_coverage = EXCLUDED.max_term_coverage,
       hits = EXCLUDED.hits,
       boilerplate_only = EXCLUDED.boilerplate_only,
       expansion_ran = EXCLUDED.expansion_ran,
       expansion_overturned = EXCLUDED.expansion_overturned,
       swept_at = now()`,
    [
      row.candidate_id,
      row.deal_id,
      row.verdict,
      JSON.stringify(row.queries_run),
      row.queries_with_hits,
      JSON.stringify(row.documents_searched),
      row.documents_with_hits,
      row.max_term_coverage,
      JSON.stringify(row.hits),
      row.boilerplate_only,
      row.expansion_ran,
      row.expansion_overturned,
    ],
    { label: `Upsert coverage: ${row.candidate_id}` },
  );
}
