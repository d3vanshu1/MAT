import { z } from "@superblocksteam/sdk-api";
import { parseCanonicalFindings, FINDING_SCHEMA_VERSION, type CanonicalFinding } from "../pipeline/canonical-finding.js";

/**
 * Shared helper: upserts a row in module_outputs and bumps the deal's updated_at.
 *
 * RC4 (Single Canonical Finalizer): Before persisting, findings are validated
 * through parseCanonicalFindings in "reload" mode. This ensures only canonical-
 * compliant data reaches the database.
 *
 * Fix 13 (Canonical Output Consistency): Persists `schema_version` and
 * `finalized_at` alongside findings so consumers can detect stale artifacts.
 * The column is added idempotently on first write (ADD COLUMN IF NOT EXISTS).
 *
 * Behavior:
 *   - Malformed findings (irrecoverable) → throws, refusing to persist corrupt data.
 *   - Invalid findings (coercible) → coerced to canonical form and persisted once.
 *     Validation issues are logged as diagnostics only.
 *   - Valid findings → persisted as-is.
 *
 * Each finding appears exactly ONCE in the persisted array. The parser's `findings`
 * array already includes both valid and coerced-invalid items — they must NOT be
 * re-added from `invalid`.
 *
 * Call this instead of writing inline INSERT/UPDATE logic in each recovery path.
 * Keeps module_outputs writes in a single place so schema changes propagate once.
 *
 * @param db - A postgres integration client (ctx.integrations.db)
 */

/** Tracks whether schema_version column has been ensured in this process lifetime */
let schemaVersionColumnEnsured = false;

export async function upsertModuleOutput(
  db: {
    query: (...args: any[]) => Promise<any[]>;
    execute: (...args: any[]) => Promise<any>;
  },
  params: {
    runId: string;
    dealId: string;
    executiveHeader: string;
    findings: unknown[];
    fullReport: string;
    /** Override schema version (for testing). Defaults to FINDING_SCHEMA_VERSION. */
    schemaVersion?: number;
  }
): Promise<{ outputId: string; wasUpdate: boolean; validationIssues: number; schemaVersion: number }> {
  const { runId, dealId, executiveHeader, findings, fullReport } = params;
  const schemaVersion = params.schemaVersion ?? FINDING_SCHEMA_VERSION;

  // RC4: Validate findings through canonical parser before persisting.
  // In "strict" mode: if ANY finding fails canonical validation, reject the entire
  // persistence call. The caller must fix data quality upstream.
  const parseResult = parseCanonicalFindings(findings, {
    mode: "reload",
    source: `upsert-module-output:${runId}`,
  });

  if (parseResult.malformed_count > 0) {
    throw new Error(
      `[upsert-module-output] ${parseResult.malformed_count} findings were irrecoverably malformed. ` +
      `Run: ${runId}. Refusing to persist corrupt data.`
    );
  }

  if (parseResult.invalid.length > 0) {
    console.warn(
      `[upsert-module-output] ${parseResult.invalid.length} findings had validation issues ` +
      `(coerced to canonical form). Run: ${runId}`
    );
    for (const inv of parseResult.invalid.slice(0, 5)) {
      console.warn(`  → "${inv.finding.title}": ${inv.issues.join("; ")}`);
    }
  }

  // parseResult.findings already contains ALL items (valid + coerced-invalid).
  // Do NOT re-add from parseResult.invalid — that would duplicate findings.
  const validatedFindings: CanonicalFinding[] = parseResult.findings;

  // Fix 13: Ensure schema_version column exists (idempotent, once per process)
  if (!schemaVersionColumnEnsured) {
    try {
      await db.execute(
        `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS schema_version INTEGER`,
        [],
        { label: "upsertModuleOutput: ensure schema_version column" }
      );
      await db.execute(
        `ALTER TABLE module_outputs ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`,
        [],
        { label: "upsertModuleOutput: ensure finalized_at column" }
      );
      schemaVersionColumnEnsured = true;
    } catch (migErr) {
      // Non-fatal: column may already exist or permissions may block DDL.
      // Proceed without versioning — consumers will see NULL and log a warning.
      console.warn(`[upsertModuleOutput] schema_version column migration skipped:`, migErr);
      schemaVersionColumnEnsured = true; // Don't retry every call
    }
  }

  const finalizedAt = new Date().toISOString();

  // Check if output already exists for this run
  const existing = await db.query(
    `SELECT id AS output_id FROM module_outputs WHERE module_run_id = $1 LIMIT 1`,
    z.object({ output_id: z.string() }),
    [runId],
    { label: "upsertModuleOutput: check existing" }
  );

  let outputId: string;
  let wasUpdate = false;

  if (existing.length > 0) {
    outputId = existing[0].output_id;
    wasUpdate = true;
    await db.execute(
      `UPDATE module_outputs
       SET executive_header = $2, findings = $3::jsonb, full_report_markdown = $4,
           schema_version = $5, finalized_at = $6::timestamptz
       WHERE id = $1`,
      [outputId, executiveHeader, JSON.stringify(validatedFindings), fullReport, schemaVersion, finalizedAt],
      { label: "upsertModuleOutput: update" }
    );
  } else {
    const insertRows = await db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown, schema_version, finalized_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)
       RETURNING id AS output_id`,
      z.object({ output_id: z.string() }),
      [runId, executiveHeader, JSON.stringify(validatedFindings), fullReport, schemaVersion, finalizedAt],
      { label: "upsertModuleOutput: insert" }
    );
    outputId = insertRows[0].output_id;
  }

  // Bump deal updated_at
  await db.execute(
    `UPDATE deals SET updated_at = now() WHERE id = $1`,
    [dealId],
    { label: "upsertModuleOutput: bump deal" }
  );

  return { outputId, wasUpdate, validationIssues: parseResult.invalid.length, schemaVersion };
}
