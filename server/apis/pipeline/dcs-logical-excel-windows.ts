/**
 * DCS Logical Excel Windows — pure, model-free, I/O-free helper.
 *
 * Combines adjacent physical 2,000-character document_chunks from Excel
 * documents into deterministic 10,000-character row-aware logical windows.
 *
 * DESIGN:
 *   - Reconstructs original parsed text from overlapping physical chunks
 *   - Parses CSV records with a quote-aware state machine (LF & CRLF)
 *   - Groups complete records into windows ≤ 10,000 characters
 *   - Each window includes sheet marker + header + one prior-row context
 *   - Maps every accepted snippet back to physical chunk IDs + source offset
 *   - Preserves physical-chunk-level checkpoint accounting
 *   - Zero-owned windows are merged into an adjacent same-sheet window
 *
 * HARD CONSTRAINT: this file performs NO I/O. It must not import the
 * database integration, the Anthropic integration, or the Superblocks
 * api helper. It is pure functions only.
 */

// ═══════════════════════════════════════════════════════════════════
// 1. Types
// ═══════════════════════════════════════════════════════════════════

/** Input physical chunk — must be provided in chunk_index order. */
export interface PhysicalChunk {
  chunk_id: string;
  chunk_index: number;
  content: string;
  document_id: string;
  source_file: string;
  document_tag: string;
}

/** Source range within the reconstructed document text. */
export interface SourceRange {
  startOffset: number;
  endOffset: number; // exclusive
}

/** Physical chunk source mapping after reconstruction. */
export interface ChunkSourceMap {
  chunk_id: string;
  chunk_index: number;
  /** Complete range including overlap with adjacent chunks. */
  completeRange: SourceRange;
  /** Unique contributed range after overlap removal. */
  uniqueRange: SourceRange;
}

/** A logical window produced by the planner. */
export interface LogicalWindow {
  /** Deterministic zero-based window index across the entire document. */
  windowIndex: number;
  /** Source file name. */
  sourceFile: string;
  /** Document ID. */
  documentId: string;
  /** Document tag. */
  documentTag: string;
  /** Complete window text sent to the model. */
  windowText: string;
  /** Total characters in window text. */
  totalChars: number;
  /** Characters in the primary (owned) range. */
  primaryChars: number;
  /** Characters in context ranges (header repeat, prior-row, etc.). */
  contextChars: number;
  /** Primary source range — the non-overlapping content this window owns. */
  primaryRange: SourceRange;
  /** Context-only source ranges (repeated header, prior row). */
  contextRanges: SourceRange[];
  /** Ordered physical chunk IDs owned by this window. */
  ownedChunkIds: string[];
  /** Physical source-range metadata for snippet mapping. */
  chunkSourceMaps: ChunkSourceMap[];
  /** First owned physical chunk ID. */
  firstOwnedChunkId: string;
  /** Last owned physical chunk ID. */
  lastOwnedChunkId: string;
  /** Sheet name for this window. */
  sheetName: string;
  /** Whether this is an empty/header-only sheet window. */
  isHeaderOnly: boolean;
}

/** Parsed sheet from the reconstructed text. */
interface ParsedSheet {
  /** Sheet name from the marker. */
  name: string;
  /** Full sheet marker line (e.g., "--- Sheet: FS Summary ---"). */
  markerLine: string;
  /** Optional title/context line starting with #. */
  titleLine: string | null;
  /** Detected CSV header line. */
  headerLine: string | null;
  /** Ordered complete data records (each is a complete CSV record). */
  dataRecords: string[];
  /** Start offset in reconstructed text. */
  startOffset: number;
  /** End offset in reconstructed text (exclusive). */
  endOffset: number;
  /** Start offset of each data record in reconstructed text. */
  recordOffsets: number[];
  /** End offset of each data record in reconstructed text (exclusive). */
  recordEndOffsets: number[];
}

// ═══════════════════════════════════════════════════════════════════
// 2. Constants
// ═══════════════════════════════════════════════════════════════════

const MAX_WINDOW_CHARS = 10_000;
const PHYSICAL_OVERLAP = 200;
const SHEET_MARKER_RE = /^--- Sheet: (.+) ---$/;

// ═══════════════════════════════════════════════════════════════════
// 3. Reconstruction
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate physical chunks and reconstruct the original parsed text.
 *
 * Validates:
 *   - Non-empty input
 *   - Contiguous chunk_index starting at 0
 *   - 200-character overlap consistency
 *   - All chunks share the same document_id, source_file, document_tag
 *
 * @throws on any invariant violation.
 * @returns The reconstructed text and per-chunk source maps.
 */
