/**
 * P4 — OA Topic Assignment (Stage S2)
 *
 * Assigns each oa_fact to one or more topics from the seeded taxonomy (44),
 * plus emergent topics discovered by the model during assignment.
 *
 * Flow:
 * 1. Insert all 44 SEEDED_TOPICS into oa_topics (idempotent ON CONFLICT)
 * 2. Load oa_facts paginated (page 50), subject docs first then reference
 * 3. Batch 100 facts per LLM call — model returns topic_id per fact
 * 4. Collect emergent topic_ids across all batches
 * 5. Single classifyEmergentTopics call to classify + parent them
 * 6. Insert emergent topics into oa_topics
 * 7. Insert all oa_topic_facts rows
 * 8. Clustering integrity probes (6 probes)
 * 9. Checkpoint per document:batch_ordinal
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  SEEDED_TOPICS,
  OBLIGATION_CHECKLIST_VERSION,
  isSeededTopic,
  getSeededTopic,
} from "./oa-taxonomy.js";
import { classifyEmergentTopics } from "./oa-obligation.js";
import { SONNET_MODEL } from "./model-config.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const FACT_PAGE_SIZE = 50;
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildAssignmentPrompt(
  facts: Array<{
    idx: number;
    fact_type: string;
    predicate: string | null;
    value: string | null;
    scope_qualifier: string;
    document_role: string;
  }>,
): string {
  const topicLines = SEEDED_TOPICS.map(
    (t) => `  ${t.topic_id} | ${t.topic_label}`
  ).join("\n");

  const factLines = facts.map(
    (f) =>
      `  [${f.idx}] type=${f.fact_type} | predicate=${f.predicate ?? "NULL"} | value=${f.value ?? "NULL"} | scope=${f.scope_qualifier} | role=${f.document_role}`
  ).join("\n");

  return `You are assigning due-diligence facts to topics.

SEEDED TOPICS (assign to these when they fit):
${topicLines}

If a fact does not fit ANY seeded topic, you may propose an EMERGENT topic_id.
Emergent IDs must be lowercase dot-separated (e.g. "cyber.incident-history").
Only propose an emergent topic if no seeded topic is a reasonable match.

FACTS TO ASSIGN:
${factLines}

For EACH fact, respond with a JSON array. Each element:
{
  "idx": <fact index number>,
  "topic_id": "<seeded or emergent topic_id>",
  "confidence": <0.0 to 1.0>
}

Rules:
- Every fact index MUST appear exactly once in your response.
- Assign exactly ONE topic_id per fact (the best match).
- Use seeded topics preferentially. Only create emergent if truly none fit.
- Confidence < 0.5 means weak match — still assign the best one.
- Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const AssignmentResultSchema = z.array(
  z.object({
    idx: z.number(),
    topic_id: z.string(),
    confidence: z.number(),
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

interface FactRow {
  fact_id: string;
  fact_type: string;
  predicate: string | null;
  value: string | null;
  scope_qualifier: string;
  document_role: string;
  document_id: string;
}

const FactRowSchema = z.object({
  fact_id: z.string(),
  fact_type: z.string(),
  predicate: z.string().nullable(),
  value: z.string().nullable(),
  scope_qualifier: z.string(),
  document_role: z.string(),
  document_id: z.string(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaTopicAssignment",
  description: "Assigns oa_facts to topics via batched LLM calls",
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
        `DELETE FROM oa_topic_facts WHERE run_id = $1`,
        z.any(), [runId],
        { label: "Reset: delete oa_topic_facts" }
      );
      await db.query(
        `DELETE FROM oa_topics WHERE run_id = $1`,
        z.any(), [runId],
        { label: "Reset: delete oa_topics" }
      );
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment'`,
        z.any(), [runId],
        { label: "Reset: delete checkpoints" }
      );
      console.log("[P4] Reset complete for run", runId);
    }

    // ─── A1: Seed oa_topics ───────────────────────────────────────────────
    for (const t of SEEDED_TOPICS) {
      await db.query(
        `INSERT INTO oa_topics (run_id, topic_id, deal_id, topic_label, parent_topic_id, obligation_class, obligation_basis, checklist_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id, topic_id) DO NOTHING`,
        z.any(),
        [runId, t.topic_id, dealId, t.topic_label, t.parent_topic_id, t.obligation_class, t.obligation_basis, OBLIGATION_CHECKLIST_VERSION],
        { label: `Seed topic: ${t.topic_id}` }
      );
    }
    console.log(`[P4] Seeded ${SEEDED_TOPICS.length} topics`);

    // ─── A2: Load facts (subject first, then reference) ──────────────────
    const allFacts: FactRow[] = [];
    for (const role of ["subject", "reference"]) {
      let offset = 0;
      while (true) {
        const page = await db.query(
          `SELECT fact_id, fact_type, predicate, value, scope_qualifier, document_role, document_id
           FROM oa_facts
           WHERE deal_id = $1 AND document_role = $2
           ORDER BY document_id, fact_id
           LIMIT $3 OFFSET $4`,
          FactRowSchema,
          [dealId, role, FACT_PAGE_SIZE, offset],
          { label: `Load ${role} facts offset=${offset}` }
        );
        if (page.length === 0) break;
        allFacts.push(...page);
        offset += page.length;
        if (page.length < FACT_PAGE_SIZE) break;
      }
    }
    console.log(`[P4] Loaded ${allFacts.length} facts (subject first)`);

    // ─── A2+: Batch LLM calls ────────────────────────────────────────────
    // Track assignments + emergent topics
    const assignments: Array<{ fact_id: string; topic_id: string; confidence: number }> = [];
    const emergentTopicIds = new Set<string>();
    let batchOrdinal = 0;
    let llmCalls = 0;

    // Group facts by document for checkpoint tracking
    let currentDocId = "";
    let docBatchOrdinal = 0;

    for (let i = 0; i < allFacts.length; i += BATCH_SIZE) {
      const batch = allFacts.slice(i, i + BATCH_SIZE);
      batchOrdinal++;

      // Track document transitions
      const batchDocId = batch[0].document_id;
      if (batchDocId !== currentDocId) {
        currentDocId = batchDocId;
        docBatchOrdinal = 0;
      }
      docBatchOrdinal++;

      // Check checkpoint
      const unitKey = `${currentDocId}:${docBatchOrdinal}`;
      const existing = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment' AND unit_key = $2`,
        z.array(z.any()),
        [runId, unitKey],
        { label: `Check checkpoint ${unitKey}` }
      );
      if (existing.length > 0) {
        console.log(`[P4] Skipping batch ${unitKey} (checkpointed)`);
        continue;
      }

      // Build prompt
      const promptFacts = batch.map((f, idx) => ({
        idx: i + idx,
        fact_type: f.fact_type,
        predicate: f.predicate ? f.predicate.slice(0, 200) : null,
        value: f.value ? f.value.slice(0, 200) : null,
        scope_qualifier: f.scope_qualifier,
        document_role: f.document_role,
      }));

      const prompt = buildAssignmentPrompt(promptFacts);

      // LLM call
      const response = await aiFn(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }],
          },
        },
        { response: z.any() },
        { label: `Topic assignment batch ${batchOrdinal}` }
      );
      llmCalls++;

      // Parse response (Anthropic Messages format)
      const textBlock = response?.content?.find((c: any) => c.type === "text");
      const rawText: string = textBlock?.text ?? "[]";
      const cleaned = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn(`[P4] Parse failure batch ${batchOrdinal}, defaulting to dd.coverage`);
        // Default all to dd.coverage
        for (const f of batch) {
          assignments.push({ fact_id: f.fact_id, topic_id: "dd.coverage", confidence: 0.1 });
        }
        // Write checkpoint anyway
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'topic_assignment', $2, 'complete') ON CONFLICT DO NOTHING`,
          z.any(), [runId, unitKey],
          { label: `Checkpoint ${unitKey}` }
        );
        continue;
      }

      const validated = AssignmentResultSchema.safeParse(parsed);
      if (!validated.success) {
        console.warn(`[P4] Schema validation failed batch ${batchOrdinal}`);
        for (const f of batch) {
          assignments.push({ fact_id: f.fact_id, topic_id: "dd.coverage", confidence: 0.1 });
        }
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'topic_assignment', $2, 'complete') ON CONFLICT DO NOTHING`,
          z.any(), [runId, unitKey],
          { label: `Checkpoint ${unitKey}` }
        );
        continue;
      }

      // Map results back to fact_ids
      const resultMap = new Map<number, { topic_id: string; confidence: number }>();
      for (const r of validated.data) {
        resultMap.set(r.idx, { topic_id: r.topic_id, confidence: r.confidence });
      }

      for (let j = 0; j < batch.length; j++) {
        const globalIdx = i + j;
        const result = resultMap.get(globalIdx);
        const topicId = result?.topic_id ?? "dd.coverage";
        const confidence = result?.confidence ?? 0.1;
        assignments.push({ fact_id: batch[j].fact_id, topic_id: topicId, confidence });
        if (!isSeededTopic(topicId)) {
          emergentTopicIds.add(topicId);
        }
      }

      // Write checkpoint
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'topic_assignment', $2, 'complete') ON CONFLICT DO NOTHING`,
        z.any(), [runId, unitKey],
        { label: `Checkpoint ${unitKey}` }
      );
    }

    console.log(`[P4] ${llmCalls} LLM calls, ${assignments.length} assignments, ${emergentTopicIds.size} emergent topics`);

    // ─── A2+: Classify and insert emergent topics ─────────────────────────
    if (emergentTopicIds.size > 0) {
      const emergentList = Array.from(emergentTopicIds).map((id) => ({
        topic_id: id,
        topic_label: id.replace(/[.\-_]/g, " "), // rough label from ID
      }));

      const classified = await classifyEmergentTopics(emergentList, aiFn);

      for (const c of classified) {
        if (isSeededTopic(c.topic_id)) continue; // already seeded
        await db.query(
          `INSERT INTO oa_topics (run_id, topic_id, deal_id, topic_label, parent_topic_id, obligation_class, obligation_basis, checklist_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (run_id, topic_id) DO NOTHING`,
          z.any(),
          [runId, c.topic_id, dealId, c.topic_id.replace(/[.\-_]/g, " "), c.parent_topic_id, c.obligation_class, c.obligation_basis, OBLIGATION_CHECKLIST_VERSION],
          { label: `Insert emergent topic: ${c.topic_id}` }
        );
      }
      console.log(`[P4] Inserted ${emergentTopicIds.size} emergent topics`);
    }

    // ─── A2+: Insert oa_topic_facts ───────────────────────────────────────
    // Build fact_id → document_role lookup
    const factRoleLookup = new Map<string, string>();
    for (const f of allFacts) {
      factRoleLookup.set(f.fact_id, f.document_role);
    }

    let insertedTopicFacts = 0;
    for (let i = 0; i < assignments.length; i += 50) {
      const batch = assignments.slice(i, i + 50);
      const values: string[] = [];
      const params: any[] = [runId];
      let paramIdx = 2;

      for (const a of batch) {
        const factRole = factRoleLookup.get(a.fact_id) ?? "reference";
        values.push(`($1, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`);
        params.push(a.topic_id, a.fact_id, factRole);
        paramIdx += 3;
      }

      await db.query(
        `INSERT INTO oa_topic_facts (run_id, topic_id, fact_id, fact_role)
         VALUES ${values.join(", ")}
         ON CONFLICT (run_id, topic_id, fact_id) DO NOTHING`,
        z.any(),
        params,
        { label: `Insert topic_facts batch ${Math.floor(i / 50)}` }
      );
      insertedTopicFacts += batch.length;
    }
    console.log(`[P4] Inserted ${insertedTopicFacts} oa_topic_facts rows`);

    // ─── A3: Clustering integrity probes ──────────────────────────────────
    // T1: Total distinct topics assigned
    const t1 = await db.query(
      `SELECT COUNT(DISTINCT topic_id) as cnt FROM oa_topic_facts WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "T1: distinct topics" }
    );

    // T2: Fact coverage — facts with at least one topic assignment
    const t2 = await db.query(
      `SELECT COUNT(DISTINCT fact_id) as assigned FROM oa_topic_facts WHERE run_id = $1`,
      z.object({ assigned: z.coerce.number() }),
      [runId],
      { label: "T2: assigned facts" }
    );

    // T3: Emergent topic count
    const t3emergent = emergentTopicIds.size;

    // T4: Top 5 topics by fact count
    const t4 = await db.query(
      `SELECT topic_id, COUNT(*) as fact_count
       FROM oa_topic_facts WHERE run_id = $1
       GROUP BY topic_id ORDER BY fact_count DESC LIMIT 5`,
      z.object({ topic_id: z.string(), fact_count: z.coerce.number() }),
      [runId],
      { label: "T4: top 5 topics" }
    );

    // T5: Topics with zero facts
    const t5 = await db.query(
      `SELECT t.topic_id FROM oa_topics t
       LEFT JOIN oa_topic_facts tf ON tf.run_id = t.run_id AND tf.topic_id = t.topic_id
       WHERE t.run_id = $1 AND tf.fact_id IS NULL`,
      z.object({ topic_id: z.string() }),
      [runId],
      { label: "T5: topics with zero facts" }
    );

    // T6: Average confidence
    // (Not stored in DB — compute from in-memory assignments)
    const avgConfidence = assignments.length > 0
      ? assignments.reduce((s, a) => s + (a.confidence ?? 0), 0) / assignments.length
      : 0;

    // T7: Churn facts co-located on revenue-quality.churn
    const t7 = await db.query(
      `SELECT tf.fact_id, f.predicate, f.value, f.document_role
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
       WHERE tf.run_id = $1 AND tf.topic_id = 'revenue-quality.churn'
       LIMIT 10`,
      z.object({
        fact_id: z.string(),
        predicate: z.string().nullable(),
        value: z.string().nullable(),
        document_role: z.string(),
      }),
      [runId, dealId],
      { label: "T7: churn facts on revenue-quality.churn" }
    );

    const report = {
      T1_distinct_topics: t1[0]?.cnt ?? 0,
      T2_facts_assigned: t2[0]?.assigned ?? 0,
      T2_total_facts: allFacts.length,
      T3_emergent_topics: t3emergent,
      T4_top5: t4,
      T5_zero_fact_topics: t5.map((r) => r.topic_id),
      T6_avg_confidence: avgConfidence.toFixed(3),
      T7_churn_facts: t7,
      llm_calls: llmCalls,
    };

    console.log("[P4] REPORT:", JSON.stringify(report, null, 2));
    return { report };
  },
});
