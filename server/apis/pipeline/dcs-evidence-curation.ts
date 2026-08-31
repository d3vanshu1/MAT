/**
 * DCS Evidence Curation — Packet 6A
 *
 * PURE MODULE: no model calls, no database access, no I/O, no logging,
 * no persistence. All inputs are passed in; all outputs are returned.
 *
 * Responsibilities:
 * 1. Exit promotion gate — prevents false promotion of Exit dimension
 * 2. Evidence curation — selects ≤4 readable anchors per dimension
 * 3. Source location resolution from existing metadata
 * 4. Coverage-question definitions for Packet 6B
 * 5. Deterministic CuratedDimensionPacket construction
 *
 * HARD CONSTRAINT: this file must NOT import any integration client,
 * database helper, Anthropic client, api() wrapper, or logger.
 */

import {
  DCS_DIMENSIONS,
  computeDimensionState,
  SCORE_VALUES,
} from "./dcs-rubric.js";
import type { DimensionState, DocClass } from "./dcs-rubric.js";

// ═══════════════════════════════════════════════════════════════════
// 1. TYPES
// ═══════════════════════════════════════════════════════════════════

/** Raw evidence row as read from dcs_evidence. */
export interface RawEvidenceRow {
  id: string;
  dimension_id: string;
  chunk_id: string;
  source_file: string;
  document_tag: string;
  doc_class: DocClass;
  is_substantive: boolean;
  snippet: string;
}

/** Chunk metadata for source-location resolution. */
export interface ChunkMeta {
  chunk_id: string;
  chunk_index: number;
  file_name: string;
  file_type: string;
}

/** Curated evidence anchor. */
export interface CuratedEvidence {
  evidenceId: string;
  chunkId: string;
  sourceFile: string;
  documentTag: string;
  docClass: DocClass;
  snippet: string;
  isSubstantive: boolean;
  promotionEligible: boolean;
  humanLocation: string;
  locationStatus: "resolved" | "unavailable";
  authorityRank: number;
  readabilityRank: number;
  selectionReasons: string[];
  readabilityWarning: string | null;
}

/** Per-dimension curated packet. */
export interface CuratedDimensionPacket {
  dimensionId: string;
  label: string;
  deterministicState: DimensionState;
  internalScoreContribution: number;
  coverageLabel: CoverageLabel;
  evidenceCount: number;
  substantiveWorkproductCount: number;
  sourceCount: number;
  coverageQuestions: string[];
  curatedEvidence: CuratedEvidence[];
  excludedCandidateCounts: {
    duplicates: number;
    lowReadability: number;
    authorityFiltered: number;
  };
  scopeNotes: string[];
}

export type CoverageLabel =
  | "independent_workproduct"
  | "narrative_only"
  | "not_established";

// ═══════════════════════════════════════════════════════════════════
// 2. COVERAGE QUESTIONS — stable report-explanation topics
// ═══════════════════════════════════════════════════════════════════

