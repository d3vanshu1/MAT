/**
 * MAT-F05: Controlled Narration Boundary
 *
 * Architecture:
 *   CanonicalFindingRecord
 *           |
 *           v
 *   Locked factual narration input (immutable projection)
 *           |
 *           v
 *   LLM narrative generation (restricted output contract)
 *           |
 *           v
 *   Narrative validation (deterministic)
 *           |
 *           +--> accepted narrative
 *           |
 *           +--> deterministic fallback narrative
 *
 * INVARIANT: The LLM may summarize or explain a canonical finding.
 * It MUST NOT originate or alter: claims, evidence quotations,
 * evidence coordinates, evidence authority, numeric values or ranges,
 * compatibility, calculations, verdicts, reportability, finding identity,
 * severity or materiality inputs, factual transaction implications.
 *
 * Canonical structured records remain authoritative at all times.
 */

import type {
  CanonicalFindingRecord,
  CanonicalAdmittedEvidence,
  CanonicalDisposition,
} from "./canonical-finding-record.js";
import type { CanonicalComparison } from "./canonical-comparison.js";
import type { IdentifiedClaim } from "./claims-ledger-identity.js";
import { validateNarrativeOutput, type ValidationResult } from "./narrative-validator.js";

// ===========================================================================
// A. Restricted Narrative Output Contract
// ===========================================================================

/**
 * The ONLY fields the LLM may output.
 * All other factual fields come from the canonical record.
 */
export interface NarrativeOutput {
  /** Short human-readable title (5-12 words) */
  title: string;
  /** 2-3 sentence summary of the finding for IC consumption */
  summary: string;
  /** Extended explanation (paragraph, for full_analysis field) */
  explanation: string;
  /** Optional flag for analyst attention — must not assert facts */
  analyst_attention?: string;
}

/**
 * Fields the LLM MUST NOT output — enforced by contract.
 * If any of these appear in LLM output, they are discarded.
 */
export const PROHIBITED_NARRATIVE_FIELDS = [
  "claim_text",
  "evidence_quotation",
  "evidence_coordinates",
  "source_documents",
  "values",
  "units",
  "deltas",
  "compatibility",
  "verdict",
  "reportability",
  "finding_id",
  "semantic_hash",
  "evidence_verification",
  "authority",
  "severity",
  "verified",
  "claim_id",
  "evidence_id",
  "comparison_basis",
] as const;

// ===========================================================================
// B. Locked Factual Narration Input
// ===========================================================================

/**
 * Immutable factual projection of a canonical finding record.
 * This is the ONLY data the LLM receives for narration.
 * Every element is drawn directly from the canonical record.
 */
export interface LockedNarrationInput {
  /** Exact claim text from IC document (immutable) */
  exact_claim_text: string;
  /** Claim metric */
  claim_metric: string | null;
  /** Claim period */
  claim_period: string | null;
  /** Claim entity/scope */
  claim_entity: string | null;
  /** Claim value (numeric) */
  claim_value: number | null;
  /** Claim unit */
  claim_unit: string | null;

  /** Admitted evidence excerpts with their source coordinates */
  admitted_evidence: Array<{
    evidence_id: string;
    source_document_name: string;
    coordinate_label: string;
    exact_excerpt: string;
    evidence_role: string;
    authority_class: string;
    value: number | null;
    unit: string | null;
  }>;

  /** Normalized calculation results */
  calculations: Array<{
    normalized_claim_value: number | null;
    normalized_fact_value: number | null;
    signed_delta: number | null;
    percentage_delta: number | null;
    direction: string;
  }>;

  /** Deterministic verdict (from comparison, NOT from LLM) */
  deterministic_verdict: string;

  /** Comparison basis labels */
  comparison_basis: string | null;

  /** Whether comparison is compatible */
  comparison_compatible: boolean;

  /** Disposition (reportability) */
  reportable: boolean;
  disposition_reason_codes: string[];

  /** Source document names referenced by evidence */
  source_document_names: string[];

  /** All entities referenced in the canonical record */
  referenced_entities: string[];

  /** All periods referenced in the canonical record */
  referenced_periods: string[];

  /** All numeric values present in the canonical record (for validation) */
  all_canonical_numbers: number[];

  /** Allowed evidence roles */
  evidence_roles: string[];
}

/**
 * Build a locked narration input from a canonical finding record.
 * Every field is directly extracted from the immutable canonical data.
 * No prose reconstruction, no LLM-derived fields.
 */
