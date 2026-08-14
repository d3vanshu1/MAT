/**
 * P5 — OA Index Assembly (Stage S3)
 *
 * After topic assignment, this stage:
 * 1. Verifies fact_role consistency (oa_topic_facts.fact_role matches oa_facts.document_role)
 * 2. Applies supersession logic within each topic's subject facts based on memo_order
 * 3. Derives subject_coverage per topic: absent / partial / present
 * 4. Writes coverage_basis explanatory string
 * 5. Checkpoints per topic
 *
 * Supersession rules:
 * - Within each topic, for subject facts (from IC memos):
 *   - Find the highest memo_order present on facts assigned to that topic
 *   - Facts with that memo_order → 'current'
 *   - Facts with lower memo_order → 'superseded'
 *   - Reference facts → supersession stays NULL (never written)
 *
 * Coverage classification:
 * - 'absent': zero subject facts on the topic
 * - 'partial': has subject facts but none are 'current' (all superseded)
 * - 'present': at least one 'current' subject fact
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const TopicFactRow = z.object({
  topic_id: z.string(),
  fact_id: z.string(),
  fact_role: z.string(),
});

const TopicRow = z.object({
  topic_id: z.string(),
});

const MemoOrderRow = z.object({
  fact_id: z.string(),
  memo_order: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaIndexAssembly",
  description: "Applies supersession and derives coverage per topic",
  integrations: {
    db: postgres(DB_ID),
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

    // ─── RESET ──────────────────────────────────────────────────────────
    if (reset) {
      // Clear supersession markers
      await db.query(
        `UPDATE oa_topic_facts SET supersession = NULL WHERE run_id = $1`,
        z.any(), [runId],
        { label: "Reset: clear supersession" }
      );
      // Clear coverage on oa_topics
      await db.query(
        `UPDATE oa_topics SET subject_coverage = NULL, coverage_basis = NULL WHERE run_id = $1`,
        z.any(), [runId],
        { label: "Reset: clear coverage" }
      );
      // Clear checkpoints
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'index_assembly'`,
        z.any(), [runId],
        { label: "Reset: delete checkpoints" }
      );
      console.log("[P5] Reset complete for run", runId);
    }

    // ─── B1: Verify fact_role consistency ─────────────────────────────────
    const inconsistent = await db.query(
      `SELECT tf.fact_id, tf.fact_role AS topic_fact_role, f.document_role
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
       WHERE tf.run_id = $1 AND tf.fact_role != f.document_role
       LIMIT 20`,
      z.object({
        fact_id: z.string(),
        topic_fact_role: z.string(),
        document_role: z.string(),
      }),
      [runId, dealId],
      { label: "B1: fact_role consistency check" }
    );
    if (inconsistent.length > 0) {
      console.warn(`[P5] B1: ${inconsistent.length} fact_role inconsistencies found — auto-fixing`);
      // Auto-fix: update oa_topic_facts.fact_role to match oa_facts.document_role
      await db.query(
        `UPDATE oa_topic_facts tf
         SET fact_role = f.document_role
         FROM oa_facts f
         WHERE tf.run_id = $1 AND f.fact_id = tf.fact_id AND f.deal_id = $2 AND tf.fact_role != f.document_role`,
        z.any(),
        [runId, dealId],
        { label: "B1: fix fact_role inconsistencies" }
      );
    }

    // ─── Load all topics for this run ──────────────────────────────────────
    const topics = await db.query(
      `SELECT topic_id FROM oa_topics WHERE run_id = $1`,
      TopicRow,
      [runId],
      { label: "Load all topics" }
    );
    console.log(`[P5] Processing ${topics.length} topics`);

    let topicsProcessed = 0;
    let absentCount = 0;
    let partialCount = 0;
    let presentCount = 0;
    let supersededFacts = 0;
    let currentFacts = 0;

    // ─── B2+B3: Process each topic ─────────────────────────────────────────
    for (const { topic_id } of topics) {
      // Check checkpoint
      const cp = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'index_assembly' AND unit_key = $2`,
        z.any(),
        [runId, topic_id],
        { label: `Check checkpoint ${topic_id}` }
      );
      if (cp.length > 0) {
        topicsProcessed++;
        continue;
      }

      // Load subject facts for this topic with their memo_order
      const subjectFacts = await db.query(
        `SELECT tf.fact_id, f.memo_order
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
         WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'subject'`,
        MemoOrderRow,
        [runId, dealId, topic_id],
        { label: `Load subject facts for ${topic_id}` }
      );

      let coverage: "absent" | "partial" | "present";
      let coverageBasis: string;

      if (subjectFacts.length === 0) {
        // No subject facts → absent
        coverage = "absent";
        coverageBasis = "0 subject facts on this topic";
      } else {
        // Find highest memo_order among subject facts on this topic
        const memoOrders = subjectFacts
          .map((f) => f.memo_order)
          .filter((m): m is number => m !== null);

        if (memoOrders.length === 0) {
          // All subject facts have NULL memo_order — treat as present (no supersession possible)
          coverage = "present";
          coverageBasis = `${subjectFacts.length} subject facts, all null memo_order — treated as current`;

          // Mark all as current
          for (const sf of subjectFacts) {
            await db.query(
              `UPDATE oa_topic_facts SET supersession = 'current'
               WHERE run_id = $1 AND topic_id = $2 AND fact_id = $3`,
              z.any(),
              [runId, topic_id, sf.fact_id],
              { label: `Mark current: ${sf.fact_id}` }
            );
            currentFacts++;
          }
        } else {
          const highestMemoOrder = Math.max(...memoOrders);

          // Mark supersession
          let currentCount = 0;
          let supersededCount = 0;
          for (const sf of subjectFacts) {
            const mo = sf.memo_order;
            if (mo === null) {
              // NULL memo_order on a subject fact — treat as superseded (conservative)
              await db.query(
                `UPDATE oa_topic_facts SET supersession = 'superseded'
                 WHERE run_id = $1 AND topic_id = $2 AND fact_id = $3`,
                z.any(),
                [runId, topic_id, sf.fact_id],
                { label: `Mark superseded (null mo): ${sf.fact_id}` }
              );
              supersededCount++;
              supersededFacts++;
            } else if (mo === highestMemoOrder) {
              await db.query(
                `UPDATE oa_topic_facts SET supersession = 'current'
                 WHERE run_id = $1 AND topic_id = $2 AND fact_id = $3`,
                z.any(),
                [runId, topic_id, sf.fact_id],
                { label: `Mark current: ${sf.fact_id}` }
              );
              currentCount++;
              currentFacts++;
            } else {
              await db.query(
                `UPDATE oa_topic_facts SET supersession = 'superseded'
                 WHERE run_id = $1 AND topic_id = $2 AND fact_id = $3`,
                z.any(),
                [runId, topic_id, sf.fact_id],
                { label: `Mark superseded: ${sf.fact_id}` }
              );
              supersededCount++;
              supersededFacts++;
            }
          }

          if (currentCount > 0) {
            coverage = "present";
            coverageBasis = `${subjectFacts.length} subject facts, ${currentCount} current, highest memo_order on topic = ${highestMemoOrder}`;
          } else {
            coverage = "partial";
            coverageBasis = `${subjectFacts.length} subject facts, 0 current (all superseded), highest memo_order on topic = ${highestMemoOrder}`;
          }
        }
      }

      // Write coverage to oa_topics
      await db.query(
        `UPDATE oa_topics SET subject_coverage = $3, coverage_basis = $4
         WHERE run_id = $1 AND topic_id = $2`,
        z.any(),
        [runId, topic_id, coverage, coverageBasis],
        { label: `Set coverage: ${topic_id} = ${coverage}` }
      );

      // Checkpoint
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'index_assembly', $2, 'complete') ON CONFLICT DO NOTHING`,
        z.any(), [runId, topic_id],
        { label: `Checkpoint ${topic_id}` }
      );

      topicsProcessed++;
      if (coverage === "absent") absentCount++;
      else if (coverage === "partial") partialCount++;
      else presentCount++;
    }

    // ─── I1-I6: Report ────────────────────────────────────────────────────
    const i1 = topicsProcessed;

    // I2: Coverage distribution
    const i2 = await db.query(
      `SELECT subject_coverage, COUNT(*) as cnt
       FROM oa_topics WHERE run_id = $1
       GROUP BY subject_coverage`,
      z.object({ subject_coverage: z.string().nullable(), cnt: z.coerce.number() }),
      [runId],
      { label: "I2: coverage distribution" }
    );

    // I3: Total superseded / current facts
    const i3 = await db.query(
      `SELECT supersession, COUNT(*) as cnt
       FROM oa_topic_facts WHERE run_id = $1 AND supersession IS NOT NULL
       GROUP BY supersession`,
      z.object({ supersession: z.string(), cnt: z.coerce.number() }),
      [runId],
      { label: "I3: supersession distribution" }
    );

    // I4: Topics with highest fact counts
    const i4 = await db.query(
      `SELECT topic_id, COUNT(*) as fact_count
       FROM oa_topic_facts WHERE run_id = $1
       GROUP BY topic_id ORDER BY fact_count DESC LIMIT 5`,
      z.object({ topic_id: z.string(), fact_count: z.coerce.number() }),
      [runId],
      { label: "I4: top 5 topics by fact count" }
    );

    // I5: Fact_role consistency (re-check after fix)
    const i5 = await db.query(
      `SELECT COUNT(*) as inconsistent_count
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
       WHERE tf.run_id = $1 AND tf.fact_role != f.document_role`,
      z.object({ inconsistent_count: z.coerce.number() }),
      [runId, dealId],
      { label: "I5: remaining inconsistencies" }
    );

    // I6: Specific check — revenue-quality.churn subject_coverage
    const i6 = await db.query(
      `SELECT subject_coverage FROM oa_topics WHERE run_id = $1 AND topic_id = 'revenue-quality.churn'`,
      z.object({ subject_coverage: z.string().nullable() }),
      [runId],
      { label: "I6: churn coverage" }
    );

    const report = {
      I1_topics_processed: i1,
      I2_coverage_distribution: i2,
      I3_supersession: i3,
      I4_top5_topics: i4,
      I5_remaining_inconsistencies: i5[0]?.inconsistent_count ?? 0,
      I6_churn_coverage: i6[0]?.subject_coverage ?? "NOT_FOUND",
      summary: {
        absent: absentCount,
        partial: partialCount,
        present: presentCount,
        superseded_facts: supersededFacts,
        current_facts: currentFacts,
      },
    };

    console.log("[P5] REPORT:", JSON.stringify(report, null, 2));
    return { report };
  },
});
