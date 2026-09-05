/**
 * sri-claim-register.ts
 *
 * SRI v2 — Stage 1: Build Claim Register
 *
 * Reads IC memo chunks only (not CIM, consultant, legal, or financial_model).
 * Extracts reputation claims the deal team asserts that a public platform
 * could speak to (Glassdoor, Indeed, LinkedIn, Trustpilot, G2, news).
 *
 * CHANGE 1 (2C): Marker guard is the FIRST statement — before lock, before purge.
 * CHANGE 2 (2C): Purge only on genuinely fresh start (marker absent, cursor 0).
 * CHANGE 3 (2C): Final inserts + marker in a single BEGIN/COMMIT transaction.
 * CHANGE 4 (2C): Near-duplicate dedup pass using token-set overlap (0.85 threshold).
 *
 * Inserts surviving rows into sri_claims. No writes to sri_evidence or sri_findings.
 */

import type { StageHandler, StageResult } from "./sri-stage-contract.js";
import { z } from "@superblocksteam/sdk-api";

var LOG_PREFIX = "[SRI-CLAIM-REGISTER]";
var MAX_OUTPUT_TOKENS = 4096;
var BATCH_SIZE = 12;
var STAGE_NAME = "build_claim_register";
var MODEL = "claude-sonnet-4-6";
var NEAR_DEDUP_THRESHOLD = 0.85;

// ── Valid enum sets ─────────────────────────────────────────────────────
var VALID_CLAIM_TYPES = new Set([
  "culture",
  "retention_attrition",
  "headcount",
  "nps_csat",
  "customer_satisfaction",
  "employer_reputation",
  "brand_reputation",
  "award",
]);

var VALID_ATTRIBUTIONS = new Set([
  "deal_team",
  "management",
  "cim",
  "third_party",
]);

// ── thesis_dependence lookup by claim_type ──────────────────────────────
var THESIS_DEPENDENCE: Record<string, string> = {
  retention_attrition: "high",
  employer_reputation: "high",
  culture: "medium",
  nps_csat: "medium",
  customer_satisfaction: "medium",
  headcount: "low",
  brand_reputation: "low",
  award: "low",
};

// ── Relevance rejection reasons ─────────────────────────────────────────
var RELEVANCE_REJECT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /deal\s+structure|deal\s+economics|deal\s+terms/i, reason: "deal structure and economics" },
  { pattern: /equity\s+ownership|rollover|roll[\s-]*over|equity\s+roll/i, reason: "equity ownership and rollover" },
  { pattern: /earn[\s-]*out|incentive\s+plan|MIP|management\s+incentive/i, reason: "earn-outs and incentive plans" },
  { pattern: /investor\s+return|return\s+to\s+\w+bridge|delivered\s+\d+x/i, reason: "historical investor returns" },
  { pattern: /\d+\s*acquisitions|\d+\+?\s*deals?\s+(completed|done|closed)/i, reason: "M&A deal counts" },
  { pattern: /financing\s+terms|debt\s+structure|leverage|LTV|syndication/i, reason: "financing terms" },
  { pattern: /valuation|multiple|EV\s*\/|theoretical\s+EV|implied\s+EV/i, reason: "valuation" },
  { pattern: /revenue\s+of|EBITDA|£\d+m\s+revenue|\$\d+m\s+revenue|revenue\s+in\s+FY/i, reason: "revenue and EBITDA figures" },
  { pattern: /market\s+share|~?\d+%\s+market/i, reason: "market share" },
  { pattern: /pricing|£\d+\s+per\s+seat|price[\s-]*point|priced\s+at/i, reason: "pricing" },
  { pattern: /product\s+feature|UI\/UX|platform\s+capability|phonebar|integration\s+with/i, reason: "product features" },
];

// ── Whitespace normalization ────────────────────────────────────────────
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── Token-set overlap for near-duplicate detection ──────────────────────
function tokenSetOverlap(a: string, b: string): number {
  var tokensA = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (t) { return t.length > 2; });
  var tokensB = b.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(function (t) { return t.length > 2; });
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  var setA = new Set(tokensA);
  var setB = new Set(tokensB);
  var intersection = 0;
  for (var ti = 0; ti < tokensA.length; ti++) {
    if (setB.has(tokensA[ti])) intersection++;
  }
  var smaller = Math.min(setA.size, setB.size);
  if (smaller === 0) return 0;
  return intersection / smaller;
}

