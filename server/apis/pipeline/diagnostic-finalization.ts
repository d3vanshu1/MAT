/**
 * DiagnosticFinalization — Multi-phase diagnostic recovery and report generation.
 *
 * Uses completed L3 merge outputs as the durable recovery boundary.
 * Does NOT rerun extraction, claims, reconciliation, or analysis chunks.
 * Does NOT continue feeding findings into legacy L4/L5 merge tree.
 *
 * Phases:
 *   1. load_and_report  — Load L3 findings, validate, report statistics
 *   2. build_families   — Construct candidate families deterministically
 *   3. process_families — Process families with bounded LLM calls (iterative)
 *   4. finalize_report  — Assemble final set, run downstream stages, produce report
 *
 * Run state: completed_diagnostic_with_merge_degradation
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  CanonicalFindingSchema,
  parseCanonicalFindings,
  type CanonicalFinding,
} from "./canonical-finding.js";
import { callLLMWithHeadroom, type LLMResponse } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import { EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, type PipelineContext } from "./pipeline-config.js";

// ---------------------------------------------------------------------------
// Integration IDs
// ---------------------------------------------------------------------------
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_FINDINGS_PER_CALL = 6;
const MAX_TOKENS_CONSOLIDATION = 4096;
const PERSISTENCE_RESERVE_MS = 20_000;
const MIN_WORK_BUDGET_MS = 40_000;

// ---------------------------------------------------------------------------
// Internal context type (not the shared PipelineContext from pipeline-config)
// ---------------------------------------------------------------------------
interface DiagCtx {
  db: {
    query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
    execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<any>;
  };
  ai: {
    apiRequest: (req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>;
  };
  startTime: number;
  runId: string;
  moduleId: string;
  useOpus: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Candidate family — deterministic grouping of findings for consolidation */
interface CandidateFamily {
  family_id: string;
  /** Grouping key (normalized issue_key, finding_kind+category combo, etc.) */
  grouping_key: string;
  grouping_reasons: string[];
  grouping_confidence: "high" | "medium" | "low";
  member_finding_ids: string[];
  /** Snapshot of input state */
  input_bytes: number;
  /** Processing state */
  status: "pending" | "processing" | "complete" | "degraded_fallback";
  attempt_count: number;
  split_depth: number;
  /** Output */
  output_finding_ids: string[];
  degraded_reason?: string;
  /** Source fingerprint for resumability */
  source_fingerprint: string;
}

/** Family processing result */
interface FamilyResult {
  family_id: string;
  input_count: number;
  output_count: number;
  output_findings: CanonicalFinding[];
  status: "complete" | "degraded_fallback";
  degraded_reason?: string;
  elapsed_ms: number;
}

// ---------------------------------------------------------------------------
// Zod schemas for I/O
// ---------------------------------------------------------------------------

const PhaseEnum = z.enum(["load_and_report", "build_families", "process_families", "finalize_report"]);

const LoadReportOutputSchema = z.object({
  phase: z.literal("load_and_report"),
  l3_checkpoints_loaded: z.number(),
  total_findings_loaded: z.number(),
  unique_finding_ids: z.number(),
  duplicate_finding_ids: z.number(),
  distinct_issue_keys: z.number(),
  findings_missing_issue_keys: z.number(),
  valid_canonical_findings: z.number(),
  invalid_canonical_findings: z.number(),
  payload_size_by_node: z.array(z.object({
    node: z.string(),
    finding_count: z.number(),
    payload_bytes: z.number(),
  })),
  severity_distribution: z.object({
    critical: z.number(),
    warning: z.number(),
    info: z.number(),
  }),
  finding_kind_distribution: z.record(z.number()),
  category_distribution: z.record(z.number()),
});

const BuildFamiliesOutputSchema = z.object({
  phase: z.literal("build_families"),
  total_findings_input: z.number(),
  total_families: z.number(),
  singleton_families: z.number(),
  multi_finding_families: z.number(),
  families_needing_split: z.number(),
  estimated_llm_calls: z.number(),
  family_size_distribution: z.record(z.number()),
  top_families: z.array(z.object({
    family_id: z.string(),
    grouping_key: z.string(),
    member_count: z.number(),
    grouping_reasons: z.array(z.string()),
    confidence: z.string(),
  })),
  families_persisted: z.boolean(),
});

const ProcessFamiliesOutputSchema = z.object({
  phase: z.literal("process_families"),
  families_processed_this_invocation: z.number(),
  families_remaining: z.number(),
  families_complete: z.number(),
  families_degraded: z.number(),
  findings_input_this_invocation: z.number(),
  findings_output_this_invocation: z.number(),
  elapsed_ms: z.number(),
  budget_exhausted: z.boolean(),
  next_action: z.string(),
});

const FinalReportOutputSchema = z.object({
  phase: z.literal("finalize_report"),
  quality_classification: z.enum(["healthy_candidate", "quality_warning", "quality_failure_diagnostic"]),
  count_waterfall: z.object({
    l3_findings: z.number(),
    candidate_families: z.number(),
    singleton_families: z.number(),
    multi_finding_families: z.number(),
    completed_family_consolidations: z.number(),
    degraded_families: z.number(),
    after_deterministic_consolidation: z.number(),
    after_materiality: z.number(),
    after_absence_verification: z.number(),
    final_report_findings: z.number(),
  }),
  ground_truth: z.object({
    expected_present: z.array(z.object({ issue: z.string(), found: z.boolean(), finding_id: z.string().optional() })),
    expected_absent: z.array(z.object({ issue: z.string(), correctly_excluded: z.boolean(), finding_id: z.string().optional() })),
  }),
  findings: z.array(z.any()),
  duplicate_family_appendix: z.array(z.object({
    topic: z.string(),
    before_count: z.number(),
    after_count: z.number(),
  })),
});

