/**
 * BSS v2 — Part 3: blind candidate generator.
 *
 * Takes a persisted structural profile and asks, without any sight of the
 * diligence corpus, what tends to kill businesses of that shape and what an
 * investor would have to be assuming for it not to happen. The answers are
 * persisted as candidates with pass_type = 'blind'.
 *
 * WHY THIS IS A SEPARATE CALL FROM THE PROFILE
 *   The profile build reads a CIM. This call reads no documents at all. Its
 *   entire input is eight short phrases. That is what makes the candidates it
 *   produces "blind": they cannot have been shaped by the diligence work that
 *   the later passes will search for them in. If this call ever gains access to
 *   a corpus, the module stops measuring what it claims to measure.
 *
 * WHAT ENTERS THE PROMPT
 *   `bss_profiles.profile_json.profile` and nothing else — the eight fields, in
 *   PROFILE_FIELDS order. NOT `field_support` (which carries verbatim CIM
 *   snippets, i.e. source text), and NOT `notes` (which is the profile
 *   generator narrating its own confidence). A leakage assertion runs on the
 *   assembled prompt string before the call and fails closed.
 *
 * NO CITATIONS HERE
 *   Unlike the profile builder and unlike Part 4, this call has no corpus, so
 *   there is nothing for it to cite and no inversion requirement to impose. A
 *   candidate is a hypothesis to go looking for, not a finding. The evidence
 *   burden lands in the passes that search, not here.
 *
 * NO ASSESSMENT LANGUAGE
 *   `bss_candidates` has no severity, confidence, priority or tier column, and
 *   that is deliberate: ranking twenty-five blind guesses by importance would
 *   be inventing precision the generator cannot have. Any such key in the model
 *   response is a contract violation and aborts before insert.
 *
 * IDEMPOTENT
 *   `candidate_hash` is the SHA-256 of the failure_mode reduced to lowercase
 *   alphanumerics, and the upsert targets the unique index
 *   bss_candidates_dedupe_uniq (deal_id, profile_id, pass_type, candidate_hash).
 *   Re-running against the same profile refreshes rows rather than multiplying
 *   them. Duplicates WITHIN one response are collapsed before the statement
 *   runs — Postgres rejects an ON CONFLICT DO UPDATE that would touch the same
 *   row twice in a single command.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { callLLMWithHeadroom } from "./call-llm.js";
import { getModuleModel } from "./model-config.js";
import { sha256hex } from "./sha256-pure.js";
import { BSS_V2_MODULE_ID, FORBIDDEN_KEY_PATTERN, PROFILE_FIELDS } from "./bss-profile.js";
import type { PipelineContext } from "./pipeline-config.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

const LOG_PREFIX = "[BSS-GEN]";

// ---------------------------------------------------------------------------
// Contract constants — exported so the rules are auditable, not buried
// ---------------------------------------------------------------------------

/** pass_type written by this API. Part 4 writes a different value. */
export const BLIND_PASS_TYPE = "blind";

/**
 * Ceiling, not a target. The prompt says "at most"; a model that has ten
 * structurally honest candidates should return ten.
 */
export const MAX_CANDIDATES = 25;

/** proposed_queries array length bounds, inclusive. Outside → candidate dropped. */
export const MIN_QUERIES_PER_CANDIDATE = 3;
export const MAX_QUERIES_PER_CANDIDATE = 5;

/** Word-count bounds for a single query, inclusive. Outside → candidate dropped. */
export const MIN_QUERY_WORDS = 2;
export const MAX_QUERY_WORDS = 8;

// FORBIDDEN_KEY_PATTERN imported from bss-profile.ts — single source of truth.
// Union pattern: /sever|confidence|priorit|tier|risk_level|critical|impact_level/i

/**
 * An implied_assumption must be a positive declarative claim: something an
 * investor is taking to be true. Openers like "no ", "lack of" restate the
 * failure mode as an absence, which is not an assumption and cannot be tested
 * against a corpus. A trailing "?" means the model wrote a diligence question
 * instead — the thing this module exists to avoid producing.
 */
