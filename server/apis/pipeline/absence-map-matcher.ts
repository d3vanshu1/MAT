/**
 * Absence Map Matcher (EM-2)
 *
 * For each absence-claim finding, makes ONE Sonnet call to match the finding's
 * topic against the per-memo engagement map (from EM-1). Produces a three-way
 * disposition:
 *   - DISCLOSED_LATEST (A)   → demote (false positive)
 *   - DROPPED_FROM_LATEST (B)→ surface_thesis_drift
 *   - NEVER_DISCLOSED (C)    → surface_omission (genuine)
 *   - UNSURE (D)             → flag (safe fallback)
 *
 * Does NOT modify findings. Only computes and returns dispositions.
 * Pipeline wiring is EM-3.
 */
import { z } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";
import type { EngagementMapResult, MemoEntry } from "./engagement-map.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absence-claim detection regex — replicated from pipeline-core.ts */
const ABSENCE_CLAIM_PATTERN = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed|not surfaced|not reflected|not mentioned|undisclosed|not flagged|not highlighted)\b/i;

/** Time budget safety margin — stop processing if within this of deadline */
const TIME_BUDGET_SAFETY_MS = 40_000;

/** Max concurrent LLM calls */
const MAX_CONCURRENCY = 5;

/** Max tokens for the per-finding matcher response */
const MATCHER_MAX_TOKENS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Decision = "A" | "B" | "C" | "D";
export type Disposition =
  | "demote"
  | "surface_thesis_drift"
  | "surface_omission"
  | "flag"
  | "not_applicable";

export interface MatchResult {
  finding_id: string;
  title: string;
  is_absence_claim: boolean;
  decision: Decision | null;
  disposition: Disposition;
  matched_topic: string | null;
  matched_memos: number[];
  reason: string | null;
}

export interface MatcherOutput {
  deal_id: string;
  run_id: string;
  latest_full_memo_order: number;
  model_used: string;
  results: MatchResult[];
  summary: {
    absence_total: number;
    demote: number;
    surface_thesis_drift: number;
    surface_omission: number;
    flag: number;
    not_applicable: number;
  };
  partial: boolean;
}

/** Minimal finding shape we need from module_outputs */
export interface FindingInput {
  finding_id: string;
  title: string;
  detail: string;
  gap_type?: string;
  finding_kind?: string;
}

export interface MatcherAIFn {
  (req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }): Promise<any>;
}

// ---------------------------------------------------------------------------
// Absence claim detection
// ---------------------------------------------------------------------------

function isAbsenceClaim(f: FindingInput): boolean {
  if (f.gap_type === "memo_omission") return true;
  const textToCheck = `${f.title ?? ""} ${f.detail ?? ""}`;
  return ABSENCE_CLAIM_PATTERN.test(textToCheck);
}

// ---------------------------------------------------------------------------
// Decision → Disposition mapping
// ---------------------------------------------------------------------------

function decisionToDisposition(decision: Decision): Disposition {
  switch (decision) {
    case "A": return "demote";
    case "B": return "surface_thesis_drift";
    case "C": return "surface_omission";
    case "D": return "flag";
  }
}

// ---------------------------------------------------------------------------
// LLM response schema
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
// Compact map formatter
// ---------------------------------------------------------------------------