// ---------------------------------------------------------------------------
// API Definition
// ---------------------------------------------------------------------------
export default api({
  name: "DiagnosticFinalization",
  description: "Multi-phase diagnostic recovery using L3 outputs as durable boundary",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    anthropic: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    moduleId: z.string(),
    phase: PhaseEnum,
    /** For process_families: batch size limit */
    maxFamiliesPerInvocation: z.number().default(10),
    useOpus: z.boolean().default(false),
  }),

  output: z.object({
    result: z.any(),
  }),

  async run(ctx, { runId, moduleId, phase, maxFamiliesPerInvocation, useOpus }) {
    const startTime = Date.now();

    const diagCtx: DiagCtx = {
      db: ctx.integrations.ic_diligence_db,
      ai: ctx.integrations.anthropic,
      startTime,
      runId,
      moduleId,
      useOpus,
    };

    switch (phase) {
      case "load_and_report":
        return { result: await phaseLoadAndReport(diagCtx) };
      case "build_families":
        return { result: await phaseBuildFamilies(diagCtx) };
      case "process_families":
        return { result: await phaseProcessFamilies(diagCtx, maxFamiliesPerInvocation) };
      case "finalize_report":
        return { result: await phaseFinalizeReport(diagCtx) };
      default:
        throw new Error(`Unknown phase: ${phase}`);
    }
  },
});

// ===========================================================================
// PHASE 1: Load L3 findings and report statistics
// ===========================================================================

async function phaseLoadAndReport(ctx: DiagCtx): Promise<z.infer<typeof LoadReportOutputSchema>> {
  const { db, runId } = ctx;

  // Load all L3 complete checkpoints
  const CheckpointRowSchema = z.object({
    tree_level: z.coerce.number(),
    node_index: z.coerce.number(),
    merged_json: z.any(),
  });

  const rows = await db.query(
    `SELECT tree_level, node_index, merged_json
     FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 3 AND status = 'complete'
     ORDER BY node_index
     LIMIT 10`,
    CheckpointRowSchema,
    [runId],
    { label: "Load L3 complete checkpoints" }
  );

  const allFindings: CanonicalFinding[] = [];
  const payloadByNode: Array<{ node: string; finding_count: number; payload_bytes: number }> = [];
  let invalidCount = 0;

  for (const row of rows) {
    const merged = typeof row.merged_json === "string" ? JSON.parse(row.merged_json) : row.merged_json;
    const rawFindings = Array.isArray(merged.findings) ? merged.findings : [];
    const payloadBytes = JSON.stringify(rawFindings).length;

    const result = parseCanonicalFindings(rawFindings, {
      mode: "reload",
      source: `L3:N${row.node_index}`,
    });

    allFindings.push(...result.findings);
    invalidCount += result.invalid.length + result.malformed_count;

    payloadByNode.push({
      node: `L3:N${row.node_index}`,
      finding_count: result.findings.length,
      payload_bytes: payloadBytes,
    });
  }

  // Compute statistics
  const findingIds = allFindings.map(f => f.finding_id);
  const uniqueIds = new Set(findingIds);
  const duplicateIds = findingIds.length - uniqueIds.size;

  const issueKeys = new Set<string>();
  let missingIssueKeys = 0;
  for (const f of allFindings) {
    if (f.issue_key) {
      issueKeys.add(f.issue_key);
    } else {
      missingIssueKeys++;
    }
  }

  const severityDist = { critical: 0, warning: 0, info: 0 };
  const findingKindDist: Record<string, number> = {};
  const categoryDist: Record<string, number> = {};

  for (const f of allFindings) {
    severityDist[f.severity]++;
    const kind = f.finding_kind ?? "unclassified";
    findingKindDist[kind] = (findingKindDist[kind] ?? 0) + 1;
    const cat = f.category ?? "unclassified";
    categoryDist[cat] = (categoryDist[cat] ?? 0) + 1;
  }

  // Persist the loaded findings to a diagnostic checkpoint for subsequent phases
  await db.execute(
    `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status)
     VALUES ($1, 99, 0, $2::jsonb, 'diagnostic_l3_union')
     ON CONFLICT (module_run_id, tree_level, node_index)
     DO UPDATE SET merged_json = EXCLUDED.merged_json, status = 'diagnostic_l3_union', updated_at = now()`,
    [runId, JSON.stringify({ findings: allFindings, _phase: "load_and_report", _timestamp: new Date().toISOString() })],
    { label: "Persist L3 union for diagnostic phases" }
  );

  return {
    phase: "load_and_report" as const,
    l3_checkpoints_loaded: rows.length,
    total_findings_loaded: allFindings.length,
    unique_finding_ids: uniqueIds.size,
    duplicate_finding_ids: duplicateIds,
    distinct_issue_keys: issueKeys.size,
    findings_missing_issue_keys: missingIssueKeys,
    valid_canonical_findings: allFindings.length,
    invalid_canonical_findings: invalidCount,
    payload_size_by_node: payloadByNode,
    severity_distribution: severityDist,
    finding_kind_distribution: findingKindDist,
    category_distribution: categoryDist,
  };
}

// ===========================================================================
// PHASE 2: Build candidate families
// ===========================================================================

