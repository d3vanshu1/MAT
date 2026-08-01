/**
 * Replay Classifier — Shared Pure Module
 *
 * Contains the authoritative classification logic used by:
 *   - ReplayDispositionHarness (Q1/Q2 and future replays)
 *   - q1-q2-regression.test.ts
 *   - Future claim-linkage replay (Q3+)
 *
 * INVARIANTS:
 *   - No input mutation: functions receive data and return classifications
 *   - Deterministic: same input always produces same output
 *   - Pure: no side effects, no external state
 *   - Single source of truth: no mirrored test-only implementations
 */

import {
  EXCLUDED_SOURCES,
  NARRATIVE_SOURCES,
  EVIDENCE_SOURCES,
  CONTRADICTION_CHECK_ALLOWED_TAGS,
  SPECIALIST_DOCUMENT_PATTERNS,
  TARGETED_VERIFICATION_CLAIM_TYPES,
  type TargetedVerificationClaimType,
} from "./source-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DISPOSITION_TYPES = [
  "retained_as_contradiction_candidate",
  "excluded_wrong_module",
  "confirmed_claim",
  "supporting_evidence",
  "process_diagnostic",
  "source_recommendation",
  "scope_limitation",
  "excluded_immaterial",
  "excluded_unsupported",
  "excluded_false_positive",
  "merged_into",
  "not_linked_to_IC_claim",
  "merged_into_canonical_finding",
  "retained_as_canonical_finding",
  "excluded_with_reason",
] as const;

export type DispositionType = typeof DISPOSITION_TYPES[number];

export interface ClassificationInput {
  title: string;
  detail?: string | null;
  full_analysis?: string | null;
  evidence?: string | null;
  severity?: string | null;
  category?: string | null;
  finding_kind?: string | null;
  source_tag?: string | null;
  _source_tag?: string | null;
  source_docs?: string[] | null;
  _originating_claim_id?: string | null;
  claim_id?: string | null;
  _claim_type?: string | null;
  claim_type?: string | null;
  originating_claim_id?: string | null;
}

export interface ClassificationResult {
  disposition: DispositionType;
  reason: string;
}

// ---------------------------------------------------------------------------
// Source-type derivation (pure, no mutation)
// ---------------------------------------------------------------------------

/**
 * Derives the source type tag for a finding from its metadata.
 * Does NOT mutate the input object.
 */
export function deriveSourceTag(finding: ClassificationInput, sourceDocs?: string[]): string | null {
  // Use explicit tag if present
  if (finding.source_tag) return finding.source_tag;
  if (finding._source_tag) return finding._source_tag;

  const docs = sourceDocs ?? (finding.source_docs || []);
  if (docs.length === 0) return null;

  const allLegal = docs.every(d => isLegalDocument(d));
  if (allLegal) return "legal";

  const allIC = docs.every(d => isICDocument(d));
  if (allIC) return "ic_memo";

  const allFinancial = docs.every(d => isFinancialDocument(d));
  if (allFinancial) return "financial_model";

  const allConsultant = docs.every(d => isConsultantDocument(d));
  if (allConsultant) return "consultant_report";

  // Mixed sources — take primary (first doc)
  if (isLegalDocument(docs[0])) return "legal";
  if (isICDocument(docs[0])) return "ic_memo";
  if (isFinancialDocument(docs[0])) return "financial_model";
  if (isConsultantDocument(docs[0])) return "consultant_report";

  return "other";
}

// ---------------------------------------------------------------------------
// Classification patterns
// ---------------------------------------------------------------------------

/** Process diagnostic indicators */
const PROCESS_DIAGNOSTIC_PATTERNS = [
  /text\s+truncat/i,
  /extraction?\s+(fail|error|unable)/i,
  /cannot\s+(be\s+)?assessed/i,
  /not\s+extracted/i,
  /analysis\s+cannot\s+proceed/i,
  /missing\s+(ic\s+)?memo\s+record/i,
  /substantive\s+analysis\s+section\s+not\s+extracted/i,
  /critical\s+gap.*text\s+truncation/i,
  /unable\s+to\s+(fully\s+)?assess/i,
  /insufficient\s+data\s+to\s+assess/i,
  /no\s+(relevant\s+)?data\s+available/i,
];

/** Confirmed-claim indicators */
const CONFIRMED_CLAIM_PATTERNS = [
  /\bconfirm(ed|s)?\b.*\b(in\s+place|compliance|ownership|aligned)\b/i,
  /\bprotective\s+documentation\s+in\s+place\b/i,
  /\bverified\b.*\bconsistent\b/i,
  /\bsubstantiat(ed|es)\b.*\bclaim\b/i,
  /\bdiversified\b.*\bportfolio\b/i,
  /\bcompliance\s+confirmed\b/i,
  /\bip\s+ownership\b.*\bin\s+place\b/i,
];

