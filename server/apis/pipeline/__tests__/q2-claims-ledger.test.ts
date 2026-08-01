/**
 * Q2 Claims Ledger — Unit Tests
 *
 * Tests for Commit 2: Deterministic claim identity, enrichment, and duplicate detection.
 *
 * Verifies:
 *  - generateClaimId produces stable, deterministic IDs
 *  - Same inputs → same ID (idempotent)
 *  - Different inputs → different IDs (collision-resistant)
 *  - normalizeClaimText correctly normalizes whitespace, case, punctuation
 *  - deriveMemoVersion maps known filenames
 *  - classifyClaimType classifies correctly
 *  - enrichClaimWithIdentity produces full IdentifiedClaim
 *  - detectDuplicateClaimIds finds duplicates
 *  - resolveClaimReference handles all fail-closed cases
 */
import {
  generateClaimId,
  normalizeClaimText,
  deriveMemoVersion,
  classifyClaimType,
  enrichClaimWithIdentity,
  detectDuplicateClaimIds,
  resolveClaimReference,
  CLAIM_SCHEMA_VERSION,
  type IdentifiedClaim,
} from "../claims-ledger-identity.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(condition: boolean, label: string): void {
  assertEqual(condition, true, label);
}

function assertNotEqual<T>(actual: T, unexpected: T, label: string): void {
  if (actual !== unexpected) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    should not be: ${JSON.stringify(unexpected)}`);
  }
}

function assertMatch(actual: string, regex: RegExp, label: string): void {
  if (regex.test(actual)) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    pattern: ${regex}`);
    console.log(`    actual:  ${actual}`);
  }
}

