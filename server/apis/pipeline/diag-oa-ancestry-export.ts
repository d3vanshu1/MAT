/**
 * OA-01: Full ancestry ledger exporter (JSONL)
 *
 * Uses the shared oa-ancestry-service.ts for all computation.
 * Emits one complete row per finding occurrence at every stage.
 *
 * SAFE: read-only, does NOT write any persisted records.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import {
  buildOccurrenceGraph, buildAncestryLedgerRow, isDegraded, fnv1a,
  type NodeInput,
} from "./oa-ancestry-service.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagOaAncestryExport",
  description: "OA-01: Exports full JSONL ancestry ledger for a run (read-only)",

  integrations: { db: postgres(IC_DILIGENCE_DB) },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("omission_audit"),
    dealId: z.string().optional(),
  }),

  output: z.object({
    success: z.boolean(),
    error: z.string().nullable(),
    rowCount: z.number(),
    jsonlPayload: z.string(),
    stageReconciliationCsv: z.string(),
    checksum: z.string(),
  }),

  async run(ctx, { runId, moduleId, dealId }) {
    const db = ctx.integrations.db;

    // Load checkpoints level by level
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete' ORDER BY tree_level`,
      LevelListSchema, [runId], { label: "OA-01 export: list levels" }
    );

    const CpSchema = z.object({
      tree_level: z.coerce.number(), node_index: z.coerce.number(),
      findings_json: z.string(), checkpoint_id: z.string().nullable(),
    });

    const findingsByLevel = new Map<number, NodeInput[]>();
    let maxLevel = 0;

    for (const { tree_level } of levelRows) {
      const rows = await db.query(
        `SELECT tree_level, node_index,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
                id AS checkpoint_id
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CpSchema, [runId, tree_level], { label: `OA-01 export: L${tree_level}` }
      );
      if (tree_level > maxLevel) maxLevel = tree_level;
      const nodes: NodeInput[] = [];
      for (const r of rows) {
        let findings: CanonicalFinding[] = [];
        try { findings = JSON.parse(r.findings_json); } catch {}
        nodes.push({ nodeIndex: r.node_index, findings, checkpointId: r.checkpoint_id });
      }
      findingsByLevel.set(tree_level, nodes);
    }

    // Load terminal output
    const OutputSchema = z.object({ id: z.string(), findings_json: z.string() });
    const outputRows = await db.query(
      `SELECT mo.id, COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json
       FROM module_outputs mo JOIN module_runs mr ON mr.id = mo.module_run_id WHERE mr.id = $1 LIMIT 1`,
      OutputSchema, [runId], { label: "OA-01 export: terminal" }
    );

    let terminalFindings: CanonicalFinding[] = [];
    if (outputRows.length > 0) {
      try { terminalFindings = JSON.parse(outputRows[0].findings_json); } catch {}
    }

    // Leaf count
    const countRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }), [runId], { label: "OA-01 export: leaf count" }
    );
    const leafCount = countRows[0]?.cnt ?? 0;

    // Build graph (shared service)
    const graph = buildOccurrenceGraph(findingsByLevel, terminalFindings);

    // Build a ledger row for EVERY occurrence
    const allRows: any[] = [];
    let globalIdx = 0;

    for (let level = 1; level <= maxLevel; level++) {
      const nodes = findingsByLevel.get(level) ?? [];
      for (const node of nodes) {
        for (const f of node.findings) {
          const occ = graph.allOccurrences.find(o =>
            o.key.level === level && o.key.nodeIndex === node.nodeIndex && o.key.findingId === f.finding_id && o.finding === f
          );
          if (occ) {
            allRows.push(buildAncestryLedgerRow(occ, graph, runId, dealId ?? null, moduleId, globalIdx, node.checkpointId ?? null));
            globalIdx++;
          }
        }
      }
    }

    // Terminal rows
    const termOccs = graph.allOccurrences.filter(o => o.key.stage === "terminal");
    for (const occ of termOccs) {
      allRows.push(buildAncestryLedgerRow(occ, graph, runId, dealId ?? null, moduleId, globalIdx, null));
      globalIdx++;
    }

    // Build JSONL
    const jsonl = allRows.map(r => JSON.stringify(r)).join("\n");
    const checksum = fnv1a(jsonl);

    // Stage reconciliation CSV
    const levelStats = new Map<string, { rows: number; unique: Set<string>; degraded: number; containers: number }>();
    for (const [level, nodes] of findingsByLevel) {
      const stage = level === maxLevel ? "root" : `L${level}`;
      let s = levelStats.get(stage);
      if (!s) { s = { rows: 0, unique: new Set(), degraded: 0, containers: 0 }; levelStats.set(stage, s); }
      for (const node of nodes) {
        s.containers++;
        for (const f of node.findings) {
          s.rows++;
          s.unique.add(f.finding_id);
          if (isDegraded(f)) s.degraded++;
        }
      }
    }
    levelStats.set("leaf", { rows: 0, unique: new Set(), degraded: 0, containers: leafCount });
    const termStats = { rows: terminalFindings.length, unique: new Set(terminalFindings.map(f => f.finding_id)), degraded: terminalFindings.filter(isDegraded).length, containers: outputRows.length };
    levelStats.set("terminal", termStats);

    const csvHeader = "stage,containers,finding_rows,unique_finding_ids,degraded_rows\n";
    const stageOrder = ["leaf", ...Array.from({ length: maxLevel - 1 }, (_, i) => `L${i + 1}`), "root", "terminal"];
    const csvRows = stageOrder
      .filter(s => levelStats.has(s))
      .map(s => { const st = levelStats.get(s)!; return `${s},${st.containers},${st.rows},${st.unique.size},${st.degraded}`; })
      .join("\n");

    return {
      success: true, error: null, rowCount: allRows.length,
      jsonlPayload: jsonl, stageReconciliationCsv: csvHeader + csvRows, checksum,
    };
  },
});
