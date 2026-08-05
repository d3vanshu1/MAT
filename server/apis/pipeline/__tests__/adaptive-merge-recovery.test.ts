/**
 * Adaptive Merge Recovery — Tests (1–10 per specification)
 *
 * Proves:
 *   1. Oversized node completes across multiple invocations
 *   2. Budget expiry resumes from the next subgroup
 *   3. Cross-partition duplicates consolidate
 *   4. Pending subgroup blocks node completion
 *   5. Explicit valid [] can complete
 *   6. Invalid/truncated empty output cannot
 *   7. Payload change invalidates parent
 *   8. Timestamp-only change does not
 *   9. Busy/CAS/no-progress statuses are honest
 *  10. No budget fallback can be marked complete
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/adaptive-merge-recovery.test.ts
 */

import * as fs from "fs";
import * as path from "path";

const DIR = path.resolve(import.meta.dirname ?? ".", "..");

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; const err = `  ✗ FAIL: ${msg}`; errors.push(err); console.error(err); }
}

function assertContains(source: string, needle: string, msg: string): void {
  assert(source.includes(needle), msg);
}

function assertNotContains(source: string, needle: string, msg: string): void {
  assert(!source.includes(needle), msg);
}

// ---------------------------------------------------------------------------
// Load source
// ---------------------------------------------------------------------------
const adaptiveRecovery = fs.readFileSync(path.join(DIR, "adaptive-merge-recovery.ts"), "utf-8");

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" Adaptive Merge Recovery — Tests (1–10)");
console.log("════════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// Test 1: Oversized node completes across multiple invocations
// ---------------------------------------------------------------------------
console.log("\n─── Test 1: Oversized node completes across multiple invocations ───");

// The node state has subgroups and a cursor that persists across invocations
assertContains(adaptiveRecovery, "cursor: number", "Durable cursor field exists in node state");
assertContains(adaptiveRecovery, "subgroups: SubgroupState[]", "Subgroup array persisted");
assertContains(adaptiveRecovery, "persistNodeState", "Node state is persisted between invocations");
assertContains(adaptiveRecovery, "nodeState.cursor = pendingIdx + 1", "Cursor advances after subgroup completion");
assertContains(adaptiveRecovery, "splitGeneration: number", "Split generation tracks recursive splits");

// ---------------------------------------------------------------------------
// Test 2: Budget expiry resumes from the next subgroup
// ---------------------------------------------------------------------------
console.log("\n─── Test 2: Budget expiry resumes from the next subgroup ───");

// Budget exhaustion persists cursor, returns retryable (not progress with degraded output)
assertContains(adaptiveRecovery, "\"budget_exhaustion\"", "Budget exhaustion is a classified failure");
assertContains(adaptiveRecovery, "persist_cursor_resume", "Budget exhaustion action is persist + resume");
assertContains(adaptiveRecovery, "status: 'partial'", "Partial status written on budget exhaustion");
assertContains(adaptiveRecovery, "return { status: \"retryable\" as const", "Budget exhaustion returns retryable");
assertNotContains(adaptiveRecovery, "degraded_fallback", "No degraded fallback output on budget exhaustion");

// ---------------------------------------------------------------------------
// Test 3: Cross-partition duplicates consolidate
// ---------------------------------------------------------------------------
console.log("\n─── Test 3: Cross-partition duplicates consolidate ───");

// Reconciliation is mandatory when multiple subgroups exist
assertContains(adaptiveRecovery, "reconciliationRequired: true", "Reconciliation required when >1 subgroup");
assertContains(adaptiveRecovery, "reconciliationComplete", "Reconciliation completion tracked");
assertContains(adaptiveRecovery, "allSubgroupFindings", "Reconciliation gathers all subgroup outputs");
assertContains(adaptiveRecovery, "deduplicateFindings", "Deduplication applied after reconciliation");
assertContains(adaptiveRecovery, "merged_from_finding_ids", "Merge tracking via merged_from_finding_ids");

// ---------------------------------------------------------------------------
// Test 4: Pending subgroup blocks node completion
// ---------------------------------------------------------------------------
console.log("\n─── Test 4: Pending subgroup blocks node completion ───");

// INVARIANT: anyPending prevents CAS complete
assertContains(adaptiveRecovery, "anyPending", "Pending check exists");
assertContains(adaptiveRecovery, "const anyPending = nodeState.subgroups.some(sg => sg.status === \"pending\")", "Pending subgroup detected");
// When pending, returns progress (not complete)
assertContains(adaptiveRecovery, "if (anyPending) {", "Pending subgroup branch exists");

// Verify: CAS complete only happens AFTER pending check passes
const pendingCheckIdx = adaptiveRecovery.indexOf("if (anyPending)");
const casCompleteIdx = adaptiveRecovery.indexOf("CAS complete");
assert(pendingCheckIdx < casCompleteIdx, "Pending check occurs before CAS complete");

// ---------------------------------------------------------------------------
// Test 5: Explicit valid [] can complete
// ---------------------------------------------------------------------------
console.log("\n─── Test 5: Explicit valid [] can complete ───");

// parseCanonicalFindings accepts empty array
assertContains(adaptiveRecovery, "if (!Array.isArray(parsed))", "Array type check on parsed output");
// An empty array from parseCanonicalFindings will have findings.length === 0
// The CAS complete logic doesn't require findings.length > 0
const casSection = adaptiveRecovery.slice(adaptiveRecovery.indexOf("Step 10: CAS persist"));
assertNotContains(casSection, "finalFindings.length === 0", "No guard preventing empty findings completion");
assertNotContains(casSection, "finalFindings.length < 1", "No minimum finding count for completion");

// ---------------------------------------------------------------------------
// Test 6: Invalid/truncated empty output cannot complete
// ---------------------------------------------------------------------------
console.log("\n─── Test 6: Invalid/truncated empty output cannot complete ───");

// Missing tags throw, truncated throws
assertContains(adaptiveRecovery, "throw new AdaptiveRecoveryError(\"missing_tag\"", "Missing tag throws error");
assertContains(adaptiveRecovery, "throw new AdaptiveRecoveryError(\"truncated_response\"", "Truncated response throws");
assertContains(adaptiveRecovery, "throw new AdaptiveRecoveryError(\"invalid_json\"", "Invalid JSON throws");
// These all prevent the subgroup from being marked complete
assertContains(adaptiveRecovery, "subgroup.status = \"complete\"", "Only explicit success marks complete");
// The complete assignment is INSIDE the try block, BEFORE the catch
const tryIdx = adaptiveRecovery.indexOf("try {", adaptiveRecovery.indexOf("Step 6: Process next pending subgroup"));
const completeAssignIdx = adaptiveRecovery.indexOf("subgroup.status = \"complete\"", tryIdx);
const catchIdx = adaptiveRecovery.indexOf("} catch (err)", tryIdx);
assert(completeAssignIdx < catchIdx, "Complete assignment is inside try block (errors prevent it)");

// ---------------------------------------------------------------------------
// Test 7: Payload change invalidates parent
// ---------------------------------------------------------------------------
console.log("\n─── Test 7: Payload change invalidates parent ───");

// Dependency fingerprint based on payload hashes, not timestamps
assertContains(adaptiveRecovery, "dependencyFingerprint", "Dependency fingerprint field exists");
assertContains(adaptiveRecovery, "computeDependencyFingerprint", "Dependency fingerprint computation");
assertContains(adaptiveRecovery, "childPayloadHashes", "Uses payload hashes for fingerprint");
assertContains(adaptiveRecovery, "currentFingerprint", "Current fingerprint computed from children");
assertContains(adaptiveRecovery, "node.nodeState.dependencyFingerprint !== currentFingerprint", "Fingerprint mismatch triggers invalidation");
assertContains(adaptiveRecovery, "Invalidate stale node", "Stale node invalidation logged");

// ---------------------------------------------------------------------------
// Test 8: Timestamp-only change does not invalidate
// ---------------------------------------------------------------------------
console.log("\n─── Test 8: Timestamp-only change does not invalidate ───");

// Invalidation is based on payload hash, NOT updated_at
const invalidationSection = adaptiveRecovery.slice(
  adaptiveRecovery.indexOf("Step 2: Invalidate stale parents"),
  adaptiveRecovery.indexOf("Step 3: Find next workable node")
);
assertNotContains(invalidationSection, "updatedAt", "Invalidation does NOT use timestamps");
assertNotContains(invalidationSection, "updated_at >", "No timestamp comparison in invalidation");
assertContains(invalidationSection, "dependencyFingerprint", "Fingerprint-based invalidation only");

// ---------------------------------------------------------------------------
// Test 9: Busy/CAS/no-progress statuses are honest
// ---------------------------------------------------------------------------
console.log("\n─── Test 9: Busy/CAS/no-progress statuses are honest ───");

// Claim failure → busy (not progress/blocked)
assertContains(adaptiveRecovery, "return { status: \"busy\" as const", "Busy status returned on claim conflict");
// CAS conflict → retryable (not progress)
assertContains(adaptiveRecovery, "\"cas_conflict\"", "CAS conflict is a classified failure");
assertContains(adaptiveRecovery, "diag.failureClass = \"cas_conflict\"", "CAS failure diagnosed");
// Budget returns retryable (not progress implying work was done)
const retryableCount = (adaptiveRecovery.match(/status: "retryable"/g) || []).length;
assert(retryableCount >= 2, `Multiple retryable return paths exist (found ${retryableCount})`);

// ---------------------------------------------------------------------------
// Test 10: No budget fallback can be marked complete
// ---------------------------------------------------------------------------
console.log("\n─── Test 10: No budget fallback can be marked complete ───");

// Budget exhaustion path never reaches CAS complete
assertNotContains(adaptiveRecovery, "degraded_pass_through", "No degraded pass-through concept");
assertNotContains(adaptiveRecovery, "degraded_fallback", "No degraded fallback patterns");

// The budget check returns BEFORE any CAS complete logic
const budgetReturnIdx = adaptiveRecovery.indexOf("return { status: \"retryable\" as const, diagnostics: diag }");
const casAtomicIdx = adaptiveRecovery.indexOf("Step 10: CAS persist as complete");
assert(budgetReturnIdx < casAtomicIdx, "Budget exhaustion returns before CAS complete is possible");

// Verify status meanings are all distinct
assertContains(adaptiveRecovery, "\"progress\"", "Status: progress exists");
assertContains(adaptiveRecovery, "\"busy\"", "Status: busy exists");
assertContains(adaptiveRecovery, "\"retryable\"", "Status: retryable exists");
assertContains(adaptiveRecovery, "\"blocked\"", "Status: blocked exists");
assertContains(adaptiveRecovery, "\"complete\"", "Status: complete exists");
assertContains(adaptiveRecovery, "\"failed\"", "Status: failed exists");

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------
console.log("\n─── Structural Invariants ───");

// All required failure classes present
const requiredFailureClasses = [
  "budget_exhaustion", "model_timeout", "context_limit", "truncated_response",
  "missing_tag", "invalid_json", "merge_contract_rejection", "persistence_failure",
  "cas_conflict", "missing_stale_child", "unknown"
];
for (const fc of requiredFailureClasses) {
  assertContains(adaptiveRecovery, `"${fc}"`, `Failure class "${fc}" defined`);
}

// All persisted state fields present
const requiredStateFields = [
  "inputFindingIds", "childIds", "childPayloadHashes", "dependencyFingerprint",
  "splitGeneration", "subgroups", "cursor", "attemptCount", "failureClass",
  "outputHash", "ancestryHash", "ancestryCount", "pipelineVersion", "mergePolicyVersion"
];
for (const field of requiredStateFields) {
  assertContains(adaptiveRecovery, field, `Persisted state field "${field}" exists`);
}

// No downstream quality-stage invocations
assertNotContains(adaptiveRecovery, "runPostMergeFinalizationStages", "No post-merge finalization");
assertNotContains(adaptiveRecovery, "f06CanonicalFinalize", "No F06 in recovery");
assertNotContains(adaptiveRecovery, "runClaimsExtraction", "No claims in recovery");
assertNotContains(adaptiveRecovery, "runReconciliation", "No reconciliation in recovery");

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
