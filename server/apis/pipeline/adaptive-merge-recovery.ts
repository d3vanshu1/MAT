/**
 * Adaptive Merge Recovery — Durable logical-node state machine.
 *
 * Replaces the single-invocation model with a resumable subgroup-based approach:
 *
 *   logical node
 *   → classify failure / estimate size
 *   → deterministic split plan
 *   → process bounded subgroup
 *   → persist subgroup output + cursor
 *   → resume remaining subgroups
 *   → reconcile subgroup outputs
 *   → recursively split reconciliation if needed
 *   → validate ancestry
 *   → atomically complete logical node
 *
 * Key invariants:
 *   - Budget exhaustion NEVER creates degraded pass-through output
 *   - Pending subgroups prevent logical-node completion
 *   - Final cross-subgroup reconciliation is mandatory
 *   - Every input finding is retained or represented via merged_from_finding_ids
 *   - Valid zero findings require explicitly parsed empty array + valid lineage
 *   - Missing tags, malformed JSON, truncation cannot become zero-finding success
 *   - Parent reuse controlled by dependency fingerprints, not timestamps
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom, type LLMResponse } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { parseCanonicalFindings, type CanonicalFinding } from "./canonical-finding.js";
import { validateMergeContract } from "./merge-contract-validator.js";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import { computeContentHash } from "./source-snapshot.js";
import { EFFECTIVE_CAP_MS } from "./pipeline-config.js";
import {
  requireFrozenManifest,
  getValidMergeTreeLevels,
  type FrozenManifest,
  PipelinePrerequisiteError,
} from "./pipeline-prerequisites.js";

// ---------------------------------------------------------------------------
// Integration IDs
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MERGE_GROUP_SIZE = 4;
const MAX_FINDINGS_PER_SUBGROUP = 6;
const MAX_TOKENS_CONSOLIDATION = 4096;
const MAX_TOKENS_LEVEL1 = 8000;
const PERSISTENCE_RESERVE_MS = 25_000;
const MIN_WORK_BUDGET_MS = 45_000;
const PER_CALL_TIMEOUT_MS = 120_000;
const CLAIM_EXPIRY_MINUTES = 10;
const MAX_RETRIES_TRANSIENT = 3;
const MAX_UNKNOWN_FAILURES = 3;

// ---------------------------------------------------------------------------
// Failure Classification
// ---------------------------------------------------------------------------
export type FailureClass =
  | "budget_exhaustion"
  | "model_timeout"
  | "context_limit"
  | "truncated_response"
  | "missing_tag"
  | "invalid_json"
  | "merge_contract_rejection"
  | "persistence_failure"
  | "cas_conflict"
  | "missing_stale_child"
  | "unknown";

export type NodeAction =
  | "persist_cursor_resume"   // budget exhaustion
  | "split"                   // oversize/context limit
  | "bounded_retry"           // transient API/DB failure
  | "block_isolate"           // parser/schema failure
  | "rebuild"                 // stale dependency
  | "busy"                    // active claim
  | "reload_state"            // CAS conflict
  | "block"                   // repeated unknown failure
  | "complete";              // success

/** Maps failure class → recommended action */
export function classifyAction(failure: FailureClass, attemptCount: number): NodeAction {
  switch (failure) {
    case "budget_exhaustion": return "persist_cursor_resume";
    case "context_limit": return "split";
    case "model_timeout": return attemptCount < MAX_RETRIES_TRANSIENT ? "bounded_retry" : "block";
    case "truncated_response": return "split";
    case "missing_tag": return attemptCount < 2 ? "bounded_retry" : "block_isolate";
    case "invalid_json": return "block_isolate";
    case "merge_contract_rejection": return "block_isolate";
    case "persistence_failure": return attemptCount < MAX_RETRIES_TRANSIENT ? "bounded_retry" : "block";
    case "cas_conflict": return "reload_state";
    case "missing_stale_child": return "rebuild";
    case "unknown": return attemptCount >= MAX_UNKNOWN_FAILURES ? "block" : "bounded_retry";
  }
}

// ---------------------------------------------------------------------------
// Durable Node State (persisted as JSONB in merge_checkpoints.node_state)
// ---------------------------------------------------------------------------
export interface SubgroupState {
  subgroupId: string;           // Stable ID: `sg_${nodeKey}_${generation}_${index}`
  memberFindingIds: string[];   // Ordered finding IDs in this subgroup
  status: "pending" | "complete" | "failed";
  outputFindingIds: string[];   // Finding IDs produced by this subgroup
  outputFindings: CanonicalFinding[]; // Actual findings
  attemptCount: number;
  lastError: string | null;
  lastFailureClass: FailureClass | null;
}

export interface DurableNodeState {
  // --- Input membership ---
  inputFindingIds: string[];          // Exact ordered input finding IDs
  childIds: string[];                 // Child node keys ("level:index")
  childPayloadHashes: Record<string, string>; // childKey → hash of payload

  // --- Dependency fingerprint ---
  dependencyFingerprint: string;      // Hash of (childPayloadHashes + childIds + input ordering)

  // --- Split plan ---
  splitGeneration: number;            // How many times this node has been split
  subgroups: SubgroupState[];         // Stable subgroup plan
  cursor: number;                     // Index of next pending subgroup

  // --- Reconciliation (Fix 1-2: all recon state is durable, survives budget expiry) ---
  reconciliationRequired: boolean;    // True when >1 subgroup produced output
  reconciliationComplete: boolean;
  reconciliationOutputIds: string[];  // Final reconciled finding IDs
  reconciliationFindings: CanonicalFinding[];
  /** Durable subgroup plan for the current reconciliation pass */
  reconSubgroups: SubgroupState[];
  /** Next recon subgroup index to process */
  reconCursor: number;
  /** Findings accumulated from the previous reconciliation pass (for multi-pass narrowing) */
  reconIntermediateFindings: CanonicalFinding[];
  /** How many recursive reconciliation passes have run so far */
  reconPassNumber: number;

  // --- Status tracking ---
  attemptCount: number;
  failureClass: FailureClass | null;
  lastError: string | null;

  // --- Lineage ---
  outputHash: string | null;          // Hash of final output findings
  ancestryHash: string | null;        // Hash of all input analysis IDs reachable (legacy)
  ancestryCount: number;              // Count of unique analysis IDs in ancestry (legacy)
  /** Fix 5: exact set of leaf analysis IDs ('chunk_N') reachable from this node */
  ancestryAnalysisIds: string[];
  pipelineVersion: string;
  mergePolicyVersion: string;

  // --- Timestamps ---
  createdAt: string;
  lastProgressAt: string;
}

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------
export type RecoveryStatus = "progress" | "busy" | "retryable" | "blocked" | "complete" | "failed";

export interface RecoveryDiagnostics {
  selectedNode: string | null;
  action: string;
  failureClass: FailureClass | null;
  subgroupsComplete: number;
  subgroupsTotal: number;
  cursor: number;
  attemptCount: number;
  elapsedMs: number;
  resultFindingCount: number;
  progressAdvanced: boolean;
  nextUnresolved: string | null;
  completeByLevel: Record<number, number>;
  totalByLevel: Record<number, number>;
  invalidatedNodes: string[];
  reconciliationTriggered: boolean;
}

