/**
 * Fix 20 — Deterministic reconciliation supersession producer
 *
 * Validates that supersedes_finding_ids is populated ONLY with exact canonical
 * ID proof. Ambiguous relationships remain append-only with diagnostics.
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix20-deterministic-supersession.test.ts
 */

import { validateSupersessionProof } from "../claims-reconciliation.js";
import type { SupersessionDiagnostic } from "../claims-reconciliation.js";

// ---------- helpers ----------
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

function baseClaim(overrides: Record<string, unknown> = {}): any {
  return {
    metric: "revenue",
    scope_qualifier: "Total Group Revenue",
    period: "FY Mar-26",
    source_doc: "IC_Memo_v3.pdf",
    unit: "£m",
    value: 100,
    claim_category: "operating_metric",
    basis_note: "",
    verbatim_snippet: "Total revenue of £100m",
    ...overrides,
  };
}

// ---------- Test 1: Deterministic replacement — exact coordinate + source match ----------
{
  const claim = baseClaim();
  const candidates = [
    {
      canonical_id: "finding-old-001",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf",
    },
  ];

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    candidates
  );

  assertEqual(result.proven_ids.length, 1, "Test 1: should have 1 proven ID");
  assertEqual(result.proven_ids[0], "finding-old-001", "Test 1: proven ID should match");
  assertEqual(result.ambiguous_ids.length, 0, "Test 1: no ambiguous IDs");
  assert(result.diagnostic !== null, "Test 1: diagnostic should exist");
  assertEqual(result.diagnostic!.decision, "proven", "Test 1: decision should be 'proven'");
  console.log("PASS: Test 1 — Deterministic replacement with exact coordinate proof");
}

// ---------- Test 2: Ambiguous — same category/title but different source doc ----------
{
  const claim = baseClaim({ source_doc: "IC_Memo_v4.pdf" });
  const candidates = [
    {
      canonical_id: "finding-old-002",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf", // Different source doc
    },
  ];

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    candidates
  );

  assertEqual(result.proven_ids.length, 0, "Test 2: should have 0 proven IDs");
  assertEqual(result.ambiguous_ids.length, 1, "Test 2: should have 1 ambiguous ID");
  assert(result.diagnostic !== null, "Test 2: diagnostic should exist");
  assertEqual(result.diagnostic!.decision, "ambiguous_appended", "Test 2: decision = ambiguous_appended");
  assert(
    !!result.diagnostic!.reason.includes("failed proof gates"),
    "Test 2: reason should explain failure"
  );
  console.log("PASS: Test 2 — Ambiguous candidate (different source doc) → append-only");
}

// ---------- Test 3: Same category not implied — different metric blocks supersession ----------
{
  const claim = baseClaim({ metric: "ebitda", scope_qualifier: "Adjusted EBITDA" });
  const candidates = [
    {
      canonical_id: "finding-old-003",
      claim_metric: "revenue", // Different metric!
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf",
    },
  ];

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    candidates
  );

  assertEqual(result.proven_ids.length, 0, "Test 3: should have 0 proven IDs");
  assertEqual(result.ambiguous_ids.length, 1, "Test 3: 1 ambiguous (metric mismatch)");
  assertEqual(result.diagnostic!.decision, "ambiguous_appended", "Test 3: ambiguous decision");
  console.log("PASS: Test 3 — Same category/period but different metric → not sufficient proof");
}

// ---------- Test 4: Unknown IDs are safe — empty candidates returns no supersession ----------
{
  const claim = baseClaim();

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    [] // No candidates
  );

  assertEqual(result.proven_ids.length, 0, "Test 4: no proven IDs");
  assertEqual(result.ambiguous_ids.length, 0, "Test 4: no ambiguous IDs");
  assertEqual(result.diagnostic, null, "Test 4: no diagnostic when no candidates");
  console.log("PASS: Test 4 — Empty candidates returns clean append-only (no diagnostic)");
}

// ---------- Test 5: Diagnostics survive — proven case records full metadata ----------
{
  const claim = baseClaim();
  const candidates = [
    {
      canonical_id: "finding-proven-A",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf",
    },
    {
      canonical_id: "finding-proven-B",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf",
    },
  ];

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    candidates
  );

  assertEqual(result.proven_ids.length, 2, "Test 5: 2 proven IDs");
  assert(result.diagnostic !== null, "Test 5: diagnostic exists");
  assertEqual(result.diagnostic!.candidate_ids.length, 2, "Test 5: candidate_ids records all");
  assertEqual(result.diagnostic!.proven_ids.length, 2, "Test 5: proven_ids records both");
  assertEqual(result.diagnostic!.ambiguous_ids.length, 0, "Test 5: no ambiguous");
  assert(
    !!result.diagnostic!.reason.includes("proven via exact coordinate"),
    "Test 5: reason explains proof"
  );
  console.log("PASS: Test 5 — Diagnostics record full metadata for proven supersession");
}

// ---------- Test 6: Mixed proven + ambiguous → ALL treated as append-only ----------
{
  const claim = baseClaim();
  const candidates = [
    {
      canonical_id: "finding-proven-X",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-26",
      claim_source_doc: "IC_Memo_v3.pdf", // MATCHES
    },
    {
      canonical_id: "finding-ambiguous-Y",
      claim_metric: "revenue",
      claim_scope: "Total Group Revenue",
      claim_period: "FY Mar-25", // DIFFERENT PERIOD — ambiguous
      claim_source_doc: "IC_Memo_v3.pdf",
    },
  ];

  const result = validateSupersessionProof(
    { claim, finding_kind: "data_divergence" },
    candidates
  );

  // Fix 20 CRITICAL: ANY ambiguity → entire set append-only
  assertEqual(result.proven_ids.length, 0, "Test 6: 0 proven (all demoted due to ambiguity)");
  assertEqual(result.ambiguous_ids.length, 2, "Test 6: ALL candidates in ambiguous set");
  assertEqual(result.diagnostic!.decision, "ambiguous_appended", "Test 6: decision = ambiguous_appended");
  assert(
    result.ambiguous_ids.includes("finding-proven-X") && result.ambiguous_ids.includes("finding-ambiguous-Y"),
    "Test 6: both IDs present in ambiguous list"
  );
  console.log("PASS: Test 6 — Mixed proven + ambiguous → all treated as append-only (no partial supersession)");
}

console.log("\n✅ All 6 Fix 20 tests passed — deterministic reconciliation supersession producer");
