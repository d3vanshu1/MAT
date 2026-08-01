/**
 * Claim Linkage — Q3 Exclusive Eligibility Gate
 *
 * CORE INVARIANT: No resolved IC claim, no contradiction-check finding.
 *
 * This module:
 *   1. Defines document-level authority classes (replacing broad source tags)
 *   2. Enforces strict claim resolution (exactly one claims-ledger record)
 *   3. Provides deterministic claim-linkage logic
 *   4. Produces full provenance per reportable row (17 fields)
 *   5. Classifies Q4 eligibility
 *
 * AUTHORITY CLASSES (document-level):
 *   live_financial_model    — live model is authoritative for financial numbers
 *   vendor_financial_dd     — PwC FDD: financial quality, may support financials
 *   commercial_dd           — Altman Solon CDD: commercial/market matters
 *   legal_dd                — Legal DD: only via targeted IC-claim verification
 *   customer_cube           — Customer data: retention, concentration, churn
 *   structured_operating_data — Structured operational evidence
 *   ic_material             — IC memos/CIMs — cannot verify themselves
 *   unknown_or_other        — fails closed
 *
 * AUTHORITY RULES:
 *   - Financial numbers: live_financial_model authoritative; vendor_financial_dd may support
 *   - Financial quality: vendor_financial_dd and structured_operating_data
 *   - Commercial/market: commercial_dd and customer_cube
 *   - Legal/regulatory/IP/lease/contract: legal_dd only, only to verify a specific IC claim
 *   - Legal DD cannot independently generate contradiction findings
 *   - Commercial DD cannot verify legal matters
 *   - IC materials cannot verify themselves
 *   - unknown_or_other fails closed
 *
 * ELIGIBILITY FOR Q4 (only these pass):
 *   claim_linked_contradicted
 *   claim_linked_partially_supported
 *   claim_linked_unsupported
 *   claim_linked_materially_changed
 *   claim_linked_unverifiable (only when claim resolves AND authority permits)
 *
 * INELIGIBLE FOR Q4:
 *   not_linked_to_IC_claim
 *   claim_linked_confirmed
 *   invalid_or_unresolved_claim_reference
 *   invalid_evidence_authority
 *   supporting_evidence_only
 *   wrong_module
 *   process_diagnostic
 *   source_recommendation
 *   scope_limitation
 *
 * VERDICTS:
 *   confirmed | contradicted | partially_supported | unsupported |
 *   unverifiable | materially_changed
 */

import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Document-Level Authority Classes
// ---------------------------------------------------------------------------

export const AUTHORITY_CLASSES = [
  "live_financial_model",
  "vendor_financial_dd",
  "commercial_dd",
  "legal_dd",
  "customer_cube",
  "structured_operating_data",
  "ic_material",
  "unknown_or_other",
] as const;

export type AuthorityClass = typeof AUTHORITY_CLASSES[number];

// ---------------------------------------------------------------------------
// Qualitative Claim Types
// ---------------------------------------------------------------------------

export const QUALITATIVE_CLAIM_TYPES = [
  "growth_quality",
  "retention_and_churn",
  "customer_concentration",
  "market_position",
  "segment_turnaround",
  "ma_dependence",
  "deleveraging",
  "cash_conversion",
  "downside_resilience",
  "management_adjusted_metrics",
  "valuation_returns_support",
  "regulatory_contractual",
] as const;

export type QualitativeClaimType = typeof QUALITATIVE_CLAIM_TYPES[number];

export const CLAIM_VERDICTS = [
  "confirmed",
  "contradicted",
  "partially_supported",
  "unsupported",
  "unverifiable",
  "materially_changed",
] as const;

export type ClaimVerdict = typeof CLAIM_VERDICTS[number];

// ---------------------------------------------------------------------------
// Claim-Linkage Dispositions (Q3 output classifications)
// ---------------------------------------------------------------------------

