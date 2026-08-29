/**
 * DCS Extract Presence — Phase 2.1 of the DCS rebuild.
 *
 * Processes document chunks one at a time through a Sonnet LLM call to
 * determine which of the 10 DCS dimensions each chunk covers, and whether
 * coverage is substantive. Results are written to dcs_evidence with
 * deterministic doc_class from classifyDocClass (never from the model).
 *
 * Cursor-based resumable. Replay-safe via delete-before-insert per chunk.
 * Zero-evidence responses are normal and advance the cursor.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";
import { callLLMWithHeadroom } from "./call-llm.js";
import { DCS_DIMENSIONS, classifyDocClass } from "./dcs-rubric.js";
import type { PipelineContext } from "./pipeline-config.js";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ────────────────────────────────────────────────────
const INVOCATION_BUDGET_MS = 240_000;
const MIN_CALL_HEADROOM_MS = 30_000;
const MAX_PER_CALL_MS = 60_000;

const VALID_DIMENSION_IDS = new Set(DCS_DIMENSIONS.map((d) => d.id));

// ── LLM response item schema ────────────────────────────────────
const PresenceItem = z.object({
  dimension_id: z.string(),
  snippet: z.string(),
  is_substantive: z.boolean(),
});
type PresenceItem = z.infer<typeof PresenceItem>;

// ── Cumulative detail stored in dcs_pipeline_state.detail ────────
interface CumulativeDetail {
  processed_count: number;
  empty_chunk_count: number;
  evidence_rows_written: number;
  fabrication_rejected: number;
  invalid_dimension_rejected: number;
  duplicate_dimension_rejected: number;
  total_chunks: number;
  last_chunk_id: string | null;
}

function emptyDetail(totalChunks: number): CumulativeDetail {
  return {
    processed_count: 0,
    empty_chunk_count: 0,
    evidence_rows_written: 0,
    fabrication_rejected: 0,
    invalid_dimension_rejected: 0,
    duplicate_dimension_rejected: 0,
    total_chunks: totalChunks,
    last_chunk_id: null,
  };
}

// ── Whitespace normalizer for literal anchoring ──────────────────
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── System prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior PE operating partner reviewing a single document chunk for diligence completeness.

Your task: identify which of the 10 standard PE diligence dimensions THIS CHUNK covers.

The 10 dimensions and their topic anchors:
${DCS_DIMENSIONS.map((d, i) => `${i + 1}. ${d.id}: ${d.description}`).join("\n")}

Return ONLY one raw JSON array. Do not use Markdown. Do not use code fences. Do not add introductory or concluding prose. Each item must have exactly these fields:
- "dimension_id": one of the 10 dimension IDs listed above (snake_case)
- "snippet": a VERBATIM excerpt from the chunk text that demonstrates coverage (copy-paste exactly, do not paraphrase or edit)
- "is_substantive": true if the snippet contains data, analysis, a finding, a contract term, or a stated metric; false if it is only a heading, table of contents entry, boilerplate, passing mention, or forward reference

Substantive examples:
- "Customer churn was 8.2% in FY25." → true
- "The SPA requires consent on a change of control." → true

Non-substantive examples:
- "Customer overview" → false
- "See the legal section below." → false

Rules:
- Return at most ONE item per dimension. If a dimension appears multiple times, pick the strongest snippet.
- Return an EMPTY ARRAY [] when the chunk contains nothing relevant to any dimension. Empty is normal.
- Do NOT assess what is absent or missing.
- Do NOT score or grade any dimension.
- Do NOT classify the document type.
- Do NOT consider anything outside the supplied chunk.
- The snippet MUST be copied verbatim from the chunk text. Do not edit, shorten, or rephrase.`;

// ── Trace entry for verification mode ────────────────────────────
interface TraceEntry {
  chunk_id: string;
  source_file: string;
  document_tag: string;
  doc_class: string;
  raw_model_response: string;
  accepted: Array<{
    dimension_id: string;
    snippet: string;
    is_substantive: boolean;
    doc_class: string;
  }>;
  rejected: Array<{
    dimension_id: string;
    snippet: string;
    is_substantive: boolean;
    reason: string;
  }>;
}

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════
export default api({
  name: "DcsExtractPresence",
  description: "Extracts dimension presence from document chunks for DCS scoring",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
    batchSize: z.number().int().min(1).max(8).default(8),
    resumeCursor: z.string().uuid().optional(),
    verificationChunkId: z.string().uuid().optional(),
    debug: z.boolean().default(false),
  }),

  output: z.object({
    runId: z.string(),
    mode: z.string(),
    status: z.string(),
    processedThisCall: z.number(),
    cumulativeProcessed: z.number(),
    rowsWrittenThisCall: z.number(),
    cumulativeRowsWritten: z.number(),
    emptyChunksThisCall: z.number(),
    fabricationRejectedThisCall: z.number(),
    invalidDimensionRejectedThisCall: z.number(),
    duplicateDimensionRejectedThisCall: z.number(),
    savedCursor: z.string().nullable(),
    remainingChunks: z.number(),
    resumeRequired: z.boolean(),
    elapsedMs: z.number(),
    trace: z.array(z.any()),
  }),

  async run(ctx, input) {
    const startTime = Date.now();
    const db = ctx.integrations.ic_diligence_db;
    const isVerification = !!input.verificationChunkId;
    const mode = isVerification ? "verification" : "normal";

    // ── 1. Run validation ──────────────────────────────────────
    const runCheck = await db.query(
      `SELECT id FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string() }),
      [input.runId, input.dealId],
      { label: "DcsExtract: validate module_runs" },
    );
    if (runCheck.length === 0) {
      throw new Error(
        `No module_runs row for runId=${input.runId} with dealId=${input.dealId} and module_id=diligence_completeness`,
      );
    }

    // ── 2. Count total chunks ──────────────────────────────────
    const totalChunksResult = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      [input.dealId],
      { label: "DcsExtract: count total chunks" },
    );
    const totalChunks = totalChunksResult[0]?.cnt ?? 0;

    // ── Tracking ───────────────────────────────────────────────
    let processedThisCall = 0;
    let rowsWrittenThisCall = 0;
    let emptyChunksThisCall = 0;
    let fabricationRejectedThisCall = 0;
    let invalidDimensionRejectedThisCall = 0;
    let duplicateDimensionRejectedThisCall = 0;
    const trace: TraceEntry[] = [];

    // ── 3. Verification mode (single chunk, no pipeline state) ─
    if (isVerification) {
      if (input.batchSize !== 1) {
        throw new Error("Verification mode requires batchSize=1");
      }
      if (!input.debug) {
        throw new Error("Verification mode requires debug=true");
      }

      const chunks = await db.query(
        `SELECT dc.id AS chunk_id, dc.content AS chunk_text,
                dc.file_name AS source_file, d.document_tag
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND dc.id = $2::uuid
         LIMIT 1`,
        z.object({
          chunk_id: z.string(),
          chunk_text: z.string(),
          source_file: z.string(),
          document_tag: z.string().nullable(),
        }),
        [input.dealId, input.verificationChunkId],
        { label: "DcsExtract: fetch verification chunk" },
      );

      if (chunks.length === 0) {
        throw new Error(`Chunk ${input.verificationChunkId} not found for deal ${input.dealId}`);
      }

      const chunk = chunks[0];
      const result = await processOneChunk(
        ctx as unknown as PipelineContext,
        db,
        input.runId,
        chunk,
        startTime,
        true,
      );

      processedThisCall = 1;
      rowsWrittenThisCall = result.rowsWritten;
      emptyChunksThisCall = result.rowsWritten === 0 ? 1 : 0;
      fabricationRejectedThisCall = result.fabricationRejected;
      invalidDimensionRejectedThisCall = result.invalidDimensionRejected;
      duplicateDimensionRejectedThisCall = result.duplicateDimensionRejected;
      if (result.traceEntry) trace.push(result.traceEntry);

      return {
        runId: input.runId,
        mode,
        status: "done",
        processedThisCall,
        cumulativeProcessed: processedThisCall,
        rowsWrittenThisCall,
        cumulativeRowsWritten: rowsWrittenThisCall,
        emptyChunksThisCall,
        fabricationRejectedThisCall,
        invalidDimensionRejectedThisCall,
        duplicateDimensionRejectedThisCall,
        savedCursor: null,
        remainingChunks: 0,
        resumeRequired: false,
        elapsedMs: Date.now() - startTime,
        trace,
      };
    }

    // ── 4. Normal mode: load/create pipeline state ─────────────
    const stateRows = await db.query(
      `SELECT id, status, cursor_value, detail
       FROM dcs_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'extract'
       LIMIT 1`,
      z.object({
        id: z.string(),
        status: z.string(),
        cursor_value: z.string().nullable(),
        detail: z.string().nullable(),
      }),
      [input.runId],
      { label: "DcsExtract: load pipeline state" },
    );

    let stateId: string;
    let cursorValue: string | null;
    let cumulative: CumulativeDetail;

    if (stateRows.length > 0) {
      const state = stateRows[0];
      stateId = state.id;
      cursorValue = state.cursor_value;

      if (state.status === "done") {
        const doneDetail: CumulativeDetail = state.detail
          ? JSON.parse(state.detail)
          : emptyDetail(totalChunks);
        return {
          runId: input.runId,
          mode,
          status: "done",
          processedThisCall: 0,
          cumulativeProcessed: doneDetail.processed_count,
          rowsWrittenThisCall: 0,
          cumulativeRowsWritten: doneDetail.evidence_rows_written,
          emptyChunksThisCall: 0,
          fabricationRejectedThisCall: 0,
          invalidDimensionRejectedThisCall: 0,
          duplicateDimensionRejectedThisCall: 0,
          savedCursor: cursorValue,
          remainingChunks: 0,
          resumeRequired: false,
          elapsedMs: Date.now() - startTime,
          trace,
        };
      }

      // Validate resumeCursor consistency
      if (input.resumeCursor && input.resumeCursor !== cursorValue) {
        throw new Error(
          `resumeCursor mismatch: supplied=${input.resumeCursor} stored=${cursorValue}`,
        );
      }

      cumulative = state.detail ? JSON.parse(state.detail) : emptyDetail(totalChunks);
    } else {
      // First invocation — create state
      if (input.resumeCursor) {
        throw new Error("resumeCursor supplied but no extract state exists for this run");
      }

      const inserted = await db.query(
        `INSERT INTO dcs_pipeline_state (run_id, stage, status, cursor_value, detail)
         VALUES ($1::uuid, 'extract', 'running', NULL, $2)
         RETURNING id`,
        z.object({ id: z.string() }),
        [input.runId, JSON.stringify(emptyDetail(totalChunks))],
        { label: "DcsExtract: create pipeline state" },
      );
      stateId = inserted[0].id;
      cursorValue = null;
      cumulative = emptyDetail(totalChunks);
    }

    // ── 5. Select chunk batch ──────────────────────────────────
    const chunkQuery = cursorValue
      ? `SELECT dc.id AS chunk_id, dc.content AS chunk_text,
                dc.file_name AS source_file, d.document_tag
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND dc.id > $2::uuid
         ORDER BY dc.id ASC
         LIMIT $3`
      : `SELECT dc.id AS chunk_id, dc.content AS chunk_text,
                dc.file_name AS source_file, d.document_tag
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
         ORDER BY dc.id ASC
         LIMIT $2`;

    const chunkParams = cursorValue
      ? [input.dealId, cursorValue, input.batchSize]
      : [input.dealId, input.batchSize];

    const chunks = await db.query(
      chunkQuery,
      z.object({
        chunk_id: z.string(),
        chunk_text: z.string(),
        source_file: z.string(),
        document_tag: z.string().nullable(),
      }),
      chunkParams,
      { label: "DcsExtract: select chunk batch" },
    );

    // ── 6. Process chunks ──────────────────────────────────────
    let finalStatus = "running";

    for (const chunk of chunks) {
      // Time budget check
      const elapsed = Date.now() - startTime;
      const remaining = INVOCATION_BUDGET_MS - elapsed;
      if (remaining < MIN_CALL_HEADROOM_MS) {
        break; // Stop cleanly — cursor is already saved for last completed chunk
      }

      try {
        const result = await processOneChunk(
          ctx as unknown as PipelineContext,
          db,
          input.runId,
          chunk,
          startTime,
          input.debug,
        );

        // Build next-cumulative without mutating current cumulative
        const nextCumulative: CumulativeDetail = {
          ...cumulative,
          processed_count: cumulative.processed_count + 1,
          evidence_rows_written: cumulative.evidence_rows_written + result.rowsWritten,
          empty_chunk_count: cumulative.empty_chunk_count + (result.rowsWritten === 0 ? 1 : 0),
          fabrication_rejected: cumulative.fabrication_rejected + result.fabricationRejected,
          invalid_dimension_rejected: cumulative.invalid_dimension_rejected + result.invalidDimensionRejected,
          duplicate_dimension_rejected: cumulative.duplicate_dimension_rejected + result.duplicateDimensionRejected,
          last_chunk_id: chunk.chunk_id,
        };
        const nextCursor = chunk.chunk_id;

        // Persist checkpoint atomically — cursor and cumulative together
        await db.execute(
          `UPDATE dcs_pipeline_state
           SET cursor_value = $1, detail = $2, status = 'running', updated_at = now()
           WHERE id = $3::uuid`,
          [nextCursor, JSON.stringify(nextCumulative), stateId],
          { label: `DcsExtract: advance cursor to ${chunk.chunk_id.slice(0, 8)}` },
        );

        // Only after successful checkpoint: commit to in-memory state
        cumulative = nextCumulative;
        cursorValue = nextCursor;
        processedThisCall++;
        rowsWrittenThisCall += result.rowsWritten;
        if (result.rowsWritten === 0) emptyChunksThisCall++;
        fabricationRejectedThisCall += result.fabricationRejected;
        invalidDimensionRejectedThisCall += result.invalidDimensionRejected;
        duplicateDimensionRejectedThisCall += result.duplicateDimensionRejected;
        if (result.traceEntry) trace.push(result.traceEntry);
      } catch (err) {
        // On error: set stage to failed, do NOT advance cursor
        const errMsg = err instanceof Error ? err.message : String(err);
        const bounded = errMsg.slice(0, 500);

        await db.execute(
          `UPDATE dcs_pipeline_state
           SET status = 'failed', detail = $1, updated_at = now()
           WHERE id = $2::uuid`,
          [JSON.stringify({ ...cumulative, error: bounded, failed_chunk: chunk.chunk_id }), stateId],
          { label: "DcsExtract: mark extract failed" },
        );

        throw new Error(`DcsExtract failed on chunk ${chunk.chunk_id}: ${bounded}`);
      }
    }

    // ── 7. Check remaining ─────────────────────────────────────
    const remainingResult = await db.query(
      cursorValue
        ? `SELECT COUNT(*)::int AS cnt
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND dc.id > $2::uuid`
        : `SELECT COUNT(*)::int AS cnt
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      cursorValue ? [input.dealId, cursorValue] : [input.dealId],
      { label: "DcsExtract: count remaining chunks" },
    );
    const remainingChunks = remainingResult[0]?.cnt ?? 0;

    if (remainingChunks === 0) {
      finalStatus = "done";
      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'done', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify(cumulative), stateId],
        { label: "DcsExtract: mark extract done" },
      );
    }

    if (mode !== "verification") {
      console.log(`[DcsExtract] run=${input.runId.slice(0, 8)} processed=${processedThisCall} written=${rowsWrittenThisCall} fabricationRejected=${fabricationRejectedThisCall} cursor=${cursorValue ?? "null"} remaining=${remainingChunks} status=${finalStatus}`);
    }

    return {
      runId: input.runId,
      mode,
      status: finalStatus,
      processedThisCall,
      cumulativeProcessed: cumulative.processed_count,
      rowsWrittenThisCall,
      cumulativeRowsWritten: cumulative.evidence_rows_written,
      emptyChunksThisCall,
      fabricationRejectedThisCall,
      invalidDimensionRejectedThisCall,
      duplicateDimensionRejectedThisCall,
      savedCursor: cursorValue,
      remainingChunks,
      resumeRequired: remainingChunks > 0,
      elapsedMs: Date.now() - startTime,
      trace: input.debug ? trace : [],
    };
  },
});

// ═════════════════════════════════════════════════════════════════
// Chunk processor
// ═════════════════════════════════════════════════════════════════
interface ChunkRow {
  chunk_id: string;
  chunk_text: string;
  source_file: string;
  document_tag: string | null;
}

interface ChunkResult {
  rowsWritten: number;
  fabricationRejected: number;
  invalidDimensionRejected: number;
  duplicateDimensionRejected: number;
  traceEntry: TraceEntry | null;
}

async function processOneChunk(
  pipelineCtx: PipelineContext,
  db: any,
  runId: string,
  chunk: ChunkRow,
  invocationStartTime: number,
  debug: boolean,
): Promise<ChunkResult> {
  const storedTag = chunk.document_tag ?? "other";
  const docClass = classifyDocClass(storedTag);

  // ── LLM call ─────────────────────────────────────────────────
  const model = getModuleModel("diligence_completeness");

  const elapsed = Date.now() - invocationStartTime;
  const remaining = INVOCATION_BUDGET_MS - elapsed;
  const callTimeout = Math.min(MAX_PER_CALL_MS, remaining - 15_000);

  const llmResponse = await callLLMWithHeadroom(
    pipelineCtx,
    {
      model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `CHUNK TEXT:\n\n${chunk.chunk_text}`,
        },
      ],
    },
    `DcsExtract: chunk ${chunk.chunk_id.slice(0, 8)} (${chunk.source_file})`,
    {
      pipelineStartTime: invocationStartTime,
      maxPerCallTimeout: callTimeout,
      retries: 1,
      minBudget: MIN_CALL_HEADROOM_MS,
    },
  );

  // ── Parse response ───────────────────────────────────────────
  const rawText = llmResponse.content[0]?.text ?? "";

  // Strict whole-response JSON parsing with exact fence normalization.
  // Accepts: (1) a raw JSON array, (2) one complete Markdown code fence
  // (``` or ```json, case-insensitive) wrapping a JSON array, occupying the
  // entire response. Rejects prose before/after fences, non-json language
  // tags, multiple fenced blocks, internal fences, and malformed JSON.
  // Does NOT search for brackets inside arbitrary text.
  let jsonToParse: string;
  const trimmed = rawText.trim();

  if (trimmed.startsWith("[")) {
    // Raw JSON array — accept directly
    jsonToParse = trimmed;
  } else if (trimmed.startsWith("```")) {
    // Potential single full-response Markdown fence
    const closingIdx = trimmed.lastIndexOf("```");
    if (closingIdx <= 3) {
      // No separate closing fence found
      throw new Error(
        `Invalid response for chunk ${chunk.chunk_id}: opening fence without closing fence. Raw: ${trimmed.slice(0, 200)}`,
      );
    }
    // Extract opening fence line
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline === -1) {
      throw new Error(
        `Invalid response for chunk ${chunk.chunk_id}: fence on single line. Raw: ${trimmed.slice(0, 200)}`,
      );
    }
    const openingLine = trimmed.slice(3, firstNewline).trim().toLowerCase();
    // Accept no language tag or "json" only
    if (openingLine !== "" && openingLine !== "json") {
      throw new Error(
        `Invalid response for chunk ${chunk.chunk_id}: unsupported fence language tag '${openingLine}'. Raw: ${trimmed.slice(0, 200)}`,
      );
    }
    // Closing fence must be at the very end
    const afterClose = trimmed.slice(closingIdx + 3).trim();
    if (afterClose !== "") {
      throw new Error(
        `Invalid response for chunk ${chunk.chunk_id}: content after closing fence. Raw: ${trimmed.slice(0, 200)}`,
      );
    }
    // Extract content between fences
    const enclosed = trimmed.slice(firstNewline + 1, closingIdx);
    // Check for internal fences (multiple blocks)
    if (enclosed.includes("```")) {
      throw new Error(
        `Invalid response for chunk ${chunk.chunk_id}: multiple fence blocks detected. Raw: ${trimmed.slice(0, 200)}`,
      );
    }
    jsonToParse = enclosed.trim();
  } else {
    // Neither raw JSON array nor fenced — reject
    throw new Error(
      `Invalid response for chunk ${chunk.chunk_id}: response is not a JSON array or single fenced block. Raw: ${trimmed.slice(0, 200)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonToParse);
  } catch {
    // Fallback: attempt to repair unescaped quotes inside JSON string values.
    // The model sometimes embeds CSV-quoted numbers (e.g. "47,014") inside
    // snippet strings without escaping the inner quotes.
    // Strategy: replace inner unescaped quotes that are not at structural
    // positions (after : or , or at array/object boundaries) with escaped quotes.
    try {
      // Character-by-character scanner for snippet values: finds each
      // "snippet":"..." and escapes inner quotes that are not structural
      // (i.e. not followed by , or } which would mark the value boundary).
      let fixed = "";
      let i = 0;
      while (i < jsonToParse.length) {
        const snippetKey = '"snippet"';
        const keyIdx = jsonToParse.indexOf(snippetKey, i);
        if (keyIdx === -1) {
          fixed += jsonToParse.slice(i);
          break;
        }
        fixed += jsonToParse.slice(i, keyIdx + snippetKey.length);
        i = keyIdx + snippetKey.length;
        // Skip whitespace and colon
        while (i < jsonToParse.length && (jsonToParse[i] === ' ' || jsonToParse[i] === ':')) {
          fixed += jsonToParse[i];
          i++;
        }
        if (i >= jsonToParse.length || jsonToParse[i] !== '"') continue;
        // Opening quote of snippet value
        fixed += '"';
        i++;
        // Scan to find the real closing quote: it must be followed by , or } (after optional whitespace)
        let value = "";
        while (i < jsonToParse.length) {
          if (jsonToParse[i] === '\\') {
            value += jsonToParse[i] + (jsonToParse[i + 1] ?? "");
            i += 2;
            continue;
          }
          if (jsonToParse[i] === '"') {
            // Check if this quote is the structural close: next non-whitespace must be , or }
            let peek = i + 1;
            while (peek < jsonToParse.length && jsonToParse[peek] === ' ') peek++;
            if (peek >= jsonToParse.length || jsonToParse[peek] === ',' || jsonToParse[peek] === '}') {
              // This is the real closing quote
              break;
            }
            // Inner unescaped quote — escape it
            value += '\\"';
            i++;
            continue;
          }
          value += jsonToParse[i];
          i++;
        }
        fixed += value + '"';
        if (i < jsonToParse.length) i++; // skip the closing quote
      }
      parsed = JSON.parse(fixed);
    } catch {
      throw new Error(
        `Invalid JSON in response for chunk ${chunk.chunk_id}: ${jsonToParse.slice(0, 200)}`,
      );
    }
  }

  // Validate the entire response as an array of PresenceItem in one pass.
  // Any item with a missing field or wrong type fails the whole chunk.
  const arrayResult = z.array(PresenceItem).safeParse(parsed);
  if (!arrayResult.success) {
    throw new Error(
      `Schema validation failed for chunk ${chunk.chunk_id}: ${arrayResult.error.message.slice(0, 300)}`,
    );
  }

  const items = arrayResult.data;

  // Post-schema validation: dimension IDs, literal anchoring, dedup
  const validItems: PresenceItem[] = [];
  const rejected: Array<{ item: unknown; reason: string }> = [];
  let fabricationRejected = 0;
  let invalidDimensionRejected = 0;
  let duplicateDimensionRejected = 0;

  for (const item of items) {

    // Validate dimension_id
    if (!VALID_DIMENSION_IDS.has(item.dimension_id)) {
      invalidDimensionRejected++;
      rejected.push({ item, reason: `invalid_dimension: ${item.dimension_id}` });
      continue;
    }

    // ── Literal anchoring gate ──────────────────────────────────
    const normalizedSnippet = normalizeWs(item.snippet);
    if (normalizedSnippet.length === 0) {
      fabricationRejected++;
      rejected.push({ item, reason: "empty_snippet" });
      continue;
    }

    const normalizedChunkText = normalizeWs(chunk.chunk_text);
    if (!normalizedChunkText.includes(normalizedSnippet)) {
      fabricationRejected++;
      rejected.push({ item, reason: "snippet_not_in_chunk: literal anchoring failed" });
      continue;
    }

    validItems.push(item);
  }

  // ── Deduplicate by dimension_id ──────────────────────────────
  const seen = new Map<string, PresenceItem>();
  for (const item of validItems) {
    const existing = seen.get(item.dimension_id);
    if (!existing) {
      seen.set(item.dimension_id, item);
    } else {
      duplicateDimensionRejected++;
      // Keep substantive over non-substantive; otherwise keep first
      if (item.is_substantive && !existing.is_substantive) {
        rejected.push({
          item: existing,
          reason: `duplicate_dimension: replaced by substantive item`,
        });
        seen.set(item.dimension_id, item);
      } else {
        rejected.push({
          item,
          reason: `duplicate_dimension: ${item.dimension_id} already present`,
        });
      }
    }
  }

  const accepted = Array.from(seen.values());

  return buildResult(
    db,
    runId,
    chunk,
    storedTag,
    docClass,
    accepted,
    rawText,
    debug,
    rejected,
    fabricationRejected,
    invalidDimensionRejected,
    duplicateDimensionRejected,
  );
}

// ── Build result: delete-before-insert, return stats ────────────
async function buildResult(
  db: any,
  runId: string,
  chunk: ChunkRow,
  storedTag: string,
  docClass: string,
  accepted: PresenceItem[],
  rawResponse: string,
  debug: boolean,
  rejected: Array<{ item: unknown; reason: string }> = [],
  fabricationRejected = 0,
  invalidDimensionRejected = 0,
  duplicateDimensionRejected = 0,
): Promise<ChunkResult> {
  // ── Replay safety: delete existing rows for this run+chunk ───
  await db.execute(
    `DELETE FROM dcs_evidence WHERE run_id = $1::uuid AND chunk_id = $2`,
    [runId, chunk.chunk_id],
    { label: `DcsExtract: replay-delete chunk ${chunk.chunk_id.slice(0, 8)}` },
  );

  // ── Insert accepted rows ─────────────────────────────────────
  for (const item of accepted) {
    await db.execute(
      `INSERT INTO dcs_evidence
         (run_id, dimension_id, chunk_id, source_file, document_tag, doc_class, is_substantive, snippet)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [
        runId,
        item.dimension_id,
        chunk.chunk_id,
        chunk.source_file,
        storedTag,
        docClass,
        item.is_substantive,
        item.snippet,
      ],
      { label: `DcsExtract: insert evidence ${item.dimension_id} for chunk ${chunk.chunk_id.slice(0, 8)}` },
    );
  }

  // ── Build trace entry ────────────────────────────────────────
  let traceEntry: TraceEntry | null = null;
  if (debug) {
    traceEntry = {
      chunk_id: chunk.chunk_id,
      source_file: chunk.source_file,
      document_tag: storedTag,
      doc_class: docClass,
      raw_model_response: rawResponse,
      accepted: accepted.map((a) => ({
        dimension_id: a.dimension_id,
        snippet: a.snippet,
        is_substantive: a.is_substantive,
        doc_class: docClass,
      })),
      rejected: rejected.map((r) => ({
        dimension_id:
          r.item && typeof r.item === "object" && "dimension_id" in r.item
            ? String((r.item as Record<string, unknown>).dimension_id)
            : "unknown",
        snippet:
          r.item && typeof r.item === "object" && "snippet" in r.item
            ? String((r.item as Record<string, unknown>).snippet)
            : "",
        is_substantive:
          r.item && typeof r.item === "object" && "is_substantive" in r.item
            ? Boolean((r.item as Record<string, unknown>).is_substantive)
            : false,
        reason: r.reason,
      })),
    };
  }

  return {
    rowsWritten: accepted.length,
    fabricationRejected,
    invalidDimensionRejected,
    duplicateDimensionRejected,
    traceEntry,
  };
}
