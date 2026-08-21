/**
 * reconciliation-pipeline.ts — P2.1 Shared Reconciliation Orchestrator
 *
 * Encapsulates the full rebuilt reconciliation path:
 *   load reference_figures → adapter → metric derivation
 *   → runReconciliation → magnitude guard → parallel-offset detector
 *   → verification gate → coverage funnel
 *
 * Shared by pipeline-core.ts (production) and diag-reconcile-only.ts (diagnostic).
 * Lifted verbatim from diag-reconcile-only.ts — no reimplementation.
 */

import { z } from "@superblocksteam/sdk-api";
import { runReconciliation, coordKey, normalizePeriod, normalizeClaimValue, type ReconciliationResult, type ReconciliationFinding } from "./claims-reconciliation.js";
import { runVerificationGate, type GateResult, type RefFigCoord } from "./verification-gate.js";
import type { Figure, Discrepancy } from "./numeric-verify-inline.js";
import type { ClaimsLedger } from "./claims-extraction.js";
import type { PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationPipelineInput {
  ctx: PipelineContext;
  dealId: string;
  ledger: ClaimsLedger;
  /** Base figures from NumericVerify (numeric_reports.figures) */
  baseFigures: Figure[];
  /** Discrepancies from NumericVerify (numeric_reports.discrepancies) */
  discrepancies: Discrepancy[];
  /** DB query function: (sql, schema, params, meta) => Promise<rows> */
  queryFn: (sql: string, schema: any, params: any[], meta?: { label: string }) => Promise<any[]>;
  /** Time budget for reconciliation (ms) */
  timeBudgetMs: number;
  /** Start time for elapsed tracking */
  startTime: number;
  /** Primary document ID for provenance ranking */
  primaryDocId?: string;
}

export interface ReconciliationPipelineResult {
  /** Reconciliation output with findings filtered through all gates */
  reconciliation: ReconciliationResult;
  /** All findings that passed the full pipeline (verified) */
  verifiedFindings: ReconciliationFinding[];
  /** Findings held by magnitude guard */
  magnitudeHeld: number;
  /** Findings held by parallel-offset detector */
  parallelOffsetHeld: number;
  /** Verification gate result */
  gateResult: GateResult;
  /** Coverage funnel: unmatchable-by-construction scopes */
  unmatchableScopes: Array<{ scope: string; reason: string; claim_count: number }>;
  /** Metric derivation stats */
  metricDerivation: { claimsRewritten: number; figuresRewritten: number };
  /** Bridge figures count */
  bridgeFiguresCount: number;
  /** Parallel offset audit entries */
  parallelAudit: ParallelAuditEntry[];
  /** Magnitude suppressions (top 10 by ratio) */
  magnitudeSuppressions: Array<{
    claim_scope: string;
    claim_value_m: number;
    figure_scope: string;
    figure_value_m: number;
    ratio: number;
  }>;
  /** Elapsed time (ms) */
  elapsedMs: number;
}

export interface ParallelAuditEntry {
  scope: string;
  periods: Array<{ period: string; claim_value_m: number; model_value_m: number; delta_m: number }>;
  mean_delta_m: number;
  cv: number;
  suspect: boolean;
}

// ---------------------------------------------------------------------------
// Reference figures adapter
// ---------------------------------------------------------------------------

const RefFigRow = z.object({
  document_id: z.string(),
  sheet_name: z.string(),
  metric: z.string(),
  scope_qualifier: z.string(),
  period: z.string(),
  value: z.coerce.number(),
  basis: z.string().nullable(),
});

const PrimaryDocRow = z.object({
  document_id: z.string(),
  file_name: z.string().nullable(),
  document_source: z.string().nullable(),
  document_tag: z.string().nullable(),
  fig_count: z.coerce.number(),
});

/**
 * Resolve the deal's PRIMARY reference document — the model whose figures win
 * first-write-wins in `normalizeFigures`.
 *
 * Ranking rule (deterministic, data-driven — no hardcoded document ids):
 *   1. Only documents that actually contribute rows to `reference_figures`.
 *   2. `document_source = 'pep'` first — the acquirer's own model is authoritative
 *      over the vendor's sellside model (same policy as merge-findings.ts, which
 *      treats `document_source = 'pep'` as an objective source and `'sellside'`
 *      as an advocacy source).
 *   3. Then `document_tag = 'financial_model'`.
 *   4. Then the document contributing the most reference_figures rows.
 *   5. Then `document_id` ascending, so the result is stable across runs.
 *
 * Returns null when the deal has no reference_figures at all — callers then fall
 * back to the sentinel uuid, which makes the CASE arm a no-op and leaves ordering
 * to (sheet_name, period) exactly as before.
 */
export async function resolvePrimaryReferenceDoc(
  queryFn: (sql: string, schema: any, params: any[], meta?: { label: string }) => Promise<any[]>,
  dealId: string,
): Promise<{ documentId: string; fileName: string | null; source: string | null; figCount: number } | null> {
  const rows = await queryFn(
    `SELECT rf.document_id,
            d.file_name,
            d.document_source,
            d.document_tag,
            count(*) AS fig_count
     FROM reference_figures rf
     LEFT JOIN documents d ON d.id = rf.document_id
     WHERE rf.deal_id = $1
       AND rf.sheet_name NOT IN ('Recent_acquisition_overlay')
     GROUP BY rf.document_id, d.file_name, d.document_source, d.document_tag
     ORDER BY CASE WHEN d.document_source = 'pep' THEN 0 ELSE 1 END,
              CASE WHEN d.document_tag = 'financial_model' THEN 0 ELSE 1 END,
              count(*) DESC,
              rf.document_id ASC
     LIMIT 1`,
    PrimaryDocRow,
    [dealId],
    { label: "Resolve primary reference document (provenance ranking)" }
  );

  if (rows.length === 0) return null;
  const top = rows[0] as z.infer<typeof PrimaryDocRow>;
  return {
    documentId: top.document_id,
    fileName: top.file_name,
    source: top.document_source,
    figCount: top.fig_count,
  };
}

/**
 * Load reference_figures from DB and convert to Figure[] with prenorm-encoded names.
 * Provenance-ranked: primary document first (first-write-wins in normalizeFigures).
 */
export async function loadReferenceFigures(
  queryFn: (sql: string, schema: any, params: any[], meta?: { label: string }) => Promise<any[]>,
  dealId: string,
  primaryDocId?: string,
): Promise<{ bridgeFigures: Figure[]; refFigCoords: RefFigCoord[]; rawRows: Array<z.infer<typeof RefFigRow>> }> {
  const refFigRows = await queryFn(
    `SELECT document_id, sheet_name, metric, scope_qualifier, period, value, basis
     FROM reference_figures WHERE deal_id = $1
     AND sheet_name NOT IN ('Recent_acquisition_overlay')
     ORDER BY CASE WHEN document_id = $2 THEN 0 ELSE 1 END, sheet_name, period`,
    RefFigRow,
    [dealId, primaryDocId ?? "00000000-0000-0000-0000-000000000000"],
    { label: "Load reference_figures for reconciler bridge (provenance-ranked, excl. scale-incompatible)" }
  );

  // Convert to Figure[] with prenorm-encoded name:
  // "[prenorm:<metric>:<basis_or_empty>]<scope_qualifier>"
  const bridgeFigures: Figure[] = refFigRows.map(r => ({
    name: `[prenorm:${r.metric}:${r.basis ?? ""}]${r.scope_qualifier}`,
    period: r.period,
    value: r.value,
    source_doc: r.document_id,
    source_cell: "ref_fig",
    source_sheet: r.sheet_name,
  }));

  const refFigCoords: RefFigCoord[] = refFigRows.map(r => ({
    metric: r.metric,
    scope_qualifier: r.scope_qualifier,
    period: r.period,
    basis: r.basis,
  }));

  return { bridgeFigures, refFigCoords, rawRows: refFigRows };
}

// ---------------------------------------------------------------------------
// Metric derivation
// ---------------------------------------------------------------------------

/**
 * Derive metric from scope for segment-qualified entries.
 * Claims extraction mis-tags segment revenue as "other_financial" when the scope
 * already encodes the metric family.
 *
 * MUTATES claims and figures in-place. Returns rewrite counts.
 */
export function applyMetricDerivation(
  ledger: ClaimsLedger,
  bridgeFigures: Figure[],
): { claimsRewritten: number; figuresRewritten: number } {
  let claimsRewritten = 0;
  let figuresRewritten = 0;

  for (const c of ledger.claims) {
    if (c.metric === "other_financial" && c.scope_qualifier) {
      if (/^Revenue \(segment: /i.test(c.scope_qualifier)) {
        c.metric = "revenue";
        claimsRewritten++;
      } else if (/^Gross Profit \(segment: /i.test(c.scope_qualifier)) {
        c.metric = "gross_margin";
        claimsRewritten++;
      }
    }
  }

  // Symmetric: apply to bridge figures' prenorm metric field
  for (const f of bridgeFigures) {
    const prenormMatch = f.name.match(/^\[prenorm:([^:]+):([^\]]*)\](.+)$/);
    if (prenormMatch && prenormMatch[1] === "other_financial") {
      const scope = prenormMatch[3];
      if (/^Revenue \(segment: /i.test(scope)) {
        f.name = `[prenorm:revenue:${prenormMatch[2]}]${scope}`;
        figuresRewritten++;
      } else if (/^Gross Profit \(segment: /i.test(scope)) {
        f.name = `[prenorm:gross_margin:${prenormMatch[2]}]${scope}`;
        figuresRewritten++;
      }
    }
  }

  return { claimsRewritten, figuresRewritten };
}

// ---------------------------------------------------------------------------
// Magnitude guard
// ---------------------------------------------------------------------------

/**
 * Suppress near-miss findings where figure differs from claim by >100x.
 * These are noise — a £352 figure against a £10.3m claim is not a candidate.
 */
export function applyMagnitudeGuard(findings: ReconciliationFinding[]): {
  passed: ReconciliationFinding[];
  rejected: number;
  suppressions: Array<{
    claim_scope: string;
    claim_value_m: number;
    figure_scope: string;
    figure_value_m: number;
    ratio: number;
  }>;
} {
  let rejected = 0;
  const passed: ReconciliationFinding[] = [];
  const suppressions: Array<{
    claim_scope: string;
    claim_value_m: number;
    figure_scope: string;
    figure_value_m: number;
    ratio: number;
  }> = [];

  for (const f of findings) {
    if (f.finding_kind === "scope_mismatch" && f.claim && f.model_figure) {
      const claimVal = Math.abs(f.claim.value * (f.claim.unit === "£m" ? 1_000_000 : f.claim.unit === "£k" ? 1_000 : 1));
      const modelVal = Math.abs(f.model_figure.value);
      if (claimVal > 0 && modelVal > 0) {
        const ratio = claimVal > modelVal ? claimVal / modelVal : modelVal / claimVal;
        if (ratio > 100) {
          rejected++;
          suppressions.push({
            claim_scope: f.claim.scope_qualifier ?? "NONE_STATED",
            claim_value_m: claimVal / 1_000_000,
            figure_scope: f.model_figure.name.replace(/^\[prenorm:[^\]]*\]/, ""),
            figure_value_m: modelVal / 1_000_000,
            ratio: Math.round(ratio),
          });
          continue;
        }
      }
    }
    passed.push(f);
  }

  // Sort suppressions by ratio desc, keep top 10
  suppressions.sort((a, b) => b.ratio - a.ratio);

  return { passed, rejected, suppressions: suppressions.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Parallel-offset detector
// ---------------------------------------------------------------------------

/**
 * Groups data_divergence findings by scope. If a scope has 3+ period observations
 * where all deltas share the same sign with CV < 20%, the mapping is suspect:
 * two parallel series that aren't measuring the same thing.
 */
export function applyParallelOffsetDetector(findings: ReconciliationFinding[]): {
  audit: ParallelAuditEntry[];
  suspectScopes: Set<string>;
  held: ReconciliationFinding[];
  passed: ReconciliationFinding[];
} {
  const parallelScopeMap = new Map<string, Array<{ period: string; claim_val: number; model_val: number }>>();

  for (const f of findings) {
    if (f.finding_kind === "data_divergence" && f.claim && f.model_figure && f.delta_abs !== null) {
      const scope = f.claim.scope_qualifier ?? "NONE_STATED";
      if (!parallelScopeMap.has(scope)) parallelScopeMap.set(scope, []);
      parallelScopeMap.get(scope)!.push({
        period: f.claim.period ?? "",
        claim_val: normalizeClaimValue(f.claim),
        model_val: f.model_figure.value,
      });
    }
  }

  const audit: ParallelAuditEntry[] = [];
  const suspectScopes = new Set<string>();

  for (const [scope, observations] of parallelScopeMap.entries()) {
    if (observations.length < 3) continue;
    const deltas = observations.map(o => o.claim_val - o.model_val);
    const allPositive = deltas.every(d => d > 0);
    const allNegative = deltas.every(d => d < 0);
    if (!allPositive && !allNegative) continue;

    const absDelta = deltas.map(d => Math.abs(d));
    const mean = absDelta.reduce((s, v) => s + v, 0) / absDelta.length;
    if (mean === 0) continue;
    const stdDev = Math.sqrt(absDelta.reduce((s, v) => s + (v - mean) ** 2, 0) / absDelta.length);
    const cv = stdDev / mean;

    const suspect = cv < 0.20;
    audit.push({
      scope,
      periods: observations.map(o => ({
        period: o.period,
        claim_value_m: parseFloat((o.claim_val / 1_000_000).toFixed(2)),
        model_value_m: parseFloat((o.model_val / 1_000_000).toFixed(2)),
        delta_m: parseFloat(((o.claim_val - o.model_val) / 1_000_000).toFixed(2)),
      })),
      mean_delta_m: parseFloat((mean / 1_000_000).toFixed(2)),
      cv: parseFloat(cv.toFixed(3)),
      suspect,
    });
    if (suspect) suspectScopes.add(scope);
  }

  // Suppress findings from suspect scopes
  const held: ReconciliationFinding[] = [];
  const passed = findings.filter(f => {
    if (f.finding_kind === "data_divergence" && f.claim && suspectScopes.has(f.claim.scope_qualifier ?? "")) {
      held.push(f);
      return false;
    }
    return true;
  });

  return { audit, suspectScopes, held, passed };
}

// ---------------------------------------------------------------------------
// Full pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the complete P2.1 reconciliation pipeline:
 * reference_figures → adapter → metric derivation → runReconciliation
 * → magnitude guard → parallel-offset detector → verification gate
 *
 * Returns the enriched ReconciliationResult with findings filtered through all gates.
 */
export async function runReconciliationPipeline(
  input: ReconciliationPipelineInput,
): Promise<ReconciliationPipelineResult> {
  const { ctx, dealId, ledger, baseFigures, discrepancies, queryFn, timeBudgetMs, startTime, primaryDocId } = input;

  // --- Step 0: Resolve primary reference document ---
  // Production call sites (pipeline-core Step 0.8b, post-merge-finalization) do not
  // know which model is authoritative, so resolve it here rather than making every
  // caller thread it through. An explicit `primaryDocId` still wins when supplied.
  let effectivePrimaryDocId = primaryDocId;
  if (!effectivePrimaryDocId) {
    const resolved = await resolvePrimaryReferenceDoc(queryFn, dealId);
    effectivePrimaryDocId = resolved?.documentId;
    console.log(
      `[ReconciliationPipeline] Primary reference doc resolved: ` +
      `${resolved ? `${resolved.documentId} (${resolved.fileName ?? "unknown"}, source=${resolved.source ?? "null"}, ${resolved.figCount} figures)` : "none — no reference_figures for deal"}`
    );
  } else {
    console.log(`[ReconciliationPipeline] Primary reference doc supplied by caller: ${effectivePrimaryDocId}`);
  }

  // --- Step 1: Load reference_figures ---
  const { bridgeFigures, refFigCoords, rawRows } = await loadReferenceFigures(
    queryFn,
    dealId,
    effectivePrimaryDocId,
  );

  // --- Step 2: Metric derivation (MUST precede reconciliation) ---
  const metricDerivation = applyMetricDerivation(ledger, bridgeFigures);

  // --- Step 3: Combine figures ---
  const figures: Figure[] = [...baseFigures, ...bridgeFigures];
  console.log(
    `[ReconciliationPipeline] Loaded: ${ledger.claims.length} claims, ` +
    `${baseFigures.length} base + ${bridgeFigures.length} bridge = ${figures.length} figures, ` +
    `${discrepancies.length} discrepancies. ` +
    `Metric derivation: ${metricDerivation.claimsRewritten} claims, ${metricDerivation.figuresRewritten} figures rewritten.`
  );

  // --- Step 4: Run reconciliation ---
  const reconciliation = await runReconciliation(
    ctx,
    ledger,
    figures,
    discrepancies,
    startTime,
    timeBudgetMs,
    dealId,
  );

  console.log(
    `[ReconciliationPipeline] Reconciliation: ${reconciliation.findings.length} findings ` +
    `(${reconciliation.reconciled_count} reconciled, ` +
    `${reconciliation.within_tolerance_count} within tolerance, ` +
    `${reconciliation.unreconcilable_count} unreconcilable)`
  );

  // --- Step 5: Magnitude guard ---
  const magnitudeResult = applyMagnitudeGuard(reconciliation.findings as ReconciliationFinding[]);
  console.log(`[ReconciliationPipeline] Magnitude guard: ${magnitudeResult.rejected} near-misses rejected (>100x delta)`);

  // --- Step 6: Parallel-offset detector ---
  const parallelResult = applyParallelOffsetDetector(magnitudeResult.passed);
  console.log(
    `[ReconciliationPipeline] Parallel offset: ${parallelResult.audit.length} scopes audited, ` +
    `${parallelResult.suspectScopes.size} suspect, ${parallelResult.held.length} findings held`
  );

  // --- Step 7: Verification gate ---
  // Gate only report-bound findings (data_divergence, cross_version)
  const reportableFindings = parallelResult.passed.filter(
    (f: ReconciliationFinding) => f.finding_kind === "data_divergence" || f.finding_kind === "cross_version"
  );

  // Collect source doc parsed_text for quote integrity check
  const sourceDocNames = new Set<string>();
  for (const f of reportableFindings) {
    if (f.claim?.source_doc) sourceDocNames.add(f.claim.source_doc);
  }

  const parsedTextByDoc = new Map<string, string>();
  if (sourceDocNames.size > 0) {
    const DocTextRow = z.object({ file_name: z.string(), parsed_text: z.string().nullable() });
    const docTextRows = await queryFn(
      `SELECT file_name, parsed_text FROM documents
       WHERE deal_id = $1 AND file_name = ANY($2::text[])`,
      DocTextRow,
      [dealId, Array.from(sourceDocNames)],
      { label: "Load parsed_text for verification gate" }
    );
    for (const row of docTextRows) {
      if (row.parsed_text) {
        parsedTextByDoc.set(row.file_name, row.parsed_text.replace(/\s+/g, " ").trim());
      }
    }
  }

  // Run the gate
  const gateResult = runVerificationGate({
    findings: reportableFindings,
    parsedTextByDoc,
    refFigCoords,
    suspectScopes: parallelResult.suspectScopes,
  });

  console.log(
    `[ReconciliationPipeline] Verification gate: ${gateResult.total_submitted} submitted, ` +
    `${gateResult.verified.length} verified, ${gateResult.rejected.length} rejected ` +
    `(${(gateResult.rejection_rate * 100).toFixed(1)}%). ` +
    `By check: quote=${gateResult.rejection_counts.quote_integrity} fig=${gateResult.rejection_counts.figure_existence} ` +
    `delta=${gateResult.rejection_counts.delta_provenance} source=${gateResult.rejection_counts.source_naming} ` +
    `unit=${gateResult.rejection_counts.unit_coherence} offset=${gateResult.rejection_counts.parallel_offset}`
  );

  // Compose final verified set: gate-verified reportable + non-reportable pass-throughs
  const nonReportable = parallelResult.passed.filter(
    (f: ReconciliationFinding) => f.finding_kind !== "data_divergence" && f.finding_kind !== "cross_version"
  );
  const verifiedFindings = [...gateResult.verified, ...nonReportable];

  // --- Step 8: Coverage funnel (unmatchable-by-construction) ---
  const refScopeMetricSet = new Set(
    rawRows.map(r => `${r.scope_qualifier.toLowerCase()}|||${r.metric.toLowerCase()}`)
  );

  const unmatchableScopes: Array<{ scope: string; reason: string; claim_count: number }> = [];
  // Dedup claims by coordKey for A4 analysis (same logic as runReconciliation)
  const operatingClaims = ledger.claims.filter(c => c.claim_category === "operating_metric");
  const seenKeys = new Set<string>();
  const dedupedClaims: typeof operatingClaims = [];
  for (const c of operatingClaims) {
    const key = coordKey(c.metric, c.scope_qualifier ?? "", c.period ?? "", c.basis ?? null, c.scenario ?? null);
    if (key === null) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedClaims.push(c);
  }

  // Build set of claim coordKeys that produced a meaningful finding
  const claimedCoordKeys = new Set<string>();
  for (const f of magnitudeResult.passed as ReconciliationFinding[]) {
    if (f.claim && f.finding_kind !== "unreconcilable") {
      const fKey = coordKey(
        f.claim.metric, f.claim.scope_qualifier ?? "", f.claim.period ?? "",
        f.claim.basis ?? null, f.claim.scenario ?? null
      );
      if (fKey !== null) claimedCoordKeys.add(fKey);
    }
  }

  // Group unmatched claims by scope
  const scopeCounts = new Map<string, { scope: string; metric: string; count: number }>();
  for (const c of dedupedClaims) {
    const key = coordKey(c.metric, c.scope_qualifier ?? "", c.period ?? "", c.basis ?? null, c.scenario ?? null);
    if (key === null) continue;
    if (claimedCoordKeys.has(key)) continue; // already matched
    const scopeMetricKey = `${(c.scope_qualifier ?? "").toLowerCase()}|||${c.metric.toLowerCase()}`;
    if (refScopeMetricSet.has(scopeMetricKey)) continue; // has counterpart in reference_figures
    const scopeKey = c.scope_qualifier ?? "UNKNOWN";
    if (!scopeCounts.has(scopeKey)) scopeCounts.set(scopeKey, { scope: scopeKey, metric: c.metric, count: 0 });
    scopeCounts.get(scopeKey)!.count++;
  }

  for (const [, entry] of scopeCounts) {
    if (entry.count >= 2) {
      unmatchableScopes.push({
        scope: entry.scope,
        reason: `No ${entry.metric} figure exists at scope "${entry.scope}" in reference_figures`,
        claim_count: entry.count,
      });
    }
  }
  unmatchableScopes.sort((a, b) => b.claim_count - a.claim_count);

  const elapsedMs = Date.now() - startTime;

  return {
    reconciliation,
    verifiedFindings,
    magnitudeHeld: magnitudeResult.rejected,
    parallelOffsetHeld: parallelResult.held.length,
    gateResult,
    unmatchableScopes,
    metricDerivation,
    bridgeFiguresCount: bridgeFigures.length,
    parallelAudit: parallelResult.audit,
    magnitudeSuppressions: magnitudeResult.suppressions,
    elapsedMs,
  };
}
