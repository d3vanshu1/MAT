/**
 * sri-claim-register.ts
 *
 * SRI v2 — Stage 1: Build Claim Register
 *
 * Reads IC memo chunks only (not CIM, consultant, legal, or financial_model).
 * Extracts reputation claims the deal team asserts. Each claim carries its
 * own subject entity. No search, no ranking, no entity extraction.
 *
 * Resumable via claim_batch_cursor on sri_pipeline_state.
 * Inserts surviving rows into sri_claims. No writes to sri_evidence or sri_findings.
 */

import type { StageHandler, StageResult } from "./sri-stage-contract.js";
import { z } from "@superblocksteam/sdk-api";

var LOG_PREFIX = "[SRI-CLAIM-REGISTER]";
var MAX_OUTPUT_TOKENS = 4096;
var BATCH_SIZE = 12;
var STAGE_NAME = "build_claim_register";
var MODEL = "claude-sonnet-4-6";

// ── Valid enum sets ─────────────────────────────────────────────────────
var VALID_CLAIM_TYPES = new Set([
  "culture",
  "retention_attrition",
  "headcount",
  "nps_csat",
  "customer_satisfaction",
  "management_quality",
  "brand_position",
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
  management_quality: "high",
  culture: "medium",
  nps_csat: "medium",
  customer_satisfaction: "medium",
  headcount: "low",
  brand_position: "low",
  award: "low",
};

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

// ── Extraction prompt ───────────────────────────────────────────────────
var SYSTEM_PROMPT =
  "You are an investment diligence analyst specializing in social and reputation intelligence. Extract reputation claims from deal team memos exactly as instructed. Return only valid JSON.";

function buildUserPrompt(chunkContent: string, fileName: string): string {
  return "Below is a section of an investment committee memo (file: " + fileName + "). Extract every reputation-related claim the deal team asserts.\n\nLook for assertions about:\n- Company culture (values, environment, employee satisfaction)\n- Employee retention or attrition rates\n- Headcount growth or plans\n- NPS, CSAT, or customer satisfaction scores\n- Management quality or leadership strength\n- Brand positioning or reputation\n- Awards or recognitions received\n\nDO NOT extract:\n- Historical financial results\n- Descriptions of products or services\n- Forward-looking financial projections (revenue, EBITDA)\n- Legal or regulatory statements\n- Generic deal terms\n\nFor each claim, provide:\n- claim_text: the assertion normalized to one clear sentence\n- verbatim_snippet: the exact passage from the text containing the claim (must be a character-for-character substring of the chunk text)\n- claim_type: exactly one of: culture, retention_attrition, headcount, nps_csat, customer_satisfaction, management_quality, brand_position, award\n- subject_entity: the company or brand the claim is about, exactly as written in the memo\n- attribution: who the memo credits for the claim, exactly one of: deal_team, management, cim, third_party\n- metric_value: the specific figure if stated (e.g. \"92%\", \"4.5/5\"), otherwise null\n\nReturn a JSON array only. No prose. No markdown fences. If no reputation claims are found, return an empty array [].\n\nExample format:\n[{\"claim_text\":\"Employee retention rate exceeds 95% annually\",\"verbatim_snippet\":\"the company maintains a retention rate exceeding 95% annually\",\"claim_type\":\"retention_attrition\",\"subject_entity\":\"SCG\",\"attribution\":\"management\",\"metric_value\":\"95%\"}]\n\n--- CHUNK TEXT ---\n" + chunkContent + "\n--- END CHUNK TEXT ---";
}

// ── Stage handler ───────────────────────────────────────────────────────
var buildClaimRegister: StageHandler = async function (
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;
  var claude = ctx.integrations.claude;

  // ── Completion guard: already done? ─────────────────────────────────
  var completedRows = await db.query(
    "SELECT stages_completed FROM sri_pipeline_state WHERE run_id = $1 LIMIT 1",
    StagesCompletedRow,
    [runId],
    { label: LOG_PREFIX + " check stages_completed" },
  );

  if (completedRows.length > 0) {
    var completed = completedRows[0].stages_completed;
    for (var ci = 0; ci < completed.length; ci++) {
      if (completed[ci] === STAGE_NAME) {
        // Already complete — return without re-extracting
        var existingCountRows = await db.query(
          "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
          z.object({ cnt: z.coerce.number() }),
          [runId],
          { label: LOG_PREFIX + " existing claim count" },
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

  // ── Ensure claim_batch_cursor column exists ─────────────────────────
  await db.execute(
    "ALTER TABLE sri_pipeline_state ADD COLUMN IF NOT EXISTS claim_batch_cursor int DEFAULT 0",
    [],
    { label: LOG_PREFIX + " ensure claim_batch_cursor column" },
  );

  // ── Ensure sri_claims has subject_entity, attribution, subject_unverified columns ──
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

  // ── Delete existing claims for this run (re-extraction on resume from scratch) ──
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
    // Starting fresh — clear any partial claims from a prior failed attempt
    await db.execute(
      "DELETE FROM sri_claims WHERE run_id = $1",
      [runId],
      { label: LOG_PREFIX + " clear prior claims for fresh start" },
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
  var totalClaimsInserted = 0;
  var chunksProcessed = 0;
  var droppedRows: Array<{ claim_text: string; reason: string }> = [];
  var coercedAttribution = 0;
  var subjectUnverifiedCount = 0;
  var claimTypeDistribution: Record<string, number> = {};
  var attributionDistribution: Record<string, number> = {};
  var sampleClaims: Array<Record<string, unknown>> = [];
  var totalInputTokens = 0;
  var totalOutputTokens = 0;
  var batchErrors = 0;

  // ── Process batches starting from cursor ────────────────────────────
  for (var batchIdx = batchCursor; batchIdx < batches.length; batchIdx++) {
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
        // Save progress and return in_progress
        await db.execute(
          "UPDATE sri_pipeline_state SET claim_batch_cursor = $2, updated_at = now() WHERE run_id = $1",
          [runId, batchIdx],
          { label: LOG_PREFIX + " save cursor on LLM error" },
        );
        return {
          stage: STAGE_NAME,
          status: "in_progress",
          message: "LLM error at batch " + batchIdx + " chunk " + chunk.chunk_index + ". Progress saved.",
          stageData: {
            claimCount: totalClaimsInserted,
            batchesProcessed: batchIdx,
            chunksProcessed: chunksProcessed,
            batchErrors: batchErrors,
          },
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
        // Strip markdown fences if present
        var cleaned = responseText.trim();
        if (cleaned.startsWith("```")) {
          var firstNewline = cleaned.indexOf("\n");
          if (firstNewline >= 0) {
            cleaned = cleaned.slice(firstNewline + 1);
          }
          if (cleaned.endsWith("```")) {
            cleaned = cleaned.slice(0, cleaned.length - 3);
          }
          cleaned = cleaned.trim();
        }
        rawClaims = JSON.parse(cleaned);
      } catch (parseErr) {
        console.log(LOG_PREFIX + " JSON parse error on chunk " + chunk.chunk_index + ": " + String(parseErr));
        droppedRows.push({
          claim_text: "(unparseable response for chunk " + chunk.chunk_index + ")",
          reason: "json_parse_error",
        });
        chunksProcessed++;
        continue;
      }

      if (!Array.isArray(rawClaims)) {
        rawClaims = [];
      }

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

        // Gate 1: verbatim_snippet must be exact case-sensitive substring of chunk
        if (chunk.content.indexOf(verbatimSnippet) === -1) {
          droppedRows.push({ claim_text: claimText, reason: "verbatim_not_found_in_chunk" });
          continue;
        }

        // Gate 2: claim_type must be valid
        if (!VALID_CLAIM_TYPES.has(claimType)) {
          droppedRows.push({ claim_text: claimText, reason: "invalid_claim_type: " + claimType });
          continue;
        }

        // Gate 3: attribution — coerce if invalid
        var subjectUnverified = false;
        if (!VALID_ATTRIBUTIONS.has(attribution)) {
          coercedAttribution++;
          attribution = "deal_team";
        }

        // Gate 4: subject_entity must appear case-insensitive in chunk
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

        // Gate 5: thesis_dependence from lookup, not model
        var thesisDependence = THESIS_DEPENDENCE[claimType] || "low";

        // ── Build locator ───────────────────────────────────────────
        var locator = chunk.file_name + "::chunk_" + chunk.chunk_index;

        // ── INSERT ──────────────────────────────────────────────────
        await db.execute(
          "INSERT INTO sri_claims (claim_id, run_id, claim_text, verbatim_snippet, claim_type, metric_value, thesis_dependence, document_id, chunk_index, locator, subject_entity, attribution, subject_unverified, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())",
          [
            runId,
            claimText,
            verbatimSnippet,
            claimType,
            metricValue,
            thesisDependence,
            chunk.document_id,
            chunk.chunk_index,
            locator,
            subjectEntity,
            attribution,
            subjectUnverified,
          ],
          { label: LOG_PREFIX + " insert claim" },
        );

        totalClaimsInserted++;

        // Track distributions
        claimTypeDistribution[claimType] = (claimTypeDistribution[claimType] || 0) + 1;
        attributionDistribution[attribution] = (attributionDistribution[attribution] || 0) + 1;

        // Collect samples
        if (sampleClaims.length < 10) {
          sampleClaims.push({
            claim_text: claimText,
            verbatim_snippet: verbatimSnippet,
            claim_type: claimType,
            subject_entity: subjectEntity,
            attribution: attribution,
            metric_value: metricValue,
            thesis_dependence: thesisDependence,
            document_id: chunk.document_id,
            chunk_index: chunk.chunk_index,
            locator: locator,
            subject_unverified: subjectUnverified,
          });
        }
      }

      chunksProcessed++;
    }

    // ── Persist cursor after each batch ─────────────────────────────
    await db.execute(
      "UPDATE sri_pipeline_state SET claim_batch_cursor = $2, updated_at = now() WHERE run_id = $1",
      [runId, batchIdx + 1],
      { label: LOG_PREFIX + " advance cursor to " + (batchIdx + 1) },
    );
  }

  // ── Final result ──────────────────────────────────────────────────
  // When resuming at cursor = total batches, no new claims are inserted
  // this invocation. Check DB for existing claims before declaring failure.
  if (totalClaimsInserted === 0) {
    var existingRows = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: LOG_PREFIX + " check existing claims after zero-insert loop" },
    );
    var existingTotal = existingRows.length > 0 ? existingRows[0].cnt : 0;
    if (existingTotal === 0) {
      return {
        stage: STAGE_NAME,
        status: "failed",
        message: "Zero claims survived gates. Register is empty.",
        stageData: {
          claimCount: 0,
          chunksProcessed: chunksProcessed,
          batchesProcessed: batches.length,
          droppedRows: droppedRows,
          totalInputTokens: totalInputTokens,
          totalOutputTokens: totalOutputTokens,
        },
      };
    }
    // Claims exist from prior batches — treat as complete
    totalClaimsInserted = existingTotal;
  }

  // ── Write completion marker (idempotent — skip if already present) ──
  await db.execute(
    "UPDATE sri_pipeline_state SET stages_completed = array_append(stages_completed, $2), updated_at = now() WHERE run_id = $1 AND NOT ($2 = ANY(stages_completed))",
    [runId, STAGE_NAME],
    { label: LOG_PREFIX + " mark stage complete (idempotent)" },
  );

  return {
    stage: STAGE_NAME,
    status: "complete",
    message: totalClaimsInserted + " claims extracted from " + chunksProcessed + " chunks across " + batches.length + " batches.",
    stageData: {
      claimCount: totalClaimsInserted,
      claimTypeDistribution: claimTypeDistribution,
      attributionDistribution: attributionDistribution,
      subjectUnverifiedCount: subjectUnverifiedCount,
      coercedAttribution: coercedAttribution,
      droppedRows: droppedRows,
      batchesProcessed: batches.length,
      chunksProcessed: chunksProcessed,
      sampleClaims: sampleClaims,
      totalInputTokens: totalInputTokens,
      totalOutputTokens: totalOutputTokens,
    },
  };
};

export { buildClaimRegister };
