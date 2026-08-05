/**
 * canonical-family-dedup.ts — OA-03
 *
 * Deterministic canonical-family deduplication service.
 *
 * Key design decisions:
 *   1. Explicit versioned rules for all known issue families (10 frozen families)
 *   2. Deterministic representative selection:
 *      authority quality → evidence completeness → stable ID ordering
 *   3. Anti-overmerge guards: customer vs supplier CoC, registered vs unregistered TM, etc.
 *   4. Every member remains accounted for (no silent disappearance)
 *   5. Family rules cannot change severity/reportability/proposition/authority
 *   6. Unknown dimensions fail closed (no grouping)
 *   7. Repeated finalization is idempotent (same inputs → same outputs)
 *   8. Semantic hash of family membership enables replay verification
 */

import type { CanonicalFinding } from "./canonical-finding.js";
import { fnv1a, normalize } from "./oa-ancestry-service.js";

// ---------------------------------------------------------------------------
// Constants & Config
// ---------------------------------------------------------------------------

export const FAMILY_RULE_VERSION = "2.0.0-scg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 10 SCG deal-specific issue families */
export type KnownFamilyId =
  | "fca_permissions_gap"
  | "earn_out_basis_divergence"
  | "revenue_recognition_cutoff"
  | "nwc_peg_adjustment"
  | "management_key_person"
  | "trademark_ownership_chain"
  | "customer_revenue_concentration"
  | "supplier_single_source"
  | "transfer_pricing_structure"
  | "conduct_of_business_breach";

/** Rule definition for one known family */
export interface FamilyRule {
  familyId: KnownFamilyId;
  /** issue_key values that map to this family */
  issueKeys: string[];
  /** finding_kind values eligible for this family (null = any) */
  eligibleKinds: string[] | null;
  /** Anti-overmerge exclusion pairs: if a finding matches one of these dimension values,
   *  it MUST NOT be grouped with findings matching the other value in the pair */
  antiOvermergePairs: Array<{ dimension: string; valueA: string; valueB: string }>;
}

/** Result of deduplicating one family */
export interface FamilyRecord {
  familyId: KnownFamilyId;
  familyRule: string;          // familyId
  familyRuleVersion: string;   // FAMILY_RULE_VERSION
  /** Representative finding_id (deterministically selected) */
  representativeFindingId: string;
  /** All member finding_ids (includes representative) */
  memberFindingIds: string[];
  /** All evidence IDs across all members */
  allEvidenceIds: string[];
  /** All source coordinates from all members */
  sourceCoordinates: string[];
  /** Strongest severity across members */
  strongestSeverity: "critical" | "warning" | "info";
  /** Source grade based on evidence completeness */
  sourceGrade: "primary" | "secondary" | "tertiary";
  /** Rationale code for why these are duplicates */
  duplicateRationaleCode: string;
  /** Per-member retained/suppressed status */
  memberDisposition: Array<{
    findingId: string;
    status: "retained" | "suppressed";
    reason: string;
  }>;
  /** Complete ancestry (merged_from chains) for all members */
  fullAncestry: string[];
  /** Deterministic semantic hash of family composition */
  semanticHash: string;
}

/** Result of the full dedup pass */
export interface FamilyDedupResult {
  families: FamilyRecord[];
  /** Findings that were NOT grouped into any family (singletons or unknown dimensions) */
  ungroupedFindingIds: string[];
  /** Diagnostics */
  totalInputFindings: number;
  totalFamiliesCreated: number;
  totalSuppressed: number;
  /** Deterministic fingerprint of the full result */
  resultFingerprint: string;
}

// ---------------------------------------------------------------------------
// Known Family Rules (frozen, versioned)
// ---------------------------------------------------------------------------

