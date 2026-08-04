/**
 * OA-01: Forensic Ancestry & Finding-Inflation Diagnostic
 *
 * A deterministic, read-only diagnostic that traces every finding occurrence
 * from leaf analysis through every merge level to the root/terminal artifact.
 *
 * Key principles:
 * - Reads ONLY persisted data; never modifies anything
 * - Does NOT call LLM or regenerate anything
 * - Does NOT change any production finding behavior
 * - Deterministic: re-running produces stable results
 * - Exposes all missing fields with machine-readable reasons
 *
 * Live path (omission_audit):
 *   1. pipeline_analysis.result_json.extraction → raw text (NOT findings)
 *   2. merge_checkpoints level=1 → L1 findings (LLM-extracted from text)
 *   3. merge_checkpoints level=2..N → consolidated/split findings
 *   4. merge_checkpoints max(level) → root findings
 *   5. module_outputs.findings → terminal/final artifact
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
 *   Evidence: ResumeMergeRecovery uses parseCanonicalFindings in "fresh" mode
 *     (assigns new UUID v4 at L1), NOT "reload". It does NOT call
 *     canonicalizeIdentity() or any Q4/Q5 function.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row in the ancestry ledger */
export interface AncestryRow {
  run_id: string;
  deal_id: string | null;
  module_id: string;
  stage: string;
  analysis_node_id: string | null;
  stage_occurrence_id: string;
  occurrence_index: number;
  finding_id: string;
  all_leaf_ancestor_ids: string[];
  source_proposition: string | null;
  normalized_proposition_hash: string;
  persisted_canonical_key: string | null;
  canonical_key_origin: "legacy" | "missing";
  claim_ids: string[];
  disclosure_ids: string[];
  evidence_ids: string[];
  source_document_ids: string[];
  source_coordinates: string[];
  severity: string;
  reportability: string;
  parent_ids: string[];
  child_ids: string[];
  merge_level: number;
  representative_member: string | null;
  first_stage_appeared: string;
  degraded_fallback_flag: boolean;
  degraded_fallback_group_id: string | null;
  terminal_descendant_ids: string[];
  raw_payload_hash: string;
  lineage_status: "traces_to_leaf" | "generated_without_parent" | "broken_parent_reference" | "cycle_detected" | "ambiguous_lineage";
  missing_field_reasons: Record<string, string>;
}

/** Stage reconciliation row */
export interface StageReconciliation {
  stage: string;
  output_containers: number;
  finding_rows: number;
  unique_finding_ids: number;
  unique_proposition_keys: number;
  orphan_rows: number;
  new_propositions_issue_key: number;
  new_propositions_factual: number;
  degraded_rows: number;
}

/** Degraded group report */
export interface DegradedGroupReport {
  group_id: string;
  persisted_node_id: string;
  stage: string;
  finding_count: number;
  finding_ids: string[];
  terminal_descendant_ids: string[];
  reconstructable: boolean;
  non_reconstructable_reason: string | null;
}

/** Known family report */
export interface KnownFamilyReport {
  family_name: string;
  matching_occurrence_ids: string[];
  exact_propositions: string[];
  count_by_stage: Record<string, number>;
  unique_proposition_keys: string[];
  first_multiplication_stage: string | null;
  terminal_finding_ids: string[];
  degraded_fallback_involvement: boolean;
}

/** Known false-positive trace */
export interface FalsePositiveTrace {
  label: string;
  matching_finding_ids: string[];
  exact_proposition: string | null;
  source_evidence_lineage: string[];
  first_stage_present: string | null;
  originated_at_leaf: boolean | null;
  changed_fields: string[];
  terminal_finding_id: string | null;
}

/** Lineage change event (deterministic, multi-dimensional) */
export interface LineageEvent {
  finding_id: string;
  event_type: "new_issue_key" | "changed_normalized_proposition" | "new_finding_id" | "parentless_occurrence" | "proposition_change_with_lineage" | "insufficient_persisted_data" | "one_to_many_split" | "occurrence_growth";
  first_stage: string;
  details: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple FNV-1a hash for deterministic locators */
function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Normalize text for comparison (lowercase, trim, collapse whitespace) */
function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Extract numbers from text */
function extractNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(/[-£$€]?\d[\d,]*\.?\d*[%kKmMbB]?/g);
  return matches ?? [];
}