async function phaseBuildFamilies(ctx: DiagCtx): Promise<z.infer<typeof BuildFamiliesOutputSchema>> {
  const { db, runId } = ctx;

  // Load findings from diagnostic checkpoint
  const CheckpointSchema = z.object({ merged_json: z.any() });
  const [checkpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load L3 union checkpoint" }
  );

  if (!checkpoint) {
    throw new Error("L3 union checkpoint not found — run load_and_report phase first");
  }

  const merged = typeof checkpoint.merged_json === "string"
    ? JSON.parse(checkpoint.merged_json) : checkpoint.merged_json;
  const allFindings: CanonicalFinding[] = merged.findings;

  // === Build candidate families using identity fields ===
  const families: CandidateFamily[] = [];
  const assignedFindings = new Set<string>();

  // Strategy 1: Group by issue_key (strongest signal)
  const issueKeyGroups = new Map<string, CanonicalFinding[]>();
  for (const f of allFindings) {
    if (f.issue_key) {
      const key = f.issue_key.toLowerCase().trim().replace(/[\s-]+/g, "_");
      if (!issueKeyGroups.has(key)) issueKeyGroups.set(key, []);
      issueKeyGroups.get(key)!.push(f);
    }
  }

  for (const [key, findings] of issueKeyGroups.entries()) {
    if (findings.length >= 2) {
      const familyId = `ik_${key}_${findings.length}`;
      families.push({
        family_id: familyId,
        grouping_key: `issue_key:${key}`,
        grouping_reasons: [`Shared issue_key "${key}" across ${findings.length} findings`],
        grouping_confidence: "high",
        member_finding_ids: findings.map(f => f.finding_id),
        input_bytes: JSON.stringify(findings).length,
        status: "pending",
        attempt_count: 0,
        split_depth: 0,
        output_finding_ids: [],
        source_fingerprint: hashIds(findings.map(f => f.finding_id)),
      });
      for (const f of findings) assignedFindings.add(f.finding_id);
    }
  }

  // Strategy 2: Group remaining by finding_kind + category combination
  const kindCatGroups = new Map<string, CanonicalFinding[]>();
  for (const f of allFindings) {
    if (assignedFindings.has(f.finding_id)) continue;
    const kind = f.finding_kind ?? "unclassified";
    const cat = f.category ?? "unclassified";
    const key = `${kind}::${cat}`;
    if (!kindCatGroups.has(key)) kindCatGroups.set(key, []);
    kindCatGroups.get(key)!.push(f);
  }

  for (const [key, findings] of kindCatGroups.entries()) {
    if (findings.length >= 2) {
      // Sub-group by source_docs overlap for tighter clusters
      const subgroups = subgroupBySourceOverlap(findings);
      for (let i = 0; i < subgroups.length; i++) {
        const sg = subgroups[i];
        if (sg.length < 2) {
          // Singleton — will be handled below
          continue;
        }
        const familyId = `kc_${key.replace(/::/g, "_")}_sg${i}_${sg.length}`;
        families.push({
          family_id: familyId,
          grouping_key: `kind_cat:${key}:sg${i}`,
          grouping_reasons: [
            `Shared finding_kind+category "${key}"`,
            `Source document overlap in subgroup ${i}`,
          ],
          grouping_confidence: "medium",
          member_finding_ids: sg.map(f => f.finding_id),
          input_bytes: JSON.stringify(sg).length,
          status: "pending",
          attempt_count: 0,
          split_depth: 0,
          output_finding_ids: [],
          source_fingerprint: hashIds(sg.map(f => f.finding_id)),
        });
        for (const f of sg) assignedFindings.add(f.finding_id);
      }
    }
  }

  // Strategy 3: Group remaining by claim_ids overlap
  const claimIndex = new Map<string, CanonicalFinding[]>();
  for (const f of allFindings) {
    if (assignedFindings.has(f.finding_id)) continue;
    for (const cid of f.claim_ids ?? []) {
      if (!claimIndex.has(cid)) claimIndex.set(cid, []);
      claimIndex.get(cid)!.push(f);
    }
  }

  const claimFamilies = new Map<string, Set<string>>();
  for (const [cid, findings] of claimIndex.entries()) {
    if (findings.length >= 2) {
      // Union-find across shared claims
      const ids = findings.map(f => f.finding_id);
      const key = ids.sort().join(",");
      if (!claimFamilies.has(key)) claimFamilies.set(key, new Set(ids));
    }
  }

  for (const [, idSet] of claimFamilies.entries()) {
    const members = allFindings.filter(f => idSet.has(f.finding_id) && !assignedFindings.has(f.finding_id));
    if (members.length >= 2) {
      const familyId = `cl_${hashIds(members.map(f => f.finding_id)).slice(0, 12)}_${members.length}`;
      families.push({
        family_id: familyId,
        grouping_key: `claim_overlap:${members.length}`,
        grouping_reasons: [`Shared claim_ids across ${members.length} findings`],
        grouping_confidence: "medium",
        member_finding_ids: members.map(f => f.finding_id),
        input_bytes: JSON.stringify(members).length,
        status: "pending",
        attempt_count: 0,
        split_depth: 0,
        output_finding_ids: [],
        source_fingerprint: hashIds(members.map(f => f.finding_id)),
      });
      for (const f of members) assignedFindings.add(f.finding_id);
    }
  }

  // Strategy 4: Remaining unassigned findings become singletons
  const singletonFindings = allFindings.filter(f => !assignedFindings.has(f.finding_id));
  for (const f of singletonFindings) {
    families.push({
      family_id: `singleton_${f.finding_id.slice(0, 8)}`,
      grouping_key: `singleton:${f.finding_id}`,
      grouping_reasons: ["No shared identity fields with other findings"],
      grouping_confidence: "high",
      member_finding_ids: [f.finding_id],
      input_bytes: JSON.stringify(f).length,
      status: "complete", // Singletons pass through unchanged
      attempt_count: 0,
      split_depth: 0,
      output_finding_ids: [f.finding_id],
      source_fingerprint: hashIds([f.finding_id]),
    });
  }

  // Count stats
  const singletonCount = families.filter(f => f.member_finding_ids.length === 1).length;
  const multiCount = families.filter(f => f.member_finding_ids.length >= 2).length;
  const needingSplit = families.filter(f => f.member_finding_ids.length > MAX_FINDINGS_PER_CALL).length;

  // Estimate LLM calls
  let estimatedCalls = 0;
  for (const fam of families) {
    if (fam.member_finding_ids.length <= 1) continue;
    if (fam.member_finding_ids.length <= MAX_FINDINGS_PER_CALL) {
      estimatedCalls += 1;
    } else {
      const subgroupCount = Math.ceil(fam.member_finding_ids.length / MAX_FINDINGS_PER_CALL);
      estimatedCalls += subgroupCount + 1; // subgroups + comparison
    }
  }

  // Size distribution
  const sizeDist: Record<string, number> = {};
  for (const fam of families) {
    const size = fam.member_finding_ids.length;
    const bucket = size === 1 ? "1" : size <= 3 ? "2-3" : size <= 6 ? "4-6" : size <= 12 ? "7-12" : "13+";
    sizeDist[bucket] = (sizeDist[bucket] ?? 0) + 1;
  }

  // Persist families to checkpoint
  await db.execute(
    `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status)
     VALUES ($1, 99, 1, $2::jsonb, 'diagnostic_families')
     ON CONFLICT (module_run_id, tree_level, node_index)
     DO UPDATE SET merged_json = EXCLUDED.merged_json, status = 'diagnostic_families', updated_at = now()`,
    [runId, JSON.stringify({ families, _phase: "build_families", _timestamp: new Date().toISOString() })],
    { label: "Persist candidate families" }
  );

  // Top families by size
  const topFamilies = families
    .filter(f => f.member_finding_ids.length >= 2)
    .sort((a, b) => b.member_finding_ids.length - a.member_finding_ids.length)
    .slice(0, 20)
    .map(f => ({
      family_id: f.family_id,
      grouping_key: f.grouping_key,
      member_count: f.member_finding_ids.length,
      grouping_reasons: f.grouping_reasons,
      confidence: f.grouping_confidence,
    }));

  return {
    phase: "build_families" as const,
    total_findings_input: allFindings.length,
    total_families: families.length,
    singleton_families: singletonCount,
    multi_finding_families: multiCount,
    families_needing_split: needingSplit,
    estimated_llm_calls: estimatedCalls,
    family_size_distribution: sizeDist,
    top_families: topFamilies,
    families_persisted: true,
  };
}

