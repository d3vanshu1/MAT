/**
 * One-shot helper: generate dimension rationales and persist them to
 * the verdicts detail JSONB on dcs_pipeline_state.
 *
 * This is a manual invocation helper — not part of the normal pipeline flow.
 * It calls DcsComputeDimensionRationales, validates the output, and writes
 * the full rationale array + metadata into the verdicts detail.
 *
 * After running this, DcsRenderReport will detect rationales_done=true
 * and produce the v2 IC-facing report.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import DcsComputeDimensionRationales from "./dcs-compute-dimension-rationales.js";
import { sha256hex } from "./sha256-pure.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

export default api({
  name: "DcsPersistRationalesOneshot",
  description: "Generates and persists dimension rationales for a completed DCS run",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string().uuid(),
    runId: z.string().uuid(),
  }),

  output: z.object({
    success: z.boolean(),
    rationaleCount: z.number(),
    rationaleHash: z.string(),
    message: z.string(),
  }),

  async run(ctx, { dealId, runId }) {
    const db = ctx.integrations.ic_diligence_db;

    // 1. Generate rationales
    console.log(`[ONESHOT] Computing rationales for run=${runId} deal=${dealId}`);
    const result = await DcsComputeDimensionRationales.run(ctx, {
      dealId,
      runId,
      mode: "live" as const,
      concurrency: 3,
      debug: false,
    });

    const rationales = result.rationales as unknown[];
    if (!Array.isArray(rationales) || rationales.length !== 10) {
      throw new Error(`Expected 10 rationales, got ${Array.isArray(rationales) ? rationales.length : "non-array"}`);
    }

    // 2. Validate
    for (const r of rationales as Array<{ dimensionId: string; validation?: { allChecksPassed?: boolean }; degraded?: boolean }>) {
      if (r.degraded) throw new Error(`Rationale ${r.dimensionId} degraded`);
      if (r.validation && !r.validation.allChecksPassed) throw new Error(`Rationale ${r.dimensionId} failed validation`);
    }

    // 3. Canonicalize and hash
    const canonicalJson = JSON.stringify(rationales, Object.keys(rationales[0] as Record<string, unknown>).sort());
    const rationaleHash = `sha256-rationale:${sha256hex(canonicalJson)}`;
    const generatedAt = new Date().toISOString();

    // 4. Read current detail
    const rows = await db.query(
      `SELECT detail FROM dcs_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'verdicts' LIMIT 1`,
      z.object({ detail: z.string().nullable() }),
      [runId],
      { label: "Oneshot: read current verdicts detail" },
    );

    const existing = rows[0]?.detail ? JSON.parse(rows[0].detail) : {};

    // 5. Merge and persist
    const updated = {
      ...existing,
      rationales_done: true,
      rationale_schema_version: 1,
      dimension_rationales: rationales,
      rationale_hash: rationaleHash,
      rationale_generated_at: generatedAt,
    };

    await db.execute(
      `UPDATE dcs_pipeline_state
       SET detail = $2, updated_at = now()
       WHERE run_id = $1::uuid AND stage = 'verdicts'`,
      [runId, JSON.stringify(updated)],
      { label: "Oneshot: persist rationales to verdicts detail" },
    );

    console.log(`[ONESHOT] Persisted ${rationales.length} rationales, hash=${rationaleHash}`);

    return {
      success: true,
      rationaleCount: rationales.length,
      rationaleHash,
      message: `Persisted ${rationales.length} rationales. DcsRenderReport will now produce v2 report.`,
    };
  },
});
