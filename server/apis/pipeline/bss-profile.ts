/**
 * BSS v2 — structural profile builder.
 *
 * Produces a structural profile of a deal from a bounded, explicitly named
 * input set that EXCLUDES the diligence corpus, and persists it alongside
 * proof of what was withheld.
 *
 * This is the blindness guarantee for the entire module. Every downstream part
 * of Blind Spot Scanner v2 depends on it holding: candidates are only
 * meaningful as "blind spots" if the generator that produced the profile never
 * saw the diligence work that would have revealed them.
 *
 * WHAT MAY ENTER THE PROMPT
 *   1. Numeric and date fields on the `deals` row, when non-null.
 *   2. Chunks from documents whose `documents.document_tag` is in
 *      STRUCTURAL_PROFILE_ALLOWLIST, capped at STRUCTURAL_PROFILE_CHAR_BUDGET.
 *
 * WHAT MAY NOT
 *   - Free-text `deals` fields (name, description, sector). These are
 *     uncurated form input with no provenance, in a pipeline whose premise is
 *     provenance. They are never sent, even when populated.
 *   - Any document whose tag is outside the allowlist. On a typical deal that
 *     is the consultant reports, financial models and IC memos — i.e. the
 *     diligence corpus itself.
 *
 * PROOF
 *   `excluded_document_ids` is computed as (all documents on the deal) minus
 *   (documents that actually contributed a selected chunk). Both an emptiness
 *   check and a partition assertion run before the LLM call and before insert:
 *   the two sets must be disjoint and must together cover every document on
 *   the deal. A violation is a hard failure, not a warning.
 *
 * APPEND-ONLY
 *   Rows are never updated in place. `bss_candidates.profile_id` is a foreign
 *   key here; rewriting a profile would silently rewrite the provenance of
 *   candidates already generated from it. Each build inserts a new
 *   profile_version, guarded by UNIQUE (deal_id, profile_kind, profile_version).
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import { sha256hex } from "./sha256-pure.js";
import { classifyChunk, BOILERPLATE_MARKERS, BOILERPLATE_MARKER_THRESHOLD } from "./bss-chunk-quality.js";
import {
  matchSnippet,
  SNIPPET_MAX_GAPS,
  SNIPPET_MAX_GAP_CHARS,
  SNIPPET_MAX_TOTAL_SKIPPED,
  type SnippetMatchMode,
} from "./bss-snippet-match.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-PROFILE]";

// ---------------------------------------------------------------------------
// Input contract — declared, exported, auditable
// ---------------------------------------------------------------------------

/** Module id used for model resolution. Registered in SONNET_MODULES. */
export const BSS_V2_MODULE_ID = "blind_spot_scanner_v2";

/** Only documents carrying one of these `documents.document_tag` values may be read. */
export const STRUCTURAL_PROFILE_ALLOWLIST = ["cim"];

/** Hard cap on characters of document text entering the prompt. */
export const STRUCTURAL_PROFILE_CHAR_BUDGET = 20000;

/** Free-text `deals` columns. Listed so the exclusion is explicit, never sent. */
export const DEALS_FREETEXT_FIELDS = ["name", "description", "sector"];

/** Numeric/date `deals` columns. Sent only when non-null. */
export const DEALS_STRUCTURAL_FIELDS = ["entry_ev", "entry_multiple", "equity_check", "ic_date"];

/** Full-text query used to rank chunks. The budget must cut the least relevant text. */
export const BUSINESS_DESCRIPTION_QUERY =
  "business overview OR products services OR customers markets OR what the company does";

/**
 * Any key matching this anywhere in a model response is a contract violation.
 * These modules describe shape and mechanism, not quality — assessment
 * language must not appear.
 *
 * CANONICAL. One parser at every boundary (recorded finding #10). This is the
 * union of the two patterns that previously lived separately here and in
 * bss-generate.ts: `risk_level` came from the profile builder, `critical` and
 * `impact_level` from the candidate generator. Each alternation was written to
 * catch something real, so the union is the correct merge rather than either
 * original taken alone.
 *
 * Note this is WIDER than the pattern the profile builder used before — a
 * response carrying a `critical` or `impact_level` key now aborts where it
 * previously passed. That is the intended direction: fail closed.
 */
export const FORBIDDEN_KEY_PATTERN =
  /sever|confidence|priorit|tier|risk_level|critical|impact_level/i;

