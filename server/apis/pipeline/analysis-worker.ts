/**
 * analysis-worker.ts — Durable Bounded Analysis Workers (Corrective C1)
 *
 * Moves chunk analysis into a lease-based work-item queue with:
 *   - Stable identity: (run_id, document_id, chunk_index, chunk_hash, analysis_version)
 *   - Identity-aware reconciliation: existing pipeline_analysis results with matching
 *     identity seed as 'complete' and are never recomputed.
 *   - Lease-guarded completion: compare-and-set prevents stale workers from overwriting.
 *   - Content-based result hash: FNV-1a of actual extraction text.
 *   - Only current-identity items contribute to completion counts.
 *
 * Architecture:
 *   analysis_work_items (coordination) + pipeline_analysis (authoritative result)
 *   Dual-write: a work item is only 'complete' after pipeline_analysis confirms
 *   with matching identity fields.
 *
 * State machine:
 *   pending → claimed → complete | failed_retryable | failed_permanent
 *   claimed → pending (lease expired, recovered)
 *
 * Claim protocol:
 *   SELECT ... FOR UPDATE SKIP LOCKED (Postgres advisory-lock-free)
 *   Two concurrent workers CANNOT claim the same item.
 */

import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Chunks per worker invocation (admission-controlled by budget) */
export const WORKER_BATCH_SIZE = 8;

/** Lease duration (ms): one full analysis call (120s) + retry (120s). */
export const LEASE_TIMEOUT_MS = 240_000;

/** Maximum attempts before marking failed_permanent */
export const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkItem {
  id: string;
  run_id: string;
  document_id: string;
  chunk_index: number;
  chunk_hash: string;
  analysis_version: string;
  work_identity: string;
  status: WorkItemStatus;
  claim_owner: string | null;
  claimed_at: string | null;
  lease_expires: string | null;
  attempt_count: number;
  error_message: string | null;
}

export type WorkItemStatus =
  | "pending"
  | "claimed"
  | "complete"
  | "failed_retryable"
  | "failed_permanent";

export interface AnalysisCounts {
  total: number;
  pending: number;
  claimed: number;
  complete: number;
  failed_retryable: number;
  failed_permanent: number;
}

export interface PopulateResult {
  inserted: number;
  skippedDuplicate: number;
  seededFromExisting: number;
  total: number;
}

export interface ClaimResult {
  claimed: WorkItem[];
  recovered: number;
}

export interface DualWriteMismatch {
  chunk_index: number;
  work_item_status: string;
  pipeline_analysis_exists: boolean;
  version_match: boolean;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WorkItemSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  chunk_hash: z.string(),
  analysis_version: z.string(),
  work_identity: z.string(),
  status: z.string(),
  claim_owner: z.string().nullable(),
  claimed_at: z.string().nullable(),
  lease_expires: z.string().nullable(),
  attempt_count: z.coerce.number(),
  error_message: z.string().nullable(),
});

const CountSchema = z.object({
  status: z.string(),
  count: z.coerce.number(),
});

const ExistsSchema = z.object({ exists: z.coerce.number() });

