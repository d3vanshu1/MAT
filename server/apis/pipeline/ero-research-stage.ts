/**
 * ERO v2 — Research Execution Stage (Phase 4, Stage 2)
 *
 * For each pending hypothesis in execution_rank order:
 *   1. Run ONE Anthropic web_search call using the hypothesis question.
 *   2. Extract evidence items from search result blocks (URLs from
 *      server-provided web_search_result blocks, snippets from citations).
 *   3. Fabrication gate: extractHost(url) must return a non-empty host.
 *      Unparseable URLs are DISCARDED and logged, never written.
 *   4. classifyTier(url, publisher) sets the source tier.
 *   5. parsePublicationDate(page_age) normalises the date.
 *   6. Write ero_evidence rows. ON CONFLICT (hypothesis_id, url) DO NOTHING.
 *   7. Set hypothesis status: 'researched' (≥1 row) or 'no_evidence_found'.
 *
 * This stage does NOT assign severity — that is 4.3.
 *
 * Resumable: processes only status='pending' hypotheses, so re-entry
 * after interruption continues from the next unprocessed hypothesis.
 *
 * Bounded follow-up: a hypothesis's research may spawn at most ONE
 * round-2 hypothesis. Round-2 may NOT spawn round-3.
 *
 * All URL/host parsing reuses the verified 4.1 functions — no local
 * URL parsing or host extraction in this file.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
import { STAGE_BUDGET_MS } from "./ero-stage-contract.js";
import {
  extractHost,
  classifyTier,
  parsePublicationDate,
} from "./ero-source-tiers.js";

// ── Constants ───────────────────────────────────────────────────────
const RESEARCH_MODEL = "claude-sonnet-4-6";
const RESEARCH_MAX_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 4;

/** Per-call timeout for the Anthropic web_search request (ms). */
const PER_CALL_TIMEOUT_MS = 90_000;

/** Retry config. */
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 2_000;

// ── DB row schemas ──────────────────────────────────────────────────
const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  question: z.string(),
  confirming_evidence: z.string(),
  refuting_evidence: z.string(),
  execution_rank: z.coerce.number(),
  round: z.coerce.number(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
  target_reg: z.string().nullable(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

const EntityRow = z.object({
  legal_name: z.string(),
  registration_number: z.string().nullable(),
});

const MaxRankRow = z.object({ max_rank: z.coerce.number().nullable() });

// ── Anthropic response schema (web_search tool-use) ─────────────────
// Content blocks can be text (with optional citations), server_tool_use,
// or web_search_tool_result (containing web_search_result items).
// We parse loosely — the important fields are url, title, page_age from
// web_search_result blocks, and cited_text from citation objects.
const WebSearchResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.record(z.unknown()).optional(),
      // web_search_tool_result contains a content array
      content: z.any().optional(),
      tool_use_id: z.string().optional(),
      // text blocks may carry citations
      citations: z.any().optional(),
    }),
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ── Types for internal bookkeeping ──────────────────────────────────
interface EvidenceItem {
  url: string;
  domain: string;
  publisher: string | null;
  publication_date: string | null;
  source_tier: 1 | 2 | 3;
  verbatim_snippet: string;
  tier_reason: string;
}

interface DroppedItem {
  url: string;
  reason: string;
}

