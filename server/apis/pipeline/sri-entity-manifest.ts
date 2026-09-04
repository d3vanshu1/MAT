/**
 * SRI v2 — Entity Manifest, Section 1: FTS Retrieval and Context Assembly
 *
 * Retrieves document chunks via full-text search for four query categories
 * (brand, leadership, workforce, group structure), deduplicates via round-robin
 * interleaving, filters boilerplate, truncates to a character budget, and
 * returns the assembled context as diagnostic payload.
 * No LLM call, no database inserts, no completion marker.
 */

import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./sri-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
var ALLOWLIST_TAGS = ["cim", "ic_memo", "consultant_report", "legal"];
var MAX_CHUNKS_PER_QUERY = 60;
var MAX_CONTEXT_CHARS = 90000;

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

// ── Boilerplate denylist ────────────────────────────────────────────
// A chunk is dropped if it matches TWO or more distinct phrases.
var BOILERPLATE_PHRASES = [
  "strictly private and confidential",
  "has consented to the inclusion of this report",
  "conditions of entry to the data room",
  "no duty of care",
  "to the fullest extent permitted by law",
  "this report has been prepared solely",
  "accepts no liability",
  "disclaimer",
];

function isBoilerplate(content: string): boolean {
  var lower = content.toLowerCase();
  var hits = 0;
  for (var p = 0; p < BOILERPLATE_PHRASES.length; p++) {
    if (lower.indexOf(BOILERPLATE_PHRASES[p]) !== -1) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

// ── Suffix density counter ──────────────────────────────────────────
var SUFFIX_PATTERNS = [/\bLtd\b/g, /\bLimited\b/g, /\bplc\b/g, /\bPLC\b/g, /\bPty\b/g];

function countSuffixes(content: string): number {
  var total = 0;
  for (var s = 0; s < SUFFIX_PATTERNS.length; s++) {
    var matches = content.match(SUFFIX_PATTERNS[s]);
    if (matches) total += matches.length;
  }
  return total;
}

type ChunkType = z.infer<typeof ChunkRow>;

export async function buildEntityManifest(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  var db = ctx.integrations.db;

  // ── FTS retrieval: four query categories ──────────────────────────
  var brandChunks: ChunkType[] = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, BRAND_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS brand" },
  );

  var leadershipChunks: ChunkType[] = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, LEADERSHIP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS leadership" },
  );

  var workforceChunks: ChunkType[] = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, WORKFORCE_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS workforce" },
  );

  var groupChunks: ChunkType[] = await db.query(
    CHUNK_SQL,
    ChunkRow,
    [dealId, GROUP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS group structure" },
  );

  var perQueryCounts = {
    brand: brandChunks.length,
    leadership: leadershipChunks.length,
    workforce: workforceChunks.length,
    group: groupChunks.length,
  };

  // ── Boilerplate filter ────────────────────────────────────────────
  var boilerplateDropped = 0;

  function filterBoilerplate(pool: ChunkType[]): ChunkType[] {
    var out: ChunkType[] = [];
    for (var i = 0; i < pool.length; i++) {
      if (isBoilerplate(pool[i].content)) {
        boilerplateDropped++;
      } else {
        out.push(pool[i]);
      }
    }
    return out;
  }

  var pools = [
    { name: "brand" as const, chunks: filterBoilerplate(brandChunks) },
    { name: "leadership" as const, chunks: filterBoilerplate(leadershipChunks) },
    { name: "workforce" as const, chunks: filterBoilerplate(workforceChunks) },
    { name: "group" as const, chunks: filterBoilerplate(groupChunks) },
  ];

  // ── Round-robin merge with dedup and character cap ────────────────
  var seen = new Set<string>();
  var contextChunks: ChunkType[] = [];
  var chunkSource: string[] = []; // parallel array: which query first surfaced each chunk
  var totalChars = 0;
  var markerLen = 60;
  var cursors = [0, 0, 0, 0];
  var poolExhausted = { brand: false, leadership: false, workforce: false, group: false };
  var perQuerySurvivors = { brand: 0, leadership: 0, workforce: 0, group: 0 };

  var capReached = false;
  var anyPoolHasMore = true;

  while (!capReached && anyPoolHasMore) {
    anyPoolHasMore = false;
    for (var pi = 0; pi < pools.length; pi++) {
      if (capReached) break;
      var pool = pools[pi];
      var cursor = cursors[pi];

      // Find next unclaimed chunk in this pool
      var found = false;
      while (cursor < pool.chunks.length) {
        var c = pool.chunks[cursor];
        var key = c.document_id + ":" + String(c.chunk_index);
        cursor++;

        if (seen.has(key)) continue;

        // Check char cap
        if (totalChars + c.content.length + markerLen > MAX_CONTEXT_CHARS) {
          capReached = true;
          break;
        }

        seen.add(key);
        contextChunks.push(c);
        chunkSource.push(pool.name);
        perQuerySurvivors[pool.name]++;
        totalChars += c.content.length + markerLen;
        found = true;
        break;
      }

      cursors[pi] = cursor;
      if (cursor < pool.chunks.length) {
        anyPoolHasMore = true;
      } else {
        poolExhausted[pool.name] = true;
        if (found) anyPoolHasMore = true; // other pools may still have chunks
      }
    }
    // Re-check if any pool has more
    if (!capReached) {
      anyPoolHasMore = false;
      for (var qi = 0; qi < pools.length; qi++) {
        if (cursors[qi] < pools[qi].chunks.length) {
          anyPoolHasMore = true;
          break;
        }
      }
    }
  }

  var totalUniquePreCap = seen.size;
  // Count remaining unclaimed chunks across all pools for the truncated count
  var remainingSeen = new Set<string>(seen);
  for (var ri = 0; ri < pools.length; ri++) {
    for (var rj = cursors[ri]; rj < pools[ri].chunks.length; rj++) {
      var rc = pools[ri].chunks[rj];
      var rkey = rc.document_id + ":" + String(rc.chunk_index);
      remainingSeen.add(rkey);
    }
  }
  var chunksTruncated = remainingSeen.size - totalUniquePreCap;

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

  // ── documentsRepresented ──────────────────────────────────────────
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

  // ── suffixDensityTop: top 5 chunks by Ltd/Limited/plc/PLC/Pty count ──
  var suffixScored: Array<{ file_name: string; chunk_index: number; suffix_count: number }> = [];
  for (var si = 0; si < contextChunks.length; si++) {
    var sc = contextChunks[si];
    var scount = countSuffixes(sc.content);
    if (scount > 0) {
      suffixScored.push({ file_name: sc.file_name, chunk_index: sc.chunk_index, suffix_count: scount });
    }
  }
  suffixScored.sort(function (a, b) { return b.suffix_count - a.suffix_count; });
  var suffixDensityTop = suffixScored.slice(0, 5);

  // ── Return diagnostic payload, status in_progress ─────────────────
  return {
    stage: "build_entity_manifest",
    status: "in_progress",
    message: "Retrieval complete. " + String(contextChunks.length) + " chunks assembled, " + String(chunksTruncated) + " truncated by char cap, " + String(boilerplateDropped) + " boilerplate dropped.",
    stageData: {
      perQueryCounts: perQueryCounts,
      perQuerySurvivors: perQuerySurvivors,
      mergedChunkCount: contextChunks.length,
      contextCharCount: contextString.length,
      chunksTruncated: chunksTruncated,
      boilerplateDropped: boilerplateDropped,
      poolExhausted: poolExhausted,
      suffixDensityTop: suffixDensityTop,
      documentsRepresented: documentsRepresented,
      contextHead: contextString.slice(0, 1500),
    },
  };
}
