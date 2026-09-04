/**
 * SRI v2 — Entity Manifest, Section 1: FTS Retrieval and Context Assembly
 *
 * Retrieves document chunks via full-text search for four query categories
 * (brand, leadership, workforce, group structure), deduplicates, truncates
 * to a character budget, and returns the assembled context as diagnostic
 * payload. No LLM call, no database inserts, no completion marker.
 */

import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./sri-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
var ALLOWLIST_TAGS = ["cim", "ic_memo", "consultant_report", "legal"];
var MAX_CHUNKS_PER_QUERY = 60;
var MAX_CONTEXT_CHARS = 40000;

var BRAND_QUERY = "brand trading name customer facing brands operating under portfolio businesses";
var LEADERSHIP_QUERY = "management team chief executive officer founder leadership board of directors";
var WORKFORCE_QUERY = "employees headcount staff colleagues culture engagement retention attrition";
var GROUP_QUERY = "acquisition acquired trading companies group structure business units subsidiaries Ltd Limited";

var CHUNK_SQL = "WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq) SELECT dc.document_id, dc.chunk_index, dc.file_name, dc.content, ts_rank_cd(dc.tsv, q.tsq) AS rank FROM document_chunks dc JOIN documents d ON d.id = dc.document_id CROSS JOIN q WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND d.document_tag = ANY($3::text[]) ORDER BY ts_rank_cd(dc.tsv, q.tsq) DESC, dc.chunk_index ASC LIMIT $4";

var ChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.coerce.number(),
});

var SEPARATOR = "\n---\n";

export async function buildEntityManifest(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;

  // ── FTS retrieval: four query categories ──────────────────────────
  var brandChunks = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, BRAND_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS brand" },
  );

  var leadershipChunks = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, LEADERSHIP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS leadership" },
  );

  var workforceChunks = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, WORKFORCE_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS workforce" },
  );

  var groupChunks = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, GROUP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS group structure" },
  );

  // ── Deduplicate and merge ─────────────────────────────────────────
  // Merge order: brand, leadership, workforce, group.
  var seen = new Set<string>();
  var allFtsChunks: z.infer<typeof ChunkRow>[] = [];
  var perQueryCounts = {
    brand: brandChunks.length,
    leadership: leadershipChunks.length,
    workforce: workforceChunks.length,
    group: groupChunks.length,
  };

  for (var pool of [brandChunks, leadershipChunks, workforceChunks, groupChunks]) {
    for (var c of pool) {
      var key = c.document_id + ":" + String(c.chunk_index);
      if (!seen.has(key)) {
        seen.add(key);
        allFtsChunks.push(c);
      }
    }
  }

  // ── Truncate to MAX_CONTEXT_CHARS ─────────────────────────────────
  var totalChars = 0;
  var markerLen = 60;
  var contextChunks: z.infer<typeof ChunkRow>[] = [];

  for (var i = 0; i < allFtsChunks.length; i++) {
    var chunk = allFtsChunks[i];
    if (totalChars + chunk.content.length + markerLen > MAX_CONTEXT_CHARS) break;
    contextChunks.push(chunk);
    totalChars += chunk.content.length + markerLen;
  }

  var chunksTruncated = allFtsChunks.length - contextChunks.length;

  if (contextChunks.length === 0) {
    return {
      stage: "build_entity_manifest",
      status: "failed",
      message: "No document chunks found for FTS retrieval. Likely cause: document tagging or missing chunks for deal " + dealId + ".",
    };
  }

  // ── Build context string ──────────────────────────────────────────
  var contextParts: string[] = [];
  for (var j = 0; j < contextChunks.length; j++) {
    var ch = contextChunks[j];
    var marker = "[DOC_ID: " + ch.document_id + " | FILE: " + ch.file_name + "]";
    contextParts.push(marker + "\n" + ch.content);
  }
  var contextString = contextParts.join(SEPARATOR);

  // ── Build documentsRepresented ────────────────────────────────────
  var docCounts = new Map<string, { file_name: string; chunk_count: number }>();
  for (var k = 0; k < contextChunks.length; k++) {
    var dc = contextChunks[k];
    var existing = docCounts.get(dc.document_id);
    if (existing) {
      existing.chunk_count += 1;
    } else {
      docCounts.set(dc.document_id, { file_name: dc.file_name, chunk_count: 1 });
    }
  }
  var documentsRepresented: Array<{ file_name: string; chunk_count: number }> = [];
  docCounts.forEach(function (v) { documentsRepresented.push(v); });

  // ── Return diagnostic payload, status in_progress ─────────────────
  return {
    stage: "build_entity_manifest",
    status: "in_progress",
    message: "Retrieval complete. " + String(contextChunks.length) + " chunks assembled, " + String(chunksTruncated) + " truncated by char cap.",
    stageData: {
      perQueryCounts: perQueryCounts,
      mergedChunkCount: contextChunks.length,
      contextCharCount: contextString.length,
      chunksTruncated: chunksTruncated,
      documentsRepresented: documentsRepresented,
      contextHead: contextString.slice(0, 1500),
    },
  };
}
