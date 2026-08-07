/**
 * materiality-tiering-stage.ts — MG-4
 *
 * Production Stage 4.6: Tiers each absence-surviving genuine-omission finding
 * (Tier 1/2/3) using Claude Sonnet, with checkpoint/resume so it completes
 * across the 240s invocation limit.
 *
 * Insertion point: AFTER Stage 4.5 (absence gate) and BEFORE Stage 5 / the
 * existing enforceMaterialityGate in runPostMergePipeline.
 *
 * Eligible findings (absence survivors):
 *   - gap_type === "memo_omission"
 *   - absence_verification === "memo_absent_confirmed"
 *   - absence_verification === "thesis_drift"
 *
 * Non-eligible findings (non-absence / demoted / housekeeping) are NOT tiered.
 *
 * Output: mutates each eligible finding in-place, attaching:
 *   - materiality_tier: 1 | 2 | 3
 *   - tier_rationale: string
 *   - tier_driver: string
 *
 * SAFETY FLOOR: a finding that cannot be tiered (timeout / parse fail) defaults
 * to tier 2 with rationale "tiering incomplete — defaulted, needs review". It is
 * NEVER dropped and NEVER silently assigned tier 3.
 *
 * --------------------------------------------------------------------------
 * DEAL_CONTEXT + buildPrompt: COPIED verbatim from diag-materiality.ts.
 * TODO: Before this stage runs on any deal other than SCG (Project Saint),
 * DEAL_CONTEXT must become deal-derived (pulled from the deal record / IC memo
 * metadata) rather than a hardcoded constant. This is a known limitation.
 * --------------------------------------------------------------------------
 */

import { z } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";

// ---------------------------------------------------------------------------
// Local query function type (mirrors AbsenceGateQueryFn from pipeline-core
// to avoid circular import — pipeline-core imports this module)
// ---------------------------------------------------------------------------

export type QueryFn = (
  sql: string,
  schema: z.ZodType<any>,
  params: unknown[],
  meta?: { label: string }
) => Promise<any[]>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONCURRENCY = 5;
/** Invocation time budget in ms. */
const INVOCATION_BUDGET_MS = 240_000;
/** Safety margin: stop accepting new work this many ms before deadline. */
const SAFETY_MARGIN_MS = 45_000;
/** Model to use for all tiering calls. */
const TIERING_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Deal context — COPIED verbatim from diag-materiality.ts.
// TODO: DEAL_CONTEXT must become deal-derived before this runs on any deal
// other than SCG (Project Saint). See module docstring above.
// ---------------------------------------------------------------------------
const DEAL_CONTEXT = `Project Saint / SCG. Enterprise Value £655m (11.6x LTM Sep-26 Cash EBITDA), plus £85m earn-out above 2.5x MoM. PEP base case: 23.0% IRR / 2.8x MoM; 6x opening leverage. Thesis: (1) verticalisation — own-IP platforms Surgery Connect (55% GP share) and Evonex growing ~30%; (2) vendor-agnostic SME comms one-stop-shop, 35k+ customers, ~7% churn; (3) industrialised M&A, ~50 acquisitions, £6m EBITDA near-term pipeline; (4) re-rating as own-IP mix grows 30%→43%; (5) backable management. Key return drivers: retention holding, M&A continuing, AI ancillary upsell into Surgery Connect, education vertical for Evonex.`;

