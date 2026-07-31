/**
 * Claim Origin Map — explicit provenance for globally unique claim IDs.
 *
 * Replaces the old approach of parsing "c{routedIdx}-{claimIdx}" into the
 * global routed array. Now every claim carries deterministic provenance:
 *   {documentId}:{chunkIndex}:{claimIndex}
 *
 * The origin map resolves a claim_id to its source document without
 * depending on array position, promise completion order, or filename alone.
 *
 * AMBIGUITY RULE: Legacy IDs that appear in more than one document are
 * tracked in `ambiguousLegacyIds` and receive NO provenance resolution.
 * They are never "first occurrence wins."
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
  /** Map from claim_id → ClaimOrigin (fast lookup) — only unambiguous entries */
  entries: Map<string, ClaimOrigin>;
  /** Legacy IDs observed against multiple distinct documents — unresolvable */
  ambiguousLegacyIds: Set<string>;
  /** Schema version */
  version: number;
}

/** Current schema version for serialized origin maps */
export const CLAIM_ORIGIN_MAP_VERSION = 3;

/**
 * Canonical UUID pattern — the authoritative definition.
 * Must be lowercase hex with dashes: 8-4-4-4-12.
 * Used both for generation validation and parsing.
 */
export const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 *
 * PRODUCTION ONLY — requires a valid canonical UUID as documentId.
 * Use `injectClaimIdsLegacy` for backward-compatible legacy format in tests.
 *
 * @throws Error if documentId is empty/missing or not a canonical UUID
 */
