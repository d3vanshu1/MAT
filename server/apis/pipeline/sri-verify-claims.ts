/**
 * sri-verify-claims.ts
 *
 * Stage 2 of 3 — verify_claims
 *
 * For each claim in sri_claims, search a fixed set of public platforms
 * determined by claim_type, retain real URLs from web_search_result
 * blocks, and write a verdict to sri_findings.
 *
 * Anti-fabrication: URLs come from server-authoritative web_search_result
 * blocks only. Snippets from citations cited_text. Never accept a URL
 * the model typed into prose. Reject any evidence row whose URL does not
 * yield a non-empty host.
 */

import { z } from "@superblocksteam/sdk-api";
import type { StageHandler, StageResult } from "./sri-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
var STAGE_NAME = "verify_claims";
var LOG_PREFIX = "[SRI verify_claims]";
var SEARCH_MODEL = "claude-sonnet-4-6";
var SEARCH_MAX_TOKENS = 4096;
var WEB_SEARCH_MAX_USES = 3;

// ── Platform routing (code-side, no model involvement) ──────────────
var PLATFORM_ROUTING: Record<string, string[]> = {
  culture: ["glassdoor", "indeed", "linkedin"],
  retention_attrition: ["glassdoor", "indeed", "linkedin"],
  headcount: ["glassdoor", "indeed", "linkedin"],
  employer_reputation: ["glassdoor", "indeed", "linkedin"],
  nps_csat: ["trustpilot", "g2"],
  customer_satisfaction: ["trustpilot", "g2"],
  brand_reputation: ["news"],
  award: ["news"],
};

// ── Severity assignment (code-side, never model-asserted) ───────────
function assignSeverity(verdict: string, thesisDependence: string, evidenceCount: number): string {
  if (verdict === "contradicted" && thesisDependence === "high" && evidenceCount >= 2) return "critical";
  if (verdict === "contradicted" && thesisDependence === "high" && evidenceCount === 1) return "warning";
  if (verdict === "contradicted" && thesisDependence === "medium") return "warning";
  return "info";
}

// ── extractHost equivalent (inline implementation) ─────────────────
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

// ── Web search response schema (loose, for web_search tool-use) ────
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

// ── Evidence extraction from web search response ────────────────────
interface EvidenceItem {
  url: string;
  domain: string;
  snippet: string;
}

function extractEvidenceFromSearchResponse(
  response: z.infer<typeof WebSearchResponseSchema>,
): { items: EvidenceItem[]; urlsRejectedNoHost: number } {
  var items: EvidenceItem[] = [];
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
    if (!host) {
      urlsRejectedNoHost++;
      return;
    }

    var citation = citationsByUrl.get(url);
    var snippet = citation || raw.title || "(no snippet available)";

    items.push({ url: url, domain: host, snippet: snippet.slice(0, 2000) });
  });

  // Phase 4: Citations for URLs not in rawResults (server-mediated)
  citationsByUrl.forEach(function (citedText, url) {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    var host = extractHost(url);
    if (!host) {
      urlsRejectedNoHost++;
      return;
    }

    items.push({ url: url, domain: host, snippet: citedText.slice(0, 2000) });
  });

  return { items: items, urlsRejectedNoHost: urlsRejectedNoHost };
}

