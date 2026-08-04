/**
 * oa-ancestry-service.ts
 *
 * Shared read-only diagnostic computation layer for OA-01.
 * Used directly by:
 *   - DiagOaAncestry (API)
 *   - DiagOaAncestryExport (API)
 *   - TestOaAncestry (API)
 *
 * Key design decisions:
 *   1. Occurrence-safe: lineage keyed by (stage, level, nodeIndex, findingId, occIdx)
 *   2. Proper DAG cycle detection: recursion-stack, NOT visited-set
 *   3. No fabricated fields: reportability=null unless persisted, representative/member only from merge decisions
 *   4. Multi-dimensional factual fingerprint (not title-only)
 *   5. Persisted vs diagnostic degraded group IDs distinguished
 *   6. Deterministic, sorted, deduplicated outputs
 */

import type { CanonicalFinding } from "./canonical-finding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique occurrence key */
export interface OccurrenceKey {
  stage: string;
  level: number;
  nodeIndex: number;
  findingId: string;
  occurrenceIndexWithinNode: number;
}

export function occKeyStr(k: OccurrenceKey): string {
  return `${k.stage}:L${k.level}:N${k.nodeIndex}:${k.findingId}:${k.occurrenceIndexWithinNode}`;
}

/** One finding occurrence at a specific stage/node */
export interface FindingOccurrence {
  key: OccurrenceKey;
  finding: CanonicalFinding;
  degraded: boolean;
}

/** Full ancestry graph (occurrence-safe) */
export interface OccurrenceGraph {
  /** All occurrences by finding_id */
  byFindingId: Map<string, FindingOccurrence[]>;
  /** All occurrences in insertion order */
  allOccurrences: FindingOccurrence[];
  /** Parent→child (by finding_id, since merged_from references IDs not occurrences) */
  parentToChildren: Map<string, Set<string>>;
  /** Child→parent (by finding_id) */
  childToParents: Map<string, Set<string>>;
  maxLevel: number;
  /** Terminal finding IDs */
  terminalIds: Set<string>;

  /** Trace all reachable L1/leaf ancestors using recursion-stack cycle detection */
  traceAllLeaves(findingId: string): LeafTraceResult;
  /** Classify lineage status */
  classifyFinding(findingId: string): LineageStatus;
  /** Get terminal descendant IDs */
  getTerminalDescendants(findingId: string): string[];
  /** Get candidate parent occurrences for a finding (occurrence-safe) */
  getCandidateParentOccurrences(findingId: string): FindingOccurrence[];
  /** Check if parentage is ambiguous (same parent ID in multiple nodes) */
  isAmbiguousParentage(findingId: string): boolean;
}

export type LineageStatus =
  | "traces_to_leaf"
  | "generated_without_parent"
  | "broken_parent_reference"
  | "cycle_detected"
  | "ambiguous_lineage";

export interface LeafTraceResult {
  leafIds: string[];       // deduplicated, sorted
  cycleDetected: boolean;  // true only for genuine cycles (not diamond convergence)
  missingParents: string[]; // sorted
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** FNV-1a hash */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Normalize text */
export function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Extract numeric values from text */
export function extractNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(/[-£$€]?\d[\d,]*\.?\d*[%kKmMbB]?/g) ?? [];
}

/** Check degraded status from persisted _recovery_status */
export function isDegraded(f: CanonicalFinding): boolean {
  const status = (f as any)._recovery_status;
  return status === "degraded_fallback" || status === "merge_contract_fallback";
}

// ---------------------------------------------------------------------------
// Multi-dimensional factual fingerprint
// ---------------------------------------------------------------------------

export interface FactualFingerprint {
  title_normalized: string;
  detail_normalized: string;
  finding_kind: string | null;
  category: string | null;
  issue_key: string | null;
  source_docs_sorted: string[];
  evidence_metrics: string[];  // metric:period:scope from evidence items
  evidence_figures: string[];  // figure values
  numeric_values: string[];    // extracted from title + detail
  structured_impact_hash: string | null; // hash of amounts
  claim_ids_sorted: string[];
  source_coordinates: string[];
  hash: string;  // composite hash of all dimensions
}

