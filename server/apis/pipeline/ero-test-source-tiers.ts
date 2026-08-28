/**
 * ERO v2 — Test harness for source-tier classifier
 *
 * Table-driven fixture suite for classifyTier, parsePublicationDate,
 * and applyCeiling. No integrations needed — pure functions.
 *
 * Returns full fixture table with actual-vs-expected and overall pass count.
 */
import { api, z } from "@superblocksteam/sdk-api";
import {
  classifyTier,
  parsePublicationDate,
  applyCeiling,
  type EvidenceForCeiling,
} from "./ero-source-tiers.js";

// ═══════════════════════════════════════════════════════════════════
// FIXTURE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

type TierFixture = {
  id: string;
  category: string;
  url: string;
  publisher?: string | null;
  expectedTier: 1 | 2 | 3;
  expectedReasonContains: string;
};

type DateFixture = {
  id: string;
  raw: string | null | undefined;
  expectedDate: string | null;
  expectedIsDated: boolean;
};

type CeilingFixture = {
  id: string;
  category: string;
  proposedSeverity: "critical" | "warning" | "info";
  evidence: EvidenceForCeiling[];
  expectedSeverity: "critical" | "warning" | "info";
  expectedNeedsRecheck: boolean;
  expectedReasonContains: string;
  nowMs?: number;
};

// ── Tier classification fixtures ──────────────────────────────────

