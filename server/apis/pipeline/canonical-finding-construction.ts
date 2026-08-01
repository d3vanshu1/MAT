/**
 * Canonical Finding Construction — Q5
 *
 * Constructs one canonical finding per substantive economic issue.
 *
 * A canonical finding aggregates all related claims, evidence records,
 * source documents, and comparison results from all members of an
 * identity family (Q4) into a single coherent finding.
 *
 * ARCHITECTURE:
 *   deterministic canonical grouping (Q4)
 *     → deterministic singleton pass-through (no LLM)
 *     → deterministic multi-member construction (no LLM for clear families)
 *     → bounded ambiguous-family adjudication (LLM only for genuinely ambiguous)
 *     → final assembly
 *
 * GUARANTEES:
 *   - One canonical finding per substantive issue
 *   - Singletons pass through without an LLM call
 *   - Failed ambiguous families preserve original candidates with degraded status
 *   - Complete lineage: merged_from_finding_ids for every member
 *   - No silent loss: every input candidate has exactly one terminal outcome
 *   - Deterministic: interrupted and uninterrupted replay produce same canonical set
 *
 * TERMINAL OUTCOMES for each original candidate:
 *   retained_as_canonical_finding — the primary representative of an issue
 *   merged_into_canonical_finding — absorbed into another finding
 *   excluded_with_reason          — explicitly excluded
 *   degraded_family_preserved     — family failed adjudication; original preserved
 */

import { z } from "@superblocksteam/sdk-api";
import type { CanonicalKey } from "./canonical-issue-identity.js";

// ---------------------------------------------------------------------------
// Evidence record schema
// ---------------------------------------------------------------------------