/** Check degraded fallback properly — direct string comparison */
function isDegraded(f: CanonicalFinding): boolean {
  return (f as any)._recovery_status === "degraded_fallback" ||
         (f as any)._recovery_status === "merge_contract_fallback";
}

// ---------------------------------------------------------------------------
// Core ancestry graph builder — exported for test reuse
// ---------------------------------------------------------------------------

export interface FindingLocation {
  level: number;
  nodeIndex: number;
  finding: CanonicalFinding;
  stage: string;
  degraded: boolean;
}

export interface AncestryGraph {
  globalIndex: Map<string, FindingLocation[]>;
  parentToChildren: Map<string, Set<string>>;
  childToParents: Map<string, Set<string>>;
  maxLevel: number;
  /** Trace all reachable leaf IDs (deduplicated, sorted), detect cycles */
  traceAllLeaves(findingId: string): { leafIds: string[]; cycleDetected: boolean; missingParents: string[] };
  /** Classify lineage status */
  classifyFinding(findingId: string): AncestryRow["lineage_status"];
  /** Get terminal descendants of a finding */
  getTerminalDescendants(findingId: string): string[];
}

export function buildAncestryGraph(
  findingsByLevel: Map<number, Array<{ nodeIndex: number; findings: CanonicalFinding[] }>>,
  terminalFindings: CanonicalFinding[] = []
): AncestryGraph {
  const globalIndex = new Map<string, FindingLocation[]>();
  const maxLevel = Math.max(...findingsByLevel.keys(), 0);

  for (const [level, nodes] of findingsByLevel) {
    const stage = level === maxLevel ? "root" : `L${level}`;
    for (const node of nodes) {
      for (const f of node.findings) {
        const locs = globalIndex.get(f.finding_id) ?? [];
        locs.push({ level, nodeIndex: node.nodeIndex, finding: f, stage, degraded: isDegraded(f) });
        globalIndex.set(f.finding_id, locs);
      }
    }
  }

  // Index terminal findings
  for (const f of terminalFindings) {
    const locs = globalIndex.get(f.finding_id) ?? [];
    locs.push({ level: maxLevel + 1, nodeIndex: 0, finding: f, stage: "terminal", degraded: isDegraded(f) });
    globalIndex.set(f.finding_id, locs);
  }

  // Build parent→child and child→parent maps
  const parentToChildren = new Map<string, Set<string>>();
  const childToParents = new Map<string, Set<string>>();

  for (const [fid, locs] of globalIndex) {
    for (const loc of locs) {
      const parents = loc.finding.merged_from_finding_ids ?? [];
      for (const pid of parents) {
        let kids = parentToChildren.get(pid);
        if (!kids) { kids = new Set(); parentToChildren.set(pid, kids); }
        kids.add(fid);

        let pSet = childToParents.get(fid);
        if (!pSet) { pSet = new Set(); childToParents.set(fid, pSet); }
        pSet.add(pid);
      }
    }
  }

  // Trace all leaves with cycle detection
  function traceAllLeaves(findingId: string): { leafIds: string[]; cycleDetected: boolean; missingParents: string[] } {
    const leafIds = new Set<string>();
    const missingParents: string[] = [];
    let cycleDetected = false;
    const visited = new Set<string>();

    function dfs(fid: string): void {
      if (visited.has(fid)) { cycleDetected = true; return; }
      visited.add(fid);

      const locs = globalIndex.get(fid);
      if (!locs || locs.length === 0) {
        missingParents.push(fid);
        return;
      }

      const minLevel = Math.min(...locs.map(l => l.level));
      if (minLevel === 1) { leafIds.add(fid); return; }

      const parents = childToParents.get(fid);
      if (!parents || parents.size === 0) {
        if (minLevel === 1) leafIds.add(fid);
        return;
      }

      for (const pid of parents) {
        if (!globalIndex.has(pid)) {
          missingParents.push(pid);
        } else {
          dfs(pid);
        }
      }
    }

    dfs(findingId);
    const sorted = [...leafIds].sort();
    return { leafIds: sorted, cycleDetected, missingParents: [...new Set(missingParents)] };
  }

  function classifyFinding(fid: string): AncestryRow["lineage_status"] {
    const { leafIds, cycleDetected, missingParents } = traceAllLeaves(fid);
    if (cycleDetected) return "cycle_detected";
    if (leafIds.length > 0) return "traces_to_leaf";

    const parents = childToParents.get(fid);
    const locs = globalIndex.get(fid);
    const minLevel = locs ? Math.min(...locs.map(l => l.level)) : 99;

    if (!parents || parents.size === 0) {
      if (minLevel <= 1) return "traces_to_leaf";
      return "generated_without_parent";
    }
    if (missingParents.length > 0) return "broken_parent_reference";
    return "ambiguous_lineage";
  }

  function getTerminalDescendants(fid: string): string[] {
    const termIds = new Set<string>();
    const visited = new Set<string>();
    function dfs(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      const locs = globalIndex.get(id);
      if (locs?.some(l => l.stage === "terminal")) { termIds.add(id); }
      const kids = parentToChildren.get(id);
      if (kids) for (const kid of kids) dfs(kid);
    }
    dfs(fid);
    return [...termIds].sort();
  }

  return { globalIndex, parentToChildren, childToParents, maxLevel, traceAllLeaves, classifyFinding, getTerminalDescendants };
}

