/**
 * BSS v2 — evidence snippet matcher.
 *
 * Decides whether a model-supplied `verbatim_snippet` genuinely came out of the
 * chunk it cites, and records HOW it matched so that downstream phases can
 * treat the two cases differently.
 *
 * WHY THIS IS NOT A PLAIN `String.includes`
 *
 * Two different things break a literal substring test on this corpus, and they
 * deserve opposite responses:
 *
 *   1. Punctuation transliteration. The model writes `SCG's` where the PDF
 *      extract holds `SCG’s`, and `"Company"` where the extract holds
 *      `“Company”`. No word changes and no ordering changes. Rejecting on this
 *      is noise, and a gate that fires on noise gets deleted.
 *
 *   2. Column-interleaved extraction. In the SCG CIM, `10-250 FTEs` and
 *      `SCG target market` are adjacent cells of one table, but the extractor
 *      spliced 76 characters of an unrelated column between them in the
 *      character stream. The model quotes what a human reading the table would
 *      call contiguous; the linear string disagrees.
 *
 * Case 1 is normalised away. Case 2 is TOLERATED BUT BOUNDED AND RECORDED.
 *
 * WHY THE BOUNDS ARE THE WHOLE POINT
 *
 * Unbounded elision would destroy the guarantee this module exists to provide.
 * Given a free hand, a model could stitch `"revenue grew"` from one end of a
 * 2,000-character chunk to `"45%"` at the other and present the join as a
 * quotation — manufacturing a claim the source never makes. That is precisely
 * the back-calculation failure this evidence rule was written to stop.
 *
 * So a match may skip text only LOCALLY: at most SNIPPET_MAX_GAPS gaps, none
 * wider than SNIPPET_MAX_GAP_CHARS, totalling no more than
 * SNIPPET_MAX_TOTAL_SKIPPED. Fragments must appear in order. Long-range
 * stitching fails, interleaved table debris survives.
 *
 * WHY THE MODE IS RETURNED RATHER THAN SWALLOWED
 *
 * An elided match is weaker evidence than a literal one. Permitting elision
 * silently would throw that distinction away at the exact point it is cheapest
 * to record. `match_mode` is set here, by the matcher, and never by the model.
 *
 * All offsets and skip counts are measured on the NORMALISED strings, which is
 * the only representation in which "how much was skipped" is well defined.
 */

/** Maximum number of separate gaps permitted in an elided match. */
export const SNIPPET_MAX_GAPS = 3;

/** Maximum width of any single gap, in normalised characters. */
export const SNIPPET_MAX_GAP_CHARS = 100;

/** Maximum total characters that may be skipped across all gaps. */
export const SNIPPET_MAX_TOTAL_SKIPPED = 120;

/** Longest anchor tried when (re-)aligning. Longer anchors are more specific. */
const PROBE_LEN = 24;

/** Below this, a fragment is too short to anchor on without risking a spurious hit. */
const MIN_PROBE_LEN = 6;

/** Bound on alignment attempts, so a pathological repeated lead cannot spin. */
const MAX_START_ATTEMPTS = 25;

export type SnippetMatchMode = "literal" | "elided";

export interface SnippetMatchResult {
  matched: boolean;
  /** Null when unmatched. Set by the matcher only. */
  mode: SnippetMatchMode | null;
  charsSkipped: number;
  gapCount: number;
  /** Human-readable cause when unmatched; null on success. */
  reason: string | null;
}

/**
 * The permitted normalisation set, and nothing beyond it.
 *
 * Deliberately absent: case folding, punctuation stripping, and any digit
 * handling. Normalising digits would let a fabricated figure match a real one,
 * which would invert the purpose of the check.
 */
export function normalizeForSnippetMatch(input: string): string {
  return input
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\u00B4]/g, "'") // single quotes / apostrophes
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"') // double quotes
    .replace(/[\u2013\u2014]/g, "-") // en-dash, em-dash
    .replace(/\u00A0/g, " ") // non-breaking space
    .replace(/\s+/g, " ") // whitespace runs
    .trim();
}

type AlignOutcome =
  | { ok: true; gapCount: number; charsSkipped: number }
  | { ok: false; reason: string };

/**
 * Anchor lengths to try, longest first.
 *
 * WHY A LADDER RATHER THAN A FIXED LENGTH
 *
 * A fixed 24-character anchor is unusable on exactly the corpus this matcher
 * exists for. Take chunk 13's `10-250 FTEs SCG target market`: the gap falls
 * after `FTEs`, so a 24-character anchor taken from the head spans the gap
 * itself and `indexOf` returns -1 — the alignment never even starts, and a
 * snippet that is comfortably inside the elision caps is reported as absent.
 *
 * Descending fixes this without loosening the gate. The longest anchor that
 * actually occurs is the most specific one available, so specificity is only
 * given up to the extent the text forces it, and never below MIN_PROBE_LEN.
 * The gap caps are unchanged and still do the real bounding work.
 */
