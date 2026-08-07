/**
 * MG-5 — formatCanonicalReport renders by materiality tier
 *
 * Synthetic findings: 2 tier-1, 1 tier-2, 3 tier-3, 1 framing-challenge, 1 untiered.
 * Assertions:
 *   - Header tier counts correct
 *   - Tier 1 heading with (2)
 *   - Both tier-1 rationales present
 *   - Tier 2 heading with (1)
 *   - Tier 3 heading with (3), compact format (no full_analysis/evidence)
 *   - Framing Challenges heading with (1) + preamble
 *   - Other Findings heading with (1)
 *   - Tier 3 section does NOT contain full_analysis or evidence keywords from tier-3 findings
 */
import { describe, it, expect } from "vitest";
import { formatCanonicalReport } from "../canonical-finalizer.js";

// ─── Synthetic findings ──────────────────────────────────────────────────────

const tier1a = {
  title: "Revenue Recognition Mismatch",
  materiality_tier: 1,
  tier_rationale: "Overstates EBITDA by 12% in target year",
  tier_driver: "valuation multiple",
  detail: "The memo reports EBITDA of $42M, but source schedules sum to $37.1M.",
  full_analysis: "Detailed walkthrough of schedule C vs reported EBITDA.",
  evidence: [
    { verbatim_snippet: "Schedule C total: $37,100,000" },
    { figure: "Exhibit 4.2" },
  ],
};

const tier1b = {
  title: "Working Capital Adjustment Omitted",
  materiality_tier: 1,
  tier_rationale: "Could shift purchase price by $5M",
  tier_driver: "closing mechanics",
  detail: "No WC peg disclosed despite asset-heavy balance sheet.",
  full_analysis: "Full analysis of WC treatment in comparable transactions.",
  evidence: ["Balance sheet note 3.1"],
};

const tier2a = {
  title: "Customer Concentration Risk",
  materiality_tier: 2,
  tier_rationale: "Top customer = 34% of revenue, no backup disclosed",
  tier_driver: "revenue durability",
  detail: "Single customer concentration exceeds typical thresholds.",
  full_analysis: "Revenue breakdown by customer for FY22-24.",
  evidence: [{ verbatim_snippet: "Customer A: 34.2% of total revenue" }],
};

const tier3a = {
  title: "Minor Lease Disclosure Gap",
  materiality_tier: 3,
  tier_rationale: "Immaterial short-term leases not itemized",
  detail: "Short-term leases under $50k not individually listed.",
  full_analysis: "SHOULD NOT APPEAR IN REPORT — tier 3 is compact.",
  evidence: ["lease_schedule_page_7"],
};

const tier3b = {
  title: "Depreciation Method Note",
  materiality_tier: 3,
  tier_rationale: "Straight-line vs MACRS difference is sub-1% of EBITDA",
  detail: "Depreciation method difference is immaterial.",
  full_analysis: "SHOULD NOT APPEAR — TIER 3 COMPACT ONLY",
  evidence: [{ verbatim_snippet: "SHOULD NOT APPEAR" }],
};

const tier3c = {
  title: "Payroll Tax Timing",
  materiality_tier: 3,
  tier_rationale: "Quarterly accrual timing, no dollar impact",
  detail: "Payroll taxes accrued Q4 vs Q1.",
  full_analysis: "NO FULL ANALYSIS IN TIER 3 OUTPUT",
  evidence: ["payroll_exhibit_9"],
};

const framingChallenge = {
  title: "Gross Margin Presented Net of One-Time Credits",
  absence_verification: "memo_disclosure_uncertain",
  materiality_tier: 2, // tier is set but classification should be framing-challenge first
  tier_rationale: "Memo shows 62% GM but includes $3M one-time vendor credit",
  tier_driver: "margin sustainability",
  detail: "Gross margin as presented includes non-recurring vendor credits.",
  full_analysis: "Strip credits: adjusted GM is 58.4%.",
};

const untiered = {
  title: "Appendix Formatting Inconsistency",
  detail: "Page numbering restarts at Appendix B.",
  full_analysis: "Minor formatting — no dollar impact.",
  evidence: ["appendix_b_page_1"],
};

