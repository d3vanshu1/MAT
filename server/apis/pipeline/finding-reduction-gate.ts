/**
 * FindingReductionGate — Deterministic finding quality filter.
 *
 * A finding may enter the candidate report ONLY if it passes ALL gates:
 *   1. Evidence/provenance completeness
 *   2. Correct authoritative source
 *   3. Period compatibility
 *   4. Scope compatibility
 *   5. Unit compatibility
 *   6. Accounting-basis compatibility
 *   7. Actual/forecast compatibility
 *   8. Genuine contradiction or material change
 *   9. Deduplication/family consolidation
 *  10. Materiality/severity rules
 *
 * Does NOT impose a hard finding-count cap.
 *
 * Output tiers:
 *   - Primary findings → enter IC-facing report
 *   - Secondary observations → retained but not in IC report
 *   - Suppressed/rejected ledger → with reasons
 *
 * Known false-positive patterns rejected:
 *   - SIP Calls "−34.1pp margin collapse"
 *   - £19.5m FY25 gap caused by FY24 mislabelling
 *   - 128% vs 55% market-share contradiction
 *   - Company metric vs market metric
 *   - Segment vs group
 *   - Currency vs operational percentage
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { computeContentHash } from "./source-snapshot.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Known False-Positive Patterns
// ---------------------------------------------------------------------------
export const KNOWN_FALSE_POSITIVE_PATTERNS: FalsePositivePattern[] = [
  {
    id: "sip_calls_margin_collapse",
    description: "SIP Calls −34.1pp margin collapse — misattributed comparison",
    match: (f) => {
      const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`.toLowerCase();
      return text.includes("sip") && text.includes("call") && (text.includes("-34.1") || text.includes("34.1pp") || text.includes("margin collapse"));
    },
  },
  {
    id: "fy25_gap_fy24_mislabel",
    description: "£19.5m FY25 gap caused by FY24 mislabelling",
    match: (f) => {
      const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`.toLowerCase();
      return text.includes("19.5") && (text.includes("mislabel") || text.includes("mis-label") || (text.includes("fy24") && text.includes("fy25") && text.includes("gap")));
    },
  },
  {
    id: "market_share_128_55",
    description: "128% vs 55% market-share contradiction — incompatible metrics",
    match: (f) => {
      const text = `${f.title ?? ""} ${f.detail ?? ""} ${f.full_analysis ?? ""}`.toLowerCase();
      return text.includes("128%") && text.includes("55%") && text.includes("market");
    },
  },
  {
    id: "company_vs_market_metric",
    description: "Company metric vs market metric — incompatible scope",
    match: (f) => {
      const text = `${f.title ?? ""} ${f.detail ?? ""}`.toLowerCase();
      return (text.includes("company") && text.includes("market")) &&
        (text.includes("versus") || text.includes(" vs ") || text.includes("contradiction"));
    },
  },
  {
    id: "segment_vs_group",
    description: "Segment vs group comparison — scope incompatibility",
    match: (f) => {
      const text = `${f.title ?? ""} ${f.detail ?? ""}`.toLowerCase();
      return (text.includes("segment") && text.includes("group")) &&
        (text.includes("versus") || text.includes(" vs ") || text.includes("discrepan"));
    },
  },
  {
    id: "currency_vs_operational_pct",
    description: "Currency amount vs operational percentage — unit incompatibility",
    match: (f) => {
      const evidence = (f.evidence ?? []) as any[];
      if (evidence.length < 2) return false;
      const units = evidence.map((e: any) => (e.unit ?? "").toLowerCase());
      const hasCurrency = units.some(u => u.includes("gbp") || u.includes("usd") || u.includes("million"));
      const hasPct = units.some(u => u.includes("percent") || u.includes("%") || u.includes("basis_points"));
      return hasCurrency && hasPct;
    },
  },
];

// ---------------------------------------------------------------------------
// Gate interfaces
// ---------------------------------------------------------------------------
export interface GateResult {
  passed: boolean;
  gate: string;
  reason?: string;
}

export interface FindingDisposition {
  findingId: string;
  tier: "primary" | "secondary" | "suppressed";
  gates: GateResult[];
  suppressionReason?: string;
  /** For deduplication: the representative finding ID if this is a duplicate */
  representativeId?: string;
}