/** Source recommendation / advisory indicators */
const SOURCE_RECOMMENDATION_PATTERNS = [
  /\brecommend(ation|ed|s)?\b/i,
  /\bshould\s+(be\s+)?(reviewed|addressed|assessed|considered)\b/i,
  /\badvisory\b/i,
  /\brequires?\s+(further\s+)?(review|diligence|assessment)\b/i,
];

/** Scope limitation indicators */
const SCOPE_LIMITATION_PATTERNS = [
  /\bscope\s+(of\s+)?this\s+(analysis|review|module)\b/i,
  /\boutside\s+(the\s+)?scope\b/i,
  /\bbeyond\s+(the\s+)?remit\b/i,
  /\bnot\s+within\s+(the\s+)?scope\b/i,
];

/** Legal DD content patterns */
const LEGAL_DD_CONTENT_PATTERNS = [
  /\blease\b.*\b(terms?|clause|provision|expir)/i,
  /\bpension\b.*\b(compliance|scheme|obligation)/i,
  /\bMSA\b.*\b(portfolio|contract)/i,
  /\bchange.of.control\b.*\b(clause|provision|trigger)/i,
  /\btermination\b.*\b(clause|provision|right|event)/i,
  /\bindemnit(y|ies)\b/i,
  /\bwarranties?\b.*\b(breach|limit|cap)/i,
  /\breinstatement\b.*\b(framework|obligation)/i,
  /\bregulatory\s+(compliance|framework|obligation)\b/i,
  /\blegal\s+dd\s+report\b/i,
];

// ---------------------------------------------------------------------------
// Classification function (pure, no mutation)
// ---------------------------------------------------------------------------

/**
 * Classifies a single finding into one disposition.
 *
 * Invariants:
 *   - Does NOT mutate the input object
 *   - Deterministic: same input → same output
 *   - Returns exactly one disposition
 *
 * @param finding - The finding data (read-only)
 * @param derivedSourceTag - Pre-computed source tag (from deriveSourceTag)
 */
