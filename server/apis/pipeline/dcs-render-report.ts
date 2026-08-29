/**
 * DCS Render Report — Phase 3C of the DCS rebuild.
 *
 * Converts validated Phase 3A dimension verdicts and Phase 3B summary into
 * a structured ten-dimension scorecard, executive header, deterministic
 * Markdown, and a deterministic report hash.
 *
 * This API is model-free: no Anthropic calls, no getModuleModel, no
 * callLLMWithHeadroom, no FormatReport. No model may write, summarize,
 * interpret or format the report.
 *
 * Does not extract documents, recompute verdicts/scoring, publish to
 * module_outputs, complete the module run, generate IC recommendations,
 * or begin orchestration.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  DCS_DIMENSIONS,
  SCORE_VALUES,
  computeHeadlineScore,
} from "./dcs-rubric.js";
import type { DimensionState } from "./dcs-rubric.js";
import { renderDcsScorecard } from "./dcs-report-renderer.js";
import type { DimensionRecord } from "./dcs-report-renderer.js";

// ── Integration ID ───────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Valid dimension IDs from the rubric ──────────────────────────
const VALID_DIMENSION_IDS = new Set(DCS_DIMENSIONS.map((d) => d.id));
const RUBRIC_DIM_MAP = new Map(DCS_DIMENSIONS.map((d) => [d.id, d]));

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
  label: z.string(),
  state: z.enum(["absent", "asserted", "evidenced"]),
  score_value: z.number(),
  evidence_count: z.number(),
  promoting_chunk_id: z.string().nullable(),
  promoting_source_file: z.string().nullable(),
  rationale: z.string(),
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

const VerificationSummarySchema = z.object({
  headlineScore: z.number(),
  evidencedCount: z.number(),
  assertedCount: z.number(),
  absentCount: z.number(),
  dimensionCount: z.number(),
  coverageBasis: CoverageBasisSchema,
  computedInCode: z.boolean(),
});
type VerificationSummary = z.infer<typeof VerificationSummarySchema>;

const DimensionRecordSchema = z.object({
  dimension_id: z.string(),
  label: z.string(),
  state: z.enum(["evidenced", "asserted", "absent"]),
  score_value: z.number(),
  evidence_count: z.number(),
  promoting_chunk_id: z.string().nullable(),
  promoting_source_file: z.string().nullable(),
  rationale: z.string(),
  representative_snippet: z.string().nullable(),
  representative_doc_class: z.string().nullable(),
  representative_is_substantive: z.boolean().nullable(),
});

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════
export default api({
  name: "DcsRenderReport",
  description: "Renders deterministic DCS scorecard from validated verdicts and summary",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
    verificationMode: z.boolean().default(false),
    verificationVerdicts: z.array(VerificationVerdictSchema).optional().nullable(),
    verificationSummary: VerificationSummarySchema.optional().nullable(),
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
    executiveHeader: z.string(),
    fullReportMarkdown: z.string(),
    reportHash: z.string(),
    dimensions: z.array(DimensionRecordSchema),
    persistedRenderState: z.boolean(),
    renderStageStatus: z.string(),
  }),

  async run(ctx, input) {
    const db = ctx.integrations.ic_diligence_db;
    const isVerification = input.verificationMode;

    // ═══════════════════════════════════════════════════════════════
    // 1. Input mode guards
    // ═══════════════════════════════════════════════════════════════
    if (isVerification) {
      if (!input.verificationVerdicts || input.verificationVerdicts.length === 0) {
        throw new Error("Verification mode requires verificationVerdicts.");
      }
      if (!input.verificationSummary) {
        throw new Error("Verification mode requires verificationSummary.");
      }
    } else {
      if (input.verificationVerdicts && input.verificationVerdicts.length > 0) {
        throw new Error(
          "Normal mode must not receive verificationVerdicts. Remove verificationVerdicts or set verificationMode=true.",
        );
      }
      if (input.verificationSummary) {
        throw new Error(
          "Normal mode must not receive verificationSummary. Remove verificationSummary or set verificationMode=true.",
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. Run validation
    // ═══════════════════════════════════════════════════════════════
    const runCheck = await db.query(
      `SELECT id FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string() }),
      [input.runId, input.dealId],
      { label: "DcsRender: validate module_runs" },
    );
    if (runCheck.length === 0) {
      throw new Error(
        `No module_runs row for runId=${input.runId} with dealId=${input.dealId} and module_id=diligence_completeness`,
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. Load extract-stage state
    // ═══════════════════════════════════════════════════════════════
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
      { label: "DcsRender: load extract state" },
    );

    if (extractState.length === 0) {
      throw new Error(
        `No extract-stage dcs_pipeline_state row for runId=${input.runId}.`,
      );
    }

    const extract = extractState[0];
    if (!extract.detail) {
      throw new Error(`Extract-stage state has null detail for runId=${input.runId}.`);
    }

    const detailParsed = ExtractDetailSchema.safeParse(JSON.parse(extract.detail));
    if (!detailParsed.success) {
      throw new Error(
        `Extract detail schema validation failed: ${detailParsed.error.message.slice(0, 300)}`,
      );
    }
    const extractDetail = detailParsed.data;

    // ═══════════════════════════════════════════════════════════════
    // 4. Coverage completeness
    // ═══════════════════════════════════════════════════════════════
    const coverageComplete =
      extract.status === "done" &&
      extractDetail.processed_count === extractDetail.total_chunks &&
      extractDetail.total_chunks > 0 &&
      extract.cursor_value === extractDetail.last_chunk_id;

    // ═══════════════════════════════════════════════════════════════
    // 5. Actual evidence row count
    // ═══════════════════════════════════════════════════════════════
    const evidenceCountResult = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM dcs_evidence WHERE run_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      [input.runId],
      { label: "DcsRender: count evidence rows" },
    );
    const actualEvidenceCount = evidenceCountResult[0].cnt;

    // ═══════════════════════════════════════════════════════════════
    // 6. Load verdicts and summary (mode-dependent)
    // ═══════════════════════════════════════════════════════════════
    let verdicts: VerificationVerdict[];
    let headlineScore: number;
    let evidencedCount: number;
    let assertedCount: number;
    let absentCount: number;

    if (isVerification) {
      // ─── Verification mode: use supplied payloads ──────────────
      verdicts = input.verificationVerdicts!;
      const summary = input.verificationSummary!;

      // 6a. Validate verdict structure: exactly 10, unique rubric dims
      if (verdicts.length !== 10) {
        throw new Error(`Expected exactly 10 verificationVerdicts, got ${verdicts.length}.`);
      }

      const seenDims = new Set<string>();
      for (const v of verdicts) {
        if (!VALID_DIMENSION_IDS.has(v.dimension_id)) {
          throw new Error(`Unknown dimension_id '${v.dimension_id}' not in DCS rubric.`);
        }
        if (seenDims.has(v.dimension_id)) {
          throw new Error(`Duplicate dimension_id '${v.dimension_id}' in verificationVerdicts.`);
        }
        seenDims.add(v.dimension_id);

        // Label must match rubric
        const rubricDim = RUBRIC_DIM_MAP.get(v.dimension_id)!;
        if (v.label !== rubricDim.label) {
          throw new Error(
            `Verdict label mismatch for '${v.dimension_id}': expected '${rubricDim.label}', got '${v.label}'.`,
          );
        }

        // Score must match state
        const expectedScore = SCORE_VALUES[v.state as DimensionState];
        if (v.score_value !== expectedScore) {
          throw new Error(
            `Score mismatch for '${v.dimension_id}': state '${v.state}' requires ${expectedScore}, got ${v.score_value}.`,
          );
        }

        // Absent constraints
        if (v.state === "absent") {
          if (v.evidence_count !== 0) {
            throw new Error(
              `Absent dimension '${v.dimension_id}' must have evidence_count=0, got ${v.evidence_count}.`,
            );
          }
          if (v.promoting_chunk_id !== null || v.promoting_source_file !== null) {
            throw new Error(
              `Absent dimension '${v.dimension_id}' must have null promoting fields.`,
            );
          }
        } else {
          // Non-absent constraints
          if (v.evidence_count <= 0) {
            throw new Error(
              `Non-absent dimension '${v.dimension_id}' must have evidence_count > 0, got ${v.evidence_count}.`,
            );
          }
          if (!v.promoting_chunk_id || !v.promoting_source_file) {
            throw new Error(
              `Non-absent dimension '${v.dimension_id}' must have both promoting fields populated.`,
            );
          }
        }
      }

      // Sort into rubric order
      const dimOrder = new Map(DCS_DIMENSIONS.map((d, i) => [d.id, i]));
      verdicts = [...verdicts].sort(
        (a, b) => dimOrder.get(a.dimension_id)! - dimOrder.get(b.dimension_id)!,
      );

      // 6b. Validate summary
      if (summary.dimensionCount !== 10) {
        throw new Error(`Summary dimensionCount must be 10, got ${summary.dimensionCount}.`);
      }
      if (summary.computedInCode !== true) {
        throw new Error(`Summary computedInCode must be true, got ${summary.computedInCode}.`);
      }

      // Validate coverageBasis
      const cb = summary.coverageBasis;
      if (cb.scoring_method !== "source_class_deterministic_v1") {
        throw new Error(
          `Summary coverageBasis.scoring_method must be 'source_class_deterministic_v1', got '${cb.scoring_method}'.`,
        );
      }
      if (cb.score_scale.absent !== 0 || cb.score_scale.asserted !== 0.5 || cb.score_scale.evidenced !== 1) {
        throw new Error(`Summary coverageBasis.score_scale must be {absent:0, asserted:0.5, evidenced:1}.`);
      }

      // Coverage basis must match actual extract state
      if (cb.extraction_status !== extract.status) {
        throw new Error(
          `Summary coverageBasis.extraction_status='${cb.extraction_status}' does not match actual '${extract.status}'.`,
        );
      }
      if (cb.processed_chunks !== extractDetail.processed_count) {
        throw new Error(
          `Summary coverageBasis.processed_chunks=${cb.processed_chunks} does not match actual ${extractDetail.processed_count}.`,
        );
      }
      if (cb.total_chunks !== extractDetail.total_chunks) {
        throw new Error(
          `Summary coverageBasis.total_chunks=${cb.total_chunks} does not match actual ${extractDetail.total_chunks}.`,
        );
      }
      if (cb.evidence_rows !== actualEvidenceCount) {
        throw new Error(
          `Summary coverageBasis.evidence_rows=${cb.evidence_rows} does not match actual ${actualEvidenceCount}.`,
        );
      }
      if (cb.coverage_complete !== coverageComplete) {
        throw new Error(
          `Summary coverageBasis.coverage_complete=${cb.coverage_complete} does not match actual ${coverageComplete}.`,
        );
      }

      // Provisional flag
      const expectedProvisional = !coverageComplete;
      if (cb.provisional !== expectedProvisional) {
        throw new Error(
          `Summary coverageBasis.provisional=${cb.provisional} but expected ${expectedProvisional}.`,
        );
      }

      // Count verdicts and verify summary counts match
      const vCounts = { evidenced: 0, asserted: 0, absent: 0 };
      for (const v of verdicts) {
        vCounts[v.state as DimensionState]++;
      }

      if (summary.evidencedCount !== vCounts.evidenced) {
        throw new Error(
          `Summary evidencedCount=${summary.evidencedCount} does not match verdicts (${vCounts.evidenced}).`,
        );
      }
      if (summary.assertedCount !== vCounts.asserted) {
        throw new Error(
          `Summary assertedCount=${summary.assertedCount} does not match verdicts (${vCounts.asserted}).`,
        );
      }
      if (summary.absentCount !== vCounts.absent) {
        throw new Error(
          `Summary absentCount=${summary.absentCount} does not match verdicts (${vCounts.absent}).`,
        );
      }

      // Headline score must match independent computation
      const computedScore = computeHeadlineScore(verdicts);
      if (summary.headlineScore !== computedScore) {
        throw new Error(
          `Summary headlineScore=${summary.headlineScore} does not match computed ${computedScore}.`,
        );
      }

      headlineScore = summary.headlineScore;
      evidencedCount = summary.evidencedCount;
      assertedCount = summary.assertedCount;
      absentCount = summary.absentCount;
    } else {
      // ─── Normal mode: read from database ────────────────────────

      // 6c. Extract preconditions
      if (extract.status !== "done") {
        throw new Error(`Extract stage status is '${extract.status}', expected 'done'.`);
      }
      if (extractDetail.processed_count !== extractDetail.total_chunks) {
        throw new Error(
          `Extract incomplete: processed=${extractDetail.processed_count}/${extractDetail.total_chunks}.`,
        );
      }
      if (extractDetail.total_chunks <= 0) {
        throw new Error(`Extract total_chunks must be > 0, got ${extractDetail.total_chunks}.`);
      }
      if (extract.cursor_value !== extractDetail.last_chunk_id) {
        throw new Error(`Extract cursor_value does not match last_chunk_id.`);
      }
      if (extractDetail.evidence_rows_written !== actualEvidenceCount) {
        throw new Error(
          `Extract evidence_rows_written=${extractDetail.evidence_rows_written} but actual=${actualEvidenceCount}.`,
        );
      }

      // 6d. Verdict-stage preconditions
      const verdictState = await db.query(
        `SELECT status, detail
         FROM dcs_pipeline_state
         WHERE run_id = $1::uuid AND stage = 'verdicts'
         LIMIT 1`,
        z.object({ status: z.string(), detail: z.string().nullable() }),
        [input.runId],
        { label: "DcsRender: load verdict-stage state" },
      );

      if (verdictState.length === 0) {
        throw new Error(`No verdict-stage state for runId=${input.runId}.`);
      }
      if (verdictState[0].status !== "done") {
        throw new Error(
          `Verdict stage status is '${verdictState[0].status}', expected 'done'.`,
        );
      }

      const vDetail = verdictState[0].detail ? JSON.parse(verdictState[0].detail) : {};
      if (vDetail.coverage_complete !== true) {
        throw new Error(`Verdict-stage coverage_complete must be true.`);
      }

      // 6e. Read persisted verdicts
      const persistedVerdicts = await db.query(
        `SELECT dimension_id, state, score_value, promoting_chunk_id,
                promoting_source_file, evidence_count, rationale
         FROM dcs_dimension_verdicts
         WHERE run_id = $1::uuid
         ORDER BY dimension_id`,
        z.object({
          dimension_id: z.string(),
          state: z.string(),
          score_value: z.string(),
          promoting_chunk_id: z.string().nullable(),
          promoting_source_file: z.string().nullable(),
          evidence_count: z.number(),
          rationale: z.string().nullable(),
        }),
        [input.runId],
        { label: "DcsRender: read persisted verdicts" },
      );

      if (persistedVerdicts.length !== 10) {
        throw new Error(`Expected 10 persisted verdicts, got ${persistedVerdicts.length}.`);
      }

      // Validate verdict detail counts match
      if (vDetail.dimension_count !== 10) {
        throw new Error(
          `Verdict-stage dimension_count=${vDetail.dimension_count}, expected 10.`,
        );
      }

      // Cross-validate counts
      const pCounts = { evidenced: 0, asserted: 0, absent: 0 };
      for (const pv of persistedVerdicts) {
        if (pv.state === "evidenced") pCounts.evidenced++;
        else if (pv.state === "asserted") pCounts.asserted++;
        else if (pv.state === "absent") pCounts.absent++;
      }

      if (vDetail.evidenced_count !== pCounts.evidenced ||
          vDetail.asserted_count !== pCounts.asserted ||
          vDetail.absent_count !== pCounts.absent) {
        throw new Error(
          `Verdict-stage detail counts do not match persisted verdict rows.`,
        );
      }

      // Convert to VerificationVerdict format for uniform processing
      verdicts = persistedVerdicts.map((pv) => {
        const rubricDim = RUBRIC_DIM_MAP.get(pv.dimension_id);
        if (!rubricDim) {
          throw new Error(`Unknown persisted dimension_id '${pv.dimension_id}'.`);
        }
        return {
          dimension_id: pv.dimension_id,
          label: rubricDim.label,
          state: pv.state as "absent" | "asserted" | "evidenced",
          score_value: parseFloat(pv.score_value),
          evidence_count: pv.evidence_count,
          promoting_chunk_id: pv.promoting_chunk_id,
          promoting_source_file: pv.promoting_source_file,
          rationale: pv.rationale ?? "",
        };
      });

      // Sort into rubric order
      const dimOrder = new Map(DCS_DIMENSIONS.map((d, i) => [d.id, i]));
      verdicts.sort((a, b) => dimOrder.get(a.dimension_id)! - dimOrder.get(b.dimension_id)!);

      // 6f. Summary preconditions
      const summaryRows = await db.query(
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
        { label: "DcsRender: read dcs_run_summary" },
      );

      if (summaryRows.length !== 1) {
        throw new Error(`Expected exactly 1 dcs_run_summary row, got ${summaryRows.length}.`);
      }

      const summary = summaryRows[0];
      if (summary.dimension_count !== 10) {
        throw new Error(`Summary dimension_count=${summary.dimension_count}, expected 10.`);
      }
      if (summary.computed_in_code !== true) {
        throw new Error(`Summary computed_in_code must be true.`);
      }
      if (summary.evidenced_count !== pCounts.evidenced) {
        throw new Error(
          `Summary evidenced_count=${summary.evidenced_count} does not match verdicts (${pCounts.evidenced}).`,
        );
      }
      if (summary.asserted_count !== pCounts.asserted) {
        throw new Error(
          `Summary asserted_count=${summary.asserted_count} does not match verdicts (${pCounts.asserted}).`,
        );
      }
      if (summary.absent_count !== pCounts.absent) {
        throw new Error(
          `Summary absent_count=${summary.absent_count} does not match verdicts (${pCounts.absent}).`,
        );
      }

      // Cross-stage: headline score
      const computedScore = computeHeadlineScore(verdicts);
      if (summary.headline_score !== computedScore) {
        throw new Error(
          `Summary headline_score=${summary.headline_score} does not match computed ${computedScore}.`,
        );
      }

      // Cross-stage: coverage_basis
      const cb = typeof summary.coverage_basis === "string"
        ? JSON.parse(summary.coverage_basis)
        : summary.coverage_basis;

      if (cb.coverage_complete !== true) {
        throw new Error(`Summary coverage_basis.coverage_complete must be true in normal mode.`);
      }
      if (cb.provisional !== false) {
        throw new Error(`Summary coverage_basis.provisional must be false in normal mode.`);
      }
      if (cb.evidence_rows !== actualEvidenceCount) {
        throw new Error(
          `Summary coverage_basis.evidence_rows=${cb.evidence_rows} does not match actual ${actualEvidenceCount}.`,
        );
      }

      headlineScore = summary.headline_score;
      evidencedCount = summary.evidenced_count;
      assertedCount = summary.asserted_count;
      absentCount = summary.absent_count;
    }

    // ═══════════════════════════════════════════════════════════════
    // 7. Cross-stage validation (independent recomputation)
    // ═══════════════════════════════════════════════════════════════
    const recomputedCounts = { evidenced: 0, asserted: 0, absent: 0 };
    for (const v of verdicts) {
      recomputedCounts[v.state as DimensionState]++;
    }
    if (recomputedCounts.evidenced !== evidencedCount ||
        recomputedCounts.asserted !== assertedCount ||
        recomputedCounts.absent !== absentCount) {
      throw new Error(
        `Cross-stage count mismatch: recomputed ${JSON.stringify(recomputedCounts)} ` +
        `vs summary e=${evidencedCount}/a=${assertedCount}/ab=${absentCount}.`,
      );
    }

    const recomputedScore = computeHeadlineScore(verdicts);
    if (recomputedScore !== headlineScore) {
      throw new Error(
        `Cross-stage headline score mismatch: recomputed ${recomputedScore} vs summary ${headlineScore}.`,
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // 8. Representative evidence resolution
    // ═══════════════════════════════════════════════════════════════
    const dimensionRecords: DimensionRecord[] = [];

    for (const v of verdicts) {
      if (v.state === "absent") {
        // Absent: no evidence query, null representative fields
        dimensionRecords.push({
          dimension_id: v.dimension_id,
          label: v.label,
          state: v.state,
          score_value: v.score_value,
          evidence_count: v.evidence_count,
          promoting_chunk_id: v.promoting_chunk_id,
          promoting_source_file: v.promoting_source_file,
          rationale: v.rationale,
          representative_snippet: null,
          representative_doc_class: null,
          representative_is_substantive: null,
        });
        continue;
      }

      // Non-absent: resolve representative evidence row
      const evidenceRow = await db.query(
        `SELECT snippet, doc_class, is_substantive, source_file, dimension_id
         FROM dcs_evidence
         WHERE run_id = $1::uuid
           AND chunk_id = $2::text
           AND dimension_id = $3::text
         LIMIT 2`,
        z.object({
          snippet: z.string(),
          doc_class: z.string(),
          is_substantive: z.boolean(),
          source_file: z.string(),
          dimension_id: z.string(),
        }),
        [input.runId, v.promoting_chunk_id, v.dimension_id],
        { label: `DcsRender: evidence for ${v.dimension_id}` },
      );

      if (evidenceRow.length === 0) {
        throw new Error(
          `No evidence row found for dimension '${v.dimension_id}' with ` +
          `chunk_id='${v.promoting_chunk_id}' in run ${input.runId}.`,
        );
      }
      if (evidenceRow.length > 1) {
        throw new Error(
          `Multiple evidence rows found for dimension '${v.dimension_id}' with ` +
          `chunk_id='${v.promoting_chunk_id}'. Expected exactly one.`,
        );
      }

      const eRow = evidenceRow[0];

      // Verify source_file matches
      if (eRow.source_file !== v.promoting_source_file) {
        throw new Error(
          `Evidence source_file '${eRow.source_file}' does not match verdict ` +
          `promoting_source_file '${v.promoting_source_file}' for dimension '${v.dimension_id}'.`,
        );
      }

      // Verify dimension_id matches
      if (eRow.dimension_id !== v.dimension_id) {
        throw new Error(
          `Evidence dimension_id '${eRow.dimension_id}' does not match ` +
          `verdict dimension_id '${v.dimension_id}'.`,
        );
      }

      // Verify snippet is non-empty
      if (!eRow.snippet || eRow.snippet.trim().length === 0) {
        throw new Error(
          `Evidence snippet is empty for dimension '${v.dimension_id}'.`,
        );
      }

      // Evidenced: must be workproduct + substantive
      if (v.state === "evidenced") {
        if (eRow.doc_class !== "workproduct") {
          throw new Error(
            `Evidenced dimension '${v.dimension_id}' representative must have doc_class='workproduct', got '${eRow.doc_class}'.`,
          );
        }
        if (eRow.is_substantive !== true) {
          throw new Error(
            `Evidenced dimension '${v.dimension_id}' representative must be substantive.`,
          );
        }
      }

      // Asserted: must NOT qualify as substantive workproduct
      if (v.state === "asserted") {
        if (eRow.doc_class === "workproduct" && eRow.is_substantive === true) {
          throw new Error(
            `Asserted dimension '${v.dimension_id}' representative must not be substantive workproduct.`,
          );
        }
      }

      dimensionRecords.push({
        dimension_id: v.dimension_id,
        label: v.label,
        state: v.state,
        score_value: v.score_value,
        evidence_count: v.evidence_count,
        promoting_chunk_id: v.promoting_chunk_id,
        promoting_source_file: v.promoting_source_file,
        rationale: v.rationale,
        representative_snippet: eRow.snippet,
        representative_doc_class: eRow.doc_class,
        representative_is_substantive: eRow.is_substantive,
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // 9. Pure rendering
    // ═══════════════════════════════════════════════════════════════
    const provisional = isVerification ? !coverageComplete : false;

    const scorecardResult = renderDcsScorecard({
      runId: input.runId,
      provisional,
      coverageComplete,
      extractionStatus: extract.status,
      processedChunks: extractDetail.processed_count,
      totalChunks: extractDetail.total_chunks,
      evidenceRows: actualEvidenceCount,
      headlineScore,
      evidencedCount,
      assertedCount,
      absentCount,
      dimensions: dimensionRecords,
    });

    // ═══════════════════════════════════════════════════════════════
    // 10. Verification mode: return without writes
    // ═══════════════════════════════════════════════════════════════
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
        executiveHeader: scorecardResult.executiveHeader,
        fullReportMarkdown: scorecardResult.fullReportMarkdown,
        reportHash: scorecardResult.reportHash,
        dimensions: scorecardResult.dimensions,
        persistedRenderState: false,
        renderStageStatus: "verification",
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // 11. Normal mode: persist render stage
    // ═══════════════════════════════════════════════════════════════
    let renderStateId: string;
    try {
      // 11a. Upsert render-stage state as running
      const stateUpsert = await db.query(
        `INSERT INTO dcs_pipeline_state (run_id, stage, status, detail)
         VALUES ($1::uuid, 'render', 'running', '{}')
         ON CONFLICT (run_id, stage) DO UPDATE
           SET status = 'running', detail = '{}', updated_at = now()
         RETURNING id`,
        z.object({ id: z.string() }),
        [input.runId],
        { label: "DcsRender: upsert render-stage running" },
      );
      renderStateId = stateUpsert[0].id;
    } catch (err) {
      throw new Error(
        `Failed to create render-stage state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      // 11b. Update to done with detail
      const renderDetail = {
        report_hash: scorecardResult.reportHash,
        markdown_length: scorecardResult.fullReportMarkdown.length,
        dimension_count: 10,
        headline_score: headlineScore,
        processed_chunks: extractDetail.processed_count,
        total_chunks: extractDetail.total_chunks,
        evidence_rows: actualEvidenceCount,
        provisional: false,
        computed_in_code: true,
      };

      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'done', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify(renderDetail), renderStateId],
        { label: "DcsRender: mark render stage done" },
      );

      // 11c. Read back and verify
      const readback = await db.query(
        `SELECT status, detail
         FROM dcs_pipeline_state
         WHERE id = $1::uuid
         LIMIT 1`,
        z.object({ status: z.string(), detail: z.string().nullable() }),
        [renderStateId],
        { label: "DcsRender: readback render stage" },
      );

      if (readback.length === 0) {
        throw new Error("Render-stage readback returned no rows.");
      }

      if (readback[0].status !== "done") {
        throw new Error(
          `Render-stage readback status='${readback[0].status}', expected 'done'.`,
        );
      }

      const rbDetail = readback[0].detail ? JSON.parse(readback[0].detail) : {};
      const expectedDetail = renderDetail;

      if (rbDetail.report_hash !== expectedDetail.report_hash) {
        throw new Error("Render-stage readback report_hash mismatch.");
      }
      if (rbDetail.markdown_length !== expectedDetail.markdown_length) {
        throw new Error("Render-stage readback markdown_length mismatch.");
      }
      if (rbDetail.dimension_count !== expectedDetail.dimension_count) {
        throw new Error("Render-stage readback dimension_count mismatch.");
      }
      if (rbDetail.headline_score !== expectedDetail.headline_score) {
        throw new Error("Render-stage readback headline_score mismatch.");
      }
      if (rbDetail.processed_chunks !== expectedDetail.processed_chunks) {
        throw new Error("Render-stage readback processed_chunks mismatch.");
      }
      if (rbDetail.total_chunks !== expectedDetail.total_chunks) {
        throw new Error("Render-stage readback total_chunks mismatch.");
      }
      if (rbDetail.evidence_rows !== expectedDetail.evidence_rows) {
        throw new Error("Render-stage readback evidence_rows mismatch.");
      }
      if (rbDetail.provisional !== false) {
        throw new Error("Render-stage readback provisional mismatch.");
      }
      if (rbDetail.computed_in_code !== true) {
        throw new Error("Render-stage readback computed_in_code mismatch.");
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
        executiveHeader: scorecardResult.executiveHeader,
        fullReportMarkdown: scorecardResult.fullReportMarkdown,
        reportHash: scorecardResult.reportHash,
        dimensions: scorecardResult.dimensions,
        persistedRenderState: true,
        renderStageStatus: "done",
      };
    } catch (err) {
      // If rendering/persistence fails after running row exists, mark failed
      const errMsg = err instanceof Error ? err.message : String(err);
      const bounded = errMsg.slice(0, 500);

      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'failed', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify({ error: bounded }), renderStateId],
        { label: "DcsRender: mark render stage failed" },
      );

      throw new Error(`DcsRenderReport persistence failed: ${bounded}`);
    }
  },
});
