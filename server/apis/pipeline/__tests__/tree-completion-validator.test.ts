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
  const MERGE_GROUP_SIZE = 4;

  // 381 analyses → L1: ceil(381/4)=96, L2: ceil(96/4)=24, L3: ceil(24/4)=6, L4: ceil(6/4)=2, L5: ceil(2/4)=1
  // Natural root = L5
  // Simulate: L1 has some complete, L2 has some, L3 has only node 0 complete
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

  it("returns correct topology for 4 leaves (MERGE_GROUP_SIZE)", () => {
    const topo = computeExpectedTopology(4);
    expect(topo).toEqual([
      { level: 1, expected_nodes: 1, complete_nodes: 0, partial_nodes: 0, failed_nodes: 0, missing_nodes: 0 },
    ]);
  });

  it("returns correct topology for 5 leaves", () => {
    const topo = computeExpectedTopology(5);
    // L1: ceil(5/4) = 2, L2: ceil(2/4) = 1
    expect(topo.length).toBe(2);
    expect(topo[0].expected_nodes).toBe(2);
    expect(topo[1].expected_nodes).toBe(1);
  });

  it("returns correct topology for 381 leaves (SCG case)", () => {
    const topo = computeExpectedTopology(381);
    // L1: ceil(381/4) = 96
    // L2: ceil(96/4) = 24
    // L3: ceil(24/4) = 6
    // L4: ceil(6/4) = 2
    // L5: ceil(2/4) = 1
    expect(topo.length).toBe(5);
    expect(topo[0]).toMatchObject({ level: 1, expected_nodes: 96 });
    expect(topo[1]).toMatchObject({ level: 2, expected_nodes: 24 });
    expect(topo[2]).toMatchObject({ level: 3, expected_nodes: 6 });
    expect(topo[3]).toMatchObject({ level: 4, expected_nodes: 2 });
    expect(topo[4]).toMatchObject({ level: 5, expected_nodes: 1 });
  });
});

describe("computeExpectedRootLevel", () => {
  it("returns 0 for 0 leaves", () => {
    expect(computeExpectedRootLevel(0)).toBe(0);
  });

  it("returns 0 for 1 leaf", () => {
    expect(computeExpectedRootLevel(1)).toBe(0);
  });

  it("returns 1 for 2-4 leaves", () => {
    expect(computeExpectedRootLevel(2)).toBe(1);
    expect(computeExpectedRootLevel(4)).toBe(1);
  });

  it("returns 2 for 5-16 leaves", () => {
    expect(computeExpectedRootLevel(5)).toBe(2);
    expect(computeExpectedRootLevel(16)).toBe(2);
  });

  it("returns 5 for 381 leaves (SCG case)", () => {
    expect(computeExpectedRootLevel(381)).toBe(5);
  });
});
