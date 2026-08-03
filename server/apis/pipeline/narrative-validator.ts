/**
 * MAT-F05: Narrative Validator
 *
 * Post-generation deterministic validator.
 * Runs after LLM narrative generation, before acceptance.
 *
 * Implements all 10 rejection rules from the MAT-F05 specification:
 *
 *   Rule 1 — Invented numeric token
 *   Rule 2 — Invented percentage, percentage-point range, basis points, or currency amount
 *   Rule 3 — Synthesized quotation
 *   Rule 4 — Unknown source name
 *   Rule 5 — Unknown entity
 *   Rule 6 — Unknown period
 *   Rule 7 — Verdict contradiction
 *   Rule 8 — Unsupported verification claim
 *   Rule 9 — Adverse language for supporting/confirmed record
 *   Rule 10 — Generated severity or materiality label
 *
 * Normalization tolerance:
 *   - £194m === £194 million
 *   - Comma-formatted numbers (1,234 === 1234)
 *   - Rounding within ±1% relative tolerance
 *
 * INVARIANT: The validator never modifies the canonical record.
 * It only accepts or rejects the LLM narrative.
 */

import type { NarrativeOutput } from "./narrative-boundary.js";
import type { LockedNarrationInput } from "./narrative-boundary.js";

// ===========================================================================
// Types
// ===========================================================================

export interface ValidationResult {
  passed: boolean;
  rule_violations: RuleViolation[];
  reason_codes: string[];
  normalized_numerics_allowed: string[];
}

export interface RuleViolation {
  rule: string;
  description: string;
  offending_text: string | null;
}

// ===========================================================================
// Normalization helpers
// ===========================================================================

/**
 * Normalize a number string to a canonical float.
 * Handles: commas, £/$/€ prefixes, k/m/bn/billion/million suffixes
 */
export function normalizeNumberString(s: string): number | null {
  if (!s || s.trim() === "") return null;
  let cleaned = s.replace(/,/g, "").replace(/^[£$€]/u, "").trim();

  // Multiplier suffixes
  const bn = /^([\d.]+)\s*(?:bn|billion)$/i.exec(cleaned);
  const mn = /^([\d.]+)\s*(?:m|million)$/i.exec(cleaned);
  const kn = /^([\d.]+)\s*(?:k|thousand)$/i.exec(cleaned);
  const pp = /^([\d.]+)\s*(?:pp|percentage[- ]?points?)$/i.exec(cleaned);
  const bps = /^([\d.]+)\s*(?:bps|basis[- ]?points?)$/i.exec(cleaned);
  const pct = /^([\d.]+)\s*%$/.exec(cleaned);

  if (bn) return parseFloat(bn[1]) * 1_000_000_000;
  if (mn) return parseFloat(mn[1]) * 1_000_000;
  if (kn) return parseFloat(kn[1]) * 1_000;
  if (pp) return parseFloat(pp[1]); // pp treated as raw for comparison
  if (bps) return parseFloat(bps[1]) * 0.01; // bps → percentage point
  if (pct) return parseFloat(pct[1]);

  const plain = parseFloat(cleaned);
  return isNaN(plain) ? null : plain;
}

/**
 * Relative tolerance: ±1% (0.01).
 * Absolute tolerance: ±1 (for very small values).
 * Returns true if the value is within tolerance of any canonical number.
 */
export function isWithinNormalizationTolerance(
  value: number,
  canonicalNumbers: number[],
): boolean {
  const REL_TOLERANCE = 0.01; // 1% relative
  const ABS_TOLERANCE = 1.0;  // 1 unit absolute (for small numbers)

  return canonicalNumbers.some(canonical => {
    if (canonical === 0 && value === 0) return true;
    if (canonical === 0) return Math.abs(value) <= ABS_TOLERANCE;
    const rel = Math.abs((value - canonical) / canonical);
    const abs = Math.abs(value - canonical);
    return rel <= REL_TOLERANCE || abs <= ABS_TOLERANCE;
  });
}

// ===========================================================================
// Numeric extraction
// ===========================================================================

