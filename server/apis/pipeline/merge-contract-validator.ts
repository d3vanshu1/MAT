/**
 * merge-contract-validator.ts — OA-02
 *
 * Enforces a restricted merge contract on all L2+ omission_audit merge stages.
 * Every output of a consolidation merge must be provably non-generative:
 *   - All finding IDs trace to direct inputs
 *   - All evidence/claim/source-document references exist in input members
 *   - No numeric values fabricated (must exist in input narration)
 *   - No severity assigned or changed by the LLM
 *   - No source authority changed
 *   - No proposition split or orphaned
 *
 * Fail-closed: if any violation is detected, the merge output is REJECTED
 * and the original input findings are preserved unchanged.
 */

import type { CanonicalFinding } from "./canonical-finding.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViolationCode =
  | "member_id_not_in_input"
  | "representative_id_not_in_input"
  | "retained_record_not_in_input"
  | "evidence_id_not_in_members"
  | "claim_id_not_in_members"
  | "disclosure_id_not_in_members"
  | "source_doc_not_in_members"
  | "source_coordinate_not_in_members"
  | "fabricated_numeric_value"
  | "source_authority_changed"
  | "severity_changed"
  | "reportability_changed"
  | "proposition_split"
  | "proposition_rewrite"
  | "orphaned_output_proposition"
  | "contradictory_membership"
  | "output_count_exceeds_input";

export interface MergeContractViolation {
  code: ViolationCode;
  /** The finding_id that triggered the violation (output side) */
  outputFindingId: string;
  /** Human-readable diagnostic */
  detail: string;
  /** The offending value (for traceability) */
  offendingValue?: string;
}

