/**
 * ReplayClaimLinkage — Q3 Claim-Linkage Replay
 *
 * Loads the 46 retained contradiction candidates from the Q2 disposition ledger
 * and classifies each as claim-linked (with verdict) or not-linked-to-IC-claim.
 *
 * For each candidate, produces:
 *   - The exact originating IC claim and source location; OR
 *   - The reason no valid originating claim exists
 *
 * ACCEPTANCE CRITERIA:
 *   - 100% of retained findings have either an originating IC claim or explicit not-linked reason
 *   - No standalone FDD/CDD/model observation remains as a finding without a claim
 *   - Missing evidence → unverifiable (not invented contradiction)
 *   - Evidence from inappropriate source type → rejected
 *   - Existing quantitative reconciliation behavior unchanged
 *   - Replay is deterministic and fully accounted for
 *
 * Persists the Q3 replay at tree_level=96, node_index=0.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  classifyClaimLinkage,
  type ClaimLinkageResult,
  type QualitativeClaim,
  CLAIM_LINKAGE_DISPOSITIONS,
} from "./claim-linkage.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ClaimLinkageRecordSchema = z.object({
  finding_id: z.string(),
  corpus_index: z.number(),
  title: z.string(),
  claim_linkage_disposition: z.string(),
  originating_claim: z.any().nullable(),
  reason: z.string(),
  evidence_source_type: z.string().nullable(),
  evidence_authority_valid: z.boolean(),
});

export default api({
  name: "ReplayClaimLinkage",
  description: "Q3 replay: links 46 retained candidates to originating IC claims or classifies as not-linked",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    total_candidates: z.number(),
    claim_linked: z.number(),
    not_linked: z.number(),
    linkage_by_disposition: z.record(z.string(), z.number()),
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

    // 4. Load claims ledger (from claims extraction checkpoint)
    const claimsRow = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
       ORDER BY created_at DESC LIMIT 1`,
      z.object({ payload: z.any() }),
      [runId],
      { label: "Load claims ledger checkpoint" }
    );

    // Build claim_id → claim lookup
    const claimMap = new Map<string, any>();
    if (claimsRow.length > 0) {
      const claimsPayload = typeof claimsRow[0].payload === "string"
        ? JSON.parse(claimsRow[0].payload)
        : claimsRow[0].payload;
      const claims = claimsPayload?.claims || [];
      for (const claim of claims) {
        // Claims from Step 0.8 use a compound ID format
        const claimId = claim.claim_id || claim.id;
        if (claimId) claimMap.set(claimId, claim);
      }
    }

    // 5. Process each candidate through claim-linkage
    const linkageResults: ClaimLinkageResult[] = [];
    const dispositionCounts: Record<string, number> = {};

    for (const candidate of candidates) {
      const finding = findingsMap.get(candidate.finding_id);

      // Attempt to resolve originating claim
      let resolvedClaim: QualitativeClaim | null = null;
      const claimId = finding?.originating_claim_id || finding?.claim_id ||
                      (finding?.claim_ids?.length ? finding.claim_ids[0] : null);

      if (claimId && claimMap.has(claimId)) {
        const rawClaim = claimMap.get(claimId)!;
        resolvedClaim = {
          originating_claim_id: claimId,
          claim_text: rawClaim.verbatim_snippet || rawClaim.claim_text || "",
          claim_type: rawClaim.claim_category || rawClaim.claim_type || "operating_metric",
          ic_source_document: rawClaim.source_doc || "",
          ic_source_location: rawClaim.source_page || "unknown",
          memo_version: rawClaim.memo_version ?? null,
          normalized_claim: `${rawClaim.metric ?? ""} ${rawClaim.scope_qualifier ?? ""} ${rawClaim.period ?? ""}`.trim() || rawClaim.claim_text || "",
          verification_source: finding?.source_docs?.[0] ?? null,
          verification_evidence: finding?.evidence ?? finding?.detail ?? null,
          comparison_performed: finding?.full_analysis ?? null,
          verdict: deriveVerdictFromFinding(finding, candidate.severity),
        };
      }

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
        },
        resolvedClaim,
      );

      linkageResults.push(result);
      dispositionCounts[result.claim_linkage_disposition] =
        (dispositionCounts[result.claim_linkage_disposition] ?? 0) + 1;
    }

    // 6. Accounting
    const claimLinked = linkageResults.filter(r => r.claim_linkage_disposition !== "not_linked_to_IC_claim").length;
    const notLinked = linkageResults.filter(r => r.claim_linkage_disposition === "not_linked_to_IC_claim").length;
    const silentLosses = totalCandidates - linkageResults.length;

    // 7. Persist Q3 replay at tree_level=96
    const q3Payload = JSON.stringify({
      _replay_metadata: {
        run_id: runId,
        module_id: moduleId,
        replay_type: "Q3_claim_linkage",
        replay_timestamp: new Date().toISOString(),
        total_candidates: totalCandidates,
        claim_linked: claimLinked,
        not_linked: notLinked,
        silent_losses: silentLosses,
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
      claim_linked: claimLinked,
      not_linked: notLinked,
      linkage_by_disposition: dispositionCounts,
      linkage_results: linkageResults,
      silent_losses: silentLosses,
      checkpoint_id: persisted.id,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives a verdict from the finding's existing metadata.
 * For reconciliation findings (data_divergence), the verdict is "contradicted".
 * For unreconcilable findings, the verdict is "unverifiable".
 * For other findings, infers from severity + content.
 */
function deriveVerdictFromFinding(finding: any, severity: string | null): "confirmed" | "contradicted" | "partially_supported" | "unsupported" | "unverifiable" | "materially_changed" {
  if (!finding) return "unverifiable";

  const kind = finding.finding_kind;
  const title = String(finding.title ?? "").toLowerCase();
  const detail = String(finding.detail ?? finding.full_analysis ?? "").toLowerCase();

  // Data divergence → contradicted or materially_changed
  if (kind === "data_divergence") {
    if (title.includes("material change") || title.includes("revision")) {
      return "materially_changed";
    }
    return "contradicted";
  }

  // Unreconcilable → unverifiable
  if (kind === "unreconcilable") return "unverifiable";

  // Scope mismatch → unverifiable
  if (kind === "scope_mismatch") return "unverifiable";

  // Cross-version → materially_changed
  if (kind === "cross_version") return "materially_changed";

  // Severity-based heuristic
  if (severity === "critical") {
    if (title.includes("unsupported") || detail.includes("unsupported")) return "unsupported";
    return "contradicted";
  }
  if (severity === "warning") {
    if (title.includes("partial") || detail.includes("partially")) return "partially_supported";
    if (title.includes("revision") || title.includes("change")) return "materially_changed";
    return "contradicted";
  }

  // Info severity with adversity
  if (title.includes("inconsisten") || title.includes("discrepanc") || title.includes("diverge")) {
    return "partially_supported";
  }

  return "unverifiable";
}