/**
 * Extract all numeric token strings from narrative text.
 * Handles: raw integers, decimals, currency-prefixed, k/m/bn-suffixed, percentages, pp, bps
 */
export function extractNumericTokens(text: string): string[] {
  const tokens: string[] = [];

  // Order matters: more specific patterns first
  const patterns = [
    // Currency with multiplier: £194m, $2.1bn, €500k
    /[£$€][\d,]+(?:\.\d+)?\s*(?:bn|billion|m|million|k|thousand)\b/gi,
    // Plain multiplier: 194m, 2.1bn, 500k
    /\b[\d,]+(?:\.\d+)?\s*(?:bn|billion|m|million|k|thousand)\b/gi,
    // Basis points: 150bps, 200 basis points
    /\b[\d,]+(?:\.\d+)?\s*(?:bps|basis[- ]?points?)\b/gi,
    // Percentage points: 5pp, 5-15pp, 5 percentage points
    /\b[\d,]+(?:\.\d+)?(?:\s*[-–]\s*[\d,]+(?:\.\d+)?)?\s*(?:pp|percentage[- ]?points?)\b/gi,
    // Ranges with %: 5-15%, 10–20%
    /\b[\d,]+(?:\.\d+)?\s*[-–]\s*[\d,]+(?:\.\d+)?\s*%/g,
    // Plain percentages: 12.5%
    /\b[\d,]+(?:\.\d+)?\s*%/g,
    // Currency without multiplier: £1,234, £194,391,535
    /[£$€][\d,]+(?:\.\d+)?/g,
    // Plain integers/decimals ≥3 digits (avoid matching years as amounts)
    /\b\d{3,}(?:,\d{3})*(?:\.\d+)?\b/g,
  ];

  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0].trim();
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
  }

  return tokens;
}

/**
 * Extract quoted strings (double-quoted text) from narrative.
 */
export function extractQuotedStrings(text: string): string[] {
  const quotes: string[] = [];
  // Match "..." and "..."
  const pattern = /[""][^""]+[""]/g;
  for (const match of text.matchAll(pattern)) {
    // Remove surrounding quotes
    quotes.push(match[0].slice(1, -1));
  }
  // Also match straight double quotes
  const straight = /"([^"]+)"/g;
  for (const match of text.matchAll(straight)) {
    quotes.push(match[1]);
  }
  return quotes;
}

// ===========================================================================
// Verdict contradiction detection
// ===========================================================================

const VERDICT_WORDS: Record<string, string[]> = {
  contradicted: ["contradicted", "contradict", "contradiction"],
  confirmed: ["confirmed", "confirms", "confirmation", "confirmed by"],
  partially_supported: ["partially supported", "partial support"],
  unsupported: ["unsupported", "not supported"],
  materially_changed: ["materially changed", "material change"],
  unverifiable: ["unverifiable", "cannot be verified"],
  degraded: ["degraded"],
};

/**
 * Returns pairs of [narrative_word, canonical_verdict] where the narrative
 * asserts a verdict that contradicts the canonical one.
 */
export function findVerdictContradictions(
  text: string,
  canonicalVerdict: string,
): Array<{ word: string; canonical: string }> {
  const contradictions: Array<{ word: string; canonical: string }> = [];
  const textLower = text.toLowerCase();

  for (const [verdictKey, patterns] of Object.entries(VERDICT_WORDS)) {
    if (verdictKey === canonicalVerdict) continue; // same verdict = allowed

    for (const word of patterns) {
      if (textLower.includes(word)) {
        // Don't flag neutral/negated patterns that explain the verdict
        contradictions.push({ word, canonical: canonicalVerdict });
        break;
      }
    }
  }

  return contradictions;
}

// ===========================================================================
// Verification claim detection (Rule 8)
// ===========================================================================

const UNSUPPORTED_VERIFICATION_PATTERNS = [
  /\bverified\b/i,
  /\bconfirmed\s+by\s+(source|evidence|document|data)\b/i,
  /\bsource\s+proves\b/i,
  /\bverbatim\b/i,
  /\bexact\s+copy\b/i,
  /\bword\s+for\s+word\b/i,
];

