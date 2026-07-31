/**
 * Numeric Verification Checkpoint — resumable cursor for numeric-verify-inline.
 *
 * Ensures partial numeric verification runs accumulate results across invocations
 * rather than restarting from zero each time. The checkpoint persists:
 *   - explicit status (partial | complete)
 *   - ordered document and table cursors
 *   - accumulated figures and discrepancies
 *   - processed/pending counts
 *   - source fingerprint for invalidation on model changes
 *   - config version for detecting schema drift
 *
 * Only `status: complete` satisfies the numeric resume gate.
 * A changed source fingerprint invalidates the entire checkpoint.
 */
import { getPipelineVersion } from "./pipeline-version.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const NUMERIC_CHECKPOINT_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NumericCheckpoint {
  version: typeof NUMERIC_CHECKPOINT_VERSION;
  status: "partial" | "complete";
  /** Ordered document IDs in the verification universe */
  documentIds: string[];
  /** Ordered table IDs in the load universe */
  tableIds: string[];
  /** Cursor: index into documentIds of the first UNPROCESSED document */
  documentCursor: number;
  /** Cursor: index into tableIds of the first UNPROCESSED table */
  tableCursor: number;
  /** Accumulated figures from all processed documents/tables so far */
  figures: SerializedFigure[];
  /** Accumulated discrepancies from all processed tables so far */
  discrepancies: SerializedDiscrepancy[];
  /** Count of documents fully processed */
  documentsProcessed: number;
  /** Total document count in the universe */
  documentsTotal: number;
  /** Count of tables fully loaded and processed */
  tablesLoaded: number;
  /** Total table count in the load universe */
  tablesTotal: number;
  /** Source fingerprint: deterministic hash of documentIds + tableIds */
  sourceFingerprint: string;
  /** Pipeline version at checkpoint creation */
  pipelineVersion: string;
  /** Numeric config version (changes when metric config or cross-agreement config changes) */
  configVersion: string;
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
 * Compute source fingerprint from the document and table universe.
 * If either set changes (new upload, removed doc, schema change), the fingerprint
 * will differ and the checkpoint will be invalidated.
 */
export function computeNumericSourceFingerprint(
  documentIds: string[],
  tableIds: string[]
): string {
  const sorted = [...documentIds].sort().join("|") + "||" + [...tableIds].sort().join("|");
  return deterministicHash(sorted);
}

/**
 * Compute config version from the numeric verification configuration.
 * Changes when metric patterns, cross-agreement thresholds, or structural
 * parameters are modified.
 */
export function computeNumericConfigVersion(): string {
  // Combines pipeline version with a static config revision.
  // Bump NUMERIC_CONFIG_REVISION when changing MetricConfig or CrossAgreementConfig.
  const NUMERIC_CONFIG_REVISION = "2026-07-31-r1";
  return `${getPipelineVersion()}:${NUMERIC_CONFIG_REVISION}`;
}

// ---------------------------------------------------------------------------
// Building checkpoints
// ---------------------------------------------------------------------------

export interface BuildCheckpointInput {
  status: "partial" | "complete";
  documentIds: string[];
  tableIds: string[];
  documentCursor: number;
  tableCursor: number;
  figures: SerializedFigure[];
  discrepancies: SerializedDiscrepancy[];
  documentsProcessed: number;
  documentsTotal: number;
  tablesLoaded: number;
  tablesTotal: number;
  crossAgreementDebug?: any;
}

/**
 * Build a numeric checkpoint from the current state of verification.
 */
export function buildNumericCheckpoint(input: BuildCheckpointInput): NumericCheckpoint {
  const sourceFingerprint = computeNumericSourceFingerprint(input.documentIds, input.tableIds);
  return {
    version: NUMERIC_CHECKPOINT_VERSION,
    status: input.status,
    documentIds: input.documentIds,
    tableIds: input.tableIds,
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
 * Returns valid=true only if:
 *   - Schema version matches
 *   - Source fingerprint matches (no new/removed documents or tables)
 *   - Config version matches (no metric/threshold changes)
 *   - All structural fields are present and well-typed
 *
 * Invalid results include an action:
 *   - "invalidate": discard checkpoint and restart (source changed)
 *   - "error": corrupted data, fail loudly
 */
export function validateNumericCheckpoint(
  raw: unknown,
  currentDocumentIds: string[],
  currentTableIds: string[]
): ValidateResult {
  if (!raw || typeof raw !== "object") {
    return { valid: false, reason: "Checkpoint is null or not an object", action: "invalidate" };
  }

  const obj = raw as Record<string, unknown>;

  // Version check
  if (obj.version !== NUMERIC_CHECKPOINT_VERSION) {
    return { valid: false, reason: `Unknown checkpoint version: ${obj.version} (expected ${NUMERIC_CHECKPOINT_VERSION})`, action: "invalidate" };
  }

  // Status check
  if (obj.status !== "partial" && obj.status !== "complete") {
    return { valid: false, reason: `Invalid status: ${obj.status}`, action: "error" };
  }

  // Required fields
  const required = ["documentIds", "tableIds", "documentCursor", "tableCursor", "figures", "discrepancies",
    "documentsProcessed", "documentsTotal", "tablesLoaded", "tablesTotal", "sourceFingerprint",
    "pipelineVersion", "configVersion"];
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

  if (!Array.isArray(obj.documentIds) || !Array.isArray(obj.tableIds)) {
    return { valid: false, reason: "documentIds and tableIds must be arrays", action: "error" };
  }

  // Source fingerprint — most critical check
  const currentFingerprint = computeNumericSourceFingerprint(currentDocumentIds, currentTableIds);
  if (obj.sourceFingerprint !== currentFingerprint) {
    return {
      valid: false,
      reason: `Source fingerprint mismatch: checkpoint=${String(obj.sourceFingerprint).slice(0, 16)}, current=${currentFingerprint.slice(0, 16)}. Documents or tables changed since last run.`,
      action: "invalidate",
    };
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
 * Returns the cursor positions to resume from.
 */
export function getResumePosition(checkpoint: NumericCheckpoint): {
  documentCursor: number;
  tableCursor: number;
  accumulatedFigures: SerializedFigure[];
  accumulatedDiscrepancies: SerializedDiscrepancy[];
} {
  return {
    documentCursor: checkpoint.documentCursor,
    tableCursor: checkpoint.tableCursor,
    accumulatedFigures: checkpoint.figures,
    accumulatedDiscrepancies: checkpoint.discrepancies,
  };
}
