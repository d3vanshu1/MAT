/**
 * Diagnostic API — Deal-Agnostic Consolidation Engine (MG-1b)
 *
 * Single-pass-per-invocation agglomerative grouping on real OA findings.
 * Each invocation runs ONE model pass and persists results to a scratch table.
 * Subsequent invocations resume from persisted state.
 *
 * NO dimension gate. NO production path changes. Measurement-only.
 *
 * Persistence: `diag_consolidation_sessions` table (CREATE IF NOT EXISTS).
 * No migration needed — table auto-created on first use.
 *
 * Invocation pattern:
 *   Pass 1: { runId: null, passNumber: 1, sessionId: null }
 *           → creates session, runs model grouping on all findings, persists
 *   Pass N: { runId: null, passNumber: N, sessionId: "<from pass 1>" }
 *           → loads pass N-1, builds reps, runs model, persists
 *   Convergence: when mergesPerformed = 0 or passNumber = 5,
 *           computes final stats + old-engine comparison + over-merge candidates.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import type { CanonicalFinding } from "./canonical-finding.js";
import { getModuleModel } from "./model-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

const MAX_INPUT_CHARS = 550_000;
const MAX_PASSES = 5;

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

/** Persisted state per pass */
interface PersistedPassState {
  groups: ConsolidatedGroup[];
  ungroupedRefs: string[];
  nextGroupId: number;
  passStats: PassStats;
  refToTitle: Record<string, string>;
  findingCount: number;
  runId: string;
  converged: boolean;
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

  const memberNouns: Array<{ ref: string; nouns: Set<string> }> = [];
  for (const ref of group.memberRefs) {
    const title = refToTitle.get(ref) || "";
    memberNouns.push({ ref, nouns: extractDistinctiveNouns(title) });
  }

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
    return { flagged: true, signal: `Zero noun overlap: ${zeroOverlapPairs.join(", ")}` };
  }
  return { flagged: false, signal: "" };
}

