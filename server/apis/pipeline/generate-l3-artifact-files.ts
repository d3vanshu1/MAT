/**
 * GenerateL3ArtifactFiles
 *
 * Reads the 273-finding L3 export checkpoint (tree_level=98) and computes
 * metadata + completeness checks for the three artifact files.
 * Does NOT store the content — use ReadArtifactChunk to retrieve content slices.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ExportCheckpointSchema = z.object({
  id: z.string(),
  merged_json: z.any(),
});

export default api({
  name: "GenerateL3ArtifactFiles",
  description: "Validates L3 export checkpoint and returns completeness metadata.",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    export_checkpoint_id: z.string(),
    total_findings: z.number(),
    completeness: z.object({
      expected: z.number(),
      exported: z.number(),
      unique_ids: z.number(),
      duplicate_ids: z.number(),
      by_node: z.record(z.number()),
      by_severity: z.record(z.number()),
      by_kind: z.record(z.number()),
      missing_title: z.number(),
      missing_issue_key: z.number(),
      missing_evidence: z.number(),
      missing_source_docs: z.number(),
    }),
  }),

  async run(ctx, { runId }) {
    const rows = await ctx.integrations.ic_diligence_db.query(
      `SELECT id, merged_json FROM merge_checkpoints
       WHERE module_run_id = $1 AND tree_level = 98 AND node_index = 0
       LIMIT 1`,
      ExportCheckpointSchema,
      [runId],
      { label: "Load L3 export checkpoint (tree_level=98)" }
    );

    if (rows.length === 0) {
      throw new Error(`No L3 export checkpoint found for run ${runId}. Run ConsolidateL3Export first.`);
    }

    const payload = typeof rows[0].merged_json === "string"
      ? JSON.parse(rows[0].merged_json)
      : rows[0].merged_json;

    const findings: any[] = payload.findings ?? [];

    // Completeness checks
    const allIds: string[] = [];
    const byNode: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let missingTitle = 0, missingIssueKey = 0, missingEvidence = 0, missingSourceDocs = 0;

    for (const f of findings) {
      if (f.finding_id) allIds.push(f.finding_id);
      const nodeKey = `L3:N${f._l3_node_index}`;
      byNode[nodeKey] = (byNode[nodeKey] ?? 0) + 1;
      bySeverity[f.severity ?? "null"] = (bySeverity[f.severity ?? "null"] ?? 0) + 1;
      byKind[f.finding_kind ?? "null"] = (byKind[f.finding_kind ?? "null"] ?? 0) + 1;
      if (!f.title) missingTitle++;
      if (!f.issue_key) missingIssueKey++;
      if (!f.evidence && !f.full_analysis) missingEvidence++;
      if (!f.source_docs || (Array.isArray(f.source_docs) && f.source_docs.length === 0)) missingSourceDocs++;
    }

    const uniqueSet = new Set(allIds);

    return {
      export_checkpoint_id: rows[0].id,
      total_findings: findings.length,
      completeness: {
        expected: 273,
        exported: findings.length,
        unique_ids: uniqueSet.size,
        duplicate_ids: allIds.length - uniqueSet.size,
        by_node: byNode,
        by_severity: bySeverity,
        by_kind: byKind,
        missing_title: missingTitle,
        missing_issue_key: missingIssueKey,
        missing_evidence: missingEvidence,
        missing_source_docs: missingSourceDocs,
      },
    };
  },
});
