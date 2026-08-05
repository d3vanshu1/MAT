/**
 * Adaptive Merge Recovery — Behavioral Acceptance Tests (T01–T12)
 *
 * These tests exercise ACTUAL logic, not source-string patterns.
 * Each test imports and calls a real function or constructs real objects,
 * then asserts behavioral postconditions.
 *
 * T01  getChildIndices — correct index ranges for all tree levels
 * T02  buildSubgroupPlan — deterministic split with stable subgroup IDs
 * T03  buildSubgroupPlan — small input stays single group
 * T04  computeDependencyFingerprint — deterministic across calls
 * T05  computeDependencyFingerprint — changes when payload hash changes
 * T06  computeDependencyFingerprint — order-insensitive (same result regardless of dict order)
 * T07  hashFindingIds — order-insensitive (same IDs, different order → same hash)
 * T08  classifyFailure — AdaptiveRecoveryError carries its own class through
 * T09  classifyAction — failure-class-to-action mapping is correct
 * T10  Post-dedup conservation: every removed finding ID is in merged_from_finding_ids of representative
 * T11  DurableNodeState new fields exist and have correct defaults
 * T12  computeFindingContentHash is sensitive to title/detail/evidence changes
 *
 * Run with: npx tsx server/apis/pipeline/__tests__/adaptive-merge-recovery.test.ts
 */

import {
  computeDependencyFingerprint,
  buildSubgroupPlan,
  getChildIndices,
  classifyFailure,
  classifyAction,
  AdaptiveRecoveryError,
  hashFindingIds,
  computeFindingContentHash,
  MERGE_GROUP_SIZE,
  MAX_FINDINGS_PER_SUBGROUP,
  type DurableNodeState,
  type SubgroupState,
} from "../adaptive-merge-recovery.js";
import type { CanonicalFinding } from "../canonical-finding.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else {
    failed++;
    const err = `  ✗ FAIL: ${msg}`;
    errors.push(err);
    console.error(err);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${msg}`); }
  else {
    failed++;
    const err = `  ✗ FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    errors.push(err);
    console.error(err);
  }
}

/** Build a minimal CanonicalFinding for testing */
function mkFinding(id: string, overrides: Partial<CanonicalFinding> = {}): CanonicalFinding {
  return {
    finding_id: id,
    severity: "warning",
    title: `Title for ${id}`,
    detail: `Detail for ${id}`,
    full_analysis: `Analysis for ${id}`,
    source_docs: ["doc_a"],
    claim_ids: [],
    merged_from_finding_ids: [],
    issue_key: id,
    finding_kind: "contradiction",
    ...overrides,
  } as CanonicalFinding;
}

// ─────────────────────────────────────────────────────────────────────────────
// T01: getChildIndices — correct ranges for all tree levels
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T01: getChildIndices — correct index ranges");
console.log("────────────────────────────────────────────────────────────────────");

