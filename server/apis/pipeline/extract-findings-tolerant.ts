/**
 * Tolerant extraction for <findings_json> — recovers complete array elements
 * from truncated LLM output where the closing tag is never emitted.
 *
 * When stop_reason = "max_tokens", the model is cut off mid-response and the
 * closing </findings_json> is never written. A naive extractTag returns "" and
 * all findings for that node are lost. This helper:
 *
 *   1. Tries the normal closed-tag extract first (fast path).
 *   2. If no match, takes the substring after <findings_json>, tracks bracket
 *      depth through the JSON array, truncates at the last position where a
 *      complete top-level array element closes (depth returns to 1), appends ']'.
 *
 * Exported for unit testing and shared between pipeline-core.ts and merge-findings.ts.
 */

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

export function extractFindingsJsonTolerant(text: string): string {
  // Fast path: closed tag present
  const closed = extractTag(text, "findings_json");
  if (closed) return closed;

  // Tolerant path: find the opening tag
  const openTagMatch = text.match(/<findings_json>/i);
  if (!openTagMatch || openTagMatch.index === undefined) return "";

  const startIdx = openTagMatch.index + openTagMatch[0].length;
  const remaining = text.slice(startIdx);

  // Find the start of the array
  const arrayStart = remaining.indexOf("[");
  if (arrayStart === -1) return "";

  let depth = 0;
  let inString = false;
  let escape = false;
  let lastCompleteElementEnd = -1;

  for (let i = arrayStart; i < remaining.length; i++) {
    const ch = remaining[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      // When depth returns to 1, we just closed a top-level array element (object)
      if (depth === 1 && ch === "}") {
        lastCompleteElementEnd = i;
      }
      // If depth hits 0, the array itself closed — use the full thing
      if (depth === 0) {
        return remaining.slice(arrayStart, i + 1).trim();
      }
    }
  }

  // Truncated mid-array — use everything up to last complete element
  if (lastCompleteElementEnd > arrayStart) {
    const recovered = remaining.slice(arrayStart, lastCompleteElementEnd + 1) + "]";
    console.log(`[extractFindingsJsonTolerant] Recovered truncated array: ${recovered.length} chars, cut at position ${lastCompleteElementEnd}`);
    return recovered.trim();
  }

  return "";
}