/** Ordered profile fields. Order is fixed so the persisted JSON is deterministic. */
export const PROFILE_FIELDS = [
  "sector",
  "business_model",
  "revenue_model",
  "customer_type",
  "deal_archetype",
  "geography",
  "scale_band",
  "capital_structure_notes",
] as const;

/**
 * How many top-ranked chunks are pulled BEFORE classification.
 *
 * Deliberately larger than the number the budget can hold. The v1 flow ranked
 * and then spent the budget immediately, so when full-text search put the
 * confidentiality notice in the top 10 — which it did, because a disclaimer is
 * dense in generic words like "business", "company" and "information" — that
 * text consumed budget that substantive passages then could not have.
 * Over-fetching gives the boilerplate filter something to fall back on.
 */
export const STRUCTURAL_PROFILE_OVERFETCH = 30;

const MAX_OUTPUT_TOKENS = 2000;

/**
 * A field's evidence record. `match_mode` and `chars_skipped` are written by
 * the matcher, never by the model: an elided match is weaker evidence, and the
 * generator that produced it is not a trustworthy narrator of its own rigour.
 */
const FieldSupportSchema = z.object({
  chunk_index: z.number(),
  verbatim_snippet: z.string(),
  match_mode: z.enum(["literal", "elided"]),
  chars_skipped: z.number(),
});

type FieldSupport = z.infer<typeof FieldSupportSchema>;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const DealRowSchema = z.object({
  id: z.string(),
  entry_ev: z.union([z.number(), z.string()]).nullable(),
  entry_multiple: z.union([z.number(), z.string()]).nullable(),
  equity_check: z.union([z.number(), z.string()]).nullable(),
  ic_date: z.union([z.string(), z.date()]).nullable(),
});

const DocumentRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string().nullable(),
  document_source: z.string().nullable(),
});

const ChunkRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.union([z.number(), z.string()]),
  // count(*) OVER () is evaluated before LIMIT, so this reports how many
  // allowlisted chunks exist in total, not how many were over-fetched.
  total_available: z.union([z.number(), z.string()]),
});