export function reconstructDocument(
  chunks: readonly PhysicalChunk[],
): { text: string; chunkMaps: ChunkSourceMap[] } {
  if (chunks.length === 0) {
    throw new Error("reconstructDocument: empty chunk array");
  }

  const docId = chunks[0].document_id;
  const fileName = chunks[0].source_file;
  const docTag = chunks[0].document_tag;

  // Validate first chunk_index is 0
  if (chunks[0].chunk_index !== 0) {
    throw new Error(
      `reconstructDocument: first chunk_index is ${chunks[0].chunk_index}, expected 0 ` +
      `(document=${docId}, file=${fileName})`,
    );
  }

  // Validate contiguity, uniqueness, and document consistency
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];

    // Document consistency: all chunks must share document_id, source_file, document_tag
    if (curr.document_id !== docId) {
      throw new Error(
        `reconstructDocument: chunk ${curr.chunk_index} has document_id "${curr.document_id}" ` +
        `but expected "${docId}" (file=${fileName})`,
      );
    }
    if (curr.source_file !== fileName) {
      throw new Error(
        `reconstructDocument: chunk ${curr.chunk_index} has source_file "${curr.source_file}" ` +
        `but expected "${fileName}" (document=${docId})`,
      );
    }
    if (curr.document_tag !== docTag) {
      throw new Error(
        `reconstructDocument: chunk ${curr.chunk_index} has document_tag "${curr.document_tag}" ` +
        `but expected "${docTag}" (document=${docId}, file=${fileName})`,
      );
    }

    if (curr.chunk_index !== prev.chunk_index + 1) {
      throw new Error(
        `reconstructDocument: non-contiguous chunk_index: ${prev.chunk_index} → ${curr.chunk_index} ` +
        `(document=${docId}, file=${fileName})`,
      );
    }

    if (curr.chunk_index === prev.chunk_index) {
      throw new Error(
        `reconstructDocument: duplicate chunk_index ${curr.chunk_index} ` +
        `(document=${docId}, file=${fileName})`,
      );
    }

    // Validate 200-character overlap
    if (curr.content.length >= PHYSICAL_OVERLAP && prev.content.length >= PHYSICAL_OVERLAP) {
      const prevTail = prev.content.slice(-PHYSICAL_OVERLAP);
      const currHead = curr.content.slice(0, PHYSICAL_OVERLAP);
      if (prevTail !== currHead) {
        throw new Error(
          `reconstructDocument: 200-character overlap mismatch between chunk_index ` +
          `${prev.chunk_index} and ${curr.chunk_index} ` +
          `(document=${docId}, file=${fileName})`,
        );
      }
    }
  }

  // Reconstruct text
  const parts: string[] = [chunks[0].content];
  const chunkMaps: ChunkSourceMap[] = [];

  // Chunk 0: complete range = unique range
  chunkMaps.push({
    chunk_id: chunks[0].chunk_id,
    chunk_index: 0,
    completeRange: { startOffset: 0, endOffset: chunks[0].content.length },
    uniqueRange: { startOffset: 0, endOffset: chunks[0].content.length },
  });

  let offset = chunks[0].content.length;

  for (let i = 1; i < chunks.length; i++) {
    const contribution = chunks[i].content.slice(PHYSICAL_OVERLAP);
    parts.push(contribution);

    const completeStart = offset - PHYSICAL_OVERLAP;
    const completeEnd = offset + contribution.length;
    const uniqueStart = offset;
    const uniqueEnd = completeEnd;

    chunkMaps.push({
      chunk_id: chunks[i].chunk_id,
      chunk_index: chunks[i].chunk_index,
      completeRange: { startOffset: completeStart, endOffset: completeEnd },
      uniqueRange: { startOffset: uniqueStart, endOffset: uniqueEnd },
    });

    offset += contribution.length;
  }

  return { text: parts.join(""), chunkMaps };
}

// ═══════════════════════════════════════════════════════════════════
// 4. CSV Record Parsing (quote-aware state machine)
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse CSV text into complete records using a quote-aware state machine.
 * Handles: quoted commas, doubled quotation marks, embedded newlines,
 * both CRLF and LF line endings.
 *
 * Returns an array of { record, startOffset, endOffset } where offsets
 * are relative to the input text (inclusive of baseOffset).
 */
export function parseCsvRecords(
  text: string,
  baseOffset: number = 0,
): Array<{ record: string; startOffset: number; endOffset: number }> {
  const records: Array<{ record: string; startOffset: number; endOffset: number }> = [];

  let inQuote = false;
  let recordStart = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        // Check for doubled quote (escaped quote inside field)
        if (i + 1 < text.length && text[i + 1] === '"') {
          i++; // skip the second quote
        } else {
          inQuote = false;
        }
      }
      // All other chars (including \n, \r) inside quotes are data
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        // CRLF line ending — treat \r\n as a single record separator
        const record = text.slice(recordStart, i); // exclude the \r
        if (record.length > 0) {
          records.push({
            record,
            startOffset: baseOffset + recordStart,
            endOffset: baseOffset + i, // exclusive, before the \r
          });
        }
        i++; // skip the \n (the \r is already consumed)
        recordStart = i + 1;
      } else if (ch === '\n') {
        const record = text.slice(recordStart, i);
        if (record.length > 0) {
          records.push({
            record,
            startOffset: baseOffset + recordStart,
            endOffset: baseOffset + i, // exclusive, before the \n
          });
        }
        recordStart = i + 1;
      }
    }
  }

  // Handle final record without trailing newline
  if (recordStart < text.length) {
    const record = text.slice(recordStart);
    if (record.length > 0) {
      records.push({
        record,
        startOffset: baseOffset + recordStart,
        endOffset: baseOffset + text.length,
      });
    }
  }

  return records;
}

// ═══════════════════════════════════════════════════════════════════
// 5. Sheet Parsing
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse the reconstructed text into sheets.
 * Each sheet starts with a `--- Sheet: <name> ---` marker.
 *
 * Content before the first sheet marker (if any) is treated as a
 * preamble sheet with name "__preamble__".
 */
