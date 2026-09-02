/**
 * mast-synthesize.ts
 *
 * Stage handler for synthesize.
 *
 * Compresses hundreds of register-level findings into ~5 critical and
 * ~10 warning findings suitable for an IC deck. Four steps:
 *
 *   A  Cluster — batch the raw findings, ask the LLM to cluster by
 *      underlying belief, then merge clusters across batches.
 *   B  Pair — for each cluster, find related register rows (siblings,
 *      evidence, context) that give the finding meaning.
 *   C  Compose — write one synthesized finding per cluster with title,
 *      body (<=120 words), supportSummary, and optional contradiction.
 *   D  Severity correction — if every member's dependence_basis is
 *      return_metric AND support is nothing, cap severity at warning
 *      (not externally verifiable).
 *
 * Storage: mast_pipeline_state payload for the 'synthesize' stage,
 * key = 'findings'. No writes to mast_findings, mast_assumptions,
 * mast_support_evidence, no new tables, no new columns.
 *
 * synthesize is a loop stage in LOOP_STAGES.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type {
  StageContext,
  StageResult,
  StageHandler,
} from "./mast-contract.js";
import { STAGE_BUDGET_MS } from "./mast-contract.js";
import { getModuleModel } from "./model-config.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-SYNTH]";

const MODULE_ID = "mast_v2";
const INPUT_CAP = 400;
const CLUSTER_BATCH_SIZE = 40;
const PAIR_CANDIDATES_CAP = 20;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_ATTEMPTS = 2;

const SYNTH_CRITICAL_CAP = 5;
const SYNTH_WARNING_CAP = 10;

// COMPOSE_CANDIDATE_CAP = SYNTH_CRITICAL_CAP + SYNTH_WARNING_CAP + margin.
// The margin exists because stepD_severityCorrection can demote a critical to
// warning after composition, which pre-compose ranking cannot anticipate.
const COMPOSE_CANDIDATE_CAP = 40;

// ---------------------------------------------------------------------------
// Banned phrases — same list as mast-fragility.ts (return-figure prohibition)
// ---------------------------------------------------------------------------

const BANNED_PHRASES = [
  "irr",
  "moic",
  "multiple of invested",
  "exit multiple",
  "enterprise value",
  "return on investment",
  "basis points of return",
];

function containsBannedPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const FindingInputRow = z.object({
  finding_id: z.string(),
  assumption_id: z.string(),
  severity: z.string(),
  severity_basis: z.string(),
  proposition: z.string(),
  dependence_tier: z.string().nullable(),
  dependence_basis: z.string().nullable(),
  support_state: z.string(),
  falsification_condition: z.string().nullable(),
  origin_type: z.string(),
});

const RegisterRow = z.object({
  assumption_id: z.string(),
  proposition: z.string(),
  dependence_tier: z.string().nullable(),
  dependence_basis: z.string().nullable(),
  origin_type: z.string(),
  verbatim: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawFinding {
  finding_id: string;
  assumption_id: string;
  severity: string;
  severity_basis: string;
  proposition: string;
  dependence_tier: string | null;
  dependence_basis: string | null;
  support_state: string;
  falsification_condition: string | null;
  origin_type: string;
}

interface Cluster {
  id: number;
  label: string;
  members: RawFinding[];
  pairedContext: string[];
}

interface SynthesizedFinding {
  clusterId: number;
  clusterLabel: string;
  title: string;
  body: string;
  supportSummary: string;
  contradiction: string | null;
  severity: string;
  memberCount: number;
  severityCorrected: boolean;
  correctionReason: string | null;
}

// ---------------------------------------------------------------------------
// Extract support state from severity_basis string
// ---------------------------------------------------------------------------

function extractSupportState(severityBasis: string): string {
  const match = severityBasis.match(/support=(\w+)/);
  return match ? match[1] : "unknown";
}

// ---------------------------------------------------------------------------
// LLM call helper
// ---------------------------------------------------------------------------

async function llmCall(
  ai: StageContext["ai"],
  model: string,
  prompt: string,
  label: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: "user", content: prompt }],
          },
        },
        { response: MessageResponseSchema },
        { label: `${label} attempt ${attempt}` },
      );

      if (resp.stop_reason === "max_tokens") {
        console.log(`${LOG_PREFIX} ${label}: truncated (attempt ${attempt}).`);
        continue;
      }

      const text = resp.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("");

      return text;
    } catch (err) {
      console.log(
        `${LOG_PREFIX} ${label}: LLM error (attempt ${attempt}): ${String(err)}`,
      );
    }
  }
  return null;
}

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as T[];
  } catch {
    // Try to extract JSON from markdown fences
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        const inner = JSON.parse(fenceMatch[1]);
        return Array.isArray(inner) ? (inner as T[]) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step A: Cluster
// ---------------------------------------------------------------------------

function buildClusterPrompt(
  entries: { index: number; proposition: string; severity: string; support: string }[],
): string {
  const list = entries
    .map(
      (e) =>
        `${e.index}. [${e.severity}, support: ${e.support}] ${e.proposition}`,
    )
    .join("\n");

  return `You are grouping due diligence findings by underlying belief. Many entries below say the same thing in different words. Your task is to assign each entry to a cluster.

Rules:
- A cluster represents ONE distinct belief about the deal (e.g. "the exit multiple is 6.0x", "M&A is paused", "pricing includes RPI plus 3.9%").
- If two entries describe the same belief, same metric, or same assumption with different phrasing, they belong to the same cluster.
- Give each cluster a short label (5-10 words) naming the belief.
- A cluster can contain one entry if it is truly unique.

Return a JSON array. Each element: {"index": <integer>, "cluster": <integer starting from 1>, "label": "<cluster label>"}. No prose. No markdown fences.

--- ENTRIES ---
${list}
--- END ENTRIES ---`;
}

async function stepA_cluster(
  ai: StageContext["ai"],
  model: string,
  findings: RawFinding[],
): Promise<Cluster[]> {
  // ── Per-batch clustering ──────────────────────────────────────────
  interface BatchAssignment {
    index: number;
    cluster: number;
    label: string;
  }

  // Track per-batch clusters: batchOffset + cluster number → label + member indices
  const allBatchClusters: {
    label: string;
    members: RawFinding[];
  }[] = [];

  for (let i = 0; i < findings.length; i += CLUSTER_BATCH_SIZE) {
    const batch = findings.slice(i, i + CLUSTER_BATCH_SIZE);
    const entries = batch.map((f, idx) => ({
      index: idx + 1,
      proposition: f.proposition,
      severity: f.severity,
      support: extractSupportState(f.severity_basis),
    }));

    const prompt = buildClusterPrompt(entries);
    const raw = await llmCall(ai, model, prompt, `SYNTH-CLUSTER batch@${i}`);
    const parsed = parseJsonArray<BatchAssignment>(raw);

    if (!parsed) {
      // Fallback: each finding is its own cluster
      console.log(
        `${LOG_PREFIX} Cluster batch@${i}: parse failed. Each entry becomes its own cluster.`,
      );
      for (const f of batch) {
        allBatchClusters.push({
          label: f.proposition.slice(0, 60),
          members: [f],
        });
      }
      continue;
    }

    // Group by cluster number within this batch
    const batchMap = new Map<number, { label: string; members: RawFinding[] }>();
    for (const a of parsed) {
      if (a.index < 1 || a.index > batch.length) continue;
      const finding = batch[a.index - 1];
      let entry = batchMap.get(a.cluster);
      if (!entry) {
        entry = { label: a.label || `Cluster ${a.cluster}`, members: [] };
        batchMap.set(a.cluster, entry);
      }
      entry.members.push(finding);
    }

    // Also catch any ungrouped entries
    const assigned = new Set(
      parsed
        .filter((a) => a.index >= 1 && a.index <= batch.length)
        .map((a) => a.index - 1),
    );
    for (let j = 0; j < batch.length; j++) {
      if (!assigned.has(j)) {
        allBatchClusters.push({
          label: batch[j].proposition.slice(0, 60),
          members: [batch[j]],
        });
      }
    }

    for (const entry of batchMap.values()) {
      allBatchClusters.push(entry);
    }
  }

  console.log(
    `${LOG_PREFIX} Step A per-batch: ${allBatchClusters.length} clusters from ${findings.length} findings.`,
  );

  // ── Cross-batch merge ─────────────────────────────────────────────
  if (allBatchClusters.length <= 1) {
    return allBatchClusters.map((c, i) => ({
      id: i + 1,
      label: c.label,
      members: c.members,
      pairedContext: [],
    }));
  }

  // Ask LLM to merge clusters by label similarity
  const mergeEntries = allBatchClusters.map((c, i) => ({
    index: i + 1,
    label: c.label,
    memberCount: c.members.length,
    sampleProposition: c.members[0]?.proposition.slice(0, 120) ?? "",
  }));

  const mergePrompt = `You are merging clusters of due diligence findings. Below are clusters identified from different batches. Some clusters describe the same underlying belief and should be merged.

Rules:
- Assign each cluster to a merge group.
- Clusters about the same belief/metric/assumption go in the same merge group.
- Give each merge group a short label (5-10 words).
- Do not merge unrelated clusters.

Return a JSON array. Each element: {"index": <integer matching cluster>, "mergeGroup": <integer starting from 1>, "label": "<merge group label>"}. No prose. No markdown fences.

--- CLUSTERS ---
${mergeEntries.map((c) => `${c.index}. "${c.label}" (${c.memberCount} members) — e.g. "${c.sampleProposition}"`).join("\n")}
--- END CLUSTERS ---`;

  const mergeRaw = await llmCall(ai, model, mergePrompt, "SYNTH-MERGE");
  const mergeParsed = parseJsonArray<{
    index: number;
    mergeGroup: number;
    label: string;
  }>(mergeRaw);

  if (!mergeParsed) {
    console.log(
      `${LOG_PREFIX} Cross-batch merge parse failed. Using per-batch clusters as-is.`,
    );
    return allBatchClusters.map((c, i) => ({
      id: i + 1,
      label: c.label,
      members: c.members,
      pairedContext: [],
    }));
  }

  // Build merged clusters
  const mergeGroupMap = new Map<
    number,
    { label: string; members: RawFinding[] }
  >();
  for (const m of mergeParsed) {
    if (m.index < 1 || m.index > allBatchClusters.length) continue;
    const source = allBatchClusters[m.index - 1];
    let group = mergeGroupMap.get(m.mergeGroup);
    if (!group) {
      group = { label: m.label || `Group ${m.mergeGroup}`, members: [] };
      mergeGroupMap.set(m.mergeGroup, group);
    }
    group.members.push(...source.members);
  }

  // Catch unmerged
  const mergedIndices = new Set(
    mergeParsed
      .filter(
        (m) => m.index >= 1 && m.index <= allBatchClusters.length,
      )
      .map((m) => m.index - 1),
  );
  for (let i = 0; i < allBatchClusters.length; i++) {
    if (!mergedIndices.has(i)) {
      const c = allBatchClusters[i];
      const nextId =
        Math.max(0, ...Array.from(mergeGroupMap.keys())) + 1;
      mergeGroupMap.set(nextId, {
        label: c.label,
        members: c.members,
      });
    }
  }

  const merged = Array.from(mergeGroupMap.entries()).map(
    ([id, group]) => ({
      id,
      label: group.label,
      members: group.members,
      pairedContext: [] as string[],
    }),
  );

  console.log(
    `${LOG_PREFIX} Step A merged: ${merged.length} clusters from ${allBatchClusters.length} pre-merge clusters.`,
  );

  return merged;
}

// ---------------------------------------------------------------------------
// Step B: Pair — find related register rows for each cluster
// ---------------------------------------------------------------------------

async function stepB_pair(
  db: StageContext["db"],
  runId: string,
  clusters: Cluster[],
): Promise<void> {
  // Extract keywords from each cluster's members to search the full register
  for (const cluster of clusters) {
    // Build a set of keywords from cluster members' propositions
    const keywords = new Set<string>();
    for (const m of cluster.members) {
      // Extract significant words (>4 chars, not common words)
      const words = m.proposition
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 4 &&
            !STOP_WORDS.has(w),
        );
      for (const w of words.slice(0, 8)) keywords.add(w);
    }

    if (keywords.size === 0) continue;

    // Member assumption IDs to exclude
    const memberIds = cluster.members.map((m) => m.assumption_id);

    // Search the full register for related rows using ILIKE on a few keywords
    const keywordArr = Array.from(keywords).slice(0, 5);
    const likeConditions = keywordArr
      .map((_, i) => `a.proposition ILIKE $${i + 3}`)
      .join(" OR ");
    const likeParams = keywordArr.map((k) => `%${k}%`);

    try {
      const related = await db.query(
        `SELECT a.id AS assumption_id, a.proposition, a.dependence_tier,
                a.dependence_basis, a.origin_type, a.verbatim
         FROM mast_assumptions a
         WHERE a.run_id = $1::uuid
           AND a.dedup_group_id = a.id
           AND a.id != ALL($2::uuid[])
           AND (${likeConditions})
         LIMIT ${PAIR_CANDIDATES_CAP}`,
        RegisterRow,
        [runId, memberIds, ...likeParams],
        { label: `SYNTH-PAIR: cluster ${cluster.id}` },
      );

      for (const r of related) {
        cluster.pairedContext.push(
          `[${r.dependence_tier ?? "low"}, ${r.origin_type}] ${r.proposition}`,
        );
      }
    } catch (pairErr) {
      console.log(
        `${LOG_PREFIX} Pair query failed for cluster ${cluster.id}: ${String(pairErr)}`,
      );
    }
  }
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "based",
  "being",
  "below",
  "between",
  "could",
  "could",
  "during",
  "every",
  "first",
  "given",
  "going",
  "great",
  "level",
  "might",
  "model",
  "noted",
  "other",
  "point",
  "prior",
  "shall",
  "should",
  "since",
  "still",
  "their",
  "these",
  "thing",
  "those",
  "total",
  "under",
  "until",
  "value",
  "where",
  "which",
  "while",
  "would",
  "years",
  "assumption",
  "assumes",
  "assumed",
]);

// ---------------------------------------------------------------------------
// Step C: Compose — write one synthesized finding per cluster
// ---------------------------------------------------------------------------

function buildComposePrompt(
  cluster: Cluster,
): string {
  const memberList = cluster.members
    .slice(0, 15)
    .map(
      (m, i) =>
        `${i + 1}. [${m.severity}, support: ${extractSupportState(m.severity_basis)}, dep: ${m.dependence_tier ?? "low"}] ${m.proposition}` +
        (m.falsification_condition
          ? `\n   Falsification: ${m.falsification_condition}`
          : ""),
    )
    .join("\n");

  const contextBlock =
    cluster.pairedContext.length > 0
      ? `\n--- RELATED REGISTER ROWS (for context, not in this cluster) ---\n${cluster.pairedContext.slice(0, 10).join("\n")}\n--- END RELATED ---\n`
      : "";

  return `You are writing a synthesized due diligence finding for an investment committee. This cluster of ${cluster.members.length} register entries all describe the same belief: "${cluster.label}".

Your task: write ONE finding that captures the essence of this cluster. Consider whether the related register rows (if any) add context that makes this finding more or less significant.

Output a single JSON object with these fields:
- "title": a clear, specific headline (10-20 words). Name the metric and its value.
- "body": a paragraph of at most 120 words. State what the model assumes, what supports it (or doesn't), and why it matters. Do NOT state any impact on IRR, MOIC, exit multiple, enterprise value, or returns.
- "supportSummary": one sentence describing the quality of evidence (measured, forecast, asserted, or nothing).
- "contradiction": one sentence if the related rows contradict this cluster's belief, otherwise null.

PROHIBITIONS:
- Do NOT state any impact on IRR, MOIC, exit multiple, enterprise value, or return on investment.
- Do NOT introduce numbers not present in the input.
- Do NOT use hedging phrases without a concrete observable event.

Return only the JSON object. No prose. No markdown fences.

--- CLUSTER: "${cluster.label}" (${cluster.members.length} entries) ---
${memberList}
${contextBlock}--- END ---`;
}

interface ComposeResult {
  title: string;
  body: string;
  supportSummary: string;
  contradiction: string | null;
}

interface ComposeOutput {
  results: Map<number, ComposeResult>;
  /** Index of the first cluster NOT composed (equals clusters.length if all done). */
  stoppedAtIndex: number;
  budgetExhausted: boolean;
}