// ---------------------------------------------------------------------------
// Known family matchers (keyword-based, deterministic)
// ---------------------------------------------------------------------------
const KNOWN_FAMILIES: Array<{ name: string; matcher: (f: CanonicalFinding) => boolean }> = [
  { name: "FCA / section 19 / legacy regulated hire", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("fca") || t.includes("section 19") || t.includes("regulated hire"); } },
  { name: "customer change-of-control", matcher: (f) => { const t = normalize(`${f.title} ${f.detail}`); return (t.includes("change") && t.includes("control") && t.includes("customer")); } },
  { name: "supplier change-of-control", matcher: (f) => { const t = normalize(`${f.title} ${f.detail}`); return t.includes("change") && t.includes("control") && t.includes("supplier"); } },
  { name: "One Park Lane", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("one park lane") || t.includes("1 park lane"); } },
  { name: "1954 Act contracting-out", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("1954 act") || t.includes("contracting-out") || t.includes("contracted out"); } },
  { name: "Courts Design / IP assignment", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("courts design") || (t.includes("ip assignment") && t.includes("ipo statement")); } },
  { name: "group trade marks / unregistered trade marks", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("trade mark") || t.includes("trademark") || t.includes("unregistered"); } },
  { name: "GDPR / cookies / consent", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("gdpr") || t.includes("cookie") || t.includes("data protection") || t.includes("consent"); } },
  { name: "stale Legal-DD scope", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("legal dd") && (t.includes("scope") || t.includes("stale") || t.includes("cut-off")); } },
  { name: "restrictive covenants", matcher: (f) => { const t = normalize(`${f.title} ${f.detail} ${f.full_analysis}`); return t.includes("restrictive covenant"); } },
];

