/**
 * sri-target-identity.ts
 *
 * SriBuildTargetIdentity — discovers candidate web domains from deal documents
 * by structural signals. All candidates are persisted as candidate_domain.
 * Nothing is classified as the target; pinning via SriPinIdentity decides.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { StageResult } from "./sri-stage-contract.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

var LOG_PREFIX = "[SRI-TargetIdentity]";

// ── Exclusion set derived from platform registry allowed_domains ────
// Review platforms are by definition not the target.
var PLATFORM_DOMAINS_EXCLUSION = new Set([
  // From PLATFORM_ALLOWED_DOMAINS in sri-verify-claims.ts
  "glassdoor.com", "glassdoor.co.uk",
  "indeed.com", "uk.indeed.com",
  "linkedin.com",
  "trustpilot.com", "uk.trustpilot.com",
  "g2.com",
  // Generic infrastructure (no national domains, no regulators, no firms, no sectors)
  "google.com", "google.co.uk", "google.de", "google.fr",
  "youtube.com",
  "facebook.com", "twitter.com", "x.com", "instagram.com",
  "wikipedia.org", "en.wikipedia.org",
  "github.com", "stackoverflow.com",
  "microsoft.com", "apple.com", "amazon.com",
  "mail.google.com", "drive.google.com", "docs.google.com",
  "bit.ly", "t.co", "tinyurl.com",
  "mailto", // not a domain but may match
]);

// ── Domain extraction regex ─────────────────────────────────────────
// Matches URLs and domain-like strings in text.
var URL_REGEX = /https?:\/\/(?:www\.)?([a-zA-Z0-9](?:[a-zA-Z0-9\-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/gi;
var DOMAIN_REGEX = /(?:^|[\s(,;])(?:www\.)?([a-zA-Z0-9](?:[a-zA-Z0-9\-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})(?:[\s),;/]|$)/gi;

function normalizeDomain(raw: string): string {
  var d = raw.toLowerCase().trim();
  if (d.startsWith("www.")) d = d.slice(4);
  return d;
}

function isExcluded(domain: string): boolean {
  if (PLATFORM_DOMAINS_EXCLUSION.has(domain)) return true;
  // Check if it's a subdomain of an excluded domain
  for (var excl of PLATFORM_DOMAINS_EXCLUSION) {
    if (domain.endsWith("." + excl)) return true;
  }
  // Exclude single-segment "domains" (no dot)
  if (domain.indexOf(".") === -1) return false; // will be filtered by TLD check
  return false;
}

function extractDomainsFromText(text: string): string[] {
  var domains: string[] = [];
  var seen = new Set<string>();

  // Extract from URLs
  var urlMatch: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((urlMatch = URL_REGEX.exec(text)) !== null) {
    var d = normalizeDomain(urlMatch[1]);
    if (d && !seen.has(d) && !isExcluded(d)) {
      seen.add(d);
      domains.push(d);
    }
  }

  // Extract standalone domain-like strings
  DOMAIN_REGEX.lastIndex = 0;
  var domMatch: RegExpExecArray | null;
  while ((domMatch = DOMAIN_REGEX.exec(text)) !== null) {
    var d2 = normalizeDomain(domMatch[1]);
    if (d2 && !seen.has(d2) && !isExcluded(d2)) {
      // Must have at least 2 segments
      if (d2.split(".").length >= 2) {
        seen.add(d2);
        domains.push(d2);
      }
    }
  }

  return domains;
}

// ── Context hash for repetition signal ──────────────────────────────
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function simpleHash(s: string): number {
  var hash = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash | 0; // 32-bit int
  }
  return hash;
}

function getContext(text: string, startIdx: number, radius: number): string {
  var left = Math.max(0, startIdx - radius);
  var right = Math.min(text.length, startIdx + radius);
  return normalizeWs(text.slice(left, right));
}

// ── Types ───────────────────────────────────────────────────────────
type DomainCandidate = {
  domain: string;
  occurrence_count: number;
  distinct_document_count: number;
  document_class_set: string[];
  appears_in_business_docs: boolean;
  appears_in_advisory_only: boolean;
  context_repetition_ratio: number;
  distinct_context_hashes: number;
  rank: number;
  first_snippet: string;
};

var ChunkRow = z.object({
  document_id: z.string(),
  document_tag: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
});

var RunIdRow = z.object({
  run_id: z.string(),
});

export default api({
  name: "SriBuildTargetIdentity",
  description: "Discovers candidate web domains from deal documents by structural signals.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    dealId: z.string(),
  }),
  output: z.object({
    candidates: z.array(z.any()),
    totalChunksScanned: z.number(),
    totalDomainsFound: z.number(),
    totalExcluded: z.number(),
  }),
  async run(ctx, { dealId }) {
    var db = ctx.integrations.db;

    // Get the run_id for this deal
    var runRows = await db.query(
      "SELECT run_id FROM sri_pipeline_state WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1",
      RunIdRow,
      [dealId],
      { label: LOG_PREFIX + " get run_id" },
    );
    if (runRows.length === 0) {
      throw new Error("No SRI pipeline run found for deal " + dealId);
    }
    var runId = runRows[0].run_id;

    // Load all chunks from ic_memo, cim, legal, consultant_report
    var chunks = await db.query(
      "SELECT dc.document_id, d.document_tag, dc.chunk_index, dc.content FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE d.deal_id = $1 AND d.document_tag IN ('ic_memo', 'cim', 'legal', 'consultant_report') ORDER BY d.document_tag, dc.document_id, dc.chunk_index",
      ChunkRow,
      [dealId],
      { label: LOG_PREFIX + " load chunks" },
    );

    console.log(LOG_PREFIX + " Scanning " + chunks.length + " chunks across " + new Set(chunks.map(function (c) { return c.document_id; })).size + " documents");

    // ── Scan all chunks for domains ─────────────────────────────────
    // Per domain: occurrences (with context hashes), document IDs, document classes
    var domainData = new Map<string, {
      occurrences: number;
      documentIds: Set<string>;
      documentClasses: Set<string>;
      contextHashes: Map<number, number>; // hash → count
      firstSnippet: string;
    }>();
    var totalExcluded = 0;

    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      var text = chunk.content;

      // Find all domain occurrences with context
      var allOccurrences: { domain: string; position: number }[] = [];

      URL_REGEX.lastIndex = 0;
      var m: RegExpExecArray | null;
      while ((m = URL_REGEX.exec(text)) !== null) {
        var d = normalizeDomain(m[1]);
        if (d && d.split(".").length >= 2) {
          if (isExcluded(d)) {
            totalExcluded++;
          } else {
            allOccurrences.push({ domain: d, position: m.index });
          }
        }
      }

      DOMAIN_REGEX.lastIndex = 0;
      while ((m = DOMAIN_REGEX.exec(text)) !== null) {
        var d2 = normalizeDomain(m[1]);
        if (d2 && d2.split(".").length >= 2) {
          if (isExcluded(d2)) {
            totalExcluded++;
          } else {
            // Avoid double-counting if already found by URL regex
            var alreadyCounted = false;
            for (var ac = 0; ac < allOccurrences.length; ac++) {
              if (allOccurrences[ac].domain === d2 && Math.abs(allOccurrences[ac].position - m.index) < 10) {
                alreadyCounted = true;
                break;
              }
            }
            if (!alreadyCounted) {
              allOccurrences.push({ domain: d2, position: m.index });
            }
          }
        }
      }

      // Record each occurrence
      for (var oi = 0; oi < allOccurrences.length; oi++) {
        var occ = allOccurrences[oi];
        var entry = domainData.get(occ.domain);
        if (!entry) {
          // Capture first snippet: ~120 chars around first occurrence
          var snippetStart = Math.max(0, occ.position - 40);
          var snippetEnd = Math.min(text.length, occ.position + 80);
          var snippet = text.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim();

          entry = {
            occurrences: 0,
            documentIds: new Set(),
            documentClasses: new Set(),
            contextHashes: new Map(),
            firstSnippet: snippet,
          };
          domainData.set(occ.domain, entry);
        }

        entry.occurrences++;
        entry.documentIds.add(chunk.document_id);
        entry.documentClasses.add(chunk.document_tag);

        // Context hash: ~80 chars either side
        var ctxStr = getContext(text, occ.position, 80);
        var ctxHash = simpleHash(ctxStr);
        entry.contextHashes.set(ctxHash, (entry.contextHashes.get(ctxHash) || 0) + 1);
      }
    }

    // ── Build candidate list with all signals ───────────────────────
    var candidates: DomainCandidate[] = [];

    domainData.forEach(function (data, domain) {
      var docClassArr = Array.from(data.documentClasses).sort();
      var businessDocs = data.documentClasses.has("cim") || data.documentClasses.has("ic_memo");
      var advisoryOnly = !businessDocs && (data.documentClasses.has("legal") || data.documentClasses.has("consultant_report"));

      // Context repetition: proportion of occurrences sharing the most common context hash
      var maxHashCount = 0;
      data.contextHashes.forEach(function (count) {
        if (count > maxHashCount) maxHashCount = count;
      });
      var contextRepRatio = data.occurrences > 0 ? maxHashCount / data.occurrences : 0;

      candidates.push({
        domain: domain,
        occurrence_count: data.occurrences,
        distinct_document_count: data.documentIds.size,
        document_class_set: docClassArr,
        appears_in_business_docs: businessDocs,
        appears_in_advisory_only: advisoryOnly,
        context_repetition_ratio: Math.round(contextRepRatio * 100) / 100,
        distinct_context_hashes: data.contextHashes.size,
        rank: 0, // assigned after sorting
        first_snippet: data.firstSnippet.slice(0, 200),
      });
    });

    // ── Rank by: appears_in_business_docs DESC, occurrence_count DESC ─
    candidates.sort(function (a, b) {
      if (a.appears_in_business_docs !== b.appears_in_business_docs) {
        return a.appears_in_business_docs ? -1 : 1;
      }
      return b.occurrence_count - a.occurrence_count;
    });
    for (var ri = 0; ri < candidates.length; ri++) {
      candidates[ri].rank = ri + 1;
    }

    // ── Persist all candidates as candidate_domain ──────────────────
    // Delete existing candidates for this run first (idempotent re-run)
    await db.execute(
      "DELETE FROM sri_target_identity WHERE run_id = $1 AND identity_type IN ('candidate_domain', 'rejected_domain')",
      [runId],
      { label: LOG_PREFIX + " clear previous candidates" },
    );

    for (var pi = 0; pi < candidates.length; pi++) {
      var c = candidates[pi];
      var confidenceNote = "rank_" + c.rank
        + " | docs:" + c.distinct_document_count
        + " | classes:" + c.document_class_set.join(",")
        + " | biz:" + (c.appears_in_business_docs ? "Y" : "N")
        + " | adv_only:" + (c.appears_in_advisory_only ? "Y" : "N")
        + " | ctx_rep:" + c.context_repetition_ratio
        + " | ctx_hashes:" + c.distinct_context_hashes;

      await db.execute(
        "INSERT INTO sri_target_identity (run_id, identity_type, identity_value, confidence, occurrence_count, verbatim_snippet) VALUES ($1, 'candidate_domain', $2, $3, $4, $5) ON CONFLICT (run_id, identity_type, identity_value) DO UPDATE SET confidence = EXCLUDED.confidence, occurrence_count = EXCLUDED.occurrence_count, verbatim_snippet = EXCLUDED.verbatim_snippet",
        [runId, c.domain, confidenceNote, c.occurrence_count, c.first_snippet],
        { label: LOG_PREFIX + " persist candidate " + c.domain },
      );
    }

    console.log(LOG_PREFIX + " Discovered " + candidates.length + " candidate domains from " + chunks.length + " chunks");

    return {
      candidates: candidates,
      totalChunksScanned: chunks.length,
      totalDomainsFound: candidates.length,
      totalExcluded: totalExcluded,
    };
  },
});
