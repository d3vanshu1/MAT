/**
 * Shared surfacing helper — called by every publisher before INSERT.
 *
 * Ranks findings, keeps the top MAX_SURFACED, caps critical at MAX_CRITICAL,
 * and caps IC-flagged at MAX_IC_FLAGGED. Downgrades persist severity_assessed
 * so the assessed (uncapped) count survives for deal-level rollup.
 *
 * The full register stays in the pipeline tables (ero_findings, etc.).
 * Nothing is deleted — the published artifact is curated.
 */
import type { CanonicalFinding } from "../pipeline/canonical-finding.js";

export const MAX_SURFACED = 30;
export const MAX_CRITICAL = 3;
export const MAX_IC_FLAGGED = 3;

const SEV_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export interface SurfaceResult {
  surfaced: CanonicalFinding[];
  suppressedCount: number;
  suppressedCritical: number;
}

export function surfaceFindings(all: CanonicalFinding[]): SurfaceResult {
  // Rank: materiality_tier ascending (1 = most material), then severity,
  // then verified evidence present, then stable by finding_id.
  const ranked = [...all].sort((a: CanonicalFinding, b: CanonicalFinding) =>
    ((a.materiality_tier ?? 99) - (b.materiality_tier ?? 99)) ||
    ((SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)) ||
    (Number(!!b.evidence?.some((e) => e.verified)) - Number(!!a.evidence?.some((e) => e.verified))) ||
    a.finding_id.localeCompare(b.finding_id)
  );

  const surfaced = ranked.slice(0, MAX_SURFACED);
  const cut = ranked.slice(MAX_SURFACED);

  let criticalsUsed = 0;
  let icUsed = 0;
  for (const f of surfaced) {
    // Preserve the assessed severity before any downgrade
    f.severity_assessed = f.severity_assessed ?? f.severity;

    if (f.severity === "critical") {
      if (criticalsUsed < MAX_CRITICAL) {
        criticalsUsed++;
        f.ic_flagged = icUsed < MAX_IC_FLAGGED;
        if (f.ic_flagged) icUsed++;
      } else {
        // Downgrade for display — assessed severity retained
        f.severity = "warning";
        f.materiality_rationale =
          "Downgraded from critical for display: module cap of " + MAX_CRITICAL +
          " critical findings reached. Assessed severity retained in severity_assessed.";
        f.ic_flagged = false;
      }
    } else {
      f.ic_flagged = false;
    }
  }

  return {
    surfaced,
    suppressedCount: cut.length,
    suppressedCritical: cut.filter(
      (f: CanonicalFinding) => (f.severity_assessed ?? f.severity) === "critical"
    ).length,
  };
}