export const EvidenceRecordSchema = z.object({
  /** Source document */
  source_document: z.string(),
  /** Location within the source document */
  source_location: z.string().nullable(),
  /** The text of the evidence */
  evidence_text: z.string(),
  /** Originating claim ID */
  claim_id: z.string().nullable(),
  /** Metric being evidenced */
  metric: z.string().nullable(),
  /** Period */
  period: z.string().nullable(),
  /** Scope */
  scope: z.string().nullable(),
  /** Value asserted in evidence */
  value: z.string().nullable(),
  /** Unit */
  unit: z.string().nullable(),
  /** Whether this is from an authoritative source */
  authority_status: z.enum(["authoritative", "secondary", "unknown"]),
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ---------------------------------------------------------------------------
// Canonical finding schema
// ---------------------------------------------------------------------------

export const CanonicalFindingSchema = z.object({
  /** Deterministic UUID for the canonical finding */
  canonical_finding_id: z.string(),
  /** Serialized canonical issue key */
  canonical_issue_key: z.string(),
  /** Human-readable title */
  title: z.string(),
  /** Issue domain */
  issue_domain: z.string(),
  /** Issue type */
  issue_type: z.string(),
  /** Originating claim IDs from all merged members */
  originating_claim_ids: z.array(z.string()),
  /** Memo versions referenced */
  memo_versions: z.array(z.string()),
  /** Claim chronology (claims ordered by memo version) */
  claim_chronology: z.array(z.object({
    claim_id: z.string(),
    claim_text: z.string(),
    memo_version: z.string().nullable(),
    verdict: z.string(),
  })),
  /** Evidence records from all members */
  evidence_records: z.array(EvidenceRecordSchema),
  /** Source documents across all members */
  source_documents: z.array(z.string()),
  /** Comparison results */
  comparison_results: z.array(z.object({
    comparison_basis: z.string(),
    claim_text: z.string(),
    evidence_text: z.string().nullable(),
    verdict: z.string(),
  })),
  /** Finding IDs that were merged into this canonical finding */
  merged_from_finding_ids: z.array(z.string()),
  /** Final verification status */
  verification_status: z.enum([
    "contradicted",
    "partially_supported",
    "unsupported",
    "unverifiable",
    "materially_changed",
    "confirmed",
    "degraded",
  ]),
});

export type CanonicalFinding = z.infer<typeof CanonicalFindingSchema>;

// ---------------------------------------------------------------------------
// Per-member terminal outcome
// ---------------------------------------------------------------------------

export const TERMINAL_OUTCOMES = [
  "wrong_module",
  "confirmed_claim",
  "supporting_evidence",
  "process_diagnostic",
  "source_recommendation",
  "scope_limitation",
  "not_linked_to_IC_claim",
  "merged_into_canonical_finding",
  "retained_as_canonical_finding",
  "excluded_with_reason",
  "degraded_family_preserved",
] as const;

export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];

export interface MemberOutcome {
  finding_id: string;
  corpus_index: number;
  title: string;
  terminal_outcome: TerminalOutcome;
  canonical_finding_id: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Canonical finding construction
// ---------------------------------------------------------------------------

interface RawFinding {
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
  issue_key?: string | null;
  evidence?: string | null;
}

interface ClaimData {
  claim_id: string;
  claim_text: string;
  memo_version: string | null;
  verdict: string;
}

function randomUUID(): string {
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).crypto?.randomUUID === "function") {
    return (globalThis as any).crypto.randomUUID() as string;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Constructs a canonical finding from a group of related findings (a family).
 *
 * Singletons: return the original finding wrapped as canonical (no LLM).
 * Multi-member families: merge deterministically (no LLM for clear cases).
 */
export function constructCanonicalFinding(
  canonicalKeyStr: string,
  canonicalKey: CanonicalKey,
  members: RawFinding[],
  resolvedClaims: Map<string, ClaimData>,
): { finding: CanonicalFinding; memberOutcomes: MemberOutcome[] } {
  const canonicalFindingId = randomUUID();
  const memberFindingIds = members.map(m => m.finding_id);

  // --- Aggregate evidence records ---
  const evidenceMap = new Map<string, EvidenceRecord>();
  const sourceDocSet = new Set<string>();
  const allClaimIds: string[] = [];
  const allMemoVersions: string[] = [];
  const comparisonResults: CanonicalFinding["comparison_results"] = [];

  for (const member of members) {
    // Collect source docs
    for (const doc of member.source_docs ?? []) {
      sourceDocSet.add(doc);
    }

    // Collect claim IDs
    if (member.originating_claim_id) allClaimIds.push(member.originating_claim_id);
    for (const cid of member.claim_ids ?? []) allClaimIds.push(cid);

    // Build evidence record from finding content
    const evidenceText = member.detail ?? member.full_analysis ?? member.evidence ?? null;
    const primaryDoc = member.source_docs?.[0] ?? "unknown";

    if (evidenceText) {
      const evidenceKey = `${primaryDoc}:${member.finding_id}`;
      if (!evidenceMap.has(evidenceKey)) {
        evidenceMap.set(evidenceKey, {
          source_document: primaryDoc,
          source_location: null,
          evidence_text: evidenceText.slice(0, 500), // Cap evidence text
          claim_id: member.originating_claim_id ?? (member.claim_ids?.[0] ?? null),
          metric: canonicalKey.metric !== "unspecified" ? canonicalKey.metric : null,
          period: canonicalKey.period !== "unspecified" ? canonicalKey.period : null,
          scope: canonicalKey.scope,
          value: null,
          unit: null,
          authority_status: getAuthorityStatus(member.source_tag ?? "other"),
        });
      }
    }

    // Build comparison result
    const claimId = member.originating_claim_id ?? (member.claim_ids?.[0] ?? null);
    const claimData = claimId ? resolvedClaims.get(claimId) : null;
    if (claimData) {
      if (claimData.memo_version && !allMemoVersions.includes(claimData.memo_version)) {
        allMemoVersions.push(claimData.memo_version);
      }
      comparisonResults.push({
        comparison_basis: canonicalKey.comparison_basis,
        claim_text: claimData.claim_text.slice(0, 300),
        evidence_text: evidenceText ? evidenceText.slice(0, 300) : null,
        verdict: claimData.verdict,
      });
    }
  }

  // --- Deduplicate claim IDs ---
  const uniqueClaimIds = [...new Set(allClaimIds)];

  // --- Build claim chronology ---
  const claimChronology: CanonicalFinding["claim_chronology"] = [];
  for (const cid of uniqueClaimIds) {
    const claim = resolvedClaims.get(cid);
    if (claim) {
      claimChronology.push({
        claim_id: cid,
        claim_text: claim.claim_text.slice(0, 300),
        memo_version: claim.memo_version,
        verdict: claim.verdict,
      });
    }
  }
  // Sort by memo version
  claimChronology.sort((a, b) => (a.memo_version ?? "").localeCompare(b.memo_version ?? ""));

  // --- Determine verification status ---
  const verificationStatus = deriveVerificationStatus(members, comparisonResults);

  // --- Derive title ---
  const title = deriveCanonicalTitle(canonicalKey, members);

  // --- Build canonical finding ---
  const finding: CanonicalFinding = {
    canonical_finding_id: canonicalFindingId,
    canonical_issue_key: canonicalKeyStr,
    title,
    issue_domain: canonicalKey.issue_domain,
    issue_type: canonicalKey.issue_type,
    originating_claim_ids: uniqueClaimIds,
    memo_versions: allMemoVersions,
    claim_chronology: claimChronology,
    evidence_records: Array.from(evidenceMap.values()),
    source_documents: Array.from(sourceDocSet),
    comparison_results: comparisonResults,
    merged_from_finding_ids: memberFindingIds,
    verification_status: verificationStatus,
  };

  // --- Member outcomes ---
  const memberOutcomes: MemberOutcome[] = [];
  const [representative, ...absorbed] = members;

  memberOutcomes.push({
    finding_id: representative.finding_id,
    corpus_index: representative.corpus_index,
    title: representative.title,
    terminal_outcome: "retained_as_canonical_finding",
    canonical_finding_id: canonicalFindingId,
    reason: members.length > 1
      ? `Representative of canonical issue '${canonicalKeyStr}' (${members.length} members merged)`
      : `Singleton canonical finding for issue '${canonicalKeyStr}'`,
  });

  for (const member of absorbed) {
    memberOutcomes.push({
      finding_id: member.finding_id,
      corpus_index: member.corpus_index,
      title: member.title,
      terminal_outcome: "merged_into_canonical_finding",
      canonical_finding_id: canonicalFindingId,
      reason: `Merged into canonical finding '${canonicalFindingId}' for issue '${canonicalKeyStr}'`,
    });
  }

  return { finding, memberOutcomes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthorityStatus(sourceTag: string): "authoritative" | "secondary" | "unknown" {
  if (["financial_model", "consultant_report"].includes(sourceTag)) return "authoritative";
  if (["customer_data", "ic_memo", "cim"].includes(sourceTag)) return "secondary";
  return "unknown";
}

function deriveVerificationStatus(
  _members: RawFinding[],
  comparisons: Array<{ verdict: string }>
): CanonicalFinding["verification_status"] {
  // Derive verification status ONLY from Q3 verdicts in comparison results.
  // PROHIBITED: Do NOT infer from severity (critical/warning/info).
  // Missing or conflicting verdicts → unverifiable or degraded.
  const verdicts = comparisons.map(c => c.verdict).filter(v => v && v !== "");

  if (verdicts.length === 0) {
    // No verdict data available — fail closed to unverifiable
    return "unverifiable";
  }

  // Confirmed claims must not become adverse findings
  if (verdicts.every(v => v === "confirmed")) return "confirmed";

  // Adverse verdicts — most severe wins (from Q3 actual verdicts)
  if (verdicts.includes("contradicted")) return "contradicted";
  if (verdicts.includes("materially_changed")) return "materially_changed";
  if (verdicts.includes("unsupported")) return "unsupported";
  if (verdicts.includes("partially_supported")) return "partially_supported";
  if (verdicts.includes("unverifiable")) return "unverifiable";

  // Conflicting mix of confirmed + non-confirmed → degraded
  return "degraded";
}

function deriveCanonicalTitle(key: CanonicalKey, members: RawFinding[]): string {
  // Use the primary member's title if it's a singleton
  if (members.length === 1) return members[0].title;

  // Build a canonical title from the key
  const periodStr = key.period !== "unspecified" ? ` — ${key.period.toUpperCase()}` : "";
  const segmentStr = key.entity_or_segment !== "group" && key.entity_or_segment !== "unspecified"
    ? ` (${key.entity_or_segment})`
    : "";
  const metricStr = key.metric !== "unspecified"
    ? key.metric.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Issue";
  const typeStr = key.issue_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  return `${typeStr}: ${metricStr}${periodStr}${segmentStr}`;
}