function assertNull(actual: unknown, label: string): void {
  if (actual === null || actual === undefined) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    console.log(`    expected null/undefined, got: ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// generateClaimId
// ---------------------------------------------------------------------------

console.log("\n=== generateClaimId ===");

const baseParams = {
  ic_document_id: "01026268-c2ff-44e8-8650-5b8570fc8ea3",
  source_page: "12",
  normalized_claim_text: "scg is expected to deliver £194m revenue for fy mar-26",
  metric: "revenue",
  period: "FY Mar-26",
  scope_qualifier: "Total Group Revenue",
};

// Format validation
const idFormat = generateClaimId(baseParams);
assertMatch(
  idFormat,
  new RegExp(`^clm-v${CLAIM_SCHEMA_VERSION}-[0-9a-f]{16}$`),
  "ID format: clm-v{version}-{hex16}"
);

// Determinism
const id1 = generateClaimId(baseParams);
const id2 = generateClaimId(baseParams);
const id3 = generateClaimId({ ...baseParams });
assertEqual(id1, id2, "Deterministic: same inputs → same ID (call 1 vs 2)");
assertEqual(id2, id3, "Deterministic: same inputs → same ID (call 2 vs 3)");

// Collision resistance
assertNotEqual(
  generateClaimId(baseParams),
  generateClaimId({ ...baseParams, metric: "EBITDA" }),
  "Different metric → different ID"
);
assertNotEqual(
  generateClaimId(baseParams),
  generateClaimId({ ...baseParams, ic_document_id: "different-doc-id" }),
  "Different document → different ID"
);
assertNotEqual(
  generateClaimId(baseParams),
  generateClaimId({ ...baseParams, source_page: "13" }),
  "Different page → different ID"
);
assertNotEqual(
  generateClaimId(baseParams),
  generateClaimId({ ...baseParams, period: "FY Mar-27" }),
  "Different period → different ID"
);
assertNotEqual(
  generateClaimId(baseParams),
  generateClaimId({ ...baseParams, scope_qualifier: "UK Revenue" }),
  "Different scope → different ID"
);

// Null page handling
assertMatch(
  generateClaimId({ ...baseParams, source_page: null }),
  new RegExp(`^clm-v${CLAIM_SCHEMA_VERSION}-[0-9a-f]{16}$`),
  "Handles null source_page"
);

// Case insensitivity for metric/period/scope
assertEqual(
  generateClaimId(baseParams),
  generateClaimId({
    ...baseParams,
    metric: "REVENUE",
    period: "fy mar-26",
    scope_qualifier: "total group revenue",
  }),
  "Case-insensitive for metric/period/scope"
);

// Whitespace trimming
assertEqual(
  generateClaimId(baseParams),
  generateClaimId({
    ...baseParams,
    metric: "  revenue  ",
    period: " FY Mar-26 ",
    scope_qualifier: " Total Group Revenue ",
  }),
  "Trims whitespace in metric/period/scope"
);

// ---------------------------------------------------------------------------
// normalizeClaimText
// ---------------------------------------------------------------------------

console.log("\n=== normalizeClaimText ===");

assertEqual(
  normalizeClaimText("Revenue Is Growing"),
  "revenue is growing",
  "Lowercases text"
);
assertEqual(
  normalizeClaimText("revenue   is\t\ngrowing"),
  "revenue is growing",
  "Collapses whitespace"
);
assertEqual(
  normalizeClaimText("  revenue is growing  "),
  "revenue is growing",
  "Trims leading/trailing whitespace"
);
assertEqual(
  normalizeClaimText("revenue is growing."),
  "revenue is growing",
  "Removes trailing period"
);
assertEqual(
  normalizeClaimText("revenue is growing;"),
  "revenue is growing",
  "Removes trailing semicolon"
);
assertEqual(
  normalizeClaimText("revenue is growing..."),
  "revenue is growing",
  "Removes trailing ellipsis"
);
assertEqual(
  normalizeClaimText("run-rate: £63m"),
  "run-rate: £63m",
  "Preserves internal punctuation"
);

// ---------------------------------------------------------------------------
// deriveMemoVersion
// ---------------------------------------------------------------------------

console.log("\n=== deriveMemoVersion ===");

assertEqual(deriveMemoVersion("SCG IC Screening Memo vS.pdf"), "screening", "Maps screening memo");
assertEqual(deriveMemoVersion("2026-05-18 SCG - 2nd IC Memo vS.pdf"), "2nd_ic", "Maps 2nd IC memo");
assertEqual(deriveMemoVersion("2026-06-15 SCG - 3rd IC Memo vS.pdf"), "3rd_ic", "Maps 3rd IC memo");
assertEqual(deriveMemoVersion("IC Update 21 June.pdf"), "ic_update_june", "Maps June update memo");
assertEqual(
  deriveMemoVersion("Unknown Document v2.pdf"),
  "unknown_document_v2",
  "Falls back to sanitized filename"
);

// ---------------------------------------------------------------------------
// classifyClaimType
// ---------------------------------------------------------------------------

console.log("\n=== classifyClaimType ===");

assertEqual(
  classifyClaimType("revenue", "cross_reference", "any"),
  "cross_reference",
  "cross_reference category → cross_reference type"
);
assertEqual(
  classifyClaimType("IRR", "returns_projection", "base case"),
  "valuation_returns",
  "returns_projection → valuation_returns"
);
assertEqual(
  classifyClaimType("multiple", "valuation_structuring", "EV/EBITDA"),
  "valuation_returns",
  "valuation_structuring → valuation_returns"
);
assertEqual(
  classifyClaimType("other_financial", "operating_metric", "Net Revenue Retention (NRR)"),
  "numeric_operational",
  "NRR → numeric_operational"
);
assertEqual(
  classifyClaimType("other_financial", "operating_metric", "Logo churn rate"),
  "numeric_operational",
  "Churn → numeric_operational"
);
assertEqual(
  classifyClaimType("revenue", "operating_metric", "Total Group Revenue"),
  "numeric_financial",
  "Revenue → numeric_financial"
);
assertEqual(
  classifyClaimType("EBITDA", "operating_metric", "Cash EBITDA"),
  "numeric_financial",
  "EBITDA → numeric_financial"
);
assertEqual(
  classifyClaimType("growth_rate", "operating_metric", "Revenue Growth"),
  "numeric_financial",
  "growth_rate → numeric_financial"
);
assertEqual(
  classifyClaimType("market_position", "strategic_claim", "Market leader"),
  "qualitative_strategic",
  "Fallback → qualitative_strategic"
);

// ---------------------------------------------------------------------------
// enrichClaimWithIdentity
// ---------------------------------------------------------------------------

console.log("\n=== enrichClaimWithIdentity ===");

const rawClaim = {
  metric: "revenue",
  scope_qualifier: "Total Group Revenue",
  period: "FY Mar-26",
  value: 194,
  unit: "£m",
  basis_note: "SCG expected",
  source_doc: "2026-05-18 SCG - 2nd IC Memo vS.pdf",
  source_page: "12",
  verbatim_snippet: "SCG is expected to deliver £194m revenue",
  claim_category: "operating_metric",
};

const docCtx = {
  ic_document_id: "01026268-c2ff-44e8-8650-5b8570fc8ea3",
  ic_document_filename: "2026-05-18 SCG - 2nd IC Memo vS.pdf",
};

const enriched = enrichClaimWithIdentity(rawClaim, docCtx);

assertMatch(enriched.claim_id, /^clm-v1-[0-9a-f]{16}$/, "Enriched: valid claim_id format");
assertEqual(enriched.claim_schema_version, "1", "Enriched: schema_version=1");
assertEqual(enriched.metric, "revenue", "Enriched: metric preserved");
assertEqual(enriched.scope_qualifier, "Total Group Revenue", "Enriched: scope_qualifier preserved");
assertEqual(enriched.period, "FY Mar-26", "Enriched: period preserved");
assertEqual(enriched.value, 194, "Enriched: value preserved");
assertEqual(enriched.unit, "£m", "Enriched: unit preserved");
assertEqual(enriched.ic_document_id, docCtx.ic_document_id, "Enriched: document_id from context");
assertEqual(enriched.ic_document_filename, docCtx.ic_document_filename, "Enriched: filename from context");
assertEqual(enriched.memo_version, "2nd_ic", "Enriched: memo_version derived");
assertEqual(enriched.source_page, "12", "Enriched: source_page preserved");
assertEqual(enriched.claim_type, "numeric_financial", "Enriched: claim_type classified");
assertEqual(
  enriched.normalized_claim_text,
  "scg is expected to deliver £194m revenue",
  "Enriched: normalized_claim_text"
);
assertEqual(enriched.extraction_method, "llm_structured_extraction", "Enriched: extraction_method");
assertEqual(enriched.currency, "GBP", "Enriched: currency=GBP from £");

// Determinism
const enriched2 = enrichClaimWithIdentity(rawClaim, docCtx);
assertEqual(enriched.claim_id, enriched2.claim_id, "Enrichment is deterministic");

// Currency extraction
const dollarClaim = enrichClaimWithIdentity({ ...rawClaim, unit: "$m" }, docCtx);
assertEqual(dollarClaim.currency, "USD", "Currency: $ → USD");

const percentClaim = enrichClaimWithIdentity({ ...rawClaim, unit: "%" }, docCtx);
assertNull(percentClaim.currency, "Currency: % → null");

// ---------------------------------------------------------------------------
// detectDuplicateClaimIds
// ---------------------------------------------------------------------------

console.log("\n=== detectDuplicateClaimIds ===");

function makeClaim(id: string): IdentifiedClaim {
  return {
    claim_id: id,
    claim_schema_version: "1",
    metric: "revenue",
    scope_qualifier: "test",
    period: "FY26",
    value: 100,
    unit: "£m",
    basis_note: "",
    claim_category: "operating_metric",
    verbatim_snippet: "test",
    normalized_claim_text: "test",
    claim_type: "numeric_financial",
    ic_document_id: "doc1",
    ic_document_filename: "doc.pdf",
    memo_version: "2nd_ic",
    source_page: null,
    extraction_coordinates: null,
    extraction_method: "llm_structured_extraction",
    entity_or_segment: null,
    actual_or_forecast: null,
    accounting_basis: null,
    currency: null,
  };
}

const noDupeClaims = [makeClaim("clm-v1-aaa"), makeClaim("clm-v1-bbb"), makeClaim("clm-v1-ccc")];
assertEqual(detectDuplicateClaimIds(noDupeClaims).size, 0, "No duplicates → empty map");

const withDupes = [
  makeClaim("clm-v1-aaa"),
  makeClaim("clm-v1-bbb"),
  makeClaim("clm-v1-aaa"), // dup
  makeClaim("clm-v1-ccc"),
  makeClaim("clm-v1-bbb"), // dup
  makeClaim("clm-v1-bbb"), // triple
];
const dupeMap = detectDuplicateClaimIds(withDupes);
assertEqual(dupeMap.size, 2, "2 duplicated IDs detected");
assertEqual(dupeMap.get("clm-v1-aaa"), 2, "aaa appears 2 times");
assertEqual(dupeMap.get("clm-v1-bbb"), 3, "bbb appears 3 times");

assertEqual(detectDuplicateClaimIds([]).size, 0, "Empty array → no duplicates");

// ---------------------------------------------------------------------------
// resolveClaimReference
// ---------------------------------------------------------------------------

console.log("\n=== resolveClaimReference ===");

function makeResolvableClaim(id: string, docId: string): IdentifiedClaim {
  return { ...makeClaim(id), ic_document_id: docId };
}

const claimMap = new Map<string, IdentifiedClaim>([
  ["clm-v1-abc12345abcdef01", makeResolvableClaim("clm-v1-abc12345abcdef01", "doc-eligible-1")],
  ["clm-v1-def67890fedcba02", makeResolvableClaim("clm-v1-def67890fedcba02", "doc-ineligible-1")],
]);

const eligibleDocIds = new Set(["doc-eligible-1"]);

// Successful resolution
const success = resolveClaimReference("clm-v1-abc12345abcdef01", claimMap, eligibleDocIds);
assertTrue(success.resolved, "Resolves valid reference from eligible doc");
assertEqual(success.claim_record?.claim_id, "clm-v1-abc12345abcdef01", "Returns correct claim record");
assertNull(success.failure_reason, "No failure reason on success");
assertNull(success.failure_code, "No failure code on success");

// Missing reference (null)
const missingNull = resolveClaimReference(null, claimMap, eligibleDocIds);
assertTrue(!missingNull.resolved, "Fails for null reference");
assertEqual(missingNull.failure_code, "claim_reference_missing", "null → claim_reference_missing");

// Missing reference (empty string)
const missingEmpty = resolveClaimReference("", claimMap, eligibleDocIds);
assertTrue(!missingEmpty.resolved, "Fails for empty string reference");
assertEqual(missingEmpty.failure_code, "claim_reference_missing", "'' → claim_reference_missing");

// Malformed reference (too short)
const malformed = resolveClaimReference("x", claimMap, eligibleDocIds);
assertTrue(!malformed.resolved, "Fails for malformed reference");
assertEqual(malformed.failure_code, "claim_reference_malformed", "'x' → claim_reference_malformed");

// Unresolved reference (not in map)
const unresolved = resolveClaimReference("clm-v1-nonexistent00000", claimMap, eligibleDocIds);
assertTrue(!unresolved.resolved, "Fails for unresolved reference");
assertEqual(unresolved.failure_code, "claim_reference_unresolved", "Not in map → claim_reference_unresolved");

// Ineligible document
const ineligible = resolveClaimReference("clm-v1-def67890fedcba02", claimMap, eligibleDocIds);
assertTrue(!ineligible.resolved, "Fails for claim from ineligible document");
assertEqual(
  ineligible.failure_code,
  "claim_record_not_from_eligible_ic_document",
  "Ineligible doc → claim_record_not_from_eligible_ic_document"
);
assertEqual(
  ineligible.claim_record?.claim_id,
  "clm-v1-def67890fedcba02",
  "Still returns claim record for debugging"
);

// Old LLM-style references fail as unresolved
const oldRef1 = resolveClaimReference("c3-5", claimMap, eligibleDocIds);
assertTrue(!oldRef1.resolved, "Old LLM ref 'c3-5' fails");
assertEqual(oldRef1.failure_code, "claim_reference_unresolved", "c3-5 → unresolved");

const oldRef2 = resolveClaimReference("c1-8", claimMap, eligibleDocIds);
assertTrue(!oldRef2.resolved, "Old LLM ref 'c1-8' fails");
assertEqual(oldRef2.failure_code, "claim_reference_unresolved", "c1-8 → unresolved");

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`Q2 Claims Ledger Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\nFailed tests:`);
  failures.forEach(f => console.log(`  - ${f}`));
}
console.log(`${"=".repeat(60)}\n`);

export { passed, failed, failures };
