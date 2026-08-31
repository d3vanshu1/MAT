/**
 * DCS Dimension Rationale Validator — Packet 6B
 *
 * PURE MODULE: no model calls, no database access, no I/O, no logging.
 * All inputs are passed in; all outputs are returned.
 *
 * Responsibilities:
 * 1. Output contract schemas (Deliverable 1)
 * 2. Citation validation (Deliverable 4)
 * 3. Numeric grounding (Deliverable 5)
 * 4. Deterministic depth computation (Deliverable 8)
 * 5. Content-format validation (no Markdown, no UUIDs, no scores)
 *
 * HARD CONSTRAINT: this file must NOT import any integration client,
 * database helper, Anthropic client, api() wrapper, or logger.
 */

import type { CuratedDimensionPacket, CuratedEvidence } from "./dcs-evidence-curation.js";

// ═══════════════════════════════════════════════════════════════════
// 1. OUTPUT CONTRACT — Deliverable 1
// ═══════════════════════════════════════════════════════════════════

export interface Citation {
  evidenceId: string;
  sourceFile: string;
  humanLocation: string;
  docClass: string;
  exactSnippet: string;
}

export interface WhyStatus {
  text: string;
  citationIds: string[];
}

export interface QuestionAssessment {
  questionId: string;
  question: string;
  status: "established" | "partial" | "not_established";
  explanation: string;
  citationIds: string[];
}

export interface EstablishedPoint {
  claimId: string;
  text: string;
  citationIds: string[];
}

export interface RemainingGap {
  gapId: string;
  text: string;
  basisType: "coverage_question" | "scope_note" | "evidence_limitation";
  basisIds: string[];
  citationIds: string[];
}

export interface IcImplication {
  text: string;
  citationIds: string[];
  isInference: true;
}

export interface ValidationMetadata {
  schemaValidated: boolean;
  citationsValidated: boolean;
  numbersValidated: boolean;
  supportVerified: boolean;
  correctionAttempted: boolean;
  correctionRecovered: boolean;
}

export interface DimensionRationale {
  dimensionId: string;
  label: string;
  deterministicState: string;
  coverageLabel: string;
  coverageDepth: string;
  whyStatus: WhyStatus;
  questionAssessments: QuestionAssessment[];
  establishedPoints: EstablishedPoint[];
  remainingGaps: RemainingGap[];
  icImplication: IcImplication;
  citations: Citation[];
  validationMetadata: ValidationMetadata;
}

// ── Model-generated candidate (before deterministic fields attached) ──

export interface RationaleDraftCandidate {
  dimensionId: string;
  whyStatus: WhyStatus;
  questionAssessments: QuestionAssessment[];
  establishedPoints: EstablishedPoint[];
  remainingGaps: RemainingGap[];
  icImplication: IcImplication;
  citations: Citation[];
}

// ── Support verification types ──

export type SupportReasonCode =
  | "SUPPORTED"
  | "NOT_SUPPORTED"
  | "CITATION_MISMATCH"
  | "OVERSTATED_SCOPE"
  | "NUMERIC_MISMATCH"
  | "UNSUPPORTED_INFERENCE";

export interface SupportVerificationResult {
  claimId: string;
  supported: boolean;
  supportingCitationIds: string[];
  reasonCode: SupportReasonCode;
}

// ═══════════════════════════════════════════════════════════════════
// 2. VALIDATION RESULT
// ═══════════════════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════════
// 3. FORBIDDEN CONTENT PATTERNS
// ═══════════════════════════════════════════════════════════════════

/** Score / evidence-count language forbidden in reader-facing text */
const SCORE_PATTERNS = [
  /\b(?:score|scored|scoring)\b/i,
  /\bout of ten\b/i,
  /\bheadline score\b/i,
  /\bevidence.row.count/i,
  /\b\d+\s+(?:evidence\s+)?rows?\b/i,
];

