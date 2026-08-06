/**
 * Diagnostic API — OA Identity-Engine Fit Test (MR-D3)
 *
 * Runs the existing canonical-issue-identity engine (built for contradiction_check)
 * against real Omission Audit findings to measure how well its numeric-axis model
 * fits OA's categorical finding population.
 *
 * Read-only: does not modify any data or production logic.
 * Calls REAL production functions — does not reimplement them.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  deriveCanonicalKey,
  groupIntoCanonicalFamilies,
  serializeCanonicalKey,
  areKeysCompatible,
} from "./canonical-issue-identity.js";
import type { CanonicalKey } from "./canonical-issue-identity.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const SCG_DEAL_ID = "c46b4129-8a16-48ae-ad3a-1da061255445";

// ─── Output Schemas ──────────────────────────────────────────────────────────

const DistEntry = z.object({ value: z.string(), count: z.number(), pct: z.number() });

const Section1Schema = z.object({
  totalFindings: z.number(),
  keysDerived: z.number(),
  keysNull: z.number(),
  keysDerivedPct: z.number(),
  unknownCounts: z.object({
    issue_domain: z.number(),
    issue_type: z.number(),
    metric: z.number(),
    period: z.number(),
    comparison_basis: z.number(),
    direction_of_difference: z.number(),
  }),
  metricUnknownPct: z.number(),
  directionUnknownPct: z.number(),
  issueDomainDistribution: z.array(DistEntry),
  issueTypeDistribution: z.array(DistEntry),
});

const LargestFamilyEntry = z.object({
  rank: z.number(),
  size: z.number(),
  canonicalKeyStr: z.string(),
  issueDomain: z.string(),
  metric: z.string(),
  period: z.string(),
});

const Section2Schema = z.object({
  familiesCreated: z.number(),
  totalInFamilies: z.number(),
  singletons: z.number(),
  ambiguous: z.number(),
  degraded: z.number(),
  projectedFindingCountAfter: z.number(),
  projectedCollapseRatio: z.number(),
  countingRule: z.string(),
  largestFamilies: z.array(LargestFamilyEntry),
});

const CompareEntry = z.object({
  engine: z.string(),
  findingsBefore: z.number(),
  findingsAfter: z.number(),
  reductionPct: z.number(),
});

const Section3Schema = z.object({
  comparisons: z.array(CompareEntry),
  mostCollapse: z.string(),
  identityEngineSingletonReason: z.string(),
});

const CanaryPairEntry = z.object({
  familyRank: z.number(),
  titleA: z.string(),
  titleB: z.string(),
  compatible: z.boolean(),
  reason: z.string(),
});

const FamilyFlagEntry = z.object({
  rank: z.number(),
  size: z.number(),
  canonicalKeyStr: z.string(),
  allMembersUnknownDomain: z.boolean(),
  warning: z.string(),
});

const Section4Schema = z.object({
  canaryPairs: z.array(CanaryPairEntry),
  familyFlags: z.array(FamilyFlagEntry),
});

const ReadoutSchema = z.object({
  projected434toN: z.number(),
  metricUnknownPct: z.number(),
  directionUnknownPct: z.number(),
  largeFamiliesOnRealIdentity: z.number(),
  largeFamiliesOnUnknownDefaults: z.number(),
  verdict: z.string(),
});

// ─── API ─────────────────────────────────────────────────────────────────────

export default api({
  name: "DiagOaIdentityFit",
  description: "Fit test of canonical-issue-identity engine on OA findings",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string().nullable().describe("Explicit run ID; if null, auto-selects largest OA run"),
  }),

  output: z.object({
    runId: z.string(),
    findingCount: z.number(),
    section1: Section1Schema,
    section2: Section2Schema,
    section3: Section3Schema,
    section4: Section4Schema,
    readout: ReadoutSchema,
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

    const rawFindings: Array<any> = Array.isArray(findingsRows[0].findings)
      ? findingsRows[0].findings
      : [];

    const findingCount = rawFindings.length;

    // Map OA findings into the shape the identity engine expects.
    // Pass null for missing fields — no fabrication.
    const mappedFindings = rawFindings.map((f: any, idx: number) => ({
      finding_id: f.finding_id || `oa_${idx}`,
      corpus_index: idx,
      title: f.title || "",
      detail: f.detail || null,
      full_analysis: f.full_analysis || null,
      severity: f.severity || null,
      source_tag: null, // OA findings don't have source_tag
      finding_kind: f.finding_kind || null,
      issue_key: f.issue_key || null,
      originating_claim_id: null,
      claim_ids: f.claim_ids || null,
      source_docs: f.source_docs || null,
      claim_type: null,
    }));

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1 — Key Derivation Fitness
    // ═══════════════════════════════════════════════════════════════════════════

    const derivedKeys: Array<{ idx: number; key: CanonicalKey | null }> = [];
    for (let i = 0; i < mappedFindings.length; i++) {
      const key = deriveCanonicalKey(mappedFindings[i]);
      derivedKeys.push({ idx: i, key });
    }

    const keysDerived = derivedKeys.filter((d) => d.key !== null).length;
    const keysNull = derivedKeys.filter((d) => d.key === null).length;
    const keysDerivedPct = findingCount > 0
      ? Math.round((keysDerived / findingCount) * 100 * 10) / 10
      : 0;

    // Count "unknown" per axis among derived keys
    const derivedOnly = derivedKeys.filter((d) => d.key !== null).map((d) => d.key!);

    const unknownCounts = {
      issue_domain: derivedOnly.filter((k) => k.issue_domain === "unknown").length,
      issue_type: derivedOnly.filter((k) => k.issue_type === "unknown").length,
      metric: derivedOnly.filter((k) => k.metric === "unknown").length,
      period: derivedOnly.filter((k) => k.period === "unknown").length,
      comparison_basis: derivedOnly.filter((k) => k.comparison_basis === "unknown").length,
      direction_of_difference: derivedOnly.filter((k) => k.direction_of_difference === "unknown").length,
    };

    const metricUnknownPct = keysDerived > 0
      ? Math.round((unknownCounts.metric / keysDerived) * 100 * 10) / 10
      : 0;
    const directionUnknownPct = keysDerived > 0
      ? Math.round((unknownCounts.direction_of_difference / keysDerived) * 100 * 10) / 10
      : 0;

    // Distribution of issue_domain
    const domainMap = new Map<string, number>();
    for (const k of derivedOnly) {
      domainMap.set(k.issue_domain, (domainMap.get(k.issue_domain) || 0) + 1);
    }
    const issueDomainDistribution = [...domainMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        count,
        pct: keysDerived > 0 ? Math.round((count / keysDerived) * 100 * 10) / 10 : 0,
      }));

    // Distribution of issue_type
    const typeMap = new Map<string, number>();
    for (const k of derivedOnly) {
      typeMap.set(k.issue_type, (typeMap.get(k.issue_type) || 0) + 1);
    }
    const issueTypeDistribution = [...typeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        count,
        pct: keysDerived > 0 ? Math.round((count / keysDerived) * 100 * 10) / 10 : 0,
      }));

    const section1 = {
      totalFindings: findingCount,
      keysDerived,
      keysNull,
      keysDerivedPct,
      unknownCounts,
      metricUnknownPct,
      directionUnknownPct,
      issueDomainDistribution,
      issueTypeDistribution,
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 2 — Grouping Outcome
    // ═══════════════════════════════════════════════════════════════════════════

    const groupResult = groupIntoCanonicalFamilies(mappedFindings);

    const familiesCreated = groupResult.families.length;
    const totalInFamilies = groupResult.families.reduce((s, f) => s + f.member_finding_ids.length, 0);
    const singletons = groupResult.singletons.length;
    const ambiguous = groupResult.ambiguous.length;
    const degraded = groupResult.degraded.length;

    // Projected count: each family = 1 representative + singletons + ambiguous + degraded
    const projectedFindingCountAfter = familiesCreated + singletons + ambiguous + degraded;
    const projectedCollapseRatio = findingCount > 0
      ? Math.round((projectedFindingCountAfter / findingCount) * 100) / 100
      : 1;

    // Top 10 largest families
    const sortedFamilies = [...groupResult.families]
      .sort((a, b) => b.member_finding_ids.length - a.member_finding_ids.length);

    const largestFamilies = sortedFamilies.slice(0, 10).map((fam, idx) => ({
      rank: idx + 1,
      size: fam.member_finding_ids.length,
      canonicalKeyStr: fam.canonical_key_str,
      issueDomain: fam.canonical_key.issue_domain,
      metric: fam.canonical_key.metric,
      period: fam.canonical_key.period,
    }));

    const section2 = {
      familiesCreated,
      totalInFamilies,
      singletons,
      ambiguous,
      degraded,
      projectedFindingCountAfter,
      projectedCollapseRatio,
      countingRule: "projected = families_created (1 representative each) + singletons + ambiguous + degraded",
      largestFamilies,
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 3 — Cross-Compare to Prior Diagnostics
    // ═══════════════════════════════════════════════════════════════════════════

    const comparisons: Array<{ engine: string; findingsBefore: number; findingsAfter: number; reductionPct: number }> = [
      {
        engine: "SCG-hardcoded (deduplicateFindings, 10 rules)",
        findingsBefore: 434,
        findingsAfter: 434 - 67, // 67 suppressed from MR-D2a section1
        reductionPct: Math.round((67 / 434) * 100 * 10) / 10,
      },
      {
        engine: "Key-normalization dry-run (MR-D2a)",
        findingsBefore: 434,
        findingsAfter: 357,
        reductionPct: Math.round(((434 - 357) / 434) * 100 * 10) / 10,
      },
      {
        engine: "Canonical-issue-identity engine (this packet)",
        findingsBefore: findingCount,
        findingsAfter: projectedFindingCountAfter,
        reductionPct: findingCount > 0
          ? Math.round(((findingCount - projectedFindingCountAfter) / findingCount) * 100 * 10) / 10
          : 0,
      },
    ];

    // Determine which produced most collapse
    const sorted = [...comparisons].sort((a, b) => b.reductionPct - a.reductionPct);
    const mostCollapse = sorted[0].engine;

    // Explain identity engine singleton reason
    const singletonDueToNullKey = keysNull;
    const identityEngineSingletonReason =
      `${keysNull} findings (${Math.round((keysNull / findingCount) * 100)}%) got null key ` +
      `(metric AND period both unknown). Of ${keysDerived} derived keys, ` +
      `${unknownCounts.metric} (${metricUnknownPct}%) have metric=unknown, ` +
      `${unknownCounts.direction_of_difference} (${directionUnknownPct}%) have direction=unknown. ` +
      `Engine requires numeric axes that OA's categorical findings rarely populate.`;

    const section3 = {
      comparisons,
      mostCollapse,
      identityEngineSingletonReason,
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 4 — Over-Merge Canary
    // ═══════════════════════════════════════════════════════════════════════════

    const canaryPairs: Array<{
      familyRank: number;
      titleA: string;
      titleB: string;
      compatible: boolean;
      reason: string;
    }> = [];

    const familyFlags: Array<{
      rank: number;
      size: number;
      canonicalKeyStr: string;
      allMembersUnknownDomain: boolean;
      warning: string;
    }> = [];

    const top10 = sortedFamilies.slice(0, 10);
    let canaryCount = 0;

    for (let fIdx = 0; fIdx < top10.length; fIdx++) {
      const fam = top10[fIdx];
      const rank = fIdx + 1;

      // Check if all members share issue_domain = "unknown"
      const allUnknownDomain = fam.canonical_key.issue_domain === "unknown";

      familyFlags.push({
        rank,
        size: fam.member_finding_ids.length,
        canonicalKeyStr: fam.canonical_key_str,
        allMembersUnknownDomain: allUnknownDomain,
        warning: allUnknownDomain
          ? "GROUPED ON ABSENCE OF SIGNAL — issue_domain=unknown, potential false identity"
          : "Grouped on real identity signal",
      });

      // Sample up to 2 pairs per family for canary (total up to 20)
      const members = fam.members;
      for (let i = 0; i < members.length && canaryCount < 20; i++) {
        for (let j = i + 1; j < members.length && canaryCount < 20; j++) {
          if (canaryCount >= 20) break;
          // Only test first 2 pairs per family to keep output bounded
          if (i > 0 || j > 1) break;

          const check = areKeysCompatible(members[i].canonical_key, members[j].canonical_key);
          canaryPairs.push({
            familyRank: rank,
            titleA: members[i].title.slice(0, 120),
            titleB: members[j].title.slice(0, 120),
            compatible: check.compatible,
            reason: check.reason,
          });
          canaryCount++;
        }
      }
    }

    const section4 = { canaryPairs, familyFlags };

    // ═══════════════════════════════════════════════════════════════════════════
    // READOUT
    // ═══════════════════════════════════════════════════════════════════════════

    const largeFamiliesOnRealIdentity = familyFlags.filter((f) => !f.allMembersUnknownDomain).length;
    const largeFamiliesOnUnknownDefaults = familyFlags.filter((f) => f.allMembersUnknownDomain).length;

    let verdict: string;
    if (keysNull / findingCount > 0.5) {
      verdict = "POOR FIT: >50% of findings cannot derive a key (metric+period both unknown). Engine designed for numeric contradictions, not categorical OA findings.";
    } else if (metricUnknownPct > 60) {
      verdict = "POOR FIT: >60% of derived keys have metric=unknown. Engine's numeric axes are sparsely populated by OA findings.";
    } else if (largeFamiliesOnUnknownDefaults > largeFamiliesOnRealIdentity) {
      verdict = "OVER-MERGE RISK: Most large families formed on unknown defaults, not real identity signal. Engine groups by absence of distinguishing data.";
    } else {
      verdict = "MODERATE FIT: Engine derives keys for some findings but numeric axes remain sparse. A categorical identity model may serve OA better.";
    }

    const readout = {
      projected434toN: projectedFindingCountAfter,
      metricUnknownPct,
      directionUnknownPct,
      largeFamiliesOnRealIdentity,
      largeFamiliesOnUnknownDefaults,
      verdict,
    };

    return {
      runId: resolvedRunId,
      findingCount,
      section1,
      section2,
      section3,
      section4,
      readout,
    };
  },
});
