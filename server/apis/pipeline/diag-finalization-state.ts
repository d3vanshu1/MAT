/**
 * Diagnostic: read finalization stage checkpoints and module_outputs status.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CheckpointRow = z.object({
  checkpoint_key: z.string(),
  status: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const OutputRow = z.object({
  id: z.string(),
  finding_count: z.number().nullable(),
  report_length: z.number().nullable(),
  header_prefix: z.string().nullable(),
});

export default api({
  name: "DiagFinalizationState",
  description: "Reads finalization stage checkpoints and module_outputs for a run",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runId: z.string(),
  }),
  output: z.object({
    checkpoints: z.array(z.object({
      checkpoint_key: z.string(),
      status: z.string().nullable(),
      updated_at: z.string().nullable(),
    })),
    reductionGatePayload: z.string().nullable(),
    moduleOutputs: z.array(OutputRow),
    mergeRootStatus: z.string().nullable(),
    pipelineRunStatus: z.string().nullable(),
    triggeredAt: z.string().nullable(),
  }),
  async run(ctx, { runId }) {
    // 1. Finalization stage checkpoints
    const checkpoints = await ctx.integrations.db.query(
      `SELECT checkpoint_key, COALESCE(status, 'complete') AS status,
              updated_at::text
       FROM pipeline_checkpoints
       WHERE module_run_id = $1
       ORDER BY created_at ASC
       LIMIT 10`,
      z.object({
        checkpoint_key: z.string(),
        status: z.string().nullable(),
        updated_at: z.string().nullable(),
      }),
      [runId],
      { label: "Diag: finalization checkpoints" }
    );

    // 1b. Reduction gate payload specifically
    const PayloadRow = z.object({ payload_text: z.string().nullable() });
    const payloadRows = await ctx.integrations.db.query(
      `SELECT LEFT(payload::text, 1500) AS payload_text
       FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'finding_reduction_gate'
       LIMIT 1`,
      PayloadRow,
      [runId],
      { label: "Diag: reduction gate payload" }
    );
    const reductionGatePayload = payloadRows[0]?.payload_text ?? null;

    // 2. Module outputs
    const moduleOutputs = await ctx.integrations.db.query(
      `SELECT id::text,
              COALESCE(jsonb_array_length(findings), 0)::int AS finding_count,
              COALESCE(length(full_report_markdown), 0)::int AS report_length,
              LEFT(executive_header, 60) AS header_prefix
       FROM module_outputs
       WHERE module_run_id = $1
       LIMIT 5`,
      OutputRow,
      [runId],
      { label: "Diag: module_outputs" }
    );

    // 3. Root merge checkpoint (tree_level=0 or highest complete node)
    const RootRow = z.object({ status: z.string().nullable() });
    const rootRows = await ctx.integrations.db.query(
      `SELECT status FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index = 0
       ORDER BY tree_level DESC
       LIMIT 1`,
      RootRow,
      [runId],
      { label: "Diag: root merge checkpoint" }
    );

    // 4. Pipeline run status
    const RunRow = z.object({ status: z.string().nullable(), triggered_at: z.string().nullable() });
    const runRows = await ctx.integrations.db.query(
      `SELECT status, triggered_at::text
       FROM module_runs
       WHERE id = $1
       LIMIT 1`,
      RunRow,
      [runId],
      { label: "Diag: module_runs status" }
    );

    return {
      checkpoints,
      reductionGatePayload,
      moduleOutputs,
      mergeRootStatus: rootRows[0]?.status ?? null,
      pipelineRunStatus: runRows[0]?.status ?? null,
      triggeredAt: runRows[0]?.triggered_at ?? null,
    };
  },
});
