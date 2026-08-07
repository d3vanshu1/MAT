/**
 * Diagnostic API — Deal-Agnostic Consolidation Engine (MG-1)
 *
 * Standalone diagnostic that runs multi-pass agglomerative grouping on real OA
 * findings. Model proposes initial groups (Pass 1), then agglomerative passes
 * merge group representatives until a fixed-point or maxPasses is reached.
 *
 * NO dimension gate. NO production path changes. Measurement-only:
 * tells us the real collapse rate and over-merge rate before we build
 * the gate (MG-2) or wire it in (MG-3).
 *
 * Outputs:
 *   - Per-pass stats (groups, merges, token usage)
 *   - Final collapse ratio
 *   - Comparison to old SCG-hardcoded engine (deduplicateFindings)
 *   - Top-25 largest final groups (all member titles + reasons)
 *   - Flagged potential over-merge candidates
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import type { CanonicalFinding } from "./canonical-finding.js";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

const MAX_INPUT_CHARS = 550_000;

// ─── Anthropic response schema ──────────────────────────────────────────────
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

// ─── Internal types ─────────────────────────────────────────────────────────
interface ModelGroup {
  group_id: number;
  member_refs: string[];
  reason: string;
}
interface ModelResponse {
  groups: ModelGroup[];
  ungrouped_refs: string[];
}

/** A consolidated group tracking original finding refs through passes */
interface ConsolidatedGroup {
  groupId: number;
  memberRefs: string[]; // original fNNN refs
  reasons: string[];    // accumulated reasons across passes
}

