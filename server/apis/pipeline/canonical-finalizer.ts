/**
 * MAT-F06 — Canonical Finalizer
 *
 * THE ONE authoritative finalization function. All execution paths (main, fast,
 * retry, resume, FinalizePipelineOutput) must call this. No path may independently
 * format, persist, or mark completion.
 *
 * Sequence (enforced by this function):
 *   1. Validate prerequisites (claim ledger, evidence-admission, comparisons, findings)
 *   2. Apply F05 narrative enforcement
 *   3. Build CanonicalFinalArtifact (reportable finding set, diagnostics)
 *   4. Format report from reportable findings only (§F filter)
 *   5. Compute semantic hash (stable, insertion-order-insensitive)
 *   6. Persist artifact once (idempotent guard — same hash → no-op)
 *   7. Verify persistence succeeded
 *   8. Mark run completed with semantic hash
 *
 * INVARIANTS:
 * - run is never marked completed before final artifact is durably written (§C)
 * - a retry with identical content is a no-op (§C idempotency)
 * - a retry with different content against a completed run returns REJECTED (§C)
 * - non-reportable items (unlinked, housekeeping, process, degraded) never enter
 *   the substantive report markdown (§F)
 * - F05 validation diagnostics are always persisted with the artifact (§G)
 */

import { z } from "@superblocksteam/sdk-api";
import { parseCanonicalFindings } from "./canonical-finding.js";
import { enforceNarrativeBoundary } from "./narrative-enforcement.js";
import type { CanonicalFindingRecord } from "./canonical-finding-record.js";
import {
  computeSemanticHash,
  buildSemanticHashInput,
  CANONICAL_FINAL_ARTIFACT_VERSION,
  SEMANTIC_HASH_VERSION,
  type CanonicalFinalArtifact,
  type ExcludedFinding,
  type NarrativeDiagnostic,
  type CheckpointStatusEntry,
} from "./canonical-final-artifact.js";
import {
  runPublicationGate,
  toCompactDiagnostic,
  type CompactCompletionDiagnostic,
} from "./tree-completion-validator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalizerPrerequisites {
  /** canonical findings from the final merge checkpoint */
  findings: unknown[];
  /** executive header from the final merge checkpoint */
  executiveHeader: string;
  /** module type (contradiction_check, model_assumptions_stress, etc.) */
  moduleType: string;
  /** canonical record map from Q3 checkpoint (claim_id → CanonicalFindingRecord) */
  canonicalRecordMap?: Map<string, CanonicalFindingRecord>;
  /**
   * Prerequisite checkpoint states. Each must be present:true for contradiction_check.
   * Other modules may omit ledgers they don't produce.
   */
  checkpointStatus: CheckpointStatusEntry[];
  /** Whether claims were degraded (permanent failure) — triggers disclosure section */
  claimsDegraded?: boolean;
  /** Extra degraded conditions to persist as diagnostics */
  degradedConditions?: string[];
  /**
   * @deprecated Ignored since MAT-F06 §1. Report is always rebuilt from
   * canonical reportable records. Kept for call-site backward compatibility.
   */
  preFormattedReport?: string;
  /**
   * Proposed final node — the merge checkpoint that produced the findings.
   * REQUIRED for the publication gate. If omitted, gate will attempt to
   * auto-detect from the highest complete checkpoint.
   */
  proposedFinalNode?: {
    treeLevel: number;
    nodeIndex: number;
  };
  /**
   * If true, skip the publication gate. ONLY for administrative recovery
   * operations that explicitly re-build the tree to completion first.
   * This flag is audited in logs.
   */
  bypassPublicationGate?: boolean;
  /**
   * If true, evidence_admission is not required as a prerequisite.
   * Set for natural-merge-tree runs that never produce P2.1 reconstruction
   * artifacts (tree_level=97/98/99) and therefore cannot have evidence_admission.
   */
  skipEvidenceAdmission?: boolean;
}

