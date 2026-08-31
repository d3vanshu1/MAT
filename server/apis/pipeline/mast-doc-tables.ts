/**
 * mast-doc-tables.ts
 *
 * Leaf helper for loading doc_tables rows one sheet at a time, staying
 * under the platform 4 MB gRPC message limit.
 *
 * Imports nothing from any other MAST file.
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Exported type — a fully loaded sheet row
// ---------------------------------------------------------------------------

export interface LoadedSheet {
  id: string;
  document_id: string;
  sheet_or_page: string;
  caption: string | null;
  data: any;
}

// ---------------------------------------------------------------------------
// Internal schemas
// ---------------------------------------------------------------------------

const SheetListRow = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data_length: z.coerce.number(),
});

const SheetDataRow = z.object({
  id: z.string(),
  document_id: z.string(),
  sheet_or_page: z.string(),
  caption: z.string().nullable(),
  data: z.any(),
});

/** Maximum data_length (text representation) we will attempt to fetch. */
const DATA_LENGTH_LIMIT = 3_500_000;

const LOG_PREFIX = "[MAST-DOC-TABLES]";

// ---------------------------------------------------------------------------
// listSheets — lightweight catalogue, never selects data
// ---------------------------------------------------------------------------

export async function listSheets(
  db: any,
  documentId: string,
): Promise<Array<z.infer<typeof SheetListRow>>> {
  return db.query(
    `SELECT id, document_id, sheet_or_page, caption, length(data::text) AS data_length
     FROM doc_tables
     WHERE document_id = $1::uuid
     ORDER BY sheet_or_page ASC`,
    SheetListRow,
    [documentId],
    { label: "MAST-DOC-TABLES: list sheets" },
  );
}

// ---------------------------------------------------------------------------
// loadSheet — fetch a single sheet by its row id
// ---------------------------------------------------------------------------

export async function loadSheet(
  db: any,
  sheetId: string,
): Promise<LoadedSheet | null> {
  const rows: Array<z.infer<typeof SheetDataRow>> = await db.query(
    `SELECT id, document_id, sheet_or_page, caption, data
     FROM doc_tables
     WHERE id = $1::uuid
     LIMIT 1`,
    SheetDataRow,
    [sheetId],
    { label: "MAST-DOC-TABLES: load single sheet" },
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.id,
    document_id: r.document_id,
    sheet_or_page: r.sheet_or_page,
    caption: r.caption,
    data: r.data,
  };
}

// ---------------------------------------------------------------------------
// loadAllSheets — fetch every sheet one at a time, with size guard
// ---------------------------------------------------------------------------

export async function loadAllSheets(
  db: any,
  documentId: string,
): Promise<{ sheets: LoadedSheet[]; skipped: number }> {
  const catalogue = await listSheets(db, documentId);
  const sheets: LoadedSheet[] = [];
  let skipped = 0;

  for (const entry of catalogue) {
    if (entry.data_length > DATA_LENGTH_LIMIT) {
      console.log(
        `${LOG_PREFIX} Skipping sheet "${entry.sheet_or_page}" — data_length ${entry.data_length} exceeds ${DATA_LENGTH_LIMIT}.`,
      );
      skipped++;
      continue;
    }

    const loaded = await loadSheet(db, entry.id);
    if (loaded) {
      sheets.push(loaded);
    }
  }

  return { sheets, skipped };
}

// ---------------------------------------------------------------------------
// loadSheetByName — fetch one named sheet, with size guard
// ---------------------------------------------------------------------------

export async function loadSheetByName(
  db: any,
  documentId: string,
  sheetName: string,
): Promise<LoadedSheet | null> {
  // Look up the catalogue entry for this specific sheet
  const catalogueRows: Array<z.infer<typeof SheetListRow>> = await db.query(
    `SELECT id, document_id, sheet_or_page, caption, length(data::text) AS data_length
     FROM doc_tables
     WHERE document_id = $1::uuid AND sheet_or_page = $2
     ORDER BY id ASC
     LIMIT 1`,
    SheetListRow,
    [documentId, sheetName],
    { label: `MAST-DOC-TABLES: lookup sheet "${sheetName}"` },
  );

  if (catalogueRows.length === 0) return null;

  const entry = catalogueRows[0];
  if (entry.data_length > DATA_LENGTH_LIMIT) {
    console.log(
      `${LOG_PREFIX} Skipping sheet "${sheetName}" — data_length ${entry.data_length} exceeds ${DATA_LENGTH_LIMIT}.`,
    );
    return null;
  }

  return loadSheet(db, entry.id);
}
