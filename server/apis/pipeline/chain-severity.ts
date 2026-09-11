/**
 * chain-severity.ts — Severity from precedent chain position
 *
 * Replaces the fixed dollar materiality floor. Position in the chain
 * determines severity: a gap in a figure feeding entry value is a price
 * question; one feeding nothing is a presentation question.
 *
 * Three states from chain_break_reason:
 *   - reaches an anchor: established as feeding the price or the returns
 *   - hardcoded_leaf:    chain legitimately ends at a typed assumption
 *   - runtime_indirect:  we can't see through it — what's beneath is unknown
 *
 * 81 cells in the anchor chain are runtime_indirect. For those, say the
 * chain breaks. Never claim such a cell feeds nothing, and never claim
 * it feeds the price.
 *
 * severity.basis goes to the run log, never the report.
 */

import type { Figure } from "./numeric-verify-inline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChainSeverityInput {
  deltaAbs: number;
  deltaPct: number;
  figure: Figure | null;
  /** From findFigure: feeds_entry_value, feeds_returns, distance_to_anchor, chain_break_reason */
  feedsEntryValue: boolean | null;
  feedsReturns: boolean | null;
  distanceToAnchor: number | null;
  chainBreakReason: string | null;
}

export type ChainState = "reaches_anchor" | "hardcoded_leaf" | "runtime_indirect" | "unknown";

export interface ChainSeverityResult {
  /** Final severity for the finding */
  severity: "critical" | "warning" | "info";
  /** Basis for the severity decision — goes to run log, never the report */
  basis: string;
  /** Structured chain state */
  chainState: ChainState;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Assess severity from chain position.
 *
 * Rules:
 * - feeds entry value (distance ≤ 3): critical if delta is nontrivial
 * - feeds returns (distance ≤ 5): warning minimum, critical if large
 * - hardcoded_leaf: info — presentation question, not price
 * - runtime_indirect: warning — we can't see through, don't claim either way
 * - unknown (no chain data): fall back to delta-based tiering
 *
 * Relative thresholds still apply (5% / 15%) — chain position adjusts
 * the floor, not the measurement.
 */
export function assessChainSeverity(input: ChainSeverityInput): ChainSeverityResult {
  const { deltaAbs, deltaPct, feedsEntryValue, feedsReturns, distanceToAnchor, chainBreakReason } = input;

  const chainState = resolveChainState(feedsEntryValue, feedsReturns, chainBreakReason);

  switch (chainState) {
    case "reaches_anchor": {
      if (feedsEntryValue) {
        // Price-relevant: critical if relative delta is meaningful
        if (deltaPct >= 0.05 || deltaAbs >= 1_000_000) {
          return {
            severity: "critical",
            basis: `feeds entry value (distance=${distanceToAnchor}), delta=${(deltaPct * 100).toFixed(1)}%`,
            chainState,
          };
        }
        return {
          severity: "warning",
          basis: `feeds entry value (distance=${distanceToAnchor}), delta below critical threshold`,
          chainState,
        };
      }
      // Feeds returns but not entry value
      if (deltaPct >= 0.15) {
        return {
          severity: "critical",
          basis: `feeds returns (distance=${distanceToAnchor}), delta=${(deltaPct * 100).toFixed(1)}%`,
          chainState,
        };
      }
      return {
        severity: "warning",
        basis: `feeds returns (distance=${distanceToAnchor}), delta=${(deltaPct * 100).toFixed(1)}%`,
        chainState,
      };
    }

    case "hardcoded_leaf":
      // Terminal assumption — presentation question, not price
      return {
        severity: "info",
        basis: "hardcoded leaf — chain legitimately ends at a typed assumption",
        chainState,
      };

    case "runtime_indirect":
      // Can't see through — don't claim it feeds nothing, don't claim it feeds price
      return {
        severity: "warning",
        basis: "runtime indirect — chain breaks at an OFFSET/INDIRECT; impact unknown",
        chainState,
      };

    case "unknown":
    default: {
      // No chain data — fall back to delta-based tiering (legacy behavior)
      if (deltaPct >= 0.15) {
        return { severity: "critical", basis: "no chain data — delta-based fallback (≥15%)", chainState };
      }
      if (deltaPct >= 0.05) {
        return { severity: "warning", basis: "no chain data — delta-based fallback (≥5%)", chainState };
      }
      return { severity: "info", basis: "no chain data — delta below 5%", chainState };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveChainState(
  feedsEntryValue: boolean | null,
  feedsReturns: boolean | null,
  chainBreakReason: string | null,
): ChainState {
  if (feedsEntryValue || feedsReturns) return "reaches_anchor";
  if (chainBreakReason === "hardcoded_leaf") return "hardcoded_leaf";
  if (chainBreakReason === "runtime_indirect") return "runtime_indirect";
  if (chainBreakReason) return "runtime_indirect"; // Treat any other break as unknown territory
  return "unknown";
}
