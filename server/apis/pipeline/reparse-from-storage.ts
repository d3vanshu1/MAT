/**
 * reparse-from-storage.ts — Read stored file bytes, verify hash, 
 * and rebuild the workbook map server-side.
 *
 * Phase 1 re-parse: reads chunks from document_files, reassembles,
 * verifies SHA-256 against workbooks.file_hash, then parses with
 * SheetJS and rebuilds workbook_cells.
 *
 * After this, run Phases 2-4 as normal (all idempotent).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import * as XLSX from "xlsx";
// Use Web Crypto API (available in SDK runtime)

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ChunkRow = z.object({
  chunk_index: z.number(),
  bytes: z.string(), // base64 from postgres bytea
  byte_count: z.number(),
});

export default api({
  name: "ReparseFromStorage",
  description: "Reads stored file bytes, verifies hash, reports cell addresses for a sheet",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    workbookId: z.string(),
    /** Only verify hash + report address diagnostics (no DB writes) */
    diagnosticOnly: z.boolean().optional(),
    /** Sheets to spot-check addresses on */
    checkSheets: z.array(z.string()).optional(),
  }),

  output: z.object({
    bytesRead: z.number(),
    chunksRead: z.number(),
    hashMatch: z.boolean(),
    storedHash: z.string().nullable(),
    computedHash: z.string(),
    addressCheck: z.array(z.object({
      sheetName: z.string(),
      totalCells: z.number(),
      sampleAddresses: z.array(z.object({
        sheetJsAddr: z.string(),
        row: z.number(),
        col: z.number(),
        value: z.any(),
      })),
    })),
  }),

  async run(ctx, { documentId, workbookId, diagnosticOnly, checkSheets }) {
    // 1. Read chunks
    const chunks = await ctx.integrations.db.query(
      `SELECT chunk_index, encode(bytes, 'base64') AS bytes, byte_count
       FROM document_files
       WHERE document_id = $1::uuid
       ORDER BY chunk_index`,
      ChunkRow,
      [documentId],
      { label: "Read file chunks" }
    );

    if (chunks.length === 0) {
      throw new Error(`No stored file chunks for document ${documentId}`);
    }

    // 2. Reassemble
    const totalBytes = chunks.reduce((sum, c) => sum + c.byte_count, 0);
    const combined = Buffer.alloc(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      const buf = Buffer.from(chunk.bytes, "base64");
      buf.copy(combined, offset);
      offset += buf.length;
    }

    // 3. Hash and verify
    // SHA-256 via Web Crypto API
    const hashBuffer = await crypto.subtle.digest("SHA-256", combined);
    const hashArray = new Uint8Array(hashBuffer);
    const hex = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
    const computedHash = `sha256:${hex}`;

    // Get stored hash from document_files (set on last chunk)
    const hashRows = await ctx.integrations.db.query(
      `SELECT file_hash FROM document_files WHERE document_id = $1::uuid AND file_hash IS NOT NULL LIMIT 1`,
      z.object({ file_hash: z.string().nullable() }),
      [documentId],
      { label: "Get stored file hash" }
    );
    const storedHash = hashRows[0]?.file_hash ?? null;

    // Also check workbooks.file_hash as fallback
    if (!storedHash) {
      const wbHash = await ctx.integrations.db.query(
        `SELECT file_hash FROM workbooks WHERE id = $1::uuid LIMIT 1`,
        z.object({ file_hash: z.string().nullable() }),
        [workbookId],
        { label: "Get workbook hash" }
      );
      const wbStoredHash = wbHash[0]?.file_hash ?? null;
      if (wbStoredHash) {
        return {
          bytesRead: totalBytes,
          chunksRead: chunks.length,
          hashMatch: wbStoredHash === computedHash,
          storedHash: wbStoredHash,
          computedHash,
          addressCheck: [],
        };
      }
    }
    const hashMatch = storedHash === computedHash;

    // 4. Parse with SheetJS and check addresses
    const wb = XLSX.read(combined, {
      type: "buffer",
      cellDates: true,
      cellNF: true,
      cellFormula: true,
    });

    const sheetsToCheck = checkSheets ?? wb.SheetNames.slice(0, 3);
    const addressCheck: Array<{
      sheetName: string;
      totalCells: number;
      sampleAddresses: Array<{
        sheetJsAddr: string;
        row: number;
        col: number;
        value: unknown;
      }>;
    }> = [];

    for (const sheetName of sheetsToCheck) {
      const ws = wb.Sheets[sheetName];
      if (!ws || !ws["!ref"]) continue;

      const range = XLSX.utils.decode_range(ws["!ref"]);
      let cellCount = 0;
      const samples: typeof addressCheck[0]["sampleAddresses"] = [];

      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] as XLSX.CellObject | undefined;
          if (!cell || cell.v == null) continue;
          cellCount++;

          // Sample: first 5 and last 5 cells, plus cells at known addresses
          if (samples.length < 5 || (cellCount % 100 === 0 && samples.length < 20)) {
            samples.push({
              sheetJsAddr: addr,
              row: r,
              col: c,
              value: cell.v,
            });
          }
        }
      }

      // Also grab the last few cells
      const lastCells: typeof samples = [];
      for (let r = range.e.r; r >= Math.max(range.s.r, range.e.r - 10); r--) {
        for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 10); c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] as XLSX.CellObject | undefined;
          if (!cell || cell.v == null) continue;
          if (lastCells.length < 5) {
            lastCells.push({ sheetJsAddr: addr, row: r, col: c, value: cell.v });
          }
        }
        if (lastCells.length >= 5) break;
      }

      addressCheck.push({
        sheetName,
        totalCells: cellCount,
        sampleAddresses: [...samples, ...lastCells],
      });
    }

    return {
      bytesRead: totalBytes,
      chunksRead: chunks.length,
      hashMatch,
      storedHash,
      computedHash,
      addressCheck,
    };
  },
});