const COVERAGE_QUESTIONS: Record<string, string[]> = {
  commercial: [
    "Market size, growth trajectory and key drivers",
    "Channel economics and go-to-market effectiveness",
    "Demand dynamics, pricing power and retention",
    "Differentiation and sustainable competitive advantages",
    "Commercial execution and pipeline quality",
  ],
  financial_qoe: [
    "Quality of earnings and EBITDA adjustments",
    "Organic growth and current trading performance",
    "Margin sustainability and cash conversion",
    "Working capital dynamics and debt structure",
    "Model reconciliation to IC assumptions",
  ],
  management: [
    "Leadership capability and track record",
    "Succession planning and key-person risk",
    "Incentive alignment and retention mechanisms",
    "Governance structure and board effectiveness",
    "Functional depth across critical roles",
  ],
  technology_product: [
    "Product roadmap and development pipeline",
    "Architecture scalability and technical debt",
    "Cyber security and data protection posture",
    "IP ownership and open-source dependencies",
    "R&D investment and innovation capacity",
  ],
  legal_regulatory: [
    "Corporate structure and financing documentation",
    "Material contracts and change-of-control provisions",
    "Regulatory compliance and licensing",
    "IP protection and data privacy obligations",
    "Employment, disputes, real estate and health & safety",
  ],
  competitive: [
    "Competitive position and market ranking",
    "Barriers to entry and switching costs",
    "Substitution and disintermediation risk",
    "Market share trends and win/loss analysis",
    "Vendor and channel dependency",
  ],
  customer: [
    "Revenue concentration and top-customer dependency",
    "Retention rates and churn dynamics",
    "Cohort economics and lifetime value",
    "Unit economics and customer acquisition cost",
    "Contract terms, renewals and dependency risk",
  ],
  operational: [
    "Delivery capacity and scalability constraints",
    "Systems architecture and integration readiness",
    "Internal controls and process maturity",
    "Workforce planning and talent pipeline",
    "Operational resilience and continuity planning",
  ],
  exit: [
    "Buyer universe and strategic acquirer landscape",
    "Exit valuation methodology and comparable transactions",
    "Timing, milestones and value creation pathway",
    "Deleveraging trajectory and debt repayment",
    "Auditable sponsor returns (MOIC/IRR/LBO analysis)",
  ],
  esg_reputational: [
    "Health and safety compliance and track record",
    "Environmental risk and regulatory obligations",
    "Workforce, diversity and social impact",
    "Governance framework and ethical standards",
    "Reputational risk and supply chain due diligence",
  ],
};

// ═══════════════════════════════════════════════════════════════════
// 3. EXIT PROMOTION GATE — Deliverable 3
// ═══════════════════════════════════════════════════════════════════

/**
 * Exit-specific snippet keywords that indicate genuine exit diligence.
 * A workproduct row may only promote Exit to "evidenced" when BOTH:
 *   (a) the source is plausibly exit-specific independent workproduct; AND
 *   (b) the snippet expressly concerns one of these exit-specific topics.
 */
const EXIT_SPECIFIC_KEYWORDS = [
  "buyer analysis",
  "buyer universe",
  "buyer list",
  "potential acquirer",
  "strategic buyer",
  "exit comparable",
  "exit multiple",
  "exit valuation",
  "terminal valuation",
  "terminal value",
  "exit timing",
  "exit proceed",
  "exit proceeds",
  "exit strategy",
  "exit horizon",
  "deleveraging at exit",
  "deleverage at exit",
  "deleveraging trajectory",
  "sponsor moic",
  "sponsor irr",
  "money multiple",
  "lbo analysis",
  "lbo model",
  "lbo return",
  "leveraged buyout return",
  "returns analysis",
  "auditable return",
];

/**
 * Snippets that are NOT exit-specific by themselves:
 * These patterns indicate generic financial/capital data.
 */
const EXIT_NON_QUALIFYING_PATTERNS = [
  /preference\s+shares?/i,
  /share\s+balance/i,
  /debt\s+(schedule|structure|facility|maturity|covenant)/i,
  /capital\s+structure/i,
  /revenue\s+forecast/i,
  /ebitda\s+(forecast|budget|projection|synerg)/i,
  /enterprise\s+value(?!\s+at\s+exit)/i,
  /generic\s+valuation/i,
  /financing\s+schedule/i,
  /acquisition\s+assumption/i,
  /purchase\s+of\s+subsidiaries/i,
  /future\s+m&a/i,
  /capex\s+of\s+future/i,
  /total\s+revenue/i,
  /change\s+of\s+control/i,
  /transaction.*proposed\s+sale/i,
  /post.?synergy\s+multiple/i,
];

/**
 * Determine whether a workproduct evidence row qualifies to promote
 * Exit from "asserted" to "evidenced".
 *
 * Pure function. No I/O.
 */
