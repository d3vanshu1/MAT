/**
 * oa-obligation.ts — Classify emergent (non-seeded) topics into obligation classes.
 *
 * Single batched LLM call for all emergent topics. No DB access.
 * Seeded topics pass through unchanged without calling the model.
 */
import { z } from "@superblocksteam/sdk-api";

import type { AiFn } from "./model-consolidation-adapter.js";
import {
  type ObligationClass,
  SEEDED_TOPICS,
  getSeededTopic,
  isSeededTopic,
  OBLIGATION_CHECKLIST_VERSION,
} from "./oa-taxonomy.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ClassifiedEmergentTopic {
  topic_id: string;
  obligation_class: ObligationClass;
  obligation_basis: string;
  parent_topic_id: string;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildClassificationPrompt(
  emergentTopics: Array<{ topic_id: string; topic_label: string }>,
): string {
  const seededLines = SEEDED_TOPICS.map(
    (t) => `  ${t.topic_id} | ${t.topic_label} | ${t.obligation_class}`
  ).join("\n");

  const emergentLines = emergentTopics.map(
    (t) => `  ${t.topic_id} | ${t.topic_label}`
  ).join("\n");

  return `You are classifying emergent due-diligence topics into obligation classes.

Obligation classes (4):
  required            — IC memo must address this topic.
  conditional         — Required only if the reference document set carries material content on it.
  optional            — Surfaced only at Tier 3 materiality. Nice-to-have, not a gap if absent.
  not_memo_relevant   — Never compared against the memo. Adviser process/boilerplate/formatting.

Decision criteria:
- "required": the topic concerns a risk, return driver, or diligence dimension that any IC memo
  must discuss regardless of deal type.
- "conditional": the topic is sector-specific, deal-structure-specific, or only material when
  the reference documents contain substantive analysis on it.
- "optional": the topic is informational context — market colour, brand, or satisfaction scores
  that do not constitute a gap if absent from the memo.
- "not_memo_relevant": the topic describes adviser process, disclaimers, scope limitations,
  or document structure that should never be compared against the IC memo.

Seeded taxonomy (version ${OBLIGATION_CHECKLIST_VERSION}):
  topic_id | topic_label | obligation_class
${seededLines}

Emergent topics to classify:
  topic_id | topic_label
${emergentLines}

For EACH emergent topic, respond with a JSON array. Each element:
{
  "topic_id": "<exact emergent topic_id>",
  "obligation_class": "required" | "conditional" | "optional" | "not_memo_relevant",
  "obligation_basis": "<one-sentence reason for the classification>",
  "parent_topic_id": "<closest seeded topic_id that this emergent topic belongs under>"
}

Rules:
- Every emergent topic MUST receive a parent_topic_id from the seeded set. No orphans.
- If no seeded parent fits cleanly, pick the nearest by domain and state so in obligation_basis.
- Default on ambiguity: "optional".
- Return ONLY the JSON array. No markdown fences, no commentary.`;
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const ClassificationResultSchema = z.array(
  z.object({
    topic_id: z.string(),
    obligation_class: z.enum(["required", "conditional", "optional", "not_memo_relevant"]),
    obligation_basis: z.string(),
    parent_topic_id: z.string(),
  })
);

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Classify emergent topics into obligation classes via a single batched LLM call.
 *
 * - Seeded topics pass through with their defined class (no model call).
 * - Emergent topics are batched into ONE prompt. The 5-minute kill makes
 *   per-topic calls unworkable.
 * - Every emergent topic receives a parent_topic_id from the seeded set.
 */
export async function classifyEmergentTopics(
  topics: Array<{ topic_id: string; topic_label: string }>,
  aiFn: AiFn,
): Promise<ClassifiedEmergentTopic[]> {
  // Separate seeded from emergent
  const seeded: ClassifiedEmergentTopic[] = [];
  const emergent: Array<{ topic_id: string; topic_label: string }> = [];

  for (const t of topics) {
    if (isSeededTopic(t.topic_id)) {
      const s = getSeededTopic(t.topic_id)!;
      // Seeded topics: return their fixed class. Parent is null for seeded,
      // but the return type requires a string — use the topic_id itself as self-reference.
      seeded.push({
        topic_id: s.topic_id,
        obligation_class: s.obligation_class,
        obligation_basis: s.obligation_basis,
        parent_topic_id: s.topic_id, // self-reference for seeded roots
      });
    } else {
      emergent.push(t);
    }
  }

  // If no emergent topics, skip model call entirely
  if (emergent.length === 0) {
    return seeded;
  }

  // Single batched LLM call for all emergent topics
  const prompt = buildClassificationPrompt(emergent);

  const response = await aiFn(
    {
      method: "POST",
      path: "/chat/completions",
      body: {
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 4096,
      },
    },
    { response: z.any() },
    { label: "Classify emergent topics (batched)" }
  );

  // Extract the text content from the response
  const rawText: string =
    response?.choices?.[0]?.message?.content ??
    response?.content?.[0]?.text ??
    "[]";

  // Parse JSON — strip markdown fences if present
  const cleaned = rawText.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // On parse failure, default all emergent topics to "optional"
    console.warn(
      `[oa-obligation] Failed to parse LLM response for ${emergent.length} topics. Defaulting to optional.`
    );
    const fallback: ClassifiedEmergentTopic[] = emergent.map((t) => ({
      topic_id: t.topic_id,
      obligation_class: "optional" as ObligationClass,
      obligation_basis: "Classification failed — defaulted to optional",
      parent_topic_id: "dd.coverage", // safe fallback parent
    }));
    return [...seeded, ...fallback];
  }

  // Validate against schema
  const validated = ClassificationResultSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn(
      `[oa-obligation] Schema validation failed: ${validated.error.message}. Defaulting unmatched to optional.`
    );
    const fallback: ClassifiedEmergentTopic[] = emergent.map((t) => ({
      topic_id: t.topic_id,
      obligation_class: "optional" as ObligationClass,
      obligation_basis: "Schema validation failed — defaulted to optional",
      parent_topic_id: "dd.coverage",
    }));
    return [...seeded, ...fallback];
  }

  // Build a lookup from model results
  const resultMap = new Map<string, z.infer<typeof ClassificationResultSchema>[number]>();
  for (const item of validated.data) {
    resultMap.set(item.topic_id, item);
  }

  // Validate parent_topic_ids point to seeded topics; fix if not
  const validSeededIds = new Set(SEEDED_TOPICS.map((s) => s.topic_id));

  const classified: ClassifiedEmergentTopic[] = emergent.map((t) => {
    const result = resultMap.get(t.topic_id);
    if (!result) {
      // Model omitted this topic — default to optional
      return {
        topic_id: t.topic_id,
        obligation_class: "optional" as ObligationClass,
        obligation_basis: "Not returned by model — defaulted to optional",
        parent_topic_id: "dd.coverage",
      };
    }

    // Ensure parent_topic_id is a valid seeded topic
    const parentId = validSeededIds.has(result.parent_topic_id)
      ? result.parent_topic_id
      : "dd.coverage"; // fallback to diligence coverage

    return {
      topic_id: result.topic_id,
      obligation_class: result.obligation_class,
      obligation_basis: result.obligation_basis,
      parent_topic_id: parentId,
    };
  });

  return [...seeded, ...classified];
}
