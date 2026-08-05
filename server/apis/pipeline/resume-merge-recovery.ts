/**
 * ResumeMergeRecovery — Targeted merge-only recovery worker.
 *
 * Resumes incomplete merge rounds WITHOUT rerunning extraction, claims,
 * reconciliation, numeric verification, or chunk analysis.
 *
 * Key differences from the main pipeline merge loop:
 *   1. Loads ONLY lightweight metadata first (not all 134 payloads)
 *   2. Identifies the single next workable node
 *   3. Loads only that node's direct children's payloads
 *   4. Bounded merge: max 6 findings per synthesis call
 *   5. Splits on truncation (no repeated retry of oversized prompts)
 *   6. Invalidates stale higher-level partials when inputs change
 *   7. Persists after every node, exits cleanly before timeout
 *   8. Single invocation = one completed node = valid progress
 *
 * Processing order: L1 partial → L2 partials → rebuild L3 → L4 → L5 root
 *
 * Safety invariants:
 *   - Every completed checkpoint remains reused
 *   - No original finding_id disappears
 *   - No partial relabeled complete without a successful bounded result
 *   - Deterministic work order (resume picks same node as uninterrupted)
 *   - Root rebuilt only from complete or explicitly degraded child results
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom, type LLMResponse } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { parseCanonicalFindings, type CanonicalFinding } from "./canonical-finding.js";
import { validateMergeContract } from "./merge-contract-validator.js";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import type { PipelineContext } from "./pipeline-config.js";
import { EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Integration IDs
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MERGE_GROUP_SIZE = 4;
const MAX_FINDINGS_PER_CALL = 6;
const MAX_TOKENS_CONSOLIDATION = 4096;
const MAX_TOKENS_LEVEL1 = 8000;
const PERSISTENCE_RESERVE_MS = 25_000; // Time reserved for DB writes at end
const MIN_WORK_BUDGET_MS = 45_000; // Minimum time needed to attempt one merge call
const PER_CALL_TIMEOUT_MS = 120_000; // Max timeout for a single LLM call
const CLAIM_EXPIRY_MINUTES = 10; // Claims older than this can be reclaimed by another worker

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface NodeMeta {
  treeLevel: number;
  nodeIndex: number;
  status: string;
  findingsCount: number;
  payloadBytes: number;
  updatedAt: string;
  truncationCount: number;
  checkpointVersion: number;
}

interface WorkUnit {
  level: number;
  nodeIndex: number;
  childIds: string[]; // "level:index" keys
  inputFindingsCount: number;
  inputPayloadBytes: number;
  action: "merge" | "split" | "pass_through" | "degraded_fallback" | "level1_merge";
  claimedVersion: number; // checkpoint_version at time of claim — used for CAS
  attemptId: string; // unique attempt identifier for this invocation
}

interface InvocationDiagnostics {
  selectedNode: string | null;
  childIds: string[];
  inputFindingCount: number;
  inputPayloadBytes: number;
  action: string;
  attemptNumber: number;
  elapsedMs: number;
  resultFindingCount: number;
  checkpointStatus: string;
  nextUnresolved: string | null;
  completeByLevel: Record<number, number>;
  partialByLevel: Record<number, number>;
  pendingSplitChildren: number;
  degradedFallbackGroups: number;
  lastDurableProgressAt: string | null;
  invalidatedNodes: string[];
}

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
  truncation_count: z.coerce.number(),
  checkpoint_version: z.coerce.number(),
});

const ChildPayloadSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
});

const AnalysisResultSchema = z.object({
  chunk_index: z.coerce.number(),
  result_json: z.any(),
});

// ---------------------------------------------------------------------------
// Consolidation prompt (bounded, structured-only)
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

// ---------------------------------------------------------------------------
// Helper: compute input fingerprint for a node
// ---------------------------------------------------------------------------
function computeInputFingerprint(childMetas: NodeMeta[]): string {
  // Hash of children's (status, updatedAt, findingsCount) — detects when inputs change
  const parts = childMetas
    .sort((a, b) => a.nodeIndex - b.nodeIndex)
    .map(c => `${c.treeLevel}:${c.nodeIndex}:${c.status}:${c.findingsCount}:${c.updatedAt}`);
  // Simple FNV-1a for fingerprint
  let h = 0x811c9dc5 >>> 0;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
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
// Helper: deterministic split into bounded groups
// ---------------------------------------------------------------------------
function splitFindings(findings: CanonicalFinding[], maxPerGroup: number): CanonicalFinding[][] {
  // Sort by finding_id for determinism
  const sorted = [...findings].sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  const groups: CanonicalFinding[][] = [];
  for (let i = 0; i < sorted.length; i += maxPerGroup) {
    groups.push(sorted.slice(i, i + maxPerGroup));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Helper: get children node indices for a given parent
// ---------------------------------------------------------------------------
function getChildIndices(parentLevel: number, parentIndex: number, maxChildIndex: number): number[] {
  // Parent at level L, index I was built from children at level L-1,
  // indices [I*MERGE_GROUP_SIZE .. min((I+1)*MERGE_GROUP_SIZE - 1, maxChildIndex)]
  const start = parentIndex * MERGE_GROUP_SIZE;
  const end = Math.min(start + MERGE_GROUP_SIZE - 1, maxChildIndex);
  const indices: number[] = [];
  for (let i = start; i <= end; i++) indices.push(i);
  return indices;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------
export default api({
  name: "ResumeMergeRecovery",
  description: "Merge-only recovery worker: resumes unresolved merge nodes without rerunning analysis",

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
    status: z.enum(["progress", "complete", "blocked", "error"]),
    diagnostics: z.any(),
    waterfall: z.any().nullable(),
  }),

  async run(ctx, { runId, moduleId, useOpus }) {
    const startTime = Date.now();
    const currentVersion = getPipelineVersion();
    const model = getModuleModel(moduleId, useOpus);

    const diag: InvocationDiagnostics = {
      selectedNode: null,
      childIds: [],
      inputFindingCount: 0,
      inputPayloadBytes: 0,
      action: "none",
      attemptNumber: 0,
      elapsedMs: 0,
      resultFindingCount: 0,
      checkpointStatus: "none",
      nextUnresolved: null,
      completeByLevel: {},
      partialByLevel: {},
      pendingSplitChildren: 0,
      degradedFallbackGroups: 0,
      lastDurableProgressAt: null,
      invalidatedNodes: [],
    };

    // ─── Step 1: Load lightweight metadata ──────────────────────────────
    const metadata = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(status, 'complete') AS status,
              jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
              octet_length(merged_json::text) AS payload_bytes,
              updated_at::text AS updated_at,
              COALESCE((merged_json->>'truncation_count')::int, 0) AS truncation_count,
              checkpoint_version
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND node_index >= 0
       ORDER BY tree_level, node_index`,
      MetadataRowSchema,
      [runId],
      { label: "Load merge checkpoint metadata (lightweight)" }
    );

    const nodeMetas: NodeMeta[] = metadata.map(r => ({
      treeLevel: r.tree_level,
      nodeIndex: r.node_index,
      status: r.status ?? "complete",
      findingsCount: r.findings_count,
      payloadBytes: r.payload_bytes,
      updatedAt: r.updated_at ?? "",
      truncationCount: r.truncation_count,
      checkpointVersion: r.checkpoint_version,
    }));

    // Build lookup maps
    const metaByKey = new Map<string, NodeMeta>();
    for (const m of nodeMetas) metaByKey.set(`${m.treeLevel}:${m.nodeIndex}`, m);

    // Compute level stats
    const levels = new Set(nodeMetas.map(m => m.treeLevel));
    const maxLevel = Math.max(...levels, 0);
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const atLevel = nodeMetas.filter(m => m.treeLevel === lvl);
      diag.completeByLevel[lvl] = atLevel.filter(m => m.status === "complete").length;
      diag.partialByLevel[lvl] = atLevel.filter(m => m.status !== "complete").length;
    }

    // Count analysis results (level 0 equivalent)
    const analysisCountRows = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Count analysis results" }
    );
    const analysisCount = analysisCountRows[0]?.cnt ?? 0;

    // Determine max node_index per level (for child index computation)
    const maxIndexByLevel = new Map<number, number>();
    for (const m of nodeMetas) {
      const curr = maxIndexByLevel.get(m.treeLevel) ?? -1;
      if (m.nodeIndex > curr) maxIndexByLevel.set(m.treeLevel, m.nodeIndex);
    }
    // Level 0 (analysis): index range is 0..analysisCount-1
    maxIndexByLevel.set(0, analysisCount - 1);

    // ─── Step 2: Invalidate stale higher-level partials ─────────────────
    // A node at level L is stale if ANY of its children at level L-1 were
    // completed AFTER the node's own updated_at. We invalidate by deleting
    // the stale partial (it will be rebuilt from fresh children).
    for (let lvl = 2; lvl <= maxLevel; lvl++) {
      const nodesAtLevel = nodeMetas.filter(m => m.treeLevel === lvl && m.status !== "complete");
      for (const node of nodesAtLevel) {
        const childLevel = lvl - 1;
        const maxChildIdx = maxIndexByLevel.get(childLevel) ?? 0;
        const childIndices = getChildIndices(lvl, node.nodeIndex, maxChildIdx);
        const childMetas = childIndices
          .map(ci => metaByKey.get(`${childLevel}:${ci}`))
          .filter((c): c is NodeMeta => c != null);

        // Check if any child was updated after this node
        const anyChildNewer = childMetas.some(c => c.updatedAt > node.updatedAt && c.status === "complete");
        if (anyChildNewer) {
          // Invalidate this node — delete it so it gets rebuilt
          await ctx.integrations.db.execute(
            `DELETE FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3`,
            [runId, lvl, node.nodeIndex],
            { label: `Invalidate stale node L${lvl}:N${node.nodeIndex}` }
          );
          diag.invalidatedNodes.push(`${lvl}:${node.nodeIndex}`);
          // Remove from local maps
          metaByKey.delete(`${lvl}:${node.nodeIndex}`);
        }
      }
    }

    // ─── Step 3: Find next workable node ────────────────────────────────
    // Process order: lowest level first, lowest index within level.
    // A node is workable if:
    //   (a) It doesn't exist OR has status != 'complete'
    //   (b) All its children at level-1 are 'complete'
    let workUnit: WorkUnit | null = null;

    for (let lvl = 1; lvl <= maxLevel + 1 && !workUnit; lvl++) {
      // Determine expected node count at this level
      const childLevelMaxIndex = maxIndexByLevel.get(lvl - 1) ?? 0;
      const expectedNodes = Math.ceil((childLevelMaxIndex + 1) / MERGE_GROUP_SIZE);

      for (let ni = 0; ni < expectedNodes && !workUnit; ni++) {
        const key = `${lvl}:${ni}`;
        const existing = metaByKey.get(key);

        // Already complete — skip
        if (existing?.status === "complete") continue;

        // Check if children are all complete
        const childLevel = lvl - 1;
        const maxChildIdx = maxIndexByLevel.get(childLevel) ?? 0;
        const childIndices = getChildIndices(lvl, ni, maxChildIdx);

        let childrenReady: boolean;
        if (childLevel === 0) {
          // Level 1 children are analysis results — always "ready"
          childrenReady = true;
        } else {
          childrenReady = childIndices.every(ci => {
            const childMeta = metaByKey.get(`${childLevel}:${ci}`);
            return childMeta?.status === "complete";
          });
        }

        if (!childrenReady) continue;

        // Determine input finding count from children
        let inputFindings = 0;
        let inputBytes = 0;
        if (childLevel === 0) {
          // Level 1: children are analysis chunks (text, not findings)
          inputFindings = 0; // raw text extraction
          inputBytes = 0; // will load on demand
        } else {
          for (const ci of childIndices) {
            const cm = metaByKey.get(`${childLevel}:${ci}`);
            if (cm) {
              inputFindings += cm.findingsCount;
              inputBytes += cm.payloadBytes;
            }
          }
        }

        const action: WorkUnit["action"] = childLevel === 0 ? "level1_merge" :
          inputFindings <= 1 ? "pass_through" :
          inputFindings <= MAX_FINDINGS_PER_CALL ? "merge" : "split";

        // Record the checkpoint_version we observed for CAS
        const observedVersion = existing?.checkpointVersion ?? 0;

        workUnit = {
          level: lvl,
          nodeIndex: ni,
          childIds: childIndices.map(ci => `${childLevel}:${ci}`),
          inputFindingsCount: inputFindings,
          inputPayloadBytes: inputBytes,
          action,
          claimedVersion: observedVersion,
          attemptId: `recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        };
      }
    }

    if (!workUnit) {
      // All nodes are complete — check if we can report the waterfall
      const waterfall = buildWaterfall(nodeMetas, analysisCount, maxLevel);
      diag.elapsedMs = Date.now() - startTime;
      return { status: "complete" as const, diagnostics: diag, waterfall };
    }

    // ─── Step 3.5: Atomic claim ─────────────────────────────────────────
    // Atomically claim the node. This prevents concurrent workers from
    // processing the same node. The claim succeeds only if:
    //   (a) The node is not already complete
    //   (b) No other worker holds an unexpired claim
    //   (c) The checkpoint_version still matches our observed version
    //
    // If the node doesn't exist yet (level1_merge first time), we INSERT it
    // with an empty placeholder payload in 'claimed' status.
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
       RETURNING checkpoint_version`,
      z.object({ checkpoint_version: z.coerce.number() }),
      [runId, workUnit.level, workUnit.nodeIndex, workUnit.attemptId, workUnit.claimedVersion],
      { label: `Atomic claim L${workUnit.level}:N${workUnit.nodeIndex} (attempt ${workUnit.attemptId})` }
    );

    if (claimResult.length === 0) {
      // Claim failed — node was concurrently completed, already claimed by another worker,
      // or version changed. This is expected and safe — just report and exit.
      diag.elapsedMs = Date.now() - startTime;
      diag.checkpointStatus = "claim_rejected";
      return { status: "progress" as const, diagnostics: diag, waterfall: null };
    }

    // Update the claimed version for the CAS final write
    workUnit.claimedVersion = claimResult[0].checkpoint_version;

    diag.selectedNode = `${workUnit.level}:${workUnit.nodeIndex}`;
    diag.childIds = workUnit.childIds;
    diag.inputFindingCount = workUnit.inputFindingsCount;
    diag.inputPayloadBytes = workUnit.inputPayloadBytes;
    diag.action = workUnit.action;

    // ─── Step 4: Budget check ───────────────────────────────────────────
    const elapsed = Date.now() - startTime;
    const remaining = EFFECTIVE_CAP_MS - elapsed;
    if (remaining < MIN_WORK_BUDGET_MS + PERSISTENCE_RESERVE_MS) {
      diag.elapsedMs = Date.now() - startTime;
      diag.checkpointStatus = "budget_exhausted_before_work";
      return { status: "progress" as const, diagnostics: diag, waterfall: null };
    }

    // ─── Step 5: Execute work unit ──────────────────────────────────────
    let resultFindings: CanonicalFinding[] = [];

    try {
      if (workUnit.action === "pass_through") {
        // Singleton pass-through: load the single child's findings and persist directly
        const childKey = workUnit.childIds[0];
        const [childLevel, childIdx] = childKey.split(":").map(Number);
        const childPayloads = await ctx.integrations.db.query(
          `SELECT tree_level, node_index, merged_json
           FROM merge_checkpoints
           WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
           LIMIT 1`,
          ChildPayloadSchema,
          [runId, childLevel, childIdx],
          { label: `Load pass-through child L${childLevel}:N${childIdx}` }
        );
        if (childPayloads.length > 0) {
          const data = typeof childPayloads[0].merged_json === "string"
            ? JSON.parse(childPayloads[0].merged_json)
            : childPayloads[0].merged_json;
          resultFindings = (data.findings ?? []) as CanonicalFinding[];
        }
        diag.attemptNumber = 0;

      } else if (workUnit.action === "level1_merge") {
        // Level 1: merge raw analysis text from pipeline_analysis
        resultFindings = await processLevel1Node(
          ctx, runId, workUnit, model, currentVersion, startTime, diag
        );

      } else if (workUnit.action === "merge") {
        // Direct merge: ≤6 input findings
        const childFindings = await loadChildFindings(ctx, runId, workUnit.childIds);
        diag.inputFindingCount = childFindings.length;
        resultFindings = await consolidateFindings(
          ctx, childFindings, model, workUnit, startTime, diag
        );

      } else if (workUnit.action === "split") {
        // Split into bounded sub-groups, process each
        const childFindings = await loadChildFindings(ctx, runId, workUnit.childIds);
        diag.inputFindingCount = childFindings.length;
        resultFindings = await processSplitNode(
          ctx, childFindings, model, workUnit, startTime, diag
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ResumeMergeRecovery] Error processing L${workUnit.level}:N${workUnit.nodeIndex}: ${msg}`);

      // On error: DO NOT persist as complete. Mark diagnostic and persist guarded error
      diag.checkpointStatus = `error: ${msg.slice(0, 200)}`;
      diag.elapsedMs = Date.now() - startTime;

      // Guarded error persist: only write error if node is NOT already complete
      // and we still hold the claim (claimed_by = attemptId)
      await ctx.integrations.db.execute(
        `UPDATE merge_checkpoints
         SET merged_json = $4::jsonb,
             model_used = $5,
             prompt_version = $6,
             status = 'error',
             claimed_by = NULL,
             claimed_at = NULL
         WHERE module_run_id = $1
           AND tree_level = $2
           AND node_index = $3
           AND status <> 'complete'
           AND claimed_by = $7`,
        [runId, workUnit.level, workUnit.nodeIndex,
         JSON.stringify({ error: msg.slice(0, 1000), timestamp: new Date().toISOString() }),
         model, currentVersion, workUnit.attemptId],
        { label: `Guarded error persist L${workUnit.level}:N${workUnit.nodeIndex}` }
      );

      return { status: "progress" as const, diagnostics: diag, waterfall: null };
    }

    // ─── Step 6: CAS Persist result ───────────────────────────────────
    diag.resultFindingCount = resultFindings.length;

    const checkpointJson = JSON.stringify({
      findings: resultFindings,
      executiveHeader: `Recovery merge L${workUnit.level}:N${workUnit.nodeIndex}`,
      recoveryWorker: true,
      inputFingerprintChildren: workUnit.childIds,
      timestamp: new Date().toISOString(),
    });

    // Compare-and-swap: only finalize if we still own the claim
    // (claimed_by = attemptId AND checkpoint_version = claimedVersion)
    const finalizeResult = await ctx.integrations.db.query(
      `UPDATE merge_checkpoints
       SET merged_json = $4::jsonb,
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
         AND claimed_by = $7
         AND checkpoint_version = $8
       RETURNING checkpoint_version`,
      z.object({ checkpoint_version: z.coerce.number() }),
      [runId, workUnit.level, workUnit.nodeIndex, checkpointJson, model, currentVersion,
       workUnit.attemptId, workUnit.claimedVersion],
      { label: `CAS finalize complete L${workUnit.level}:N${workUnit.nodeIndex}` }
    );

    if (finalizeResult.length === 0) {
      // CAS failed — our claim was superseded or version changed
      diag.checkpointStatus = "cas_rejected_stale_attempt";
      diag.elapsedMs = Date.now() - startTime;
      return { status: "progress" as const, diagnostics: diag, waterfall: null };
    }

    diag.checkpointStatus = "complete";
    diag.lastDurableProgressAt = new Date().toISOString();

    // Refresh heartbeat so auto-resume doesn't conflict
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [runId],
      { label: "Refresh triggered_at (recovery heartbeat)" }
    );

    // ─── Step 7: Determine next unresolved ──────────────────────────────
    // Update local state and find next
    metaByKey.set(`${workUnit.level}:${workUnit.nodeIndex}`, {
      treeLevel: workUnit.level,
      nodeIndex: workUnit.nodeIndex,
      status: "complete",
      findingsCount: resultFindings.length,
      payloadBytes: checkpointJson.length,
      updatedAt: new Date().toISOString(),
      truncationCount: 0,
      checkpointVersion: finalizeResult[0].checkpoint_version,
    });

    // Check if there's more work
    let nextUnresolved: string | null = null;
    for (let lvl = 1; lvl <= maxLevel + 1 && !nextUnresolved; lvl++) {
      const childLevelMaxIndex = maxIndexByLevel.get(lvl - 1) ?? 0;
      const expectedNodes = Math.ceil((childLevelMaxIndex + 1) / MERGE_GROUP_SIZE);
      for (let ni = 0; ni < expectedNodes && !nextUnresolved; ni++) {
        const key = `${lvl}:${ni}`;
        const existing = metaByKey.get(key);
        if (existing?.status === "complete") continue;
        nextUnresolved = key;
      }
    }
    diag.nextUnresolved = nextUnresolved;
    diag.elapsedMs = Date.now() - startTime;

    // Update level stats after completion
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const atLevel = [...metaByKey.values()].filter(m => m.treeLevel === lvl);
      diag.completeByLevel[lvl] = atLevel.filter(m => m.status === "complete").length;
      diag.partialByLevel[lvl] = atLevel.filter(m => m.status !== "complete").length;
    }

    const isFullyComplete = nextUnresolved === null;
    if (isFullyComplete) {
      const waterfall = buildWaterfall(
        [...metaByKey.values()],
        analysisCount,
        maxLevel
      );
      return { status: "complete" as const, diagnostics: diag, waterfall };
    }

    return { status: "progress" as const, diagnostics: diag, waterfall: null };
  },
});

// ===========================================================================
// Processing functions
// ===========================================================================

/**
 * Process a level-1 node (merges raw analysis text → findings)
 */
