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
      // Server-pipeline path: run already exists and is marked completed by pipeline-core.
      // Just update documents_included if provided (pipeline-core doesn't set this).
      effectiveRunId = runId;
      if (documentsIncluded && documentsIncluded.length > 0) {
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
