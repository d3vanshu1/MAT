/**
 * ReplayCanonicalIdentity — Q4 Canonical Issue Identity
 *
 * Loads the Q3 claim-linkage results and applies canonical issue identity
 * to all claim-linked contradiction candidates.
 *
 * Produces a canonical-key mapping with:
 *   - canonical key (issue_domain, issue_type, metric, period, entity, scope, etc.)
 *   - raw candidate IDs
 *   - originating claim IDs
 *   - memo versions
 *   - comparison basis
 *   - merge decision (grouped | singleton | ambiguous)
 *
 * ACCEPTANCE CRITERIA:
 *   - FY26 revenue repetitions consolidate
 *   - FY26 EBITDA repetitions consolidate
 *   - EBITDA adjustments remain distinguishable from EBITDA
 *   - forecast revision and memo-vs-model discrepancy remain separate where different
 *   - Calls & Lines remains a distinct issue
 *   - Different periods, segments, metrics not overmerged
 *   - Every candidate retains originating claim IDs and lineage
 *   - No family based only on source-document overlap
 *   - No silent loss
 *
 * Persists the Q4 identity mapping at tree_level=95, node_index=0.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  groupIntoCanonicalFamilies,
  type CanonicalFamily,
} from "./canonical-issue-identity.js";

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

const FamilyOutputSchema = z.object({
  canonical_key_str: z.string(),
  canonical_key: CanonicalKeySchema,
  member_count: z.number(),
  member_finding_ids: z.array(z.string()),
  all_originating_claim_ids: z.array(z.string()),
  memo_versions: z.array(z.string()),
  merge_decision: z.enum(["grouped", "singleton", "ambiguous_pending_llm"]),
  merge_reason: z.string(),
});

export default api({
  name: "ReplayCanonicalIdentity",
  description: "Q4 replay: assigns canonical issue identity to claim-linked candidates",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    total_input_candidates: z.number(),
    grouped_families: z.number(),
    singleton_findings: z.number(),
    ambiguous_findings: z.number(),
    total_canonical_issues: z.number(),
    silent_losses: z.number(),
    families: z.array(FamilyOutputSchema),
    checkpoint_id: z.string(),
  }),

  async run(ctx, { runId, moduleId }) {
    // 1. Load the Q2 disposition ledger (tree_level=97) to get retained candidates
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
      throw new Error(`No Q2 disposition ledger found for run ${runId}`);
    }

    const rawLedger = ledgerRows[0].merged_json;
    const ledgerParsed = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;
    const ledger = (ledgerParsed.ledger || []) as Array<{
      corpus_index: number;
      finding_id: string;
      disposition: string;
      source_tag: string | null;
      severity: string | null;
      title: string;
      category: string | null;
      l3_node: number;
    }>;

    // Filter to retained candidates
    const candidates = ledger.filter(e => e.disposition === "retained_as_contradiction_candidate");
    const totalInput = candidates.length;

    if (totalInput === 0) {
      throw new Error("No retained candidates found. Run ReplayDispositionHarness first.");
    }

    // 2. Load the original findings corpus (tree_level=98) for full metadata
    const CorpusRow = z.object({ merged_json: z.any(), node_index: z.number() });
    const corpusRows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load findings corpus for identity metadata" }
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

    // 3. Build enriched finding list for identity grouping
    const enrichedFindings = candidates.map(c => {
      const f = findingsMap.get(c.finding_id) ?? {};
      return {
        finding_id: c.finding_id,
        corpus_index: c.corpus_index,
        title: c.title,
        detail: f.detail ?? f.evidence ?? null,
        full_analysis: f.full_analysis ?? null,
        severity: c.severity,
        source_tag: c.source_tag,
        finding_kind: f.finding_kind ?? null,
        issue_key: f.issue_key ?? null,
        originating_claim_id: f.originating_claim_id ?? null,
        claim_ids: f.claim_ids ?? null,
        source_docs: f.source_docs ?? null,
        claim_type: f.claim_type ?? null,
      };
    });

    // 4. Apply canonical identity grouping
    const { families, singletons, ambiguous } = groupIntoCanonicalFamilies(enrichedFindings);

    // 5. Build output families (grouped + singletons)
    const allFamilies = [
      ...families.map(family => ({
        canonical_key_str: family.canonical_key_str,
        canonical_key: family.canonical_key,
        member_count: family.member_finding_ids.length,
        member_finding_ids: family.member_finding_ids,
        all_originating_claim_ids: family.all_originating_claim_ids,
        memo_versions: family.memo_versions,
        merge_decision: family.member_finding_ids.length > 1
          ? "grouped" as const
          : "singleton" as const,
        merge_reason: family.member_finding_ids.length > 1
          ? `${family.member_finding_ids.length} findings share canonical key: ${family.canonical_key_str}`
          : "Single finding with deterministic key — singleton",
      })),
      ...singletons.map(s => ({
        canonical_key_str: s.canonical_key_str,
        canonical_key: s.canonical_key,
        member_count: 1,
        member_finding_ids: [s.finding_id],
        all_originating_claim_ids: s.originating_claim_ids,
        memo_versions: s.memo_versions,
        merge_decision: "singleton" as const,
        merge_reason: s.reason,
      })),
    ];

    // 6. Accounting
    const totalAccountedFor = families.reduce((sum, f) => sum + f.member_finding_ids.length, 0) +
                              singletons.length + ambiguous.length;
    const silentLosses = totalInput - totalAccountedFor;
    const totalCanonicalIssues = families.length + singletons.length;

    // 7. Persist at tree_level=95
    const q4Payload = JSON.stringify({
      _identity_metadata: {
        run_id: runId,
        module_id: moduleId,
        identity_type: "Q4_canonical_issue",
        timestamp: new Date().toISOString(),
        total_input_candidates: totalInput,
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
      { label: "Persist Q4 canonical identity (tree_level=95)" }
    );

    return {
      total_input_candidates: totalInput,
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