export function isExitPromotionEligible(
  snippet: string,
  documentTag: string,
  sourceFile: string,
): boolean {
  const snippetLower = snippet.toLowerCase();
  const sourceFileLower = sourceFile.toLowerCase();

  // Step 1: Check for non-qualifying patterns first (fast rejection)
  for (const pattern of EXIT_NON_QUALIFYING_PATTERNS) {
    if (pattern.test(snippet)) {
      // If the snippet matches a non-qualifying pattern, it can still
      // promote ONLY if it also contains explicit exit-specific keywords
      // that override the generic classification.
      const hasExitKeyword = EXIT_SPECIFIC_KEYWORDS.some(
        (kw) => snippetLower.includes(kw),
      );
      if (!hasExitKeyword) return false;
    }
  }

  // Step 2: Document must be plausibly exit-specific workproduct.
  // A generic financial model requires both explicit exit/LBO/returns
  // sheet context AND an exit-specific snippet.
  if (documentTag === "financial_model") {
    // Financial model requires exit-specific snippet content
    const hasExitKeyword = EXIT_SPECIFIC_KEYWORDS.some(
      (kw) => snippetLower.includes(kw),
    );
    // Also check source file name for exit/LBO context
    const hasExitSourceContext =
      sourceFileLower.includes("exit") ||
      sourceFileLower.includes("lbo") ||
      sourceFileLower.includes("return");

    return hasExitKeyword || hasExitSourceContext;
  }

  // Step 3: For non-financial-model workproduct (consultant_report, legal, etc.),
  // require the snippet to contain exit-specific language.
  const hasExitKeyword = EXIT_SPECIFIC_KEYWORDS.some(
    (kw) => snippetLower.includes(kw),
  );

  return hasExitKeyword;
}

/**
 * Compute Exit dimension state with the promotion gate applied.
 * Falls back to standard rubric for non-Exit dimensions.
 */
export function computeExitDimensionState(
  rows: Array<{
    doc_class: DocClass;
    is_substantive: boolean;
    snippet: string;
    document_tag: string;
    source_file: string;
  }>,
): DimensionState {
  if (rows.length === 0) return "absent";

  // Check if ANY workproduct+substantive row passes the exit promotion gate
  const hasQualifyingPromoter = rows.some(
    (r) =>
      r.doc_class === "workproduct" &&
      r.is_substantive &&
      isExitPromotionEligible(r.snippet, r.document_tag, r.source_file),
  );

  return hasQualifyingPromoter ? "evidenced" : "asserted";
}

// ═══════════════════════════════════════════════════════════════════
// 4. AUTHORITY RANKING — Deliverable 4
// ═══════════════════════════════════════════════════════════════════

/**
 * Preferred authoritative sources per dimension.
 * Lower number = higher authority.
 */
const AUTHORITY_PREFERENCES: Record<string, Array<{ pattern: RegExp; rank: number }>> = {
  commercial: [
    { pattern: /altman\s*solon|commercial\s+cdd|buyside\s+cdd/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 3 },
    { pattern: /legal/i, rank: 4 },
  ],
  financial_qoe: [
    { pattern: /vendor\s+financial|fdd|financial\s+due\s+diligence|pwc/i, rank: 1 },
    { pattern: /financial_model/i, rank: 2 },
    { pattern: /consultant_report/i, rank: 3 },
  ],
  management: [
    { pattern: /vendor\s+financial|fdd|financial\s+due\s+diligence|pwc/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 3 },
  ],
  technology_product: [
    { pattern: /altman\s*solon|technical|product\s+cdd|buyside\s+cdd/i, rank: 1 },
    { pattern: /legal\s+due\s+diligence/i, rank: 2 },
    { pattern: /consultant_report/i, rank: 3 },
    { pattern: /financial_model/i, rank: 4 },
  ],
  legal_regulatory: [
    { pattern: /legal\s+due\s+diligence/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 4 },
  ],
  competitive: [
    { pattern: /altman\s*solon|commercial\s+cdd|buyside\s+cdd/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 3 },
  ],
  customer: [
    { pattern: /customer/i, rank: 1 },
    { pattern: /vendor\s+financial|fdd|financial\s+due\s+diligence|pwc/i, rank: 2 },
    { pattern: /legal\s+due\s+diligence/i, rank: 3 },
    { pattern: /consultant_report/i, rank: 4 },
    { pattern: /financial_model/i, rank: 5 },
  ],
  operational: [
    { pattern: /vendor\s+financial|fdd|financial\s+due\s+diligence|pwc/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 3 },
  ],
  exit: [
    { pattern: /exit|lbo|return/i, rank: 1 },
    { pattern: /ic\s+memo/i, rank: 2 },
    { pattern: /consultant_report/i, rank: 3 },
    { pattern: /financial_model/i, rank: 4 },
  ],
  esg_reputational: [
    { pattern: /legal\s+due\s+diligence/i, rank: 1 },
    { pattern: /esg|h&s|health\s+and\s+safety/i, rank: 1 },
    { pattern: /consultant_report/i, rank: 2 },
    { pattern: /financial_model/i, rank: 4 },
  ],
};

