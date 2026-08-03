/**
 * MAT-F07: Disposition Bridge
 *
 * Bridges canonical comparison results to production disposition aggregation.
 * Thin wrapper — calls the real canonical-comparison module.
 */

import type { CanonicalComparison, VerdictValue } from "./canonical-comparison.js";

/**
 * Aggregates canonical comparison results for a single candidate.
 * This is the production aggregation — no hardcoded dispositions.
 */
export function aggregateCanonicalDispositionFromComparisons(
  comparisons: CanonicalComparison[],
): { verdict: VerdictValue; q4_eligible: boolean; reason: string } {
  if (!comparisons || comparisons.length === 0) {
    return { verdict: "unverifiable", q4_eligible: false, reason: "no_comparisons" };
  }

  const VERDICT_SEVERITY: Record<string, number> = {
    confirmed: 0,
    partially_supported: 1,
    unsupported: 2,
    unverifiable: 3,
    materially_changed: 4,
    contradicted: 5,
  };

  const compatible = comparisons.filter(c => c.compatibility.allowed);
  const rejected = comparisons.filter(c => !c.compatibility.allowed);

  if (compatible.length === 0) {
    return {
      verdict: "unverifiable",
      q4_eligible: false,
      reason: `All ${rejected.length} comparisons incompatible`,
    };
  }

  let worstVerdict: VerdictValue = "confirmed";
  let worstSeverity = 0;

  for (const comp of compatible) {
    const severity = VERDICT_SEVERITY[comp.verdict.value] ?? 0;
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worstVerdict = comp.verdict.value;
    }
  }

  const q4_eligible = worstSeverity >= 1; // Anything beyond confirmed

  return {
    verdict: worstVerdict,
    q4_eligible,
    reason: `worst_adverse=${worstVerdict} (${compatible.length} compatible, ${rejected.length} rejected)`,
  };
}
