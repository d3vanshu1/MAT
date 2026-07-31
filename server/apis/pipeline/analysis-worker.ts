/**
 * analysis-worker.ts — Durable Analysis Worker (Corrective C1.1)
 *
 * Architecture:
 * - Fenced writes: ownership validated BEFORE any pipeline_analysis write
 * - Resumable population: every invocation reconciles the full expected identity set
 * - Generation model: generation_id = hash of sorted expected work_identity set
 * - Full identity reconciliation: existing pipeline_analysis only reused when
 *   document_id, chunk_hash, analysis_version, AND result content all match
 * - Progress scoped to expected current identities (generation_id)
 *
 * State machine: pending → claimed → complete | failed_retryable | failed_permanent
 *
 * Fencing design:
 *   1. claimBatch generates a unique fence_token per claim
 *   2. completeItem validates ownership (status=claimed, owner, attempt, fence_token)
 *      BEFORE writing pipeline_analysis
 *   3. Pipeline_analysis stores fence_token alongside the result
 *   4. Read-back verifies fence_token matches
 *   5. Only then is the work item marked complete
 *   A stale worker whose fence_token doesn't match can never write the authoritative row.
 */

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import { getPipelineVersion } from "./pipeline-version.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const WORKER_BATCH_SIZE = 8;
const LEASE_TIMEOUT_MS = 240_000; // 4 minutes
const MAX_ATTEMPTS = 3;

// ─── FNV-1a hash (deterministic, no crypto dependency) ────────────────────────

