/**
 * ERO v2 — Test harness: Entity Manifest (Packet 2.1)
 *
 * Creates a fresh ERO run via the real orchestrator, then calls
 * buildEntityManifest directly. Returns FULL entity rows from the DB,
 * the dropped list, and independent re-verification of every snippet.
 *
 * Does NOT delete the run — report the runId for inspection with EroDiagState.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import EroRunPipeline from "./ero-run-pipeline.js";
import { buildEntityManifest, EntityRow, type DroppedEntity } from "./ero-entity-manifest.js";
import { matchSnippet } from "./bss-snippet-match.js";

// ── Integration IDs ─────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Schemas ─────────────────────────────────────────────────────────
const ChunkContentRow = z.object({
  content: z.string(),
});

export default api({
  name: "EroTestEntityManifest",
  description: "Test harness for ERO entity manifest stage against a live deal",

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
    entities: z.array(z.any()),
    dropped: z.array(z.any()),
    checks: z.object({
      totalEntities: z.number(),
      byEntityType: z.record(z.number()),
      allHaveSnippet: z.boolean(),
      allSnippetsVerified: z.boolean(),
      verificationFailures: z.array(z.any()),
    }),
  }),

  async run(ctx, { dealId }) {
    const db = ctx.integrations.ic_diligence_db;

    // ── 1. Create fresh ERO run via orchestrator ────────────────────
    const createResult = await EroRunPipeline.run(ctx, { dealId, runId: null });
    const runId = createResult.runId;

    // ── 2. Call buildEntityManifest directly ─────────────────────────
    // The handler accesses ctx.integrations.ic_diligence_db and ctx.integrations.claude
    const stageResult = await buildEntityManifest(ctx, runId, dealId);

    // ── 3. Read entities from the ero_entities TABLE ────────────────
    const entities = await db.query(
      `SELECT entity_id, run_id, entity_type, legal_name,
              registration_number, jurisdiction, role,
              source_document_id, verbatim_snippet, rank_signal, created_at
         FROM ero_entities
        WHERE run_id = $1
        ORDER BY entity_type, legal_name`,
      EntityRow,
      [runId],
      { label: "TestEntityManifest: read all entities" },
    );

    // ── 4. Read dropped list from stage result ──────────────────────
    // buildEntityManifest now returns dropped[] in its result.
    const dropped: DroppedEntity[] = stageResult?.dropped ?? [];

    // ── 5. Independent re-verification (belt & suspenders) ──────────
    // For every inserted entity, independently confirm the snippet is
    // a substring of the cited source document's chunks.
    const verificationFailures: Array<{
      entity_id: string;
      legal_name: string;
      source_document_id: string;
      reason: string;
    }> = [];

    for (const entity of entities) {
      // Fetch chunk texts for the cited document
      const chunks = await db.query(
        `SELECT content FROM document_chunks
          WHERE document_id = $1::uuid AND deal_id = $2::uuid
          ORDER BY chunk_index
          LIMIT 200`,
        ChunkContentRow,
        [entity.source_document_id, dealId],
        { label: `TestEntityManifest: verify ${entity.legal_name}` },
      );

      if (chunks.length === 0) {
        verificationFailures.push({
          entity_id: entity.entity_id,
          legal_name: entity.legal_name,
          source_document_id: entity.source_document_id,
          reason: "no chunks found for cited document",
        });
        continue;
      }

      let matched = false;
      for (const chunk of chunks) {
        const result = matchSnippet(chunk.content, entity.verbatim_snippet);
        if (result.matched) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        verificationFailures.push({
          entity_id: entity.entity_id,
          legal_name: entity.legal_name,
          source_document_id: entity.source_document_id,
          reason: "snippet not found in any chunk of cited document (re-verification)",
        });
      }
    }

    // ── 6. Compute checks ───────────────────────────────────────────
    const byEntityType: Record<string, number> = {};
    let allHaveSnippet = true;
    for (const e of entities) {
      byEntityType[e.entity_type] = (byEntityType[e.entity_type] || 0) + 1;
      if (!e.verbatim_snippet || e.verbatim_snippet.trim().length === 0) {
        allHaveSnippet = false;
      }
    }

    return {
      runId,
      stageResult,
      entities,
      dropped,
      checks: {
        totalEntities: entities.length,
        byEntityType,
        allHaveSnippet,
        allSnippetsVerified: verificationFailures.length === 0,
        verificationFailures,
      },
    };
  },
});