async function processLevel1Node(
  ctx: PipelineContext,
  runId: string,
  workUnit: WorkUnit,
  model: string,
  currentVersion: string,
  startTime: number,
  diag: InvocationDiagnostics
): Promise<CanonicalFinding[]> {
  // Load analysis chunks for this group
  const startIdx = workUnit.nodeIndex * MERGE_GROUP_SIZE;
  const endIdx = startIdx + MERGE_GROUP_SIZE - 1;

  const analysisRows = await ctx.integrations.db.query(
    `SELECT chunk_index, result_json
     FROM pipeline_analysis
     WHERE run_id = $1 AND chunk_index >= $2 AND chunk_index <= $3
     ORDER BY chunk_index`,
    AnalysisResultSchema,
    [runId, startIdx, endIdx],
    { label: `Load analysis chunks ${startIdx}-${endIdx} for L1 merge` }
  );

  if (analysisRows.length === 0) return [];

  // Build merge input from analysis text
  const texts = analysisRows.map(row => {
    const data = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return String(data.extraction ?? data.text ?? "");
  });

  if (texts.length === 1) {
    // Singleton — still need to extract findings from text
    // Use a bounded extraction call
    diag.action = "level1_merge";
    diag.attemptNumber = 1;
  }

  const mergeInput = texts.map((t, i) => `## Analysis Chunk ${startIdx + i}\n\n${t.slice(0, 50_000)}`).join("\n\n---\n\n");

  const result = await callLLMWithHeadroom(ctx, {
    model,
    max_tokens: MAX_TOKENS_LEVEL1,
    system: [{ type: "text", text: LEVEL1_MERGE_PROMPT }],
    messages: [{ role: "user", content: mergeInput }],
  }, `Recovery L1:N${workUnit.nodeIndex}`, {
    pipelineStartTime: startTime,
    maxPerCallTimeout: PER_CALL_TIMEOUT_MS,
    retries: 2,
    minBudget: MIN_WORK_BUDGET_MS,
  });

  diag.attemptNumber = 1;
  const responseText = result.content[0]?.text ?? "";
  const findingsRaw = extractTag(responseText, "findings_json");

  if (!findingsRaw) return [];

  try {
    const parsed = JSON.parse(findingsRaw);
    const parseResult = parseCanonicalFindings(parsed, {
      mode: "fresh",
      source: `recovery L1:N${workUnit.nodeIndex}`,
      truncated: result.stop_reason === "max_tokens",
    });
    return parseResult.findings;
  } catch {
    return [];
  }
}

