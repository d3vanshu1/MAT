/**
 * Post-Merge Finalization — Static Source Assertions
 *
 * These tests read source files with `fs` and verify structural invariants.
 * Run with: npx tsx server/apis/pipeline/__tests__/post-merge-finalization-static.test.ts
 *
 * NOT bundled by Vite — pure Node.js execution.
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

function assertNotContains(source: string, needle: string, msg: string): void {
  assert(!source.includes(needle), msg);
}

function assertContains(source: string, needle: string, msg: string): void {
  assert(source.includes(needle), msg);
}

// ---------------------------------------------------------------------------
// Load sources
// ---------------------------------------------------------------------------
const pipelineCore = fs.readFileSync(path.join(DIR, "pipeline-core.ts"), "utf-8");
const postMergeRunner = fs.readFileSync(path.join(DIR, "post-merge-finalization.ts"), "utf-8");
const canonicalFinalizer = fs.readFileSync(path.join(DIR, "canonical-finalizer.ts"), "utf-8");

console.log("\n════════════════════════════════════════════════════════════════");
console.log(" Post-Merge Finalization — Static Source Assertions");
console.log("════════════════════════════════════════════════════════════════");

// ---------------------------------------------------------------------------
// A. pipeline-core.ts — unified runner, no direct F06
// ---------------------------------------------------------------------------
console.log("\n─── A. pipeline-core.ts ───");

// 1. No direct f06CanonicalFinalize call
const f06Calls = pipelineCore.match(/f06CanonicalFinalize\s*\(/g);
assert(f06Calls === null, "No direct f06CanonicalFinalize call in pipeline-core.ts");

// 2. No old inline fast-path block
assertNotContains(pipelineCore, "end else (fast-path housekeeping valid)", "Old inline block removed");

// 3. Shared runner imported and used
assertContains(pipelineCore, "runPostMergeFinalizationStages", "Shared runner imported");

// 4. Both call paths exist
assertContains(pipelineCore, 'callerPath: "fast_path"', "fast_path call site exists");
assertContains(pipelineCore, 'callerPath: "normal_path"', "normal_path call site exists");

// 5. No bypass flags
assertNotContains(pipelineCore, "findingsAlreadyPostProcessed", "No findingsAlreadyPostProcessed");
assertNotContains(pipelineCore, "preFormattedReport", "No preFormattedReport passed to runner");

// 6. No FinalizerPrerequisites import (moved to runner)
const prereqImport = pipelineCore.match(/import.*FinalizerPrerequisites.*from/);
assert(prereqImport === null, "No FinalizerPrerequisites import in pipeline-core.ts");

// ---------------------------------------------------------------------------
// B. post-merge-finalization.ts — invariants
// ---------------------------------------------------------------------------
console.log("\n─── B. post-merge-finalization.ts ───");

// 1. Returns actual F06 artifact
assertContains(postMergeRunner, "artifact: f06Outcome.artifact", "Returns f06Outcome.artifact");

// 2. No fabricated evidence
assertNotContains(postMergeRunner, "evidence-admission-v1", "No synthetic evidence schema");
assertNotContains(postMergeRunner, "satisfied structurally", "No fabrication text");
assertNotContains(postMergeRunner, "total_processed: 0", "No empty evidence stats");

// 3. No bypass flags accepted
assertNotContains(postMergeRunner, "findingsAlreadyPostProcessed", "No bypass: findingsAlreadyPostProcessed");
assertNotContains(postMergeRunner, "preFormattedReport", "No bypass: preFormattedReport");

// 4. housekeepingValidated is checked
assertContains(postMergeRunner, "housekeepingValidated", "housekeepingValidated field used");
assertContains(postMergeRunner, "blocked", "Can return blocked status");

// 5. Lineage fingerprints accepted
assertContains(postMergeRunner, "sourceManifestHash", "sourceManifestHash in interface");

// 6. Stage sequence is ordered
assertContains(postMergeRunner, "STAGE_SEQUENCE", "STAGE_SEQUENCE defined");

// ---------------------------------------------------------------------------
// C. canonical-finalizer.ts — invalidated artifact lifecycle
// ---------------------------------------------------------------------------
console.log("\n─── C. canonical-finalizer.ts ───");

// 1. Detects invalidated partial
assertContains(canonicalFinalizer, "[INVALIDATED_PARTIAL]", "Checks for invalidated partial");

// 2. Forces INSERT for invalidated rows
assertContains(canonicalFinalizer, "isInvalidatedPartial", "isInvalidatedPartial logic exists");
assertContains(canonicalFinalizer, "existingOutputs = []", "Clears existingOutputs for invalidated → INSERT");

// 3. Also fetches executive_header for detection
assertContains(canonicalFinalizer, "executive_header", "Fetches executive_header to detect invalidation");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n════════════════════════════════════════════════════════════════");
console.log(` Results: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log("\n FAILURES:");
  errors.forEach(e => console.log(`   ${e}`));
}
console.log("════════════════════════════════════════════════════════════════");

if (failed > 0) process.exit(1);
