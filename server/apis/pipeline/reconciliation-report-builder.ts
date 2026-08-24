/**
 * Reconciliation Report Builder (Item 6 — wiring)
 * ===============================================
 *
 * Assembles a `ReconciliationReportContext` from the artefacts the finalization
 * runner already holds, then renders it via `formatReconciliationReport`.
 *
 * Split out of `post-merge-finalization.ts` deliberately: the runner's job is
 * stage orchestration, and the only thing it needs from this module is a string.
 * All DB reads here are provenance lookups (§1 "What was audited") — the numbers
 * in §3 and §4 are copied from counters the runner passes in, never re-derived.
 *
 * Failure policy: this is a presentation step. If it throws, the caller falls
 * back to the canonical renderer rather than failing the run.
 */

import { z } from "@superblocksteam/sdk-api";

import type { ClaimsLedger } from "./claims-extraction.js";
import type { ReconciliationResult } from "./claims-reconciliation.js";
import { RECONCILIATION_REPORT_TOP_N } from "./pipeline-config.js";
import { formatRankAudit, rankReconciliationFindings } from "./reconciliation-ranking.js";
import { formatReconciliationReport } from "./reconciliation-report.js";
import type { ReconciliationReportContext, ReportDocument } from "./reconciliation-report.js";

const LOG = "[reconciliationReport]";

/** P2.1 metadata recorded alongside the reconciliation checkpoint. */
export interface ReconciliationP21Meta {
  magnitudeHeld?: number | null;
  parallelOffsetHeld?: number | null;
  gateVerified?: number | null;
  gateRejected?: number | null;
  gateRejectionCounts?: Record<string, number> | null;
  gateTotalSubmitted?: number | null;
  unmatchableScopeDetails?: Array<{ scope: string; reason: string; claim_count: number }> | null;
  bridgeFiguresCount?: number | null;
  elapsedMs?: number | null;
}

/** Ten-gate reduction filter outcome, as observed by the runner. */
export interface ReductionGateSummary {
  admitted: number;
  /**
   * Suppressed count. `null` when the runner restored the gate from a checkpoint
   * that does not carry it — this module then reads the authoritative
   * `finding_reduction_gate` ledger rather than reporting a wrong number.
   */
  rejected: number | null;
  /**
   * Per-gate stats. `applyReductionGates` emits `{ passed, failed }` per gate;
   * a plain number is accepted too and read as the rejection count.
   */
  byGate?: Record<string, number | { passed: number; failed: number }> | null;
}

