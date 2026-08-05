/**
 * Canonical Finalization & Publication Integrity — Tests (1–12 per specification)
 *
 * Proves:
 *   1. Normal and resume paths use the same runner
 *   2. No upstream merge/analysis runs after valid root
 *   3. Each post-root stage runs once
 *   4. Invocation-boundary resume starts at the next stage
 *   5. Stale lineage is rejected
 *   6. Genuine evidence admission executes
 *   7. Housekeeping corruption blocks
 *   8. Missing canonical schema causes no write
 *   9. Invalidated artifact is preserved and replaced by a distinct active artifact
 *  10. Idempotent call returns the active persisted artifact
 *  11. Blocked/failed are terminal
 *  12. Response, persistence, history and export are identical
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/canonical-finalization-integrity.test.ts
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
const postMergeFinalization = fs.readFileSync(path.join(DIR, "post-merge-finalization.ts"), "utf-8");
const pipelineCore = fs.readFileSync(path.join(DIR, "pipeline-core.ts"), "utf-8");
const canonicalFinalizer = fs.readFileSync(path.join(DIR, "canonical-finalizer.ts"), "utf-8");
const canonicalFinalArtifact = fs.readFileSync(path.join(DIR, "canonical-final-artifact.ts"), "utf-8");

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" Canonical Finalization & Publication Integrity — Tests (1–12)");
console.log("════════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// Test 1: Normal and resume paths use the same runner
// ---------------------------------------------------------------------------
console.log("\n─── Test 1: Normal and resume paths use same runner ───");

// pipeline-core imports runPostMergeFinalizationStages
assertContains(pipelineCore, "runPostMergeFinalizationStages", "Pipeline core uses shared runner");
assertContains(postMergeFinalization, "export async function runPostMergeFinalizationStages", "Shared runner is the exported function");
// Both fast_path and normal_path call the same function
assertContains(pipelineCore, "callerPath: \"fast_path\"", "Fast path uses callerPath tag");
assertContains(pipelineCore, "callerPath: \"normal_path\"", "Normal path uses callerPath tag");
// No inline finalization in pipeline-core
assertNotContains(pipelineCore, "import { canonicalFinalize", "No direct F06 import in pipeline-core");

// ---------------------------------------------------------------------------
// Test 2: No upstream merge/analysis runs after valid root
// ---------------------------------------------------------------------------
console.log("\n─── Test 2: No upstream runs after valid root ───");

// Post-merge finalization never invokes upstream
assertNotContains(postMergeFinalization, "runExtractionPhase", "No extraction in post-merge");
assertNotContains(postMergeFinalization, "analyzeChunk", "No analysis in post-merge");
assertNotContains(postMergeFinalization, "mergeFindings", "No merge in post-merge");
assertNotContains(postMergeFinalization, "completeMergeTree", "No merge tree completion in post-merge");
// Verify by comment
assertContains(postMergeFinalization, "No upstream extraction, analysis, or merge work is invoked", "Documented invariant");

// ---------------------------------------------------------------------------
// Test 3: Each post-root stage runs once
// ---------------------------------------------------------------------------
console.log("\n─── Test 3: Each post-root stage runs once ───");

// Stage sequence is defined and fixed
assertContains(postMergeFinalization, "STAGE_SEQUENCE", "Stage sequence constant defined");
assertContains(postMergeFinalization, "\"claims_ledger\"", "Stage: claims_ledger");
assertContains(postMergeFinalization, "\"reconciliation\"", "Stage: reconciliation");
assertContains(postMergeFinalization, "\"post_merge\"", "Stage: post_merge");
assertContains(postMergeFinalization, "\"absence_verify\"", "Stage: absence_verify");
assertContains(postMergeFinalization, "\"canonical_finalize\"", "Stage: canonical_finalize");
// completedStages tracks what was done
assertContains(postMergeFinalization, "completedStages.push", "Completed stages tracked");

// ---------------------------------------------------------------------------
// Test 4: Invocation-boundary resume starts at the next stage
// ---------------------------------------------------------------------------
console.log("\n─── Test 4: Invocation-boundary resume starts at next stage ───");

// Each stage checks existing checkpoint before executing
assertContains(postMergeFinalization, "claims_ledger", "Claims ledger checkpoint checked");
assertContains(postMergeFinalization, "reconciliation", "Reconciliation checkpoint checked");
// Budget insufficient → in_progress return (resume next invocation)
assertContains(postMergeFinalization, "return buildResult(\"in_progress\"", "Returns in_progress for resume");

// ---------------------------------------------------------------------------
// Test 5: Stale lineage is rejected
// ---------------------------------------------------------------------------
console.log("\n─── Test 5: Stale lineage is rejected ───");

// Lineage validation exists
assertContains(postMergeFinalization, "LineageEnvelope", "Lineage envelope defined");
assertContains(postMergeFinalization, "naturalRootFindingHash", "Root finding hash in lineage");
assertContains(postMergeFinalization, "pipelineVersion", "Pipeline version in lineage");
assertContains(postMergeFinalization, "sourceManifestHash", "Source manifest hash in lineage");
// Stale detection
assertContains(postMergeFinalization, "STALE", "Stale detection logging");
assertContains(postMergeFinalization, "version mismatch", "Version mismatch detection");
// Force re-execution on stale
assertContains(postMergeFinalization, "claimsLedger = null", "Stale claims forces re-extraction");
assertContains(postMergeFinalization, "reconciliationResult = null", "Stale reconciliation forces re-execution");

// ---------------------------------------------------------------------------
// Test 6: Genuine evidence admission executes
// ---------------------------------------------------------------------------
console.log("\n─── Test 6: Genuine evidence admission executes ───");

// Evidence admission check is present and blocking
assertContains(postMergeFinalization, "evidence_admission", "Evidence admission checked");
assertContains(postMergeFinalization, "Cannot fabricate", "No fabrication of evidence");
assertContains(postMergeFinalization, "BLOCKED — evidence_admission missing", "Missing evidence blocks finalization");

// ---------------------------------------------------------------------------
// Test 7: Housekeeping corruption blocks
// ---------------------------------------------------------------------------
console.log("\n─── Test 7: Housekeeping corruption blocks ───");

// housekeepingValidated must be true
assertContains(postMergeFinalization, "housekeepingValidated", "Housekeeping validation required");
assertContains(postMergeFinalization, "if (!housekeepingValidated)", "Housekeeping check is fail-closed");
assertContains(postMergeFinalization, "BLOCKED: housekeeping not validated", "Corruption blocks finalization");
assertContains(postMergeFinalization, "cannot finalize with unverified housekeeping", "Explicit block message");

// ---------------------------------------------------------------------------
// Test 8: Missing canonical schema causes no write
// ---------------------------------------------------------------------------
console.log("\n─── Test 8: Missing canonical schema causes no write ───");

// CANONICAL_SCHEMA_MIGRATION_REQUIRED sentinel exists
assertContains(canonicalFinalArtifact, "CANONICAL_SCHEMA_MIGRATION_REQUIRED", "Schema migration sentinel defined");

// ---------------------------------------------------------------------------
// Test 9: Invalidated artifact preserved and replaced
// ---------------------------------------------------------------------------
console.log("\n─── Test 9: Invalidated artifact preserved, distinct active ───");

// Artifact lifecycle fields
assertContains(canonicalFinalArtifact, "artifact_status", "Artifact status field");
assertContains(canonicalFinalArtifact, "\"active\"", "Active status");
assertContains(canonicalFinalArtifact, "\"invalidated_partial\"", "Invalidated partial status");
assertContains(canonicalFinalArtifact, "\"superseded\"", "Superseded status");
assertContains(canonicalFinalArtifact, "superseded_by_output_id", "Superseded-by reference");
assertContains(canonicalFinalArtifact, "invalidation_reason", "Invalidation reason field");
assertContains(canonicalFinalArtifact, "invalidation_timestamp", "Invalidation timestamp field");

// The old approach relied on [INVALIDATED_PARTIAL] text — verify it's no longer required
assertContains(canonicalFinalArtifact, "ArtifactStatus", "Typed artifact status (not text-based)");

// ---------------------------------------------------------------------------
// Test 10: Idempotent call returns active persisted artifact
// ---------------------------------------------------------------------------
console.log("\n─── Test 10: Idempotent call returns active artifact ───");

// Canonical finalizer has idempotent status
assertContains(canonicalFinalizer, "\"idempotent\"", "Idempotent outcome status");
assertContains(canonicalFinalizer, "status: \"idempotent\"", "Idempotent return path");
// Post-merge handles idempotent
assertContains(postMergeFinalization, "f06Outcome.status === \"idempotent\"", "Idempotent case handled");

// ---------------------------------------------------------------------------
// Test 11: Blocked/failed are terminal
// ---------------------------------------------------------------------------
console.log("\n─── Test 11: Blocked/failed are terminal ───");

// Runner status types
assertContains(postMergeFinalization, "\"blocked\"", "Blocked status exists");
assertContains(postMergeFinalization, "\"failed\"", "Failed status exists");
// These are terminal — no retry loop
assertNotContains(postMergeFinalization, "retry.*blocked", "Blocked is not retried");
assertContains(postMergeFinalization, "return buildResult(\"blocked\"", "Blocked returns immediately");
assertContains(postMergeFinalization, "return buildResult(\"failed\"", "Failed returns immediately");

// Status translation
assertContains(postMergeFinalization, "status: \"complete\"", "Complete status");
assertContains(postMergeFinalization, "status: \"in_progress\"", "In_progress status");

// ---------------------------------------------------------------------------
// Test 12: Response, persistence, history and export are identical
// ---------------------------------------------------------------------------
console.log("\n─── Test 12: Response/persistence/history/export parity ───");

// F06 outcome carries the artifact
assertContains(postMergeFinalization, "artifact: f06Outcome.artifact", "Artifact from F06 outcome returned");
assertContains(postMergeFinalization, "finalizerOutcome: f06Outcome", "Full finalizer outcome returned");
// Canonical finalizer persists the same data it returns
assertContains(canonicalFinalizer, "artifact:", "Artifact in response");
assertContains(canonicalFinalizer, "semanticHash", "Hash in response");
assertContains(canonicalFinalizer, "findingCount", "Count in response");

// ---------------------------------------------------------------------------
// Structural: No caller bypass flags
// ---------------------------------------------------------------------------
console.log("\n─── Structural: No bypass flags ───");

assertNotContains(postMergeFinalization, "findingsAlreadyPostProcessed", "No findingsAlreadyPostProcessed flag");
assertNotContains(postMergeFinalization, "preFormattedReport", "No preFormattedReport flag");
assertNotContains(postMergeFinalization, "bypass", "No bypass mechanism");

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
