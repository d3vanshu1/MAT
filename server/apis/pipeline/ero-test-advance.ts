/**
 * ERO v2 — Advance test harness (Packet 1.3)
 *
 * Creates a fresh ERO run, then drives the shipped EroRunPipeline
 * orchestrator through 9 successive invocations.  After each
 * invocation, reads the DB row and captures a trace snapshot.
 *
 * Returns the raw trace plus boolean assertions.
 * Does NOT delete the run — leave it for independent inspection
 * via EroDiagState.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import EroRunPipeline from "./ero-run-pipeline.js";
import { ERO_STAGES } from "./ero-stage-contract.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Schemas ─────────────────────────────────────────────────────────
const StateSnapshot = z.object({
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
});

export default api({
  name: "EroTestAdvance",
  description: "Test harness — drives ERO orchestrator through full advance cycle",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runId: z.string(),
    trace: z.array(z.object({
      invocation: z.number(),
      current_stage: z.string(),
      stage_status: z.string(),
      invocation_count: z.number(),
      orchestratorResult: z.object({
        stage: z.string(),
        status: z.string(),
        invocationCount: z.number(),
        message: z.string(),
      }),
    })),
    checks: z.object({
      invocationCountIncrementsBy1: z.object({ pass: z.boolean(), observed: z.array(z.number()) }),
      stagesWalkInOrder: z.object({ pass: z.boolean(), observed: z.array(z.string()) }),
      terminalReached: z.object({ pass: z.boolean(), observedStage: z.string(), observedStatus: z.string() }),
      terminalStable: z.object({ pass: z.boolean(), detail: z.string() }),
      noFailures: z.object({ pass: z.boolean(), failedInvocations: z.array(z.number()) }),
    }),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── 1. Create a fresh run via the real orchestrator ──────────────
    const createResult = await EroRunPipeline.run(ctx, { dealId, runId: null });
    const runId = createResult.runId;

    // ── 2. Drive 9 invocations, capturing trace after each ──────────
    const trace: Array<{
      invocation: number;
      current_stage: string;
      stage_status: string;
      invocation_count: number;
      orchestratorResult: {
        stage: string;
        status: string;
        invocationCount: number;
        message: string;
      };
    }> = [];

    for (let i = 1; i <= 9; i++) {
      // Call the shipped orchestrator
      const result = await EroRunPipeline.run(ctx, { dealId, runId });

      // Read the DB row after the invocation
      const [snapshot] = await db.query(
        `SELECT current_stage, stage_status, invocation_count
         FROM ero_pipeline_state
         WHERE run_id = $1`,
        StateSnapshot,
        [runId],
        { label: `Trace snapshot #${i}` },
      );

      trace.push({
        invocation: i,
        current_stage: snapshot.current_stage,
        stage_status: snapshot.stage_status,
        invocation_count: snapshot.invocation_count,
        orchestratorResult: {
          stage: result.stage,
          status: result.status,
          invocationCount: result.invocationCount,
          message: result.message,
        },
      });
    }

    // ── 3. Compute checks ───────────────────────────────────────────
    // (a) invocation_count increments by exactly 1 per invocation
    const invCounts = trace.map((t) => t.invocation_count);
    const invIncrementsBy1 = invCounts.every(
      (v, i) => v === i + 1,
    );

    // (b) current_stage walks ERO_STAGES in declared order, no skip, no revert
    // Extract the sequence of unique stages in order of first appearance
    const stageSequence: string[] = [];
    for (const t of trace) {
      if (stageSequence.length === 0 || stageSequence[stageSequence.length - 1] !== t.current_stage) {
        stageSequence.push(t.current_stage);
      }
    }
    // The expected walk is all 7 stages in order (stubs advance on every invocation)
    // But the last 2 invocations (8 and 9) should stay on "render" (terminal)
    // So stageSequence should be exactly ERO_STAGES (7 entries)
    const expectedSequence = [...ERO_STAGES];
    const stagesWalkInOrder =
      stageSequence.length === expectedSequence.length &&
      stageSequence.every((s, i) => s === expectedSequence[i]);

    // (c) terminal state reached: render + complete by end
    const lastTrace = trace[trace.length - 1];
    const terminalReached =
      lastTrace.current_stage === "render" &&
      lastTrace.stage_status === "complete";

    // (d) terminal is stable: once we see render/complete, all subsequent stay there
    let terminalStable = true;
    let terminalDetail = "ok";
    let seenTerminal = false;
    for (const t of trace) {
      if (t.current_stage === "render" && t.stage_status === "complete") {
        seenTerminal = true;
      } else if (seenTerminal) {
        terminalStable = false;
        terminalDetail = `Invocation ${t.invocation}: reverted to ${t.current_stage}/${t.stage_status} after terminal`;
        break;
      }
    }
    if (!seenTerminal) {
      terminalStable = false;
      terminalDetail = "Terminal state (render/complete) never observed";
    }

    // (e) no failures
    const failedInvocations = trace
      .filter((t) => t.stage_status === "failed" || t.orchestratorResult.status === "failed")
      .map((t) => t.invocation);
    const noFailures = failedInvocations.length === 0;

    return {
      runId,
      trace,
      checks: {
        invocationCountIncrementsBy1: { pass: invIncrementsBy1, observed: invCounts },
        stagesWalkInOrder: { pass: stagesWalkInOrder, observed: stageSequence },
        terminalReached: {
          pass: terminalReached,
          observedStage: lastTrace.current_stage,
          observedStatus: lastTrace.stage_status,
        },
        terminalStable: { pass: terminalStable, detail: terminalDetail },
        noFailures: { pass: noFailures, failedInvocations },
      },
    };
  },
});
