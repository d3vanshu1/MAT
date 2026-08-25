/**
 * Shared retrieval utility — boilerplate detection over chunk text.
 *
 * Pure and side-effect-free: no DB access, no LLM call, no I/O. It is a
 * function of `content` alone, so it can be unit-tested against fixtures and
 * called from anywhere in the pipeline without a context.
 *
 * WHY CONTENT-BASED AND NOT POSITIONAL
 *   Position heuristics ("drop the trailing N chunks", "keep the first 60%")
 *   are properties of one document's layout, not of boilerplate. Disclaimers
 *   appear at the front of some memoranda, interleaved in others, and repeated
 *   in page footers in others still. A positional rule tuned on the SCG CIM
 *   would silently mis-fire on the next deal.
 *
 * THE TWO CONSUMERS USE THIS OPPOSITELY — READ BEFORE IMPORTING
 *
 *   Input selection (structural profile, and anything else choosing what to
 *   SHOW a model) EXCLUDES boilerplate. The only cost of a wrong call is a
 *   wasted slice of character budget.
 *
 *   The absence sweep (P5) MUST NOT EXCLUDE ANYTHING. The sweep searches the
 *   entire corpus and uses this classification to DISCOUNT a hit: a candidate
 *   whose only supporting hits land in boilerplate chunks is not covered. If
 *   boilerplate chunks were filtered out of the sweep's search space instead,
 *   the sweep would manufacture false absences — reporting a blind spot the
 *   corpus actually addresses.
 *
 *   The asymmetry matters because the two failure modes are not equally bad. A
 *   false absence is visible and embarrassing; a false COVERAGE is silent, and
 *   suppresses the exact finding the module exists to produce. Hence: this file
 *   returns a classification. It never filters. Filtering is the caller's
 *   decision, made explicitly at the call site.
 */

/**
 * Phrases that occur in adviser/legal boilerplate and effectively never in a
 * substantive business passage.
 *
 * Exported so the set is auditable and extendable without editing logic.
 *
 * Selection criteria: each entry is a multi-word legal collocation rather than
 * a single generic term. That is deliberate — generic vocabulary ("business",
 * "company", "information") is precisely what causes a disclaimer to rank
 * highly under full-text search in the first place, so matching on it would
 * reproduce the bug this file exists to fix.
 *
 * GENERALITY NOTE: "Houlihan Lokey" is a bank name, not a legal phrase. It is
 * the sellside adviser on this one deal and will not appear on another. It is
 * retained because a named adviser recurring inside a chunk is a genuine
 * boilerplate signal, but it must not be relied on for cross-deal generality,
 * and the Part 14 generality test should not treat it as evidence the marker
 * set transfers. If a per-deal adviser name is wanted later, it should be
 * passed in as a parameter, not hardcoded here.
 */
export const BOILERPLATE_MARKERS: readonly string[] = [
  "no representation or warranty",
  "does not constitute an offer",
  "shall not constitute",
  "no liability",
  "strictly confidential",
  "the recipient",
  "professional adviser",
  "Financial Services and Markets Act",
  "FSMA",
  "section 21",
  "forward-looking statements",
  "no obligation to update",
  "Houlihan Lokey",
];

/**
 * Distinct markers required before a chunk is called boilerplate.
 *
 * Two, not one. A substantive chunk may legitimately name an adviser once, or
 * carry a single "forward-looking statements" caption under a projections
 * chart. Requiring two distinct phrases means the chunk has to be doing legal
 * work, not merely mentioning it in passing.
 */
export const BOILERPLATE_MARKER_THRESHOLD = 2;

export interface ChunkClassification {
  /** True when at least BOILERPLATE_MARKER_THRESHOLD distinct markers matched. */
  isBoilerplate: boolean;
  /** The distinct markers that matched, in BOILERPLATE_MARKERS order. */
  markersHit: string[];
  /** Count of distinct markers matched. Never a count of occurrences. */
  markerCount: number;
}

/**
 * Classify a single chunk of text.
 *
 * Matching is case-insensitive substring. Occurrences are NOT counted: a chunk
 * repeating one phrase ten times scores 1, because repetition of a single
 * phrase is weaker evidence than the co-occurrence of two different ones.
 *
 * Never throws. A null/undefined/empty input classifies as not-boilerplate,
 * which is the safe default under the asymmetry described in the file header:
 * when uncertain, keep the chunk and let it be searched.
 */
export function classifyChunk(content: string): ChunkClassification {
  if (typeof content !== "string" || content.length === 0) {
    return { isBoilerplate: false, markersHit: [], markerCount: 0 };
  }

  const haystack = content.toLowerCase();
  const markersHit = BOILERPLATE_MARKERS.filter((marker) =>
    haystack.includes(marker.toLowerCase()),
  );

  return {
    isBoilerplate: markersHit.length >= BOILERPLATE_MARKER_THRESHOLD,
    markersHit,
    markerCount: markersHit.length,
  };
}