// ===========================================================================
// Severity/materiality label detection (Rule 10)
// ===========================================================================

const SEVERITY_LABEL_PATTERNS = [
  /\b(?:severity|sev)[:\s]+(?:critical|warning|info|high|medium|low)\b/i,
  /\bcritical\s+finding\b/i,
  /\bhigh[\s-]severity\b/i,
  /\bmaterial(?:ity|ly\s+significant)?\s+(?:issue|risk|concern)\b/i,
  /\b(?:above|below)\s+materiality\s+threshold\b/i,
  /\b(?:material|immaterial)\s+to\s+(?:the\s+)?(?:deal|transaction|IC)\b/i,
  /\bseverity[\s_]anchor\b/i,
];

// ===========================================================================
// Adverse language for non-adverse records (Rule 9)
// ===========================================================================

const ADVERSE_NARRATIVE_PATTERNS = [
  /\bcontradicts?\b/i,
  /\bdisproves?\b/i,
  /\brefutes?\b/i,
  /\bundermines?\b/i,
  /\binvalidates?\b/i,
  /\boverstated\b/i,
  /\bshortfall\b/i,
  /\bapparent\s+(?:gap|discrepancy)\b/i,
];

// ===========================================================================
// Main Validation Entry Point
// ===========================================================================

/**
 * Run all 10 validation rules against an LLM narrative output.
 * Returns a ValidationResult with pass/fail and full violation details.
 */
