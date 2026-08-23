/**
 * Coordinate-level finding dedup — shared primitives.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The pipeline already contained a thorough, well-tested consolidation
 * implementation: union-find clustering guarded by a 14-field compatibility gate,
 * an identity extractor that derives coordinates from `evidence[]` /
 * `structured_impact[]` when top-level fields are absent, a bridge-merge
 * prevention rule, and a provenance union that preserves claim_ids, source_docs,
 * evidence, structured_impact and absorbed analyses.
 *
 * That implementation lived as LOCAL CLOSURES inside `runPostMergePipeline`
 * (pipeline-core.ts). It was therefore reachable from exactly one place: once,
 * after the whole merge tree had already converged. The merge loop itself — where
 * Fix 16 carries unaccounted findings forward verbatim — could not call it.
 *
 * The consequence was structural accumulation. Fix 16 appends a carried finding
 * without ever asking whether the node already holds an equivalent one, so
 * finding counts grow monotonically up the tree. Measured on run 13e9c0d6:
 * 84-93% of findings at L6:0 / L7:0 / L8:0 were code-carried rather than
 * model-synthesized, and the emission requirement at L7:0 (~56k output tokens)
 * exceeded what the merge call can produce inside its timeout. The tree
 * deadlocked at MAX_PARTIAL_RETRIES.
 *
 * This module lifts those primitives out verbatim (de-indexed to operate on
 * objects instead of array positions) so there is ONE implementation with TWO
 * call sites:
 *   1. `runPostMergePipeline` — global consolidation after the tree completes.
 *   2. The Fix 16 carry-forward point — per-node, before a carried finding is
 *      appended.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - Deterministic. No model call, no token cost. Runs in the merge hot path.
 * - Fail-safe toward preservation. Absorption requires a fully determined
 *   coordinate AND a passing compatibility gate. Any doubt → carry forward
 *   verbatim, exactly as before.
 * - Accounting-preserving. Absorption records the absorbed finding's id in the
 *   representative's `merged_from_finding_ids`. Fix 16's zero-tolerance contract
 *   is satisfied "by reference" — which is precisely the second of the three
 *   accounting outcomes it already recognizes. No finding is lost; the COUNT
 *   drops because duplicates become provenance instead of payload.
 */

/** Loose finding shape — the merge path carries heterogeneous finding objects. */
export type AnyFinding = Record<string, any>;

// ---------------------------------------------------------------------------
// Identity extraction (lifted from runPostMergePipeline, Corrective F)
// ---------------------------------------------------------------------------

/**
 * Extract deterministic identity from a finding, including its evidence and
 * structured_impact arrays.
 *
 * Returns a map of identity dimension → Set of canonical values. Absence of a
 * dimension returns no entry (neutral — not blocking).
 */
export function extractStructuredIdentity(finding: AnyFinding): Map<string, Set<string>> {
  const identity = new Map<string, Set<string>>();

  const addValue = (key: string, value: string | undefined | null) => {
    if (!value || typeof value !== "string") return;
    const normalized = value.toLowerCase().trim();
    if (!normalized) return;
    if (!identity.has(key)) identity.set(key, new Set());
    identity.get(key)!.add(normalized);
  };

  // Top-level fields
  addValue("metric", finding.metric);
  addValue("period", finding.period);
  addValue("scope", finding.scope);
  addValue("entity", finding.entity);
  addValue("currency", finding.currency);
  addValue("accounting_basis", finding.accounting_basis);
  addValue("actual_vs_forecast", finding.actual_vs_forecast);
  addValue("legal_clause", finding.legal_clause);
  addValue("legal_consequence", finding.legal_consequence);
  addValue("impact_type", finding.impact_type);
  addValue("contract_provision", finding.contract_provision);

  // Evidence array
  const evidence = finding.evidence;
  if (Array.isArray(evidence)) {
    for (const ev of evidence) {
      if (!ev || typeof ev !== "object") continue;
      addValue("metric", ev.metric);
      addValue("period", ev.period);
      addValue("scope", ev.scope);
      addValue("entity", ev.entity);
      addValue("currency", ev.currency);
      addValue("accounting_basis", ev.accounting_basis);
      addValue("actual_vs_forecast", ev.actual_or_forecast);
      addValue("sheet_or_page", ev.sheet_or_page);
      addValue("cell_coordinate", ev.cell_coordinate);
      addValue("source_doc", ev.source_doc);
      addValue("unit", ev.unit);
    }
  }

  // Structured impact array
  const impacts = finding.structured_impact;
  if (Array.isArray(impacts)) {
    for (const imp of impacts) {
      if (!imp || typeof imp !== "object") continue;
      addValue("impact_type", imp.role);
      addValue("currency", imp.currency);
      addValue("source_doc", imp.source_doc);
      addValue("source_coordinate", imp.source_coordinate);
    }
  }

  addValue("finding_kind", finding.finding_kind);

  return identity;
}

