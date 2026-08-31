/**
 * mast-severity.ts
 *
 * Stage handler for severity.
 *
 * Assigns a severity (critical / warning / info) to every canonical
 * assumption by crossing the dependence tier with the support state,
 * and writes one mast_findings row per assumption.
 *
 * Pure code. No LLM. The matrix is fully enumerable and deterministic.
 *
 * severity is a single-shot stage and stays out of LOOP_STAGES.
 *
 * Writes to mast_findings and the payload column of mast_pipeline_state.
 * Does not write to mast_assumptions or mast_support_evidence.
 *
 * MAST owns this handler. No imports from OA, CC, BSS, ERO, or DCS.
 */
import type { StageContext, StageResult, StageHandler } from "./mast-contract.js";
import { z } from "@superblocksteam/sdk-api";

const LOG_PREFIX = "[MAST-SEV]";

// ---------------------------------------------------------------------------
// DB row schemas
// ---------------------------------------------------------------------------

const CanonicalRow = z.object({
  id: z.string(),
  proposition: z.string(),
  dependence_tier: z.string().nullable(),
});

const EvidenceRow = z.object({
  assumption_id: z.string(),
  statement_type: z.string(),
});

// ---------------------------------------------------------------------------
// Support state
// ---------------------------------------------------------------------------

type SupportState = "measured" | "forecast" | "asserted" | "nothing";

function resolveSupportState(
  statementTypes: Set<string>,
): SupportState {
  if (statementTypes.has("measured")) return "measured";
  if (statementTypes.has("forecast")) return "forecast";
  if (statementTypes.has("asserted")) return "asserted";
  return "nothing";
}

// ---------------------------------------------------------------------------
// Severity matrix — pure exported function
// ---------------------------------------------------------------------------

type DependenceTier = "critical" | "high" | "moderate" | "low";
type Severity = "critical" | "warning" | "info";

const MATRIX: Record<DependenceTier, Record<SupportState, Severity>> = {
  critical: {
    nothing: "critical",
    asserted: "critical",
    forecast: "warning",
    measured: "info",
  },
  high: {
    nothing: "critical",
    asserted: "warning",
    forecast: "warning",
    measured: "info",
  },
  moderate: {
    nothing: "warning",
    asserted: "warning",
    forecast: "info",
    measured: "info",
  },
  low: {
    nothing: "info",
    asserted: "info",
    forecast: "info",
    measured: "info",
  },
};

