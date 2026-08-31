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
import type {
  Citation,
  DimensionRationale,
} from "./dcs-dimension-rationale-validator.js";

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
  materialityOverlay: string | null;
}

export interface ScorecardOutput {
  executiveHeader: string;
  fullReportMarkdown: string;
  dimensions: DimensionRecord[];
  reportHash: string;
  materialityOverlayIncluded: boolean;
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

function renderMaterialityOverlay(overlay: string | null): string | null {
  if (overlay === null) {
    return null;
  }
  const lines: string[] = [];
  lines.push(`## Materiality Overlay`);
  lines.push(``);
  lines.push(`This qualitative commentary is generated separately and cannot alter the deterministic results above.`);
  lines.push(``);
  lines.push(overlay);
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
    ...(renderMaterialityOverlay(input.materialityOverlay) !== null
      ? [``, renderMaterialityOverlay(input.materialityOverlay)!]
      : []),
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
    materialityOverlayIncluded: input.materialityOverlay !== null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 5. Report V2 — IC-facing grounded report
// ═══════════════════════════════════════════════════════════════════

// ── V2 types ─────────────────────────────────────────────────────

export interface CorpusScopeInput {
  includedDocuments: Array<{ fileName: string; documentTag: string }>;
  excludedDocuments: Array<{ fileName: string; reason: string }>;
  processedChunks: number;
  totalChunks: number;
  extractionComplete: boolean;
  reportGeneratedAt: string;
}

export interface ReportV2Input {
  runId: string;
  rationales: DimensionRationale[];
  corpus: CorpusScopeInput;
  provisional: boolean;
}

export interface CoverageOverviewEntry {
  dimension: string;
  coverage: string;
  depth: string;
  principalLimitation: string;
}

export interface PriorityGapEntry {
  dimension: string;
  coverage: string;
  gap: string;
  icImplication: string;
  basis: string;
}

export interface ReportV2Output {
  executiveHeader: string;
  fullReportMarkdown: string;
  reportHash: string;
  coverageOverview: CoverageOverviewEntry[];
  priorityGaps: PriorityGapEntry[];
  corpusScopeDisplay: {
    includedCount: number;
    excludedCount: number;
    extractionComplete: boolean;
  };
}

// ── V2 display label maps ────────────────────────────────────────

const COVERAGE_DISPLAY: Record<string, string> = {
  independent_workproduct: "Independent workproduct",
  narrative_only: "Narrative only",
  not_established: "Not established",
};

const DEPTH_DISPLAY: Record<string, string> = {
  strong: "Strong",
  moderate: "Moderate",
  limited: "Limited",
};

/** Canonical dimension rendering order. */
const DIMENSION_ORDER: string[] = [
  "commercial",
  "financial_qoe",
  "customer",
  "competitive",
  "operational",
  "technology_product",
  "management",
  "legal_regulatory",
  "esg_reputational",
  "exit",
];

// ── V2 citation helpers ──────────────────────────────────────────

/** Shorten a source filename for inline citation labels. */
function abbreviateSource(sourceFile: string): string {
  let name = sourceFile;
  // Remove extension
  name = name.replace(/\.(pdf|xlsx|docx|csv|txt|pptx|xlsm)$/i, "");
  // Remove trailing underscores
  name = name.replace(/_+$/, "");
  // Remove leading date prefix: "09 04 2026 " or "2026-06-15 "
  name = name.replace(/^\d{1,2}\s+\d{1,2}\s+\d{4}\s+/, "");
  name = name.replace(/^\d{4}-\d{2}-\d{2}\s+/, "");
  // Remove common project prefixes
  name = name.replace(/^(?:SCG\s*[-–—]\s*)?(?:Project\s+Saint\s*[-–—]\s*)?/i, "");
  // Remove version suffixes: _vS, _vFinal Report, _vF, vF, vS at end
  name = name.replace(/\s*[-–—]\s*Updated\s+for\s+.*$/i, " (CT Update)");
  name = name.replace(/_v\w+.*$/i, "");
  name = name.replace(/\s+v[A-Z]\b.*$/i, "");
  // Clean trailing/leading dashes and whitespace
  name = name.replace(/\s*[-–—]\s*$/, "").trim();
  if (!name) return sourceFile;
  return name;
}

/** Build a map from evidenceId → Citation for a single rationale. */
function buildCitationMap(rationale: DimensionRationale): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const c of rationale.citations) {
    map.set(c.evidenceId, c);
  }
  return map;
}

