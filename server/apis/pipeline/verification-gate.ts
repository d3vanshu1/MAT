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
  | "parallel_offset"
  | "double_read"           // C9: model-side value cross-check
  | "snippet_value";        // C9: memo-side cited number must appear in snippet

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
  /** C9: double-read mismatches — both values logged for audit */
  doubleReadMismatches: Array<{ cellRef: string; sheet: string; mapValue: string; verifyValue: string }>;
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

/** C9: verification row from workbook_cells_verify */
export interface VerifyCell {
  sheet_name: string;
  cell_ref: string;
  value_num_v2: number | null;
  value_raw_v2: string | null;
}

export interface GateInput {
  findings: ReconciliationFinding[];
  /** Map of source_doc filename → collapsed parsed_text */
  parsedTextByDoc: Map<string, string>;
  /** Reference figure coordinate set */
  refFigCoords: RefFigCoord[];
  /** Scopes flagged as suspect_parallel_offset by Part 2 detector */
  suspectScopes: Set<string>;
  /** C9: verify table keyed by "sheet|cellRef" → VerifyCell */
  verifyCells?: Map<string, VerifyCell>;
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
    double_read: 0,
    snippet_value: 0,
  };
  const doubleReadMismatches: GateResult["doubleReadMismatches"] = [];

  for (const f of findings) {
    const failedCheck = checkFinding(f, parsedTextByDoc, refCoordSet, suspectScopes, input.verifyCells ?? null, doubleReadMismatches);
    if (failedCheck) {
      rejected.push(failedCheck);
      rejection_counts[failedCheck.check]++;
    } else {
      verified.push(f);
    }
  }

  const total_submitted = findings.length;
  const rejection_rate = total_submitted > 0 ? rejected.length / total_submitted : 0;

  return { verified, rejected, rejection_counts, total_submitted, rejection_rate, doubleReadMismatches };
}

// ---------------------------------------------------------------------------
// Individual checks — returns first failing check (or null if all pass)
// ---------------------------------------------------------------------------

function checkFinding(
  f: ReconciliationFinding,
  parsedTextByDoc: Map<string, string>,
  refCoordSet: Set<string>,
  suspectScopes: Set<string>,
  verifyCells: Map<string, VerifyCell> | null,
  doubleReadMismatches: GateResult["doubleReadMismatches"],
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

  // Check 7 (C9): Double-read — model-side value cross-check
  const doubleReadResult = checkDoubleRead(f, verifyCells, doubleReadMismatches);
  if (doubleReadResult) return doubleReadResult;

  // Check 8 (C9): Snippet value — the cited number must appear in the snippet
  const snippetResult = checkSnippetContainsValue(f);
  if (snippetResult) return snippetResult;

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

// ---------------------------------------------------------------------------
// C9 Check 7: Double-read — model-side value cross-check
// ---------------------------------------------------------------------------

/**
 * Compare the map's value_raw against an independent second parse stored in
 * workbook_cells_verify. Exact match required. No tolerance, no fuzzy compare.
 * A cell present in the map but missing from the verify table is a mismatch.
 * Disagreement drops the finding and logs both values.
 */
function checkDoubleRead(
  f: ReconciliationFinding,
  verifyCells: Map<string, VerifyCell> | null,
  mismatches: GateResult["doubleReadMismatches"],
): GateRejection | null {
  if (!verifyCells) return null; // Verify table not loaded — skip (pre-C9 runs)
  if (!f.model_figure) return null;

  const cellRef = f.model_figure.cell_ref;
  const sheet = f.model_figure.source_sheet;
  if (!cellRef || !sheet) return null; // No cell coordinate — can't verify

  const key = `${sheet}|${cellRef}`;
  const verify = verifyCells.get(key);

  if (!verify) {
    // Cell in map but absent from verify table — mismatch per spec
    mismatches.push({
      cellRef, sheet,
      mapValue: String(f.model_figure.value_raw ?? f.model_figure.value),
      verifyValue: "(missing from verify table)",
    });
    return {
      finding: f,
      check: "double_read",
      reason: `cell ${sheet}!${cellRef} present in map but absent from verification table`,
    };
  }

  // Compare value_raw (map) vs value_num_v2 (verify) — exact numeric match
  const mapVal = f.model_figure.value_raw ?? f.model_figure.value;
  const verifyVal = verify.value_num_v2;

  if (mapVal === null || mapVal === undefined || verifyVal === null || verifyVal === undefined) {
    // One side null — mismatch only if the other side has a value
    if ((mapVal !== null && mapVal !== undefined) !== (verifyVal !== null && verifyVal !== undefined)) {
      mismatches.push({
        cellRef, sheet,
        mapValue: String(mapVal ?? "null"),
        verifyValue: String(verifyVal ?? "null"),
      });
      return {
        finding: f,
        check: "double_read",
        reason: `double-read mismatch at ${sheet}!${cellRef}: map=${mapVal}, verify=${verifyVal}`,
      };
    }
    return null;
  }

  // Exact numeric comparison (both are numbers)
  if (Number(mapVal) !== Number(verifyVal)) {
    mismatches.push({
      cellRef, sheet,
      mapValue: String(mapVal),
      verifyValue: String(verifyVal),
    });
    return {
      finding: f,
      check: "double_read",
      reason: `double-read mismatch at ${sheet}!${cellRef}: map=${mapVal}, verify=${verifyVal}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// C9 Check 8: Snippet value — cited number must appear in its own snippet
// ---------------------------------------------------------------------------

/**
 * A finding whose verbatim_snippet doesn't contain its own cited number
 * means the number came from somewhere nobody can see. Do not publish.
 */
function checkSnippetContainsValue(f: ReconciliationFinding): GateRejection | null {
  if (!f.claim) return null;

  const snippet = f.claim.verbatim_snippet;
  if (!snippet || snippet.trim().length === 0) return null; // Already caught by quote_integrity

  const value = f.claim.value;
  if (value === null || value === undefined) return null;

  // Normalize the value to common string representations
  const absVal = Math.abs(value);
  const candidates: string[] = [];

  // Try various formatting: 38, 38.0, 38.00, 38m, $38m, 38%, 3800, etc.
  candidates.push(String(absVal));
  candidates.push(absVal.toFixed(1));
  candidates.push(absVal.toFixed(2));

  // For values >= 1, also try integer form
  if (absVal >= 1) {
    candidates.push(String(Math.round(absVal)));
  }

  // Percentage display: 0.045 → 4.5
  if (absVal < 1 && absVal > 0) {
    const pctVal = absVal * 100;
    candidates.push(String(pctVal));
    candidates.push(pctVal.toFixed(1));
    candidates.push(pctVal.toFixed(2));
  }

  // Check if any candidate appears in the snippet
  const normalizedSnippet = snippet.replace(/,/g, ""); // Remove commas for number matching
  const found = candidates.some(c => normalizedSnippet.includes(c));

  if (!found) {
    return {
      finding: f,
      check: "snippet_value",
      reason: `cited value ${value} not found in snippet: "${snippet.slice(0, 80)}${snippet.length > 80 ? "…" : ""}"`,
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
