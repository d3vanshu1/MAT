/**
 * AssembleCanonicalFindings — Q5 Evidence Aggregation
 *
 * Constructs one canonical finding per substantive issue by aggregating
 * all related claims, evidence records, and comparisons from Q4 families.
 *
 * PROCESSING FLOW:
 *   Q4 canonical families
 *     → singletons: pass through without LLM call
 *     → multi-member families: deterministic aggregation
 *     → failed families: preserve originals with degraded status
 *     → final assembly
 *
 * TERMINAL OUTCOMES for every original candidate:
 *   retained_as_canonical_finding — primary representative of an issue
 *   merged_into_canonical_finding — absorbed into another finding
 *   excluded_with_reason          — explicitly excluded
 *   degraded_family_preserved     — family failed; originals preserved
 *
 * Persists:
 *   - Canonical findings at tree_level=94, node_index=0
 *   - Terminal outcome ledger at tree_level=93, node_index=0
 *
 * The before/after table is returned in the output.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  constructCanonicalFinding,
  type MemberOutcome,
  type CanonicalFinding,
} from "./canonical-finding-construction.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const BeforeAfterRowSchema = z.object({
  canonical_issue: z.string(),
  raw_candidate_count: z.number(),
  originating_claim_count: z.number(),
  evidence_record_count: z.number(),
  final_finding_count: z.number(),
  merged_from_count: z.number(),
  verification_status: z.string(),
});

export default api({
  name: "AssembleCanonicalFindings",
  description: "Q5: constructs one canonical finding per issue with all evidence; full lineage",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    total_input_candidates: z.number(),
    canonical_findings_count: z.number(),
    silent_losses: z.number(),
    terminal_outcome_counts: z.record(z.string(), z.number()),
    before_after_table: z.array(BeforeAfterRowSchema),
    canonical_findings_checkpoint_id: z.string(),
    terminal_ledger_checkpoint_id: z.string(),
  }),

  async run(ctx, { runId, moduleId }) {
    // 1. Load Q4 canonical identity mapping (tree_level=95)
    const CheckpointRow = z.object({ merged_json: z.any() });
    const q4Rows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 95 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      CheckpointRow,
      [runId],
      { label: "Load Q4 canonical identity mapping" }
    );

    if (q4Rows.length === 0) {
      throw new Error(`No Q4 canonical identity found for run ${runId}. Run ReplayCanonicalIdentity first.`);
    }

    const q4Parsed = typeof q4Rows[0].merged_json === "string"
      ? JSON.parse(q4Rows[0].merged_json)
      : q4Rows[0].merged_json;

    const q4Families = (q4Parsed.families ?? []) as Array<{
      canonical_key_str: string;
      canonical_key: any;
      member_count: number;
      member_finding_ids: string[];
      all_originating_claim_ids: string[];
      memo_versions: string[];
      merge_decision: string;
    }>;

    const totalInput = q4Families.reduce((sum, f) => sum + f.member_finding_ids.length, 0);

    // 2. Load findings corpus (tree_level=98) for full content
    const CorpusRow = z.object({ merged_json: z.any(), node_index: z.number() });
    const corpusRows = await ctx.integrations.db.query(
      `SELECT merged_json, node_index FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98
       ORDER BY node_index ASC`,
      CorpusRow,
      [runId],
      { label: "Load findings corpus" }
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

    // Load ledger for corpus_index
    const LedgerRow = z.object({ merged_json: z.any() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 97 AND node_index = 0
       ORDER BY updated_at DESC LIMIT 1`,
      LedgerRow,
      [runId],
      { label: "Load disposition ledger for corpus_index" }
    );
    const rawLedger = ledgerRows[0]?.merged_json;
    const ledgerParsed = rawLedger
      ? (typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger)
      : { ledger: [] };
    const ledgerEntries = (ledgerParsed.ledger || []) as Array<{
      finding_id: string;
      corpus_index: number;
      title: string;
    }>;
    const corpusIndexMap = new Map<string, number>();
    const corpusTitleMap = new Map<string, string>();
    for (const e of ledgerEntries) {
      corpusIndexMap.set(e.finding_id, e.corpus_index);
      corpusTitleMap.set(e.finding_id, e.title);
    }

    // 3. Load claims ledger
    const claimsRows = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'
       ORDER BY created_at DESC LIMIT 1`,
      z.object({ payload: z.any() }),
      [runId],
      { label: "Load claims ledger" }
    );
    const resolvedClaims = new Map<string, { claim_id: string; claim_text: string; memo_version: string | null; verdict: string }>();
    if (claimsRows.length > 0) {
      const claimsPayload = typeof claimsRows[0].payload === "string"
        ? JSON.parse(claimsRows[0].payload)
        : claimsRows[0].payload;
      for (const claim of claimsPayload?.claims ?? []) {
        const cid = claim.claim_id || claim.id;
        if (cid) {
          resolvedClaims.set(cid, {
            claim_id: cid,
            claim_text: claim.verbatim_snippet || claim.claim_text || "",
            memo_version: claim.memo_version ?? null,
            verdict: "contradicted", // Will be overridden by Q3 data
          });
        }
      }
    }

    // 4. Assemble canonical findings
    const allCanonicalFindings: CanonicalFinding[] = [];
    const allMemberOutcomes: MemberOutcome[] = [];
    const terminalOutcomeCounts: Record<string, number> = {};

    for (const family of q4Families) {
      // Build member finding list with full content
      const memberFindings = family.member_finding_ids.map(fid => {
        const f = findingsMap.get(fid) ?? {};
        return {
          finding_id: fid,
          corpus_index: corpusIndexMap.get(fid) ?? -1,
          title: corpusTitleMap.get(fid) ?? f.title ?? "UNKNOWN",
          detail: f.detail ?? f.evidence ?? null,
          full_analysis: f.full_analysis ?? null,
          severity: f.severity ?? null,
          source_tag: f.source_tag ?? null,
          source_docs: f.source_docs ?? null,
          originating_claim_id: f.originating_claim_id ?? null,
          claim_ids: f.claim_ids ?? null,
          claim_type: f.claim_type ?? null,
          finding_kind: f.finding_kind ?? null,
          issue_key: f.issue_key ?? null,
          evidence: f.evidence ?? null,
        };
      });

      try {
        const { finding, memberOutcomes } = constructCanonicalFinding(
          family.canonical_key_str,
          family.canonical_key,
          memberFindings,
          resolvedClaims
        );
        allCanonicalFindings.push(finding);
        allMemberOutcomes.push(...memberOutcomes);
      } catch (err) {
        // Degraded: preserve original candidates
        for (const member of memberFindings) {
          allMemberOutcomes.push({
            finding_id: member.finding_id,
            corpus_index: member.corpus_index,
            title: member.title,
            terminal_outcome: "degraded_family_preserved",
            canonical_finding_id: null,
            reason: `Family construction failed: ${String(err)}`,
          });
        }
      }
    }

    // Count terminal outcomes
    for (const outcome of allMemberOutcomes) {
      terminalOutcomeCounts[outcome.terminal_outcome] =
        (terminalOutcomeCounts[outcome.terminal_outcome] ?? 0) + 1;
    }

    // 5. Build before/after table
    const beforeAfterTable = allCanonicalFindings.map(cf => ({
      canonical_issue: cf.canonical_issue_key,
      raw_candidate_count: cf.merged_from_finding_ids.length,
      originating_claim_count: cf.originating_claim_ids.length,
      evidence_record_count: cf.evidence_records.length,
      final_finding_count: 1,
      merged_from_count: cf.merged_from_finding_ids.length,
      verification_status: cf.verification_status,
    }));

    // 6. Accounting
    const totalAccountedFor = allMemberOutcomes.length;
    const silentLosses = totalInput - totalAccountedFor;

    // 7. Persist canonical findings at tree_level=94
    const canonicalPayload = JSON.stringify({
      _assembly_metadata: {
        run_id: runId,
        module_id: moduleId,
        assembly_type: "Q5_canonical_findings",
        timestamp: new Date().toISOString(),
        total_input_candidates: totalInput,
        canonical_findings_count: allCanonicalFindings.length,
        silent_losses: silentLosses,
      },
      findings: allCanonicalFindings,
      before_after_table: beforeAfterTable,
    });

    const UpsertSchema = z.object({ id: z.string() });
    const [canonicalCheckpoint] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 94, 0, 'q5_canonical_findings', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'q5_canonical_findings', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, canonicalPayload],
      { label: "Persist canonical findings (tree_level=94)" }
    );

    // 8. Persist terminal outcome ledger at tree_level=93
    const terminalPayload = JSON.stringify({
      _ledger_metadata: {
        run_id: runId,
        module_id: moduleId,
        ledger_type: "Q5_terminal_outcomes",
        timestamp: new Date().toISOString(),
        total_entries: allMemberOutcomes.length,
        silent_losses: silentLosses,
      },
      terminal_outcome_counts: terminalOutcomeCounts,
      outcomes: allMemberOutcomes,
    });

    const [terminalCheckpoint] = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 93, 0, 'q5_terminal_ledger', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'q5_terminal_ledger', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, terminalPayload],
      { label: "Persist terminal outcome ledger (tree_level=93)" }
    );

    return {
      total_input_candidates: totalInput,
      canonical_findings_count: allCanonicalFindings.length,
      silent_losses: silentLosses,
      terminal_outcome_counts: terminalOutcomeCounts,
      before_after_table: beforeAfterTable,
      canonical_findings_checkpoint_id: canonicalCheckpoint.id,
      terminal_ledger_checkpoint_id: terminalCheckpoint.id,
    };
  },
});
