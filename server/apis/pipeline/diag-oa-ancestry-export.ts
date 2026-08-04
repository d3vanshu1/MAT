/**
 * OA-01: Full ancestry ledger exporter
 *
 * Produces JSONL-format ancestry ledger for every finding at every stage.
 * Each row represents ONE finding occurrence at ONE stage/node.
 *
 * Every row contains the complete field set:
 * - Unique occurrence locator (stage:nodeIndex:findingId:occurrenceIndex)
 * - finding_id, all direct parent IDs, all child IDs
 * - All reachable L1/leaf ancestor IDs (deduplicated, sorted)
 * - first_stage_appeared, lineage_status
 * - proposition, normalized_proposition_hash, persisted_canonical_key, canonical_key_origin
 * - evidence, claim, disclosure, source-document, coordinate fields
 * - severity, reportability, merge_level
 * - degraded flag, actual persisted group ID (node-level)
 * - terminal descendant IDs
 * - representative/member relationship
 * - complete machine-readable missing-field reasons
 *
 * SAFE: read-only, does NOT write any persisted records.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import { buildAncestryGraph, type AncestryRow } from "./diag-oa-ancestry.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/** Simple FNV-1a hash */
function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function isDegraded(f: CanonicalFinding): boolean {
  return (f as any)._recovery_status === "degraded_fallback" ||
         (f as any)._recovery_status === "merge_contract_fallback";
}