function fnv1aHex(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x050c5d1f >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// ─── Stable Identity ──────────────────────────────────────────────────────────

/**
 * Deterministic work identity from the 5-tuple.
 * Any change in document_id, chunk_hash, or analysis_version produces a new identity.
 */
export function computeWorkIdentity(
  runId: string,
  documentId: string,
  chunkIndex: number,
  chunkHash: string,
  analysisVersion: string
): string {
  return fnv1aHex(`${runId}|${documentId}|${chunkIndex}|${chunkHash}|${analysisVersion}`);
}

/**
 * Compute generation_id: deterministic hash of the sorted expected work_identity set.
 * Changes when the routed chunk set changes (new docs, changed content, version bump).
 */
export function computeGenerationId(expectedIdentities: string[]): string {
  const sorted = [...expectedIdentities].sort();
  return fnv1aHex(sorted.join("\n"));
}

/**
 * Canonical result fingerprint covering the complete normalized result object.
 * Includes: label, extraction, truncation status, content identity (as JSON object).
 */
export function computeResultHash(result: {
  runId: string;
  chunkIndex: number;
  analysisVersion: string;
  label: string;
  extraction: string;
  truncated: boolean;
  contentIdentity: { document_id: string; chunk_index: number; chunk_hash: string };
}): string {
  const canonical = JSON.stringify({
    run_id: result.runId,
    chunk_index: result.chunkIndex,
    analysis_version: result.analysisVersion,
    label: result.label,
    extraction: result.extraction,
    truncated: result.truncated,
    content_identity: result.contentIdentity,
  });
  return fnv1aHex(canonical);
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input chunk descriptor for population */
export interface ChunkDescriptor {
  document_id: string;
  chunk_index: number;
  content_hash: string;
}

/** Claimed work item returned to the caller */
export interface ClaimedItem {
  id: string;
  run_id: string;
  document_id: string;
  chunk_index: number;
  chunk_hash: string;
  analysis_version: string;
  work_identity: string;
  generation_id: string;
  attempt_count: number;
  fence_token: string;
}

/** Result of completing a work item */
export interface CompleteResult {
  accepted: boolean;
  reason?: string;
}

/** Population result */
export interface PopulateResult {
  inserted: number;
  skippedDuplicate: number;
  seededFromExisting: number;
  expectedCount: number;
  presentCount: number;
  missingCount: number;
  generationId: string;
}

/** Progress counts scoped to the current generation */
export interface GenerationCounts {
  total: number;
  pending: number;
  claimed: number;
  complete: number;
  failed_retryable: number;
  failed_permanent: number;
  expectedCount: number;
  missingFromQueue: number;
}

// ─── Worker enablement (fail-closed) ────────────────────────────────────────

/**
 * Check if a run has opted into the worker path.
 * Fail-closed: any error or missing config → false (legacy path).
 */
export async function isWorkerEnabledForRun(
  ctx: PipelineContext,
  runId: string
): Promise<boolean> {
  try {
    const rows = await ctx.integrations.db.query(
      `SELECT analysis_worker_enabled FROM pipeline_run_config WHERE run_id = $1 LIMIT 1`,
      z.object({ analysis_worker_enabled: z.boolean() }),
      [runId],
      { label: "Check worker-path enablement" }
    );
    return rows.length > 0 && rows[0].analysis_worker_enabled === true;
  } catch (e) {
    // Fail-closed: table missing, permission error, etc. → legacy path
    console.warn(`[analysis-worker] isWorkerEnabledForRun failed, using legacy path: ${String(e).slice(0, 200)}`);
    return false;
  }
}

// ─── Population (complete & resumable) ──────────────────────────────────────

/**
 * Reconcile the full expected identity set into analysis_work_items.
 *
 * Every invocation:
 * 1. Computes the expected work identities from the routed chunks
 * 2. Computes generation_id from the sorted identities
 * 3. Inserts every missing identity (ON CONFLICT DO NOTHING = idempotent)
 * 4. Reconciles with existing pipeline_analysis using full identity match
 * 5. Verifies expected count vs present count
 * 6. Logs missing and unexpected identities
 *
 * A partially seeded queue NEVER appears complete because we verify counts.
 */
export async function populateWorkItems(
  ctx: PipelineContext,
  runId: string,
  chunks: ChunkDescriptor[],
  analysisVersion: string
): Promise<PopulateResult> {
  // Compute expected identities and generation
  const expectedIdentities = chunks.map(c =>
    computeWorkIdentity(runId, c.document_id, c.chunk_index, c.content_hash, analysisVersion)
  );
  const generationId = computeGenerationId(expectedIdentities);

  let inserted = 0;
  let skippedDuplicate = 0;
  let seededFromExisting = 0;

  // Load existing pipeline_analysis rows for reconciliation
  const existingAnalysis = await ctx.integrations.db.query(
    `SELECT chunk_index, prompt_version, model_used,
            document_id, chunk_hash, result_hash, fence_token
     FROM pipeline_analysis
     WHERE run_id = $1
     LIMIT 2000`,
    z.object({
      chunk_index: z.number(),
      prompt_version: z.string().nullable(),
      model_used: z.string().nullable(),
      document_id: z.string().nullable(),
      chunk_hash: z.string().nullable(),
      result_hash: z.string().nullable(),
      fence_token: z.string().nullable(),
    }),
    [runId],
    { label: "Load existing analysis for reconciliation" }
  );

  // Build reconciliation index: full identity match required
  const reconcileMap = new Map<string, typeof existingAnalysis[0]>();
  for (const row of existingAnalysis) {
    // Key by a combination that allows full identity lookup
    const key = `${row.chunk_index}:${row.document_id ?? ""}:${row.chunk_hash ?? ""}:${row.prompt_version ?? ""}`;
    reconcileMap.set(key, row);
  }

  // Insert all expected work items (batch of individual inserts for resumability)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const workIdentity = expectedIdentities[i];

    // Check full identity reconciliation
    const reconcileKey = `${chunk.chunk_index}:${chunk.document_id}:${chunk.content_hash}:${analysisVersion}`;
    const existingResult = reconcileMap.get(reconcileKey);

    // A result is reusable ONLY when full identity matches AND has a valid result_hash
    const canSeedComplete = existingResult != null &&
      existingResult.document_id === chunk.document_id &&
      existingResult.chunk_hash === chunk.content_hash &&
      existingResult.prompt_version === analysisVersion &&
      existingResult.result_hash != null &&
      existingResult.result_hash.length > 0;

    const status = canSeedComplete ? "complete" : "pending";
    const resultHash = canSeedComplete ? existingResult!.result_hash : null;
    const completedAt = canSeedComplete ? new Date().toISOString() : null;

    try {
      const result = await ctx.integrations.db.query(
        `INSERT INTO analysis_work_items (
          run_id, document_id, chunk_index, chunk_hash, analysis_version,
          work_identity, generation_id, status, result_hash, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
        ON CONFLICT (work_identity) DO NOTHING
        RETURNING id`,
        z.object({ id: z.string() }),
        [runId, chunk.document_id, chunk.chunk_index, chunk.content_hash, analysisVersion,
         workIdentity, generationId, status, resultHash, completedAt],
        { label: `Populate work item ${i + 1}/${chunks.length}` }
      );
      if (result.length > 0) {
        inserted++;
        if (canSeedComplete) seededFromExisting++;
      } else {
        skippedDuplicate++;
      }
    } catch (e) {
      // Individual insert failure is tolerable — next invocation retries
      console.warn(`[analysis-worker] populate item ${i} failed (will retry): ${String(e).slice(0, 200)}`);
    }
  }

  // Verify expected vs present count
  const presentRows = await ctx.integrations.db.query(
    `SELECT COUNT(*)::int AS cnt FROM analysis_work_items
     WHERE run_id = $1 AND generation_id = $2`,
    z.object({ cnt: z.number() }),
    [runId, generationId],
    { label: "Count present work items" }
  );
  const presentCount = presentRows[0]?.cnt ?? 0;
  const missingCount = chunks.length - presentCount;

  if (missingCount > 0) {
    console.warn(
      `[analysis-worker] Population incomplete: ${presentCount}/${chunks.length} present, ` +
      `${missingCount} missing (will retry next invocation)`
    );
  }

  return {
    inserted,
    skippedDuplicate,
    seededFromExisting,
    expectedCount: chunks.length,
    presentCount,
    missingCount,
    generationId,
  };
}

// ─── Claiming (atomic, fenced) ──────────────────────────────────────────────

/**
 * Generate a unique fence token for this claim.
 * Token = fnv1aHex(claimOwner + timestamp + random suffix)
 */
function generateFenceToken(claimOwner: string): string {
  return fnv1aHex(`${claimOwner}:${Date.now()}:${Math.random().toString(36).slice(2)}`);
}

/**
 * Claim a batch of work items for processing. Atomic via SELECT FOR UPDATE SKIP LOCKED.
 *
 * Also recovers expired leases first.
 * Each claimed item gets a unique fence_token that must be presented at completion.
 * Only claims items from the current generation.
 */
export async function claimBatch(
  ctx: PipelineContext,
  runId: string,
  claimOwner: string,
  batchSize: number,
  generationId: string
): Promise<{ claimed: ClaimedItem[]; recovered: number }> {
  // 1. Recover expired leases
  const recoveredRows = await ctx.integrations.db.query(
    `UPDATE analysis_work_items
     SET status = CASE
       WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'failed_permanent'
       ELSE 'pending'
     END,
     claim_owner = NULL,
     claimed_at = NULL,
     lease_expires = NULL,
     fence_token = NULL,
     updated_at = now()
     WHERE run_id = $1
       AND generation_id = $2
       AND status = 'claimed'
       AND lease_expires < now()
     RETURNING id`,
    z.object({ id: z.string() }),
    [runId, generationId],
    { label: "Recover expired leases" }
  );
  const recovered = recoveredRows.length;

  // 2. Claim batch with fence token
  const fenceToken = generateFenceToken(claimOwner);

  const claimed = await ctx.integrations.db.query(
    `UPDATE analysis_work_items
     SET status = 'claimed',
         claim_owner = $3,
         claimed_at = now(),
         lease_expires = now() + interval '${LEASE_TIMEOUT_MS / 1000} seconds',
         fence_token = $4,
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE id IN (
       SELECT id FROM analysis_work_items
       WHERE run_id = $1
         AND generation_id = $2
         AND status IN ('pending', 'failed_retryable')
         AND attempt_count < ${MAX_ATTEMPTS}
       ORDER BY chunk_index
       LIMIT $5
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, run_id, document_id, chunk_index, chunk_hash,
               analysis_version, work_identity, generation_id,
               attempt_count, fence_token`,
    z.object({
      id: z.string(),
      run_id: z.string(),
      document_id: z.string(),
      chunk_index: z.number(),
      chunk_hash: z.string(),
      analysis_version: z.string(),
      work_identity: z.string(),
      generation_id: z.string(),
      attempt_count: z.number(),
      fence_token: z.string(),
    }),
    [runId, generationId, claimOwner, fenceToken, batchSize],
    { label: `Claim batch of ${batchSize}` }
  );

  return { claimed, recovered };
}

// ─── Fenced Completion ──────────────────────────────────────────────────────

/**
 * Complete a work item with fenced write.
 *
 * Order of operations (critical for safety):
 * 1. CAS: validate ownership (status=claimed, owner, attempt, fence_token, lease not expired)
 *    → If fails: return rejected, do NOT write anything
 * 2. Write pipeline_analysis with fence_token embedded
 * 3. Read-back: verify full identity + fence_token + result_hash
 *    → If fails: revert work item to pending, return rejected
 * 4. Mark work item complete
 *
 * A stale worker can NEVER alter the authoritative pipeline_analysis row.
 */
export async function completeItem(
  ctx: PipelineContext,
  item: ClaimedItem,
  result: {
    label: string;
    extraction: string;
    chunkIndex: number;
    truncated: boolean;
    content_identity: { document_id: string; chunk_index: number; chunk_hash: string };
  },
  modelUsed: string,
  claimOwner: string
): Promise<CompleteResult> {
  // Step 1: CAS — validate ownership BEFORE any authoritative write
  // This is the fencing gate. If this fails, we never touch pipeline_analysis.
  const casResult = await ctx.integrations.db.query(
    `UPDATE analysis_work_items
     SET status = 'completing',
         updated_at = now()
     WHERE id = $1
       AND status = 'claimed'
       AND claim_owner = $2
       AND attempt_count = $3
       AND fence_token = $4
       AND lease_expires > now()
     RETURNING id`,
    z.object({ id: z.string() }),
    [item.id, claimOwner, item.attempt_count, item.fence_token],
    { label: `CAS ownership check chunk ${item.chunk_index}` }
  );

  if (casResult.length === 0) {
    console.warn(
      `[analysis-worker] STALE_WORKER_COMPLETION_REJECTED: ` +
      `item=${item.id} owner=${claimOwner} attempt=${item.attempt_count} chunk=${item.chunk_index}`
    );
    return { accepted: false, reason: "STALE_WORKER_COMPLETION_REJECTED" };
  }

  // Step 2: Compute canonical result hash
  const resultHash = computeResultHash({
    runId: item.run_id,
    chunkIndex: item.chunk_index,
    analysisVersion: item.analysis_version,
    label: result.label,
    extraction: result.extraction,
    truncated: result.truncated,
    contentIdentity: result.content_identity,
  });

  // Step 3: Write authoritative result to pipeline_analysis WITH fence_token
  // content_identity stored as JSON object (not nested string)
  await ctx.integrations.db.execute(
    `INSERT INTO pipeline_analysis (
      run_id, chunk_index, label, extraction, truncated, model_used,
      prompt_version, document_id, chunk_hash, work_identity,
      content_identity, result_hash, fence_token, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, now())
    ON CONFLICT (run_id, chunk_index)
    DO UPDATE SET
      label = EXCLUDED.label,
      extraction = EXCLUDED.extraction,
      truncated = EXCLUDED.truncated,
      model_used = EXCLUDED.model_used,
      prompt_version = EXCLUDED.prompt_version,
      document_id = EXCLUDED.document_id,
      chunk_hash = EXCLUDED.chunk_hash,
      work_identity = EXCLUDED.work_identity,
      content_identity = EXCLUDED.content_identity,
      result_hash = EXCLUDED.result_hash,
      fence_token = EXCLUDED.fence_token,
      updated_at = now()
    WHERE pipeline_analysis.fence_token IS NULL
       OR pipeline_analysis.fence_token = $13`,
    [
      item.run_id, item.chunk_index, result.label, result.extraction,
      result.truncated, modelUsed, item.analysis_version,
      item.document_id, item.chunk_hash, item.work_identity,
      JSON.stringify(result.content_identity), resultHash, item.fence_token,
    ],
    { label: `Write pipeline_analysis chunk ${item.chunk_index}` }
  );

  // Step 4: Read-back verification — full identity + fence_token + result_hash
  const readBack = await ctx.integrations.db.query(
    `SELECT run_id, chunk_index, work_identity, document_id, chunk_hash,
            prompt_version, result_hash, fence_token
     FROM pipeline_analysis
     WHERE run_id = $1 AND chunk_index = $2
     LIMIT 1`,
    z.object({
      run_id: z.string(),
      chunk_index: z.number(),
      work_identity: z.string().nullable(),
      document_id: z.string().nullable(),
      chunk_hash: z.string().nullable(),
      prompt_version: z.string().nullable(),
      result_hash: z.string().nullable(),
      fence_token: z.string().nullable(),
    }),
    [item.run_id, item.chunk_index],
    { label: `Verify pipeline_analysis chunk ${item.chunk_index}` }
  );

  const verified = readBack.length > 0 &&
    readBack[0].run_id === item.run_id &&
    readBack[0].chunk_index === item.chunk_index &&
    readBack[0].work_identity === item.work_identity &&
    readBack[0].document_id === item.document_id &&
    readBack[0].chunk_hash === item.chunk_hash &&
    readBack[0].prompt_version === item.analysis_version &&
    readBack[0].result_hash === resultHash &&
    readBack[0].fence_token === item.fence_token;

  if (!verified) {
    // Read-back failed — another worker with a different fence token owns this slot
    // Revert work item to pending for re-processing
    console.warn(
      `[analysis-worker] DUAL_WRITE_VERIFICATION_FAILED: ` +
      `item=${item.id} chunk=${item.chunk_index} fence=${item.fence_token} ` +
      `readBack fence=${readBack[0]?.fence_token ?? "null"}`
    );
    await ctx.integrations.db.execute(
      `UPDATE analysis_work_items SET status = 'pending', claim_owner = NULL,
       fence_token = NULL, updated_at = now() WHERE id = $1`,
      [item.id],
      { label: `Revert failed verification chunk ${item.chunk_index}` }
    );
    return { accepted: false, reason: "DUAL_WRITE_VERIFICATION_FAILED" };
  }

  // Step 5: Mark work item complete
  await ctx.integrations.db.execute(
    `UPDATE analysis_work_items
     SET status = 'complete',
         completed_at = now(),
         result_hash = $2,
         updated_at = now()
     WHERE id = $1`,
    [item.id, resultHash],
    { label: `Mark complete chunk ${item.chunk_index}` }
  );

  return { accepted: true };
}

// ─── Fenced Failure ─────────────────────────────────────────────────────────

/**
 * Mark a work item as failed (retryable or permanent based on attempt count).
 * Also validates fence_token to prevent stale workers from altering state.
 */
export async function failItem(
  ctx: PipelineContext,
  item: ClaimedItem,
  error: unknown,
  claimOwner: string
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error ?? "Unknown");
  const isPermanent = item.attempt_count >= MAX_ATTEMPTS;

  // Fenced failure: only the current owner can mark failure
  await ctx.integrations.db.execute(
    `UPDATE analysis_work_items
     SET status = $3,
         error_message = $4,
         claim_owner = NULL,
         fence_token = NULL,
         updated_at = now()
     WHERE id = $1
       AND claim_owner = $2
       AND fence_token = $5`,
    [
      item.id,
      claimOwner,
      isPermanent ? "failed_permanent" : "failed_retryable",
      errMsg.slice(0, 2000),
      item.fence_token,
    ],
    { label: `Fail item chunk ${item.chunk_index}` }
  );
}

