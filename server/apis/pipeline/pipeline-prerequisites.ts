/**
 * Pipeline Prerequisites — Migration verification, manifest loading, and checkpoint typing.
 *
 * Provides fail-closed guards that prevent pipeline operations from running against
 * a database that hasn't been migrated to the required schema version.
 *
 * Also provides immutable manifest loading: once a frozen manifest is persisted,
 * it is treated as the authoritative source of truth for tree membership.
 * It is NEVER overwritten with a newly inferred manifest unless exact equivalence
 * is proven by comparing source fingerprints.
 *
 * Checkpoint kind: provides explicit type filtering for merge-tree data nodes
 * rather than relying on numeric level thresholds.
 */
import { z } from "@superblocksteam/sdk-api";
import { computeContentHash } from "./source-snapshot.js";

// ---------------------------------------------------------------------------
// Migration 019 required columns
// ---------------------------------------------------------------------------
const MIGRATION_019_REQUIRED_COLUMNS = [
  "artifact_status",
  "superseded_by_output_id",
  "invalidated_at",
  "invalidation_reason",
] as const;

export interface MigrationVerificationResult {
  migrated: boolean;
  missingColumns: string[];
  presentColumns: string[];
}

/**
 * Checks whether migration 019 has been applied by verifying required columns
 * exist in module_outputs. Returns structured result; does NOT throw.
 */
export async function verifyMigration019(db: any): Promise<MigrationVerificationResult> {
  const rows = await db.query(
    `SELECT column_name::text AS column_name
     FROM information_schema.columns
     WHERE table_name = 'module_outputs'
       AND column_name = ANY($1::text[])`,
    z.object({ column_name: z.string() }),
    [MIGRATION_019_REQUIRED_COLUMNS as unknown as string[]],
    { label: "Verify migration 019 columns exist" }
  );

  const presentColumns = rows.map((r: { column_name: string }) => r.column_name);
  const missingColumns = MIGRATION_019_REQUIRED_COLUMNS.filter(
    col => !presentColumns.includes(col)
  );

  return {
    migrated: missingColumns.length === 0,
    missingColumns,
    presentColumns,
  };
}

/**
 * Fail-closed guard: throws if migration 019 has not been applied.
 * Must be called before any code that depends on artifact lifecycle columns.
 */
export async function requireMigration019(db: any): Promise<void> {
  const result = await verifyMigration019(db);
  if (!result.migrated) {
    throw new PipelinePrerequisiteError(
      "MIGRATION_019_REQUIRED",
      `Migration 019 not applied. Missing columns: ${result.missingColumns.join(", ")}. ` +
      `Pipeline operations cannot proceed until a DBA runs RunMigration019 with table-owner privileges.`
    );
  }
}

// ---------------------------------------------------------------------------
// Frozen Manifest (Immutable)
// ---------------------------------------------------------------------------

/**
 * The canonical frozen manifest structure.
 * Once persisted, it is immutable — it represents the original eligible analysis set
 * at tree construction time.
 */
export interface FrozenManifest {
  version: number;
  /** All eligible analysis IDs in deterministic order */
  eligibleAnalysisIds: string[];
  /** L1 membership: maps L1 node index → array of chunk_indices that belong to that L1 node */
  l1Membership: Record<number, number[]>;
  /** Excluded analyses and reasons */
  excluded: Array<{ analysisId: string; reason: string }>;
  /** Fingerprint of the source analysis set (deterministic hash of all content) */
  sourceFingerprint: string;
  /** Expected topology derived from eligible count and fan-in */
  expectedTopology: { l1: number; l2: number; l3: number; l4: number; total: number };
  /** ISO timestamp when this manifest was first created */
  createdAt: string;
  /** Provenance: how this manifest was constructed */
  provenance: "tree_construction" | "recovery_reconstruction" | "validation_snapshot";
  /** Number of eligible analyses at creation time */
  eligibleCount: number;
}

/**
 * Load the immutable frozen manifest for a run.
 * Returns null if no manifest has been persisted yet.
 * Does NOT reconstruct — callers that need the manifest must handle the null case.
 */