async function stepC_compose(
  ai: StageContext["ai"],
  model: string,
  clusters: Cluster[],
  startTime: number,
  budgetMs: number,
  resumeFrom: number = 0,
  priorResults?: Map<number, ComposeResult>,
): Promise<ComposeOutput> {
  const results = priorResults
    ? new Map<number, ComposeResult>(priorResults)
    : new Map<number, ComposeResult>();

  for (let i = resumeFrom; i < clusters.length; i++) {
    // Budget guard: check elapsed time BEFORE dispatching the LLM call
    if (Date.now() - startTime > budgetMs) {
      console.log(
        `${LOG_PREFIX} Step C budget exhausted after composing ${results.size} of ${clusters.length} clusters.`,
      );
      return { results, stoppedAtIndex: i, budgetExhausted: true };
    }

    const cluster = clusters[i];
    const prompt = buildComposePrompt(cluster);
    const raw = await llmCall(
      ai,
      model,
      prompt,
      `SYNTH-COMPOSE cluster=${cluster.id}`,
    );

    if (!raw) {
      console.log(
        `${LOG_PREFIX} Compose failed for cluster ${cluster.id}. Skipping.`,
      );
      continue;
    }

    try {
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
          parsed = JSON.parse(fenceMatch[1]);
        } else {
          throw new Error("Not JSON");
        }
      }

      if (
        typeof parsed.title !== "string" ||
        typeof parsed.body !== "string" ||
        typeof parsed.supportSummary !== "string"
      ) {
        console.log(
          `${LOG_PREFIX} Compose cluster ${cluster.id}: missing required fields. Raw (200): ${raw.slice(0, 200)}`,
        );
        continue;
      }

      // Banned phrase check on title and body
      const bannedInTitle = containsBannedPhrase(parsed.title);
      if (bannedInTitle) {
        console.log(
          `${LOG_PREFIX} REJECTED compose cluster ${cluster.id}: banned phrase "${bannedInTitle}" in title.`,
        );
        continue;
      }
      const bannedInBody = containsBannedPhrase(parsed.body);
      if (bannedInBody) {
        console.log(
          `${LOG_PREFIX} REJECTED compose cluster ${cluster.id}: banned phrase "${bannedInBody}" in body.`,
        );
        continue;
      }

      results.set(cluster.id, {
        title: parsed.title,
        body: parsed.body,
        supportSummary: parsed.supportSummary,
        contradiction:
          parsed.contradiction &&
          typeof parsed.contradiction === "string" &&
          parsed.contradiction.toLowerCase() !== "null"
            ? parsed.contradiction
            : null,
      });
    } catch {
      console.log(
        `${LOG_PREFIX} Compose cluster ${cluster.id}: JSON parse error. Raw (200): ${raw.slice(0, 200)}`,
      );
    }
  }

  return { results, stoppedAtIndex: clusters.length, budgetExhausted: false };
}

