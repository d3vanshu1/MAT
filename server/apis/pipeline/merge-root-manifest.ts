/**
 * Merge-Root Completion Manifest
 *
 * Ensures the pipeline never infers merge-tree completeness merely from a
 * singleton highest-level node. Completion requires an explicit, validated
 * manifest that proves every input leaf reached the final root.
 *
 * The manifest records:
 *   - expected leaf count (total analysis results entering merge)
 *   - accounted leaf set (deterministic fingerprint of all leaf node content hashes)
 *   - root level and node index
 *   - root checkpoint identity (tree_level:node_index key)
 *   - pipeline/prompt version at completion time
 *   - source/input fingerprint (hash of sorted extraction IDs)
 *   - completion generation counter (monotonically increasing per run)
 */
import { getPipelineVersion } from "./pipeline-version.js";

// ---------------------------------------------------------------------------
// Deterministic fingerprint (no crypto dependency — runs in both server and Vite)
// ---------------------------------------------------------------------------

/**
 * Simple deterministic hash for fingerprinting (djb2 variant → hex).
 * NOT cryptographic — used solely for change-detection.
 */
function deterministicHash(input: string): string {
  let h1 = 0x811c9dc5; // FNV offset basis
  let h2 = 0x01000193; // FNV prime
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x811c9dc5);
  }
  // Produce 32 hex chars from two 32-bit halves repeated with rotation
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
  const d = ((h1 + h2) >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}${c}${d}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MERGE_ROOT_MANIFEST_VERSION = 1;

export interface MergeRootManifest {
  /** Schema version for forward-compatibility checks */
  version: typeof MERGE_ROOT_MANIFEST_VERSION;
  /** Total number of leaf nodes (analysis results) that entered the merge tree */
  expectedLeafCount: number;
  /** Deterministic fingerprint: SHA-256 of sorted leaf content hashes */
  leafSetFingerprint: string;
  /** Tree level of the root node (0-indexed round counter) */
  rootLevel: number;
  /** Node index of the root (always 0 for a valid completed tree) */
  rootNodeIndex: number;
  /** Checkpoint identity string: `${rootLevel}:${rootNodeIndex}` */
  rootCheckpointId: string;
  /** Pipeline/prompt version hash at the time of completion */
  pipelineVersion: string;
  /** Source fingerprint: SHA-256 of sorted extraction document_id:chunk_index pairs */
  sourceFingerprint: string;
  /** Monotonically increasing generation counter for this run */
  completionGeneration: number;
  /** ISO timestamp of manifest creation */
  completedAt: string;
  /** Per-round summary: how many nodes each round produced */
  roundSummary: RoundSummary[];
}

export interface RoundSummary {
  round: number;
  inputNodes: number;
  outputNodes: number;
  singletonCarries: number;
  failedGroups: number;
}

