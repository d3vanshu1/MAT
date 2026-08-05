/**
 * MAT-F06 — Canonical Final Artifact
 *
 * Defines the single versioned output artifact that every completion path must
 * produce and persist. Provides the semantic hash computation that excludes
 * volatile operational fields (timestamps, request IDs, insertion order).
 *
 * RULE: the semantic hash must be identical for materially identical content
 * across main, fast, retry, and resume paths.
 */

import { sha256hex } from "./sha256-pure.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

export const CANONICAL_FINAL_ARTIFACT_VERSION = "mat-final-v1" as const;
export const SEMANTIC_HASH_VERSION = "sha256-v1" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────────────────────

export interface NarrativeDiagnostic {
  finding_id: string;
  status: "accepted" | "rejected" | "no_canonical_record" | "fallback_applied";
  reason_codes: string[];
  fallback_used: boolean;
}

export interface ExcludedFinding {
  finding_id: string;
  title: string;
  exclusion_reason:
    | "process_object"
    | "no_canonical_record"
    | "unlinked"
    | "invalid_evidence"
    | "incompatible_comparison"
    | "housekeeping"
    | "placeholder"
    | "degraded_notice";
}

export interface CheckpointStatusEntry {
  key: string;
  present: boolean;
  status?: string;
}

export interface CanonicalFinalArtifact {
  schema_version: typeof CANONICAL_FINAL_ARTIFACT_VERSION;
  run_id: string;
  module_type: string;

  // Findings: only canonical, reportable findings
  canonical_findings: unknown[];
  reportable_finding_ids: string[];

  diagnostics: {
    /** Narrative validation outcomes (F05) — rejected text never enters report */
    narrative_validation: NarrativeDiagnostic[];
    /** Findings excluded from substantive report */
    excluded_findings: ExcludedFinding[];
    /** Degraded conditions (claims failed, partial extraction, etc.) */
    degraded_conditions: string[];
    /** Checkpoint availability at finalization time */
    checkpoint_status: CheckpointStatusEntry[];
  };

  report: {
    markdown: string;
    finding_count: number;
    executive_header: string;
  };

  identity: {
    /** Stable content hash — excludes timestamps, request IDs, insertion order */
    semantic_hash: string;
    hash_version: typeof SEMANTIC_HASH_VERSION;
  };

  // Operational (excluded from semantic hash)
  finalized_at: string;

  // --- Artifact lifecycle (Commit 3) ---
  /** Lifecycle status: active = current, invalidated_partial = superseded partial, superseded = replaced */
  artifact_status?: "active" | "invalidated_partial" | "superseded";
  /** If superseded, the output_id of the replacement artifact */
  superseded_by_output_id?: string | null;
  /** Reason for invalidation (if artifact_status != active) */
  invalidation_reason?: string | null;
  /** Timestamp of invalidation */
  invalidation_timestamp?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact Lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

export type ArtifactStatus = "active" | "invalidated_partial" | "superseded";

export interface ArtifactLifecycleFields {
  artifact_status: ArtifactStatus;
  superseded_by_output_id: string | null;
  invalidation_reason: string | null;
  invalidation_timestamp: string | null;
}

/**
 * Sentinel for canonical schema migration required.
 * When critical columns are missing, finalization returns this instead of writing.
 */
export const CANONICAL_SCHEMA_MIGRATION_REQUIRED = "CANONICAL_SCHEMA_MIGRATION_REQUIRED" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Semantic hash
// ─────────────────────────────────────────────────────────────────────────────

export interface SemanticHashInput {
  /** Canonical finding IDs sorted deterministically */
  finding_ids: string[];
  /** Per-finding semantic hashes from the F04 canonical record */
  finding_semantic_hashes: string[];
  /** Reportable finding IDs sorted deterministically */
  reportable_finding_ids: string[];
  /** Deterministic verdicts: finding_id → verdict */
  verdicts: Record<string, string>;
  /** Final validated/fallback narrative: finding_id → title|detail */
  narrative_digests: Record<string, string>;
  /** Diagnostic decisions that affect output */
  excluded_finding_ids: string[];
  narrative_rejection_ids: string[];
  /** Normalized digest of final report markdown — ensures report content changes the hash */
  report_content_digest: string;
  /** Schema/version identifiers */
  schema_version: string;
  hash_version: string;
  module_type: string;
}

/**
 * Compute a stable semantic hash from content — excludes all volatile fields.
 *
 * The hash is identical for materially equivalent artifacts regardless of:
 * - timestamp;
 * - insertion order;
 * - request ID / run_id;
 * - log text;
 * - runtime duration.
 */
export function computeSemanticHash(input: SemanticHashInput): string {
  // Sort all arrays to eliminate insertion-order sensitivity
  const stable = {
    schema_version: input.schema_version,
    hash_version: input.hash_version,
    module_type: input.module_type,
    finding_ids: [...input.finding_ids].sort(),
    finding_semantic_hashes: [...input.finding_semantic_hashes].sort(),
    reportable_finding_ids: [...input.reportable_finding_ids].sort(),
    verdicts: sortObjectKeys(input.verdicts),
    narrative_digests: sortObjectKeys(input.narrative_digests),
    excluded_finding_ids: [...input.excluded_finding_ids].sort(),
    narrative_rejection_ids: [...input.narrative_rejection_ids].sort(),
    report_content_digest: input.report_content_digest,
  };

  const payload = JSON.stringify(stable);
  return "sha256-v1:" + sha256hex(payload);
}

function sortObjectKeys<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

/**
 * Build the SemanticHashInput from a CanonicalFinalArtifact (excludes volatile fields).
 */
export function buildSemanticHashInput(
  findings: any[],
  reportableFindingIds: string[],
  diagnostics: CanonicalFinalArtifact["diagnostics"],
  moduleType: string,
  reportMarkdown?: string
): SemanticHashInput {
  const findingIds: string[] = [];
  const findingSemanticHashes: string[] = [];
  const verdicts: Record<string, string> = {};
  const narrativeDigests: Record<string, string> = {};

  for (const f of findings) {
    const id: string = f.finding_id ?? f.id ?? "";
    if (!id) continue;
    findingIds.push(id);
    // Use F04 semantic hash if available
    findingSemanticHashes.push(f._semantic_hash ?? f.finding_id ?? id);
    // Deterministic verdict from canonical disposition
    verdicts[id] = f._canonical_verdict ?? f.verdict ?? f.severity ?? "";
    // Narrative digest: hash of validated title + detail
    const title: string = f.title ?? "";
    const detail: string = f.detail ?? "";
    narrativeDigests[id] = sha256hex(title + "|" + detail).slice(0, 16);
  }

  // Compute deterministic report digest — covers final markdown content in the hash
  const reportDigest = reportMarkdown
    ? sha256hex(reportMarkdown).slice(0, 32)
    : "empty";

  return {
    finding_ids: findingIds,
    finding_semantic_hashes: findingSemanticHashes,
    reportable_finding_ids: [...reportableFindingIds],
    verdicts,
    narrative_digests: narrativeDigests,
    excluded_finding_ids: diagnostics.excluded_findings.map(e => e.finding_id),
    narrative_rejection_ids: diagnostics.narrative_validation
      .filter(n => n.status === "rejected")
      .map(n => n.finding_id),
    report_content_digest: reportDigest,
    schema_version: CANONICAL_FINAL_ARTIFACT_VERSION,
    hash_version: SEMANTIC_HASH_VERSION,
    module_type: moduleType,
  };
}
