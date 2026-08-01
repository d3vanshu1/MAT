/**
 * Diagnostic Saint Reconciliation — PERSIST + COMPACT MANIFEST
 *
 * Extracts the 46 Q2 candidates from the SCG contradiction_check run,
 * loads the claims ledger, builds the origin map from universal_extractions,
 * produces a full 46-row reconciliation ledger, PERSISTS it as a durable
 * artifact at tree_level=98, and returns only a compact manifest.
 *
 * Idempotent: same deal/run + Q2 checkpoint + claims-ledger checkpoint +
 * schema version → replaces the same logical artifact (tree_level=98, node_index=0).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  parseClaimId,
  isLegacyClaimId,
  isGlobalClaimId,
  buildOriginMapFromRoutedArray,
} from "./claim-origin-map.js";
import type { IdentifiedClaim } from "./claims-ledger-identity.js";
// Simple SHA-256-like hash using FNV-1a (avoids Node crypto import for build compatibility)
// Produces a stable hex string for content-addressable artifact checksums
function computeStableHash(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x811c9dc5) >>> 0;
  }
  // Additional mixing passes for better distribution
  for (let round = 0; round < 4; round++) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") +
    (h1 ^ h2).toString(16).padStart(8, "0") + ((h1 + h2) >>> 0).toString(16).padStart(8, "0");
}

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Artifact schema version — bump when row shape changes
const RECONCILIATION_SCHEMA_VERSION = "saint_claim_reconciliation_v1";
// Dedicated tree_level for reconciliation artifacts (96 is unoccupied; 97=Q2 ledger, 98=findings corpus, 99=claims)
const ARTIFACT_TREE_LEVEL = 96;
const ARTIFACT_NODE_INDEX = 0;

// ---------------------------------------------------------------------------
// Helper: compute flat claim index from chunk/claim coordinates
// ---------------------------------------------------------------------------
function computeFlatClaimIndex(
  extractionRows: Array<{ document_id: string; chunk_index: number; extraction_json?: any }>,
  documentId: string,
  targetChunkIndex: number,
  claimIndexInChunk: number,
): number | null {
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
      return null;
    }
    flatIndex += numClaims;
  }
  return null;
}

// Resolution methods
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
  source_document_id: string | null;
  source_document_name: string | null;
  source_page_or_location: string | null;
  resolved_claim_id: string | null;
  resolved_claim_text: string | null;
  resolved_memo_version: string | null;
  matching_method: ResolutionMethod;
  candidate_match_count: number;
  confidence: "high" | "medium" | "low" | "none";
  ambiguity_reason: string | null;
  rejection_reason: string | null;
  q3_eligible: boolean;
}

export default api({
  name: "DiagSaintReconciliation",
  description: "Persists 46-row reconciliation artifact and returns compact manifest",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    runId: z.string(),
  }),

  output: z.object({
    artifact_checkpoint_id: z.string(),
    schema_version: z.string(),
    total_candidate_rows: z.number(),
    persisted_row_count: z.number(),
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
    claims_ledger_count: z.number(),
    source_checkpoint_ids: z.object({
      q2_disposition_ledger: z.string(),
      claims_ledger: z.string(),
    }),
    checksum: z.string(),
    page_size_supported: z.number(),
    persistence_succeeded: z.boolean(),
    global_ambiguous_position_count: z.number(),
    candidate_ambiguous_count: z.number(),
    disposition_counts: z.object({
      resolved_q3_eligible: z.number(),
      resolved_not_eligible: z.number(),
      unresolved_rejected: z.number(),
    }),
  }),

  async run(ctx, { dealId, runId }) {
    // =========================================================================
    // 1. Load Q2 disposition ledger (tree_level=97)
    // =========================================================================
    const LedgerRow = z.object({ merged_json: z.any(), id: z.string().optional() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 97 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      LedgerRow,
      [runId],
      { label: "Load Q2 disposition ledger" }
    );

    if (ledgerRows.length === 0) {
      throw new Error(`No disposition ledger found for run ${runId}`);
    }

    const q2CheckpointId = ledgerRows[0].id ?? `${runId}:L97:N0`;
    const ledgerParsed = typeof ledgerRows[0].merged_json === "string"
      ? JSON.parse(ledgerRows[0].merged_json)
      : ledgerRows[0].merged_json;

    const fullLedger = (ledgerParsed.ledger || []) as Array<any>;
    // Filter to only contradiction candidates (the 46 Q3-eligible findings)
    const ledgerEntries = fullLedger.filter(
      (e: any) => e.disposition === "retained_as_contradiction_candidate"
    );

    // =========================================================================
    // 2. Load raw findings from merge_checkpoints (tree_level ≤ 5)
    // =========================================================================
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

    // =========================================================================
    // 3. Load claims ledger (tree_level=99)
    // =========================================================================
    const ClaimsRow = z.object({ merged_json: z.any(), id: z.string().optional() });
    const claimsRows = await ctx.integrations.db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      ClaimsRow,
      [runId],
      { label: "Load claims ledger (tree_level=99)" }
    );

    let enrichedClaims: IdentifiedClaim[] = [];
    let claimsCheckpointId = "unknown";

    if (claimsRows.length > 0) {
      claimsCheckpointId = claimsRows[0].id ?? `${runId}:L99:N0`;
      const claimsParsed = typeof claimsRows[0].merged_json === "string"
        ? JSON.parse(claimsRows[0].merged_json)
        : claimsRows[0].merged_json;
      enrichedClaims = (claimsParsed.claims ?? []) as IdentifiedClaim[];
    }

    // Fallback: pipeline_checkpoints
    if (enrichedClaims.length === 0) {
      const FallbackRow = z.object({ payload: z.any(), id: z.string().optional() });
      const fallbackRows = await ctx.integrations.db.query(
        `SELECT id, payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
         ORDER BY created_at DESC LIMIT 1`,
        FallbackRow,
        [runId],
        { label: "Fallback: claims_ledger from pipeline_checkpoints" }
      );
      if (fallbackRows.length > 0) {
        claimsCheckpointId = fallbackRows[0].id ?? `${runId}:claims_ledger`;
        const fbParsed = typeof fallbackRows[0].payload === "string"
          ? JSON.parse(fallbackRows[0].payload)
          : fallbackRows[0].payload;
        enrichedClaims = (fbParsed.claims ?? []) as IdentifiedClaim[];
      }
    }

    // =========================================================================
    // 4. Build lookup indices for claims
    // =========================================================================
    const claimById = new Map<string, IdentifiedClaim>();
    const claimsByMetricPeriodScope = new Map<string, IdentifiedClaim[]>();
    const claimsByDocPageText = new Map<string, IdentifiedClaim>();
    const claimsByDocument = new Map<string, IdentifiedClaim[]>();

    for (const claim of enrichedClaims) {
      claimById.set(claim.claim_id, claim);

      if (!claimsByDocument.has(claim.ic_document_id)) {
        claimsByDocument.set(claim.ic_document_id, []);
      }
      claimsByDocument.get(claim.ic_document_id)!.push(claim);

      const mpsKey = `${(claim.metric ?? "").toLowerCase()}|${(claim.period ?? "").toLowerCase()}|${(claim.scope_qualifier ?? "").toLowerCase()}`;
      if (!claimsByMetricPeriodScope.has(mpsKey)) {
        claimsByMetricPeriodScope.set(mpsKey, []);
      }
      claimsByMetricPeriodScope.get(mpsKey)!.push(claim);

      if (claim.ic_document_id && claim.source_page && claim.verbatim_snippet) {
        const textKey = `${claim.ic_document_id}|${claim.source_page}|${claim.verbatim_snippet.slice(0, 100).toLowerCase()}`;
        claimsByDocPageText.set(textKey, claim);
      }
    }

    // =========================================================================
    // 5. Load IC document extractions and build origin map
    // =========================================================================
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

    const DocRow = z.object({ id: z.string(), file_name: z.string() });
    const docRows = await ctx.integrations.db.query(
      `SELECT id, file_name FROM documents WHERE deal_id = $1 LIMIT 50`,
      DocRow,
      [dealId],
      { label: "Load document filenames" }
    );
    const idToFileName = new Map(docRows.map(d => [d.id, d.file_name]));

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
        { label: `Load extractions for ${idToFileName.get(docId)?.slice(0, 30) ?? docId.slice(0, 8)}` }
      );
      extractionRows.push(...rows);
    }

    const originMap = buildOriginMapFromRoutedArray(
      extractionRows.map(r => ({
        document_id: r.document_id,
        chunk_index: r.chunk_index,
        extraction_json: r.extraction_json,
      })),
      idToFileName,
    );

    // =========================================================================
    // 6. Reconcile each candidate
    // =========================================================================
    const reconciliationLedger: ReconciliationRow[] = [];

    for (const entry of ledgerEntries) {
      const findingId = entry.finding_id;
      const finding = findingsMap.get(findingId) ?? entry;
      const claimRef = finding.originating_claim_id ?? finding.claim_ids?.[0] ?? null;

      // Determine source document info from finding metadata
      const sourceDocIds: string[] = finding.source_docs ?? [];
      const primarySourceDocId = sourceDocIds[0] ?? null;
      const sourceDocName = primarySourceDocId ? (idToFileName.get(primarySourceDocId) ?? null) : null;
      const sourcePage = finding.source_page ?? finding.page_reference ?? null;

      const row: ReconciliationRow = {
        finding_id: findingId,
        corpus_index: entry.corpus_index ?? -1,
        finding_title: entry.title ?? finding.title ?? "UNKNOWN",
        legacy_claim_ref: claimRef,
        ref_type: "none",
        originating_memo_metadata: {
          source_tag: finding.source_tag ?? null,
          source_docs: sourceDocIds,
          doc_type: finding.doc_type ?? null,
        },
        source_document_id: primarySourceDocId,
        source_document_name: sourceDocName,
        source_page_or_location: sourcePage ? String(sourcePage) : null,
        resolved_claim_id: null,
        resolved_claim_text: null,
        resolved_memo_version: null,
        matching_method: "unresolved_missing_ref",
        candidate_match_count: 0,
        confidence: "none",
        ambiguity_reason: null,
        rejection_reason: null,
        q3_eligible: false,
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
        row.source_document_id = row.source_document_id ?? claim.ic_document_id;
        row.source_document_name = row.source_document_name ?? (idToFileName.get(claim.ic_document_id) ?? null);
        row.source_page_or_location = row.source_page_or_location ?? claim.source_page ?? null;
        row.matching_method = "canonical_id_direct";
        row.candidate_match_count = 1;
        row.confidence = "high";
        row.q3_eligible = true;
        reconciliationLedger.push(row);
        continue;
      }

      // Priority 2: Origin map positional lookup
      if (row.ref_type === "positional") {
        const parsed = parseClaimId(claimRef);
        if (parsed) {
          const { chunk_index, claim_index } = parsed;
          const originEntry = originMap.entries.get(claimRef);

          if (originEntry && !originMap.ambiguousLegacyIds.has(claimRef)) {
            const docClaims = claimsByDocument.get(originEntry.document_id) ?? [];
            if (docClaims.length > 0) {
              const flatIdx = computeFlatClaimIndex(extractionRows, originEntry.document_id, chunk_index, claim_index);
              if (flatIdx !== null && flatIdx < docClaims.length) {
                const posMatch = docClaims[flatIdx];
                row.resolved_claim_id = posMatch.claim_id;
                row.resolved_claim_text = posMatch.verbatim_snippet?.slice(0, 200) ?? null;
                row.resolved_memo_version = posMatch.memo_version ?? null;
                row.source_document_id = originEntry.document_id;
                row.source_document_name = idToFileName.get(originEntry.document_id) ?? null;
                row.source_page_or_location = posMatch.source_page ?? null;
                row.matching_method = "origin_map_positional";
                row.candidate_match_count = 1;
                row.confidence = "medium";
                row.q3_eligible = true;
                reconciliationLedger.push(row);
                continue;
              }
            }
          }

          if (originMap.ambiguousLegacyIds.has(claimRef)) {
            row.matching_method = "unresolved_ambiguous";
            row.ambiguity_reason = `Legacy ID '${claimRef}' appears in multiple documents in the origin map`;
            row.rejection_reason = "Ambiguous: same positional ID exists in multiple IC documents";
            const allDocsWithThisId = extractionRows.filter(er => {
              const ext = typeof er.extraction_json === "string" ? er.extraction_json : JSON.stringify(er.extraction_json);
              return ext.includes(`"${claimRef}"`) && er.chunk_index === chunk_index;
            });
            row.candidate_match_count = allDocsWithThisId.length;
            row.confidence = "none";
            row.q3_eligible = false;
            reconciliationLedger.push(row);
            continue;
          }

          // Not in origin map — try positional fallback across IC docs
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
            row.source_document_id = possibleDocs[0].ic_document_id;
            row.source_document_name = idToFileName.get(possibleDocs[0].ic_document_id) ?? null;
            row.source_page_or_location = possibleDocs[0].source_page ?? null;
            row.matching_method = "origin_map_positional";
            row.candidate_match_count = 1;
            row.confidence = "medium";
            row.q3_eligible = true;
            reconciliationLedger.push(row);
            continue;
          } else if (possibleDocs.length > 1) {
            row.matching_method = "unresolved_ambiguous";
            row.candidate_match_count = possibleDocs.length;
            row.ambiguity_reason = `Positional ref c${chunk_index}-${claim_index} matches ${possibleDocs.length} claims across IC documents`;
            row.rejection_reason = "Multiple IC documents have a claim at this position";
            row.confidence = "none";
            row.q3_eligible = false;
            reconciliationLedger.push(row);
            continue;
          }

          row.matching_method = "unresolved_no_match";
          row.candidate_match_count = 0;
          row.rejection_reason = `No claim found at position c${chunk_index}-${claim_index} in any IC document`;
          row.confidence = "none";
          row.q3_eligible = false;
          reconciliationLedger.push(row);
          continue;
        }
      }

      // Priority 3: Slug references — try metric+period matching
      if (row.ref_type === "slug") {
        const slugParts = claimRef.toLowerCase().split(/[_\-]+/);
        let matches: IdentifiedClaim[] = [];
        for (const [_key, claims] of claimsByMetricPeriodScope) {
          const keyParts = _key.toLowerCase().split("|");
          const overlap = slugParts.filter((p: string) => keyParts.some(kp => kp.includes(p) || p.includes(kp)));
          if (overlap.length >= 2) {
            matches.push(...claims);
          }
        }

        if (matches.length === 1) {
          row.resolved_claim_id = matches[0].claim_id;
          row.resolved_claim_text = matches[0].verbatim_snippet?.slice(0, 200) ?? null;
          row.resolved_memo_version = matches[0].memo_version ?? null;
          row.source_document_id = matches[0].ic_document_id;
          row.source_document_name = idToFileName.get(matches[0].ic_document_id) ?? null;
          row.source_page_or_location = matches[0].source_page ?? null;
          row.matching_method = "document_metric_period_scope";
          row.candidate_match_count = 1;
          row.confidence = "low";
          row.q3_eligible = true;
          reconciliationLedger.push(row);
          continue;
        } else if (matches.length > 1) {
          row.matching_method = "unresolved_ambiguous";
          row.candidate_match_count = matches.length;
          row.ambiguity_reason = `Slug '${claimRef}' matches ${matches.length} claims by metric/period keywords`;
          row.rejection_reason = "Multiple claims match slug keywords";
          row.confidence = "none";
          row.q3_eligible = false;
          reconciliationLedger.push(row);
          continue;
        }

        row.matching_method = "unresolved_no_match";
        row.candidate_match_count = 0;
        row.rejection_reason = `Slug '${claimRef}' does not match any claim by metric/period/scope`;
        row.confidence = "none";
        row.q3_eligible = false;
        reconciliationLedger.push(row);
        continue;
      }

      // Fallback
      row.matching_method = "unresolved_no_match";
      row.rejection_reason = `Reference '${claimRef}' could not be resolved by any method`;
      row.confidence = "none";
      row.q3_eligible = false;
      reconciliationLedger.push(row);
    }

    // =========================================================================
    // 7. Compute summary
    // =========================================================================
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

    // =========================================================================
    // 8. Sort ledger deterministically: finding_id → legacy_claim_ref
    // =========================================================================
    reconciliationLedger.sort((a, b) => {
      const cmp = a.finding_id.localeCompare(b.finding_id);
      if (cmp !== 0) return cmp;
      return (a.legacy_claim_ref ?? "").localeCompare(b.legacy_claim_ref ?? "");
    });

    // =========================================================================
    // 9. Compute checksum of the full artifact
    // =========================================================================
    const artifactPayload = {
      artifact_type: "saint_claim_reconciliation",
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      deal_id: dealId,
      run_id: runId,
      source_q2_checkpoint_id: q2CheckpointId,
      claims_ledger_checkpoint_id: claimsCheckpointId,
      generation_timestamp: new Date().toISOString(),
      total_rows: reconciliationLedger.length,
      summary,
      global_ambiguous_position_count: originMap.ambiguousLegacyIds.size,
      candidate_ambiguous_count: reconciliationLedger.filter(r => r.matching_method === "unresolved_ambiguous").length,
      rows: reconciliationLedger,
    };

    const checksumInput = JSON.stringify({
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      deal_id: dealId,
      run_id: runId,
      rows: reconciliationLedger.map(r => ({
        finding_id: r.finding_id,
        legacy_claim_ref: r.legacy_claim_ref,
        resolved_claim_id: r.resolved_claim_id,
        matching_method: r.matching_method,
        confidence: r.confidence,
        q3_eligible: r.q3_eligible,
      })),
    });
    const checksum = computeStableHash(checksumInput);
    (artifactPayload as any).checksum = checksum;

    // =========================================================================
    // 10. Persist artifact at tree_level=98 (UPSERT — idempotent)
    // =========================================================================
    let persistenceSucceeded = false;
    let artifactCheckpointId = `${runId}:L${ARTIFACT_TREE_LEVEL}:N${ARTIFACT_NODE_INDEX}`;

    try {
      const IdRow = z.object({ id: z.string() });
      const result = await ctx.integrations.db.query(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (module_run_id, tree_level, node_index)
         DO UPDATE SET merged_json = EXCLUDED.merged_json,
                       status = EXCLUDED.status,
                       updated_at = now()
         RETURNING id`,
        IdRow,
        [runId, ARTIFACT_TREE_LEVEL, ARTIFACT_NODE_INDEX, JSON.stringify(artifactPayload), RECONCILIATION_SCHEMA_VERSION],
        { label: "Persist reconciliation artifact at L98" }
      );
      if (result.length > 0) {
        artifactCheckpointId = result[0].id;
      }
      persistenceSucceeded = true;
    } catch (err: any) {
      // If persist fails, we still return the compact manifest
      console.error("Reconciliation artifact persistence failed:", err.message ?? err);
    }

    // =========================================================================
    // 11. Compute disposition counts
    // =========================================================================
    const dispositionCounts = {
      resolved_q3_eligible: reconciliationLedger.filter(r => r.q3_eligible).length,
      resolved_not_eligible: reconciliationLedger.filter(r => r.confidence !== "none" && !r.q3_eligible).length,
      unresolved_rejected: reconciliationLedger.filter(r => r.confidence === "none").length,
    };

    // =========================================================================
    // 12. Return compact manifest (no full rows)
    // =========================================================================
    return {
      artifact_checkpoint_id: artifactCheckpointId,
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      total_candidate_rows: reconciliationLedger.length,
      persisted_row_count: reconciliationLedger.length,
      summary,
      claims_ledger_count: enrichedClaims.length,
      source_checkpoint_ids: {
        q2_disposition_ledger: q2CheckpointId,
        claims_ledger: claimsCheckpointId,
      },
      checksum,
      page_size_supported: 20,
      persistence_succeeded: persistenceSucceeded,
      global_ambiguous_position_count: originMap.ambiguousLegacyIds.size,
      candidate_ambiguous_count: reconciliationLedger.filter(r => r.matching_method === "unresolved_ambiguous").length,
      disposition_counts: dispositionCounts,
    };
  },
});
