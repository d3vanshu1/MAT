/**
 * ERO v2 — Hypothesis generation (Phase 3, Stage 1)
 *
 * Turns the verified Phase 2 output (entity manifest + deal profile) into
 * specific, falsifiable research questions. Each hypothesis names an entity
 * or regime, links to a thesis dependency where relevant, and states its
 * confirming and refuting evidence BEFORE any search runs.
 *
 * Hypotheses come from TWO sources:
 *   1. Entity-sourced — keyed off ero_entities manifest rows
 *   2. Profile-sourced — keyed off ero_profile fields (e.g. regulatory
 *      hypotheses from sector/geography when no regulator entities exist,
 *      or acquisition-programme hypotheses from thesis_dependency fields)
 *
 * Model: claude-sonnet-4-6 hardcoded (Phase 5 centralisation TODO).
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
import { ERO_FAMILIES, type CheckFamily, type FamilySource } from "./ero-families.js";

// ── Model ───────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-6";

// ── Zod schemas for DB reads ────────────────────────────────────────
const CountRow = z.object({ cnt: z.coerce.number() });

const EntityRow = z.object({
  entity_id: z.string(),
  entity_type: z.string(),
  legal_name: z.string(),
  registration_number: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  role: z.string().nullable(),
  rank_signal: z.any().nullable(),
});

const ProfileRow = z.object({
  profile_id: z.string(),
  field_group: z.string(),
  field_name: z.string(),
  field_value: z.string(),
});

// ── LLM response schemas ────────────────────────────────────────────
const AnthropicResponse = z.object({
  content: z.array(z.object({ text: z.string() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const LlmHypothesis = z.object({
  question: z.string(),
  confirming_evidence: z.string(),
  refuting_evidence: z.string(),
  thesis_link: z.string().nullable(),
  entity_ref: z.string().nullable(),  // legal_name reference for entity-sourced
});

// ── Main handler ────────────────────────────────────────────────────
export async function generateHypotheses(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;
  const claude = ctx.integrations.claude;

  // ── 1. Idempotency check ──────────────────────────────────────────
  const [{ cnt: existingCount }] = await db.query(
    `SELECT count(*)::int AS cnt FROM ero_hypotheses WHERE run_id = $1`,
    CountRow,
    [runId],
    { label: "HypothesisGen: idempotency check" },
  );

  if (existingCount > 0) {
    return {
      stage: "generate_hypotheses",
      status: "complete",
      message: `Idempotent — ${existingCount} hypotheses already exist for this run.`,
    };
  }

  // ── 2. Load entities and profile ──────────────────────────────────
  const entities = await db.query(
    `SELECT entity_id, entity_type, legal_name, registration_number, jurisdiction, role, rank_signal
     FROM ero_entities WHERE run_id = $1`,
    EntityRow,
    [runId],
    { label: "HypothesisGen: load entities" },
  );

  const profile = await db.query(
    `SELECT profile_id, field_group, field_name, field_value
     FROM ero_profile WHERE run_id = $1`,
    ProfileRow,
    [runId],
    { label: "HypothesisGen: load profile" },
  );

  if (entities.length === 0 && profile.length === 0) {
    return {
      stage: "generate_hypotheses",
      status: "failed",
      message: "No entities or profile found for this run. Phase 2 must complete first.",
    };
  }

  // ── 2b. Alias guard (belt-and-suspenders) ──────────────────────────
  // Build a set of all legal_names that appear as merged aliases of
  // another surviving entity.  If the semantic dedup's non-fatal catch
  // fell back to the pre-dedup set, aliases could be present as rows.
  // Excluding them here prevents duplicate/shadow hypotheses.
  const aliasNames = new Set<string>();
  for (const e of entities) {
    if (e.rank_signal && typeof e.rank_signal === "object") {
      const sig = e.rank_signal as Record<string, unknown>;
      const aliases = sig.merged_aliases;
      if (Array.isArray(aliases)) {
        for (const a of aliases) {
          if (typeof a === "string") aliasNames.add(a.toLowerCase());
        }
      }
    }
  }

  const filteredEntities = aliasNames.size > 0
    ? entities.filter(
        (e: z.infer<typeof EntityRow>) => !aliasNames.has(e.legal_name.toLowerCase()),
      )
    : entities;

  // ── 3. Index entities by type, profile by field ───────────────────
  const entitiesByType = new Map<string, z.infer<typeof EntityRow>[]>();
  for (const e of filteredEntities) {
    const arr = entitiesByType.get(e.entity_type) ?? [];
    arr.push(e);
    entitiesByType.set(e.entity_type, arr);
  }

  const profileByGroup = new Map<string, z.infer<typeof ProfileRow>[]>();
  for (const p of profile) {
    const arr = profileByGroup.get(p.field_group) ?? [];
    arr.push(p);
    profileByGroup.set(p.field_group, arr);
  }

  // ── 4. Generate hypotheses per family ─────────────────────────────
  type HypothesisInsert = {
    family: string;
    entity_id: string | null;
    thesis_link: string | null;
    question: string;
    confirming_evidence: string;
    refuting_evidence: string;
  };

  const allHypotheses: HypothesisInsert[] = [];
  const familyBreakdown: Record<string, number> = {};
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const family of ERO_FAMILIES) {
    const inputs = assembleFamilyInputs(family, entitiesByType, profileByGroup, profile);

    // Skip families with no inputs
    if (!inputs.entityBlock && !inputs.profileBlock) {
      familyBreakdown[family.id] = 0;
      continue;
    }

    const systemPrompt = buildSystemPrompt(family);
    const userPrompt = buildUserPrompt(family, inputs);

    try {
      const llmResult = await claude.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          },
        },
        { response: AnthropicResponse },
        { label: `HypothesisGen: ${family.id}` },
      );

      totalTokensIn += llmResult.usage.input_tokens;
      totalTokensOut += llmResult.usage.output_tokens;

      const raw = llmResult.content[0]?.text ?? "[]";
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned) as z.infer<typeof LlmHypothesis>[];

      // Map LLM output to inserts
      for (const h of parsed) {
        // Resolve entity_id from entity_ref (legal_name match)
        let entityId: string | null = null;
        if (h.entity_ref) {
          const match = entities.find(
            (e: { entity_id: string; legal_name: string }) =>
              e.legal_name.toLowerCase() === h.entity_ref!.toLowerCase(),
          );
          if (match) entityId = match.entity_id;
        }

        allHypotheses.push({
          family: family.id,
          entity_id: entityId,
          thesis_link: h.thesis_link ?? null,
          question: h.question,
          confirming_evidence: h.confirming_evidence,
          refuting_evidence: h.refuting_evidence,
        });
      }

      familyBreakdown[family.id] = parsed.length;
    } catch (err: any) {
      // Log error but continue — don't let one family failure block all
      familyBreakdown[family.id] = 0;
      console.error(`HypothesisGen: family ${family.id} failed:`, err?.message ?? err);
    }
  }

  // ── 5. Insert all hypotheses ──────────────────────────────────────
  if (allHypotheses.length === 0) {
    return {
      stage: "generate_hypotheses",
      status: "failed",
      message: "No hypotheses generated across any family.",
    };
  }

  // Build parameterized batch insert
  // execution_rank: provisional sequential index (3.2 will overwrite with real ranks)
  const valueClauses: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  for (let i = 0; i < allHypotheses.length; i++) {
    const h = allHypotheses[i];
    valueClauses.push(
      `(gen_random_uuid(), $${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, 'pending', 1)`,
    );
    params.push(
      runId,                  // run_id
      h.family,               // family
      h.entity_id,            // entity_id (nullable)
      h.thesis_link,          // thesis_link
      h.question,             // question
      h.confirming_evidence,  // confirming_evidence
      h.refuting_evidence,    // refuting_evidence
      i + 1,                  // execution_rank (provisional sequential)
    );
    paramIdx += 8;
  }

  await db.execute(
    `INSERT INTO ero_hypotheses
       (hypothesis_id, run_id, family, entity_id, thesis_link,
        question, confirming_evidence, refuting_evidence,
        execution_rank, status, round)
     VALUES ${valueClauses.join(", ")}`,
    params,
    { label: `HypothesisGen: insert ${allHypotheses.length} hypotheses` },
  );

  // ── 6. Check must-haves ───────────────────────────────────────────
  const regulatoryPresent = (familyBreakdown["regulatory"] ?? 0) > 0;
  const acquisitionProgrammePresent = (familyBreakdown["valuation"] ?? 0) > 0;

  const breakdownStr = Object.entries(familyBreakdown)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

  return {
    stage: "generate_hypotheses",
    status: "complete",
    message: `${allHypotheses.length} hypotheses generated | breakdown: ${breakdownStr} | regulatory_present: ${regulatoryPresent} | acquisition_programme_present: ${acquisitionProgrammePresent} | tokens: in=${totalTokensIn} out=${totalTokensOut}`,
    stageData: {
      familyBreakdown,
      totalTokensIn,
      totalTokensOut,
      regulatoryPresent,
      acquisitionProgrammePresent,
    },
  };
}

// ── Helper: assemble inputs for a family ────────────────────────────
function assembleFamilyInputs(
  family: CheckFamily,
  entitiesByType: Map<string, z.infer<typeof EntityRow>[]>,
  profileByGroup: Map<string, z.infer<typeof ProfileRow>[]>,
  allProfile: z.infer<typeof ProfileRow>[],
): { entityBlock: string | null; profileBlock: string | null } {
  const source = family.source;
  let entityBlock: string | null = null;
  let profileBlock: string | null = null;

  if (source.kind === "entity" || source.kind === "entity_and_profile") {
    const relevantEntities: z.infer<typeof EntityRow>[] = [];
    for (const et of source.entityTypes) {
      const arr = entitiesByType.get(et);
      if (arr) relevantEntities.push(...arr);
    }
    if (relevantEntities.length > 0) {
      entityBlock = relevantEntities
        .map((e) => {
          const parts = [`- ${e.legal_name} (type: ${e.entity_type})`];
          if (e.registration_number) parts.push(`  reg: ${e.registration_number}`);
          if (e.jurisdiction) parts.push(`  jurisdiction: ${e.jurisdiction}`);
          if (e.role) parts.push(`  role: ${e.role}`);
          if (e.rank_signal && typeof e.rank_signal === "object") {
            const sig = e.rank_signal as Record<string, unknown>;
            const sigParts = Object.entries(sig)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}: ${v}`);
            if (sigParts.length > 0) parts.push(`  rank_signal: ${sigParts.join(", ")}`);
          }
          return parts.join("\n");
        })
        .join("\n");
    }
  }

  if (source.kind === "profile" || source.kind === "entity_and_profile") {
    const relevantProfile: z.infer<typeof ProfileRow>[] = [];
    for (const pf of source.profileFields) {
      // If fieldNames is empty, take ALL fields in that group
      if (pf.fieldNames.length === 0) {
        const groupFields = profileByGroup.get(pf.fieldGroup) ?? [];
        relevantProfile.push(...groupFields);
      } else {
        for (const fn of pf.fieldNames) {
          const match = allProfile.find(
            (p) => p.field_group === pf.fieldGroup && p.field_name === fn,
          );
          if (match) relevantProfile.push(match);
        }
      }
    }
    if (relevantProfile.length > 0) {
      profileBlock = relevantProfile
        .map((p) => `- ${p.field_name} [${p.field_group}]: ${p.field_value}`)
        .join("\n");
    }
  }

  return { entityBlock, profileBlock };
}

// ── Helper: build system prompt ─────────────────────────────────────
function buildSystemPrompt(family: CheckFamily): string {
  return `You are a due diligence hypothesis generator for the "${family.name}" check family.

Your task: generate specific, falsifiable research questions (hypotheses) that can be verified through public record searches, regulatory filings, and corporate databases.

RULES:
1. Each hypothesis MUST name a specific entity, person, or regulatory body — never generic ("assess risk").
2. Each hypothesis MUST be falsifiable — it has a clear yes/no or quantitative answer.
3. For each hypothesis, provide:
   - question: the specific research question
   - confirming_evidence: what evidence would CONFIRM a risk (what we'd find if there IS a problem)
   - refuting_evidence: what evidence would REFUTE a risk (what we'd find if there is NO problem)
   - thesis_link: which thesis dependency this threatens (null if not directly linked)
   - entity_ref: the exact legal_name of the entity this hypothesis concerns (null for profile-sourced hypotheses about regulators or macro factors)
4. Do NOT generate duplicate or near-duplicate hypotheses.
5. Return ONLY a JSON array. No markdown, no explanation.

${family.guidance}`;
}

// ── Helper: build user prompt ───────────────────────────────────────
function buildUserPrompt(
  family: CheckFamily,
  inputs: { entityBlock: string | null; profileBlock: string | null },
): string {
  const parts: string[] = [
    `Generate hypotheses for the "${family.name}" check family based on the following inputs:`,
  ];

  if (inputs.entityBlock) {
    parts.push(`\nENTITIES:\n${inputs.entityBlock}`);
  }

  if (inputs.profileBlock) {
    parts.push(`\nDEAL PROFILE:\n${inputs.profileBlock}`);
  }

  parts.push(`\nReturn a JSON array of hypothesis objects.`);

  return parts.join("\n");
}