// ---------------------------------------------------------------------------
// Prompt — COPIED verbatim from diag-materiality.ts buildPrompt().
// TODO: Replace DEAL_CONTEXT with deal-derived value before using on other deals.
// ---------------------------------------------------------------------------
function buildPrompt(title: string): string {
  return `You are an IC member assessing a due-diligence finding that is ABSENT from the investment memos. Given the DEAL CONTEXT below, assign a materiality tier:
  TIER 1 (DEAL-CHANGING): could kill the deal, materially move the price, or break the base-case return (23% IRR / 2.8x). Reserve for findings a partner would want on the first page.
  TIER 2 (CONDITION / DILIGENCE): a real issue requiring a condition to close or a specific diligence follow-up, but not a threat to the thesis or returns.
  TIER 3 (NOTED / IMMATERIAL): genuine but immaterial to the investment decision at this deal size.
Judge materiality RELATIVE TO THE DEAL (a £60k liability is immaterial on a £655m EV; an uncapped indemnity on a top customer may not be). Do NOT tier by how alarming the wording is — most findings are worded as risks. Be STRICT with Tier 1: if most findings are Tier 1, you are miscalibrated. Return JSON only:
  {"tier":1|2|3, "rationale":"one sentence tying it to deal impact", "driver":"which return driver / thesis pillar it affects, or 'none'"}
DEAL CONTEXT: ${DEAL_CONTEXT}
FINDING: ${title}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TierAssignment {
  tier: 1 | 2 | 3;
  rationale: string;
  driver: string;
}

export interface TieredResult {
  totalEligible: number;
  tieredCount: number;
  skippedFromCheckpoint: number;
  partial: boolean;
  /** finding_ids not yet tiered (only populated when partial=true) */
  untieredFindingIds: string[];
}

// ---------------------------------------------------------------------------
// Anthropic response schema (minimal — only needs text content)
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

// ---------------------------------------------------------------------------
// AI function type (matches PostMergePipelineInput.aiFn)
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

// ---------------------------------------------------------------------------
// Checkpoint table schema (CREATE IF NOT EXISTS — no migration needed)
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mg4_materiality_tier_checkpoints (
  checkpoint_key TEXT NOT NULL,
  finding_id     TEXT NOT NULL,
  tier           INTEGER NOT NULL,
  rationale      TEXT NOT NULL,
  driver         TEXT NOT NULL,
  tiered_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (checkpoint_key, finding_id)
)`;

const CheckpointRowSchema = z.object({
  finding_id: z.string(),
  tier: z.coerce.number(),
  rationale: z.string(),
  driver: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbsenceSurvivor(f: CanonicalFinding): boolean {
  const av = (f as any).absence_verification as string | undefined;
  return (
    f.gap_type === "memo_omission" ||
    av === "memo_absent_confirmed" ||
    av === "thesis_drift"
  );
}

function parseTierResponse(text: string): TierAssignment | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    if (!cleaned.startsWith("{")) {
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed.tier !== "number" || typeof parsed.rationale !== "string" || typeof parsed.driver !== "string") {
      return null;
    }
    const tier = parsed.tier as number;
    if (tier !== 1 && tier !== 2 && tier !== 3) return null;
    return { tier: tier as 1 | 2 | 3, rationale: parsed.rationale, driver: parsed.driver };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-finding tier call — fail-loud but wrapped so caller can apply safety floor
// ---------------------------------------------------------------------------

async function callTierModel(
  aiFn: AiFn,
  finding: CanonicalFinding,
): Promise<TierAssignment> {
  const prompt = buildPrompt(finding.title);

  const result = await aiFn(
    {
      method: "POST",
      path: "/v1/messages",
      body: {
        model: TIERING_MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      },
    },
    { response: MessageResponseSchema },
    { label: `mg4-tier: ${finding.finding_id.slice(0, 8)} — ${finding.title.slice(0, 50)}` }
  );

  const textBlock = result.content.find((c: any) => c.type === "text");
  if (!textBlock) throw new Error(`[mg4-tier] No text content for ${finding.finding_id}`);

  const assignment = parseTierResponse(textBlock.text);
  if (!assignment) throw new Error(`[mg4-tier] Parse failed for ${finding.finding_id}: ${textBlock.text.slice(0, 200)}`);

  return assignment;
}

// ---------------------------------------------------------------------------
// Main export: tierFindings
// ---------------------------------------------------------------------------

/**
 * Tier each absence-surviving finding (Tier 1/2/3) via Sonnet.
 *
 * - Loads already-tiered finding_ids from checkpoint and skips them (resume).
 * - Tracks elapsed time; if within SAFETY_MARGIN_MS of deadline, persists
 *   progress and returns partial=true with untieredFindingIds.
 * - Safety floor: if a call fails (any error), assigns tier 2 with
 *   "tiering incomplete — defaulted, needs review" (NEVER tier 3, NEVER dropped).
 * - Mutates findings in-place (attaches materiality_tier, tier_rationale, tier_driver).
 *
 * @param findings       All surviving findings post-absence-gate
 * @param queryFn        DB query/execute function (bound postgres client method)
 * @param aiFn           Anthropic API function (bound anthropic client method)
 * @param checkpointKey  Stable key for this run's checkpoint (e.g. runId + ":materiality")
 * @param invocationStart  Date.now() from the start of the invocation (for deadline tracking)
 */
export async function tierFindings(
  findings: CanonicalFinding[],
  queryFn: QueryFn,
  aiFn: AiFn,
  checkpointKey: string,
  invocationStart: number = Date.now(),
): Promise<TieredResult> {
  const deadlineMs = invocationStart + INVOCATION_BUDGET_MS - SAFETY_MARGIN_MS;

  // 1. Ensure checkpoint table exists
  try {
    await queryFn(CREATE_TABLE_SQL, z.any(), [], { label: "mg4: ensure checkpoint table" });
  } catch (ddlErr: unknown) {
    const msg = ddlErr && typeof ddlErr === "object" && "message" in ddlErr
      ? String((ddlErr as { message: unknown }).message)
      : String(ddlErr);
    // "already exists" is expected on non-first runs — suppress silently.
    // All other DDL errors (permissions, connection) are logged loudly so they surface.
    if (!/already exists/i.test(msg)) {
      console.error(`[mg4-tier] CHECKPOINT TABLE CREATION FAILED: ${msg}. Subsequent checkpoint reads/writes will fail.`);
      throw ddlErr;
    }
  }

  // 2. Load already-tiered finding_ids for this checkpointKey
  let existingRows: any[];
  try {
    existingRows = await queryFn(
      `SELECT finding_id, tier, rationale, driver
       FROM mg4_materiality_tier_checkpoints
       WHERE checkpoint_key = $1`,
      CheckpointRowSchema,
      [checkpointKey],
      { label: "mg4: load checkpoint" }
    );
  } catch (loadErr: unknown) {
    const msg = loadErr && typeof loadErr === "object" && "message" in loadErr
      ? String((loadErr as { message: unknown }).message)
      : String(loadErr);
    // "does not exist" / "undefined_table" → first invocation, table just created;
    // treat as empty checkpoint (expected on first run before any rows exist).
    if (/does not exist|undefined_table|42P01/i.test(msg)) {
      existingRows = [];
    } else {
      // Real error (permission, schema mismatch, connection): fail loud.
      console.error(`[mg4-tier] CHECKPOINT LOAD FAILED (not a missing-table case): ${msg}`);
      throw loadErr;
    }
  }

  const checkpointMap = new Map<string, TierAssignment>();
  for (const row of existingRows) {
    const tier = Number(row.tier);
    if (tier === 1 || tier === 2 || tier === 3) {
      checkpointMap.set(row.finding_id, {
        tier: tier as 1 | 2 | 3,
        rationale: row.rationale,
        driver: row.driver,
      });
    }
  }
  const skippedFromCheckpoint = checkpointMap.size;

  // 3. Identify eligible (absence-surviving) findings not already tiered
  const eligible = findings.filter(isAbsenceSurvivor);
  const toTier = eligible.filter(f => !checkpointMap.has(f.finding_id));

  console.log(
    `[mg4-tier] eligible=${eligible.length}, checkpointed=${skippedFromCheckpoint}, to-tier=${toTier.length}, ` +
    `checkpointKey=${checkpointKey}`
  );

  // 4. Apply already-checkpointed tiers to findings
  for (const f of eligible) {
    const cached = checkpointMap.get(f.finding_id);
    if (cached) {
      f.materiality_tier = cached.tier;
      f.tier_rationale = cached.rationale;
      f.tier_driver = cached.driver;
    }
  }

  if (toTier.length === 0) {
    console.log(`[mg4-tier] All ${eligible.length} findings already tiered from checkpoint.`);
    return {
      totalEligible: eligible.length,
      tieredCount: skippedFromCheckpoint,
      skippedFromCheckpoint,
      partial: false,
      untieredFindingIds: [],
    };
  }

  // 5. Tier remaining findings with bounded concurrency + time budget
  let idx = 0;
  let tieredThisInvocation = 0;
  let timedOut = false;
  const untieredFindingIds: string[] = [];

  async function worker(): Promise<void> {
    while (idx < toTier.length) {
      // Check time budget BEFORE taking the next item
      if (Date.now() >= deadlineMs) {
        timedOut = true;
        break;
      }

      const myIdx = idx++;
      if (myIdx >= toTier.length) break;

      const f = toTier[myIdx];
      let assignment: TierAssignment;

      try {
        assignment = await callTierModel(aiFn, f);
      } catch (err: unknown) {
        // Safety floor: default to tier 2, never tier 3, never drop
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
        console.warn(`[mg4-tier] Failed to tier ${f.finding_id}: ${msg}. Defaulting to tier 2.`);
        assignment = {
          tier: 2,
          rationale: "tiering incomplete — defaulted, needs review",
          driver: "unknown",
        };
      }

      // Attach to finding in-place
      f.materiality_tier = assignment.tier;
      f.tier_rationale = assignment.rationale;
      f.tier_driver = assignment.driver;

      // Persist checkpoint row (fire-and-forget; don't let persist failure block the run)
      queryFn(
        `INSERT INTO mg4_materiality_tier_checkpoints (checkpoint_key, finding_id, tier, rationale, driver)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (checkpoint_key, finding_id) DO UPDATE
           SET tier = EXCLUDED.tier, rationale = EXCLUDED.rationale,
               driver = EXCLUDED.driver, tiered_at = now()`,
        z.any(),
        [checkpointKey, f.finding_id, assignment.tier, assignment.rationale, assignment.driver],
        { label: "mg4: persist tier checkpoint" }
      ).catch((e: unknown) => {
        const msg = e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
        console.warn(`[mg4-tier] Checkpoint persist failed for ${f.finding_id}: ${msg}`);
      });

      tieredThisInvocation++;
    }
  }

  // Run bounded concurrency pool
  const workers = Array.from({ length: Math.min(CONCURRENCY, toTier.length) }, () => worker());
  await Promise.all(workers);

  // 6. Collect un-tiered findings (if timed out)
  if (timedOut) {
    for (let i = idx; i < toTier.length; i++) {
      const f = toTier[i];
      if (!f.materiality_tier) {
        untieredFindingIds.push(f.finding_id);
      }
    }
    console.log(
      `[mg4-tier] Time budget exhausted: tiered ${tieredThisInvocation} this invocation, ` +
      `${untieredFindingIds.length} remaining for next invocation.`
    );
  }

  const totalTiered = skippedFromCheckpoint + tieredThisInvocation;
  const isPartial = timedOut && untieredFindingIds.length > 0;

  console.log(
    `[mg4-tier] Complete: totalEligible=${eligible.length}, tiered=${totalTiered}, ` +
    `partial=${isPartial}, untiered=${untieredFindingIds.length}`
  );

  return {
    totalEligible: eligible.length,
    tieredCount: totalTiered,
    skippedFromCheckpoint,
    partial: isPartial,
    untieredFindingIds,
  };
}