export function buildLockedNarrationInput(record: CanonicalFindingRecord): LockedNarrationInput {
  const claim = record.claim;
  const evidence = record.evidence;
  const comparisons = record.comparisons;
  const disposition = record.disposition;

  // Collect ALL numeric values from the canonical record for validation
  const allNumbers: number[] = [];
  if (claim.value != null) allNumbers.push(claim.value);

  const admittedEvidence = evidence.map(e => {
    // value: proposition.value may be string|number|null — coerce to number
    const rawVal = e.canonical_record.proposition.value;
    const value = rawVal != null && rawVal !== "" ? Number(rawVal) : null;
    if (value != null && !isNaN(value)) allNumbers.push(value);

    // verbatim text: prefer PDF exact_quote, fall back to proposition description
    let exactExcerpt = "";
    const coord = e.canonical_record.coordinate;
    if (coord.kind === "pdf") {
      exactExcerpt = coord.exact_quote;
    } else if (coord.kind === "workbook") {
      // Workbook: describe from sheet/cell/value (do not fabricate a prose quote)
      const displayed = coord.displayed_value != null ? String(coord.displayed_value) : "";
      exactExcerpt = `${coord.sheet}/${coord.cell_or_range}${displayed ? `: ${displayed}` : ""}`;
    }

    return {
      evidence_id: e.evidence_id,
      source_document_name: e.source_document_name,
      coordinate_label: formatCoordinate(e.coordinate),
      exact_excerpt: exactExcerpt,
      evidence_role: e.evidence_role,
      authority_class: e.authority_class,
      value: isNaN(value as number) ? null : value,
      unit: e.canonical_record.proposition.unit ?? null,
    };
  });

  const calculations = comparisons.map(comp => {
    const calc = comp.calculation;
    if (calc.normalized_claim_value != null) allNumbers.push(calc.normalized_claim_value);
    if (calc.normalized_fact_value != null) allNumbers.push(calc.normalized_fact_value);
    if (calc.signed_delta != null) allNumbers.push(calc.signed_delta);
    if (calc.percentage_delta != null) allNumbers.push(calc.percentage_delta);
    return {
      normalized_claim_value: calc.normalized_claim_value,
      normalized_fact_value: calc.normalized_fact_value,
      signed_delta: calc.signed_delta,
      percentage_delta: calc.percentage_delta,
      direction: calc.direction,
    };
  });

  // Collect all source document names
  const sourceDocNames = [...new Set(evidence.map(e => e.source_document_name))];

  // Collect all entities referenced
  const entities: string[] = [];
  if (claim.entity_or_segment) entities.push(claim.entity_or_segment);
  for (const e of evidence) {
    if (e.target_entity) entities.push(e.target_entity);
    if (e.target_segment) entities.push(e.target_segment);
  }

  // Collect all periods
  const periods: string[] = [];
  if (claim.period) periods.push(claim.period);
  for (const e of evidence) {
    const ep = e.canonical_record.proposition.period;
    if (ep) periods.push(ep);
  }

  // Comparison basis
  const compBasis = comparisons.length > 0
    ? (comparisons[0] as any).claim_comparison_basis ?? null
    : null;

  // Compatibility
  const compCompatible = comparisons.length > 0
    ? comparisons.every(c => c.compatibility.allowed)
    : false;

  // Deterministic verdict
  const verdict = disposition.verdict;

  return {
    exact_claim_text: claim.verbatim_snippet,
    claim_metric: claim.metric ?? null,
    claim_period: claim.period ?? null,
    claim_entity: claim.entity_or_segment ?? null,
    claim_value: claim.value ?? null,
    claim_unit: claim.unit ?? null,
    admitted_evidence: admittedEvidence,
    calculations,
    deterministic_verdict: verdict,
    comparison_basis: compBasis,
    comparison_compatible: compCompatible,
    reportable: disposition.reportable,
    disposition_reason_codes: disposition.reason_codes,
    source_document_names: sourceDocNames,
    referenced_entities: [...new Set(entities)],
    referenced_periods: [...new Set(periods)],
    all_canonical_numbers: [...new Set(allNumbers)],
    evidence_roles: [...new Set(evidence.map(e => e.evidence_role))],
  };
}

// ===========================================================================
// C. Narration Result
// ===========================================================================

export interface NarrationSuccess {
  status: "accepted";
  narrative: NarrativeOutput;
  validation: ValidationResult;
  /** Invariant flag: canonical record was not modified */
  canonical_unchanged: true;
}

export interface NarrationRejection {
  status: "rejected";
  narrative: NarrativeOutput; // deterministic fallback
  validation: ValidationResult;
  fallback_reason: string;
  rejected_narrative: NarrativeOutput; // the LLM output that was rejected
  /** Invariant flag: canonical record was not modified */
  canonical_unchanged: true;
}