// ===========================================================================
// PHASE 3: Process families with bounded LLM calls
// ===========================================================================

async function phaseProcessFamilies(
  ctx: DiagCtx,
  maxFamilies: number,
): Promise<z.infer<typeof ProcessFamiliesOutputSchema>> {
  const { db, runId, startTime, useOpus } = ctx;

  // Load families and findings
  const CheckpointSchema = z.object({ merged_json: z.any() });
  const [familyCheckpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 1
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load families checkpoint" }
  );

  if (!familyCheckpoint) {
    throw new Error("Families checkpoint not found — run build_families phase first");
  }

  const familyData = typeof familyCheckpoint.merged_json === "string"
    ? JSON.parse(familyCheckpoint.merged_json) : familyCheckpoint.merged_json;
  const families: CandidateFamily[] = familyData.families;

  // Load findings
  const [findingsCheckpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load L3 union findings" }
  );

  const findingsData = typeof findingsCheckpoint.merged_json === "string"
    ? JSON.parse(findingsCheckpoint.merged_json) : findingsCheckpoint.merged_json;
  const allFindings: CanonicalFinding[] = findingsData.findings;
  const findingIndex = new Map<string, CanonicalFinding>();
  for (const f of allFindings) findingIndex.set(f.finding_id, f);

  // Process pending families
  const pending = families.filter(f => f.status === "pending");
  let processedCount = 0;
  let totalInputFindings = 0;
  let totalOutputFindings = 0;
  let budgetExhausted = false;

  const model = getModuleModel(ctx.moduleId, useOpus);

  for (const family of pending) {
    if (processedCount >= maxFamilies) break;

    // Budget check
    const elapsed = Date.now() - startTime;
    const remaining = EFFECTIVE_CAP_MS - elapsed;
    if (remaining < MIN_WORK_BUDGET_MS) {
      budgetExhausted = true;
      break;
    }

    const memberFindings = family.member_finding_ids
      .map(id => findingIndex.get(id))
      .filter((f): f is CanonicalFinding => f !== undefined);

    if (memberFindings.length === 0) {
      family.status = "degraded_fallback";
      family.degraded_reason = "No valid findings found for family members";
      processedCount++;
      continue;
    }

    if (memberFindings.length === 1) {
      // Singleton — pass through
      family.status = "complete";
      family.output_finding_ids = [memberFindings[0].finding_id];
      processedCount++;
      continue;
    }

    family.attempt_count++;
    family.status = "processing";

    try {
      let result: FamilyResult;
      if (memberFindings.length <= MAX_FINDINGS_PER_CALL) {
        // Direct consolidation — one call
        result = await consolidateFamily(ctx, family, memberFindings, model);
      } else {
        // Split into coherent subgroups
        result = await consolidateLargeFamily(ctx, family, memberFindings, model);
      }

      family.status = result.status;
      family.output_finding_ids = result.output_findings.map(f => f.finding_id);
      if (result.degraded_reason) family.degraded_reason = result.degraded_reason;

      totalInputFindings += result.input_count;
      totalOutputFindings += result.output_count;
    } catch (err: any) {
      // On failure, preserve originals as degraded
      family.status = "degraded_fallback";
      family.degraded_reason = `Processing error: ${err.message?.slice(0, 200)}`;
      family.output_finding_ids = family.member_finding_ids;
      totalInputFindings += memberFindings.length;
      totalOutputFindings += memberFindings.length;
    }

    processedCount++;
  }

  // Persist updated families
  await db.execute(
    `UPDATE merge_checkpoints
     SET merged_json = $2::jsonb, updated_at = now()
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 1`,
    [runId, JSON.stringify({ families, _phase: "process_families", _timestamp: new Date().toISOString() })],
    { label: "Persist updated families" }
  );

  const complete = families.filter(f => f.status === "complete").length;
  const degraded = families.filter(f => f.status === "degraded_fallback").length;
  const remaining2 = families.filter(f => f.status === "pending" || f.status === "processing").length;

  return {
    phase: "process_families" as const,
    families_processed_this_invocation: processedCount,
    families_remaining: remaining2,
    families_complete: complete,
    families_degraded: degraded,
    findings_input_this_invocation: totalInputFindings,
    findings_output_this_invocation: totalOutputFindings,
    elapsed_ms: Date.now() - startTime,
    budget_exhausted: budgetExhausted,
    next_action: remaining2 > 0 ? "invoke process_families again" : "invoke finalize_report",
  };
}

// ===========================================================================
// PHASE 4: Finalize report
// ===========================================================================

