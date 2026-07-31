/**
 * Source Snapshot — unified, versioned source-state identity for all checkpoints.
 *
 * Produces a single deterministic, run-level snapshot covering every relevant
 * document and its processing metadata. Consumed by ALL checkpoint validators:
 *   - extraction-phase (chunk-content hash + prompt version)
 *   - analysis checkpoints (extraction content hash + analysis prompt version)
 *   - doc_tables (parsed_text hash + parser version + generation record)
 *   - numeric checkpoint (document set + indexed table metadata)
 *   - claim-origin map (extraction snapshot identity)
 *   - merge-root manifest (leaf set + source fingerprint)
 *
 * Design principles:
 *   1. One canonical ordering → one deterministic hash. No per-phase reinvention.
 *   2. Granular: changed document invalidates ONLY its downstream stages.
 *   3. Versioned: structural schema changes bump SOURCE_SNAPSHOT_VERSION.
 *   4. Cheap: FNV-1a hash (no crypto dependency — runs in Vite bundle).
 *
 * Version history:
 *   v1: Initial unified snapshot (Fix 5)
 */
import { getPipelineVersion } from "./pipeline-version.js";
import { computeContentHash, CHUNK_CHARS, EXTRACTION_MODEL } from "./extraction-prompt.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const SOURCE_SNAPSHOT_VERSION = 1;

/** Parser version for doc_tables CSV/spreadsheet parsing.
 *  Bump when parsedTextToTables logic changes. */
export const DOC_TABLES_PARSER_VERSION = "1.0.0";

/** Extraction chunking version. Bump when CHUNK_CHARS or chunk algorithm changes. */
export const CHUNKING_VERSION = `chunk-${CHUNK_CHARS}`;

// ---------------------------------------------------------------------------
// Deterministic hash (FNV-1a, same as other pipeline modules)
// ---------------------------------------------------------------------------