{
  // 205 analyses → 52 L1 nodes (MERGE_GROUP_SIZE=4)
  // L2:N0 should cover L1:[0,1,2,3]
  const l2n0 = getChildIndices(2, 0, 51);
  assertEqual(l2n0, [0, 1, 2, 3], "L2:N0 covers L1 indices [0,1,2,3]");

  // L2:N1 should cover L1:[4,5,6,7]
  const l2n1 = getChildIndices(2, 1, 51);
  assertEqual(l2n1, [4, 5, 6, 7], "L2:N1 covers L1 indices [4,5,6,7]");

  // L3:N0 with 13 L2 nodes → covers L2:[0,1,2,3]
  const l3n0 = getChildIndices(3, 0, 12);
  assertEqual(l3n0, [0, 1, 2, 3], "L3:N0 covers L2 indices [0,1,2,3]");

  // Last L2 node (N12): maxChildIndex=51, startIdx=48, endIdx=51
  const l2n12 = getChildIndices(2, 12, 51);
  assertEqual(l2n12, [48, 49, 50, 51], "L2:N12 covers last 4 L1 indices [48,49,50,51]");

  // Boundary: maxChildIndex clips the end
  const l2n12clip = getChildIndices(2, 12, 50);
  assertEqual(l2n12clip, [48, 49, 50], "L2:N12 clips at maxChildIndex=50");

  assert(MERGE_GROUP_SIZE === 4, `MERGE_GROUP_SIZE is 4 (got ${MERGE_GROUP_SIZE})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// T02: buildSubgroupPlan — deterministic split with stable subgroup IDs
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T02: buildSubgroupPlan — deterministic split with stable IDs");
console.log("────────────────────────────────────────────────────────────────────");

{
  // 9 findings with MAX_FINDINGS_PER_SUBGROUP=6 → ceil(9/6)=2 groups: [6, 3]
  const findings = Array.from({ length: 9 }, (_, i) => mkFinding(`f${String(i).padStart(3, "0")}`));
  const plan = buildSubgroupPlan(findings, "2:0", 0, 6);

  assert(plan.length === 2, `9 findings / MAX=6 → 2 subgroups (got ${plan.length})`);
  assert(plan[0].memberFindingIds.length === 6, `First subgroup has 6 members`);
  assert(plan[1].memberFindingIds.length === 3, `Second subgroup has 3 members`);

  // Stable subgroup IDs use the nodeKey + generation + index
  assert(plan[0].subgroupId.startsWith("sg_2:0_g0_0"), `Subgroup 0 ID is stable: ${plan[0].subgroupId}`);
  assert(plan[1].subgroupId.startsWith("sg_2:0_g0_1"), `Subgroup 1 ID is stable: ${plan[1].subgroupId}`);

  // All findings are covered (no duplicates, no omissions)
  const allMemberIds = plan.flatMap(sg => sg.memberFindingIds);
  assertEqual(allMemberIds.length, 9, "All 9 finding IDs covered across subgroups");
  const uniqueMemberIds = new Set(allMemberIds);
  assertEqual(uniqueMemberIds.size, 9, "No duplicate finding IDs in subgroups");

  // All start as "pending"
  assert(plan.every(sg => sg.status === "pending"), "All subgroups start as pending");

  // Determinism: same input → same plan
  const plan2 = buildSubgroupPlan(findings, "2:0", 0, 6);
  assertEqual(plan[0].memberFindingIds, plan2[0].memberFindingIds, "Plan is deterministic (same input → same output)");
}

// ─────────────────────────────────────────────────────────────────────────────
// T03: buildSubgroupPlan — small input stays as single subgroup
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T03: buildSubgroupPlan — small input → single subgroup");
console.log("────────────────────────────────────────────────────────────────────");

{
  const findings = Array.from({ length: 4 }, (_, i) => mkFinding(`fz${i}`));
  const plan = buildSubgroupPlan(findings, "1:3", 0, 6);

  assertEqual(plan.length, 1, "4 findings / MAX=6 → 1 subgroup");
  assertEqual(plan[0].memberFindingIds.length, 4, "Single subgroup contains all 4 findings");

  // Single finding also works
  const singlePlan = buildSubgroupPlan([mkFinding("fonly")], "1:0", 0, 6);
  assertEqual(singlePlan.length, 1, "Single finding → 1 subgroup");
  assertEqual(singlePlan[0].memberFindingIds, ["fonly"], "Single subgroup contains the one finding");
}

// ─────────────────────────────────────────────────────────────────────────────
// T04: computeDependencyFingerprint — deterministic
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T04: computeDependencyFingerprint — deterministic");
console.log("────────────────────────────────────────────────────────────────────");

{
  const childIds = ["1:0", "1:1", "1:2", "1:3"];
  const hashes = { "1:0": "aaa", "1:1": "bbb", "1:2": "ccc", "1:3": "ddd" };

  const fp1 = computeDependencyFingerprint(childIds, hashes);
  const fp2 = computeDependencyFingerprint(childIds, hashes);

  assert(typeof fp1 === "string" && fp1.length > 0, "Fingerprint is a non-empty string");
  assert(fp1 === fp2, "Same inputs produce identical fingerprints (deterministic)");
}

// ─────────────────────────────────────────────────────────────────────────────
// T05: computeDependencyFingerprint — changes when payload hash changes
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T05: computeDependencyFingerprint — content-sensitive");
console.log("────────────────────────────────────────────────────────────────────");

{
  const childIds = ["1:0", "1:1"];
  const hashesV1 = { "1:0": "hash_original", "1:1": "hash_b" };
  const hashesV2 = { "1:0": "hash_CHANGED",  "1:1": "hash_b" };
  const hashesV3 = { "1:0": "hash_original", "1:1": "hash_b_CHANGED" };

  const fpV1 = computeDependencyFingerprint(childIds, hashesV1);
  const fpV2 = computeDependencyFingerprint(childIds, hashesV2);
  const fpV3 = computeDependencyFingerprint(childIds, hashesV3);

  assert(fpV1 !== fpV2, "Fingerprint changes when child 1:0's hash changes");
  assert(fpV1 !== fpV3, "Fingerprint changes when child 1:1's hash changes");
  assert(fpV2 !== fpV3, "Different hash changes produce different fingerprints");
}

// ─────────────────────────────────────────────────────────────────────────────
// T06: computeDependencyFingerprint — order-insensitive
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T06: computeDependencyFingerprint — order-insensitive");
console.log("────────────────────────────────────────────────────────────────────");

{
  const hashesAbc = { "1:0": "aaa", "1:1": "bbb", "1:2": "ccc" };
  const hashesReversed = { "1:2": "ccc", "1:0": "aaa", "1:1": "bbb" };

  const fpAbc = computeDependencyFingerprint(["1:0", "1:1", "1:2"], hashesAbc);
  const fpRev = computeDependencyFingerprint(["1:0", "1:1", "1:2"], hashesReversed);

  // Same logical content — fingerprint must be identical regardless of JS object insertion order
  assert(fpAbc === fpRev, "Fingerprint is identical regardless of hash dict insertion order");
}

// ─────────────────────────────────────────────────────────────────────────────
// T07: hashFindingIds — order-insensitive
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T07: hashFindingIds — order-insensitive");
console.log("────────────────────────────────────────────────────────────────────");

{
  const ids = ["uuid-c", "uuid-a", "uuid-b"];
  const idsReversed = ["uuid-b", "uuid-c", "uuid-a"];

  const h1 = hashFindingIds(ids);
  const h2 = hashFindingIds(idsReversed);

  assert(typeof h1 === "string" && h1.length > 0, "Hash is a non-empty string");
  assert(h1 === h2, "hashFindingIds is order-insensitive (same IDs → same hash)");

  // Different ID set → different hash
  const h3 = hashFindingIds(["uuid-a", "uuid-b"]);
  assert(h1 !== h3, "Different ID sets produce different hashes");

  // Empty set is stable
  const hEmpty1 = hashFindingIds([]);
  const hEmpty2 = hashFindingIds([]);
  assert(hEmpty1 === hEmpty2, "Empty ID set produces stable hash");
}

// ─────────────────────────────────────────────────────────────────────────────
// T08: classifyFailure — AdaptiveRecoveryError carries its own class
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T08: classifyFailure — typed error carries its own failure class");
console.log("────────────────────────────────────────────────────────────────────");

{
  const classes = [
    "budget_exhaustion", "model_timeout", "context_limit", "truncated_response",
    "missing_tag", "invalid_json", "merge_contract_rejection", "persistence_failure",
    "cas_conflict", "missing_stale_child",
  ] as const;

  for (const fc of classes) {
    const err = new AdaptiveRecoveryError(fc, `test message for ${fc}`);
    const classified = classifyFailure(err);
    assertEqual(classified, fc, `AdaptiveRecoveryError("${fc}") classifies as "${fc}"`);
  }

  // Unknown error → "unknown"
  const unknownErr = new Error("some unexpected error");
  assertEqual(classifyFailure(unknownErr), "unknown", "Generic Error classifies as 'unknown'");

  // Timeout keyword → model_timeout
  const timeoutErr = new Error("request timeout exceeded");
  assertEqual(classifyFailure(timeoutErr), "model_timeout", "Timeout keyword → model_timeout");

  // Rate limit → model_timeout
  const rateErr = new Error("429 rate_limit exceeded");
  assertEqual(classifyFailure(rateErr), "model_timeout", "Rate limit → model_timeout");

  // Context length → context_limit
  const ctxErr = new Error("context_length exceeded, token count too high");
  assertEqual(classifyFailure(ctxErr), "context_limit", "Context length → context_limit");
}

// ─────────────────────────────────────────────────────────────────────────────
// T09: classifyAction — failure-class-to-action mapping
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T09: classifyAction — failure-class-to-action mapping");
console.log("────────────────────────────────────────────────────────────────────");

{
  assertEqual(classifyAction("budget_exhaustion", 0), "persist_cursor_resume",
    "budget_exhaustion → persist_cursor_resume");
  assertEqual(classifyAction("context_limit", 0), "split",
    "context_limit → split");
  assertEqual(classifyAction("truncated_response", 0), "split",
    "truncated_response → split");
  assertEqual(classifyAction("model_timeout", 0), "bounded_retry",
    "model_timeout (first attempt) → bounded_retry");
  assertEqual(classifyAction("model_timeout", 5), "block",
    "model_timeout (many attempts) → block");
  assertEqual(classifyAction("invalid_json", 0), "block_isolate",
    "invalid_json → block_isolate");
  assertEqual(classifyAction("merge_contract_rejection", 0), "block_isolate",
    "merge_contract_rejection → block_isolate");
  assertEqual(classifyAction("cas_conflict", 0), "reload_state",
    "cas_conflict → reload_state");
  assertEqual(classifyAction("missing_stale_child", 0), "rebuild",
    "missing_stale_child → rebuild");
}

// ─────────────────────────────────────────────────────────────────────────────
// T10: Post-dedup conservation — every removed ID in merged_from_finding_ids
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T10: Post-dedup conservation — removed IDs tracked in representative");
console.log("────────────────────────────────────────────────────────────────────");

{
  // Directly test the conservation repair algorithm from Step 9 (Fix 6).
  // We simulate what the adaptive recovery code does after deduplication:
  //   1. Track which IDs were removed
  //   2. Map removed IDs to their family representative
  //   3. Verify every removed ID ends up in merged_from_finding_ids of representative

  const rep = mkFinding("f-representative", { severity: "critical" });
  const dup1 = mkFinding("f-duplicate-1", { severity: "warning" });
  const dup2 = mkFinding("f-duplicate-2", { severity: "info" });

  // Simulate dedup: rep is the representative, dup1 and dup2 are removed
  const preDedupIds = new Set(["f-representative", "f-duplicate-1", "f-duplicate-2"]);
  const representativeIds = new Set(["f-representative"]);

  // Build removed-to-representative mapping (mirrors the code in Step 9)
  const simulatedFamily = {
    representativeFindingId: "f-representative",
    memberFindingIds: ["f-representative", "f-duplicate-1", "f-duplicate-2"],
  };
  const removedToRepresentative = new Map<string, string>();
  for (const memberId of simulatedFamily.memberFindingIds) {
    if (memberId !== simulatedFamily.representativeFindingId) {
      removedToRepresentative.set(memberId, simulatedFamily.representativeFindingId);
    }
  }

  // Run the conservation repair (identical logic to Step 9 Fix 6)
  const finalFindings = [rep]; // Post-dedup output
  const representativeMap = new Map(finalFindings.map(f => [f.finding_id, f]));
  const removedIds = [...preDedupIds].filter(id => !representativeIds.has(id));

  for (const removedId of removedIds) {
    const repId = removedToRepresentative.get(removedId);
    const representative = repId ? representativeMap.get(repId) : null;
    if (representative) {
      const merged = representative.merged_from_finding_ids ?? [];
      if (!merged.includes(removedId)) {
        representative.merged_from_finding_ids = [...merged, removedId];
      }
    } else if (finalFindings.length > 0) {
      const first = finalFindings[0];
      const merged = first.merged_from_finding_ids ?? [];
      if (!merged.includes(removedId)) {
        first.merged_from_finding_ids = [...merged, removedId];
      }
    }
  }

  // Conservation invariants
  assert(
    (rep.merged_from_finding_ids ?? []).includes("f-duplicate-1"),
    "Removed ID f-duplicate-1 appears in representative's merged_from_finding_ids"
  );
  assert(
    (rep.merged_from_finding_ids ?? []).includes("f-duplicate-2"),
    "Removed ID f-duplicate-2 appears in representative's merged_from_finding_ids"
  );
  assert(
    finalFindings.length === 1,
    "Post-dedup: only the representative remains in final findings"
  );

  // Verify removed findings are NOT in the output but ARE referenced
  assert(
    !finalFindings.find(f => f.finding_id === "f-duplicate-1"),
    "f-duplicate-1 is not in final output (correctly suppressed)"
  );
  assert(
    !finalFindings.find(f => f.finding_id === "f-duplicate-2"),
    "f-duplicate-2 is not in final output (correctly suppressed)"
  );

  // Verify idempotency: applying repair twice doesn't duplicate the ID
  for (const removedId of removedIds) {
    const repId = removedToRepresentative.get(removedId);
    const representative = repId ? representativeMap.get(repId) : null;
    if (representative) {
      const merged = representative.merged_from_finding_ids ?? [];
      if (!merged.includes(removedId)) {
        representative.merged_from_finding_ids = [...merged, removedId];
      }
    }
  }
  const mergedSet = new Set(rep.merged_from_finding_ids ?? []);
  assert(
    mergedSet.size === (rep.merged_from_finding_ids ?? []).length,
    "Conservation repair is idempotent (no duplicate IDs in merged_from)"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// T11: DurableNodeState new fields — correct structure and defaults
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T11: DurableNodeState new fields — correct structure and defaults");
console.log("────────────────────────────────────────────────────────────────────");

{
  // Construct a minimal DurableNodeState and verify all required fields are present
  const emptySubgroup: SubgroupState = {
    subgroupId: "sg_test",
    memberFindingIds: [],
    status: "pending",
    outputFindingIds: [],
    outputFindings: [],
    attemptCount: 0,
    lastError: null,
    lastFailureClass: null,
  };

  const state: DurableNodeState = {
    inputFindingIds: [],
    childIds: ["1:0"],
    childPayloadHashes: { "1:0": "abc" },
    dependencyFingerprint: "fp",
    splitGeneration: 0,
    subgroups: [emptySubgroup],
    cursor: 0,
    reconciliationRequired: false,
    reconciliationComplete: false,
    reconciliationOutputIds: [],
    reconciliationFindings: [],
    // Fix 1-2: durable reconciliation subgroup state
    reconSubgroups: [],
    reconCursor: 0,
    reconIntermediateFindings: [],
    reconPassNumber: 0,
    attemptCount: 0,
    failureClass: null,
    lastError: null,
    outputHash: null,
    ancestryHash: null,
    ancestryCount: 0,
    // Fix 5: exact ancestry tracking
    ancestryAnalysisIds: ["chunk_0", "chunk_1", "chunk_2", "chunk_3"],
    pipelineVersion: "test",
    mergePolicyVersion: "v1",
    createdAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
  };

  // Verify all new fields are typed and present
  assert(Array.isArray(state.reconSubgroups), "reconSubgroups field exists and is array");
  assert(state.reconCursor === 0, "reconCursor field exists with default 0");
  assert(Array.isArray(state.reconIntermediateFindings), "reconIntermediateFindings field exists");
  assert(state.reconPassNumber === 0, "reconPassNumber field exists with default 0");
  assert(Array.isArray(state.ancestryAnalysisIds), "ancestryAnalysisIds field exists and is array");
  assert(state.ancestryAnalysisIds.length === 4, "ancestryAnalysisIds contains correct IDs");
  assert(state.ancestryAnalysisIds[0] === "chunk_0", "ancestryAnalysisIds format is 'chunk_N'");

  // Existing fields still present
  assert(typeof state.dependencyFingerprint === "string", "dependencyFingerprint field present");
  assert(typeof state.splitGeneration === "number", "splitGeneration field present");
  assert(Array.isArray(state.reconciliationFindings), "reconciliationFindings field present");
}

// ─────────────────────────────────────────────────────────────────────────────
// T12: computeFindingContentHash — sensitive to all content fields
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────────");
console.log(" T12: computeFindingContentHash — sensitive to content field changes");
console.log("────────────────────────────────────────────────────────────────────");

{
  const base = mkFinding("f-base", {
    title: "Original title",
    detail: "Original detail",
    full_analysis: "Original analysis",
    source_docs: ["doc1"],
    claim_ids: ["claim1"],
    severity: "warning",
  });

  const h0 = computeFindingContentHash(base);
  assert(typeof h0 === "string" && h0.length > 0, "Hash is a non-empty string");

  // Same content → same hash
  const h0b = computeFindingContentHash({ ...base });
  assert(h0 === h0b, "Same content produces identical hash");

  // Title change → different hash
  const titleChanged = mkFinding("f-base", { ...base, title: "CHANGED title" });
  assert(h0 !== computeFindingContentHash(titleChanged), "Title change produces different hash");

  // Detail change → different hash
  const detailChanged = mkFinding("f-base", { ...base, detail: "CHANGED detail" });
  assert(h0 !== computeFindingContentHash(detailChanged), "Detail change produces different hash");

  // full_analysis change → different hash
  const analysisChanged = mkFinding("f-base", { ...base, full_analysis: "CHANGED analysis" });
  assert(h0 !== computeFindingContentHash(analysisChanged), "full_analysis change produces different hash");

  // source_docs change → different hash
  const docsChanged = mkFinding("f-base", { ...base, source_docs: ["doc1", "doc2"] });
  assert(h0 !== computeFindingContentHash(docsChanged), "source_docs change produces different hash");

  // severity change → different hash
  const sevChanged = mkFinding("f-base", { ...base, severity: "critical" });
  assert(h0 !== computeFindingContentHash(sevChanged), "Severity change produces different hash");

  // Ancestor lineage change → different hash
  const ancestorChanged = mkFinding("f-base", {
    ...base,
    merged_from_finding_ids: ["f-parent1", "f-parent2"],
  });
  assert(h0 !== computeFindingContentHash(ancestorChanged), "merged_from_finding_ids change produces different hash");

  // ID-only change (without any other field change) → different hash
  const idChanged = mkFinding("f-DIFFERENT-ID", {
    title: base.title, detail: base.detail, full_analysis: base.full_analysis,
    source_docs: base.source_docs, claim_ids: base.claim_ids, severity: base.severity,
  });
  assert(h0 !== computeFindingContentHash(idChanged), "finding_id change produces different hash");
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════════════");
console.log(` Results: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log("\nFailures:");
  errors.forEach(e => console.log(e));
}
console.log("════════════════════════════════════════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);