export function generateClaimId(documentId: string, chunkIndex: number, claimIndex: number): string {
  if (!documentId) {
    throw new Error("[ClaimOriginMap] generateClaimId requires a non-empty documentId");
  }
  if (!CANONICAL_UUID_PATTERN.test(documentId)) {
    throw new Error(
      `[ClaimOriginMap] generateClaimId requires a canonical lowercase UUID as documentId. ` +
      `Received: "${documentId.slice(0, 60)}"${documentId.length > 60 ? "..." : ""}`
    );
  }
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
 * Validate that a global claim ID's embedded coordinates agree with its entry.
 * @throws Error on coordinate mismatch
 */
function validateGlobalIdCoordinates(entry: ClaimOriginEntry): void {
  const parsed = parseClaimId(entry.claim_id);
  if (!parsed || parsed.format !== "global") return; // only validate global IDs

  if (parsed.document_id !== entry.document_id) {
    throw new Error(
      `[ClaimOriginMap] Global ID coordinate mismatch: ID "${entry.claim_id}" embeds ` +
      `document_id "${parsed.document_id}" but entry has document_id "${entry.document_id}"`
    );
  }
  if (parsed.chunk_index !== entry.chunk_index) {
    throw new Error(
      `[ClaimOriginMap] Global ID coordinate mismatch: ID "${entry.claim_id}" embeds ` +
      `chunk_index ${parsed.chunk_index} but entry has chunk_index ${entry.chunk_index}`
    );
  }
  if (parsed.claim_index !== entry.claim_index) {
    throw new Error(
      `[ClaimOriginMap] Global ID coordinate mismatch: ID "${entry.claim_id}" embeds ` +
      `claim_index ${parsed.claim_index} but entry has claim_index ${entry.claim_index}`
    );
  }
}

/**
 * Build a ClaimOriginMap from a list of entries.
 * - Global ID duplicates: fail closed (hard error).
 * - Legacy ID duplicates from DIFFERENT documents: marked ambiguous, removed from resolvable entries.
 * - Legacy ID duplicates from the SAME document: deduplicated (same origin, no conflict).
 * - All global IDs are coordinate-validated.
 *
 * @throws Error if duplicate global claim_ids are detected or coordinates mismatch
 */
export function buildClaimOriginMap(entries: ClaimOriginEntry[]): ClaimOriginMap {
  const map = new Map<string, ClaimOrigin>();
  const ambiguousLegacyIds = new Set<string>();

  for (const entry of entries) {
    // Validate global ID coordinates
    if (isGlobalClaimId(entry.claim_id)) {
      validateGlobalIdCoordinates(entry);
    }

    if (map.has(entry.claim_id)) {
      const existing = map.get(entry.claim_id)!;

      if (isGlobalClaimId(entry.claim_id)) {
        // Global ID collision → hard error (non-deterministic extraction)
        throw new Error(
          `[ClaimOriginMap] DUPLICATE global claim_id detected: "${entry.claim_id}" ` +
          `— first from doc "${existing.filename}" chunk ${existing.chunk_index}, ` +
          `duplicate from doc "${entry.filename}" chunk ${entry.chunk_index}. ` +
          `This indicates a non-deterministic extraction bug.`
        );
      }

      // Legacy ID collision
      if (existing.document_id !== entry.document_id) {
        // Different documents → AMBIGUOUS. Remove from resolvable, track as ambiguous.
        map.delete(entry.claim_id);
        ambiguousLegacyIds.add(entry.claim_id);
      }
      // Same document → harmless dedup, skip
      continue;
    }

    // If this ID was previously marked ambiguous, don't re-add it
    if (ambiguousLegacyIds.has(entry.claim_id)) {
      continue;
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

  return { entries: map, ambiguousLegacyIds, version: CLAIM_ORIGIN_MAP_VERSION };
}

/**
 * Build a ClaimOriginMap from the universal_extractions routed array.
 * Scans each extraction's key_claims structurally, falling back to regex for legacy text.
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

    const documentId = ext.documentId ?? row.document_id;
    const filename = idToFileName.get(documentId) ?? ext.sourceFile ?? "unknown";

    // --- Structural parse: prefer key_claims array when available ---
    let structurallyParsed = false;
    const extractionText = ext.extraction ?? "";

    // Try parsing the extraction as JSON (it may be wrapped in markdown headers)
    try {
      // The extraction field often starts with "### Universal Extraction from: ...\n\n"
      // followed by the JSON body. Strip the prefix.
      const jsonStart = extractionText.indexOf("{");
      if (jsonStart >= 0) {
        const jsonBody = extractionText.substring(jsonStart);
        const parsed = JSON.parse(jsonBody);
        if (Array.isArray(parsed.key_claims)) {
          for (let i = 0; i < parsed.key_claims.length; i++) {
            const claim = parsed.key_claims[i];
            const claimId = claim.id;
            if (!claimId || typeof claimId !== "string") continue;

            const location = typeof claim.location === "string" ? claim.location : null;

            if (isGlobalClaimId(claimId)) {
              const parsedId = parseClaimId(claimId)!;
              // Only add if document matches (avoid cross-doc false positives)
              if (parsedId.document_id === documentId) {
                entries.push({
                  claim_id: claimId,
                  document_id: documentId,
                  filename,
                  chunk_index: parsedId.chunk_index,
                  claim_index: parsedId.claim_index,
                  source_page: location,
                });
              }
            } else if (isLegacyClaimId(claimId)) {
              const parsedLegacy = parseClaimId(claimId)!;
              // Legacy IDs: register with this row's document_id
              if (parsedLegacy.chunk_index === row.chunk_index) {
                entries.push({
                  claim_id: claimId,
                  document_id: documentId,
                  filename,
                  chunk_index: parsedLegacy.chunk_index,
                  claim_index: parsedLegacy.claim_index,
                  source_page: location,
                });
              }
            }
          }
          structurallyParsed = true;
        }
      }
    } catch {
      // JSON parse failed — fall through to regex scanning
    }

    // --- Regex fallback: only if structural parse didn't succeed ---
    if (!structurallyParsed) {
      // Scan for new-format IDs: {uuid}:{chunkIdx}:{claimIdx}
      const globalMatches = extractionText.matchAll(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d+)/g
      );
      for (const m of globalMatches) {
        const claimId = m[0];
        const chunkIdx = parseInt(m[2], 10);
        const claimIdx = parseInt(m[3], 10);
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

      // Scan for legacy format IDs: c{N}-{M}
      const legacyMatches = extractionText.matchAll(/\bid["']?\s*:\s*["']c(\d+)-(\d+)["']/g);
      for (const m of legacyMatches) {
        const chunkIdx = parseInt(m[1], 10);
        const claimIdx = parseInt(m[2], 10);
        const legacyId = `c${chunkIdx}-${claimIdx}`;
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
  }

  const result = buildClaimOriginMap(entries);

  if (result.ambiguousLegacyIds.size > 0) {
    const ids = [...result.ambiguousLegacyIds].slice(0, 5);
    console.warn(
      `[ClaimOriginMap] ${result.ambiguousLegacyIds.size} legacy claim ID(s) are ambiguous ` +
      `(observed in multiple documents — no provenance derived): ${ids.join(", ")}` +
      (result.ambiguousLegacyIds.size > 5 ? ` and ${result.ambiguousLegacyIds.size - 5} more` : "")
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Provenance resolution — the ONLY valid way to resolve claim_ids to source docs
// ---------------------------------------------------------------------------

export interface ProvenanceResolution {
  /** Filenames derived from claim_ids via the origin map */
  derivedSources: Set<string>;
  /** Legacy IDs that could not be resolved (ambiguous or no entry in map) */
  unresolvedLegacy: string[];
}

/**
 * Resolve claim_ids to source documents via the origin map.
 *
 * - Global IDs are resolved deterministically from the map.
 * - Legacy IDs in the ambiguous set are returned as unresolved.
 * - Legacy IDs not in the map are returned as unresolved.
 * - Legacy IDs uniquely resolvable (one document) are resolved as a compatibility behavior.
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
    // Ambiguous legacy IDs are NEVER resolved
    if (originMap.ambiguousLegacyIds.has(cid)) {
      unresolvedLegacy.push(cid);
      continue;
    }

    const origin = originMap.entries.get(cid);
    if (origin) {
      derivedSources.add(origin.filename);
    } else if (isLegacyClaimId(cid)) {
      // Legacy ID with no origin entry — unresolved
      unresolvedLegacy.push(cid);
    }
    // Non-matching IDs (neither global nor legacy format) are ignored
  }

  return { derivedSources, unresolvedLegacy };
}

// ---------------------------------------------------------------------------
// Serialization (for checkpoint persistence)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Source Fingerprint — ties the map to the extraction generation that produced it
// ---------------------------------------------------------------------------

export interface OriginMapFingerprint {
  /** Sorted list of document IDs in the routed array */
  documentIds: string[];
  /** Total number of chunks (length of routed array) */
  chunkCount: number;
  /** Pipeline version hash when the map was built */
  pipelineVersion: string;
  /** Schema version of the origin map */
  schemaVersion: number;
}

/**
 * Compute a fingerprint for the current extraction generation.
 * Used to detect stale persisted maps after re-extraction.
 */
export function computeOriginMapFingerprint(
  routed: Array<{ document_id: string; chunk_index: number }>,
  pipelineVersion: string,
): OriginMapFingerprint {
  const docIds = [...new Set(routed.map((r) => r.document_id))].sort();
  return {
    documentIds: docIds,
    chunkCount: routed.length,
    pipelineVersion,
    schemaVersion: CLAIM_ORIGIN_MAP_VERSION,
  };
}

/**
 * Compare two fingerprints. Returns null if they match,
 * or a human-readable mismatch description.
 */
export function compareFingerprints(
  expected: OriginMapFingerprint,
  actual: OriginMapFingerprint,
): string | null {
  if (expected.schemaVersion !== actual.schemaVersion) {
    return `schemaVersion mismatch: expected ${expected.schemaVersion}, got ${actual.schemaVersion}`;
  }
  if (expected.pipelineVersion !== actual.pipelineVersion) {
    return `pipelineVersion mismatch: expected "${expected.pipelineVersion}", got "${actual.pipelineVersion}"`;
  }
  if (expected.chunkCount !== actual.chunkCount) {
    return `chunkCount mismatch: expected ${expected.chunkCount}, got ${actual.chunkCount}`;
  }
  if (expected.documentIds.length !== actual.documentIds.length) {
    return `documentIds count mismatch: expected ${expected.documentIds.length}, got ${actual.documentIds.length}`;
  }
  for (let i = 0; i < expected.documentIds.length; i++) {
    if (expected.documentIds[i] !== actual.documentIds[i]) {
      return `documentIds diverge at index ${i}: expected "${expected.documentIds[i]}", got "${actual.documentIds[i]}"`;
    }
  }
  return null;
}

export interface SerializedClaimOriginMap {
  version: number;
  entries: ClaimOriginEntry[];
  ambiguousLegacyIds: string[];
  /** Source fingerprint — ties the map to the extraction generation */
  fingerprint: OriginMapFingerprint | null;
}

/**
 * Serialize an origin map for checkpoint persistence.
 * @param fingerprint The source fingerprint to embed (from computeOriginMapFingerprint)
 */
export function serializeOriginMap(
  originMap: ClaimOriginMap,
  fingerprint?: OriginMapFingerprint,
): SerializedClaimOriginMap {
  return {
    version: originMap.version,
    entries: [...originMap.entries.values()],
    ambiguousLegacyIds: [...originMap.ambiguousLegacyIds],
    fingerprint: fingerprint ?? null,
  };
}

/**
 * Deserialize an origin map from a checkpoint payload.
 * Fail-closed validation:
 *   - Rejects unsupported versions
 *   - Rejects malformed structure
 *   - Rejects duplicate global IDs
 *   - Rejects global ID coordinate mismatches
 *   - Preserves ambiguous legacy ID set
 *   - Optionally verifies source fingerprint
 *
 * @param payload The raw JSON-parsed checkpoint payload
 * @param expectedFingerprint If provided, the stored fingerprint must match or an error is thrown
 * @throws Error on any validation failure (corrupt payload, stale fingerprint, etc.)
 */
export function deserializeOriginMap(
  payload: unknown,
  expectedFingerprint?: OriginMapFingerprint,
): ClaimOriginMap {
  if (!payload || typeof payload !== "object") {
    throw new Error("[ClaimOriginMap] Cannot deserialize: payload is not an object");
  }
  const obj = payload as Record<string, unknown>;

  // Version check
  const version = obj.version;
  if (typeof version !== "number" || version < 1 || version > CLAIM_ORIGIN_MAP_VERSION) {
    throw new Error(
      `[ClaimOriginMap] Unsupported origin map version: ${version} ` +
      `(supported: 1-${CLAIM_ORIGIN_MAP_VERSION})`
    );
  }

  if (!Array.isArray(obj.entries)) {
    throw new Error("[ClaimOriginMap] Cannot deserialize: entries is not an array");
  }

  // Validate each entry has required fields
  const entries = obj.entries as ClaimOriginEntry[];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: not an object`);
    }
    if (typeof e.claim_id !== "string" || !e.claim_id) {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: missing claim_id`);
    }
    if (typeof e.document_id !== "string" || !e.document_id) {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: missing document_id`);
    }
    if (typeof e.filename !== "string") {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: missing filename`);
    }
    if (typeof e.chunk_index !== "number") {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: missing chunk_index`);
    }
    if (typeof e.claim_index !== "number") {
      throw new Error(`[ClaimOriginMap] Malformed entry at index ${i}: missing claim_index`);
    }
  }

  // Fingerprint verification (if expected fingerprint is provided)
  if (expectedFingerprint) {
    const storedFingerprint = (obj as Record<string, unknown>).fingerprint as OriginMapFingerprint | null | undefined;
    if (!storedFingerprint) {
      throw new Error(
        `[ClaimOriginMap] Stale checkpoint: persisted map has no fingerprint but current extraction requires one. ` +
        `The map must be rebuilt from the current extraction generation.`
      );
    }
    const mismatch = compareFingerprints(expectedFingerprint, storedFingerprint);
    if (mismatch) {
      throw new Error(
        `[ClaimOriginMap] Stale checkpoint: fingerprint mismatch (${mismatch}). ` +
        `The persisted map belongs to a different extraction generation and cannot be reused.`
      );
    }
  }

  // Restore ambiguous legacy IDs
  const ambiguousArr = Array.isArray(obj.ambiguousLegacyIds)
    ? (obj.ambiguousLegacyIds as string[])
    : [];

  // Build the map (validates duplicates + coordinates)
  const map = buildClaimOriginMap(entries);

  // Merge the persisted ambiguous set into the rebuilt one
  for (const aid of ambiguousArr) {
    map.ambiguousLegacyIds.add(aid);
    // Ensure ambiguous IDs are NOT in entries
    map.entries.delete(aid);
  }

  return map;
}
