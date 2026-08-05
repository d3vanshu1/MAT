/**
 * OA-01: Forensic Ancestry & Finding-Inflation Diagnostic
 *
 * Thin API wrapper — all computation delegated to oa-ancestry-service.ts
 *
 * Identity path proof:
 *   The omission_audit module uses the LEGACY merge path via:
 *     - server/apis/pipeline/resume-merge-recovery.ts → ResumeMergeRecovery API
 *       ↳ processLevel1Node() — L1 generative extraction (raw text → findings)
 *       ↳ consolidateFindings() — L2+ deduplication merge
 *       ↳ processSplitNode() — split >6 findings, delegate to consolidateFindings
 *     - server/apis/pipeline/diagnostic-finalization.ts → DiagnosticFinalization
 *       ↳ Terminal consumer: takes root findings from merge_checkpoints → module_outputs
 *   Functions NOT invoked on this path:
 *     - server/apis/pipeline/q5-production-stage.ts (Q5 canonical identity)
 *     - server/apis/pipeline/finding-identity.ts (canonical identity functions)
 *     - server/apis/pipeline/replay-canonical-identity.ts (identity replay)
 *   Evidence: ResumeMergeRecovery imports parseCanonicalFindings from canonical-finding.ts
 *     and calls it in "fresh" mode (assigns new UUID v4 at L1). It does NOT import or call
 *     canonicalizeIdentity, replayCanonicalIdentity, or any Q4/Q5 function.
 *     Verified: grep -l of those symbols shows zero matches in resume-merge-recovery.ts.
 *
 * SAFE: read-only, does NOT write any persisted records.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import {
  buildOccurrenceGraph, buildAncestryLedgerRow, isDegraded, normalize, fnv1a,
  detectFactualChanges, computeFactualFingerprint, occKeyStr,
  type OccurrenceGraph, type NodeInput, type DegradedGroupReport,
  type AncestryLedgerRow, type FindingOccurrence,
} from "./oa-ancestry-service.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// Re-export service types for consumer use
export type { OccurrenceGraph, NodeInput, DegradedGroupReport, AncestryLedgerRow };
export { buildOccurrenceGraph, buildAncestryLedgerRow, isDegraded, fnv1a, normalize };

// ---------------------------------------------------------------------------
// Known families & false positives (deterministic matchers)
// ---------------------------------------------------------------------------
const KNOWN_FAMILIES: Array<{ name: string; matcher: (f: CanonicalFinding) => boolean }> = [
  { name: "FCA / section 19 / legacy regulated hire", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("fca") || t.includes("section 19") || t.includes("regulated hire"); } },
  { name: "customer change-of-control", matcher: (f) => { const t = normalize(`${f.title} ${f.detail}`); return t.includes("change") && t.includes("control") && t.includes("customer"); } },
  { name: "supplier change-of-control", matcher: (f) => { const t = normalize(`${f.title} ${f.detail}`); return t.includes("change") && t.includes("control") && t.includes("supplier"); } },
  { name: "One Park Lane", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("one park lane") || t.includes("1 park lane"); } },
  { name: "1954 Act contracting-out", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("1954 act") || t.includes("contracting-out") || t.includes("contracted out"); } },
  { name: "Courts Design / IP assignment", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("courts design") || (t.includes("ip assignment") && t.includes("ipo statement")); } },
  { name: "group trade marks / unregistered trade marks", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("trade mark") || t.includes("trademark") || t.includes("unregistered"); } },
  { name: "GDPR / cookies / consent", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("gdpr") || t.includes("cookie") || t.includes("data protection") || t.includes("consent"); } },
  { name: "stale Legal-DD scope", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("legal dd") && (t.includes("scope") || t.includes("stale") || t.includes("cut-off")); } },
  { name: "restrictive covenants", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("restrictive covenant"); } },
];

const KNOWN_FALSE_POSITIVES: Array<{ label: string; matcher: (f: CanonicalFinding) => boolean }> = [
  { label: "128% vs 55% market-share contradiction", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("128%") && t.includes("55%") && t.includes("market"); } },
  { label: "£19.5m FY25 revenue discrepancy", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("19.5m") && t.includes("fy25") && t.includes("revenue"); } },
  { label: "SIP Calls -34.1 percentage-point margin collapse", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("34.1") && t.includes("sip") && (t.includes("margin") || t.includes("collapse")); } },
  { label: "£19k lease matter rated critical", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("19k") && t.includes("lease") && t.includes("critical"); } },
];

// ---------------------------------------------------------------------------
// Main diagnostic API
// ---------------------------------------------------------------------------
export default api({
  name: "DiagOaAncestry",
  description: "OA-01: Read-only forensic ancestry and finding-inflation diagnostic",

  integrations: { db: postgres(IC_DILIGENCE_DB) },

  input: z.object({
    runId: z.string(),
    moduleId: z.string().default("omission_audit"),
    dealId: z.string().optional(),
  }),

  output: z.object({
    success: z.boolean(), error: z.string().nullable(),
    summary: z.any(), stageReconciliation: z.any(), degradedGroups: z.any(),
    knownFamilies: z.any(), falsePositives: z.any(), lineageEvents: z.any(),
    stats: z.any(), ancestryLedgerSample: z.any(), ancestryLedgerCount: z.number(),
  }),

  async run(ctx, { runId, moduleId, dealId }) {
    const db = ctx.integrations.db;

    // ═══ LOAD DATA ═══
    const AnalysisRowSchema = z.object({ chunk_index: z.coerce.number(), extraction_length: z.coerce.number() });
    const analysisRows = await db.query(
      `SELECT chunk_index, octet_length(COALESCE(result_json->>'extraction', '')) AS extraction_length
       FROM pipeline_analysis WHERE run_id = $1 ORDER BY chunk_index`,
      AnalysisRowSchema, [runId], { label: "OA-01: Load leaf analysis rows" }
    );
    const leafCount = analysisRows.length;

    // Load checkpoints level by level (gRPC 4MB limit)
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete' ORDER BY tree_level`,
      LevelListSchema, [runId], { label: "OA-01: List levels" }
    );

    const CpSchema = z.object({
      tree_level: z.coerce.number(), node_index: z.coerce.number(),
      status: z.string().nullable(), findings_json: z.string(),
      findings_count: z.coerce.number(), payload_bytes: z.coerce.number(),
      checkpoint_id: z.string().nullable(),
    });

    const findingsByLevel = new Map<number, NodeInput[]>();
    let maxLevel = 0;

    for (const { tree_level } of levelRows) {
      const rows = await db.query(
        `SELECT tree_level, node_index, COALESCE(status, 'complete') AS status,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
                jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
                octet_length(merged_json::text) AS payload_bytes,
                id AS checkpoint_id
         FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CpSchema, [runId, tree_level], { label: `OA-01: Load L${tree_level}` }
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
    const OutputSchema = z.object({ id: z.string(), findings_json: z.string(), findings_count: z.coerce.number() });
    const outputRows = await db.query(
      `SELECT mo.id, COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json,
              jsonb_array_length(COALESCE(mo.findings, '[]'::jsonb)) AS findings_count
       FROM module_outputs mo JOIN module_runs mr ON mr.id = mo.module_run_id WHERE mr.id = $1 LIMIT 1`,
      OutputSchema, [runId], { label: "OA-01: Load terminal output" }
    );

    let terminalFindings: CanonicalFinding[] = [];
    if (outputRows.length > 0) {
      try { terminalFindings = JSON.parse(outputRows[0].findings_json); } catch {}
    }

    // ═══ BUILD GRAPH (shared service) ═══
    const graph = buildOccurrenceGraph(findingsByLevel, terminalFindings);

    // Root invariant
    const rootNodes = findingsByLevel.get(maxLevel) ?? [];
    const rootNodeCount = rootNodes.length;
    const rootFindings = rootNodes.flatMap(n => n.findings);

    // ═══ DEGRADED GROUPS (with correct identity separation) ═══
    const degradedGroups: DegradedGroupReport[] = [];
    for (const [level, nodes] of findingsByLevel) {
      const stage = level === maxLevel ? "root" : `L${level}`;
      for (const node of nodes) {
        const degradedFindings = node.findings.filter(isDegraded);
        if (degradedFindings.length === 0) continue;
        const nodeId = `L${level}:N${node.nodeIndex}`;
        const findingIds = degradedFindings.map(f => f.finding_id);
        // Collect terminal descendant occurrence keys via occurrence-level traversal
        const termDescOccKeys: string[] = [];
        const termDescFindingIds: string[] = [];
        for (const df of degradedFindings) {
          const dfOccs = graph.byFindingId.get(df.finding_id) ?? [];
          for (const dfOcc of dfOccs) {
            const termOccs = graph.getTerminalDescendantOccurrences(occKeyStr(dfOcc.key));
            for (const tk of termOccs) {
              termDescOccKeys.push(tk);
              const termO = graph.byOccKey.get(tk);
              if (termO) termDescFindingIds.push(termO.key.findingId);
            }
          }
        }
        const uniqueTermDescFindingIds = [...new Set(termDescFindingIds)].sort();
        degradedGroups.push({
          diagnostic_node_group_id: nodeId,
          persisted_degraded_group_id: node.checkpointId ?? null,
          degraded_group_identity_source: node.checkpointId ? "persisted_checkpoint_id" : "diagnostic_level_node",
          stage, finding_count: degradedFindings.length, finding_ids: findingIds,
          occurrence_keys: degradedFindings.flatMap(df => (graph.byFindingId.get(df.finding_id) ?? []).map(o => occKeyStr(o.key))),
          terminal_descendant_occurrence_keys: [...new Set(termDescOccKeys)].sort(),
          terminal_descendant_finding_ids: uniqueTermDescFindingIds,
          reconstructable: degradedFindings.every(f => (f.merged_from_finding_ids ?? []).length > 0),
          non_reconstructable_reason: degradedFindings.some(f => (f.merged_from_finding_ids ?? []).length === 0)
            ? "no_merged_from_ids_persisted" : null,
        });
      }
    }

    // ═══ STAGE RECONCILIATION ═══
    interface StageRecon { stage: string; output_containers: number; finding_rows: number; unique_finding_ids: number; unique_proposition_keys: number; orphan_rows: number; new_propositions_issue_key: number; new_propositions_factual: number; degraded_rows: number; }
    const stageRecon: StageRecon[] = [];
    stageRecon.push({ stage: "leaf", output_containers: leafCount, finding_rows: 0, unique_finding_ids: 0, unique_proposition_keys: 0, orphan_rows: 0, new_propositions_issue_key: 0, new_propositions_factual: 0, degraded_rows: 0 });

    const prevIssueKeys = new Set<string>();
    const prevFactualHashes = new Set<string>();

    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const nodesAtLevel = findingsByLevel.get(lvl) ?? [];
      const allFindings = nodesAtLevel.flatMap(n => n.findings);
      const stage = lvl === maxLevel ? "root" : `L${lvl}`;
      const uniqueIds = new Set(allFindings.map(f => f.finding_id));
      const uniqueKeys = new Set(allFindings.map(f => f.issue_key).filter(Boolean));
      let orphans = 0;
      for (const f of allFindings) {
        for (const pid of f.merged_from_finding_ids ?? []) {
          if (!graph.byFindingId.has(pid)) orphans++;
        }
      }
      const newIssueKeyCount = allFindings.filter(f => f.issue_key && !prevIssueKeys.has(f.issue_key)).length;
      const newFactualCount = allFindings.filter(f => { const fp = computeFactualFingerprint(f); return !prevFactualHashes.has(fp.hash); }).length;
      for (const f of allFindings) {
        if (f.issue_key) prevIssueKeys.add(f.issue_key);
        prevFactualHashes.add(computeFactualFingerprint(f).hash);
      }
      stageRecon.push({ stage, output_containers: nodesAtLevel.length, finding_rows: allFindings.length, unique_finding_ids: uniqueIds.size, unique_proposition_keys: uniqueKeys.size, orphan_rows: orphans, new_propositions_issue_key: newIssueKeyCount, new_propositions_factual: newFactualCount, degraded_rows: allFindings.filter(isDegraded).length });
    }
    stageRecon.push({ stage: "terminal", output_containers: outputRows.length, finding_rows: terminalFindings.length, unique_finding_ids: new Set(terminalFindings.map(f => f.finding_id)).size, unique_proposition_keys: new Set(terminalFindings.map(f => f.issue_key).filter(Boolean)).size, orphan_rows: 0, new_propositions_issue_key: 0, new_propositions_factual: 0, degraded_rows: terminalFindings.filter(isDegraded).length });

    // ═══ LINEAGE EVENTS (multi-dimensional) ═══
    const lineageEvents: any[] = [];
    for (const [fid, occs] of graph.byFindingId) {
      if (occs.length < 2) continue;
      const sorted = [...occs].sort((a, b) => a.key.level - b.key.level);
      for (let i = 1; i < sorted.length; i++) {
        const changes = detectFactualChanges(sorted[i - 1].finding, sorted[i].finding);
        for (const ch of changes) {
          lineageEvents.push({ finding_id: fid, event_type: ch.type, first_stage: sorted[i].key.stage, details: ch.details });
        }
      }
    }
    // Parentless above L1
    for (const [fid, occs] of graph.byFindingId) {
      const minLevel = Math.min(...occs.map(o => o.key.level));
      if (minLevel > 1 && (!graph.findingIdChildToParents.has(fid) || graph.findingIdChildToParents.get(fid)!.size === 0)) {
        lineageEvents.push({ finding_id: fid, event_type: "parentless_occurrence", first_stage: occs.find(o => o.key.level === minLevel)?.key.stage, details: "No merged_from_finding_ids" });
      }
    }
    // One-to-many splits
    for (const [pid, children] of graph.findingIdParentToChildren) {
      if (children.size <= 1) continue;
      const childTitles = new Set<string>();
      for (const cid of children) { const co = graph.byFindingId.get(cid); if (co?.[0]) childTitles.add(normalize(co[0].finding.title)); }
      if (childTitles.size > 1) {
        const po = graph.byFindingId.get(pid);
        lineageEvents.push({ finding_id: pid, event_type: "one_to_many_split", first_stage: po?.[0]?.key.stage ?? "unknown", details: `Split into ${children.size} propositions` });
      }
    }

    // ═══ KNOWN FAMILIES & FALSE POSITIVES ═══
    const knownFamilies: any[] = [];
    for (const family of KNOWN_FAMILIES) {
      const matchIds: string[] = []; const propositions: string[] = [];
      const countByStage: Record<string, number> = {}; const propKeys = new Set<string>();
      const termIds: string[] = []; let degraded = false;
      for (const occ of graph.allOccurrences) {
        if (family.matcher(occ.finding)) {
          matchIds.push(occKeyStr(occ.key));
          propositions.push(occ.finding.title);
          countByStage[occ.key.stage] = (countByStage[occ.key.stage] ?? 0) + 1;
          if (occ.finding.issue_key) propKeys.add(occ.finding.issue_key);
          if (occ.degraded) degraded = true;
          if (occ.key.stage === "terminal") termIds.push(occ.key.findingId);
        }
      }
      if (matchIds.length > 0) {
        let firstMult: string | null = null;
        for (const s of ["L1", "L2", "L3", "L4", "L5", "root", "terminal"]) { if ((countByStage[s] ?? 0) > 1) { firstMult = s; break; } }
        knownFamilies.push({ family_name: family.name, matching_occurrence_ids: matchIds.slice(0, 50), exact_propositions: [...new Set(propositions)].slice(0, 20), count_by_stage: countByStage, unique_proposition_keys: [...propKeys], first_multiplication_stage: firstMult, terminal_finding_ids: termIds, degraded_fallback_involvement: degraded });
      }
    }

    const falsePositives: any[] = [];
    for (const fp of KNOWN_FALSE_POSITIVES) {
      const matchIds: string[] = []; let firstStage: string | null = null; let proposition: string | null = null; let termId: string | null = null; const evidence: string[] = [];
      for (const occ of graph.allOccurrences) {
        if (fp.matcher(occ.finding)) {
          matchIds.push(occ.key.findingId);
          if (!firstStage) { firstStage = occ.key.stage; proposition = occ.finding.title; }
          if (occ.key.stage === "terminal") termId = occ.key.findingId;
          if (occ.finding.source_docs) evidence.push(...occ.finding.source_docs);
        }
      }
      falsePositives.push({ label: fp.label, matching_finding_ids: [...new Set(matchIds)], exact_proposition: proposition, source_evidence_lineage: [...new Set(evidence)].slice(0, 5), first_stage_present: firstStage, originated_at_leaf: firstStage === "L1" ? true : firstStage ? false : null, changed_fields: [], terminal_finding_id: termId });
    }

    // ═══ ANCESTRY LEDGER + STATS ═══
    const terminalOccsFull = graph.allOccurrences.filter(o => o.key.stage === "terminal");

    const ancestryRows: AncestryLedgerRow[] = [];
    const terminalOccsSample = terminalOccsFull.slice(0, 50);
    for (let i = 0; i < terminalOccsSample.length; i++) {
      ancestryRows.push(buildAncestryLedgerRow(terminalOccsSample[i], graph, runId, dealId ?? null, moduleId, i));
    }

    let tracesToLeaf = 0, generated = 0, broken = 0, cycleCount = 0, ambiguous = 0;
    for (const occ of terminalOccsFull) {
      const cls = graph.classifyOccurrence(occKeyStr(occ.key));
      if (cls === "traces_to_leaf") tracesToLeaf++;
      else if (cls === "generated_without_parent") generated++;
      else if (cls === "broken_parent_reference") broken++;
      else if (cls === "cycle_detected") cycleCount++;
      else ambiguous++;
    }
    const l1Nodes = findingsByLevel.get(1) ?? [];
    const l1Counts = l1Nodes.map(n => n.findings.length);
    const l1Total = l1Counts.reduce((s, c) => s + c, 0);
    const sorted = [...l1Counts].sort((a, b) => a - b);

    const stats = {
      leaf_analysis_outputs: leafCount,
      l1_nodes: l1Nodes.length, l1_total_findings: l1Total,
      l1_findings_min: sorted[0] ?? 0, l1_findings_max: sorted[sorted.length - 1] ?? 0,
      l1_findings_median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      root_nodes_at_max_level: rootNodeCount, root_findings: rootFindings.length,
      terminal_findings: terminalFindings.length, terminal_degraded: terminalFindings.filter(isDegraded).length,
      traces_to_leaf: tracesToLeaf, generated_without_parent: generated,
      broken_parent_reference: broken, cycle_detected: cycleCount, ambiguous_lineage: ambiguous,
      degraded_groups_from_data: degradedGroups.length,
      degraded_groups_distinct_findings: degradedGroups.reduce((s, g) => s + g.finding_count, 0),
      total_levels: maxLevel, identity_path: "legacy_merge_recovery",
      identity_path_entrypoints: [
        { file: "server/apis/pipeline/resume-merge-recovery.ts", api: "ResumeMergeRecovery", role: "merge orchestrator" },
        { file: "server/apis/pipeline/resume-merge-recovery.ts", function: "processLevel1Node", role: "L1 generative extraction" },
        { file: "server/apis/pipeline/resume-merge-recovery.ts", function: "consolidateFindings", role: "L2+ dedup merge" },
        { file: "server/apis/pipeline/resume-merge-recovery.ts", function: "processSplitNode", role: "split >6 findings" },
        { file: "server/apis/pipeline/diagnostic-finalization.ts", api: "DiagnosticFinalization", role: "terminal consumer" },
      ],
      identity_path_not_invoked: [
        { file: "server/apis/pipeline/q5-production-stage.ts", reason: "not imported by resume-merge-recovery.ts" },
        { file: "server/apis/pipeline/finding-identity.ts", reason: "not imported by resume-merge-recovery.ts" },
        { file: "server/apis/pipeline/replay-canonical-identity.ts", reason: "not imported by resume-merge-recovery.ts" },
      ],
      uses_f04_q4_q5: false,
    };

    const summary = {
      question_1_leaf_findings: `${leafCount} leaf analysis outputs = RAW TEXT. First structured findings at L1: ${l1Total} across ${l1Nodes.length} nodes.`,
      question_2_no_leaf_trace: `${generated} generated_without_parent, ${broken} broken_parent_reference, ${cycleCount} cycle_detected, ${ambiguous} ambiguous_lineage.`,
      question_3_duplicate_families: knownFamilies.filter((f: any) => f.first_multiplication_stage).map((f: any) => `"${f.family_name}": multiplies at ${f.first_multiplication_stage}`).join("; ") || "None",
      question_4_factual_changes: `${lineageEvents.filter((e: any) => e.event_type === "title_changed").length} title changes, ${lineageEvents.filter((e: any) => e.event_type === "factual_payload_changed").length} factual payload changes, ${lineageEvents.filter((e: any) => e.event_type === "issue_key_changed").length} issue_key changes.`,
      question_5_degraded_fallback: `${degradedGroups.length} degraded groups from data. ${degradedGroups.filter(g => g.persisted_degraded_group_id).length} have persisted checkpoint IDs.`,
      question_6_identity_path: `LEGACY path: ResumeMergeRecovery. Root nodes: ${rootNodeCount}. Q4/Q5 NOT invoked (verified: not imported).`,
    };

    return {
      success: true, error: null, summary, stageReconciliation: stageRecon,
      degradedGroups, knownFamilies, falsePositives,
      lineageEvents: lineageEvents.slice(0, 200), stats,
      ancestryLedgerSample: ancestryRows, ancestryLedgerCount: terminalFindings.length,
    };
  },
});

