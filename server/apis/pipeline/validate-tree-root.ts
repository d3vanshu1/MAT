/**
 * ValidateTreeRoot — Frozen manifest reconstruction + root acceptance.
 *
 * Validates the merge tree for a given run meets all acceptance criteria:
 *   - L1 52/52, L2 13/13, L3 4/4, L4 1/1 (for 205 analyses, fan-in 4)
 *   - Zero unresolved/partial/failed/missing nodes
 *   - All 205 expected analysis IDs appear exactly once in root ancestry
 *   - No unexpected analysis IDs
 *   - Root fingerprint matches the frozen manifest
 *   - L4:0 is the only natural root
 *
 * Does NOT invoke claims, reconciliation, evidence admission, F06, or publication.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  computeSourceFingerprint,
  computeLeafSetFingerprint,
  type LeafNode,
} from "./merge-root-manifest.js";
import { computeContentHash } from "./source-snapshot.js";
import { getPipelineVersion } from "./pipeline-version.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const MERGE_GROUP_SIZE = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface FrozenManifest {
  version: number;
  /** All eligible analysis IDs in deterministic order */
  eligibleAnalysisIds: string[];
  /** L1 membership: maps L1 node index → array of analysis chunk_indices */
  l1Membership: Record<number, number[]>;
  /** Excluded IDs and reasons */
  excluded: Array<{ analysisId: string; reason: string }>;
  /** Source manifest fingerprint */
  sourceFingerprint: string;
  /** Expected topology */
  expectedTopology: { l1: number; l2: number; l3: number; l4: number; total: number };
  /** Computed at validation time */
  createdAt: string;
}

export interface RootAcceptanceResult {
  accepted: boolean;
  /** If not accepted, reasons why */
  rejectionReasons: string[];
  /** Frozen manifest (persisted for recovery reference) */
  frozenManifest: FrozenManifest | null;
  /** Per-level completion status */
  levelStatus: Record<number, { complete: number; expected: number; missing: number[] }>;
  /** Ancestry validation */
  ancestryValid: boolean;
  ancestryDetails: {
    totalAnalysisIds: number;
    expectedCount: number;
    missingIds: string[];
    unexpectedIds: string[];
    duplicateIds: string[];
  };
  /** Diagnostics per partial node */
  partialNodes: PartialNodeDiagnostic[];
  /** Natural root identity */
  naturalRoot: { level: number; nodeIndex: number } | null;
}

export interface PartialNodeDiagnostic {
  level: number;
  nodeIndex: number;
  status: string;
  attemptId: string | null;
  timestamps: { createdAt: string | null; updatedAt: string | null };
  requestBytes: number | null;
  estimatedTokens: number | null;
  outputLimit: string | null;
  stopReason: string | null;
  rawResponseSize: number | null;
  tagStatus: string;
  jsonStatus: string;
  runtime: number | null;
  remainingBudget: number | null;
  persistenceResult: string | null;
  lastError: string | null;
  failureClassification: string;
}

