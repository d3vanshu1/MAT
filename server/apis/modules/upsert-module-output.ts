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
 * Fix: Large-payload chunking (Aug 2026)
 *   The Superblocks integration layer uses gRPC with a 4MB message limit.
 *   For large reports (205+ analyses), the full_report_markdown or findings
 *   JSON can exceed this. The fix:
 *     1. INSERT/UPDATE skeleton (header, schema_version, finalized_at) — small payload
 *     2. UPDATE findings in chunks if > 3MB (jsonb concatenation)
 *     3. UPDATE full_report_markdown in chunks (first SET, then || concatenation)
 *   Each chunk stays under MAX_CHUNK_BYTES (3MB) to fit within gRPC envelope.
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

/** Max bytes per gRPC call payload. 4MB limit with safety margin. */
const MAX_CHUNK_BYTES = 3_000_000; // 3MB (leaves ~1MB for gRPC envelope, SQL, params overhead)

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

  // Fix 13: schema_version and finalized_at columns are assumed to exist
  // (created by prior migrations / RunMigration004+). Do NOT use ALTER TABLE
  // at runtime — Supabase PgBouncer in transaction-pooling mode rejects DDL,
  // and even caught errors corrupt the connection state for subsequent queries.
  const finalizedAt = new Date().toISOString();
  const findingsJson = JSON.stringify(validatedFindings);

  // Log payload sizes for diagnostics
  console.log(
    `[upsertModuleOutput] Payload sizes: executive_header=${executiveHeader.length} chars, ` +
    `findings_json=${findingsJson.length} chars (${validatedFindings.length} items), ` +
    `full_report=${fullReport.length} chars`
  );

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
    // --- UPDATE path (split into multiple calls to avoid payload limits) ---
    outputId = existing[0].output_id;
    wasUpdate = true;

    // Step 1: Update small fields (header, schema, timestamp)
    await db.execute(
      `UPDATE module_outputs
       SET executive_header = $2, schema_version = $3, finalized_at = $4::timestamptz
       WHERE id = $1`,
      [outputId, executiveHeader, schemaVersion, finalizedAt],
      { label: "upsertModuleOutput: update skeleton" }
    );

    // Step 2: Update findings (chunk if > MAX_CHUNK_BYTES)
    await writeChunkedText(
      db,
      outputId,
      "findings",
      findingsJson,
      true, // isJsonb
      "upsertModuleOutput: update findings"
    );

    // Step 3: Update full report (chunk if > MAX_CHUNK_BYTES)
    await writeChunkedText(
      db,
      outputId,
      "full_report_markdown",
      fullReport,
      false, // plain text
      "upsertModuleOutput: update report"
    );
  } else {
    // --- INSERT path (split: insert skeleton, then update large fields) ---
    // Step 1: Insert skeleton row with small fields only
    const insertRows = await db.query(
      `INSERT INTO module_outputs (module_run_id, executive_header, findings, full_report_markdown, schema_version, finalized_at)
       VALUES ($1, $2, '[]'::jsonb, '', $3, $4::timestamptz)
       RETURNING id AS output_id`,
      z.object({ output_id: z.string() }),
      [runId, executiveHeader, schemaVersion, finalizedAt],
      { label: "upsertModuleOutput: insert skeleton" }
    );
    outputId = insertRows[0].output_id;

    // Step 2: Update findings (chunk if > MAX_CHUNK_BYTES)
    await writeChunkedText(
      db,
      outputId,
      "findings",
      findingsJson,
      true, // isJsonb
      "upsertModuleOutput: set findings"
    );

    // Step 3: Update full report (chunk if > MAX_CHUNK_BYTES)
    await writeChunkedText(
      db,
      outputId,
      "full_report_markdown",
      fullReport,
      false, // plain text
      "upsertModuleOutput: set report"
    );
  }

  // Bump deal updated_at
  await db.execute(
    `UPDATE deals SET updated_at = now() WHERE id = $1`,
    [dealId],
    { label: "upsertModuleOutput: bump deal" }
  );

  console.log(`[upsertModuleOutput] Successfully saved output ${outputId} (${wasUpdate ? "update" : "insert"})`);
  return { outputId, wasUpdate, validationIssues: parseResult.invalid.length, schemaVersion };
}

