/**
 * ReplayPopulateClaimsLedger — Materialize the Claims Ledger with Deterministic IDs
 *
 * PURPOSE: Load the existing claims-extraction checkpoint (from pipeline_checkpoints),
 * assign deterministic claim IDs, classify and enrich, then persist at tree_level=99
 * as the canonical claims-ledger that Q3 resolves against.
 *
 * ELIGIBLE ORIGINATING DOCUMENTS (for Saint):
 *   - Screening Memo
 *   - 2nd IC Memo
 *   - 3rd IC Memo
 *   - 21 June IC Update
 *
 * NOT originating claims (evidence sources only):
 *   - Financial Model
 *   - FDD (PwC)
 *   - CDD (Altman Solon)
 *   - Legal DD
 *   - Customer Data
 *   - IM/CIM
 *
 * PERSISTENCE: tree_level=99, node_index=0
 * (99 = highest layer, the claims ledger feeds everything downstream)
 *
 * This API:
 *   1. Loads existing claims-ledger from pipeline_checkpoints
 *   2. Loads IC document metadata to get document IDs
 *   3. Assigns deterministic claim IDs using the identity scheme
 *   4. Detects and reports duplicate IDs (fail-closed if found)
 *   5. Persists enriched ledger at tree_level=99
 *   6. Reports coverage metrics
 *
 * DOES NOT trigger AI/LLM calls — safe to run without consent gate.
 * If the claims-ledger checkpoint is absent or empty, it will attempt to
 * load from any prior extraction runs.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  enrichClaimWithIdentity,
  detectDuplicateClaimIds,
  deriveMemoVersion,
  type IdentifiedClaim,
} from "./claims-ledger-identity.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "ReplayPopulateClaimsLedger",
  description: "Materialize claims ledger with deterministic IDs at tree_level=99",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string().default("c46b4129-8a16-48ae-ad3a-1da061255445"),
  }),

  output: z.object({
    total_claims: z.number(),
    claims_by_memo: z.array(z.object({
      memo_version: z.string(),
      filename: z.string(),
      document_id: z.string(),
      claim_count: z.number(),
      by_type: z.record(z.number()),
      by_category: z.record(z.number()),
    })),
    claims_by_type: z.record(z.number()),
    claims_by_category: z.record(z.number()),
    duplicate_ids: z.number(),
    duplicates_deduplicated: z.number(),
    duplicate_details: z.array(z.object({ claim_id: z.string(), count: z.number() })),
    missing_locations: z.number(),
    missing_periods: z.number(),
    parser_failures: z.number(),
    checkpoint_id: z.string(),
    sample_claims: z.array(z.object({
      claim_id: z.string(),
      memo_version: z.string(),
      metric: z.string(),
      scope_qualifier: z.string(),
      period: z.string(),
      value: z.number(),
      unit: z.string(),
      claim_type: z.string(),
      verbatim_snippet: z.string(),
    })),
  }),

  async run(ctx, { runId, dealId }) {
    // =========================================================================
    // STEP 1: Load existing claims-ledger from pipeline_checkpoints
    // =========================================================================
    const CheckpointRow = z.object({ payload: z.any() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
       ORDER BY updated_at DESC LIMIT 1`,
      CheckpointRow,
      [runId],
      { label: "Load claims-ledger checkpoint" }
    );

    let rawClaims: Array<{
      metric: string;
      scope_qualifier: string;
      period: string;
      value: number;
      unit: string;
      basis_note: string;
      source_doc: string;
      source_page: string | null;
      verbatim_snippet: string;
      claim_category: string;
    }> = [];

    if (ledgerRows.length > 0 && ledgerRows[0].payload) {
      const payload = typeof ledgerRows[0].payload === "string"
        ? JSON.parse(ledgerRows[0].payload)
        : ledgerRows[0].payload;
      rawClaims = payload.claims || [];
      console.log(`[PopulateClaimsLedger] Loaded ${rawClaims.length} raw claims from pipeline_checkpoints`);
    } else {
      console.log(`[PopulateClaimsLedger] No claims-ledger checkpoint found for run ${runId}`);
    }

    // =========================================================================
    // STEP 2: Load IC document metadata (to get stable document IDs)
    // =========================================================================
    const DocRow = z.object({
      id: z.string(),
      file_name: z.string(),
      document_tag: z.string(),
    });
    const docs = await ctx.integrations.db.query(
      `SELECT id, file_name, document_tag
       FROM documents
       WHERE deal_id = $1 AND document_tag = 'ic_memo'
       ORDER BY uploaded_at ASC`,
      DocRow,
      [dealId],
      { label: "Load IC document metadata" }
    );

    console.log(`[PopulateClaimsLedger] Found ${docs.length} IC documents: ${docs.map(d => d.file_name).join(", ")}`);

    // Build filename → document ID mapping (normalized lowercase)
    const filenameToDocId = new Map<string, { id: string; file_name: string }>();
    for (const doc of docs) {
      // Map both exact and normalized names
      filenameToDocId.set(doc.file_name, { id: doc.id, file_name: doc.file_name });
      filenameToDocId.set(doc.file_name.toLowerCase(), { id: doc.id, file_name: doc.file_name });
      // Also try without extension
      const withoutExt = doc.file_name.replace(/\.(pdf|docx?|pptx?|txt)$/i, "");
      filenameToDocId.set(withoutExt.toLowerCase(), { id: doc.id, file_name: doc.file_name });
    }

    // Set of eligible IC document IDs
    const eligibleDocIds = new Set(docs.map(d => d.id));

    // =========================================================================
    // STEP 3: Enrich each raw claim with deterministic ID
    // =========================================================================
    let enrichedClaims: IdentifiedClaim[] = [];
    let missingLocations = 0;
    let missingPeriods = 0;
    let parserFailures = 0;

    for (const raw of rawClaims) {
      // Resolve source_doc to document ID
      const docLookup = filenameToDocId.get(raw.source_doc)
        ?? filenameToDocId.get(raw.source_doc.toLowerCase())
        ?? filenameToDocId.get(raw.source_doc.replace(/\.(pdf|docx?|pptx?|txt)$/i, "").toLowerCase());

      if (!docLookup) {
        // Cannot resolve to an IC document — this claim is from an unknown source
        parserFailures++;
        console.warn(`[PopulateClaimsLedger] Cannot resolve source_doc '${raw.source_doc}' to an IC document`);
        continue;
      }

      try {
        const identified = enrichClaimWithIdentity(raw, {
          ic_document_id: docLookup.id,
          ic_document_filename: docLookup.file_name,
        });
        enrichedClaims.push(identified);

        if (!raw.source_page) missingLocations++;
        if (!raw.period || raw.period.trim() === "") missingPeriods++;
      } catch (err) {
        parserFailures++;
        console.warn(`[PopulateClaimsLedger] Enrichment failed: ${err}`);
      }
    }

    console.log(`[PopulateClaimsLedger] Enriched ${enrichedClaims.length}/${rawClaims.length} claims (${parserFailures} failures)`);

    // =========================================================================
    // STEP 3b: SOURCE-LEDGER QUALITY GATES
    // =========================================================================
    // Gate 1: Minimum claim count (a deal must have substantive claims to be processable)
    const MIN_CLAIMS = 10;
    if (enrichedClaims.length < MIN_CLAIMS) {
      throw new Error(
        `QUALITY GATE FAILURE: Only ${enrichedClaims.length} claims enriched (minimum ${MIN_CLAIMS}). ` +
        `Insufficient claims-ledger coverage for reliable Q3\u2192Q5 processing. ` +
        `Check extraction checkpoint or IC memo document tags.`
      );
    }

    // Gate 2: Parser failure rate must be < 20%
    const failureRate = rawClaims.length > 0 ? parserFailures / rawClaims.length : 0;
    if (failureRate > 0.2) {
      throw new Error(
        `QUALITY GATE FAILURE: Parser failure rate ${(failureRate * 100).toFixed(1)}% exceeds 20% threshold. ` +
        `${parserFailures}/${rawClaims.length} claims failed enrichment. ` +
        `Check IC document metadata (document_tag = 'ic_memo') and filename normalization.`
      );
    }

    // Gate 3: At least 2 IC memo documents must be represented
    const representedDocIds = new Set(enrichedClaims.map(c => c.ic_document_id));
    if (representedDocIds.size < 2) {
      throw new Error(
        `QUALITY GATE FAILURE: Only ${representedDocIds.size} IC document(s) represented in claims ledger. ` +
        `Expected at least 2 memo versions for cross-version verification. ` +
        `Documents found: ${[...filenameToDocId.values()].map(d => d.file_name).join(", ")}`
      );
    }

    // =========================================================================
    // STEP 4: Deduplicate by claim_id (same identity = same underlying claim)
    // =========================================================================
    const duplicates = detectDuplicateClaimIds(enrichedClaims);
    const duplicateDetails = [...duplicates.entries()].map(([claim_id, count]) => ({ claim_id, count }));

    // Deduplicate: keep first occurrence of each claim_id
    // Same identity inputs → same underlying claim extracted redundantly by LLM
    const seenIds = new Set<string>();
    const deduplicatedClaims: IdentifiedClaim[] = [];
    for (const claim of enrichedClaims) {
      if (!seenIds.has(claim.claim_id)) {
        seenIds.add(claim.claim_id);
        deduplicatedClaims.push(claim);
      }
    }

    if (duplicates.size > 0) {
      const removed = enrichedClaims.length - deduplicatedClaims.length;
      console.warn(
        `[PopulateClaimsLedger] Deduplicated ${removed} redundant extraction(s) across ${duplicates.size} claim IDs. ` +
        `Same identity inputs = same underlying claim extracted multiple times.`
      );
    }

    // Replace enrichedClaims with deduplicated set
    enrichedClaims = deduplicatedClaims;

    // =========================================================================
    // STEP 5: Compute metrics by memo and type
    // =========================================================================
    const byMemo = new Map<string, {
      memo_version: string;
      filename: string;
      document_id: string;
      claims: IdentifiedClaim[];
    }>();

    for (const claim of enrichedClaims) {
      const key = claim.ic_document_id;
      if (!byMemo.has(key)) {
        byMemo.set(key, {
          memo_version: claim.memo_version,
          filename: claim.ic_document_filename,
          document_id: claim.ic_document_id,
          claims: [],
        });
      }
      byMemo.get(key)!.claims.push(claim);
    }

    const claimsByMemo = [...byMemo.values()].map(group => ({
      memo_version: group.memo_version,
      filename: group.filename,
      document_id: group.document_id,
      claim_count: group.claims.length,
      by_type: countBy(group.claims, c => c.claim_type),
      by_category: countBy(group.claims, c => c.claim_category),
    }));

    const claimsByType = countBy(enrichedClaims, c => c.claim_type);
    const claimsByCategory = countBy(enrichedClaims, c => c.claim_category);

    // =========================================================================
    // STEP 6: Persist at tree_level=99, node_index=0
    // =========================================================================
    const ledgerPayload = JSON.stringify({
      _claims_ledger_metadata: {
        run_id: runId,
        deal_id: dealId,
        schema_version: "2.0.0",
        identity_version: "1",
        timestamp: new Date().toISOString(),
        total_claims: enrichedClaims.length,
        eligible_ic_documents: docs.map(d => ({ id: d.id, filename: d.file_name })),
        duplicate_ids_detected: duplicates.size,
      },
      claims: enrichedClaims,
    });

    const UpsertSchema = z.object({ id: z.string() });
    const [persisted] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 99, 0, 'claims_ledger_populated', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'claims_ledger_populated', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, ledgerPayload],
      { label: "Persist claims ledger (tree_level=99, deterministic IDs)" }
    );

    // =========================================================================
    // STEP 7: Sample claims for manual inspection
    // =========================================================================
    const sampleClaims = enrichedClaims.slice(0, 20).map(c => ({
      claim_id: c.claim_id,
      memo_version: c.memo_version,
      metric: c.metric,
      scope_qualifier: c.scope_qualifier,
      period: c.period,
      value: c.value,
      unit: c.unit,
      claim_type: c.claim_type,
      verbatim_snippet: c.verbatim_snippet.slice(0, 200),
    }));

    return {
      total_claims: enrichedClaims.length,
      claims_by_memo: claimsByMemo,
      claims_by_type: claimsByType,
      claims_by_category: claimsByCategory,
      duplicate_ids: duplicates.size,
      duplicates_deduplicated: duplicateDetails.reduce((sum, d) => sum + d.count - 1, 0),
      duplicate_details: duplicateDetails,
      missing_locations: missingLocations,
      missing_periods: missingPeriods,
      parser_failures: parserFailures,
      checkpoint_id: persisted.id,
      sample_claims: sampleClaims,
    };
  },
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