export function parseSheets(
  text: string,
): ParsedSheet[] {
  // Find all sheet marker positions
  const markerPositions: Array<{ name: string; markerLine: string; offset: number }> = [];

  // Scan for sheet markers using simple line splitting.
  // Sheet markers are structural and never contain quotes/commas that
  // would confuse a simple \n split. They are always complete lines.
  let scanPos = 0;
  while (scanPos < text.length) {
    const nlIdx = text.indexOf('\n', scanPos);
    const lineEnd = nlIdx === -1 ? text.length : nlIdx;
    let line = text.slice(scanPos, lineEnd);
    // Strip trailing \r for CRLF support in marker detection
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    const match = SHEET_MARKER_RE.exec(line.trim());
    if (match) {
      markerPositions.push({
        name: match[1],
        markerLine: line.trim(),
        offset: scanPos,
      });
    }
    scanPos = lineEnd + 1;
    if (nlIdx === -1) break;
  }

  if (markerPositions.length === 0) {
    // No sheet markers — treat entire text as one sheet
    const records = parseCsvRecords(text, 0);
    const headerLine = records.length > 0 ? records[0].record : null;
    const dataRecords = records.slice(headerLine ? 1 : 0);
    return [{
      name: "__no_sheets__",
      markerLine: "",
      titleLine: null,
      headerLine,
      dataRecords: dataRecords.map(r => r.record),
      startOffset: 0,
      endOffset: text.length,
      recordOffsets: dataRecords.map(r => r.startOffset),
      recordEndOffsets: dataRecords.map(r => r.endOffset),
    }];
  }

  const sheets: ParsedSheet[] = [];

  // Handle preamble before first marker
  if (markerPositions[0].offset > 0) {
    const preambleText = text.slice(0, markerPositions[0].offset);
    if (preambleText.trim().length > 0) {
      const records = parseCsvRecords(preambleText, 0);
      sheets.push({
        name: "__preamble__",
        markerLine: "",
        titleLine: null,
        headerLine: records.length > 0 ? records[0].record : null,
        dataRecords: records.slice(1).map(r => r.record),
        startOffset: 0,
        endOffset: markerPositions[0].offset,
        recordOffsets: records.slice(1).map(r => r.startOffset),
        recordEndOffsets: records.slice(1).map(r => r.endOffset),
      });
    }
  }

  // Process each sheet
  for (let s = 0; s < markerPositions.length; s++) {
    const marker = markerPositions[s];
    const sheetStart = marker.offset;
    const sheetEnd = s + 1 < markerPositions.length
      ? markerPositions[s + 1].offset
      : text.length;

    const sheetText = text.slice(sheetStart, sheetEnd);

    // Find end of marker line
    const markerLineEnd = sheetText.indexOf('\n');
    if (markerLineEnd === -1) {
      // Sheet is just a marker, no content
      sheets.push({
        name: marker.name,
        markerLine: marker.markerLine,
        titleLine: null,
        headerLine: null,
        dataRecords: [],
        startOffset: sheetStart,
        endOffset: sheetEnd,
        recordOffsets: [],
        recordEndOffsets: [],
      });
      continue;
    }

    const contentAfterMarker = sheetText.slice(markerLineEnd + 1);
    const contentOffset = sheetStart + markerLineEnd + 1;

    // Check for title line (starts with #)
    let titleLine: string | null = null;
    let contentForRecords = contentAfterMarker;
    let recordsBaseOffset = contentOffset;

    const firstNl = contentAfterMarker.indexOf('\n');
    const firstLine = firstNl === -1 ? contentAfterMarker : contentAfterMarker.slice(0, firstNl);
    // Strip trailing \r for CRLF title-line detection
    const firstLineTrimmed = firstLine.endsWith('\r') ? firstLine.slice(0, -1) : firstLine;
    if (firstLineTrimmed.trimStart().startsWith('#')) {
      titleLine = firstLineTrimmed;
      if (firstNl !== -1) {
        contentForRecords = contentAfterMarker.slice(firstNl + 1);
        recordsBaseOffset = contentOffset + firstNl + 1;
      } else {
        contentForRecords = "";
        recordsBaseOffset = contentOffset + contentAfterMarker.length;
      }
    }

    // Parse records
    const records = parseCsvRecords(contentForRecords, recordsBaseOffset);

    // First record is the header
    const headerLine = records.length > 0 ? records[0].record : null;
    const dataRecords = records.slice(headerLine ? 1 : 0);

    sheets.push({
      name: marker.name,
      markerLine: marker.markerLine,
      titleLine,
      headerLine,
      dataRecords: dataRecords.map(r => r.record),
      startOffset: sheetStart,
      endOffset: sheetEnd,
      recordOffsets: dataRecords.map(r => r.startOffset),
      recordEndOffsets: dataRecords.map(r => r.endOffset),
    });
  }

  return sheets;
}

// ═══════════════════════════════════════════════════════════════════
// 6. Window Construction
// ═══════════════════════════════════════════════════════════════════

/**
 * Build logical windows from parsed sheets, respecting the 10k char limit.
 *
 * Each window contains:
 *   1. Sheet marker
 *   2. Optional title line
 *   3. Header line (repeated)
 *   4. One prior data record as context (except first window in sheet)
 *   5. Primary data records
 *
 * After building, zero-owned windows are merged into an adjacent
 * same-sheet window if possible without exceeding the cap. If merging
 * fails, an error is thrown.
 *
 * @returns Array of logical windows with primary/context ranges,
 *          owned physical chunk mappings, and char-count stats.
 */
