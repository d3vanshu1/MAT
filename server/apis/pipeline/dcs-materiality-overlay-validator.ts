/**
 * DCS Materiality Overlay Validator — pure deterministic validation.
 *
 * DESIGN INVARIANT: this file performs NO I/O. It must not import any
 * database integration, Anthropic integration, API helper, or
 * Superblocks SDK. It contains only types, constants, and pure
 * deterministic functions.
 *
 * No database access.
 * No API registration.
 * No model calls.
 * No logging.
 * No timestamps.
 * No random values.
 * No environment reads.
 */

// ── Forbidden vocabulary for output validation ──────────────────
export const OVERLAY_FORBIDDEN_TERMS = [
  "score", "scores", "scored", "scoring",
  "grade", "grades", "graded",
  "rating", "ratings",
  "percent", "percentage",
  "out of ten",
];

const RECOMMENDATION_PATTERNS = [
  /\brecommend(?:s|ed|ing)?\s+(?:that\s+)?(?:the\s+)?(?:investment|deal|transaction)\s+(?:be\s+)?(?:approved|rejected|declined|proceed)/i,
  /\bshould\s+(?:not\s+)?(?:approve|reject|decline|proceed\s+with)/i,
  /\bapprove\s+(?:the\s+)?(?:investment|deal|transaction)/i,
  /\breject\s+(?:the\s+)?(?:investment|deal|transaction)/i,
];

// ── Validation result type ──────────────────────────────────────

export interface OverlayValidationResult {
  accepted: boolean;
  overlay: string | null;
  rejectionCode: string | null;
}

// ═══════════════════════════════════════════════════════════════════
// PURE VALIDATION FUNCTION — used for both live model output,
// verification candidates, and render-time re-validation.
// ═══════════════════════════════════════════════════════════════════

export function validateMaterialityOverlay(
  candidate: string,
): OverlayValidationResult {
  const trimmed = candidate.trim();

  // 1. Empty
  if (trimmed.length === 0) {
    return { accepted: false, overlay: null, rejectionCode: "EMPTY" };
  }

  // 2. Exceeds 2000 chars
  if (trimmed.length > 2000) {
    return { accepted: false, overlay: null, rejectionCode: "EXCEEDS_LENGTH" };
  }

  // 3. Contains ASCII digit
  if (/[0-9]/.test(trimmed)) {
    return { accepted: false, overlay: null, rejectionCode: "CONTAINS_DIGIT" };
  }

  // 4. Forbidden vocabulary (case-insensitive word boundary)
  for (const term of OVERLAY_FORBIDDEN_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(trimmed)) {
      return {
        accepted: false,
        overlay: null,
        rejectionCode: `FORBIDDEN_TERM:${term}`,
      };
    }
  }

  // 5. Markdown heading
  if (/^#{1,6}\s/m.test(trimmed)) {
    return { accepted: false, overlay: null, rejectionCode: "MARKDOWN_HEADING" };
  }

  // 6. Markdown bullet or numbered list
  if (/^[\s]*[-*+]\s/m.test(trimmed) || /^[\s]*\d+\.\s/m.test(trimmed)) {
    return { accepted: false, overlay: null, rejectionCode: "MARKDOWN_LIST" };
  }

  // 7. Markdown table separator
  if (/\|[\s]*[-:]+[\s]*\|/.test(trimmed)) {
    return { accepted: false, overlay: null, rejectionCode: "MARKDOWN_TABLE" };
  }

  // 8. Approval or rejection recommendation
  for (const pattern of RECOMMENDATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { accepted: false, overlay: null, rejectionCode: "RECOMMENDATION" };
    }
  }

  return { accepted: true, overlay: trimmed, rejectionCode: null };
}
