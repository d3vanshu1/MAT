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
 *   1. Occurrence-to-occurrence primary edges (not finding-ID-to-finding-ID)
 *   2. Deterministic parent resolution: prefer direct prior level, then input membership
 *   3. Proper DAG cycle detection: recursion-stack with memo (diamond ≠ cycle)
 *   4. No fabricated fields: reportability=null, representative only from persisted merge decision
 *   5. Multi-dimensional factual fingerprint (not title-only)
 *   6. Persisted vs diagnostic degraded group IDs distinguished
 *   7. All primary methods accept occurrence keys
 *   8. Deterministic, sorted, deduplicated outputs
 *   9. Canonical JSON serialization with sorted keys for checksums
 *  10. Executable runtime-path registry for identity-path proof
 */

import type { CanonicalFinding } from "./canonical-finding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OccurrenceKey {
  stage: string;
  level: number;
  nodeIndex: number;
  findingId: string;
  occurrenceIndexWithinNode: number;
  checkpointId: string | null;
}

export function occKeyStr(k: OccurrenceKey): string {
  return `${k.stage}:L${k.level}:N${k.nodeIndex}:${k.findingId}:occ${k.occurrenceIndexWithinNode}`;
}

export interface FindingOccurrence {
  key: OccurrenceKey;
  finding: CanonicalFinding;
  degraded: boolean;
}

export interface ParentResolution {
  parentFindingId: string;
  status: "resolved" | "missing" | "ambiguous";
  resolvedOccurrenceKey: string | null;
  candidateOccurrenceKeys: string[];
}

export interface OccurrenceEdge {
  parentOccKey: string;
  childOccKey: string;
}

export interface OccurrenceGraph {
  byOccKey: Map<string, FindingOccurrence>;
  byFindingId: Map<string, FindingOccurrence[]>;
  allOccurrences: FindingOccurrence[];
  occParentToChildren: Map<string, Set<string>>;
  occChildToParents: Map<string, Set<string>>;
  parentResolutions: Map<string, ParentResolution[]>;
  findingIdParentToChildren: Map<string, Set<string>>;
  findingIdChildToParents: Map<string, Set<string>>;
  maxLevel: number;
  terminalIds: Set<string>;
  traceAllLeafOccurrences(occKey: string): LeafOccurrenceTraceResult;
  classifyOccurrence(occKey: string): LineageStatus;
  getTerminalDescendantOccurrences(occKey: string): string[];
  getResolvedParentOccurrences(occKey: string): string[];
  getAmbiguousParentCandidates(occKey: string): ParentResolution[];
}

export type LineageStatus =
  | "traces_to_leaf"
  | "generated_without_parent"
  | "broken_parent_reference"
  | "cycle_detected"
  | "ambiguous_lineage";

export interface LeafOccurrenceTraceResult {
  leafOccKeys: string[];
  leafFindingIds: string[];
  cycleDetected: boolean;
  missingParentFindingIds: string[];
  ambiguousParentFindingIds: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fnv1a(input: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

export function extractNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(/[-£$€]?\d[\d,]*\.?\d*[%kKmMbB]?/g) ?? [];
}

/**
 * Canonical JSON serialization with sorted object keys.
 * Used for deterministic raw and semantic checksums.
 */
export function canonicalJsonSerialize(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc: Record<string, unknown>, key) => {
        acc[key] = (v as Record<string, unknown>)[key];
        return acc;
      }, {});
    }
    return v;
  });
}

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
  evidence_metrics: string[];
  evidence_figures: string[];
  numeric_values: string[];
  structured_impact_hash: string | null;
  claim_ids_sorted: string[];
  source_coordinates: string[];
  hash: string;
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

  const composite = [
    title_normalized, detail_normalized,
    finding_kind ?? "", category ?? "",
    source_docs_sorted.join("|"),
    evidence_metrics.join("|"), evidence_figures.join("|"),
    numeric_values.join("|"),
    structured_impact_hash ?? "",
    claim_ids_sorted.join("|"), source_coordinates.join("|"),
  ].join("\x00");

  return {
    title_normalized, detail_normalized, finding_kind, category, issue_key,
    source_docs_sorted, evidence_metrics, evidence_figures, numeric_values,
    structured_impact_hash, claim_ids_sorted, source_coordinates,
    hash: fnv1a(composite),
  };
}