export function buildLogicalWindows(
  chunks: readonly PhysicalChunk[],
): LogicalWindow[] {
  const { text, chunkMaps } = reconstructDocument(chunks);
  const sheets = parseSheets(text);

  const docId = chunks[0].document_id;
  const sourceFile = chunks[0].source_file;
  const docTag = chunks[0].document_tag;

  const windows: LogicalWindow[] = [];
  let globalWindowIndex = 0;

  for (const sheet of sheets) {
    // Build prefix: marker + title + header
    const prefixParts: string[] = [];
    if (sheet.markerLine) prefixParts.push(sheet.markerLine);
    if (sheet.titleLine) prefixParts.push(sheet.titleLine);
    if (sheet.headerLine) prefixParts.push(sheet.headerLine);
    const prefix = prefixParts.join('\n');
    const prefixWithNewline = prefix.length > 0 ? prefix + '\n' : '';

    if (sheet.dataRecords.length === 0) {
      // Header-only or empty sheet — one window
      const windowText = prefixWithNewline.length > 0 ? prefixWithNewline : sheet.markerLine || '';
      const primaryRange: SourceRange = {
        startOffset: sheet.startOffset,
        endOffset: sheet.endOffset,
      };

      const owned = assignOwnedChunks(chunkMaps, primaryRange);
      const trimmedText = windowText.trimEnd();
      const primaryChars = primaryRange.endOffset - primaryRange.startOffset;

      windows.push({
        windowIndex: globalWindowIndex++,
        sourceFile,
        documentId: docId,
        documentTag: docTag,
        windowText: trimmedText,
        totalChars: trimmedText.length,
        primaryChars,
        contextChars: Math.max(0, trimmedText.length - primaryChars),
        primaryRange,
        contextRanges: [],
        ownedChunkIds: owned.map(c => c.chunk_id),
        chunkSourceMaps: owned,
        firstOwnedChunkId: owned[0]?.chunk_id ?? '',
        lastOwnedChunkId: owned[owned.length - 1]?.chunk_id ?? '',
        sheetName: sheet.name,
        isHeaderOnly: true,
      });
      continue;
    }

    // Build windows from data records
    let recordIdx = 0;

    while (recordIdx < sheet.dataRecords.length) {
      const isFirstWindow = recordIdx === 0;

      // Context: one prior record (not for first window)
      let contextRecord: string | null = null;
      let contextRange: SourceRange | null = null;
      if (!isFirstWindow && recordIdx > 0) {
        contextRecord = sheet.dataRecords[recordIdx - 1];
        contextRange = {
          startOffset: sheet.recordOffsets[recordIdx - 1],
          endOffset: sheet.recordEndOffsets[recordIdx - 1],
        };
      }

      // Calculate prefix size for this window
      let windowPrefix = prefixWithNewline;
      if (contextRecord !== null) {
        windowPrefix += contextRecord + '\n';
      }

      // Check if prefix + one record fits
      const firstRecord = sheet.dataRecords[recordIdx];
      const firstRecordLen = firstRecord.length;

      if (windowPrefix.length + firstRecordLen > MAX_WINDOW_CHARS) {
        throw new Error(
          `buildLogicalWindows: prefix (${windowPrefix.length} chars) + first record ` +
          `(${firstRecordLen} chars) = ${windowPrefix.length + firstRecordLen} chars exceeds ` +
          `${MAX_WINDOW_CHARS} limit in sheet "${sheet.name}" ` +
          `(document=${docId}, file=${sourceFile})`,
        );
      }

      // Pack records into this window
      const windowRecordIdxs: number[] = [];
      let currentSize = windowPrefix.length;

      while (recordIdx < sheet.dataRecords.length) {
        const rec = sheet.dataRecords[recordIdx];
        const addSize = rec.length + (windowRecordIdxs.length > 0 ? 1 : 0); // +1 for \n separator

        if (currentSize + addSize > MAX_WINDOW_CHARS && windowRecordIdxs.length > 0) {
          break; // Would exceed limit and we already have at least one record
        }

        windowRecordIdxs.push(recordIdx);
        currentSize += addSize;
        recordIdx++;
      }

      // Build window text
      const primaryRecordTexts = windowRecordIdxs.map(i => sheet.dataRecords[i]);
      const windowText = windowPrefix + primaryRecordTexts.join('\n');

      // Primary range: from first primary record to last primary record
      const firstPrimIdx = windowRecordIdxs[0];
      const lastPrimIdx = windowRecordIdxs[windowRecordIdxs.length - 1];

      // For the first window in a sheet, primary range starts at sheet start
      // to include the header/marker as primary content (they're part of this sheet)
      const primaryStart = isFirstWindow
        ? sheet.startOffset
        : sheet.recordOffsets[firstPrimIdx];

      // Ensure primary ranges partition the document without gaps:
      // - Last window in sheet: extend to sheet.endOffset (captures trailing newline).
      // - Non-last window: extend to the start offset of the next record
      //   (captures the \n separator between the last record of this window
      //    and the first record of the next window).
      const isLastWindowInSheet = recordIdx >= sheet.dataRecords.length;
      const primaryEnd = isLastWindowInSheet
        ? sheet.endOffset
        : sheet.recordOffsets[recordIdx];

      const primaryRange: SourceRange = {
        startOffset: primaryStart,
        endOffset: primaryEnd,
      };

      const contextRanges: SourceRange[] = [];
      if (contextRange) {
        contextRanges.push(contextRange);
      }

      // Assign owned physical chunks
      const owned = assignOwnedChunks(chunkMaps, primaryRange);
      const trimmedText = windowText.trimEnd();
      const primaryCharsLen = primaryRange.endOffset - primaryRange.startOffset;
      const contextCharsLen = contextRanges.reduce(
        (sum, cr) => sum + (cr.endOffset - cr.startOffset),
        0,
      );

      windows.push({
        windowIndex: globalWindowIndex++,
        sourceFile,
        documentId: docId,
        documentTag: docTag,
        windowText: trimmedText,
        totalChars: trimmedText.length,
        primaryChars: primaryCharsLen,
        contextChars: contextCharsLen,
        primaryRange,
        contextRanges,
        ownedChunkIds: owned.map(c => c.chunk_id),
        chunkSourceMaps: owned,
        firstOwnedChunkId: owned[0]?.chunk_id ?? '',
        lastOwnedChunkId: owned[owned.length - 1]?.chunk_id ?? '',
        sheetName: sheet.name,
        isHeaderOnly: false,
      });
    }
  }

  // ── Repair unassigned chunks ────────────────────────────────────
  // Due to newline/separator boundaries, some chunks' uniqueRange.startOffset
  // may fall between two windows' primary ranges. Assign each unassigned chunk
  // to the window whose primary range end is closest (i.e., the immediately
  // preceding window in document order).
  repairUnassignedChunks(windows, chunkMaps);

  // ── Zero-owned window merging ──────────────────────────────────
  // If a window still owns no physical chunk after repair, merge it into
  // an adjacent window without exceeding MAX_WINDOW_CHARS.
  mergeZeroOwnedWindows(windows);

  // Validate invariants
  assertCompleteOwnership(windows, chunks);

  return windows;
}

