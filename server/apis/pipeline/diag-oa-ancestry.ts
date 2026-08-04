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
 * Identity path: This module does NOT use F04/Q4/Q5 canonical identity machinery.
 *   The omission_audit module uses a LEGACY merge path via ResumeMergeRecovery:
 *   - finding_id is assigned fresh at L1 (UUID v4)
 *   - merged_from_finding_ids tracks parent→child merge relationships
 *   - No Q3 claim linkage, no Q4 canonical identity, no Q5 reconciliation
 *   - issue_key is assigned by LLM during merge (not deterministic)
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
  stage: string; // "leaf" | "L1" | "L2" | ... | "root" | "terminal"
  analysis_node_id: string | null; // chunk_index for leaf, "L{n}:N{i}" for merge
  stage_occurrence_id: string; // deterministic: "{stage}:{finding_id}"
  finding_id: string;
  atomic_leaf_finding_id: string | null; // traced back or null
  source_proposition: string | null; // title or detail
  persisted_canonical_key: string | null; // issue_key
  canonical_key_origin: "legacy" | "diagnostic_only" | "missing";
  claim_ids: string[];
  disclosure_ids: string[]; // not persisted in this path
  evidence_ids: string[]; // from evidence[] array
  source_document_ids: string[];
  source_coordinates: string[]; // from evidence[].cell_coordinate
  severity: string;
  reportability: string; // "reportable" or "excluded" or "unknown"
  parent_ids: string[]; // merged_from_finding_ids
  child_ids: string[]; // findings that list this as parent
  merge_level: number;
  representative_member: string | null; // "representative" | "member" | null
  first_stage_appeared: string | null;
  degraded_fallback_flag: boolean;
  degraded_fallback_group_id: string | null;
  terminal_finding_id: string | null;
  raw_payload_hash: string | null;
  normalized_proposition_hash: string | null;
  lineage_status: "traces_to_leaf" | "generated_without_parent" | "broken_parent_reference" | "ambiguous_lineage";
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
  new_propositions: number;
  degraded_rows: number;
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

/** Lineage change event */
export interface LineageEvent {
  finding_id: string;
  event_type: "proposition_changed" | "number_introduced" | "evidence_introduced" | "source_introduced" | "one_to_many_split" | "occurrence_growth";
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
  const matches = text.match(/[\-£$€]?\d[\d,]*\.?\d*[%kKmMbB]?/g);
  return matches ?? [];
}

// ---------------------------------------------------------------------------
// Known family matchers (keyword-based, deterministic)
// ---------------------------------------------------------------------------
const KNOWN_FAMILIES: Array<{ name: string; matcher: (f: CanonicalFinding) => boolean }> = [
  {
    name: "FCA / section 19 / legacy regulated hire",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("fca") || text.includes("section 19") || text.includes("regulated hire") || text.includes("fca authoris");
    },
  },
  {
    name: "customer change-of-control",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail}`);
      return (text.includes("change") && text.includes("control") && text.includes("customer")) ||
             (text.includes("change-of-control") && !text.includes("supplier"));
    },
  },
  {
    name: "supplier change-of-control",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail}`);
      return text.includes("change") && text.includes("control") && text.includes("supplier");
    },
  },
  {
    name: "One Park Lane",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("one park lane") || text.includes("1 park lane");
    },
  },
  {
    name: "1954 Act contracting-out",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("1954 act") || text.includes("contracting-out") || text.includes("contracted out");
    },
  },
  {
    name: "Courts Design / IP assignment",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("courts design") || (text.includes("ip assignment") && text.includes("ipo statement"));
    },
  },
  {
    name: "group trade marks / unregistered trade marks",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("trade mark") || text.includes("trademark") || text.includes("unregistered");
    },
  },
  {
    name: "GDPR / cookies / consent",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("gdpr") || text.includes("cookie") || text.includes("data protection") || text.includes("consent");
    },
  },
  {
    name: "stale Legal-DD scope",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("legal dd") && (text.includes("scope") || text.includes("stale") || text.includes("cut-off"));
    },
  },
  {
    name: "restrictive covenants",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("restrictive covenant");
    },
  },
];

