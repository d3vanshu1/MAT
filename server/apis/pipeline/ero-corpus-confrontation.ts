/**
 * ERO v2 — Corpus Confrontation Stage (Phase 5, Stage 1)
 *
 * For each ero_findings row, checks the deal's OWN document_chunks to
 * classify whether the deal team already knew about the finding:
 *
 *   - unknown_to_deal_team: corpus queries returned nothing relevant
 *   - known_and_assessed: corpus addresses the finding
 *   - known_but_understated: corpus mentions it but external evidence
 *     shows a LARGER magnitude (requires BOTH quoted figures)
 *
 * TWO LOCKED DESIGN RULES:
 *
 *   1. Confrontation searches the FULL document_chunks corpus for the
 *      deal — the same table the manifest and research were grounded in.
 *      No tag filter — searching a subset would manufacture false absences.
 *      Every query is PERSISTED to ero_corpus_checks (receipt).
 *
 *   2. known_but_understated is a MAGNITUDE claim. It requires the deal
 *      team's stated figure AND the external figure, both quoted, in the
 *      record. Code enforces: if the model classifies understated but does
 *      not supply both a non-empty corpus_quoted_value and a non-empty
 *      external_quoted_value, DOWNGRADE to known_and_assessed.
 *
 * Resume-safe: processes only findings that do NOT yet have
 * ero_corpus_checks rows (NOT EXISTS guard).
 *
 * This stage does NOT change severity — severity is 4.3's applyCeiling
 * result and stays fixed.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
import { STAGE_BUDGET_MS } from "./ero-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
const CONFRONTATION_MODEL = "claude-sonnet-4-6";
const CONFRONTATION_MAX_TOKENS = 4096;

/** Max chunks to retrieve per narrow FTS query. */
const MAX_CHUNKS_PER_QUERY = 8;

/**
 * Minimum total hit_count across all queries before "unknown_to_deal_team"
 * is suspect. If the model claims unknown but queries returned ≥ this
 * many hits, we flag it as an inconsistency.
 */
const UNKNOWN_HIT_THRESHOLD = 3;

// ── DB row schemas ──────────────────────────────────────────────────
const FindingWithContext = z.object({
  finding_id: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: z.string(),
  verdict: z.string(),
  materiality_rationale: z.string(),
  // hypothesis context
  hypothesis_id: z.string(),
  family: z.string(),
  question: z.string(),
  // entity context (nullable — non-entity hypotheses have none)
  entity_legal_name: z.string().nullable(),
  entity_type: z.string().nullable(),
  entity_jurisdiction: z.string().nullable(),
});

const ChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.coerce.number(),
  total_matches: z.coerce.number(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

// ── Anthropic response schema ───────────────────────────────────────
const ConfrontationResponse = z.object({
  content: z.array(z.object({ text: z.string() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

// ── LLM classification output schema ────────────────────────────────
const ClassificationResult = z.object({
  classification: z.enum([
    "unknown_to_deal_team",
    "known_and_assessed",
    "known_but_understated",
  ]),
  corpus_quote: z.string().nullable().optional(),
  corpus_quoted_value: z.string().nullable().optional(),
  external_quoted_value: z.string().nullable().optional(),
  reasoning: z.string(),
});

// ── Per-finding result for stageData ────────────────────────────────
interface CorpusCheckOutcome {
  finding_id: string;
  title: string;
  severity: string;
  queries: Array<{
    query_text: string;
    hit_count: number;
    best_hit_snippet: string | null;
    best_hit_document_id: string | null;
  }>;
  classification: string;
  corpus_quote: string | null;
  corpus_quoted_value: string | null;
  external_quoted_value: string | null;
  magnitude_downgrade: boolean;
  absence_flag: boolean;
  reasoning: string;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function corpusConfrontation(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;
  const ai = ctx.integrations.claude;
  const stageStart = Date.now();

  // ── Load findings that do NOT yet have corpus_checks rows ─────────
  // Resume-safe: NOT EXISTS on ero_corpus_checks means re-entry skips
  // already-confronted findings.
  const findings = await db.query(
    `SELECT f.finding_id, f.title, f.detail, f.severity, f.verdict,
            f.materiality_rationale,
            h.hypothesis_id, h.family, h.question,
            e.legal_name  AS entity_legal_name,
            e.entity_type AS entity_type,
            e.jurisdiction AS entity_jurisdiction
     FROM ero_findings f
     JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
     LEFT JOIN ero_entities e ON e.entity_id = h.entity_id
     WHERE h.run_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM ero_corpus_checks cc
         WHERE cc.finding_id = f.finding_id
       )
     ORDER BY f.created_at ASC`,
    FindingWithContext,
    [runId],
    { label: "CorpusConfrontation: load unconfrronted findings" },
  );

  if (findings.length === 0) {
    return {
      stage: "corpus_confrontation",
      status: "complete",
      message: "No unconfronted findings — corpus confrontation complete.",
      stageData: { findingsProcessed: 0, outcomes: [] },
    };
  }

  const outcomes: CorpusCheckOutcome[] = [];
  let findingsProcessed = 0;

  for (const finding of findings) {
    // ── Budget guard ──────────────────────────────────────────────
    const elapsed = Date.now() - stageStart;
    if (elapsed >= STAGE_BUDGET_MS) {
      return {
        stage: "corpus_confrontation",
        status: "in_progress",
        message: `Budget exhausted after ${findingsProcessed} findings (${Math.round(elapsed / 1000)}s). ${findings.length - findingsProcessed} remain.`,
        stageData: { findingsProcessed, outcomes },
      };
    }

    // ── Process one finding (fault-isolated per research pattern) ─
    try {
      const outcome = await confrontOneFinding(db, ai, dealId, finding);
      outcomes.push(outcome);
      findingsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Insert a sentinel corpus_check so the NOT EXISTS guard at stage
      // entry skips this finding on re-entry. No ON CONFLICT clause:
      // ero_corpus_checks has no unique constraint on finding_id (PK is
      // check_id; finding_id has only a plain index). ON CONFLICT with a
      // non-unique index throws a PG error inside the catch, defeating
      // fault isolation. A bare INSERT is safe — multiple rows per
      // finding_id are schema-legal (check_id is the PK), and one sentinel
      // row is sufficient for the NOT EXISTS skip.
      // Schema constraints satisfied: query_text NOT NULL ✓, hit_count NOT NULL ✓,
      // classification NULL ✓ (CHECK allows NULL).
      await db.execute(
        `INSERT INTO ero_corpus_checks
           (finding_id, query_text, hit_count, classification, best_hit_snippet)
         VALUES ($1, '[error]', 0, NULL, $2)`,
        [finding.finding_id, msg.slice(0, 500)],
        { label: `CorpusConfrontation: sentinel for finding ${finding.finding_id}` },
      );

      outcomes.push({
        finding_id: finding.finding_id,
        title: finding.title,
        severity: finding.severity,
        queries: [{ query_text: "[error]", hit_count: 0, best_hit_snippet: msg, best_hit_document_id: null }],
        classification: "error",
        corpus_quote: null,
        corpus_quoted_value: null,
        external_quoted_value: null,
        magnitude_downgrade: false,
        absence_flag: false,
        reasoning: msg,
      });
      findingsProcessed++;
      // Continue to next finding — do not kill the stage
    }

    // ── Heartbeat ─────────────────────────────────────────────────
    await db.execute(
      `UPDATE ero_pipeline_state
       SET heartbeat_at = now(), updated_at = now()
       WHERE run_id = $1`,
      [runId],
      { label: `CorpusConfrontation: heartbeat after finding ${findingsProcessed}` },
    );
  }

  return {
    stage: "corpus_confrontation",
    status: "complete",
    message: `Corpus confrontation complete. ${findingsProcessed} findings classified.`,
    stageData: { findingsProcessed, outcomes },
  };
}

// ═══════════════════════════════════════════════════════════════════
// SEARCH TERM DERIVATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Derive MULTIPLE narrow FTS queries from a finding's context.
 *
 * Each query is short and high-signal (2-4 terms max) to avoid the
 * websearch_to_tsquery AND trap: long multi-term queries require ALL
 * terms to appear in a single chunk, returning zero rows.
 *
 * Strategy:
 *   - Q1: entity name (if present) — "Acme Holdings"
 *   - Q2: finding title keywords (top 2-3 content words)
 *   - Q3: family/regime term — "litigation", "regulatory", "environmental"
 *   - Q4: if the finding detail contains a number, search for it
 *     with a context word — "£4.2m penalty"
 *
 * Returns 2-4 queries. Never returns one long concatenated query.
 */
function deriveSearchQueries(
  finding: z.infer<typeof FindingWithContext>,
): string[] {
  const queries: string[] = [];

  // ── Q1: Entity name ─────────────────────────────────────────────
  if (finding.entity_legal_name) {
    queries.push(finding.entity_legal_name.trim());
  }

  // ── Q2: Title keywords (top 3 content words) ───────────────────
  const titleWords = extractContentWords(finding.title, 3);
  if (titleWords.length >= 2) {
    queries.push(titleWords.join(" "));
  }

  // ── Q3: Family / regime term ────────────────────────────────────
  const familyTerm = familyToSearchTerm(finding.family);
  if (familyTerm) {
    queries.push(familyTerm);
  }

  // ── Q4: Quantitative term from detail ───────────────────────────
  const quantTerm = extractQuantitativeTerm(finding.detail);
  if (quantTerm) {
    queries.push(quantTerm);
  }

  // Ensure at least 2 queries — if we have fewer, add the hypothesis
  // question's key terms as a fallback.
  if (queries.length < 2) {
    const questionWords = extractContentWords(finding.question, 3);
    if (questionWords.length >= 2) {
      queries.push(questionWords.join(" "));
    }
  }

  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const q of queries) {
    const key = q.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(q);
    }
  }

  return deduped;
}

/** Extract the N most content-bearing words from text (no stopwords). */
function extractContentWords(text: string, n: number): string[] {
  const STOPWORDS = new Set([
    "the", "a", "an", "of", "in", "to", "for", "and", "or", "is",
    "are", "was", "were", "be", "been", "has", "have", "had", "with",
    "on", "at", "by", "from", "as", "it", "its", "this", "that",
    "not", "but", "no", "may", "will", "can", "do", "does", "did",
    "about", "into", "over", "under", "between", "through", "during",
    "up", "out", "their", "they", "them", "which", "what", "who",
    "how", "than", "been", "being", "would", "could", "should",
    "also", "such", "each", "any", "all", "both", "more", "most",
    "other", "some", "very", "just", "only", "own", "same",
  ]);

  const words = text
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));

  // Prefer longer words (more signal)
  words.sort((a, b) => b.length - a.length);
  return words.slice(0, n);
}

/** Map hypothesis family to a short FTS-friendly search term. */
function familyToSearchTerm(family: string): string | null {
  const FAMILY_MAP: Record<string, string> = {
    litigation_enforcement: "litigation claim proceedings",
    regulatory: "regulatory compliance breach",
    environmental: "environmental contamination remediation",
    financial: "financial performance revenue",
    operational: "operational risk supply chain",
    reputational: "reputation adverse media",
    cyber_data: "cyber data breach security",
    tax: "tax liability HMRC",
    governance: "governance director board",
    labour: "employment tribunal workforce",
  };
  return FAMILY_MAP[family] ?? null;
}

/** Extract a number + context word from text for quantitative search. */
function extractQuantitativeTerm(text: string): string | null {
  // Match currency/number patterns: £4.2m, $10 million, 15%, 2,300
  const match = text.match(
    /(?:[£$€][\d,.]+\s*(?:m(?:illion)?|bn|billion|k|thousand)?|[\d,.]+\s*%|\d{1,3}(?:,\d{3})+)/i,
  );
  if (!match) return null;

  // Get the word before or after the number for context
  const idx = text.indexOf(match[0]);
  const before = text.slice(Math.max(0, idx - 30), idx).trim().split(/\s+/);
  const after = text.slice(idx + match[0].length, idx + match[0].length + 30).trim().split(/\s+/);

  const contextWord =
    before.length > 0 && before[before.length - 1].length > 2
      ? before[before.length - 1]
      : after.length > 0 && after[0].length > 2
        ? after[0]
        : null;

  if (contextWord) {
    return `${contextWord} ${match[0]}`;
  }
  return match[0];
}

// ═══════════════════════════════════════════════════════════════════
// PER-FINDING CONFRONTATION
// ═══════════════════════════════════════════════════════════════════

async function confrontOneFinding(
  db: any,
  ai: any,
  dealId: string,
  finding: z.infer<typeof FindingWithContext>,
): Promise<CorpusCheckOutcome> {
  // ── a. Derive narrow search queries ─────────────────────────────
  const searchQueries = deriveSearchQueries(finding);

  // ── b. Run each query against document_chunks (full deal corpus) ──
  //    Persist EVERY query to ero_corpus_checks as a receipt.
  //    This is the audit trail — every query the stage ran is recorded
  //    whether it hit or missed.
  const queryResults: Array<{
    query_text: string;
    hit_count: number;
    best_hit_snippet: string | null;
    best_hit_document_id: string | null;
    topChunks: Array<z.infer<typeof ChunkRow>>;
  }> = [];

  // FTS query with @@ match filter: ONLY genuine matches return.
  // count(*) OVER() gives the TRUE total match count across the
  // entire corpus, independent of the LIMIT cap. The LIMIT caps
  // rows retrieved for LLM context; the window count is the receipt.
  const ftsSQL = `
    WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq)
    SELECT dc.document_id,
           dc.chunk_index,
           dc.file_name,
           dc.content,
           ts_rank_cd(dc.tsv, q.tsq) AS rank,
           count(*) OVER() AS total_matches
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      CROSS JOIN q
     WHERE dc.deal_id = $1::uuid
       AND d.deal_id = $1::uuid
       AND dc.tsv @@ q.tsq
     ORDER BY ts_rank_cd(dc.tsv, q.tsq) DESC, dc.chunk_index ASC
     LIMIT $3`;

  for (const queryText of searchQueries) {
    const chunks = await db.query(
      ftsSQL,
      ChunkRow,
      [dealId, queryText, MAX_CHUNKS_PER_QUERY],
      { label: `CorpusConfrontation: FTS "${queryText.slice(0, 40)}"` },
    );

    // With the @@ filter in SQL, all returned rows are genuine matches.
    // total_matches (window count) is the TRUE corpus match count,
    // independent of LIMIT. Use it for the receipt, not chunks.length.
    const trueHitCount =
      chunks.length > 0
        ? (chunks[0] as z.infer<typeof ChunkRow>).total_matches
        : 0;
    const bestHit = chunks.length > 0 ? chunks[0] : null;

    queryResults.push({
      query_text: queryText,
      hit_count: trueHitCount,   // TRUE corpus match count (window count)
      best_hit_snippet: bestHit
        ? bestHit.content.slice(0, 500)
        : null,
      best_hit_document_id: bestHit ? bestHit.document_id : null,
      topChunks: chunks.slice(0, 3), // keep top 3 for LLM context
    });

    // ── PERSIST to ero_corpus_checks — the receipt ──────────────
    // Every query is recorded: query_text, hit_count, best_hit.
    // Classification is set to NULL here — will be updated after LLM.
    await db.execute(
      `INSERT INTO ero_corpus_checks
         (finding_id, query_text, hit_count, best_hit_snippet,
          best_hit_document_id, classification)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [
        finding.finding_id,
        queryText,
        trueHitCount,          // TRUE count, not LIMIT-capped
        bestHit ? bestHit.content.slice(0, 500) : null,
        bestHit ? bestHit.document_id : null,
      ],
      { label: `CorpusConfrontation: persist receipt for "${queryText.slice(0, 30)}"` },
    );
  }

  // ── c. Assemble corpus hits for LLM ─────────────────────────────
  // Collect unique snippets from all queries (deduplicate by chunk key).
  const seenChunkKeys = new Set<string>();
  const corpusSnippets: Array<{ file_name: string; content: string }> = [];

  for (const qr of queryResults) {
    for (const chunk of qr.topChunks) {
      const key = `${chunk.document_id}:${chunk.chunk_index}`;
      if (!seenChunkKeys.has(key)) {
        seenChunkKeys.add(key);
        corpusSnippets.push({
          file_name: chunk.file_name,
          content: chunk.content.slice(0, 600),
        });
      }
    }
  }

  const totalHits = queryResults.reduce((sum, qr) => sum + qr.hit_count, 0);

  // ── d. LLM classification call ──────────────────────────────────
  const llmResult = await callClassificationLlm(
    ai,
    finding,
    corpusSnippets,
    totalHits,
  );

  // ── e. CODE ENFORCEMENT: magnitude rule ─────────────────────────
  //    known_but_understated requires BOTH a corpus_quoted_value and
  //    an external_quoted_value. If either is missing, DOWNGRADE to
  //    known_and_assessed. An adjective is not sufficient for understated.
  let finalClassification = llmResult.classification;
  let magnitudeDowngrade = false;

  if (finalClassification === "known_but_understated") {
    const hasCorpusValue =
      llmResult.corpus_quoted_value != null &&
      llmResult.corpus_quoted_value.trim().length > 0;
    const hasExternalValue =
      llmResult.external_quoted_value != null &&
      llmResult.external_quoted_value.trim().length > 0;

    if (!hasCorpusValue || !hasExternalValue) {
      finalClassification = "known_and_assessed";
      magnitudeDowngrade = true;
    }
  }

  // ── f. CODE ENFORCEMENT: absence honesty ────────────────────────
  //    unknown_to_deal_team is only valid if corpus queries genuinely
  //    returned low/no relevant hits. If queries returned substantive
  //    hits but the model still says unknown, flag it.
  let absenceFlag = false;

  if (
    finalClassification === "unknown_to_deal_team" &&
    totalHits >= UNKNOWN_HIT_THRESHOLD
  ) {
    absenceFlag = true;
    // We flag but do NOT override — the model may be correct that
    // the hits are irrelevant to THIS finding. The flag is surfaced
    // in the test harness for human review.
  }

  // ── g. Update classification on all corpus_checks rows for this
  //    finding. All receipt rows get the same final classification.
  await db.execute(
    `UPDATE ero_corpus_checks
     SET classification = $2
     WHERE finding_id = $1`,
    [finding.finding_id, finalClassification],
    { label: `CorpusConfrontation: set classification for finding ${finding.finding_id.slice(0, 8)}` },
  );

  return {
    finding_id: finding.finding_id,
    title: finding.title,
    severity: finding.severity,
    queries: queryResults.map((qr) => ({
      query_text: qr.query_text,
      hit_count: qr.hit_count,
      best_hit_snippet: qr.best_hit_snippet,
      best_hit_document_id: qr.best_hit_document_id,
    })),
    classification: finalClassification,
    corpus_quote: llmResult.corpus_quote ?? null,
    corpus_quoted_value: llmResult.corpus_quoted_value ?? null,
    external_quoted_value: llmResult.external_quoted_value ?? null,
    magnitude_downgrade: magnitudeDowngrade,
    absence_flag: absenceFlag,
    reasoning: llmResult.reasoning,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LLM CALL
// ═══════════════════════════════════════════════════════════════════

const CONFRONTATION_SYSTEM_PROMPT = `You are a diligence analyst cross-referencing an external risk finding against the deal's own data room documents.

You will receive:
1. An EXTERNAL FINDING — a risk discovered through web research about the deal.
2. CORPUS EXCERPTS — snippets from the deal team's own documents found by searching for the finding's key terms.

Your job is to classify the finding into one of three categories:

- "unknown_to_deal_team": The corpus excerpts do NOT address this finding's subject. The deal team's documents are silent on this matter. Choose this ONLY when the search genuinely returned nothing relevant — if the snippets discuss the same topic, do NOT call it unknown.

- "known_and_assessed": The corpus excerpts address this finding's subject. The deal team is aware of and has assessed this risk. Provide a direct quote from the corpus.

- "known_but_understated": The corpus excerpts mention this matter, BUT the external evidence shows a LARGER magnitude than what the deal team stated. You MUST provide BOTH:
  - corpus_quoted_value: the exact figure/number the deal team stated (quoted from the corpus)
  - external_quoted_value: the exact figure/number from the external finding that is larger
  BOTH must be specific numbers or quantified values. An adjective like "significant" or "material" is NOT a value. If you cannot provide both specific quoted values, classify as "known_and_assessed" instead.

CRITICAL RULES:
- Be rigorously honest about absence. Do NOT claim "unknown_to_deal_team" if the corpus snippets discuss the same entity, topic, or risk — even if the coverage is superficial.
- "known_but_understated" is the highest-consequence classification. It means the deal team actively misrepresented or underestimated a figure. Require hard numbers.
- When uncertain between "unknown" and "known_and_assessed", prefer "known_and_assessed" — false "unknown" (claiming the deal team missed something they actually covered) is the most damaging error.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "classification": "unknown_to_deal_team" | "known_and_assessed" | "known_but_understated",
  "corpus_quote": "Direct quote from corpus if known (null if unknown)",
  "corpus_quoted_value": "The deal team's stated figure (REQUIRED for understated)",
  "external_quoted_value": "The external finding's larger figure (REQUIRED for understated)",
  "reasoning": "Brief explanation of why this classification was chosen"
}`;

async function callClassificationLlm(
  ai: any,
  finding: z.infer<typeof FindingWithContext>,
  corpusSnippets: Array<{ file_name: string; content: string }>,
  totalHits: number,
): Promise<z.infer<typeof ClassificationResult>> {
  // Build the corpus block
  let corpusBlock: string;
  if (corpusSnippets.length === 0) {
    corpusBlock =
      "NO CORPUS RESULTS. The deal team's documents contain no content matching the search queries for this finding.";
  } else {
    corpusBlock = corpusSnippets
      .map(
        (s, i) =>
          `Corpus Excerpt ${i + 1} (from ${s.file_name}):\n${s.content}`,
      )
      .join("\n\n");
  }

  const userPrompt = [
    `EXTERNAL FINDING:`,
    `Title: ${finding.title}`,
    `Severity: ${finding.severity}`,
    `Detail: ${finding.detail}`,
    `Materiality: ${finding.materiality_rationale}`,
    ``,
    `Hypothesis family: ${finding.family}`,
    `Hypothesis question: ${finding.question}`,
    finding.entity_legal_name
      ? `Entity: ${finding.entity_legal_name} (${finding.entity_type ?? "unknown type"})`
      : null,
    ``,
    `CORPUS SEARCH RESULTS (${totalHits} total hits across ${corpusSnippets.length} unique excerpts):`,
    corpusBlock,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await ai.apiRequest(
    {
      method: "POST",
      path: "/v1/messages",
      body: {
        model: CONFRONTATION_MODEL,
        max_tokens: CONFRONTATION_MAX_TOKENS,
        system: [
          {
            type: "text",
            text: CONFRONTATION_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      },
    },
    { response: ConfrontationResponse },
    { label: `CorpusConfrontation: classify finding "${finding.title.slice(0, 40)}"` },
  );

  // Parse the JSON response from the model
  const textBlock = response.content.find((b: { text: string }) => b.text);
  if (!textBlock || !textBlock.text) {
    throw new Error(
      `Confrontation LLM returned no text for finding ${finding.finding_id}`,
    );
  }

  // Strip markdown code fences if the model wrapped its response
  let rawJson = textBlock.text.trim();
  if (rawJson.startsWith("```")) {
    rawJson = rawJson
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(
      `Confrontation LLM returned invalid JSON for finding ` +
        `${finding.finding_id}: ${rawJson.slice(0, 500)}`,
    );
  }

  const validated = ClassificationResult.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Confrontation LLM returned invalid structure for finding ` +
        `${finding.finding_id}: ${validated.error.message}`,
    );
  }

  return validated.data;
}
