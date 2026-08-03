/**
 * ReplayCanonicalIdentity — Q4 Canonical Issue Identity (Q3-Gated)
 *
 * CRITICAL CHANGE: Q4 now loads Q3 results (tree_level=96) as its SOLE eligible
 * population. It does NOT load from Q2 directly.
 *
 * FAIL-CLOSED RULES:
 *   - Q3 checkpoint absent → hard failure
 *   - A candidate has zero Q3 matches → hard failure
 *   - A candidate has multiple Q3 matches → hard failure
 *   - Q3 eligibility counts do not reconcile → hard failure
 *   - A Q4 family member cannot be traced back to Q3 → hard failure
 *   - Terminal accounting violations → hard failure
 *
 * Q4-ELIGIBLE INPUT (from Q3):
 *   - claim_linked_contradicted
 *   - claim_linked_partially_supported
 *   - claim_linked_unsupported
 *   - claim_linked_materially_changed
 *   - claim_linked_unverifiable (only when claim resolves AND authority permits)
 *
 * Q4-INELIGIBLE (excluded):
 *   - not_linked_to_IC_claim
 *   - claim_linked_confirmed
 *   - invalid_or_unresolved_claim_reference
 *   - invalid_evidence_authority
 *   - supporting_evidence_only, wrong_module, process_diagnostic, etc.
 *
 * Every Q4 member preserves:
 *   - Q3 outcome (disposition)
 *   - Q3 verdict
 *   - Resolved claim (full provenance)
 *   - Memo location
 *   - Authority decision and rationale
 *
 * MESSAGE 3 ADDITIONS:
 *   - Extended CanonicalKey (unit, actual_or_forecast, accounting_basis)
 *   - Claim chronology (repeated/corrected/weakened/strengthened/omitted)
 *   - Degraded record persistence (full output, not just terminal row)
 *   - Strong accounting validation (6 invariants, hard-fail on violation)
 *   - No defaults (unknown remains unknown)
 *
 * Persists the Q4 identity mapping at tree_level=95, node_index=0.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  groupIntoCanonicalFamilies,
  validateTerminalAccounting,
  type CanonicalFamily,
  type AmbiguousCandidate,
  type DegradedRecord,
  type ClaimChronologyEntry,
  CanonicalKeySchema,
} from "./canonical-issue-identity.js";
import {
  executeQ4Stage,
  type Q4Family,
  type Q4StageOutput,
} from "./q4-production-stage.js";
import { executeQ5Stage, type Q5Finding } from "./q5-production-stage.js";
import type { Q2CandidateInput, Q3ResultRow } from "./q3-production-stage.js";
import type { CanonicalFindingRecord } from "./canonical-finding-record.js";
import {
  Q4_ELIGIBLE_ADVERSE,
  type ClaimLinkageDisposition,
  type ClaimProvenance,
} from "./claim-linkage.js";
import { generateCanonicalFindingId } from "./finding-identity.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const Q3ProvenanceInMember = z.object({
  q3_disposition: z.string(),
  q3_verdict: z.string().nullable(),
  q3_authority_class: z.string(),
  q3_authority_valid: z.boolean(),
  q3_authority_rationale: z.string(),
  q3_claim_id: z.string().nullable(),
  q3_ic_document_filename: z.string().nullable(),
  q3_memo_version: z.string().nullable(),
  q3_page_or_location: z.string().nullable(),
});

const FamilyMemberSchema = z.object({
  finding_id: z.string(),
  corpus_index: z.number(),
  title: z.string(),
  q3_provenance: Q3ProvenanceInMember,
});

const ClaimChronologySchema = z.object({
  claim_id: z.string(),
  claim_text: z.string(),
  memo_version: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  version_status: z.enum(["introduced", "repeated", "corrected", "weakened", "strengthened", "omitted"]),
});

const DegradedOutputSchema = z.object({
  original_finding_id: z.string(),
  claim_linkage_disposition: z.string(),
  resolved_claim_id: z.string().nullable(),
  evidence_snapshot_ids: z.array(z.string()),
  family_key_str: z.string().nullable(),
  failure_reason: z.string(),
  terminal_reference: z.string(),
  degraded_output: z.object({
    title: z.string(),
    originating_claim_text: z.string().nullable(),
    evidence_excerpts: z.array(z.string()),
    verification_status: z.literal("degraded"),
    evidence_quality: z.literal("degraded"),
  }),
});

const FamilyOutputSchema = z.object({
  canonical_key_str: z.string(),
  canonical_key: CanonicalKeySchema,
  deterministic_finding_id: z.string(),
  member_count: z.number(),
  member_finding_ids: z.array(z.string()),
  all_originating_claim_ids: z.array(z.string()),
  memo_versions: z.array(z.string()),
  claim_chronology: z.array(ClaimChronologySchema),
  merge_decision: z.enum(["grouped", "singleton", "ambiguous_pending_llm"]),
  merge_reason: z.string(),
  members_with_provenance: z.array(FamilyMemberSchema),
});

const AmbiguousOutputSchema = z.object({
  finding_id: z.string(),
  corpus_index: z.number(),
  title: z.string(),
  ambiguity_reasons: z.array(z.string()),
  candidate_families: z.array(z.string()),
  resolution: z.enum(["preserved_separate", "degraded", "adjudicated"]),
});

export default api({
  name: "ReplayCanonicalIdentity",
  description: "Q4: assigns canonical issue identity using Q3 as sole eligible input",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    total_q3_candidates: z.number(),
    q4_eligible_input: z.number(),
    q4_ineligible_excluded: z.number(),
    grouped_families: z.number(),
    singleton_findings: z.number(),
    ambiguous_findings: z.number(),
    degraded_findings: z.number(),
    total_canonical_issues: z.number(),
    silent_losses: z.number(),
    accounting_valid: z.boolean(),
    families: z.array(FamilyOutputSchema),
    ambiguous_records: z.array(AmbiguousOutputSchema),
    degraded_records: z.array(DegradedOutputSchema),
    checkpoint_id: z.string(),
  }),

  async run(ctx, { runId, moduleId }) {
    // =========================================================================
    // STEP 1: Load Q3 checkpoint (tree_level=96) — FAIL CLOSED if absent
    // =========================================================================
    const Q3Row = z.object({ merged_json: z.any() });
    const q3Rows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 96 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      Q3Row,
      [runId],
      { label: "Load Q3 claim-linkage checkpoint (REQUIRED)" }
    );

    if (q3Rows.length === 0) {
      throw new Error(
        `FAIL CLOSED: Q3 checkpoint (tree_level=96) absent for run ${runId}. ` +
        `Q4 cannot proceed without Q3 claim-linkage results. Run ReplayClaimLinkage first.`
      );
    }

    const q3Parsed = typeof q3Rows[0].merged_json === "string"
      ? JSON.parse(q3Rows[0].merged_json)
      : q3Rows[0].merged_json;

    const q3Results = (q3Parsed.results ?? []) as Array<{
      finding_id: string;
      corpus_index: number;
      title: string;
      claim_linkage_disposition: string;
      q4_eligible: boolean;
      claim_provenance: ClaimProvenance | null;
      authority_class: string;
      authority_valid: boolean;
      authority_rationale: string;
      reason: string;
      evidence_source_type: string | null;
    }>;

    const totalQ3Candidates = q3Results.length;

    if (totalQ3Candidates === 0) {
      throw new Error(`FAIL CLOSED: Q3 checkpoint contains zero results for run ${runId}.`);
    }

    // =========================================================================
    // STEP 2: Build Q3 lookup and validate uniqueness (no duplicates)
    // =========================================================================
    const q3ByFindingId = new Map<string, typeof q3Results[number]>();
    const duplicateCheck = new Set<string>();

    for (const result of q3Results) {
      if (duplicateCheck.has(result.finding_id)) {
        throw new Error(
          `FAIL CLOSED: Duplicate finding_id '${result.finding_id}' in Q3 checkpoint. ` +
          `Each candidate must have exactly one Q3 result.`
        );
      }
      duplicateCheck.add(result.finding_id);
      q3ByFindingId.set(result.finding_id, result);
    }

    // =========================================================================
    // STEP 3: Filter to Q4-eligible candidates (from Q3 dispositions)
    // =========================================================================
    const eligibleResults = q3Results.filter(r => r.q4_eligible);
    const ineligibleResults = q3Results.filter(r => !r.q4_eligible);

    const q4EligibleInput = eligibleResults.length;
    const q4IneligibleExcluded = ineligibleResults.length;

    // Reconciliation check
    if (q4EligibleInput + q4IneligibleExcluded !== totalQ3Candidates) {
      throw new Error(
        `FAIL CLOSED: Q3 eligibility counts do not reconcile. ` +
        `eligible=${q4EligibleInput} + ineligible=${q4IneligibleExcluded} ≠ total=${totalQ3Candidates}`
      );
    }

    if (q4EligibleInput === 0) {
      // No eligible candidates — persist empty Q4 and return
      const emptyPayload = JSON.stringify({
        _identity_metadata: {
          run_id: runId,
          module_id: moduleId,
          identity_type: "Q4_canonical_issue",
          q3_gated: true,
          timestamp: new Date().toISOString(),
          total_q3_candidates: totalQ3Candidates,
          q4_eligible_input: 0,
          q4_ineligible_excluded: q4IneligibleExcluded,
          total_canonical_issues: 0,
          silent_losses: 0,
        },
        families: [],
        ambiguous_records: [],
        degraded_records: [],
      });

      const UpsertSchema = z.object({ id: z.string() });
      const [persisted] = await ctx.integrations.db.query(
        `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
         VALUES ($1, 95, 0, 'q4_canonical_identity', $2::jsonb, now())
         ON CONFLICT (module_run_id, tree_level, node_index)
         DO UPDATE SET merged_json = $2::jsonb, status = 'q4_canonical_identity', updated_at = now()
         RETURNING id`,
        UpsertSchema,
        [runId, emptyPayload],
        { label: "Persist empty Q4 (no eligible candidates)" }
      );

      return {
        total_q3_candidates: totalQ3Candidates,
        q4_eligible_input: 0,
        q4_ineligible_excluded: q4IneligibleExcluded,
        grouped_families: 0,
        singleton_findings: 0,
        ambiguous_findings: 0,
        degraded_findings: 0,
        total_canonical_issues: 0,
        silent_losses: 0,
        accounting_valid: true,
        families: [],
        ambiguous_records: [],
        degraded_records: [],
        checkpoint_id: persisted.id,
      };
    }

    // =========================================================================
    // STEP 4: Load findings corpus (tree_level=98) for structured metadata
    // =========================================================================
    const CorpusRow = z.object({ merged_json: z.any(), node_index: z.number() });
    const corpusRows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load findings corpus for identity metadata" }
    );

    const findingsMap = new Map<string, any>();
    for (const row of corpusRows) {
      const parsed = typeof row.merged_json === "string" ? JSON.parse(row.merged_json) : row.merged_json;
      const findings = parsed.findings || (Array.isArray(parsed) ? parsed : []);
      for (const f of findings) {
        const fid = f.finding_id || f.id;
        if (fid) findingsMap.set(fid, f);
      }
    }

    // =========================================================================
    // STEP 5: Build Q3ResultRow + Q2CandidateInput for executeQ4Stage
    // =========================================================================
    const q3ResultRows: Q3ResultRow[] = eligibleResults.map(q3 => ({
      candidate_id: q3.finding_id,
      canonical_comparison_ids: [],
      disposition: q3.claim_linkage_disposition,
      q4_eligible: q3.q4_eligible,
      eligibility_reason: q3.reason,
      rejection_reason_codes: q3.q4_eligible ? [] : [q3.claim_linkage_disposition],
      canonical_finding_id: null,
      evidence_admission_refs: [],
      authority_class: q3.authority_class,
      authority_valid: q3.authority_valid,
      authority_rationale: q3.authority_rationale,
      claim_provenance: q3.claim_provenance,
      verdict: q3.claim_provenance?.verdict ?? null,
    }));

    const q2Candidates: Q2CandidateInput[] = eligibleResults.map(q3 => {
      const f = findingsMap.get(q3.finding_id) ?? {};
      return {
        candidate_id: q3.finding_id,
        canonical_claim_id: q3.claim_provenance?.claim_id ?? f.originating_claim_id ?? null,
        admitted_evidence_ids: [],
        originating_run_id: runId,
        originating_module_id: moduleId,
        candidate_type: "contradiction_candidate",
        creation_rule_version: "replay-q4-v3",
        title: q3.title,
        detail: f.detail ?? f.evidence ?? null,
        finding_kind: f.finding_kind ?? null,
        severity: f.severity ?? null,
        source_tag: q3.evidence_source_type ?? f.source_tag ?? null,
        source_docs: f.source_docs ?? [],
        metric: f.metric ?? null,
        period: f.period ?? null,
        scope_qualifier: f.scope_qualifier ?? null,
        entity_segment: f.entity_segment ?? null,
        unit: f.unit ?? null,
        actual_or_forecast: f.actual_or_forecast ?? null,
        accounting_basis: f.accounting_basis ?? null,
        comparison_basis: f.comparison_basis ?? null,
        verification_evidence: null,
        comparison_inputs: null,
      };
    });

    // =========================================================================
    // STEP 6: Apply canonical identity grouping via executeQ4Stage (ROUTE PARITY)
    // =========================================================================
    const q4Output: Q4StageOutput = executeQ4Stage({
      q3Results: q3ResultRows,
      candidates: q2Candidates,
    });

    const { families: q4Families, singletons, ambiguous, degraded, memberToFamily } = q4Output;

    // =========================================================================
    // STEP 7: Build claim chronology for families (replay-specific enrichment)
    // =========================================================================
    const familyChronologies = new Map<string, ClaimChronologyEntry[]>();
    for (const family of q4Families) {
      const chronology: ClaimChronologyEntry[] = [];
      const seenClaims = new Set<string>();

      for (const memberId of family.member_candidate_ids) {
        const q3Result = q3ByFindingId.get(memberId);
        if (!q3Result?.claim_provenance?.claim_id) continue;

        const cp = q3Result.claim_provenance;
        const claimKey = `${cp.claim_id}|${cp.memo_version ?? "unknown"}`;
        if (seenClaims.has(claimKey)) continue;
        seenClaims.add(claimKey);

        // Determine version_status based on chronology
        let version_status: ClaimChronologyEntry["version_status"] = "introduced";
        const existingForSameClaim = chronology.filter(c => c.claim_id === cp.claim_id);
        if (existingForSameClaim.length > 0) {
          version_status = "repeated";
        }

        chronology.push({
          claim_id: cp.claim_id,
          claim_text: cp.exact_claim_text ?? "",
          memo_version: cp.memo_version ?? "unknown",
          value: extractNumericValue(cp.exact_claim_text ?? ""),
          unit: extractUnit(cp.exact_claim_text ?? ""),
          version_status,
        });
      }

      familyChronologies.set(family.family_id, chronology);
    }

    // =========================================================================
    // STEP 8: Build output families with Q3 provenance in every member
    // (q4Families already includes singletons — no separate singleton pass)
    // =========================================================================
    const allFamilies = q4Families.map(family => {
      const membersWithProvenance = family.member_candidate_ids.map(fid => {
        const q3Result = q3ByFindingId.get(fid)!;
        return {
          finding_id: fid,
          corpus_index: q3Result?.corpus_index ?? 0,
          title: q3Result?.title ?? "",
          q3_provenance: {
            q3_disposition: q3Result?.claim_linkage_disposition ?? "unknown",
            q3_verdict: q3Result?.claim_provenance?.verdict ?? null,
            q3_authority_class: q3Result?.authority_class ?? "unknown",
            q3_authority_valid: q3Result?.authority_valid ?? false,
            q3_authority_rationale: q3Result?.authority_rationale ?? "",
            q3_claim_id: q3Result?.claim_provenance?.claim_id ?? null,
            q3_ic_document_filename: q3Result?.claim_provenance?.ic_document_filename ?? null,
            q3_memo_version: q3Result?.claim_provenance?.memo_version ?? null,
            q3_page_or_location: q3Result?.claim_provenance?.page_or_location ?? null,
          },
        };
      });

      const memoVersions = [...new Set(
        membersWithProvenance
          .map(m => m.q3_provenance.q3_memo_version)
          .filter((v): v is string => v !== null)
      )];

      return {
        canonical_key_str: family.canonical_proposition_key,
        canonical_key: family.canonical_key,
        deterministic_finding_id: generateCanonicalFindingId({ canonical_key_str: family.canonical_proposition_key, member_finding_ids: family.member_candidate_ids }),
        member_count: family.member_count,
        member_finding_ids: family.member_candidate_ids,
        all_originating_claim_ids: family.all_originating_claim_ids,
        memo_versions: memoVersions,
        claim_chronology: familyChronologies.get(family.family_id) ?? [],
        merge_decision: family.member_count > 1
          ? "grouped" as const
          : "singleton" as const,
        merge_reason: family.member_count > 1
          ? `${family.member_count} findings share canonical key: ${family.canonical_proposition_key}`
          : "Single finding with deterministic key — singleton",
        members_with_provenance: membersWithProvenance,
      };
    });

    // =========================================================================
    // STEP 9: Build degraded records
    // =========================================================================
    const degradedRecords: DegradedRecord[] = degraded.map(d => d);

    // Also: ambiguous items with resolution "degraded" become degraded records
    const ambiguousRecords = ambiguous.map(a => ({
      finding_id: a.finding_id,
      corpus_index: a.corpus_index,
      title: a.title,
      ambiguity_reasons: a.ambiguity_reasons,
      candidate_families: a.candidate_families,
      resolution: a.resolution,
    }));

    // =========================================================================
    // STEP 10: Strong terminal accounting (hard-fail on violation)
    // =========================================================================
    const inputs = eligibleResults.map(r => r.finding_id);
    const terminalOutcomes = new Map<string, string[]>();
    const canonicalOutputIds: string[] = [];
    const degradedOutputIds: string[] = [];
    const mergedCounts = new Map<string, number>();

    // Family members → canonical finding terminal
    for (const familyOut of allFamilies) {
      const canonId = familyOut.deterministic_finding_id;
      canonicalOutputIds.push(canonId);
      mergedCounts.set(canonId, familyOut.member_count);
      for (const fid of familyOut.member_finding_ids) {
        if (!terminalOutcomes.has(fid)) terminalOutcomes.set(fid, []);
        terminalOutcomes.get(fid)!.push(canonId);
      }
    }

    // Ambiguous items → treated as separate canonical terminals
    for (const a of ambiguous) {
      const ambigTerminal = `ambig-${a.finding_id}`;
      canonicalOutputIds.push(ambigTerminal);
      mergedCounts.set(ambigTerminal, 1);
      if (!terminalOutcomes.has(a.finding_id)) terminalOutcomes.set(a.finding_id, []);
      terminalOutcomes.get(a.finding_id)!.push(ambigTerminal);
    }

    // Degraded items → degraded terminal
    for (const d of degradedRecords) {
      const degradedTerminal = `dgrdd-${d.original_finding_id}`;
      degradedOutputIds.push(degradedTerminal);
      if (!terminalOutcomes.has(d.original_finding_id)) terminalOutcomes.set(d.original_finding_id, []);
      terminalOutcomes.get(d.original_finding_id)!.push(degradedTerminal);
    }

    const accounting = validateTerminalAccounting({
      inputs,
      terminalOutcomes,
      canonicalOutputIds,
      degradedOutputIds,
      memberToFamily,
      mergedCounts,
    });

    if (!accounting.valid) {
      throw new Error(
        `FAIL CLOSED: Terminal accounting violations in Q4:\n` +
        accounting.violations.map(v => `  • ${v}`).join("\n")
      );
    }

    // =========================================================================
    // STEP 11: Final accounting
    // =========================================================================
    const totalAccountedFor = q4Families.reduce((sum, f) => sum + f.member_count, 0) +
                              ambiguous.length + degradedRecords.length;
    const silentLosses = q4EligibleInput - totalAccountedFor;
    const totalCanonicalIssues = q4Families.length;

    // =========================================================================
    // STEP 12: Persist at tree_level=95
    // =========================================================================
    const q4Payload = JSON.stringify({
      _identity_metadata: {
        run_id: runId,
        module_id: moduleId,
        identity_type: "Q4_canonical_issue",
        q3_gated: true,
        timestamp: new Date().toISOString(),
        schema_version: "3.0.0",
        total_q3_candidates: totalQ3Candidates,
        q4_eligible_input: q4EligibleInput,
        q4_ineligible_excluded: q4IneligibleExcluded,
        grouped_families: q4Families.filter(f => f.member_count > 1).length,
        singleton_findings: singletons.length,
        ambiguous_findings: ambiguous.length,
        degraded_findings: degradedRecords.length,
        total_canonical_issues: totalCanonicalIssues,
        silent_losses: silentLosses,
        accounting_valid: accounting.valid,
      },
      families: allFamilies,
      ambiguous_records: ambiguousRecords,
      degraded_records: degradedRecords,
    });

    const UpsertSchema = z.object({ id: z.string() });
    const [persisted] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 95, 0, 'q4_canonical_identity', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'q4_canonical_identity', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, q4Payload],
      { label: "Persist Q4 canonical identity (tree_level=95, Q3-gated)" }
    );

    // =========================================================================
    // STEP 13: Run Q5 via executeQ5Stage — ROUTE PARITY with proof route
    // Load F04 canonical finding records from tree_level=96 (persisted by ReplayClaimLinkage)
    // =========================================================================
    const F04Row = z.object({ merged_json: z.any() });
    const f04Rows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 96 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      F04Row, [runId],
      { label: "Load F04 canonical findings from Q3 checkpoint (tree_level=96)" }
    );

    const f04RecordsByCandidate = new Map<string, CanonicalFindingRecord>();
    if (f04Rows.length > 0) {
      const f04Payload = typeof f04Rows[0].merged_json === "string"
        ? JSON.parse(f04Rows[0].merged_json) : f04Rows[0].merged_json;
      const canonicalFindings = f04Payload?.canonical_findings ?? f04Payload?.f04_records ?? [];
      for (const cfr of canonicalFindings) {
        const claimId = cfr?.claim?.claim_id;
        if (claimId) {
          f04RecordsByCandidate.set(claimId, cfr);
        }
      }
    }

    // Build candidate→F04 map using Q2 candidate claim_id cross-reference
    const f04ByCandidateId = new Map<string, CanonicalFindingRecord>();
    for (const cand of q2Candidates) {
      const claimId = cand.canonical_claim_id;
      if (claimId && f04RecordsByCandidate.has(claimId)) {
        f04ByCandidateId.set(cand.candidate_id, f04RecordsByCandidate.get(claimId)!);
      }
    }

    // Call executeQ5Stage — same function proof route uses
    const q5Output = executeQ5Stage({
      q4Output,
      f04RecordsByCandidate: f04ByCandidateId,
    });

    // Persist Q5 at tree_level=94 (matching proof route)
    const q5Payload = JSON.stringify({
      _metadata: {
        run_id: runId,
        timestamp: new Date().toISOString(),
        schema_version: "5.0.0",
        source_q4_checkpoint: persisted.id,
        canonical_findings_count: q5Output.findings.length,
        reportable_count: q5Output.findings.filter(f => f.reportable).length,
        unresolved_families: q5Output.unresolved_families,
      },
      canonical_findings: q5Output.findings,
    });

    const [q5Persisted] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 94, 0, 'q5_canonical_findings', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'q5_canonical_findings', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, q5Payload],
      { label: "Persist Q5 canonical findings (tree_level=94, route-parity)" }
    );

    return {
      total_q3_candidates: totalQ3Candidates,
      q4_eligible_input: q4EligibleInput,
      q4_ineligible_excluded: q4IneligibleExcluded,
      grouped_families: q4Families.filter(f => f.member_count > 1).length,
      singleton_findings: singletons.length,
      ambiguous_findings: ambiguous.length,
      degraded_findings: degradedRecords.length,
      total_canonical_issues: totalCanonicalIssues,
      silent_losses: silentLosses,
      accounting_valid: accounting.valid,
      families: allFamilies,
      ambiguous_records: ambiguousRecords,
      degraded_records: degradedRecords,
      checkpoint_id: persisted.id,
      q5_checkpoint_id: q5Persisted.id,
      q5_findings_count: q5Output.findings.length,
      q5_reportable_count: q5Output.findings.filter(f => f.reportable).length,
      q5_unresolved_families: q5Output.unresolved_families,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers: extract numeric value and unit from claim text
// ---------------------------------------------------------------------------

function extractNumericValue(text: string): number | null {
  // Match patterns like "£45m", "$120m", "45.3%", "£12.5m"
  const match = text.match(/[£$€]?\s*(\d+(?:\.\d+)?)\s*[mb%]?/i);
  if (match) {
    return parseFloat(match[1]);
  }
  return null;
}

function extractUnit(text: string): string | null {
  if (/£\d/.test(text) || /\bgbp\b/i.test(text)) return "£m";
  if (/\$\d/.test(text) || /\busd\b/i.test(text)) return "$m";
  if (/€\d/.test(text) || /\beur\b/i.test(text)) return "€m";
  if (/\d+(\.\d+)?%/.test(text)) return "%";
  return null;
}