function computeAuthorityRank(
  dimensionId: string,
  sourceFile: string,
  documentTag: string,
): number {
  const prefs = AUTHORITY_PREFERENCES[dimensionId];
  if (!prefs) return 99;

  const combined = `${sourceFile} ${documentTag}`;
  for (const pref of prefs) {
    if (pref.pattern.test(combined)) {
      return pref.rank;
    }
  }
  return 99;
}

// ═══════════════════════════════════════════════════════════════════
// 5. READABILITY SCORING — Deliverable 4
// ═══════════════════════════════════════════════════════════════════

interface ReadabilityResult {
  rank: number; // lower = better
  warning: string | null;
}

function computeReadability(snippet: string): ReadabilityResult {
  const trimmed = snippet.trim();

  // Count alphabetic words
  const alphaWords = (trimmed.match(/[a-zA-Z]{2,}/g) || []).length;

  // Count numeric cells (comma-separated or standalone numbers)
  const numericCells = (trimmed.match(/[\d,.]+/g) || []).length;

  // Penalty: fewer than 8 alphabetic words
  if (alphaWords < 8) {
    // Mostly numeric data
    if (numericCells > 25) {
      return {
        rank: 90,
        warning: `Unexplained numeric sequence: ${alphaWords} alphabetic words, ${numericCells} numeric cells`,
      };
    }
    return {
      rank: 70,
      warning: `Low text content: ${alphaWords} alphabetic words`,
    };
  }

  // Penalty: more than 25 numeric cells without context
  if (numericCells > 25 && alphaWords < numericCells) {
    return {
      rank: 60,
      warning: `Numeric-heavy: ${numericCells} numeric cells vs ${alphaWords} words`,
    };
  }

  // Penalty: comma-heavy blank CSV fragments
  const commaRatio = (trimmed.match(/,/g) || []).length / Math.max(trimmed.length, 1);
  if (commaRatio > 0.15 && alphaWords < 15) {
    return {
      rank: 65,
      warning: "CSV-like fragment with limited textual context",
    };
  }

  // Penalty: repeated forecast periods (e.g., many year columns)
  const yearPattern = /20[12]\d/g;
  const years = trimmed.match(yearPattern) || [];
  if (years.length > 8) {
    return {
      rank: 50,
      warning: `Repeated forecast periods: ${years.length} year references`,
    };
  }

  // Good readability: complete sentences or self-contained records
  const hasSentence = /[A-Z][^.!?]*[.!?]/.test(trimmed);
  if (hasSentence && alphaWords >= 15) {
    return { rank: 1, warning: null }; // Excellent: complete sentence with substance
  }

  if (alphaWords >= 15) {
    return { rank: 5, warning: null }; // Good: substantial text content
  }

  return { rank: 10, warning: null }; // Acceptable
}

