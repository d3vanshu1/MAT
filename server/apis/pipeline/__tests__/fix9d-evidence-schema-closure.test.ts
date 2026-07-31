/**
 * Fix 9D (Corrective) — Evidence Coordinate Schema Closure
 *
 * Proves that full evidence coordinates survive the canonical pipeline:
 *   parseCanonicalFindings() → serializeFindings() → deserializeFindings() → resolveCitedValues()
 *
 * Scenarios:
 *   1. Memo FY26 Revenue (£191.2m) resolves to its memo document coordinate (verified)
 *   2. Model FY26 Revenue (£184.4m) resolves to its model document coordinate (verified)
 *   3. An unsupported £999m citation with no matching coordinate remains mismatched
 *   4. All coordinate fields survive the full serialize → deserialize round-trip
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix9d-evidence-schema-closure.test.ts
 */

import { parseCanonicalFindings, serializeFindings, deserializeFindings } from "../canonical-finding.js";
import { resolveCitedValues, type VerifiedFigure } from "../cited-value-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
    failed++;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMO_DOC_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const MODEL_DOC_ID = "bbbbbbbb-2222-4000-8000-000000000002";

/** Raw findings as they would arrive from the LLM merge output */
const rawFindings = [
  {
    finding_id: "11111111-aaaa-4000-8000-ffffffffffff",
    severity: "warning",
    title: "Revenue divergence FY26",
    detail: "IC Memo cites £191.2m revenue FY26 but Financial Model shows £184.4m — a £6.8m gap.",
    full_analysis: "The IC Memo states total revenue for FY2026 of £191.2m. The financial model (v3.2) calculates £184.4m for the same period.",
    source_docs: ["IC Memo", "Financial Model v3.2"],
    finding_kind: "data_divergence",
    numeric_unverified: false,
    evidence: [
      {
        figure: "£191.2m",
        source_doc: "IC Memo",
        verbatim_snippet: "Total revenue for FY2026 is projected at £191.2m",
        verified: false,
        metric: "revenue",
        period: "FY2026",
        // Fix 9D: Full coordinates
        document_id: MEMO_DOC_ID,
        source_filename: "SCG IC Memo - Final.pdf",
        document_role: "ic_memo",
        sheet_or_page: "Page 7",
        cell_coordinate: "paragraph:3",
        scope: "group",
        unit: "GBP_millions",
        currency: "GBP",
        accounting_basis: "forecast",
        actual_or_forecast: "forecast",
      },
      {
        figure: "£184.4m",
        source_doc: "Financial Model v3.2",
        verbatim_snippet: "Revenue total FY26: £184.4m",
        verified: false,
        metric: "revenue",
        period: "FY2026",
        // Fix 9D: Full coordinates
        document_id: MODEL_DOC_ID,
        source_filename: "SCG Model v3.2.xlsx",
        document_role: "financial_model",
        sheet_or_page: "P&L",
        cell_coordinate: "B12",
        scope: "group",
        unit: "GBP_millions",
        currency: "GBP",
        accounting_basis: "forecast",
        actual_or_forecast: "forecast",
      },
      {
        // A fabricated/unsupported citation with no matching source
        figure: "£999m",
        source_doc: "Unknown Source",
        verbatim_snippet: "Total exposure of £999m",
        verified: false,
        metric: "exposure",
        period: "FY2026",
        document_id: "cccccccc-3333-4000-8000-000000000003",
        source_filename: "ghost.pdf",
        document_role: "other",
        scope: "group",
        currency: "GBP",
      },
    ],
  },
];

/** Verified figures from NumericVerifyInline (the source of truth) */
const verifiedFigures: VerifiedFigure[] = [
  {
    name: "Revenue",
    period: "FY2026",
    value: 191_200_000, // £191.2m in base units
    source_doc: "IC Memo",
    source_cell: "paragraph:3",
    source_sheet: "Page 7",
    currency: "GBP",
    document_id: MEMO_DOC_ID,
    scope: "group",
  },
  {
    name: "Revenue",
    period: "FY2026",
    value: 184_400_000, // £184.4m in base units
    source_doc: "Financial Model v3.2",
    source_cell: "B12",
    source_sheet: "P&L",
    currency: "GBP",
    document_id: MODEL_DOC_ID,
    scope: "group",
  },
];

