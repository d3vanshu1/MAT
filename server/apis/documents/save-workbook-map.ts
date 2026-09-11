import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const WorkbookInputSchema = z.object({
  documentId: z.string().uuid(),
  workbookRole: z.string(),
  roleSource: z.string(),
  fileHash: z.string(),
  captureVersion: z.number(),
  loadStatus: z.string().optional(), // Ignored — always inserted as 'pending'
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

    // Hash check — skip ONLY when load_status = 'complete' AND cells exist.
    // A hash match against an incomplete or empty workbook must re-ingest.
    const existingRows = await db.query(
      `SELECT id, load_status FROM workbooks
       WHERE document_id = $1 AND file_hash = $2`,
      z.object({ id: z.string(), load_status: z.string().nullable() }),
      [workbook.documentId, workbook.fileHash],
      { label: "SaveWorkbookMap: hash check" },
    );

    if (existingRows.length > 0 && existingRows[0].load_status === "complete") {
      const cellCount = await db.query(
        `SELECT count(*)::int AS cnt FROM workbook_cells WHERE workbook_id = $1`,
        z.object({ cnt: z.number() }),
        [existingRows[0].id],
        { label: "SaveWorkbookMap: verify cells exist" },
      );
      if (cellCount[0].cnt > 0) {
        return { workbookId: existingRows[0].id, skippedByHash: true };
      }
    }

    // Transactional rebuild: do NOT delete old workbook yet.
    // Old cells survive until CompleteWorkbookMap swaps them out.
    // Delete any stale PENDING workbooks for this document (failed prior attempts).
    await db.execute(
      `DELETE FROM workbooks WHERE document_id = $1 AND (load_status = 'pending' OR load_status IS NULL)`,
      [workbook.documentId],
      { label: "SaveWorkbookMap: clear stale pending" },
    );

    // Insert new workbook as PENDING — old complete workbook stays alive.
    const wbRows = await db.query(
      `INSERT INTO workbooks (document_id, workbook_role, role_source, file_hash,
         capture_version, style_tables, defined_names, load_status, load_reason)
       VALUES ($1, $2, $3, $4, $5, '{}', '[]', 'pending', $6)
       RETURNING id`,
      WorkbookIdSchema,
      [
        workbook.documentId,
        workbook.workbookRole,
        workbook.roleSource,
        workbook.fileHash,
        workbook.captureVersion,
        workbook.loadReason,
      ],
      { label: "SaveWorkbookMap: insert pending workbook" },
    );

    return { workbookId: wbRows[0].id, skippedByHash: false };
  },
});
