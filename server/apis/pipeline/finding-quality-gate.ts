/**
 * Finding Quality Gate — Ship Packet v2
 *
 * Three gates that every CC finding must pass before publication:
 *
 *   1.1  Wording lint    — no verdict words in rendered text
 *   1.2  Alt explanation — every finding must carry an innocent reason
 *   1.3  Immutability    — hash at generation, nothing downstream edits
 *
 * All gates are pure functions operating on the finding object.
 * A finding that fails any gate is dropped (not softened) and logged.
 */

// ---------------------------------------------------------------------------
// 1.1 — Wording lint
// ---------------------------------------------------------------------------

/** Words that read as verdicts. Case-insensitive, word-boundary matched. */
const BANNED_WORDS = [
  "overstates",
  "understates",
  "wrong",
  "incorrect",
  "misleading",
  "contradicts",
  "error",
  "misrepresents",
  "fails to",
];

/** Pre-compiled pattern for performance. */
const BANNED_PATTERN = new RegExp(
  "\\b(" + BANNED_WORDS.map(w => w.replace(/\s+/g, "\\s+")).join("|") + ")\\b",
  "i",
);

/** Suggested replacements for common verdict words. */
const REPLACEMENTS: Record<string, string> = {
  overstates: "differs from",
  understates: "differs from",
  wrong: "does not tie",
  incorrect: "does not tie",
  misleading: "appears to be on a different basis",
  contradicts: "does not tie to",
  error: "discrepancy",
  misrepresents: "does not match",
  "fails to": "does not",
};

export interface WordingLintResult {
  passed: boolean;
  violations: Array<{ word: string; field: string; suggestion: string }>;
}

/**
 * Check all text fields of a finding for banned verdict words.
 * Returns violations with suggested replacements.
 */
