/**
 * IC Questions (v2) — data contract and fail-closed parser.
 *
 * `ic_challenge_mode` v2 synthesises IC questions in a SINGLE LLM call over the
 * IC memo corpus (documents tagged `ic_memo`). This module owns the shape of
 * that call's output and the ONLY sanctioned way to turn raw model output into
 * trusted `ICQuestion` values.
 *
 * ── Fail-closed contract ────────────────────────────────────────────────────
 * `parseICQuestions` NEVER defaults, coerces, or repairs. A question that does
 * not fully satisfy `ICQuestion` is REJECTED and recorded in
 * `ICQuestionParseResult.rejected` with a specific, human-readable reason plus
 * the offending raw value. Nothing is silently dropped.
 *
 * The rationale is anchor fidelity: every question published by this module is
 * read directly by a deal team and must be traceable to a verbatim quote in a
 * named memo. A question with a missing or empty anchor is indistinguishable
 * from a fabricated one, so it must not survive parsing.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Why the question exists — the analytical lens that produced it. */
export const IC_QUESTION_TYPES = [
  "unsupported_assertion",
  "internal_inconsistency",
  "version_drift",
  "checklist_omission",
  "assumption_challenge",
] as const;

export type ICQuestionType = (typeof IC_QUESTION_TYPES)[number];

/** How well the memo corpus already answers the question. */
export const IC_ANSWER_READINESS = [
  "answered_in_memo",
  "partially_addressed",
  "not_addressed",
] as const;

export type ICAnswerReadiness = (typeof IC_ANSWER_READINESS)[number];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * A verbatim tie-back from a question to the memo text that provoked it.
 *
 * `quote` MUST be verbatim memo text. `claim_id` ties the quote to an extracted
 * claim so downstream provenance resolution can verify it.
 */
export interface ICQuestionAnchor {
  claim_id: string;
  quote: string;
  source_doc: string;
  memo_version: string;
}

/** A single IC question. `anchors` is REQUIRED and must hold at least one entry. */
export interface ICQuestion {
  rank: number;
  question: string;
  why_it_matters: string;
  question_type: ICQuestionType;
  answer_readiness: ICAnswerReadiness;
  /** REQUIRED, minimum 1 — a question with no anchor cannot be published. */
  anchors: ICQuestionAnchor[];
}

/**
 * Outcome of parsing raw model output.
 *
 * `questions` holds only fully-valid questions. `rejected` holds one entry per
 * discarded item, each carrying the specific reason(s) it failed.
 */