// ---------------------------------------------------------------------------
// Step D: Severity correction
// ---------------------------------------------------------------------------

function stepD_severityCorrection(
  cluster: Cluster,
  originalSeverity: string,
): { severity: string; corrected: boolean; reason: string | null } {
  // If every member's dependence_basis = 'return_metric' AND support = 'nothing',
  // the finding is "not externally verifiable" — cap at warning.
  const allReturnMetric = cluster.members.every(
    (m) => m.dependence_basis === "return_metric",
  );
  const allNothingSupport = cluster.members.every(
    (m) => extractSupportState(m.severity_basis) === "nothing",
  );

  if (allReturnMetric && allNothingSupport && originalSeverity === "critical") {
    return {
      severity: "warning",
      corrected: true,
      reason: "not_externally_verifiable",
    };
  }

  return { severity: originalSeverity, corrected: false, reason: null };
}

// ---------------------------------------------------------------------------
// Determine cluster severity from members
// ---------------------------------------------------------------------------

function clusterSeverity(members: RawFinding[]): string {
  // Highest severity wins: critical > warning > info
  if (members.some((m) => m.severity === "critical")) return "critical";
  if (members.some((m) => m.severity === "warning")) return "warning";
  return "info";
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

// Schema for reading partial payload back from DB on resume
const PartialPayloadRow = z.object({
  payload: z.any().nullable(),
});

const synthesize: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, ai, runId, resumePosition } = ctx;
  const startTime = Date.now();
  const model = getModuleModel(MODULE_ID);

  // ── 0. Resume from checkpoint if resumePosition > 0 ──────────────
  //    The partial payload persisted on prior invocations contains the
  //    serialised cluster array so we can skip expensive LLM work.
  let resumedClusters: Cluster[] | null = null;
  let resumedTotalEligible: number | null = null;
  let resumedCappedCount = 0;
  let resumedComposeResults: Map<number, ComposeResult> | null = null;
  let resumedComposeOffset = 0;

  if (resumePosition >= 1) {
    console.log(
      `${LOG_PREFIX} Resuming from checkpoint. resumePosition=${resumePosition}.`,
    );
    try {
      const payloadRows = await db.query(
        `SELECT payload FROM mast_pipeline_state
         WHERE run_id = $1::uuid AND stage = 'synthesize'`,
        PartialPayloadRow,
        [runId],
        { label: "MAST-SYNTH: read partial payload for resume" },
      );
      const existing = payloadRows[0]?.payload;
      if (existing && Array.isArray(existing.clusters)) {
        resumedClusters = (existing.clusters as any[]).map(
          (c: any): Cluster => ({
            id: c.id,
            label: c.label,
            members: c.members ?? [],
            pairedContext: c.pairedContext ?? [],
          }),
        );
        resumedTotalEligible = existing.stats?.inputFindings ?? 0;
        resumedCappedCount = existing.stats?.inputCapped ?? 0;
        console.log(
          `${LOG_PREFIX} Restored ${resumedClusters.length} clusters from checkpoint.`,
        );

        // Restore partial compose results if resuming into Step C (resumePosition >= 3)
        if (
          resumePosition >= 3 &&
          existing.composePartial &&
          Array.isArray(existing.composePartial.entries)
        ) {
          resumedComposeResults = new Map<number, ComposeResult>();
          for (const e of existing.composePartial.entries as any[]) {
            resumedComposeResults.set(e.clusterId, {
              title: e.title,
              body: e.body,
              supportSummary: e.supportSummary,
              contradiction: e.contradiction ?? null,
            });
          }
          resumedComposeOffset = resumePosition - 3;
          console.log(
            `${LOG_PREFIX} Restored ${resumedComposeResults.size} compose results, resuming from offset ${resumedComposeOffset}.`,
          );
        }
      } else {
        console.log(
          `${LOG_PREFIX} No usable cluster data in checkpoint payload. Starting from scratch.`,
        );
      }
    } catch (readErr) {
      console.log(
        `${LOG_PREFIX} Failed to read checkpoint payload: ${String(readErr)}. Starting from scratch.`,
      );
    }
  }

  // ── 1. Load critical + warning findings joined to assumptions ─────
  const rawFindings = await db.query(
    `SELECT
       f.id AS finding_id,
       f.assumption_id,
       f.severity,
       f.severity_basis,
       a.proposition,
       a.dependence_tier,
       a.dependence_basis,
       CASE
         WHEN f.severity_basis LIKE '%support=measured%' THEN 'measured'
         WHEN f.severity_basis LIKE '%support=forecast%' THEN 'forecast'
         WHEN f.severity_basis LIKE '%support=asserted%' THEN 'asserted'
         ELSE 'nothing'
       END AS support_state,
       f.falsification_condition,
       a.origin_type
     FROM mast_findings f
     JOIN mast_assumptions a ON a.id = f.assumption_id
     WHERE f.run_id = $1::uuid
       AND a.dedup_group_id = a.id
       AND f.severity IN ('critical', 'warning')
     ORDER BY
       CASE f.severity WHEN 'critical' THEN 0 ELSE 1 END,
       CASE a.dependence_tier
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1
         WHEN 'moderate' THEN 2 ELSE 3
       END,
       f.assumption_id`,
    FindingInputRow,
    [runId],
    { label: "MAST-SYNTH: load critical+warning findings" },
  );

  const totalEligible = rawFindings.length;

  if (totalEligible === 0) {
    console.log(
      `${LOG_PREFIX} No critical or warning findings for run ${runId}. Nothing to synthesize.`,
    );

    const emptyPayload = {
      findings: [],
      stats: {
        inputFindings: 0,
        clustersFormed: 0,
        findingsProduced: 0,
        severityCorrections: 0,
      },
    };

    try {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = $3::jsonb
         WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
        [runId, "synthesize", JSON.stringify(emptyPayload)],
        { label: "MAST-SYNTH: persist empty payload" },
      );
    } catch (_) {
      /* best effort */
    }

    return { complete: true, itemsDone: 0, itemsTotal: 0, resumePosition: 0 };
  }

  // Cap input
  const capped = rawFindings.slice(0, INPUT_CAP);
  const cappedCount = totalEligible - capped.length;
  if (cappedCount > 0) {
    console.log(
      `${LOG_PREFIX} ${totalEligible} eligible. Capped to ${INPUT_CAP}; ${cappedCount} dropped.`,
    );
  } else {
    console.log(`${LOG_PREFIX} ${totalEligible} eligible findings loaded.`);
  }

  // ── Step A: Cluster ───────────────────────────────────────────────
  //    Skip if we resumed with clusters already built.
  let clusters: Cluster[];
  const effectiveTotalEligible = resumedTotalEligible ?? totalEligible;
  const effectiveCappedCount = resumedClusters ? resumedCappedCount : cappedCount;

  if (resumedClusters && resumePosition >= 1) {
    clusters = resumedClusters;
    console.log(
      `${LOG_PREFIX} Step A: SKIPPED (resumed ${clusters.length} clusters from checkpoint).`,
    );
  } else {
    console.log(`${LOG_PREFIX} Step A: Clustering ${capped.length} findings...`);
    clusters = await stepA_cluster(ai, model, capped);
  }

  if (Date.now() - startTime > STAGE_BUDGET_MS) {
    console.log(`${LOG_PREFIX} Budget exceeded after Step A. Pausing.`);
    // Persist partial progress WITH cluster data for resumption
    const partialPayload = {
      findings: [],
      clusters: clusters.map((c) => ({
        id: c.id,
        label: c.label,
        members: c.members,
        pairedContext: c.pairedContext,
      })),
      stats: {
        inputFindings: effectiveTotalEligible,
        inputCapped: effectiveCappedCount,
        clustersFormed: clusters.length,
        findingsProduced: 0,
        severityCorrections: 0,
        partialStop: "after_clustering",
      },
    };
    try {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = $3::jsonb
         WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
        [runId, "synthesize", JSON.stringify(partialPayload)],
        { label: "MAST-SYNTH: persist partial payload (post-cluster)" },
      );
    } catch (_) {
      /* best effort */
    }
    return {
      complete: false,
      itemsDone: clusters.length,
      itemsTotal: clusters.length * 3,
      resumePosition: 1, // signals: clustering done, pair next
    };
  }

  // ── Step B: Pair ──────────────────────────────────────────────────
  //    Skip if we resumed past pairing.
  if (resumedClusters && resumePosition >= 2) {
    console.log(
      `${LOG_PREFIX} Step B: SKIPPED (resumed with pairedContext from checkpoint).`,
    );
  } else {
    console.log(`${LOG_PREFIX} Step B: Pairing ${clusters.length} clusters...`);
    await stepB_pair(db, runId, clusters);
  }

  if (Date.now() - startTime > STAGE_BUDGET_MS) {
    console.log(`${LOG_PREFIX} Budget exceeded after Step B. Pausing.`);
    const partialPayload = {
      findings: [],
      clusters: clusters.map((c) => ({
        id: c.id,
        label: c.label,
        members: c.members,
        pairedContext: c.pairedContext,
      })),
      stats: {
        inputFindings: effectiveTotalEligible,
        inputCapped: effectiveCappedCount,
        clustersFormed: clusters.length,
        findingsProduced: 0,
        severityCorrections: 0,
        partialStop: "after_pairing",
      },
    };
    try {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = $3::jsonb
         WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
        [runId, "synthesize", JSON.stringify(partialPayload)],
        { label: "MAST-SYNTH: persist partial payload (post-pair)" },
      );
    } catch (_) {
      /* best effort */
    }
    return {
      complete: false,
      itemsDone: clusters.length,
      itemsTotal: clusters.length * 3,
      resumePosition: 2,
    };
  }

  // ── Rank before compose ─────────────────────────────────────────
  //    Sort clusters using the same ordering Step D applies: severity
  //    from clusterSeverity, criticals first, then by memberCount desc.
  //    Take the top COMPOSE_CANDIDATE_CAP so we only compose clusters
  //    that have a realistic chance of surviving the Step D caps.
  const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

  const rankedClusters = [...clusters].sort((a, b) => {
    const sa = sevOrder[clusterSeverity(a.members)] ?? 2;
    const sb = sevOrder[clusterSeverity(b.members)] ?? 2;
    if (sa !== sb) return sa - sb;
    return b.members.length - a.members.length;
  });

  const composeCandidates = rankedClusters.slice(0, COMPOSE_CANDIDATE_CAP);

  const selectedCriticals = composeCandidates.filter(
    (c) => clusterSeverity(c.members) === "critical",
  ).length;
  const selectedWarnings = composeCandidates.filter(
    (c) => clusterSeverity(c.members) === "warning",
  ).length;

  console.log(
    `${LOG_PREFIX} COMPOSE_RANK total=${clusters.length} selected=${composeCandidates.length}` +
    ` criticals_selected=${selectedCriticals} warnings_selected=${selectedWarnings}`,
  );

  // ── Step C: Compose ───────────────────────────────────────────────
  //    Skip if resumed past compose; resume at offset if partially done.
  const composeResumeFrom =
    resumedComposeResults && resumePosition >= 3
      ? resumedComposeOffset
      : 0;

  if (resumedComposeResults && resumePosition >= 3) {
    console.log(
      `${LOG_PREFIX} Step C: Resuming compose from offset ${composeResumeFrom} ` +
      `(${resumedComposeResults.size} already composed).`,
    );
  } else {
    console.log(
      `${LOG_PREFIX} Step C: Composing findings for ${composeCandidates.length} clusters...`,
    );
  }

  const composeOutput = await stepC_compose(
    ai,
    model,
    composeCandidates,
    startTime,
    STAGE_BUDGET_MS,
    composeResumeFrom,
    resumedComposeResults ?? undefined,
  );

  const composeResults = composeOutput.results;

  if (composeOutput.budgetExhausted) {
    console.log(
      `${LOG_PREFIX} Step C partial: ${composeResults.size} of ${composeCandidates.length} composed. Pausing.`,
    );

    // Serialize compose results for resumption
    const composePartialEntries = Array.from(composeResults.entries()).map(
      ([clusterId, cr]) => ({
        clusterId,
        title: cr.title,
        body: cr.body,
        supportSummary: cr.supportSummary,
        contradiction: cr.contradiction,
      }),
    );

    const partialPayload = {
      findings: [],
      clusters: clusters.map((c) => ({
        id: c.id,
        label: c.label,
        members: c.members,
        pairedContext: c.pairedContext,
      })),
      composePartial: {
        entries: composePartialEntries,
      },
      stats: {
        inputFindings: effectiveTotalEligible,
        inputCapped: effectiveCappedCount,
        clustersFormed: clusters.length,
        composeCandidates: composeCandidates.length,
        composedSoFar: composeResults.size,
        composeStoppedAtIndex: composeOutput.stoppedAtIndex,
        findingsProduced: 0,
        severityCorrections: 0,
        partialStop: "during_compose",
      },
    };

    try {
      await db.execute(
        `UPDATE mast_pipeline_state
         SET payload = $3::jsonb
         WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
        [runId, "synthesize", JSON.stringify(partialPayload)],
        { label: "MAST-SYNTH: persist partial payload (mid-compose)" },
      );
    } catch (_) {
      /* best effort */
    }

    // resumePosition = 3 + composedCount so the next invocation
    // knows how many clusters to skip in the composeCandidates array.
    return {
      complete: false,
      itemsDone: composeResults.size,
      itemsTotal: composeCandidates.length,
      resumePosition: 3 + composeOutput.stoppedAtIndex,
    };
  }

  console.log(
    `${LOG_PREFIX} Step C complete. ${composeResults.size} of ${composeCandidates.length} clusters composed.`,
  );

  // ── Step D: Severity correction + assembly ────────────────────────
  //    Iterate only over composeCandidates (the ranked subset).
  const synthesized: SynthesizedFinding[] = [];
  let severityCorrections = 0;

  for (const cluster of composeCandidates) {
    const composed = composeResults.get(cluster.id);
    if (!composed) continue;

    const rawSev = clusterSeverity(cluster.members);
    const { severity, corrected, reason } = stepD_severityCorrection(
      cluster,
      rawSev,
    );

    if (corrected) severityCorrections++;

    synthesized.push({
      clusterId: cluster.id,
      clusterLabel: cluster.label,
      title: composed.title,
      body: composed.body,
      supportSummary: composed.supportSummary,
      contradiction: composed.contradiction,
      severity,
      memberCount: cluster.members.length,
      severityCorrected: corrected,
      correctionReason: reason,
    });
  }

  // Sort: criticals first, then warnings, then by memberCount desc
  synthesized.sort((a, b) => {
    const sa = sevOrder[a.severity] ?? 2;
    const sb = sevOrder[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return b.memberCount - a.memberCount;
  });

  // Cap: 5 critical, 10 warning
  const criticals = synthesized.filter((f) => f.severity === "critical");
  const warnings = synthesized.filter((f) => f.severity === "warning");
  const cappedCriticals = criticals.slice(0, SYNTH_CRITICAL_CAP);
  const cappedWarnings = warnings.slice(0, SYNTH_WARNING_CAP);
  const finalFindings = [...cappedCriticals, ...cappedWarnings];

  const correctionMargin = COMPOSE_CANDIDATE_CAP - SYNTH_CRITICAL_CAP - SYNTH_WARNING_CAP;
  const marginExhausted = severityCorrections > correctionMargin;

  console.log(
    `${LOG_PREFIX} CORRECTION_MARGIN corrections=${severityCorrections}` +
    ` margin=${correctionMargin} exhausted=${marginExhausted}`,
  );

  console.log(
    `${LOG_PREFIX} Step D complete. ${synthesized.length} synthesized findings. ` +
    `${criticals.length} critical (capped to ${cappedCriticals.length}), ` +
    `${warnings.length} warning (capped to ${cappedWarnings.length}). ` +
    `${severityCorrections} severity corrections applied.`,
  );

  // ── Persist payload ───────────────────────────────────────────────
  const payload = {
    findings: finalFindings,
    stats: {
      inputFindings: effectiveTotalEligible,
      inputCapped: effectiveCappedCount,
      clustersFormed: clusters.length,
      findingsProduced: finalFindings.length,
      criticalProduced: cappedCriticals.length,
      warningProduced: cappedWarnings.length,
      totalComposed: composeResults.size,
      severityCorrections,
      composeCandidates: composeCandidates.length,
      composeFailures: composeCandidates.length - composeResults.size,
    },
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "synthesize", JSON.stringify(payload)],
      { label: "MAST-SYNTH: persist final payload" },
    );
  } catch (payloadErr) {
    console.log(
      `${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`,
    );
  }

  console.log(
    `${LOG_PREFIX} Synthesize complete. ${finalFindings.length} findings stored in payload. ` +
    `Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s.`,
  );

  return {
    complete: true,
    itemsDone: finalFindings.length,
    itemsTotal: finalFindings.length,
    resumePosition: 0,
  };
};

export default synthesize;
