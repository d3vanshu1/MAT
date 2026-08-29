/**
 * DCS Report Renderer — pure deterministic rendering functions.
 *
 * DESIGN INVARIANT: this file performs NO I/O. It must not import the
 * database integration, the Anthropic integration, or the Superblocks
 * api helper. It contains only types and pure deterministic functions.
 *
 * No database access.
 * No API registration.
 * No model calls.
 * No logging.
 * No timestamps.
 * No random values.
 * No environment reads.
 */
import { sha256hex } from "./sha256-pure.js";

// ═══════════════════════════════════════════════════════════════════
// 1. Types
// ═══════════════════════════════════════════════════════════════════

export interface DimensionRecord {
  dimension_id: string;
  label: string;
  state: "evidenced" | "asserted" | "absent";
  score_value: number;
  evidence_count: number;
  promoting_chunk_id: string | null;
  promoting_source_file: string | null;
  rationale: string;
  representative_snippet: string | null;
  representative_doc_class: string | null;
  representative_is_substantive: boolean | null;
}

export interface ScorecardInput {
  runId: string;
  provisional: boolean;
  coverageComplete: boolean;
  extractionStatus: string;
  processedChunks: number;
  totalChunks: number;
  evidenceRows: number;
  headlineScore: number;
  evidencedCount: number;
  assertedCount: number;
  absentCount: number;
  dimensions: DimensionRecord[];
}

export interface ScorecardOutput {
  executiveHeader: string;
  fullReportMarkdown: string;
  dimensions: DimensionRecord[];
  reportHash: string;
}

// ═══════════════════════════════════════════════════════════════════
// 2. Helpers
// ═══════════════════════════════════════════════════════════════════

/** Escape Markdown table special characters and collapse newlines to spaces. */
function escapeTableCell(value: string): string {
  return value
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\|/g, "\\|");
}

/** Format score contribution as X.X */
function formatScore(score: number): string {
  return score.toFixed(1);
}

/** Format a number with comma separators */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ═══════════════════════════════════════════════════════════════════
// 3. Section renderers
// ═══════════════════════════════════════════════════════════════════

function renderCoverageNotice(input: ScorecardInput): string {
  if (input.provisional) {
    return (
      `> **PROVISIONAL DEVELOPMENT PREVIEW** — This scorecard is based on ` +
      `${formatNumber(input.processedChunks)} of ${formatNumber(input.totalChunks)} processed chunks. ` +
      `It is not a complete-corpus diligence assessment and must not be presented to the IC.`
    );
  }
  return (
    `> **COMPLETE-CORPUS SCORECARD** — All recorded corpus chunks completed extraction before verdict computation.`
  );
}

function renderOverallScore(input: ScorecardInput): string {
  const lines: string[] = [];
  lines.push(`## Overall Coverage Score`);
  lines.push(``);
  lines.push(`**Headline Score: ${formatScore(input.headlineScore)} / 10**`);
  lines.push(``);
  lines.push(`- **Evidenced:** ${input.evidencedCount} dimension(s)`);
  lines.push(`- **Asserted:** ${input.assertedCount} dimension(s)`);
  lines.push(`- **Absent:** ${input.absentCount} dimension(s)`);
  lines.push(`- **Processed Chunks:** ${formatNumber(input.processedChunks)}`);
  lines.push(`- **Total Chunks:** ${formatNumber(input.totalChunks)}`);
  lines.push(`- **Accepted Evidence Rows:** ${formatNumber(input.evidenceRows)}`);
  return lines.join("\n");
}

function renderDimensionTable(dimensions: DimensionRecord[]): string {
  const lines: string[] = [];
  lines.push(`## Dimension Scorecard`);
  lines.push(``);
  lines.push(`| Dimension | State | Score Contribution | Evidence Rows | Representative Source |`);
  lines.push(`| --- | --- | --- | --- | --- |`);

  for (const dim of dimensions) {
    const label = escapeTableCell(dim.label);
    const stateLabel =
      dim.state === "evidenced" ? "Evidenced" :
      dim.state === "asserted" ? "Asserted" : "Absent";
    const score = formatScore(dim.score_value);
    const evidenceCount = String(dim.evidence_count);
    const source = dim.promoting_source_file
      ? escapeTableCell(dim.promoting_source_file)
      : "—";
    lines.push(`| ${label} | ${stateLabel} | ${score} | ${evidenceCount} | ${source} |`);
  }

  return lines.join("\n");
}

