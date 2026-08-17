/**
 * P8 — OA Finding Assembly (Narrative Generation + Quote Validation)
 *
 * For each finding (created by P6, tiered by P7), this stage:
 * 1. Derives source windows from documents.parsed_text using char_start/char_end
 * 2. Generates a narrative via LLM with strict quoting rules
 * 3. Validates every double-quoted span ≥5 words against source windows
 * 4. Rejects findings with unresolvable provenance pointers
 *
 * Anti-fabrication mechanism: the quote validator ensures no shipped narrative
 * contains a fabricated quotation. If a quote cannot be matched to source text,
 * the finding retries once, then persists with narrative=NULL and a validation
 * failure flag.
 *
 * Report: F1-F5
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";
import { SEEDED_TOPICS } from "./oa-taxonomy.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// Budget guard constants — orchestrator hard-kills at ~300s, must yield before that
const HARD_KILL_MS = 250_000;
const SAFETY_MARGIN_MS = 40_000;
const DEFAULT_UNIT_DURATION_MS = 55_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

const FindingRow = z.object({
  finding_id: z.string(),
  topic_id: z.string(),
  gap_kind: z.string(),
  materiality_tier: z.coerce.number(),
  materiality_basis: z.string().nullable(),
  absence_basis: z.string().nullable(),
  subject_evidence: z.any(),
  reference_evidence: z.any(),
  narrative: z.string().nullable(),
});

const FactSourceRow = z.object({
  fact_id: z.string(),
  predicate: z.string().nullable(),
  value: z.string().nullable(),
  scope_qualifier: z.string().nullable(),
  period: z.string().nullable(),
  adviser_severity: z.string().nullable(),
  adviser_disposition: z.string().nullable(),
  document_name: z.string().nullable(),
  char_start: z.coerce.number().nullable(),
  char_end: z.coerce.number().nullable(),
  document_id: z.string(),
});

const ParsedTextRow = z.object({
  parsed_text: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Topic label lookup
// ---------------------------------------------------------------------------
const TOPIC_LABEL_MAP: Record<string, string> = {};
SEEDED_TOPICS.forEach((t) => { TOPIC_LABEL_MAP[t.topic_id] = t.topic_label; });

function getTopicLabel(topicId: string): string {
  return TOPIC_LABEL_MAP[topicId] ?? topicId;
}

// ---------------------------------------------------------------------------
// A1 — Snippet derivation
// ---------------------------------------------------------------------------

async function deriveSourceWindow(
  db: any,
  factId: string,
  charStart: number | null,
  charEnd: number | null,
  documentId: string,
): Promise<{ text: string | null; error: string | null }> {
  if (charStart == null || charEnd == null) {
    return { text: null, error: `fact ${factId}: char_start or char_end is NULL` };
  }
  if (charEnd <= charStart) {
    return { text: null, error: `fact ${factId}: char_end (${charEnd}) <= char_start (${charStart})` };
  }

  const rows = await db.query(
    `SELECT substring(parsed_text FROM $2 + 1 FOR $3 - $2) AS parsed_text
     FROM documents WHERE id = $1 AND parsed_text IS NOT NULL`,
    ParsedTextRow,
    [documentId, charStart, charEnd],
    { label: `Source window: ${factId}` }
  );

  if (rows.length === 0 || !rows[0].parsed_text) {
    return { text: null, error: `fact ${factId}: no parsed_text returned for document ${documentId}` };
  }

  return { text: rows[0].parsed_text, error: null };
}

// ---------------------------------------------------------------------------
// A2 — Narrative generation prompt
// ---------------------------------------------------------------------------

function buildNarrativePrompt(
  topicId: string,
  topicLabel: string,
  gapKind: string,
  materialityTier: number,
  subjectEvidence: Array<{ fact_id: string; predicate: string | null; value: string | null; scope_qualifier: string | null; period: string | null; sourceWindow: string | null }>,
  referenceEvidence: Array<{ fact_id: string; predicate: string | null; value: string | null; scope_qualifier: string | null; period: string | null; adviser_severity: string | null; adviser_disposition: string | null; sourceWindow: string | null }>,
): string {
  const subLines = subjectEvidence.map((e, i) => {
    const sw = e.sourceWindow ? `\n    SOURCE WINDOW:\n    ${e.sourceWindow.slice(0, 2000)}` : "";
    return `  [S${i}] predicate=${e.predicate ?? "NULL"} | value=${e.value ?? "NULL"} | scope=${e.scope_qualifier ?? "NULL"} | period=${e.period ?? "NULL"}${sw}`;
  }).join("\n");

  const refLines = referenceEvidence.map((e, i) => {
    const sw = e.sourceWindow ? `\n    SOURCE WINDOW:\n    ${e.sourceWindow.slice(0, 2000)}` : "";
    return `  [R${i}] predicate=${e.predicate ?? "NULL"} | value=${e.value ?? "NULL"} | scope=${e.scope_qualifier ?? "NULL"} | period=${e.period ?? "NULL"} | adviser_severity=${e.adviser_severity ?? "NULL"} | adviser_disposition=${e.adviser_disposition ?? "NULL"}${sw}`;
  }).join("\n");

  return `You are writing an analytical narrative for an omission audit finding.

TOPIC: ${topicId} | ${topicLabel}
GAP KIND: ${gapKind}
MATERIALITY TIER: ${materialityTier}

SUBJECT EVIDENCE (from IC memo):
${subLines || "  (none)"}

REFERENCE EVIDENCE (from adviser reports):
${refLines || "  (none)"}

INSTRUCTIONS:
- Write 2-4 paragraphs.
- FIRST: State what the memos DO disclose on this topic before stating what is missing. A finding that ignores existing coverage is a false finding.
- THEN: Describe the gap — what the reference documents reveal that is absent or inadequately addressed in the IC memo.
- Use factual, measured language. Do not speculate.
- Do not use internal field names or identifiers in the narrative.
- Reference documents by name (e.g. "the Vendor FDD states...") not by fact_id.
- Focus on the gap: what is disclosed in the reference but missing/inadequate in the subject.

QUOTATION RULES:
- The fact fields provided to you — predicate, value, scope_qualifier — are SUMMARIES generated during extraction. They are NOT source text. Never place them in quotation marks.
- Direct quotation is permitted ONLY from the SOURCE WINDOWS provided, copied exactly, character for character.
- QUOTE where the finding rests on someone's specific wording — an adviser's stated disposition ("For information only"), a recommendation, a qualification, a caveat. In those cases the wording carries meaning that paraphrase loses.
- DO NOT quote where the finding rests on figures. State the numbers directly as prose. A finding built on data is verified by its numbers, not by quotation marks.
- If no suitable verbatim quote exists in the source windows, do not construct one. Write the finding without quotation.

FIGURE CITATION RULES:
- Every figure you cite must appear with its period and its scope qualifier as recorded on the fact, and you must name the source document. A reader must be able to locate that figure in the source without guessing which population or period it refers to.
- Example: "£49.0 million of adjusted EBITDA for the year ended March 2025 (PwC Vendor FDD)" — not "£49.0 million".

ADVISER SEVERITY:
- Adviser severity ratings are provided as structured fields. State a rating ONLY when it appears on a fact you are citing. Never infer a severity from the seriousness of the subject matter.

SCOPE CONSTRAINTS:
- You see only the facts assigned to THIS topic. You do not see the rest of the memo. Never assert that the memos are silent on a subject, that no acknowledgement exists, or that a matter is absent from the memos entirely. Those are corpus-wide claims you cannot verify from one topic's facts. Write "the facts on this topic do not include X" — never "the memo does not address X".

OUTPUT: Return ONLY the narrative text. No markdown headings, no metadata, no JSON wrapping.`;
}

// ---------------------------------------------------------------------------
// A3 — Quote validator
// ---------------------------------------------------------------------------

/**
 * Normalise smart/curly quotes to straight ASCII double quotes.
 * Models frequently emit \u201C/\u201D instead of \x22.
 */
