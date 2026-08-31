/**
 * mast-diag-sweep-probe.ts
 *
 * Read-only diagnostic: sweeps sampled chunks from the Vendor FDD report
 * against a small set of canonical assumptions, asking the model which
 * assumptions each passage bears on.
 *
 * Not a pipeline stage — not in STAGES or HANDLER_MAP.
 * Writes nothing to any table.
 *
 * MAST owns this API. No imports from OA, CC, BSS, ERO, or DCS.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[MAST-SWEEP-PROBE]";

const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
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

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const AssumptionRow = z.object({
  id: z.string(),
  proposition: z.string(),
});

const ChunkRow = z.object({
  chunk_index: z.coerce.number(),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// Normalization — local copy from mast-register-memo.ts
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment diligence analyst reviewing passages from a vendor financial due diligence report against a numbered list of assumptions. Return only valid JSON.";

function buildUserPrompt(
  assumptions: Array<{ index: number; proposition: string }>,
  chunkText: string,
): string {
  const assumptionList = assumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  return `Below is a numbered list of assumptions that a deal model depends on, followed by a passage from a vendor financial due diligence report.

ASSUMPTIONS
${assumptionList}

PASSAGE
${chunkText}

TASK
Which of the numbered assumptions does this passage say something about — supporting or undermining?

Most passages will speak to none of them. Returning an empty array is the expected and correct answer for most passages. Do not stretch to find a connection. Only report an assumption when the passage genuinely bears on it.

For each hit return three fields:
- "index": the assumption number from the list above (integer)
- "quote": copied character for character from the PASSAGE above
- "kind": one of "measured", "forecast", or "asserted"
  - "measured" means someone collected or observed this
  - "forecast" means it is a projection or expectation
  - "asserted" means it is stated without support

Respond with a JSON array only. No prose, no markdown fences. An empty array [] is valid.`;
}

// ---------------------------------------------------------------------------
// Hit schema for parsing model output
// ---------------------------------------------------------------------------

interface RawHit {
  index: number;
  quote: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const HitOutputSchema = z.object({
  assumptionIndex: z.number(),
  quotePassedGate: z.boolean(),
  kind: z.string(),
  quotePreview: z.string(),
});

const ChunkOutputSchema = z.object({
  chunkIndex: z.number(),
  hitsReturned: z.number(),
  hits: z.array(HitOutputSchema),
});

const AssumptionOutputSchema = z.object({
  index: z.number(),
  proposition: z.string(),
});

const AggregatesSchema = z.object({
  chunksProcessed: z.number(),
  chunksZeroHits: z.number(),
  totalHits: z.number(),
  hitsPassedGate: z.number(),
  hitsRejectedByGate: z.number(),
  hitsByKind: z.record(z.string(), z.number()),
});

// ═══════════════════════════════════════════════════════════════════════════════
// API Definition
// ═══════════════════════════════════════════════════════════════════════════════

export default api({
  name: "MastDiagSweepProbe",
  description: "Read-only sweep of FDD chunks against canonical assumptions.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    chunkLimit: z.number().nullable(),
  }),
  output: z.object({
    assumptions: z.array(AssumptionOutputSchema),
    chunks: z.array(ChunkOutputSchema),
    aggregates: AggregatesSchema,
    model: z.string(),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    durationMs: z.number(),
    errors: z.array(z.string()),
  }),

  async run(ctx, { dealId, runId, chunkLimit: chunkLimitInput }) {
    const startTime = Date.now();
    const effectiveChunkLimit = chunkLimitInput ?? 10;
    const model = getModuleModel(MODULE_ID);
    const errors: string[] = [];

    // ── STEP 1: Load canonical assumptions ──────────────────────────
    const memoRows = await ctx.integrations.db.query(
      `SELECT id, proposition FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id AND origin_type = 'memo_prose'
       ORDER BY id LIMIT 6`,
      AssumptionRow,
      [runId],
      { label: "Sweep: load memo_prose assumptions" },
    );

    const explicitRows = await ctx.integrations.db.query(
      `SELECT id, proposition FROM mast_assumptions
       WHERE run_id = $1::uuid AND dedup_group_id = id AND origin_type = 'model_explicit'
       ORDER BY id LIMIT 6`,
      AssumptionRow,
      [runId],
      { label: "Sweep: load model_explicit assumptions" },
    );

    const rawAssumptions = [...memoRows, ...explicitRows];
    const numberedAssumptions = rawAssumptions.map((row, i) => ({
      index: i + 1,
      proposition: row.proposition,
    }));

    console.log(
      `${LOG_PREFIX} ${numberedAssumptions.length} assumptions loaded (${memoRows.length} memo_prose, ${explicitRows.length} model_explicit).`,
    );

    if (numberedAssumptions.length === 0) {
      return {
        assumptions: [],
        chunks: [],
        aggregates: {
          chunksProcessed: 0,
          chunksZeroHits: 0,
          totalHits: 0,
          hitsPassedGate: 0,
          hitsRejectedByGate: 0,
          hitsByKind: {},
        },
        model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        durationMs: Date.now() - startTime,
        errors: ["No canonical assumptions found for this run."],
      };
    }

    // ── STEP 2: Load and sample Vendor FDD chunks ───────────────────
    const allChunks = await ctx.integrations.db.query(
      `SELECT dc.chunk_index, dc.content
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.deal_id = $1::uuid
         AND d.document_tag = 'consultant_report'
         AND d.file_name ILIKE '%Vendor%'
       ORDER BY dc.chunk_index`,
      ChunkRow,
      [dealId],
      { label: "Sweep: load Vendor FDD chunks" },
    );

    if (allChunks.length === 0) {
      return {
        assumptions: numberedAssumptions,
        chunks: [],
        aggregates: {
          chunksProcessed: 0,
          chunksZeroHits: 0,
          totalHits: 0,
          hitsPassedGate: 0,
          hitsRejectedByGate: 0,
          hitsByKind: {},
        },
        model,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        durationMs: Date.now() - startTime,
        errors: ["No Vendor FDD chunks found for this deal."],
      };
    }

    // Sample every Nth chunk to spread across the document
    const totalChunkCount = allChunks.length;
    const stride = Math.max(1, Math.floor(totalChunkCount / effectiveChunkLimit));
    const sampledChunks: Array<{ chunk_index: number; content: string }> = [];
    for (let i = 0; i < totalChunkCount && sampledChunks.length < effectiveChunkLimit; i += stride) {
      sampledChunks.push(allChunks[i]);
    }

    console.log(
      `${LOG_PREFIX} ${totalChunkCount} total chunks, stride=${stride}, sampled ${sampledChunks.length} chunks.`,
    );

    // ── STEP 3: One LLM call per chunk ──────────────────────────────
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Aggregates
    let chunksZeroHits = 0;
    let totalHits = 0;
    let hitsPassedGate = 0;
    let hitsRejectedByGate = 0;
    const hitsByKind: Record<string, number> = {};

    const chunkOutputs: Array<{
      chunkIndex: number;
      hitsReturned: number;
      hits: Array<{
        assumptionIndex: number;
        quotePassedGate: boolean;
        kind: string;
        quotePreview: string;
      }>;
    }> = [];

    for (let ci = 0; ci < sampledChunks.length; ci++) {
      const chunk = sampledChunks[ci];
      const userPrompt = buildUserPrompt(numberedAssumptions, chunk.content);

      let rawHits: RawHit[] = [];
      let attempts = 0;
      let lastAttemptWasError = false;
      let lastAttemptWasParseFailure = false;
      let lastAttemptWasTruncated = false;

      while (attempts < MAX_ATTEMPTS) {
        if (attempts > 0 && !lastAttemptWasError && !lastAttemptWasParseFailure && !lastAttemptWasTruncated) {
          break;
        }
        attempts++;
        lastAttemptWasError = false;
        lastAttemptWasParseFailure = false;
        lastAttemptWasTruncated = false;

        try {
          const llmResponse = await ctx.integrations.ai.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model,
                max_tokens: MAX_OUTPUT_TOKENS,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: userPrompt }],
              },
            },
            { response: MessageResponseSchema },
            { label: `Sweep: chunk ${chunk.chunk_index} attempt ${attempts}` },
          );

          totalInputTokens += llmResponse.usage.input_tokens;
          totalOutputTokens += llmResponse.usage.output_tokens;

          // Detect truncation
          if (llmResponse.stop_reason === "max_tokens") {
            console.log(
              `${LOG_PREFIX} Chunk ${chunk.chunk_index}: TRUNCATED (attempt ${attempts}).`,
            );
            lastAttemptWasTruncated = true;
          }

          const responseText = llmResponse.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");

          // Parse JSON array
          try {
            const parsed = JSON.parse(responseText);
            if (!Array.isArray(parsed)) {
              console.log(
                `${LOG_PREFIX} Chunk ${chunk.chunk_index}: not an array (attempt ${attempts}). Raw: ${responseText.slice(0, 300)}`,
              );
              lastAttemptWasParseFailure = true;
              continue;
            }
            rawHits = parsed.filter(
              (el: any): el is RawHit =>
                el &&
                typeof el === "object" &&
                typeof el.index === "number" &&
                typeof el.quote === "string" &&
                typeof el.kind === "string",
            );
            // Successfully parsed — break (don't retry empty valid result)
            break;
          } catch (_parseErr) {
            console.log(
              `${LOG_PREFIX} Chunk ${chunk.chunk_index}: JSON parse failure (attempt ${attempts}). Raw: ${responseText.slice(0, 300)}`,
            );
            lastAttemptWasParseFailure = true;
            continue;
          }
        } catch (llmErr) {
          console.log(
            `${LOG_PREFIX} Chunk ${chunk.chunk_index}: LLM call failed (attempt ${attempts}): ${String(llmErr)}`,
          );
          lastAttemptWasError = true;
          errors.push(`Chunk ${chunk.chunk_index}: LLM error attempt ${attempts}: ${String(llmErr)}`);
          continue;
        }
      }

      // ── STEP 4: Quote gate ──────────────────────────────────────────
      const normalizedChunk = normalize(chunk.content);
      const processedHits: Array<{
        assumptionIndex: number;
        quotePassedGate: boolean;
        kind: string;
        quotePreview: string;
      }> = [];

      for (const hit of rawHits) {
        const normalizedQuote = normalize(hit.quote);
        const passed = normalizedChunk.includes(normalizedQuote);

        if (passed) {
          hitsPassedGate++;
        } else {
          hitsRejectedByGate++;
        }

        // Count by kind
        hitsByKind[hit.kind] = (hitsByKind[hit.kind] || 0) + 1;

        totalHits++;

        processedHits.push({
          assumptionIndex: hit.index,
          quotePassedGate: passed,
          kind: hit.kind,
          quotePreview: hit.quote.slice(0, 150),
        });
      }

      if (rawHits.length === 0) {
        chunksZeroHits++;
      }

      chunkOutputs.push({
        chunkIndex: chunk.chunk_index,
        hitsReturned: rawHits.length,
        hits: processedHits,
      });

      console.log(
        `${LOG_PREFIX} Chunk ${chunk.chunk_index}: ${rawHits.length} hits, ${processedHits.filter((h) => h.quotePassedGate).length} passed gate.`,
      );
    }

    // ── STEP 5: Output ────────────────────────────────────────────────
    return {
      assumptions: numberedAssumptions,
      chunks: chunkOutputs,
      aggregates: {
        chunksProcessed: sampledChunks.length,
        chunksZeroHits,
        totalHits,
        hitsPassedGate,
        hitsRejectedByGate,
        hitsByKind,
      },
      model,
      totalInputTokens,
      totalOutputTokens,
      durationMs: Date.now() - startTime,
      errors,
    };
  },
});
