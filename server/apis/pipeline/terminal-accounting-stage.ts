/**
 * MAT-F07 Stage 4: Terminal Accounting
 *
 * Produces one terminal record for EVERY Q2 candidate.
 * No silent losses. No candidate may disappear.
 *
 * 12+ statuses from Terminal Status Taxonomy (MAT-F07 §E):
 *   reportable_finding, confirmed_non_adverse, supporting_only,
 *   duplicate_suppressed, missing_ic_claim, invalid_evidence_authority,
 *   incompatible_claim_evidence, unverifiable, q3_ineligible,
 *   q4_grouped_non_representative, degraded, processing_error
 *
 * CONSTRAINTS:
 *   - No API registration (no `api()` call)
 *   - No UI/client imports
 *   - No pipeline-core.ts import
 *   - No module-initialization side effects
 *   - Every Q2 candidate receives exactly one terminal row
 *   - All cross-stage references resolve to real rows
 *   - Returns invariant violations for monitoring
 */

import type { Q2CandidateInput, Q3ResultRow } from "./q3-production-stage.js";
import type { Q4Family, Q4StageOutput } from "./q4-production-stage.js";
import type { Q5Finding } from "./q5-production-stage.js";
import type { CanonicalDisposition } from "./canonical-finding-record.js";

// ===========================================================================
// Terminal Status Taxonomy (MAT-F07 §E)
// ===========================================================================

export const TERMINAL_STATUSES = [
  "reportable_finding",
  "confirmed_non_adverse",
  "supporting_only",
  "duplicate_suppressed",
  "missing_ic_claim",
  "invalid_evidence_authority",
  "incompatible_claim_evidence",
  "unverifiable",
  "q3_ineligible",
  "q4_grouped_non_representative",
  "degraded",
  "processing_error",
] as const;

export type TerminalStatus = typeof TERMINAL_STATUSES[number];

// ===========================================================================
// Types
// ===========================================================================

export interface TerminalRecord {
  candidate_id: string;
  terminal_status: TerminalStatus;
  terminal_stage: "q3" | "q4" | "q5";
  canonical_finding_id: string | null;
  family_id: string | null;
  reason_codes: string[];
  reportable: boolean;
  terminal_rule_version: string;
}

export interface TerminalAccountingInput {
  candidates: Q2CandidateInput[];
  q3Results: Q3ResultRow[];
  q4Output: Q4StageOutput;
  q5Findings: Q5Finding[];
}

export interface TerminalAccountingOutput {
  records: TerminalRecord[];
  invariant_violations: string[];
}

// ===========================================================================
// Production execution
// ===========================================================================

/**
 * Produce one terminal record for EVERY Q2 candidate.
 * No silent losses. No candidate may disappear.
 */
export function executeTerminalAccounting(input: TerminalAccountingInput): TerminalAccountingOutput {
  const records: TerminalRecord[] = [];
  const processedCandidateIds = new Set<string>();

  // Build lookup maps
  const q3ByCandidate = new Map<string, Q3ResultRow>();
  for (const r of input.q3Results) {
    q3ByCandidate.set(r.candidate_id, r);
  }

  const candidateFamilyMap = new Map<string, string>();
  const candidateFindingMap = new Map<string, string>();

  for (const family of input.q4Output.families) {
    for (const mid of family.member_candidate_ids) {
      candidateFamilyMap.set(mid, family.family_id);
    }
  }

  for (const finding of input.q5Findings) {
    for (const mid of finding.member_ids) {
      candidateFindingMap.set(mid, finding.canonical_finding_id);
    }
  }

  // Process every Q2 candidate
  for (const candidate of input.candidates) {
    const cid = candidate.candidate_id;
    if (processedCandidateIds.has(cid)) continue;
    processedCandidateIds.add(cid);

    const q3 = q3ByCandidate.get(cid);
    const familyId = candidateFamilyMap.get(cid) ?? null;
    const findingId = candidateFindingMap.get(cid) ?? null;

    // Determine terminal status
    const terminalRecord = deriveTerminalRecord(candidate, q3, familyId, findingId, input);
    records.push(terminalRecord);
  }

  // Validate invariants
  const invariant_violations: string[] = [];
  const uniqueCandidateIds = new Set(input.candidates.map(c => c.candidate_id));
  const uniqueTerminalIds = new Set(records.map(r => r.candidate_id));

  // Check: count(unique Q2 candidate IDs) = count(unique terminal candidate IDs)
  if (uniqueCandidateIds.size !== uniqueTerminalIds.size) {
    invariant_violations.push(
      `Q2 candidates (${uniqueCandidateIds.size}) != terminal records (${uniqueTerminalIds.size})`
    );
  }

  // Check: each Q2 candidate has exactly one terminal row
  for (const cid of uniqueCandidateIds) {
    const count = records.filter(r => r.candidate_id === cid).length;
    if (count === 0) {
      invariant_violations.push(`Q2 candidate '${cid}' has NO terminal record`);
    } else if (count > 1) {
      invariant_violations.push(`Q2 candidate '${cid}' has ${count} terminal records (expected 1)`);
    }
  }

  // Check: no terminal IDs that don't correspond to a Q2 candidate
  for (const tid of uniqueTerminalIds) {
    if (!uniqueCandidateIds.has(tid)) {
      invariant_violations.push(`Terminal record '${tid}' has no corresponding Q2 candidate`);
    }
  }

  return { records, invariant_violations };
}

