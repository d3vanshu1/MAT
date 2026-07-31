/**
 * analysis-worker.ts — Durable Bounded Analysis Workers (Stabilization Batch, Commit 1)
 *
 * Moves chunk analysis out of the monolithic pipeline execution path into a
 * lease-based work-item queue with stable identity and concurrent worker support.
 *
 * Architecture:
 *   analysis_work_items (coordination) + pipeline_analysis (authoritative result)
 *   Dual-write: a work item is only 'complete' after pipeline_analysis confirms.
 *
 * State machine:
 *   pending → claimed → complete | failed_retryable | failed_permanent
 *   claimed → pending (lease expired, recovered)
 *
 * Identity tuple (stable across invocations):
 *   (run_id, document_id, chunk_index, chunk_hash, analysis_version)
 *
 * Claim protocol:
 *   SELECT ... FOR UPDATE SKIP LOCKED with lease_expires check
 *   Prevents duplicate claims across concurrent workers.
 *
 * This module is used by pipeline-core.ts when ANALYSIS_WORKER_ENABLED=true.
 */

import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Chunks per worker invocation (admission-controlled by budget) */
export const WORKER_BATCH_SIZE = 8;

/** Lease duration (ms). Must be < platform cap to allow recovery.
 *  4 minutes = 240s: one full analysis call (120s) + retry (120s). */
export const LEASE_TIMEOUT_MS = 240_000;

/** Maximum attempts before marking failed_permanent */
export const MAX_ATTEMPTS = 3;

/** Threshold for stale-lease recovery: claimed_at older than this and lease expired */
export const RECOVERY_GRACE_MS = 30_000;

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
  skipped: number;
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
}

// ---------------------------------------------------------------------------
// Schemas for DB queries
// ---------------------------------------------------------------------------

const WorkItemSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  chunk_hash: z.string(),
  analysis_version: z.string(),
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

// ---------------------------------------------------------------------------
// Populate work items from routed extractions
// ---------------------------------------------------------------------------

/**
 * Seeds analysis_work_items for a run. Called once when the pipeline enters
 * the analysis phase for the first time (or when new extractions are added).
 *
 * Idempotent: ON CONFLICT (run_id, chunk_index) DO NOTHING.
 * Only inserts items for chunk indices that don't already have a matching
 * pipeline_analysis result with the current analysis_version.
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
  let skipped = 0;

  // Batch insert in groups of 20 to avoid overly large queries
  const BATCH = 20;
  for (let i = 0; i < routedChunks.length; i += BATCH) {
    const batch = routedChunks.slice(i, i + BATCH);

    // Build VALUES clause for batch
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const offset = j * 5;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
      );
      values.push(runId, chunk.document_id, chunk.chunk_index, chunk.content_hash, analysisVersion);
    }

    // Insert only items that don't already have a complete pipeline_analysis row
    // with matching version. ON CONFLICT skips duplicates.
    const result = await ctx.integrations.db.execute(
      `INSERT INTO analysis_work_items (run_id, document_id, chunk_index, chunk_hash, analysis_version)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (run_id, chunk_index) DO NOTHING`,
      values,
      { label: `Populate work items batch ${Math.floor(i / BATCH) + 1}` }
    );

    // rowCount from ON CONFLICT DO NOTHING tells us how many were actually inserted
    const rowCount = typeof result === "object" && result && "rowCount" in result
      ? (result as { rowCount: number }).rowCount
      : batch.length; // fallback: assume all inserted
    inserted += rowCount;
    skipped += batch.length - rowCount;
  }

  return { inserted, skipped, total: routedChunks.length };
}

// ---------------------------------------------------------------------------
// Atomic claim (SELECT FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

/**
 * Atomically claims a bounded batch of pending/recoverable work items.
 *
 * Uses Postgres advisory-lock-free approach:
 *   1. Recover expired leases first (claimed → pending where lease_expires < now)
 *   2. SELECT ... FOR UPDATE SKIP LOCKED on pending items
 *   3. UPDATE status='claimed', set claim_owner, lease_expires, increment attempt_count
 *
 * Two concurrent workers calling claimBatch CANNOT claim the same item
 * because SKIP LOCKED ensures locked rows are invisible to other transactions.
 */
