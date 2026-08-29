/**
 * DCS Compute Summary — Phase 3B of the DCS rebuild.
 *
 * Converts exactly ten valid dimension verdicts into a headline score,
 * state counts, and a persisted dcs_run_summary row in production mode.
 * Verification mode returns a read-only provisional summary.
 *
 * This API is model-free: no Anthropic calls, no getModuleModel, no
 * callLLMWithHeadroom. All scoring is code-deterministic via dcs-rubric.ts.
 *
 * It does not extract documents, recompute dimension verdicts, render a
 * report, publish module output, or calculate a materiality overlay.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  DCS_DIMENSIONS,
  SCORE_VALUES,
  computeHeadlineScore,
} from "./dcs-rubric.js";
import type { DimensionState } from "./dcs-rubric.js";

// ── Integration ID ───────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Valid dimension IDs and states ───────────────────────────────
const VALID_DIMENSION_IDS = new Set(DCS_DIMENSIONS.map((d) => d.id));
const VALID_STATES: Set<string> = new Set(["absent", "asserted", "evidenced"]);

// ── Zod schemas ──────────────────────────────────────────────────

const ExtractDetailSchema = z.object({
  processed_count: z.number(),
  empty_chunk_count: z.number(),
  evidence_rows_written: z.number(),
  fabrication_rejected: z.number(),
  invalid_dimension_rejected: z.number(),
  duplicate_dimension_rejected: z.number(),
  total_chunks: z.number(),
  last_chunk_id: z.string(),
});

const VerificationVerdictSchema = z.object({
  dimension_id: z.string(),
  state: z.enum(["absent", "asserted", "evidenced"]),
  score_value: z.number(),
});
type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

const CoverageBasisSchema = z.object({
  extraction_status: z.string(),
  processed_chunks: z.number(),
  total_chunks: z.number(),
  coverage_complete: z.boolean(),
  evidence_rows: z.number(),
  verdict_stage_status: z.string(),
  verdict_dimension_count: z.number(),
  scoring_method: z.literal("source_class_deterministic_v1"),
  score_scale: z.object({
    absent: z.literal(0),
    asserted: z.literal(0.5),
    evidenced: z.literal(1),
  }),
  provisional: z.boolean(),
});
type CoverageBasis = z.infer<typeof CoverageBasisSchema>;

const OrderedVerdictSchema = z.object({
  dimension_id: z.string(),
  state: z.string(),
  score_value: z.number(),
});

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════
export default api({
  name: "DcsComputeSummary",
  description: "Computes deterministic headline summary from DCS dimension verdicts",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
    verificationMode: z.boolean().default(false),
    verificationVerdicts: z
      .array(VerificationVerdictSchema)
      .optional()
      .nullable(),
  }),

  output: z.object({
    runId: z.string(),
    mode: z.string(),
    provisional: z.boolean(),
    coverageComplete: z.boolean(),
    headlineScore: z.number(),
    evidencedCount: z.number(),
    assertedCount: z.number(),
    absentCount: z.number(),
    dimensionCount: z.number(),
    coverageBasis: CoverageBasisSchema,
    materialityOverlay: z.string().nullable(),
    computedInCode: z.boolean(),
    persistedSummary: z.boolean(),
    orderedVerdicts: z.array(OrderedVerdictSchema),
  }),

  async run(ctx, input) {
    const db = ctx.integrations.ic_diligence_db;
    const isVerification = input.verificationMode;

    // ── 1. Input mode guards ───────────────────────────────────
    if (isVerification && (!input.verificationVerdicts || input.verificationVerdicts.length === 0)) {
      throw new Error(
        "Verification mode requires verificationVerdicts to be provided.",
      );
    }
    if (!isVerification && input.verificationVerdicts && input.verificationVerdicts.length > 0) {
      throw new Error(
        "Normal mode must not receive verificationVerdicts. Remove verificationVerdicts or set verificationMode=true.",
      );
    }

    // ── 2. Run validation ──────────────────────────────────────
    const runCheck = await db.query(
      `SELECT id FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string() }),
      [input.runId, input.dealId],
      { label: "DcsSummary: validate module_runs" },
    );
    if (runCheck.length === 0) {
      throw new Error(
        `No module_runs row for runId=${input.runId} with dealId=${input.dealId} and module_id=diligence_completeness`,
      );
    }

    // ── 3. Load extract-stage state ────────────────────────────
    const extractState = await db.query(
      `SELECT id, status, cursor_value, detail
       FROM dcs_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'extract'
       LIMIT 1`,
      z.object({
        id: z.string(),
        status: z.string(),
        cursor_value: z.string().nullable(),
        detail: z.string().nullable(),
      }),
      [input.runId],
      { label: "DcsSummary: load extract state" },
    );

    if (extractState.length === 0) {
      throw new Error(
        `No extract-stage dcs_pipeline_state row for runId=${input.runId}. Extraction has not started.`,
      );
    }

    const extract = extractState[0];
    if (!extract.detail) {
      throw new Error(
        `Extract-stage state has null detail for runId=${input.runId}.`,
      );
    }

    const detailParsed = ExtractDetailSchema.safeParse(JSON.parse(extract.detail));
    if (!detailParsed.success) {
      throw new Error(
        `Extract detail schema validation failed: ${detailParsed.error.message.slice(0, 300)}`,
      );
    }
    const detail = detailParsed.data;

    // ── 4. Coverage completeness ───────────────────────────────
    const coverageComplete =
      extract.status === "done" &&
      detail.processed_count === detail.total_chunks &&
      detail.total_chunks > 0 &&
      extract.cursor_value === detail.last_chunk_id;

    // ── 5. Actual evidence row count ───────────────────────────
    const evidenceCountResult = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM dcs_evidence WHERE run_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      [input.runId],
      { label: "DcsSummary: count evidence rows" },
    );
    const actualEvidenceCount = evidenceCountResult[0].cnt;

    // ── 6. Normal-mode extraction gate ─────────────────────────
    if (!isVerification) {
      if (!coverageComplete) {
        throw new Error(
          `Extraction incomplete: status=${extract.status}, processed=${detail.processed_count}/${detail.total_chunks}. ` +
          `Coverage must be complete before computing summary in normal mode.`,
        );
      }
      if (detail.evidence_rows_written !== actualEvidenceCount) {
        throw new Error(
          `Evidence count mismatch: detail.evidence_rows_written=${detail.evidence_rows_written} ` +
          `but actual dcs_evidence rows=${actualEvidenceCount}. Data integrity check failed.`,
        );
      }
    }

    // ── 7. Load and validate verdicts ──────────────────────────
    let rawVerdicts: Array<{ dimension_id: string; state: string; score_value: number }>;

    if (isVerification) {
      // Use supplied verification verdicts
      rawVerdicts = input.verificationVerdicts!.map((v) => ({
        dimension_id: v.dimension_id,
        state: v.state,
        score_value: v.score_value,
      }));
    } else {
      // Normal mode: read from persisted verdicts with full precondition checks

      // 7a. Verdict-stage state must exist and be done
      const verdictState = await db.query(
        `SELECT id, status, detail
         FROM dcs_pipeline_state
         WHERE run_id = $1::uuid AND stage = 'verdicts'
         LIMIT 1`,
        z.object({
          id: z.string(),
          status: z.string(),
          detail: z.string().nullable(),
        }),
        [input.runId],
        { label: "DcsSummary: load verdict-stage state" },
      );

      if (verdictState.length === 0) {
        throw new Error(
          `No verdict-stage dcs_pipeline_state row for runId=${input.runId}. Verdicts have not been computed.`,
        );
      }

      if (verdictState[0].status !== "done") {
        throw new Error(
          `Verdict-stage status is '${verdictState[0].status}', expected 'done'. Cannot compute summary until verdicts are finalized.`,
        );
      }

      // 7b. Parse verdict-stage detail and validate
      if (!verdictState[0].detail) {
        throw new Error(
          `Verdict-stage state has null detail for runId=${input.runId}.`,
        );
      }

      const verdictDetail = JSON.parse(verdictState[0].detail);

      if (verdictDetail.dimension_count !== 10) {
        throw new Error(
          `Verdict-stage detail dimension_count=${verdictDetail.dimension_count}, expected 10.`,
        );
      }
      if (verdictDetail.coverage_complete !== true) {
        throw new Error(
          `Verdict-stage detail coverage_complete=${verdictDetail.coverage_complete}, expected true.`,
        );
      }

      // 7c. Read persisted verdicts
      const persistedVerdicts = await db.query(
        `SELECT dimension_id, state, score_value
         FROM dcs_dimension_verdicts
         WHERE run_id = $1::uuid
         ORDER BY dimension_id`,
        z.object({
          dimension_id: z.string(),
          state: z.string(),
          score_value: z.string(), // NUMERIC returned as string
        }),
        [input.runId],
        { label: "DcsSummary: read persisted verdicts" },
      );

      if (persistedVerdicts.length !== 10) {
        throw new Error(
          `Expected exactly 10 persisted verdict rows, got ${persistedVerdicts.length}.`,
        );
      }

      // 7d. Cross-validate verdict-stage counts against actual rows
      const persistedCounts = { evidenced: 0, asserted: 0, absent: 0 };
      for (const pv of persistedVerdicts) {
        if (pv.state === "evidenced") persistedCounts.evidenced++;
        else if (pv.state === "asserted") persistedCounts.asserted++;
        else if (pv.state === "absent") persistedCounts.absent++;
      }

      if (verdictDetail.evidenced_count !== persistedCounts.evidenced) {
        throw new Error(
          `Verdict-stage evidenced_count=${verdictDetail.evidenced_count} but actual=${persistedCounts.evidenced}.`,
        );
      }
      if (verdictDetail.asserted_count !== persistedCounts.asserted) {
        throw new Error(
          `Verdict-stage asserted_count=${verdictDetail.asserted_count} but actual=${persistedCounts.asserted}.`,
        );
      }
      if (verdictDetail.absent_count !== persistedCounts.absent) {
        throw new Error(
          `Verdict-stage absent_count=${verdictDetail.absent_count} but actual=${persistedCounts.absent}.`,
        );
      }

      // 7e. Cross-validate evidence_count sum against actual evidence rows
      const evidenceSumResult = await db.query(
        `SELECT COALESCE(SUM(evidence_count), 0)::int AS total
         FROM dcs_dimension_verdicts
         WHERE run_id = $1::uuid`,
        z.object({ total: z.number() }),
        [input.runId],
        { label: "DcsSummary: sum verdict evidence_count" },
      );

      if (evidenceSumResult[0].total !== actualEvidenceCount) {
        throw new Error(
          `Sum of persisted verdict evidence_count=${evidenceSumResult[0].total} ` +
          `but actual dcs_evidence rows=${actualEvidenceCount}. Data integrity check failed.`,
        );
      }

      rawVerdicts = persistedVerdicts.map((pv) => ({
        dimension_id: pv.dimension_id,
        state: pv.state,
        score_value: parseFloat(pv.score_value),
      }));
    }

    // ── 8. Shared verdict validation ───────────────────────────
    // 8a. Exactly ten verdicts
    if (rawVerdicts.length !== 10) {
      throw new Error(
        `Expected exactly 10 verdicts, got ${rawVerdicts.length}.`,
      );
    }

    // 8b. Each rubric dimension exactly once
    const seenDims = new Set<string>();
    for (const v of rawVerdicts) {
      if (!VALID_DIMENSION_IDS.has(v.dimension_id)) {
        throw new Error(
          `Unknown dimension_id '${v.dimension_id}' not in DCS rubric.`,
        );
      }
      if (seenDims.has(v.dimension_id)) {
        throw new Error(
          `Duplicate dimension_id '${v.dimension_id}' in verdicts.`,
        );
      }
      seenDims.add(v.dimension_id);
    }

    // 8c. Each rubric dimension must be present
    for (const dim of DCS_DIMENSIONS) {
      if (!seenDims.has(dim.id)) {
        throw new Error(
          `Missing required dimension '${dim.id}' from verdicts.`,
        );
      }
    }

    // 8d. Validate states and score-state consistency
    for (const v of rawVerdicts) {
      if (!VALID_STATES.has(v.state)) {
        throw new Error(
          `Invalid state '${v.state}' for dimension '${v.dimension_id}'. Must be absent, asserted, or evidenced.`,
        );
      }
      const expectedScore = SCORE_VALUES[v.state as DimensionState];
      if (v.score_value !== expectedScore) {
        throw new Error(
          `Score mismatch for dimension '${v.dimension_id}': state '${v.state}' requires score_value ${expectedScore}, got ${v.score_value}.`,
        );
      }
    }

    // 8e. Sort into rubric order
    const dimOrder = new Map(DCS_DIMENSIONS.map((d, i) => [d.id, i]));
    rawVerdicts.sort((a, b) => dimOrder.get(a.dimension_id)! - dimOrder.get(b.dimension_id)!);

    // 8f. Count states
    const evidencedCount = rawVerdicts.filter((v) => v.state === "evidenced").length;
    const assertedCount = rawVerdicts.filter((v) => v.state === "asserted").length;
    const absentCount = rawVerdicts.filter((v) => v.state === "absent").length;

    // 8g. Sum must be 10
    if (evidencedCount + assertedCount + absentCount !== 10) {
      throw new Error(
        `State counts do not sum to 10: evidenced=${evidencedCount}, asserted=${assertedCount}, absent=${absentCount}.`,
      );
    }

    // ── 9. Compute headline score ──────────────────────────────
    const headlineScore = computeHeadlineScore(rawVerdicts);

    // ── 10. Build coverage basis ───────────────────────────────
    const provisional = isVerification ? !coverageComplete : false;

    const coverageBasis: CoverageBasis = {
      extraction_status: extract.status,
      processed_chunks: detail.processed_count,
      total_chunks: detail.total_chunks,
      coverage_complete: coverageComplete,
      evidence_rows: actualEvidenceCount,
      verdict_stage_status: isVerification ? "verification" : "done",
      verdict_dimension_count: 10,
      scoring_method: "source_class_deterministic_v1",
      score_scale: {
        absent: 0,
        asserted: 0.5,
        evidenced: 1,
      },
      provisional,
    };

    // ── 11. Build ordered verdicts ─────────────────────────────
    const orderedVerdicts = rawVerdicts.map((v) => ({
      dimension_id: v.dimension_id,
      state: v.state,
      score_value: v.score_value,
    }));

    // ── 12. Verification mode: return without writes ───────────
    if (isVerification) {
      return {
        runId: input.runId,
        mode: "verification",
        provisional,
        coverageComplete,
        headlineScore,
        evidencedCount,
        assertedCount,
        absentCount,
        dimensionCount: 10,
        coverageBasis,
        materialityOverlay: null,
        computedInCode: true,
        persistedSummary: false,
        orderedVerdicts,
      };
    }

    // ── 13. Normal mode: persist summary ───────────────────────
    await db.execute(
      `INSERT INTO dcs_run_summary
         (run_id, headline_score, evidenced_count, asserted_count, absent_count,
          dimension_count, coverage_basis, computed_in_code, created_at)
       VALUES
         ($1::uuid, $2::numeric, $3::int, $4::int, $5::int,
          $6::int, $7::jsonb, true, now())
       ON CONFLICT (run_id) DO UPDATE SET
         headline_score = EXCLUDED.headline_score,
         evidenced_count = EXCLUDED.evidenced_count,
         asserted_count = EXCLUDED.asserted_count,
         absent_count = EXCLUDED.absent_count,
         dimension_count = EXCLUDED.dimension_count,
         coverage_basis = EXCLUDED.coverage_basis,
         computed_in_code = EXCLUDED.computed_in_code,
         created_at = now()`,
      [
        input.runId,
        headlineScore,
        evidencedCount,
        assertedCount,
        absentCount,
        10,
        JSON.stringify(coverageBasis),
      ],
      { label: "DcsSummary: upsert dcs_run_summary" },
    );

    // ── 14. Read back and verify ───────────────────────────────
    const readback = await db.query(
      `SELECT headline_score, evidenced_count, asserted_count, absent_count,
              dimension_count, coverage_basis, computed_in_code
       FROM dcs_run_summary
       WHERE run_id = $1::uuid
       LIMIT 1`,
      z.object({
        headline_score: z.coerce.number(),
        evidenced_count: z.number(),
        asserted_count: z.number(),
        absent_count: z.number(),
        dimension_count: z.number(),
        coverage_basis: z.any(),
        computed_in_code: z.boolean(),
      }),
      [input.runId],
      { label: "DcsSummary: readback summary" },
    );

    if (readback.length === 0) {
      throw new Error("Summary readback returned no rows after upsert.");
    }

    const rb = readback[0];

    if (rb.headline_score !== headlineScore) {
      throw new Error(
        `Readback headline_score=${rb.headline_score}, expected ${headlineScore}.`,
      );
    }
    if (rb.evidenced_count !== evidencedCount) {
      throw new Error(
        `Readback evidenced_count=${rb.evidenced_count}, expected ${evidencedCount}.`,
      );
    }
    if (rb.asserted_count !== assertedCount) {
      throw new Error(
        `Readback asserted_count=${rb.asserted_count}, expected ${assertedCount}.`,
      );
    }
    if (rb.absent_count !== absentCount) {
      throw new Error(
        `Readback absent_count=${rb.absent_count}, expected ${absentCount}.`,
      );
    }
    if (rb.dimension_count !== 10) {
      throw new Error(
        `Readback dimension_count=${rb.dimension_count}, expected 10.`,
      );
    }
    if (rb.computed_in_code !== true) {
      throw new Error(
        `Readback computed_in_code=${rb.computed_in_code}, expected true.`,
      );
    }

    // Verify coverage_basis matches (semantic, order-independent)
    const rbBasisRaw = typeof rb.coverage_basis === "string"
      ? JSON.parse(rb.coverage_basis)
      : rb.coverage_basis;
    const rbBasisParsed = CoverageBasisSchema.safeParse(rbBasisRaw);
    if (!rbBasisParsed.success) {
      throw new Error(
        `Persisted coverage_basis failed schema validation: ${rbBasisParsed.error.message.slice(0, 300)}`,
      );
    }
    const rbBasis = rbBasisParsed.data;

    // Field-by-field semantic comparison
    const basisFields: Array<{ field: string; expected: unknown; actual: unknown }> = [
      { field: "extraction_status", expected: coverageBasis.extraction_status, actual: rbBasis.extraction_status },
      { field: "processed_chunks", expected: coverageBasis.processed_chunks, actual: rbBasis.processed_chunks },
      { field: "total_chunks", expected: coverageBasis.total_chunks, actual: rbBasis.total_chunks },
      { field: "coverage_complete", expected: coverageBasis.coverage_complete, actual: rbBasis.coverage_complete },
      { field: "evidence_rows", expected: coverageBasis.evidence_rows, actual: rbBasis.evidence_rows },
      { field: "verdict_stage_status", expected: coverageBasis.verdict_stage_status, actual: rbBasis.verdict_stage_status },
      { field: "verdict_dimension_count", expected: coverageBasis.verdict_dimension_count, actual: rbBasis.verdict_dimension_count },
      { field: "scoring_method", expected: coverageBasis.scoring_method, actual: rbBasis.scoring_method },
      { field: "provisional", expected: coverageBasis.provisional, actual: rbBasis.provisional },
      { field: "score_scale.absent", expected: coverageBasis.score_scale.absent, actual: rbBasis.score_scale.absent },
      { field: "score_scale.asserted", expected: coverageBasis.score_scale.asserted, actual: rbBasis.score_scale.asserted },
      { field: "score_scale.evidenced", expected: coverageBasis.score_scale.evidenced, actual: rbBasis.score_scale.evidenced },
    ];
    for (const { field, expected, actual } of basisFields) {
      if (actual !== expected) {
        throw new Error(
          `Readback coverage_basis.${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
        );
      }
    }

    return {
      runId: input.runId,
      mode: "normal",
      provisional: false,
      coverageComplete: true,
      headlineScore,
      evidencedCount,
      assertedCount,
      absentCount,
      dimensionCount: 10,
      coverageBasis,
      materialityOverlay: null,
      computedInCode: true,
      persistedSummary: true,
      orderedVerdicts,
    };
  },
});
