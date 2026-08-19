/**
 * TestRunner — Synthetic validation suite for the Verification Gate (Part 3).
 *
 * Six constructed findings, each designed to fail exactly one check.
 * A case failing two checks = overlap (redundant check).
 * A case passing = check not binding.
 */

import { api, z } from "@superblocksteam/sdk-api";
import { runVerificationGate } from "./verification-gate.js";
import type { ReconciliationFinding } from "./claims-reconciliation.js";

// ---------------------------------------------------------------------------
// Helpers — construct a baseline finding that passes ALL checks
// ---------------------------------------------------------------------------

const KNOWN_DOC = "test-memo.pdf";
const KNOWN_SNIPPET = "Revenue for the period was £150m";
const KNOWN_SCOPE = "Total Revenue";
const KNOWN_METRIC = "revenue";
const KNOWN_PERIOD = "fy mar-25";

function baselineFinding(): ReconciliationFinding {
  return {
    finding_kind: "data_divergence",
    severity: "warning",
    title: "Test finding",
    detail: "Synthetic test case",
    full_analysis: "Test",
    severity_anchor: 5_000_000,
    source_docs: [KNOWN_DOC, "model.xlsx"],
    claim: {
      metric: KNOWN_METRIC,
      scope_qualifier: KNOWN_SCOPE,
      period: "FY Mar-25",
      value: 150,
      unit: "£m",
      basis: null,
      scenario: null,
      basis_note: "total revenue",
      source_doc: KNOWN_DOC,
      source_page: "p.12",
      verbatim_snippet: KNOWN_SNIPPET,
      source_locations: null,
      claim_category: "operating_metric",
    },
    model_figure: {
      name: `[prenorm:${KNOWN_METRIC}:]${KNOWN_SCOPE}`,
      period: KNOWN_PERIOD,
      value: 145,
      source_doc: "model.xlsx",
      source_cell: "D15",
      source_sheet: "P&L Summary",
    },
    delta_abs: 5_000_000,
    delta_pct: 0.0345,
  };
}

// ---------------------------------------------------------------------------
// Build the parsed_text map and refCoords for the test
// ---------------------------------------------------------------------------

function buildTestContext() {
  // parsedTextByDoc: the known document contains the known snippet
  const parsedTextByDoc = new Map<string, string>();
  parsedTextByDoc.set(
    KNOWN_DOC,
    `This is the full memo text. ${KNOWN_SNIPPET} and other content follows. The company performed well.`
  );

  // refFigCoords: a row exists at the known coordinate
  const refFigCoords = [
    { metric: KNOWN_METRIC, scope_qualifier: KNOWN_SCOPE, period: KNOWN_PERIOD, basis: null },
  ];

  // suspectScopes: one suspect scope that is NOT the known scope
  const suspectScopes = new Set<string>(["Suspect EBITDA Scope"]);

  return { parsedTextByDoc, refFigCoords, suspectScopes };
}

// ---------------------------------------------------------------------------
// The 6 test cases
// ---------------------------------------------------------------------------

interface TestCase {
  id: string;
  description: string;
  expectedCheck: string;
  finding: ReconciliationFinding;
}