export function lintFindingWording(
  fields: Record<string, string | null | undefined>,
): WordingLintResult {
  const violations: WordingLintResult["violations"] = [];

  for (const [fieldName, text] of Object.entries(fields)) {
    if (!text) continue;
    // Check each banned word individually for precise violation reporting
    for (const banned of BANNED_WORDS) {
      const pattern = new RegExp(
        "\\b(" + banned.replace(/\s+/g, "\\s+") + ")\\b",
        "gi",
      );
      if (pattern.test(text)) {
        violations.push({
          word: banned,
          field: fieldName,
          suggestion: REPLACEMENTS[banned] ?? "(rephrase as open item)",
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Auto-fix banned words in a text string by replacing with safe alternatives.
 * Returns the cleaned text. Used as a fallback when the LLM generated
 * verdict language — prefer fixing at generation, but catch at render.
 */
export function cleanVerdictLanguage(text: string): string {
  let cleaned = text;
  for (const [banned, replacement] of Object.entries(REPLACEMENTS)) {
    const pattern = new RegExp(
      "\\b(" + banned.replace(/\s+/g, "\\s+") + ")\\b",
      "gi",
    );
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// 1.2 — Alternative explanation
// ---------------------------------------------------------------------------

export type FindingCheckType =
  | "data_divergence"
  | "cross_version"
  | "does_not_foot"
  | "basis_divergence"
  | "internal_inconsistency";

/**
 * Generate an alternative (innocent) explanation for a finding.
 * Returns null if no credible explanation can be generated — the finding
 * must not publish in that case.
 *
 * Each check type has its own generator. The explanation goes into the
 * finding's existing narrative field as the last sentence.
 */
export function generateAlternativeExplanation(
  checkType: FindingCheckType,
  context: {
    metricA?: string;
    metricB?: string;
    periodA?: string;
    periodB?: string;
    docA?: string;
    docB?: string;
    deltaAbs?: number;
    deltaPct?: number;
  },
): string | null {
  switch (checkType) {
    case "data_divergence":
      // Two documents, same coordinate, different values
      if (context.docA && context.docB) {
        return (
          "**Alternative explanation:** The two documents may be on different " +
          "accounting bases (e.g. reported vs adjusted, or pre- vs post-normalisation), " +
          "in which case both figures are correct within their own convention."
        );
      }
      return (
        "**Alternative explanation:** The difference may reflect a basis or " +
        "convention difference rather than an error in either document."
      );

    case "cross_version":
      return (
        "**Alternative explanation:** One document may have been updated after " +
        "the other was finalised, in which case the later version supersedes."
      );

    case "does_not_foot":
      return (
        "**Alternative explanation:** The apparent gap may be a footnoted " +
        "adjustment, a rounding convention, or a line item excluded from the " +
        "subtotal by design."
      );

    case "basis_divergence":
      return (
        "**Alternative explanation:** The memo may be quoting a different case " +
        "(e.g. management vs risk-adjusted) or a different accounting basis " +
        "(e.g. reported vs sell-side QofE), in which case both figures are " +
        "correct within their respective conventions."
      );

    case "internal_inconsistency":
      return (
        "**Alternative explanation:** The two citations may refer to different " +
        "scopes, time periods or definitions that are not apparent from the " +
        "extracted text alone."
      );

    default:
      // Unknown check type — cannot generate a credible explanation
      return null;
  }
}

// ---------------------------------------------------------------------------
// 1.3 — Finding immutability (hash)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of a finding's core fields.
 * Used to detect any downstream mutation.
 *
 * The hash covers: metric, period, scope, claim value, figure value,
 * delta, and the finding text. It does NOT cover rank or presentation
 * decisions, which are allowed to change.
 */
export function hashFinding(fields: {
  metric?: string | null;
  period?: string | null;
  scope?: string | null;
  claimValue?: number | null;
  figureValue?: number | null;
  deltaAbs?: number | null;
  deltaPct?: number | null;
  text?: string | null;
}): string {
  const parts = [
    fields.metric ?? "",
    fields.period ?? "",
    fields.scope ?? "",
    String(fields.claimValue ?? ""),
    String(fields.figureValue ?? ""),
    String(fields.deltaAbs ?? ""),
    String(fields.deltaPct ?? ""),
    fields.text ?? "",
  ];
  // Simple deterministic hash (FNV-1a 32-bit)
  let hash = 0x811c9dc5;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return "f_" + hash.toString(16).padStart(8, "0");
}

/**
 * Verify a finding hasn't been mutated since generation.
 */
export function verifyFindingIntegrity(
  finding: {
    metric?: string | null;
    period?: string | null;
    scope?: string | null;
    claimValue?: number | null;
    figureValue?: number | null;
    deltaAbs?: number | null;
    deltaPct?: number | null;
    text?: string | null;
  },
  expectedHash: string,
): boolean {
  return hashFinding(finding) === expectedHash;
}

// ---------------------------------------------------------------------------
// 2.1 — Double-read verification
// ---------------------------------------------------------------------------

/**
 * Verify a cited number by comparing two independent reads.
 * Returns true if both reads agree within 4 significant figures.
 * Returns false (and the finding must be dropped) on disagreement.
 */
export function doubleReadVerify(
  readA: number | null | undefined,
  readB: number | null | undefined,
): { passed: boolean; readA: number | null; readB: number | null; reason?: string } {
  if (readA == null || readB == null) {
    return { passed: false, readA: readA ?? null, readB: readB ?? null, reason: "one or both reads missing" };
  }
  if (!Number.isFinite(readA) || !Number.isFinite(readB)) {
    return { passed: false, readA, readB, reason: "non-finite value" };
  }

  // Compare to 4 significant figures
  const base = Math.max(Math.abs(readA), Math.abs(readB), 1);
  const relDiff = Math.abs(readA - readB) / base;
  const SIG_FIG_TOLERANCE = 5e-5; // 4 sig figs

  if (relDiff > SIG_FIG_TOLERANCE) {
    return {
      passed: false,
      readA,
      readB,
      reason: "double-read disagreement: " + readA.toPrecision(6) + " vs " + readB.toPrecision(6) +
        " (rel diff " + (relDiff * 100).toFixed(4) + "%)",
    };
  }

  return { passed: true, readA, readB };
}

// ---------------------------------------------------------------------------
// Combined gate — run all three
// ---------------------------------------------------------------------------

export interface QualityGateResult {
  passed: boolean;
  wordingLint: WordingLintResult;
  hasExplanation: boolean;
  explanation: string | null;
  integrityHash: string;
  dropReason: string | null;
}

export function runFindingQualityGate(
  finding: {
    title?: string | null;
    detail?: string | null;
    full_analysis?: string | null;
    metric?: string | null;
    period?: string | null;
    scope?: string | null;
    claimValue?: number | null;
    figureValue?: number | null;
    deltaAbs?: number | null;
    deltaPct?: number | null;
  },
  checkType: FindingCheckType,
  context: Parameters<typeof generateAlternativeExplanation>[1] = {},
): QualityGateResult {
  // 1.1: Wording lint
  const lint = lintFindingWording({
    title: finding.title,
    detail: finding.detail,
    full_analysis: finding.full_analysis,
  });

  // 1.2: Alternative explanation
  const explanation = generateAlternativeExplanation(checkType, context);
  const hasExplanation = explanation !== null;

  // 1.3: Integrity hash
  const integrityHash = hashFinding({
    ...finding,
    text: finding.full_analysis,
  });

  // Determine pass/fail
  let dropReason: string | null = null;
  if (!lint.passed) {
    dropReason = "WORDING_LINT: " + lint.violations.map(v =>
      "'" + v.word + "' in " + v.field + " → use '" + v.suggestion + "'"
    ).join("; ");
  }
  if (!hasExplanation) {
    dropReason = (dropReason ? dropReason + " | " : "") +
      "NO_EXPLANATION: check type '" + checkType + "' cannot generate a credible alternative";
  }

  return {
    passed: lint.passed && hasExplanation,
    wordingLint: lint,
    hasExplanation,
    explanation,
    integrityHash,
    dropReason,
  };
}
