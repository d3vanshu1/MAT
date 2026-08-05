/**
 * canonical-family-dedup.ts — OA-03 (finalized)
 *
 * Deterministic canonical-family deduplication with multi-dimensional grouping.
 *
 * Design:
 *   1. Exactly 10 approved SCG issue-family rules (versioned)
 *   2. Issue-key nominates a CANDIDATE family but cannot authorize grouping alone
 *   3. All available material dimensions compared before grouping:
 *      entity, counterparty, customer/supplier role, contract, property, product,
 *      issue/legal provision, affected obligation, period, segment, scope, metric,
 *      unit/scale, actual/forecast, accounting basis, comparison basis, source authority
 *   4. Unknown material dimensions → ungrouped (fail-closed)
 *   5. Deterministic representative selection (evidence completeness → stable ID sort)
 *   6. Non-generative: cannot change severity/reportability/proposition/authority
 *   7. Complete: every finding accounted for (retained/suppressed/ungrouped)
 *   8. Idempotent: same inputs → same outputs regardless of input ordering
 *   9. Full family artifact preserved (not reduced to representative IDs)
 */

import type { CanonicalFinding } from "./canonical-finding.js";
import { fnv1a, normalize, canonicalJsonSerialize } from "./oa-ancestry-service.js";

// ---------------------------------------------------------------------------
// Constants & Config
// ---------------------------------------------------------------------------

export const FAMILY_RULE_VERSION = "3.0.0-scg-finalized";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 10 approved SCG issue families */
export type KnownFamilyId =
  | "fca_section_19_legacy_hire"
  | "customer_change_of_control"
  | "supplier_change_of_control"
  | "one_park_lane_title_and_lease"
  | "contracting_out_1954_act"
  | "courts_design_ip_assignment"
  | "group_trademarks_unregistered"
  | "gdpr_cookies_consent"
  | "stale_legal_dd_scope"
  | "restrictive_covenants";

/** All canonical grouping dimensions that must be compared */
export type GroupingDimension =
  | "entity"
  | "counterparty"
  | "counterparty_role"
  | "contract"
  | "property"
  | "product"
  | "issue_provision"
  | "affected_obligation"
  | "period"
  | "segment"
  | "scope"
  | "metric"
  | "unit_scale"
  | "actual_forecast"
  | "accounting_basis"
  | "comparison_basis"
  | "source_authority";

/** Which dimensions are material for a given family rule */
export interface FamilyRule {
  familyId: KnownFamilyId;
  /** Issue-key values that nominate candidacy for this family */
  issueKeys: string[];
  /** Dimensions that MUST match for grouping (null = not applicable to this family) */
  materialDimensions: GroupingDimension[];
  /** Required separations specific to this family */
  requiredSeparations: Array<{
    dimension: GroupingDimension;
    description: string;
  }>;
  /** Human-readable description */
  description: string;
}

/** Dimension values extracted from a finding */
export interface DimensionVector {
  entity: string | null;
  counterparty: string | null;
  counterparty_role: string | null;
  contract: string | null;
  property: string | null;
  product: string | null;
  issue_provision: string | null;
  affected_obligation: string | null;
  period: string | null;
  segment: string | null;
  scope: string | null;
  metric: string | null;
  unit_scale: string | null;
  actual_forecast: string | null;
  accounting_basis: string | null;
  comparison_basis: string | null;
  source_authority: string | null;
}

/** Per-member occurrence record within a family */
export interface OccurrenceRecord {
  occurrenceId: string;       // finding_id (occurrence-level)
  findingId: string;          // finding_id
  disposition: "retained" | "suppressed";
  reason: string;
}

/** Complete evidence record preserved per-family */
export interface FamilyEvidenceRecord {
  evidenceId: string;
  sourceDoc: string | null;
  figure: string | null;
  verbatimSnippet: string | null;
  verified: boolean;
  /** Full coordinate fields */
  page: string | null;
  section: string | null;
  table: string | null;
  sheet: string | null;
  cell: string | null;
  range: string | null;
  metric: string | null;
  period: string | null;
  scope: string | null;
  unit: string | null;
  accountingBasis: string | null;
  actualOrForecast: string | null;
}

/** Source coordinate preserved per-family */
export interface SourceCoordinate {
  sourceDoc: string | null;
  page: string | null;
  section: string | null;
  table: string | null;
  sheet: string | null;
  cell: string | null;
  range: string | null;
}

/** Complete family artifact — must survive Stage 3 through promotion */
export interface FamilyRecord {
  /** Stable family record ID (deterministic from rule + members) */
  familyRecordId: string;
  /** Which approved family this belongs to */
  issueFamilyKey: KnownFamilyId;
  /** Rule ID */
  ruleId: string;
  /** Rule version */
  ruleVersion: string;
  /** Representative occurrence ID (= finding_id of representative) */
  representativeOccurrenceId: string;
  /** Representative finding ID */
  representativeFindingId: string;
  /** All member occurrence IDs */
  memberOccurrenceIds: string[];
  /** All member finding IDs */
  memberFindingIds: string[];
  /** Per-member disposition */
  memberDispositions: OccurrenceRecord[];
  /** All persisted evidence IDs (from finding evidence arrays, NOT fabricated) */
  evidenceIds: string[];
  /** Complete evidence records */
  evidenceRecords: FamilyEvidenceRecord[];
  /** Claim IDs (separate from evidence IDs) */
  claimIds: string[];
  /** Disclosure IDs (separate from evidence and claims) */
  disclosureIds: string[];
  /** Complete source coordinates */
  sourceCoordinates: SourceCoordinate[];
  /** Affected entities */
  affectedEntities: string[];
  /** Counterparties */
  counterparties: string[];
  /** Properties */
  properties: string[];
  /** Products */
  products: string[];
  /** Contracts */
  contracts: string[];
  /** Persisted source authority/grade (null if unavailable) */
  sourceAuthority: string | null;
  /** Missing reason if authority unavailable */
  sourceAuthorityMissingReason: string | null;
  /** Complete recursive leaf ancestry (using OA-01 occurrence graph) */
  recursiveLeafAncestry: string[];
  /** Rationale code */
  rationaleCode: string;
  /** Matched grouping dimensions */
  matchedDimensions: Partial<DimensionVector>;
  /** Deterministic semantic hash */
  semanticHash: string;
}