async function phaseFinalizeReport(ctx: DiagCtx): Promise<z.infer<typeof FinalReportOutputSchema>> {
  const { db, runId } = ctx;

  // Load families and findings
  const CheckpointSchema = z.object({ merged_json: z.any() });
  const [familyCheckpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 1
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load families checkpoint for finalization" }
  );

  const [findingsCheckpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 0
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load L3 union findings for finalization" }
  );

  if (!familyCheckpoint || !findingsCheckpoint) {
    throw new Error("Required checkpoints not found — run earlier phases first");
  }

  const familyData = typeof familyCheckpoint.merged_json === "string"
    ? JSON.parse(familyCheckpoint.merged_json) : familyCheckpoint.merged_json;
  const families: CandidateFamily[] = familyData.families;

  const findingsData = typeof findingsCheckpoint.merged_json === "string"
    ? JSON.parse(findingsCheckpoint.merged_json) : findingsCheckpoint.merged_json;
  const allFindings: CanonicalFinding[] = findingsData.findings;
  const findingIndex = new Map<string, CanonicalFinding>();
  for (const f of allFindings) findingIndex.set(f.finding_id, f);

  // Check for incomplete families
  const incomplete = families.filter(f => f.status === "pending" || f.status === "processing");
  if (incomplete.length > 0) {
    throw new Error(`${incomplete.length} families still pending — run process_families until all complete`);
  }

  // === Assemble final candidate set ===
  const assembledFindings: CanonicalFinding[] = [];
  const seenIds = new Set<string>();

  // Load any processed family outputs from checkpoint node_index=2
  const [outputsCheckpoint] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 2
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load family outputs checkpoint" }
  );

  const familyOutputs = new Map<string, CanonicalFinding[]>();
  if (outputsCheckpoint) {
    const outputData = typeof outputsCheckpoint.merged_json === "string"
      ? JSON.parse(outputsCheckpoint.merged_json) : outputsCheckpoint.merged_json;
    if (outputData.family_outputs) {
      for (const [fid, findings] of Object.entries(outputData.family_outputs)) {
        familyOutputs.set(fid, findings as CanonicalFinding[]);
      }
    }
  }

  for (const family of families) {
    if (family.status === "complete" && familyOutputs.has(family.family_id)) {
      // Use processed output
      for (const f of familyOutputs.get(family.family_id)!) {
        if (!seenIds.has(f.finding_id)) {
          assembledFindings.push(f);
          seenIds.add(f.finding_id);
        }
      }
    } else {
      // Singleton or degraded — use original findings
      for (const id of family.output_finding_ids) {
        const f = findingIndex.get(id);
        if (f && !seenIds.has(f.finding_id)) {
          assembledFindings.push(f);
          seenIds.add(f.finding_id);
        }
      }
    }
  }

  // === Run deterministic downstream stages ===
  const l3Count = allFindings.length;

  // Stage: Global Semantic Consolidation (deterministic — no LLM)
  const afterConsolidation = runDeterministicConsolidation(assembledFindings);

  // Stage: Materiality gate (deterministic — no LLM)
  const afterMateriality = runMaterialityGate(afterConsolidation);

  // Stage: Absence verification cap (deterministic — no LLM)
  const afterAbsence = runAbsenceCap(afterMateriality);

  const finalFindings = afterAbsence;

  // === Quality classification ===
  const finalCount = finalFindings.length;
  const classification = finalCount <= 30
    ? "healthy_candidate" as const
    : finalCount <= 50
      ? "quality_warning" as const
      : "quality_failure_diagnostic" as const;

  // === Count waterfall ===
  const singletonFamilies = families.filter(f => f.member_finding_ids.length === 1).length;
  const multiFamilies = families.filter(f => f.member_finding_ids.length >= 2).length;
  const completedConsolidations = families.filter(f => f.status === "complete" && f.member_finding_ids.length >= 2).length;
  const degradedFamilies = families.filter(f => f.status === "degraded_fallback").length;

  // === Ground truth verification ===
  const groundTruth = verifyGroundTruth(finalFindings);

  // === Duplicate family appendix ===
  const dupAppendix = buildDuplicateFamilyAppendix(families, allFindings, finalFindings);

  // === Persist final diagnostic report ===
  await db.execute(
    `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status)
     VALUES ($1, 99, 9, $2::jsonb, 'completed_diagnostic_with_merge_degradation')
     ON CONFLICT (module_run_id, tree_level, node_index)
     DO UPDATE SET merged_json = EXCLUDED.merged_json, status = 'completed_diagnostic_with_merge_degradation', updated_at = now()`,
    [runId, JSON.stringify({
      quality_classification: classification,
      final_finding_count: finalCount,
      findings: finalFindings,
      count_waterfall: {
        l3_findings: l3Count,
        candidate_families: families.length,
        singleton_families: singletonFamilies,
        multi_finding_families: multiFamilies,
        completed_family_consolidations: completedConsolidations,
        degraded_families: degradedFamilies,
        after_deterministic_consolidation: afterConsolidation.length,
        after_materiality: afterMateriality.length,
        after_absence_verification: afterAbsence.length,
        final_report_findings: finalCount,
      },
      ground_truth: groundTruth,
      _timestamp: new Date().toISOString(),
    })],
    { label: "Persist final diagnostic report" }
  );

  return {
    phase: "finalize_report" as const,
    quality_classification: classification,
    count_waterfall: {
      l3_findings: l3Count,
      candidate_families: families.length,
      singleton_families: singletonFamilies,
      multi_finding_families: multiFamilies,
      completed_family_consolidations: completedConsolidations,
      degraded_families: degradedFamilies,
      after_deterministic_consolidation: afterConsolidation.length,
      after_materiality: afterMateriality.length,
      after_absence_verification: afterAbsence.length,
      final_report_findings: finalCount,
    },
    ground_truth: groundTruth,
    findings: finalFindings.map(f => ({
      finding_id: f.finding_id,
      title: f.title,
      category: f.category ?? "unclassified",
      severity: f.severity,
      finding_kind: f.finding_kind ?? "unclassified",
      issue_key: f.issue_key ?? null,
      source_docs: f.source_docs,
      evidence_count: f.evidence?.length ?? 0,
      claim_ids: f.claim_ids ?? [],
      structured_impact_count: f.structured_impact?.length ?? 0,
      verification_status: f.verification?.status ?? null,
      materiality_rationale: f.materiality_rationale ?? null,
      merged_from_count: f.merged_from_finding_ids?.length ?? 0,
      numeric_unverified: f.numeric_unverified ?? false,
    })),
    duplicate_family_appendix: dupAppendix,
  };
}

// ===========================================================================
// HELPER: Family consolidation (≤6 findings)
// ===========================================================================