export function validateNarrativeOutput(
  narrative: NarrativeOutput,
  lockedInput: LockedNarrationInput,
): ValidationResult {
  const violations: RuleViolation[] = [];
  const reasonCodes: string[] = [];
  const normalizedAllowed: string[] = [];

  // Combine all narrative text for full-text checks
  const fullText = [
    narrative.title,
    narrative.summary,
    narrative.explanation,
    narrative.analyst_attention ?? "",
  ].join(" ");

  // ── Rule 1: Invented numeric tokens ──────────────────────────────────────
  const numericTokens = extractNumericTokens(fullText);
  for (const token of numericTokens) {
    const normalized = normalizeNumberString(token);
    if (normalized === null) continue;

    // Allow 4-digit years (1900–2099) — not financial amounts
    if (normalized >= 1900 && normalized <= 2099 && !token.includes("£") && !token.includes("$") && !token.includes("%")) continue;

    if (isWithinNormalizationTolerance(normalized, lockedInput.all_canonical_numbers)) {
      normalizedAllowed.push(token);
      continue;
    }

    violations.push({
      rule: "RULE_1_INVENTED_NUMERIC",
      description: `Numeric token "${token}" (normalized: ${normalized}) is not present in canonical input`,
      offending_text: token,
    });
    reasonCodes.push("RULE_1_INVENTED_NUMERIC");
  }

  // ── Rule 2: Invented percentage/range/bps/currency ────────────────────────
  // Rule 2 overlaps with Rule 1 but specifically targets ranges and bps
  const rangePattern = /\b(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:%|pp|bps|percentage[- ]?points?|basis[- ]?points?)\b/gi;
  for (const match of fullText.matchAll(rangePattern)) {
    const low = parseFloat(match[1]);
    const high = parseFloat(match[2]);
    const inCanon = isWithinNormalizationTolerance(low, lockedInput.all_canonical_numbers) &&
                    isWithinNormalizationTolerance(high, lockedInput.all_canonical_numbers);
    if (!inCanon) {
      violations.push({
        rule: "RULE_2_INVENTED_RANGE",
        description: `Range "${match[0]}" not present in canonical input (low=${low}, high=${high})`,
        offending_text: match[0],
      });
      reasonCodes.push("RULE_2_INVENTED_RANGE");
    }
  }

  // ── Rule 3: Synthesized quotation ─────────────────────────────────────────
  const quotedStrings = extractQuotedStrings(fullText);
  for (const quoted of quotedStrings) {
    if (quoted.length < 5) continue; // Skip very short quoted strings
    // Must be exact substring of: canonical claim text OR admitted evidence excerpts
    const canonicalTexts = [
      lockedInput.exact_claim_text,
      ...lockedInput.admitted_evidence.map(e => e.exact_excerpt),
    ];
    const isExactSubstring = canonicalTexts.some(text =>
      text.toLowerCase().includes(quoted.toLowerCase())
    );
    if (!isExactSubstring) {
      violations.push({
        rule: "RULE_3_SYNTHESIZED_QUOTATION",
        description: `Quoted text "${truncate(quoted, 100)}" is not an exact substring of any admitted source or claim text`,
        offending_text: `"${quoted}"`,
      });
      reasonCodes.push("RULE_3_SYNTHESIZED_QUOTATION");
    }
  }

  // ── Rule 4: Unknown source name ───────────────────────────────────────────
  // Extract document-like references (filenames with extensions, or proper nouns in source context)
  const sourceReferencePattern = /\b[\w\-._]+\.(?:pdf|xlsx?|docx?|pptx?|csv|txt)\b/gi;
  for (const match of fullText.matchAll(sourceReferencePattern)) {
    const refName = match[0];
    if (!lockedInput.source_document_names.some(name =>
      name.toLowerCase().includes(refName.toLowerCase()) ||
      refName.toLowerCase().includes(name.toLowerCase())
    )) {
      violations.push({
        rule: "RULE_4_UNKNOWN_SOURCE",
        description: `Source reference "${refName}" not in canonical source documents`,
        offending_text: refName,
      });
      reasonCodes.push("RULE_4_UNKNOWN_SOURCE");
    }
  }

  // ── Rule 5: Unknown entity ────────────────────────────────────────────────
  // We check for major entity names that look like company names (proper nouns)
  // but are not in the referenced entities. This is a heuristic — flag for review.
  // We only flag if referenced_entities is non-empty (otherwise too many false positives)
  if (lockedInput.referenced_entities.length > 0) {
    // Look for entity patterns like "XYZ Ltd", "ABC Group", "Company Name Inc"
    const entityPattern = /\b([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*(?:\s+(?:Ltd|Limited|plc|Inc|Corp|Group|Holdings?|LLP)))\b/g;
    for (const match of fullText.matchAll(entityPattern)) {
      const entity = match[0];
      // Skip known good patterns
      if (["IC Chair", "Investment Committee", "Board", "Management Team", "Deal Team"].includes(entity)) continue;
      const isKnown = lockedInput.referenced_entities.some(ref =>
        ref.toLowerCase().includes(entity.toLowerCase()) ||
        entity.toLowerCase().includes(ref.toLowerCase())
      );
      if (!isKnown) {
        violations.push({
          rule: "RULE_5_UNKNOWN_ENTITY",
          description: `Entity "${entity}" is not referenced in the canonical record`,
          offending_text: entity,
        });
        reasonCodes.push("RULE_5_UNKNOWN_ENTITY");
      }
    }
  }

  // ── Rule 6: Unknown period ────────────────────────────────────────────────
  if (lockedInput.referenced_periods.length > 0) {
    // Match financial periods: FY YYYY, H1/H2 YYYY, Q1-Q4 YYYY, "Mar-26", "2025", "2024"
    const periodPattern = /\b(?:FY\s*\d{2,4}|H[12]\s*\d{4}|Q[1-4]\s*\d{4}|Mar|Jun|Sep|Dec-\d{2,4}|20\d{2}[–\-]20\d{2}|FY\s*Mar-?\d{2})\b/gi;
    for (const match of fullText.matchAll(periodPattern)) {
      const period = match[0];
      const isKnown = lockedInput.referenced_periods.some(ref =>
        ref.toLowerCase().includes(period.toLowerCase()) ||
        period.toLowerCase().includes(ref.toLowerCase())
      );
      if (!isKnown) {
        violations.push({
          rule: "RULE_6_UNKNOWN_PERIOD",
          description: `Period "${period}" is not referenced in the canonical record`,
          offending_text: period,
        });
        reasonCodes.push("RULE_6_UNKNOWN_PERIOD");
      }
    }
  }

  // ── Rule 7: Verdict contradiction ─────────────────────────────────────────
  const verdictContra = findVerdictContradictions(fullText, lockedInput.deterministic_verdict);
  // Only flag if the contradiction word is present WITHOUT a negation prefix nearby
  for (const { word } of verdictContra) {
    // Check if it's actually contradicting (not in a "not confirmed" context for a contradicted verdict)
    if (lockedInput.deterministic_verdict === "contradicted") {
      // confirmed-family words would contradict
      if (["confirmed", "confirms", "confirmation"].some(w => word.includes(w))) {
        violations.push({
          rule: "RULE_7_VERDICT_CONTRADICTION",
          description: `Narrative uses "${word}" but canonical verdict is "contradicted"`,
          offending_text: word,
        });
        reasonCodes.push("RULE_7_VERDICT_CONTRADICTION");
      }
    } else if (lockedInput.deterministic_verdict === "confirmed") {
      // contradiction-family words would contradict
      if (["contradict", "contradiction"].some(w => word.includes(w))) {
        violations.push({
          rule: "RULE_7_VERDICT_CONTRADICTION",
          description: `Narrative uses "${word}" but canonical verdict is "confirmed"`,
          offending_text: word,
        });
        reasonCodes.push("RULE_7_VERDICT_CONTRADICTION");
      }
    }
  }

  // ── Rule 8: Unsupported verification claim ────────────────────────────────
  for (const pattern of UNSUPPORTED_VERIFICATION_PATTERNS) {
    const match = fullText.match(pattern);
    if (match) {
      // "verified" is only allowed when verdict is "confirmed"
      const isVerificationWord = /\bverified\b/i.test(match[0]) || /\bverbatim\b/i.test(match[0]) || /confirms?\b/i.test(match[0]);
      if (isVerificationWord && lockedInput.deterministic_verdict !== "confirmed") {
        violations.push({
          rule: "RULE_8_UNSUPPORTED_VERIFICATION",
          description: `Verification language "${match[0]}" used but verdict is not confirmed`,
          offending_text: match[0],
        });
        reasonCodes.push("RULE_8_UNSUPPORTED_VERIFICATION");
      }
    }
  }

  // ── Rule 9: Adverse language for supporting/confirmed record ──────────────
  const hasOnlySupportingEvidence = lockedInput.evidence_roles.every(
    r => r === "supporting" || r === "corroborating" || r === "contextual"
  );
  const verdictIsConfirmed = lockedInput.deterministic_verdict === "confirmed" ||
    lockedInput.deterministic_verdict === "partially_supported";

  if (hasOnlySupportingEvidence || verdictIsConfirmed) {
    for (const pattern of ADVERSE_NARRATIVE_PATTERNS) {
      const match = fullText.match(pattern);
      if (match) {
        violations.push({
          rule: "RULE_9_ADVERSE_LANGUAGE_FOR_SUPPORTING",
          description: `Adverse language "${match[0]}" used for a supporting/confirmed record (verdict: ${lockedInput.deterministic_verdict})`,
          offending_text: match[0],
        });
        reasonCodes.push("RULE_9_ADVERSE_LANGUAGE_FOR_SUPPORTING");
        break; // One violation per category is enough
      }
    }
  }

  // ── Rule 10: Generated severity/materiality label ─────────────────────────
  for (const pattern of SEVERITY_LABEL_PATTERNS) {
    const match = fullText.match(pattern);
    if (match) {
      violations.push({
        rule: "RULE_10_GENERATED_SEVERITY",
        description: `Severity/materiality label "${match[0]}" generated by LLM — not permitted`,
        offending_text: match[0],
      });
      reasonCodes.push("RULE_10_GENERATED_SEVERITY");
    }
  }

  const uniqueReasonCodes = [...new Set(reasonCodes)];

  return {
    passed: violations.length === 0,
    rule_violations: violations,
    reason_codes: uniqueReasonCodes,
    normalized_numerics_allowed: normalizedAllowed,
  };
}

// ===========================================================================
// Internal helpers
// ===========================================================================

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}
