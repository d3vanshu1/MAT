/**
 * MAT-F02B: Production Evidence Admission Boundary
 *
 * This module is the SINGLE production point where extracted evidence
 * passes through the canonical evidence admission gate before influencing
 * claim-linkage disposition, comparison, or eligibility.
 *
 * Flow:
 *   raw legacy evidence (from findings)
 *   → adaptLegacyEvidence (normalize to CanonicalEvidenceRecord inputs)
 *   → admitEvidence (authority / coordinate / entity gate)
 *   → admitted or rejected outcome with stable evidence ID
 *
 * Responsibilities:
 *   A. Convert legacy evidence entries to canonical evidence inputs
 *   B. Resolve authority class from durable document metadata
 *   C. Construct coordinate (PDF or workbook) from legacy fields
 *   D. Invoke the canonical admission gate (MAT-F02)
 *   E. Persist admitted/rejected records
 *   F. Expose admitted-only evidence for downstream use
 *
 * No production path may bypass this gate by relying on generated prose,
 * source titles, generic snippets, or a legacy `verified` flag.
 */

import {
  admitEvidence,
  classifySourceAuthority,
  generateEvidenceId,
  serializeEvidenceRecord,
  deserializeEvidenceRecord,
  type CanonicalEvidenceRecord,
  type EvidenceAdmissionResult,
  type EvidenceRejectionReason,
  type EvidenceAuthorityClass,
  type EvidenceCoordinate,
  type EvidenceRole,
  type PdfCoordinate,
  type WorkbookCoordinate,
} from "./canonical-evidence.js";

// ---------------------------------------------------------------------------
// Legacy Evidence Entry — the shape found in production findings
// ---------------------------------------------------------------------------

export interface LegacyEvidenceEntry {
  figure: string;
  source_doc: string;
  verbatim_snippet: string;
  verified: boolean;
  metric?: string | null;
  period?: string | null;
  document_id?: string | null;
  source_filename?: string | null;
  document_role?: string | null;
  sheet_or_page?: string | null;
  cell_coordinate?: string | null;
  scope?: string | null;
  unit?: string | null;
  currency?: string | null;
  accounting_basis?: string | null;
  actual_or_forecast?: string | null;
  entity?: string | null;
  segment?: string | null;
}

// ---------------------------------------------------------------------------
// Admitted Evidence — downstream production record
// ---------------------------------------------------------------------------

export interface AdmittedEvidenceRecord {
  evidence_id: string;
  source_document_id: string;
  source_document_name: string;
  authority_class: EvidenceAuthorityClass;
  coordinate: EvidenceCoordinate;
  target_entity: string | null;
  evidence_role: EvidenceRole;
  authority_decision: { allowed: boolean; reason_code: string; rule_version: string };
  entity_applicability: {
    allowed: boolean;
    direct_entity_match: boolean;
    bridge_evidence_id: string | null;
    reason_code: string;
  };
  /** The full canonical record for persistence */
  canonical_record: CanonicalEvidenceRecord;
}

// ---------------------------------------------------------------------------
// Rejected Evidence — terminal record for rejected evidence
// ---------------------------------------------------------------------------

export interface RejectedEvidenceRecord {
  evidence_id: string;
  candidate_or_claim_reference: string;
  admission_status: "rejected";
  rejection_reason: EvidenceRejectionReason;
  authority_decision: { allowed: boolean; reason_code: string; rule_version: string } | null;
  entity_applicability: {
    allowed: boolean;
    direct_entity_match: boolean;
    bridge_evidence_id: string | null;
    reason_code: string;
  } | null;
  coordinate_validation: { coordinate_valid: boolean; validation_method: string } | null;
  source_document_id: string;
  source_document_name: string;
  authority_class: EvidenceAuthorityClass;
  legacy_entry: LegacyEvidenceEntry;
}

// ---------------------------------------------------------------------------
// Evidence Admission Outcome — per-entry result
// ---------------------------------------------------------------------------

export interface EvidenceAdmissionOutcome {
  admitted: boolean;
  admitted_record: AdmittedEvidenceRecord | null;
  rejected_record: RejectedEvidenceRecord | null;
}

// ---------------------------------------------------------------------------
// Evidence Admission Context — full run context for the boundary
// ---------------------------------------------------------------------------

