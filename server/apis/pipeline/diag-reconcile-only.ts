/**
 * DiagReconcileOnly — reconciliation-only harness.
 *
 * Loads a pre-existing claims ledger and numeric figures from the database,
 * then runs runReconciliation directly. Zero LLM calls. Expected runtime: seconds.
 *
 * Modes:
 *   - "summary" (default): returns coverage, all counts, findings_report_id,
 *     total_findings, total_pages. No findings array.
 *   - "findings": returns paginated findings (10/page).
 *
 * Hard-rejects responses above 20K characters rather than silently truncating.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runReconciliation, coordKey, normalizePeriod, normalizeClaimValue, type ReconciliationFinding } from "./claims-reconciliation.js";
import { runVerificationGate, type GateCheck, type GateResult, type RefFigCoord } from "./verification-gate.js";
import type { Figure, Discrepancy } from "./numeric-verify-inline.js";
import type { ClaimsLedger } from "./claims-extraction.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const FINDINGS_PAGE_SIZE = 10;
const MAX_RESPONSE_CHARS = 20_000;

export default api({
  name: "DiagReconcileOnly",
  description: "Run reconciliation on pre-loaded ledger + figures (no LLM calls)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    // ai declared for PipelineContext type satisfaction — never called
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
    numericReportId: z.string(),
    /** "summary" (default), "findings", or "rollup" (scope-level aggregation) */
    mode: z.enum(["summary", "findings", "rollup"]).nullable(),
    /** 0-based page for findings mode (10/page). Ignored in summary mode. */
    page: z.number().nullable(),
    /** Optional filter: only return findings of this kind */
    finding_kind: z.string().nullable(),
  }),

  output: z.object({
    // --- Always present ---
    ledger_found: z.boolean(),
    ledger_claims_count: z.number(),
    figures_found: z.boolean(),
    figures_count: z.number(),
    discrepancies_count: z.number(),
    elapsed_ms: z.number(),
    matching_error: z.string().nullable(),

    // --- Summary fields (always present when reconciliation ran) ---
    findings_report_id: z.string().nullable(),
    total_findings: z.number(),
    total_pages: z.number(),
    reconciled_count: z.number(),
    unreconcilable_count: z.number(),
    scope_mismatch_count: z.number(),
    within_tolerance_count: z.number(),
    cross_version_findings: z.number(),
    near_miss_count: z.number(),
    ambiguous_reference_count: z.number(),
    coverage: z.object({
      raw_claims: z.number(),
      category_excluded: z.number(),
      category_breakdown: z.record(z.number()),
      in_category: z.number(),
      scenario_excluded: z.number(),
      pre_dedup: z.number(),
      duplicates_collapsed: z.number(),
      distinct_claims: z.number(),
      no_scope_count: z.number(),
      no_scope_near_miss_eligible: z.number(),
      no_period_count: z.number(),
      ambiguous_reference_count: z.number(),
      adjudicable: z.number(),
      matched: z.number(),
      near_miss: z.number(),
      unmatched: z.number(),
      coverage_pct: z.number(),
      coverage_with_near_miss_pct: z.number(),
    }).nullable(),

    // --- A4: Funnel annotations (always present when reconciliation ran) ---
    unmatchable_by_construction: z.object({
      count: z.number(),
      scopes: z.array(z.object({
        scope: z.string(),
        reason: z.string(),
        claim_count: z.number(),
      })),
    }).nullable(),

    // --- Findings mode only ---
    pagination: z.object({
      page: z.number(),
      page_size: z.number(),
      total_findings: z.number(),
      total_pages: z.number(),
      finding_kind_filter: z.string().optional(),
    }).nullable(),
    findings: z.array(z.object({
      finding_kind: z.string(),
      severity: z.string(),
      title: z.string(),
      detail: z.string(),
      full_analysis: z.string(),
      claim_metric: z.string().nullable(),
      claim_scope: z.string().nullable(),
      claim_period: z.string().nullable(),
      claim_value: z.string().nullable(),
      claim_source_doc: z.string().nullable(),
      model_label: z.string().nullable(),
      model_period: z.string().nullable(),
      model_value_m: z.string().nullable(),
      delta_abs_m: z.string().nullable(),
      delta_pct: z.string().nullable(),
      source_docs: z.array(z.string()),
    })).nullable(),

    // --- Rollup mode only ---
    rollup: z.array(z.object({
      scope_qualifier: z.string(),
      metric: z.string(),
      claim_count: z.number(),
      matched: z.number(),
      near_miss: z.number(),
      unmatched: z.number(),
      within_tolerance: z.number(),
      mean_delta_pct: z.number().nullable(),
      max_delta_pct: z.number().nullable(),
      figure_exists_in_ref: z.boolean(),
    })).nullable(),

    // Rollup mode: number of scopes suppressed beyond top 30
    rollup_suppressed_count: z.number().nullable(),

    // --- Metric derivation stats (Item 1) ---
    metric_derivation: z.object({
      claims_rewritten: z.number(),
      figures_rewritten: z.number(),
    }).nullable(),

    // --- Near-miss unit compatibility guard (1.1) ---
    near_miss_unit_rejected: z.number().nullable(),

    // --- Near-miss magnitude guard (Item 4) ---
    near_miss_magnitude_rejected: z.number().nullable(),

    // --- Item 7: Top magnitude-guard suppressions ---
    magnitude_suppressions: z.array(z.object({
      claim_scope: z.string(),
      claim_value_m: z.number(),
      figure_scope: z.string(),
      figure_value_m: z.number(),
      ratio: z.number(),
    })).nullable(),

    // --- Near-miss scope pairs (Item 5) ---
    near_miss_pairs: z.array(z.object({
      claim_scope: z.string(),
      figure_scope: z.string(),
      count: z.number(),
    })).nullable(),

    // --- Part 2: Parallel offset audit ---
    parallel_offset_audit: z.array(z.object({
      scope: z.string(),
      periods: z.array(z.object({
        period: z.string(),
        claim_value_m: z.number(),
        model_value_m: z.number(),
        delta_m: z.number(),
      })),
      mean_delta_m: z.number(),
      cv: z.number(),
      suspect: z.boolean(),
    })).nullable(),
    parallel_offset_held: z.number().nullable(),

    // --- Part 3: Verification gate ---
    verification_gate: z.object({
      total_submitted: z.number(),
      verified_count: z.number(),
      rejected_count: z.number(),
      rejection_rate: z.number(),
      rejection_counts: z.object({
        quote_integrity: z.number(),
        figure_existence: z.number(),
        delta_provenance: z.number(),
        source_naming: z.number(),
        unit_coherence: z.number(),
        parallel_offset: z.number(),
      }),
      rejected_sample: z.array(z.object({
        check: z.string(),
        reason: z.string(),
        claim_scope: z.string().nullable(),
        claim_period: z.string().nullable(),
      })).nullable(),
      held_upstream: z.number(),
    }).nullable(),

    // --- Item 10: Period axis analysis ---
    period_axis: z.object({
      total_claims: z.number(),
      matchable_period: z.number(),
      period_no_counterpart: z.number(),
      range_period: z.number(),
      quarterly_monthly: z.number(),
      unstructured: z.number(),
    }).nullable(),
  }),

  async run(ctx, { dealId, numericReportId, mode, page, finding_kind }) {
    const startTime = Date.now();
    const resolvedMode = mode ?? "summary";
    const pageNum = page ?? 0;

    // --- Step 1: Load ledger from diag_claims_ledger ---
    const LedgerRow = z.object({ ledger: z.any() });
    const ledgerRows = await ctx.integrations.db.query(
      `SELECT ledger FROM diag_claims_ledger WHERE deal_id = $1 LIMIT 1`,
      LedgerRow,
      [dealId],
      { label: "Load claims ledger" }
    );

    if (ledgerRows.length === 0) {
      return emptyResult(Date.now() - startTime, false, true);
    }

    const rawLedger = ledgerRows[0].ledger;
    const ledger: ClaimsLedger = typeof rawLedger === "string" ? JSON.parse(rawLedger) : rawLedger;

    // --- Step 2: Load figures from numeric_reports ---
    const ReportRow = z.object({ figures: z.any(), discrepancies: z.any() });
    const reportRows = await ctx.integrations.db.query(
      `SELECT figures, discrepancies FROM numeric_reports WHERE id = $1 LIMIT 1`,
      ReportRow,
      [numericReportId],
      { label: "Load numeric report figures" }
    );

    if (reportRows.length === 0) {
      return emptyResult(Date.now() - startTime, true, false, ledger.claims.length);
    }

    const rawFigures = typeof reportRows[0].figures === "string"
      ? JSON.parse(reportRows[0].figures)
      : reportRows[0].figures;
    const rawDisc = typeof reportRows[0].discrepancies === "string"
      ? JSON.parse(reportRows[0].discrepancies)
      : reportRows[0].discrepancies;

    const baseFigures: Figure[] = Array.isArray(rawFigures) ? rawFigures : [];
    const discrepancies: Discrepancy[] = Array.isArray(rawDisc) ? rawDisc : [];

    // --- Step 2b: Load reference_figures as supplementary bridge figures ---
    // reference_figures stores 2,242 segment-level figures already in claims vocabulary.
    // We convert them to Figure[] with prenorm-encoded names so normalizeFigures passes
    // them through directly (metric + scope_qualifier + period already resolved).
    //
    // Item 8: Provenance ranking — ORDER BY places primary document first.
    // When multiple figures share a coordKey, the first inserted (primary doc)
    // wins in the figureIndex (first-write-wins in normalizeFigures / coordKey build).
    const PRIMARY_DOC = "3ea34aa1-6617-4d95-ae3c-5225d3da0387";
    const RefFigRow = z.object({
      document_id: z.string(),
      sheet_name: z.string(),
      metric: z.string(),
      scope_qualifier: z.string(),
      period: z.string(),
      value: z.coerce.number(),
      basis: z.string().nullable(),
    });
    const refFigRows = await ctx.integrations.db.query(
      `SELECT document_id, sheet_name, metric, scope_qualifier, period, value, basis
       FROM reference_figures WHERE deal_id = $1
       AND sheet_name NOT IN ('Recent_acquisition_overlay')
       ORDER BY CASE WHEN document_id = $2 THEN 0 ELSE 1 END, sheet_name, period`,
      RefFigRow,
      [dealId, PRIMARY_DOC],
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

    // Combine: numeric_reports figures (group-level) + reference_figures (segment-level)
    const figures: Figure[] = [...baseFigures, ...bridgeFigures];

    // --- Step 2c: Derive metric from scope for segment-qualified entries ---
    // Claims extraction mis-tags segment revenue as "other_financial" when the scope
    // already encodes the metric family. Rule (narrow, deterministic):
    //   metric==="other_financial" AND scope matches Revenue (segment: → revenue
    //   metric==="other_financial" AND scope matches Gross Profit (segment: → gross_margin
    // Applied symmetrically to claims and figures.
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
    // (shouldn't fire — stage5 already assigns correct metric — but ensures parity)
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

    console.log(
      `[DiagReconcileOnly] Loaded: ${ledger.claims.length} claims, ${baseFigures.length} base + ${bridgeFigures.length} bridge = ${figures.length} figures, ${discrepancies.length} discrepancies`
    );
    console.log(
      `[DiagReconcileOnly] Metric derivation: ${claimsRewritten} claims rewritten, ${figuresRewritten} figures rewritten`
    );

    // --- Step 3: Run reconciliation (pure in-memory — no LLM) ---
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    const result = await runReconciliation(
      pipelineCtx,
      ledger,
      figures,
      discrepancies,
      startTime,
      60_000, // 60s budget
      dealId,
    );

    const elapsed = Date.now() - startTime;

    // --- Item 4: Near-miss magnitude guard ---
    // Suppress any scope_mismatch (near-miss) finding where the figure value
    // differs from the claim value by more than 100x in either direction.
    // These are noise — a £352 figure against a £10.3m claim is not a candidate.
    let magnitudeRejected = 0;
    const findingsFiltered: ReconciliationFinding[] = [];
    // Item 7: Capture suppressed findings for reporting
    const magnitudeSuppressed: Array<{
      claim_scope: string;
      claim_value_m: number;
      figure_scope: string;
      figure_value_m: number;
      ratio: number;
    }> = [];
    for (const f of result.findings as ReconciliationFinding[]) {
      if (f.finding_kind === "scope_mismatch" && f.claim && f.model_figure) {
        const claimVal = Math.abs(f.claim.value * (f.claim.unit === "£m" ? 1_000_000 : f.claim.unit === "£k" ? 1_000 : 1));
        const modelVal = Math.abs(f.model_figure.value);
        if (claimVal > 0 && modelVal > 0) {
          const ratio = claimVal > modelVal ? claimVal / modelVal : modelVal / claimVal;
          if (ratio > 100) {
            magnitudeRejected++;
            magnitudeSuppressed.push({
              claim_scope: f.claim.scope_qualifier ?? "NONE_STATED",
              claim_value_m: claimVal / 1_000_000,
              figure_scope: f.model_figure.name.replace(/^\[prenorm:[^\]]*\]/, ""),
              figure_value_m: modelVal / 1_000_000,
              ratio: Math.round(ratio),
            });
            continue; // suppress this finding
          }
        }
      }
      findingsFiltered.push(f);
    }

    // Replace result.findings with filtered set for downstream processing
    const effectiveFindings = findingsFiltered;
    // Sort suppressions by ratio desc, keep top 10
    magnitudeSuppressed.sort((a, b) => b.ratio - a.ratio);
    const topMagnitudeSuppressed = magnitudeSuppressed.slice(0, 10);
    console.log(
      `[DiagReconcileOnly] Magnitude guard: ${magnitudeRejected} near-misses rejected (>100x delta)`
    );

    // --- Item 5: Near-miss scope pairs ---
    // For each scope_mismatch finding, record claim_scope → figure_scope pair.
    const pairCounts = new Map<string, { claim_scope: string; figure_scope: string; count: number }>();
    for (const f of effectiveFindings) {
      if (f.finding_kind === "scope_mismatch" && f.claim && f.model_figure) {
        const claimScope = f.claim.scope_qualifier ?? "NONE_STATED";
        // Extract figure scope from prenorm name or raw name
        const figName = f.model_figure.name;
        const figScope = figName.replace(/^\[prenorm:[^\]]*\]/, "");
        const pairKey = `${claimScope}|||${figScope}`;
        if (!pairCounts.has(pairKey)) {
          pairCounts.set(pairKey, { claim_scope: claimScope, figure_scope: figScope, count: 0 });
        }
        pairCounts.get(pairKey)!.count++;
      }
    }
    const nearMissPairs = [...pairCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 30); // Top 30 pairs

    // --- Part 2: Parallel offset detector ---
    // Groups data_divergence findings by scope. If a scope has 3+ period observations
    // where all deltas share the same sign with CV < 20%, the mapping is suspect:
    // two parallel series that aren't measuring the same thing.
    interface ParallelAuditEntry {
      scope: string;
      periods: Array<{ period: string; claim_value_m: number; model_value_m: number; delta_m: number }>;
      mean_delta_m: number;
      cv: number;
      suspect: boolean;
    }
    const parallelScopeMap = new Map<string, Array<{ period: string; claim_val: number; model_val: number }>>();
    for (const f of effectiveFindings) {
      if ((f.finding_kind === "data_divergence" || (f.finding_kind === "scope_mismatch" && f.delta_abs !== null && f.delta_abs > 0))
          && f.claim && f.model_figure && f.delta_abs !== null) {
        // Only consider findings where claim matched by coordKey (not near-miss)
        // data_divergence findings are direct coordinate matches
        if (f.finding_kind !== "data_divergence") continue;
        const scope = f.claim.scope_qualifier ?? "NONE_STATED";
        if (!parallelScopeMap.has(scope)) parallelScopeMap.set(scope, []);
        parallelScopeMap.get(scope)!.push({
          period: f.claim.period ?? "",
          claim_val: normalizeClaimValue(f.claim),
          model_val: f.model_figure.value,
        });
      }
    }

    const parallelAudit: ParallelAuditEntry[] = [];
    const suspectScopes = new Set<string>();

    for (const [scope, observations] of parallelScopeMap.entries()) {
      if (observations.length < 3) continue;
      // Compute signed deltas (claim - model)
      const deltas = observations.map(o => o.claim_val - o.model_val);
      const allPositive = deltas.every(d => d > 0);
      const allNegative = deltas.every(d => d < 0);
      if (!allPositive && !allNegative) continue; // mixed signs → not parallel

      const absDelta = deltas.map(d => Math.abs(d));
      const mean = absDelta.reduce((s, v) => s + v, 0) / absDelta.length;
      if (mean === 0) continue;
      const stdDev = Math.sqrt(absDelta.reduce((s, v) => s + (v - mean) ** 2, 0) / absDelta.length);
      const cv = stdDev / mean;

      const suspect = cv < 0.20;
      const entry: ParallelAuditEntry = {
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
      };
      parallelAudit.push(entry);
      if (suspect) suspectScopes.add(scope);
    }

    // Suppress findings from suspect scopes
    const preSuppressCount = effectiveFindings.length;
    const suspectSuppressed: typeof effectiveFindings = [];
    const cleanedFindings = effectiveFindings.filter(f => {
      if (f.finding_kind === "data_divergence" && f.claim && suspectScopes.has(f.claim.scope_qualifier ?? "")) {
        suspectSuppressed.push(f);
        return false;
      }
      return true;
    });
    console.log(`[DiagReconcileOnly] Parallel offset: ${parallelAudit.length} scopes audited, ${suspectScopes.size} suspect, ${suspectSuppressed.length} findings held`);

    // --- Part 3: Verification Gate ---
    // Gate only report-bound findings (post-Part-2 cleanedFindings).
    // Part 2 holds are reported separately as held_upstream.
    // parallel_offset check remains active — catches any new suspect scope that appears mid-run.
    const reportableFindings = cleanedFindings.filter(
      (f: ReconciliationFinding) => f.finding_kind === "data_divergence" || f.finding_kind === "cross_version"
    );

    // Collect unique source_doc filenames from reportable findings
    const sourceDocNames = new Set<string>();
    for (const f of reportableFindings) {
      if (f.claim?.source_doc) sourceDocNames.add(f.claim.source_doc);
    }

    // Query parsed_text (whitespace-collapsed at query time for efficiency)
    const parsedTextByDoc = new Map<string, string>();
    if (sourceDocNames.size > 0) {
      const DocTextRow = z.object({ file_name: z.string(), parsed_text: z.string().nullable() });
      const docNames = Array.from(sourceDocNames);
      const docTextRows = await ctx.integrations.db.query(
        `SELECT file_name, parsed_text FROM documents
         WHERE deal_id = $1 AND file_name = ANY($2::text[])`,
        DocTextRow,
        [dealId, docNames],
        { label: "Load parsed_text for verification gate" }
      );
      for (const row of docTextRows) {
        if (row.parsed_text) {
          // Collapse whitespace once for all subsequent substring checks
          parsedTextByDoc.set(row.file_name, row.parsed_text.replace(/\s+/g, " ").trim());
        }
      }
    }

    // Build ref fig coords for figure existence check
    const refFigCoords: RefFigCoord[] = refFigRows.map(r => ({
      metric: r.metric,
      scope_qualifier: r.scope_qualifier,
      period: r.period,
      basis: r.basis,
    }));

    // Run the gate
    const gateResult = runVerificationGate({
      findings: reportableFindings,
      parsedTextByDoc,
      refFigCoords,
      suspectScopes,
    });

    console.log(
      `[DiagReconcileOnly] Verification gate: ${gateResult.total_submitted} submitted, ` +
      `${gateResult.verified.length} verified, ${gateResult.rejected.length} rejected ` +
      `(${(gateResult.rejection_rate * 100).toFixed(1)}%). ` +
      `By check: quote=${gateResult.rejection_counts.quote_integrity} fig=${gateResult.rejection_counts.figure_existence} ` +
      `delta=${gateResult.rejection_counts.delta_provenance} source=${gateResult.rejection_counts.source_naming} ` +
      `unit=${gateResult.rejection_counts.unit_coherence} offset=${gateResult.rejection_counts.parallel_offset}`
    );

    // Replace cleanedFindings with gate-verified findings for downstream
    // Non-reportable findings (scope_mismatch, unreconcilable) pass through unchanged
    const nonReportable = cleanedFindings.filter(
      (f: ReconciliationFinding) => f.finding_kind !== "data_divergence" && f.finding_kind !== "cross_version"
    );
    const gatedFindings = [...gateResult.verified, ...nonReportable];

    // Build gate summary for output
    const gateSummary = {
      total_submitted: gateResult.total_submitted,
      verified_count: gateResult.verified.length,
      rejected_count: gateResult.rejected.length,
      rejection_rate: parseFloat(gateResult.rejection_rate.toFixed(4)),
      rejection_counts: gateResult.rejection_counts,
      rejected_sample: gateResult.rejected.length > 0
        ? gateResult.rejected.slice(0, 20).map(r => ({
            check: r.check,
            reason: r.reason,
            claim_scope: r.finding.claim?.scope_qualifier ?? null,
            claim_period: r.finding.claim?.period ?? null,
          }))
        : null,
      held_upstream: suspectSuppressed.length,
    };

    // --- Item 10: Period axis analysis ---
    // Classify all operating_metric claims by period recoverability:
    // matchable: normalizes to a period present in reference_figures
    // range_period: multi-year range (FY23-25, FY26-FY31) — potentially derivable via sum/CAGR
    // quarterly_monthly: sub-annual (Q1-26, Dec-25, Jun-26) — no model counterpart
    // unstructured: non-temporal (current, CY, L3Y, NONE_STATED, Deal signing, etc.)
    const modelPeriods = new Set(refFigRows.map(r => r.period));
    const operatingClaimsAll = ledger.claims.filter(c => c.claim_category === "operating_metric");
    let periodMatchable = 0;
    let periodNoCounterpart = 0;
    let periodRange = 0;
    let periodQuarterlyMonthly = 0;
    let periodUnstructured = 0;
    const rangeRe = /\d{2,4}\s*[-\u2013to]+\s*(?:fy\s*)?(?:mar[-\s]?)?\d{2,4}/i;
    const subAnnualRe = /^(Q[1-4]|Jan|Feb|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|LTM)[-\s]?\d{2,4}/i;

    for (const c of operatingClaimsAll) {
      const period = c.period ?? "";
      if (!period || period === "NONE_STATED" || period === "UNDATED") {
        periodUnstructured++;
        continue;
      }
      const normalized = normalizePeriod(period);
      if (modelPeriods.has(normalized)) {
        periodMatchable++;
      } else if (rangeRe.test(period)) {
        periodRange++;
      } else if (subAnnualRe.test(period)) {
        periodQuarterlyMonthly++;
      } else {
        // Check if it's a single-period that just doesn't have a counterpart
        // vs truly unstructured (current, CY, L3Y, historical, etc.)
        const looksLikeFiscalPeriod = /^(fy|mar|20\d{2}|\d{2})\s*[-\s]?\d{0,4}/i.test(period);
        if (looksLikeFiscalPeriod) {
          periodNoCounterpart++;
        } else {
          periodUnstructured++;
        }
      }
    }

    const periodAxis = {
      total_claims: operatingClaimsAll.length,
      matchable_period: periodMatchable,
      period_no_counterpart: periodNoCounterpart,
      range_period: periodRange,
      quarterly_monthly: periodQuarterlyMonthly,
      unstructured: periodUnstructured,
    };
    console.log(`[DiagReconcileOnly] Period axis: matchable=${periodMatchable}, range=${periodRange}, quarterly=${periodQuarterlyMonthly}, no_counterpart=${periodNoCounterpart}, unstructured=${periodUnstructured}`);

    const totalPages = Math.ceil(gatedFindings.length / FINDINGS_PAGE_SIZE);

    // --- A4: Detect unmatchable-by-construction scopes ---
    // Evidence-based: a scope is unmatchable only when NO figure exists at that
    // metric+period in reference_figures across all sheets. Scopes with a figure
    // present (even at a different scope_qualifier) are near-miss or derivable.
    //
    // ITEM 2 FIX: Iterate the DEDUPLICATED claim set (excluding scenarios and
    // coordinate duplicates) so unmatchable ≤ adjudicable and all funnel buckets
    // sum correctly. Uses the same coordKey dedup logic as runReconciliation.
    const RefCheckRow = z.object({ scope_qualifier: z.string(), metric: z.string() });
    const refScopeMetrics = await ctx.integrations.db.query(
      `SELECT DISTINCT scope_qualifier, COALESCE(metric, 'unknown') AS metric FROM reference_figures WHERE deal_id = $1`,
      RefCheckRow,
      [dealId],
      { label: "Load reference scope+metric pairs for A4" }
    );
    // Build lookup: scope_qualifier (lowercased) → set of metrics present
    const refScopeMetricSet = new Set(
      refScopeMetrics.map(r => `${r.scope_qualifier.toLowerCase()}|||${r.metric.toLowerCase()}`)
    );
    // Also track all scopes regardless of metric for broad existence check
    const refScopeSet = new Set(refScopeMetrics.map(r => r.scope_qualifier.toLowerCase()));
    // And all metrics in the reference set
    const refMetricSet = new Set(refScopeMetrics.map(r => r.metric.toLowerCase()));

    const unmatchableHits: Array<{ scope: string; reason: string; claim_count: number }> = [];
    if (ledger.claims) {
      // ITEM 2: Replicate the dedup from runReconciliation (Step 1 + 1b):
      // filter to operating_metric → exclude scenario claims → dedup by coordKey.
      const operatingClaims = ledger.claims.filter(c => c.claim_category === "operating_metric");
      const dedupedForA4: typeof operatingClaims = [];
      const seenKeys = new Set<string>();
      for (const c of operatingClaims) {
        const key = coordKey(c.metric, c.scope_qualifier ?? "", c.period ?? "", c.basis ?? null, c.scenario ?? null);
        if (key === null) continue; // scenario claims excluded
        if (seenKeys.has(key)) continue; // duplicate coordinate
        seenKeys.add(key);
        dedupedForA4.push(c);
      }

      // A2 fix: Only count claims that are truly UNMATCHED (not in any finding).
      // Build set of claim coordKeys that produced a MEANINGFUL finding (matched,
      // near-miss, cross_version). "unreconcilable" findings represent claims with
      // NO model counterpart — they are effectively unmatched and should be eligible
      // for unmatchable_by_construction classification.
      const claimedCoordKeys = new Set<string>();
      for (const f of effectiveFindings as ReconciliationFinding[]) {
        if (f.claim && f.finding_kind !== "unreconcilable") {
          const fKey = coordKey(
            f.claim.metric, f.claim.scope_qualifier ?? "", f.claim.period ?? "",
            f.claim.basis ?? null, f.claim.scenario ?? null
          );
          if (fKey !== null) claimedCoordKeys.add(fKey);
        }
      }

      // Filter dedupedForA4 to only claims NOT in any finding (truly unmatched)
      const unmatchedClaims = dedupedForA4.filter(c => {
        const key = coordKey(c.metric, c.scope_qualifier ?? "", c.period ?? "", c.basis ?? null, c.scenario ?? null);
        // key should never be null here (scenario claims already excluded), but guard defensively
        return key !== null && !claimedCoordKeys.has(key);
      });

      const scopeCounts = new Map<string, { count: number; metrics: Set<string> }>();
      for (const c of unmatchedClaims) {
        const s = c.scope_qualifier ?? "";
        if (!scopeCounts.has(s)) scopeCounts.set(s, { count: 0, metrics: new Set() });
        const entry = scopeCounts.get(s)!;
        entry.count++;
        if (c.metric) entry.metrics.add(c.metric.toLowerCase());
      }
      for (const [scope, { count, metrics }] of scopeCounts.entries()) {
        // Skip scopes that already matched or near-missed in reconciliation
        // (they're not unmatchable even if evidence is partial)
        const hasAnyRefFigure = refScopeSet.has(scope.toLowerCase());
        if (hasAnyRefFigure) continue; // Figure exists at same scope — matchable or near-miss

        // Check if the metric exists in reference at all — if not, it's a metric
        // the model doesn't track (growth_rate, customer_count, etc.)
        const claimMetrics = [...metrics];
        const metricAbsent = claimMetrics.length > 0 &&
          claimMetrics.every(m => !refMetricSet.has(m));

        if (metricAbsent) {
          unmatchableHits.push({
            scope,
            reason: `Metric(s) [${claimMetrics.join(", ")}] absent from reference_figures entirely`,
            claim_count: count,
          });
        } else {
          // Metric exists but this specific scope does not — either derivable or unmatchable.
          // Apply strict standard: search found no candidate row at any level.
          unmatchableHits.push({
            scope,
            reason: "No figure at this scope_qualifier in reference_figures across all sheets",
            claim_count: count,
          });
        }
      }
    }
    const unmatchableAnnotation = unmatchableHits.length > 0
      ? {
          count: unmatchableHits.reduce((s, h) => s + h.claim_count, 0),
          scopes: unmatchableHits
            .sort((a, b) => b.claim_count - a.claim_count)
            .slice(0, 20),
          total_scopes: unmatchableHits.length,
        }
      : null;

    // --- A5: Build scope-level rollup from findings ---
    let rollupData: Array<{
      scope_qualifier: string;
      metric: string;
      claim_count: number;
      matched: number;
      near_miss: number;
      unmatched: number;
      within_tolerance: number;
      mean_delta_pct: number | null;
      max_delta_pct: number | null;
      figure_exists_in_ref: boolean;
    }> | null = null;

    if (resolvedMode === "rollup") {
      // refScopeSet already loaded in A4 above — reuse it

      // Group findings by claim scope_qualifier + metric
      const rollupMap = new Map<string, {
        scope_qualifier: string;
        metric: string;
        claim_count: number;
        matched: number;
        near_miss: number;
        unmatched: number;
        within_tolerance: number;
        deltas: number[];
      }>();

      for (const f of gatedFindings as ReconciliationFinding[]) {
        if (!f.claim) continue;
        const scope = f.claim.scope_qualifier ?? "NONE_STATED";
        const metric = f.claim.metric ?? "unknown";
        const key = `${scope}|||${metric}`;
        if (!rollupMap.has(key)) {
          rollupMap.set(key, {
            scope_qualifier: scope,
            metric,
            claim_count: 0,
            matched: 0,
            near_miss: 0,
            unmatched: 0,
            within_tolerance: 0,
            deltas: [],
          });
        }
        const entry = rollupMap.get(key)!;
        entry.claim_count++;
        if (f.finding_kind === "data_divergence") entry.matched++;
        else if (f.finding_kind === "scope_mismatch") entry.near_miss++;
        else if (f.finding_kind === "cross_version") entry.matched++;
        else entry.unmatched++;
        if (f.delta_pct != null) entry.deltas.push(f.delta_pct);
      }

      // Also count claims that produced NO findings (pure matches don't emit findings)
      // — these are implicitly "matched" and not in the findings array
      // We derive from the coverage summary: matched = reconciled + within_tolerance
      // But per-scope, we can only attribute findings that were emitted.

      rollupData = Array.from(rollupMap.values())
        .map(e => ({
          scope_qualifier: e.scope_qualifier,
          metric: e.metric,
          claim_count: e.claim_count,
          matched: e.matched,
          near_miss: e.near_miss,
          unmatched: e.unmatched,
          within_tolerance: e.within_tolerance,
          mean_delta_pct: e.deltas.length > 0
            ? e.deltas.reduce((s, d) => s + d, 0) / e.deltas.length
            : null,
          max_delta_pct: e.deltas.length > 0 ? Math.max(...e.deltas) : null,
          figure_exists_in_ref: refScopeSet.has(e.scope_qualifier.toLowerCase()),
        }))
        .sort((a, b) => b.claim_count - a.claim_count);
    }

    // --- Summary fields (common to both modes) ---
    const summary = {
      ledger_found: true,
      ledger_claims_count: ledger.claims.length,
      figures_found: true,
      figures_count: figures.length,
      discrepancies_count: discrepancies.length,
      elapsed_ms: elapsed,
      matching_error: result.matching_error ?? null,
      findings_report_id: result.findings_report_id,
      total_findings: gatedFindings.length,
      total_pages: totalPages,
      reconciled_count: result.reconciled_count,
      unreconcilable_count: result.unreconcilable_count,
      scope_mismatch_count: result.scope_mismatch_count,
      within_tolerance_count: result.within_tolerance_count,
      cross_version_findings: result.cross_version_findings,
      near_miss_count: result.near_miss_count,
      ambiguous_reference_count: result.ambiguous_reference_count,
      coverage: result.coverage,
      metric_derivation: { claims_rewritten: claimsRewritten, figures_rewritten: figuresRewritten },
      near_miss_unit_rejected: result.near_miss_unit_rejected ?? 0,
      near_miss_magnitude_rejected: magnitudeRejected,
      magnitude_suppressions: topMagnitudeSuppressed.length > 0 ? topMagnitudeSuppressed : null,
      near_miss_pairs: nearMissPairs.length > 0 ? nearMissPairs : null,
      period_axis: periodAxis,
      parallel_offset_audit: parallelAudit.length > 0 ? parallelAudit : null,
      parallel_offset_held: suspectSuppressed.length,
      verification_gate: gateSummary,
    };

    // --- Summary mode: no findings array ---
    if (resolvedMode === "summary") {
      const response = {
        ...summary,
        unmatchable_by_construction: unmatchableAnnotation,
        pagination: null,
        findings: null,
        rollup: null,
        rollup_suppressed_count: null,
      };
      enforceResponseSize(response, "summary");
      console.log(`[DiagReconcileOnly] Summary complete in ${elapsed}ms`);
      return response;
    }

    // --- Rollup mode ---
    if (resolvedMode === "rollup") {
      // Cap at top 30 scopes by claim count to stay within 20K transport limit
      const MAX_ROLLUP_SCOPES = 30;
      const cappedRollup = rollupData ? rollupData.slice(0, MAX_ROLLUP_SCOPES) : null;
      const suppressed = rollupData ? Math.max(0, rollupData.length - MAX_ROLLUP_SCOPES) : 0;
      const response = {
        ...summary,
        unmatchable_by_construction: unmatchableAnnotation,
        pagination: null,
        findings: null,
        rollup: cappedRollup,
        rollup_suppressed_count: suppressed,
      };
      enforceResponseSize(response, "rollup");
      console.log(`[DiagReconcileOnly] Rollup complete in ${elapsed}ms — ${cappedRollup?.length ?? 0} scope rows, ${suppressed} suppressed`);
      return response;
    }

    // --- Findings mode: filter + paginate at 10/page ---
    const filteredFindings = finding_kind
      ? gatedFindings.filter((f: ReconciliationFinding) => f.finding_kind === finding_kind)
      : gatedFindings;
    const filteredPages = Math.ceil(filteredFindings.length / FINDINGS_PAGE_SIZE);
    const pagedFindings = filteredFindings.slice(
      pageNum * FINDINGS_PAGE_SIZE,
      (pageNum + 1) * FINDINGS_PAGE_SIZE,
    );

    const formatted = pagedFindings.map((rf: ReconciliationFinding) => ({
      finding_kind: rf.finding_kind,
      severity: rf.severity,
      title: rf.title,
      detail: rf.detail,
      full_analysis: rf.full_analysis,
      claim_metric: rf.claim?.metric ?? null,
      claim_scope: rf.claim?.scope_qualifier ?? null,
      claim_period: rf.claim?.period ?? null,
      claim_value: rf.claim ? `${rf.claim.value}${rf.claim.unit}` : null,
      claim_source_doc: rf.claim?.source_doc ?? null,
      model_label: rf.model_figure?.name
        ? rf.model_figure.name.replace(/^\[prenorm:[^\]]*\]/, "")
        : null,
      model_period: rf.model_figure?.period ?? null,
      model_value_m: rf.model_figure ? `£${(rf.model_figure.value / 1_000_000).toFixed(2)}m` : null,
      delta_abs_m: rf.delta_abs != null ? `£${(rf.delta_abs / 1_000_000).toFixed(2)}m` : null,
      delta_pct: rf.delta_pct != null ? `${(rf.delta_pct * 100).toFixed(1)}%` : null,
      source_docs: rf.source_docs,
    }));

    const response = {
      ...summary,
      unmatchable_by_construction: unmatchableAnnotation,
      pagination: {
        page: pageNum,
        page_size: FINDINGS_PAGE_SIZE,
        total_findings: filteredFindings.length,
        total_pages: filteredPages,
        ...(finding_kind ? { finding_kind_filter: finding_kind } : {}),
      },
      findings: formatted,
      rollup: null,
      rollup_suppressed_count: null,
    };

    enforceResponseSize(response, `findings page ${pageNum}`);
    console.log(`[DiagReconcileOnly] Findings page ${pageNum} complete in ${elapsed}ms`);
    return response;
  },
});

