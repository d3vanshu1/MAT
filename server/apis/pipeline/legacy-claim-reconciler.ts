/**
 * Legacy Claim Reconciler — Bridge legacy `c{chunk}-{claim}` references to deterministic `clm-v1-*` IDs
 *
 * PURPOSE: The contradiction-check analysis module assigned claim references using the
 * `c{chunk_index}-{claim_index}` positional format from the original universal_extractions
 * ordering. The claims ledger uses `clm-v1-*` deterministic IDs. This module builds a
 * bridge map so that legacy references can be resolved to the canonical ledger.
 *
 * RECONCILIATION STRATEGIES (tried in order):
 *   1. PROVENANCE-BACKED POSITIONAL: `c{chunk}-{claim}` → resolved ONLY when explicit
 *      source-document provenance (document_id, chunk_index, claim_index) is available.
 *      Document-order heuristics are NOT used — they are unsafe.
 *   2. METRIC-PERIOD: For slug-style refs like `numeric_verification_fy2026_divergence` → match by metric+period+keywords
 *   3. DIRECT: If the ref happens to be a `clm-v1-*` ID already → pass through
 *
 * POSITIONAL RESOLUTION POLICY:
 *   - Bare cN-M refs WITHOUT source-document provenance are ALWAYS unresolved.
 *   - Document-order positional mapping is REMOVED — it is provably unsafe when
 *     N resets to 0 per document and multiple IC documents exist.
 *   - Provenance-backed resolution requires an explicit (doc_id, chunk, claim) tuple.
 *
 * INVARIANTS:
 *   - Never fabricates a mapping — every bridge is backed by provenance or content evidence
 *   - No document-order heuristic — positional refs require provenance
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
// Positional index builder — PROVENANCE-ONLY (no document-order heuristic)
// ---------------------------------------------------------------------------

/**
 * Provenance record: explicit (document_id, chunk_index, claim_index) → claim_id mapping.
 * This comes from the claim-origin-map when available.
 */
export interface ClaimProvenance {
  claim_id: string;
  document_id: string;
  chunk_index: number;
  claim_index: number;
}

/**
 * Builds a positional index from EXPLICIT provenance records only.
 *
 * POLICY: Document-order positional resolution is REMOVED.
 * Bare cN-M refs may resolve ONLY when source-document provenance is available.
 * Without provenance, ALL positional refs are unresolved.
 *
 * @param provenance - Explicit (doc_id, chunk_index, claim_index) → claim_id records.
 *                     Empty array means no provenance is available (all positional = unresolved).
 * @param documentOrder - IC document IDs (used only for the provenance-backed lookup key).
 * @returns Map from "docIdx:chunkIdx:claimIdx" → claim_id (only unique entries).
 *          Returns EMPTY MAP when no provenance is available (forcing all cN-M to unresolved).
 */
export function buildPositionalIndex(
  provenance: ClaimProvenance[],
  documentOrder: string[],
): Map<string, string> {
  if (provenance.length === 0) {
    // No provenance available — ALL positional refs are unresolved.
    // This is the safe default. Document-order heuristic is NOT used.
    return new Map();
  }

  // Build doc_id → document_order_index map
  const docIndexMap = new Map<string, number>();
  for (let i = 0; i < documentOrder.length; i++) {
    docIndexMap.set(documentOrder[i], i);
  }

  // With provenance, resolve using explicit (doc, chunk, claim) tuples
  const positionCandidates = new Map<string, string[]>();

  for (const record of provenance) {
    const docIdx = docIndexMap.get(record.document_id);
    if (docIdx === undefined) continue; // Unknown document

    // Key includes document index so c0-0 in doc A ≠ c0-0 in doc B
    const key = `${docIdx}:${record.chunk_index}:${record.claim_index}`;
    if (!positionCandidates.has(key)) {
      positionCandidates.set(key, []);
    }
    positionCandidates.get(key)!.push(record.claim_id);
  }

  // Only bridge unique positions
  const positionalMap = new Map<string, string>();
  for (const [key, candidates] of positionCandidates) {
    if (candidates.length === 1) {
      positionalMap.set(key, candidates[0]);
    }
  }
  return positionalMap;
}

/**
 * Returns the count of documents in the extraction corpus.
 * ALL bare cN-M refs without provenance are unresolved regardless.
 */
export function getPositionalResolutionPolicy(
  provenance: ClaimProvenance[],
  documentOrder: string[],
): { provenanceAvailable: boolean; documentCount: number; resolvableCount: number } {
  const resolvable = buildPositionalIndex(provenance, documentOrder).size;
  return {
    provenanceAvailable: provenance.length > 0,
    documentCount: documentOrder.length,
    resolvableCount: resolvable,
  };
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
 * @param claims - The full enriched claims ledger (for content matching)
 * @param documentOrder - IC document IDs in the order they were processed/extracted
 * @param claimMap - Map from claim_id → IdentifiedClaim (for direct lookups)
 * @param provenance - Explicit positional provenance records (empty = no positional resolution)
 */
export function buildReconciliationIndex(
  legacyRefs: string[],
  claims: IdentifiedClaim[],
  documentOrder: string[],
  claimMap: Map<string, IdentifiedClaim>,
  provenance: ClaimProvenance[] = [],
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

  // Build positional index from explicit provenance only (no document-order heuristic)
  const positionalIndex = buildPositionalIndex(provenance, documentOrder);

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
        // POLICY: Without source-document provenance, ALL positional refs are unresolved.
        // Document-order heuristic is NOT used. Only explicit provenance can resolve cN-M.
        if (provenance.length === 0) {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_no_positional_data",
            candidates_considered: 0,
            rationale: `Positional ref '${ref}' cannot be resolved — no source-document provenance available. Document-order resolution is disabled.`,
          });
          summary.unresolved_no_positional_data++;
          break;
        }

        // With provenance, attempt to resolve using docIdx:chunkIdx:claimIdx key
        // The ref cN-M encodes (chunk_within_doc=N, claim_within_chunk=M)
        // We need to check ALL documents at position (N, M)
        const matchingKeys: string[] = [];
        for (let docIdx = 0; docIdx < documentOrder.length; docIdx++) {
          const key = `${docIdx}:${parsed.chunkIndex}:${parsed.claimIndex}`;
          if (positionalIndex.has(key)) {
            matchingKeys.push(key);
          }
        }

        if (matchingKeys.length === 1) {
          const resolved = positionalIndex.get(matchingKeys[0])!;
          bridge.set(ref, resolved);
          records.push({
            legacy_ref: ref,
            resolved_claim_id: resolved,
            outcome: "bridged_positional",
            candidates_considered: 1,
            rationale: `Provenance-backed positional match: ${matchingKeys[0]} → ${resolved}`,
          });
          summary.bridged_positional++;
        } else if (matchingKeys.length > 1) {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_ambiguous",
            candidates_considered: matchingKeys.length,
            rationale: `Positional ref '${ref}' matches ${matchingKeys.length} documents at (chunk=${parsed.chunkIndex}, claim=${parsed.claimIndex}) — ambiguous, fail-closed`,
          });
          summary.unresolved_ambiguous++;
        } else {
          records.push({
            legacy_ref: ref,
            resolved_claim_id: null,
            outcome: "unresolved_no_match",
            candidates_considered: 0,
            rationale: `Provenance has no claim at position (chunk=${parsed.chunkIndex}, claim=${parsed.claimIndex}) in any document`,
          });
          summary.unresolved_no_match++;
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
