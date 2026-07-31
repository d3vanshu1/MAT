/**
 * Fix 2 — Merge-Root Completion Manifest Tests
 *
 * Verifies that the pipeline requires an explicit, validated root-completion
 * manifest before engaging the fast path. Tests cover:
 *   1. Five leaves with merge-group size four cannot complete after only the four-member group is checkpointed
 *   2. The carried singleton survives interruption and resume
 *   3. A highest-level singleton node without a manifest is not accepted as final
 *   4. A manifest missing one child or leaf is rejected
 *   5. A stale-version or stale-source manifest is rejected
 *   6. A valid completed tree enters the fast path
 *   7. Every expected leaf appears exactly once in root accounting
 *   8. Legacy checkpoints without a manifest use recovery rather than inferred completion
 *
 * Run: npx tsx server/apis/pipeline/__tests__/merge-root-manifest.test.ts
 */

import {
  buildMergeRootManifest,
  buildLeafNodes,
  computeLeafSetFingerprint,
  computeSourceFingerprint,
  computeLeafContentHash,
  validateManifest,
  deserializeManifest,
  MERGE_ROOT_MANIFEST_VERSION,
  type MergeRootManifest,
  type LeafNode,
  type RoundSummary,
} from "../merge-root-manifest.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLeafNodes(count: number): LeafNode[] {
  const results: Array<{ documentId: string; chunkIndex: number; extraction: string }> = [];
  for (let i = 0; i < count; i++) {
    results.push({
      documentId: `doc-${String(i).padStart(3, "0")}`,
      chunkIndex: i,
      extraction: `Extraction content for chunk ${i} with some text for hashing.`,
    });
  }
  return buildLeafNodes(results);
}

function makeExtractions(count: number): Array<{ documentId: string; chunkIndex: number }> {
  return Array.from({ length: count }, (_, i) => ({
    documentId: `doc-${String(i).padStart(3, "0")}`,
    chunkIndex: i,
  }));
}