function anchorProbeLengths(snippet: string, si: number): number[] {
  const max = Math.min(PROBE_LEN, snippet.length - si);
  const lengths: number[] = [];
  for (let pl = max; pl >= MIN_PROBE_LEN; pl--) lengths.push(pl);
  return lengths;
}

/** Longest anchor from `snippet[si..]` that occurs in `content` at or after `from`. */
function findAnchor(
  content: string,
  snippet: string,
  si: number,
  from: number,
): { pos: number; probeLen: number } | null {
  for (const probeLen of anchorProbeLengths(snippet, si)) {
    const pos = content.indexOf(snippet.slice(si, si + probeLen), from);
    if (pos !== -1) return { pos, probeLen };
  }
  return null;
}

/**
 * Attempt to align `snippet` into `content` starting at `start`, greedily
 * consuming contiguous runs and re-anchoring across bounded gaps.
 */
function align(content: string, snippet: string, start: number): AlignOutcome {
  let ci = start;
  let si = 0;
  let gapCount = 0;
  let charsSkipped = 0;

  while (si < snippet.length) {
    // Consume the longest contiguous run that matches from here.
    let k = 0;
    while (
      si + k < snippet.length &&
      ci + k < content.length &&
      content[ci + k] === snippet[si + k]
    ) {
      k++;
    }
    si += k;
    ci += k;
    if (si >= snippet.length) break;

    const remaining = snippet.length - si;
    if (remaining < MIN_PROBE_LEN) {
      return {
        ok: false,
        reason: `trailing ${remaining} chars ("${snippet.slice(si)}") too short to re-anchor safely`,
      };
    }

    const anchor = findAnchor(content, snippet, si, ci);
    if (anchor === null) {
      return {
        ok: false,
        reason: `fragment "${snippet.slice(si, si + Math.min(PROBE_LEN, remaining))}" does not occur after the preceding fragment`,
      };
    }

    const found = anchor.pos;
    const gap = found - ci;
    if (gap <= 0) {
      return { ok: false, reason: "alignment failed to advance" };
    }
    if (gapCount + 1 > SNIPPET_MAX_GAPS) {
      return { ok: false, reason: `needs more than ${SNIPPET_MAX_GAPS} gaps` };
    }
    if (gap > SNIPPET_MAX_GAP_CHARS) {
      return { ok: false, reason: `gap of ${gap} chars exceeds the ${SNIPPET_MAX_GAP_CHARS}-char limit` };
    }
    if (charsSkipped + gap > SNIPPET_MAX_TOTAL_SKIPPED) {
      return {
        ok: false,
        reason: `total skipped ${charsSkipped + gap} chars exceeds the ${SNIPPET_MAX_TOTAL_SKIPPED}-char limit`,
      };
    }

    gapCount++;
    charsSkipped += gap;
    ci = found;
  }

  return { ok: true, gapCount, charsSkipped };
}

/**
 * Test a snippet against the chunk text it claims to come from.
 *
 * Never throws: a matcher that can crash would turn a validation gate into an
 * outage. An internal failure is reported as an unmatched result.
 */
export function matchSnippet(rawContent: string, rawSnippet: string): SnippetMatchResult {
  const miss = (reason: string): SnippetMatchResult => ({
    matched: false,
    mode: null,
    charsSkipped: 0,
    gapCount: 0,
    reason,
  });

  try {
    const content = normalizeForSnippetMatch(rawContent);
    const snippet = normalizeForSnippetMatch(rawSnippet);

    if (snippet.length === 0) return miss("snippet is empty after normalisation");
    if (content.length === 0) return miss("chunk content is empty after normalisation");

    // Fast path. Most honest quotes land here once punctuation is normalised.
    if (content.includes(snippet)) {
      return { matched: true, mode: "literal", charsSkipped: 0, gapCount: 0, reason: null };
    }

    // The opening anchor needs the same ladder as the re-anchor: if the first
    // gap falls early, a full-length lead straddles it and the alignment never
    // starts. Longest lead first, each tried at every occurrence, within one
    // shared attempt budget so a repetitive chunk cannot spin.
    let firstReason: string | null = null;
    let attempts = 0;
    const leadLengths = anchorProbeLengths(snippet, 0);

    for (const leadLen of leadLengths) {
      const lead = snippet.slice(0, leadLen);
      let from = 0;

      while (attempts < MAX_START_ATTEMPTS) {
        const start = content.indexOf(lead, from);
        if (start === -1) break;
        attempts++;

        const outcome = align(content, snippet, start);
        if (outcome.ok) {
          return {
            matched: true,
            mode: "elided",
            charsSkipped: outcome.charsSkipped,
            gapCount: outcome.gapCount,
            reason: null,
          };
        }
        if (firstReason === null) firstReason = outcome.reason;
        from = start + 1;
      }

      if (attempts >= MAX_START_ATTEMPTS) break;
    }

    if (leadLengths.length === 0) {
      return miss(`snippet is only ${snippet.length} chars and does not occur literally`);
    }

    return miss(
      firstReason ?? `opening fragment "${snippet.slice(0, leadLengths[0])}" does not occur in the chunk`,
    );
  } catch (err) {
    return miss(`matcher error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
