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
import {
  EXCLUDED_SOURCES,
  NARRATIVE_SOURCES,
  EVIDENCE_SOURCES,
  isFindingInScope,
  isTargetedVerificationEligible,
  TARGETED_VERIFICATION_CLAIM_TYPES,
} from "./source-policy.js";

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
// Classification heuristics (Q2 logic applied inline)
// ---------------------------------------------------------------------------

/**
 * Process diagnostic indicators — findings about pipeline/extraction failures,
 * missing documents, truncation, or scope limitations of the analysis itself.
 */
const PROCESS_DIAGNOSTIC_PATTERNS = [
  /text\s+truncat/i,
  /extraction?\s+(fail|error|unable)/i,
  /cannot\s+(be\s+)?assessed/i,
  /not\s+extracted/i,
  /analysis\s+cannot\s+proceed/i,
  /missing\s+(ic\s+)?memo\s+record/i,
  /substantive\s+analysis\s+section\s+not\s+extracted/i,
  /critical\s+gap.*text\s+truncation/i,
  /unable\s+to\s+(fully\s+)?assess/i,
  /insufficient\s+data\s+to\s+assess/i,
  /no\s+(relevant\s+)?data\s+available/i,
];

/**
 * Confirmed-claim indicators — findings that explicitly confirm or support
 * an IC narrative position (positive confirmation).
 */
const CONFIRMED_CLAIM_PATTERNS = [
  /\bconfirm(ed|s)?\b.*\b(in\s+place|compliance|ownership|aligned)\b/i,
  /\bprotective\s+documentation\s+in\s+place\b/i,
  /\bverified\b.*\bconsistent\b/i,
  /\bsubstantiat(ed|es)\b.*\bclaim\b/i,
  /\bdiversified\b.*\bportfolio\b/i,
  /\bcompliance\s+confirmed\b/i,
  /\bip\s+ownership\b.*\bin\s+place\b/i,
];

/**
 * Source recommendation / advisory indicators — generic diligence
 * recommendations or advisory observations from source documents.
 */
const SOURCE_RECOMMENDATION_PATTERNS = [
  /\brecommend(ation|ed|s)?\b/i,
  /\bshould\s+(be\s+)?(reviewed|addressed|assessed|considered)\b/i,
  /\badvisory\b/i,
  /\brequires?\s+(further\s+)?(review|diligence|assessment)\b/i,
];

/**
 * Scope limitation indicators — findings that acknowledge the analysis
 * couldn't cover something due to scope constraints.
 */
const SCOPE_LIMITATION_PATTERNS = [
  /\bscope\s+(of\s+)?this\s+(analysis|review|module)\b/i,
  /\boutside\s+(the\s+)?scope\b/i,
  /\bbeyond\s+(the\s+)?remit\b/i,
  /\bnot\s+within\s+(the\s+)?scope\b/i,
];

/**
 * Wrong-module indicators specific to Legal DD content that shouldn't
 * be in contradiction_check at all.
 */
const LEGAL_DD_CONTENT_PATTERNS = [
  /\blease\b.*\b(terms?|clause|provision|expir)/i,
  /\bpension\b.*\b(compliance|scheme|obligation)/i,
  /\bMSA\b.*\b(portfolio|contract)/i,
  /\bchange.of.control\b.*\b(clause|provision|trigger)/i,
  /\btermination\b.*\b(clause|provision|right|event)/i,
  /\bindemnit(y|ies)\b/i,
  /\bwarranties?\b.*\b(breach|limit|cap)/i,
  /\breinstatement\b.*\b(framework|obligation)/i,
  /\bregulatory\s+(compliance|framework|obligation)\b/i,
  /\blegal\s+dd\s+report\b/i,
];

/**
 * Determine the disposition of a single finding based on source policy
 * and output-type heuristics.
 */
