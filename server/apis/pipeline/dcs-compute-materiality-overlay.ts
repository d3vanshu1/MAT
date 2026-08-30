/**
 * DCS Compute Materiality Overlay — Phase 4A of the DCS rebuild.
 *
 * Produces one qualitative paragraph explaining which DCS evidence gaps
 * matter most for the deal. Uses a single Anthropic model call via
 * getModuleModel("diligence_completeness") and callLLMWithHeadroom.
 *
 * This API never computes, modifies, or returns:
 *   - headline score
 *   - dimension scores / score_value
 *   - state counts (evidenced/asserted/absent counts)
 *   - evidence counts or coverage statistics
 *   - dimension verdicts
 *
 * Separation is deliberate: Phases 3A–3C remain deterministic and model-free.
 * The model may explain which evidence gaps matter most; it cannot see,
 * calculate, change, or justify the headline score.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { DCS_DIMENSIONS, type DimensionState } from "./dcs-rubric.js";
import { getModuleModel } from "./model-config.js";
import { callLLMWithHeadroom, MessageResponseSchema } from "./call-llm.js";
import type { PipelineContext } from "./pipeline-config.js";
import {
  validateMaterialityOverlay,
  OVERLAY_FORBIDDEN_TERMS,
} from "./dcs-materiality-overlay-validator.js";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Rubric dimension set for validation ─────────────────────────
const RUBRIC_IDS = new Set(DCS_DIMENSIONS.map((d) => d.id));
const RUBRIC_LABELS: Record<string, string> = Object.fromEntries(
  DCS_DIMENSIONS.map((d) => [d.id, d.label]),
);
const RUBRIC_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  DCS_DIMENSIONS.map((d) => [d.id, d.description]),
);
const VALID_STATES = new Set<string>(["evidenced", "asserted", "absent"]);

// ── Qualitative gap basis (spec-mandated, no quantitative data) ─
const GAP_BASIS: Record<DimensionState, string> = {
  evidenced: "Independent workproduct evidence is present.",
  asserted:
    "The topic appears in narrative material, but no substantive workproduct evidence qualifies.",
  absent: "No accepted evidence references this topic.",
};

// ── Schemas ─────────────────────────────────────────────────────

const VerificationVerdictSchema = z.object({
  dimension_id: z.string(),
  label: z.string(),
  state: z.string(),
  rationale: z.string(),
});
type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

const InputSchema = z.object({
  runId: z.string().uuid(),
  dealId: z.string().uuid(),
  verificationMode: z.boolean().default(false),
  verificationVerdicts: z.array(VerificationVerdictSchema).optional(),
  verificationOverlayCandidate: z.string().optional(),
});

const ModelInputAuditSchema = z.object({
  dimensionCount: z.number(),
  containsDigit: z.boolean(),
  containsForbiddenQuantitativeTerm: z.boolean(),
});

const OutputSchema = z.object({
  runId: z.string(),
  mode: z.enum(["normal", "verification"]),
  provisional: z.boolean(),
  modelCalled: z.boolean(),
  overlayAccepted: z.boolean(),
  overlay: z.string().nullable(),
  rejectionCode: z.string().nullable(),
  persistedOverlay: z.boolean(),
  modelInputAudit: ModelInputAuditSchema,
});

// ── Row schemas for DB queries ──────────────────────────────────

const ModuleRunRowSchema = z.object({
  run_id: z.string(),
  deal_id: z.string(),
});

const StageStateRowSchema = z.object({
  stage: z.string(),
  status: z.string(),
  cursor_value: z.string().nullable(),
  detail: z.string().nullable(),
});

const ExtractDetailSchema = z.object({
  processed_count: z.number(),
  total_chunks: z.number(),
  last_chunk_id: z.string(),
});

const VerdictRowSchema = z.object({
  dimension_id: z.string(),
  state: z.string(),
});

const SummaryCheckRowSchema = z.object({
  computed_in_code: z.boolean(),
  dimension_count: z.coerce.number(),
});

const DealDescriptorRowSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
});

const OverlayReadbackSchema = z.object({
  materiality_overlay: z.string().nullable(),
});

const CountSchema = z.object({
  cnt: z.coerce.number(),
});

// ═════════════════════════════════════════════════════════════════
// PROMPT AUDIT — code-side check of assembled model payload
// ═════════════════════════════════════════════════════════════════

function auditPromptPayload(payload: string): {
  containsDigit: boolean;
  containsForbiddenQuantitativeTerm: boolean;
} {
  const containsDigit = /[0-9]/.test(payload);
  let containsForbiddenQuantitativeTerm = false;
  for (const term of OVERLAY_FORBIDDEN_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(payload)) {
      containsForbiddenQuantitativeTerm = true;
      break;
    }
  }
  return { containsDigit, containsForbiddenQuantitativeTerm };
}

/**
 * Sanitize deal descriptor — strip all ASCII digits so ordinary numbers
 * in a deal description cannot reach the model.
 */