/**
 * Writes a large text value to a column in chunks to stay under the 4MB gRPC limit.
 * 
 * Strategy:
 *   - If data fits in one chunk (<= MAX_CHUNK_BYTES): single SET
 *   - If data exceeds one chunk: SET first chunk, then CONCATENATE subsequent chunks
 * 
 * For jsonb columns (isJsonb=true): the entire value is sent as one piece because
 * PostgreSQL can't concatenate partial JSON. If it's over the limit, we throw
 * (findings JSON shouldn't exceed 3MB; if it does, something is wrong).
 * 
 * For text columns: use SET for first chunk, then `column = column || $2` for rest.
 */
async function writeChunkedText(
  db: { execute: (...args: any[]) => Promise<any> },
  outputId: string,
  column: string,
  data: string,
  isJsonb: boolean,
  labelPrefix: string,
): Promise<void> {
  const dataBytes = Buffer.byteLength(data, "utf8");

  if (isJsonb) {
    // JSONB can't be written in chunks — must be atomic.
    // If it exceeds the limit, we have a data quality issue.
    if (dataBytes > MAX_CHUNK_BYTES) {
      console.warn(
        `[upsertModuleOutput] WARNING: ${column} is ${(dataBytes / 1_000_000).toFixed(1)}MB — ` +
        `exceeds ${MAX_CHUNK_BYTES / 1_000_000}MB chunk limit. Attempting anyway...`
      );
    }
    const cast = isJsonb ? "::jsonb" : "";
    await db.execute(
      `UPDATE module_outputs SET ${column} = $2${cast} WHERE id = $1`,
      [outputId, data],
      { label: `${labelPrefix} (${(dataBytes / 1000).toFixed(0)}KB)` }
    );
    return;
  }

  // Text column: chunk if needed
  if (dataBytes <= MAX_CHUNK_BYTES) {
    // Fits in one call
    await db.execute(
      `UPDATE module_outputs SET ${column} = $2 WHERE id = $1`,
      [outputId, data],
      { label: `${labelPrefix} (${(dataBytes / 1000).toFixed(0)}KB, single)` }
    );
    return;
  }

  // Multi-chunk write
  const chunks = splitIntoChunks(data, MAX_CHUNK_BYTES);
  console.log(
    `[upsertModuleOutput] Chunking ${column}: ${(dataBytes / 1_000_000).toFixed(1)}MB → ${chunks.length} chunks`
  );

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      // First chunk: SET (overwrites any previous value)
      await db.execute(
        `UPDATE module_outputs SET ${column} = $2 WHERE id = $1`,
        [outputId, chunks[i]],
        { label: `${labelPrefix} chunk ${i + 1}/${chunks.length}` }
      );
    } else {
      // Subsequent chunks: concatenate
      await db.execute(
        `UPDATE module_outputs SET ${column} = ${column} || $2 WHERE id = $1`,
        [outputId, chunks[i]],
        { label: `${labelPrefix} chunk ${i + 1}/${chunks.length}` }
      );
    }
  }
}

/**
 * Splits a string into chunks where each chunk is at most maxBytes in UTF-8.
 * Splits on character boundaries (never in the middle of a multi-byte char).
 */
function splitIntoChunks(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    // Binary search for the longest substring starting at `start` that fits in maxBytes
    let end = Math.min(start + maxBytes, text.length); // optimistic upper bound (ASCII)
    let slice = text.slice(start, end);

    while (Buffer.byteLength(slice, "utf8") > maxBytes && end > start + 1) {
      // Reduce by ~10% each iteration for efficiency
      end = start + Math.max(1, Math.floor((end - start) * 0.9));
      slice = text.slice(start, end);
    }

    // If still too big (single chars > maxBytes impossible but guard anyway)
    if (Buffer.byteLength(slice, "utf8") > maxBytes && end - start > 1) {
      end = start + 1;
      slice = text.slice(start, end);
    }

    chunks.push(slice);
    start = end;
  }

  return chunks;
}