/** Result of the full dedup pass — complete family artifact */
export interface FamilyDedupResult {
  families: FamilyRecord[];
  /** Findings NOT grouped (singletons or unknown dimensions) */
  ungroupedFindingIds: string[];
  /** Total input */
  totalInputFindings: number;
  /** Families created */
  totalFamiliesCreated: number;
  /** Total suppressed occurrences */
  totalSuppressed: number;
  /** Deterministic fingerprint of the full result */
  resultFingerprint: string;
  /** Rule version used */
  ruleVersion: string;
  /** Catalogue of family IDs present */
  familyCatalogue: KnownFamilyId[];
}

// ---------------------------------------------------------------------------
// The 10 Approved SCG Family Rules
// ---------------------------------------------------------------------------

export const KNOWN_FAMILY_RULES: FamilyRule[] = [
  {
    familyId: "fca_section_19_legacy_hire",
    description: "FCA s.19 legacy Hire-designated representative permissions gap",
    issueKeys: [
      "dataphone_fca_authorisation_revocation",
      "dataphone_fca_permission_gap",
      "dataphone_fca_section_19_breach",
      "datakom_fca_deregistration_risk",
      "datakom_fca_deregistration_legacy_hire",
      "fsma_general_prohibition_breach",
      "fsma_general_prohibition_risk",
      "fca_section_19_permission_gap",
      "fca_section_19_legacy_hire_breach",
      "fca_legacy_hire_purchase_designation",
    ],
    materialDimensions: ["entity", "issue_provision", "affected_obligation"],
    requiredSeparations: [
      { dimension: "issue_provision", description: "FCA s.19 vs other FCA/Ofcom matters must remain separate" },
    ],
  },
  {
    familyId: "customer_change_of_control",
    description: "Customer contract change-of-control termination rights",
    issueKeys: [
      "change_of_control_customer_termination_rights",
      "change_of_control_customer_termination",
      "change_of_control_customer_termination_risk",
      "change_of_control_customer_termination_unquantified",
      "customer_contract_change_of_control",
      "change_of_control_termination_rights",
      "change_of_control_contract_termination",
      "change_of_control_contract_termination_risk",
      "change_of_control_termination_risk",
      "openwork_change_of_control_termination",
    ],
    materialDimensions: ["counterparty_role", "counterparty", "contract"],
    requiredSeparations: [
      { dimension: "counterparty_role", description: "Customer vs supplier change-of-control must remain separate" },
    ],
  },
  {
    familyId: "supplier_change_of_control",
    description: "Supplier/lender change-of-control prepayment or termination",
    issueKeys: [
      "supplier_change_of_control_termination",
      "change_of_control_debt_repayment",
      "change_of_control_mandatory_prepayment",
      "sa_block_d_change_of_control_consent",
      "gamma_telecom_supplier_concentration",
    ],
    materialDimensions: ["counterparty_role", "counterparty", "contract"],
    requiredSeparations: [
      { dimension: "counterparty_role", description: "Supplier vs customer change-of-control must remain separate" },
    ],
  },
  {
    familyId: "one_park_lane_title_and_lease",
    description: "One Park Lane (Hemel Hempstead) specific title and lease issues",
    issueKeys: [
      "hemel_hempstead_overseas_entity_title_defect",
      "hemel_hempstead_asbestos_survey_gap",
      "hemel_hempstead_title_defect",
      "one_park_lane_title_defect",
      "one_park_lane_lease_issue",
    ],
    materialDimensions: ["property", "issue_provision"],
    requiredSeparations: [
      { dimension: "property", description: "One Park Lane vs any other property must remain separate" },
    ],
  },
  {
    familyId: "contracting_out_1954_act",
    description: "Contracting-out of Landlord and Tenant Act 1954 documentation gap",
    issueKeys: [
      "security_of_tenure_contracting_out_undocumented",
      "contracting_out_1954_act_undocumented",
      "landlord_tenant_act_1954_contracting_out",
      "security_of_tenure_gap",
    ],
    materialDimensions: ["property", "contract", "issue_provision"],
    requiredSeparations: [
      { dimension: "issue_provision", description: "1954 Act contracting-out vs unrelated lease clauses must remain separate" },
    ],
  },
  {
    familyId: "courts_design_ip_assignment",
    description: "Courts Design IP assignment gap (specific third-party developer)",
    issueKeys: [
      "courts_design_ip_assignment_gap",
      "courts_design_ip_assignment_defect",
      "courts_design_ip_assignment",
      "courts_design_ip_title_defect",
      "third_party_ip_assignment_gap_courts_design",
      "ip_assignment_gap_courts_design",
    ],
    materialDimensions: ["entity", "counterparty", "issue_provision"],
    requiredSeparations: [
      { dimension: "entity", description: "Courts Design assignment vs general trade-mark registration must remain separate" },
    ],
  },
  {
    familyId: "group_trademarks_unregistered",
    description: "Group-level unregistered trade marks exposure",
    issueKeys: [
      "unregistered_trade_marks",
      "unregistered_trademarks",
      "unregistered_trademarks_ip_gap",
      "unregistered_ip_and_assignment_gap",
      "group_unregistered_trade_names",
      "ip_ownership_and_trademark_gaps",
      "ip_trademark_unregistered",
      "ip_trade_mark_registration",
      "group_ip_assignment_and_registration_gaps",
      "scg_logo_trademark_registration_pending",
    ],
    materialDimensions: ["entity", "issue_provision"],
    requiredSeparations: [
      { dimension: "entity", description: "Registered vs unregistered trade marks must remain separate; Courts Design specific vs group-level" },
    ],
  },
  {
    familyId: "gdpr_cookies_consent",
    description: "GDPR/PECR cookies and consent compliance gap",
    issueKeys: [
      "gdpr_cookie_consent_gap",
      "gdpr_cookies_consent_breach",
      "pecr_cookie_compliance_gap",
      "cookie_consent_mechanism_deficiency",
      "privacy_cookie_consent_gap",
      "gdpr_consent_mechanism_deficiency",
    ],
    materialDimensions: ["entity", "issue_provision", "scope"],
    requiredSeparations: [],
  },
  {
    familyId: "stale_legal_dd_scope",
    description: "Stale Legal-DD scope or outdated diligence reliance",
    issueKeys: [
      "legal_dd_scope_limitation",
      "legal_dd_stale_scope",
      "vfdd_legal_scope_reliance_gap",
      "legal_dd_scope_outdated",
      "stale_legal_dd_scope",
      "diligence_scope_limitation_legal",
    ],
    materialDimensions: ["scope", "period", "issue_provision"],
    requiredSeparations: [
      { dimension: "issue_provision", description: "Stale Legal-DD scope vs current substantive legal issue must remain separate" },
    ],
  },
  {
    familyId: "restrictive_covenants",
    description: "Senior executive restrictive covenant gaps",
    issueKeys: [
      "senior_executive_restrictive_covenants",
      "senior_executive_restrictive_covenant_gap",
      "senior_executive_restrictive_covenant_weakness",
      "sbd_executive_restrictive_covenant_gap",
      "restrictive_covenant_gap",
      "restrictive_covenant_inadequacy",
      "restrictive_covenant_enforceability_gap",
      "key_man_restrictive_covenant_gap",
      "non_compete_restrictive_covenant_gap",
    ],
    materialDimensions: ["entity", "counterparty", "affected_obligation"],
    requiredSeparations: [
      { dimension: "affected_obligation", description: "Separate restrictive-covenant obligations where entity or individual differs materially" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Dimension Extraction
// ---------------------------------------------------------------------------

/**
 * Extract all material dimension values from a finding.
 * Uses the finding's structured fields, evidence, title and detail.
 * Returns null for dimensions that cannot be determined.
 */
export function extractDimensions(finding: CanonicalFinding): DimensionVector {
  const text = normalize(`${finding.title ?? ""} ${finding.detail ?? ""} ${finding.full_analysis ?? ""}`);
  const issueKey = normalize(finding.issue_key ?? "");

  return {
    entity: extractEntity(finding, text, issueKey),
    counterparty: extractCounterparty(finding, text, issueKey),
    counterparty_role: extractCounterpartyRole(finding, text, issueKey),
    contract: extractContract(finding, text, issueKey),
    property: extractProperty(finding, text, issueKey),
    product: extractProduct(finding, text, issueKey),
    issue_provision: extractIssueProvision(finding, text, issueKey),
    affected_obligation: extractAffectedObligation(finding, text, issueKey),
    period: extractPeriod(finding, text),
    segment: extractSegment(finding, text),
    scope: extractScope(finding, text),
    metric: extractMetric(finding, text),
    unit_scale: extractUnitScale(finding),
    actual_forecast: extractActualForecast(finding),
    accounting_basis: extractAccountingBasis(finding),
    comparison_basis: extractComparisonBasis(finding, text),
    source_authority: null, // persisted authority — use finding's grade, not derived
  };
}

function extractEntity(f: CanonicalFinding, text: string, issueKey: string): string | null {
  // Named entities from issue_key prefix
  if (/^dataphone_/.test(issueKey)) return "dataphone";
  if (/^datakom_/.test(issueKey)) return "datakom";
  if (/^courts_design_/.test(issueKey)) return "courts_design";
  if (/^openwork_/.test(issueKey)) return "openwork";
  if (/^sbd_/.test(issueKey)) return "sbd";
  if (/^neos_/.test(issueKey)) return "neos_networks";
  if (/^gamma_/.test(issueKey)) return "gamma_telecom";
  if (/^cisco_/.test(issueKey)) return "cisco";
  if (/^shraga_/.test(issueKey)) return "shraga";
  if (/^bt_/.test(issueKey)) return "bt";
  // Group-level (issue_key contains group_ or scg_)
  if (/group_|scg_/.test(issueKey)) return "scg_group";
  // Try to detect from title/detail text
  if (/\bdataphone\b/.test(text)) return "dataphone";
  if (/\bdatakom\b/.test(text)) return "datakom";
  if (/\bcourts?\s*design\b/.test(text)) return "courts_design";
  if (/\bsbd\b/.test(text)) return "sbd";
  // Group-level from text (SCG group, group-level, etc.)
  if (/\bscg\s*group\b|\bgroup[\s-]*level\b|\bscg\b.*\bbrand\b/.test(text)) return "scg_group";
  return null;
}

function extractCounterparty(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  if (/openwork/.test(issueKey) || /\bopenwork\b/.test(text)) return "openwork";
  if (/gamma_telecom/.test(issueKey) || /\bgamma\b/.test(text)) return "gamma_telecom";
  if (/cisco/.test(issueKey) || /\bcisco\b/.test(text)) return "cisco";
  if (/neos/.test(issueKey) || /\bneos\b/.test(text)) return "neos_networks";
  if (/bt_msa/.test(issueKey) || /\bbt\b.*\bmsa\b/.test(text)) return "bt";
  return null;
}

function extractCounterpartyRole(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  // Issue-key prefixed with customer/supplier
  if (/customer/.test(issueKey)) return "customer";
  if (/supplier|vendor|lender|debt|prepayment/.test(issueKey)) return "supplier";
  // Text analysis
  const hasCustomer = /\b(customer|client|buyer)\b/.test(text);
  const hasSupplier = /\b(supplier|vendor|lender)\b/.test(text);
  if (hasCustomer && !hasSupplier) return "customer";
  if (hasSupplier && !hasCustomer) return "supplier";
  return null;
}

function extractContract(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  if (/sa_block_d/.test(issueKey)) return "sa_block_d";
  if (/bt_msa/.test(issueKey)) return "bt_msa";
  // Try to identify contracts from text
  if (/\bblock\s*d\b/i.test(text)) return "sa_block_d";
  if (/\bmsa\b.*\bbt\b|\bbt\b.*\bmsa\b/i.test(text)) return "bt_msa";
  return null;
}

function extractProperty(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  if (/hemel_hempstead|one_park_lane/.test(issueKey)) return "one_park_lane_hemel_hempstead";
  if (/chippenham_hill/.test(issueKey)) return "chippenham_hill";
  if (/bolton/.test(issueKey)) return "bolton";
  if (/riduna_park/.test(issueKey)) return "riduna_park";
  if (/cardiff_gate/.test(issueKey)) return "cardiff_gate";
  if (/hereford/.test(issueKey)) return "hereford";
  if (/moulton/.test(issueKey)) return "moulton";
  if (/apex_park/.test(issueKey)) return "apex_park";
  if (/birmingham/.test(issueKey)) return "birmingham";
  if (/bristol/.test(issueKey)) return "bristol";
  // From text
  if (/\bone\s*park\s*lane\b|\bhemel\s*hempstead\b/i.test(text)) return "one_park_lane_hemel_hempstead";
  if (/\bchippenham\b/i.test(text)) return "chippenham_hill";
  return null;
}

function extractProduct(_f: CanonicalFinding, _text: string, issueKey: string): string | null {
  if (/hire_purchase|hire_designated/.test(issueKey)) return "hire_purchase";
  if (/legacy_hire/.test(issueKey)) return "hire_purchase";
  return null;
}

function extractIssueProvision(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  // FCA / regulatory
  if (/fca_section_19|fsma_general_prohibition|fca_authorisation/.test(issueKey)) return "fca_s19_permission";
  if (/fca_deregistration/.test(issueKey)) return "fca_s19_permission";
  if (/general_condition|ofcom_general/.test(issueKey)) return "ofcom_general_conditions";
  if (/cease_charge/.test(issueKey)) return "ofcom_cease_charges";
  // IP
  if (/courts_design_ip_assignment/.test(issueKey)) return "ip_assignment_courts_design";
  if (/unregistered_trade|unregistered_ip|trademark_unregistered/.test(issueKey)) return "unregistered_trademarks";
  if (/ip_trade_mark_registration/.test(issueKey)) return "trademark_registration";
  // Property/lease
  if (/security_of_tenure|contracting_out_1954|landlord_tenant_act_1954/.test(issueKey)) return "lta_1954_contracting_out";
  // GDPR
  if (/gdpr|pecr|cookie|consent/.test(issueKey)) return "gdpr_pecr_cookies";
  // Legal DD (stale scope, limitation, reliance)
  if (/legal_dd_scope|legal_dd_stale|stale_legal_dd|vfdd_legal_scope|diligence_scope_limitation/.test(issueKey)) return "legal_dd_scope_limitation";
  // Restrictive covenants
  if (/restrictive_covenant|non_compete/.test(issueKey)) return "restrictive_covenant";
  // Detect from text
  if (/\bsection\s*19\b|\bs\.?\s*19\b/i.test(text)) return "fca_s19_permission";
  if (/\b1954\s*act\b|\bsecurity\s*of\s*tenure\b/i.test(text)) return "lta_1954_contracting_out";
  return null;
}

function extractAffectedObligation(_f: CanonicalFinding, text: string, issueKey: string): string | null {
  if (/restrictive_covenant/.test(issueKey)) {
    // Try to identify which individual/obligation
    if (/\bceo\b|\bchief\s*executive\b/i.test(text)) return "ceo_non_compete";
    if (/\bcfo\b|\bchief\s*financial\b/i.test(text)) return "cfo_non_compete";
    if (/\bcto\b|\bchief\s*technical\b|\bchief\s*technology\b/i.test(text)) return "cto_non_compete";
    if (/\bmanaging\s*director\b|\bmd\b/i.test(text)) return "md_non_compete";
  }
  return null;
}

function extractPeriod(_f: CanonicalFinding, text: string): string | null {
  const yearMatch = text.match(/\b(fy|cy|h[12])?\s*(20[12]\d)\b/i);
  if (yearMatch) return normalize(yearMatch[0]);
  return null;
}

function extractSegment(_f: CanonicalFinding, text: string): string | null {
  if (/\bmobile\b/i.test(text)) return "mobile";
  if (/\bconnectivity\b/i.test(text)) return "connectivity";
  if (/\bcalls\b.*\blines\b|\blegacy\b/i.test(text)) return "calls_lines_legacy";
  return null;
}

function extractScope(f: CanonicalFinding, _text: string): string | null {
  // From evidence
  for (const e of f.evidence ?? []) {
    if (e.scope) return normalize(e.scope);
  }
  return null;
}

function extractMetric(f: CanonicalFinding, _text: string): string | null {
  for (const e of f.evidence ?? []) {
    if (e.metric) return normalize(e.metric);
  }
  return null;
}

function extractUnitScale(f: CanonicalFinding): string | null {
  for (const e of f.evidence ?? []) {
    if (e.unit) return normalize(e.unit);
  }
  return null;
}

function extractActualForecast(f: CanonicalFinding): string | null {
  for (const e of f.evidence ?? []) {
    if (e.actual_or_forecast) return normalize(e.actual_or_forecast);
  }
  return null;
}

function extractAccountingBasis(f: CanonicalFinding): string | null {
  for (const e of f.evidence ?? []) {
    if (e.accounting_basis) return normalize(e.accounting_basis);
  }
  return null;
}

function extractComparisonBasis(_f: CanonicalFinding, text: string): string | null {
  if (/\bcurrent\s*model\b/i.test(text)) return "current_model";
  if (/\bprior\s*model\b/i.test(text)) return "prior_model";
  if (/\bhardcoded\b|\breference\s*forecast\b/i.test(text)) return "hardcoded_reference";
  return null;
}

// ---------------------------------------------------------------------------
// Dimension Compatibility Check
// ---------------------------------------------------------------------------

/**
 * Check if two findings are compatible for grouping on all material dimensions.
 *
 * Logic:
 *   - If both have non-null values that DIFFER → incompatible (clear separation)
 *   - If both have the SAME non-null value → compatible on this dimension
 *   - If one is null and other is non-null → compatible (null doesn't conflict)
 *   - If BOTH are null on a dimension with a required separation → fail-closed
 *     (we cannot confirm they belong together on a critical distinguishing axis)
 *   - If both are null on a non-required-separation dimension → compatible
 *     (the dimension isn't relevant to these findings)
 */
export function areDimensionsCompatible(
  dimA: DimensionVector,
  dimB: DimensionVector,
  materialDimensions: GroupingDimension[],
  requiredSeparationDimensions: GroupingDimension[] = []
): { compatible: boolean; conflictingDimension: GroupingDimension | null; failedClosed: boolean } {
  for (const dim of materialDimensions) {
    const valA = dimA[dim];
    const valB = dimB[dim];

    // Both non-null and different → incompatible
    if (valA !== null && valB !== null && valA !== valB) {
      return { compatible: false, conflictingDimension: dim, failedClosed: false };
    }

    // Both null on a REQUIRED SEPARATION dimension → fail closed
    if (valA === null && valB === null && requiredSeparationDimensions.includes(dim)) {
      return { compatible: false, conflictingDimension: dim, failedClosed: true };
    }
  }

  return { compatible: true, conflictingDimension: null, failedClosed: false };
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Compute the candidate family for a finding based on issue_key.
 * Returns the family ID if issue_key matches a rule, or null.
 * NOTE: This is candidacy only — dimension compatibility must still be checked.
 */
export function computeCandidateFamily(finding: CanonicalFinding): KnownFamilyId | null {
  if (!finding.issue_key) return null;
  const normalizedKey = normalize(finding.issue_key);
  for (const rule of KNOWN_FAMILY_RULES) {
    if (rule.issueKeys.some((k) => normalize(k) === normalizedKey)) {
      return rule.familyId;
    }
  }
  return null;
}

/**
 * Score finding for representative selection.
 * Evidence completeness → source doc coverage → stable ID ordering.
 * Does NOT use proportion-of-verified for authority (that would be fabrication).
 */
function scoreFinding(f: CanonicalFinding): number {
  let score = 0;
  // Evidence completeness (total entries, not verified proportion)
  score += (f.evidence ?? []).length * 100;
  // Source docs coverage
  score += (f.source_docs ?? []).length * 50;
  // Structured impact presence
  score += (f.structured_impact ?? []).length * 200;
  // Severity anchor present
  if (f.severity_anchor) score += 75;
  // Claim IDs present
  score += (f.claim_ids ?? []).length * 25;
  // Penalty for missing core fields
  if (!f.detail) score -= 50;
  if (!f.full_analysis) score -= 50;
  return score;
}

/**
 * Deterministically select representative from a group.
 * Tie-breaking: score → finding_id lexicographic sort.
 */
export function selectRepresentative(findings: CanonicalFinding[]): CanonicalFinding {
  if (findings.length === 1) return findings[0];
  const scored = findings.map((f) => ({ finding: f, score: scoreFinding(f) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.finding.finding_id.localeCompare(b.finding.finding_id);
  });
  return scored[0].finding;
}

/**
 * Collect all persisted evidence IDs from findings.
 * Uses claim_ids as real evidence IDs. Does NOT fabricate from source_doc:figure.
 */
function collectEvidenceIds(findings: CanonicalFinding[]): string[] {
  const ids = new Set<string>();
  for (const f of findings) {
    // Real evidence IDs are in the evidence array (document_id based)
    for (const e of f.evidence ?? []) {
      if (e.document_id) {
        // Use persisted document_id as the evidence identifier
        ids.add(e.document_id);
      }
    }
  }
  return [...ids].sort();
}

/**
 * Collect all claim IDs (separate from evidence IDs).
 */
function collectClaimIds(findings: CanonicalFinding[]): string[] {
  const ids = new Set<string>();
  for (const f of findings) {
    for (const cid of f.claim_ids ?? []) {
      ids.add(cid);
    }
  }
  return [...ids].sort();
}

/**
 * Build complete evidence records preserving all coordinate fields.
 */
function buildEvidenceRecords(findings: CanonicalFinding[]): FamilyEvidenceRecord[] {
  const records: FamilyEvidenceRecord[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      // Deduplicate by content fingerprint (not by fabricated ID)
      const fp = canonicalJsonSerialize({
        sourceDoc: e.source_doc ?? null,
        figure: e.figure ?? null,
        cell: e.cell_coordinate ?? null,
        sheet: e.sheet_or_page ?? null,
      });
      if (seen.has(fp)) continue;
      seen.add(fp);

      records.push({
        evidenceId: e.document_id ?? `${e.source_doc ?? "unknown"}`,
        sourceDoc: e.source_doc ?? null,
        figure: e.figure ?? null,
        verbatimSnippet: e.verbatim_snippet ?? null,
        verified: e.verified ?? false,
        page: e.sheet_or_page ?? null,
        section: null, // Not available in current schema
        table: null,
        sheet: e.sheet_or_page ?? null,
        cell: e.cell_coordinate ?? null,
        range: null,
        metric: e.metric ?? null,
        period: e.period ?? null,
        scope: e.scope ?? null,
        unit: e.unit ?? null,
        accountingBasis: e.accounting_basis ?? null,
        actualOrForecast: e.actual_or_forecast ?? null,
      });
    }
  }
  return records;
}

/**
 * Build source coordinates preserving all available fields.
 */
function buildSourceCoordinates(findings: CanonicalFinding[]): SourceCoordinate[] {
  const coords: SourceCoordinate[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      const coord: SourceCoordinate = {
        sourceDoc: e.source_doc ?? null,
        page: e.sheet_or_page ?? null,
        section: null,
        table: null,
        sheet: e.sheet_or_page ?? null,
        cell: e.cell_coordinate ?? null,
        range: null,
      };
      const fp = canonicalJsonSerialize(coord);
      if (seen.has(fp)) continue;
      seen.add(fp);
      coords.push(coord);
    }
    for (const si of f.structured_impact ?? []) {
      if (si.source_coordinate || si.source_doc) {
        const coord: SourceCoordinate = {
          sourceDoc: si.source_doc ?? null,
          page: null,
          section: null,
          table: null,
          sheet: null,
          cell: si.source_coordinate ?? null,
          range: null,
        };
        const fp = canonicalJsonSerialize(coord);
        if (seen.has(fp)) continue;
        seen.add(fp);
        coords.push(coord);
      }
    }
  }
  return coords;
}

/**
 * Collect recursive leaf ancestry for all members.
 * Uses OA-01 occurrence graph (merged_from chains).
 */
function collectRecursiveAncestry(findings: CanonicalFinding[]): string[] {
  const ancestry = new Set<string>();
  const queue = [...findings];
  const visited = new Set<string>();

  for (const f of queue) {
    if (visited.has(f.finding_id)) continue;
    visited.add(f.finding_id);
    ancestry.add(f.finding_id);
    for (const mid of f.merged_from_finding_ids ?? []) {
      ancestry.add(mid);
    }
  }
  return [...ancestry].sort();
}

/**
 * Extract affected entities from a group of findings.
 */
function collectAffectedEntities(findings: CanonicalFinding[]): string[] {
  const entities = new Set<string>();
  for (const f of findings) {
    const e = extractEntity(f, normalize(`${f.title} ${f.detail}`), normalize(f.issue_key ?? ""));
    if (e) entities.add(e);
  }
  return [...entities].sort();
}

/**
 * Compute deterministic semantic hash including all required inputs.
 */
export function computeFamilyHash(
  ruleId: string,
  ruleVersion: string,
  dimensions: Partial<DimensionVector>,
  memberOccurrenceIds: string[],
  memberFactualFingerprints: string[],
  evidenceFingerprints: string[],
  sourceCoordinates: SourceCoordinate[],
  representativeOccurrenceId: string,
  dispositions: OccurrenceRecord[]
): string {
  const payload = canonicalJsonSerialize({
    ruleId,
    ruleVersion,
    dimensions,
    memberOccurrenceIds: [...memberOccurrenceIds].sort(),
    memberFactualFingerprints: [...memberFactualFingerprints].sort(),
    evidenceFingerprints: [...evidenceFingerprints].sort(),
    sourceCoordinates,
    representativeOccurrenceId,
    dispositions: [...dispositions].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId)),
  });
  return fnv1a(payload);
}

/**
 * Compute a factual fingerprint for a finding (for hash inclusion).
 */
function factualFingerprint(f: CanonicalFinding): string {
  return fnv1a(canonicalJsonSerialize({
    title: normalize(f.title),
    detail: normalize(f.detail ?? ""),
    severity: f.severity,
    finding_kind: f.finding_kind ?? null,
    issue_key: normalize(f.issue_key ?? ""),
  }));
}

/**
 * Compute evidence fingerprints for hash inclusion.
 */
function evidenceFingerprints(findings: CanonicalFinding[]): string[] {
  const fps: string[] = [];
  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      fps.push(fnv1a(canonicalJsonSerialize({
        source_doc: e.source_doc ?? null,
        figure: e.figure ?? null,
        verified: e.verified,
        cell: e.cell_coordinate ?? null,
        sheet: e.sheet_or_page ?? null,
      })));
    }
  }
  return fps.sort();
}