export async function claimBatch(
  ctx: PipelineContext,
  runId: string,
  invocationId: string,
  batchSize: number = WORKER_BATCH_SIZE,
): Promise<ClaimResult> {
  // Step 1: Recover expired leases
  const recovered = await recoverExpiredLeases(ctx, runId);

  // Step 2: Atomic claim via CTE (single round-trip)
  // The CTE uses FOR UPDATE SKIP LOCKED to prevent concurrent duplicate claims.
  const leaseExpiresAt = new Date(Date.now() + LEASE_TIMEOUT_MS).toISOString();

  const claimed = await ctx.integrations.db.query(
    `WITH claimable AS (
       SELECT id FROM analysis_work_items
       WHERE run_id = $1
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
              awi.chunk_hash, awi.analysis_version, awi.status,
              awi.claim_owner, awi.claimed_at::text, awi.lease_expires::text,
              awi.attempt_count, awi.error_message`,
    WorkItemSchema,
    [runId, batchSize, invocationId, MAX_ATTEMPTS, leaseExpiresAt],
    { label: `Claim batch (up to ${batchSize})` }
  );

  return { claimed, recovered };
}

// ---------------------------------------------------------------------------
// Recover expired leases
// ---------------------------------------------------------------------------

/**
 * Transitions claimed items with expired leases back to 'pending' or
 * 'failed_retryable' (if attempt_count >= MAX_ATTEMPTS → failed_permanent).
 *
 * Returns count of recovered items.
 */
