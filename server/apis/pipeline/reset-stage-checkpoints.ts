import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

/**
 * ResetStageCheckpoints — Delete specific stage checkpoints and/or findings by unit_key/topic_id.
 * Utility for selectively re-running pipeline stages for specific topics.
 */
export default api({
  name: "ResetStageCheckpoints",
  description: "Deletes specific stage checkpoints and optionally findings for selected topics",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    runId: z.string(),
    stage: z.string(),
    unitKeys: z.array(z.string()).min(1).max(20),
    alsoDeleteFindings: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  }),
  output: z.object({
    found: z.number(),
    deleted: z.number(),
    unitKeysFound: z.array(z.string()),
    findingsDeleted: z.number(),
    dryRun: z.boolean(),
  }),
  async run(ctx, { runId, stage, unitKeys, alsoDeleteFindings, dryRun }) {
    // Check which unit_keys currently exist
    const placeholders = unitKeys.map((_, i) => `$${i + 3}`).join(", ");
    const existing = await ctx.integrations.db.query(
      `SELECT unit_key FROM oa_stage_checkpoints
       WHERE run_id = $1::uuid AND stage = $2 AND unit_key IN (${placeholders})`,
      z.object({ unit_key: z.string() }),
      [runId, stage, ...unitKeys],
      { label: "Find existing checkpoints" }
    );

    const found = existing.length;
    const unitKeysFound = existing.map(r => r.unit_key);
    let deleted = 0;
    let findingsDeleted = 0;

    if (!dryRun && found > 0) {
      await ctx.integrations.db.execute(
        `DELETE FROM oa_stage_checkpoints
         WHERE run_id = $1::uuid AND stage = $2 AND unit_key IN (${placeholders})`,
        [runId, stage, ...unitKeys],
        { label: `Delete ${found} checkpoints` }
      );
      deleted = found;
    }

    // Optionally delete findings for those topic_ids
    if (alsoDeleteFindings && !dryRun) {
      const findPlaceholders = unitKeys.map((_, i) => `$${i + 2}`).join(", ");
      const findingsExisting = await ctx.integrations.db.query(
        `SELECT finding_id FROM oa_findings
         WHERE run_id = $1::uuid AND topic_id IN (${findPlaceholders})`,
        z.object({ finding_id: z.string() }),
        [runId, ...unitKeys],
        { label: "Find existing findings for topics" }
      );
      if (findingsExisting.length > 0) {
        await ctx.integrations.db.execute(
          `DELETE FROM oa_findings
           WHERE run_id = $1::uuid AND topic_id IN (${findPlaceholders})`,
          [runId, ...unitKeys],
          { label: `Delete ${findingsExisting.length} findings` }
        );
        findingsDeleted = findingsExisting.length;
      }
    } else if (alsoDeleteFindings && dryRun) {
      const findPlaceholders = unitKeys.map((_, i) => `$${i + 2}`).join(", ");
      const findingsExisting = await ctx.integrations.db.query(
        `SELECT finding_id FROM oa_findings
         WHERE run_id = $1::uuid AND topic_id IN (${findPlaceholders})`,
        z.object({ finding_id: z.string() }),
        [runId, ...unitKeys],
        { label: "Count existing findings for topics (dry run)" }
      );
      findingsDeleted = findingsExisting.length;
    }

    return { found, deleted, unitKeysFound, findingsDeleted, dryRun };
  },
});