// ─── Progress (scoped to current generation) ────────────────────────────────

/**
 * Get progress counts scoped to the current generation.
 * Only items matching the generation_id contribute to counts.
 * Also reports missing items (expected but not yet in the queue).
 */
export async function getAnalysisCounts(
  ctx: PipelineContext,
  runId: string,
  generationId: string,
  expectedCount: number
): Promise<GenerationCounts> {
  const rows = await ctx.integrations.db.query(
    `SELECT status, COUNT(*)::int AS cnt
     FROM analysis_work_items
     WHERE run_id = $1 AND generation_id = $2
     GROUP BY status`,
    z.object({ status: z.string(), cnt: z.number() }),
    [runId, generationId],
    { label: "Get generation counts" }
  );

  const counts: GenerationCounts = {
    total: 0,
    pending: 0,
    claimed: 0,
    complete: 0,
    failed_retryable: 0,
    failed_permanent: 0,
    expectedCount,
    missingFromQueue: 0,
  };

  for (const row of rows) {
    counts.total += row.cnt;
    const key = row.status.replace(/-/g, "_") as keyof GenerationCounts;
    if (key in counts && key !== "total" && key !== "expectedCount" && key !== "missingFromQueue") {
      (counts as unknown as Record<string, number>)[key] = row.cnt;
    }
  }

  counts.missingFromQueue = Math.max(0, expectedCount - counts.total);
  return counts;
}