export default api({
  name: "DiagOaAncestryExport",
  description: "OA-01: Exports full JSONL ancestry ledger for a run (read-only)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

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

    // Load merge checkpoints LEVEL BY LEVEL (gRPC 4MB limit)
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete' ORDER BY tree_level`,
      LevelListSchema, [runId], { label: "OA-01 export: list levels" }
    );

    const CheckpointSchema = z.object({ tree_level: z.coerce.number(), node_index: z.coerce.number(), findings_json: z.string() });
    interface CpRow { tree_level: number; node_index: number; findings_json: string; }
    const checkpoints: CpRow[] = [];

    for (const { tree_level } of levelRows) {
      const lvlCps = await db.query(
        `SELECT tree_level, node_index,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CheckpointSchema, [runId, tree_level], { label: `OA-01 export: load L${tree_level}` }
      );
      checkpoints.push(...lvlCps);
    }

    // Load terminal output
    const OutputSchema = z.object({ id: z.string(), findings_json: z.string() });
    const outputRows = await db.query(
      `SELECT mo.id, COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json
       FROM module_outputs mo JOIN module_runs mr ON mr.id = mo.module_run_id
       WHERE mr.id = $1 LIMIT 1`,
      OutputSchema, [runId], { label: "OA-01 export: load terminal output" }
    );

    // Count leaf analysis outputs
    const countRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }), [runId], { label: "OA-01 export: count leaf outputs" }
    );
    const leafCount = countRows[0]?.cnt ?? 0;

    // Parse into level map
    const findingsByLevel = new Map<number, Array<{ nodeIndex: number; findings: CanonicalFinding[] }>>();
    let maxLevel = 0;
    for (const cp of checkpoints) {
      if (cp.tree_level > maxLevel) maxLevel = cp.tree_level;
      let levelArr = findingsByLevel.get(cp.tree_level);
      if (!levelArr) { levelArr = []; findingsByLevel.set(cp.tree_level, levelArr); }
      try {
        const parsed = JSON.parse(cp.findings_json) as CanonicalFinding[];
        levelArr.push({ nodeIndex: cp.node_index, findings: parsed });
      } catch {
        levelArr.push({ nodeIndex: cp.node_index, findings: [] });
      }
    }

    let terminalFindings: CanonicalFinding[] = [];
    let terminalOutputId: string | null = null;
    if (outputRows.length > 0) {
      terminalOutputId = outputRows[0].id;
      try { terminalFindings = JSON.parse(outputRows[0].findings_json) as CanonicalFinding[]; } catch {}
    }

    // Build the ancestry graph
    const graph = buildAncestryGraph(findingsByLevel, terminalFindings);

    // Track first_stage_appeared per finding_id
    const firstStageMap = new Map<string, string>();
    for (const [fid, locs] of graph.globalIndex) {
      const sorted = [...locs].sort((a, b) => a.level - b.level);
      if (sorted.length > 0) firstStageMap.set(fid, sorted[0].stage);
    }

    // ═══ Build complete rows for every occurrence at every stage ═══
    const allRows: any[] = [];
    let globalOccurrenceIdx = 0;

    // Helper to build a complete row for a finding at a specific location
    function buildRow(f: CanonicalFinding, stage: string, nodeIndex: number, level: number): any {
      const fid = f.finding_id;
      const { leafIds, cycleDetected, missingParents } = graph.traceAllLeaves(fid);
      const classification = graph.classifyFinding(fid);
      const parents = [...(graph.childToParents.get(fid) ?? [])];
      const children = [...(graph.parentToChildren.get(fid) ?? [])];
      const termDescendants = graph.getTerminalDescendants(fid);
      const degraded = isDegraded(f);
      const firstStage = firstStageMap.get(fid) ?? stage;

      // Determine degraded group (node-level)
      let degradedGroupId: string | null = null;
      if (degraded) degradedGroupId = `L${level}:N${nodeIndex}`;

      // Representative/member
      let representativeMember: string | null = null;
      if (parents.length > 0) representativeMember = "representative";
      // Check if this finding is listed as a member in another's merged_from
      if (graph.parentToChildren.has(fid) && (graph.parentToChildren.get(fid)?.size ?? 0) > 0) {
        if (!representativeMember) representativeMember = "member";
      }

      // Missing field reasons
      const missingReasons: Record<string, string> = {};
      if (leafIds.length === 0 && classification !== "traces_to_leaf") missingReasons.all_leaf_ancestor_ids = "no_leaf_ancestor_traced";
      if (!f.issue_key) missingReasons.persisted_canonical_key = "not_assigned_by_llm";
      if (!(f.evidence?.length)) missingReasons.evidence_ids = "evidence_array_not_populated";
      if (cycleDetected) missingReasons.cycle = "cycle_detected_in_ancestry";
      if (missingParents.length > 0) missingReasons.missing_parents = `ids:${missingParents.join(",")}`;
      if (!(f.claim_ids?.length)) missingReasons.claim_ids = "claim_ids_not_populated";
      if (!(f.source_docs?.length)) missingReasons.source_document_ids = "source_docs_not_populated";

      const occId = `${stage}:N${nodeIndex}:${fid}:${globalOccurrenceIdx}`;
      const row = {
        run_id: runId,
        deal_id: dealId ?? null,
        module_id: moduleId,
        stage,
        analysis_node_id: `L${level}:N${nodeIndex}`,
        stage_occurrence_id: occId,
        occurrence_index: globalOccurrenceIdx,
        finding_id: fid,
        all_leaf_ancestor_ids: leafIds,
        source_proposition: f.title ?? null,
        normalized_proposition_hash: fnv1a(normalize(f.title)),
        persisted_canonical_key: f.issue_key ?? null,
        canonical_key_origin: f.issue_key ? "legacy" : "missing",
        claim_ids: f.claim_ids ?? [],
        disclosure_ids: f.evidence_docs ?? [],
        evidence_ids: (f.evidence ?? []).map(e => e.figure),
        source_document_ids: f.source_docs ?? [],
        source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean),
        severity: f.severity,
        reportability: "reportable",
        parent_ids: parents,
        child_ids: children,
        merge_level: level,
        representative_member: representativeMember,
        first_stage_appeared: firstStage,
        degraded_fallback_flag: degraded,
        degraded_fallback_group_id: degradedGroupId,
        terminal_descendant_ids: termDescendants,
        raw_payload_hash: fnv1a(JSON.stringify(f)),
        lineage_status: classification,
        missing_field_reasons: missingReasons,
      };
      globalOccurrenceIdx++;
      return row;
    }

    // Emit rows for every merge level
    for (let level = 1; level <= maxLevel; level++) {
      const stage = level === maxLevel ? "root" : `L${level}`;
      const nodesAtLevel = findingsByLevel.get(level) ?? [];
      for (const node of nodesAtLevel) {
        for (const f of node.findings) {
          allRows.push(buildRow(f, stage, node.nodeIndex, level));
        }
      }
    }

    // Emit rows for terminal findings
    for (const f of terminalFindings) {
      allRows.push(buildRow(f, "terminal", 0, maxLevel + 1));
    }

    // Build JSONL
    const jsonl = allRows.map(r => JSON.stringify(r)).join("\n");
    const checksum = fnv1a(jsonl);

    // Build stage reconciliation CSV
    const levelStats = new Map<string, { rows: number; unique: Set<string>; degraded: number; containers: number }>();

    for (const cp of checkpoints) {
      const stage = cp.tree_level === maxLevel ? "root" : `L${cp.tree_level}`;
      let s = levelStats.get(stage);
      if (!s) { s = { rows: 0, unique: new Set(), degraded: 0, containers: 0 }; levelStats.set(stage, s); }
      try {
        const parsed = JSON.parse(cp.findings_json) as CanonicalFinding[];
        s.rows += parsed.length;
        s.containers++;
        for (const f of parsed) {
          s.unique.add(f.finding_id);
          if (isDegraded(f)) s.degraded++;
        }
      } catch {}
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
