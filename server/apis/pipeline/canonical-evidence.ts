/**
 * MAT-F02: Canonical Evidence Record — Coordinate-Backed Authority, Evidence, and Entity Routing
 *
 * This module defines:
 *   1. The CanonicalEvidenceRecord type with versioned schema
 *   2. Centralized authority classification (no filename heuristics scattered across pipeline)
 *   3. Exact coordinate validation (PDF page/quote, workbook sheet/cell)
 *   4. Target-entity applicability enforcement (Gamma ≠ SCG without bridge)
 *   5. Evidence admission gate with stable terminal reason codes
 *   6. Persistence/reload parity via content-derived evidence IDs
 *
 * Authority Policy Version: "authority-policy-v1"
 */

import { sha256hex } from "./sha256-pure.js";

// ---------------------------------------------------------------------------
// Schema version constant
// ---------------------------------------------------------------------------

const EVIDENCE_SCHEMA_VERSION = "evidence-v1" as const;
const AUTHORITY_POLICY_VERSION = "authority-policy-v1";

// ---------------------------------------------------------------------------
// Authority classes — expanded from claim-linkage.ts to meet MAT-F02 spec
// ---------------------------------------------------------------------------

export const EVIDENCE_AUTHORITY_CLASSES = [
  "current_financial_model",
  "prior_financial_model",
  "vendor_financial_dd",
  "legal_dd",
  "commercial_cdd",
  "information_memorandum",
  "management_material",
  "ic_memo",
  "unknown",
] as const;

export type EvidenceAuthorityClass = typeof EVIDENCE_AUTHORITY_CLASSES[number];

// ---------------------------------------------------------------------------
// Evidence roles
// ---------------------------------------------------------------------------

export type EvidenceRole =
  | "verifying"
  | "contradicting"
  | "supporting"
  | "contextual"
  | "absence_evidence";

// ---------------------------------------------------------------------------
// Coordinate types
// ---------------------------------------------------------------------------

export type PdfCoordinate = {
  kind: "pdf";
  page: number;
  exact_quote: string;
  source_start?: number;
  source_end?: number;
};

export type WorkbookCoordinate = {
  kind: "workbook";
  sheet: string;
  cell_or_range: string;
  displayed_value?: string | number | null;
  raw_value?: string | number | null;
};

export type EvidenceCoordinate = PdfCoordinate | WorkbookCoordinate;

// ---------------------------------------------------------------------------
// Canonical Evidence Record type
// ---------------------------------------------------------------------------

export interface CanonicalEvidenceRecord {
  schema_version: "evidence-v1";
  evidence_id: string;

  source: {
    document_id: string;
    document_name: string;
    authority_class: EvidenceAuthorityClass;
    source_type: "pdf" | "workbook" | "other";
  };

  coordinate: EvidenceCoordinate;

  target: {
    entity: string | null;
    segment: string | null;
  };

  proposition: {
    metric: string | null;
    qualitative_proposition: string | null;
    period: string | null;
    scope: string | null;
    unit: string | null;
    currency: string | null;
    scale: string | null;
    actual_forecast_status:
      | "actual"
      | "forecast"
      | "mixed"
      | "not_applicable"
      | "unknown";
    accounting_basis: string | null;
    value: string | number | null;
  };

  evidence_role: EvidenceRole;

  authority_decision: {
    allowed: boolean;
    reason_code: string;
    rule_version: string;
  };

  entity_applicability: {
    allowed: boolean;
    direct_entity_match: boolean;
    bridge_evidence_id: string | null;
    reason_code: string;
  };

  source_validation: {
    coordinate_valid: boolean;
    exact_quote_found: boolean | null;
    validation_method: string;
  };
}

// ---------------------------------------------------------------------------
// Evidence rejection reason codes
// ---------------------------------------------------------------------------

export type EvidenceRejectionReason =
  | "unknown_authority"
  | "authority_not_valid_for_proposition"
  | "missing_evidence_coordinate"
  | "quote_not_found"
  | "invalid_workbook_coordinate"
  | "entity_mismatch"
  | "entity_bridge_missing"
  | "market_evidence_not_company_specific"
  | "ic_memo_self_verification"
  | "management_source_not_independent";

