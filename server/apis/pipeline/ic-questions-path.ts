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

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import type { PipelineResult } from "./pipeline-core.js";
import type { MergedFinding } from "../modules/build-merged-text.js";
import {
  runPostMergeFinalizationStages,
  type PostMergeFinalizationInput,
} from "./post-merge-finalization.js";
import { runAbsenceVerificationPhase } from "./absence-verification-phase.js";
import { parseDateFromFileName } from "./parse-date-from-filename.js";
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

// ===========================================================================
// P0 scope resolution — inlined verbatim from the former ic-questions-scope.ts
// ===========================================================================
//
// Relocated here without logic change. The standalone module repeatedly failed
// `FileSystemManager.getFileWithIds` in the Superblocks CLI's Vite transform,
// breaking the editor build; the fix lives in the globally-installed
// @superblocksteam/cli, outside this app. Removing the file removes that
// failure surface. Reversible once the CLI issue is resolved.
//
// Original module doc follows.
//
/**
 * IC Questions (v2) — P0 scope resolution.
 *
 * Resolves the ONLY corpus `ic_challenge_mode` v2 is permitted to see: documents
 * on the deal tagged `ic_memo`, plus their extractions. Nothing else.
 *
 * ── Why scope resolution is its own module ─────────────────────────────────
 * The exclusion of the CIM, vendor/legal DD, consultant reports, and financial
 * models is the module's entire thesis: it reproduces what an IC member actually
 * saw. If scope selection lived inline in the pipeline-core branch it would sit
 * next to the general extraction loader that reads EVERY document on the deal,
 * one editing accident away from silently widening the corpus and invalidating
 * every question the module produces. Keeping it here makes the tag filter a
 * single, reviewable surface.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 * Zero `ic_memo` documents is not an empty result, it is a scope error: the
 * module cannot reproduce an IC member's view of a deal that has no IC memo.
 * This module reports that as a failure for the caller to record against the
 * run; it never proceeds with a wider corpus.
 */

/**
 * Log prefix for the scope code. Kept distinct from this module's own
 * `LOG_PREFIX` so relocated log lines remain byte-identical to the originals.
 */
const SCOPE_LOG_PREFIX = "[ic-questions-scope]";

/**
 * Matches the extraction page size in `pipeline-core.ts`. Rows carry
 * `extraction_json` at 5–38KB, so 50 rows ≈ 1MB — well under the 4MB gRPC
 * response ceiling.
 */
const EXTRACTION_PAGE_SIZE = 50;

/** One IC memo, carrying its position in the memo chronology. */
export interface ICMemoDoc {
  id: string;
  file_name: string;
  /** e.g. `"MEMO 3 of 4 — 2026-06-15"`, or `"MEMO 4 of 4 (position inferred)"`. */
  version_label: string;
}

/** One extraction row for a memo chunk. */
export interface ICMemoExtraction {
  document_id: string;
  chunk_index: number;
  extraction_json: any;
}

/** Everything the synthesis call (P2) and the renderer (P4) need about scope. */
export interface ICQuestionsScope {
  /** Memos in chronological order, 1..N. */
  memoDocs: ICMemoDoc[];
  /** Usable extraction rows for `memoDocs` only. Failed chunks excluded. */
  extractions: ICMemoExtraction[];
  /** Per-memo usable chunk counts, in `memoDocs` order — feeds the P8 disclosure. */
  memoCoverage: Array<{ file_name: string; chunks_used: number }>;
  /** Memos whose ordering came from filename sort because no date parsed (F4). */
  orderingFallbackDocs: string[];
}

export type ICQuestionsScopeResult =
  | { ok: true; scope: ICQuestionsScope }
  | { ok: false; errorPhase: "no_ic_memos"; errorMessage: string };

const MemoDocumentRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string(),
});

const MemoExtractionRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  extraction_json: z.any(),
});

/**
 * Resolve the IC memo corpus for a deal (P0).
 *
 * @returns `{ ok: true, scope }`, or `{ ok: false, errorPhase: "no_ic_memos" }`
 *          when the deal has no document tagged `ic_memo`. The caller owns
 *          marking the run failed — this module does not touch `module_runs`.
 */