// --- Hard-reject if serialized response exceeds 20K characters ---
function enforceResponseSize(response: unknown, context: string): void {
  const serialized = JSON.stringify(response);
  if (serialized.length > MAX_RESPONSE_CHARS) {
    throw new Error(
      `Response exceeds ${MAX_RESPONSE_CHARS} characters (actual: ${serialized.length}) ` +
      `in ${context} mode. Reduce page size or switch to summary mode.`
    );
  }
}

// --- Helper: empty result for early returns ---
function emptyResult(
  elapsed: number,
  ledgerFound: boolean,
  figuresFound: boolean,
  claimsCount = 0,
) {
  return {
    ledger_found: ledgerFound,
    ledger_claims_count: claimsCount,
    figures_found: figuresFound,
    figures_count: 0,
    discrepancies_count: 0,
    elapsed_ms: elapsed,
    matching_error: ledgerFound ? null : "No ledger found for deal",
    findings_report_id: null,
    total_findings: 0,
    total_pages: 0,
    reconciled_count: 0,
    unreconcilable_count: 0,
    scope_mismatch_count: 0,
    within_tolerance_count: 0,
    cross_version_findings: 0,
    near_miss_count: 0,
    ambiguous_reference_count: 0,
    coverage: null,
    unmatchable_by_construction: null,
    pagination: null,
    findings: null,
    rollup: null,
    rollup_suppressed_count: null,
    metric_derivation: null,
    near_miss_unit_rejected: null,
    near_miss_magnitude_rejected: null,
    magnitude_suppressions: null,
    near_miss_pairs: null,
    period_axis: null,
    parallel_offset_audit: null,
    parallel_offset_held: null,
    verification_gate: null,
  };
}