function classifyFinding(finding: any): { disposition: DispositionType; reason: string } {
  const title = String(finding.title ?? "").trim();
  const detail = String(finding.detail ?? finding.full_analysis ?? "").trim();
  const severity = String(finding.severity ?? "").toLowerCase();
  const category = String(finding.category ?? "").toLowerCase();
  const sourceDocs: string[] = Array.isArray(finding.source_docs) ? finding.source_docs : [];
  const fullText = `${title} ${detail}`;

  // Determine source tag from finding metadata
  const sourceTag = finding._source_tag ?? finding.source_tag ?? null;

  // -----------------------------------------------------------------------
  // Rule 1: Source policy — findings from excluded sources without IC claim
  // -----------------------------------------------------------------------
  if (sourceTag && EXCLUDED_SOURCES.has(sourceTag as any)) {
    // Check if this might be a targeted verification
    if (finding._originating_claim_id || finding.claim_id) {
      const claimType = finding._claim_type ?? finding.claim_type;
      if (claimType && TARGETED_VERIFICATION_CLAIM_TYPES.includes(claimType as any)) {
        // Retain through targeted path — but still classify the output type
      } else {
        return { disposition: "excluded_wrong_module", reason: `Legal DD finding without qualifying targeted claim type (has '${claimType ?? "none"}')` };
      }
    } else {
      return { disposition: "excluded_wrong_module", reason: "Legal DD finding with no originating IC claim — excluded by source policy" };
    }
  }

  // Heuristic: detect Legal DD content even if source_tag wasn't set
  const legalDocs = sourceDocs.filter(d =>
    /legal\s*dd/i.test(d) || /legal\s+due\s+diligence/i.test(d) || /legal\s+report/i.test(d)
  );
  const hasOnlyLegalSource = legalDocs.length > 0 && legalDocs.length === sourceDocs.length;
  const hasLegalSource = legalDocs.length > 0;

  if (hasOnlyLegalSource && !finding._originating_claim_id && !finding.claim_id) {
    // Pure Legal DD finding with no IC claim anchor
    if (LEGAL_DD_CONTENT_PATTERNS.some(p => p.test(fullText))) {
      return { disposition: "excluded_wrong_module", reason: "Legal DD content pattern detected with no IC claim anchor — wrong module" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 2: Process diagnostics — extraction/analysis failures
  // -----------------------------------------------------------------------
  if (PROCESS_DIAGNOSTIC_PATTERNS.some(p => p.test(fullText))) {
    return { disposition: "process_diagnostic", reason: "Finding describes an extraction failure, missing document, or analysis scope limitation" };
  }

  // -----------------------------------------------------------------------
  // Rule 3: Confirmed claims — positive confirmations of IC narrative
  // -----------------------------------------------------------------------
  if (CONFIRMED_CLAIM_PATTERNS.some(p => p.test(fullText)) && severity === "info") {
    return { disposition: "confirmed_claim", reason: "Finding confirms an IC claim is supported by evidence (positive confirmation)" };
  }

  // -----------------------------------------------------------------------
  // Rule 4: Legal DD content as wrong_module (broader detection)
  // -----------------------------------------------------------------------
  if (hasLegalSource && LEGAL_DD_CONTENT_PATTERNS.some(p => p.test(fullText))) {
    if (!finding._originating_claim_id && !finding.claim_id) {
      return { disposition: "excluded_wrong_module", reason: "Legal DD content (lease, pension, MSA, termination) without IC claim — belongs in legal_diligence_review module" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 5: Scope limitations
  // -----------------------------------------------------------------------
  if (SCOPE_LIMITATION_PATTERNS.some(p => p.test(fullText))) {
    return { disposition: "scope_limitation", reason: "Finding describes a scope limitation of the analysis" };
  }

  // -----------------------------------------------------------------------
  // Rule 6: Source recommendations (advisory, not contradictions)
  // -----------------------------------------------------------------------
  if (SOURCE_RECOMMENDATION_PATTERNS.some(p => p.test(fullText)) && severity !== "critical") {
    // Only classify as recommendation if it's not describing an actual data conflict
    const hasDataConflict = /\b(contradict|conflict|discrepanc|inconsisten|diverge|shortfall|gap\s+between)\b/i.test(fullText);
    if (!hasDataConflict) {
      return { disposition: "source_recommendation", reason: "Finding is a diligence recommendation or advisory observation, not a narrative-vs-data contradiction" };
    }
  }

  // -----------------------------------------------------------------------
  // Rule 7: Supporting evidence (additional passages for existing issues)
  // -----------------------------------------------------------------------
  if (category === "housekeeping" || category === "supporting" || severity === "info") {
    const isSubstantive = /\b(contradict|conflict|discrepanc|inconsisten|diverge|shortfall|weak|unsupport)\b/i.test(fullText);
    if (!isSubstantive) {
      return { disposition: "supporting_evidence", reason: "Info-level finding without substantive contradiction — classifies as supporting evidence" };
    }
  }

  // -----------------------------------------------------------------------
  // Default: retained as contradiction candidate
  // -----------------------------------------------------------------------
  return { disposition: "retained_as_contradiction_candidate", reason: "Finding describes a narrative-vs-evidence conflict or unsupported IC claim — within contradiction-check scope" };
}

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

      // Extract metadata
      const sourceDocs: string[] = Array.isArray(finding.source_docs) ? finding.source_docs : [];
      const sourceTag = deriveSourceTag(finding, sourceDocs);

      // Annotate finding with derived source tag for classification
      finding._source_tag = sourceTag;

      const { disposition, reason } = classifyFinding(finding);

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
// Helpers
// ---------------------------------------------------------------------------

function deriveSourceTag(finding: any, sourceDocs: string[]): string | null {
  // Use explicit tag if present
  if (finding.source_tag) return finding.source_tag;
  if (finding._source_tag) return finding._source_tag;

  // Derive from source_docs filenames
  if (sourceDocs.length === 0) return null;

  const allLegal = sourceDocs.every(d => isLegalDocument(d));
  if (allLegal) return "legal";

  const allIC = sourceDocs.every(d => isICDocument(d));
  if (allIC) return "ic_memo";

  const allFinancial = sourceDocs.every(d => isFinancialDocument(d));
  if (allFinancial) return "financial_model";

  const allConsultant = sourceDocs.every(d => isConsultantDocument(d));
  if (allConsultant) return "consultant_report";

  // Mixed sources — take primary (first doc)
  if (isLegalDocument(sourceDocs[0])) return "legal";
  if (isICDocument(sourceDocs[0])) return "ic_memo";
  if (isFinancialDocument(sourceDocs[0])) return "financial_model";
  if (isConsultantDocument(sourceDocs[0])) return "consultant_report";

  return "other";
}

function isLegalDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /legal\s*(dd|due\s*diligence|report)/i.test(lower) ||
    /^legal/i.test(lower) ||
    lower.includes("legal dd");
}

function isICDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /ic\s*memo/i.test(lower) ||
    /screening\s*memo/i.test(lower) ||
    /investment\s*committee/i.test(lower) ||
    lower.includes("ic memo") ||
    lower.includes("ic update");
}

function isFinancialDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /financial\s*model/i.test(lower) ||
    /model.*\.xlsx?$/i.test(lower) ||
    lower.includes("lbo model") ||
    lower.includes("operating model");
}

function isConsultantDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /vendor\s*(f|financial)\s*(dd|due\s*diligence)/i.test(lower) ||
    /commercial\s*(dd|due\s*diligence)/i.test(lower) ||
    /quality\s*of\s*earnings/i.test(lower) ||
    /qoe/i.test(lower) ||
    lower.includes("fdd") ||
    lower.includes("cdd");
}

function isLegalDDSource(sourceDocs: string[]): boolean {
  return sourceDocs.some(d => isLegalDocument(d));
}
