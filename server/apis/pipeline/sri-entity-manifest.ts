/**
 * SRI v2 — Entity Manifest, Section 1: FTS Retrieval and Context Assembly
 *
 * Retrieves document chunks via full-text search for four query categories
 * (brand, leadership, workforce, group structure), plus a structural roster
 * pass based on company-suffix density. Round-robin interleaving, boilerplate
 * filter, reserved roster budget, truncation to character cap.
 * No LLM call, no database inserts, no completion marker.
 */

import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./sri-stage-contract.js";

// ── Constants ───────────────────────────────────────────────────────
var ALLOWLIST_TAGS = ["cim", "ic_memo", "consultant_report", "legal"];
var MAX_CHUNKS_PER_QUERY = 60;
var MAX_CONTEXT_CHARS = 90000;
var ROSTER_SUFFIX_FLOOR = 10;
var ROSTER_MAX_CANDIDATES = 12;
var ROSTER_RESERVED_CHARS = 25000;

var BRAND_QUERY = "brand trading name customer facing brands operating under portfolio businesses";
var LEADERSHIP_QUERY = "management team chief executive officer founder leadership board of directors";
var WORKFORCE_QUERY = "employees headcount staff colleagues culture engagement retention attrition";
var GROUP_QUERY = "acquisition acquired trading companies group structure business units subsidiaries Ltd Limited";

var CHUNK_SQL = "WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq) SELECT dc.document_id, dc.chunk_index, dc.file_name, dc.content, ts_rank_cd(dc.tsv, q.tsq) AS rank FROM document_chunks dc JOIN documents d ON d.id = dc.document_id CROSS JOIN q WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND d.document_tag = ANY($3::text[]) ORDER BY ts_rank_cd(dc.tsv, q.tsq) DESC, dc.chunk_index ASC LIMIT $4";

var COUNT_SQL = "WITH q AS (SELECT websearch_to_tsquery('english', $2) AS tsq) SELECT count(*)::int AS total FROM document_chunks dc JOIN documents d ON d.id = dc.document_id CROSS JOIN q WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND d.document_tag = ANY($3::text[]) AND dc.tsv @@ q.tsq";

var ROSTER_SQL = "SELECT dc.document_id, dc.chunk_index, dc.file_name, dc.content, (SELECT count(*)::int FROM regexp_matches(dc.content, '\\m(Ltd|Limited|plc|PLC|Pty)\\M', 'g')) AS suffix_count FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid AND d.document_tag = ANY($2::text[]) ORDER BY suffix_count DESC LIMIT $3";

var ChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  rank: z.coerce.number(),
});

var RosterChunkRow = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  file_name: z.string(),
  content: z.string(),
  suffix_count: z.coerce.number(),
});

var CountRow = z.object({ total: z.coerce.number() });

var SEPARATOR = "\n---\n";

// ── Boilerplate denylist ────────────────────────────────────────────
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

