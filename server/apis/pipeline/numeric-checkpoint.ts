/**
 * Numeric Verification Checkpoint — resumable cursor for numeric-verify-inline.
 *
 * Ensures partial numeric verification runs accumulate results across invocations
 * rather than restarting from zero each time. The checkpoint persists:
 *   - explicit status (partial | complete)
 *   - ordered document and table cursors
 *   - accumulated figures and discrepancies
 *   - accumulated table-index metadata (so resume skips already-indexed documents)
 *   - processed/pending counts
 *   - source fingerprint for invalidation on model changes
 *   - config version for detecting schema drift
 *
 * Only `status: complete` satisfies the numeric resume gate.
 *
 * Fingerprint semantics (v2 — Fix 4 corrective):
 *   The source fingerprint covers documentIds (the full ordered universe from the
 *   DB query — always complete) and the ACCUMULATED table index (grows monotonically
 *   as new documents are indexed). Validation distinguishes:
 *     - Known prefix changed (a table in the already-indexed portion was added/removed
 *       or a document was removed) → invalidate.
 *     - New documents/tables discovered during forward progress → valid (the checkpoint's
 *       prefix is still correct; the universe grew beyond it).
 */
import { getPipelineVersion } from "./pipeline-version.js";

// ---------------------------------------------------------------------------
// Version — bump on structural schema change
// ---------------------------------------------------------------------------

export const NUMERIC_CHECKPOINT_VERSION = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight table-index entry stored in the checkpoint for resumability. */
export interface IndexedTableEntry {
  id: string;
  document_id: string;
  sheet_or_page: string;
  caption: string | null;
  data_length: number;
}

export interface NumericCheckpoint {
  version: typeof NUMERIC_CHECKPOINT_VERSION;
  status: "partial" | "complete";
  /** Full ordered document ID universe (from DB query — always complete) */
  documentIds: string[];
  /** Accumulated table-index metadata for documents 0..documentCursor-1 */
  indexedTableMetadata: IndexedTableEntry[];
  /** Cursor: index into documentIds of the first UNPROCESSED document for indexing */
  documentCursor: number;
  /** Cursor: index into loadable tables of the first UNPROCESSED table for data loading */
  tableCursor: number;
  /** Accumulated figures from all processed documents/tables so far */
  figures: SerializedFigure[];
  /** Accumulated discrepancies from all processed tables so far */
  discrepancies: SerializedDiscrepancy[];
  /** Count of documents whose index metadata is fully loaded */
  documentsProcessed: number;
  /** Total document count in the universe */
  documentsTotal: number;
  /** Count of tables whose data has been loaded and processed */
  tablesLoaded: number;
  /** Total table count in the loadable universe (may grow as indexing progresses) */
  tablesTotal: number;
  /**
   * Source fingerprint: hash of documentIds + indexedTableMetadata IDs.
   * Covers the KNOWN prefix. New tables from unindexed documents don't affect it.
   */
  sourceFingerprint: string;
  /** Pipeline version at checkpoint creation */
  pipelineVersion: string;
  /** Numeric config version (changes when metric config or cross-agreement config changes) */
  configVersion: string;
  /**
   * Unified source-snapshot fingerprint (Fix 5).
   * Cross-references the run-level SourceSnapshot to detect document set changes
   * that the local sourceFingerprint (doc+table prefix) might miss.
   * Optional for backward compatibility with v2 checkpoints written before Fix 5.
   */
  snapshotFingerprint?: string;
  /** ISO timestamp when the checkpoint was last written */
  lastUpdated: string;
  /** Cross-agreement debug from last invocation (if any) */
  crossAgreementDebug?: any;
}

/** Serialized figure (matches NumericVerifyResult.Figure shape) */
export interface SerializedFigure {
  name: string;
  period: string;
  value: number;
  source_doc: string;
  source_cell: string;
  source_sheet: string;
}

