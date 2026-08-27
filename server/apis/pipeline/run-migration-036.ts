/**
 * Migration 036 — ero_entities idempotency constraint.
 *
 * Adds UNIQUE (run_id, entity_type, legal_name) to ero_entities so that
 * concurrent / ghost executions of the entity-manifest stage cannot
 * accumulate duplicate rows (the check-then-act idempotency guard is
 * defeated by the testApi double-execution race).
 *
 * Before adding the constraint, existing duplicates are removed — keeping
 * the row with the smallest entity_id (deterministic, PK-ordered) per
 * (run_id, entity_type, legal_name) group and deleting the rest.
 *
 * Additive only. Idempotent (checks information_schema before ALTER).
 * Does NOT add any constraint on registration_number — reg-number-aware
 * dedup is a separate concern (Layer 2).
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const CONSTRAINT_NAME = "uq_ero_entities_run_type_name";

const ConstraintRow = z.object({ constraint_name: z.string() });
const TotalRow = z.object({ cnt: z.number() });

export default api({
  name: "RunMigration036",
  description: "Adds UNIQUE(run_id,entity_type,legal_name) to ero_entities",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    duplicatesRemoved: z.number(),
    constraintCreated: z.boolean(),
    constraintAlreadyExisted: z.boolean(),
  }),

  async run(ctx) {
    const db = ctx.integrations.db;

    // -- 1. Check if constraint already exists
    const existing = await db.query(
      `SELECT constraint_name
         FROM information_schema.table_constraints
        WHERE table_name = 'ero_entities'
          AND constraint_name = $1`,
      ConstraintRow,
      [CONSTRAINT_NAME],
      { label: "Migration036: check existing constraint" },
    );

    if (existing.length > 0) {
      return {
        success: true,
        message: `Constraint ${CONSTRAINT_NAME} already exists - migration is a no-op.`,
        duplicatesRemoved: 0,
        constraintCreated: false,
        constraintAlreadyExisted: true,
      };
    }

    // -- 2. Count rows before dedup
    const preCounts = await db.query(
      `SELECT count(*)::int AS cnt FROM ero_entities`,
      TotalRow,
      [],
      { label: "Migration036: count rows before dedup" },
    );
    const totalBefore = preCounts[0]?.cnt ?? 0;

    // -- 3. Remove duplicate rows
    // Keep the row with the smallest entity_id per (run_id, entity_type,
    // legal_name) group. Delete all others.
    // Single atomic statement - no window for partial state.
    await db.execute(
      `DELETE FROM ero_entities
        WHERE entity_id IN (
          SELECT entity_id FROM (
            SELECT entity_id,
                   ROW_NUMBER() OVER (
                     PARTITION BY run_id, entity_type, legal_name
                     ORDER BY entity_id
                   ) AS rn
              FROM ero_entities
          ) ranked
          WHERE rn > 1
        )`,
      [],
      { label: "Migration036: remove duplicate entities" },
    );

    // -- 4. Count rows after dedup
    const postCounts = await db.query(
      `SELECT count(*)::int AS cnt FROM ero_entities`,
      TotalRow,
      [],
      { label: "Migration036: count rows after dedup" },
    );
    const totalAfter = postCounts[0]?.cnt ?? 0;
    const duplicatesRemoved = totalBefore - totalAfter;

    // -- 5. Add UNIQUE constraint
    await db.execute(
      `ALTER TABLE ero_entities
         ADD CONSTRAINT ${CONSTRAINT_NAME}
         UNIQUE (run_id, entity_type, legal_name)`,
      [],
      { label: "Migration036: add unique constraint" },
    );

    const message = [
      `Removed ${duplicatesRemoved} duplicate rows (${totalBefore} -> ${totalAfter}).`,
      `Constraint ${CONSTRAINT_NAME} created on (run_id, entity_type, legal_name).`,
    ].join(" ");

    return {
      success: true,
      message,
      duplicatesRemoved,
      constraintCreated: true,
      constraintAlreadyExisted: false,
    };
  },
});