function renderEvidenceBasis(dimensions: DimensionRecord[]): string {
  const lines: string[] = [];
  lines.push(`## Evidence Basis by Dimension`);

  for (const dim of dimensions) {
    const stateLabel =
      dim.state === "evidenced" ? "Evidenced" :
      dim.state === "asserted" ? "Asserted" : "Absent";

    lines.push(``);
    lines.push(`### ${dim.label} — ${stateLabel}`);
    lines.push(``);
    lines.push(`- **Score Contribution:** ${formatScore(dim.score_value)}`);
    lines.push(`- **Evidence Rows:** ${dim.evidence_count}`);
    lines.push(`- **Rationale:** ${dim.rationale}`);

    if (dim.state !== "absent") {
      lines.push(``);
      lines.push(`- **Representative Source File:** ${dim.promoting_source_file}`);
      lines.push(`- **Representative Document Class:** ${dim.representative_doc_class}`);
      lines.push(`- **Representative Chunk ID:** ${dim.promoting_chunk_id}`);
      lines.push(``);
      lines.push(`> ${dim.representative_snippet}`);
    } else {
      lines.push(``);
      lines.push(`No representative evidence row exists.`);
    }
  }

  return lines.join("\n");
}

function renderMethodology(): string {
  const lines: string[] = [];
  lines.push(`## Methodology`);
  lines.push(``);
  lines.push(`- **Absent** — No accepted evidence rows were extracted for this dimension. Score contribution: 0.0.`);
  lines.push(`- **Asserted** — Some accepted coverage exists, but no substantive workproduct evidence was found. Score contribution: 0.5.`);
  lines.push(`- **Evidenced** — At least one substantive workproduct evidence row exists. Score contribution: 1.0.`);
  lines.push(``);
  lines.push(`The headline score is computed equally across ten dimensions as: (sum of score contributions) × 10 / 10.`);
  lines.push(``);
  lines.push(`Document class (narrative or workproduct) comes from stored document tags, not from the scoring model. ` +
    `No language model computes verdicts, scores, or report narrative. All scoring is deterministic and code-computed.`);
  return lines.join("\n");
}

function renderCoverageLimitation(provisional: boolean): string {
  const lines: string[] = [];
  lines.push(`## Coverage Limitation`);
  lines.push(``);

  if (provisional) {
    lines.push(`- Results cover only the processed chunks and do not represent the full corpus.`);
    lines.push(`- Absent states cannot be interpreted as corpus-wide absence.`);
    lines.push(`- This score is for engineering verification only.`);
  } else {
    lines.push(`- This score covers the recorded and processed corpus only.`);
    lines.push(`- It does not prove that the data room itself contained every appropriate diligence document.`);
    lines.push(`- Extracted evidence quality and document tagging remain relevant assumptions.`);
  }

  return lines.join("\n");
}

function buildExecutiveHeader(input: ScorecardInput): string {
  const lines: string[] = [];
  lines.push(`Diligence Completeness Score: ${formatScore(input.headlineScore)}/10`);
  lines.push(`Distribution: ${input.evidencedCount} Evidenced, ${input.assertedCount} Asserted, ${input.absentCount} Absent`);
  lines.push(`Corpus: ${formatNumber(input.processedChunks)}/${formatNumber(input.totalChunks)} chunks processed`);
  lines.push(`Evidence Rows: ${formatNumber(input.evidenceRows)}`);
  lines.push(`Status: ${input.provisional ? "Provisional (development preview)" : "Complete-corpus scorecard"}`);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// 4. Primary export — renderDcsScorecard
// ═══════════════════════════════════════════════════════════════════

export function renderDcsScorecard(input: ScorecardInput): ScorecardOutput {
  const executiveHeader = buildExecutiveHeader(input);

  const sections = [
    `# Diligence Completeness Scorecard`,
    ``,
    renderCoverageNotice(input),
    ``,
    renderOverallScore(input),
    ``,
    renderDimensionTable(input.dimensions),
    ``,
    renderEvidenceBasis(input.dimensions),
    ``,
    renderMethodology(),
    ``,
    renderCoverageLimitation(input.provisional),
  ];

  const fullReportMarkdown = sections.join("\n");

  const reportHash = "sha256-v1:" + sha256hex(fullReportMarkdown);

  return {
    executiveHeader,
    fullReportMarkdown,
    dimensions: input.dimensions,
    reportHash,
  };
}
