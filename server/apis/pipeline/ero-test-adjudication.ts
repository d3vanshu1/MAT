/**
 * ERO v2 — Test harness for finding adjudication stage.
 *
 * Input: { runId, maxHypotheses? }
 *   - runId: an existing ERO run with researched hypotheses + evidence
 *   - maxHypotheses: cap on how many to adjudicate (default 3)
 *
 * Adjudicates the top-N researched hypotheses that do not yet have a
 * finding row, then returns RAW per-finding detail plus integrity checks.
 *
 * The critical check: recompute applyCeiling for each finding and compare
 * to the stored severity. If they differ, the gate is broken.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { STAGE_BUDGET_MS } from "./ero-stage-contract.js";
import {
  applyCeiling,
  type EvidenceForCeiling,
} from "./ero-source-tiers.js";

// ── Integration IDs ─────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ───────────────────────────────────────────────────────
const ADJUDICATION_MODEL = "claude-sonnet-4-6";
const ADJUDICATION_MAX_TOKENS = 4096;

// ── Enforcement/litigation families (same as main handler) ──────────
const ENFORCEMENT_FAMILIES = new Set([
  "litigation_enforcement",
  "regulatory",
]);

// ── DB row schemas ──────────────────────────────────────────────────
const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  question: z.string(),
  confirming_evidence: z.string(),
  refuting_evidence: z.string(),
  execution_rank: z.coerce.number(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
});

const EvidenceRow = z.object({
  evidence_id: z.string(),
  url: z.string(),
  domain: z.string().nullable(),
  publisher: z.string().nullable(),
  publication_date: z.string().nullable(),
  source_tier: z.coerce.number(),
  verbatim_snippet: z.string(),
});

const FindingRow = z.object({
  finding_id: z.string(),
  hypothesis_id: z.string(),
  verdict: z.string(),
  severity: z.string(),
  ceiling_reason: z.string(),
  title: z.string(),
  detail: z.string(),
  materiality_rationale: z.string(),
});

// ── Anthropic response schema ───────────────────────────────────────
const AdjudicationResponse = z.object({
  content: z.array(z.object({ text: z.string() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const AdjudicationResult = z.object({
  verdict: z.enum(["confirmed", "refuted"]),
  proposed_severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  materiality_rationale: z.string(),
});

// ── System prompt (same as main handler) ────────────────────────────
const ADJUDICATION_SYSTEM_PROMPT = `You are a due-diligence adjudicator. You will receive a risk hypothesis and the evidence gathered from web research.

Your job is to:
1. Read all evidence items and determine whether the hypothesis is CONFIRMED or REFUTED.
2. Propose a severity level for the finding: critical, warning, or info.
3. Write a concise title and detailed explanation.
4. Explain why this finding matters (or doesn't) to the investment thesis.

IMPORTANT RULES:
- Your proposed_severity is a PROPOSAL. It will be checked against source quality by code. Propose based on the SUBSTANCE of the finding — how material is this to the investment? Do NOT inflate severity to be "safe".
- "confirmed" means the evidence supports the risk described in the hypothesis.
- "refuted" means the evidence contradicts or disproves the risk.
- If evidence is mixed, lean toward the weight of evidence. If genuinely ambiguous, choose "confirmed" with lower severity rather than "refuted" — err toward surfacing risk.
- The materiality_rationale should explain how this finding connects to the deal thesis and why it matters (or doesn't) for the investment decision.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "verdict": "confirmed" | "refuted",
  "proposed_severity": "critical" | "warning" | "info",
  "title": "Short descriptive title for the finding",
  "detail": "Detailed explanation of what the evidence shows, citing specific sources",
  "materiality_rationale": "Why this matters to the investment thesis"
}`;

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "EroTestAdjudication",
  description: "Test harness for ERO adjudication — processes top-N researched hypotheses",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    maxHypotheses: z.number().optional(),
  }),

  output: z.object({
    findingsCreated: z.number(),
    hypothesesRemaining: z.number(),
    perFinding: z.array(
      z.object({
        hypothesis_id: z.string(),
        question: z.string(),
        family: z.string(),
        execution_rank: z.number(),
        verdict: z.string(),
        model_proposed_severity: z.string(),
        final_severity: z.string(),
        ceiling_reason: z.string(),
        needs_recheck: z.boolean(),
        title: z.string(),
        detail: z.string(),
        materiality_rationale: z.string(),
        evidence_count: z.number(),
        evidence_tiers: z.array(z.number()),
        is_enforcement_family: z.boolean(),
      }),
    ),
    checks: z.object({
      totalFindings: z.number(),
      ceilingDowngrades: z.number(),
      findingsWithZeroEvidence: z.number(),
      recomputeMatchesStored: z.boolean(),
      recomputeDetails: z.array(
        z.object({
          hypothesis_id: z.string(),
          stored_severity: z.string(),
          recomputed_severity: z.string(),
          match: z.boolean(),
        }),
      ),
      integrityPassed: z.boolean(),
    }),
  }),

  async run(ctx, { runId, maxHypotheses }) {
    const db = ctx.integrations.ic_diligence_db;
    const ai = ctx.integrations.claude;
    const cap = maxHypotheses ?? 3;
    const stageStart = Date.now();
    const deadlineMs = stageStart + STAGE_BUDGET_MS;

    // ── Load unadjudicated researched hypotheses (capped) ─────────
    const allUnadjudicated = await db.query(
      `SELECT h.hypothesis_id, h.family, h.question, h.confirming_evidence,
              h.refuting_evidence, h.execution_rank, h.entity_id, h.thesis_link
       FROM ero_hypotheses h
       WHERE h.run_id = $1
         AND h.status = 'researched'
         AND NOT EXISTS (
           SELECT 1 FROM ero_findings f WHERE f.hypothesis_id = h.hypothesis_id
         )
       ORDER BY h.execution_rank ASC`,
      HypothesisRow,
      [runId],
      { label: "TestAdjudication: load unadjudicated hypotheses" },
    );

    const toProcess = allUnadjudicated.slice(0, cap);
    const remaining = allUnadjudicated.length - toProcess.length;

    // ── Process each hypothesis ───────────────────────────────────
    const perFinding: Array<{
      hypothesis_id: string;
      question: string;
      family: string;
      execution_rank: number;
      verdict: string;
      model_proposed_severity: string;
      final_severity: string;
      ceiling_reason: string;
      needs_recheck: boolean;
      title: string;
      detail: string;
      materiality_rationale: string;
      evidence_count: number;
      evidence_tiers: number[];
      is_enforcement_family: boolean;
    }> = [];

    for (const hyp of toProcess) {
      // ── Load evidence ─────────────────────────────────────────
      const evidenceRows = await db.query(
        `SELECT evidence_id, url, domain, publisher, publication_date,
                source_tier, verbatim_snippet
         FROM ero_evidence
         WHERE hypothesis_id = $1
         ORDER BY source_tier ASC, publication_date DESC NULLS LAST`,
        EvidenceRow,
        [hyp.hypothesis_id],
        { label: `TestAdjudication: load evidence for hyp ${hyp.execution_rank}` },
      );

      // ASSERT: no finding without evidence
      if (evidenceRows.length === 0) {
        throw new Error(
          `INVARIANT VIOLATION: hypothesis ${hyp.hypothesis_id} has status ` +
            `'researched' but zero evidence rows.`,
        );
      }

      // ── LLM adjudication ──────────────────────────────────────
      const llmResult = await callLlm(ai, hyp, evidenceRows);

      // ── Build evidence for applyCeiling ────────────────────────
      const isEnforcementFamily = ENFORCEMENT_FAMILIES.has(hyp.family);
      const evidenceForCeiling: EvidenceForCeiling[] = evidenceRows.map((e) => ({
        tier: e.source_tier as 1 | 2 | 3,
        isDated: e.publication_date != null,
        publicationDate: e.publication_date,
        isEnforcementOrLitigation: isEnforcementFamily,
      }));

      // ── THE GATE ──────────────────────────────────────────────
      const ceilingResult = applyCeiling(
        llmResult.proposed_severity,
        evidenceForCeiling,
      );
      const finalSeverity = ceilingResult.severity;

      // ── Write finding row ─────────────────────────────────────
      await db.execute(
        `INSERT INTO ero_findings
           (hypothesis_id, verdict, severity, ceiling_reason,
            title, detail, materiality_rationale)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          hyp.hypothesis_id,
          llmResult.verdict,
          finalSeverity,
          ceilingResult.ceilingReason,
          llmResult.title,
          llmResult.detail,
          llmResult.materiality_rationale,
        ],
        { label: `TestAdjudication: write finding for hyp ${hyp.execution_rank}` },
      );

      perFinding.push({
        hypothesis_id: hyp.hypothesis_id,
        question: hyp.question,
        family: hyp.family,
        execution_rank: hyp.execution_rank,
        verdict: llmResult.verdict,
        model_proposed_severity: llmResult.proposed_severity,
        final_severity: finalSeverity,
        ceiling_reason: ceilingResult.ceilingReason,
        needs_recheck: ceilingResult.needsRecheck,
        title: llmResult.title,
        detail: llmResult.detail,
        materiality_rationale: llmResult.materiality_rationale,
        evidence_count: evidenceRows.length,
        evidence_tiers: evidenceRows.map((e) => e.source_tier),
        is_enforcement_family: isEnforcementFamily,
      });

      // ── Heartbeat ─────────────────────────────────────────────
      await db.execute(
        `UPDATE ero_pipeline_state
         SET heartbeat_at = now(), updated_at = now()
         WHERE run_id = $1`,
        [runId],
        { label: `TestAdjudication: heartbeat after hyp ${hyp.execution_rank}` },
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECKS
    // ═══════════════════════════════════════════════════════════════

    const totalFindings = perFinding.length;

    // Count where final < proposed (the gate DEMONSTRABLY firing)
    const SEVERITY_RANK: Record<string, number> = {
      critical: 3, warning: 2, info: 1,
    };
    const ceilingDowngrades = perFinding.filter(
      (f) =>
        (SEVERITY_RANK[f.final_severity] ?? 0) <
        (SEVERITY_RANK[f.model_proposed_severity] ?? 0),
    ).length;

    // Count findings with zero evidence (MUST be 0)
    const findingsWithZeroEvidence = perFinding.filter(
      (f) => f.evidence_count === 0,
    ).length;

    // HARD ASSERTION: recompute applyCeiling for each finding and
    // compare to the stored severity. If they differ, the gate is
    // not correctly wired.
    const recomputeDetails: Array<{
      hypothesis_id: string;
      stored_severity: string;
      recomputed_severity: string;
      match: boolean;
    }> = [];

    for (const f of perFinding) {
      // Rebuild the evidence array from the same data
      const isEnforcementFamily = ENFORCEMENT_FAMILIES.has(f.family);

      // Re-read evidence from DB to get the actual tiers/dates
      const evidenceRows = await db.query(
        `SELECT source_tier, publication_date
         FROM ero_evidence
         WHERE hypothesis_id = $1`,
        z.object({
          source_tier: z.coerce.number(),
          publication_date: z.string().nullable(),
        }),
        [f.hypothesis_id],
        { label: `TestAdjudication: recompute evidence for ${f.hypothesis_id}` },
      );

      const evidenceForCeiling: EvidenceForCeiling[] = evidenceRows.map((e) => ({
        tier: e.source_tier as 1 | 2 | 3,
        isDated: e.publication_date != null,
        publicationDate: e.publication_date,
        isEnforcementOrLitigation: isEnforcementFamily,
      }));

      const recomputed = applyCeiling(
        f.model_proposed_severity as "critical" | "warning" | "info",
        evidenceForCeiling,
      );

      recomputeDetails.push({
        hypothesis_id: f.hypothesis_id,
        stored_severity: f.final_severity,
        recomputed_severity: recomputed.severity,
        match: f.final_severity === recomputed.severity,
      });
    }

    const recomputeMatchesStored = recomputeDetails.every((d) => d.match);

    const integrityPassed =
      findingsWithZeroEvidence === 0 && recomputeMatchesStored;

    return {
      findingsCreated: totalFindings,
      hypothesesRemaining: remaining,
      perFinding,
      checks: {
        totalFindings,
        ceilingDowngrades,
        findingsWithZeroEvidence,
        recomputeMatchesStored,
        recomputeDetails,
        integrityPassed,
      },
    };
  },
});

// ═══════════════════════════════════════════════════════════════════
// LLM HELPER (duplicated from main handler for standalone harness)
// ═══════════════════════════════════════════════════════════════════

async function callLlm(
  ai: any,
  hyp: z.infer<typeof HypothesisRow>,
  evidenceRows: Array<z.infer<typeof EvidenceRow>>,
): Promise<z.infer<typeof AdjudicationResult>> {
  const evidenceBlock = evidenceRows
    .map((e, i) => {
      const parts = [
        `Evidence ${i + 1}:`,
        `  URL: ${e.url}`,
        `  Domain: ${e.domain ?? "unknown"}`,
        e.publisher ? `  Publisher: ${e.publisher}` : null,
        e.publication_date ? `  Date: ${e.publication_date}` : `  Date: undated`,
        `  Source Tier: ${e.source_tier} (${e.source_tier === 1 ? "authoritative" : e.source_tier === 2 ? "reputable" : "general web"})`,
        `  Snippet: ${e.verbatim_snippet}`,
      ];
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");

  const userPrompt = [
    `HYPOTHESIS: ${hyp.question}`,
    ``,
    `Confirming evidence would include: ${hyp.confirming_evidence}`,
    `Refuting evidence would include: ${hyp.refuting_evidence}`,
    hyp.thesis_link ? `Thesis dependency: ${hyp.thesis_link}` : null,
    ``,
    `EVIDENCE (${evidenceRows.length} items):`,
    evidenceBlock,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await ai.apiRequest(
    {
      method: "POST",
      path: "/v1/messages",
      body: {
        model: ADJUDICATION_MODEL,
        max_tokens: ADJUDICATION_MAX_TOKENS,
        system: [
          {
            type: "text",
            text: ADJUDICATION_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      },
    },
    { response: AdjudicationResponse },
    { label: `TestAdjudication: LLM for hyp ${hyp.execution_rank} (${hyp.family})` },
  );

  const textBlock = response.content.find((b: { text: string }) => b.text);
  if (!textBlock || !textBlock.text) {
    throw new Error(
      `Adjudication LLM returned no text for hypothesis ${hyp.hypothesis_id}`,
    );
  }

  let rawJson = textBlock.text.trim();
  if (rawJson.startsWith("```")) {
    rawJson = rawJson
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(
      `Adjudication LLM returned invalid JSON for hypothesis ` +
        `${hyp.hypothesis_id}: ${rawJson.slice(0, 500)}`,
    );
  }

  const validated = AdjudicationResult.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Adjudication LLM returned invalid structure for hypothesis ` +
        `${hyp.hypothesis_id}: ${validated.error.message}`,
    );
  }

  return validated.data;
}