async function consolidateFamily(
  ctx: DiagCtx,
  family: CandidateFamily,
  findings: CanonicalFinding[],
  model: string,
): Promise<FamilyResult> {
  const startMs = Date.now();

  const prompt = buildConsolidationPrompt(findings, family.grouping_key);
  const label = `Consolidate family ${family.family_id} (${findings.length} findings)`;

  // Build PipelineContext for callLLMWithHeadroom
  const pCtx: PipelineContext = {
    integrations: { db: ctx.db, ai: ctx.ai },
  };

  let response: LLMResponse;
  try {
    response = await callLLMWithHeadroom(
      pCtx,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: MAX_TOKENS_CONSOLIDATION,
      },
      label,
      { pipelineStartTime: ctx.startTime },
    );
  } catch (err: any) {
    // Headroom exhausted or provider error — degrade gracefully
    return {
      family_id: family.family_id,
      input_count: findings.length,
      output_count: findings.length,
      output_findings: findings,
      status: "degraded_fallback",
      degraded_reason: `LLM call failed: ${err.message?.slice(0, 150)}`,
      elapsed_ms: Date.now() - startMs,
    };
  }

  // Parse response — content is [{type:"text", text:"..."}]
  const text = response.content.map(c => c.text).join("");
  const parsed = parseConsolidationResponse(text, findings);

  if (parsed.findings.length === 0) {
    // Failed parse — return originals
    return {
      family_id: family.family_id,
      input_count: findings.length,
      output_count: findings.length,
      output_findings: findings,
      status: "degraded_fallback",
      degraded_reason: "Failed to parse consolidation response",
      elapsed_ms: Date.now() - startMs,
    };
  }

  // Persist family output
  await persistFamilyOutput(ctx, family.family_id, parsed.findings);

  return {
    family_id: family.family_id,
    input_count: findings.length,
    output_count: parsed.findings.length,
    output_findings: parsed.findings,
    status: "complete",
    elapsed_ms: Date.now() - startMs,
  };
}

// ===========================================================================
// HELPER: Large family consolidation (>6 findings — split into subgroups)
// ===========================================================================

async function consolidateLargeFamily(
  ctx: DiagCtx,
  family: CandidateFamily,
  findings: CanonicalFinding[],
  model: string,
): Promise<FamilyResult> {
  const startMs = Date.now();

  // Build PipelineContext for callLLMWithHeadroom
  const pCtx: PipelineContext = {
    integrations: { db: ctx.db, ai: ctx.ai },
  };

  // Split into coherent subgroups of ≤6
  const subgroups = splitIntoCoherentSubgroups(findings, MAX_FINDINGS_PER_CALL);
  const subgroupResults: CanonicalFinding[] = [];
  let degradedCount = 0;

  for (const sg of subgroups) {
    const elapsed = Date.now() - ctx.startTime;
    const remaining = EFFECTIVE_CAP_MS - elapsed;
    if (remaining < MIN_WORK_BUDGET_MS) {
      // Budget exhausted — pass through remaining subgroups
      subgroupResults.push(...sg);
      degradedCount++;
      continue;
    }

    const prompt = buildConsolidationPrompt(sg, family.grouping_key);
    const label = `Consolidate subgroup of family ${family.family_id} (${sg.length} findings)`;
    try {
      const response = await callLLMWithHeadroom(
        pCtx,
        {
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: MAX_TOKENS_CONSOLIDATION,
        },
        label,
        { pipelineStartTime: ctx.startTime },
      );

      const text = response.content.map(c => c.text).join("");
      const parsed = parseConsolidationResponse(text, sg);
      if (parsed.findings.length > 0) {
        subgroupResults.push(...parsed.findings);
      } else {
        subgroupResults.push(...sg);
        degradedCount++;
      }
    } catch (err: any) {
      subgroupResults.push(...sg);
      degradedCount++;
    }
  }

  // If we have multiple subgroup results, run a bounded comparison
  // to catch duplicates split across subgroups
  let finalResults = subgroupResults;
  if (subgroupResults.length > MAX_FINDINGS_PER_CALL && subgroupResults.length <= 30) {
    // Run deterministic dedup only — no additional LLM call for cross-subgroup comparison
    finalResults = runDeterministicConsolidation(subgroupResults);
  }

  // Persist
  await persistFamilyOutput(ctx, family.family_id, finalResults);

  const status = degradedCount > 0 && degradedCount === subgroups.length
    ? "degraded_fallback" as const
    : "complete" as const;

  return {
    family_id: family.family_id,
    input_count: findings.length,
    output_count: finalResults.length,
    output_findings: finalResults,
    status,
    degraded_reason: degradedCount > 0
      ? `${degradedCount}/${subgroups.length} subgroups degraded`
      : undefined,
    elapsed_ms: Date.now() - startMs,
  };
}

// ===========================================================================
// HELPER: Persist family output
// ===========================================================================

async function persistFamilyOutput(ctx: DiagCtx, familyId: string, findings: CanonicalFinding[]) {
  const { db, runId } = ctx;
  const CheckpointSchema = z.object({ merged_json: z.any() });

  // Load existing outputs checkpoint
  const [existing] = await db.query(
    `SELECT merged_json FROM merge_checkpoints
     WHERE module_run_id = $1 AND tree_level = 99 AND node_index = 2
     LIMIT 1`,
    CheckpointSchema,
    [runId],
    { label: "Load existing family outputs" }
  );

  let outputs: Record<string, CanonicalFinding[]> = {};
  if (existing) {
    const data = typeof existing.merged_json === "string"
      ? JSON.parse(existing.merged_json) : existing.merged_json;
    outputs = data.family_outputs ?? {};
  }

  outputs[familyId] = findings;

  await db.execute(
    `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, status)
     VALUES ($1, 99, 2, $2::jsonb, 'diagnostic_family_outputs')
     ON CONFLICT (module_run_id, tree_level, node_index)
     DO UPDATE SET merged_json = EXCLUDED.merged_json, status = 'diagnostic_family_outputs', updated_at = now()`,
    [runId, JSON.stringify({ family_outputs: outputs, _timestamp: new Date().toISOString() })],
    { label: "Persist family outputs" }
  );
}

// ===========================================================================
// HELPER: Build consolidation prompt
// ===========================================================================

function buildConsolidationPrompt(findings: CanonicalFinding[], groupingKey: string): string {
  const findingsJson = findings.map(f => ({
    finding_id: f.finding_id,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
    full_analysis: f.full_analysis,
    source_docs: f.source_docs,
    issue_key: f.issue_key,
    finding_kind: f.finding_kind,
    claim_ids: f.claim_ids,
    evidence: f.evidence,
    structured_impact: f.structured_impact,
  }));

  return `You are consolidating duplicate or overlapping diligence findings that share grouping key: "${groupingKey}".

TASK: Review the following findings and consolidate any that are genuinely the same issue (same underlying fact, same risk, same quantitative claim) into representative findings. Preserve all distinct issues.

RULES:
1. Two findings are duplicates ONLY if they describe the same factual claim about the same metric/period/entity/contract.
2. When consolidating, keep the most complete and highest-severity version as representative.
3. Set merged_from_finding_ids on the representative to include ALL absorbed finding IDs.
4. Preserve ALL source_docs, claim_ids, and evidence from merged findings.
5. Do NOT merge findings that are superficially similar but describe different metrics, periods, or contracts.
6. Do NOT invent new findings or alter quantitative claims.
7. Keep severity values: critical, warning, or info only.

INPUT FINDINGS:
${JSON.stringify(findingsJson, null, 2)}

OUTPUT FORMAT: Return a JSON array of the consolidated findings. Each must include:
- finding_id (UUID — use the representative's existing ID)
- merged_from_finding_ids (array of absorbed finding IDs, empty if no merge)
- severity (critical/warning/info)
- title
- detail
- full_analysis
- source_docs (union of all)
- issue_key
- finding_kind
- claim_ids (union of all)
- evidence (union of all, deduplicated)
- structured_impact (union of all, deduplicated)

Return ONLY the JSON array, no markdown fences, no explanation.`;
}