function normaliseQuoteChars(s: string): string {
  return s.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
}

/**
 * Extracts all double-quoted spans of ≥5 words from text.
 * Smart quotes are normalised before extraction.
 */
function extractQuotedSpans(text: string): string[] {
  const normalised = normaliseQuoteChars(text);
  const regex = /"([^"]{10,})"/g;
  const quotes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalised)) !== null) {
    const candidate = match[1].trim();
    // ≥5 words
    if (candidate.split(/\s+/).length >= 5) {
      quotes.push(candidate);
    }
  }
  return quotes;
}

/**
 * Normalise whitespace for comparison: collapse runs of whitespace to single space, trim.
 */
function normaliseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Validates all quotes in a narrative against the provided source windows.
 * Returns { valid: true } or { valid: false, failedQuotes: [...] }.
 */
function validateQuotes(
  narrative: string,
  sourceWindows: Array<string | null>,
): { valid: boolean; failedQuotes: string[] } {
  const quotes = extractQuotedSpans(narrative);
  if (quotes.length === 0) return { valid: true, failedQuotes: [] };

  const normalisedWindows = sourceWindows
    .filter((w): w is string => w != null && w.length > 0)
    .map(normaliseWhitespace);

  const failedQuotes: string[] = [];
  for (const quote of quotes) {
    const normQuote = normaliseWhitespace(quote);
    const found = normalisedWindows.some((window) => window.includes(normQuote));
    if (!found) {
      failedQuotes.push(quote);
    }
  }

  return { valid: failedQuotes.length === 0, failedQuotes };
}

