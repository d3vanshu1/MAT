/**
 * sri-verify-claims.ts
 *
 * Stage 2 of 3 — verify_claims
 *
 * For each claim in sri_claims, search public platforms determined by
 * claim_type using domain-constrained web search, judge per-URL relevance
 * with a structured model call, and compute verdicts from counted stances.
 *
 * Anti-fabrication: URLs come from server-authoritative web_search_result
 * blocks only. Domain backstop rejects off-platform URLs. Per-URL stance
 * requires a verbatim quote substring from the snippet. Verdict is computed
 * in code from stance counts, never from model prose.
 */

import { z } from "@superblocksteam/sdk-api";
import type { StageHandler, StageResult } from "./sri-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
const STAGE_NAME = "verify_claims";
const LOG_PREFIX = "[SRI verify_claims]";
const SEARCH_MODEL = "claude-sonnet-4-6";
const SEARCH_MAX_TOKENS = 4096;
const JUDGMENT_MAX_TOKENS = 2048;
const WEB_SEARCH_MAX_USES = 3;

// ── Platform routing (code-side, no model involvement) ──────────────
const PLATFORM_ROUTING: Record<string, string[]> = {
  culture: ["glassdoor", "indeed", "linkedin"],
  retention_attrition: ["glassdoor", "indeed", "linkedin"],
  headcount: ["glassdoor", "indeed", "linkedin"],
  employer_reputation: ["glassdoor", "indeed", "linkedin"],
  nps_csat: ["trustpilot", "g2"],
  customer_satisfaction: ["trustpilot", "g2"],
  brand_reputation: ["news"],
  award: ["news"],
};

// ── Allowed domains per platform (for web_search tool config) ───────
const PLATFORM_ALLOWED_DOMAINS: Record<string, string[]> = {
  glassdoor: ["glassdoor.com", "glassdoor.co.uk"],
  indeed: ["indeed.com", "uk.indeed.com"],
  linkedin: ["linkedin.com"],
  trustpilot: ["trustpilot.com", "uk.trustpilot.com"],
  g2: ["g2.com"],
  // news: no allowed_domains — legitimately open web
};

// ── Severity (code-assigned, never model-asserted) ──────────────────
function assignSeverity(verdict: string, thesisDependence: string, contradictCount: number): string {
  if (verdict === "contradicted" && thesisDependence === "high" && contradictCount >= 2) return "critical";
  if (verdict === "contradicted" && thesisDependence === "high" && contradictCount === 1) return "warning";
  if (verdict === "contradicted" && thesisDependence === "medium") return "warning";
  if (verdict === "mixed" && thesisDependence === "high") return "warning";
  return "info";
}