const allFindings = [tier1a, tier3a, framingChallenge, tier2a, tier1b, tier3b, untiered, tier3c];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("formatCanonicalReport — tier-based rendering (MG-5)", () => {
  const report = formatCanonicalReport(
    "This report covers the SCG deal diligence.",
    allFindings,
    { degradedConditions: ["LLM fallback used for 2 extractions"], excludedCount: 4 }
  );

  it("header shows correct tier counts", () => {
    expect(report).toContain("Tier 1 (deal-relevant): 2");
    expect(report).toContain("Tier 2: 1");
    expect(report).toContain("Tier 3: 3");
  });

  it("total reportable findings count is correct", () => {
    // 8 total findings
    expect(report).toContain("**8 reportable findings**");
  });

  it("Tier 1 section heading with count 2", () => {
    expect(report).toContain("## Tier 1 — Potentially Deal-Relevant (2)");
  });

  it("Tier 1 includes both rationales prominently", () => {
    expect(report).toContain("> **Why this matters:** Overstates EBITDA by 12% in target year");
    expect(report).toContain("> **Why this matters:** Could shift purchase price by $5M");
  });

  it("Tier 1 includes tier_driver as Affects blockquote", () => {
    expect(report).toContain("> **Affects:** valuation multiple");
    expect(report).toContain("> **Affects:** closing mechanics");
  });

  it("Tier 1 includes full_analysis content", () => {
    expect(report).toContain("Detailed walkthrough of schedule C vs reported EBITDA.");
    expect(report).toContain("Full analysis of WC treatment in comparable transactions.");
  });

  it("Tier 1 includes evidence", () => {
    expect(report).toContain("Schedule C total: $37,100,000");
    expect(report).toContain("Balance sheet note 3.1");
  });

  it("Tier 2 section heading with count 1", () => {
    expect(report).toContain("## Tier 2 — Worth a Condition or Follow-Up (1)");
  });

  it("Tier 2 contains the customer concentration finding", () => {
    expect(report).toContain("### Customer Concentration Risk");
    expect(report).toContain("Top customer = 34% of revenue");
  });

  it("Tier 3 section heading with count 3", () => {
    expect(report).toContain("## Tier 3 — Noted (3)");
  });

  it("Tier 3 uses compact bullet format (title + rationale only)", () => {
    expect(report).toContain("- **Minor Lease Disclosure Gap** — Immaterial short-term leases not itemized");
    expect(report).toContain("- **Depreciation Method Note** — Straight-line vs MACRS difference is sub-1% of EBITDA");
    expect(report).toContain("- **Payroll Tax Timing** — Quarterly accrual timing, no dollar impact");
  });

  it("Tier 3 does NOT contain full_analysis from tier-3 findings", () => {
    // Extract just the Tier 3 section
    const tier3Start = report.indexOf("## Tier 3 — Noted");
    const tier3End = report.indexOf("##", tier3Start + 10); // next ## heading
    const tier3Section = report.slice(tier3Start, tier3End > tier3Start ? tier3End : undefined);

    expect(tier3Section).not.toContain("SHOULD NOT APPEAR IN REPORT");
    expect(tier3Section).not.toContain("SHOULD NOT APPEAR — TIER 3 COMPACT ONLY");
    expect(tier3Section).not.toContain("NO FULL ANALYSIS IN TIER 3 OUTPUT");
    expect(tier3Section).not.toContain("lease_schedule_page_7");
    expect(tier3Section).not.toContain("payroll_exhibit_9");
  });

  it("Framing Challenges section heading with count 1", () => {
    expect(report).toContain("## Challenges to the Memo's Figures (1)");
  });

  it("Framing Challenges section has preamble", () => {
    expect(report).toContain("not omissions");
    expect(report).toContain("Verify against source");
  });

  it("Framing challenge finding classified by absence_verification, not tier", () => {
    // Should NOT be in Tier 2 even though materiality_tier=2
    const tier2Start = report.indexOf("## Tier 2 — Worth a Condition");
    const tier2End = report.indexOf("##", tier2Start + 10);
    const tier2Section = report.slice(tier2Start, tier2End > tier2Start ? tier2End : undefined);
    expect(tier2Section).not.toContain("Gross Margin Presented Net of One-Time Credits");

    // Should be in Framing Challenges section
    const fcStart = report.indexOf("## Challenges to the Memo");
    const fcEnd = report.indexOf("##", fcStart + 10);
    const fcSection = report.slice(fcStart, fcEnd > fcStart ? fcEnd : undefined);
    expect(fcSection).toContain("Gross Margin Presented Net of One-Time Credits");
  });

  it("Other Findings heading with count 1 (untiered)", () => {
    expect(report).toContain("## Other Findings (1)");
  });

  it("Other Findings contains the untiered finding", () => {
    expect(report).toContain("### Appendix Formatting Inconsistency");
  });

  it("Executive Summary section present", () => {
    expect(report).toContain("## Executive Summary");
    expect(report).toContain("This report covers the SCG deal diligence.");
  });

  it("Operational disclosures footer present", () => {
    expect(report).toContain("---");
    expect(report).toContain("Operational Disclosures");
    expect(report).toContain("LLM fallback used for 2 extractions");
    expect(report).toContain("4 diagnostic record(s) excluded from substantive findings.");
  });
});
