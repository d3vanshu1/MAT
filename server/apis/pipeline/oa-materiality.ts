/**
 * P7 — OA Materiality Assessment
 *
 * Updates existing oa_findings rows (inserted by P6) with materiality_tier and materiality_basis.
 * Also reads probe results from D1 to set retrieval_probe JSONB and enforce fail-closed rule.
 *
 * Deal config (SCG):
 * - EV = £655m
 * - Tier 1 threshold: 1% of EV = £6.55m
 * - Tier 2 threshold: 5% of EBITDA (£55m) = £2.75m
 * - Tier 3: everything else
 *
 * Materiality rules:
 * - D4 adviser severity asymmetry:
 *   - If adviser_severity_max = 'high' on any reference fact for the topic → floor at Tier 2
 *   - If adviser_severity_max = 'high' AND gap_kind = 'not_disclosed' → Tier 1
 * - FAIL CLOSED: absence_basis = 'probe_not_run' → caps at Tier 3 (never Tier 1 or 2)
 * - No code path can reach Tier 1 if absence_basis = 'probe_not_run'
 *
 * LLM call per finding to assess financial materiality based on:
 * - Reference evidence values/predicates
 * - Gap kind
 * - Topic obligation class
 * Then code applies tier boundaries and fail-closed rules.
 *
 * Report: M3-M8
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Deal config (SCG)
// ---------------------------------------------------------------------------
const DEAL_EV_GBP = 655_000_000;
const TIER1_THRESHOLD_GBP = 6_550_000; // 1% of EV
const TIER2_THRESHOLD_GBP = 2_750_000; // 5% of EBITDA (£55m)

// Budget guard constants
const HARD_KILL_MS = 200_000;          // conservative: yield well before platform kill
const SAFETY_MARGIN_MS = 45_000;       // do not start work inside this window
const DEFAULT_UNIT_DURATION_MS = 15_000; // conservative seed for rolling average

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

const AdviserSeverityRow = z.object({
  max_severity: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildMaterialityPrompt(
  topicId: string,
  gapKind: string,
  referenceEvidence: any[],
  narrative: string | null,
): string {
  const evidenceLines = (referenceEvidence || []).map((e: any, i: number) =>
    `  [${i}] predicate=${e?.predicate ?? "NULL"} | value=${e?.value ?? "NULL"}`
  ).join("\n");

  return `You are assessing the financial materiality of a due-diligence gap.

DEAL CONTEXT:
- Enterprise Value: £655m
- Tier 1 threshold (critical): >£6.55m potential impact (1% of EV)
- Tier 2 threshold (significant): >£2.75m potential impact (5% of EBITDA)
- Tier 3 (informational): below both thresholds or unquantifiable

FINDING:
- Topic: ${topicId}
- Gap kind: ${gapKind}
- Narrative: ${narrative ?? "N/A"}

REFERENCE EVIDENCE:
${evidenceLines || "  (none)"}

Assess the POTENTIAL FINANCIAL IMPACT of this gap being unaddressed.
Consider:
- What could go wrong if this gap is not addressed?
- What is the likely monetary exposure?
- Is the impact quantifiable from the evidence?

Respond with JSON:
{
  "estimated_impact_gbp": <number or null if unquantifiable>,
  "tier_recommendation": 1 | 2 | 3,
  "basis": "<one sentence explaining the tier assignment>"
}

Rules:
- If evidence contains no monetary values and impact is speculative → Tier 3
- If impact clearly exceeds £6.55m → Tier 1
- If impact is between £2.75m and £6.55m → Tier 2
- If unquantifiable but topic is 'required' obligation → Tier 2 minimum
- Be conservative: uncertainty defaults DOWN (toward higher tier number = lower severity)
- Return ONLY valid JSON. No markdown fences.`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "OaMateriality",
  description: "Assigns materiality tiers to gap findings",
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
      // Reset materiality back to placeholder values
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
    let yieldedForBudget = false;
    const tierDetails: Array<{ finding_id: string; topic_id: string; gap_kind: string; tier: number; basis: string }> = [];

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

      // ─── BUDGET GUARD ─────────────────────────────────────────────────
      const remaining = timeRemaining();
      const estUnit = estimatedUnitDuration();
      if (remaining < SAFETY_MARGIN_MS + estUnit) {
        console.log(`[P7] YIELDING FOR BUDGET: ${remaining}ms remaining, est unit ${estUnit.toFixed(0)}ms`);
        yieldedForBudget = true;
        break;
      }

      // ─── Get adviser_severity_max for this topic ───────────────────
      const unitStart = Date.now();
      const severityResult = await db.query(
        `SELECT MAX(f.adviser_severity) as max_severity
         FROM oa_topic_facts tf
         JOIN oa_facts f ON f.fact_id = tf.fact_id AND f.deal_id = $2
         WHERE tf.run_id = $1 AND tf.topic_id = $3 AND tf.fact_role = 'reference'
           AND f.adviser_severity IS NOT NULL`,
        AdviserSeverityRow,
        [runId, dealId, finding.topic_id],
        { label: `Adviser severity for ${finding.topic_id}` }
      );
      const adviserSeverityMax = severityResult[0]?.max_severity ?? null;

      // ─── Get probe result for not_disclosed findings ─────────────────
      let retrievalProbe: any = null;
      if (finding.gap_kind === "not_disclosed") {
        // Check if D1 ran a probe on this topic
        const probeCheckpoint = await db.query(
          `SELECT 1 FROM oa_stage_checkpoints WHERE run_id = $1 AND stage = 'absence_probe' AND unit_key = $2`,
          z.any(),
          [runId, finding.topic_id],
          { label: `Probe check for ${finding.topic_id}` }
        );
        if (probeCheckpoint.length > 0) {
          retrievalProbe = { probed: true, stage: "absence_probe", topic_id: finding.topic_id };
        } else {
          retrievalProbe = null; // probe not run
        }
      }

      // ─── LLM materiality assessment ───────────────────────────────────
      const refEvidence = Array.isArray(finding.reference_evidence) ? finding.reference_evidence : [];
      const prompt = buildMaterialityPrompt(
        finding.topic_id,
        finding.gap_kind,
        refEvidence,
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

      let materialityResult: { estimated_impact_gbp: number | null; tier_recommendation: number; basis: string };
      try {
        materialityResult = JSON.parse(cleanedText);
      } catch {
        materialityResult = { estimated_impact_gbp: null, tier_recommendation: 3, basis: "Parse failure — defaulted to Tier 3" };
      }

      let finalTier = materialityResult.tier_recommendation;
      let finalBasis = materialityResult.basis;

      // ─── D4: Adviser severity asymmetry ─────────────────────────────
      if (adviserSeverityMax === "high") {
        if (finding.gap_kind === "not_disclosed") {
          // High severity + not_disclosed → Tier 1
          if (finalTier > 1) {
            finalTier = 1;
            finalBasis += " [elevated to Tier 1: adviser_severity=high + not_disclosed]";
          }
        } else {
          // High severity + any other gap → floor at Tier 2
          if (finalTier > 2) {
            finalTier = 2;
            finalBasis += " [elevated to Tier 2: adviser_severity=high]";
          }
        }
      }

      // ─── FAIL CLOSED: probe_not_run caps at Tier 3 ──────────────────
      if (finding.absence_basis === "probe_not_run") {
        if (finalTier < 3) {
          finalTier = 3;
          finalBasis += " [FAIL CLOSED: probe_not_run caps at Tier 3]";
          failClosedCount++;
        }
      }

      // Validate tier bounds
      if (finalTier < 1) finalTier = 1;
      if (finalTier > 3) finalTier = 3;

      // ─── UPDATE finding ──────────────────────────────────────────────
      await db.query(
        `UPDATE oa_findings
         SET materiality_tier = $3, materiality_basis = $4, adviser_severity_max = $5, retrieval_probe = $6::jsonb
         WHERE finding_id = $1 AND run_id = $2`,
        z.any(),
        [finding.finding_id, runId, finalTier, finalBasis, adviserSeverityMax, retrievalProbe ? JSON.stringify(retrievalProbe) : null],
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
      });

      // Checkpoint
      await db.query(
        `INSERT INTO oa_stage_checkpoints (run_id, stage, unit_key, status) VALUES ($1, 'materiality', $2, 'complete') ON CONFLICT DO NOTHING`,
        z.any(), [runId, finding.finding_id],
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

    // ─── M3-M8: Report ─────────────────────────────────────────────────
    // M7: Tier 1 findings with probe_not_run (must be ZERO)
    const m7 = await db.query(
      `SELECT finding_id, topic_id FROM oa_findings
       WHERE run_id = $1 AND deal_id = $2 AND materiality_tier = 1 AND absence_basis = 'probe_not_run'`,
      z.object({ finding_id: z.string(), topic_id: z.string() }),
      [runId, dealId],
      { label: "M7: Tier 1 with probe_not_run" }
    );

    // M8: Check for 'verified_absent' in any probe results
    const m8 = await db.query(
      `SELECT topic_id, absence_basis FROM oa_findings
       WHERE run_id = $1 AND deal_id = $2 AND absence_basis = 'no_subject_facts_and_probe_null'`,
      z.object({ topic_id: z.string(), absence_basis: z.string() }),
      [runId, dealId],
      { label: "M8: verified_absent findings" }
    );

    const report = {
      M3_total_findings: findings.length,
      M4_tier_distribution: { tier1: tier1Count, tier2: tier2Count, tier3: tier3Count },
      M5_fail_closed_count: failClosedCount,
      M6_llm_calls: llmCalls,
      M7_tier1_probe_not_run: m7.length,
      M7_detail: m7,
      M8_verified_absent_count: m8.length,
      M8_detail: m8.slice(0, 10),
      tier_details: tierDetails.slice(0, 20),
    };

    console.log("[P7] REPORT:", JSON.stringify(report, null, 2));
    return { status: "complete" as const, findings_completed: findings.length, findings_remaining: 0, report };
  },
});