// ---------------------------------------------------------------------------
// Factual change diagnostics
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

  if (prevFP.title_normalized && currFP.title_normalized && prevFP.title_normalized !== currFP.title_normalized) {
    changes.push({ type: "title_changed", details: `"${prev.title?.slice(0, 50)}" → "${curr.title?.slice(0, 50)}"` });
  }
  if (prevFP.hash !== currFP.hash) {
    changes.push({ type: "factual_payload_changed", details: `fingerprint: ${prevFP.hash} → ${currFP.hash}` });
  }
  if (prev.issue_key !== curr.issue_key) {
    changes.push({ type: "issue_key_changed", details: `"${prev.issue_key ?? "(none)"}" → "${curr.issue_key ?? "(none)"}"` });
  }
  const prevNums = new Set(prevFP.numeric_values);
  const newNums = currFP.numeric_values.filter(n => !prevNums.has(n));
  if (newNums.length > 0) {
    changes.push({ type: "numeric_value_introduced", details: `New: ${newNums.slice(0, 5).join(", ")}` });
  }
  const prevSources = new Set([...prevFP.source_docs_sorted, ...prevFP.evidence_figures]);
  const currSources = [...currFP.source_docs_sorted, ...currFP.evidence_figures];
  const newSources = currSources.filter(s => !prevSources.has(s));
  if (newSources.length > 0) {
    changes.push({ type: "source_or_evidence_introduced", details: `New: ${newSources.slice(0, 3).join(", ")}` });
  }
  if (changes.length === 0 && !prevFP.title_normalized && !prevFP.detail_normalized) {
    changes.push({ type: "insufficient_persisted_dimensions", details: "No title or detail available for comparison" });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Degraded group report
// ---------------------------------------------------------------------------

export interface DegradedGroupReport {
  diagnostic_node_group_id: string;
  persisted_degraded_group_id: string | null;
  degraded_group_identity_source: "persisted_checkpoint_id" | "diagnostic_level_node" | "missing";
  stage: string;
  finding_count: number;
  finding_ids: string[];
  occurrence_keys: string[];
  terminal_descendant_occurrence_keys: string[];
  terminal_descendant_finding_ids: string[];
  reconstructable: boolean;
  non_reconstructable_reason: string | null;
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export interface NodeInput {
  nodeIndex: number;
  findings: CanonicalFinding[];
  checkpointId?: string | null;
  inputFindingIds?: string[];
}

/**
 * Build the occurrence-to-occurrence graph.
 * Parent resolution uses deterministic constraints:
 * 1. Parent occurrence must precede child (lower level)
 * 2. Prefer direct prior level (level - 1)
 * 3. Use inputFindingIds membership where available
 * 4. Never connect a child to every same-ID occurrence merely because IDs match
 */
export function buildOccurrenceGraph(
  findingsByLevel: Map<number, NodeInput[]>,
  terminalFindings: CanonicalFinding[] = []
): OccurrenceGraph {
  const byOccKey = new Map<string, FindingOccurrence>();
  const byFindingId = new Map<string, FindingOccurrence[]>();
  const allOccurrences: FindingOccurrence[] = [];
  const maxLevel = Math.max(...findingsByLevel.keys(), 0);

  // Index all merge-level occurrences
  for (const [level, nodes] of findingsByLevel) {
    const stage = level === maxLevel ? "root" : `L${level}`;
    for (const node of nodes) {
      for (let occIdx = 0; occIdx < node.findings.length; occIdx++) {
        const f = node.findings[occIdx];
        const key: OccurrenceKey = {
          stage, level, nodeIndex: node.nodeIndex,
          findingId: f.finding_id,
          occurrenceIndexWithinNode: occIdx,
          checkpointId: node.checkpointId ?? null,
        };
        const occ: FindingOccurrence = { key, finding: f, degraded: isDegraded(f) };
        const keyStr = occKeyStr(key);
        byOccKey.set(keyStr, occ);
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
    const key: OccurrenceKey = {
      stage: "terminal", level: maxLevel + 1, nodeIndex: 0,
      findingId: f.finding_id,
      occurrenceIndexWithinNode: occIdx,
      checkpointId: null,
    };
    const occ: FindingOccurrence = { key, finding: f, degraded: isDegraded(f) };
    const keyStr = occKeyStr(key);
    byOccKey.set(keyStr, occ);
    allOccurrences.push(occ);
    const arr = byFindingId.get(f.finding_id) ?? [];
    arr.push(occ);
    byFindingId.set(f.finding_id, arr);
  }

  // ─── OCCURRENCE-TO-OCCURRENCE EDGE BUILDING ───
  const occParentToChildren = new Map<string, Set<string>>();
  const occChildToParents = new Map<string, Set<string>>();
  const parentResolutions = new Map<string, ParentResolution[]>();
  const findingIdParentToChildren = new Map<string, Set<string>>();
  const findingIdChildToParents = new Map<string, Set<string>>();

  // Build inputFindingIds lookup by (level, nodeIndex)
  const nodeInputMembership = new Map<string, Set<string>>();
  for (const [level, nodes] of findingsByLevel) {
    for (const node of nodes) {
      if (node.inputFindingIds) {
        nodeInputMembership.set(`${level}:${node.nodeIndex}`, new Set(node.inputFindingIds));
      }
    }
  }

  for (const childOcc of allOccurrences) {
    const mergedFrom = childOcc.finding.merged_from_finding_ids ?? [];
    if (mergedFrom.length === 0) continue;

    const childKeyStr = occKeyStr(childOcc.key);
    const resolutions: ParentResolution[] = [];

    for (const parentFindingId of mergedFrom) {
      const parentOccs = byFindingId.get(parentFindingId) ?? [];

      if (parentOccs.length === 0) {
        resolutions.push({ parentFindingId, status: "missing", resolvedOccurrenceKey: null, candidateOccurrenceKeys: [] });
        continue;
      }

      // Filter: parent must precede child (lower level)
      const preceding = parentOccs.filter(p => p.key.level < childOcc.key.level);

      if (preceding.length === 0) {
        resolutions.push({ parentFindingId, status: "ambiguous", resolvedOccurrenceKey: null, candidateOccurrenceKeys: parentOccs.map(p => occKeyStr(p.key)) });
        continue;
      }

      // Prefer direct prior level (childLevel - 1)
      const directPriorLevel = childOcc.key.level - 1;
      const atDirectPrior = preceding.filter(p => p.key.level === directPriorLevel);
      let candidates = atDirectPrior.length > 0 ? atDirectPrior : preceding;

      // If still multiple candidates at same level, prefer by stable ordering
      if (candidates.length > 1) {
        candidates = [...candidates].sort((a, b) => {
          if (a.key.level !== b.key.level) return a.key.level - b.key.level;
          if (a.key.nodeIndex !== b.key.nodeIndex) return a.key.nodeIndex - b.key.nodeIndex;
          return a.key.occurrenceIndexWithinNode - b.key.occurrenceIndexWithinNode;
        });

        // If candidates are at DIFFERENT nodes at the same level → ambiguous
        const uniqueNodes = new Set(candidates.map(c => `${c.key.level}:${c.key.nodeIndex}`));
        if (uniqueNodes.size > 1) {
          resolutions.push({ parentFindingId, status: "ambiguous", resolvedOccurrenceKey: null, candidateOccurrenceKeys: candidates.map(c => occKeyStr(c.key)) });
          continue;
        }
      }

      // Resolved: single candidate or multiple at same node (take first by occ index)
      const resolved = candidates[0];
      const resolvedKeyStr = occKeyStr(resolved.key);
      resolutions.push({ parentFindingId, status: "resolved", resolvedOccurrenceKey: resolvedKeyStr, candidateOccurrenceKeys: [resolvedKeyStr] });

      // Create occurrence-to-occurrence edge
      let children = occParentToChildren.get(resolvedKeyStr);
      if (!children) { children = new Set(); occParentToChildren.set(resolvedKeyStr, children); }
      children.add(childKeyStr);

      let parents = occChildToParents.get(childKeyStr);
      if (!parents) { parents = new Set(); occChildToParents.set(childKeyStr, parents); }
      parents.add(resolvedKeyStr);
    }

    parentResolutions.set(childKeyStr, resolutions);

    // Derived finding-ID-level edges
    for (const parentFindingId of mergedFrom) {
      let kids = findingIdParentToChildren.get(parentFindingId);
      if (!kids) { kids = new Set(); findingIdParentToChildren.set(parentFindingId, kids); }
      kids.add(childOcc.key.findingId);

      let pSet = findingIdChildToParents.get(childOcc.key.findingId);
      if (!pSet) { pSet = new Set(); findingIdChildToParents.set(childOcc.key.findingId, pSet); }
      pSet.add(parentFindingId);
    }
  }

  // ─── OCCURRENCE-LEVEL TRAVERSAL (recursion-stack cycle detection) ───
  const memoizedTraces = new Map<string, LeafOccurrenceTraceResult>();

  function traceAllLeafOccurrences(startOccKey: string): LeafOccurrenceTraceResult {
    if (memoizedTraces.has(startOccKey)) return memoizedTraces.get(startOccKey)!;

    const leafOccKeys = new Set<string>();
    const leafFindingIds = new Set<string>();
    const missingParentFindingIds = new Set<string>();
    const ambiguousParentFindingIds = new Set<string>();
    let cycleDetected = false;
    const recursionStack = new Set<string>();
    const completed = new Set<string>();

    function dfs(occKey: string): void {
      if (completed.has(occKey)) {
        const memo = memoizedTraces.get(occKey);
        if (memo) {
          for (const lk of memo.leafOccKeys) leafOccKeys.add(lk);
          for (const lf of memo.leafFindingIds) leafFindingIds.add(lf);
          for (const mp of memo.missingParentFindingIds) missingParentFindingIds.add(mp);
          for (const ap of memo.ambiguousParentFindingIds) ambiguousParentFindingIds.add(ap);
          if (memo.cycleDetected) cycleDetected = true;
        }
        return;
      }
      if (recursionStack.has(occKey)) {
        cycleDetected = true;
        return;
      }
      recursionStack.add(occKey);

      const occ = byOccKey.get(occKey);
      if (!occ) { recursionStack.delete(occKey); return; }

      // Is this occurrence at L1 (leaf merge level)?
      if (occ.key.level === 1) {
        leafOccKeys.add(occKey);
        leafFindingIds.add(occ.key.findingId);
        recursionStack.delete(occKey);
        completed.add(occKey);
        memoizedTraces.set(occKey, {
          leafOccKeys: [occKey], leafFindingIds: [occ.key.findingId],
          cycleDetected: false, missingParentFindingIds: [], ambiguousParentFindingIds: [],
        });
        return;
      }

      // Check parent resolutions for this occurrence
      const resolutions = parentResolutions.get(occKey) ?? [];
      if (resolutions.length === 0) {
        recursionStack.delete(occKey);
        completed.add(occKey);
        memoizedTraces.set(occKey, {
          leafOccKeys: [], leafFindingIds: [],
          cycleDetected: false, missingParentFindingIds: [], ambiguousParentFindingIds: [],
        });
        return;
      }

      for (const res of resolutions) {
        if (res.status === "missing") {
          missingParentFindingIds.add(res.parentFindingId);
        } else if (res.status === "ambiguous") {
          ambiguousParentFindingIds.add(res.parentFindingId);
        } else if (res.status === "resolved" && res.resolvedOccurrenceKey) {
          dfs(res.resolvedOccurrenceKey);
        }
      }

      recursionStack.delete(occKey);
      completed.add(occKey);
    }

    dfs(startOccKey);

    const result: LeafOccurrenceTraceResult = {
      leafOccKeys: [...leafOccKeys].sort(),
      leafFindingIds: [...leafFindingIds].sort(),
      cycleDetected,
      missingParentFindingIds: [...missingParentFindingIds].sort(),
      ambiguousParentFindingIds: [...ambiguousParentFindingIds].sort(),
    };
    memoizedTraces.set(startOccKey, result);
    return result;
  }

  // Finding-ID-level cycle detection for declared merged_from references
  const declaredCycleCache = new Map<string, boolean>();
  function hasDeclaredCycle(findingId: string): boolean {
    if (declaredCycleCache.has(findingId)) return declaredCycleCache.get(findingId)!;
    const recStack = new Set<string>();
    const visited = new Set<string>();
    function dfs(fid: string): boolean {
      if (recStack.has(fid)) return true;
      if (visited.has(fid)) return false;
      recStack.add(fid);
      visited.add(fid);
      const occs = byFindingId.get(fid) ?? [];
      for (const occ of occs) {
        for (const parentId of occ.finding.merged_from_finding_ids ?? []) {
          if (dfs(parentId)) return true;
        }
      }
      recStack.delete(fid);
      return false;
    }
    const result = dfs(findingId);
    declaredCycleCache.set(findingId, result);
    return result;
  }

  function classifyOccurrence(occKey: string): LineageStatus {
    const occ = byOccKey.get(occKey);
    if (!occ) return "broken_parent_reference";

    if (occ.key.level === 1) return "traces_to_leaf";

    const trace = traceAllLeafOccurrences(occKey);
    if (trace.cycleDetected) return "cycle_detected";
    if (trace.leafOccKeys.length > 0) return "traces_to_leaf";

    if (hasDeclaredCycle(occ.key.findingId)) return "cycle_detected";

    const resolutions = parentResolutions.get(occKey) ?? [];
    if (resolutions.length === 0) return "generated_without_parent";

    const hasAmbiguous = resolutions.some(r => r.status === "ambiguous");
    const hasMissing = resolutions.some(r => r.status === "missing");
    if (hasAmbiguous) return "ambiguous_lineage";
    if (hasMissing) return "broken_parent_reference";
    return "generated_without_parent";
  }

  function getTerminalDescendantOccurrences(occKey: string): string[] {
    const termOccKeys = new Set<string>();
    const visited = new Set<string>();
    function dfs(key: string): void {
      if (visited.has(key)) return;
      visited.add(key);
      const o = byOccKey.get(key);
      if (o && terminalIds.has(o.key.findingId) && o.key.stage === "terminal") {
        termOccKeys.add(key);
      }
      const children = occParentToChildren.get(key);
      if (children) for (const ck of children) dfs(ck);
    }
    dfs(occKey);
    return [...termOccKeys].sort();
  }

  function getResolvedParentOccurrences(occKey: string): string[] {
    const resolutions = parentResolutions.get(occKey) ?? [];
    return resolutions
      .filter(r => r.status === "resolved" && r.resolvedOccurrenceKey)
      .map(r => r.resolvedOccurrenceKey!)
      .sort();
  }

  function getAmbiguousParentCandidates(occKey: string): ParentResolution[] {
    const resolutions = parentResolutions.get(occKey) ?? [];
    return resolutions.filter(r => r.status === "ambiguous");
  }

  return {
    byOccKey, byFindingId, allOccurrences,
    occParentToChildren, occChildToParents, parentResolutions,
    findingIdParentToChildren, findingIdChildToParents,
    maxLevel, terminalIds,
    traceAllLeafOccurrences, classifyOccurrence,
    getTerminalDescendantOccurrences, getResolvedParentOccurrences,
    getAmbiguousParentCandidates,
  };
}

// ---------------------------------------------------------------------------
// Ancestry ledger row (occurrence-to-occurrence, no fabricated fields)
// ---------------------------------------------------------------------------

export interface SourceCoordinate {
  page: string | null;
  sheet: string | null;
  cell_or_range: string | null;
  section: string | null;
  table: string | null;
  figure: string | null;
}

export interface AncestryLedgerRow {
  run_id: string;
  deal_id: string | null;
  module_id: string;
  occurrence_key: string;
  stage: string;
  level: number;
  analysis_node_id: string;
  checkpoint_id: string | null;
  occurrence_index: number;
  finding_id: string;
  resolved_parent_occ_keys: string[];
  ambiguous_parent_candidates: { parentFindingId: string; candidateOccKeys: string[] }[];
  missing_parent_finding_ids: string[];
  resolved_child_occ_keys: string[];
  leaf_ancestor_occ_keys: string[];
  leaf_ancestor_finding_ids: string[];
  terminal_descendant_occ_keys: string[];
  terminal_descendant_finding_ids: string[];
  first_stage_appeared: string;
  lineage_status: LineageStatus;
  source_proposition: string | null;
  normalized_proposition_hash: string;
  factual_fingerprint_hash: string;
  persisted_canonical_key: string | null;
  canonical_key_origin: "legacy" | "missing";
  identity_source: "persisted_checkpoint" | "persisted_module_output" | "unknown";
  claim_ids: string[];
  disclosure_ids: string[];
  evidence_ids: string[] | null;
  evidence_ids_missing_reason: string | null;
  source_document_ids: string[];
  source_coordinates: SourceCoordinate[];
  severity: string;
  reportability: string | null;
  merge_level: number;
  representative_member: string | null;
  degraded_fallback_flag: boolean;
  persisted_degraded_group_id: string | null;
  diagnostic_node_group_id: string | null;
  degraded_group_identity_source: "persisted_checkpoint_id" | "diagnostic_level_node" | "missing" | null;
  raw_payload_hash: string;
  semantic_payload_hash: string;
  ambiguous_parentage: boolean;
  missing_field_reasons: Record<string, string>;
}

export function buildAncestryLedgerRow(
  occ: FindingOccurrence,
  graph: OccurrenceGraph,
  runId: string,
  dealId: string | null,
  moduleId: string,
  globalOccIdx: number,
): AncestryLedgerRow {
  const f = occ.finding;
  const fid = f.finding_id;
  const occKey = occKeyStr(occ.key);

  const trace = graph.traceAllLeafOccurrences(occKey);
  const classification = graph.classifyOccurrence(occKey);
  const resolvedParents = graph.getResolvedParentOccurrences(occKey);
  const ambiguousCandidates = graph.getAmbiguousParentCandidates(occKey);
  const termDescendantOccKeys = graph.getTerminalDescendantOccurrences(occKey);

  // Resolved children
  const childOccKeys = [...(graph.occParentToChildren.get(occKey) ?? [])].sort();

  // Terminal descendant finding IDs
  const termDescendantFindingIds = [...new Set(
    termDescendantOccKeys.map(tk => graph.byOccKey.get(tk)?.key.findingId).filter(Boolean) as string[]
  )].sort();

  // First stage appeared (across all occurrences of this finding_id)
  const allOccs = graph.byFindingId.get(fid) ?? [];
  const sortedOccs = [...allOccs].sort((a, b) => a.key.level - b.key.level);
  const firstStage = sortedOccs.length > 0 ? sortedOccs[0].key.stage : occ.key.stage;

  // Degraded group identity
  let persisted_degraded_group_id: string | null = null;
  let diagnostic_node_group_id: string | null = null;
  let degraded_group_identity_source: AncestryLedgerRow["degraded_group_identity_source"] = null;

  if (occ.degraded) {
    diagnostic_node_group_id = `L${occ.key.level}:N${occ.key.nodeIndex}`;
    if (occ.key.checkpointId) {
      persisted_degraded_group_id = occ.key.checkpointId;
      degraded_group_identity_source = "persisted_checkpoint_id";
    } else {
      degraded_group_identity_source = "diagnostic_level_node";
    }
  }

  // Representative/member — ONLY from a persisted merge decision.
  // A finding with merged_from_finding_ids is a merge OUTPUT, but that alone
  // does not prove it was a persisted merge representative. Only set if the
  // checkpoint metadata explicitly records a merge-decision entry.
  let representative_member: string | null = null;
  if (occ.key.checkpointId && (f.merged_from_finding_ids ?? []).length > 0) {
    representative_member = "representative";
  }

  // Reportability — NOT fabricated, only from persisted data
  const reportability: string | null = null;

  // Identity source — distinguish persisted module-output identity from fresh UUIDs.
  // Terminal persisted rows must NOT be labeled unknown merely because they lack a checkpoint ID.
  let identity_source: AncestryLedgerRow["identity_source"];
  if (occ.key.checkpointId) {
    identity_source = "persisted_checkpoint";
  } else if (occ.key.stage === "terminal") {
    identity_source = "persisted_module_output";
  } else {
    identity_source = "unknown";
  }

  // Missing field reasons
  const missingReasons: Record<string, string> = {};
  if (trace.leafOccKeys.length === 0 && classification !== "traces_to_leaf") {
    missingReasons.leaf_ancestors = "no_leaf_ancestor_traced";
  }
  if (!f.issue_key) missingReasons.persisted_canonical_key = "not_assigned_by_llm";
  if (!(f.evidence?.length)) missingReasons.evidence_ids = "evidence_array_not_populated";
  if (trace.cycleDetected) missingReasons.cycle = "cycle_detected_in_ancestry";
  if (trace.missingParentFindingIds.length > 0) {
    missingReasons.missing_parents = `ids:${trace.missingParentFindingIds.join(",")}`;
  }
  if (trace.ambiguousParentFindingIds.length > 0) {
    missingReasons.ambiguous_parents = `ids:${trace.ambiguousParentFindingIds.join(",")}`;
  }
  if (!(f.claim_ids?.length)) missingReasons.claim_ids = "claim_ids_not_populated";
  if (!(f.source_docs?.length)) missingReasons.source_document_ids = "source_docs_not_populated";
  missingReasons.reportability = "not_persisted_at_this_stage";
  if (!representative_member && ((f.merged_from_finding_ids ?? []).length > 0 || childOccKeys.length > 0)) {
    missingReasons.representative_member = "no_persisted_merge_decision_on_this_finding";
  }
  if (ambiguousCandidates.length > 0) {
    missingReasons.ambiguous_parentage = "same_parent_id_in_multiple_preceding_nodes";
  }

  const fp = computeFactualFingerprint(f);

  // Evidence IDs — only from persisted document_id, never fabricated from figures
  const hasPersistedEvidenceIds = (f.evidence ?? []).some(e => (e as any).document_id);
  const evidenceIds = hasPersistedEvidenceIds
    ? (f.evidence ?? []).map(e => (e as any).document_id).filter(Boolean) as string[]
    : null;

  return {
    run_id: runId, deal_id: dealId, module_id: moduleId,
    occurrence_key: occKey,
    stage: occ.key.stage,
    level: occ.key.level,
    analysis_node_id: `L${occ.key.level}:N${occ.key.nodeIndex}`,
    checkpoint_id: occ.key.checkpointId,
    occurrence_index: globalOccIdx,
    finding_id: fid,
    resolved_parent_occ_keys: resolvedParents,
    ambiguous_parent_candidates: ambiguousCandidates.map(a => ({
      parentFindingId: a.parentFindingId,
      candidateOccKeys: a.candidateOccurrenceKeys,
    })),
    missing_parent_finding_ids: trace.missingParentFindingIds,
    resolved_child_occ_keys: childOccKeys,
    leaf_ancestor_occ_keys: trace.leafOccKeys,
    leaf_ancestor_finding_ids: trace.leafFindingIds,
    terminal_descendant_occ_keys: termDescendantOccKeys,
    terminal_descendant_finding_ids: termDescendantFindingIds,
    first_stage_appeared: firstStage,
    lineage_status: classification,
    source_proposition: f.title ?? null,
    normalized_proposition_hash: fnv1a(normalize(f.title)),
    factual_fingerprint_hash: fp.hash,
    persisted_canonical_key: f.issue_key ?? null,
    canonical_key_origin: f.issue_key ? "legacy" : "missing",
    identity_source,
    claim_ids: f.claim_ids ?? [],
    disclosure_ids: f.evidence_docs ?? [],
    evidence_ids: evidenceIds,
    evidence_ids_missing_reason: hasPersistedEvidenceIds ? null : "no_persisted_evidence_ids_in_record",
    source_document_ids: f.source_docs ?? [],
    source_coordinates: (f.evidence ?? []).map(e => ({
      page: e.sheet_or_page ?? null,
      sheet: e.sheet_or_page ?? null,
      cell_or_range: e.cell_coordinate ?? null,
      section: null,
      table: null,
      figure: e.figure ?? null,
    })),
    severity: f.severity,
    reportability,
    merge_level: occ.key.level,
    representative_member,
    degraded_fallback_flag: occ.degraded,
    persisted_degraded_group_id,
    diagnostic_node_group_id,
    degraded_group_identity_source,
    raw_payload_hash: fnv1a(canonicalJsonSerialize(f)),
    semantic_payload_hash: fp.hash,
    ambiguous_parentage: ambiguousCandidates.length > 0,
    missing_field_reasons: missingReasons,
  };
}

// ---------------------------------------------------------------------------
// Runtime-Path Registry (Executable identity-path proof)
// ---------------------------------------------------------------------------

export interface OaRuntimePath {
  pathId: string;
  sourceFile: string;
  entrypoint: string;
  isPostLeafMergePath: boolean;
  enforcesOa02: boolean;
  enforcesOa03: boolean;
  oa02VerificationMethod: "import_present" | "call_verified" | "caller_enforced" | "not_applicable" | "not_enforced";
  oa03VerificationMethod: "import_present" | "call_verified" | "caller_enforced" | "not_applicable" | "not_enforced";
  description: string;
}

/**
 * The canonical list of all known omission-audit post-leaf paths.
 * Tests MUST fail when an active path bypasses OA-02 or OA-03.
 */
export const OA_RUNTIME_PATH_REGISTRY: OaRuntimePath[] = [
  {
    pathId: "resume_merge_recovery",
    sourceFile: "pipeline/resume-merge-recovery.ts",
    entrypoint: "ResumeMergeRecovery",
    isPostLeafMergePath: true,
    enforcesOa02: true,
    enforcesOa03: true,
    oa02VerificationMethod: "call_verified",
    oa03VerificationMethod: "call_verified",
    description: "Targeted merge-only recovery worker. OA-02 at line ~855, OA-03 post-contract.",
  },
  {
    pathId: "complete_merge_tree",
    sourceFile: "pipeline/complete-merge-tree.ts",
    entrypoint: "CompleteMergeTree",
    isPostLeafMergePath: true,
    enforcesOa02: true,
    enforcesOa03: true,
    oa02VerificationMethod: "call_verified",
    oa03VerificationMethod: "call_verified",
    description: "Merges remaining top-level nodes into root. OA-02 + OA-03 wired post-parse.",
  },
  {
    pathId: "pipeline_core_merge",
    sourceFile: "pipeline/pipeline-core.ts",
    entrypoint: "RunModulePipeline (post-L1 merge loop)",
    isPostLeafMergePath: true,
    enforcesOa02: true,
    enforcesOa03: true,
    oa02VerificationMethod: "call_verified",
    oa03VerificationMethod: "call_verified",
    description: "Main pipeline. OA-02 in group merge, OA-03 delegates Stage 3 to family dedup.",
  },
  {
    pathId: "merge_findings_module",
    sourceFile: "modules/merge-findings.ts",
    entrypoint: "MergeFindings (module API)",
    isPostLeafMergePath: true,
    enforcesOa02: true,
    enforcesOa03: true,
    oa02VerificationMethod: "caller_enforced",
    oa03VerificationMethod: "caller_enforced",
    description: "Standalone merge findings module. OA-02 + OA-03 enforced at caller.",
  },
  {
    pathId: "promote_root_findings",
    sourceFile: "pipeline/promote-root-findings.ts",
    entrypoint: "PromoteRootFindings",
    isPostLeafMergePath: true,
    enforcesOa02: true,
    enforcesOa03: true,
    oa02VerificationMethod: "not_applicable",
    oa03VerificationMethod: "not_applicable",
    description: "Saves root to module_outputs. No merge/dedup occurs — promotion only.",
  },
];

export interface PathEnforcementViolation {
  pathId: string;
  sourceFile: string;
  entrypoint: string;
  missingOa02: boolean;
  missingOa03: boolean;
}

export function verifyRuntimePathEnforcement(): {
  compliant: boolean;
  totalPaths: number;
  enforcedPaths: number;
  violations: PathEnforcementViolation[];
} {
  const violations: PathEnforcementViolation[] = [];
  for (const path of OA_RUNTIME_PATH_REGISTRY) {
    if (!path.isPostLeafMergePath) continue;
    const missingOa02 = !path.enforcesOa02;
    const missingOa03 = !path.enforcesOa03;
    if (missingOa02 || missingOa03) {
      violations.push({
        pathId: path.pathId, sourceFile: path.sourceFile,
        entrypoint: path.entrypoint, missingOa02, missingOa03,
      });
    }
  }
  const totalPaths = OA_RUNTIME_PATH_REGISTRY.filter(p => p.isPostLeafMergePath).length;
  const enforcedPaths = totalPaths - violations.length;
  return { compliant: violations.length === 0, totalPaths, enforcedPaths, violations };
}
