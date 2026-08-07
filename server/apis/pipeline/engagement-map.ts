/**
 * Engagement Map Builder (EM-1)
 *
 * Reads each IC memo ONCE via LLM and extracts the topics the memo SUBSTANTIVELY
 * ENGAGES WITH. Produces a structured map (per-memo topic list with evidence)
 * for later use in absence-verification gating.
 *
 * Cost is tied to the number of MEMOS (typically 3-5), not findings.
 * The map is finding-independent: no findings are passed to the LLM call.
 *
 * This module exposes reusable logic. The API wrapper is in diag-engagement-map.ts.
 */
import { z } from "@superblocksteam/sdk-api";
import { SONNET_MODEL } from "./model-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** IC memo file_name pattern */
const IC_MEMO_FILE_PATTERN = /IC[_ ].*Memo|IC update/i;

/** Maximum characters per memo text fed to the LLM */
const MEMO_TEXT_CAP = 180_000;

/** Time budget safety margin — stop processing if within this many ms of the deadline */
const TIME_BUDGET_SAFETY_MS = 40_000;

/** Max tokens for the engagement extraction response */
const ENGAGEMENT_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngagedTopic {
  topic: string;
  evidence: string;
}

export interface MemoEntry {
  memo_file: string;
  memo_order: number;
  chunk_count: number;
  truncated: boolean;
  engaged_topics: EngagedTopic[];
  error?: string;
}

export interface EngagementMapResult {
  deal_id: string;
  memos: MemoEntry[];
  model_used: string;
  partial: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// MemoDocSchema removed — inline z.object used in query

const ChunkRowSchema = z.object({
  content: z.string(),
  chunk_index: z.coerce.number(),
});

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
// Query function interface (injectable for testing)
// ---------------------------------------------------------------------------

export interface EngagementMapQueryFn {
  (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }): Promise<any[]>;
}

export interface EngagementMapAIFn {
  (req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }): Promise<any>;
}

// ---------------------------------------------------------------------------
// Memo date extraction for chronological ordering
// ---------------------------------------------------------------------------

/**
 * Extracts a date from a memo file_name for chronological sorting.
 * Patterns: "2026-05-18 SCG - 2nd IC Memo", "SCG IC Screening Memo",
 * "2026-06-21 Saint IC update_vS.pdf"
 */
function extractMemoDate(fileName: string): number {
  // Try YYYY-MM-DD pattern
  const isoMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return new Date(isoMatch[1]).getTime();
  }
  // Screening memo = earliest (no date prefix means it was first)
  if (/screening/i.test(fileName)) {
    return 0;
  }
  // Fallback: return a large number (sort last)
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Extract memo ordinal from file_name for disambiguation.
 * "2nd IC Memo" → 2, "3rd IC Memo" → 3, "IC update" → 99 (latest supplement)
 */
function extractMemoOrdinal(fileName: string): number {
  if (/screening/i.test(fileName)) return 0;
  const ordMatch = fileName.match(/(\d+)(?:st|nd|rd|th)\s+IC/i);
  if (ordMatch) return parseInt(ordMatch[1], 10);
  if (/IC update/i.test(fileName)) return 99;
  return 50; // Unknown — middle
}

// ---------------------------------------------------------------------------
// System prompt for engagement extraction
// ---------------------------------------------------------------------------

const ENGAGEMENT_SYSTEM_PROMPT = `You are reading one Investment Committee (IC) memo. Your task is to list the distinct TOPICS this memo SUBSTANTIVELY ENGAGES WITH.

A topic is "engaged" ONLY if the memo:
- Discloses a quantitative figure for it (e.g. a metric, KPI, percentage, monetary amount), OR
- Discusses it as a risk, concern, or consideration with at least one supporting sentence, OR
- Gives it genuine analytical treatment (comparison, trend, implication)

A topic is NOT "engaged" if a word merely appears in passing, in a list header, in boilerplate text, or as a cross-reference to another document without substantive discussion.

CRITICAL CONSERVATIVE BIAS: It is FAR WORSE to wrongly list a topic as "engaged" (which could later suppress a real finding) than to omit one (which merely lets a false-positive survive for manual review). When in doubt, OMIT the topic. Only list a topic when the memo CLEARLY and substantively engages with it.

For each engaged topic, return:
- "topic": A short canonical label (e.g. "retention metrics (NRR/GRR)", "M&A pipeline", "earn-out structure", "change-of-control provisions", "capex forecast", "customer concentration")
- "evidence": A verbatim snippet (≤200 characters) from the memo that proves engagement. This must be text that actually appears in the memo.

Do NOT invent topics. Do NOT hallucinate evidence. Do NOT list topics you are uncertain about.

Return ONLY valid JSON in this exact format:
{"engaged_topics": [{"topic": "...", "evidence": "..."}, ...]}`;

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Builds the engagement map for a deal's IC memos.
 *
 * @param queryFn - DB query function
 * @param aiFn - Anthropic API request function
 * @param dealId - Deal to analyze
 * @param deadlineMs - Absolute timestamp (Date.now()) by which we must finish
 * @returns Engagement map result
 */
