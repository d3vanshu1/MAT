/**
 * IC Questions (v2) — P2/P3 single-call synthesis over the IC memo corpus.
 *
 * ONE LLM call. The whole memo corpus goes in; a ranked, anchored question set
 * comes out. There is no map-reduce, no merge tree, no per-chunk analysis.
 *
 * ── Why one call ───────────────────────────────────────────────────────────
 * Three of the five question types (`version_drift`, `internal_inconsistency`,
 * `checklist_omission`) are only visible from the WHOLE corpus at once. Drift
 * between memo 2 and memo 4 cannot be seen by an agent holding memo 2, and an
 * omission cannot be asserted by an agent that has not read every memo. Chunked
 * analysis followed by a merge would let each stage assert absence from partial
 * evidence — precisely the fabrication mode that this module exists to avoid.
 * So the corpus is NOT truncated, NOT chunked, and NOT summarised before the
 * call. If it does not fit, the run fails loudly (see PAYLOAD_CHAR_CEILING).
 *
 * ── What this module trusts ────────────────────────────────────────────────
 * Nothing the model asserts about provenance. Every anchor is re-verified
 * against the extracted memo text before it can be published:
 *   step 5 — claim_id is resolved through the origin map
 *   step 6 — the quote must be findable, verbatim, in the named memo
 * Anchors that fail are DROPPED and counted; questions left with no surviving
 * anchor are dropped whole. The published attribution line is rewritten to the
 * canonical memo label so the reader never sees a model-rendered filename.
 */

import { z } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import {
  parseICQuestions,
  type ICQuestion,
  type ICQuestionAnchor,
  type ICQuestionType,
} from "./ic-questions-contract.js";
import { buildOriginMapFromRoutedArray, resolveProvenance } from "./claim-origin-map.js";
import type { ICQuestionsScope, ICMemoDoc } from "./ic-questions-path.js";
import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";

const LOG_PREFIX = "[ic-questions-synthesis]";

/** Checkpoint key for the completed synthesis result (step 8). */
const CHECKPOINT_KEY = "ic_questions_v2";

/** Output budget for the single call. ~15 fully-anchored questions fit comfortably. */
const SYNTHESIS_MAX_TOKENS = 8000;

/**
 * Per-attempt timeout for the synthesis call.
 *
 * 180s, not 240s: at the 300s platform cap with 30s reserved headroom, a 240s
 * first attempt leaves no room for a second, so `callLLMWithHeadroom` would
 * refuse every retry and a transient 429 would kill the invocation. 180s leaves
 * a real retry available while still being ample for 8k output tokens.
 */
const SYNTHESIS_CALL_TIMEOUT_MS = 180_000;

/** Retry attempts for the synthesis call (budget permitting). */
const SYNTHESIS_RETRIES = 2;

/**
 * Hard ceiling on the assembled payload, in characters.
 *
 * This is a FAIL gate, not a truncation gate. Truncating the corpus would let
 * the model assert omissions against memo text it never saw, which is the one
 * failure mode this module must not have.
 *
 * Calibrated for claude-sonnet-4-6, whose context window is 1M tokens. At the
 * ~4 chars/token typical of extraction JSON, 2M chars is roughly 500k tokens,
 * leaving ~500k tokens of headroom for the system prompt, cache-block overhead
 * and the 8k output budget. Above the ceiling the run fails and an operator
 * decides what to do.
 */
