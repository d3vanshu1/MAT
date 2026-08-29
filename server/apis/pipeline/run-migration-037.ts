/**
 * Migration 037 — ero_findings credibility + materiality columns.
 *
 * Adds:
 *   finding_class   TEXT  — nullable, CHECK IN ('risk','cleared','context','unsupported')
 *   supporting_evidence_count  INT  — nullable, DEFAULT 0
 *
 * Additive only. Idempotent (checks information_schema before ALTER).
 * No backfill — applies to new runs only.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ColumnRow = z.object({ column_name: z.string() });

export default api({
  name: "RunMigration037",
  description: "Adds finding_class and supporting_evidence_count to ero_findings",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({}),

  output: z.object({
    success: z.boolean(),
    message: z.string(),
    findingClassAdded: z.boolean(),
    supportingEvidenceCountAdded: z.boolean(),
  }),

  async run(ctx) {
    const db = ctx.integrations.ic_diligence_db;

    // ── 1. Check existing columns ────────────────────────────────
    const existing = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'ero_findings'
         AND column_name IN ('finding_class', 'supporting_evidence_count')`,
      ColumnRow,
      [],
      { label: "Migration037: check existing columns" },
    );

    const existingNames = new Set(existing.map((r) => r.column_name));
    let findingClassAdded = false;
    let supportingEvidenceCountAdded = false;

    // ── 2. Add finding_class if missing ──────────────────────────
    if (!existingNames.has("finding_class")) {
      await db.execute(
        `ALTER TABLE ero_findings
           ADD COLUMN finding_class TEXT
           CHECK (finding_class IS NULL OR finding_class IN ('risk','cleared','context','unsupported'))`,
        [],
        { label: "Migration037: add finding_class column" },
      );
      findingClassAdded = true;
    }

    // ── 3. Add supporting_evidence_count if missing ──────────────
    if (!existingNames.has("supporting_evidence_count")) {
      await db.execute(
        `ALTER TABLE ero_findings
           ADD COLUMN supporting_evidence_count INT DEFAULT 0`,
        [],
        { label: "Migration037: add supporting_evidence_count column" },
      );
      supportingEvidenceCountAdded = true;
    }

    const parts: string[] = [];
    if (findingClassAdded) parts.push("finding_class added");
    else parts.push("finding_class already exists");
    if (supportingEvidenceCountAdded) parts.push("supporting_evidence_count added");
    else parts.push("supporting_evidence_count already exists");

    return {
      success: true,
      message: `Migration 037 complete: ${parts.join(", ")}.`,
      findingClassAdded,
      supportingEvidenceCountAdded,
    };
  },
});