/**
 * Render inline citations for a list of citationIds.
 * Groups by source file and merges locations.
 * Returns empty string if no valid citations.
 */
function renderInlineCitations(
  citationIds: string[],
  citMap: Map<string, Citation>,
): string {
  if (citationIds.length === 0) return "";

  const resolved = citationIds
    .map((id) => citMap.get(id))
    .filter((c): c is Citation => c !== undefined);
  if (resolved.length === 0) return "";

  // Group by sourceFile, preserving encounter order
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const c of resolved) {
    const key = c.sourceFile;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    if (c.humanLocation && !groups.get(key)!.includes(c.humanLocation)) {
      groups.get(key)!.push(c.humanLocation);
    }
  }

  const parts: string[] = [];
  for (const file of order) {
    const short = abbreviateSource(file);
    const locs = groups.get(file)!;
    if (locs.length === 0) {
      parts.push(`[${short}]`);
    } else if (locs.length === 1) {
      parts.push(`[${short}, ${locs[0]}]`);
    } else {
      parts.push(`[${short}, ${locs.join(" and ")}]`);
    }
  }

  return " " + parts.join(" ");
}

// ── V2 validation gates ──────────────────────────────────────────

/**
 * Validate that the rationale set is complete and render-ready.
 * Throws on failure — caller must not render with invalid input.
 */
function validateReportV2Input(input: ReportV2Input): void {
  const { rationales } = input;

  // Gate 11: exactly 10 unique dimensions
  if (rationales.length !== 10) {
    throw new Error(
      `Report-v2 render rejected: expected 10 rationales, got ${rationales.length}`,
    );
  }
  const dimIds = new Set(rationales.map((r) => r.dimensionId));
  // Gate 12: no duplicate dimensions
  if (dimIds.size !== 10) {
    throw new Error(
      `Report-v2 render rejected: duplicate dimension IDs detected`,
    );
  }

  for (const r of rationales) {
    const vm = r.validationMetadata;
    // Gate 13: no unsupported/degraded rationale
    if (
      !vm.schemaValidated ||
      !vm.citationsValidated ||
      !vm.numbersValidated ||
      !vm.supportVerified
    ) {
      throw new Error(
        `Report-v2 render rejected: dimension ${r.dimensionId} has incomplete validation: ` +
        `schema=${vm.schemaValidated} citations=${vm.citationsValidated} ` +
        `numbers=${vm.numbersValidated} support=${vm.supportVerified}`,
      );
    }

    // Gate 14: every positive claim must have readable citations
    const citMap = buildCitationMap(r);
    for (const ep of r.establishedPoints) {
      if (ep.citationIds.length === 0) {
        throw new Error(
          `Report-v2 render rejected: established point "${ep.text.slice(0, 60)}…" ` +
          `in dimension ${r.dimensionId} has no citations`,
        );
      }
      for (const cid of ep.citationIds) {
        const cit = citMap.get(cid);
        if (!cit || !cit.sourceFile) {
          throw new Error(
            `Report-v2 render rejected: established point in ${r.dimensionId} ` +
            `references citation ${cid} with no readable location`,
          );
        }
      }
    }

    // IC implication citations — allowed to have zero for inference-based implications
    if (r.whyStatus.citationIds.length > 0) {
      for (const cid of r.whyStatus.citationIds) {
        const cit = citMap.get(cid);
        if (!cit || !cit.sourceFile) {
          throw new Error(
            `Report-v2 render rejected: whyStatus in ${r.dimensionId} ` +
            `references citation ${cid} with no readable location`,
          );
        }
      }
    }
  }
}

// ── V2 section renderers ─────────────────────────────────────────

