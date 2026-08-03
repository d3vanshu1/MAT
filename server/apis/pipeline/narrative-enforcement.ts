/**
 * MAT-F05 Integration: Narrative Enforcement Orchestrator
 *
 * This module provides the production-path function that applies the FULL F05
 * enforcement sequence to an array of LLM-generated findings:
 *
 *   LLM output
 *   → process-object exclusion
 *   → canonical-record lookup (by claim_id linkage)
 *   → processNarration validation/fallback
 *   → authority gate for structured fields
 *   → persistence/report formatting
 *
 * Where NO canonical F04 record exists for a finding:
 *   - the finding is marked non-reportable (severity=info, category=housekeeping)
 *   - its narrative text is replaced with a diagnostic label
 *   - it is NOT published as a substantive reportable finding
 *
 * Where multiple or ambiguous canonical records resolve:
 *   - fail closed: finding excluded
 *
 * All three production paths (merge-findings, complete-merge-tree, finalize-pipeline-output)
 * call `enforceNarrativeBoundary()` as their sole F05 integration point.
 */

import type { CanonicalFinding } from "./canonical-finding.js";
import type { CanonicalFindingRecord } from "./canonical-finding-record.js";
import {
  processNarration,
  shouldExcludeAsProcessObject,
  buildLockedNarrationInput,
  type NarrativeOutput,
  type NarrationResult,
} from "./narrative-boundary.js";
import {
  applyBatchAuthorityGate,
  type BatchGateResult,
} from "./narrative-authority-gate.js";

// ===========================================================================
// Types
// ===========================================================================

export interface NarrativeValidationDiagnostic {
  finding_id: string;
  status: "accepted" | "rejected" | "no_canonical_record" | "excluded_process";
  reason_codes: string[];
  original_title?: string;
  fallback_title?: string;
}

export interface EnforcementResult {
  /** Findings that survived enforcement — ready for persistence/report */
  findings: CanonicalFinding[];
  /** Full diagnostic log */
  diagnostics: NarrativeValidationDiagnostic[];
  /** Authority gate metadata (structural field modifications) */
  gateResult: BatchGateResult;
  /** Summary counts */
  counts: {
    input: number;
    process_excluded: number;
    no_canonical_rejected: number;
    narrative_rejected: number;
    narrative_accepted: number;
    authority_modified: number;
    output: number;
  };
}

// ===========================================================================
// Canonical Record Lookup
// ===========================================================================

/**
 * Resolve a canonical finding record for a given finding.
 * Uses exact claim_id linkage ONLY — no title similarity or source matching.
 *
 * Returns undefined if:
 *   - no claim_ids on the finding
 *   - no match in the canonical record map
 *   - multiple distinct records match (ambiguous — fail closed)
 */
function resolveCanonicalRecord(
  finding: CanonicalFinding,
  canonicalRecordMap: Map<string, CanonicalFindingRecord> | undefined,
): CanonicalFindingRecord | undefined {
  if (!canonicalRecordMap || canonicalRecordMap.size === 0) return undefined;
  if (!finding.claim_ids || finding.claim_ids.length === 0) return undefined;

  const matchedRecords: CanonicalFindingRecord[] = [];
  const seenIds = new Set<string>();

  for (const claimId of finding.claim_ids) {
    const rec = canonicalRecordMap.get(claimId);
    if (rec && !seenIds.has(rec.identity.finding_id)) {
      seenIds.add(rec.identity.finding_id);
      matchedRecords.push(rec);
    }
  }

  // Exact single match — proceed
  if (matchedRecords.length === 1) return matchedRecords[0];

  // Multiple distinct records → ambiguous, fail closed
  if (matchedRecords.length > 1) return undefined;

  // No match
  return undefined;
}

// ===========================================================================
// Narrative Extraction from Finding
// ===========================================================================

/**
 * Extract the NarrativeOutput fields from a raw LLM finding.
 * These are the ONLY fields the LLM should have authored.
 */
function extractNarrativeFromFinding(finding: CanonicalFinding): NarrativeOutput {
  return {
    title: finding.title || "",
    summary: finding.detail || "",
    explanation: finding.full_analysis || finding.detail || "",
  };
}

/**
 * Apply validated/fallback narrative back onto a finding.
 * Replaces title, detail, full_analysis with the accepted/fallback text.
 */
function applyNarrativeToFinding(
  finding: CanonicalFinding,
  narrative: NarrativeOutput,
): CanonicalFinding {
  return {
    ...finding,
    title: narrative.title,
    detail: narrative.summary,
    full_analysis: narrative.explanation,
  };
}

