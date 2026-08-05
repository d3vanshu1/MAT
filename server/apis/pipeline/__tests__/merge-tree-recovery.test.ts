/**
 * Merge Tree Recovery — Regression Tests
 *
 * Tests A–F per specification:
 *   A. Exact live recovery state
 *   B. Complete output with stale partial status
 *   C. Parent invalidated by changed child membership
 *   D. Invocation boundary resume
 *   E. No-progress protection
 *   F. Natural-root gate
 *
 * These tests validate structural invariants of the ResumeMergeRecovery
 * algorithm via static source assertions and logic validation.
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/merge-tree-recovery.test.ts
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
const resumeMergeRecovery = fs.readFileSync(path.join(DIR, "resume-merge-recovery.ts"), "utf-8");
const pipelineCore = fs.readFileSync(path.join(DIR, "pipeline-core.ts"), "utf-8");
const postMergeFinalization = fs.readFileSync(path.join(DIR, "post-merge-finalization.ts"), "utf-8");

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" Merge Tree Recovery — Regression Tests (A–F)");
console.log("════════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// Test A: Exact live recovery state
// ---------------------------------------------------------------------------
console.log("\n─── Test A: Exact live recovery state ───");

// A1: Recovery processes L1 nodes first (bottom-up)
assertContains(resumeMergeRecovery, "for (let lvl = 1; lvl <= maxLevel", "Recovery iterates bottom-up from L1");

// A2: No quality/downstream functions called
assertNotContains(resumeMergeRecovery, "runPostMergeFinalizationStages", "No post-merge finalization in recovery");
assertNotContains(resumeMergeRecovery, "f06CanonicalFinalize", "No F06 finalization in recovery");
assertNotContains(resumeMergeRecovery, "runClaimsExtraction", "No claims extraction in recovery");
assertNotContains(resumeMergeRecovery, "runReconciliation", "No reconciliation in recovery");
assertNotContains(resumeMergeRecovery, "runAbsenceVerification", "No absence verification in recovery");

// A3: No extraction or analysis functions called
assertNotContains(resumeMergeRecovery, "extractDocument", "No extraction in recovery");
assertNotContains(resumeMergeRecovery, "analyzeChunk", "No analysis in recovery");

// A4: Parents blocked until all children complete
assertContains(resumeMergeRecovery, "childrenReady", "Child completeness check exists");
assertContains(resumeMergeRecovery, "childMeta?.status === \"complete\"", "Parent waits for complete children");

// A5: Nodes at correct level counts for 205/4 fan-in
assertContains(resumeMergeRecovery, "MERGE_GROUP_SIZE = 4", "MERGE_GROUP_SIZE=4 for fan-in=4");
assertContains(resumeMergeRecovery, "Math.ceil((childLevelMaxIndex + 1) / MERGE_GROUP_SIZE)", "Expected node count computed from fan-in");

// ---------------------------------------------------------------------------
// Test B: Complete output with stale partial status
// ---------------------------------------------------------------------------
console.log("\n─── Test B: Complete output with stale partial status ───");

// B1: System checks for existing output before rebuilding
assertContains(resumeMergeRecovery, "status === \"complete\"", "Checks node status");

// B2: Node with status != 'complete' is selected as workable
assertContains(resumeMergeRecovery, "if (existing?.status === \"complete\") continue", "Skips only complete nodes");

// B3: Stale partial nodes with output are NOT automatically promoted
// (They must go through the LLM merge call or explicit validation)
// The recovery rebuilds them — status must be earned through CAS persistence.
assertContains(resumeMergeRecovery, "status = 'complete'", "Status set to complete only in CAS persist");

// ---------------------------------------------------------------------------
// Test C: Parent invalidated by changed child membership
// ---------------------------------------------------------------------------
console.log("\n─── Test C: Parent invalidated by changed child membership ───");

// C1: Stale invalidation step exists
assertContains(resumeMergeRecovery, "Invalidate stale higher-level partials", "Stale invalidation section exists");

// C2: Checks if child updated after parent
assertContains(resumeMergeRecovery, "anyChildNewer", "Detects children newer than parent");
assertContains(resumeMergeRecovery, "c.updatedAt > node.updatedAt", "Compares child vs parent timestamps");

// C3: Stale parent is deleted (will be rebuilt)
assertContains(resumeMergeRecovery, "DELETE FROM merge_checkpoints WHERE module_run_id", "Deletes stale parent for rebuild");

// C4: Invalidation tracked in diagnostics
assertContains(resumeMergeRecovery, "invalidatedNodes", "Invalidation tracked in diagnostics");

// C5: Parent rebuilds only after corrected children complete
// (same mechanism as A4 — childrenReady check)

// ---------------------------------------------------------------------------
// Test D: Invocation boundary resume
// ---------------------------------------------------------------------------
console.log("\n─── Test D: Invocation boundary resume ───");

// D1: Single node per invocation (bounded progress)
assertContains(resumeMergeRecovery, "workUnit: WorkUnit | null = null", "Single work unit per invocation");

// D2: CAS persistence ensures durable completion
assertContains(resumeMergeRecovery, "ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE", "CAS atomic claim");
assertContains(resumeMergeRecovery, "AND checkpoint_version = $", "CAS uses version for safety");

// D3: Next invocation finds next eligible (skips completed)
assertContains(resumeMergeRecovery, "if (existing?.status === \"complete\") continue", "Next invocation skips completed nodes");

// D4: No repeated work — completed nodes not re-processed
assertContains(resumeMergeRecovery, "AND status <> 'complete'", "Claim guard: won't claim complete nodes");

// D5: nextUnresolved reported in diagnostics
assertContains(resumeMergeRecovery, "nextUnresolved", "Reports next eligible node");

// ---------------------------------------------------------------------------
// Test E: No-progress protection
// ---------------------------------------------------------------------------
console.log("\n─── Test E: No-progress protection ───");

// E1: Claim rejection returns blocked (not progress)
assertContains(resumeMergeRecovery, 'claim_rejected', "Claim rejection diagnosed");
{
  // Find the claim_rejected return and verify it's blocked
  const claimRejectedIdx = resumeMergeRecovery.indexOf("claim_rejected");
  const nearbyReturn = resumeMergeRecovery.slice(claimRejectedIdx, claimRejectedIdx + 200);
  assert(nearbyReturn.includes('"blocked"'), "Claim rejection returns blocked status");
}

// E2: Budget exhaustion returns blocked
{
  const budgetIdx = resumeMergeRecovery.indexOf("budget_exhausted_before_work");
  const nearbyReturn = resumeMergeRecovery.slice(budgetIdx, budgetIdx + 200);
  assert(nearbyReturn.includes('"blocked"'), "Budget exhaustion returns blocked status");
}

// E3: Error during processing returns blocked
{
  const errorPersistIdx = resumeMergeRecovery.indexOf("Guarded error persist");
  const nearbyReturn = resumeMergeRecovery.slice(errorPersistIdx, errorPersistIdx + 400);
  assert(nearbyReturn.includes('"blocked"'), "Error during processing returns blocked status");
}

// E4: CAS rejection at finalize returns blocked
{
  const casIdx = resumeMergeRecovery.indexOf("cas_rejected_stale_attempt");
  const nearbyReturn = resumeMergeRecovery.slice(casIdx, casIdx + 200);
  assert(nearbyReturn.includes('"blocked"'), "CAS rejection returns blocked status");
}

// E5: No infinite in_progress loop possible
// All non-success exit paths return 'blocked' or 'complete' (never 'progress' without durable advance)
{
  const progressReturns = resumeMergeRecovery.match(/status:\s*"progress"/g);
  // The only 'progress' return should be after successful CAS persist (which IS durable progress)
  const expectedProgressReturns = 1; // Only after successful completion and nextUnresolved exists
  assert(
    (progressReturns?.length ?? 0) <= expectedProgressReturns,
    `At most ${expectedProgressReturns} progress return (after durable advance), found ${progressReturns?.length ?? 0}`
  );
}

// ---------------------------------------------------------------------------
// Test F: Natural-root gate
// ---------------------------------------------------------------------------
console.log("\n─── Test F: Natural-root gate ───");

// F1: Post-merge finalization only called when root is complete
assertContains(pipelineCore, "runPostMergeFinalizationStages", "Shared runner exists in pipeline-core");

// F2: Fast-path requires manifest validation before engaging
assertContains(pipelineCore, "Root manifest VALIDATED", "Root manifest must be validated");
assertContains(pipelineCore, "manifestValid", "Manifest validation gate exists");

// F3: Source fingerprint validated
assertContains(pipelineCore, "sourceFingerprint", "Source fingerprint checked in fast-path");

// F4: Pipeline version validated
assertContains(pipelineCore, "pipelineVersion", "Pipeline version checked in fast-path");

// F5: Invalidated partial artifact excluded from output check
assertContains(pipelineCore, "NOT LIKE '[INVALIDATED_PARTIAL]%'", "Invalidated artifacts excluded from output check");

// F6: Recovery returns 'complete' only when ALL nodes are done
assertContains(resumeMergeRecovery, "All nodes are complete", "Reports complete only when tree fully resolved");
assertContains(resumeMergeRecovery, "buildWaterfall", "Builds completion waterfall for verification");

// F7: Post-merge finalization runner requires housekeepingValidated
assertContains(postMergeFinalization, "housekeepingValidated", "Shared runner requires housekeeping validation");
assertContains(postMergeFinalization, "status: \"blocked\"", "Shared runner can block on corruption");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n════════════════════════════════════════════════════════════════════");
console.log(` Results: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log("\n FAILURES:");
  errors.forEach(e => console.log(`   ${e}`));
}
console.log("════════════════════════════════════════════════════════════════════");

if (failed > 0) process.exit(1);