// ===========================================================================
// Cross-Stage Reconciliation (MAT-F07 §F)
// ===========================================================================

export interface ReconciliationResult {
  q2_unique_ids: number;
  q2_duplicate_count: number;
  q3_row_count: number;
  q3_unresolved_references: number;
  q4_family_count: number;
  q4_member_count: number;
  q4_invalid_members: number;
  q5_finding_count: number;
  q5_family_count: number;
  q5_invalid_references: number;
  terminal_row_count: number;
  terminal_duplicate_ids: number;
  terminal_missing_candidates: number;
  reportable_terminal_count: number;
  reportable_finding_ids: string[];
  all_valid: boolean;
  violations: string[];
}

export function reconcileAllStages(
  candidates: Q2CandidateInput[],
  q3Results: Q3ResultRow[],
  q4Output: Q4StageOutput,
  q5Findings: Q5Finding[],
  terminalRecords: TerminalRecord[],
): ReconciliationResult {
  const violations: string[] = [];

  // Q2 stats
  const q2Ids = candidates.map(c => c.candidate_id);
  const q2UniqueIds = new Set(q2Ids);
  const q2DuplicateCount = q2Ids.length - q2UniqueIds.size;

  // Q3 reference validation
  let q3UnresolvedRefs = 0;
  for (const r of q3Results) {
    if (!q2UniqueIds.has(r.candidate_id)) {
      q3UnresolvedRefs++;
      violations.push(`Q3 result references non-existent Q2 candidate: ${r.candidate_id}`);
    }
  }

  // Q4 member validation — all members must be Q3-eligible
  const q3EligibleIds = new Set(q3Results.filter(r => r.q4_eligible).map(r => r.candidate_id));
  let q4InvalidMembers = 0;
  let q4TotalMembers = 0;
  for (const fam of q4Output.families) {
    for (const mid of fam.member_candidate_ids) {
      q4TotalMembers++;
      if (!q3EligibleIds.has(mid)) {
        q4InvalidMembers++;
        violations.push(`Q4 family '${fam.family_id}' contains Q3-ineligible member: ${mid}`);
      }
    }
  }

  // Q5 family reference validation
  const q4FamilyIds = new Set(q4Output.families.map(f => f.family_id));
  let q5InvalidRefs = 0;
  for (const finding of q5Findings) {
    if (!q4FamilyIds.has(finding.source_q4_family_id)) {
      q5InvalidRefs++;
      violations.push(`Q5 finding '${finding.canonical_finding_id}' references non-existent Q4 family: ${finding.source_q4_family_id}`);
    }
  }

  // Terminal validation
  const terminalCandidateIds = terminalRecords.map(r => r.candidate_id);
  const terminalUniqueIds = new Set(terminalCandidateIds);
  const terminalDuplicateIds = terminalCandidateIds.length - terminalUniqueIds.size;
  let terminalMissing = 0;
  for (const cid of q2UniqueIds) {
    if (!terminalUniqueIds.has(cid)) {
      terminalMissing++;
      violations.push(`Q2 candidate '${cid}' missing from terminal ledger`);
    }
  }

  // Reportable terminal → finding resolution
  const reportableTerminal = terminalRecords.filter(r => r.reportable);
  const reportableFindingIds = [...new Set(reportableTerminal
    .map(r => r.canonical_finding_id)
    .filter((id): id is string => id != null))];

  // All reportable terminal rows must resolve to a real Q5 finding
  const q5FindingIds = new Set(q5Findings.map(f => f.canonical_finding_id));
  for (const r of reportableTerminal) {
    if (r.canonical_finding_id && !q5FindingIds.has(r.canonical_finding_id)) {
      violations.push(`Reportable terminal '${r.candidate_id}' references non-existent Q5 finding: ${r.canonical_finding_id}`);
    }
  }

  return {
    q2_unique_ids: q2UniqueIds.size,
    q2_duplicate_count: q2DuplicateCount,
    q3_row_count: q3Results.length,
    q3_unresolved_references: q3UnresolvedRefs,
    q4_family_count: q4Output.families.length,
    q4_member_count: q4TotalMembers,
    q4_invalid_members: q4InvalidMembers,
    q5_finding_count: q5Findings.length,
    q5_family_count: new Set(q5Findings.map(f => f.source_q4_family_id)).size,
    q5_invalid_references: q5InvalidRefs,
    terminal_row_count: terminalRecords.length,
    terminal_duplicate_ids: terminalDuplicateIds,
    terminal_missing_candidates: terminalMissing,
    reportable_terminal_count: reportableTerminal.length,
    reportable_finding_ids: reportableFindingIds,
    all_valid: violations.length === 0,
    violations,
  };
}

