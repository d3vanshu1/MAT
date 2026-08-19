import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { runPipelineCore } from "./pipeline-core.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

/**
 * Diagnostic API: directly resumes the CC diagnostic run through runPipelineCore.
 * Used when RunModulePipeline has a stale integration connection issue.
 */
export default api({
  name: "DiagResumeCcRun",
  description: "Directly resumes the CC diagnostic run bc6b519f via runPipelineCore",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    dealId: z.string(),
  }),

  output: z.object({
    status: z.string(),
    phase: z.string(),
    runId: z.string(),
    progress: z.any(),
    result: z.any().nullable(),
    firstError: z.string().nullable().optional(),
  }),

  async run(ctx, { runId, dealId }) {
    const result = await runPipelineCore(ctx, {
      dealId,
      moduleId: "contradiction_check",
      runId,
      useOpus: false,
      subjectDocumentIds: ["3bdc4854-71e5-4c7b-8b3a-f68da47a7649"],
      numericReport: null,
      numericPartial: null,
      diagnosticOnly: true,
    });

    return {
      status: result.status,
      phase: result.phase,
      runId: result.runId,
      progress: result.progress,
      result: result.result ?? null,
      firstError: result.firstError ?? null,
    };
  },
});