// ── DB row schemas ──────────────────────────────────────────────────────
var ChunkRow = z.object({
  id: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

var AnthropicResponse = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

var CursorRow = z.object({
  claim_batch_cursor: z.coerce.number().nullable(),
});

var StagesCompletedRow = z.object({
  stages_completed: z.array(z.string()),
});

var LockRow = z.object({ locked: z.boolean() });

// ── Extraction prompt ───────────────────────────────────────────────────
var SYSTEM_PROMPT =
  "You are an investment diligence analyst specializing in social and reputation intelligence. Extract only reputation claims that a public platform (Glassdoor, Indeed, LinkedIn, Trustpilot, G2, or news outlets) could speak to. Return only valid JSON.";

function buildUserPrompt(chunkContent: string, fileName: string): string {
  return "Below is a section of an investment committee memo (file: " + fileName + "). Extract ONLY reputation claims that could be verified or contradicted on a public platform such as Glassdoor, Indeed, LinkedIn, Trustpilot, G2, or named news coverage.\n\nQualifying claim types (use EXACTLY one of these):\n- culture: company values, work environment, employee satisfaction\n- retention_attrition: employee turnover, retention rates, attrition\n- headcount: headcount growth, hiring plans, workforce size\n- nps_csat: Net Promoter Score, CSAT scores, quantified satisfaction metrics\n- customer_satisfaction: qualitative customer satisfaction, service quality, support quality\n- employer_reputation: what it is like to work at the company, leadership as perceived by employees or the public, public standing of named executives\n- brand_reputation: brand perception, market reputation, competitive standing as perceived externally\n- award: awards, certifications, recognitions received\n\nDO NOT extract any of the following — these are not reputation claims:\n- Deal structure, economics, or terms\n- Equity ownership, rollover, or earn-out arrangements\n- Historical investor returns (e.g. \"delivered 3x\")\n- M&A deal counts (e.g. \"50 acquisitions\")\n- Financing terms, debt, leverage\n- Valuation or multiples\n- Revenue, EBITDA, or financial figures\n- Market share percentages\n- Pricing or price points\n- Product features or technical capabilities\n- Management incentive plans\n\nMost chunks in an IC memo contain NO reputation claims. If a chunk is about financials, deal terms, market sizing, or product features, return an empty array.\n\nFor each claim, provide:\n- claim_text: the assertion normalized to one clear sentence\n- verbatim_snippet: the EXACT passage from the text. Copy it character for character. Do not fix whitespace, newlines, or formatting.\n- claim_type: exactly one of the eight types listed above\n- subject_entity: the company or brand the claim is about, exactly as written\n- attribution: exactly one of: deal_team, management, cim, third_party\n- metric_value: the specific figure if stated, otherwise null\n\nReturn a JSON array only. No prose. No markdown fences. Return [] if no qualifying claims exist.\n\n--- CHUNK TEXT ---\n" + chunkContent + "\n--- END CHUNK TEXT ---";
}

// ── Candidate row type ──────────────────────────────────────────────────
type ClaimCandidate = {
  claim_text: string;
  verbatim_snippet: string;
  claim_type: string;
  subject_entity: string | null;
  attribution: string;
  metric_value: string | null;
  thesis_dependence: string;
  document_id: string;
  chunk_index: number;
  locator: string;
  subject_unverified: boolean;
  member_count: number;
  source_locators: string[];
};

// ── Stage handler ───────────────────────────────────────────────────────
var buildClaimRegister: StageHandler = async function (
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;
  var claude = ctx.integrations.claude;

  // ══ CHANGE 1: Marker guard is the FIRST database operation ══════════
  // If build_claim_register is in stages_completed, return immediately.
  // No lock, no purge, no extraction.
  var completedRows = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " check stages_completed (FIRST)" },
  );

  if (completedRows.length > 0) {
    var completed = completedRows[0].stages_completed;
    for (var ci = 0; ci < completed.length; ci++) {
      if (completed[ci] === STAGE_NAME) {
        var existingCountRows = await db.query(
          "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
          z.object({ cnt: z.coerce.number() }),
          [runId],
          { label: LOG_PREFIX + " existing claim count (marker present)" },
        );
        var existingCount = existingCountRows.length > 0 ? existingCountRows[0].cnt : 0;
        return {
          stage: STAGE_NAME,
          status: "complete",
          message: "Already complete (" + existingCount + " claims). Skipped re-extraction.",
          stageData: { claimCount: existingCount, alreadyComplete: true },
        };
      }
    }
  }

  // ── Advisory lock ───────────────────────────────────────────────────
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

  // ── Re-check marker under lock (prevents TOCTOU race) ──────────────
  var recheck = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " re-check marker under lock" },
  );
  if (recheck.length > 0) {
    for (var rci = 0; rci < recheck[0].stages_completed.length; rci++) {
      if (recheck[0].stages_completed[rci] === STAGE_NAME) {
        // Release lock and return
        try {
          await db.execute(
            "SELECT pg_advisory_unlock(hashtext($1::text)::bigint)",
            [runId],
            { label: LOG_PREFIX + " release lock (marker found on recheck)" },
          );
        } catch (e) { /* best effort */ }
        var recheckCount = await db.query(
          "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
          z.object({ cnt: z.coerce.number() }),
          [runId],
          { label: LOG_PREFIX + " count after recheck" },
        );
        return {
          stage: STAGE_NAME,
          status: "complete",
          message: "Already complete (" + (recheckCount.length > 0 ? recheckCount[0].cnt : 0) + " claims). Skipped re-extraction.",
          stageData: { claimCount: recheckCount.length > 0 ? recheckCount[0].cnt : 0, alreadyComplete: true },
        };
      }
    }
  }

  // Wrap all remaining work in try/finally to guarantee lock release
  try {
    return await doExtraction(db, claude, runId, dealId);
  } finally {
    try {
      await db.execute(
        "SELECT pg_advisory_unlock(hashtext($1::text)::bigint)",
        [runId],
        { label: LOG_PREFIX + " release advisory lock" },
      );
    } catch (unlockErr) {
      console.log(LOG_PREFIX + " Failed to release advisory lock: " + String(unlockErr));
    }
  }
};

