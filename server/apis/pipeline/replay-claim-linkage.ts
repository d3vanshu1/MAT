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
  buildCanonicalLedgerFromCheckpoint,
} from "./claim-linkage.js";
import {
  buildEvidenceSnapshot,
  type EvidenceSnapshot,
} from "./finding-identity.js";
import {
  buildReconciliationIndex,
  resolveViaReconciliation,
  type ReconciliationIndex,
} from "./legacy-claim-reconciler.js";
import type { IdentifiedClaim } from "./claims-ledger-identity.js";
import {
  admitCandidateEvidence,
  serializeEvidenceAdmissionLedger,
  type CandidateEvidenceAdmissionResult,
  type AdmittedEvidenceRecord,
  type RejectedEvidenceRecord,
  type LegacyEvidenceEntry,
  type EvidenceAdmissionLedger,
} from "./evidence-admission-boundary.js";
import {
  executeCanonicalComparison,
  serializeComparisonLedger,
  type CanonicalComparison,
  type ComparisonClaimInput,
  type ComparisonEvidenceInput,
} from "./canonical-comparison.js";

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

    // 4a. HARD FAILURE: Detect duplicate claim IDs in the loaded ledger
    const claimIdCounts = new Map<string, number>();
    const allLedgerClaims: IdentifiedClaim[] = [];
    for (const [, claim] of claimMap) {
      const cid = claim.claim_id;
      if (cid) {
        claimIdCounts.set(cid, (claimIdCounts.get(cid) ?? 0) + 1);
        allLedgerClaims.push(claim);
      }
    }
    const duplicateClaimIds = [...claimIdCounts.entries()].filter(([, n]) => n > 1);
    if (duplicateClaimIds.length > 0) {
      const dupList = duplicateClaimIds.map(([id, n]) => `${id} (×${n})`).join(", ");
      throw new Error(
        `HARD FAILURE in Q3: Claims ledger contains ${duplicateClaimIds.length} duplicate claim IDs. ` +
        `Deterministic identity must be unique. Duplicates: ${dupList.slice(0, 500)}. ` +
        `Re-run ReplayPopulateClaimsLedger to fix identity inputs.`
      );
    }

    // 4b. Build legacy-to-deterministic reconciliation bridge
    // Collect all unique legacy refs from candidates
    const legacyRefsSet = new Set<string>();
    for (const candidate of candidates) {
      const finding = findingsMap.get(candidate.finding_id);
      if (finding?.originating_claim_id) legacyRefsSet.add(finding.originating_claim_id);
      if (finding?.claim_ids) {
        for (const cid of finding.claim_ids) legacyRefsSet.add(cid);
      }
    }

    // Load document order for positional reconciliation
    const DocOrderRow = z.object({ id: z.string() });
    const orderedDocs = await ctx.integrations.db.query(
      `SELECT id FROM documents
       WHERE deal_id = (SELECT deal_id FROM module_runs WHERE id = $1 LIMIT 1)
         AND document_tag = 'ic_memo'
       ORDER BY uploaded_at ASC`,
      DocOrderRow,
      [runId],
      { label: "Load IC document order for positional reconciliation" }
    );
    const documentOrder = orderedDocs.map(d => d.id);

    const reconciliation = buildReconciliationIndex(
      [...legacyRefsSet],
      allLedgerClaims,
      documentOrder,
      claimMap as Map<string, IdentifiedClaim>,
    );

    console.log(
      `[ReplayClaimLinkage] Reconciliation: ${reconciliation.summary.total_attempted} refs attempted, ` +
      `${reconciliation.summary.bridged_positional} positional, ${reconciliation.summary.bridged_metric_period} metric-period, ` +
      `${reconciliation.summary.bridged_direct} direct, ` +
      `${reconciliation.summary.unresolved_no_match + reconciliation.summary.unresolved_ambiguous + reconciliation.summary.unresolved_malformed + reconciliation.summary.unresolved_no_positional_data} unresolved`
    );

    // Augment claimMap with bridged entries so resolveClaimId can find them
    for (const [legacyRef, canonicalId] of reconciliation.bridge) {
      if (!claimMap.has(legacyRef)) {
        claimMap.set(legacyRef, claimMap.get(canonicalId));
      }
    }

    // Build set of ambiguous refs for hard-rejection in Q3
    const ambiguousRefs = new Set<string>();
    for (const rec of reconciliation.records) {
      if (rec.outcome === "unresolved_ambiguous") {
        ambiguousRefs.add(rec.legacy_ref);
      }
    }

    // 5. Process each candidate through strict claim-linkage
    // MAT-F01: Build canonical ledger from pipeline_checkpoints for admission gate
    const canonicalLedgerRows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
       ORDER BY updated_at DESC LIMIT 1`,
      z.object({ payload: z.any() }),
      [runId],
      { label: "Load canonical claims for admission gate" }
    );
    let canonicalLedger = null;
    if (canonicalLedgerRows.length > 0) {
      const cpPayload = typeof canonicalLedgerRows[0].payload === "string"
        ? JSON.parse(canonicalLedgerRows[0].payload)
        : canonicalLedgerRows[0].payload;
      canonicalLedger = buildCanonicalLedgerFromCheckpoint(cpPayload?.canonical_claims);
      if (canonicalLedger) {
        console.log(`[ReplayClaimLinkage][MAT-F01] Canonical admission gate active: ${canonicalLedger.claims.length} validated claims`);
      }
    }

    const linkageResults: ClaimLinkageResult[] = [];
    const evidenceSnapshots: EvidenceSnapshot[] = [];
    const dispositionCounts: Record<string, number> = {};

    // MAT-F03: Canonical comparison ledger
    const canonicalComparisons: CanonicalComparison[] = [];

    // MAT-F02B: Evidence admission ledger — tracks all evidence through canonical gate
    const evidenceAdmissionResults: CandidateEvidenceAdmissionResult[] = [];

    for (const candidate of candidates) {
      const finding = findingsMap.get(candidate.finding_id);

      // ─── MAT-F02B: Canonical evidence admission gate ───────────────────────
      // Process ALL evidence entries through the admission gate BEFORE
      // they can influence claim-linkage disposition, comparison, or eligibility.
      const rawEvidenceEntries: LegacyEvidenceEntry[] =
        Array.isArray(finding?.evidence) ? finding.evidence : [];

      let evidenceAdmission: CandidateEvidenceAdmissionResult | null = null;
      if (rawEvidenceEntries.length > 0) {
        // Resolve the claim entity for entity-applicability checks
        // Use the claim from the first resolved claim_id
        const primaryClaimId = finding?.originating_claim_id ??
          (finding?.claim_ids?.[0] ?? null);
        const resolvedClaim = primaryClaimId ? claimMap.get(primaryClaimId) : null;

        evidenceAdmission = admitCandidateEvidence(
          rawEvidenceEntries,
          {
            claim_entity: resolvedClaim?.entity ?? resolvedClaim?.scope_qualifier ?? "SCG",
            claim_source_document_id: resolvedClaim?.ic_document_id ?? null,
            proposition_type: resolvedClaim?.claim_category ?? resolvedClaim?.claim_type ?? finding?.claim_type ?? "unclassified",
            candidate_reference: candidate.finding_id,
            // Source text validation deferred to full-text availability
            source_text: "",
          },
          {
            finding_kind: finding?.finding_kind,
            finding_id: candidate.finding_id,
          },
        );

        evidenceAdmissionResults.push(evidenceAdmission);
      }
      // ─── End MAT-F02B evidence admission ────────────────────────────────────

      // ─── MAT-F02B: Gate enforcement ─────────────────────────────────────────
      // If evidence existed but NONE was admitted, this candidate cannot produce
      // a Q4-eligible result. Override to invalid_evidence_authority immediately.
      if (evidenceAdmission && rawEvidenceEntries.length > 0 && !evidenceAdmission.has_admitted_evidence) {
        const authorityClass = evidenceAdmission.rejected.length > 0
          ? evidenceAdmission.rejected[0].authority_class
          : "unknown_or_other" as const;
        const rejectionReasons = evidenceAdmission.rejected.map(r => r.rejection_reason).join(", ");

        const gatedResult: ClaimLinkageResult = {
          finding_id: candidate.finding_id,
          corpus_index: candidate.corpus_index,
          title: candidate.title,
          claim_linkage_disposition: "invalid_evidence_authority",
          q4_eligible: false,
          claim_provenance: null,
          authority_class: authorityClass as any,
          authority_valid: false,
          authority_rationale: `MAT-F02B: All evidence rejected by canonical admission gate — ${rejectionReasons}`,
          reason: `Evidence admission gate: all ${rawEvidenceEntries.length} entries rejected (${rejectionReasons})`,
          evidence_source_type: candidate.source_tag ?? null,
        };

        linkageResults.push(gatedResult);
        dispositionCounts[gatedResult.claim_linkage_disposition] =
          (dispositionCounts[gatedResult.claim_linkage_disposition] ?? 0) + 1;
        continue; // Skip classifyClaimLinkage entirely — no admitted evidence
      }

      // Derive admitted-only evidence fields for classifyClaimLinkage
      // Only admitted evidence may influence authority, disposition, and provenance
      let filteredEvidence: string | null = finding?.evidence ?? null;
      let filteredDocFilename: string | null = finding?.source_docs?.[0] ?? null;
      let filteredSourceTag: string | null = candidate.source_tag;
      let admittedEvidenceIds: string[] = [];

      if (evidenceAdmission && evidenceAdmission.has_admitted_evidence) {
        // Synthesize evidence text from admitted entries only
        const admittedTexts = evidenceAdmission.admitted.map(a => {
          if (a.coordinate.kind === "workbook") {
            return `[${a.source_document_name}] ${a.coordinate.sheet}!${a.coordinate.cell_or_range}: ${a.canonical_record.proposition.value ?? ""}`;
          }
          if (a.coordinate.kind === "pdf") {
            return `[${a.source_document_name}] p.${a.coordinate.page}: "${a.coordinate.exact_quote}"`;
          }
          return `[${a.source_document_name}]`;
        });
        filteredEvidence = admittedTexts.join(" | ");
        // Use the first admitted evidence's document for authority derivation
        filteredDocFilename = evidenceAdmission.admitted[0].source_document_name;
        admittedEvidenceIds = evidenceAdmission.admitted.map(a => a.evidence_id);
      }
      // ─── End MAT-F02B gate enforcement ──────────────────────────────────────

      const result = classifyClaimLinkage(
        {
          finding_id: candidate.finding_id,
          corpus_index: candidate.corpus_index,
          title: candidate.title,
          detail: finding?.detail,
          full_analysis: finding?.full_analysis,
          severity: candidate.severity,
          source_tag: filteredSourceTag,
          source_docs: finding?.source_docs,
          originating_claim_id: finding?.originating_claim_id,
          claim_ids: finding?.claim_ids,
          claim_type: finding?.claim_type,
          finding_kind: finding?.finding_kind,
          evidence: filteredEvidence,
          doc_filename: filteredDocFilename,
          doc_type: finding?.doc_type ?? null,
        },
        claimMap,
        ambiguousRefs,
        canonicalLedger,
      );

      linkageResults.push(result);
      dispositionCounts[result.claim_linkage_disposition] =
        (dispositionCounts[result.claim_linkage_disposition] ?? 0) + 1;

      // ─── MAT-F03: Canonical comparison ──────────────────────────────────────
      // For candidates with admitted evidence AND a resolved claim, run the
      // deterministic comparison engine: compatibility → normalization → delta → verdict
      if (evidenceAdmission?.has_admitted_evidence && result.claim_provenance?.claim_id) {
        const resolvedClaim = claimMap.get(result.claim_provenance.claim_id);
        if (resolvedClaim) {
          for (const admitted of evidenceAdmission.admitted) {
            const compClaim: ComparisonClaimInput = {
              claim_id: result.claim_provenance.claim_id,
              entity: resolvedClaim.entity ?? resolvedClaim.scope_qualifier ?? "SCG",
              metric: resolvedClaim.metric ?? null,
              period: resolvedClaim.period ?? null,
              segment: resolvedClaim.segment ?? null,
              scope: resolvedClaim.scope_qualifier ?? null,
              unit: resolvedClaim.unit ?? null,
              currency: resolvedClaim.currency ?? "GBP",
              scale: resolvedClaim.scale ?? null,
              actual_or_forecast: resolvedClaim.actual_or_forecast ?? null,
              accounting_basis: resolvedClaim.accounting_basis ?? null,
              comparison_basis: "memo_claim",
              value: resolvedClaim.value ?? null,
              ic_document_id: resolvedClaim.ic_document_id ?? null,
            };

            const compEvidence: ComparisonEvidenceInput = {
              evidence_id: admitted.evidence_id,
              entity: admitted.canonical_record.target.entity ?? "SCG",
              metric: admitted.canonical_record.proposition.metric ?? null,
              period: admitted.canonical_record.proposition.period ?? null,
              segment: admitted.canonical_record.target.segment ?? null,
              scope: admitted.canonical_record.proposition.scope ?? null,
              unit: admitted.canonical_record.proposition.unit ?? null,
              currency: admitted.canonical_record.proposition.currency ?? "GBP",
              scale: admitted.canonical_record.proposition.scale ?? null,
              actual_or_forecast: admitted.canonical_record.proposition.actual_forecast_status ?? null,
              accounting_basis: admitted.canonical_record.proposition.accounting_basis ?? null,
              comparison_basis: admitted.coordinate.kind === "workbook" ?
                (admitted.coordinate.sheet?.includes("hardcoded") ? "reference_forecast" : "current_model") :
                "model_evidence",
              value: admitted.canonical_record.proposition.value ?? null,
              source_document_id: admitted.source_document_id,
              has_entity_bridge: admitted.entity_applicability.allowed && !admitted.entity_applicability.direct_entity_match,
            };

            const comparison = executeCanonicalComparison(compClaim, compEvidence);
            canonicalComparisons.push(comparison);
          }
        }
      }
      // ─── End MAT-F03 ────────────────────────────────────────────────────────

      // Build evidence snapshot if claim was resolved
      if (result.claim_provenance && result.claim_provenance.claim_id) {
        const resolvedClaim = claimMap.get(result.claim_provenance.claim_id);
        if (resolvedClaim) {
          // Collect originating claim IDs for this finding
          const finding = findingsMap.get(candidate.finding_id);
          const originatingIds: string[] = [];
          if (finding?.originating_claim_id) originatingIds.push(finding.originating_claim_id);
          if (finding?.claim_ids) {
            for (const cid of finding.claim_ids) {
              if (!originatingIds.includes(cid)) originatingIds.push(cid);
            }
          }

          const snapshot = buildEvidenceSnapshot({
            claim_id: result.claim_provenance.claim_id,
            claim_record: {
              metric: resolvedClaim.metric ?? "",
              period: resolvedClaim.period ?? "",
              scope_qualifier: resolvedClaim.scope_qualifier ?? "",
              value: resolvedClaim.value ?? 0,
              unit: resolvedClaim.unit ?? "",
              verbatim_snippet: resolvedClaim.verbatim_snippet ?? "",
              memo_version: resolvedClaim.memo_version ?? "",
              ic_document_id: resolvedClaim.ic_document_id ?? "",
              ic_document_filename: resolvedClaim.ic_document_filename ?? "",
              claim_type: resolvedClaim.claim_type ?? "",
            },
            authority_class: result.authority_class,
            verdict: result.claim_provenance.verdict,
            evidence_text: result.claim_provenance.evidence,
            originating_claim_ids: originatingIds,
          });
          evidenceSnapshots.push(snapshot);
        }
      }
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

    // 7b. MAT-F02B: Log evidence admission diagnostics
    const totalAdmitted = evidenceAdmissionResults.reduce((sum, r) => sum + r.admitted.length, 0);
    const totalRejected = evidenceAdmissionResults.reduce((sum, r) => sum + r.rejected.length, 0);
    const totalEvidenceProcessed = evidenceAdmissionResults.reduce((sum, r) => sum + r.total_processed, 0);
    console.log(
      `[ReplayClaimLinkage][MAT-F02B] Evidence admission: ${totalEvidenceProcessed} entries processed, ` +
      `${totalAdmitted} admitted, ${totalRejected} rejected across ${evidenceAdmissionResults.length} candidates`
    );

    // Serialize evidence admission ledgers for persistence
    const evidenceAdmissionLedgers = evidenceAdmissionResults.map(r =>
      serializeEvidenceAdmissionLedger(r)
    );

    // 8. Persist Q3 replay at tree_level=96
    const q3Payload = JSON.stringify({
      _replay_metadata: {
        run_id: runId,
        module_id: moduleId,
        replay_type: "Q3_claim_linkage_strict",
        replay_timestamp: new Date().toISOString(),
        schema_version: "3.1.0",
        total_candidates: totalCandidates,
        q4_eligible_count: q4EligibleCount,
        q4_ineligible_count: q4IneligibleCount,
        silent_losses: silentLosses,
        eligibility_breakdown: eligibilityBreakdown,
        evidence_snapshots_count: evidenceSnapshots.length,
        // MAT-F02B: Evidence admission summary
        evidence_admission: {
          total_processed: totalEvidenceProcessed,
          total_admitted: totalAdmitted,
          total_rejected: totalRejected,
          candidates_with_evidence: evidenceAdmissionResults.length,
        },
      },
      linkage_by_disposition: dispositionCounts,
      results: linkageResults,
      evidence_snapshots: evidenceSnapshots,
      // MAT-F02B: Full evidence admission ledger (admitted + rejected records)
      evidence_admission_ledgers: evidenceAdmissionLedgers,
      // MAT-F03: Canonical comparison results
      canonical_comparisons: JSON.parse(serializeComparisonLedger(canonicalComparisons)),
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