export async function resolveICQuestionsScope(
  db: PipelineContext["integrations"]["db"],
  dealId: string,
): Promise<ICQuestionsScopeResult> {
  // ── Step 1: the tag filter. The single source of the module's scope. ──────
  const memoRows = await db.query(
    `SELECT id, file_name, document_tag FROM documents
     WHERE deal_id = $1 AND document_tag = 'ic_memo' ORDER BY file_name`,
    MemoDocumentRowSchema,
    [dealId],
    { label: "IC questions scope — load ic_memo documents" },
  );

  if (memoRows.length === 0) {
    const errorMessage =
      "IC Questions requires at least one document tagged 'ic_memo'.";
    console.error(`${SCOPE_LOG_PREFIX} no ic_memo documents on deal ${dealId} — scope error.`);
    return { ok: false, errorPhase: "no_ic_memos", errorMessage };
  }

  // ── Step 2: chronology ───────────────────────────────────────────────────
  // Sort key is the parsed date where one exists, else the file name. Because
  // ISO dates begin with digits, dated memos sort ahead of letter-initial
  // filenames as a consequence of this rule, not as a separate tier.
  const orderingFallbackDocs: string[] = [];
  const keyed = memoRows.map((row) => {
    const parsedDate = parseDateFromFileName(row.file_name);
    if (parsedDate === null) orderingFallbackDocs.push(row.file_name);
    return { id: row.id, file_name: row.file_name, parsedDate };
  });

  keyed.sort((a, b) => {
    const ka = a.parsedDate ?? a.file_name;
    const kb = b.parsedDate ?? b.file_name;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });

  // ── Step 3: version labels ───────────────────────────────────────────────
  // A memo with no parsed date is labelled "(position inferred)" INSTEAD of a
  // date. This marker is load-bearing, not cosmetic: the P3 synthesis prompt
  // keys off the literal string "(position inferred)" to suppress version_drift
  // claims across that memo and downgrade them to internal_inconsistency. A bare
  // "MEMO n of N" would leave the model unable to tell a guessed position from a
  // known one, and it would assert drift direction across an ordering nobody
  // established. Substituting a neighbouring memo's date or the upload timestamp
  // would be worse still — fabricated provenance inside an attribution line the
  // reader treats as verbatim.
  const total = keyed.length;
  const memoDocs: ICMemoDoc[] = keyed.map((doc, i) => ({
    id: doc.id,
    file_name: doc.file_name,
    version_label:
      doc.parsedDate === null
        ? `MEMO ${i + 1} of ${total} (position inferred)`
        : `MEMO ${i + 1} of ${total} — ${doc.parsedDate}`,
  }));

  // ── Step 4: extractions, scoped to these document IDs only ───────────────
  const memoIds = memoDocs.map((d) => d.id);
  const rawRows: ICMemoExtraction[] = [];
  let offset = 0;
  while (true) {
    const page = await db.query(
      `SELECT document_id, chunk_index, extraction_json
       FROM universal_extractions
       WHERE document_id = ANY($1::uuid[])
       ORDER BY document_id, chunk_index
       LIMIT ${EXTRACTION_PAGE_SIZE} OFFSET ${offset}`,
      MemoExtractionRowSchema,
      [memoIds],
      { label: `IC questions scope — load memo extractions (offset ${offset})` },
    );
    rawRows.push(...page);
    if (page.length < EXTRACTION_PAGE_SIZE) break;
    offset += EXTRACTION_PAGE_SIZE;
  }

  // Failed chunks hold no usable text. Excluding them here keeps `chunks_used`
  // in the P8 disclosure an honest count of what the model actually read.
  const extractions: ICMemoExtraction[] = [];
  let failedCount = 0;
  for (const row of rawRows) {
    const ext =
      typeof row.extraction_json === "string"
        ? JSON.parse(row.extraction_json)
        : row.extraction_json;
    if (ext?.failed) {
      failedCount++;
      continue;
    }
    extractions.push({ ...row, extraction_json: ext });
  }

  // ── Step 5: coverage, in memoDocs order ──────────────────────────────────
  const chunkCounts = new Map<string, number>();
  for (const e of extractions) {
    chunkCounts.set(e.document_id, (chunkCounts.get(e.document_id) ?? 0) + 1);
  }
  const memoCoverage = memoDocs.map((d) => ({
    file_name: d.file_name,
    chunks_used: chunkCounts.get(d.id) ?? 0,
  }));

  // A memo with zero usable chunks contributes nothing but is still counted in
  // the disclosure's memo total. Dropping it is not sanctioned by the spec, so
  // it is surfaced loudly instead of silently removed.
  for (const c of memoCoverage) {
    if (c.chunks_used === 0) {
      // stdout, not stderr: a stderr write is surfaced as a step error, and this
      // memo is disclosed rather than dropped, so the run must still succeed.
      console.log(
        `${SCOPE_LOG_PREFIX} ADVISORY: memo "${c.file_name}" has 0 usable chunks — it will be ` +
        "named in the disclosure but contribute no text.",
      );
    }
  }

  console.log(
    `${SCOPE_LOG_PREFIX} resolved ${memoDocs.length} IC memo(s), ${extractions.length} usable chunk(s) ` +
    `(${failedCount} failed excluded), orderingFallback ${orderingFallbackDocs.length}.`,
  );
  for (const d of memoDocs) {
    console.log(`${SCOPE_LOG_PREFIX}   ${d.version_label} — ${d.file_name}`);
  }

  return {
    ok: true,
    scope: { memoDocs, extractions, memoCoverage, orderingFallbackDocs },
  };
}

// ===========================================================================
// End of relocated scope resolution
// ===========================================================================

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
