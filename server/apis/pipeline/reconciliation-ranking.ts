/**
 * Reconciliation Finding Ranking (Item 5)
 * =======================================
 *
 * Deterministic presentation ranking for claims-reconciliation findings. No LLM,
 * no network, no DB — a pure function of signals the findings already carry.
 *
 * ── Why these inputs and not the ones originally proposed ──────────────────
 * The packet proposed ranking on delta magnitude (absolute and percentage),
 * severity, materiality-floor clearance, and verification status. Two of those
 * five carry no usable information and are deliberately excluded:
 *
 *   • `severity` — assigned at claims-reconciliation.ts:663–669 purely as a step
 *     function of the same two deltas (critical iff delta_abs >= £10m OR
 *     delta_pct >= 15%). Scoring it alongside the deltas double-counts magnitude
 *     and would let a £10.0m/15.1% finding outrank a £40m/60% one on a rounding
 *     boundary. Excluded as collinear.
 *
 *   • verification status — degenerate. pipeline-core.ts:3446 replaces the
 *     reconciliation findings array with `pipelineResult.verifiedFindings`, so
 *     every finding reaching this function has already passed the verification
 *     gate. The signal is constant-true and its variance is zero.
 *
 * That leaves three genuinely independent inputs:
 *   1. finding_kind      — class gate: a genuine divergence always outranks a
 *                          scope mismatch or an unreconcilable claim.
 *   2. floor clearance   — does the delta clear £2m AND/OR 5%.
 *   3. delta magnitude   — absolute (log-scaled) and percentage (linear).
 *
 * ── Ordering guarantees ───────────────────────────────────────────────────
 * Total order, stable, and reproducible across runs: ties break on delta_abs,
 * then delta_pct, then period, then original array index. Two runs over the same
 * reconciliation output produce byte-identical ranks.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * Presentation only. Ranking runs strictly AFTER the ten-gate reduction filter
 * (finding-reduction-gate.ts) and changes no gate outcome. Nothing is dropped:
 * every finding receives a rank and a score, and findings below the presentation
 * cap are demoted to the report appendix, not discarded.
 */

import type { ReconciliationFinding } from "./claims-reconciliation.js";
import { RECONCILIATION_REPORT_TOP_N } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Materiality floors
// ---------------------------------------------------------------------------

/**
 * Mirrors MATERIALITY_ABS_FLOOR / MATERIALITY_REL_FLOOR at
 * claims-reconciliation.ts:301–302. Re-declared rather than imported because
 * claims-reconciliation.ts is frozen for this change and does not export them.
 *
 * These are used here for SCORING ONLY. They do not participate in any
 * admission, suppression, or gate decision — those remain entirely inside
 * claims-reconciliation.ts. A drift between the two would change which finding
 * leads the report; it could never change which findings exist.
 */
export const RANK_MATERIALITY_ABS_FLOOR = 2_000_000; // £2m
export const RANK_MATERIALITY_REL_FLOOR = 0.05; // 5%

// ---------------------------------------------------------------------------
// Score weights
// ---------------------------------------------------------------------------

/** Awarded to findings that assert a genuine numeric divergence. */
const CLASS_BASE_PRINCIPAL = 100;
/** Awarded to scope_mismatch / unreconcilable (housekeeping-class) findings. */
const CLASS_BASE_HOUSEKEEPING = 0;

const FLOOR_POINTS_BOTH = 40;
const FLOOR_POINTS_EITHER = 20;
const FLOOR_POINTS_NEITHER = 0;

/** Absolute magnitude: log10(delta_abs / £1m) x 15, clamped to [0, 30]. */
const MAGNITUDE_SCALE = 15;
const MAGNITUDE_CAP = 30;

/**
 * D-12: Percentage scoring with peak + decay.
 * Peaks at ~15% (the critical threshold) then decays — a 15% delta
 * should score higher than a 900% delta (which signals a scale/unit error).
 * Uses a bell-like curve: 20 · (x/15) · e^(1 - x/15) for x > 0.
 * Peak value is 20 at x=15%. Decays to ~7.4 at 100%, ~1.5 at 900%.
 */
const PERCENTAGE_PEAK = 20;
const PERCENTAGE_PEAK_AT = 15; // percent
// Legacy constants kept for reference:
const PERCENTAGE_SCALE = 1.33;
const PERCENTAGE_CAP = 20;