// ---------------------------------------------------------------------------
// Test: Full pipeline round-trip
// ---------------------------------------------------------------------------
{
  console.log("=== Step 1: parseCanonicalFindings (fresh parse) ===");
  const parseResult = parseCanonicalFindings(rawFindings, { mode: "fresh", source: "test" });
  assertEqual(parseResult.findings.length, 1, "Parse produces 1 finding");
  assertEqual(parseResult.malformed_count, 0, "No malformed items");

  const finding = parseResult.findings[0];
  assert(finding.evidence !== undefined, "Evidence array preserved after parse");
  assertEqual(finding.evidence!.length, 3, "All 3 evidence items preserved");

  // Verify coordinate fields survived parse
  const memoEv = finding.evidence![0];
  assertEqual(memoEv.document_id, MEMO_DOC_ID, "Test 4a: document_id survives parse");
  assertEqual(memoEv.source_filename, "SCG IC Memo - Final.pdf", "Test 4b: source_filename survives parse");
  assertEqual(memoEv.document_role, "ic_memo", "Test 4c: document_role survives parse");
  assertEqual(memoEv.sheet_or_page, "Page 7", "Test 4d: sheet_or_page survives parse");
  assertEqual(memoEv.cell_coordinate, "paragraph:3", "Test 4e: cell_coordinate survives parse");
  assertEqual(memoEv.scope, "group", "Test 4f: scope survives parse");
  assertEqual(memoEv.unit, "GBP_millions", "Test 4g: unit survives parse");
  assertEqual(memoEv.currency, "GBP", "Test 4h: currency survives parse");
  assertEqual(memoEv.accounting_basis, "forecast", "Test 4i: accounting_basis survives parse");
  assertEqual(memoEv.actual_or_forecast, "forecast", "Test 4j: actual_or_forecast survives parse");

  console.log("\n=== Step 2: serializeFindings ===");
  const serialized = serializeFindings(parseResult.findings, { source: "test" });
  assert(serialized.json.length > 0, "Serialization produces non-empty JSON");
  assertEqual(serialized.count, 1, "Serialized count is 1");

  console.log("\n=== Step 3: deserializeFindings (reload) ===");
  const deserialized = deserializeFindings(serialized.json, "test-reload");
  assertEqual(deserialized.findings.length, 1, "Deserialization produces 1 finding");
  assertEqual(deserialized.issues.length, 0, "No deserialization issues");

  const reloaded = deserialized.findings[0];
  assert(reloaded.evidence !== undefined, "Evidence array survives reload");
  assertEqual(reloaded.evidence!.length, 3, "All 3 evidence items survive reload");

  // Verify coordinate fields survived the full round-trip
  const reloadedMemo = reloaded.evidence![0];
  assertEqual(reloadedMemo.document_id, MEMO_DOC_ID, "Test 4k: document_id survives serialize → deserialize");
  assertEqual(reloadedMemo.sheet_or_page, "Page 7", "Test 4l: sheet_or_page survives round-trip");
  assertEqual(reloadedMemo.cell_coordinate, "paragraph:3", "Test 4m: cell_coordinate survives round-trip");
  assertEqual(reloadedMemo.scope, "group", "Test 4n: scope survives round-trip");
  assertEqual(reloadedMemo.accounting_basis, "forecast", "Test 4o: accounting_basis survives round-trip");
  assertEqual(reloadedMemo.actual_or_forecast, "forecast", "Test 4p: actual_or_forecast survives round-trip");

  const reloadedModel = reloaded.evidence![1];
  assertEqual(reloadedModel.document_id, MODEL_DOC_ID, "Test 4q: model document_id survives round-trip");
  assertEqual(reloadedModel.sheet_or_page, "P&L", "Test 4r: model sheet_or_page survives round-trip");
  assertEqual(reloadedModel.cell_coordinate, "B12", "Test 4s: model cell_coordinate survives round-trip");

  console.log("\n=== Step 4: resolveCitedValues (coordinate resolution) ===");
  const verificationResults = resolveCitedValues(
    deserialized.findings as Array<{
      finding_id: string;
      evidence?: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean; metric?: string; period?: string; document_id?: string; source_filename?: string; document_role?: string; sheet_or_page?: string; cell_coordinate?: string; scope?: string; unit?: string; currency?: string; accounting_basis?: string }>;
      severity_anchor?: string;
      detail?: string;
    }>,
    verifiedFigures
  );

  assertEqual(verificationResults.length, 1, "One finding verified");
  const result = verificationResults[0];

  // Find the three citation resolutions
  const memoCitation = result.citations.find(c => c.citedValue.rawText === "£191.2m");
  const modelCitation = result.citations.find(c => c.citedValue.rawText === "£184.4m");
  const ghostCitation = result.citations.find(c => c.citedValue.rawText === "£999m");

  assert(memoCitation !== undefined, "Memo citation (£191.2m) found in results");
  assert(modelCitation !== undefined, "Model citation (£184.4m) found in results");
  assert(ghostCitation !== undefined, "Ghost citation (£999m) found in results");

  // Test 1: Memo FY26 Revenue resolves to its memo coordinate
  assertEqual(memoCitation!.status, "verified", "Test 1: Memo £191.2m resolves to memo coordinate → verified");
  assertEqual(memoCitation!.matchTier, "exact_cell", "Test 1b: Matched at exact_cell tier (doc+sheet+cell)");
  assertEqual(memoCitation!.matchedValue, 191_200_000, "Test 1c: Matched value is 191.2m");

  // Test 2: Model FY26 Revenue resolves to its model coordinate
  assertEqual(modelCitation!.status, "verified", "Test 2: Model £184.4m resolves to model coordinate → verified");
  assertEqual(modelCitation!.matchTier, "exact_cell", "Test 2b: Matched at exact_cell tier (doc+sheet+cell)");
  assertEqual(modelCitation!.matchedValue, 184_400_000, "Test 2c: Matched value is 184.4m");

  // Test 3: £999m citation has no matching figure → mismatched (coordinate resolves but value wrong)
  // The ghost citation has document_id cccccccc-... which has no matching figure at all → unresolved
  assertEqual(ghostCitation!.status, "unresolved", "Test 3: £999m has no matching coordinate → unresolved");

  // The finding should NOT be flagged as unverified since 2/3 citations verified
  // and the unresolved ratio is 1/3 = 0.33 which is below UNRESOLVED_THRESHOLD (0.5)
  assert(!result.shouldFlagUnverified, "Test 3b: Finding with 2 verified + 1 unresolved (33%) is not flagged");
  assertEqual(result.verified, 2, "Test 3c: 2 citations verified");
  assertEqual(result.unresolved, 1, "Test 3d: 1 citation unresolved");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Fix 9D (Corrective) tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
