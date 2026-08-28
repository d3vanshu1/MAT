/**
 * ERO v2 — Finding Adjudication Stage (Phase 4, Stage 3)
 *
 * For each hypothesis with status 'researched' (≥1 admissible evidence row),
 * the model reads the evidence and produces:
 *   - verdict: confirmed | refuted
 *   - proposed_severity: critical | warning | info
 *   - title, detail, materiality_rationale
 *
 * The INVARIANT of this stage:
 *   The model's proposed_severity is an INPUT to applyCeiling.
 *   applyCeiling's RETURNED severity is what gets written to ero_findings.
 *   The model's proposal is never the stored value.
 *   Both are captured so the gate's action is auditable.
 *
 * Resume-safe: processes only hypotheses with status 'researched' that
 * do NOT yet have an ero_findings row (NOT EXISTS guard).
 *
 * This stage does NOT merge findings across hypotheses — one finding
 * per adjudicated hypothesis. Render handles dedup.
 *
 * isEnforcementOrLitigation is derived from the hypothesis family:
 *   - 'litigation_enforcement' → true
 *   - 'regulatory' → true
 *   - all others → false
 * This is sound because the hypothesis family determines the investigation
 * domain: a litigation_enforcement hypothesis researches litigation evidence.
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
import { STAGE_BUDGET_MS } from "./ero-stage-contract.js";
import {
  applyCeiling,
  type EvidenceForCeiling,
} from "./ero-source-tiers.js";

// ── Constants ───────────────────────────────────────────────────────
const ADJUDICATION_MODEL = "claude-sonnet-4-6";
const ADJUDICATION_MAX_TOKENS = 4096;

// ── Enforcement/litigation families ─────────────────────────────────
// Derived from ero-families.ts family keys. These families investigate
// litigation/enforcement/regulatory matters, so their evidence items
// carry the enforcement/litigation signal for applyCeiling.
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

const ExistsFindingRow = z.object({ cnt: z.coerce.number() });

// ── Anthropic response schema ───────────────────────────────────────
const AdjudicationResponse = z.object({
  content: z.array(z.object({ text: z.string() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

// ── LLM adjudication output schema ──────────────────────────────────
const AdjudicationResult = z.object({
  verdict: z.enum(["confirmed", "refuted"]),
  proposed_severity: z.enum(["critical", "warning", "info"]),
  title: z.string(),
  detail: z.string(),
  materiality_rationale: z.string(),
});

// ── Per-hypothesis result for stageData ──────────────────────────────
interface AdjudicationOutcome {
  hypothesis_id: string;
  question: string;
  family: string;
  execution_rank: number;
  verdict: string;
  proposed_severity: string;
  final_severity: string;
  ceiling_reason: string;
  needs_recheck: boolean;
  title: string;
  evidence_count: number;
  evidence_tiers: number[];
  is_enforcement_family: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function adjudicateFindings(
  ctx: any,
  runId: string,
  _dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;
  const ai = ctx.integrations.claude;
  const stageStart = Date.now();

  // ── Load researched hypotheses that do NOT yet have a finding ─────
  // Resume-safe: NOT EXISTS on ero_findings means re-entry skips
  // already-adjudicated hypotheses.
  const hypotheses = await db.query(
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
    { label: "Adjudication: load unadjudicated researched hypotheses" },
  );

  if (hypotheses.length === 0) {
    return {
      stage: "adjudicate_findings",
      status: "complete",
      message: "No unadjudicated hypotheses — adjudication complete.",
      stageData: { findingsCreated: 0, outcomes: [] },
    };
  }

  const outcomes: AdjudicationOutcome[] = [];
  let findingsCreated = 0;

  for (const hyp of hypotheses) {
    // ── Budget guard ──────────────────────────────────────────────
    const elapsed = Date.now() - stageStart;
    if (elapsed >= STAGE_BUDGET_MS) {
      return {
        stage: "adjudicate_findings",
        status: "in_progress",
        message: `Budget exhausted after ${findingsCreated} findings (${Math.round(elapsed / 1000)}s). ${hypotheses.length - findingsCreated} remain.`,
        stageData: { findingsCreated, outcomes },
      };
    }

    // ── Process one hypothesis ────────────────────────────────────
    const outcome = await adjudicateOneHypothesis(db, ai, hyp);
    outcomes.push(outcome);
    findingsCreated++;

    // ── Heartbeat ─────────────────────────────────────────────────
    await db.execute(
      `UPDATE ero_pipeline_state
       SET heartbeat_at = now(), updated_at = now()
       WHERE run_id = $1`,
      [runId],
      { label: `Adjudication: heartbeat after hyp ${hyp.execution_rank}` },
    );
  }

  return {
    stage: "adjudicate_findings",
    status: "complete",
    message: `Adjudication complete. ${findingsCreated} findings created.`,
    stageData: { findingsCreated, outcomes },
  };
}

// ═══════════════════════════════════════════════════════════════════
// PER-HYPOTHESIS ADJUDICATION
// ═══════════════════════════════════════════════════════════════════

async function adjudicateOneHypothesis(
  db: any,
  ai: any,
  hyp: z.infer<typeof HypothesisRow>,
): Promise<AdjudicationOutcome> {
  // ── 1. Load evidence rows ───────────────────────────────────────
  const evidenceRows = await db.query(
    `SELECT evidence_id, url, domain, publisher, publication_date,
            source_tier, verbatim_snippet
     FROM ero_evidence
     WHERE hypothesis_id = $1
     ORDER BY source_tier ASC, publication_date DESC NULLS LAST`,
    EvidenceRow,
    [hyp.hypothesis_id],
    { label: `Adjudication: load evidence for hyp ${hyp.execution_rank}` },
  );

  // ── ASSERT: no finding without evidence ─────────────────────────
  // This should never happen because we only load status='researched'
  // hypotheses (which have ≥1 evidence row), but enforce defensively.
  if (evidenceRows.length === 0) {
    throw new Error(
      `INVARIANT VIOLATION: hypothesis ${hyp.hypothesis_id} has status ` +
        `'researched' but zero evidence rows. Cannot create finding ` +
        `without admissible evidence.`,
    );
  }

  // ── 2. LLM adjudication call ────────────────────────────────────
  const llmResult = await callAdjudicationLlm(ai, hyp, evidenceRows);

  // ── 3. Build evidence array for applyCeiling ────────────────────
  // isEnforcementOrLitigation is derived from the HYPOTHESIS FAMILY,
  // not from evidence content. litigation_enforcement and regulatory
  // families investigate enforcement/litigation matters, so their
  // evidence items carry the enforcement/litigation signal.
  const isEnforcementFamily = ENFORCEMENT_FAMILIES.has(hyp.family);

  const evidenceForCeiling: EvidenceForCeiling[] = evidenceRows.map(
    (e: z.infer<typeof EvidenceRow>) => ({
      tier: e.source_tier as 1 | 2 | 3,
      isDated: e.publication_date != null,
      publicationDate: e.publication_date,
      isEnforcementOrLitigation: isEnforcementFamily,
    }),
  );

  // ════════════════════════════════════════════════════════════════
  // THE GATE — this is the module's spine.
  //
  // proposed_severity goes IN to applyCeiling.
  // The RETURNED severity is what gets written to ero_findings.
  // The model's proposal is NEVER the stored value.
  // ════════════════════════════════════════════════════════════════
  const ceilingResult = applyCeiling(
    llmResult.proposed_severity,
    evidenceForCeiling,
  );
  const finalSeverity = ceilingResult.severity;       // ← this gets written
  const ceilingReason = ceilingResult.ceilingReason;
  // llmResult.proposed_severity is captured in stageData for audit,
  // NOT written to the severity column.
  // ════════════════════════════════════════════════════════════════

  // ── 5. Write ero_findings row ───────────────────────────────────
  // severity = applyCeiling's RETURNED value (finalSeverity)
  // ceiling_reason = applyCeiling's ceilingReason
  // The model's proposed_severity is NOT stored in this table
  // (no column for it) — it is captured in stageData for audit.
  await db.execute(
    `INSERT INTO ero_findings
       (hypothesis_id, verdict, severity, ceiling_reason,
        title, detail, materiality_rationale)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      hyp.hypothesis_id,
      llmResult.verdict,
      finalSeverity,                // ← applyCeiling result, NOT proposed
      ceilingReason,
      llmResult.title,
      llmResult.detail,
      llmResult.materiality_rationale,
    ],
    { label: `Adjudication: write finding for hyp ${hyp.execution_rank}` },
  );

  return {
    hypothesis_id: hyp.hypothesis_id,
    question: hyp.question,
    family: hyp.family,
    execution_rank: hyp.execution_rank,
    verdict: llmResult.verdict,
    proposed_severity: llmResult.proposed_severity,
    final_severity: finalSeverity,
    ceiling_reason: ceilingReason,
    needs_recheck: ceilingResult.needsRecheck,
    title: llmResult.title,
    evidence_count: evidenceRows.length,
    evidence_tiers: evidenceRows.map((e: z.infer<typeof EvidenceRow>) => e.source_tier),
    is_enforcement_family: isEnforcementFamily,
  };
}

// ═══════════════════════════════════════════════════════════════════
// LLM CALL
// ═══════════════════════════════════════════════════════════════════

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

async function callAdjudicationLlm(
  ai: any,
  hyp: z.infer<typeof HypothesisRow>,
  evidenceRows: Array<z.infer<typeof EvidenceRow>>,
): Promise<z.infer<typeof AdjudicationResult>> {
  // Build the evidence block for the prompt
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
    { label: `Adjudication: LLM call for hyp ${hyp.execution_rank} (${hyp.family})` },
  );

  // Parse the JSON response from the model
  const textBlock = response.content.find((b: { text: string }) => b.text);
  if (!textBlock || !textBlock.text) {
    throw new Error(
      `Adjudication LLM returned no text for hypothesis ${hyp.hypothesis_id}`,
    );
  }

  // Strip markdown code fences if the model wrapped its response
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