export interface EvidenceAdmissionContext {
  /** The claim entity being verified (e.g., "SCG") */
  claim_entity: string | null;
  /** The IC document ID the claim comes from (for self-verification detection) */
  claim_source_document_id: string | null;
  /** The proposition type (claim_type) being verified */
  proposition_type: string;
  /** Candidate or finding reference for the rejection record */
  candidate_reference: string;
  /** Source text for PDF coordinate validation */
  source_text?: string;
  /** Per-page text for page-level PDF validation */
  page_texts?: Map<number, string>;
  /** Available sheets in a workbook */
  available_sheets?: string[];
  /** Cell values keyed by "sheet!cell" */
  cell_values?: Map<string, string | number | null>;
  /** Entity bridges (e.g., "gamma→scg") */
  bridges?: Map<string, { bridge_evidence_id: string; rationale: string }>;
}

// ---------------------------------------------------------------------------
// A. LEGACY-TO-CANONICAL ADAPTER
// ---------------------------------------------------------------------------

/**
 * Resolves the coordinate type from legacy evidence fields.
 *
 * Detection heuristics (ordered):
 *   1. If cell_coordinate is a valid cell reference (A1:B5 style) → workbook
 *   2. If sheet_or_page starts with "Page" or is a number → pdf
 *   3. If source_filename ends in .xlsx/.xlsm/.xls → workbook
 *   4. If source_filename ends in .pdf → pdf
 *   5. Otherwise → cannot determine (fails closed with missing_evidence_coordinate)
 */
function resolveCoordinate(entry: LegacyEvidenceEntry): {
  coordinate: EvidenceCoordinate | null;
  source_type: "pdf" | "workbook" | "other";
} {
  const cellCoord = (entry.cell_coordinate ?? "").trim();
  const sheetOrPage = (entry.sheet_or_page ?? "").trim();
  const filename = (entry.source_filename ?? entry.source_doc ?? "").toLowerCase();

  // Check for workbook coordinate (valid cell format)
  const cellRegex = /^[A-Z]{1,3}\d{1,7}(:[A-Z]{1,3}\d{1,7})?$/i;
  if (cellCoord && cellRegex.test(cellCoord)) {
    // This is a workbook evidence entry
    const sheet = sheetOrPage || "Sheet1";
    const coordinate: WorkbookCoordinate = {
      kind: "workbook",
      sheet,
      cell_or_range: cellCoord,
      displayed_value: entry.figure || null,
      raw_value: entry.figure || null,
    };
    return { coordinate, source_type: "workbook" };
  }

  // Check for PDF coordinate (page reference + quote)
  const pageMatch = sheetOrPage.match(/(?:page\s*)?(\d+)/i);
  if (pageMatch && entry.verbatim_snippet && entry.verbatim_snippet.length >= 10) {
    const page = parseInt(pageMatch[1], 10);
    if (page > 0) {
      const coordinate: PdfCoordinate = {
        kind: "pdf",
        page,
        exact_quote: entry.verbatim_snippet,
      };
      return { coordinate, source_type: "pdf" };
    }
  }

  // Filename-based detection
  if (filename.endsWith(".xlsx") || filename.endsWith(".xlsm") || filename.endsWith(".xls")) {
    // Workbook but no valid cell — construct a minimal coordinate
    if (sheetOrPage && cellCoord) {
      const coordinate: WorkbookCoordinate = {
        kind: "workbook",
        sheet: sheetOrPage,
        cell_or_range: cellCoord,
        displayed_value: entry.figure || null,
        raw_value: entry.figure || null,
      };
      return { coordinate, source_type: "workbook" };
    }
    // No cell coordinate → still workbook type but coordinate is incomplete
    if (sheetOrPage) {
      // Try to construct from sheet + first cell-like value
      const coordinate: WorkbookCoordinate = {
        kind: "workbook",
        sheet: sheetOrPage,
        cell_or_range: cellCoord || "", // Will fail validation (intentionally)
        displayed_value: entry.figure || null,
        raw_value: entry.figure || null,
      };
      return { coordinate, source_type: "workbook" };
    }
    return { coordinate: null, source_type: "workbook" };
  }

  if (filename.endsWith(".pdf")) {
    // PDF but no valid page → try to construct from verbatim_snippet
    if (entry.verbatim_snippet && entry.verbatim_snippet.length >= 10) {
      const coordinate: PdfCoordinate = {
        kind: "pdf",
        page: 0, // Will fail validation (page < 1)
        exact_quote: entry.verbatim_snippet,
      };
      return { coordinate, source_type: "pdf" };
    }
    return { coordinate: null, source_type: "pdf" };
  }

  // Cannot determine source type
  return { coordinate: null, source_type: "other" };
}

