/**
 * Executive header regeneration + source-doc resolution + untiered tier display
 *
 * GATE (frozen): every risk named in the executive header must resolve to a
 * finding in the same artifact. The header is synthesized FROM the reportable
 * finding set, so this is structural — these tests exist to keep it that way.
 */

import { describe, it, expect } from "vitest";
import {
  synthesizeExecutiveHeader,
  resolveSourceDocFilenames,
  formatCanonicalReport,
} from "../canonical-finalizer.js";

function finding(overrides: Record<string, any> = {}) {
  return {
    finding_id: `f-${Math.random().toString(36).slice(2, 8)}`,
    severity: "warning",
    title: "Some finding",
    detail: "Detail sentence one. Detail sentence two.",
    full_analysis: "Full analysis body.",
    source_docs: [],
    category: "principal_finding",
    finding_kind: "contradiction",
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Item 2 — header regeneration
// ───────────────────────────────────────────────────────────────────────────

describe("synthesizeExecutiveHeader", () => {
  const findings = [
    finding({ title: "Revenue restated between memo and model", severity: "critical", severity_anchor: "£4.2m gap in FY24 revenue" }),
    finding({ title: "Working capital assumption undisclosed", severity: "warning" }),
    finding({ title: "Headcount plan differs from model", severity: "info" }),
  ];

  const header = synthesizeExecutiveHeader(findings)!;

  it("returns null for an empty finding set (caller keeps its fallback)", () => {
    expect(synthesizeExecutiveHeader([])).toBeNull();
  });

  it("states the reportable count and severity mix", () => {
    expect(header).toContain("3 reportable findings");
    expect(header).toContain("1 critical");
    expect(header).toContain("1 warning");
    expect(header).toContain("1 informational");
  });

  it("GATE: every risk named in the header resolves to a finding", () => {
    // Each header bullet is "- **<title>** (severity) — anchor"
    const namedTitles = header
      .split("\n")
      .filter((l) => l.startsWith("- **"))
      .map((l) => l.slice(4, l.indexOf("**", 4)));

    const findingTitles = new Set(findings.map((f) => f.title));

    expect(namedTitles.length).toBe(findings.length);
    for (const named of namedTitles) {
      expect(findingTitles.has(named)).toBe(true);
    }
  });

  it("GATE: every finding is named in the header (nothing silently omitted)", () => {
    for (const f of findings) {
      expect(header).toContain(f.title);
    }
  });

  it("orders critical before warning before info", () => {
    const iCrit = header.indexOf("Revenue restated");
    const iWarn = header.indexOf("Working capital");
    const iInfo = header.indexOf("Headcount plan");
    expect(iCrit).toBeLessThan(iWarn);
    expect(iWarn).toBeLessThan(iInfo);
  });

  it("uses severity_anchor when present, falls back to first detail sentence", () => {
    expect(header).toContain("£4.2m gap in FY24 revenue");
    expect(header).toContain("Detail sentence one.");
  });

  it("does not name any risk absent from the finding set", () => {
    // The classic defect: a pre-gate header naming a dropped risk.
    expect(header).not.toContain("Diamond concentration");
    expect(header).not.toContain("interest coverage");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Item 3a — untiered display instead of three zeros
// ───────────────────────────────────────────────────────────────────────────

describe("formatCanonicalReport — untiered modules", () => {
  const untiered = [finding({ title: "A" }), finding({ title: "B" })];

  it("does not print three zero tier counts", () => {
    const report = formatCanonicalReport("Header", untiered, {});
    expect(report).not.toContain("Tier 1 (deal-relevant): 0");
    expect(report).toContain("Materiality tiers not assigned");
  });

  it("labels the sole section 'Findings', not 'Other Findings'", () => {
    const report = formatCanonicalReport("Header", untiered, {});
    expect(report).toContain("## Findings (2)");
    expect(report).not.toContain("## Other Findings");
  });

  it("still prints tier counts when tiering did run", () => {
    const tiered = [finding({ title: "T1", materiality_tier: 1 }), finding({ title: "U" })];
    const report = formatCanonicalReport("Header", tiered, {});
    expect(report).toContain("Tier 1 (deal-relevant): 1");
    // With a tiered section present, untiered residuals keep the "Other" label.
    expect(report).toContain("## Other Findings (1)");
  });

  it("surfaces severity and sources on untiered findings", () => {
    const report = formatCanonicalReport(
      "Header",
      [finding({ title: "A", severity: "critical", source_docs: ["Model.xlsx::FS Summary"] })],
      {}
    );
    expect(report).toContain("**Severity:** critical");
    expect(report).toContain("Model.xlsx::FS Summary");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Item 3b — source_docs UUID → filename resolution
// ───────────────────────────────────────────────────────────────────────────

describe("resolveSourceDocFilenames", () => {
  const DOC_A = "3ea34aa1-1111-4222-8333-444455556666";
  const DOC_B = "9bb01c22-7777-4888-8999-aaaabbbbcccc";

  function fakeDb(rows: { id: string; file_name: string }[]) {
    return { query: async () => rows };
  }

  it("replaces the UUID prefix and preserves the ::sheet suffix", async () => {
    const findings = [
      finding({ source_docs: [`${DOC_A}::FS Summary`, DOC_B] }),
    ];
    const result = await resolveSourceDocFilenames(
      fakeDb([
        { id: DOC_A, file_name: "Project Saint - Operating Model.xlsx" },
        { id: DOC_B, file_name: "IC Memo v3.pdf" },
      ]),
      "deal-1",
      findings
    );

    expect(result.resolved).toBe(2);
    expect(result.unresolved).toBe(0);
    expect(findings[0].source_docs).toEqual([
      "Project Saint - Operating Model.xlsx::FS Summary",
      "IC Memo v3.pdf",
    ]);
  });

  it("leaves already-resolved filenames untouched", async () => {
    const findings = [finding({ source_docs: ["IC Memo v3.pdf", "Model.xlsx::Rev"] })];
    const result = await resolveSourceDocFilenames(fakeDb([]), "deal-1", findings);
    expect(result).toEqual({ resolved: 0, unresolved: 0 });
    expect(findings[0].source_docs).toEqual(["IC Memo v3.pdf", "Model.xlsx::Rev"]);
  });

  it("never fabricates a name for an unresolvable UUID", async () => {
    const findings = [finding({ source_docs: [`${DOC_A}::FS Summary`] })];
    const result = await resolveSourceDocFilenames(fakeDb([]), "deal-1", findings);
    expect(result.unresolved).toBe(1);
    expect(findings[0].source_docs).toEqual([`${DOC_A}::FS Summary`]);
  });

  it("is non-fatal when the query throws", async () => {
    const findings = [finding({ source_docs: [`${DOC_A}::FS Summary`] })];
    const throwingDb = {
      query: async () => {
        throw new Error("connection reset");
      },
    };
    const result = await resolveSourceDocFilenames(throwingDb, "deal-1", findings);
    expect(result.resolved).toBe(0);
    expect(findings[0].source_docs).toEqual([`${DOC_A}::FS Summary`]);
  });
});
