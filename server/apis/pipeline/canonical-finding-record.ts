/**
 * MAT-F04: Lossless Canonical Finding Record and Stable Identity
 *
 * This module defines the canonical finding/comparison envelope that preserves
 * ALL structured data through downstream persistence, grouping, checkpoint
 * reload, and output retrieval.
 *
 * Architecture:
 *   A. Type definitions — CanonicalFindingRecord envelope
 *   B. Construction — buildCanonicalFindingRecord from components
 *   C. Identity — content-derived finding_id and semantic_hash
 *   D. Proposition key — multi-dimension grouping key
 *   E. Serialization — lossless persist/reload
 *   F. Legacy adapter — derives legacy fields from canonical record
 *   G. Validation — blocks prose-based evidence reconstruction
 *
 * INVARIANT: No downstream stage may replace these records with prose,
 * reconstruct them from narrative, or drop their IDs and coordinates.
 */

import { sha256hex } from "./sha256-pure.js";
import type { CanonicalComparison, VerdictValue } from "./canonical-comparison.js";
import type { CanonicalEvidenceRecord, EvidenceCoordinate } from "./canonical-evidence.js";
import type { AdmittedEvidenceRecord } from "./evidence-admission-boundary.js";
import type { IdentifiedClaim } from "./claims-ledger-identity.js";

// ===========================================================================
// Schema Version
// ===========================================================================

export const CANONICAL_FINDING_SCHEMA_VERSION = "canonical-finding-v1" as const;
export const IDENTITY_VERSION = "identity-v1.0" as const;

// ===========================================================================
// A. Types
// ===========================================================================

/**
 * Canonical finding disposition — deterministic, code-derived.
 * No LLM, no narrative, no text inference.
 */
export interface CanonicalDisposition {
  verdict: VerdictValue;
  reportable: boolean;
  reason_codes: string[];
  rule_version: string;
}

/**
 * Content-derived stable identity for a finding.
 * Equivalent records MUST receive the same identity across fresh construction and reload.
 */
export interface CanonicalFindingIdentity {
  /** Deterministic finding ID: `cfr-v1-{hex16}` */
  finding_id: string;
  /** Multi-dimension proposition key for grouping */
  proposition_key: string;
  /** Content-derived semantic hash for change detection */
  semantic_hash: string;
  /** Identity schema version */
  identity_version: typeof IDENTITY_VERSION;
}

/**
 * Optional narrative — kept strictly separate from factual provenance.
 * Narrative may describe the canonical record but CANNOT create or modify
 * claim IDs, evidence IDs, coordinates, values, compatibility, verdict, or reportability.
 */
export interface FindingNarrative {
  title?: string;
  summary?: string;
  detail?: string;
}

/**
 * Admitted evidence reference within a canonical finding.
 * Only admitted evidence may appear here — rejected evidence stays in terminal ledger.
 */
export interface CanonicalAdmittedEvidence {
  evidence_id: string;
  source_document_id: string;
  source_document_name: string;
  authority_class: string;
  coordinate: EvidenceCoordinate;
  target_entity: string | null;
  target_segment: string | null;
  evidence_role: string;
  /** Full canonical evidence record — lossless */
  canonical_record: CanonicalEvidenceRecord;
  /** Entity bridge reference if applicable */
  bridge_evidence_id: string | null;
}

/**
 * The complete canonical finding/comparison envelope.
 *
 * A reviewer can reconstruct every downstream numeric finding from:
 *   - one exact canonical IC claim
 *   - one or more admitted canonical evidence records
 *   - the explicit compatibility decision
 *   - the deterministic calculation
 *   - the deterministic verdict
 *
 * No downstream stage may replace these records with prose.
 */
export interface CanonicalFindingRecord {
  schema_version: typeof CANONICAL_FINDING_SCHEMA_VERSION;

  /** Content-derived stable identity */
  identity: CanonicalFindingIdentity;

  /** Complete canonical IC claim — lossless */
  claim: IdentifiedClaim;

  /** Admitted evidence only — rejected evidence stays in terminal ledger */
  evidence: CanonicalAdmittedEvidence[];

  /** Complete comparison records — lossless */
  comparisons: CanonicalComparison[];