export interface ReductionResult {
  primaryFindings: any[];
  secondaryObservations: any[];
  suppressedLedger: FindingDisposition[];
  /** Findings reclassified from divergence→confirmation (asserted agreement) */
  confirmations: KindConsistencyResult[];
  /** Deduplication families: representative → member IDs */
  families: Record<string, string[]>;
  /** Gate statistics */
  gateStats: Record<string, { passed: number; failed: number }>;
  /** Ground-truth signals detected */
  groundTruthSignals: string[];
}

interface FalsePositivePattern {
  id: string;
  description: string;
  match: (finding: any) => boolean;
}

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

/** Gate 1: Evidence/provenance completeness */
function gateEvidenceCompleteness(f: any): GateResult {
  const evidence = f.evidence ?? [];
  const sourceDocs = f.source_docs ?? [];
  if (evidence.length === 0 && sourceDocs.length === 0) {
    return { passed: false, gate: "evidence_completeness", reason: "No evidence or source documents" };
  }
  // At least one evidence entry must have a figure and source
  const hasSubstantive = evidence.some((e: any) => e.figure && e.source_doc) || sourceDocs.length > 0;
  if (!hasSubstantive) {
    return { passed: false, gate: "evidence_completeness", reason: "No substantive evidence with figure+source" };
  }
  return { passed: true, gate: "evidence_completeness" };
}

/** Gate 2: Correct authoritative source — must cite a recognized document class */
const VALID_DOCUMENT_CLASSES = new Set([
  "im", "cim", "management_presentation", "financial_model",
  "data_room", "vendor_due_diligence", "management_accounts",
  "annual_report", "statutory_accounts", "board_minutes",
  "operating_model", "forecast_model", "budget",
  "memo", "ic_memo", "term_sheet",
]);

function gateAuthoritativeSource(f: any): GateResult {
  const sourceDocs = f.source_docs ?? [];
  const evidence = f.evidence ?? [];
  const allSources = [
    ...sourceDocs.map((s: any) => typeof s === "object" ? s : { doc_class: "", name: String(s) }),
    ...evidence.map((e: any) => ({ doc_class: e.doc_class ?? "", name: e.source_doc ?? "" })),
  ];

  if (allSources.length === 0) {
    return { passed: false, gate: "authoritative_source", reason: "No source documents cited" };
  }

  // Must have at least one source with a recognized document class
  const hasRecognizedClass = allSources.some((s: any) => {
    const docClass = (s.doc_class ?? "").toLowerCase().replace(/[\s-]/g, "_");
    return VALID_DOCUMENT_CLASSES.has(docClass);
  });

  if (!hasRecognizedClass) {
    // If no structured doc_class, require at minimum a named source document
    const hasNamedSource = allSources.some((s: any) => {
      const name = (s.name ?? "").trim();
      return name.length > 3 && !name.startsWith("[process");
    });
    if (!hasNamedSource) {
      return {
        passed: false,
        gate: "authoritative_source",
        reason: "No recognized authoritative document class or named source"
      };
    }
    // Named source exists but lacks structured doc_class.
    // A cited filename is sufficient provenance — the finding references a real
    // document even though the upstream pipeline didn't tag it with doc_class.
    // Pass the gate; doc_class enrichment is a metadata improvement, not a
    // reason to suppress a finding that clearly cites source material.
    return { passed: true, gate: "authoritative_source" };
  }

  return { passed: true, gate: "authoritative_source" };
}

