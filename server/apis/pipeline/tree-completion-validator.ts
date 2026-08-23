/**
 * Tree Completion Validator — Fail-Closed Publication Gate
 *
 * Implements a deterministic completion check that MUST pass before any
 * finalization path can persist a module_output or mark a run completed.
 *
 * INVARIANT: A module run may be marked complete or published ONLY when:
 *   1. The expected analysis population is known and frozen
 *   2. Every expected analysis item is accounted for
 *   3. Every merge node required by the tree topology has completed
 *   4. The final node is the natural root of the complete tree
 *   5. No sibling, child or ancestor node remains partial/pending/failed/absent
 *   6. The root ancestry covers the complete expected source population
 *   7. Source-snapshot validation passes
 *   8. No node in the tree — least of all the root — was written from a
 *      TRUNCATED model response (Fix 25)
 *
 * A complete checkpoint below the natural root is RESUMABLE STATE ONLY.
 * It is NOT a final artifact.
 *
 * ── Fix 25: truncation blindspot ─────────────────────────────────────────────
 * `status` alone does not describe a node's fitness. A node whose merge response
 * hit `max_tokens` is retried; if it still truncates after MAX_PARTIAL_RETRIES it
 * is ACCEPTED and written with `status='complete'` plus `truncated: true` inside
 * `merged_json` (livelock prevention — the alternative is a tree that never
 * converges). The gate previously read only the `status` column, so such a node
 * counted as fully complete and the root's truncation was invisible: run
 * 13e9c0d6's L8:0 root was `status='complete', truncated=true,
 * truncation_count=1`, and the published artifact rested on it silently.
 *
 * The validator now reads `truncated` / `truncation_count` out of `merged_json`.
 * A truncated ROOT blocks publication outright — the final artifact must not be
 * built from a response the model was cut off mid-emission. Truncated
 * NON-root nodes are surfaced as a degraded-tree warning rather than a block,
 * because their content has already been folded into ancestors and re-merging
 * them means re-running the subtree.
 */

import { z } from "@superblocksteam/sdk-api";
import { MERGE_GROUP_SIZE } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Completion status levels — explicit semantics, not overloaded */
export type CheckpointStatus = "checkpoint_complete" | "tree_incomplete" | "failed" | "absent";
export type TreeStatus = "tree_complete" | "tree_incomplete" | "tree_degraded";
export type AnalysisStatus = "analysis_complete" | "analysis_incomplete" | "analysis_unknown";
export type PublicationEligibility = "publication_eligible" | "publication_blocked";

export interface CompletionDiagnostic {
  // Analysis population
  expected_analysis_count: number;
  completed_analysis_count: number;
  expected_analysis_ids: string[];
  accounted_analysis_ids: string[];
  missing_analysis_ids: string[];
  duplicate_analysis_ids: string[];
  analysis_status: AnalysisStatus;

  // Tree topology
  expected_root_level: number;
  expected_root_node_id: string; // "level:0"
  actual_final_node_id: string | null;
  actual_final_node_level: number | null;
  root_ancestry_count: number;

  // Node status
  unresolved_node_count: number;
  partial_node_count: number;
  failed_node_count: number;
  missing_node_count: number;
  total_expected_nodes: number;
  total_complete_nodes: number;

  // Fix 25: truncation visibility. A node counted in `total_complete_nodes` may
  // still appear here — 'complete' and 'truncated' are independent axes.
  truncated_node_count: number;
  truncated_node_ids: string[];
  /** True when the proposed final node itself was written from a truncated response. */
  root_truncated: boolean;
  root_truncation_count: number;

  // Verdicts
  tree_complete: boolean;
  source_coverage_complete: boolean;
  publication_eligible: boolean;
  /**
   * Fix 25: the tree converged and the root is clean, but at least one non-root
   * node was accepted truncated. Publication is permitted; fidelity is not
   * guaranteed for the subtree beneath those nodes.
   */
  tree_degraded: boolean;

  // Blocking reasons (empty = eligible)
  blocking_reasons: string[];

  // Metadata
  validated_at: string;
  validator_version: string;
}

export interface TreeLevelSummary {
  level: number;
  expected_nodes: number;
  complete_nodes: number;
  partial_nodes: number;
  failed_nodes: number;
  missing_nodes: number;
  /** Fix 25: nodes at this level that are complete-but-truncated. */
  truncated_nodes?: number;
}