async function doExtraction(db: any, claude: any, runId: string, dealId: string): Promise<StageResult> {
  // ── Ensure columns exist ────────────────────────────────────────────
  await db.execute(
    "ALTER TABLE sri_pipeline_state ADD COLUMN IF NOT EXISTS claim_batch_cursor int DEFAULT 0",
    [],
    { label: LOG_PREFIX + " ensure claim_batch_cursor column" },
  );
  await db.execute(
    "ALTER TABLE sri_claims ADD COLUMN IF NOT EXISTS subject_entity text",
    [],
    { label: LOG_PREFIX + " ensure subject_entity column" },
  );
  await db.execute(
    "ALTER TABLE sri_claims ADD COLUMN IF NOT EXISTS attribution text NOT NULL DEFAULT 'deal_team'",
    [],
    { label: LOG_PREFIX + " ensure attribution column" },
  );
  await db.execute(
    "ALTER TABLE sri_claims ADD COLUMN IF NOT EXISTS subject_unverified boolean NOT NULL DEFAULT false",
    [],
    { label: LOG_PREFIX + " ensure subject_unverified column" },
  );
  await db.execute(
    "ALTER TABLE sri_claims ADD COLUMN IF NOT EXISTS member_count int NOT NULL DEFAULT 1",
    [],
    { label: LOG_PREFIX + " ensure member_count column" },
  );
  await db.execute(
    "ALTER TABLE sri_claims ADD COLUMN IF NOT EXISTS source_locators text[] NOT NULL DEFAULT '{}'",
    [],
    { label: LOG_PREFIX + " ensure source_locators column" },
  );

  // ══ CHANGE 2: Purge only on genuinely fresh start ══════════════════
  var cursorRows = await db.query(
    "SELECT claim_batch_cursor FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    CursorRow,
    [runId],
    { label: LOG_PREFIX + " read batch cursor" },
  );
  var batchCursor = (cursorRows.length > 0 && cursorRows[0].claim_batch_cursor != null)
    ? cursorRows[0].claim_batch_cursor
    : 0;

  if (batchCursor === 0) {
    // Genuinely fresh start — clear any partial claims from a prior failed attempt
    await db.execute(
      "DELETE FROM sri_claims WHERE run_id = $1",
      [runId],
      { label: LOG_PREFIX + " purge claims for fresh start (cursor=0, marker absent)" },
    );
  }

  // ── Load IC memo chunks ─────────────────────────────────────────────
  var chunks = await db.query(
    "SELECT dc.id, dc.chunk_index, dc.content, dc.document_id, dc.file_name FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE d.deal_id = $1 AND d.document_tag = 'ic_memo' ORDER BY dc.document_id, dc.chunk_index",
    ChunkRow,
    [dealId],
    { label: LOG_PREFIX + " load IC memo chunks" },
  );

  if (chunks.length === 0) {
    return {
      stage: STAGE_NAME,
      status: "failed",
      message: "No IC memo chunks found for deal " + dealId,
      stageData: { claimCount: 0 },
    };
  }

  // ── Build batches ───────────────────────────────────────────────────
  var batches: Array<typeof chunks> = [];
  for (var bi = 0; bi < chunks.length; bi += BATCH_SIZE) {
    batches.push(chunks.slice(bi, bi + BATCH_SIZE));
  }

  // ── Tracking ────────────────────────────────────────────────────────
  var allCandidates: ClaimCandidate[] = [];
  var chunksProcessed = 0;
  var droppedRows: Array<{ claim_text: string; reason: string }> = [];
  var rejectedByRelevance: Array<{ claim_text: string; reason: string }> = [];
  var coercedAttribution = 0;
  var subjectUnverifiedCount = 0;
  var gatePassAfterNormalization = 0;
  var gateStillFailing = 0;
  var totalInputTokens = 0;
  var totalOutputTokens = 0;
  var batchErrors = 0;

  // ── Process all batches ─────────────────────────────────────────────
  for (var batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    var batch = batches[batchIdx];

    for (var chunkI = 0; chunkI < batch.length; chunkI++) {
      var chunk = batch[chunkI];
      var userPrompt = buildUserPrompt(chunk.content, chunk.file_name);

      var llmResponse;
      try {
        llmResponse = await claude.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: MODEL,
              max_tokens: MAX_OUTPUT_TOKENS,
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userPrompt }],
            },
          },
          { response: AnthropicResponse },
          { label: LOG_PREFIX + " extract chunk " + chunk.chunk_index + " doc " + chunk.document_id },
        );
      } catch (llmErr: unknown) {
        var errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        console.log(LOG_PREFIX + " LLM error on chunk " + chunk.chunk_index + ": " + errMsg);
        batchErrors++;
        return {
          stage: STAGE_NAME,
          status: "in_progress",
          message: "LLM error at batch " + batchIdx + " chunk " + chunk.chunk_index + ". Progress saved.",
          stageData: { claimCount: allCandidates.length, batchesProcessed: batchIdx, chunksProcessed: chunksProcessed, batchErrors: batchErrors },
        };
      }

      totalInputTokens += llmResponse.usage.input_tokens;
      totalOutputTokens += llmResponse.usage.output_tokens;

      // Parse response
      var responseText = "";
      for (var ri = 0; ri < llmResponse.content.length; ri++) {
        if (llmResponse.content[ri].type === "text") {
          responseText += llmResponse.content[ri].text;
        }
      }

      var rawClaims: Array<any> = [];
      try {
        var cleaned = responseText.trim();
        if (cleaned.startsWith("```")) {
          var firstNewline = cleaned.indexOf("\n");
          if (firstNewline >= 0) cleaned = cleaned.slice(firstNewline + 1);
          if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, cleaned.length - 3);
          cleaned = cleaned.trim();
        }
        rawClaims = JSON.parse(cleaned);
      } catch (parseErr) {
        console.log(LOG_PREFIX + " JSON parse error on chunk " + chunk.chunk_index + ": " + String(parseErr));
        droppedRows.push({ claim_text: "(unparseable response for chunk " + chunk.chunk_index + ")", reason: "json_parse_error" });
        chunksProcessed++;
        continue;
      }

      if (!Array.isArray(rawClaims)) rawClaims = [];

      // ── Gate and validate each claim ──────────────────────────────
      for (var ci2 = 0; ci2 < rawClaims.length; ci2++) {
        var raw = rawClaims[ci2];
        if (!raw || typeof raw !== "object") continue;

        var claimText = String(raw.claim_text || "").trim();
        var verbatimSnippet = String(raw.verbatim_snippet || "").trim();
        var claimType = String(raw.claim_type || "").trim().toLowerCase();
        var subjectEntity = raw.subject_entity != null ? String(raw.subject_entity).trim() : null;
        var attribution = String(raw.attribution || "").trim().toLowerCase();
        var metricValue = raw.metric_value != null ? String(raw.metric_value).trim() : null;

        if (!claimText || !verbatimSnippet) {
          droppedRows.push({ claim_text: claimText || "(empty)", reason: "missing_required_field" });
          continue;
        }

        // Relevance rejection
        var rejected = false;
        for (var rp = 0; rp < RELEVANCE_REJECT_PATTERNS.length; rp++) {
          if (RELEVANCE_REJECT_PATTERNS[rp].pattern.test(claimText)) {
            rejectedByRelevance.push({ claim_text: claimText, reason: RELEVANCE_REJECT_PATTERNS[rp].reason });
            rejected = true;
            break;
          }
        }
        if (rejected) continue;

        // Whitespace-normalized verbatim gate
        var normalizedSnippet = normalizeWs(verbatimSnippet);
        var normalizedChunk = normalizeWs(chunk.content);
        var matchIdx = normalizedChunk.indexOf(normalizedSnippet);

        if (matchIdx === -1) {
          gateStillFailing++;
          droppedRows.push({ claim_text: claimText, reason: "verbatim_not_found_after_normalization" });
          continue;
        }

        // Recover the original snippet from the source chunk
        var exactSnippetFromSource: string;
        var rawMatchIdx = chunk.content.indexOf(verbatimSnippet);
        if (rawMatchIdx !== -1) {
          exactSnippetFromSource = verbatimSnippet;
        } else {
          gatePassAfterNormalization++;
          var srcChars = chunk.content;
          var normPos = 0;
          var srcStart = -1;
          var srcEnd = -1;
          var inWhitespace = false;
          for (var si = 0; si < srcChars.length && normPos <= matchIdx + normalizedSnippet.length; si++) {
            var ch = srcChars[si];
            var isWs = ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
            if (isWs) {
              if (!inWhitespace) {
                if (normPos === matchIdx && srcStart === -1) srcStart = si;
                normPos++;
              }
              inWhitespace = true;
            } else {
              if (normPos === matchIdx && srcStart === -1) srcStart = si;
              normPos++;
              inWhitespace = false;
            }
            if (normPos === matchIdx + normalizedSnippet.length && srcEnd === -1) {
              srcEnd = si + 1;
            }
          }
          if (srcStart >= 0 && srcEnd > srcStart) {
            exactSnippetFromSource = srcChars.slice(srcStart, srcEnd);
          } else {
            exactSnippetFromSource = verbatimSnippet;
          }
        }

        // Gate: claim_type must be valid
        if (!VALID_CLAIM_TYPES.has(claimType)) {
          droppedRows.push({ claim_text: claimText, reason: "invalid_claim_type: " + claimType });
          continue;
        }

        // Gate: attribution — coerce if invalid
        var subjectUnverified = false;
        if (!VALID_ATTRIBUTIONS.has(attribution)) {
          coercedAttribution++;
          attribution = "deal_team";
        }

        // Gate: subject_entity must appear case-insensitive in chunk
        if (subjectEntity != null && subjectEntity.length > 0) {
          if (chunk.content.toLowerCase().indexOf(subjectEntity.toLowerCase()) === -1) {
            subjectEntity = null;
            subjectUnverified = true;
            subjectUnverifiedCount++;
          }
        } else {
          subjectEntity = null;
          subjectUnverified = true;
          subjectUnverifiedCount++;
        }

        // thesis_dependence from lookup
        var thesisDependence = THESIS_DEPENDENCE[claimType] || "low";
        var locator = chunk.file_name + "::chunk_" + chunk.chunk_index;

        allCandidates.push({
          claim_text: claimText,
          verbatim_snippet: exactSnippetFromSource,
          claim_type: claimType,
          subject_entity: subjectEntity,
          attribution: attribution,
          metric_value: metricValue,
          thesis_dependence: thesisDependence,
          document_id: chunk.document_id,
          chunk_index: chunk.chunk_index,
          locator: locator,
          subject_unverified: subjectUnverified,
          member_count: 1,
          source_locators: [locator],
        });
      }

      chunksProcessed++;
    }
  }

  // ── Deduplication ───────────────────────────────────────────────────
  var duplicatesCollapsedBySnippet = 0;
  var duplicatesCollapsedByText = 0;
  var duplicatesCollapsedByNearText = 0;

  // Pass 1: collapse by normalized verbatim_snippet
  var snippetMap = new Map<string, ClaimCandidate>();
  for (var di = 0; di < allCandidates.length; di++) {
    var cand = allCandidates[di];
    var normSnip = normalizeWs(cand.verbatim_snippet).toLowerCase();
    var existing = snippetMap.get(normSnip);
    if (existing) {
      existing.member_count += cand.member_count;
      for (var sli = 0; sli < cand.source_locators.length; sli++) {
        existing.source_locators.push(cand.source_locators[sli]);
      }
      duplicatesCollapsedBySnippet++;
    } else {
      snippetMap.set(normSnip, cand);
    }
  }
  var afterSnippetDedup = Array.from(snippetMap.values());

  // Pass 2: collapse by exact normalized claim_text (on post-snippet set)
  var textMap = new Map<string, ClaimCandidate>();
  for (var ti = 0; ti < afterSnippetDedup.length; ti++) {
    var cand2 = afterSnippetDedup[ti];
    var normText = normalizeWs(cand2.claim_text).toLowerCase();
    var existing2 = textMap.get(normText);
    if (existing2) {
      existing2.member_count += cand2.member_count;
      for (var sli2 = 0; sli2 < cand2.source_locators.length; sli2++) {
        existing2.source_locators.push(cand2.source_locators[sli2]);
      }
      duplicatesCollapsedByText++;
    } else {
      textMap.set(normText, cand2);
    }
  }
  var afterTextDedup = Array.from(textMap.values());

  // ══ CHANGE 4 (2C): Pass 3 — near-duplicate collapse by token-set overlap ══
  // For claims sharing same claim_type AND same subject_entity, collapse
  // pairs whose normalized claim_text overlap exceeds NEAR_DEDUP_THRESHOLD.
  var nearDedupResult: ClaimCandidate[] = [];
  var consumed = new Set<number>();

  for (var ni = 0; ni < afterTextDedup.length; ni++) {
    if (consumed.has(ni)) continue;
    var survivor = afterTextDedup[ni];
    var survivorNorm = normalizeWs(survivor.claim_text);

    for (var nj = ni + 1; nj < afterTextDedup.length; nj++) {
      if (consumed.has(nj)) continue;
      var candidate = afterTextDedup[nj];

      // Must share claim_type and subject_entity
      if (candidate.claim_type !== survivor.claim_type) continue;
      var sameEntity = (survivor.subject_entity || "") === (candidate.subject_entity || "");
      if (!sameEntity) continue;

      var candidateNorm = normalizeWs(candidate.claim_text);
      var overlap = tokenSetOverlap(survivorNorm, candidateNorm);
      if (overlap >= NEAR_DEDUP_THRESHOLD) {
        survivor.member_count += candidate.member_count;
        for (var slk = 0; slk < candidate.source_locators.length; slk++) {
          survivor.source_locators.push(candidate.source_locators[slk]);
        }
        consumed.add(nj);
        duplicatesCollapsedByNearText++;
      }
    }

    nearDedupResult.push(survivor);
  }
  var dedupedCandidates = nearDedupResult;

  // ══ CHANGE 3 (2C): Insert + marker in a single transaction ══════════
  var claimTypeDistribution: Record<string, number> = {};
  var attributionDistribution: Record<string, number> = {};
  var sampleClaims: Array<Record<string, unknown>> = [];
  var totalClaimsInserted = 0;

  if (dedupedCandidates.length === 0) {
    return {
      stage: STAGE_NAME,
      status: "failed",
      message: "Zero claims survived gates and deduplication. Register is empty.",
      stageData: {
        claimCount: 0,
        chunksProcessed: chunksProcessed,
        batchesProcessed: batches.length,
        droppedRows: droppedRows,
        rejectedByRelevance: rejectedByRelevance,
        gatePassAfterNormalization: gatePassAfterNormalization,
        gateStillFailing: gateStillFailing,
        duplicatesCollapsedBySnippet: duplicatesCollapsedBySnippet,
        duplicatesCollapsedByText: duplicatesCollapsedByText,
        duplicatesCollapsedByNearText: duplicatesCollapsedByNearText,
        nearDedupThreshold: NEAR_DEDUP_THRESHOLD,
        totalInputTokens: totalInputTokens,
        totalOutputTokens: totalOutputTokens,
      },
    };
  }

  // BEGIN transaction
  await db.execute("BEGIN", [], { label: LOG_PREFIX + " BEGIN insert+marker transaction" });

  try {
    for (var ii = 0; ii < dedupedCandidates.length; ii++) {
      var c = dedupedCandidates[ii];
      await db.execute(
        "INSERT INTO sri_claims (claim_id, run_id, claim_text, verbatim_snippet, claim_type, metric_value, thesis_dependence, document_id, chunk_index, locator, subject_entity, attribution, subject_unverified, member_count, source_locators, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], now())",
        [
          runId,
          c.claim_text,
          c.verbatim_snippet,
          c.claim_type,
          c.metric_value,
          c.thesis_dependence,
          c.document_id,
          c.chunk_index,
          c.locator,
          c.subject_entity,
          c.attribution,
          c.subject_unverified,
          c.member_count,
          "{" + c.source_locators.map(function (s) { return "\"" + s.replace(/"/g, "\\\"") + "\""; }).join(",") + "}",
        ],
        { label: LOG_PREFIX + " insert claim " + (ii + 1) },
      );

      totalClaimsInserted++;
      claimTypeDistribution[c.claim_type] = (claimTypeDistribution[c.claim_type] || 0) + 1;
      attributionDistribution[c.attribution] = (attributionDistribution[c.attribution] || 0) + 1;

      if (sampleClaims.length < 10) {
        sampleClaims.push({
          claim_text: c.claim_text,
          verbatim_snippet: c.verbatim_snippet,
          claim_type: c.claim_type,
          subject_entity: c.subject_entity,
          attribution: c.attribution,
          metric_value: c.metric_value,
          thesis_dependence: c.thesis_dependence,
          document_id: c.document_id,
          chunk_index: c.chunk_index,
          locator: c.locator,
          subject_unverified: c.subject_unverified,
          member_count: c.member_count,
          source_locators: c.source_locators,
        });
      }
    }

    // Completion marker — inside the same transaction
    await db.execute(
      "UPDATE sri_pipeline_state SET stages_completed = array_append(stages_completed, $2), updated_at = now() WHERE run_id = $1 AND NOT ($2 = ANY(stages_completed))",
      [runId, STAGE_NAME],
      { label: LOG_PREFIX + " mark stage complete (in transaction)" },
    );

    // COMMIT
    await db.execute("COMMIT", [], { label: LOG_PREFIX + " COMMIT insert+marker transaction" });
  } catch (txErr) {
    try { await db.execute("ROLLBACK", [], { label: LOG_PREFIX + " ROLLBACK on error" }); } catch (rbErr) { /* best effort */ }
    throw txErr;
  }

  var stageData = {
    claimCount: totalClaimsInserted,
    claimTypeDistribution: claimTypeDistribution,
    attributionDistribution: attributionDistribution,
    subjectUnverifiedCount: subjectUnverifiedCount,
    coercedAttribution: coercedAttribution,
    droppedRows: droppedRows,
    rejectedByRelevance: rejectedByRelevance,
    gatePassAfterNormalization: gatePassAfterNormalization,
    gateStillFailing: gateStillFailing,
    duplicatesCollapsedBySnippet: duplicatesCollapsedBySnippet,
    duplicatesCollapsedByText: duplicatesCollapsedByText,
    duplicatesCollapsedByNearText: duplicatesCollapsedByNearText,
    nearDedupThreshold: NEAR_DEDUP_THRESHOLD,
    batchesProcessed: batches.length,
    chunksProcessed: chunksProcessed,
    sampleClaims: sampleClaims,
    totalInputTokens: totalInputTokens,
    totalOutputTokens: totalOutputTokens,
  };

  return {
    stage: STAGE_NAME,
    status: "complete",
    message: totalClaimsInserted + " claims extracted from " + chunksProcessed + " chunks across " + batches.length + " batches.",
    stageData: stageData,
  };
}

export { buildClaimRegister };
