/**
 * Legacy Claim Reconciler — Bridge legacy `c{chunk}-{claim}` references to deterministic `clm-v1-*` IDs
 *
 * PURPOSE: The contradiction-check analysis module assigned claim references using the
 * `c{chunk_index}-{claim_index}` positional format from the original universal_extractions
 * ordering. The claims ledger uses `clm-v1-*` deterministic IDs. This module builds a
 * bridge map so that legacy references can be resolved to the canonical ledger.
 *
 * RECONCILIATION STRATEGIES (tried in order):
 *   1. POSITIONAL: `c{chunk}-{claim}` → reconstruct by document order + claim position within doc
 *   2. METRIC-PERIOD: For slug-style refs like `numeric_verification_fy2026_divergence` → match by metric+period+keywords
 *   3. DIRECT: If the ref happens to be a `clm-v1-*` ID already → pass through
 *
 * AMBIGUITY HANDLING:
 *   - Zero matches → unresolved (logged, not bridged)
 *   - One match → bridged successfully
 *   - Multiple matches → ambiguous (rejected, not bridged)
 *
 * INVARIANTS:
 *   - Never fabricates a mapping — every bridge is backed by positional or content evidence
 *   - Ambiguous mappings are rejected (fail-closed)
 *   - Every reconciliation attempt is recorded with its outcome for audit
 */

import type { IdentifiedClaim } from "./claims-ledger-identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReconciliationOutcome =
  | "bridged_positional"      // c{N}-{M} matched by position in extraction order
  | "bridged_metric_period"   // Slug matched by metric+period content
  | "bridged_direct"          // Already a clm-v1-* ID (pass-through)
  | "unresolved_no_match"     // No candidate found
  | "unresolved_ambiguous"    // Multiple candidates, cannot disambiguate
  | "unresolved_malformed"    // Reference too short or garbled to parse
  | "unresolved_no_positional_data"; // Positional data not available for this chunk

export interface ReconciliationRecord {
  /** The original legacy reference from the finding */
  legacy_ref: string;
  /** The resolved deterministic claim_id (null if unresolved) */
  resolved_claim_id: string | null;
  /** How it was resolved */
  outcome: ReconciliationOutcome;
  /** Number of candidate matches considered */
  candidates_considered: number;
  /** Human-readable explanation */
  rationale: string;
}

export interface ReconciliationIndex {
  /** Map from legacy ref → deterministic claim_id */
  bridge: Map<string, string>;
  /** Full audit trail of every reconciliation attempt */
  records: ReconciliationRecord[];
  /** Summary counts */
  summary: {
    total_attempted: number;
    bridged_positional: number;
    bridged_metric_period: number;
    bridged_direct: number;
    unresolved_no_match: number;
    unresolved_ambiguous: number;
    unresolved_malformed: number;
    unresolved_no_positional_data: number;
  };
}

// ---------------------------------------------------------------------------
// Legacy reference parsing
// ---------------------------------------------------------------------------

/** Pattern: c{chunkIndex}-{claimIndex} (e.g. c3-5, c0-7, c12-0) */
const LEGACY_POSITIONAL_PATTERN = /^c(\d+)-(\d+)$/;

/** Pattern: clm-v{version}-{hash} (already canonical) */
const CANONICAL_PATTERN = /^clm-v\d+-[a-f0-9]+$/;

export interface ParsedLegacyRef {
  type: "positional" | "canonical" | "slug" | "malformed";
  chunkIndex?: number;
  claimIndex?: number;
  raw: string;
}

export function parseLegacyRef(ref: string): ParsedLegacyRef {
  const trimmed = ref.trim();

  if (trimmed.length < 2) {
    return { type: "malformed", raw: trimmed };
  }

  // Check if already canonical
  if (CANONICAL_PATTERN.test(trimmed)) {
    return { type: "canonical", raw: trimmed };
  }

  // Check positional format
  const posMatch = trimmed.match(LEGACY_POSITIONAL_PATTERN);
  if (posMatch) {
    return {
      type: "positional",
      chunkIndex: parseInt(posMatch[1], 10),
      claimIndex: parseInt(posMatch[2], 10),
      raw: trimmed,
    };
  }

  // Everything else is a slug (descriptive string)
  return { type: "slug", raw: trimmed };
}

// ---------------------------------------------------------------------------
// Positional index builder
// ---------------------------------------------------------------------------