function renderV2Title(input: ReportV2Input): string {
  const status = input.provisional
    ? "PROVISIONAL DEVELOPMENT PREVIEW"
    : "Complete-corpus assessment";
  return [
    `# Diligence Completeness Assessment`,
    ``,
    `> **${status}** — Generated ${input.corpus.reportGeneratedAt}.`,
  ].join("\n");
}

function buildV2ExecutiveConclusion(rationales: DimensionRationale[]): string {
  const sorted = sortByCanonicalOrder(rationales);
  const iwCount = sorted.filter(
    (r) => r.coverageLabel === "independent_workproduct",
  ).length;
  const narrativeOnly = sorted.filter(
    (r) => r.coverageLabel === "narrative_only",
  );
  const notEstablished = sorted.filter(
    (r) => r.coverageLabel === "not_established",
  );

  const lines: string[] = [];
  lines.push(`## Executive Conclusion`);
  lines.push(``);

  // Primary headline
  lines.push(
    `Independent workproduct identified for ${iwCount} of 10 dimensions.`,
  );

  // Name narrative-only dimensions
  if (narrativeOnly.length > 0) {
    for (const r of narrativeOnly) {
      lines.push(
        `${r.label} is supported by IC narrative, but independent ${r.dimensionId.replace(/_/g, " ")} workproduct was not established in the supplied corpus.`,
      );
    }
  }

  // Name not-established dimensions
  if (notEstablished.length > 0) {
    for (const r of notEstablished) {
      lines.push(
        `${r.label} was not established in the processed corpus.`,
      );
    }
  }

  lines.push(``);

  // Top priority gaps (2-3)
  const topGaps = selectPriorityGaps(sorted).slice(0, 3);
  if (topGaps.length > 0) {
    lines.push(`**Highest-priority diligence gaps:**`);
    lines.push(``);
    for (const g of topGaps) {
      lines.push(`- **${g.dimension}** (${g.coverage}): ${g.gap}`);
    }
    lines.push(``);
  }

  lines.push(
    `Evidence coverage for a dimension does not mean the underlying risks are resolved or that diligence is comprehensive.`,
  );

  return lines.join("\n");
}

function buildV2CoverageOverview(
  rationales: DimensionRationale[],
): { markdown: string; entries: CoverageOverviewEntry[] } {
  const sorted = sortByCanonicalOrder(rationales);
  const entries: CoverageOverviewEntry[] = [];

  const lines: string[] = [];
  lines.push(`## Coverage Overview`);
  lines.push(``);
  lines.push(
    `| Dimension | Coverage | Depth | Principal Limitation |`,
  );
  lines.push(`| --- | --- | --- | --- |`);

  for (const r of sorted) {
    const coverage = COVERAGE_DISPLAY[r.coverageLabel] ?? r.coverageLabel;
    const depth = DEPTH_DISPLAY[r.coverageDepth] ?? r.coverageDepth;
    const limitation =
      r.remainingGaps.length > 0
        ? escapeTableCell(r.remainingGaps[0].text)
        : "—";

    entries.push({
      dimension: r.label,
      coverage,
      depth,
      principalLimitation:
        r.remainingGaps.length > 0 ? r.remainingGaps[0].text : "—",
    });

    lines.push(
      `| ${escapeTableCell(r.label)} | ${coverage} | ${depth} | ${limitation} |`,
    );
  }

  return { markdown: lines.join("\n"), entries };
}