// ---------------------------------------------------------------------------
// Helper: compute dependency fingerprint from child payload hashes
// ---------------------------------------------------------------------------
function computeDependencyFingerprint(
  childIds: string[],
  childPayloadHashes: Record<string, string>,
): string {
  // Deterministic: sorted child IDs + their hashes
  const parts = [...childIds].sort().map(id => `${id}:${childPayloadHashes[id] ?? "missing"}`);
  return computeContentHash(parts.join("|"));
}

// ---------------------------------------------------------------------------
// Helper: compute finding set hash
// ---------------------------------------------------------------------------
function hashFindingIds(ids: string[]): string {
  return computeContentHash([...ids].sort().join("|"));
}

// ---------------------------------------------------------------------------
// Helper: compute full-content hash for a single finding (Fix 7)
// Hashes all content fields so any content change invalidates parents.
// ---------------------------------------------------------------------------
function computeFindingContentHash(f: CanonicalFinding): string {
  const parts = [
    f.finding_id ?? "",
    f.title ?? "",
    f.detail ?? "",
    f.full_analysis ?? "",
    (f.source_docs ?? []).join(","),
    (f.claim_ids ?? []).join(","),
    (f.merged_from_finding_ids ?? []).sort().join(","),
    f.severity ?? "",
    f.issue_key ?? "",
    f.finding_kind ?? "",
    // Capture any numeric / quantitative fields that may exist on extended types
    String((f as any).delta_abs ?? ""),
    String((f as any).delta_pct ?? ""),
    // Schema / version marker so any structural change also invalidates
    "v1",
  ];
  return computeContentHash(parts.join("|"));
}

// ---------------------------------------------------------------------------
// Helper: extract tag from LLM response
// ---------------------------------------------------------------------------
function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Helper: deterministic split into bounded subgroups
// ---------------------------------------------------------------------------
function buildSubgroupPlan(
  findings: CanonicalFinding[],
  nodeKey: string,
  generation: number,
  maxPerGroup: number,
): SubgroupState[] {
  // Sort by finding_id for determinism
  const sorted = [...findings].sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  const subgroups: SubgroupState[] = [];
  for (let i = 0; i < sorted.length; i += maxPerGroup) {
    const group = sorted.slice(i, i + maxPerGroup);
    subgroups.push({
      subgroupId: `sg_${nodeKey}_g${generation}_${subgroups.length}`,
      memberFindingIds: group.map(f => f.finding_id),
      status: "pending",
      outputFindingIds: [],
      outputFindings: [],
      attemptCount: 0,
      lastError: null,
      lastFailureClass: null,
    });
  }
  return subgroups;
}

// ---------------------------------------------------------------------------
// Helper: get child indices for a parent node
// ---------------------------------------------------------------------------
function getChildIndices(parentLevel: number, parentIndex: number, maxChildIndex: number): number[] {
  const start = parentIndex * MERGE_GROUP_SIZE;
  const end = Math.min(start + MERGE_GROUP_SIZE - 1, maxChildIndex);
  const indices: number[] = [];
  for (let i = start; i <= end; i++) indices.push(i);
  return indices;
}

// ---------------------------------------------------------------------------
// Consolidation prompt
// ---------------------------------------------------------------------------
const CONSOLIDATION_SYSTEM_PROMPT = `You are a diligence finding consolidation engine. Your ONLY job is to identify overlapping, duplicate, or closely related findings and merge them into a deduplicated set.

RULES:
- Input: A JSON array of findings (max 6)
- Output: A JSON array of consolidated findings wrapped in <findings_json>...</findings_json> tags
- If two findings describe the same underlying issue (same claim, same evidence gap, same contradiction), merge them into ONE finding
- Preserve the finding_id of the MOST specific or highest-severity instance when merging
- Record ALL merged source finding_ids in "merged_from_finding_ids"
- If findings are genuinely distinct, pass them through unchanged
- DO NOT invent new findings or add information not present in inputs
- DO NOT produce narrative text — ONLY the JSON array
- Singleton inputs (array of 1) should be returned unchanged
- Keep evidence fields bounded: max 3 source_docs, max 200 chars per detail/full_analysis

SEVERITY VALUES: "critical" | "warning" | "info"

REQUIRED FIELDS per finding:
- finding_id: UUID string
- severity: one of the values above
- title: concise title
- detail: short explanation (max 200 chars)
- full_analysis: analysis text (max 300 chars, combine if merging)
- source_docs: array of document references (max 3)

OPTIONAL FIELDS (preserve if present in input):
- claim_ids: array of claim IDs
- merged_from_finding_ids: array of absorbed finding UUIDs
- issue_key: semantic clustering key
- finding_kind: classification

OUTPUT FORMAT (exactly):
<findings_json>
[{"finding_id":"...","severity":"...","title":"...","detail":"...","full_analysis":"...","source_docs":[...],"claim_ids":[...],"merged_from_finding_ids":[...]}]
</findings_json>`;

const LEVEL1_MERGE_PROMPT = `You are a diligence analysis engine. Your task is to identify contradictions, inconsistencies, and data-divergences in the provided analysis chunks.

RULES:
- Identify distinct findings (contradictions, omissions, inconsistencies) from the input text
- Each finding must have: finding_id (UUID v4), severity (critical/warning/info), title, detail, full_analysis, source_docs
- Focus on substantive issues, not formatting
- Maximum 10 findings per merge group
- Return ONLY structured JSON

OUTPUT FORMAT (exactly):
<findings_json>
[{"finding_id":"<uuid>","severity":"...","title":"...","detail":"...","full_analysis":"...","source_docs":[],"claim_ids":[]}]
</findings_json>`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const MetadataRowSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  status: z.string().nullable(),
  findings_count: z.coerce.number(),
  payload_bytes: z.coerce.number(),
  updated_at: z.string().nullable(),
  checkpoint_version: z.coerce.number(),
  node_state: z.any().nullable(),
  payload_hash: z.string().nullable(),
});

const ChildPayloadSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
  payload_hash: z.string().nullable(),
});

