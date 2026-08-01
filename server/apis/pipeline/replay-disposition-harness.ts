/**
 * ReplayDispositionHarness — Q1 + Q2
 *
 * Loads the exported 273-finding L3 corpus from the tree_level=98 checkpoint
 * and applies disposition rules WITHOUT rerunning extraction.
 *
 * Every input finding receives exactly one disposition:
 *   - retained_as_contradiction_candidate
 *   - excluded_wrong_module
 *   - confirmed_claim
 *   - supporting_evidence
 *   - process_diagnostic
 *   - source_recommendation
 *   - scope_limitation
 *   - excluded_immaterial
 *   - excluded_unsupported
 *   - excluded_false_positive
 *   - merged_into
 *
 * Invariants:
 *   - 273 inputs accounted for
 *   - 0 silent losses
 *   - 0 conflicting dispositions
 *   - deterministic output
 *   - idempotent rerun
 *   - complete lineage
 *
 * The first replay applies source-scope and obvious output-type rules only.
 * Canonical identity and merge behavior are NOT changed in this pass.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
// Source-policy imports removed — all classification logic delegated to replay-classifier.ts
import {
  deriveSourceTag,
  classifyReplayFinding,
  isLegalDDSource,
} from "./replay-classifier.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Disposition types
// ---------------------------------------------------------------------------

export const DISPOSITION_TYPES = [
  "retained_as_contradiction_candidate",
  "excluded_wrong_module",
  "confirmed_claim",
  "supporting_evidence",
  "process_diagnostic",
  "source_recommendation",
  "scope_limitation",
  "excluded_immaterial",
  "excluded_unsupported",
  "excluded_false_positive",
  "merged_into",
  "not_linked_to_IC_claim",
  "merged_into_canonical_finding",
  "retained_as_canonical_finding",
  "excluded_with_reason",
] as const;

export type DispositionType = typeof DISPOSITION_TYPES[number];

export interface DispositionRecord {
  /** Index in the original 273-finding array (0-based) */
  corpus_index: number;
  /** Finding ID (if present) */
  finding_id: string | null;
  /** Title of the finding */
  title: string;
  /** Assigned disposition */
  disposition: DispositionType;
  /** Explanation of why this disposition was assigned */
  reason: string;
  /** Source document tag that generated this finding */
  source_tag: string | null;
  /** Original severity */
  severity: string | null;
  /** Category/type from the finding */
  category: string | null;
  /** Whether the finding traces to an IC claim */
  has_originating_claim: boolean;
  /** L3 node this came from */
  l3_node: number;
}

// ---------------------------------------------------------------------------
// Classification: uses shared replay-classifier.ts (single source of truth)
// No inline classification heuristics — all logic lives in replay-classifier.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API Definition
// ---------------------------------------------------------------------------

const DispositionRecordSchema = z.object({
  corpus_index: z.number(),
  finding_id: z.string().nullable(),
  title: z.string(),
  disposition: z.string(),
  reason: z.string(),
  source_tag: z.string().nullable(),
  severity: z.string().nullable(),
  category: z.string().nullable(),
  has_originating_claim: z.boolean(),
  l3_node: z.number(),
});