function selectPriorityGaps(
  rationales: DimensionRationale[],
): PriorityGapEntry[] {
  const candidates: Array<{
    rationale: DimensionRationale;
    priority: number;
  }> = [];

  for (const r of rationales) {
    if (r.remainingGaps.length === 0) continue;

    let priority: number;
    if (r.coverageLabel === "narrative_only") priority = 1;
    else if (r.coverageLabel === "not_established") priority = 2;
    else if (
      r.coverageLabel === "independent_workproduct" &&
      r.coverageDepth === "limited"
    )
      priority = 3;
    else if (
      r.coverageLabel === "independent_workproduct" &&
      r.coverageDepth === "moderate"
    )
      priority = 4;
    else if (
      r.coverageLabel === "independent_workproduct" &&
      r.coverageDepth === "strong"
    )
      priority = 5;
    else continue;

    candidates.push({ rationale: r, priority });
  }

  // Stable sort: by priority, then by canonical dimension order
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (
      DIMENSION_ORDER.indexOf(a.rationale.dimensionId) -
      DIMENSION_ORDER.indexOf(b.rationale.dimensionId)
    );
  });

  return candidates.slice(0, 5).map((c) => {
    const r = c.rationale;
    const gap = r.remainingGaps[0];
    const citMap = buildCitationMap(r);
    const coverage = COVERAGE_DISPLAY[r.coverageLabel] ?? r.coverageLabel;

    let basis: string;
    if (gap.citationIds.length > 0) {
      basis = renderInlineCitations(gap.citationIds, citMap).trim();
    } else if (
      gap.basisType === "scope_note" ||
      gap.basisType === "evidence_limitation"
    ) {
      basis = "Not established in the supplied corpus";
    } else {
      basis = "Not established in the supplied corpus";
    }

    return {
      dimension: r.label,
      coverage,
      gap: gap.text,
      icImplication: r.icImplication.text,
      basis,
    };
  });
}

function buildV2PriorityGaps(
  rationales: DimensionRationale[],
): { markdown: string; entries: PriorityGapEntry[] } {
  const entries = selectPriorityGaps(rationales);

  const lines: string[] = [];
  lines.push(`## Highest-Priority Diligence Gaps`);

  if (entries.length === 0) {
    lines.push(``);
    lines.push(`No significant diligence gaps identified.`);
    return { markdown: lines.join("\n"), entries };
  }

  for (let i = 0; i < entries.length; i++) {
    const g = entries[i];
    lines.push(``);
    lines.push(`### ${i + 1}. ${g.dimension} — ${g.coverage}`);
    lines.push(``);
    lines.push(`**Gap:** ${g.gap}`);
    lines.push(``);
    lines.push(`**IC Implication:** ${g.icImplication}`);
    lines.push(``);
    lines.push(`**Basis:** ${g.basis}`);
  }

  return { markdown: lines.join("\n"), entries };
}

function buildV2DimensionAssessments(
  rationales: DimensionRationale[],
): string {
  const sorted = sortByCanonicalOrder(rationales);
  const lines: string[] = [];
  lines.push(`## Dimension Assessments`);

  for (const r of sorted) {
    const coverage = COVERAGE_DISPLAY[r.coverageLabel] ?? r.coverageLabel;
    const depth = DEPTH_DISPLAY[r.coverageDepth] ?? r.coverageDepth;
    const citMap = buildCitationMap(r);

    lines.push(``);
    lines.push(`### ${r.label} — ${coverage}`);
    lines.push(``);
    lines.push(`**Depth:** ${depth}`);
    lines.push(``);

    // Why this status
    lines.push(
      `**Why this status:** ${r.whyStatus.text}${renderInlineCitations(r.whyStatus.citationIds, citMap)}`,
    );
    lines.push(``);

    // What the evidence establishes
    if (r.establishedPoints.length > 0) {
      lines.push(`**What the evidence establishes:**`);
      lines.push(``);
      for (const ep of r.establishedPoints) {
        lines.push(
          `- ${ep.text}${renderInlineCitations(ep.citationIds, citMap)}`,
        );
      }
      lines.push(``);
    }

    // Remaining gaps
    if (r.remainingGaps.length > 0) {
      lines.push(`**Remaining gaps:**`);
      lines.push(``);
      for (const gap of r.remainingGaps) {
        if (gap.citationIds.length > 0) {
          lines.push(
            `- ${gap.text}${renderInlineCitations(gap.citationIds, citMap)}`,
          );
        } else {
          lines.push(
            `- ${gap.text} — not established in the supplied corpus`,
          );
        }
      }
      lines.push(``);
    }

    // IC Implication
    lines.push(
      `**IC Implication:** ${r.icImplication.text}${renderInlineCitations(r.icImplication.citationIds, citMap)}`,
    );

    // Question assessments summary
    if (r.questionAssessments.length > 0) {
      const established = r.questionAssessments.filter(
        (q) => q.status === "established",
      ).length;
      const partial = r.questionAssessments.filter(
        (q) => q.status === "partial",
      ).length;
      const notEst = r.questionAssessments.filter(
        (q) => q.status === "not_established",
      ).length;
      lines.push(``);
      lines.push(
        `*Coverage questions: ${established} established, ${partial} partial, ${notEst} not established.*`,
      );
    }
  }

  return lines.join("\n");
}