const InsertedRowSchema = z.object({
  profile_id: z.string(),
  profile_version: z.number(),
  created_at: z.union([z.string(), z.date()]),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip markdown fences and isolate the outermost JSON object. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Model response contained no JSON object. First 300 chars: ${trimmed.slice(0, 300)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Collect every key name appearing anywhere in a nested structure. */
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

// prompt_hash uses the pure-JS SHA-256 in ./sha256-pure.js. The Superblocks
// server runtime provides neither node:crypto (externalized for the browser
// bundle) nor crypto.subtle/TextEncoder, so the pure implementation is the only
// option that actually runs here.

/**
 * Assemble the exact prompt string. Pure and deterministic: the same inputs
 * always yield the same string, which is what makes prompt_hash meaningful.
 */
export function buildStructuralProfilePrompt(args: {
  dealFields: Record<string, string>;
  chunks: Array<{ chunk_index: number; content: string }>;
}): string {
  const { dealFields, chunks } = args;

  const dealBlock =
    Object.keys(dealFields).length === 0
      ? "(No structural fields are populated on the deal record. Nothing from the deal " +
        "record is available to you. Free-text deal fields are withheld by design.)"
      : Object.entries(dealFields)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

  const excerptBlock = chunks
    .map((c) => `[chunk ${c.chunk_index}]\n${c.content}`)
    .join("\n\n---\n\n");

  const shape = PROFILE_FIELDS.map((f) => `    "${f}": "<one short phrase>"`).join(",\n");
  const supportShape = PROFILE_FIELDS.map(
    (f) =>
      `    "${f}": {"chunk_index": <chunk number>, "verbatim_snippet": "<exact quote, at most 200 characters>"}`,
  ).join(",\n");

  return `You are building a STRUCTURAL PROFILE of a company for an investment diligence system.

You are being shown a deliberately narrow input set: excerpts from a single sellside information memorandum, plus any populated numeric fields from the deal record. Nothing else. This narrowness is intentional and is not an error. Do not speculate about what other documents might contain, and do not note that information is missing.

Your task is to describe what the business IS — its structural shape. You are not assessing it. Do not comment on quality, prospects, attractiveness, risk, or whether any figure is good or bad. The source is a sellside advocacy document: capture the structural facts it reveals, not the claims it makes about performance or outlook.

<deal_structural_fields>
${dealBlock}
</deal_structural_fields>

<source_excerpts>
${excerptBlock}
</source_excerpts>

Return ONLY a JSON object. No prose before or after it, no markdown code fences. It must have exactly this shape, with "profile" first, "field_support" second and "notes" third:

{
  "profile": {
${shape}
  },
  "field_support": {
${supportShape}
  },
  "notes": "<at most two sentences on how confidently the shape could be read from these excerpts>"
}

EVIDENCE RULE — this is the most important rule here:
- Every profile value must be STATED in the excerpts above. Not implied by them, not derivable from them, not consistent with them: stated.
- For each field, "field_support" gives an object with exactly two keys: "chunk_index", the number of the single chunk that states the value, using the [chunk N] labels above; and "verbatim_snippet", the passage in that chunk which states it, at most 200 characters.
- The snippet must be copied CHARACTER FOR CHARACTER out of that chunk. Do not paraphrase it, correct its spelling, expand its abbreviations, or add ellipses. The receiving system locates the snippet inside the chunk text and discards the entire response if it cannot find it.
- Quote the SHORTEST run of text that states the value. A short exact quote is always safer than a long tidied one.
- Some excerpts are extracted from tables and slides, so the text may read oddly and may have fragments of neighbouring columns running through it. Quote it as it appears. Do not clean it up, do not close up the gaps, and do not join text from two different parts of the chunk into one quote — pick a single continuous run instead.
- If the excerpts do not state the value, the profile value is exactly "unknown" and the support is null — the bare JSON literal null, not an object. This is the expected outcome for several fields and is not a failure.
- Do NOT derive, estimate, back-calculate or infer a value from adjacent figures. If a revenue figure is absent, you may not reconstruct it from percentages, ratios or margins that appear near it. Write "unknown".
- A value with no supporting chunk will be rejected by the receiving system, and the whole response discarded. When in doubt, write "unknown" with null.

Rules:
- Every profile field is ONE short phrase, under 15 words. Not a sentence, not a paragraph.
- "scale_band" means an order-of-magnitude revenue or headcount band, e.g. "~£50-100m revenue", and only if such a figure is stated outright. Use "unknown" if no such figure is present.
- "deal_archetype" means the structural transaction type, e.g. "founder-owned buyout", "carve-out", "platform for buy-and-build".
- Do not add, remove or rename any key. "field_support" must contain exactly the same eight keys as "profile". Each of its values is either the two-key object described above or null, and nothing else. Do not nest anything further inside it.
- Do not emit any key containing "severity", "confidence", "priority", "tier" or "risk_level". This is a description of shape, not an assessment.`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "BuildStructuralProfile",
  description: "Builds a blind structural deal profile from CIM only",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    success: z.boolean(),
    profileId: z.string().nullable(),
    profileVersion: z.number().nullable(),
    generationModel: z.string(),
    promptHash: z.string(),
    inputCharCount: z.number(),
    promptText: z.string(),
    profileJson: z.any(),
    inputDocumentIds: z.array(z.string()),
    inputDocumentNames: z.array(z.string()),
    excludedDocumentIds: z.array(z.string()),
    excludedDocuments: z.array(
      z.object({ id: z.string(), file_name: z.string(), document_tag: z.string().nullable() }),
    ),
    totalDocumentsOnDeal: z.number(),
    chunksSelected: z.number(),
    chunksAvailableInAllowlist: z.number(),
    chunksRetrievedForClassification: z.number(),
    chunksDroppedAsBoilerplate: z.number(),
    selectedChunkIndexes: z.array(z.number()),
    retrievedChunkDiagnostics: z.array(
      z.object({
        chunkIndex: z.number(),
        rank: z.number(),
        markerCount: z.number(),
        markersHit: z.array(z.string()),
        isBoilerplate: z.boolean(),
        inFinalSet: z.boolean(),
      }),
    ),
    fieldSupport: z.record(z.string(), FieldSupportSchema.nullable()),
    literalMatchCount: z.number(),
    elidedMatchCount: z.number(),
    maxCharsSkipped: z.number(),
    // Called out separately: scale_band is the field v1 got wrong by
    // back-calculating from a capex table, so it is the specific case the
    // evidence rule was added to catch.
    scaleBandValue: z.string(),
    scaleBandSupport: FieldSupportSchema.nullable(),
    markerFireCounts: z.record(z.string(), z.number()),
    dealFieldsIncluded: z.array(z.string()),
    dealFieldsAllNull: z.boolean(),
    partitionAssertionPassed: z.boolean(),
    forbiddenKeysFound: z.array(z.string()),
    llmCallMs: z.number(),
    usage: z.any(),
  }),

  async run(ctx, { dealId }) {
    // Standalone API, not a pipeline runner: it owns its own platform clock.
    const pipelineStartTime = Date.now();

    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // ── Step 1: deal record — numeric/date fields only ────────────────────
    const dealRows = await ctx.integrations.db.query(
      `SELECT id, entry_ev, entry_multiple, equity_check, ic_date
         FROM deals WHERE id = $1::uuid`,
      DealRowSchema,
      [dealId],
      { label: "BSSProfile: deal structural fields" },
    );
    if (dealRows.length === 0) {
      throw new Error(`${LOG_PREFIX} deal ${dealId} not found.`);
    }
    const deal = dealRows[0];

    const dealFields: Record<string, string> = {};
    for (const field of DEALS_STRUCTURAL_FIELDS) {
      const raw = (deal as Record<string, unknown>)[field];
      if (raw === null || raw === undefined || raw === "") continue;
      dealFields[field] = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
    }
    const dealFieldsIncluded = Object.keys(dealFields);
    const dealFieldsAllNull = dealFieldsIncluded.length === 0;
    console.log(
      `${LOG_PREFIX} deal fields sent: ${dealFieldsAllNull ? "NONE (all structural fields null)" : dealFieldsIncluded.join(", ")}. ` +
        `Free-text fields withheld by contract: ${DEALS_FREETEXT_FIELDS.join(", ")}.`,
    );

    // ── Step 2: enumerate every document on the deal ──────────────────────
    const allDocs = await ctx.integrations.db.query(
      `SELECT id, file_name, document_tag, document_source
         FROM documents WHERE deal_id = $1::uuid ORDER BY file_name`,
      DocumentRowSchema,
      [dealId],
      { label: "BSSProfile: enumerate deal documents" },
    );
    if (allDocs.length === 0) {
      throw new Error(`${LOG_PREFIX} deal ${dealId} has no documents — cannot build a profile.`);
    }

    // ── Step 3: relevance-ranked chunk selection within the allowlist ─────
    // The budget must cut the LEAST relevant text, so ordering is by
    // ts_rank_cd DESC first; chunk_index is only a deterministic tiebreak.
    const chunkRows = await ctx.integrations.db.query(
      `WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq)
       SELECT dc.document_id,
              dc.chunk_index,
              dc.file_name,
              dc.content,
              ts_rank_cd(dc.tsv, q.tsq) AS rank,
              count(*) OVER () AS total_available
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         CROSS JOIN q
        WHERE dc.deal_id = $1::uuid
          AND d.deal_id = $1::uuid
          AND d.document_tag = ANY($3::text[])
        ORDER BY ts_rank_cd(dc.tsv, q.tsq) DESC, dc.chunk_index ASC
        LIMIT ${STRUCTURAL_PROFILE_OVERFETCH}`,
      ChunkRowSchema,
      [dealId, BUSINESS_DESCRIPTION_QUERY, STRUCTURAL_PROFILE_ALLOWLIST],
      { label: "BSSProfile: rank allowlisted chunks" },
    );

    const chunksAvailableInAllowlist = chunkRows.length === 0 ? 0 : Number(chunkRows[0].total_available);

    // Over-fetch → classify → drop boilerplate → spend budget in rank order.
    // The filter is applied HERE, at the call site, and not inside retrieval:
    // this is an input-selection step, where dropping boilerplate costs nothing
    // but budget. The absence sweep must make the opposite choice and discount
    // rather than drop. See the header of ./bss-chunk-quality.ts.
    const selected: Array<{ document_id: string; chunk_index: number; content: string }> = [];
    const diagnostics: Array<{
      chunkIndex: number;
      rank: number;
      markerCount: number;
      markersHit: string[];
      isBoilerplate: boolean;
      inFinalSet: boolean;
    }> = [];
    let charTotal = 0;
    let droppedAsBoilerplate = 0;

    for (const row of chunkRows) {
      const classification = classifyChunk(row.content);
      let inFinalSet = false;

      if (classification.isBoilerplate) {
        droppedAsBoilerplate += 1;
      } else if (charTotal + row.content.length <= STRUCTURAL_PROFILE_CHAR_BUDGET) {
        selected.push({
          document_id: row.document_id,
          chunk_index: row.chunk_index,
          content: row.content,
        });
        charTotal += row.content.length;
        inFinalSet = true;
      }

      diagnostics.push({
        chunkIndex: row.chunk_index,
        rank: Number(row.rank),
        markerCount: classification.markerCount,
        markersHit: classification.markersHit,
        isBoilerplate: classification.isBoilerplate,
        inFinalSet,
      });
    }

    // Per-marker firing count across every retrieved chunk, whether or not it
    // was classified as boilerplate. A marker set whose behaviour rests on one
    // string is one document-template change away from doing nothing, and the
    // aggregate drop count hides that completely. Counting each marker
    // separately puts the dependence in the record instead of leaving it to be
    // inferred later from a number that happens to look healthy.
    const markerFireCounts: Record<string, number> = {};
    for (const marker of BOILERPLATE_MARKERS) markerFireCounts[marker] = 0;
    for (const d of diagnostics) {
      for (const m of d.markersHit) {
        markerFireCounts[m] = (markerFireCounts[m] ?? 0) + 1;
      }
    }

    console.log(
      `${LOG_PREFIX} chunk selection: ${chunksAvailableInAllowlist} allowlisted, ` +
        `${chunkRows.length} retrieved, ${droppedAsBoilerplate} dropped as boilerplate ` +
        `(>=${BOILERPLATE_MARKER_THRESHOLD} distinct markers), ${selected.length} in final set.`,
    );
    console.log(
      `${LOG_PREFIX} marker fires across ${chunkRows.length} retrieved chunks: ` +
        (Object.entries(markerFireCounts)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([m, n]) => `"${m}"=${n}`)
          .join(", ") || "none") +
        `. Silent markers: ` +
        (Object.entries(markerFireCounts)
          .filter(([, n]) => n === 0)
          .map(([m]) => `"${m}"`)
          .join(", ") || "none"),
    );

    if (selected.length === 0) {
      throw new Error(
        `${LOG_PREFIX} no chunks selected from allowlist [${STRUCTURAL_PROFILE_ALLOWLIST.join(", ")}] ` +
          `(${chunksAvailableInAllowlist} allowlisted, ${chunkRows.length} retrieved, ` +
          `${droppedAsBoilerplate} dropped as boilerplate). Refusing to build a profile with no source text.`,
      );
    }

    // ── Step 4: blindness partition ───────────────────────────────────────
    // input = documents that actually contributed a selected chunk. An
    // allowlisted document that contributed nothing was not shown to the model
    // and therefore belongs in the excluded set, not the input set.
    const inputIdSet = new Set(selected.map((c) => c.document_id));
    const inputDocs = allDocs.filter((d) => inputIdSet.has(d.id));
    const excludedDocs = allDocs.filter((d) => !inputIdSet.has(d.id));

    const inputDocumentIds = inputDocs.map((d) => d.id);
    const inputDocumentNames = inputDocs.map((d) => d.file_name);
    const excludedDocumentIds = excludedDocs.map((d) => d.id);

    const overlap = inputDocumentIds.filter((id) => excludedDocumentIds.includes(id));
    const covered = inputDocumentIds.length + excludedDocumentIds.length;
    if (overlap.length > 0 || covered !== allDocs.length) {
      throw new Error(
        `${LOG_PREFIX} BLINDNESS ASSERTION FAILED: overlap=[${overlap.join(", ")}], ` +
          `covered=${covered}, total=${allDocs.length}. No LLM call, no insert.`,
      );
    }
    // Every contributing document must itself be allowlisted — a defence in
    // depth against a future join change silently widening the input set.
    const nonAllowlisted = inputDocs.filter(
      (d) => d.document_tag === null || !STRUCTURAL_PROFILE_ALLOWLIST.includes(d.document_tag),
    );
    if (nonAllowlisted.length > 0) {
      throw new Error(
        `${LOG_PREFIX} BLINDNESS ASSERTION FAILED: non-allowlisted documents contributed chunks: ` +
          nonAllowlisted.map((d) => `${d.file_name} (${d.document_tag})`).join(", "),
      );
    }
    const partitionAssertionPassed = true;
    console.log(
      `${LOG_PREFIX} blindness partition OK: ${inputDocumentIds.length} input + ` +
        `${excludedDocumentIds.length} excluded = ${allDocs.length} total.`,
    );

    // ── Step 5: assemble prompt, measure, hash ────────────────────────────
    const prompt = buildStructuralProfilePrompt({ dealFields, chunks: selected });
    const inputCharCount = prompt.length; // measured, never estimated
    const promptHash = sha256hex(prompt);
    const generationModel = getModuleModel(BSS_V2_MODULE_ID);

    console.log(
      `${LOG_PREFIX} prompt assembled: ${inputCharCount} chars, ${selected.length} chunks, ` +
        `${charTotal} chars of source text, model=${generationModel}, sha256=${promptHash.slice(0, 16)}…`,
    );

    // ── Step 6: the single LLM call ───────────────────────────────────────
    const callStart = Date.now();
    const response = await callLLMWithHeadroom(
      pipelineCtx,
      {
        model: generationModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      },
      "BSSProfile: structural profile",
      { pipelineStartTime },
    );
    const llmCallMs = Date.now() - callStart;

    const rawText = response.content.find((c) => c.type === "text")?.text ?? "";
    console.log(
      `${LOG_PREFIX} call complete: model=${response.model}, ${llmCallMs}ms, ` +
        `in=${response.usage.input_tokens} out=${response.usage.output_tokens} stop=${response.stop_reason}`,
    );

    // ── Step 7: parse and validate, fail-closed ───────────────────────────
    const parsed = extractJsonObject(rawText) as Record<string, unknown>;

    const forbiddenKeysFound = collectKeys(parsed).filter((k) => FORBIDDEN_KEY_PATTERN.test(k));
    if (forbiddenKeysFound.length > 0) {
      console.error(
        `${LOG_PREFIX} CONTRACT VIOLATION: assessment keys in response: ${forbiddenKeysFound.join(", ")}`,
      );
      throw new Error(
        `${LOG_PREFIX} response contained forbidden assessment keys [${forbiddenKeysFound.join(", ")}]. ` +
          "The profile describes shape, not quality. No insert performed.",
      );
    }

    const rawProfile = parsed.profile;
    if (rawProfile === null || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      throw new Error(`${LOG_PREFIX} response has no "profile" object. Raw: ${rawText.slice(0, 400)}`);
    }
    const profileIn = rawProfile as Record<string, unknown>;

    const missing = PROFILE_FIELDS.filter((f) => typeof profileIn[f] !== "string" || profileIn[f] === "");
    if (missing.length > 0) {
      throw new Error(`${LOG_PREFIX} profile missing/non-string fields: ${missing.join(", ")}`);
    }
    const extra = Object.keys(profileIn).filter((k) => !(PROFILE_FIELDS as readonly string[]).includes(k));
    if (extra.length > 0) {
      throw new Error(`${LOG_PREFIX} profile has unexpected fields: ${extra.join(", ")}`);
    }

    // ── Step 7b: field-level support ──────────────────────────────────────
    // v1 returned scale_band "~£145–185m revenue implied by capex percentages",
    // which is a back-calculation presented as an observation — and it was low.
    // A blind generator that inherits an understated scale reasons about the
    // wrong size of business. Requiring a citing chunk per field makes the
    // difference between observed and derived checkable rather than trusted.
    const rawSupport = parsed.field_support;
    if (rawSupport === null || typeof rawSupport !== "object" || Array.isArray(rawSupport)) {
      throw new Error(
        `${LOG_PREFIX} response has no "field_support" object. Raw: ${rawText.slice(0, 400)}`,
      );
    }
    const supportIn = rawSupport as Record<string, unknown>;

    const supportExtra = Object.keys(supportIn).filter(
      (k) => !(PROFILE_FIELDS as readonly string[]).includes(k),
    );
    if (supportExtra.length > 0) {
      throw new Error(`${LOG_PREFIX} field_support has unexpected keys: ${supportExtra.join(", ")}`);
    }

    const selectedIndexSet = new Set(selected.map((c) => c.chunk_index));
    const contentByIndex = new Map(selected.map((c) => [c.chunk_index, c.content]));

    const fieldSupport: Record<string, FieldSupport | null> = {};
    const unsupportedFields: string[] = [];
    const uncitedChunks: string[] = [];
    const malformedSupport: string[] = [];
    const snippetMismatches: string[] = [];

    for (const f of PROFILE_FIELDS) {
      const raw = supportIn[f];
      const value = String(profileIn[f]);
      const isUnknown = value.trim().toLowerCase() === "unknown";

      // Parse the model's two declared keys. Anything the model may have added
      // beyond them — including match_mode, which is the matcher's to set — is
      // ignored rather than trusted.
      let claimIndex: number | null = null;
      let claimSnippet: string | null = null;

      if (raw !== null && raw !== undefined) {
        if (typeof raw !== "object" || Array.isArray(raw)) {
          malformedSupport.push(`${f} (expected {chunk_index, verbatim_snippet} or null, got ${typeof raw})`);
        } else {
          const obj = raw as Record<string, unknown>;
          const idxRaw = obj.chunk_index;
          const snippetRaw = obj.verbatim_snippet;
          const idx =
            typeof idxRaw === "number" && Number.isInteger(idxRaw)
              ? idxRaw
              : typeof idxRaw === "string" && /^\d+$/.test(idxRaw.trim())
                ? Number(idxRaw.trim()) // tolerate a numeric string; unambiguous
                : null;
          if (idx === null || typeof snippetRaw !== "string" || snippetRaw.trim() === "") {
            malformedSupport.push(`${f} (chunk_index or verbatim_snippet missing / wrong type)`);
          } else {
            claimIndex = idx;
            claimSnippet = snippetRaw;
            if ("match_mode" in obj || "chars_skipped" in obj) {
              console.warn(
                `${LOG_PREFIX} field_support.${f} supplied match_mode/chars_skipped; ignored. ` +
                  "Those are set by the matcher, not the model.",
              );
            }
          }
        }
      }

      let support: FieldSupport | null = null;
      if (claimIndex !== null && claimSnippet !== null) {
        // A citation to a chunk that was never shown is a fabricated citation,
        // which is worse than an absent one — it would survive the null check.
        if (!selectedIndexSet.has(claimIndex)) {
          uncitedChunks.push(`${f} -> chunk ${claimIndex}`);
        } else {
          // A chunk number on its own is cheap to produce and cannot distinguish
          // a passage the model read from one it composed. Matching the snippet
          // against the exact text that was sent is the only check here that a
          // plausible-sounding derivation cannot pass.
          const content = contentByIndex.get(claimIndex) ?? "";
          const m = matchSnippet(content, claimSnippet);
          if (!m.matched) {
            snippetMismatches.push(
              `${f} -> chunk ${claimIndex}: ${m.reason} — "${claimSnippet.slice(0, 140)}"`,
            );
          } else {
            support = {
              chunk_index: claimIndex,
              verbatim_snippet: claimSnippet,
              match_mode: m.mode as SnippetMatchMode,
              chars_skipped: m.charsSkipped,
            };
            if (m.mode === "elided") {
              console.warn(
                `${LOG_PREFIX} field_support.${f} matched chunk ${claimIndex} with ${m.gapCount} gap(s), ` +
                  `${m.charsSkipped} chars skipped. Recorded as elided — weaker evidence than a literal match.`,
              );
            }
            if (claimSnippet.length > 200) {
              console.warn(
                `${LOG_PREFIX} field_support.${f} snippet is ${claimSnippet.length} chars, ` +
                  "over the 200-char instruction; it matches so it is accepted.",
              );
            }
          }
        }
      }

      if (!isUnknown && support === null) {
        unsupportedFields.push(f);
      }

      // "unknown" carries no support by definition; normalise so the persisted
      // JSON cannot claim a source for a value it does not have.
      fieldSupport[f] = isUnknown ? null : support;
      if (isUnknown && support !== null) {
        console.warn(
          `${LOG_PREFIX} field_support.${f} cited chunk ${support.chunk_index} for an "unknown" value; normalised to null.`,
        );
      }
    }

    if (malformedSupport.length > 0) {
      throw new Error(
        `${LOG_PREFIX} field_support entries are malformed: ${malformedSupport.join(", ")}. ` +
          "Each entry must be {chunk_index, verbatim_snippet} or null. No insert performed.",
      );
    }
    if (uncitedChunks.length > 0) {
      throw new Error(
        `${LOG_PREFIX} field_support cites chunks that were never shown to the model: ` +
          `${uncitedChunks.join(", ")}. Shown: [${[...selectedIndexSet].join(", ")}]. No insert performed.`,
      );
    }
    if (snippetMismatches.length > 0) {
      throw new Error(
        `${LOG_PREFIX} EVIDENCE RULE VIOLATION: verbatim_snippet could not be located in the cited ` +
          `chunk within the elision bounds (<=${SNIPPET_MAX_GAPS} gaps, <=${SNIPPET_MAX_GAP_CHARS} chars each, ` +
          `<=${SNIPPET_MAX_TOTAL_SKIPPED} total): ${snippetMismatches.join("; ")}. A quote that does not ` +
          "appear in the source is not evidence. No insert performed.",
      );
    }
    if (unsupportedFields.length > 0) {
      throw new Error(
        `${LOG_PREFIX} EVIDENCE RULE VIOLATION: fields with a non-"unknown" value and no ` +
          `supporting chunk: ${unsupportedFields.join(", ")}. A value the extract does not ` +
          "state must be \"unknown\". No insert performed.",
      );
    }

    // Rebuild in fixed key order: profile, field_support, notes.
    const profile: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) profile[f] = String(profileIn[f]);
    const profileJson = {
      profile,
      field_support: fieldSupport,
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };

    // Match-quality summary. If most fields need elision, the extracted corpus
    // is more degraded than a single CIM would suggest, which is a design input
    // for later phases rather than a detail of this one.
    const supportEntries = PROFILE_FIELDS.map((f) => fieldSupport[f]).filter(
      (s): s is FieldSupport => s !== null,
    );
    const literalMatchCount = supportEntries.filter((s) => s.match_mode === "literal").length;
    const elidedMatchCount = supportEntries.filter((s) => s.match_mode === "elided").length;
    const maxCharsSkipped = supportEntries.reduce((max, s) => Math.max(max, s.chars_skipped), 0);

    const scaleBandValue = profile.scale_band;
    const scaleBandSupport = fieldSupport.scale_band ?? null;

    console.log(
      `${LOG_PREFIX} field support: ` +
        PROFILE_FIELDS.map((f) => {
          const s = fieldSupport[f];
          return s ? `${f}=chunk ${s.chunk_index}/${s.match_mode}` : `${f}=null`;
        }).join(" "),
    );
    console.log(
      `${LOG_PREFIX} match quality: ${literalMatchCount} literal, ${elidedMatchCount} elided, ` +
        `${PROFILE_FIELDS.length - supportEntries.length} unsupported ("unknown"), ` +
        `max chars skipped ${maxCharsSkipped}.`,
    );
    console.log(
      `${LOG_PREFIX} scale_band = "${scaleBandValue}" | support = ` +
        (scaleBandSupport
          ? `chunk ${scaleBandSupport.chunk_index} (${scaleBandSupport.match_mode}, ${scaleBandSupport.chars_skipped} skipped)`
          : "null") +
        ". v1 back-calculated this field from a capex table; null or a cited figure both mean the rule held.",
    );

    // ── Step 8: append-only insert ────────────────────────────────────────
    // profile_version = MAX + 1 for this (deal_id, profile_kind). Never an
    // upsert: bss_candidates.profile_id points here, so an in-place update
    // would rewrite the provenance of candidates already generated.
    const inserted = await ctx.integrations.db.query(
      `INSERT INTO bss_profiles (
         deal_id, profile_kind, profile_version, profile_json,
         input_document_ids, input_document_names, excluded_document_ids,
         input_char_count, generation_model, prompt_hash
       )
       SELECT $1::uuid,
              'structural',
              COALESCE((SELECT MAX(profile_version) FROM bss_profiles
                         WHERE deal_id = $1::uuid AND profile_kind = 'structural'), 0) + 1,
              $2::jsonb, $3::uuid[], $4::text[], $5::uuid[], $6::int, $7::text, $8::text
       RETURNING profile_id, profile_version, created_at`,
      InsertedRowSchema,
      [
        dealId,
        JSON.stringify(profileJson),
        inputDocumentIds,
        inputDocumentNames,
        excludedDocumentIds,
        inputCharCount,
        generationModel,
        promptHash,
      ],
      { label: "BSSProfile: insert structural profile" },
    );
    const row = inserted[0] ?? null;
    console.log(
      `${LOG_PREFIX} inserted profile_id=${row?.profile_id} version=${row?.profile_version}`,
    );

    return {
      success: true,
      profileId: row?.profile_id ?? null,
      profileVersion: row?.profile_version ?? null,
      generationModel,
      promptHash,
      inputCharCount,
      promptText: prompt,
      profileJson,
      inputDocumentIds,
      inputDocumentNames,
      excludedDocumentIds,
      excludedDocuments: excludedDocs.map((d) => ({
        id: d.id,
        file_name: d.file_name,
        document_tag: d.document_tag,
      })),
      totalDocumentsOnDeal: allDocs.length,
      chunksSelected: selected.length,
      chunksAvailableInAllowlist,
      chunksRetrievedForClassification: chunkRows.length,
      chunksDroppedAsBoilerplate: droppedAsBoilerplate,
      selectedChunkIndexes: selected.map((c) => c.chunk_index),
      retrievedChunkDiagnostics: diagnostics,
      fieldSupport,
      literalMatchCount,
      elidedMatchCount,
      maxCharsSkipped,
      scaleBandValue,
      scaleBandSupport,
      markerFireCounts,
      dealFieldsIncluded,
      dealFieldsAllNull,
      partitionAssertionPassed,
      forbiddenKeysFound,
      llmCallMs,
      usage: response.usage,
    };
  },
});