export function computeFactualFingerprint(f: CanonicalFinding): FactualFingerprint {
  const title_normalized = normalize(f.title);
  const detail_normalized = normalize(f.detail);
  const finding_kind = f.finding_kind ?? null;
  const category = f.category ?? null;
  const issue_key = f.issue_key ?? null;
  const source_docs_sorted = [...(f.source_docs ?? [])].sort();

  const evidence_metrics: string[] = [];
  const evidence_figures: string[] = [];
  const source_coordinates: string[] = [];
  for (const e of f.evidence ?? []) {
    if (e.figure) evidence_figures.push(e.figure);
    const metricKey = [e.metric ?? "", e.period ?? "", e.scope ?? ""].filter(Boolean).join(":");
    if (metricKey) evidence_metrics.push(metricKey);
    if (e.cell_coordinate) source_coordinates.push(e.cell_coordinate);
  }
  evidence_metrics.sort();
  evidence_figures.sort();
  source_coordinates.sort();

  const numeric_values = [...new Set([...extractNumbers(f.title), ...extractNumbers(f.detail)])].sort();

  let structured_impact_hash: string | null = null;
  if (f.structured_impact?.length) {
    const impactStr = f.structured_impact.map(si => `${si.amount}:${si.currency}:${si.unit_multiplier}:${si.role}`).sort().join("|");
    structured_impact_hash = fnv1a(impactStr);
  }

  const claim_ids_sorted = [...(f.claim_ids ?? [])].sort();

  // Composite hash of ALL available dimensions
  const composite = [
    title_normalized,
    detail_normalized,
    finding_kind ?? "",
    category ?? "",
    source_docs_sorted.join("|"),
    evidence_metrics.join("|"),
    evidence_figures.join("|"),
    numeric_values.join("|"),
    structured_impact_hash ?? "",
    claim_ids_sorted.join("|"),
    source_coordinates.join("|"),
  ].join("\x00");

  return {
    title_normalized, detail_normalized, finding_kind, category, issue_key,
    source_docs_sorted, evidence_metrics, evidence_figures, numeric_values,
    structured_impact_hash, claim_ids_sorted, source_coordinates,
    hash: fnv1a(composite),
  };
}

// ---------------------------------------------------------------------------
// Factual change diagnostics between two occurrences of same finding_id
// ---------------------------------------------------------------------------

export type FactualChangeType =
  | "title_changed"
  | "factual_payload_changed"
  | "issue_key_changed"
  | "numeric_value_introduced"
  | "source_or_evidence_introduced"
  | "insufficient_persisted_dimensions";

export interface FactualChange {
  type: FactualChangeType;
  details: string;
}