export async function loadFrozenManifest(db: any, runId: string): Promise<FrozenManifest | null> {
  const rows = await db.query(
    `SELECT payload FROM pipeline_checkpoints
     WHERE module_run_id = $1 AND checkpoint_key = 'frozen_manifest'
     LIMIT 1`,
    z.object({ payload: z.any() }),
    [runId],
    { label: "Load frozen manifest (immutable)" }
  );

  if (rows.length === 0) return null;
  const payload = rows[0].payload;
  if (!payload || typeof payload !== "object") return null;

  // Validate required fields
  if (!payload.eligibleAnalysisIds || !payload.l1Membership || !payload.sourceFingerprint) {
    return null;
  }

  return payload as FrozenManifest;
}

/**
 * Require the frozen manifest — fail-closed if it doesn't exist.
 * Recovery and finalization MUST NOT proceed without a valid manifest.
 */
export async function requireFrozenManifest(db: any, runId: string): Promise<FrozenManifest> {
  const manifest = await loadFrozenManifest(db, runId);
  if (!manifest) {
    throw new PipelinePrerequisiteError(
      "FROZEN_MANIFEST_REQUIRED",
      `No frozen manifest found for run ${runId}. ` +
      `Recovery cannot proceed without an immutable manifest. ` +
      `Run ValidateTreeRoot first to construct and persist the manifest.`
    );
  }
  return manifest;
}

/**
 * Persist a frozen manifest. Will NOT overwrite an existing manifest unless
 * exact source fingerprint equivalence is proven.
 *
 * Returns: { persisted: true } if written, { persisted: false, reason: string } if skipped.
 */
export async function persistFrozenManifest(
  db: any,
  runId: string,
  manifest: FrozenManifest,
): Promise<{ persisted: boolean; reason?: string }> {
  // Check for existing manifest
  const existing = await loadFrozenManifest(db, runId);
  if (existing) {
    // Only overwrite if source fingerprints match (exact equivalence)
    if (existing.sourceFingerprint !== manifest.sourceFingerprint) {
      return {
        persisted: false,
        reason: `Existing manifest has different sourceFingerprint ` +
          `(existing: ${existing.sourceFingerprint}, new: ${manifest.sourceFingerprint}). ` +
          `Refusing to overwrite immutable manifest with different content.`,
      };
    }
    // Fingerprints match — update is safe (idempotent)
  }

  await db.execute(
    `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
     VALUES ($1, 'frozen_manifest', $2::jsonb, 'complete', $3)
     ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
    [runId, JSON.stringify(manifest), computeContentHash(manifest.sourceFingerprint)],
    { label: "Persist frozen manifest (immutable)" }
  );

  return { persisted: true };
}

// ---------------------------------------------------------------------------
// Checkpoint Kind — Explicit type filtering
// ---------------------------------------------------------------------------

/**
 * Valid merge-tree levels derived from a frozen manifest's expectedTopology.
 * Only these levels contain actual merge-tree data nodes.
 * Any level outside this set is NOT a merge-tree data node (e.g., synthetic
 * quality checkpoints, diagnostic snapshots, etc.).
 */
export function getValidMergeTreeLevels(manifest: FrozenManifest): number[] {
  const levels: number[] = [];
  if (manifest.expectedTopology.l1 > 0) levels.push(1);
  if (manifest.expectedTopology.l2 > 0) levels.push(2);
  if (manifest.expectedTopology.l3 > 0) levels.push(3);
  if (manifest.expectedTopology.l4 > 0) levels.push(4);
  return levels;
}

/**
 * SQL filter clause for merge-tree data nodes only.
 * Use this instead of `tree_level < 90`.
 */
export function mergeTreeLevelFilter(manifest: FrozenManifest): string {
  const levels = getValidMergeTreeLevels(manifest);
  if (levels.length === 0) return "FALSE"; // No valid levels — fail closed
  return `tree_level = ANY(ARRAY[${levels.join(",")}])`;
}

/**
 * Returns true if a given tree_level is a valid merge-tree data node level
 * according to the manifest topology.
 */
export function isMergeTreeLevel(level: number, manifest: FrozenManifest): boolean {
  return getValidMergeTreeLevels(manifest).includes(level);
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------
export class PipelinePrerequisiteError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PipelinePrerequisiteError";
  }
}
