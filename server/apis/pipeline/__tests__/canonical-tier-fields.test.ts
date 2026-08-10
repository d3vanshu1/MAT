/**
 * Round-trip test: materiality tier fields + cross_version finding_kind
 *
 * Proves that the six previously-dropped fields survive parseCanonicalFindings
 * in reload mode without generating any invalid entries.
 *
 * Run via: npx vitest run server/apis/pipeline/__tests__/canonical-tier-fields.test.ts
 */
import { describe, it, expect } from "vitest";
import { parseCanonicalFindings } from "../canonical-finding.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const FULL_FINDING = {
  finding_id: VALID_UUID,
  severity: "high",
  title: "Revenue recognition mismatch across model versions",
  detail: "The Q3 revenue figure in v2 differs from v1 by £1.2m without explanation.",
  full_analysis: "Detailed cross-version analysis showing revenue divergence...",
  source_docs: ["memo_v1.pdf", "memo_v2.pdf"],
  // --- The six fields under test ---
  finding_kind: "cross_version",
  materiality_tier: 1,
  tier_rationale: "Direct P&L impact exceeding £500k threshold",
  tier_driver: "revenue_recognition",
  consolidated_analyses: ["analysis_001", "analysis_002"],
  absence_verification: "memo_absent_confirmed",
};

const FINDING_WITH_INVALID_ABSENCE = {
  ...FULL_FINDING,
  finding_id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  absence_verification: "not_a_real_value",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canonical-tier-fields round-trip", () => {
  it("preserves all six tier/kind fields through reload parse", () => {
    const result = parseCanonicalFindings([FULL_FINDING], {
      mode: "reload",
      source: "test",
    });

    expect(result.invalid.length).toBe(0);
    expect(result.malformed_count).toBe(0);
    expect(result.findings.length).toBe(1);

    const f = result.findings[0];
    expect(f.finding_kind).toBe("cross_version");
    expect(f.materiality_tier).toBe(1);
    expect(f.tier_rationale).toBe("Direct P&L impact exceeding £500k threshold");
    expect(f.tier_driver).toBe("revenue_recognition");
    expect(f.consolidated_analyses).toEqual(["analysis_001", "analysis_002"]);
    expect(f.absence_verification).toBe("memo_absent_confirmed");
  });

  it("invalid absence_verification value results in undefined without invalidating finding", () => {
    const result = parseCanonicalFindings([FINDING_WITH_INVALID_ABSENCE], {
      mode: "reload",
      source: "test",
    });

    expect(result.invalid.length).toBe(0);
    expect(result.malformed_count).toBe(0);
    expect(result.findings.length).toBe(1);

    const f = result.findings[0];
    // The invalid enum value is silently dropped — field becomes undefined
    expect(f.absence_verification).toBeUndefined();
    // All other fields still survive
    expect(f.finding_kind).toBe("cross_version");
    expect(f.materiality_tier).toBe(1);
    expect(f.tier_rationale).toBe("Direct P&L impact exceeding £500k threshold");
    expect(f.tier_driver).toBe("revenue_recognition");
    expect(f.consolidated_analyses).toEqual(["analysis_001", "analysis_002"]);
  });
});
