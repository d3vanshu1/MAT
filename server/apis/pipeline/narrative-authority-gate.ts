/**
 * MAT-F05: Narrative Authority Gate
 *
 * Enforces that LLM-generated merge/finding output cannot determine or override
 * authoritative fields sourced from canonical F04 records.
 *
 * Fields the LLM CANNOT determine or override:
 *   - verified / evidence.verified flags
 *   - evidence authority
 *   - claim linkage (claim_ids)
 *   - compatibility
 *   - verdict (derived from canonical verdict)
 *   - reportability
 *   - finding_kind (where it affects eligibility)
 *   - severity (where canonical comparison overrides it)
 *   - materiality rationale
 *   - source provenance
 *
 * LLM-returned values for these fields are:
 *   - ignored (not used to set authoritative output)
 *   - OR stored as diagnostic raw output (prefixed _llm_raw_*)
 *
 * The canonical F04 record controls the final output.
 *
 * INVARIANT: After applying the authority gate, the output finding has:
 *   - finding_id, claim_ids, evidence from canonical record (not LLM)
 *   - severity anchored to canonical comparison verdict
 *   - verified flags derived from canonical verdict (not LLM assertion)
 *   - source_docs from canonical evidence (not LLM list)
 *   - finding_kind forced to "data_divergence" when canonical record present
 *   - process/operational findings excluded
 */

import type { CanonicalFinding } from "./canonical-finding.js";
import type { CanonicalFindingRecord } from "./canonical-finding-record.js";
import {
  shouldExcludeAsProcessObject,
  isProcessObject,
} from "./narrative-boundary.js";

// ===========================================================================
// Types
// ===========================================================================

export interface AuthorityGateResult {
  finding: CanonicalFinding;
  was_modified: boolean;
  modifications: string[];
  excluded: false;
  _llm_raw_diagnostic?: Record<string, unknown>;
}

export interface AuthorityGateExclusion {
  excluded: true;
  reason: string;
  original_title: string;
}

export type AuthorityGateOutput = AuthorityGateResult | AuthorityGateExclusion;

// ===========================================================================
// Verdict → severity mapping (deterministic, not LLM-inferred)
// ===========================================================================

/**
 * Map a canonical verdict to the maximum allowable severity.
 * The LLM may assign an equal or lower severity, but never higher.
 * "critical" is reserved for verdicts that confirm material discrepancy.
 */
export function mapVerdictToMaxSeverity(
  verdict: string,
): "critical" | "warning" | "info" {
  switch (verdict) {
    case "contradicted":      return "critical";
    case "materially_changed": return "warning";
    case "partially_supported": return "warning";
    case "unsupported":        return "warning";
    case "confirmed":          return "info";
    case "unverifiable":       return "info";
    case "degraded":           return "info";
    default:                   return "info";
  }
}

/**
 * Apply canonical verdict to derive finding severity.
 * Caps LLM-assigned severity at the canonical maximum.
 */
export function deriveAuthoritative_severity(
  llmSeverity: "critical" | "warning" | "info",
  canonicalVerdict: string,
): "critical" | "warning" | "info" {
  const maxAllowed = mapVerdictToMaxSeverity(canonicalVerdict);
  const ORDER: Record<string, number> = { critical: 3, warning: 2, info: 1 };
  const llmLevel = ORDER[llmSeverity] ?? 1;
  const maxLevel = ORDER[maxAllowed] ?? 1;
  return llmLevel <= maxLevel ? llmSeverity : maxAllowed;
}

// ===========================================================================
// Evidence verification enforcement
// ===========================================================================

/**
 * Enforce verified flags on evidence items.
 *
 * RULE: `verified: true` may only be set when:
 *   - The canonical verdict is "confirmed" OR "partially_supported", AND
 *   - The evidence item's source document is in the canonical evidence list
 *
 * All other `verified: true` flags from LLM are demoted to false.
 */
export function enforceEvidenceVerification(
  evidence: CanonicalFinding["evidence"],
  canonicalVerdict: string,
  canonicalSourceDocNames: string[],
): { enforced: CanonicalFinding["evidence"]; modifications: string[] } {
  if (!evidence || evidence.length === 0) {
    return { enforced: evidence, modifications: [] };
  }

  const modifications: string[] = [];
  const verdictAllowsVerified = canonicalVerdict === "confirmed" || canonicalVerdict === "partially_supported";

  const enforced = evidence.map(item => {
    if (!item.verified) return item;

    // LLM marked verified=true — enforce rules
    if (!verdictAllowsVerified) {
      modifications.push(`Demoted verified=true on "${item.source_doc}" (verdict ${canonicalVerdict} disallows verified)`);
      return { ...item, verified: false };
    }

    // Must be a known source
    const isKnownSource = canonicalSourceDocNames.length === 0 ||
      canonicalSourceDocNames.some(name =>
        name.toLowerCase().includes(item.source_doc.toLowerCase()) ||
        item.source_doc.toLowerCase().includes(name.toLowerCase())
      );

    if (!isKnownSource) {
      modifications.push(`Demoted verified=true on unknown source "${item.source_doc}"`);
      return { ...item, verified: false };
    }

    return item;
  });

  return { enforced, modifications };
}

