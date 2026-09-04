import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
var CountRow = z.object({ cnt: z.coerce.number() });
var DeletedCountRow = z.object({ deleted: z.coerce.number() });

export default api({
  name: "SriPurgeDealState",
  description: "Purge all SRI pipeline state for a deal (cascade deletes children)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    dealId: z.string(),
    before: z.object({
      runs: z.number(),
      entities: z.number(),
      claims: z.number(),
      research_plan: z.number(),
      evidence: z.number(),
      findings: z.number(),
    }),
    deletedRuns: z.number(),
    after: z.object({
      runs: z.number(),
      entities: z.number(),
      claims: z.number(),
      research_plan: z.number(),
      evidence: z.number(),
      findings: z.number(),
    }),
  }),

  async run(ctx, { dealId }) {
    var db = ctx.integrations.db;

    async function countAll(label: string) {
      var runIds = await db.query(
        "SELECT run_id FROM sri_pipeline_state WHERE deal_id = $1",
        z.object({ run_id: z.string() }),
        [dealId],
        { label: label + ": get run_ids" },
      );
      var ids = runIds.map(function (r) { return r.run_id; });

      var runs = runIds.length;
      var entities = 0;
      var claims = 0;
      var research_plan = 0;
      var evidence = 0;
      var findings = 0;

      if (ids.length > 0) {
        var eRows = await db.query("SELECT count(*)::int AS cnt FROM sri_entities WHERE run_id = ANY($1::uuid[])", CountRow, [ids], { label: label + ": entities" });
        entities = eRows[0]?.cnt ?? 0;

        var cRows = await db.query("SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = ANY($1::uuid[])", CountRow, [ids], { label: label + ": claims" });
        claims = cRows[0]?.cnt ?? 0;

        var rpRows = await db.query("SELECT count(*)::int AS cnt FROM sri_research_plan WHERE run_id = ANY($1::uuid[])", CountRow, [ids], { label: label + ": research_plan" });
        research_plan = rpRows[0]?.cnt ?? 0;

        var evRows = await db.query("SELECT count(*)::int AS cnt FROM sri_evidence WHERE plan_id IN (SELECT plan_id FROM sri_research_plan WHERE run_id = ANY($1::uuid[]))", CountRow, [ids], { label: label + ": evidence" });
        evidence = evRows[0]?.cnt ?? 0;

        var fRows = await db.query("SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = ANY($1::uuid[])", CountRow, [ids], { label: label + ": findings" });
        findings = fRows[0]?.cnt ?? 0;
      }

      return { runs: runs, entities: entities, claims: claims, research_plan: research_plan, evidence: evidence, findings: findings };
    }

    var before = await countAll("Before purge");

    if (before.runs === 0) {
      return { dealId: dealId, before: before, deletedRuns: 0, after: before };
    }

    // The ONLY table named in any DELETE is sri_pipeline_state. Cascade handles children.
    var deleteResult = await db.query(
      "WITH deleted AS (DELETE FROM sri_pipeline_state WHERE deal_id = $1 RETURNING run_id) SELECT count(*)::int AS deleted FROM deleted",
      DeletedCountRow,
      [dealId],
      { label: "Purge: DELETE sri_pipeline_state for deal" },
    );

    var after = await countAll("After purge");

    return {
      dealId: dealId,
      before: before,
      deletedRuns: deleteResult[0]?.deleted ?? 0,
      after: after,
    };
  },
});
