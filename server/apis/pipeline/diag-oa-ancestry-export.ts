/**
 * OA-01: Full ancestry ledger exporter
 *
 * Produces JSONL-format ancestry ledger for every finding at every stage.
 * Returns as a string payload that callers can stream/save to disk.
 *
 * Separate from DiagOaAncestry to avoid blowing up the API response size
 * with 434 × N-levels rows.
 *
 * SAFE: read-only, does NOT write any persisted records.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/** Simple FNV-1a hash for deterministic row IDs */
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
    jsonlPayload: z.string(), // JSONL content — write to disk outside this API
    stageReconciliationCsv: z.string(),
    checksum: z.string(), // fnv1a of entire jsonl — stable for idempotency
  }),

  async run(ctx, { runId, moduleId, dealId }) {
    const db = ctx.integrations.db;

    // Load merge checkpoints LEVEL BY LEVEL (gRPC 4MB limit)
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level`,
      LevelListSchema,
      [runId],
      { label: "OA-01 export: list levels" }
    );

    const CheckpointSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      findings_json: z.string(),
    });

    interface CpRow { tree_level: number; node_index: number; findings_json: string; }
    const checkpoints: CpRow[] = [];

    for (const { tree_level } of levelRows) {
      const lvlCps = await db.query(
        `SELECT tree_level, node_index,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CheckpointSchema,
        [runId, tree_level],
        { label: `OA-01 export: load L${tree_level}` }
      );
      checkpoints.push(...lvlCps);
    }

    // Load terminal output
    const OutputSchema = z.object({
      id: z.string(),
      findings_json: z.string(),
    });
    const outputRows = await db.query(
      `SELECT mo.id, COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json
       FROM module_outputs mo
       JOIN module_runs mr ON mr.id = mo.module_run_id
       WHERE mr.id = $1 LIMIT 1`,
      OutputSchema,
      [runId],
      { label: "OA-01 export: load terminal output" }
    );

    // Load analysis count
    const countRows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "OA-01 export: count leaf outputs" }
    );
    const leafCount = countRows[0]?.cnt ?? 0;

    // Build global index
    const maxLevel = checkpoints.reduce((m, cp) => Math.max(m, cp.tree_level), 0);
    const globalIndex = new Map<string, { level: number; nodeIndex: number; finding: CanonicalFinding }[]>();
    const allRows: any[] = [];

    for (const cp of checkpoints) {
      let parsed: CanonicalFinding[] = [];
      try { parsed = JSON.parse(cp.findings_json) as CanonicalFinding[]; } catch { parsed = []; }

      const stage = cp.tree_level === maxLevel ? "root" : `L${cp.tree_level}`;

      for (const f of parsed) {
        const locs = globalIndex.get(f.finding_id) ?? [];
        locs.push({ level: cp.tree_level, nodeIndex: cp.node_index, finding: f });
        globalIndex.set(f.finding_id, locs);

        const degraded = (f as any)._recovery_status === "degraded_fallback";
        allRows.push({
          run_id: runId,
          deal_id: dealId ?? null,
          module_id: moduleId,
          stage,
          analysis_node_id: `L${cp.tree_level}:N${cp.node_index}`,
          stage_occurrence_id: `${stage}:${f.finding_id}`,
          finding_id: f.finding_id,
          parent_ids: f.merged_from_finding_ids ?? [],
          title: f.title,
          issue_key: f.issue_key ?? null,
          severity: f.severity,
          claim_ids: f.claim_ids ?? [],
          source_docs: f.source_docs ?? [],
          merge_level: cp.tree_level,
          degraded_fallback: degraded,
          degraded_group_id: degraded ? fnv1a(f.finding_id) : null,
          raw_proposition_hash: fnv1a(normalize(f.title)),
          model_used: null,
          updated_at: null,
          // NOTE: these fields were never persisted in this path
          atomic_leaf_finding_id: null,
          leaf_not_persisted_reason: "legacy_path_no_leaf_id",
          canonical_key_origin: f.issue_key ? "legacy" : "missing",
          disclosure_ids: [],
          evidence_ids: (f.evidence ?? []).map(e => e.figure),
          source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean),
        });
      }
    }

    // Add terminal rows
    let terminalFindings: CanonicalFinding[] = [];
    let terminalOutputId: string | null = null;
    if (outputRows.length > 0) {
      terminalOutputId = outputRows[0].id;
      try { terminalFindings = JSON.parse(outputRows[0].findings_json) as CanonicalFinding[]; } catch {}
    }

    // Build parent→child map for lineage
    const parentToChildren = new Map<string, string[]>();
    for (const [fid, locs] of globalIndex) {
      for (const loc of locs) {
        for (const pid of loc.finding.merged_from_finding_ids ?? []) {
          const kids = parentToChildren.get(pid) ?? [];
          kids.push(fid);
          parentToChildren.set(pid, kids);
        }
      }
    }

    // Trace leaf ancestors
    function traceLeaf(fid: string, depth = 0): string | null {
      if (depth > 20) return null; // cycle guard
      const locs = globalIndex.get(fid);
      if (!locs) return null;
      const minLevel = Math.min(...locs.map(l => l.level));
      if (minLevel === 1) return fid;
      const parents = locs.flatMap(l => l.finding.merged_from_finding_ids ?? []);
      for (const pid of parents) {
        const result = traceLeaf(pid, depth + 1);
        if (result) return result;
      }
      return null;
    }

    for (const f of terminalFindings) {
      const degraded = (f as any)._recovery_status === "degraded_fallback";
      const leafId = traceLeaf(f.finding_id);
      const parents = (f.merged_from_finding_ids ?? []);
      const allParentsExist = parents.every(pid => globalIndex.has(pid));

      let lineage_status: string;
      if (leafId) lineage_status = "traces_to_leaf";
      else if (parents.length === 0) lineage_status = "generated_without_parent";
      else if (!allParentsExist) lineage_status = "broken_parent_reference";
      else lineage_status = "ambiguous_lineage";

      allRows.push({
        run_id: runId,
        deal_id: dealId ?? null,
        module_id: moduleId,
        stage: "terminal",
        analysis_node_id: `output:${terminalOutputId ?? "none"}`,
        stage_occurrence_id: `terminal:${f.finding_id}`,
        finding_id: f.finding_id,
        parent_ids: parents,
        child_ids: parentToChildren.get(f.finding_id) ?? [],
        title: f.title,
        issue_key: f.issue_key ?? null,
        severity: f.severity,
        claim_ids: f.claim_ids ?? [],
        source_docs: f.source_docs ?? [],
        merge_level: maxLevel,
        degraded_fallback: degraded,
        degraded_group_id: degraded ? fnv1a(f.finding_id) : null,
        raw_proposition_hash: fnv1a(normalize(f.title)),
        atomic_leaf_finding_id: leafId,
        leaf_not_persisted_reason: leafId ? null : "no_leaf_ancestor_traced",
        canonical_key_origin: f.issue_key ? "legacy" : "missing",
        lineage_status,
        disclosure_ids: [],
        evidence_ids: (f.evidence ?? []).map(e => e.figure),
        source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean),
        terminal_finding_id: f.finding_id,
      });
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
          if ((f as any)._recovery_status === "degraded_fallback") s.degraded++;
        }
      } catch {}
    }

    // Add leaf and terminal
    levelStats.set("leaf", { rows: 0, unique: new Set(), degraded: 0, containers: leafCount });
    const termStats = { rows: terminalFindings.length, unique: new Set(terminalFindings.map(f => f.finding_id)), degraded: terminalFindings.filter(f => (f as any)._recovery_status === "degraded_fallback").length, containers: outputRows.length };
    levelStats.set("terminal", termStats);

    const csvHeader = "stage,containers,finding_rows,unique_finding_ids,degraded_rows\n";
    const stageOrder = ["leaf", ...Array.from({ length: maxLevel - 1 }, (_, i) => `L${i + 1}`), "root", "terminal"];
    const csvRows = stageOrder
      .filter(s => levelStats.has(s))
      .map(s => {
        const st = levelStats.get(s)!;
        return `${s},${st.containers},${st.rows},${st.unique.size},${st.degraded}`;
      })
      .join("\n");
    const csv = csvHeader + csvRows;

    return {
      success: true,
      error: null,
      rowCount: allRows.length,
      jsonlPayload: jsonl,
      stageReconciliationCsv: csv,
      checksum,
    };
  },
});