// ── extractHost (inline implementation) ─────────────────────────────
function extractHost(url: string): string {
  if (!url || typeof url !== "string") return "";
  var s = url.trim().toLowerCase();
  s = s.replace(/^https?:\/\//i, "");
  var atIdx = s.indexOf("@");
  if (atIdx !== -1) s = s.slice(atIdx + 1);
  var endIdx = s.search(/[/?#]/);
  if (endIdx !== -1) s = s.slice(0, endIdx);
  var colonIdx = s.lastIndexOf(":");
  if (colonIdx !== -1) s = s.slice(0, colonIdx);
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s.includes(".")) return "";
  return s;
}

// ── Whitespace normalization for quote gate ──────────────────────────
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Zod schemas ─────────────────────────────────────────────────────
var StagesCompletedRow = z.object({ stages_completed: z.array(z.string()) });
var LockRow = z.object({ locked: z.boolean() });
var ClaimRow = z.object({
  claim_id: z.string(),
  claim_text: z.string(),
  claim_type: z.string(),
  subject_entity: z.string().nullable(),
  thesis_dependence: z.string(),
});
var FindingExistsRow = z.object({ cnt: z.coerce.number() });
var CountRow = z.object({ cnt: z.coerce.number() });

// ── Web search response schema ──────────────────────────────────────
var WebSearchResponseSchema = z.object({
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

// ── Judgment response schema ────────────────────────────────────────
var JudgmentResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ── Evidence extraction from web search response ────────────────────
interface HarvestedItem {
  url: string;
  domain: string;
  snippet: string;
}

function extractHarvestedItems(
  response: z.infer<typeof WebSearchResponseSchema>,
): { items: HarvestedItem[]; urlsRejectedNoHost: number } {
  var items: HarvestedItem[] = [];
  var urlsRejectedNoHost = 0;
  var seenUrls = new Set<string>();

  // Phase 1: Collect raw search results from web_search_result blocks
  var rawResults = new Map<string, { url: string; title: string }>();
  for (var bi = 0; bi < response.content.length; bi++) {
    var block = response.content[bi] as any;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (var ri = 0; ri < block.content.length; ri++) {
        var result = block.content[ri];
        if (result.type === "web_search_result" && result.url) {
          rawResults.set(result.url, { url: result.url, title: result.title || "" });
        }
      }
    }
  }

  // Phase 2: Collect citations from text blocks
  var citationsByUrl = new Map<string, string>();
  for (var ci = 0; ci < response.content.length; ci++) {
    var cBlock = response.content[ci] as any;
    if (cBlock.type === "text" && Array.isArray(cBlock.citations)) {
      for (var cii = 0; cii < cBlock.citations.length; cii++) {
        var cit = cBlock.citations[cii];
        if (cit.url && cit.cited_text) {
          var existing = citationsByUrl.get(cit.url);
          if (!existing || cit.cited_text.length > existing.length) {
            citationsByUrl.set(cit.url, cit.cited_text);
          }
        }
      }
    }
  }

  // Phase 3: Build evidence from server-authoritative URLs
  rawResults.forEach(function (raw, url) {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    var host = extractHost(url);
    if (!host) { urlsRejectedNoHost++; return; }
    var citation = citationsByUrl.get(url);
    var snippet = citation || raw.title || "(no snippet available)";
    items.push({ url: url, domain: host, snippet: snippet.slice(0, 2000) });
  });

  // Phase 4: Citations for URLs not in rawResults (server-mediated)
  citationsByUrl.forEach(function (citedText, url) {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    var host = extractHost(url);
    if (!host) { urlsRejectedNoHost++; return; }
    items.push({ url: url, domain: host, snippet: citedText.slice(0, 2000) });
  });

  return { items: items, urlsRejectedNoHost: urlsRejectedNoHost };
}

// ── Per-URL relevance judgment ───────────────────────────────────────
interface JudgedItem {
  url: string;
  domain: string;
  snippet: string;
  stance: "supports" | "contradicts";
  quote: string;
  entity_match: "confirmed" | "ambiguous" | "mismatch";
  entity_reason: string;
}

const VALID_STANCES = new Set(["supports", "contradicts", "irrelevant"]);
const VALID_ENTITY_MATCHES = new Set(["confirmed", "ambiguous", "mismatch"]);

interface DroppedItem {
  platform: string;
  url: string;
  domain: string;
  drop_stage: string;
  drop_reason: string;
  entity_match: string | null;
}

async function judgeRelevance(
  claude: any,
  claimText: string,
  items: HarvestedItem[],
  label: string,
  targetProfileText: string,
  platform: string,
): Promise<{ retained: JudgedItem[]; dropped: DroppedItem[]; quoteGateFailed: number; irrelevantCount: number; judgeParseFailed: number; judgeIndexInvalid: number; judgeNoVerdict: number; rawResponse: string }> {
  if (items.length === 0) return { retained: [], dropped: [], quoteGateFailed: 0, irrelevantCount: 0, judgeParseFailed: 0, judgeIndexInvalid: 0, judgeNoVerdict: 0, rawResponse: "" };

  // Build numbered list of url + snippet
  var itemList = "";
  for (var i = 0; i < items.length; i++) {
    itemList += (i + 1) + ". URL: " + items[i].url + "\nSnippet: " + items[i].snippet.slice(0, 500) + "\n\n";
  }

  // ── Build judge prompt with separated stance and entity sections ──
  var hasProfile = targetProfileText.length > 0;

  var entityFields = "";
  var entitySection = "";
  if (hasProfile) {
    entityFields = "\n- \"entity_match\": exactly one of \"confirmed\", \"ambiguous\", or \"mismatch\"\n- \"entity_reason\": one short sentence citing what in the page's own description drove the entity_match decision";
    entitySection = "\n\nENTITY IDENTIFICATION (used only for entity_match, not for stance):\n" + targetProfileText + "\n\nDefinitions for entity_match:\n- \"confirmed\" means the page describes a company consistent with the profile on at least two independent attributes, such as sector plus geography, or products plus customer type.\n- \"ambiguous\" means the page gives too little identifying description to decide.\n- \"mismatch\" means the page describes a company contradicting the profile on any attribute.\n\nIMPORTANT: entity_match is a separate question from stance. A page about the wrong company can still have a stance toward the claim. Assess stance on content alone. Then assess entity_match on company identity alone. Do NOT use \"irrelevant\" to signal that the company may be wrong — use entity_match for that.";
  }

  var judgmentPrompt = "You are evaluating web search results. You must answer two independent questions for each result.\n\nQuestion 1 — STANCE: Does the page content support, contradict, or not address the claim? Assess stance based on content alone, regardless of which company the page describes.\n\nQuestion 2 — ENTITY: Does the page describe the same company as the target? This is answered separately via entity_match.\n\nClaim: \"" + claimText + "\"\n\nSearch results:\n" + itemList + "For each result, return a JSON object with these fields in this order:\n- \"index\": the 1-based result number\n- \"stance\": exactly one of \"supports\", \"contradicts\", or \"irrelevant\"\n- \"quote\": a verbatim span copied exactly from that result's Snippet text that justifies the stance" + entityFields + "\n\nReturn ONLY a JSON array, no prose.\n\nRules for stance:\n- \"supports\" means the snippet provides evidence consistent with the claim\n- \"contradicts\" means the snippet provides evidence that disputes or undermines the claim\n- \"irrelevant\" means the snippet has no bearing on the claim at all — the content does not address the topic\n- Do NOT mark a result \"irrelevant\" because it may be about the wrong company. If the content addresses the claim topic, assign \"supports\" or \"contradicts\" and record any company-identity doubt in entity_match.\n- The quote MUST be an exact substring of the snippet text. Do not paraphrase or rearrange." + entitySection;

  try {
    var response = await claude.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SEARCH_MODEL,
          max_tokens: JUDGMENT_MAX_TOKENS,
          messages: [{ role: "user", content: judgmentPrompt }],
        },
      },
      { response: JudgmentResponseSchema },
      { label: label },
    );

    // Extract JSON from response text
    var responseText = "";
    for (var ri = 0; ri < response.content.length; ri++) {
      if (response.content[ri].type === "text" && response.content[ri].text) {
        responseText += response.content[ri].text;
      }
    }

    // Strip markdown fences if present
    responseText = responseText.trim();
    if (responseText.startsWith("```json")) {
      responseText = responseText.slice(7);
    } else if (responseText.startsWith("```")) {
      responseText = responseText.slice(3);
    }
    if (responseText.endsWith("```")) {
      responseText = responseText.slice(0, -3);
    }
    responseText = responseText.trim();

    var parsed: any;
    var judgeParseFailed = 0;
    var judgeIndexInvalid = 0;
    var judgeNoVerdict = 0;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      // Parse failed — treat every item as irrelevant
      var parseDrops: DroppedItem[] = items.map(function (it) { return { platform: platform, url: it.url, domain: it.domain, drop_stage: "judge_parse_failed", drop_reason: "JSON parse failed", entity_match: null }; });
      return { retained: [], dropped: parseDrops, quoteGateFailed: 0, irrelevantCount: items.length, judgeParseFailed: 1, judgeIndexInvalid: 0, judgeNoVerdict: 0, rawResponse: responseText };
    }

    // The parsed value must be an array
    if (!Array.isArray(parsed)) {
      var parseDrops2: DroppedItem[] = items.map(function (it) { return { platform: platform, url: it.url, domain: it.domain, drop_stage: "judge_parse_failed", drop_reason: "Response not an array", entity_match: null }; });
      return { retained: [], dropped: parseDrops2, quoteGateFailed: 0, irrelevantCount: items.length, judgeParseFailed: 1, judgeIndexInvalid: 0, judgeNoVerdict: 0, rawResponse: responseText };
    }

    var retained: JudgedItem[] = [];
    var allDropped: DroppedItem[] = [];
    var quoteGateFailed = 0;
    var irrelevantCount = 0;

    // Track which items received a verdict
    var itemCovered = new Array(items.length).fill(false);

    for (var ji = 0; ji < parsed.length; ji++) {
      var j = parsed[ji];

      // Index must be an integer within range (1-based)
      if (typeof j.index !== "number" || !Number.isInteger(j.index)) {
        judgeIndexInvalid++;
        allDropped.push({ platform: platform, url: "unknown", domain: "unknown", drop_stage: "judge_index_invalid", drop_reason: "Non-integer index", entity_match: null });
        continue;
      }
      var idx = j.index - 1;
      if (idx < 0 || idx >= items.length) {
        judgeIndexInvalid++;
        allDropped.push({ platform: platform, url: "unknown", domain: "unknown", drop_stage: "judge_index_invalid", drop_reason: "Index out of range: " + j.index, entity_match: null });
        continue;
      }

      itemCovered[idx] = true;

      var stance = String(j.stance || "").toLowerCase().trim();
      var quote = String(j.quote || "");

      // Gate (a): stance must be one of the three literals
      if (!VALID_STANCES.has(stance)) {
        stance = "irrelevant";
      }

      if (stance === "irrelevant") {
        irrelevantCount++;
        allDropped.push({ platform: platform, url: items[idx].url, domain: items[idx].domain, drop_stage: "judge_irrelevant", drop_reason: "Judged irrelevant", entity_match: null });
        continue;
      }

      // Gate (b): quote must be exact substring of snippet after whitespace normalization
      var normQuote = normalizeWs(quote);
      var normSnippet = normalizeWs(items[idx].snippet);
      if (normQuote.length === 0 || normSnippet.indexOf(normQuote) === -1) {
        quoteGateFailed++;
        irrelevantCount++;
        allDropped.push({ platform: platform, url: items[idx].url, domain: items[idx].domain, drop_stage: "quote_gate", drop_reason: "Quote not found in snippet", entity_match: null });
        continue;
      }

      // Entity match gate
      var entityMatch = String(j.entity_match || "").toLowerCase().trim();
      var entityReason = String(j.entity_reason || "");
      if (!VALID_ENTITY_MATCHES.has(entityMatch)) {
        entityMatch = "mismatch";
      }
      if (entityMatch === "mismatch") {
        allDropped.push({ platform: platform, url: items[idx].url, domain: items[idx].domain, drop_stage: "entity_mismatch", drop_reason: entityReason, entity_match: "mismatch" });
        irrelevantCount++;
        continue;
      }

      // Retained: supports or contradicts with valid quote and confirmed or ambiguous entity
      retained.push({
        url: items[idx].url,
        domain: items[idx].domain,
        snippet: items[idx].snippet,
        stance: stance as "supports" | "contradicts",
        quote: quote,
        entity_match: entityMatch as "confirmed" | "ambiguous",
        entity_reason: entityReason,
      });
    }

    // Items receiving no entry are treated as irrelevant
    for (var ic = 0; ic < itemCovered.length; ic++) {
      if (!itemCovered[ic]) {
        judgeNoVerdict++;
        irrelevantCount++;
        allDropped.push({ platform: platform, url: items[ic].url, domain: items[ic].domain, drop_stage: "judge_no_verdict", drop_reason: "No verdict returned by judge", entity_match: null });
      }
    }

    return { retained: retained, dropped: allDropped, quoteGateFailed: quoteGateFailed, irrelevantCount: irrelevantCount, judgeParseFailed: judgeParseFailed, judgeIndexInvalid: judgeIndexInvalid, judgeNoVerdict: judgeNoVerdict, rawResponse: responseText };
  } catch (err) {
    console.log(LOG_PREFIX + " Judgment call failed: " + String(err));
    var catchDrops: DroppedItem[] = items.map(function (it) { return { platform: platform, url: it.url, domain: it.domain, drop_stage: "judge_parse_failed", drop_reason: "Judgment call exception: " + String(err), entity_match: null }; });
    return { retained: [], dropped: catchDrops, quoteGateFailed: 0, irrelevantCount: items.length, judgeParseFailed: 0, judgeIndexInvalid: 0, judgeNoVerdict: 0, rawResponse: "" };
  }
}

