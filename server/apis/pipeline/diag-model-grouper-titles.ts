/**
 * Tiny companion to DiagModelGrouper — returns all finding titles in ref order
 * so we can cross-reference grouped vs ungrouped without re-running the model.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

export default api({
  name: "DiagModelGrouperTitles",
  description: "Returns all OA finding titles in ref order for grouper analysis",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable(),
    groupedRefs: z.array(z.string()).nullable().describe("Refs that were grouped; returns only the complement (ungrouped) if provided"),
  }),

  output: z.object({
    runId: z.string(),
    totalFindings: z.number(),
    titles: z.array(z.object({
      ref: z.string(),
      title: z.string(),
    })),
  }),

  async run(ctx, { runId: inputRunId, groupedRefs }) {
    let resolvedRunId: string;
    if (inputRunId) {
      resolvedRunId = inputRunId;
    } else {
      const AutoSelectRow = z.object({ id: z.string() });
      const autoRows = await ctx.integrations.db.query(
        `SELECT mr.id
         FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        AutoSelectRow,
        [SCG_DEAL_ID],
        { label: "Auto-select largest OA run" }
      );
      if (autoRows.length === 0) throw new Error("No completed OA runs found");
      resolvedRunId = autoRows[0].id;
    }

    const FindingRow = z.object({ findings: z.any() });
    const rows = await ctx.integrations.db.query(
      `SELECT mo.findings FROM module_outputs mo WHERE mo.module_run_id = $1 LIMIT 1`,
      FindingRow,
      [resolvedRunId],
      { label: "Load findings for title extraction" }
    );
    if (rows.length === 0) throw new Error("No module_outputs found");

    const rawFindings: any[] = rows[0].findings;
    const allTitles = rawFindings.map((f: any, idx: number) => ({
      ref: `f${String(idx + 1).padStart(3, "0")}`,
      title: (f.title || "").slice(0, 200),
    }));

    const groupedSet = groupedRefs ? new Set(groupedRefs) : null;
    const filtered = groupedSet
      ? allTitles.filter((t) => !groupedSet.has(t.ref))
      : allTitles;

    return {
      runId: resolvedRunId,
      totalFindings: rawFindings.length,
      titles: filtered.slice(0, 60), // return first 60 for review
    };
  },
});