export interface MergeNodeRecord {
  tree_level: number;
  node_index: number;
  status: string | null; // 'complete', 'partial', 'error', 'root_manifest', etc.
  /**
   * Fix 25: hoisted out of `merged_json`. True when the merge response for this
   * node hit `max_tokens`. A node can be BOTH `status='complete'` and
   * `truncated=true` — that is the accepted-after-MAX_PARTIAL_RETRIES state, and
   * it is exactly the case the gate used to miss.
   */
  truncated?: boolean | null;
  /** Fix 25: how many times this node truncated before being accepted. */
  truncation_count?: number | null;
}

export interface AnalysisRecord {
  chunk_index: number;
  document_id: string;
  content_identity: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALIDATOR_VERSION = "1.0.0-publication-gate";
// MERGE_GROUP_SIZE is imported from pipeline-config.ts (single source of truth).
// This gate must agree with the fan-in pipeline-core uses to build the tree;
// the shared constant preserves the value of 2 that has always been used here.

// ---------------------------------------------------------------------------
// Core Validation Logic
// ---------------------------------------------------------------------------

/**
 * Compute the expected number of nodes at each tree level for a quaternary tree.
 * Level 1 has ceil(leafCount / MERGE_GROUP_SIZE) nodes, etc.
 * Returns levels 1..N where level N has exactly 1 node (the root).
 */
export function computeExpectedTopology(leafCount: number): TreeLevelSummary[] {
  if (leafCount <= 0) return [];
  // Single leaf: trivial tree — the leaf IS the root, no merge nodes needed
  if (leafCount === 1) return [];

  const levels: TreeLevelSummary[] = [];
  let nodesAtLevel = Math.ceil(leafCount / MERGE_GROUP_SIZE);
  let level = 1;

  while (nodesAtLevel >= 1) {
    levels.push({
      level,
      expected_nodes: nodesAtLevel,
      complete_nodes: 0,
      partial_nodes: 0,
      failed_nodes: 0,
      missing_nodes: 0,
    });
    if (nodesAtLevel === 1) break;
    nodesAtLevel = Math.ceil(nodesAtLevel / MERGE_GROUP_SIZE);
    level++;
  }

  return levels;
}

/**
 * Determine the expected root level for a given leaf count.
 */
export function computeExpectedRootLevel(leafCount: number): number {
  // Single leaf: trivial tree — the leaf IS the root at level 0
  if (leafCount <= 1) return 0;
  const topology = computeExpectedTopology(leafCount);
  return topology.length > 0 ? topology[topology.length - 1].level : 0;
}

/**
 * Validate tree completion against expected topology.
 *
 * @param expectedAnalysisIds - The frozen set of chunk IDs that should be in the tree
 * @param completedAnalysisIds - The set of chunk IDs that have completed analysis
 * @param mergeNodes - All merge checkpoint records for this run
 * @param actualFinalNodeLevel - The tree_level of the node being proposed as final
 * @param actualFinalNodeIndex - The node_index of the node being proposed as final
 */
export function validateTreeCompletion(params: {
  expectedAnalysisIds: string[];
  completedAnalysisIds: string[];
  mergeNodes: MergeNodeRecord[];
  actualFinalNodeLevel: number | null;
  actualFinalNodeIndex: number | null;
}): CompletionDiagnostic {
  const {
    expectedAnalysisIds,
    completedAnalysisIds,
    mergeNodes,
    actualFinalNodeLevel,
    actualFinalNodeIndex,
  } = params;

  const blockingReasons: string[] = [];
  const now = new Date().toISOString();

  // --- Analysis Coverage ---
  const expectedSet = new Set(expectedAnalysisIds);
  const completedSet = new Set(completedAnalysisIds);
  const missingIds = expectedAnalysisIds.filter(id => !completedSet.has(id));
  const duplicateIds = completedAnalysisIds.filter((id, idx) =>
    completedAnalysisIds.indexOf(id) !== idx
  );

  // Extra analysis IDs not in the expected set
  const extraIds = completedAnalysisIds.filter(id => !expectedSet.has(id));

  const analysisComplete = missingIds.length === 0 && expectedAnalysisIds.length > 0;
  if (!analysisComplete) {
    if (expectedAnalysisIds.length === 0) {
      blockingReasons.push("Expected analysis population is empty (not frozen or not computed)");
    } else {
      blockingReasons.push(
        `Analysis incomplete: ${missingIds.length} of ${expectedAnalysisIds.length} expected analyses missing`
      );
    }
  }

  // --- Tree Topology ---
  const leafCount = expectedAnalysisIds.length;
  const expectedTopology = computeExpectedTopology(leafCount);
  const expectedRootLevel = computeExpectedRootLevel(leafCount);
  const expectedRootNodeId = `${expectedRootLevel}:0`;

  // Classify actual merge nodes by level (exclude manifests and recovery namespace L93+)
  const regularNodes = mergeNodes.filter(n =>
    n.node_index >= 0 && n.tree_level < 90
  );

  // Fill topology with actual counts
  for (const levelSummary of expectedTopology) {
    const nodesAtLevel = regularNodes.filter(n => n.tree_level === levelSummary.level);
    levelSummary.complete_nodes = nodesAtLevel.filter(n =>
      n.status === "complete" || n.status === null // legacy null = complete
    ).length;
    levelSummary.partial_nodes = nodesAtLevel.filter(n =>
      n.status === "partial"
    ).length;
    levelSummary.failed_nodes = nodesAtLevel.filter(n =>
      n.status === "error" || n.status === "failed"
    ).length;
    // Fix 25: complete-but-truncated. Counted separately because these nodes are
    // ALSO counted in complete_nodes — truncation is orthogonal to status.
    levelSummary.truncated_nodes = nodesAtLevel.filter(n =>
      n.truncated === true
    ).length;
    // Missing = expected but not present in DB
    const presentNodeIndices = new Set(nodesAtLevel.map(n => n.node_index));
    let missingCount = 0;
    for (let i = 0; i < levelSummary.expected_nodes; i++) {
      if (!presentNodeIndices.has(i)) missingCount++;
    }
    levelSummary.missing_nodes = missingCount;
  }

  // Aggregate node-level stats
  let unresolvedCount = 0;
  let partialCount = 0;
  let failedCount = 0;
  let missingNodeCount = 0;
  let totalExpectedNodes = 0;
  let totalCompleteNodes = 0;
  let truncatedNodeCount = 0;

  for (const level of expectedTopology) {
    totalExpectedNodes += level.expected_nodes;
    totalCompleteNodes += level.complete_nodes;
    partialCount += level.partial_nodes;
    failedCount += level.failed_nodes;
    missingNodeCount += level.missing_nodes;
    truncatedNodeCount += level.truncated_nodes ?? 0;
  }
  unresolvedCount = partialCount + failedCount + missingNodeCount;

  // Fix 25: enumerate truncated nodes so the caller can name them.
  const truncatedNodeIds = regularNodes
    .filter(n => n.truncated === true)
    .map(n => `${n.tree_level}:${n.node_index}`)
    .sort();

  // --- Root Validation ---
  const actualFinalNodeId = actualFinalNodeLevel != null
    ? `${actualFinalNodeLevel}:${actualFinalNodeIndex ?? 0}`
    : null;

  const isNaturalRoot =
    actualFinalNodeLevel === expectedRootLevel &&
    actualFinalNodeIndex === 0;

  if (!isNaturalRoot) {
    if (actualFinalNodeLevel == null) {
      blockingReasons.push("No final node proposed — tree has not produced any complete checkpoint");
    } else if (actualFinalNodeLevel < expectedRootLevel) {
      blockingReasons.push(
        `Proposed final node ${actualFinalNodeId} is at level ${actualFinalNodeLevel}, ` +
        `but natural root is expected at level ${expectedRootLevel}. ` +
        `A sub-root checkpoint is resumable state, not a final artifact.`
      );
    } else if (actualFinalNodeIndex !== 0) {
      blockingReasons.push(
        `Proposed final node ${actualFinalNodeId} has node_index=${actualFinalNodeIndex} (expected 0 for root)`
      );
    }
  }

  // Check that ALL tree levels have zero unresolved nodes
  const treeComplete = expectedTopology.every(
    level => level.complete_nodes === level.expected_nodes
  );

  if (!treeComplete) {
    const incompleteDetails = expectedTopology
      .filter(l => l.complete_nodes < l.expected_nodes)
      .map(l => `L${l.level}: ${l.complete_nodes}/${l.expected_nodes} complete` +
        (l.partial_nodes > 0 ? `, ${l.partial_nodes} partial` : "") +
        (l.failed_nodes > 0 ? `, ${l.failed_nodes} failed` : "") +
        (l.missing_nodes > 0 ? `, ${l.missing_nodes} missing` : "")
      );
    blockingReasons.push(
      `Tree incomplete — unresolved nodes at: ${incompleteDetails.join("; ")}`
    );
  }

  // Check source coverage
  const sourceCoverageComplete = analysisComplete && treeComplete && isNaturalRoot;

  // ── Fix 25: truncated-root gate ───────────────────────────────────────────
  // The proposed final node can be `status='complete'` and still have been
  // written from a response the model was cut off mid-emission. That node's
  // findings are, by definition, an unknown subset of what the merge was asked
  // to produce. An artifact built on it is not defensible, so this BLOCKS.
  const proposedRootRecord = actualFinalNodeLevel != null
    ? regularNodes.find(n =>
        n.tree_level === actualFinalNodeLevel &&
        n.node_index === (actualFinalNodeIndex ?? 0)
      )
    : undefined;
  const rootTruncated = proposedRootRecord?.truncated === true;
  const rootTruncationCount = proposedRootRecord?.truncation_count ?? 0;

  if (rootTruncated) {
    blockingReasons.push(
      `Proposed final node ${actualFinalNodeId} is status='${proposedRootRecord?.status ?? "complete"}' but ` +
      `truncated=true (truncation_count=${rootTruncationCount || 1}). The root merge response hit max_tokens, ` +
      `so its finding set is an unknown subset of the merge input. An artifact built on a truncated root is ` +
      `not defensible — re-merge the root before publishing.`
    );
  }

  // Truncated NON-root nodes do not block: their content is already folded into
  // ancestors, and re-merging them means re-running the subtree. They are
  // reported so the degradation is on the record rather than silent.
  const nonRootTruncatedIds = truncatedNodeIds.filter(id => id !== actualFinalNodeId);
  const treeDegraded = nonRootTruncatedIds.length > 0;

  // If there are siblings at the proposed final level that are not complete
  if (actualFinalNodeLevel != null && actualFinalNodeLevel <= expectedRootLevel) {
    const finalLevelSummary = expectedTopology.find(l => l.level === actualFinalNodeLevel);
    if (finalLevelSummary && finalLevelSummary.expected_nodes > 1) {
      const siblingsIncomplete = finalLevelSummary.expected_nodes - finalLevelSummary.complete_nodes;
      if (siblingsIncomplete > 0 && !blockingReasons.some(r => r.includes("Tree incomplete"))) {
        blockingReasons.push(
          `Proposed final level ${actualFinalNodeLevel} has ${siblingsIncomplete} incomplete sibling(s) — ` +
          `node 0 being complete does not prove tree convergence`
        );
      }
    }
  }

  // Publication eligibility = all checks pass.
  // NOTE (Fix 25): this MUST be the last computation in the function. It was
  // previously evaluated before the sibling-completeness check below it, which
  // meant a reason pushed by that check was reported in `blocking_reasons` but
  // did not actually flip `publication_eligible` to false — a blocking reason
  // that did not block. Do not move this above any blockingReasons.push().
  const publicationEligible = blockingReasons.length === 0;

  return {
    expected_analysis_count: expectedAnalysisIds.length,
    completed_analysis_count: completedAnalysisIds.length,
    expected_analysis_ids: expectedAnalysisIds,
    accounted_analysis_ids: completedAnalysisIds,
    missing_analysis_ids: missingIds,
    duplicate_analysis_ids: [...new Set(duplicateIds)],
    analysis_status: analysisComplete ? "analysis_complete" : "analysis_incomplete",

    expected_root_level: expectedRootLevel,
    expected_root_node_id: expectedRootNodeId,
    actual_final_node_id: actualFinalNodeId,
    actual_final_node_level: actualFinalNodeLevel,
    root_ancestry_count: totalCompleteNodes,

    unresolved_node_count: unresolvedCount,
    partial_node_count: partialCount,
    failed_node_count: failedCount,
    missing_node_count: missingNodeCount,
    total_expected_nodes: totalExpectedNodes,
    total_complete_nodes: totalCompleteNodes,

    truncated_node_count: truncatedNodeCount,
    truncated_node_ids: truncatedNodeIds,
    root_truncated: rootTruncated,
    root_truncation_count: rootTruncationCount,

    tree_complete: treeComplete,
    source_coverage_complete: sourceCoverageComplete,
    publication_eligible: publicationEligible,
    tree_degraded: treeDegraded,

    blocking_reasons: blockingReasons,

    validated_at: now,
    validator_version: VALIDATOR_VERSION,
  };
}

// ---------------------------------------------------------------------------
// DB Query Helpers — used by integration points
// ---------------------------------------------------------------------------

/**
 * Load the expected analysis population from the persisted routing diagnostic.
 * Returns the chunk IDs that were routed (eligible) for this run.
 */
export async function loadExpectedAnalysisPopulation(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<{ ids: string[]; found: boolean }> {
  // Load routing diagnostics (persisted by pipeline-core at routing time)
  const [routingCp] = await db.query(
    `SELECT payload FROM pipeline_checkpoints
     WHERE module_run_id = $1 AND checkpoint_key = 'routing_diagnostics' AND status = 'complete'
     LIMIT 1`,
    z.object({ payload: z.any() }),
    [runId],
    { label: "TreeValidator: load routing diagnostics" }
  );

  if (!routingCp?.payload) {
    return { ids: [], found: false };
  }

  const payload = typeof routingCp.payload === "string"
    ? JSON.parse(routingCp.payload)
    : routingCp.payload;

  // The routing diagnostic entries contain document_id + chunk_index for routed items.
  // Use the array position (global index) as the canonical ID, since pipeline_analysis
  // stores chunk_index as the global position in the routed array.
  if (payload.entries && Array.isArray(payload.entries)) {
    const routedEntries = payload.entries.filter((e: any) => e.allowed);
    const ids = routedEntries.map((_: any, idx: number) => String(idx));
    return { ids, found: true };
  }

  return { ids: [], found: false };
}

/**
 * Load completed analysis IDs from pipeline_analysis for this run.
 * Returns global chunk indices (matching the position-based IDs from loadExpectedAnalysisPopulation).
 */
export async function loadCompletedAnalysisIds(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<string[]> {

  const rows = await db.query(
    `SELECT chunk_index
     FROM pipeline_analysis
     WHERE run_id = $1
     ORDER BY chunk_index`,
    z.object({ chunk_index: z.coerce.number() }),
    [runId],
    { label: "TreeValidator: load completed analysis IDs" }
  );

  return rows.map(r => String(r.chunk_index));
}

/**
 * Load all merge checkpoint node records for this run.
 */
export async function loadMergeNodeRecords(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
): Promise<MergeNodeRecord[]> {

  const rows = await db.query(
    `SELECT tree_level, node_index, status,
            (merged_json->>'truncated')::boolean       AS truncated,
            (merged_json->>'truncation_count')::int    AS truncation_count
     FROM merge_checkpoints
     WHERE module_run_id = $1
     ORDER BY tree_level, node_index`,
    z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      status: z.string().nullable(),
      truncated: z.boolean().nullable(),
      truncation_count: z.coerce.number().nullable(),
    }),
    [runId],
    { label: "TreeValidator: load merge node records (with truncation flags)" }
  );

  return rows;
}

/**
 * Full validation entry point — loads all data and runs the validator.
 * Returns the diagnostic and a pass/fail verdict.
 *
 * @param proposedFinalLevel - The tree_level of the node being proposed as the
 *   final artifact source. If null, auto-detects from highest complete node.
 * @param proposedFinalIndex - The node_index (should be 0 for root). If null, defaults to 0.
 */
export async function runPublicationGate(
  db: { query: (...args: any[]) => Promise<any[]> },
  runId: string,
  proposedFinalLevel: number | null,
  proposedFinalIndex: number | null,
): Promise<{ eligible: boolean; diagnostic: CompletionDiagnostic }> {
  // 1. Load expected analysis population
  const expected = await loadExpectedAnalysisPopulation(db, runId);

  // 2. Load completed analysis IDs
  const completed = await loadCompletedAnalysisIds(db, runId);

  // 3. Load merge node records
  const mergeNodes = await loadMergeNodeRecords(db, runId);

  // If routing diagnostics not found, we cannot validate — fail closed
  if (!expected.found) {
    return {
      eligible: false,
      diagnostic: {
        expected_analysis_count: 0,
        completed_analysis_count: completed.length,
        expected_analysis_ids: [],
        accounted_analysis_ids: completed,
        missing_analysis_ids: [],
        duplicate_analysis_ids: [],
        analysis_status: "analysis_unknown",
        expected_root_level: 0,
        expected_root_node_id: "unknown",
        actual_final_node_id: proposedFinalLevel != null ? `${proposedFinalLevel}:${proposedFinalIndex ?? 0}` : null,
        actual_final_node_level: proposedFinalLevel,
        root_ancestry_count: 0,
        unresolved_node_count: 0,
        partial_node_count: 0,
        failed_node_count: 0,
        missing_node_count: 0,
        total_expected_nodes: 0,
        total_complete_nodes: 0,
        truncated_node_count: 0,
        truncated_node_ids: [],
        root_truncated: false,
        root_truncation_count: 0,
        tree_complete: false,
        source_coverage_complete: false,
        publication_eligible: false,
        tree_degraded: false,
        blocking_reasons: [
          "Routing diagnostics checkpoint not found — cannot determine expected analysis population. " +
          "Publication gate requires a frozen source manifest."
        ],
        validated_at: new Date().toISOString(),
        validator_version: VALIDATOR_VERSION,
      },
    };
  }

  // 4. Run validation
  const diagnostic = validateTreeCompletion({
    expectedAnalysisIds: expected.ids,
    completedAnalysisIds: completed,
    mergeNodes,
    actualFinalNodeLevel: proposedFinalLevel,
    actualFinalNodeIndex: proposedFinalIndex,
  });

  return {
    eligible: diagnostic.publication_eligible,
    diagnostic,
  };
}

// ---------------------------------------------------------------------------
// Compact diagnostic for persistence (omits full ID arrays for brevity)
// ---------------------------------------------------------------------------

export interface CompactCompletionDiagnostic {
  expected_analysis_count: number;
  completed_analysis_count: number;
  missing_analysis_count: number;
  duplicate_analysis_count: number;
  coverage_pct: number;
  expected_root_level: number;
  expected_root_node_id: string;
  actual_final_node_id: string | null;
  total_expected_nodes: number;
  total_complete_nodes: number;
  partial_node_count: number;
  failed_node_count: number;
  missing_node_count: number;
  truncated_node_count: number;
  truncated_node_ids: string[];
  root_truncated: boolean;
  root_truncation_count: number;
  tree_complete: boolean;
  source_coverage_complete: boolean;
  publication_eligible: boolean;
  tree_degraded: boolean;
  blocking_reasons: string[];
  validated_at: string;
  validator_version: string;
}

export function toCompactDiagnostic(d: CompletionDiagnostic): CompactCompletionDiagnostic {
  return {
    expected_analysis_count: d.expected_analysis_count,
    completed_analysis_count: d.completed_analysis_count,
    missing_analysis_count: d.missing_analysis_ids.length,
    duplicate_analysis_count: d.duplicate_analysis_ids.length,
    coverage_pct: d.expected_analysis_count > 0
      ? Math.round((d.completed_analysis_count / d.expected_analysis_count) * 10000) / 100
      : 0,
    expected_root_level: d.expected_root_level,
    expected_root_node_id: d.expected_root_node_id,
    actual_final_node_id: d.actual_final_node_id,
    total_expected_nodes: d.total_expected_nodes,
    total_complete_nodes: d.total_complete_nodes,
    partial_node_count: d.partial_node_count,
    failed_node_count: d.failed_node_count,
    missing_node_count: d.missing_node_count,
    truncated_node_count: d.truncated_node_count,
    truncated_node_ids: d.truncated_node_ids,
    root_truncated: d.root_truncated,
    root_truncation_count: d.root_truncation_count,
    tree_complete: d.tree_complete,
    source_coverage_complete: d.source_coverage_complete,
    publication_eligible: d.publication_eligible,
    tree_degraded: d.tree_degraded,
    blocking_reasons: d.blocking_reasons,
    validated_at: d.validated_at,
    validator_version: d.validator_version,
  };
}