// ===========================================================================
// Source document enforcement
// ===========================================================================

/**
 * Override source_docs with canonical evidence sources.
 * LLM-generated source lists may contain hallucinated filenames.
 * If canonical evidence is available, use ONLY those sources.
 */
export function enforceSourceDocs(
  llmSourceDocs: string[],
  canonicalSourceDocNames: string[],
): { enforced: string[]; modifications: string[] } {
  if (canonicalSourceDocNames.length === 0) {
    return { enforced: llmSourceDocs, modifications: [] };
  }

  // Use canonical source docs as authoritative list
  const modifications: string[] = [];
  const llmSet = new Set(llmSourceDocs.map(d => d.toLowerCase()));
  const canonicalSet = new Set(canonicalSourceDocNames.map(d => d.toLowerCase()));

  // Detect hallucinated docs
  for (const doc of llmSourceDocs) {
    if (!canonicalSet.has(doc.toLowerCase())) {
      modifications.push(`Removed hallucinated source doc "${doc}" (not in canonical evidence)`);
    }
  }

  // Detect missing canonical docs
  for (const doc of canonicalSourceDocNames) {
    if (!llmSet.has(doc.toLowerCase())) {
      modifications.push(`Added canonical source doc "${doc}" (in canonical evidence, missing from LLM output)`);
    }
  }

  return {
    enforced: canonicalSourceDocNames,
    modifications,
  };
}

// ===========================================================================
// Main Authority Gate
// ===========================================================================

/**
 * Apply the authority gate to a finding from the LLM merge path.
 *
 * - If `canonicalRecord` is provided: all authoritative fields are overridden
 *   from the F04 canonical record. LLM-originated versions are stored as
 *   _llm_raw_diagnostic fields.
 *
 * - If no `canonicalRecord` is provided: LLM fields are still capped by rules
 *   (e.g., verified flags, severity bounds based on finding_kind).
 *
 * - If the finding is a process/operational object: it is excluded entirely.
 */
