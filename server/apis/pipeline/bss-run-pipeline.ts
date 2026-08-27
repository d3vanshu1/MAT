/**
 * BSS v2 — Packet 6: Orchestrator.
 *
 * BssRunPipeline — resumable, one-stage-per-invocation orchestrator for
 * the Blind Spot Scanner v2 pipeline.
 *
 * EXECUTION MODEL:
 *   - Each invocation reads `bss_pipeline_state` to find the first non-complete stage.
 *   - Claims ownership via an owner_token CAS on the `_lock` row.
 *   - Runs ONE stage, marks it complete, and returns.
 *   - The UI re-invokes to advance — the orchestrator never loops across stages.
 *
 * LOOP STAGES (coverage_sweep, adjudication):
 *   - Resume per-candidate within the same stage across invocations.
 *   - Query unprocessed candidates (missing coverage row / missing adjudicated_verdict).
 *   - Process until elapsed time exceeds STAGE_BUDGET_MS, then return `stage_partial`.
 *   - Next invocation re-enters the same stage and continues from where it left off.
 *
 * STAGE DISPATCH:
 *   - Calls exported core functions from each stage file — no logic duplicated.
 *   - Profile/Generate: `runBuildProfileCore`, `runBssGenerateCore`
 *   - Sweep/Adjudication: `sweepOneCandidate`/`upsertOneCoverageRow`,
 *     `adjudicateOneCandidate`/`checkOneDependency`/`computeAndWriteDisposition`
 *
 * CONCURRENCY:
 *   - `bss_pipeline_state._lock` row with token CAS prevents concurrent runs.
 *   - Staleness threshold: 10 minutes — if a previous owner hasn't heartbeated
 *     in 10 min, the lock is reclaimable.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runBuildProfileCore, type ProfileKind } from "./bss-profile.js";
import { runBssGenerateCore } from "./bss-generate.js";
import { sweepOneCandidate, upsertOneCoverageRow } from "./bss-absence-sweep.js";
import {
  adjudicateOneCandidate,
  checkOneDependency,
  computeAndWriteDisposition,
} from "./bss-llm-adjudication.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-PIPELINE]";

// ---------------------------------------------------------------------------
// Pipeline constants
// ---------------------------------------------------------------------------

/** Ordered stages — the canonical pipeline sequence. */
const STAGES = [
  "structural_profile",
  "thesis_profile",
  "blind_pass",
  "informed_pass",
  "coverage_sweep",
  "adjudication",
] as const;
type StageName = (typeof STAGES)[number];

/** Stages that iterate per-candidate and may need multiple invocations. */
const LOOP_STAGES: ReadonlySet<string> = new Set(["coverage_sweep", "adjudication"]);

/**
 * Budget (ms) for loop stages — stop starting new candidates past this.
 * 240s gives a 60s margin before the 300s platform kill.
 */
const STAGE_BUDGET_MS = 240_000;

/** Staleness threshold for ownership reclaim (ms). */
const STALENESS_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PipelineStateRow = z.object({
  deal_id: z.string(),
  stage: z.string(),
  status: z.string(),
  started_at: z.string().nullable(),
  items_done: z.coerce.number().nullable(),
  items_total: z.coerce.number().nullable(),
  error: z.string().nullable(),
  owner_token: z.string().nullable(),
});

const ProfileIdRow = z.object({
  profile_id: z.string(),
});

const CandidateRow = z.object({
  candidate_id: z.string(),
  failure_mode: z.string(),
  pass_type: z.string(),
  proposed_queries: z.any(),
});

const AdjCandidateRow = z.object({
  candidate_id: z.string(),
  failure_mode: z.string(),
  pass_type: z.string(),
  implied_assumption: z.string(),
  hypothesis: z.string(),
  proposed_queries: z.any(),
  old_verdict: z.string().nullable(),
});

const DocSchema = z.object({
  id: z.string(),
  file_name: z.string(),
});

