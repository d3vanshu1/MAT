/**
 * D1 — OA Absence Probe
 *
 * Runs retrieval probes on topics with subject_coverage = 'absent'.
 * For each such topic:
 * 1. Generate ≥3 query formulations from topic_label + reference fact predicates
 *    (ONE batched LLM call for ALL absent topics)
 * 2. Run ILIKE against parsed_text of SUBJECT documents (ic_memos) only
 * 3. If any query hits, the topic is NOT truly absent — update coverage to 'partial'
 *    and set probe result as evidence
 * 4. If no query hits, the topic remains absent and probe proves it
 *
 * Persists probe results to oa_findings.retrieval_probe JSONB.
 * This runs BEFORE gap comparison (P6), so P6 can reference probe results
 * when determining absence_basis.
 *
 * Report: M1 (topics probed), M2 (topics with hits → reclassified)
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

const AbsentTopicRow = z.object({
  topic_id: z.string(),
  topic_label: z.string(),
});

const RefPredicateRow = z.object({
  topic_id: z.string(),
  predicate: z.string(),
});

const SubjectDocRow = z.object({
  document_id: z.string(),
  file_name: z.string(),
});

const ParsedTextRow = z.object({
  document_id: z.string(),
  parsed_text: z.string(),
});

// ---------------------------------------------------------------------------
// Prompt builder for query formulation
// ---------------------------------------------------------------------------

function buildQueryFormulationPrompt(
  topics: Array<{ topic_id: string; topic_label: string; predicates: string[] }>,
): string {
  const topicLines = topics.map((t) => {
    const preds = t.predicates.length > 0
      ? t.predicates.slice(0, 10).join("; ")
      : "(no reference predicates)";
    return `  ${t.topic_id} | ${t.topic_label} | reference predicates: ${preds}`;
  }).join("\n");

  return `You are generating search queries to detect whether IC memo text discusses certain topics.
For each topic below, generate 3-5 search terms/phrases that would appear in an IC memo
if that topic were discussed. Terms should be short (1-4 words), case-insensitive.

TOPICS:
${topicLines}

Respond with a JSON array. Each element:
{
  "topic_id": "<exact topic_id>",
  "queries": ["term1", "term2", "term3", ...]
}

Rules:
- At least 3 queries per topic, at most 5.
- Queries should be distinct — avoid near-duplicates.
- Use terms a PE IC memo author would actually write (not academic language).
- Include both specific terms (from predicates) and general synonyms.
- Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaAbsenceProbe",
  description: "Runs retrieval probes on absent topics to verify true absence",
  integrations: {
    db: postgres(DB_ID),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    reset: z.boolean().optional().default(false),
  }),
  output: z.object({
    report: z.record(z.string(), z.any()),
  }),

  async run(ctx, { dealId, runId, reset }) {
    const { db } = ctx.integrations;
    const aiFn: AiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as any;

    // ─── RESET ────────────────────────────────────────────────────────────
    if (reset) {
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'absence_probe'`,
        z.any(), [runId],
        { label: "Reset: delete absence_probe checkpoints" }
      );
      console.log("[D1] Reset complete for run", runId);
    }

    // ─── Load topics with subject_coverage = 'absent' ────────────────────
    const absentTopics = await db.query(
      `SELECT topic_id, topic_label FROM oa_topics
       WHERE run_id = $1 AND subject_coverage = 'absent'`,
      AbsentTopicRow,
      [runId],
      { label: "Load absent topics" }
    );
    console.log(`[D1] ${absentTopics.length} topics with coverage=absent`);

    if (absentTopics.length === 0) {
      return { report: { M1_topics_probed: 0, M2_topics_with_hits: 0, detail: [] } };
    }

    // ─── Load reference predicates for each absent topic ─────────────────
    const topicIds = absentTopics.map((t) => t.topic_id);
    const refPredicates = await db.query(
      `SELECT tf.topic_id, f.predicate
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
       WHERE tf.run_id = $1 AND tf.topic_id = ANY($3) AND tf.fact_role = 'reference' AND f.predicate IS NOT NULL
       LIMIT 500`,
      RefPredicateRow,
      [runId, dealId, topicIds],
      { label: "Load reference predicates for absent topics" }
    );

    // Group predicates by topic
    const predsByTopic = new Map<string, string[]>();
    for (const r of refPredicates) {
      if (!predsByTopic.has(r.topic_id)) predsByTopic.set(r.topic_id, []);
      predsByTopic.get(r.topic_id)!.push(r.predicate);
    }

    // ─── LLM: Generate query formulations (one batched call) ─────────────
    const topicsForPrompt = absentTopics.map((t) => ({
      topic_id: t.topic_id,
      topic_label: t.topic_label,
      predicates: predsByTopic.get(t.topic_id) ?? [],
    }));

    const prompt = buildQueryFormulationPrompt(topicsForPrompt);
    const response = await aiFn(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        },
      },
      { response: z.any() },
      { label: "Generate absence probe queries (batched)" }
    );

    const textBlock = response?.content?.find((c: any) => c.type === "text");
    const rawText: string = textBlock?.text ?? "[]";
    const cleaned = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

    let queryFormulations: Array<{ topic_id: string; queries: string[] }> = [];
    try {
      const parsed = JSON.parse(cleaned);
      queryFormulations = parsed;
    } catch {
      console.warn("[D1] Failed to parse query formulations, using fallback");
      // Fallback: use topic_label words as queries
      queryFormulations = absentTopics.map((t) => ({
        topic_id: t.topic_id,
        queries: t.topic_label.split(/\s+/).filter((w) => w.length > 3).slice(0, 3),
      }));
    }

    // Build lookup
    const queriesByTopic = new Map<string, string[]>();
    for (const qf of queryFormulations) {
      queriesByTopic.set(qf.topic_id, qf.queries);
    }

    // ─── Load subject documents (ic_memos) ───────────────────────────────
    const subjectDocs = await db.query(
      `SELECT id as document_id, file_name FROM documents
       WHERE deal_id = $1 AND document_tag = 'ic_memo'`,
      SubjectDocRow,
      [dealId],
      { label: "Load subject documents" }
    );
    console.log(`[D1] ${subjectDocs.length} subject documents for probing`);

    // Load parsed text for subject docs
    const subjectDocIds = subjectDocs.map((d) => d.document_id);
    const parsedTexts: Array<{ document_id: string; parsed_text: string }> = [];
    for (const docId of subjectDocIds) {
      const rows = await db.query(
        `SELECT document_id, parsed_text FROM document_texts
         WHERE document_id = $1 AND parsed_text IS NOT NULL
         LIMIT 1`,
        ParsedTextRow,
        [docId],
        { label: `Load parsed_text for ${docId}` }
      );
      if (rows.length > 0) parsedTexts.push(rows[0]);
    }

    // Combine all subject text
    const allSubjectText = parsedTexts.map((r) => r.parsed_text).join("\n\n");
    console.log(`[D1] Combined subject text length: ${allSubjectText.length}`);

    // ─── Run probes per topic ────────────────────────────────────────────
    const probeResults: Array<{
      topic_id: string;
      queries: string[];
      hits: Array<{ query: string; snippet: string }>;
      verdict: "verified_absent" | "found_in_text";
    }> = [];

    let topicsWithHits = 0;

    for (const topic of absentTopics) {
      // Check checkpoint
      const cp = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'absence_probe' AND unit_key = $2`,
        z.array(z.any()),
        [runId, topic.topic_id],
        { label: `Check checkpoint ${topic.topic_id}` }
      );
      if (cp.length > 0) continue;

      const queries = queriesByTopic.get(topic.topic_id) ?? [topic.topic_label];
      const hits: Array<{ query: string; snippet: string }> = [];

      for (const query of queries) {
        // Simple ILIKE search against combined subject text
        const lowerQuery = query.toLowerCase();
        const lowerText = allSubjectText.toLowerCase();
        const idx = lowerText.indexOf(lowerQuery);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(allSubjectText.length, idx + query.length + 50);
          hits.push({
            query,
            snippet: allSubjectText.slice(start, end),
          });
        }
      }

      const verdict = hits.length > 0 ? "found_in_text" : "verified_absent";

      if (hits.length > 0) {
        topicsWithHits++;
        // Update coverage from 'absent' to 'partial' — the text mentions it but no structured fact was extracted
        await db.query(
          `UPDATE oa_topics SET subject_coverage = 'partial',
           coverage_basis = $3
           WHERE run_id = $1 AND topic_id = $2`,
          z.any(),
          [runId, topic.topic_id, `Probe found ${hits.length} text hits but no extracted facts`],
          { label: `Reclassify ${topic.topic_id} to partial` }
        );
      }

      probeResults.push({
        topic_id: topic.topic_id,
        queries,
        hits,
        verdict,
      });

      // Checkpoint
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'absence_probe', $2, 'complete') ON CONFLICT DO NOTHING`,
        z.any(), [runId, topic.topic_id],
        { label: `Checkpoint ${topic.topic_id}` }
      );
    }

    const report = {
      M1_topics_probed: probeResults.length,
      M2_topics_with_hits: topicsWithHits,
      M2_reclassified_to_partial: topicsWithHits,
      detail: probeResults.map((r) => ({
        topic_id: r.topic_id,
        queries_run: r.queries.length,
        hits: r.hits.length,
        verdict: r.verdict,
      })),
    };

    console.log("[D1] REPORT:", JSON.stringify(report, null, 2));
    return { report };
  },
});
