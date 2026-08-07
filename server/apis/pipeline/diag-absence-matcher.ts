/**
 * EM-2 Diagnostic API — Absence Map Matcher Verification
 *
 * Standalone API that:
 *   1. Builds the engagement map (EM-1) for the deal (first batch only)
 *   2. Loads findings from the largest completed OA run
 *   3. Runs the per-finding absence matcher against the map
 *   4. Returns full dispositions for manual verification
 *
 * dumpMode: persists progress to diag_absence_sessions table and resumes
 * across invocations. When all findings processed, use dumpPart to read
 * results in chunks.
 *
 * Resume behavior: On subsequent calls with the same sessionId, skips the
 * engagement map rebuild (cached in session state) and only processes
 * unclassified absence findings.
 *
 * Read-only: no writes to production tables, no finding modifications.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildEngagementMap } from "./engagement-map.js";
import {
  matchSingleFinding,
  isAbsenceClaim,
  decisionToDisposition,
  formatCompactMap,
  runWithConcurrency,
  type FindingInput,
  type MatchResult,
  type MatcherAIFn,
} from "./absence-map-matcher.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

/** Max concurrent LLM calls during resume */
const RESUME_CONCURRENCY = 5;
/** Time budget safety margin */
const TIME_BUDGET_SAFETY_MS = 40_000;

// ---------------------------------------------------------------------------
// Session persistence types
// ---------------------------------------------------------------------------

interface PersistedAbsenceState {
  runId: string;
  dealId: string;
  totalFindings: number;
  latestFullMemoOrder: number;
  model: string;
  /** Compact engagement map text — cached so resume doesn't rebuild it */
  compactMap: string;
  /** All results processed so far (full array, indexed by finding position) */
  results: MatchResult[];
  /** Whether all findings have been processed */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const MatchResultSchema = z.object({
  finding_id: z.string(),
  title: z.string(),
  is_absence_claim: z.boolean(),
  decision: z.string().nullable(),
  disposition: z.string(),
  matched_topic: z.string().nullable(),
  matched_memos: z.array(z.number()),
  reason: z.string().nullable(),
});

const SummarySchema = z.object({
  absence_total: z.number(),
  demote: z.number(),
  surface_thesis_drift: z.number(),
  surface_omission: z.number(),
  flag: z.number(),
  not_applicable: z.number(),
});

const OutputSchema = z.object({
  deal_id: z.string(),
  run_id: z.string(),
  latest_full_memo_order: z.number(),
  model_used: z.string(),
  results: z.array(MatchResultSchema),
  summary: SummarySchema,
  partial: z.boolean(),
  // dump mode fields
  sessionId: z.string().nullable(),
  processed: z.number().nullable(),
  total: z.number().nullable(),
  dumpJson: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "DiagAbsenceMatcher",
  description: "Matches absence findings against engagement map via LLM with batch persistence",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().nullable().describe("Deal ID; null = SCG deal"),
    runId: z.string().nullable().describe("Module run ID; null = auto-select largest OA run"),
    dumpMode: z.boolean().nullable().describe("Enable batch persistence + dump mode"),
    sessionId: z.string().nullable().describe("Resume existing session"),
    dumpPart: z.string().nullable().describe("Dump part: summary, demote, omission, thesis-drift, flag, not-applicable"),
    dumpOffset: z.number().nullable().describe("Pagination offset for large dumps (default 0)"),
    dumpLimit: z.number().nullable().describe("Pagination limit for large dumps (default 50)"),
  }),

  output: OutputSchema,