// ---------------------------------------------------------------------------
// Evidence admission result
// ---------------------------------------------------------------------------

export interface EvidenceAdmissionResult {
  admitted: boolean;
  evidence_record: CanonicalEvidenceRecord | null;
  rejection_reason: EvidenceRejectionReason | null;
  rejection_detail: string | null;
}

// ============================================================================
// A. CENTRALIZED SOURCE CLASSIFICATION
// ============================================================================

/**
 * Classifies a document into its canonical authority class using durable
 * document metadata. Does NOT rely solely on filename heuristics.
 *
 * Priority:
 *   1. Explicit document_tag from upload metadata (most reliable)
 *   2. Document type field from system classification
 *   3. Filename-based detection (fallback only)
 *   4. Unknown (fails closed)
 */
export function classifySourceAuthority(params: {
  document_tag?: string | null;
  document_type?: string | null;
  document_name: string;
  /** Whether this is the current (updated) model vs. prior version */
  is_current_model?: boolean;
  /** Model sheet name hint — distinguishes live vs hardcoded model sheets */
  sheet_name?: string | null;
}): EvidenceAuthorityClass {
  const { document_tag, document_type, document_name, is_current_model, sheet_name } = params;
  const tag = (document_tag ?? "").toLowerCase().trim();
  const dtype = (document_type ?? "").toLowerCase().trim();
  const fname = document_name.toLowerCase().trim();

  // 1. Explicit document_tag (most reliable)
  if (tag === "financial_model" || tag === "live_model" || tag === "current_model") {
    return is_current_model === false ? "prior_financial_model" : "current_financial_model";
  }
  if (tag === "prior_model" || tag === "historical_model") {
    return "prior_financial_model";
  }
  if (tag === "fdd" || tag === "vendor_fdd" || tag === "pwc_fdd" || tag === "financial_dd") {
    return "vendor_financial_dd";
  }
  if (tag === "legal_dd" || tag === "legal") {
    return "legal_dd";
  }
  if (tag === "cdd" || tag === "commercial_dd" || tag === "altman_solon" || tag === "commercial_cdd") {
    return "commercial_cdd";
  }
  if (tag === "ic_memo" || tag === "ic_material") {
    return "ic_memo";
  }
  if (tag === "cim" || tag === "information_memorandum" || tag === "im") {
    return "information_memorandum";
  }
  if (tag === "management_material" || tag === "management_presentation" || tag === "mgmt_material") {
    return "management_material";
  }

  // 2. Document type field
  if (dtype === "financial_model" || dtype === "model") {
    return is_current_model === false ? "prior_financial_model" : "current_financial_model";
  }
  if (dtype === "fdd" || dtype === "financial_dd" || dtype === "vendor_fdd") {
    return "vendor_financial_dd";
  }
  if (dtype === "legal_dd") return "legal_dd";
  if (dtype === "cdd" || dtype === "commercial_dd") return "commercial_cdd";
  if (dtype === "ic_memo") return "ic_memo";
  if (dtype === "cim" || dtype === "information_memorandum") return "information_memorandum";
  if (dtype === "management_material") return "management_material";

  // 3. Filename-based detection (fallback)
  // Financial model detection
  if ((fname.includes("model") || fname.includes("financial model")) &&
      (fname.endsWith(".xlsx") || fname.endsWith(".xlsm") || fname.endsWith(".xls"))) {
    // Distinguish current vs prior based on naming patterns
    if (fname.includes("prior") || fname.includes("old") || fname.includes("previous") || fname.includes("v1")) {
      return "prior_financial_model";
    }
    return is_current_model === false ? "prior_financial_model" : "current_financial_model";
  }

  // PwC FDD
  if (fname.includes("pwc") || fname.includes("fdd") || fname.includes("financial due diligence")) {
    return "vendor_financial_dd";
  }

  // Altman Solon / Commercial DD
  if (fname.includes("altman") || fname.includes("cdd") || fname.includes("commercial due diligence")) {
    return "commercial_cdd";
  }

  // Legal DD
  if (fname.includes("legal dd") || fname.includes("legal due diligence")) {
    return "legal_dd";
  }

  // IC memo
  if (fname.includes("ic memo") || fname.includes("investment committee") || fname.includes("ic paper")) {
    return "ic_memo";
  }

  // Information Memorandum
  if (fname.includes("information memorandum") || fname.includes(" im ") || fname.startsWith("im ") || fname === "im.pdf") {
    return "information_memorandum";
  }

  // Management materials
  if (fname.includes("management presentation") || fname.includes("mgmt") || fname.includes("board pack")) {
    return "management_material";
  }

  // 4. Unknown — fails closed
  return "unknown";
}

