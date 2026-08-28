/**
 * ERO v2 — Layer 3 Dedup Fixture Runner
 *
 * No DB, no LLM. Builds a 9-row fixture array, calls consolidateEntities,
 * and returns raw stats + every output row for manual inspection.
 */
import { api, z } from "@superblocksteam/sdk-api";
import {
  consolidateEntities,
  type LlmEntityInput,
} from "./ero-entity-manifest.js";

// Placeholder values for required fields that are irrelevant to dedup
const PLACEHOLDER_DOC = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_SNIPPET = "fixture-row";

function row(
  entity_type: string,
  legal_name: string,
  registration_number: string | null,
): LlmEntityInput {
  return {
    entity_type,
    legal_name,
    registration_number,
    jurisdiction: "GB",
    role: "fixture",
    source_document_id: PLACEHOLDER_DOC,
    verbatim_snippet: PLACEHOLDER_SNIPPET,
    rank_signal: null,
  };
}

const OutputRow = z.object({
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable().optional(),
  rank_signal: z.any().nullable().optional(),
});

export default api({
  name: "EroTestDedup",
  description: "Fires Layer 3 consolidateEntities against a 9-row fixture",

  input: z.object({}),

  output: z.object({
    stats: z.object({
      inputCount: z.number(),
      regCollapsed: z.number(),
      nameCollapsed: z.number(),
      nameConflictsKept: z.number(),
      multiRoleFlagged: z.number(),
      finalCount: z.number(),
    }),
    rows: z.array(OutputRow),
  }),

  async run() {
    const fixtures: LlmEntityInput[] = [
      // Phase A pair: same type, same reg, different names -> collapse to 1
      row("acquired_entity", "Alpha Systems Limited", "11111111"),
      row("acquired_entity", "Alpha Holdings Ltd", "11111111"),

      // Phase B pair: same type, same normalized name, both null reg -> collapse to 1
      row("acquired_entity", "Beta Communications Limited", null),
      row("acquired_entity", "Beta Communications Ltd", null),

      // Phase B conflict: same type, same normalized name, DIFFERENT regs -> keep both, flag
      row("acquired_entity", "Gamma Limited", "22222222"),
      row("acquired_entity", "Gamma Ltd", "33333333"),

      // Phase C pair: different type, same normalized name -> keep both, flag multi_role
      row("counterparty", "Delta", null),
      row("competitor", "Delta", null),

      // Control: unique, passes through untouched
      row("adviser", "Epsilon Advisory LLP", null),
    ];

    const { survivors, stats } = consolidateEntities(fixtures);

    const rows = survivors.map((s) => ({
      entity_type: s.entity_type,
      legal_name: s.legal_name,
      registration_number: s.registration_number ?? null,
      rank_signal: s.rank_signal ?? null,
    }));

    return { stats, rows };
  },
});
