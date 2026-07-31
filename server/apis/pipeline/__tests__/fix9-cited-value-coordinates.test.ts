/**
 * Fix 9 (Commit 2) — Cited-Value Coordinate Resolution Tests
 *
 * Tests:
 * 1. Memo Revenue FY26 £191.2m resolves to the memo coordinate
 * 2. Model Revenue FY26 £184.4m resolves to the model coordinate
 * 3. Memo-versus-model discrepancy containing both remains verified as genuine divergence
 * 4. Revenue FY26 £999m is mismatched and flagged
 * 5. Wrong source document does not verify
 * 6. Same metric and period without coordinates remains ambiguous when multiple values exist
 * 7. Exact sheet and cell disambiguate duplicate metric/period values
 * 8. Same value in another metric does not verify
 * 9. Same value in another period does not verify
 * 10. GBP does not verify against explicit USD
 * 11. Percentages do not verify against monetary figures
 * 12. One verified and one fabricated citation leaves the finding unverified
 * 13. Known Saint FY26 revenue and EBITDA discrepancies remain valid findings
 * 14. The known £19.5m false divergence caused by period mislabelling remains rejected
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix9-cited-value-coordinates.test.ts
 */

import {
  resolveCitedValues,
  parseMonetaryValue,
  valuesWithinTolerance,
  type VerifiedFigure,
} from "../cited-value-resolver.js";

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
// Fixture: Verified figures for Saint/SCG deal
// ---------------------------------------------------------------------------

const MEMO_DOC_ID = "memo-doc-001";
const MODEL_DOC_ID = "model-doc-002";

const figures: VerifiedFigure[] = [
  // Memo Revenue FY26 — £191.2m
  { name: "Revenue", period: "FY2026", value: 191_200_000, source_doc: "Project Saint Memo", source_cell: "Table 2, Row: Revenue", source_sheet: "P&L Summary", currency: "GBP", document_id: MEMO_DOC_ID, scope: "group" },
  // Model Revenue FY26 — £184.4m
  { name: "Revenue", period: "FY2026", value: 184_400_000, source_doc: "Financial Model", source_cell: "B12", source_sheet: "Model Output", currency: "GBP", document_id: MODEL_DOC_ID, scope: "group" },
  // Memo EBITDA FY26 — £47.5m
  { name: "EBITDA", period: "FY2026", value: 47_500_000, source_doc: "Project Saint Memo", source_cell: "Table 2, Row: EBITDA", source_sheet: "P&L Summary", currency: "GBP", document_id: MEMO_DOC_ID, scope: "group" },
  // Model EBITDA FY26 — £44.1m
  { name: "EBITDA", period: "FY2026", value: 44_100_000, source_doc: "Financial Model", source_cell: "B15", source_sheet: "Model Output", currency: "GBP", document_id: MODEL_DOC_ID, scope: "group" },
  // Model Revenue FY25 — £160.0m
  { name: "Revenue", period: "FY2025", value: 160_000_000, source_doc: "Financial Model", source_cell: "C12", source_sheet: "Model Output", currency: "GBP", document_id: MODEL_DOC_ID, scope: "group" },
  // A USD figure
  { name: "Revenue", period: "FY2026", value: 240_000_000, source_doc: "US Subsidiary Report", source_cell: "D5", source_sheet: "P&L", currency: "USD", document_id: "us-doc-003" },
];

// ---------------------------------------------------------------------------
// Test 1: Memo Revenue FY26 £191.2m resolves to the memo coordinate
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f1",
    evidence: [{
      figure: "£191.2m",
      verbatim_snippet: "Revenue of £191.2m per the memo",
      metric: "Revenue",
      period: "FY2026",
      document_id: MEMO_DOC_ID,
      source_filename: "Project Saint Memo.pdf",
      document_role: "ic_memo",
      sheet_or_page: "P&L Summary",
    }],
  }], figures);

  const citation = results[0].citations[0];
  assertEqual(citation.status, "verified", "Test 1: Memo Revenue FY26 £191.2m resolves to memo (verified)");
  assertEqual(citation.matchedSource, "Project Saint Memo", "Test 1b: Match source is memo");
}

// ---------------------------------------------------------------------------
// Test 2: Model Revenue FY26 £184.4m resolves to the model coordinate
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f2",
    evidence: [{
      figure: "£184.4m",
      verbatim_snippet: "Model shows Revenue of £184.4m",
      metric: "Revenue",
      period: "FY2026",
      document_id: MODEL_DOC_ID,
      source_filename: "Financial Model.xlsx",
      document_role: "financial_model",
      sheet_or_page: "Model Output",
    }],
  }], figures);

  const citation = results[0].citations[0];
  assertEqual(citation.status, "verified", "Test 2: Model Revenue FY26 £184.4m resolves to model (verified)");
  assertEqual(citation.matchedSource, "Financial Model", "Test 2b: Match source is model");
}

