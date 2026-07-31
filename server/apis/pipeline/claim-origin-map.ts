/**
 * Claim Origin Map — explicit provenance for globally unique claim IDs.
 *
 * Replaces the old approach of parsing "c{routedIdx}-{claimIdx}" into the
 * global routed array. Now every claim carries deterministic provenance:
 *   {documentId}:{chunkIndex}:{claimIndex}
 *
 * The origin map resolves a claim_id to its source document without
 * depending on array position, promise completion order, or filename alone.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimOrigin {
  claim_id: string;
  document_id: string;
  filename: string;
  chunk_index: number;
  claim_index: number;
  /** Page or source coordinate from extraction, when available */
  source_page: string | null;
}

export interface ClaimOriginMap {
  /** Map from claim_id → ClaimOrigin (fast lookup) */
  entries: Map<string, ClaimOrigin>;
  /** Build metadata */
  version: number;
}

/** Current schema version for serialized origin maps */
export const CLAIM_ORIGIN_MAP_VERSION = 1;

// ---------------------------------------------------------------------------
// Claim ID format
// ---------------------------------------------------------------------------

/** Regex for the new globally unique claim ID format: {uuid}:{chunkIdx}:{claimIdx} */
const GLOBAL_CLAIM_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d+)$/;

/** Regex for the legacy document-local claim ID format: c{N}-{M} */
const LEGACY_CLAIM_ID_PATTERN = /^c(\d+)-(\d+)$/;

/**
 * Generate a deterministic, globally unique claim ID.
 * Format: "{documentId}:{chunkIndex}:{claimIndex}"
 */
export function generateClaimId(documentId: string, chunkIndex: number, claimIndex: number): string {
  return `${documentId}:${chunkIndex}:${claimIndex}`;
}

/**
 * Parse a claim ID. Returns the structured components or null if unparseable.
 */
export function parseClaimId(claimId: string): {
  format: "global" | "legacy";
  document_id?: string;
  chunk_index: number;
  claim_index: number;
} | null {
  const globalMatch = claimId.match(GLOBAL_CLAIM_ID_PATTERN);
  if (globalMatch) {
    return {
      format: "global",
      document_id: globalMatch[1],
      chunk_index: parseInt(globalMatch[2], 10),
      claim_index: parseInt(globalMatch[3], 10),
    };
  }
  const legacyMatch = claimId.match(LEGACY_CLAIM_ID_PATTERN);
  if (legacyMatch) {
    return {
      format: "legacy",
      chunk_index: parseInt(legacyMatch[1], 10),
      claim_index: parseInt(legacyMatch[2], 10),
    };
  }
  return null;
}

/**
 * Check if a claim ID uses the new globally unique format.
 */
export function isGlobalClaimId(claimId: string): boolean {
  return GLOBAL_CLAIM_ID_PATTERN.test(claimId);
}

/**
 * Check if a claim ID uses the legacy document-local format.
 */
export function isLegacyClaimId(claimId: string): boolean {
  return LEGACY_CLAIM_ID_PATTERN.test(claimId);
}

// ---------------------------------------------------------------------------
// Builder — constructs an origin map from extraction data
// ---------------------------------------------------------------------------

export interface ClaimOriginEntry {
  claim_id: string;
  document_id: string;
  filename: string;
  chunk_index: number;
  claim_index: number;
  source_page: string | null;
}

/**
 * Build a ClaimOriginMap from a list of entries.
 * Fails closed on duplicate IDs — this means the extraction produced
 * non-deterministic output (a bug at the extraction layer).
 *
 * @throws Error if duplicate claim_ids are detected
 */
export function buildClaimOriginMap(entries: ClaimOriginEntry[]): ClaimOriginMap {
  const map = new Map<string, ClaimOrigin>();
  for (const entry of entries) {
    if (map.has(entry.claim_id)) {
      const existing = map.get(entry.claim_id)!;
      throw new Error(
        `[ClaimOriginMap] DUPLICATE claim_id detected: "${entry.claim_id}" ` +
        `— first from doc "${existing.filename}" chunk ${existing.chunk_index}, ` +
        `duplicate from doc "${entry.filename}" chunk ${entry.chunk_index}. ` +
        `This indicates a non-deterministic extraction bug.`
      );
    }
    map.set(entry.claim_id, {
      claim_id: entry.claim_id,
      document_id: entry.document_id,
      filename: entry.filename,
      chunk_index: entry.chunk_index,
      claim_index: entry.claim_index,
      source_page: entry.source_page,
    });
  }
  return { entries: map, version: CLAIM_ORIGIN_MAP_VERSION };
}

/**
 * Build a ClaimOriginMap from the universal_extractions routed array.
 * Scans each extraction's text for claim IDs and maps them to their source document.
 *
 * @param routed Array of extraction rows (document_id, chunk_index, extraction_json)
 * @param idToFileName Map from document_id → filename
 */