/** Gate 3: Period compatibility — exact period and period_type validation */
function gatePeriodCompatibility(f: any): GateResult {
  const evidence = f.evidence ?? [];
  if (evidence.length < 2) return { passed: true, gate: "period_compatibility" };

  // Extract structured period data from evidence
  const periodEntries = evidence
    .map((e: any) => ({
      period: (e.period ?? "").trim(),
      period_type: (e.period_type ?? "").trim().toLowerCase(),
    }))
    .filter((p: any) => p.period.length > 0);

  if (periodEntries.length < 2) {
    // Insufficient structured period metadata — fail closed to needs-review
    if (evidence.length >= 2) {
      return {
        passed: false,
        gate: "period_compatibility",
        reason: "Evidence has multiple entries but insufficient structured period metadata to validate compatibility"
      };
    }
    return { passed: true, gate: "period_compatibility" };
  }

  // Check period_type consistency (FY vs HY vs Q vs monthly)
  const periodTypes = [...new Set(periodEntries.map((p: any) => p.period_type).filter(Boolean))];
  if (periodTypes.length > 1) {
    return {
      passed: false,
      gate: "period_compatibility",
      reason: `Incompatible period types compared: ${periodTypes.join(" vs ")}`
    };
  }

  // Check for cross-year comparison without explicit revision context
  const years = periodEntries
    .map((p: any) => {
      const match = p.period.match(/(20\d{2}|FY\d{2})/i);
      return match ? match[0].replace(/FY/i, "20") : null;
    })
    .filter(Boolean);
  const uniqueYears = [...new Set(years)];
  if (uniqueYears.length > 1) {
    // Cross-year comparison — valid only for revision/trend findings
    const kind = (f.finding_kind ?? "").toLowerCase();
    const isRevision = kind.includes("revision") || kind.includes("change") || kind.includes("trend");
    if (!isRevision) {
      return {
        passed: false,
        gate: "period_compatibility",
        reason: `Cross-year comparison (${uniqueYears.join(" vs ")}) without revision/trend classification`
      };
    }
  }

  return { passed: true, gate: "period_compatibility" };
}

/** Gate 4: Scope compatibility */
function gateScopeCompatibility(f: any): GateResult {
  const evidence = f.evidence ?? [];
  if (evidence.length < 2) return { passed: true, gate: "scope_compatibility" };

  const scopes = evidence.map((e: any) => (e.scope ?? "").toLowerCase()).filter((s: string) => s.length > 0);
  if (scopes.length < 2) return { passed: true, gate: "scope_compatibility" };

  // Reject: segment vs group comparison
  const hasSegment = scopes.some((s: string) => s.includes("segment") || s.includes("division"));
  const hasGroup = scopes.some((s: string) => s.includes("group") || s.includes("consolidated") || s.includes("total"));
  if (hasSegment && hasGroup) {
    return { passed: false, gate: "scope_compatibility", reason: "Segment vs group comparison is incompatible" };
  }
  return { passed: true, gate: "scope_compatibility" };
}

/** Gate 5: Unit compatibility */
function gateUnitCompatibility(f: any): GateResult {
  const evidence = f.evidence ?? [];
  if (evidence.length < 2) return { passed: true, gate: "unit_compatibility" };

  const units = evidence.map((e: any) => (e.unit ?? "").toLowerCase()).filter((u: string) => u.length > 0);
  if (units.length < 2) return { passed: true, gate: "unit_compatibility" };

  // Reject: mixing currency amounts with percentages
  const hasCurrency = units.some((u: string) => u.includes("gbp") || u.includes("usd") || u.includes("million") || u.includes("£"));
  const hasPercentage = units.some((u: string) => u.includes("percent") || u.includes("%") || u.includes("basis") || u.includes("pp"));
  if (hasCurrency && hasPercentage) {
    return { passed: false, gate: "unit_compatibility", reason: "Currency amount vs percentage — incompatible units" };
  }
  return { passed: true, gate: "unit_compatibility" };
}

/** Gate 6: Accounting-basis compatibility */
function gateAccountingBasis(f: any): GateResult {
  const evidence = f.evidence ?? [];
  if (evidence.length < 2) return { passed: true, gate: "accounting_basis" };

  const bases = evidence.map((e: any) => (e.accounting_basis ?? "").toLowerCase()).filter((b: string) => b.length > 0);
  if (bases.length < 2) return { passed: true, gate: "accounting_basis" };

  // Reject: comparing reported vs adjusted without disclosure
  const hasReported = bases.some((b: string) => b.includes("reported") || b.includes("statutory"));
  const hasAdjusted = bases.some((b: string) => b.includes("adjusted") || b.includes("underlying"));
  if (hasReported && hasAdjusted) {
    // This is only a rejection if the finding doesn't acknowledge the difference
    const text = `${f.title ?? ""} ${f.detail ?? ""}`.toLowerCase();
    if (!text.includes("adjust") && !text.includes("reported vs")) {
      return { passed: false, gate: "accounting_basis", reason: "Reported vs adjusted comparison without disclosure" };
    }
  }
  return { passed: true, gate: "accounting_basis" };
}

