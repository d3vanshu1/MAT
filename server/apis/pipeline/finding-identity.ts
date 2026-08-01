/**
 * Finding Identity — SHA-256 Deterministic Canonical Finding ID Generation
 *
 * PURPOSE: Generate stable, deterministic canonical finding IDs so that the same
 * canonical issue (same key + same member set + same claims) always receives
 * the same ID regardless of:
 *   - construction order
 *   - retry/resume
 *   - invocation time
 *   - random factors
 *   - title wording, evidence prose, or merge-node position
 *
 * IDENTITY INPUTS (and ONLY these):
 *   - identity_version
 *   - canonical_issue_key
 *   - sorted resolved deterministic claim IDs
 *   - sorted member finding IDs
 *
 * NOT INCLUDED (would break determinism or are non-semantic):
 *   - timestamp
 *   - run ID
 *   - retry count
 *   - title wording
 *   - evidence prose
 *   - merge-node position
 *
 * FORMAT: `cfnd-v{version}-{sha256_prefix}`
 * Where sha256_prefix is the first 32 hex chars of SHA-256.
 *
 * INVARIANTS:
 *   - Same canonical key + same claims + same members → same ID
 *   - Different key OR different claims OR different members → different ID
 *   - ID encodes schema version for future migrations
 *
 * COLLISION SAFETY:
 *   - SHA-256 is used where supported (crypto module)
 *   - Falls back to FNV-128 only if crypto unavailable
 *   - Full identity payload is persisted alongside the hash for:
 *     (a) hash vs payload comparison
 *     (b) hard-fail on same hash / different payload
 *   - Never upsert by hash alone
 */

// No external crypto dependency — pure JS SHA-256 used below

// ---------------------------------------------------------------------------
// Schema version — increment when identity derivation logic changes
// ---------------------------------------------------------------------------
export const FINDING_IDENTITY_VERSION = "2";

// ---------------------------------------------------------------------------
// Identity payload — serialized for hashing AND persisted for comparison
// ---------------------------------------------------------------------------

export interface FindingIdentityPayload {
  /** Schema version for the identity derivation */
  identity_version: string;
  /** Serialized canonical issue key */
  canonical_issue_key: string;
  /** Sorted resolved deterministic claim IDs */
  resolved_claim_ids: string[];
  /** Sorted member finding IDs (lexicographic) */
  member_finding_ids: string[];
}

/**
 * Serialize the identity payload to a stable canonical string.
 * The output is used BOTH for hashing AND for persistence/comparison.
 */
export function serializeIdentityPayload(payload: FindingIdentityPayload): string {
  return JSON.stringify({
    v: payload.identity_version,
    key: payload.canonical_issue_key,
    claims: payload.resolved_claim_ids,
    members: payload.member_finding_ids,
  });
}

// ---------------------------------------------------------------------------
// SHA-256 canonical finding ID
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic canonical finding ID using SHA-256.
 *
 * Format: `cfnd-v{version}-{sha256_32hex}`
 *
 * Identity is derived from:
 *   - identity_version
 *   - canonical_issue_key
 *   - sorted resolved deterministic claim IDs
 *   - sorted member finding IDs
 *
 * Returns both the ID and the full persisted payload for collision detection.
 */
export function generateCanonicalFindingId(params: {
  canonical_key_str: string;
  member_finding_ids: string[];
  resolved_claim_ids?: string[];
}): string {
  const payload = buildIdentityPayload(params);
  const serialized = serializeIdentityPayload(payload);
  const hash = sha256Hex(serialized);
  return `cfnd-v${FINDING_IDENTITY_VERSION}-${hash.slice(0, 32)}`;
}

/**
 * Build the full identity payload for persistence.
 * This MUST be stored alongside the hash so that collision detection can work.
 */
export function buildIdentityPayload(params: {
  canonical_key_str: string;
  member_finding_ids: string[];
  resolved_claim_ids?: string[];
}): FindingIdentityPayload {
  return {
    identity_version: FINDING_IDENTITY_VERSION,
    canonical_issue_key: params.canonical_key_str,
    resolved_claim_ids: [...(params.resolved_claim_ids ?? [])].sort(),
    member_finding_ids: [...params.member_finding_ids].sort(),
  };
}

/**
 * Validate that a hash matches its payload. Hard-fail on mismatch.
 *
 * INVARIANT: Same hash MUST mean same payload. If they diverge,
 * the identity system is compromised.
 */
export function validateHashPayloadConsistency(
  existingId: string,
  existingPayload: FindingIdentityPayload,
  newPayload: FindingIdentityPayload,
): { valid: boolean; error?: string } {
  const existingSerialized = serializeIdentityPayload(existingPayload);
  const newSerialized = serializeIdentityPayload(newPayload);

  if (existingSerialized === newSerialized) {
    return { valid: true };
  }

  // Same hash, different payload — HARD FAILURE
  const newId = `cfnd-v${FINDING_IDENTITY_VERSION}-${sha256Hex(newSerialized).slice(0, 32)}`;
  if (newId === existingId) {
    return {
      valid: false,
      error: `HASH COLLISION: ID '${existingId}' maps to two different payloads. ` +
        `Existing: ${existingSerialized.slice(0, 200)}... New: ${newSerialized.slice(0, 200)}...`,
    };
  }

  // Different hash, different payload — normal (different findings)
  return { valid: true };
}

