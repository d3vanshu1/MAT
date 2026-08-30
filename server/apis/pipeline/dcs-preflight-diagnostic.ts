/**
 * DCS Preflight Diagnostic — Packet 5F.
 *
 * Read-only, model-free diagnostic that validates corpus integrity,
 * logical-window planning, run-state safety, database contracts, and
 * call-reduction projections for a given deal.
 *
 * Returns readyForLiveRun: true/false with exact blockers.
 *
 * MUST NOT:
 *   - import model helpers (getModuleModel, callLLMWithHeadroom, anthropic)
 *   - execute INSERT, UPDATE, DELETE, UPSERT, or DDL
 *   - call any child API
 *   - log source data (chunk text, snippets, prompts, evidence, model responses)
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { DCS_DIMENSIONS, classifyDocClass, DOC_CLASS_BY_TAG } from "./dcs-rubric.js";
import {
  type PhysicalChunk,
  buildLogicalWindows,
  isExcelDocument,
} from "./dcs-logical-excel-windows.js";
import * as crypto from "crypto";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ORDERING_VERSION = "document-index-v1";
const WORK_UNIT_VERSION = "logical-excel-v1";

// ── Helpers ──────────────────────────────────────────────────────

interface Check {
  id: string;
  status: "pass" | "warning" | "fail";
  message: string;
  metrics: Record<string, unknown>;
}

function pass(id: string, message: string, metrics: Record<string, unknown> = {}): Check {
  return { id, status: "pass", message, metrics };
}
function warn(id: string, message: string, metrics: Record<string, unknown> = {}): Check {
  return { id, status: "warning", message, metrics };
}
function fail(id: string, message: string, metrics: Record<string, unknown> = {}): Check {
  return { id, status: "fail", message, metrics };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ═════════════════════════════════════════════════════════════════
// API Definition
// ═════════════════════════════════════════════════════════════════

export default api({
  name: "DcsPreflightDiagnostic",
  description: "Read-only preflight diagnostic for DCS live-run readiness",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string().uuid(),
  }),

  output: z.object({
    readyForLiveRun: z.boolean(),
    status: z.string(),
    checks: z.array(z.object({
      id: z.string(),
      status: z.string(),
      message: z.string(),
      metrics: z.any(),
    })),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
    corpusSummary: z.any(),
    logicalWindowSummary: z.any(),
    runStateSummary: z.any(),
    projectedModelCalls: z.any(),
  }),

  async run(ctx, input) {
    const db = ctx.integrations.ic_diligence_db;
    const { dealId } = input;
    const checks: Check[] = [];
    const blockers: string[] = [];
    const warnings: string[] = [];

    // ═══════════════════════════════════════════════════════════════
    // §2: CORPUS CHECKS
    // ═══════════════════════════════════════════════════════════════

    // 2a: Document count
    const docCountRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM documents d
       WHERE d.deal_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      [dealId],
      { label: "Preflight: document count" },
    );
    const documentCount = docCountRows[0]?.cnt ?? 0;

    // 2b: Physical chunk count (joined)
    const chunkCountRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid`,
      z.object({ cnt: z.number() }),
      [dealId],
      { label: "Preflight: physical chunk count" },
    );
    const physicalChunkCount = chunkCountRows[0]?.cnt ?? 0;

    // 2c: Zero-chunk documents
    const zeroChunkRows = await db.query(
      `SELECT d.id, d.file_name
       FROM documents d
       LEFT JOIN document_chunks dc ON dc.document_id = d.id AND dc.deal_id = d.deal_id
       WHERE d.deal_id = $1::uuid
       GROUP BY d.id, d.file_name
       HAVING COUNT(dc.id) = 0
       LIMIT 10`,
      z.object({ id: z.string(), file_name: z.string() }),
      [dealId],
      { label: "Preflight: zero-chunk documents" },
    );

    // 2d: Orphan chunks (chunks with no matching document)
    const orphanRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM document_chunks dc
       WHERE dc.deal_id = $1::uuid
         AND NOT EXISTS (
           SELECT 1 FROM documents d
           WHERE d.id = dc.document_id AND d.deal_id = $1::uuid
         )`,
      z.object({ cnt: z.number() }),
      [dealId],
      { label: "Preflight: orphan chunks" },
    );
    const orphanChunks = orphanRows[0]?.cnt ?? 0;

    // 2e: Duplicate document_id + chunk_index
    const dupRows = await db.query(
      `SELECT dc.document_id, dc.chunk_index, COUNT(*)::int AS cnt
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
       GROUP BY dc.document_id, dc.chunk_index
       HAVING COUNT(*) > 1
       LIMIT 5`,
      z.object({ document_id: z.string(), chunk_index: z.number(), cnt: z.number() }),
      [dealId],
      { label: "Preflight: duplicate doc/index pairs" },
    );

    // 2f: First chunk_index per document (should be 0)
    const firstIndexRows = await db.query(
      `SELECT dc.document_id, MIN(dc.chunk_index)::int AS min_idx
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
       GROUP BY dc.document_id
       HAVING MIN(dc.chunk_index) != 0
       LIMIT 5`,
      z.object({ document_id: z.string(), min_idx: z.number() }),
      [dealId],
      { label: "Preflight: first chunk index check" },
    );

    // 2g: Chunk-index gaps
    const gapRows = await db.query(
      `WITH indexed AS (
         SELECT dc.document_id, dc.chunk_index,
                LEAD(dc.chunk_index) OVER (
                  PARTITION BY dc.document_id ORDER BY dc.chunk_index
                ) AS next_idx
         FROM document_chunks dc
         JOIN documents d ON d.id = dc.document_id
         WHERE dc.deal_id = $1::uuid AND d.deal_id = $1::uuid
       )
       SELECT document_id, chunk_index, next_idx
       FROM indexed
       WHERE next_idx IS NOT NULL AND next_idx != chunk_index + 1
       LIMIT 5`,
      z.object({ document_id: z.string(), chunk_index: z.number(), next_idx: z.number() }),
      [dealId],
      { label: "Preflight: chunk index gaps" },
    );

    // 2h: Per-document details
    const docDetailRows = await db.query(
      `SELECT d.id AS document_id, d.file_name, d.document_tag,
              COUNT(dc.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN document_chunks dc ON dc.document_id = d.id AND dc.deal_id = d.deal_id
       WHERE d.deal_id = $1::uuid
       GROUP BY d.id, d.file_name, d.document_tag
       ORDER BY d.document_tag, d.file_name
       LIMIT 50`,
      z.object({
        document_id: z.string(),
        file_name: z.string(),
        document_tag: z.string().nullable(),
        chunk_count: z.number(),
      }),
      [dealId],
      { label: "Preflight: per-document details" },
    );

    // Classify documents
    const docDetails = docDetailRows.map(d => {
      const ext = d.file_name.includes(".") ? d.file_name.split(".").pop()!.toLowerCase() : "";
      const isExcel = isExcelDocument(d.document_tag, d.file_name);
      return {
        documentId: d.document_id,
        fileName: d.file_name,
        tag: d.document_tag,
        extension: ext,
        chunkCount: d.chunk_count,
        isExcel,
        docClass: classifyDocClass(d.document_tag),
      };
    });

    const excelDocs = docDetails.filter(d => d.isExcel);
    const nonExcelDocs = docDetails.filter(d => !d.isExcel);
    const excelPhysicalChunks = excelDocs.reduce((sum, d) => sum + d.chunkCount, 0);
    const nonExcelPhysicalChunks = nonExcelDocs.reduce((sum, d) => sum + d.chunkCount, 0);
    const financialModelCount = docDetails.filter(d => d.tag === "financial_model").length;

    // Corpus checks
    if (documentCount === 10) {
      checks.push(pass("corpus.document_count", `${documentCount} indexed documents`, { documentCount }));
    } else {
      checks.push(fail("corpus.document_count", `Expected 10 documents, found ${documentCount}`, { documentCount }));
      blockers.push(`Document count: expected 10, found ${documentCount}`);
    }

    if (physicalChunkCount === 3878) {
      checks.push(pass("corpus.physical_chunks", `${physicalChunkCount} physical chunks`, { physicalChunkCount }));
    } else {
      checks.push(fail("corpus.physical_chunks", `Expected 3,878 chunks, found ${physicalChunkCount}`, { physicalChunkCount }));
      blockers.push(`Physical chunk count: expected 3878, found ${physicalChunkCount}`);
    }

    if (zeroChunkRows.length === 0) {
      checks.push(pass("corpus.zero_chunk_docs", "No zero-chunk documents"));
    } else {
      checks.push(fail("corpus.zero_chunk_docs", `${zeroChunkRows.length} documents with zero chunks`, { docs: zeroChunkRows.map(r => r.file_name) }));
      blockers.push(`${zeroChunkRows.length} documents have zero chunks`);
    }

    if (orphanChunks === 0) {
      checks.push(pass("corpus.orphan_chunks", "No orphan chunks"));
    } else {
      checks.push(fail("corpus.orphan_chunks", `${orphanChunks} orphan chunks`, { orphanChunks }));
      blockers.push(`${orphanChunks} orphan chunks found`);
    }

    if (dupRows.length === 0) {
      checks.push(pass("corpus.duplicate_doc_index", "No duplicate document_id + chunk_index pairs"));
    } else {
      checks.push(fail("corpus.duplicate_doc_index", `${dupRows.length} duplicate pairs`, { duplicates: dupRows }));
      blockers.push(`${dupRows.length} duplicate document_id/chunk_index pairs`);
    }

    if (firstIndexRows.length === 0) {
      checks.push(pass("corpus.first_chunk_index", "Every document begins at chunk_index 0"));
    } else {
      checks.push(fail("corpus.first_chunk_index", `${firstIndexRows.length} documents don't start at index 0`, { docs: firstIndexRows }));
      blockers.push(`${firstIndexRows.length} documents don't start at chunk_index 0`);
    }

    if (gapRows.length === 0) {
      checks.push(pass("corpus.chunk_index_gaps", "Chunk indexes contiguous within every document"));
    } else {
      checks.push(fail("corpus.chunk_index_gaps", `${gapRows.length} chunk index gap(s) found`, { gaps: gapRows }));
      blockers.push(`${gapRows.length} chunk index gaps found`);
    }

    if (financialModelCount === 2) {
      checks.push(pass("corpus.financial_model_count", `${financialModelCount} indexed financial-model workbooks`, { financialModelCount }));
    } else {
      checks.push(fail("corpus.financial_model_count", `Expected 2 financial-model workbooks, found ${financialModelCount}`, { financialModelCount }));
      blockers.push(`Financial model count: expected 2, found ${financialModelCount}`);
    }

    if (excelPhysicalChunks === 2830) {
      checks.push(pass("corpus.excel_chunks", `${excelPhysicalChunks} Excel physical chunks`, { excelPhysicalChunks }));
    } else {
      checks.push(fail("corpus.excel_chunks", `Expected 2,830 Excel chunks, found ${excelPhysicalChunks}`, { excelPhysicalChunks }));
      blockers.push(`Excel chunk count: expected 2830, found ${excelPhysicalChunks}`);
    }

    if (nonExcelPhysicalChunks === 1048) {
      checks.push(pass("corpus.non_excel_chunks", `${nonExcelPhysicalChunks} non-Excel physical chunks`, { nonExcelPhysicalChunks }));
    } else {
      checks.push(fail("corpus.non_excel_chunks", `Expected 1,048 non-Excel chunks, found ${nonExcelPhysicalChunks}`, { nonExcelPhysicalChunks }));
      blockers.push(`Non-Excel chunk count: expected 1048, found ${nonExcelPhysicalChunks}`);
    }

    const corpusSummary = {
      documentCount,
      physicalChunkCount,
      excelPhysicalChunks,
      nonExcelPhysicalChunks,
      financialModelCount,
      excelDocuments: excelDocs.map(d => ({ fileName: d.fileName, tag: d.tag, chunkCount: d.chunkCount })),
      nonExcelDocuments: nonExcelDocs.map(d => ({ fileName: d.fileName, tag: d.tag, chunkCount: d.chunkCount })),
      zeroChunkDocuments: zeroChunkRows.length,
      orphanChunks,
      duplicatePairs: dupRows.length,
      gapCount: gapRows.length,
    };

    // ═══════════════════════════════════════════════════════════════
    // §3: EXCEL RECONSTRUCTION AND PLANNER CHECKS
    // ═══════════════════════════════════════════════════════════════

    interface WindowSummary {
      documentId: string;
      fileName: string;
      physicalChunks: number;
      logicalWindows: number;
      sheets: number;
      normalWindows: number;
      repairedWindows: number;
      crossSheetWindows: number;
      oversizeRepairWindows: number;
      oversizeWindows: number;
      charStats: { min: number; median: number; p95: number; max: number };
      avgOwnedChunks: number;
      planHash: string;
    }

    const windowSummaries: WindowSummary[] = [];
    let totalExcelWindows = 0;
    let plannerBlocker = false;

    for (const excelDoc of excelDocs) {
      // Fetch all chunks for this document
      const docChunks = await db.query(
        `SELECT dc.id AS chunk_id, dc.chunk_index, dc.content,
                dc.document_id, dc.file_name AS source_file
         FROM document_chunks dc
         WHERE dc.document_id = $1::uuid AND dc.deal_id = $2::uuid
         ORDER BY dc.chunk_index ASC`,
        z.object({
          chunk_id: z.string(),
          chunk_index: z.number(),
          content: z.string(),
          document_id: z.string(),
          source_file: z.string(),
        }),
        [excelDoc.documentId, dealId],
        { label: `Preflight: fetch chunks for ${excelDoc.fileName.slice(0, 40)}` },
      );

      if (docChunks.length === 0) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.chunks`, `No chunks found for ${excelDoc.fileName}`));
        blockers.push(`No chunks for Excel doc: ${excelDoc.fileName}`);
        plannerBlocker = true;
        continue;
      }

      // 3a: Overlap validation — verify 200-character overlaps
      let overlapIssues = 0;
      for (let i = 1; i < docChunks.length; i++) {
        const prevContent = docChunks[i - 1].content;
        const currContent = docChunks[i].content;
        const prevTail = prevContent.slice(-200);
        const currHead = currContent.slice(0, 200);
        if (prevTail !== currHead) {
          overlapIssues++;
        }
      }

      if (overlapIssues > 0) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.overlap`, `${overlapIssues} overlap mismatches in ${excelDoc.fileName}`, { overlapIssues }));
        blockers.push(`Overlap validation failed for ${excelDoc.fileName}: ${overlapIssues} mismatches`);
        plannerBlocker = true;
      }

      // Build PhysicalChunk array
      const physicalChunks: PhysicalChunk[] = docChunks.map(c => ({
        chunk_id: c.chunk_id,
        chunk_index: c.chunk_index,
        content: c.content,
        document_id: c.document_id,
        source_file: c.source_file,
        document_tag: excelDoc.tag ?? "other",
      }));

      // 3b: Run planner
      const windows = buildLogicalWindows(physicalChunks);

      // 3c: Determinism — run planner again and compare
      const windows2 = buildLogicalWindows(physicalChunks);
      const planStr1 = JSON.stringify(windows.map(w => ({
        idx: w.windowIndex,
        owned: w.ownedChunkIds,
        chars: w.totalChars,
        primaryChars: w.primaryChars,
        contextChars: w.contextChars,
      })));
      const planStr2 = JSON.stringify(windows2.map(w => ({
        idx: w.windowIndex,
        owned: w.ownedChunkIds,
        chars: w.totalChars,
        primaryChars: w.primaryChars,
        contextChars: w.contextChars,
      })));

      const planHash = crypto.createHash("sha256").update(planStr1).digest("hex").slice(0, 16);
      const deterministic = planStr1 === planStr2;

      if (!deterministic) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.determinism`, `Planner is non-deterministic for ${excelDoc.fileName}`));
        blockers.push(`Planner non-deterministic for ${excelDoc.fileName}`);
        plannerBlocker = true;
      }

      // 3d: Ownership assertions
      const allOwnedChunkIds = new Set<string>();
      let duplicateOwnership = false;
      let missingOwnership = false;
      const physicalChunkIds = new Set(docChunks.map(c => c.chunk_id));

      for (const win of windows) {
        for (const cid of win.ownedChunkIds) {
          if (allOwnedChunkIds.has(cid)) {
            duplicateOwnership = true;
          }
          allOwnedChunkIds.add(cid);
          if (!physicalChunkIds.has(cid)) {
            missingOwnership = true;
          }
        }
      }

      // Complete partition check
      const uncovered = [...physicalChunkIds].filter(id => !allOwnedChunkIds.has(id));

      if (duplicateOwnership) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.ownership`, `Duplicate ownership in ${excelDoc.fileName}`));
        blockers.push(`Duplicate chunk ownership in ${excelDoc.fileName}`);
        plannerBlocker = true;
      }

      if (uncovered.length > 0) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.partition`, `${uncovered.length} unowned chunks in ${excelDoc.fileName}`));
        blockers.push(`${uncovered.length} unowned chunks in ${excelDoc.fileName}`);
        plannerBlocker = true;
      }

      // 3e: Window size classification
      const sheetMarkerRe = /^--- Sheet: .+ ---$/gm;
      let normalCount = 0;
      let repairedCount = 0;
      let crossSheetCount = 0;
      let oversizeRepairCount = 0;
      let oversizeCount = 0;
      const charCounts: number[] = [];
      let totalOwnedChunks = 0;

      for (const win of windows) {
        charCounts.push(win.totalChars);
        totalOwnedChunks += win.ownedChunkIds.length;

        const sheetMarkers = win.windowText.match(sheetMarkerRe) || [];
        const isCrossSheet = sheetMarkers.length > 1;

        if (win.totalChars > 12000) {
          oversizeCount++;
        } else if (win.totalChars > 10000) {
          repairedCount++;
          if (isCrossSheet) {
            crossSheetCount++;
            oversizeRepairCount++;
          }
        } else {
          normalCount++;
          if (isCrossSheet) {
            crossSheetCount++;
          }
        }
      }

      charCounts.sort((a, b) => a - b);
      const sheetSet = new Set<string>();
      for (const win of windows) {
        const markers = win.windowText.match(sheetMarkerRe) || [];
        for (const m of markers) {
          sheetSet.add(m.replace(/^--- Sheet: /, "").replace(/ ---$/, ""));
        }
      }

      const summary: WindowSummary = {
        documentId: excelDoc.documentId,
        fileName: excelDoc.fileName,
        physicalChunks: docChunks.length,
        logicalWindows: windows.length,
        sheets: sheetSet.size,
        normalWindows: normalCount,
        repairedWindows: repairedCount,
        crossSheetWindows: crossSheetCount,
        oversizeRepairWindows: oversizeRepairCount,
        oversizeWindows: oversizeCount,
        charStats: {
          min: charCounts[0] ?? 0,
          median: median(charCounts),
          p95: percentile(charCounts, 95),
          max: charCounts[charCounts.length - 1] ?? 0,
        },
        avgOwnedChunks: windows.length > 0 ? Math.round((totalOwnedChunks / windows.length) * 100) / 100 : 0,
        planHash,
      };

      windowSummaries.push(summary);
      totalExcelWindows += windows.length;

      if (oversizeCount > 0) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.oversize`, `${oversizeCount} windows > 12,000 chars in ${excelDoc.fileName}`));
        blockers.push(`${oversizeCount} oversize windows in ${excelDoc.fileName}`);
        plannerBlocker = true;
      }

      if (crossSheetCount > 0 && !plannerBlocker) {
        checks.push(warn(`planner.${excelDoc.documentId.slice(0, 8)}.cross_sheet`, `${crossSheetCount} cross-sheet windows in ${excelDoc.fileName}`, { crossSheetCount }));
        warnings.push(`${crossSheetCount} cross-sheet windows in ${excelDoc.fileName}`);
      }

      // Window ordering check — windows should be ordered by first owned chunk_index
      let orderValid = true;
      for (let i = 1; i < windows.length; i++) {
        const prevFirstChunk = docChunks.find(c => c.chunk_id === windows[i - 1].ownedChunkIds[0]);
        const currFirstChunk = docChunks.find(c => c.chunk_id === windows[i].ownedChunkIds[0]);
        if (prevFirstChunk && currFirstChunk && prevFirstChunk.chunk_index >= currFirstChunk.chunk_index) {
          orderValid = false;
          break;
        }
      }

      if (!orderValid) {
        checks.push(fail(`planner.${excelDoc.documentId.slice(0, 8)}.order`, `Windows not ordered by owned physical chunks in ${excelDoc.fileName}`));
        blockers.push(`Window ordering violated in ${excelDoc.fileName}`);
        plannerBlocker = true;
      }
    }

    if (!plannerBlocker && excelDocs.length > 0) {
      checks.push(pass("planner.all_invariants", `All planner invariants pass for ${excelDocs.length} Excel documents`, {
        totalExcelWindows,
        documents: excelDocs.length,
      }));
    }

    const logicalWindowSummary = {
      excelDocuments: excelDocs.length,
      totalExcelWindows,
      windowSummaries,
    };

    // ═══════════════════════════════════════════════════════════════
    // §4: CALL-REDUCTION CHECK
    // ═══════════════════════════════════════════════════════════════

    const projectedExcelCalls = totalExcelWindows;
    const projectedNonExcelCalls = nonExcelPhysicalChunks;
    const projectedTotalCalls = projectedExcelCalls + projectedNonExcelCalls;
    const reductionPct = physicalChunkCount > 0
      ? Math.round((1 - projectedTotalCalls / physicalChunkCount) * 100)
      : 0;

    checks.push(pass("call_reduction.projection", `Projected ${projectedTotalCalls} total calls (${reductionPct}% reduction from ${physicalChunkCount})`, {
      projectedExcelCalls,
      projectedNonExcelCalls,
      projectedTotalCalls,
      physicalChunkBaseline: physicalChunkCount,
      reductionPercent: reductionPct,
    }));

    const projectedModelCalls = {
      projectedExcelCalls,
      projectedNonExcelCalls,
      projectedTotalCalls,
      physicalChunkBaseline: physicalChunkCount,
      reductionPercent: reductionPct,
    };

    // ═══════════════════════════════════════════════════════════════
    // §5: RUN-STATE CHECKS
    // ═══════════════════════════════════════════════════════════════

    const moduleRunRows = await db.query(
      `SELECT mr.id, mr.status, mr.triggered_at, mr.completed_at,
              mr.documents_included
       FROM module_runs mr
       WHERE mr.deal_id = $1::uuid AND mr.module_id = 'diligence_completeness'
       ORDER BY mr.triggered_at DESC
       LIMIT 10`,
      z.object({
        id: z.string(),
        status: z.string(),
        triggered_at: z.string().nullable(),
        completed_at: z.string().nullable(),
        documents_included: z.any().nullable(),
      }),
      [dealId],
      { label: "Preflight: module runs" },
    );

    interface RunStateInfo {
      runId: string;
      moduleStatus: string;
      extractState: any;
      verdictState: any;
      renderState: any;
      evidenceCount: number;
      verdictCount: number;
      summaryCount: number;
      outputCount: number;
      orderingVersion: string | null;
      workUnitVersion: string | null;
      cursor: string | null;
      processedCount: number;
    }

    const runStates: RunStateInfo[] = [];
    let activeRunBlocker = false;

    for (const mr of moduleRunRows) {
      // Pipeline state for this run
      const stateRows = await db.query(
        `SELECT stage, status, cursor_value, detail, owner_token, updated_at
         FROM dcs_pipeline_state
         WHERE run_id = $1::uuid
         ORDER BY stage
         LIMIT 10`,
        z.object({
          stage: z.string(),
          status: z.string(),
          cursor_value: z.string().nullable(),
          detail: z.string().nullable(),
          owner_token: z.string().nullable(),
          updated_at: z.string().nullable(),
        }),
        [mr.id],
        { label: `Preflight: state for run ${mr.id.slice(0, 8)}` },
      );

      const extractState = stateRows.find(s => s.stage === "extract");
      const verdictState = stateRows.find(s => s.stage === "verdicts");
      const renderState = stateRows.find(s => s.stage === "render");

      // Evidence count
      const evRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM dcs_evidence WHERE run_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [mr.id],
        { label: `Preflight: evidence count for run ${mr.id.slice(0, 8)}` },
      );

      // Verdict count
      const vRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM dcs_dimension_verdicts WHERE run_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [mr.id],
        { label: `Preflight: verdict count for run ${mr.id.slice(0, 8)}` },
      );

      // Summary count
      const sRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM dcs_run_summary WHERE run_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [mr.id],
        { label: `Preflight: summary count for run ${mr.id.slice(0, 8)}` },
      );

      // Output count
      const oRows = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM module_outputs WHERE module_run_id = $1::uuid`,
        z.object({ cnt: z.number() }),
        [mr.id],
        { label: `Preflight: output count for run ${mr.id.slice(0, 8)}` },
      );

      let orderingVer: string | null = null;
      let workUnitVer: string | null = null;
      let cursor: string | null = null;
      let processedCount = 0;

      if (extractState?.detail) {
        try {
          const detail = JSON.parse(extractState.detail);
          orderingVer = detail.ordering_version ?? null;
          workUnitVer = detail.work_unit_version ?? null;
          processedCount = detail.processed_count ?? 0;
        } catch {}
      }
      cursor = extractState?.cursor_value ?? null;

      runStates.push({
        runId: mr.id,
        moduleStatus: mr.status,
        extractState: extractState ? {
          status: extractState.status,
          cursor: extractState.cursor_value,
          ownerToken: extractState.owner_token ? `${extractState.owner_token.slice(0, 8)}…` : null,
          updatedAt: extractState.updated_at,
        } : null,
        verdictState: verdictState ? { status: verdictState.status } : null,
        renderState: renderState ? { status: renderState.status } : null,
        evidenceCount: evRows[0]?.cnt ?? 0,
        verdictCount: vRows[0]?.cnt ?? 0,
        summaryCount: sRows[0]?.cnt ?? 0,
        outputCount: oRows[0]?.cnt ?? 0,
        orderingVersion: orderingVer,
        workUnitVersion: workUnitVer,
        cursor,
        processedCount,
      });

      // Check for active runs
      const isActive = ["running", "pending"].includes(mr.status);
      const isStagePartial = extractState?.status === "running" && extractState?.owner_token;
      const isFresh = ["running", "pending"].includes(mr.status) &&
        !extractState && evRows[0]?.cnt === 0;

      if (isActive || isStagePartial) {
        // Check staleness
        const updatedAt = extractState?.updated_at ? new Date(extractState.updated_at).getTime() : 0;
        const isStale = Date.now() - updatedAt > 10 * 60 * 1000;

        if (!isStale && isStagePartial) {
          checks.push(fail("run_state.active_run", `Run ${mr.id.slice(0, 8)} is actively running (extract in progress)`, { runId: mr.id }));
          blockers.push(`Active DCS run: ${mr.id.slice(0, 8)}`);
          activeRunBlocker = true;
        } else if (isActive && !isStale) {
          checks.push(fail("run_state.active_run", `Run ${mr.id.slice(0, 8)} has module status: ${mr.status}`, { runId: mr.id }));
          blockers.push(`Active DCS run: ${mr.id.slice(0, 8)} (status: ${mr.status})`);
          activeRunBlocker = true;
        }
      }

      // Warning for failed/throwaway runs
      if (mr.status === "failed") {
        warnings.push(`Historical failed run: ${mr.id.slice(0, 8)}`);
      }

      // Warning for existing published output
      if ((oRows[0]?.cnt ?? 0) > 0) {
        warnings.push(`Run ${mr.id.slice(0, 8)} has existing published output`);
      }
    }

    if (!activeRunBlocker) {
      checks.push(pass("run_state.no_active_run", "No active DCS run"));
    }

    const runStateSummary = {
      totalRuns: moduleRunRows.length,
      runs: runStates,
    };

    // ═══════════════════════════════════════════════════════════════
    // §6: DATABASE CONTRACT CHECKS
    // ═══════════════════════════════════════════════════════════════

    // 6a: Required tables queryable
    const requiredTables = [
      "module_runs", "document_chunks", "documents",
      "dcs_evidence", "dcs_pipeline_state",
      "dcs_dimension_verdicts", "dcs_run_summary", "module_outputs",
    ];

    for (const table of requiredTables) {
      try {
        await db.query(
          `SELECT 1 AS ok FROM ${table} LIMIT 1`,
          z.object({ ok: z.number() }),
          [],
          { label: `Preflight: probe ${table}` },
        );
        // Table is queryable (even if empty)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push(fail(`db.table.${table}`, `Table ${table} not queryable: ${msg.slice(0, 200)}`));
        blockers.push(`Table ${table} not queryable`);
      }
    }

    checks.push(pass("db.tables_queryable", `All ${requiredTables.length} required tables are queryable`));

    // 6b: Ten DCS rubric dimensions
    const rubricCount = DCS_DIMENSIONS.length;
    if (rubricCount === 10) {
      checks.push(pass("db.rubric_dimensions", `${rubricCount} DCS rubric dimensions`, { dimensions: DCS_DIMENSIONS.map(d => d.id) }));
    } else {
      checks.push(fail("db.rubric_dimensions", `Expected 10 dimensions, found ${rubricCount}`));
      blockers.push(`Rubric dimension count: expected 10, found ${rubricCount}`);
    }

    // 6c: Unknown dimension IDs in evidence
    const validDimIds = new Set(DCS_DIMENSIONS.map(d => d.id));
    const unknownDimRows = await db.query(
      `SELECT DISTINCT e.dimension_id
       FROM dcs_evidence e
       JOIN module_runs mr ON mr.id = e.run_id
       WHERE mr.deal_id = $1::uuid
       LIMIT 20`,
      z.object({ dimension_id: z.string() }),
      [dealId],
      { label: "Preflight: distinct evidence dimensions" },
    );

    const unknownDims = unknownDimRows.filter(r => !validDimIds.has(r.dimension_id));
    if (unknownDims.length === 0) {
      checks.push(pass("db.dimension_ids_valid", "No unknown dimension IDs in evidence"));
    } else {
      checks.push(fail("db.dimension_ids_valid", `${unknownDims.length} unknown dimension IDs: ${unknownDims.map(d => d.dimension_id).join(", ")}`));
      blockers.push(`Unknown dimension IDs in evidence: ${unknownDims.map(d => d.dimension_id).join(", ")}`);
    }

    // 6d: Duplicate evidence rows
    const dupEvidenceRows = await db.query(
      `SELECT e.run_id, e.chunk_id, e.dimension_id, COUNT(*)::int AS cnt
       FROM dcs_evidence e
       JOIN module_runs mr ON mr.id = e.run_id
       WHERE mr.deal_id = $1::uuid
       GROUP BY e.run_id, e.chunk_id, e.dimension_id
       HAVING COUNT(*) > 1
       LIMIT 5`,
      z.object({ run_id: z.string(), chunk_id: z.string(), dimension_id: z.string(), cnt: z.number() }),
      [dealId],
      { label: "Preflight: duplicate evidence check" },
    );

    if (dupEvidenceRows.length === 0) {
      checks.push(pass("db.no_duplicate_evidence", "No duplicate run_id + chunk_id + dimension_id rows"));
    } else {
      checks.push(fail("db.no_duplicate_evidence", `${dupEvidenceRows.length} duplicate evidence rows`, { duplicates: dupEvidenceRows }));
      blockers.push(`${dupEvidenceRows.length} duplicate evidence rows`);
    }

    // 6e: doc_class leakage check
    const docClassRows = await db.query(
      `SELECT DISTINCT e.document_tag, e.doc_class
       FROM dcs_evidence e
       JOIN module_runs mr ON mr.id = e.run_id
       WHERE mr.deal_id = $1::uuid
       LIMIT 20`,
      z.object({ document_tag: z.string().nullable(), doc_class: z.string() }),
      [dealId],
      { label: "Preflight: doc_class leakage check" },
    );

    let docClassLeakage = false;
    for (const row of docClassRows) {
      const expectedClass = classifyDocClass(row.document_tag);
      if (row.doc_class !== expectedClass) {
        docClassLeakage = true;
        checks.push(fail("db.doc_class_leakage", `Tag "${row.document_tag}" has doc_class="${row.doc_class}" but expected "${expectedClass}"`));
        blockers.push(`doc_class leakage: tag=${row.document_tag} got ${row.doc_class} expected ${expectedClass}`);
      }
    }

    if (!docClassLeakage && docClassRows.length > 0) {
      checks.push(pass("db.doc_class_valid", "No doc_class leakage — all tag→class mappings valid"));
    }

    // ═══════════════════════════════════════════════════════════════
    // FINAL DECISION
    // ═══════════════════════════════════════════════════════════════

    const readyForLiveRun = blockers.length === 0;

    return {
      readyForLiveRun,
      status: readyForLiveRun ? "ready" : "blocked",
      checks,
      blockers,
      warnings,
      corpusSummary,
      logicalWindowSummary,
      runStateSummary,
      projectedModelCalls,
    };
  },
});