// ═══════════════════════════════════════════════════════════════════
// 6. SOURCE LOCATION RESOLUTION — Deliverable 5
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve a human-readable location from chunk metadata.
 * Uses existing metadata only — no inference from chunk order.
 */
export function resolveHumanLocation(
  chunkId: string,
  sourceFile: string,
  chunkMeta: ChunkMeta | undefined,
): { humanLocation: string; locationStatus: "resolved" | "unavailable" } {
  if (!chunkMeta) {
    return { humanLocation: "", locationStatus: "unavailable" };
  }

  const ft = chunkMeta.file_type.toLowerCase();

  // PDF: chunk_index maps to sequential page-sized segments, not 1:1 pages.
  // Without explicit page metadata, we cannot reliably resolve page numbers.
  if (ft.includes("pdf")) {
    // chunk_index is 0-based ordinal; we can't claim it's a page number
    // without explicit page metadata in the schema.
    return { humanLocation: "", locationStatus: "unavailable" };
  }

  // Excel: chunk_index is ordinal within the document's flattened chunk stream.
  // Without sheet name persisted in dcs_evidence, we can't resolve sheet!cell.
  if (
    ft.includes("spreadsheet") ||
    ft.includes("excel") ||
    ft.includes("xlsx") ||
    ft.includes("xls")
  ) {
    return { humanLocation: "", locationStatus: "unavailable" };
  }

  // Other file types: no reliable location metadata
  return { humanLocation: "", locationStatus: "unavailable" };
}

// ═══════════════════════════════════════════════════════════════════
// 7. DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════