// ===========================================================================
// Internal Helpers
// ===========================================================================

/**
 * Derive terminal record for a candidate based on its progression through stages.
 */
function deriveTerminalRecord(
  candidate: Q2CandidateInput,
  q3: Q3ResultRow | undefined,
  familyId: string | null,
  findingId: string | null,
  input: TerminalAccountingInput,
): TerminalRecord {
  const cid = candidate.candidate_id;

  // Case 1: No Q3 result (shouldn't happen but defensive)
  if (!q3) {
    return {
      candidate_id: cid,
      terminal_status: "processing_error",
      terminal_stage: "q3",
      canonical_finding_id: null,
      family_id: null,
      reason_codes: ["no_q3_result"],
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    };
  }

  // Case 2: Q3 ineligible — terminal at Q3
  if (!q3.q4_eligible) {
    const status = mapQ3DispositionToTerminalStatus(q3.disposition);
    return {
      candidate_id: cid,
      terminal_status: status,
      terminal_stage: "q3",
      canonical_finding_id: null,
      family_id: null,
      reason_codes: q3.rejection_reason_codes,
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    };
  }

  // Case 3: Q3 eligible but not in any Q4 family (ambiguous/degraded)
  if (!familyId) {
    return {
      candidate_id: cid,
      terminal_status: "degraded",
      terminal_stage: "q4",
      canonical_finding_id: null,
      family_id: null,
      reason_codes: ["q4_unassigned"],
      reportable: false,
      terminal_rule_version: "f07-terminal-v1",
    };
  }

  // Case 4: In Q4 family but not the representative (duplicate suppressed)
  const family = input.q4Output.families.find(f => f.family_id === familyId);
  if (family) {
    const decision = family.duplicate_decisions.find(d => d.candidate_id === cid);
    if (decision?.decision === "non_representative") {
      return {
        candidate_id: cid,
        terminal_status: "duplicate_suppressed",
        terminal_stage: "q4",
        canonical_finding_id: findingId,
        family_id: familyId,
        reason_codes: ["q4_grouped_non_representative"],
        reportable: false,
        terminal_rule_version: "f07-terminal-v1",
      };
    }
  }

  // Case 5: Has Q5 finding
  if (findingId) {
    const finding = input.q5Findings.find(f => f.canonical_finding_id === findingId);
    if (finding) {
      if (finding.reportable) {
        return {
          candidate_id: cid,
          terminal_status: "reportable_finding",
          terminal_stage: "q5",
          canonical_finding_id: findingId,
          family_id: familyId,
          reason_codes: [],
          reportable: true,
          terminal_rule_version: "f07-terminal-v1",
        };
      }
      // Q5 finding exists but not reportable
      const status = mapQ5DispositionToTerminalStatus(finding.disposition);
      return {
        candidate_id: cid,
        terminal_status: status,
        terminal_stage: "q5",
        canonical_finding_id: findingId,
        family_id: familyId,
        reason_codes: finding.disposition.reason_codes,
        reportable: false,
        terminal_rule_version: "f07-terminal-v1",
      };
    }
  }

  // Case 6: In family, representative, but no Q5 finding produced
  return {
    candidate_id: cid,
    terminal_status: "processing_error",
    terminal_stage: "q5",
    canonical_finding_id: null,
    family_id: familyId,
    reason_codes: ["q5_finding_not_produced"],
    reportable: false,
    terminal_rule_version: "f07-terminal-v1",
  };
}

function mapQ3DispositionToTerminalStatus(disposition: string): TerminalStatus {
  switch (disposition) {
    case "not_linked_to_IC_claim":
      return "missing_ic_claim";
    case "invalid_or_unresolved_claim_reference":
    case "malformed_claim_reference":
    case "ambiguous_reconciliation":
    case "claim_from_non_ic_document":
      return "missing_ic_claim";
    case "invalid_evidence_authority":
      return "invalid_evidence_authority";
    case "incompatible_claim_evidence":
      return "incompatible_claim_evidence";
    case "claim_linked_confirmed":
      return "confirmed_non_adverse";
    case "claim_linked_unverifiable":
      return "unverifiable";
    case "supporting_evidence_only":
      return "supporting_only";
    case "wrong_module":
    case "process_diagnostic":
    case "source_recommendation":
    case "scope_limitation":
      return "q3_ineligible";
    default:
      return "q3_ineligible";
  }
}

function mapQ5DispositionToTerminalStatus(disposition: CanonicalDisposition): TerminalStatus {
  if (disposition.reportable) return "reportable_finding";
  const verdict = disposition.verdict;
  if (verdict === "confirmed") return "confirmed_non_adverse";
  if (verdict === "unverifiable") return "unverifiable";
  return "supporting_only";
}
