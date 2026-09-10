/**
 * diag-workbook-roundtrip.ts — Phase 4.4
 *
 * Round-trip test: for selected sheets, compare display_value from workbook_cells
 * against the original parsed values in doc_tables.
 *
 * Reports: filename, hash, upload timestamp, capture version (provenance header),
 * then per-sheet match/mismatch/missing counts with sample diffs.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "DiagWorkbookRoundtrip",
  description: "Round-trip test: compares display_value against doc_tables parsed values",
  integrations: {
    ic_db: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string(),
    sheetNames: z.array(z.string()),
  }),
  output: z.object({
    provenance: z.object({
      fileName: z.string().nullable(),
      fileHash: z.string().nullable(),
      uploadedAt: z.string().nullable(),
      captureVersion: z.any(),
    }),
    sheets: z.array(z.object({
      sheetName: z.string(),
      mapCells: z.number(),
      docTableCells: z.number(),
      compared: z.number(),
      matched: z.number(),
      mismatched: z.number(),
      mapOnly: z.number(),
      docOnly: z.number(),
      mismatchSamples: z.array(z.object({
        cellRef: z.string(),
        mapDisplay: z.string().nullable(),
        docValue: z.string(),
        valueRaw: z.string().nullable(),
        format: z.string().nullable(),
      })),
    })),
    summary: z.object({
      totalCompared: z.number(),
      totalMatched: z.number(),
      totalMismatched: z.number(),
      matchRate: z.number(),
    }),
  }),

  async run(ctx, { workbookId, sheetNames }) {
    const q = ctx.integrations.ic_db;

    // --- Provenance header ---
    const WbRow = z.object({
      file_hash: z.string().nullable(),
      capture_version: z.number().nullable(),
      parsed_at: z.string().nullable(),
      document_id: z.string().nullable(),
    });
    const [wb] = await q.query(
      "SELECT file_hash, capture_version, parsed_at::text, document_id FROM workbooks WHERE id = $1",
      WbRow,
      [workbookId],
      { label: "Get workbook provenance" },
    );

    let fileName: string | null = null;
    if (wb?.document_id) {
      const DocRow = z.object({ file_name: z.string().nullable() });
      const [doc] = await q.query(
        "SELECT file_name FROM documents WHERE id = $1",
        DocRow,
        [wb.document_id],
        { label: "Get document filename" },
      );
      fileName = doc?.file_name ?? null;
    }

    const provenance = {
      fileName,
      fileHash: wb?.file_hash ?? null,
      uploadedAt: wb?.parsed_at ?? null,
      captureVersion: wb?.capture_version != null ? String(wb.capture_version) : null,
    };

    // --- Per-sheet comparison ---
    const MapCell = z.object({
      cell_ref: z.string(),
      display_value: z.string().nullable(),
      value_raw: z.string().nullable(),
      number_format: z.string().nullable(),
      value_type: z.string().nullable(),
    });

    const DocTableRow = z.object({
      data: z.any(),
    });

    const sheets: Array<{
      sheetName: string; mapCells: number; docTableCells: number;
      compared: number; matched: number; mismatched: number;
      mapOnly: number; docOnly: number;
      mismatchSamples: Array<{
        cellRef: string; mapDisplay: string | null; docValue: string;
        valueRaw: string | null; format: string | null;
      }>;
    }> = [];

    let totalCompared = 0, totalMatched = 0, totalMismatched = 0;

    for (const sheetName of sheetNames) {
      // Load map cells (paginated)
      const mapIndex = new Map<string, z.infer<typeof MapCell>>();
      const PAGE = 5000;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await q.query(
          `SELECT cell_ref, display_value, value_raw::text AS value_raw, number_format, value_type
           FROM workbook_cells
           WHERE workbook_id = $1 AND sheet_name = $2 AND cell_ref IS NOT NULL
           ORDER BY row_idx, col_idx LIMIT $3 OFFSET $4`,
          MapCell,
          [workbookId, sheetName, PAGE, offset],
          { label: `Round-trip map cells: ${sheetName} (${offset})` },
        );
        for (const c of page) mapIndex.set(c.cell_ref, c);
        hasMore = page.length === PAGE;
        offset += PAGE;
      }

      // Load doc_tables cells for this sheet
      const docRows = await q.query(
        `SELECT data FROM doc_tables
         WHERE document_id = $1 AND sheet_or_page = $2`,
        DocTableRow,
        [wb?.document_id ?? "", sheetName],
        { label: `Round-trip doc_tables: ${sheetName}` },
      );

      // Build doc cell index: cell_ref → display string
      const docIndex = new Map<string, string>();
      for (const dr of docRows) {
        const cells = dr.data?.cells ?? [];
        for (const cell of cells) {
          if (cell.value === null || cell.value === undefined) continue;
          // Convert r,c to cell_ref (A1 notation)
          const col = cell.c ?? 0;
          const row = (cell.r ?? 0) + 1;
          let colStr = "";
          let c = col;
          while (c >= 0) {
            colStr = String.fromCharCode(65 + (c % 26)) + colStr;
            c = Math.floor(c / 26) - 1;
          }
          const ref = colStr + row;
          docIndex.set(ref, String(cell.value));
        }
      }

      // Compare
      let compared = 0, matched = 0, mismatched = 0;
      let mapOnly = 0, docOnly = 0;
      const mismatchSamples: Array<{
        cellRef: string; mapDisplay: string | null; docValue: string;
        valueRaw: string | null; format: string | null;
      }> = [];

      // Compare cells that exist in both
      for (const [ref, mapCell] of mapIndex) {
        const docVal = docIndex.get(ref);
        if (!docVal) { mapOnly++; continue; }

        // Skip text cells — display_value is only for numeric cells
        if (mapCell.value_type === "text" || mapCell.value_type === "string") continue;
        // Skip cells without display_value (General format)
        if (mapCell.display_value === null) continue;

        compared++;
        const mapDisp = mapCell.display_value.trim();
        const docStr = docVal.trim();

        // Normalize for comparison: strip commas, whitespace
        const normMap = mapDisp.replace(/,/g, "").replace(/\s+/g, " ");
        const normDoc = docStr.replace(/,/g, "").replace(/\s+/g, " ");

        if (normMap === normDoc) {
          matched++;
        } else {
          // Try numeric equivalence (e.g., "32.9" vs "32.92133...")
          const mapNum = parseFloat(normMap.replace(/[^0-9.\-]/g, ""));
          const docNum = parseFloat(normDoc.replace(/[^0-9.\-]/g, ""));
          if (!isNaN(mapNum) && !isNaN(docNum) && Math.abs(mapNum - docNum) < 0.05) {
            matched++; // Rounding match
          } else {
            mismatched++;
            if (mismatchSamples.length < 10) {
              mismatchSamples.push({
                cellRef: ref,
                mapDisplay: mapCell.display_value,
                docValue: docVal,
                valueRaw: mapCell.value_raw,
                format: mapCell.number_format,
              });
            }
          }
        }
      }

      // Count doc-only (cells in doc_tables not in map)
      for (const ref of docIndex.keys()) {
        if (!mapIndex.has(ref)) docOnly++;
      }

      totalCompared += compared;
      totalMatched += matched;
      totalMismatched += mismatched;

      sheets.push({
        sheetName,
        mapCells: mapIndex.size,
        docTableCells: docIndex.size,
        compared,
        matched,
        mismatched,
        mapOnly,
        docOnly,
        mismatchSamples,
      });
    }

    const matchRate = totalCompared > 0 ? Math.round((totalMatched / totalCompared) * 10000) / 100 : 100;

    return {
      provenance,
      sheets,
      summary: {
        totalCompared,
        totalMatched,
        totalMismatched,
        matchRate,
      },
    };
  },
});
