/**
 * Regex patterns for suppressing fabricated arithmetic/reconciliation findings.
 *
 * LLM-generated findings that claim summation or reconciliation discrepancies are
 * unreliable (ad-hoc arithmetic on raw text). Only findings grounded in
 * NumericVerify's deterministic output are trustworthy.
 *
 * Fix 19 closure: Overly broad patterns removed. Words like "irreconcilable",
 * "cannot be reconciled", "fails to reconcile" MUST NOT trigger suppression
 * when they appear in legal, control, operational, or governance contexts.
 * These patterns only target arithmetic/summation language.
 *
 * Validated against acceptance cases:
 *   see pipeline/__tests__/fix19-closure-narrow-arithmetic-suppression.test.ts
 */
export const FABRICATED_ARITHMETIC_PATTERNS: RegExp[] = [
  // Arithmetic summation discrepancies
  /\breconcil(?:e|iation|ing)\b.*\b(?:sum|total|add|subtotal)\b/i,
  /\b(?:sum|total|add(?:s|ing)?|subtotal)\b.*\b(?:does not|doesn't|don't|do not)\s+(?:match|equal|reconcile|agree)\b/i,
  /\b(?:adds? up to|sums? to|totals? to)\b.*\b(?:but|however|yet|whereas)\b/i,
  /\bperiodic values?\b.*\b(?:sum|total)\b.*\b(?:discrepan|mismatch|inconsisten)/i,
  /\barithmetic(?:al)?\s+(?:error|discrepancy|mismatch|inconsistency)\b/i,
  /\bmanual(?:ly)?\s+(?:sum|add|calculat|total|reconcil)/i,
  /\bcolumn[s]?\s+(?:sum|total|add)\b.*\b(?:variance|differ|mismatch|disagree)/i,
  /\bsum(?:s|ming)?\s+to\b.*\b(?:gap|shortfall|unexplained)\b/i,
  /\bdo\s+not\s+reconcile\b/i,
  // REMOVED (Fix 19 closure):
  // /\birreconcil/i — matches "irreconcilable shareholder dispute" (legal risk)
  // /\bcannot\s+be\s+reconciled\b/i — matches "accounts cannot be reconciled due to control deficiencies"
  // /\bfails?\s+to\s+reconcile\b/i — matches operational/governance contexts
];

/**
 * Fix 19 closure: Context guard — only suppress findings that meet ALL conditions:
 * 1. LLM-generated (not from deterministic reconciliation)
 * 2. Asserts a numeric/arithmetic discrepancy
 * 3. Unverified or explicitly failed numeric verification
 * 4. Not a source-stated legal, control, operational, or governance risk
 *
 * Returns true if the finding should be suppressed.
 */
export function shouldSuppressArithmeticFinding(finding: {
  title: string;
  detail: string;
  full_analysis: string;
  finding_kind?: string;
  category?: string;
  verification?: { status: string } | null;
  source?: string;
  numeric_unverified?: boolean;
}): boolean {
  // Guard 1: Never suppress deterministic reconciliation findings
  if (finding.finding_kind === "data_divergence" ||
      finding.finding_kind === "cross_version" ||
      finding.finding_kind === "unreconcilable" ||
      finding.finding_kind === "scope_mismatch") {
    return false;
  }

  // Guard 2: Never suppress source-stated legal, control, operational, governance risks
  const protectedCategories = ["legal", "governance", "control", "regulatory", "compliance", "operational_risk"];
  if (finding.category && protectedCategories.includes(finding.category.toLowerCase())) {
    return false;
  }

  // Guard 3: Never suppress findings that have been verified (only suppress unverified)
  if (finding.verification && finding.verification.status === "verified") {
    return false;
  }

  // Guard 4: The finding text must match a fabricated arithmetic pattern
  const text = `${finding.title} ${finding.detail} ${finding.full_analysis}`;
  const matchesPattern = FABRICATED_ARITHMETIC_PATTERNS.some(pat => pat.test(text));
  if (!matchesPattern) {
    return false;
  }

  // Guard 5: The matched content must be in arithmetic context (not legal/operational)
  // Check if the text contains legal/operational risk language that should NOT be suppressed
  const legalOperationalSignals = [
    /\b(?:shareholder|stakeholder)\s+(?:dispute|conflict|disagreement)\b/i,
    /\bcontrol\s+(?:deficien|weakness|failure|gap)\b/i,
    /\b(?:legal|regulatory|compliance)\s+(?:risk|exposure|breach|violation)\b/i,
    /\b(?:governance|fiduciary|duty)\b.*\b(?:failure|breach|concern)\b/i,
    /\b(?:material\s+weakness|significant\s+deficiency)\b/i,
    /\boperational\s+(?:risk|failure|disruption)\b/i,
  ];
  if (legalOperationalSignals.some(pat => pat.test(text))) {
    return false;
  }

  // All guards passed — this is a fabricated arithmetic finding that should be suppressed
  return true;
}
