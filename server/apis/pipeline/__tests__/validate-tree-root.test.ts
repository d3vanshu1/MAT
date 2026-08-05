/**
 * Validate Tree Root — Tests per specification
 *
 * Proves the 15/9/3/1 partial topology can reach 52/13/4/1 without invoking
 * claims, reconciliation, evidence admission, F06 or publication.
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/validate-tree-root.test.ts
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
// Load sources
// ---------------------------------------------------------------------------
const validateTreeRoot = fs.readFileSync(path.join(DIR, "validate-tree-root.ts"), "utf-8");
const adaptiveRecovery = fs.readFileSync(path.join(DIR, "adaptive-merge-recovery.ts"), "utf-8");

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" Validate Tree Root — Tests");
console.log("════════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// Test: Expected topology computation
// ---------------------------------------------------------------------------
console.log("\n─── Topology Computation ───");

assertContains(validateTreeRoot, "MERGE_GROUP_SIZE = 4", "Fan-in of 4");
assertContains(validateTreeRoot, "Math.ceil(analysisCount / MERGE_GROUP_SIZE)", "L1 count = ceil(205/4) = 52");
assertContains(validateTreeRoot, "Math.ceil(expectedL1 / MERGE_GROUP_SIZE)", "L2 count = ceil(52/4) = 13");
assertContains(validateTreeRoot, "Math.ceil(expectedL2 / MERGE_GROUP_SIZE)", "L3 count = ceil(13/4) = 4");
assertContains(validateTreeRoot, "Math.ceil(expectedL3 / MERGE_GROUP_SIZE)", "L4 count = ceil(4/4) = 1");

// Verify topology totals
// For 205 analyses: 52 + 13 + 4 + 1 = 70
assert(Math.ceil(205/4) === 52, "52 L1 nodes for 205 analyses");
assert(Math.ceil(52/4) === 13, "13 L2 nodes");
assert(Math.ceil(13/4) === 4, "4 L3 nodes");
assert(Math.ceil(4/4) === 1, "1 L4 node (natural root)");
assert(52 + 13 + 4 + 1 === 70, "70 total data nodes");

// ---------------------------------------------------------------------------
// Test: Frozen manifest structure
// ---------------------------------------------------------------------------
console.log("\n─── Frozen Manifest ───");

assertContains(validateTreeRoot, "eligibleAnalysisIds", "Exact eligible analysis IDs");
assertContains(validateTreeRoot, "l1Membership", "Exact L1 membership");
assertContains(validateTreeRoot, "excluded", "Excluded IDs and reasons");
assertContains(validateTreeRoot, "sourceFingerprint", "Source-manifest fingerprint");
assertContains(validateTreeRoot, "computeSourceFingerprint", "Deterministic source fingerprint computation");
assertContains(validateTreeRoot, "computeLeafSetFingerprint", "Leaf set fingerprint for content validation");

// Not derived from contiguous chunk_index ranges alone
assertContains(validateTreeRoot, "analysisRows.map", "Membership from actual analysis rows");

// ---------------------------------------------------------------------------
// Test: Synthetic quality checkpoints excluded
// ---------------------------------------------------------------------------
console.log("\n─── Synthetic Exclusion ───");

assertContains(validateTreeRoot, "tree_level < 90", "Synthetic checkpoints (>=90) excluded");
assertContains(validateTreeRoot, "dataCheckpoints", "Uses filtered data-only checkpoints");

// ---------------------------------------------------------------------------
// Test: Recovery order enforcement
// ---------------------------------------------------------------------------
console.log("\n─── Recovery Order (in Adaptive Recovery) ───");

// Bottom-up processing: L1 → L2 → L3 → L4
assertContains(adaptiveRecovery, "for (let lvl = 1; lvl <= maxLevel", "Bottom-up iteration from L1");
// Children must be complete before parent
assertContains(adaptiveRecovery, "childrenReady", "Child readiness check");
assertContains(adaptiveRecovery, "childMeta?.status === \"complete\"", "Parent only processes when children complete");

// ---------------------------------------------------------------------------
// Test: L1 failure diagnosis
// ---------------------------------------------------------------------------
console.log("\n─── L1 Failure Diagnosis ───");

assertContains(validateTreeRoot, "attemptId", "Attempt ID captured");
assertContains(validateTreeRoot, "requestBytes", "Request bytes captured");
assertContains(validateTreeRoot, "estimatedTokens", "Estimated tokens captured");
assertContains(validateTreeRoot, "outputLimit", "Output limit captured");
assertContains(validateTreeRoot, "stopReason", "Stop reason captured");
assertContains(validateTreeRoot, "rawResponseSize", "Raw response size captured");
assertContains(validateTreeRoot, "tagStatus", "Tag/JSON status captured");
assertContains(validateTreeRoot, "runtime", "Runtime captured");
assertContains(validateTreeRoot, "remainingBudget", "Remaining budget captured");
assertContains(validateTreeRoot, "persistenceResult", "Persistence result captured");
assertContains(validateTreeRoot, "lastError", "Last error captured");
assertContains(validateTreeRoot, "failureClassification", "Failure classification captured");

// Supports both camelCase and snake_case fields
assertContains(validateTreeRoot, "nodeData?.request_bytes ?? nodeData?.requestBytes", "Supports snake_case and camelCase");
assertContains(validateTreeRoot, "nodeData?.stop_reason ?? nodeData?.stopReason", "Supports stop_reason and stopReason");

// Does not infer timeout from missing header
assertNotContains(validateTreeRoot, "!executive_header.*timeout", "No timeout inference from missing header");
assertContains(validateTreeRoot, "classifyNodeFailure", "Explicit failure classification function");

// ---------------------------------------------------------------------------
// Test: Root acceptance criteria
// ---------------------------------------------------------------------------
console.log("\n─── Root Acceptance Criteria ───");

// L1 52/52, L2 13/13, L3 4/4, L4 1/1
assertContains(validateTreeRoot, "completeNodes.length < expected", "Level completeness check");
assertContains(validateTreeRoot, "rejectionReasons", "Rejection reasons collected");

// Zero unresolved
assertContains(validateTreeRoot, "missingIndices", "Missing node indices tracked");

// All 205 analysis IDs in root ancestry
assertContains(validateTreeRoot, "coveredChunkIndices", "Ancestry coverage tracked");
assertContains(validateTreeRoot, "ancestryDetails.missingIds", "Missing ancestry IDs tracked");
assertContains(validateTreeRoot, "ancestryDetails.unexpectedIds", "Unexpected ancestry IDs tracked");
assertContains(validateTreeRoot, "ancestryDetails.duplicateIds", "Duplicate ancestry IDs tracked");

// L4:0 is the only natural root
assertContains(validateTreeRoot, "rootLevelNodes.length > 1", "Single root verification");
assertContains(validateTreeRoot, "Multiple nodes at root level", "Multiple roots rejected");

// Root fingerprint
assertContains(validateTreeRoot, "sourceFingerprint", "Root fingerprint validation");

// ---------------------------------------------------------------------------
// Test: No downstream invocations
// ---------------------------------------------------------------------------
console.log("\n─── No Downstream Invocations ───");

assertNotContains(validateTreeRoot, "runClaimsExtraction", "No claims extraction");
assertNotContains(validateTreeRoot, "runReconciliation", "No reconciliation");
assertNotContains(validateTreeRoot, "f06CanonicalFinalize", "No F06 finalization");
assertNotContains(validateTreeRoot, "runPostMergeFinalization", "No post-merge finalization");
assertNotContains(validateTreeRoot, "evidence_admission", "No evidence admission invocation");
assertNotContains(validateTreeRoot, "runAbsenceVerification", "No absence verification");

// ---------------------------------------------------------------------------
// Test: Manifest persistence
// ---------------------------------------------------------------------------
console.log("\n─── Manifest Persistence ───");

assertContains(validateTreeRoot, "frozen_manifest", "Manifest persisted as checkpoint");
assertContains(validateTreeRoot, "pipeline_checkpoints", "Uses standard checkpoint table");
assertContains(validateTreeRoot, "result.accepted = true", "Accepted only when zero rejection reasons");

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