/** Normalizes per-gate stats to rejection counts, dropping gates that rejected nothing. */
function toRejectionCounts(
  byGate: Record<string, number | { passed: number; failed: number }> | null | undefined,
): Record<string, number> | undefined {
  if (!byGate) return undefined;
  const out: Record<string, number> = {};
  for (const [gate, stat] of Object.entries(byGate)) {
    const failed = typeof stat === "number" ? stat : (stat?.failed ?? 0);
    if (failed > 0) out[gate] = failed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ReductionLedgerSchema = z.object({
  suppressedCount: z.coerce.number().nullable(),
});

export interface BuildReconciliationReportInput {
  db: { query: (...args: any[]) => Promise<any[]> };
  dealId: string;
  /** Module run ID — used to read the authoritative reduction-gate ledger. */
  runId: string;
  claimsLedger: ClaimsLedger | null;
  reconciliation: ReconciliationResult;
  p21: ReconciliationP21Meta | null;
  reductionGate: ReductionGateSummary | null;
  /**
   * Titles of findings that survived post-merge + the ten-gate reduction filter.
   * When supplied, the report ranks only the surviving set, so §2/§6 can never
   * present a finding the gate suppressed. When null, all verified findings rank.
   */
  survivingTitles: Set<string> | null;
  timings?: { extractionMs?: number | null; reconciliationMs?: number | null; totalMs?: number | null } | null;
}

const DocRowSchema = z.object({
  file_name: z.string().nullable(),
  document_tag: z.string().nullable(),
  uploaded_at: z.any().nullable(),
});

const DealRowSchema = z.object({ name: z.string().nullable() });

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toReportDocs(rows: Array<z.infer<typeof DocRowSchema>>): ReportDocument[] {
  return rows.map(r => ({
    file_name: r.file_name ?? "(unnamed)",
    document_tag: r.document_tag,
    ingested_at: toIso(r.uploaded_at),
  }));
}

/**
 * Builds and renders the reconciliation report. Returns null when the report
 * cannot be produced — the caller then keeps the canonical renderer.
 */
export async function buildReconciliationReportMarkdown(
  input: BuildReconciliationReportInput,
): Promise<{ markdown: string; rankAudit: string[]; rankedCount: number; presentedCount: number } | null> {
  const { db, dealId, runId, claimsLedger, reconciliation, p21, reductionGate, survivingTitles } = input;

  // ── §1 provenance: documents actually read ───────────────────────────────
  let memos: ReportDocument[] = [];
  let modelDocs: ReportDocument[] = [];
  try {
    const rows = await db.query(
      `SELECT file_name, document_tag, uploaded_at
         FROM documents
        WHERE deal_id = $1
          AND document_tag IN ('ic_memo', 'financial_model')
        ORDER BY document_tag ASC, uploaded_at ASC`,
      DocRowSchema,
      [dealId],
      { label: `${LOG} load audited documents` },
    );
    memos = toReportDocs(rows.filter(r => r.document_tag === "ic_memo"));
    modelDocs = toReportDocs(rows.filter(r => r.document_tag === "financial_model"));
  } catch (e: any) {
    console.warn(`${LOG} document provenance lookup failed (non-fatal): ${e?.message}`);
  }

  let dealName: string | null = null;
  try {
    const dealRows = await db.query(
      `SELECT name FROM deals WHERE id = $1 LIMIT 1`,
      DealRowSchema,
      [dealId],
      { label: `${LOG} load deal name` },
    );
    dealName = dealRows[0]?.name ?? null;
  } catch { /* header degrades to timestamp only */ }

  // ── §2 / §6: rank the surviving verified findings ────────────────────────
  const verified = Array.isArray(reconciliation.findings) ? reconciliation.findings : [];
  const eligible = survivingTitles
    ? verified.filter(f => survivingTitles.has(String(f.title ?? "")))
    : verified;

  if (survivingTitles && eligible.length !== verified.length) {
    console.log(
      `${LOG} rank population: ${verified.length} verified → ${eligible.length} ` +
      `after the ten-gate reduction filter (${verified.length - eligible.length} suppressed).`,
    );
  }

  const ranked = rankReconciliationFindings(eligible, { topN: RECONCILIATION_REPORT_TOP_N });

  // ── §4: reduction-gate suppression count ────────────────────────────────
  // The runner cannot supply this when it restored the gate from
  // `reduction_gate_done` (that checkpoint carries only the surviving set), so
  // read the `finding_reduction_gate` ledger, which is written whenever the gate
  // actually executes. Reporting "0 rejected" on a resumed run would be false.
  let reductionRejected = reductionGate?.rejected ?? null;
  if (reductionGate && reductionRejected === null) {
    try {
      const ledgerRows = await db.query(
        `SELECT (payload->>'suppressedCount') AS "suppressedCount"
           FROM pipeline_checkpoints
          WHERE module_run_id = $1 AND checkpoint_key = 'finding_reduction_gate'
          LIMIT 1`,
        ReductionLedgerSchema,
        [runId],
        { label: `${LOG} load reduction-gate ledger` },
      );
      reductionRejected = ledgerRows[0]?.suppressedCount ?? null;
    } catch (e: any) {
      console.warn(`${LOG} reduction-gate ledger lookup failed (non-fatal): ${e?.message}`);
    }
  }

  // ── §4: exclusions, copied from counters ────────────────────────────────
  const gateRejectionCounts = p21?.gateRejectionCounts ?? {};
  const gateRejected = p21?.gateRejected ?? Object.values(gateRejectionCounts).reduce((a, b) => a + (b ?? 0), 0);
  const gateTotalSubmitted =
    p21?.gateTotalSubmitted ??
    ((p21?.gateVerified ?? 0) + (gateRejected ?? 0));

  const ctx: ReconciliationReportContext = {
    dealName,
    memos,
    modelDocs,
    figuresCount: p21?.bridgeFiguresCount ?? null,
    extraction: {
      timestamp: claimsLedger?.extraction_metadata?.extraction_timestamp ?? null,
      model: claimsLedger?.extraction_metadata?.extraction_model ?? null,
      docs_processed: claimsLedger?.extraction_metadata?.docs_processed ?? 0,
      pending: claimsLedger?.extraction_metadata?.pending ?? 0,
      total_claims: claimsLedger?.extraction_metadata?.total_claims ?? (claimsLedger?.claims?.length ?? 0),
      operating_metric_claims: claimsLedger?.extraction_metadata?.operating_metric_claims ?? 0,
      complete: claimsLedger?.complete ?? false,
    },
    ranked,
    coverage: reconciliation.coverage,
    reconciliation: {
      reconciled_count: reconciliation.reconciled_count,
      within_tolerance_count: reconciliation.within_tolerance_count,
      near_miss_count: reconciliation.near_miss_count,
      unreconcilable_count: reconciliation.unreconcilable_count,
      scope_mismatch_count: reconciliation.scope_mismatch_count,
      cross_version_findings: reconciliation.cross_version_findings,
      ambiguous_reference_count: reconciliation.ambiguous_reference_count,
      near_miss_unit_rejected: reconciliation.near_miss_unit_rejected,
      findings_report_id: reconciliation.findings_report_id,
      findings_truncated: reconciliation.findings_truncated,
      matching_error: reconciliation.matching_error,
    },
    holds: {
      magnitudeHeld: p21?.magnitudeHeld ?? 0,
      parallelOffsetHeld: p21?.parallelOffsetHeld ?? 0,
    },
    gate: {
      totalSubmitted: gateTotalSubmitted,
      rejectedCount: gateRejected ?? 0,
      rejectionCounts: gateRejectionCounts,
    },
    reductionGate: reductionGate
      ? {
          admitted: reductionGate.admitted,
          rejected: reductionRejected,
          byGate: toRejectionCounts(reductionGate.byGate),
        }
      : null,
    unmatchableScopes: p21?.unmatchableScopeDetails ?? [],
    timings: input.timings ?? null,
    generatedAt: new Date().toISOString(),
    topN: RECONCILIATION_REPORT_TOP_N,
  };

  const markdown = formatReconciliationReport(ctx);
  const rankAudit = formatRankAudit(ranked);

  return {
    markdown,
    rankAudit,
    rankedCount: ranked.length,
    presentedCount: ranked.filter(r => r.presented).length,
  };
}