/**
 * Is analysis complete for the current generation?
 * Complete = every expected identity is represented AND all are terminal (complete or failed_permanent).
 * A partially seeded queue NEVER reports complete.
 */
export async function isAnalysisComplete(
  ctx: PipelineContext,
  runId: string,
  generationId: string,
  expectedCount: number
): Promise<boolean> {
  const counts = await getAnalysisCounts(ctx, runId, generationId, expectedCount);

  // Queue not fully populated yet
  if (counts.missingFromQueue > 0) return false;
  if (counts.total < expectedCount) return false;

  // All items must be terminal
  const nonTerminal = counts.pending + counts.claimed + counts.failed_retryable;
  return nonTerminal === 0;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Detect mismatches between work items and pipeline_analysis.
 * Used for observability — does not affect execution.
 */
export async function detectMismatches(
  ctx: PipelineContext,
  runId: string,
  generationId: string
): Promise<{ mismatches: Array<{ chunk_index: number; issue: string }> }> {
  // Find complete work items where pipeline_analysis doesn't match
  const rows = await ctx.integrations.db.query(
    `SELECT wi.chunk_index, wi.work_identity, wi.result_hash AS wi_hash,
            pa.result_hash AS pa_hash, pa.fence_token AS pa_fence, wi.fence_token AS wi_fence
     FROM analysis_work_items wi
     LEFT JOIN pipeline_analysis pa ON pa.run_id = wi.run_id AND pa.chunk_index = wi.chunk_index
     WHERE wi.run_id = $1 AND wi.generation_id = $2 AND wi.status = 'complete'
       AND (pa.result_hash IS NULL OR pa.result_hash != wi.result_hash
            OR pa.work_identity IS NULL OR pa.work_identity != wi.work_identity)
     LIMIT 50`,
    z.object({
      chunk_index: z.number(),
      work_identity: z.string(),
      wi_hash: z.string().nullable(),
      pa_hash: z.string().nullable(),
      pa_fence: z.string().nullable(),
      wi_fence: z.string().nullable(),
    }),
    [runId, generationId],
    { label: "Detect dual-write mismatches" }
  );

  return {
    mismatches: rows.map(r => ({
      chunk_index: r.chunk_index,
      issue: r.pa_hash == null
        ? "pipeline_analysis row missing"
        : r.pa_hash !== r.wi_hash
          ? `result_hash mismatch: work_item=${r.wi_hash} pa=${r.pa_hash}`
          : `work_identity mismatch`,
    })),
  };
}

// ─── Exports for testing ─────────────────────────────────────────────────────

export { fnv1aHex };
export { LEASE_TIMEOUT_MS, MAX_ATTEMPTS };