// ── Suffix density counter (code-side, for diagnostics) ─────────────
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
    CHUNK_SQL, ChunkRow,
    [dealId, BRAND_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS brand" },
  );
  var leadershipChunks: ChunkType[] = await db.query(
    CHUNK_SQL, ChunkRow,
    [dealId, LEADERSHIP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS leadership" },
  );
  var workforceChunks: ChunkType[] = await db.query(
    CHUNK_SQL, ChunkRow,
    [dealId, WORKFORCE_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS workforce" },
  );
  var groupChunks: ChunkType[] = await db.query(
    CHUNK_SQL, ChunkRow,
    [dealId, GROUP_QUERY, ALLOWLIST_TAGS, MAX_CHUNKS_PER_QUERY],
    { label: "SRI EntityManifest: FTS group structure" },
  );

  // ── Total match counts (no LIMIT) ────────────────────────────────
  var brandTotal = await db.query(COUNT_SQL, CountRow, [dealId, BRAND_QUERY, ALLOWLIST_TAGS], { label: "SRI count: brand" });
  var leadershipTotal = await db.query(COUNT_SQL, CountRow, [dealId, LEADERSHIP_QUERY, ALLOWLIST_TAGS], { label: "SRI count: leadership" });
  var workforceTotal = await db.query(COUNT_SQL, CountRow, [dealId, WORKFORCE_QUERY, ALLOWLIST_TAGS], { label: "SRI count: workforce" });
  var groupTotal = await db.query(COUNT_SQL, CountRow, [dealId, GROUP_QUERY, ALLOWLIST_TAGS], { label: "SRI count: group" });

  var totalMatchesPerQuery = {
    brand: brandTotal[0]?.total ?? 0,
    leadership: leadershipTotal[0]?.total ?? 0,
    workforce: workforceTotal[0]?.total ?? 0,
    group: groupTotal[0]?.total ?? 0,
  };

  var perQueryCounts = {
    brand: brandChunks.length,
    leadership: leadershipChunks.length,
    workforce: workforceChunks.length,
    group: groupChunks.length,
  };

  // ── Roster pass: direct SQL by suffix density ─────────────────────
  var rosterCandidates = await db.query(
    ROSTER_SQL, RosterChunkRow,
    [dealId, ALLOWLIST_TAGS, ROSTER_MAX_CANDIDATES],
    { label: "SRI EntityManifest: roster candidates by suffix density" },
  );

  var rosterTopCounts: Array<{ file_name: string; chunk_index: number; suffix_count: number }> = [];
  for (var ri = 0; ri < rosterCandidates.length; ri++) {
    var rc = rosterCandidates[ri];
    rosterTopCounts.push({ file_name: rc.file_name, chunk_index: rc.chunk_index, suffix_count: rc.suffix_count });
  }

  var rosterSurvivors = rosterCandidates.filter(function (c: z.infer<typeof RosterChunkRow>) { return c.suffix_count >= ROSTER_SUFFIX_FLOOR; });

  // ── Boilerplate filter on FTS pools ───────────────────────────────
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

  var ftsPools = [
    { name: "brand" as const, chunks: filterBoilerplate(brandChunks) },
    { name: "leadership" as const, chunks: filterBoilerplate(leadershipChunks) },
    { name: "workforce" as const, chunks: filterBoilerplate(workforceChunks) },
    { name: "group" as const, chunks: filterBoilerplate(groupChunks) },
  ];

  // ── Phase 1: Roster survivors into context FIRST, exempt from cap ──
  var seen = new Set<string>();
  var contextChunks: Array<ChunkType & { source: string }> = [];
  var rosterCharCount = 0;
  var markerLen = 60;
  var perQuerySurvivors = { brand: 0, leadership: 0, workforce: 0, group: 0, roster: 0 };

  for (var rsi = 0; rsi < rosterSurvivors.length; rsi++) {
    var rs = rosterSurvivors[rsi];
    var rkey = rs.document_id + ":" + String(rs.chunk_index);
    if (seen.has(rkey)) continue;
    if (rosterCharCount + rs.content.length + markerLen > ROSTER_RESERVED_CHARS) break;
    seen.add(rkey);
    contextChunks.push({ document_id: rs.document_id, chunk_index: rs.chunk_index, file_name: rs.file_name, content: rs.content, rank: 0, source: "roster" });
    perQuerySurvivors.roster++;
    rosterCharCount += rs.content.length + markerLen;
  }

  // ── Phase 2: Round-robin FTS merge into remaining budget ──────────
  var ftsCharBudget = MAX_CONTEXT_CHARS - rosterCharCount;
  var ftsCharCount = 0;
  var cursors = [0, 0, 0, 0];
  var poolExhausted = { brand: false, leadership: false, workforce: false, group: false };
  var capReached = false;
  var anyPoolHasMore = true;

  while (!capReached && anyPoolHasMore) {
    anyPoolHasMore = false;
    for (var pi = 0; pi < ftsPools.length; pi++) {
      if (capReached) break;
      var ftsPool = ftsPools[pi];
      var cursor = cursors[pi];

      var found = false;
      while (cursor < ftsPool.chunks.length) {
        var c = ftsPool.chunks[cursor];
        var ckey = c.document_id + ":" + String(c.chunk_index);
        cursor++;
        if (seen.has(ckey)) continue;
        if (ftsCharCount + c.content.length + markerLen > ftsCharBudget) {
          capReached = true;
          break;
        }
        seen.add(ckey);
        contextChunks.push({ document_id: c.document_id, chunk_index: c.chunk_index, file_name: c.file_name, content: c.content, rank: c.rank, source: ftsPool.name });
        perQuerySurvivors[ftsPool.name]++;
        ftsCharCount += c.content.length + markerLen;
        found = true;
        break;
      }

      cursors[pi] = cursor;
      if (cursor < ftsPool.chunks.length) {
        anyPoolHasMore = true;
      } else {
        poolExhausted[ftsPool.name] = true;
        if (found) anyPoolHasMore = true;
      }
    }
    if (!capReached) {
      anyPoolHasMore = false;
      for (var qi = 0; qi < ftsPools.length; qi++) {
        if (cursors[qi] < ftsPools[qi].chunks.length) {
          anyPoolHasMore = true;
          break;
        }
      }
    }
  }

  // ── Truncated count ───────────────────────────────────────────────
  var totalInContext = contextChunks.length;
  var remainingSeen = new Set<string>(seen);
  for (var rri = 0; rri < ftsPools.length; rri++) {
    for (var rrj = cursors[rri]; rrj < ftsPools[rri].chunks.length; rrj++) {
      var rrc = ftsPools[rri].chunks[rrj];
      remainingSeen.add(rrc.document_id + ":" + String(rrc.chunk_index));
    }
  }
  var chunksTruncated = remainingSeen.size - seen.size;

  if (contextChunks.length === 0) {
    return {
      stage: "build_entity_manifest",
      status: "failed",
      message: "No document chunks found for FTS retrieval. Likely cause: document tagging or missing chunks for deal " + dealId + ".",
    };
  }

  // ── Build context string ──────────────────────────────────────────
  var contextParts: string[] = [];
  var rosterContextParts: string[] = [];
  for (var j = 0; j < contextChunks.length; j++) {
    var ch = contextChunks[j];
    var marker = "[DOC_ID: " + ch.document_id + " | FILE: " + ch.file_name + "]";
    var part = marker + "\n" + ch.content;
    contextParts.push(part);
    if (ch.source === "roster") {
      rosterContextParts.push(part);
    }
  }
  var contextString = contextParts.join(SEPARATOR);
  var rosterContextString = rosterContextParts.join(SEPARATOR);

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

  // ── suffixDensityTop: top 5 FTS+roster chunks by suffix count ─────
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

  // ── Return diagnostic payload ─────────────────────────────────────
  return {
    stage: "build_entity_manifest",
    status: "in_progress",
    message: "Retrieval complete. " + String(contextChunks.length) + " chunks (" + String(perQuerySurvivors.roster) + " roster + " + String(contextChunks.length - perQuerySurvivors.roster) + " FTS), " + String(chunksTruncated) + " truncated, " + String(boilerplateDropped) + " boilerplate dropped.",
    stageData: {
      perQueryCounts: perQueryCounts,
      totalMatchesPerQuery: totalMatchesPerQuery,
      perQuerySurvivors: perQuerySurvivors,
      mergedChunkCount: contextChunks.length,
      contextCharCount: contextString.length,
      rosterCharCount: rosterCharCount,
      ftsCharCount: ftsCharCount,
      chunksTruncated: chunksTruncated,
      boilerplateDropped: boilerplateDropped,
      poolExhausted: poolExhausted,
      rosterCandidateCount: rosterCandidates.length,
      rosterSurvivorCount: rosterSurvivors.length,
      rosterTopCounts: rosterTopCounts,
      suffixDensityTop: suffixDensityTop,
      documentsRepresented: documentsRepresented,
      contextHead: contextString.slice(0, 1500),
      rosterContextHead: rosterContextString.slice(0, 2000),
    },
  };
}
