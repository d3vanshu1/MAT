/**
 * DCS Extract Presence — Phase 2.1 of the DCS rebuild.
 *
 * Processes document chunks one at a time through a Sonnet LLM call to
 * determine which of the 10 DCS dimensions each chunk covers, and whether
 * coverage is substantive. Results are written to dcs_evidence with
 * deterministic doc_class from classifyDocClass (never from the model).
 *
 * Architecture: concurrent workers perform model analysis entirely in memory.
 * Only the ordered commit walk may delete/insert evidence, advance the cursor,
 * update pipeline state, or mutate counters.
 *
 * Cursor-based resumable. Replay-safe via delete-before-insert per chunk.
 * Zero-evidence responses are normal and advance the cursor.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "./model-config.js";
import { callLLMWithHeadroom } from "./call-llm.js";
import { DCS_DIMENSIONS, classifyDocClass } from "./dcs-rubric.js";
import type { PipelineContext } from "./pipeline-config.js";
import {
  type PhysicalChunk,
  type LogicalWindow,
  type SnippetMapping,
  reconstructDocument,
  buildLogicalWindows,
  mapSnippetToPhysicalChunk,
  isExcelDocument,
} from "./dcs-logical-excel-windows.js";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ────────────────────────────────────────────────────
const INVOCATION_BUDGET_MS = 240_000;
const MIN_CALL_HEADROOM_MS = 30_000;
const MAX_PER_CALL_MS = 60_000;
const ORDERING_VERSION = "document-index-v1";
const WORK_UNIT_VERSION = "logical-excel-v1";

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
  // Recovery counters
  json_repair_applied: number;
  semantic_retry_attempted: number;
  semantic_retry_recovered: number;
  // Ordering version (5C.2C)
  ordering_version: string;
  // Work-unit version (5C.2E)
  work_unit_version: string;
  // Physical mapping rejections (5C.2E)
  physical_mapping_rejected: number;
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
    json_repair_applied: 0,
    semantic_retry_attempted: 0,
    semantic_retry_recovered: 0,
    ordering_version: ORDERING_VERSION,
    work_unit_version: WORK_UNIT_VERSION,
    physical_mapping_rejected: 0,
  };
}

/** Hydrate recovery counters for older state rows that lack them. */
function hydrateRecoveryCounters(detail: CumulativeDetail): CumulativeDetail {
  return {
    ...detail,
    json_repair_applied: detail.json_repair_applied ?? 0,
    semantic_retry_attempted: detail.semantic_retry_attempted ?? 0,
    semantic_retry_recovered: detail.semantic_retry_recovered ?? 0,
    ordering_version: detail.ordering_version ?? "",
    work_unit_version: detail.work_unit_version ?? "",
    physical_mapping_rejected: detail.physical_mapping_rejected ?? 0,
  };
}

/** Classify state as empty: cursor null, all counters zero, no last_chunk_id */
function isStateEmpty(detail: CumulativeDetail, cursorValue: string | null): boolean {
  return (
    cursorValue === null &&
    detail.processed_count === 0 &&
    detail.evidence_rows_written === 0 &&
    detail.empty_chunk_count === 0 &&
    (!detail.last_chunk_id || detail.last_chunk_id === null)
  );
}

// ── Whitespace normalizer for literal anchoring ──────────────────
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Targeted snippet-quote repair (D2) ───────────────────────────
/**
 * Repairs unescaped quotation marks inside "snippet" JSON string values.
 *
 * Operates on the full JSON payload after fence normalization.
 * Recognizes only the exact ordered object shape:
 *   { "dimension_id": "...", "snippet": "...", "is_substantive": true/false }
 *
 * For each snippet value, locates the structural end by finding the
 * subsequent `"is_substantive"` key rather than relying on quote+comma
 * heuristics that fail on CSV-quoted text.
 *
 * Returns null if any snippet key cannot be matched exactly once, or if
 * the repaired payload still fails JSON.parse.
 */