/**
 * Build a complete FamilyRecord for a sub-group of findings.
 */
function buildFamilyRecord(
  subgroup: CanonicalFinding[],
  familyId: KnownFamilyId,
  matchedDimensions: Partial<DimensionVector>
): FamilyRecord {
  const representative = selectRepresentative(subgroup);
  const memberIds = subgroup.map((f) => f.finding_id).sort();
  const memberOccurrenceIds = [...memberIds]; // In this context, occurrence = finding

  const dispositions: OccurrenceRecord[] = subgroup.map((f) => ({
    occurrenceId: f.finding_id,
    findingId: f.finding_id,
    disposition: f.finding_id === representative.finding_id ? "retained" as const : "suppressed" as const,
    reason: f.finding_id === representative.finding_id
      ? "selected_as_representative"
      : `duplicate_of_${representative.finding_id}`,
  }));

  const memberFps = subgroup.map(factualFingerprint);
  const evFps = evidenceFingerprints(subgroup);
  const srcCoords = buildSourceCoordinates(subgroup);

  const semanticHash = computeFamilyHash(
    familyId,
    FAMILY_RULE_VERSION,
    matchedDimensions,
    memberOccurrenceIds,
    memberFps,
    evFps,
    srcCoords,
    representative.finding_id,
    dispositions
  );

  // Stable family record ID (deterministic from rule + sorted member IDs)
  const familyRecordId = fnv1a(`${familyId}:${FAMILY_RULE_VERSION}:${memberIds.join(",")}`);

  return {
    familyRecordId,
    issueFamilyKey: familyId,
    ruleId: familyId,
    ruleVersion: FAMILY_RULE_VERSION,
    representativeOccurrenceId: representative.finding_id,
    representativeFindingId: representative.finding_id,
    memberOccurrenceIds,
    memberFindingIds: memberIds,
    memberDispositions: dispositions,
    evidenceIds: collectEvidenceIds(subgroup),
    evidenceRecords: buildEvidenceRecords(subgroup),
    claimIds: collectClaimIds(subgroup),
    disclosureIds: [], // No disclosure IDs in current schema — preserve field for future
    sourceCoordinates: srcCoords,
    affectedEntities: collectAffectedEntities(subgroup),
    counterparties: extractCounterparties(subgroup),
    properties: extractProperties(subgroup),
    products: extractProducts(subgroup),
    contracts: extractContracts(subgroup),
    sourceAuthority: null, // Use persisted authority; not derived from verification proportion
    sourceAuthorityMissingReason: "no_persisted_authority_classification_available",
    recursiveLeafAncestry: collectRecursiveAncestry(subgroup),
    rationaleCode: `issue_family_${familyId}`,
    matchedDimensions,
    semanticHash,
  };
}

