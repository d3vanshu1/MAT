/**
 * ERO v2 — Phase 2 Acceptance Export (Packet 2.3)
 *
 * Read-only, paginated export of the full entity manifest and deal
 * profile for a given run. Every row includes source_file_name
 * resolved via a JOIN to the documents table. Full snippets are
 * returned un-truncated — the whole point is verifying snippets
 * against the named source PDF.
 *
 * Deal-general: no hardcoded names, no expected-value checks.
 * Pointing it at a different deal is just a different deal_id.
 *
 * Writes nothing. Runs no LLM.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Transport safety ────────────────────────────────────────────────
// Full snippets make each row ~400-800 chars. 20 rows × 800 = ~16K,
// well under the ~28-30K response ceiling.
const PAGE_SIZE = 20;

// ── Zod schemas ─────────────────────────────────────────────────────
const CountRow = z.object({ cnt: z.coerce.number() });

const EntityExportRow = z.object({
  entity_id: z.string(),
  run_id: z.string(),
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  role: z.string().nullable(),
  source_document_id: z.string(),
  source_file_name: z.string().nullable(),
  verbatim_snippet: z.string(),
  rank_signal: z.any().nullable(),
  created_at: z.string(),
});

const ProfileExportRow = z.object({
  profile_id: z.string(),
  run_id: z.string(),
  field_group: z.string(),
  field_name: z.string(),
  field_value: z.string(),
  source_document_id: z.string(),
  source_file_name: z.string().nullable(),
  verbatim_snippet: z.string(),
  created_at: z.string(),
});

const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
  invocation_count: z.coerce.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const GroupCountRow = z.object({
  grp: z.string(),
  cnt: z.coerce.number(),
});

export default api({
  name: "EroDiagPhase2Export",
  description: "Read-only paginated export of ERO Phase 2 entities and profile",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable().optional(),
    dealId: z.string().nullable().optional(),
    section: z
      .enum(["entities", "profile", "header"])
      .nullable()
      .optional(),
    offset: z.coerce.number().nullable().optional(),
    limit: z.coerce.number().nullable().optional(),
  }),

  output: z.object({
    header: z.any().nullable(),
    section: z.string(),
    rows: z.array(z.any()),
    nextOffset: z.number().nullable(),
  }),

  async run(ctx, { runId, dealId, section, offset, limit }) {
    const db = ctx.integrations.ic_diligence_db;

    if (!runId && !dealId) {
      throw new Error(
        "At least one of runId or dealId is required. Pass runId for a specific run, or dealId to resolve the most recent run.",
      );
    }

    // ── 1. Resolve target run ───────────────────────────────────────
    let resolvedRunId: string;

    if (runId) {
      resolvedRunId = runId;
    } else {
      const latestRows = await db.query(
        `SELECT run_id FROM ero_pipeline_state
         WHERE deal_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        z.object({ run_id: z.string() }),
        [dealId],
        { label: "Phase2Export: resolve latest run for deal" },
      );
      if (latestRows.length === 0) {
        throw new Error(`No ERO runs found for deal ${dealId}.`);
      }
      resolvedRunId = latestRows[0].run_id;
    }

    // ── 2. Always build the header (lightweight) ────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id, current_stage, stage_status,
              invocation_count, created_at::text, updated_at::text
         FROM ero_pipeline_state
        WHERE run_id = $1`,
      PipelineStateRow,
      [resolvedRunId],
      { label: "Phase2Export: load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(`ERO run not found: ${resolvedRunId}.`);
    }

    const runState = stateRows[0];

    // Entity count by type
    const entityCounts = await db.query(
      `SELECT entity_type AS grp, COUNT(*)::int AS cnt
         FROM ero_entities
        WHERE run_id = $1
        GROUP BY entity_type
        ORDER BY entity_type`,
      GroupCountRow,
      [resolvedRunId],
      { label: "Phase2Export: entity counts by type" },
    );

    // Profile count by field_group
    const profileCounts = await db.query(
      `SELECT field_group AS grp, COUNT(*)::int AS cnt
         FROM ero_profile
        WHERE run_id = $1
        GROUP BY field_group
        ORDER BY field_group`,
      GroupCountRow,
      [resolvedRunId],
      { label: "Phase2Export: profile counts by group" },
    );

    const entityTotal = entityCounts.reduce((s, r) => s + r.cnt, 0);
    const profileTotal = profileCounts.reduce((s, r) => s + r.cnt, 0);

    const header = {
      runId: resolvedRunId,
      dealId: runState.deal_id,
      currentStage: runState.current_stage,
      stageStatus: runState.stage_status,
      invocationCount: runState.invocation_count,
      createdAt: runState.created_at,
      updatedAt: runState.updated_at,
      entityCount: entityTotal,
      entityCountByType: Object.fromEntries(
        entityCounts.map((r) => [r.grp, r.cnt]),
      ),
      profileCount: profileTotal,
      profileCountByGroup: Object.fromEntries(
        profileCounts.map((r) => [r.grp, r.cnt]),
      ),
    };

    // ── 3. Determine which section to return ────────────────────────
    const resolvedSection = section ?? "header";
    const pageSize = limit && limit > 0 ? Math.min(limit, PAGE_SIZE) : PAGE_SIZE;
    const pageOffset = offset && offset > 0 ? offset : 0;

    // header-only: return header with empty rows
    if (resolvedSection === "header") {
      return {
        header,
        section: "header",
        rows: [],
        nextOffset: null,
      };
    }

    // ── 4. Entities section ─────────────────────────────────────────
    if (resolvedSection === "entities") {
      const rows = await db.query(
        `SELECT e.entity_id, e.run_id, e.entity_type, e.legal_name,
                e.registration_number, e.jurisdiction, e.role,
                e.source_document_id,
                d.file_name AS source_file_name,
                e.verbatim_snippet, e.rank_signal,
                e.created_at::text AS created_at
           FROM ero_entities e
           LEFT JOIN documents d ON d.id = e.source_document_id
          WHERE e.run_id = $1
          ORDER BY e.entity_type, e.legal_name
         OFFSET $2
          LIMIT $3`,
        EntityExportRow,
        [resolvedRunId, pageOffset, pageSize + 1], // fetch one extra to detect more
        { label: `Phase2Export: entities page offset=${pageOffset}` },
      );

      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      return {
        header,
        section: "entities",
        rows: pageRows,
        nextOffset: hasMore ? pageOffset + pageSize : null,
      };
    }

    // ── 5. Profile section ──────────────────────────────────────────
    if (resolvedSection === "profile") {
      const rows = await db.query(
        `SELECT p.profile_id, p.run_id, p.field_group, p.field_name,
                p.field_value,
                p.source_document_id,
                d.file_name AS source_file_name,
                p.verbatim_snippet,
                p.created_at::text AS created_at
           FROM ero_profile p
           LEFT JOIN documents d ON d.id = p.source_document_id
          WHERE p.run_id = $1
          ORDER BY p.field_group, p.field_name
         OFFSET $2
          LIMIT $3`,
        ProfileExportRow,
        [resolvedRunId, pageOffset, pageSize + 1],
        { label: `Phase2Export: profile page offset=${pageOffset}` },
      );

      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      return {
        header,
        section: "profile",
        rows: pageRows,
        nextOffset: hasMore ? pageOffset + pageSize : null,
      };
    }

    throw new Error(
      `Invalid section: ${resolvedSection}. Use 'header', 'entities', or 'profile'.`,
    );
  },
});