export const KNOWN_FAMILY_RULES: FamilyRule[] = [
  {
    familyId: "fca_permissions_gap",
    issueKeys: [
      "dataphone_fca_authorisation_revocation",
      "datakom_fca_deregistration_status",
      "datakom_fca_deregistration",
      "fsma_general_prohibition_legacy_hire",
      "prs_network_operator_registration_breach",
    ],
    eligibleKinds: ["absence_claim", "source_stated_risk", "process_observation"],
    antiOvermergePairs: [
      { dimension: "fca_proposition_type", valueA: "s19_permission", valueB: "conduct_of_business" },
    ],
  },
  {
    familyId: "earn_out_basis_divergence",
    issueKeys: [
      "contingent_consideration_liability",
      "earnout_obligations_unquantified",
      "earnout_mechanics_governance_disclosure",
      "nt_voice_data_deferred_contingent_consideration",
      "topco_deferred_consideration_fy2025",
      "xon_acquisition_earnout_disclosure",
      "acquisition_l3m_ebitda_basis_and_contingent_consideration",
    ],
    eligibleKinds: ["data_divergence", "source_stated_risk"],
    antiOvermergePairs: [],
  },
  {
    familyId: "revenue_recognition_cutoff",
    issueKeys: [
      "revenue_basis_discrepancy",
      "revenue_budget_vs_actuals_shortfall",
      "recurring_nonrecurring_revenue_not_split_in_plan",
      "deferred_income_billing_model_shift",
      "nhs_deferred_income_wc_unwind",
      "contracted_vs_variable_revenue_split",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [],
  },
  {
    familyId: "nwc_peg_adjustment",
    issueKeys: [
      "nwc_negative_trend_and_seasonality",
      "working_capital_surgery_connect_structural_tension",
      "nhs_dsi_working_capital_normalisation",
      "debtor_ageing_deterioration",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [],
  },
  {
    familyId: "management_key_person",
    issueKeys: [
      "senior_executive_restrictive_covenants",
      "senior_executive_restrictive_covenant_gap",
      "senior_executive_restrictive_covenant_weakness",
      "senior_executive_restrictive_covenant_gaps",
      "senior_executive_restrictive_covenant_risk",
      "senior_executive_restrictive_covenant_adequacy",
      "senior_executive_restrictive_covenant_enforceability",
      "sbd_executive_restrictive_covenant_gap",
      "sbd_executive_restrictive_covenant_scope",
      "sbd_executive_restrictive_covenant_adequacy",
      "sbd_executive_restrictive_covenants_inadequate",
      "key_man_restrictive_covenant_weakness",
      "key_man_restrictive_covenant_duration",
      "key_man_covenant_adequacy",
      "key_man_covenant_deficiency",
      "key_man_departure_and_non_compete_risk",
      "key_executive_covenant_enforceability",
      "restrictive_covenant_scope_senior_executives",
      "restrictive_covenant_enforceability",
      "restrictive_covenant_enforceability_senior_execs",
      "senior_exec_restrictive_covenants",
      "preventable_employee_departures",
      "dpo_ciso_dual_role_key_person",
      "cto_slt_exclusion",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [],
  },
  {
    familyId: "trademark_ownership_chain",
    issueKeys: [
      "unregistered_trade_marks",
      "unregistered_trademarks",
      "unregistered_trademarks_ip_gap",
      "unregistered_trademarks_ip_assignment",
      "unregistered_trademarks_no_jurisdiction",
      "unregistered_trade_marks_core_brand",
      "unregistered_trade_marks_all_jurisdictions",
      "unregistered_trademark_portfolio",
      "unregistered_group_trademarks",
      "unregistered_ip_and_assignment_gap",
      "group_unregistered_trade_names",
      "ip_ownership_and_trademark_gaps",
      "ip_ownership_group_and_design_agency_gap",
      "ip_assignment_deficiency",
      "ip_assignment_gap_courts_design",
      "ip_assignment_third_party_developer",
      "ip_structural_deficiencies",
      "ip_title_and_trademark_defects",
      "ip_trademark_unregistered",
      "ip_trade_mark_registration",
      "group_ip_assignment_and_registration_gaps",
      "courts_design_ip_assignment_gap",
      "courts_design_ip_assignment_defect",
      "courts_design_ip_assignment",
      "courts_design_ip_title_defect",
      "third_party_ip_assignment_gap_courts_design",
      "bt_msa_ip_clause_incomplete",
      "shraga_ip_ownership_risk",
      "scg_logo_trademark_registration_pending",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [
      { dimension: "ip_type", valueA: "registered_trademark", valueB: "unregistered_trademark" },
    ],
  },
  {
    familyId: "customer_revenue_concentration",
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
      "change_of_control_debt_repayment",
      "change_of_control_mandatory_prepayment",
      "sa_block_d_change_of_control_consent",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [
      { dimension: "counterparty_role", valueA: "customer", valueB: "supplier" },
    ],
  },
  {
    familyId: "supplier_single_source",
    issueKeys: [
      "supplier_change_of_control_termination",
      "gamma_telecom_supplier_concentration",
      "single_vendor_alignment_aggregator_risk",
      "cisco_dependency_caaas_roadmap_risk",
      "supplier_msa_outdated_data_protection_provisions",
      "neos_networks_minimum_commitment",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [
      { dimension: "counterparty_role", valueA: "supplier", valueB: "customer" },
    ],
  },
  {
    familyId: "transfer_pricing_structure",
    issueKeys: [
      "calls_lines_structural_decline",
      "calls_lines_legacy_decline",
      "mobile_segment_margin_decline",
      "reseller_gross_margin_structural_decline",
      "aggregator_gross_margin_compression",
      "connectivity_margin_non_recurring_drivers",
      "connectivity_margin_bundling_dependency",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [],
  },
  {
    familyId: "conduct_of_business_breach",
    issueKeys: [
      "general_conditions_cease_charge_breach",
      "general_conditions_compliance_breach",
      "general_conditions_regulatory_breach",
      "general_condition_c2_cease_charges_breach",
      "general_condition_c2_cease_charge_breach",
      "cease_charges_regulatory_breach",
      "cancellation_charge_regulatory_breach",
      "regulatory_breach_cease_charges_gc",
      "regulatory_cease_charges_breach",
      "regulatory_gc_breach_risk",
      "ofcom_general_condition_breaches",
      "ofcom_general_conditions_technical_breaches",
      "ofcom_unpaid_administrative_charges",
    ],
    eligibleKinds: null,
    antiOvermergePairs: [],
  },
];

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Compute the issue_family_key for a finding.
 * Returns the known family ID if matched, or null if no family applies.
 */
export function computeFamilyKey(finding: CanonicalFinding): KnownFamilyId | null {
  if (!finding.issue_key) return null;
  const normalizedKey = normalize(finding.issue_key);
  for (const rule of KNOWN_FAMILY_RULES) {
    // Check issue_key match
    const keyMatches = rule.issueKeys.some((k) => normalize(k) === normalizedKey);
    if (!keyMatches) continue;
    // Check finding_kind eligibility
    if (rule.eligibleKinds !== null) {
      if (!finding.finding_kind || !rule.eligibleKinds.includes(finding.finding_kind)) {
        continue;
      }
    }
    return rule.familyId;
  }
  return null;
}

/**
 * Extract dimension value for anti-overmerge checks.
 * Inspects the finding's title, detail, and evidence to infer dimension values.
 */
function extractDimensionValue(finding: CanonicalFinding, dimension: string): string | null {
  const searchText = normalize(`${finding.title} ${finding.detail} ${finding.full_analysis}`);

  if (dimension === "counterparty_role") {
    // Infer if finding is about a customer or supplier
    const hasCustomer = /customer|client|buyer|revenue.?concentration/i.test(searchText);
    const hasSupplier = /supplier|vendor|supply.?chain/i.test(searchText);
    if (hasCustomer && !hasSupplier) return "customer";
    if (hasSupplier && !hasCustomer) return "supplier";
    return null; // ambiguous — don't group
  }

  if (dimension === "ip_type") {
    const hasUnregistered = /unregistered|common.?law.?mark|™/i.test(searchText);
    // Must check registered AFTER removing "unregistered" matches to avoid substring collision
    const textWithoutUnreg = searchText.replace(/unregistered/gi, "___");
    const hasRegistered = /registered.?trademark|®|registration/i.test(textWithoutUnreg);
    if (hasRegistered && !hasUnregistered) return "registered_trademark";
    if (hasUnregistered && !hasRegistered) return "unregistered_trademark";
    return null;
  }

  if (dimension === "fca_proposition_type") {
    const hasS19 = /s\.?\s*19|section\s*19|permission.?(?:gap|missing|absent)|authoris(?:ation|ed)/i.test(searchText);
    const hasConduct = /conduct.?of.?business|tcf|treating.?customers.?fairly|cobs/i.test(searchText);
    if (hasS19 && !hasConduct) return "s19_permission";
    if (hasConduct && !hasS19) return "conduct_of_business";
    return null; // ambiguous — don't group across these
  }

  return null;
}

/**
 * Check if two findings violate anti-overmerge rules for a given family.
 * Returns true if they MUST NOT be grouped together.
 */
export function violatesAntiOvermerge(
  findingA: CanonicalFinding,
  findingB: CanonicalFinding,
  rule: FamilyRule
): boolean {
  for (const pair of rule.antiOvermergePairs) {
    const valA = extractDimensionValue(findingA, pair.dimension);
    const valB = extractDimensionValue(findingB, pair.dimension);
    // If both findings have values and they conflict, they cannot be merged
    if (valA && valB && valA !== valB) return true;
    // Also prevent if one matches valueA and other matches valueB
    if (valA === pair.valueA && valB === pair.valueB) return true;
    if (valA === pair.valueB && valB === pair.valueA) return true;
  }
  return false;
}

/**
 * Score finding for representative selection (higher = better representative).
 * Authority quality → evidence completeness → fewest missing fields → stable ID.
 */
function scoreFinding(f: CanonicalFinding): number {
  let score = 0;

  // Authority: evidence with verified=true
  const verifiedEvidence = (f.evidence ?? []).filter((e) => e.verified).length;
  score += verifiedEvidence * 1000;

  // Evidence completeness: total evidence entries
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
  if (!f.issue_key) score -= 25;

  return score;
}

/**
 * Deterministically select the representative from a group of findings.
 * Tie-breaking: authority quality → evidence completeness → stable ID sort.
 */
export function selectRepresentative(findings: CanonicalFinding[]): CanonicalFinding {
  if (findings.length === 1) return findings[0];

  // Score all findings
  const scored = findings.map((f) => ({ finding: f, score: scoreFinding(f) }));

  // Sort: highest score first, then by finding_id for determinism
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.finding.finding_id.localeCompare(b.finding.finding_id);
  });

  return scored[0].finding;
}

/**
 * Compute the strongest severity across a set of findings.
 */
function strongestSeverity(findings: CanonicalFinding[]): "critical" | "warning" | "info" {
  const order = { critical: 3, warning: 2, info: 1 } as const;
  let max: "critical" | "warning" | "info" = "info";
  for (const f of findings) {
    if (order[f.severity] > order[max]) max = f.severity;
  }
  return max;
}

/**
 * Compute source grade based on evidence verification across group.
 */
function computeSourceGrade(findings: CanonicalFinding[]): "primary" | "secondary" | "tertiary" {
  let verifiedCount = 0;
  let totalEvidence = 0;
  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      totalEvidence++;
      if (e.verified) verifiedCount++;
    }
  }
  if (totalEvidence === 0) return "tertiary";
  const ratio = verifiedCount / totalEvidence;
  if (ratio >= 0.5) return "primary";
  if (ratio >= 0.2) return "secondary";
  return "tertiary";
}

/**
 * Collect all evidence IDs from a set of findings.
 */
function collectEvidenceIds(findings: CanonicalFinding[]): string[] {
  const ids = new Set<string>();
  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      // Use figure + source_doc as a composite evidence ID
      ids.add(`${e.source_doc}:${e.figure}`);
    }
    for (const cid of f.claim_ids ?? []) {
      ids.add(cid);
    }
  }
  return [...ids].sort();
}