export interface ICQuestionParseResult {
  questions: ICQuestion[];
  rejected: Array<{ reason: string; raw: unknown }>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[ic-questions-contract]";

/** True only for a string with at least one non-whitespace character. */
function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate one anchor. Returns the specific failure reasons — empty array means
 * the anchor is valid. Values are NOT trimmed or rewritten here; validation is
 * strictly read-only so the caller publishes exactly what the model produced.
 */
function anchorIssues(raw: unknown, index: number): string[] {
  const at = `anchors[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [`${at} is not an object (got ${Array.isArray(raw) ? "array" : typeof raw})`];
  }

  const obj = raw as Record<string, unknown>;
  const issues: string[] = [];

  // claim_id — absent or empty is a hard reject (spec: fail-closed).
  if (!isNonBlankString(obj.claim_id)) {
    issues.push(`${at}.claim_id is missing or empty`);
  }

  // quote — absent, empty, or whitespace-only is a hard reject (spec: fail-closed).
  if (!isNonBlankString(obj.quote)) {
    issues.push(`${at}.quote is missing, empty, or whitespace-only`);
  }

  // source_doc / memo_version are rendered verbatim in the attribution line
  // ("— {source_doc}, {memo_version}"). Missing values cannot be defaulted
  // without fabricating provenance, so they are rejected too.
  if (!isNonBlankString(obj.source_doc)) {
    issues.push(`${at}.source_doc is missing or empty`);
  }
  if (!isNonBlankString(obj.memo_version)) {
    issues.push(`${at}.memo_version is missing or empty`);
  }

  return issues;
}

/**
 * Validate one question. Returns the specific failure reasons — empty array
 * means every field satisfies `ICQuestion`.
 */
function questionIssues(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [`item is not an object (got ${Array.isArray(raw) ? "array" : typeof raw})`];
  }

  const obj = raw as Record<string, unknown>;
  const issues: string[] = [];

  // rank — required number. Not derived from array position: deriving it would
  // be a default, which this parser is forbidden from doing.
  if (typeof obj.rank !== "number" || !Number.isFinite(obj.rank)) {
    issues.push(`rank is missing or not a finite number (got ${JSON.stringify(obj.rank)})`);
  }

  // question — empty is a hard reject (spec: fail-closed).
  if (!isNonBlankString(obj.question)) {
    issues.push("question is missing, empty, or whitespace-only");
  }

  // why_it_matters — rendered as its own paragraph; cannot be defaulted.
  if (!isNonBlankString(obj.why_it_matters)) {
    issues.push("why_it_matters is missing, empty, or whitespace-only");
  }

  // question_type — outside the enum is a hard reject (spec: fail-closed).
  if (!IC_QUESTION_TYPES.includes(obj.question_type as ICQuestionType)) {
    issues.push(
      `question_type ${JSON.stringify(obj.question_type)} is not one of: ${IC_QUESTION_TYPES.join(", ")}`,
    );
  }

  // answer_readiness — outside the enum is a hard reject (spec: fail-closed).
  if (!IC_ANSWER_READINESS.includes(obj.answer_readiness as ICAnswerReadiness)) {
    issues.push(
      `answer_readiness ${JSON.stringify(obj.answer_readiness)} is not one of: ${IC_ANSWER_READINESS.join(", ")}`,
    );
  }

  // anchors — absent, non-array, or empty is a hard reject (spec: fail-closed).
  if (obj.anchors === undefined || obj.anchors === null) {
    issues.push("anchors is missing — at least one anchor is required");
  } else if (!Array.isArray(obj.anchors)) {
    issues.push(`anchors is not an array (got ${typeof obj.anchors})`);
  } else if (obj.anchors.length === 0) {
    issues.push("anchors is empty — at least one anchor is required");
  } else {
    // Every anchor must be valid. One bad anchor rejects the whole question:
    // dropping just the bad anchor would silently narrow the evidence base.
    for (let i = 0; i < obj.anchors.length; i++) {
      issues.push(...anchorIssues(obj.anchors[i], i));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse raw model output into `ICQuestion` values, fail-closed.
 *
 * Accepts either a bare array of question objects or an object with a
 * `questions` array (container-level tolerance only — no field is ever
 * defaulted, coerced, or repaired).
 *
 * Every discarded item lands in `rejected` with a reason naming each field that
 * failed, so a degraded run is always explainable from the logs.
 *
 * @param raw     Parsed JSON from the model (NOT a raw string — the caller owns
 *                JSON extraction so that extraction failures stay distinct from
 *                contract violations).
 * @param source  Context label used in log lines.
 */
export function parseICQuestions(raw: unknown, source = "unknown"): ICQuestionParseResult {
  const questions: ICQuestion[] = [];
  const rejected: Array<{ reason: string; raw: unknown }> = [];

  // Unwrap the common `{ questions: [...] }` envelope. This is a container
  // shape, not a field value, so unwrapping it is not a repair.
  let items: unknown = raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Array.isArray((raw as Record<string, unknown>).questions)
  ) {
    items = (raw as Record<string, unknown>).questions;
  }

  if (!Array.isArray(items)) {
    const reason = `payload is not an array of questions (got ${
      items === null ? "null" : Array.isArray(items) ? "array" : typeof items
    })`;
    console.error(`${LOG_PREFIX} parseICQuestions: ${reason} (source=${source})`);
    return { questions: [], rejected: [{ reason, raw }] };
  }

  for (const item of items) {
    const issues = questionIssues(item);
    if (issues.length === 0) {
      // Safe to assert: questionIssues verified every field of the contract.
      questions.push(item as ICQuestion);
    } else {
      rejected.push({ reason: issues.join("; "), raw: item });
    }
  }

  if (rejected.length > 0) {
    console.warn(
      `${LOG_PREFIX} parseICQuestions: accepted ${questions.length}, rejected ${rejected.length} ` +
      `(source=${source})`,
    );
    for (let i = 0; i < rejected.length; i++) {
      console.warn(`${LOG_PREFIX}   rejected[${i}]: ${rejected[i].reason}`);
    }
  } else {
    console.log(
      `${LOG_PREFIX} parseICQuestions: accepted ${questions.length}, rejected 0 (source=${source})`,
    );
  }

  return { questions, rejected };
}