interface HypothesisResult {
  hypothesis_id: string;
  question: string;
  search_query: string;
  evidence_written: EvidenceItem[];
  dropped: DroppedItem[];
  status: "researched" | "no_evidence_found" | "error";
  error_message: string | null;
  round2_spawned: { question: string; family: string } | null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function researchExecution(
  ctx: any,
  runId: string,
  _dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;
  const ai = ctx.integrations.claude;
  const stageStart = Date.now();

  // ── Load pending hypotheses in execution_rank order ───────────────
  const pendingHypotheses = await db.query(
    `SELECT h.hypothesis_id, h.family, h.question, h.confirming_evidence,
            h.refuting_evidence, h.execution_rank, h.round, h.entity_id, h.thesis_link,
            e.registration_number AS target_reg
     FROM ero_hypotheses h
     LEFT JOIN ero_entities e ON e.entity_id = h.entity_id
     WHERE h.run_id = $1 AND h.status = 'pending'
     ORDER BY h.execution_rank ASC`,
    HypothesisRow,
    [runId],
    { label: "Research: load pending hypotheses" },
  );

  if (pendingHypotheses.length === 0) {
    return {
      stage: "research_execution",
      status: "complete",
      message: "No pending hypotheses — research complete.",
      stageData: { hypothesesProcessed: 0 },
    };
  }

  const results: HypothesisResult[] = [];
  let hypothesesProcessed = 0;

  for (const hyp of pendingHypotheses) {
    // ── Budget guard ──────────────────────────────────────────────
    const elapsed = Date.now() - stageStart;
    if (elapsed >= STAGE_BUDGET_MS) {
      return {
        stage: "research_execution",
        status: "in_progress",
        message: `Budget exhausted after ${hypothesesProcessed} hypotheses (${Math.round(elapsed / 1000)}s). ${pendingHypotheses.length - hypothesesProcessed} remain pending.`,
        stageData: {
          hypothesesProcessed,
          hypothesesRemaining: pendingHypotheses.length - hypothesesProcessed,
          results,
        },
      };
    }

    // ── Process one hypothesis ────────────────────────────────────
    const hypResult = await processOneHypothesis(ctx, db, ai, runId, hyp, stageStart);
    results.push(hypResult);
    hypothesesProcessed++;

    // ── Heartbeat ─────────────────────────────────────────────────
    await db.execute(
      `UPDATE ero_pipeline_state
       SET heartbeat_at = now(), updated_at = now()
       WHERE run_id = $1`,
      [runId],
      { label: `Research: heartbeat after hyp ${hyp.execution_rank}` },
    );
  }

  return {
    stage: "research_execution",
    status: "complete",
    message: `Research complete. ${hypothesesProcessed} hypotheses processed.`,
    stageData: {
      hypothesesProcessed,
      results,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// PER-HYPOTHESIS PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function processOneHypothesis(
  ctx: any,
  db: any,
  ai: any,
  runId: string,
  hyp: z.infer<typeof HypothesisRow>,
  stageStart: number,
): Promise<HypothesisResult> {
  // ── 0. Resolve entity identity for disambiguation ────────────
  let entity: z.infer<typeof EntityRow> | null = null;
  if (hyp.entity_id) {
    const rows = await db.query(
      `SELECT legal_name, registration_number
       FROM ero_entities WHERE entity_id = $1`,
      EntityRow,
      [hyp.entity_id],
      { label: `Research: resolve entity for hyp ${hyp.execution_rank}` },
    );
    entity = rows.length > 0 ? rows[0] : null;
  }

  const searchQuery = buildSearchQuery(hyp, entity);

  try {
    // ── 1. Run web search ─────────────────────────────────────────
    const deadlineMs = stageStart + STAGE_BUDGET_MS;
    const response = await runWebSearch(
      ai,
      searchQuery,
      hyp,
      deadlineMs,
      `Research: hyp ${hyp.execution_rank} (${hyp.family})`,
    );

    // ── 2. Extract evidence from response ─────────────────────────
    const { items, dropped } = extractEvidenceFromResponse(response, hyp.target_reg);

    // ── 3. Write evidence rows ────────────────────────────────────
    const writtenItems: EvidenceItem[] = [];
    for (const item of items) {
      await db.execute(
        `INSERT INTO ero_evidence
           (hypothesis_id, url, domain, publisher, publication_date,
            source_tier, verbatim_snippet)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)
         ON CONFLICT (hypothesis_id, url) DO NOTHING`,
        [
          hyp.hypothesis_id,
          item.url,
          item.domain,
          item.publisher,
          item.publication_date,
          item.source_tier,
          item.verbatim_snippet,
        ],
        { label: `Research: write evidence for hyp ${hyp.execution_rank}` },
      );
      writtenItems.push(item);
    }

    // ── 4. Set hypothesis status ──────────────────────────────────
    const status: "researched" | "no_evidence_found" =
      writtenItems.length > 0 ? "researched" : "no_evidence_found";

    await db.execute(
      `UPDATE ero_hypotheses SET status = $2 WHERE hypothesis_id = $1`,
      [hyp.hypothesis_id, status],
      { label: `Research: set hyp ${hyp.execution_rank} → ${status}` },
    );

    // ── 5. Bounded follow-up: spawn round-2 if warranted ─────────
    let round2Spawned: { question: string; family: string } | null = null;
    if (hyp.round === 1) {
      round2Spawned = await maybeSpawnFollowUp(
        db, ai, runId, hyp, response, stageStart,
      );
    }
    // Round-2 hypotheses may NOT spawn round-3 (ceiling enforced by
    // the `hyp.round === 1` guard above).

    return {
      hypothesis_id: hyp.hypothesis_id,
      question: hyp.question,
      search_query: searchQuery,
      evidence_written: writtenItems,
      dropped,
      status,
      error_message: null,
      round2_spawned: round2Spawned,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Budget exhaustion is transient — leave hypothesis as 'pending'
    // so the next invocation retries it. Only genuine failures get
    // permanently marked 'error'.
    const isBudgetExhaustion = /budget exhausted/i.test(msg);

    if (!isBudgetExhaustion) {
      await db.execute(
        `UPDATE ero_hypotheses SET status = 'error' WHERE hypothesis_id = $1`,
        [hyp.hypothesis_id],
        { label: `Research: set hyp ${hyp.execution_rank} → error` },
      );
    }
    // else: leave as 'pending' — next invocation will pick it up

    return {
      hypothesis_id: hyp.hypothesis_id,
      question: hyp.question,
      search_query: searchQuery,
      evidence_written: [],
      dropped: [],
      status: isBudgetExhaustion ? "pending" as any : "error",
      error_message: msg,
      round2_spawned: null,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SEARCH QUERY BUILDER
// ═══════════════════════════════════════════════════════════════════

function buildSearchQuery(
  hyp: z.infer<typeof HypothesisRow>,
  entity: { legal_name: string; registration_number: string | null } | null,
): string {
  // Combine the hypothesis question with its confirming/refuting framing
  // and the entity's resolved identity to give Claude a focused research mandate.
  const parts: string[] = [hyp.question];

  // Entity identity block — gives the model the exact legal name and
  // registration number so it can disambiguate from similarly-named entities.
  if (entity) {
    const regLine = entity.registration_number
      ? ` (registration number: ${entity.registration_number})`
      : "";
    parts.push(
      `Target entity: ${entity.legal_name}${regLine}. Research ONLY this specific entity — reject results about any other company even if the name is similar.`,
    );
  }

  parts.push(
    `Confirming evidence would include: ${hyp.confirming_evidence}`,
    `Refuting evidence would include: ${hyp.refuting_evidence}`,
  );
  return parts.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// WEB SEARCH VIA ANTHROPIC
// ═══════════════════════════════════════════════════════════════════

const RESEARCH_SYSTEM_PROMPT = `You are a due-diligence research agent. You will investigate ONE specific hypothesis about ONE specific named entity. You have a SMALL search budget (about four searches). Spend them in priority order and STOP as soon as you have authoritative evidence that confirms or refutes the hypothesis. Do not use remaining searches on redundant rephrasings or tangential angles.

Search order of priority:
1. The most targeted, authoritative query first — use the entity's exact legal name AND its company registration number to find official records (Companies House filings, regulator registers, official filings).
2. Reputable secondary sources (trade press, financial databases) only if official records are insufficient.
3. General web last, and only if needed.

Entity discipline (critical): research ONLY the exact named legal entity and its registration number. Do NOT accept results about a differently-registered company that merely shares part of the name — a similarly-named US-listed or foreign company is NOT the target. If you cannot confirm a result refers to the specific entity by name and registration number, treat it as no evidence rather than including it.

CRITICAL RULES:
1. Report ONLY what you actually find in search results. Do NOT invent or fabricate findings.
2. If you find nothing relevant, say so honestly. An empty result is better than a fabricated one.
3. When citing sources, use the EXACT URLs from search results. Do NOT modify or construct URLs.
4. For each piece of evidence found, note whether it confirms or refutes the hypothesis.
5. If your research suggests a SINGLE follow-up question worth investigating, state it clearly at the end prefixed with "FOLLOW-UP:". Only suggest a follow-up if the evidence strongly warrants further investigation. Most hypotheses will NOT need a follow-up.

Respond with a concise summary of what you found, citing specific sources.`;

async function runWebSearch(
  ai: any,
  searchContent: string,
  hyp: z.infer<typeof HypothesisRow>,
  deadlineMs: number,
  label: string,
): Promise<z.infer<typeof WebSearchResponseSchema>> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Budget check before each attempt
    const remaining = deadlineMs - Date.now();
    if (remaining < 30_000) {
      throw new Error(
        `Budget exhausted mid-retry (attempt ${attempt}/${MAX_RETRIES}, ` +
          `${Math.round(remaining / 1000)}s left): ${label}`,
      );
    }

    try {
      const timeoutMs = Math.min(PER_CALL_TIMEOUT_MS, remaining);

      const response = await Promise.race([
        ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: RESEARCH_MODEL,
              max_tokens: RESEARCH_MAX_TOKENS,
              system: [
                {
                  type: "text",
                  text: RESEARCH_SYSTEM_PROMPT,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: [{ role: "user", content: searchContent }],
              tools: [
                {
                  type: "web_search_20250305" as string,
                  name: "web_search",
                  max_uses: WEB_SEARCH_MAX_USES,
                },
              ],
            },
          },
          { response: WebSearchResponseSchema },
          { label },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Web search timed out after ${Math.round(timeoutMs / 1000)}s: ${label}`,
                ),
              ),
            timeoutMs,
          ),
        ),
      ]);

      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable =
        /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(
          msg,
        );
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
        15_000,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// ═══════════════════════════════════════════════════════════════════
// EVIDENCE EXTRACTION — anti-fabrication
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract evidence items from the Anthropic web_search response.
 *
 * Anti-fabrication stance: URLs come from server-provided
 * web_search_result blocks, NOT from model-generated text.
 * Snippets come from citations[].cited_text (linked to URLs).
 * The model text is used ONLY to determine relevance / to extract
 * a follow-up question — never as a source of URLs.
 */
function extractEvidenceFromResponse(
  response: z.infer<typeof WebSearchResponseSchema>,
  targetReg: string | null = null,
): { items: EvidenceItem[]; dropped: DroppedItem[] } {
  const items: EvidenceItem[] = [];
  const dropped: DroppedItem[] = [];
  const seenUrls = new Set<string>();

  // ── Phase 1: Collect raw search results from web_search_result blocks ─
  // These are server-authoritative: url, title, page_age.
  const rawResults = new Map<
    string,
    { url: string; title: string; page_age: string | null }
  >();

  for (const block of response.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content as any[]) {
        if (result.type === "web_search_result" && result.url) {
          rawResults.set(result.url, {
            url: result.url,
            title: result.title ?? "",
            page_age: result.page_age ?? null,
          });
        }
      }
    }
  }

  // ── Phase 2: Collect citations from text blocks ───────────────────
  // Citations carry cited_text and link back to URLs. These provide
  // the verbatim snippet.
  const citationsByUrl = new Map<
    string,
    { cited_text: string; title: string }
  >();

  for (const block of response.content) {
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const cit of block.citations as any[]) {
        if (cit.url && cit.cited_text) {
          // Keep the longest cited_text per URL
          const existing = citationsByUrl.get(cit.url);
          if (!existing || cit.cited_text.length > existing.cited_text.length) {
            citationsByUrl.set(cit.url, {
              cited_text: cit.cited_text,
              title: cit.title ?? "",
            });
          }
        }
      }
    }
  }

  // ── Phase 3: Build evidence items from server-authoritative URLs ──
  for (const [url, raw] of rawResults) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Fabrication gate: extractHost must return a non-empty host
    const host = extractHost(url);
    if (!host) {
      dropped.push({ url, reason: "extractHost returned empty — unparseable URL" });
      continue;
    }

    // ── Wrong-entity admission filter (Companies House only) ────
    if (targetReg && host === "find-and-update.company-information.service.gov.uk") {
      const chMatch = url.match(/\/company\/([A-Za-z0-9]+)/);
      if (!chMatch) {
        dropped.push({ url, reason: "CH non-entity page (no company number)" });
        continue;
      }
      if (chMatch[1].trim().toLowerCase() !== targetReg.trim().toLowerCase()) {
        dropped.push({ url, reason: `wrong-entity: CH company ${chMatch[1]} != target ${targetReg}` });
        continue;
      }
    }

    // Classify via the verified 4.1 classifier
    const tierResult = classifyTier(url, null);

    // Date from page_age
    const dateResult = parsePublicationDate(raw.page_age);

    // Snippet: prefer citation cited_text, fall back to title
    const citation = citationsByUrl.get(url);
    const snippet = citation?.cited_text
      ?? raw.title
      ?? "(no snippet available)";

    items.push({
      url,
      domain: host,
      publisher: null, // web search results don't carry publisher metadata
      publication_date: dateResult.date,
      source_tier: tierResult.tier,
      verbatim_snippet: snippet.slice(0, 2000), // cap at 2KB
      tier_reason: tierResult.reason,
    });
  }

  // Also check citations for URLs not in rawResults (edge case:
  // the model cited a URL from a previous search result block that
  // might not be in the current web_search_tool_result). These are
  // still server-mediated (citation URLs come from encrypted_content),
  // not model-fabricated.
  for (const [url, cit] of citationsByUrl) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const host = extractHost(url);
    if (!host) {
      dropped.push({ url, reason: "extractHost returned empty — unparseable URL (citation)" });
      continue;
    }

    // ── Wrong-entity admission filter (Companies House only) ────
    if (targetReg && host === "find-and-update.company-information.service.gov.uk") {
      const chMatch = url.match(/\/company\/([A-Za-z0-9]+)/);
      if (!chMatch) {
        dropped.push({ url, reason: "CH non-entity page (no company number) (citation)" });
        continue;
      }
      if (chMatch[1].trim().toLowerCase() !== targetReg.trim().toLowerCase()) {
        dropped.push({ url, reason: `wrong-entity: CH company ${chMatch[1]} != target ${targetReg} (citation)` });
        continue;
      }
    }

    const tierResult = classifyTier(url, null);
    const dateResult = parsePublicationDate(null); // no page_age for citation-only URLs

    items.push({
      url,
      domain: host,
      publisher: null,
      publication_date: dateResult.date,
      source_tier: tierResult.tier,
      verbatim_snippet: cit.cited_text.slice(0, 2000),
      tier_reason: tierResult.reason,
    });
  }

  return { items, dropped };
}

// ═══════════════════════════════════════════════════════════════════
// BOUNDED FOLLOW-UP — round-2 spawning
// ═══════════════════════════════════════════════════════════════════

/**
 * If the research response suggests a single follow-up question,
 * insert it as a round-2 hypothesis with a provisional execution_rank
 * at the end. Only round-1 hypotheses may spawn round-2.
 * Round-2 may NOT spawn round-3 (enforced by caller guard).
 */
async function maybeSpawnFollowUp(
  db: any,
  _ai: any,
  runId: string,
  parentHyp: z.infer<typeof HypothesisRow>,
  response: z.infer<typeof WebSearchResponseSchema>,
  _stageStart: number,
): Promise<{ question: string; family: string } | null> {
  // Extract follow-up from model text
  const followUp = extractFollowUpQuestion(response);
  if (!followUp) return null;

  // Get max execution_rank for this run
  const maxRows = await db.query(
    `SELECT MAX(execution_rank) AS max_rank FROM ero_hypotheses WHERE run_id = $1`,
    MaxRankRow,
    [runId],
    { label: "Research: get max execution_rank" },
  );
  const nextRank = (maxRows[0]?.max_rank ?? 0) + 1;

  // Insert round-2 hypothesis
  await db.execute(
    `INSERT INTO ero_hypotheses
       (run_id, family, entity_id, thesis_link, question,
        confirming_evidence, refuting_evidence, execution_rank,
        status, round)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 2)
     ON CONFLICT (run_id, execution_rank) DO NOTHING`,
    [
      runId,
      parentHyp.family,
      parentHyp.entity_id,
      parentHyp.thesis_link,
      followUp,
      "Follow-up evidence to be determined by research",
      "Contradictory evidence to be determined by research",
      nextRank,
    ],
    { label: `Research: spawn round-2 from hyp ${parentHyp.execution_rank}` },
  );

  return { question: followUp, family: parentHyp.family };
}

/**
 * Look for a "FOLLOW-UP:" line in the model's text response.
 * Returns the follow-up question or null.
 */
function extractFollowUpQuestion(
  response: z.infer<typeof WebSearchResponseSchema>,
): string | null {
  for (const block of response.content) {
    if (block.type === "text" && block.text) {
      const match = block.text.match(/FOLLOW-UP:\s*(.+)/i);
      if (match && match[1]) {
        const question = match[1].trim();
        // Sanity: must be a real question (>20 chars, not just noise)
        if (question.length > 20) {
          return question;
        }
      }
    }
  }
  return null;
}