export function computeSeverity(
  dependenceTier: DependenceTier,
  supportState: SupportState,
): Severity {
  return MATRIX[dependenceTier][supportState];
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

const severity: StageHandler = async (
  ctx: StageContext,
): Promise<StageResult> => {
  const { db, runId, dealId } = ctx;

  // ── 1. Load canonical assumptions ─────────────────────────────────
  const allRows = await db.query(
    `SELECT id, proposition, dependence_tier
     FROM mast_assumptions
     WHERE run_id = $1::uuid AND dedup_group_id = id
     ORDER BY id`,
    CanonicalRow,
    [runId],
    { label: "MAST-SEV: load canonical assumptions" },
  );

  if (allRows.length === 0) {
    throw new Error(
      `${LOG_PREFIX} No canonical assumptions found for run ${runId}. Cannot proceed.`,
    );
  }

  const totalRows = allRows.length;
  console.log(`${LOG_PREFIX} ${totalRows} canonical assumptions loaded.`);

  // ── 2. Load support evidence ──────────────────────────────────────
  const evidenceRows = await db.query(
    `SELECT assumption_id, statement_type
     FROM mast_support_evidence
     WHERE run_id = $1::uuid`,
    EvidenceRow,
    [runId],
    { label: "MAST-SEV: load support evidence" },
  );

  const totalEvidenceRows = evidenceRows.length;
  const sweepRan = totalEvidenceRows > 0;

  if (!sweepRan) {
    console.log(
      `${LOG_PREFIX} WARNING: mast_support_evidence is empty for run ${runId}. ` +
      `The support sweep has not run. Every finding will read as unsupported.`,
    );
  } else {
    console.log(`${LOG_PREFIX} ${totalEvidenceRows} evidence rows loaded.`);
  }

  // Group evidence by assumption_id → set of statement_types
  const evidenceByAssumption = new Map<string, Set<string>>();
  for (const row of evidenceRows) {
    let types = evidenceByAssumption.get(row.assumption_id);
    if (!types) {
      types = new Set<string>();
      evidenceByAssumption.set(row.assumption_id, types);
    }
    types.add(row.statement_type);
  }

  // ── 3. Compute severity per assumption ────────────────────────────
  let missingTierCount = 0;
  const severityCounts: Record<string, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  const supportStateCounts: Record<string, number> = {
    measured: 0,
    forecast: 0,
    asserted: 0,
    nothing: 0,
  };
  // Full 4×4 matrix counts for payload
  const matrixCounts: Record<string, Record<string, number>> = {
    critical: { nothing: 0, asserted: 0, forecast: 0, measured: 0 },
    high: { nothing: 0, asserted: 0, forecast: 0, measured: 0 },
    moderate: { nothing: 0, asserted: 0, forecast: 0, measured: 0 },
    low: { nothing: 0, asserted: 0, forecast: 0, measured: 0 },
  };

  interface FindingRow {
    assumption_id: string;
    title: string;
    sev: Severity;
    basis: string;
  }

  const findings: FindingRow[] = [];

  for (const row of allRows) {
    // Resolve dependence tier
    let tier: DependenceTier;
    if (
      row.dependence_tier === null ||
      !["critical", "high", "moderate", "low"].includes(row.dependence_tier)
    ) {
      tier = "low";
      missingTierCount++;
    } else {
      tier = row.dependence_tier as DependenceTier;
    }

    // Resolve support state
    const types = evidenceByAssumption.get(row.id) ?? new Set<string>();
    const support = resolveSupportState(types);

    // Compute severity
    const sev = computeSeverity(tier, support);

    // Track counts
    severityCounts[sev]++;
    supportStateCounts[support]++;
    matrixCounts[tier][support]++;

    // Build finding
    findings.push({
      assumption_id: row.id,
      title: row.proposition.length > 300
        ? row.proposition.slice(0, 300)
        : row.proposition,
      sev,
      basis: `dependence=${tier};support=${support}`,
    });
  }

  // ── 4. Idempotency — delete existing findings for this run ────────
  await db.execute(
    `DELETE FROM mast_findings WHERE run_id = $1::uuid`,
    [runId],
    { label: "MAST-SEV: delete existing findings for idempotency" },
  );

  // ── 5. Insert findings ────────────────────────────────────────────
  for (const f of findings) {
    await db.execute(
      `INSERT INTO mast_findings (
         id, run_id, deal_id, assumption_id, title, severity, severity_basis,
         falsification_condition, monitoring_trigger, fragility_generated
       ) VALUES (
         gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         NULL, NULL, false
       )`,
      [runId, dealId, f.assumption_id, f.title, f.sev, f.basis],
      { label: `MAST-SEV: insert finding for ${f.assumption_id}` },
    );
  }

  // ── 6. Log prominently ────────────────────────────────────────────
  console.log(
    `${LOG_PREFIX} Severity scoring complete. ${findings.length} findings written. ` +
    `critical=${severityCounts.critical}, warning=${severityCounts.warning}, ` +
    `info=${severityCounts.info}. ` +
    `sweepRan=${sweepRan}. missingTier=${missingTierCount}.`,
  );

  console.log(
    `${LOG_PREFIX} Support state distribution: ` +
    `measured=${supportStateCounts.measured}, forecast=${supportStateCounts.forecast}, ` +
    `asserted=${supportStateCounts.asserted}, nothing=${supportStateCounts.nothing}.`,
  );

  // ── 7. Persist payload ────────────────────────────────────────────
  const summaryPayload = {
    totalFindings: findings.length,
    severityCounts,
    supportStateCounts,
    matrixApplied: matrixCounts,
    missingTierCount,
    totalEvidenceRows,
    sweepRan,
  };

  try {
    await db.execute(
      `UPDATE mast_pipeline_state
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1::uuid AND stage = $2 AND stage != '_lock'`,
      [runId, "severity", JSON.stringify(summaryPayload)],
      { label: "MAST-SEV: persist stage summary" },
    );
  } catch (payloadErr) {
    console.log(`${LOG_PREFIX} Failed to persist payload: ${String(payloadErr)}`);
  }

  return {
    complete: true,
    itemsDone: findings.length,
    itemsTotal: findings.length,
    resumePosition: 0,
  };
};

export default severity;
