/**
 * model-consolidation-adapter.ts — MG-3
 *
 * Wraps the validated single-pass model-grouping engine into a conformant
 * FamilyDedupResult, enabling drop-in replacement for deduplicateFindings
 * in pipeline-core.ts behind a config flag.
 *
 * Contract: modelConsolidate(findings, aiFn) → FamilyDedupResult
 * Preserves the EXACT FamilyDedupResult shape (10 consumers depend on it).
 *
 * Model: Sonnet (claude-sonnet-4-6) — NOT Haiku.
 * Bounded time: if grouping fails or times out, this function THROWS (fail-loud).
 */

import type { FamilyDedupResult, FamilyRecord, KnownFamilyId, OccurrenceRecord } from "./canonical-family-dedup.js";
import type { CanonicalFinding } from "./canonical-finding.js";
import { fnv1a, canonicalJsonSerialize } from "./oa-ancestry-service.js";
import { SONNET_MODEL } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INPUT_CHARS = 550_000;
const RULE_VERSION = "model-grouping-v1";

// ---------------------------------------------------------------------------
// Anthropic response schema (reused from diag-consolidation-engine)
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

// ---------------------------------------------------------------------------
// Model response types
// ---------------------------------------------------------------------------

interface ModelGroup {
  group_id: number;
  member_refs: string[];
  reason: string;
}

interface ModelResponse {
  groups: ModelGroup[];
  ungrouped_refs: string[];
}

// ---------------------------------------------------------------------------
// System prompt (identical to validated diag-consolidation-engine)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Model response parser (identical to validated engine)
// ---------------------------------------------------------------------------

function parseModelResponse(text: string): ModelResponse | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
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

// ---------------------------------------------------------------------------
// AI function type (matches PostMergePipelineInput.aiFn)
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

// ---------------------------------------------------------------------------
// Model call — single-pass (validated: single pass is sufficient, agglom buys ~2)
// ---------------------------------------------------------------------------

async function callGroupingModel(
  aiFn: AiFn,
  inputText: string,
): Promise<ModelResponse> {
  const targetBatchChars = Math.floor(MAX_INPUT_CHARS * 0.8);

  if (inputText.length <= MAX_INPUT_CHARS) {
    // Single call
    const result = await aiFn(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SONNET_MODEL,
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: inputText }],
        },
      },
      { response: MessageResponseSchema },
      { label: "model-consolidation: single-pass grouping" }
    );
    const textBlock = result.content.find((c: any) => c.type === "text");
    if (!textBlock) throw new Error("[model-consolidation] Model returned no text content");
    const parsed = parseModelResponse(textBlock.text);
    if (!parsed) throw new Error("[model-consolidation] Failed to parse model response as valid grouping JSON");
    return parsed;
  }

  // Batch mode — split into chunks
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

  for (let i = 0; i < batches.length; i++) {
    const batchInput = batches[i].join("\n\n");
    const result = await aiFn(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: SONNET_MODEL,
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: batchInput }],
        },
      },
      { response: MessageResponseSchema },
      { label: `model-consolidation: batch ${i + 1}/${batches.length}` }
    );
    const textBlock = result.content.find((c: any) => c.type === "text");
    if (!textBlock) throw new Error(`[model-consolidation] Batch ${i + 1}: no text content`);
    const parsed = parseModelResponse(textBlock.text);
    if (!parsed) throw new Error(`[model-consolidation] Batch ${i + 1}: failed to parse response`);
    const offset = allGroups.length;
    for (const g of parsed.groups) allGroups.push({ ...g, group_id: g.group_id + offset });
    allUngrouped.push(...parsed.ungrouped_refs);
  }

  return { groups: allGroups, ungrouped_refs: allUngrouped };
}

// ---------------------------------------------------------------------------
// Build ref → finding_id map
// ---------------------------------------------------------------------------