// ===========================================================================
// HELPER: Parse consolidation response
// ===========================================================================

function parseConsolidationResponse(
  content: string,
  inputFindings: CanonicalFinding[],
): { findings: CanonicalFinding[] } {
  // Try to parse JSON from the response
  let raw: unknown;
  try {
    // Strip markdown fences if present
    const cleaned = content.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    raw = JSON.parse(cleaned);
  } catch {
    // Try extracting JSON array from the content
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        raw = JSON.parse(match[0]);
      } catch {
        return { findings: [] };
      }
    } else {
      return { findings: [] };
    }
  }

  if (!Array.isArray(raw)) return { findings: [] };

  const result = parseCanonicalFindings(raw, { mode: "fresh", source: "consolidation" });
  return { findings: result.findings };
}

// ===========================================================================
// HELPER: Deterministic consolidation (no LLM — union-find on shared keys)
// ===========================================================================

function runDeterministicConsolidation(findings: CanonicalFinding[]): CanonicalFinding[] {
  if (findings.length <= 1) return findings;

  const parent: number[] = findings.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Union by shared claim_ids
  const claimToIdx = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    for (const cid of findings[i].claim_ids ?? []) {
      const norm = cid.toLowerCase().trim();
      if (!claimToIdx.has(norm)) claimToIdx.set(norm, []);
      claimToIdx.get(norm)!.push(i);
    }
  }
  for (const indices of claimToIdx.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  // Union by shared issue_key
  const ikToIdx = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const ik = findings[i].issue_key;
    if (!ik) continue;
    const norm = ik.toLowerCase().trim().replace(/[\s-]+/g, "_");
    if (!ikToIdx.has(norm)) ikToIdx.set(norm, []);
    ikToIdx.get(norm)!.push(i);
  }
  for (const indices of ikToIdx.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  // Build clusters
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  const severityRank = { critical: 3, warning: 2, info: 1 } as Record<string, number>;
  const result: CanonicalFinding[] = [];

  for (const members of clusters.values()) {
    if (members.length === 1) {
      result.push(findings[members[0]]);
      continue;
    }

    // Pick representative: highest severity, then longest full_analysis
    members.sort((a, b) => {
      const sa = severityRank[findings[a].severity] ?? 0;
      const sb = severityRank[findings[b].severity] ?? 0;
      if (sb !== sa) return sb - sa;
      return (findings[b].full_analysis?.length ?? 0) - (findings[a].full_analysis?.length ?? 0);
    });

    const rep = { ...findings[members[0]] };
    const mergedFrom: string[] = [];
    const allClaims = new Set<string>(rep.claim_ids ?? []);
    const allSourceDocs = new Set<string>(rep.source_docs ?? []);

    for (let k = 1; k < members.length; k++) {
      const f = findings[members[k]];
      mergedFrom.push(f.finding_id);
      for (const c of f.claim_ids ?? []) allClaims.add(c);
      for (const s of f.source_docs ?? []) allSourceDocs.add(s);
    }

    rep.merged_from_finding_ids = [
      ...(rep.merged_from_finding_ids ?? []),
      ...mergedFrom,
    ];
    rep.claim_ids = [...allClaims];
    rep.source_docs = [...allSourceDocs];
    result.push(rep);
  }

  return result;
}

// ===========================================================================
// HELPER: Materiality gate (deterministic)
// ===========================================================================

function runMaterialityGate(findings: CanonicalFinding[]): CanonicalFinding[] {
  // Materiality threshold: £50k for critical, £10k for warning
  // If structured_impact verified amounts are below threshold, demote severity
  return findings.map(f => {
    if (f.severity === "info") return f;

    const impacts = f.structured_impact ?? [];
    const verifiedDeltas = impacts.filter(i =>
      i.verified && (i.role === "delta" || i.role === "exposure" || i.role === "annual_impact")
    );

    if (verifiedDeltas.length === 0) return f; // No verified impacts — leave unchanged

    const maxAmount = Math.max(...verifiedDeltas.map(i => Math.abs(i.amount * i.unit_multiplier)));
    const threshold = f.severity === "critical" ? 50_000 : 10_000;

    if (maxAmount < threshold) {
      return {
        ...f,
        severity: "info" as const,
        materiality_rationale: `Verified impact £${Math.round(maxAmount).toLocaleString()} below ${f.severity} threshold £${threshold.toLocaleString()}`,
      };
    }

    return f;
  });
}

// ===========================================================================
// HELPER: Absence cap (deterministic)
// ===========================================================================

function runAbsenceCap(findings: CanonicalFinding[]): CanonicalFinding[] {
  const ABSENCE_PATTERNS = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;

  return findings.map(f => {
    if (f.severity === "info") return f;
    if (f.finding_kind === "data_divergence") return f;

    const isAbsence =
      f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged" ||
      ABSENCE_PATTERNS.test(f.full_analysis ?? "") || ABSENCE_PATTERNS.test(f.detail ?? "");

    if (isAbsence && f.absence_confidence !== "verified_absent") {
      return { ...f, severity: "info" as const };
    }

    return f;
  });
}

// ===========================================================================
// HELPER: Ground truth verification
// ===========================================================================