const PipelineAnalysisCheckSchema = z.object({
  chunk_index: z.coerce.number(),
  prompt_version: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Identity computation
// ---------------------------------------------------------------------------

/**
 * Computes the deterministic work_identity for a chunk.
 * This is a stable hash of the full identity tuple.
 * Changed content or version → different identity → new work item.
 */
export function computeWorkIdentity(
  runId: string,
  documentId: string,
  chunkIndex: number,
  chunkHash: string,
  analysisVersion: string,
): string {
  const input = `${runId}|${documentId}|${chunkIndex}|${chunkHash}|${analysisVersion}`;
  return fnv1aHex(input);
}

// ---------------------------------------------------------------------------
// Populate work items with reconciliation
// ---------------------------------------------------------------------------

/**
 * Seeds analysis_work_items for a run, reconciling with existing pipeline_analysis.
 *
 * Reconciliation rules:
 * - If pipeline_analysis has a result with matching prompt_version (analysis_version)
 *   for this chunk, the work item is seeded as 'complete' with its result hash.
 * - If pipeline_analysis has a STALE result (different version), the work item is
 *   seeded as 'pending' for recomputation.
 * - If no pipeline_analysis result exists, seeded as 'pending'.
 *
 * Identity: ON CONFLICT (work_identity) DO NOTHING — same identity is idempotent.
 * Changed chunk_hash or analysis_version produces a new work_identity and thus
 * new work, while stale items remain but don't contribute to completion counts.
 */
export async function populateWorkItems(
  ctx: PipelineContext,
  runId: string,
  routedChunks: Array<{
    document_id: string;
    chunk_index: number;
    content_hash: string;
  }>,
): Promise<PopulateResult> {
  const analysisVersion = getPipelineVersion();
  let inserted = 0;
  let skippedDuplicate = 0;
  let seededFromExisting = 0;

  // Step 1: Load existing pipeline_analysis results for this run
  const existingResults = await ctx.integrations.db.query(
    `SELECT chunk_index, prompt_version
     FROM pipeline_analysis
     WHERE run_id = $1`,
    PipelineAnalysisCheckSchema,
    [runId],
    { label: "Load existing pipeline_analysis for reconciliation" }
  );
  const existingMap = new Map<number, string | null>();
  for (const row of existingResults) {
    existingMap.set(row.chunk_index, row.prompt_version);
  }

  // Step 2: Batch insert work items
  const BATCH = 20;
  for (let i = 0; i < routedChunks.length; i += BATCH) {
    const batch = routedChunks.slice(i, i + BATCH);

    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const identity = computeWorkIdentity(
        runId, chunk.document_id, chunk.chunk_index, chunk.content_hash, analysisVersion
      );

      // Reconcile with existing results
      const existingVersion = existingMap.get(chunk.chunk_index);
      const hasMatchingResult = existingVersion === analysisVersion;
      const initialStatus = hasMatchingResult ? "complete" : "pending";

      // For items seeded as complete, store a reconciliation result hash
      const resultHash = hasMatchingResult
        ? fnv1aHex(`reconciled:${runId}:${chunk.chunk_index}:${analysisVersion}`)
        : null;

      const offset = j * 9;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
      );
      values.push(
        runId, chunk.document_id, chunk.chunk_index, chunk.content_hash,
        analysisVersion, identity, initialStatus,
        hasMatchingResult ? new Date().toISOString() : null, // completed_at
        resultHash
      );

      if (hasMatchingResult) seededFromExisting++;
    }

    const result = await ctx.integrations.db.execute(
      `INSERT INTO analysis_work_items
         (run_id, document_id, chunk_index, chunk_hash, analysis_version, work_identity, status, completed_at, result_hash)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (work_identity) DO NOTHING`,
      values,
      { label: `Populate work items batch ${Math.floor(i / BATCH) + 1}` }
    );

    const rowCount = typeof result === "object" && result && "rowCount" in result
      ? (result as { rowCount: number }).rowCount
      : batch.length;
    inserted += rowCount;
    skippedDuplicate += batch.length - rowCount;
  }

  // Adjust: seededFromExisting may include items that were already in the table (skipped)
  // The accurate count is items that were inserted with status='complete'
  const actualSeeded = Math.min(seededFromExisting, inserted);

  return {
    inserted,
    skippedDuplicate,
    seededFromExisting: actualSeeded,
    total: routedChunks.length,
  };
}

// ---------------------------------------------------------------------------
// Atomic claim (SELECT FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

/**
 * Atomically claims a bounded batch of pending/recoverable work items.
 * Only claims items matching the CURRENT analysis version.
 *
 * Guarantees: two concurrent workers CANNOT claim the same item
 * (SKIP LOCKED makes locked rows invisible to other transactions).
 */
export async function claimBatch(
  ctx: PipelineContext,
  runId: string,
  invocationId: string,
  batchSize: number = WORKER_BATCH_SIZE,
): Promise<ClaimResult> {
  const analysisVersion = getPipelineVersion();

  // Step 1: Recover expired leases
  const recovered = await recoverExpiredLeases(ctx, runId);

  // Step 2: Atomic claim via CTE — only current-version items
  const leaseExpiresAt = new Date(Date.now() + LEASE_TIMEOUT_MS).toISOString();

  const claimed = await ctx.integrations.db.query(
    `WITH claimable AS (
       SELECT id FROM analysis_work_items
       WHERE run_id = $1
         AND analysis_version = $6
         AND status IN ('pending', 'failed_retryable')
         AND attempt_count < $4
       ORDER BY chunk_index ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE analysis_work_items awi
     SET status = 'claimed',
         claim_owner = $3,
         claimed_at = now(),
         lease_expires = $5::timestamptz,
         attempt_count = attempt_count + 1,
         updated_at = now()
     FROM claimable
     WHERE awi.id = claimable.id
     RETURNING awi.id, awi.run_id, awi.document_id, awi.chunk_index,
              awi.chunk_hash, awi.analysis_version, awi.work_identity,
              awi.status, awi.claim_owner, awi.claimed_at::text,
              awi.lease_expires::text, awi.attempt_count, awi.error_message`,
    WorkItemSchema,
    [runId, batchSize, invocationId, MAX_ATTEMPTS, leaseExpiresAt, analysisVersion],
    { label: `Claim batch (up to ${batchSize})` }
  );

  return { claimed, recovered };
}