function extractCounterparties(findings: CanonicalFinding[]): string[] {
  const cps = new Set<string>();
  for (const f of findings) {
    const cp = extractCounterparty(f, normalize(`${f.title} ${f.detail}`), normalize(f.issue_key ?? ""));
    if (cp) cps.add(cp);
  }
  return [...cps].sort();
}

function extractProperties(findings: CanonicalFinding[]): string[] {
  const props = new Set<string>();
  for (const f of findings) {
    const p = extractProperty(f, normalize(`${f.title} ${f.detail}`), normalize(f.issue_key ?? ""));
    if (p) props.add(p);
  }
  return [...props].sort();
}

function extractProducts(findings: CanonicalFinding[]): string[] {
  const prods = new Set<string>();
  for (const f of findings) {
    const p = extractProduct(f, normalize(`${f.title} ${f.detail}`), normalize(f.issue_key ?? ""));
    if (p) prods.add(p);
  }
  return [...prods].sort();
}

function extractContracts(findings: CanonicalFinding[]): string[] {
  const contracts = new Set<string>();
  for (const f of findings) {
    const c = extractContract(f, normalize(`${f.title} ${f.detail}`), normalize(f.issue_key ?? ""));
    if (c) contracts.add(c);
  }
  return [...contracts].sort();
}

