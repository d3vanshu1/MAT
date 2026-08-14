/**
 * Diagnostic: P4 Topic Assignment checkpoint status report.
 * T8 — count by status, full list of failed rows.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagP4Checkpoints",
  description: "T8 diagnostic: checkpoint status counts and failed batch details for P4 topic_assignment",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string(),
  }),
  output: z.object({
    status_counts: z.array(z.object({ status: z.string(), cnt: z.coerce.number() })),
    failed_rows: z.array(z.object({
      unit_key: z.string(),
      status: z.string(),
    })),
    total_checkpoints: z.coerce.number(),
    topic_facts_count: z.coerce.number(),
    payload_samples: z.array(z.object({
      unit_key: z.string(),
      payload_json: z.any(),
    })),
  }),
  async run(ctx, { runId }) {
    const db = ctx.integrations.db;

    // T8a: count by status
    const status_counts = await db.query(
      `SELECT status, COUNT(*) as cnt
       FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'topic_assignment'
       GROUP BY status
       ORDER BY cnt DESC`,
      z.object({ status: z.string(), cnt: z.coerce.number() }),
      [runId],
      { label: "T8a: status counts" }
    );

    // T8b: every failed row
    const failed_rows = await db.query(
      `SELECT unit_key, status
       FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'topic_assignment' AND status = 'failed'
       ORDER BY unit_key`,
      z.object({ unit_key: z.string(), status: z.string() }),
      [runId],
      { label: "T8b: failed rows" }
    );

    // total
    const totalRes = await db.query(
      `SELECT COUNT(*) as cnt FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'topic_assignment'`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Total checkpoints" }
    );

    // topic_facts row count
    const tfCountRes = await db.query(
      `SELECT COUNT(*) as cnt FROM oa_topic_facts WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Total topic_facts rows" }
    );

    // topic_facts per checkpoint (verify each batch wrote rows)
    const factsPerBatch = await db.query(
      `SELECT c.unit_key, COUNT(tf.fact_id) as fact_count
       FROM oa_stage_checkpoints c
       LEFT JOIN oa_topic_facts tf ON tf.run_id = c.run_id
         AND tf.fact_id IN (SELECT fact_id FROM oa_topic_facts WHERE run_id = $1)
       WHERE c.run_id = $1 AND c.stage = 'topic_assignment' AND c.status = 'complete'
       GROUP BY c.unit_key
       ORDER BY c.unit_key
       LIMIT 10`,
      z.object({ unit_key: z.string(), fact_count: z.coerce.number() }),
      [runId],
      { label: "Facts per batch (verify)" }
    );

    // payload_json sample from first complete checkpoint
    const payloadSample = await db.query(
      `SELECT unit_key, payload_json
       FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'topic_assignment' AND status = 'complete' AND payload_json IS NOT NULL
       ORDER BY unit_key
       LIMIT 3`,
      z.object({ unit_key: z.string(), payload_json: z.any() }),
      [runId],
      { label: "Payload sample" }
    );

    return {
      status_counts,
      failed_rows,
      total_checkpoints: totalRes[0]?.cnt ?? 0,
      topic_facts_count: tfCountRes[0]?.cnt ?? 0,
      payload_samples: payloadSample,
    };
  },
});
