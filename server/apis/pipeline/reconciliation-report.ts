/**
 * Reconciliation Report Renderer (Item 6)
 * =======================================
 *
 * The one-page memo-vs-model reconciliation report produced when
 * CONTRADICTION_CHECK_PATH === "reconciliation". Replaces the tier-based
 * `formatCanonicalReport` for contradiction_check only; the other four modules
 * continue to use the canonical renderer unchanged.
 *
 * Six sections, in this order:
 *   1. What was audited      — memos, model, extraction provenance
 *   2. Findings              — top 1–2 by deterministic rank, in full
 *   3. Coverage              — the claim funnel, end to end
 *   4. What wasn't reached   — every exclusion, with its count and reason
 *   5. Limitations           — stated plainly, not buried
 *   6. Appendix A            — EVERY finding with its rank and score
 *
 * Design constraints:
 *   • Pure and synchronous. No DB, no network, no LLM. Everything the report
 *     needs is passed in as `ReconciliationReportContext`, mirroring
 *     `formatCanonicalReport`, which is likewise a pure formatter.
 *   • Nothing is dropped. The presentation cap (RECONCILIATION_REPORT_TOP_N)
 *     only decides what appears in §2 in full; the remainder is enumerated in
 *     the appendix with its rank, score, and score components.
 *   • Every number in §3 and §4 is copied from a counter, never recomputed
 *     here. If a count looks wrong, the defect is upstream and the report will
 *     faithfully show it rather than paper over it.
 *   • All timestamps render in Eastern Time.
 */

import type { CoverageDenominator, ReconciliationFinding, ReconciliationResult } from "./claims-reconciliation.js";
import { normalizeClaimValue } from "./claims-reconciliation.js";
import type { RankedReconciliationFinding } from "./reconciliation-ranking.js";
import { appendixFindings, formatRankAudit, presentedFindings } from "./reconciliation-ranking.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ReportDocument {
  file_name: string;
  document_tag?: string | null;
  /** ISO timestamp — documents.created_at. Rendered in ET. */
  ingested_at?: string | null;
}

export interface ReconciliationReportContext {
  /** Deal label for the header. Optional — omitted from the header when absent. */
  dealName?: string | null;

  // ── §1 What was audited ──────────────────────────────────────────────────
  /** Memo-side documents claims were extracted from. */
  memos: ReportDocument[];
  /** Model-side documents figures were read from. */
  modelDocs: ReportDocument[];
  /** Count of verified model figures the claims were adjudicated against. */
  figuresCount?: number | null;
  extraction: {
    /** ClaimsLedger.extraction_metadata.extraction_timestamp */
    timestamp?: string | null;
    /** ClaimsLedger.extraction_metadata.extraction_model */
    model?: string | null;
    docs_processed: number;
    pending: number;
    total_claims: number;
    operating_metric_claims: number;
    /** ClaimsLedger.complete — false means extraction did not finish. */
    complete: boolean;
  };

  // ── §2 / §6 Findings ─────────────────────────────────────────────────────
  /** Every verified finding, already ranked. Rank order is preserved. */
  ranked: RankedReconciliationFinding[];

  // ── §3 Coverage ──────────────────────────────────────────────────────────
  coverage: CoverageDenominator;
  reconciliation: Pick<
    ReconciliationResult,
    | "reconciled_count"
    | "within_tolerance_count"
    | "near_miss_count"
    | "unreconcilable_count"
    | "scope_mismatch_count"
    | "cross_version_findings"
    | "ambiguous_reference_count"
    | "near_miss_unit_rejected"
    | "findings_report_id"
    | "findings_truncated"
    | "matching_error"
  >;

  // ── §4 What wasn't reached ───────────────────────────────────────────────
  holds: {
    /** Findings held by the magnitude guard (scope-scale implausibility). */
    magnitudeHeld: number;
    /** Findings held by the parallel-offset detector. */
    parallelOffsetHeld: number;
  };
  /** Verification gate (6 code checks) outcome. */
  gate: {
    totalSubmitted: number;
    rejectedCount: number;
    rejectionCounts: Record<string, number>;
  };
  /** Ten-gate finding-reduction filter outcome, when it ran. */
  reductionGate?: {
    admitted: number;
    /** `null` when the count could not be recovered — rendered as "not recorded". */
    rejected: number | null;
    byGate?: Record<string, number>;
  } | null;
  /** Scopes that cannot be matched by construction — no model counterpart exists. */
  unmatchableScopes: Array<{ scope: string; reason: string; claim_count: number }>;

