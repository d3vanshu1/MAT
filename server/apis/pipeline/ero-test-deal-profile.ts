/**
 * ERO v2 — Test harness: Deal Profile (Packet 2.2)
 *
 * Creates a fresh ERO run via the real orchestrator, then calls
 * buildDealProfile directly. Returns FULL profile rows from the DB,
 * the dropped list, and independent re-verification of every snippet.
 *
 * Does NOT delete the run — report the runId for inspection with EroDiagState.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import EroRunPipeline from "./ero-run-pipeline.js";
import {
  buildDealProfile,
  ProfileRow,
  type DroppedProfileField,
} from "./ero-deal-profile.js";
import { matchSnippet } from "./bss-snippet-match.js";

// ── Integration IDs ─────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Schemas ─────────────────────────────────────────────────────────
const ChunkContentRow = z.object({
  content: z.string(),
});

export default api({
  name: "EroTestDealProfile",
  description: "Test harness for ERO deal profile stage against a live deal",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    dealId: z.string(),
  }),

  output: z.object({
    runId: z.string(),
    stageResult: z.any(),
    profile: z.array(z.any()),
    dropped: z.array(z.any()),
    checks: z.object({
      totalFields: z.number(),
      byFieldGroup: z.record(z.number()),
      allHaveSnippet: z.boolean(),
      allSnippetsVerified: z.boolean(),
      verificationFailures: z.array(z.any()),
    }),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── 1. Create fresh ERO run via orchestrator ────────────────────
    const createResult = await EroRunPipeline.run(ctx, {
      dealId,
      runId: null,
    });
    const runId = createResult.runId;

    // ── 2. Call buildDealProfile directly ────────────────────────────
    const stageResult = await buildDealProfile(ctx, runId, dealId);

    // ── 3. Read profile from the ero_profile TABLE ──────────────────
    const profile = await db.query(
      `SELECT profile_id, run_id, field_group, field_name,
              field_value, source_document_id, verbatim_snippet, created_at
         FROM ero_profile
        WHERE run_id = $1
        ORDER BY field_group, field_name`,
      ProfileRow,
      [runId],
      { label: "TestDealProfile: read all profile fields" },
    );

    // ── 4. Read dropped list from stage result ──────────────────────
    const dropped: DroppedProfileField[] =
      (stageResult as any)?.dropped ?? [];

    // ── 5. Independent re-verification ──────────────────────────────
    // For every inserted profile field, independently confirm the
    // verbatim_snippet is a substring of the cited source document's chunks.
    const verificationFailures: Array<{
      profile_id: string;
      field_group: string;
      field_name: string;
      source_document_id: string;
      reason: string;
    }> = [];

    for (const row of profile) {
      // Fetch chunk texts for the cited document
      const chunks = await db.query(
        `SELECT content FROM document_chunks
          WHERE document_id = $1::uuid AND deal_id = $2::uuid
          ORDER BY chunk_index
          LIMIT 200`,
        ChunkContentRow,
        [row.source_document_id, dealId],
        { label: `TestDealProfile: verify ${row.field_name}` },
      );

      if (chunks.length === 0) {
        verificationFailures.push({
          profile_id: row.profile_id,
          field_group: row.field_group,
          field_name: row.field_name,
          source_document_id: row.source_document_id,
          reason: "no chunks found for cited document",
        });
        continue;
      }

      let matched = false;
      for (const chunk of chunks) {
        const result = matchSnippet(chunk.content, row.verbatim_snippet);
        if (result.matched) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        verificationFailures.push({
          profile_id: row.profile_id,
          field_group: row.field_group,
          field_name: row.field_name,
          source_document_id: row.source_document_id,
          reason:
            "snippet not found in any chunk of cited document (re-verification)",
        });
      }
    }

    // ── 6. Compute checks ───────────────────────────────────────────
    const byFieldGroup: Record<string, number> = {};
    let allHaveSnippet = true;
    for (const row of profile) {
      byFieldGroup[row.field_group] =
        (byFieldGroup[row.field_group] || 0) + 1;
      if (!row.verbatim_snippet || row.verbatim_snippet.trim().length === 0) {
        allHaveSnippet = false;
      }
    }

    return {
      runId,
      stageResult,
      profile,
      dropped,
      checks: {
        totalFields: profile.length,
        byFieldGroup,
        allHaveSnippet,
        allSnippetsVerified: verificationFailures.length === 0,
        verificationFailures,
      },
    };
  },
});