/** Gate 7: Actual/forecast compatibility */
function gateActualForecast(f: any): GateResult {
  const evidence = f.evidence ?? [];
  if (evidence.length < 2) return { passed: true, gate: "actual_forecast" };

  const statuses = evidence.map((e: any) => (e.actual_or_forecast ?? "").toLowerCase()).filter((s: string) => s.length > 0);
  if (statuses.length < 2) return { passed: true, gate: "actual_forecast" };

  const hasActual = statuses.some((s: string) => s.includes("actual") || s.includes("historic"));
  const hasForecast = statuses.some((s: string) => s.includes("forecast") || s.includes("budget") || s.includes("plan"));
  if (hasActual && hasForecast) {
    // Actuals vs forecasts is valid ONLY if the finding is about revision/change
    const text = `${f.title ?? ""} ${f.detail ?? ""}`.toLowerCase();
    if (!text.includes("revis") && !text.includes("change") && !text.includes("update")) {
      return { passed: false, gate: "actual_forecast", reason: "Actual vs forecast comparison without revision context" };
    }
  }
  return { passed: true, gate: "actual_forecast" };
}

/** Gate 8: Genuine contradiction — requires structured disclosure state + numeric delta */
function gateGenuineContradiction(f: any): GateResult {
  const kind = (f.finding_kind ?? "").toLowerCase();
  const severity = (f.severity ?? "").toLowerCase();

  // Info-only observations without structured contradiction classification
  if (severity === "info" && !kind.includes("contradiction") && !kind.includes("discrepancy") && !kind.includes("gap") && !kind.includes("divergence")) {
    return { passed: false, gate: "genuine_contradiction", reason: "Informational observation — no contradiction/discrepancy classification" };
  }

  // Require structured disclosure_status field for genuine determination
  const disclosureStatus = (f.disclosure_status ?? "").toLowerCase();
  if (disclosureStatus === "disclosed" || disclosureStatus === "acknowledged") {
    return { passed: false, gate: "genuine_contradiction", reason: `Finding has disclosure_status='${disclosureStatus}' — not undisclosed` };
  }

  // STRICT FORM: For contradiction/discrepancy findings, require numeric delta proof.
  // Structured evidence is the bar — qualitative detail alone is insufficient.
  // Reconciliation findings carry delta in structured_impact[].role==="delta".
  if (kind.includes("contradiction") || kind.includes("discrepancy") || kind.includes("divergence")) {
    const deltaAbs = (f as any).delta_abs;
    const deltaPct = (f as any).delta_pct;
    const hasTopLevelDelta = (deltaAbs != null && deltaAbs !== 0) || (deltaPct != null && deltaPct !== 0);

    // P2.1: Check structured_impact for verified delta entries
    const structuredImpact: any[] = f.structured_impact ?? [];
    const hasStructuredDelta = structuredImpact.some(
      (si: any) => si.role === "delta" && si.verified === true && si.amount != null && si.amount !== 0
    );

    const hasComparisonBasis = f.comparison_basis != null && String(f.comparison_basis).length > 0;

    if (!hasTopLevelDelta && !hasStructuredDelta && !hasComparisonBasis) {
      return {
        passed: false,
        gate: "genuine_contradiction",
        reason: "Contradiction finding lacks numeric delta (top-level or structured_impact) and comparison_basis — cannot verify genuine inconsistency"
      };
    }
  }

  return { passed: true, gate: "genuine_contradiction" };
}

/** Gate 9: Deduplication — handled at family level, not per-finding */
function gateDeduplication(_f: any): GateResult {
  // Deduplication is handled separately in the family consolidation pass
  return { passed: true, gate: "deduplication" };
}