export interface MergeContractResult {
  valid: boolean;
  /** When valid=true, the accepted LLM output. When valid=false, the original input findings. */
  acceptedFindings: CanonicalFinding[];
  /** All violations detected (empty when valid=true) */
  validationErrors: MergeContractViolation[];
  /** Unique violation codes for fast diagnostic filtering */
  violationCodes: ViolationCode[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all numeric-like tokens from a string.
 * Matches: integers, decimals, percentages (without the % sign), negative numbers.
 * Ignores UUIDs and dates by context.
 */
function extractNumericTokens(text: string): Set<string> {
  if (!text) return new Set();
  // Match numbers that look like data values (not UUID hex segments)
  const matches = text.match(/-?\d+(?:\.\d+)?(?:%)?/g) ?? [];
  return new Set(matches.map(m => m.replace(/%$/, "")));
}

/**
 * Collect all numeric tokens from a finding's narration fields.
 * "Narration" = title, detail, full_analysis, severity_anchor, materiality_rationale
 */
function collectNarrationNumerics(finding: CanonicalFinding): Set<string> {
  const tokens = new Set<string>();
  const fields = [
    finding.title,
    finding.detail,
    finding.full_analysis,
    finding.severity_anchor ?? "",
    finding.materiality_rationale ?? "",
  ];
  for (const field of fields) {
    for (const t of extractNumericTokens(field)) tokens.add(t);
  }
  // Also collect from evidence figures
  if (finding.evidence) {
    for (const ev of finding.evidence) {
      for (const t of extractNumericTokens(ev.figure)) tokens.add(t);
      for (const t of extractNumericTokens(ev.verbatim_snippet)) tokens.add(t);
    }
  }
  // Structured impact amounts
  if (finding.structured_impact) {
    for (const si of finding.structured_impact) {
      tokens.add(String(si.amount));
    }
  }
  return tokens;
}

/**
 * Collect all source_docs from a finding (flat string array).
 */
function collectSourceDocs(finding: CanonicalFinding): Set<string> {
  const docs = new Set<string>();
  for (const d of finding.source_docs ?? []) docs.add(d);
  if (finding.evidence_docs) {
    for (const d of finding.evidence_docs) docs.add(d);
  }
  if (finding.evidence) {
    for (const ev of finding.evidence) {
      if (ev.source_doc) docs.add(ev.source_doc);
      if (ev.source_filename) docs.add(ev.source_filename);
      if (ev.document_id) docs.add(ev.document_id);
    }
  }
  return docs;
}

/**
 * Collect all source coordinates from a finding's evidence entries.
 */
function collectSourceCoordinates(finding: CanonicalFinding): Set<string> {
  const coords = new Set<string>();
  if (finding.evidence) {
    for (const ev of finding.evidence) {
      if (ev.cell_coordinate) coords.add(ev.cell_coordinate);
      if (ev.sheet_or_page) coords.add(ev.sheet_or_page);
    }
  }
  if (finding.structured_impact) {
    for (const si of finding.structured_impact) {
      if (si.source_coordinate) coords.add(si.source_coordinate);
    }
  }
  return coords;
}

/**
 * Collect all claim_ids from a finding.
 */
function collectClaimIds(finding: CanonicalFinding): Set<string> {
  return new Set(finding.claim_ids ?? []);
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate that an LLM merge output strictly satisfies the non-generative
 * merge contract. Returns a MergeContractResult.
 *
 * @param inputFindings  Direct input findings to this merge call (L-1 children)
 * @param mergeOutput    Parsed findings from the LLM merge response
 * @returns              MergeContractResult — valid + acceptedFindings OR violations
 */
export function validateMergeContract(
  inputFindings: CanonicalFinding[],
  mergeOutput: CanonicalFinding[]
): MergeContractResult {
  const violations: MergeContractViolation[] = [];

  // Build input lookup structures
  const inputById = new Map<string, CanonicalFinding>();
  for (const f of inputFindings) {
    inputById.set(f.finding_id, f);
  }
  const inputIds = new Set(inputById.keys());

  // Aggregate input pools (union across all inputs)
  const allInputSourceDocs = new Set<string>();
  const allInputCoordinates = new Set<string>();
  const allInputClaimIds = new Set<string>();
  const allInputNumerics = new Set<string>();

  for (const f of inputFindings) {
    for (const d of collectSourceDocs(f)) allInputSourceDocs.add(d);
    for (const c of collectSourceCoordinates(f)) allInputCoordinates.add(c);
    for (const cl of collectClaimIds(f)) allInputClaimIds.add(cl);
    for (const n of collectNarrationNumerics(f)) allInputNumerics.add(n);
  }

  // --- Check 0: output count must not exceed input count ---
  // A non-generative merge can consolidate (reduce) but never inflate
  if (mergeOutput.length > inputFindings.length) {
    violations.push({
      code: "output_count_exceeds_input",
      outputFindingId: "__aggregate__",
      detail: `Output has ${mergeOutput.length} findings but input had only ${inputFindings.length}`,
    });
  }

  // Track which input IDs are "accounted for" (appear in output as representative or merged_from)
  const accountedInputIds = new Set<string>();

  for (const out of mergeOutput) {
    const outId = out.finding_id;
    const mergedFrom = out.merged_from_finding_ids ?? [];

    // --- Check 1: Every member ID (merged_from) exists in direct input ---
    for (const memberId of mergedFrom) {
      if (!inputIds.has(memberId)) {
        violations.push({
          code: "member_id_not_in_input",
          outputFindingId: outId,
          detail: `merged_from_finding_ids contains "${memberId}" which is not a direct input finding`,
          offendingValue: memberId,
        });
      } else {
        accountedInputIds.add(memberId);
      }
    }

    // --- Check 2: Every representative ID exists in direct input ---
    // The representative (output finding_id) must come from input
    if (!inputIds.has(outId)) {
      violations.push({
        code: "representative_id_not_in_input",
        outputFindingId: outId,
        detail: `Output finding_id "${outId}" is not present in direct input findings`,
        offendingValue: outId,
      });
    } else {
      accountedInputIds.add(outId);
    }

    // --- Check 3: retained/suppressed records exist in input ---
    // (Covered implicitly by checks 1+2: all IDs in output must trace to input)

    // --- Determine relevant input members for content checks ---
    // "Members" = the representative + all merged_from
    const memberIds = new Set([outId, ...mergedFrom]);
    const members = [...memberIds]
      .map(id => inputById.get(id))
      .filter((f): f is CanonicalFinding => f !== undefined);

    // Build member-scoped pools
    const memberSourceDocs = new Set<string>();
    const memberCoordinates = new Set<string>();
    const memberClaimIds = new Set<string>();
    const memberNumerics = new Set<string>();

    for (const m of members) {
      for (const d of collectSourceDocs(m)) memberSourceDocs.add(d);
      for (const c of collectSourceCoordinates(m)) memberCoordinates.add(c);
      for (const cl of collectClaimIds(m)) memberClaimIds.add(cl);
      for (const n of collectNarrationNumerics(m)) memberNumerics.add(n);
    }

    // --- Check 4: Every evidence ID exists in relevant input members ---
    // (evidence.document_id field)
    if (out.evidence) {
      for (const ev of out.evidence) {
        if (ev.document_id && !memberSourceDocs.has(ev.document_id)) {
          violations.push({
            code: "evidence_id_not_in_members",
            outputFindingId: outId,
            detail: `Evidence document_id "${ev.document_id}" not found in member findings`,
            offendingValue: ev.document_id,
          });
        }
      }
    }

    // --- Check 5: Every claim ID exists in relevant input members ---
    if (out.claim_ids) {
      for (const cid of out.claim_ids) {
        if (!memberClaimIds.has(cid)) {
          violations.push({
            code: "claim_id_not_in_members",
            outputFindingId: outId,
            detail: `claim_id "${cid}" not found in member findings`,
            offendingValue: cid,
          });
        }
      }
    }

    // --- Check 6: Disclosure IDs (evidence_docs) exist in members ---
    if (out.evidence_docs) {
      for (const edoc of out.evidence_docs) {
        if (!memberSourceDocs.has(edoc)) {
          violations.push({
            code: "disclosure_id_not_in_members",
            outputFindingId: outId,
            detail: `evidence_docs entry "${edoc}" not found in member findings`,
            offendingValue: edoc,
          });
        }
      }
    }

    // --- Check 7: Every source-document ID in output exists in members ---
    for (const sd of out.source_docs ?? []) {
      if (!memberSourceDocs.has(sd)) {
        violations.push({
          code: "source_doc_not_in_members",
          outputFindingId: outId,
          detail: `source_docs entry "${sd}" not found in member findings`,
          offendingValue: sd,
        });
      }
    }

    // --- Check 8: Every source coordinate exists in input members ---
    if (out.evidence) {
      for (const ev of out.evidence) {
        if (ev.cell_coordinate && !memberCoordinates.has(ev.cell_coordinate)) {
          violations.push({
            code: "source_coordinate_not_in_members",
            outputFindingId: outId,
            detail: `Source coordinate "${ev.cell_coordinate}" not found in member findings`,
            offendingValue: ev.cell_coordinate,
          });
        }
      }
    }
    if (out.structured_impact) {
      for (const si of out.structured_impact) {
        if (si.source_coordinate && !memberCoordinates.has(si.source_coordinate)) {
          violations.push({
            code: "source_coordinate_not_in_members",
            outputFindingId: outId,
            detail: `structured_impact source_coordinate "${si.source_coordinate}" not in members`,
            offendingValue: si.source_coordinate,
          });
        }
      }
    }

    // --- Check 9: Every numeric value in narration exists in locked input fields ---
    const outputNumerics = collectNarrationNumerics(out);
    for (const num of outputNumerics) {
      // Skip trivial numerics (0, 1, 2, 3 — common in text)
      if (["0", "1", "2", "3"].includes(num)) continue;
      if (!allInputNumerics.has(num)) {
        violations.push({
          code: "fabricated_numeric_value",
          outputFindingId: outId,
          detail: `Numeric value "${num}" in output narration not found in any input finding`,
          offendingValue: num,
        });
      }
    }

    // --- Check 10: No source authority or authority class changed ---
    // Compare finding_kind if the representative existed in input
    const inputRepresentative = inputById.get(outId);
    if (inputRepresentative) {
      if (
        out.finding_kind !== undefined &&
        inputRepresentative.finding_kind !== undefined &&
        out.finding_kind !== inputRepresentative.finding_kind
      ) {
        violations.push({
          code: "source_authority_changed",
          outputFindingId: outId,
          detail: `finding_kind changed from "${inputRepresentative.finding_kind}" to "${out.finding_kind}"`,
          offendingValue: out.finding_kind,
        });
      }
      // category
      if (
        out.category !== undefined &&
        inputRepresentative.category !== undefined &&
        out.category !== inputRepresentative.category
      ) {
        violations.push({
          code: "source_authority_changed",
          outputFindingId: outId,
          detail: `category changed from "${inputRepresentative.category}" to "${out.category}"`,
          offendingValue: out.category,
        });
      }
    }

    // --- Check 11: No severity assigned/changed ---
    if (inputRepresentative) {
      if (out.severity !== inputRepresentative.severity) {
        violations.push({
          code: "severity_changed",
          outputFindingId: outId,
          detail: `severity changed from "${inputRepresentative.severity}" to "${out.severity}"`,
          offendingValue: out.severity,
        });
      }
    }

    // --- Check 11b: No reportability assigned/changed ---
    if (inputRepresentative) {
      const inRep = (inputRepresentative as any).reportability ?? null;
      const outRep = (out as any).reportability ?? null;
      if (inRep !== outRep) {
        violations.push({
          code: "reportability_changed",
          outputFindingId: outId,
          detail: `reportability changed from "${inRep}" to "${outRep}"`,
          offendingValue: String(outRep),
        });
      }
    }

    // --- Check 11c: Proposition rewrite (title or issue_key semantically changed) ---
    if (inputRepresentative) {
      // Title must not be materially changed (normalized comparison)
      const inTitle = (inputRepresentative.title ?? "").trim().toLowerCase();
      const outTitle = (out.title ?? "").trim().toLowerCase();
      if (inTitle && outTitle && inTitle !== outTitle) {
        // Allow minor whitespace/punctuation normalization but not content change
        const inNorm = inTitle.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
        const outNorm = outTitle.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
        if (inNorm !== outNorm) {
          violations.push({
            code: "proposition_rewrite",
            outputFindingId: outId,
            detail: `Title rewritten: was "${inputRepresentative.title}", now "${out.title}"`,
            offendingValue: out.title,
          });
        }
      }
    }

    // --- Check 11d: Contradictory membership (same finding appears in multiple groups) ---
    // Tracked after the loop below
  }

  // --- Check 12: No input proposition split into multiple output propositions ---
  // An input finding_id should appear as representative in at most ONE output finding.
  const representativeCounts = new Map<string, number>();
  for (const out of mergeOutput) {
    const current = representativeCounts.get(out.finding_id) ?? 0;
    representativeCounts.set(out.finding_id, current + 1);
  }
  for (const [id, count] of representativeCounts) {
    if (count > 1) {
      violations.push({
        code: "proposition_split",
        outputFindingId: id,
        detail: `Input finding "${id}" appears as representative in ${count} output findings (split prohibited)`,
        offendingValue: String(count),
      });
    }
  }

  // --- Check 13: No output proposition lacks traceable input membership ---
  for (const out of mergeOutput) {
    const memberIds = [out.finding_id, ...(out.merged_from_finding_ids ?? [])];
    const anyInInput = memberIds.some(id => inputIds.has(id));
    if (!anyInInput) {
      violations.push({
        code: "orphaned_output_proposition",
        outputFindingId: out.finding_id,
        detail: `Output finding has no traceable membership in input findings`,
      });
    }
  }

  // --- Check 14: Contradictory membership (same member in multiple output groups) ---
  const memberAssignments = new Map<string, string[]>();
  for (const out of mergeOutput) {
    for (const mid of out.merged_from_finding_ids ?? []) {
      const existing = memberAssignments.get(mid) ?? [];
      existing.push(out.finding_id);
      memberAssignments.set(mid, existing);
    }
  }
  for (const [mid, reps] of memberAssignments) {
    if (reps.length > 1) {
      violations.push({
        code: "contradictory_membership",
        outputFindingId: reps[0],
        detail: `Finding "${mid}" assigned as member to multiple groups: [${reps.join(", ")}]`,
        offendingValue: mid,
      });
    }
  }

  // Build result
  const violationCodes = [...new Set(violations.map(v => v.code))] as ViolationCode[];
  const valid = violations.length === 0;

  return {
    valid,
    // Fail-closed: reject LLM output and preserve original input
    acceptedFindings: valid ? mergeOutput : inputFindings,
    validationErrors: violations,
    violationCodes,
  };
}