  /** Deterministic disposition from canonical comparison */
  disposition: CanonicalDisposition;

  /** Optional narrative — strictly separate from factual provenance */
  narrative?: FindingNarrative;

  /** Legacy Q3 metadata (diagnostic only, not source of truth) */
  _legacy_diagnostic?: {
    legacy_disposition?: string;
    legacy_q4_eligible?: boolean;
    legacy_reason?: string;
  };
}

// ===========================================================================
// B. Construction
// ===========================================================================

export interface BuildCanonicalFindingInput {
  claim: IdentifiedClaim;
  admittedEvidence: AdmittedEvidenceRecord[];
  comparisons: CanonicalComparison[];
  disposition: CanonicalDisposition;
  narrative?: FindingNarrative;
  legacyDiagnostic?: {
    legacy_disposition?: string;
    legacy_q4_eligible?: boolean;
    legacy_reason?: string;
  };
}

/**
 * Build a complete CanonicalFindingRecord from its components.
 *
 * This is the single construction point — no downstream stage may
 * reconstruct finding data from prose or narrative.
 */
export function buildCanonicalFindingRecord(
  input: BuildCanonicalFindingInput,
): CanonicalFindingRecord {
  // Map admitted evidence to canonical format
  const evidence: CanonicalAdmittedEvidence[] = input.admittedEvidence.map(ae => ({
    evidence_id: ae.evidence_id,
    source_document_id: ae.source_document_id,
    source_document_name: ae.source_document_name,
    authority_class: ae.authority_class,
    coordinate: ae.coordinate,
    target_entity: ae.canonical_record.target.entity,
    target_segment: ae.canonical_record.target.segment,
    evidence_role: ae.evidence_role,
    canonical_record: ae.canonical_record,
    bridge_evidence_id: ae.entity_applicability.bridge_evidence_id,
  }));

  // Generate stable identity
  const identity = generateFindingIdentity(input.claim, evidence, input.comparisons, input.disposition);

  return {
    schema_version: CANONICAL_FINDING_SCHEMA_VERSION,
    identity,
    claim: input.claim,
    evidence,
    comparisons: input.comparisons,
    disposition: input.disposition,
    narrative: input.narrative,
    _legacy_diagnostic: input.legacyDiagnostic,
  };
}

// ===========================================================================
// C. Identity — Content-derived finding ID and semantic hash
// ===========================================================================

/**
 * Generate deterministic finding identity from immutable factual content.
 *
 * INCLUDES:
 *   - canonical claim ID
 *   - sorted admitted evidence IDs
 *   - comparison type/basis
 *   - normalized proposition dimensions
 *   - deterministic verdict
 *   - identity schema version
 *
 * EXCLUDES:
 *   - runtime order
 *   - timestamps
 *   - generated title
 *   - generated summary
 *   - array insertion order
 *   - mutable severity wording
 */
function generateFindingIdentity(
  claim: IdentifiedClaim,
  evidence: CanonicalAdmittedEvidence[],
  comparisons: CanonicalComparison[],
  disposition: CanonicalDisposition,
): CanonicalFindingIdentity {
  // Sort evidence IDs for order independence
  const sortedEvidenceIds = evidence
    .map(e => e.evidence_id)
    .sort();

  // Generate proposition key from claim dimensions
  const proposition_key = generatePropositionKey(claim, comparisons);

  // Generate semantic hash from ALL identity-relevant fields
  const semantic_hash = generateSemanticHash(
    claim,
    sortedEvidenceIds,
    comparisons,
    disposition,
    proposition_key,
  );

  // Generate finding_id from semantic hash
  const finding_id = `cfr-v1-${semantic_hash.slice(0, 16)}`;

  return {
    finding_id,
    proposition_key,
    semantic_hash,
    identity_version: IDENTITY_VERSION,
  };
}

// ===========================================================================
// D. Proposition Key
// ===========================================================================

/**
 * Generate a multi-dimension proposition key that prevents accidental overmerge.
 *
 * INCLUDES at minimum:
 *   - entity
 *   - metric
 *   - period
 *   - segment
 *   - scope
 *   - unit
 *   - actual/forecast status
 *   - accounting basis
 *   - comparison basis
 *
 * Distinct comparison families (memo-vs-model, live-vs-reference, etc.)
 * MUST produce distinct proposition keys even if they share period/metric.
 */