export function detectFactualChanges(prev: CanonicalFinding, curr: CanonicalFinding): FactualChange[] {
  const changes: FactualChange[] = [];
  const prevFP = computeFactualFingerprint(prev);
  const currFP = computeFactualFingerprint(curr);

  // Title change
  if (prevFP.title_normalized && currFP.title_normalized && prevFP.title_normalized !== currFP.title_normalized) {
    changes.push({ type: "title_changed", details: `"${prev.title?.slice(0, 50)}" → "${curr.title?.slice(0, 50)}"` });
  }

  // Full factual payload change (composite hash)
  if (prevFP.hash !== currFP.hash) {
    changes.push({ type: "factual_payload_changed", details: `fingerprint: ${prevFP.hash} → ${currFP.hash}` });
  }

  // Issue key change
  if (prev.issue_key !== curr.issue_key) {
    changes.push({ type: "issue_key_changed", details: `"${prev.issue_key ?? "(none)"}" → "${curr.issue_key ?? "(none)"}"` });
  }

  // New numeric values
  const prevNums = new Set(prevFP.numeric_values);
  const newNums = currFP.numeric_values.filter(n => !prevNums.has(n));
  if (newNums.length > 0) {
    changes.push({ type: "numeric_value_introduced", details: `New: ${newNums.slice(0, 5).join(", ")}` });
  }

  // New source docs or evidence
  const prevSources = new Set([...prevFP.source_docs_sorted, ...prevFP.evidence_figures]);
  const currSources = [...currFP.source_docs_sorted, ...currFP.evidence_figures];
  const newSources = currSources.filter(s => !prevSources.has(s));
  if (newSources.length > 0) {
    changes.push({ type: "source_or_evidence_introduced", details: `New: ${newSources.slice(0, 3).join(", ")}` });
  }

  // Check if we have enough dimensions to make any determination
  if (changes.length === 0 && !prevFP.title_normalized && !prevFP.detail_normalized) {
    changes.push({ type: "insufficient_persisted_dimensions", details: "No title or detail available for comparison" });
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Degraded group report
// ---------------------------------------------------------------------------

export interface DegradedGroupReport {
  /** Diagnostic-constructed locator (L{n}:N{i}) */
  diagnostic_node_group_id: string;
  /** Persisted degraded group ID (from checkpoint/node primary key if available) */
  persisted_degraded_group_id: string | null;
  /** Source of the group identity */
  degraded_group_identity_source: "persisted_checkpoint_id" | "diagnostic_level_node" | "missing";
  stage: string;
  finding_count: number;
  finding_ids: string[];
  terminal_descendant_ids: string[];
  reconstructable: boolean;
  non_reconstructable_reason: string | null;
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export interface NodeInput {
  nodeIndex: number;
  findings: CanonicalFinding[];
  /** Persisted checkpoint ID if available (for degraded group identity) */
  checkpointId?: string | null;
}

export function buildOccurrenceGraph(
  findingsByLevel: Map<number, NodeInput[]>,
  terminalFindings: CanonicalFinding[] = []
): OccurrenceGraph {
  const byFindingId = new Map<string, FindingOccurrence[]>();
  const allOccurrences: FindingOccurrence[] = [];
  const maxLevel = Math.max(...findingsByLevel.keys(), 0);

  // Index all merge-level occurrences
  for (const [level, nodes] of findingsByLevel) {
    const stage = level === maxLevel ? "root" : `L${level}`;
    for (const node of nodes) {
      for (let occIdx = 0; occIdx < node.findings.length; occIdx++) {
        const f = node.findings[occIdx];
        const key: OccurrenceKey = { stage, level, nodeIndex: node.nodeIndex, findingId: f.finding_id, occurrenceIndexWithinNode: occIdx };
        const occ: FindingOccurrence = { key, finding: f, degraded: isDegraded(f) };
        allOccurrences.push(occ);
        const arr = byFindingId.get(f.finding_id) ?? [];
        arr.push(occ);
        byFindingId.set(f.finding_id, arr);
      }
    }
  }

  // Index terminal occurrences
  const terminalIds = new Set<string>();
  for (let occIdx = 0; occIdx < terminalFindings.length; occIdx++) {
    const f = terminalFindings[occIdx];
    terminalIds.add(f.finding_id);
    const key: OccurrenceKey = { stage: "terminal", level: maxLevel + 1, nodeIndex: 0, findingId: f.finding_id, occurrenceIndexWithinNode: occIdx };
    const occ: FindingOccurrence = { key, finding: f, degraded: isDegraded(f) };
    allOccurrences.push(occ);
    const arr = byFindingId.get(f.finding_id) ?? [];
    arr.push(occ);
    byFindingId.set(f.finding_id, arr);
  }

  // Build finding-ID-level parent/child maps
  const parentToChildren = new Map<string, Set<string>>();
  const childToParents = new Map<string, Set<string>>();

  for (const occ of allOccurrences) {
    const parents = occ.finding.merged_from_finding_ids ?? [];
    for (const pid of parents) {
      let kids = parentToChildren.get(pid);
      if (!kids) { kids = new Set(); parentToChildren.set(pid, kids); }
      kids.add(occ.key.findingId);

      let pSet = childToParents.get(occ.key.findingId);
      if (!pSet) { pSet = new Set(); childToParents.set(occ.key.findingId, pSet); }
      pSet.add(pid);
    }
  }

  // ─── Trace all leaves using RECURSION-STACK cycle detection ───
  // A node on the current DFS path = cycle.
  // A node previously fully explored = memoized (diamond convergence OK).
  const memoizedLeaves = new Map<string, LeafTraceResult>();

  function traceAllLeaves(findingId: string): LeafTraceResult {
    if (memoizedLeaves.has(findingId)) return memoizedLeaves.get(findingId)!;

    const leafIds = new Set<string>();
    const missingParents = new Set<string>();
    let cycleDetected = false;
    const recursionStack = new Set<string>();
    const completed = new Set<string>();

    function dfs(fid: string): void {
      if (completed.has(fid)) {
        // Already fully explored — reuse result (diamond convergence)
        const memo = memoizedLeaves.get(fid);
        if (memo) {
          for (const lid of memo.leafIds) leafIds.add(lid);
          for (const mp of memo.missingParents) missingParents.add(mp);
          if (memo.cycleDetected) cycleDetected = true;
        }
        return;
      }
      if (recursionStack.has(fid)) {
        // Genuine cycle: this node is on the CURRENT path
        cycleDetected = true;
        return;
      }
      recursionStack.add(fid);

      const occs = byFindingId.get(fid);
      if (!occs || occs.length === 0) {
        missingParents.add(fid);
        recursionStack.delete(fid);
        return;
      }

      // Check if this finding appears at L1 (leaf level)
      const minLevel = Math.min(...occs.map(o => o.key.level));
      if (minLevel === 1) {
        leafIds.add(fid);
        recursionStack.delete(fid);
        completed.add(fid);
        memoizedLeaves.set(fid, { leafIds: [fid], cycleDetected: false, missingParents: [] });
        return;
      }

      // Traverse parents
      const parents = childToParents.get(fid);
      if (!parents || parents.size === 0) {
        // No parents above L1 → not a leaf
        recursionStack.delete(fid);
        completed.add(fid);
        memoizedLeaves.set(fid, { leafIds: [], cycleDetected: false, missingParents: [] });
        return;
      }

      for (const pid of parents) {
        if (!byFindingId.has(pid)) {
          missingParents.add(pid);
        } else {
          dfs(pid);
        }
      }

      recursionStack.delete(fid);
      completed.add(fid);
    }

    dfs(findingId);

    const result: LeafTraceResult = {
      leafIds: [...leafIds].sort(),
      cycleDetected,
      missingParents: [...missingParents].sort(),
    };
    memoizedLeaves.set(findingId, result);
    return result;
  }

  function classifyFinding(fid: string): LineageStatus {
    const { leafIds, cycleDetected, missingParents } = traceAllLeaves(fid);
    if (cycleDetected) return "cycle_detected";
    if (leafIds.length > 0) return "traces_to_leaf";

    const parents = childToParents.get(fid);
    const occs = byFindingId.get(fid);
    const minLevel = occs ? Math.min(...occs.map(o => o.key.level)) : 99;

    if (!parents || parents.size === 0) {
      if (minLevel <= 1) return "traces_to_leaf";
      return "generated_without_parent";
    }
    if (missingParents.length > 0) return "broken_parent_reference";
    return "ambiguous_lineage";
  }

  function getTerminalDescendants(fid: string): string[] {
    const termIds2 = new Set<string>();
    const visited = new Set<string>();
    function dfs(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      if (terminalIds.has(id)) termIds2.add(id);
      const kids = parentToChildren.get(id);
      if (kids) for (const kid of kids) dfs(kid);
    }
    dfs(fid);
    return [...termIds2].sort();
  }

  function getCandidateParentOccurrences(findingId: string): FindingOccurrence[] {
    const parents = childToParents.get(findingId);
    if (!parents) return [];
    const candidates: FindingOccurrence[] = [];
    for (const pid of parents) {
      const poccs = byFindingId.get(pid) ?? [];
      candidates.push(...poccs);
    }
    return candidates;
  }

  function isAmbiguousParentage(findingId: string): boolean {
    const parents = childToParents.get(findingId);
    if (!parents) return false;
    for (const pid of parents) {
      const poccs = byFindingId.get(pid) ?? [];
      // If same parent ID exists in multiple nodes at the same level, it's ambiguous
      const levels = new Set(poccs.map(o => `${o.key.level}:${o.key.nodeIndex}`));
      if (levels.size > 1) return true;
    }
    return false;
  }

  return {
    byFindingId, allOccurrences, parentToChildren, childToParents,
    maxLevel, terminalIds, traceAllLeaves, classifyFinding,
    getTerminalDescendants, getCandidateParentOccurrences, isAmbiguousParentage,
  };
}

// ---------------------------------------------------------------------------
// Ancestry ledger row (occurrence-safe, no fabricated fields)
// ---------------------------------------------------------------------------

export interface AncestryLedgerRow {
  run_id: string;
  deal_id: string | null;
  module_id: string;
  stage: string;
  analysis_node_id: string;
  stage_occurrence_id: string;
  occurrence_index: number;
  finding_id: string;
  all_leaf_ancestor_ids: string[];
  source_proposition: string | null;
  normalized_proposition_hash: string;
  factual_fingerprint_hash: string;
  persisted_canonical_key: string | null;
  canonical_key_origin: "legacy" | "missing";
  claim_ids: string[];
  disclosure_ids: string[];
  evidence_ids: string[];
  source_document_ids: string[];
  source_coordinates: string[];
  severity: string;
  /** null unless persisted — we do NOT fabricate "reportable" */
  reportability: string | null;
  parent_ids: string[];
  child_ids: string[];
  merge_level: number;
  /** null unless persisted merge decision supports it */
  representative_member: string | null;
  first_stage_appeared: string;
  degraded_fallback_flag: boolean;
  /** Persisted checkpoint ID or null */
  persisted_degraded_group_id: string | null;
  /** Diagnostic-constructed node locator */
  diagnostic_node_group_id: string | null;
  degraded_group_identity_source: "persisted_checkpoint_id" | "diagnostic_level_node" | "missing" | null;
  terminal_descendant_ids: string[];
  raw_payload_hash: string;
  lineage_status: LineageStatus;
  ambiguous_parentage: boolean;
  candidate_parent_occurrences: string[];
  missing_field_reasons: Record<string, string>;
}

export function buildAncestryLedgerRow(
  occ: FindingOccurrence,
  graph: OccurrenceGraph,
  runId: string,
  dealId: string | null,
  moduleId: string,
  globalOccIdx: number,
  checkpointId: string | null,
): AncestryLedgerRow {
  const f = occ.finding;
  const fid = f.finding_id;
  const { leafIds, cycleDetected, missingParents } = graph.traceAllLeaves(fid);
  const classification = graph.classifyFinding(fid);
  const parents = [...(graph.childToParents.get(fid) ?? [])].sort();
  const children = [...(graph.parentToChildren.get(fid) ?? [])].sort();
  const termDescendants = graph.getTerminalDescendants(fid);
  const ambiguous = graph.isAmbiguousParentage(fid);

  // First stage appeared (across all occurrences of this finding_id)
  const allOccs = graph.byFindingId.get(fid) ?? [];
  const sortedOccs = [...allOccs].sort((a, b) => a.key.level - b.key.level);
  const firstStage = sortedOccs.length > 0 ? sortedOccs[0].key.stage : occ.key.stage;

  // Degraded group identity — DO NOT fabricate
  let persisted_degraded_group_id: string | null = null;
  let diagnostic_node_group_id: string | null = null;
  let degraded_group_identity_source: AncestryLedgerRow["degraded_group_identity_source"] = null;

  if (occ.degraded) {
    diagnostic_node_group_id = `L${occ.key.level}:N${occ.key.nodeIndex}`;
    if (checkpointId) {
      persisted_degraded_group_id = checkpointId;
      degraded_group_identity_source = "persisted_checkpoint_id";
    } else {
      degraded_group_identity_source = "diagnostic_level_node";
    }
  }

  // Representative/member — ONLY from persisted merge decision
  // A finding has a persisted merge decision if it has merged_from_finding_ids (it's a representative)
  let representative_member: string | null = null;
  if ((f.merged_from_finding_ids ?? []).length > 0) {
    representative_member = "representative"; // persisted: this finding explicitly lists its inputs
  }
  // Note: we do NOT infer "member" from being in another's merged_from — that's the parent's data, not this finding's persisted decision

  // Reportability — NOT fabricated, only from persisted field
  // CanonicalFinding has no `reportability` field → always null
  const reportability: string | null = null;

  // Missing field reasons
  const missingReasons: Record<string, string> = {};
  if (leafIds.length === 0 && classification !== "traces_to_leaf") missingReasons.all_leaf_ancestor_ids = "no_leaf_ancestor_traced";
  if (!f.issue_key) missingReasons.persisted_canonical_key = "not_assigned_by_llm";
  if (!(f.evidence?.length)) missingReasons.evidence_ids = "evidence_array_not_populated";
  if (cycleDetected) missingReasons.cycle = "cycle_detected_in_ancestry";
  if (missingParents.length > 0) missingReasons.missing_parents = `ids:${missingParents.join(",")}`;
  if (!(f.claim_ids?.length)) missingReasons.claim_ids = "claim_ids_not_populated";
  if (!(f.source_docs?.length)) missingReasons.source_document_ids = "source_docs_not_populated";
  missingReasons.reportability = "not_persisted_at_this_stage";
  if (!representative_member && (parents.length > 0 || children.length > 0)) {
    missingReasons.representative_member = "no_persisted_merge_decision_on_this_finding";
  }
  if (ambiguous) missingReasons.ambiguous_parentage = "same_parent_id_in_multiple_nodes";

  const fp = computeFactualFingerprint(f);
  const occId = `${occ.key.stage}:N${occ.key.nodeIndex}:${fid}:${globalOccIdx}`;

  return {
    run_id: runId, deal_id: dealId, module_id: moduleId,
    stage: occ.key.stage,
    analysis_node_id: `L${occ.key.level}:N${occ.key.nodeIndex}`,
    stage_occurrence_id: occId,
    occurrence_index: globalOccIdx,
    finding_id: fid,
    all_leaf_ancestor_ids: leafIds,
    source_proposition: f.title ?? null,
    normalized_proposition_hash: fnv1a(normalize(f.title)),
    factual_fingerprint_hash: fp.hash,
    persisted_canonical_key: f.issue_key ?? null,
    canonical_key_origin: f.issue_key ? "legacy" : "missing",
    claim_ids: f.claim_ids ?? [],
    disclosure_ids: f.evidence_docs ?? [],
    evidence_ids: (f.evidence ?? []).map(e => e.figure),
    source_document_ids: f.source_docs ?? [],
    source_coordinates: (f.evidence ?? []).map(e => e.cell_coordinate).filter(Boolean) as string[],
    severity: f.severity,
    reportability,
    parent_ids: parents,
    child_ids: children,
    merge_level: occ.key.level,
    representative_member,
    first_stage_appeared: firstStage,
    degraded_fallback_flag: occ.degraded,
    persisted_degraded_group_id,
    diagnostic_node_group_id,
    degraded_group_identity_source,
    terminal_descendant_ids: termDescendants,
    raw_payload_hash: fnv1a(JSON.stringify(f)),
    lineage_status: classification,
    ambiguous_parentage: ambiguous,
    candidate_parent_occurrences: ambiguous
      ? graph.getCandidateParentOccurrences(fid).map(o => occKeyStr(o.key))
      : [],
    missing_field_reasons: missingReasons,
  };
}
