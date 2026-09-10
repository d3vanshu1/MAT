import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const WorkbookInputSchema = z.object({
  documentId: z.string().uuid(),
  workbookRole: z.string(),
  roleSource: z.string(),
  fileHash: z.string(),
  captureVersion: z.number(),
  loadStatus: z.string(),
  loadReason: z.string().nullable(),
});

const WorkbookIdSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// API — creates workbook record only (sheets, cells, styles saved separately)
// ---------------------------------------------------------------------------
export default api({
  name: "SaveWorkbookMap",
  description: "Creates a workbook record. Sheets/cells/styles saved via separate APIs.",
  integrations: {
    ic_diligence: postgres(IC_DB),
  },
  input: z.object({
    workbook: WorkbookInputSchema,
  }),
  output: z.object({
    workbookId: z.string(),
    skippedByHash: z.boolean(),
  }),
  async run(ctx, { workbook }) {
    const db = ctx.integrations.ic_diligence;

    // Hash check — skip if unchanged AND complete
    const existingRows = await db.query(
      `SELECT id FROM workbooks WHERE document_id = $1 AND file_hash = $2`,
      WorkbookIdSchema,
      [workbook.documentId, workbook.fileHash],
      { label: "SaveWorkbookMap: hash check" },
    );

    if (existingRows.length > 0) {
      const sheetCount = await db.query(
        `SELECT count(*)::int AS cnt FROM workbook_sheets WHERE workbook_id = $1`,
        z.object({ cnt: z.number() }),
        [existingRows[0].id],
        { label: "SaveWorkbookMap: verify completeness" },
      );
      if (sheetCount[0].cnt > 0) {
        return { workbookId: existingRows[0].id, skippedByHash: true };
      }
    }

    // Delete any existing workbook for this document (cascade)
    await db.execute(
      `DELETE FROM workbooks WHERE document_id = $1`,
      [workbook.documentId],
      { label: "SaveWorkbookMap: clear previous" },
    );

    // Insert workbook (style_tables and defined_names saved separately)
    const wbRows = await db.query(
      `INSERT INTO workbooks (document_id, workbook_role, role_source, file_hash,
         capture_version, style_tables, defined_names, load_status, load_reason)
       VALUES ($1, $2, $3, $4, $5, '{}', '[]', $6, $7)
       RETURNING id`,
      WorkbookIdSchema,
      [
        workbook.documentId,
        workbook.workbookRole,
        workbook.roleSource,
        workbook.fileHash,
        workbook.captureVersion,
        workbook.loadStatus,
        workbook.loadReason,
      ],
      { label: "SaveWorkbookMap: insert workbook" },
    );

    return { workbookId: wbRows[0].id, skippedByHash: false };
  },
});