export type NarrationResult = NarrationSuccess | NarrationRejection;

// ===========================================================================
// D. Narration Boundary — the complete controlled pipeline
// ===========================================================================

/**
 * Process an LLM-generated narrative through the controlled narration boundary.
 *
 * Overloads:
 *   1. processNarration(record: CanonicalFindingRecord, llmOutput: NarrativeOutput)
 *   2. processNarration(llmOutput: NarrativeOutput, lockedInput: LockedNarrationInput) — test/diagnostic path
 *
 * The canonical record is NEVER modified regardless of outcome.
 */
export function processNarration(
  narrativeOrRecord: NarrativeOutput | CanonicalFindingRecord,
  llmOutputOrLockedInput: NarrativeOutput | LockedNarrationInput,
): NarrationResult;
export function processNarration(
  first: any,
  second: any,
): NarrationResult {
  // Overload: if `second` has `exact_claim_text`, it's a LockedNarrationInput
  if (second && typeof second === "object" && "exact_claim_text" in second) {
    const llmOutput = first as NarrativeOutput;
    const lockedInput = second as LockedNarrationInput;
    const validation = validateNarrativeOutput(llmOutput, lockedInput);

    if (validation.passed) {
      return {
        status: "accepted",
        narrative: llmOutput,
        validation,
        canonical_unchanged: true,
      };
    }

    const fallbackNarrative = generateDeterministicFallbackNarrative(lockedInput);
    const fallbackValidation = validateNarrativeOutput(fallbackNarrative, lockedInput);
    return {
      status: "rejected",
      narrative: fallbackNarrative,
      validation: fallbackValidation,
      fallback_reason: validation.reason_codes.join("; "),
      rejected_narrative: llmOutput,
      canonical_unchanged: true,
    };
  }

  // Standard path: first is CanonicalFindingRecord, second is NarrativeOutput
  const record = first as CanonicalFindingRecord;
  const llmOutput = second as NarrativeOutput;
  const lockedInput = buildLockedNarrationInput(record);
  const validation = validateNarrativeOutput(llmOutput, lockedInput);

  if (validation.passed) {
    return {
      status: "accepted",
      narrative: llmOutput,
      validation,
      canonical_unchanged: true,
    };
  }

  const fallbackNarrative = generateDeterministicFallbackNarrative(lockedInput);
  const fallbackValidation = validateNarrativeOutput(fallbackNarrative, lockedInput);
  return {
    status: "rejected",
    narrative: fallbackNarrative,
    validation: fallbackValidation,
    fallback_reason: validation.reason_codes.join("; "),
    rejected_narrative: llmOutput,
    canonical_unchanged: true,
  };
}

// ===========================================================================
// E. Deterministic Fallback Narrative
// ===========================================================================

/**
 * Generate a factual, plain narrative directly from the canonical record.
 * Every element comes from the locked narration input.
 * No LLM involved. No inference. No characterization.
 */
export function generateDeterministicFallbackNarrative(
  input: LockedNarrationInput,
): NarrativeOutput {
  const parts: string[] = [];

  // 1. State the IC claim
  const claimValueStr = input.claim_value != null
    ? formatNumber(input.claim_value, input.claim_unit)
    : null;

  if (claimValueStr) {
    const periodStr = input.claim_period ? ` of ${input.claim_period}` : "";
    const metricStr = input.claim_metric ? ` ${input.claim_metric}` : "";
    parts.push(`The IC memo states${metricStr}${periodStr}: ${claimValueStr}.`);
  } else {
    parts.push(`The IC memo states: \u201c${truncate(input.exact_claim_text, 120)}\u201d.`);
  }

  // 2. State the evidence (first admitted piece)
  if (input.admitted_evidence.length > 0) {
    const ev = input.admitted_evidence[0];
    const evValueStr = ev.value != null
      ? formatNumber(ev.value, ev.unit)
      : `"${truncate(ev.exact_excerpt, 80)}"`;
    const coordStr = ev.coordinate_label ? ` at [${ev.coordinate_label}]` : "";
    parts.push(`The ${ev.source_document_name} records ${evValueStr}${coordStr}.`);
  }

  // 3. State calculation if present
  if (input.calculations.length > 0) {
    const calc = input.calculations[0];
    if (calc.signed_delta != null && calc.normalized_claim_value != null && calc.normalized_fact_value != null) {
      const deltaStr = formatNumber(Math.abs(calc.signed_delta), input.claim_unit);
      const dirStr = calc.direction === "claim_higher" ? "higher in memo"
        : calc.direction === "claim_lower" ? "lower in memo"
        : "";
      parts.push(`A ${deltaStr} difference${dirStr ? ` (${dirStr})` : ""}.`);
    }
  }

  // 4. State deterministic verdict
  parts.push(`The deterministic verdict is ${input.deterministic_verdict}.`);

  const summary = parts.join(" ");

  // Title — factual, no characterization
  const metricTitle = input.claim_metric
    ? input.claim_metric.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Claim";
  const periodTitle = input.claim_period ? ` — ${input.claim_period}` : "";
  const verdictTitle = input.deterministic_verdict.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const title = `${metricTitle}${periodTitle}: ${verdictTitle}`;

  return {
    title: truncate(title, 80),
    summary,
    explanation: summary, // Deterministic fallback uses same text for explanation
  };
}