function sanitizeDealDescriptor(raw: string): string {
  return raw.replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
}

// ═════════════════════════════════════════════════════════════════
// API DEFINITION
// ═════════════════════════════════════════════════════════════════

export default api({
  name: "DcsComputeMaterialityOverlay",
  description: "Generates qualitative materiality paragraph for DCS evidence gaps",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: InputSchema,
  output: OutputSchema,

  async run(ctx, input) {
    const { runId, dealId, verificationMode } = input;
    const mode = verificationMode ? "verification" : "normal";
    const pipelineStartTime = Date.now();

    // ── Build pipeline context for callLLMWithHeadroom ──────────
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.db,
        ai: ctx.integrations.ai,
      },
    };

    // ════════════════════════════════════════════════════════════
    // NORMAL MODE — reject verification-only inputs
    // ════════════════════════════════════════════════════════════
    if (!verificationMode) {
      if (input.verificationVerdicts !== undefined) {
        throw new Error(
          "Normal mode rejects verificationVerdicts. Remove the field or set verificationMode=true.",
        );
      }
      if (input.verificationOverlayCandidate !== undefined) {
        throw new Error(
          "Normal mode rejects verificationOverlayCandidate. Remove the field or set verificationMode=true.",
        );
      }
    }

    // ════════════════════════════════════════════════════════════
    // VERIFICATION MODE
    // ════════════════════════════════════════════════════════════
    if (verificationMode) {
      const verdicts = input.verificationVerdicts;
      if (!verdicts || verdicts.length === 0) {
        // No verdicts and no candidate → need verdicts for model call
        if (input.verificationOverlayCandidate === undefined) {
          throw new Error(
            "Verification mode requires verificationVerdicts (10 rubric dimensions).",
          );
        }
      }

      // ── Validate verification verdicts ────────────────────────
      if (verdicts) {
        if (verdicts.length !== DCS_DIMENSIONS.length) {
          throw new Error(
            `Verification requires exactly ${DCS_DIMENSIONS.length} verdicts, got ${verdicts.length}.`,
          );
        }
        const seenIds = new Set<string>();
        for (const v of verdicts) {
          if (!RUBRIC_IDS.has(v.dimension_id)) {
            throw new Error(`Unknown dimension_id: ${v.dimension_id}`);
          }
          if (seenIds.has(v.dimension_id)) {
            throw new Error(`Duplicate dimension_id: ${v.dimension_id}`);
          }
          seenIds.add(v.dimension_id);
          const expectedLabel = RUBRIC_LABELS[v.dimension_id];
          if (v.label !== expectedLabel) {
            throw new Error(
              `Label mismatch for ${v.dimension_id}: expected "${expectedLabel}", got "${v.label}"`,
            );
          }
          if (!VALID_STATES.has(v.state)) {
            throw new Error(
              `Invalid state "${v.state}" for ${v.dimension_id}. Must be evidenced|asserted|absent.`,
            );
          }
          if (!v.rationale || v.rationale.trim().length === 0) {
            throw new Error(`Empty rationale for ${v.dimension_id}.`);
          }
        }
      }

      // ── Candidate-only verification path ──────────────────────
      if (input.verificationOverlayCandidate !== undefined) {
        const validation = validateMaterialityOverlay(input.verificationOverlayCandidate);
        return {
          runId,
          mode: "verification" as const,
          provisional: true,
          modelCalled: false,
          overlayAccepted: validation.accepted,
          overlay: validation.overlay,
          rejectionCode: validation.rejectionCode,
          persistedOverlay: false,
          modelInputAudit: {
            dimensionCount: verdicts?.length ?? 0,
            containsDigit: false,
            containsForbiddenQuantitativeTerm: false,
          },
        };
      }

      // ── Live verification model call ──────────────────────────
      // verdicts are guaranteed non-null here because we validated above
      const vVerdicts = verdicts!;
      const dealDescriptor = await loadDealDescriptor(ctx, dealId);
      const { userContent, audit } = buildModelPayload(dealDescriptor, vVerdicts);

      if (audit.containsDigit || audit.containsForbiddenQuantitativeTerm) {
        throw new Error(
          `Prompt audit failed: containsDigit=${audit.containsDigit}, containsForbiddenQuantitativeTerm=${audit.containsForbiddenQuantitativeTerm}`,
        );
      }

      const model = getModuleModel("diligence_completeness");
      const llmResponse = await callLLMWithHeadroom(
        pipelineCtx,
        {
          model,
          max_tokens: 512,
          system: [{ type: "text", text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content: userContent }],
        },
        "DcsMaterialityOverlay: verification live call",
        {
          pipelineStartTime,
          maxPerCallTimeout: 60_000,
          retries: 1,
          minBudget: 30_000,
        },
      );

      const rawText = (llmResponse.content[0]?.text ?? "").trim();
      const validation = validateMaterialityOverlay(rawText);

      return {
        runId,
        mode: "verification" as const,
        provisional: true,
        modelCalled: true,
        overlayAccepted: validation.accepted,
        overlay: validation.overlay,
        rejectionCode: validation.rejectionCode,
        persistedOverlay: false,
        modelInputAudit: {
          dimensionCount: vVerdicts.length,
          ...audit,
        },
      };
    }

    // ════════════════════════════════════════════════════════════
    // NORMAL MODE — precondition checks
    // ════════════════════════════════════════════════════════════

    // Precondition 1: module_runs row exists
    const moduleRuns = await ctx.integrations.db.query(
      `SELECT id, deal_id::text FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string(), deal_id: z.string() }),
      [runId, dealId],
      { label: "Precondition: module_runs exists" },
    );
    if (moduleRuns.length === 0) {
      throw new Error(
        `Precondition failed: no module_runs row for run=${runId}, deal=${dealId}, module=diligence_completeness`,
      );
    }

    // Preconditions 2–4: extract + verdict stage done, extract detail checks
    const stageStates = await ctx.integrations.db.query(
      `SELECT stage, status, cursor_value, detail
       FROM dcs_pipeline_state
       WHERE run_id = $1::uuid AND stage IN ('extract', 'verdicts')
       LIMIT 2`,
      StageStateRowSchema,
      [runId],
      { label: "Precondition: stage states" },
    );

    // Precondition 2: extract stage exists and is done
    const extractStage = stageStates.find((s) => s.stage === "extract");
    if (!extractStage || extractStage.status !== "done") {
      throw new Error(
        `Precondition failed: extract stage not done (status=${extractStage?.status ?? "missing"})`,
      );
    }

    // Precondition 3: extract detail proves completeness
    if (!extractStage.detail) {
      throw new Error("Precondition failed: extract stage has null detail.");
    }
    const detailParsed = ExtractDetailSchema.safeParse(JSON.parse(extractStage.detail));
    if (!detailParsed.success) {
      throw new Error(
        `Precondition failed: extract detail schema invalid: ${detailParsed.error.message.slice(0, 300)}`,
      );
    }
    const ext = detailParsed.data;
    if (ext.total_chunks === 0) {
      throw new Error("Precondition failed: total_chunks = 0.");
    }
    if (ext.processed_count !== ext.total_chunks) {
      throw new Error(
        `Precondition failed: extraction incomplete (processed=${ext.processed_count}, total=${ext.total_chunks}).`,
      );
    }
    if (extractStage.cursor_value !== ext.last_chunk_id) {
      throw new Error(
        `Precondition failed: cursor_value (${extractStage.cursor_value}) != last_chunk_id (${ext.last_chunk_id}).`,
      );
    }

    // Precondition 4: verdict stage done
    const verdictStage = stageStates.find((s) => s.stage === "verdicts");
    if (!verdictStage || verdictStage.status !== "done") {
      throw new Error(
        `Precondition failed: verdict stage not done (status=${verdictStage?.status ?? "missing"})`,
      );
    }

    // Preconditions 5–7: exactly 10 verdicts, each rubric dimension once, valid states
    const persistedVerdicts = await ctx.integrations.db.query(
      `SELECT dimension_id, state FROM dcs_dimension_verdicts
       WHERE run_id = $1
       LIMIT 11`,
      VerdictRowSchema,
      [runId],
      { label: "Precondition: verdict rows" },
    );
    if (persistedVerdicts.length !== DCS_DIMENSIONS.length) {
      throw new Error(
        `Precondition failed: expected ${DCS_DIMENSIONS.length} verdict rows, found ${persistedVerdicts.length}.`,
      );
    }
    const verdictDimIds = new Set(persistedVerdicts.map((v) => v.dimension_id));
    for (const dim of DCS_DIMENSIONS) {
      if (!verdictDimIds.has(dim.id)) {
        throw new Error(`Precondition failed: missing verdict for dimension ${dim.id}.`);
      }
    }
    for (const v of persistedVerdicts) {
      if (!VALID_STATES.has(v.state)) {
        throw new Error(
          `Precondition failed: invalid state "${v.state}" for ${v.dimension_id}.`,
        );
      }
    }

    // Preconditions 8–10: exactly one summary row, computed_in_code, dimension_count
    const summaryCheck = await ctx.integrations.db.query(
      `SELECT computed_in_code, dimension_count FROM dcs_run_summary
       WHERE run_id = $1
       LIMIT 2`,
      SummaryCheckRowSchema,
      [runId],
      { label: "Precondition: summary row" },
    );
    if (summaryCheck.length !== 1) {
      throw new Error(
        `Precondition failed: expected 1 summary row, found ${summaryCheck.length}.`,
      );
    }
    if (!summaryCheck[0].computed_in_code) {
      throw new Error("Precondition failed: computed_in_code is false.");
    }
    if (summaryCheck[0].dimension_count !== DCS_DIMENSIONS.length) {
      throw new Error(
        `Precondition failed: dimension_count=${summaryCheck[0].dimension_count}, expected ${DCS_DIMENSIONS.length}.`,
      );
    }

    // ── Build model input ───────────────────────────────────────
    // Convert persisted verdicts to the format needed for payload
    const normalVerdicts: VerificationVerdict[] = persistedVerdicts.map((v) => ({
      dimension_id: v.dimension_id,
      label: RUBRIC_LABELS[v.dimension_id],
      state: v.state,
      rationale: "", // rationale is NOT sent to model; only state-based gap basis is used
    }));

    const dealDescriptor = await loadDealDescriptor(ctx, dealId);
    const { userContent, audit } = buildModelPayload(dealDescriptor, normalVerdicts);

    if (audit.containsDigit || audit.containsForbiddenQuantitativeTerm) {
      throw new Error(
        `Prompt audit failed: containsDigit=${audit.containsDigit}, containsForbiddenQuantitativeTerm=${audit.containsForbiddenQuantitativeTerm}`,
      );
    }

    // ── Model call ──────────────────────────────────────────────
    const model = getModuleModel("diligence_completeness");
    const llmResponse = await callLLMWithHeadroom(
      pipelineCtx,
      {
        model,
        max_tokens: 512,
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: userContent }],
      },
      "DcsMaterialityOverlay: normal mode",
      {
        pipelineStartTime,
        maxPerCallTimeout: 60_000,
        retries: 2,
        minBudget: 30_000,
      },
    );

    const rawText = (llmResponse.content[0]?.text ?? "").trim();
    const validation = validateMaterialityOverlay(rawText);

    // ── Persistence ─────────────────────────────────────────────
    if (validation.accepted) {
      await ctx.integrations.db.execute(
        `UPDATE dcs_run_summary SET materiality_overlay = $1
         WHERE run_id = $2`,
        [validation.overlay, runId],
        { label: "Persist accepted overlay" },
      );
    } else {
      await ctx.integrations.db.execute(
        `UPDATE dcs_run_summary SET materiality_overlay = NULL
         WHERE run_id = $2`,
        [null, runId],
        { label: "Persist NULL for rejected overlay" },
      );
    }

    // ── Readback verification ───────────────────────────────────
    const readback = await ctx.integrations.db.query(
      `SELECT materiality_overlay FROM dcs_run_summary WHERE run_id = $1 LIMIT 1`,
      OverlayReadbackSchema,
      [runId],
      { label: "Readback overlay" },
    );
    const storedValue = readback[0]?.materiality_overlay ?? null;
    const expectedValue = validation.overlay;
    if (storedValue !== expectedValue) {
      throw new Error(
        `Readback mismatch: stored=${storedValue?.slice(0, 50) ?? "NULL"}, expected=${expectedValue?.slice(0, 50) ?? "NULL"}`,
      );
    }

    // ── Observability log ───────────────────────────────────────
    console.log(
      JSON.stringify({
        runId,
        mode,
        modelCalled: true,
        overlayAccepted: validation.accepted,
        persistedOverlay: true,
        rejectionCode: validation.rejectionCode,
      }),
    );

    return {
      runId,
      mode: "normal" as const,
      provisional: false,
      modelCalled: true,
      overlayAccepted: validation.accepted,
      overlay: validation.overlay,
      rejectionCode: validation.rejectionCode,
      persistedOverlay: true,
      modelInputAudit: {
        dimensionCount: normalVerdicts.length,
        ...audit,
      },
    };
  },
});

// ═════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════

async function loadDealDescriptor(
  ctx: { integrations: { db: { query: (...args: any[]) => Promise<any[]> } } },
  dealId: string,
): Promise<string> {
  const rows = await ctx.integrations.db.query(
    `SELECT name, description FROM deals WHERE id = $1 LIMIT 1`,
    DealDescriptorRowSchema,
    [dealId],
    { label: "Load deal descriptor" },
  );
  if (rows.length === 0) {
    throw new Error(`Deal not found: ${dealId}`);
  }
  const deal = rows[0];
  const name = (deal.name ?? "Unnamed Deal").replace(/\s+/g, " ").trim();
  const desc = (deal.description ?? "")
    .slice(0, 500)
    .replace(/\s+/g, " ")
    .trim();

  const raw = desc ? `${name} — ${desc}` : name;
  return sanitizeDealDescriptor(raw);
}

function buildModelPayload(
  dealDescriptor: string,
  verdicts: VerificationVerdict[],
): { userContent: string; audit: ReturnType<typeof auditPromptPayload> } {
  const dimensionLines = verdicts
    .map((v) => {
      const state = v.state as DimensionState;
      const rubricDesc = RUBRIC_DESCRIPTIONS[v.dimension_id] ?? "";
      return `- ${v.label} (${rubricDesc}): ${GAP_BASIS[state]}`;
    })
    .join("\n");

  const userContent = `DEAL: ${dealDescriptor}

DIMENSION EVIDENCE STATES:
${dimensionLines}

Based on the evidence states above, write a materiality overlay paragraph for this deal.`;

  const audit = auditPromptPayload(userContent);
  return { userContent, audit };
}

// ── System prompt ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a diligence analyst writing a materiality overlay for an investment committee.

Write exactly one paragraph of three to five sentences in plain prose.

Identify which asserted or absent evidence gaps matter most for this specific deal and explain why those gaps matter to an IC decision. Distinguish your qualitative judgment from the objective evidence state.

Do not claim that an evidenced dimension is fully or adequately diligenced. Do not invent facts, documents, analyses, or findings not described in the evidence states.

You must not:
- State or estimate any score, count, grade, rating, percentage, or quantitative ranking
- Use any arithmetic or numbers
- Refer to "out of ten"
- Claim the data room is complete
- Recommend that the investment be approved or rejected
- Use headings, bullet points, numbered lists, or tables`;