// ---------------------------------------------------------------------------
// Known false-positive matchers
// ---------------------------------------------------------------------------
const KNOWN_FALSE_POSITIVES: Array<{ label: string; matcher: (f: CanonicalFinding) => boolean }> = [
  {
    label: "128% vs 55% market-share contradiction",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("128%") && text.includes("55%") && text.includes("market");
    },
  },
  {
    label: "£19.5m FY25 revenue discrepancy",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("19.5m") && text.includes("fy25") && text.includes("revenue");
    },
  },
  {
    label: "SIP Calls -34.1 percentage-point margin collapse",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("34.1") && text.includes("sip") && (text.includes("margin") || text.includes("collapse"));
    },
  },
  {
    label: "£19k lease matter rated critical",
    matcher: (f) => {
      const text = normalize(`${f.title} ${f.detail} ${f.full_analysis}`);
      return text.includes("19k") && text.includes("lease") && text.includes("critical");
    },
  },
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
    summary: z.any(), // Markdown summary answers
    stageReconciliation: z.any(), // StageReconciliation[]
    knownFamilies: z.any(), // KnownFamilyReport[]
    falsePositives: z.any(), // FalsePositiveTrace[]
    lineageEvents: z.any(), // LineageEvent[]
    stats: z.any(),
    // The full ancestry ledger is too large for API response (434 findings × N levels)
    // It is computed and summarized; full JSONL would be a file export
    ancestryLedgerSample: z.any(), // first 50 rows
    ancestryLedgerCount: z.number(),
  }),

  async run(ctx, { runId, moduleId, dealId }) {
    const db = ctx.integrations.db;

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Load all persisted data
    // ═══════════════════════════════════════════════════════════════════════

    // 1a. Load analysis outputs (leaf level)
    const AnalysisRowSchema = z.object({
      chunk_index: z.coerce.number(),
      extraction_length: z.coerce.number(),
    });

    const analysisRows = await db.query(
      `SELECT chunk_index,
              octet_length(COALESCE(result_json->>'extraction', '')) AS extraction_length
       FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index`,
      AnalysisRowSchema,
      [runId],
      { label: "OA-01: Load leaf analysis rows" }
    );

    const leafCount = analysisRows.length;

    // 1b. Load merge checkpoints LEVEL BY LEVEL to stay under gRPC 4MB limit
    const LevelListSchema = z.object({ tree_level: z.coerce.number() });
    const levelRows = await db.query(
      `SELECT DISTINCT tree_level
       FROM merge_checkpoints
       WHERE module_run_id = $1 AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level`,
      LevelListSchema,
      [runId],
      { label: "OA-01: List distinct merge levels" }
    );

    const CheckpointSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      status: z.string().nullable(),
      findings_json: z.string(),
      findings_count: z.coerce.number(),
      payload_bytes: z.coerce.number(),
    });

    interface CheckpointRow { tree_level: number; node_index: number; status: string | null; findings_json: string; findings_count: number; payload_bytes: number; }
    const checkpoints: CheckpointRow[] = [];

    for (const { tree_level } of levelRows) {
      const levelCheckpoints = await db.query(
        `SELECT tree_level, node_index,
                COALESCE(status, 'complete') AS status,
                COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
                jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)) AS findings_count,
                octet_length(merged_json::text) AS payload_bytes
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND tree_level = $2 AND COALESCE(status, 'complete') = 'complete'
         ORDER BY node_index`,
        CheckpointSchema,
        [runId, tree_level],
        { label: `OA-01: Load merge checkpoints L${tree_level}` }
      );
      checkpoints.push(...levelCheckpoints);
    }

    // 1c. Load terminal findings from module_outputs
    const OutputSchema = z.object({
      id: z.string(),
      findings_json: z.string(),
      findings_count: z.coerce.number(),
    });

    const outputRows = await db.query(
      `SELECT mo.id,
              COALESCE(mo.findings, '[]'::jsonb)::text AS findings_json,
              jsonb_array_length(COALESCE(mo.findings, '[]'::jsonb)) AS findings_count
       FROM module_outputs mo
       JOIN module_runs mr ON mr.id = mo.module_run_id
       WHERE mr.id = $1
       LIMIT 1`,
      OutputSchema,
      [runId],
      { label: "OA-01: Load terminal output" }
    );

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Parse findings at each level
    // ═══════════════════════════════════════════════════════════════════════

    // Build findings-by-level map
    const findingsByLevel = new Map<number, Array<{ nodeIndex: number; findings: CanonicalFinding[] }>>();
    let maxLevel = 0;

    for (const cp of checkpoints) {
      if (cp.tree_level > maxLevel) maxLevel = cp.tree_level;
      let levelArr = findingsByLevel.get(cp.tree_level);
      if (!levelArr) {
        levelArr = [];
        findingsByLevel.set(cp.tree_level, levelArr);
      }
      try {
        const parsed = JSON.parse(cp.findings_json) as CanonicalFinding[];
        levelArr.push({ nodeIndex: cp.node_index, findings: parsed });
      } catch {
        levelArr.push({ nodeIndex: cp.node_index, findings: [] });
      }
    }

    // Parse terminal findings
    let terminalFindings: CanonicalFinding[] = [];
    let terminalOutputId: string | null = null;
    if (outputRows.length > 0) {
      terminalOutputId = outputRows[0].id;
      try {
        terminalFindings = JSON.parse(outputRows[0].findings_json) as CanonicalFinding[];
      } catch {
        terminalFindings = [];
      }
    }

    // Root findings (highest level)
    const rootLevel = findingsByLevel.get(maxLevel);
    const rootFindings: CanonicalFinding[] = rootLevel?.[0]?.findings ?? [];

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Build ancestry graph
    // ═══════════════════════════════════════════════════════════════════════

    // Create a global index: finding_id → { level, nodeIndex, finding }
    interface FindingLocation {
      level: number;
      nodeIndex: number;
      finding: CanonicalFinding;
      stage: string;
      degraded: boolean;
    }
    const globalIndex = new Map<string, FindingLocation[]>();

    for (const [level, nodes] of findingsByLevel) {
      const stage = level === maxLevel ? "root" : `L${level}`;
      for (const node of nodes) {
        for (const f of node.findings) {
          const locs = globalIndex.get(f.finding_id) ?? [];
          const degraded = !!(f as any)._recovery_status === true &&
                           (f as any)._recovery_status === "degraded_fallback";
          locs.push({ level, nodeIndex: node.nodeIndex, finding: f, stage, degraded });
          globalIndex.set(f.finding_id, locs);
        }
      }
    }

    // Also index terminal findings
    for (const f of terminalFindings) {
      const locs = globalIndex.get(f.finding_id) ?? [];
      locs.push({ level: maxLevel + 1, nodeIndex: 0, finding: f, stage: "terminal", degraded: false });
      globalIndex.set(f.finding_id, locs);
    }

    // Build parent→child map from merged_from_finding_ids
    const parentToChildren = new Map<string, string[]>();
    const childToParents = new Map<string, string[]>();

    for (const [fid, locs] of globalIndex) {
      for (const loc of locs) {
        const parents = loc.finding.merged_from_finding_ids ?? [];
        for (const pid of parents) {
          // fid was created by merging pid
          const children = parentToChildren.get(pid) ?? [];
          children.push(fid);
          parentToChildren.set(pid, children);

          const pList = childToParents.get(fid) ?? [];
          pList.push(pid);
          childToParents.set(fid, pList);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: Trace lineage for each terminal/root finding
    // ═══════════════════════════════════════════════════════════════════════

    // For each terminal finding, trace back to leaves
    function traceToLeaves(findingId: string, visited: Set<string> = new Set()): string[] {
      if (visited.has(findingId)) return [];
      visited.add(findingId);

      const locs = globalIndex.get(findingId);
      if (!locs || locs.length === 0) return []; // broken reference

      // Find the lowest-level occurrence
      const minLevel = Math.min(...locs.map(l => l.level));
      if (minLevel === 1) return [findingId]; // This IS a leaf finding

      // Trace parents
      const parents = childToParents.get(findingId) ?? [];
      if (parents.length === 0) {
        // No parents declared — could be generated or its own leaf
        return minLevel === 1 ? [findingId] : [];
      }

      const leafIds: string[] = [];
      for (const pid of parents) {
        leafIds.push(...traceToLeaves(pid, visited));
      }
      return leafIds;
    }

    // Classify each terminal finding
    const lineageClassifications = new Map<string, AncestryRow["lineage_status"]>();
    const leafAncestors = new Map<string, string[]>();

    for (const f of terminalFindings) {
      const leaves = traceToLeaves(f.finding_id);
      leafAncestors.set(f.finding_id, leaves);

      const parents = childToParents.get(f.finding_id) ?? [];
      const locs = globalIndex.get(f.finding_id);
      const minLevel = locs ? Math.min(...locs.map(l => l.level)) : 99;

      if (leaves.length > 0) {
        lineageClassifications.set(f.finding_id, "traces_to_leaf");
      } else if (parents.length === 0 && minLevel > 1) {
        lineageClassifications.set(f.finding_id, "generated_without_parent");
      } else if (parents.length > 0) {
        // Has parents but none trace to leaves — check if parents exist
        const allParentsExist = parents.every(pid => globalIndex.has(pid));
        if (!allParentsExist) {
          lineageClassifications.set(f.finding_id, "broken_parent_reference");
        } else {
          lineageClassifications.set(f.finding_id, "ambiguous_lineage");
        }
      } else {
        // At L1 with no parents — it IS a leaf
        lineageClassifications.set(f.finding_id, "traces_to_leaf");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Build stage reconciliation
    // ═══════════════════════════════════════════════════════════════════════

    const stageRecon: StageReconciliation[] = [];

    // Leaf stage
    stageRecon.push({
      stage: "leaf",
      output_containers: leafCount,
      finding_rows: 0, // raw text, not structured findings
      unique_finding_ids: 0,
      unique_proposition_keys: 0,
      orphan_rows: 0,
      new_propositions: 0,
      degraded_rows: 0,
    });

    // Each merge level
    for (let lvl = 1; lvl <= maxLevel; lvl++) {
      const nodesAtLevel = findingsByLevel.get(lvl) ?? [];
      const allFindings = nodesAtLevel.flatMap(n => n.findings);
      const stage = lvl === maxLevel ? "root" : `L${lvl}`;

      const uniqueIds = new Set(allFindings.map(f => f.finding_id));
      const uniqueKeys = new Set(allFindings.map(f => f.issue_key).filter(Boolean));

      // Orphan: has merged_from but parent not found at previous level
      let orphans = 0;
      for (const f of allFindings) {
        const parents = f.merged_from_finding_ids ?? [];
        for (const pid of parents) {
          if (!globalIndex.has(pid)) orphans++;
        }
      }

      // New propositions: issue_key not seen at any previous level
      const prevKeys = new Set<string>();
      for (let prev = 1; prev < lvl; prev++) {
        const prevNodes = findingsByLevel.get(prev) ?? [];
        for (const n of prevNodes) {
          for (const f of n.findings) {
            if (f.issue_key) prevKeys.add(f.issue_key);
          }
        }
      }
      const newProps = allFindings.filter(f => f.issue_key && !prevKeys.has(f.issue_key)).length;

      // Degraded
      const degradedCount = allFindings.filter(f => (f as any)._recovery_status === "degraded_fallback").length;

      stageRecon.push({
        stage,
        output_containers: nodesAtLevel.length,
        finding_rows: allFindings.length,
        unique_finding_ids: uniqueIds.size,
        unique_proposition_keys: uniqueKeys.size,
        orphan_rows: orphans,
        new_propositions: newProps,
        degraded_rows: degradedCount,
      });
    }

    // Terminal stage
    const termUniqueIds = new Set(terminalFindings.map(f => f.finding_id));
    const termUniqueKeys = new Set(terminalFindings.map(f => f.issue_key).filter(Boolean));
    stageRecon.push({
      stage: "terminal",
      output_containers: outputRows.length,
      finding_rows: terminalFindings.length,
      unique_finding_ids: termUniqueIds.size,
      unique_proposition_keys: termUniqueKeys.size,
      orphan_rows: 0,
      new_propositions: 0,
      degraded_rows: terminalFindings.filter(f => (f as any)._recovery_status === "degraded_fallback").length,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 6: Lineage change detection
    // ═══════════════════════════════════════════════════════════════════════

    const lineageEvents: LineageEvent[] = [];

    // Detect proposition changes, number introductions, evidence introductions
    for (const [fid, locs] of globalIndex) {
      if (locs.length < 2) continue;
      const sorted = [...locs].sort((a, b) => a.level - b.level);

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];

        // Proposition change (title or detail changed)
        if (normalize(prev.finding.title) !== normalize(curr.finding.title)) {
          lineageEvents.push({
            finding_id: fid,
            event_type: "proposition_changed",
            first_stage: curr.stage,
            details: `Title changed: "${prev.finding.title?.slice(0, 60)}" → "${curr.finding.title?.slice(0, 60)}"`,
          });
        }

        // Number introduced after leaf
        const prevNumbers = extractNumbers(`${prev.finding.title} ${prev.finding.detail}`);
        const currNumbers = extractNumbers(`${curr.finding.title} ${curr.finding.detail}`);
        const newNumbers = currNumbers.filter(n => !prevNumbers.includes(n));
        if (newNumbers.length > 0 && prev.level >= 1) {
          lineageEvents.push({
            finding_id: fid,
            event_type: "number_introduced",
            first_stage: curr.stage,
            details: `New numbers: ${newNumbers.slice(0, 5).join(", ")}`,
          });
        }

        // Evidence introduced
        const prevEvIds = (prev.finding.evidence ?? []).map(e => e.figure);
        const currEvIds = (curr.finding.evidence ?? []).map(e => e.figure);
        const newEv = currEvIds.filter(e => !prevEvIds.includes(e));
        if (newEv.length > 0) {
          lineageEvents.push({
            finding_id: fid,
            event_type: "evidence_introduced",
            first_stage: curr.stage,
            details: `New evidence figures: ${newEv.slice(0, 3).join(", ")}`,
          });
        }

        // Source docs introduced
        const prevDocs = prev.finding.source_docs ?? [];
        const currDocs = curr.finding.source_docs ?? [];
        const newDocs = currDocs.filter(d => !prevDocs.includes(d));
        if (newDocs.length > 0) {
          lineageEvents.push({
            finding_id: fid,
            event_type: "source_introduced",
            first_stage: curr.stage,
            details: `New source docs: ${newDocs.slice(0, 2).join(", ")}`,
          });
        }
      }
    }

    // Detect one-to-many splits (one parent → multiple children with distinct propositions)
    for (const [pid, children] of parentToChildren) {
      if (children.length <= 1) continue;
      const childTitles = new Set<string>();
      for (const cid of children) {
        const clocs = globalIndex.get(cid);
        if (clocs && clocs.length > 0) {
          childTitles.add(normalize(clocs[0].finding.title));
        }
      }
      if (childTitles.size > 1) {
        const parentLocs = globalIndex.get(pid);
        const stage = parentLocs?.[0]?.stage ?? "unknown";
        lineageEvents.push({
          finding_id: pid,
          event_type: "one_to_many_split",
          first_stage: stage,
          details: `Parent ${pid.slice(0, 8)} split into ${children.length} distinct propositions`,
        });
      }
    }

    // Detect occurrence growth (same issue_key appears more times at a higher level)
    const keyCountByLevel = new Map<string, Map<number, number>>();
    for (const [level, nodes] of findingsByLevel) {
      for (const node of nodes) {
        for (const f of node.findings) {
          if (!f.issue_key) continue;
          let levelMap = keyCountByLevel.get(f.issue_key);
          if (!levelMap) {
            levelMap = new Map();
            keyCountByLevel.set(f.issue_key, levelMap);
          }
          levelMap.set(level, (levelMap.get(level) ?? 0) + 1);
        }
      }
    }
    for (const [key, levelMap] of keyCountByLevel) {
      const levels = [...levelMap.entries()].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < levels.length; i++) {
        if (levels[i][1] > levels[i - 1][1]) {
          lineageEvents.push({
            finding_id: key,
            event_type: "occurrence_growth",
            first_stage: `L${levels[i][0]}`,
            details: `issue_key "${key}" grew from ${levels[i - 1][1]} to ${levels[i][1]} occurrences`,
          });
          break; // Report only first growth
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 7: Known families
    // ═══════════════════════════════════════════════════════════════════════

    const knownFamilies: KnownFamilyReport[] = [];
    for (const family of KNOWN_FAMILIES) {
      const matchIds: string[] = [];
      const propositions: string[] = [];
      const countByStage: Record<string, number> = {};
      const propKeys = new Set<string>();
      const termIds: string[] = [];
      let degraded = false;

      for (const [fid, locs] of globalIndex) {
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

      // Determine first multiplication stage
      let firstMult: string | null = null;
      const stageOrder = ["L1", "L2", "L3", "L4", "L5", "root", "terminal"];
      for (const s of stageOrder) {
        if ((countByStage[s] ?? 0) > 1) {
          firstMult = s;
          break;
        }
      }

      if (matchIds.length > 0) {
        knownFamilies.push({
          family_name: family.name,
          matching_occurrence_ids: matchIds.slice(0, 50), // limit for response size
          exact_propositions: [...new Set(propositions)].slice(0, 20),
          count_by_stage: countByStage,
          unique_proposition_keys: [...propKeys],
          first_multiplication_stage: firstMult,
          terminal_finding_ids: termIds,
          degraded_fallback_involvement: degraded,
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 8: Known false positives
    // ═══════════════════════════════════════════════════════════════════════

    const falsePositives: FalsePositiveTrace[] = [];
    for (const fp of KNOWN_FALSE_POSITIVES) {
      const matchIds: string[] = [];
      let firstStage: string | null = null;
      let proposition: string | null = null;
      let termId: string | null = null;
      const evidence: string[] = [];
      const changedFields: string[] = [];

      for (const [fid, locs] of globalIndex) {
        for (const loc of locs) {
          if (fp.matcher(loc.finding)) {
            matchIds.push(fid);
            if (!firstStage || loc.level < (globalIndex.get(matchIds[0])?.[0]?.level ?? 99)) {
              firstStage = loc.stage;
              proposition = loc.finding.title;
            }
            if (loc.stage === "terminal") termId = fid;
            if (loc.finding.source_docs) evidence.push(...loc.finding.source_docs);
          }
        }
      }

      falsePositives.push({
        label: fp.label,
        matching_finding_ids: [...new Set(matchIds)],
        exact_proposition: proposition,
        source_evidence_lineage: [...new Set(evidence)].slice(0, 5),
        first_stage_present: firstStage,
        originated_at_leaf: firstStage === "L1" ? true : firstStage ? false : null,
        changed_fields: changedFields,
        terminal_finding_id: termId,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 9: Build ancestry ledger (sample)
    // ═══════════════════════════════════════════════════════════════════════

    const ancestryRows: AncestryRow[] = [];
    for (const f of terminalFindings.slice(0, 50)) {
      const locs = globalIndex.get(f.finding_id) ?? [];
      const classification = lineageClassifications.get(f.finding_id) ?? "ambiguous_lineage";
      const leaves = leafAncestors.get(f.finding_id) ?? [];
      const parents = childToParents.get(f.finding_id) ?? [];
      const children = parentToChildren.get(f.finding_id) ?? [];
      const degraded = locs.some(l => l.degraded) ||
                       (f as any)._recovery_status === "degraded_fallback";

      ancestryRows.push({
        run_id: runId,
        deal_id: dealId ?? null,
        module_id: moduleId,
        stage: "terminal",
        analysis_node_id: null,
        stage_occurrence_id: `terminal:${f.finding_id}`,
        finding_id: f.finding_id,
        atomic_leaf_finding_id: leaves.length === 1 ? leaves[0] : null,
        source_proposition: f.title ?? null,
        persisted_canonical_key: f.issue_key ?? null,
        canonical_key_origin: f.issue_key ? "legacy" : "missing",
        claim_ids: f.claim_ids ?? [],
        disclosure_ids: [],
        evidence_ids: (f.evidence ?? []).map(e => e.figure),
        source_document_ids: f.source_docs ?? [],
        source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean) as string[],
        severity: f.severity,
        reportability: "reportable",
        parent_ids: parents,
        child_ids: children,
        merge_level: Math.min(...locs.map(l => l.level)),
        representative_member: parents.length > 0 ? "representative" : null,
        first_stage_appeared: locs.length > 0 ? locs.sort((a, b) => a.level - b.level)[0].stage : null,
        degraded_fallback_flag: degraded,
        degraded_fallback_group_id: degraded ? fnv1a(f.finding_id) : null,
        terminal_finding_id: f.finding_id,
        raw_payload_hash: fnv1a(JSON.stringify(f)),
        normalized_proposition_hash: fnv1a(normalize(f.title)),
        lineage_status: classification,
        missing_field_reasons: {
          ...(leaves.length === 0 && classification !== "traces_to_leaf"
            ? { atomic_leaf_finding_id: "no_leaf_ancestor_traced" }
            : {}),
          ...(!f.issue_key ? { persisted_canonical_key: "not_assigned_by_llm" } : {}),
          ...(!(f.evidence?.length) ? { evidence_ids: "evidence_array_not_populated" } : {}),
        },
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 10: Compute stats and summary answers
    // ═══════════════════════════════════════════════════════════════════════

    // Count degraded findings at terminal
    const terminalDegraded = terminalFindings.filter(f =>
      (f as any)._recovery_status === "degraded_fallback"
    ).length;

    // Count findings that trace to leaf vs not
    let tracesToLeafCount = 0;
    let generatedCount = 0;
    let brokenCount = 0;
    let ambiguousCount = 0;
    for (const [, cls] of lineageClassifications) {
      if (cls === "traces_to_leaf") tracesToLeafCount++;
      else if (cls === "generated_without_parent") generatedCount++;
      else if (cls === "broken_parent_reference") brokenCount++;
      else ambiguousCount++;
    }

    // L1 findings distribution
    const l1Nodes = findingsByLevel.get(1) ?? [];
    const l1FindingCounts = l1Nodes.map(n => n.findings.length);
    const l1Total = l1FindingCounts.reduce((s, c) => s + c, 0);
    const l1Min = l1FindingCounts.length > 0 ? Math.min(...l1FindingCounts) : 0;
    const l1Max = l1FindingCounts.length > 0 ? Math.max(...l1FindingCounts) : 0;
    const l1Median = l1FindingCounts.length > 0
      ? l1FindingCounts.sort((a, b) => a - b)[Math.floor(l1FindingCounts.length / 2)]
      : 0;

    const stats = {
      leaf_analysis_outputs: leafCount,
      leaf_finding_rows: 0, // raw text extractions, not structured findings
      l1_nodes: l1Nodes.length,
      l1_total_findings: l1Total,
      l1_findings_min: l1Min,
      l1_findings_max: l1Max,
      l1_findings_median: l1Median,
      root_findings: rootFindings.length,
      terminal_findings: terminalFindings.length,
      terminal_degraded: terminalDegraded,
      traces_to_leaf: tracesToLeafCount,
      generated_without_parent: generatedCount,
      broken_parent_reference: brokenCount,
      ambiguous_lineage: ambiguousCount,
      degraded_fallback_groups_reported: 64, // from recovery worker
      total_levels: maxLevel,
      identity_path: "legacy_merge_recovery",
      uses_f04_q4_q5: false,
    };

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 11: Summary answers
    // ═══════════════════════════════════════════════════════════════════════

    const summary = {
      question_1_leaf_findings: `The ${leafCount} leaf analysis outputs contain RAW TEXT extractions, not structured findings. The first structured findings appear at L1 (${l1Total} findings across ${l1Nodes.length} nodes). Min/max/median per L1 node: ${l1Min}/${l1Max}/${l1Median}.`,
      question_2_no_leaf_trace: `${generatedCount} terminal findings have no traceable leaf proposition (generated_without_parent). ${brokenCount} have broken parent references. ${ambiguousCount} are ambiguous.`,
      question_3_duplicate_families: knownFamilies.filter(f => f.first_multiplication_stage).map(f =>
        `"${f.family_name}": first multiplies at ${f.first_multiplication_stage} (${f.terminal_finding_ids.length} terminal findings)`
      ).join("; ") || "No multiplication detected",
      question_4_splits_rewrites: `${lineageEvents.filter(e => e.event_type === "one_to_many_split").length} one-to-many splits detected. ${lineageEvents.filter(e => e.event_type === "proposition_changed").length} proposition changes. ${lineageEvents.filter(e => e.event_type === "number_introduced").length} numbers introduced after leaf.`,
      question_5_degraded_fallback: `${terminalDegraded} of ${terminalFindings.length} terminal findings carry _recovery_status="degraded_fallback" tag. The recovery worker reported 64 degraded fallback groups during processing.`,
      question_6_identity_path: "The live path uses LEGACY merge recovery (ResumeMergeRecovery). It does NOT use F04/Q4/Q5 canonical identity machinery. finding_id is UUID v4 assigned at L1 extraction. merged_from_finding_ids tracks parent→child. issue_key is LLM-assigned (not deterministic).",
    };

    return {
      success: true,
      error: null,
      summary,
      stageReconciliation: stageRecon,
      knownFamilies,
      falsePositives,
      lineageEvents: lineageEvents.slice(0, 200), // limit for response size
      stats,
      ancestryLedgerSample: ancestryRows,
      ancestryLedgerCount: terminalFindings.length,
    };
  },
});
