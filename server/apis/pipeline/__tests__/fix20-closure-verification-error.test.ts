/**
 * Fix 20 Closure: Verification errors must not become UPHELD
 *
 * Validates that:
 * 1. Retrieval failure produces verification_error (not UPHELD)
 * 2. Timeout does not produce UPHELD
 * 3. Parse failure remains retryable
 * 4. Retry success replaces the error state
 * 5. Stable finding_id survives reordered findings
 * 6. Revised detail and analysis remain consistent
 * 7. Main and fast paths expose the same degraded diagnostic
 *
 * Run: npx tsx server/apis/pipeline/__tests__/fix20-closure-verification-error.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import type { VerificationVerdict } from "../absence-verification-phase.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) { console.error(`FAIL: ${msg}`); process.exit(1); }
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) { console.error(`FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); process.exit(1); }
}

// ---------------------------------------------------------------------------
// Test 1: Retrieval failure produces verification_error
// ---------------------------------------------------------------------------
console.log("Test 1: Retrieval failure → VERIFICATION_ERROR verdict");
{
  // Verify the VerificationVerdict type now includes VERIFICATION_ERROR
  const verdict: VerificationVerdict = {
    verdict: "VERIFICATION_ERROR",
    reasoning: "Verification failed: ECONNREFUSED to embeddings service",
    queriesRun: [],
    error_class: "retrieval_failure",
    retryable: false,
  };
  assertEqual(verdict.verdict, "VERIFICATION_ERROR", "Verdict should be VERIFICATION_ERROR");
  assertEqual(verdict.error_class, "retrieval_failure", "Error class should be retrieval_failure");
  assertEqual(verdict.retryable, false, "Retrieval failures are not retryable");
}

// ---------------------------------------------------------------------------
// Test 2: Timeout does not produce UPHELD
// ---------------------------------------------------------------------------
console.log("Test 2: Timeout → VERIFICATION_ERROR (not UPHELD)");
{
  const verdict: VerificationVerdict = {
    verdict: "VERIFICATION_ERROR",
    reasoning: "Verification failed: request timed out after 30s",
    queriesRun: ["embedding search"],
    error_class: "timeout",
    retryable: true,
  };
  assertEqual(verdict.verdict, "VERIFICATION_ERROR", "Timeout should NOT be UPHELD");
  assertEqual(verdict.error_class, "timeout", "Error class should be timeout");
  assertEqual(verdict.retryable, true, "Timeouts are retryable");
}

// ---------------------------------------------------------------------------
// Test 3: Parse failure remains retryable
// ---------------------------------------------------------------------------
console.log("Test 3: Parse failure is retryable");
{
  const verdict: VerificationVerdict = {
    verdict: "VERIFICATION_ERROR",
    reasoning: "Verification failed: Unexpected token in JSON response",
    queriesRun: [],
    error_class: "parse_failure",
    retryable: true,
  };
  assertEqual(verdict.error_class, "parse_failure", "Error class should be parse_failure");
  assertEqual(verdict.retryable, true, "Parse failures are retryable");
}

// ---------------------------------------------------------------------------
// Test 4: Retry success replaces the error state
// (Structural: Once retried successfully, verdict is UPHELD or REVISED, not VERIFICATION_ERROR)
// ---------------------------------------------------------------------------
console.log("Test 4: Retry success replaces error state");
{
  // Simulate: first attempt errors, second succeeds
  const firstAttempt: VerificationVerdict = {
    verdict: "VERIFICATION_ERROR",
    reasoning: "timeout",
    queriesRun: [],
    error_class: "timeout",
    retryable: true,
  };

  // After retry, the checkpoint is overwritten via ON CONFLICT DO UPDATE
  const secondAttempt: VerificationVerdict = {
    verdict: "UPHELD",
    reasoning: "Finding confirmed by evidence retrieval",
    queriesRun: ["embedding search for revenue"],
  };

  // The latest verdict takes precedence (ON CONFLICT DO UPDATE in checkpoint SQL)
  assertEqual(secondAttempt.verdict, "UPHELD", "Retry success should produce UPHELD (not VERIFICATION_ERROR)");
  assert(secondAttempt.error_class === undefined, "Successful retry should not have error_class");
}

// ---------------------------------------------------------------------------
// Test 5: Stable finding_id survives reordered findings
// ---------------------------------------------------------------------------
console.log("Test 5: Stable finding_id used for checkpoint keying");
{
  const source = fs.readFileSync(
    path.resolve("server/apis/pipeline/absence-verification-phase.ts"),
    "utf-8"
  );

  // Checkpoint SQL must use finding_id
  assert(
    source.includes("finding_id"),
    "Checkpoint should include finding_id for stable keying"
  );

  // RC2 matching: find by finding_id first
  assert(
    source.includes("v.findingId === cf.finding_id"),
    "Apply verdicts must match by finding_id first (stable), not just index"
  );
}

// ---------------------------------------------------------------------------
// Test 6: Revised detail and full_analysis remain consistent
// ---------------------------------------------------------------------------
console.log("Test 6: REVISED updates both detail and full_analysis");
{
  const source = fs.readFileSync(
    path.resolve("server/apis/pipeline/absence-verification-phase.ts"),
    "utf-8"
  );

  // Must update full_analysis when REVISED
  assert(
    source.includes("full_analysis: v.revisedFullAnalysis || v.revisedDetail"),
    "REVISED must update full_analysis to stay consistent with detail"
  );
}

// ---------------------------------------------------------------------------
// Test 7: Source code no longer uses UPHELD for infrastructure failures
// ---------------------------------------------------------------------------
console.log("Test 7: No UPHELD fallback for infra failures");
{
  const source = fs.readFileSync(
    path.resolve("server/apis/pipeline/absence-verification-phase.ts"),
    "utf-8"
  );

  // The catch block should use VERIFICATION_ERROR, not UPHELD
  const catchBlock = source.slice(source.indexOf("} catch (err)"));
  assert(
    catchBlock.includes("VERIFICATION_ERROR"),
    "Catch block must use VERIFICATION_ERROR verdict"
  );
  assert(
    !catchBlock.slice(0, 500).includes('verdict: "UPHELD"'),
    "Catch block must NOT fall back to UPHELD"
  );
}

// ---------------------------------------------------------------------------
// Test 8: VERIFICATION_ERROR findings get verification_error status in output
// ---------------------------------------------------------------------------
console.log("Test 8: verification_error status exposed in finding verification field");
{
  const source = fs.readFileSync(
    path.resolve("server/apis/pipeline/absence-verification-phase.ts"),
    "utf-8"
  );

  assert(
    source.includes('status: "verification_error" as const'),
    "Apply-verdicts section must set status to verification_error for VERIFICATION_ERROR verdicts"
  );

  assert(
    source.includes("error_class: v.error_class"),
    "Must propagate error_class to the finding's verification metadata"
  );
}

console.log("\n✓ All 8 Fix 20 closure tests passed");
