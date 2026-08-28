/**
 * ERO v2 — Test harness for research execution stage.
 *
 * Input: { runId, maxHypotheses? }
 *   - runId: an existing ERO run with ranked hypotheses
 *   - maxHypotheses: cap on how many pending hypotheses to process
 *     (default 3). Keeps test scope narrow without exhausting
 *     web-search quota or testApi limits.
 *
 * Researches only the top-N-ranked pending hypotheses, then returns
 * RAW per-hypothesis detail plus integrity assertions.
 *
 * Integrations: postgres (IC_DILIGENCE_DB), anthropic (for web search).
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { STAGE_BUDGET_MS } from "./ero-stage-contract.js";
import {
  extractHost,
  classifyTier,
  parsePublicationDate,
} from "./ero-source-tiers.js";

// ── Integration IDs ─────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ───────────────────────────────────────────────────────
const RESEARCH_MODEL = "claude-sonnet-4-6";
const RESEARCH_MAX_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 10;
const PER_CALL_TIMEOUT_MS = 90_000;
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
});

const EvidenceRow = z.object({
  evidence_id: z.string(),
  url: z.string(),
  domain: z.string().nullable(),
  publisher: z.string().nullable(),
  publication_date: z.string().nullable(),
  source_tier: z.coerce.number(),
  verbatim_snippet: z.string(),
});

const CountRow = z.object({ cnt: z.coerce.number() });
const MaxRankRow = z.object({ max_rank: z.coerce.number().nullable() });

// ── Anthropic response schema ───────────────────────────────────────
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
      content: z.any().optional(),
      tool_use_id: z.string().optional(),
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

// ── Evidence item types ─────────────────────────────────────────────
interface TestEvidenceItem {
  url: string;
  domain: string;
  publisher: string | null;
  publication_date: string | null;
  source_tier: number;
  verbatim_snippet: string;
  tier_reason: string;
}

interface TestDroppedItem {
  url: string;
  reason: string;
}

// ── System prompt (same as main stage) ──────────────────────────────
const RESEARCH_SYSTEM_PROMPT = `You are a due-diligence research agent. You will receive a specific risk hypothesis to investigate.

Use the web_search tool to find evidence that either confirms or refutes the hypothesis. Search thoroughly — try multiple angles if the first search is inconclusive.

CRITICAL RULES:
1. Report ONLY what you actually find in search results. Do NOT invent or fabricate findings.
2. If you find nothing relevant, say so honestly. An empty result is better than a fabricated one.
3. When citing sources, use the EXACT URLs from search results. Do NOT modify or construct URLs.
4. For each piece of evidence found, note whether it confirms or refutes the hypothesis.
5. If your research suggests a SINGLE follow-up question worth investigating, state it clearly at the end prefixed with "FOLLOW-UP:". Only suggest a follow-up if the evidence strongly warrants further investigation. Most hypotheses will NOT need a follow-up.

Respond with a concise summary of what you found, citing specific sources.`;

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "EroTestResearch",
  description: "Test harness for ERO research execution — processes top-N hypotheses",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    maxHypotheses: z.number().optional(),
  }),

  output: z.object({
    hypothesesProcessed: z.number(),
    hypothesesRemaining: z.number(),
    perHypothesis: z.array(
      z.object({
        hypothesis_id: z.string(),
        question: z.string(),
        execution_rank: z.number(),
        round: z.number(),
        search_query: z.string(),
        evidence_written: z.array(
          z.object({
            url: z.string(),
            domain: z.string(),
            publisher: z.string().nullable(),
            publication_date: z.string().nullable(),
            source_tier: z.number(),
            verbatim_snippet: z.string(),
            tier_reason: z.string(),
          }),
        ),
        dropped: z.array(
          z.object({
            url: z.string(),
            reason: z.string(),
          }),
        ),
        status: z.string(),
        error_message: z.string().nullable(),
        round2_spawned: z
          .object({ question: z.string(), family: z.string() })
          .nullable(),
      }),
    ),
    checks: z.object({
      totalEvidenceRows: z.number(),
      tierDistribution: z.object({
        tier1: z.number(),
        tier2: z.number(),
        tier3: z.number(),
      }),
      hypothesesWithZeroEvidence: z.number(),
      allRowsHaveNonEmptyDomain: z.boolean(),
      allRowsHaveValidTier: z.boolean(),
      integrityPassed: z.boolean(),
    }),
  }),

  async run(ctx, { runId, maxHypotheses }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.claude;
    const cap = maxHypotheses ?? 3;
    const stageStart = Date.now();
    const deadlineMs = stageStart + STAGE_BUDGET_MS;

    // ── Load pending hypotheses (capped) ──────────────────────────
    const allPending = await db.query(
      `SELECT hypothesis_id, family, question, confirming_evidence,
              refuting_evidence, execution_rank, round, entity_id, thesis_link
       FROM ero_hypotheses
       WHERE run_id = $1 AND status = 'pending'
       ORDER BY execution_rank ASC`,
      HypothesisRow,
      [runId],
      { label: "TestResearch: load pending hypotheses" },
    );

    const toProcess = allPending.slice(0, cap);
    const remaining = allPending.length - toProcess.length;

    // ── Process each hypothesis ───────────────────────────────────
    const perHypothesis: Array<{
      hypothesis_id: string;
      question: string;
      execution_rank: number;
      round: number;
      search_query: string;
      evidence_written: TestEvidenceItem[];
      dropped: TestDroppedItem[];
      status: string;
      error_message: string | null;
      round2_spawned: { question: string; family: string } | null;
    }> = [];

    for (const hyp of toProcess) {
      const searchQuery = [
        hyp.question,
        `Confirming evidence would include: ${hyp.confirming_evidence}`,
        `Refuting evidence would include: ${hyp.refuting_evidence}`,
      ].join("\n");

      let evidenceWritten: TestEvidenceItem[] = [];
      let dropped: TestDroppedItem[] = [];
      let status = "no_evidence_found";
      let errorMessage: string | null = null;
      let round2Spawned: { question: string; family: string } | null = null;

      try {
        // ── Run web search ──────────────────────────────────────
        const response = await runWebSearchCall(
          ai,
          searchQuery,
          deadlineMs,
          `TestResearch: hyp ${hyp.execution_rank} (${hyp.family})`,
        );

        // ── Extract evidence ────────────────────────────────────
        const extracted = extractEvidence(response);
        evidenceWritten = extracted.items;
        dropped = extracted.dropped;

        // ── Write evidence rows ─────────────────────────────────
        for (const item of evidenceWritten) {
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
            { label: `TestResearch: write evidence for hyp ${hyp.execution_rank}` },
          );
        }

        // ── Set status ──────────────────────────────────────────
        status = evidenceWritten.length > 0 ? "researched" : "no_evidence_found";
        await db.execute(
          `UPDATE ero_hypotheses SET status = $2 WHERE hypothesis_id = $1`,
          [hyp.hypothesis_id, status],
          { label: `TestResearch: set hyp ${hyp.execution_rank} → ${status}` },
        );

        // ── Bounded follow-up (round-1 only) ────────────────────
        if (hyp.round === 1) {
          const followUp = extractFollowUp(response);
          if (followUp) {
            const maxRows = await db.query(
              `SELECT MAX(execution_rank) AS max_rank FROM ero_hypotheses WHERE run_id = $1`,
              MaxRankRow,
              [runId],
              { label: "TestResearch: get max execution_rank" },
            );
            const nextRank = (maxRows[0]?.max_rank ?? 0) + 1;

            await db.execute(
              `INSERT INTO ero_hypotheses
                 (run_id, family, entity_id, thesis_link, question,
                  confirming_evidence, refuting_evidence, execution_rank,
                  status, round)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 2)`,
              [
                runId,
                hyp.family,
                hyp.entity_id,
                hyp.thesis_link,
                followUp,
                "Follow-up evidence to be determined by research",
                "Contradictory evidence to be determined by research",
                nextRank,
              ],
              { label: `TestResearch: spawn round-2 from hyp ${hyp.execution_rank}` },
            );

            round2Spawned = { question: followUp, family: hyp.family };
          }
        }
      } catch (err) {
        status = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        await db.execute(
          `UPDATE ero_hypotheses SET status = 'error' WHERE hypothesis_id = $1`,
          [hyp.hypothesis_id],
          { label: `TestResearch: set hyp ${hyp.execution_rank} → error` },
        );
      }

      perHypothesis.push({
        hypothesis_id: hyp.hypothesis_id,
        question: hyp.question,
        execution_rank: hyp.execution_rank,
        round: hyp.round,
        search_query: searchQuery,
        evidence_written: evidenceWritten,
        dropped,
        status,
        error_message: errorMessage,
        round2_spawned: round2Spawned,
      });

      // ── Heartbeat ─────────────────────────────────────────────
      await db.execute(
        `UPDATE ero_pipeline_state
         SET heartbeat_at = now(), updated_at = now()
         WHERE run_id = $1`,
        [runId],
        { label: `TestResearch: heartbeat after hyp ${hyp.execution_rank}` },
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECKS
    // ═══════════════════════════════════════════════════════════════

    // Collect all written evidence
    const allEvidence = perHypothesis.flatMap((h) => h.evidence_written);
    const totalEvidenceRows = allEvidence.length;

    // Tier distribution
    const tier1 = allEvidence.filter((e) => e.source_tier === 1).length;
    const tier2 = allEvidence.filter((e) => e.source_tier === 2).length;
    const tier3 = allEvidence.filter((e) => e.source_tier === 3).length;

    // Hypotheses with zero admissible evidence
    const hypothesesWithZeroEvidence = perHypothesis.filter(
      (h) => h.status === "no_evidence_found",
    ).length;

    // HARD ASSERTION: every written row has non-empty domain
    const allRowsHaveNonEmptyDomain = allEvidence.every(
      (e) => typeof e.domain === "string" && e.domain.length > 0,
    );

    // HARD ASSERTION: every written row has tier in {1, 2, 3}
    const allRowsHaveValidTier = allEvidence.every(
      (e) => e.source_tier === 1 || e.source_tier === 2 || e.source_tier === 3,
    );

    const integrityPassed = allRowsHaveNonEmptyDomain && allRowsHaveValidTier;

    return {
      hypothesesProcessed: perHypothesis.length,
      hypothesesRemaining: remaining,
      perHypothesis,
      checks: {
        totalEvidenceRows,
        tierDistribution: { tier1, tier2, tier3 },
        hypothesesWithZeroEvidence,
        allRowsHaveNonEmptyDomain,
        allRowsHaveValidTier,
        integrityPassed,
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════
// HELPERS (duplicated from main stage to keep test harness standalone)
// ═══════════════════════════════════════════════════════════════════

async function runWebSearchCall(
  ai: any,
  searchContent: string,
  deadlineMs: number,
  label: string,
): Promise<z.infer<typeof WebSearchResponseSchema>> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
        /503|429|rate.?limit|service.?unavailable|overloaded|timed out/i.test(msg);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), 15_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

function extractEvidence(
  response: z.infer<typeof WebSearchResponseSchema>,
): { items: TestEvidenceItem[]; dropped: TestDroppedItem[] } {
  const items: TestEvidenceItem[] = [];
  const dropped: TestDroppedItem[] = [];
  const seenUrls = new Set<string>();

  // Phase 1: raw search results
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

  // Phase 2: citations
  const citationsByUrl = new Map<
    string,
    { cited_text: string; title: string }
  >();

  for (const block of response.content) {
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const cit of block.citations as any[]) {
        if (cit.url && cit.cited_text) {
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

  // Phase 3: build evidence items
  for (const [url, raw] of rawResults) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const host = extractHost(url);
    if (!host) {
      dropped.push({ url, reason: "extractHost returned empty — unparseable URL" });
      continue;
    }

    const tierResult = classifyTier(url, null);
    const dateResult = parsePublicationDate(raw.page_age);
    const citation = citationsByUrl.get(url);
    const snippet = citation?.cited_text ?? raw.title ?? "(no snippet available)";

    items.push({
      url,
      domain: host,
      publisher: null,
      publication_date: dateResult.date,
      source_tier: tierResult.tier,
      verbatim_snippet: snippet.slice(0, 2000),
      tier_reason: tierResult.reason,
    });
  }

  for (const [url, cit] of citationsByUrl) {
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const host = extractHost(url);
    if (!host) {
      dropped.push({ url, reason: "extractHost returned empty — unparseable URL (citation)" });
      continue;
    }

    const tierResult = classifyTier(url, null);
    const dateResult = parsePublicationDate(null);

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

function extractFollowUp(
  response: z.infer<typeof WebSearchResponseSchema>,
): string | null {
  for (const block of response.content) {
    if (block.type === "text" && block.text) {
      const match = block.text.match(/FOLLOW-UP:\s*(.+)/i);
      if (match && match[1]) {
        const question = match[1].trim();
        if (question.length > 20) return question;
      }
    }
  }
  return null;
}
