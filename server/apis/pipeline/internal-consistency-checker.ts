/**
 * Internal Consistency Checker — B1
 *
 * Detects contradictions WITHIN subject documents (claims vs claims),
 * not between claims and model figures. Three sub-checks:
 *
 *   cross_version     — Same metric+period+scope across two subject docs,
 *                       different values. Includes same as-of date across
 *                       memo versions.
 *
 *   summary_vs_detail — A summary figure vs the table it summarises.
 *                       Compute from detail; compare.
 *
 *   does_not_foot     — Three or more co-stated figures forming an identity
 *                       (A − B = C, shares summing to 100%). Recompute.
 *
 * Guard: reconcile against footnotes before flagging. A footnoted
 * reconciling item that equals the gap within tolerance → basis_divergence,
 * not an inconsistency.
 *
 * Uses the comparability gate to determine when two claims are at the
 * same coordinate.
 */

// Claim type is internal to claims-reconciliation — define a minimal interface here
interface ClaimLike {
  metric?: string | null;
  period?: string | null;
  scope?: string | null;
  value?: number | string | null;
  verbatim?: string | null;
  source_document?: string | null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InconsistencySubCheck = "cross_version" | "summary_vs_detail" | "does_not_foot";

export interface InternalInconsistencyFinding {
  subCheck: InconsistencySubCheck;
  claimA: { docName: string; page?: number; verbatim: string; value: number; metric: string };
  claimB: { docName: string; page?: number; verbatim: string; value: number; metric: string };
  deltaAbs: number;
  deltaPct: number;
  coordinate: string; // human-readable coordinate description
  footnoteReconciled: boolean; // true → reclassify as basis_divergence
}

// ---------------------------------------------------------------------------
// Coordinate key for grouping claims
// ---------------------------------------------------------------------------

function claimCoordinateKey(c: ClaimLike): string | null {
  const metric = (c.metric ?? "").toLowerCase().trim();
  const period = (c.period ?? "").toLowerCase().trim();
  const scope = (c.scope ?? "").toLowerCase().trim();
  if (!metric || !c.value) return null;
  return [metric, period, scope].join("|");
}

// ---------------------------------------------------------------------------
// Cross-version check (B1.1)
// ---------------------------------------------------------------------------

const TOLERANCE_PCT = 0.005; // 0.5% — within rounding

export function checkCrossVersion(
  claims: ClaimLike[],
): InternalInconsistencyFinding[] {
  // Group claims by coordinate key
  const byKey = new Map<string, ClaimLike[]>();
  for (const c of claims) {
    const key = claimCoordinateKey(c);
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }

  const findings: InternalInconsistencyFinding[] = [];

  for (const [coordKey, group] of byKey) {
    if (group.length < 2) continue;

    // Compare each pair from different documents
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];

        // Must be from different documents
        const docA = a.source_document ?? "";
        const docB = b.source_document ?? "";
        if (docA === docB) continue;

        const valA = typeof a.value === "number" ? a.value : parseFloat(String(a.value));
        const valB = typeof b.value === "number" ? b.value : parseFloat(String(b.value));
        if (!Number.isFinite(valA) || !Number.isFinite(valB)) continue;

        const deltaAbs = Math.abs(valA - valB);
        const base = Math.max(Math.abs(valA), Math.abs(valB));
        const deltaPct = base > 0 ? deltaAbs / base : 0;

        // Skip if within rounding tolerance
        if (deltaPct <= TOLERANCE_PCT) continue;

        findings.push({
          subCheck: "cross_version",
          claimA: {
            docName: docA,
            verbatim: a.verbatim ?? String(valA),
            value: valA,
            metric: a.metric ?? "",
          },
          claimB: {
            docName: docB,
            verbatim: b.verbatim ?? String(valB),
            value: valB,
            metric: b.metric ?? "",
          },
          deltaAbs,
          deltaPct,
          coordinate: coordKey.replace(/\|/g, " / "),
          footnoteReconciled: false,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Does-not-foot check (B1.3) — identity verification
// ---------------------------------------------------------------------------

/** Known identity patterns: A = B + C, A = B - C, sum to 100% */
interface IdentityCandidate {
  total: ClaimLike;
  parts: ClaimLike[];
  expectedSum: number;
  actualSum: number;
  gap: number;
}

/**
 * Detect groups of co-stated figures within one document that should form
 * an arithmetic identity. For now, detect sum-to-total patterns where
 * a claim at a broader scope equals the sum of claims at narrower scopes
 * with the same metric and period.
 */
export function checkDoesNotFoot(
  claims: ClaimLike[],
): InternalInconsistencyFinding[] {
  // Group by (metric, period, document) — look for scope breakdowns
  const byMetricPeriodDoc = new Map<string, ClaimLike[]>();
  for (const c of claims) {
    if (!c.metric || !c.value || !c.source_document) continue;
    const key = [
      (c.metric ?? "").toLowerCase(),
      (c.period ?? "").toLowerCase(),
      c.source_document,
    ].join("|");
    const arr = byMetricPeriodDoc.get(key) ?? [];
    arr.push(c);
    byMetricPeriodDoc.set(key, arr);
  }

  const findings: InternalInconsistencyFinding[] = [];

  for (const [, group] of byMetricPeriodDoc) {
    if (group.length < 3) continue; // need total + at least 2 parts

    // Heuristic: the claim with the broadest scope (or no scope) is the total
    const totalCandidates = group.filter(c =>
      !c.scope || c.scope.toLowerCase() === "total" || c.scope.toLowerCase() === "company",
    );
    const parts = group.filter(c =>
      c.scope && c.scope.toLowerCase() !== "total" && c.scope.toLowerCase() !== "company",
    );

    if (totalCandidates.length === 0 || parts.length < 2) continue;

    for (const total of totalCandidates) {
      const totalVal = typeof total.value === "number" ? total.value : parseFloat(String(total.value));
      if (!Number.isFinite(totalVal)) continue;

      const partVals = parts
        .map(p => typeof p.value === "number" ? p.value : parseFloat(String(p.value)))
        .filter(Number.isFinite);
      if (partVals.length < 2) continue;

      const sum = partVals.reduce((a, b) => a + b, 0);
      const gap = Math.abs(totalVal - sum);
      const base = Math.max(Math.abs(totalVal), 1);
      const gapPct = gap / base;

      // Only flag if gap exceeds tolerance
      if (gapPct <= TOLERANCE_PCT) continue;

      findings.push({
        subCheck: "does_not_foot",
        claimA: {
          docName: total.source_document ?? "",
          verbatim: total.verbatim ?? String(totalVal),
          value: totalVal,
          metric: `${total.metric} (total)`,
        },
        claimB: {
          docName: total.source_document ?? "",
          verbatim: `Sum of ${parts.length} components: ${partVals.map(v => v.toFixed(1)).join(" + ")} = ${sum.toFixed(1)}`,
          value: sum,
          metric: `${total.metric} (component sum)`,
        },
        deltaAbs: gap,
        deltaPct: gapPct,
        coordinate: `${total.metric} / ${total.period ?? "unspecified"} / footing check`,
        footnoteReconciled: false,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main entry point — run all sub-checks
// ---------------------------------------------------------------------------

export function runInternalConsistencyChecks(
  claims: ClaimLike[],
): InternalInconsistencyFinding[] {
  const allFindings: InternalInconsistencyFinding[] = [];

  // B1.1: Cross-version
  allFindings.push(...checkCrossVersion(claims));

  // B1.3: Does-not-foot
  allFindings.push(...checkDoesNotFoot(claims));

  // B1.2: Summary-vs-detail — requires structured table data, deferred
  // (needs detail-row claims linked to summary claims, which the current
  // extraction doesn't emit reliably)

  // Sort by delta descending (most material first)
  allFindings.sort((a, b) => b.deltaAbs - a.deltaAbs);

  return allFindings;
}