// ---------------------------------------------------------------------------
// Test 3: Memo-versus-model discrepancy containing both remains verified
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f3",
    evidence: [
      { figure: "£191.2m", verbatim_snippet: "Memo: £191.2m", metric: "Revenue", period: "FY2026", document_id: MEMO_DOC_ID, sheet_or_page: "P&L Summary" },
      { figure: "£184.4m", verbatim_snippet: "Model: £184.4m", metric: "Revenue", period: "FY2026", document_id: MODEL_DOC_ID, sheet_or_page: "Model Output" },
    ],
  }], figures);

  assertEqual(results[0].verified, 2, "Test 3: Both citations verified (genuine divergence between sources)");
  assert(!results[0].shouldFlagUnverified, "Test 3b: Finding NOT flagged as unverified");
}

// ---------------------------------------------------------------------------
// Test 4: Revenue FY26 £999m is mismatched and flagged
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f4",
    evidence: [{
      figure: "£999m",
      verbatim_snippet: "Revenue of £999m",
      metric: "Revenue",
      period: "FY2026",
      document_id: MEMO_DOC_ID,
      sheet_or_page: "P&L Summary",
    }],
  }], figures);

  const citation = results[0].citations[0];
  assertEqual(citation.status, "mismatched", "Test 4: £999m vs £191.2m is mismatched");
  assert(results[0].shouldFlagUnverified, "Test 4b: Finding flagged as unverified");
}

// ---------------------------------------------------------------------------
// Test 5: Wrong source document does not verify
// ---------------------------------------------------------------------------
{
  // Citing £191.2m but claiming it's from the model (not the memo)
  const results = resolveCitedValues([{
    finding_id: "f5",
    evidence: [{
      figure: "£191.2m",
      verbatim_snippet: "Model Revenue £191.2m",
      metric: "Revenue",
      period: "FY2026",
      document_id: MODEL_DOC_ID, // Wrong doc!
      sheet_or_page: "Model Output",
    }],
  }], figures);

  const citation = results[0].citations[0];
  // Model Revenue FY26 is £184.4m, not £191.2m → mismatched
  assertEqual(citation.status, "mismatched", "Test 5: Citing £191.2m from model doc → mismatched (model has £184.4m)");
}

// ---------------------------------------------------------------------------
// Test 6: Same metric/period without document coordinates = ambiguous when multiple values
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f6",
    evidence: [{
      figure: "£191.2m",
      verbatim_snippet: "Revenue FY26: £191.2m",
      metric: "Revenue",
      period: "FY2026",
      // No document_id — global match
    }],
  }], figures);

  const citation = results[0].citations[0];
  // Revenue FY26 exists in both memo (£191.2m) and model (£184.4m) and USD ($240m)
  // After currency filter (GBP), still 2 values. Multiple candidates → ambiguous
  assertEqual(citation.status, "ambiguous", "Test 6: Same metric+period with multiple GBP values → ambiguous");
}

// ---------------------------------------------------------------------------
// Test 7: Exact sheet and cell disambiguate duplicate metric/period values
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f7",
    evidence: [{
      figure: "£184.4m",
      verbatim_snippet: "Cell B12: £184.4m",
      metric: "Revenue",
      period: "FY2026",
      document_id: MODEL_DOC_ID,
      sheet_or_page: "Model Output",
      cell_coordinate: "B12",
    }],
  }], figures);

  const citation = results[0].citations[0];
  assertEqual(citation.status, "verified", "Test 7: Exact doc+sheet+cell disambiguates → verified");
  assertEqual(citation.matchTier, "exact_cell", "Test 7b: Resolved via exact_cell tier");
}

// ---------------------------------------------------------------------------
// Test 8: Same value in another metric does not verify
// ---------------------------------------------------------------------------
{
  // Trying to verify £47.5m against Revenue (which is £191.2m in the memo)
  const results = resolveCitedValues([{
    finding_id: "f8",
    evidence: [{
      figure: "£47.5m",
      verbatim_snippet: "Revenue of £47.5m",
      metric: "Revenue", // Claims Revenue, but value is EBITDA
      period: "FY2026",
      document_id: MEMO_DOC_ID,
      sheet_or_page: "P&L Summary",
    }],
  }], figures);

  const citation = results[0].citations[0];
  // Memo Revenue FY26 is £191.2m, not £47.5m → mismatched
  assertEqual(citation.status, "mismatched", "Test 8: £47.5m claimed as Revenue → mismatched (actual Revenue is £191.2m)");
}

// ---------------------------------------------------------------------------
// Test 9: Same value in another period does not verify
// ---------------------------------------------------------------------------
{
  // Trying to verify £184.4m against FY25 (which is £160m)
  const results = resolveCitedValues([{
    finding_id: "f9",
    evidence: [{
      figure: "£184.4m",
      verbatim_snippet: "FY25 Revenue £184.4m",
      metric: "Revenue",
      period: "FY2025",
      document_id: MODEL_DOC_ID,
      sheet_or_page: "Model Output",
    }],
  }], figures);

  const citation = results[0].citations[0];
  // Model Revenue FY25 is £160m, not £184.4m → mismatched
  assertEqual(citation.status, "mismatched", "Test 9: £184.4m claimed as FY25 → mismatched (FY25 is £160m)");
}