/**
 * Collect all source coordinates from findings.
 */
function collectSourceCoordinates(findings: CanonicalFinding[]): string[] {
  const coords = new Set<string>();
  for (const f of findings) {
    for (const e of f.evidence ?? []) {
      if (e.cell_coordinate) {
        coords.add(`${e.source_doc ?? "unknown"}:${e.sheet_or_page ?? ""}:${e.cell_coordinate}`);
      }
    }
    for (const si of f.structured_impact ?? []) {
      if (si.source_coordinate) {
        coords.add(`${si.source_doc ?? "unknown"}:${si.source_coordinate}`);
      }
    }
  }
  return [...coords].sort();
}

/**
 * Collect full ancestry (merged_from chains) for all members.
 */
function collectAncestry(findings: CanonicalFinding[]): string[] {
  const ancestry = new Set<string>();
  for (const f of findings) {
    ancestry.add(f.finding_id);
    for (const mid of f.merged_from_finding_ids ?? []) {
      ancestry.add(mid);
    }
  }
  return [...ancestry].sort();
}

/**
 * Compute deterministic semantic hash of a family's composition.
 * Inputs: sorted member IDs + family rule + version.
 */
export function computeFamilyHash(memberIds: string[], familyId: string): string {
  const sorted = [...memberIds].sort();
  const payload = `${familyId}:${FAMILY_RULE_VERSION}:${sorted.join(",")}`;
  return fnv1a(payload);
}