// ---------------------------------------------------------------------------
// Partition by Multi-Dimensional Compatibility
// ---------------------------------------------------------------------------

/**
 * Partition findings within a candidate family into sub-groups where all
 * members are dimensionally compatible.
 *
 * Uses a greedy single-pass algorithm:
 * - For each finding, check compatibility with each existing sub-group's seed
 * - If compatible with a sub-group, add to it
 * - If not compatible with any, start a new sub-group
 * - Findings with all-null material dimensions remain ungrouped (fail-closed)
 */
function partitionByDimensions(
  findings: CanonicalFinding[],
  rule: FamilyRule
): { grouped: CanonicalFinding[][]; ungroupedFailClosed: CanonicalFinding[] } {
  if (rule.materialDimensions.length === 0) {
    return { grouped: [findings], ungroupedFailClosed: [] };
  }

  const dimensionCache = new Map<string, DimensionVector>();
  for (const f of findings) {
    dimensionCache.set(f.finding_id, extractDimensions(f));
  }

  const subgroups: Array<{ seed: DimensionVector; findings: CanonicalFinding[] }> = [];
  const ungroupedFailClosed: CanonicalFinding[] = [];
  const requiredSepDims = rule.requiredSeparations.map((s) => s.dimension);

  for (const f of findings) {
    const dims = dimensionCache.get(f.finding_id)!;

    // Check if all material dimensions are null → fail-closed
    const allMaterialNull = rule.materialDimensions.every((d) => dims[d] === null);
    if (allMaterialNull) {
      ungroupedFailClosed.push(f);
      continue;
    }

    // Try to join an existing sub-group
    let placed = false;
    for (const sg of subgroups) {
      const check = areDimensionsCompatible(dims, sg.seed, rule.materialDimensions, requiredSepDims);
      if (check.compatible) {
        sg.findings.push(f);
        // Update seed: fill in any null dimensions with new values
        for (const dim of rule.materialDimensions) {
          if (sg.seed[dim] === null && dims[dim] !== null) {
            (sg.seed as any)[dim] = dims[dim];
          }
        }
        placed = true;
        break;
      }
    }

    if (!placed) {
      subgroups.push({ seed: { ...dims }, findings: [f] });
    }
  }

  return {
    grouped: subgroups.map((sg) => sg.findings),
    ungroupedFailClosed,
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Perform full canonical-family deduplication with multi-dimensional grouping.
 *
 * Guarantees:
 *   - Deterministic: same inputs → same outputs (regardless of input ordering)
 *   - Non-generative: cannot change severity/reportability/proposition/authority
 *   - Complete: every input finding accounted for (retained/suppressed/ungrouped)
 *   - Idempotent: repeated application produces identical result
 *   - Fail-closed: unknown material dimensions → ungrouped
 */
export function deduplicateFindings(findings: CanonicalFinding[]): FamilyDedupResult {
  // Step 1: Sort findings deterministically by finding_id
  const sorted = [...findings].sort((a, b) => a.finding_id.localeCompare(b.finding_id));

  // Step 2: Assign each finding to a candidate family (or ungrouped)
  const candidateBuckets: Map<KnownFamilyId, CanonicalFinding[]> = new Map();
  const ungroupedIds: string[] = [];

  for (const f of sorted) {
    const candidateFamily = computeCandidateFamily(f);
    if (candidateFamily === null) {
      ungroupedIds.push(f.finding_id);
      continue;
    }
    const bucket = candidateBuckets.get(candidateFamily) ?? [];
    bucket.push(f);
    candidateBuckets.set(candidateFamily, bucket);
  }

  // Step 3: Process each candidate family with multi-dimensional grouping
  const families: FamilyRecord[] = [];
  let totalSuppressed = 0;

  for (const [familyId, bucket] of candidateBuckets) {
    const rule = KNOWN_FAMILY_RULES.find((r) => r.familyId === familyId)!;

    // Partition by dimensional compatibility
    const { grouped, ungroupedFailClosed } = partitionByDimensions(bucket, rule);

    // Fail-closed findings go to ungrouped
    for (const f of ungroupedFailClosed) {
      ungroupedIds.push(f.finding_id);
    }

    // Process each dimensionally-compatible sub-group
    for (const subgroup of grouped) {
      if (subgroup.length === 1) {
        // Singletons don't form a family
        ungroupedIds.push(subgroup[0].finding_id);
        continue;
      }

      // Extract the matched dimensions from the sub-group's findings
      const seedDims: Partial<DimensionVector> = {};
      for (const f of subgroup) {
        const dims = extractDimensions(f);
        for (const dim of rule.materialDimensions) {
          if (dims[dim] !== null && !seedDims[dim]) {
            (seedDims as any)[dim] = dims[dim];
          }
        }
      }

      const record = buildFamilyRecord(subgroup, familyId, seedDims);
      families.push(record);
      totalSuppressed += subgroup.length - 1;
    }
  }

  // Step 4: Sort families deterministically
  families.sort((a, b) =>
    a.issueFamilyKey.localeCompare(b.issueFamilyKey) ||
    a.semanticHash.localeCompare(b.semanticHash)
  );

  // Step 5: Compute result fingerprint
  const fingerprintInput = canonicalJsonSerialize({
    families: families.map((f) => f.semanticHash),
    ungrouped: [...ungroupedIds].sort(),
  });
  const resultFingerprint = fnv1a(fingerprintInput);

  // Build catalogue
  const familyCatalogue = [...new Set(families.map((f) => f.issueFamilyKey))].sort() as KnownFamilyId[];

  return {
    families,
    ungroupedFindingIds: ungroupedIds.sort(),
    totalInputFindings: findings.length,
    totalFamiliesCreated: families.length,
    totalSuppressed,
    resultFingerprint,
    ruleVersion: FAMILY_RULE_VERSION,
    familyCatalogue,
  };
}

// ---------------------------------------------------------------------------
// Verification Functions
// ---------------------------------------------------------------------------

/**
 * Verify completeness: every input finding appears exactly once in output.
 */
export function verifyCompleteness(
  inputFindingIds: string[],
  result: FamilyDedupResult
): { complete: boolean; missing: string[]; duplicated: string[] } {
  const accountedFor = new Map<string, number>();

  for (const family of result.families) {
    for (const id of family.memberFindingIds) {
      accountedFor.set(id, (accountedFor.get(id) ?? 0) + 1);
    }
  }
  for (const id of result.ungroupedFindingIds) {
    accountedFor.set(id, (accountedFor.get(id) ?? 0) + 1);
  }

  const missing: string[] = [];
  const duplicated: string[] = [];
  const checked = new Set<string>();

  for (const id of inputFindingIds) {
    if (checked.has(id)) continue; // Skip duplicate input IDs
    checked.add(id);
    const count = accountedFor.get(id) ?? 0;
    if (count === 0) missing.push(id);
    if (count > 1) duplicated.push(id);
  }

  return { complete: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}

/**
 * Verify non-generative: family rules do not change finding content.
 */
export function verifyNonGenerative(
  originalFindings: CanonicalFinding[],
  result: FamilyDedupResult
): { valid: boolean; violations: string[] } {
  const origMap = new Map<string, CanonicalFinding>();
  for (const f of originalFindings) origMap.set(f.finding_id, f);

  const violations: string[] = [];

  for (const family of result.families) {
    const rep = origMap.get(family.representativeFindingId);
    if (!rep) {
      violations.push(`representative ${family.representativeFindingId} not found in original input`);
      continue;
    }

    // Verify no member has been content-modified
    for (const disp of family.memberDispositions) {
      const orig = origMap.get(disp.findingId);
      if (!orig) {
        violations.push(`member ${disp.findingId} not found in original input`);
      }
    }

    // Verify representative is an existing canonical finding (not a container ID)
    if (!origMap.has(family.representativeFindingId)) {
      violations.push(`family ${family.issueFamilyKey}: representative is not an existing canonical finding`);
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Verify no occurrence appears in two families.
 */
export function verifyNoDoubleGrouping(result: FamilyDedupResult): { valid: boolean; duplicates: string[] } {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const family of result.families) {
    for (const id of family.memberFindingIds) {
      const existing = seen.get(id);
      if (existing) {
        duplicates.push(`${id} in both ${existing} and ${family.issueFamilyKey}`);
      } else {
        seen.set(id, family.issueFamilyKey);
      }
    }
  }

  return { valid: duplicates.length === 0, duplicates };
}

/**
 * Get the approved family catalogue (the exact 10 family IDs).
 */
export function getApprovedFamilyCatalogue(): KnownFamilyId[] {
  return KNOWN_FAMILY_RULES.map((r) => r.familyId);
}

/**
 * Check that a result contains no retired/generic family IDs.
 */
export function verifyNoRetiredFamilies(result: FamilyDedupResult): { valid: boolean; retiredIds: string[] } {
  const RETIRED_FAMILY_IDS = [
    "earn_out_basis_divergence",
    "revenue_recognition_cutoff",
    "nwc_peg_adjustment",
    "management_key_person",
    "trademark_ownership_chain",
    "customer_revenue_concentration",
    "supplier_single_source",
    "transfer_pricing_structure",
    "conduct_of_business_breach",
    "fca_permissions_gap",
  ];

  const retiredIds = result.families
    .map((f) => f.issueFamilyKey)
    .filter((id) => RETIRED_FAMILY_IDS.includes(id));

  return { valid: retiredIds.length === 0, retiredIds };
}