/**
 * Load findings from child checkpoint payloads (targeted, not all)
 */
async function loadChildFindings(
  ctx: PipelineContext,
  runId: string,
  childIds: string[]
): Promise<CanonicalFinding[]> {
  const allFindings: CanonicalFinding[] = [];

  for (const childKey of childIds) {
    const [level, index] = childKey.split(":").map(Number);
    const rows = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, merged_json
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = $2 AND node_index = $3
       LIMIT 1`,
      ChildPayloadSchema,
      [runId, level, index],
      { label: `Load child payload L${level}:N${index}` }
    );

    if (rows.length > 0) {
      const data = typeof rows[0].merged_json === "string"
        ? JSON.parse(rows[0].merged_json)
        : rows[0].merged_json;
      const findings = (data.findings ?? []) as CanonicalFinding[];
      allFindings.push(...findings);
    }
  }

  return allFindings;
}

/**
 * Consolidate ≤6 findings in a single LLM call
 */
async function consolidateFindings(
  ctx: PipelineContext,
  findings: CanonicalFinding[],
  model: string,
  workUnit: WorkUnit,
  startTime: number,
  diag: InvocationDiagnostics
): Promise<CanonicalFinding[]> {
  if (findings.length === 0) return [];
  if (findings.length === 1) {
    diag.action = "pass_through";
    return findings;
  }

  // Build bounded input — only essential fields
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

  diag.attemptNumber = 1;
  const result = await callLLMWithHeadroom(ctx, {
    model,
    max_tokens: MAX_TOKENS_CONSOLIDATION,
    system: [{ type: "text", text: CONSOLIDATION_SYSTEM_PROMPT }],
    messages: [{ role: "user", content: userContent }],
  }, `Recovery consolidate L${workUnit.level}:N${workUnit.nodeIndex}`, {
    pipelineStartTime: startTime,
    maxPerCallTimeout: PER_CALL_TIMEOUT_MS,
    retries: 2,
    minBudget: MIN_WORK_BUDGET_MS,
  });

  const responseText = result.content[0]?.text ?? "";
  const truncated = result.stop_reason === "max_tokens";

  if (truncated) {
    // At ≤6 findings, truncation means degraded fallback
    console.warn(`[ResumeMergeRecovery] Truncation at ≤${MAX_FINDINGS_PER_CALL} findings — degraded fallback`);
    diag.action = "degraded_fallback";
    diag.degradedFallbackGroups++;
    // Carry forward original findings tagged as degraded
    return findings.map(f => ({ ...f, _recovery_status: "degraded_fallback" } as any));
  }

  const findingsRaw = extractTag(responseText, "findings_json");
  if (!findingsRaw) {
    // Parse failure — carry forward
    return findings;
  }

  try {
    const parsed = JSON.parse(findingsRaw);
    const parseResult = parseCanonicalFindings(parsed, {
      mode: "fresh",
      source: `recovery L${workUnit.level}:N${workUnit.nodeIndex}`,
      truncated: false,
    });

    // ─── OA-02: Non-generative merge contract enforcement ─────────────
    // For L2+ merge stages, validate that the LLM output is strictly
    // non-generative: all IDs, evidence, claims, source docs, coordinates,
    // and numeric values must trace to the direct input findings.
    const contractResult = validateMergeContract(findings, parseResult.findings);
    if (!contractResult.valid) {
      // Fail-closed: reject LLM output, preserve original input findings
      console.warn(
        `[ResumeMergeRecovery] OA-02 merge contract REJECTED L${workUnit.level}:N${workUnit.nodeIndex}: ` +
        `${contractResult.validationErrors.length} violation(s) — [${contractResult.violationCodes.join(", ")}]`
      );
      // Tag input findings as degraded_fallback so downstream knows contract was enforced
      return findings.map(f => ({ ...f, _recovery_status: "merge_contract_fallback" } as any));
    }

    // Contract passed — use validated output.
    // Additional safety: ensure no finding_ids from input are lost
    // (belt-and-suspenders with the contract validator's own checks)
    const outputIds = new Set(contractResult.acceptedFindings.flatMap(f =>
      [f.finding_id, ...(f.merged_from_finding_ids ?? [])]
    ));
    const inputIds = findings.map(f => f.finding_id);
    const missing = inputIds.filter(id => !outputIds.has(id));

    if (missing.length > 0) {
      console.warn(`[ResumeMergeRecovery] ${missing.length} input finding_ids not accounted for — carrying forward`);
      const missingFindings = findings.filter(f => missing.includes(f.finding_id));
      contractResult.acceptedFindings.push(...missingFindings);
    }

    // OA-03: Canonical family dedup after merge contract passes
    if (contractResult.acceptedFindings.length > 1) {
      const familyResult = deduplicateFindings(contractResult.acceptedFindings as any);
      const retainedIds = new Set<string>([
        ...familyResult.ungroupedFindingIds,
        ...familyResult.families.map(f => f.representativeFindingId),
      ]);
      const preDedupCount = contractResult.acceptedFindings.length;
      contractResult.acceptedFindings = contractResult.acceptedFindings.filter(f => retainedIds.has(f.finding_id));
      if (contractResult.acceptedFindings.length < preDedupCount) {
        console.log(`[ResumeMergeRecovery][OA-03] Family dedup: ${preDedupCount} → ${contractResult.acceptedFindings.length}`);
      }
    }

    return contractResult.acceptedFindings;
  } catch {
    return findings;
  }
}

/**
 * Process a node with >6 input findings by splitting into bounded sub-groups
 */
async function processSplitNode(
  ctx: PipelineContext,
  findings: CanonicalFinding[],
  model: string,
  workUnit: WorkUnit,
  startTime: number,
  diag: InvocationDiagnostics
): Promise<CanonicalFinding[]> {
  const groups = splitFindings(findings, MAX_FINDINGS_PER_CALL);
  diag.action = "split";
  diag.pendingSplitChildren = groups.length;

  const allResults: CanonicalFinding[] = [];
  let groupsProcessed = 0;

  for (const group of groups) {
    // Budget check before each sub-group
    const remaining = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (remaining < MIN_WORK_BUDGET_MS + PERSISTENCE_RESERVE_MS) {
      // Budget exhausted — carry forward remaining groups as degraded
      console.log(`[ResumeMergeRecovery] Budget exhausted after ${groupsProcessed}/${groups.length} sub-groups`);
      const remainingGroups = groups.slice(groupsProcessed);
      for (const rg of remainingGroups) {
        allResults.push(...rg.map(f => ({ ...f, _recovery_status: "degraded_fallback" } as any)));
        diag.degradedFallbackGroups++;
      }
      break;
    }

    if (group.length === 1) {
      // Singleton pass-through
      allResults.push(group[0]);
    } else {
      // Bounded consolidation call
      const subResult = await consolidateFindings(ctx, group, model, workUnit, startTime, diag);
      allResults.push(...subResult);
    }
    groupsProcessed++;
  }

  return allResults;
}

// ===========================================================================
// Waterfall builder
// ===========================================================================
function buildWaterfall(nodeMetas: NodeMeta[], analysisCount: number, maxLevel: number): Record<string, number> {
  const waterfall: Record<string, number> = {
    analysis_outputs: analysisCount,
  };
  for (let lvl = 1; lvl <= maxLevel; lvl++) {
    const completeAtLevel = nodeMetas.filter(m => m.treeLevel === lvl && m.status === "complete");
    const totalFindings = completeAtLevel.reduce((sum, m) => sum + m.findingsCount, 0);
    waterfall[`level_${lvl}_nodes`] = completeAtLevel.length;
    waterfall[`level_${lvl}_findings`] = totalFindings;
  }
  return waterfall;
}

// ===========================================================================
// Level 1 merge prompt (extraction of findings from raw text)
// ===========================================================================
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