const ClaimedRow = z.object({ deal_id: z.string() });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "BssRunPipeline",
  description: "One-stage-per-invocation orchestrator for BSS v2 pipeline",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    ownerToken: z.string().uuid(),
  }),

  output: z.object({
    status: z.enum(["advanced", "stage_partial", "done", "failed", "owned_elsewhere"]),
    stage: z.string().nullable(),
    nextStage: z.string().nullable(),
    itemsDone: z.number().nullable(),
    itemsTotal: z.number().nullable(),
    error: z.string().nullable(),
    elapsedMs: z.number(),
  }),

  async run(ctx, { dealId, ownerToken }) {
    const startTime = Date.now();
    const db = ctx.integrations.db;
    const ai = ctx.integrations.ai;

    // ── 0. Ensure bss_pipeline_state has owner_token column ──────────────
    await db.execute(
      `ALTER TABLE bss_pipeline_state ADD COLUMN IF NOT EXISTS owner_token UUID NULL`,
      [],
      { label: "Ensure owner_token column" },
    );

    // ── 1. Ensure rows exist for all stages + _lock ─────────────────────
    for (const stage of [...STAGES, "_lock"]) {
      await db.execute(
        `INSERT INTO bss_pipeline_state (deal_id, stage, status)
         VALUES ($1::uuid, $2, 'pending')
         ON CONFLICT (deal_id, stage) DO NOTHING`,
        [dealId, stage],
        { label: `Init stage: ${stage}` },
      );
    }

    // ── 2. Token CAS — claim or refresh ownership ───────────────────────
    const claimed = await db.query(
      `UPDATE bss_pipeline_state
       SET owner_token = $2::uuid,
           started_at  = now(),
           status      = 'running'
       WHERE deal_id = $1::uuid
         AND stage = '_lock'
         AND (
           owner_token IS NULL
           OR owner_token = $2::uuid
           OR started_at < now() - interval '${Math.floor(STALENESS_MS / 1000)} seconds'
         )
       RETURNING deal_id`,
      ClaimedRow,
      [dealId, ownerToken],
      { label: "CAS ownership claim" },
    );

    if (claimed.length === 0) {
      console.log(`${LOG_PREFIX} Ownership CAS failed — another owner holds the lock.`);
      return {
        status: "owned_elsewhere" as const,
        stage: null,
        nextStage: null,
        itemsDone: null,
        itemsTotal: null,
        error: null,
        elapsedMs: Date.now() - startTime,
      };
    }

    // ── 3. Read pipeline state — find first non-complete stage ───────────
    const stateRows = await db.query(
      `SELECT deal_id, stage, status, started_at::text, items_done, items_total, error, owner_token::text
       FROM bss_pipeline_state
       WHERE deal_id = $1::uuid AND stage != '_lock'
       ORDER BY array_position(ARRAY['structural_profile','thesis_profile','blind_pass','informed_pass','coverage_sweep','adjudication'], stage)`,
      PipelineStateRow,
      [dealId],
      { label: "Read pipeline state" },
    );

    const stateMap = new Map(stateRows.map((r) => [r.stage, r]));

    // Find first non-complete stage
    let currentStage: StageName | null = null;
    for (const stage of STAGES) {
      const row = stateMap.get(stage);
      if (!row || row.status !== "complete") {
        currentStage = stage;
        break;
      }
    }

    // All stages complete
    if (currentStage === null) {
      console.log(`${LOG_PREFIX} All 6 stages complete for deal ${dealId}.`);
      return {
        status: "done" as const,
        stage: null,
        nextStage: null,
        itemsDone: null,
        itemsTotal: null,
        error: null,
        elapsedMs: Date.now() - startTime,
      };
    }

    console.log(`${LOG_PREFIX} Entering stage: ${currentStage}`);

    // ── 4. Mark stage as running ─────────────────────────────────────────
    await db.execute(
      `UPDATE bss_pipeline_state
       SET status = 'running', started_at = now(), error = NULL
       WHERE deal_id = $1::uuid AND stage = $2`,
      [dealId, currentStage],
      { label: `Mark running: ${currentStage}` },
    );

    // ── 5. Dispatch stage ────────────────────────────────────────────────
    try {
      const result = await dispatchStage(db, ai, dealId, currentStage, startTime);

      if (result.partial) {
        // Loop stage hit budget — stay 'running'
        await db.execute(
          `UPDATE bss_pipeline_state
           SET items_done = $3, items_total = $4, started_at = now()
           WHERE deal_id = $1::uuid AND stage = $2`,
          [dealId, currentStage, result.itemsDone, result.itemsTotal],
          { label: `Heartbeat partial: ${currentStage}` },
        );

        const nextStage = currentStage; // same stage next invocation
        console.log(
          `${LOG_PREFIX} Stage ${currentStage} partial: ${result.itemsDone}/${result.itemsTotal} done.`,
        );
        return {
          status: "stage_partial" as const,
          stage: currentStage,
          nextStage,
          itemsDone: result.itemsDone,
          itemsTotal: result.itemsTotal,
          error: null,
          elapsedMs: Date.now() - startTime,
        };
      }

      // Stage complete
      await db.execute(
        `UPDATE bss_pipeline_state
         SET status = 'complete', completed_at = now(),
             items_done = $3, items_total = $4
         WHERE deal_id = $1::uuid AND stage = $2`,
        [dealId, currentStage, result.itemsDone, result.itemsTotal],
        { label: `Mark complete: ${currentStage}` },
      );

      // Refresh lock heartbeat
      await db.execute(
        `UPDATE bss_pipeline_state SET started_at = now() WHERE deal_id = $1::uuid AND stage = '_lock'`,
        [dealId],
        { label: "Refresh lock heartbeat" },
      );

      const idx = STAGES.indexOf(currentStage);
      const nextStage = idx < STAGES.length - 1 ? STAGES[idx + 1] : null;

      console.log(
        `${LOG_PREFIX} Stage ${currentStage} complete. Next: ${nextStage ?? "DONE"}`,
      );
      return {
        status: "advanced" as const,
        stage: currentStage,
        nextStage,
        itemsDone: result.itemsDone,
        itemsTotal: result.itemsTotal,
        error: null,
        elapsedMs: Date.now() - startTime,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Stage ${currentStage} FAILED: ${msg}`);

      await db.execute(
        `UPDATE bss_pipeline_state
         SET status = 'failed', error = $3
         WHERE deal_id = $1::uuid AND stage = $2`,
        [dealId, currentStage, msg.slice(0, 2000)],
        { label: `Mark failed: ${currentStage}` },
      );

      return {
        status: "failed" as const,
        stage: currentStage,
        nextStage: null,
        itemsDone: null,
        itemsTotal: null,
        error: msg.slice(0, 2000),
        elapsedMs: Date.now() - startTime,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Stage dispatch — calls existing exported functions, never reimplements
// ---------------------------------------------------------------------------

interface StageResult {
  partial: boolean;
  itemsDone: number;
  itemsTotal: number;
}

type DbClient = {
  query: (sql: string, schema: any, params: unknown[], meta?: { label: string }) => Promise<any[]>;
  execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any>;
};
type AiClient = {
  apiRequest: (req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: any }, meta?: { label: string }) => Promise<any>;
};

async function dispatchStage(
  db: DbClient,
  ai: AiClient,
  dealId: string,
  stage: StageName,
  startTime: number,
): Promise<StageResult> {
  switch (stage) {
    case "structural_profile":
      return dispatchProfile(db, ai, dealId, "structural");
    case "thesis_profile":
      return dispatchProfile(db, ai, dealId, "thesis");
    case "blind_pass":
      return dispatchGenerate(db, ai, dealId, "blind");
    case "informed_pass":
      return dispatchGenerate(db, ai, dealId, "informed");
    case "coverage_sweep":
      return dispatchCoverageSweep(db, dealId, startTime);
    case "adjudication":
      return dispatchAdjudication(db, ai, dealId, startTime);
  }
}

// ── Profile dispatch ──────────────────────────────────────────────────────

async function dispatchProfile(
  db: DbClient,
  ai: AiClient,
  dealId: string,
  profileKind: "structural" | "thesis",
): Promise<StageResult> {
  // Reuse check: if a profile for this (deal_id, profile_kind) already exists,
  // skip — this is the orchestrator's reuse decision.
  const existing = await db.query(
    `SELECT profile_id FROM bss_profiles
     WHERE deal_id = $1::uuid AND profile_kind = $2
     ORDER BY profile_version DESC LIMIT 1`,
    ProfileIdRow,
    [dealId, profileKind],
    { label: `Check existing ${profileKind} profile` },
  );

  if (existing.length > 0) {
    console.log(
      `${LOG_PREFIX} ${profileKind} profile already exists (${existing[0].profile_id}), reusing.`,
    );
    return { partial: false, itemsDone: 1, itemsTotal: 1 };
  }

  // Build new profile — delegates to the extracted core function
  await runBuildProfileCore(db, ai, dealId, profileKind as ProfileKind);
  console.log(`${LOG_PREFIX} ${profileKind} profile built.`);
  return { partial: false, itemsDone: 1, itemsTotal: 1 };
}

// ── Generate dispatch ─────────────────────────────────────────────────────

async function dispatchGenerate(
  db: DbClient,
  ai: AiClient,
  dealId: string,
  passType: "blind" | "informed",
): Promise<StageResult> {
  // Skip check: if candidates for this pass_type already exist, skip.
  const countRows = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM bss_candidates WHERE deal_id = $1::uuid AND pass_type = $2`,
    z.object({ cnt: z.coerce.number() }),
    [dealId, passType],
    { label: `Count ${passType} candidates` },
  );
  if (countRows[0].cnt > 0) {
    console.log(
      `${LOG_PREFIX} ${passType} pass already has ${countRows[0].cnt} candidates, skipping.`,
    );
    return { partial: false, itemsDone: countRows[0].cnt, itemsTotal: countRows[0].cnt };
  }

  // Get profile_id — blind uses structural, informed uses thesis
  const expectedKind = passType === "blind" ? "structural" : "thesis";
  const profileRows = await db.query(
    `SELECT profile_id FROM bss_profiles
     WHERE deal_id = $1::uuid AND profile_kind = $2
     ORDER BY profile_version DESC LIMIT 1`,
    ProfileIdRow,
    [dealId, expectedKind],
    { label: `Get ${expectedKind} profile for ${passType} pass` },
  );
  if (profileRows.length === 0) {
    throw new Error(`No ${expectedKind} profile found for deal ${dealId} — cannot run ${passType} pass.`);
  }

  await runBssGenerateCore(db, ai, dealId, profileRows[0].profile_id, passType);
  console.log(`${LOG_PREFIX} ${passType} pass generated.`);
  return { partial: false, itemsDone: 1, itemsTotal: 1 };
}

// ── Coverage sweep dispatch (loop stage, per-candidate resume) ────────────

async function dispatchCoverageSweep(
  db: DbClient,
  dealId: string,
  startTime: number,
): Promise<StageResult> {
  // Total candidates (for progress reporting)
  const allCandRows = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM bss_candidates
     WHERE deal_id = $1::uuid AND superseded_by IS NULL`,
    z.object({ cnt: z.coerce.number() }),
    [dealId],
    { label: "Count total candidates" },
  );
  const totalCandidates = allCandRows[0].cnt;

  // Query candidates that LACK a coverage row with a verdict
  const pending = await db.query(
    `SELECT c.candidate_id, c.failure_mode, c.pass_type, c.proposed_queries
     FROM bss_candidates c
     WHERE c.deal_id = $1::uuid
       AND c.superseded_by IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM bss_coverage cv
         WHERE cv.candidate_id = c.candidate_id AND cv.verdict IS NOT NULL
       )
     ORDER BY c.pass_type, c.failure_mode`,
    CandidateRow,
    [dealId],
    { label: "Query unswept candidates" },
  );

  if (pending.length === 0) {
    console.log(`${LOG_PREFIX} coverage_sweep: all ${totalCandidates} candidates have coverage rows.`);
    return { partial: false, itemsDone: totalCandidates, itemsTotal: totalCandidates };
  }

  const alreadyDone = totalCandidates - pending.length;
  console.log(
    `${LOG_PREFIX} coverage_sweep: ${pending.length} pending, ${alreadyDone} already done.`,
  );

  // Load documents (needed by sweepOneCandidate)
  const docs = await db.query(
    `SELECT DISTINCT d.id, d.file_name
     FROM documents d
     JOIN document_chunks dc ON dc.document_id = d.id
     WHERE d.deal_id = $1::uuid
     ORDER BY d.file_name`,
    DocSchema,
    [dealId],
    { label: "Load searchable documents" },
  );
  const documentsSearched = docs.map((d) => ({ id: d.id, file_name: d.file_name }));

  // Process per-candidate with budget check
  let processed = 0;
  for (const cand of pending) {
    // Budget check: stop starting new candidates past STAGE_BUDGET_MS
    const elapsed = Date.now() - startTime;
    if (elapsed >= STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} coverage_sweep: budget exhausted at ${elapsed}ms after ${processed} candidates this invocation.`,
      );
      return {
        partial: true,
        itemsDone: alreadyDone + processed,
        itemsTotal: totalCandidates,
      };
    }

    // Sweep this candidate — delegates to exported function
    const coverageRow = await sweepOneCandidate(db, cand, dealId, documentsSearched);
    await upsertOneCoverageRow(db, coverageRow);
    processed++;

    // Per-candidate heartbeat on the _lock row
    await db.execute(
      `UPDATE bss_pipeline_state
       SET started_at = now(), items_done = $3, items_total = $4
       WHERE deal_id = $1::uuid AND stage = 'coverage_sweep'`,
      [dealId, "coverage_sweep", alreadyDone + processed, totalCandidates],
      { label: `Heartbeat: sweep ${alreadyDone + processed}/${totalCandidates}` },
    );
  }

  // All pending candidates processed — stage complete
  console.log(
    `${LOG_PREFIX} coverage_sweep: all ${totalCandidates} candidates swept (${processed} this invocation).`,
  );
  return { partial: false, itemsDone: totalCandidates, itemsTotal: totalCandidates };
}