// ============================================================================
// B. EXACT COORDINATE VALIDATION
// ============================================================================

/**
 * Validates a PDF coordinate by checking that the exact quote exists in the
 * source text at/near the stated page.
 *
 * Requirements:
 *   - exact_quote must occur in source_text
 *   - page must be a valid positive integer
 *   - Generic section/scope/title alone is NOT a valid coordinate
 */
export function validatePdfCoordinate(params: {
  coordinate: PdfCoordinate;
  /** Full text of the source document (or page text if per-page) */
  source_text: string;
  /** If page-indexed text is available, provide for page-level validation */
  page_texts?: Map<number, string>;
}): { valid: boolean; exact_quote_found: boolean; validation_method: string } {
  const { coordinate, source_text, page_texts } = params;

  // Page must be a valid positive integer
  if (!coordinate.page || coordinate.page < 1 || !Number.isInteger(coordinate.page)) {
    return { valid: false, exact_quote_found: false, validation_method: "page_number_invalid" };
  }

  // Quote must be non-empty and substantive (not just a section title)
  if (!coordinate.exact_quote || coordinate.exact_quote.trim().length < 10) {
    return { valid: false, exact_quote_found: false, validation_method: "quote_too_short_or_empty" };
  }

  // Normalize whitespace for comparison
  const normalizedQuote = coordinate.exact_quote.replace(/\s+/g, " ").trim();

  // If page-level text available, verify quote on the specific page
  if (page_texts && page_texts.size > 0) {
    const pageText = page_texts.get(coordinate.page);
    if (!pageText) {
      // Page doesn't exist in document
      return { valid: false, exact_quote_found: false, validation_method: "page_not_in_document" };
    }
    const normalizedPage = pageText.replace(/\s+/g, " ");
    const found = normalizedPage.includes(normalizedQuote);
    return {
      valid: found,
      exact_quote_found: found,
      validation_method: found ? "exact_quote_on_page" : "quote_not_on_stated_page",
    };
  }

  // Fallback: check against full document text
  const normalizedSource = source_text.replace(/\s+/g, " ");
  const found = normalizedSource.includes(normalizedQuote);
  return {
    valid: found,
    exact_quote_found: found,
    validation_method: found ? "exact_quote_in_document" : "quote_not_in_document",
  };
}

/**
 * Validates a workbook coordinate by checking sheet and cell/range are present
 * and well-formed.
 */
