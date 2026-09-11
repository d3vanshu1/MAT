import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * CompleteWorkbookMap — flips a pending workbook to complete and deletes
 * the old complete workbook for the same document in one transaction.
 *
 * Old cells survive until this call succeeds. If the upload fails mid-way,
 * the pending workbook stays pending and the old one remains intact.
 */
export default api({
  name: "CompleteWorkbookMap",
  description: "Marks a pending workbook as complete, deletes old version.",
  integrations: {
    ic_diligence: postgres(IC_DB),
  },
  input: z.object({
    workbookId: z.string().uuid(),
    documentId: z.string().uuid(),
  }),
  output: z.object({
    completed: z.boolean(),
    oldWorkbookDeleted: z.boolean(),
    cellCount: z.number(),
  }),
  async run(ctx, { workbookId, documentId }) {
    const db = ctx.integrations.ic_diligence;

    // Verify the pending workbook has cells
    const countRows = await db.query(
      `SELECT count(*)::int AS cnt FROM workbook_cells WHERE workbook_id = $1`,
      z.object({ cnt: z.number() }),
      [workbookId],
      { label: "CompleteWorkbookMap: count cells" },
    );
    const cellCount = countRows[0].cnt;

    if (cellCount === 0) {
      console.warn(`[CompleteWorkbookMap] workbook ${workbookId} has 0 cells — not marking complete`);
      return { completed: false, oldWorkbookDeleted: false, cellCount: 0 };
    }

    // Delete old complete workbooks for this document (cascade deletes their cells/sheets)
    const deleteResult = await db.execute(
      `DELETE FROM workbooks WHERE document_id = $1 AND id != $2 AND load_status = 'complete'`,
      [documentId, workbookId],
      { label: "CompleteWorkbookMap: delete old complete" },
    );

    // Mark the new workbook as complete
    await db.execute(
      `UPDATE workbooks SET load_status = 'complete' WHERE id = $1`,
      [workbookId],
      { label: "CompleteWorkbookMap: set complete" },
    );

    console.info(`[CompleteWorkbookMap] workbook ${workbookId}: ${cellCount} cells, marked complete`);
    return {
      completed: true,
      oldWorkbookDeleted: (deleteResult as any)?.rowCount > 0,
      cellCount,
    };
  },
});