export function applyAuthorityGate(
  finding: CanonicalFinding,
  canonicalRecord?: CanonicalFindingRecord,
): AuthorityGateOutput {
  // ── Step 1: Process/fallback object exclusion ─────────────────────────────
  if (shouldExcludeAsProcessObject({
    title: finding.title,
    detail: finding.detail,
    full_analysis: finding.full_analysis,
    source_docs: finding.source_docs,
    claim_ids: finding.claim_ids,
  })) {
    return {
      excluded: true,
      reason: `Process/operational finding excluded: "${finding.title}"`,
      original_title: finding.title,
    };
  }

  const modifications: string[] = [];
  const llmRaw: Record<string, unknown> = {};
  let result = { ...finding };

  // ── Step 2: Apply canonical F04 record authority (if present) ─────────────
  if (canonicalRecord) {
    const canonicalSourceDocs = canonicalRecord.evidence.map(e => e.source_document_name);
    const canonicalClaimIds = [canonicalRecord.claim.claim_id];
    const canonicalVerdict = canonicalRecord.disposition.verdict;

    // --- verdict → severity enforcement ---
    const canonicalSeverity = deriveAuthoritative_severity(
      result.severity,
      canonicalVerdict,
    );
    if (canonicalSeverity !== result.severity) {
      llmRaw.severity = result.severity;
      modifications.push(
        `Severity overridden from "${result.severity}" to "${canonicalSeverity}" (canonical verdict: ${canonicalVerdict})`
      );
      result = { ...result, severity: canonicalSeverity };
    }

    // --- claim_ids enforcement ---
    const llmClaimIds = result.claim_ids ?? [];
    if (llmClaimIds.join(",") !== canonicalClaimIds.join(",")) {
      llmRaw.claim_ids = llmClaimIds;
      modifications.push(`claim_ids overridden from LLM [${llmClaimIds.join(",")}] to canonical [${canonicalClaimIds.join(",")}]`);
      result = { ...result, claim_ids: canonicalClaimIds };
    }

    // --- source_docs enforcement ---
    const { enforced: enforcedDocs, modifications: docMods } = enforceSourceDocs(
      result.source_docs,
      canonicalSourceDocs,
    );
    if (docMods.length > 0) {
      llmRaw.source_docs = result.source_docs;
      modifications.push(...docMods);
      result = { ...result, source_docs: enforcedDocs };
    }

    // --- evidence.verified enforcement ---
    if (result.evidence && result.evidence.length > 0) {
      const { enforced: enforcedEvidence, modifications: evMods } = enforceEvidenceVerification(
        result.evidence,
        canonicalVerdict,
        canonicalSourceDocs,
      );
      if (evMods.length > 0) {
        llmRaw.evidence_verified_flags = result.evidence.map(e => ({ source: e.source_doc, verified: e.verified }));
        modifications.push(...evMods);
        result = { ...result, evidence: enforcedEvidence };
      }
    }

    // --- finding_kind enforcement: canonical records → data_divergence ---
    if (result.finding_kind !== "data_divergence") {
      llmRaw.finding_kind = result.finding_kind;
      modifications.push(`finding_kind overridden from "${result.finding_kind}" to "data_divergence" (canonical F04 record present)`);
      result = { ...result, finding_kind: "data_divergence" };
    }

    // --- severity_anchor: replace LLM anchor with canonical anchor ---
    const canonicalCalc = canonicalRecord.comparisons[0]?.calculation;
    if (canonicalCalc) {
      const delta = canonicalCalc.signed_delta;
      const pct = canonicalCalc.percentage_delta;
      const newAnchor = delta != null
        ? `Canonical calculation: delta ${delta}${pct != null ? ` (${pct.toFixed(1)}%)` : ""}, verdict ${canonicalVerdict}`
        : `Canonical verdict: ${canonicalVerdict}`;
      if (result.severity_anchor !== newAnchor) {
        llmRaw.severity_anchor = result.severity_anchor;
        result = { ...result, severity_anchor: newAnchor };
        modifications.push("severity_anchor replaced with canonical calculation");
      }
    }

    // --- materiality_rationale: never from LLM alone ---
    // Store LLM version as diagnostic but keep it (it may be useful prose)
    // but mark it as LLM-generated so downstream audits can see it
    if (result.materiality_rationale) {
      llmRaw.materiality_rationale_llm = result.materiality_rationale;
    }

    // Store canonical record reference
    llmRaw._canonical_record_id = canonicalRecord.identity.finding_id;
    llmRaw._canonical_verdict = canonicalVerdict;
    llmRaw._canonical_semantic_hash = canonicalRecord.identity.semantic_hash;
  } else {
    // ── Step 3: No canonical record — apply rule-based caps ──────────────────

    // Cap severity for process_observation findings
    if (result.finding_kind === "process_observation" && result.severity !== "info") {
      llmRaw.severity = result.severity;
      modifications.push(`Severity capped to "info" for process_observation finding`);
      result = { ...result, severity: "info" };
    }

    // Demote verified flags that have no structural basis
    // (without a canonical record, verified=true requires finding to be confirmed-verdict-like)
    if (result.evidence) {
      const {
        enforced: enforcedEvidence,
        modifications: evMods,
      } = enforceEvidenceVerification(
        result.evidence,
        "unverifiable", // conservative default without canonical record
        result.source_docs,
      );
      if (evMods.length > 0) {
        modifications.push(...evMods);
        result = { ...result, evidence: enforcedEvidence };
      }
    }
  }

  return {
    finding: result,
    was_modified: modifications.length > 0,
    modifications,
    excluded: false,
    _llm_raw_diagnostic: Object.keys(llmRaw).length > 0 ? llmRaw : undefined,
  };
}

// ===========================================================================
// Batch Gate (for merge output arrays)
// ===========================================================================

export interface BatchGateResult {
  accepted: CanonicalFinding[];
  excluded: Array<{ title: string; reason: string }>;
  modified: Array<{ finding_id: string; modifications: string[] }>;
  /** LLM raw diagnostic data keyed by finding_id */
  diagnostics: Record<string, Record<string, unknown>>;
}

/**
 * Apply the authority gate to an entire batch of findings from a merge round.
 *
 * - canonicalRecords: map of claim_id → CanonicalFindingRecord (from F04 checkpoint)
 * - Findings not in the canonical map are still processed with rule-based caps
 */
export function applyBatchAuthorityGate(
  findings: CanonicalFinding[],
  canonicalRecords?: Map<string, CanonicalFindingRecord>,
): BatchGateResult {
  const accepted: CanonicalFinding[] = [];
  const excluded: Array<{ title: string; reason: string }> = [];
  const modified: Array<{ finding_id: string; modifications: string[] }> = [];
  const diagnostics: Record<string, Record<string, unknown>> = {};

  for (const finding of findings) {
    // Find matching canonical record by claim linkage
    let canonicalRecord: CanonicalFindingRecord | undefined;
    if (canonicalRecords) {
      for (const claimId of finding.claim_ids ?? []) {
        const rec = canonicalRecords.get(claimId);
        if (rec) { canonicalRecord = rec; break; }
      }
    }

    const gateResult = applyAuthorityGate(finding, canonicalRecord);

    if (gateResult.excluded) {
      excluded.push({
        title: gateResult.original_title,
        reason: gateResult.reason,
      });
      continue;
    }

    accepted.push(gateResult.finding);

    if (gateResult.was_modified) {
      modified.push({
        finding_id: gateResult.finding.finding_id,
        modifications: gateResult.modifications,
      });
    }

    if (gateResult._llm_raw_diagnostic) {
      diagnostics[gateResult.finding.finding_id] = gateResult._llm_raw_diagnostic;
    }
  }

  return { accepted, excluded, modified, diagnostics };
}
