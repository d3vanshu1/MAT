/**
 * P6 — OA Gap Comparison
 *
 * Per-topic gap detection. For each topic, evaluates whether the subject set
 * adequately addresses what the reference set discusses.
 *
 * 5 gap kinds evaluated in order (first match wins):
 * 1. not_disclosed — topic absent from subject entirely (verified by probe)
 * 2. scope_mismatch — subject mentions topic but with narrower/different scope
 * 3. unreconciled_divergence — subject contradicts or materially deviates from reference
 * 4. stale_supersession — subject addresses topic but with outdated data (DISABLED)
 * 5. unquantified — subject discusses qualitatively but lacks quantification present in reference
 *
 * Rules:
 * - ENABLE_STALE_SUPERSESSION = false (kind never emitted)
 * - One LLM call per topic with both fact sets visible
 * - Churn worked example in prompt
 * - INSERT to oa_findings with placeholder materiality_tier=3/basis='awaiting_materiality_assessment'
 * - absence_basis written by code only (never by LLM)
 * - Topics with obligation_class = 'not_memo_relevant' → skip
 * - Topics with subject_coverage = 'present' AND no gap detected → no finding
 *
 * Checkpoint: stage='gap_comparison', unit_key=topic_id
 * Report: G1-G6
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const ENABLE_STALE_SUPERSESSION = false;

// Budget guard constants
const HARD_KILL_MS = 200_000;          // conservative: yield well before platform kill
const SAFETY_MARGIN_MS = 45_000;       // do not start work inside this window
const DEFAULT_UNIT_DURATION_MS = 15_000; // conservative seed for rolling average

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

const TopicWithCoverageRow = z.object({
  topic_id: z.string(),
  topic_label: z.string(),
  obligation_class: z.string(),
  subject_coverage: z.string().nullable(),
});

const TopicFactDetail = z.object({
  fact_id: z.string(),
  fact_role: z.string(),
  predicate: z.string().nullable(),
  value: z.string().nullable(),
  scope_qualifier: z.string().nullable(),
  fact_type: z.string(),
  supersession: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildGapPrompt(
  topicId: string,
  topicLabel: string,
  subjectFacts: Array<{ predicate: string | null; value: string | null; scope_qualifier: string | null; fact_type: string; supersession: string | null }>,
  referenceFacts: Array<{ predicate: string | null; value: string | null; scope_qualifier: string | null; fact_type: string }>,
): string {
  const subLines = subjectFacts.map((f, i) =>
    `  [S${i}] type=${f.fact_type} | predicate=${f.predicate ?? "NULL"} | value=${f.value ?? "NULL"} | scope=${f.scope_qualifier ?? "NULL"} | supersession=${f.supersession ?? "N/A"}`
  ).join("\n");

  const refLines = referenceFacts.map((f, i) =>
    `  [R${i}] type=${f.fact_type} | predicate=${f.predicate ?? "NULL"} | value=${f.value ?? "NULL"} | scope=${f.scope_qualifier ?? "NULL"}`
  ).join("\n");

  return `You are comparing IC memo coverage (SUBJECT facts) against adviser reports (REFERENCE facts)
for a single topic to detect gaps.

TOPIC: ${topicId} | ${topicLabel}

SUBJECT FACTS (from IC memo):
${subLines || "  (none)"}

REFERENCE FACTS (from adviser reports):
${refLines || "  (none)"}

GAP KINDS to evaluate (in priority order — first match wins):
1. scope_mismatch — subject discusses topic but with narrower scope than reference
2. unreconciled_divergence — subject contradicts or materially differs from reference
3. unquantified — subject discusses qualitatively but reference has quantification not carried forward

NOTE: "not_disclosed" and "stale_supersession" are determined by code. You only evaluate the 3 above.

WORKED EXAMPLE — revenue-quality.churn:
If subject facts include "annual churn rate = 8%" and reference has "annual churn rate = 8%" and
"monthly churn rate = 0.7%" plus "logo churn = 3 customers/quarter":
- If subject addresses the key metric, this is NOT a gap even if reference has more detail.
- Only flag as gap if the subject MISSES an angle that materially changes the picture.

RESPOND with a JSON object:
{
  "gap_detected": true | false,
  "gap_kind": "scope_mismatch" | "unreconciled_divergence" | "unquantified" | null,
  "narrative": "<one paragraph explaining the gap or why no gap exists>",
  "subject_evidence_refs": [<indices of subject facts supporting your conclusion>],
  "reference_evidence_refs": [<indices of reference facts supporting your conclusion>]
}

Rules:
- If subject_coverage handles the topic adequately → gap_detected = false, gap_kind = null.
- Conservative: only flag a gap if material information is truly missing, not just additional detail.
- Never invent facts not shown above.
- Return ONLY valid JSON. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaGapComparison",
  description: "Evaluates per-topic gaps between subject and reference facts",
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
      await db.query(
        `DELETE FROM oa_findings WHERE run_id = $1 AND deal_id = $2`,
        z.any(), [runId, dealId],
        { label: "Reset: delete oa_findings" }
      );
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'gap_comparison'`,
        z.any(), [runId],
        { label: "Reset: delete gap_comparison checkpoints" }
      );
      console.log("[P6] Reset complete for run", runId);
    }

    // ─── Load all topics (skip not_memo_relevant) ───────────────────────
    const topics = await db.query(
      `SELECT topic_id, topic_label, obligation_class, subject_coverage
       FROM oa_topics
       WHERE run_id = $1 AND obligation_class != 'not_memo_relevant'`,
      TopicWithCoverageRow,
      [runId],
      { label: "Load topics for gap comparison" }
    );
    console.log(`[P6] ${topics.length} topics to evaluate (excluding not_memo_relevant)`);

    let gapsEmitted = 0;
    let topicsSkipped = 0;
    let topicsNoGap = 0;
    let llmCalls = 0;
    let yieldedForBudget = false;
    const gapsByKind: Record<string, number> = {};
    const findings: Array<{ topic_id: string; gap_kind: string; narrative: string }> = [];

    // Budget guard
    const invocationStart = Date.now();
    const timeRemaining = () => HARD_KILL_MS - (Date.now() - invocationStart);
    const unitDurations: number[] = [];
    const estimatedUnitDuration = () =>
      unitDurations.length > 0
        ? unitDurations.reduce((a, b) => a + b, 0) / unitDurations.length
        : DEFAULT_UNIT_DURATION_MS;

    for (const topic of topics) {
      // Check checkpoint
      const cp = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'gap_comparison' AND unit_key = $2`,
        z.any(),
        [runId, topic.topic_id],
        { label: `Check checkpoint ${topic.topic_id}` }
      );
      if (cp.length > 0) {
        topicsSkipped++;
        continue;
      }

      // ─── Determine if topic is absent (code-path: not_disclosed) ───────
      // FIX 2: Only required/conditional topics can produce not_disclosed.
      // Optional/emergent topics are reference-only by construction.
      if (topic.subject_coverage === "absent") {
        // Gate: only required or conditional obligation classes qualify for not_disclosed
        if (topic.obligation_class !== "required" && topic.obligation_class !== "conditional") {
          // Optional/emergent topic with no subject facts — skip, no gap to report
          topicsNoGap++;
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
             VALUES ($1, 'gap_comparison', $2, 'complete', $3::jsonb) ON CONFLICT DO NOTHING`,
            z.any(), [runId, topic.topic_id, JSON.stringify({ skipped_reason: "optional_absent" })],
            { label: `Checkpoint (optional absent) ${topic.topic_id}` }
          );
          continue;
        }
        // Determine absence_basis from probe results
        // Check if a probe was run on this topic
        const probeCheckpoint = await db.query(
          `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'absence_probe' AND unit_key = $2`,
          z.any(),
          [runId, topic.topic_id],
          { label: `Check absence probe for ${topic.topic_id}` }
        );

        const absenceBasis = probeCheckpoint.length > 0
          ? "no_subject_facts_and_probe_null"
          : "probe_not_run";

        // Check if there are any reference facts — no reference facts = skip (nothing to compare against)
        const refCount = await db.query(
          `SELECT COUNT(*) as cnt FROM oa_topic_facts
           WHERE run_id = $1 AND topic_id = $2 AND fact_role = 'reference'`,
          z.object({ cnt: z.coerce.number() }),
          [runId, topic.topic_id],
          { label: `Count reference facts for ${topic.topic_id}` }
        );

        if ((refCount[0]?.cnt ?? 0) === 0) {
          // No reference facts either — no gap to report
          topicsNoGap++;
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'gap_comparison', $2, 'complete') ON CONFLICT DO NOTHING`,
            z.any(), [runId, topic.topic_id],
            { label: `Checkpoint (no ref facts) ${topic.topic_id}` }
          );
          continue;
        }

        // Emit not_disclosed finding
        await db.query(
          `INSERT INTO oa_findings (finding_id, run_id, deal_id, topic_id, gap_kind, materiality_tier, materiality_basis, absence_basis, subject_evidence, reference_evidence, narrative)
           VALUES (gen_random_uuid(), $1, $2, $3, 'not_disclosed', 3, 'awaiting_materiality_assessment', $4, '[]'::jsonb, '[]'::jsonb, $5)`,
          z.any(),
          [runId, dealId, topic.topic_id, absenceBasis,
           `Topic "${topic.topic_label}" is not addressed in the IC memo. ${absenceBasis === 'probe_not_run' ? 'Retrieval probe was not run.' : 'Retrieval probe confirmed no text mentions.'}`],
          { label: `Insert not_disclosed: ${topic.topic_id}` }
        );
        gapsEmitted++;
        gapsByKind["not_disclosed"] = (gapsByKind["not_disclosed"] ?? 0) + 1;
        findings.push({ topic_id: topic.topic_id, gap_kind: "not_disclosed", narrative: "Topic absent from IC memo" });

        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'gap_comparison', $2, 'complete') ON CONFLICT DO NOTHING`,
          z.any(), [runId, topic.topic_id],
          { label: `Checkpoint ${topic.topic_id}` }
        );
        continue;
      }

      // ─── BUDGET GUARD ─────────────────────────────────────────────────
      const remaining = timeRemaining();
      const estUnit = estimatedUnitDuration();
      if (remaining < SAFETY_MARGIN_MS + estUnit) {
        console.log(`[P6] YIELDING FOR BUDGET: ${remaining}ms remaining, est unit ${estUnit.toFixed(0)}ms`);
        yieldedForBudget = true;
        break;
      }

      // ─── Topic has some subject facts — load both sets for LLM comparison ───
      const unitStart = Date.now();

      // FIX 1: Separate queries to avoid LIMIT bias when one role dominates
      const FACT_CAP = 150;

      const subjectFacts = await db.query(
        `SELECT tf.fact_id, tf.fact_role, f.predicate, f.value, f.scope_qualifier, f.fact_type, tf.supersession
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
         WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'subject'
         ORDER BY f.predicate
         LIMIT ${FACT_CAP}`,
        TopicFactDetail,
        [runId, dealId, topic.topic_id],
        { label: `Load subject facts for ${topic.topic_id}` }
      );

      const referenceFacts = await db.query(
        `SELECT tf.fact_id, tf.fact_role, f.predicate, f.value, f.scope_qualifier, f.fact_type, tf.supersession
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
         WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'reference'
         ORDER BY f.predicate
         LIMIT ${FACT_CAP}`,
        TopicFactDetail,
        [runId, dealId, topic.topic_id],
        { label: `Load reference facts for ${topic.topic_id}` }
      );

      const subjectTruncated = subjectFacts.length >= FACT_CAP;
      const referenceTruncated = referenceFacts.length >= FACT_CAP;

      if (referenceFacts.length === 0) {
        // No reference facts — can't compare
        topicsNoGap++;
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'gap_comparison', $2, 'complete') ON CONFLICT DO NOTHING`,
          z.any(), [runId, topic.topic_id],
          { label: `Checkpoint (no ref) ${topic.topic_id}` }
        );
        continue;
      }

      // LLM call
      const prompt = buildGapPrompt(
        topic.topic_id,
        topic.topic_label,
        subjectFacts.map((f) => ({ predicate: f.predicate, value: f.value, scope_qualifier: f.scope_qualifier, fact_type: f.fact_type, supersession: f.supersession })),
        referenceFacts.map((f) => ({ predicate: f.predicate, value: f.value, scope_qualifier: f.scope_qualifier, fact_type: f.fact_type })),
      );

      const response = await aiFn(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          },
        },
        { response: z.any() },
        { label: `Gap comparison: ${topic.topic_id}` }
      );
      llmCalls++;

      const textBlock = response?.content?.find((c: any) => c.type === "text");
      const rawText: string = textBlock?.text ?? "{}";
      const cleanedText = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

      let gapResult: {
        gap_detected: boolean;
        gap_kind: string | null;
        narrative: string;
        subject_evidence_refs: number[];
        reference_evidence_refs: number[];
      };

      try {
        gapResult = JSON.parse(cleanedText);
      } catch {
        console.warn(`[P6] Parse failure for ${topic.topic_id}, defaulting to no gap`);
        gapResult = { gap_detected: false, gap_kind: null, narrative: "Parse failure", subject_evidence_refs: [], reference_evidence_refs: [] };
      }

      // Validate: reject stale_supersession if disabled
      if (!ENABLE_STALE_SUPERSESSION && gapResult.gap_kind === "stale_supersession") {
        gapResult.gap_detected = false;
        gapResult.gap_kind = null;
        gapResult.narrative += " [stale_supersession disabled]";
      }

      if (gapResult.gap_detected && gapResult.gap_kind) {
        // Build evidence JSONB — store fact_id arrays (plain UUIDs for G6 resolution)
        const subjectEvidence = subjectFacts.map((f) => f.fact_id);
        const referenceEvidence = referenceFacts.map((f) => f.fact_id);

        await db.query(
          `INSERT INTO oa_findings (finding_id, run_id, deal_id, topic_id, gap_kind, materiality_tier, materiality_basis, subject_evidence, reference_evidence, narrative)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 3, 'awaiting_materiality_assessment', $5::jsonb, $6::jsonb, $7)`,
          z.any(),
          [runId, dealId, topic.topic_id, gapResult.gap_kind,
           JSON.stringify(subjectEvidence), JSON.stringify(referenceEvidence), gapResult.narrative],
          { label: `Insert gap finding: ${topic.topic_id}` }
        );
        gapsEmitted++;
        gapsByKind[gapResult.gap_kind] = (gapsByKind[gapResult.gap_kind] ?? 0) + 1;
        findings.push({ topic_id: topic.topic_id, gap_kind: gapResult.gap_kind, narrative: gapResult.narrative });
      } else {
        topicsNoGap++;
      }

      // Checkpoint — include truncation flags
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
         VALUES ($1, 'gap_comparison', $2, 'complete', $3::jsonb) ON CONFLICT DO NOTHING`,
        z.any(), [runId, topic.topic_id, JSON.stringify({
          subject_count: subjectFacts.length,
          reference_count: referenceFacts.length,
          subject_truncated: subjectTruncated,
          reference_truncated: referenceTruncated,
        })],
        { label: `Checkpoint ${topic.topic_id}` }
      );

      // Record unit duration for budget guard
      unitDurations.push(Date.now() - unitStart);
    }

    // ─── BUDGET YIELD: early return ──────────────────────────────────────
    if (yieldedForBudget) {
      const completedCps = await db.query(
        `SELECT COUNT(*) as cnt FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'gap_comparison' AND status = 'complete'`,
        z.object({ cnt: z.coerce.number() }), [runId], { label: "Count completed gap_comparison checkpoints" }
      );
      const completed = completedCps[0]?.cnt ?? 0;
      return {
        status: "in_progress" as const,
        topics_completed: completed,
        topics_remaining: topics.length - completed,
        report: { message: "Yielded for budget — re-invoke to resume", run_id: runId, llm_calls_this_invocation: llmCalls },
      };
    }

    // ─── G1-G6: Report ─────────────────────────────────────────────────
    // G5: Check if churn has a gap
    const g5 = await db.query(
      `SELECT finding_id, gap_kind FROM oa_findings
       WHERE run_id = $1 AND topic_id = 'revenue-quality.churn'`,
      z.object({ finding_id: z.string(), gap_kind: z.string() }),
      [runId],
      { label: "G5: churn gap check" }
    );

    const report = {
      G1_topics_evaluated: topics.length - topicsSkipped,
      G2_gaps_emitted: gapsEmitted,
      G3_gaps_by_kind: gapsByKind,
      G4_topics_no_gap: topicsNoGap,
      G5_churn_gap: g5.length === 0 ? "NO gap (pass)" : `GAP FOUND: ${g5[0]?.gap_kind}`,
      G6_llm_calls: llmCalls,
      findings_summary: findings.slice(0, 20),
    };

    console.log("[P6] REPORT:", JSON.stringify(report, null, 2));
    return { status: "complete" as const, topics_completed: topics.length - topicsSkipped, topics_remaining: 0, report };
  },
});