export function generatePropositionKey(
  claim: IdentifiedClaim,
  comparisons: CanonicalComparison[],
): string {
  // Derive the normalized comparison basis pair from the first comparison.
  // This distinguishes: memo_claim vs current_model, current_model vs reference_forecast, etc.
  const firstComp = comparisons[0];
  const normalizedBasisPair = firstComp
    ? deriveNormalizedComparisonBasisPair(firstComp)
    : "no_comparison";

  const parts = [
    normalize(claim.entity_or_segment ?? claim.scope_qualifier ?? "scg"),
    normalize(claim.metric),
    normalize(claim.period),
    normalize((claim as any).segment ?? "all"),
    normalize(claim.scope_qualifier ?? "group"),
    normalize(claim.unit),
    normalize(claim.actual_or_forecast ?? "unknown"),
    normalize(claim.accounting_basis ?? "unspecified"),
    normalize(normalizedBasisPair),
  ];

  return parts.join("|");
}

/**
 * Derive a normalized comparison basis pair string from a CanonicalComparison.
 * 
 * This creates a directional key that distinguishes:
 *   memo_claim__current_model
 *   current_model__reference_forecast
 *   current_model__prior_model
 *   memo_claim__reference_forecast
 *
 * This ensures that:
 *   - memo revenue vs current model → distinct from
 *   - live revenue vs frozen reference → distinct from
 *   - current model vs prior model
 */
function deriveNormalizedComparisonBasisPair(comparison: CanonicalComparison): string {
  const claimBasis = comparison.claim_comparison_basis ?? "unknown";
  const evidenceBasis = comparison.evidence_comparison_basis ?? "unknown";
  
  // Sort alphabetically to ensure stable key regardless of which side is claim/evidence
  // NO — we want directionality. claim_basis first, evidence_basis second.
  return `${claimBasis}__${evidenceBasis}`;
}

function normalize(value: string): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "null";
}

// ===========================================================================
// E. Semantic Hash — deterministic, content-derived
// ===========================================================================

/**
 * Generate a SHA-256-based semantic hash from immutable factual content.
 *
 * Same factual content → same hash across:
 *   - fresh construction
 *   - persistence/reload
 *   - reordered evidence
 *   - changed title/summary
 *   - changed timestamp
 *
 * Different hash when any of:
 *   - claim ID changes
 *   - admitted evidence set changes
 *   - metric changes
 *   - accounting basis changes
 *   - comparison basis changes
 *   - deterministic verdict changes
 */
function generateSemanticHash(
  claim: IdentifiedClaim,
  sortedEvidenceIds: string[],
  comparisons: CanonicalComparison[],
  disposition: CanonicalDisposition,
  propositionKey: string,
): string {
  // Build a deterministic payload from ONLY immutable factual content
  const payload = [
    IDENTITY_VERSION,
    CANONICAL_FINDING_SCHEMA_VERSION,
    // Claim identity
    claim.claim_id,
    claim.ic_document_id,
    claim.metric,
    claim.period,
    claim.value?.toString() ?? "null",
    claim.unit,
    claim.scope_qualifier ?? "null",
    claim.accounting_basis ?? "null",
    claim.actual_or_forecast ?? "null",
    // Evidence set (sorted for order independence)
    sortedEvidenceIds.join(","),
    // Comparisons (sorted by comparison_id for stability)
    comparisons
      .map(c => c.comparison_id)
      .sort()
      .join(","),
    // Proposition key
    propositionKey,
    // Disposition verdict
    disposition.verdict,
    disposition.rule_version,
  ].join("|");

  return sha256hex(payload);
}

// ===========================================================================
// F. Serialization — Lossless persist/reload
// ===========================================================================

/**
 * Serialize a canonical finding record to JSON string.
 * The serialization preserves ALL fields — no lossy reduction.
 */
export function serializeCanonicalFinding(record: CanonicalFindingRecord): string {
  return JSON.stringify(record);
}

/**
 * Deserialize a canonical finding record from JSON string.
 * Returns the complete record — identity, claim, evidence, comparisons, disposition.
 */
export function deserializeCanonicalFinding(json: string): CanonicalFindingRecord {
  return JSON.parse(json) as CanonicalFindingRecord;
}