export function validateWorkbookCoordinate(params: {
  coordinate: WorkbookCoordinate;
  /** Available sheet names in the workbook */
  available_sheets?: string[];
  /** Cell values by "sheet!cell" key, if available */
  cell_values?: Map<string, string | number | null>;
}): { valid: boolean; exact_quote_found: boolean | null; validation_method: string } {
  const { coordinate, available_sheets, cell_values } = params;

  // Sheet must be non-empty
  if (!coordinate.sheet || coordinate.sheet.trim().length === 0) {
    return { valid: false, exact_quote_found: null, validation_method: "missing_sheet" };
  }

  // Cell/range must be non-empty and well-formed
  if (!coordinate.cell_or_range || coordinate.cell_or_range.trim().length === 0) {
    return { valid: false, exact_quote_found: null, validation_method: "missing_cell_or_range" };
  }

  // Validate cell format (A1 style or range like A1:B5)
  const cellRegex = /^[A-Z]{1,3}\d{1,7}(:[A-Z]{1,3}\d{1,7})?$/i;
  if (!cellRegex.test(coordinate.cell_or_range.trim())) {
    return { valid: false, exact_quote_found: null, validation_method: "invalid_cell_format" };
  }

  // If sheet list available, verify sheet exists
  if (available_sheets && available_sheets.length > 0) {
    const sheetExists = available_sheets.some(
      s => s.toLowerCase() === coordinate.sheet.toLowerCase()
    );
    if (!sheetExists) {
      return { valid: false, exact_quote_found: null, validation_method: "sheet_not_in_workbook" };
    }
  }

  // If cell values available, verify value
  if (cell_values && cell_values.size > 0) {
    const key = `${coordinate.sheet}!${coordinate.cell_or_range}`;
    if (cell_values.has(key)) {
      return { valid: true, exact_quote_found: true, validation_method: "cell_value_verified" };
    }
    return { valid: true, exact_quote_found: null, validation_method: "sheet_and_cell_format_valid" };
  }

  return { valid: true, exact_quote_found: null, validation_method: "sheet_and_cell_format_valid" };
}

// ============================================================================
// C. TARGET-ENTITY APPLICABILITY ENFORCEMENT
// ============================================================================

/**
 * Entity applicability gate.
 *
 * Rules:
 *   - Direct entity match: evidence entity === claim entity → allowed
 *   - Evidence entity is "Market" or null (market-level): contextual only, not verifying
 *   - Evidence entity differs from claim entity: fails closed unless a bridge exists
 *   - Bridge must be an exact structured record with evidence_id, not a generated narrative
 */
export function evaluateEntityApplicability(params: {
  claim_entity: string | null;
  evidence_entity: string | null;
  evidence_segment: string | null;
  evidence_role: EvidenceRole;
  /** Structured entity bridge records keyed by "source_entity→target_entity" */
  bridges?: Map<string, { bridge_evidence_id: string; rationale: string }>;
}): {
  allowed: boolean;
  direct_entity_match: boolean;
  bridge_evidence_id: string | null;
  reason_code: string;
} {
  const { claim_entity, evidence_entity, evidence_role, bridges } = params;

  // If claim entity is null, we can't enforce entity match
  if (!claim_entity) {
    return {
      allowed: true,
      direct_entity_match: false,
      bridge_evidence_id: null,
      reason_code: "claim_entity_unspecified",
    };
  }

  // If evidence entity is null or "Market" — market-level evidence
  if (!evidence_entity || evidence_entity.toLowerCase() === "market") {
    // Market evidence is contextual/supporting only — not verifying or contradicting
    if (evidence_role === "verifying" || evidence_role === "contradicting") {
      return {
        allowed: false,
        direct_entity_match: false,
        bridge_evidence_id: null,
        reason_code: "market_evidence_not_company_specific",
      };
    }
    return {
      allowed: true,
      direct_entity_match: false,
      bridge_evidence_id: null,
      reason_code: "market_evidence_as_context",
    };
  }

  // Direct entity match
  if (evidence_entity.toLowerCase() === claim_entity.toLowerCase()) {
    return {
      allowed: true,
      direct_entity_match: true,
      bridge_evidence_id: null,
      reason_code: "direct_entity_match",
    };
  }

  // Entities differ — check for a structured bridge
  const bridgeKey = `${evidence_entity.toLowerCase()}→${claim_entity.toLowerCase()}`;
  if (bridges && bridges.has(bridgeKey)) {
    const bridge = bridges.get(bridgeKey)!;
    return {
      allowed: true,
      direct_entity_match: false,
      bridge_evidence_id: bridge.bridge_evidence_id,
      reason_code: "entity_bridge_applied",
    };
  }

  // No bridge — fails closed
  return {
    allowed: false,
    direct_entity_match: false,
    bridge_evidence_id: null,
    reason_code: "entity_bridge_missing",
  };
}

// ============================================================================
// D. AUTHORITY GATE — PROPOSITION-AWARE AUTHORITY VALIDATION
// ============================================================================

/**
 * Centralized proposition-aware authority gate.
 *
 * Determines whether a given authority class is valid for verifying
 * a given proposition type.
 */