// ── Stage handler ───────────────────────────────────────────────────
var verifyClaims: StageHandler = async function (
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;
  var claude = ctx.integrations.claude;

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
    // ── Inline ALTER for resume cursor ──────────────────────────────
    await db.execute(
      "ALTER TABLE sri_pipeline_state ADD COLUMN IF NOT EXISTS verify_claim_cursor INT NOT NULL DEFAULT 0",
      [],
      { label: LOG_PREFIX + " ensure verify_claim_cursor column" },
    );

    // ── Get deal name for subject fallback ──────────────────────────
    var dealRows = await db.query(
      "SELECT name FROM deals WHERE id = $1 LIMIT 1",
      z.object({ name: z.string() }),
      [dealId],
      { label: LOG_PREFIX + " get deal name" },
    );
    var dealName = dealRows.length > 0 ? dealRows[0].name : "Unknown";

    // ── Stage-start diagnostics (committed immediately, outside transaction) ──
    try {
      await db.execute(
        "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb)",
        [runId, "verify_claims_start", JSON.stringify({
          claimsToProcess: 0, // will be updated below
          platformRouting: PLATFORM_ROUTING,
          timestamp: new Date().toISOString(),
          dealName: dealName,
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

    // Update start diagnostics with actual claim count
    try {
      await db.execute(
        "UPDATE sri_stage_diagnostics SET payload = jsonb_set(payload, '{claimsToProcess}', $2::text::jsonb) WHERE run_id = $1 AND stage = 'verify_claims_start' AND payload->>'claimsToProcess' = '0'",
        [runId, String(claims.length)],
        { label: LOG_PREFIX + " update start diagnostics claim count" },
      );
    } catch (e) { /* best effort */ }

    // ── Counters ────────────────────────────────────────────────────
    var claimsProcessed = 0;
    var pairsAttempted = 0;
    var pairsWithEvidence = 0;
    var pairsNoEvidence = 0;
    var evidenceRowsWritten = 0;
    var urlsRejectedNoHost = 0;
    var subjectFallbackCount = 0;
    var verdictDistribution: Record<string, number> = {};
    var severityDistribution: Record<string, number> = {};
    var perPlatformCounts: Record<string, { attempted: number; withEvidence: number }> = {};
    var sampleFindings: any[] = [];

    // ── Process claims sequentially ─────────────────────────────────
    for (var idx = 0; idx < claims.length; idx++) {
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
        // not_searched verdict
        await db.execute(
          "INSERT INTO sri_findings (finding_id, run_id, claim_id, verdict, severity, title, detail, created_at) VALUES (gen_random_uuid(), $1, $2, 'not_searched', 'info', $3, $4, now())",
          [runId, claim.claim_id, "No platform routing for " + claim.claim_type, "Claim type has no configured search platforms."],
          { label: LOG_PREFIX + " insert not_searched finding" },
        );
        claimsProcessed++;
        verdictDistribution["not_searched"] = (verdictDistribution["not_searched"] || 0) + 1;
        severityDistribution["info"] = (severityDistribution["info"] || 0) + 1;
        continue;
      }

      // ── Search subject ────────────────────────────────────────────
      var searchSubject = claim.subject_entity;
      var usedFallback = false;
      if (!searchSubject) {
        searchSubject = dealName;
        usedFallback = true;
        subjectFallbackCount++;
      }

      // ── Search each platform ──────────────────────────────────────
      var claimEvidenceCount = 0;
      var claimHasContradiction = false;
      var claimEvidenceUrls: string[] = [];

      for (var pi = 0; pi < platforms.length; pi++) {
        var platform = platforms[pi];
        pairsAttempted++;

        if (!perPlatformCounts[platform]) {
          perPlatformCounts[platform] = { attempted: 0, withEvidence: 0 };
        }
        perPlatformCounts[platform].attempted++;

        // ── Build search prompt ─────────────────────────────────────
        var platformLabel = platform;
        if (platform === "glassdoor") platformLabel = "Glassdoor";
        else if (platform === "indeed") platformLabel = "Indeed";
        else if (platform === "linkedin") platformLabel = "LinkedIn";
        else if (platform === "trustpilot") platformLabel = "Trustpilot";
        else if (platform === "g2") platformLabel = "G2";
        else if (platform === "news") platformLabel = "news articles and press coverage";

        var searchPrompt = "Search " + platformLabel + " for information about " + searchSubject + " related to this claim: \"" + claim.claim_text + "\"\n\nReturn what you find. Focus on whether the evidence supports or contradicts the claim. If you find nothing relevant, say so explicitly.";

        try {
          var searchResponse = await claude.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model: SEARCH_MODEL,
                max_tokens: SEARCH_MAX_TOKENS,
                messages: [{ role: "user", content: searchPrompt }],
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
            { label: LOG_PREFIX + " search " + platform + " for claim " + (idx + 1) },
          );

          // ── Extract evidence ──────────────────────────────────────
          var extracted = extractEvidenceFromSearchResponse(searchResponse);
          urlsRejectedNoHost += extracted.urlsRejectedNoHost;

          if (extracted.items.length > 0) {
            pairsWithEvidence++;
            perPlatformCounts[platform].withEvidence++;

            for (var ei = 0; ei < extracted.items.length; ei++) {
              var ev = extracted.items[ei];
              await db.execute(
                "INSERT INTO sri_evidence (evidence_id, claim_id, platform, url, domain, snippet, retrieved_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now()) ON CONFLICT (claim_id, url) DO NOTHING",
                [claim.claim_id, platform, ev.url, ev.domain, ev.snippet],
                { label: LOG_PREFIX + " insert evidence" },
              );
              evidenceRowsWritten++;
              claimEvidenceCount++;
              claimEvidenceUrls.push(ev.url);
            }

            // ── Check model text for contradiction signal ───────────
            var modelText = "";
            for (var ti = 0; ti < searchResponse.content.length; ti++) {
              if (searchResponse.content[ti].type === "text" && searchResponse.content[ti].text) {
                modelText += " " + searchResponse.content[ti].text;
              }
            }
            var contradictionSignals = /\bcontradict|disputes?|refutes?|denies?|negative\s+review|poor\s+rating|complaints?\b/i;
            if (contradictionSignals.test(modelText)) {
              claimHasContradiction = true;
            }
          } else {
            pairsNoEvidence++;
          }
        } catch (searchErr) {
          console.log(LOG_PREFIX + " Search error for claim " + (idx + 1) + " platform " + platform + ": " + String(searchErr));
          pairsNoEvidence++;
        }
      }

      // ── Determine verdict ─────────────────────────────────────────
      var verdict: string;
      if (claimEvidenceCount === 0) {
        verdict = "unverifiable";
      } else if (claimHasContradiction) {
        verdict = "contradicted";
      } else {
        verdict = "corroborated";
      }

      var severity = assignSeverity(verdict, claim.thesis_dependence, claimEvidenceCount);

      verdictDistribution[verdict] = (verdictDistribution[verdict] || 0) + 1;
      severityDistribution[severity] = (severityDistribution[severity] || 0) + 1;

      // ── Write finding ─────────────────────────────────────────────
      var findingTitle = verdict === "unverifiable"
        ? "No public evidence found for claim"
        : verdict === "contradicted"
          ? "Public evidence may contradict claim"
          : "Public evidence corroborates claim";
      var findingDetail = "Claim: " + claim.claim_text + "\nVerdict: " + verdict + " | Severity: " + severity + " | Evidence URLs: " + claimEvidenceCount;

      await db.execute(
        "INSERT INTO sri_findings (finding_id, run_id, claim_id, verdict, severity, title, detail, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now())",
        [runId, claim.claim_id, verdict, severity, findingTitle, findingDetail],
        { label: LOG_PREFIX + " insert finding for claim " + (idx + 1) },
      );

      // ── Update cursor ─────────────────────────────────────────────
      await db.execute(
        "UPDATE sri_pipeline_state SET verify_claim_cursor = $2, updated_at = now() WHERE run_id = $1",
        [runId, idx + 1],
        { label: LOG_PREFIX + " update cursor to " + (idx + 1) },
      );

      claimsProcessed++;

      // ── Collect sample findings ───────────────────────────────────
      if (sampleFindings.length < 10) {
        sampleFindings.push({
          claim_text: claim.claim_text,
          claim_type: claim.claim_type,
          subject_entity: claim.subject_entity || dealName,
          subject_fallback: usedFallback,
          thesis_dependence: claim.thesis_dependence,
          verdict: verdict,
          severity: severity,
          evidence_urls: claimEvidenceUrls,
          evidence_count: claimEvidenceCount,
        });
      }
    }

    // ── Completion: diagnostics + marker in transaction ──────────────
    var stageData: Record<string, unknown> = {
      claimsProcessed: claimsProcessed,
      pairsAttempted: pairsAttempted,
      pairsWithEvidence: pairsWithEvidence,
      pairsNoEvidence: pairsNoEvidence,
      evidenceRowsWritten: evidenceRowsWritten,
      urlsRejectedNoHost: urlsRejectedNoHost,
      subjectFallbackCount: subjectFallbackCount,
      verdictDistribution: verdictDistribution,
      severityDistribution: severityDistribution,
      perPlatformCounts: perPlatformCounts,
      sampleFindings: sampleFindings,
    };

    await db.execute("BEGIN", [], { label: LOG_PREFIX + " BEGIN completion transaction" });
    try {
      // Persist diagnostics
      try {
        await db.execute(
          "INSERT INTO sri_stage_diagnostics (run_id, stage, payload) VALUES ($1, $2, $3::jsonb)",
          [runId, STAGE_NAME, JSON.stringify(stageData)],
          { label: LOG_PREFIX + " persist completion diagnostics" },
        );
      } catch (diagErr) {
        console.log(LOG_PREFIX + " Failed to persist diagnostics (non-fatal): " + String(diagErr));
      }

      // Completion marker
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
    // ── Always release advisory lock ────────────────────────────────
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