const AnalysisResultSchema = z.object({
  chunk_index: z.coerce.number(),
  result_json: z.any(),
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------
interface NodeMeta {
  treeLevel: number;
  nodeIndex: number;
  status: string;
  findingsCount: number;
  payloadBytes: number;
  updatedAt: string;
  checkpointVersion: number;
  nodeState: DurableNodeState | null;
  payloadHash: string | null;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------
export default api({
  name: "AdaptiveMergeRecovery",
  description: "Durable resumable merge recovery with subgroup state machine",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string(),
    useOpus: z.boolean().nullable().optional(),
  }),

  output: z.object({
    status: z.enum(["progress", "busy", "retryable", "blocked", "complete", "failed"]),
    diagnostics: z.any(),
  }),

  async run(ctx, { runId, moduleId, useOpus }) {
    const startTime = Date.now();
    const currentVersion = getPipelineVersion();
    const model = getModuleModel(moduleId, useOpus);

    const diag: RecoveryDiagnostics = {
      selectedNode: null,
      action: "none",
      failureClass: null,
      subgroupsComplete: 0,
      subgroupsTotal: 0,
      cursor: 0,
      attemptCount: 0,
      elapsedMs: 0,
      resultFindingCount: 0,
      progressAdvanced: false,
      nextUnresolved: null,
      completeByLevel: {},
      totalByLevel: {},
      invalidatedNodes: [],
      reconciliationTriggered: false,
    };

    // ─── Step 0: Load frozen manifest (fail-closed if missing) ────────
    const frozenManifest = await requireFrozenManifest(ctx.integrations.db, runId);
    const validLevels = getValidMergeTreeLevels(frozenManifest);

    // ─── Step 1: Load lightweight metadata ──────────────────────────────
    const metadata = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(status, 'complete') AS status,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
              octet_length(merged_json::text) AS payload_bytes,
              updated_at::text AS updated_at,
              checkpoint_version,
              merged_json->'_node_state' AS node_state,
              payload_hash
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index >= 0 AND tree_level = ANY($2::int[])
       ORDER BY tree_level, node_index`,
      MetadataRowSchema,
      [runId, validLevels],
      { label: "Load merge checkpoint metadata (manifest-scoped levels)" }
    );

    const nodeMetas: NodeMeta[] = metadata.map(r => ({
      treeLevel: r.tree_level,
      nodeIndex: r.node_index,
      status: r.status ?? "complete",
      findingsCount: r.findings_count,
      payloadBytes: r.payload_bytes,
      updatedAt: r.updated_at ?? "",
      checkpointVersion: r.checkpoint_version,
      nodeState: r.node_state as DurableNodeState | null,
      payloadHash: r.payload_hash,
    }));

    const metaByKey = new Map<string, NodeMeta>();
    for (const m of nodeMetas) metaByKey.set(`${m.treeLevel}:${m.nodeIndex}`, m);

    // Compute level stats
    const levels = new Set(nodeMetas.map(m => m.treeLevel));
    const maxLevel = Math.max(...levels, 0);
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const atLevel = nodeMetas.filter(m => m.treeLevel === lvl);
      diag.completeByLevel[lvl] = atLevel.filter(m => m.status === "complete").length;
      diag.totalByLevel[lvl] = atLevel.length;
    }

    // Count analysis results (level 0)
    const analysisCountRows = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Count analysis results" }
    );
    const analysisCount = analysisCountRows[0]?.cnt ?? 0;

    // Max node_index per level
    const maxIndexByLevel = new Map<number, number>();
    for (const m of nodeMetas) {
      const curr = maxIndexByLevel.get(m.treeLevel) ?? -1;
      if (m.nodeIndex > curr) maxIndexByLevel.set(m.treeLevel, m.nodeIndex);
    }
    maxIndexByLevel.set(0, analysisCount - 1);

    // ─── Step 2: Invalidate stale parents by dependency fingerprint ─────
    for (let lvl = 2; lvl <= maxLevel; lvl++) {
      const nodesAtLevel = nodeMetas.filter(m => m.treeLevel === lvl && m.status !== "complete");
      for (const node of nodesAtLevel) {
        if (!node.nodeState) continue; // No state → will be rebuilt from scratch

        const childLevel = lvl - 1;
        const maxChildIdx = maxIndexByLevel.get(childLevel) ?? 0;
        const childIndices = getChildIndices(lvl, node.nodeIndex, maxChildIdx);

        // Compute current children's payload hashes
        const currentChildHashes: Record<string, string> = {};
        for (const ci of childIndices) {
          const childMeta = metaByKey.get(`${childLevel}:${ci}`);
          if (childMeta?.payloadHash) {
            currentChildHashes[`${childLevel}:${ci}`] = childMeta.payloadHash;
          }
        }

        // Compare with stored dependency fingerprint
        const currentFingerprint = computeDependencyFingerprint(
          childIndices.map(ci => `${childLevel}:${ci}`),
          currentChildHashes
        );

        if (node.nodeState.dependencyFingerprint !== currentFingerprint) {
          // Payload change → invalidate
          await ctx.integrations.db.execute(
            `DELETE FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
            [runId, lvl, node.nodeIndex],
            { label: `Invalidate stale node L${lvl}:N${node.nodeIndex} (fingerprint mismatch)` }
          );
          diag.invalidatedNodes.push(`${lvl}:${node.nodeIndex}`);
          metaByKey.delete(`${lvl}:${node.nodeIndex}`);
        }
      }
    }

    // ─── Step 3: Find next workable node ────────────────────────────────
    // Bottom-up: lowest level first, lowest index within level
    let targetKey: string | null = null;
    let targetLevel = 0;
    let targetIndex = 0;

    for (let lvl = 1; lvl <= maxLevel + 1 && !targetKey; lvl++) {
      const childLevelMaxIndex = maxIndexByLevel.get(lvl - 1) ?? 0;
      const expectedNodes = Math.ceil((childLevelMaxIndex + 1) / MERGE_GROUP_SIZE);

      for (let ni = 0; ni < expectedNodes && !targetKey; ni++) {
        const key = `${lvl}:${ni}`;
        const existing = metaByKey.get(key);

        if (existing?.status === "complete") continue;

        // Check children readiness
        const childLevel = lvl - 1;
        const maxChildIdx = maxIndexByLevel.get(childLevel) ?? 0;
        const childIndices = getChildIndices(lvl, ni, maxChildIdx);

        let childrenReady: boolean;
        if (childLevel === 0) {
          childrenReady = true; // Analysis results always ready
        } else {
          childrenReady = childIndices.every(ci => {
            const childMeta = metaByKey.get(`${childLevel}:${ci}`);
            return childMeta?.status === "complete";
          });
        }

        if (!childrenReady) continue;

        targetKey = key;
        targetLevel = lvl;
        targetIndex = ni;
      }
    }

    if (!targetKey) {
      // All nodes complete
      diag.elapsedMs = Date.now() - startTime;
      return { status: "complete" as const, diagnostics: diag };
    }

    diag.selectedNode = targetKey;

    // ─── Step 3.5: Atomic claim ─────────────────────────────────────────
    const existing = metaByKey.get(targetKey);
    const observedVersion = existing?.checkpointVersion ?? 0;
    const attemptId = `adaptive_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const claimResult = await ctx.integrations.db.query(
      `INSERT INTO merge_checkpoints
         (module_run_id, tree_level, node_index, merged_json, status, claimed_by, claimed_at, checkpoint_version)
       VALUES ($1, $2, $3, '{}'::jsonb, 'claimed', $4, now(), 1)
       ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE
         SET claimed_by = $4,
             claimed_at = now(),
             checkpoint_version = merge_checkpoints.checkpoint_version + 1
         WHERE merge_checkpoints.status <> 'complete'
           AND (
             merge_checkpoints.claimed_by IS NULL
             OR merge_checkpoints.claimed_at < now() - make_interval(mins => ${CLAIM_EXPIRY_MINUTES})
           )
           AND merge_checkpoints.checkpoint_version = $5
       RETURNING checkpoint_version, merged_json->'_node_state' AS node_state`,
      z.object({ checkpoint_version: z.coerce.number(), node_state: z.any().nullable() }),
      [runId, targetLevel, targetIndex, attemptId, observedVersion],
      { label: `Atomic claim L${targetLevel}:N${targetIndex}` }
    );

    if (claimResult.length === 0) {
      diag.elapsedMs = Date.now() - startTime;
      diag.action = "busy";
      return { status: "busy" as const, diagnostics: diag };
    }

    const claimedVersion = claimResult[0].checkpoint_version;
    let nodeState = claimResult[0].node_state as DurableNodeState | null;

    // ─── Step 4: Budget check ───────────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const remaining = EFFECTIVE_CAP_MS - elapsed;
    if (remaining < MIN_WORK_BUDGET_MS + PERSISTENCE_RESERVE_MS) {
      // Budget exhaustion — persist cursor, do NOT create degraded output
      diag.action = "persist_cursor_resume";
      diag.failureClass = "budget_exhaustion";
      diag.elapsedMs = Date.now() - startTime;
      // Release claim without completing
      await ctx.integrations.db.execute(
        `UPDATE merge_checkpoints
         SET claimed_by = NULL, claimed_at = NULL, status = 'partial'
         WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
           AND claimed_by = $4`,
        [runId, targetLevel, targetIndex, attemptId],
        { label: `Release claim (budget exhaustion) L${targetLevel}:N${targetIndex}` }
      );
      return { status: "retryable" as const, diagnostics: diag };
    }

    // ─── Step 5: Load/initialize durable node state ─────────────────────
    const childLevel = targetLevel - 1;
    const maxChildIdx = maxIndexByLevel.get(childLevel) ?? 0;
    const childIndices = getChildIndices(targetLevel, targetIndex, maxChildIdx);
    const childKeys = childIndices.map(ci => `${childLevel}:${ci}`);

    // Load child findings
    let inputFindings: CanonicalFinding[] = [];
    const childPayloadHashes: Record<string, string> = {};

    if (childLevel === 0) {
      // Level 1: load from pipeline_analysis using frozen manifest membership (Fix 3)
      // The manifest is immutable and REQUIRED — no fallback to computed range.
      const membership = frozenManifest.l1Membership?.[targetIndex];
      if (!membership || membership.length === 0) {
        throw new PipelinePrerequisiteError(
          "MANIFEST_MEMBERSHIP_MISSING",
          `Frozen manifest has no L1 membership for node index ${targetIndex}. ` +
          `Cannot proceed without exact membership — range fallback is prohibited.`
        );
      }
      const chunkIndices = membership;

      const analysisRows = await ctx.integrations.db.query(
        `SELECT chunk_index, result_json
         FROM pipeline_analysis
         WHERE run_id = $1 AND chunk_index = ANY($2::int[])
         ORDER BY chunk_index`,
        AnalysisResultSchema,
        [runId, chunkIndices],
        { label: `Load analysis chunks [${chunkIndices.join(",")}] for L1:N${targetIndex}` }
      );

      // Fix 8: Verify requested vs returned membership — block on mismatch
      const returnedIndices = new Set(analysisRows.map((r: any) => r.chunk_index as number));
      const missingIndices = chunkIndices.filter(ci => !returnedIndices.has(ci));
      const unexpectedIndices = [...returnedIndices].filter(ci => !chunkIndices.includes(ci));

      if (missingIndices.length > 0) {
        throw new PipelinePrerequisiteError(
          "L1_MEMBERSHIP_MISMATCH",
          `L1:N${targetIndex} requested ${chunkIndices.length} analyses but ` +
          `${missingIndices.length} are missing from pipeline_analysis: [${missingIndices.join(",")}]. ` +
          `Recovery blocked — cannot proceed with incomplete membership.`
        );
      }
      if (unexpectedIndices.length > 0) {
        throw new PipelinePrerequisiteError(
          "L1_MEMBERSHIP_UNEXPECTED",
          `L1:N${targetIndex} received ${unexpectedIndices.length} unexpected analyses: [${unexpectedIndices.join(",")}]. ` +
          `Recovery blocked — membership integrity violated.`
        );
      }

      // Fix 4: hash full text content (not truncated) for dependency fingerprinting
      for (const row of analysisRows) {
        const data = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
        const text = String(data.extraction ?? data.text ?? "");
        childPayloadHashes[`0:${row.chunk_index}`] = computeContentHash(text);
      }

      // Store exact chunk indices for ancestry tracking
      ;(childPayloadHashes as any).__l1ChunkIndices__ = chunkIndices;
    } else {
      // Level 2+: load from merge_checkpoints
      for (const ci of childIndices) {
        const rows = await ctx.integrations.db.query(
          `SELECT tree_level, node_index, merged_json, payload_hash
           FROM merge_checkpoints
           WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3 AND status = 'complete'
           LIMIT 1`,
          ChildPayloadSchema,
          [runId, childLevel, ci],
          { label: `Load child L${childLevel}:N${ci}` }
        );
        if (rows.length > 0) {
          const data = typeof rows[0].merged_json === "string"
            ? JSON.parse(rows[0].merged_json) : rows[0].merged_json;
          const findings = (data.findings ?? []) as CanonicalFinding[];
          inputFindings.push(...findings);
          // Fix 7: use full content hash for each finding (not just ID + first 1024 chars)
          const findingContentHash = findings.map(f => computeFindingContentHash(f)).join("|");
          childPayloadHashes[`${childLevel}:${ci}`] = rows[0].payload_hash ?? computeContentHash(findingContentHash);
        }
      }
    }

    // Compute dependency fingerprint
    // (strip temp sentinel before hashing — it's not a real child key)
    const l1ChunkIndices: number[] = (childPayloadHashes as any).__l1ChunkIndices__ ?? [];
    delete (childPayloadHashes as any).__l1ChunkIndices__;
    const depFingerprint = computeDependencyFingerprint(childKeys, childPayloadHashes);

    // Fix 5: compute exact ancestry ID set before node state init
    // For L1: chunk indices loaded from manifest or computed range
    // For L2+: accumulate from completed children's ancestry sets
    const freshAncestryAnalysisIds: string[] = childLevel === 0
      ? l1ChunkIndices.map(ci => `chunk_${ci}`)
      : childIndices.flatMap(ci => {
          const childMeta = metaByKey.get(`${childLevel}:${ci}`);
          const childNodeState = childMeta?.nodeState as DurableNodeState | null;
          return childNodeState?.ancestryAnalysisIds ?? [];
        });

    // Initialize or resume node state
    if (!nodeState || nodeState.dependencyFingerprint !== depFingerprint) {
      // Fresh state or stale state — reinitialize
      const inputIds = inputFindings.map(f => f.finding_id);
      nodeState = {
        inputFindingIds: inputIds,
        childIds: childKeys,
        childPayloadHashes,
        dependencyFingerprint: depFingerprint,
        splitGeneration: 0,
        subgroups: [],
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
        // Fix 5: exact ancestry ID set
        ancestryAnalysisIds: freshAncestryAnalysisIds,
        pipelineVersion: currentVersion,
        mergePolicyVersion: "v1",
        createdAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
      };

      // Build subgroup plan
      if (childLevel === 0) {
        // L1: single "subgroup" representing the full merge-from-text
        nodeState.subgroups = [{
          subgroupId: `sg_${targetKey}_g0_0`,
          memberFindingIds: [], // L1 has no input findings — raw text
          status: "pending",
          outputFindingIds: [],
          outputFindings: [],
          attemptCount: 0,
          lastError: null,
          lastFailureClass: null,
        }];
      } else if (inputFindings.length <= MAX_FINDINGS_PER_SUBGROUP) {
        // Small enough for single subgroup
        nodeState.subgroups = [{
          subgroupId: `sg_${targetKey}_g0_0`,
          memberFindingIds: inputFindings.map(f => f.finding_id),
          status: "pending",
          outputFindingIds: [],
          outputFindings: [],
          attemptCount: 0,
          lastError: null,
          lastFailureClass: null,
        }];
      } else {
        // Split into bounded subgroups
        nodeState.subgroups = buildSubgroupPlan(inputFindings, targetKey, 0, MAX_FINDINGS_PER_SUBGROUP);
        nodeState.reconciliationRequired = nodeState.subgroups.length > 1;
      }
    } else {
      // Resuming — ensure new fields have defaults if state was persisted before this patch
      if (!nodeState.reconSubgroups) nodeState.reconSubgroups = [];
      if (nodeState.reconCursor === undefined) nodeState.reconCursor = 0;
      if (!nodeState.reconIntermediateFindings) nodeState.reconIntermediateFindings = [];
      if (nodeState.reconPassNumber === undefined) nodeState.reconPassNumber = 0;
      if (!nodeState.ancestryAnalysisIds) nodeState.ancestryAnalysisIds = freshAncestryAnalysisIds;
    }

    diag.attemptCount = nodeState.attemptCount + 1;
    nodeState.attemptCount++;

    // ─── Step 6: Process next pending subgroup ──────────────────────────
    const pendingIdx = nodeState.subgroups.findIndex((sg, i) => i >= nodeState!.cursor && sg.status === "pending");

    if (pendingIdx >= 0) {
      const subgroup = nodeState.subgroups[pendingIdx];
      diag.cursor = pendingIdx;

      try {
        let subgroupOutput: CanonicalFinding[];

        if (childLevel === 0) {
          // L1 merge from raw text — pass manifest membership
          const l1Membership = frozenManifest.l1Membership?.[targetIndex] ?? [];
          subgroupOutput = await processLevel1Subgroup(
            ctx, runId, targetIndex, model, currentVersion, startTime, l1Membership
          );
        } else if (subgroup.memberFindingIds.length <= 1) {
          // Pass-through single finding
          subgroupOutput = inputFindings.filter(f => subgroup.memberFindingIds.includes(f.finding_id));
        } else {
          // Bounded consolidation
          const subgroupFindings = inputFindings.filter(f => subgroup.memberFindingIds.includes(f.finding_id));
          subgroupOutput = await processSubgroup(ctx, subgroupFindings, model, targetKey, startTime);
        }

        // Validate output: missing tags / truncation cannot become zero-finding success
        // (The process functions handle this internally, but belt-and-suspenders)
        subgroup.outputFindings = subgroupOutput;
        subgroup.outputFindingIds = subgroupOutput.map(f => f.finding_id);
        subgroup.status = "complete";
        nodeState.cursor = pendingIdx + 1;
        nodeState.lastProgressAt = new Date().toISOString();
        diag.progressAdvanced = true;

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failureClass = classifyFailure(err);
        subgroup.attemptCount++;
        subgroup.lastError = errMsg.slice(0, 500);
        subgroup.lastFailureClass = failureClass;
        nodeState.failureClass = failureClass;
        nodeState.lastError = errMsg.slice(0, 500);

        const action = classifyAction(failureClass, subgroup.attemptCount);
        diag.action = action;
        diag.failureClass = failureClass;

        if (action === "block_isolate" || action === "block") {
          subgroup.status = "failed";
          // Persist state and return blocked
          await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
          diag.elapsedMs = Date.now() - startTime;
          return { status: "blocked" as const, diagnostics: diag };
        }

        if (action === "split") {
          // Re-split this subgroup into smaller pieces
          const subgroupFindings = inputFindings.filter(f => subgroup.memberFindingIds.includes(f.finding_id));
          nodeState.splitGeneration++;
          const newSubgroups = buildSubgroupPlan(
            subgroupFindings, targetKey, nodeState.splitGeneration,
            Math.max(2, Math.ceil(MAX_FINDINGS_PER_SUBGROUP / 2))
          );
          // Replace this subgroup with the new split
          nodeState.subgroups.splice(pendingIdx, 1, ...newSubgroups);
          nodeState.reconciliationRequired = true;
        }

        // Persist progress and return retryable
        await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
        diag.elapsedMs = Date.now() - startTime;
        return { status: "retryable" as const, diagnostics: diag };
      }
    }

    // ─── Step 7: Check if all subgroups complete ────────────────────────
    const allComplete = nodeState.subgroups.every(sg => sg.status === "complete");
    const anyFailed = nodeState.subgroups.some(sg => sg.status === "failed");
    const anyPending = nodeState.subgroups.some(sg => sg.status === "pending");

    diag.subgroupsComplete = nodeState.subgroups.filter(sg => sg.status === "complete").length;
    diag.subgroupsTotal = nodeState.subgroups.length;

    if (anyFailed) {
      await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
      diag.elapsedMs = Date.now() - startTime;
      return { status: "failed" as const, diagnostics: diag };
    }

    if (anyPending) {
      // INVARIANT: Pending subgroups prevent logical-node completion
      // Persist cursor and return progress
      await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
      diag.elapsedMs = Date.now() - startTime;
      diag.action = "persist_cursor_resume";
      return { status: "progress" as const, diagnostics: diag };
    }

    // ─── Step 8: Cross-subgroup reconciliation (Fixes 1-2: fully durable + recursive) ──
    // INVARIANT: All per-subgroup outputs must be reconciled into a single result.
    // The reconciliation subgroup plan and cursor are persisted in node state so budget
    // expiry during reconciliation does not lose progress.  Multiple passes are executed
    // until the result fits in MAX_FINDINGS_PER_SUBGROUP, guaranteeing a single final merge.
    if (allComplete && nodeState.reconciliationRequired && !nodeState.reconciliationComplete) {
      diag.reconciliationTriggered = true;

      // ── Recon pass loop: repeat until result is small enough for a final single merge ──
      let reconPassDone = false;
      while (!reconPassDone) {
        // Determine the input pool for the current pass
        const passInput: CanonicalFinding[] = nodeState.reconIntermediateFindings.length > 0
          ? nodeState.reconIntermediateFindings
          : nodeState.subgroups.flatMap(sg => sg.outputFindings);

        if (passInput.length <= MAX_FINDINGS_PER_SUBGROUP) {
          // Small enough — single final merge
          const budgetCheck = EFFECTIVE_CAP_MS - (Date.now() - startTime);
          if (budgetCheck < MIN_WORK_BUDGET_MS + PERSISTENCE_RESERVE_MS) {
            await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
            diag.elapsedMs = Date.now() - startTime; diag.action = "persist_cursor_resume";
            return { status: "progress" as const, diagnostics: diag };
          }
          const finalResult = passInput.length <= 1
            ? passInput
            : await processSubgroup(ctx, passInput, model, `${targetKey}_recon_final_p${nodeState.reconPassNumber}`, startTime);
          nodeState.reconciliationFindings = finalResult;
          nodeState.reconciliationOutputIds = finalResult.map(f => f.finding_id);
          nodeState.reconciliationComplete = true;
          // Clear intermediate state
          nodeState.reconSubgroups = [];
          nodeState.reconCursor = 0;
          nodeState.reconIntermediateFindings = [];
          reconPassDone = true;
        } else {
          // Need a reduction pass: build/resume durable reconSubgroups
          if (nodeState.reconSubgroups.length === 0) {
            nodeState.reconSubgroups = buildSubgroupPlan(
              passInput, `${targetKey}_recon_p${nodeState.reconPassNumber}`, 0, MAX_FINDINGS_PER_SUBGROUP
            );
            nodeState.reconCursor = 0;
          }

          // Process pending recon subgroups with cursor
          while (nodeState.reconCursor < nodeState.reconSubgroups.length) {
            const rsg = nodeState.reconSubgroups[nodeState.reconCursor];
            if (rsg.status === "complete") { nodeState.reconCursor++; continue; }

            const budgetRemaining = EFFECTIVE_CAP_MS - (Date.now() - startTime);
            if (budgetRemaining < MIN_WORK_BUDGET_MS + PERSISTENCE_RESERVE_MS) {
              nodeState.lastProgressAt = new Date().toISOString();
              await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
              diag.elapsedMs = Date.now() - startTime; diag.action = "persist_cursor_resume";
              return { status: "progress" as const, diagnostics: diag };
            }

            // Look up findings for this recon subgroup from passInput
            const findingMap = new Map(passInput.map(f => [f.finding_id, f]));
            const rsgFindings = rsg.memberFindingIds.map(id => findingMap.get(id)).filter((f): f is CanonicalFinding => !!f);

            let rsgResult: CanonicalFinding[];
            if (rsgFindings.length <= 1) {
              rsgResult = rsgFindings;
            } else {
              rsgResult = await processSubgroup(
                ctx, rsgFindings, model,
                `${targetKey}_recon_p${nodeState.reconPassNumber}_sg${nodeState.reconCursor}`, startTime
              );
            }

            rsg.outputFindings = rsgResult;
            rsg.outputFindingIds = rsgResult.map(f => f.finding_id);
            rsg.status = "complete";
            nodeState.reconCursor++;
          }

          // All recon subgroups for this pass complete — collect outputs for next pass
          const passOutputs = nodeState.reconSubgroups.flatMap(rsg => rsg.outputFindings);

          if (passOutputs.length < passInput.length) {
            // Progress made — set up next pass
            nodeState.reconPassNumber++;
            nodeState.reconIntermediateFindings = passOutputs;
            nodeState.reconSubgroups = [];
            nodeState.reconCursor = 0;
            // Loop continues — next iteration will decide single-merge vs another split pass
          } else {
            // No further reduction in partitioned passes.
            // Fix 5: Before declaring complete, ensure all outputs have been compared
            // through at least one global pass. If the total exceeds MAX_FINDINGS_PER_SUBGROUP
            // and no reduction occurred, this is an irreducible population — BLOCK rather than
            // falsely marking complete.
            if (passOutputs.length > MAX_FINDINGS_PER_SUBGROUP) {
              // Irreducible oversized population — cannot fit in a single merge request
              // and partitioned passes produced no reduction. Block explicitly.
              nodeState.lastError =
                `Reconciliation irreducible: ${passOutputs.length} findings cannot be reduced below ` +
                `${MAX_FINDINGS_PER_SUBGROUP}. Cross-partition duplicates may exist but partitioned ` +
                `reduction produced no convergence after ${nodeState.reconPassNumber + 1} passes.`;
              nodeState.failureClass = "unknown";
              await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
              diag.elapsedMs = Date.now() - startTime;
              diag.action = "block";
              return { status: "blocked" as const, diagnostics: diag };
            }
            // Small enough for a final single merge — this guarantees global comparison
            nodeState.reconciliationFindings = passOutputs;
            nodeState.reconciliationOutputIds = passOutputs.map(f => f.finding_id);
            nodeState.reconciliationComplete = true;
            nodeState.reconSubgroups = [];
            nodeState.reconCursor = 0;
            nodeState.reconIntermediateFindings = [];
            reconPassDone = true;
          }
        }
      } // end while !reconPassDone
    }

    // ─── Step 9: Validate ancestry + atomically complete ────────────────
    let finalFindings: CanonicalFinding[];
    if (nodeState.reconciliationRequired && nodeState.reconciliationComplete) {
      finalFindings = nodeState.reconciliationFindings;
    } else if (nodeState.subgroups.length === 1) {
      finalFindings = nodeState.subgroups[0].outputFindings;
    } else {
      // Should not reach here if reconciliation is required
      finalFindings = nodeState.subgroups.flatMap(sg => sg.outputFindings);
    }

    // ── Conservation check: carry forward any input findings not yet represented ──
    // (applies to L2+ only — L1 builds findings from raw text, so no pre-existing IDs)
    if (childLevel !== 0) {
      const outputIds = new Set(finalFindings.flatMap(f => [f.finding_id, ...(f.merged_from_finding_ids ?? [])]));
      const missingInputs = nodeState.inputFindingIds.filter(id => !outputIds.has(id));
      if (missingInputs.length > 0) {
        const missingFindings = inputFindings.filter(f => missingInputs.includes(f.finding_id));
        finalFindings.push(...missingFindings);
      }
    }

    // ── Deduplication pass ────────────────────────────────────────────────────
    // Fix 6: run deduplication FIRST, then verify conservation.
    // Every removed finding must appear in merged_from_finding_ids of a representative.
    if (finalFindings.length > 1) {
      // Snapshot input IDs before dedup for conservation tracking
      const preDedupIds = new Set(finalFindings.map(f => f.finding_id));

      const dedupResult = deduplicateFindings(finalFindings as any);
      const representativeIds = new Set<string>([
        ...dedupResult.ungroupedFindingIds,
        ...dedupResult.families.map(fam => fam.representativeFindingId),
      ]);
      finalFindings = finalFindings.filter(f => representativeIds.has(f.finding_id));

      // Build a lookup from removed IDs to their family representative (for repair)
      const removedToRepresentative = new Map<string, string>();
      for (const fam of dedupResult.families) {
        for (const memberId of fam.memberFindingIds) {
          if (memberId !== fam.representativeFindingId) {
            removedToRepresentative.set(memberId, fam.representativeFindingId);
          }
        }
      }

      // Fix 6: verify every removed ID is accounted for in merged_from_finding_ids
      const removedIds = [...preDedupIds].filter(id => !representativeIds.has(id));
      const representativeMap = new Map(finalFindings.map(f => [f.finding_id, f]));

      for (const removedId of removedIds) {
        const repId = removedToRepresentative.get(removedId);
        const representative = repId ? representativeMap.get(repId) : null;
        if (representative) {
          // Ensure the removed ID appears in merged_from_finding_ids
          const merged = representative.merged_from_finding_ids ?? [];
          if (!merged.includes(removedId)) {
            representative.merged_from_finding_ids = [...merged, removedId];
          }
        } else if (finalFindings.length > 0) {
          // No representative found (should not happen) — append to first finding
          const first = finalFindings[0];
          const merged = first.merged_from_finding_ids ?? [];
          if (!merged.includes(removedId)) {
            first.merged_from_finding_ids = [...merged, removedId];
          }
        }
      }
    }

    // ── Fix 7: Exact ancestry validation — mismatches BLOCK completion ────────
    // Verify the ancestry ID set is internally consistent.
    const ancestrySet = new Set(nodeState.ancestryAnalysisIds);
    const ancestryDuplicates = nodeState.ancestryAnalysisIds.filter((id, idx) =>
      nodeState!.ancestryAnalysisIds.indexOf(id) !== idx
    );
    if (ancestryDuplicates.length > 0) {
      // BLOCK: duplicate ancestry IDs are a tree construction error
      nodeState.lastError = `Ancestry has ${ancestryDuplicates.length} duplicate IDs: ${ancestryDuplicates.slice(0, 5).join(", ")}`;
      nodeState.failureClass = "unknown";
      await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
      diag.elapsedMs = Date.now() - startTime;
      diag.action = "block";
      diag.failureClass = "unknown";
      return { status: "blocked" as const, diagnostics: diag };
    }

    // For the natural root (top level), verify ancestry covers the full manifest
    const isNaturalRoot = targetLevel === Math.max(...validLevels) &&
      targetIndex === 0 &&
      !diag.nextUnresolved; // Will be checked after completion
    if (isNaturalRoot) {
      const expectedAnalysisIds = new Set(frozenManifest.eligibleAnalysisIds);
      const missingFromAncestry = [...expectedAnalysisIds].filter(id => !ancestrySet.has(id));
      const unexpectedInAncestry = [...ancestrySet].filter(id => !expectedAnalysisIds.has(id));

      if (missingFromAncestry.length > 0 || unexpectedInAncestry.length > 0) {
        nodeState.lastError =
          `Root ancestry mismatch: ${missingFromAncestry.length} missing, ${unexpectedInAncestry.length} unexpected. ` +
          `Missing: [${missingFromAncestry.slice(0, 5).join(",")}]. Unexpected: [${unexpectedInAncestry.slice(0, 5).join(",")}]`;
        nodeState.failureClass = "unknown";
        await persistNodeState(ctx, runId, targetLevel, targetIndex, nodeState, attemptId, claimedVersion);
        diag.elapsedMs = Date.now() - startTime;
        diag.action = "block";
        return { status: "blocked" as const, diagnostics: diag };
      }
    }

    // Compute output hash using full finding content (Fix 6: not just finding IDs)
    // Any content change with identical IDs must still invalidate parents.
    const findingContentHashes = finalFindings.map(f => computeFindingContentHash(f));
    nodeState.outputHash = computeContentHash(findingContentHashes.sort().join("|"));
    nodeState.ancestryCount = ancestrySet.size;
    nodeState.ancestryHash = computeContentHash(
      [...ancestrySet].sort().join("|") + ":" + nodeState.outputHash
    );

    diag.resultFindingCount = finalFindings.length;

    // ─── Step 10: CAS persist as complete ───────────────────────────────
    const checkpointJson = JSON.stringify({
      findings: finalFindings,
      executiveHeader: `Adaptive recovery L${targetLevel}:N${targetIndex}`,
      recoveryWorker: true,
      timestamp: new Date().toISOString(),
      dependencyFingerprint: depFingerprint,
      ancestryCount: nodeState.ancestryCount,
      ancestryAnalysisIds: nodeState.ancestryAnalysisIds,
    });

    const finalizeResult = await ctx.integrations.db.query(
      `UPDATE merge_checkpoints
       SET merged_json = ($4::jsonb || jsonb_build_object('_node_state', $7::jsonb)),
           model_used = $5,
           prompt_version = $6,
           status = 'complete',
           updated_at = now(),
           claimed_by = NULL,
           claimed_at = NULL,
           checkpoint_version = checkpoint_version + 1,
           payload_hash = md5(($4::jsonb)::text)
       WHERE module_run_id = $1
         AND tree_level = $2
         AND node_index = $3
         AND claimed_by = $8
         AND checkpoint_version = $9
       RETURNING checkpoint_version`,
      z.object({ checkpoint_version: z.coerce.number() }),
      [runId, targetLevel, targetIndex, checkpointJson, model, currentVersion,
       JSON.stringify(nodeState), attemptId, claimedVersion],
      { label: `CAS complete L${targetLevel}:N${targetIndex}` }
    );

    if (finalizeResult.length === 0) {
      diag.action = "reload_state";
      diag.failureClass = "cas_conflict";
      diag.elapsedMs = Date.now() - startTime;
      return { status: "retryable" as const, diagnostics: diag };
    }

    diag.progressAdvanced = true;
    diag.action = "complete";

    // Refresh heartbeat
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [runId],
      { label: "Refresh triggered_at (recovery heartbeat)" }
    );

    // Check if tree is fully complete
    metaByKey.set(targetKey, {
      treeLevel: targetLevel,
      nodeIndex: targetIndex,
      status: "complete",
      findingsCount: finalFindings.length,
      payloadBytes: checkpointJson.length,
      updatedAt: new Date().toISOString(),
      checkpointVersion: finalizeResult[0].checkpoint_version,
      nodeState,
      payloadHash: null,
    });

    let nextUnresolved: string | null = null;
    for (let lvl = 1; lvl <= maxLevel + 1 && !nextUnresolved; lvl++) {
      const childLvlMaxIdx = maxIndexByLevel.get(lvl - 1) ?? 0;
      const expectedNodes = Math.ceil((childLvlMaxIdx + 1) / MERGE_GROUP_SIZE);
      for (let ni = 0; ni < expectedNodes && !nextUnresolved; ni++) {
        const key = `${lvl}:${ni}`;
        const ex = metaByKey.get(key);
        if (ex?.status === "complete") continue;
        nextUnresolved = key;
      }
    }
    diag.nextUnresolved = nextUnresolved;
    diag.elapsedMs = Date.now() - startTime;

    if (!nextUnresolved) {
      return { status: "complete" as const, diagnostics: diag };
    }

    return { status: "progress" as const, diagnostics: diag };
  },
});

// ===========================================================================
// Processing Functions
// ===========================================================================

async function processLevel1Subgroup(
  ctx: any,
  runId: string,
  nodeIndex: number,
  model: string,
  currentVersion: string,
  startTime: number,
  manifestMembership: number[],
): Promise<CanonicalFinding[]> {
  // Fix 2: Use exact manifest membership — no range-based queries
  const analysisRows = await ctx.integrations.db.query(
    `SELECT chunk_index, result_json
     FROM pipeline_analysis
     WHERE run_id = $1 AND chunk_index = ANY($2::int[])
     ORDER BY chunk_index`,
    AnalysisResultSchema,
    [runId, manifestMembership],
    { label: `Load analysis chunks [${manifestMembership.join(",")}] for L1:N${nodeIndex} (manifest)` }
  );

  // Fix 8: Verify returned matches requested
  if (analysisRows.length !== manifestMembership.length) {
    const returned = new Set(analysisRows.map((r: any) => r.chunk_index));
    const missing = manifestMembership.filter(ci => !returned.has(ci));
    throw new AdaptiveRecoveryError(
      "missing_stale_child",
      `L1:N${nodeIndex} processSubgroup: manifest expects ${manifestMembership.length} analyses, got ${analysisRows.length}. Missing: [${missing.join(",")}]`
    );
  }

  if (analysisRows.length === 0) return [];

  const texts = analysisRows.map((row: any) => {
    const data = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return String(data.extraction ?? data.text ?? "");
  });

  const mergeInput = texts.map((t: string, i: number) => `## Analysis Chunk ${manifestMembership[i]}\n\n${t.slice(0, 50_000)}`).join("\n\n---\n\n");

  const result = await callLLMWithHeadroom(ctx, {
    model,
    max_tokens: MAX_TOKENS_LEVEL1,
    system: [{ type: "text", text: LEVEL1_MERGE_PROMPT }],
    messages: [{ role: "user", content: mergeInput }],
  }, `Adaptive L1:N${nodeIndex}`, {
    pipelineStartTime: startTime,
    maxPerCallTimeout: PER_CALL_TIMEOUT_MS,
    retries: 2,
    minBudget: MIN_WORK_BUDGET_MS,
  });

  const responseText = result.content[0]?.text ?? "";
  const findingsRaw = extractTag(responseText, "findings_json");

  // INVARIANT: Missing tags cannot become zero-finding success
  if (!findingsRaw) {
    throw new AdaptiveRecoveryError("missing_tag", "No <findings_json> tag in LLM response");
  }

  // INVARIANT: Truncated response cannot become success
  if (result.stop_reason === "max_tokens") {
    throw new AdaptiveRecoveryError("truncated_response", "Response was truncated (max_tokens)");
  }

  try {
    const parsed = JSON.parse(findingsRaw);
    // INVARIANT: Valid zero requires explicitly parsed empty array
    if (!Array.isArray(parsed)) {
      throw new AdaptiveRecoveryError("invalid_json", "Parsed findings is not an array");
    }
    const parseResult = parseCanonicalFindings(parsed, {
      mode: "fresh",
      source: `adaptive L1:N${nodeIndex}`,
      truncated: false,
    });
    return parseResult.findings;
  } catch (err) {
    if (err instanceof AdaptiveRecoveryError) throw err;
    throw new AdaptiveRecoveryError("invalid_json", `JSON parse failure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processSubgroup(
  ctx: any,
  findings: CanonicalFinding[],
  model: string,
  contextLabel: string,
  startTime: number,
): Promise<CanonicalFinding[]> {
  if (findings.length === 0) return [];
  if (findings.length === 1) return findings;

  const boundedInput = findings.map(f => ({
    finding_id: f.finding_id,
    severity: f.severity,
    title: f.title,
    detail: (f.detail ?? "").slice(0, 300),
    full_analysis: (f.full_analysis ?? "").slice(0, 300),
    source_docs: (f.source_docs ?? []).slice(0, 3),
    claim_ids: (f.claim_ids ?? []).slice(0, 5),
    merged_from_finding_ids: f.merged_from_finding_ids ?? [],
    issue_key: f.issue_key,
    finding_kind: f.finding_kind,
  }));

  const userContent = `Consolidate these findings:\n\n\`\`\`json\n${JSON.stringify(boundedInput, null, 1)}\n\`\`\``;

  const result = await callLLMWithHeadroom(ctx, {
    model,
    max_tokens: MAX_TOKENS_CONSOLIDATION,
    system: [{ type: "text", text: CONSOLIDATION_SYSTEM_PROMPT }],
    messages: [{ role: "user", content: userContent }],
  }, `Adaptive consolidate ${contextLabel}`, {
    pipelineStartTime: startTime,
    maxPerCallTimeout: PER_CALL_TIMEOUT_MS,
    retries: 2,
    minBudget: MIN_WORK_BUDGET_MS,
  });

  const responseText = result.content[0]?.text ?? "";

  // INVARIANT: Truncation at bounded input → split needed
  if (result.stop_reason === "max_tokens") {
    throw new AdaptiveRecoveryError("truncated_response", "Consolidation truncated");
  }

  const findingsRaw = extractTag(responseText, "findings_json");
  if (!findingsRaw) {
    throw new AdaptiveRecoveryError("missing_tag", "No <findings_json> tag in consolidation response");
  }

  try {
    const parsed = JSON.parse(findingsRaw);
    if (!Array.isArray(parsed)) {
      throw new AdaptiveRecoveryError("invalid_json", "Consolidation output not array");
    }

    const parseResult = parseCanonicalFindings(parsed, {
      mode: "fresh",
      source: `adaptive ${contextLabel}`,
      truncated: false,
    });

    // Merge-contract validation
    const contractResult = validateMergeContract(findings, parseResult.findings);
    if (!contractResult.valid) {
      throw new AdaptiveRecoveryError(
        "merge_contract_rejection",
        `Contract rejected: ${contractResult.violationCodes.join(", ")}`
      );
    }

    return contractResult.acceptedFindings;
  } catch (err) {
    if (err instanceof AdaptiveRecoveryError) throw err;
    throw new AdaptiveRecoveryError("invalid_json", `Parse failure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

async function persistNodeState(
  ctx: any,
  runId: string,
  level: number,
  index: number,
  state: DurableNodeState,
  attemptId: string,
  claimedVersion: number,
): Promise<void> {
  await ctx.integrations.db.execute(
    `UPDATE merge_checkpoints
     SET merged_json = COALESCE(merged_json, '{}'::jsonb) || jsonb_build_object('_node_state', $4::jsonb),
         status = 'partial',
         updated_at = now(),
         claimed_by = NULL,
         claimed_at = NULL,
         checkpoint_version = checkpoint_version + 1
     WHERE module_run_id = $1
       AND tree_level = $2
       AND node_index = $3
       AND claimed_by = $5
       AND checkpoint_version = $6`,
    [runId, level, index, JSON.stringify(state), attemptId, claimedVersion],
    { label: `Persist node state L${level}:N${index}` }
  );
}

function classifyFailure(err: unknown): FailureClass {
  if (err instanceof AdaptiveRecoveryError) return err.failureClass;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("deadline")) return "model_timeout";
  if (msg.includes("context_length") || msg.includes("token")) return "context_limit";
  if (msg.includes("rate_limit") || msg.includes("429")) return "model_timeout";
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) return "persistence_failure";
  return "unknown";
}

class AdaptiveRecoveryError extends Error {
  constructor(public failureClass: FailureClass, message: string) {
    super(message);
    this.name = "AdaptiveRecoveryError";
  }
}

// ===========================================================================
// Exports for testing
// ===========================================================================
export {
  computeDependencyFingerprint,
  buildSubgroupPlan,
  getChildIndices,
  classifyFailure,
  AdaptiveRecoveryError,
  hashFindingIds,
  computeFindingContentHash,
  MERGE_GROUP_SIZE,
  MAX_FINDINGS_PER_SUBGROUP,
  PipelinePrerequisiteError,
};