/** Gate 10: Materiality — requires quantifiable threshold or explicit severity justification */
function gateMateriality(f: any): GateResult {
  const severity = (f.severity ?? "info").toLowerCase();
  const kind = (f.finding_kind ?? "").toLowerCase();

  // Info findings: only contradiction/discrepancy/divergence kinds with structured
  // evidence pass. All others are secondary observations.
  if (severity === "info") {
    const isContradictionKind = kind.includes("contradiction") || kind.includes("discrepancy") || kind.includes("divergence");
    if (!isContradictionKind) {
      return { passed: false, gate: "materiality", reason: "Info-severity findings are secondary observations only" };
    }
    // Info + contradiction kind → still needs structured evidence to be primary
    const structuredImpact: any[] = f.structured_impact ?? [];
    const hasStructuredDelta = structuredImpact.some(
      (si: any) => si.role === "delta" && si.verified === true && si.amount != null
    );
    const hasTopLevelDelta = (f.delta_abs != null && f.delta_abs !== 0) || (f.delta_pct != null && f.delta_pct !== 0);
    const evidence = f.evidence ?? [];
    if (!hasStructuredDelta && !hasTopLevelDelta && evidence.length < 2) {
      return { passed: false, gate: "materiality", reason: "Info-severity contradiction finding lacks structured evidence — secondary" };
    }
    return { passed: true, gate: "materiality" };
  }

  // STRICT FORM: For warning/critical findings, require quantified delta or materiality_basis.
  // structured_impact with role==="delta" counts as quantified delta.
  // Qualitative detail alone is NOT sufficient.
  const deltaAbs = (f as any).delta_abs;
  const deltaPct = (f as any).delta_pct;
  const materialityBasis = (f.materiality_basis ?? "").trim();

  // P2.1: Check structured_impact for verified delta
  const structuredImpact: any[] = f.structured_impact ?? [];
  const hasStructuredDelta = structuredImpact.some(
    (si: any) => si.role === "delta" && si.verified === true && si.amount != null && si.amount !== 0
  );

  if (severity === "critical") {
    const hasQuantifiedDelta = (deltaAbs != null && Math.abs(Number(deltaAbs)) > 0) ||
      (deltaPct != null && Math.abs(Number(deltaPct)) > 0) ||
      hasStructuredDelta;
    if (!hasQuantifiedDelta && !materialityBasis) {
      return {
        passed: false,
        gate: "materiality",
        reason: "Critical finding lacks quantified delta (top-level or structured_impact) and materiality_basis — cannot verify material impact"
      };
    }
  }

  if (severity === "warning") {
    const hasAnyQuantification = (deltaAbs != null) || (deltaPct != null) || materialityBasis || hasStructuredDelta;
    const evidence = f.evidence ?? [];
    if (!hasAnyQuantification && evidence.length < 2) {
      return {
        passed: false,
        gate: "materiality",
        reason: "Warning finding has no quantification (delta, structured_impact, or materiality_basis) and insufficient evidence entries"
      };
    }
  }

  return { passed: true, gate: "materiality" };
}

// All gates in order
const GATES = [
  gateEvidenceCompleteness,
  gateAuthoritativeSource,
  gatePeriodCompatibility,
  gateScopeCompatibility,
  gateUnitCompatibility,
  gateAccountingBasis,
  gateActualForecast,
  gateGenuineContradiction,
  gateDeduplication,
  gateMateriality,
];

