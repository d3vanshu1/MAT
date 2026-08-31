/**
 * mast-publish-inline.ts
 *
 * Inline publish function callable from the render stage handler.
 * Writes the rendered MAST report to module_runs + module_outputs
 * so the dashboard displays it.
 *
 * This is the shared implementation used by both the render stage
 * (automatic publish) and the MastPublish API (manual re-publish).
 *
 * No LLM. No web requests.
 */

const LOG_PREFIX = "[MAST-PUBLISH]";
const MAST_MODULE_ID = "model_assumptions_stress";

interface SectionCounts {
  totalFindings: number;
  critical: number;
  nothingCount: number;
  [key: string]: unknown;
}

/**
 * Publish a MAST run to module_outputs.
 *
 * @param db      – postgres client from ctx.integrations
 * @param runId   – the MAST module_runs.id
 * @param dealId  – the deal UUID
 * @param report  – rendered markdown
 * @param counts  – sectionCounts from the render payload
 */
export default async function mastPublish(
  db: {
    execute: (sql: string, params: unknown[], meta?: { label?: string }) => Promise<void>;
    query: <T>(sql: string, schema: unknown, params: unknown[], meta?: { label?: string }) => Promise<T[]>;
  },
  runId: string,
  dealId: string,
  report: string,
  counts: SectionCounts,
): Promise<string> {
  const totalFindings = counts.totalFindings ?? 0;
  const criticalCount = counts.critical ?? 0;
  const nothingCount = counts.nothingCount ?? 0;

  // ── 1. Assemble header in code ──────────────────────────────────
  const headerParts: string[] = [
    `Model Assumptions Stress Test: ${totalFindings} assumptions assessed`,
  ];
  if (criticalCount > 0) {
    headerParts.push(`${criticalCount} critical finding${criticalCount === 1 ? "" : "s"}`);
  }
  if (nothingCount > 0) {
    headerParts.push(`${nothingCount} with no support located`);
  }
  const executiveHeader = headerParts.join(", ") + ".";

  // ── 2. Upsert module_runs ─────────────────────────────────────
  await db.execute(
    `INSERT INTO module_runs
       (id, deal_id, module_id, status, triggered_at, completed_at, documents_included)
     VALUES ($1::uuid, $2::uuid, $3, 'completed', NOW(), NOW(), '{}')
     ON CONFLICT (id) DO UPDATE
       SET status = 'completed', completed_at = NOW()`,
    [runId, dealId, MAST_MODULE_ID],
    { label: "MAST-PUBLISH: upsert module_runs" },
  );

  // ── 3. DELETE then INSERT module_outputs ───────────────────────
  await db.execute(
    `DELETE FROM module_outputs WHERE module_run_id = $1::uuid`,
    [runId],
    { label: "MAST-PUBLISH: clear existing module_output" },
  );

  // findings: empty JSON array — MAST findings live in mast_findings
  await db.execute(
    `INSERT INTO module_outputs
       (module_run_id, executive_header, findings, full_report_markdown)
     VALUES ($1::uuid, $2, '[]'::jsonb, $3)`,
    [runId, executiveHeader, report],
    { label: "MAST-PUBLISH: insert module_outputs row" },
  );

  // ── 4. Bump deals.updated_at ──────────────────────────────────
  await db.execute(
    `UPDATE deals SET updated_at = NOW() WHERE id = $1::uuid`,
    [dealId],
    { label: "MAST-PUBLISH: bump deal updated_at" },
  );

  console.log(
    `${LOG_PREFIX} Published. module_run_id=${runId}, header="${executiveHeader}"`,
  );

  return executiveHeader;
}