/**
 * Determines the evidence role from legacy fields.
 *
 * Uses the `verified` flag, finding_kind context, and document_role to
 * determine whether the evidence is verifying, contradicting, supporting, etc.
 */
function resolveEvidenceRole(
  entry: LegacyEvidenceEntry,
  findingKind?: string | null,
): EvidenceRole {
  // IC memo entries or document_role='ic_memo' are never verifying (self-ref)
  const role = (entry.document_role ?? "").toLowerCase();
  if (role === "ic_memo" || role === "cim" || role === "ic_material") {
    return "contextual";
  }

  // Explicit finding_kind mappings
  if (findingKind === "data_divergence" || findingKind === "numeric_contradiction") {
    return "contradicting";
  }
  if (findingKind === "confirmed_alignment") {
    return "verifying";
  }
  if (findingKind === "partial_alignment") {
    return "verifying";
  }

  // If verified flag is true, this was a verification source
  if (entry.verified) {
    return "verifying";
  }

  // Default: supporting (conservative)
  return "supporting";
}

/**
 * Adapt a single legacy evidence entry to canonical evidence admission inputs.
 *
 * Preserves all available metadata. If required information cannot be resolved,
 * the admission gate itself will reject the record — we do NOT invent missing data.
 */
export function adaptLegacyEvidence(params: {
  entry: LegacyEvidenceEntry;
  finding_kind?: string | null;
  finding_id?: string | null;
  /** Document metadata lookup for richer authority classification */
  document_metadata?: {
    document_tag?: string | null;
    document_type?: string | null;
    is_current_model?: boolean;
  };
}): {
  document_id: string;
  document_name: string;
  authority_class: EvidenceAuthorityClass;
  source_type: "pdf" | "workbook" | "other";
  coordinate: EvidenceCoordinate | null;
  target_entity: string | null;
  target_segment: string | null;
  evidence_role: EvidenceRole;
  proposition: {
    metric: string | null;
    qualitative_proposition: string | null;
    period: string | null;
    scope: string | null;
    unit: string | null;
    currency: string | null;
    scale: string | null;
    actual_forecast_status: "actual" | "forecast" | "mixed" | "not_applicable" | "unknown";
    accounting_basis: string | null;
    value: string | number | null;
  };
} {
  const { entry, finding_kind, document_metadata } = params;

  // Resolve coordinate
  const { coordinate, source_type } = resolveCoordinate(entry);

  // Resolve authority class
  const authority_class = classifySourceAuthority({
    document_tag: document_metadata?.document_tag ?? entry.document_role ?? null,
    document_type: document_metadata?.document_type ?? null,
    document_name: entry.source_filename ?? entry.source_doc ?? "",
    is_current_model: document_metadata?.is_current_model,
    sheet_name: entry.sheet_or_page ?? null,
  });

  // Resolve evidence role
  const evidence_role = resolveEvidenceRole(entry, finding_kind);

  // Resolve actual/forecast status
  let actual_forecast_status: "actual" | "forecast" | "mixed" | "not_applicable" | "unknown" = "unknown";
  if (entry.actual_or_forecast) {
    const aof = entry.actual_or_forecast.toLowerCase();
    if (aof === "actual") actual_forecast_status = "actual";
    else if (aof === "forecast") actual_forecast_status = "forecast";
    else if (aof === "mixed") actual_forecast_status = "mixed";
  } else if (entry.accounting_basis) {
    const ab = entry.accounting_basis.toLowerCase();
    if (ab === "forecast" || ab === "budget" || ab === "plan") actual_forecast_status = "forecast";
    else if (ab === "actual" || ab === "audited") actual_forecast_status = "actual";
  }

  return {
    document_id: entry.document_id ?? `legacy-${(entry.source_doc ?? "unknown").replace(/\s+/g, "_").toLowerCase()}`,
    document_name: entry.source_filename ?? entry.source_doc ?? "unknown",
    authority_class,
    source_type,
    coordinate,
    target_entity: entry.entity ?? null,
    target_segment: entry.segment ?? null,
    evidence_role,
    proposition: {
      metric: entry.metric ?? null,
      qualitative_proposition: null,
      period: entry.period ?? null,
      scope: entry.scope ?? null,
      unit: entry.unit ?? null,
      currency: entry.currency ?? null,
      scale: null,
      actual_forecast_status,
      accounting_basis: entry.accounting_basis ?? null,
      value: entry.figure ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// B. PRODUCTION EVIDENCE ADMISSION — Single entry point
// ---------------------------------------------------------------------------

/**
 * Process a single legacy evidence entry through the canonical admission gate.
 *
 * This is the ONLY function that production should call to admit evidence.
 * It:
 *   1. Adapts legacy evidence to canonical inputs
 *   2. Calls the MAT-F02 admission gate
 *   3. Returns an admitted or rejected outcome with stable evidence ID
 *
 * Rejected evidence gets a stable evidence ID computed from the same inputs
 * (so persistence/reload parity is maintained even for rejects).
 */
export function admitEvidenceAtProductionBoundary(
  entry: LegacyEvidenceEntry,
  context: EvidenceAdmissionContext,
  options?: {
    finding_kind?: string | null;
    finding_id?: string | null;
    document_metadata?: {
      document_tag?: string | null;
      document_type?: string | null;
      is_current_model?: boolean;
    };
  },
): EvidenceAdmissionOutcome {
  const adapted = adaptLegacyEvidence({
    entry,
    finding_kind: options?.finding_kind,
    finding_id: options?.finding_id,
    document_metadata: options?.document_metadata,
  });

  // If no coordinate could be resolved, create a rejected record directly
  if (!adapted.coordinate) {
    const evidence_id = generateEvidenceId({
      document_id: adapted.document_id,
      coordinate: { kind: "pdf", page: 0, exact_quote: "" }, // Placeholder for ID stability
      proposition_type: context.proposition_type,
      evidence_role: adapted.evidence_role,
    });

    const rejected: RejectedEvidenceRecord = {
      evidence_id,
      candidate_or_claim_reference: context.candidate_reference,
      admission_status: "rejected",
      rejection_reason: "missing_evidence_coordinate",
      authority_decision: null,
      entity_applicability: null,
      coordinate_validation: { coordinate_valid: false, validation_method: "no_coordinate_resolvable" },
      source_document_id: adapted.document_id,
      source_document_name: adapted.document_name,
      authority_class: adapted.authority_class,
      legacy_entry: entry,
    };

    return { admitted: false, admitted_record: null, rejected_record: rejected };
  }

  // Call the canonical admission gate
  const result = admitEvidence({
    document_id: adapted.document_id,
    document_name: adapted.document_name,
    authority_class: adapted.authority_class,
    source_type: adapted.source_type,
    coordinate: adapted.coordinate,
    target_entity: adapted.target_entity,
    target_segment: adapted.target_segment,
    claim_entity: context.claim_entity,
    proposition_type: context.proposition_type,
    evidence_role: adapted.evidence_role,
    claim_source_document_id: context.claim_source_document_id,
    source_text: context.source_text,
    page_texts: context.page_texts,
    available_sheets: context.available_sheets,
    cell_values: context.cell_values,
    bridges: context.bridges,
    proposition: adapted.proposition,
  });

  if (result.admitted && result.evidence_record) {
    const admitted: AdmittedEvidenceRecord = {
      evidence_id: result.evidence_record.evidence_id,
      source_document_id: adapted.document_id,
      source_document_name: adapted.document_name,
      authority_class: adapted.authority_class,
      coordinate: adapted.coordinate,
      target_entity: adapted.target_entity,
      evidence_role: adapted.evidence_role,
      authority_decision: result.evidence_record.authority_decision,
      entity_applicability: result.evidence_record.entity_applicability,
      canonical_record: result.evidence_record,
    };

    return { admitted: true, admitted_record: admitted, rejected_record: null };
  }

  // Rejected — build rejected record with stable evidence ID
  const evidence_id = generateEvidenceId({
    document_id: adapted.document_id,
    coordinate: adapted.coordinate,
    proposition_type: context.proposition_type,
    evidence_role: adapted.evidence_role,
  });

  const rejected: RejectedEvidenceRecord = {
    evidence_id,
    candidate_or_claim_reference: context.candidate_reference,
    admission_status: "rejected",
    rejection_reason: result.rejection_reason!,
    authority_decision: result.evidence_record?.authority_decision ?? null,
    entity_applicability: result.evidence_record?.entity_applicability ?? null,
    coordinate_validation: result.evidence_record?.source_validation
      ? { coordinate_valid: result.evidence_record.source_validation.coordinate_valid, validation_method: result.evidence_record.source_validation.validation_method }
      : { coordinate_valid: false, validation_method: result.rejection_detail ?? "unknown" },
    source_document_id: adapted.document_id,
    source_document_name: adapted.document_name,
    authority_class: adapted.authority_class,
    legacy_entry: entry,
  };

  return { admitted: false, admitted_record: null, rejected_record: rejected };
}

// ---------------------------------------------------------------------------
// C. BATCH ADMISSION — Process all evidence for a candidate/finding
// ---------------------------------------------------------------------------

export interface CandidateEvidenceAdmissionResult {
  /** Finding/candidate reference */
  candidate_reference: string;
  /** All admitted evidence (only these may influence disposition) */
  admitted: AdmittedEvidenceRecord[];
  /** All rejected evidence (persisted with reason) */
  rejected: RejectedEvidenceRecord[];
  /** Whether ANY evidence was admitted (gates downstream use) */
  has_admitted_evidence: boolean;
  /** Total evidence entries processed */
  total_processed: number;
}

/**
 * Process ALL evidence entries for a candidate through the admission gate.
 *
 * Returns admitted and rejected evidence separately.
 * Only admitted evidence may influence:
 *   - claim-linkage disposition
 *   - comparison / numeric delta
 *   - verdict
 *   - Q4/Q5 eligibility
 *   - final narrative
 */
export function admitCandidateEvidence(
  evidenceEntries: LegacyEvidenceEntry[],
  context: EvidenceAdmissionContext,
  options?: {
    finding_kind?: string | null;
    finding_id?: string | null;
    document_metadata_map?: Map<string, {
      document_tag?: string | null;
      document_type?: string | null;
      is_current_model?: boolean;
    }>;
  },
): CandidateEvidenceAdmissionResult {
  const admitted: AdmittedEvidenceRecord[] = [];
  const rejected: RejectedEvidenceRecord[] = [];

  for (const entry of evidenceEntries) {
    // Look up document metadata if available
    const docId = entry.document_id ?? `legacy-${(entry.source_doc ?? "").replace(/\s+/g, "_").toLowerCase()}`;
    const docMeta = options?.document_metadata_map?.get(docId) ?? undefined;

    const outcome = admitEvidenceAtProductionBoundary(entry, context, {
      finding_kind: options?.finding_kind,
      finding_id: options?.finding_id,
      document_metadata: docMeta,
    });

    if (outcome.admitted && outcome.admitted_record) {
      admitted.push(outcome.admitted_record);
    } else if (outcome.rejected_record) {
      rejected.push(outcome.rejected_record);
    }
  }

  return {
    candidate_reference: context.candidate_reference,
    admitted,
    rejected,
    has_admitted_evidence: admitted.length > 0,
    total_processed: evidenceEntries.length,
  };
}

// ---------------------------------------------------------------------------
// D. PERSISTENCE — Serialize/deserialize admitted+rejected ledger
// ---------------------------------------------------------------------------

export interface EvidenceAdmissionLedger {
  schema_version: "evidence-admission-v1";
  candidate_reference: string;
  admitted: AdmittedEvidenceRecord[];
  rejected: RejectedEvidenceRecord[];
  admission_timestamp: string;
}

/**
 * Serialize admitted and rejected evidence for persistence (JSON/JSONB).
 */
export function serializeEvidenceAdmissionLedger(
  result: CandidateEvidenceAdmissionResult,
): EvidenceAdmissionLedger {
  return {
    schema_version: "evidence-admission-v1",
    candidate_reference: result.candidate_reference,
    admitted: result.admitted.map(a => ({
      ...a,
      canonical_record: serializeEvidenceRecord(a.canonical_record) as CanonicalEvidenceRecord,
    })),
    rejected: result.rejected,
    admission_timestamp: new Date().toISOString(),
  };
}

/**
 * Deserialize a persisted evidence admission ledger.
 */
export function deserializeEvidenceAdmissionLedger(raw: any): EvidenceAdmissionLedger | null {
  if (!raw || raw.schema_version !== "evidence-admission-v1") return null;
  // Rehydrate canonical records in admitted entries
  for (const a of raw.admitted ?? []) {
    if (a.canonical_record) {
      a.canonical_record = deserializeEvidenceRecord(a.canonical_record) ?? a.canonical_record;
    }
  }
  return raw as EvidenceAdmissionLedger;
}