export type FinalizerOutcome =
  | { status: "completed"; artifactId: string; semanticHash: string; findingCount: number; artifact: CanonicalFinalArtifact }
  | { status: "idempotent"; artifactId: string; semanticHash: string; message: string }
  | { status: "rejected_overwrite"; existingHash: string; newHash: string; message: string }
  | { status: "prerequisites_missing"; missingKeys: string[]; message: string }
  | { status: "persist_failed"; error: string }
  | { status: "already_completed" }
  | { status: "publication_blocked"; diagnostic: CompactCompletionDiagnostic; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// Required prerequisites per module type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys that MUST be present:true in checkpointStatus for a credible contradiction audit.
 * These correspond to actual pipeline_checkpoints.checkpoint_key values written by pipeline-core.ts,
 * plus synthetic keys derived from structured payload validation.
 * - claims_ledger: canonical claims extracted from IC memos
 * - evidence_admission: F02B evidence admission ledger (stored inside Q3 merge checkpoint)
 * - reconciliation: claims reconciled against operating model evidence (verdict/comparisons)
 * - canonical_findings: synthetic entry derived from findings.length > 0 (checked in caller)
 */
const REQUIRED_CHECKPOINTS_CONTRADICTION: string[] = [
  "claims_ledger",
  "evidence_admission",
  "reconciliation",
  "canonical_findings",
];

/** Modules that require claims/reconciliation checkpoints */
const CLAIMS_REQUIRED_MODULES = new Set(["contradiction_check"]);

// ─────────────────────────────────────────────────────────────────────────────
// §F — Non-reportable item patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a finding should be excluded from the substantive report.
 * Returns the exclusion_reason if it should be excluded, null if it should be included.
 */
export function getReportExclusionReason(finding: any): ExcludedFinding["exclusion_reason"] | null {
  const title: string = (finding.title ?? "").toLowerCase();
  const detail: string = (finding.detail ?? "").toLowerCase();
  const findingKind: string = (finding.finding_kind ?? "").toLowerCase();
  const severity: string = (finding.severity ?? "").toLowerCase();

  // Process/housekeeping objects
  if (
    title.includes("analysis complete") ||
    title.includes("no findings") ||
    title.includes("processing") ||
    title.includes("[process]") ||
    findingKind === "process" ||
    findingKind === "housekeeping"
  ) {
    return "process_object";
  }

  // Housekeeping
  if (
    title.includes("housekeeping") ||
    title.includes("[housekeeping]") ||
    findingKind === "housekeeping_appendix"
  ) {
    return "housekeeping";
  }

  // Placeholders
  if (
    title.startsWith("no ") && (title.includes("finding") || title.includes("issue")) ||
    title === "no issues identified" ||
    title === "no findings identified" ||
    detail.includes("no issues were identified") ||
    detail.includes("no findings were identified")
  ) {
    return "placeholder";
  }

  // Degraded notices
  if (
    title.includes("degraded") ||
    title.includes("[degraded]") ||
    title.includes("[unlinked]") ||
    findingKind === "degraded_run_notice"
  ) {
    return title.includes("[unlinked]") ? "unlinked" : "degraded_notice";
  }

  // Unverifiable non-reportable
  if (severity === "info" && (finding._f05_excluded || finding._no_canonical_record)) {
    return "unlinked";
  }

  return null;
}

/**
 * Human-readable reason string per §F exclusion_reason.
 *
 * `getReportExclusionReason` returns only the enum tag, which tells you a
 * finding was excluded but not what tripped. These strings are what get written
 * to the suppression audit trail so a reader can see the cause without having
 * to reverse-engineer the filter.
 */
export const FINALIZER_EXCLUSION_REASON_TEXT: Record<ExcludedFinding["exclusion_reason"], string> = {
  process_object: "Process/status object, not a substantive finding (title or finding_kind matched the process/housekeeping filter)",
  housekeeping: "Housekeeping appendix item — recorded but not IC-facing",
  placeholder: "Placeholder 'no findings/issues identified' object",
  degraded_notice: "Degraded-run notice — reported in the disclosure section, not as a finding",
  unlinked: "No canonical claim/evidence link — cannot be substantiated in the report",
  no_canonical_record: "No canonical finding record exists for this finding_id",
  invalid_evidence: "Evidence payload failed validation",
  incompatible_comparison: "Comparison operands are not compatible (units, basis, or period)",
  reduction_gate: "Suppressed upstream by the finding reduction gate — see gate_name/reason",
};

// ─────────────────────────────────────────────────────────────────────────────
// Suppression audit trail (module_run_diagnostics)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of one entry in the `finding_reduction_gate` pipeline checkpoint's
 * suppressedLedger, as written by post-merge-finalization.
 */
interface PersistedGateDisposition {
  findingId?: string;
  title?: string;
  tier?: string;
  suppressionReason?: string;
  gates?: Array<{ passed?: boolean; gate?: string; reason?: string }>;
}

/**
 * Read the reduction-gate suppression ledger for a run and convert it into
 * ExcludedFinding entries carrying gate attribution.
 *
 * The gate ledger already exists in `pipeline_checkpoints` under key
 * `finding_reduction_gate`, but `pipeline_checkpoints` is purgeable. Reading it
 * here and copying the attribution into the permanent side table is what makes
 * "which gate dropped this, and why" survive a checkpoint purge.
 *
 * Reads the checkpoint rather than taking the ledger as a parameter so every
 * finalization path (main, fast, retry, resume, admin re-finalize) gets the
 * same attribution without new plumbing — including resumed runs where the gate
 * was restored from checkpoint and never re-executed in this process.
 */
async function loadGateLayerExclusions(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<{ entries: ExcludedFinding[]; gateStats: unknown; groundTruthSignals: unknown }> {
  try {
    const rows = await db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'finding_reduction_gate'
       LIMIT 1`,
      z.object({ payload: z.any().nullable() }),
      [runId],
      { label: "canonicalFinalize: load reduction gate ledger for audit trail" },
    );
    if (rows.length === 0 || !rows[0].payload) {
      return { entries: [], gateStats: null, groundTruthSignals: null };
    }
    const payload = rows[0].payload as Record<string, unknown>;
    const ledger = Array.isArray(payload.suppressedLedger)
      ? (payload.suppressedLedger as PersistedGateDisposition[])
      : [];

    const entries: ExcludedFinding[] = ledger.map((d) => {
      const failed = (d.gates ?? []).filter((g) => g && g.passed === false);
      const first = failed[0];
      return {
        finding_id: d.findingId ?? "unknown",
        title: d.title ?? "",
        exclusion_reason: "reduction_gate",
        exclusion_layer: "reduction_gate",
        // First gate that rejected it. When several rejected it, the rest go in
        // also_failed_gates — a finding dropped by three gates independently is
        // a different signal than one dropped by a single rule.
        gate_name: first?.gate ?? "unknown_gate",
        reason: first?.reason ?? d.suppressionReason ?? "No reason recorded by gate",
        also_failed_gates: failed.slice(1).map((g) => g.gate ?? "unknown_gate"),
        tier: (d.tier as ExcludedFinding["tier"]) ?? "suppressed",
      };
    });

    return {
      entries,
      gateStats: payload.gateStats ?? null,
      groundTruthSignals: payload.groundTruthSignals ?? null,
    };
  } catch (e: any) {
    console.warn(`[canonicalFinalize][audit] Gate ledger read failed (non-fatal): ${e?.message}`);
    return { entries: [], gateStats: null, groundTruthSignals: null };
  }
}

/**
 * Read the qualifier-mismatch skip diagnostics from the numeric checkpoint.
 *
 * These are suppressed *comparisons*, not suppressed findings — no finding is
 * ever constructed for a forecast-vs-actual pair, so it cannot appear in an
 * exclusion ledger. The count and samples are recorded in the summary so the
 * loss of coverage is visible instead of silent.
 */
async function loadQualifierSkipDiagnostics(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<{ skipped: number | null; samples: string[] } | null> {
  try {
    const rows = await db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'
       LIMIT 1`,
      z.object({ payload: z.any().nullable() }),
      [runId],
      { label: "canonicalFinalize: load numeric checkpoint for qualifier-skip audit" },
    );
    const debug = (rows[0]?.payload as any)?.crossAgreementDebug;
    if (!debug) return null;
    const skipped = typeof debug.qualifierMismatchSkipped === "number"
      ? debug.qualifierMismatchSkipped
      : null;
    const samples = Array.isArray(debug.qualifierMismatchSamples)
      ? (debug.qualifierMismatchSamples as unknown[]).map(String)
      : [];
    if (skipped === null && samples.length === 0) return null;
    return { skipped, samples };
  } catch (e: any) {
    console.warn(`[canonicalFinalize][audit] Qualifier-skip read failed (non-fatal): ${e?.message}`);
    return null;
  }
}

/**
 * Persist the suppression audit trail for a run to `module_run_diagnostics`.
 *
 * WHY THIS EXISTS: `excluded_findings` and `degraded_conditions` were computed
 * at finalization and discarded. `module_outputs` has six fixed columns and
 * cannot be altered, and overloading its `findings` column would make every
 * downstream reader of that column start seeing suppressed findings. So the
 * audit trail goes to a side table keyed on module_run_id (the module_run_flags
 * pattern), and `findings` stays the reportable set.
 *
 * Non-fatal by design: a failure here must never block a run from completing
 * with a durable report. It is logged loudly instead.
 */
async function persistRunDiagnostics(
  db: {
    query: (...args: any[]) => Promise<any[]>;
    execute: (...args: any[]) => Promise<unknown>;
  },
  runId: string,
  finalizerExclusions: ExcludedFinding[],
  degradedConditions: string[],
  reportableCount: number,
): Promise<{ written: boolean; totalExcluded: number; error?: string }> {
  const gateLayer = await loadGateLayerExclusions(db, runId);
  const qualifierSkips = await loadQualifierSkipDiagnostics(db, runId);

  // Order: gate layer first (it runs first chronologically), then the
  // finalizer's report filter. A finding can only appear in one — the gate
  // removes it before the finalizer ever sees it.
  const allExclusions: ExcludedFinding[] = [...gateLayer.entries, ...finalizerExclusions];

  const byGate: Record<string, number> = {};
  for (const e of allExclusions) {
    const key = `${e.exclusion_layer ?? "unknown_layer"}:${e.gate_name ?? e.exclusion_reason}`;
    byGate[key] = (byGate[key] ?? 0) + 1;
  }

  const summary = {
    reportable_count: reportableCount,
    excluded_total: allExclusions.length,
    excluded_by_layer: {
      reduction_gate: gateLayer.entries.length,
      finalizer_report_filter: finalizerExclusions.length,
    },
    excluded_by_gate: byGate,
    gate_stats: gateLayer.gateStats,
    ground_truth_signals: gateLayer.groundTruthSignals,
    // Suppressed comparisons, not suppressed findings — see loadQualifierSkipDiagnostics.
    qualifier_mismatch_skips: qualifierSkips,
    recorded_at: new Date().toISOString(),
  };

  try {
    await db.execute(
      `INSERT INTO module_run_diagnostics
         (module_run_id, excluded_findings, degraded_conditions, suppression_summary)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
       ON CONFLICT (module_run_id) DO UPDATE
         SET excluded_findings   = EXCLUDED.excluded_findings,
             degraded_conditions = EXCLUDED.degraded_conditions,
             suppression_summary = EXCLUDED.suppression_summary,
             updated_at          = now()`,
      [
        runId,
        JSON.stringify(allExclusions),
        JSON.stringify(degradedConditions),
        JSON.stringify(summary),
      ],
      { label: "canonicalFinalize: persist suppression audit trail" },
    );
    console.log(
      `[canonicalFinalize][audit] Persisted suppression trail — ` +
      `excluded=${allExclusions.length} ` +
      `(gate=${gateLayer.entries.length}, report_filter=${finalizerExclusions.length}), ` +
      `degraded_conditions=${degradedConditions.length}, ` +
      `qualifier_skips=${qualifierSkips?.skipped ?? "n/a"}`
    );
    return { written: true, totalExcluded: allExclusions.length };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // Loud but non-fatal. A missing audit row is a diagnostics gap; refusing to
    // complete a run that has a durable report would be worse.
    console.error(
      `[canonicalFinalize][audit] FAILED to persist suppression trail for run ${runId}: ${msg}. ` +
      `Run 'RunMigration030' if module_run_diagnostics does not exist.`
    );
    return { written: false, totalExcluded: allExclusions.length, error: msg };
  }
}

/**
 * Read back the persisted suppression audit trail for a run.
 * Used by the rehydration path so a rebuilt artifact carries real diagnostics
 * instead of an empty array.
 */
export async function loadRunDiagnostics(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<{ excludedFindings: ExcludedFinding[]; degradedConditions: string[] } | null> {
  try {
    const rows = await db.query(
      `SELECT excluded_findings, degraded_conditions
       FROM module_run_diagnostics
       WHERE module_run_id = $1
       LIMIT 1`,
      z.object({
        excluded_findings: z.any().nullable(),
        degraded_conditions: z.any().nullable(),
      }),
      [runId],
      { label: "Load persisted suppression audit trail" },
    );
    if (rows.length === 0) return null;
    return {
      excludedFindings: Array.isArray(rows[0].excluded_findings)
        ? (rows[0].excluded_findings as ExcludedFinding[])
        : [],
      degradedConditions: Array.isArray(rows[0].degraded_conditions)
        ? (rows[0].degraded_conditions as unknown[]).map(String)
        : [],
    };
  } catch {
    // Table may not exist yet on an environment that has not run migration 030.
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Executive header synthesis (Item 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the executive header deterministically from the FINAL reportable
 * finding set.
 *
 * WHY: the LLM-authored `executive_header` is extracted from the merge tree
 * BEFORE the reduction gate runs. The gate then drops findings, so the stored
 * header routinely names risks that have no corresponding finding in the same
 * artifact — which reads as fabrication and is the first thing a reader checks.
 *
 * INVARIANT: every risk named in the returned header is derived from an element
 * of `reportableFindings`, so header↔finding correspondence is structural, not
 * a validation step that can drift.
 *
 * Returns null when there is nothing to synthesize from (caller keeps its
 * existing human-readable fallback).
 */
export function synthesizeExecutiveHeader(reportableFindings: any[]): string | null {
  if (!Array.isArray(reportableFindings) || reportableFindings.length === 0) {
    return null;
  }

  const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const rankOf = (f: any) => SEVERITY_RANK[String(f?.severity ?? "info")] ?? 2;

  const ordered = [...reportableFindings].sort((a, b) => {
    const d = rankOf(a) - rankOf(b);
    if (d !== 0) return d;
    return String(a?.title ?? "").localeCompare(String(b?.title ?? ""));
  });

  const counts = { critical: 0, warning: 0, info: 0 } as Record<string, number>;
  for (const f of ordered) {
    const sev = String(f?.severity ?? "info");
    if (sev in counts) counts[sev] += 1;
    else counts.info += 1;
  }

  const total = ordered.length;
  const mixParts: string[] = [];
  if (counts.critical > 0) mixParts.push(`${counts.critical} critical`);
  if (counts.warning > 0) mixParts.push(`${counts.warning} warning`);
  if (counts.info > 0) mixParts.push(`${counts.info} informational`);

  const lines: string[] = [];
  lines.push(
    `This review surfaced ${total} reportable finding${total !== 1 ? "s" : ""}` +
    (mixParts.length > 0 ? ` (${mixParts.join(", ")}).` : ".")
  );
  lines.push("");

  for (const f of ordered) {
    const title = String(f?.title ?? "").trim() || "Untitled finding";
    const sev = String(f?.severity ?? "info");

    // Prefer the severity anchor (the £/x figure justifying the rating); fall
    // back to the first sentence of detail. Never invent language.
    let anchor = typeof f?.severity_anchor === "string" ? f.severity_anchor.trim() : "";
    if (!anchor && typeof f?.detail === "string") {
      const firstSentence = f.detail.trim().split(/(?<=[.!?])\s/)[0] ?? "";
      anchor = firstSentence.length > 220 ? `${firstSentence.slice(0, 217)}...` : firstSentence;
    }
    anchor = anchor.replace(/\s+/g, " ").trim();

    lines.push(`- **${title}** (${sev})${anchor ? ` — ${anchor}` : ""}`);
  }

  lines.push("");
  lines.push(
    "Each item above corresponds to a numbered finding in this report. " +
    "No risk is named here that is not evidenced below."
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Source document resolution (Item 3b)
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_DOC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Replace raw document UUIDs in `source_docs` with human-readable filenames.
 *
 * WHY: findings produced on the numeric-verification path carry
 * `"<documentId>::<sheetName>"` in `source_docs` (built in numeric-verify-inline
 * from table provenance), while findings produced on the claims path are
 * resolved upstream via `resolveProvenance`. The result is inconsistent output
 * where some findings cite a filename and others leak a UUID.
 *
 * Mutates the findings in place. Non-fatal: any unresolved UUID is left exactly
 * as-is rather than replaced with a guess.
 */
export async function resolveSourceDocFilenames(
  db: { query: (...args: any[]) => Promise<any[]> },
  dealId: string,
  findings: any[]
): Promise<{ resolved: number; unresolved: number }> {
  const docIds = new Set<string>();
  for (const f of findings) {
    const docs = Array.isArray(f?.source_docs) ? f.source_docs : [];
    for (const sd of docs) {
      if (typeof sd !== "string") continue;
      const m = sd.match(SOURCE_DOC_UUID_PATTERN);
      if (m) docIds.add(m[0].toLowerCase());
    }
  }

  if (docIds.size === 0) return { resolved: 0, unresolved: 0 };

  const nameById = new Map<string, string>();
  try {
    const rows = await db.query(
      `SELECT id, file_name
         FROM documents
        WHERE deal_id = $1 AND id = ANY($2::uuid[])
        LIMIT 500`,
      z.object({ id: z.string(), file_name: z.string().nullable() }),
      [dealId, Array.from(docIds)],
      { label: "canonicalFinalize: resolve source doc UUIDs" }
    );
    for (const row of rows) {
      if (row?.id && row?.file_name) nameById.set(String(row.id).toLowerCase(), row.file_name);
    }
  } catch (err: any) {
    console.warn(
      `[canonicalFinalize] source_docs UUID resolution failed (non-fatal): ${err?.message ?? err}`
    );
    return { resolved: 0, unresolved: docIds.size };
  }

  let resolved = 0;
  let unresolved = 0;

  for (const f of findings) {
    if (!Array.isArray(f?.source_docs)) continue;
    f.source_docs = f.source_docs.map((sd: unknown) => {
      if (typeof sd !== "string") return sd;
      const m = sd.match(SOURCE_DOC_UUID_PATTERN);
      if (!m) return sd;
      const fileName = nameById.get(m[0].toLowerCase());
      if (!fileName) {
        unresolved += 1;
        return sd; // leave the UUID rather than fabricate a name
      }
      resolved += 1;
      return fileName + sd.slice(m[0].length); // preserves "::Sheet Name" suffix
    });
  }

  return { resolved, unresolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// §F — Reportable report formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a report from canonical reportable findings only.
 * Non-reportable items must not appear as substantive findings.
 * Operational disclosures may be appended as a clearly separated section.
 *
 * MG-5: Sections by materiality_tier (from MG-4 Stage 4.6), NOT by severity.
 *   Tier 1 — Potentially Deal-Relevant (with rationale + driver prominently)
 *   Tier 2 — Worth a Condition or Follow-Up (with rationale + driver)
 *   Tier 3 — Noted (compact: title + one-line rationale only)
 *   Challenges to the Memo's Figures (absence_verification === "memo_disclosure_uncertain")
 *   Other Findings (untiered — safety net, nothing silently dropped)
 */
export function formatCanonicalReport(
  executiveHeader: string,
  reportableFindings: any[],
  options: {
    degradedConditions?: string[];
    excludedCount?: number;
  } = {}
): string {
  const lines: string[] = [];

  // ── Classify findings by tier ──────────────────────────────────────────────
  const tier1: any[] = [];
  const tier2: any[] = [];
  const tier3: any[] = [];
  const framingChallenges: any[] = [];
  const other: any[] = [];

  for (const f of reportableFindings) {
    // Framing challenges: memo engages the topic but finding disputes its framing
    if (f.absence_verification === "memo_disclosure_uncertain") {
      framingChallenges.push(f);
    } else if (f.materiality_tier === 1) {
      tier1.push(f);
    } else if (f.materiality_tier === 2) {
      tier2.push(f);
    } else if (f.materiality_tier === 3) {
      tier3.push(f);
    } else {
      // No tier set (non-absence findings, safety-floor residuals, etc.)
      other.push(f);
    }
  }

  const total = reportableFindings.length;

  // ── Header ─────────────────────────────────────────────────────────────────
  lines.push("# Diligence Report");
  lines.push("");
  lines.push(`> **${total} reportable finding${total !== 1 ? "s" : ""}**`);
  // Item 3a: three zeros is self-contradictory when tiering never ran for this
  // module (materiality tiering applies to omission-audit modules only). Say so
  // explicitly rather than printing a count line that reads as "nothing matters".
  const tieredCount = tier1.length + tier2.length + tier3.length;
  if (tieredCount === 0) {
    lines.push(
      `> Materiality tiers not assigned for this module — findings are reported untiered.`
    );
  } else {
    lines.push(
      `> Tier 1 (deal-relevant): ${tier1.length}  ·  Tier 2: ${tier2.length}  ·  Tier 3: ${tier3.length}`
    );
  }
  lines.push("");

  if (executiveHeader) {
    lines.push("## Executive Summary");
    lines.push("");
    lines.push(executiveHeader);
    lines.push("");
  }

  // ── Tier 1 — full detail with prominent rationale ──────────────────────────
  if (tier1.length > 0) {
    lines.push(`## Tier 1 — Potentially Deal-Relevant (${tier1.length})`);
    lines.push("");
    for (const f of tier1) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push("");
      if (f.tier_rationale) {
        lines.push(`> **Why this matters:** ${f.tier_rationale}`);
      }
      if (f.tier_driver) {
        lines.push(`> **Affects:** ${f.tier_driver}`);
      }
      if (f.tier_rationale || f.tier_driver) lines.push("");
      if (f.detail) {
        lines.push(f.detail);
        lines.push("");
      }
      if (f.full_analysis) {
        lines.push(f.full_analysis);
        lines.push("");
      }
      if (f.evidence && f.evidence.length > 0) {
        lines.push("**Evidence:**");
        for (const ev of f.evidence.slice(0, 5)) {
          const label = typeof ev === "string"
            ? ev
            : ev.verbatim_snippet ?? ev.figure ?? JSON.stringify(ev);
          lines.push(`- ${label}`);
        }
        lines.push("");
      }
    }
  }

  // ── Tier 2 — full detail with rationale ────────────────────────────────────
  if (tier2.length > 0) {
    lines.push(`## Tier 2 — Worth a Condition or Follow-Up (${tier2.length})`);
    lines.push("");
    for (const f of tier2) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push("");
      if (f.tier_rationale) {
        lines.push(`> **Why this matters:** ${f.tier_rationale}`);
      }
      if (f.tier_driver) {
        lines.push(`> **Affects:** ${f.tier_driver}`);
      }
      if (f.tier_rationale || f.tier_driver) lines.push("");
      if (f.detail) {
        lines.push(f.detail);
        lines.push("");
      }
      if (f.full_analysis) {
        lines.push(f.full_analysis);
        lines.push("");
      }
      if (f.evidence && f.evidence.length > 0) {
        lines.push("**Evidence:**");
        for (const ev of f.evidence.slice(0, 5)) {
          const label = typeof ev === "string"
            ? ev
            : ev.verbatim_snippet ?? ev.figure ?? JSON.stringify(ev);
          lines.push(`- ${label}`);
        }
        lines.push("");
      }
    }
  }

  // ── Tier 3 — compact appendix (title + rationale only, no full_analysis/evidence) ─
  if (tier3.length > 0) {
    lines.push(`## Tier 3 — Noted (${tier3.length})`);
    lines.push("");
    for (const f of tier3) {
      const rationale = f.tier_rationale ? ` — ${f.tier_rationale}` : "";
      lines.push(`- **${f.title || "Untitled Finding"}**${rationale}`);
    }
    lines.push("");
  }

  // ── Framing Challenges (memo engages topic but finding disputes framing) ───
  if (framingChallenges.length > 0) {
    lines.push(`## Challenges to the Memo's Figures (${framingChallenges.length})`);
    lines.push("");
    lines.push("These are not omissions — the memos address these topics, but the tool's read of the underlying data differs from how the memo presents it. Verify against source.");
    lines.push("");
    for (const f of framingChallenges) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push("");
      if (f.tier_rationale) {
        lines.push(`> **Why this matters:** ${f.tier_rationale}`);
      }
      if (f.tier_driver) {
        lines.push(`> **Affects:** ${f.tier_driver}`);
      }
      if (f.tier_rationale || f.tier_driver) lines.push("");
      if (f.detail) {
        lines.push(f.detail);
        lines.push("");
      }
      if (f.full_analysis) {
        lines.push(f.full_analysis);
        lines.push("");
      }
    }
  }

  // ── Other Findings (untiered — safety net, never drop) ─────────────────────
  if (other.length > 0) {
    // Item 3a: when tiering never ran for this module, every finding lands here.
    // Calling them "Other Findings" while they are the module's principal
    // findings is misleading — label the section for what it actually holds.
    const isSoleSection =
      tier1.length === 0 && tier2.length === 0 && tier3.length === 0 && framingChallenges.length === 0;
    lines.push(isSoleSection ? `## Findings (${other.length})` : `## Other Findings (${other.length})`);
    lines.push("");
    for (const f of other) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push("");
      const meta: string[] = [];
      if (f.severity) meta.push(`**Severity:** ${f.severity}`);
      if (Array.isArray(f.source_docs) && f.source_docs.length > 0) {
        meta.push(`**Sources:** ${f.source_docs.slice(0, 4).join(", ")}`);
      }
      if (meta.length > 0) {
        lines.push(`> ${meta.join("  ·  ")}`);
        lines.push("");
      }
      if (f.detail) {
        lines.push(f.detail);
        lines.push("");
      }
      if (f.full_analysis) {
        lines.push(f.full_analysis);
        lines.push("");
      }
      if (f.evidence && f.evidence.length > 0) {
        lines.push("**Evidence:**");
        for (const ev of f.evidence.slice(0, 5)) {
          const label = typeof ev === "string"
            ? ev
            : ev.verbatim_snippet ?? ev.figure ?? JSON.stringify(ev);
          lines.push(`- ${label}`);
        }
        lines.push("");
      }
    }
  }

  // ── Operational disclosures — clearly separated, never counted as findings ─
  const disclosureLines: string[] = [];
  if (options.degradedConditions && options.degradedConditions.length > 0) {
    disclosureLines.push(...options.degradedConditions);
  }
  if (options.excludedCount && options.excludedCount > 0) {
    disclosureLines.push(
      `${options.excludedCount} diagnostic record(s) excluded from substantive findings.`
    );
  }

  if (disclosureLines.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Operational Disclosures");
    lines.push("");
    for (const d of disclosureLines) {
      lines.push(`> ${d}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main canonical finalizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single authoritative finalization function.
 *
 * db: postgres integration client (ctx.integrations.db)
 * runId: module run ID
 * dealId: deal ID
 * prereqs: validated inputs from the caller (checkpoint data already loaded)
 */
export async function canonicalFinalize(
  db: { query: (...args: any[]) => Promise<any[]>; execute: (...args: any[]) => Promise<any> },
  runId: string,
  dealId: string,
  prereqs: FinalizerPrerequisites
): Promise<FinalizerOutcome> {

  const { moduleType, executiveHeader, checkpointStatus, canonicalRecordMap } = prereqs;

  // ── STEP 0: Publication Gate (fail-closed) ─────────────────────────────────
  // A module run may ONLY be published when the tree is fully complete and the
  // proposed final node is the natural root. Sub-root checkpoints are resumable
  // state, not publishable artifacts.
  if (prereqs.bypassPublicationGate) {
    console.warn(
      `[canonicalFinalize] ⚠️ Publication gate BYPASSED for run ${runId} — ` +
      `administrative override active. This is auditable.`
    );
  } else {
    const proposedLevel = prereqs.proposedFinalNode?.treeLevel ?? null;
    const proposedIndex = prereqs.proposedFinalNode?.nodeIndex ?? null;

    const gateResult = await runPublicationGate(db, runId, proposedLevel, proposedIndex);

    if (!gateResult.eligible) {
      const compact = toCompactDiagnostic(gateResult.diagnostic);
      console.warn(
        `[canonicalFinalize] PUBLICATION BLOCKED for run ${runId} — ` +
        `reasons: ${compact.blocking_reasons.join("; ")}`
      );
      return {
        status: "publication_blocked",
        diagnostic: compact,
        message:
          `Publication gate failed: ${compact.blocking_reasons.join("; ")}. ` +
          `Coverage: ${compact.coverage_pct}% (${compact.completed_analysis_count}/${compact.expected_analysis_count}). ` +
          `Tree: ${compact.total_complete_nodes}/${compact.total_expected_nodes} nodes complete. ` +
          `Run remains in_progress and is resumable.`,
      };
    }

    console.log(
      `[canonicalFinalize] Publication gate PASSED for run ${runId} — ` +
      `coverage=${gateResult.diagnostic.completed_analysis_count}/${gateResult.diagnostic.expected_analysis_count}, ` +
      `tree ${gateResult.diagnostic.total_complete_nodes}/${gateResult.diagnostic.total_expected_nodes} nodes`
    );

    // Fix 25: a clean root can still sit above nodes that were accepted truncated.
    // Publication proceeds — their content is already folded into ancestors — but
    // the degradation is recorded rather than left silent.
    if (gateResult.diagnostic.tree_degraded) {
      console.warn(
        `[canonicalFinalize] ⚠️ TREE DEGRADED for run ${runId} — root is clean but ` +
        `${gateResult.diagnostic.truncated_node_count} non-root node(s) were accepted truncated: ` +
        `${gateResult.diagnostic.truncated_node_ids.join(", ")}. ` +
        `Fidelity is not guaranteed for the subtrees beneath them.`
      );
    }
  }

  // ── STEP 1: Validate prerequisites ────────────────────────────────────────
  // Check if an output already exists for this run (idempotency).
  // Schema has only: id, module_run_id, executive_header, findings, full_report_markdown, created_at
  const ExistingOutputSchema = z.object({
    id: z.string(),
    executive_header: z.string().nullable(),
  });
  let existingOutputs: { id: string; executive_header: string | null }[];
  existingOutputs = await db.query(
    `SELECT id, executive_header
     FROM module_outputs
     WHERE module_run_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    ExistingOutputSchema,
    [runId],
    { label: "canonicalFinalize: check existing output" }
  );

  // For contradiction_check, require all canonical checkpoints
  const requiredKeys = CLAIMS_REQUIRED_MODULES.has(moduleType)
    ? REQUIRED_CHECKPOINTS_CONTRADICTION
    : ["canonical_findings"];

  const missingKeys: string[] = [];
  const statusMap = new Map(checkpointStatus.map(s => [s.key, s]));

  // Filter out evidence_admission when skipEvidenceAdmission is set (natural-merge-tree runs)
  const effectiveRequiredKeys = prereqs.skipEvidenceAdmission
    ? requiredKeys.filter(k => k !== "evidence_admission")
    : requiredKeys;

  for (const key of effectiveRequiredKeys) {
    const entry = statusMap.get(key);
    if (!entry || !entry.present) {
      missingKeys.push(key);
    } else if (entry.status && !["complete", "present", "done"].includes(entry.status.toLowerCase())) {
      missingKeys.push(`${key}(${entry.status})`);
    }
  }

  if (missingKeys.length > 0) {
    return {
      status: "prerequisites_missing",
      missingKeys,
      message: `Required checkpoints missing or incomplete: ${missingKeys.join(", ")}. Run remains in_progress.`,
    };
  }

  // ── STEP 2: Parse and validate findings ──────────────────────────────────
  let findings: any[];
  try {
    const parseResult = parseCanonicalFindings(prereqs.findings, {
      mode: "reload",
      source: `canonicalFinalize:${runId}`,
    });
    if (parseResult.malformed_count > 0) {
      return {
        status: "persist_failed",
        error: `${parseResult.malformed_count} irrecoverably malformed findings — refusing to finalize`,
      };
    }
    findings = parseResult.findings as any[];
  } catch (err: any) {
    return {
      status: "persist_failed",
      error: `Finding parse error: ${err?.message ?? err}`,
    };
  }

  // ── STEP 3: Apply F05 narrative enforcement ────────────────────────────────
  const enforcement = enforceNarrativeBoundary(findings, canonicalRecordMap);
  const enforcedFindings: any[] = enforcement.findings as any[];

  console.log(
    `[canonicalFinalize][F05] ${enforcement.counts.input} → ${enforcement.counts.output} ` +
    `(excluded: process=${enforcement.counts.process_excluded}, ` +
    `no_canonical=${enforcement.counts.no_canonical_rejected}, ` +
    `narrative_rejected=${enforcement.counts.narrative_rejected})`
  );

  // ── STEP 3.5: Resolve raw document UUIDs in source_docs to filenames ──────
  // Findings from the numeric-verification path carry "<documentId>::<sheet>";
  // findings from the claims path are already resolved upstream. Normalize here
  // so a single artifact never mixes filenames and UUIDs.
  const sourceDocResolution = await resolveSourceDocFilenames(db, dealId, enforcedFindings);
  if (sourceDocResolution.resolved > 0 || sourceDocResolution.unresolved > 0) {
    console.log(
      `[canonicalFinalize][source_docs] resolved=${sourceDocResolution.resolved}, ` +
      `unresolved=${sourceDocResolution.unresolved}`
    );
  }

  // ── STEP 4: Classify reportable vs. excluded findings (§F) ────────────────
  const reportableFindings: any[] = [];
  const excludedFindings: ExcludedFinding[] = [];
  const reportableFindingIds: string[] = [];

  for (const f of enforcedFindings) {
    const exclusionReason = getReportExclusionReason(f);
    if (exclusionReason) {
      excludedFindings.push({
        finding_id: f.finding_id ?? f.id ?? "unknown",
        title: f.title ?? "",
        exclusion_reason: exclusionReason,
        // Attribution: which layer dropped it and why. Without these two fields
        // an exclusion is only inferable from absence, which cannot distinguish
        // "the filter removed a process object" from "a real finding vanished".
        exclusion_layer: "finalizer_report_filter",
        gate_name: exclusionReason,
        reason: FINALIZER_EXCLUSION_REASON_TEXT[exclusionReason],
      });
    } else {
      reportableFindings.push(f);
      reportableFindingIds.push(f.finding_id ?? f.id ?? "");
    }
  }

  // ── STEP 5: Build diagnostics (§G) ────────────────────────────────────────
  const narrativeDiagnostics: NarrativeDiagnostic[] = enforcement.diagnostics.map(d => ({
    finding_id: d.finding_id,
    status: d.status as NarrativeDiagnostic["status"],
    reason_codes: d.reason_codes ?? [],
    fallback_used: d.status === "rejected" || (d.status as string) === "fallback_applied",
  }));

  const degradedConditions = prereqs.degradedConditions ?? [];
  if (prereqs.claimsDegraded) {
    degradedConditions.push(
      "Claims reconciliation could not be completed. Analysis is based on numeric verification only."
    );
  }

  const diagnostics: CanonicalFinalArtifact["diagnostics"] = {
    narrative_validation: narrativeDiagnostics,
    excluded_findings: excludedFindings,
    degraded_conditions: degradedConditions,
    checkpoint_status: checkpointStatus,
  };

  // ── STEP 5.5: Regenerate executive header from the FINAL finding set ──────
  // The inbound `executiveHeader` was extracted from the merge tree BEFORE the
  // reduction gate ran, so it can name risks the gate subsequently dropped.
  // Rebuilding it here from `reportableFindings` makes header↔finding
  // correspondence structural rather than something that has to be validated.
  const regeneratedHeader = synthesizeExecutiveHeader(reportableFindings);
  const effectiveHeader = regeneratedHeader ?? executiveHeader;
  if (regeneratedHeader && regeneratedHeader !== executiveHeader) {
    console.log(
      `[canonicalFinalize][header] regenerated from ${reportableFindings.length} ` +
      `reportable finding(s) — pre-gate header discarded ` +
      `(${(executiveHeader ?? "").length} → ${regeneratedHeader.length} chars)`
    );
  }

  // ── STEP 6: Format report from reportable findings only ──────────────────
  // ALWAYS rebuild report from canonical reportable records (MAT-F06 §1).
  // preFormattedReport is never used as authoritative — it may contain excluded
  // items, F05-rejected text, or unlinked entries that passed through LLM formatting.
  const reportMarkdown = formatCanonicalReport(effectiveHeader, reportableFindings, {
    degradedConditions,
    excludedCount: excludedFindings.length,
  });

  // ── STEP 7: Compute semantic hash ─────────────────────────────────────────
  const hashInput = buildSemanticHashInput(
    reportableFindings,
    reportableFindingIds,
    diagnostics,
    moduleType,
    reportMarkdown
  );
  const semanticHash = computeSemanticHash(hashInput);

  // ── STEP 8: Idempotency guard ──────────────────────────────────────────────
  if (existingOutputs.length > 0) {
    const existing = existingOutputs[0];

    // Check if the run is already marked completed
    const RunStatusSchema = z.object({ status: z.string() });
    const runRows = await db.query(
      `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
      RunStatusSchema,
      [runId],
      { label: "canonicalFinalize: check run status" }
    );
    const currentStatus = runRows[0]?.status ?? "unknown";
    if (currentStatus === "completed") {
      // Already finalized — treat as idempotent
      console.log(`[canonicalFinalize] Idempotent: run ${runId} already completed, artifact ${existing.id} exists`);
      return {
        status: "idempotent",
        artifactId: existing.id,
        semanticHash,
        message: `Run already completed with existing artifact.`,
      };
    }
    // Run is not completed — allow the update (retry with different content mid-run is normal)
    console.log(`[canonicalFinalize] Existing output found but run not completed — allowing update`);
  }

  // ── STEP 9: Build artifact ────────────────────────────────────────────────
  const artifact: CanonicalFinalArtifact = {
    schema_version: CANONICAL_FINAL_ARTIFACT_VERSION,
    run_id: runId,
    module_type: moduleType,
    canonical_findings: reportableFindings,
    reportable_finding_ids: reportableFindingIds,
    diagnostics,
    report: {
      markdown: reportMarkdown,
      finding_count: reportableFindings.length,
      executive_header: effectiveHeader,
    },
    identity: {
      semantic_hash: semanticHash,
      hash_version: SEMANTIC_HASH_VERSION,
    },
    finalized_at: new Date().toISOString(),
  };

  // ── STEP 10: Persist artifact once ────────────────────────────────────────
  // Writes ONLY the reportable findings to `module_outputs.findings`.
  //
  // This is deliberate, not an oversight. `findings` is the IC-facing set: every
  // downstream reader (report renderer, Q&A retrieval, deal dashboard) treats a
  // row in this column as something that survived §F and the reduction gate.
  // Putting suppressed findings here would silently promote them.
  //
  // The suppressed set is not discarded — STEP 10.5 writes the full exclusion
  // ledger, with per-finding gate attribution, to `module_run_diagnostics`.
  //
  // Schema: module_outputs has (id, module_run_id, executive_header, findings, full_report_markdown, created_at).
  const reportableFindingsJson = JSON.stringify(reportableFindings);

  try {
    let artifactId: string;

    if (existingOutputs.length > 0) {
      artifactId = existingOutputs[0].id;
      // Update existing row — only actual schema columns
      await db.execute(
          `UPDATE module_outputs
           SET executive_header       = $2,
               findings               = $3::jsonb,
               full_report_markdown   = $4
           WHERE id = $1`,
          [
            artifactId,
            effectiveHeader,
            reportableFindingsJson,
            reportMarkdown,
          ],
          { label: "canonicalFinalize: persist artifact (update)" }
        );
    } else {
      // Insert new row — actual schema columns only
      const insertedRows = await db.query(
        `INSERT INTO module_outputs
           (module_run_id, executive_header, findings, full_report_markdown)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id`,
        z.object({ id: z.string() }),
        [
          runId,
          effectiveHeader,
          reportableFindingsJson,
          reportMarkdown,
        ],
        { label: "canonicalFinalize: persist artifact (insert)" }
      );
      artifactId = insertedRows[0].id;
    }

    // Bump deal updated_at
    await db.execute(
      `UPDATE deals SET updated_at = now() WHERE id = $1`,
      [dealId],
      { label: "canonicalFinalize: bump deal" }
    );

    console.log(
      `[canonicalFinalize] Persisted artifact ${artifactId} — ` +
      `hash=${semanticHash}, reportable=${reportableFindings.length}, excluded=${excludedFindings.length}`
    );

    // ── STEP 10.5: Persist the suppression audit trail ─────────────────────
    // `excluded_findings` and `degraded_conditions` used to exist only in the
    // in-memory artifact and were lost the moment this function returned. The
    // rehydration path proved it: it returned `excluded_findings: []` with a note
    // that diagnostics were not re-derived.
    //
    // Everything the finalizer suppressed, plus everything the reduction gate
    // suppressed (with gate name and reason per finding), now lands in
    // `module_run_diagnostics`. Non-fatal — an audit-row failure must not block a
    // run whose report is already durable.
    const auditResult = await persistRunDiagnostics(
      db,
      runId,
      excludedFindings,
      degradedConditions,
      reportableFindings.length,
    );

    // ── STEP 11: Verify persistence succeeded ─────────────────────────────
    const VerifySchema = z.object({ id: z.string() });
    const verifyRows = await db.query(
      `SELECT id FROM module_outputs WHERE id = $1 LIMIT 1`,
      VerifySchema,
      [artifactId],
      { label: "canonicalFinalize: verify persistence" }
    );
    if (verifyRows.length === 0) {
      return {
        status: "persist_failed",
        error: `Persistence verification failed — artifact ${artifactId} not readable after INSERT/UPDATE`,
      };
    }

    // ── STEP 12: Mark run completed AFTER artifact is durable ─────────────
    await db.execute(
      `UPDATE module_runs
       SET status       = 'completed'::module_status,
           completed_at = now()
       WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: "canonicalFinalize: mark run completed (guarded)" }
    );

    console.log(`[canonicalFinalize] Run ${runId} marked completed with hash ${semanticHash}`);
    console.log(
      `[canonicalFinalize] Audit trail: written=${auditResult.written}, ` +
      `excluded_total=${auditResult.totalExcluded}` +
      (auditResult.error ? `, error=${auditResult.error}` : "")
    );

    return {
      status: "completed",
      artifactId,
      semanticHash,
      findingCount: reportableFindings.length,
      artifact,
    };
  } catch (persistErr: any) {
    return {
      status: "persist_failed",
      error: persistErr?.message ?? String(persistErr),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisite loader — load checkpoint status from DB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load checkpoint presence/status from pipeline_checkpoints for a given run.
 * Returns a CheckpointStatusEntry for each of the four required canonical keys.
 */
/**
 * Load checkpoint presence from pipeline_checkpoints for prerequisite validation.
 *
 * NOTE: `canonical_findings` is a synthetic key — it is not written to the DB.
 * Pass `hasParsedFindings=true` when the caller has already successfully parsed
 * findings from a merge checkpoint. It will be included as present:true.
 *
 * NOTE: `evidence_admission` is validated by checking the Q3 merge checkpoint payload
 * (tree_level=96) for the `evidence_admission_ledgers` field with at least one entry.
 * F02B stores evidence admission data inside the Q3 replay payload, not as a separate
 * pipeline_checkpoints row.
 */
export async function loadCheckpointStatus(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
  moduleType: string,
  hasParsedFindings = false
): Promise<CheckpointStatusEntry[]> {
  // DB keys actually written by pipeline-core.ts to pipeline_checkpoints
  const dbKeys = CLAIMS_REQUIRED_MODULES.has(moduleType)
    ? ["claims_ledger", "reconciliation"]
    : [];

  const CheckpointRow = z.object({
    checkpoint_key: z.string(),
    status: z.string().nullable(),
  });

  let rows: z.infer<typeof CheckpointRow>[] = [];
  if (dbKeys.length > 0) {
    try {
      rows = await db.query(
        `SELECT checkpoint_key, COALESCE(status, 'complete') AS status
         FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = ANY($2::text[])
         ORDER BY created_at DESC`,
        CheckpointRow,
        [runId, dbKeys],
        { label: "loadCheckpointStatus: query pipeline_checkpoints" }
      );
    } catch {
      // pipeline_checkpoints may not exist (old schema) — treat as all missing
    }
  }

  const found = new Map(rows.map(r => [r.checkpoint_key, r.status ?? "complete"]));

  const result: CheckpointStatusEntry[] = dbKeys.map(key => ({
    key,
    present: found.has(key),
    status: found.get(key),
  }));

  // Synthetic canonical_findings entry — derived from whether findings were parsed
  result.push({
    key: "canonical_findings",
    present: hasParsedFindings,
    status: hasParsedFindings ? "complete" : "missing",
  });

  // Synthetic evidence_admission entry — derived from Q3 merge checkpoint payload
  // F02B stores evidence_admission_ledgers inside merge_checkpoints at tree_level=96
  if (CLAIMS_REQUIRED_MODULES.has(moduleType)) {
    let hasEvidenceAdmission = false;
    try {
      const Q3Row = z.object({ merged_json: z.any() });
      const q3Rows = await db.query(
        `SELECT merged_json FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = 96 AND node_index = 0
         LIMIT 1`,
        Q3Row,
        [runId],
        { label: "loadCheckpointStatus: check Q3 evidence admission" }
      );
      if (q3Rows.length > 0) {
        const payload = typeof q3Rows[0].merged_json === "string"
          ? JSON.parse(q3Rows[0].merged_json)
          : q3Rows[0].merged_json;
        const ledgers = payload?.evidence_admission_ledgers;
        if (Array.isArray(ledgers) && ledgers.length > 0) {
          // Validate at least one ledger has admitted evidence
          hasEvidenceAdmission = ledgers.some(
            (l: any) => l?.schema_version === "evidence-admission-v1" && Array.isArray(l.admitted)
          );
        }
      }
    } catch {
      // merge_checkpoints may not exist or Q3 not yet written — treat as missing
    }
    result.push({
      key: "evidence_admission",
      present: hasEvidenceAdmission,
      status: hasEvidenceAdmission ? "complete" : "missing",
    });
  }

  return result;
}
