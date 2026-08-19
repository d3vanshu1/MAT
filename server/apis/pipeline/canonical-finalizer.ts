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
  lines.push(`> Tier 1 (deal-relevant): ${tier1.length}  ·  Tier 2: ${tier2.length}  ·  Tier 3: ${tier3.length}`);
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
    lines.push(`## Other Findings (${other.length})`);
    lines.push("");
    for (const f of other) {
      lines.push(`### ${f.title || "Untitled Finding"}`);
      lines.push("");
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

  for (const key of requiredKeys) {
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

  // ── STEP 6: Format report from reportable findings only ──────────────────
  // ALWAYS rebuild report from canonical reportable records (MAT-F06 §1).
  // preFormattedReport is never used as authoritative — it may contain excluded
  // items, F05-rejected text, or unlinked entries that passed through LLM formatting.
  const reportMarkdown = formatCanonicalReport(executiveHeader, reportableFindings, {
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
      executive_header: executiveHeader,
    },
    identity: {
      semantic_hash: semanticHash,
      hash_version: SEMANTIC_HASH_VERSION,
    },
    finalized_at: new Date().toISOString(),
  };

  // ── STEP 10: Persist artifact once ────────────────────────────────────────
  // Write all findings (reportable + excluded) to findings column for full fidelity.
  // Schema: module_outputs has (id, module_run_id, executive_header, findings, full_report_markdown, created_at).
  const allFindingsJson = JSON.stringify(reportableFindings);

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
            executiveHeader,
            allFindingsJson,
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
          executiveHeader,
          allFindingsJson,
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