// ── Stage handler ───────────────────────────────────────────────────
var verifyClaims: StageHandler = async function (
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;
  var claude = ctx.integrations.claude;
  var claimLimit: number | null = typeof ctx._claimLimit === "number" ? ctx._claimLimit : null;

  // ══ Marker guard — FIRST database operation ═══════════════════════
  var completedRows = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " check stages_completed (FIRST)" },
  );

  if (completedRows.length > 0) {
    var completed = completedRows[0].stages_completed;
    for (var mi = 0; mi < completed.length; mi++) {
      if (completed[mi] === STAGE_NAME) {
        var existingFindings = await db.query(
          "SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = $1 LIMIT 1",
          CountRow,
          [runId],
          { label: LOG_PREFIX + " existing finding count (marker present)" },
        );
        var existingCount = existingFindings.length > 0 ? existingFindings[0].cnt : 0;
        return {
          stage: STAGE_NAME,
          status: "complete",
          message: "Already complete (" + existingCount + " findings). Skipped re-verification.",
          stageData: { findingCount: existingCount, alreadyComplete: true },
        };
      }
    }
  }

  // ══ Advisory lock ═════════════════════════════════════════════════
  var lockRows = await db.query(
    "SELECT pg_try_advisory_lock(hashtext($1::text)::bigint) AS locked",
    LockRow,
    [runId],
    { label: LOG_PREFIX + " acquire advisory lock" },
  );
  var lockAcquired = lockRows.length > 0 && lockRows[0].locked === true;
  if (!lockAcquired) {
    return {
      stage: STAGE_NAME,
      status: "in_progress",
      message: "another execution holds the lock",
      stageData: {},
    };
  }

  // ── TOCTOU recheck under lock ─────────────────────────────────────
  var recheck = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " re-check marker under lock" },
  );
  if (recheck.length > 0) {
    for (var rci = 0; rci < recheck[0].stages_completed.length; rci++) {
      if (recheck[0].stages_completed[rci] === STAGE_NAME) {
        try {
          await db.execute("SELECT pg_advisory_unlock(hashtext($1::text)::bigint)", [runId], { label: LOG_PREFIX + " release lock (recheck)" });
        } catch (e) { /* best effort */ }
        var recheckFindings = await db.query(
          "SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = $1 LIMIT 1",
          CountRow, [runId],
          { label: LOG_PREFIX + " count after recheck" },
        );
        return {
          stage: STAGE_NAME,
          status: "complete",
          message: "Already complete (" + (recheckFindings.length > 0 ? recheckFindings[0].cnt : 0) + " findings). Skipped.",
          stageData: { findingCount: recheckFindings.length > 0 ? recheckFindings[0].cnt : 0, alreadyComplete: true },
        };
      }
    }
  }

  try {
    // ── Inline ALTERs ───────────────────────────────────────────────
    await db.execute(
      "ALTER TABLE sri_pipeline_state ADD COLUMN IF NOT EXISTS verify_claim_cursor INT NOT NULL DEFAULT 0",
      [],
      { label: LOG_PREFIX + " ensure verify_claim_cursor column" },
    );
    await db.execute(
      "ALTER TABLE sri_evidence ADD COLUMN IF NOT EXISTS stance TEXT",
      [],
      { label: LOG_PREFIX + " ensure stance column on sri_evidence" },
    );
    await db.execute(
      "ALTER TABLE sri_evidence ADD COLUMN IF NOT EXISTS entity_match TEXT",
      [],
      { label: LOG_PREFIX + " ensure entity_match column on sri_evidence" },
    );
    await db.execute(
      "ALTER TABLE sri_findings ADD COLUMN IF NOT EXISTS entity_confidence TEXT",
      [],
      { label: LOG_PREFIX + " ensure entity_confidence column on sri_findings" },
    );
    await db.execute(
      "ALTER TABLE sri_findings ADD COLUMN IF NOT EXISTS pointer_text TEXT",
      [],
      { label: LOG_PREFIX + " ensure pointer_text column on sri_findings" },
    );

    // ── Load target profile for entity matching ──────────────────
    var profileRows = await db.query(
      "SELECT identity_type, identity_value FROM sri_target_identity WHERE run_id = $1 AND identity_type IN ('profile_field', 'trading_name') ORDER BY identity_type, identity_value",
      z.object({ identity_type: z.string(), identity_value: z.string() }),
      [runId],
      { label: LOG_PREFIX + " load target profile" },
    );
    var targetProfileText = "";
    if (profileRows.length > 0) {
      var profileLines: string[] = [];
      for (var pi2 = 0; pi2 < profileRows.length; pi2++) {
        profileLines.push(profileRows[pi2].identity_type + ": " + profileRows[pi2].identity_value);
      }
      targetProfileText = profileLines.join("\n");
    }

    // ── Stage-start diagnostics (committed immediately) ─────────────
    try {
      await db.execute(
        "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb)",
        [runId, "verify_claims_start", JSON.stringify({
          claimsToProcess: 0,
          claimLimit: claimLimit,
          platformRouting: PLATFORM_ROUTING,
          allowedDomains: PLATFORM_ALLOWED_DOMAINS,
          timestamp: new Date().toISOString(),
          hasTargetProfile: profileRows.length > 0,
          profileFieldCount: profileRows.length,
        })],
        { label: LOG_PREFIX + " persist start diagnostics" },
      );
    } catch (diagStartErr) {
      console.log(LOG_PREFIX + " Failed to persist start diagnostics (non-fatal): " + String(diagStartErr));
    }

    // ── Load all claims for this run ────────────────────────────────
    var claims = await db.query(
      "SELECT claim_id, claim_text, claim_type, subject_entity, thesis_dependence FROM sri_claims WHERE run_id = $1 ORDER BY created_at",
      ClaimRow,
      [runId],
      { label: LOG_PREFIX + " load claims" },
    );

    // Update start diagnostics with actual count
    try {
      await db.execute(
        "UPDATE sri_stage_diagnostics SET payload = jsonb_set(payload, '{claimsToProcess}', $2::text::jsonb) WHERE run_id = $1 AND stage = 'verify_claims_start' AND payload->>'claimsToProcess' = '0'",
        [runId, String(claims.length)],
        { label: LOG_PREFIX + " update start diagnostics claim count" },
      );
    } catch (e) { /* best effort */ }

    // ── Counters ────────────────────────────────────────────────────
    var claimsProcessed = 0;
    var claimsNewlyProcessed = 0;
    var pairsAttempted = 0;
    var pairsWithEvidence = 0;
    var pairsNoEvidence = 0;
    var evidenceRowsWritten = 0;
    var urlsRejectedNoHost = 0;
    var domainMismatchDropped = 0;
    var quoteGateFailed = 0;
    var judgeParseFailed = 0;
    var judgeIndexInvalid = 0;
    var judgeNoVerdict = 0;
    var claimsSkippedNoSubject = 0;
    var droppedEvidenceCount = 0;
    var verdictDistribution: Record<string, number> = {};
    var severityDistribution: Record<string, number> = {};
    var perPlatformCounts: Record<string, { attempted: number; withEvidence: number }> = {};
    var sampleFindings: any[] = [];

    // ── Process claims sequentially ─────────────────────────────────
    for (var idx = 0; idx < claims.length; idx++) {
      // ── claimLimit check ──────────────────────────────────────────
      if (claimLimit !== null && claimsNewlyProcessed >= claimLimit) {
        break;
      }

      var claim = claims[idx];

      // ── Skip already-processed claims (resume support) ────────────
      var existingFinding = await db.query(
        "SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = $1 AND claim_id = $2 LIMIT 1",
        FindingExistsRow,
        [runId, claim.claim_id],
        { label: LOG_PREFIX + " check existing finding for claim " + (idx + 1) },
      );
      if (existingFinding.length > 0 && existingFinding[0].cnt > 0) {
        claimsProcessed++;
        continue;
      }

      // ── Determine platforms ───────────────────────────────────────
      var platforms = PLATFORM_ROUTING[claim.claim_type] || [];
      if (platforms.length === 0) {
        await db.execute(
          "INSERT INTO sri_findings (finding_id, run_id, claim_id, verdict, severity, title, detail, created_at) VALUES (gen_random_uuid(), $1, $2, 'not_searched', 'info', $3, $4, now())",
          [runId, claim.claim_id, "No platform routing for " + claim.claim_type, "Claim type has no configured search platforms."],
          { label: LOG_PREFIX + " insert not_searched finding" },
        );
        claimsProcessed++;
        claimsNewlyProcessed++;
        verdictDistribution["not_searched"] = (verdictDistribution["not_searched"] || 0) + 1;
        severityDistribution["info"] = (severityDistribution["info"] || 0) + 1;
        continue;
      }

      // ── Search subject (no fallback — null subject → not_searched) ──
      var searchSubject = claim.subject_entity;
      if (!searchSubject) {
        await db.execute(
          "INSERT INTO sri_findings (finding_id, run_id, claim_id, verdict, severity, title, detail, entity_confidence, created_at) VALUES (gen_random_uuid(), $1, $2, 'not_searched', 'info', $3, $4, 'none', now())",
          [runId, claim.claim_id, "No subject entity on claim", "Claim has no subject_entity. Cannot search without an entity name."],
          { label: LOG_PREFIX + " insert not_searched finding (no subject)" },
        );
        claimsProcessed++;
        claimsNewlyProcessed++;
        claimsSkippedNoSubject++;
        verdictDistribution["not_searched"] = (verdictDistribution["not_searched"] || 0) + 1;
        severityDistribution["info"] = (severityDistribution["info"] || 0) + 1;
        continue;
      }

      // ── Search each platform ──────────────────────────────────────
      var claimSupportsCount = 0;
      var claimContradictsCount = 0;
      var claimEvidenceUrls: string[] = [];
      var claimEntityMatches: string[] = [];

      for (var pi = 0; pi < platforms.length; pi++) {
        var platform = platforms[pi];
        pairsAttempted++;

        if (!perPlatformCounts[platform]) {
          perPlatformCounts[platform] = { attempted: 0, withEvidence: 0 };
        }
        perPlatformCounts[platform].attempted++;

        // ── Build search prompt (no platform name in text) ──────────
        var searchPrompt = "Search for information about " + searchSubject + " related to this claim: \"" + claim.claim_text + "\"\n\nReturn what you find. Report the facts as they appear in search results.";

        // ── Build web_search tool config with allowed_domains ────────
        var toolConfig: any = {
          type: "web_search_20250305" as string,
          name: "web_search",
          max_uses: WEB_SEARCH_MAX_USES,
        };
        var allowedDomains = PLATFORM_ALLOWED_DOMAINS[platform];
        if (allowedDomains) {
          toolConfig.allowed_domains = allowedDomains;
        }

        try {
          var searchResponse = await claude.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model: SEARCH_MODEL,
                max_tokens: SEARCH_MAX_TOKENS,
                messages: [{ role: "user", content: searchPrompt }],
                tools: [toolConfig],
              },
            },
            { response: WebSearchResponseSchema },
            { label: LOG_PREFIX + " search " + platform + " claim " + (idx + 1) },
          );

          // ── Extract harvested items ───────────────────────────────
          var extracted = extractHarvestedItems(searchResponse);
          urlsRejectedNoHost += extracted.urlsRejectedNoHost;

          // ── Code-side domain backstop ─────────────────────────────
          var domainFiltered: HarvestedItem[] = [];
          if (platform === "news") {
            // news: legitimately open web, no domain filter
            domainFiltered = extracted.items;
          } else if (allowedDomains) {
            for (var di = 0; di < extracted.items.length; di++) {
              var item = extracted.items[di];
              var domainOk = false;
              for (var ai = 0; ai < allowedDomains.length; ai++) {
                if (item.domain === allowedDomains[ai] || item.domain.endsWith("." + allowedDomains[ai])) {
                  domainOk = true;
                  break;
                }
              }
              if (domainOk) {
                domainFiltered.push(item);
              } else {
                domainMismatchDropped++;
                await db.execute(
                  "INSERT INTO sri_dropped_evidence (run_id, claim_id, platform, url, domain, drop_stage, drop_reason, created_at) VALUES ($1, $2, $3, $4, $5, 'domain_backstop', $6, now())",
                  [runId, claim.claim_id, platform, item.url, item.domain, "Domain " + item.domain + " not in allowed list for " + platform],
                  { label: LOG_PREFIX + " drop: domain_backstop" },
                );
                droppedEvidenceCount++;
              }
            }
          } else {
            // Unknown platform with no allowed_domains — fail loud
            throw new Error("Platform '" + platform + "' has no PLATFORM_ALLOWED_DOMAINS entry and is not 'news'. This is a configuration error.");
          }

          if (domainFiltered.length === 0) {
            pairsNoEvidence++;
            continue;
          }

          // ── Per-URL relevance judgment ─────────────────────────────
          var judgment = await judgeRelevance(
            claude,
            claim.claim_text,
            domainFiltered,
            LOG_PREFIX + " judge " + platform + " claim " + (idx + 1),
            targetProfileText,
            platform,
          );
          quoteGateFailed += judgment.quoteGateFailed;
          judgeParseFailed += judgment.judgeParseFailed;
          judgeIndexInvalid += judgment.judgeIndexInvalid;
          judgeNoVerdict += judgment.judgeNoVerdict;

          // Write drop records for every dropped item
          for (var dri = 0; dri < judgment.dropped.length; dri++) {
            var drop = judgment.dropped[dri];
            await db.execute(
              "INSERT INTO sri_dropped_evidence (run_id, claim_id, platform, url, domain, drop_stage, drop_reason, entity_match, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())",
              [runId, claim.claim_id, drop.platform, drop.url, drop.domain, drop.drop_stage, drop.drop_reason, drop.entity_match],
              { label: LOG_PREFIX + " drop: " + drop.drop_stage },
            );
            droppedEvidenceCount++;
          }

          // ── Persist raw judge response for diagnostics ──────────
          if (judgment.rawResponse.length > 0) {
            try {
              await db.execute(
                "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb)",
                [runId, "verify_claims_judge", JSON.stringify({
                  claim_index: idx + 1,
                  platform: platform,
                  retained_count: judgment.retained.length,
                  dropped_count: judgment.dropped.length,
                  raw_response: judgment.rawResponse.slice(0, 4000),
                  timestamp: new Date().toISOString(),
                })],
                { label: LOG_PREFIX + " judge diagnostics " + platform + " claim " + (idx + 1) },
              );
            } catch (jdErr) {
              console.log(LOG_PREFIX + " Judge diagnostics failed (non-fatal): " + String(jdErr));
            }
          }

          if (judgment.retained.length > 0) {
            pairsWithEvidence++;
            perPlatformCounts[platform].withEvidence++;

            for (var ei = 0; ei < judgment.retained.length; ei++) {
              var ev = judgment.retained[ei];
              await db.execute(
                "INSERT INTO sri_evidence (evidence_id, claim_id, platform, url, domain, snippet, stance, entity_match, retrieved_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now()) ON CONFLICT (claim_id, url) DO NOTHING",
                [claim.claim_id, platform, ev.url, ev.domain, ev.snippet, ev.stance, ev.entity_match],
                { label: LOG_PREFIX + " insert evidence" },
              );
              evidenceRowsWritten++;
              claimEvidenceUrls.push(ev.url);
              claimEntityMatches.push(ev.entity_match);
              if (ev.stance === "supports") claimSupportsCount++;
              if (ev.stance === "contradicts") claimContradictsCount++;
            }
          } else {
            pairsNoEvidence++;
          }
        } catch (searchErr) {
          console.log(LOG_PREFIX + " Search error for claim " + (idx + 1) + " platform " + platform + ": " + String(searchErr));
          pairsNoEvidence++;
        }
      }

      // ── Verdict from counted stances (Item 6) ─────────────────────
      var s = claimSupportsCount;
      var c = claimContradictsCount;
      var verdict: string;
      if (c === 0 && s === 0) {
        verdict = "unverifiable";
      } else if (c === 0 && s >= 1) {
        verdict = "corroborated";
      } else if (c >= 1 && c >= 2 * s) {
        verdict = "contradicted";
      } else {
        verdict = "mixed";
      }

      // ── Entity confidence from retained evidence ───────────────
      var entityConfidence: string;
      if (claimEntityMatches.length === 0) {
        entityConfidence = "none";
      } else {
        var allConfirmed = true;
        var allAmbiguous = true;
        for (var eci = 0; eci < claimEntityMatches.length; eci++) {
          if (claimEntityMatches[eci] !== "confirmed") allConfirmed = false;
          if (claimEntityMatches[eci] !== "ambiguous") allAmbiguous = false;
        }
        if (allConfirmed) {
          entityConfidence = "confirmed";
        } else if (allAmbiguous) {
          entityConfidence = "ambiguous";
        } else {
          entityConfidence = "mixed_confidence";
        }
      }

      // ── Severity with entity confidence ceiling ─────────────────
      var rawSeverity = assignSeverity(verdict, claim.thesis_dependence, c);
      var severity = rawSeverity;
      if (entityConfidence === "ambiguous") {
        // All rows ambiguous → ceiling is info
        if (severity === "critical" || severity === "warning") {
          severity = "info";
        }
      } else if (entityConfidence === "mixed_confidence") {
        // Some ambiguous → ceiling is warning (critical unreachable)
        if (severity === "critical") {
          severity = "warning";
        }
      }
      // entityConfidence === "confirmed" → full range, no ceiling

      verdictDistribution[verdict] = (verdictDistribution[verdict] || 0) + 1;
      severityDistribution[severity] = (severityDistribution[severity] || 0) + 1;

      // ── Write finding ─────────────────────────────────────────────
      var findingTitle = verdict === "unverifiable"
        ? "No public evidence found for claim"
        : verdict === "contradicted"
          ? "Public evidence contradicts claim"
          : verdict === "mixed"
            ? "Mixed public evidence for claim"
            : "Public evidence corroborates claim";
      var findingDetail = "Claim: " + claim.claim_text + "\nVerdict: " + verdict + " | Severity: " + severity + " | Entity confidence: " + entityConfidence + " | Supports: " + s + " | Contradicts: " + c;

      // ── Pointer text for ambiguous/mixed_confidence findings ────
      var pointerText: string | null = null;
      if (entityConfidence === "ambiguous" || entityConfidence === "mixed_confidence") {
        pointerText = "The claim \"" + claim.claim_text + "\" could not be independently confirmed as referring to the target company.";
      }

      await db.execute(
        "INSERT INTO sri_findings (finding_id, run_id, claim_id, verdict, severity, title, detail, entity_confidence, pointer_text, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())",
        [runId, claim.claim_id, verdict, severity, findingTitle, findingDetail, entityConfidence, pointerText],
        { label: LOG_PREFIX + " insert finding for claim " + (idx + 1) },
      );

      // ── Update cursor ─────────────────────────────────────────────
      await db.execute(
        "UPDATE sri_pipeline_state SET verify_claim_cursor = $2, updated_at = now() WHERE run_id = $1",
        [runId, idx + 1],
        { label: LOG_PREFIX + " update cursor to " + (idx + 1) },
      );

      claimsProcessed++;
      claimsNewlyProcessed++;

      // ── Per-claim diagnostics (committed immediately) ─────────
      try {
        var claimDiag = {
          claimsProcessed: claimsProcessed,
          claimsNewlyProcessed: claimsNewlyProcessed,
          evidenceRowsWritten: evidenceRowsWritten,
          droppedEvidenceCount: droppedEvidenceCount,
          verdictDistribution: verdictDistribution,
          severityDistribution: severityDistribution,
          timestamp: new Date().toISOString(),
        };
        await db.execute(
          "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (run_id, stage) DO UPDATE SET payload = $3::jsonb",
          [runId, STAGE_NAME, JSON.stringify(claimDiag)],
          { label: LOG_PREFIX + " per-claim diagnostics " + (idx + 1) },
        );
      } catch (pcDiagErr) {
        console.log(LOG_PREFIX + " Per-claim diagnostics failed (non-fatal): " + String(pcDiagErr));
      }

      // ── Collect sample findings ───────────────────────────────────
      if (sampleFindings.length < 10) {
        sampleFindings.push({
          claim_text: claim.claim_text,
          claim_type: claim.claim_type,
          subject_entity: claim.subject_entity,
          thesis_dependence: claim.thesis_dependence,
          verdict: verdict,
          severity: severity,
          entity_confidence: entityConfidence,
          supports: s,
          contradicts: c,
          evidence_urls: claimEvidenceUrls,
        });
      }
    }

    // ── If claimLimit hit, return in_progress without writing marker ─
    if (claimLimit !== null && claimsNewlyProcessed >= claimLimit && claimsProcessed < claims.length) {
      var partialData: Record<string, unknown> = {
        claimsProcessed: claimsProcessed,
        claimsNewlyProcessed: claimsNewlyProcessed,
        claimLimit: claimLimit,
        pairsAttempted: pairsAttempted,
        pairsWithEvidence: pairsWithEvidence,
        pairsNoEvidence: pairsNoEvidence,
        evidenceRowsWritten: evidenceRowsWritten,
        urlsRejectedNoHost: urlsRejectedNoHost,
        domainMismatchDropped: domainMismatchDropped,
        quoteGateFailed: quoteGateFailed,
        judgeParseFailed: judgeParseFailed,
        judgeIndexInvalid: judgeIndexInvalid,
        judgeNoVerdict: judgeNoVerdict,
        claimsSkippedNoSubject: claimsSkippedNoSubject,
        droppedEvidenceCount: droppedEvidenceCount,
        verdictDistribution: verdictDistribution,
        severityDistribution: severityDistribution,
        perPlatformCounts: perPlatformCounts,
        sampleFindings: sampleFindings,
      };

      return {
        stage: STAGE_NAME,
        status: "in_progress",
        message: "Scoped run: processed " + claimsNewlyProcessed + " of " + claims.length + " claims (limit " + claimLimit + ").",
        stageData: partialData,
      };
    }

    // ── Completion: diagnostics outside transaction, marker inside ───
    var stageData: Record<string, unknown> = {
      claimsProcessed: claimsProcessed,
      pairsAttempted: pairsAttempted,
      pairsWithEvidence: pairsWithEvidence,
      pairsNoEvidence: pairsNoEvidence,
      evidenceRowsWritten: evidenceRowsWritten,
      urlsRejectedNoHost: urlsRejectedNoHost,
      domainMismatchDropped: domainMismatchDropped,
      quoteGateFailed: quoteGateFailed,
      judgeParseFailed: judgeParseFailed,
      judgeIndexInvalid: judgeIndexInvalid,
      judgeNoVerdict: judgeNoVerdict,
      claimsSkippedNoSubject: claimsSkippedNoSubject,
      droppedEvidenceCount: droppedEvidenceCount,
      verdictDistribution: verdictDistribution,
      severityDistribution: severityDistribution,
      perPlatformCounts: perPlatformCounts,
      sampleFindings: sampleFindings,
    };

    // Diagnostics committed BEFORE the marker transaction
    try {
      await db.execute(
        "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (run_id, stage) DO UPDATE SET payload = $3::jsonb",
        [runId, STAGE_NAME, JSON.stringify(stageData)],
        { label: LOG_PREFIX + " persist completion diagnostics" },
      );
    } catch (diagErr) {
      console.log(LOG_PREFIX + " Failed to persist diagnostics (non-fatal): " + String(diagErr));
    }

    await db.execute("BEGIN", [], { label: LOG_PREFIX + " BEGIN completion transaction" });
    try {

      await db.execute(
        "UPDATE sri_pipeline_state SET stages_completed = array_append(stages_completed, $2), updated_at = now() WHERE run_id = $1 AND NOT ($2 = ANY(stages_completed))",
        [runId, STAGE_NAME],
        { label: LOG_PREFIX + " mark stage complete" },
      );

      await db.execute("COMMIT", [], { label: LOG_PREFIX + " COMMIT completion transaction" });
    } catch (txErr) {
      try { await db.execute("ROLLBACK", [], { label: LOG_PREFIX + " ROLLBACK" }); } catch (e) { /* best effort */ }
      throw txErr;
    }

    return {
      stage: STAGE_NAME,
      status: "complete",
      message: claimsProcessed + " claims verified. " + evidenceRowsWritten + " evidence rows written.",
      stageData: stageData,
    };
  } finally {
    try {
      await db.execute(
        "SELECT pg_advisory_unlock(hashtext($1::text)::bigint)",
        [runId],
        { label: LOG_PREFIX + " release advisory lock" },
      );
    } catch (e) { /* best effort */ }
  }
};

export { verifyClaims };
