/**
 * Tree Completion Validator — Regression Tests
 *
 * Tests the fail-closed publication gate to ensure:
 * A) Incomplete trees are blocked (the defect that caused run 7bbeab48)
 * B) Complete trees are eligible
 * C) Missing routing diagnostics fail closed
 * D) Single-analysis trivial trees pass
 */

import { describe, it, expect } from "vitest";
import {
  validateTreeCompletion,
  computeExpectedTopology,
  computeExpectedRootLevel,
  type MergeNodeRecord,
} from "../tree-completion-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIds(count: number, prefix = "doc"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}:${i}`);
}

function makeCompleteNodes(leafCount: number): MergeNodeRecord[] {
  const topology = computeExpectedTopology(leafCount);
  const nodes: MergeNodeRecord[] = [];
  for (const level of topology) {
    for (let i = 0; i < level.expected_nodes; i++) {
      nodes.push({ tree_level: level.level, node_index: i, status: "complete" });
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Test A: Incomplete tree (reproduces the 7bbeab48 defect)
// ---------------------------------------------------------------------------

describe("Test A: Incomplete tree — 205/381 analyses, L3:0 proposed as final", () => {
  const expectedIds = makeIds(381);
  const completedIds = makeIds(205); // only first 205

  // Fan-in 2 → 381 analyses: L1..L9 = 191, 96, 48, 24, 12, 6, 3, 2, 1
  // Natural root = L9
  // Simulate a partially-built tree whose deepest complete node is L3:0.
  // The node counts below are deliberately arbitrary partial progress — the
  // point of Test A is that a node far below the natural root must never be
  // accepted as final, whatever the level populations look like.
  const mergeNodes: MergeNodeRecord[] = [];
  // L1: 53 complete nodes (from 205 analyses → ceil(205/4) = 52 groups; but some may be at higher indices)
  for (let i = 0; i < 52; i++) {
    mergeNodes.push({ tree_level: 1, node_index: i, status: "complete" });
  }
  // L2: 13 complete nodes
  for (let i = 0; i < 13; i++) {
    mergeNodes.push({ tree_level: 2, node_index: i, status: "complete" });
  }
  // L3: only node 0 complete
  mergeNodes.push({ tree_level: 3, node_index: 0, status: "complete" });

  const result = validateTreeCompletion({
    expectedAnalysisIds: expectedIds,
    completedAnalysisIds: completedIds,
    mergeNodes,
    actualFinalNodeLevel: 3,
    actualFinalNodeIndex: 0,
  });

  it("should NOT be publication eligible", () => {
    expect(result.publication_eligible).toBe(false);
  });

  it("should report analysis incomplete", () => {
    expect(result.analysis_status).toBe("analysis_incomplete");
    expect(result.missing_analysis_ids.length).toBe(176);
  });

  it("should report tree incomplete", () => {
    expect(result.tree_complete).toBe(false);
  });

  it("should report proposed node is not natural root", () => {
    expect(result.expected_root_level).toBe(5);
    expect(result.actual_final_node_level).toBe(3);
    expect(result.blocking_reasons.some(r => r.includes("sub-root") || r.includes("level 3"))).toBe(true);
  });

  it("should have meaningful blocking reasons", () => {
    expect(result.blocking_reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.blocking_reasons.some(r => r.includes("missing"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test B: Complete tree — 381/381 analyses, natural root reached
// ---------------------------------------------------------------------------

describe("Test B: Complete tree — all analyses done, tree fully reduced", () => {
  const expectedIds = makeIds(381);
  const completedIds = makeIds(381);

  // Build a fully complete tree for 381 analyses
  const mergeNodes = makeCompleteNodes(381);
  const rootLevel = computeExpectedRootLevel(381); // should be 5

  const result = validateTreeCompletion({
    expectedAnalysisIds: expectedIds,
    completedAnalysisIds: completedIds,
    mergeNodes,
    actualFinalNodeLevel: rootLevel,
    actualFinalNodeIndex: 0,
  });

  it("should be publication eligible", () => {
    expect(result.publication_eligible).toBe(true);
  });

  it("should have analysis complete", () => {
    expect(result.analysis_status).toBe("analysis_complete");
    expect(result.missing_analysis_ids.length).toBe(0);
  });

  it("should have tree complete", () => {
    expect(result.tree_complete).toBe(true);
  });

  it("should have source coverage complete", () => {
    expect(result.source_coverage_complete).toBe(true);
  });

  it("should have no blocking reasons", () => {
    expect(result.blocking_reasons).toEqual([]);
  });

  it("should report natural root at L5", () => {
    expect(result.expected_root_level).toBe(5);
    expect(result.actual_final_node_level).toBe(5);
    expect(result.expected_root_node_id).toBe("5:0");
  });
});

// ---------------------------------------------------------------------------
// Test C: Missing routing diagnostics — fail closed
// ---------------------------------------------------------------------------

describe("Test C: Fail closed when expected analysis population is empty", () => {
  const result = validateTreeCompletion({
    expectedAnalysisIds: [],
    completedAnalysisIds: makeIds(100),
    mergeNodes: makeCompleteNodes(100),
    actualFinalNodeLevel: computeExpectedRootLevel(100),
    actualFinalNodeIndex: 0,
  });

  it("should NOT be publication eligible", () => {
    expect(result.publication_eligible).toBe(false);
  });

  it("should report analysis_incomplete (empty expected set)", () => {
    expect(result.analysis_status).toBe("analysis_incomplete");
  });

  it("should have blocking reason about empty population", () => {
    expect(result.blocking_reasons.some(r =>
      r.includes("empty") || r.includes("not frozen") || r.includes("not computed")
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test D: Single analysis — trivial tree (no merge needed)
// ---------------------------------------------------------------------------

describe("Test D: Single analysis — trivial tree passes", () => {
  const expectedIds = ["doc:0"];
  const completedIds = ["doc:0"];

  // No merge nodes — single leaf IS the root
  const result = validateTreeCompletion({
    expectedAnalysisIds: expectedIds,
    completedAnalysisIds: completedIds,
    mergeNodes: [],
    actualFinalNodeLevel: 0,
    actualFinalNodeIndex: 0,
  });

  it("should be publication eligible", () => {
    expect(result.publication_eligible).toBe(true);
  });

  it("should have analysis complete", () => {
    expect(result.analysis_status).toBe("analysis_complete");
  });

  it("should have expected root level = 0 (trivial)", () => {
    expect(result.expected_root_level).toBe(0);
  });

  it("should have tree complete (vacuously)", () => {
    expect(result.tree_complete).toBe(true);
  });

  it("should have no blocking reasons", () => {
    expect(result.blocking_reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Topology unit tests
// ---------------------------------------------------------------------------

describe("computeExpectedTopology", () => {
  it("returns empty for 0 leaves", () => {
    expect(computeExpectedTopology(0)).toEqual([]);
  });

  it("returns empty for 1 leaf (trivial tree)", () => {
    expect(computeExpectedTopology(1)).toEqual([]);
  });

  it("returns correct topology for 4 leaves", () => {
    const topo = computeExpectedTopology(4);
    // Fan-in 2: L1: ceil(4/2) = 2, L2: ceil(2/2) = 1
    expect(topo.length).toBe(2);
    expect(topo[0]).toMatchObject({ level: 1, expected_nodes: 2 });
    expect(topo[1]).toMatchObject({ level: 2, expected_nodes: 1 });
  });

  it("returns correct topology for 2 leaves (single merge)", () => {
    const topo = computeExpectedTopology(2);
    expect(topo).toEqual([
      { level: 1, expected_nodes: 1, complete_nodes: 0, partial_nodes: 0, failed_nodes: 0, missing_nodes: 0 },
    ]);
  });

  it("returns correct topology for 5 leaves", () => {
    const topo = computeExpectedTopology(5);
    // L1: ceil(5/2) = 3, L2: ceil(3/2) = 2, L3: ceil(2/2) = 1
    expect(topo.length).toBe(3);
    expect(topo[0].expected_nodes).toBe(3);
    expect(topo[1].expected_nodes).toBe(2);
    expect(topo[2].expected_nodes).toBe(1);
  });

  it("returns correct topology for 205 leaves (SCG contradiction_check, run 13e9c0d6)", () => {
    const topo = computeExpectedTopology(205);
    // Fan-in 2: 205 → 103 → 52 → 26 → 13 → 7 → 4 → 2 → 1
    // This matches the eight round manifests the real run wrote, including
    // round 6's groupCount=4 with 1 singleton carry (L5 had 7 nodes: 3 pairs
    // + 1 carried singleton → L6 had exactly 4 nodes).
    expect(topo.map(l => l.expected_nodes)).toEqual([103, 52, 26, 13, 7, 4, 2, 1]);
    expect(topo.length).toBe(8);
  });

  it("returns correct topology for 381 leaves", () => {
    const topo = computeExpectedTopology(381);
    // Fan-in 2: 381 → 191 → 96 → 48 → 24 → 12 → 6 → 3 → 2 → 1
    expect(topo.map(l => l.expected_nodes)).toEqual([191, 96, 48, 24, 12, 6, 3, 2, 1]);
    expect(topo.length).toBe(9);
  });
});

describe("computeExpectedRootLevel", () => {
  it("returns 0 for 0 leaves", () => {
    expect(computeExpectedRootLevel(0)).toBe(0);
  });

  it("returns 0 for 1 leaf", () => {
    expect(computeExpectedRootLevel(1)).toBe(0);
  });

  it("returns 1 for 2 leaves", () => {
    expect(computeExpectedRootLevel(2)).toBe(1);
  });

  it("returns 2 for 3-4 leaves", () => {
    expect(computeExpectedRootLevel(3)).toBe(2);
    expect(computeExpectedRootLevel(4)).toBe(2);
  });

  it("returns 4 for 16 leaves", () => {
    expect(computeExpectedRootLevel(16)).toBe(4);
  });

  it("returns 8 for 205 leaves (SCG contradiction_check, run 13e9c0d6)", () => {
    expect(computeExpectedRootLevel(205)).toBe(8);
  });

  it("returns 9 for 381 leaves", () => {
    expect(computeExpectedRootLevel(381)).toBe(9);
  });
});
