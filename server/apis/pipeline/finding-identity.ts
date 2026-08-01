/**
 * Finding Identity — Deterministic Canonical Finding ID Generation
 *
 * PURPOSE: Generate stable, deterministic canonical finding IDs so that the same
 * canonical issue (same key + same member set) always receives the same ID
 * regardless of:
 *   - construction order
 *   - retry/resume
 *   - invocation time
 *   - random factors
 *
 * IDENTITY INPUTS:
 *   - canonical_key_str (the serialized canonical issue key)
 *   - sorted member finding IDs (lexicographic sort for stability)
 *
 * NOT INCLUDED (would break determinism):
 *   - timestamp
 *   - run ID
 *   - random UUID
 *   - ordering of members in input array
 *
 * FORMAT: `cfnd-v{version}-{hex16}`
 * Where hex16 is the FNV-1a hash of the identity payload.
 *
 * INVARIANTS:
 *   - Same canonical key + same members → same ID
 *   - Different key OR different members → different ID
 *   - ID encodes schema version for future migrations
 */

// ---------------------------------------------------------------------------
// Schema version — increment when identity derivation logic changes
// ---------------------------------------------------------------------------
export const FINDING_IDENTITY_VERSION = "1";

// ---------------------------------------------------------------------------
// FNV-1a hash (pure JS, no Node crypto dependency)
// Same implementation as claims-ledger-identity.ts — shared for consistency.
// ---------------------------------------------------------------------------

export function fnv1aHashForFinding(str: string): string {
  // FNV-1a parameters (32-bit)
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c >> 8) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    // Mix in position for extra entropy
    h1 ^= (i * 31) & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }

  // Additional mixing passes for longer strings
  for (let i = 0; i < str.length; i++) {
    h2 ^= str.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }

  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Deterministic canonical finding ID
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic canonical finding ID.
 *
 * Format: `cfnd-v{version}-{hex16}`
 *
 * Identity payload:
 *   - version
 *   - canonical_key_str
 *   - sorted member finding IDs (lexicographic)
 *
 * This ensures that the same canonical issue with the same constituent
 * findings always produces the same ID across replays.
 */
export function generateCanonicalFindingId(params: {
  canonical_key_str: string;
  member_finding_ids: string[];
}): string {
  const sortedMembers = [...params.member_finding_ids].sort();
  const identityPayload = [
    `fv=${FINDING_IDENTITY_VERSION}`,
    `key=${params.canonical_key_str}`,
    `members=${sortedMembers.join(",")}`,
  ].join("|");

  const hash = fnv1aHashForFinding(identityPayload);
  return `cfnd-v${FINDING_IDENTITY_VERSION}-${hash}`;
}

// ---------------------------------------------------------------------------
// Evidence Snapshot Schema
// ---------------------------------------------------------------------------

/**
 * An evidence snapshot captures the exact resolved claim record and evidence
 * state at the time of linkage. This is persisted alongside Q3 results so that
 * downstream stages (Q4, Q5) can reference the precise claim data that was
 * used to reach the verdict — even if the claims-ledger is later modified.
 */
export interface EvidenceSnapshot {
  /** Snapshot version */
  snapshot_version: string;
  /** The claim_id that was resolved */
  claim_id: string;
  /** The resolved claim's metric */
  metric: string;
  /** The resolved claim's period */
  period: string;
  /** The resolved claim's scope_qualifier */
  scope_qualifier: string;
  /** The resolved claim's numeric value */
  value: number;
  /** The resolved claim's unit */
  unit: string;
  /** The resolved claim's verbatim snippet */
  verbatim_snippet: string;
  /** The resolved claim's memo_version */
  memo_version: string;
  /** The resolved claim's IC document ID */
  ic_document_id: string;
  /** The resolved claim's IC document filename */
  ic_document_filename: string;
  /** The resolved claim's claim_type */
  claim_type: string;
  /** The authority class assigned during linkage */
  authority_class: string;
  /** The verdict assigned during linkage */
  verdict: string;
  /** The evidence text that supported the verdict */
  evidence_text: string | null;
  /** Timestamp of when this snapshot was captured */
  snapshot_timestamp: string;
}

export const EVIDENCE_SNAPSHOT_VERSION = "1";

/**
 * Build an evidence snapshot from a resolved claim and linkage result.
 */
export function buildEvidenceSnapshot(params: {
  claim_id: string;
  claim_record: {
    metric: string;
    period: string;
    scope_qualifier: string;
    value: number;
    unit: string;
    verbatim_snippet: string;
    memo_version: string;
    ic_document_id: string;
    ic_document_filename: string;
    claim_type: string;
  };
  authority_class: string;
  verdict: string;
  evidence_text: string | null;
}): EvidenceSnapshot {
  return {
    snapshot_version: EVIDENCE_SNAPSHOT_VERSION,
    claim_id: params.claim_id,
    metric: params.claim_record.metric,
    period: params.claim_record.period,
    scope_qualifier: params.claim_record.scope_qualifier,
    value: params.claim_record.value,
    unit: params.claim_record.unit,
    verbatim_snippet: params.claim_record.verbatim_snippet,
    memo_version: params.claim_record.memo_version,
    ic_document_id: params.claim_record.ic_document_id,
    ic_document_filename: params.claim_record.ic_document_filename,
    claim_type: params.claim_record.claim_type,
    authority_class: params.authority_class,
    verdict: params.verdict,
    evidence_text: params.evidence_text,
    snapshot_timestamp: new Date().toISOString(),
  };
}