export const ASSUMPTION_BANNED_OPENERS = ["no ", "not ", "lack of", "absence of"];

/**
 * Generous. Twenty-five candidates with four prose fields and up to five
 * queries each is a large structured response, and a truncated JSON object is
 * a total loss rather than a partial one.
 */
const MAX_OUTPUT_TOKENS = 12000;

/**
 * A long single call. Clamped by callLLMWithHeadroom to the platform clock, so
 * this is an upper bound rather than a promise.
 */
const MAX_PER_CALL_TIMEOUT_MS = 240_000;

/**
 * At most one retry, and only for transient transport errors — the headroom
 * guard inside callLLMWithHeadroom will refuse a second attempt unless the
 * first failed quickly. A run authorization for "one LLM call" is not spent by
 * a 529 that never produced tokens.
 */
const RETRIES = 2;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const ProfileRowSchema = z.object({
  profile_id: z.string(),
  deal_id: z.string(),
  profile_kind: z.string(),
  profile_version: z.number(),
  profile_json: z.any(),
});

const MaxVersionSchema = z.object({
  max_version: z.number(),
});

const UpsertedRowSchema = z.object({
  candidate_id: z.string(),
  candidate_hash: z.string(),
  inserted: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip markdown fences and isolate the outermost JSON object. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Model response contained no JSON object. First 300 chars: ${trimmed.slice(0, 300)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Collect every key name appearing anywhere in a nested structure. */
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Max failure_mode length in characters. Beyond this the label is a sentence. */
export const MAX_FAILURE_MODE_CHARS = 60;

/**
 * candidate_hash — SHA-256 of the failure_mode reduced to lowercase
 * alphanumerics. Because failure_mode is a short snake_case label, hashing it
 * gives stable dedupe: the same concept always produces the same hash.
 * Exported because the dedupe key must be reproducible outside this file.
 */
export function candidateHash(failureMode: string): string {
  return sha256hex(failureMode.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// ---------------------------------------------------------------------------
// Query diversity — stopword-filtered term overlap
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "not", "no", "if", "it",
  "its", "this", "that", "these", "those", "as", "so", "up", "out",
  "about", "into", "over", "after", "before", "between", "under",
  "above", "each", "all", "any", "both", "more", "most", "other",
  "some", "such", "than", "too", "very", "just", "also",
]);

/** Extract content terms from a query string, lowercased, stopwords removed. */
function contentTerms(query: string): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/**
 * Prune queries so no pair shares >50% content terms.
 * For each overlapping pair the later query (higher index) is removed.
 * Repeat until no pair exceeds the threshold.
 * The caller drops the candidate only if fewer than MIN_QUERIES_PER_CANDIDATE survive.
 */
export function pruneOverlappingQueries(
  queries: string[],
): { pruned: string[]; prunedPairs: Array<{ kept: string; dropped: string }> } {
  const active = [...queries];
  const prunedPairs: Array<{ kept: string; dropped: string }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < active.length; i++) {
      const termsA = contentTerms(active[i]);
      if (termsA.size === 0) continue;
      for (let j = i + 1; j < active.length; j++) {
        const termsB = contentTerms(active[j]);
        if (termsB.size === 0) continue;
        let overlap = 0;
        for (const t of termsA) if (termsB.has(t)) overlap++;
        if (overlap > Math.min(termsA.size, termsB.size) / 2) {
          prunedPairs.push({ kept: active[i], dropped: active[j] });
          active.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return { pruned: active, prunedPairs };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Assemble the exact prompt string. Pure and deterministic: same profile in,
 * same string out, which is what makes prompt_hash worth persisting.
 *
 * The framing deliberately avoids the words "diligence", "due diligence" and
 * "checklist". Asked to run a diligence process, a model reproduces the
 * standard one, and the standard one is exactly what the diligence corpus
 * already covers — which would make every candidate a guaranteed hit and the
 * module's output worthless. Asking instead how businesses of this shape fail
 * produces mechanisms, some of which nobody thought to look at.
 */
export function buildBlindCandidatePrompt(args: {
  profile: Record<string, string>;
}): string {
  const { profile } = args;

  const profileBlock = PROFILE_FIELDS.map((f) => `${f}: ${profile[f]}`).join("\n");

  return `Here is the structural shape of one company. Eight short phrases, nothing else.

<company_shape>
${profileBlock}
</company_shape>

Some fields may read "unknown". That means the shape of this company on that dimension was not established. Treat "unknown" as genuinely unknown: do not guess a value, do not reason as if you had one, and do not build a candidate whose whole force depends on a value you supplied yourself. You may say that something is unknown as part of a rationale. You may not quietly replace it with a plausible number.

You have no documents. You have not seen this company's accounts, contracts, customer list, systems, or any analysis anyone has done on it. Do not pretend otherwise and do not describe what such material would show.

THE QUESTION

First: what tends to kill businesses of this shape? Not this company — businesses of this shape. Think about the mechanisms by which companies with this model, these customers, this transaction structure actually come apart: how the economics stop working, where the operational load lands, what the buy-side inherits, which dependencies are load-bearing and invisible, what the seller's incentives make it rational to leave unsaid.

Then, for each mechanism: what would an investor have to be assuming, right now, for that not to happen here? State that assumption plainly, as something a person believes to be true. That assumption is the thing that can be checked later.

Return at most ${MAX_CANDIDATES} of these. That is a ceiling, not a target. ${MAX_CANDIDATES} shallow mechanisms are worth less than eight that are specific to this shape. Do not pad the list to reach a number, and do not produce two entries that are the same mechanism worded differently.

Avoid the generic corporate risk list. "Key person dependency", "customer concentration", "integration risk" and "regulatory change" apply to almost any company and cost nothing to say. If a mechanism would appear unchanged on a company with a completely different shape, either sharpen it until it is specific to this one or drop it.

OUTPUT

Return ONLY a JSON object. No prose before or after it, no markdown code fences.

{
  "candidates": [
    {
      "failure_mode": "<short_snake_case_label>",
      "implied_assumption": "<what an investor must be taking to be true for that mechanism not to bite here, one sentence, positive and declarative>",
      "hypothesis": "<the concrete, checkable claim about this company that would be true if the mechanism is live>",
      "rationale": "<why this mechanism is structurally plausible given the eight fields above, two sentences at most>",
      "proposed_queries": ["<search phrase>", "<search phrase>", "<search phrase>"]
    }
  ]
}

FIELD RULES

- "failure_mode": a short snake_case label naming the mechanism, 2–5 words joined by underscores, no spaces. Examples: "renewal_pricing_erosion", "acquired_cohort_churn", "service_desk_cost_creep". The label is a tag, not a sentence — the mechanism sentence goes in "hypothesis".
- "implied_assumption": write it as a positive statement of belief. It must NOT be phrased as a question and must NOT begin with "No", "Not", "Lack of" or "Absence of". Write "Renewal pricing holds at current levels", not "No pricing pressure at renewal" and not "Is renewal pricing holding?".
- "hypothesis": what would actually be the case if the mechanism is live here. It must be the kind of statement that a document could confirm or contradict. It is a claim to go and test, not a conclusion.
- "rationale": tie it to the eight fields. If the connection runs through a field marked "unknown", say so rather than inventing the missing value.
- "proposed_queries": between ${MIN_QUERIES_PER_CANDIDATE} and ${MAX_QUERIES_PER_CANDIDATE} of them. Each is a short search phrase of ${MIN_QUERY_WORDS} to ${MAX_QUERY_WORDS} words, of the kind you would type to find the relevant passage in a pile of company documents. Terms, not sentences, and not questions. Any candidate whose queries fall outside those bounds is discarded whole, so count the words. Attack the same concept through different vocabulary — each query should use mostly different content words from the others. If two queries share more than half their non-stopword terms, the later one is pruned rather than costing you the whole candidate — but if fewer than ${MIN_QUERIES_PER_CANDIDATE} survive, the candidate is dropped.

Do not emit any key containing "severity", "confidence", "priority", "tier", "critical" or "impact_level", and do not rank, score, order by importance, or flag any candidate as more serious than another. Nothing here has been checked against anything. An ordering would be a fabrication.`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "BssGenerateBlindCandidates",
  description: "Generates blind failure-mode candidates from a structural profile",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    profileId: z.string().uuid(),
  }),

  output: z.object({
    success: z.boolean(),
    dealId: z.string(),
    profileId: z.string(),
    profileVersion: z.number(),
    passType: z.string(),
    generationModel: z.string(),
    modelReported: z.string(),
    promptHash: z.string(),
    promptChars: z.number(),
    promptText: z.string(),
    profileFieldsSent: z.record(z.string(), z.string()),
    leakageAssertionPassed: z.boolean(),
    forbiddenKeysFound: z.array(z.string()),
    rawCandidateCount: z.number(),
    acceptedCount: z.number(),
    droppedCount: z.number(),
    dropped: z.array(
      z.object({
        index: z.number(),
        failureMode: z.string(),
        reasons: z.array(z.string()),
      }),
    ),
    inBatchDuplicates: z.array(
      z.object({ index: z.number(), failureMode: z.string(), candidateHash: z.string() }),
    ),
    prunedQueryCount: z.number(),
    prunedQueries: z.array(
      z.object({
        candidateIndex: z.number(),
        failureMode: z.string(),
        kept: z.string(),
        dropped: z.string(),
      }),
    ),
    insertedCount: z.number(),
    updatedCount: z.number(),
    upsertedHashes: z.array(z.string()),
    llmCallMs: z.number(),
    stopReason: z.string().nullable(),
    usage: z.any(),
  }),

  async run(ctx, { dealId, profileId }) {
    // Standalone API, not a pipeline runner: it owns its own platform clock.
    const pipelineStartTime = Date.now();

    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // ── Step 1: load the profile ──────────────────────────────────────────
    const profileRows = await ctx.integrations.db.query(
      `SELECT profile_id, deal_id, profile_kind, profile_version, profile_json
         FROM bss_profiles WHERE profile_id = $1::uuid`,
      ProfileRowSchema,
      [profileId],
      { label: "BSSGenerate: load structural profile" },
    );
    if (profileRows.length === 0) {
      throw new Error(`${LOG_PREFIX} profile ${profileId} not found.`);
    }
    const profileRow = profileRows[0];

    // A profile belonging to another deal would produce candidates whose
    // provenance is a lie, and the FK alone would not catch it.
    if (profileRow.deal_id !== dealId) {
      throw new Error(
        `${LOG_PREFIX} profile ${profileId} belongs to deal ${profileRow.deal_id}, not ${dealId}. ` +
          "No LLM call, no insert.",
      );
    }
    if (profileRow.profile_kind !== "structural") {
      throw new Error(
        `${LOG_PREFIX} profile ${profileId} has profile_kind='${profileRow.profile_kind}'. ` +
          "The blind pass generates from the structural profile only.",
      );
    }

    // ── Step 1b: reject superseded profiles ───────────────────────────────
    // Passing an older profile_id would silently generate from stale data.
    const maxVersionRows = await ctx.integrations.db.query(
      `SELECT MAX(profile_version) AS max_version FROM bss_profiles
         WHERE deal_id = $1::uuid AND profile_kind = 'structural'`,
      MaxVersionSchema,
      [dealId],
      { label: "BSSGenerate: check max profile version" },
    );
    const maxVersion = maxVersionRows[0]?.max_version ?? 0;
    if (profileRow.profile_version !== maxVersion) {
      throw new Error(
        `${LOG_PREFIX} profile ${profileId} is v${profileRow.profile_version} but the current ` +
          `structural profile for deal ${dealId} is v${maxVersion}. ` +
          "Generating from a superseded profile would silently use stale data. No LLM call, no insert.",
      );
    }

    // ── Step 2: extract profile_json.profile, and only that ───────────────
    const profileJson = profileRow.profile_json as Record<string, unknown> | null;
    const rawProfile = profileJson?.profile;
    if (rawProfile === null || rawProfile === undefined || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      throw new Error(`${LOG_PREFIX} profile_json.profile is missing or not an object on ${profileId}.`);
    }
    const profileIn = rawProfile as Record<string, unknown>;

    const missing = PROFILE_FIELDS.filter((f) => typeof profileIn[f] !== "string" || profileIn[f] === "");
    if (missing.length > 0) {
      throw new Error(`${LOG_PREFIX} profile_json.profile missing fields: ${missing.join(", ")}`);
    }

    // Rebuild in fixed order. Anything the stored object carries beyond the
    // eight fields is dropped here rather than passed through by accident.
    const profileFieldsSent: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) profileFieldsSent[f] = String(profileIn[f]);

    const unknownFields = PROFILE_FIELDS.filter(
      (f) => profileFieldsSent[f].trim().toLowerCase() === "unknown",
    );
    console.log(
      `${LOG_PREFIX} profile v${profileRow.profile_version} loaded; sending ${PROFILE_FIELDS.length} fields, ` +
        `${unknownFields.length} of them "unknown"` +
        (unknownFields.length > 0 ? ` (${unknownFields.join(", ")})` : "") +
        ". field_support and notes withheld.",
    );

    // ── Step 3: assemble prompt, assert no leakage, hash ──────────────────
    const prompt = buildBlindCandidatePrompt({ profile: profileFieldsSent });

    // field_support holds verbatim CIM snippets and notes is the profile
    // generator's self-assessment. Neither may reach this call. Checking the
    // assembled string rather than the assembly logic means a future edit to
    // the prompt builder cannot quietly widen the input.
    const leaks: string[] = [];
    if (prompt.includes("field_support")) leaks.push("field_support key name present in prompt");
    const notesText = typeof profileJson?.notes === "string" ? profileJson.notes.trim() : "";
    if (notesText.length > 0 && prompt.includes(notesText)) {
      leaks.push("profile_json.notes text present in prompt");
    }
    const supportObj = profileJson?.field_support;
    if (supportObj !== null && supportObj !== undefined && typeof supportObj === "object") {
      for (const [field, entry] of Object.entries(supportObj as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object") continue;
        const snippet = (entry as Record<string, unknown>).verbatim_snippet;
        if (typeof snippet === "string" && snippet.trim().length > 0 && prompt.includes(snippet.trim())) {
          leaks.push(`field_support.${field}.verbatim_snippet present in prompt`);
        }
      }
    }
    if (leaks.length > 0) {
      throw new Error(
        `${LOG_PREFIX} BLINDNESS ASSERTION FAILED: ${leaks.join("; ")}. ` +
          "The blind pass may see the eight profile fields and nothing else. No LLM call, no insert.",
      );
    }
    const leakageAssertionPassed = true;

    const promptHash = sha256hex(prompt);
    const promptChars = prompt.length;

    // useOpus = true. This pass is generating hypotheses from eight phrases with
    // no corpus to lean on; the whole output quality is the reasoning.
    const generationModel = getModuleModel(BSS_V2_MODULE_ID, true);

    console.log(
      `${LOG_PREFIX} prompt assembled: ${promptChars} chars, model=${generationModel}, ` +
        `sha256=${promptHash.slice(0, 16)}…, leakage assertion passed.`,
    );

    // ── Step 4: the single LLM call ───────────────────────────────────────
    const callStart = Date.now();
    const response = await callLLMWithHeadroom(
      pipelineCtx,
      {
        model: generationModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: prompt }],
      },
      "BSSGenerate: blind candidates",
      { pipelineStartTime, maxPerCallTimeout: MAX_PER_CALL_TIMEOUT_MS, retries: RETRIES },
    );
    const llmCallMs = Date.now() - callStart;

    const rawText = response.content.find((c) => c.type === "text")?.text ?? "";
    console.log(
      `${LOG_PREFIX} call complete: model=${response.model}, ${llmCallMs}ms, ` +
        `in=${response.usage.input_tokens} out=${response.usage.output_tokens} stop=${response.stop_reason}`,
    );
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `${LOG_PREFIX} response hit max_tokens (${MAX_OUTPUT_TOKENS}) and is truncated. ` +
          "A truncated candidate list is silently short rather than obviously broken. No insert performed.",
      );
    }

    // ── Step 5: parse and validate, fail-closed on contract violations ────
    const parsed = extractJsonObject(rawText) as Record<string, unknown>;

    const forbiddenKeysFound = collectKeys(parsed).filter((k) => FORBIDDEN_KEY_PATTERN.test(k));
    if (forbiddenKeysFound.length > 0) {
      console.error(
        `${LOG_PREFIX} CONTRACT VIOLATION: assessment keys in response: ${forbiddenKeysFound.join(", ")}`,
      );
      throw new Error(
        `${LOG_PREFIX} response contained forbidden assessment keys [${forbiddenKeysFound.join(", ")}]. ` +
          "bss_candidates has no severity, confidence, priority or tier column by design. No insert performed.",
      );
    }

    const rawList = parsed.candidates;
    if (!Array.isArray(rawList)) {
      throw new Error(`${LOG_PREFIX} response has no "candidates" array. Raw: ${rawText.slice(0, 400)}`);
    }
    const rawCandidateCount = rawList.length;
    if (rawCandidateCount > MAX_CANDIDATES) {
      throw new Error(
        `${LOG_PREFIX} response returned ${rawCandidateCount} candidates, over the ceiling of ${MAX_CANDIDATES}. ` +
          "Truncating silently would hide that the ceiling was ignored. No insert performed.",
      );
    }

    // ── Step 6: per-candidate drop rules ──────────────────────────────────
    // A malformed candidate is dropped, not repaired. Repairing it would mean
    // this file writing content into a field the generator is responsible for,
    // and the drop count is itself the signal about how well the prompt worked.
    type Accepted = {
      failure_mode: string;
      implied_assumption: string;
      hypothesis: string;
      rationale: string | null;
      proposed_queries: string[];
      candidate_hash: string;
    };

    const accepted: Accepted[] = [];
    const dropped: Array<{ index: number; failureMode: string; reasons: string[] }> = [];
    const inBatchDuplicates: Array<{ index: number; failureMode: string; candidateHash: string }> = [];
    const seenHashes = new Set<string>();

    // Query-pruning accumulators — track which individual queries were removed
    // (rather than whole candidates) so the output diagnostics show what happened.
    let totalPrunedQueryCount = 0;
    const allPrunedQueries: Array<{
      candidateIndex: number;
      failureMode: string;
      kept: string;
      dropped: string;
    }> = [];

    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      const reasons: string[] = [];

      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        dropped.push({ index: i, failureMode: "", reasons: [`not an object (got ${typeof item})`] });
        continue;
      }
      const c = item as Record<string, unknown>;

      const failureMode = typeof c.failure_mode === "string" ? c.failure_mode.trim() : "";
      const impliedAssumption =
        typeof c.implied_assumption === "string" ? c.implied_assumption.trim() : "";
      const hypothesis = typeof c.hypothesis === "string" ? c.hypothesis.trim() : "";
      const rationaleRaw = typeof c.rationale === "string" ? c.rationale.trim() : "";

      // NOT NULL columns.
      if (failureMode === "") reasons.push("failure_mode empty or not a string");
      if (hypothesis === "") reasons.push("hypothesis empty or not a string");

      // failure_mode must be a short snake_case label — no spaces, ≤60 chars.
      if (failureMode !== "" && /\s/.test(failureMode)) {
        reasons.push(`failure_mode contains whitespace — expected snake_case label: "${failureMode.slice(0, 80)}"`);
      }
      if (failureMode.length > MAX_FAILURE_MODE_CHARS) {
        reasons.push(`failure_mode is ${failureMode.length} chars, exceeds ${MAX_FAILURE_MODE_CHARS}: "${failureMode.slice(0, 80)}"`);
      }

      // implied_assumption must be a positive declarative belief.
      if (impliedAssumption === "") {
        reasons.push("implied_assumption empty or not a string");
      } else {
        if (impliedAssumption.endsWith("?")) {
          reasons.push("implied_assumption is a question (ends in '?')");
        }
        const lower = impliedAssumption.toLowerCase();
        const opener = ASSUMPTION_BANNED_OPENERS.find((o) => lower.startsWith(o));
        if (opener !== undefined) {
          reasons.push(`implied_assumption opens with "${opener.trim()}" — states an absence, not an assumption`);
        }
      }

      // proposed_queries: count and per-query word bounds.
      const q = c.proposed_queries;
      if (!Array.isArray(q)) {
        reasons.push(`proposed_queries is not an array (got ${typeof q})`);
      } else {
        if (q.length < MIN_QUERIES_PER_CANDIDATE || q.length > MAX_QUERIES_PER_CANDIDATE) {
          reasons.push(
            `proposed_queries has ${q.length} entries, outside ${MIN_QUERIES_PER_CANDIDATE}-${MAX_QUERIES_PER_CANDIDATE}`,
          );
        }
        for (let j = 0; j < q.length; j++) {
          const entry = q[j];
          if (typeof entry !== "string" || entry.trim() === "") {
            reasons.push(`proposed_queries[${j}] is empty or not a string`);
            continue;
          }
          const w = wordCount(entry);
          if (w < MIN_QUERY_WORDS || w > MAX_QUERY_WORDS) {
            reasons.push(
              `proposed_queries[${j}] has ${w} words, outside ${MIN_QUERY_WORDS}-${MAX_QUERY_WORDS}: "${entry.trim().slice(0, 80)}"`,
            );
          }
        }
      }

      // Query diversity: prune overlapping pairs, drop only if too few survive.
      if (Array.isArray(q) && reasons.length === 0) {
        const queryStrings = (q as unknown[]).map((e) => String(e).trim());
        const { pruned, prunedPairs } = pruneOverlappingQueries(queryStrings);
        if (prunedPairs.length > 0) {
          totalPrunedQueryCount += prunedPairs.length;
          allPrunedQueries.push(
            ...prunedPairs.map((p) => ({
              candidateIndex: i,
              failureMode: failureMode.slice(0, 80),
              kept: p.kept,
              dropped: p.dropped,
            })),
          );
          console.log(
            `${LOG_PREFIX} [${i}] "${failureMode.slice(0, 60)}": pruned ${prunedPairs.length} overlapping quer${prunedPairs.length === 1 ? "y" : "ies"}, ` +
              `${pruned.length} survive.`,
          );
        }
        if (pruned.length < MIN_QUERIES_PER_CANDIDATE) {
          reasons.push(
            `only ${pruned.length} queries survive after pruning ${prunedPairs.length} overlapping pair(s), ` +
              `minimum is ${MIN_QUERIES_PER_CANDIDATE}`,
          );
        } else {
          // Replace with pruned set for downstream insert.
          (c as Record<string, unknown>).proposed_queries = pruned;
        }
      }

      if (reasons.length > 0) {
        dropped.push({ index: i, failureMode: failureMode.slice(0, 160), reasons });
        continue;
      }

      const hash = candidateHash(failureMode);
      if (seenHashes.has(hash)) {
        // Not a drop-for-quality: the same mechanism twice in one response.
        // Collapsed here because ON CONFLICT DO UPDATE cannot touch one row
        // twice in a single statement.
        inBatchDuplicates.push({ index: i, failureMode: failureMode.slice(0, 160), candidateHash: hash });
        continue;
      }
      seenHashes.add(hash);

      // Guard: if pruning occurred, the property must reflect the pruned set.
      // A mismatch means the binding was broken — the diagnostic output would
      // attest to pruning that the persisted rows do not reflect.
      const queriesForInsert = ((c as Record<string, unknown>).proposed_queries as unknown[]);
      const prunedThisCandidate = allPrunedQueries.filter((p) => p.candidateIndex === i);
      if (prunedThisCandidate.length > 0) {
        const expectedLength = (q as unknown[]).length - prunedThisCandidate.length;
        if (queriesForInsert.length !== expectedLength) {
          throw new Error(
            `${LOG_PREFIX} PRUNING ASSERTION FAILED at candidate [${i}] "${failureMode.slice(0, 60)}": ` +
              `expected ${expectedLength} queries after pruning ${prunedThisCandidate.length}, ` +
              `but proposed_queries has ${queriesForInsert.length}. ` +
              "The insert array does not match the pruning diagnostics. No insert performed.",
          );
        }
      }

      accepted.push({
        failure_mode: failureMode,
        implied_assumption: impliedAssumption,
        hypothesis: hypothesis,
        rationale: rationaleRaw === "" ? null : rationaleRaw,
        proposed_queries: queriesForInsert.map((e) => String(e).trim()),
        candidate_hash: hash,
      });
    }

    console.log(
      `${LOG_PREFIX} validation: ${rawCandidateCount} returned, ${accepted.length} accepted, ` +
        `${dropped.length} dropped, ${inBatchDuplicates.length} in-batch duplicates collapsed.`,
    );
    for (const d of dropped) {
      console.warn(`${LOG_PREFIX} dropped [${d.index}] "${d.failureMode}": ${d.reasons.join("; ")}`);
    }

    if (accepted.length === 0) {
      throw new Error(
        `${LOG_PREFIX} no candidate survived validation (${rawCandidateCount} returned, ` +
          `${dropped.length} dropped, ${inBatchDuplicates.length} duplicates). No insert performed.`,
      );
    }

    // ── Step 7: upsert on the dedupe key ──────────────────────────────────
    const upserted = await ctx.integrations.db.query(
      `INSERT INTO bss_candidates (
         deal_id, profile_id, module_run_id, pass_type, failure_mode,
         implied_assumption, hypothesis, rationale, proposed_queries,
         candidate_hash, generation_model, prompt_hash
       )
       SELECT $1::uuid, $2::uuid, NULL::uuid, $3::text,
              t.failure_mode, t.implied_assumption, t.hypothesis, t.rationale,
              t.proposed_queries, t.candidate_hash, $4::text, $5::text
         FROM jsonb_to_recordset($6::jsonb) AS t(
                failure_mode text,
                implied_assumption text,
                hypothesis text,
                rationale text,
                proposed_queries jsonb,
                candidate_hash text
              )
       ON CONFLICT (deal_id, profile_id, pass_type, candidate_hash) DO UPDATE SET
         failure_mode = EXCLUDED.failure_mode,
         implied_assumption = EXCLUDED.implied_assumption,
         hypothesis = EXCLUDED.hypothesis,
         rationale = EXCLUDED.rationale,
         proposed_queries = EXCLUDED.proposed_queries,
         generation_model = EXCLUDED.generation_model,
         prompt_hash = EXCLUDED.prompt_hash,
         generated_at = now()
       RETURNING candidate_id, candidate_hash, (xmax = 0) AS inserted`,
      UpsertedRowSchema,
      [
        dealId,
        profileId,
        BLIND_PASS_TYPE,
        generationModel,
        promptHash,
        JSON.stringify(accepted),
      ],
      { label: "BSSGenerate: upsert blind candidates" },
    );

    const insertedCount = upserted.filter((r) => r.inserted).length;
    const updatedCount = upserted.length - insertedCount;
    console.log(
      `${LOG_PREFIX} upsert complete: ${upserted.length} rows touched — ` +
        `${insertedCount} inserted, ${updatedCount} updated.`,
    );

    return {
      success: true,
      dealId,
      profileId,
      profileVersion: profileRow.profile_version,
      passType: BLIND_PASS_TYPE,
      generationModel,
      modelReported: response.model,
      promptHash,
      promptChars,
      promptText: prompt,
      profileFieldsSent,
      leakageAssertionPassed,
      forbiddenKeysFound,
      rawCandidateCount,
      acceptedCount: accepted.length,
      droppedCount: dropped.length,
      dropped,
      inBatchDuplicates,
      prunedQueryCount: totalPrunedQueryCount,
      prunedQueries: allPrunedQueries,
      insertedCount,
      updatedCount,
      upsertedHashes: upserted.map((r) => r.candidate_hash),
      llmCallMs,
      stopReason: response.stop_reason,
      usage: response.usage,
    };
  },
});