export default api({
  name: "ReplayDispositionHarness",
  description: "Replays 273 L3 findings through scope policy and classification rules.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("contradiction_check"),
  }),

  output: z.object({
    // Invariant checks
    total_inputs: z.number(),
    total_dispositions: z.number(),
    silent_losses: z.number(),
    conflicting_dispositions: z.number(),
    // Summary by class
    summary: z.record(z.string(), z.number()),
    // Detailed breakdown
    legal_dd_excluded_wrong_module: z.number(),
    legal_dd_retained_targeted: z.number(),
    process_diagnostics: z.number(),
    confirmed_claims: z.number(),
    supporting_evidence: z.number(),
    source_recommendations: z.number(),
    scope_limitations: z.number(),
    remaining_contradiction_candidates: z.number(),
    // Disposition ledger (first 50 for testApi display; full in DB)
    ledger_preview: z.array(DispositionRecordSchema),
    // Persistence
    ledger_checkpoint_id: z.string(),
  }),

  async run(ctx, { runId, moduleId }) {
    // Load the 273-finding corpus from tree_level=98 checkpoint
    const CheckpointSchema = z.object({
      merged_json: z.any(),
    });

    const [exportRow] = await ctx.integrations.ic_diligence_db.query(
      `SELECT merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98 AND node_index = 0
       LIMIT 1`,
      CheckpointSchema,
      [runId],
      { label: "Load L3 export corpus (tree_level=98)" }
    );

    if (!exportRow) {
      throw new Error(`No tree_level=98 export checkpoint found for run ${runId}. Run ConsolidateL3Export first.`);
    }

    const payload = typeof exportRow.merged_json === "string"
      ? JSON.parse(exportRow.merged_json)
      : exportRow.merged_json;

    const findings: any[] = Array.isArray(payload.findings) ? payload.findings : [];
    const totalInputs = findings.length;

    if (totalInputs === 0) {
      throw new Error("Export checkpoint contains 0 findings — corpus is empty.");
    }

    // -----------------------------------------------------------------------
    // Apply disposition rules to every finding
    // -----------------------------------------------------------------------
    const ledger: DispositionRecord[] = [];
    const dispositionCounts: Record<string, number> = {};
    let legalDDExcluded = 0;
    let legalDDRetained = 0;

    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i];

      // Extract metadata (NO MUTATION — pass context separately)
      const sourceDocs: string[] = Array.isArray(finding.source_docs) ? finding.source_docs : [];
      const sourceTag = deriveSourceTag(finding, sourceDocs);

      // Classify using shared pure function — does NOT mutate input
      const { disposition, reason } = classifyReplayFinding(finding, sourceTag);

      // Track Legal DD specifics
      if (sourceTag === "legal" || isLegalDDSource(sourceDocs)) {
        if (disposition === "excluded_wrong_module") {
          legalDDExcluded++;
        } else {
          legalDDRetained++;
        }
      }

      const record: DispositionRecord = {
        corpus_index: i,
        finding_id: finding.finding_id ?? finding.id ?? null,
        title: String(finding.title ?? `[untitled-${i}]`),
        disposition,
        reason,
        source_tag: sourceTag,
        severity: finding.severity ?? null,
        category: finding.category ?? null,
        has_originating_claim: !!(finding._originating_claim_id || finding.claim_id),
        l3_node: finding._l3_node_index ?? -1,
      };

      ledger.push(record);
      dispositionCounts[disposition] = (dispositionCounts[disposition] ?? 0) + 1;
    }

    // -----------------------------------------------------------------------
    // Invariant checks
    // -----------------------------------------------------------------------
    const silentLosses = totalInputs - ledger.length;
    // Check for conflicting dispositions (same finding_id with different dispositions)
    const idDispositions = new Map<string, Set<string>>();
    for (const r of ledger) {
      if (r.finding_id) {
        const existing = idDispositions.get(r.finding_id) ?? new Set();
        existing.add(r.disposition);
        idDispositions.set(r.finding_id, existing);
      }
    }
    let conflictingDispositions = 0;
    for (const [, dispositions] of idDispositions) {
      if (dispositions.size > 1) conflictingDispositions++;
    }

    // -----------------------------------------------------------------------
    // Persist full ledger to DB at tree_level=97, node_index=0
    // -----------------------------------------------------------------------
    const ledgerPayload = JSON.stringify({
      _replay_metadata: {
        run_id: runId,
        module_id: moduleId,
        replay_timestamp: new Date().toISOString(),
        total_inputs: totalInputs,
        total_dispositions: ledger.length,
        silent_losses: silentLosses,
        conflicting_dispositions: conflictingDispositions,
        source_policy_version: "Q0",
        classification_version: "Q2",
      },
      summary: dispositionCounts,
      ledger,
    });

    const UpsertSchema = z.object({ id: z.string() });
    const [persisted] = await ctx.integrations.ic_diligence_db.query(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, status, merged_json, updated_at)
       VALUES ($1, 97, 0, 'replay_disposition', $2::jsonb, now())
       ON CONFLICT (module_run_id, tree_level, node_index)
       DO UPDATE SET merged_json = $2::jsonb, status = 'replay_disposition', updated_at = now()
       RETURNING id`,
      UpsertSchema,
      [runId, ledgerPayload],
      { label: "Persist disposition ledger (tree_level=97)" }
    );

    return {
      total_inputs: totalInputs,
      total_dispositions: ledger.length,
      silent_losses: silentLosses,
      conflicting_dispositions: conflictingDispositions,
      summary: dispositionCounts,
      legal_dd_excluded_wrong_module: legalDDExcluded,
      legal_dd_retained_targeted: legalDDRetained,
      process_diagnostics: dispositionCounts["process_diagnostic"] ?? 0,
      confirmed_claims: dispositionCounts["confirmed_claim"] ?? 0,
      supporting_evidence: dispositionCounts["supporting_evidence"] ?? 0,
      source_recommendations: dispositionCounts["source_recommendation"] ?? 0,
      scope_limitations: dispositionCounts["scope_limitation"] ?? 0,
      remaining_contradiction_candidates: dispositionCounts["retained_as_contradiction_candidate"] ?? 0,
      ledger_preview: ledger.slice(0, 50),
      ledger_checkpoint_id: persisted.id,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers — all classification and document-type detection functions are
// imported from replay-classifier.ts (single source of truth).
// No local duplicates maintained.
// ---------------------------------------------------------------------------
