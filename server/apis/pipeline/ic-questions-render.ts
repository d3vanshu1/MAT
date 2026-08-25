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
 * The single exception is an artifact with ZERO questions: there is no honest
 * report to publish, so the renderer returns `null` and the caller (F3) leaves
 * `reportOverride` unset rather than publishing an empty section.
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
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render the IC Questions report.
 *
 * @returns The markdown, header, and count — or `null` when the artifact holds
 *          no questions, in which case there is nothing honest to publish.
 */
export function renderICQuestionsReport(
  artifact: ICQuestionsArtifact,
): RenderedICQuestionsReport | null {
  if (artifact.questions.length === 0) {
    console.error(
      `${LOG_PREFIX} renderICQuestionsReport: artifact holds 0 questions ` +
        `(rejected ${artifact.rejectedCount}, anchorDrops ${artifact.anchorDropCount}) — ` +
        "returning null; no report override will be published.",
    );
    return null;
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