/** Dimensions specific enough that asymmetric population blocks a merge. */
const DISCRIMINATING_DIMENSIONS = new Set([
  "metric", "period", "scope", "entity", "sheet_or_page",
  "cell_coordinate", "legal_clause", "legal_consequence",
  "contract_provision", "accounting_basis", "actual_vs_forecast",
]);

/**
 * Check whether two structured identities are compatible.
 *
 * Rules (unchanged from Corrective F):
 * - Both sides populate a dimension with NO overlapping value → conflict.
 * - Only one side populates a DISCRIMINATING dimension → not compatible. The
 *   other finding's silence is not proof of agreement; this is what prevents
 *   bridge merges between a coordinate-specific finding and a generic one.
 * - Absent on both sides → neutral.
 */
export function identitiesAreCompatible(
  idA: Map<string, Set<string>>,
  idB: Map<string, Set<string>>,
): boolean {
  const allDims = new Set([...idA.keys(), ...idB.keys()]);

  for (const dim of allDims) {
    const setA = idA.get(dim);
    const setB = idB.get(dim);

    // Both absent → neutral
    if ((!setA || setA.size === 0) && (!setB || setB.size === 0)) continue;

    // Both present → require overlap
    if (setA && setA.size > 0 && setB && setB.size > 0) {
      let hasOverlap = false;
      for (const v of setA) {
        if (setB.has(v)) { hasOverlap = true; break; }
      }
      if (!hasOverlap) return false;
      continue;
    }

    // Asymmetric population of a discriminating dimension → block
    if (DISCRIMINATING_DIMENSIONS.has(dim)) {
      const populatedSet = setA && setA.size > 0 ? setA : setB;
      if (populatedSet && populatedSet.size > 0) return false;
    }
  }

  return true;
}

/** Top-level gate fields (Fix 17) with their normalizers. */
const GATE_FIELDS: Array<{ key: string; normalize?: (v: string) => string }> = [
  { key: "finding_kind" },
  { key: "metric", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "period", normalize: (v: string) => v.toLowerCase().trim().replace(/\s+/g, "") },
  { key: "scope", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "entity", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "currency" },
  { key: "legal_clause", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "legal_consequence", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "impact_type", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "affected_asset", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "accounting_basis", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "actual_vs_forecast", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "counterparty", normalize: (v: string) => v.toLowerCase().trim() },
  { key: "contract_provision", normalize: (v: string) => v.toLowerCase().trim() },
];

/**
 * Two findings may merge only when no top-level gate field materially conflicts
 * AND their evidence-derived structured identities are compatible.
 *
 * Object-based signature — the post-merge caller previously passed array indices.
 */
export function areCompatibleForMerge(a: AnyFinding, b: AnyFinding): boolean {
  // Gate 1: top-level field conflicts (Fix 17)
  for (const { key, normalize } of GATE_FIELDS) {
    const valA = a[key];
    const valB = b[key];
    // Only compare when BOTH sides have a truthy value
    if (!valA || !valB) continue;
    if (typeof valA !== "string" || typeof valB !== "string") continue;
    const normA = normalize ? normalize(valA) : valA;
    const normB = normalize ? normalize(valB) : valB;
    if (normA !== normB) return false;
  }

  // Gate 2: evidence/structured_impact-derived identity (Corrective F)
  return identitiesAreCompatible(extractStructuredIdentity(a), extractStructuredIdentity(b));
}

// ---------------------------------------------------------------------------
// Coordinate key
// ---------------------------------------------------------------------------

const normText = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const n = v.toLowerCase().trim();
  return n.length > 0 ? n : null;
};

const normPeriod = (v: unknown): string | null => {
  const n = normText(v);
  return n === null ? null : n.replace(/\s+/g, "");
};

/**
 * Build the cheap coordinate prefilter key: metric | scope | period.
 *
 * Falls back to evidence-derived values when top-level fields are absent, but
 * ONLY when the evidence agrees on a single value for that dimension — an
 * ambiguous dimension is treated as undetermined.
 *
 * Returns null when metric or period cannot be determined. A null coordinate
 * means "do not absorb" — the finding is carried forward verbatim. This is the
 * conservative direction: we would rather keep a duplicate than collapse two
 * findings whose coordinates we cannot establish.
 *
 * `scope` is permitted to be absent (many group-level findings legitimately have
 * no scope qualifier) and is rendered as the literal "-" so that a scoped and an
 * unscoped finding never share a key.
 */