function repairSnippetQuotes(payload: string): unknown | null {
  // Pattern: locate each "snippet" : "..." , "is_substantive" boundary
  // We find the opening quote of the snippet value and the closing quote
  // by anchoring on the is_substantive key that must follow.
  const snippetKeyPattern = /"snippet"\s*:\s*"/g;
  const isSubKeyLiteral = '"is_substantive"';

  let repaired = "";
  let lastEnd = 0;
  let matchCount = 0;

  let match: RegExpExecArray | null;
  while ((match = snippetKeyPattern.exec(payload)) !== null) {
    matchCount++;
    const valueStart = match.index + match[0].length; // index after opening quote

    // Find the is_substantive key that follows this snippet value.
    // The structural boundary is: ","is_substantive"  (with optional whitespace)
    // We search for the pattern:  ","is_substantive" or ", "is_substantive"
    // starting from valueStart.
    const isSubIdx = payload.indexOf(isSubKeyLiteral, valueStart);
    if (isSubIdx === -1) {
      return null; // Cannot find structural boundary — bail
    }

    // Walk backwards from isSubIdx to find the closing quote + comma separator.
    // Expected pattern before is_substantive key: ...CLOSING_QUOTE , SPACE*
    // So we look backwards: optional whitespace, comma, optional whitespace, closing quote
    let backIdx = isSubIdx - 1;
    while (backIdx >= valueStart && (payload[backIdx] === ' ' || payload[backIdx] === '\n' || payload[backIdx] === '\r' || payload[backIdx] === '\t')) backIdx--;
    if (backIdx < valueStart || payload[backIdx] !== ',') return null; // no comma before is_substantive
    backIdx--; // skip comma
    while (backIdx >= valueStart && (payload[backIdx] === ' ' || payload[backIdx] === '\n' || payload[backIdx] === '\r' || payload[backIdx] === '\t')) backIdx--;
    if (backIdx < valueStart || payload[backIdx] !== '"') return null; // no closing quote

    const closingQuoteIdx = backIdx;

    // Extract the raw snippet value content (between opening quote and closing quote)
    const rawSnippetContent = payload.slice(valueStart, closingQuoteIdx);

    // Escape unescaped quotes within the snippet value.
    // Preserve already-escaped quotes (\" should stay as \").
    let escapedContent = "";
    for (let i = 0; i < rawSnippetContent.length; i++) {
      const ch = rawSnippetContent[i];
      if (ch === '\\') {
        // Already an escape sequence — preserve as-is
        escapedContent += ch + (rawSnippetContent[i + 1] ?? "");
        i++;
      } else if (ch === '"') {
        // Unescaped quote inside snippet — escape it
        escapedContent += '\\"';
      } else {
        escapedContent += ch;
      }
    }

    // Append everything from lastEnd up to and including the opening quote
    repaired += payload.slice(lastEnd, valueStart);
    // Append the escaped snippet content + closing quote
    repaired += escapedContent + '"';
    lastEnd = closingQuoteIdx + 1; // continue after the original closing quote
  }

  if (matchCount === 0) return null; // No snippet keys found

  // Append the remainder of the payload
  repaired += payload.slice(lastEnd);

  // Verify every "snippet" key was matched (check for unmatched ones)
  // Count total "snippet" keys in the original payload
  const totalSnippetKeys = (payload.match(/"snippet"\s*:\s*"/g) || []).length;
  if (totalSnippetKeys !== matchCount) return null;

  // Attempt to parse the repaired payload
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
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
- The snippet MUST be copied verbatim from the chunk text. Do not edit, shorten, or rephrase.

FORMATTING REQUIREMENTS (critical for valid JSON):
- Each object's keys MUST appear in this exact order: dimension_id, snippet, is_substantive
- Every quotation mark inside a snippet value MUST be escaped as \\"
- Every backslash inside a snippet value MUST be escaped as \\\\
- CSV-quoted cells (e.g. "1,121,037","1,653,036") MUST use escaped quotes inside snippet
- Check your response for valid JSON before submitting

Example with adjacent quoted financial values:
[{"dimension_id":"financial_qoe","snippet":"Revenue was \\"1,121,037\\",\\"1,653,036\\",\\"2,115,151\\" for Q1-Q3","is_substantive":true}]`;

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
    batchSize: z.number().int().min(1).max(32).default(16),
    concurrency: z.number().int().min(1).max(8).default(4),
    resumeCursor: z.string().uuid().optional(),
    verificationChunkId: z.string().uuid().optional(),
    verificationDocumentId: z.string().uuid().optional(),
    verificationWindowIndex: z.number().int().min(0).optional(),
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
    // Concurrency telemetry (D8)
    configuredConcurrency: z.number(),
    maxObservedConcurrency: z.number(),
    llmCallsStartedThisCall: z.number(),
    staggerMs: z.number(),
    // Recovery telemetry (D5)
    jsonRepairsAppliedThisCall: z.number(),
    semanticRetriesThisCall: z.number(),
    semanticRetryRecoveriesThisCall: z.number(),
    // Work-unit telemetry (5C.2E)
    logicalWindowsProcessedThisCall: z.number().optional(),
    excelWindowsProcessedThisCall: z.number().optional(),
    pdfWindowsProcessedThisCall: z.number().optional(),
    physicalChunksCoveredThisCall: z.number().optional(),
    averageExcelWindowChars: z.number().optional(),
    largestExcelWindowChars: z.number().optional(),
    physicalMappingRejectedThisCall: z.number().optional(),
    effectiveWorkUnitVersion: z.string().optional(),
  }),

  async run(ctx, input) {
    const startTime = Date.now();
    const db = ctx.integrations.ic_diligence_db;
    const hasLogicalFields = input.verificationDocumentId !== undefined || input.verificationWindowIndex !== undefined;
    const isLogicalVerification = input.verificationDocumentId !== undefined && input.verificationWindowIndex !== undefined;
    const isPhysicalVerification = !!input.verificationChunkId;
    const isVerification = isPhysicalVerification || isLogicalVerification;
    const mode = isVerification ? "verification" : "normal";

    // ── 0. Input-mode validation ───────────────────────────────
    // Reject ambiguous/partial logical fields
    if (hasLogicalFields && !isLogicalVerification) {
      throw new Error(
        "verificationDocumentId and verificationWindowIndex must both be supplied together.",
      );
    }
    if (isLogicalVerification && isPhysicalVerification) {
      throw new Error(
        "Cannot combine verificationDocumentId/verificationWindowIndex with verificationChunkId.",
      );
    }
    if (isLogicalVerification && input.resumeCursor) {
      throw new Error("Logical verification mode does not accept resumeCursor.");
    }
    if (isLogicalVerification && !input.debug) {
      throw new Error("Logical verification mode requires debug=true.");
    }
    if (isLogicalVerification && input.batchSize !== 1) {
      throw new Error("Logical verification mode requires batchSize=1.");
    }
    if (isLogicalVerification && input.concurrency !== 1) {
      throw new Error("Logical verification mode requires concurrency=1.");
    }
    if (!isLogicalVerification && !isPhysicalVerification && hasLogicalFields) {
      throw new Error(
        "verificationDocumentId/verificationWindowIndex are verification-only inputs.",
      );
    }

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
    let jsonRepairsAppliedThisCall = 0;
    let semanticRetriesThisCall = 0;
    let semanticRetryRecoveriesThisCall = 0;
    const trace: TraceEntry[] = [];

    // ── 3a. Logical Excel verification mode (read-only) ────────
    if (isLogicalVerification) {
      // D2: Document validation
      const docRows = await db.query(
        `SELECT d.id, d.document_tag, d.deal_id
         FROM documents d
         WHERE d.id = $1::uuid
         LIMIT 1`,
        z.object({ id: z.string(), document_tag: z.string().nullable(), deal_id: z.string() }),
        [input.verificationDocumentId],
        { label: "DcsExtract: validate verification document" },
      );
      if (docRows.length === 0) {
        throw new Error(`Document ${input.verificationDocumentId} not found.`);
      }
      const doc = docRows[0];
      if (doc.deal_id !== input.dealId) {
        throw new Error(
          `Document ${input.verificationDocumentId} belongs to deal ${doc.deal_id}, not ${input.dealId}.`,
        );
      }

      // Fetch all physical chunks for this document
      const physChunkRows = await db.query(
        `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content,
                dc.document_id, dc.file_name AS source_file, dc.deal_id
         FROM document_chunks dc
         WHERE dc.document_id = $1::uuid AND dc.deal_id = $2::uuid
         ORDER BY dc.chunk_index ASC`,
        z.object({
          chunk_id: z.string(),
          chunk_index: z.number(),
          content: z.string(),
          document_id: z.string(),
          source_file: z.string(),
          deal_id: z.string(),
        }),
        [input.verificationDocumentId, input.dealId],
        { label: "DcsExtract: fetch document chunks for logical verification" },
      );
      if (physChunkRows.length === 0) {
        throw new Error(`No physical chunks found for document ${input.verificationDocumentId}.`);
      }

      const sourceFile = physChunkRows[0].source_file;
      const documentTag = doc.document_tag;

      // Require Excel document (tag + extension)
      if (!isExcelDocument(documentTag, sourceFile)) {
        throw new Error(
          `Document is not Excel: tag="${documentTag}", file="${sourceFile}". ` +
          `Logical verification requires financial_model or customer_data tag and .xlsx/.xls/.xlsm/.csv extension.`,
        );
      }

      // Verify all chunks belong to same deal
      for (const pc of physChunkRows) {
        if (pc.deal_id !== input.dealId) {
          throw new Error(
            `Chunk ${pc.chunk_id} (index ${pc.chunk_index}) has deal_id=${pc.deal_id}, expected ${input.dealId}.`,
          );
        }
      }

      // Build PhysicalChunk array for planner
      const physicalChunks: PhysicalChunk[] = physChunkRows.map(pc => ({
        chunk_id: pc.chunk_id,
        chunk_index: pc.chunk_index,
        content: pc.content,
        document_id: pc.document_id,
        source_file: sourceFile,
        document_tag: documentTag ?? "other",
      }));

      // Run approved planner
      const windows = buildLogicalWindows(physicalChunks);

      // Validate window index exists
      const windowIndex = input.verificationWindowIndex!;
      const selectedWindow = windows.find(w => w.windowIndex === windowIndex);
      if (!selectedWindow) {
        throw new Error(
          `Window index ${windowIndex} not found. Document has ${windows.length} windows (0–${windows.length - 1}).`,
        );
      }

      // D3: Window safety checks
      if (selectedWindow.ownedChunkIds.length === 0) {
        throw new Error(`Window ${windowIndex} owns zero physical chunks.`);
      }
      // All owned chunks belong to requested document
      const docChunkIds = new Set(physChunkRows.map(pc => pc.chunk_id));
      for (const oid of selectedWindow.ownedChunkIds) {
        if (!docChunkIds.has(oid)) {
          throw new Error(`Window ${windowIndex} owns chunk ${oid} not in document ${input.verificationDocumentId}.`);
        }
      }
      // No duplicate owned chunk IDs
      if (new Set(selectedWindow.ownedChunkIds).size !== selectedWindow.ownedChunkIds.length) {
        throw new Error(`Window ${windowIndex} has duplicate owned chunk IDs.`);
      }
      // Complete ownership metadata
      if (!selectedWindow.firstOwnedChunkId || !selectedWindow.lastOwnedChunkId) {
        throw new Error(`Window ${windowIndex} missing first/last owned chunk ID metadata.`);
      }

      // Classify window type
      let windowClassification: "normal" | "repaired" | "cross_sheet";
      if (selectedWindow.totalChars > 12_000) {
        throw new Error(
          `Window ${windowIndex} exceeds 12,000 characters (${selectedWindow.totalChars}). Cannot process.`,
        );
      } else if (selectedWindow.totalChars > 10_000 && selectedWindow.totalChars <= 12_000) {
        windowClassification = "repaired";
      } else {
        windowClassification = "normal";
      }

      // Cross-sheet detection: check if window text contains multiple sheet markers
      const sheetMarkerRe = /^--- Sheet: .+ ---$/gm;
      const sheetMarkers = selectedWindow.windowText.match(sheetMarkerRe) || [];
      if (sheetMarkers.length > 1) {
        windowClassification = "cross_sheet";
        // Verify each sheet marker is present and distinguishable
        for (const marker of sheetMarkers) {
          if (!selectedWindow.windowText.includes(marker)) {
            throw new Error(`Cross-sheet window ${windowIndex}: sheet marker "${marker}" not properly embedded.`);
          }
        }
      }

      // Size bounds
      if (windowClassification === "repaired") {
        if (selectedWindow.totalChars > 12_000) {
          throw new Error(`Repair window ${windowIndex} exceeds 12,000 char limit.`);
        }
      } else if (windowClassification === "normal" || windowClassification === "cross_sheet") {
        if (selectedWindow.totalChars > 10_000) {
          // Allow normal windows up to 10k, cross-sheet might be slightly larger via repair
          if (windowClassification !== "cross_sheet" || selectedWindow.totalChars > 12_000) {
            throw new Error(`Normal window ${windowIndex} exceeds 10,000 char limit (${selectedWindow.totalChars}).`);
          }
        }
      }

      // D4: Real in-memory model analysis using a synthetic ChunkRow
      const syntheticChunk: ChunkRow = {
        chunk_id: `logical-window-${windowIndex}`,
        chunk_text: selectedWindow.windowText,
        source_file: sourceFile,
        document_tag: documentTag,
        document_id: selectedWindow.documentId,
        chunk_index: windowIndex,
      };

      const outcome = await analyzeChunk(
        ctx as unknown as PipelineContext,
        syntheticChunk,
        startTime,
        true, // debug
      );

      // D5: Physical mapping for every accepted item
      interface MappedItem {
        dimension_id: string;
        snippet: string;
        is_substantive: boolean;
        mapping: SnippetMapping;
        mappedChunkId: string | null;
        sourceOffset: number | null;
        fullyContained: boolean;
        sheetName: string;
      }

      const mappedItems: MappedItem[] = [];
      const mappingRejections: Array<{ dimension_id: string; snippet: string; reason: string }> = [];

      for (const item of outcome.accepted) {
        const mapping = mapSnippetToPhysicalChunk(selectedWindow, item.snippet);

        if (mapping.foundInPrimary && mapping.mappedChunkId) {
          // Verify mapped chunk is owned by the window
          if (!selectedWindow.ownedChunkIds.includes(mapping.mappedChunkId)) {
            mappingRejections.push({
              dimension_id: item.dimension_id,
              snippet: item.snippet,
              reason: `mapped_chunk_not_owned: ${mapping.mappedChunkId}`,
            });
            continue;
          }
          // Verify mapped chunk exists in document_chunks and same deal
          if (!docChunkIds.has(mapping.mappedChunkId)) {
            mappingRejections.push({
              dimension_id: item.dimension_id,
              snippet: item.snippet,
              reason: `mapped_chunk_not_in_document: ${mapping.mappedChunkId}`,
            });
            continue;
          }

          mappedItems.push({
            dimension_id: item.dimension_id,
            snippet: item.snippet,
            is_substantive: item.is_substantive,
            mapping,
            mappedChunkId: mapping.mappedChunkId,
            sourceOffset: mapping.sourceOffset,
            fullyContained: true, // simplified — chunk contains the snippet
            sheetName: selectedWindow.sheetName,
          });
        } else {
          // Rejected: context-only or not found
          mappingRejections.push({
            dimension_id: item.dimension_id,
            snippet: item.snippet,
            reason: mapping.rejectionReason ?? "unknown",
          });
        }
      }

      // D6: Build logical verification trace
      const logicalTrace = {
        mode: "logical_excel_verification",
        document_id: input.verificationDocumentId,
        source_file: sourceFile,
        document_tag: documentTag,
        window_index: windowIndex,
        classification: windowClassification,
        totalChars: selectedWindow.totalChars,
        primaryChars: selectedWindow.primaryChars,
        contextChars: selectedWindow.contextChars,
        sheetName: selectedWindow.sheetName,
        owned_chunk_ids: selectedWindow.ownedChunkIds,
        first_owned_chunk_id: selectedWindow.firstOwnedChunkId,
        last_owned_chunk_id: selectedWindow.lastOwnedChunkId,
        raw_model_response: outcome.traceEntry?.raw_model_response ?? null,
        model_accepted_items: outcome.accepted,
        mapped_items: mappedItems,
        mapping_rejections: mappingRejections,
        fabrication_rejected: outcome.fabricationRejected,
        invalid_dimension_rejected: outcome.invalidDimensionRejected,
        duplicate_dimension_rejected: outcome.duplicateDimensionRejected,
        json_repair_applied: outcome.jsonRepairApplied ? 1 : 0,
        semantic_retry_attempted: outcome.semanticRetryAttempted ? 1 : 0,
        semantic_retry_recovered: outcome.semanticRetryRecovered ? 1 : 0,
      };
      trace.push(logicalTrace as unknown as TraceEntry);

      return {
        runId: input.runId,
        mode,
        status: "done",
        processedThisCall: 0,
        cumulativeProcessed: 0,
        rowsWrittenThisCall: 0,
        cumulativeRowsWritten: 0,
        emptyChunksThisCall: 0,
        fabricationRejectedThisCall: outcome.fabricationRejected,
        invalidDimensionRejectedThisCall: outcome.invalidDimensionRejected,
        duplicateDimensionRejectedThisCall: outcome.duplicateDimensionRejected,
        savedCursor: null,
        remainingChunks: 0,
        resumeRequired: false,
        elapsedMs: Date.now() - startTime,
        trace,
        configuredConcurrency: 1,
        maxObservedConcurrency: 0,
        llmCallsStartedThisCall: 1,
        staggerMs: 0,
        jsonRepairsAppliedThisCall: outcome.jsonRepairApplied ? 1 : 0,
        semanticRetriesThisCall: outcome.semanticRetryAttempted ? 1 : 0,
        semanticRetryRecoveriesThisCall: outcome.semanticRetryRecovered ? 1 : 0,
      };
    }

    // ── 3b. Physical verification mode (single chunk, no pipeline state) ─
    if (isPhysicalVerification) {
      if (input.batchSize !== 1) {
        throw new Error("Verification mode requires batchSize=1");
      }
      if (!input.debug) {
        throw new Error("Verification mode requires debug=true");
      }

      const chunks = await db.query(
        `SELECT dc.id AS chunk_id, dc.content AS chunk_text,
                dc.file_name AS source_file, d.document_tag,
                dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND dc.id = $2::uuid
         LIMIT 1`,
        z.object({
          chunk_id: z.string(),
          chunk_text: z.string(),
          source_file: z.string(),
          document_tag: z.string().nullable(),
          document_id: z.string(),
          chunk_index: z.number(),
        }),
        [input.dealId, input.verificationChunkId],
        { label: "DcsExtract: fetch verification chunk" },
      );

      if (chunks.length === 0) {
        throw new Error(`Chunk ${input.verificationChunkId} not found for deal ${input.dealId}`);
      }

      const chunk = chunks[0];

      // D7: Verification uses the same in-memory analysis + explicit persistence
      const outcome = await analyzeChunk(
        ctx as unknown as PipelineContext,
        chunk,
        startTime,
        true,
      );
      const written = await persistChunkEvidence(db, input.runId, chunk, outcome);

      processedThisCall = 1;
      rowsWrittenThisCall = written;
      emptyChunksThisCall = written === 0 ? 1 : 0;
      fabricationRejectedThisCall = outcome.fabricationRejected;
      invalidDimensionRejectedThisCall = outcome.invalidDimensionRejected;
      duplicateDimensionRejectedThisCall = outcome.duplicateDimensionRejected;
      if (outcome.traceEntry) trace.push(outcome.traceEntry);

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
        configuredConcurrency: 1,
        maxObservedConcurrency: 1,
        llmCallsStartedThisCall: 1,
        staggerMs: 50,
        jsonRepairsAppliedThisCall: outcome.jsonRepairApplied ? 1 : 0,
        semanticRetriesThisCall: outcome.semanticRetryAttempted ? 1 : 0,
        semanticRetryRecoveriesThisCall: outcome.semanticRetryRecovered ? 1 : 0,
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

      // D2: Parse detail and apply compatibility check BEFORE any early return
      const parsedDetail: CumulativeDetail = hydrateRecoveryCounters(
        state.detail ? JSON.parse(state.detail) : emptyDetail(totalChunks),
      );
      const stateEmpty = isStateEmpty(parsedDetail, cursorValue);

      // D2: Compatibility check — applies even for done/failed states
      if (stateEmpty) {
        // Empty state: initialize versions in memory, persist on next checkpoint
        parsedDetail.ordering_version = ORDERING_VERSION;
        parsedDetail.work_unit_version = WORK_UNIT_VERSION;
      } else {
        // Non-empty state: require exact ordering_version match
        if (parsedDetail.ordering_version !== ORDERING_VERSION) {
          throw new Error(
            `Incompatible ordering: state has ordering_version="${parsedDetail.ordering_version || "(missing)"}" ` +
            `but this build requires "${ORDERING_VERSION}". Create a fresh DCS run to use the new ordering.`,
          );
        }
        // Non-empty state: require exact work_unit_version match
        if (parsedDetail.work_unit_version !== WORK_UNIT_VERSION) {
          throw new Error(
            `Incompatible work_unit_version: state has "${parsedDetail.work_unit_version || "(missing)"}" ` +
            `but this build requires "${WORK_UNIT_VERSION}". Create a fresh DCS run.`,
          );
        }
      }

      if (state.status === "done") {
        return {
          runId: input.runId,
          mode,
          status: "done",
          processedThisCall: 0,
          cumulativeProcessed: parsedDetail.processed_count,
          rowsWrittenThisCall: 0,
          cumulativeRowsWritten: parsedDetail.evidence_rows_written,
          emptyChunksThisCall: 0,
          fabricationRejectedThisCall: 0,
          invalidDimensionRejectedThisCall: 0,
          duplicateDimensionRejectedThisCall: 0,
          savedCursor: cursorValue,
          remainingChunks: 0,
          resumeRequired: false,
          elapsedMs: Date.now() - startTime,
          trace,
          configuredConcurrency: input.concurrency,
          maxObservedConcurrency: 0,
          llmCallsStartedThisCall: 0,
          staggerMs: 50,
          jsonRepairsAppliedThisCall: 0,
          semanticRetriesThisCall: 0,
          semanticRetryRecoveriesThisCall: 0,
        };
      }

      // Validate resumeCursor consistency (D4)
      if (cursorValue) {
        // State has progress: resumeCursor must match if supplied
        if (input.resumeCursor && input.resumeCursor !== cursorValue) {
          throw new Error(
            `resumeCursor mismatch: supplied=${input.resumeCursor} stored=${cursorValue}`,
          );
        }
      } else {
        // No state progress: reject externally supplied cursor
        if (input.resumeCursor) {
          throw new Error(
            "resumeCursor supplied but extract state has no progress (cursor_value is null). " +
            "Omit resumeCursor to start from the beginning.",
          );
        }
      }

      cumulative = parsedDetail;
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

    // ── 4b. D3: Corpus order invariant — require unique (document_id, chunk_index)
    const dupCheck = await db.query(
      `SELECT dc.document_id, dc.chunk_index, COUNT(*)::int AS cnt
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
       GROUP BY dc.document_id, dc.chunk_index
       HAVING COUNT(*) > 1
       LIMIT 1`,
      z.object({ document_id: z.string(), chunk_index: z.number(), cnt: z.number() }),
      [input.dealId],
      { label: "DcsExtract: check corpus uniqueness" },
    );
    if (dupCheck.length > 0) {
      throw new Error(
        `Corpus order invariant violated: document_id=${dupCheck[0].document_id} ` +
        `chunk_index=${dupCheck[0].chunk_index} appears ${dupCheck[0].cnt} times. ` +
        `Fix duplicate chunks before running DCS extract.`,
      );
    }

    // ── 4c. D4: Cursor resolution — resolve UUID to composite position
    let cursorAnchor: { document_id: string; chunk_index: number } | null = null;
    if (cursorValue) {
      const anchorRows = await db.query(
        `SELECT dc.id AS chunk_id, dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.id = $1::uuid AND dc.deal_id = $2::uuid AND d.deal_id = $2::uuid
         LIMIT 1`,
        z.object({ chunk_id: z.string(), document_id: z.string(), chunk_index: z.number() }),
        [cursorValue, input.dealId],
        { label: "DcsExtract: resolve cursor anchor" },
      );
      if (anchorRows.length === 0) {
        throw new Error(
          `Unknown or cross-deal cursor: chunk_id=${cursorValue} not found in deal ${input.dealId}`,
        );
      }
      cursorAnchor = { document_id: anchorRows[0].document_id, chunk_index: anchorRows[0].chunk_index };
    }

    // ═════════════════════════════════════════════════════════════
    // §3: Build work-unit list (5C.2E)
    // ═════════════════════════════════════════════════════════════

    // §3a: Phase 1 — fetch METADATA ONLY (no content) for all remaining chunks.
    // This avoids the gRPC 4MB payload limit that occurs when fetching content
    // for thousands of chunks (e.g. 3,878 chunks × ~2KB ≈ 8MB > 4MB limit).
    // Content is fetched per-document in Phase 2 only for documents in the batch.
    type ChunkMeta = {
      chunk_id: string;
      source_file: string;
      document_tag: string | null;
      document_id: string;
      chunk_index: number;
    };

    const metaQuery = cursorAnchor
      ? `SELECT dc.id AS chunk_id,
                dc.file_name AS source_file, d.document_tag,
                dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
           AND (dc.document_id::text, dc.chunk_index) > ($2::text, $3::int)
         ORDER BY dc.document_id::text ASC, dc.chunk_index ASC`
      : `SELECT dc.id AS chunk_id,
                dc.file_name AS source_file, d.document_tag,
                dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
         ORDER BY dc.document_id::text ASC, dc.chunk_index ASC`;

    const metaParams = cursorAnchor
      ? [input.dealId, cursorAnchor.document_id, cursorAnchor.chunk_index]
      : [input.dealId];

    const allRemainingMeta: ChunkMeta[] = await db.query(
      metaQuery,
      z.object({
        chunk_id: z.string(),
        source_file: z.string(),
        document_tag: z.string().nullable(),
        document_id: z.string(),
        chunk_index: z.number(),
      }),
      metaParams,
      { label: "DcsExtract: fetch remaining chunk metadata" },
    );

    // Build a set of remaining chunk IDs for fast lookup
    const allRemainingChunkIds = new Set(allRemainingMeta.map(m => m.chunk_id));

    // §3b: Group metadata by document_id (preserving composite order)
    const docMetaMap = new Map<string, ChunkMeta[]>();
    const docOrder: string[] = [];
    for (const meta of allRemainingMeta) {
      let arr = docMetaMap.get(meta.document_id);
      if (!arr) {
        arr = [];
        docMetaMap.set(meta.document_id, arr);
        docOrder.push(meta.document_id);
      }
      arr.push(meta);
    }

    // §3c: Phase 2 — fetch content per-document, only for docs we need.
    // We iterate documents in composite order and build work units until
    // we have enough to satisfy the batchSize budget. Content is loaded
    // lazily per-document to stay under the gRPC payload limit.
    //
    // Helper to fetch full content for a single document.
    async function fetchDocChunks(docId: string, dealId: string, isFullDoc: boolean): Promise<ChunkRow[]> {
      return db.query(
        `SELECT dc.id AS chunk_id, dc.content AS chunk_text,
                dc.file_name AS source_file, d.document_tag,
                dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.document_id = $1::uuid AND dc.deal_id = $2::uuid AND d.deal_id = $2::uuid
         ORDER BY dc.chunk_index ASC`,
        z.object({
          chunk_id: z.string(),
          chunk_text: z.string(),
          source_file: z.string(),
          document_tag: z.string().nullable(),
          document_id: z.string(),
          chunk_index: z.number(),
        }),
        [docId, dealId],
        { label: isFullDoc
            ? "DcsExtract: fetch full Excel doc for window building"
            : "DcsExtract: fetch doc content for batch" },
      );
    }

    // §3d: Build WorkUnit list from documents in composite order.
    // Fetch content lazily per-document. Stop once we have enough work units
    // to fill the batchSize budget (with one extra document to account for
    // partial windows at the boundary).
    const workUnits: WorkUnit[] = [];
    let estimatedPhysicalChunks = 0;
    // Over-fetch by 2× batchSize to ensure we have enough work units after
    // window building trims some. This keeps the number of per-doc queries small.
    const fetchBudget = input.batchSize * 2;

    for (const docId of docOrder) {
      const docMeta = docMetaMap.get(docId)!;
      const firstMeta = docMeta[0];
      const isExcel = isExcelDocument(firstMeta.document_tag, firstMeta.source_file);

      if (isExcel) {
        // Excel documents: always fetch ALL chunks for the document
        // (needed for window building). Individual Excel docs are 2-3MB,
        // within the gRPC limit.
        const fullDocChunks = await fetchDocChunks(docId, input.dealId, true);

        const physicalChunks: PhysicalChunk[] = fullDocChunks.map(c => ({
          chunk_id: c.chunk_id,
          chunk_index: c.chunk_index,
          content: c.chunk_text,
          document_id: c.document_id,
          source_file: c.source_file,
          document_tag: c.document_tag ?? "other",
        }));

        const windows = buildLogicalWindows(physicalChunks);

        // Skip windows fully processed (no owned chunks in remaining set)
        for (const win of windows) {
          const hasRemainingChunks = win.ownedChunkIds.some(id => allRemainingChunkIds.has(id));
          if (!hasRemainingChunks) continue;

          const chunkById = new Map(fullDocChunks.map(c => [c.chunk_id, c]));
          const ownedChunks = win.ownedChunkIds
            .map(id => chunkById.get(id))
            .filter((c): c is ChunkRow => c !== undefined);

          workUnits.push({
            kind: "excel_logical",
            window: win,
            ownedChunks,
            ownedChunkIds: [...win.ownedChunkIds],
            firstOwnedChunkId: win.firstOwnedChunkId,
            lastOwnedChunkId: win.lastOwnedChunkId,
            analysisText: win.windowText,
            charCount: win.totalChars,
            sourceFile: win.sourceFile,
            documentTag: firstMeta.document_tag,
            documentId: win.documentId,
          });
        }

        estimatedPhysicalChunks += docMeta.length;
      } else {
        // Non-Excel: fetch content only for this document's remaining chunks
        const docChunks = await fetchDocChunks(docId, input.dealId, false);

        for (const chunk of docChunks) {
          if (!allRemainingChunkIds.has(chunk.chunk_id)) continue;
          workUnits.push({
            kind: "physical",
            chunk,
            ownedChunkIds: [chunk.chunk_id],
            firstOwnedChunkId: chunk.chunk_id,
            lastOwnedChunkId: chunk.chunk_id,
            analysisText: chunk.chunk_text,
            charCount: chunk.chunk_text.length,
            sourceFile: chunk.source_file,
            documentTag: chunk.document_tag,
            documentId: chunk.document_id,
          });
        }

        estimatedPhysicalChunks += docMeta.length;
      }

      // Stop fetching more documents once we have enough work units.
      // We need at least batchSize physical chunks worth of work units.
      if (estimatedPhysicalChunks >= fetchBudget) break;
    }

    // §4: Apply batchSize — counts owned physical chunks, not work units
    let physicalChunkBudget = input.batchSize;
    const batchWorkUnits: WorkUnit[] = [];
    for (const wu of workUnits) {
      const cost = wu.ownedChunkIds.length;
      if (physicalChunkBudget <= 0) break;
      batchWorkUnits.push(wu);
      physicalChunkBudget -= cost;
    }

    // ═════════════════════════════════════════════════════════════
    // §5: Concurrent IN-MEMORY analysis with bounded worker pool (5C.2E)
    // ═════════════════════════════════════════════════════════════
    let finalStatus = "running";

    // Effective concurrency: one LLM call per work unit
    const effectiveConcurrency = Math.min(input.concurrency, batchWorkUnits.length);

    // Launch stagger gate: 50ms between successive initial LLM calls
    const STAGGER_MS = 50;
    let lastLaunchTime = 0;
    async function acquireLaunchSlot(): Promise<void> {
      const now = Date.now();
      const gap = lastLaunchTime + STAGGER_MS - now;
      if (gap > 0) {
        await new Promise<void>((r) => setTimeout(r, gap));
      }
      lastLaunchTime = Date.now();
    }

    // Concurrency telemetry
    let activeWorkers = 0;
    let maxObservedConcurrency = 0;
    let llmCallsStartedThisCall = 0;

    // §5: Workers call ONLY analyzeChunk (in-memory). No database writes.
    // For Excel work units, create a synthetic ChunkRow with chunk_text = window text.
    async function analyzeWorkUnitWithStagger(
      wu: WorkUnit,
    ): Promise<AnalysisOutcome> {
      activeWorkers++;
      if (activeWorkers > maxObservedConcurrency) {
        maxObservedConcurrency = activeWorkers;
      }
      try {
        await acquireLaunchSlot();
        llmCallsStartedThisCall++;

        // Build the ChunkRow to pass to analyzeChunk
        let syntheticChunk: ChunkRow;
        if (wu.kind === "excel_logical") {
          // Synthetic ChunkRow: chunk_text is the window text
          syntheticChunk = {
            chunk_id: wu.firstOwnedChunkId,
            chunk_text: wu.analysisText,
            source_file: wu.sourceFile,
            document_tag: wu.documentTag,
            document_id: wu.documentId,
            chunk_index: wu.window.windowIndex,
          };
        } else {
          syntheticChunk = wu.chunk;
        }

        return await analyzeChunk(
          ctx as unknown as PipelineContext,
          syntheticChunk,
          startTime,
          input.debug,
        );
      } finally {
        activeWorkers--;
      }
    }

    // Bounded worker pool: at most effectiveConcurrency active tasks
    type TaskOutcome = { index: number; result?: AnalysisOutcome; error?: string };
    const outcomes: TaskOutcome[] = new Array(batchWorkUnits.length);
    let stopScheduling = false;

    let nextToSchedule = 0;
    const inFlight = new Map<number, Promise<void>>();

    function canLaunchMore(): boolean {
      if (stopScheduling) return false;
      if (nextToSchedule >= batchWorkUnits.length) return false;
      if (inFlight.size >= effectiveConcurrency) return false;
      const remaining = INVOCATION_BUDGET_MS - (Date.now() - startTime);
      if (remaining < MIN_CALL_HEADROOM_MS + MAX_PER_CALL_MS) return false;
      return true;
    }

    function scheduleOne(): void {
      const idx = nextToSchedule++;
      const wu = batchWorkUnits[idx];

      const task = analyzeWorkUnitWithStagger(wu)
        .then((result) => {
          outcomes[idx] = { index: idx, result };
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          outcomes[idx] = { index: idx, error: errMsg.slice(0, 500) };
          stopScheduling = true;
        })
        .finally(() => {
          inFlight.delete(idx);
        });

      inFlight.set(idx, task);
    }

    // Fill initial slots
    while (canLaunchMore()) {
      scheduleOne();
    }

    // Pump: when a slot frees up, schedule next if allowed
    while (inFlight.size > 0) {
      await Promise.race(inFlight.values());
      while (canLaunchMore()) {
        scheduleOne();
      }
    }

    // ═════════════════════════════════════════════════════════════
    // §6–§8: Ordered commit walk with physical mapping (5C.2E)
    // ═════════════════════════════════════════════════════════════
    //
    // Walk work units in composite order.
    // For each work unit, persist evidence to EACH owned physical chunk.
    // For Excel: use mapSnippetToPhysicalChunk to route evidence items.
    // Cursor advances to lastOwnedChunkId of each work unit.
    // processed_count increments by ownedChunkIds.length (physical chunks).

    // §10 telemetry accumulators
    let excelWindowsProcessedThisCall = 0;
    let pdfWindowsProcessedThisCall = 0;
    let physicalChunksCoveredThisCall = 0;
    let physicalMappingRejectedThisCall = 0;
    let totalExcelWindowChars = 0;
    let maxExcelWindowChars = 0;

    for (let i = 0; i < batchWorkUnits.length; i++) {
      const outcome = outcomes[i];
      const wu = batchWorkUnits[i];

      // NOT STARTED: budget ran out before this work unit was scheduled
      if (!outcome) {
        break;
      }

      // §8: FAILURE — stop at first failed work unit
      if (outcome.error != null) {
        const bounded = outcome.error;
        await db.execute(
          `UPDATE dcs_pipeline_state
           SET status = 'failed', detail = $1, updated_at = now()
           WHERE id = $2::uuid`,
          [
            JSON.stringify({
              ...cumulative,
              error: bounded,
              failed_chunk: wu.firstOwnedChunkId,
            }),
            stateId,
          ],
          { label: "DcsExtract: mark extract failed" },
        );
        throw new Error(`DcsExtract failed on work unit ${wu.firstOwnedChunkId}: ${bounded}`);
      }

      // SUCCESS: map and persist evidence per physical chunk
      const analysisResult = outcome.result!;

      if (wu.kind === "excel_logical") {
        // §6: Map each accepted evidence item to a physical chunk
        // Build per-chunk evidence buckets
        const chunkEvidenceMap = new Map<string, PresenceItem[]>();
        for (const chunkId of wu.ownedChunkIds) {
          chunkEvidenceMap.set(chunkId, []);
        }

        let wuMappingRejected = 0;
        for (const item of analysisResult.accepted) {
          const mapping = mapSnippetToPhysicalChunk(wu.window, item.snippet);
          if (mapping.foundInPrimary && mapping.mappedChunkId && chunkEvidenceMap.has(mapping.mappedChunkId)) {
            chunkEvidenceMap.get(mapping.mappedChunkId)!.push(item);
          } else {
            // Context-only or unmapped snippet — rejected
            wuMappingRejected++;
          }
        }

        // §7: Persist evidence for each owned physical chunk in order
        let wuRowsWritten = 0;
        let wuEmptyChunks = 0;

        for (const physChunkId of wu.ownedChunkIds) {
          const chunkItems = chunkEvidenceMap.get(physChunkId) ?? [];
          const physChunk = wu.ownedChunks.find(c => c.chunk_id === physChunkId);
          if (!physChunk) {
            throw new Error(`Physical chunk ${physChunkId} not found in work unit owned chunks`);
          }

          // Build a per-chunk AnalysisOutcome for persistChunkEvidence
          const perChunkOutcome: AnalysisOutcome = {
            chunkId: physChunkId,
            sourceFile: physChunk.source_file,
            documentTag: physChunk.document_tag ?? "other",
            docClass: analysisResult.docClass,
            accepted: chunkItems,
            fabricationRejected: 0,
            invalidDimensionRejected: 0,
            duplicateDimensionRejected: 0,
            jsonRepairApplied: false,
            semanticRetryAttempted: false,
            semanticRetryRecovered: false,
            traceEntry: null,
          };

          let rowsWritten: number;
          try {
            rowsWritten = await persistChunkEvidence(db, input.runId, physChunk, perChunkOutcome);
          } catch (persistErr) {
            const pMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
            await db.execute(
              `UPDATE dcs_pipeline_state
               SET status = 'failed', detail = $1, updated_at = now()
               WHERE id = $2::uuid`,
              [
                JSON.stringify({
                  ...cumulative,
                  error: `Evidence persistence failed: ${pMsg.slice(0, 400)}`,
                  failed_chunk: physChunkId,
                }),
                stateId,
              ],
              { label: "DcsExtract: mark failed on persistence error" },
            );
            throw new Error(`DcsExtract persistence failed on chunk ${physChunkId}: ${pMsg.slice(0, 400)}`);
          }

          wuRowsWritten += rowsWritten;
          if (rowsWritten === 0) wuEmptyChunks++;

          // Advance cumulative per physical chunk
          const nextCumulative: CumulativeDetail = {
            ...cumulative,
            processed_count: cumulative.processed_count + 1,
            evidence_rows_written: cumulative.evidence_rows_written + rowsWritten,
            empty_chunk_count: cumulative.empty_chunk_count + (rowsWritten === 0 ? 1 : 0),
            fabrication_rejected: cumulative.fabrication_rejected,
            invalid_dimension_rejected: cumulative.invalid_dimension_rejected,
            duplicate_dimension_rejected: cumulative.duplicate_dimension_rejected,
            last_chunk_id: physChunkId,
            json_repair_applied: cumulative.json_repair_applied,
            semantic_retry_attempted: cumulative.semantic_retry_attempted,
            semantic_retry_recovered: cumulative.semantic_retry_recovered,
            physical_mapping_rejected: cumulative.physical_mapping_rejected,
          };
          const nextCursor = physChunkId;

          try {
            await db.execute(
              `UPDATE dcs_pipeline_state
               SET cursor_value = $1, detail = $2, status = 'running', updated_at = now()
               WHERE id = $3::uuid`,
              [nextCursor, JSON.stringify(nextCumulative), stateId],
              { label: `DcsExtract: advance cursor to ${physChunkId.slice(0, 8)}` },
            );
          } catch (cpErr) {
            const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
            await db.execute(
              `UPDATE dcs_pipeline_state
               SET status = 'failed', detail = $1, updated_at = now()
               WHERE id = $2::uuid`,
              [
                JSON.stringify({
                  ...cumulative,
                  error: `Checkpoint failed: ${cpMsg.slice(0, 400)}`,
                  failed_chunk: physChunkId,
                }),
                stateId,
              ],
              { label: "DcsExtract: mark failed on checkpoint error" },
            );
            throw new Error(`DcsExtract checkpoint failed on chunk ${physChunkId}: ${cpMsg.slice(0, 400)}`);
          }

          cumulative = nextCumulative;
          cursorValue = nextCursor;
          processedThisCall++;
        }

        // Work-unit-level accounting (only after all physical chunks committed)
        rowsWrittenThisCall += wuRowsWritten;
        emptyChunksThisCall += wuEmptyChunks;
        // Rejection counters apply at work-unit level (from the single LLM call)
        fabricationRejectedThisCall += analysisResult.fabricationRejected;
        invalidDimensionRejectedThisCall += analysisResult.invalidDimensionRejected;
        duplicateDimensionRejectedThisCall += analysisResult.duplicateDimensionRejected;
        if (analysisResult.jsonRepairApplied) jsonRepairsAppliedThisCall++;
        if (analysisResult.semanticRetryAttempted) semanticRetriesThisCall++;
        if (analysisResult.semanticRetryRecovered) semanticRetryRecoveriesThisCall++;
        if (analysisResult.traceEntry) trace.push(analysisResult.traceEntry);

        // Update cumulative rejection counters (only at work-unit boundary)
        cumulative = {
          ...cumulative,
          fabrication_rejected: cumulative.fabrication_rejected + analysisResult.fabricationRejected,
          invalid_dimension_rejected: cumulative.invalid_dimension_rejected + analysisResult.invalidDimensionRejected,
          duplicate_dimension_rejected: cumulative.duplicate_dimension_rejected + analysisResult.duplicateDimensionRejected,
          json_repair_applied: cumulative.json_repair_applied + (analysisResult.jsonRepairApplied ? 1 : 0),
          semantic_retry_attempted: cumulative.semantic_retry_attempted + (analysisResult.semanticRetryAttempted ? 1 : 0),
          semantic_retry_recovered: cumulative.semantic_retry_recovered + (analysisResult.semanticRetryRecovered ? 1 : 0),
          physical_mapping_rejected: cumulative.physical_mapping_rejected + wuMappingRejected,
        };

        physicalMappingRejectedThisCall += wuMappingRejected;

        // Telemetry
        excelWindowsProcessedThisCall++;
        physicalChunksCoveredThisCall += wu.ownedChunkIds.length;
        totalExcelWindowChars += wu.charCount;
        if (wu.charCount > maxExcelWindowChars) maxExcelWindowChars = wu.charCount;

      } else {
        // §7: Physical work unit — same as original per-chunk path
        let rowsWritten: number;
        try {
          rowsWritten = await persistChunkEvidence(db, input.runId, wu.chunk, analysisResult);
        } catch (persistErr) {
          const pMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET status = 'failed', detail = $1, updated_at = now()
             WHERE id = $2::uuid`,
            [
              JSON.stringify({
                ...cumulative,
                error: `Evidence persistence failed: ${pMsg.slice(0, 400)}`,
                failed_chunk: wu.chunk.chunk_id,
              }),
              stateId,
            ],
            { label: "DcsExtract: mark failed on persistence error" },
          );
          throw new Error(`DcsExtract persistence failed on chunk ${wu.chunk.chunk_id}: ${pMsg.slice(0, 400)}`);
        }

        const nextCumulative: CumulativeDetail = {
          ...cumulative,
          processed_count: cumulative.processed_count + 1,
          evidence_rows_written: cumulative.evidence_rows_written + rowsWritten,
          empty_chunk_count: cumulative.empty_chunk_count + (rowsWritten === 0 ? 1 : 0),
          fabrication_rejected: cumulative.fabrication_rejected + analysisResult.fabricationRejected,
          invalid_dimension_rejected: cumulative.invalid_dimension_rejected + analysisResult.invalidDimensionRejected,
          duplicate_dimension_rejected: cumulative.duplicate_dimension_rejected + analysisResult.duplicateDimensionRejected,
          last_chunk_id: wu.chunk.chunk_id,
          json_repair_applied: cumulative.json_repair_applied + (analysisResult.jsonRepairApplied ? 1 : 0),
          semantic_retry_attempted: cumulative.semantic_retry_attempted + (analysisResult.semanticRetryAttempted ? 1 : 0),
          semantic_retry_recovered: cumulative.semantic_retry_recovered + (analysisResult.semanticRetryRecovered ? 1 : 0),
        };
        const nextCursor = wu.chunk.chunk_id;

        try {
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET cursor_value = $1, detail = $2, status = 'running', updated_at = now()
             WHERE id = $3::uuid`,
            [nextCursor, JSON.stringify(nextCumulative), stateId],
            { label: `DcsExtract: advance cursor to ${wu.chunk.chunk_id.slice(0, 8)}` },
          );
        } catch (cpErr) {
          const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET status = 'failed', detail = $1, updated_at = now()
             WHERE id = $2::uuid`,
            [
              JSON.stringify({
                ...cumulative,
                error: `Checkpoint failed: ${cpMsg.slice(0, 400)}`,
                failed_chunk: wu.chunk.chunk_id,
              }),
              stateId,
            ],
            { label: "DcsExtract: mark failed on checkpoint error" },
          );
          throw new Error(`DcsExtract checkpoint failed on chunk ${wu.chunk.chunk_id}: ${cpMsg.slice(0, 400)}`);
        }

        cumulative = nextCumulative;
        cursorValue = nextCursor;
        processedThisCall++;
        rowsWrittenThisCall += rowsWritten;
        if (rowsWritten === 0) emptyChunksThisCall++;
        fabricationRejectedThisCall += analysisResult.fabricationRejected;
        invalidDimensionRejectedThisCall += analysisResult.invalidDimensionRejected;
        duplicateDimensionRejectedThisCall += analysisResult.duplicateDimensionRejected;
        if (analysisResult.jsonRepairApplied) jsonRepairsAppliedThisCall++;
        if (analysisResult.semanticRetryAttempted) semanticRetriesThisCall++;
        if (analysisResult.semanticRetryRecovered) semanticRetryRecoveriesThisCall++;
        if (analysisResult.traceEntry) trace.push(analysisResult.traceEntry);

        // Telemetry
        pdfWindowsProcessedThisCall++;
        physicalChunksCoveredThisCall++;
      }
    }

    // ═════════════════════════════════════════════════════════════
    // §9: Remaining count & completion (5C.2E)
    // ═════════════════════════════════════════════════════════════
    // Remaining always counts physical chunks (not work units).
    let remainingChunks: number;
    if (cursorValue) {
      const curAnchor = await db.query(
        `SELECT dc.document_id, dc.chunk_index
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.id = $1::uuid AND dc.deal_id = $2::uuid AND d.deal_id = $2::uuid
         LIMIT 1`,
        z.object({ document_id: z.string(), chunk_index: z.number() }),
        [cursorValue, input.dealId],
        { label: "DcsExtract: resolve cursor for remaining count" },
      );
      if (curAnchor.length === 0) {
        throw new Error(`Cursor ${cursorValue} lost after checkpoint — data integrity error`);
      }
      const remResult = await db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
           AND (dc.document_id::text, dc.chunk_index) > ($2::text, $3::int)`,
        z.object({ cnt: z.number() }),
        [input.dealId, curAnchor[0].document_id, curAnchor[0].chunk_index],
        { label: "DcsExtract: count remaining chunks (composite)" },
      );
      remainingChunks = remResult[0]?.cnt ?? 0;
    } else {
      const remResult = await db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [input.dealId],
        { label: "DcsExtract: count remaining chunks (no cursor)" },
      );
      remainingChunks = remResult[0]?.cnt ?? 0;
    }

    // Completion check with authoritative last physical chunk
    if (remainingChunks === 0) {
      const lastChunkRows = await db.query(
        `SELECT dc.id AS chunk_id
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
         ORDER BY dc.document_id::text DESC, dc.chunk_index DESC
         LIMIT 1`,
        z.object({ chunk_id: z.string() }),
        [input.dealId],
        { label: "DcsExtract: find authoritative last chunk" },
      );

      if (lastChunkRows.length > 0) {
        const authLastChunkId = lastChunkRows[0].chunk_id;
        const completionValid =
          cumulative.processed_count === totalChunks &&
          cursorValue === authLastChunkId &&
          cumulative.last_chunk_id === authLastChunkId;

        if (!completionValid) {
          const errMsg =
            `Completion invariant violated: processed_count=${cumulative.processed_count} ` +
            `totalChunks=${totalChunks} cursorValue=${cursorValue} ` +
            `last_chunk_id=${cumulative.last_chunk_id} authLastChunkId=${authLastChunkId}`;
          await db.execute(
            `UPDATE dcs_pipeline_state
             SET status = 'failed', detail = $1, updated_at = now()
             WHERE id = $2::uuid`,
            [
              JSON.stringify({
                ...cumulative,
                error: errMsg,
              }),
              stateId,
            ],
            { label: "DcsExtract: mark failed on completion invariant" },
          );
          throw new Error(`DcsExtract: ${errMsg}`);
        }
      }

      finalStatus = "done";
      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'done', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify(cumulative), stateId],
        { label: "DcsExtract: mark extract done" },
      );
    }

    // §10: Output telemetry
    const logicalWindowsProcessedThisCall = excelWindowsProcessedThisCall + pdfWindowsProcessedThisCall;
    const averageExcelWindowChars = excelWindowsProcessedThisCall > 0
      ? Math.round(totalExcelWindowChars / excelWindowsProcessedThisCall)
      : 0;

    if (mode !== "verification") {
      console.log(
        `[DcsExtract] run=${input.runId.slice(0, 8)} processed=${processedThisCall} ` +
        `written=${rowsWrittenThisCall} fabricationRejected=${fabricationRejectedThisCall} ` +
        `cursor=${cursorValue ?? "null"} remaining=${remainingChunks} status=${finalStatus} ` +
        `excelWindows=${excelWindowsProcessedThisCall} pdfChunks=${pdfWindowsProcessedThisCall} ` +
        `mappingRejected=${physicalMappingRejectedThisCall}`,
      );
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
      configuredConcurrency: effectiveConcurrency,
      maxObservedConcurrency,
      llmCallsStartedThisCall,
      staggerMs: STAGGER_MS,
      jsonRepairsAppliedThisCall,
      semanticRetriesThisCall,
      semanticRetryRecoveriesThisCall,
      // §10: New telemetry fields (5C.2E)
      logicalWindowsProcessedThisCall,
      excelWindowsProcessedThisCall,
      pdfWindowsProcessedThisCall,
      physicalChunksCoveredThisCall,
      averageExcelWindowChars,
      largestExcelWindowChars: maxExcelWindowChars,
      physicalMappingRejectedThisCall,
      effectiveWorkUnitVersion: WORK_UNIT_VERSION,
    };
  },
});

// ═════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════

interface ChunkRow {
  chunk_id: string;
  chunk_text: string;
  source_file: string;
  document_tag: string | null;
  document_id: string;
  chunk_index: number;
}

// ═════════════════════════════════════════════════════════════════
// D1: In-memory analysis outcome
// ═════════════════════════════════════════════════════════════════

/** In-memory analysis result. Contains NO database references. */
interface AnalysisOutcome {
  /** Physical chunk identity */
  chunkId: string;
  sourceFile: string;
  documentTag: string;
  docClass: string;
  /** Accepted evidence items ready for persistence */
  accepted: PresenceItem[];
  /** Rejection counters */
  fabricationRejected: number;
  invalidDimensionRejected: number;
  duplicateDimensionRejected: number;
  /** Recovery flags */
  jsonRepairApplied: boolean;
  semanticRetryAttempted: boolean;
  semanticRetryRecovered: boolean;
  /** Optional debug trace entry */
  traceEntry: TraceEntry | null;
}

// ═════════════════════════════════════════════════════════════════
// §2: Unified Work-Unit type (5C.2E)
// ═════════════════════════════════════════════════════════════════

/** One physical chunk — used for all non-Excel documents. */
interface PhysicalWorkUnit {
  kind: "physical";
  chunk: ChunkRow;
  /** Single-element array for uniform iteration in commit walk. */
  ownedChunkIds: [string];
  firstOwnedChunkId: string;
  lastOwnedChunkId: string;
  /** Text sent to the model (= chunk_text). */
  analysisText: string;
  charCount: number;
  sourceFile: string;
  documentTag: string | null;
  documentId: string;
}

/** One logical Excel window covering ≥1 physical chunks. */
interface ExcelWorkUnit {
  kind: "excel_logical";
  window: LogicalWindow;
  /** Ordered physical chunks owned by this window (chunk_index ASC). */
  ownedChunks: ChunkRow[];
  /** Physical chunk IDs in composite order. */
  ownedChunkIds: string[];
  firstOwnedChunkId: string;
  lastOwnedChunkId: string;
  /** Text sent to the model (= window.windowText). */
  analysisText: string;
  charCount: number;
  sourceFile: string;
  documentTag: string | null;
  documentId: string;
}

/** Discriminated union: the scheduler produces these; workers consume them. */
type WorkUnit = PhysicalWorkUnit | ExcelWorkUnit;

// ═════════════════════════════════════════════════════════════════
// D1: In-memory analysis function — NO database access
// ═════════════════════════════════════════════════════════════════

/**
 * Analyze a single chunk through the model. Returns an in-memory outcome.
 *
 * This function MAY:
 *   - call the configured model via callLLMWithHeadroom
 *   - normalize fences, parse JSON, apply repair, perform semantic retry
 *   - validate dimensions, anchor snippets, deduplicate
 *   - build debug trace data
 *   - return an outcome or throw
 *
 * This function MUST NOT:
 *   - call db.execute or db.query
 *   - replay-delete evidence
 *   - insert evidence
 *   - update dcs_pipeline_state
 *   - advance cursorValue
 *   - mutate cumulative or call-local counters
 */
async function analyzeChunk(
  pipelineCtx: PipelineContext,
  chunk: ChunkRow,
  invocationStartTime: number,
  debug: boolean,
): Promise<AnalysisOutcome> {
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

  // ── Validation pipeline (D4 order) ────────────────────────────
  // 1. fence normalization (done above)
  // 2. direct JSON.parse
  // 3. targeted snippet-quote repair (D2) — only if direct parse failed
  // 4. JSON.parse of repaired payload
  // 5. whole-array PresenceItem schema validation
  // If both fail → one semantic retry (D3), then same pipeline again

  let jsonRepairApplied = false;
  let semanticRetryAttempted = false;
  let semanticRetryRecovered = false;

  function attemptParseAndValidate(payload: string): { items: PresenceItem[] } | { error: string; phase: "parse" | "schema" } {
    // Step 2: direct JSON.parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Step 3–4: targeted snippet-quote repair
      const repaired = repairSnippetQuotes(payload);
      if (repaired != null) {
        jsonRepairApplied = true;
        parsed = repaired;
      } else {
        return { error: `Invalid JSON in response for chunk ${chunk.chunk_id}: ${payload.slice(0, 200)}`, phase: "parse" };
      }
    }

    // Step 5: whole-array schema validation
    const arrayResult = z.array(PresenceItem).safeParse(parsed);
    if (!arrayResult.success) {
      return { error: `Schema validation failed for chunk ${chunk.chunk_id}: ${arrayResult.error.message.slice(0, 300)}`, phase: "schema" };
    }

    return { items: arrayResult.data };
  }

  let firstResult = attemptParseAndValidate(jsonToParse);
  let items: PresenceItem[];

  if ("error" in firstResult) {
    // ── Semantic retry (D3): one correction attempt ──────────
    semanticRetryAttempted = true;

    const retryElapsed = Date.now() - invocationStartTime;
    const retryRemaining = INVOCATION_BUDGET_MS - retryElapsed;
    const retryTimeout = Math.min(MAX_PER_CALL_MS, retryRemaining - 15_000);

    if (retryTimeout < MIN_CALL_HEADROOM_MS) {
      throw new Error(firstResult.error);
    }

    let retryResponse;
    try {
      retryResponse = await callLLMWithHeadroom(
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
            {
              role: "assistant",
              content: "I will analyze this chunk.",
            },
            {
              role: "user",
              content: `Your prior response was invalid (${firstResult.phase === "parse" ? "malformed JSON" : "schema validation failed"}). Please try again.

CRITICAL REMINDERS:
- Return ONLY a raw JSON array, no Markdown fences, no prose
- Keys in exact order: dimension_id, snippet, is_substantive
- Escape all quotation marks inside snippet values as \\"
- CSV-quoted cells like "1,121,037" must be escaped as \\"1,121,037\\"
- Return [] if no dimensions are covered`,
            },
          ],
        },
        `DcsExtract: RETRY chunk ${chunk.chunk_id.slice(0, 8)} (${chunk.source_file})`,
        {
          pipelineStartTime: invocationStartTime,
          maxPerCallTimeout: retryTimeout,
          retries: 1,
          minBudget: MIN_CALL_HEADROOM_MS,
        },
      );
    } catch {
      throw new Error(firstResult.error);
    }

    const retryRaw = retryResponse.content[0]?.text ?? "";
    const retryTrimmed = retryRaw.trim();

    // Apply same fence normalization to retry response
    let retryPayload: string;
    if (retryTrimmed.startsWith("[")) {
      retryPayload = retryTrimmed;
    } else if (retryTrimmed.startsWith("```")) {
      const closingIdx = retryTrimmed.lastIndexOf("```");
      if (closingIdx <= 3) throw new Error(firstResult.error);
      const firstNewline = retryTrimmed.indexOf("\n");
      if (firstNewline === -1) throw new Error(firstResult.error);
      const openingLine = retryTrimmed.slice(3, firstNewline).trim().toLowerCase();
      if (openingLine !== "" && openingLine !== "json") throw new Error(firstResult.error);
      const afterClose = retryTrimmed.slice(closingIdx + 3).trim();
      if (afterClose !== "") throw new Error(firstResult.error);
      const enclosed = retryTrimmed.slice(firstNewline + 1, closingIdx);
      if (enclosed.includes("```")) throw new Error(firstResult.error);
      retryPayload = enclosed.trim();
    } else {
      throw new Error(firstResult.error);
    }

    // Reset repair flag for retry attempt
    jsonRepairApplied = false;
    const retryResult = attemptParseAndValidate(retryPayload);

    if ("error" in retryResult) {
      // Correction response also failed — fail the chunk
      throw new Error(firstResult.error);
    }

    semanticRetryRecovered = true;
    items = retryResult.items;
  } else {
    items = firstResult.items;
  }

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

  // ── Build trace entry (in-memory only) ────────────────────────
  let traceEntry: TraceEntry | null = null;
  if (debug) {
    traceEntry = {
      chunk_id: chunk.chunk_id,
      source_file: chunk.source_file,
      document_tag: storedTag,
      doc_class: docClass,
      raw_model_response: rawText,
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
    chunkId: chunk.chunk_id,
    sourceFile: chunk.source_file,
    documentTag: storedTag,
    docClass,
    accepted,
    fabricationRejected,
    invalidDimensionRejected,
    duplicateDimensionRejected,
    jsonRepairApplied,
    semanticRetryAttempted,
    semanticRetryRecovered,
    traceEntry,
  };
}