// ---------------------------------------------------------------------------
// Test 10: GBP does not verify against explicit USD
// ---------------------------------------------------------------------------
{
  // Citing £240m (GBP) but only USD figure has that value
  const results = resolveCitedValues([{
    finding_id: "f10",
    evidence: [{
      figure: "£240m",
      verbatim_snippet: "Group Revenue £240m",
      metric: "Revenue",
      period: "FY2026",
      document_id: "us-doc-003",
    }],
  }], figures);

  const citation = results[0].citations[0];
  // us-doc-003 has Revenue FY26 = $240m (USD), but citation is in GBP
  // Currency filter removes the USD figure → no candidates remain → unresolved
  assertEqual(citation.status, "unresolved", "Test 10: GBP citation does not match USD figure");
}

// ---------------------------------------------------------------------------
// Test 11: Percentages do not verify against monetary figures
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f11",
    evidence: [{
      figure: "25%",
      verbatim_snippet: "Margin of 25%",
      metric: "EBITDA Margin",
      period: "FY2026",
    }],
  }], figures);

  const citation = results[0].citations[0];
  // 25% is a percentage — must not match any monetary figure
  assertEqual(citation.status, "unresolved", "Test 11: Percentage value does not match monetary figures");
}

// ---------------------------------------------------------------------------
// Test 12: One verified + one fabricated citation → finding unverified
// ---------------------------------------------------------------------------
{
  const results = resolveCitedValues([{
    finding_id: "f12",
    evidence: [
      { figure: "£191.2m", verbatim_snippet: "Memo Rev £191.2m", metric: "Revenue", period: "FY2026", document_id: MEMO_DOC_ID },
      { figure: "£500m", verbatim_snippet: "Revenue £500m fabricated", metric: "Revenue", period: "FY2026", document_id: MEMO_DOC_ID },
    ],
  }], figures);

  assertEqual(results[0].verified, 1, "Test 12a: First citation verified");
  assertEqual(results[0].mismatched, 1, "Test 12b: Second citation mismatched (fabricated)");
  assert(results[0].shouldFlagUnverified, "Test 12c: Finding flagged unverified (one good + one bad → bad wins)");
}

// ---------------------------------------------------------------------------
// Test 13: Known Saint FY26 revenue and EBITDA discrepancies remain valid
// ---------------------------------------------------------------------------
{
  // Both memo and model values exist and are legitimately different
  // A finding citing both should show verified citations (genuine divergence)
  const results = resolveCitedValues([{
    finding_id: "saint-rev",
    evidence: [
      { figure: "£191.2m", verbatim_snippet: "Memo: £191.2m", metric: "Revenue", period: "FY2026", document_id: MEMO_DOC_ID },
      { figure: "£184.4m", verbatim_snippet: "Model: £184.4m", metric: "Revenue", period: "FY2026", document_id: MODEL_DOC_ID },
    ],
  }, {
    finding_id: "saint-ebitda",
    evidence: [
      { figure: "£47.5m", verbatim_snippet: "Memo EBITDA: £47.5m", metric: "EBITDA", period: "FY2026", document_id: MEMO_DOC_ID },
      { figure: "£44.1m", verbatim_snippet: "Model EBITDA: £44.1m", metric: "EBITDA", period: "FY2026", document_id: MODEL_DOC_ID },
    ],
  }], figures);

  assert(!results[0].shouldFlagUnverified, "Test 13a: Revenue discrepancy (memo vs model) both verified → not flagged");
  assert(!results[1].shouldFlagUnverified, "Test 13b: EBITDA discrepancy (memo vs model) both verified → not flagged");
}

// ---------------------------------------------------------------------------
// Test 14: Known £19.5m false divergence (period mislabelling) remains rejected
// ---------------------------------------------------------------------------
{
  // A citation claims £19.5m for Revenue FY26 from memo, but memo says £191.2m
  // This simulates the known defect where period mislabelling creates a false finding
  const results = resolveCitedValues([{
    finding_id: "false-div",
    evidence: [{
      figure: "£19.5m",
      verbatim_snippet: "FY26 Revenue £19.5m per IC memo",
      metric: "Revenue",
      period: "FY2026",
      document_id: MEMO_DOC_ID,
      sheet_or_page: "P&L Summary",
    }],
  }], figures);

  const citation = results[0].citations[0];
  assertEqual(citation.status, "mismatched", "Test 14: £19.5m false divergence caught as mismatched");
  assert(results[0].shouldFlagUnverified, "Test 14b: Finding flagged unverified (£19.5m ≠ £191.2m)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Fix 9 (Commit 2) tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);
if (failed > 0) process.exit(1);