// ===========================================================================
// Main Enforcement Function
// ===========================================================================

/**
 * Apply the complete F05 narrative enforcement sequence to a batch of findings.
 *
 * Production order:
 *   1. Process-object exclusion
 *   2. Canonical-record lookup (exact claim_id linkage)
 *   3. processNarration validation/fallback (for findings WITH canonical record)
 *   4. Non-canonical findings → non-reportable/excluded
 *   5. Authority gate for structured fields
 *
 * @param findings - Raw LLM-generated findings (parsed from merge output)
 * @param canonicalRecordMap - Map of claim_id → CanonicalFindingRecord from Q3 checkpoint
 * @returns EnforcementResult with final findings and diagnostics
 */
export function enforceNarrativeBoundary(
  findings: CanonicalFinding[],
  canonicalRecordMap: Map<string, CanonicalFindingRecord> | undefined,
): EnforcementResult {
  const diagnostics: NarrativeValidationDiagnostic[] = [];
  const counts = {
    input: findings.length,
    process_excluded: 0,
    no_canonical_rejected: 0,
    narrative_rejected: 0,
    narrative_accepted: 0,
    authority_modified: 0,
    output: 0,
  };

  // ── Step 1: Process-object exclusion ──────────────────────────────────────
  const substantive: CanonicalFinding[] = [];
  for (const f of findings) {
    if (shouldExcludeAsProcessObject(f)) {
      counts.process_excluded++;
      diagnostics.push({
        finding_id: f.finding_id || "(no-id)",
        status: "excluded_process",
        reason_codes: ["PROCESS_OBJECT_EXCLUDED"],
        original_title: f.title,
      });
      continue;
    }
    substantive.push(f);
  }

  // ── Step 2 & 3: Canonical lookup + narrative validation ───────────────────
  const narrativeValidated: CanonicalFinding[] = [];

  for (const f of substantive) {
    const canonicalRecord = resolveCanonicalRecord(f, canonicalRecordMap);

    if (!canonicalRecord) {
      // No canonical record → fail closed: demote to non-reportable
      counts.no_canonical_rejected++;
      diagnostics.push({
        finding_id: f.finding_id || "(no-id)",
        status: "no_canonical_record",
        reason_codes: ["NO_CANONICAL_RECORD_FAIL_CLOSED"],
        original_title: f.title,
      });

      // Retain as diagnostic/non-reportable output with neutered narrative
      const demoted: CanonicalFinding = {
        ...f,
        severity: "info",
        category: "housekeeping" as any,
        title: `[Unlinked] ${f.title}`,
        detail: "This finding could not be linked to a canonical F04 record. It is retained as a non-reportable diagnostic item only.",
        full_analysis: "No canonical finding record resolved for this LLM output. Per MAT-F05, findings without F04 canonical authority are non-reportable.",
      };
      narrativeValidated.push(demoted);
      continue;
    }

    // ── processNarration: validate LLM narrative against canonical record ──
    const llmNarrative = extractNarrativeFromFinding(f);
    const narrationResult: NarrationResult = processNarration(canonicalRecord, llmNarrative);

    if (narrationResult.status === "accepted") {
      counts.narrative_accepted++;
      diagnostics.push({
        finding_id: f.finding_id || "(no-id)",
        status: "accepted",
        reason_codes: [],
        original_title: f.title,
      });
      // Attach validated narrative (may be unchanged)
      narrativeValidated.push(applyNarrativeToFinding(f, narrationResult.narrative));
    } else {
      // Rejected — replace with deterministic fallback
      counts.narrative_rejected++;
      diagnostics.push({
        finding_id: f.finding_id || "(no-id)",
        status: "rejected",
        reason_codes: narrationResult.validation.reason_codes,
        original_title: f.title,
        fallback_title: narrationResult.narrative.title,
      });
      // Apply fallback narrative — rejected text is NEVER retained
      narrativeValidated.push(applyNarrativeToFinding(f, narrationResult.narrative));
    }
  }

  // ── Step 4: Authority gate for structured fields ──────────────────────────
  const gateResult = applyBatchAuthorityGate(narrativeValidated, canonicalRecordMap);
  counts.authority_modified = gateResult.modified.length;
  counts.output = gateResult.accepted.length;

  return {
    findings: gateResult.accepted,
    diagnostics,
    gateResult,
    counts,
  };
}
