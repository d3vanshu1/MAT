/**
 * IC Questions v2 path (P6).
 *
 * `ic_challenge_mode` does not use the merge tree. It runs one LLM call over the
 * whole IC memo corpus, verifies every anchor against the extracted text, and
 * publishes through the shared finalization runner on `callerPath =
 * "ic_questions_path"`.
 *
 * This module exists so the branch in `pipeline-core.ts` stays a handful of
 * lines. Everything that is specific to the path — scope resolution, error →
 * `module_runs` translation, artifact assembly, and the
 * `PostMergeFinalizationResult` → `PipelineResult` mapping — lives here.
 *
 * Three failure modes are TERMINAL and are recorded on the run rather than
 * retried or degraded:
 *
 *   - `no_ic_memos`            — the deal has no `ic_memo` document (P0).
 *   - the synthesis error phase — corpus over ceiling, or unparseable output (P2).
 *   - `no_anchored_questions`   — synthesis verified nothing (P5.2b / render).
 *
 * None of them may fall through to the canonical renderer: it would emit a
 * tier-based report over projected findings, which is a different document than
 * the one this module promises.
 */

import type { PipelineContext } from "./pipeline-config.js";
import type { PipelineResult } from "./pipeline-core.js";
import type { MergedFinding } from "../modules/build-merged-text.js";
import {
  runPostMergeFinalizationStages,
  type PostMergeFinalizationInput,
} from "./post-merge-finalization.js";
import { runAbsenceVerificationPhase } from "./absence-verification-phase.js";
import { resolveICQuestionsScope } from "./ic-questions-scope.js";
import {
  projectICQuestionsToCanonicalFindings,
  type ICQuestionsArtifact,
} from "./ic-questions-contract.js";
import { ICQuestionsEmptyError } from "./ic-questions-render.js";
import {
  runICQuestionsSynthesis,
  ICQuestionsSynthesisError,
} from "./ic-questions-synthesis.js";

const LOG_PREFIX = "[ic-questions-path]";

/** Transport ceiling for `result.mergedText` — mirrors the other paths. */
const MAX_MERGED_TEXT_CHARS = 150_000;

/** Empty progress block. This path builds no tree, so every counter is zero. */
const NO_PROGRESS = {
  analysisTotal: 0,
  analysisCompleted: 0,
  mergeRound: 0,
  mergeTotal: 0,
} as const;

export interface ICQuestionsPathInput {
  ctx: PipelineContext;
  runId: string;
  dealId: string;
  moduleId: string;
  useOpus: boolean | null | undefined;
  startTime: number;
  timeRemaining: () => number;
  fileTagMap: Map<string, string>;
  subjectDocumentIds: string[];

  /**
   * Injected from `pipeline-core.ts`. Both are module-private there, so they
   * cannot be imported — and injecting them keeps this module free of any
   * import edge back into `pipeline-core.ts`.
   */
  markRunFailed: (
    db: PipelineContext["integrations"]["db"],
    runId: string,
    errorMessage: string,
    errorPhase: string,
    dealId?: string,
    moduleId?: string,
  ) => Promise<void>;
  runPostMergePipeline: PostMergeFinalizationInput["runPostMergePipeline"];
}

/** Record a terminal failure on the run and shape the pipeline's failed result. */
async function fail(
  input: ICQuestionsPathInput,
  errorMessage: string,
  errorPhase: string,
): Promise<PipelineResult> {
  console.error(`${LOG_PREFIX} TERMINAL (${errorPhase}): ${errorMessage}`);
  await input.markRunFailed(
    input.ctx.integrations.db,
    input.runId,
    errorMessage,
    errorPhase,
    input.dealId,
    input.moduleId,
  );
  return {
    status: "failed",
    runId: input.runId,
    phase: errorPhase,
    progress: { ...NO_PROGRESS },
    result: null,
    failedChunks: 0,
    truncatedChunks: 0,
    truncatedMerges: 0,
    firstError: errorMessage,
  };
}

/**
 * Run the IC Questions v2 path end to end.
 *
 * Returns a terminal `failed` result for the three conditions above, a
 * `completed` result once finalization publishes an artifact, or `in_progress`
 * so the scheduler resumes a finalization stage that ran out of budget.
 */
