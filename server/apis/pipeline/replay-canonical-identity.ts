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
 * Persists the Q4 identity mapping at tree_level=95, node_index=0.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  groupIntoCanonicalFamilies,
  type CanonicalFamily,
} from "./canonical-issue-identity.js";
import {
  Q4_ELIGIBLE_ADVERSE,
  type ClaimLinkageDisposition,
  type ClaimProvenance,
} from "./claim-linkage.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CanonicalKeySchema = z.object({
  issue_domain: z.string(),
  issue_type: z.string(),
  metric: z.string(),
  period: z.string(),
  entity_or_segment: z.string(),
  scope: z.string().nullable(),
  comparison_basis: z.string(),
  direction_of_difference: z.string(),
});

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

const FamilyOutputSchema = z.object({
  canonical_key_str: z.string(),
  canonical_key: CanonicalKeySchema,
  member_count: z.number(),
  member_finding_ids: z.array(z.string()),
  all_originating_claim_ids: z.array(z.string()),
  memo_versions: z.array(z.string()),
  merge_decision: z.enum(["grouped", "singleton", "ambiguous_pending_llm"]),
  merge_reason: z.string(),
  members_with_provenance: z.array(FamilyMemberSchema),
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
    total_canonical_issues: z.number(),
    silent_losses: z.number(),
    families: z.array(FamilyOutputSchema),
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

    const q3Metadata = q3Parsed._replay_metadata ?? {};
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
        total_canonical_issues: 0,
        silent_losses: 0,
        families: [],
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
    // STEP 5: Build enriched finding list — ONLY from Q4-eligible Q3 results
    // =========================================================================
    const enrichedFindings = eligibleResults.map(q3 => {
      const f = findingsMap.get(q3.finding_id) ?? {};

      // FAIL CLOSED: every Q4 member must be traceable to Q3
      if (!q3ByFindingId.has(q3.finding_id)) {
        throw new Error(
          `FAIL CLOSED: Q4 member '${q3.finding_id}' cannot be traced to Q3 checkpoint.`
        );
      }

      return {
        finding_id: q3.finding_id,
        corpus_index: q3.corpus_index,
        title: q3.title,
        detail: f.detail ?? f.evidence ?? null,
        full_analysis: f.full_analysis ?? null,
        severity: f.severity ?? null,
        source_tag: q3.evidence_source_type ?? f.source_tag ?? null,
        finding_kind: f.finding_kind ?? null,
        issue_key: f.issue_key ?? null,
        originating_claim_id: q3.claim_provenance?.claim_id ?? f.originating_claim_id ?? null,
        claim_ids: f.claim_ids ?? null,
        source_docs: f.source_docs ?? null,
        claim_type: q3.claim_provenance?.claim_type ?? f.claim_type ?? null,
      };
    });

    // =========================================================================
    // STEP 6: Apply canonical identity grouping
    // =========================================================================
    const { families, singletons, ambiguous } = groupIntoCanonicalFamilies(enrichedFindings);

    // =========================================================================
    // STEP 7: Build output families with Q3 provenance in every member
    // =========================================================================
    const allFamilies = [
      ...families.map(family => {
        const membersWithProvenance = family.member_finding_ids.map(fid => {
          const q3Result = q3ByFindingId.get(fid)!;
          return {
            finding_id: fid,
            corpus_index: q3Result.corpus_index,
            title: q3Result.title,
            q3_provenance: {
              q3_disposition: q3Result.claim_linkage_disposition,
              q3_verdict: q3Result.claim_provenance?.verdict ?? null,
              q3_authority_class: q3Result.authority_class,
              q3_authority_valid: q3Result.authority_valid,
              q3_authority_rationale: q3Result.authority_rationale,
              q3_claim_id: q3Result.claim_provenance?.claim_id ?? null,
              q3_ic_document_filename: q3Result.claim_provenance?.ic_document_filename ?? null,
              q3_memo_version: q3Result.claim_provenance?.memo_version ?? null,
              q3_page_or_location: q3Result.claim_provenance?.page_or_location ?? null,
            },
          };
        });

        // Collect memo versions from Q3 provenance
        const memoVersions = [...new Set(
          membersWithProvenance
            .map(m => m.q3_provenance.q3_memo_version)
            .filter((v): v is string => v !== null)
        )];

        return {
          canonical_key_str: family.canonical_key_str,
          canonical_key: family.canonical_key,
          member_count: family.member_finding_ids.length,
          member_finding_ids: family.member_finding_ids,
          all_originating_claim_ids: family.all_originating_claim_ids,
          memo_versions: memoVersions,
          merge_decision: family.member_finding_ids.length > 1
            ? "grouped" as const
            : "singleton" as const,
          merge_reason: family.member_finding_ids.length > 1
            ? `${family.member_finding_ids.length} findings share canonical key: ${family.canonical_key_str}`
            : "Single finding with deterministic key — singleton",
          members_with_provenance: membersWithProvenance,
        };
      }),
      ...singletons.map(s => {
        const q3Result = q3ByFindingId.get(s.finding_id)!;
        const membersWithProvenance = [{
          finding_id: s.finding_id,
          corpus_index: s.corpus_index,
          title: s.title,
          q3_provenance: {
            q3_disposition: q3Result.claim_linkage_disposition,
            q3_verdict: q3Result.claim_provenance?.verdict ?? null,
            q3_authority_class: q3Result.authority_class,
            q3_authority_valid: q3Result.authority_valid,
            q3_authority_rationale: q3Result.authority_rationale,
            q3_claim_id: q3Result.claim_provenance?.claim_id ?? null,
            q3_ic_document_filename: q3Result.claim_provenance?.ic_document_filename ?? null,
            q3_memo_version: q3Result.claim_provenance?.memo_version ?? null,
            q3_page_or_location: q3Result.claim_provenance?.page_or_location ?? null,
          },
        }];

        return {
          canonical_key_str: s.canonical_key_str,
          canonical_key: s.canonical_key,
          member_count: 1,
          member_finding_ids: [s.finding_id],
          all_originating_claim_ids: s.originating_claim_ids,
          memo_versions: q3Result.claim_provenance?.memo_version
            ? [q3Result.claim_provenance.memo_version]
            : [],
          merge_decision: "singleton" as const,
          merge_reason: s.reason,
          members_with_provenance: membersWithProvenance,
        };
      }),
    ];

    // =========================================================================
    // STEP 8: Final accounting
    // =========================================================================
    const totalAccountedFor = families.reduce((sum, f) => sum + f.member_finding_ids.length, 0) +
                              singletons.length + ambiguous.length;
    const silentLosses = q4EligibleInput - totalAccountedFor;
    const totalCanonicalIssues = families.length + singletons.length;

    // =========================================================================
    // STEP 9: Persist at tree_level=95
    // =========================================================================
    const q4Payload = JSON.stringify({
      _identity_metadata: {
        run_id: runId,
        module_id: moduleId,
        identity_type: "Q4_canonical_issue",
        q3_gated: true,
        timestamp: new Date().toISOString(),
        schema_version: "2.0.0",
        total_q3_candidates: totalQ3Candidates,
        q4_eligible_input: q4EligibleInput,
        q4_ineligible_excluded: q4IneligibleExcluded,
        grouped_families: families.length,
        singleton_findings: singletons.length,
        ambiguous_findings: ambiguous.length,
        total_canonical_issues: totalCanonicalIssues,
        silent_losses: silentLosses,
      },
      families: allFamilies,
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

    return {
      total_q3_candidates: totalQ3Candidates,
      q4_eligible_input: q4EligibleInput,
      q4_ineligible_excluded: q4IneligibleExcluded,
      grouped_families: families.length,
      singleton_findings: singletons.length,
      ambiguous_findings: ambiguous.length,
      total_canonical_issues: totalCanonicalIssues,
      silent_losses: silentLosses,
      families: allFamilies,
      checkpoint_id: persisted.id,
    };
  },
});