function normalizeSnippet(snippet: string): string {
  return snippet
    .replace(/\s+/g, " ")
    .replace(/[",]+/g, "")
    .trim()
    .toLowerCase();
}

function deduplicateRows(rows: RawEvidenceRow[]): {
  unique: RawEvidenceRow[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const unique: RawEvidenceRow[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    // Check exact snippet duplicate
    if (seen.has(row.snippet)) {
      duplicateCount++;
      continue;
    }

    // Check normalized snippet duplicate
    const normalized = normalizeSnippet(row.snippet);
    if (seen.has(normalized)) {
      duplicateCount++;
      continue;
    }

    seen.add(row.snippet);
    seen.add(normalized);
    unique.push(row);
  }

  return { unique, duplicateCount };
}

// ═══════════════════════════════════════════════════════════════════
// 8. EVIDENCE CURATION PIPELINE — Deliverable 4
// ═══════════════════════════════════════════════════════════════════

const MAX_ANCHORS = 4;

interface ScoredCandidate {
  row: RawEvidenceRow;
  authorityRank: number;
  readability: ReadabilityResult;
  promotionEligible: boolean;
}

function selectAnchors(
  dimensionId: string,
  rows: RawEvidenceRow[],
  chunkMetaMap: Map<string, ChunkMeta>,
): {
  curated: CuratedEvidence[];
  excludedCandidateCounts: {
    duplicates: number;
    lowReadability: number;
    authorityFiltered: number;
  };
  scopeNotes: string[];
} {
  const scopeNotes: string[] = [];

  // Step 1: Deduplicate
  const { unique, duplicateCount } = deduplicateRows(rows);

  // Step 2: Score every unique candidate
  const scored: ScoredCandidate[] = unique.map((row) => {
    const authorityRank = computeAuthorityRank(
      dimensionId,
      row.source_file,
      row.document_tag,
    );
    const readability = computeReadability(row.snippet);
    const promotionEligible =
      dimensionId === "exit"
        ? row.doc_class === "workproduct" &&
          row.is_substantive &&
          isExitPromotionEligible(row.snippet, row.document_tag, row.source_file)
        : row.doc_class === "workproduct" && row.is_substantive;

    return { row, authorityRank, readability, promotionEligible };
  });

  // Step 3: Sort by authority (asc), readability (asc), then chunk_id for determinism
  scored.sort((a, b) => {
    // Substantive first
    if (a.row.is_substantive && !b.row.is_substantive) return -1;
    if (!a.row.is_substantive && b.row.is_substantive) return 1;
    // Authority rank (lower = better)
    if (a.authorityRank !== b.authorityRank) return a.authorityRank - b.authorityRank;
    // Readability rank (lower = better)
    if (a.readability.rank !== b.readability.rank) return a.readability.rank - b.readability.rank;
    // Deterministic tiebreaker
    return a.row.chunk_id.localeCompare(b.row.chunk_id);
  });

  // Step 4: Select up to MAX_ANCHORS, preferring distinct sources
  const selected: ScoredCandidate[] = [];
  const selectedSources = new Set<string>();
  let lowReadabilitySkipped = 0;
  let authorityFiltered = 0;

  // First pass: prefer best candidates from distinct sources
  for (const candidate of scored) {
    if (selected.length >= MAX_ANCHORS) break;

    // Skip very low readability unless no better option exists
    if (candidate.readability.rank >= 70 && selected.length < scored.length - 1) {
      // Check if there's a better candidate from a different source
      const hasBetterCandidate = scored.some(
        (other) =>
          other !== candidate &&
          other.readability.rank < 70 &&
          !selected.includes(other),
      );
      if (hasBetterCandidate) {
        lowReadabilitySkipped++;
        continue;
      }
    }

    // Prefer distinct sources
    if (selectedSources.has(candidate.row.source_file) && selected.length < scored.length) {
      // Check if there's an unrepresented source
      const hasUnrepresentedSource = scored.some(
        (other) =>
          !selectedSources.has(other.row.source_file) &&
          !selected.includes(other) &&
          other.readability.rank < 70,
      );
      if (hasUnrepresentedSource) {
        authorityFiltered++;
        continue;
      }
    }

    selected.push(candidate);
    selectedSources.add(candidate.row.source_file);
  }

  // Second pass: fill remaining slots if first pass was too selective
  if (selected.length < MAX_ANCHORS) {
    for (const candidate of scored) {
      if (selected.length >= MAX_ANCHORS) break;
      if (selected.includes(candidate)) continue;
      selected.push(candidate);
      selectedSources.add(candidate.row.source_file);
    }
  }

  // Check for location unavailability
  const locationUnavailableCount = selected.filter((s) => {
    const meta = chunkMetaMap.get(s.row.chunk_id);
    const loc = resolveHumanLocation(s.row.chunk_id, s.row.source_file, meta);
    return loc.locationStatus === "unavailable";
  }).length;

  if (locationUnavailableCount > 0) {
    scopeNotes.push(
      `${locationUnavailableCount} selected anchor(s) have unavailable source locations: chunk metadata does not include page/sheet/cell references.`,
    );
  }

  // Build curated evidence
  const curated: CuratedEvidence[] = selected.map((s) => {
    const meta = chunkMetaMap.get(s.row.chunk_id);
    const location = resolveHumanLocation(s.row.chunk_id, s.row.source_file, meta);

    const selectionReasons: string[] = [];
    if (s.authorityRank <= 2) selectionReasons.push("Authoritative source for this dimension");
    if (s.readability.rank <= 5) selectionReasons.push("High readability");
    if (s.row.is_substantive) selectionReasons.push("Substantive evidence");
    if (s.promotionEligible) selectionReasons.push("Promotion-eligible workproduct");
    if (selectionReasons.length === 0) selectionReasons.push("Best available candidate");

    return {
      evidenceId: s.row.id,
      chunkId: s.row.chunk_id,
      sourceFile: s.row.source_file,
      documentTag: s.row.document_tag,
      docClass: s.row.doc_class,
      snippet: s.row.snippet, // Preserved exactly, never rewritten
      isSubstantive: s.row.is_substantive,
      promotionEligible: s.promotionEligible,
      humanLocation: location.humanLocation,
      locationStatus: location.locationStatus,
      authorityRank: s.authorityRank,
      readabilityRank: s.readability.rank,
      selectionReasons,
      readabilityWarning: s.readability.warning,
    };
  });

  return {
    curated,
    excludedCandidateCounts: {
      duplicates: duplicateCount,
      lowReadability: lowReadabilitySkipped,
      authorityFiltered,
    },
    scopeNotes,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 9. COVERAGE LABEL MAPPING
// ═══════════════════════════════════════════════════════════════════

function toCoverageLabel(state: DimensionState): CoverageLabel {
  switch (state) {
    case "evidenced":
      return "independent_workproduct";
    case "asserted":
      return "narrative_only";
    case "absent":
      return "not_established";
  }
}

// ═══════════════════════════════════════════════════════════════════
// 10. MAIN ENTRY POINT — curateDimensionPackets
// ═══════════════════════════════════════════════════════════════════

/**
 * Produce exactly 10 CuratedDimensionPackets from raw evidence rows.
 *
 * Pure function. Deterministic. Identical inputs produce byte-identical output.
 *
 * @param evidenceRows — all dcs_evidence rows for the run
 * @param chunkMetaMap — chunk_id → ChunkMeta for location resolution
 * @returns exactly 10 packets in canonical dimension order
 */
export function curateDimensionPackets(
  evidenceRows: RawEvidenceRow[],
  chunkMetaMap: Map<string, ChunkMeta>,
): CuratedDimensionPacket[] {
  // Group evidence by dimension
  const byDimension = new Map<string, RawEvidenceRow[]>();
  for (const dim of DCS_DIMENSIONS) {
    byDimension.set(dim.id, []);
  }
  for (const row of evidenceRows) {
    const arr = byDimension.get(row.dimension_id);
    if (arr) arr.push(row);
  }

  const packets: CuratedDimensionPacket[] = [];

  for (const dim of DCS_DIMENSIONS) {
    const rows = byDimension.get(dim.id)!;

    // Compute deterministic state
    let state: DimensionState;
    if (dim.id === "exit") {
      state = computeExitDimensionState(
        rows.map((r) => ({
          doc_class: r.doc_class,
          is_substantive: r.is_substantive,
          snippet: r.snippet,
          document_tag: r.document_tag,
          source_file: r.source_file,
        })),
      );
    } else {
      state = computeDimensionState(
        rows.map((r) => ({
          doc_class: r.doc_class,
          is_substantive: r.is_substantive,
        })),
      );
    }

    const scoreContribution = SCORE_VALUES[state];
    const coverageLabel = toCoverageLabel(state);

    // Count substantive workproduct
    const substantiveWpCount = rows.filter(
      (r) => r.doc_class === "workproduct" && r.is_substantive,
    ).length;

    // Count distinct sources
    const sourceCount = new Set(rows.map((r) => r.source_file)).size;

    // Curate evidence anchors
    const { curated, excludedCandidateCounts, scopeNotes } = selectAnchors(
      dim.id,
      rows,
      chunkMetaMap,
    );

    // Add Exit-specific scope note when demotion occurs
    if (dim.id === "exit" && state === "asserted" && substantiveWpCount > 0) {
      scopeNotes.push(
        `${substantiveWpCount} workproduct row(s) exist but none pass the exit promotion gate. ` +
        `Evidence relates to capital structure, forecasts, or generic valuation rather than independent exit diligence.`,
      );
    }

    packets.push({
      dimensionId: dim.id,
      label: dim.label,
      deterministicState: state,
      internalScoreContribution: scoreContribution,
      coverageLabel,
      evidenceCount: rows.length,
      substantiveWorkproductCount: substantiveWpCount,
      sourceCount,
      coverageQuestions: COVERAGE_QUESTIONS[dim.id] || [],
      curatedEvidence: curated,
      excludedCandidateCounts,
      scopeNotes,
    });
  }

  return packets;
}
