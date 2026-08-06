/**
 * Diagnostic API — Consolidation Dry-Run (MR-D2a)
 *
 * Measures the ungrouped OA findings left by the production 10-rule
 * deduplicateFindings engine, profiles their population, and dry-runs a
 * proposed general consolidation to project reduction and detect over-merge.
 *
 * Read-only: does not modify any data or production logic.
 * Calls REAL production functions — does not reimplement them.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import type { CanonicalFinding } from "./canonical-finding.js";
import {
  deduplicateFindings,
  computeCandidateFamily,
  extractDimensions,
  areDimensionsCompatible,
  KNOWN_FAMILY_RULES,
} from "./canonical-family-dedup.js";
import type { KnownFamilyId, GroupingDimension } from "./canonical-family-dedup.js";
import { normalize } from "./oa-ancestry-service.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// ─── Output Schemas ──────────────────────────────────────────────────────────

const PerFamilyCountSchema = z.object({
  familyId: z.string(),
  memberCount: z.number(),
  suppressed: z.number(),
});

const Section1Schema = z.object({
  totalFindings: z.number(),
  groupedCount: z.number(),
  ungroupedCount: z.number(),
  familiesCreated: z.number(),
  totalSuppressed: z.number(),
  perFamily: z.array(PerFamilyCountSchema),
});

const DistributionEntry = z.object({ key: z.string(), count: z.number() });

const Section2Schema = z.object({
  ungroupedTotal: z.number(),
  findingKindDistribution: z.array(DistributionEntry),
  categoryDistribution: z.array(DistributionEntry),
  withIssueKey: z.number(),
  withMetric: z.number(),
  withPeriod: z.number(),
  withScope: z.number(),
  topIssueKeys: z.array(z.object({ normalizedKey: z.string(), count: z.number() })),
});

const CanaryPairSchema = z.object({
  titleA: z.string(),
  titleB: z.string(),
  issueKeyA: z.string(),
  issueKeyB: z.string(),
  rejectingDimension: z.string(),
  failedClosed: z.boolean(),
});

const Section3Schema = z.object({
  proposedClustersTotal: z.number(),
  clustersFullyCompatible: z.number(),
  clustersPartiallyCompatible: z.number(),
  clustersGateRejectsEntirely: z.number(),
  projectedFindingCountAfter: z.number(),
  overMergeCanary: z.array(CanaryPairSchema),
});

const FamilySubstringEntry = z.object({ pattern: z.string(), count: z.number() });

const Section4Schema = z.object({
  familySubstringCounts: z.array(FamilySubstringEntry),
});

const ReadoutSchema = z.object({
  findingsBefore: z.number(),
  findingsAfter: z.number(),
  reductionPct: z.number(),
  canarySize: z.enum(["empty", "small", "large"]),
  canaryCount: z.number(),
});

// ─── API ─────────────────────────────────────────────────────────────────────

export default api({
  name: "DiagConsolidationDryrun",
  description: "Dry-runs proposed general consolidation on ungrouped OA findings",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable().describe("Explicit run ID; if null, auto-selects largest OA run"),
  }),

  output: z.object({
    runId: z.string(),
    section1: Section1Schema,
    section2: Section2Schema,
    section3: Section3Schema,
    section4: Section4Schema,
    readout: ReadoutSchema,
  }),

  async run(ctx, { runId: inputRunId }) {
    // ── Step 0: Resolve run ID ────────────────────────────────────────────
    let resolvedRunId: string;

    if (inputRunId) {
      resolvedRunId = inputRunId;
    } else {
      const AutoSelectRow = z.object({ id: z.string() });
      const autoRows = await ctx.integrations.db.query(
        `SELECT mr.id
         FROM module_runs mr
         JOIN module_outputs mo ON mo.module_run_id = mr.id
         WHERE mr.deal_id = $1
           AND mr.module_id = 'omission_audit'
           AND mr.status = 'completed'
         ORDER BY jsonb_array_length(mo.findings) DESC
         LIMIT 1`,
        AutoSelectRow,
        [SCG_DEAL_ID],
        { label: "Auto-select largest OA run" }
      );
      if (autoRows.length === 0) {
        throw new Error("No completed omission_audit runs found for SCG deal");
      }
      resolvedRunId = autoRows[0].id;
    }

    // ── Fetch findings ────────────────────────────────────────────────────
    const FindingsRow = z.object({ findings: z.any() });
    const findingsRows = await ctx.integrations.db.query(
      `SELECT findings FROM module_outputs WHERE module_run_id = $1`,
      FindingsRow,
      [resolvedRunId],
      { label: "Fetch module_outputs findings" }
    );

    if (findingsRows.length === 0) {
      throw new Error(`No module_outputs found for run ${resolvedRunId}`);
    }

    const findings: CanonicalFinding[] = Array.isArray(findingsRows[0].findings)
      ? findingsRows[0].findings
      : [];

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 1 — Current State (production deduplicateFindings)
    // ══════════════════════════════════════════════════════════════════════

    const dedupResult = deduplicateFindings(findings);

    const perFamily: Array<{ familyId: string; memberCount: number; suppressed: number }> = [];
    for (const fam of dedupResult.families) {
      perFamily.push({
        familyId: fam.issueFamilyKey,
        memberCount: fam.memberFindingIds.length,
        suppressed: fam.memberFindingIds.length - 1, // all except representative
      });
    }

    const groupedCount = findings.length - dedupResult.ungroupedFindingIds.length;

    const section1 = {
      totalFindings: dedupResult.totalInputFindings,
      groupedCount,
      ungroupedCount: dedupResult.ungroupedFindingIds.length,
      familiesCreated: dedupResult.totalFamiliesCreated,
      totalSuppressed: dedupResult.totalSuppressed,
      perFamily,
    };

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 2 — Ungrouped Population Profile
    // ══════════════════════════════════════════════════════════════════════

    const ungroupedSet = new Set(dedupResult.ungroupedFindingIds);
    const ungroupedFindings = findings.filter((f) => ungroupedSet.has(f.finding_id));

    // finding_kind distribution
    const kindMap = new Map<string, number>();
    const catMap = new Map<string, number>();
    let withIssueKey = 0;
    let withMetric = 0;
    let withPeriod = 0;
    let withScope = 0;

    for (const f of ungroupedFindings) {
      const kind = f.finding_kind || "__none__";
      kindMap.set(kind, (kindMap.get(kind) || 0) + 1);

      const cat = f.category || "__none__";
      catMap.set(cat, (catMap.get(cat) || 0) + 1);

      if (f.issue_key && f.issue_key.trim()) withIssueKey++;

      // Check evidence for metric/period/scope
      const dims = extractDimensions(f);
      if (dims.metric) withMetric++;
      if (dims.period) withPeriod++;
      if (dims.scope) withScope++;
    }

    const findingKindDistribution = [...kindMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }));

    const categoryDistribution = [...catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }));

    // Top 20 normalized issue_keys among ungrouped
    function normalizeIssueKey(key: string): string {
      return key
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/_(v?\d+|ver\d+|\d{4})$/, "") // strip trailing version/digits
        .replace(/^_|_$/g, "");
    }

    const issueKeyMap = new Map<string, number>();
    for (const f of ungroupedFindings) {
      if (!f.issue_key || !f.issue_key.trim()) continue;
      const nk = normalizeIssueKey(f.issue_key);
      issueKeyMap.set(nk, (issueKeyMap.get(nk) || 0) + 1);
    }

    const topIssueKeys = [...issueKeyMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([normalizedKey, count]) => ({ normalizedKey, count }));

    const section2 = {
      ungroupedTotal: ungroupedFindings.length,
      findingKindDistribution,
      categoryDistribution,
      withIssueKey,
      withMetric,
      withPeriod,
      withScope,
      topIssueKeys,
    };

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 3 — Proposed Grouping Dry-Run
    // ══════════════════════════════════════════════════════════════════════

    // Group ungrouped findings by proposed identity key
    function computeProposedKey(f: CanonicalFinding): string {
      if (f.issue_key && f.issue_key.trim()) {
        return normalizeIssueKey(f.issue_key);
      }
      // Fallback: metric|period|scope
      const dims = extractDimensions(f);
      const metric = dims.metric || "";
      const period = dims.period || "";
      const scope = dims.scope || "";
      if (metric || period || scope) {
        return `${metric}|${period}|${scope}`;
      }
      // Truly orphaned — give unique key so it stays singleton
      return `__orphan__${f.finding_id}`;
    }

    const proposedClusters = new Map<string, CanonicalFinding[]>();
    for (const f of ungroupedFindings) {
      const pk = computeProposedKey(f);
      const arr = proposedClusters.get(pk) || [];
      arr.push(f);
      proposedClusters.set(pk, arr);
    }

    // Filter to clusters of size >= 2
    const multiClusters: Array<{ key: string; members: CanonicalFinding[] }> = [];
    let singletonCount = 0;
    for (const [key, members] of proposedClusters) {
      if (members.length >= 2) {
        multiClusters.push({ key, members });
      } else {
        singletonCount++;
      }
    }

    // For each cluster, test all pairs through the production compatibility gate.
    // We use a "general" rule: all 17 material dimensions, no required separations.
    // This is the most conservative gate — if pairs pass this, they won't over-merge.
    const ALL_DIMENSIONS: GroupingDimension[] = [
      "entity", "counterparty", "counterparty_role", "contract", "property",
      "product", "issue_provision", "affected_obligation", "period", "segment",
      "scope", "metric", "unit_scale", "actual_forecast", "accounting_basis",
      "comparison_basis", "source_authority",
    ];

    let clustersFullyCompatible = 0;
    let clustersPartiallyCompatible = 0;
    let clustersGateRejectsEntirely = 0;
    const overMergeCanary: Array<{
      titleA: string;
      titleB: string;
      issueKeyA: string;
      issueKeyB: string;
      rejectingDimension: string;
      failedClosed: boolean;
    }> = [];

    for (const cluster of multiClusters) {
      const members = cluster.members;
      const dimVectors = members.map((f) => extractDimensions(f));

      let compatiblePairs = 0;
      let incompatiblePairs = 0;

      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const check = areDimensionsCompatible(
            dimVectors[i],
            dimVectors[j],
            ALL_DIMENSIONS,
            [] // no required separations for general gate
          );
          if (check.compatible) {
            compatiblePairs++;
          } else {
            incompatiblePairs++;
            // Collect canary examples (up to 20 total)
            if (overMergeCanary.length < 20) {
              overMergeCanary.push({
                titleA: members[i].title?.slice(0, 120) || "",
                titleB: members[j].title?.slice(0, 120) || "",
                issueKeyA: members[i].issue_key || "",
                issueKeyB: members[j].issue_key || "",
                rejectingDimension: check.conflictingDimension || "unknown",
                failedClosed: check.failedClosed,
              });
            }
          }
        }
      }

      if (incompatiblePairs === 0) {
        clustersFullyCompatible++;
      } else if (compatiblePairs === 0) {
        clustersGateRejectsEntirely++;
      } else {
        clustersPartiallyCompatible++;
      }
    }

    // Projected finding count:
    // = families from section1 (each family = 1 representative)
    //   + fully compatible clusters (each = 1 representative)
    //   + partially compatible clusters left unchanged (each member counted)
    //   + gate-rejected clusters left unchanged (each member counted)
    //   + singletons
    const familyRepresentatives = dedupResult.totalFamiliesCreated;
    const clusterClassifications: Array<"full" | "partial" | "rejected"> = [];

    // Classify clusters for projected count calculation
    for (const cluster of multiClusters) {
      const members = cluster.members;
      const dimVectors = members.map((f) => extractDimensions(f));
      let anyIncompat = false;
      let anyCompat = false;

      for (let i = 0; i < members.length && !(anyIncompat && anyCompat); i++) {
        for (let j = i + 1; j < members.length && !(anyIncompat && anyCompat); j++) {
          const check = areDimensionsCompatible(dimVectors[i], dimVectors[j], ALL_DIMENSIONS, []);
          if (check.compatible) anyCompat = true;
          else anyIncompat = true;
        }
      }

      if (!anyIncompat) {
        clusterClassifications.push("full");
      } else if (!anyCompat) {
        clusterClassifications.push("rejected");
      } else {
        clusterClassifications.push("partial");
      }
    }

    const projectedFindingCountAfter =
      familyRepresentatives + // 1 per existing family
      clustersFullyCompatible + // 1 per new fully-compatible cluster
      // partially + rejected clusters: all members remain
      multiClusters
        .filter((_, i) => clusterClassifications[i] !== "full")
        .reduce((sum, c) => sum + c.members.length, 0) +
      singletonCount;

    const section3 = {
      proposedClustersTotal: multiClusters.length,
      clustersFullyCompatible,
      clustersPartiallyCompatible,
      clustersGateRejectsEntirely,
      projectedFindingCountAfter,
      overMergeCanary,
    };

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 4 — Known-Family Survival (cross-check)
    // ══════════════════════════════════════════════════════════════════════

    const FAMILY_PATTERNS: Array<{ pattern: string; regex: RegExp }> = [
      { pattern: "fca_or_section_19", regex: /fca|section\s*19|s\.?\s*19/i },
      { pattern: "one_park_lane", regex: /one\s*park\s*lane|hemel\s*hempstead/i },
      { pattern: "change_of_control", regex: /change\s*(of|in)\s*control/i },
      { pattern: "contracting_out_1954", regex: /contracting\s*out|1954\s*act|security\s*of\s*tenure/i },
      { pattern: "ip_assignment", regex: /ip\s*assignment|intellectual\s*property\s*assignment/i },
      { pattern: "gdpr_consent_cookies", regex: /gdpr|pecr|cookie|consent\s*mechanism/i },
      { pattern: "calls_and_lines", regex: /calls?\s*(and|&)\s*lines?|legacy\s*voice/i },
      { pattern: "fy26_revenue", regex: /fy\s*2?6.*revenue|revenue.*fy\s*2?6/i },
      { pattern: "fy26_ebitda", regex: /fy\s*2?6.*ebitda|ebitda.*fy\s*2?6/i },
      { pattern: "customer_cube", regex: /customer\s*cube/i },
      { pattern: "m_and_a_deleveraging", regex: /m\s*&\s*a\s*deleverag|deleverag.*m\s*&\s*a/i },
      { pattern: "uncapped_indemnity", regex: /uncapped\s*indemnit|indemnit.*uncapped/i },
    ];

    const familySubstringCounts = FAMILY_PATTERNS.map(({ pattern, regex }) => {
      let count = 0;
      for (const f of findings) {
        const text = `${f.title || ""} ${f.detail || ""}`;
        if (regex.test(text)) count++;
      }
      return { pattern, count };
    });

    const section4 = { familySubstringCounts };

    // ══════════════════════════════════════════════════════════════════════
    // READOUT
    // ══════════════════════════════════════════════════════════════════════

    const findingsBefore = findings.length;
    const findingsAfter = projectedFindingCountAfter;
    const reductionPct = findingsBefore > 0
      ? Math.round(((findingsBefore - findingsAfter) / findingsBefore) * 100 * 10) / 10
      : 0;

    const canaryCount = overMergeCanary.length;
    const canarySize: "empty" | "small" | "large" =
      canaryCount === 0 ? "empty" : canaryCount <= 5 ? "small" : "large";

    const readout = {
      findingsBefore,
      findingsAfter,
      reductionPct,
      canarySize,
      canaryCount,
    };

    return {
      runId: resolvedRunId,
      section1,
      section2,
      section3,
      section4,
      readout,
    };
  },
});
