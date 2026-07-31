/**
 * strict-reload-findings.ts
 *
 * Shared fail-closed helper for APIs that reload persisted findings from the database.
 *
 * INVARIANT: If parseCanonicalFindings reports ANY corruption (malformed_count > 0
 * or invalid.length > 0), this function throws — callers must NOT silently serve
 * a reduced findings set.
 *
 * Production-readiness: Remediation Fix 3.
 */
import {
  type CanonicalFinding,
  parseCanonicalFindings,
} from "../pipeline/canonical-finding.js";

export interface StrictReloadResult {
  findings: CanonicalFinding[];
}

/**
 * Parse persisted findings with fail-closed semantics.
 *
 * @param raw — JSONB value (may be string or object/array)
 * @param source — human-readable context for error diagnostics
 * @throws when any finding is malformed or has identity corruption
 */
export function strictReloadFindings(
  raw: unknown,
  source: string
): StrictReloadResult {
  // Wrap JSON.parse so invalid JSON produces the same contextual error style
  // as canonical validation failures (not a bare SyntaxError).
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (parseErr) {
    throw new Error(
      `[${source}] Corrupt persisted findings — fail closed: invalid JSON (${parseErr instanceof Error ? parseErr.message : String(parseErr)})`
    );
  }

  const result = parseCanonicalFindings(parsed, {
    mode: "reload",
    source,
  });

  if (result.malformed_count > 0 || result.invalid.length > 0) {
    const details = [
      result.malformed_count > 0 ? `${result.malformed_count} malformed` : null,
      result.invalid.length > 0 ? `${result.invalid.length} identity-corrupt` : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `[${source}] Corrupt persisted findings — fail closed: ${details}`
    );
  }

  return { findings: result.findings };
}
