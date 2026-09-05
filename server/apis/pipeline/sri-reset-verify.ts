/**
 * sri-reset-verify.ts
 *
 * Targeted reset of verify_claims output only.
 * Deletes sri_evidence and sri_findings for the run,
 * removes the verify_claims marker, resets the cursor.
 * Never touches sri_claims, sri_stage_diagnostics, or any pipeline_state row.
 */

import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "SriResetVerify",
  description: "Targeted reset of verify_claims evidence and findings only",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    dealId: z.string(),
    runId: z.string(),
    before: z.object({
      claims: z.number(),
      evidence: z.number(),
      findings: z.number(),
    }),
    after: z.object({
      claims: z.number(),
      evidence: z.number(),
      findings: z.number(),
    }),
  }),

  async run(ctx, { dealId }) {
    var db = ctx.integrations.db;

    // Find the run
    var runRows = await db.query(
      "SELECT run_id FROM sri_pipeline_state WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1",
      z.object({ run_id: z.string() }),
      [dealId],
      { label: "SriResetVerify: find run" },
    );
    if (runRows.length === 0) {
      throw new Error("No SRI run found for deal " + dealId);
    }
    var runId = runRows[0].run_id;

    // Count before
    var claimsBefore = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: claims before" },
    );
    var evidenceBefore = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_evidence WHERE claim_id IN (SELECT claim_id FROM sri_claims WHERE run_id = $1) LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: evidence before" },
    );
    var findingsBefore = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: findings before" },
    );

    // Delete evidence for this run's claims
    await db.execute(
      "DELETE FROM sri_evidence WHERE claim_id IN (SELECT claim_id FROM sri_claims WHERE run_id = $1)",
      [runId],
      { label: "SriResetVerify: delete evidence" },
    );

    // Delete findings for this run
    await db.execute(
      "DELETE FROM sri_findings WHERE run_id = $1",
      [runId],
      { label: "SriResetVerify: delete findings" },
    );

    // Remove verify_claims from stages_completed and reset cursor
    await db.execute(
      "UPDATE sri_pipeline_state SET stages_completed = array_remove(stages_completed, 'verify_claims'), verify_claim_cursor = 0, current_stage = 'verify_claims', stage_status = 'pending' WHERE run_id = $1",
      [runId],
      { label: "SriResetVerify: reset marker and cursor" },
    );

    // Count after
    var claimsAfter = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_claims WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: claims after" },
    );
    var evidenceAfter = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_evidence WHERE claim_id IN (SELECT claim_id FROM sri_claims WHERE run_id = $1) LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: evidence after" },
    );
    var findingsAfter = await db.query(
      "SELECT count(*)::int AS cnt FROM sri_findings WHERE run_id = $1 LIMIT 1",
      z.object({ cnt: z.coerce.number() }), [runId],
      { label: "SriResetVerify: findings after" },
    );

    return {
      dealId: dealId,
      runId: runId,
      before: {
        claims: claimsBefore.length > 0 ? claimsBefore[0].cnt : 0,
        evidence: evidenceBefore.length > 0 ? evidenceBefore[0].cnt : 0,
        findings: findingsBefore.length > 0 ? findingsBefore[0].cnt : 0,
      },
      after: {
        claims: claimsAfter.length > 0 ? claimsAfter[0].cnt : 0,
        evidence: evidenceAfter.length > 0 ? evidenceAfter[0].cnt : 0,
        findings: findingsAfter.length > 0 ? findingsAfter[0].cnt : 0,
      },
    };
  },
});