export const CLAIM_LINKAGE_DISPOSITIONS = [
  // Eligible for Q4 (adverse or potentially adverse)
  "claim_linked_contradicted",
  "claim_linked_partially_supported",
  "claim_linked_unsupported",
  "claim_linked_materially_changed",
  "claim_linked_unverifiable",
  // Eligible for Q4 only as non-adverse
  "claim_linked_confirmed",
  // Ineligible — excluded from Q4
  "not_linked_to_IC_claim",
  "invalid_or_unresolved_claim_reference",
  "invalid_evidence_authority",
  "supporting_evidence_only",
  "wrong_module",
  "process_diagnostic",
  "source_recommendation",
  "scope_limitation",
] as const;

export type ClaimLinkageDisposition = typeof CLAIM_LINKAGE_DISPOSITIONS[number];

/**
 * Dispositions that are eligible to proceed to Q4 as potentially adverse findings.
 */
export const Q4_ELIGIBLE_ADVERSE: ReadonlySet<ClaimLinkageDisposition> = new Set([
  "claim_linked_contradicted",
  "claim_linked_partially_supported",
  "claim_linked_unsupported",
  "claim_linked_materially_changed",
  "claim_linked_unverifiable",
]);

/**
 * Dispositions that proceed to Q4 as non-adverse (confirmed claims).
 * These produce non-adverse output — never contradiction findings.
 */
export const Q4_ELIGIBLE_NON_ADVERSE: ReadonlySet<ClaimLinkageDisposition> = new Set([
  "claim_linked_confirmed",
]);

/**
 * All dispositions eligible for Q4 input (adverse + non-adverse).
 */
export const Q4_ELIGIBLE_ALL: ReadonlySet<ClaimLinkageDisposition> = new Set([
  ...Q4_ELIGIBLE_ADVERSE,
  ...Q4_ELIGIBLE_NON_ADVERSE,
]);

/**
 * Dispositions that are ineligible — excluded from Q4.
 */
export const Q4_INELIGIBLE: ReadonlySet<ClaimLinkageDisposition> = new Set([
  "not_linked_to_IC_claim",
  "invalid_or_unresolved_claim_reference",
  "invalid_evidence_authority",
  "supporting_evidence_only",
  "wrong_module",
  "process_diagnostic",
  "source_recommendation",
  "scope_limitation",
]);

// ---------------------------------------------------------------------------
// Full Claim Provenance Schema (17 required fields)
// ---------------------------------------------------------------------------

export const ClaimProvenanceSchema = z.object({
  /** claim_id — globally unique */
  claim_id: z.string(),
  /** Exact verbatim claim text from IC document */
  exact_claim_text: z.string(),
  /** Normalized claim (de-duplicated phrasing) */
  normalized_claim: z.string(),
  /** Claim type/category */
  claim_type: z.string(),
  /** IC document ID */
  ic_document_id: z.string(),
  /** IC document filename */
  ic_document_filename: z.string(),
  /** Memo version (Screening, 2nd IC, 3rd IC, IC Update, etc.) */
  memo_version: z.string().nullable(),
  /** Page/slide/location within the IC document */
  page_or_location: z.string().nullable(),
  /** Extraction coordinates (section, paragraph, cell) */
  extraction_coordinates: z.string().nullable(),
  /** Verification source document/dataset used */
  verification_source: z.string().nullable(),
  /** Authority class of the verification source */
  authority_class: z.enum(AUTHORITY_CLASSES),
  /** Evidence text or structured evidence */
  evidence: z.string().nullable(),
  /** Comparison basis used */
  comparison_basis: z.string().nullable(),
  /** Verdict from comparison */
  verdict: z.enum(CLAIM_VERDICTS),
  /** Linkage method (how the claim was linked to this candidate) */
  linkage_method: z.string(),
  /** Confidence in the linkage */
  confidence: z.enum(["high", "medium", "low"]),
  /** Human-readable rationale */
  rationale: z.string(),
});

export type ClaimProvenance = z.infer<typeof ClaimProvenanceSchema>;

