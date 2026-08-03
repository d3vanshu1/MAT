import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";
import { upsertModuleOutput } from "./upsert-module-output.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const SavedRunSchema = z.object({
  run_id: z.string(),
  output_id: z.string(),
});

export default api({
  name: "SaveModuleResult",
  description: "Saves module output, attaching to existing run when runId is provided",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    moduleId: z.string(),
    executiveHeader: z.string(),
    // RC2: Full canonical finding schema — no reduced subsets.
    // All finding fields (finding_id, structured_impact, verification, etc.) preserved.
    findings: z.array(CanonicalFindingSchema),
    fullReport: z.string(),
    documentsIncluded: z.array(z.string()).nullable().optional(),
    // When provided, attaches output to this existing run instead of creating a new one.
    // Used by the server-pipeline path where pipeline-core.ts already manages the module_runs row.
    runId: z.string().nullable().optional(),
  }),

  output: z.object({
    result: SavedRunSchema,
  }),

  async run(ctx, { dealId, moduleId, executiveHeader, findings, fullReport, documentsIncluded, runId }) {
    let effectiveRunId: string;

    if (runId) {
      // Server-pipeline path: run already exists and is managed by pipeline-core.
      effectiveRunId = runId;

      // MAT-F06 §D: Guard against duplicate client write.
      // If the canonical finalizer already wrote module_outputs with a semantic_hash,
      // the client call is a late-arriving duplicate — skip upsertModuleOutput entirely.
      // Wrapped in try-catch: if semantic_hash column doesn't exist yet (pre-migration),
      // gracefully fall through to the legacy path.
      let guardTriggered = false;
      try {
        const ExistingOutputSchema = z.object({
          id: z.string(),
          semantic_hash: z.string().nullable(),
        });
        const RunStatusSchema = z.object({ status: z.string() });

        const [runStatusRows, existingOutputRows] = await Promise.all([
          ctx.integrations.db.query(
            `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
            RunStatusSchema,
            [effectiveRunId],
            { label: "SaveModuleResult: check run status" }
          ),
          ctx.integrations.db.query(
            `SELECT id, semantic_hash FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
            ExistingOutputSchema,
            [effectiveRunId],
            { label: "SaveModuleResult: check existing output" }
          ),
        ]);

        if (
          runStatusRows[0]?.status === "completed" &&
          existingOutputRows[0]?.semantic_hash
        ) {
          // Run already canonically finalized — skip duplicate write, just update docs if needed
          console.log(
            `[SaveModuleResult] Run ${effectiveRunId} already canonically finalized (hash=${existingOutputRows[0].semantic_hash.slice(0, 8)}…) — skipping duplicate write`
          );
          if (documentsIncluded && documentsIncluded.length > 0) {
            await ctx.integrations.db.execute(
              `UPDATE module_runs SET documents_included = $2::text[] WHERE id = $1`,
              [effectiveRunId, documentsIncluded],
              { label: "Update documents_included (canonical guard)" }
            );
          }
          return { result: { run_id: effectiveRunId, output_id: existingOutputRows[0].id } };
        }
      } catch (guardErr: any) {
        // Pre-migration: semantic_hash column may not exist yet — fall through to legacy path
        console.warn(
          `[SaveModuleResult] F06 guard check failed (pre-migration?): ${guardErr?.message ?? guardErr}`
        );
      }

      // Not canonically finalized (or guard unavailable) — allow legacy upsert to proceed below.
      if (!guardTriggered && documentsIncluded && documentsIncluded.length > 0) {
        await ctx.integrations.db.execute(
          `UPDATE module_runs SET documents_included = $2::text[] WHERE id = $1`,
          [effectiveRunId, documentsIncluded],
          { label: "Update documents_included on existing run" }
        );
      }
    } else {
      // Legacy client-only path (non-pipeline): create a new completed run.
      const runRows = await ctx.integrations.db.query(
        `INSERT INTO module_runs (deal_id, module_id, status, completed_at, documents_included)
         VALUES ($1, $2, 'completed', now(), $3::text[])
         RETURNING id AS run_id`,
        z.object({ run_id: z.string() }),
        [dealId, moduleId, documentsIncluded ?? []],
        { label: "Insert module run (legacy path)" }
      );
      effectiveRunId = runRows[0].run_id;
    }

    // Upsert output via shared helper (validates via canonical parser, rejects malformed)
    const { outputId } = await upsertModuleOutput(ctx.integrations.db, {
      runId: effectiveRunId,
      dealId,
      executiveHeader,
      findings,
      fullReport,
    });

    return { result: { run_id: effectiveRunId, output_id: outputId } };
  },
});