// ---------------------------------------------------------------------------
// SHA-256 implementation (pure JS — no Node crypto dependency for portability)
// ---------------------------------------------------------------------------

/**
 * Manual UTF-8 encoder — replaces TextEncoder which is unavailable in
 * the Superblocks server runtime.
 */
function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // Surrogate pair
      const hi = c;
      const lo = str.charCodeAt(++i);
      c = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure-JS SHA-256. Used instead of Node's crypto module because the build
 * system externalizes crypto for browser compatibility checks.
 */
function sha256Hex(input: string): string {
  // SHA-256 constants
  const K: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(n: number, x: number): number { return (x >>> n) | (x << (32 - n)); }
  function ch(x: number, y: number, z: number): number { return (x & y) ^ (~x & z); }
  function maj(x: number, y: number, z: number): number { return (x & y) ^ (x & z) ^ (y & z); }
  function sigma0(x: number): number { return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x); }
  function sigma1(x: number): number { return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x); }
  function gamma0(x: number): number { return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3); }
  function gamma1(x: number): number { return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10); }

  // Encode input as UTF-8 bytes (no TextEncoder dependency — server compat)
  const msgBytes = utf8Encode(input);
  const msgLen = msgBytes.length;

  // Padding: append 1 bit, zeros, then 64-bit big-endian length
  const totalBits = msgLen * 8;
  const padLen = ((msgLen + 9 + 63) & ~63); // Round up to 64-byte block
  const padded = new Uint8Array(padLen);
  padded.set(msgBytes);
  padded[msgLen] = 0x80;
  // Write length as 64-bit big-endian at end
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, totalBits, false);

  // Initial hash values
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // Process each 64-byte block
  const W = new Array<number>(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      W[i] = (gamma1(W[i - 2]) + W[i - 7] + gamma0(W[i - 15]) + W[i - 16]) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + sigma1(e) + ch(e, f, g) + K[i] + W[i]) | 0;
      const t2 = (sigma0(a) + maj(a, b, c)) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  // Convert to hex
  function toHex(n: number): string { return (n >>> 0).toString(16).padStart(8, "0"); }
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

// ---------------------------------------------------------------------------
// Stable Evidence ID generation (exported for use by canonical-finding-construction)
// ---------------------------------------------------------------------------

/**
 * Generate a stable evidence ID from:
 *   verification_document + coordinate + claim_id + normalized_excerpt_or_value
 *
 * Uses SHA-256 internally. NEVER deduplicates by claim_id alone.
 */
export function generateStableEvidenceIdFromParts(params: {
  verification_document: string;
  coordinate: string | null;
  claim_id: string;
  normalized_value: string;
}): string {
  const input = [
    params.verification_document,
    params.coordinate ?? "null",
    params.claim_id,
    params.normalized_value,
  ].join("|");
  const hash = sha256Hex(input);
  return `evd-${hash.slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Legacy FNV-128 (kept for migration/comparison only — NOT used for new IDs)
// ---------------------------------------------------------------------------

export function fnv1aHashForFinding(str: string): string {
  let h0 = 0x811c9dc5 >>> 0;
  let h1 = 0x050c5d1f >>> 0;
  let h2 = 0x1a47e90b >>> 0;
  let h3 = 0x3b9aca07 >>> 0;

  const FNV_PRIME = 0x01000193;

  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const lo = c & 0xff;
    const hi = (c >> 8) & 0xff;

    h0 ^= lo;
    h0 = Math.imul(h0, FNV_PRIME) >>> 0;

    h1 ^= hi ^ ((i & 0xff));
    h1 = Math.imul(h1, FNV_PRIME) >>> 0;

    h2 ^= ((lo << 4) | (hi >>> 4)) & 0xff;
    h2 ^= (h0 >>> 24) & 0xff;
    h2 = Math.imul(h2, FNV_PRIME) >>> 0;

    h3 ^= (lo ^ (i * 31)) & 0xff;
    h3 ^= (h1 >>> 16) & 0xff;
    h3 = Math.imul(h3, FNV_PRIME) >>> 0;
  }

  h0 ^= h2 >>> 16; h0 = Math.imul(h0, FNV_PRIME) >>> 0;
  h1 ^= h3 >>> 16; h1 = Math.imul(h1, FNV_PRIME) >>> 0;
  h2 ^= h0 >>> 16; h2 = Math.imul(h2, FNV_PRIME) >>> 0;
  h3 ^= h1 >>> 16; h3 = Math.imul(h3, FNV_PRIME) >>> 0;

  return (
    h0.toString(16).padStart(8, "0") +
    h1.toString(16).padStart(8, "0") +
    h2.toString(16).padStart(8, "0") +
    h3.toString(16).padStart(8, "0")
  );
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
  /** Originating claim IDs from the finding (for identity tracing) */
  originating_claim_ids: string[];
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
  originating_claim_ids?: string[];
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
    originating_claim_ids: params.originating_claim_ids ?? [],
  };
}