function buildRefMap(findings: CanonicalFinding[]): { inputText: string; refToId: Map<string, string> } {
  const refToId = new Map<string, string>();
  const lines: string[] = [];

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const ref = `f${String(i).padStart(3, "0")}`;
    refToId.set(ref, f.finding_id);
    const title = f.title || "(untitled)";
    const detail = f.detail ? ` — ${f.detail.slice(0, 200)}` : "";
    lines.push(`${ref}: ${title}${detail}`);
  }

  return { inputText: lines.join("\n\n"), refToId };
}

// ---------------------------------------------------------------------------
// Map model groups → FamilyDedupResult
// ---------------------------------------------------------------------------

function mapToFamilyDedupResult(
  modelResponse: ModelResponse,
  refToId: Map<string, string>,
  totalInput: number,
): FamilyDedupResult {
  const families: FamilyRecord[] = [];
  const ungroupedFindingIds: string[] = [];

  // Track all accounted finding IDs for conservation check
  const accountedIds = new Set<string>();

  // Process groups → FamilyRecord
  for (let gIdx = 0; gIdx < modelResponse.groups.length; gIdx++) {
    const group = modelResponse.groups[gIdx];
    const memberFindingIds: string[] = [];

    for (const ref of group.member_refs) {
      const fid = refToId.get(ref);
      if (fid && !accountedIds.has(fid)) {
        memberFindingIds.push(fid);
        accountedIds.add(fid);
      }
    }

    if (memberFindingIds.length < 2) {
      // Degenerate group — treat remaining as ungrouped
      for (const fid of memberFindingIds) {
        ungroupedFindingIds.push(fid);
      }
      continue;
    }

    // Deterministic representative: lexicographically smallest finding_id
    memberFindingIds.sort();
    const representativeFindingId = memberFindingIds[0];
    const suppressedFindingIds = memberFindingIds.slice(1);

    // Build member dispositions
    const memberDispositions: OccurrenceRecord[] = memberFindingIds.map(fid => ({
      occurrenceId: fid,
      findingId: fid,
      disposition: fid === representativeFindingId ? "retained" as const : "suppressed" as const,
      reason: fid === representativeFindingId
        ? "representative (lexicographic min)"
        : `suppressed: same issue as ${representativeFindingId}`,
    }));

    // Build stable family record ID
    const familyRecordId = fnv1a(`model-grp-${gIdx}-${memberFindingIds.join(",")}`);

    // Semantic hash: hash of sorted member IDs
    const semanticHash = fnv1a(canonicalJsonSerialize(memberFindingIds));

    const familyRecord: FamilyRecord = {
      familyRecordId,
      // Cast synthetic key — no consumer reads this field as discriminated union
      issueFamilyKey: `model_group_${String(gIdx).padStart(3, "0")}` as unknown as KnownFamilyId,
      ruleId: `model-grouping-rule-${gIdx}`,
      ruleVersion: RULE_VERSION,
      representativeOccurrenceId: representativeFindingId,
      representativeFindingId,
      memberOccurrenceIds: memberFindingIds,
      memberFindingIds,
      memberDispositions,
      evidenceIds: [],
      evidenceRecords: [],
      claimIds: [],
      disclosureIds: [],
      sourceCoordinates: [],
      affectedEntities: [],
      counterparties: [],
      properties: [],
      products: [],
      contracts: [],
      sourceAuthority: null,
      sourceAuthorityMissingReason: "model-grouping engine does not assign authority",
      recursiveLeafAncestry: [],
      rationaleCode: group.reason || "model-grouped",
      matchedDimensions: {},
      semanticHash,
    };

    families.push(familyRecord);
  }

  // Process ungrouped refs
  for (const ref of modelResponse.ungrouped_refs) {
    const fid = refToId.get(ref);
    if (fid && !accountedIds.has(fid)) {
      ungroupedFindingIds.push(fid);
      accountedIds.add(fid);
    }
  }

  // Conservation: any finding not accounted for goes to ungrouped
  for (const [, fid] of refToId) {
    if (!accountedIds.has(fid)) {
      ungroupedFindingIds.push(fid);
    }
  }

  // Compute totals
  const totalSuppressed = families.reduce(
    (sum, f) => sum + f.memberFindingIds.length - 1, // minus representative
    0,
  );

  // Deterministic fingerprint: hash of sorted group assignments
  const groupAssignments = families
    .map(f => `${f.familyRecordId}:${f.memberFindingIds.join(",")}`)
    .sort();
  const resultFingerprint = fnv1a(canonicalJsonSerialize(groupAssignments));

  return {
    families,
    ungroupedFindingIds,
    totalInputFindings: totalInput,
    totalFamiliesCreated: families.length,
    totalSuppressed,
    resultFingerprint,
    ruleVersion: RULE_VERSION,
    // Option (b): emit empty catalogue — no consumer requires it non-empty
    familyCatalogue: [] as KnownFamilyId[],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Model-based consolidation that produces a conformant FamilyDedupResult.
 * Runs single-pass Sonnet grouping, then maps into the canonical contract.
 *
 * FAIL-LOUD: throws on any model or parsing failure.
 * Does NOT silently degrade to no-grouping.
 */
export async function modelConsolidate(
  findings: CanonicalFinding[],
  aiFn: AiFn,
): Promise<FamilyDedupResult> {
  if (findings.length === 0) {
    return {
      families: [],
      ungroupedFindingIds: [],
      totalInputFindings: 0,
      totalFamiliesCreated: 0,
      totalSuppressed: 0,
      resultFingerprint: fnv1a("empty"),
      ruleVersion: RULE_VERSION,
      familyCatalogue: [] as KnownFamilyId[],
    };
  }

  if (findings.length === 1) {
    return {
      families: [],
      ungroupedFindingIds: [findings[0].finding_id],
      totalInputFindings: 1,
      totalFamiliesCreated: 0,
      totalSuppressed: 0,
      resultFingerprint: fnv1a(findings[0].finding_id),
      ruleVersion: RULE_VERSION,
      familyCatalogue: [] as KnownFamilyId[],
    };
  }

  // Build input text from findings
  const { inputText, refToId } = buildRefMap(findings);

  console.log(`[model-consolidation] Running single-pass Sonnet grouping on ${findings.length} findings (${inputText.length} chars)`);

  // Call model — FAIL-LOUD on any error
  const modelResponse = await callGroupingModel(aiFn, inputText);

  console.log(`[model-consolidation] Model returned ${modelResponse.groups.length} groups, ${modelResponse.ungrouped_refs.length} ungrouped`);

  // Map to FamilyDedupResult
  const result = mapToFamilyDedupResult(modelResponse, refToId, findings.length);

  // Conservation assertion: every input finding must be accounted for exactly once
  const allAccountedIds = new Set<string>([
    ...result.ungroupedFindingIds,
    ...result.families.flatMap(f => f.memberFindingIds),
  ]);
  if (allAccountedIds.size !== findings.length) {
    const missing = findings.filter(f => !allAccountedIds.has(f.finding_id));
    throw new Error(
      `[model-consolidation] Conservation violation: ${allAccountedIds.size} accounted vs ${findings.length} input. ` +
      `Missing: ${missing.map(f => f.finding_id).slice(0, 5).join(", ")}`
    );
  }

  console.log(
    `[model-consolidation] Result: ${result.totalFamiliesCreated} families, ` +
    `${result.ungroupedFindingIds.length} ungrouped, ${result.totalSuppressed} suppressed ` +
    `(${findings.length} → ${findings.length - result.totalSuppressed} effective)`
  );

  return result;
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { parseModelResponse as _parseModelResponse, mapToFamilyDedupResult as _mapToFamilyDedupResult, buildRefMap as _buildRefMap };
export type { AiFn, ModelResponse, ModelGroup };