// ═════════════════════════════════════════════════════════════════
// D2: Explicit persistence function — ONLY called from ordered commit
// ═════════════════════════════════════════════════════════════════

/**
 * Persist evidence for a single physical chunk.
 *
 * Called ONLY by the ordered commit walk or verification mode.
 *
 * This function MUST:
 *   1. Replay-delete dcs_evidence for run_id + chunk_id
 *   2. Insert accepted evidence rows for that physical chunk
 *   3. Return the number of rows successfully written
 *
 * This function MUST NOT:
 *   - update pipeline state
 *   - mutate cumulative
 *   - advance the cursor
 *   - increment call-local counters
 */
async function persistChunkEvidence(
  db: any,
  runId: string,
  chunk: ChunkRow,
  outcome: AnalysisOutcome,
): Promise<number> {
  // ── Replay safety: delete existing rows for this run+chunk ───
  await db.execute(
    `DELETE FROM dcs_evidence WHERE run_id = $1::uuid AND chunk_id = $2`,
    [runId, chunk.chunk_id],
    { label: `DcsExtract: replay-delete chunk ${chunk.chunk_id.slice(0, 8)}` },
  );

  // ── Insert accepted rows ─────────────────────────────────────
  for (const item of outcome.accepted) {
    await db.execute(
      `INSERT INTO dcs_evidence
         (run_id, dimension_id, chunk_id, source_file, document_tag, doc_class, is_substantive, snippet)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [
        runId,
        item.dimension_id,
        chunk.chunk_id,
        chunk.source_file,
        outcome.documentTag,
        outcome.docClass,
        item.is_substantive,
        item.snippet,
      ],
      { label: `DcsExtract: insert evidence ${item.dimension_id} for chunk ${chunk.chunk_id.slice(0, 8)}` },
    );
  }

  return outcome.accepted.length;
}
