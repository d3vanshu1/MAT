/**
 * mast-diag-sweep-prompt-ab.ts
 *
 * A/B prompt probe for the support sweep. Runs two arms over the same
 * assumption/chunk pairs and reports gate-passing hits from each.
 *
 * Arm A: current sweep prompt verbatim.
 * Arm B: adds language about legal/regulatory/contractual constraints
 *        and a fifth relation field (supports|undermines|constrains|defines).
 *
 * Writes nothing. Read-only diagnostic.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[MAST-SWEEP-AB]";
const MODULE_ID = "mast_v2";
const MAX_OUTPUT_TOKENS = 4096;
const CHUNKS_PER_CALL = 8;
const MIN_QUOTE_WORDS = 6;
const PREFIX_GATE_LEN = 40;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RunIdRow = z.object({ id: z.string() });

const AssumptionRow = z.object({
  id: z.string(),
  proposition: z.string(),
});

const ChunkRow = z.object({
  chunk_index: z.coerce.number(),
  content: z.string(),
  document_id: z.string(),
  file_name: z.string(),
});

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
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Normalize (verbatim from sweep)
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT (verbatim from sweep)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are an investment diligence analyst reviewing passages from deal documents against a numbered list of assumptions. Return only valid JSON.";

// ---------------------------------------------------------------------------
// Arm A: current prompt (verbatim from sweep)
// ---------------------------------------------------------------------------

function buildCachedPrefixA(
  assumptions: Array<{ index: number; proposition: string }>,
): string {
  const assumptionList = assumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  return `ASSUMPTIONS
${assumptionList}

TASK
Which of the numbered assumptions does each passage say something about — supporting or undermining?

Most passages will speak to none of them. Returning an empty array is the expected and correct answer for most chunks. Do not stretch to find a connection. Only report an assumption when the passage genuinely bears on it.

A consultant's projection is "forecast", not "measured", regardless of the credibility of the source.

For each hit return four fields:
- "chunk": the chunk label number (integer)
- "index": the assumption number from the list above (integer)
- "quote": copied character for character from that passage
- "kind": one of "measured", "forecast", or "asserted"
  - "measured" means someone collected or observed this
  - "forecast" means it is a projection or expectation
  - "asserted" means it is stated without support

Respond with a JSON array only. No prose, no markdown fences. An empty array [] is valid.`;
}

// ---------------------------------------------------------------------------
// Arm B: extended prompt
// ---------------------------------------------------------------------------

function buildCachedPrefixB(
  assumptions: Array<{ index: number; proposition: string }>,
): string {
  const assumptionList = assumptions
    .map((a) => `${a.index}. ${a.proposition}`)
    .join("\n");

  return `ASSUMPTIONS
${assumptionList}

TASK
Which of the numbered assumptions does each passage bear on?

A passage bears on an assumption when it supports it, undermines it, or describes a legal, regulatory, contractual or operational constraint that would make the assumption harder to achieve — even when the passage does not restate the assumption's wording.

Most passages will speak to none of them. Returning an empty array is the expected and correct answer for most chunks. Do not stretch to find a connection. Only report an assumption when the passage genuinely bears on it.

A consultant's projection is "forecast", not "measured", regardless of the credibility of the source.

For each hit return five fields:
- "chunk": the chunk label number (integer)
- "index": the assumption number from the list above (integer)
- "quote": copied character for character from that passage
- "relation": one of "supports", "undermines", "constrains", "defines"
  - "supports" means the passage provides evidence that the assumption holds
  - "undermines" means the passage provides evidence that the assumption may not hold
  - "constrains" means the passage describes a condition, risk, or limitation that bears on whether the assumption holds, without directly confirming or denying it
  - "defines" means the passage defines a term, threshold, or mechanism referenced in the assumption
- "kind": one of "measured", "forecast", or "asserted"
  - "measured" means someone collected or observed this
  - "forecast" means it is a projection or expectation
  - "asserted" means it is stated without support

Respond with a JSON array only. No prose, no markdown fences. An empty array [] is valid.`;
}

// ---------------------------------------------------------------------------
// Shared passages block (verbatim from sweep)
// ---------------------------------------------------------------------------

function buildPassagesBlock(
  chunks: Array<{ label: number; content: string }>,
): string {
  const chunkList = chunks
    .map((c) => `--- CHUNK ${c.label} ---\n${c.content}\n--- END CHUNK ${c.label} ---`)
    .join("\n\n");

  return `Below is a numbered list of assumptions that a deal model depends on, followed by ${chunks.length} passages from deal documents, each labelled with its number.

Passages are labelled 1 through ${chunks.length} for this request only. The "chunk" field in your response must be that label. Do not use document page numbers, corpus indices, or any other numbering.

PASSAGES
${chunkList}`;
}

// ---------------------------------------------------------------------------
// Hit interfaces
// ---------------------------------------------------------------------------

interface RawHitA {
  chunk: number;
  index: number;
  quote: string;
  kind: string;
}

interface RawHitB {
  chunk: number;
  index: number;
  quote: string;
  kind: string;
  relation: string;
}

interface GatedHit {
  assumptionIndex: number;
  proposition: string;
  quote: string;
  kind: string;
  relation: string | null;
  chunkLocator: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "MastDiagSweepPromptAB",
  description: "A/B prompt probe: compares current sweep prompt vs extended constraint-aware prompt",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    runId: z.string().uuid().nullable().default(null),
  }),

  output: z.object({
    runId: z.string(),
    assumptionCount: z.number(),
    chunkCount: z.number(),
    callsPerArm: z.number(),
    armA: z.object({
      totalHitsReturned: z.number(),
      hitsPassedGate: z.number(),
      rejectBadIndex: z.number(),
      rejectQuoteTooShort: z.number(),
      rejectPrefixNotFound: z.number(),
      hits: z.array(z.any()),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
    armB: z.object({
      totalHitsReturned: z.number(),
      hitsPassedGate: z.number(),
      rejectBadIndex: z.number(),
      rejectQuoteTooShort: z.number(),
      rejectPrefixNotFound: z.number(),
      hits: z.array(z.any()),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
    priceRiseChunkHit: z.any().nullable(),
  }),

  async run(ctx, { dealId, runId: inputRunId }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.ai;
    const model = getModuleModel(MODULE_ID);

    // ── 1. Resolve run ──────────────────────────────────────────────
    let runId: string;
    if (inputRunId) {
      runId = inputRunId;
    } else {
      const runs = await db.query(
        `SELECT id FROM module_runs
         WHERE deal_id = $1::uuid AND module_id = 'model_assumptions_stress' AND status = 'completed'
         ORDER BY triggered_at DESC LIMIT 1`,
        RunIdRow,
        [dealId],
        { label: `${LOG_PREFIX} find latest run` },
      );
      if (runs.length === 0) throw new Error("No completed MAST run found.");
      runId = runs[0].id;
    }

    // ── 2. Select assumptions matching keywords ─────────────────────
    const assumptions = await db.query(
      `SELECT id, proposition
       FROM mast_assumptions
       WHERE run_id = $1::uuid
         AND dedup_group_id = id
         AND origin_type = 'memo_prose'
         AND (
           proposition ~* 'price increase'
           OR proposition ~* 'escalator'
           OR proposition ~* 'inflation.linked'
           OR proposition ~* 'churn'
           OR proposition ~* 'retention'
           OR proposition ~* 'termination'
           OR proposition ~* 'contract term'
           OR proposition ~* 'change of control'
         )
       ORDER BY id`,
      AssumptionRow,
      [runId],
      { label: `${LOG_PREFIX} select matching assumptions` },
    );

    const assumptionCount = assumptions.length;
    console.log(`${LOG_PREFIX} ${assumptionCount} assumptions matched keywords.`);

    // Number assumptions 1..N
    const numberedAssumptions = assumptions.map((a, i) => ({
      index: i + 1,
      id: a.id,
      proposition: a.proposition,
    }));
    const indexById = new Map(numberedAssumptions.map((a) => [a.id, a.index]));

    // ── 3. Select Legal DD chunks (filtered to pricing/contract keywords) ──
    const chunks = await db.query(
      `SELECT dc.chunk_index, dc.content, dc.document_id, dc.file_name
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE d.deal_id = $1::uuid
         AND d.file_name ILIKE '%Legal Due Diligence%'
         AND (
           dc.content ILIKE '%price%'
           OR dc.content ILIKE '%escalat%'
           OR dc.content ILIKE '%inflation%'
           OR dc.content ILIKE '%churn%'
           OR dc.content ILIKE '%retention%'
           OR dc.content ILIKE '%terminat%'
           OR dc.content ILIKE '%contract term%'
           OR dc.content ILIKE '%change of control%'
           OR dc.content ILIKE '%exit%'
         )
       ORDER BY dc.chunk_index`,
      ChunkRow,
      [dealId],
      { label: `${LOG_PREFIX} load Legal DD chunks (keyword-filtered)` },
    );

    const chunkCount = chunks.length;
    const callsPerArm = Math.ceil(chunkCount / CHUNKS_PER_CALL);
    console.log(`${LOG_PREFIX} ${chunkCount} Legal DD chunks. ${callsPerArm} calls per arm.`);

    // ── 4. Run both arms ────────────────────────────────────────────
    const cachedPrefixA = buildCachedPrefixA(numberedAssumptions);
    const cachedPrefixB = buildCachedPrefixB(numberedAssumptions);

    interface ArmResult {
      totalHitsReturned: number;
      hitsPassedGate: number;
      rejectBadIndex: number;
      rejectQuoteTooShort: number;
      rejectPrefixNotFound: number;
      hits: GatedHit[];
      inputTokens: number;
      outputTokens: number;
    }

    async function runArm(
      armLabel: string,
      cachedPrefix: string,
      expectRelation: boolean,
    ): Promise<ArmResult> {
      let totalHitsReturned = 0;
      let hitsPassedGate = 0;
      let rejectBadIndex = 0;
      let rejectQuoteTooShort = 0;
      let rejectPrefixNotFound = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const hits: GatedHit[] = [];

      for (let batchIdx = 0; batchIdx < callsPerArm; batchIdx++) {
        const chunkStart = batchIdx * CHUNKS_PER_CALL;
        const chunkEnd = Math.min(chunkStart + CHUNKS_PER_CALL, chunkCount);
        const chunkBatch = chunks.slice(chunkStart, chunkEnd);

        const labelledChunks = chunkBatch.map((c, i) => ({
          label: i + 1,
          content: c.content,
        }));

        const passagesBlock = buildPassagesBlock(labelledChunks);
        const userPrompt = `${passagesBlock}`;

        let rawHits: any[] = [];
        const MAX_ATTEMPTS = 2;
        let attempts = 0;

        while (attempts < MAX_ATTEMPTS) {
          attempts++;
          try {
            const llmResponse = await ai.apiRequest(
              {
                method: "POST",
                path: "/v1/messages",
                body: {
                  model,
                  max_tokens: MAX_OUTPUT_TOKENS,
                  system: [
                    { type: "text", text: SYSTEM_PROMPT },
                    { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } },
                  ],
                  messages: [{ role: "user", content: userPrompt }],
                },
              },
              { response: MessageResponseSchema },
              { label: `${LOG_PREFIX} ${armLabel} batch ${batchIdx + 1}/${callsPerArm}` },
            );

            inputTokens += llmResponse.usage.input_tokens;
            outputTokens += llmResponse.usage.output_tokens;

            if (llmResponse.stop_reason === "max_tokens") {
              console.log(`${LOG_PREFIX} ${armLabel} batch ${batchIdx + 1}: TRUNCATED`);
              continue;
            }

            let responseText = llmResponse.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");

            // Strip markdown fences
            responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

            try {
              const parsed = JSON.parse(responseText);
              if (!Array.isArray(parsed)) continue;
              rawHits = parsed;
              break;
            } catch {
              console.log(`${LOG_PREFIX} ${armLabel} batch ${batchIdx + 1}: parse failure`);
              continue;
            }
          } catch (err) {
            console.log(`${LOG_PREFIX} ${armLabel} batch ${batchIdx + 1}: LLM error: ${String(err).slice(0, 200)}`);
            continue;
          }
        }

        // ── Gate ────────────────────────────────────────────────────
        for (const hit of rawHits) {
          totalHitsReturned++;

          // Validate chunk label
          if (typeof hit.chunk !== "number" || hit.chunk < 1 || hit.chunk > chunkBatch.length) {
            rejectBadIndex++;
            continue;
          }
          // Validate assumption index
          if (typeof hit.index !== "number" || hit.index < 1 || hit.index > assumptionCount) {
            rejectBadIndex++;
            continue;
          }
          if (typeof hit.quote !== "string") {
            rejectBadIndex++;
            continue;
          }

          // Quote word count gate
          const quoteWords = hit.quote.trim().split(/\s+/);
          if (quoteWords.length < MIN_QUOTE_WORDS) {
            rejectQuoteTooShort++;
            continue;
          }

          // Prefix gate
          const chunkContent = chunkBatch[hit.chunk - 1].content;
          const normalizedChunk = normalize(chunkContent);
          const normalizedQuote = normalize(hit.quote);

          let passedGate: boolean;
          if (normalizedQuote.length <= PREFIX_GATE_LEN) {
            passedGate = normalizedChunk.includes(normalizedQuote);
          } else {
            const prefix = normalizedQuote.slice(0, PREFIX_GATE_LEN);
            passedGate = normalizedChunk.includes(prefix);
          }

          if (!passedGate) {
            rejectPrefixNotFound++;
            continue;
          }

          // Passed
          hitsPassedGate++;
          const assumption = numberedAssumptions[hit.index - 1];
          const chunkData = chunkBatch[hit.chunk - 1];

          hits.push({
            assumptionIndex: hit.index,
            proposition: assumption.proposition.slice(0, 80),
            quote: hit.quote,
            kind: hit.kind ?? "unknown",
            relation: expectRelation ? (hit.relation ?? "unknown") : null,
            chunkLocator: `${chunkData.file_name}:chunk_${chunkData.chunk_index}`,
          });
        }
      }

      console.log(
        `${LOG_PREFIX} ${armLabel}: ${totalHitsReturned} returned, ${hitsPassedGate} passed gate, ` +
        `rejectBadIndex=${rejectBadIndex}, rejectQuoteTooShort=${rejectQuoteTooShort}, ` +
        `rejectPrefixNotFound=${rejectPrefixNotFound}. Tokens: ${inputTokens}/${outputTokens}.`,
      );

      return {
        totalHitsReturned,
        hitsPassedGate,
        rejectBadIndex,
        rejectQuoteTooShort,
        rejectPrefixNotFound,
        hits,
        inputTokens,
        outputTokens,
      };
    }

    // Run arms sequentially
    console.log(`${LOG_PREFIX} Running Arm A (current prompt)...`);
    const armA = await runArm("ArmA", cachedPrefixA, false);

    console.log(`${LOG_PREFIX} Running Arm B (extended prompt)...`);
    const armB = await runArm("ArmB", cachedPrefixB, true);

    // ── 5. Check for price-rise chunk hit ────────────────────────────
    const allHits = [...armA.hits, ...armB.hits];
    const priceRiseHit = allHits.find((h) =>
      h.chunkLocator.toLowerCase().includes("legal") &&
      (h.quote.toLowerCase().includes("price rise") ||
       h.quote.toLowerCase().includes("right of exit") ||
       h.quote.toLowerCase().includes("mid-contract"))
    ) ?? null;

    return {
      runId,
      assumptionCount,
      chunkCount,
      callsPerArm,
      armA,
      armB,
      priceRiseChunkHit: priceRiseHit,
    };
  },
});