/** finding_kind values that assert a genuine numeric divergence. */
const PRINCIPAL_KINDS = new Set<ReconciliationFinding["finding_kind"]>([
  "data_divergence",
  "cross_version",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  /** Class gate: 100 for data_divergence/cross_version, 0 otherwise. */
  class_base: number;
  /** 40 both floors, 20 either, 0 neither. */
  floor_points: number;
  /** Log-scaled absolute delta, [0, 30]. */
  magnitude_points: number;
  /** Linear percentage delta, [0, 20]. */
  percentage_points: number;
}

export interface FloorClearance {
  /** delta_abs >= £2m */
  abs_cleared: boolean;
  /** delta_pct >= 5% */
  rel_cleared: boolean;
  both_cleared: boolean;
}

export interface RankedReconciliationFinding {
  /** The underlying finding — unmodified. */
  finding: ReconciliationFinding;
  /** 1-based rank across the whole set. Every finding gets one. */
  rank: number;
  /** Total score, rounded to one decimal place. */
  score: number;
  components: ScoreComponents;
  floors: FloorClearance;
  /** True when rank <= presentation cap. Demotion flag only — never a filter. */
  presented: boolean;
  /** Position in the input array, retained as the final deterministic tiebreak. */
  source_index: number;
  /** 1.5: Severity assessment — level goes to the report, basis to the log. */
  severity: {
    level: "critical" | "material" | "notable";
    basis: string; // reasoning — logged, never rendered
  };
  /** 1.4: True for the top 3 critical findings; items 4+ are critical_overflow. */
  critical_elevated: boolean;
  critical_overflow: boolean;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function evaluateFloors(finding: ReconciliationFinding): FloorClearance {
  const absCleared = (finding.delta_abs ?? 0) >= RANK_MATERIALITY_ABS_FLOOR;
  const relCleared = (finding.delta_pct ?? 0) >= RANK_MATERIALITY_REL_FLOOR;
  return {
    abs_cleared: absCleared,
    rel_cleared: relCleared,
    both_cleared: absCleared && relCleared,
  };
}

export function scoreReconciliationFinding(finding: ReconciliationFinding): {
  score: number;
  components: ScoreComponents;
  floors: FloorClearance;
} {
  const floors = evaluateFloors(finding);

  const classBase = PRINCIPAL_KINDS.has(finding.finding_kind)
    ? CLASS_BASE_PRINCIPAL
    : CLASS_BASE_HOUSEKEEPING;

  const floorPoints = floors.both_cleared
    ? FLOOR_POINTS_BOTH
    : floors.abs_cleared || floors.rel_cleared
      ? FLOOR_POINTS_EITHER
      : FLOOR_POINTS_NEITHER;

  // Absolute magnitude, log-scaled so £100m does not swamp £10m by 10x.
  // Clamped at 0 on the low side: a sub-£1m delta contributes nothing rather
  // than a negative penalty (log10 of a fraction is negative).
  const deltaAbs = Math.abs(finding.delta_abs ?? 0);
  const magnitudePoints = clamp(
    Math.log10(Math.max(1, deltaAbs) / 1_000_000) * MAGNITUDE_SCALE,
    0,
    MAGNITUDE_CAP,
  );

  // 2.3: Plateau-then-decay percentage scoring.
  // Ramps linearly to PEAK over [0, 5%], flat across [5%, 60%], decays above 60%.
  // A 40% delta scores the same as a 15% one (both plausible). Only implausible
  // values (>60%) sort down. Test: 5/15/25/40/60% must not decline; only 300% should.
  const deltaPctAbs = Math.abs(finding.delta_pct ?? 0) * 100; // as percentage
  let percentagePoints: number;
  if (deltaPctAbs <= 0) {
    percentagePoints = 0;
  } else if (deltaPctAbs <= 5) {
    // Ramp: 0 at 0% → PEAK at 5%
    percentagePoints = PERCENTAGE_PEAK * (deltaPctAbs / 5);
  } else if (deltaPctAbs <= 60) {
    // Plateau: flat at PEAK across the plausible band
    percentagePoints = PERCENTAGE_PEAK;
  } else {
    // Decay: exponential falloff above 60% — signals scale/unit error
    const excess = (deltaPctAbs - 60) / 60; // 1.0 at 120%, 4.0 at 300%
    percentagePoints = PERCENTAGE_PEAK * Math.exp(-excess);
  }

  const components: ScoreComponents = {
    class_base: classBase,
    floor_points: floorPoints,
    magnitude_points: round1(magnitudePoints),
    percentage_points: round1(percentagePoints),
  };

  const score = round1(classBase + floorPoints + magnitudePoints + percentagePoints);

  return { score, components, floors };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Ranks every reconciliation finding. Returns a new array in rank order —
 * the input array is not mutated and no finding is removed.
 *
 * @param findings verified reconciliation findings (post-gate)
 * @param opts.topN presentation cap; defaults to RECONCILIATION_REPORT_TOP_N
 */
export function rankReconciliationFindings(
  findings: ReconciliationFinding[],
  opts: { topN?: number } = {},
): RankedReconciliationFinding[] {
  const topN = opts.topN ?? RECONCILIATION_REPORT_TOP_N;

  const scored = findings.map((finding, source_index) => {
    const { score, components, floors } = scoreReconciliationFinding(finding);
    return { finding, score, components, floors, source_index };
  });

  scored.sort((a, b) => {
    // 1. score, descending
    if (b.score !== a.score) return b.score - a.score;
    // 2. absolute delta, descending
    const aAbs = Math.abs(a.finding.delta_abs ?? 0);
    const bAbs = Math.abs(b.finding.delta_abs ?? 0);
    if (bAbs !== aAbs) return bAbs - aAbs;
    // 3. percentage delta, descending
    const aPct = Math.abs(a.finding.delta_pct ?? 0);
    const bPct = Math.abs(b.finding.delta_pct ?? 0);
    if (bPct !== aPct) return bPct - aPct;
    // 4. period, ascending (lexicographic on the normalised period string)
    const aPeriod = a.finding.claim?.period ?? "";
    const bPeriod = b.finding.claim?.period ?? "";
    if (aPeriod !== bPeriod) return aPeriod < bPeriod ? -1 : 1;
    // 5. original order — guarantees a total, stable order
    return a.source_index - b.source_index;
  });

  // 1.5: Assess severity per finding
  const ranked = scored.map((entry, i) => {
    const severity = assessSeverity(entry.finding, entry.floors, entry.score);
    return {
      finding: entry.finding,
      rank: i + 1,
      score: entry.score,
      components: entry.components,
      floors: entry.floors,
      presented: i < topN,
      source_index: entry.source_index,
      severity,
      critical_elevated: false,
      critical_overflow: false,
    };
  });

  // 1.4: Three-critical cap — top 3 by rank get elevated, rest are overflow
  const CRITICAL_CAP = 3;
  let elevatedCount = 0;
  for (const r of ranked) {
    if (r.severity.level === "critical") {
      if (elevatedCount < CRITICAL_CAP) {
        r.critical_elevated = true;
        elevatedCount++;
      } else {
        r.critical_overflow = true;
      }
    }
  }

  return ranked;
}

/**
 * 1.5: Per-module severity assessment.
 * Four questions, answered from signals the finding already carries:
 *   1. Does this change what we pay? (both floors cleared)
 *   2. Does this change the forecast? (principal class)
 *   3. Can the deal team answer it in one line? (small delta)
 *   4. Would it change the recommendation? (score > 150)
 */
function assessSeverity(
  finding: ReconciliationFinding,
  floors: FloorClearance,
  score: number,
): { level: "critical" | "material" | "notable"; basis: string } {
  const reasons: string[] = [];

  // Q1: Does this change what we pay?
  const q1 = floors.both_cleared;
  if (q1) reasons.push("clears both materiality floors");

  // Q2: Does this change the forecast?
  const isPrincipal = PRINCIPAL_KINDS.has(finding.finding_kind);
  if (isPrincipal) reasons.push("principal finding class (data_divergence/cross_version)");

  // Q3: Can the deal team answer it in one line?
  const deltaPct = Math.abs(finding.delta_pct ?? 0);
  const smallDelta = deltaPct < 0.03; // < 3%
  if (smallDelta) reasons.push("delta < 3%, likely answerable in one line");

  // Q4: Would it change the recommendation?
  const highScore = score > 150;
  if (highScore) reasons.push("score > 150");

  // Determine level
  let level: "critical" | "material" | "notable";
  if (q1 && isPrincipal && highScore) {
    level = "critical";
  } else if ((q1 || isPrincipal) && !smallDelta) {
    level = "material";
  } else {
    level = "notable";
  }

  return {
    level,
    basis: level.toUpperCase() + ": " + (reasons.length > 0 ? reasons.join("; ") : "default classification"),
  };
}

/** Findings above the presentation cap, in rank order. */
export function presentedFindings(
  ranked: RankedReconciliationFinding[],
): RankedReconciliationFinding[] {
  return ranked.filter(r => r.presented);
}

/** Findings demoted to the appendix, in rank order. Nothing is discarded. */
export function appendixFindings(
  ranked: RankedReconciliationFinding[],
): RankedReconciliationFinding[] {
  return ranked.filter(r => !r.presented);
}

/**
 * One-line audit trail per finding — logged on every run so a rank can always be
 * reconstructed from the log without re-deriving the score.
 */
export function formatRankAudit(ranked: RankedReconciliationFinding[]): string[] {
  return ranked.map(r => {
    const c = r.components;
    return (
      `#${r.rank} score=${r.score} ` +
      `[class=${c.class_base} floors=${c.floor_points} mag=${c.magnitude_points} pct=${c.percentage_points}] ` +
      `kind=${r.finding.finding_kind} ` +
      `delta_abs=${r.finding.delta_abs ?? "null"} delta_pct=${r.finding.delta_pct ?? "null"} ` +
      `floors(abs=${r.floors.abs_cleared},rel=${r.floors.rel_cleared}) ` +
      `${r.presented ? "PRESENTED" : "appendix"} — "${r.finding.title}"`
    );
  });
}