const TIER_FIXTURES: TierFixture[] = [
  // ── Tier 1: Official records ────────────────────────────────────
  {
    id: "T1-01",
    category: "Tier 1: Companies House",
    url: "https://find-and-update.company-information.service.gov.uk/company/12345678/filing-history",
    expectedTier: 1,
    expectedReasonContains: "Companies House",
  },
  {
    id: "T1-02",
    category: "Tier 1: gov.uk enforcement",
    url: "https://www.ofcom.org.uk/about-ofcom/latest/bulletins/content-sanctions/decision-xyz",
    expectedTier: 1,
    expectedReasonContains: "Ofcom",
  },
  {
    id: "T1-03",
    category: "Tier 1: Court/tribunal decision",
    url: "https://www.bailii.org/ew/cases/EWHC/Ch/2024/1234.html",
    expectedTier: 1,
    expectedReasonContains: "BAILII",
  },
  {
    id: "T1-04",
    category: "Tier 1: NHS publication",
    url: "https://digital.nhs.uk/data-and-information/publications/statistical/appointments-in-general-practice",
    expectedTier: 1,
    expectedReasonContains: "NHS",
  },
  {
    id: "T1-05",
    category: "Tier 1: SEC filing",
    url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=acme&type=10-K",
    expectedTier: 1,
    expectedReasonContains: "SEC",
  },
  {
    id: "T1-06",
    category: "Tier 1: gov.uk generic",
    url: "https://www.data.gov.uk/dataset/some-dataset?format=csv&page=2",
    expectedTier: 1,
    expectedReasonContains: "gov.uk",
  },
  {
    id: "T1-07",
    category: "Tier 1: FCA register",
    url: "https://register.fca.org.uk/s/firm?id=001b000000MfNPHAA3",
    expectedTier: 1,
    expectedReasonContains: "FCA",
  },
  {
    id: "T1-08",
    category: "Tier 1: Companies House beta",
    url: "https://beta.companieshouse.gov.uk/company/SC123456",
    expectedTier: 1,
    expectedReasonContains: "Companies House",
  },

  // ── Tier 2: Established press ───────────────────────────────────
  {
    id: "T2-01",
    category: "Tier 2: Financial press (FT)",
    url: "https://www.ft.com/content/abc123-some-article-slug",
    publisher: "John Smith, Financial Times",
    expectedTier: 2,
    expectedReasonContains: "Financial Times",
  },
  {
    id: "T2-02a",
    category: "Tier 2: Company IR with publisher signal",
    url: "https://www.acme-corp.com/investors/press-releases/q3-results",
    publisher: "Investor Relations — Acme Corp plc",
    expectedTier: 2,
    expectedReasonContains: "corporate/IR source",
  },
  {
    id: "T2-02b",
    category: "Tier 3: Company IR path WITHOUT publisher signal",
    url: "https://www.acme-corp.com/investors/press-releases/q3-results",
    publisher: null,
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "T2-03",
    category: "Tier 2: BBC News",
    url: "https://www.bbc.co.uk/news/business-12345678",
    expectedTier: 2,
    expectedReasonContains: "BBC",
  },
  {
    id: "T2-04",
    category: "Tier 2: Publisher IR signal",
    url: "https://www.unknown-company.com/about/our-story",
    publisher: "Investor Relations - Unknown Company plc",
    expectedTier: 2,
    expectedReasonContains: "corporate/IR source",
  },
  {
    id: "T2-05",
    category: "Tier 2: Reuters",
    url: "https://www.reuters.com/business/some-article-2024",
    expectedTier: 2,
    expectedReasonContains: "Reuters",
  },
  {
    id: "T2-06",
    category: "Tier 2: Trade press (Comms Dealer)",
    url: "https://www.commsdealer.com/article/123456/channel-roundup",
    expectedTier: 2,
    expectedReasonContains: "Comms Dealer",
  },

  // ── Tier 3: Everything else ─────────────────────────────────────
  {
    id: "T3-01",
    category: "Tier 3: Content farm",
    url: "https://www.businesswire-summary-ai.com/press-release/acme-acquires-widget",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "T3-02",
    category: "Tier 3: Blog",
    url: "https://random-telecoms-blog.wordpress.com/2023/05/01/analysis-of-market",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "T3-03",
    category: "Tier 3: Forum thread",
    url: "https://forums.somesite.com/thread/12345-company-discussion",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "T3-04",
    category: "Tier 3: Press wire no primary",
    url: "https://www.prnewswire.com/news-releases/acme-announces-results-12345.html",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },

  // ── ADVERSARIAL ─────────────────────────────────────────────────
  {
    id: "ADV-01",
    category: "Adversarial: 'gov' substring trap",
    url: "https://www.govinda-insights.blogspot.com/2024/01/company-analysis",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-02",
    category: "Adversarial: 'gov' in domain name, not TLD",
    url: "https://govreports.co.uk/companies-house-data/12345",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-03",
    category: "Adversarial: real gov domain with messy path/query",
    url: "https://www.gov.uk/government/publications/some-doc?utm_source=email&utm_medium=newsletter&ref=abc#section-3",
    expectedTier: 1,
    expectedReasonContains: "gov.uk",
  },
  {
    id: "ADV-04",
    category: "Adversarial: companieshouse lookalike",
    url: "https://fakecompanieshouse.com/company/12345678",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-05",
    category: "Adversarial: evilgov.uk (not a real gov domain)",
    url: "https://evilgov.uk/enforcement/notice/12345",
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-06",
    category: "Adversarial: subdomain.gov.uk (legitimate gov subdomain)",
    url: "https://assets.publishing.service.gov.uk/media/abc123/document.pdf",
    expectedTier: 1,
    expectedReasonContains: "gov.uk",
  },

  // ── ADVERSARIAL: Path-heuristic removal (Packet 4.1-fix) ───────
  {
    id: "ADV-07",
    category: "Adversarial: content-farm with /investor-news path",
    url: "https://businesswire-summary-ai.com/investor-news/acme",
    publisher: null,
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-08",
    category: "Adversarial: blog with /investors path",
    url: "https://randomblog.wordpress.com/investors/post",
    publisher: null,
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
  {
    id: "ADV-09",
    category: "Adversarial: corporate IR page WITH publisher signal → Tier 2",
    url: "https://megacorp.com/investor-relations/annual-report",
    publisher: "Press Release — MegaCorp Investor Relations",
    expectedTier: 2,
    expectedReasonContains: "corporate/IR source",
  },
  {
    id: "ADV-10",
    category: "Adversarial: corporate IR page WITHOUT publisher signal → Tier 3",
    url: "https://megacorp.com/investor-relations/annual-report",
    publisher: null,
    expectedTier: 3,
    expectedReasonContains: "no official/press pattern matched",
  },
];

// ── Date parsing fixtures ─────────────────────────────────────────

const DATE_FIXTURES: DateFixture[] = [
  { id: "D-01", raw: "2024-03-15", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-02", raw: "15/03/2024", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-03", raw: "15 March 2024", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-04", raw: "March 15, 2024", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-05", raw: "15 Mar 2024", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-06", raw: "2024-03-15T10:30:00Z", expectedDate: "2024-03-15", expectedIsDated: true },
  { id: "D-07", raw: null, expectedDate: null, expectedIsDated: false },
  { id: "D-08", raw: "", expectedDate: null, expectedIsDated: false },
  { id: "D-09", raw: "sometime last year", expectedDate: null, expectedIsDated: false },
  { id: "D-10", raw: undefined, expectedDate: null, expectedIsDated: false },
  { id: "D-11", raw: "01-06-2023", expectedDate: "2023-06-01", expectedIsDated: true },
  { id: "D-12", raw: "2024-13-01", expectedDate: null, expectedIsDated: false },  // invalid month
];

// ── applyCeiling fixtures ─────────────────────────────────────────
// Use a fixed "now" for deterministic age calculations: 2026-06-15T00:00:00Z
const FIXED_NOW = new Date("2026-06-15T00:00:00Z").getTime();

const CEILING_FIXTURES: CeilingFixture[] = [
  {
    id: "C-01",
    category: "Tier-1 dated → critical allowed",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2026-01-15", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "critical",
    expectedNeedsRecheck: false,
    expectedReasonContains: "tier-1 source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-02",
    category: "Tier-2 only → warning cap",
    proposedSeverity: "critical",
    evidence: [
      { tier: 2, isDated: true, publicationDate: "2026-03-01", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "warning",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no dated Tier-1 source, best is dated Tier-2",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-03",
    category: "Tier-3 only → info cap",
    proposedSeverity: "warning",
    evidence: [
      { tier: 3, isDated: true, publicationDate: "2026-02-01", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "best dated source is Tier-3",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-04",
    category: "Mixed tier-1 + tier-3 → tier-1 governs",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2026-01-10", isEnforcementOrLitigation: false },
      { tier: 3, isDated: true, publicationDate: "2026-01-11", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "critical",
    expectedNeedsRecheck: false,
    expectedReasonContains: "tier-1 source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-05",
    category: "Empty evidence → fail closed",
    proposedSeverity: "critical",
    evidence: [],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no admissible evidence",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-06",
    category: "Undated-only Tier-1 → info cap (no dated source)",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no dated source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-07",
    category: "Stale enforcement (>24mo) on Tier-1 → info + recheck",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2023-01-15", isEnforcementOrLitigation: true },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: true,
    expectedReasonContains: "stale enforcement/litigation",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-08",
    category: "Recent enforcement on Tier-1 → critical allowed",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2026-03-01", isEnforcementOrLitigation: true },
    ],
    expectedSeverity: "critical",
    expectedNeedsRecheck: false,
    expectedReasonContains: "tier-1 source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-09",
    category: "Proposed info stays info even with Tier-1",
    proposedSeverity: "info",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2026-01-15", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "proposed info within ceiling",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-10",
    category: "Undated Tier-2 press → info cap (no dated source)",
    proposedSeverity: "warning",
    evidence: [
      { tier: 2, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no dated source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "C-11",
    category: "Proposed warning on Tier-2 → warning allowed",
    proposedSeverity: "warning",
    evidence: [
      { tier: 2, isDated: true, publicationDate: "2026-05-01", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "warning",
    expectedNeedsRecheck: false,
    expectedReasonContains: "proposed warning within ceiling",
    nowMs: FIXED_NOW,
  },

  // ═══════════════════════════════════════════════════════════════
  // R2 REGRESSION CASES — best-source ceiling
  // ═══════════════════════════════════════════════════════════════
  {
    id: "R2-01",
    category: "PSTN regression: 1 dated T1 + 5 undated T1 → critical (undated never lowers)",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2026-02-01", isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "critical",
    expectedNeedsRecheck: false,
    expectedReasonContains: "dated Tier-1 source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "R2-02",
    category: "Only undated sources (any tier) → info",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 2, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
      { tier: 3, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no dated source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "R2-03",
    category: "1 dated T2 + undated T1 → warning (dated T2 earns warning; undated T1 cannot earn critical)",
    proposedSeverity: "critical",
    evidence: [
      { tier: 2, isDated: true, publicationDate: "2026-04-01", isEnforcementOrLitigation: false },
      { tier: 1, isDated: false, publicationDate: null, isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "warning",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no dated Tier-1 source, best is dated Tier-2",
    nowMs: FIXED_NOW,
  },
  {
    id: "R2-04",
    category: "1 dated T1 stale enforcement only → info + needs_recheck",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2022-06-01", isEnforcementOrLitigation: true },
    ],
    expectedSeverity: "info",
    expectedNeedsRecheck: true,
    expectedReasonContains: "stale enforcement/litigation",
    nowMs: FIXED_NOW,
  },
  {
    id: "R2-05",
    category: "1 stale enforcement T1 + 1 fresh non-enforcement T1 → critical (fresh wins)",
    proposedSeverity: "critical",
    evidence: [
      { tier: 1, isDated: true, publicationDate: "2022-06-01", isEnforcementOrLitigation: true },
      { tier: 1, isDated: true, publicationDate: "2026-05-01", isEnforcementOrLitigation: false },
    ],
    expectedSeverity: "critical",
    expectedNeedsRecheck: false,
    expectedReasonContains: "dated Tier-1 source present",
    nowMs: FIXED_NOW,
  },
  {
    id: "R2-06",
    category: "Empty evidence → fail closed (info, no recheck)",
    proposedSeverity: "critical",
    evidence: [],
    expectedSeverity: "info",
    expectedNeedsRecheck: false,
    expectedReasonContains: "no admissible evidence",
    nowMs: FIXED_NOW,
  },
];

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "EroTestSourceTiers",
  description: "Fixture-driven test suite for ERO source-tier classifier",

  integrations: {},

  input: z.object({}),

  output: z.object({
    summary: z.object({
      totalFixtures: z.number(),
      passed: z.number(),
      failed: z.number(),
      allPassed: z.boolean(),
    }),
    tierResults: z.array(z.object({
      id: z.string(),
      category: z.string(),
      input: z.string(),
      expectedTier: z.number(),
      actualTier: z.number(),
      actualReason: z.string(),
      expectedReasonContains: z.string(),
      tierMatch: z.boolean(),
      reasonMatch: z.boolean(),
      passed: z.boolean(),
    })),
    dateResults: z.array(z.object({
      id: z.string(),
      input: z.string(),
      expectedDate: z.string().nullable(),
      actualDate: z.string().nullable(),
      expectedIsDated: z.boolean(),
      actualIsDated: z.boolean(),
      passed: z.boolean(),
    })),
    ceilingResults: z.array(z.object({
      id: z.string(),
      category: z.string(),
      proposedSeverity: z.string(),
      evidenceSummary: z.string(),
      expectedSeverity: z.string(),
      actualSeverity: z.string(),
      expectedNeedsRecheck: z.boolean(),
      actualNeedsRecheck: z.boolean(),
      actualReason: z.string(),
      expectedReasonContains: z.string(),
      severityMatch: z.boolean(),
      recheckMatch: z.boolean(),
      reasonMatch: z.boolean(),
      passed: z.boolean(),
    })),
  }),

  async run() {
    // ── Run tier fixtures ───────────────────────────────────────────
    const tierResults = TIER_FIXTURES.map((f) => {
      const result = classifyTier(f.url, f.publisher);
      const tierMatch = result.tier === f.expectedTier;
      const reasonMatch = result.reason
        .toLowerCase()
        .includes(f.expectedReasonContains.toLowerCase());
      return {
        id: f.id,
        category: f.category,
        input: f.url + (f.publisher ? ` [pub: "${f.publisher}"]` : ""),
        expectedTier: f.expectedTier,
        actualTier: result.tier,
        actualReason: result.reason,
        expectedReasonContains: f.expectedReasonContains,
        tierMatch,
        reasonMatch,
        passed: tierMatch && reasonMatch,
      };
    });

    // ── Run date fixtures ───────────────────────────────────────────
    const dateResults = DATE_FIXTURES.map((f) => {
      const result = parsePublicationDate(f.raw);
      const dateMatch = result.date === f.expectedDate;
      const datedMatch = result.isDated === f.expectedIsDated;
      return {
        id: f.id,
        input: f.raw === null ? "null" : f.raw === undefined ? "undefined" : `"${f.raw}"`,
        expectedDate: f.expectedDate,
        actualDate: result.date,
        expectedIsDated: f.expectedIsDated,
        actualIsDated: result.isDated,
        passed: dateMatch && datedMatch,
      };
    });

    // ── Run ceiling fixtures ────────────────────────────────────────
    const ceilingResults = CEILING_FIXTURES.map((f) => {
      const result = applyCeiling(f.proposedSeverity, f.evidence, f.nowMs);
      const severityMatch = result.severity === f.expectedSeverity;
      const recheckMatch = result.needsRecheck === f.expectedNeedsRecheck;
      const reasonMatch = result.ceilingReason
        .toLowerCase()
        .includes(f.expectedReasonContains.toLowerCase());

      const evidenceSummary = f.evidence.length === 0
        ? "[]"
        : f.evidence
            .map(
              (e) =>
                `T${e.tier}${e.isDated ? "" : "/undated"}${
                  e.isEnforcementOrLitigation ? "/enforcement" : ""
                }${e.publicationDate ? `@${e.publicationDate}` : ""}`,
            )
            .join(", ");

      return {
        id: f.id,
        category: f.category,
        proposedSeverity: f.proposedSeverity,
        evidenceSummary,
        expectedSeverity: f.expectedSeverity,
        actualSeverity: result.severity,
        expectedNeedsRecheck: f.expectedNeedsRecheck,
        actualNeedsRecheck: result.needsRecheck,
        actualReason: result.ceilingReason,
        expectedReasonContains: f.expectedReasonContains,
        severityMatch,
        recheckMatch,
        reasonMatch,
        passed: severityMatch && recheckMatch && reasonMatch,
      };
    });

    // ── Summary ─────────────────────────────────────────────────────
    const allResults = [
      ...tierResults.map((r) => r.passed),
      ...dateResults.map((r) => r.passed),
      ...ceilingResults.map((r) => r.passed),
    ];
    const passed = allResults.filter(Boolean).length;
    const failed = allResults.length - passed;

    return {
      summary: {
        totalFixtures: allResults.length,
        passed,
        failed,
        allPassed: failed === 0,
      },
      tierResults,
      dateResults,
      ceilingResults,
    };
  },
});