// ═══════════════════════════════════════════════════════════════════
// 6b. Repair Unassigned Chunks
// ═══════════════════════════════════════════════════════════════════

/**
 * After initial chunk assignment, some chunks may remain unassigned because
 * their uniqueRange.startOffset falls on a separator character (e.g., \n)
 * between two windows' primary ranges. This function assigns each such chunk
 * to the window whose primary range is closest, preferring the preceding window.
 */
function repairUnassignedChunks(
  windows: LogicalWindow[],
  chunkMaps: ChunkSourceMap[],
): void {
  // Build set of already-assigned chunk IDs
  const assigned = new Set<string>();
  for (const w of windows) {
    for (const id of w.ownedChunkIds) {
      assigned.add(id);
    }
  }

  // Find unassigned chunks
  const unassigned = chunkMaps.filter(cm => !assigned.has(cm.chunk_id));
  if (unassigned.length === 0) return;

  // Sort windows by primaryRange.startOffset for binary-search-like matching
  const sortedWindows = [...windows].sort((a, b) => a.primaryRange.startOffset - b.primaryRange.startOffset);

  for (const cm of unassigned) {
    const offset = cm.uniqueRange.startOffset;

    // Find the best window: the one whose primary range most closely contains
    // or precedes this offset.
    let bestWindow: LogicalWindow | null = null;
    let bestDist = Infinity;

    for (const w of sortedWindows) {
      // If offset falls inside primary range, perfect match
      if (offset >= w.primaryRange.startOffset && offset < w.primaryRange.endOffset) {
        bestWindow = w;
        bestDist = 0;
        break;
      }

      // Distance: how far is offset from this window's primary range?
      const dist = offset < w.primaryRange.startOffset
        ? w.primaryRange.startOffset - offset
        : offset - w.primaryRange.endOffset + 1;

      if (dist < bestDist) {
        bestDist = dist;
        bestWindow = w;
      }
    }

    if (bestWindow) {
      // Insert chunk in correct order
      const insertIdx = bestWindow.chunkSourceMaps.findIndex(
        existing => existing.chunk_index > cm.chunk_index,
      );
      if (insertIdx === -1) {
        bestWindow.chunkSourceMaps.push(cm);
        bestWindow.ownedChunkIds.push(cm.chunk_id);
      } else {
        bestWindow.chunkSourceMaps.splice(insertIdx, 0, cm);
        bestWindow.ownedChunkIds.splice(insertIdx, 0, cm.chunk_id);
      }
      // Extend primary range to include this chunk
      bestWindow.primaryRange = {
        startOffset: Math.min(bestWindow.primaryRange.startOffset, cm.uniqueRange.startOffset),
        endOffset: Math.max(bestWindow.primaryRange.endOffset, cm.uniqueRange.endOffset),
      };
      bestWindow.primaryChars = bestWindow.primaryRange.endOffset - bestWindow.primaryRange.startOffset;
      assigned.add(cm.chunk_id);
    }
  }

  // Update first/last owned chunk IDs
  for (const w of windows) {
    if (w.ownedChunkIds.length > 0) {
      w.firstOwnedChunkId = w.ownedChunkIds[0];
      w.lastOwnedChunkId = w.ownedChunkIds[w.ownedChunkIds.length - 1];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6c. Zero-Owned Window Merging
// ═══════════════════════════════════════════════════════════════════

/**
 * Merge windows that own zero physical chunks into an adjacent
 * same-sheet window, provided the merged text stays ≤ 10,000 chars.
 * Mutates the array in place and reindexes windows after merging.
 */
function mergeZeroOwnedWindows(windows: LogicalWindow[]): void {
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (w.ownedChunkIds.length > 0) continue;

      // Try merge candidates: prefer same-sheet adjacent, then any adjacent.
      let didMerge = false;
      const candidates: Array<{ idx: number; direction: 'forward' | 'backward' }> = [];

      // Same-sheet forward
      if (i + 1 < windows.length && windows[i + 1].sheetName === w.sheetName) {
        candidates.push({ idx: i + 1, direction: 'forward' });
      }
      // Same-sheet backward
      if (i - 1 >= 0 && windows[i - 1].sheetName === w.sheetName) {
        candidates.push({ idx: i - 1, direction: 'backward' });
      }
      // Cross-sheet forward (fallback)
      if (i + 1 < windows.length && !candidates.some(c => c.idx === i + 1)) {
        candidates.push({ idx: i + 1, direction: 'forward' });
      }
      // Cross-sheet backward (fallback)
      if (i - 1 >= 0 && !candidates.some(c => c.idx === i - 1)) {
        candidates.push({ idx: i - 1, direction: 'backward' });
      }

      // Two-pass merge: first try strict (≤ MAX_WINDOW_CHARS), then relaxed (any size).
      // Relaxed merge produces an oversized window but is preferable to crashing
      // on production data where chunk boundaries don't align with record boundaries.
      for (const strict of [true, false]) {
        for (const cand of candidates) {
          const target = windows[cand.idx];
          const mergedLen = target.windowText.length + w.windowText.length + 1;
          if (strict && mergedLen > MAX_WINDOW_CHARS) continue;
          // Perform merge
          target.primaryRange = {
            startOffset: Math.min(w.primaryRange.startOffset, target.primaryRange.startOffset),
            endOffset: Math.max(w.primaryRange.endOffset, target.primaryRange.endOffset),
          };
          target.primaryChars = target.primaryRange.endOffset - target.primaryRange.startOffset;
          if (cand.direction === 'forward') {
            target.contextRanges = [...w.contextRanges, ...target.contextRanges];
            target.windowText = (w.windowText + '\n' + target.windowText).trimEnd();
          } else {
            target.contextRanges = [...target.contextRanges, ...w.contextRanges];
            target.windowText = (target.windowText + '\n' + w.windowText).trimEnd();
          }
          target.contextChars = target.contextRanges.reduce(
            (sum, cr) => sum + (cr.endOffset - cr.startOffset), 0,
          );
          target.totalChars = target.windowText.length;
          // Merge owned chunk sets
          if (w.ownedChunkIds.length > 0) {
            // Shouldn't happen (we only merge zero-owned) but be safe
            target.ownedChunkIds = [...target.ownedChunkIds, ...w.ownedChunkIds]
              .sort((a, b) => {
                const aMap = target.chunkSourceMaps.find(m => m.chunk_id === a) ?? w.chunkSourceMaps.find(m => m.chunk_id === a);
                const bMap = target.chunkSourceMaps.find(m => m.chunk_id === b) ?? w.chunkSourceMaps.find(m => m.chunk_id === b);
                return (aMap?.chunk_index ?? 0) - (bMap?.chunk_index ?? 0);
              });
            target.chunkSourceMaps = [...target.chunkSourceMaps, ...w.chunkSourceMaps]
              .sort((a, b) => a.chunk_index - b.chunk_index);
          }
          windows.splice(i, 1);
          didMerge = true;
          merged = true;
          break;
        }
        if (didMerge) break;
      }

      if (!didMerge) {
        throw new Error(
          `buildLogicalWindows: window ${w.windowIndex} in sheet "${w.sheetName}" owns no ` +
          `physical chunks and cannot be merged with any adjacent window ` +
          `(document=${w.documentId}, file=${w.sourceFile})`,
        );
      }
    }
  }

  // Re-index windows and update first/last owned chunk IDs
  for (let i = 0; i < windows.length; i++) {
    windows[i].windowIndex = i;
    if (windows[i].ownedChunkIds.length > 0) {
      windows[i].firstOwnedChunkId = windows[i].ownedChunkIds[0];
      windows[i].lastOwnedChunkId = windows[i].ownedChunkIds[windows[i].ownedChunkIds.length - 1];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 7. Physical Chunk Assignment
// ═══════════════════════════════════════════════════════════════════

/**
 * Assign physical chunks to a window based on unique-range start offset.
 * A chunk is owned by the window whose primary range contains the
 * start of the chunk's unique contributed range.
 */
function assignOwnedChunks(
  chunkMaps: ChunkSourceMap[],
  primaryRange: SourceRange,
): ChunkSourceMap[] {
  const owned: ChunkSourceMap[] = [];
  for (const cm of chunkMaps) {
    if (cm.uniqueRange.startOffset >= primaryRange.startOffset &&
        cm.uniqueRange.startOffset < primaryRange.endOffset) {
      owned.push(cm);
    }
  }
  return owned;
}

// ═══════════════════════════════════════════════════════════════════
// 8. Invariant Assertions (exported for testing)
// ═══════════════════════════════════════════════════════════════════

/**
 * Assert every physical chunk is owned exactly once and owned indexes
 * are monotonically increasing within each window.
 */
export function assertCompleteOwnership(
  windows: LogicalWindow[],
  chunks: readonly PhysicalChunk[],
): void {
  const allOwnedIds = new Set<string>();
  const expectedIds = new Set(chunks.map(c => c.chunk_id));

  for (const w of windows) {
    // Check monotonically increasing chunk indexes
    for (let i = 1; i < w.ownedChunkIds.length; i++) {
      const prevMap = w.chunkSourceMaps[i - 1];
      const currMap = w.chunkSourceMaps[i];
      if (currMap.chunk_index <= prevMap.chunk_index) {
        throw new Error(
          `assertCompleteOwnership: non-monotonic chunk indexes in window ${w.windowIndex}: ` +
          `index ${prevMap.chunk_index} followed by ${currMap.chunk_index}`,
        );
      }
    }

    // Check no duplicate ownership
    for (const id of w.ownedChunkIds) {
      if (allOwnedIds.has(id)) {
        throw new Error(
          `assertCompleteOwnership: duplicate ownership of chunk ${id} in window ${w.windowIndex}`,
        );
      }
      allOwnedIds.add(id);
    }

    // Check no cross-document ownership
    for (const cm of w.chunkSourceMaps) {
      if (!expectedIds.has(cm.chunk_id)) {
        throw new Error(
          `assertCompleteOwnership: window ${w.windowIndex} owns chunk ${cm.chunk_id} ` +
          `which is not in the input chunk set`,
        );
      }
    }
  }

  // Check completeness
  if (allOwnedIds.size !== expectedIds.size) {
    const missing = [...expectedIds].filter(id => !allOwnedIds.has(id));
    throw new Error(
      `assertCompleteOwnership: ${missing.length} chunks not owned by any window: ` +
      `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
    );
  }
}

/**
 * Assert that concatenated primary ranges reproduce the original document exactly.
 */
export function assertPrimaryPartition(
  windows: LogicalWindow[],
  reconstructedTextLength: number,
): void {
  // Sort windows by primary range start
  const sorted = [...windows].sort((a, b) => a.primaryRange.startOffset - b.primaryRange.startOffset);

  let expectedStart = 0;
  for (const w of sorted) {
    if (w.primaryRange.startOffset !== expectedStart) {
      throw new Error(
        `assertPrimaryPartition: gap or overlap at offset ${expectedStart}. ` +
        `Window ${w.windowIndex} starts at ${w.primaryRange.startOffset}`,
      );
    }
    expectedStart = w.primaryRange.endOffset;
  }

  if (expectedStart !== reconstructedTextLength) {
    throw new Error(
      `assertPrimaryPartition: primary ranges end at ${expectedStart}, ` +
      `expected ${reconstructedTextLength}`,
    );
  }
}

/**
 * Assert deterministic planning — same input produces identical output.
 */
export function assertDeterministic(
  chunks: readonly PhysicalChunk[],
): void {
  const plan1 = buildLogicalWindows(chunks);
  const plan2 = buildLogicalWindows(chunks);

  if (plan1.length !== plan2.length) {
    throw new Error(
      `assertDeterministic: plan lengths differ: ${plan1.length} vs ${plan2.length}`,
    );
  }

  for (let i = 0; i < plan1.length; i++) {
    if (plan1[i].windowText !== plan2[i].windowText) {
      throw new Error(
        `assertDeterministic: window ${i} text differs between runs`,
      );
    }
    if (JSON.stringify(plan1[i].ownedChunkIds) !== JSON.stringify(plan2[i].ownedChunkIds)) {
      throw new Error(
        `assertDeterministic: window ${i} owned chunks differ between runs`,
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 9. Snippet Mapping
// ═══════════════════════════════════════════════════════════════════

/** Result of mapping a snippet to a physical chunk. */
export interface SnippetMapping {
  /** Whether the snippet was found in primary text (not just context). */
  foundInPrimary: boolean;
  /** Physical chunk ID the snippet maps to, if found in primary. */
  mappedChunkId: string | null;
  /** Source offset within the reconstructed text where the snippet was found, if in primary. */
  sourceOffset: number | null;
  /** Reason for rejection, if applicable. */
  rejectionReason: string | null;
}

/**
 * Map a snippet to a physical chunk within a logical window.
 *
 * Signature: (window, snippet) — no reconstructedText argument.
 * The window's primaryRange + chunkSourceMaps carry all information needed.
 *
 * Algorithm:
 *   1. Whitespace-normalize the snippet; reject if empty.
 *   2. Verify snippet appears literally in the window text.
 *   3. Determine if the occurrence falls in primary text or context-only.
 *   4. If primary: map to the owned physical chunk containing the first
 *      primary character and return the source offset.
 *   5. If context-only: reject with reason.
 */
export function mapSnippetToPhysicalChunk(
  window: LogicalWindow,
  snippet: string,
): SnippetMapping {
  // Whitespace-normalize both snippet and window text for anchoring
  const normSnippet = snippet.replace(/\s+/g, ' ').trim();
  if (normSnippet.length === 0) {
    return { foundInPrimary: false, mappedChunkId: null, sourceOffset: null, rejectionReason: 'empty_snippet' };
  }

  const normWindowText = window.windowText.replace(/\s+/g, ' ').trim();
  if (!normWindowText.includes(normSnippet)) {
    return { foundInPrimary: false, mappedChunkId: null, sourceOffset: null, rejectionReason: 'snippet_not_in_window' };
  }

  // For windows with no context ranges (first window in sheet or first overall),
  // everything in the window is primary content.
  if (window.contextRanges.length === 0) {
    // Compute a rough source offset within the primary range
    const snippetPosInWindow = normWindowText.indexOf(normSnippet);
    const sourceOffset = window.primaryRange.startOffset + snippetPosInWindow;
    const firstOwnedChunk = window.chunkSourceMaps[0];

    // Find the chunk whose complete range covers the estimated position
    for (const cm of window.chunkSourceMaps) {
      if (sourceOffset >= cm.completeRange.startOffset &&
          sourceOffset < cm.completeRange.endOffset) {
        return {
          foundInPrimary: true,
          mappedChunkId: cm.chunk_id,
          sourceOffset,
          rejectionReason: null,
        };
      }
    }

    return {
      foundInPrimary: true,
      mappedChunkId: firstOwnedChunk?.chunk_id ?? null,
      sourceOffset,
      rejectionReason: null,
    };
  }

  // For non-first windows: determine primary text region in the window.
  // The window text is structured as:
  //   [sheet marker\n] [title\n] [header\n] [context record\n] [primary records...]
  // The primary records start after all context/prefix material.
  //
  // We compute the primary section by reconstructing the prefix length.
  const prefixParts: string[] = [];
  if (window.sheetName !== '__no_sheets__' && window.sheetName !== '__preamble__') {
    prefixParts.push(`--- Sheet: ${window.sheetName} ---`);
  }

  // We don't have direct access to title/header lines from the window object,
  // but we can infer the primary region by computing the offset of primary
  // records relative to the window text. The primary range in the reconstructed
  // text tells us which chars are primary — and the window text reproduces them.
  //
  // Strategy: extract primary text from the window text by looking at the last
  // N characters that correspond to the primary range length. But the window
  // text may have been trimmed. Instead, use the reconstructed text approach:
  // search for the snippet in the primary portion of the window.

  // The primary range in the reconstructed text starts at primaryRange.startOffset.
  // Each owned chunk's completeRange tells us where it sits in the reconstructed text.
  // We need to check if the snippet text (whitespace-normalized) appears in the
  // reconstructed text within the primary range. We can reconstruct the primary
  // section from the window's internal data.

  // Build the primary text portion by finding records whose offsets fall in primaryRange
  // Instead of needing reconstructedText, we use the window text structure:
  // Everything after the prefix+context is primary.

  // Split window text into lines and identify where primary starts
  const windowLines = window.windowText.split('\n');
  let prefixLineCount = 0;

  // Count prefix lines: marker, title(?), header, context record
  // Marker
  if (window.sheetName !== '__no_sheets__' && window.sheetName !== '__preamble__') {
    if (windowLines.length > prefixLineCount &&
        SHEET_MARKER_RE.test(windowLines[prefixLineCount].trim())) {
      prefixLineCount++;
    }
  }
  // Title line (starts with #)
  if (windowLines.length > prefixLineCount &&
      windowLines[prefixLineCount].trimStart().startsWith('#')) {
    prefixLineCount++;
  }
  // Header line (first non-marker, non-title line that's context)
  // For non-first windows we always repeat the header + one context record
  if (window.contextRanges.length > 0) {
    // Header line
    if (windowLines.length > prefixLineCount) {
      prefixLineCount++; // header
    }
    // Context record (one prior row)
    if (windowLines.length > prefixLineCount) {
      prefixLineCount++; // context record
    }
  }

  // Primary text = lines from prefixLineCount onward
  const primaryLines = windowLines.slice(prefixLineCount);
  const primaryWindowText = primaryLines.join('\n');
  const normPrimaryWindowText = primaryWindowText.replace(/\s+/g, ' ').trim();

  if (normPrimaryWindowText.includes(normSnippet)) {
    // Found in primary — compute source offset and map to physical chunk
    const snippetPosInPrimary = normPrimaryWindowText.indexOf(normSnippet);
    const sourceOffset = window.primaryRange.startOffset + snippetPosInPrimary;

    for (const cm of window.chunkSourceMaps) {
      if (sourceOffset >= cm.completeRange.startOffset &&
          sourceOffset < cm.completeRange.endOffset) {
        return {
          foundInPrimary: true,
          mappedChunkId: cm.chunk_id,
          sourceOffset,
          rejectionReason: null,
        };
      }
    }

    // Fallback: map to first owned chunk
    return {
      foundInPrimary: true,
      mappedChunkId: window.chunkSourceMaps[0]?.chunk_id ?? null,
      sourceOffset,
      rejectionReason: null,
    };
  }

  // Snippet found in window text but not in primary range — context-only
  return {
    foundInPrimary: false,
    mappedChunkId: null,
    sourceOffset: null,
    rejectionReason: 'snippet_in_context_only',
  };
}

// ═══════════════════════════════════════════════════════════════════
// 10. Excel Detection
// ═══════════════════════════════════════════════════════════════════

const EXCEL_EXTENSIONS_RE = /\.(xlsx|xls|xlsm|csv)$/i;
const EXCEL_TAGS = new Set(['financial_model', 'customer_data']);

/**
 * Determine if a document should be treated as Excel for DCS windowing.
 */
export function isExcelDocument(
  documentTag: string | null,
  sourceFile: string,
): boolean {
  const tag = documentTag?.toLowerCase() ?? '';
  return EXCEL_TAGS.has(tag) && EXCEL_EXTENSIONS_RE.test(sourceFile);
}

// ═══════════════════════════════════════════════════════════════════
// 11. Call-Reduction Oracle
// ═══════════════════════════════════════════════════════════════════

export interface OracleReport {
  documentId: string;
  sourceFile: string;
  physicalChunks: number;
  logicalWindows: number;
  avgChunksPerWindow: number;
  minWindowChars: number;
  medianWindowChars: number;
  p95WindowChars: number;
  maxWindowChars: number;
  sheetCount: number;
  windowsPerSheet: Record<string, number>;
  contextCharsAdded: number;
  totalPrimaryChars: number;
  totalContextChars: number;
  smallWindows: Array<{ windowIndex: number; chars: number; sheetName: string; reason: string }>;
}

/**
 * Run the call-reduction oracle over a set of physical chunks.
 */
export function runOracle(
  chunks: readonly PhysicalChunk[],
): OracleReport {
  const windows = buildLogicalWindows(chunks);

  const windowChars = windows.map(w => w.totalChars);
  windowChars.sort((a, b) => a - b);

  const windowsPerSheet: Record<string, number> = {};
  let totalPrimaryChars = 0;
  let totalContextChars = 0;

  for (const w of windows) {
    windowsPerSheet[w.sheetName] = (windowsPerSheet[w.sheetName] ?? 0) + 1;
    totalPrimaryChars += w.primaryChars;
    totalContextChars += w.contextChars;
  }

  const contextCharsAdded = totalContextChars;

  const p95Idx = Math.min(Math.floor(windowChars.length * 0.95), windowChars.length - 1);
  const medianIdx = Math.floor(windowChars.length / 2);

  const smallWindows = windows
    .filter(w => w.totalChars < 500)
    .map(w => ({
      windowIndex: w.windowIndex,
      chars: w.totalChars,
      sheetName: w.sheetName,
      reason: w.isHeaderOnly ? 'header_only_sheet' : 'small_final_window',
    }));

  return {
    documentId: chunks[0].document_id,
    sourceFile: chunks[0].source_file,
    physicalChunks: chunks.length,
    logicalWindows: windows.length,
    avgChunksPerWindow: Math.round((chunks.length / windows.length) * 10) / 10,
    minWindowChars: windowChars[0] ?? 0,
    medianWindowChars: windowChars[medianIdx] ?? 0,
    p95WindowChars: windowChars[p95Idx] ?? 0,
    maxWindowChars: windowChars[windowChars.length - 1] ?? 0,
    sheetCount: Object.keys(windowsPerSheet).length,
    windowsPerSheet,
    contextCharsAdded,
    totalPrimaryChars,
    totalContextChars,
    smallWindows,
  };
}