const PAYLOAD_CHAR_CEILING = 2_000_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Synthesis failure carrying the `error_phase` the caller must record. */
export class ICQuestionsSynthesisError extends Error {
  readonly errorPhase: string;
  constructor(message: string, errorPhase: string) {
    super(message);
    this.name = "ICQuestionsSynthesisError";
    this.errorPhase = errorPhase;
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Everything the P6 branch needs to assemble an `ICQuestionsArtifact`. */
export interface ICQuestionsSynthesisResult {
  /** Verified survivors, re-ranked 1..N contiguously (step 7). */
  questions: ICQuestion[];
  /** Deterministically composed (step 9). */
  executiveHeader: string;
  /** Contract rejections from `parseICQuestions`. */
  rejectedCount: number;
  /** Anchors dropped at verification (steps 5–6). */
  anchorDropCount: number;
  /** Questions whose rank came from emission order. */
  rankDerivedCount: number;
  /** Observability for the post-run report (R1–R4). Never load-bearing. */
  diagnostics: ICQuestionsSynthesisDiagnostics;
}

export interface ICQuestionsSynthesisDiagnostics {
  resumedFromCheckpoint: boolean;
  payloadChars: number;
  memoBlocks: number;
  chunksIncluded: number;
  chunksWithoutExtractionText: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Corpus tokens written to the prompt cache on this call (null when absent). */
  cacheCreationTokens: number | null;
  /** Corpus tokens served from the prompt cache on this call (null when absent). */
  cacheReadTokens: number | null;
  stopReason: string | null;
  /** Questions the model emitted (before contract parsing). */
  emittedByModel: number;
  /** Questions that survived the contract but lost every anchor. */
  questionsDroppedNoAnchors: number;
  anchorsSubmitted: number;
  anchorsSurviving: number;
  /** Anchor drop reasons — these sum to `anchorDropCount`. */
  dropProvenanceNonMemo: number;
  dropQuoteNotFound: number;
  dropSourceDocUnresolvable: number;
  /** claim_ids with no origin-map entry. Logged, NOT dropped — see step 5. */
  unresolvedClaimIds: number;
  /** Anchors whose quote matched only after typographic normalisation. */
  quoteLenientMatches: number;
  /** Anchors whose attribution was corrected to the canonical memo label. */
  attributionCanonicalised: number;
  /** Anchors whose memo was recovered by unique quote match (step 6b). */
  attributionRecoveredByQuote: number;
  timings: {
    payloadBuildMs: number;
    synthesisCallMs: number;
    verificationMs: number;
    totalMs: number;
  };
}

// ---------------------------------------------------------------------------
// P3 — system prompt
// ---------------------------------------------------------------------------

/**
 * The P3 synthesis prompt.
 *
 * Three constraints in here are load-bearing and must not be softened:
 *
 *  1. The "(position inferred)" rule. P0 emits that literal marker for a memo
 *     whose chronological position was guessed. The prompt keys off the string
 *     to forbid `version_drift` across that memo — otherwise the model asserts a
 *     direction of change over an ordering nobody established.
 *  2. Verbatim quoting with no ellipses and no stitching. Step 6 verifies quotes
 *     by substring match against the extracted text; a paraphrase or a stitched
 *     quote is indistinguishable from a fabricated one and gets dropped, so
 *     licence to paraphrase here would silently gut the question set.
 *  3. No markdown headings in field values. The G1 FATAL gate rejects any line
 *     starting with a canonical-renderer heading; a model that formats
 *     `why_it_matters` with `## ` would fail the run at publication.
 */
const P3_SYSTEM_PROMPT = `You are a veteran private equity Investment Committee member. A deal has been brought to committee and you have read the IC memo set reproduced below — and nothing else. You have NOT seen the CIM or Information Memorandum, the vendor or legal due diligence reports, the commercial or consultant reports, or the financial model. Your information position is exactly the memo set. Your task is to produce the questions you would actually ask in the room.

## Input format

The memos appear in chronological order. Each is introduced by a header line:

===== MEMO n of N — YYYY-MM-DD — <file name> =====
===== MEMO n of N (position inferred) — <file name> =====

Each memo block contains the extracted representation of that memo. Where the extraction contains a "key_claims" array, each entry carries an "id" — those ids are the only valid claim_id values.

## What to produce

The questions the memo set genuinely supports — ordinarily eight to fifteen. Never pad the list to reach a count, and never split one question into two to inflate it. One sharp question outranks three soft ones.

Each question must belong to exactly one type:

- "unsupported_assertion" — the memo asserts something material to the decision but presents no evidence for it.
- "internal_inconsistency" — two statements in the memo set cannot both be true, or a figure does not reconcile with another figure.
- "version_drift" — a position, figure, or plan changed between memo versions and the change is not explained.
- "checklist_omission" — a standard diligence topic an IC would expect to be covered is not addressed anywhere in the memo set.
- "assumption_challenge" — the memo treats a contestable assumption as settled.

And carry an answer_readiness:

- "answered_in_memo" — the memo set already answers it; you are asking to test the answer, not to learn it.
- "partially_addressed" — the memo set touches the topic but leaves the material part open.
- "not_addressed" — the memo set does not address it.

## Anchors — the hard requirement

Every question needs at least one anchor, and every anchor needs four fields:

- "quote" — memo text copied CHARACTER FOR CHARACTER. Never paraphrase. Never join two separated sentences into one quote. Never insert an ellipsis or bracketed edit. Roughly fifteen to sixty words, and it must be a contiguous span of the memo text as given to you.
- "claim_id" — an id that literally appears in that memo's extraction.
- "source_doc" — the file name exactly as written in that memo's header line.
- "memo_version" — the "MEMO n of N ..." label exactly as written in that memo's header line.

Additional rules:

- For "version_drift" and "internal_inconsistency", supply at least two anchors: one for each side of the change or the contradiction.
- For "checklist_omission", anchor the quote to the point where the memo comes closest to the topic and then stops. An omission still needs a foothold in the text.
- If you cannot anchor a question in verbatim memo text, OMIT THE QUESTION. Every quote is machine-verified against the memo text after you answer; an unverifiable quote is discarded, and a question that loses all its anchors is discarded whole. A fabricated quote or claim_id is worse than a missing question.

## The "(position inferred)" rule

A header reading "(position inferred)" means that memo's place in the chronology was GUESSED — no date could be established for it. For any memo so marked:

- Do NOT raise a "version_drift" question involving it.
- Do NOT assert a direction of change ("increased to", "was revised down from") across it.
- If you find a discrepancy between it and another memo, classify it as "internal_inconsistency" instead.

## Ranking

rank 1 is the question that is both most likely to be asked and hardest to answer. Rank by likelihood multiplied by difficulty, descending.

## why_it_matters

One to three sentences saying what the ANSWER would change about the investment decision. Not why the topic matters in general.

## Output

Return raw JSON and nothing else — no prose before or after, no markdown code fence:

{"questions":[{"rank":1,"question":"...","why_it_matters":"...","question_type":"...","answer_readiness":"...","anchors":[{"claim_id":"...","quote":"...","source_doc":"...","memo_version":"..."}]}]}

Field values must be plain prose. Do not use markdown headings, bullet lists, or tier labels inside any field value.`;

// ---------------------------------------------------------------------------
// Text normalisation for quote verification
// ---------------------------------------------------------------------------

/** Collapse all whitespace runs to a single space and trim. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Comparison-only normalisation: fold typographic variants that a model
 * routinely re-renders (curly quotes, en/em dashes, non-breaking spaces,
 * zero-width characters) and lowercase.
 *
 * This affects MATCHING ONLY. The published quote is always the model's own
 * string, so no verbatim guarantee is weakened; a lenient match merely means
 * "this span is present in the memo, modulo punctuation rendering". Lenient
 * matches are counted separately so a run that leans on them is visible.
 */
function lenientNormalize(s: string): string {
  return collapseWhitespace(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Payload assembly (steps 1–2)
// ---------------------------------------------------------------------------

/** Pull the text a chunk contributes to the payload. */
function extractionTextOf(extractionJson: any): string | null {
  const ext =
    typeof extractionJson === "string" ? safeParse(extractionJson) : extractionJson;
  if (!ext) return null;
  if (typeof ext.extraction === "string" && ext.extraction.trim().length > 0) {
    return ext.extraction;
  }
  if (typeof ext.text === "string" && ext.text.trim().length > 0) return ext.text;
  return null;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

interface BuiltPayload {
  payload: string;
  memoBlocks: number;
  chunksIncluded: number;
  chunksWithoutExtractionText: number;
  /** memo file_name → whitespace-collapsed full text, for step 6. */
  corpusByMemo: Map<string, string>;
}

/**
 * Assemble the single user message.
 *
 * Chunks are ordered by (memo chronological position, chunk_index) so the model
 * reads each memo front-to-back and the memos in the order they were written —
 * the ordering `version_drift` depends on.
 */
function buildPayload(scope: ICQuestionsScope): BuiltPayload {
  const positionOf = new Map<string, number>();
  scope.memoDocs.forEach((d, i) => positionOf.set(d.id, i));

  const ordered = [...scope.extractions].sort((a, b) => {
    const pa = positionOf.get(a.document_id) ?? Number.MAX_SAFE_INTEGER;
    const pb = positionOf.get(b.document_id) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.chunk_index - b.chunk_index;
  });

  const byMemo = new Map<string, string[]>();
  let chunksIncluded = 0;
  let chunksWithoutExtractionText = 0;

  for (const row of ordered) {
    const text = extractionTextOf(row.extraction_json);
    if (text === null) {
      chunksWithoutExtractionText++;
      continue;
    }
    const bucket = byMemo.get(row.document_id) ?? [];
    bucket.push(text);
    byMemo.set(row.document_id, bucket);
    chunksIncluded++;
  }

  const blocks: string[] = [];
  const corpusByMemo = new Map<string, string>();

  for (const memo of scope.memoDocs) {
    const texts = byMemo.get(memo.id) ?? [];
    // The header carries the version label verbatim — the model must echo it
    // back as `memo_version`, and the "(position inferred)" rule keys off it.
    blocks.push(`===== ${memo.version_label} — ${memo.file_name} =====\n\n${texts.join("\n\n")}`);
    corpusByMemo.set(memo.file_name, collapseWhitespace(texts.join("\n\n")));
  }

  return {
    payload: blocks.join("\n\n"),
    memoBlocks: blocks.length,
    chunksIncluded,
    chunksWithoutExtractionText,
    corpusByMemo,
  };
}

// ---------------------------------------------------------------------------
// JSON extraction (step 4)
// ---------------------------------------------------------------------------

/**
 * Pull the JSON object out of the model's text block.
 *
 * Kept separate from `parseICQuestions` so a transport-level failure (the model
 * emitted prose) stays distinguishable from a contract-level failure (the model
 * emitted well-formed JSON that violates the schema).
 */
function extractJsonObject(text: string): unknown {
  let body = text.trim();

  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) body = fenced[1].trim();

  if (!body.startsWith("{") && !body.startsWith("[")) {
    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new ICQuestionsSynthesisError(
        `Synthesis returned no JSON object (${text.length} chars, starts: ${JSON.stringify(text.slice(0, 160))}).`,
        "ic_questions_unparseable_output",
      );
    }
    body = body.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(body);
  } catch (err) {
    throw new ICQuestionsSynthesisError(
      `Synthesis output is not valid JSON: ${err instanceof Error ? err.message : String(err)} ` +
        `(${body.length} chars, starts: ${JSON.stringify(body.slice(0, 160))}).`,
      "ic_questions_unparseable_output",
    );
  }
}

// ---------------------------------------------------------------------------
// Step 9 — executive header
// ---------------------------------------------------------------------------

/**
 * Tie-break order for "largest group" when two types have equal counts.
 *
 * Fixed, not count-derived, so the header is deterministic for a given question
 * set. Ordered by how directly the type indicts the memo: drift and unevidenced
 * assertions are the sharpest signals, a checklist omission the softest.
 */
const DOMINANT_TYPE_TIE_BREAK: readonly ICQuestionType[] = [
  "version_drift",
  "unsupported_assertion",
  "internal_inconsistency",
  "assumption_challenge",
  "checklist_omission",
] as const;

/** Reader-facing phrasing for each type. Contract vocabulary stays in the body. */
const TYPE_PHRASE: Record<ICQuestionType, string> = {
  version_drift: "changes between memo versions",
  unsupported_assertion: "assertions the memo does not evidence",
  internal_inconsistency: "internal inconsistencies",
  checklist_omission: "standard diligence topics not addressed",
  assumption_challenge: "assumptions treated as settled",
};

/**
 * Compose the executive header from counts alone — no second LLM call.
 *
 * A model-written summary of a model-written question set would be a second,
 * unverifiable claim sitting above verified content, and it would drift from the
 * body whenever verification dropped a question. Counting is exact and free.
 */
function buildExecutiveHeader(questions: ICQuestion[], memoCount: number): string {
  const n = questions.length;
  const notAddressed = questions.filter((q) => q.answer_readiness === "not_addressed").length;

  const readinessClause =
    notAddressed > 0
      ? `${notAddressed} ${notAddressed === 1 ? "is" : "are"} not addressed anywhere in the memo set.`
      : "Each is at least partially addressed in the memo set.";

  const counts = new Map<ICQuestionType, number>();
  for (const q of questions) counts.set(q.question_type, (counts.get(q.question_type) ?? 0) + 1);

  let dominant: ICQuestionType = DOMINANT_TYPE_TIE_BREAK[0];
  let dominantCount = -1;
  for (const type of DOMINANT_TYPE_TIE_BREAK) {
    const c = counts.get(type) ?? 0;
    if (c > dominantCount) {
      dominant = type;
      dominantCount = c;
    }
  }

  return (
    `${n} question${n === 1 ? "" : "s"} an IC member is likely to ask, ranked by likelihood and ` +
    `difficulty to answer. ${readinessClause} The largest group is ${TYPE_PHRASE[dominant]} ` +
    `(${dominantCount}), drawn from ${memoCount} IC memo${memoCount === 1 ? "" : "s"}.`
  );
}

// ---------------------------------------------------------------------------
// Checkpoint (step 8)
// ---------------------------------------------------------------------------

const CheckpointRowSchema = z.object({ payload: z.any() });

async function loadCheckpoint(
  db: PipelineContext["integrations"]["db"],
  runId: string,
): Promise<ICQuestionsSynthesisResult | null> {
  try {
    const [row] = await db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = $2
         AND status = 'complete' AND version_hash = $3
       LIMIT 1`,
      CheckpointRowSchema,
      [runId, CHECKPOINT_KEY, getPipelineVersion()],
      { label: "Load ic_questions_v2 checkpoint" },
    );
    if (!row?.payload) return null;
    const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (!Array.isArray(parsed?.questions) || typeof parsed?.executiveHeader !== "string") return null;
    return parsed as ICQuestionsSynthesisResult;
  } catch (err) {
    // pipeline_checkpoints may not exist yet, or the payload may predate a shape
    // change. Either way the correct behaviour is to re-synthesise, not to fail.
    console.log(
      `${LOG_PREFIX} checkpoint load skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function persistCheckpoint(
  db: PipelineContext["integrations"]["db"],
  runId: string,
  result: ICQuestionsSynthesisResult,
): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
       VALUES ($1, $2, $3::jsonb, 'complete', $4)
       ON CONFLICT (module_run_id, checkpoint_key)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(),
                     status = 'complete', version_hash = EXCLUDED.version_hash`,
      [runId, CHECKPOINT_KEY, JSON.stringify(result), getPipelineVersion()],
      { label: "Persist ic_questions_v2 checkpoint" },
    );
  } catch (err) {
    // Non-fatal: losing the checkpoint costs one repeated LLM call on resume, it
    // does not corrupt anything. Failing the run here would be worse.
    console.warn(
      `${LOG_PREFIX} checkpoint persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run IC Questions synthesis (steps 1–9).
 *
 * @throws {ICQuestionsSynthesisError} payload over ceiling, or unparseable model
 *         output. Carries `errorPhase` for the caller to record.
 * @throws propagates `HeadroomExhaustedError` and transport errors from
 *         `callLLMWithHeadroom` unchanged, so the caller can distinguish a
 *         budget yield from a synthesis defect.
 */
export async function runICQuestionsSynthesis(
  ctx: PipelineContext,
  runId: string,
  scope: ICQuestionsScope,
  useOpus: boolean | null | undefined,
  pipelineStartTime: number,
): Promise<ICQuestionsSynthesisResult> {
  const totalStart = Date.now();

  // ── Step 8 (resume first): a completed synthesis is never redone ──────────
  const resumed = await loadCheckpoint(ctx.integrations.db, runId);
  if (resumed) {
    console.log(
      `${LOG_PREFIX} resumed from checkpoint — ${resumed.questions.length} question(s), ` +
        "no LLM call made.",
    );
    return {
      ...resumed,
      diagnostics: { ...resumed.diagnostics, resumedFromCheckpoint: true },
    };
  }

  // ── Steps 1–2: order chunks, assemble the payload ─────────────────────────
  const payloadStart = Date.now();
  const built = buildPayload(scope);
  const payloadBuildMs = Date.now() - payloadStart;

  console.log(
    `${LOG_PREFIX} payload: ${built.payload.length} chars, ${built.memoBlocks} memo block(s), ` +
      `${built.chunksIncluded} chunk(s) included, ${built.chunksWithoutExtractionText} chunk(s) ` +
      "carried no extraction text.",
  );

  if (built.payload.length > PAYLOAD_CHAR_CEILING) {
    throw new ICQuestionsSynthesisError(
      `IC memo corpus is ${built.payload.length} chars, over the ${PAYLOAD_CHAR_CEILING}-char ` +
        "single-call ceiling. The corpus is deliberately never truncated for this module — " +
        "truncation would let the model assert omissions against memo text it never saw. " +
        "Reduce the tagged memo set or raise the ceiling with a larger-context model.",
      "ic_memo_corpus_too_large",
    );
  }

  // ── Step 3: the single call ───────────────────────────────────────────────
  const model = getModuleModel("ic_challenge_mode", useOpus);
  const callStart = Date.now();
  const response = await callLLMWithHeadroom(
    ctx,
    {
      model,
      max_tokens: SYNTHESIS_MAX_TOKENS,
      // Both the system prompt and the memo corpus are cached. The corpus is
      // the expensive part (hundreds of thousands of tokens) and is byte-identical
      // across retries, so caching it turns a retry from a full re-prefill into a
      // cache read — which is what makes retrying viable inside the per-call
      // timeout at this corpus size.
      system: [{ type: "text", text: P3_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: built.payload,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    },
    "IC Questions synthesis (single call over memo corpus)",
    {
      pipelineStartTime,
      maxPerCallTimeout: SYNTHESIS_CALL_TIMEOUT_MS,
      retries: SYNTHESIS_RETRIES,
    },
  );
  const synthesisCallMs = Date.now() - callStart;

  const rawText = response.content.find((c) => c.type === "text")?.text ?? "";
  console.log(
    `${LOG_PREFIX} synthesis call: model=${response.model}, ${synthesisCallMs}ms, ` +
      `in=${response.usage.input_tokens} out=${response.usage.output_tokens} ` +
      `cache_write=${response.usage.cache_creation_input_tokens ?? 0} ` +
      `cache_read=${response.usage.cache_read_input_tokens ?? 0} ` +
      `stop=${response.stop_reason}, ${rawText.length} chars of text.`,
  );
  if (response.stop_reason === "max_tokens") {
    // Not fatal on its own — the JSON may still parse if the model finished the
    // array. If it did not, extractJsonObject fails loudly next. Kept on stdout:
    // stderr writes are surfaced as step errors, which would make this fatal.
    console.log(
      `${LOG_PREFIX} ADVISORY: synthesis hit max_tokens (${SYNTHESIS_MAX_TOKENS}); the question list may be ` +
        "cut short. Any truncated trailing question will fail the contract and be rejected.",
    );
  }

  // ── Step 4: parse, fail-closed ────────────────────────────────────────────
  const rawJson = extractJsonObject(rawText);
  const emittedByModel = Array.isArray((rawJson as any)?.questions)
    ? (rawJson as any).questions.length
    : Array.isArray(rawJson)
      ? (rawJson as any[]).length
      : 0;
  const parsed = parseICQuestions(rawJson, "ic_questions_synthesis");

  // ── Steps 5–6: anchor verification ────────────────────────────────────────
  const verifyStart = Date.now();
  const verified = verifyAnchors(scope, built.corpusByMemo, parsed.questions);
  const verificationMs = Date.now() - verifyStart;

  // ── Step 7: re-rank survivors 1..N contiguously ───────────────────────────
  // Rank order is preserved from the model's ordering; only the numbering is
  // rewritten, so a gap left by a dropped question never reaches the reader.
  const reranked = verified.questions.map((q, i) => ({ ...q, rank: i + 1 }));

  // ── Step 9: executive header ──────────────────────────────────────────────
  const executiveHeader = buildExecutiveHeader(reranked, scope.memoCoverage.length);

  const result: ICQuestionsSynthesisResult = {
    questions: reranked,
    executiveHeader,
    rejectedCount: parsed.rejected.length,
    anchorDropCount: verified.anchorDropCount,
    rankDerivedCount: parsed.rankDerivedCount,
    diagnostics: {
      resumedFromCheckpoint: false,
      payloadChars: built.payload.length,
      memoBlocks: built.memoBlocks,
      chunksIncluded: built.chunksIncluded,
      chunksWithoutExtractionText: built.chunksWithoutExtractionText,
      model: response.model || model,
      inputTokens: response.usage.input_tokens ?? null,
      outputTokens: response.usage.output_tokens ?? null,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? null,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
      stopReason: response.stop_reason ?? null,
      emittedByModel,
      questionsDroppedNoAnchors: verified.questionsDroppedNoAnchors,
      anchorsSubmitted: verified.anchorsSubmitted,
      anchorsSurviving: verified.anchorsSurviving,
      dropProvenanceNonMemo: verified.dropProvenanceNonMemo,
      dropQuoteNotFound: verified.dropQuoteNotFound,
      dropSourceDocUnresolvable: verified.dropSourceDocUnresolvable,
      unresolvedClaimIds: verified.unresolvedClaimIds,
      quoteLenientMatches: verified.quoteLenientMatches,
      attributionCanonicalised: verified.attributionCanonicalised,
      attributionRecoveredByQuote: verified.attributionRecoveredByQuote,
      timings: {
        payloadBuildMs,
        synthesisCallMs,
        verificationMs,
        totalMs: Date.now() - totalStart,
      },
    },
  };

  console.log(
    `${LOG_PREFIX} synthesis complete: model emitted ${emittedByModel}, contract accepted ` +
      `${parsed.questions.length} (rejected ${parsed.rejected.length}), verification kept ` +
      `${reranked.length} question(s) and ${verified.anchorsSurviving}/${verified.anchorsSubmitted} ` +
      `anchor(s) (dropped ${verified.anchorDropCount}: provenance ${verified.dropProvenanceNonMemo}, ` +
      `quote-not-found ${verified.dropQuoteNotFound}, source-doc ${verified.dropSourceDocUnresolvable}). ` +
      `Lenient quote matches ${verified.quoteLenientMatches}, attribution canonicalised ` +
      `${verified.attributionCanonicalised}, recovered-by-quote ${verified.attributionRecoveredByQuote}, ` +
      `unresolved claim_ids ${verified.unresolvedClaimIds}.`,
  );

  // ── Step 8: persist ───────────────────────────────────────────────────────
  await persistCheckpoint(ctx.integrations.db, runId, result);

  return result;
}

// ---------------------------------------------------------------------------
// Steps 5–6 — verification
// ---------------------------------------------------------------------------

interface VerificationOutcome {
  questions: ICQuestion[];
  anchorDropCount: number;
  questionsDroppedNoAnchors: number;
  anchorsSubmitted: number;
  anchorsSurviving: number;
  dropProvenanceNonMemo: number;
  dropQuoteNotFound: number;
  dropSourceDocUnresolvable: number;
  unresolvedClaimIds: number;
  quoteLenientMatches: number;
  attributionCanonicalised: number;
  attributionRecoveredByQuote: number;
}

/**
 * Verify every anchor against the memo corpus and drop the ones that fail.
 *
 * Step 5 (provenance): the claim_id is resolved through the origin map built
 * from the memo extractions. A claim_id that resolves to a NON-memo document is
 * a provenance breach and the anchor is dropped. A claim_id that resolves to
 * NOTHING is counted and logged but not dropped on that basis alone — the origin
 * map only indexes claims the structural parser could read out of `key_claims`,
 * so an unindexed id is weak evidence of fabrication, whereas the step-6 quote
 * check is direct evidence either way. Dropping on unresolved ids would discard
 * anchors whose text is provably present in the memo.
 *
 * Step 6 (quote): the quote must appear as a contiguous span of the named memo's
 * extracted text, after whitespace collapse. A strict match is preferred; a
 * typographic-fold match is accepted and counted. Failure drops the anchor.
 *
 * Step 6b (attribution): when `source_doc` does not name a memo, the quote is
 * searched across all memos. A quote found in exactly ONE memo determines the
 * attribution — the corpus is ground truth and beats the model's rendering of a
 * filename. Found in none, or in several, is unresolvable and the anchor drops:
 * publishing an attribution line we cannot pin to one memo would be a fabricated
 * citation, which is precisely what the anchor exists to prevent.
 */
function verifyAnchors(
  scope: ICQuestionsScope,
  corpusByMemo: Map<string, string>,
  questions: ICQuestion[],
): VerificationOutcome {
  const memoByFileName = new Map<string, ICMemoDoc>();
  const memoByLowerFileName = new Map<string, ICMemoDoc>();
  for (const m of scope.memoDocs) {
    memoByFileName.set(m.file_name, m);
    memoByLowerFileName.set(m.file_name.toLowerCase(), m);
  }
  const memoFileNames = new Set(memoByFileName.keys());

  const idToFileName = new Map(scope.memoDocs.map((d) => [d.id, d.file_name]));
  const originMap = buildOriginMapFromRoutedArray(
    scope.extractions.map((e) => ({
      document_id: e.document_id,
      chunk_index: e.chunk_index,
      extraction_json: e.extraction_json,
    })),
    idToFileName,
  );

  // Pre-compute the lenient corpus once per memo — normalising per anchor would
  // be O(anchors × corpus).
  const lenientCorpus = new Map<string, string>();
  for (const [fileName, text] of corpusByMemo) {
    lenientCorpus.set(fileName, lenientNormalize(text));
  }

  const out: VerificationOutcome = {
    questions: [],
    anchorDropCount: 0,
    questionsDroppedNoAnchors: 0,
    anchorsSubmitted: 0,
    anchorsSurviving: 0,
    dropProvenanceNonMemo: 0,
    dropQuoteNotFound: 0,
    dropSourceDocUnresolvable: 0,
    unresolvedClaimIds: 0,
    quoteLenientMatches: 0,
    attributionCanonicalised: 0,
    attributionRecoveredByQuote: 0,
  };

  /** Which memo contains this quote? Returns every match. */
  const memosContaining = (quote: string): ICMemoDoc[] => {
    const strict = collapseWhitespace(quote);
    const lenient = lenientNormalize(quote);
    const found: ICMemoDoc[] = [];
    for (const memo of scope.memoDocs) {
      const corpus = corpusByMemo.get(memo.file_name) ?? "";
      if (corpus.includes(strict) || (lenientCorpus.get(memo.file_name) ?? "").includes(lenient)) {
        found.push(memo);
      }
    }
    return found;
  };

  for (const q of questions) {
    const surviving: ICQuestionAnchor[] = [];

    for (const anchor of q.anchors) {
      out.anchorsSubmitted++;

      // ── Step 5: provenance ────────────────────────────────────────────────
      const { derivedSources, unresolvedLegacy } = resolveProvenance([anchor.claim_id], originMap);
      if (derivedSources.size > 0) {
        const anyMemo = [...derivedSources].some((f) => memoFileNames.has(f));
        if (!anyMemo) {
          out.dropProvenanceNonMemo++;
          out.anchorDropCount++;
          console.warn(
            `${LOG_PREFIX} anchor dropped (provenance): claim_id ${anchor.claim_id} resolves to ` +
              `[${[...derivedSources].join(", ")}], none of which is a tagged IC memo.`,
          );
          continue;
        }
      } else {
        out.unresolvedClaimIds++;
        if (unresolvedLegacy.length > 0) {
          console.warn(
            `${LOG_PREFIX} claim_id ${anchor.claim_id} is legacy-format and unresolvable in the ` +
              "origin map — relying on the quote check for verification.",
          );
        }
      }

      // ── Step 6: resolve the named memo ────────────────────────────────────
      let memo =
        memoByFileName.get(anchor.source_doc) ??
        memoByLowerFileName.get(anchor.source_doc.trim().toLowerCase());
      let recoveredByQuote = false;

      if (!memo) {
        // ── Step 6b: recover attribution from the corpus ────────────────────
        const matches = memosContaining(anchor.quote);
        if (matches.length === 1) {
          memo = matches[0];
          recoveredByQuote = true;
          console.warn(
            `${LOG_PREFIX} anchor source_doc ${JSON.stringify(anchor.source_doc)} names no memo; ` +
              `quote is unique to "${memo.file_name}" — attribution recovered from corpus.`,
          );
        } else {
          out.dropSourceDocUnresolvable++;
          out.anchorDropCount++;
          console.warn(
            `${LOG_PREFIX} anchor dropped (source_doc): ${JSON.stringify(anchor.source_doc)} names ` +
              `no memo and the quote matches ${matches.length} memo(s) — attribution unresolvable.`,
          );
          continue;
        }
      }

      // ── Step 6: quote must be present in THAT memo ────────────────────────
      const strictCorpus = corpusByMemo.get(memo.file_name) ?? "";
      const strictQuote = collapseWhitespace(anchor.quote);
      let matched = strictCorpus.includes(strictQuote);

      if (!matched) {
        const lenient = (lenientCorpus.get(memo.file_name) ?? "").includes(
          lenientNormalize(anchor.quote),
        );
        if (lenient) {
          matched = true;
          out.quoteLenientMatches++;
        }
      }

      if (!matched) {
        out.dropQuoteNotFound++;
        out.anchorDropCount++;
        console.warn(
          `${LOG_PREFIX} anchor dropped (quote): not found in "${memo.file_name}" — ` +
            `${JSON.stringify(strictQuote.slice(0, 120))}`,
        );
        continue;
      }

      // Attribution is rewritten to the canonical label. The model's rendering of
      // a filename or version string is not authoritative; the resolved memo is.
      const canonicalised =
        anchor.source_doc !== memo.file_name || anchor.memo_version !== memo.version_label;
      if (canonicalised) out.attributionCanonicalised++;
      if (recoveredByQuote) out.attributionRecoveredByQuote++;

      surviving.push({
        claim_id: anchor.claim_id,
        quote: anchor.quote,
        source_doc: memo.file_name,
        memo_version: memo.version_label,
      });
      out.anchorsSurviving++;
    }

    if (surviving.length === 0) {
      // Anchor drops are already counted individually; this counts the question.
      out.questionsDroppedNoAnchors++;
      console.warn(
        `${LOG_PREFIX} question dropped — every anchor failed verification: ` +
          `${JSON.stringify(q.question.slice(0, 140))}`,
      );
      continue;
    }

    out.questions.push({ ...q, anchors: surviving });
  }

  return out;
}