// ---------------------------------------------------------------------------
// Ground-truth signals (SCG-specific expected findings)
// Validated using structured fields: issue_key, finding_kind, evidence data.
// Title/detail regex used only as SECONDARY confirmation signal, not primary gate.
// ---------------------------------------------------------------------------
const GROUND_TRUTH_SIGNALS = [
  {
    id: "fy26_revenue_revision",
    match: (f: any) => {
      const key = (f.issue_key ?? "").toLowerCase();
      const kind = (f.finding_kind ?? "").toLowerCase();
      // Primary: structured field match
      if (key.includes("fy26") && key.includes("revenue") && kind.includes("revision")) return true;
      // Secondary: evidence period + metric type
      const evidence = f.evidence ?? [];
      const hasFY26 = evidence.some((e: any) => (e.period ?? "").includes("FY26") || (e.period ?? "").includes("2026"));
      const hasRevenue = evidence.some((e: any) => (e.metric ?? "").toLowerCase().includes("revenue"));
      if (hasFY26 && hasRevenue && kind.includes("revision")) return true;
      return false;
    },
  },
  {
    id: "fy26_ebitda_revision",
    match: (f: any) => {
      const key = (f.issue_key ?? "").toLowerCase();
      const kind = (f.finding_kind ?? "").toLowerCase();
      if (key.includes("fy26") && key.includes("ebitda") && kind.includes("revision")) return true;
      const evidence = f.evidence ?? [];
      const hasFY26 = evidence.some((e: any) => (e.period ?? "").includes("FY26") || (e.period ?? "").includes("2026"));
      const hasEBITDA = evidence.some((e: any) => (e.metric ?? "").toLowerCase().includes("ebitda"));
      if (hasFY26 && hasEBITDA && kind.includes("revision")) return true;
      return false;
    },
  },
  {
    id: "widening_adjustments",
    match: (f: any) => {
      const key = (f.issue_key ?? "").toLowerCase();
      if (key.includes("widen") && key.includes("adjust")) return true;
      const kind = (f.finding_kind ?? "").toLowerCase();
      const hasAdjustmentType = kind.includes("adjustment") || kind.includes("gap");
      const evidence = f.evidence ?? [];
      const hasMultiplePeriods = new Set(evidence.map((e: any) => e.period).filter(Boolean)).size > 1;
      if (hasAdjustmentType && hasMultiplePeriods) return true;
      return false;
    },
  },
  {
    id: "memo_vs_model_revenue",
    match: (f: any) => {
      const key = (f.issue_key ?? "").toLowerCase();
      if (key.includes("memo") && key.includes("model") && key.includes("revenue")) return true;
      // Check evidence sources for memo vs model comparison
      const evidence = f.evidence ?? [];
      const docClasses = evidence.map((e: any) => (e.doc_class ?? "").toLowerCase());
      const hasMemo = docClasses.some((d: string) => d.includes("memo") || d.includes("ic_memo"));
      const hasModel = docClasses.some((d: string) => d.includes("model") || d.includes("financial_model"));
      if (hasMemo && hasModel) return true;
      return false;
    },
  },
  {
    id: "calls_lines_fy26_decline",
    match: (f: any) => {
      const key = (f.issue_key ?? "").toLowerCase();
      if (key.includes("call") && key.includes("line") && key.includes("declin")) return true;
      // Structured: metric=calls/lines + negative delta + FY26 period
      const evidence = f.evidence ?? [];
      const hasCallsMetric = evidence.some((e: any) => (e.metric ?? "").toLowerCase().includes("call"));
      const hasFY26 = evidence.some((e: any) => (e.period ?? "").includes("FY26") || (e.period ?? "").includes("2026"));
      const deltaPct = (f as any).delta_pct;
      const hasDecline = deltaPct != null && Number(deltaPct) < 0;
      if (hasCallsMetric && hasFY26 && hasDecline) return true;
      return false;
    },
  },
];

// ---------------------------------------------------------------------------
// Kind-consistency guard — detects findings that assert agreement but carry
// a contradiction/discrepancy/divergence kind label. Reclassifies them as
// "confirmation" before gates run. This is not a gate; it corrects a
// mislabelling the model applies when it checks for divergence, finds none,
// and reports the check.
// ---------------------------------------------------------------------------
const DIVERGENCE_KINDS = /contradiction|discrepancy|divergence/i;
const AGREEMENT_SIGNALS = [
  /\breconciles?\b/i,
  /\bconsistent(ly)?\b/i,
  /\bverified\b(?!.*\b(delta|discrepan|gap|differ|exceed))/i,  // "verified" only when NOT followed by conflict language
  /\balign(s|ed|ment)?\b/i,
  /\bwell[- ]supported\b/i,
  /\bdocumented and internally consistent\b/i,
  /\bconfirm(s|ed)?\b.*\b(no|zero|immaterial)\b/i,
  /\bno\s+(material\s+)?variance\b/i,
  /\bno\s+contradiction\b/i,
  /\bsupports?\s+the\s+thesis\b/i,
  /\bnarrative\s+anchor\s+verified\b/i,
  /\bnot\s+contradicted\b/i,
];

export interface KindConsistencyResult {
  finding: any;
  originalKind: string;
  matchedSignal: string;
}

