/**
 * Verification Gate — Part 3.
 *
 * Six code-level checks run AFTER reconciliation and BEFORE report assembly.
 * Every finding proposed for the report is re-resolved against source.
 * A finding failing ANY check does not ship.
 *
 * Checks:
 *   1. Quote integrity — verbatim_snippet appears in source memo parsed_text (whitespace-collapsed)
 *   2. Figure existence — reference_figures has a row at claimed coordinate
 *   3. Delta provenance — delta computed by code with both operand values recorded
 *   4. Source naming — both sides have document + sheet/page + row label
 *   5. Unit coherence — claim unit and figure unit in same family
 *   6. Parallel offset — mapping flagged suspect_parallel_offset from Part 2
 */

import type { ReconciliationFinding } from "./claims-reconciliation.js";
import { classifyClaimUnit, classifyModelFigureUnit, unitsAreCompatible } from "./claims-reconciliation.js";
import type { Figure } from "./numeric-verify-inline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateCheck =
  | "quote_integrity"
  | "figure_existence"
  | "delta_provenance"
  | "source_naming"
  | "unit_coherence"
  | "parallel_offset";

export interface GateRejection {
  finding: ReconciliationFinding;
  check: GateCheck;
  reason: string;
}

export interface GateResult {
  /** Findings that passed all 6 checks */
  verified: ReconciliationFinding[];
  /** Findings that failed at least one check */
  rejected: GateRejection[];
  /** Counts per check — how many findings each check rejected */
  rejection_counts: Record<GateCheck, number>;
  /** Total findings submitted to the gate */
  total_submitted: number;
  /** Rejection rate (rejected / total) */
  rejection_rate: number;
}

// ---------------------------------------------------------------------------
// Whitespace collapse — for quote matching
// ---------------------------------------------------------------------------

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Reference figure coordinate lookup set
// ---------------------------------------------------------------------------

export interface RefFigCoord {
  metric: string;
  scope_qualifier: string;
  period: string;
  basis: string | null;
}

/**
 * Build a set of lowercase coordinate keys from reference_figures rows.
 * Key format: "metric|scope_qualifier|period"
 */