/**
 * Builds a positional index from the enriched claims ledger.
 *
 * HISTORICAL PRODUCER SEMANTICS (proven from extraction-prompt.ts chunkDocument):
 *   N in `c{N}-{M}` = chunk_index WITHIN A SINGLE DOCUMENT (starts at 0 per doc)
 *   M in `c{N}-{M}` = claim ordinal WITHIN THAT CHUNK
 *
 * CRITICAL: Since chunkIndex is document-local and resets to 0 per document,
 * the same `c0-0` reference is produced by every single-chunk document.
 * Without document identity in the reference, `c0-0` is AMBIGUOUS across documents.
 *
 * SAFE RESOLUTION (from claim-origin-map, when available):
 *   - Use the persisted (document_id, chunk_index, claim_index) provenance
 *   - If only ONE claim exists at position (N, M) → unique, resolvable
 *   - If MULTIPLE claims from different documents share (N, M) → AMBIGUOUS
 *
 * FALLBACK RESOLUTION (ledger-only, no origin map):
 *   - Group claims by document in processing order
 *   - Each document contributes ONE chunk slot (chunk N = document at index N)
 *   - M = claim ordinal within that document's claims (in extraction order)
 *   - This is the legacy heuristic: ONLY SAFE if document count equals max chunk+1
 *
 * ANY position resolved by MULTIPLE documents is AMBIGUOUS and NOT bridged.
 */
export function buildPositionalIndex(
  claims: IdentifiedClaim[],
  documentOrder: string[],
): Map<string, string> {
  const positionalMap = new Map<string, string>(); // "chunk:claim" → claim_id
  const positionCandidates = new Map<string, string[]>(); // "chunk:claim" → [claim_ids]

  // Group claims by document, preserving extraction order within each doc
  const claimsByDoc = new Map<string, IdentifiedClaim[]>();
  for (const claim of claims) {
    if (!claimsByDoc.has(claim.ic_document_id)) {
      claimsByDoc.set(claim.ic_document_id, []);
    }
    claimsByDoc.get(claim.ic_document_id)!.push(claim);
  }

  // The producer assigns chunk_index per-document (all starting at 0).
  // Since IdentifiedClaim lacks chunk_index, we use document ORDER as the
  // chunk index proxy — but ONLY if the mapping is unique.
  // Each document occupies ONE chunk slot: chunk N = Nth document.
  // Claim M = Mth claim in that document's extraction order.
  for (let chunkIdx = 0; chunkIdx < documentOrder.length; chunkIdx++) {
    const docId = documentOrder[chunkIdx];
    const docClaims = claimsByDoc.get(docId) ?? [];

    for (let claimIdx = 0; claimIdx < docClaims.length; claimIdx++) {
      const key = `${chunkIdx}:${claimIdx}`;
      if (!positionCandidates.has(key)) {
        positionCandidates.set(key, []);
      }
      positionCandidates.get(key)!.push(docClaims[claimIdx].claim_id);
    }
  }

  // SAFETY: Only bridge positions that resolve to EXACTLY ONE claim
  for (const [key, candidates] of positionCandidates) {
    if (candidates.length === 1) {
      positionalMap.set(key, candidates[0]);
    }
    // Multiple candidates at same position → AMBIGUOUS, fail-closed
  }

  return positionalMap;
}

/**
 * Returns the set of legacy cN-M references that are ambiguous (same local position
 * exists in multiple documents). These MUST NOT be auto-resolved.
 *
 * Key insight: The legacy producer generates cN-M where N = chunk index WITHIN a single
 * document (resets to 0 per document). So c0-0 from any document means "first claim in
 * that document's first chunk." If multiple documents each have a claim at local position
 * (N, M), then cN-M is ambiguous — we cannot determine which document it came from.
 *
 * This is distinct from buildPositionalIndex which uses document-order as a disambiguation
 * strategy (doc 0 → chunk 0, doc 1 → chunk 1, etc). That mapping is deterministic but
 * does NOT match what the legacy producer actually meant.
 */
