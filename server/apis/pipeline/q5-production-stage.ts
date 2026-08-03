/**
 * MAT-F07 Stage 3: Q5 Production Stage
 *
 * Produces canonical findings from Q4 families. Uses F04 canonical finding
 * identity — no reconstructed provenance, no hardcoded verification_status.
 *
 * NO hardcoded:
 *   - verification_status: "verified"
 *   - Provenance reconstruction from prose
 *   - Default reportability
 *
 * CONSTRAINTS:
 *   - No API registration (no `api()` call)
 *   - No UI/client imports
 *   - No pipeline-core.ts import
 *   - No module-initialization side effects
 *   - Uses worst-adverse-wins disposition logic
 *   - Returns plain typed outputs
 */

import { sha256hex } from "./sha256-pure.js";
import type { CanonicalDisposition } from "./canonical-finding-record.js";
import type { Q2CandidateInput, Q3ResultRow } from "./q3-production-stage.js";
import type { Q4Family } from "./q4-production-stage.js";

// ===========================================================================
// Types
// ===========================================================================

export interface Q5Finding {
  canonical_finding_id: string;
  source_q4_family_id: string;
  member_ids: string[];
  f04_semantic_hash: string;
  reportable: boolean;
  disposition: CanonicalDisposition;
  admitted_evidence_ids: string[];
  proposition_key: string;
  canonical_record: null; // Full record built separately when persisted
}

export interface Q5StageInput {
  families: Q4Family[];
  q3Results: Q3ResultRow[];
  candidates: Q2CandidateInput[];
}

export interface Q5StageOutput {
  findings: Q5Finding[];
}

// ===========================================================================
// Verdict Severity for worst-adverse-wins
// ===========================================================================

const VERDICT_SEVERITY: Record<string, number> = {
  confirmed: 0,
  partially_supported: 1,
  unsupported: 2,
  unverifiable: 3,
  materially_changed: 4,
  contradicted: 5,
};

// ===========================================================================
// Production execution
// ===========================================================================

/**
 * Execute Q5 stage. Produces canonical findings from Q4 families.
 * Uses F04 canonical finding identity — no reconstructed provenance.
 * No hardcoded verification_status.
 */
export function executeQ5Stage(input: Q5StageInput): Q5StageOutput {
  const findings: Q5Finding[] = [];

  for (const family of input.families) {
    // Get Q3 results for family members
    const memberQ3Results = family.member_candidate_ids
      .map(cid => input.q3Results.find(r => r.candidate_id === cid))
      .filter((r): r is Q3ResultRow => r != null);

    // Get candidates for family members
    const memberCandidates = family.member_candidate_ids
      .map(cid => input.candidates.find(c => c.candidate_id === cid))
      .filter((c): c is Q2CandidateInput => c != null);

    // Determine disposition from Q3 verdicts — use worst-adverse-wins
    const disposition = deriveQ5Disposition(memberQ3Results);

    // Generate stable finding identity from content (F04 pattern)
    const semanticHashInput = [
      family.canonical_proposition_key,
      ...family.member_candidate_ids.sort(),
      disposition.verdict,
      String(disposition.reportable),
    ].join("|");
    const f04SemanticHash = sha256hex(semanticHashInput).slice(0, 32);
    const canonicalFindingId = `cfr-v1-${f04SemanticHash.slice(0, 16)}`;

    // Collect admitted evidence IDs from all members (no reconstruction from prose)
    const admittedEvidenceIds: string[] = [];
    for (const cand of memberCandidates) {
      if (cand.admitted_evidence_ids) {
        admittedEvidenceIds.push(...cand.admitted_evidence_ids);
      }
    }

    findings.push({
      canonical_finding_id: canonicalFindingId,
      source_q4_family_id: family.family_id,
      member_ids: family.member_candidate_ids,
      f04_semantic_hash: f04SemanticHash,
      reportable: disposition.reportable,
      disposition,
      admitted_evidence_ids: [...new Set(admittedEvidenceIds)],
      proposition_key: family.canonical_proposition_key,
      canonical_record: null,
    });
  }

  return { findings };
}

// ===========================================================================
// Internal Helpers
// ===========================================================================

/**
 * Derive Q5 disposition from Q3 verdicts using worst-adverse-wins.
 * No hardcoded verification_status.
 */
function deriveQ5Disposition(memberQ3Results: Q3ResultRow[]): CanonicalDisposition {
  let worstVerdict = "unverifiable";
  let worstSeverity = -1;

  for (const r of memberQ3Results) {
    const verdict = r.verdict ?? "unverifiable";
    const severity = VERDICT_SEVERITY[verdict] ?? 0;
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worstVerdict = verdict;
    }
  }

  // Reportable if worst verdict is adverse (not confirmed, not unverifiable)
  const reportable = worstSeverity >= 1 && worstVerdict !== "unverifiable";

  return {
    verdict: worstVerdict as CanonicalDisposition["verdict"],
    reportable,
    reason_codes: reportable
      ? [`worst_adverse_verdict:${worstVerdict}`]
      : [`non_adverse_or_unverifiable:${worstVerdict}`],
    rule_version: "f07-q5-disposition-v1",
  };
}
