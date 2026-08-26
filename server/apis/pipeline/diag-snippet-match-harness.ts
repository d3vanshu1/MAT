/**
 * Diagnostic — deterministic regression harness for the BSS v2 snippet matcher.
 *
 * WHY THIS EXISTS
 *
 * Two BuildStructuralProfile attempts have been spent discovering matcher
 * behaviour, and each one costs a model call. The matcher is a pure function
 * over two strings, so none of that discovery needed a model at all. This API
 * exercises `matchSnippet` against REAL chunk text with SYNTHETIC snippets
 * whose correct verdict is known by construction — no model, no writes, no
 * pipeline invocation.
 *
 * Synthetic-but-real is the point: the snippets are cut from the actual
 * normalised chunk, so they exercise the same punctuation, table debris and
 * whitespace the model faces, while the expected gap count and skipped-char
 * total are known exactly because this file chose them.
 *
 * The cases cover both directions the gate must get right: bounded elision
 * must be ACCEPTED (case 2 is the exact probe-straddle shape that failed the
 * last run), and long-range stitching, over-cap gaps, too many gaps and
 * altered digits must all be REJECTED.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import {
  matchSnippet,
  normalizeForSnippetMatch,
  SNIPPET_MAX_GAPS,
  SNIPPET_MAX_GAP_CHARS,
  SNIPPET_MAX_TOTAL_SKIPPED,
} from "./bss-snippet-match.js";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

const ChunkRowSchema = z.object({
  chunk_index: z.number(),
  content: z.string(),
});

const CaseResultSchema = z.object({
  name: z.string(),
  intent: z.string(),
  expectMatched: z.boolean(),
  expectMode: z.string().nullable(),
  expectGaps: z.number().nullable(),
  expectSkipped: z.number().nullable(),
  actualMatched: z.boolean(),
  actualMode: z.string().nullable(),
  actualGaps: z.number(),
  actualSkipped: z.number(),
  reason: z.string().nullable(),
  pass: z.boolean(),
  snippetPreview: z.string(),
});

type CaseSpec = {
  name: string;
  intent: string;
  snippet: string;
  expectMatched: boolean;
  expectMode: "literal" | "elided" | null;
  expectGaps: number | null;
  expectSkipped: number | null;
};

export default api({
  name: "DiagSnippetMatchHarness",
  description: "Deterministic regression tests for the BSS snippet matcher",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    documentId: z.string(),
    chunkIndex: z.number().default(13),
  }),

  output: z.object({
    chunkIndex: z.number(),
    normalizedLength: z.number(),
    caps: z.object({
      maxGaps: z.number(),
      maxGapChars: z.number(),
      maxTotalSkipped: z.number(),
    }),
    cases: z.array(CaseResultSchema),
    passCount: z.number(),
    failCount: z.number(),
    allPass: z.boolean(),
  }),

  async run(ctx, { documentId, chunkIndex }) {
    const rows = await ctx.integrations.db.query(
      `SELECT chunk_index, content
         FROM document_chunks
        WHERE document_id = $1::uuid AND chunk_index = $2::int
        LIMIT 1`,
      ChunkRowSchema,
      [documentId, String(chunkIndex)],
      { label: `Fetch chunk ${chunkIndex} for matcher harness` },
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`No chunk ${chunkIndex} found for document ${documentId}`);
    }

    const n = normalizeForSnippetMatch(rows[0].content);
    if (n.length < 700) {
      throw new Error(
        `Chunk ${chunkIndex} normalises to only ${n.length} chars; harness needs >= 700. Pick a longer chunk.`,
      );
    }

    /** head fragment deliberately SHORTER than the 24-char probe — the bug shape. */
    const shortHead = n.slice(200, 211); // 11 chars
    const cases: CaseSpec[] = [];

    cases.push({
      name: "literal",
      intent: "An honest contiguous quote must match literally with nothing skipped.",
      snippet: n.slice(200, 260),
      expectMatched: true,
      expectMode: "literal",
      expectGaps: 0,
      expectSkipped: 0,
    });

    cases.push({
      name: "elided_probe_straddle",
      intent:
        "One 76-char gap opening after an 11-char head. The full-length lead probe spans the gap, " +
        "so this is exactly what failed the previous run; the descending ladder must now accept it.",
      snippet: shortHead + n.slice(287, 337),
      expectMatched: true,
      expectMode: "elided",
      expectGaps: 1,
      expectSkipped: 76,
    });

    cases.push({
      name: "elided_three_gaps_at_cap",
      intent: `Three 30-char gaps = 90 skipped: inside all three caps, must be accepted as elided.`,
      snippet:
        n.slice(200, 240) + n.slice(270, 310) + n.slice(340, 380) + n.slice(410, 450),
      expectMatched: true,
      expectMode: "elided",
      expectGaps: 3,
      expectSkipped: 90,
    });

    cases.push({
      name: "reject_four_gaps",
      intent: `Four gaps exceeds SNIPPET_MAX_GAPS=${SNIPPET_MAX_GAPS}; must be rejected even though each gap is small.`,
      snippet:
        n.slice(200, 230) +
        n.slice(250, 280) +
        n.slice(300, 330) +
        n.slice(350, 380) +
        n.slice(400, 430),
      expectMatched: false,
      expectMode: null,
      expectGaps: null,
      expectSkipped: null,
    });

    cases.push({
      name: "reject_gap_over_cap",
      intent: `A single 150-char gap exceeds SNIPPET_MAX_GAP_CHARS=${SNIPPET_MAX_GAP_CHARS}; must be rejected.`,
      snippet: shortHead + n.slice(361, 411),
      expectMatched: false,
      expectMode: null,
      expectGaps: null,
      expectSkipped: null,
    });

    cases.push({
      name: "reject_long_range_stitch",
      intent:
        "Head of the chunk joined to its tail — the back-calculation fabrication shape this gate exists to stop.",
      snippet: n.slice(0, 30) + n.slice(n.length - 30),
      expectMatched: false,
      expectMode: null,
      expectGaps: null,
      expectSkipped: null,
    });

    // Punctuation transliteration: must be normalised away, not rejected.
    const punctBase = n.slice(200, 300);
    const punctSnippet = punctBase
      .replace(/'/g, "\u2019")
      .replace(/"/g, "\u201C")
      .replace(/-/g, "\u2013")
      .replace(/ /g, "\u00A0");
    cases.push({
      name: "unicode_transliteration",
      intent:
        "Straight quotes/hyphens/spaces swapped for curly, en-dash and NBSP. Normalisation must absorb this as a literal match.",
      snippet: punctSnippet,
      expectMatched: true,
      expectMode: "literal",
      expectGaps: 0,
      expectSkipped: 0,
    });

    // Digit alteration: normalisation must NOT absorb this.
    const digitWindow = n.slice(200, 400);
    const digitPos = digitWindow.search(/[0-9]/);
    if (digitPos !== -1) {
      const absolute = 200 + digitPos;
      const original = n[absolute];
      const altered = original === "9" ? "8" : String(Number(original) + 1);
      const base = n.slice(absolute - 20 < 0 ? 0 : absolute - 20, absolute + 40);
      const idxInBase = base.indexOf(original);
      cases.push({
        name: "reject_altered_digit",
        intent:
          `Digit '${original}' changed to '${altered}' in an otherwise faithful quote. ` +
          "Digits are deliberately not normalised, so a fabricated figure must not match.",
        snippet: base.slice(0, idxInBase) + altered + base.slice(idxInBase + 1),
        expectMatched: false,
        expectMode: null,
        expectGaps: null,
        expectSkipped: null,
      });
    }

    const results = cases.map((c) => {
      const r = matchSnippet(rows[0].content, c.snippet);
      const pass =
        r.matched === c.expectMatched &&
        (!c.expectMatched ||
          (r.mode === c.expectMode &&
            (c.expectGaps === null || r.gapCount === c.expectGaps) &&
            (c.expectSkipped === null || r.charsSkipped === c.expectSkipped)));

      return {
        name: c.name,
        intent: c.intent,
        expectMatched: c.expectMatched,
        expectMode: c.expectMode,
        expectGaps: c.expectGaps,
        expectSkipped: c.expectSkipped,
        actualMatched: r.matched,
        actualMode: r.mode,
        actualGaps: r.gapCount,
        actualSkipped: r.charsSkipped,
        reason: r.reason,
        pass,
        snippetPreview:
          c.snippet.length > 120 ? `${c.snippet.slice(0, 60)} … ${c.snippet.slice(-40)}` : c.snippet,
      };
    });

    const passCount = results.filter((r) => r.pass).length;

    return {
      chunkIndex,
      normalizedLength: n.length,
      caps: {
        maxGaps: SNIPPET_MAX_GAPS,
        maxGapChars: SNIPPET_MAX_GAP_CHARS,
        maxTotalSkipped: SNIPPET_MAX_TOTAL_SKIPPED,
      },
      cases: results,
      passCount,
      failCount: results.length - passCount,
      allPass: passCount === results.length,
    };
  },
});
