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
 *
 * PERFORMANCE: Uses bulk queries/updates instead of per-fact loops to avoid
 * orchestrator timeout on large topic sets (240+ topics).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const TopicRow = z.object({
  topic_id: z.string(),
});

const SubjectFactRow = z.object({
  topic_id: z.string(),
  fact_id: z.string(),
  memo_order: z.coerce.number().nullable(),
});

const CheckpointRow = z.object({
  unit_key: z.string(),
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
      await db.query(
        `UPDATE oa_topic_facts SET supersession = NULL WHERE run_id = $1::uuid`,
        z.any(), [runId],
        { label: "Reset: clear supersession" }
      );
      await db.query(
        `UPDATE oa_topics SET subject_coverage = NULL, coverage_basis = NULL WHERE run_id = $1::uuid`,
        z.any(), [runId],
        { label: "Reset: clear coverage" }
      );
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'index_assembly'`,
        z.any(), [runId],
        { label: "Reset: delete checkpoints" }
      );
      console.log("[P5] Reset complete for run", runId);
    }

    // ─── B1: Verify fact_role consistency (bulk fix) ─────────────────────
    const inconsistentCount = await db.query(
      `WITH mismatches AS (
         SELECT tf.fact_id, tf.fact_role AS topic_fact_role, f.document_role
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2::uuid
         WHERE tf.run_id = $1::uuid AND tf.fact_role != f.document_role
       )
       SELECT COUNT(*)::int as cnt FROM mismatches`,
      z.object({ cnt: z.coerce.number() }),
      [runId, dealId],
      { label: "B1: count fact_role inconsistencies" }
    );
    const mismatchCount = inconsistentCount[0]?.cnt ?? 0;
    if (mismatchCount > 0) {
      console.warn(`[P5] B1: ${mismatchCount} fact_role inconsistencies — bulk fixing`);
      await db.query(
        `UPDATE oa_topic_facts tf
         SET fact_role = f.document_role
         FROM oa_facts f
         WHERE tf.run_id = $1::uuid AND f.fact_id = tf.fact_id AND f.deal_id = $2::uuid AND tf.fact_role != f.document_role`,
        z.any(),
        [runId, dealId],
        { label: "B1: bulk fix fact_role" }
      );
    }

    // ─── Load all topics ────────────────────────────────────────────────
    const allTopics = await db.query(
      `SELECT topic_id FROM oa_topics WHERE run_id = $1::uuid`,
      TopicRow,
      [runId],
      { label: "Load all topics" }
    );
    console.log(`[P5] Total topics: ${allTopics.length}`);

    // ─── Load existing checkpoints (skip completed) ─────────────────────
    const existingCheckpoints = await db.query(
      `SELECT unit_key FROM oa_stage_checkpoints WHERE run_id = $1::uuid AND stage = 'index_assembly'`,
      CheckpointRow,
      [runId],
      { label: "Load existing checkpoints" }
    );
    const completedSet = new Set(existingCheckpoints.map((r) => r.unit_key));
    const pendingTopics = allTopics.filter((t) => !completedSet.has(t.topic_id));
    console.log(`[P5] Already checkpointed: ${completedSet.size}, pending: ${pendingTopics.length}`);

    if (pendingTopics.length === 0) {
      console.log("[P5] All topics already checkpointed — skipping to report");
    } else {
      // ─── Bulk load ALL subject facts + memo_order for pending topics ───
      // Process in batches to avoid query-param limits
      const BATCH_SIZE = 50;
      let absentCount = 0;
      let partialCount = 0;
      let presentCount = 0;
      let supersededFacts = 0;
      let currentFacts = 0;

      for (let batchStart = 0; batchStart < pendingTopics.length; batchStart += BATCH_SIZE) {
        const batch = pendingTopics.slice(batchStart, batchStart + BATCH_SIZE);
        const topicIds = batch.map((t) => t.topic_id);
        console.log(`[P5] Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1} (${topicIds.length} topics)`);

        // Load all subject facts for this batch of topics in ONE query
        const subjectFacts = await db.query(
          `SELECT tf.topic_id, tf.fact_id, f.memo_order
           FROM oa_topic_facts tf
           JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2::uuid
           WHERE tf.run_id = $1::uuid AND tf.fact_role = 'subject' AND tf.topic_id = ANY($3::text[])`,
          SubjectFactRow,
          [runId, dealId, topicIds],
          { label: `Bulk load subject facts (batch ${Math.floor(batchStart / BATCH_SIZE) + 1})` }
        );

        // Group by topic_id
        const factsByTopic = new Map<string, Array<{ fact_id: string; memo_order: number | null }>>();
        for (const sf of subjectFacts) {
          const list = factsByTopic.get(sf.topic_id) ?? [];
          list.push({ fact_id: sf.fact_id, memo_order: sf.memo_order });
          factsByTopic.set(sf.topic_id, list);
        }

        // Compute supersession and coverage in memory
        const currentFactIds: string[] = [];
        const supersededFactIds: string[] = [];
        const coverageUpdates: Array<{ topic_id: string; coverage: string; basis: string }> = [];

        for (const { topic_id } of batch) {
          const facts = factsByTopic.get(topic_id) ?? [];

          if (facts.length === 0) {
            coverageUpdates.push({
              topic_id,
              coverage: "absent",
              basis: "0 subject facts on this topic",
            });
            absentCount++;
            continue;
          }

          const memoOrders = facts
            .map((f) => f.memo_order)
            .filter((m): m is number => m !== null);

          if (memoOrders.length === 0) {
            // All null memo_order — treat as current
            for (const f of facts) {
              currentFactIds.push(f.fact_id);
              currentFacts++;
            }
            coverageUpdates.push({
              topic_id,
              coverage: "present",
              basis: `${facts.length} subject facts, all null memo_order — treated as current`,
            });
            presentCount++;
          } else {
            const highestMemoOrder = Math.max(...memoOrders);
            let topicCurrentCount = 0;

            for (const f of facts) {
              if (f.memo_order === null) {
                // NULL memo_order with some non-null present → superseded (conservative)
                supersededFactIds.push(f.fact_id);
                supersededFacts++;
              } else if (f.memo_order === highestMemoOrder) {
                currentFactIds.push(f.fact_id);
                currentFacts++;
                topicCurrentCount++;
              } else {
                supersededFactIds.push(f.fact_id);
                supersededFacts++;
              }
            }

            if (topicCurrentCount > 0) {
              coverageUpdates.push({
                topic_id,
                coverage: "present",
                basis: `${facts.length} subject facts, ${topicCurrentCount} current, highest memo_order = ${highestMemoOrder}`,
              });
              presentCount++;
            } else {
              coverageUpdates.push({
                topic_id,
                coverage: "partial",
                basis: `${facts.length} subject facts, 0 current (all superseded), highest memo_order = ${highestMemoOrder}`,
              });
              partialCount++;
            }
          }
        }

        // ─── Bulk write supersession markers ────────────────────────────
        if (currentFactIds.length > 0) {
          await db.query(
            `UPDATE oa_topic_facts SET supersession = 'current'
             WHERE run_id = $1::uuid AND fact_id = ANY($2::uuid[])`,
            z.any(),
            [runId, currentFactIds],
            { label: `Bulk mark current (${currentFactIds.length} facts)` }
          );
        }
        if (supersededFactIds.length > 0) {
          await db.query(
            `UPDATE oa_topic_facts SET supersession = 'superseded'
             WHERE run_id = $1::uuid AND fact_id = ANY($2::uuid[])`,
            z.any(),
            [runId, supersededFactIds],
            { label: `Bulk mark superseded (${supersededFactIds.length} facts)` }
          );
        }

        // ─── Bulk write coverage ────────────────────────────────────────
        if (coverageUpdates.length > 0) {
          // Build VALUES clause (topic_id is text, not uuid)
          const values = coverageUpdates.map((u, i) => {
            const offset = i * 3 + 2; // $1 is runId
            return `($${offset}, $${offset + 1}, $${offset + 2})`;
          }).join(", ");
          const params: (string | null)[] = [runId];
          for (const u of coverageUpdates) {
            params.push(u.topic_id, u.coverage, u.basis);
          }
          await db.query(
            `UPDATE oa_topics SET subject_coverage = v.coverage, coverage_basis = v.basis
             FROM (VALUES ${values}) AS v(topic_id, coverage, basis)
             WHERE oa_topics.run_id = $1::uuid AND oa_topics.topic_id = v.topic_id`,
            z.any(),
            params,
            { label: `Bulk set coverage (${coverageUpdates.length} topics)` }
          );
        }

        // ─── Bulk checkpoint ────────────────────────────────────────────
        if (topicIds.length > 0) {
          const cpValues = topicIds.map((_, i) => `($1::uuid, 'index_assembly', $${i + 2}, 'complete')`).join(", ");
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ${cpValues} ON CONFLICT DO NOTHING`,
            z.any(),
            [runId, ...topicIds],
            { label: `Bulk checkpoint (${topicIds.length} topics)` }
          );
        }

        console.log(`[P5] Batch done: ${currentFactIds.length} current, ${supersededFactIds.length} superseded`);
      }

      console.log(`[P5] Processing complete. Absent: ${absentCount}, Partial: ${partialCount}, Present: ${presentCount}`);
      console.log(`[P5] Supersession: ${currentFacts} current, ${supersededFacts} superseded`);
    }

    // ─── I1-I6: Report ────────────────────────────────────────────────────
    // I2: Coverage distribution
    const i2 = await db.query(
      `SELECT subject_coverage, COUNT(*) as cnt
       FROM oa_topics WHERE run_id = $1::uuid
       GROUP BY subject_coverage`,
      z.object({ subject_coverage: z.string().nullable(), cnt: z.coerce.number() }),
      [runId],
      { label: "I2: coverage distribution" }
    );

    // I3: Total superseded / current facts
    const i3 = await db.query(
      `SELECT supersession, COUNT(*) as cnt
       FROM oa_topic_facts WHERE run_id = $1::uuid AND supersession IS NOT NULL
       GROUP BY supersession`,
      z.object({ supersession: z.string(), cnt: z.coerce.number() }),
      [runId],
      { label: "I3: supersession distribution" }
    );

    // I4: Topics with highest fact counts
    const i4 = await db.query(
      `SELECT topic_id, COUNT(*) as fact_count
       FROM oa_topic_facts WHERE run_id = $1::uuid
       GROUP BY topic_id ORDER BY fact_count DESC LIMIT 10`,
      z.object({ topic_id: z.string(), fact_count: z.coerce.number() }),
      [runId],
      { label: "I4: top 10 topics by fact count" }
    );

    // I5: Fact_role consistency (re-check after fix)
    const i5 = await db.query(
      `SELECT COUNT(*) as inconsistent_count
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2::uuid
       WHERE tf.run_id = $1::uuid AND tf.fact_role != f.document_role`,
      z.object({ inconsistent_count: z.coerce.number() }),
      [runId, dealId],
      { label: "I5: remaining inconsistencies" }
    );

    // I6: Specific check — revenue-quality.churn subject_coverage
    const i6 = await db.query(
      `SELECT subject_coverage, coverage_basis FROM oa_topics WHERE run_id = $1::uuid AND topic_id = 'revenue-quality.churn'`,
      z.object({ subject_coverage: z.string().nullable(), coverage_basis: z.string().nullable() }),
      [runId],
      { label: "I6: churn coverage" }
    );

    const report = {
      I1_topics_processed: allTopics.length,
      I2_coverage_distribution: i2,
      I3_supersession: i3,
      I4_top10_topics: i4,
      I5_remaining_inconsistencies: i5[0]?.inconsistent_count ?? 0,
      I6_churn_coverage: i6[0] ?? "NOT_FOUND",
      B1_fact_role_fixes: mismatchCount,
    };

    console.log("[P5] REPORT:", JSON.stringify(report, null, 2));
    return { report };
  },
});