export function buildOriginMapFromRoutedArray(
  routed: Array<{ document_id: string; chunk_index: number; extraction_json: unknown }>,
  idToFileName: Map<string, string>,
): ClaimOriginMap {
  const entries: ClaimOriginEntry[] = [];

  for (const row of routed) {
    const ext = typeof row.extraction_json === "string"
      ? JSON.parse(row.extraction_json)
      : row.extraction_json;

    // The extraction text contains claim IDs injected by injectClaimIds.
    // Parse the key_claims or scan for IDs in the extraction text.
    const extractionText = ext.extraction ?? "";
    const documentId = ext.documentId ?? row.document_id;
    const filename = idToFileName.get(documentId) ?? ext.sourceFile ?? "unknown";

    // Scan for new-format IDs: {uuid}:{chunkIdx}:{claimIdx}
    const globalMatches = extractionText.matchAll(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d+)/g
    );
    for (const m of globalMatches) {
      const claimId = m[0];
      const chunkIdx = parseInt(m[2], 10);
      const claimIdx = parseInt(m[3], 10);
      // Only add if this matches OUR document (avoid false positives from UUIDs in text)
      if (m[1] === documentId) {
        entries.push({
          claim_id: claimId,
          document_id: documentId,
          filename,
          chunk_index: chunkIdx,
          claim_index: claimIdx,
          source_page: null,
        });
      }
    }

    // Also scan for legacy format IDs: c{N}-{M}
    // These are mapped to the routed row's document_id
    const legacyMatches = extractionText.matchAll(/\bid["']?\s*:\s*["']c(\d+)-(\d+)["']/g);
    for (const m of legacyMatches) {
      const chunkIdx = parseInt(m[1], 10);
      const claimIdx = parseInt(m[2], 10);
      const legacyId = `c${chunkIdx}-${claimIdx}`;
      // Legacy IDs use document-local chunk index — only register if it matches this row
      if (chunkIdx === row.chunk_index) {
        entries.push({
          claim_id: legacyId,
          document_id: documentId,
          filename,
          chunk_index: chunkIdx,
          claim_index: claimIdx,
          source_page: null,
        });
      }
    }
  }

  // Build the map — Note: for legacy IDs that collide across documents,
  // the first occurrence wins. This is intentional: legacy provenance is
  // ambiguous and should not receive fabricated attribution.
  const map = new Map<string, ClaimOrigin>();
  const collisions: string[] = [];
  for (const entry of entries) {
    if (map.has(entry.claim_id)) {
      // For new-format IDs, collision is a hard error
      if (isGlobalClaimId(entry.claim_id)) {
        const existing = map.get(entry.claim_id)!;
        throw new Error(
          `[ClaimOriginMap] DUPLICATE global claim_id: "${entry.claim_id}" ` +
          `from docs "${existing.filename}" and "${entry.filename}"`
        );
      }
      // For legacy IDs, log the collision but don't throw (ambiguity surfaced)
      collisions.push(entry.claim_id);
      continue; // first occurrence wins
    }
    map.set(entry.claim_id, {
      claim_id: entry.claim_id,
      document_id: entry.document_id,
      filename: entry.filename,
      chunk_index: entry.chunk_index,
      claim_index: entry.claim_index,
      source_page: entry.source_page,
    });
  }

  if (collisions.length > 0) {
    console.warn(
      `[ClaimOriginMap] ${collisions.length} legacy claim ID collision(s) detected ` +
      `(ambiguous provenance — not resolved): ${collisions.slice(0, 5).join(", ")}` +
      (collisions.length > 5 ? ` and ${collisions.length - 5} more` : "")
    );
  }

  return { entries: map, version: CLAIM_ORIGIN_MAP_VERSION };
}

// ---------------------------------------------------------------------------
// Provenance resolution — the ONLY valid way to resolve claim_ids to source docs
// ---------------------------------------------------------------------------

export interface ProvenanceResolution {
  /** Filenames derived from claim_ids via the origin map */
  derivedSources: Set<string>;
  /** Legacy IDs that could not be resolved (ambiguous, no entry in map) */
  unresolvedLegacy: string[];
}

/**
 * Resolve claim_ids to source documents via the origin map.
 *
 * - Global IDs are resolved deterministically from the map.
 * - Legacy IDs are attempted against the map; failures are logged but DO NOT
 *   receive fabricated provenance (no fallback to routed-array position decode).
 *
 * The caller should UNION the derived sources with existing source_docs,
 * never OVERWRITE.
 */
export function resolveProvenance(
  claimIds: string[],
  originMap: ClaimOriginMap,
): ProvenanceResolution {
  const derivedSources = new Set<string>();
  const unresolvedLegacy: string[] = [];

  for (const cid of claimIds) {
    const origin = originMap.entries.get(cid);
    if (origin) {
      derivedSources.add(origin.filename);
    } else if (isLegacyClaimId(cid)) {
      // Legacy ID with no origin entry — ambiguous, do NOT fabricate provenance
      unresolvedLegacy.push(cid);
    }
    // Non-matching IDs (neither global nor legacy format) are ignored
  }

  return { derivedSources, unresolvedLegacy };
}

// ---------------------------------------------------------------------------
// Serialization (for checkpoint persistence)
// ---------------------------------------------------------------------------

export interface SerializedClaimOriginMap {
  version: number;
  entries: ClaimOriginEntry[];
}

export function serializeOriginMap(originMap: ClaimOriginMap): SerializedClaimOriginMap {
  return {
    version: originMap.version,
    entries: [...originMap.entries.values()],
  };
}

/**
 * Deserialize an origin map from a checkpoint payload.
 * Fails closed on duplicate IDs (same rule as build).
 *
 * @throws Error if duplicate claim_ids are detected in persisted data
 */
export function deserializeOriginMap(payload: unknown): ClaimOriginMap {
  if (!payload || typeof payload !== "object") {
    throw new Error("[ClaimOriginMap] Cannot deserialize: payload is not an object");
  }
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) {
    throw new Error("[ClaimOriginMap] Cannot deserialize: entries is not an array");
  }
  const entries = obj.entries as ClaimOriginEntry[];
  return buildClaimOriginMap(entries);
}