export function coordinateKey(finding: AnyFinding): string | null {
  const identity = extractStructuredIdentity(finding);

  const soleValue = (dim: string): string | null => {
    const set = identity.get(dim);
    if (!set || set.size !== 1) return null;
    return [...set][0]!;
  };

  const metric = normText(finding.metric) ?? soleValue("metric");
  if (!metric) return null;

  const period = normPeriod(finding.period) ?? (soleValue("period") === null ? null : normPeriod(soleValue("period")));
  if (!period) return null;

  const scopeRaw = normText(finding.scope) ?? normText(finding.scope_qualifier) ?? soleValue("scope");
  const scope = scopeRaw ?? "-";

  return `${metric}|${scope}|${period}`;
}

// ---------------------------------------------------------------------------
// Provenance union
// ---------------------------------------------------------------------------

const severityRank: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/** Rank a finding's severity; unknown severities rank lowest. */
export function rankSeverity(f: AnyFinding): number {
  return severityRank[String(f?.severity ?? "").toLowerCase()] ?? 0;
}

/**
 * Absorb `absorbed` into `representative`, returning a NEW finding object that
 * carries the union of both provenance sets.
 *
 * What is preserved (mirrors the post-merge consolidation exactly):
 * - claim_ids, source_docs, evidence_docs — set union
 * - evidence[] — deduped on figure|source_doc|snippet-prefix (Fix 15 key), so
 *   coordinate-rich items sharing a figure are not collapsed
 * - structured_impact[] — deduped on amount|role|currency (Fix 15 key)
 * - consolidated_analyses[] — the absorbed finding's full_analysis is retained
 *   for the audit trail rather than discarded
 * - merged_from_finding_ids — the absorbed id plus any ids it had already
 *   absorbed, so provenance chains survive multi-level absorption
 *
 * The representative's own narrative fields (title, detail, full_analysis,
 * severity) are left untouched. Absorption never rewrites prose.
 *
 * Severity escalation is intentionally NOT performed here: the caller chooses
 * the higher-severity finding as representative before calling.
 */
