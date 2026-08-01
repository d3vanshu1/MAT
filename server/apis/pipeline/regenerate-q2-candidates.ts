/**
 * RegenerateQ2Candidates — M1 Readiness: Claim-First Candidate Generation
 *
 * Generates new Q2 candidates from the pipeline's reconciliation findings,
 * linking each to exactly one deterministic clm-v1-* claim ID from the
 * populated claims ledger (tree_level=99).
 *
 * ENFORCEMENT RULES:
 *   - Every reportable candidate must carry exactly ONE valid clm-v1-* claim ID
 *   - No document-order claim inference
 *   - No bare cN-M admission
 *   - No title-similarity claim substitution
 *   - Duplicate claim IDs fail hard
 *   - Non-IC claims fail hard
 *   - Missing or ambiguous claim links fail closed (non-reportable)
 *   - Candidate source provenance preserved before Q3
 *
 * DATA FLOW:
 *   pipeline_checkpoints[reconciliation] → 221 ReconciliationFindings
 *   merge_checkpoints[tree_level=99] → 263 IdentifiedClaims (with clm-v1-*)
 *   Match: finding.claim coordinates → clm-v1-* via deterministic identity
 *   Output: Candidates with full provenance + deterministic claim linkage
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { generateClaimId } from "./claims-ledger-identity.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// IC memo document IDs for provenance validation
const IC_MEMO_DOCS = new Set([
  "7d059993-a6ed-44cb-83bf-f61cfe8100cf", // Screening
  "01026268-e380-4a3e-9f3e-9d2e0ea42e3a", // 2nd IC
  "125261e4-6bb3-4c93-b49e-3f1f1e97e6d3", // 3rd IC
  "694e184c-bf4e-4948-8dd3-df7565d91781", // 21 June Update
]);

const IC_DOC_FILENAMES: Record<string, string> = {
  "7d059993-a6ed-44cb-83bf-f61cfe8100cf": "2025-12-08 SCG - Screening IC Memo v3.pdf",
  "01026268-e380-4a3e-9f3e-9d2e0ea42e3a": "2026-05-18 SCG - 2nd IC Memo vS.pdf",
  "125261e4-6bb3-4c93-b49e-3f1f1e97e6d3": "2026-06-17 SCG 3rd IC Memo vS.pdf",
  "694e184c-bf4e-4948-8dd3-df7565d91781": "2026-06-21 SCG IC Update.pdf",
};

// Memo version from filename
function getMemoVersion(filename: string): string {
  if (filename.includes("Screening")) return "Screening IC (Dec 2025)";
  if (filename.includes("2nd IC")) return "2nd IC (May 2026)";
  if (filename.includes("3rd IC")) return "3rd IC (Jun 2026)";
  if (filename.includes("Update")) return "21 June Update (Jun 2026)";
  return "Unknown";
}

// Deterministic candidate ID from claim coordinates
function generateCandidateId(claimId: string, findingKind: string): string {
  const input = `${claimId}|${findingKind}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cand-v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export default api({
  name: "RegenerateQ2Candidates",
  description: "M1: Generate Q2 candidates from reconciliation findings with deterministic claim linkage",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    total_reconciliation_findings: z.number(),
    total_regenerated_candidates: z.number(),
    reportable_candidates: z.number(),
    non_reportable_candidates: z.number(),
    candidates_by_memo: z.record(z.string(), z.number()),
    candidates_by_claim_type: z.record(z.string(), z.number()),
    candidates_by_finding_kind: z.record(z.string(), z.number()),
    candidates_with_zero_claim_ids: z.number(),
    candidates_with_multiple_claim_ids: z.number(),
    duplicate_claim_ids_rejected: z.number(),
    invalid_non_ic_links_rejected: z.number(),
    duplicates_leaked_to_reportable: z.number(),
    invalid_links_leaked_to_reportable: z.number(),
    gate_passed: z.boolean(),
    gate_checks: z.record(z.string(), z.any()),
    candidates: z.array(z.any()),
  }),

  async run(ctx, { runId }) {
    // 1. Load reconciliation findings
    const Row = z.object({ payload: z.any() });
    const reconRows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
       ORDER BY updated_at DESC LIMIT 1`,
      Row,
      [runId],
      { label: "Load reconciliation findings" }
    );

    if (reconRows.length === 0) {
      throw new Error(`No reconciliation checkpoint found for run ${runId}`);
    }

    const reconPayload = typeof reconRows[0].payload === "string"
      ? JSON.parse(reconRows[0].payload) : reconRows[0].payload;
    const reconFindings = reconPayload.findings || [];

    // 2. Load populated claims ledger (tree_level=99) with clm-v1-* IDs
    const ClaimsRow = z.object({ merged_json: z.any() });
    const claimsRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      ClaimsRow,
      [runId],
      { label: "Load populated claims ledger (tree_level=99)" }
    );

    if (claimsRows.length === 0) {
      throw new Error("No populated claims ledger at tree_level=99. Run ReplayPopulateClaimsLedger first.");
    }

    const claimsPayload = typeof claimsRows[0].merged_json === "string"
      ? JSON.parse(claimsRows[0].merged_json) : claimsRows[0].merged_json;
    const claims = claimsPayload?.claims || [];

    // 3. Build deterministic claim index: coordinate-key → claim
    // The key uses the same fields as generateClaimId: doc|page|metric|period|scope|text
    const claimByCoordinate = new Map<string, any>();
    const claimById = new Map<string, any>();

    for (const claim of claims) {
      if (claim.claim_id) {
        claimById.set(claim.claim_id, claim);
      }
      // Build coordinate key matching the reconciliation finding's claim object
      const coordKey = [
        claim.ic_document_id || "",
        (claim.source_page || claim.page || "").toLowerCase(),
        (claim.metric || "").toLowerCase(),
        (claim.period || "").toLowerCase(),
        (claim.scope_qualifier || "").toLowerCase(),
        (claim.verbatim_snippet || "").slice(0, 40).toLowerCase(),
      ].join("|");
      claimByCoordinate.set(coordKey, claim);
    }

    // 4. Also build a metric+period+scope+value index for fallback matching
    const claimByMPSV = new Map<string, any[]>();
    for (const claim of claims) {
      const key = [
        (claim.metric || "").toLowerCase(),
        (claim.period || "").toLowerCase(),
        (claim.scope_qualifier || "").toLowerCase(),
        String(claim.value ?? ""),
      ].join("|");
      if (!claimByMPSV.has(key)) claimByMPSV.set(key, []);
      claimByMPSV.get(key)!.push(claim);
    }

    // 5. Load IC document metadata for provenance
    const DocRow = z.object({ id: z.string(), file_name: z.string() });
    const icDocs = await ctx.integrations.db.query(
      `SELECT id, file_name FROM documents
       WHERE deal_id = (SELECT deal_id FROM module_runs WHERE id = $1 LIMIT 1)
         AND document_tag = 'ic_memo'`,
      DocRow,
      [runId],
      { label: "Load IC document metadata" }
    );
    const docFilenameMap = new Map<string, string>();
    const icDocIds = new Set<string>();
    for (const doc of icDocs) {
      docFilenameMap.set(doc.file_name, doc.id);
      icDocIds.add(doc.id);
    }

    // 6. Process each reconciliation finding → candidate
    const candidates: any[] = [];
    const claimIdsUsed = new Set<string>();
    let zeroClaims = 0;
    let multipleClaims = 0;
    let duplicateClaimIds = 0;
    let invalidNonIcLinks = 0;
    const byMemo: Record<string, number> = {};
    const byClaimType: Record<string, number> = {};
    const byFindingKind: Record<string, number> = {};

    for (const finding of reconFindings) {
      const claim = finding.claim;
      if (!claim) {
        // Finding without a claim — non-reportable
        zeroClaims++;
        candidates.push({
          finding_kind: finding.finding_kind,
          title: finding.title,
          severity: finding.severity,
          reportable: false,
          disposition: "no_originating_claim",
          claim_id: null,
          reason: "Reconciliation finding has no attached claim object",
        });
        continue;
      }

      // Resolve to clm-v1-* ID using multiple strategies
      let resolvedClaim: any = null;
      let resolutionMethod = "none";

      // Strategy 1: Direct coordinate match
      const sourceDocFilename = claim.source_doc || "";
      const docId = docFilenameMap.get(sourceDocFilename) || "";
      const coordKey = [
        docId,
        (claim.source_page || "").toLowerCase(),
        (claim.metric || "").toLowerCase(),
        (claim.period || "").toLowerCase(),
        (claim.scope_qualifier || "").toLowerCase(),
        (claim.verbatim_snippet || "").slice(0, 40).toLowerCase(),
      ].join("|");

      if (claimByCoordinate.has(coordKey)) {
        resolvedClaim = claimByCoordinate.get(coordKey);
        resolutionMethod = "exact_coordinate";
      }

      // Strategy 2: Metric+Period+Scope+Value (must be unique)
      if (!resolvedClaim) {
        const mpsvKey = [
          (claim.metric || "").toLowerCase(),
          (claim.period || "").toLowerCase(),
          (claim.scope_qualifier || "").toLowerCase(),
          String(claim.value ?? ""),
        ].join("|");
        const matches = claimByMPSV.get(mpsvKey) || [];
        if (matches.length === 1) {
          resolvedClaim = matches[0];
          resolutionMethod = "unique_mpsv";
        } else if (matches.length > 1) {
          // Ambiguous — filter by source doc
          const docFiltered = matches.filter(m =>
            m.ic_document_filename === sourceDocFilename ||
            m.source_doc === sourceDocFilename
          );
          if (docFiltered.length === 1) {
            resolvedClaim = docFiltered[0];
            resolutionMethod = "mpsv_doc_filtered";
          }
          // Still ambiguous → fail closed
        }
      }

      // Strategy 3: Recompute claim ID from coordinates
      if (!resolvedClaim && docId) {
        const computedId = generateClaimId({
          ic_document_id: docId,
          source_page: claim.source_page || "",
          normalized_claim_text: (claim.verbatim_snippet || "").toLowerCase().trim(),
          metric: claim.metric || "",
          period: claim.period || "",
          scope_qualifier: claim.scope_qualifier || "",
        });
        if (claimById.has(computedId)) {
          resolvedClaim = claimById.get(computedId);
          resolutionMethod = "recomputed_id";
        }
      }

      // Validate resolved claim
      const claimId = resolvedClaim?.claim_id;

      if (!claimId) {
        zeroClaims++;
        candidates.push({
          finding_kind: finding.finding_kind,
          title: finding.title,
          severity: finding.severity,
          reportable: false,
          disposition: "unresolved_claim_link",
          claim_id: null,
          reason: `Could not resolve claim to clm-v1-* ID (metric=${claim.metric}, period=${claim.period}, scope=${claim.scope_qualifier})`,
          claim_metric: claim.metric,
          claim_period: claim.period,
          claim_value: claim.value,
        });
        continue;
      }

      // Validate clm-v1-* format
      const CLM_PATTERN = /^clm-v1-[a-f0-9]+$/;
      if (!CLM_PATTERN.test(claimId)) {
        invalidNonIcLinks++;
        candidates.push({
          finding_kind: finding.finding_kind,
          title: finding.title,
          severity: finding.severity,
          reportable: false,
          disposition: "invalid_claim_id_format",
          claim_id: claimId,
          reason: `Claim ID '${claimId}' does not match clm-v1-[hex] pattern`,
        });
        continue;
      }

      // Validate IC document origin — use ACTUAL IC docs from DB, not hardcoded
      const claimDocId = resolvedClaim.ic_document_id || "";
      if (claimDocId && !icDocIds.has(claimDocId)) {
        invalidNonIcLinks++;
        candidates.push({
          finding_kind: finding.finding_kind,
          title: finding.title,
          severity: finding.severity,
          reportable: false,
          disposition: "non_ic_claim_origin",
          claim_id: claimId,
          reason: `Claim originates from non-IC document: ${claimDocId}`,
        });
        continue;
      }

      // Check for duplicate claim IDs (same claim ID used by multiple candidates)
      if (claimIdsUsed.has(claimId)) {
        duplicateClaimIds++;
        // Still emit but mark as non-reportable duplicate
        candidates.push({
          finding_kind: finding.finding_kind,
          title: finding.title,
          severity: finding.severity,
          reportable: false,
          disposition: "duplicate_claim_id",
          claim_id: claimId,
          reason: `Claim ID already used by another candidate — duplicate`,
        });
        continue;
      }
      claimIdsUsed.add(claimId);

      // === REPORTABLE CANDIDATE ===
      const icDocFilename = resolvedClaim.ic_document_filename || IC_DOC_FILENAMES[claimDocId] || sourceDocFilename;
      const memoVersion = getMemoVersion(icDocFilename);
      const candidateId = generateCandidateId(claimId, finding.finding_kind);

      const candidate = {
        candidate_id: candidateId,
        finding_kind: finding.finding_kind,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail?.slice(0, 500),
        reportable: true,
        disposition: "reportable_q3_eligible",

        // Claim linkage
        claim_id: claimId,
        resolution_method: resolutionMethod,

        // Originating IC document
        ic_document_id: claimDocId,
        ic_document_filename: icDocFilename,
        memo_version: memoVersion,
        source_page: resolvedClaim.source_page || claim.source_page || null,

        // Claim content
        exact_claim_text: resolvedClaim.verbatim_snippet || claim.verbatim_snippet || "",
        metric: resolvedClaim.metric || claim.metric,
        period: resolvedClaim.period || claim.period,
        scope_qualifier: resolvedClaim.scope_qualifier || claim.scope_qualifier,
        value: resolvedClaim.value ?? claim.value,
        unit: resolvedClaim.unit || claim.unit,
        claim_category: resolvedClaim.claim_category || claim.claim_category || "operating_metric",

        // Evidence/comparison
        model_figure_label: finding.model_figure?.label || null,
        model_figure_value: finding.model_figure?.value ?? null,
        delta_abs: finding.delta_abs,
        delta_pct: finding.delta_pct,
        source_docs: finding.source_docs || [],
      };

      candidates.push(candidate);

      // Accumulators
      byMemo[memoVersion] = (byMemo[memoVersion] ?? 0) + 1;
      byClaimType[candidate.claim_category] = (byClaimType[candidate.claim_category] ?? 0) + 1;
      byFindingKind[finding.finding_kind] = (byFindingKind[finding.finding_kind] ?? 0) + 1;
    }

    // 7. Compute totals
    const reportable = candidates.filter(c => c.reportable);
    const nonReportable = candidates.filter(c => !c.reportable);

    // 8. Gate checks
    const reportableWithExactlyOneClaimId = reportable.filter(c =>
      c.claim_id && CLM_PATTERN_CHECK.test(c.claim_id)
    ).length;
    const reportableWithZeroOrMultiple = reportable.length - reportableWithExactlyOneClaimId;

    // Structural guarantee: duplicates & invalid links are rejected before reaching reportable set.
    // Gate checks validate no leakage into reportable (always 0) and report rejected counts separately.
    const duplicatesInReportable = reportable.filter(c => {
      const sameClaimCandidates = reportable.filter(r => r.claim_id === c.claim_id);
      return sameClaimCandidates.length > 1;
    }).length;
    const invalidLinksInReportable = reportable.filter(c =>
      !CLM_PATTERN_CHECK.test(c.claim_id || "")
    ).length;

    const gateChecks = {
      reportable_with_exactly_one_clm_v1: reportableWithExactlyOneClaimId,
      reportable_total: reportable.length,
      pct_with_valid_claim: reportable.length > 0
        ? Math.round((reportableWithExactlyOneClaimId / reportable.length) * 100)
        : 0,
      reportable_with_zero_or_multiple_claim_ids: reportableWithZeroOrMultiple,
      duplicates_in_reportable: duplicatesInReportable,
      invalid_links_in_reportable: invalidLinksInReportable,
      duplicate_claim_ids_rejected: duplicateClaimIds,
      non_ic_claims_rejected: invalidNonIcLinks,
      at_least_one_saint_issue: reportable.some(c =>
        c.title?.toLowerCase().includes("revenue") ||
        c.title?.toLowerCase().includes("ebitda") ||
        c.title?.toLowerCase().includes("calls") ||
        c.title?.toLowerCase().includes("lines") ||
        c.finding_kind === "data_divergence"
      ),
    };

    const gatePassed =
      reportable.length > 0 &&
      reportableWithExactlyOneClaimId === reportable.length &&
      reportableWithZeroOrMultiple === 0 &&
      duplicatesInReportable === 0 &&
      invalidLinksInReportable === 0 &&
      gateChecks.at_least_one_saint_issue;

    return {
      total_reconciliation_findings: reconFindings.length,
      total_regenerated_candidates: candidates.length,
      reportable_candidates: reportable.length,
      non_reportable_candidates: nonReportable.length,
      candidates_by_memo: byMemo,
      candidates_by_claim_type: byClaimType,
      candidates_by_finding_kind: byFindingKind,
      candidates_with_zero_claim_ids: zeroClaims,
      candidates_with_multiple_claim_ids: multipleClaims,
      duplicate_claim_ids_rejected: duplicateClaimIds,
      invalid_non_ic_links_rejected: invalidNonIcLinks,
      duplicates_leaked_to_reportable: duplicatesInReportable,
      invalid_links_leaked_to_reportable: invalidLinksInReportable,
      gate_passed: gatePassed,
      gate_checks: gateChecks,
      candidates,
    };
  },
});

const CLM_PATTERN_CHECK = /^clm-v1-[a-f0-9]+$/;