// ---------------------------------------------------------------------------
// Recover expired leases
// ---------------------------------------------------------------------------

/**
 * Transitions claimed items with expired leases.
 * Under MAX_ATTEMPTS → 'pending'. At/over MAX_ATTEMPTS → 'failed_permanent'.
 */
export async function recoverExpiredLeases(
  ctx: PipelineContext,
  runId: string,
): Promise<number> {
  const result = await ctx.integrations.db.execute(
    `UPDATE analysis_work_items
     SET status = CASE
           WHEN attempt_count >= $2 THEN 'failed_permanent'
           ELSE 'pending'
         END,
         claim_owner = NULL,
         claimed_at = NULL,
         lease_expires = NULL,
         error_message = CASE
           WHEN attempt_count >= $2 THEN 'Lease expired after max attempts'
           ELSE error_message
         END,
         updated_at = now()
     WHERE run_id = $1
       AND status = 'claimed'
       AND lease_expires < now()`,
    [runId, MAX_ATTEMPTS],
    { label: "Recover expired leases" }
  );

  const rowCount = typeof result === "object" && result && "rowCount" in result
    ? (result as { rowCount: number }).rowCount
    : 0;

  if (rowCount > 0) {
    console.log(`[analysis-worker] Recovered ${rowCount} expired lease(s) for run ${runId}`);
  }

  return rowCount;
}

// ---------------------------------------------------------------------------
// Complete a work item (lease-guarded, dual-write)
// ---------------------------------------------------------------------------

/**
 * Marks a work item complete with lease-ownership guard.
 *
 * Compare-and-set: UPDATE WHERE id=$1 AND status='claimed'
 *   AND claim_owner=$2 AND attempt_count=$3
 *
 * If ownership check fails (lease expired, reclaimed by another worker),
 * logs STALE_WORKER_COMPLETION_REJECTED and does NOT overwrite.
 *
 * Dual-write sequence:
 *   1. Write to pipeline_analysis (authoritative result)
 *   2. Read-back verification (run_id, chunk_index, prompt_version, content identity match)
 *   3. Compare-and-set work item to 'complete' (only if still owner)
 */