export async function runICQuestionsPath(
  input: ICQuestionsPathInput,
): Promise<PipelineResult> {
  const {
    ctx,
    runId,
    dealId,
    moduleId,
    useOpus,
    startTime,
    timeRemaining,
    fileTagMap,
    subjectDocumentIds,
    runPostMergePipeline,
  } = input;
  const pathStart = Date.now();

  console.log(
    `${LOG_PREFIX} ENABLED for ${moduleId} — bypassing routing, analysis, tree ` +
      `merge, and root promotion. No merge nodes will be written. ` +
      `Budget remaining: ${timeRemaining()}ms`,
  );

  // ── P0: resolve the IC memo corpus ────────────────────────────────────────
  const scopeResult = await resolveICQuestionsScope(ctx.integrations.db, dealId);
  if (!scopeResult.ok) {
    return fail(input, scopeResult.errorMessage, scopeResult.errorPhase);
  }
  const { scope } = scopeResult;

  console.log(
    `${LOG_PREFIX} scope: ${scope.memoDocs.length} memo(s), ` +
      `${scope.extractions.length} usable chunk(s), ` +
      `orderingFallbackDocs=[${scope.orderingFallbackDocs.join(", ")}]`,
  );

  // ── P2: single-call synthesis (checkpoint-resumable) ──────────────────────
  let synthesis;
  try {
    synthesis = await runICQuestionsSynthesis(
      ctx,
      runId,
      scope,
      useOpus,
      startTime,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const phase =
      err instanceof ICQuestionsSynthesisError
        ? err.errorPhase
        : "ic_questions_synthesis_error";
    return fail(input, message, phase);
  }

  const artifact: ICQuestionsArtifact = {
    questions: synthesis.questions,
    executiveHeader: synthesis.executiveHeader,
    memoCoverage: scope.memoCoverage,
    rejectedCount: synthesis.rejectedCount,
    anchorDropCount: synthesis.anchorDropCount,
    rankDerivedCount: synthesis.rankDerivedCount,
    orderingFallbackDocs: scope.orderingFallbackDocs,
  };

  // R1–R4 observability. Never load-bearing — the run's outcome does not read it.
  console.log(
    `${LOG_PREFIX} synthesis diagnostics: ${JSON.stringify(synthesis.diagnostics)}`,
  );

  // ── Finalization: publishes via the ic_questions_path renderer ────────────
  let finalization;
  try {
    finalization = await runPostMergeFinalizationStages({
      ctx,
      runId,
      dealId,
      moduleId,
      // No merge tree exists on this path. F06's publication gate is bypassed
      // for `ic_questions_path`, so these coordinates are never dereferenced.
      naturalRootTreeLevel: 0,
      naturalRootNodeIndex: 0,
      canonicalRootFindings: projectICQuestionsToCanonicalFindings(
        artifact.questions,
      ) as unknown as MergedFinding[],
      executiveHeader: artifact.executiveHeader,
      housekeepingFindings: [],
      housekeepingValidated: true,
      startTime,
      timeRemaining,
      callerPath: "ic_questions_path",
      fileTagMap,
      subjectDocumentIds,
      useOpus,
      sourceManifestHash: null,
      icQuestionsArtifact: artifact,
      runPostMergePipeline,
      runAbsenceVerificationPhase,
    });
  } catch (err: unknown) {
    // The render throws `ICQuestionsEmptyError` when synthesis verified nothing.
    // Terminal by design: see the class doc in ic-questions-render.ts.
    if (err instanceof ICQuestionsEmptyError) {
      return fail(input, err.message, err.errorPhase);
    }
    throw err;
  }

  console.log(
    `${LOG_PREFIX} finalization returned status=${finalization.status}, ` +
      `stage=${finalization.currentStage ?? "none"}, ` +
      `completed=[${finalization.completedStages.join(",")}], ` +
      `elapsed=${Date.now() - pathStart}ms`,
  );

  if (finalization.status === "complete" && finalization.artifact) {
    const markdown = finalization.artifact.report?.markdown ?? "";
    const mergedText =
      markdown.length > MAX_MERGED_TEXT_CHARS
        ? markdown.slice(0, MAX_MERGED_TEXT_CHARS) +
          "\n\n[…truncated for transport]"
        : markdown;
    return {
      status: "completed",
      runId,
      phase: "done",
      progress: { ...NO_PROGRESS },
      result: {
        executiveHeader:
          finalization.artifact.report?.executive_header ??
          artifact.executiveHeader,
        findings: (finalization.artifact.canonical_findings ??
          []) as MergedFinding[],
        mergedText,
        fullReport: markdown,
      },
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: null,
    };
  }

  // Blocked or out of budget — yield so the scheduler resumes the stage.
  return {
    status: "in_progress",
    runId,
    phase: `ic_questions_${finalization.currentStage ?? "init"}`,
    progress: { ...NO_PROGRESS },
    result: null,
    failedChunks: 0,
    truncatedChunks: 0,
    truncatedMerges: 0,
    firstError:
      finalization.blockingReasons.length > 0
        ? finalization.blockingReasons.join("; ")
        : null,
  };
}