// ===========================================================================
// F. Process/Fallback Object Exclusion
// ===========================================================================

/**
 * Patterns that identify process/operational text that must NEVER become
 * a substantive reportable finding.
 */
const PROCESS_PATTERNS = [
  /^analysis\s+complete$/i,
  /^no\s+findings?$/i,
  /^processing\s+complete$/i,
  /^stage\s+\d+\s+complete$/i,
  /^all\s+claims?\s+processed$/i,
  /degraded[\s-]?run/i,
  /parser\s+error/i,
  /^fallback[\s:]|generic\s+fallback/i,
  /^completion\s+summar/i,
  /^batch\s+\d+\s+processed$/i,
  /no\s+contradictions?\s+found/i,
  /analysis\s+not\s+applicable/i,
] as const;

/**
 * Returns true if the text is a process/operational message
 * that must NOT become a substantive finding.
 */
export function isProcessObject(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  const trimmed = text.trim();
  return PROCESS_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Returns true if a finding object should be excluded from substantive output.
 * Checks title, detail, and key structural indicators.
 */
export function shouldExcludeAsProcessObject(finding: {
  title?: string;
  detail?: string;
  full_analysis?: string;
  severity?: string;
  source_docs?: string[];
  claim_ids?: string[];
}): boolean {
  // Empty or missing title
  if (!finding.title || finding.title.trim().length === 0) return true;

  // Title matches process patterns
  if (isProcessObject(finding.title)) return true;

  // Detail is a process message and no substantive content
  if (finding.detail && isProcessObject(finding.detail) && !finding.full_analysis) return true;

  // No source docs AND no claim linkage AND no substantive detail
  if (
    (!finding.source_docs || finding.source_docs.length === 0) &&
    (!finding.claim_ids || finding.claim_ids.length === 0) &&
    (!finding.full_analysis || finding.full_analysis.length < 20)
  ) return true;

  return false;
}

// ===========================================================================
// G. Evidence Role Guard
// ===========================================================================

/**
 * Validates that narrative text does not violate canonical evidence roles.
 *
 * Rules:
 * - supporting evidence cannot be described as contradictory
 * - contextual evidence cannot be described as proving a company-specific claim
 * - verifying evidence may support confirmation
 * - contradicting evidence may support an adverse finding
 * - rejected evidence must never appear substantively
 */
export interface EvidenceRoleViolation {
  evidence_id: string;
  canonical_role: string;
  violation: string;
}

const ADVERSE_PATTERNS = [
  /contradict/i,
  /disprove/i,
  /refute/i,
  /undermine/i,
  /invalidate/i,
  /overstated/i,
  /materially\s+different/i,
  /adverse/i,
  /shortfall/i,
  /gap\s+between/i,
];

const PROVING_PATTERNS = [
  /proves?\b/i,
  /confirms?\b/i,
  /establishes?\b/i,
  /demonstrates?\b/i,
  /directly\s+shows?/i,
  /verif(?:y|ied|ies)\b/i,
];

/**
 * Check if narrative text violates evidence role constraints.
 */
export function checkEvidenceRoleViolations(
  narrativeText: string,
  lockedInput: LockedNarrationInput,
): EvidenceRoleViolation[] {
  const violations: EvidenceRoleViolation[] = [];

  for (const ev of lockedInput.admitted_evidence) {
    // Check if evidence source is mentioned in the narrative
    const sourceMentioned = narrativeText.includes(ev.source_document_name) ||
      narrativeText.includes(ev.evidence_id);

    if (!sourceMentioned) continue;

    // Supporting evidence cannot be described as adverse/contradictory
    if (ev.evidence_role === "supporting" || ev.evidence_role === "corroborating") {
      for (const pattern of ADVERSE_PATTERNS) {
        if (pattern.test(narrativeText)) {
          // Check if the adverse language is specifically about this evidence
          const evContext = extractContextAroundSource(narrativeText, ev.source_document_name);
          if (evContext && ADVERSE_PATTERNS.some(p => p.test(evContext))) {
            violations.push({
              evidence_id: ev.evidence_id,
              canonical_role: ev.evidence_role,
              violation: `Supporting/corroborating evidence described as adverse: matched "${pattern.source}"`,
            });
            break;
          }
        }
      }
    }

    // Contextual/market evidence cannot prove a company-specific proposition
    if (ev.evidence_role === "contextual") {
      const evContext = extractContextAroundSource(narrativeText, ev.source_document_name);
      if (evContext && PROVING_PATTERNS.some(p => p.test(evContext))) {
        violations.push({
          evidence_id: ev.evidence_id,
          canonical_role: "contextual",
          violation: "Contextual/market evidence described as proving a specific proposition",
        });
      }
    }
  }

  return violations;
}

// ===========================================================================
// H. Narration Prompt Builder
// ===========================================================================

/**
 * Build the system prompt for LLM narrative generation.
 * Explicitly prohibits the LLM from introducing facts not in the locked input.
 */
export function buildNarrationPrompt(lockedInput: LockedNarrationInput): string {
  return `You are generating a brief narrative summary of an already-validated canonical finding.

## IMMUTABLE FACTS (you MUST NOT alter, contradict, or add to these)

Claim: "${lockedInput.exact_claim_text}"
${lockedInput.claim_value != null ? `Claim value: ${lockedInput.claim_value}${lockedInput.claim_unit ? ` ${lockedInput.claim_unit}` : ""}` : ""}
${lockedInput.claim_metric ? `Metric: ${lockedInput.claim_metric}` : ""}
${lockedInput.claim_period ? `Period: ${lockedInput.claim_period}` : ""}

Evidence:
${lockedInput.admitted_evidence.map(e =>
  `- [${e.source_document_name}] at ${e.coordinate_label}: "${truncate(e.exact_excerpt, 200)}" (role: ${e.evidence_role})${e.value != null ? ` value=${e.value}` : ""}`
).join("\n")}

Calculations:
${lockedInput.calculations.map(c =>
  `- Claim: ${c.normalized_claim_value}, Fact: ${c.normalized_fact_value}, Delta: ${c.signed_delta}, Pct: ${c.percentage_delta}%, Direction: ${c.direction}`
).join("\n")}

Verdict: ${lockedInput.deterministic_verdict}
Reportable: ${lockedInput.reportable}

## ABSOLUTE PROHIBITIONS

You MUST NOT:
1. Introduce ANY number not listed above
2. Introduce ANY percentage, range, or basis point not in the calculations
3. Quote text that is not an exact substring of the claim or evidence excerpts above
4. Name sources not listed above
5. Name entities not referenced above
6. Reference periods not listed above
7. Contradict the deterministic verdict "${lockedInput.deterministic_verdict}"
8. Claim "verified", "confirmed by source", "verbatim", or "source proves" unless the verdict is "confirmed"
9. Describe supporting evidence as adverse or contradictory
10. Generate severity or materiality labels

## OUTPUT FORMAT

Provide exactly:
- title: 5-12 word factual title
- summary: 2-3 sentence plain summary referencing only the facts above
- explanation: One paragraph elaboration for the full analysis
- analyst_attention: (optional) One sentence noting what deserves human review

Every factual element in your output MUST come from the immutable facts above.`;
}

// ===========================================================================
// Internal Helpers
// ===========================================================================

function formatCoordinate(coord: { type: string; label: string } | any): string {
  if (!coord) return "";
  if (typeof coord === "string") return coord;
  if (coord.label) return coord.label;
  if (coord.type === "cell" && coord.sheet && coord.cell) return `${coord.sheet}/${coord.cell}`;
  if (coord.type === "page" && coord.page) return `page ${coord.page}`;
  return JSON.stringify(coord);
}

function formatNumber(value: number, unit: string | null): string {
  const absVal = Math.abs(value);
  let formatted: string;
  if (absVal >= 1_000_000) {
    formatted = `£${(value / 1_000_000).toFixed(1)}m`;
  } else if (absVal >= 1_000) {
    formatted = `£${(value / 1_000).toFixed(0)}k`;
  } else {
    formatted = `£${value}`;
  }
  if (unit && unit !== "GBP" && unit !== "£") {
    formatted = `${value} ${unit}`;
  }
  return formatted;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function extractContextAroundSource(text: string, sourceName: string): string | null {
  const idx = text.indexOf(sourceName);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + sourceName.length + 100);
  return text.slice(start, end);
}