  async run(ctx, { dealId, runId, dumpMode, sessionId: sessionIdInput, dumpPart, dumpOffset, dumpLimit }) {
    const targetDeal = dealId ?? SCG_DEAL_ID;

    // ═══════════════════════════════════════════════════════════════════════
    // Ensure session table exists (idempotent)
    // ═══════════════════════════════════════════════════════════════════════
    if (dumpMode) {
      await ctx.integrations.db.query(
        `CREATE TABLE IF NOT EXISTS diag_absence_sessions (
          id TEXT NOT NULL,
          batch_number INT NOT NULL DEFAULT 1,
          state_json JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          PRIMARY KEY (id, batch_number)
        )`,
        z.object({}),
        [],
        { label: "Ensure diag_absence_sessions table" }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DUMP PART MODE: read already-computed results from session table
    // ═══════════════════════════════════════════════════════════════════════
    if (dumpMode && dumpPart && sessionIdInput) {
      const stateRows = await ctx.integrations.db.query(
        `SELECT state_json FROM diag_absence_sessions
         WHERE id = $1 ORDER BY batch_number DESC LIMIT 1`,
        z.object({ state_json: z.any() }),
        [sessionIdInput],
        { label: "Load session state for dump" }
      );
      if (stateRows.length === 0) throw new Error(`No state found for session ${sessionIdInput}`);
      const state: PersistedAbsenceState = stateRows[0].state_json as PersistedAbsenceState;

      if (!state.complete) {
        throw new Error(`Session not complete: ${state.results.filter(r => r.decision !== null || !r.is_absence_claim).length} of ${state.totalFindings} processed`);
      }

      const results = state.results;
      const makeDumpReturn = (json: string) => ({
        deal_id: state.dealId,
        run_id: state.runId,
        latest_full_memo_order: state.latestFullMemoOrder,
        model_used: state.model,
        results: [],
        summary: computeSummary(results),
        partial: false,
        sessionId: sessionIdInput,
        processed: results.length,
        total: state.totalFindings,
        dumpJson: json,
      });

      if (dumpPart === "summary") {
        const counts = computeSummary(results);
        const summaryObj = {
          run_id: state.runId,
          deal_id: state.dealId,
          total_findings: state.totalFindings,
          counts: {
            demote_false_positive: counts.demote,
            surface_omission: counts.surface_omission,
            surface_thesis_drift: counts.surface_thesis_drift,
            flag_uncertain: counts.flag,
            not_absence_claim: counts.not_applicable,
          },
          processed: results.filter(r => r.decision !== null || !r.is_absence_claim).length,
          unprocessed: results.filter(r => r.is_absence_claim && r.decision === null).length,
          model: state.model,
          latest_full_memo_order: state.latestFullMemoOrder,
        };
        return makeDumpReturn(JSON.stringify(summaryObj, null, 2));
      }

      if (dumpPart === "demote") {
        const demoted = results
          .filter(r => r.disposition === "demote")
          .map(r => ({
            finding_id: r.finding_id,
            title: r.title,
            matched_topic: r.matched_topic,
            matched_memos: r.matched_memos,
            reason: r.reason,
          }));
        return makeDumpReturn(JSON.stringify(demoted, null, 2));
      }

      if (dumpPart === "omission") {
        const omissions = results
          .filter(r => r.disposition === "surface_omission")
          .map(r => ({
            finding_id: r.finding_id,
            title: r.title,
            reason: r.reason,
          }));
        const offset = dumpOffset ?? 0;
        const limit = dumpLimit ?? 50;
        const page = omissions.slice(offset, offset + limit);
        const envelope = { total: omissions.length, offset, limit, items: page };
        return makeDumpReturn(JSON.stringify(envelope, null, 2));
      }

      if (dumpPart === "thesis-drift") {
        const drift = results
          .filter(r => r.disposition === "surface_thesis_drift")
          .map(r => ({
            finding_id: r.finding_id,
            title: r.title,
            matched_memos: r.matched_memos,
            reason: r.reason,
          }));
        return makeDumpReturn(JSON.stringify(drift, null, 2));
      }

      if (dumpPart === "flag") {
        const flagged = results
          .filter(r => r.disposition === "flag")
          .map(r => ({
            finding_id: r.finding_id,
            title: r.title,
            reason: r.reason,
          }));
        return makeDumpReturn(JSON.stringify(flagged, null, 2));
      }

      if (dumpPart === "not-applicable") {
        const na = results
          .filter(r => r.disposition === "not_applicable")
          .map(r => ({
            finding_id: r.finding_id,
            title: r.title,
          }));
        return makeDumpReturn(JSON.stringify(na, null, 2));
      }

      throw new Error(`Unknown dumpPart: ${dumpPart}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROCESSING MODE: run the matcher (with or without persistence)
    // ═══════════════════════════════════════════════════════════════════════

    // ── Load existing session state if resuming ────────────────────────────
    let existingState: PersistedAbsenceState | null = null;
    const sessionId = sessionIdInput ?? crypto.randomUUID();

    if (dumpMode && sessionIdInput) {
      const existingRows = await ctx.integrations.db.query(
        `SELECT batch_number, state_json FROM diag_absence_sessions
         WHERE id = $1 ORDER BY batch_number DESC LIMIT 1`,
        z.object({ batch_number: z.number(), state_json: z.any() }),
        [sessionId],
        { label: "Check existing session progress" }
      );
      if (existingRows.length > 0) {
        existingState = existingRows[0].state_json as PersistedAbsenceState;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RESUME PATH: skip engagement map rebuild, process remaining findings
    // ═══════════════════════════════════════════════════════════════════════
    if (dumpMode && existingState && !existingState.complete) {
      const deadlineMs = Date.now() + 220_000;
      const aiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as unknown as MatcherAIFn;
      const cachedMap = existingState.compactMap;
      const latestFullMemoOrder = existingState.latestFullMemoOrder;
      const allResults = [...existingState.results];

      // Find unprocessed absence findings (is_absence_claim=true, decision=null)
      const unprocessedIndices: number[] = [];
      for (let i = 0; i < allResults.length; i++) {
        if (allResults[i].is_absence_claim && allResults[i].decision === null) {
          unprocessedIndices.push(i);
        }
      }

      if (unprocessedIndices.length === 0) {
        // Already complete — mark and return
        existingState.complete = true;
        await persistState(ctx, sessionId, existingState);
        return buildOutput(existingState, sessionId, false);
      }

      // Process remaining findings using cached compact map
      const findingsToProcess = unprocessedIndices.map(idx => ({
        finding: {
          finding_id: allResults[idx].finding_id,
          title: allResults[idx].title,
          detail: allResults[idx].reason ?? "",
        } as FindingInput,
        globalIdx: idx,
      }));

      const { results: matchResults, completed } = await runWithConcurrency(
        findingsToProcess,
        RESUME_CONCURRENCY,
        async (item) => {
          return matchSingleFinding(
            item.finding,
            cachedMap,
            latestFullMemoOrder,
            aiFn,
          );
        },
        () => (deadlineMs - Date.now()) < TIME_BUDGET_SAFETY_MS,
      );

      // Apply results back
      for (let i = 0; i < findingsToProcess.length; i++) {
        if (i < completed && matchResults[i]) {
          const mr = matchResults[i];
          const idx = findingsToProcess[i].globalIdx;
          allResults[idx] = {
            ...allResults[idx],
            decision: mr.decision,
            disposition: decisionToDisposition(mr.decision),
            matched_topic: mr.matched_topic,
            matched_memos: mr.matched_memos,
            reason: mr.reason,
          };
        }
      }

      // Determine if complete
      const stillUnprocessed = allResults.filter(r => r.is_absence_claim && r.decision === null).length;
      const isComplete = stillUnprocessed === 0;

      const newState: PersistedAbsenceState = {
        ...existingState,
        results: allResults,
        complete: isComplete,
      };

      await persistState(ctx, sessionId, newState);
      return buildOutput(newState, sessionId, !isComplete);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FIRST RUN: Build engagement map + classify + start matching
    // ═══════════════════════════════════════════════════════════════════════
    const deadlineMs = Date.now() + 220_000;

    // ── Step 1: Build engagement map ──────────────────────────────────────
    const engagementMap = await buildEngagementMap(
      ctx.integrations.db.query.bind(ctx.integrations.db),
      ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
      targetDeal,
      deadlineMs,
    );

    // Determine latest full memo order
    const fullMemos = engagementMap.memos.filter((m: any) => !/IC update/i.test(m.memo_file));
    const latestFullMemoOrder = fullMemos.length > 0
      ? Math.max(...fullMemos.map((m: any) => m.memo_order))
      : (engagementMap.memos.length > 0 ? Math.max(...engagementMap.memos.map((m: any) => m.memo_order)) : 1);

    // Build compact map text (cache this for resume)
    const compactMap = formatCompactMap(engagementMap, latestFullMemoOrder);

    // ── Step 2: Resolve OA run ────────────────────────────────────────────
    let resolvedRunId: string;

    if (runId) {
      resolvedRunId = runId;
    } else {
      const AutoSelectRow = z.object({ id: z.string() });
      const autoRows = await ctx.integrations.db.query(
        `SELECT mr.id
         FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        AutoSelectRow,
        [targetDeal],
        { label: "Auto-select largest OA run" }
      );
      if (autoRows.length === 0) {
        throw new Error("No completed omission_audit runs found for this deal");
      }
      resolvedRunId = autoRows[0].id;
    }

    // ── Step 3: Load findings ─────────────────────────────────────────────
    const FindingsRow = z.object({ findings: z.any() });
    const findingsRows = await ctx.integrations.db.query(
      `SELECT findings FROM module_outputs WHERE module_run_id = $1`,
      FindingsRow,
      [resolvedRunId],
      { label: "Fetch module_outputs findings" }
    );

    if (findingsRows.length === 0) {
      throw new Error(`No module_outputs found for run ${resolvedRunId}`);
    }

    const rawFindings: Array<any> = Array.isArray(findingsRows[0].findings)
      ? findingsRows[0].findings
      : [];

    // Map to minimal FindingInput shape
    const findings: FindingInput[] = rawFindings.map((f: any) => ({
      finding_id: f.finding_id ?? f.id ?? "unknown",
      title: f.title ?? "",
      detail: f.detail ?? "",
      gap_type: f.gap_type,
      finding_kind: f.finding_kind,
    }));

    // ── Step 4: Classify findings + attempt initial matching ──────────────
    const aiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as unknown as MatcherAIFn;
    const allResults: MatchResult[] = [];
    const absenceIndices: number[] = [];

    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      if (isAbsenceClaim(f)) {
        absenceIndices.push(i);
        allResults.push({
          finding_id: f.finding_id,
          title: f.title,
          is_absence_claim: true,
          decision: null,
          disposition: "flag",
          matched_topic: null,
          matched_memos: [],
          reason: null,
        });
      } else {
        allResults.push({
          finding_id: f.finding_id,
          title: f.title,
          is_absence_claim: false,
          decision: null,
          disposition: "not_applicable",
          matched_topic: null,
          matched_memos: [],
          reason: null,
        });
      }
    }

    // Try to process some absence findings if time remains
    const remainingTime = deadlineMs - Date.now();
    if (remainingTime > TIME_BUDGET_SAFETY_MS) {
      const absenceFindings = absenceIndices.map(idx => ({
        finding: findings[idx],
        globalIdx: idx,
      }));

      const { results: matchResults, completed } = await runWithConcurrency(
        absenceFindings,
        RESUME_CONCURRENCY,
        async (item) => {
          return matchSingleFinding(
            item.finding,
            compactMap,
            latestFullMemoOrder,
            aiFn,
          );
        },
        () => (deadlineMs - Date.now()) < TIME_BUDGET_SAFETY_MS,
      );

      for (let i = 0; i < absenceFindings.length; i++) {
        if (i < completed && matchResults[i]) {
          const mr = matchResults[i];
          const idx = absenceFindings[i].globalIdx;
          allResults[idx] = {
            ...allResults[idx],
            decision: mr.decision,
            disposition: decisionToDisposition(mr.decision),
            matched_topic: mr.matched_topic,
            matched_memos: mr.matched_memos,
            reason: mr.reason,
          };
        }
      }
    }

    // Determine if complete
    const stillUnprocessed = allResults.filter(r => r.is_absence_claim && r.decision === null).length;
    const isComplete = stillUnprocessed === 0;

    // ── Persist (dumpMode) ────────────────────────────────────────────────
    if (dumpMode) {
      const newState: PersistedAbsenceState = {
        runId: resolvedRunId,
        dealId: targetDeal,
        totalFindings: findings.length,
        latestFullMemoOrder,
        model: "claude-sonnet-4-6",
        compactMap,
        results: allResults,
        complete: isComplete,
      };

      await persistState(ctx, sessionId, newState);
      return buildOutput(newState, sessionId, !isComplete);
    }

    // ── Non-persistent mode (original behavior) ───────────────────────────
    return {
      deal_id: targetDeal,
      run_id: resolvedRunId,
      latest_full_memo_order: latestFullMemoOrder,
      model_used: "claude-sonnet-4-6",
      results: allResults,
      summary: computeSummary(allResults),
      partial: !isComplete,
      sessionId: null,
      processed: null,
      total: null,
      dumpJson: null,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSummary(results: MatchResult[]) {
  return {
    absence_total: results.filter(r => r.is_absence_claim).length,
    demote: results.filter(r => r.disposition === "demote").length,
    surface_thesis_drift: results.filter(r => r.disposition === "surface_thesis_drift").length,
    surface_omission: results.filter(r => r.disposition === "surface_omission").length,
    flag: results.filter(r => r.disposition === "flag").length,
    not_applicable: results.filter(r => r.disposition === "not_applicable").length,
  };
}

function buildOutput(state: PersistedAbsenceState, sessionId: string, partial: boolean) {
  const processed = state.results.filter(r => r.decision !== null || !r.is_absence_claim).length;
  return {
    deal_id: state.dealId,
    run_id: state.runId,
    latest_full_memo_order: state.latestFullMemoOrder,
    model_used: state.model,
    results: [],
    summary: computeSummary(state.results),
    partial,
    sessionId,
    processed,
    total: state.totalFindings,
    dumpJson: null,
  };
}

async function persistState(ctx: any, sessionId: string, state: PersistedAbsenceState) {
  // Get next batch number
  const batchRows = await ctx.integrations.db.query(
    `SELECT COALESCE(MAX(batch_number), 0) + 1 AS next FROM diag_absence_sessions WHERE id = $1`,
    z.object({ next: z.number() }),
    [sessionId],
    { label: "Get next batch number" }
  );
  const batchNumber = batchRows[0].next;

  await ctx.integrations.db.query(
    `INSERT INTO diag_absence_sessions (id, batch_number, state_json)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id, batch_number) DO UPDATE SET state_json = $3::jsonb`,
    z.object({}),
    [sessionId, batchNumber, JSON.stringify(state)],
    { label: "Persist absence matcher session state" }
  );
}