// ---------------------------------------------------------------------------
// Known false-positive matchers
// ---------------------------------------------------------------------------
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
    summary: z.any(),
    stageReconciliation: z.any(),
    degradedGroups: z.any(),
    knownFamilies: z.any(),
    falsePositives: z.any(),
    lineageEvents: z.any(),
    stats: z.any(),
    ancestryLedgerSample: z.any(),
    ancestryLedgerCount: z.number(),
  }),

  async run(ctx, { runId, moduleId, dealId }) {
    const db = ctx.integrations.db;

    // ═══ PHASE 1: Load all persisted data ═══
    const AnalysisRowSchema = z.object({ chunk_index: z.coerce.number(), extraction_length: z.coerce.number() });
    const analysisRows = await db.query(
      `SELECT chunk_index, octet_length(COALESCE(result_json->>'extraction', '')) AS extraction_length
       FROM pipeline_analysis WHERE run_id = $1 ORDER BY chunk_index`,
      AnalysisRowSchema, [runId], { label: "OA-01: Load leaf analysis rows" }
    );
    const leafCount = analysisRows.length;

    // Load merge checkpoints LEVEL BY LEVEL (gRPC 4MB limit)
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete' ORDER BY tree_level`,
      LevelListSchema, [runId], { label: "OA-01: List distinct merge levels" }
    );

    const CheckpointSchema = z.object({
      tree_level: z.coerce.number(), node_index: z.coerce.number(),
      status: z.string().nullable(), findings_json: z.string(),
      findings_count: z.coerce.number(), payload_bytes: z.coerce.number(),
    });

    interface CheckpointRow { tree_level: number; node_index: number; status: string | null; findings_json: string; findings_count: number; payload_bytes: number; }
    const checkpoints: CheckpointRow[] = [];

    for (const { tree_level } of levelRows) {
      const lvlCps = await db.query(
        `SELECT tree_level, node_index, COALESCE(status, 'complete') AS status,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
                jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
                octet_length(merged_json::text) AS payload_bytes
         FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CheckpointSchema, [runId, tree_level], { label: `OA-01: Load L${tree_level}` }
      );
      checkpoints.push(...lvlCps);
    }

    // Load terminal output
    const OutputSchema = z.object({ id: z.string(), findings_json: z.string(), findings_count: z.coerce.number() });
    const outputRows = await db.query(
      `SELECT mo.id, COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json,
              jsonb_array_length(COALESCE(mo.findings, '[]'::jsonb)) AS findings_count
       FROM module_outputs mo JOIN module_runs mr ON mr.id = mo.module_run_id WHERE mr.id = $1 LIMIT 1`,
      OutputSchema, [runId], { label: "OA-01: Load terminal output" }
    );

    // ═══ PHASE 2: Parse findings by level ═══
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
    if (outputRows.length > 0) {
      try { terminalFindings = JSON.parse(outputRows[0].findings_json) as CanonicalFinding[]; } catch {}
    }

    // ═══ PHASE 3: Build ancestry graph (reconcile ALL max-level nodes) ═══
    const graph = buildAncestryGraph(findingsByLevel, terminalFindings);

    // Verify root invariant: report ALL nodes at max level
    const rootNodes = findingsByLevel.get(maxLevel) ?? [];
    const rootNodeCount = rootNodes.length;
    const rootFindings = rootNodes.flatMap(n => n.findings);

    // ═══ PHASE 4: Derive degraded groups from persisted data ═══
    const degradedGroups: DegradedGroupReport[] = [];
    for (const [level, nodes] of findingsByLevel) {
      const stage = level === maxLevel ? "root" : `L${level}`;
      for (const node of nodes) {
        const degradedFindings = node.findings.filter(isDegraded);
        if (degradedFindings.length === 0) continue;
        const nodeId = `L${level}:N${node.nodeIndex}`;
        const findingIds = degradedFindings.map(f => f.finding_id);
        const termDescendants: string[] = [];
        for (const fid of findingIds) {
          termDescendants.push(...graph.getTerminalDescendants(fid));
        }
        const uniqueTermDescendants = [...new Set(termDescendants)].sort();
        degradedGroups.push({
          group_id: nodeId,
          persisted_node_id: nodeId,
          stage,
          finding_count: degradedFindings.length,
          finding_ids: findingIds,
          terminal_descendant_ids: uniqueTermDescendants,
          reconstructable: degradedFindings.every(f => (f.merged_from_finding_ids ?? []).length > 0),
          non_reconstructable_reason: degradedFindings.some(f => (f.merged_from_finding_ids ?? []).length === 0)
            ? "no_merged_from_ids_persisted" : null,
        });
      }
    }

    // ═══ PHASE 5: Stage reconciliation ═══
    const stageRecon: StageReconciliation[] = [];

    stageRecon.push({ stage: "leaf", output_containers: leafCount, finding_rows: 0, unique_finding_ids: 0, unique_proposition_keys: 0, orphan_rows: 0, new_propositions_issue_key: 0, new_propositions_factual: 0, degraded_rows: 0 });

    const prevNormProps = new Set<string>();
    const prevIssueKeys = new Set<string>();

    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const nodesAtLevel = findingsByLevel.get(lvl) ?? [];
      const allFindings = nodesAtLevel.flatMap(n => n.findings);
      const stage = lvl === maxLevel ? "root" : `L${lvl}`;

      const uniqueIds = new Set(allFindings.map(f => f.finding_id));
      const uniqueKeys = new Set(allFindings.map(f => f.issue_key).filter(Boolean));

      let orphans = 0;
      for (const f of allFindings) {
        for (const pid of f.merged_from_finding_ids ?? []) {
          if (!graph.globalIndex.has(pid)) orphans++;
        }
      }

      // New issue_key not seen at prior levels
      const newIssueKeyCount = allFindings.filter(f => f.issue_key && !prevIssueKeys.has(f.issue_key)).length;
      // New factual proposition (normalized title) not seen at prior levels
      const newFactualCount = allFindings.filter(f => {
        const normProp = normalize(f.title);
        return normProp && !prevNormProps.has(normProp);
      }).length;

      // Update prev sets for next level
      for (const f of allFindings) {
        if (f.issue_key) prevIssueKeys.add(f.issue_key);
        const np = normalize(f.title);
        if (np) prevNormProps.add(np);
      }

      const degradedCount = allFindings.filter(isDegraded).length;

      stageRecon.push({
        stage, output_containers: nodesAtLevel.length, finding_rows: allFindings.length,
        unique_finding_ids: uniqueIds.size, unique_proposition_keys: uniqueKeys.size,
        orphan_rows: orphans, new_propositions_issue_key: newIssueKeyCount,
        new_propositions_factual: newFactualCount, degraded_rows: degradedCount,
      });
    }

    // Terminal stage
    stageRecon.push({
      stage: "terminal", output_containers: outputRows.length,
      finding_rows: terminalFindings.length,
      unique_finding_ids: new Set(terminalFindings.map(f => f.finding_id)).size,
      unique_proposition_keys: new Set(terminalFindings.map(f => f.issue_key).filter(Boolean)).size,
      orphan_rows: 0, new_propositions_issue_key: 0, new_propositions_factual: 0,
      degraded_rows: terminalFindings.filter(isDegraded).length,
    });

    // ═══ PHASE 6: Lineage events (deterministic, multi-dimensional) ═══
    const lineageEvents: LineageEvent[] = [];

    for (const [fid, locs] of graph.globalIndex) {
      if (locs.length < 2) continue;
      const sorted = [...locs].sort((a, b) => a.level - b.level);

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];

        // Normalized proposition change
        const prevNorm = normalize(prev.finding.title);
        const currNorm = normalize(curr.finding.title);
        if (prevNorm && currNorm && prevNorm !== currNorm) {
          lineageEvents.push({ finding_id: fid, event_type: "changed_normalized_proposition", first_stage: curr.stage,
            details: `"${prev.finding.title?.slice(0, 50)}" → "${curr.finding.title?.slice(0, 50)}"` });
        }

        // New issue_key assigned (but proposition may be same)
        if (curr.finding.issue_key && !prev.finding.issue_key) {
          lineageEvents.push({ finding_id: fid, event_type: "new_issue_key", first_stage: curr.stage,
            details: `issue_key assigned: "${curr.finding.issue_key}"` });
        }
      }
    }

    // Parentless occurrences above L1
    for (const [fid, locs] of graph.globalIndex) {
      const minLevel = Math.min(...locs.map(l => l.level));
      if (minLevel > 1) {
        const parents = graph.childToParents.get(fid);
        if (!parents || parents.size === 0) {
          const stage = locs.find(l => l.level === minLevel)?.stage ?? `L${minLevel}`;
          lineageEvents.push({ finding_id: fid, event_type: "parentless_occurrence", first_stage: stage,
            details: `Appears at ${stage} with no merged_from_finding_ids` });
        }
      }
    }

    // One-to-many splits
    for (const [pid, children] of graph.parentToChildren) {
      if (children.size <= 1) continue;
      const childNormTitles = new Set<string>();
      for (const cid of children) {
        const clocs = graph.globalIndex.get(cid);
        if (clocs && clocs.length > 0) childNormTitles.add(normalize(clocs[0].finding.title));
      }
      if (childNormTitles.size > 1) {
        const parentLocs = graph.globalIndex.get(pid);
        const stage = parentLocs?.[0]?.stage ?? "unknown";
        lineageEvents.push({ finding_id: pid, event_type: "one_to_many_split", first_stage: stage,
          details: `Split into ${children.size} distinct propositions` });
      }
    }

    // Occurrence growth by issue_key
    const keyCountByLevel = new Map<string, Map<number, number>>();
    for (const [level, nodes] of findingsByLevel) {
      for (const node of nodes) {
        for (const f of node.findings) {
          if (!f.issue_key) continue;
          let lm = keyCountByLevel.get(f.issue_key);
          if (!lm) { lm = new Map(); keyCountByLevel.set(f.issue_key, lm); }
          lm.set(level, (lm.get(level) ?? 0) + 1);
        }
      }
    }
    for (const [key, lm] of keyCountByLevel) {
      const levels = [...lm.entries()].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i][1] > levels[i - 1][1]) {
          lineageEvents.push({ finding_id: key, event_type: "occurrence_growth", first_stage: `L${levels[i][0]}`,
            details: `"${key}" grew from ${levels[i - 1][1]} to ${levels[i][1]}` });
          break;
        }
      }
    }

    // ═══ PHASE 7: Known families ═══
    const knownFamilies: KnownFamilyReport[] = [];
    for (const family of KNOWN_FAMILIES) {
      const matchIds: string[] = [];
      const propositions: string[] = [];
      const countByStage: Record<string, number> = {};
      const propKeys = new Set<string>();
      const termIds: string[] = [];
      let degraded = false;

      for (const [fid, locs] of graph.globalIndex) {
        for (const loc of locs) {
          if (family.matcher(loc.finding)) {
            matchIds.push(`${loc.stage}:${fid}`);
            propositions.push(loc.finding.title);
            countByStage[loc.stage] = (countByStage[loc.stage] ?? 0) + 1;
            if (loc.finding.issue_key) propKeys.add(loc.finding.issue_key);
            if (loc.degraded) degraded = true;
            if (loc.stage === "terminal") termIds.push(fid);
          }
        }
      }

      let firstMult: string | null = null;
      const stageOrder = ["L1", "L2", "L3", "L4", "L5", "root", "terminal"];
      for (const s of stageOrder) { if ((countByStage[s] ?? 0) > 1) { firstMult = s; break; } }

      if (matchIds.length > 0) {
        knownFamilies.push({
          family_name: family.name, matching_occurrence_ids: matchIds.slice(0, 50),
          exact_propositions: [...new Set(propositions)].slice(0, 20),
          count_by_stage: countByStage, unique_proposition_keys: [...propKeys],
          first_multiplication_stage: firstMult, terminal_finding_ids: termIds,
          degraded_fallback_involvement: degraded,
        });
      }
    }

    // ═══ PHASE 8: Known false positives ═══
    const falsePositives: FalsePositiveTrace[] = [];
    for (const fp of KNOWN_FALSE_POSITIVES) {
      const matchIds: string[] = [];
      let firstStage: string | null = null;
      let proposition: string | null = null;
      let termId: string | null = null;
      const evidence: string[] = [];

      for (const [fid, locs] of graph.globalIndex) {
        for (const loc of locs) {
          if (fp.matcher(loc.finding)) {
            matchIds.push(fid);
            if (!firstStage) { firstStage = loc.stage; proposition = loc.finding.title; }
            if (loc.stage === "terminal") termId = fid;
            if (loc.finding.source_docs) evidence.push(...loc.finding.source_docs);
          }
        }
      }

      falsePositives.push({
        label: fp.label, matching_finding_ids: [...new Set(matchIds)],
        exact_proposition: proposition, source_evidence_lineage: [...new Set(evidence)].slice(0, 5),
        first_stage_present: firstStage, originated_at_leaf: firstStage === "L1" ? true : firstStage ? false : null,
        changed_fields: [], terminal_finding_id: termId,
      });
    }

    // ═══ PHASE 9: Ancestry ledger sample (first 50 terminal findings) ═══
    const ancestryRows: AncestryRow[] = [];
    let occurrenceIdx = 0;
    for (const f of terminalFindings.slice(0, 50)) {
      const locs = graph.globalIndex.get(f.finding_id) ?? [];
      const { leafIds, cycleDetected, missingParents } = graph.traceAllLeaves(f.finding_id);
      const classification = graph.classifyFinding(f.finding_id);
      const parents = [...(graph.childToParents.get(f.finding_id) ?? [])];
      const children = [...(graph.parentToChildren.get(f.finding_id) ?? [])];
      const termDescendants = graph.getTerminalDescendants(f.finding_id);
      const degraded = locs.some(l => l.degraded) || isDegraded(f);
      const sortedLocs = [...locs].sort((a, b) => a.level - b.level);
      const firstStage = sortedLocs.length > 0 ? sortedLocs[0].stage : "terminal";

      // Determine degraded group: find the node where this finding is tagged degraded
      let degradedGroupId: string | null = null;
      if (degraded) {
        const degradedLoc = locs.find(l => l.degraded);
        if (degradedLoc) degradedGroupId = `L${degradedLoc.level}:N${degradedLoc.nodeIndex}`;
      }

      const missingReasons: Record<string, string> = {};
      if (leafIds.length === 0 && classification !== "traces_to_leaf") missingReasons.all_leaf_ancestor_ids = "no_leaf_ancestor_traced";
      if (!f.issue_key) missingReasons.persisted_canonical_key = "not_assigned_by_llm";
      if (!(f.evidence?.length)) missingReasons.evidence_ids = "evidence_array_not_populated";
      if (cycleDetected) missingReasons.cycle = "cycle_detected_in_ancestry";
      if (missingParents.length > 0) missingReasons.missing_parents = `ids:${missingParents.join(",")}`;

      ancestryRows.push({
        run_id: runId, deal_id: dealId ?? null, module_id: moduleId,
        stage: "terminal", analysis_node_id: null,
        stage_occurrence_id: `terminal:${f.finding_id}:${occurrenceIdx}`,
        occurrence_index: occurrenceIdx,
        finding_id: f.finding_id,
        all_leaf_ancestor_ids: leafIds,
        source_proposition: f.title ?? null,
        normalized_proposition_hash: fnv1a(normalize(f.title)),
        persisted_canonical_key: f.issue_key ?? null,
        canonical_key_origin: f.issue_key ? "legacy" : "missing",
        claim_ids: f.claim_ids ?? [], disclosure_ids: [],
        evidence_ids: (f.evidence ?? []).map(e => e.figure),
        source_document_ids: f.source_docs ?? [],
        source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean) as string[],
        severity: f.severity, reportability: "reportable",
        parent_ids: parents, child_ids: children,
        merge_level: locs.length > 0 ? Math.min(...locs.map(l => l.level)) : maxLevel + 1,
        representative_member: parents.length > 0 ? "representative" : null,
        first_stage_appeared: firstStage,
        degraded_fallback_flag: degraded,
        degraded_fallback_group_id: degradedGroupId,
        terminal_descendant_ids: termDescendants,
        raw_payload_hash: fnv1a(JSON.stringify(f)),
        lineage_status: classification,
        missing_field_reasons: missingReasons,
      });
      occurrenceIdx++;
    }

    // ═══ PHASE 10: Stats ═══
    const terminalDegraded = terminalFindings.filter(isDegraded).length;
    let tracesToLeafCount = 0, generatedCount = 0, brokenCount = 0, ambiguousCount = 0, cycleCount = 0;
    for (const f of terminalFindings) {
      const cls = graph.classifyFinding(f.finding_id);
      if (cls === "traces_to_leaf") tracesToLeafCount++;
      else if (cls === "generated_without_parent") generatedCount++;
      else if (cls === "broken_parent_reference") brokenCount++;
      else if (cls === "cycle_detected") cycleCount++;
      else ambiguousCount++;
    }

    const l1Nodes = findingsByLevel.get(1) ?? [];
    const l1FindingCounts = l1Nodes.map(n => n.findings.length);
    const l1Total = l1FindingCounts.reduce((s, c) => s + c, 0);
    const l1Min = l1FindingCounts.length > 0 ? Math.min(...l1FindingCounts) : 0;
    const l1Max = l1FindingCounts.length > 0 ? Math.max(...l1FindingCounts) : 0;
    const sortedCounts = [...l1FindingCounts].sort((a, b) => a - b);
    const l1Median = sortedCounts.length > 0 ? sortedCounts[Math.floor(sortedCounts.length / 2)] : 0;

    const stats = {
      leaf_analysis_outputs: leafCount,
      l1_nodes: l1Nodes.length, l1_total_findings: l1Total,
      l1_findings_min: l1Min, l1_findings_max: l1Max, l1_findings_median: l1Median,
      root_nodes_at_max_level: rootNodeCount,
      root_findings: rootFindings.length,
      terminal_findings: terminalFindings.length,
      terminal_degraded: terminalDegraded,
      traces_to_leaf: tracesToLeafCount,
      generated_without_parent: generatedCount,
      broken_parent_reference: brokenCount,
      cycle_detected: cycleCount,
      ambiguous_lineage: ambiguousCount,
      degraded_groups_from_data: degradedGroups.length,
      degraded_groups_distinct_findings: degradedGroups.reduce((s, g) => s + g.finding_count, 0),
      total_levels: maxLevel,
      identity_path: "legacy_merge_recovery",
      identity_path_files: [
        "server/apis/pipeline/resume-merge-recovery.ts (ResumeMergeRecovery)",
        "server/apis/pipeline/resume-merge-recovery.ts → processLevel1Node() [L1 generative]",
        "server/apis/pipeline/resume-merge-recovery.ts → consolidateFindings() [L2+ dedup]",
        "server/apis/pipeline/diagnostic-finalization.ts (DiagnosticFinalization) [terminal consumer]",
      ],
      identity_path_not_used: [
        "server/apis/pipeline/q5-production-stage.ts",
        "server/apis/pipeline/finding-identity.ts",
        "server/apis/pipeline/replay-canonical-identity.ts",
      ],
      uses_f04_q4_q5: false,
    };

    // ═══ PHASE 11: Summary ═══
    const summary = {
      question_1_leaf_findings: `${leafCount} leaf analysis outputs = RAW TEXT, not findings. First structured findings at L1: ${l1Total} across ${l1Nodes.length} nodes (min/max/median: ${l1Min}/${l1Max}/${l1Median}).`,
      question_2_no_leaf_trace: `${generatedCount} generated_without_parent, ${brokenCount} broken_parent_reference, ${cycleCount} cycle_detected, ${ambiguousCount} ambiguous_lineage.`,
      question_3_duplicate_families: knownFamilies.filter(f => f.first_multiplication_stage).map(f =>
        `"${f.family_name}": multiplies at ${f.first_multiplication_stage} (${f.terminal_finding_ids.length} terminal)`
      ).join("; ") || "No multiplication detected",
      question_4_splits_rewrites: `${lineageEvents.filter(e => e.event_type === "one_to_many_split").length} splits, ${lineageEvents.filter(e => e.event_type === "changed_normalized_proposition").length} factual prop changes, ${lineageEvents.filter(e => e.event_type === "new_issue_key").length} new issue_keys.`,
      question_5_degraded_fallback: `${terminalDegraded}/${terminalFindings.length} terminal degraded. ${degradedGroups.length} degraded groups derived from data (${degradedGroups.reduce((s, g) => s + g.finding_count, 0)} total degraded findings).`,
      question_6_identity_path: `LEGACY path: ResumeMergeRecovery → processLevel1Node (L1) / consolidateFindings (L2+). Terminal consumer: DiagnosticFinalization. Does NOT invoke Q4/Q5 canonical identity. Root nodes at max level: ${rootNodeCount} (invariant: single root expected; ${rootNodeCount === 1 ? "SATISFIED" : "VIOLATED — multiple roots"}).`,
    };

    return {
      success: true, error: null, summary, stageReconciliation: stageRecon,
      degradedGroups, knownFamilies, falsePositives,
      lineageEvents: lineageEvents.slice(0, 200), stats,
      ancestryLedgerSample: ancestryRows, ancestryLedgerCount: terminalFindings.length,
    };
  },
});