function buildCases(): TestCase[] {
  // Case A: Quote integrity — snippet altered so it does not appear in parsed_text
  const caseA = baselineFinding();
  caseA.claim.verbatim_snippet = "Revenue for the period was £999m ALTERED TEXT";

  // Case B: Figure existence — coordinate with no reference_figures row
  const caseB = baselineFinding();
  caseB.claim.scope_qualifier = "Nonexistent Scope XYZ";
  // The model_figure name must match the claim's scope for the prenorm lookup
  caseB.model_figure = {
    ...caseB.model_figure!,
    name: `[prenorm:${KNOWN_METRIC}:]Nonexistent Scope XYZ`,
  };

  // Case C: Delta provenance — delta present, operand values stripped
  const caseC = baselineFinding();
  caseC.claim.value = null as any; // Strip claim operand
  // Keep delta_abs and delta_pct present — the check should fail on missing operand

  // Case D: Source naming — figure missing sheet or row label
  const caseD = baselineFinding();
  caseD.model_figure = {
    ...caseD.model_figure!,
    source_sheet: "", // Empty sheet reference
  };

  // Case E: Unit coherence — percentage claim paired with £m figure
  const caseE = baselineFinding();
  caseE.claim.unit = "%"; // Percentage claim
  // model_figure stays as £m (prenorm revenue → monetary family)

  // Case F: Parallel offset — finding from a suspect scope
  const caseF = baselineFinding();
  caseF.claim.scope_qualifier = "Suspect EBITDA Scope";
  // Keep model_figure at a valid coordinate so earlier checks pass
  caseF.model_figure = {
    ...caseF.model_figure!,
    name: `[prenorm:${KNOWN_METRIC}:]${KNOWN_SCOPE}`, // valid coord
  };

  return [
    { id: "A", description: "Quote integrity: altered snippet not in parsed_text", expectedCheck: "quote_integrity", finding: caseA },
    { id: "B", description: "Figure existence: coordinate not in reference_figures", expectedCheck: "figure_existence", finding: caseB },
    { id: "C", description: "Delta provenance: claim operand value stripped", expectedCheck: "delta_provenance", finding: caseC },
    { id: "D", description: "Source naming: model figure missing sheet reference", expectedCheck: "source_naming", finding: caseD },
    { id: "E", description: "Unit coherence: % claim vs £m figure", expectedCheck: "unit_coherence", finding: caseE },
    { id: "F", description: "Parallel offset: scope in suspectScopes set", expectedCheck: "parallel_offset", finding: caseF },
  ];
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "TestVerificationGate",
  description: "Synthetic test suite validating all 6 verification gate checks.",

  input: z.object({}),

  output: z.object({
    passed: z.boolean(),
    total_cases: z.number(),
    results: z.array(z.object({
      case_id: z.string(),
      description: z.string(),
      expected_check: z.string(),
      actual_check: z.string().nullable(),
      verdict: z.enum(["PASS", "FAIL_WRONG_CHECK", "FAIL_NOT_REJECTED"]),
      reason: z.string().nullable(),
    })),
    summary: z.string(),
  }),

  async run() {
    const { parsedTextByDoc, refFigCoords, suspectScopes } = buildTestContext();
    const cases = buildCases();

    const results: Array<{
      case_id: string;
      description: string;
      expected_check: string;
      actual_check: string | null;
      verdict: "PASS" | "FAIL_WRONG_CHECK" | "FAIL_NOT_REJECTED";
      reason: string | null;
    }> = [];

    for (const tc of cases) {
      // Run gate on a single finding
      const gateResult = runVerificationGate({
        findings: [tc.finding],
        parsedTextByDoc,
        refFigCoords,
        suspectScopes,
      });

      if (gateResult.rejected.length === 0) {
        // Finding passed — this is a test failure
        results.push({
          case_id: tc.id,
          description: tc.description,
          expected_check: tc.expectedCheck,
          actual_check: null,
          verdict: "FAIL_NOT_REJECTED",
          reason: "Finding passed all checks — expected rejection",
        });
      } else if (gateResult.rejected.length === 1) {
        const rejection = gateResult.rejected[0];
        if (rejection.check === tc.expectedCheck) {
          // Correct check fired
          results.push({
            case_id: tc.id,
            description: tc.description,
            expected_check: tc.expectedCheck,
            actual_check: rejection.check,
            verdict: "PASS",
            reason: rejection.reason,
          });
        } else {
          // Wrong check fired
          results.push({
            case_id: tc.id,
            description: tc.description,
            expected_check: tc.expectedCheck,
            actual_check: rejection.check,
            verdict: "FAIL_WRONG_CHECK",
            reason: `Expected ${tc.expectedCheck} but got ${rejection.check}: ${rejection.reason}`,
          });
        }
      } else {
        // Multiple checks fired — overlap detected
        const checks = gateResult.rejected.map(r => r.check).join(", ");
        results.push({
          case_id: tc.id,
          description: tc.description,
          expected_check: tc.expectedCheck,
          actual_check: gateResult.rejected[0].check,
          verdict: "FAIL_WRONG_CHECK",
          reason: `Multiple checks fired (overlap): ${checks}`,
        });
      }
    }

    const passed = results.every(r => r.verdict === "PASS");
    const passCount = results.filter(r => r.verdict === "PASS").length;
    const summary = passed
      ? `All ${cases.length} cases PASSED — each check rejected its intended case and only that case.`
      : `${passCount}/${cases.length} cases passed. Failures: ${results.filter(r => r.verdict !== "PASS").map(r => `Case ${r.case_id} (${r.verdict})`).join(", ")}`;

    return {
      passed,
      total_cases: cases.length,
      results,
      summary,
    };
  },
});