// ---------------------------------------------------------------------------
// A4 — Provenance resolution gate (BATCHED for performance)
// ---------------------------------------------------------------------------

interface ProvenanceResult {
  resolved: boolean;
  factId: string;
  error: string | null;
  sourceWindow: string | null;
}

async function resolveProvenance(
  db: any,
  factIds: string[],
  dealId: string,
): Promise<ProvenanceResult[]> {
  if (factIds.length === 0) return [];

  // Batch 1: Load all fact metadata in one query
  const placeholders = factIds.map((_, i) => `$${i + 2}`).join(", ");
  const factRows = await db.query(
    `SELECT fact_id, char_start, char_end, document_id
     FROM oa_facts
     WHERE fact_id IN (${placeholders}) AND deal_id = $1`,
    z.object({
      fact_id: z.string(),
      char_start: z.coerce.number().nullable(),
      char_end: z.coerce.number().nullable(),
      document_id: z.string(),
    }),
    [dealId, ...factIds],
    { label: `Batch provenance lookup (${factIds.length} facts)` }
  );

  const factMap = new Map<string, { fact_id: string; char_start: number | null; char_end: number | null; document_id: string }>(
    factRows.map((r: any) => [r.fact_id, r])
  );
  const results: ProvenanceResult[] = [];
  
  // Group facts by document_id for batch source window retrieval
  const docGroups = new Map<string, Array<{ factId: string; charStart: number; charEnd: number }>>();

  for (const factId of factIds) {
    const row = factMap.get(factId);
    if (!row) {
      results.push({ resolved: false, factId, error: `fact_id ${factId} not found in oa_facts`, sourceWindow: null });
      continue;
    }
    if (row.char_start == null || row.char_end == null) {
      results.push({ resolved: false, factId, error: `fact_id ${factId} has NULL char_start or char_end`, sourceWindow: null });
      continue;
    }
    if (row.char_end <= row.char_start) {
      results.push({ resolved: false, factId, error: `fact_id ${factId}: char_end <= char_start`, sourceWindow: null });
      continue;
    }
    
    const group = docGroups.get(row.document_id) ?? [];
    group.push({ factId, charStart: row.char_start, charEnd: row.char_end });
    docGroups.set(row.document_id, group);
  }

  // Batch 2: For each document, load ALL source windows in ONE query
  for (const [docId, facts] of docGroups.entries()) {
    // Build a single query that returns all substrings for this document
    // Using a VALUES list with lateral join
    const valuesClause = facts.map((f, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::int)`).join(", ");
    const WINDOW_PAD = 200; // Extra chars each side for quote validation context
    const params: any[] = [docId];
    for (const f of facts) {
      params.push(Math.max(0, f.charStart - WINDOW_PAD), f.charEnd + WINDOW_PAD);
    }

    try {
      const rows = await db.query(
        `SELECT v.idx, substring(d.parsed_text FROM GREATEST(v.cs + 1, 1) FOR LEAST(v.ce, length(d.parsed_text)) - GREATEST(v.cs, 0)) AS snippet
         FROM documents d,
              (VALUES ${facts.map((_, i) => `(${i}, $${i * 2 + 2}::int, $${i * 2 + 3}::int)`).join(", ")}) AS v(idx, cs, ce)
         WHERE d.id = $1 AND d.parsed_text IS NOT NULL
         ORDER BY v.idx`,
        z.object({ idx: z.coerce.number(), snippet: z.string().nullable() }),
        params,
        { label: `Batch source windows: ${docId.slice(0, 8)} (${facts.length} facts)` }
      );

      const snippetMap = new Map<number, string | null>(rows.map((r: any) => [r.idx, r.snippet]));
      for (let i = 0; i < facts.length; i++) {
        const snippet = snippetMap.get(i);
        if (!snippet) {
          results.push({ resolved: false, factId: facts[i].factId, error: `empty source window for ${facts[i].factId}`, sourceWindow: null });
        } else {
          results.push({ resolved: true, factId: facts[i].factId, error: null, sourceWindow: snippet });
        }
      }
    } catch (e: any) {
      // Fallback: if the batch query fails (too many params), do individual
      for (const fact of facts) {
        const rows = await db.query(
          `SELECT substring(parsed_text FROM GREATEST($2 + 1, 1) FOR LEAST($3, length(parsed_text)) - GREATEST($2, 0)) AS parsed_text
           FROM documents WHERE id = $1 AND parsed_text IS NOT NULL`,
          ParsedTextRow,
          [docId, Math.max(0, fact.charStart - WINDOW_PAD), fact.charEnd + WINDOW_PAD],
          { label: `Source window fallback: ${fact.factId.slice(0, 8)}` }
        );
        if (rows.length === 0 || !rows[0].parsed_text) {
          results.push({ resolved: false, factId: fact.factId, error: `empty source window for ${fact.factId}`, sourceWindow: null });
        } else {
          results.push({ resolved: true, factId: fact.factId, error: null, sourceWindow: rows[0].parsed_text });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaFindingAssembly",
  description: "Generates validated narratives for findings with provenance-checked quotes",
  integrations: {
    db: postgres(DB_ID),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    reset: z.boolean().optional().default(false),
    retryFailed: z.boolean().optional().default(false),
    dryRun: z.boolean().optional().default(false),
    findingIds: z.array(z.string()).optional(),
    testMode: z.object({
      narrative: z.string(),
      sourceWindows: z.array(z.string()),
    }).optional(),
  }),
  output: z.object({
    status: z.enum(["complete", "in_progress"]),
    findings_completed: z.number(),
    findings_remaining: z.number(),
    report: z.record(z.string(), z.any()).optional(),
  }),

  async run(ctx, { dealId, runId, reset, retryFailed, dryRun, findingIds, testMode }) {
    // ─── TEST MODE: pure validator unit test, no DB/LLM ─────────────────
    if (testMode) {
      const quotesExtracted = extractQuotedSpans(testMode.narrative);
      const result = validateQuotes(testMode.narrative, testMode.sourceWindows);
      return {
        status: "complete" as const,
        findings_completed: 0,
        findings_remaining: 0,
        report: {
          testMode: true,
          valid: result.valid,
          failedQuotes: result.failedQuotes,
          quotesExtracted,
        },
      };
    }

    const { db } = ctx.integrations;
    const aiFn: AiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as any;
    const invocationStart = Date.now();
    const timeRemaining = () => HARD_KILL_MS - (Date.now() - invocationStart);

    // ─── RESET ────────────────────────────────────────────────────────────
    if (reset) {
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'finding_assembly'`,
        z.any(), [runId],
        { label: "Reset: delete finding_assembly checkpoints" }
      );
      console.log("[P8] Reset complete for run", runId);
    } else if (retryFailed) {
      const deleted = await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'finding_assembly' AND status = 'failed' RETURNING unit_key`,
        z.object({ unit_key: z.string() }), [runId],
        { label: "RetryFailed: delete failed finding_assembly checkpoints" }
      );
      console.log(`[P8] RetryFailed: cleared ${deleted.length} failed checkpoints for retry`);
    }

    // ─── Load findings that have a materiality_tier (completed P7) ────────
    const findings = await db.query(
      `SELECT finding_id, topic_id, gap_kind, materiality_tier, materiality_basis,
              absence_basis, subject_evidence, reference_evidence, narrative
       FROM oa_findings
       WHERE run_id = $1 AND deal_id = $2
         AND materiality_basis != 'awaiting_materiality_assessment'
       ORDER BY materiality_tier ASC, topic_id ASC`,
      FindingRow,
      [runId, dealId],
      { label: "Load findings for assembly" }
    );

    console.log(`[P8] ${findings.length} findings to process`);

    // ─── Filter to unprocessed (no checkpoint yet) ────────────────────────
    const checkpoints = await db.query(
      `SELECT unit_key, status FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'finding_assembly'`,
      z.object({ unit_key: z.string(), status: z.string() }),
      [runId],
      { label: "Load finding_assembly checkpoints" }
    );
    const processed = new Set(checkpoints.map((c) => c.unit_key));

    const pending = findings.filter((f) => !processed.has(f.finding_id));
    // ─── Optional: restrict to specific finding IDs ─────────────────────
    const workset = findingIds && findingIds.length > 0
      ? pending.filter((f) => findingIds.includes(f.finding_id))
      : pending;
    console.log(`[P8] ${pending.length} pending (${findings.length - pending.length} already processed)${findingIds ? `, workset=${workset.length} (filtered)` : ''}`);

    if (workset.length === 0) {
      // ─── Complete: build report ─────────────────────────────────────────
      const completedCps = checkpoints.filter((c) => c.status === "complete").length;
      const failedCps = checkpoints.filter((c) => c.status === "failed").length;
      return {
        status: "complete" as const,
        findings_completed: findings.length,
        findings_remaining: 0,
        report: {
          F1_findings_processed: findings.length,
          F1_narratives_written: completedCps,
          F1_narratives_null: failedCps,
          message: "All findings processed",
        },
      };
    }

    // ─── Budget-guarded processing loop ────────────────────────────────────
    let unitDurationMs = DEFAULT_UNIT_DURATION_MS;
    let findingsProcessed = 0;
    let narrativesWritten = 0;
    let narrativesNull = 0;
    let provenanceRejections: Array<{ finding_id: string; errors: string[] }> = [];
    let quoteFailures: Array<{ finding_id: string; quotes: string[]; attempt: number }> = [];
    let emptyCharRangeFacts: string[] = [];

    for (const finding of workset) {
      // Budget check
      if (timeRemaining() < SAFETY_MARGIN_MS + unitDurationMs) {
        console.log(`[P8] YIELDING FOR BUDGET: ${timeRemaining()}ms remaining`);
        break;
      }

      const unitStart = Date.now();

      // ─── A4: Provenance resolution gate ──────────────────────────────────
      // Evidence arrays may be plain UUID strings (from P6) or objects with fact_id
      const extractFactIds = (evidence: any[]): string[] =>
        (evidence ?? []).map((e: any) => {
          if (typeof e === "string") return e;           // Plain UUID
          if (typeof e === "object" && e?.fact_id) return e.fact_id; // Object form
          return null;
        }).filter((id: any): id is string => typeof id === "string");

      const subjectFactIds = extractFactIds(finding.subject_evidence);
      const referenceFactIds = extractFactIds(finding.reference_evidence);
      const allFactIds = [...subjectFactIds, ...referenceFactIds];

      const provenanceResults = await resolveProvenance(db, allFactIds, dealId);
      const provenanceErrors = provenanceResults.filter((r) => !r.resolved);

      if (provenanceErrors.length > 0) {
        // REJECT finding — unresolvable provenance
        provenanceRejections.push({
          finding_id: finding.finding_id,
          errors: provenanceErrors.map((e) => e.error!),
        });
        emptyCharRangeFacts.push(...provenanceErrors.map((e) => e.factId));

        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason, payload_json)
           VALUES ($1, 'finding_assembly', $2, 'failed', 'unresolvable_provenance', $3::jsonb)
           ON CONFLICT (run_id, stage, unit_key) DO NOTHING`,
          z.any(),
          [runId, finding.finding_id, JSON.stringify({ errors: provenanceErrors.map((e) => e.error) })],
          { label: `Checkpoint (provenance fail): ${finding.finding_id}` }
        );

        findingsProcessed++;
        narrativesNull++;
        const elapsed = Date.now() - unitStart;
        unitDurationMs = Math.round(0.7 * unitDurationMs + 0.3 * elapsed);
        continue;
      }

      // Build source window map
      const sourceWindowMap: Record<string, string | null> = {};
      for (const r of provenanceResults) {
        sourceWindowMap[r.factId] = r.sourceWindow;
      }

      // ─── A1: Enrich evidence with source windows ─────────────────────────
      // Load full fact details for subject and reference
      const enrichedSubject = await loadFactDetails(db, subjectFactIds, dealId);
      const enrichedReference = await loadFactDetails(db, referenceFactIds, dealId);

      const subjectWithWindows = enrichedSubject.map((e) => ({
        ...e,
        sourceWindow: sourceWindowMap[e.fact_id] ?? null,
      }));
      const referenceWithWindows = enrichedReference.map((e) => ({
        ...e,
        sourceWindow: sourceWindowMap[e.fact_id] ?? null,
      }));

      if (dryRun) {
        // In dry-run mode, skip LLM call, just verify provenance
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason)
           VALUES ($1, 'finding_assembly', $2, 'complete', 'dry_run')
           ON CONFLICT (run_id, stage, unit_key) DO NOTHING`,
          z.any(),
          [runId, finding.finding_id],
          { label: `Checkpoint (dry_run): ${finding.finding_id}` }
        );
        findingsProcessed++;
        narrativesWritten++;
        const elapsed = Date.now() - unitStart;
        unitDurationMs = Math.round(0.7 * unitDurationMs + 0.3 * elapsed);
        continue;
      }

      // ─── A2: Narrative generation ───────────────────────────────────────
      const topicLabel = getTopicLabel(finding.topic_id);
      const allSourceWindows = Object.values(sourceWindowMap).filter((w): w is string => w != null);

      let narrative: string | null = null;
      let validationPassed = false;
      const rejectedNarratives: string[] = [];

      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = buildNarrativePrompt(
          finding.topic_id,
          topicLabel,
          finding.gap_kind,
          finding.materiality_tier,
          subjectWithWindows,
          referenceWithWindows,
        );

        const aiResp = await aiFn(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: SONNET_MODEL,
              max_tokens: 2000,
              temperature: 0,
              messages: [{ role: "user", content: prompt }],
            },
          },
          { response: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }) },
          { label: `P8 narrative (${finding.topic_id}, attempt ${attempt})` }
        );

        const rawNarrative = aiResp.content?.[0]?.text ?? "";

        // ─── A3: Quote validation ─────────────────────────────────────────
        const validation = validateQuotes(rawNarrative, allSourceWindows);

        if (validation.valid) {
          narrative = rawNarrative;
          validationPassed = true;
          break;
        } else {
          quoteFailures.push({
            finding_id: finding.finding_id,
            quotes: validation.failedQuotes,
            attempt,
          });
          rejectedNarratives.push(rawNarrative);
          console.log(`[P8] Quote validation FAILED (attempt ${attempt}) for ${finding.finding_id}: ${validation.failedQuotes.length} bad quotes`);
        }
      }

      // ─── Persist result ──────────────────────────────────────────────────
      if (validationPassed && narrative) {
        await db.query(
          `UPDATE oa_findings SET narrative = $1 WHERE finding_id = $2`,
          z.any(),
          [narrative, finding.finding_id],
          { label: `Update narrative: ${finding.finding_id}` }
        );
        narrativesWritten++;

        // Persist quote metrics on success for observability
        const quotesExtracted = extractQuotedSpans(narrative);
        const quoteMetrics = {
          quotes_extracted: quotesExtracted.length,
          quotes_validated: quotesExtracted.length,
          quote_texts: quotesExtracted,
          narrative_length: narrative.length,
        };

        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
           VALUES ($1, 'finding_assembly', $2, 'complete', $3::jsonb)
           ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET
             status = 'complete', payload_json = $3::jsonb, updated_at = now()`,
          z.any(),
          [runId, finding.finding_id, JSON.stringify(quoteMetrics)],
          { label: `Checkpoint (success): ${finding.finding_id}` }
        );
      } else {
        // narrative=NULL + flag
        await db.query(
          `UPDATE oa_findings SET narrative = NULL,
            materiality_basis = COALESCE(materiality_basis, '') || ' [quote_validation_failed]'
           WHERE finding_id = $1`,
          z.any(),
          [finding.finding_id],
          { label: `Null narrative (validation fail): ${finding.finding_id}` }
        );
        narrativesNull++;

        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason, payload_json)
           VALUES ($1, 'finding_assembly', $2, 'failed', 'quote_validation_failed', $3::jsonb)
           ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET
             status = 'failed', reason = 'quote_validation_failed', payload_json = $3::jsonb, updated_at = now()`,
          z.any(),
          [runId, finding.finding_id, JSON.stringify({
            failed_quotes: quoteFailures.filter((q) => q.finding_id === finding.finding_id).flatMap((q) => q.quotes),
            rejected_narrative_attempt_1: rejectedNarratives[0] ?? null,
            rejected_narrative_attempt_2: rejectedNarratives[1] ?? null,
            offending_quotes_by_attempt: quoteFailures
              .filter((q) => q.finding_id === finding.finding_id)
              .map((q) => ({ attempt: q.attempt, quotes: q.quotes })),
            source_window_lengths: allSourceWindows.map((w) => w.length),
          })],
          { label: `Checkpoint (quote fail): ${finding.finding_id}` }
        );
      }

      findingsProcessed++;
      const elapsed = Date.now() - unitStart;
      unitDurationMs = Math.round(0.7 * unitDurationMs + 0.3 * elapsed);
    }

    // ─── Return ────────────────────────────────────────────────────────────
    const totalRemaining = workset.length - findingsProcessed;

    if (totalRemaining === 0) {
      return {
        status: "complete" as const,
        findings_completed: findings.length,
        findings_remaining: 0,
        report: {
          F1_findings_processed: findingsProcessed,
          F1_narratives_written: narrativesWritten,
          F1_narratives_null: narrativesNull,
          F2_quote_validation_failures: quoteFailures,
          F3_provenance_rejections: provenanceRejections,
          F4_all_shipped_provenance_valid: provenanceRejections.length === 0,
          F5_empty_char_range_facts: emptyCharRangeFacts,
        },
      };
    }

    return {
      status: "in_progress" as const,
      findings_completed: findingsProcessed,
      findings_remaining: totalRemaining,
      report: {
        message: "Yielded for budget — re-invoke to resume",
        run_id: runId,
        narratives_written_this_invocation: narrativesWritten,
        narratives_null_this_invocation: narrativesNull,
        provenance_rejections_this_invocation: provenanceRejections.length,
        quote_failures_this_invocation: quoteFailures.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFactDetails(
  db: any,
  factIds: string[],
  dealId: string,
): Promise<Array<{
  fact_id: string;
  predicate: string | null;
  value: string | null;
  scope_qualifier: string | null;
  period: string | null;
  adviser_severity: string | null;
  adviser_disposition: string | null;
  document_name: string | null;
}>> {
  if (factIds.length === 0) return [];

  // Batch query — up to ~50 facts at a time for a finding
  const placeholders = factIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.query(
    `SELECT fact_id, predicate, value, scope_qualifier, period,
            adviser_severity, adviser_disposition, document_name
     FROM oa_facts
     WHERE fact_id IN (${placeholders}) AND deal_id = $1`,
    FactSourceRow.pick({
      fact_id: true,
      predicate: true,
      value: true,
      scope_qualifier: true,
      period: true,
      adviser_severity: true,
      adviser_disposition: true,
      document_name: true,
    }),
    [dealId, ...factIds],
    { label: `Load fact details (${factIds.length} ids)` }
  );

  return rows as any;
}

// ---------------------------------------------------------------------------
// Exported validators for unit testing (B4 / dry-run verification)
// ---------------------------------------------------------------------------
export { extractQuotedSpans, normaliseWhitespace, validateQuotes, normaliseQuoteChars };
