/**
 * Text helpers for presenting module report content in the dashboard.
 *
 * The card tier is a flash card: it gets a plain-text headline and lead, derived
 * from the summary markdown. The details and full-report tiers render markdown
 * directly, so they do not use these helpers.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string is a bare UUID and therefore carries no reader value. */
export function isBareUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Drop bare UUIDs from a source-document list so they never reach the reader. */
export function readableSourceDocs(docs: readonly string[]): string[] {
  return docs.filter((doc) => !isBareUuid(doc));
}

/** Strip markdown syntax down to readable plain text for clamped card display. */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface SummaryLead {
  /** The finding headline — the first level-2 heading, when present. */
  headline: string | null;
  /** The first body paragraph following the headline. */
  lead: string | null;
}

/**
 * Split markdown into paragraph blocks, dropping blockquote and heading lines.
 *
 * Blockquotes on these reports carry run metadata (deal, timestamp, coverage),
 * which is provenance rather than finding content and does not belong on a card.
 */
function paragraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !trimmed.startsWith(">") && !trimmed.startsWith("#");
        })
        .join(" "),
    )
    .map((block) => stripMarkdown(block).replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0);
}

/**
 * Pull a headline and lead out of summary markdown for the flash card.
 *
 * With a level-2 heading present, the heading is the headline and the first
 * following paragraph is the lead. Without one — modules still emitting a plain
 * executive header — the first two paragraphs fill those roles instead. Only
 * those two blocks are ever used, so trailing methodology boilerplate stays off
 * the card.
 */
export function summaryLead(markdown: string): SummaryLead {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => /^\s*##\s+/.test(line));

  if (headingIndex === -1) {
    const blocks = paragraphs(markdown);
    return {
      headline: blocks[0] ?? null,
      lead: blocks[1] ?? null,
    };
  }

  const headline = lines[headingIndex].replace(/^\s*##\s+/, "").trim();
  const blocks = paragraphs(lines.slice(headingIndex + 1).join("\n"));

  return {
    headline: headline.length > 0 ? headline : null,
    lead: blocks[0] ?? null,
  };
}