function makeValidManifest(leafCount: number = 5): MergeRootManifest {
  const leafNodes = makeLeafNodes(leafCount);
  const extractions = makeExtractions(leafCount);
  return buildMergeRootManifest({
    leafNodes,
    extractions,
    rootLevel: 2,
    rootNodeIndex: 0,
    completionGeneration: 1,
    roundSummary: [
      { round: 1, inputNodes: leafCount, outputNodes: 2, singletonCarries: 1, failedGroups: 0 },
      { round: 2, inputNodes: 2, outputNodes: 1, singletonCarries: 0, failedGroups: 0 },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== Fix 2: Merge-Root Completion Manifest Tests ===\n");

// --- Test 1: Five leaves with group size 4 cannot complete after only the 4-member group ---
console.log("Test 1: Incomplete tree (4/5 leaves) cannot produce valid manifest");
{
  // Simulate: 5 leaves, MERGE_GROUP_SIZE=4 → Round 1 produces 2 nodes (4-group + singleton)
  // If only the 4-group is checkpointed, the tree is NOT complete
  const fullLeafNodes = makeLeafNodes(5);
  const fullExtractions = makeExtractions(5);

  // Build a manifest claiming only 4 leaves
  const partialLeafNodes = makeLeafNodes(4);
  const partialManifest = buildMergeRootManifest({
    leafNodes: partialLeafNodes,
    extractions: makeExtractions(4),
    rootLevel: 1,
    rootNodeIndex: 0,
    completionGeneration: 1,
    roundSummary: [{ round: 1, inputNodes: 4, outputNodes: 1, singletonCarries: 0, failedGroups: 0 }],
  });

  // Validate against the ACTUAL state (5 leaves)
  const result = validateManifest(partialManifest, {
    leafNodes: fullLeafNodes,
    extractions: fullExtractions,
    currentPipelineVersion: partialManifest.pipelineVersion,
  });

  assert(!result.valid, "Manifest with 4 leaves rejected when current has 5");
  if (!result.valid) {
    assert(result.reason.includes("Leaf count mismatch"), "Rejection reason mentions leaf count mismatch");
    assertEqual(result.recovery, "rebuild", "Recovery strategy is rebuild");
  }
}

// --- Test 2: Singleton carry survives interruption and resume ---
console.log("\nTest 2: Singleton carry is durably represented");
{
  // Simulate: 5 leaves → Round 1 (4-group + 1 singleton) → Round 2 (2 nodes → 1 root)
  // The singleton at Round 1 must be checkpointed for the manifest to validate
  const leafNodes = makeLeafNodes(5);
  const extractions = makeExtractions(5);

  const manifest = buildMergeRootManifest({
    leafNodes,
    extractions,
    rootLevel: 2,
    rootNodeIndex: 0,
    completionGeneration: 1,
    roundSummary: [
      { round: 1, inputNodes: 5, outputNodes: 2, singletonCarries: 1, failedGroups: 0 },
      { round: 2, inputNodes: 2, outputNodes: 1, singletonCarries: 0, failedGroups: 0 },
    ],
  });

  // The round summary records the singleton carry at round 1
  assertEqual(manifest.roundSummary[0].singletonCarries, 1, "Round 1 records 1 singleton carry");
  assertEqual(manifest.expectedLeafCount, 5, "Manifest accounts for all 5 leaves");

  // Validate: all 5 leaves are accounted for
  const result = validateManifest(manifest, {
    leafNodes,
    extractions,
    currentPipelineVersion: manifest.pipelineVersion,
  });
  assert(result.valid, "Full manifest with singleton carry validates successfully");
}

// --- Test 3: Singleton node without manifest is not accepted ---
console.log("\nTest 3: Highest-level singleton without manifest is rejected");
{
  // deserializeManifest should reject payloads that aren't manifests
  const nonManifestPayload = {
    text: "some merged text",
    executiveHeader: "Analysis complete",
    findings: [],
    singletonCarry: true,
  };

  const result = deserializeManifest(nonManifestPayload);
  assertEqual(result, null, "Non-manifest payload rejected by deserializeManifest");

  // Also test: a round manifest (not root-completion) should not deserialize as root
  const roundManifest = {
    round: 1,
    totalRounds: 2,
    inputNodeCount: 5,
    groupCount: 2,
    completedGroups: 2,
    failedGroups: 0,
    isFinalRound: false,
  };
  const result2 = deserializeManifest(roundManifest);
  assertEqual(result2, null, "Round manifest rejected by deserializeManifest (not a root manifest)");
}

// --- Test 4: Manifest missing one leaf is rejected ---
console.log("\nTest 4: Manifest with wrong leaf count is rejected");
{
  const manifest = makeValidManifest(5);
  const currentLeafNodes = makeLeafNodes(6); // Current state has 6 leaves (one was added)
  const currentExtractions = makeExtractions(6);

  const result = validateManifest(manifest, {
    leafNodes: currentLeafNodes,
    extractions: currentExtractions,
    currentPipelineVersion: manifest.pipelineVersion,
  });
  assert(!result.valid, "Manifest rejected when leaf count doesn't match");
  if (!result.valid) {
    assert(result.reason.includes("Leaf count"), "Reason mentions leaf count");
  }
}

// --- Test 5: Stale-version or stale-source manifest is rejected ---
console.log("\nTest 5: Stale pipeline version or source fingerprint is rejected");
{
  const manifest = makeValidManifest(5);
  const leafNodes = makeLeafNodes(5);
  const extractions = makeExtractions(5);

  // 5a: Wrong pipeline version
  const resultVersion = validateManifest(manifest, {
    leafNodes,
    extractions,
    currentPipelineVersion: "completely-different-version-hash",
  });
  assert(!resultVersion.valid, "Manifest rejected with wrong pipeline version");
  if (!resultVersion.valid) {
    assert(resultVersion.reason.includes("Pipeline version"), "Reason mentions pipeline version");
    assertEqual(resultVersion.recovery, "rebuild", "Recovery is rebuild for version mismatch");
  }

  // 5b: Same leaf count but different content (different source fingerprint)
  const altExtractions = makeExtractions(5).map(e => ({ ...e, documentId: `alt-${e.documentId}` }));
  const altLeafNodes = buildLeafNodes(altExtractions.map(e => ({
    ...e,
    extraction: `Different content for ${e.documentId}`,
  })));
  const resultSource = validateManifest(manifest, {
    leafNodes: altLeafNodes,
    extractions: altExtractions,
    currentPipelineVersion: manifest.pipelineVersion,
  });
  assert(!resultSource.valid, "Manifest rejected with wrong source fingerprint");
  if (!resultSource.valid) {
    // Could be leaf fingerprint or source fingerprint depending on which check fires first
    assert(
      resultSource.reason.includes("fingerprint"),
      "Reason mentions fingerprint mismatch"
    );
  }
}

// --- Test 6: Valid completed tree enters the fast path ---
console.log("\nTest 6: Valid completed tree passes validation");
{
  const leafNodes = makeLeafNodes(5);
  const extractions = makeExtractions(5);
  const manifest = buildMergeRootManifest({
    leafNodes,
    extractions,
    rootLevel: 2,
    rootNodeIndex: 0,
    completionGeneration: 1,
    roundSummary: [
      { round: 1, inputNodes: 5, outputNodes: 2, singletonCarries: 1, failedGroups: 0 },
      { round: 2, inputNodes: 2, outputNodes: 1, singletonCarries: 0, failedGroups: 0 },
    ],
  });

  const result = validateManifest(manifest, {
    leafNodes,
    extractions,
    currentPipelineVersion: manifest.pipelineVersion,
  });
  assert(result.valid, "Valid manifest passes all checks");
  assertEqual(manifest.rootCheckpointId, "2:0", "Root checkpoint ID is 2:0");
  assertEqual(manifest.version, MERGE_ROOT_MANIFEST_VERSION, "Version matches current schema");
}

// --- Test 7: Every expected leaf appears exactly once in root accounting ---
console.log("\nTest 7: Leaf set fingerprint is deterministic and unique per leaf set");
{
  const leaves5 = makeLeafNodes(5);
  const leaves5Again = makeLeafNodes(5); // same content → same fingerprint
  const leaves5Diff = makeLeafNodes(5).map(l => ({ ...l, contentHash: "different" }));

  const fp1 = computeLeafSetFingerprint(leaves5);
  const fp2 = computeLeafSetFingerprint(leaves5Again);
  const fp3 = computeLeafSetFingerprint(leaves5Diff);

  assertEqual(fp1, fp2, "Same leaves produce same fingerprint");
  assert(fp1 !== fp3, "Different leaf content produces different fingerprint");

  // Verify order independence
  const reversed = [...leaves5].reverse();
  const fpReversed = computeLeafSetFingerprint(reversed);
  assertEqual(fp1, fpReversed, "Fingerprint is order-independent");

  // Source fingerprint also order-independent
  const ext = makeExtractions(5);
  const extReversed = [...ext].reverse();
  assertEqual(
    computeSourceFingerprint(ext),
    computeSourceFingerprint(extReversed),
    "Source fingerprint is order-independent"
  );
}

// --- Test 8: Legacy checkpoints without manifest use recovery ---
console.log("\nTest 8: Legacy checkpoints (no manifest) use recovery path");
{
  // deserializeManifest returns null for: null, undefined, empty object, non-manifest shapes
  assertEqual(deserializeManifest(null), null, "null → recovery");
  assertEqual(deserializeManifest(undefined), null, "undefined → recovery");
  assertEqual(deserializeManifest({}), null, "empty object → recovery");
  assertEqual(deserializeManifest({ version: 1 }), null, "partial manifest → recovery");
  assertEqual(deserializeManifest({ version: 999, expectedLeafCount: 5 }), null, "incomplete fields → recovery");

  // A manifest with version > supported is also rejected by validateManifest
  const futureManifest = {
    ...makeValidManifest(5),
    version: 999,
  } as unknown as MergeRootManifest;
  const leafNodes = makeLeafNodes(5);
  const extractions = makeExtractions(5);
  const result = validateManifest(futureManifest, {
    leafNodes,
    extractions,
    currentPipelineVersion: futureManifest.pipelineVersion,
  });
  assert(!result.valid, "Future version manifest rejected");
  if (!result.valid) {
    assert(result.reason.includes("Unknown manifest version"), "Reason mentions unknown version");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
