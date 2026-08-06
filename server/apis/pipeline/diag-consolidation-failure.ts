/**
 * Diagnostic API — Consolidation-failure analysis for Omission Audit
 *
 * Explains why a given OA run produced ~500 findings instead of consolidating
 * to a small set. Sections A–E analyze fragmentation, sharing, duplication,
 * known families, and funnel stalls.
 *
 * Read-only: does not modify any data.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const KeyFragmentationSchema = z.object({
  totalFindings: z.number(),
  distinctIssueKeys: z.number(),
  avgFindingsPerKey: z.number(),
  singletonKeyCount: z.number().describe("Keys appearing exactly once"),
  singletonKeyPct: z.number(),
  topKeys: z.array(z.object({
    issueKey: z.string(),
    count: z.number(),
  })).describe("Top 15 most-repeated keys"),
});

const ClaimSharingSchema = z.object({
  totalClaimIds: z.number(),
  distinctClaimIds: z.number(),
  sharedClaimIds: z.number().describe("Claim IDs referenced by >1 finding"),
  sharedClaimPct: z.number(),
  maxFindingsPerClaim: z.number(),
  histogram: z.array(z.object({
    bucket: z.string(),
    count: z.number(),
  })).describe("Claim-ID reference count histogram"),
});

const TitleClusterSchema = z.object({
  totalClusters: z.number(),
  clustersWithMultiple: z.number(),
  largestClusterSize: z.number(),
  largestClusterLabel: z.string(),
  topClusters: z.array(z.object({
    normalizedTitle: z.string(),
    count: z.number(),
  })).describe("Top 10 title clusters by size"),
});

const KNOWN_FAMILIES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Missing/Absent Disclosure", pattern: /missing|absent|not\s+disclosed|omitted/i },
  { name: "Incomplete Coverage", pattern: /incomplete|partial|insufficient\s+coverage/i },
  { name: "Stale/Outdated Information", pattern: /stale|outdated|not\s+updated|expired/i },
  { name: "Inconsistent/Conflicting Data", pattern: /inconsisten|conflictin|contradicts?/i },
  { name: "Unverified Claims", pattern: /unverified|not\s+confirmed|lacks?\s+evidence/i },
  { name: "Format/Presentation Issues", pattern: /format|presentation|layout|structure/i },
  { name: "Scope Gap", pattern: /scope\s+gap|out\s+of\s+scope|not\s+addressed/i },
];

const FamilySurvivalSchema = z.object({
  families: z.array(z.object({
    familyName: z.string(),
    matchCount: z.number(),
    pctOfTotal: z.number(),
  })),
  uncategorizedCount: z.number(),
  uncategorizedPct: z.number(),
});

const FunnelStallSchema = z.object({
  totalLevels: z.number(),
  levelStats: z.array(z.object({
    treeLevel: z.number(),
    nodeCount: z.number(),
    totalFindings: z.number(),
    collapseRatio: z.number().nullable(),
  })),
  stallLevel: z.number().nullable().describe("First level where collapseRatio > 0.90 (no meaningful collapse)"),
  rootFindings: z.number(),
});

const HypothesisSchema = z.object({
  hypotheses: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]).describe("Overall consolidation-failure severity"),
});

// ─── API ──────────────────────────────────────────────────────────────────────

export default api({
  name: "DiagConsolidationFailure",
  description: "Analyzes why an Omission Audit run failed to consolidate findings",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable().describe("Explicit run ID; if null, auto-selects largest OA run"),
  }),

  output: z.object({
    runId: z.string(),
    findingCount: z.number(),
    sectionA: KeyFragmentationSchema,
    sectionB: ClaimSharingSchema,
    sectionC: TitleClusterSchema,
    sectionD: FamilySurvivalSchema,
    sectionE: FunnelStallSchema,
    diagnosis: HypothesisSchema,
  }),

  async run(ctx, { runId: inputRunId }) {
    // ── Step 0: Resolve run ID ────────────────────────────────────────────────
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

    // ── Fetch findings ────────────────────────────────────────────────────────
    const FindingsRow = z.object({
      findings: z.any(),
    });
    const findingsRows = await ctx.integrations.db.query(
      `SELECT findings FROM module_outputs WHERE module_run_id = $1`,
      FindingsRow,
      [resolvedRunId],
      { label: "Fetch module_outputs findings" }
    );

    if (findingsRows.length === 0) {
      throw new Error(`No module_outputs found for run ${resolvedRunId}`);
    }

    const findings: Array<{
      issue_key?: string;
      claim_ids?: string[];
      title?: string;
      finding_kind?: string;
      category?: string;
      severity?: string;
      detail?: string;
    }> = Array.isArray(findingsRows[0].findings) ? findingsRows[0].findings : [];

    const findingCount = findings.length;

    // ── Section A: Key Fragmentation ──────────────────────────────────────────
    const keyMap = new Map<string, number>();
    for (const f of findings) {
      const key = f.issue_key || "__no_key__";
      keyMap.set(key, (keyMap.get(key) || 0) + 1);
    }
    const distinctIssueKeys = keyMap.size;
    const singletonKeyCount = [...keyMap.values()].filter(c => c === 1).length;
    const avgFindingsPerKey = distinctIssueKeys > 0
      ? Math.round((findingCount / distinctIssueKeys) * 100) / 100
      : 0;
    const singletonKeyPct = distinctIssueKeys > 0
      ? Math.round((singletonKeyCount / distinctIssueKeys) * 100 * 10) / 10
      : 0;
    const topKeys = [...keyMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([issueKey, count]) => ({ issueKey, count }));

    const sectionA = {
      totalFindings: findingCount,
      distinctIssueKeys,
      avgFindingsPerKey,
      singletonKeyCount,
      singletonKeyPct,
      topKeys,
    };

    // ── Section B: Claim-ID Sharing ───────────────────────────────────────────
    const claimRefCount = new Map<string, number>();
    for (const f of findings) {
      const claims = Array.isArray(f.claim_ids) ? f.claim_ids : [];
      for (const cid of claims) {
        claimRefCount.set(cid, (claimRefCount.get(cid) || 0) + 1);
      }
    }
    const totalClaimIds = [...claimRefCount.values()].reduce((s, v) => s + v, 0);
    const distinctClaimIds = claimRefCount.size;
    const sharedClaimIds = [...claimRefCount.values()].filter(c => c > 1).length;
    const sharedClaimPct = distinctClaimIds > 0
      ? Math.round((sharedClaimIds / distinctClaimIds) * 100 * 10) / 10
      : 0;
    const maxFindingsPerClaim = claimRefCount.size > 0
      ? Math.max(...claimRefCount.values())
      : 0;

    // Histogram buckets: 1, 2, 3-5, 6-10, 11+
    const histBuckets = [
      { bucket: "1", min: 1, max: 1 },
      { bucket: "2", min: 2, max: 2 },
      { bucket: "3-5", min: 3, max: 5 },
      { bucket: "6-10", min: 6, max: 10 },
      { bucket: "11+", min: 11, max: Infinity },
    ];
    const histogram = histBuckets.map(({ bucket, min, max }) => ({
      bucket,
      count: [...claimRefCount.values()].filter(c => c >= min && c <= max).length,
    }));

    const sectionB = {
      totalClaimIds,
      distinctClaimIds,
      sharedClaimIds,
      sharedClaimPct,
      maxFindingsPerClaim,
      histogram,
    };

    // ── Section C: Near-Duplicate Title Clusters ──────────────────────────────
    function normalizeTitle(title: string): string {
      return title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 8) // First 8 words for clustering
        .join(" ");
    }

    const titleMap = new Map<string, number>();
    for (const f of findings) {
      const raw = f.title || "__untitled__";
      const norm = normalizeTitle(raw);
      titleMap.set(norm, (titleMap.get(norm) || 0) + 1);
    }
    const totalClusters = titleMap.size;
    const clustersWithMultiple = [...titleMap.values()].filter(c => c > 1).length;
    const sortedClusters = [...titleMap.entries()].sort((a, b) => b[1] - a[1]);
    const largestClusterSize = sortedClusters.length > 0 ? sortedClusters[0][1] : 0;
    const largestClusterLabel = sortedClusters.length > 0 ? sortedClusters[0][0] : "";
    const topClusters = sortedClusters
      .slice(0, 10)
      .map(([normalizedTitle, count]) => ({ normalizedTitle, count }));

    const sectionC = {
      totalClusters,
      clustersWithMultiple,
      largestClusterSize,
      largestClusterLabel,
      topClusters,
    };

    // ── Section D: Known Family Survival ──────────────────────────────────────
    const familyCounts = KNOWN_FAMILIES.map(fam => ({ familyName: fam.name, matchCount: 0 }));
    let uncategorizedCount = 0;

    for (const f of findings) {
      const text = `${f.title || ""} ${f.detail || ""}`;
      let matched = false;
      for (let i = 0; i < KNOWN_FAMILIES.length; i++) {
        if (KNOWN_FAMILIES[i].pattern.test(text)) {
          familyCounts[i].matchCount++;
          matched = true;
          break; // Each finding counts toward first matching family only
        }
      }
      if (!matched) uncategorizedCount++;
    }

    const families = familyCounts.map(fc => ({
      ...fc,
      pctOfTotal: findingCount > 0
        ? Math.round((fc.matchCount / findingCount) * 100 * 10) / 10
        : 0,
    }));
    const uncategorizedPct = findingCount > 0
      ? Math.round((uncategorizedCount / findingCount) * 100 * 10) / 10
      : 0;

    const sectionD = { families, uncategorizedCount, uncategorizedPct };

    // ── Section E: Funnel Stall Location ──────────────────────────────────────
    const LevelRow = z.object({
      tree_level: z.coerce.number(),
      node_count: z.coerce.number(),
      total_findings: z.coerce.number(),
    });
    const levelRows = await ctx.integrations.db.query(
      `SELECT tree_level,
              COUNT(*)::int AS node_count,
              SUM(jsonb_array_length(COALESCE(merged_json->'findings', '[]'::jsonb)))::int AS total_findings
       FROM merge_checkpoints
       WHERE module_run_id = $1
       GROUP BY tree_level
       ORDER BY tree_level ASC`,
      LevelRow,
      [resolvedRunId],
      { label: "Diag: funnel stall levels" }
    );

    const levelStats: Array<{
      treeLevel: number;
      nodeCount: number;
      totalFindings: number;
      collapseRatio: number | null;
    }> = [];

    let stallLevel: number | null = null;

    for (let i = 0; i < levelRows.length; i++) {
      const r = levelRows[i];
      const prevFindings = i > 0 ? levelRows[i - 1].total_findings : null;
      const collapseRatio = prevFindings && prevFindings > 0
        ? Math.round((r.total_findings / prevFindings) * 100) / 100
        : null;

      levelStats.push({
        treeLevel: r.tree_level,
        nodeCount: r.node_count,
        totalFindings: r.total_findings,
        collapseRatio,
      });

      // First level where ratio > 0.90 indicates stall
      if (collapseRatio !== null && collapseRatio > 0.90 && stallLevel === null) {
        stallLevel = r.tree_level;
      }
    }

    const rootFindings = levelStats.length > 0
      ? levelStats[levelStats.length - 1].totalFindings
      : 0;

    const sectionE = {
      totalLevels: levelStats.length,
      levelStats,
      stallLevel,
      rootFindings,
    };

    // ── Hypothesis Generation ─────────────────────────────────────────────────
    const hypotheses: string[] = [];

    // A: Fragmentation hypothesis
    if (singletonKeyPct > 70) {
      hypotheses.push(
        `HIGH KEY FRAGMENTATION: ${singletonKeyPct}% of issue_keys appear only once — the extraction stage is generating near-unique keys per chunk, preventing merge-round deduplication.`
      );
    } else if (singletonKeyPct > 40) {
      hypotheses.push(
        `MODERATE KEY FRAGMENTATION: ${singletonKeyPct}% singleton keys — merge can consolidate some, but many keys escape grouping.`
      );
    }

    // B: Low claim sharing
    if (sharedClaimPct < 20) {
      hypotheses.push(
        `LOW CLAIM SHARING: Only ${sharedClaimPct}% of claim IDs are referenced by more than one finding — findings may target narrow, non-overlapping evidence.`
      );
    }

    // C: Title duplication
    if (clustersWithMultiple > 0 && largestClusterSize >= 10) {
      hypotheses.push(
        `TITLE DUPLICATION: ${clustersWithMultiple} title clusters have >1 member (largest: ${largestClusterSize}) — merge may fail to collapse semantically identical findings with minor text variation.`
      );
    }

    // D: Family dominance
    const topFamily = families.sort((a, b) => b.matchCount - a.matchCount)[0];
    if (topFamily && topFamily.pctOfTotal > 40) {
      hypotheses.push(
        `FAMILY DOMINANCE: "${topFamily.familyName}" accounts for ${topFamily.pctOfTotal}% of findings — a single finding archetype is proliferating without dedup.`
      );
    }

    // E: Funnel stall
    if (stallLevel !== null) {
      hypotheses.push(
        `FUNNEL STALL at level ${stallLevel}: collapse ratio > 0.90 means merge rounds stopped reducing findings at this level — higher levels inherit inflated counts.`
      );
    }

    // Overall collapse assessment
    const leafFindings = levelStats.length > 0 ? levelStats[0].totalFindings : findingCount;
    const overallRatio = leafFindings > 0 ? rootFindings / leafFindings : 1;
    if (overallRatio > 0.80) {
      hypotheses.push(
        `OVERALL MERGE INEFFECTIVE: Root contains ${Math.round(overallRatio * 100)}% of leaf findings — the entire merge tree achieved <20% net reduction.`
      );
    }

    // Determine severity
    let severity: "low" | "medium" | "high" = "low";
    if (hypotheses.length >= 4 || singletonKeyPct > 70) {
      severity = "high";
    } else if (hypotheses.length >= 2) {
      severity = "medium";
    }

    const diagnosis = { hypotheses, severity };

    return {
      runId: resolvedRunId,
      findingCount,
      sectionA,
      sectionB,
      sectionC,
      sectionD,
      sectionE,
      diagnosis,
    };
  },
});