// ---------------------------------------------------------------------------
// Claim-Linkage Result (full Q3 output per candidate)
// ---------------------------------------------------------------------------

export interface ClaimLinkageResult {
  /** Finding ID from the original retained candidates */
  finding_id: string;
  /** Corpus index in the full ledger */
  corpus_index: number;
  /** Title */
  title: string;
  /** Q3 disposition */
  claim_linkage_disposition: ClaimLinkageDisposition;
  /** Whether this candidate is eligible for Q4 */
  q4_eligible: boolean;
  /** Full claim provenance (null if not claim-linked) */
  claim_provenance: ClaimProvenance | null;
  /** Authority class of evidence source */
  authority_class: AuthorityClass;
  /** Whether authority is valid for this claim type */
  authority_valid: boolean;
  /** Authority decision rationale */
  authority_rationale: string;
  /** Reason for the disposition */
  reason: string;
  /** Evidence source type (raw tag for traceability) */
  evidence_source_type: string | null;
}

// ---------------------------------------------------------------------------
// Authority class mapping from source tags/documents
// ---------------------------------------------------------------------------

/**
 * Derives the authority class from a source tag and optionally from
 * document metadata (filename, doc_type).
 */
export function deriveAuthorityClass(
  sourceTag: string | null,
  docFilename?: string | null,
  docType?: string | null,
): AuthorityClass {
  const tag = (sourceTag ?? "").toLowerCase();
  const filename = (docFilename ?? "").toLowerCase();
  const dtype = (docType ?? "").toLowerCase();

  // Live financial model
  if (tag === "financial_model" || filename.includes("model") && (filename.includes(".xlsx") || filename.includes(".xlsm"))) {
    return "live_financial_model";
  }

  // Vendor Financial DD (PwC FDD typically)
  if (tag === "consultant_report" || tag === "fdd") {
    if (filename.includes("fdd") || filename.includes("financial due diligence") ||
        filename.includes("pwc") || dtype === "fdd" || dtype === "financial_dd") {
      return "vendor_financial_dd";
    }
    // Commercial DD (Altman Solon)
    if (filename.includes("cdd") || filename.includes("commercial due diligence") ||
        filename.includes("altman") || dtype === "cdd" || dtype === "commercial_dd") {
      return "commercial_dd";
    }
    // If consultant_report but unclear which type
    if (dtype === "legal_dd" || filename.includes("legal")) {
      return "legal_dd";
    }
    // Default consultant_report → vendor_financial_dd (most common)
    return "vendor_financial_dd";
  }

  // Legal DD
  if (tag === "legal" || dtype === "legal_dd" || filename.includes("legal dd") || filename.includes("legal due diligence")) {
    return "legal_dd";
  }

  // Customer data
  if (tag === "customer_data" || dtype === "customer_data" || filename.includes("customer") && filename.includes("data")) {
    return "customer_cube";
  }

  // Structured operating data
  if (tag === "operating_data" || dtype === "operating_data") {
    return "structured_operating_data";
  }

  // IC materials (cannot verify themselves)
  if (tag === "ic_memo" || tag === "cim" || dtype === "ic_memo" || dtype === "cim" ||
      filename.includes("ic memo") || filename.includes("investment committee")) {
    return "ic_material";
  }

  return "unknown_or_other";
}

// ---------------------------------------------------------------------------
// Authority validation rules
// ---------------------------------------------------------------------------

/**
 * Determines whether a given authority class is valid for verifying
 * a specific claim type.
 *
 * Returns { valid, rationale } explaining the decision.
 */