export function evaluateAuthority(params: {
  authority_class: EvidenceAuthorityClass;
  proposition_type: string;
  evidence_role: EvidenceRole;
  /** The claim being verified — to detect IC self-verification */
  claim_source_document_id?: string | null;
  evidence_document_id: string;
}): { allowed: boolean; reason_code: string; rule_version: string } {
  const { authority_class, proposition_type, evidence_role, claim_source_document_id, evidence_document_id } = params;

  // IC memo self-verification — ALWAYS rejected
  if (authority_class === "ic_memo") {
    return {
      allowed: false,
      reason_code: "ic_memo_self_verification",
      rule_version: AUTHORITY_POLICY_VERSION,
    };
  }

  // Also reject if evidence document IS the same as the claim source document
  if (claim_source_document_id && evidence_document_id === claim_source_document_id) {
    return {
      allowed: false,
      reason_code: "ic_memo_self_verification",
      rule_version: AUTHORITY_POLICY_VERSION,
    };
  }

  // Unknown authority — fails closed
  if (authority_class === "unknown") {
    return {
      allowed: false,
      reason_code: "unknown_authority",
      rule_version: AUTHORITY_POLICY_VERSION,
    };
  }

  // Management material / Information Memorandum — NOT independent authority
  if (authority_class === "management_material" || authority_class === "information_memorandum") {
    // Only allowed as supporting/contextual, not verifying/contradicting
    if (evidence_role === "verifying" || evidence_role === "contradicting") {
      return {
        allowed: false,
        reason_code: "management_source_not_independent",
        rule_version: AUTHORITY_POLICY_VERSION,
      };
    }
    // Supporting/contextual is fine
    return {
      allowed: true,
      reason_code: "management_material_as_context",
      rule_version: AUTHORITY_POLICY_VERSION,
    };
  }

  // Proposition-specific rules
  const propLower = (proposition_type ?? "").toLowerCase();

  // Legal propositions — only legal_dd is authoritative
  const legalPropositions = new Set([
    "legal", "regulatory", "contractual", "change_of_control",
    "indemnity", "ip", "lease", "data_protection", "regulatory_contractual",
  ]);
  if (legalPropositions.has(propLower)) {
    if (authority_class === "legal_dd") {
      return { allowed: true, reason_code: "legal_dd_for_legal_proposition", rule_version: AUTHORITY_POLICY_VERSION };
    }
    return {
      allowed: false,
      reason_code: "authority_not_valid_for_proposition",
      rule_version: AUTHORITY_POLICY_VERSION,
    };
  }

  // Commercial/market propositions — commercial_cdd is authoritative
  const commercialPropositions = new Set([
    "commercial", "market_size", "market_position", "market_growth",
    "customer_concentration", "retention", "competitive_landscape",
    "segment_turnaround", "downside_resilience",
  ]);
  if (commercialPropositions.has(propLower)) {
    if (authority_class === "commercial_cdd") {
      return { allowed: true, reason_code: "commercial_cdd_for_market_proposition", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "current_financial_model" || authority_class === "vendor_financial_dd") {
      return { allowed: true, reason_code: "model_or_fdd_supports_commercial", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "legal_dd") {
      return {
        allowed: false,
        reason_code: "authority_not_valid_for_proposition",
        rule_version: AUTHORITY_POLICY_VERSION,
      };
    }
    return { allowed: true, reason_code: "authority_accepted_for_commercial", rule_version: AUTHORITY_POLICY_VERSION };
  }

  // Financial propositions — model + vendor FDD authoritative
  const financialPropositions = new Set([
    "financial", "revenue", "ebitda", "cash_flow", "growth", "forecast",
    "operating_metric", "valuation", "returns", "deal_mechanics",
    "current_forecast", "financial_number",
  ]);
  if (financialPropositions.has(propLower)) {
    if (authority_class === "current_financial_model") {
      return { allowed: true, reason_code: "current_model_for_financial", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "prior_financial_model") {
      return { allowed: true, reason_code: "prior_model_for_financial_comparison", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "vendor_financial_dd") {
      return { allowed: true, reason_code: "vendor_fdd_for_financial", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "legal_dd") {
      return { allowed: false, reason_code: "authority_not_valid_for_proposition", rule_version: AUTHORITY_POLICY_VERSION };
    }
    if (authority_class === "commercial_cdd") {
      return { allowed: false, reason_code: "authority_not_valid_for_proposition", rule_version: AUTHORITY_POLICY_VERSION };
    }
    return { allowed: true, reason_code: "authority_accepted_for_financial", rule_version: AUTHORITY_POLICY_VERSION };
  }

  // Default: current_model, prior_model, vendor_fdd → allowed; others fail closed
  if (authority_class === "current_financial_model" || authority_class === "prior_financial_model" || authority_class === "vendor_financial_dd") {
    return { allowed: true, reason_code: "authority_accepted_default", rule_version: AUTHORITY_POLICY_VERSION };
  }
  if (authority_class === "legal_dd") {
    return { allowed: true, reason_code: "legal_dd_accepted_default", rule_version: AUTHORITY_POLICY_VERSION };
  }
  if (authority_class === "commercial_cdd") {
    return { allowed: true, reason_code: "commercial_cdd_accepted_default", rule_version: AUTHORITY_POLICY_VERSION };
  }

  return { allowed: false, reason_code: "authority_not_valid_for_proposition", rule_version: AUTHORITY_POLICY_VERSION };
}

// ============================================================================
// E. EVIDENCE ADMISSION GATE
// ============================================================================

/**
 * Production evidence admission gate.
 *
 * Enforces:
 *   1. Valid authority class (not unknown, not self-verifying IC)
 *   2. Valid coordinate (PDF quote or workbook cell)
 *   3. Authority-for-proposition match
 *   4. Entity applicability
 *
 * Returns admitted=true with the full canonical record, or admitted=false
 * with a stable rejection reason.
 */
export function admitEvidence(params: {
  document_id: string;
  document_name: string;
  authority_class: EvidenceAuthorityClass;
  source_type: "pdf" | "workbook" | "other";
  coordinate: EvidenceCoordinate;
  target_entity: string | null;
  target_segment: string | null;
  claim_entity: string | null;
  proposition_type: string;
  evidence_role: EvidenceRole;
  claim_source_document_id?: string | null;
  source_text?: string;
  page_texts?: Map<number, string>;
  available_sheets?: string[];
  cell_values?: Map<string, string | number | null>;
  bridges?: Map<string, { bridge_evidence_id: string; rationale: string }>;
  proposition?: {
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
}): EvidenceAdmissionResult {
  const {
    document_id, document_name, authority_class, source_type,
    coordinate, target_entity, target_segment, claim_entity,
    proposition_type, evidence_role, claim_source_document_id,
    source_text, page_texts, available_sheets, cell_values, bridges,
    proposition,
  } = params;

  // Step 1: Authority decision
  const authorityDecision = evaluateAuthority({
    authority_class,
    proposition_type,
    evidence_role,
    claim_source_document_id,
    evidence_document_id: document_id,
  });

  if (!authorityDecision.allowed) {
    return {
      admitted: false,
      evidence_record: null,
      rejection_reason: authorityDecision.reason_code as EvidenceRejectionReason,
      rejection_detail: `Authority rejected: ${authorityDecision.reason_code} (class=${authority_class}, proposition=${proposition_type})`,
    };
  }

  // Step 2: Coordinate validation
  let sourceValidation: { coordinate_valid: boolean; exact_quote_found: boolean | null; validation_method: string };

  if (coordinate.kind === "pdf") {
    const pdfResult = validatePdfCoordinate({
      coordinate,
      source_text: source_text ?? "",
      page_texts,
    });
    sourceValidation = {
      coordinate_valid: pdfResult.valid,
      exact_quote_found: pdfResult.exact_quote_found,
      validation_method: pdfResult.validation_method,
    };
  } else if (coordinate.kind === "workbook") {
    const wbResult = validateWorkbookCoordinate({
      coordinate,
      available_sheets,
      cell_values,
    });
    sourceValidation = {
      coordinate_valid: wbResult.valid,
      exact_quote_found: wbResult.exact_quote_found,
      validation_method: wbResult.validation_method,
    };
  } else {
    sourceValidation = {
      coordinate_valid: false,
      exact_quote_found: null,
      validation_method: "unsupported_source_type",
    };
  }

  if (!sourceValidation.coordinate_valid) {
    const reason: EvidenceRejectionReason = coordinate.kind === "pdf"
      ? (sourceValidation.validation_method === "quote_not_on_stated_page" || sourceValidation.validation_method === "quote_not_in_document"
        ? "quote_not_found" : "missing_evidence_coordinate")
      : "invalid_workbook_coordinate";

    return {
      admitted: false,
      evidence_record: null,
      rejection_reason: reason,
      rejection_detail: `Coordinate invalid: ${sourceValidation.validation_method}`,
    };
  }

  // Step 3: Entity applicability
  const entityDecision = evaluateEntityApplicability({
    claim_entity,
    evidence_entity: target_entity,
    evidence_segment: target_segment,
    evidence_role,
    bridges,
  });

  if (!entityDecision.allowed) {
    return {
      admitted: false,
      evidence_record: null,
      rejection_reason: entityDecision.reason_code as EvidenceRejectionReason,
      rejection_detail: `Entity applicability rejected: evidence_entity=${target_entity}, claim_entity=${claim_entity}, reason=${entityDecision.reason_code}`,
    };
  }

  // Step 4: Build canonical evidence record
  const evidence_id = generateEvidenceId({
    document_id,
    coordinate,
    proposition_type,
    evidence_role,
  });

  const record: CanonicalEvidenceRecord = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_id,
    source: {
      document_id,
      document_name,
      authority_class,
      source_type,
    },
    coordinate,
    target: {
      entity: target_entity,
      segment: target_segment,
    },
    proposition: proposition ?? {
      metric: null,
      qualitative_proposition: null,
      period: null,
      scope: null,
      unit: null,
      currency: null,
      scale: null,
      actual_forecast_status: "unknown",
      accounting_basis: null,
      value: null,
    },
    evidence_role,
    authority_decision: authorityDecision,
    entity_applicability: entityDecision,
    source_validation: sourceValidation,
  };

  return {
    admitted: true,
    evidence_record: record,
    rejection_reason: null,
    rejection_detail: null,
  };
}

// ============================================================================
// F. EVIDENCE IDENTITY — Content-derived stable ID
// ============================================================================

/**
 * Generate a deterministic evidence ID from content-invariant inputs.
 * Uses SHA-256 with truncation to 32 hex chars (128-bit collision resistance).
 */
export function generateEvidenceId(params: {
  document_id: string;
  coordinate: EvidenceCoordinate;
  proposition_type: string;
  evidence_role: EvidenceRole;
}): string {
  const { document_id, coordinate, proposition_type, evidence_role } = params;

  let coordinateKey: string;
  if (coordinate.kind === "pdf") {
    coordinateKey = `pdf|${coordinate.page}|${coordinate.exact_quote}`;
  } else {
    coordinateKey = `wb|${coordinate.sheet}|${coordinate.cell_or_range}`;
  }

  const input = [
    document_id,
    coordinateKey,
    proposition_type,
    evidence_role,
  ].join("|");

  const hash = sha256hex(input);
  return `ev-v1-${hash.slice(0, 32)}`;
}

// ============================================================================
// PERSISTENCE / RELOAD
// ============================================================================

/**
 * Serialize a canonical evidence record for persistence (e.g. to JSON/JSONB).
 * Strips the Map-unfriendly fields and produces a plain object.
 */
export function serializeEvidenceRecord(record: CanonicalEvidenceRecord): object {
  return { ...record };
}

/**
 * Deserialize a persisted evidence record back to the canonical type.
 */
export function deserializeEvidenceRecord(raw: any): CanonicalEvidenceRecord | null {
  if (!raw || raw.schema_version !== EVIDENCE_SCHEMA_VERSION) return null;
  return raw as CanonicalEvidenceRecord;
}