function verifyGroundTruth(findings: CanonicalFinding[]) {
  const expectedPresent = [
    { issue: "FY26 revenue revision", patterns: ["fy26 revenue", "revenue revision", "revenue downgrade"] },
    { issue: "FY26 reported EBITDA revision", patterns: ["fy26 ebitda", "ebitda revision", "ebitda restate"] },
    { issue: "widening adjustments", patterns: ["widening adjust", "adjustment gap", "normalised.*adjust"] },
    { issue: "memo/model FY26 revenue gap", patterns: ["memo.*model.*gap", "revenue.*gap.*memo", "revenue gap"] },
    { issue: "Calls & Lines decline", patterns: ["calls.*lines.*decline", "calls decline", "lines decline", "call volume"] },
    { issue: "FCA section 19", patterns: ["fca", "section 19", "financial conduct"] },
    { issue: "M&A-dependent deleveraging", patterns: ["deleverag", "m&a.*dependent", "leverage.*m&a"] },
    { issue: "uncapped indemnities", patterns: ["uncapped indemn", "indemnit.*uncapped", "unlimited indemn"] },
    { issue: "change-of-control rights", patterns: ["change.of.control", "coc right", "change of control"] },
    { issue: "absent LBO model", patterns: ["lbo model", "absent.*lbo", "lbo.*absent", "leveraged buyout model"] },
  ];

  const expectedAbsent = [
    { issue: "SIP Calls -34.1ppt margin collapse", patterns: ["sip.*34.1", "34.1ppt", "margin collapse.*sip"] },
    { issue: "£19.5m FY25 period-mislabel divergence", patterns: ["19.5m.*fy25.*mislabel", "period.mislabel.*19.5", "£19.5m.*period"] },
    { issue: "128% vs 55% market-share contradiction", patterns: ["128%.*55%", "market.share.*128", "market.share.*contradict"] },
    { issue: "£19k lease rated critical", patterns: ["19k.*lease.*critical", "£19k.*lease", "19,000.*lease.*critical"] },
  ];

  const searchText = (f: CanonicalFinding) =>
    `${f.title} ${f.detail} ${f.full_analysis} ${f.issue_key ?? ""}`.toLowerCase();

  const presentResults = expectedPresent.map(({ issue, patterns }) => {
    const found = findings.find(f => {
      const text = searchText(f);
      return patterns.some(p => new RegExp(p, "i").test(text));
    });
    return {
      issue,
      found: !!found,
      finding_id: found?.finding_id,
    };
  });

  const absentResults = expectedAbsent.map(({ issue, patterns }) => {
    const found = findings.find(f => {
      const text = searchText(f);
      return patterns.some(p => new RegExp(p, "i").test(text));
    });
    return {
      issue,
      correctly_excluded: !found,
      finding_id: found?.finding_id,
    };
  });

  return { expected_present: presentResults, expected_absent: absentResults };
}

// ===========================================================================
// HELPER: Duplicate family appendix
// ===========================================================================

function buildDuplicateFamilyAppendix(
  families: CandidateFamily[],
  allFindings: CanonicalFinding[],
  finalFindings: CanonicalFinding[],
): Array<{ topic: string; before_count: number; after_count: number }> {
  const topics = [
    { topic: "FCA / section 19", pattern: /fca|section.19|financial.conduct/i },
    { topic: "One Park Lane", pattern: /one.park.lane|park.lane/i },
    { topic: "change-of-control", pattern: /change.of.control|coc/i },
    { topic: "1954 Act contracting-out", pattern: /1954.act|contracting.out/i },
    { topic: "IP assignment and licensing", pattern: /ip.assign|intellectual.property.*licen/i },
    { topic: "GDPR / cookies / consent", pattern: /gdpr|cookie|consent.*data/i },
    { topic: "stale Legal-DD scope", pattern: /legal.dd.*scope|stale.*legal/i },
    { topic: "FY26 revenue discrepancies", pattern: /fy26.*revenue|revenue.*fy26|fy2026.*revenue/i },
    { topic: "FY26 EBITDA discrepancies", pattern: /fy26.*ebitda|ebitda.*fy26|fy2026.*ebitda/i },
  ];

  const textOf = (f: CanonicalFinding) => `${f.title} ${f.detail} ${f.issue_key ?? ""}`.toLowerCase();

  return topics.map(({ topic, pattern }) => {
    const beforeCount = allFindings.filter(f => pattern.test(textOf(f))).length;
    const afterCount = finalFindings.filter(f => pattern.test(textOf(f))).length;
    return { topic, before_count: beforeCount, after_count: afterCount };
  });
}

// ===========================================================================
// HELPER: Subgroup by source document overlap
// ===========================================================================

function subgroupBySourceOverlap(findings: CanonicalFinding[]): CanonicalFinding[][] {
  if (findings.length <= 6) return [findings];

  // Cluster by source_docs overlap using union-find
  const parent: number[] = findings.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const docToIndices = new Map<string, number[]>();
  for (let i = 0; i < findings.length; i++) {
    for (const doc of findings[i].source_docs) {
      const norm = doc.toLowerCase().trim();
      if (!docToIndices.has(norm)) docToIndices.set(norm, []);
      docToIndices.get(norm)!.push(i);
    }
  }

  for (const indices of docToIndices.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0], indices[k]);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  return [...clusters.values()].map(indices => indices.map(i => findings[i]));
}

// ===========================================================================
// HELPER: Split into coherent subgroups of ≤maxSize
// ===========================================================================

function splitIntoCoherentSubgroups(findings: CanonicalFinding[], maxSize: number): CanonicalFinding[][] {
  if (findings.length <= maxSize) return [findings];

  // First try source-based subgrouping
  const sourceGroups = subgroupBySourceOverlap(findings);

  const result: CanonicalFinding[][] = [];
  for (const group of sourceGroups) {
    if (group.length <= maxSize) {
      result.push(group);
    } else {
      // Further split large groups by severity, then arbitrary ≤maxSize chunks
      const bySeverity: Record<string, CanonicalFinding[]> = {};
      for (const f of group) {
        if (!bySeverity[f.severity]) bySeverity[f.severity] = [];
        bySeverity[f.severity].push(f);
      }
      for (const sevGroup of Object.values(bySeverity)) {
        for (let i = 0; i < sevGroup.length; i += maxSize) {
          result.push(sevGroup.slice(i, i + maxSize));
        }
      }
    }
  }

  return result;
}

// ===========================================================================
// HELPER: Hash finding IDs for fingerprint
// ===========================================================================

function hashIds(ids: string[]): string {
  const sorted = [...ids].sort();
  let hash = 0;
  const str = sorted.join("|");
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