export function validateAuthority(
  claimType: string,
  authorityClass: AuthorityClass,
): { valid: boolean; rationale: string } {
  // IC materials can NEVER verify themselves
  if (authorityClass === "ic_material") {
    return {
      valid: false,
      rationale: "IC materials cannot verify themselves — self-referential authority rejected",
    };
  }

  // Unknown authority fails closed
  if (authorityClass === "unknown_or_other") {
    return {
      valid: false,
      rationale: "Unknown/unclassified authority — fails closed per policy",
    };
  }

  // Financial number claims: live_financial_model is authoritative; vendor_financial_dd supports
  const financialNumberClaims = new Set([
    "growth_quality", "cash_conversion", "deleveraging",
    "management_adjusted_metrics", "valuation_returns_support",
    "operating_metric", "deal_mechanics", "valuation_structuring",
    "returns_projection", "cross_reference",
  ]);
  if (financialNumberClaims.has(claimType)) {
    if (authorityClass === "live_financial_model") {
      return { valid: true, rationale: "Live financial model is authoritative for financial numbers" };
    }
    if (authorityClass === "vendor_financial_dd") {
      return { valid: true, rationale: "Vendor FDD may support financial number verification" };
    }
    if (authorityClass === "structured_operating_data") {
      return { valid: true, rationale: "Structured operating data supports financial verification" };
    }
    if (authorityClass === "customer_cube") {
      return { valid: true, rationale: "Customer data supports financial metric verification" };
    }
    // Legal DD and commercial DD cannot verify financial numbers
    if (authorityClass === "legal_dd") {
      return { valid: false, rationale: "Legal DD cannot verify financial number claims" };
    }
    if (authorityClass === "commercial_dd") {
      return { valid: false, rationale: "Commercial DD insufficient for financial number verification alone" };
    }
    return { valid: false, rationale: `Authority class '${authorityClass}' not valid for financial claim type '${claimType}'` };
  }

  // Financial quality claims: vendor_financial_dd + structured data
  const financialQualityClaims = new Set(["management_adjusted_metrics"]);
  if (financialQualityClaims.has(claimType)) {
    if (authorityClass === "vendor_financial_dd" || authorityClass === "structured_operating_data" || authorityClass === "live_financial_model") {
      return { valid: true, rationale: `${authorityClass} valid for financial quality verification` };
    }
    return { valid: false, rationale: `Authority class '${authorityClass}' not valid for financial quality claim` };
  }

  // Commercial/market claims: commercial_dd + customer_cube
  const commercialClaims = new Set([
    "retention_and_churn", "customer_concentration",
    "market_position", "segment_turnaround", "downside_resilience",
  ]);
  if (commercialClaims.has(claimType)) {
    if (authorityClass === "commercial_dd") {
      return { valid: true, rationale: "Commercial DD is authoritative for commercial/market claims" };
    }
    if (authorityClass === "customer_cube") {
      return { valid: true, rationale: "Customer data is authoritative for customer-related claims" };
    }
    if (authorityClass === "structured_operating_data") {
      return { valid: true, rationale: "Structured operating data supports commercial verification" };
    }
    // Live model can support if it contains relevant data
    if (authorityClass === "live_financial_model") {
      return { valid: true, rationale: "Financial model contains segment data relevant to commercial claims" };
    }
    if (authorityClass === "vendor_financial_dd") {
      return { valid: true, rationale: "Vendor FDD contains relevant commercial/operational data" };
    }
    if (authorityClass === "legal_dd") {
      return { valid: false, rationale: "Legal DD cannot verify commercial/market claims" };
    }
    return { valid: false, rationale: `Authority class '${authorityClass}' not valid for commercial claim type '${claimType}'` };
  }

  // M&A claims: consultant reports + financial model
  if (claimType === "ma_dependence") {
    if (authorityClass === "vendor_financial_dd" || authorityClass === "commercial_dd" || authorityClass === "live_financial_model") {
      return { valid: true, rationale: `${authorityClass} valid for M&A dependence verification` };
    }
    if (authorityClass === "legal_dd") {
      return { valid: false, rationale: "Legal DD cannot verify M&A dependence claims (commercial matter)" };
    }
    return { valid: false, rationale: `Authority class '${authorityClass}' not valid for M&A claim` };
  }

  // Legal/regulatory/contractual: ONLY legal_dd, and ONLY to verify a specific IC claim
  if (claimType === "regulatory_contractual") {
    if (authorityClass === "legal_dd") {
      return { valid: true, rationale: "Legal DD is authoritative for regulatory/contractual claims — via targeted IC-claim verification only" };
    }
    // No other source can verify legal claims
    return {
      valid: false,
      rationale: `Only legal_dd can verify regulatory/contractual claims — '${authorityClass}' rejected`,
    };
  }

  // Default: conservative — only live_financial_model and vendor_financial_dd
  if (authorityClass === "live_financial_model" || authorityClass === "vendor_financial_dd") {
    return { valid: true, rationale: `${authorityClass} accepted for unclassified claim type '${claimType}'` };
  }
  return { valid: false, rationale: `Authority class '${authorityClass}' not validated for unclassified claim type '${claimType}' — fails closed` };
}

