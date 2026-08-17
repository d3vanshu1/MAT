/**
 * P7 — OA Materiality Assessment
 *
 * Updates existing oa_findings rows (inserted by P6) with materiality_tier and materiality_basis.
 * Also reads probe results from D1 to enforce fail-closed rule.
 *
 * Deal config (SCG):
 * - EV = £655m → 1% = £6.55m (Tier 1 quantified threshold)
 * - Run-rate EBITDA = £55m → 5% = £2.75m (Tier 1 EBITDA threshold)
 * - Tier 2 range: 0.25%–1% of EV = £1.6375m–£6.55m
 *
 * TIERING — evaluate in order, first match wins:
 *
 * TIER 1:
 *   1. adviser_severity_max = 'high' AND verified quantified impact present
 *   2. Verified quantified impact >= £6.55m (EV threshold only — no EBITDA branch)
 *   3. obligation_class='required' AND gap_kind='not_disclosed' AND probe ran and returned nothing
 *   4. Gap touches a deal.* or returns.* topic
 *   5. Gap contradicts a stated investment-thesis pillar (not implemented — requires pillar list)
 *
 * TIER 2:
 *   1. adviser_severity_max = 'medium'
 *   2. Quantified impact between 0.25% and 1% of EV (£1.6375m–£6.55m)
 *   3. obligation_class='conditional' AND gap_kind='not_disclosed'
 *   4. gap_kind='unreconciled_divergence' on a required topic
 *
 * TIER 3: everything else, and AUTOMATICALLY when:
 *   1. adviser_severity_max='low' AND any adviser_disposition contains 'for information only'
 *   2. No quantification available and all reference facts are qualitative
 *   3. obligation_class='optional'
 *
 * ADVISER SEVERITY ASYMMETRY:
 *   'low' + 'for information only' → CAPS at Tier 3
 *   'low' alone → CAPS at Tier 3
 *   'medium' → FLOORS at Tier 2 (does not force Tier 1)
 *   'high' → FLOORS at Tier 2 (does not force Tier 1)
 *   NULL → no effect
 *
 * OVERRIDE: 'low'-rated item may exceed Tier 3 ONLY if it independently satisfies Tier 1 rule 2.
 *   materiality_basis = "adviser_low_overridden_by_quantified_impact"
 *
 * FAIL CLOSED: absence_basis='probe_not_run' → CAPS at Tier 3 always.
 *
 * Report: M1-M8 + C1-C3
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Deal config (SCG) — stored here, not hard-coded in tier logic
// ---------------------------------------------------------------------------
const DEAL_CONFIG = {
  ev_gbp: 655_000_000,
  ebitda_gbp: 55_000_000,
  tier1_ev_pct: 0.01,        // 1% of EV = £6.55m
  tier1_ebitda_pct: 0.05,    // 5% of EBITDA = £2.75m
  tier2_low_pct: 0.0025,     // 0.25% of EV = £1.6375m
  tier2_high_pct: 0.01,      // 1% of EV = £6.55m (same as tier1 threshold)
} as const;

const TIER1_THRESHOLD_GBP = DEAL_CONFIG.ev_gbp * DEAL_CONFIG.tier1_ev_pct;     // £6.55m
// EBITDA branch removed per user directive — EV threshold only
const TIER2_LOW_GBP = DEAL_CONFIG.ev_gbp * DEAL_CONFIG.tier2_low_pct;          // £1.6375m

// Budget guard constants
const HARD_KILL_MS = 200_000;
const SAFETY_MARGIN_MS = 45_000;
const DEFAULT_UNIT_DURATION_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AiFn = (
  req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> },
  opts: { response: z.ZodType<any> },
  meta?: { label: string }
) => Promise<any>;

const FindingRow = z.object({
  finding_id: z.string(),
  topic_id: z.string(),
  gap_kind: z.string(),
  absence_basis: z.string().nullable(),
  reference_evidence: z.any(),
  subject_evidence: z.any(),
  narrative: z.string().nullable(),
});

const TopicObligationRow = z.object({
  obligation_class: z.string(),
});

const AdviserInfoRow = z.object({
  max_severity: z.coerce.number().nullable(),
  has_fio: z.coerce.boolean(),
});

// ---------------------------------------------------------------------------
// Prompt builder — materiality impact extraction (NOT estimation)
// ---------------------------------------------------------------------------

function buildMaterialityPrompt(
  topicId: string,
  gapKind: string,
  referenceEvidence: Array<{ fact_id?: string; predicate?: string; value?: string }>,
  narrative: string | null,
): string {
  const evidenceLines = (referenceEvidence || []).slice(0, 50).map((e: any, i: number) =>
    `  [${i}] fact_id=${e?.fact_id ?? "NULL"} | predicate=${e?.predicate ?? "NULL"} | value=${e?.value ?? "NULL"}`
  ).join("\n");

  return `You are checking whether any cited evidence contains a monetary figure that quantifies THIS due-diligence gap.

DEAL CONTEXT:
- Enterprise Value: £655m
- Tier 1 threshold: verified quantified impact >= £6.55m (1% of EV)
- Tier 2 threshold: £1.6375m to £6.55m (0.25% to 1% of EV)
- Tier 3: below £1.6375m or no quantifying figure

FINDING:
- Topic: ${topicId}
- Gap kind: ${gapKind}
- Narrative: ${narrative ?? "N/A"}

CITED EVIDENCE (each has a fact_id):
${evidenceLines || "  (none)"}

TASK: Identify whether the cited evidence contains a monetary figure that quantifies THIS gap.

Do NOT estimate. Do NOT infer. Do NOT compute. Do NOT aggregate figures.
Do NOT apply a percentage to enterprise value or EBITDA.
Do NOT add figures together. Do NOT subtract one figure from another.

Return a figure ONLY if it appears in the text of a cited fact AND that
figure describes the exposure created by this specific gap.

You must return the fact_id you took it from.

If no cited fact carries a figure that quantifies this gap, return
estimated_impact_gbp: null and impact_basis: "no quantifying figure in
evidence". That is a correct and expected answer.

A figure that appears on this topic but describes a different matter is NOT
a quantification of this gap. Do not use it.

Respond with JSON:
{
  "estimated_impact_gbp": <number or null if no qualifying figure>,
  "source_fact_id": "<uuid of the fact containing the figure, or null>",
  "impact_basis": "<one sentence: either cite the fact text or state 'no quantifying figure in evidence'>",
  "tier_recommendation": 1 | 2 | 3,
  "basis": "<one sentence explaining the tier assignment>"
}

Rules:
- No quantifying figure → estimated_impact_gbp: null, tier_recommendation: 3
- Verified figure >= £6.55m → tier_recommendation: 1
- Verified figure £1.6375m to £6.55m → tier_recommendation: 2
- Verified figure below £1.6375m → tier_recommendation: 3
- Be conservative: if uncertain whether a figure describes THIS gap, return null
- Return ONLY valid JSON. No markdown fences.

SCOPE CONSTRAINT:
You see only the facts assigned to THIS topic. Never assert that the memos are
silent on a subject or that a matter is absent from the memos entirely.`;
}

// ---------------------------------------------------------------------------
// Tier assignment engine — applies all rules in priority order
// ---------------------------------------------------------------------------

interface TierInput {
  topicId: string;
  gapKind: string;
  absenceBasis: string | null;
  obligationClass: string;
  adviserSeverityMax: string | null;
  hasForInfoOnly: boolean;
  probeRan: boolean;
  llmTier: number;
  estimatedImpact: number | null;
  referenceFactCount: number;
}

interface TierOutput {
  tier: number;
  basis: string;
}

function assignTier(input: TierInput): TierOutput {
  const {
    topicId, gapKind, absenceBasis, obligationClass,
    adviserSeverityMax, hasForInfoOnly, probeRan,
    llmTier, estimatedImpact, referenceFactCount,
  } = input;

  // ─── FAIL CLOSED: probe_not_run always caps at Tier 3 ──────────────────
  if (absenceBasis === "probe_not_run") {
    return { tier: 3, basis: "FAIL CLOSED: absence_basis=probe_not_run caps at Tier 3" };
  }

  // ─── Adviser severity 'low' caps at Tier 3 (with one override) ─────────
  const adviserLow = adviserSeverityMax === "low";
  if (adviserLow) {
    // Override: 'low' may exceed Tier 3 ONLY if independently satisfies Tier 1 rule 2 (EV only)
    if (estimatedImpact != null && estimatedImpact >= TIER1_THRESHOLD_GBP) {
      return { tier: 1, basis: "adviser_low_overridden_by_quantified_impact" };
    }
    // Otherwise, 'low' (regardless of FIO) is capped at Tier 3
    if (hasForInfoOnly) {
      return { tier: 3, basis: "adviser_severity=low with 'for information only' disposition — capped at Tier 3" };
    }
    return { tier: 3, basis: "adviser_severity=low — capped at Tier 3" };
  }

  // ─── Tier 3 automatic conditions ──────────────────────────────────────
  if (obligationClass === "optional") {
    return { tier: 3, basis: "obligation_class=optional — automatically Tier 3" };
  }

  // ─── Evaluate Tier 1 rules (first match wins) ─────────────────────────
  // Rule 1: adviser_severity_max = 'high' AND verified quantified impact
  if (adviserSeverityMax === "high" && estimatedImpact != null) {
    return { tier: 1, basis: `adviser_severity=high with verified quantified_impact £${(estimatedImpact / 1_000_000).toFixed(2)}m` };
  }

  // Rule 2: Verified quantified impact >= £6.55m (EV threshold only)
  if (estimatedImpact != null && estimatedImpact >= TIER1_THRESHOLD_GBP) {
    return { tier: 1, basis: `quantified_impact £${(estimatedImpact / 1_000_000).toFixed(2)}m exceeds Tier 1 EV threshold (£6.55m)` };
  }

  // Rule 3: required + not_disclosed + probe ran and returned nothing
  if (obligationClass === "required" && gapKind === "not_disclosed" && probeRan) {
    return { tier: 1, basis: "required topic not_disclosed with probe confirming absence" };
  }

  // Rule 4: Gap touches deal.* or returns.* topic
  if (topicId.startsWith("deal.") || topicId.startsWith("returns.")) {
    return { tier: 1, basis: `topic ${topicId} is deal.* or returns.* — automatically Tier 1` };
  }

  // Rule 5: contradicts investment-thesis pillar — requires pillar list, skip for now

  // ─── Evaluate Tier 2 rules ─────────────────────────────────────────────
  // Rule 1: adviser_severity_max = 'medium' → floors at Tier 2
  if (adviserSeverityMax === "medium") {
    // Medium floors at 2 but the quantified impact may have been below tier 1
    // Check if quantified puts it in tier 2 range
    if (estimatedImpact != null && estimatedImpact >= TIER2_LOW_GBP) {
      return { tier: 2, basis: `adviser_severity=medium, quantified impact £${(estimatedImpact / 1_000_000).toFixed(2)}m in Tier 2 range` };
    }
    return { tier: 2, basis: "adviser_severity=medium — floors at Tier 2" };
  }

  // Rule 2: Quantified impact in Tier 2 range
  if (estimatedImpact != null && estimatedImpact >= TIER2_LOW_GBP && estimatedImpact < TIER1_THRESHOLD_GBP) {
    return { tier: 2, basis: `quantified_impact £${(estimatedImpact / 1_000_000).toFixed(2)}m in Tier 2 range (0.25%-1% of EV)` };
  }

  // Rule 3: conditional + not_disclosed (requires ≥3 reference facts)
  if (obligationClass === "conditional" && gapKind === "not_disclosed") {
    if (referenceFactCount < 3) {
      return { tier: 3, basis: `conditional topic not_disclosed with only ${referenceFactCount} reference fact(s) — below minimum 3, Tier 3` };
    }
    return { tier: 2, basis: "conditional topic not_disclosed — Tier 2" };
  }

  // Rule 4: unreconciled_divergence on required topic
  if (gapKind === "unreconciled_divergence" && obligationClass === "required") {
    return { tier: 2, basis: "unreconciled_divergence on required topic — Tier 2" };
  }

  // ─── Adviser 'high' floor: if nothing else pushed to Tier 1, floor at 2 ─
  if (adviserSeverityMax === "high") {
    return { tier: 2, basis: "adviser_severity=high — floors at Tier 2" };
  }

  // ─── Default to LLM recommendation, bounded to Tier 2-3 ───────────────
  // (Tier 1 can only be reached by explicit rules above)
  const boundedLlmTier = Math.max(llmTier, 2);
  if (boundedLlmTier <= 2 && llmTier <= 2) {
    return { tier: 2, basis: "LLM assessed Tier 2 — no rule elevates or caps" };
  }

  return { tier: 3, basis: "Tier 3 — no rule elevates above default" };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaMateriality",
  description: "Assigns materiality tiers to gap findings using multi-rule engine",
  integrations: {
    db: postgres(DB_ID),
    ai: anthropic(ANTHROPIC_ID),
  },
  input: z.object({
    dealId: z.string(),
    runId: z.string(),
    reset: z.boolean().optional().default(false),
  }),
  output: z.object({
    status: z.enum(["complete", "in_progress"]),
    findings_completed: z.number(),
    findings_remaining: z.number(),
    report: z.record(z.string(), z.any()).optional(),
  }),

  async run(ctx, { dealId, runId, reset }) {
    const { db } = ctx.integrations;
    const aiFn: AiFn = ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai) as any;

    // ─── RESET ────────────────────────────────────────────────────────────
    if (reset) {
      await db.query(
        `UPDATE oa_findings SET materiality_tier = 3, materiality_basis = 'awaiting_materiality_assessment', retrieval_probe = NULL, adviser_severity_max = NULL
         WHERE run_id = $1 AND deal_id = $2`,
        z.any(), [runId, dealId],
        { label: "Reset: restore placeholder materiality" }
      );
      await db.query(
        `DELETE FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'materiality'`,
        z.any(), [runId],
        { label: "Reset: delete materiality checkpoints" }
      );
      console.log("[P7] Reset complete for run", runId);
    }

    // ─── Load all findings for this run ───────────────────────────────────
    const findings = await db.query(
      `SELECT finding_id, topic_id, gap_kind, absence_basis, reference_evidence, subject_evidence, narrative
       FROM oa_findings WHERE run_id = $1 AND deal_id = $2`,
      FindingRow,
      [runId, dealId],
      { label: "Load findings for materiality" }
    );
    console.log(`[P7] ${findings.length} findings to assess`);

    let tier1Count = 0;
    let tier2Count = 0;
    let tier3Count = 0;
    let llmCalls = 0;
    let failClosedCount = 0;
    let adviserLowOverrideCount = 0;
    let yieldedForBudget = false;
    const tierDetails: Array<{ finding_id: string; topic_id: string; gap_kind: string; tier: number; basis: string; adviser_severity_max: string | null }> = [];
    const adviserLowOverrides: Array<{ topic_id: string; estimated_impact: number }> = [];

    // Budget guard
    const invocationStart = Date.now();
    const timeRemaining = () => HARD_KILL_MS - (Date.now() - invocationStart);
    const unitDurations: number[] = [];
    const estimatedUnitDuration = () =>
      unitDurations.length > 0
        ? unitDurations.reduce((a, b) => a + b, 0) / unitDurations.length
        : DEFAULT_UNIT_DURATION_MS;

    for (const finding of findings) {
      // Check checkpoint
      const cp = await db.query(
        `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'materiality' AND unit_key = $2`,
        z.any(),
        [runId, finding.finding_id],
        { label: `Check checkpoint ${finding.finding_id}` }
      );
      if (cp.length > 0) continue;

      // ─── PRE-WRITE GATE: Reject findings with both evidence arrays empty ──
      const subEv = Array.isArray(finding.subject_evidence) ? finding.subject_evidence : [];
      const refEv = Array.isArray(finding.reference_evidence) ? finding.reference_evidence : [];
      if (subEv.length === 0 && refEv.length === 0) {
        console.log(`[P7] REJECTED finding ${finding.topic_id}: both subject_evidence and reference_evidence empty — unverifiable`);
        await db.query(
          `UPDATE oa_findings
           SET materiality_tier = 3, materiality_basis = $3, adviser_severity_max = NULL,
               quantified_impact = NULL, source_fact_id = NULL
           WHERE finding_id = $1 AND run_id = $2`,
          z.any(),
          [finding.finding_id, runId, "REJECTED: no cited evidence (both arrays empty) — unverifiable finding"],
          { label: `Reject empty-evidence ${finding.topic_id}` }
        );
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
           VALUES ($1, 'materiality', $2, 'complete', $3::jsonb) ON CONFLICT DO NOTHING`,
          z.any(), [runId, finding.finding_id, JSON.stringify({ tier: 3, basis: "REJECTED: no cited evidence", rejected: true })],
          { label: `Checkpoint reject empty-evidence ${finding.finding_id}` }
        );
        tier3Count++;
        tierDetails.push({ finding_id: finding.finding_id, topic_id: finding.topic_id, gap_kind: finding.gap_kind, tier: 3, basis: "REJECTED: no cited evidence", adviser_severity_max: null });
        continue;
      }

      // ─── FIX 4: Reject not_disclosed with zero reference facts ─────────
      if (finding.gap_kind === "not_disclosed") {
        const refCount = await db.query(
          `SELECT COUNT(*) as cnt FROM oa_topic_facts tf
           JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
           WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'reference'`,
          z.object({ cnt: z.coerce.number() }),
          [runId, dealId, finding.topic_id],
          { label: `Ref count for ${finding.topic_id}` }
        );
        if ((refCount[0]?.cnt ?? 0) === 0) {
          console.log(`[P7] REJECTED finding ${finding.topic_id}: not_disclosed with 0 reference facts`);
          // Write rejection tier + checkpoint
          await db.query(
            `UPDATE oa_findings
             SET materiality_tier = 3, materiality_basis = $3, adviser_severity_max = NULL,
                 quantified_impact = NULL, source_fact_id = NULL
             WHERE finding_id = $1 AND run_id = $2`,
            z.any(),
            [finding.finding_id, runId, "REJECTED: not_disclosed with zero reference evidence — no basis for gap claim"],
            { label: `Reject ${finding.topic_id}` }
          );
          await db.query(
            `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
             VALUES ($1, 'materiality', $2, 'complete', $3::jsonb) ON CONFLICT DO NOTHING`,
            z.any(), [runId, finding.finding_id, JSON.stringify({ tier: 3, basis: "REJECTED: zero reference facts", rejected: true })],
            { label: `Checkpoint reject ${finding.finding_id}` }
          );
          tier3Count++;
          tierDetails.push({ finding_id: finding.finding_id, topic_id: finding.topic_id, gap_kind: finding.gap_kind, tier: 3, basis: "REJECTED: zero reference facts", adviser_severity_max: null });
          continue;
        }
      }

      // ─── BUDGET GUARD ─────────────────────────────────────────────────
      const remaining = timeRemaining();
      const estUnit = estimatedUnitDuration();
      if (remaining < SAFETY_MARGIN_MS + estUnit) {
        console.log(`[P7] YIELDING FOR BUDGET: ${remaining}ms remaining, est unit ${estUnit.toFixed(0)}ms`);
        yieldedForBudget = true;
        break;
      }

      const unitStart = Date.now();

      // ─── Get obligation_class for this topic ───────────────────────────
      const obligationResult = await db.query(
        `SELECT obligation_class FROM oa_topics WHERE run_id = $1 AND topic_id = $2`,
        TopicObligationRow,
        [runId, finding.topic_id],
        { label: `Obligation class for ${finding.topic_id}` }
      );
      const obligationClass = obligationResult[0]?.obligation_class ?? "optional";

      // ─── Get adviser_severity_max SCOPED TO FINDING'S EVIDENCE ─────────
      // Only count severity from facts the finding actually cites, not all topic facts
      // FIX: Also check ALL topic facts for rated items (in case FACT_CAP truncated them out of reference_evidence)
      const evidenceFactIds: string[] = Array.isArray(finding.reference_evidence) ? finding.reference_evidence : [];
      let adviserSeverityMax: string | null = null;
      let hasForInfoOnly = false;

      // Adviser severity — evidence-scoped ONLY (facts cited in this finding's evidence)
      if (evidenceFactIds.length > 0) {
        const adviserResult = await db.query(
          `SELECT
             MAX(CASE f.adviser_severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) as max_severity,
             BOOL_OR(LOWER(COALESCE(f.adviser_disposition, '')) LIKE '%for information only%') as has_fio
           FROM oa_facts f
           WHERE f.fact_id = ANY($1::uuid[])
             AND f.deal_id = $2
             AND f.adviser_severity IS NOT NULL`,
          AdviserInfoRow,
          [evidenceFactIds, dealId],
          { label: `Adviser info (evidence-scoped) for ${finding.topic_id}` }
        );
        const rank = adviserResult[0]?.max_severity ?? 0;
        adviserSeverityMax = rank >= 3 ? "high" : rank >= 2 ? "medium" : rank >= 1 ? "low" : null;
        hasForInfoOnly = adviserResult[0]?.has_fio ?? false;
      }

      // ─── Check probe status for not_disclosed findings ─────────────────
      let probeRan = false;
      if (finding.gap_kind === "not_disclosed") {
        const probeCheckpoint = await db.query(
          `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'absence_probe' AND unit_key = $2`,
          z.any(),
          [runId, finding.topic_id],
          { label: `Probe check for ${finding.topic_id}` }
        );
        probeRan = probeCheckpoint.length > 0;
      }

      // ─── LLM materiality extraction — identify quantifying figure ────────
      // Load reference fact values (with fact_id) for the prompt
      const refFacts = await db.query(
        `SELECT f.fact_id, f.predicate, f.value
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
         WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'reference'
         LIMIT 50`,
        z.object({ fact_id: z.string(), predicate: z.string().nullable(), value: z.string().nullable() }),
        [runId, dealId, finding.topic_id],
        { label: `Load ref facts for materiality: ${finding.topic_id}` }
      );

      const prompt = buildMaterialityPrompt(
        finding.topic_id,
        finding.gap_kind,
        refFacts as Array<{ fact_id?: string; predicate?: string; value?: string }>,
        finding.narrative,
      );

      const response = await aiFn(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          },
        },
        { response: z.any() },
        { label: `Materiality: ${finding.topic_id}` }
      );
      llmCalls++;

      const textBlock = response?.content?.find((c: any) => c.type === "text");
      const rawText: string = textBlock?.text ?? "{}";
      const cleanedText = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();

      let materialityResult: { estimated_impact_gbp: number | null; source_fact_id?: string | null; tier_recommendation: number; basis: string; impact_basis?: string };
      try {
        materialityResult = JSON.parse(cleanedText);
      } catch {
        materialityResult = { estimated_impact_gbp: null, source_fact_id: null, tier_recommendation: 3, basis: "Parse failure — defaulted to Tier 3" };
      }

      // ─── FIX 2: Code-verify the claimed figure ─────────────────────────
      // The model proposes; code verifies against source. No match = no claim.
      let verifiedImpact: number | null = null;
      let verifiedFactId: string | null = null;

      if (materialityResult.estimated_impact_gbp != null && materialityResult.source_fact_id) {
        // Step 1: Check source_fact_id is in this finding's evidence
        const allEvidenceIds: string[] = [
          ...(Array.isArray(finding.reference_evidence) ? finding.reference_evidence : []),
          ...(Array.isArray(finding.subject_evidence) ? finding.subject_evidence : []),
        ];
        const refFactIds = refFacts.map(f => f.fact_id);
        const factInEvidence = allEvidenceIds.includes(materialityResult.source_fact_id)
          || refFactIds.includes(materialityResult.source_fact_id);

        if (factInEvidence) {
          // Step 2: Look up the fact's text and check the figure appears as substring
          const sourceFact = refFacts.find(f => f.fact_id === materialityResult.source_fact_id);
          if (sourceFact) {
            const factText = `${sourceFact.predicate ?? ""} ${sourceFact.value ?? ""}`;
            // Normalise figure to string for substring match (e.g. 42100000 → "42.1m" or "42,100")
            const impactM = materialityResult.estimated_impact_gbp / 1_000_000;
            const candidates = [
              `£${impactM.toFixed(1)}m`,
              `£${impactM.toFixed(2)}m`,
              `${impactM.toFixed(1)}m`,
              `${impactM.toFixed(2)}m`,
              `£${(materialityResult.estimated_impact_gbp / 1000).toFixed(0)}k`,
              `£${materialityResult.estimated_impact_gbp.toLocaleString("en-GB")}`,
              materialityResult.estimated_impact_gbp.toLocaleString("en-GB"),
            ];
            const matched = candidates.some(c => factText.toLowerCase().includes(c.toLowerCase()));
            if (matched) {
              verifiedImpact = materialityResult.estimated_impact_gbp;
              verifiedFactId = materialityResult.source_fact_id;
            } else {
              console.log(`[P7] REJECTED figure £${impactM.toFixed(2)}m for ${finding.topic_id}: not found as substring in fact ${materialityResult.source_fact_id}`);
            }
          } else {
            console.log(`[P7] REJECTED figure for ${finding.topic_id}: source_fact_id ${materialityResult.source_fact_id} not in refFacts`);
          }
        } else {
          console.log(`[P7] REJECTED figure for ${finding.topic_id}: source_fact_id ${materialityResult.source_fact_id} not in evidence arrays`);
        }
      } else if (materialityResult.estimated_impact_gbp != null && !materialityResult.source_fact_id) {
        console.log(`[P7] REJECTED figure £${(materialityResult.estimated_impact_gbp / 1_000_000).toFixed(2)}m for ${finding.topic_id}: no source_fact_id provided`);
      }

      // ─── Apply tiering engine (uses VERIFIED impact only) ──────────────────
      // Get reference fact count for the tier engine (conditional not_disclosed rule)
      let referenceFactCount = 0;
      if (finding.gap_kind === "not_disclosed") {
        const refCountResult = await db.query(
          `SELECT COUNT(*) as cnt FROM oa_topic_facts tf
           JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
           WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'reference'`,
          z.object({ cnt: z.coerce.number() }),
          [runId, dealId, finding.topic_id],
          { label: `Ref count for tier engine: ${finding.topic_id}` }
        );
        referenceFactCount = refCountResult[0]?.cnt ?? 0;
      }

      const tierResult = assignTier({
        topicId: finding.topic_id,
        gapKind: finding.gap_kind,
        absenceBasis: finding.absence_basis,
        obligationClass,
        adviserSeverityMax,
        hasForInfoOnly,
        probeRan,
        llmTier: materialityResult.tier_recommendation,
        estimatedImpact: verifiedImpact,
        referenceFactCount,
      });

      const finalTier = tierResult.tier;
      const finalBasis = tierResult.basis;

      // Track adviser_low overrides
      if (finalBasis === "adviser_low_overridden_by_quantified_impact") {
        adviserLowOverrideCount++;
        adviserLowOverrides.push({ topic_id: finding.topic_id, estimated_impact: verifiedImpact! });
      }

      // Track fail-closed
      if (finding.absence_basis === "probe_not_run") {
        failClosedCount++;
      }

      // ─── Build retrieval_probe JSONB ───────────────────────────────────
      let retrievalProbe: any = null;
      if (finding.gap_kind === "not_disclosed") {
        retrievalProbe = probeRan
          ? { probed: true, stage: "absence_probe", topic_id: finding.topic_id }
          : { probed: false, reason: "probe_not_run" };
      }

      // ─── PRE-WRITE GATE: reject findings with empty evidence ──────────
      const subjectEvArr: string[] = Array.isArray(finding.subject_evidence) ? finding.subject_evidence : [];
      const refEvArr: string[] = Array.isArray(finding.reference_evidence) ? finding.reference_evidence : [];
      if (subjectEvArr.length === 0 && refEvArr.length === 0) {
        console.log(`[P7] GATE REJECTED ${finding.topic_id}: both subject_evidence and reference_evidence empty`);
        // Write a Tier 3 with explicit basis so it doesn't silently persist
        await db.query(
          `UPDATE oa_findings
           SET materiality_tier = 3, materiality_basis = 'GATE: empty evidence — suppressed',
               adviser_severity_max = NULL, retrieval_probe = NULL, quantified_impact = NULL, source_fact_id = NULL
           WHERE finding_id = $1 AND run_id = $2`,
          z.any(), [finding.finding_id, runId],
          { label: `Gate reject: ${finding.topic_id} empty evidence` }
        );
        await db.query(
          `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
           VALUES ($1, 'materiality', $2, 'gate_rejected', $3::jsonb) ON CONFLICT DO NOTHING`,
          z.any(), [runId, finding.finding_id, JSON.stringify({ reason: "empty_evidence" })],
          { label: `Checkpoint gate reject ${finding.topic_id}` }
        );
        tier3Count++;
        tierDetails.push({ finding_id: finding.finding_id, topic_id: finding.topic_id, gap_kind: finding.gap_kind, tier: 3, basis: "GATE: empty evidence", adviser_severity_max: null });
        continue;
      }

      // ─── UPDATE finding ──────────────────────────────────────────────────
      await db.query(
        `UPDATE oa_findings
         SET materiality_tier = $3, materiality_basis = $4, adviser_severity_max = $5, retrieval_probe = $6::jsonb,
             quantified_impact = $7, source_fact_id = $8
         WHERE finding_id = $1 AND run_id = $2`,
        z.any(),
        [finding.finding_id, runId, finalTier, finalBasis, adviserSeverityMax,
         retrievalProbe ? JSON.stringify(retrievalProbe) : null,
         verifiedImpact, verifiedFactId],
        { label: `Update materiality: ${finding.topic_id} → Tier ${finalTier}` }
      );

      // Track
      if (finalTier === 1) tier1Count++;
      else if (finalTier === 2) tier2Count++;
      else tier3Count++;

      tierDetails.push({
        finding_id: finding.finding_id,
        topic_id: finding.topic_id,
        gap_kind: finding.gap_kind,
        tier: finalTier,
        basis: finalBasis,
        adviser_severity_max: adviserSeverityMax,
      });

      // Checkpoint
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status, payload_json)
         VALUES ($1, 'materiality', $2, 'complete', $3::jsonb) ON CONFLICT DO NOTHING`,
        z.any(), [runId, finding.finding_id, JSON.stringify({
          tier: finalTier,
          basis: finalBasis,
          verified_impact_gbp: verifiedImpact,
          source_fact_id: verifiedFactId,
          llm_raw_impact: materialityResult.estimated_impact_gbp,
          llm_basis: materialityResult.basis,
        })],
        { label: `Checkpoint ${finding.finding_id}` }
      );

      // Record unit duration for budget guard
      unitDurations.push(Date.now() - unitStart);
    }

    // ─── BUDGET YIELD: early return ──────────────────────────────────────
    if (yieldedForBudget) {
      const completedCps = await db.query(
        `SELECT COUNT(*) as cnt FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'materiality' AND status = 'complete'`,
        z.object({ cnt: z.coerce.number() }), [runId], { label: "Count completed materiality checkpoints" }
      );
      const completed = completedCps[0]?.cnt ?? 0;
      return {
        status: "in_progress" as const,
        findings_completed: completed,
        findings_remaining: findings.length - completed,
        report: { message: "Yielded for budget — re-invoke to resume", run_id: runId, llm_calls_this_invocation: llmCalls },
      };
    }

    // ─── FULL REPORT: M1-M8 ─────────────────────────────────────────────
    // M1: Probe stats
    const probeStats = await db.query(
      `SELECT COUNT(*) as total_probed,
              SUM(CASE WHEN payload_json->>'verdict' = 'found_in_text' THEN 1 ELSE 0 END) as hits
       FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'absence_probe'`,
      z.object({ total_probed: z.coerce.number(), hits: z.coerce.number() }),
      [runId],
      { label: "M1: Probe stats" }
    );

    // M4: Findings by absence_basis
    const absenceBasisDist = await db.query(
      `SELECT absence_basis, COUNT(*) as cnt FROM oa_findings
       WHERE run_id = $1 AND deal_id = $2
       GROUP BY absence_basis`,
      z.object({ absence_basis: z.string().nullable(), cnt: z.coerce.number() }),
      [runId, dealId],
      { label: "M4: absence_basis distribution" }
    );

    // M5: ALL Tier 1 findings — no LIMIT
    const tier1Findings = await db.query(
      `SELECT f.finding_id, f.topic_id, f.gap_kind, f.materiality_basis, f.adviser_severity_max, f.absence_basis,
              CASE WHEN EXISTS (
                SELECT 1 FROM oa_stage_checkpoints sc
                WHERE sc.run_id = $1 AND sc.stage = 'absence_probe' AND sc.unit_key = f.topic_id
              ) THEN true ELSE false END AS probe_ran
       FROM oa_findings f
       WHERE f.run_id = $1 AND f.deal_id = $2 AND f.materiality_tier = 1`,
      z.object({
        finding_id: z.string(),
        topic_id: z.string(),
        gap_kind: z.string(),
        materiality_basis: z.string().nullable(),
        adviser_severity_max: z.string().nullable(),
        absence_basis: z.string().nullable(),
        probe_ran: z.coerce.boolean(),
      }),
      [runId, dealId],
      { label: "M5: All Tier 1 findings" }
    );

    // M7: Tier 1 findings with probe_not_run (MUST be zero)
    const m7 = tier1Findings.filter((f) => f.absence_basis === "probe_not_run");

    // M2: Topics where probe returned hits (reclassified)
    const probeHits = await db.query(
      `SELECT unit_key as topic_id, payload_json->>'verdict' as verdict
       FROM oa_stage_checkpoints
       WHERE run_id = $1 AND stage = 'absence_probe' AND payload_json->>'verdict' = 'found_in_text'`,
      z.object({ topic_id: z.string(), verdict: z.string() }),
      [runId],
      { label: "M2: Topics with probe hits" }
    );

    const report = {
      M1_probes_run: probeStats[0]?.total_probed ?? 0,
      M1_topics_probed: probeStats[0]?.total_probed ?? 0,
      M1_topics_returning_hits: probeStats[0]?.hits ?? 0,
      M2_topics_with_hits: probeHits.map((r) => r.topic_id),
      M3_findings_by_tier: { tier1: tier1Count, tier2: tier2Count, tier3: tier3Count, total: findings.length },
      M4_findings_by_absence_basis: absenceBasisDist,
      M5_tier1_findings: tier1Findings,
      M6_adviser_low_override_count: adviserLowOverrideCount,
      M6_adviser_low_overrides: adviserLowOverrides,
      M7_tier1_probe_not_run_count: m7.length,
      M7_tier1_probe_not_run_detail: m7,
      M7_GATE: m7.length === 0 ? "PASSED — zero Tier 1 findings with probe_not_run" : "FAILED",
      M8_fail_closed_count: failClosedCount,
      llm_calls_total: llmCalls,
      tier_details_sample: tierDetails.slice(0, 30),
    };

    console.log("[P7] REPORT:", JSON.stringify(report, null, 2));
    return { status: "complete" as const, findings_completed: findings.length, findings_remaining: 0, report };
  },
});