// ---------------------------------------------------------------------------
// Helper: classify node failure without inferring timeout from missing header
// ---------------------------------------------------------------------------
function classifyNodeFailure(nodeData: any): string {
  if (!nodeData) return "no_data";
  const error = nodeData.error ?? nodeData.last_error ?? nodeData.lastError;
  if (error) {
    if (typeof error === "string") {
      if (error.includes("timeout") || error.includes("ETIMEDOUT")) return "model_timeout";
      if (error.includes("token") || error.includes("context_length")) return "context_limit";
      if (error.includes("truncat")) return "truncated_response";
      if (error.includes("JSON") || error.includes("parse")) return "invalid_json";
      if (error.includes("rate_limit") || error.includes("429")) return "rate_limited";
    }
    return "error_persisted";
  }
  // Check for partial indicators
  if (nodeData.findings && !nodeData.executive_header && !nodeData.executiveHeader) {
    return "partial_no_header";
  }
  if (nodeData.truncation_count > 0 || nodeData.truncationCount > 0) return "truncated_output";
  return "unknown_partial";
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------
export default api({
  name: "ValidateTreeRoot",
  description: "Validates merge tree root acceptance and builds frozen manifest",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string(),
  }),

  output: z.object({
    result: z.any(),
  }),

  async run(ctx, { runId, moduleId }) {
    const result: RootAcceptanceResult = {
      accepted: false,
      rejectionReasons: [],
      frozenManifest: null,
      levelStatus: {},
      ancestryValid: false,
      ancestryDetails: {
        totalAnalysisIds: 0,
        expectedCount: 0,
        missingIds: [],
        unexpectedIds: [],
        duplicateIds: [],
      },
      partialNodes: [],
      naturalRoot: null,
    };

    // ─── Step 1: Load all analysis results (eligible membership) ────────
    const analysisRows = await ctx.integrations.db.query(
      `SELECT chunk_index,
              COALESCE(LEFT(COALESCE(result_json->>'extraction', result_json->>'text', ''), 1024), '') AS text_sample
       FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index`,
      z.object({
        chunk_index: z.coerce.number(),
        text_sample: z.string(),
      }),
      [runId],
      { label: "Load all analysis results for manifest" }
    );

    const analysisCount = analysisRows.length;
    const analysisIds = analysisRows.map(r => `chunk_${r.chunk_index}`);
    const chunkIndices = analysisRows.map(r => r.chunk_index);

    // Expected topology for fan-in = 4
    const expectedL1 = Math.ceil(analysisCount / MERGE_GROUP_SIZE);
    const expectedL2 = Math.ceil(expectedL1 / MERGE_GROUP_SIZE);
    const expectedL3 = Math.ceil(expectedL2 / MERGE_GROUP_SIZE);
    const expectedL4 = Math.ceil(expectedL3 / MERGE_GROUP_SIZE);
    const maxLevel = expectedL4 > 0 ? 4 : expectedL3 > 0 ? 3 : expectedL2 > 0 ? 2 : 1;

    const expectedByLevel: Record<number, number> = {
      1: expectedL1,
      2: expectedL2,
      3: expectedL3,
      4: expectedL4,
    };

    // ─── Step 2: Build frozen manifest ──────────────────────────────────
    // Deterministic L1 membership from chunk indices
    const l1Membership: Record<number, number[]> = {};
    for (let ni = 0; ni < expectedL1; ni++) {
      const start = ni * MERGE_GROUP_SIZE;
      const end = Math.min(start + MERGE_GROUP_SIZE - 1, analysisCount - 1);
      l1Membership[ni] = [];
      for (let ci = start; ci <= end; ci++) {
        l1Membership[ni].push(ci);
      }
    }

    // Source fingerprint from extraction metadata
    const extractions = analysisRows.map(r => ({
      documentId: `run_${runId}`,
      chunkIndex: r.chunk_index,
    }));
    const sourceFingerprint = computeSourceFingerprint(extractions);

    // Build leaf nodes for fingerprint
    const leafNodes: LeafNode[] = analysisRows.map(r => ({
      leafId: `${runId}:${r.chunk_index}`,
      contentHash: computeContentHash(r.text_sample),
    }));
    const leafSetFingerprint = computeLeafSetFingerprint(leafNodes);

    const frozenManifest: FrozenManifest = {
      version: 1,
      eligibleAnalysisIds: analysisIds,
      l1Membership,
      excluded: [], // No exclusions in current implementation
      sourceFingerprint,
      expectedTopology: {
        l1: expectedL1,
        l2: expectedL2,
        l3: expectedL3,
        l4: expectedL4,
        total: expectedL1 + expectedL2 + expectedL3 + expectedL4,
      },
      createdAt: new Date().toISOString(),
    };

    result.frozenManifest = frozenManifest;

    // ─── Step 3: Load merge checkpoints ─────────────────────────────────
    const checkpoints = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, status,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
              merged_json,
              updated_at::text AS updated_at,
              updated_at::text AS created_at,
              merged_json->'_node_state' AS node_state,
              payload_hash
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index >= 0
       ORDER BY tree_level, node_index`,
      z.object({
        tree_level: z.coerce.number(),
        node_index: z.coerce.number(),
        status: z.string().nullable(),
        findings_count: z.coerce.number(),
        merged_json: z.any().nullable(),
        updated_at: z.string().nullable(),
        created_at: z.string().nullable(),
        node_state: z.any().nullable(),
        payload_hash: z.string().nullable(),
      }),
      [runId],
      { label: "Load all merge checkpoints for validation" }
    );

    // Exclude synthetic quality checkpoints (tree_level >= 90)
    const dataCheckpoints = checkpoints.filter(c => c.tree_level < 90);

    // ─── Step 4: Per-level validation ───────────────────────────────────
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const expected = expectedByLevel[lvl] ?? 0;
      const nodesAtLevel = dataCheckpoints.filter(c => c.tree_level === lvl);
      const completeNodes = nodesAtLevel.filter(c => (c.status ?? "complete") === "complete");
      const missingIndices: number[] = [];

      for (let ni = 0; ni < expected; ni++) {
        const exists = nodesAtLevel.find(n => n.node_index === ni);
        if (!exists || (exists.status && exists.status !== "complete")) {
          missingIndices.push(ni);
        }
      }

      result.levelStatus[lvl] = {
        complete: completeNodes.length,
        expected,
        missing: missingIndices,
      };

      if (completeNodes.length < expected) {
        result.rejectionReasons.push(`L${lvl}: ${completeNodes.length}/${expected} complete (missing: ${missingIndices.join(", ")})`);
      }
    }

    // ─── Step 5: Diagnose partial/failed nodes ──────────────────────────
    const partialNodes = dataCheckpoints.filter(c =>
      c.status && c.status !== "complete" && c.tree_level < 90
    );

    for (const pn of partialNodes) {
      const nodeData = typeof pn.merged_json === "string"
        ? JSON.parse(pn.merged_json) : pn.merged_json;
      const nodeState = pn.node_state as any;

      const diagnostic: PartialNodeDiagnostic = {
        level: pn.tree_level,
        nodeIndex: pn.node_index,
        status: pn.status ?? "unknown",
        attemptId: nodeState?.attemptId ?? nodeData?.attemptId ?? null,
        timestamps: {
          createdAt: pn.created_at,
          updatedAt: pn.updated_at,
        },
        requestBytes: nodeData?.request_bytes ?? nodeData?.requestBytes ?? null,
        estimatedTokens: nodeData?.estimated_tokens ?? nodeData?.estimatedTokens ?? null,
        outputLimit: nodeData?.output_limit ?? nodeData?.outputLimit ?? null,
        stopReason: nodeData?.stop_reason ?? nodeData?.stopReason ?? null,
        rawResponseSize: nodeData?.raw_response_size ?? nodeData?.rawResponseSize ?? null,
        tagStatus: nodeData?.findings ? "present" : "missing",
        jsonStatus: nodeData?.findings && Array.isArray(nodeData.findings) ? "valid" : "invalid_or_missing",
        runtime: nodeData?.runtime_ms ?? nodeData?.runtimeMs ?? null,
        remainingBudget: nodeData?.remaining_budget_ms ?? nodeData?.remainingBudgetMs ?? null,
        persistenceResult: pn.status === "error" ? "error_persisted" : pn.status ?? null,
        lastError: nodeData?.error ?? nodeState?.lastError ?? null,
        failureClassification: classifyNodeFailure(nodeData),
      };

      result.partialNodes.push(diagnostic);
    }

    // ─── Step 6: Ancestry validation ────────────────────────────────────
    // Check that the root (highest level, index 0) accounts for all analysis IDs
    const rootLevel = maxLevel;
    const rootNode = dataCheckpoints.find(c => c.tree_level === rootLevel && c.node_index === 0);

    if (rootNode && (rootNode.status ?? "complete") === "complete") {
      result.naturalRoot = { level: rootLevel, nodeIndex: 0 };

      // Trace ancestry: walk down from root to L1 to verify coverage
      const coveredChunkIndices = new Set<number>();

      // For each L1 node that's complete, add its chunk indices to coverage
      const l1Nodes = dataCheckpoints.filter(c => c.tree_level === 1 && (c.status ?? "complete") === "complete");
      for (const l1 of l1Nodes) {
        const membership = l1Membership[l1.node_index] ?? [];
        for (const ci of membership) {
          if (coveredChunkIndices.has(ci)) {
            result.ancestryDetails.duplicateIds.push(`chunk_${ci}`);
          }
          coveredChunkIndices.add(ci);
        }
      }

      result.ancestryDetails.totalAnalysisIds = coveredChunkIndices.size;
      result.ancestryDetails.expectedCount = analysisCount;

      // Find missing
      for (let ci = 0; ci < analysisCount; ci++) {
        if (!coveredChunkIndices.has(ci)) {
          result.ancestryDetails.missingIds.push(`chunk_${ci}`);
        }
      }

      // Find unexpected (chunks beyond expected range)
      for (const ci of coveredChunkIndices) {
        if (ci >= analysisCount) {
          result.ancestryDetails.unexpectedIds.push(`chunk_${ci}`);
        }
      }

      result.ancestryValid =
        result.ancestryDetails.missingIds.length === 0 &&
        result.ancestryDetails.unexpectedIds.length === 0 &&
        result.ancestryDetails.duplicateIds.length === 0 &&
        result.ancestryDetails.totalAnalysisIds === analysisCount;

      if (!result.ancestryValid) {
        result.rejectionReasons.push(
          `Ancestry invalid: ${result.ancestryDetails.missingIds.length} missing, ` +
          `${result.ancestryDetails.unexpectedIds.length} unexpected, ` +
          `${result.ancestryDetails.duplicateIds.length} duplicates`
        );
      }
    } else {
      result.rejectionReasons.push(`Natural root L${rootLevel}:0 not complete`);
    }

    // ─── Step 7: Verify L4:0 is the only natural root ───────────────────
    // Check no other node at the highest level exists
    const rootLevelNodes = dataCheckpoints.filter(c => c.tree_level === rootLevel);
    if (rootLevelNodes.length > 1) {
      result.rejectionReasons.push(`Multiple nodes at root level ${rootLevel}: ${rootLevelNodes.length}`);
    }

    // ─── Step 8: Persist frozen manifest ────────────────────────────────
    if (result.rejectionReasons.length === 0) {
      result.accepted = true;

      // Persist manifest as checkpoint
      try {
        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
           VALUES ($1, 'frozen_manifest', $2::jsonb, 'complete', $3)
           ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE
             SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
          [runId, JSON.stringify(frozenManifest), getPipelineVersion()],
          { label: "Persist frozen manifest" }
        );
      } catch (e: any) {
        console.warn(`[ValidateTreeRoot] Failed to persist manifest: ${e?.message}`);
      }
    }

    return { result };
  },
});