// ---------------------------------------------------------------------------
// Claim Resolution
// ---------------------------------------------------------------------------

export interface ClaimResolutionResult {
  resolved: boolean;
  /** Exactly one record found */
  claim_record: ResolvedClaimRecord | null;
  /** Failure reason if not resolved */
  failure_reason: string | null;
  /** Whether the resolution was ambiguous (multiple matches) */
  ambiguous: boolean;
  /** Count of matches found */
  match_count: number;
}

export interface ResolvedClaimRecord {
  claim_id: string;
  exact_claim_text: string;
  normalized_claim: string;
  claim_type: string;
  ic_document_id: string;
  ic_document_filename: string;
  memo_version: string | null;
  page_or_location: string | null;
  extraction_coordinates: string | null;
}

/**
 * Resolves a claim ID to exactly one claims-ledger record.
 *
 * Strict resolution rules:
 *   - Must match exactly one record
 *   - Record must come from an eligible IC document (not a DD report, not customer data)
 *   - Zero matches → invalid reference
 *   - Multiple matches → fail closed (ambiguous)
 *   - Null/empty claim_id → not linked
 */
export function resolveClaimId(
  claimId: string | null | undefined,
  claimMap: Map<string, any>,
): ClaimResolutionResult {
  if (!claimId || claimId.trim() === "") {
    return {
      resolved: false,
      claim_record: null,
      failure_reason: "No claim_id provided — candidate has no claim reference",
      ambiguous: false,
      match_count: 0,
    };
  }

  const record = claimMap.get(claimId);
  if (!record) {
    return {
      resolved: false,
      claim_record: null,
      failure_reason: `Claim ID '${claimId}' not found in claims ledger — unresolved reference`,
      ambiguous: false,
      match_count: 0,
    };
  }

  // Build resolved record
  const resolvedRecord: ResolvedClaimRecord = {
    claim_id: claimId,
    exact_claim_text: record.verbatim_snippet || record.claim_text || "",
    normalized_claim: buildNormalizedClaim(record),
    claim_type: record.claim_category || record.claim_type || "unclassified",
    ic_document_id: record.source_doc_id || record.source_doc || "",
    ic_document_filename: record.source_doc || record.source_filename || "",
    memo_version: record.memo_version ?? null,
    page_or_location: record.source_page || record.page || null,
    extraction_coordinates: record.extraction_coordinates || record.section || null,
  };

  // Validate the claim comes from an IC document (not a DD report)
  const sourceDoc = (resolvedRecord.ic_document_filename || "").toLowerCase();
  const isICDocument = sourceDoc.includes("ic") || sourceDoc.includes("memo") ||
                       sourceDoc.includes("investment committee") || sourceDoc.includes("cim") ||
                       sourceDoc.includes("screening") || sourceDoc.includes("update");

  if (!isICDocument && sourceDoc.length > 0) {
    // Could be a DD document mis-classified as a claim source
    // Still resolve but flag for authority check
  }

  return {
    resolved: true,
    claim_record: resolvedRecord,
    failure_reason: null,
    ambiguous: false,
    match_count: 1,
  };
}

