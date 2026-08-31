/**
 * dcs-v2-compat.ts
 *
 * Compatibility layer for DCS v2 report-envelope format stored in module_outputs.findings.
 *
 * DCS v2 stores a single report envelope in the findings JSONB column:
 *   [{ reportVersion, reportHash, corpusScope, priorityGaps, coverageOverview, ... }]
 *
 * This is NOT canonical findings format. These helpers detect the envelope format
 * and map priorityGaps → CanonicalFinding[] so the dashboard can display DCS results.
 */
import { z } from "@superblocksteam/sdk-api";
import { CanonicalFindingSchema } from "../pipeline/canonical-finding.js";

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------
interface DcsV2PriorityGap {
  dimension: string;
  gap: string;
  coverage: string;
  basis: string;
  icImplication: string;
}

interface DcsV2Envelope {
  reportVersion: number;
  priorityGaps: DcsV2PriorityGap[];
  coverageOverview: Array<{
    dimension: string;
    coverage: string;
    depth: string;
    principalLimitation: string;
  }>;
}

export function isDcsV2Report(raw: unknown): raw is [DcsV2Envelope] {
  if (!Array.isArray(raw) || raw.length !== 1) return false;
  const envelope = raw[0];
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    "reportVersion" in envelope &&
    "priorityGaps" in envelope &&
    Array.isArray((envelope as Record<string, unknown>).priorityGaps)
  );
}

// ---------------------------------------------------------------------------
// UUID helper (cross-environment, no Node crypto dependency)
// ---------------------------------------------------------------------------
function randomUUID(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as any).crypto?.randomUUID === "function"
  ) {
    return (globalThis as any).crypto.randomUUID() as string;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Mapper: DCS v2 priorityGaps → CanonicalFinding[]
// ---------------------------------------------------------------------------

/** Map DCS v2 priorityGaps into CanonicalFinding[] for dashboard display. */
export function mapDcsV2ToCanonical(
  envelope: DcsV2Envelope,
): z.infer<typeof CanonicalFindingSchema>[] {
  return envelope.priorityGaps.map((pg) => ({
    finding_id: randomUUID(),
    severity:
      pg.coverage === "Narrative only"
        ? ("critical" as const)
        : ("warning" as const),
    title: `${pg.dimension}: ${pg.gap.length > 100 ? pg.gap.slice(0, 97) + "..." : pg.gap}`,
    detail: pg.gap,
    full_analysis: pg.icImplication,
    source_docs: [],
    category: "principal_finding" as const,
    finding_kind: "absence_claim" as const,
  }));
}