function fnvHash(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Document Entry — per-document metadata for the snapshot
// ---------------------------------------------------------------------------

export interface DocumentEntry {
  /** Document UUID */
  documentId: string;
  /** Content hash of parsed_text (stable across reads if content unchanged) */
  contentHash: string;
  /** Document type/file type (e.g. "application/pdf", "spreadsheet") */
  documentType: string;
  /** Source role/tag (e.g. "ic_memo", "financial_model", "cim") */
  sourceTag: string | null;
  /** Number of chunks this document produces */
  chunkCount: number;
}

/** Per-chunk metadata for extraction invalidation */
export interface ChunkEntry {
  documentId: string;
  chunkIndex: number;
  /** Content hash of this specific chunk's text */
  contentHash: string;
}

/** Doc-tables generation record for atomicity proof */
export interface TableGenerationRecord {
  documentId: string;
  /** Hash of the source parsed_text used for table parsing */
  sourceHash: string;
  /** Parser version used */
  parserVersion: string;
  /** Generation ID (monotonically increasing per document) */
  generationId: number;
  /** Expected table count (from parsing) */
  expectedTableCount: number;
  /** Actual table count (rows persisted) */
  actualTableCount: number;
  /** Explicit completion status */
  status: "complete" | "partial" | "failed";
}

// ---------------------------------------------------------------------------
// Source Snapshot — the unified identity object
// ---------------------------------------------------------------------------

export interface SourceSnapshot {
  version: typeof SOURCE_SNAPSHOT_VERSION;
  /** Overall run-level fingerprint (deterministic hash of all document entries) */
  fingerprint: string;
  /** Per-document entries */
  documents: DocumentEntry[];
  /** Pipeline/prompt version at snapshot time */
  pipelineVersion: string;
  /** Extraction model identifier */
  extractionModel: string;
  /** Chunking version */
  chunkingVersion: string;
  /** Doc-tables parser version */
  docTablesParserVersion: string;
  /** ISO timestamp of snapshot creation */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Snapshot Construction
// ---------------------------------------------------------------------------

export interface BuildSnapshotInput {
  documents: Array<{
    id: string;
    contentHash: string;
    documentType: string;
    sourceTag: string | null;
    chunkCount: number;
  }>;
}

/**
 * Build a source snapshot from the current document set.
 * Documents are sorted by ID for determinism.
 */
export function buildSourceSnapshot(input: BuildSnapshotInput): SourceSnapshot {
  const entries: DocumentEntry[] = input.documents
    .map(d => ({
      documentId: d.id,
      contentHash: d.contentHash,
      documentType: d.documentType,
      sourceTag: d.sourceTag,
      chunkCount: d.chunkCount,
    }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId));

  const fingerprint = computeSnapshotFingerprint(entries);

  return {
    version: SOURCE_SNAPSHOT_VERSION,
    fingerprint,
    documents: entries,
    pipelineVersion: getPipelineVersion(),
    extractionModel: EXTRACTION_MODEL,
    chunkingVersion: CHUNKING_VERSION,
    docTablesParserVersion: DOC_TABLES_PARSER_VERSION,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Compute the overall snapshot fingerprint from sorted document entries.
 * Incorporates document ID, content hash, type, tag, chunk count, and processing versions.
 */
export function computeSnapshotFingerprint(documents: DocumentEntry[]): string {
  const parts = documents.map(d =>
    `${d.documentId}|${d.contentHash}|${d.documentType}|${d.sourceTag ?? "null"}|${d.chunkCount}`
  );
  // Include processing versions so prompt/config changes invalidate
  parts.push(`pipeline:${getPipelineVersion()}`);
  parts.push(`model:${EXTRACTION_MODEL}`);
  parts.push(`chunking:${CHUNKING_VERSION}`);
  parts.push(`parser:${DOC_TABLES_PARSER_VERSION}`);
  return fnvHash(parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Per-Document Fingerprint (granular invalidation)
// ---------------------------------------------------------------------------

/**
 * Compute a document-level fingerprint for targeted invalidation.
 * Includes content hash + processing versions so any change to the
 * document's content OR the extraction/analysis configuration invalidates
 * only that document's downstream work.
 */
export function computeDocumentFingerprint(doc: DocumentEntry): string {
  const payload = [
    doc.documentId,
    doc.contentHash,
    doc.documentType,
    doc.sourceTag ?? "null",
    String(doc.chunkCount),
    getPipelineVersion(),
    EXTRACTION_MODEL,
    CHUNKING_VERSION,
  ].join("|");
  return fnvHash(payload);
}

/**
 * Compute a chunk-level fingerprint for extraction invalidation.
 * Invalidates when chunk content OR extraction prompt version changes.
 */
export function computeChunkFingerprint(chunk: ChunkEntry): string {
  const payload = [
    chunk.documentId,
    String(chunk.chunkIndex),
    chunk.contentHash,
    getPipelineVersion(),
    EXTRACTION_MODEL,
    CHUNKING_VERSION,
  ].join("|");
  return fnvHash(payload);
}

/**
 * Compute a table-generation fingerprint for doc_tables invalidation.
 * Requires matching content hash + parser version.
 */
export function computeTableGenerationFingerprint(
  documentId: string,
  sourceHash: string,
): string {
  const payload = [
    documentId,
    sourceHash,
    DOC_TABLES_PARSER_VERSION,
  ].join("|");
  return fnvHash(payload);
}

// ---------------------------------------------------------------------------
// Snapshot Validation
// ---------------------------------------------------------------------------

export type SnapshotValidationResult =
  | { valid: true; snapshot: SourceSnapshot }
  | { valid: false; action: "invalidate" | "error"; reason: string };

/**
 * Validate a persisted snapshot against the current document set.
 *
 * Returns valid=true only when:
 *   - Version matches
 *   - All current documents are present in the snapshot
 *   - Content hashes match (no document changed)
 *   - Processing versions match (no config drift)
 *
 * A changed document returns action="invalidate" (recoverable: rebuild affected stages).
 * A structurally corrupt snapshot returns action="error" (fail-closed).
 */
export function validateSourceSnapshot(
  raw: unknown,
  currentDocuments: BuildSnapshotInput["documents"]
): SnapshotValidationResult {
  if (!raw || typeof raw !== "object") {
    return { valid: false, action: "invalidate", reason: "Missing or null snapshot" };
  }

  const snap = raw as Record<string, unknown>;

  // Version check
  if (snap.version !== SOURCE_SNAPSHOT_VERSION) {
    return {
      valid: false,
      action: "invalidate",
      reason: `Version mismatch: stored=${snap.version}, current=${SOURCE_SNAPSHOT_VERSION}`,
    };
  }

  // Structural checks
  if (!Array.isArray(snap.documents) || typeof snap.fingerprint !== "string") {
    return { valid: false, action: "error", reason: "Missing required fields (documents, fingerprint)" };
  }

  const stored = snap as unknown as SourceSnapshot;

  // Processing version checks
  if (stored.pipelineVersion !== getPipelineVersion()) {
    return {
      valid: false,
      action: "invalidate",
      reason: `Pipeline version changed: stored=${stored.pipelineVersion.slice(0, 8)}, current=${getPipelineVersion().slice(0, 8)}`,
    };
  }
  if (stored.extractionModel !== EXTRACTION_MODEL) {
    return {
      valid: false,
      action: "invalidate",
      reason: `Extraction model changed: stored=${stored.extractionModel}, current=${EXTRACTION_MODEL}`,
    };
  }
  if (stored.chunkingVersion !== CHUNKING_VERSION) {
    return {
      valid: false,
      action: "invalidate",
      reason: `Chunking version changed: stored=${stored.chunkingVersion}, current=${CHUNKING_VERSION}`,
    };
  }
  if (stored.docTablesParserVersion !== DOC_TABLES_PARSER_VERSION) {
    return {
      valid: false,
      action: "invalidate",
      reason: `Doc-tables parser version changed: stored=${stored.docTablesParserVersion}, current=${DOC_TABLES_PARSER_VERSION}`,
    };
  }

  // Document-level validation: every current document must be in the snapshot with matching content
  const storedMap = new Map(stored.documents.map(d => [d.documentId, d]));

  for (const current of currentDocuments) {
    const storedDoc = storedMap.get(current.id);
    if (!storedDoc) {
      return {
        valid: false,
        action: "invalidate",
        reason: `New document not in snapshot: ${current.id.slice(0, 8)}`,
      };
    }
    if (storedDoc.contentHash !== current.contentHash) {
      return {
        valid: false,
        action: "invalidate",
        reason: `Content hash changed for document ${current.id.slice(0, 8)}: stored=${storedDoc.contentHash}, current=${current.contentHash}`,
      };
    }
    if (storedDoc.chunkCount !== current.chunkCount) {
      return {
        valid: false,
        action: "invalidate",
        reason: `Chunk count changed for document ${current.id.slice(0, 8)}: stored=${storedDoc.chunkCount}, current=${current.chunkCount}`,
      };
    }
  }

  // Check for documents removed from the deal
  for (const storedDoc of stored.documents) {
    if (!currentDocuments.find(d => d.id === storedDoc.documentId)) {
      return {
        valid: false,
        action: "invalidate",
        reason: `Document removed from deal: ${storedDoc.documentId.slice(0, 8)}`,
      };
    }
  }

  // Fingerprint cross-check (redundant with above but catches corruption)
  const recomputed = computeSnapshotFingerprint(stored.documents);
  if (stored.fingerprint !== recomputed) {
    return {
      valid: false,
      action: "error",
      reason: `Fingerprint mismatch (possible corruption): stored=${stored.fingerprint.slice(0, 8)}, recomputed=${recomputed.slice(0, 8)}`,
    };
  }

  return { valid: true, snapshot: stored };
}

// ---------------------------------------------------------------------------
// Granular Document Change Detection
// ---------------------------------------------------------------------------

export interface DocumentChangeSet {
  /** Documents that changed content, chunk count, or were added */
  invalidated: string[];
  /** Documents that are unchanged and can reuse work */
  reusable: string[];
  /** Documents that were removed from the deal */
  removed: string[];
}

/**
 * Compare a stored snapshot against the current document set to find
 * which documents changed. Used for targeted invalidation:
 * only the affected document's extractions/analysis/tables are rebuilt.
 */
export function computeDocumentChangeSet(
  storedSnapshot: SourceSnapshot | null,
  currentDocuments: BuildSnapshotInput["documents"]
): DocumentChangeSet {
  if (!storedSnapshot) {
    // No stored snapshot → everything is new
    return {
      invalidated: currentDocuments.map(d => d.id),
      reusable: [],
      removed: [],
    };
  }

  const storedMap = new Map(storedSnapshot.documents.map(d => [d.documentId, d]));
  const currentIds = new Set(currentDocuments.map(d => d.id));

  const invalidated: string[] = [];
  const reusable: string[] = [];

  for (const current of currentDocuments) {
    const stored = storedMap.get(current.id);
    if (!stored) {
      invalidated.push(current.id);
    } else if (
      stored.contentHash !== current.contentHash ||
      stored.chunkCount !== current.chunkCount
    ) {
      invalidated.push(current.id);
    } else {
      reusable.push(current.id);
    }
  }

  const removed = storedSnapshot.documents
    .filter(d => !currentIds.has(d.documentId))
    .map(d => d.documentId);

  return { invalidated, reusable, removed };
}

// ---------------------------------------------------------------------------
// Subject Selection Record — persisted run identity (Fix 3 follow-up)
// ---------------------------------------------------------------------------

export interface SubjectSelectionRecord {
  /** Document IDs selected as subjects for this run */
  subjectIds: string[];
  /** Source snapshot fingerprint at the time of selection */
  snapshotFingerprint: string;
  /** Selection criteria used (e.g. "ic_memo" tag filter) */
  selectionCriteria: string;
  /** ISO timestamp of selection */
  selectedAt: string;
}

/**
 * Build a subject selection record to persist with the run.
 */
export function buildSubjectSelectionRecord(
  subjectIds: string[],
  snapshotFingerprint: string,
  criteria: string,
): SubjectSelectionRecord {
  return {
    subjectIds: [...subjectIds].sort(),
    snapshotFingerprint,
    selectionCriteria: criteria,
    selectedAt: new Date().toISOString(),
  };
}

/**
 * Validate a persisted subject selection against the current snapshot.
 * Returns true if the selection is still valid (same snapshot, same subjects still exist).
 */
export function validateSubjectSelection(
  record: SubjectSelectionRecord | null | undefined,
  currentSnapshotFingerprint: string,
  currentDocumentIds: string[],
): { valid: boolean; reason?: string } {
  if (!record) {
    return { valid: false, reason: "No persisted subject selection (first run)" };
  }
  if (record.snapshotFingerprint !== currentSnapshotFingerprint) {
    return { valid: false, reason: "Source snapshot changed since subject selection" };
  }
  // Verify all selected subjects still exist in the current document set
  const currentSet = new Set(currentDocumentIds);
  for (const subjectId of record.subjectIds) {
    if (!currentSet.has(subjectId)) {
      return { valid: false, reason: `Subject document removed: ${subjectId.slice(0, 8)}` };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Table Generation Validation (Fix 5 — doc_tables atomicity)
// ---------------------------------------------------------------------------

/**
 * Validate a table generation record for a document.
 * Returns true only when the generation completed successfully with matching source.
 */
export function validateTableGeneration(
  record: TableGenerationRecord | null | undefined,
  currentSourceHash: string,
): { valid: boolean; reason?: string } {
  if (!record) {
    return { valid: false, reason: "No generation record (tables not yet parsed)" };
  }
  if (record.status !== "complete") {
    return { valid: false, reason: `Generation status is ${record.status}, not complete` };
  }
  if (record.sourceHash !== currentSourceHash) {
    return { valid: false, reason: "Source content changed since table generation" };
  }
  if (record.parserVersion !== DOC_TABLES_PARSER_VERSION) {
    return { valid: false, reason: `Parser version changed: stored=${record.parserVersion}, current=${DOC_TABLES_PARSER_VERSION}` };
  }
  if (record.expectedTableCount !== record.actualTableCount) {
    return { valid: false, reason: `Table count mismatch: expected=${record.expectedTableCount}, actual=${record.actualTableCount}` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Re-export content hash utility
// ---------------------------------------------------------------------------

export { computeContentHash };