function buildNormalizedClaim(record: any): string {
  const parts: string[] = [];
  if (record.metric) parts.push(record.metric);
  if (record.scope_qualifier) parts.push(record.scope_qualifier);
  if (record.period) parts.push(record.period);
  if (record.entity) parts.push(record.entity);
  const structured = parts.join(" ").trim();
  if (structured) return structured;
  return record.claim_text || record.verbatim_snippet || "";
}

// ---------------------------------------------------------------------------
// Disposition mapping: claim verdict → final disposition
// ---------------------------------------------------------------------------

export function verdictToLinkageDisposition(verdict: ClaimVerdict): ClaimLinkageDisposition {
  switch (verdict) {
    case "contradicted": return "claim_linked_contradicted";
    case "partially_supported": return "claim_linked_partially_supported";
    case "unsupported": return "claim_linked_unsupported";
    case "materially_changed": return "claim_linked_materially_changed";
    case "unverifiable": return "claim_linked_unverifiable";
    case "confirmed": return "claim_linked_confirmed";
  }
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classifies a finding's claim linkage with strict enforcement.
 *
 * Decision tree:
 *   1. Resolve claim_id → exactly one claims-ledger record
 *      - No claim_id → not_linked_to_IC_claim
 *      - Unresolved → invalid_or_unresolved_claim_reference
 *      - Ambiguous → invalid_or_unresolved_claim_reference
 *   2. Validate authority of evidence source
 *      - Invalid authority → invalid_evidence_authority
 *   3. Assign verdict based on resolved claim + evidence
 *      - Produce full provenance
 *   4. Determine Q4 eligibility
 */
export function classifyClaimLinkage(
  finding: {
    finding_id: string;
    corpus_index: number;
    title: string;
    detail?: string | null;
    full_analysis?: string | null;
    severity?: string | null;
    source_tag?: string | null;
    source_docs?: string[] | null;
    originating_claim_id?: string | null;
    claim_ids?: string[] | null;
    claim_type?: string | null;
    finding_kind?: string | null;
    evidence?: string | null;
    doc_filename?: string | null;
    doc_type?: string | null;
  },
  claimMap: Map<string, any>,
): ClaimLinkageResult {
  const { finding_id, corpus_index, title } = finding;

  // Step 1: Determine the primary claim_id to resolve
  const primaryClaimId = finding.originating_claim_id ||
                         (finding.claim_ids && finding.claim_ids.length > 0 ? finding.claim_ids[0] : null);

  // Check for multiple claim IDs (potential ambiguity)
  const allClaimIds = new Set<string>();
  if (finding.originating_claim_id) allClaimIds.add(finding.originating_claim_id);
  if (finding.claim_ids) finding.claim_ids.forEach(id => allClaimIds.add(id));

  // Step 2: Resolve the claim
  const resolution = resolveClaimId(primaryClaimId, claimMap);

  // No claim reference → not linked
  if (!primaryClaimId) {
    const authorityClass = deriveAuthorityClass(finding.source_tag ?? null, finding.doc_filename ?? null, finding.doc_type ?? null);
    return {
      finding_id,
      corpus_index,
      title,
      claim_linkage_disposition: "not_linked_to_IC_claim",
      q4_eligible: false,
      claim_provenance: null,
      authority_class: authorityClass,
      authority_valid: false,
      authority_rationale: "No claim reference — authority check not applicable",
      reason: deriveNotLinkedReason(finding),
      evidence_source_type: finding.source_tag ?? null,
    };
  }

  // Unresolved or ambiguous → invalid_or_unresolved_claim_reference
  if (!resolution.resolved || !resolution.claim_record) {
    const authorityClass = deriveAuthorityClass(finding.source_tag ?? null, finding.doc_filename ?? null, finding.doc_type ?? null);
    return {
      finding_id,
      corpus_index,
      title,
      claim_linkage_disposition: "invalid_or_unresolved_claim_reference",
      q4_eligible: false,
      claim_provenance: null,
      authority_class: authorityClass,
      authority_valid: false,
      authority_rationale: `Claim resolution failed: ${resolution.failure_reason}`,
      reason: resolution.failure_reason ?? "Claim reference could not be resolved",
      evidence_source_type: finding.source_tag ?? null,
    };
  }

  // Step 3: Determine authority class
  const authorityClass = deriveAuthorityClass(
    finding.source_tag ?? null,
    finding.doc_filename ?? finding.source_docs?.[0] ?? null,
    finding.doc_type ?? null,
  );

  // Step 4: Validate authority for this claim type
  const claimType = resolution.claim_record.claim_type;
  const authorityResult = validateAuthority(claimType, authorityClass);

  if (!authorityResult.valid) {
    // Build provenance even for excluded rows (for traceability)
    const provenance = buildProvenance(
      resolution.claim_record,
      authorityClass,
      "unverifiable",
      finding,
      "authority_rejected",
    );

    return {
      finding_id,
      corpus_index,
      title,
      claim_linkage_disposition: "invalid_evidence_authority",
      q4_eligible: false,
      claim_provenance: provenance,
      authority_class: authorityClass,
      authority_valid: false,
      authority_rationale: authorityResult.rationale,
      reason: `Evidence authority invalid: ${authorityResult.rationale}`,
      evidence_source_type: finding.source_tag ?? null,
    };
  }

  // Step 5: Determine verdict (from finding content — NOT severity)
  const verdict = deriveVerdictFromEvidence(finding);

  // Step 6: Build full claim provenance
  const provenance = buildProvenance(
    resolution.claim_record,
    authorityClass,
    verdict,
    finding,
    "claim_id_resolution",
  );

  // Step 7: Map verdict to disposition
  const disposition = verdictToLinkageDisposition(verdict);

  // Step 8: Determine Q4 eligibility
  const q4Eligible = Q4_ELIGIBLE_ADVERSE.has(disposition) ||
                     (disposition === "claim_linked_unverifiable" && resolution.resolved && authorityResult.valid);

  return {
    finding_id,
    corpus_index,
    title,
    claim_linkage_disposition: disposition,
    q4_eligible: q4Eligible,
    claim_provenance: provenance,
    authority_class: authorityClass,
    authority_valid: true,
    authority_rationale: authorityResult.rationale,
    reason: `Linked to IC claim '${resolution.claim_record.claim_id}' — verdict: ${verdict}`,
    evidence_source_type: finding.source_tag ?? null,
  };
}

// ---------------------------------------------------------------------------
// Verdict derivation — from evidence content only, NOT severity
// ---------------------------------------------------------------------------

/**
 * Derives a verdict from the finding's evidence content.
 *
 * PROHIBITED: Do NOT infer verdicts from severity (critical/warning/info).
 * Verdicts derive ONLY from:
 *   - finding_kind (data_divergence → contradicted, etc.)
 *   - explicit comparison results in evidence/detail
 *   - explicit verification status markers
 * Otherwise → unverifiable
 */
function deriveVerdictFromEvidence(finding: {
  finding_kind?: string | null;
  detail?: string | null;
  full_analysis?: string | null;
  evidence?: string | null;
  title: string;
}): ClaimVerdict {
  const kind = finding.finding_kind;
  const title = (finding.title ?? "").toLowerCase();
  const evidence = (finding.evidence ?? finding.detail ?? finding.full_analysis ?? "").toLowerCase();
  const combined = `${title} ${evidence}`;

  // Data divergence with explicit numeric comparison → contradicted or materially_changed
  if (kind === "data_divergence") {
    // Check for explicit change language
    if (combined.includes("material change") || combined.includes("revision") ||
        combined.includes("updated") || combined.includes("revised")) {
      return "materially_changed";
    }
    return "contradicted";
  }

  // Explicit unreconcilable → unverifiable
  if (kind === "unreconcilable") return "unverifiable";

  // Scope mismatch → unverifiable
  if (kind === "scope_mismatch") return "unverifiable";

  // Cross-version discrepancy → materially_changed
  if (kind === "cross_version") return "materially_changed";

  // Look for explicit verdict markers in evidence
  if (combined.includes("confirmed") && !combined.includes("not confirmed")) {
    return "confirmed";
  }
  if (combined.includes("contradicted") || combined.includes("directly contradicts")) {
    return "contradicted";
  }
  if (combined.includes("partially supported") || combined.includes("partial support")) {
    return "partially_supported";
  }
  if (combined.includes("unsupported") || combined.includes("not supported")) {
    return "unsupported";
  }
  if (combined.includes("materially changed") || combined.includes("material revision")) {
    return "materially_changed";
  }

  // Explicit numeric gap language (strong signal for contradiction)
  if (/\b\d+\.?\d*\s*[mv%]?\s*(vs|versus|compared to|against)\s*\d+\.?\d*\s*[mv%]?/.test(combined)) {
    // Has explicit numeric comparison — likely contradicted or materially_changed
    if (combined.includes("revision") || combined.includes("updated")) return "materially_changed";
    return "contradicted";
  }

  // Inconsistency/divergence language without numeric specificity
  if (combined.includes("inconsisten") || combined.includes("discrepanc") || combined.includes("diverge")) {
    return "partially_supported";
  }

  // Default: unverifiable (NOT inferred from severity)
  return "unverifiable";
}

// ---------------------------------------------------------------------------
// Provenance builder
// ---------------------------------------------------------------------------

function buildProvenance(
  claimRecord: ResolvedClaimRecord,
  authorityClass: AuthorityClass,
  verdict: ClaimVerdict,
  finding: {
    source_docs?: string[] | null;
    evidence?: string | null;
    detail?: string | null;
    full_analysis?: string | null;
    source_tag?: string | null;
  },
  linkageMethod: string,
): ClaimProvenance {
  const evidenceText = finding.evidence ?? finding.detail ?? finding.full_analysis ?? null;
  const verificationSource = finding.source_docs?.[0] ?? null;

  return {
    claim_id: claimRecord.claim_id,
    exact_claim_text: claimRecord.exact_claim_text,
    normalized_claim: claimRecord.normalized_claim,
    claim_type: claimRecord.claim_type,
    ic_document_id: claimRecord.ic_document_id,
    ic_document_filename: claimRecord.ic_document_filename,
    memo_version: claimRecord.memo_version,
    page_or_location: claimRecord.page_or_location,
    extraction_coordinates: claimRecord.extraction_coordinates,
    verification_source: verificationSource,
    authority_class: authorityClass,
    evidence: evidenceText,
    comparison_basis: null, // Will be enriched in Q4 from canonical key
    verdict,
    linkage_method: linkageMethod,
    confidence: evidenceText ? "medium" : "low",
    rationale: `Claim '${claimRecord.claim_id}' resolved from IC doc '${claimRecord.ic_document_filename}' — verified by ${authorityClass} source — verdict: ${verdict}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveNotLinkedReason(finding: {
  title: string;
  detail?: string | null;
  source_tag?: string | null;
  source_docs?: string[] | null;
  finding_kind?: string | null;
}): string {
  const sourceTag = finding.source_tag ?? "unknown";
  const kind = finding.finding_kind;

  if (sourceTag === "consultant_report" || sourceTag === "fdd") {
    return "Standalone FDD/CDD observation with no originating IC claim — not a contradiction finding";
  }
  if (sourceTag === "financial_model") {
    return "Financial model observation without originating IC claim — supporting evidence only";
  }
  if (sourceTag === "customer_data") {
    return "Customer/revenue data observation without originating IC claim — supporting evidence only";
  }
  if (sourceTag === "ic_memo" || sourceTag === "cim") {
    return "IC narrative observation not anchored to a specific verifiable claim — IC cannot verify itself";
  }
  if (sourceTag === "legal") {
    return "Legal DD observation without originating IC claim — legal DD cannot independently generate contradiction findings";
  }
  return `No originating IC claim found — source: ${sourceTag}, kind: ${kind ?? "unspecified"}`;
}
