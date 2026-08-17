/**
 * D1 — OA Absence Probe
 *
 * Runs retrieval probes on topics with subject_coverage = 'absent'.
 * For each such topic:
 * 1. Generate ≥3 query formulations from topic_label + reference fact predicates
 *    (ONE batched LLM call for ALL absent topics)
 * 2. Run substring search against parsed_text of SUBJECT documents (ic_memos) only
 * 3. If any query hits, the topic is NOT truly absent — update coverage to 'partial'
 *    and set probe result as evidence
 * 4. If no query hits, the topic remains absent and probe proves it
 *
 * This runs BEFORE gap comparison (P6), so P6 can reference probe results
 * when determining absence_basis.
 *
 * PERFORMANCE: Bulk checkpoint handling. Single LLM call. In-memory text search.
 *
 * Report: M1 (topics probed), M2 (topics with hits → reclassified)
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

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
  parsed_text: z.string(),
});

const CheckpointRow = z.object({
  unit_key: z.string(),
});

// ---------------------------------------------------------------------------
// Prompt builder for query formulation
// ---------------------------------------------------------------------------

function buildQueryFormulationPrompt(
  topics: Array<{ topic_id: string; topic_label: string; predicates: string[] }>,
): string {
  const topicLines = topics.map((t) => {
    const preds = t.predicates.length > 0
      ? t.predicates.slice(0, 5).join("; ")
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
    status: z.enum(["complete", "in_progress"]),
    topics_completed: z.number(),
    topics_remaining: z.number(),
    report: z.record(z.string(), z.any()).optional(),
  }),

  async run(ctx, { dealId, runId, reset }) {
    const { db } = ctx.integrations;
    const aiFn: AiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as any;

    // ─── RESET ────────────────────────────────────────────────────────────
    if (reset) {
      // Revert probe-reclassified topics back to absent
      await db.query(
        `UPDATE oa_topics SET subject_coverage = 'absent', coverage_basis = '0 subject facts on this topic'
         WHERE run_id = $1::uuid AND subject_coverage = 'partial'
           AND coverage_basis LIKE 'Probe found%'`,
        z.any(), [runId],
        { label: "Reset: revert probe-partial topics to absent" }
      );
      // Delete checkpoints
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'absence_probe'`,
        z.any(), [runId],
        { label: "Reset: delete absence_probe checkpoints" }
      );
      console.log("[D1] Reset complete for run", runId);
    }

    // ─── Load topics with subject_coverage = 'absent' ────────────────────
    const absentTopics = await db.query(
      `SELECT topic_id, topic_label FROM oa_topics
       WHERE run_id = $1::uuid AND subject_coverage = 'absent'`,
      AbsentTopicRow,
      [runId],
      { label: "Load absent topics" }
    );
    console.log(`[D1] ${absentTopics.length} topics with coverage=absent`);

    if (absentTopics.length === 0) {
      return { status: "complete" as const, topics_completed: 0, topics_remaining: 0, report: { M1_topics_probed: 0, M2_topics_with_hits: 0, detail: [] } };
    }

    // ─── Load existing checkpoints — skip already probed ─────────────────
    const existingCps = await db.query(
      `SELECT unit_key FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'absence_probe'`,
      CheckpointRow,
      [runId],
      { label: "Load existing checkpoints" }
    );
    const completedSet = new Set(existingCps.map((r) => r.unit_key));
    const pendingTopics = absentTopics.filter((t) => !completedSet.has(t.topic_id));
    console.log(`[D1] Already checkpointed: ${completedSet.size}, pending: ${pendingTopics.length}`);

    if (pendingTopics.length === 0) {
      console.log("[D1] All topics already probed — skipping to report");
    }

    // ─── Load reference predicates (bulk, once) ──────────────────────────
    const topicIds = pendingTopics.map((t) => t.topic_id);
    const refPredicates = await db.query(
      `SELECT tf.topic_id, f.predicate
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2::uuid
       WHERE tf.run_id = $1::uuid AND tf.topic_id = ANY($3::text[]) AND tf.fact_role = 'reference' AND f.predicate IS NOT NULL
       LIMIT 1000`,
      RefPredicateRow,
      [runId, dealId, topicIds],
      { label: "Bulk load reference predicates" }
    );

    // Group predicates by topic
    const predsByTopic = new Map<string, string[]>();
    for (const r of refPredicates) {
      if (!predsByTopic.has(r.topic_id)) predsByTopic.set(r.topic_id, []);
      predsByTopic.get(r.topic_id)!.push(r.predicate);
    }

    // ─── Load IC memo parsed_text one-by-one (gRPC 4MB cap) ────────────
    const docListRows = await db.query(
      `SELECT id AS document_id, file_name FROM documents
       WHERE deal_id = $1::uuid AND document_tag = 'ic_memo' AND parsed_text IS NOT NULL`,
      z.object({ document_id: z.string(), file_name: z.string() }),
      [dealId],
      { label: "List IC memo documents" }
    );
    console.log(`[D1] ${docListRows.length} IC memos to load`);

    const subjectDocs: Array<{ document_id: string; file_name: string; parsed_text: string }> = [];
    for (const doc of docListRows) {
      const textRows = await db.query(
        `SELECT parsed_text FROM documents WHERE id = $1::uuid AND parsed_text IS NOT NULL`,
        z.object({ parsed_text: z.string() }),
        [doc.document_id],
        { label: `Load text: ${doc.file_name}` }
      );
      if (textRows.length > 0) {
        subjectDocs.push({ ...doc, parsed_text: textRows[0].parsed_text });
      }
    }
    console.log(`[D1] Loaded ${subjectDocs.length} IC memos (total text: ${subjectDocs.reduce((s, d) => s + d.parsed_text.length, 0)} chars)`);

    // Combine for search
    const allSubjectText = subjectDocs.map((d) => d.parsed_text).join("\n\n");
    const allSubjectTextLower = allSubjectText.toLowerCase();

    if (pendingTopics.length > 0) {
      // ─── LLM: Generate query formulations ────────────────────────────────
      // Split into batches of 75 topics to keep prompt/response manageable
      const LLM_BATCH = 50;
      const queriesByTopic = new Map<string, string[]>();

      for (let i = 0; i < pendingTopics.length; i += LLM_BATCH) {
        const batch = pendingTopics.slice(i, i + LLM_BATCH);
        const topicsForPrompt = batch.map((t) => ({
          topic_id: t.topic_id,
          topic_label: t.topic_label,
          predicates: predsByTopic.get(t.topic_id) ?? [],
        }));

        const prompt = buildQueryFormulationPrompt(topicsForPrompt);
        console.log(`[D1] LLM batch ${Math.floor(i / LLM_BATCH) + 1}: ${batch.length} topics`);

        const response = await aiFn(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: "claude-sonnet-4-6",
              max_tokens: 8192,
              temperature: 0,
              messages: [{ role: "user", content: prompt }],
            },
          },
          { response: z.any() },
          { label: `Generate probe queries (batch ${Math.floor(i / LLM_BATCH) + 1})` }
        );

        const textBlock = response?.content?.find((c: any) => c.type === "text");
        const rawText: string = textBlock?.text ?? "[]";
        const cleaned = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

        try {
          const parsed = JSON.parse(cleaned);
          for (const qf of parsed) {
            if (qf.topic_id && Array.isArray(qf.queries)) {
              queriesByTopic.set(qf.topic_id, qf.queries);
            }
          }
        } catch {
          console.warn(`[D1] Failed to parse LLM batch ${Math.floor(i / LLM_BATCH) + 1}, using fallback`);
          for (const t of batch) {
            queriesByTopic.set(t.topic_id, t.topic_label.split(/[\s.\-]+/).filter((w) => w.length > 3).slice(0, 3));
          }
        }
      }

      // ─── Run probes (in-memory, fast) ───────────────────────────────────
      const probeResults: Array<{
        topic_id: string;
        queries: string[];
        hits: Array<{ query: string; snippet: string; document: string }>;
        verdict: "verified_absent" | "found_in_text";
      }> = [];

      let topicsWithHits = 0;
      const reclassifyTopicIds: string[] = [];
      const reclassifyBases: string[] = [];

      for (const topic of pendingTopics) {
        const queries = queriesByTopic.get(topic.topic_id) ?? [topic.topic_label];
        const hits: Array<{ query: string; snippet: string; document: string }> = [];

        for (const query of queries) {
          const lowerQuery = query.toLowerCase();
          // Search in each document separately to report which doc had the hit
          for (const doc of subjectDocs) {
            const docTextLower = doc.parsed_text.toLowerCase();
            const idx = docTextLower.indexOf(lowerQuery);
            if (idx >= 0) {
              const start = Math.max(0, idx - 80);
              const end = Math.min(doc.parsed_text.length, idx + query.length + 80);
              hits.push({
                query,
                snippet: doc.parsed_text.slice(start, end),
                document: doc.file_name,
              });
              break; // One hit per query is enough
            }
          }
        }

        const verdict = hits.length > 0 ? "found_in_text" : "verified_absent";

        // ─── STRICTER THRESHOLD ─────────────────────────────────────────
        // A single generic keyword hit (1-word query) is insufficient.
        // Require EITHER: a multi-word phrase match, OR hits from ≥2 distinct queries.
        let passesThreshold = false;
        if (hits.length >= 2) {
          // Hits from 2+ distinct queries → strong signal
          const distinctQueryHits = new Set(hits.map(h => h.query));
          passesThreshold = distinctQueryHits.size >= 2;
        }
        if (!passesThreshold && hits.length > 0) {
          // Check if any hit was from a multi-word phrase (≥2 words)
          passesThreshold = hits.some(h => h.query.trim().split(/\s+/).length >= 2);
        }

        if (passesThreshold) {
          topicsWithHits++;
          reclassifyTopicIds.push(topic.topic_id);
          reclassifyBases.push(`Probe found ${hits.length} text hit(s) but no extracted facts`);
        }

        probeResults.push({
          topic_id: topic.topic_id,
          queries,
          hits,
          verdict,
        });
      }

      // ─── Bulk reclassify topics with hits ─────────────────────────────────
      if (reclassifyTopicIds.length > 0) {
        // Update each one (can't easily bulk-update with different basis per row without VALUES)
        for (let i = 0; i < reclassifyTopicIds.length; i++) {
          await db.query(
            `UPDATE oa_topics SET subject_coverage = 'partial', coverage_basis = $3
             WHERE run_id = $1::uuid AND topic_id = $2`,
            z.any(),
            [runId, reclassifyTopicIds[i], reclassifyBases[i]],
            { label: `Reclassify to partial: ${reclassifyTopicIds[i]}` }
          );
        }
      }

      // ─── Persist probe results to checkpoints with payload_json ─────────
      if (pendingTopics.length > 0) {
        for (const result of probeResults) {
          const payload = JSON.stringify({
            verdict: result.verdict,
            queries: result.queries,
            hits: result.hits,
          });
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
             VALUES ($1::uuid, 'absence_probe', $2, 'complete', $3::jsonb)
             ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET payload_json = $3::jsonb, updated_at = now()`,
            z.any(),
            [runId, result.topic_id, payload],
            { label: `Checkpoint+payload: ${result.topic_id}` }
          );
        }
      }

      // ─── Build report ───────────────────────────────────────────────────
      const hitDetails = probeResults.filter((r) => r.verdict === "found_in_text");

      const report = {
        M1_topics_probed: probeResults.length,
        M1_topics_with_hits: topicsWithHits,
        M1_topics_verified_absent: probeResults.length - topicsWithHits,
        M2_hit_details: hitDetails.map((r) => ({
          topic_id: r.topic_id,
          queries: r.queries,
          hits: r.hits,
        })),
      };

      console.log(`[D1] COMPLETE: ${probeResults.length} probed, ${topicsWithHits} hits, ${probeResults.length - topicsWithHits} verified absent`);
      return { status: "complete" as const, topics_completed: probeResults.length, topics_remaining: 0, report };
    }

    // If all were already checkpointed, return a summary report
    return {
      status: "complete" as const,
      topics_completed: completedSet.size,
      topics_remaining: 0,
      report: { M1_topics_probed: completedSet.size, message: "All topics were already checkpointed from prior run" },
    };
  },
});