/** Markdown patterns */
const MARKDOWN_PATTERNS = [
  /^#{1,6}\s/m,                         // headings
  /^[\s]*[-*+]\s/m,                     // bullets
  /^[\s]*\d+\.\s/m,                     // numbered lists
  /\|[\s]*[-:]+[\s]*\|/,               // tables
  /```/,                                 // code blocks
  /\*\*[^*]+\*\*/,                      // bold
  /__[^_]+__/,                          // underline emphasis
];

/** UUID pattern */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** CSV vector pattern (5+ comma-separated numbers) */
const CSV_VECTOR_PATTERN = /(?:\d[\d,.]*,){4,}\d[\d,.]*/;

/** Absolute absence claims without scope qualification */
const ABSOLUTE_ABSENCE_PATTERNS = [
  /\bno diligence exists\b/i,
  /\bthe company has no controls\b/i,
  /\bthere is no market\b/i,
  /\bmanagement did not assess\b/i,
  /\bno (?:due )?diligence (?:has been |was )?(?:performed|conducted|completed)\b/i,
  /\bno (?:analysis|assessment|review) exists\b/i,
];

// ═══════════════════════════════════════════════════════════════════
// 4. SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════════

function validateSchema(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
): string[] {
  const errors: string[] = [];

  // dimensionId match
  if (candidate.dimensionId !== packet.dimensionId) {
    errors.push(`dimensionId mismatch: expected ${packet.dimensionId}, got ${candidate.dimensionId}`);
  }

  // whyStatus
  if (!candidate.whyStatus?.text || candidate.whyStatus.text.trim().length === 0) {
    errors.push("whyStatus.text is empty");
  }

  // questionAssessments: exactly one per coverage question
  const expectedQuestionCount = packet.coverageQuestions.length;
  if (candidate.questionAssessments.length !== expectedQuestionCount) {
    errors.push(
      `questionAssessments count: expected ${expectedQuestionCount}, got ${candidate.questionAssessments.length}`,
    );
  }

  // Check for duplicate question IDs
  const qIds = new Set<string>();
  for (const qa of candidate.questionAssessments) {
    if (qIds.has(qa.questionId)) {
      errors.push(`Duplicate questionId: ${qa.questionId}`);
    }
    qIds.add(qa.questionId);
  }

  // Check every coverage question appears exactly once
  const questionTexts = new Set(candidate.questionAssessments.map((qa) => qa.question));
  for (const q of packet.coverageQuestions) {
    if (!questionTexts.has(q)) {
      errors.push(`Missing coverage question: "${q}"`);
    }
  }

  // Check for unknown question IDs / questions not in packet
  const packetQuestions = new Set(packet.coverageQuestions);
  for (const qa of candidate.questionAssessments) {
    if (!packetQuestions.has(qa.question)) {
      errors.push(`Unknown question: "${qa.question}"`);
    }
    if (!["established", "partial", "not_established"].includes(qa.status)) {
      errors.push(`Invalid question status: "${qa.status}" for ${qa.questionId}`);
    }
  }

  // establishedPoints: 1–4
  if (candidate.establishedPoints.length === 0) {
    errors.push("establishedPoints is empty (minimum 1)");
  }
  if (candidate.establishedPoints.length > 4) {
    errors.push(`establishedPoints exceeds maximum (4): got ${candidate.establishedPoints.length}`);
  }

  // Check for duplicate claim IDs
  const claimIds = new Set<string>();
  for (const ep of candidate.establishedPoints) {
    if (claimIds.has(ep.claimId)) {
      errors.push(`Duplicate claimId: ${ep.claimId}`);
    }
    claimIds.add(ep.claimId);
  }

  // remainingGaps: 1–3
  if (candidate.remainingGaps.length === 0) {
    errors.push("remainingGaps is empty (minimum 1)");
  }
  if (candidate.remainingGaps.length > 3) {
    errors.push(`remainingGaps exceeds maximum (3): got ${candidate.remainingGaps.length}`);
  }

  // Check gap basis types and IDs
  for (const gap of candidate.remainingGaps) {
    if (!["coverage_question", "scope_note", "evidence_limitation"].includes(gap.basisType)) {
      errors.push(`Invalid gap basisType: "${gap.basisType}" for ${gap.gapId}`);
    }
    if (claimIds.has(gap.gapId)) {
      errors.push(`gapId collides with claimId: ${gap.gapId}`);
    }
  }

  // icImplication
  if (!candidate.icImplication?.text || candidate.icImplication.text.trim().length === 0) {
    errors.push("icImplication.text is empty");
  }
  if (candidate.icImplication?.isInference !== true) {
    errors.push("icImplication.isInference must be true");
  }

  // citations array
  if (!candidate.citations || candidate.citations.length === 0) {
    errors.push("citations array is empty");
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════
// 5. CITATION VALIDATION — Deliverable 4
// ═══════════════════════════════════════════════════════════════════

function validateCitations(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
): string[] {
  const errors: string[] = [];

  // Build evidence ID set from curated packet
  const packetEvidenceIds = new Set(packet.curatedEvidence.map((e) => e.evidenceId));
  const evidenceById = new Map<string, CuratedEvidence>();
  for (const e of packet.curatedEvidence) {
    evidenceById.set(e.evidenceId, e);
  }

  // Build citation ID set from candidate
  const candidateCitationIds = new Set(candidate.citations.map((c) => c.evidenceId));

  // Every citation ID must exist in packet
  for (const cit of candidate.citations) {
    if (!packetEvidenceIds.has(cit.evidenceId)) {
      errors.push(`Unknown citation evidenceId: ${cit.evidenceId}`);
      continue;
    }

    const evidence = evidenceById.get(cit.evidenceId)!;

    // Source file must match
    if (cit.sourceFile !== evidence.sourceFile) {
      errors.push(
        `Citation ${cit.evidenceId} sourceFile mismatch: "${cit.sourceFile}" vs "${evidence.sourceFile}"`,
      );
    }

    // Human location must match
    if (cit.humanLocation !== evidence.humanLocation) {
      errors.push(
        `Citation ${cit.evidenceId} humanLocation mismatch: "${cit.humanLocation}" vs "${evidence.humanLocation}"`,
      );
    }

    // Doc class must match
    if (cit.docClass !== evidence.docClass) {
      errors.push(
        `Citation ${cit.evidenceId} docClass mismatch: "${cit.docClass}" vs "${evidence.docClass}"`,
      );
    }

    // Exact snippet must match
    if (cit.exactSnippet !== evidence.snippet) {
      errors.push(
        `Citation ${cit.evidenceId} exactSnippet mismatch (length ${cit.exactSnippet.length} vs ${evidence.snippet.length})`,
      );
    }
  }

  // Collect all referenced citation IDs from claims
  const allReferencedIds = new Set<string>();

  for (const id of candidate.whyStatus.citationIds) allReferencedIds.add(id);
  for (const qa of candidate.questionAssessments) {
    for (const id of qa.citationIds) allReferencedIds.add(id);
  }
  for (const ep of candidate.establishedPoints) {
    for (const id of ep.citationIds) allReferencedIds.add(id);
  }
  for (const gap of candidate.remainingGaps) {
    for (const id of gap.citationIds) allReferencedIds.add(id);
  }
  for (const id of candidate.icImplication.citationIds) allReferencedIds.add(id);

  // Every referenced citation ID must exist in the citations array
  for (const refId of allReferencedIds) {
    if (!candidateCitationIds.has(refId)) {
      errors.push(`Referenced citationId "${refId}" not found in citations array`);
    }
  }

  // Every positive established point must have at least one citation
  for (const ep of candidate.establishedPoints) {
    if (ep.citationIds.length === 0) {
      errors.push(`Established point "${ep.claimId}" has no citations`);
    }
  }

  // IC implication must have supporting citations
  if (candidate.icImplication.citationIds.length === 0) {
    errors.push("icImplication has no supporting citations");
  }

  // not_established questions cannot be described as established elsewhere
  const notEstablishedQuestions = new Set(
    candidate.questionAssessments
      .filter((qa) => qa.status === "not_established")
      .map((qa) => qa.question.toLowerCase()),
  );
  for (const ep of candidate.establishedPoints) {
    const epLower = ep.text.toLowerCase();
    for (const neq of notEstablishedQuestions) {
      // Check if established point contradicts not_established question
      const questionKeywords = neq.split(/\s+/).filter((w) => w.length > 4);
      const matchCount = questionKeywords.filter((kw) => epLower.includes(kw)).length;
      if (matchCount >= 3 && matchCount / questionKeywords.length >= 0.6) {
        errors.push(
          `Established point "${ep.claimId}" appears to contradict not_established question: "${neq}"`,
        );
      }
    }
  }

  // Absence-based gaps: validate basis
  for (const gap of candidate.remainingGaps) {
    if (gap.citationIds.length === 0) {
      // Allowed only for coverage_question, scope_note, evidence_limitation
      if (!["coverage_question", "scope_note", "evidence_limitation"].includes(gap.basisType)) {
        errors.push(`Gap "${gap.gapId}" has no citations and invalid basisType "${gap.basisType}"`);
      }
      // Check wording uses scope-qualified language
      const gapLower = gap.text.toLowerCase();
      for (const pattern of ABSOLUTE_ABSENCE_PATTERNS) {
        if (pattern.test(gap.text)) {
          errors.push(
            `Gap "${gap.gapId}" uses absolute absence claim without scope qualification`,
          );
        }
      }
      // If basisType is coverage_question, basisIds should reference valid question IDs
      if (gap.basisType === "coverage_question") {
        const validQuestionIds = new Set(candidate.questionAssessments.map((qa) => qa.questionId));
        for (const bId of gap.basisIds) {
          if (!validQuestionIds.has(bId)) {
            errors.push(`Gap "${gap.gapId}" references unknown question basisId: ${bId}`);
          }
        }
      }
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════
// 6. NUMERIC GROUNDING — Deliverable 5
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract numeric tokens from text.
 * Returns normalized numbers as strings (commas removed, percentages preserved).
 */
function extractNumericTokens(text: string): string[] {
  // Match: balanced-paren negatives, currency amounts, percentages, plain numbers
  // Balanced parens: ($1,234.56) or (1,234.56)
  // Unbalanced parens are NOT captured
  const matches = text.match(
    /[$£€¥]?\s*\(\d[\d,.]*\)%?|[$£€¥]\s*\d[\d,.]*%?|\d[\d,.]*%|\d[\d,.]*x\b|\d[\d,.]+/g,
  );
  if (!matches) return [];

  return matches.map((m) => normalizeNumericToken(m)).filter((n) => n.length > 0);
}

function normalizeNumericToken(raw: string): string {
  let token = raw.trim();
  // Strip currency symbols
  token = token.replace(/[$£€¥]/g, "");
  // Handle parenthesized negatives: (123) → -123
  if (token.startsWith("(") && token.endsWith(")")) {
    token = "-" + token.slice(1, -1);
  }
  // Strip stray parens (unbalanced)
  token = token.replace(/[()]/g, "");
  // Strip commas
  token = token.replace(/,/g, "");
  // Strip percent sign and multiplier suffix for matching
  token = token.replace(/%/g, "");
  token = token.replace(/x$/i, "");
  // Trim whitespace
  token = token.trim();
  return token;
}

function validateNumericGrounding(
  candidate: RationaleDraftCandidate,
): string[] {
  const errors: string[] = [];

  // Build snippet text per citation ID
  const snippetByCitationId = new Map<string, string>();
  for (const cit of candidate.citations) {
    snippetByCitationId.set(cit.evidenceId, cit.exactSnippet);
  }

  // Collect ALL snippet text for fallback grounding (entire dimension)
  const allSnippetText = Array.from(snippetByCitationId.values()).join(" ");
  const allSnippetNums = extractNumericTokens(allSnippetText);
  const allSnippetNumSet = new Set(allSnippetNums);

  // Helper: check all numbers in text are grounded in cited snippets
  function checkClaim(
    claimId: string,
    text: string,
    citationIds: string[],
  ): void {
    const numbers = extractNumericTokens(text);
    if (numbers.length === 0) return;

    // Collect specifically cited snippet text
    const citedSnippetText = citationIds
      .map((id) => snippetByCitationId.get(id) ?? "")
      .join(" ");

    for (const num of numbers) {
      // Primary: check cited snippets
      const snippetNums = extractNumericTokens(citedSnippetText);
      const foundInCited = snippetNums.some((sn) => sn === num);
      if (foundInCited) continue;

      // Also check raw cited snippet contains the original form
      const rawMatch = citedSnippetText.includes(num) ||
        citedSnippetText.includes(num.replace(/-/g, ""));
      if (rawMatch) continue;

      // Fallback: check ALL dimension snippets
      if (allSnippetNumSet.has(num)) continue;
      if (allSnippetText.includes(num)) continue;

      // Exempt calendar years (common knowledge, not financial claims)
      const plainNum = num.replace(/[^0-9]/g, "");
      if (/^(19|20)\d{2}$/.test(plainNum)) continue;

      errors.push(
        `Numeric token "${num}" in claim "${claimId}" not found in cited evidence snippets`,
      );
    }
  }

  // Check whyStatus
  checkClaim("whyStatus", candidate.whyStatus.text, candidate.whyStatus.citationIds);

  // Check established points
  for (const ep of candidate.establishedPoints) {
    checkClaim(ep.claimId, ep.text, ep.citationIds);
  }

  // Check question explanations
  for (const qa of candidate.questionAssessments) {
    checkClaim(qa.questionId, qa.explanation, qa.citationIds);
  }

  // Check IC implication
  checkClaim("icImplication", candidate.icImplication.text, candidate.icImplication.citationIds);

  return errors;
}

// ═══════════════════════════════════════════════════════════════════
// 7. CONTENT FORMAT VALIDATION
// ═══════════════════════════════════════════════════════════════════

function validateContentFormat(
  candidate: RationaleDraftCandidate,
): string[] {
  const errors: string[] = [];

  // Collect all reader-facing text
  const readerTexts: Array<{ label: string; text: string }> = [
    { label: "whyStatus", text: candidate.whyStatus.text },
    { label: "icImplication", text: candidate.icImplication.text },
  ];
  for (const ep of candidate.establishedPoints) {
    readerTexts.push({ label: `established:${ep.claimId}`, text: ep.text });
  }
  for (const gap of candidate.remainingGaps) {
    readerTexts.push({ label: `gap:${gap.gapId}`, text: gap.text });
  }
  for (const qa of candidate.questionAssessments) {
    readerTexts.push({ label: `question:${qa.questionId}`, text: qa.explanation });
  }

  for (const { label, text } of readerTexts) {
    // Score / evidence-row-count language
    for (const pattern of SCORE_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`Score/count language in ${label}: matched ${pattern.source}`);
      }
    }

    // Markdown
    for (const pattern of MARKDOWN_PATTERNS) {
      if (pattern.test(text)) {
        errors.push(`Markdown in ${label}: matched ${pattern.source}`);
      }
    }

    // Raw UUID
    if (UUID_PATTERN.test(text)) {
      errors.push(`Raw UUID in ${label}`);
    }

    // CSV vector
    if (CSV_VECTOR_PATTERN.test(text)) {
      errors.push(`CSV vector in ${label}`);
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════
// 8. DETERMINISTIC DEPTH — Deliverable 8
// ═══════════════════════════════════════════════════════════════════

export function computeCoverageDepth(
  coverageLabel: string,
  questionAssessments: QuestionAssessment[],
): { depth: string; explanation: string } {
  const established = questionAssessments.filter((qa) => qa.status === "established").length;
  const partial = questionAssessments.filter((qa) => qa.status === "partial").length;
  const breadth = established + 0.5 * partial;

  let depth: string;
  if (coverageLabel !== "independent_workproduct") {
    depth = "limited";
  } else if (breadth >= 3.5) {
    depth = "strong";
  } else if (breadth >= 1.5) {
    depth = "moderate";
  } else {
    depth = "limited";
  }

  // Deterministic explanation
  const parts: string[] = [];
  if (established > 0) {
    parts.push(`${established} question${established !== 1 ? "s" : ""} established`);
  }
  if (partial > 0) {
    parts.push(`${partial} partially established`);
  }
  const notEstablished = questionAssessments.filter((qa) => qa.status === "not_established").length;
  if (notEstablished > 0) {
    parts.push(`${notEstablished} not established`);
  }

  const explanation = parts.length > 0
    ? parts.join(" and ") + "."
    : "No question assessments available.";

  return { depth, explanation };
}

// ═══════════════════════════════════════════════════════════════════
// 9. SUPPORT VERIFICATION VALIDATION
// ═══════════════════════════════════════════════════════════════════

export function validateSupportResults(
  candidate: RationaleDraftCandidate,
  supportResults: SupportVerificationResult[],
): string[] {
  const errors: string[] = [];

  // Build set of all positive claim IDs (established points + IC implication)
  const positiveClaimIds = new Set<string>();
  for (const ep of candidate.establishedPoints) {
    positiveClaimIds.add(ep.claimId);
  }
  positiveClaimIds.add("icImplication");

  // Every positive claim must have a support result
  const resultMap = new Map<string, SupportVerificationResult>();
  for (const r of supportResults) {
    resultMap.set(r.claimId, r);
  }

  for (const claimId of positiveClaimIds) {
    const result = resultMap.get(claimId);
    if (!result) {
      errors.push(`No support verification result for claim: ${claimId}`);
      continue;
    }
    if (!result.supported) {
      // IC implication is expected to be an inference. UNSUPPORTED_INFERENCE
      // from the verifier is tolerable if the implication has supporting citations,
      // since the spec explicitly labels it isInference=true.
      if (
        claimId === "icImplication" &&
        result.reasonCode === "UNSUPPORTED_INFERENCE" &&
        candidate.icImplication.citationIds.length > 0
      ) {
        // Downgrade: IC implication is an inference by design — accepted
        continue;
      }
      errors.push(
        `Claim "${claimId}" not supported by verifier: ${result.reasonCode}`,
      );
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════
// 10. MAIN VALIDATION ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate a rationale draft candidate against the curated dimension packet.
 * Pure function. Deterministic. No I/O.
 *
 * Runs schema, citation, numeric, and content-format validation.
 * Support verification is checked separately via validateSupportResults.
 */
export function validateRationaleDraft(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
): ValidationResult {
  const errors: string[] = [];

  errors.push(...validateSchema(candidate, packet));
  errors.push(...validateCitations(candidate, packet));
  errors.push(...validateNumericGrounding(candidate));
  errors.push(...validateContentFormat(candidate));

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Assemble a validated rationale from a draft candidate and its packet.
 * Attaches deterministic fields (state, coverageLabel, depth).
 * Only call AFTER validateRationaleDraft returns valid.
 */
export function assembleValidatedRationale(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
  validationMetadata: ValidationMetadata,
): DimensionRationale {
  const { depth, explanation: _depthExplanation } = computeCoverageDepth(
    packet.coverageLabel,
    candidate.questionAssessments,
  );

  return {
    dimensionId: packet.dimensionId,
    label: packet.label,
    deterministicState: packet.deterministicState,
    coverageLabel: packet.coverageLabel,
    coverageDepth: depth,
    whyStatus: candidate.whyStatus,
    questionAssessments: candidate.questionAssessments,
    establishedPoints: candidate.establishedPoints,
    remainingGaps: candidate.remainingGaps,
    icImplication: candidate.icImplication,
    citations: candidate.citations,
    validationMetadata,
  };
}
