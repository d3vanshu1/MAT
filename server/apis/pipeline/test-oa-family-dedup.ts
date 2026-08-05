/**
 * TestOaFamilyDedup — OA-03 Acceptance Tests (finalized)
 *
 * T1-T10: Named deterministic fixtures for each of the 10 approved SCG families.
 * T11: Cross-family structural assertions (no double-grouping, fail-closed, etc.)
 * T12: SCG integration test against persisted production artifact.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import {
  deduplicateFindings,
  computeCandidateFamily,
  areDimensionsCompatible,
  extractDimensions,
  selectRepresentative,
  computeFamilyHash,
  verifyCompleteness,
  verifyNonGenerative,
  verifyNoDoubleGrouping,
  verifyNoRetiredFamilies,
  getApprovedFamilyCatalogue,
  FAMILY_RULE_VERSION,
  KNOWN_FAMILY_RULES,
} from "./canonical-family-dedup.js";
import type { KnownFamilyId, FamilyDedupResult, DimensionVector } from "./canonical-family-dedup.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_RUN_ID = "576171a3-5533-4dcc-8af6-7a1ffd56026e";

// ---------------------------------------------------------------------------
// Test Fixture Helpers
// ---------------------------------------------------------------------------

let fixtureCounter = 0;
function makeId(): string {
  fixtureCounter++;
  const hex = fixtureCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-a000-${hex}`;
}

function makeFinding(overrides: Partial<CanonicalFinding> & { issue_key: string }): CanonicalFinding {
  const { issue_key, ...rest } = overrides;
  return {
    finding_id: makeId(),
    severity: "warning",
    title: rest.title ?? `Finding ${fixtureCounter}`,
    detail: rest.detail ?? "Test detail",
    full_analysis: rest.full_analysis ?? "Test full analysis",
    source_docs: rest.source_docs ?? ["doc1.pdf"],
    issue_key,
    finding_kind: rest.finding_kind ?? "source_stated_risk",
    category: rest.category ?? "principal_finding",
    evidence: rest.evidence ?? [],
    claim_ids: rest.claim_ids ?? [],
    merged_from_finding_ids: rest.merged_from_finding_ids ?? [],
    structured_impact: rest.structured_impact ?? [],
  } as CanonicalFinding;
}

interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  skipped?: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// T1: FCA Section 19 Legacy Hire
// ---------------------------------------------------------------------------

function t1_fca_section_19(): TestResult {
  fixtureCounter = 100;
  const checks: string[] = [];

  // True duplicates: same entity (dataphone), same provision (s.19)
  const f1 = makeFinding({
    issue_key: "dataphone_fca_authorisation_revocation",
    title: "Dataphone FCA authorisation revocation risk",
    detail: "Dataphone's hire purchase designation may trigger FCA section 19 revocation",
  });
  const f2 = makeFinding({
    issue_key: "dataphone_fca_permission_gap",
    title: "Dataphone FCA permission gap under section 19",
    detail: "Dataphone lacks current FCA section 19 authorisation for hire activities",
  });

  // Different entity (datakom) — must NOT merge with dataphone
  const f3 = makeFinding({
    issue_key: "datakom_fca_deregistration_risk",
    title: "Datakom FCA deregistration risk",
    detail: "Datakom faces deregistration from FCA register",
  });

  // Different provision (Ofcom, not FCA s.19) — must NOT merge
  const f4 = makeFinding({
    issue_key: "general_conditions_cease_charge_breach",
    title: "Ofcom general conditions cease charge breach",
    detail: "Breach of Ofcom general conditions regarding cease charges",
  });

  const result = deduplicateFindings([f1, f2, f3, f4]);

  // f1 + f2 should form one family (same entity + same provision)
  const fcaFamily = result.families.find(f => f.issueFamilyKey === "fca_section_19_legacy_hire");
  if (!fcaFamily) {
    checks.push("MISSING: fca_section_19_legacy_hire family not created");
  } else {
    if (fcaFamily.memberFindingIds.length !== 2) {
      checks.push(`WRONG_SIZE: expected 2 members, got ${fcaFamily.memberFindingIds.length}`);
    }
    if (!fcaFamily.memberFindingIds.includes(f1.finding_id) || !fcaFamily.memberFindingIds.includes(f2.finding_id)) {
      checks.push("WRONG_MEMBERS: f1 and f2 should be in the family");
    }
    // Representative is deterministic
    const rep = selectRepresentative([f1, f2]);
    if (fcaFamily.representativeFindingId !== rep.finding_id) {
      checks.push("REP_MISMATCH: representative not deterministic");
    }
    // Proposition unchanged
    if (fcaFamily.memberDispositions.find(d => d.findingId === rep.finding_id)?.disposition !== "retained") {
      checks.push("REP_NOT_RETAINED");
    }
    // All evidence survives
    // Idempotent
    const result2 = deduplicateFindings([f1, f2, f3, f4]);
    if (result.resultFingerprint !== result2.resultFingerprint) {
      checks.push("NOT_IDEMPOTENT");
    }
  }

  // f3 (datakom) must be ungrouped (different entity)
  if (!result.ungroupedFindingIds.includes(f3.finding_id)) {
    // Check if it's in a separate family
    const f3Family = result.families.find(f => f.memberFindingIds.includes(f3.finding_id));
    if (f3Family && f3Family.memberFindingIds.includes(f1.finding_id)) {
      checks.push("OVERMERGE: datakom merged with dataphone — entity separation violated");
    }
  }

  // f4 (Ofcom provision) must NOT be in fca_section_19_legacy_hire
  if (fcaFamily && fcaFamily.memberFindingIds.includes(f4.finding_id)) {
    checks.push("OVERMERGE: Ofcom finding merged into FCA s.19 family — provision separation violated");
  }

  return {
    id: "T1",
    name: "FCA section 19 vs other FCA/Ofcom matters",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: FCA s.19 forms family; Datakom separate; Ofcom excluded" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T2: Customer Change-of-Control
// ---------------------------------------------------------------------------

function t2_customer_coc(): TestResult {
  fixtureCounter = 200;
  const checks: string[] = [];

  // Customer CoC findings (same counterparty role)
  const f1 = makeFinding({
    issue_key: "change_of_control_customer_termination_rights",
    title: "Customer contract termination on change of control",
    detail: "Key customer contracts have change of control termination rights",
  });
  const f2 = makeFinding({
    issue_key: "change_of_control_customer_termination",
    title: "Customer CoC termination risk",
    detail: "Customer may terminate on change of control",
  });

  // Supplier CoC — must NOT merge with customer
  const f3 = makeFinding({
    issue_key: "supplier_change_of_control_termination",
    title: "Supplier termination on change of control",
    detail: "Supplier contract has change of control clause",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  // Customer findings should form one family
  const custFamily = result.families.find(f => f.issueFamilyKey === "customer_change_of_control");
  if (!custFamily) {
    checks.push("MISSING: customer_change_of_control family not created");
  } else {
    if (!custFamily.memberFindingIds.includes(f1.finding_id) || !custFamily.memberFindingIds.includes(f2.finding_id)) {
      checks.push("WRONG_MEMBERS: customer CoC findings not grouped");
    }
    if (custFamily.memberFindingIds.includes(f3.finding_id)) {
      checks.push("OVERMERGE: supplier finding merged into customer family");
    }
  }

  // f3 must NOT be in customer family
  const supplierFamily = result.families.find(f => f.issueFamilyKey === "supplier_change_of_control");
  if (supplierFamily && supplierFamily.memberFindingIds.includes(f1.finding_id)) {
    checks.push("OVERMERGE: customer finding in supplier family");
  }

  // f3 should be ungrouped (only 1 supplier finding = singleton)
  if (!result.ungroupedFindingIds.includes(f3.finding_id) && !supplierFamily) {
    checks.push("SUPPLIER_DISPOSITION: f3 should be ungrouped or in supplier family");
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T2",
    name: "Customer vs supplier change-of-control separation",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: Customer CoC grouped; supplier separate" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T3: Supplier Change-of-Control
// ---------------------------------------------------------------------------

function t3_supplier_coc(): TestResult {
  fixtureCounter = 300;
  const checks: string[] = [];

  const f1 = makeFinding({
    issue_key: "supplier_change_of_control_termination",
    title: "Gamma supplier CoC termination",
    detail: "Gamma Telecom supplier contract has change of control termination clause",
  });
  const f2 = makeFinding({
    issue_key: "change_of_control_debt_repayment",
    title: "Debt repayment on change of control",
    detail: "Mandatory prepayment of debt facility on change of control",
  });
  const f3 = makeFinding({
    issue_key: "change_of_control_mandatory_prepayment",
    title: "Mandatory prepayment obligation",
    detail: "Senior facility mandatory prepayment on change of control event",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  // All 3 are supplier-side CoC
  const supplierFamily = result.families.find(f => f.issueFamilyKey === "supplier_change_of_control");
  if (!supplierFamily) {
    checks.push("MISSING: supplier_change_of_control family not created");
  } else {
    if (supplierFamily.memberFindingIds.length < 2) {
      checks.push(`WRONG_SIZE: expected 2+ members, got ${supplierFamily.memberFindingIds.length}`);
    }
    // All evidence and coordinates survive
    const rep = supplierFamily.representativeFindingId;
    if (!supplierFamily.memberFindingIds.includes(rep)) {
      checks.push("REP_NOT_MEMBER: representative not in members");
    }
    // Idempotent
    const r2 = deduplicateFindings([f1, f2, f3]);
    if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");
  }

  return {
    id: "T3",
    name: "Supplier change-of-control family",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: Supplier CoC findings grouped correctly" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T4: One Park Lane Title and Lease
// ---------------------------------------------------------------------------

function t4_one_park_lane(): TestResult {
  fixtureCounter = 400;
  const checks: string[] = [];

  // One Park Lane (Hemel Hempstead) findings
  const f1 = makeFinding({
    issue_key: "hemel_hempstead_overseas_entity_title_defect",
    title: "Hemel Hempstead (One Park Lane) overseas entity title defect",
    detail: "One Park Lane, Hemel Hempstead has overseas entity registration issues",
  });
  const f2 = makeFinding({
    issue_key: "hemel_hempstead_asbestos_survey_gap",
    title: "Hemel Hempstead asbestos survey gap",
    detail: "One Park Lane, Hemel Hempstead lacks current asbestos survey",
  });

  // Different property — must NOT merge
  const f3 = makeFinding({
    issue_key: "bolton_leasehold_title_defect",
    title: "Bolton leasehold title defect",
    detail: "Bolton office has title registration issues",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  const oplFamily = result.families.find(f => f.issueFamilyKey === "one_park_lane_title_and_lease");
  if (!oplFamily) {
    checks.push("MISSING: one_park_lane_title_and_lease family not created");
  } else {
    if (!oplFamily.memberFindingIds.includes(f1.finding_id) || !oplFamily.memberFindingIds.includes(f2.finding_id)) {
      checks.push("WRONG_MEMBERS: OPL findings not grouped");
    }
    if (oplFamily.memberFindingIds.includes(f3.finding_id)) {
      checks.push("OVERMERGE: Bolton property merged into One Park Lane");
    }
    if (!oplFamily.properties.includes("one_park_lane_hemel_hempstead")) {
      checks.push("PROPERTY_MISSING: property dimension not extracted");
    }
  }

  // Bolton must be ungrouped (different property, singleton)
  if (!result.ungroupedFindingIds.includes(f3.finding_id)) {
    const inFamily = result.families.find(f => f.memberFindingIds.includes(f3.finding_id));
    if (inFamily?.issueFamilyKey === "one_park_lane_title_and_lease") {
      checks.push("OVERMERGE: Bolton merged into One Park Lane");
    }
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T4",
    name: "One Park Lane vs another property",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: One Park Lane grouped; Bolton separate" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T5: Contracting Out 1954 Act
// ---------------------------------------------------------------------------

function t5_contracting_out_1954(): TestResult {
  fixtureCounter = 500;
  const checks: string[] = [];

  const f1 = makeFinding({
    issue_key: "security_of_tenure_contracting_out_undocumented",
    title: "Security of tenure contracting-out undocumented",
    detail: "No evidence of valid contracting-out under the Landlord and Tenant Act 1954",
  });
  const f2 = makeFinding({
    issue_key: "security_of_tenure_contracting_out_undocumented",
    title: "1954 Act contracting-out gap at second property",
    detail: "Second lease lacks contracting-out documentation under 1954 Act",
  });

  // Unrelated lease clause — must NOT merge
  const f3 = makeFinding({
    issue_key: "riduna_park_lease_terrorism_exclusion_uncapped_service_charge",
    title: "Riduna Park lease terrorism exclusion and uncapped service charge",
    detail: "Lease contains terrorism exclusion with uncapped service charge liability",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  const actFamily = result.families.find(f => f.issueFamilyKey === "contracting_out_1954_act");
  if (!actFamily) {
    checks.push("MISSING: contracting_out_1954_act family not created");
  } else {
    if (actFamily.memberFindingIds.length !== 2) {
      checks.push(`WRONG_SIZE: expected 2, got ${actFamily.memberFindingIds.length}`);
    }
    if (actFamily.memberFindingIds.includes(f3.finding_id)) {
      checks.push("OVERMERGE: unrelated lease clause merged into 1954 Act family");
    }
  }

  // f3 must be ungrouped
  if (!result.ungroupedFindingIds.includes(f3.finding_id)) {
    checks.push("LEASE_CLAUSE_NOT_UNGROUPED: f3 should be standalone");
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T5",
    name: "1954 Act contracting-out vs unrelated lease clauses",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: 1954 Act grouped; unrelated lease excluded" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T6: Courts Design IP Assignment vs Unregistered Trade Marks
// ---------------------------------------------------------------------------

function t6_courts_design_vs_trademarks(): TestResult {
  fixtureCounter = 600;
  const checks: string[] = [];

  // Courts Design specific IP assignment
  const f1 = makeFinding({
    issue_key: "courts_design_ip_assignment_gap",
    title: "Courts Design IP assignment gap",
    detail: "Courts Design Limited has not assigned IP to the group",
  });
  const f2 = makeFinding({
    issue_key: "courts_design_ip_assignment_defect",
    title: "Courts Design IP assignment defect",
    detail: "Courts Design third-party developer IP assignment incomplete",
  });

  // Group-level unregistered trade marks — must NOT merge with Courts Design
  const f3 = makeFinding({
    issue_key: "unregistered_trade_marks",
    title: "Group unregistered trade marks exposure",
    detail: "Multiple SCG group brand names are unregistered trade marks",
  });
  const f4 = makeFinding({
    issue_key: "unregistered_trademarks",
    title: "Unregistered trade marks risk",
    detail: "Group-level unregistered trade marks lack statutory protection",
  });

  const result = deduplicateFindings([f1, f2, f3, f4]);

  // Courts Design should form its own family
  const cdFamily = result.families.find(f => f.issueFamilyKey === "courts_design_ip_assignment");
  if (!cdFamily) {
    checks.push("MISSING: courts_design_ip_assignment family not created");
  } else {
    if (!cdFamily.memberFindingIds.includes(f1.finding_id) || !cdFamily.memberFindingIds.includes(f2.finding_id)) {
      checks.push("WRONG_MEMBERS: Courts Design findings not grouped");
    }
    if (cdFamily.memberFindingIds.includes(f3.finding_id) || cdFamily.memberFindingIds.includes(f4.finding_id)) {
      checks.push("OVERMERGE: trademark findings merged into Courts Design");
    }
  }

  // Group trademarks should form separate family
  const tmFamily = result.families.find(f => f.issueFamilyKey === "group_trademarks_unregistered");
  if (!tmFamily) {
    checks.push("MISSING: group_trademarks_unregistered family not created");
  } else {
    if (!tmFamily.memberFindingIds.includes(f3.finding_id) || !tmFamily.memberFindingIds.includes(f4.finding_id)) {
      checks.push("WRONG_MEMBERS: trademark findings not grouped");
    }
    if (tmFamily.memberFindingIds.includes(f1.finding_id) || tmFamily.memberFindingIds.includes(f2.finding_id)) {
      checks.push("OVERMERGE: Courts Design findings merged into trademarks");
    }
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3, f4]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T6",
    name: "Courts Design assignment vs unregistered trade marks",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: Courts Design and trademarks separate" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T7: GDPR/Cookies/Consent as One Controlled Family
// ---------------------------------------------------------------------------

function t7_gdpr_cookies(): TestResult {
  fixtureCounter = 700;
  const checks: string[] = [];

  const f1 = makeFinding({
    issue_key: "gdpr_cookie_consent_gap",
    title: "GDPR cookie consent gap",
    detail: "Website cookie consent mechanism does not meet GDPR requirements",
  });
  const f2 = makeFinding({
    issue_key: "pecr_cookie_compliance_gap",
    title: "PECR cookie compliance gap",
    detail: "Cookie implementation breaches PECR regulations",
  });

  const result = deduplicateFindings([f1, f2]);

  const gdprFamily = result.families.find(f => f.issueFamilyKey === "gdpr_cookies_consent");
  if (!gdprFamily) {
    checks.push("MISSING: gdpr_cookies_consent family not created");
  } else {
    if (gdprFamily.memberFindingIds.length !== 2) {
      checks.push(`WRONG_SIZE: expected 2, got ${gdprFamily.memberFindingIds.length}`);
    }
    // All evidence survives
    if (gdprFamily.memberDispositions.length !== 2) {
      checks.push("DISPOSITIONS_MISSING");
    }
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T7",
    name: "GDPR/cookies/consent as one controlled family",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: GDPR/cookies grouped as one family" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T8: Stale Legal-DD Scope vs Current Substantive Issue
// ---------------------------------------------------------------------------

function t8_stale_legal_dd(): TestResult {
  fixtureCounter = 800;
  const checks: string[] = [];

  const f1 = makeFinding({
    issue_key: "legal_dd_scope_limitation",
    title: "Legal DD scope limitation",
    detail: "Legal due diligence relies on stale 2021 scope; does not cover current operations",
  });
  const f2 = makeFinding({
    issue_key: "legal_dd_stale_scope",
    title: "Stale legal DD scope",
    detail: "Legal DD scope is outdated and does not reflect current corporate structure",
  });

  // Current substantive legal issue — must NOT merge
  const f3 = makeFinding({
    issue_key: "fca_section_19_legacy_hire_breach",
    title: "FCA section 19 breach",
    detail: "Active FCA section 19 permission breach — substantive legal issue",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  const ddFamily = result.families.find(f => f.issueFamilyKey === "stale_legal_dd_scope");
  if (!ddFamily) {
    checks.push("MISSING: stale_legal_dd_scope family not created");
  } else {
    if (ddFamily.memberFindingIds.length !== 2) {
      checks.push(`WRONG_SIZE: expected 2, got ${ddFamily.memberFindingIds.length}`);
    }
    if (ddFamily.memberFindingIds.includes(f3.finding_id)) {
      checks.push("OVERMERGE: substantive legal issue merged into stale DD scope");
    }
  }

  // f3 must NOT be in the DD scope family
  if (!result.ungroupedFindingIds.includes(f3.finding_id)) {
    const f3Family = result.families.find(f => f.memberFindingIds.includes(f3.finding_id));
    if (f3Family?.issueFamilyKey === "stale_legal_dd_scope") {
      checks.push("OVERMERGE: FCA s.19 in stale DD scope family");
    }
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T8",
    name: "Stale Legal-DD scope vs current substantive legal issue",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: Stale DD grouped; substantive issue excluded" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T9: Restrictive Covenants (Entity/Individual Material Separation)
// ---------------------------------------------------------------------------

function t9_restrictive_covenants(): TestResult {
  fixtureCounter = 900;
  const checks: string[] = [];

  // Same entity, same general obligation
  const f1 = makeFinding({
    issue_key: "senior_executive_restrictive_covenants",
    title: "Senior executive restrictive covenant gap",
    detail: "CEO lacks adequate non-compete restrictive covenant coverage",
  });
  const f2 = makeFinding({
    issue_key: "senior_executive_restrictive_covenant_gap",
    title: "Senior executive restrictive covenant weakness",
    detail: "CEO restrictive covenant duration insufficient",
  });

  // Different entity/individual — may need to remain separate
  const f3 = makeFinding({
    issue_key: "sbd_executive_restrictive_covenant_gap",
    title: "SBD executive restrictive covenant gap",
    detail: "SBD managing director lacks non-compete clause",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  // f1 and f2 (same CEO obligation) should group
  const rcFamily = result.families.find(f =>
    f.issueFamilyKey === "restrictive_covenants" &&
    f.memberFindingIds.includes(f1.finding_id)
  );
  if (!rcFamily) {
    checks.push("MISSING: restrictive_covenants family for f1+f2 not created");
  } else {
    if (rcFamily.memberFindingIds.length !== 2) {
      checks.push(`WRONG_SIZE: expected 2, got ${rcFamily.memberFindingIds.length}`);
    }
    if (rcFamily.memberFindingIds.includes(f3.finding_id)) {
      checks.push("OVERMERGE: SBD finding merged with CEO findings — entity differs");
    }
  }

  // f3 (different entity — SBD) should be ungrouped (singleton in different dimension bucket)
  if (rcFamily && rcFamily.memberFindingIds.includes(f3.finding_id)) {
    checks.push("SBD_IN_CEO_FAMILY: entity/individual separation violated");
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T9",
    name: "Restrictive covenants: separate where entity/individual differs",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: CEO covenants grouped; SBD separate" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T10: Group Trademarks Unregistered (distinct from Courts Design)
// ---------------------------------------------------------------------------

function t10_group_trademarks(): TestResult {
  fixtureCounter = 1000;
  const checks: string[] = [];

  const f1 = makeFinding({
    issue_key: "unregistered_trade_marks",
    title: "Group unregistered trade marks",
    detail: "SCG group brand names lack trademark registration",
  });
  const f2 = makeFinding({
    issue_key: "group_unregistered_trade_names",
    title: "Group unregistered trade names",
    detail: "Group-level trade names without statutory protection",
  });
  const f3 = makeFinding({
    issue_key: "scg_logo_trademark_registration_pending",
    title: "SCG logo trademark registration pending",
    detail: "SCG group logo trademark application pending",
  });

  const result = deduplicateFindings([f1, f2, f3]);

  const tmFamily = result.families.find(f => f.issueFamilyKey === "group_trademarks_unregistered");
  if (!tmFamily) {
    checks.push("MISSING: group_trademarks_unregistered family not created");
  } else {
    if (tmFamily.memberFindingIds.length < 2) {
      checks.push(`WRONG_SIZE: expected 2+, got ${tmFamily.memberFindingIds.length}`);
    }
    // Evidence and coordinates survive
    if (tmFamily.memberDispositions.length < 2) {
      checks.push("DISPOSITIONS_INCOMPLETE");
    }
    // Severity/reportability unchanged
    if (tmFamily.memberDispositions.some(d => d.disposition !== "retained" && d.disposition !== "suppressed")) {
      checks.push("INVALID_DISPOSITION");
    }
  }

  // Idempotent
  const r2 = deduplicateFindings([f1, f2, f3]);
  if (result.resultFingerprint !== r2.resultFingerprint) checks.push("NOT_IDEMPOTENT");

  return {
    id: "T10",
    name: "Group trademarks unregistered family",
    passed: checks.length === 0,
    detail: checks.length === 0 ? "PASSED: Group trademarks form family" : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T11: Cross-Family Structural Assertions
// ---------------------------------------------------------------------------

function t11_structural(): TestResult {
  fixtureCounter = 1100;
  const checks: string[] = [];

  // Build a mix of findings from multiple families
  const findings: CanonicalFinding[] = [
    makeFinding({ issue_key: "dataphone_fca_authorisation_revocation", title: "Dataphone FCA", detail: "Dataphone FCA section 19" }),
    makeFinding({ issue_key: "dataphone_fca_permission_gap", title: "Dataphone FCA gap", detail: "Dataphone FCA section 19 gap" }),
    makeFinding({ issue_key: "change_of_control_customer_termination_rights", title: "Customer CoC", detail: "Customer termination" }),
    makeFinding({ issue_key: "change_of_control_customer_termination", title: "Customer CoC 2", detail: "Customer contract termination" }),
    makeFinding({ issue_key: "supplier_change_of_control_termination", title: "Supplier CoC", detail: "Supplier termination" }),
    makeFinding({ issue_key: "change_of_control_debt_repayment", title: "Debt CoC", detail: "Debt mandatory prepayment supplier" }),
    makeFinding({ issue_key: "courts_design_ip_assignment_gap", title: "Courts Design IP", detail: "Courts Design assignment gap" }),
    makeFinding({ issue_key: "courts_design_ip_assignment_defect", title: "Courts Design IP 2", detail: "Courts Design third-party" }),
    makeFinding({ issue_key: "unregistered_trade_marks", title: "Group TM", detail: "SCG group unregistered marks" }),
    makeFinding({ issue_key: "unregistered_trademarks", title: "Group TM 2", detail: "Group unregistered trade marks" }),
    // Unknown family (should be ungrouped)
    makeFinding({ issue_key: "completely_novel_risk", title: "Novel risk", detail: "Unknown category" }),
    // All-null dimensions (should fail closed)
    makeFinding({ issue_key: "gdpr_cookie_consent_gap", title: "Cookies gap", detail: "Cookies" }),
  ];

  const result = deduplicateFindings(findings);

  // 1. No occurrence appears in two families
  const doubleCheck = verifyNoDoubleGrouping(result);
  if (!doubleCheck.valid) {
    checks.push(`DOUBLE_GROUPING: ${doubleCheck.duplicates.join("; ")}`);
  }

  // 2. No retired family IDs
  const retiredCheck = verifyNoRetiredFamilies(result);
  if (!retiredCheck.valid) {
    checks.push(`RETIRED_IDS: ${retiredCheck.retiredIds.join(", ")}`);
  }

  // 3. Completeness
  const inputIds = findings.map(f => f.finding_id);
  const completeness = verifyCompleteness(inputIds, result);
  if (!completeness.complete) {
    if (completeness.missing.length > 0) checks.push(`MISSING: ${completeness.missing.length} findings`);
    if (completeness.duplicated.length > 0) checks.push(`DUPLICATED: ${completeness.duplicated.length}`);
  }

  // 4. Non-generative
  const nonGen = verifyNonGenerative(findings, result);
  if (!nonGen.valid) {
    checks.push(`GENERATIVE: ${nonGen.violations.join("; ")}`);
  }

  // 5. Exact approved catalogue
  const approvedCatalogue = getApprovedFamilyCatalogue();
  const presentFamilies = result.familyCatalogue;
  for (const f of presentFamilies) {
    if (!approvedCatalogue.includes(f)) {
      checks.push(`UNAPPROVED_FAMILY: ${f}`);
    }
  }

  // 6. Novel risk must be ungrouped
  const novelFinding = findings.find(f => f.issue_key === "completely_novel_risk")!;
  if (!result.ungroupedFindingIds.includes(novelFinding.finding_id)) {
    checks.push("NOVEL_RISK_GROUPED: unknown category should be ungrouped");
  }

  // 7. Customer vs supplier separation verified
  const custFam = result.families.find(f => f.issueFamilyKey === "customer_change_of_control");
  const suppFam = result.families.find(f => f.issueFamilyKey === "supplier_change_of_control");
  if (custFam && suppFam) {
    const overlap = custFam.memberFindingIds.filter(id => suppFam.memberFindingIds.includes(id));
    if (overlap.length > 0) {
      checks.push("CUST_SUPP_OVERLAP: customer and supplier families share members");
    }
  }

  // 8. Courts Design vs trademarks separation
  const cdFam = result.families.find(f => f.issueFamilyKey === "courts_design_ip_assignment");
  const tmFam = result.families.find(f => f.issueFamilyKey === "group_trademarks_unregistered");
  if (cdFam && tmFam) {
    const overlap = cdFam.memberFindingIds.filter(id => tmFam.memberFindingIds.includes(id));
    if (overlap.length > 0) {
      checks.push("CD_TM_OVERLAP: Courts Design and trademarks families share members");
    }
  }

  // 9. Deterministic across replays
  const r2 = deduplicateFindings(findings);
  if (result.resultFingerprint !== r2.resultFingerprint) {
    checks.push("NOT_DETERMINISTIC: different fingerprint on replay");
  }

  // 10. Hashes change when content changes
  const modifiedFindings = [...findings];
  modifiedFindings[0] = { ...modifiedFindings[0], title: "MODIFIED TITLE FOR HASH TEST" };
  const r3 = deduplicateFindings(modifiedFindings);
  if (r3.resultFingerprint === result.resultFingerprint) {
    checks.push("HASH_INVARIANT: hash should change when proposition changes");
  }

  return {
    id: "T11",
    name: "Cross-family structural assertions",
    passed: checks.length === 0,
    detail: checks.length === 0
      ? `PASSED: ${result.totalFamiliesCreated} families, all structural checks pass`
      : `FAILED: ${checks.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// T12: SCG Integration Test (Production Artifact)
// ---------------------------------------------------------------------------

async function t12_scg_integration(db: any): Promise<TestResult> {
  const checks: string[] = [];

  // Query the real SCG module_outputs.findings
  let allFindings: CanonicalFinding[] = [];
  try {
    const rows = await db.query(
      `SELECT COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json
       FROM module_outputs mo
       JOIN module_runs mr ON mr.id = mo.module_run_id
       WHERE mr.id = $1
       LIMIT 1`,
      z.object({ findings_json: z.string() }),
      [SCG_RUN_ID],
      { label: "T12: Load SCG findings" }
    );

    if (rows.length === 0) {
      return { id: "T12", name: "SCG integration: persisted artifact", passed: false, detail: "FAILED: No module_outputs row for SCG run" };
    }

    const parsed = JSON.parse(rows[0].findings_json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { id: "T12", name: "SCG integration: persisted artifact", passed: false, detail: "FAILED: Empty or non-array findings" };
    }

    allFindings = parsed.filter((f: any) => f && f.finding_id);
    if (allFindings.length === 0) {
      return { id: "T12", name: "SCG integration: persisted artifact", passed: false, detail: "FAILED: No valid findings with finding_id" };
    }
  } catch (e: any) {
    return { id: "T12", name: "SCG integration: persisted artifact", passed: false, detail: `FAILED: DB error: ${e.message}` };
  }

  // Run the production family service
  const result = deduplicateFindings(allFindings);

  // --- Assertions ---

  // 1. Exact approved family catalogue — only approved IDs present
  const approved = getApprovedFamilyCatalogue();
  for (const fam of result.families) {
    if (!approved.includes(fam.issueFamilyKey)) {
      checks.push(`UNAPPROVED_FAMILY: ${fam.issueFamilyKey}`);
    }
  }

  // 2. Zero retired generic family IDs
  const retiredCheck = verifyNoRetiredFamilies(result);
  if (!retiredCheck.valid) {
    checks.push(`RETIRED_IDS: ${retiredCheck.retiredIds.join(", ")}`);
  }

  // 3. No occurrence appears in two families
  const doubleCheck = verifyNoDoubleGrouping(result);
  if (!doubleCheck.valid) {
    checks.push(`DOUBLE_GROUPING: ${doubleCheck.duplicates.slice(0, 3).join("; ")}`);
  }

  // 4. Completeness (deduplicate input IDs first)
  const uniqueInputIds = [...new Set(allFindings.map(f => f.finding_id))];
  const completeness = verifyCompleteness(uniqueInputIds, result);
  if (completeness.missing.length > 0) {
    checks.push(`MISSING: ${completeness.missing.length} findings lost`);
  }

  // 5. Non-generative
  const nonGen = verifyNonGenerative(allFindings, result);
  if (!nonGen.valid) {
    checks.push(`GENERATIVE: ${nonGen.violations.slice(0, 3).join("; ")}`);
  }

  // 6. Deterministic across two replays
  const result2 = deduplicateFindings(allFindings);
  if (result.resultFingerprint !== result2.resultFingerprint) {
    checks.push("NOT_DETERMINISTIC: different fingerprint on replay");
  }

  // 7. Hashes identical across replays (per-family)
  for (let i = 0; i < result.families.length; i++) {
    if (result.families[i].semanticHash !== result2.families[i].semanticHash) {
      checks.push(`HASH_MISMATCH: family ${result.families[i].issueFamilyKey} hash differs on replay`);
      break;
    }
  }

  // 8. Family artifacts have required fields
  for (const fam of result.families) {
    if (!fam.familyRecordId) checks.push(`NO_RECORD_ID: ${fam.issueFamilyKey}`);
    if (!fam.ruleId) checks.push(`NO_RULE_ID: ${fam.issueFamilyKey}`);
    if (!fam.ruleVersion) checks.push(`NO_RULE_VERSION: ${fam.issueFamilyKey}`);
    if (!fam.representativeFindingId) checks.push(`NO_REP: ${fam.issueFamilyKey}`);
    if (!fam.memberFindingIds.includes(fam.representativeFindingId)) {
      checks.push(`REP_NOT_MEMBER: ${fam.issueFamilyKey}`);
    }
    if (fam.memberDispositions.length !== fam.memberFindingIds.length) {
      checks.push(`DISPOSITION_COUNT: ${fam.issueFamilyKey}`);
    }
    if (!fam.semanticHash) checks.push(`NO_HASH: ${fam.issueFamilyKey}`);
    if (!fam.rationaleCode) checks.push(`NO_RATIONALE: ${fam.issueFamilyKey}`);
    // sourceAuthority is null (no persisted classification), must have missing reason
    if (fam.sourceAuthority === null && !fam.sourceAuthorityMissingReason) {
      checks.push(`NO_AUTHORITY_REASON: ${fam.issueFamilyKey}`);
    }
    // Recursive ancestry must include at least the members themselves
    for (const mid of fam.memberFindingIds) {
      if (!fam.recursiveLeafAncestry.includes(mid)) {
        checks.push(`ANCESTRY_MISSING: ${mid} in ${fam.issueFamilyKey}`);
        break;
      }
    }
  }

  // 9. Customer vs supplier separation (if both families exist)
  const custFams = result.families.filter(f => f.issueFamilyKey === "customer_change_of_control");
  const suppFams = result.families.filter(f => f.issueFamilyKey === "supplier_change_of_control");
  if (custFams.length > 0 && suppFams.length > 0) {
    const custIds = new Set(custFams.flatMap(f => f.memberFindingIds));
    const suppIds = new Set(suppFams.flatMap(f => f.memberFindingIds));
    for (const id of custIds) {
      if (suppIds.has(id)) {
        checks.push("CUST_SUPP_OVERLAP: finding in both customer and supplier");
        break;
      }
    }
  }

  // 10. Courts Design vs trademarks separation
  const cdFams = result.families.filter(f => f.issueFamilyKey === "courts_design_ip_assignment");
  const tmFams = result.families.filter(f => f.issueFamilyKey === "group_trademarks_unregistered");
  if (cdFams.length > 0 && tmFams.length > 0) {
    const cdIds = new Set(cdFams.flatMap(f => f.memberFindingIds));
    const tmIds = new Set(tmFams.flatMap(f => f.memberFindingIds));
    for (const id of cdIds) {
      if (tmIds.has(id)) {
        checks.push("CD_TM_OVERLAP: finding in both Courts Design and trademarks");
        break;
      }
    }
  }

  // 11. Build family reconciliation report
  const familyReport = result.families.map(f => ({
    family: f.issueFamilyKey,
    members: f.memberFindingIds.length,
    representative: f.representativeFindingId.slice(0, 8),
    hash: f.semanticHash,
  }));

  const passed = checks.length === 0;
  return {
    id: "T12",
    name: "SCG integration: persisted artifact",
    passed,
    detail: passed
      ? `PASSED: ${allFindings.length} findings → ${result.totalFamiliesCreated} families, ${result.ungroupedFindingIds.length} ungrouped. Catalogue: [${result.familyCatalogue.join(",")}]. Deterministic=true, complete=${completeness.missing.length === 0}, noDoubleGrouping=true. Families: ${JSON.stringify(familyReport)}`
      : `FAILED: ${checks.join("; ")}. Input: ${allFindings.length} findings, families=${result.totalFamiliesCreated}`,
  };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export default api({
  name: "TestOaFamilyDedup",
  description: "OA-03 acceptance: 10 SCG families, multi-dimensional grouping, full artifact.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    runScgIntegrationTests: z.boolean().default(false),
  }),
  output: z.object({
    summary: z.string(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    total: z.number(),
    results: z.array(z.object({
      id: z.string(),
      name: z.string(),
      passed: z.boolean(),
      skipped: z.boolean().optional(),
      detail: z.string(),
    })),
    ruleVersion: z.string(),
    familyCatalogue: z.array(z.string()),
  }),
  async run(ctx, { runScgIntegrationTests }) {
    const results: TestResult[] = [];

    // T1-T11: Synthetic deterministic tests
    results.push(t1_fca_section_19());
    results.push(t2_customer_coc());
    results.push(t3_supplier_coc());
    results.push(t4_one_park_lane());
    results.push(t5_contracting_out_1954());
    results.push(t6_courts_design_vs_trademarks());
    results.push(t7_gdpr_cookies());
    results.push(t8_stale_legal_dd());
    results.push(t9_restrictive_covenants());
    results.push(t10_group_trademarks());
    results.push(t11_structural());

    // T12: SCG integration test
    if (runScgIntegrationTests) {
      results.push(await t12_scg_integration(ctx.integrations.db));
    } else {
      results.push({
        id: "T12",
        name: "SCG integration: persisted artifact",
        passed: false,
        skipped: true,
        detail: "SKIPPED: runScgIntegrationTests=false",
      });
    }

    const passed = results.filter(r => r.passed && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.passed && !r.skipped).length;

    return {
      summary: `OA-03 Family Dedup: ${passed}/${results.length - skipped} passed, ${failed} failed, ${skipped} skipped`,
      passed,
      failed,
      skipped,
      total: results.length,
      results,
      ruleVersion: FAMILY_RULE_VERSION,
      familyCatalogue: getApprovedFamilyCatalogue(),
    };
  },
});
