/**
 * IC Questions (v2) — P0 scope resolution.
 *
 * Resolves the ONLY corpus `ic_challenge_mode` v2 is permitted to see: documents
 * on the deal tagged `ic_memo`, plus their extractions. Nothing else.
 *
 * ── Why scope resolution is its own module ─────────────────────────────────
 * The exclusion of the CIM, vendor/legal DD, consultant reports, and financial
 * models is the module's entire thesis: it reproduces what an IC member actually
 * saw. If scope selection lived inline in the pipeline-core branch it would sit
 * next to the general extraction loader that reads EVERY document on the deal,
 * one editing accident away from silently widening the corpus and invalidating
 * every question the module produces. Keeping it here makes the tag filter a
 * single, reviewable surface.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 * Zero `ic_memo` documents is not an empty result, it is a scope error: the
 * module cannot reproduce an IC member's view of a deal that has no IC memo.
 * This module reports that as a failure for the caller to record against the
 * run; it never proceeds with a wider corpus.
 */

import { z } from "@superblocksteam/sdk-api";
import type { PipelineContext } from "./pipeline-config.js";
import { parseDateFromFileName } from "./parse-date-from-filename.js";

const LOG_PREFIX = "[ic-questions-scope]";

/**
 * Matches the extraction page size in `pipeline-core.ts`. Rows carry
 * `extraction_json` at 5–38KB, so 50 rows ≈ 1MB — well under the 4MB gRPC
 * response ceiling.
 */
const EXTRACTION_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One IC memo, carrying its position in the memo chronology. */
export interface ICMemoDoc {
  id: string;
  file_name: string;
  /** e.g. `"MEMO 3 of 4 — 2026-06-15"`, or `"MEMO 4 of 4"` when no date parsed. */
  version_label: string;
}

/** One extraction row for a memo chunk. */
export interface ICMemoExtraction {
  document_id: string;
  chunk_index: number;
  extraction_json: any;
}

/** Everything the synthesis call (P2) and the renderer (P4) need about scope. */
export interface ICQuestionsScope {
  /** Memos in chronological order, 1..N. */
  memoDocs: ICMemoDoc[];
  /** Usable extraction rows for `memoDocs` only. Failed chunks excluded. */
  extractions: ICMemoExtraction[];
  /** Per-memo usable chunk counts, in `memoDocs` order — feeds the P8 disclosure. */
  memoCoverage: Array<{ file_name: string; chunks_used: number }>;
  /** Memos whose ordering came from filename sort because no date parsed (F4). */
  orderingFallbackDocs: string[];
}

export type ICQuestionsScopeResult =
  | { ok: true; scope: ICQuestionsScope }
  | { ok: false; errorPhase: "no_ic_memos"; errorMessage: string };

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const MemoDocumentRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  document_tag: z.string(),
});

const MemoExtractionRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  extraction_json: z.any(),
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the IC memo corpus for a deal (P0).
 *
 * @returns `{ ok: true, scope }`, or `{ ok: false, errorPhase: "no_ic_memos" }`
 *          when the deal has no document tagged `ic_memo`. The caller owns
 *          marking the run failed — this module does not touch `module_runs`.
 */