// ─── Model response parser ──────────────────────────────────────────────────
function parseModelResponse(text: string): ModelResponse | null {
  try {
    let cleaned = text.trim();
    // Strip markdown code fences
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    // Try to extract JSON object if wrapped in text
    if (!cleaned.startsWith("{")) {
      const jsonStart = cleaned.indexOf("{");
      const jsonEnd = cleaned.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
      }
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
  const targetBatchChars = Math.floor(MAX_INPUT_CHARS * 0.8);

  if (inputText.length <= MAX_INPUT_CHARS) {
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

  // Batch mode
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
  description: "Single-pass-per-invocation agglomerative grouping diagnostic with persistence.",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    runId: z.string().nullable(),
    passNumber: z.number().nullable(),
    sessionId: z.string().nullable(),
    dumpMode: z.boolean().nullable(),
    dumpPart: z.string().nullable(), // "meta", "groups:0-19", "groups:20-51", "ungrouped", "overmerge"
  }),
  output: z.object({
    sessionId: z.string(),
    passNumber: z.number(),
    runId: z.string(),
    findingCount: z.number(),
    model: z.string(),
    thisPassStats: z.object({
      pass: z.number(),
      inputItems: z.number(),
      groupsFormed: z.number(),
      mergesPerformed: z.number(),
      ungroupedAfter: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      durationMs: z.number(),
    }),
    converged: z.boolean(),
    // Trajectory: passN → effective count at that pass
    trajectory: z.array(z.object({
      pass: z.number(),
      effectiveCount: z.number(),
      merges: z.number(),
      durationMs: z.number(),
    })),
    // Final analysis (only populated when converged)
    finalAnalysis: z.object({
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
    }).nullable(),
    durationMs: z.number(),
    error: z.string().nullable(),
    dumpJson: z.string().nullable(),
  }),

  async run(ctx, { runId: inputRunId, passNumber: passNumberInput, sessionId: sessionIdInput, dumpMode, dumpPart }) {
    const passNumber = passNumberInput ?? 1;
    const model = getModuleModel("omission_audit");
    const startTime = Date.now();

    // ═══════ DUMP MODE: read converged state and return full JSON ═══════
    if (dumpMode && sessionIdInput) {
      const dumpRows = await ctx.integrations.db.query(
        `SELECT pass_number, state_json FROM diag_consolidation_sessions
         WHERE id = $1 ORDER BY pass_number DESC LIMIT 1`,
        z.object({ pass_number: z.number(), state_json: z.any() }),
        [sessionIdInput],
        { label: "Load converged state for dump" }
      );
      if (dumpRows.length === 0) throw new Error(`No state found for session ${sessionIdInput}`);
      const finalState: PersistedPassState = dumpRows[0].state_json as PersistedPassState;
      const refToTitle = new Map(Object.entries(finalState.refToTitle));

      const makeDumpReturn = (json: string) => ({
        sessionId: sessionIdInput, passNumber: dumpRows[0].pass_number,
        runId: finalState.runId, findingCount: finalState.findingCount, model,
        thisPassStats: { pass: 0, inputItems: 0, groupsFormed: 0, mergesPerformed: 0, ungroupedAfter: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
        converged: true,
        trajectory: [{ pass: 0, effectiveCount: finalState.findingCount, merges: 0, durationMs: 0 }],
        finalAnalysis: null,
        durationMs: Date.now() - startTime,
        error: null,
        dumpJson: json,
      });

      const part = dumpPart || "meta";

      // ─── PART: meta ───
      if (part === "meta") {
        const allPassRows = await ctx.integrations.db.query(
          `SELECT pass_number, state_json FROM diag_consolidation_sessions
           WHERE id = $1 ORDER BY pass_number ASC`,
          z.object({ pass_number: z.number(), state_json: z.any() }),
          [sessionIdInput],
          { label: "Load all passes for trajectory" }
        );
        const trajectory = [finalState.findingCount, ...allPassRows.map((r: any) => {
          const s: PersistedPassState = r.state_json;
          return s.groups.length + s.ungroupedRefs.length;
        })];
        const totalFindingsInGroups = finalState.groups.reduce((acc, g) => acc + g.memberRefs.length, 0);

        // Old engine comparison
        let oldEngineComparison = { grouped: 0, ungrouped: 0, families: 0, family_names: [] as string[] };
        try {
          const findingsRows = await ctx.integrations.db.query(
            `SELECT mo.findings FROM module_outputs mo WHERE mo.module_run_id = $1`,
            z.object({ findings: z.any() }),
            [finalState.runId],
            { label: "Load findings for old-engine dump" }
          );
          if (findingsRows.length > 0) {
            const rawFindings: any[] = findingsRows[0].findings;
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
              grouped: oldResult.totalSuppressed + oldResult.totalFamiliesCreated,
              ungrouped: oldResult.ungroupedFindingIds.length,
              families: oldResult.totalFamiliesCreated,
              family_names: oldResult.familyCatalogue,
            };
          }
        } catch { /* skip */ }

        const meta = {
          sessionId: sessionIdInput,
          run_id: finalState.runId,
          converged_collapse: `${finalState.findingCount} -> ${finalState.groups.length + finalState.ungroupedRefs.length}`,
          trajectory,
          total_groups: finalState.groups.length,
          total_findings_in_groups: totalFindingsInGroups,
          total_ungrouped: finalState.ungroupedRefs.length,
          old_engine_comparison: oldEngineComparison,
        };
        return makeDumpReturn(JSON.stringify(meta, null, 2));
      }

      // ─── PART: groups:START-END ───
      if (part.startsWith("groups:")) {
        const [startStr, endStr] = part.slice(7).split("-");
        const startIdx = parseInt(startStr, 10);
        const endIdx = parseInt(endStr, 10);
        const sortedGroups = [...finalState.groups].sort((a, b) => b.memberRefs.length - a.memberRefs.length);
        const slice = sortedGroups.slice(startIdx, endIdx + 1);
        const dumpGroups = slice.map((g) => ({
          group_id: g.groupId,
          member_count: g.memberRefs.length,
          members: g.memberRefs.map((r) => ({ finding_id: r, title: refToTitle.get(r) || "(unknown)" })),
          reasons: g.reasons,
        }));
        return makeDumpReturn(JSON.stringify(dumpGroups, null, 2));
      }

      // ─── PART: ungrouped or ungrouped:START-END ───
      if (part === "ungrouped" || part.startsWith("ungrouped:")) {
        const allUngrouped = finalState.ungroupedRefs.map((r) => ({
          finding_id: r, title: refToTitle.get(r) || "(unknown)",
        }));
        if (part === "ungrouped") {
          return makeDumpReturn(JSON.stringify(allUngrouped, null, 2));
        }
        const [startStr, endStr] = part.slice(10).split("-");
        const startIdx = parseInt(startStr, 10);
        const endIdx = parseInt(endStr, 10);
        return makeDumpReturn(JSON.stringify(allUngrouped.slice(startIdx, endIdx + 1), null, 2));
      }

      // ─── PART: overmerge ───
      if (part === "overmerge") {
        const sortedGroups = [...finalState.groups].sort((a, b) => b.memberRefs.length - a.memberRefs.length);
        const overMergeCandidates: any[] = [];
        for (const g of sortedGroups) {
          const { flagged, signal } = detectOverMerge(g, refToTitle);
          if (flagged) {
            overMergeCandidates.push({
              group_id: g.groupId, member_count: g.memberRefs.length, signal,
              members: g.memberRefs.map((r) => ({ finding_id: r, title: refToTitle.get(r) || "(unknown)" })),
              reasons: g.reasons,
            });
          }
        }
        return makeDumpReturn(JSON.stringify(overMergeCandidates, null, 2));
      }

      throw new Error(`Unknown dumpPart: ${part}. Valid: meta, groups:START-END, ungrouped, overmerge`);
    }
    // ═══════ END DUMP MODE ═══════

    // Haiku guard
    if (model.toLowerCase().includes("haiku")) {
      throw new Error(`HAIKU_GUARD: model "${model}" is haiku — refusing to run consolidation diagnostic.`);
    }

    // ── Ensure scratch table exists ─────────────────────────────────────────
    await ctx.integrations.db.execute(
      `CREATE TABLE IF NOT EXISTS diag_consolidation_sessions (
        id            TEXT NOT NULL,
        pass_number   INT NOT NULL,
        state_json    JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, pass_number)
      )`,
      undefined,
      { label: "Ensure diag_consolidation_sessions table" }
    );

    // ── Generate or validate session ID ─────────────────────────────────────
    const sessionId = sessionIdInput || crypto.randomUUID();

    // ════════════════════════════════════════════════════════════════════════
    // PASS 1: Initial model grouping on raw findings
    // ════════════════════════════════════════════════════════════════════════
    if (passNumber === 1) {
      // Auto-select run
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

      // Load findings
      const findingsRows = await ctx.integrations.db.query(
        `SELECT mo.findings FROM module_outputs mo WHERE mo.module_run_id = $1`,
        z.object({ findings: z.any() }),
        [resolvedRunId],
        { label: "Load OA findings" }
      );
      if (findingsRows.length === 0) throw new Error(`No module_outputs found for run ${resolvedRunId}`);

      const rawFindings: any[] = findingsRows[0].findings;
      const findingCount = rawFindings.length;

      // Build compact projection
      const compactFindings = rawFindings.map((f: any, idx: number) => ({
        ref: `f${String(idx).padStart(3, "0")}`,
        title: (f.title || "").slice(0, 200),
        detail_trimmed: (f.detail || f.full_analysis || "").slice(0, 400),
        source_docs: (f.source_docs || []).slice(0, 3),
      }));

      const refToTitleObj: Record<string, string> = {};
      for (const c of compactFindings) refToTitleObj[c.ref] = c.title;

      // Build finding lines
      const findingLines = compactFindings.map((c) => {
        const docs = c.source_docs.length > 0 ? ` [Sources: ${c.source_docs.join(", ")}]` : "";
        return `${c.ref}: ${c.title}\n  Detail: ${c.detail_trimmed}${docs}`;
      });

      const inputTextPass1 = findingLines.join("\n\n");

      // Run model
      const passStart = Date.now();
      const pass1Result = await callModel(ctx.integrations.ai, model, inputTextPass1, "DiagConsolidation Pass 1");

      if (pass1Result.error || !pass1Result.response) {
        const errorStats: PassStats = {
          pass: 1, inputItems: findingCount, groupsFormed: 0, mergesPerformed: 0,
          ungroupedAfter: findingCount, inputTokens: pass1Result.inputTokens,
          outputTokens: pass1Result.outputTokens, durationMs: Date.now() - passStart,
        };
        return {
          sessionId, passNumber: 1, runId: resolvedRunId, findingCount, model,
          thisPassStats: errorStats, converged: false,
          trajectory: [{ pass: 1, effectiveCount: findingCount, merges: 0, durationMs: errorStats.durationMs }],
          finalAnalysis: null, durationMs: Date.now() - startTime,
          error: pass1Result.error || "Unknown pass 1 failure",
          dumpJson: null,
        };
      }

      // Build groups from pass 1
      const allOriginalRefs = new Set(compactFindings.map((c) => c.ref));
      let ungroupedRefs = new Set(allOriginalRefs);
      const groups: ConsolidatedGroup[] = [];
      let nextGroupId = 1;

      for (const g of pass1Result.response.groups) {
        if (g.member_refs.length >= 2) {
          groups.push({ groupId: nextGroupId++, memberRefs: [...g.member_refs], reasons: [g.reason] });
          for (const ref of g.member_refs) ungroupedRefs.delete(ref);
        }
      }
      // Account for model's ungrouped + any missed refs
      const accountedPass1 = new Set<string>();
      for (const g of groups) for (const r of g.memberRefs) accountedPass1.add(r);
      for (const r of pass1Result.response.ungrouped_refs) accountedPass1.add(r);
      for (const r of allOriginalRefs) {
        if (!accountedPass1.has(r)) ungroupedRefs.add(r);
      }

      const passStats: PassStats = {
        pass: 1,
        inputItems: findingCount,
        groupsFormed: groups.length,
        mergesPerformed: groups.length,
        ungroupedAfter: ungroupedRefs.size,
        inputTokens: pass1Result.inputTokens,
        outputTokens: pass1Result.outputTokens,
        durationMs: Date.now() - passStart,
      };

      // Persist
      const state: PersistedPassState = {
        groups,
        ungroupedRefs: [...ungroupedRefs],
        nextGroupId,
        passStats,
        refToTitle: refToTitleObj,
        findingCount,
        runId: resolvedRunId,
        converged: false,
      };
      await ctx.integrations.db.execute(
        `INSERT INTO diag_consolidation_sessions (id, pass_number, state_json)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id, pass_number) DO UPDATE SET state_json = EXCLUDED.state_json, created_at = NOW()`,
        [sessionId, 1, JSON.stringify(state)],
        { label: "Persist pass 1 state" }
      );

      const effectiveCount = groups.length + ungroupedRefs.size;
      return {
        sessionId,
        passNumber: 1,
        runId: resolvedRunId,
        findingCount,
        model,
        thisPassStats: passStats,
        converged: false,
        trajectory: [{ pass: 1, effectiveCount, merges: groups.length, durationMs: passStats.durationMs }],
        finalAnalysis: null,
        durationMs: Date.now() - startTime,
        error: null,
        dumpJson: null,
      };
    }

    // ════════════════════════════════════════════════════════════════════════
    // PASS N > 1: Load previous pass, run agglomerative, persist
    // ════════════════════════════════════════════════════════════════════════
    if (!sessionIdInput) {
      throw new Error("sessionId is required for passNumber > 1");
    }

    // Load previous pass state
    const prevRows = await ctx.integrations.db.query(
      `SELECT state_json FROM diag_consolidation_sessions WHERE id = $1 AND pass_number = $2 LIMIT 1`,
      z.object({ state_json: z.any() }),
      [sessionId, passNumber - 1],
      { label: `Load pass ${passNumber - 1} state` }
    );
    if (prevRows.length === 0) {
      throw new Error(`No persisted state found for session ${sessionId}, pass ${passNumber - 1}. Run pass ${passNumber - 1} first.`);
    }

    const prevState: PersistedPassState = prevRows[0].state_json as PersistedPassState;
    if (prevState.converged) {
      throw new Error(`Session ${sessionId} already converged at pass ${passNumber - 1}. No further passes needed.`);
    }

    let groups = prevState.groups;
    let ungroupedRefs = new Set(prevState.ungroupedRefs);
    let nextGroupId = prevState.nextGroupId;
    const refToTitleObj = prevState.refToTitle;
    const refToTitle = new Map(Object.entries(refToTitleObj));
    const findingCount = prevState.findingCount;
    const resolvedRunId = prevState.runId;

    // Build representatives
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

    // Ungrouped as individual items
    const ungroupedLines: string[] = [];
    for (const ref of ungroupedRefs) {
      const title = refToTitle.get(ref) || "(unknown)";
      ungroupedLines.push(`${ref}: ${title}`);
    }

    const allPassItems = [...repLines, ...ungroupedLines];
    const inputItemCount = allPassItems.length;

    // Fixed-point early exit: if ≤1 items, converge immediately
    if (inputItemCount <= 1) {
      const trivialStats: PassStats = {
        pass: passNumber, inputItems: inputItemCount, groupsFormed: groups.length,
        mergesPerformed: 0, ungroupedAfter: ungroupedRefs.size,
        inputTokens: 0, outputTokens: 0, durationMs: 0,
      };
      const finalState: PersistedPassState = {
        groups, ungroupedRefs: [...ungroupedRefs], nextGroupId,
        passStats: trivialStats, refToTitle: refToTitleObj,
        findingCount, runId: resolvedRunId, converged: true,
      };
      await ctx.integrations.db.execute(
        `INSERT INTO diag_consolidation_sessions (id, pass_number, state_json)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id, pass_number) DO UPDATE SET state_json = EXCLUDED.state_json, created_at = NOW()`,
        [sessionId, passNumber, JSON.stringify(finalState)],
        { label: `Persist pass ${passNumber} (trivial convergence)` }
      );
      const finalAnalysis = await computeFinalAnalysis(ctx, groups, ungroupedRefs, refToTitle, findingCount, resolvedRunId, sessionId, passNumber);
      return {
        sessionId, passNumber, runId: resolvedRunId, findingCount, model,
        thisPassStats: trivialStats, converged: true,
        trajectory: await buildTrajectory(ctx, sessionId, passNumber),
        finalAnalysis, durationMs: Date.now() - startTime, error: null,
        dumpJson: null,
      };
    }

    // Run model call
    const passStart = Date.now();
    const passInputText = allPassItems.join("\n\n");
    const passResult = await callModel(ctx.integrations.ai, model, passInputText, `DiagConsolidation Pass ${passNumber}`);

    if (passResult.error || !passResult.response) {
      // Treat parse failure on pass N>1 as convergence (model couldn't produce
      // valid new merges → fixed point). Persist current state as converged.
      const errorStats: PassStats = {
        pass: passNumber, inputItems: inputItemCount, groupsFormed: groups.length,
        mergesPerformed: 0, ungroupedAfter: ungroupedRefs.size,
        inputTokens: passResult.inputTokens, outputTokens: passResult.outputTokens,
        durationMs: Date.now() - passStart,
      };
      const convergedState: PersistedPassState = {
        groups, ungroupedRefs: [...ungroupedRefs], nextGroupId,
        passStats: errorStats, refToTitle: refToTitleObj,
        findingCount, runId: resolvedRunId, converged: true,
      };
      await ctx.integrations.db.execute(
        `INSERT INTO diag_consolidation_sessions (id, pass_number, state_json)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id, pass_number) DO UPDATE SET state_json = EXCLUDED.state_json, created_at = NOW()`,
        [sessionId, passNumber, JSON.stringify(convergedState)],
        { label: `Persist pass ${passNumber} (parse-failure convergence)` }
      );
      const finalAnalysis = await computeFinalAnalysis(ctx, groups, ungroupedRefs, refToTitle, findingCount, resolvedRunId, sessionId, passNumber);
      const trajectory = await buildTrajectory(ctx, sessionId, passNumber);
      return {
        sessionId, passNumber, runId: resolvedRunId, findingCount, model,
        thisPassStats: errorStats, converged: true,
        trajectory,
        finalAnalysis, durationMs: Date.now() - startTime,
        error: `Converged via parse failure: ${passResult.error || "unknown"}`,
        dumpJson: null,
      };
    }

    const passResponse = passResult.response;

    // Resolve merges back to original groups
    let mergesThisPass = 0;
    const newGroups: ConsolidatedGroup[] = [];
    const consumedGroupIds = new Set<number>();
    const consumedUngroupedRefs = new Set<string>();

    for (const mg of passResponse.groups) {
      if (mg.member_refs.length < 2) continue;

      const mergedOriginalRefs: string[] = [];
      const mergedReasons: string[] = [mg.reason];

      for (const mref of mg.member_refs) {
        if (mref.startsWith("g")) {
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

    const passStats: PassStats = {
      pass: passNumber,
      inputItems: inputItemCount,
      groupsFormed: newGroups.length,
      mergesPerformed: mergesThisPass,
      ungroupedAfter: ungroupedRefs.size,
      inputTokens: passResult.inputTokens,
      outputTokens: passResult.outputTokens,
      durationMs: Date.now() - passStart,
    };

    const isConverged = mergesThisPass === 0 || passNumber >= MAX_PASSES;

    // Persist
    const state: PersistedPassState = {
      groups,
      ungroupedRefs: [...ungroupedRefs],
      nextGroupId,
      passStats,
      refToTitle: refToTitleObj,
      findingCount,
      runId: resolvedRunId,
      converged: isConverged,
    };
    await ctx.integrations.db.execute(
      `INSERT INTO diag_consolidation_sessions (id, pass_number, state_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id, pass_number) DO UPDATE SET state_json = EXCLUDED.state_json, created_at = NOW()`,
      [sessionId, passNumber, JSON.stringify(state)],
      { label: `Persist pass ${passNumber} state` }
    );

    // Build trajectory
    const trajectory = await buildTrajectory(ctx, sessionId, passNumber);

    // If converged, compute final analysis
    let finalAnalysis = null;
    if (isConverged) {
      finalAnalysis = await computeFinalAnalysis(ctx, groups, ungroupedRefs, refToTitle, findingCount, resolvedRunId, sessionId, passNumber);
    }

    return {
      sessionId,
      passNumber,
      runId: resolvedRunId,
      findingCount,
      model,
      thisPassStats: passStats,
      converged: isConverged,
      trajectory,
      finalAnalysis,
      durationMs: Date.now() - startTime,
      error: null,
      dumpJson: null,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: Build trajectory from all persisted passes
// ═══════════════════════════════════════════════════════════════════════════════
async function buildTrajectory(
  ctx: any,
  sessionId: string,
  upThroughPass: number
): Promise<Array<{ pass: number; effectiveCount: number; merges: number; durationMs: number }>> {
  const rows = await ctx.integrations.db.query(
    `SELECT pass_number, state_json FROM diag_consolidation_sessions
     WHERE id = $1 AND pass_number <= $2
     ORDER BY pass_number ASC`,
    z.object({ pass_number: z.number(), state_json: z.any() }),
    [sessionId, upThroughPass],
    { label: "Load trajectory passes" }
  );

  return rows.map((r: any) => {
    const s: PersistedPassState = r.state_json;
    const effectiveCount = s.groups.length + s.ungroupedRefs.length;
    return {
      pass: r.pass_number,
      effectiveCount,
      merges: s.passStats.mergesPerformed,
      durationMs: s.passStats.durationMs,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: Compute final analysis on convergence
// ═══════════════════════════════════════════════════════════════════════════════
async function computeFinalAnalysis(
  ctx: any,
  groups: ConsolidatedGroup[],
  ungroupedRefs: Set<string>,
  refToTitle: Map<string, string>,
  findingCount: number,
  resolvedRunId: string,
  sessionId: string,
  passNumber: number
) {
  // Conservation check
  const allOriginalRefs = new Set<string>();
  for (let i = 0; i < findingCount; i++) {
    allOriginalRefs.add(`f${String(i).padStart(3, "0")}`);
  }

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

  // Collapse ratio
  const finalGroupCount = groups.length;
  const finalUngrouped = ungroupedRefs.size;
  const effectiveFindingCount = finalGroupCount + finalUngrouped;
  const collapseRatio = `${findingCount} → ${effectiveFindingCount} (${((1 - effectiveFindingCount / findingCount) * 100).toFixed(1)}% reduction)`;

  // Old engine comparison
  let oldEngineComparison = {
    oldFamiliesCreated: 0, oldSuppressed: 0, oldUngrouped: 0,
    oldRuleVersion: "", oldFamilyCatalogue: [] as string[],
  };
  try {
    const findingsRows = await ctx.integrations.db.query(
      `SELECT mo.findings FROM module_outputs mo WHERE mo.module_run_id = $1`,
      z.object({ findings: z.any() }),
      [resolvedRunId],
      { label: "Load findings for old-engine comparison" }
    );
    if (findingsRows.length > 0) {
      const rawFindings: any[] = findingsRows[0].findings;
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
    }
  } catch (e: any) {
    oldEngineComparison.oldRuleVersion = `ERROR: ${e.message || String(e)}`;
  }

  // Top 25 largest groups
  const sortedBySize = [...groups].sort((a, b) => b.memberRefs.length - a.memberRefs.length);
  const top25 = sortedBySize.slice(0, 25).map((g) => ({
    groupId: g.groupId,
    size: g.memberRefs.length,
    reasons: g.reasons,
    memberTitles: g.memberRefs.map((r) => `${r}: ${refToTitle.get(r) || "(unknown)"}`),
  }));

  // Over-merge candidates
  const overMergeCandidates: Array<{
    groupId: number; size: number; signal: string; reasons: string[]; memberTitles: string[];
  }> = [];
  for (const g of sortedBySize) {
    if (overMergeCandidates.length >= 20) break;
    const { flagged, signal } = detectOverMerge(g, refToTitle);
    if (flagged) {
      overMergeCandidates.push({
        groupId: g.groupId, size: g.memberRefs.length, signal,
        reasons: g.reasons,
        memberTitles: g.memberRefs.map((r) => `${r}: ${refToTitle.get(r) || "(unknown)"}`),
      });
    }
  }

  // Sum tokens from all passes
  const allPassRows = await ctx.integrations.db.query(
    `SELECT state_json FROM diag_consolidation_sessions WHERE id = $1 ORDER BY pass_number ASC`,
    z.object({ state_json: z.any() }),
    [sessionId],
    { label: "Load all passes for token sum" }
  );
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const r of allPassRows) {
    const s: PersistedPassState = r.state_json;
    totalInputTokens += s.passStats.inputTokens;
    totalOutputTokens += s.passStats.outputTokens;
  }

  return {
    collapseRatio,
    conservationOk: conservationErrors.length === 0,
    conservationErrors: conservationErrors.slice(0, 50),
    oldEngineComparison,
    top25Groups: top25,
    overMergeCandidates,
    totalInputTokens,
    totalOutputTokens,
  };
}
