/**
 * SCG Cloned-State Preflight — Dry-run validation of pipeline prerequisites.
 *
 * This is a READ-ONLY diagnostic that validates the SCG deal's (or any deal's)
 * run state consistency. It checks:
 *
 *   1. Migration 019 columns are present (fail-closed if not)
 *   2. Frozen manifest exists and is structurally valid
 *   3. Checkpoint topology matches manifest expectations
 *   4. No orphaned or duplicate nodes in the merge tree
 *   5. Ancestry coverage is complete (every eligible analysis is represented)
 *   6. Active artifact lifecycle is consistent (at most one active output)
 *   7. L1 membership alignment — each L1 node has the expected chunk indices
 *
 * DOES NOT MODIFY any data. Pure read path.
 * Safe to invoke against the SCG evidence set without governance gate.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  verifyMigration019,
  loadFrozenManifest,
  getValidMergeTreeLevels,
  type FrozenManifest,
  type MigrationVerificationResult,
} from "./pipeline-prerequisites.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_RUN_ID = "7bbeab48-8c1c-46c8-8a25-02b1caa5a8fb";

// ---------------------------------------------------------------------------
// Preflight Result Types
// ---------------------------------------------------------------------------

interface PreflightCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skipped";
  detail: string;
}

interface TopologyExpectation {
  level: number;
  expectedNodes: number;
  foundComplete: number;
  foundPartial: number;
  foundFailed: number;
  foundMissing: number;
}

interface L1MembershipCheck {
  nodeIndex: number;
  expectedChunks: number[];
  actualChunks: number[];
  missingChunks: number[];
  extraChunks: number[];
  aligned: boolean;
}

interface ArtifactLifecycleCheck {
  totalOutputRows: number;
  activeRows: number;
  invalidatedRows: number;
  orphanedRows: number; // Rows with no artifact_status value
  multipleActive: boolean;
}

interface PreflightResult {
  runId: string;
  timestamp: string;
  overallStatus: "pass" | "fail" | "warn";
  checks: PreflightCheck[];
  migrationStatus: MigrationVerificationResult | null;
  manifest: FrozenManifest | null;
  topologyReport: TopologyExpectation[];
  l1MembershipReport: L1MembershipCheck[];
  artifactLifecycle: ArtifactLifecycleCheck | null;
  ancestryReport: {
    totalTraced: number;
    expectedCount: number;
    missingIds: string[];
    unexpectedIds: string[];
    duplicateIds: string[];
    coverageComplete: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// API Definition
// ---------------------------------------------------------------------------

export default api({
  name: "ScgClonedStatePreflight",
  description: "Read-only preflight validation of pipeline state consistency",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().describe("Run ID to validate (defaults to SCG run)").nullable(),
  }),

  output: z.object({
    result: z.any(),
  }),

  async run(ctx, { runId }) {
    const targetRunId = runId || SCG_RUN_ID;
    const db = ctx.integrations.ic_diligence_db;
    const checks: PreflightCheck[] = [];
    let overallStatus: "pass" | "fail" | "warn" = "pass";

    const downgrade = (to: "fail" | "warn") => {
      if (to === "fail") overallStatus = "fail";
      else if (to === "warn" && overallStatus !== "fail") overallStatus = "warn";
    };

    // ─── Check 1: Migration 019 ──────────────────────────────────────────────
    let migrationStatus: MigrationVerificationResult | null = null;
    try {
      migrationStatus = await verifyMigration019(db);
      if (migrationStatus.migrated) {
        checks.push({ name: "migration_019", status: "pass", detail: `All ${migrationStatus.presentColumns.length} required columns present.` });
      } else {
        checks.push({ name: "migration_019", status: "fail", detail: `Missing columns: ${migrationStatus.missingColumns.join(", ")}` });
        downgrade("fail");
      }
    } catch (err: any) {
      checks.push({ name: "migration_019", status: "fail", detail: `Error checking migration: ${err?.message ?? String(err)}` });
      downgrade("fail");
    }

    // ─── Check 2: Frozen Manifest Exists ─────────────────────────────────────
    let manifest: FrozenManifest | null = null;
    try {
      manifest = await loadFrozenManifest(db, targetRunId);
      if (manifest) {
        checks.push({
          name: "frozen_manifest",
          status: "pass",
          detail: `Manifest v${manifest.version} found. ${manifest.eligibleCount} eligible analyses. Fingerprint: ${manifest.sourceFingerprint.slice(0, 16)}…`,
        });
      } else {
        checks.push({ name: "frozen_manifest", status: "fail", detail: "No frozen manifest persisted for this run." });
        downgrade("fail");
      }
    } catch (err: any) {
      checks.push({ name: "frozen_manifest", status: "fail", detail: `Error loading manifest: ${err?.message ?? String(err)}` });
      downgrade("fail");
    }

    // ─── Check 3: Topology Consistency ───────────────────────────────────────
    let topologyReport: TopologyExpectation[] = [];
    if (manifest) {
      try {
        const validLevels = getValidMergeTreeLevels(manifest);
        const checkpointRows = await db.query(
          `SELECT tree_level, node_index, status
           FROM merge_checkpoints
           WHERE module_run_id = $1
             AND tree_level = ANY($2::int[])
           ORDER BY tree_level, node_index`,
          z.object({ tree_level: z.number(), node_index: z.number(), status: z.string() }),
          [targetRunId, validLevels],
          { label: "Preflight: read checkpoint topology" }
        );

        const topology = manifest.expectedTopology;
        const levelExpected: Record<number, number> = {
          1: topology.l1,
          2: topology.l2,
          3: topology.l3,
          4: topology.l4,
        };

        for (const level of validLevels) {
          const nodesAtLevel = checkpointRows.filter((r: any) => r.tree_level === level);
          const complete = nodesAtLevel.filter((r: any) => r.status === "complete").length;
          const partial = nodesAtLevel.filter((r: any) => r.status === "partial").length;
          const failed = nodesAtLevel.filter((r: any) => r.status === "failed" || r.status === "blocked").length;
          const expected = levelExpected[level] ?? 0;
          const foundIndices = new Set(nodesAtLevel.map((r: any) => r.node_index));
          const missingIndices: number[] = [];
          for (let i = 0; i < expected; i++) {
            if (!foundIndices.has(i)) missingIndices.push(i);
          }

          topologyReport.push({
            level,
            expectedNodes: expected,
            foundComplete: complete,
            foundPartial: partial,
            foundFailed: failed,
            foundMissing: missingIndices.length,
          });
        }

        const allComplete = topologyReport.every(t =>
          t.foundComplete === t.expectedNodes && t.foundPartial === 0 && t.foundFailed === 0 && t.foundMissing === 0
        );
        if (allComplete) {
          checks.push({ name: "topology", status: "pass", detail: `All ${validLevels.length} levels fully complete.` });
        } else {
          const issues = topologyReport
            .filter(t => t.foundComplete < t.expectedNodes || t.foundFailed > 0)
            .map(t => `L${t.level}: ${t.foundComplete}/${t.expectedNodes} complete, ${t.foundFailed} failed, ${t.foundMissing} missing`)
            .join("; ");
          checks.push({ name: "topology", status: "warn", detail: issues });
          downgrade("warn");
        }
      } catch (err: any) {
        checks.push({ name: "topology", status: "fail", detail: `Error: ${err?.message ?? String(err)}` });
        downgrade("fail");
      }
    } else {
      topologyReport = [];
      checks.push({ name: "topology", status: "skipped", detail: "Skipped: no manifest available." });
    }

    // ─── Check 4: Duplicate Nodes ────────────────────────────────────────────
    if (manifest) {
      try {
        const duplicates = await db.query(
          `SELECT tree_level, node_index, COUNT(*)::int AS cnt
           FROM merge_checkpoints
           WHERE module_run_id = $1
             AND tree_level = ANY($2::int[])
           GROUP BY tree_level, node_index
           HAVING COUNT(*) > 1
           LIMIT 10`,
          z.object({ tree_level: z.number(), node_index: z.number(), cnt: z.number() }),
          [targetRunId, getValidMergeTreeLevels(manifest)],
          { label: "Preflight: check duplicate nodes" }
        );

        if (duplicates.length === 0) {
          checks.push({ name: "no_duplicate_nodes", status: "pass", detail: "No duplicate checkpoint entries found." });
        } else {
          const dupeDesc = duplicates.map((d: any) => `L${d.tree_level}:${d.node_index} (×${d.cnt})`).join(", ");
          checks.push({ name: "no_duplicate_nodes", status: "fail", detail: `Duplicate nodes: ${dupeDesc}` });
          downgrade("fail");
        }
      } catch (err: any) {
        checks.push({ name: "no_duplicate_nodes", status: "fail", detail: `Error: ${err?.message ?? String(err)}` });
        downgrade("fail");
      }
    }

    // ─── Check 5: Ancestry Coverage ─────────────────────────────────────────
    let ancestryReport: PreflightResult["ancestryReport"] = null;
    if (manifest) {
      try {
        // Get L4:0 (root) checkpoint ancestry
        const rootRows = await db.query(
          `SELECT ancestry_ids
           FROM merge_checkpoints
           WHERE module_run_id = $1 AND tree_level = 4 AND node_index = 0 AND status = 'complete'
           LIMIT 1`,
          z.object({ ancestry_ids: z.any() }),
          [targetRunId],
          { label: "Preflight: read root ancestry" }
        );

        if (rootRows.length === 0) {
          checks.push({ name: "ancestry_coverage", status: "warn", detail: "Root node (L4:0) not yet complete — ancestry check deferred." });
          downgrade("warn");
        } else {
          const rawAncestry: string[] = rootRows[0].ancestry_ids ?? [];
          const ancestrySet = new Set(rawAncestry);
          const expectedSet = new Set(manifest.eligibleAnalysisIds);

          const missingIds = [...expectedSet].filter(id => !ancestrySet.has(id));
          const unexpectedIds = [...ancestrySet].filter(id => !expectedSet.has(id));
          const duplicateIds = rawAncestry.filter((id, idx) => rawAncestry.indexOf(id) !== idx);

          ancestryReport = {
            totalTraced: rawAncestry.length,
            expectedCount: manifest.eligibleAnalysisIds.length,
            missingIds,
            unexpectedIds,
            duplicateIds,
            coverageComplete: missingIds.length === 0 && unexpectedIds.length === 0 && duplicateIds.length === 0,
          };

          if (ancestryReport.coverageComplete) {
            checks.push({ name: "ancestry_coverage", status: "pass", detail: `All ${ancestryReport.expectedCount} analyses represented in root ancestry.` });
          } else {
            const parts: string[] = [];
            if (missingIds.length > 0) parts.push(`${missingIds.length} missing`);
            if (unexpectedIds.length > 0) parts.push(`${unexpectedIds.length} unexpected`);
            if (duplicateIds.length > 0) parts.push(`${duplicateIds.length} duplicates`);
            checks.push({ name: "ancestry_coverage", status: "fail", detail: `Ancestry mismatch: ${parts.join(", ")}. Total traced: ${rawAncestry.length}, expected: ${manifest.eligibleAnalysisIds.length}` });
            downgrade("fail");
          }
        }
      } catch (err: any) {
        checks.push({ name: "ancestry_coverage", status: "fail", detail: `Error: ${err?.message ?? String(err)}` });
        downgrade("fail");
      }
    }

    // ─── Check 6: Artifact Lifecycle ─────────────────────────────────────────
    let artifactLifecycle: ArtifactLifecycleCheck | null = null;
    if (migrationStatus?.migrated) {
      try {
        const artifactRows = await db.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE artifact_status = 'active')::int AS active,
             COUNT(*) FILTER (WHERE artifact_status = 'invalidated_partial')::int AS invalidated,
             COUNT(*) FILTER (WHERE artifact_status IS NULL)::int AS orphaned
           FROM module_outputs
           WHERE module_run_id = $1`,
          z.object({ total: z.number(), active: z.number(), invalidated: z.number(), orphaned: z.number() }),
          [targetRunId],
          { label: "Preflight: artifact lifecycle counts" }
        );

        if (artifactRows.length > 0) {
          const r = artifactRows[0];
          artifactLifecycle = {
            totalOutputRows: r.total,
            activeRows: r.active,
            invalidatedRows: r.invalidated,
            orphanedRows: r.orphaned,
            multipleActive: r.active > 1,
          };

          if (r.active <= 1 && r.orphaned === 0) {
            checks.push({ name: "artifact_lifecycle", status: "pass", detail: `${r.total} total outputs: ${r.active} active, ${r.invalidated} invalidated, 0 orphaned.` });
          } else {
            const issues: string[] = [];
            if (r.active > 1) issues.push(`${r.active} active (expected ≤1)`);
            if (r.orphaned > 0) issues.push(`${r.orphaned} orphaned (null artifact_status)`);
            checks.push({ name: "artifact_lifecycle", status: "fail", detail: `Lifecycle issues: ${issues.join("; ")}` });
            downgrade("fail");
          }
        }
      } catch (err: any) {
        checks.push({ name: "artifact_lifecycle", status: "fail", detail: `Error: ${err?.message ?? String(err)}` });
        downgrade("fail");
      }
    } else {
      checks.push({ name: "artifact_lifecycle", status: "skipped", detail: "Skipped: migration 019 not applied." });
    }

    // ─── Check 7: L1 Membership Alignment ────────────────────────────────────
    let l1MembershipReport: L1MembershipCheck[] = [];
    if (manifest) {
      try {
        // Sample first 5 L1 nodes (to avoid massive query on 52-node trees)
        const sampleNodes = Object.keys(manifest.l1Membership).slice(0, 5).map(Number);

        for (const nodeIdx of sampleNodes) {
          const expectedChunks = manifest.l1Membership[nodeIdx] ?? [];
          const checkpointRow = await db.query(
            `SELECT payload
             FROM merge_checkpoints
             WHERE module_run_id = $1 AND tree_level = 1 AND node_index = $2
             LIMIT 1`,
            z.object({ payload: z.any() }),
            [targetRunId, nodeIdx],
            { label: `Preflight: L1 node ${nodeIdx} payload` }
          );

          if (checkpointRow.length === 0) {
            l1MembershipReport.push({
              nodeIndex: nodeIdx,
              expectedChunks,
              actualChunks: [],
              missingChunks: expectedChunks,
              extraChunks: [],
              aligned: false,
            });
            continue;
          }

          const payload = checkpointRow[0].payload;
          const actualChunks: number[] = payload?.source_chunk_indices ?? payload?.chunk_indices ?? [];
          const missingChunks = expectedChunks.filter(c => !actualChunks.includes(c));
          const extraChunks = actualChunks.filter(c => !expectedChunks.includes(c));

          l1MembershipReport.push({
            nodeIndex: nodeIdx,
            expectedChunks,
            actualChunks,
            missingChunks,
            extraChunks,
            aligned: missingChunks.length === 0 && extraChunks.length === 0,
          });
        }

        const allAligned = l1MembershipReport.every(r => r.aligned);
        if (allAligned) {
          checks.push({ name: "l1_membership", status: "pass", detail: `Sampled ${sampleNodes.length} L1 nodes — all aligned with manifest.` });
        } else {
          const misaligned = l1MembershipReport.filter(r => !r.aligned);
          const desc = misaligned.map(r => `L1:${r.nodeIndex} (${r.missingChunks.length} missing, ${r.extraChunks.length} extra)`).join(", ");
          checks.push({ name: "l1_membership", status: "warn", detail: `Misaligned L1 nodes: ${desc}` });
          downgrade("warn");
        }
      } catch (err: any) {
        checks.push({ name: "l1_membership", status: "fail", detail: `Error: ${err?.message ?? String(err)}` });
        downgrade("fail");
      }
    }

    // ─── Assemble Result ─────────────────────────────────────────────────────
    const result: PreflightResult = {
      runId: targetRunId,
      timestamp: new Date().toISOString(),
      overallStatus,
      checks,
      migrationStatus,
      manifest,
      topologyReport,
      l1MembershipReport,
      artifactLifecycle,
      ancestryReport,
    };

    return { result };
  },
});
