/**
 * Diagnostic API — Model-Based Finding Grouper (MR-B1)
 *
 * Standalone test harness: groups real OA findings using the model to judge
 * "same issue," then code-enforces the dimensional compatibility gate.
 *
 * Does NOT touch deduplicateFindings, the live OA path, or any production logic.
 * Read-only: no writes to module_outputs or anywhere else.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  extractDimensions,
  areDimensionsCompatible,
} from "./canonical-family-dedup.js";
import type { GroupingDimension, DimensionVector } from "./canonical-family-dedup.js";
import type { CanonicalFinding } from "./canonical-finding.js";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// All 17 material dimensions — same as used by diag-consolidation-dryrun.ts
// This is the MOST CONSERVATIVE gate: any pair with differing non-null values
// on ANY dimension will be rejected.
const ALL_DIMENSIONS: GroupingDimension[] = [
  "entity", "counterparty", "counterparty_role", "contract", "property",
  "product", "issue_provision", "affected_obligation", "period", "segment",
  "scope", "metric", "unit_scale", "actual_forecast", "accounting_basis",
  "comparison_basis", "source_authority",
];

// No required separations for the general gate (no fail-closed on double-null)
const REQUIRED_SEPARATIONS: GroupingDimension[] = [];

// Token budget safety: if input exceeds this char count, batch
const MAX_INPUT_CHARS = 550_000; // ~137k tokens, well within 200k context

// ─── Response Schema for Anthropic ─────────────────────────────────────────
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    })
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ─── Model response shape ──────────────────────────────────────────────────
interface ModelGroup {
  group_id: number;
  member_refs: string[];
  reason: string;
}
interface ModelResponse {
  groups: ModelGroup[];
  ungrouped_refs: string[];
}

// ─── Output schemas ────────────────────────────────────────────────────────
const GateSplitEntry = z.object({
  ref_a: z.string(),
  ref_b: z.string(),
  title_a: z.string(),
  title_b: z.string(),
  conflicting_dimension: z.string(),
  failed_closed: z.boolean(),
});

const GroupSampleEntry = z.object({
  group_id: z.number(),
  size: z.number(),
  reason: z.string(),
  member_titles: z.array(z.string()),
});

const SpotCheckEntry = z.object({
  group_id: z.number(),
  reason: z.string(),
  size: z.number(),
});

const ConservationReport = z.object({
  total_refs: z.number(),
  accounted_refs: z.number(),
  missing_refs: z.array(z.string()),
  duplicated_refs: z.array(z.string()),
  conservation_ok: z.boolean(),
});

// ─── API ───────────────────────────────────────────────────────────────────
export default api({
  name: "DiagModelGrouper",
  description: "Model-based grouper test harness for OA findings with gate enforcement",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string().nullable().describe("Explicit run ID; null = auto-select largest OA run"),
    dryRun: z.boolean().nullable().describe("Reserved for future use; currently ignored"),
  }),

  output: z.object({
    runId: z.string(),
    findingCount: z.number(),
    modelUsed: z.string(),
    oneCallOrBatches: z.string(),
    batchCount: z.number(),
    batchSize: z.number().nullable(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    parseFailed: z.boolean(),
    parseError: z.string().nullable(),
    // Pre-gate
    proposedGroupCount: z.number(),
    proposedFindingsInGroups: z.number(),
    proposedUngrouped: z.number(),
    // Post-gate
    afterGateGroupCount: z.number(),
    afterGateFindingsInGroups: z.number(),
    afterGateUngrouped: z.number(),
    projectedFindingCountAfter: z.number(),
    countingRule: z.string(),
    // Gate dimensions used
    materialDimensions: z.array(z.string()),
    requiredSeparations: z.array(z.string()),
    // Conservation
    conservation: ConservationReport,
    // Gate splits
    gateSplitCount: z.number(),
    gateSplits: z.array(GateSplitEntry),
    // Human review sample
    sampleGroups: z.array(GroupSampleEntry),
    // Spot check
    spotCheckReasons: z.array(SpotCheckEntry),
  }),

  async run(ctx, { runId: inputRunId }) {
    // ── Step 0: Resolve run ID ─────────────────────────────────────────────
    let resolvedRunId: string;

    if (inputRunId) {
      resolvedRunId = inputRunId;
    } else {
      const AutoSelectRow = z.object({ id: z.string() });
      const autoRows = await ctx.integrations.db.query(
        `SELECT mr.id
         FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        AutoSelectRow,
        [SCG_DEAL_ID],
        { label: "Auto-select largest OA run" }
      );
      if (autoRows.length === 0) {
        throw new Error("No completed omission_audit runs found for SCG deal");
      }
      resolvedRunId = autoRows[0].id;
    }

    // ── Fetch findings ─────────────────────────────────────────────────────
    const FindingsRow = z.object({ findings: z.any() });
    const findingsRows = await ctx.integrations.db.query(
      `SELECT findings FROM module_outputs WHERE module_run_id = $1`,
      FindingsRow,
      [resolvedRunId],
      { label: "Fetch module_outputs findings" }
    );

    if (findingsRows.length === 0) {
      throw new Error(`No module_outputs found for run ${resolvedRunId}`);
    }

    const rawFindings: Array<any> = Array.isArray(findingsRows[0].findings)
      ? findingsRows[0].findings
      : [];

    const findingCount = rawFindings.length;

    // Build ref → finding_id map and compact projection
    const refToId = new Map<string, string>();
    const refToIndex = new Map<string, number>();
    const compactFindings: Array<{ ref: string; title: string; detail_trimmed: string; source_docs: string[] }> = [];

    for (let i = 0; i < rawFindings.length; i++) {
      const f = rawFindings[i];
      const ref = `f${String(i + 1).padStart(3, "0")}`;
      const findingId = f.finding_id || `oa_${i}`;
      refToId.set(ref, findingId);
      refToIndex.set(ref, i);
      compactFindings.push({
        ref,
        title: f.title || "",
        detail_trimmed: (f.detail || "").slice(0, 400),
        source_docs: f.source_docs || [],
      });
    }

    const allRefs = new Set(compactFindings.map((c) => c.ref));

    // ── Step 1: Build input text ───────────────────────────────────────────
    const findingLines = compactFindings.map((c) => {
      const docs = c.source_docs.length > 0 ? ` [Sources: ${c.source_docs.join(", ")}]` : "";
      return `${c.ref}: ${c.title}\n  Detail: ${c.detail_trimmed}${docs}`;
    });

    const inputText = findingLines.join("\n\n");
    const model = getModuleModel("omission_audit"); // Sonnet for OA

    // ── Step 2: Model call(s) ──────────────────────────────────────────────
    const systemPrompt = `You are grouping private-equity due-diligence findings from an Omission Audit report. Below is a numbered list of findings. Group together ONLY findings that describe the SAME underlying issue (same specific problem about the same subject), even if worded differently. Do NOT group findings that are merely related or in the same topic area — they must be about the exact same issue to be grouped.

Return ONLY valid JSON (no markdown, no explanation):
{
  "groups": [
    { "group_id": 1, "member_refs": ["f012", "f055"], "reason": "one sentence: why these are the same issue" }
  ],
  "ungrouped_refs": ["f077", "f123"]
}

Rules:
- Every ref from the input must appear exactly once — either in one group's member_refs or in ungrouped_refs.
- A group must have at least 2 members.
- Do not invent refs that don't exist in the input.
- Do not put a ref in more than one group.
- Be conservative: if two findings are merely about similar topics but different specific issues, keep them ungrouped.`;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let batchCount = 1;
    let batchSize: number | null = null;
    let oneCallOrBatches = "one_call";
    let parseFailed = false;
    let parseError: string | null = null;
    let allGroups: ModelGroup[] = [];
    let allUngroupedRefs: string[] = [];

    if (inputText.length > MAX_INPUT_CHARS) {
      // ── Step 2b: Batch mode ────────────────────────────────────────────
      const targetBatchChars = Math.floor(MAX_INPUT_CHARS * 0.8); // 80% of max per batch
      const batches: string[][] = [];
      let currentBatch: string[] = [];
      let currentChars = 0;

      for (const line of findingLines) {
        if (currentChars + line.length > targetBatchChars && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentChars = 0;
        }
        currentBatch.push(line);
        currentChars += line.length;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      batchCount = batches.length;
      batchSize = Math.ceil(findingCount / batchCount);
      oneCallOrBatches = `${batchCount}_batches`;

      for (const batch of batches) {
        const batchInput = batch.join("\n\n");
        try {
          const result = await ctx.integrations.ai.apiRequest(
            {
              method: "POST",
              path: "/v1/messages",
              body: {
                model,
                max_tokens: 8000,
                system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
                messages: [{ role: "user", content: batchInput }],
              },
            },
            { response: MessageResponseSchema },
            { label: `DiagModelGrouper batch (${batch.length} findings)` }
          );

          totalInputTokens += result.usage.input_tokens;
          totalOutputTokens += result.usage.output_tokens;

          const textBlock = result.content.find((c) => c.type === "text");
          if (!textBlock) {
            parseFailed = true;
            parseError = "No text content in batch response";
            break;
          }

          const parsed = parseModelResponse(textBlock.text);
          if (!parsed) {
            parseFailed = true;
            parseError = `Failed to parse batch response JSON`;
            break;
          }

          // Offset group_ids to avoid collisions across batches
          const offset = allGroups.length;
          for (const g of parsed.groups) {
            allGroups.push({ ...g, group_id: g.group_id + offset });
          }
          allUngroupedRefs.push(...parsed.ungrouped_refs);
        } catch (e: any) {
          parseFailed = true;
          parseError = `Batch call error: ${e.message || String(e)}`;
          break;
        }
      }
    } else {
      // ── Single call ─────────────────────────────────────────────────────
      try {
        const result = await ctx.integrations.ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model,
              max_tokens: 8000,
              system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: inputText }],
            },
          },
          { response: MessageResponseSchema },
          { label: "DiagModelGrouper: single-call grouping" }
        );

        totalInputTokens = result.usage.input_tokens;
        totalOutputTokens = result.usage.output_tokens;

        const textBlock = result.content.find((c) => c.type === "text");
        if (!textBlock) {
          parseFailed = true;
          parseError = "No text content in model response";
        } else {
          const parsed = parseModelResponse(textBlock.text);
          if (!parsed) {
            parseFailed = true;
            parseError = "Failed to parse model response as valid JSON";
          } else {
            allGroups = parsed.groups;
            allUngroupedRefs = parsed.ungrouped_refs;
          }
        }
      } catch (e: any) {
        parseFailed = true;
        parseError = `Model call error: ${e.message || String(e)}`;
      }
    }

    // If parse failed, treat all findings as ungrouped
    if (parseFailed) {
      allGroups = [];
      allUngroupedRefs = [...allRefs];
    }

    // ── Conservation check ─────────────────────────────────────────────────
    const seenRefs = new Map<string, number>();
    for (const g of allGroups) {
      for (const ref of g.member_refs) {
        seenRefs.set(ref, (seenRefs.get(ref) || 0) + 1);
      }
    }
    for (const ref of allUngroupedRefs) {
      seenRefs.set(ref, (seenRefs.get(ref) || 0) + 1);
    }

    const missingRefs: string[] = [];
    const duplicatedRefs: string[] = [];
    for (const ref of allRefs) {
      const count = seenRefs.get(ref) || 0;
      if (count === 0) missingRefs.push(ref);
      if (count > 1) duplicatedRefs.push(ref);
    }
    // Also check for invented refs
    for (const ref of seenRefs.keys()) {
      if (!allRefs.has(ref)) {
        missingRefs.push(`INVENTED:${ref}`);
      }
    }

    const conservation: z.infer<typeof ConservationReport> = {
      total_refs: findingCount,
      accounted_refs: seenRefs.size,
      missing_refs: missingRefs,
      duplicated_refs: duplicatedRefs,
      conservation_ok: missingRefs.length === 0 && duplicatedRefs.length === 0,
    };

    // Pre-gate stats
    const proposedGroupCount = allGroups.filter((g) => g.member_refs.length >= 2).length;
    const proposedFindingsInGroups = allGroups
      .filter((g) => g.member_refs.length >= 2)
      .reduce((s, g) => s + g.member_refs.length, 0);
    const proposedUngrouped = findingCount - proposedFindingsInGroups;

    // ── Step 3: Enforce dimensional compatibility gate ─────────────────────
    // Build dimension vectors for all findings
    const dimCache = new Map<string, DimensionVector>();
    for (const [ref, idx] of refToIndex) {
      const f = rawFindings[idx];
      // Cast to CanonicalFinding shape for extractDimensions
      const asFinding: CanonicalFinding = {
        finding_id: f.finding_id || `oa_${idx}`,
        severity: f.severity || "info",
        title: f.title || "",
        detail: f.detail || "",
        full_analysis: f.full_analysis || "",
        source_docs: f.source_docs || [],
        issue_key: f.issue_key || undefined,
        category: f.category || undefined,
        finding_kind: f.finding_kind || undefined,
        claim_ids: f.claim_ids || undefined,
      };
      dimCache.set(ref, extractDimensions(asFinding));
    }

    // For each group with 2+ members, check all pairs
    interface GateSplit {
      ref_a: string;
      ref_b: string;
      title_a: string;
      title_b: string;
      conflicting_dimension: string;
      failed_closed: boolean;
    }

    const gateSplits: GateSplit[] = [];

    // Post-gate groups: split incompatible members using greedy sub-grouping
    const postGateGroups: Array<{ group_id: number; member_refs: string[]; reason: string }> = [];

    for (const group of allGroups) {
      if (group.member_refs.length < 2) {
        // Single-member "groups" become ungrouped
        continue;
      }

      // Greedy sub-grouping (same algorithm as partitionByDimensions)
      const subgroups: Array<{ seed: DimensionVector; members: string[] }> = [];

      for (const ref of group.member_refs) {
        if (!dimCache.has(ref)) continue; // skip invented refs
        const dims = dimCache.get(ref)!;

        let placed = false;
        for (const sg of subgroups) {
          const check = areDimensionsCompatible(dims, sg.seed, ALL_DIMENSIONS, REQUIRED_SEPARATIONS);
          if (check.compatible) {
            sg.members.push(ref);
            // Update seed: fill nulls with new values
            for (const dim of ALL_DIMENSIONS) {
              if (sg.seed[dim] === null && dims[dim] !== null) {
                (sg.seed as any)[dim] = dims[dim];
              }
            }
            placed = true;
            break;
          } else {
            // Record the gate split
            if (gateSplits.length < 30) {
              const idxA = refToIndex.get(sg.members[0])!;
              const idxB = refToIndex.get(ref)!;
              gateSplits.push({
                ref_a: sg.members[0],
                ref_b: ref,
                title_a: (rawFindings[idxA].title || "").slice(0, 150),
                title_b: (rawFindings[idxB].title || "").slice(0, 150),
                conflicting_dimension: check.conflictingDimension || "unknown",
                failed_closed: check.failedClosed,
              });
            }
          }
        }

        if (!placed) {
          // Start a new sub-group
          subgroups.push({ seed: { ...dims }, members: [ref] });
        }
      }

      // Each sub-group with 2+ members becomes a post-gate group
      for (const sg of subgroups) {
        if (sg.members.length >= 2) {
          postGateGroups.push({
            group_id: postGateGroups.length + 1,
            member_refs: sg.members,
            reason: group.reason,
          });
        }
      }
    }

    // Post-gate stats
    const afterGateGroupCount = postGateGroups.length;
    const afterGateFindingsInGroups = postGateGroups.reduce((s, g) => s + g.member_refs.length, 0);
    const afterGateUngrouped = findingCount - afterGateFindingsInGroups;

    // Counting rule: projected = post-gate groups (1 representative each) + ungrouped singletons
    const projectedFindingCountAfter = afterGateGroupCount + afterGateUngrouped;

    // ── Step 4: Build output ───────────────────────────────────────────────

    // SAMPLE FOR HUMAN REVIEW: 20 largest post-gate groups
    const sortedPostGate = [...postGateGroups].sort((a, b) => b.member_refs.length - a.member_refs.length);
    const sampleGroups = sortedPostGate.slice(0, 20).map((g) => ({
      group_id: g.group_id,
      size: g.member_refs.length,
      reason: g.reason,
      member_titles: g.member_refs.map((ref) => {
        const idx = refToIndex.get(ref);
        return idx !== undefined ? (rawFindings[idx].title || "").slice(0, 200) : `[unknown ref: ${ref}]`;
      }),
    }));

    // SPOT CHECK: 10 random groups' reasons
    const shuffled = [...postGateGroups].sort(() => Math.random() - 0.5);
    const spotCheckReasons = shuffled.slice(0, 10).map((g) => ({
      group_id: g.group_id,
      reason: g.reason,
      size: g.member_refs.length,
    }));

    return {
      runId: resolvedRunId,
      findingCount,
      modelUsed: model,
      oneCallOrBatches,
      batchCount,
      batchSize,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      parseFailed,
      parseError,
      proposedGroupCount,
      proposedFindingsInGroups,
      proposedUngrouped,
      afterGateGroupCount,
      afterGateFindingsInGroups,
      afterGateUngrouped,
      projectedFindingCountAfter,
      countingRule: "projected = post_gate_groups (1 representative each) + all ungrouped singletons",
      materialDimensions: ALL_DIMENSIONS as string[],
      requiredSeparations: REQUIRED_SEPARATIONS as string[],
      conservation,
      gateSplitCount: gateSplits.length,
      gateSplits,
      sampleGroups,
      spotCheckReasons,
    };
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseModelResponse(text: string): ModelResponse | null {
  try {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.groups) || !Array.isArray(parsed.ungrouped_refs)) {
      return null;
    }
    // Validate structure
    for (const g of parsed.groups) {
      if (typeof g.group_id !== "number" || !Array.isArray(g.member_refs) || typeof g.reason !== "string") {
        return null;
      }
    }
    return parsed as ModelResponse;
  } catch {
    return null;
  }
}