function formatCompactMap(map: EngagementMapResult, latestFullMemoOrder: number): string {
  const lines: string[] = [];
  for (const memo of map.memos) {
    const isLatest = memo.memo_order === latestFullMemoOrder;
    const isSupplement = /IC update/i.test(memo.memo_file);
    let label = `MEMO ${memo.memo_order}: "${memo.memo_file}"`;
    if (isLatest) label += " [LATEST FULL MEMO]";
    if (isSupplement) label += " [UPDATE SUPPLEMENT]";
    lines.push(label);
    for (const t of memo.engaged_topics) {
      lines.push(`  • ${t.topic} — "${t.evidence}"`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt for per-finding matching
// ---------------------------------------------------------------------------

function buildMatcherPrompt(latestFullMemoOrder: number): string {
  return `You are judging whether a due-diligence finding's "not disclosed in the IC memo" claim is correct, using ONLY the engagement map provided.

The engagement map lists what each IC memo SUBSTANTIVELY ENGAGES WITH (extracted separately). Memo ${latestFullMemoOrder} is the latest full memo. Any memo labeled "[UPDATE SUPPLEMENT]" is a later addendum but not the primary reference.

DECISION RULES:
A) DISCLOSED_LATEST — The latest full memo (memo ${latestFullMemoOrder}) OR the update supplement engage with the SPECIFIC topic this finding claims is undisclosed. The "not disclosed" claim is FALSE.
B) DROPPED_FROM_LATEST — An EARLIER memo engages with this topic but the latest full memo (memo ${latestFullMemoOrder}) does NOT. This is thesis drift.
C) NEVER_DISCLOSED — NO memo engages with this topic at all. Genuine omission.
D) UNSURE — You cannot confidently decide from the map.

CRITICAL JUDGMENT RULES:
- Judge the SPECIFIC issue the finding raises, not just the broad subject area.
- If the finding is about a specific sub-aspect that the memos only address generally, that is NOT disclosure of the specific issue → do NOT pick A.
- If choosing between A and D, choose D. Wrongly picking A suppresses a real finding; D is the safe fallback.
- "matched_topic" must be the exact topic label from the map, or null if none match.
- "matched_memos" must list the memo_order integers where the topic appears.

Return ONLY valid JSON:
{"decision":"A","matched_topic":"<exact map topic label or null>","matched_memos":[<memo_order ints>],"reason":"<one sentence>"}`;
}

// ---------------------------------------------------------------------------
// Single finding matcher
// ---------------------------------------------------------------------------

async function matchSingleFinding(
  finding: FindingInput,
  compactMap: string,
  latestFullMemoOrder: number,
  aiFn: MatcherAIFn,
): Promise<{ decision: Decision; matched_topic: string | null; matched_memos: number[]; reason: string }> {
  const userMessage = `FINDING: ${finding.title} — ${finding.detail}\n\nENGAGEMENT MAP:\n${compactMap}`;

  try {
    const response = await aiFn(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SONNET_MODEL,
          max_tokens: MATCHER_MAX_TOKENS,
          system: buildMatcherPrompt(latestFullMemoOrder),
          messages: [{ role: "user", content: userMessage }],
        },
      },
      { response: MessageResponseSchema },
      { label: `EM2: Match finding "${finding.title.slice(0, 50)}"` },
    );

    const text = response.content?.[0]?.text ?? "";
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { decision: "D", matched_topic: null, matched_memos: [], reason: "parse_failure: no JSON in response" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const decision = parsed.decision;
    if (!["A", "B", "C", "D"].includes(decision)) {
      return { decision: "D", matched_topic: null, matched_memos: [], reason: `parse_failure: invalid decision "${decision}"` };
    }

    return {
      decision: decision as Decision,
      matched_topic: parsed.matched_topic ?? null,
      matched_memos: Array.isArray(parsed.matched_memos) ? parsed.matched_memos : [],
      reason: parsed.reason ?? "",
    };
  } catch (e: any) {
    return { decision: "D", matched_topic: null, matched_memos: [], reason: `error: ${e?.message ?? String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Concurrency-limited executor
// ---------------------------------------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<{ results: R[]; completed: number }> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      if (shouldStop?.()) return;
      results[idx] = await fn(items[idx], idx);
      completed++;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { results, completed };
}

// ---------------------------------------------------------------------------
// Main matcher function
// ---------------------------------------------------------------------------

/**
 * Match all findings against the engagement map.
 *
 * @param findings - Full findings array from module_outputs
 * @param engagementMap - Result from buildEngagementMap (EM-1)
 * @param aiFn - Anthropic API request function
 * @param dealId - Deal ID
 * @param runId - Module run ID
 * @param deadlineMs - Absolute timestamp by which we must finish
 * @returns MatcherOutput with dispositions per finding
 */
export async function matchAbsenceFindings(
  findings: FindingInput[],
  engagementMap: EngagementMapResult,
  aiFn: MatcherAIFn,
  dealId: string,
  runId: string,
  deadlineMs: number,
): Promise<MatcherOutput> {
  const model = SONNET_MODEL;

  // Determine latest full memo order:
  // Highest memo_order among memos NOT labeled as "IC update" supplement
  const fullMemos = engagementMap.memos.filter(m => !/IC update/i.test(m.memo_file));
  const latestFullMemoOrder = fullMemos.length > 0
    ? Math.max(...fullMemos.map(m => m.memo_order))
    : (engagementMap.memos.length > 0 ? Math.max(...engagementMap.memos.map(m => m.memo_order)) : 1);

  // Build compact map text once
  const compactMap = formatCompactMap(engagementMap, latestFullMemoOrder);

  // Classify findings
  const allResults: MatchResult[] = [];
  const absenceFindings: { finding: FindingInput; idx: number }[] = [];

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (isAbsenceClaim(f)) {
      absenceFindings.push({ finding: f, idx: i });
      // Placeholder — will be filled
      allResults.push({
        finding_id: f.finding_id,
        title: f.title,
        is_absence_claim: true,
        decision: null,
        disposition: "flag", // default safe
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

  // Process absence findings with bounded concurrency
  let partial = false;
  const absenceItems = absenceFindings.map(af => af.finding);

  const { results: matchResults, completed } = await runWithConcurrency(
    absenceItems,
    MAX_CONCURRENCY,
    async (finding) => {
      return matchSingleFinding(finding, compactMap, latestFullMemoOrder, aiFn);
    },
    () => (deadlineMs - Date.now()) < TIME_BUDGET_SAFETY_MS,
  );

  // Apply results back
  for (let i = 0; i < absenceFindings.length; i++) {
    const af = absenceFindings[i];
    const resultSlot = allResults[af.idx];
    if (i < completed && matchResults[i]) {
      const mr = matchResults[i];
      resultSlot.decision = mr.decision;
      resultSlot.disposition = decisionToDisposition(mr.decision);
      resultSlot.matched_topic = mr.matched_topic;
      resultSlot.matched_memos = mr.matched_memos;
      resultSlot.reason = mr.reason;
    } else {
      // Not processed due to time budget
      partial = true;
      resultSlot.decision = null;
      resultSlot.disposition = "flag";
      resultSlot.reason = "time_budget_exceeded";
    }
  }

  // Compute summary
  const summary = {
    absence_total: absenceFindings.length,
    demote: allResults.filter(r => r.disposition === "demote").length,
    surface_thesis_drift: allResults.filter(r => r.disposition === "surface_thesis_drift").length,
    surface_omission: allResults.filter(r => r.disposition === "surface_omission").length,
    flag: allResults.filter(r => r.disposition === "flag").length,
    not_applicable: allResults.filter(r => r.disposition === "not_applicable").length,
  };

  return {
    deal_id: dealId,
    run_id: runId,
    latest_full_memo_order: latestFullMemoOrder,
    model_used: model,
    results: allResults,
    summary,
    partial,
  };
}