export async function resolveICQuestionsScope(
  db: PipelineContext["integrations"]["db"],
  dealId: string,
): Promise<ICQuestionsScopeResult> {
  // ── Step 1: the tag filter. The single source of the module's scope. ──────
  const memoRows = await db.query(
    `SELECT id, file_name, document_tag FROM documents
     WHERE deal_id = $1 AND document_tag = 'ic_memo' ORDER BY file_name`,
    MemoDocumentRowSchema,
    [dealId],
    { label: "IC questions scope — load ic_memo documents" },
  );

  if (memoRows.length === 0) {
    const errorMessage =
      "IC Questions requires at least one document tagged 'ic_memo'.";
    console.error(`${LOG_PREFIX} no ic_memo documents on deal ${dealId} — scope error.`);
    return { ok: false, errorPhase: "no_ic_memos", errorMessage };
  }

  // ── Step 2: chronology ───────────────────────────────────────────────────
  // Sort key is the parsed date where one exists, else the file name. Because
  // ISO dates begin with digits, dated memos sort ahead of letter-initial
  // filenames as a consequence of this rule, not as a separate tier.
  const orderingFallbackDocs: string[] = [];
  const keyed = memoRows.map((row) => {
    const parsedDate = parseDateFromFileName(row.file_name);
    if (parsedDate === null) orderingFallbackDocs.push(row.file_name);
    return { id: row.id, file_name: row.file_name, parsedDate };
  });

  keyed.sort((a, b) => {
    const ka = a.parsedDate ?? a.file_name;
    const kb = b.parsedDate ?? b.file_name;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });

  // ── Step 3: version labels ───────────────────────────────────────────────
  // A memo with no parsed date gets a label with NO date segment. Substituting
  // a neighbouring memo's date, or the upload timestamp, would put a fabricated
  // date in front of the reader inside a verbatim attribution line.
  const total = keyed.length;
  const memoDocs: ICMemoDoc[] = keyed.map((doc, i) => ({
    id: doc.id,
    file_name: doc.file_name,
    version_label:
      doc.parsedDate === null
        ? `MEMO ${i + 1} of ${total}`
        : `MEMO ${i + 1} of ${total} — ${doc.parsedDate}`,
  }));

  // ── Step 4: extractions, scoped to these document IDs only ───────────────
  const memoIds = memoDocs.map((d) => d.id);
  const rawRows: ICMemoExtraction[] = [];
  let offset = 0;
  while (true) {
    const page = await db.query(
      `SELECT document_id, chunk_index, extraction_json
       FROM universal_extractions
       WHERE document_id = ANY($1::uuid[])
       ORDER BY document_id, chunk_index
       LIMIT ${EXTRACTION_PAGE_SIZE} OFFSET ${offset}`,
      MemoExtractionRowSchema,
      [memoIds],
      { label: `IC questions scope — load memo extractions (offset ${offset})` },
    );
    rawRows.push(...page);
    if (page.length < EXTRACTION_PAGE_SIZE) break;
    offset += EXTRACTION_PAGE_SIZE;
  }

  // Failed chunks hold no usable text. Excluding them here keeps `chunks_used`
  // in the P8 disclosure an honest count of what the model actually read.
  const extractions: ICMemoExtraction[] = [];
  let failedCount = 0;
  for (const row of rawRows) {
    const ext =
      typeof row.extraction_json === "string"
        ? JSON.parse(row.extraction_json)
        : row.extraction_json;
    if (ext?.failed) {
      failedCount++;
      continue;
    }
    extractions.push({ ...row, extraction_json: ext });
  }

  // ── Step 5: coverage, in memoDocs order ──────────────────────────────────
  const chunkCounts = new Map<string, number>();
  for (const e of extractions) {
    chunkCounts.set(e.document_id, (chunkCounts.get(e.document_id) ?? 0) + 1);
  }
  const memoCoverage = memoDocs.map((d) => ({
    file_name: d.file_name,
    chunks_used: chunkCounts.get(d.id) ?? 0,
  }));

  // A memo with zero usable chunks contributes nothing but is still counted in
  // the disclosure's memo total. Dropping it is not sanctioned by the spec, so
  // it is surfaced loudly instead of silently removed.
  for (const c of memoCoverage) {
    if (c.chunks_used === 0) {
      console.error(
        `${LOG_PREFIX} memo "${c.file_name}" has 0 usable chunks — it will be ` +
        "named in the disclosure but contribute no text.",
      );
    }
  }

  console.log(
    `${LOG_PREFIX} resolved ${memoDocs.length} IC memo(s), ${extractions.length} usable chunk(s) ` +
    `(${failedCount} failed excluded), orderingFallback ${orderingFallbackDocs.length}.`,
  );
  for (const d of memoDocs) {
    console.log(`${LOG_PREFIX}   ${d.version_label} — ${d.file_name}`);
  }

  return {
    ok: true,
    scope: { memoDocs, extractions, memoCoverage, orderingFallbackDocs },
  };
}