  // ── Header / footer metadata ─────────────────────────────────────────────
  timings?: {
    extractionMs?: number | null;
    reconciliationMs?: number | null;
    totalMs?: number | null;
  } | null;
  /** ISO timestamp for the report header. Defaults to now. */
  generatedAt?: string | null;
  /** Presentation cap actually applied, for disclosure in §2. */
  topN?: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Eastern Time, per the app-wide timestamp rule. */
function formatET(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
    return `${s} ET`;
  } catch {
    return d.toISOString();
  }
}

/** Date only, ET. Used for ingestion dates where the clock time adds nothing. */
function formatETDate(iso: string | null | undefined): string {
  if (!iso) return "date not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Raw pounds → £Xm / £Xk. Reconciliation deltas are always in raw £. */
function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `£${(v / 1_000_000).toFixed(1)}m`;
  if (a >= 1_000) return `£${(v / 1_000).toFixed(0)}k`;
  return `£${v.toFixed(0)}`;
}

/** Fraction (0.153) → "15.3%". */
function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}

function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The memo's own stated value, in the memo's own units — never re-based. */
function claimValueLabel(finding: ReconciliationFinding): string {
  const claim = finding.claim;
  if (!claim) return "n/a";
  return `${claim.value}${claim.unit}`;
}

function claimCitation(finding: ReconciliationFinding): string {
  const claim = finding.claim;
  if (!claim) {
    const docs = finding.source_docs?.length ? finding.source_docs.join(", ") : "source not recorded";
    return docs;
  }
  const page = claim.source_page ? `p. ${claim.source_page}` : "page not recorded";
  return `${claim.source_doc} — ${page}`;
}

function figureCitation(finding: ReconciliationFinding): string {
  const fig = finding.model_figure;
  if (!fig) return "no model counterpart";
  const sheet = fig.source_sheet || "sheet not recorded";
  const cell = fig.source_cell || "cell not recorded";
  const doc = fig.source_doc || "model";
  return `${doc} — ${sheet}!${cell}`;
}

/**
 * The one-sentence "what it means" line. Deterministic: direction comes from
 * comparing the normalised claim value against the model figure, magnitude from
 * the code-computed delta. No interpretation is invented beyond the arithmetic.
 */
function meaningSentence(finding: ReconciliationFinding): string {
  const claim = finding.claim;
  const fig = finding.model_figure;

  if (finding.finding_kind === "cross_version") {
    return (
      `The same metric appears with different values across document versions — ` +
      `up to ${money(finding.delta_abs)} apart. One of the documents is stale, or the ` +
      `restatement is intentional and undisclosed.`
    );
  }

  if (finding.finding_kind === "unreconcilable") {
    return (
      `This figure has no counterpart in the model provided, so it could not be checked ` +
      `either way. It is reported so the gap is visible, not as a contradiction.`
    );
  }

  if (finding.finding_kind === "scope_mismatch") {
    return (
      `The memo figure and the nearest model figure are not confirmed to measure the same ` +
      `thing, so no contradiction is asserted. Confirm the intended basis before relying on either.`
    );
  }

  if (!claim || !fig) {
    return `A divergence of ${money(finding.delta_abs)} (${pct(finding.delta_pct)}) was computed between the memo and the model.`;
  }

  const claimVal = normalizeClaimValue(claim);
  const direction = claimVal >= fig.value ? "overstates" : "understates";
  const scope = claim.scope_qualifier && claim.scope_qualifier !== "NONE_STATED"
    ? claim.scope_qualifier
    : claim.metric;

  return (
    `If the model is correct, the memo ${direction} ${scope} for ${claim.period} by ` +
    `${money(finding.delta_abs)} (${pct(finding.delta_pct)}).`
  );
}