/**
 * Returns true if the finding's text asserts agreement/confirmation while its
 * kind label claims divergence. Examines detail and full_analysis.
 */
function isAgreementMislabelled(f: any): { mislabelled: boolean; signal: string } {
  const kind = (f.finding_kind ?? "").toLowerCase();
  if (!DIVERGENCE_KINDS.test(kind)) return { mislabelled: false, signal: "" };

  const text = `${f.detail ?? ""} ${f.full_analysis ?? ""}`;
  for (const pattern of AGREEMENT_SIGNALS) {
    if (pattern.test(text)) {
      // Secondary check: the finding must NOT also contain conflict indicators
      const hasConflict = /\bdiscrepan(cy|cies)\b|\bcontradicts?\b|\bdiverg(es?|ence)\b|\bunderstat(es?|ement)\b|\boverstat(es?|ement)\b|\bmismatch\b|\bexceeds?\b|\b(gap|delta|variance)\s*(of|:|\s+£|\s+\d)/i.test(text);
      if (!hasConflict) {
        return { mislabelled: true, signal: pattern.source };
      }
    }
  }
  return { mislabelled: false, signal: "" };
}

// ---------------------------------------------------------------------------
// Main reduction function
// ---------------------------------------------------------------------------
export function applyReductionGates(findings: any[]): ReductionResult {
  const primaryFindings: any[] = [];
  const secondaryObservations: any[] = [];
  const suppressedLedger: FindingDisposition[] = [];
  const gateStats: Record<string, { passed: number; failed: number }> = {};
  const groundTruthSignals: string[] = [];

  // ── Pre-pass: Kind-consistency guard ─────────────────────────────────────
  // SAFETY PROPERTY: This guard RECLASSIFIES (kind→"confirmation", severity→"info")
  // rather than SUPPRESSES. A wrong call costs a finding its tier, not its existence.
  // The finding remains in the output (confirmations array) and is preserved in the
  // checkpoint. This is intentional — regex heuristics over model-written prose will
  // always have edges (e.g. "zero discrepancy" contains "discrepancy"), and the cost
  // of a false positive is demotion, not data loss. Do NOT convert this to a suppression.
  const confirmations: KindConsistencyResult[] = [];
  const gatedFindings: any[] = [];
  for (const f of findings) {
    const { mislabelled, signal } = isAgreementMislabelled(f);
    if (mislabelled) {
      confirmations.push({
        finding: { ...f, finding_kind: "confirmation", severity: "info" },
        originalKind: f.finding_kind,
        matchedSignal: signal,
      });
    } else {
      gatedFindings.push(f);
    }
  }
  if (confirmations.length > 0) {
    console.log(
      `[ReductionGate] Kind-consistency guard: ${confirmations.length} findings reclassified ` +
      `from divergence→confirmation (${findings.length} total → ${gatedFindings.length} entering gates)`
    );
  }

  // Initialize gate stats
  for (const gate of GATES) {
    const name = gate.name.replace("gate", "").replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    gateStats[name] = { passed: 0, failed: 0 };
  }

  for (const f of gatedFindings) {
    const findingId = f.finding_id ?? f.id ?? "unknown";

    // Check known false-positive patterns first
    const fpMatch = KNOWN_FALSE_POSITIVE_PATTERNS.find(p => p.match(f));
    if (fpMatch) {
      suppressedLedger.push({
        findingId,
        tier: "suppressed",
        gates: [{ passed: false, gate: "false_positive_pattern", reason: fpMatch.description }],
        suppressionReason: `Known false positive: ${fpMatch.id}`,
      });
      continue;
    }

    // Run all gates
    const gateResults: GateResult[] = [];
    let allPassed = true;
    let failedGate: GateResult | null = null;

    for (const gate of GATES) {
      const result = gate(f);
      gateResults.push(result);
      const gateName = gate.name.replace("gate", "").replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
      if (result.passed) {
        gateStats[gateName]!.passed++;
      } else {
        gateStats[gateName]!.failed++;
        if (allPassed) { // First failure
          allPassed = false;
          failedGate = result;
        }
      }
    }

    if (allPassed) {
      primaryFindings.push(f);
    } else if (failedGate?.gate === "materiality" || failedGate?.gate === "genuine_contradiction") {
      // Materiality/info failures become secondary observations
      secondaryObservations.push(f);
      suppressedLedger.push({
        findingId,
        tier: "secondary",
        gates: gateResults,
        suppressionReason: failedGate.reason,
      });
    } else {
      // All other gate failures are suppressed
      suppressedLedger.push({
        findingId,
        tier: "suppressed",
        gates: gateResults,
        suppressionReason: failedGate?.reason ?? "Gate failure",
      });
    }
  }

  // Check ground-truth signals
  for (const signal of GROUND_TRUTH_SIGNALS) {
    const found = primaryFindings.some(f => signal.match(f));
    if (found) groundTruthSignals.push(signal.id);
  }

  // Family consolidation (Gate 9 effective implementation)
  const families = consolidateFamilies(primaryFindings);

  return {
    primaryFindings,
    secondaryObservations,
    suppressedLedger,
    confirmations,
    families,
    gateStats,
    groundTruthSignals,
  };
}

