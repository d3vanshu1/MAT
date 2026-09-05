/**
 * sri-target-profile.ts
 *
 * Builds a structured profile of the deal target from CIM and IC memos.
 * Each profile field carries a verbatim snippet gated as an exact substring
 * of a retrieved chunk (whitespace-normalised). Failed gates drop the field.
 *
 * Persists profile fields, trading names, and web domains into
 * sri_target_identity with identity_type = profile_field | trading_name | web_domain.
 *
 * No deal name, company name, sector, or country appears in code.
 */

import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ────────────────────────────────────────────────────
const PROFILE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;
const MAX_CHUNKS = 40;
const LOG_PREFIX = "[SRI target_profile]";

// ── Whitespace normalisation ─────────────────────────────────────
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Schemas ──────────────────────────────────────────────────────
const ChunkRow = z.object({
  chunk_id: z.string(),
  content: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
  document_id: z.string(),
});

const IdentityCountRow = z.object({ cnt: z.coerce.number() });

const MessageResponseSchema = z.object({
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

// ── Profile field contract ───────────────────────────────────────
interface ProfileField {
  field: string;
  value: string;
  snippet: string;
  source_file: string;
  gated: boolean;
}

interface ExtractedProfile {
  fields: ProfileField[];
  trading_names: Array<{ name: string; snippet: string; source_file: string; gated: boolean }>;
  web_domains: Array<{ domain: string; snippet: string; source_file: string; gated: boolean }>;
}

// ── Input / Output schemas ───────────────────────────────────────
const InputSchema = z.object({
  dealId: z.string().uuid(),
});

const OutputSchema = z.object({
  runId: z.string(),
  profile: z.any(),
  persisted: z.number(),
  dropped: z.number(),
  chunksUsed: z.number(),
});

// ── Prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = "You are a due diligence analyst building a structured profile of the target company from investment documents. You must extract factual attributes with exact verbatim snippets from the source text.\n\nReturn ONLY a JSON object with this structure:\n{\n  \"fields\": [\n    { \"field\": \"products_services\", \"value\": \"<what the company sells or provides>\", \"snippet\": \"<exact verbatim span from source text>\" },\n    { \"field\": \"sector\", \"value\": \"<industry or sector>\", \"snippet\": \"<exact verbatim span>\" },\n    { \"field\": \"geography\", \"value\": \"<primary operating geography>\", \"snippet\": \"<exact verbatim span>\" },\n    { \"field\": \"customer_type\", \"value\": \"<type of customers>\", \"snippet\": \"<exact verbatim span>\" },\n    { \"field\": \"approximate_size\", \"value\": \"<revenue, employees, or other size indicator>\", \"snippet\": \"<exact verbatim span>\" }\n  ],\n  \"trading_names\": [\n    { \"name\": \"<trading name or brand>\", \"snippet\": \"<exact verbatim span>\" }\n  ],\n  \"web_domains\": [\n    { \"domain\": \"<website domain>\", \"snippet\": \"<exact verbatim span>\" }\n  ]\n}\n\nRules:\n- Every snippet MUST be an exact substring of the source text provided. Do not paraphrase.\n- Include only fields you can support with a verbatim snippet.\n- If you cannot find evidence for a field, omit it entirely.\n- trading_names: include the primary company name and any subsidiaries, brands, or trading names mentioned.\n- web_domains: include any website domains mentioned in the text.\n- Do not invent or guess values. Only state what appears in the text.\n- Return valid JSON only, no surrounding text.";

export default api({
  name: "SriBuildTargetProfile",
  description: "Builds target company profile from CIM and IC memos for entity matching.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },
  input: InputSchema,
  output: OutputSchema,

  async run(ctx, input) {
    var db = ctx.integrations.db;
    var claude = ctx.integrations.claude;
    var dealId = input.dealId;

    // ── Find the active SRI run ─────────────────────────────────
    var runRows = await db.query(
      "SELECT run_id FROM sri_pipeline_state WHERE run_id IN (SELECT run_id FROM sri_pipeline_state ORDER BY updated_at DESC LIMIT 5) LIMIT 1",
      z.object({ run_id: z.string() }),
      [],
      { label: LOG_PREFIX + " find active run" },
    );
    if (runRows.length === 0) {
      throw new Error("No SRI pipeline run found. Run SriRunPipeline first.");
    }
    var runId = runRows[0].run_id;

    // ── Check if profile already exists for this run ────────────
    var existingCount = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_target_identity WHERE run_id = $1 AND identity_type = 'profile_field'",
      IdentityCountRow,
      [runId],
      { label: LOG_PREFIX + " check existing profile" },
    );
    if (existingCount.length > 0 && existingCount[0].cnt > 0) {
      // Return existing profile
      var existingRows = await db.query(
        "SELECT identity_type, identity_value, verbatim_snippet, confidence, source_document_id FROM sri_target_identity WHERE run_id = $1 AND identity_type IN ('profile_field', 'trading_name', 'web_domain') ORDER BY identity_type, identity_value",
        z.object({
          identity_type: z.string(),
          identity_value: z.string(),
          verbatim_snippet: z.string().nullable(),
          confidence: z.string().nullable(),
          source_document_id: z.string().nullable(),
        }),
        [runId],
        { label: LOG_PREFIX + " load existing profile" },
      );
      return {
        runId: runId,
        profile: { existing: true, rows: existingRows },
        persisted: existingRows.length,
        dropped: 0,
        chunksUsed: 0,
      };
    }

    // ── Load chunks from CIM and IC memo ────────────────────────
    var chunks = await db.query(
      "SELECT dc.id AS chunk_id, dc.content, dc.file_name, d.document_tag, dc.document_id FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE dc.deal_id = $1 AND d.document_tag IN ('cim', 'ic_memo') ORDER BY d.document_tag, dc.chunk_index LIMIT " + String(MAX_CHUNKS),
      ChunkRow,
      [dealId],
      { label: LOG_PREFIX + " load CIM and IC memo chunks" },
    );

    if (chunks.length === 0) {
      throw new Error("No CIM or IC memo chunks found for deal " + dealId);
    }

    // ── Build source text with chunk boundaries ─────────────────
    var sourceText = "";
    var chunkSources: Array<{ file_name: string; document_id: string; start: number; end: number }> = [];
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      var marker = "--- CHUNK " + (ci + 1) + " (from: " + chunk.file_name + ") ---\n";
      var startPos = sourceText.length + marker.length;
      sourceText += marker + chunk.content + "\n\n";
      chunkSources.push({
        file_name: chunk.file_name,
        document_id: chunk.document_id,
        start: startPos,
        end: sourceText.length,
      });
    }

    // ── Concatenate chunk content for gate checking ─────────────
    var allContent = chunks.map(function (c) { return c.content; }).join(" ");
    var normalizedAllContent = normalizeWs(allContent);

    // ── LLM call ────────────────────────────────────────────────
    var response = await claude.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: PROFILE_MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: "Extract a structured profile from these investment documents:\n\n" + sourceText }],
        },
      },
      { response: MessageResponseSchema },
      { label: LOG_PREFIX + " extract profile" },
    );

    // ── Parse response ──────────────────────────────────────────
    var responseText = "";
    for (var ri = 0; ri < response.content.length; ri++) {
      if (response.content[ri].type === "text" && response.content[ri].text) {
        responseText += response.content[ri].text;
      }
    }

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
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      throw new Error("Failed to parse LLM profile response: " + String(parseErr));
    }

    // ── Gate and persist ────────────────────────────────────────
    var persisted = 0;
    var dropped = 0;
    var profileResult: ExtractedProfile = { fields: [], trading_names: [], web_domains: [] };

    // Helper: find which source file a snippet belongs to
    function findSourceForSnippet(snippet: string): { file_name: string; document_id: string } | null {
      var normSnippet = normalizeWs(snippet);
      for (var si = 0; si < chunks.length; si++) {
        var normChunkContent = normalizeWs(chunks[si].content);
        if (normChunkContent.indexOf(normSnippet) !== -1) {
          return { file_name: chunks[si].file_name, document_id: chunks[si].document_id };
        }
      }
      return null;
    }

    // Helper: gate a snippet against normalized content
    function gateSnippet(snippet: string): boolean {
      if (!snippet || snippet.trim().length === 0) return false;
      var normSnippet = normalizeWs(snippet);
      return normalizedAllContent.indexOf(normSnippet) !== -1;
    }

    // Process profile fields
    if (Array.isArray(parsed.fields)) {
      for (var fi = 0; fi < parsed.fields.length; fi++) {
        var field = parsed.fields[fi];
        if (!field.field || !field.value || !field.snippet) continue;
        var fieldGated = gateSnippet(field.snippet);
        var fieldSource = fieldGated ? findSourceForSnippet(field.snippet) : null;
        var fieldEntry: ProfileField = {
          field: String(field.field),
          value: String(field.value),
          snippet: String(field.snippet),
          source_file: fieldSource ? fieldSource.file_name : "",
          gated: fieldGated,
        };
        profileResult.fields.push(fieldEntry);

        if (fieldGated) {
          await db.execute(
            "INSERT INTO sri_target_identity (identity_id, run_id, identity_type, identity_value, confidence, verbatim_snippet, source_document_id, created_at) VALUES (gen_random_uuid(), $1, 'profile_field', $2, 'extracted', $3, $4, now()) ON CONFLICT (run_id, identity_type, identity_value) DO NOTHING",
            [runId, field.field + ": " + field.value, field.snippet, fieldSource ? fieldSource.document_id : null],
            { label: LOG_PREFIX + " persist profile field " + field.field },
          );
          persisted++;
        } else {
          dropped++;
          console.log(LOG_PREFIX + " DROPPED field " + field.field + ": snippet gate failed");
        }
      }
    }

    // Process trading names
    if (Array.isArray(parsed.trading_names)) {
      for (var ti = 0; ti < parsed.trading_names.length; ti++) {
        var tn = parsed.trading_names[ti];
        if (!tn.name || !tn.snippet) continue;
        var tnGated = gateSnippet(tn.snippet);
        var tnSource = tnGated ? findSourceForSnippet(tn.snippet) : null;
        profileResult.trading_names.push({
          name: String(tn.name),
          snippet: String(tn.snippet),
          source_file: tnSource ? tnSource.file_name : "",
          gated: tnGated,
        });

        if (tnGated) {
          await db.execute(
            "INSERT INTO sri_target_identity (identity_id, run_id, identity_type, identity_value, confidence, verbatim_snippet, source_document_id, created_at) VALUES (gen_random_uuid(), $1, 'trading_name', $2, 'extracted', $3, $4, now()) ON CONFLICT (run_id, identity_type, identity_value) DO NOTHING",
            [runId, tn.name, tn.snippet, tnSource ? tnSource.document_id : null],
            { label: LOG_PREFIX + " persist trading name " + tn.name },
          );
          persisted++;
        } else {
          dropped++;
          console.log(LOG_PREFIX + " DROPPED trading_name " + tn.name + ": snippet gate failed");
        }
      }
    }

    // Process web domains
    if (Array.isArray(parsed.web_domains)) {
      for (var wi = 0; wi < parsed.web_domains.length; wi++) {
        var wd = parsed.web_domains[wi];
        if (!wd.domain || !wd.snippet) continue;
        var wdGated = gateSnippet(wd.snippet);
        var wdSource = wdGated ? findSourceForSnippet(wd.snippet) : null;
        profileResult.web_domains.push({
          domain: String(wd.domain),
          snippet: String(wd.snippet),
          source_file: wdSource ? wdSource.file_name : "",
          gated: wdGated,
        });

        if (wdGated) {
          await db.execute(
            "INSERT INTO sri_target_identity (identity_id, run_id, identity_type, identity_value, confidence, verbatim_snippet, source_document_id, created_at) VALUES (gen_random_uuid(), $1, 'web_domain', $2, 'extracted', $3, $4, now()) ON CONFLICT (run_id, identity_type, identity_value) DO NOTHING",
            [runId, wd.domain, wd.snippet, wdSource ? wdSource.document_id : null],
            { label: LOG_PREFIX + " persist web domain " + wd.domain },
          );
          persisted++;
        } else {
          dropped++;
          console.log(LOG_PREFIX + " DROPPED web_domain " + wd.domain + ": snippet gate failed");
        }
      }
    }

    return {
      runId: runId,
      profile: profileResult,
      persisted: persisted,
      dropped: dropped,
      chunksUsed: chunks.length,
    };
  },
});
