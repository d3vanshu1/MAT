/**
 * IC Questions (v2) — report renderer (P4), disclosure header (P8), F4 lines.
 *
 * Turns an `ICQuestionsArtifact` into the markdown published via
 * `reportOverride`, plus the `executiveHeader` published via `headerOverride`.
 *
 * ── Why this module renders and nothing else ────────────────────────────────
 * The renderer is deliberately pure and total: it reads the artifact and emits
 * strings. It does NOT filter, re-rank, re-verify, or repair. Every question in
 * the artifact has already survived the fail-closed contract (`parseICQuestions`)
 * and P2's anchor verification, so anything reaching this module is publishable
 * as-is. Adding a second, softer validation layer here would let a question that
 * P1 rejected slip in by a different route, or silently hide one that P1
 * accepted — both of which break the anchor-fidelity guarantee that the module
 * exists to provide.
 *
 * The single exception is an artifact with ZERO questions, which is a TERMINAL
 * condition, not an empty render. See `ICQuestionsEmptyError` below.
 */

import type { ICQuestion, ICQuestionsArtifact } from "./ic-questions-contract.js";

const LOG_PREFIX = "[ic-questions-render]";

/** What F3 consumes: the report body, the header, and a count for the log line. */
export interface RenderedICQuestionsReport {
  /** Full markdown for `reportOverride`. */
  markdown: string;
  /** Executive header for `headerOverride`. */
  executiveHeader: string;
  /** Number of questions rendered — equals `artifact.questions.length`. */
  questionCount: number;
}

// ---------------------------------------------------------------------------
// Zero-question terminal condition
// ---------------------------------------------------------------------------

/** `error_phase` the caller must record when synthesis yields no questions. */
export const NO_ANCHORED_QUESTIONS_PHASE = "no_anchored_questions";

/**
 * Build the operator-facing message for a zero-question outcome. Exported so the
 * P6 branch and this module report the identical string.
 */
export function buildNoAnchoredQuestionsMessage(artifact: ICQuestionsArtifact): string {
  return (
    `IC Questions produced no anchored questions: ${artifact.rejectedCount} rejected at contract, ` +
    `${artifact.anchorDropCount} anchors dropped at verification.`
  );
}

/**
 * Thrown when the artifact holds no questions.
 *
 * Zero surviving questions is a LEGITIMATE outcome of the module and must be
 * terminal, never published. An earlier revision returned `null` here, which
 * defeated P5.2b: F3's `if (built)` guard would leave `reportOverride` unset,
 * F06 would fall through to its own canonical markdown, and the run would
 * publish a tier-based document containing zero findings and mark itself
 * completed. A deal team reads that as "no hard questions on this deal" — the
 * exact opposite of "synthesis produced nothing verifiable". Throwing makes the
 * outcome loud and unpublishable.
 *
 * The canonical fallback must NEVER be published from the IC-questions path;
 * suppressing this error anywhere upstream reintroduces the defect.
 */
export class ICQuestionsEmptyError extends Error {
  readonly errorPhase = NO_ANCHORED_QUESTIONS_PHASE;
  constructor(message: string) {
    super(message);
    this.name = "ICQuestionsEmptyError";
  }
}

// ---------------------------------------------------------------------------
// P8 disclosure + F4 lines
// ---------------------------------------------------------------------------

/**
 * Build the P8 disclosure paragraphs (and the F4 additions), as an array of
 * paragraphs. The caller wraps them in a blockquote.
 *
 * The exclusion paragraph is load-bearing, not boilerplate: a reader who does
 * not know the CIM and DD reports were withheld would read a thin question set
 * as weak analysis rather than as a faithful reproduction of an IC member's
 * information position.
 */
function buildDisclosureParagraphs(artifact: ICQuestionsArtifact): string[] {
  const coverage = artifact.memoCoverage
    .map((m) => `${m.file_name} (${m.chunks_used} chunks)`)
    .join(", ");

  const paragraphs: string[] = [
    `Generated from ${artifact.memoCoverage.length} IC memo(s): ${coverage}`,

    "Reference material — CIM, Information Memorandum, vendor and legal due " +
      "diligence, consultant reports, and financial models — was deliberately " +
      "excluded. This module reproduces the information available to an IC member, " +
      "who sees only the memo.",

    "Anchors are verbatim spans from the extracted representation of each memo, " +
      `not from the source PDF. ${artifact.rejectedCount} question(s) were rejected for ` +
      `missing or unverifiable anchors. ${artifact.anchorDropCount} anchor(s) were dropped ` +
      "for failing source verification.",
  ];

  // F4 — ordering provenance. Both lines are conditional: emitting them when
  // nothing was derived or fell back would imply a degradation that did not
  // happen.
  if (artifact.rankDerivedCount > 0) {
    paragraphs.push(
      `${artifact.rankDerivedCount} question(s) carried no model-assigned rank; ` +
        "their ordering was derived from emission order.",
    );
  }

  for (const fileName of artifact.orderingFallbackDocs) {
    paragraphs.push(
      `Memo ordering for ${fileName} derived from filename sort; no date parsed.`,
    );
  }

  return paragraphs;
}

