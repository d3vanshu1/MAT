/**
 * ReplayClaimLinkage — Q3 Claim-Linkage Replay (Strict Enforcement)
 *
 * Loads the 46 retained contradiction candidates from the Q2 disposition ledger
 * and applies strict claim resolution, authority validation, and verdict assignment.
 *
 * ENFORCEMENT RULES:
 *   - A candidate is claim-linked ONLY when its claim_id resolves to exactly one
 *     claims-ledger record from an eligible IC document.
 *   - Unresolved/missing claim IDs → invalid_or_unresolved_claim_reference (excluded from Q4)
 *   - Invalid evidence authority → invalid_evidence_authority (excluded from Q4)
 *   - No severity-based truth inference — verdicts derive from evidence content only
 *   - Full 17-field provenance for every reportable row
 *
 * CORE INVARIANT: No resolved IC claim, no contradiction-check finding.
 *
 * OUTPUT:
 *   - Per-candidate: disposition, q4_eligible, full provenance, authority decision
 *   - Aggregate: eligibility counts, disposition breakdown, accounting
 *
 * Persists the Q3 replay at tree_level=96, node_index=0.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  classifyClaimLinkage,
  type ClaimLinkageResult,
  type ClaimLinkageDisposition,
  Q4_ELIGIBLE_ADVERSE,
  Q4_ELIGIBLE_ALL,
  CLAIM_LINKAGE_DISPOSITIONS,
  ClaimProvenanceSchema,
} from "./claim-linkage.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ClaimLinkageRecordSchema = z.object({
  finding_id: z.string(),
  corpus_index: z.number(),
  title: z.string(),
  claim_linkage_disposition: z.string(),
  q4_eligible: z.boolean(),
  claim_provenance: ClaimProvenanceSchema.nullable(),
  authority_class: z.string(),
  authority_valid: z.boolean(),
  authority_rationale: z.string(),
  reason: z.string(),
  evidence_source_type: z.string().nullable(),
});

export default api({
  name: "ReplayClaimLinkage",
  description: "Q3 replay: strict claim resolution, authority enforcement, full provenance",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    total_candidates: z.number(),
    q4_eligible_count: z.number(),
    q4_ineligible_count: z.number(),
    linkage_by_disposition: z.record(z.string(), z.number()),
    eligibility_breakdown: z.object({
      claim_linked_adverse: z.number(),
      claim_linked_confirmed: z.number(),
      not_linked: z.number(),
      invalid_claim_reference: z.number(),
      invalid_authority: z.number(),
      other_ineligible: z.number(),
    }),
    linkage_results: z.array(ClaimLinkageRecordSchema),
    // Accounting
    silent_losses: z.number(),
    checkpoint_id: z.string(),
  }),

  async run(ctx, { runId, moduleId }) {
    // 1. Load the disposition ledger (tree_level=97)
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
      throw new Error(`No disposition ledger found for run ${runId}. Run ReplayDispositionHarness first.`);
    }

    const rawLedger = ledgerRows[0].merged_json;
    const ledgerParsed = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;
    const ledger = (ledgerParsed.ledger || []) as Array<{
      corpus_index: number;
      finding_id: string;
      disposition: string;
      reason: string;
      source_tag: string | null;
      severity: string | null;
      title: string;
      has_originating_claim: boolean;
      category: string | null;
      l3_node: number;
    }>;

    // 2. Filter to retained_as_contradiction_candidate only
    const candidates = ledger.filter(e => e.disposition === "retained_as_contradiction_candidate");
    const totalCandidates = candidates.length;

    if (totalCandidates === 0) {
      throw new Error("No retained contradiction candidates found in the disposition ledger.");
    }

    // 3. Load the original findings corpus (tree_level=98) for full metadata
    const CorpusRow = z.object({ merged_json: z.any(), node_index: z.number() });
    const corpusRows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load findings corpus for claim metadata" }
    );

    // Build findings map
    const findingsMap = new Map<string, any>();
    for (const row of corpusRows) {
      const parsed = typeof row.merged_json === "string" ? JSON.parse(row.merged_json) : row.merged_json;
      const findings = parsed.findings || (Array.isArray(parsed) ? parsed : []);
      for (const f of findings) {
        const fid = f.finding_id || f.id;
        if (fid) findingsMap.set(fid, f);
      }
    }

    // 4. Load POPULATED claims ledger (tree_level=99 — deterministic IDs)
    // This is the canonical claims ledger populated by ReplayPopulateClaimsLedger.
    // Falls back to pipeline_checkpoints if tree_level=99 not available.
    const ClaimsCheckpointRow = z.object({ merged_json: z.any() });
    const claimsLedgerRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      ClaimsCheckpointRow,
      [runId],
      { label: "Load populated claims ledger (tree_level=99)" }
    );

    // Build claim_id → claim lookup from the populated ledger
    const claimMap = new Map<string, any>();
    // Also build content-based indexes for reconciliation
    const claimsByMetricPeriod = new Map<string, any[]>();
    let claimsLedgerSource = "none";

    if (claimsLedgerRows.length > 0) {
      const ledgerPayload = typeof claimsLedgerRows[0].merged_json === "string"
        ? JSON.parse(claimsLedgerRows[0].merged_json)
        : claimsLedgerRows[0].merged_json;
      const claims = ledgerPayload?.claims || [];
      claimsLedgerSource = `tree_level_99 (${claims.length} claims)`;

      for (const claim of claims) {
        if (claim.claim_id) {
          claimMap.set(claim.claim_id, claim);
        }
        // Content index for reconciliation
        const metricKey = `${(claim.metric || "").toLowerCase()}|${(claim.period || "").toLowerCase()}`;
        if (!claimsByMetricPeriod.has(metricKey)) {
          claimsByMetricPeriod.set(metricKey, []);
        }
        claimsByMetricPeriod.get(metricKey)!.push(claim);
      }
    } else {
      // Fallback: try pipeline_checkpoints
      const fallbackRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
         ORDER BY updated_at DESC LIMIT 1`,
        z.object({ payload: z.any() }),
        [runId],
        { label: "Load claims ledger fallback (pipeline_checkpoints)" }
      );

      if (fallbackRows.length > 0 && fallbackRows[0].payload) {
        const claimsPayload = typeof fallbackRows[0].payload === "string"
          ? JSON.parse(fallbackRows[0].payload)
          : fallbackRows[0].payload;
        const claims = claimsPayload?.claims || [];
        claimsLedgerSource = `pipeline_checkpoints_fallback (${claims.length} claims)`;

        for (const claim of claims) {
          const claimId = claim.claim_id || claim.id;
          if (claimId) claimMap.set(claimId, claim);
          // Content index
          const metricKey = `${(claim.metric || "").toLowerCase()}|${(claim.period || "").toLowerCase()}`;
          if (!claimsByMetricPeriod.has(metricKey)) {
            claimsByMetricPeriod.set(metricKey, []);
          }
          claimsByMetricPeriod.get(metricKey)!.push(claim);
        }
      }
    }

    console.log(`[ReplayClaimLinkage] Claims ledger: ${claimsLedgerSource} — ${claimMap.size} indexed by ID, ${claimsByMetricPeriod.size} metric-period groups`);

    // 5. Process each candidate through strict claim-linkage
    const linkageResults: ClaimLinkageResult[] = [];
    const dispositionCounts: Record<string, number> = {};

    for (const candidate of candidates) {
      const finding = findingsMap.get(candidate.finding_id);

      const result = classifyClaimLinkage(
        {
          finding_id: candidate.finding_id,
          corpus_index: candidate.corpus_index,
          title: candidate.title,
          detail: finding?.detail,
          full_analysis: finding?.full_analysis,
          severity: candidate.severity,
          source_tag: candidate.source_tag,
          source_docs: finding?.source_docs,
          originating_claim_id: finding?.originating_claim_id,
          claim_ids: finding?.claim_ids,
          claim_type: finding?.claim_type,
          finding_kind: finding?.finding_kind,
          evidence: finding?.evidence,
          doc_filename: finding?.source_docs?.[0] ?? null,
          doc_type: finding?.doc_type ?? null,
        },
        claimMap,
      );

      linkageResults.push(result);
      dispositionCounts[result.claim_linkage_disposition] =
        (dispositionCounts[result.claim_linkage_disposition] ?? 0) + 1;
    }

    // 6. Compute eligibility breakdown
    const q4EligibleCount = linkageResults.filter(r => r.q4_eligible).length;
    const q4IneligibleCount = linkageResults.filter(r => !r.q4_eligible).length;

    const eligibilityBreakdown = {
      claim_linked_adverse: linkageResults.filter(r =>
        Q4_ELIGIBLE_ADVERSE.has(r.claim_linkage_disposition as ClaimLinkageDisposition)
      ).length,
      claim_linked_confirmed: linkageResults.filter(r =>
        r.claim_linkage_disposition === "claim_linked_confirmed"
      ).length,
      not_linked: linkageResults.filter(r =>
        r.claim_linkage_disposition === "not_linked_to_IC_claim"
      ).length,
      invalid_claim_reference: linkageResults.filter(r =>
        r.claim_linkage_disposition === "invalid_or_unresolved_claim_reference"
      ).length,
      invalid_authority: linkageResults.filter(r =>
        r.claim_linkage_disposition === "invalid_evidence_authority"
      ).length,
      other_ineligible: linkageResults.filter(r =>
        !r.q4_eligible &&
        r.claim_linkage_disposition !== "not_linked_to_IC_claim" &&
        r.claim_linkage_disposition !== "invalid_or_unresolved_claim_reference" &&
        r.claim_linkage_disposition !== "invalid_evidence_authority" &&
        r.claim_linkage_disposition !== "claim_linked_confirmed"
      ).length,
    };

    // 7. Accounting — strict: every input must have exactly one output
    const silentLosses = totalCandidates - linkageResults.length;

    // 8. Persist Q3 replay at tree_level=96
    const q3Payload = JSON.stringify({
      _replay_metadata: {
        run_id: runId,
        module_id: moduleId,
        replay_type: "Q3_claim_linkage_strict",
        replay_timestamp: new Date().toISOString(),
        schema_version: "2.0.0",
        total_candidates: totalCandidates,
        q4_eligible_count: q4EligibleCount,
        q4_ineligible_count: q4IneligibleCount,
        silent_losses: silentLosses,
        eligibility_breakdown: eligibilityBreakdown,
      },
      linkage_by_disposition: dispositionCounts,
      results: linkageResults,
    });

    const UpsertSchema = z.object({ id: z.string() });
    const [persisted] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 96, 0, 'q3_claim_linkage', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'q3_claim_linkage', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, q3Payload],
      { label: "Persist Q3 claim-linkage replay (tree_level=96)" }
    );

    return {
      total_candidates: totalCandidates,
      q4_eligible_count: q4EligibleCount,
      q4_ineligible_count: q4IneligibleCount,
      linkage_by_disposition: dispositionCounts,
      eligibility_breakdown: eligibilityBreakdown,
      linkage_results: linkageResults,
      silent_losses: silentLosses,
      checkpoint_id: persisted.id,
    };
  },
});
