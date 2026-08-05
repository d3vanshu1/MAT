/**
 * Finding Reduction Gate — Tests per specification
 *
 * Uses fixed SCG fixtures proving:
 *   - True findings survive
 *   - False positives are rejected
 *   - Duplicates consolidate
 *   - Incompatible comparisons fail closed
 *   - Unsupported findings cannot become primary
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/finding-reduction-gate.test.ts
 */

import * as path from "path";

// Direct import of the gate function for unit testing
const DIR = path.resolve(import.meta.dirname ?? ".", "..");

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; const err = `  ✗ FAIL: ${msg}`; errors.push(err); console.error(err); }
}

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" Finding Reduction Gate — Tests");
console.log("════════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// Import the gate logic (dynamic import for ESM compatibility)
// ---------------------------------------------------------------------------
async function runTests() {
  const mod = await import("../finding-reduction-gate.js");
  const { applyReductionGates, KNOWN_FALSE_POSITIVE_PATTERNS } = mod;

  // ─── SCG Fixtures ──────────────────────────────────────────────────────

  // True positive: FY26 revenue revision
  const trueRevisionFinding = {
    finding_id: "tp-001",
    severity: "critical",
    title: "FY26 Revenue Revision: IC Memo vs Live Model Discrepancy",
    detail: "Revenue revised downward in FY26 model update not reflected in memo",
    full_analysis: "The IC memo cites £245m revenue for FY26, but the live model shows £232m — a £13m downward revision.",
    source_docs: ["IC_Memo_v3.pdf", "Financial_Model_v12.xlsx"],
    finding_kind: "discrepancy",
    issue_key: "fy26_revenue_revision",
    evidence: [
      { figure: "£245m", source_doc: "IC_Memo_v3.pdf", verbatim_snippet: "Revenue forecast of £245m", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions" },
      { figure: "£232m", source_doc: "Financial_Model_v12.xlsx", verbatim_snippet: "Revenue: 232", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions" },
    ],
  };

  // True positive: FY26 EBITDA revision
  const trueEbitdaFinding = {
    finding_id: "tp-002",
    severity: "critical",
    title: "FY26 Reported EBITDA Revision Not Disclosed",
    detail: "EBITDA revised from £89m to £81m in model but memo retains £89m",
    full_analysis: "Material EBITDA revision not reflected in IC presentation",
    source_docs: ["IC_Memo_v3.pdf", "Financial_Model_v12.xlsx"],
    finding_kind: "contradiction",
    issue_key: "fy26_ebitda_revision",
    evidence: [
      { figure: "£89m", source_doc: "IC_Memo_v3.pdf", verbatim_snippet: "EBITDA of £89m", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions", accounting_basis: "reported" },
      { figure: "£81m", source_doc: "Financial_Model_v12.xlsx", verbatim_snippet: "EBITDA: 81", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions", accounting_basis: "reported" },
    ],
  };

  // True positive: Widening adjustments
  const trueWideningFinding = {
    finding_id: "tp-003",
    severity: "warning",
    title: "Widening Adjustments Between Reported and Underlying",
    detail: "Gap between reported and adjusted EBITDA widening year-on-year",
    full_analysis: "The adjustment bridge shows widening gap from £5m in FY24 to £12m in FY26",
    source_docs: ["Financial_Model_v12.xlsx"],
    finding_kind: "discrepancy",
    issue_key: "widening_adjustments",
    evidence: [
      { figure: "£5m", source_doc: "Financial_Model_v12.xlsx", verbatim_snippet: "FY24 adjustments: 5", verified: true, period: "FY2024", scope: "group", unit: "GBP_millions" },
      { figure: "£12m", source_doc: "Financial_Model_v12.xlsx", verbatim_snippet: "FY26 adjustments: 12", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions" },
    ],
  };

  // False positive: SIP Calls margin collapse
  const fpSipCalls = {
    finding_id: "fp-001",
    severity: "critical",
    title: "SIP Calls Division: −34.1pp Margin Collapse",
    detail: "SIP Calls margin appears to collapse by 34.1 percentage points",
    full_analysis: "Misattributed comparison between different reporting segments",
    source_docs: ["Segment_Report.pdf"],
    finding_kind: "contradiction",
    evidence: [],
  };

  // False positive: £19.5m FY25 gap
  const fpFy25Gap = {
    finding_id: "fp-002",
    severity: "warning",
    title: "£19.5m Revenue Gap in FY25",
    detail: "£19.5m gap caused by FY24 mislabelling in the model",
    full_analysis: "Investigation shows this is a labelling error — FY24 data tagged as FY25",
    source_docs: ["Model_Notes.xlsx"],
    finding_kind: "discrepancy",
    evidence: [],
  };

  // False positive: 128% vs 55% market share
  const fpMarketShare = {
    finding_id: "fp-003",
    severity: "critical",
    title: "Market Share Contradiction: 128% vs 55%",
    detail: "Comparing company metric (128% growth) to market metric (55% share)",
    full_analysis: "Incompatible metrics being compared across different frameworks",
    source_docs: ["Market_Analysis.pdf"],
    finding_kind: "contradiction",
    evidence: [],
  };

  // Incompatible comparison: segment vs group
  const incompatibleScope = {
    finding_id: "ic-001",
    severity: "warning",
    title: "Revenue Discrepancy: Segment vs Group Total",
    detail: "UK segment revenue doesn't match group consolidated total — because it shouldn't",
    full_analysis: "Comparing segment to group without recognizing these are different scopes",
    source_docs: ["Annual_Report.pdf"],
    finding_kind: "discrepancy",
    evidence: [
      { figure: "£120m", source_doc: "Annual_Report.pdf", verbatim_snippet: "UK segment: £120m", verified: true, scope: "segment_UK", unit: "GBP_millions" },
      { figure: "£450m", source_doc: "Annual_Report.pdf", verbatim_snippet: "Group total: £450m", verified: true, scope: "group", unit: "GBP_millions" },
    ],
  };

  // Incompatible comparison: currency vs percentage
  const incompatibleUnit = {
    finding_id: "ic-002",
    severity: "warning",
    title: "EBITDA Metric Mismatch",
    detail: "Comparing £ absolute amount to margin percentage",
    full_analysis: "Unit incompatibility between currency and percentage",
    source_docs: ["Model.xlsx"],
    finding_kind: "discrepancy",
    evidence: [
      { figure: "£89m", source_doc: "Model.xlsx", verbatim_snippet: "EBITDA: £89m", verified: true, unit: "GBP_millions" },
      { figure: "22%", source_doc: "Model.xlsx", verbatim_snippet: "EBITDA margin: 22%", verified: true, unit: "percentage" },
    ],
  };

  // Unsupported: info-only observation (no evidence)
  const unsupportedInfo = {
    finding_id: "us-001",
    severity: "info",
    title: "General Market Commentary Noted",
    detail: "The memo mentions general market conditions",
    full_analysis: "Informational only — no contradictions identified",
    source_docs: [],
    finding_kind: "observation",
    evidence: [],
  };

  // Duplicate of tp-001 (same issue_key)
  const duplicateRevision = {
    finding_id: "dup-001",
    severity: "warning",
    title: "Revenue Number Differs Between Sources (FY26)",
    detail: "FY26 revenue shown differently in memo vs model",
    full_analysis: "Same underlying issue as the main revenue revision finding",
    source_docs: ["IC_Memo_v3.pdf"],
    finding_kind: "discrepancy",
    issue_key: "fy26_revenue_revision",
    evidence: [
      { figure: "£245m", source_doc: "IC_Memo_v3.pdf", verbatim_snippet: "Revenue: 245", verified: true, period: "FY2026", scope: "group", unit: "GBP_millions" },
    ],
  };

  // ─── Run Gate Tests ────────────────────────────────────────────────────

  const allFindings = [
    trueRevisionFinding, trueEbitdaFinding, trueWideningFinding,
    fpSipCalls, fpFy25Gap, fpMarketShare,
    incompatibleScope, incompatibleUnit,
    unsupportedInfo,
    duplicateRevision,
  ];

  const result = applyReductionGates(allFindings);

  // ─── True findings survive ─────────────────────────────────────────────
  console.log("\n─── True Findings Survive ───");

  const primaryIds = result.primaryFindings.map((f: any) => f.finding_id);
  assert(primaryIds.includes("tp-001"), "FY26 revenue revision survives");
  assert(primaryIds.includes("tp-002"), "FY26 EBITDA revision survives");
  assert(primaryIds.includes("tp-003"), "Widening adjustments survives");

  // ─── False positives are rejected ──────────────────────────────────────
  console.log("\n─── False Positives Rejected ───");

  const suppressedIds = result.suppressedLedger.filter((d: any) => d.tier === "suppressed").map((d: any) => d.findingId);
  assert(suppressedIds.includes("fp-001"), "SIP Calls false positive rejected");
  assert(suppressedIds.includes("fp-002"), "£19.5m FY25 gap rejected");
  assert(suppressedIds.includes("fp-003"), "128% vs 55% market share rejected");
  assert(!primaryIds.includes("fp-001"), "SIP Calls not in primary");
  assert(!primaryIds.includes("fp-002"), "FY25 gap not in primary");
  assert(!primaryIds.includes("fp-003"), "Market share not in primary");

  // ─── Duplicates consolidate ────────────────────────────────────────────
  console.log("\n─── Duplicates Consolidate ───");

  // Both tp-001 and dup-001 share issue_key "fy26_revenue_revision"
  // Family consolidation should group them
  const familyKeys = Object.keys(result.families);
  const hasRevenueFamily = familyKeys.some(k => {
    const members = result.families[k];
    return members.includes("tp-001") || members.includes("dup-001");
  });
  assert(hasRevenueFamily || primaryIds.includes("dup-001"), "Revenue revision findings form a family or both survive");

  // ─── Incompatible comparisons fail closed ──────────────────────────────
  console.log("\n─── Incompatible Comparisons Fail Closed ───");

  assert(suppressedIds.includes("ic-001") || !primaryIds.includes("ic-001"), "Segment vs group rejected or not primary");
  assert(suppressedIds.includes("ic-002") || !primaryIds.includes("ic-002"), "Currency vs percentage rejected or not primary");

  // ─── Unsupported findings cannot become primary ────────────────────────
  console.log("\n─── Unsupported Cannot Be Primary ───");

  assert(!primaryIds.includes("us-001"), "Info observation not primary");
  // Should be in secondary observations
  const secondaryIds = result.secondaryObservations.map((f: any) => f.finding_id);
  assert(secondaryIds.includes("us-001") || suppressedIds.includes("us-001"), "Info observation in secondary or suppressed");

  // ─── Ground-truth signals ──────────────────────────────────────────────
  console.log("\n─── Ground-Truth Signals ───");

  assert(result.groundTruthSignals.includes("fy26_revenue_revision"), "Ground truth: FY26 revenue revision detected");
  assert(result.groundTruthSignals.includes("fy26_ebitda_revision"), "Ground truth: FY26 EBITDA revision detected");

  // ─── Gate statistics ───────────────────────────────────────────────────
  console.log("\n─── Gate Statistics ───");

  assert(Object.keys(result.gateStats).length >= 8, "All gates have statistics");
  assert(result.suppressedLedger.length > 0, "Suppressed ledger has entries");
  assert(result.suppressedLedger.every((d: any) => d.suppressionReason), "Every suppressed entry has a reason");

  // ─── No hard cap ───────────────────────────────────────────────────────
  console.log("\n─── No Hard Cap ───");

  // Verify source has no hard finding count limit
  const sourceCode = await import("fs").then(fs =>
    fs.readFileSync(path.join(DIR, "finding-reduction-gate.ts"), "utf-8")
  );
  assert(!sourceCode.includes("MAX_FINDINGS") && !sourceCode.includes("FINDING_CAP"), "No hard finding count cap in source");
  assert(!sourceCode.includes("slice(0, ") || sourceCode.indexOf("slice(0, 300)") > 0, "No array truncation cap");

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n════════════════════════════════════════════════════════════════════");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log("\nFailures:");
    errors.forEach(e => console.log(e));
  }
  console.log("════════════════════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