/**
 * Serialize an array of canonical finding records (ledger).
 */
export function serializeCanonicalFindingLedger(records: CanonicalFindingRecord[]): string {
  return JSON.stringify(records);
}

/**
 * Deserialize canonical finding ledger from JSON.
 */
export function deserializeCanonicalFindingLedger(json: string): CanonicalFindingRecord[] {
  return JSON.parse(json) as CanonicalFindingRecord[];
}

/**
 * Validate that a deserialized record's semantic hash matches fresh computation.
 * Returns true if identity is stable (lossless round-trip).
 */
export function validateIdentityStability(record: CanonicalFindingRecord): boolean {
  const evidence: CanonicalAdmittedEvidence[] = record.evidence;
  const sortedEvidenceIds = evidence.map(e => e.evidence_id).sort();
  const propositionKey = generatePropositionKey(record.claim, record.comparisons);
  const freshHash = generateSemanticHash(
    record.claim,
    sortedEvidenceIds,
    record.comparisons,
    record.disposition,
    propositionKey,
  );
  return freshHash === record.identity.semantic_hash;
}

// ===========================================================================
// G. Legacy Adapter — derives legacy fields FROM canonical record
// ===========================================================================

/**
 * Derive legacy finding fields from a canonical record.
 * Legacy fields are DERIVED — the canonical record remains source of truth.
 * This adapter exists for temporary backwards compatibility with Q4/Q5 stages
 * that have not yet been migrated to consume the canonical envelope directly.
 */
export interface LegacyDerivedFinding {
  finding_id: string;
  title: string;
  claim_id: string;
  claim_text: string;
  ic_document_id: string;
  ic_document_filename: string;
  memo_version: string | null;
  evidence_text: string;
  evidence_source_ids: string[];
  authority_class: string;
  verdict: VerdictValue;
  disposition: string;
  q4_eligible: boolean;
  reportable: boolean;
  metric: string;
  period: string;
  value: number;
  unit: string;
  scope: string;
  // Numeric comparison fields
  normalized_claim_value: number | null;
  normalized_fact_value: number | null;
  signed_delta: number | null;
  absolute_delta: number | null;
  percentage_delta: number | null;
  direction: string;
}

/**
 * Derive a legacy finding from a canonical record.
 * ALL fields are derived from the canonical record — nothing is sourced from
 * detail, full_analysis, title text, or generated summaries.
 */
export function deriveLegacyFinding(record: CanonicalFindingRecord): LegacyDerivedFinding {
  // Find the first reportable (compatible numeric) comparison
  const reportableComparison = record.comparisons.find(c => c.reportable);
  const anyComparison = reportableComparison ?? record.comparisons[0] ?? null;

  // Derive evidence text from canonical evidence coordinates
  const evidenceText = record.evidence.map(e => {
    if (e.coordinate.kind === "workbook") {
      return `[${e.source_document_name}] ${e.coordinate.sheet}!${e.coordinate.cell_or_range}`;
    }
    if (e.coordinate.kind === "pdf") {
      return `[${e.source_document_name}] p.${e.coordinate.page}: "${e.coordinate.exact_quote}"`;
    }
    return `[${e.source_document_name}]`;
  }).join(" | ");

  // Determine Q4 eligibility from disposition
  const adverseVerdicts: VerdictValue[] = ["contradicted", "materially_changed", "partially_supported", "unsupported"];
  const q4Eligible = adverseVerdicts.includes(record.disposition.verdict) ||
    record.disposition.verdict === "confirmed";

  // Map verdict to legacy disposition string
  const dispositionMap: Record<VerdictValue, string> = {
    confirmed: "claim_linked_confirmed",
    contradicted: "claim_linked_contradicted",
    materially_changed: "claim_linked_materially_changed",
    partially_supported: "claim_linked_partially_supported",
    unsupported: "claim_linked_unsupported",
    unverifiable: "incompatible_claim_evidence",
  };

  return {
    finding_id: record.identity.finding_id,
    title: record.narrative?.title ?? `${record.claim.metric} ${record.claim.period} — ${record.disposition.verdict}`,
    claim_id: record.claim.claim_id,
    claim_text: record.claim.verbatim_snippet,
    ic_document_id: record.claim.ic_document_id,
    ic_document_filename: record.claim.ic_document_filename,
    memo_version: record.claim.memo_version || null,
    evidence_text: evidenceText,
    evidence_source_ids: record.evidence.map(e => e.evidence_id),
    authority_class: record.evidence[0]?.authority_class ?? "unknown",
    verdict: record.disposition.verdict,
    disposition: dispositionMap[record.disposition.verdict] ?? "incompatible_claim_evidence",
    q4_eligible: q4Eligible,
    reportable: record.disposition.reportable,
    metric: record.claim.metric,
    period: record.claim.period,
    value: record.claim.value,
    unit: record.claim.unit,
    scope: record.claim.scope_qualifier,
    // Numeric fields from the reportable comparison
    normalized_claim_value: anyComparison?.calculation.normalized_claim_value ?? null,
    normalized_fact_value: anyComparison?.calculation.normalized_fact_value ?? null,
    signed_delta: anyComparison?.calculation.signed_delta ?? null,
    absolute_delta: anyComparison?.calculation.absolute_delta ?? null,
    percentage_delta: anyComparison?.calculation.percentage_delta ?? null,
    direction: anyComparison?.calculation.direction ?? "not_applicable",
  };
}