/** Serialized discrepancy (matches NumericVerifyResult.Discrepancy shape) */
export interface SerializedDiscrepancy {
  description: string;
  severity: "critical" | "warning" | "info";
  check_type: "cross_doc_agreement";
  sources: string[];
  period: string;
  headline: string;
  materialityFloor: { abs: number; rel: number };
  /**
   * Actual/forecast qualifiers of the two compared columns. Optional because
   * checkpoints written before qualified cross-agreement matching lack them.
   */
  qualifierA?: string;
  qualifierB?: string;
  metrics: Array<{
    label: string;
    sourceA: number;
    sourceB: number;
    absDiff: number;
    relDiffPct: number;
    tier: "material" | "detail";
    isAggregate: boolean;
    isDuplicateLabel: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Simple deterministic hash (FNV-1a variant → hex).
 * NOT cryptographic — used solely for change-detection.
 */
function deterministicHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x811c9dc5);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c2 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
  const d = ((h1 + h2) >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}${c2}${d}`;
}

/**
 * Compute source fingerprint from the document universe and the accumulated
 * indexed table entries. The fingerprint covers:
 *   - The full document ID list (always queried fresh — detects doc additions/removals)
 *   - The table IDs from already-indexed documents (detects table changes in known prefix)
 *
 * IMPORTANT: This fingerprint grows monotonically as more documents are indexed.
 * Validation logic accounts for this — see validateNumericCheckpoint.
 */
export function computeNumericSourceFingerprint(
  documentIds: string[],
  indexedTableIds: string[]
): string {
  // Document IDs sorted for order-independence of the DB query
  const docPart = [...documentIds].sort().join("|");
  // Table IDs sorted — represents the known indexed prefix
  const tablePart = [...indexedTableIds].sort().join("|");
  return deterministicHash(docPart + "||" + tablePart);
}

/**
 * Compute config version from the numeric verification configuration.
 * Changes when metric patterns, cross-agreement thresholds, or structural
 * parameters are modified.
 */
export function computeNumericConfigVersion(): string {
  const NUMERIC_CONFIG_REVISION = "2026-07-31-r2";
  return `${getPipelineVersion()}:${NUMERIC_CONFIG_REVISION}`;
}

// ---------------------------------------------------------------------------
// Building checkpoints
// ---------------------------------------------------------------------------

export interface BuildCheckpointInput {
  status: "partial" | "complete";
  documentIds: string[];
  indexedTableMetadata: IndexedTableEntry[];
  documentCursor: number;
  tableCursor: number;
  figures: SerializedFigure[];
  discrepancies: SerializedDiscrepancy[];
  documentsProcessed: number;
  documentsTotal: number;
  tablesLoaded: number;
  tablesTotal: number;
  crossAgreementDebug?: any;
  /** Unified source-snapshot fingerprint for cross-validation (Fix 5) */
  snapshotFingerprint?: string;
}

/**
 * Build a numeric checkpoint from the current state of verification.
 */
export function buildNumericCheckpoint(input: BuildCheckpointInput): NumericCheckpoint {
  const indexedTableIds = input.indexedTableMetadata.map(t => t.id);
  const sourceFingerprint = computeNumericSourceFingerprint(input.documentIds, indexedTableIds);
  const checkpoint: NumericCheckpoint = {
    version: NUMERIC_CHECKPOINT_VERSION,
    status: input.status,
    documentIds: input.documentIds,
    indexedTableMetadata: input.indexedTableMetadata,
    documentCursor: input.documentCursor,
    tableCursor: input.tableCursor,
    figures: input.figures,
    discrepancies: input.discrepancies,
    documentsProcessed: input.documentsProcessed,
    documentsTotal: input.documentsTotal,
    tablesLoaded: input.tablesLoaded,
    tablesTotal: input.tablesTotal,
    sourceFingerprint,
    pipelineVersion: getPipelineVersion(),
    configVersion: computeNumericConfigVersion(),
    lastUpdated: new Date().toISOString(),
    crossAgreementDebug: input.crossAgreementDebug,
  };
  if (input.snapshotFingerprint) {
    checkpoint.snapshotFingerprint = input.snapshotFingerprint;
  }
  return checkpoint;
}

// ---------------------------------------------------------------------------
// Validation & deserialization
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { valid: true; checkpoint: NumericCheckpoint }
  | { valid: false; reason: string; action: "invalidate" | "error" };

/**
 * Validate a loaded numeric checkpoint against the current source state.
 *
 * Validation strategy (v2 — distinguishes prefix-change from forward progress):
 *   1. Schema version must match.
 *   2. Config version must match.
 *   3. Structural fields must be present and well-typed.
 *   4. Document universe check:
 *      - The checkpoint's documentIds (positions 0..documentCursor-1) must match
 *        the same positions in the current documentIds.
 *      - Documents cannot be removed or reordered in the known prefix without invalidation.
 *      - New documents at the END of the current list are fine (forward progress).
 *   5. Indexed table prefix check:
 *      - If the caller provides prefixTableIds (re-queried table IDs for documents
 *        0..documentCursor-1), every table ID in the checkpoint's indexedTableMetadata
 *        must still be present. A missing table means the source data changed.
 */
export function validateNumericCheckpoint(
  raw: unknown,
  currentDocumentIds: string[],
  /** Table IDs from documents 0..checkpoint.documentCursor-1 (re-queried prefix) */
  prefixTableIds?: string[],
  /** Current source-snapshot fingerprint for cross-validation (Fix 5) */
  currentSnapshotFingerprint?: string
): ValidateResult {
  if (!raw || typeof raw !== "object") {
    return { valid: false, reason: "Checkpoint is null or not an object", action: "invalidate" };
  }

  const obj = raw as Record<string, unknown>;

  // Version check — v1 checkpoints are incompatible (no indexedTableMetadata)
  if (obj.version !== NUMERIC_CHECKPOINT_VERSION) {
    return { valid: false, reason: `Checkpoint version ${obj.version} !== ${NUMERIC_CHECKPOINT_VERSION}. Requires rebuild.`, action: "invalidate" };
  }

  // Status check
  if (obj.status !== "partial" && obj.status !== "complete") {
    return { valid: false, reason: `Invalid status: ${obj.status}`, action: "error" };
  }

  // Required fields
  const required = ["documentIds", "indexedTableMetadata", "documentCursor", "tableCursor",
    "figures", "discrepancies", "documentsProcessed", "documentsTotal", "tablesLoaded",
    "tablesTotal", "sourceFingerprint", "pipelineVersion", "configVersion"];
  for (const field of required) {
    if (!(field in obj)) {
      return { valid: false, reason: `Missing required field: ${field}`, action: "error" };
    }
  }

  // Type validation for cursors
  if (typeof obj.documentCursor !== "number" || typeof obj.tableCursor !== "number") {
    return { valid: false, reason: "Cursors must be numbers", action: "error" };
  }

  if (!Array.isArray(obj.figures) || !Array.isArray(obj.discrepancies)) {
    return { valid: false, reason: "figures and discrepancies must be arrays", action: "error" };
  }

  if (!Array.isArray(obj.documentIds) || !Array.isArray(obj.indexedTableMetadata)) {
    return { valid: false, reason: "documentIds and indexedTableMetadata must be arrays", action: "error" };
  }

  // Config version — invalidate if config changed
  const currentConfigVersion = computeNumericConfigVersion();
  if (obj.configVersion !== currentConfigVersion) {
    return {
      valid: false,
      reason: `Config version mismatch: checkpoint=${obj.configVersion}, current=${currentConfigVersion}. Numeric configuration changed.`,
      action: "invalidate",
    };
  }

  const cpDocIds = obj.documentIds as string[];
  const cpDocCursor = obj.documentCursor as number;

  // Document universe prefix check:
  // Every document in the checkpoint's processed prefix (0..documentCursor-1)
  // must appear in the same position in the current document list.
  for (let i = 0; i < Math.min(cpDocIds.length, cpDocCursor); i++) {
    if (i >= currentDocumentIds.length || currentDocumentIds[i] !== cpDocIds[i]) {
      return {
        valid: false,
        reason: `Document at position ${i} changed: checkpoint="${cpDocIds[i]}", current="${currentDocumentIds[i] ?? "<missing>"}"`,
        action: "invalidate",
      };
    }
  }

  // If the current universe has FEWER documents than the checkpoint's full list, invalidate
  // (documents were removed)
  if (cpDocIds.length > currentDocumentIds.length) {
    return {
      valid: false,
      reason: `Document universe shrunk: checkpoint had ${cpDocIds.length} docs, current has ${currentDocumentIds.length}`,
      action: "invalidate",
    };
  }

  // Indexed table prefix check (if caller provided re-queried prefix table IDs)
  if (prefixTableIds !== undefined) {
    const cpIndexedIds = (obj.indexedTableMetadata as IndexedTableEntry[]).map(t => t.id);
    const currentPrefixSet = new Set(prefixTableIds);
    // Every table the checkpoint claims to have indexed must still exist
    for (const tableId of cpIndexedIds) {
      if (!currentPrefixSet.has(tableId)) {
        return {
          valid: false,
          reason: `Table ${tableId.slice(0, 8)} from indexed prefix no longer exists. Source data changed.`,
          action: "invalidate",
        };
      }
    }
  }

  // Snapshot fingerprint cross-check (Fix 5): if both the checkpoint and the
  // caller supply a snapshot fingerprint, they must agree. A mismatch means
  // the run-level document set changed in a way the local doc-prefix check might miss.
  if (currentSnapshotFingerprint && typeof obj.snapshotFingerprint === "string") {
    if (obj.snapshotFingerprint !== currentSnapshotFingerprint) {
      return {
        valid: false,
        reason: `Snapshot fingerprint mismatch: checkpoint=${(obj.snapshotFingerprint as string).slice(0, 8)}, current=${currentSnapshotFingerprint.slice(0, 8)}. Source snapshot changed.`,
        action: "invalidate",
      };
    }
  }

  return { valid: true, checkpoint: obj as unknown as NumericCheckpoint };
}

/**
 * Check if a checkpoint represents a complete result that can be used directly.
 * Only status=complete is accepted — partial results must be resumed.
 */
export function isCheckpointComplete(checkpoint: NumericCheckpoint): boolean {
  return checkpoint.status === "complete";
}

/**
 * Determine the resume position from a partial checkpoint.
 * Returns cursor positions, accumulated data, AND accumulated table-index metadata.
 */
export function getResumePosition(checkpoint: NumericCheckpoint): {
  documentCursor: number;
  tableCursor: number;
  accumulatedFigures: SerializedFigure[];
  accumulatedDiscrepancies: SerializedDiscrepancy[];
  indexedTableMetadata: IndexedTableEntry[];
} {
  return {
    documentCursor: checkpoint.documentCursor,
    tableCursor: checkpoint.tableCursor,
    accumulatedFigures: checkpoint.figures,
    accumulatedDiscrepancies: checkpoint.discrepancies,
    indexedTableMetadata: checkpoint.indexedTableMetadata,
  };
}