/**
 * Consolidate findings by issue_key into families.
 * One issue → one primary finding with merged_from_finding_ids.
 */
function consolidateFamilies(findings: any[]): Record<string, string[]> {
  const families: Record<string, string[]> = {};
  const byIssueKey = new Map<string, any[]>();

  for (const f of findings) {
    const key = f.issue_key ?? f.finding_id ?? "ungrouped";
    if (!byIssueKey.has(key)) byIssueKey.set(key, []);
    byIssueKey.get(key)!.push(f);
  }

  for (const [key, group] of byIssueKey) {
    if (group.length > 1) {
      // Representative: highest severity, then first by finding_id
      const sorted = group.sort((a: any, b: any) => {
        const sevOrder = { critical: 0, warning: 1, info: 2 };
        const sa = (sevOrder as any)[(a.severity ?? "info").toLowerCase()] ?? 3;
        const sb = (sevOrder as any)[(b.severity ?? "info").toLowerCase()] ?? 3;
        if (sa !== sb) return sa - sb;
        return (a.finding_id ?? "").localeCompare(b.finding_id ?? "");
      });
      const representative = sorted[0];
      const memberIds = sorted.map((f: any) => f.finding_id ?? f.id);
      families[representative.finding_id ?? key] = memberIds;
    }
  }

  return families;
}

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------
export default api({
  name: "FindingReductionGate",
  description: "Applies deterministic quality gates to reduce findings to credible set",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string(),
    /** If provided, uses these findings instead of loading from DB */
    inputFindings: z.array(z.any()).optional(),
  }),

  output: z.object({
    result: z.any(),
  }),

  async run(ctx, { runId, moduleId, inputFindings }) {
    let findings: any[];

    if (inputFindings && inputFindings.length > 0) {
      findings = inputFindings;
    } else {
      // Load findings from the active artifact.
      // Fix 11: FAIL CLOSED — requires migration 019 (artifact_status column).
      // Do not silently select a row under the legacy lifecycle schema.
      let artifactRows: { findings?: any }[];
      try {
        artifactRows = await ctx.integrations.db.query(
          `SELECT findings
           FROM module_outputs
           WHERE module_run_id = $1
             AND artifact_status = 'active'
           ORDER BY created_at DESC
           LIMIT 1`,
          z.object({ findings: z.any() }),
          [runId],
          { label: "Load active artifact findings (requires migration 019)" }
        );
      } catch {
        // artifact_status column does not exist — FAIL CLOSED.
        // Do NOT fallback to legacy query which could select an invalidated partial.
        return {
          result: {
            error: "MIGRATION_REQUIRED: artifact_status column missing. " +
              "Run RunMigration019 before invoking FindingReductionGate in production. " +
              "Legacy lifecycle schema cannot guarantee the correct artifact is selected.",
            primaryFindings: [],
            suppressedLedger: [],
            migrationRequired: true,
          }
        };
      }

      if (artifactRows.length === 0) {
        return { result: { error: "No active artifact found for run", primaryFindings: [], suppressedLedger: [] } };
      }

      findings = artifactRows[0].findings ?? [];
    }

    const result = applyReductionGates(findings);
    return { result };
  },
});