export function absorbInto(representative: AnyFinding, absorbed: AnyFinding): AnyFinding {
  const unionList = (key: string): string[] => {
    const out = new Set<string>();
    for (const src of [representative, absorbed]) {
      const arr = src?.[key];
      if (Array.isArray(arr)) {
        for (const v of arr) if (typeof v === "string" && v) out.add(v);
      }
    }
    return [...out];
  };

  // evidence[] union with Fix 15 dedup key
  const evidence: AnyFinding[] = [];
  const seenEvidence = new Set<string>();
  for (const src of [representative, absorbed]) {
    const arr = src?.evidence;
    if (!Array.isArray(arr)) continue;
    for (const ev of arr) {
      if (!ev || typeof ev !== "object") continue;
      const key = `${ev.figure}|${ev.source_doc}|${String(ev.verbatim_snippet ?? "").slice(0, 80)}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(ev);
    }
  }

  // structured_impact[] union with Fix 15 dedup key
  const structuredImpact: AnyFinding[] = [];
  const seenImpact = new Set<string>();
  for (const src of [representative, absorbed]) {
    const arr = src?.structured_impact;
    if (!Array.isArray(arr)) continue;
    for (const si of arr) {
      if (!si || typeof si !== "object") continue;
      const key = `${si.amount ?? ""}|${si.role ?? ""}|${si.currency ?? ""}`;
      if (seenImpact.has(key)) continue;
      seenImpact.add(key);
      structuredImpact.push(si);
    }
  }

  // Audit trail: keep the absorbed narrative
  const consolidatedAnalyses: string[] = [
    ...(Array.isArray(representative.consolidated_analyses) ? representative.consolidated_analyses : []),
    ...(Array.isArray(absorbed.consolidated_analyses) ? absorbed.consolidated_analyses : []),
  ];
  if (typeof absorbed.full_analysis === "string" && absorbed.full_analysis.length > 0) {
    consolidatedAnalyses.push(absorbed.full_analysis);
  }

  // Provenance ids: the absorbed finding plus anything it already absorbed
  const mergedFrom = new Set<string>(
    Array.isArray(representative.merged_from_finding_ids)
      ? representative.merged_from_finding_ids.filter((x: unknown): x is string => typeof x === "string")
      : []
  );
  if (typeof absorbed.finding_id === "string" && absorbed.finding_id && absorbed.finding_id !== representative.finding_id) {
    mergedFrom.add(absorbed.finding_id);
  }
  if (Array.isArray(absorbed.merged_from_finding_ids)) {
    for (const id of absorbed.merged_from_finding_ids) {
      if (typeof id === "string" && id && id !== representative.finding_id) mergedFrom.add(id);
    }
  }

  const claimIds = unionList("claim_ids");
  const sourceDocs = unionList("source_docs");
  const evidenceDocs = unionList("evidence_docs");

  return {
    ...representative,
    ...(claimIds.length > 0 ? { claim_ids: claimIds } : {}),
    ...(sourceDocs.length > 0 ? { source_docs: sourceDocs } : {}),
    ...(evidenceDocs.length > 0 ? { evidence_docs: evidenceDocs } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(structuredImpact.length > 0 ? { structured_impact: structuredImpact } : {}),
    ...(consolidatedAnalyses.length > 0 ? { consolidated_analyses: consolidatedAnalyses } : {}),
    ...(mergedFrom.size > 0 ? { merged_from_finding_ids: [...mergedFrom] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Carry-forward dedup
// ---------------------------------------------------------------------------

export interface CarryForwardDedupDiagnostic {
  absorbed_finding_id: string;
  into_finding_id: string;
  coordinate: string;
}

export interface CarryForwardDedupResult {
  /** The node's findings, with absorbed provenance folded in. */
  findings: AnyFinding[];
  /** Carried findings that had no equivalent and must still be appended. */
  carryForward: AnyFinding[];
  /** How many carried findings were absorbed instead of appended. */
  absorbedCount: number;
  /** Per-absorption record for logging and the node accounting block. */
  diagnostics: CarryForwardDedupDiagnostic[];
  /** Carried findings skipped because their coordinate was undetermined. */
  undeterminedCoordinateCount: number;
}

/**
 * Fold carried-forward findings into a node's existing findings wherever an
 * equivalent already sits at the same coordinate.
 *
 * A carried finding is absorbed when ALL of the following hold:
 *   1. Its coordinate (metric|scope|period) is fully determined.
 *   2. Some candidate already in the node shares that exact coordinate.
 *   3. `areCompatibleForMerge` passes against that candidate — this is the
 *      authority, and it independently re-checks finding_kind, currency,
 *      accounting basis, actual-vs-forecast, and evidence coordinates.
 *
 * Otherwise it is carried forward verbatim, exactly as before this change.
 *
 * Carried findings are also matched against each other: a carried finding that
 * has already been appended becomes a candidate for the next one, so a family of
 * duplicates arriving together collapses to one representative.
 *
 * When a carried finding outranks its match on severity, the carried finding
 * becomes the representative and absorbs the incumbent — a critical is never
 * demoted into a warning's provenance.
 */
export function dedupCarryForward(params: {
  findings: AnyFinding[];
  carried: AnyFinding[];
}): CarryForwardDedupResult {
  const findings = [...params.findings];
  const carryForward: AnyFinding[] = [];
  const diagnostics: CarryForwardDedupDiagnostic[] = [];
  let absorbedCount = 0;
  let undeterminedCoordinateCount = 0;

  // Coordinate index over absorb candidates. Values are positions into either
  // `findings` (kind "node") or `carryForward` (kind "carried").
  type Slot = { kind: "node" | "carried"; index: number };
  const byCoordinate = new Map<string, Slot[]>();

  const indexSlot = (coord: string, slot: Slot) => {
    const existing = byCoordinate.get(coord);
    if (existing) existing.push(slot);
    else byCoordinate.set(coord, [slot]);
  };

  const readSlot = (slot: Slot): AnyFinding =>
    slot.kind === "node" ? findings[slot.index]! : carryForward[slot.index]!;

  const writeSlot = (slot: Slot, value: AnyFinding): void => {
    if (slot.kind === "node") findings[slot.index] = value;
    else carryForward[slot.index] = value;
  };

  for (let i = 0; i < findings.length; i++) {
    const coord = coordinateKey(findings[i]!);
    if (coord) indexSlot(coord, { kind: "node", index: i });
  }

  for (const cf of params.carried) {
    const coord = coordinateKey(cf);

    if (!coord) {
      // Coordinate undetermined → never absorb.
      undeterminedCoordinateCount++;
      carryForward.push(cf);
      continue;
    }

    const slots = byCoordinate.get(coord);
    let absorbedIntoSlot: Slot | null = null;

    if (slots) {
      for (const slot of slots) {
        const candidate = readSlot(slot);
        if (!areCompatibleForMerge(candidate, cf)) continue;

        // Higher severity wins the representative seat.
        const merged = rankSeverity(cf) > rankSeverity(candidate)
          ? absorbInto(cf, candidate)
          : absorbInto(candidate, cf);

        writeSlot(slot, merged);
        absorbedIntoSlot = slot;
        break;
      }
    }

    if (absorbedIntoSlot) {
      absorbedCount++;
      diagnostics.push({
        absorbed_finding_id: String(cf.finding_id ?? "unknown"),
        into_finding_id: String(readSlot(absorbedIntoSlot).finding_id ?? "unknown"),
        coordinate: coord,
      });
    } else {
      const slot: Slot = { kind: "carried", index: carryForward.length };
      carryForward.push(cf);
      indexSlot(coord, slot);
    }
  }

  return {
    findings,
    carryForward,
    absorbedCount,
    diagnostics,
    undeterminedCoordinateCount,
  };
}