// ===========================================================================
// H. Prose Reconstruction Guard
// ===========================================================================

/**
 * Validation: Ensure that a canonical finding record's factual provenance
 * is NOT derived from narrative fields.
 *
 * Returns true if the record is self-consistent (all provenance from structured fields).
 * Returns false if any evidence coordinate appears sourced from narrative.
 */
export function validateNoProseReconstruction(record: CanonicalFindingRecord): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  // Check 1: Every evidence item must have a structured coordinate
  for (const ev of record.evidence) {
    if (!ev.coordinate || !ev.coordinate.kind) {
      violations.push(`evidence ${ev.evidence_id}: missing structured coordinate`);
    }
    if (ev.coordinate.kind === "pdf" && !ev.coordinate.page) {
      violations.push(`evidence ${ev.evidence_id}: PDF coordinate missing page number`);
    }
    if (ev.coordinate.kind === "workbook" && !ev.coordinate.sheet) {
      violations.push(`evidence ${ev.evidence_id}: workbook coordinate missing sheet`);
    }
  }

  // Check 2: Claim must have structured ID (not reconstructed from text)
  if (!record.claim.claim_id || !record.claim.claim_id.startsWith("clm-")) {
    violations.push(`claim: missing or invalid structured claim_id`);
  }

  // Check 3: Every comparison must have a structured comparison_id
  for (const comp of record.comparisons) {
    if (!comp.comparison_id || !comp.comparison_id.startsWith("cmp-")) {
      violations.push(`comparison: missing or invalid structured comparison_id`);
    }
  }

  // Check 4: Identity must be present and deterministic
  if (!record.identity.finding_id || !record.identity.finding_id.startsWith("cfr-")) {
    violations.push(`identity: missing or invalid finding_id`);
  }
  if (!record.identity.semantic_hash || record.identity.semantic_hash.length < 32) {
    violations.push(`identity: missing or invalid semantic_hash`);
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Strict evidence-only reference builder.
 * This BLOCKS any attempt to reconstruct evidence from:
 *   - detail field
 *   - full_analysis field
 *   - title text
 *   - generated summaries
 *   - generic source arrays
 *   - first-source fallback
 *   - regex extraction from narrative
 *
 * ONLY admitted evidence records from the F02B gate may be used.
 */
export function extractEvidenceFromAdmittedOnly(
  admittedRecords: AdmittedEvidenceRecord[],
): CanonicalAdmittedEvidence[] {
  return admittedRecords.map(ae => ({
    evidence_id: ae.evidence_id,
    source_document_id: ae.source_document_id,
    source_document_name: ae.source_document_name,
    authority_class: ae.authority_class,
    coordinate: ae.coordinate,
    target_entity: ae.canonical_record.target.entity,
    target_segment: ae.canonical_record.target.segment,
    evidence_role: ae.evidence_role,
    canonical_record: ae.canonical_record,
    bridge_evidence_id: ae.entity_applicability.bridge_evidence_id,
  }));
}