export function classifyReplayFinding(
  finding: ClassificationInput,
  derivedSourceTag: string | null,
): ClassificationResult {
  const title = String(finding.title ?? "").trim();
  const detail = String(finding.detail ?? finding.full_analysis ?? finding.evidence ?? "").trim();
  const severity = String(finding.severity ?? "").toLowerCase();
  const category = String(finding.category ?? "").toLowerCase();
  const sourceDocs: string[] = Array.isArray(finding.source_docs) ? finding.source_docs : [];
  const fullText = `${title} ${detail}`;

  const sourceTag = derivedSourceTag;

  // -----------------------------------------------------------------------
  // Rule 1: Source policy — findings from excluded sources without IC claim
  // -----------------------------------------------------------------------
  if (sourceTag && EXCLUDED_SOURCES.has(sourceTag as any)) {
    const hasOriginatingClaim = !!(finding._originating_claim_id || finding.claim_id || finding.originating_claim_id);
    if (hasOriginatingClaim) {
      const claimType = finding._claim_type ?? finding.claim_type;
      if (claimType && TARGETED_VERIFICATION_CLAIM_TYPES.includes(claimType as TargetedVerificationClaimType)) {
        // Retain through targeted path — continue to classify output type
      } else {
        return { disposition: "excluded_wrong_module", reason: `Legal DD finding without qualifying targeted claim type (has '${claimType ?? "none"}')` };
      }
    } else {
      return { disposition: "excluded_wrong_module", reason: "Legal DD finding with no originating IC claim — excluded by source policy" };
    }
  }

  // Rule 1b: Heuristic detection of Legal DD content even without explicit tag
  const legalDocs = sourceDocs.filter(d =>
    /legal\s*dd/i.test(d) || /legal\s+due\s+diligence/i.test(d) || /legal\s+report/i.test(d)
  );
  const hasOnlyLegalSource = legalDocs.length > 0 && legalDocs.length === sourceDocs.length;
  const hasLegalSource = legalDocs.length > 0;

  if (hasOnlyLegalSource && !finding._originating_claim_id && !finding.claim_id && !finding.originating_claim_id) {
    if (LEGAL_DD_CONTENT_PATTERNS.some(p => p.test(fullText))) {
      return { disposition: "excluded_wrong_module", reason: "Legal DD content pattern detected with no IC claim anchor — wrong module" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 2: Process diagnostics — extraction/analysis failures
  // -----------------------------------------------------------------------
  if (PROCESS_DIAGNOSTIC_PATTERNS.some(p => p.test(fullText))) {
    return { disposition: "process_diagnostic", reason: "Finding describes an extraction failure, missing document, or analysis scope limitation" };
  }

  // -----------------------------------------------------------------------
  // Rule 3: Confirmed claims — positive confirmations of IC narrative
  // -----------------------------------------------------------------------
  if (CONFIRMED_CLAIM_PATTERNS.some(p => p.test(fullText)) && severity === "info") {
    return { disposition: "confirmed_claim", reason: "Finding confirms an IC claim is supported by evidence (positive confirmation)" };
  }

  // -----------------------------------------------------------------------
  // Rule 4: Legal DD content as wrong_module (broader detection)
  // -----------------------------------------------------------------------
  if (hasLegalSource && LEGAL_DD_CONTENT_PATTERNS.some(p => p.test(fullText))) {
    if (!finding._originating_claim_id && !finding.claim_id && !finding.originating_claim_id) {
      return { disposition: "excluded_wrong_module", reason: "Legal DD content (lease, pension, MSA, termination) without IC claim — belongs in legal_diligence_review module" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 5: Scope limitations
  // -----------------------------------------------------------------------
  if (SCOPE_LIMITATION_PATTERNS.some(p => p.test(fullText))) {
    return { disposition: "scope_limitation", reason: "Finding describes a scope limitation of the analysis" };
  }

  // -----------------------------------------------------------------------
  // Rule 6: Source recommendations (advisory, not contradictions)
  // -----------------------------------------------------------------------
  if (SOURCE_RECOMMENDATION_PATTERNS.some(p => p.test(fullText)) && severity !== "critical") {
    const hasDataConflict = /\b(contradict|conflict|discrepanc|inconsisten|diverge|shortfall|gap\s+between)\b/i.test(fullText);
    if (!hasDataConflict) {
      return { disposition: "source_recommendation", reason: "Finding is a diligence recommendation or advisory observation, not a narrative-vs-data contradiction" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 7: Supporting evidence (additional passages for existing issues)
  // -----------------------------------------------------------------------
  if (category === "housekeeping" || category === "supporting" || severity === "info") {
    const isSubstantive = /\b(contradict|conflict|discrepanc|inconsisten|diverge|shortfall|weak|unsupport)\b/i.test(fullText);
    if (!isSubstantive) {
      return { disposition: "supporting_evidence", reason: "Info-level finding without substantive contradiction — classifies as supporting evidence" };
    }
  }

  // -----------------------------------------------------------------------
  // Default: retained as contradiction candidate
  // -----------------------------------------------------------------------
  return { disposition: "retained_as_contradiction_candidate", reason: "Finding describes a narrative-vs-evidence conflict or unsupported IC claim — within contradiction-check scope" };
}

// ---------------------------------------------------------------------------
// Document classification helpers (pure)
// ---------------------------------------------------------------------------

export function isLegalDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /legal\s*(dd|due\s*diligence|report)/i.test(lower) ||
    /^legal/i.test(lower) ||
    lower.includes("legal dd");
}

export function isICDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /ic\s*memo/i.test(lower) ||
    /screening\s*memo/i.test(lower) ||
    /investment\s*committee/i.test(lower) ||
    lower.includes("ic memo") ||
    lower.includes("ic update");
}

export function isFinancialDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /financial\s*model/i.test(lower) ||
    /model.*\.xlsx?$/i.test(lower) ||
    lower.includes("lbo model") ||
    lower.includes("operating model");
}

export function isConsultantDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /vendor\s*(f|financial)\s*(dd|due\s*diligence)/i.test(lower) ||
    /commercial\s*(dd|due\s*diligence)/i.test(lower) ||
    /quality\s*of\s*earnings/i.test(lower) ||
    /qoe/i.test(lower) ||
    lower.includes("fdd") ||
    lower.includes("cdd");
}

export function isLegalDDSource(sourceDocs: string[]): boolean {
  return sourceDocs.some(d => isLegalDocument(d));
}

// ---------------------------------------------------------------------------
// Routing diagnostics interface
// ---------------------------------------------------------------------------

export interface RoutingDiagnosticEntry {
  document_id: string;
  document_title: string;
  chunk_index: number;
  tag: string;
  actual_source_type: string;
  allowed: boolean;
  reason: string;
}

export interface RoutingDiagnostics {
  total_chunks_considered: number;
  chunks_routed: number;
  chunks_excluded: number;
  entries: RoutingDiagnosticEntry[];
}