function buildV2CorpusScope(corpus: CorpusScopeInput): string {
  const lines: string[] = [];
  lines.push(`## Corpus Scope and Limitations`);
  lines.push(``);
  lines.push(
    `This report covers the ${corpus.includedDocuments.length}-document production-indexed corpus.`,
  );
  lines.push(``);

  // Included documents
  lines.push(`**Included documents:**`);
  lines.push(``);
  for (const doc of corpus.includedDocuments) {
    lines.push(`- ${doc.fileName}`);
  }
  lines.push(``);

  // Excluded documents
  if (corpus.excludedDocuments.length > 0) {
    lines.push(`**Documents not included in the production-indexed corpus:**`);
    lines.push(``);
    for (const doc of corpus.excludedDocuments) {
      lines.push(`- ${doc.fileName} — ${doc.reason}`);
    }
    lines.push(``);
    lines.push(
      `The above document(s) were not included in the production-indexed corpus. ` +
        `Do not interpret this report as having analyzed those materials.`,
    );
    lines.push(``);
  }

  // Extraction completion
  const extractLabel = corpus.extractionComplete
    ? `${formatNumber(corpus.processedChunks)}/${formatNumber(corpus.totalChunks)} chunks processed (complete).`
    : `${formatNumber(corpus.processedChunks)}/${formatNumber(corpus.totalChunks)} chunks processed (incomplete).`;
  lines.push(`**Extraction completion:** ${extractLabel}`);
  lines.push(``);
  lines.push(`**Report generated:** ${corpus.reportGeneratedAt}`);
  lines.push(``);
  lines.push(
    `"Complete corpus" means all chunks from the production-indexed documents were processed through extraction. ` +
      `It does not guarantee that every relevant diligence document has been supplied to the data room.`,
  );

  return lines.join("\n");
}

function buildV2Methodology(): string {
  return [
    `## Methodology`,
    ``,
    `- **Independent workproduct**: Qualifying analytical or third-party workproduct supports the dimension.`,
    `- **Narrative only**: The subject appears in IC/management narrative without qualifying independent workproduct.`,
    `- **Not established**: Accepted evidence was not identified in the processed corpus.`,
    `- **Depth** describes the breadth of supported coverage questions and is non-scoring.`,
    `- Coverage does not prove risks are resolved or diligence is comprehensive.`,
    `- Verdicts are deterministic and code-computed from extracted evidence attributes.`,
    `- Rationales are model-assisted, citation-constrained, and support-verified against source evidence.`,
    `- Rendering is deterministic from persisted validated inputs.`,
  ].join("\n");
}