function buildRefFigCoordSet(refFigRows: RefFigCoord[]): Set<string> {
  const set = new Set<string>();
  for (const r of refFigRows) {
    const key = `${r.metric.toLowerCase()}|${r.scope_qualifier.toLowerCase()}|${r.period.toLowerCase()}`;
    set.add(key);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

export interface GateInput {
  findings: ReconciliationFinding[];
  /** Map of source_doc filename → collapsed parsed_text */
  parsedTextByDoc: Map<string, string>;
  /** Reference figure coordinate set */
  refFigCoords: RefFigCoord[];
  /** Scopes flagged as suspect_parallel_offset by Part 2 detector */
  suspectScopes: Set<string>;
}

export function runVerificationGate(input: GateInput): GateResult {
  const { findings, parsedTextByDoc, refFigCoords, suspectScopes } = input;
  const refCoordSet = buildRefFigCoordSet(refFigCoords);

  const verified: ReconciliationFinding[] = [];
  const rejected: GateRejection[] = [];
  const rejection_counts: Record<GateCheck, number> = {
    quote_integrity: 0,
    figure_existence: 0,
    delta_provenance: 0,
    source_naming: 0,
    unit_coherence: 0,
    parallel_offset: 0,
  };

  for (const f of findings) {
    const failedCheck = checkFinding(f, parsedTextByDoc, refCoordSet, suspectScopes);
    if (failedCheck) {
      rejected.push(failedCheck);
      rejection_counts[failedCheck.check]++;
    } else {
      verified.push(f);
    }
  }

  const total_submitted = findings.length;
  const rejection_rate = total_submitted > 0 ? rejected.length / total_submitted : 0;

  return { verified, rejected, rejection_counts, total_submitted, rejection_rate };
}

// ---------------------------------------------------------------------------
// Individual checks — returns first failing check (or null if all pass)
// ---------------------------------------------------------------------------

function checkFinding(
  f: ReconciliationFinding,
  parsedTextByDoc: Map<string, string>,
  refCoordSet: Set<string>,
  suspectScopes: Set<string>,
): GateRejection | null {
  // Only gate data_divergence and cross_version findings (those that would ship to report)
  // scope_mismatch and unreconcilable don't assert a contradiction → not report-worthy
  if (f.finding_kind !== "data_divergence" && f.finding_kind !== "cross_version") {
    return null; // Pass through — these are informational, not assertions
  }

  // cross_version findings have a different evidence structure:
  // They compare two document versions (no claim.verbatim_snippet, no single model_figure).
  // Checks 1 (quote), 2 (figure existence), 5 (unit), 6 (parallel offset) don't apply.
  // Checks 3 (delta provenance) and 4 (source naming) still apply.
  if (f.finding_kind === "cross_version") {
    // Check 3: Delta provenance (must have computed delta)
    if (f.delta_abs === null || f.delta_abs === undefined) {
      return { finding: f, check: "delta_provenance", reason: "cross_version finding lacks delta_abs" };
    }
    // Check 4: Source naming (must have source_docs identifying both versions)
    if (!f.source_docs || f.source_docs.length === 0) {
      return { finding: f, check: "source_naming", reason: "cross_version finding lacks source document references" };
    }
    return null; // Passes applicable checks
  }

  // --- data_divergence findings: all 6 checks apply ---

  // Check 1: Quote integrity
  const quoteResult = checkQuoteIntegrity(f, parsedTextByDoc);
  if (quoteResult) return quoteResult;

  // Check 2: Figure existence
  const figResult = checkFigureExistence(f, refCoordSet);
  if (figResult) return figResult;

  // Check 3: Delta provenance
  const deltaResult = checkDeltaProvenance(f);
  if (deltaResult) return deltaResult;

  // Check 4: Source naming
  const sourceResult = checkSourceNaming(f);
  if (sourceResult) return sourceResult;

  // Check 5: Unit coherence
  const unitResult = checkUnitCoherence(f);
  if (unitResult) return unitResult;

  // Check 6: Parallel offset
  const offsetResult = checkParallelOffset(f, suspectScopes);
  if (offsetResult) return offsetResult;

  return null; // All checks passed
}

function checkQuoteIntegrity(
  f: ReconciliationFinding,
  parsedTextByDoc: Map<string, string>,
): GateRejection | null {
  if (!f.claim) return null; // No claim → can't check quote

  const snippet = f.claim.verbatim_snippet;
  if (!snippet || snippet.trim().length === 0) {
    return { finding: f, check: "quote_integrity", reason: "verbatim_snippet is empty" };
  }

  const sourceDoc = f.claim.source_doc;
  if (!sourceDoc) {
    return { finding: f, check: "quote_integrity", reason: "claim has no source_doc" };
  }

  const docText = parsedTextByDoc.get(sourceDoc);
  if (!docText) {
    // Document not loaded — can't verify. This is a hard fail per spec:
    // "does not appear as an exact substring" — if we can't find the doc, we can't confirm.
    return { finding: f, check: "quote_integrity", reason: `parsed_text not available for "${sourceDoc}"` };
  }

  // Whitespace-collapse both sides and check substring
  const collapsedSnippet = collapseWhitespace(snippet);
  const collapsedDoc = docText; // Already collapsed at load time

  if (!collapsedDoc.includes(collapsedSnippet)) {
    return {
      finding: f,
      check: "quote_integrity",
      reason: `snippet not found in source: "${snippet.slice(0, 60)}${snippet.length > 60 ? "…" : ""}"`,
    };
  }

  return null;
}

function checkFigureExistence(
  f: ReconciliationFinding,
  refCoordSet: Set<string>,
): GateRejection | null {
  if (!f.model_figure) {
    return { finding: f, check: "figure_existence", reason: "no model_figure on finding" };
  }

  // For prenorm figures, extract metric and scope from the name
  const figName = f.model_figure.name;
  const prenormMatch = figName.match(/^\[prenorm:([^:]+):([^\]]*)\](.+)$/);

  if (prenormMatch) {
    // Prenorm figure — check reference_figures coordinate set
    const metric = prenormMatch[1].toLowerCase();
    const scope = prenormMatch[3].toLowerCase();
    const period = f.model_figure.period.toLowerCase();
    const key = `${metric}|${scope}|${period}`;
    if (!refCoordSet.has(key)) {
      return {
        finding: f,
        check: "figure_existence",
        reason: `no reference_figures row at [${metric}|${scope}|${period}]`,
      };
    }
  }
  // Non-prenorm figures come from numeric_reports — they exist by construction
  // (loaded from the report). No additional check needed.

  return null;
}

function checkDeltaProvenance(f: ReconciliationFinding): GateRejection | null {
  // Delta must be code-computed: delta_abs and delta_pct must be present,
  // AND both operand values (claim.value + model_figure.value) must be recorded.
  if (f.delta_abs === null || f.delta_abs === undefined) {
    return { finding: f, check: "delta_provenance", reason: "delta_abs not recorded" };
  }
  if (f.delta_pct === null || f.delta_pct === undefined) {
    return { finding: f, check: "delta_provenance", reason: "delta_pct not recorded" };
  }
  if (!f.claim || f.claim.value === null || f.claim.value === undefined) {
    return { finding: f, check: "delta_provenance", reason: "claim operand value not recorded" };
  }
  if (!f.model_figure || f.model_figure.value === null || f.model_figure.value === undefined) {
    return { finding: f, check: "delta_provenance", reason: "model operand value not recorded" };
  }
  return null;
}

function checkSourceNaming(f: ReconciliationFinding): GateRejection | null {
  // Claim side: must have source_doc AND source_page (or section reference)
  if (!f.claim) {
    return { finding: f, check: "source_naming", reason: "no claim object" };
  }
  if (!f.claim.source_doc || f.claim.source_doc.trim().length === 0) {
    return { finding: f, check: "source_naming", reason: "claim missing source document" };
  }
  if (!f.claim.source_page && !f.claim.verbatim_snippet) {
    return { finding: f, check: "source_naming", reason: "claim missing page/section reference" };
  }

  // Model side: must have source_doc, source_sheet, and a row label (name)
  if (!f.model_figure) {
    return { finding: f, check: "source_naming", reason: "no model figure" };
  }
  if (!f.model_figure.source_doc || f.model_figure.source_doc.trim().length === 0) {
    return { finding: f, check: "source_naming", reason: "model figure missing source document" };
  }
  if (!f.model_figure.source_sheet || f.model_figure.source_sheet.trim().length === 0) {
    return { finding: f, check: "source_naming", reason: "model figure missing sheet reference" };
  }
  if (!f.model_figure.name || f.model_figure.name.trim().length === 0) {
    return { finding: f, check: "source_naming", reason: "model figure missing row label" };
  }

  return null;
}

function checkUnitCoherence(f: ReconciliationFinding): GateRejection | null {
  if (!f.claim || !f.model_figure) return null;

  const claimUnit = classifyClaimUnit(f.claim.unit);
  const modelUnit = classifyModelFigureUnit(f.model_figure);

  if (!unitsAreCompatible(claimUnit, modelUnit)) {
    return {
      finding: f,
      check: "unit_coherence",
      reason: `claim unit "${f.claim.unit}" (${claimUnit}) incompatible with model figure unit (${modelUnit})`,
    };
  }

  return null;
}

function checkParallelOffset(
  f: ReconciliationFinding,
  suspectScopes: Set<string>,
): GateRejection | null {
  if (!f.claim) return null;

  const scope = f.claim.scope_qualifier ?? "";
  if (suspectScopes.has(scope)) {
    return {
      finding: f,
      check: "parallel_offset",
      reason: `scope "${scope}" flagged as suspect_parallel_offset (systematic same-sign offset)`,
    };
  }

  return null;
}