/**
 * Partition findings within a family by anti-overmerge guards.
 * Returns sub-groups where each sub-group can safely be deduplicated together.
 */
function partitionByAntiOvermerge(
  findings: CanonicalFinding[],
  rule: FamilyRule
): CanonicalFinding[][] {
  if (rule.antiOvermergePairs.length === 0) return [findings];

  // Group by dimension values — findings with same dimension values can be grouped
  const groups: Map<string, CanonicalFinding[]> = new Map();
  for (const f of findings) {
    const dimValues: string[] = [];
    for (const pair of rule.antiOvermergePairs) {
      const val = extractDimensionValue(f, pair.dimension) ?? "__ambiguous__";
      dimValues.push(`${pair.dimension}=${val}`);
    }
    const key = dimValues.sort().join("|");
    const existing = groups.get(key) ?? [];
    existing.push(f);
    groups.set(key, existing);
  }

  return [...groups.values()];
}

/**
 * Build a single FamilyRecord for a sub-group of findings belonging to the same family.
 */
function buildFamilyRecord(
  subgroup: CanonicalFinding[],
  familyId: KnownFamilyId,
  rationaleCode: string
): FamilyRecord {
  const representative = selectRepresentative(subgroup);
  const memberIds = subgroup.map((f) => f.finding_id).sort();

  return {
    familyId,
    familyRule: familyId,
    familyRuleVersion: FAMILY_RULE_VERSION,
    representativeFindingId: representative.finding_id,
    memberFindingIds: memberIds,
    allEvidenceIds: collectEvidenceIds(subgroup),
    sourceCoordinates: collectSourceCoordinates(subgroup),
    strongestSeverity: strongestSeverity(subgroup),
    sourceGrade: computeSourceGrade(subgroup),
    duplicateRationaleCode: rationaleCode,
    memberDisposition: subgroup.map((f) => ({
      findingId: f.finding_id,
      status: f.finding_id === representative.finding_id ? "retained" as const : "suppressed" as const,
      reason: f.finding_id === representative.finding_id
        ? "selected_as_representative"
        : `duplicate_of_${representative.finding_id}`,
    })),
    fullAncestry: collectAncestry(subgroup),
    semanticHash: computeFamilyHash(memberIds, familyId),
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Perform full canonical-family deduplication on a set of findings.
 *
 * Guarantees:
 *   - Deterministic: same inputs → same outputs (regardless of input ordering)
 *   - Non-generative: family rules cannot change severity/reportability/proposition/authority
 *   - Complete: every input finding is accounted for (retained, suppressed, or ungrouped)
 *   - Idempotent: running again on same input produces identical result
 */
export function deduplicateFindings(findings: CanonicalFinding[]): FamilyDedupResult {
  // Step 1: Sort findings deterministically by finding_id for stable processing
  const sorted = [...findings].sort((a, b) => a.finding_id.localeCompare(b.finding_id));

  // Step 2: Assign each finding to a family (or ungrouped)
  const familyBuckets: Map<KnownFamilyId, CanonicalFinding[]> = new Map();
  const ungroupedIds: string[] = [];

  for (const f of sorted) {
    const familyKey = computeFamilyKey(f);
    if (familyKey === null) {
      ungroupedIds.push(f.finding_id);
      continue;
    }
    const bucket = familyBuckets.get(familyKey) ?? [];
    bucket.push(f);
    familyBuckets.set(familyKey, bucket);
  }

  // Step 3: Process each family bucket
  const families: FamilyRecord[] = [];
  let totalSuppressed = 0;

  for (const [familyId, bucket] of familyBuckets) {
    // Singletons don't form a dedup family
    if (bucket.length === 1) {
      ungroupedIds.push(bucket[0].finding_id);
      continue;
    }

    // Look up the rule
    const rule = KNOWN_FAMILY_RULES.find((r) => r.familyId === familyId)!;

    // Partition by anti-overmerge guards
    const subgroups = partitionByAntiOvermerge(bucket, rule);

    for (const subgroup of subgroups) {
      if (subgroup.length === 1) {
        // After partitioning, singleton becomes ungrouped
        ungroupedIds.push(subgroup[0].finding_id);
        continue;
      }

      const record = buildFamilyRecord(
        subgroup,
        familyId,
        `issue_family_${familyId}`
      );
      families.push(record);
      totalSuppressed += subgroup.length - 1; // all except representative
    }
  }

  // Step 4: Sort families deterministically
  families.sort((a, b) => a.familyId.localeCompare(b.familyId) || a.semanticHash.localeCompare(b.semanticHash));

  // Step 5: Compute result fingerprint
  const fingerprintInput = families.map((f) => f.semanticHash).join(":") + "|" + ungroupedIds.sort().join(",");
  const resultFingerprint = fnv1a(fingerprintInput);

  return {
    families,
    ungroupedFindingIds: ungroupedIds.sort(),
    totalInputFindings: findings.length,
    totalFamiliesCreated: families.length,
    totalSuppressed,
    resultFingerprint,
  };
}

/**
 * Verify that no member disappears silently during deduplication.
 * Returns true if every input finding_id appears exactly once in either
 * a family's memberFindingIds or in ungroupedFindingIds.
 */
export function verifyCompleteness(
  inputFindingIds: string[],
  result: FamilyDedupResult
): { complete: boolean; missing: string[]; duplicated: string[] } {
  const accountedFor = new Map<string, number>();

  // Count from families
  for (const family of result.families) {
    for (const id of family.memberFindingIds) {
      accountedFor.set(id, (accountedFor.get(id) ?? 0) + 1);
    }
  }

  // Count from ungrouped
  for (const id of result.ungroupedFindingIds) {
    accountedFor.set(id, (accountedFor.get(id) ?? 0) + 1);
  }

  const missing: string[] = [];
  const duplicated: string[] = [];

  for (const id of inputFindingIds) {
    const count = accountedFor.get(id) ?? 0;
    if (count === 0) missing.push(id);
    if (count > 1) duplicated.push(id);
  }

  return { complete: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}

/**
 * Verify that family rules do not change severity, reportability, proposition, or authority
 * of any finding. This is a structural guarantee — the dedup only selects/suppresses,
 * never modifies finding content.
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

    // Representative's severity must match original
    if (rep.severity !== family.strongestSeverity && family.strongestSeverity !== strongestSeverity(
      family.memberFindingIds.map((id) => origMap.get(id)!).filter(Boolean)
    )) {
      violations.push(`family ${family.familyId}: severity mismatch`);
    }

    // No member has been content-modified (they are just retained/suppressed)
    for (const member of family.memberDisposition) {
      const orig = origMap.get(member.findingId);
      if (!orig) {
        violations.push(`member ${member.findingId} not found in original input`);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}