/** Render paragraphs as one markdown blockquote (blank lines kept as `>`). */
function asBlockquote(paragraphs: string[]): string {
  return paragraphs
    .map((p) =>
      p
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    )
    .join("\n>\n");
}

// ---------------------------------------------------------------------------
// Question body
// ---------------------------------------------------------------------------

/**
 * Render one question block.
 *
 * `question_type` and `answer_readiness` are emitted as the stored enum values.
 * They are contract vocabulary, and rewriting them into prose here would put a
 * second, undeclared vocabulary in front of the reader that no other surface
 * (DB rows, logs, exports) uses.
 */
function renderQuestion(q: ICQuestion): string {
  const lines: string[] = [
    `### Q${q.rank}. ${q.question}`,
    "",
    `**Why it matters:** ${q.why_it_matters}`,
    "",
    `**Type:** ${q.question_type} · **Answer readiness:** ${q.answer_readiness}`,
    "",
    "**Anchored in:**",
  ];

  // Multiple anchors render as consecutive quote blocks under the single
  // heading, separated by a blank line so each stays its own blockquote.
  const anchorBlocks = q.anchors.map(
    (a) => `> ${a.quote}\n> — ${a.source_doc}, ${a.memo_version}`,
  );
  lines.push(anchorBlocks.join("\n\n"));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// G1 — banned-vocabulary audit
// ---------------------------------------------------------------------------

/**
 * Vocabulary that must not appear in an IC Questions report.
 *
 * Every entry belongs to the canonical/tier-based renderer this module replaces.
 * Their presence would mean the reader is looking at the wrong document, or at a
 * hybrid of the two — which is what G1 exists to detect.
 */
const G1_BANNED_STRINGS = [
  "Diligence Report",
  "Memo Omissions",
  "Diligence Gaps",
  "gap_type",
  "severity",
  "critical",
  "warning",
  "Housekeeping",
  "Human Review Flags",
  "Tier 1",
  "Tier 2",
  "Tier 3",
] as const;

/**
 * Audit the rendered markdown for G1 banned vocabulary and LOG any hits.
 *
 * Deliberately non-fatal. This module's own scaffolding contains none of these
 * strings by construction, so a hit can only come from model-authored text: a
 * question, a `why_it_matters`, the executive header, or a verbatim memo quote.
 * A memo that genuinely says "critical to the investment thesis" would fail a
 * hard gate, and dropping or rewriting that quote would breach the verbatim-anchor
 * guarantee that outranks G1. So the violation is reported loudly for the
 * operator to adjudicate rather than silently suppressed or fatally enforced.
 */
function auditBannedStrings(markdown: string): string[] {
  const haystack = markdown.toLowerCase();
  const hits: string[] = [];

  for (const banned of G1_BANNED_STRINGS) {
    const needle = banned.toLowerCase();
    let count = 0;
    let from = 0;
    while (true) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      count++;
      from = at + needle.length;
    }
    if (count > 0) hits.push(`"${banned}" ×${count}`);
  }

  if (hits.length > 0) {
    console.error(
      `${LOG_PREFIX} G1 AUDIT: rendered report contains banned vocabulary — ${hits.join(", ")}. ` +
      "Source is model-authored text (question, why_it_matters, header, or a verbatim quote); " +
      "not suppressed, because rewriting an anchor quote would breach verbatim fidelity.",
    );
  } else {
    console.log(`${LOG_PREFIX} G1 AUDIT: clean — 0 banned strings in rendered report.`);
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the IC Questions report.
 *
 * @throws {ICQuestionsEmptyError} when the artifact holds no questions. This is
 *         terminal by design — see the class doc. The caller must fail the run
 *         with `error_phase = "no_anchored_questions"` and must NOT fall back to
 *         the canonical renderer.
 */
export function renderICQuestionsReport(
  artifact: ICQuestionsArtifact,
): RenderedICQuestionsReport {
  if (artifact.questions.length === 0) {
    const message = buildNoAnchoredQuestionsMessage(artifact);
    console.error(`${LOG_PREFIX} renderICQuestionsReport: ${message}`);
    throw new ICQuestionsEmptyError(message);
  }

  const sections: string[] = [
    "# IC Questions",
    asBlockquote(buildDisclosureParagraphs(artifact)),
    "## Executive Summary",
    artifact.executiveHeader,
  ];

  // A `---` rule precedes every question and closes the final one, so each
  // question reads as a discrete, self-contained unit.
  for (const q of artifact.questions) {
    sections.push("---");
    sections.push(renderQuestion(q));
  }
  sections.push("---");

  const markdown = sections.join("\n\n");

  auditBannedStrings(markdown);

  console.log(
    `${LOG_PREFIX} renderICQuestionsReport: ${markdown.length} chars, ` +
      `${artifact.questions.length} question(s), ` +
      `${artifact.memoCoverage.length} memo(s), ` +
      `rejected ${artifact.rejectedCount}, anchorDrops ${artifact.anchorDropCount}, ` +
      `rankDerived ${artifact.rankDerivedCount}, ` +
      `orderingFallback ${artifact.orderingFallbackDocs.length}.`,
  );

  return {
    markdown,
    executiveHeader: artifact.executiveHeader,
    questionCount: artifact.questions.length,
  };
}
