/**
 * Diagnostic API: Run structured claim extraction on a deal's IC memos.
 *
 * Persist-and-resume harness for Stage 0 verification of the claims-reconciliation loop.
 * Persists the accumulated ledger to `diag_claims_ledger` after each memo completes,
 * so orchestrator timeouts do not discard completed work.
 *
 * Returns a pointer (counts + status), not the payload. Read back with DiagD1Query.
 *
 * Does NOT write to module_runs, module_outputs, or pipeline_checkpoints.
 * Does NOT trigger a pipeline run — safe to execute without consent gate.
 *
 * DDL (auto-created):
 *   CREATE TABLE IF NOT EXISTS diag_claims_ledger (
 *     deal_id UUID PRIMARY KEY,
 *     ledger JSONB NOT NULL DEFAULT '{}',
 *     memos_completed TEXT[] NOT NULL DEFAULT '{}',
 *     total_claims INTEGER NOT NULL DEFAULT 0,
 *     complete BOOLEAN NOT NULL DEFAULT FALSE,
 *     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS diag_claims_events (
 *     id SERIAL PRIMARY KEY,
 *     deal_id UUID NOT NULL,
 *     event_type TEXT NOT NULL,
 *     memo_file TEXT,
 *     ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     elapsed_ms INTEGER,
 *     output_tokens INTEGER,
 *     detail JSONB
 *   );
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runClaimsExtraction, parseClaimsResponse, CLAIMS_EXTRACTION_PROMPT, type ClaimsLedger, type ChunkCompleteEvent } from "./claims-extraction.js";
import { MessageResponseSchema } from "./call-llm.js";
import { SONNET_MODEL } from "./model-config.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "DiagClaimsExtraction",
  description: "Run structured claim extraction on IC memos with persist-and-resume",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    // Optional: filter to specific document IDs. If null, processes all ic_memo docs.
    // Unlike the prior version, this ONLY controls which memos are processed —
    // non-target memos remain as "pending", NOT marked as completed.
    documentIds: z.array(z.string()).nullable(),
    // Optional: max memos to process this invocation. If null, processes all pending.
    maxWorkUnits: z.number().nullable(),
    // Reset: if true, deletes existing persisted ledger and starts fresh.
    reset: z.boolean().nullable(),
    // Skip qualitative extraction pass (halves LLM budget per memo).
    // Now wired through to ClaimsExtractionOptions.skipQualitative.
    skipQualitative: z.boolean().nullable(),
    // Density test: when set, truncates the FIRST target memo's parsed_text
    // to this many characters and runs a direct LLM call (bypasses runClaimsExtraction).
    // Does NOT persist to ledger. Requires exactly 1 documentIds entry.
    maxInputChars: z.number().nullable(),
    // Chunk filter: when set, extracts ONLY these chunk indices and merges
    // results into the existing ledger. Used for targeted re-extraction of
    // specific chunks (e.g. after a fix). Requires exactly 1 documentIds entry.
    chunkIndices: z.array(z.number()).nullable(),
  }),

  output: z.object({
    // Status pointer — not the payload
    complete: z.boolean(),
    total_claims: z.number(),
    memos_completed: z.array(z.string()),
    memos_pending: z.array(z.string()),
    // Per-memo timing from this invocation (only memos processed in THIS call)
    this_invocation: z.object({
      memos_processed: z.number(),
      wall_clock_ms: z.number(),
      per_memo: z.array(z.object({
        file_name: z.string(),
        status: z.string(),
        claims_count: z.number(),
        error: z.string().nullable(),
      })),
    }),
    // Category breakdown (full ledger)
    category_counts: z.object({
      operating_metric: z.number(),
      deal_mechanics: z.number(),
      valuation_structuring: z.number(),
      returns_projection: z.number(),
      cross_reference: z.number(),
      total: z.number(),
      docs_processed: z.number(),
    }),
    // Obstacle report (non-empty if skipQualitative requested but impossible)
    obstacles: z.array(z.string()),
  }),

  async run(ctx, { dealId, documentIds, maxWorkUnits, reset, skipQualitative, maxInputChars, chunkIndices }) {
    const startTime = Date.now();
    const obstacles: string[] = [];

    // =========================================================================
    // DENSITY TEST PATH — direct LLM call with truncated text, no persist
    // =========================================================================
    if (maxInputChars !== null && maxInputChars !== undefined && maxInputChars > 0) {
      if (!documentIds || documentIds.length !== 1) {
        throw new Error("maxInputChars requires exactly 1 documentIds entry");
      }
      const targetDocId = documentIds[0];

      // Load the memo's parsed_text
      const memoRows = await ctx.integrations.db.query(
        `SELECT id, file_name, parsed_text FROM documents WHERE id = $1 AND parsed_text IS NOT NULL LIMIT 1`,
        z.object({ id: z.string(), file_name: z.string(), parsed_text: z.string() }),
        [targetDocId],
        { label: "DiagCE density: load memo" },
      );
      if (memoRows.length === 0) {
        throw new Error(`Document ${targetDocId} not found or has no parsed_text`);
      }
      const memo = memoRows[0];
      const fullLen = memo.parsed_text.length;
      const slicedText = memo.parsed_text.slice(0, maxInputChars);

      console.log(
        `[DiagCE density] "${memo.file_name}": ${fullLen} chars total, sliced to ${slicedText.length} chars`
      );

      // Use the canonical extraction prompt (now exported from claims-extraction.ts)
      const systemPrompt = CLAIMS_EXTRACTION_PROMPT;

      const llmBody = {
        model: SONNET_MODEL,
        max_tokens: 16_384,
        temperature: 0,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `## Document: ${memo.file_name}\n\nExtract all quantitative financial claims from this IC memo:\n\n${slicedText}`,
          },
        ],
      };

      const llmStart = Date.now();
      const response = await ctx.integrations.ai.apiRequest(
        { method: "POST", path: "/v1/messages", body: llmBody },
        { response: MessageResponseSchema },
        { label: `DiagCE density: ${memo.file_name} (${maxInputChars} chars)` },
      );
      const llmElapsed = Date.now() - llmStart;

      const responseText = response.content[0]?.text ?? "";
      const parseResult = parseClaimsResponse(responseText, memo.file_name);

      const outputTruncated = response.stop_reason === "max_tokens";
      const outputTokens = response.usage.output_tokens;
      const inputTokens = response.usage.input_tokens;

      console.log(
        `[DiagCE density] Result: ${parseResult.claims.length} claims, ` +
        `output_truncated=${outputTruncated}, output_tokens=${outputTokens}, ` +
        `input_tokens=${inputTokens}, llm_ms=${llmElapsed}, ` +
        `density=${(parseResult.claims.length / maxInputChars * 1000).toFixed(1)} claims/1K chars`
      );

      // Log to diag_claims_events for the record
      await ctx.integrations.db.query(
        `CREATE TABLE IF NOT EXISTS diag_claims_events (
          id SERIAL PRIMARY KEY, deal_id UUID NOT NULL, event_type TEXT NOT NULL,
          memo_file TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          elapsed_ms INTEGER, output_tokens INTEGER, detail JSONB
        )`,
        z.any(), [], { label: "DiagCE density: ensure events table" },
      );
      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_events (deal_id, event_type, memo_file, elapsed_ms, output_tokens, detail)
         VALUES ($1, 'density_test', $2, $3, $4, $5::jsonb)`,
        z.any(),
        [
          dealId, memo.file_name, llmElapsed, outputTokens,
          JSON.stringify({
            maxInputChars,
            input_chars: slicedText.length,
            full_chars: fullLen,
            input_tokens: inputTokens,
            output_truncated: outputTruncated,
            claims_count: parseResult.claims.length,
            parse_failed: parseResult.failed,
            density_per_1k: parseResult.claims.length / maxInputChars * 1000,
          }),
        ],
        { label: "DiagCE density: log event" },
      );

      // Return via the standard output shape (fill unused fields with zeros)
      const cats = { operating_metric: 0, deal_mechanics: 0, valuation_structuring: 0, returns_projection: 0, cross_reference: 0 };
      for (const c of parseResult.claims) {
        const cat = (c as any).claim_category as string;
        if (cat in cats) (cats as any)[cat]++;
      }

      return {
        complete: !outputTruncated,
        total_claims: parseResult.claims.length,
        memos_completed: outputTruncated ? [] : [memo.file_name],
        memos_pending: outputTruncated ? [memo.file_name] : [],
        this_invocation: {
          memos_processed: 1,
          wall_clock_ms: Date.now() - startTime,
          per_memo: [{
            file_name: memo.file_name,
            status: outputTruncated ? "output_truncated" : "success",
            claims_count: parseResult.claims.length,
            error: parseResult.failed ? (parseResult.error ?? "parse error") : null,
          }],
        },
        category_counts: {
          ...cats,
          total: parseResult.claims.length,
          docs_processed: 1,
        },
        obstacles: outputTruncated
          ? [`OUTPUT TRUNCATED at ${outputTokens} tokens — density may exceed ${maxInputChars} chars`]
          : [],
      };
    }
    // =========================================================================
    // END DENSITY TEST PATH
    // =========================================================================

    // --- Ensure tables exist (idempotent) ---
    await ctx.integrations.db.query(
      `CREATE TABLE IF NOT EXISTS diag_claims_ledger (
        deal_id UUID PRIMARY KEY,
        ledger JSONB NOT NULL DEFAULT '{}',
        memos_completed TEXT[] NOT NULL DEFAULT '{}',
        total_claims INTEGER NOT NULL DEFAULT 0,
        complete BOOLEAN NOT NULL DEFAULT FALSE,
        chunk_cursor JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      z.any(),
      [],
      { label: "DiagCE: ensure ledger table" },
    );

    // Add chunk_cursor column if missing (for existing tables)
    await ctx.integrations.db.query(
      `ALTER TABLE diag_claims_ledger ADD COLUMN IF NOT EXISTS chunk_cursor JSONB NOT NULL DEFAULT '{}'`,
      z.any(),
      [],
      { label: "DiagCE: ensure chunk_cursor column" },
    );

    await ctx.integrations.db.query(
      `CREATE TABLE IF NOT EXISTS diag_claims_events (
        id SERIAL PRIMARY KEY,
        deal_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        memo_file TEXT,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        elapsed_ms INTEGER,
        output_tokens INTEGER,
        detail JSONB
      )`,
      z.any(),
      [],
      { label: "DiagCE: ensure events table" },
    );

    // --- Log invocation start ---
    await ctx.integrations.db.query(
      `INSERT INTO diag_claims_events (deal_id, event_type, detail)
       VALUES ($1, 'invocation_start', $2::jsonb)`,
      z.any(),
      [dealId, JSON.stringify({ documentIds, maxWorkUnits, reset, skipQualitative, startTime: new Date(startTime).toISOString() })],
      { label: "DiagCE: log start" },
    );

    // --- Reset if requested ---
    if (reset) {
      await ctx.integrations.db.query(
        `DELETE FROM diag_claims_ledger WHERE deal_id = $1`,
        z.any(),
        [dealId],
        { label: "DiagCE: reset ledger" },
      );
    }

    // --- Load prior ledger from persistence ---
    const priorRows = await ctx.integrations.db.query(
      `SELECT ledger, memos_completed, complete, chunk_cursor FROM diag_claims_ledger WHERE deal_id = $1 LIMIT 1`,
      z.object({
        ledger: z.any(),
        memos_completed: z.array(z.string()),
        complete: z.boolean(),
        chunk_cursor: z.any(),
      }),
      [dealId],
      { label: "DiagCE: load prior ledger" },
    );

    let priorLedger: ClaimsLedger | undefined;
    let chunkCursor: Record<string, number[]> = {};
    let persistedMemosCompleted: string[] = [];
    let missingCompletedFileNames: string[] = [];
    if (priorRows.length > 0 && priorRows[0].ledger && priorRows[0].ledger.claims) {
      priorLedger = priorRows[0].ledger as ClaimsLedger;
      chunkCursor = (priorRows[0].chunk_cursor as Record<string, number[]>) ?? {};
      persistedMemosCompleted = priorRows[0].memos_completed ?? [];
      console.log(`[DiagCE] Loaded chunk cursor: ${Object.keys(chunkCursor).length} memo(s) with progress`);
      console.log(`[DiagCE] Persisted memos_completed: [${persistedMemosCompleted.join(", ")}]`);

      // Inject synthetic "success" entries — deferred until after allMemos query
      // (needs filename→UUID mapping). Flag for later injection.
      const existingTerminalFiles = new Set(priorLedger.terminal_results.map(t => t.file_name));
      missingCompletedFileNames = persistedMemosCompleted.filter(f => !existingTerminalFiles.has(f));
      // NOTE: Do NOT early-return based on stored `complete` flag.
      // The stored flag reflects a PREVIOUS call's target set. The current
      // call may have a different documentIds target set that hasn't been
      // processed yet. Completion is checked AFTER extraction against the
      // current target set.

      // Strip "filtered_out" entries for memos that are NOW targets.
      // A prior filtered run may have marked them as "filtered_out", but the
      // current call wants them processed. Remove those entries so
      // runClaimsExtraction sees them as pending.
      if (documentIds && documentIds.length > 0) {
        const currentTargets = new Set(documentIds);
        priorLedger.terminal_results = priorLedger.terminal_results.filter(
          t => !(currentTargets.has(t.memo_id) && (t.status as string) === "filtered_out")
        );
      }
    }

    // --- Reconstruction: if cursor is full but ledger has 0 claims, rebuild from events ---
    // This handles the case where orchestrator timeout killed the process after all chunks
    // completed but before the final ledger persist. Claims were saved per-chunk in events.
    if (priorRows.length > 0 && chunkCursor && Object.keys(chunkCursor).length > 0) {
      const ledgerClaims = (priorLedger?.claims ?? []).length;
      if (ledgerClaims === 0) {
        // Check if any target memo has a full cursor but no claims in ledger
        const targetMemoIdsForRecon = documentIds && documentIds.length > 0
          ? documentIds
          : Object.keys(chunkCursor);

        for (const memoId of targetMemoIdsForRecon) {
          const cursorChunks = chunkCursor[memoId] ?? [];
          if (cursorChunks.length > 0) {
            console.log(
              `[DiagCE] Reconstruction: memo ${memoId} has ${cursorChunks.length} chunks in cursor but 0 claims in ledger. Attempting rebuild from events.`
            );

            // Load persisted chunk_claims events for this deal+memo (deduplicate by chunk_index, keep latest)
            const chunkEvents = await ctx.integrations.db.query(
              `SELECT DISTINCT ON ((detail->>'chunk_index')::int) detail
               FROM diag_claims_events
               WHERE deal_id = $1 AND event_type = 'chunk_claims' AND detail->>'memo_id' = $2
               ORDER BY (detail->>'chunk_index')::int ASC, ts DESC`,
              z.object({ detail: z.any() }),
              [dealId, memoId],
              { label: `DiagCE: load chunk_claims events for reconstruction (${memoId})` },
            );

            if (chunkEvents.length > 0) {
              console.log(`[DiagCE] Found ${chunkEvents.length} persisted chunk events for reconstruction`);

              // Reconstruct claims and chunk results
              const reconstructedClaims: any[] = [];
              const reconstructedChunkResults: any[] = [];
              let anyTruncated = false;
              let totalTokens = 0;
              let anyParseEmpty = false;

              for (const evt of chunkEvents) {
                const d = evt.detail;
                if (d.claims && Array.isArray(d.claims)) {
                  reconstructedClaims.push(...d.claims);
                }
                reconstructedChunkResults.push({
                  index: d.chunk_index,
                  charStart: d.char_start,
                  charEnd: d.char_end,
                  claims: d.claims_count ?? 0,
                  output_tokens: d.output_tokens ?? 0,
                  output_truncated: d.output_truncated ?? false,
                  elapsed_ms: d.elapsed_ms ?? 0,
                  parse_recovered_empty: d.parse_recovered_empty ?? false,
                });
                if (d.output_truncated) anyTruncated = true;
                if (d.parse_recovered_empty) anyParseEmpty = true;
                totalTokens += (d.output_tokens ?? 0);
              }

              // Look up file_name for this memo
              const memoNameRows = await ctx.integrations.db.query(
                `SELECT file_name FROM documents WHERE id = $1 LIMIT 1`,
                z.object({ file_name: z.string() }),
                [memoId],
                { label: `DiagCE: lookup memo filename for reconstruction` },
              );
              const memoFileName = memoNameRows.length > 0 ? memoNameRows[0].file_name : memoId;

              // Build a reconstructed ledger
              const status = anyTruncated ? "partial" : "success";
              priorLedger = {
                claims: reconstructedClaims,
                complete: true,
                terminal_results: [{
                  memo_id: memoId,
                  file_name: memoFileName,
                  status,
                  claims_count: reconstructedClaims.length,
                  output_truncated: anyTruncated,
                  output_tokens: totalTokens,
                  chunk_results: reconstructedChunkResults,
                }],
                extraction_metadata: {
                  docs_processed: 1,
                  pending: 0,
                  total_claims: reconstructedClaims.length,
                  operating_metric_claims: reconstructedClaims.filter((c: any) => c.claim_category === "operating_metric").length,
                  deal_mechanics_claims: reconstructedClaims.filter((c: any) => c.claim_category === "deal_mechanics").length,
                  valuation_structuring_claims: reconstructedClaims.filter((c: any) => c.claim_category === "valuation_structuring").length,
                  returns_projection_claims: reconstructedClaims.filter((c: any) => c.claim_category === "returns_projection").length,
                  cross_reference_claims: reconstructedClaims.filter((c: any) => c.claim_category === "cross_reference").length,
                  extraction_model: SONNET_MODEL,
                  extraction_timestamp: new Date().toISOString(),
                },
              };
              persistedMemosCompleted = [memoFileName];

              console.log(
                `[DiagCE] Reconstruction complete: ${reconstructedClaims.length} claims, ` +
                `${chunkEvents.length} chunks, truncated=${anyTruncated}, parseEmpty=${anyParseEmpty}`
              );

              // Persist the reconstructed ledger immediately
              await ctx.integrations.db.query(
                `INSERT INTO diag_claims_ledger (deal_id, ledger, memos_completed, total_claims, complete, chunk_cursor, updated_at)
                 VALUES ($1, $2::jsonb, $3::text[], $4, $5, $6::jsonb, NOW())
                 ON CONFLICT (deal_id)
                 DO UPDATE SET ledger = $2::jsonb, memos_completed = $3::text[], total_claims = $4, complete = $5, chunk_cursor = $6::jsonb, updated_at = NOW()`,
                z.any(),
                [dealId, JSON.stringify(priorLedger), persistedMemosCompleted, reconstructedClaims.length, true, JSON.stringify(chunkCursor)],
                { label: "DiagCE: persist reconstructed ledger" },
              );

              // Return immediately — no need to re-extract
              const meta = priorLedger.extraction_metadata;
              return {
                complete: true,
                total_claims: meta.total_claims,
                memos_completed: persistedMemosCompleted,
                memos_pending: [],
                this_invocation: {
                  memos_processed: 1,
                  wall_clock_ms: Date.now() - startTime,
                  per_memo: [{
                    file_name: memoFileName,
                    status,
                    claims_count: reconstructedClaims.length,
                    error: null,
                  }],
                },
                category_counts: {
                  operating_metric: meta.operating_metric_claims,
                  deal_mechanics: meta.deal_mechanics_claims,
                  valuation_structuring: meta.valuation_structuring_claims,
                  returns_projection: meta.returns_projection_claims,
                  cross_reference: meta.cross_reference_claims,
                  total: meta.total_claims,
                  docs_processed: meta.docs_processed,
                },
                obstacles: anyTruncated ? ["RECONSTRUCTED: some chunks had output_truncated=true"] : [],
              };
            } else {
              // No events found — cursor is stale. Clear it and force re-extraction.
              console.log(`[DiagCE] No chunk_claims events found for ${memoId}. Clearing cursor to force re-extraction.`);
              delete chunkCursor[memoId];
              await ctx.integrations.db.query(
                `UPDATE diag_claims_ledger SET chunk_cursor = $1::jsonb, updated_at = NOW() WHERE deal_id = $2`,
                z.any(),
                [JSON.stringify(chunkCursor), dealId],
                { label: "DiagCE: clear stale cursor" },
              );
            }
          }
        }
      }
    }

    // --- Construct pipeline context ---
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // --- documentIds filter (FIXED: no longer marks non-targets as "completed") ---
    // Strategy: Load which memos exist. If documentIds is provided, only pass those
    // as "pending" in the priorLedger — but DON'T mark non-targets as "success".
    // Instead, we exclude non-targets from the extraction by marking them as "pending"
    // in a synthetic priorLedger that runClaimsExtraction will skip via maxWorkUnits.
    //
    // Actually: runClaimsExtraction selects ALL ic_memo docs and only processes
    // those NOT in priorLedger.terminal_results with status !== "pending".
    // We cannot prevent it from loading them. What we CAN do:
    //   - Use priorLedger to retain already-extracted claims
    //   - Use maxWorkUnits to limit how many new memos are processed
    //   - Filter AFTER: Only count memos in documentIds as contributing to "complete"
    //
    // The correct approach: do NOT synthesize terminal_results for non-target memos.
    // Let runClaimsExtraction see all memos as pending, but cap via maxWorkUnits.
    // Then, in the persist step, only mark memos that actually got extracted as
    // "completed". Non-target memos remain pending in the ledger.
    //
    // Wait — that means non-target memos stay "pending" forever and complete never
    // becomes true. That's correct for a filtered run: you asked for specific memos,
    // the rest remain unprocessed.
    //
    // For additive runs (no documentIds): all memos are targets. maxWorkUnits controls
    // how many get processed per invocation. complete = all targets done.

    // Determine effective target set
    const allMemos = await ctx.integrations.db.query(
      `SELECT id, file_name FROM documents
       WHERE deal_id = $1 AND document_tag = 'ic_memo' AND parsed_text IS NOT NULL
       ORDER BY uploaded_at ASC`,
      z.object({ id: z.string(), file_name: z.string() }),
      [dealId],
      { label: "DiagCE: load memo list" },
    );

    // Deferred injection: now that we have filename→UUID mapping, inject
    // synthetic "success" entries for memos completed in prior invocations
    // but missing from the ledger's terminal_results (overwrite bug).
    if (priorLedger && missingCompletedFileNames.length > 0) {
      const fileNameToId = new Map(allMemos.map(m => [m.file_name, m.id]));
      for (const fileName of missingCompletedFileNames) {
        const memoId = fileNameToId.get(fileName);
        if (memoId) {
          priorLedger.terminal_results.push({
            memo_id: memoId,
            file_name: fileName,
            status: "success",
            claims_count: 0,
          });
          console.log(`[DiagCE] Recovered completed memo: "${fileName}" (${memoId})`);
        }
      }
    }

    const targetIds = documentIds && documentIds.length > 0
      ? new Set(documentIds)
      : new Set(allMemos.map(m => m.id)); // all memos are targets if no filter

    // For documentIds filtering: mark NON-target memos in priorLedger so
    // runClaimsExtraction skips them. BUT use a special status that we strip
    // from "memos_completed" in the output — "filtered_out" treated same as
    // "success" by runClaimsExtraction (any non-"pending" status = skip).
    if (documentIds && documentIds.length > 0) {
      const excludedMemos = allMemos.filter(m => !targetIds.has(m.id));
      if (excludedMemos.length > 0) {
        if (!priorLedger) {
          priorLedger = {
            claims: [],
            complete: false,
            terminal_results: [],
            extraction_metadata: {
              docs_processed: 0,
              pending: 0,
              total_claims: 0,
              operating_metric_claims: 0,
              deal_mechanics_claims: 0,
              valuation_structuring_claims: 0,
              returns_projection_claims: 0,
              cross_reference_claims: 0,
              extraction_model: "",
              extraction_timestamp: new Date().toISOString(),
            },
          };
        }
        const existingIds = new Set(priorLedger.terminal_results.map(t => t.memo_id));
        for (const memo of excludedMemos) {
          if (!existingIds.has(memo.id)) {
            priorLedger.terminal_results.push({
              memo_id: memo.id,
              file_name: memo.file_name,
              status: "filtered_out" as any, // Non-"pending" → skipped by runClaimsExtraction
              claims_count: 0,
            });
          }
        }
      }
    }

    // --- Log pre-extraction ---
    const preExtractionTs = Date.now();
    await ctx.integrations.db.query(
      `INSERT INTO diag_claims_events (deal_id, event_type, elapsed_ms, detail)
       VALUES ($1, 'pre_extraction', $2, $3::jsonb)`,
      z.any(),
      [dealId, preExtractionTs - startTime, JSON.stringify({ targets: allMemos.filter(m => targetIds.has(m.id)).map(m => m.file_name) })],
      { label: "DiagCE: log pre-extraction" },
    );

    // --- Run extraction ---
    const effectiveMaxWork = maxWorkUnits ?? 1;

    // onChunkComplete callback: persist chunk cursor AND claims after each chunk resolves
    const onChunkComplete = async (event: ChunkCompleteEvent): Promise<void> => {
      // Update in-memory cursor
      if (!chunkCursor[event.memoId]) {
        chunkCursor[event.memoId] = [];
      }
      chunkCursor[event.memoId].push(event.chunkIndex);

      // Persist chunk claims + result to events table (for reconstruction on timeout)
      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_events (deal_id, event_type, memo_file, elapsed_ms, output_tokens, detail)
         VALUES ($1, 'chunk_claims', $2, $3, $4, $5::jsonb)`,
        z.any(),
        [
          dealId, event.memoFileName, event.chunkResult.elapsed_ms, event.chunkResult.output_tokens,
          JSON.stringify({
            memo_id: event.memoId,
            chunk_index: event.chunkIndex,
            char_start: event.chunkResult.charStart,
            char_end: event.chunkResult.charEnd,
            claims_count: event.chunkClaims.length,
            output_truncated: event.chunkResult.output_truncated,
            parse_recovered_empty: event.chunkResult.parse_recovered_empty ?? false,
            needs_subdivide: event.chunkResult.needs_subdivide ?? false,
            claims: event.chunkClaims,
          }),
        ],
        { label: `DiagCE: persist chunk claims (${event.memoFileName} chunk ${event.chunkIndex})` },
      );

      // Also persist cursor alongside claims (so reconstruction + resume both work)
      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_ledger (deal_id, chunk_cursor, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (deal_id)
         DO UPDATE SET chunk_cursor = $2::jsonb, updated_at = NOW()`,
        z.any(),
        [dealId, JSON.stringify(chunkCursor)],
        { label: `DiagCE: persist chunk cursor (${event.memoFileName} chunk ${event.chunkIndex})` },
      );

      console.log(
        `[DiagCE] Chunk persisted: ${event.memoFileName} chunk ${event.chunkIndex + 1} ` +
        `(${event.chunkClaims.length} claims, ${event.chunkResult.output_tokens} tokens, ${Math.round(event.chunkResult.elapsed_ms / 1000)}s)` +
        `${event.chunkResult.parse_recovered_empty ? " [SILENT_LOSS]" : ""}`
      );

      // P1: Persist raw LLM response for silent-loss chunks (0 claims, >500 tokens)
      if (event.chunkResult.parse_recovered_empty && event.rawResponseText) {
        await ctx.integrations.db.query(
          `INSERT INTO diag_claims_events (deal_id, event_type, memo_file, detail)
           VALUES ($1, 'silent_loss_raw_response', $2, $3::jsonb)`,
          z.any(),
          [dealId, event.memoFileName, JSON.stringify({
            chunk_index: event.chunkIndex,
            char_start: event.chunkResult.charStart,
            char_end: event.chunkResult.charEnd,
            output_tokens: event.chunkResult.output_tokens,
            raw_response: event.rawResponseText,
          })],
          { label: `DiagCE: persist silent-loss raw response (chunk ${event.chunkIndex})` },
        );
      }
    };

    // onChunkProgress: cursor-only persist (fires in-pool, pre-subdivide)
    const onChunkProgress = async (memoId: string, chunkIndex: number): Promise<void> => {
      if (!chunkCursor[memoId]) {
        chunkCursor[memoId] = [];
      }
      if (!chunkCursor[memoId].includes(chunkIndex)) {
        chunkCursor[memoId].push(chunkIndex);
      }
      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_ledger (deal_id, chunk_cursor, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (deal_id)
         DO UPDATE SET chunk_cursor = $2::jsonb, updated_at = NOW()`,
        z.any(),
        [dealId, JSON.stringify(chunkCursor)],
        { label: `DiagCE: cursor progress (chunk ${chunkIndex})` },
      );
    };

    // --- chunkIndices filter: STAGING pattern ---
    // Extract specified chunks into staging events FIRST. Only delete the old
    // events and update the cursor once the new data has been successfully written.
    // This prevents data loss on orchestrator timeout — the old events remain
    // intact until replacements are confirmed.
    if (chunkIndices && chunkIndices.length > 0) {
      if (!documentIds || documentIds.length !== 1) {
        throw new Error("chunkIndices requires exactly 1 documentIds entry");
      }
      const targetMemoId = documentIds[0];

      // Build a TEMPORARY cursor that omits the target indices (forces re-extraction
      // of those chunks) but DO NOT persist this yet. The real cursor keeps old data safe.
      const tempCursor: Record<string, number[]> = { ...chunkCursor };
      if (tempCursor[targetMemoId]) {
        const indicesToClear = new Set(chunkIndices);
        tempCursor[targetMemoId] = tempCursor[targetMemoId].filter(i => !indicesToClear.has(i));
      }

      // Clear the terminal_result for this memo so extraction sees it as pending
      if (priorLedger) {
        priorLedger.terminal_results = priorLedger.terminal_results.filter(
          t => t.memo_id !== targetMemoId
        );
        priorLedger.complete = false;
      }

      console.log(`[DiagCE] chunkIndices staging: will re-extract chunks [${chunkIndices.join(",")}] of memo ${targetMemoId} (old events preserved until success)`);

      // Run extraction with the temporary cursor — only target indices are pending
      const stagingLedger: ClaimsLedger = await runClaimsExtraction(
        pipelineCtx,
        dealId,
        startTime,
        200_000,
        {
          bypassHeadroom: true,
          priorLedger,
          maxWorkUnits: 1,
          skipQualitative: skipQualitative ?? false,
          chunkConcurrency: 8,
          chunkCursor: tempCursor,
          onChunkComplete: async (event: ChunkCompleteEvent): Promise<void> => {
            // Write new results as staging events (separate event_type so old ones stay)
            await ctx.integrations.db.query(
              `INSERT INTO diag_claims_events (deal_id, event_type, memo_file, elapsed_ms, output_tokens, detail)
               VALUES ($1, 'chunk_claims_staged', $2, $3, $4, $5::jsonb)`,
              z.any(),
              [
                dealId, event.memoFileName, event.chunkResult.elapsed_ms, event.chunkResult.output_tokens,
                JSON.stringify({
                  memo_id: event.memoId,
                  chunk_index: event.chunkIndex,
                  char_start: event.chunkResult.charStart,
                  char_end: event.chunkResult.charEnd,
                  claims_count: event.chunkClaims.length,
                  output_truncated: event.chunkResult.output_truncated,
                  parse_recovered_empty: event.chunkResult.parse_recovered_empty ?? false,
                  claims: event.chunkClaims,
                }),
              ],
              { label: `DiagCE: STAGED chunk claims (chunk ${event.chunkIndex})` },
            );
            console.log(`[DiagCE] Staged: chunk ${event.chunkIndex} (${event.chunkClaims.length} claims, ${event.chunkResult.output_tokens} tokens)`);
          },
          onChunkProgress,
          deferSubdivide: true,
        },
      );

      // --- COMMIT PHASE: swap old → new ONLY for chunks that actually staged ---
      // Query which chunk indices have staged events (handles partial completion on timeout)
      const stagedRows = await ctx.integrations.db.query(
        `SELECT DISTINCT (detail->>'chunk_index')::int AS idx
         FROM diag_claims_events
         WHERE deal_id = $1 AND event_type = 'chunk_claims_staged'
         AND detail->>'memo_id' = $2`,
        z.object({ idx: z.number() }),
        [dealId, targetMemoId],
        { label: `DiagCE: check which chunks staged successfully` },
      );
      const stagedIndices = stagedRows.map(r => r.idx);

      if (stagedIndices.length === 0) {
        // Nothing staged — originals preserved. Clean up any partial staging artifacts.
        console.warn(`[DiagCE] chunkIndices staging: 0 of ${chunkIndices.length} chunks completed — originals preserved intact.`);
        await ctx.integrations.db.query(
          `DELETE FROM diag_claims_events WHERE deal_id = $1 AND event_type = 'chunk_claims_staged' AND detail->>'memo_id' = $2`,
          z.any(),
          [dealId, targetMemoId],
          { label: `DiagCE: clean up empty staging` },
        );

        // Return with obstacle report — no data lost
        const meta = stagingLedger.extraction_metadata;
        return {
          complete: false,
          total_claims: meta.total_claims,
          memos_completed: persistedMemosCompleted,
          memos_pending: stagingLedger.terminal_results.filter(t => t.status === "pending").map(t => t.file_name),
          this_invocation: { memos_processed: 0, wall_clock_ms: Date.now() - startTime, per_memo: [] },
          category_counts: {
            operating_metric: meta.operating_metric_claims,
            deal_mechanics: meta.deal_mechanics_claims,
            valuation_structuring: meta.valuation_structuring_claims,
            returns_projection: meta.returns_projection_claims,
            cross_reference: meta.cross_reference_claims,
            total: meta.total_claims,
            docs_processed: meta.docs_processed,
          },
          obstacles: [`STAGING_TIMEOUT: 0 of ${chunkIndices.length} target chunks completed — originals preserved`],
        };
      }

      console.log(`[DiagCE] chunkIndices staging: ${stagedIndices.length}/${chunkIndices.length} chunks staged. Committing.`);

      // 1. Delete old chunk_claims events ONLY for successfully staged indices
      await ctx.integrations.db.query(
        `DELETE FROM diag_claims_events
         WHERE deal_id = $1 AND event_type = 'chunk_claims'
         AND detail->>'memo_id' = $2
         AND (detail->>'chunk_index')::int = ANY($3::int[])`,
        z.any(),
        [dealId, targetMemoId, stagedIndices],
        { label: `DiagCE: delete old events for staged chunks [${stagedIndices.join(",")}]` },
      );

      // 2. Promote staged events to regular chunk_claims
      await ctx.integrations.db.query(
        `UPDATE diag_claims_events
         SET event_type = 'chunk_claims'
         WHERE deal_id = $1 AND event_type = 'chunk_claims_staged'
         AND detail->>'memo_id' = $2
         AND (detail->>'chunk_index')::int = ANY($3::int[])`,
        z.any(),
        [dealId, targetMemoId, stagedIndices],
        { label: `DiagCE: promote staged → chunk_claims [${stagedIndices.join(",")}]` },
      );

      // 3. Update the real cursor — only staged indices, preserve the rest
      if (!chunkCursor[targetMemoId]) chunkCursor[targetMemoId] = [];
      for (const idx of stagedIndices) {
        if (!chunkCursor[targetMemoId].includes(idx)) {
          chunkCursor[targetMemoId].push(idx);
        }
      }
      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_ledger (deal_id, chunk_cursor, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (deal_id)
         DO UPDATE SET chunk_cursor = $2::jsonb, updated_at = NOW()`,
        z.any(),
        [dealId, JSON.stringify(chunkCursor)],
        { label: "DiagCE: persist cursor after staging success" },
      );

      console.log(`[DiagCE] chunkIndices staging COMPLETE: chunks [${stagedIndices.join(",")}] swapped (${stagedIndices.length}/${chunkIndices.length} requested)`);

      // 4. Persist the final merged ledger and return
      const meta = stagingLedger.extraction_metadata;
      const newTerminals = stagingLedger.terminal_results.filter(t => t.status !== "pending" && (t.status as string) !== "filtered_out");
      const priorCompleted = new Set(priorRows.length > 0 ? priorRows[0].memos_completed : [] as string[]);
      for (const t of newTerminals) priorCompleted.add(t.file_name);
      const reallyCompleted = [...priorCompleted];

      await ctx.integrations.db.query(
        `INSERT INTO diag_claims_ledger (deal_id, ledger, memos_completed, total_claims, complete, chunk_cursor, updated_at)
         VALUES ($1, $2::jsonb, $3::text[], $4, $5, $6::jsonb, NOW())
         ON CONFLICT (deal_id)
         DO UPDATE SET ledger = $2::jsonb, memos_completed = $3::text[], total_claims = $4, complete = $5, chunk_cursor = $6::jsonb, updated_at = NOW()`,
        z.any(),
        [dealId, JSON.stringify(stagingLedger), reallyCompleted, meta.total_claims, stagingLedger.complete, JSON.stringify(chunkCursor)],
        { label: "DiagCE: persist ledger after chunkIndices staging" },
      );

      return {
        complete: stagingLedger.complete,
        total_claims: meta.total_claims,
        memos_completed: reallyCompleted,
        memos_pending: stagingLedger.terminal_results
          .filter(t => t.status === "pending")
          .map(t => t.file_name),
        this_invocation: {
          memos_processed: newTerminals.length,
          wall_clock_ms: Date.now() - startTime,
          per_memo: newTerminals.map(t => ({
            file_name: t.file_name,
            status: t.status,
            claims_count: t.claims_count,
            error: t.error ?? null,
          })),
        },
        category_counts: {
          operating_metric: meta.operating_metric_claims,
          deal_mechanics: meta.deal_mechanics_claims,
          valuation_structuring: meta.valuation_structuring_claims,
          returns_projection: meta.returns_projection_claims,
          cross_reference: meta.cross_reference_claims,
          total: meta.total_claims,
          docs_processed: meta.docs_processed,
        },
        obstacles: [],
      };
    }

    // --- Build deferred subdivide queue from persisted events ---
    // Load events with needs_subdivide=true for all target memos
    const subdivideQueue: Record<string, Array<{ parentIdx: number; charStart: number; charEnd: number }>> = {};
    if (documentIds && documentIds.length > 0) {
      for (const memoId of documentIds) {
        const subdRows = await ctx.integrations.db.query(
          `SELECT detail FROM diag_claims_events
           WHERE deal_id = $1 AND event_type = 'chunk_claims'
           AND detail->>'memo_id' = $2
           AND (detail->>'needs_subdivide')::boolean = true`,
          z.object({ detail: z.any() }),
          [dealId, memoId],
          { label: `DiagCE: load subdivide queue for ${memoId}` },
        );
        if (subdRows.length > 0) {
          subdivideQueue[memoId] = subdRows.map(r => ({
            parentIdx: r.detail.chunk_index,
            charStart: r.detail.char_start,
            charEnd: r.detail.char_end,
          }));
          // Remove these indices from cursor so they're treated as pending for subdivide
          if (chunkCursor[memoId]) {
            const subdIndices = new Set(subdivideQueue[memoId].map(q => q.parentIdx));
            chunkCursor[memoId] = chunkCursor[memoId].filter(i => !subdIndices.has(i));
          }
          console.log(`[DiagCE] Subdivide queue for ${memoId}: ${subdRows.length} chunk(s) [${subdivideQueue[memoId].map(q => q.parentIdx).join(",")}]`);
        }
      }
    }

    const ledger: ClaimsLedger = await runClaimsExtraction(
      pipelineCtx,
      dealId,
      startTime,
      200_000, // 200s — matches production TIME_BUDGET_MS
      {
        bypassHeadroom: true,
        priorLedger,
        maxWorkUnits: effectiveMaxWork,
        skipQualitative: skipQualitative ?? false,
        chunkConcurrency: 8,
        chunkCursor,
        onChunkComplete,
        onChunkProgress,
        deferSubdivide: true,
        subdivideQueue: Object.keys(subdivideQueue).length > 0 ? subdivideQueue : undefined,
      },
    );

    // --- Log post-extraction ---
    const postExtractionTs = Date.now();
    await ctx.integrations.db.query(
      `INSERT INTO diag_claims_events (deal_id, event_type, elapsed_ms, detail)
       VALUES ($1, 'post_extraction', $2, $3::jsonb)`,
      z.any(),
      [dealId, postExtractionTs - startTime, JSON.stringify({
        total_claims: ledger.extraction_metadata.total_claims,
        complete: ledger.complete,
        terminals: ledger.terminal_results.map(t => ({ f: t.file_name, s: t.status, c: t.claims_count })),
      })],
      { label: "DiagCE: log post-extraction" },
    );

    // --- Persist the accumulated ledger ---
    // "memos_completed" = UNION of prior persisted completions + new extractions
    // This prevents re-extraction of memos completed in earlier invocations.
    const priorCompleted = new Set(priorRows.length > 0 ? priorRows[0].memos_completed : []);
    const newlyCompleted = ledger.terminal_results
      .filter(t => t.status !== "pending" && (t.status as string) !== "filtered_out")
      .map(t => t.file_name);
    for (const m of newlyCompleted) priorCompleted.add(m);
    const reallyCompleted = [...priorCompleted];

    // "complete" = all TARGET memos have been extracted (not pending, not filtered_out)
    const targetMemoIds = new Set(allMemos.filter(m => targetIds.has(m.id)).map(m => m.id));
    const targetTerminals = ledger.terminal_results.filter(t => targetMemoIds.has(t.memo_id));
    const allTargetsDone = targetTerminals.length === targetMemoIds.size &&
      targetTerminals.every(t => t.status !== "pending");
    const isComplete = allTargetsDone;

    await ctx.integrations.db.query(
      `INSERT INTO diag_claims_ledger (deal_id, ledger, memos_completed, total_claims, complete, chunk_cursor, updated_at)
       VALUES ($1, $2::jsonb, $3::text[], $4, $5, $6::jsonb, NOW())
       ON CONFLICT (deal_id)
       DO UPDATE SET ledger = $2::jsonb, memos_completed = $3::text[], total_claims = $4, complete = $5, chunk_cursor = $6::jsonb, updated_at = NOW()`,
      z.any(),
      [dealId, JSON.stringify(ledger), reallyCompleted, ledger.extraction_metadata.total_claims, isComplete, JSON.stringify(chunkCursor)],
      { label: "DiagCE: persist ledger" },
    );

    // --- Log persist complete ---
    const persistTs = Date.now();
    await ctx.integrations.db.query(
      `INSERT INTO diag_claims_events (deal_id, event_type, elapsed_ms, detail)
       VALUES ($1, 'persist_complete', $2, $3::jsonb)`,
      z.any(),
      [dealId, persistTs - startTime, JSON.stringify({ total_claims: ledger.extraction_metadata.total_claims, isComplete })],
      { label: "DiagCE: log persist" },
    );

    // --- Build per-memo status from this invocation ---
    const priorTerminalIds = new Set(
      (priorLedger?.terminal_results ?? []).map(t => t.memo_id)
    );
    const newTerminals = ledger.terminal_results.filter(
      t => !priorTerminalIds.has(t.memo_id) && t.status !== "pending" && (t.status as string) !== "filtered_out"
    );

    // Pending = target memos that haven't been extracted yet
    const memosPending = ledger.terminal_results
      .filter(t => t.status === "pending" && targetIds.has(t.memo_id))
      .map(t => t.file_name);

    const meta = ledger.extraction_metadata;
    const wallClock = Date.now() - startTime;

    return {
      complete: isComplete,
      total_claims: meta.total_claims,
      memos_completed: reallyCompleted,
      memos_pending: memosPending,
      this_invocation: {
        memos_processed: newTerminals.length,
        wall_clock_ms: wallClock,
        per_memo: newTerminals.map(t => ({
          file_name: t.file_name,
          status: t.status,
          claims_count: t.claims_count,
          error: t.error ?? null,
        })),
      },
      category_counts: {
        operating_metric: meta.operating_metric_claims,
        deal_mechanics: meta.deal_mechanics_claims,
        valuation_structuring: meta.valuation_structuring_claims,
        returns_projection: meta.returns_projection_claims,
        cross_reference: meta.cross_reference_claims,
        total: meta.total_claims,
        docs_processed: meta.docs_processed,
      },
      obstacles,
    };
  },
});