// ── Adjudication dispatch (loop stage, per-candidate resume) ──────────────

async function dispatchAdjudication(
  db: DbClient,
  ai: AiClient,
  dealId: string,
  startTime: number,
): Promise<StageResult> {
  // Ensure adjudication columns exist (idempotent)
  await db.execute(
    `ALTER TABLE bss_coverage
       ADD COLUMN IF NOT EXISTS adjudicated_verdict text,
       ADD COLUMN IF NOT EXISTS adjudication_quote text,
       ADD COLUMN IF NOT EXISTS adjudication_reason text`,
    [],
    { label: "Ensure adjudication columns" },
  );

  // Total candidates
  const allCandRows = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM bss_candidates
     WHERE deal_id = $1::uuid AND superseded_by IS NULL`,
    z.object({ cnt: z.coerce.number() }),
    [dealId],
    { label: "Count total candidates for adjudication" },
  );
  const totalCandidates = allCandRows[0].cnt;

  // Query candidates whose bss_coverage row lacks adjudicated_verdict
  const pending = await db.query(
    `SELECT c.candidate_id, c.failure_mode, c.pass_type,
            c.implied_assumption, c.hypothesis, c.proposed_queries,
            cv.verdict AS old_verdict
     FROM bss_candidates c
     JOIN bss_coverage cv ON cv.candidate_id = c.candidate_id
     WHERE c.deal_id = $1::uuid
       AND c.superseded_by IS NULL
       AND cv.adjudicated_verdict IS NULL
     ORDER BY c.pass_type, c.failure_mode`,
    AdjCandidateRow,
    [dealId],
    { label: "Query unadjudicated candidates" },
  );

  if (pending.length === 0) {
    console.log(`${LOG_PREFIX} adjudication: all ${totalCandidates} candidates adjudicated.`);
    return { partial: false, itemsDone: totalCandidates, itemsTotal: totalCandidates };
  }

  const alreadyDone = totalCandidates - pending.length;
  console.log(
    `${LOG_PREFIX} adjudication: ${pending.length} pending, ${alreadyDone} already done.`,
  );

  let processed = 0;
  for (const cand of pending) {
    // Budget check
    const elapsed = Date.now() - startTime;
    if (elapsed >= STAGE_BUDGET_MS) {
      console.log(
        `${LOG_PREFIX} adjudication: budget exhausted at ${elapsed}ms after ${processed} candidates this invocation.`,
      );
      return {
        partial: true,
        itemsDone: alreadyDone + processed,
        itemsTotal: totalCandidates,
      };
    }

    // Adjudicate — delegates to exported function
    const adj = await adjudicateOneCandidate(
      db, ai, cand, dealId, cand.old_verdict ?? "unknown",
    );

    // Dependency check (non-ADDRESSED only)
    let dep = null;
    if (adj.adjudicated_verdict !== "ADDRESSED") {
      dep = await checkOneDependency(db, cand, dealId);
    }

    // Disposition
    await computeAndWriteDisposition(db, adj, dep, dealId);

    processed++;

    // Per-candidate heartbeat
    await db.execute(
      `UPDATE bss_pipeline_state
       SET started_at = now(), items_done = $3, items_total = $4
       WHERE deal_id = $1::uuid AND stage = 'adjudication'`,
      [dealId, "adjudication", alreadyDone + processed, totalCandidates],
      { label: `Heartbeat: adjudication ${alreadyDone + processed}/${totalCandidates}` },
    );
  }

  console.log(
    `${LOG_PREFIX} adjudication: all ${totalCandidates} candidates done (${processed} this invocation).`,
  );
  return { partial: false, itemsDone: totalCandidates, itemsTotal: totalCandidates };
}