export interface LeafNode {
  /** Unique content identifier — typically `${documentId}:${chunkIndex}` */
  leafId: string;
  /** Content hash for fingerprinting (SHA-256 of first 10KB of extraction text) */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Manifest Construction
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic fingerprint from leaf nodes.
 * Sorts by leafId to ensure order-independence.
 */
export function computeLeafSetFingerprint(leaves: LeafNode[]): string {
  const sorted = [...leaves].sort((a, b) => a.leafId.localeCompare(b.leafId));
  const payload = sorted.map(l => `${l.leafId}|${l.contentHash}`).join("\n");
  return deterministicHash(payload);
}

/**
 * Compute a source fingerprint from extraction metadata.
 * Uses sorted document_id:chunk_index pairs.
 */
export function computeSourceFingerprint(
  extractions: Array<{ documentId: string; chunkIndex: number }>
): string {
  const sorted = [...extractions]
    .map(e => `${e.documentId}:${e.chunkIndex}`)
    .sort();
  const payload = sorted.join("\n");
  return deterministicHash(payload);
}

/**
 * Compute a content hash for a leaf node's extraction text.
 */
export function computeLeafContentHash(text: string): string {
  // Use first 10KB to bound computation cost on huge extractions
  const sample = text.slice(0, 10_240);
  return deterministicHash(sample).slice(0, 16);
}

/**
 * Build leaf nodes from analysis results (the inputs to the merge tree).
 */
export function buildLeafNodes(
  analysisResults: Array<{ documentId: string; chunkIndex: number; extraction: string }>
): LeafNode[] {
  return analysisResults.map(a => ({
    leafId: `${a.documentId}:${a.chunkIndex}`,
    contentHash: computeLeafContentHash(a.extraction),
  }));
}

/**
 * Build the root-completion manifest after the merge tree has fully reduced to a single root.
 */
export function buildMergeRootManifest(params: {
  leafNodes: LeafNode[];
  extractions: Array<{ documentId: string; chunkIndex: number }>;
  rootLevel: number;
  rootNodeIndex: number;
  completionGeneration: number;
  roundSummary: RoundSummary[];
}): MergeRootManifest {
  const { leafNodes, extractions, rootLevel, rootNodeIndex, completionGeneration, roundSummary } = params;

  return {
    version: MERGE_ROOT_MANIFEST_VERSION,
    expectedLeafCount: leafNodes.length,
    leafSetFingerprint: computeLeafSetFingerprint(leafNodes),
    rootLevel,
    rootNodeIndex,
    rootCheckpointId: `${rootLevel}:${rootNodeIndex}`,
    pipelineVersion: getPipelineVersion(),
    sourceFingerprint: computeSourceFingerprint(extractions),
    completionGeneration,
    completedAt: new Date().toISOString(),
    roundSummary,
  };
}

// ---------------------------------------------------------------------------
// Manifest Validation
// ---------------------------------------------------------------------------

export type ManifestValidationResult =
  | { valid: true }
  | { valid: false; reason: string; recovery: "resume" | "rebuild" };

/**
 * Validate a loaded manifest against the current pipeline state.
 *
 * Checks:
 *   1. Schema version is recognized
 *   2. Expected leaf count matches the current analysis result count
 *   3. Leaf set fingerprint matches (content hasn't changed)
 *   4. Source fingerprint matches (extraction set hasn't changed)
 *   5. Pipeline version matches (prompts haven't been updated)
 *   6. Root level and node index are consistent
 *
 * Returns `{ valid: true }` or `{ valid: false, reason, recovery }` where
 * recovery indicates whether the pipeline should resume or rebuild.
 */
export function validateManifest(
  manifest: MergeRootManifest,
  currentState: {
    leafNodes: LeafNode[];
    extractions: Array<{ documentId: string; chunkIndex: number }>;
    currentPipelineVersion: string;
  }
): ManifestValidationResult {
  // Version check
  if (!manifest.version || manifest.version > MERGE_ROOT_MANIFEST_VERSION) {
    return {
      valid: false,
      reason: `Unknown manifest version: ${manifest.version} (max supported: ${MERGE_ROOT_MANIFEST_VERSION})`,
      recovery: "rebuild",
    };
  }

  // Leaf count
  if (manifest.expectedLeafCount !== currentState.leafNodes.length) {
    return {
      valid: false,
      reason: `Leaf count mismatch: manifest expects ${manifest.expectedLeafCount}, current has ${currentState.leafNodes.length}`,
      recovery: "rebuild",
    };
  }

  // Leaf fingerprint
  const currentLeafFingerprint = computeLeafSetFingerprint(currentState.leafNodes);
  if (manifest.leafSetFingerprint !== currentLeafFingerprint) {
    return {
      valid: false,
      reason: `Leaf set fingerprint mismatch: manifest=${manifest.leafSetFingerprint.slice(0, 8)}, current=${currentLeafFingerprint.slice(0, 8)}`,
      recovery: "rebuild",
    };
  }

  // Source fingerprint
  const currentSourceFingerprint = computeSourceFingerprint(currentState.extractions);
  if (manifest.sourceFingerprint !== currentSourceFingerprint) {
    return {
      valid: false,
      reason: `Source fingerprint mismatch: manifest=${manifest.sourceFingerprint.slice(0, 8)}, current=${currentSourceFingerprint.slice(0, 8)}`,
      recovery: "rebuild",
    };
  }

  // Pipeline version
  if (manifest.pipelineVersion !== currentState.currentPipelineVersion) {
    return {
      valid: false,
      reason: `Pipeline version mismatch: manifest=${manifest.pipelineVersion.slice(0, 8)}, current=${currentState.currentPipelineVersion.slice(0, 8)}`,
      recovery: "rebuild",
    };
  }

  // Root consistency
  if (manifest.rootNodeIndex !== 0) {
    return {
      valid: false,
      reason: `Root node index must be 0, got ${manifest.rootNodeIndex}`,
      recovery: "rebuild",
    };
  }

  return { valid: true };
}

/**
 * Deserialize a manifest from its JSON representation (as stored in the checkpoint).
 * Returns null if the payload is not a valid manifest.
 */
export function deserializeManifest(payload: unknown): MergeRootManifest | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  // Must have version field and match manifest shape
  if (typeof p.version !== "number") return null;
  if (typeof p.expectedLeafCount !== "number") return null;
  if (typeof p.leafSetFingerprint !== "string") return null;
  if (typeof p.rootLevel !== "number") return null;
  if (typeof p.rootNodeIndex !== "number") return null;
  if (typeof p.rootCheckpointId !== "string") return null;
  if (typeof p.pipelineVersion !== "string") return null;
  if (typeof p.sourceFingerprint !== "string") return null;
  if (typeof p.completionGeneration !== "number") return null;
  if (typeof p.completedAt !== "string") return null;

  return payload as MergeRootManifest;
}