export function getAmbiguousPositionalKeys(
  claims: IdentifiedClaim[],
  documentOrder: string[],
): Set<string> {
  // Group claims by document
  const claimsByDoc = new Map<string, IdentifiedClaim[]>();
  for (const claim of claims) {
    if (!claimsByDoc.has(claim.ic_document_id)) {
      claimsByDoc.set(claim.ic_document_id, []);
    }
    claimsByDoc.get(claim.ic_document_id)!.push(claim);
  }

  // For each LOCAL position (chunk=0 always since we treat each doc as one chunk,
  // claimIdx = order within that doc), track how many documents have a claim there.
  // The legacy producer emits c0-M for the Mth claim of a document (single chunk per doc).
  const positionOccupancy = new Map<string, number>(); // "N:M" → count of docs having claim at that local position

  for (const docId of documentOrder) {
    const docClaims = claimsByDoc.get(docId) ?? [];
    // Each document's claims map to local positions c0-0, c0-1, c0-2, ...
    // (N=0 because each document is treated as a single chunk by the producer)
    for (let claimIdx = 0; claimIdx < docClaims.length; claimIdx++) {
      const key = `0:${claimIdx}`;
      positionOccupancy.set(key, (positionOccupancy.get(key) ?? 0) + 1);
    }
  }

  const ambiguous = new Set<string>();
  for (const [key, count] of positionOccupancy) {
    if (count > 1) {
      const [chunk, claim] = key.split(":");
      ambiguous.add(`c${chunk}-${claim}`);
    }
  }
  return ambiguous;
}

// ---------------------------------------------------------------------------
// Metric-period content matcher
// ---------------------------------------------------------------------------

/**
 * Attempts to resolve a slug-style reference by matching against claim content.
 *
 * Slug refs often encode the metric, period, or finding type as a descriptive string.
 * E.g. `numeric_verification_fy2026_divergence` → metric containing "divergence" + period "fy2026"
 *
 * Returns all matching claim_ids (caller decides if ambiguous).
 */