function docLine(doc: ReportDocument): string {
  const tag = doc.document_tag ? ` [${doc.document_tag}]` : "";
  return `- **${doc.file_name}**${tag} — ingested ${formatETDate(doc.ingested_at)}`;
}

function countEntries(counts: Record<string, number> | undefined): Array<[string, number]> {
  if (!counts) return [];
  return Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function formatReconciliationReport(ctx: ReconciliationReportContext): string {
  const lines: string[] = [];

  const presented = presentedFindings(ctx.ranked);
  const appendix = appendixFindings(ctx.ranked);
  const cov = ctx.coverage;
  const rec = ctx.reconciliation;

  // UNIT CONTRACT: claims-reconciliation.ts computes coverage_pct as a FRACTION
  // (matched / adjudicable, range 0..1) despite the `_pct` suffix. Its own log
  // line multiplies by 100 before printing. Render must do the same or a 1.1%
  // coverage renders as "0.0%" and reads as total reconciliation failure.
  // Convert once here rather than at each call site.
  const coveragePctDisplay = cov.coverage_pct * 100;
  const coverageWithNearMissPctDisplay = cov.coverage_with_near_miss_pct * 100;

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push("# Memo–Model Reconciliation");
  lines.push("");
  const headerBits: string[] = [];
  if (ctx.dealName) headerBits.push(ctx.dealName);
  headerBits.push(`Generated ${formatET(ctx.generatedAt ?? new Date().toISOString())}`);
  lines.push(`> ${headerBits.join("  ·  ")}`);
  lines.push(
    `> **${ctx.ranked.length} verified finding${ctx.ranked.length !== 1 ? "s" : ""}** · ` +
      `${presented.length} presented below · ${appendix.length} in the appendix`
  );
  lines.push(
    `> Coverage: ${cov.matched} of ${cov.adjudicable} adjudicable claims matched (${coveragePctDisplay.toFixed(1)}%)`
  );
  lines.push("");
  lines.push(
    "This report reconciles the numeric claims in the investment memo against the figures in the " +
      "financial model. It asserts a contradiction only where a claim and a model figure were matched " +
      "at the same coordinate and the delta was computed in code."
  );
  lines.push("");

  // ── §1 What was audited ───────────────────────────────────────────────────
  lines.push("## 1. What was audited");
  lines.push("");
  lines.push("**Memo documents**");
  lines.push("");
  if (ctx.memos.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const doc of ctx.memos) lines.push(docLine(doc));
  }
  lines.push("");
  lines.push("**Model documents**");
  lines.push("");
  if (ctx.modelDocs.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const doc of ctx.modelDocs) lines.push(docLine(doc));
  }
  lines.push("");
  lines.push("**Extraction**");
  lines.push("");
  lines.push(
    `- ${ctx.extraction.total_claims} numeric claims extracted from ` +
      `${ctx.extraction.docs_processed} document${ctx.extraction.docs_processed !== 1 ? "s" : ""}` +
      (ctx.extraction.pending > 0 ? `, ${ctx.extraction.pending} still pending` : "")
  );
  lines.push(
    `- ${ctx.extraction.operating_metric_claims} are operating metrics — the only class that is ` +
      `reconcilable against the operating model`
  );
  lines.push(
    `- Extracted by \`${ctx.extraction.model ?? "model not recorded"}\` at ${formatET(ctx.extraction.timestamp)}`
  );
  if (ctx.figuresCount !== null && ctx.figuresCount !== undefined) {
    lines.push(`- Adjudicated against ${ctx.figuresCount} verified model figures`);
  }
  if (!ctx.extraction.complete) {
    lines.push(
      `- **Extraction did not complete.** Coverage below is relative to the claims that were extracted, not to the memo in full.`
    );
  }
  lines.push("");

  // ── §2 Findings ───────────────────────────────────────────────────────────
  const cap = ctx.topN ?? presented.length;
  lines.push(`## 2. Findings`);
  lines.push("");
  if (presented.length === 0) {
    lines.push(
      "No finding survived to presentation. Either no memo claim diverged from its matched model " +
        "figure, or every candidate divergence was held by a quality gate — see §4."
    );
    lines.push("");
  } else {
    lines.push(
      `Ranked on delta size, delta percentage, and materiality-floor clearance. ` +
        `The top ${presented.length} of ${ctx.ranked.length} ` +
        `${ctx.ranked.length === 1 ? "finding is" : "findings are"} shown in full` +
        (appendix.length > 0 ? `; the remaining ${appendix.length} appear in Appendix A.` : ".")
    );
    lines.push("");

    for (const r of presented) {
      const f = r.finding;
      lines.push(`### Finding ${r.rank} — ${f.title}`);
      lines.push("");

      // Memo side — verbatim, with document and page.
      if (f.claim?.verbatim_snippet) {
        lines.push(`**The memo says:** "${f.claim.verbatim_snippet.trim()}"`);
        lines.push("");
        lines.push(`> Stated value: ${claimValueLabel(f)} · Source: ${claimCitation(f)}`);
      } else {
        lines.push(`**Memo source:** ${claimCitation(f)}`);
      }
      lines.push("");

      // Model side — figure, with sheet and cell.
      if (f.model_figure) {
        lines.push(
          `**The model says:** ${money(f.model_figure.value)} — "${f.model_figure.name}" (${f.model_figure.period})`
        );
        lines.push("");
        lines.push(`> Source: ${figureCitation(f)}`);
      } else {
        lines.push(`**The model says:** no counterpart figure was found.`);
      }
      lines.push("");

      // Delta.
      if (f.delta_abs !== null || f.delta_pct !== null) {
        const floorNote = r.floors.both_cleared
          ? "clears both materiality floors (£2m and 5%)"
          : r.floors.abs_cleared
            ? "clears the £2m absolute floor"
            : r.floors.rel_cleared
              ? "clears the 5% relative floor"
              : "clears neither materiality floor";
        lines.push(`**Delta:** ${money(f.delta_abs)} (${pct(f.delta_pct)}) — ${floorNote}.`);
        lines.push("");
      }

      // Meaning — one sentence.
      lines.push(`**What it means:** ${meaningSentence(f)}`);
      lines.push("");
      lines.push(`_Rank ${r.rank} of ${ctx.ranked.length} · score ${r.score} · ${f.finding_kind}_`);
      lines.push("");
    }

    if (appendix.length > 0 && cap > 0) {
      lines.push(
        `_Presentation cap: ${cap}. Nothing was discarded — every other finding is listed in Appendix A._`
      );
      lines.push("");
    }
  }

  // ── §3 Coverage ───────────────────────────────────────────────────────────
  lines.push("## 3. Coverage");
  lines.push("");
  lines.push("| Stage | Claims |");
  lines.push("| --- | --- |");
  lines.push(`| Extracted from the memo | ${cov.raw_claims} |`);
  lines.push(`| Excluded — not an operating metric | −${cov.category_excluded} |`);
  lines.push(`| In scope for reconciliation | ${cov.in_category} |`);
  lines.push(`| Excluded — scenario-conditional | −${cov.scenario_excluded} |`);
  lines.push(`| Duplicate coordinates collapsed | −${cov.duplicates_collapsed} |`);
  lines.push(`| Distinct claims | ${cov.distinct_claims} |`);
  lines.push(`| Excluded — no stated period | −${cov.no_period_count} |`);
  lines.push(`| **Adjudicable** | **${cov.adjudicable}** |`);
  lines.push(`| Matched to a model figure | ${cov.matched} |`);
  lines.push(`| Near-miss (same metric and period, different scope) | ${cov.near_miss} |`);
  lines.push(`| Unmatched | ${cov.unmatched} |`);
  lines.push("");
  lines.push(
    `**Coverage: ${coveragePctDisplay.toFixed(1)}%** of adjudicable claims matched a model figure ` +
      `(${coverageWithNearMissPctDisplay.toFixed(1)}% counting near-misses, which are reported ` +
      `separately and never asserted as contradictions).`
  );
  lines.push("");
  lines.push("**Adjudication outcomes**");
  lines.push("");
  lines.push(`- ${rec.reconciled_count} matched claims diverged from the model`);
  lines.push(`- ${rec.within_tolerance_count} matched claims agreed with the model within tolerance`);
  lines.push(`- ${rec.near_miss_count} routed to near-miss on a scope difference`);
  lines.push(`- ${rec.scope_mismatch_count} scope or basis mismatches — not comparable`);
  lines.push(`- ${rec.unreconcilable_count} had no model counterpart at all`);
  if (rec.cross_version_findings > 0) {
    lines.push(`- ${rec.cross_version_findings} cross-version disagreements between documents`);
  }
  if (cov.no_scope_count > 0) {
    lines.push(
      `- ${cov.no_scope_count} claims stated no scope qualifier ` +
        `(${cov.no_scope_near_miss_eligible} of which found a near-miss candidate)`
    );
  }
  lines.push("");

  // ── §4 What wasn't reached ────────────────────────────────────────────────
  lines.push("## 4. What wasn't reached");
  lines.push("");
  lines.push(
    "Every exclusion below is deliberate and fail-closed: where the pipeline could not prove a " +
      "comparison was valid, it declined to assert one."
  );
  lines.push("");

  lines.push("**Claims never adjudicated**");
  lines.push("");
  lines.push(`- ${cov.category_excluded} excluded as non-operating-metric claims — no operating-model counterpart exists by construction`);
  const catRows = countEntries(cov.category_breakdown);
  for (const [category, n] of catRows) {
    lines.push(`  - ${category}: ${n}`);
  }
  lines.push(`- ${cov.scenario_excluded} excluded as scenario-conditional (the memo states a sensitivity, not a base-case figure)`);
  lines.push(`- ${cov.no_period_count} excluded for having no stated period — a claim without a period has no coordinate to match on`);
  lines.push(`- ${cov.ambiguous_reference_count} hit an ambiguous model coordinate resolving to multiple disagreeing figures — failed closed rather than guess`);
  if (rec.near_miss_unit_rejected > 0) {
    lines.push(`- ${rec.near_miss_unit_rejected} near-miss candidates rejected on unit incompatibility (e.g. % against £)`);
  }
  lines.push(`- ${cov.unmatched} adjudicable claims found no model figure at their coordinate`);
  lines.push("");

  lines.push("**Candidate findings held by a quality check**");
  lines.push("");
  lines.push(
    `- ${ctx.holds.magnitudeHeld} held by the magnitude guard — the claim and figure differ by an ` +
      `implausible scale factor, indicating a scope mismatch rather than a genuine divergence`
  );
  lines.push(
    `- ${ctx.holds.parallelOffsetHeld} held by the parallel-offset detector — the delta repeats ` +
      `across periods, indicating a systematic basis difference rather than a discrete error`
  );
  lines.push(
    `- ${ctx.gate.rejectedCount} of ${ctx.gate.totalSubmitted} rejected by the six-check verification gate`
  );
  for (const [check, n] of countEntries(ctx.gate.rejectionCounts)) {
    lines.push(`  - ${check.replace(/_/g, " ")}: ${n}`);
  }
  if (ctx.reductionGate) {
    const rejectedLabel =
      ctx.reductionGate.rejected === null
        ? "suppression count not recorded for this run"
        : `${ctx.reductionGate.rejected} rejected`;
    lines.push(
      `- Ten-gate reduction filter: ${ctx.reductionGate.admitted} admitted, ${rejectedLabel}`
    );
    for (const [gate, n] of countEntries(ctx.reductionGate.byGate)) {
      lines.push(`  - ${gate.replace(/_/g, " ")}: ${n}`);
    }
  }
  lines.push("");

  if (ctx.unmatchableScopes.length > 0) {
    lines.push("**Scopes unmatchable by construction**");
    lines.push("");
    lines.push("| Scope | Claims | Why |");
    lines.push("| --- | --- | --- |");
    for (const s of ctx.unmatchableScopes.slice(0, 20)) {
      lines.push(`| ${s.scope} | ${s.claim_count} | ${s.reason} |`);
    }
    if (ctx.unmatchableScopes.length > 20) {
      lines.push(`| _+${ctx.unmatchableScopes.length - 20} more_ | | |`);
    }
    lines.push("");
  }

  // ── §5 Limitations ────────────────────────────────────────────────────────
  lines.push("## 5. Limitations");
  lines.push("");
  lines.push(
    "- **Scope is numeric only.** This report compares stated figures. It does not assess strategy, " +
      "market claims, legal risk, or any qualitative assertion in the memo."
  );
  lines.push(
    "- **The model is treated as the reference.** A finding says the memo and the model disagree. " +
      "It does not establish which is correct — the model may be the one that is wrong or stale."
  );
  lines.push(
    "- **Matching requires an exact coordinate.** A claim is compared only where metric, scope, " +
      "period, and basis all align. Claims whose wording does not resolve to a model coordinate " +
      "are reported as unmatched rather than force-matched."
  );
  lines.push(
    "- **Near-misses are not contradictions.** Where scopes differ, the pair is reported for " +
      "human review and no divergence is asserted."
  );
  lines.push(
    "- **Non-operating claims are out of reach.** Deal mechanics, valuation and structuring, " +
      "returns projections, and cross-references to third-party reports cannot be checked against " +
      "an operating model, and were excluded rather than partially assessed."
  );
  lines.push(
    "- **Coverage is relative to extracted claims.** A claim the extractor never captured cannot be " +
      "counted as unmatched; §3 measures the pipeline, not the memo's full contents."
  );
  lines.push(
    "- **Ranking is presentational.** It orders findings by delta size, delta percentage, and " +
      "materiality-floor clearance. It is not a judgement of deal impact, and it never removes a finding."
  );
  if (rec.matching_error) {
    lines.push(`- **Matching reported an error:** ${rec.matching_error}`);
  }
  if (rec.findings_truncated) {
    lines.push(
      "- **The persisted findings dump was truncated** to stay within the storage guard. The counts " +
        "above are complete; the stored detail is not."
    );
  }
  lines.push("");

  // ── §6 Appendix A — every finding, ranked ─────────────────────────────────
  lines.push(`## Appendix A — All findings by rank (${ctx.ranked.length})`);
  lines.push("");
  if (ctx.ranked.length === 0) {
    lines.push("No findings were produced.");
    lines.push("");
  } else {
    lines.push("| # | Score | Kind | Delta | % | Floors | Finding |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of ctx.ranked) {
      const floors = r.floors.both_cleared
        ? "abs+rel"
        : r.floors.abs_cleared
          ? "abs"
          : r.floors.rel_cleared
            ? "rel"
            : "—";
      const title = r.finding.title.replace(/\|/g, "\\|");
      lines.push(
        `| ${r.rank}${r.presented ? " ★" : ""} | ${r.score} | ${r.finding.finding_kind} | ` +
          `${money(r.finding.delta_abs)} | ${pct(r.finding.delta_pct)} | ${floors} | ${title} |`
      );
    }
    lines.push("");
    lines.push("★ presented in full in §2.");
    lines.push("");
    lines.push("**Score derivation**");
    lines.push("");
    lines.push(
      "`score = class base (100 genuine divergence / 0 housekeeping) + floor clearance " +
        "(40 both / 20 either / 0 neither) + absolute delta (log-scaled, capped 30) + " +
        "delta percentage (linear, capped 20)`. Ties break on absolute delta, then percentage, " +
        "then period, then extraction order — so ranks reproduce exactly across runs."
    );
    lines.push("");
    lines.push("<details><summary>Per-finding score components</summary>");
    lines.push("");
    lines.push("```");
    for (const line of formatRankAudit(ctx.ranked)) lines.push(line);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // ── Footer — provenance ───────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  const footer: string[] = [`Findings dump: \`${rec.findings_report_id}\``];
  if (ctx.timings?.reconciliationMs !== null && ctx.timings?.reconciliationMs !== undefined) {
    footer.push(`reconciliation ${seconds(ctx.timings.reconciliationMs)}`);
  }
  if (ctx.timings?.totalMs !== null && ctx.timings?.totalMs !== undefined) {
    footer.push(`total ${seconds(ctx.timings.totalMs)}`);
  }
  lines.push(`_${footer.join(" · ")}_`);
  lines.push("");

  return lines.join("\n");
}