export async function buildEngagementMap(
  queryFn: EngagementMapQueryFn,
  aiFn: EngagementMapAIFn,
  dealId: string,
  deadlineMs: number,
): Promise<EngagementMapResult> {
  const model = SONNET_MODEL;

  // 1. Find IC memo documents for this deal
  const memoRows = await queryFn(
    `SELECT DISTINCT dc.file_name
     FROM document_chunks dc
     WHERE dc.deal_id = $1
       AND (dc.file_name ~* 'IC[_ ].*Memo' OR dc.file_name ~* 'IC update')`,
    z.object({ file_name: z.string() }),
    [dealId],
    { label: "EM: Find IC memo documents" }
  );

  if (memoRows.length === 0) {
    return {
      deal_id: dealId,
      memos: [],
      model_used: model,
      partial: false,
      note: "no_memos: No IC memo documents found for this deal.",
    };
  }

  // Sort chronologically by extracted date, then by ordinal
  const sortedMemos = [...memoRows].sort((a, b) => {
    const dateA = extractMemoDate(a.file_name);
    const dateB = extractMemoDate(b.file_name);
    if (dateA !== dateB) return dateA - dateB;
    return extractMemoOrdinal(a.file_name) - extractMemoOrdinal(b.file_name);
  });

  // 2. Process each memo sequentially
  const results: MemoEntry[] = [];
  let partial = false;

  for (let i = 0; i < sortedMemos.length; i++) {
    const memo = sortedMemos[i];
    const memoOrder = i + 1;

    // Time budget check
    const remaining = deadlineMs - Date.now();
    if (remaining < TIME_BUDGET_SAFETY_MS) {
      partial = true;
      // Add remaining memos as unprocessed
      for (let j = i; j < sortedMemos.length; j++) {
        results.push({
          memo_file: sortedMemos[j].file_name,
          memo_order: j + 1,
          chunk_count: 0,
          truncated: false,
          engaged_topics: [],
          error: "time_budget_exceeded",
        });
      }
      break;
    }

    // 2a. Gather all chunks for this memo, ordered by chunk_index
    const chunks = await queryFn(
      `SELECT dc.content, dc.chunk_index
       FROM document_chunks dc
       WHERE dc.deal_id = $1
         AND dc.file_name = $2
       ORDER BY dc.chunk_index ASC`,
      ChunkRowSchema,
      [dealId, memo.file_name],
      { label: `EM: Gather chunks for "${memo.file_name.slice(0, 60)}"` }
    );

    // 2b. Concatenate chunk text
    let memoText = chunks.map((c) => c.content).join("\n\n");
    let truncated = false;
    if (memoText.length > MEMO_TEXT_CAP) {
      memoText = memoText.slice(0, MEMO_TEXT_CAP);
      truncated = true;
    }

    // 2c. Call LLM for engagement extraction
    let engagedTopics: EngagedTopic[] = [];
    let error: string | undefined;

    try {
      const userContent = `--- IC MEMO: "${memo.file_name}" ---\n\n${memoText}\n\n--- END OF MEMO ---\n\nList the topics this memo substantively engages with. Return JSON only.`;

      const result = await aiFn(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model,
            max_tokens: ENGAGEMENT_MAX_TOKENS,
            system: [{ type: "text", text: ENGAGEMENT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userContent }],
          },
        },
        { response: MessageResponseSchema },
        { label: `EM: Extract engagement — "${memo.file_name.slice(0, 50)}" (memo ${memoOrder}/${sortedMemos.length})` }
      );

      // Parse response
      const textBlock = result.content.find((c: any) => c.type === "text");
      if (textBlock) {
        const parsed = parseEngagementResponse(textBlock.text);
        if (parsed) {
          engagedTopics = parsed;
        } else {
          error = "parse_failed: Could not parse LLM response as valid engagement JSON";
        }
      } else {
        error = "no_text_content: LLM returned no text block";
      }
    } catch (err: any) {
      error = `llm_error: ${err?.message ?? String(err)}`;
    }

    results.push({
      memo_file: memo.file_name,
      memo_order: memoOrder,
      chunk_count: chunks.length,
      truncated,
      engaged_topics: engagedTopics,
      ...(error ? { error } : {}),
    });
  }

  return {
    deal_id: dealId,
    memos: results,
    model_used: model,
    partial,
  };
}

// ---------------------------------------------------------------------------
// JSON parser (strict, handles markdown fencing)
// ---------------------------------------------------------------------------

function parseEngagementResponse(text: string): EngagedTopic[] | null {
  // Strip markdown code fence if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  try {
    const obj = JSON.parse(cleaned);
    if (obj && Array.isArray(obj.engaged_topics)) {
      // Validate each entry
      return obj.engaged_topics
        .filter((e: any) => typeof e.topic === "string" && typeof e.evidence === "string")
        .map((e: any) => ({
          topic: e.topic.slice(0, 200),
          evidence: e.evidence.slice(0, 250),
        }));
    }
    return null;
  } catch {
    // Try to find JSON in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*"engaged_topics"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (Array.isArray(obj.engaged_topics)) {
          return obj.engaged_topics
            .filter((e: any) => typeof e.topic === "string" && typeof e.evidence === "string")
            .map((e: any) => ({
              topic: e.topic.slice(0, 200),
              evidence: e.evidence.slice(0, 250),
            }));
        }
      } catch {
        return null;
      }
    }
    return null;
  }
}