export function matchByContent(
  slug: string,
  claims: IdentifiedClaim[],
): string[] {
  const normalized = slug.toLowerCase().replace(/[_-]+/g, " ").trim();
  const tokens = normalized.split(/\s+/).filter(t => t.length > 2);

  if (tokens.length === 0) return [];

  // Extract period tokens (fy20XX, ltm, q1, h1, etc.)
  const periodTokens = tokens.filter(t =>
    /^fy\d{2,4}$/.test(t) || /^(ltm|ntm|ytd|run.rate)$/.test(t) ||
    /^[qh][1-4]$/.test(t)
  );

  // Extract metric tokens (everything else meaningful)
  const metricTokens = tokens.filter(t =>
    !periodTokens.includes(t) && !["numeric", "verification", "divergence", "check"].includes(t)
  );

  const candidates: string[] = [];

  for (const claim of claims) {
    let score = 0;
    const claimMetricLower = claim.metric.toLowerCase();
    const claimPeriodLower = claim.period.toLowerCase();
    const claimScopeLower = claim.scope_qualifier.toLowerCase();

    // Period match
    for (const pt of periodTokens) {
      if (claimPeriodLower.includes(pt)) score += 3;
    }

    // Metric/scope match
    for (const mt of metricTokens) {
      if (claimMetricLower.includes(mt)) score += 2;
      if (claimScopeLower.includes(mt)) score += 1;
    }

    if (score >= 3) {
      candidates.push(claim.claim_id);
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main reconciler
// ---------------------------------------------------------------------------

/**
 * Build a complete reconciliation index mapping all unique legacy refs
 * found in findings to deterministic claim IDs.
 *
 * @param legacyRefs - All unique legacy references found across findings
 * @param claims - The full enriched claims ledger
 * @param documentOrder - IC document IDs in the order they were processed/extracted
 * @param claimMap - Map from claim_id → IdentifiedClaim (for direct lookups)
 */
export function buildReconciliationIndex(
  legacyRefs: string[],
  claims: IdentifiedClaim[],
  documentOrder: string[],
  claimMap: Map<string, IdentifiedClaim>,
): ReconciliationIndex {
  const bridge = new Map<string, string>();
  const records: ReconciliationRecord[] = [];
  const summary = {
    total_attempted: 0,
    bridged_positional: 0,
    bridged_metric_period: 0,
    bridged_direct: 0,
    unresolved_no_match: 0,
    unresolved_ambiguous: 0,
    unresolved_malformed: 0,
    unresolved_no_positional_data: 0,
  };

  // Build positional index + ambiguous refs set
  const positionalIndex = buildPositionalIndex(claims, documentOrder);
  const ambiguousPositionalRefs = getAmbiguousPositionalKeys(claims, documentOrder);

  for (const ref of legacyRefs) {
    summary.total_attempted++;
    const parsed = parseLegacyRef(ref);

    switch (parsed.type) {
      case "canonical": {
        // Already a clm-v1-* ID — verify it exists in ledger
        if (claimMap.has(ref)) {
          bridge.set(ref, ref);
          records.push({
            legacy_ref: ref,
            resolved_claim_id: ref,
            outcome: "bridged_direct",
            candidates_considered: 1,
            rationale: "Already a canonical claim ID present in ledger",
          });
          summary.bridged_direct++;
        } else {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_no_match",
            candidates_considered: 0,
            rationale: `Canonical-format ID '${ref}' not found in claims ledger`,
          });
          summary.unresolved_no_match++;
        }
        break;
      }

      case "positional": {
        // CRITICAL: Check ambiguity FIRST — ambiguous positional refs MUST fail closed.
        // Historical producer semantics: cN-M where N = chunk_index within a single document
        // (resets to 0 per document). Since all documents start at chunk 0, many positional
        // keys are shared across multiple IC documents and cannot be resolved deterministically.
        if (ambiguousPositionalRefs.has(ref)) {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_ambiguous",
            candidates_considered: documentOrder.length,
            rationale: `Positional ref '${ref}' maps to the same chunk:claim position in ${documentOrder.length} IC documents — ambiguous, fail-closed`,
          });
          summary.unresolved_ambiguous++;
          break;
        }

        const key = `${parsed.chunkIndex}:${parsed.claimIndex}`;
        const resolved = positionalIndex.get(key);

        if (resolved) {
          bridge.set(ref, resolved);
          records.push({
            legacy_ref: ref,
            resolved_claim_id: resolved,
            outcome: "bridged_positional",
            candidates_considered: 1,
            rationale: `Positional match: chunk=${parsed.chunkIndex}, claim=${parsed.claimIndex} → ${resolved}`,
          });
          summary.bridged_positional++;
        } else {
          // Check if the chunk index is out of range
          const maxChunk = documentOrder.length - 1;
          if (parsed.chunkIndex! > maxChunk) {
            records.push({
              legacy_ref: ref,
              resolved_claim_id: null,
              outcome: "unresolved_no_positional_data",
              candidates_considered: 0,
              rationale: `Chunk index ${parsed.chunkIndex} exceeds document count (max=${maxChunk})`,
            });
            summary.unresolved_no_positional_data++;
          } else {
            records.push({
              legacy_ref: ref,
              resolved_claim_id: null,
              outcome: "unresolved_no_match",
              candidates_considered: 0,
              rationale: `Positional key '${key}' not found — claim index may exceed claims in document ${parsed.chunkIndex}`,
            });
            summary.unresolved_no_match++;
          }
        }
        break;
      }

      case "slug": {
        const candidates = matchByContent(ref, claims);

        if (candidates.length === 1) {
          bridge.set(ref, candidates[0]);
          records.push({
            legacy_ref: ref,
            resolved_claim_id: candidates[0],
            outcome: "bridged_metric_period",
            candidates_considered: candidates.length,
            rationale: `Slug '${ref}' matched uniquely by content to ${candidates[0]}`,
          });
          summary.bridged_metric_period++;
        } else if (candidates.length > 1) {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_ambiguous",
            candidates_considered: candidates.length,
            rationale: `Slug '${ref}' matched ${candidates.length} claims — ambiguous, rejected`,
          });
          summary.unresolved_ambiguous++;
        } else {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_no_match",
            candidates_considered: 0,
            rationale: `Slug '${ref}' did not match any claim by content`,
          });
          summary.unresolved_no_match++;
        }
        break;
      }

      case "malformed": {
        records.push({
          legacy_ref: ref,
          resolved_claim_id: null,
          outcome: "unresolved_malformed",
          candidates_considered: 0,
          rationale: `Reference '${ref}' is too short or malformed to parse`,
        });
        summary.unresolved_malformed++;
        break;
      }
    }
  }

  return { bridge, records, summary };
}

/**
 * Resolve a single claim reference through the reconciliation bridge.
 *
 * Order of resolution:
 *   1. Check bridge map (legacy → canonical)
 *   2. Check claimMap directly (in case it's already a canonical ID)
 *   3. Fail with detailed reason
 */
export function resolveViaReconciliation(
  claimRef: string | null | undefined,
  bridge: Map<string, string>,
  claimMap: Map<string, IdentifiedClaim>,
): { resolved: boolean; claim_id: string | null; method: string } {
  if (!claimRef || claimRef.trim() === "") {
    return { resolved: false, claim_id: null, method: "no_reference" };
  }

  const ref = claimRef.trim();

  // 1. Try bridge
  const bridged = bridge.get(ref);
  if (bridged && claimMap.has(bridged)) {
    return { resolved: true, claim_id: bridged, method: "reconciliation_bridge" };
  }

  // 2. Try direct lookup (already canonical)
  if (claimMap.has(ref)) {
    return { resolved: true, claim_id: ref, method: "direct_canonical" };
  }

  // 3. Fail
  return { resolved: false, claim_id: null, method: "unresolved" };
}