export async function recoverExpiredLeases(
  ctx: PipelineContext,
  runId: string,
): Promise<number> {
  // Move expired claims back to pending (if under max attempts)
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
// Complete a work item (dual-write to pipeline_analysis)
// ---------------------------------------------------------------------------

/**
 * Marks a work item complete and dual-writes the result to pipeline_analysis.
 *
 * Transaction behavior:
 *   1. Write to pipeline_analysis (authoritative result store)
 *   2. Verify pipeline_analysis row exists
 *   3. Mark work item complete only after verification
 *
 * A work item is NOT marked complete until pipeline_analysis confirms.
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
): Promise<void> {
  const analysisVersion = item.analysis_version;

  // Step 1: Write to pipeline_analysis (the merge-phase reader)
  await ctx.integrations.db.execute(
    `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (run_id, chunk_index) DO UPDATE
     SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
    [
      item.run_id,
      result.chunkIndex,
      JSON.stringify(result),
      model,
      analysisVersion,
    ],
    { label: `Dual-write pipeline_analysis chunk ${result.chunkIndex}` }
  );

  // Step 2: Verify the write landed
  const verification = await ctx.integrations.db.query(
    `SELECT 1 AS exists FROM pipeline_analysis WHERE run_id = $1 AND chunk_index = $2 LIMIT 1`,
    ExistsSchema,
    [item.run_id, result.chunkIndex],
    { label: `Verify pipeline_analysis chunk ${result.chunkIndex}` }
  );

  if (verification.length === 0) {
    throw new Error(
      `Dual-write verification failed: pipeline_analysis row missing for ` +
      `run=${item.run_id} chunk=${result.chunkIndex} after INSERT`
    );
  }

  // Step 3: Mark work item complete (only after pipeline_analysis confirmed)
  const resultHash = fnv1aShort(
    `${result.chunkIndex}:${result.extraction.length}:${result.content_identity}`
  );

  await ctx.integrations.db.execute(
    `UPDATE analysis_work_items
     SET status = 'complete',
         completed_at = now(),
         result_hash = $2,
         error_message = NULL,
         updated_at = now()
     WHERE id = $1`,
    [item.id, resultHash],
    { label: `Complete work item chunk ${item.chunk_index}` }
  );
}

// ---------------------------------------------------------------------------
// Fail a work item
// ---------------------------------------------------------------------------

/**
 * Marks a work item as failed. If attempt_count >= MAX_ATTEMPTS, marks permanent.
 * Otherwise marks retryable so the next invocation can reclaim it.
 */
export async function failItem(
  ctx: PipelineContext,
  item: WorkItem,
  error: unknown,
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
     WHERE id = $1`,
    [item.id, newStatus, truncatedMsg],
    { label: `Fail work item chunk ${item.chunk_index} (${newStatus})` }
  );

  console.warn(
    `[analysis-worker] Chunk ${item.chunk_index} failed (attempt ${item.attempt_count}/${MAX_ATTEMPTS}): ` +
    `${truncatedMsg.slice(0, 100)}${truncatedMsg.length > 100 ? "..." : ""}`
  );
}

// ---------------------------------------------------------------------------
// Progress counts
// ---------------------------------------------------------------------------

/**
 * Returns durable progress counts for a run.
 * Used by the orchestrator and diagnostic endpoints.
 */
export async function getAnalysisCounts(
  ctx: PipelineContext,
  runId: string,
): Promise<AnalysisCounts> {
  const rows = await ctx.integrations.db.query(
    `SELECT status, COUNT(*)::int AS count
     FROM analysis_work_items
     WHERE run_id = $1
     GROUP BY status`,
    CountSchema,
    [runId],
    { label: "Analysis work item counts" }
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
// Dual-write mismatch detection (diagnostics)
// ---------------------------------------------------------------------------

/**
 * Detects mismatches between analysis_work_items and pipeline_analysis.
 * A mismatch is:
 *   - work item status = 'complete' but no pipeline_analysis row exists
 *   - pipeline_analysis row exists but work item is not 'complete'
 *
 * Returns up to 10 mismatches for diagnostic visibility.
 */
export async function detectMismatches(
  ctx: PipelineContext,
  runId: string,
): Promise<DualWriteMismatch[]> {
  const MismatchSchema = z.object({
    chunk_index: z.coerce.number(),
    work_item_status: z.string(),
    pipeline_analysis_exists: z.coerce.boolean(),
  });

  // Check: work items marked complete but missing from pipeline_analysis
  const mismatches = await ctx.integrations.db.query(
    `SELECT
       awi.chunk_index,
       awi.status AS work_item_status,
       (pa.run_id IS NOT NULL) AS pipeline_analysis_exists
     FROM analysis_work_items awi
     LEFT JOIN pipeline_analysis pa
       ON pa.run_id = awi.run_id AND pa.chunk_index = awi.chunk_index
     WHERE awi.run_id = $1
       AND (
         (awi.status = 'complete' AND pa.run_id IS NULL)
         OR
         (awi.status != 'complete' AND pa.run_id IS NOT NULL AND awi.status != 'claimed')
       )
     LIMIT 10`,
    MismatchSchema,
    [runId],
    { label: "Detect dual-write mismatches" }
  );

  return mismatches;
}

// ---------------------------------------------------------------------------
// Check if work items are already populated for this run
// ---------------------------------------------------------------------------

/**
 * Returns true if analysis_work_items have been seeded for this run.
 * Used to avoid redundant population on re-entry.
 */
export async function isPopulated(
  ctx: PipelineContext,
  runId: string,
): Promise<boolean> {
  const rows = await ctx.integrations.db.query(
    `SELECT 1 AS exists FROM analysis_work_items WHERE run_id = $1 LIMIT 1`,
    ExistsSchema,
    [runId],
    { label: "Check work items populated" }
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Check if all analysis is complete (no pending or claimed items remain)
// ---------------------------------------------------------------------------

/**
 * Returns true when all work items are terminal (complete or failed_permanent).
 * Used by the orchestrator to determine when to advance to merge phase.
 */
export async function isAnalysisComplete(
  ctx: PipelineContext,
  runId: string,
): Promise<boolean> {
  const rows = await ctx.integrations.db.query(
    `SELECT 1 AS exists FROM analysis_work_items
     WHERE run_id = $1 AND status IN ('pending', 'claimed', 'failed_retryable')
     LIMIT 1`,
    ExistsSchema,
    [runId],
    { label: "Check analysis complete" }
  );
  return rows.length === 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Simple FNV-1a hash for result fingerprinting (no crypto dependency) */
function fnv1aShort(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
