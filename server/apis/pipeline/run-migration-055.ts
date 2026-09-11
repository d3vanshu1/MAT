import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration055",
  description: "Adds verify_status and verify_count to workbooks",
  integrations: { ic_diligence: postgres(IC_DB) },
  input: z.object({ dryRun: z.boolean().default(false) }),
  output: z.object({ added: z.array(z.string()), dryRun: z.boolean() }),
  async run(ctx, { dryRun }) {
    const db = ctx.integrations.ic_diligence;
    const added: string[] = [];

    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'workbooks' AND column_name IN ('verify_status', 'verify_count')`,
      z.object({ column_name: z.string() }),
      [],
      { label: "check existing columns" },
    );
    const existing = new Set(cols.map((c) => c.column_name));

    if (!existing.has("verify_status")) {
      if (!dryRun) {
        await db.execute(
          `ALTER TABLE workbooks ADD COLUMN verify_status text DEFAULT 'none'`,
          [],
          { label: "add verify_status" },
        );
      }
      added.push("workbooks.verify_status");
    }
    if (!existing.has("verify_count")) {
      if (!dryRun) {
        await db.execute(
          `ALTER TABLE workbooks ADD COLUMN verify_count int DEFAULT 0`,
          [],
          { label: "add verify_count" },
        );
      }
      added.push("workbooks.verify_count");
    }

    return { added, dryRun };
  },
});