function buildV2SourceAppendix(rationales: DimensionRationale[]): string {
  // Collect all unique citations across all rationales
  const seen = new Set<string>();
  const allCitations: Array<{
    sourceFile: string;
    humanLocation: string;
    docClass: string;
    exactSnippet: string;
  }> = [];

  const sorted = sortByCanonicalOrder(rationales);
  for (const r of sorted) {
    for (const c of r.citations) {
      const key = `${c.sourceFile}|${c.humanLocation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allCitations.push({
        sourceFile: c.sourceFile,
        humanLocation: c.humanLocation,
        docClass: c.docClass,
        exactSnippet: c.exactSnippet,
      });
    }
  }

  // Sort by sourceFile then humanLocation for determinism
  allCitations.sort((a, b) => {
    const fileCmp = a.sourceFile.localeCompare(b.sourceFile);
    if (fileCmp !== 0) return fileCmp;
    return a.humanLocation.localeCompare(b.humanLocation);
  });

  const lines: string[] = [];
  lines.push(`## Source and Location Appendix`);
  lines.push(``);
  lines.push(`| # | Source File | Location | Class |`);
  lines.push(`| --- | --- | --- | --- |`);

  for (let i = 0; i < allCitations.length; i++) {
    const c = allCitations[i];
    lines.push(
      `| ${i + 1} | ${escapeTableCell(c.sourceFile)} | ${escapeTableCell(c.humanLocation)} | ${escapeTableCell(c.docClass)} |`,
    );
  }

  // Evidence snippets
  lines.push(``);
  lines.push(`### Evidence Snippets`);

  // Group by sourceFile
  const byFile = new Map<string, typeof allCitations>();
  for (const c of allCitations) {
    if (!byFile.has(c.sourceFile)) byFile.set(c.sourceFile, []);
    byFile.get(c.sourceFile)!.push(c);
  }

  for (const [file, citations] of byFile) {
    lines.push(``);
    lines.push(`**${abbreviateSource(file)}** (${file}):`);
    for (const c of citations) {
      if (c.exactSnippet) {
        lines.push(``);
        lines.push(`*${c.humanLocation}:*`);
        lines.push(`> ${c.exactSnippet.replace(/\n/g, " ")}`);
      }
    }
  }

  return lines.join("\n");
}

// ── V2 helpers ───────────────────────────────────────────────────

function sortByCanonicalOrder(
  rationales: DimensionRationale[],
): DimensionRationale[] {
  return [...rationales].sort(
    (a, b) =>
      DIMENSION_ORDER.indexOf(a.dimensionId) -
      DIMENSION_ORDER.indexOf(b.dimensionId),
  );
}

// ── V2 primary export ────────────────────────────────────────────

export function renderDcsReportV2(input: ReportV2Input): ReportV2Output {
  // Run all validation gates — throws on failure
  validateReportV2Input(input);

  const { rationales, corpus } = input;

  const sorted = sortByCanonicalOrder(rationales);
  const iwCount = sorted.filter(
    (r) => r.coverageLabel === "independent_workproduct",
  ).length;
  const narrativeOnly = sorted.filter(
    (r) => r.coverageLabel === "narrative_only",
  );
  const notEstablished = sorted.filter(
    (r) => r.coverageLabel === "not_established",
  );

  // Build executive header (short, for module_outputs.executive_header)
  const headerParts: string[] = [];
  headerParts.push(
    `Independent workproduct identified for ${iwCount} of 10 dimensions.`,
  );
  if (narrativeOnly.length > 0) {
    headerParts.push(
      `Narrative only: ${narrativeOnly.map((r) => r.label).join(", ")}.`,
    );
  }
  if (notEstablished.length > 0) {
    headerParts.push(
      `Not established: ${notEstablished.map((r) => r.label).join(", ")}.`,
    );
  }
  const executiveHeader = headerParts.join(" ");

  // Build all report sections
  const title = renderV2Title(input);
  const execConclusion = buildV2ExecutiveConclusion(rationales);
  const { markdown: coverageMd, entries: coverageEntries } =
    buildV2CoverageOverview(rationales);
  const { markdown: gapsMd, entries: gapEntries } =
    buildV2PriorityGaps(rationales);
  const assessments = buildV2DimensionAssessments(rationales);
  const corpusScope = buildV2CorpusScope(corpus);
  const methodology = buildV2Methodology();
  const appendix = buildV2SourceAppendix(rationales);

  // Assemble — order matches spec exactly
  const sections = [
    title,
    ``,
    execConclusion,
    ``,
    coverageMd,
    ``,
    gapsMd,
    ``,
    assessments,
    ``,
    corpusScope,
    ``,
    methodology,
    ``,
    appendix,
  ];

  const fullReportMarkdown = sections.join("\n");
  const reportHash = "sha256-v1:" + sha256hex(fullReportMarkdown);

  return {
    executiveHeader,
    fullReportMarkdown,
    reportHash,
    coverageOverview: coverageEntries,
    priorityGaps: gapEntries,
    corpusScopeDisplay: {
      includedCount: corpus.includedDocuments.length,
      excludedCount: corpus.excludedDocuments.length,
      extractionComplete: corpus.extractionComplete,
    },
  };
}
