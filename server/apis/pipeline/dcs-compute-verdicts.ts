/**
 * DCS Compute Verdicts — Phase 3A of the DCS rebuild.
 *
 * Reads accepted dcs_evidence rows, computes exactly one verdict for each of
 * the ten DCS dimensions using the deterministic rubric, and persists those
 * verdicts only when extraction is demonstrably complete.
 *
 * This API is model-free: no Anthropic calls, no getModuleModel, no
 * callLLMWithHeadroom. All scoring is code-deterministic via dcs-rubric.ts.
 *
 * Verification mode computes and returns verdicts without any database writes,
 * allowing inspection of partial runs.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  DCS_DIMENSIONS,
  computeDimensionState,
  SCORE_VALUES,
} from "./dcs-rubric.js";
import type { DimensionState, DocClass } from "./dcs-rubric.js";
import {
  curateDimensionPackets,
  computeExitDimensionState,
} from "./dcs-evidence-curation.js";
import type {
  RawEvidenceRow,
  ChunkMeta,
  CuratedDimensionPacket,
} from "./dcs-evidence-curation.js";

// ── Integration ID ───────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Valid dimension IDs from the rubric ──────────────────────────
const VALID_DIMENSION_IDS = new Set(DCS_DIMENSIONS.map((d) => d.id));

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

const EvidenceRowSchema = z.object({
  id: z.string(),
  dimension_id: z.string(),
  chunk_id: z.string(),
  source_file: z.string(),
  document_tag: z.string(),
  doc_class: z.enum(["narrative", "workproduct"]),
  is_substantive: z.boolean(),
  snippet: z.string(),
});
type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

const ChunkMetaSchema = z.object({
  chunk_id: z.string(),
  chunk_index: z.number(),
  file_name: z.string(),
  file_type: z.string(),
});

const VerdictSchema = z.object({
  dimension_id: z.string(),
  label: z.string(),
  state: z.string(),
  score_value: z.number(),
  evidence_count: z.number(),
  promoting_chunk_id: z.string().nullable(),
  promoting_source_file: z.string().nullable(),
  rationale: z.string(),
});
type Verdict = z.infer<typeof VerdictSchema>;

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════
export default api({
  name: "DcsComputeVerdicts",
  description: "Computes deterministic per-dimension verdicts from extracted DCS evidence",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().uuid(),
    dealId: z.string().uuid(),
    verificationMode: z.boolean().default(false),
  }),

  output: z.object({
    runId: z.string(),
    mode: z.string(),
    provisional: z.boolean(),
    coverageComplete: z.boolean(),
    extractionStatus: z.string(),
    processedChunks: z.number(),
    totalChunks: z.number(),
    evidenceRowsRead: z.number(),
    verdicts: z.array(VerdictSchema),
    stateCounts: z.object({
      evidenced: z.number(),
      asserted: z.number(),
      absent: z.number(),
    }),
    persistedVerdicts: z.boolean(),
    verdictStageStatus: z.string().nullable(),
    curatedDimensionPackets: z.any().optional(),
  }),

  async run(ctx, input) {
    const db = ctx.integrations.ic_diligence_db;
    const mode = input.verificationMode ? "verification" : "normal";

    // ── 1. Run validation ──────────────────────────────────────
    const runCheck = await db.query(
      `SELECT id FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string() }),
      [input.runId, input.dealId],
      { label: "DcsVerdicts: validate module_runs" },
    );
    if (runCheck.length === 0) {
      throw new Error(
        `No module_runs row for runId=${input.runId} with dealId=${input.dealId} and module_id=diligence_completeness`,
      );
    }

    // ── 2. Load extract-stage state ────────────────────────────
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
      { label: "DcsVerdicts: load extract state" },
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

    // ── 3. Coverage completeness ───────────────────────────────
    const coverageComplete =
      extract.status === "done" &&
      detail.processed_count === detail.total_chunks &&
      detail.total_chunks > 0 &&
      extract.cursor_value === detail.last_chunk_id;

    // ── 4. Normal-mode gate ────────────────────────────────────
    if (!input.verificationMode && !coverageComplete) {
      throw new Error(
        `Extraction incomplete: status=${extract.status}, processed=${detail.processed_count}/${detail.total_chunks}. ` +
        `Coverage must be complete before computing verdicts in normal mode.`,
      );
    }

    // ── 5. Read all evidence rows (with id + snippet for curation) ──
    const evidenceRows = await db.query(
      `SELECT id, dimension_id, chunk_id, source_file, document_tag, doc_class, is_substantive, snippet
       FROM dcs_evidence
       WHERE run_id = $1::uuid
       ORDER BY dimension_id, chunk_id, source_file`,
      EvidenceRowSchema,
      [input.runId],
      { label: "DcsVerdicts: read all evidence" },
    );

    // ── 5b. Load chunk metadata for source-location resolution ──
    const distinctChunkIds = [...new Set(evidenceRows.map((r) => r.chunk_id))];
    const chunkMetaMap = new Map<string, ChunkMeta>();

    if (distinctChunkIds.length > 0) {
      // Batch query in groups of 500 to avoid parameter limits
      const BATCH_SIZE = 500;
      for (let i = 0; i < distinctChunkIds.length; i += BATCH_SIZE) {
        const batch = distinctChunkIds.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map((_, idx) => `$${idx + 1}::uuid`).join(",");
        const chunkMetas = await db.query(
          `SELECT dc.id AS chunk_id, dc.chunk_index, dc.file_name,
                  COALESCE(d.file_type, 'unknown') AS file_type
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.id IN (${placeholders})
           LIMIT ${BATCH_SIZE}`,
          ChunkMetaSchema,
          batch,
          { label: `DcsVerdicts: chunk metadata batch ${i / BATCH_SIZE + 1}` },
        );
        for (const cm of chunkMetas) {
          chunkMetaMap.set(cm.chunk_id, cm);
        }
      }
    }

    // Validate all dimension_ids against the rubric
    for (const row of evidenceRows) {
      if (!VALID_DIMENSION_IDS.has(row.dimension_id)) {
        throw new Error(
          `Evidence row contains invalid dimension_id '${row.dimension_id}' outside the DCS rubric. ` +
          `chunk_id=${row.chunk_id}, source_file=${row.source_file}. Computation rejected.`,
        );
      }
    }

    // ── 6. Group evidence by dimension ─────────────────────────
    const evidenceByDimension = new Map<string, EvidenceRow[]>();
    for (const dim of DCS_DIMENSIONS) {
      evidenceByDimension.set(dim.id, []);
    }
    for (const row of evidenceRows) {
      evidenceByDimension.get(row.dimension_id)!.push(row);
    }

    // ── 7. Compute verdicts in rubric order ────────────────────
    const verdicts: Verdict[] = [];
    const stateCounts = { evidenced: 0, asserted: 0, absent: 0 };

    for (const dim of DCS_DIMENSIONS) {
      const rows = evidenceByDimension.get(dim.id)!;

      // Compute state using rubric pure function.
      // Exit dimension uses the promotion gate from dcs-evidence-curation.
      const state: DimensionState = dim.id === "exit"
        ? computeExitDimensionState(
            rows.map((r) => ({
              doc_class: r.doc_class as DocClass,
              is_substantive: r.is_substantive,
              snippet: r.snippet,
              document_tag: r.document_tag,
              source_file: r.source_file,
            })),
          )
        : computeDimensionState(
            rows.map((r) => ({ doc_class: r.doc_class as DocClass, is_substantive: r.is_substantive })),
          );
      const scoreValue = SCORE_VALUES[state];
      stateCounts[state]++;

      // Promoting row selection
      let promotingChunkId: string | null = null;
      let promotingSourceFile: string | null = null;

      if (state === "evidenced") {
        // Eligible: workproduct + substantive only
        const eligible = rows
          .filter((r) => r.doc_class === "workproduct" && r.is_substantive)
          .sort((a, b) => {
            const cmp = a.chunk_id.localeCompare(b.chunk_id);
            if (cmp !== 0) return cmp;
            return a.source_file.localeCompare(b.source_file);
          });
        if (eligible.length > 0) {
          promotingChunkId = eligible[0].chunk_id;
          promotingSourceFile = eligible[0].source_file;
        }
      } else if (state === "asserted") {
        // Sort: substantive first, then chunk_id ASC, then source_file ASC
        const sorted = [...rows].sort((a, b) => {
          // Substantive before non-substantive
          if (a.is_substantive && !b.is_substantive) return -1;
          if (!a.is_substantive && b.is_substantive) return 1;
          const cmp = a.chunk_id.localeCompare(b.chunk_id);
          if (cmp !== 0) return cmp;
          return a.source_file.localeCompare(b.source_file);
        });
        if (sorted.length > 0) {
          promotingChunkId = sorted[0].chunk_id;
          promotingSourceFile = sorted[0].source_file;
        }
      }
      // absent: null/null — already initialized

      // Deterministic rationale
      let rationale: string;
      if (state === "absent") {
        rationale = "No accepted evidence rows were extracted for this dimension.";
      } else if (state === "asserted") {
        const wpSubstCount = rows.filter(
          (r) => r.doc_class === "workproduct" && r.is_substantive,
        ).length;
        rationale = dim.id === "exit" && wpSubstCount > 0
          ? `${rows.length} accepted row(s); ${wpSubstCount} workproduct row(s) exist but none pass the exit promotion gate.`
          : `${rows.length} accepted row(s); none is substantive workproduct evidence.`;
      } else {
        // evidenced
        const wpSubstantive = rows.filter(
          (r) => r.doc_class === "workproduct" && r.is_substantive,
        );
        const distinctSources = new Set(wpSubstantive.map((r) => r.source_file));
        rationale = `${wpSubstantive.length} substantive workproduct row(s) across ${distinctSources.size} source file(s).`;
      }

      verdicts.push({
        dimension_id: dim.id,
        label: dim.label,
        state,
        score_value: scoreValue,
        evidence_count: rows.length,
        promoting_chunk_id: promotingChunkId,
        promoting_source_file: promotingSourceFile,
        rationale,
      });
    }

    // ── 7b. Curate dimension packets ────────────────────────────
    const rawEvidenceForCurator: RawEvidenceRow[] = evidenceRows.map((r) => ({
      id: r.id,
      dimension_id: r.dimension_id,
      chunk_id: r.chunk_id,
      source_file: r.source_file,
      document_tag: r.document_tag,
      doc_class: r.doc_class as DocClass,
      is_substantive: r.is_substantive,
      snippet: r.snippet,
    }));

    const curatedDimensionPackets = curateDimensionPackets(
      rawEvidenceForCurator,
      chunkMetaMap,
    );

    // ── 8. Verification mode: return without writes ────────────
    if (input.verificationMode) {
      return {
        runId: input.runId,
        mode: "verification",
        provisional: !coverageComplete,
        coverageComplete,
        extractionStatus: extract.status,
        processedChunks: detail.processed_count,
        totalChunks: detail.total_chunks,
        evidenceRowsRead: evidenceRows.length,
        verdicts,
        stateCounts,
        persistedVerdicts: false,
        verdictStageStatus: null,
        curatedDimensionPackets,
      };
    }

    // ── 9. Normal mode: persist verdicts ───────────────────────
    // 9a. Upsert verdict-stage state row
    let verdictStateId: string;
    try {
      const stateUpsert = await db.query(
        `INSERT INTO dcs_pipeline_state (run_id, stage, status, detail)
         VALUES ($1::uuid, 'verdicts', 'running', '{}')
         ON CONFLICT (run_id, stage) DO UPDATE
           SET status = 'running', detail = '{}', updated_at = now()
         RETURNING id`,
        z.object({ id: z.string() }),
        [input.runId],
        { label: "DcsVerdicts: upsert verdict-stage state" },
      );
      verdictStateId = stateUpsert[0].id;
    } catch (err) {
      throw new Error(
        `Failed to create verdict-stage state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      // 9b. Bulk upsert all ten verdicts via jsonb_to_recordset
      const verdictPayload = verdicts.map((v) => ({
        dimension_id: v.dimension_id,
        state: v.state,
        score_value: v.score_value,
        promoting_chunk_id: v.promoting_chunk_id,
        promoting_source_file: v.promoting_source_file,
        evidence_count: v.evidence_count,
        rationale: v.rationale,
      }));

      await db.execute(
        `INSERT INTO dcs_dimension_verdicts
           (run_id, dimension_id, state, score_value, promoting_chunk_id, promoting_source_file, evidence_count, rationale, created_at)
         SELECT
           $1::uuid,
           r.dimension_id,
           r.state,
           r.score_value::numeric,
           r.promoting_chunk_id,
           r.promoting_source_file,
           r.evidence_count::int,
           r.rationale,
           now()
         FROM jsonb_to_recordset($2::jsonb) AS r(
           dimension_id text,
           state text,
           score_value numeric,
           promoting_chunk_id text,
           promoting_source_file text,
           evidence_count int,
           rationale text
         )
         ON CONFLICT (run_id, dimension_id) DO UPDATE SET
           state = EXCLUDED.state,
           score_value = EXCLUDED.score_value,
           promoting_chunk_id = EXCLUDED.promoting_chunk_id,
           promoting_source_file = EXCLUDED.promoting_source_file,
           evidence_count = EXCLUDED.evidence_count,
           rationale = EXCLUDED.rationale,
           created_at = now()`,
        [input.runId, JSON.stringify(verdictPayload)],
        { label: "DcsVerdicts: bulk upsert 10 verdicts" },
      );

      // 9c. Read back persisted verdicts in rubric order
      const persisted = await db.query(
        `SELECT dimension_id, state, score_value, promoting_chunk_id, promoting_source_file, evidence_count, rationale
         FROM dcs_dimension_verdicts
         WHERE run_id = $1::uuid
         ORDER BY dimension_id`,
        z.object({
          dimension_id: z.string(),
          state: z.string(),
          score_value: z.string(), // NUMERIC returned as string
          promoting_chunk_id: z.string().nullable(),
          promoting_source_file: z.string().nullable(),
          evidence_count: z.number(),
          rationale: z.string().nullable(),
        }),
        [input.runId],
        { label: "DcsVerdicts: readback persisted verdicts" },
      );

      // Verify exactly ten rows
      if (persisted.length !== 10) {
        throw new Error(
          `Readback expected 10 verdicts, got ${persisted.length}`,
        );
      }

      // Verify exactly the 10 rubric dimension IDs
      const persistedIds = new Set(persisted.map((r) => r.dimension_id));
      for (const dim of DCS_DIMENSIONS) {
        if (!persistedIds.has(dim.id)) {
          throw new Error(
            `Readback missing dimension '${dim.id}'`,
          );
        }
      }

      // Verify each persisted field matches computed
      for (const pRow of persisted) {
        const computed = verdicts.find((v) => v.dimension_id === pRow.dimension_id);
        if (!computed) {
          throw new Error(
            `Extra dimension '${pRow.dimension_id}' in persisted verdicts`,
          );
        }
        if (pRow.state !== computed.state) {
          throw new Error(
            `Readback mismatch for '${pRow.dimension_id}': state ${pRow.state} != ${computed.state}`,
          );
        }
        if (parseFloat(pRow.score_value) !== computed.score_value) {
          throw new Error(
            `Readback mismatch for '${pRow.dimension_id}': score_value ${pRow.score_value} != ${computed.score_value}`,
          );
        }
        if (pRow.promoting_chunk_id !== computed.promoting_chunk_id) {
          throw new Error(
            `Readback mismatch for '${pRow.dimension_id}': promoting_chunk_id`,
          );
        }
        if (pRow.promoting_source_file !== computed.promoting_source_file) {
          throw new Error(
            `Readback mismatch for '${pRow.dimension_id}': promoting_source_file`,
          );
        }
        if (pRow.evidence_count !== computed.evidence_count) {
          throw new Error(
            `Readback mismatch for '${pRow.dimension_id}': evidence_count ${pRow.evidence_count} != ${computed.evidence_count}`,
          );
        }
      }

      // Check no extra dimension rows exist for the run
      const extraCheck = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM dcs_dimension_verdicts WHERE run_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [input.runId],
        { label: "DcsVerdicts: check no extra rows" },
      );
      if (extraCheck[0].cnt !== 10) {
        throw new Error(
          `Expected exactly 10 verdict rows for run, found ${extraCheck[0].cnt}`,
        );
      }

      // 9d. Mark verdict-stage state as done
      const verdictStageDetail = {
        dimension_count: 10,
        evidenced_count: stateCounts.evidenced,
        asserted_count: stateCounts.asserted,
        absent_count: stateCounts.absent,
        evidence_rows_read: evidenceRows.length,
        extraction_processed_count: detail.processed_count,
        extraction_total_chunks: detail.total_chunks,
        coverage_complete: true,
        computed_in_code: true,
      };

      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'done', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify(verdictStageDetail), verdictStateId],
        { label: "DcsVerdicts: mark verdict stage done" },
      );

      return {
        runId: input.runId,
        mode: "normal",
        provisional: false,
        coverageComplete: true,
        extractionStatus: extract.status,
        processedChunks: detail.processed_count,
        totalChunks: detail.total_chunks,
        evidenceRowsRead: evidenceRows.length,
        verdicts,
        stateCounts,
        persistedVerdicts: true,
        verdictStageStatus: "done",
        curatedDimensionPackets,
      };
    } catch (err) {
      // If persistence or readback fails after verdict-stage row exists,
      // mark only that row as failed
      const errMsg = err instanceof Error ? err.message : String(err);
      const bounded = errMsg.slice(0, 500);

      await db.execute(
        `UPDATE dcs_pipeline_state
         SET status = 'failed', detail = $1, updated_at = now()
         WHERE id = $2::uuid`,
        [JSON.stringify({ error: bounded }), verdictStateId],
        { label: "DcsVerdicts: mark verdict stage failed" },
      );

      throw new Error(`DcsComputeVerdicts persistence failed: ${bounded}`);
    }
  },
});
