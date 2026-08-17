/**
 * P4 — OA Topic Assignment (Stage S2)
 *
 * Assigns each oa_fact to one topic from the seeded taxonomy (47 as of v1.1.0),
 * plus emergent topics discovered by the model during assignment.
 *
 * Uses compact numbered output format for throughput:
 *   Input: numbered taxonomy (1-N) + batch of 250 facts
 *   Output: comma-separated pairs "factIdx:topicNum" or "factIdx:E"
 *   Emergent: second block listing emergent labels per E-flagged fact
 *
 * Budget-guarded: yields cleanly when time runs low, resumable via checkpoints.
 *
 * Excludes gap/omission flags (chunk-local absence assertions) from assignment.
 *
 * Validator: any out-of-range topic number or inconsistent emergent reference
 * triggers a hard fail → retry once → checkpoint failed with reason.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import {
  SEEDED_TOPICS,
  OBLIGATION_CHECKLIST_VERSION,
  isSeededTopic,
} from "./oa-taxonomy.js";
import { classifyEmergentTopics } from "./oa-obligation.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const FACT_PAGE_SIZE = 5000;
const BATCH_SIZE = 250;

// Budget guard constants
const HARD_KILL_MS = 200_000;            // conservative: yield well before platform kill (~240s)
const SAFETY_MARGIN_MS = 45_000;         // do not start work inside this window
const DEFAULT_UNIT_DURATION_MS = 20_000; // conservative seed for first unit

// ---------------------------------------------------------------------------
// Numbered taxonomy — built once per invocation
// ---------------------------------------------------------------------------

function buildNumberedTaxonomy(): string {
  return SEEDED_TOPICS.map((t, i) => `  ${i + 1}. ${t.topic_id} | ${t.topic_label}`).join("\n");
}

// Map topic number (1-N) → topic_id
const TOPIC_NUM_TO_ID: Record<number, string> = {};
SEEDED_TOPICS.forEach((t, i) => { TOPIC_NUM_TO_ID[i + 1] = t.topic_id; });

// ---------------------------------------------------------------------------
// Compact prompt builder
// ---------------------------------------------------------------------------

function buildCompactPrompt(
  numberedTaxonomy: string,
  facts: Array<{
    batchIdx: number;
    fact_type: string;
    predicate: string | null;
    value: string | null;
    scope_qualifier: string;
    document_role: string;
  }>,
): string {
  const factLines = facts.map(
    (f) =>
      `${f.batchIdx}|${f.fact_type}|${f.predicate ?? "NULL"}|${f.value ?? "NULL"}|${f.scope_qualifier}|${f.document_role}`
  ).join("\n");

  return `Assign each fact to exactly ONE topic from the numbered list.

TOPICS:
${numberedTaxonomy}

NOT_MEMO_RELEVANT TOPICS (use freely — these are expected, not fallbacks):
  Topics ${SEEDED_TOPICS.length - 4}-${SEEDED_TOPICS.length} are for content that is NEVER compared against the IC memos.
  Routing facts to these is CORRECT and EXPECTED. Diligence reports contain a large volume of such content.
    adviser.methodology: adviser's approach, sampling, basis of review
    adviser.scope-limitations: engagement caveats, "we have not reviewed...", exclusions, reliance
    adviser.boilerplate: standard disclaimers, process notes, document lists, definitions
    document.formatting: headers, page artefacts, table structure noise
    entity.corporate-structure: share capital, registration, registered addresses, corporate history, governance
  NEVER propose an emergent topic whose meaning is already covered by a seeded topic.
  If content is adviser boilerplate, use the seeded boilerplate topic.

MAPPING CORRECTIONS (follow these before proposing emergent):
  Current transaction price, earn-out, deferred/contingent consideration → deal.price-mechanism (#2)
  Customer contract terms, change-of-control → risk.customer-contract (#20)
  Customer revenue data and concentration → revenue-quality.concentration (#12)
  Prior acquisition warranties, earn-outs, consideration → acquisition.historic-terms (#36)
  Channel/dealer/reseller agreements → partner.channel-agreements (#37)

EMERGENT DISCIPLINE:
  Propose E ONLY when no seeded topic covers the content.
  Before using E, check the numbered list again.
  An emergent rate above ~10% of a batch means you are under-using the taxonomy.

FACTS (index|type|predicate|value|scope|role):
${factLines}

OUTPUT FORMAT — comma-separated pairs, one per fact, NO spaces around colons:
  factIndex:topicNumber,factIndex:topicNumber,...

Use topic numbers 1-${SEEDED_TOPICS.length}. If no seeded topic fits, use E instead of a number.

Example: 0:10,1:10,2:14,3:22,4:E,5:3

If any facts are marked E, add a second line starting with "EMERGENT:" listing each emergent fact index and a proposed topic_id (lowercase dot-separated):
  EMERGENT: 4=cyber.incident-history, 12=operations.supply-chain

Rules:
- Every fact index (0 to ${facts.length - 1}) MUST appear exactly once.
- Assign the BEST matching seeded topic. Only use E if truly none fit.
- Return ONLY the pairs line (and EMERGENT line if needed). No other text.`;
}

// ---------------------------------------------------------------------------
// Compact response parser
// ---------------------------------------------------------------------------

interface ParsedAssignment {
  batchIdx: number;
  topicId: string;
  isEmergent: boolean;
}

function parseCompactResponse(
  rawText: string,
  batchSize: number,
): { assignments: ParsedAssignment[]; errors: string[]; hardFail: boolean } {
  const lines = rawText.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const assignments: ParsedAssignment[] = [];
  const errors: string[] = [];
  const N = SEEDED_TOPICS.length; // valid topic range 1..N

  // Parse emergent mapping first — collect indices that appear in EMERGENT line
  const emergentMap = new Map<number, string>();
  const emergentLine = lines.find(l => l.toUpperCase().startsWith("EMERGENT:"));
  if (emergentLine) {
    const content = emergentLine.slice("EMERGENT:".length).trim();
    const parts = content.split(",").map(p => p.trim());
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        const idx = parseInt(part.slice(0, eqIdx).trim(), 10);
        const topicId = part.slice(eqIdx + 1).trim();
        if (!isNaN(idx) && topicId) {
          emergentMap.set(idx, topicId);
        }
      }
    }
  }

  // Parse main pairs line (first non-EMERGENT line)
  const pairsLine = lines.find(l => !l.toUpperCase().startsWith("EMERGENT:"));
  if (!pairsLine) {
    errors.push("No pairs line found in response");
    return { assignments, errors, hardFail: true };
  }

  // Collect indices that appear with numeric topic assignments (not E)
  const numericAssignedIndices = new Set<number>();
  // Collect indices that appear with E
  const emergentAssignedIndices = new Set<number>();

  const pairs = pairsLine.split(",").map(p => p.trim()).filter(p => p.length > 0);
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx < 0) {
      errors.push(`Invalid pair format: "${pair}"`);
      continue;
    }
    const idxStr = pair.slice(0, colonIdx).trim();
    const valStr = pair.slice(colonIdx + 1).trim();
    const batchIdx = parseInt(idxStr, 10);

    if (isNaN(batchIdx) || batchIdx < 0 || batchIdx >= batchSize) {
      errors.push(`Invalid fact index: ${idxStr}`);
      continue;
    }

    if (valStr.toUpperCase() === "E") {
      emergentAssignedIndices.add(batchIdx);
      const emergentId = emergentMap.get(batchIdx) ?? `emergent.unspecified-${batchIdx}`;
      assignments.push({ batchIdx, topicId: emergentId, isEmergent: true });
    } else {
      const topicNum = parseInt(valStr, 10);
      if (isNaN(topicNum) || topicNum < 1 || topicNum > N) {
        // HARD FAIL: out-of-range topic number
        errors.push(`HARD FAIL: topic number ${valStr} out of range 1..${N} for fact ${batchIdx}`);
        return { assignments: [], errors, hardFail: true };
      }
      numericAssignedIndices.add(batchIdx);
      const mapped = TOPIC_NUM_TO_ID[topicNum];
      if (!mapped) {
        errors.push(`HARD FAIL: topic number ${topicNum} has no mapping`);
        return { assignments: [], errors, hardFail: true };
      }
      assignments.push({ batchIdx, topicId: mapped, isEmergent: false });
    }
  }

  // HARD FAIL: any index appears in BOTH numeric assignments AND emergent map
  // (An index with a numeric topic must not also be defined in the EMERGENT line)
  for (const idx of numericAssignedIndices) {
    if (emergentMap.has(idx)) {
      errors.push(`HARD FAIL: fact index ${idx} appears with numeric topic AND in EMERGENT line`);
      return { assignments: [], errors, hardFail: true };
    }
  }

  // HARD FAIL: any index in EMERGENT map that was not assigned as E in main pairs
  for (const idx of emergentMap.keys()) {
    if (!emergentAssignedIndices.has(idx)) {
      errors.push(`HARD FAIL: fact index ${idx} in EMERGENT line but not assigned E in pairs`);
      return { assignments: [], errors, hardFail: true };
    }
  }

  return { assignments, errors, hardFail: false };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

interface FactRow {
  fact_id: string;
  fact_type: string;
  predicate: string | null;
  value: string | null;
  scope_qualifier: string;
  document_role: string;
  document_id: string;
}

// ---------------------------------------------------------------------------
// Per-batch topic_facts writer (FIX 1)
// ---------------------------------------------------------------------------

async function writeBatchTopicFacts(
  db: any,
  runId: string,
  batchAssignments: Array<{ fact_id: string; topic_id: string }>,
  allFacts: FactRow[],
  batchLabel: string,
): Promise<void> {
  if (batchAssignments.length === 0) return;
  const factRoleLookup = new Map<string, string>();
  for (const f of allFacts) {
    factRoleLookup.set(f.fact_id, f.document_role);
  }
  // Insert in sub-batches of 50 for param limits
  for (let i = 0; i < batchAssignments.length; i += 50) {
    const chunk = batchAssignments.slice(i, i + 50);
    const values: string[] = [];
    const params: any[] = [runId];
    let paramIdx = 2;
    for (const a of chunk) {
      const factRole = factRoleLookup.get(a.fact_id) ?? "reference";
      values.push(`($1, $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`);
      params.push(a.topic_id, a.fact_id, factRole);
      paramIdx += 3;
    }
    await db.query(
      `INSERT INTO oa_topic_facts (run_id, topic_id, fact_id, fact_role)
       VALUES ${values.join(", ")}
       ON CONFLICT (run_id, topic_id, fact_id) DO NOTHING`,
      z.any(),
      params,
      { label: `Write topic_facts batch ${batchLabel} [${i}..${i + chunk.length}]` }
    );
  }
}

// Ensure emergent topics exist in oa_topics before FK write
async function ensureEmergentTopics(
  db: any,
  runId: string,
  dealId: string,
  emergentAssignments: ParsedAssignment[],
): Promise<void> {
  if (emergentAssignments.length === 0) return;
  const seen = new Set<string>();
  for (const a of emergentAssignments) {
    if (seen.has(a.topicId)) continue;
    seen.add(a.topicId);
    await db.query(
      `INSERT INTO oa_topics (run_id, topic_id, deal_id, topic_label, parent_topic_id, obligation_class, obligation_basis, checklist_version)
       VALUES ($1, $2, $3, $4, NULL, 'optional', 'model_proposed_unclassified', $5)
       ON CONFLICT (run_id, topic_id) DO NOTHING`,
      z.any(),
      [runId, a.topicId, dealId, a.topicId.replace(/[.\-_]/g, " "), OBLIGATION_CHECKLIST_VERSION],
      { label: `Ensure emergent topic: ${a.topicId}` }
    );
  }
}

const FactRowSchema = z.object({
  fact_id: z.string(),
  fact_type: z.string(),
  predicate: z.string().nullable(),
  value: z.string().nullable(),
  scope_qualifier: z.string(),
  document_role: z.string(),
  document_id: z.string(),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaTopicAssignment",
  description: "Assigns oa_facts to topics via compact batched LLM calls (250 facts/batch)",
  integrations: {
    db: postgres(DB_ID),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    reset: z.boolean().optional().default(false),
    maxBatches: z.number().optional(), // for testing: limit number of batches to process
    testDocumentId: z.string().optional(), // for testing: only load facts from this document
    startOffset: z.number().optional(), // for testing: skip N facts before batching (probe mid-document)
    repairUnitKeys: z.array(z.string()).optional(), // repair mode: delete only these failed checkpoints then re-process them
  }),
  output: z.object({
    status: z.enum(["complete", "in_progress"]),
    batches_completed: z.number(),
    batches_remaining: z.number(),
    report: z.record(z.string(), z.any()).optional(),
  }),

  async run(ctx, { dealId, runId, reset, maxBatches, testDocumentId, startOffset, repairUnitKeys }) {
    const { db } = ctx.integrations;
    const aiFn: AiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as any;

    // Budget guard: start clock immediately
    const invocationStart = Date.now();
    const timeRemaining = () => HARD_KILL_MS - (Date.now() - invocationStart);
    const unitDurations: number[] = [];
    const estimatedUnitDuration = () =>
      unitDurations.length > 0
        ? unitDurations.reduce((a, b) => a + b, 0) / unitDurations.length
        : DEFAULT_UNIT_DURATION_MS;

    // ─── RESET ──────────────────────────────────────────────────────────
    let resetCounts: { topic_facts: number; topics: number; checkpoints: number } | null = null;
    if (reset) {
      const delTf = await db.query(
        `WITH deleted AS (DELETE FROM oa_topic_facts WHERE run_id = $1 RETURNING 1) SELECT COUNT(*) as cnt FROM deleted`,
        z.object({ cnt: z.coerce.number() }), [runId],
        { label: "Reset: delete oa_topic_facts" }
      );
      const delTopics = await db.query(
        `WITH deleted AS (DELETE FROM oa_topics WHERE run_id = $1 RETURNING 1) SELECT COUNT(*) as cnt FROM deleted`,
        z.object({ cnt: z.coerce.number() }), [runId],
        { label: "Reset: delete oa_topics" }
      );
      const delCp = await db.query(
        `WITH deleted AS (DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment' RETURNING 1) SELECT COUNT(*) as cnt FROM deleted`,
        z.object({ cnt: z.coerce.number() }), [runId],
        { label: "Reset: delete checkpoints" }
      );
      resetCounts = {
        topic_facts: delTf[0]?.cnt ?? 0,
        topics: delTopics[0]?.cnt ?? 0,
        checkpoints: delCp[0]?.cnt ?? 0,
      };
      console.log(`[P4] Reset complete for run ${runId}: topic_facts=${resetCounts.topic_facts}, topics=${resetCounts.topics}, checkpoints=${resetCounts.checkpoints}`);
    }

    // ─── REPAIR MODE: delete only specific failed checkpoints ────────────
    if (repairUnitKeys && repairUnitKeys.length > 0) {
      for (const uk of repairUnitKeys) {
        await db.query(
          `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment' AND unit_key = $2`,
          z.any(), [runId, uk],
          { label: `Repair: delete checkpoint ${uk}` }
        );
      }
      console.log(`[P4] Repair: deleted ${repairUnitKeys.length} failed checkpoints: ${repairUnitKeys.join(', ')}`);
    }

    // ─── A1: Seed oa_topics (batched) ─────────────────────────────────────
    const SEED_BATCH_SIZE = 10;
    for (let si = 0; si < SEEDED_TOPICS.length; si += SEED_BATCH_SIZE) {
      const batch = SEEDED_TOPICS.slice(si, si + SEED_BATCH_SIZE);
      const values: string[] = [];
      const params: any[] = [runId, dealId, OBLIGATION_CHECKLIST_VERSION];
      let pIdx = 4;
      for (const t of batch) {
        values.push(`($1, $${pIdx}, $2, $${pIdx + 1}, $${pIdx + 2}, $${pIdx + 3}, $${pIdx + 4}, $3)`);
        params.push(t.topic_id, t.topic_label, t.parent_topic_id, t.obligation_class, t.obligation_basis);
        pIdx += 5;
      }
      await db.query(
        `INSERT INTO oa_topics (run_id, topic_id, deal_id, topic_label, parent_topic_id, obligation_class, obligation_basis, checklist_version)
         VALUES ${values.join(", ")}
         ON CONFLICT (run_id, topic_id) DO NOTHING`,
        z.any(),
        params,
        { label: `Seed topics batch ${Math.floor(si / SEED_BATCH_SIZE)}` }
      );
    }
    console.log(`[P4] Seeded ${SEEDED_TOPICS.length} topics`);

    // ─── A2: Load facts — EXCLUDING gap/omission flags ───────────────────
    const allFacts: FactRow[] = [];
    let excludedCount = 0;

    if (testDocumentId) {
      // Test mode: only load facts from the specified document
      let offset = 0;
      while (true) {
        const page = await db.query(
          `SELECT fact_id, fact_type, predicate, value, scope_qualifier, document_role, document_id
           FROM oa_facts
           WHERE deal_id = $1 AND document_id = $2
             AND NOT (fact_type = 'flag' AND source_metadata->>'type' IN ('gap', 'omission'))
           ORDER BY fact_id
           LIMIT $3 OFFSET $4`,
          FactRowSchema,
          [dealId, testDocumentId, FACT_PAGE_SIZE, offset],
          { label: `Load test doc facts offset=${offset}` }
        );
        if (page.length === 0) break;
        allFacts.push(...page);
        offset += page.length;
        if (page.length < FACT_PAGE_SIZE) break;
      }
    } else {
      // Normal mode: load all facts subject-first then reference
      for (const role of ["subject", "reference"]) {
        let offset = 0;
        while (true) {
          const page = await db.query(
            `SELECT fact_id, fact_type, predicate, value, scope_qualifier, document_role, document_id
             FROM oa_facts
             WHERE deal_id = $1 AND document_role = $2
               AND NOT (fact_type = 'flag' AND source_metadata->>'type' IN ('gap', 'omission'))
             ORDER BY document_id, fact_id
             LIMIT $3 OFFSET $4`,
            FactRowSchema,
            [dealId, role, FACT_PAGE_SIZE, offset],
            { label: `Load ${role} facts offset=${offset}` }
          );
          if (page.length === 0) break;
          allFacts.push(...page);
          offset += page.length;
          if (page.length < FACT_PAGE_SIZE) break;
        }
      }
    }
    // Count excluded for reporting
    const excludedRows = await db.query(
      `SELECT COUNT(*) as cnt FROM oa_facts
       WHERE deal_id = $1 AND fact_type = 'flag' AND source_metadata->>'type' IN ('gap', 'omission')`,
      z.object({ cnt: z.coerce.number() }),
      [dealId],
      { label: "Count excluded gap/omission flags" }
    );
    excludedCount = excludedRows[0]?.cnt ?? 0;
    console.log(`[P4] Loaded ${allFacts.length} facts, excluded ${excludedCount} gap/omission flags. Setup: ${Date.now() - invocationStart}ms`);

    // Apply startOffset for mid-document probing
    const factsToProcess = startOffset ? allFacts.slice(startOffset) : allFacts;
    if (startOffset) {
      console.log(`[P4] startOffset=${startOffset}: processing facts ${startOffset}-${startOffset + factsToProcess.length - 1} of ${allFacts.length}`);
    }

    // ─── A2+: Batch LLM calls ────────────────────────────────────────────
    const numberedTaxonomy = buildNumberedTaxonomy();
    const emergentTopicIds = new Set<string>();
    let batchOrdinal = 0;
    let llmCalls = 0;
    let batchesSkipped = 0;
    let yieldedForBudget = false;
    let rawOutputSample: string | null = null; // capture first batch output

    // Group facts by document for checkpoint tracking
    let currentDocId = "";
    let docBatchOrdinal = 0;
    const totalBatches = Math.ceil(factsToProcess.length / BATCH_SIZE);

    for (let i = 0; i < factsToProcess.length; i += BATCH_SIZE) {
      const batch = factsToProcess.slice(i, i + BATCH_SIZE);
      batchOrdinal++;

      // Respect maxBatches limit for testing
      if (maxBatches && llmCalls >= maxBatches) {
        yieldedForBudget = true;
        console.log(`[P4] Hit maxBatches limit (${maxBatches}), yielding`);
        break;
      }

      // Track document transitions
      const batchDocId = batch[0].document_id;
      if (batchDocId !== currentDocId) {
        currentDocId = batchDocId;
        docBatchOrdinal = 0;
      }
      docBatchOrdinal++;

      // Check checkpoint
      const unitKey = `${currentDocId}:${docBatchOrdinal}`;
      const existing = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment' AND unit_key = $2`,
        z.any(),
        [runId, unitKey],
        { label: `Check checkpoint ${unitKey}` }
      );
      if (existing.length > 0) {
        batchesSkipped++;
        continue;
      }

      // ─── BUDGET GUARD ─────────────────────────────────────────────────
      const remaining = timeRemaining();
      const estUnit = estimatedUnitDuration();
      if (remaining < SAFETY_MARGIN_MS + estUnit) {
        console.log(`[P4] YIELDING FOR BUDGET: ${remaining}ms remaining, est unit ${estUnit.toFixed(0)}ms`);
        yieldedForBudget = true;
        break;
      }

      // Build compact prompt
      const promptFacts = batch.map((f, idx) => ({
        batchIdx: idx,
        fact_type: f.fact_type,
        predicate: f.predicate ? f.predicate.slice(0, 200) : null,
        value: f.value ? f.value.slice(0, 200) : null,
        scope_qualifier: f.scope_qualifier,
        document_role: f.document_role,
      }));

      const prompt = buildCompactPrompt(numberedTaxonomy, promptFacts);

      // LLM call (timed for budget guard rolling average)
      const unitStart = Date.now();
      const response = await aiFn(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          },
        },
        { response: z.any() },
        { label: `Topic assignment batch ${batchOrdinal}` }
      );
      llmCalls++;

      // Parse response (Anthropic Messages format)
      const textBlock = response?.content?.find((c: any) => c.type === "text");
      const rawText: string = textBlock?.text ?? "";

      // Capture first batch output for diagnostic
      if (rawOutputSample === null) {
        rawOutputSample = rawText;
      }

      // Parse compact format
      const { assignments: parsed, errors, hardFail } = parseCompactResponse(rawText, batch.length);

      if (errors.length > 0) {
        console.warn(`[P4] Batch ${batchOrdinal} parse errors (${errors.length}):`, errors.slice(0, 5).join("; "));
      }

      // Capture stop_reason for diagnostic
      const stopReason = response?.stop_reason ?? response?.stop ?? null;

      // RETRY condition: hardFail OR fewer than 50% of expected assignments
      const needsRetry = hardFail || parsed.length < batch.length * 0.5;
      if (needsRetry) {
        console.warn(`[P4] Batch ${batchOrdinal}: ${hardFail ? "HARD FAIL" : `only ${parsed.length}/${batch.length} parsed`}. Retrying...`);
        const retryResponse = await aiFn(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: "claude-sonnet-4-6",
              max_tokens: 4096,
              temperature: 0,
              messages: [{ role: "user", content: prompt }],
            },
          },
          { response: z.any() },
          { label: `Topic assignment batch ${batchOrdinal} RETRY` }
        );
        llmCalls++;

        const retryTextBlock = retryResponse?.content?.find((c: any) => c.type === "text");
        const retryRawText: string = retryTextBlock?.text ?? "";
        const retryResult = parseCompactResponse(retryRawText, batch.length);
        const retryStopReason = retryResponse?.stop_reason ?? retryResponse?.stop ?? null;

        if (!retryResult.hardFail && retryResult.assignments.length >= batch.length * 0.5) {
          // Use retry result — it passed validation
          // FIX 3: Compute missing indices (soft check, no hard fail)
          const assignedIdxs = new Set(retryResult.assignments.map(a => a.batchIdx));
          const missingIndices: number[] = [];
          for (let j = 0; j < batch.length; j++) {
            if (!assignedIdxs.has(j)) missingIndices.push(j);
          }
          if (missingIndices.length > 0) {
            console.warn(`[P4] Batch ${batchOrdinal} (retry): ${missingIndices.length} missing indices — unassigned, not defaulted`);
          }

          // FIX 1: Write oa_topic_facts for this batch BEFORE checkpoint
          const batchAssignments = retryResult.assignments.map(a => ({
            fact_id: batch[a.batchIdx].fact_id,
            topic_id: a.topicId,
          }));
          for (const a of retryResult.assignments) {
            if (a.isEmergent) emergentTopicIds.add(a.topicId);
          }
          // Ensure emergent topics exist in oa_topics before FK write
          await ensureEmergentTopics(db, runId, dealId, retryResult.assignments.filter(a => a.isEmergent));
          await writeBatchTopicFacts(db, runId, batchAssignments, allFacts, `${batchOrdinal}-retry`);

          // Write checkpoint with missing_indices metadata
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
             VALUES ($1, 'topic_assignment', $2, 'complete', $3::jsonb)
             ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'complete', payload_json = $3::jsonb`,
            z.any(),
            [runId, unitKey, JSON.stringify({
              assigned: batchAssignments.length,
              missing_indices: missingIndices,
              batch_size: batch.length,
              stop_reason: retryStopReason,
              attempt: "retry",
            })],
            { label: `Checkpoint ${unitKey} (retry success)` }
          );
        } else {
          // FIX 2: Both attempts failed — persist full diagnostic
          const allErrors = [...errors, ...(retryResult.errors || [])];
          const failReason = hardFail ? "hard_fail_validation" : "parse_failure";
          console.warn(`[P4] BATCH FAILED (${failReason}) unit_key=${unitKey}: ${allErrors.slice(0, 5).join("; ")}`);
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, reason, payload_json)
             VALUES ($1, 'topic_assignment', $2, 'failed', $3, $4::jsonb)
             ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'failed', reason = $3, payload_json = $4::jsonb`,
            z.any(),
            [runId, unitKey, allErrors[0] ?? failReason, JSON.stringify({
              raw_model_output: rawText,
              retry_model_output: retryRawText,
              errors: allErrors,
              batch_size: batch.length,
              first_fact_id: batch[0].fact_id,
              stop_reason: stopReason,
              retry_stop_reason: retryStopReason,
            })],
            { label: `Checkpoint FAILED ${unitKey}` }
          );
          // FIX 4: NO dd.coverage default. Unassigned facts get no row.
          unitDurations.push(Date.now() - unitStart);
          continue;
        }
      } else {
        // Normal path: map assignments
        // FIX 3: Compute missing indices (soft check)
        const assignedIdxs = new Set(parsed.map(a => a.batchIdx));
        const missingIndices: number[] = [];
        for (let j = 0; j < batch.length; j++) {
          if (!assignedIdxs.has(j)) missingIndices.push(j);
        }
        if (missingIndices.length > 0) {
          console.warn(`[P4] Batch ${batchOrdinal}: ${missingIndices.length} missing indices — unassigned, not defaulted`);
        }

        // Collect emergent topics
        for (const a of parsed) {
          if (a.isEmergent) emergentTopicIds.add(a.topicId);
        }

        // FIX 1: Write oa_topic_facts for this batch BEFORE checkpoint
        const batchAssignments = parsed.map(a => ({
          fact_id: batch[a.batchIdx].fact_id,
          topic_id: a.topicId,
        }));
        // Ensure emergent topics exist in oa_topics before FK write
        await ensureEmergentTopics(db, runId, dealId, parsed.filter(a => a.isEmergent));
        await writeBatchTopicFacts(db, runId, batchAssignments, allFacts, `${batchOrdinal}`);

        // Write checkpoint with metadata
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
           VALUES ($1, 'topic_assignment', $2, 'complete', $3::jsonb)
           ON CONFLICT (run_id, stage, unit_key) DO UPDATE SET status = 'complete', payload_json = $3::jsonb`,
          z.any(),
          [runId, unitKey, JSON.stringify({
            assigned: batchAssignments.length,
            missing_indices: missingIndices,
            batch_size: batch.length,
            stop_reason: stopReason,
            attempt: "first",
          })],
          { label: `Checkpoint ${unitKey}` }
        );
      }

      // Record unit duration for budget guard
      const unitDuration = Date.now() - unitStart;
      unitDurations.push(unitDuration);
      console.log(`[P4] Batch ${batchOrdinal} complete: ${unitDuration}ms, ${parsed.length}/${batch.length} assigned`);
    }

    console.log(`[P4] ${llmCalls} LLM calls, ${emergentTopicIds.size} emergent topics, ${batchesSkipped} skipped`);

    // ─── BUDGET YIELD: early return if yielded ──────────────────────────
    if (yieldedForBudget) {
      const completedCheckpoints = await db.query(
        `SELECT COUNT(*) as cnt FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'topic_assignment' AND status = 'complete'`,
        z.object({ cnt: z.coerce.number() }), [runId], { label: "Count completed batches" }
      );
      const completed = completedCheckpoints[0]?.cnt ?? 0;
      return {
        status: "in_progress" as const,
        batches_completed: completed,
        batches_remaining: totalBatches - completed,
        report: {
          message: "Yielded for budget — re-invoke to resume",
          run_id: runId,
          llm_calls_this_invocation: llmCalls,
          avg_unit_ms: unitDurations.length > 0 ? Math.round(unitDurations.reduce((a, b) => a + b, 0) / unitDurations.length) : null,
          raw_output_sample: rawOutputSample,
          excluded_gap_omission: excludedCount,
          reset_counts: resetCounts,
        },
      };
    }

    // ─── A2+: Classify and insert emergent topics ─────────────────────────
    if (emergentTopicIds.size > 0) {
      const emergentList = Array.from(emergentTopicIds).map((id) => ({
        topic_id: id,
        topic_label: id.replace(/[.\-_]/g, " "),
      }));

      const classified = await classifyEmergentTopics(emergentList, aiFn, invocationStart);

      for (const c of classified) {
        if (isSeededTopic(c.topic_id)) continue;
        await db.query(
          `INSERT INTO oa_topics (run_id, topic_id, deal_id, topic_label, parent_topic_id, obligation_class, obligation_basis, checklist_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (run_id, topic_id) DO UPDATE SET
             parent_topic_id = EXCLUDED.parent_topic_id,
             obligation_class = EXCLUDED.obligation_class,
             obligation_basis = EXCLUDED.obligation_basis`,
          z.any(),
          [runId, c.topic_id, dealId, c.topic_id.replace(/[.\-_]/g, " "), c.parent_topic_id, c.obligation_class, c.obligation_basis, OBLIGATION_CHECKLIST_VERSION],
          { label: `Classify emergent topic: ${c.topic_id}` }
        );
      }
      console.log(`[P4] Inserted ${emergentTopicIds.size} emergent topics`);
    }

    // ─── FIX 1: oa_topic_facts already written per-batch inside the loop ──
    // No bulk insert needed here. Query T-metrics directly from persisted data.

    // ─── A3: Clustering integrity probes ──────────────────────────────────
    // T1: Total distinct topics assigned
    const t1 = await db.query(
      `SELECT COUNT(DISTINCT topic_id) as cnt FROM oa_topic_facts WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "T1: distinct topics" }
    );

    // T2: Fact coverage — facts with at least one topic assignment
    const t2 = await db.query(
      `SELECT COUNT(DISTINCT fact_id) as assigned FROM oa_topic_facts WHERE run_id = $1`,
      z.object({ assigned: z.coerce.number() }),
      [runId],
      { label: "T2: assigned facts" }
    );

    // T3: Topic fact counts — ALL topics including not_memo_relevant
    const t3 = await db.query(
      `SELECT t.topic_id, t.obligation_class, COALESCE(tf.fact_count, 0) as fact_count
       FROM oa_topics t
       LEFT JOIN (
         SELECT topic_id, COUNT(*) as fact_count
         FROM oa_topic_facts WHERE run_id = $1
         GROUP BY topic_id
       ) tf ON tf.topic_id = t.topic_id
       WHERE t.run_id = $1
       ORDER BY fact_count DESC`,
      z.object({ topic_id: z.string(), obligation_class: z.string(), fact_count: z.coerce.number() }),
      [runId],
      { label: "T3: all topic fact counts" }
    );

    // T4: Top 5 topics by fact count
    const t4 = t3.slice(0, 5);

    // T5: Topics with zero facts
    const t5 = t3.filter((r) => r.fact_count === 0).map((r) => r.topic_id);

    // T6: Emergent topic count
    const t6emergent = emergentTopicIds.size;

    // T7: Churn facts on revenue-quality.churn — full rows, NO LIMIT
    const t7 = await db.query(
      `SELECT tf.fact_id, f.document_name, f.document_role, f.memo_order,
              f.predicate, f.value, f.scope_qualifier, f.period, f.fact_type
       FROM oa_topic_facts tf
       JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
       WHERE tf.run_id = $1 AND tf.topic_id = 'revenue-quality.churn'
       ORDER BY f.document_role DESC, f.document_name`,
      z.object({
        fact_id: z.string(),
        document_name: z.string().nullable(),
        document_role: z.string(),
        memo_order: z.coerce.number().nullable(),
        predicate: z.string().nullable(),
        value: z.string().nullable(),
        scope_qualifier: z.string(),
        period: z.string().nullable(),
        fact_type: z.string(),
      }),
      [runId, dealId],
      { label: "T7: churn co-location full rows (no limit)" }
    );

    // T3 subset: not_memo_relevant topics specifically
    const t3_not_memo = t3.filter((r) => r.obligation_class === "not_memo_relevant");

    const report = {
      T1_distinct_topics: t1[0]?.cnt ?? 0,
      T2_facts_assigned: t2[0]?.assigned ?? 0,
      T2_total_facts_loaded: allFacts.length,
      T2_excluded_gap_omission: excludedCount,
      T3_all_topics: t3,
      T3_not_memo_relevant: t3_not_memo,
      T4_top5: t4,
      T5_zero_fact_topics: t5,
      T6_emergent_topics: t6emergent,
      T7_churn_facts: t7,
      llm_calls: llmCalls,
      raw_output_sample: rawOutputSample,
    };

    console.log("[P4] REPORT:", JSON.stringify(report, null, 2));
    return { status: "complete" as const, batches_completed: totalBatches, batches_remaining: 0, report };
  },
});