interface PassStats {
  pass: number;
  inputItems: number;
  groupsFormed: number;
  mergesPerformed: number;
  ungroupedAfter: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ─── System prompt (identical to MR-B1) ─────────────────────────────────────
const SYSTEM_PROMPT = `You are grouping private-equity due-diligence findings from an Omission Audit report. Below is a numbered list of findings. Group together ONLY findings that describe the SAME underlying issue (same specific problem about the same subject), even if worded differently. Do NOT group findings that are merely related or in the same topic area — they must be about the exact same issue to be grouped.

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

// ─── Over-merge detection ───────────────────────────────────────────────────
const STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "being", "below", "between",
  "could", "during", "every", "finding", "found", "further", "given", "having",
  "issue", "issues", "might", "other", "potential", "related", "report", "reported",
  "review", "reviewed", "should", "their", "there", "these", "those", "through",
  "under", "where", "which", "while", "would", "without", "within", "across",
  "around", "concern", "concerning", "analysis", "identified", "regarding",
  "documentation", "compliance", "regulatory", "requirement", "requirements",
]);

function extractDistinctiveNouns(title: string): Set<string> {
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
  const nouns = new Set<string>();
  for (const w of words) {
    if (w.length > 5 && !STOP_WORDS.has(w)) nouns.add(w);
  }
  return nouns;
}

function detectOverMerge(
  group: ConsolidatedGroup,
  refToTitle: Map<string, string>
): { flagged: boolean; signal: string } {
  if (group.memberRefs.length < 3) return { flagged: false, signal: "" };

  // Heuristic: if any two members share zero distinctive nouns, flag
  const memberNouns: Array<{ ref: string; nouns: Set<string> }> = [];
  for (const ref of group.memberRefs) {
    const title = refToTitle.get(ref) || "";
    memberNouns.push({ ref, nouns: extractDistinctiveNouns(title) });
  }

  // Check for pairs with zero overlap
  const zeroOverlapPairs: string[] = [];
  for (let i = 0; i < memberNouns.length && zeroOverlapPairs.length < 3; i++) {
    for (let j = i + 1; j < memberNouns.length && zeroOverlapPairs.length < 3; j++) {
      const a = memberNouns[i];
      const b = memberNouns[j];
      if (a.nouns.size === 0 || b.nouns.size === 0) continue;
      let overlap = false;
      for (const n of a.nouns) { if (b.nouns.has(n)) { overlap = true; break; } }
      if (!overlap) {
        zeroOverlapPairs.push(`${a.ref}↔${b.ref}`);
      }
    }
  }

  if (zeroOverlapPairs.length > 0) {
    return {
      flagged: true,
      signal: `Zero noun overlap: ${zeroOverlapPairs.join(", ")}`,
    };
  }
  return { flagged: false, signal: "" };
}

// ─── Model response parser (replicated from diag-model-grouper, not exported)
function parseModelResponse(text: string): ModelResponse | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.groups) || !Array.isArray(parsed.ungrouped_refs)) {
      return null;
    }
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

// ─── Model call helper ──────────────────────────────────────────────────────
async function callModel(
  ai: any,
  model: string,
  inputText: string,
  label: string
): Promise<{ response: ModelResponse | null; inputTokens: number; outputTokens: number; error: string | null }> {
  const findingLines = inputText; // already formatted
  const targetBatchChars = Math.floor(MAX_INPUT_CHARS * 0.8);

  if (inputText.length <= MAX_INPUT_CHARS) {
    // Single call
    try {
      const result = await ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model,
            max_tokens: 16000,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: inputText }],
          },
        },
        { response: MessageResponseSchema },
        { label }
      );
      const textBlock = result.content.find((c: any) => c.type === "text");
      if (!textBlock) return { response: null, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, error: "No text content" };
      const parsed = parseModelResponse(textBlock.text);
      if (!parsed) return { response: null, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, error: "Parse failed" };
      return { response: parsed, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, error: null };
    } catch (e: any) {
      return { response: null, inputTokens: 0, outputTokens: 0, error: e.message || String(e) };
    }
  }

  // Batch mode — split by lines (each "item" is separated by \n\n)
  const items = inputText.split("\n\n");
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;
  for (const item of items) {
    if (currentChars + item.length > targetBatchChars && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(item);
    currentChars += item.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  let allGroups: ModelGroup[] = [];
  let allUngrouped: string[] = [];
  let totalIn = 0, totalOut = 0;

  for (let i = 0; i < batches.length; i++) {
    const batchInput = batches[i].join("\n\n");
    try {
      const result = await ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model,
            max_tokens: 16000,
            system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: batchInput }],
          },
        },
        { response: MessageResponseSchema },
        { label: `${label} batch ${i + 1}/${batches.length}` }
      );
      totalIn += result.usage.input_tokens;
      totalOut += result.usage.output_tokens;
      const textBlock = result.content.find((c: any) => c.type === "text");
      if (!textBlock) return { response: null, inputTokens: totalIn, outputTokens: totalOut, error: `Batch ${i + 1}: no text content` };
      const parsed = parseModelResponse(textBlock.text);
      if (!parsed) return { response: null, inputTokens: totalIn, outputTokens: totalOut, error: `Batch ${i + 1}: parse failed` };
      const offset = allGroups.length;
      for (const g of parsed.groups) allGroups.push({ ...g, group_id: g.group_id + offset });
      allUngrouped.push(...parsed.ungrouped_refs);
    } catch (e: any) {
      return { response: null, inputTokens: totalIn, outputTokens: totalOut, error: `Batch ${i + 1}: ${e.message || String(e)}` };
    }
  }

  return { response: { groups: allGroups, ungrouped_refs: allUngrouped }, inputTokens: totalIn, outputTokens: totalOut, error: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Definition
// ═══════════════════════════════════════════════════════════════════════════════
export default api({
  name: "DiagConsolidationEngine",
  description: "Multi-pass agglomerative grouping diagnostic on real OA findings.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    runId: z.string().nullable(),
    maxPasses: z.number().nullable(),
  }),
  output: z.object({
    runId: z.string(),
    findingCount: z.number(),
    model: z.string(),
    passStats: z.array(z.object({
      pass: z.number(),
      inputItems: z.number(),
      groupsFormed: z.number(),
      mergesPerformed: z.number(),
      ungroupedAfter: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      durationMs: z.number(),
    })),
    finalGroups: z.number(),
    finalUngrouped: z.number(),
    collapseRatio: z.string(),
    conservationOk: z.boolean(),
    conservationErrors: z.array(z.string()),
    oldEngineComparison: z.object({
      oldFamiliesCreated: z.number(),
      oldSuppressed: z.number(),
      oldUngrouped: z.number(),
      oldRuleVersion: z.string(),
      oldFamilyCatalogue: z.array(z.string()),
    }),
    top25Groups: z.array(z.object({
      groupId: z.number(),
      size: z.number(),
      reasons: z.array(z.string()),
      memberTitles: z.array(z.string()),
    })),
    overMergeCandidates: z.array(z.object({
      groupId: z.number(),
      size: z.number(),
      signal: z.string(),
      reasons: z.array(z.string()),
      memberTitles: z.array(z.string()),
    })),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalDurationMs: z.number(),
    error: z.string().nullable(),
  }),

  async run(ctx, { runId: inputRunId, maxPasses: maxPassesInput }) {
    const maxPasses = maxPassesInput ?? 3;
    const model = getModuleModel("omission_audit");
    const startTime = Date.now();

    // Haiku guard
    if (model.toLowerCase().includes("haiku")) {
      throw new Error(`HAIKU_GUARD: model "${model}" is haiku — refusing to run consolidation diagnostic.`);
    }

    // ── Auto-select run (largest completed OA run for SCG deal) ──────────
    let resolvedRunId = inputRunId;
    if (!resolvedRunId) {
      const rows = await ctx.integrations.db.query(
        `SELECT mr.id FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        z.object({ id: z.string() }),
        [SCG_DEAL_ID],
        { label: "Auto-select largest OA run" }
      );
      if (rows.length === 0) throw new Error("No completed OA runs found for SCG deal");
      resolvedRunId = rows[0].id;
    }

    // ── Load findings ───────────────────────────────────────────────────────
    const findingsRows = await ctx.integrations.db.query(
      `SELECT mo.findings FROM module_outputs mo WHERE mo.module_run_id = $1`,
      z.object({ findings: z.any() }),
      [resolvedRunId],
      { label: "Load OA findings" }
    );
    if (findingsRows.length === 0) throw new Error(`No module_outputs found for run ${resolvedRunId}`);

    const rawFindings: any[] = findingsRows[0].findings;
    const findingCount = rawFindings.length;

    // ── Build compact projection ────────────────────────────────────────────
    interface CompactFinding {
      ref: string;
      title: string;
      detail_trimmed: string;
      source_docs: string[];
    }
    const compactFindings: CompactFinding[] = rawFindings.map((f: any, idx: number) => ({
      ref: `f${String(idx).padStart(3, "0")}`,
      title: (f.title || "").slice(0, 200),
      detail_trimmed: (f.detail || f.full_analysis || "").slice(0, 400),
      source_docs: (f.source_docs || []).slice(0, 3),
    }));

    const refToTitle = new Map<string, string>();
    for (const c of compactFindings) refToTitle.set(c.ref, c.title);

    // ── Build finding lines for model ───────────────────────────────────────
    const findingLines = compactFindings.map((c) => {
      const docs = c.source_docs.length > 0 ? ` [Sources: ${c.source_docs.join(", ")}]` : "";
      return `${c.ref}: ${c.title}\n  Detail: ${c.detail_trimmed}${docs}`;
    });

    // ════════════════════════════════════════════════════════════════════════
    // PASS 1: Initial model grouping (all findings)
    // ════════════════════════════════════════════════════════════════════════
    const passStatsList: PassStats[] = [];
    let groups: ConsolidatedGroup[] = [];
    let ungroupedRefs: Set<string> = new Set(compactFindings.map((c) => c.ref));
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const pass1Start = Date.now();
    const inputTextPass1 = findingLines.join("\n\n");
    const pass1Result = await callModel(ctx.integrations.ai, model, inputTextPass1, "DiagConsolidation Pass 1");

    if (pass1Result.error || !pass1Result.response) {
      return {
        runId: resolvedRunId,
        findingCount,
        model,
        passStats: [],
        finalGroups: 0,
        finalUngrouped: findingCount,
        collapseRatio: "N/A (pass 1 failed)",
        conservationOk: false,
        conservationErrors: [pass1Result.error || "Unknown pass 1 failure"],
        oldEngineComparison: { oldFamiliesCreated: 0, oldSuppressed: 0, oldUngrouped: 0, oldRuleVersion: "", oldFamilyCatalogue: [] },
        top25Groups: [],
        overMergeCandidates: [],
        totalInputTokens: pass1Result.inputTokens,
        totalOutputTokens: pass1Result.outputTokens,
        totalDurationMs: Date.now() - startTime,
        error: pass1Result.error,
      };
    }

    totalInputTokens += pass1Result.inputTokens;
    totalOutputTokens += pass1Result.outputTokens;

    // Build initial consolidated groups from pass 1
    const pass1Response = pass1Result.response;
    let nextGroupId = 1;
    for (const g of pass1Response.groups) {
      if (g.member_refs.length >= 2) {
        groups.push({ groupId: nextGroupId++, memberRefs: [...g.member_refs], reasons: [g.reason] });
        for (const ref of g.member_refs) ungroupedRefs.delete(ref);
      }
    }
    // Anything model put in ungrouped_refs stays ungrouped
    // Also add back any refs model may have missed
    const allOriginalRefs = new Set(compactFindings.map((c) => c.ref));
    const accountedPass1 = new Set<string>();
    for (const g of groups) for (const r of g.memberRefs) accountedPass1.add(r);
    for (const r of pass1Response.ungrouped_refs) accountedPass1.add(r);
    // Any not accounted for = missed by model → add to ungrouped
    for (const r of allOriginalRefs) {
      if (!accountedPass1.has(r)) ungroupedRefs.add(r);
    }

    passStatsList.push({
      pass: 1,
      inputItems: findingCount,
      groupsFormed: groups.length,
      mergesPerformed: groups.length, // each group is a "merge" in pass 1
      ungroupedAfter: ungroupedRefs.size,
      inputTokens: pass1Result.inputTokens,
      outputTokens: pass1Result.outputTokens,
      durationMs: Date.now() - pass1Start,
    });

    // ════════════════════════════════════════════════════════════════════════
    // AGGLOMERATIVE PASSES 2..maxPasses
    // ════════════════════════════════════════════════════════════════════════
    for (let passNum = 2; passNum <= maxPasses; passNum++) {
      const passStart = Date.now();

      // Build representatives: for each group, use first member's title + reason
      // Use gNNN prefix for group representatives to avoid collision with fNNN
      const repLines: string[] = [];
      const repRefToGroupId = new Map<string, number>();

      for (const g of groups) {
        const repRef = `g${String(g.groupId).padStart(3, "0")}`;
        const firstMemberTitle = refToTitle.get(g.memberRefs[0]) || "(unknown)";
        const reason = g.reasons[g.reasons.length - 1] || "";
        const repLine = `${repRef}: [GROUP of ${g.memberRefs.length}] ${firstMemberTitle}\n  Reason: ${reason}`;
        repLines.push(repLine);
        repRefToGroupId.set(repRef, g.groupId);
      }

      // Also include ungrouped as individual items
      const ungroupedLines: string[] = [];
      for (const ref of ungroupedRefs) {
        const title = refToTitle.get(ref) || "(unknown)";
        ungroupedLines.push(`${ref}: ${title}`);
      }

      const allPassItems = [...repLines, ...ungroupedLines];
      const inputItemCount = allPassItems.length;

      // Fixed-point check: if only 1 or fewer groupable items, stop
      if (inputItemCount <= 1) break;

      const passInputText = allPassItems.join("\n\n");
      const passResult = await callModel(ctx.integrations.ai, model, passInputText, `DiagConsolidation Pass ${passNum}`);

      totalInputTokens += passResult.inputTokens;
      totalOutputTokens += passResult.outputTokens;

      if (passResult.error || !passResult.response) {
        passStatsList.push({
          pass: passNum,
          inputItems: inputItemCount,
          groupsFormed: 0,
          mergesPerformed: 0,
          ungroupedAfter: ungroupedRefs.size,
          inputTokens: passResult.inputTokens,
          outputTokens: passResult.outputTokens,
          durationMs: Date.now() - passStart,
        });
        break; // Stop on error
      }

      const passResponse = passResult.response;

      // Resolve merges back to original groups
      let mergesThisPass = 0;
      const newGroups: ConsolidatedGroup[] = [];
      const consumedGroupIds = new Set<number>();
      const consumedUngroupedRefs = new Set<string>();

      for (const mg of passResponse.groups) {
        if (mg.member_refs.length < 2) continue;

        // Collect all original finding refs from this merged group
        const mergedOriginalRefs: string[] = [];
        const mergedReasons: string[] = [mg.reason];

        for (const mref of mg.member_refs) {
          if (mref.startsWith("g")) {
            // This is a group representative
            const gid = repRefToGroupId.get(mref);
            if (gid !== undefined) {
              const existing = groups.find((g) => g.groupId === gid);
              if (existing) {
                mergedOriginalRefs.push(...existing.memberRefs);
                mergedReasons.push(...existing.reasons);
                consumedGroupIds.add(gid);
              }
            }
          } else if (mref.startsWith("f")) {
            // This is an ungrouped finding
            mergedOriginalRefs.push(mref);
            consumedUngroupedRefs.add(mref);
          }
        }

        if (mergedOriginalRefs.length >= 2) {
          newGroups.push({ groupId: nextGroupId++, memberRefs: mergedOriginalRefs, reasons: mergedReasons });
          mergesThisPass++;
        }
      }

      // Keep unconsumed groups
      for (const g of groups) {
        if (!consumedGroupIds.has(g.groupId)) {
          newGroups.push(g);
        }
      }

      // Update ungrouped
      for (const ref of consumedUngroupedRefs) ungroupedRefs.delete(ref);

      groups = newGroups;

      passStatsList.push({
        pass: passNum,
        inputItems: inputItemCount,
        groupsFormed: newGroups.length,
        mergesPerformed: mergesThisPass,
        ungroupedAfter: ungroupedRefs.size,
        inputTokens: passResult.inputTokens,
        outputTokens: passResult.outputTokens,
        durationMs: Date.now() - passStart,
      });

      // Fixed-point: no merges → stop
      if (mergesThisPass === 0) break;
    }

    // ════════════════════════════════════════════════════════════════════════
    // CONSERVATION CHECK
    // ════════════════════════════════════════════════════════════════════════
    const refCounts = new Map<string, number>();
    for (const g of groups) {
      for (const r of g.memberRefs) refCounts.set(r, (refCounts.get(r) || 0) + 1);
    }
    for (const r of ungroupedRefs) refCounts.set(r, (refCounts.get(r) || 0) + 1);

    const conservationErrors: string[] = [];
    for (const ref of allOriginalRefs) {
      const count = refCounts.get(ref) || 0;
      if (count === 0) conservationErrors.push(`MISSING: ${ref}`);
      if (count > 1) conservationErrors.push(`DUPLICATED: ${ref} (×${count})`);
    }
    for (const ref of refCounts.keys()) {
      if (!allOriginalRefs.has(ref)) conservationErrors.push(`INVENTED: ${ref}`);
    }
    const conservationOk = conservationErrors.length === 0;

    // ════════════════════════════════════════════════════════════════════════
    // COLLAPSE RATIO
    // ════════════════════════════════════════════════════════════════════════
    const finalGroupCount = groups.length;
    const finalUngrouped = ungroupedRefs.size;
    const effectiveFindingCount = finalGroupCount + finalUngrouped;
    const collapseRatio = `${findingCount} → ${effectiveFindingCount} (${((1 - effectiveFindingCount / findingCount) * 100).toFixed(1)}% reduction)`;

    // ════════════════════════════════════════════════════════════════════════
    // OLD ENGINE COMPARISON (SCG-hardcoded deduplicateFindings)
    // ════════════════════════════════════════════════════════════════════════
    let oldEngineComparison = {
      oldFamiliesCreated: 0,
      oldSuppressed: 0,
      oldUngrouped: 0,
      oldRuleVersion: "",
      oldFamilyCatalogue: [] as string[],
    };
    try {
      const asCanonical: CanonicalFinding[] = rawFindings.map((f: any, idx: number) => ({
        finding_id: f.finding_id || `synth_${idx}`,
        severity: f.severity || "info",
        title: f.title || "",
        detail: f.detail || "",
        full_analysis: f.full_analysis || "",
        source_docs: f.source_docs || [],
        issue_key: f.issue_key || undefined,
        category: f.category || undefined,
        finding_kind: f.finding_kind || undefined,
        claim_ids: f.claim_ids || undefined,
        merged_from_finding_ids: f.merged_from_finding_ids || undefined,
      }));
      const oldResult = deduplicateFindings(asCanonical);
      oldEngineComparison = {
        oldFamiliesCreated: oldResult.totalFamiliesCreated,
        oldSuppressed: oldResult.totalSuppressed,
        oldUngrouped: oldResult.ungroupedFindingIds.length,
        oldRuleVersion: oldResult.ruleVersion,
        oldFamilyCatalogue: oldResult.familyCatalogue,
      };
    } catch (e: any) {
      oldEngineComparison.oldRuleVersion = `ERROR: ${e.message || String(e)}`;
    }

    // ════════════════════════════════════════════════════════════════════════
    // TOP 25 LARGEST GROUPS
    // ════════════════════════════════════════════════════════════════════════
    const sortedBySize = [...groups].sort((a, b) => b.memberRefs.length - a.memberRefs.length);
    const top25 = sortedBySize.slice(0, 25).map((g) => ({
      groupId: g.groupId,
      size: g.memberRefs.length,
      reasons: g.reasons,
      memberTitles: g.memberRefs.map((r) => `${r}: ${refToTitle.get(r) || "(unknown)"}`),
    }));

    // ════════════════════════════════════════════════════════════════════════
    // OVER-MERGE CANDIDATES (up to 20)
    // ════════════════════════════════════════════════════════════════════════
    const overMergeCandidates: Array<{
      groupId: number;
      size: number;
      signal: string;
      reasons: string[];
      memberTitles: string[];
    }> = [];

    for (const g of sortedBySize) {
      if (overMergeCandidates.length >= 20) break;
      const { flagged, signal } = detectOverMerge(g, refToTitle);
      if (flagged) {
        overMergeCandidates.push({
          groupId: g.groupId,
          size: g.memberRefs.length,
          signal,
          reasons: g.reasons,
          memberTitles: g.memberRefs.map((r) => `${r}: ${refToTitle.get(r) || "(unknown)"}`),
        });
      }
    }

    return {
      runId: resolvedRunId,
      findingCount,
      model,
      passStats: passStatsList,
      finalGroups: finalGroupCount,
      finalUngrouped,
      collapseRatio,
      conservationOk,
      conservationErrors: conservationErrors.slice(0, 50),
      oldEngineComparison,
      top25Groups: top25,
      overMergeCandidates,
      totalInputTokens,
      totalOutputTokens,
      totalDurationMs: Date.now() - startTime,
      error: null,
    };
  },
});