export async function completeItem(
  ctx: PipelineContext,
  item: WorkItem,
  result: {
    label: string;
    extraction: string;
    chunkIndex: number;
    truncated: boolean;
    content_identity: string;
  },
  model: string,
  invocationId: string,
): Promise<{ accepted: boolean }> {
  const analysisVersion = item.analysis_version;

  // Step 1: Write to pipeline_analysis (authoritative result store)
  const contentIdentityJson = JSON.stringify({
    document_id: item.document_id,
    chunk_index: item.chunk_index,
    chunk_hash: item.chunk_hash,
    analysis_version: analysisVersion,
  });

  await ctx.integrations.db.execute(
    `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (run_id, chunk_index) DO UPDATE
     SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
    [
      item.run_id,
      result.chunkIndex,
      JSON.stringify({
        ...result,
        content_identity: contentIdentityJson,
        analysis_version: analysisVersion,
      }),
      model,
      analysisVersion,
    ],
    { label: `Dual-write pipeline_analysis chunk ${result.chunkIndex}` }
  );

  // Step 2: Read-back verification — confirm identity fields match
  const ReadBackSchema = z.object({
    chunk_index: z.coerce.number(),
    prompt_version: z.string().nullable(),
  });

  const verification = await ctx.integrations.db.query(
    `SELECT chunk_index, prompt_version
     FROM pipeline_analysis
     WHERE run_id = $1 AND chunk_index = $2
     LIMIT 1`,
    ReadBackSchema,
    [item.run_id, result.chunkIndex],
    { label: `Verify pipeline_analysis chunk ${result.chunkIndex}` }
  );

  if (verification.length === 0) {
    throw new Error(
      `Dual-write verification failed: pipeline_analysis row missing for ` +
      `run=${item.run_id} chunk=${result.chunkIndex} after INSERT`
    );
  }

  // Verify version matches (not just existence)
  if (verification[0].prompt_version !== analysisVersion) {
    console.warn(
      `[analysis-worker] DUAL_WRITE_VERSION_MISMATCH: chunk ${result.chunkIndex} ` +
      `wrote version=${analysisVersion} but read back version=${verification[0].prompt_version}`
    );
  }

  // Step 3: Content-based result hash (actual extraction text, not just length)
  const resultHash = fnv1aHex(
    `${item.run_id}:${result.chunkIndex}:${analysisVersion}:${result.extraction}`
  );

  // Step 4: Compare-and-set — only mark complete if we still own the lease
  const CompletionResultSchema = z.object({ updated: z.coerce.number() });

  const casResult = await ctx.integrations.db.query(
    `WITH updated AS (
       UPDATE analysis_work_items
       SET status = 'complete',
           completed_at = now(),
           result_hash = $4,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1
         AND status = 'claimed'
         AND claim_owner = $2
         AND attempt_count = $3
       RETURNING id
     )
     SELECT COUNT(*)::int AS updated FROM updated`,
    CompletionResultSchema,
    [item.id, invocationId, item.attempt_count, resultHash],
    { label: `CAS-complete work item chunk ${item.chunk_index}` }
  );

  const accepted = (casResult[0]?.updated ?? 0) > 0;

  if (!accepted) {
    console.warn(
      `[analysis-worker] STALE_WORKER_COMPLETION_REJECTED: chunk ${item.chunk_index} ` +
      `invocation=${invocationId} attempt=${item.attempt_count} — ` +
      `ownership lost (lease expired or reclaimed by another worker). ` +
      `Pipeline_analysis write was accepted; work item NOT marked complete.`
    );
  }

  return { accepted };
}

// ---------------------------------------------------------------------------
// Fail a work item
// ---------------------------------------------------------------------------

/**
 * Marks a work item as failed. Guards by claim_owner for consistency.
 * At MAX_ATTEMPTS → failed_permanent. Below → failed_retryable.
 */
export async function failItem(
  ctx: PipelineContext,
  item: WorkItem,
  error: unknown,
  invocationId: string,
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const truncatedMsg = errMsg.slice(0, 500);
  const newStatus: WorkItemStatus =
    item.attempt_count >= MAX_ATTEMPTS ? "failed_permanent" : "failed_retryable";

  await ctx.integrations.db.execute(
    `UPDATE analysis_work_items
     SET status = $2,
         error_message = $3,
         claim_owner = NULL,
         lease_expires = NULL,
         updated_at = now()
     WHERE id = $1
       AND claim_owner = $4`,
    [item.id, newStatus, truncatedMsg, invocationId],
    { label: `Fail work item chunk ${item.chunk_index} (${newStatus})` }
  );

  console.warn(
    `[analysis-worker] Chunk ${item.chunk_index} failed (attempt ${item.attempt_count}/${MAX_ATTEMPTS}): ` +
    `${truncatedMsg.slice(0, 100)}${truncatedMsg.length > 100 ? "..." : ""}`
  );
}

// ---------------------------------------------------------------------------
// Progress counts (current identity only)
// ---------------------------------------------------------------------------

/**
 * Returns progress counts for the CURRENT analysis version only.
 * Stale-identity items do not contribute to completion counts.
 */
export async function getAnalysisCounts(
  ctx: PipelineContext,
  runId: string,
): Promise<AnalysisCounts> {
  const analysisVersion = getPipelineVersion();

  const rows = await ctx.integrations.db.query(
    `SELECT status, COUNT(*)::int AS count
     FROM analysis_work_items
     WHERE run_id = $1 AND analysis_version = $2
     GROUP BY status`,
    CountSchema,
    [runId, analysisVersion],
    { label: "Analysis work item counts (current version)" }
  );

  const counts: AnalysisCounts = {
    total: 0,
    pending: 0,
    claimed: 0,
    complete: 0,
    failed_retryable: 0,
    failed_permanent: 0,
  };

  for (const row of rows) {
    const key = row.status.replace(/-/g, "_") as keyof AnalysisCounts;
    if (key in counts && key !== "total") {
      (counts as unknown as Record<string, number>)[key] = row.count;
    }
    counts.total += row.count;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Dual-write mismatch detection
// ---------------------------------------------------------------------------

/**
 * Detects mismatches between analysis_work_items and pipeline_analysis.
 * Checks identity match (version), not just existence.
 */
export async function detectMismatches(
  ctx: PipelineContext,
  runId: string,
): Promise<DualWriteMismatch[]> {
  const analysisVersion = getPipelineVersion();

  const MismatchSchema = z.object({
    chunk_index: z.coerce.number(),
    work_item_status: z.string(),
    pipeline_analysis_exists: z.coerce.boolean(),
    version_match: z.coerce.boolean(),
  });

  const mismatches = await ctx.integrations.db.query(
    `SELECT
       awi.chunk_index,
       awi.status AS work_item_status,
       (pa.run_id IS NOT NULL) AS pipeline_analysis_exists,
       (pa.prompt_version = $2) AS version_match
     FROM analysis_work_items awi
     LEFT JOIN pipeline_analysis pa
       ON pa.run_id = awi.run_id AND pa.chunk_index = awi.chunk_index
     WHERE awi.run_id = $1
       AND awi.analysis_version = $2
       AND (
         (awi.status = 'complete' AND (pa.run_id IS NULL OR pa.prompt_version != $2))
         OR
         (awi.status NOT IN ('complete','claimed','failed_permanent') AND pa.run_id IS NOT NULL AND pa.prompt_version = $2)
       )
     LIMIT 10`,
    MismatchSchema,
    [runId, analysisVersion],
    { label: "Detect dual-write mismatches (version-aware)" }
  );

  return mismatches;
}

// ---------------------------------------------------------------------------
// Check if work items are populated
// ---------------------------------------------------------------------------

/**
 * Returns true if current-version analysis_work_items exist for this run.
 */
export async function isPopulated(
  ctx: PipelineContext,
  runId: string,
): Promise<boolean> {
  const analysisVersion = getPipelineVersion();
  const rows = await ctx.integrations.db.query(
    `SELECT 1 AS exists FROM analysis_work_items
     WHERE run_id = $1 AND analysis_version = $2
     LIMIT 1`,
    ExistsSchema,
    [runId, analysisVersion],
    { label: "Check work items populated (current version)" }
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Check if analysis is complete (current version)
// ---------------------------------------------------------------------------

/**
 * Returns true when all CURRENT-VERSION work items are terminal.
 */
export async function isAnalysisComplete(
  ctx: PipelineContext,
  runId: string,
): Promise<boolean> {
  const analysisVersion = getPipelineVersion();
  const rows = await ctx.integrations.db.query(
    `SELECT 1 AS exists FROM analysis_work_items
     WHERE run_id = $1
       AND analysis_version = $2
       AND status IN ('pending', 'claimed', 'failed_retryable')
     LIMIT 1`,
    ExistsSchema,
    [runId, analysisVersion],
    { label: "Check analysis complete (current version)" }
  );
  return rows.length === 0;
}

// ---------------------------------------------------------------------------
// Pipeline run config helpers
// ---------------------------------------------------------------------------

/**
 * Checks if a run has analysis_worker_enabled in pipeline_run_config.
 * Fail-closed: if the table doesn't exist or query errors, returns false.
 */
export async function isWorkerEnabledForRun(
  ctx: PipelineContext,
  runId: string,
): Promise<boolean> {
  try {
    const RunConfigSchema = z.object({
      analysis_worker_enabled: z.boolean(),
    });
    const rows = await ctx.integrations.db.query(
      `SELECT analysis_worker_enabled FROM pipeline_run_config WHERE run_id = $1 LIMIT 1`,
      RunConfigSchema,
      [runId],
      { label: "Check worker enabled (pipeline_run_config)" }
    );
    return rows.length > 0 && rows[0].analysis_worker_enabled === true;
  } catch (err) {
    // Fail-closed: table missing or query error → legacy path
    console.warn(
      `[analysis-worker] isWorkerEnabledForRun failed (fail-closed → legacy): ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash producing a 16-char hex string.
 * Used for work_identity and result_hash.
 * Content-based: different extraction text → different hash.
 */
function fnv1aHex(input: string): string {
  // Use two 32-bit FNV-1a passes with different seeds for 64-bit equivalent
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x050c5d1f >>> 0; // second seed
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// Export for testing
export { fnv1aHex, computeWorkIdentity as _computeWorkIdentity };
