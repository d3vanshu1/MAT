/**
 * Diagnostic Saint Reconciliation — READ-ONLY
 *
 * Extracts the 46 Q2 candidates from the SCG contradiction_check run,
 * loads the claims ledger, builds the origin map from universal_extractions,
 * and produces a full 46-row reconciliation ledger with explicit outcomes.
 *
 * Does NOT write to any tables.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  parseClaimId,
  isLegacyClaimId,
  isGlobalClaimId,
  buildOriginMapFromRoutedArray,
} from "./claim-origin-map.js";
import type { IdentifiedClaim } from "./claims-ledger-identity.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Helper: compute flat claim index from chunk/claim coordinates
// Given extractionRows for a document, counts how many claims precede
// chunk_index:claim_index in document order.
// ---------------------------------------------------------------------------
function computeFlatClaimIndex(
  extractionRows: Array<{ document_id: string; chunk_index: number; extraction_json?: any }>,
  documentId: string,
  targetChunkIndex: number,
  claimIndexInChunk: number,
): number | null {
  // Get all chunks for this document, sorted by chunk_index
  const docChunks = extractionRows
    .filter(r => r.document_id === documentId)
    .sort((a, b) => a.chunk_index - b.chunk_index);

  let flatIndex = 0;
  for (const chunk of docChunks) {
    const ext = typeof chunk.extraction_json === "string"
      ? JSON.parse(chunk.extraction_json)
      : chunk.extraction_json;
    const claims = ext?.key_claims ?? ext?.claims ?? [];
    const numClaims = Array.isArray(claims) ? claims.length : 0;

    if (chunk.chunk_index === targetChunkIndex) {
      if (claimIndexInChunk < numClaims) {
        return flatIndex + claimIndexInChunk;
      }
      return null; // claim_index out of bounds for this chunk
    }
    flatIndex += numClaims;
  }
  return null; // chunk not found
}

// Resolution methods in priority order
type ResolutionMethod =
  | "exact_persisted_mapping"
  | "origin_map_positional"
  | "document_source_page_text"
  | "document_metric_period_scope"
  | "canonical_id_direct"
  | "unresolved_ambiguous"
  | "unresolved_no_match"
  | "unresolved_missing_ref"
  | "unresolved_malformed";

interface ReconciliationRow {
  finding_id: string;
  corpus_index: number;
  finding_title: string;
  legacy_claim_ref: string | null;
  ref_type: "positional" | "global" | "slug" | "none" | "malformed";
  originating_memo_metadata: {
    source_tag: string | null;
    source_docs: string[];
    doc_type: string | null;
  };
  resolved_claim_id: string | null;
  resolved_claim_text: string | null;
  resolved_memo_version: string | null;
  matching_method: ResolutionMethod;
  candidate_match_count: number;
  confidence: "high" | "medium" | "low" | "none";
  ambiguity_reason: string | null;
  rejection_reason: string | null;
}

export default api({
  name: "DiagSaintReconciliation",
  description: "Read-only reconciliation of all 46 Saint Q2 candidates against claims ledger",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    runId: z.string(),
  }),

  output: z.object({
    total_candidates: z.number(),
    reconciliation_ledger: z.array(z.any()),
    summary: z.object({
      resolved_exact: z.number(),
      resolved_positional: z.number(),
      resolved_text_match: z.number(),
      resolved_metric_match: z.number(),
      unresolved_ambiguous: z.number(),
      unresolved_no_match: z.number(),
      unresolved_missing_ref: z.number(),
      unresolved_malformed: z.number(),
      total_resolved: z.number(),
      total_unresolved: z.number(),
    }),
    claims_ledger_stats: z.object({
      total_claims: z.number(),
      by_memo_version: z.record(z.string(), z.number()),
      by_document: z.record(z.string(), z.number()),
    }),
    origin_map_stats: z.object({
      total_entries: z.number(),
      ambiguous_legacy_ids: z.number(),
      documents_covered: z.number(),
    }),
    sample_mappings: z.array(z.any()),
  }),

  async run(ctx, { dealId, runId }) {
    // 1. Load Q2 disposition ledger (tree_level=97)
    const LedgerRow = z.object({ merged_json: z.any() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 97 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      LedgerRow,
      [runId],
      { label: "Load Q2 disposition ledger" }
    );

    if (ledgerRows.length === 0) {
      throw new Error(`No disposition ledger found for run ${runId}`);
    }

    const ledgerParsed = typeof ledgerRows[0].merged_json === "string"
      ? JSON.parse(ledgerRows[0].merged_json)
      : ledgerRows[0].merged_json;

    const ledgerEntries = (ledgerParsed.ledger || []) as Array<any>;

    // 2. Load the full findings from merge_checkpoints (tree_level ≤ 5 = raw analysis results)
    const FindingRow = z.object({ merged_json: z.any(), tree_level: z.number() });
    const findingRows = await ctx.integrations.db.query(
      `SELECT merged_json, tree_level FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level <= 5
       ORDER BY tree_level ASC, node_index ASC
       LIMIT 100`,
      FindingRow,
      [runId],
      { label: "Load raw analysis findings" }
    );

    // Extract individual findings from merged results
    const findingsMap = new Map<string, any>();
    for (const row of findingRows) {
      const parsed = typeof row.merged_json === "string"
        ? JSON.parse(row.merged_json)
        : row.merged_json;
      const findings = parsed.findings ?? parsed.results ?? [];
      if (Array.isArray(findings)) {
        for (const f of findings) {
          if (f.finding_id || f.id) {
            findingsMap.set(f.finding_id ?? f.id, f);
          }
        }
      }
    }

    // 3. Load claims ledger (tree_level=99)
    const ClaimsRow = z.object({ merged_json: z.any() });
    const claimsRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      ClaimsRow,
      [runId],
      { label: "Load claims ledger (tree_level=99)" }
    );

    let enrichedClaims: IdentifiedClaim[] = [];
    if (claimsRows.length > 0) {
      const claimsParsed = typeof claimsRows[0].merged_json === "string"
        ? JSON.parse(claimsRows[0].merged_json)
        : claimsRows[0].merged_json;
      enrichedClaims = (claimsParsed.claims ?? []) as IdentifiedClaim[];
    }

    // Also try pipeline_checkpoints if tree_level=99 doesn't have it
    if (enrichedClaims.length === 0) {
      const FallbackRow = z.object({ payload: z.any() });
      const fallbackRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
         ORDER BY created_at DESC LIMIT 1`,
        FallbackRow,
        [runId],
        { label: "Fallback: claims_ledger from pipeline_checkpoints" }
      );
      if (fallbackRows.length > 0) {
        const fbParsed = typeof fallbackRows[0].payload === "string"
          ? JSON.parse(fallbackRows[0].payload)
          : fallbackRows[0].payload;
        enrichedClaims = (fbParsed.claims ?? []) as IdentifiedClaim[];
      }
    }

    // Build lookup indices
    const claimById = new Map<string, IdentifiedClaim>();
    const claimsByMetricPeriodScope = new Map<string, IdentifiedClaim[]>();
    const claimsByDocPageText = new Map<string, IdentifiedClaim>();
    // Claims indexed by document — ordered list for positional resolution
    const claimsByDocument = new Map<string, IdentifiedClaim[]>();

    for (const claim of enrichedClaims) {
      claimById.set(claim.claim_id, claim);

      // Index claims per document in extraction order
      if (!claimsByDocument.has(claim.ic_document_id)) {
        claimsByDocument.set(claim.ic_document_id, []);
      }
      claimsByDocument.get(claim.ic_document_id)!.push(claim);

      // Index by metric+period+scope
      const mpsKey = `${(claim.metric ?? "").toLowerCase()}|${(claim.period ?? "").toLowerCase()}|${(claim.scope_qualifier ?? "").toLowerCase()}`;
      if (!claimsByMetricPeriodScope.has(mpsKey)) {
        claimsByMetricPeriodScope.set(mpsKey, []);
      }
      claimsByMetricPeriodScope.get(mpsKey)!.push(claim);

      // Index by doc+page+text
      if (claim.ic_document_id && claim.source_page && claim.verbatim_snippet) {
        const textKey = `${claim.ic_document_id}|${claim.source_page}|${claim.verbatim_snippet.slice(0, 100).toLowerCase()}`;
        claimsByDocPageText.set(textKey, claim);
      }
    }

    // 4. Load universal_extractions for origin map construction
    // Only load IC memo document extractions to avoid gRPC size limits
    // First get IC document IDs
    const IcDocRow = z.object({ id: z.string() });
    const icDocRows = await ctx.integrations.db.query(
      `SELECT id FROM documents
       WHERE deal_id = $1 AND document_tag = 'ic_memo'
       LIMIT 20`,
      IcDocRow,
      [dealId],
      { label: "Load IC memo document IDs" }
    );
    const icDocumentIds = new Set(icDocRows.map(d => d.id));

    // Get document filenames
    const DocRow = z.object({ id: z.string(), file_name: z.string() });
    const docRows = await ctx.integrations.db.query(
      `SELECT id, file_name FROM documents WHERE deal_id = $1 LIMIT 50`,
      DocRow,
      [dealId],
      { label: "Load document filenames" }
    );
    const idToFileName = new Map(docRows.map(d => [d.id, d.file_name]));

    // Load extractions only for IC memo documents (smaller payload)
    const ExtractionRow = z.object({
      document_id: z.string(),
      chunk_index: z.coerce.number(),
      extraction_json: z.any(),
    });
    let extractionRows: Array<{ document_id: string; chunk_index: number; extraction_json?: any }> = [];
    for (const docId of icDocumentIds) {
      const rows = await ctx.integrations.db.query(
        `SELECT document_id, chunk_index, extraction_json
         FROM universal_extractions
         WHERE deal_id = $1 AND document_id = $2
         ORDER BY chunk_index
         LIMIT 100`,
        ExtractionRow,
        [dealId, docId],
        { label: `Load extractions for IC doc ${idToFileName.get(docId)?.slice(0, 30) ?? docId.slice(0, 8)}` }
      );
      extractionRows.push(...rows);
    }

    // Build origin map from IC document extractions
    const originMap = buildOriginMapFromRoutedArray(
      extractionRows.map(r => ({
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        extraction_json: r.extraction_json,
      })),
      idToFileName,
    );

    // 6. Reconcile each of the 46 candidates
    const reconciliationLedger: ReconciliationRow[] = [];

    for (const entry of ledgerEntries) {
      const findingId = entry.finding_id;
      const finding = findingsMap.get(findingId) ?? entry;
      const claimRef = finding.originating_claim_id ?? finding.claim_ids?.[0] ?? null;

      const row: ReconciliationRow = {
        finding_id: findingId,
        corpus_index: entry.corpus_index ?? -1,
        finding_title: entry.title ?? finding.title ?? "UNKNOWN",
        legacy_claim_ref: claimRef,
        ref_type: "none",
        originating_memo_metadata: {
          source_tag: finding.source_tag ?? null,
          source_docs: finding.source_docs ?? [],
          doc_type: finding.doc_type ?? null,
        },
        resolved_claim_id: null,
        resolved_claim_text: null,
        resolved_memo_version: null,
        matching_method: "unresolved_missing_ref",
        candidate_match_count: 0,
        confidence: "none",
        ambiguity_reason: null,
        rejection_reason: null,
      };

      if (!claimRef) {
        row.ref_type = "none";
        row.matching_method = "unresolved_missing_ref";
        row.rejection_reason = "No claim reference present on finding";
        reconciliationLedger.push(row);
        continue;
      }

      // Classify the reference type
      if (isLegacyClaimId(claimRef)) {
        row.ref_type = "positional";
      } else if (isGlobalClaimId(claimRef)) {
        row.ref_type = "global";
      } else if (/^[a-z][a-z0-9_]+$/.test(claimRef) && claimRef.length >= 5) {
        row.ref_type = "slug";
      } else if (/^clm-v1-/.test(claimRef)) {
        row.ref_type = "global";
      } else if (claimRef.length < 3) {
        row.ref_type = "malformed";
        row.matching_method = "unresolved_malformed";
        row.rejection_reason = `Reference '${claimRef}' is too short to be valid`;
        reconciliationLedger.push(row);
        continue;
      } else {
        row.ref_type = "slug";
      }

      // Priority 1: Exact canonical ID match
      if (claimById.has(claimRef)) {
        const claim = claimById.get(claimRef)!;
        row.resolved_claim_id = claim.claim_id;
        row.resolved_claim_text = claim.verbatim_snippet?.slice(0, 200) ?? null;
        row.resolved_memo_version = claim.memo_version ?? null;
        row.matching_method = "canonical_id_direct";
        row.candidate_match_count = 1;
        row.confidence = "high";
        reconciliationLedger.push(row);
        continue;
      }

      // Priority 2: Origin map positional lookup
      if (row.ref_type === "positional") {
        const parsed = parseClaimId(claimRef);
        if (parsed) {
          const { chunk_index, claim_index } = parsed;
          // Check origin map
          const originEntry = originMap.entries.get(claimRef);

          if (originEntry && !originMap.ambiguousLegacyIds.has(claimRef)) {
            // We have the origin document — now find the matching claim in the ledger
            // The origin map gives us document_id + chunk_index; the legacy ref gives claim_index
            // We need to find the claim at that positional slot within the document
            const docClaims = claimsByDocument.get(originEntry.document_id) ?? [];

            // Positional resolution: compute flat claim index from extraction chunk sizes
            if (docClaims.length > 0) {
              // Estimate flat index: count claims per chunk from extractions
              const flatIdx = computeFlatClaimIndex(extractionRows, originEntry.document_id, chunk_index, claim_index);
              if (flatIdx !== null && flatIdx < docClaims.length) {
                const posMatch = docClaims[flatIdx];
                row.resolved_claim_id = posMatch.claim_id;
                row.resolved_claim_text = posMatch.verbatim_snippet?.slice(0, 200) ?? null;
                row.resolved_memo_version = posMatch.memo_version ?? null;
                row.matching_method = "origin_map_positional";
                row.candidate_match_count = 1;
                row.confidence = "medium";
                reconciliationLedger.push(row);
                continue;
              }
            }
          }

          if (originMap.ambiguousLegacyIds.has(claimRef)) {
            row.matching_method = "unresolved_ambiguous";
            row.ambiguity_reason = `Legacy ID '${claimRef}' appears in multiple documents in the origin map`;
            row.rejection_reason = "Ambiguous: same positional ID exists in multiple IC documents";
            // Count how many docs it appears in
            const allDocsWithThisId = extractionRows.filter(er => {
              const ext = typeof er.extraction_json === "string" ? er.extraction_json : JSON.stringify(er.extraction_json);
              return ext.includes(`"${claimRef}"`) && er.chunk_index === chunk_index;
            });
            row.candidate_match_count = allDocsWithThisId.length;
            row.confidence = "none";
            reconciliationLedger.push(row);
            continue;
          }

          // Not in origin map at all — try positional fallback against IC docs
          // For each IC document, check if a claim at the given flat position exists
          const possibleDocs: IdentifiedClaim[] = [];
          for (const docId of icDocumentIds) {
            const docClaims = claimsByDocument.get(docId) ?? [];
            if (docClaims.length > 0) {
              const flatIdx = computeFlatClaimIndex(extractionRows, docId, chunk_index, claim_index);
              if (flatIdx !== null && flatIdx < docClaims.length) {
                possibleDocs.push(docClaims[flatIdx]);
              }
            }
          }

          if (possibleDocs.length === 1) {
            row.resolved_claim_id = possibleDocs[0].claim_id;
            row.resolved_claim_text = possibleDocs[0].verbatim_snippet?.slice(0, 200) ?? null;
            row.resolved_memo_version = possibleDocs[0].memo_version ?? null;
            row.matching_method = "origin_map_positional";
            row.candidate_match_count = 1;
            row.confidence = "medium";
            reconciliationLedger.push(row);
            continue;
          } else if (possibleDocs.length > 1) {
            row.matching_method = "unresolved_ambiguous";
            row.candidate_match_count = possibleDocs.length;
            row.ambiguity_reason = `Positional ref c${chunk_index}-${claim_index} matches ${possibleDocs.length} claims across IC documents`;
            row.rejection_reason = "Multiple IC documents have a claim at this position";
            row.confidence = "none";
            reconciliationLedger.push(row);
            continue;
          }

          // No match at all
          row.matching_method = "unresolved_no_match";
          row.candidate_match_count = 0;
          row.rejection_reason = `No claim found at position c${chunk_index}-${claim_index} in any IC document`;
          row.confidence = "none";
          reconciliationLedger.push(row);
          continue;
        }
      }

      // Priority 3: Slug references — try metric+period matching
      if (row.ref_type === "slug") {
        // Extract keywords from slug
        const slugParts = claimRef.toLowerCase().split(/[_\-]+/);
        // Try to find claims matching keywords
        let matches: IdentifiedClaim[] = [];
        for (const [_key, claims] of claimsByMetricPeriodScope) {
          const keyParts = _key.toLowerCase().split("|");
          // Check if slug parts overlap with metric/period/scope
          const overlap = slugParts.filter((p: string) => keyParts.some(kp => kp.includes(p) || p.includes(kp)));
          if (overlap.length >= 2) {
            matches.push(...claims);
          }
        }

        if (matches.length === 1) {
          row.resolved_claim_id = matches[0].claim_id;
          row.resolved_claim_text = matches[0].verbatim_snippet?.slice(0, 200) ?? null;
          row.resolved_memo_version = matches[0].memo_version ?? null;
          row.matching_method = "document_metric_period_scope";
          row.candidate_match_count = 1;
          row.confidence = "low";
          reconciliationLedger.push(row);
          continue;
        } else if (matches.length > 1) {
          row.matching_method = "unresolved_ambiguous";
          row.candidate_match_count = matches.length;
          row.ambiguity_reason = `Slug '${claimRef}' matches ${matches.length} claims by metric/period keywords`;
          row.rejection_reason = "Multiple claims match slug keywords";
          row.confidence = "none";
          reconciliationLedger.push(row);
          continue;
        }

        row.matching_method = "unresolved_no_match";
        row.candidate_match_count = 0;
        row.rejection_reason = `Slug '${claimRef}' does not match any claim by metric/period/scope`;
        row.confidence = "none";
        reconciliationLedger.push(row);
        continue;
      }

      // Fallback
      row.matching_method = "unresolved_no_match";
      row.rejection_reason = `Reference '${claimRef}' could not be resolved by any method`;
      row.confidence = "none";
      reconciliationLedger.push(row);
    }

    // 7. Compute summary
    const summary = {
      resolved_exact: reconciliationLedger.filter(r => r.matching_method === "canonical_id_direct").length,
      resolved_positional: reconciliationLedger.filter(r => r.matching_method === "origin_map_positional").length,
      resolved_text_match: reconciliationLedger.filter(r => r.matching_method === "document_source_page_text").length,
      resolved_metric_match: reconciliationLedger.filter(r => r.matching_method === "document_metric_period_scope").length,
      unresolved_ambiguous: reconciliationLedger.filter(r => r.matching_method === "unresolved_ambiguous").length,
      unresolved_no_match: reconciliationLedger.filter(r => r.matching_method === "unresolved_no_match").length,
      unresolved_missing_ref: reconciliationLedger.filter(r => r.matching_method === "unresolved_missing_ref").length,
      unresolved_malformed: reconciliationLedger.filter(r => r.matching_method === "unresolved_malformed").length,
      total_resolved: 0,
      total_unresolved: 0,
    };
    summary.total_resolved = summary.resolved_exact + summary.resolved_positional +
      summary.resolved_text_match + summary.resolved_metric_match;
    summary.total_unresolved = summary.unresolved_ambiguous + summary.unresolved_no_match +
      summary.unresolved_missing_ref + summary.unresolved_malformed;

    // 8. Claims ledger stats
    const byMemoVersion: Record<string, number> = {};
    const byDocument: Record<string, number> = {};
    for (const claim of enrichedClaims) {
      const mv = claim.memo_version ?? "unknown";
      byMemoVersion[mv] = (byMemoVersion[mv] ?? 0) + 1;
      const docName = claim.ic_document_filename ?? claim.ic_document_id ?? "unknown";
      byDocument[docName] = (byDocument[docName] ?? 0) + 1;
    }

    // 9. Condensed ledger (key fields only, to avoid gRPC size limit)
    const condensedLedger = reconciliationLedger.map(r => ({
      finding_id: r.finding_id.slice(0, 12),
      title: r.finding_title.slice(0, 60),
      ref: r.legacy_claim_ref,
      ref_type: r.ref_type,
      method: r.matching_method,
      resolved_id: r.resolved_claim_id?.slice(0, 24) ?? null,
      confidence: r.confidence,
      rejection: r.rejection_reason?.slice(0, 80) ?? null,
    }));

    // 10. Sample validated mappings (first 5 resolved)
    const sampleMappings = reconciliationLedger
      .filter(r => r.resolved_claim_id !== null)
      .slice(0, 5)
      .map(r => ({
        finding_id: r.finding_id,
        finding_title: r.finding_title,
        legacy_ref: r.legacy_claim_ref,
        resolved_to: r.resolved_claim_id,
        claim_text_preview: r.resolved_claim_text?.slice(0, 120),
        memo_version: r.resolved_memo_version,
        method: r.matching_method,
        confidence: r.confidence,
      }));

    return {
      total_candidates: reconciliationLedger.length,
      reconciliation_ledger: condensedLedger,
      summary,
      claims_ledger_stats: {
        total_claims: enrichedClaims.length,
        by_memo_version: byMemoVersion,
        by_document: byDocument,
      },
      origin_map_stats: {
        total_entries: originMap.entries.size,
        ambiguous_legacy_ids: originMap.ambiguousLegacyIds.size,
        documents_covered: new Set([...originMap.entries.values()].map(e => e.document_id)).size,
      },
      sample_mappings: sampleMappings,
    };
  },
});
