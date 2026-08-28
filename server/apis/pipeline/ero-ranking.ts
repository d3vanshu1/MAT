/**
 * ERO v2 — Hypothesis ranking (Phase 3, Stage 2)
 *
 * Assigns each hypothesis a deterministic execution_rank so that when
 * Phase 4 research runs one hypothesis at a time and can be interrupted,
 * a partial run leaves the MOST IMPORTANT subset complete, not a random
 * subset.
 *
 * Ranking is graceful degradation, not rationing — no hypotheses are
 * dropped, they are ordered.
 *
 * Deterministic, no LLM.  Ranking is computed in code from three signals
 * already on the hypotheses and their linked profile/entity rows:
 *
 *   1. Thesis exposure (primary) — hypothesis whose thesis_link points
 *      to a thesis_dependency outranks one with no thesis_link.
 *   2. Family weight (secondary) — within the same thesis-exposure tier,
 *      order by CheckFamily.family_weight (higher = earlier).
 *   3. Entity materiality (tertiary) — within the same family and thesis
 *      tier, order by entity rank_signal richness, then stable tiebreak
 *      (entity legal_name alphabetical, hypothesis question alphabetical).
 */
import { z } from "@superblocksteam/sdk-api";
import type { StageResult } from "./ero-stage-contract.js";
import { ERO_FAMILIES } from "./ero-families.js";

// ── Zod schemas for DB reads ────────────────────────────────────────
const HypothesisRow = z.object({
  hypothesis_id: z.string(),
  family: z.string(),
  entity_id: z.string().nullable(),
  thesis_link: z.string().nullable(),
  question: z.string(),
  // execution_rank deliberately NOT loaded — ranking is a pure function
  // of signals (thesis exposure, family weight, entity materiality),
  // never of prior rank.  Safe to re-run from any starting state.
});

const ProfileFieldRow = z.object({
  field_name: z.string(),
});

const EntitySignalRow = z.object({
  entity_id: z.string(),
  legal_name: z.string(),
  rank_signal: z.any().nullable(),
  registration_number: z.string().nullable(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

// ── Build a family_weight lookup from ERO_FAMILIES ──────────────────
const FAMILY_WEIGHT: Record<string, number> = {};
for (const f of ERO_FAMILIES) {
  FAMILY_WEIGHT[f.id] = f.family_weight;
}

// ── Main handler ────────────────────────────────────────────────────
export async function rankHypotheses(
  ctx: any,
  runId: string,
  dealId: string,
): Promise<StageResult> {
  const db = ctx.integrations.ic_diligence_db;

  // ── 1. Load hypotheses ────────────────────────────────────────────
  const hypotheses = await db.query(
    `SELECT hypothesis_id, family, entity_id, thesis_link, question
     FROM ero_hypotheses WHERE run_id = $1`,
    HypothesisRow,
    [runId],
    { label: "Ranking: load hypotheses" },
  );

  if (hypotheses.length === 0) {
    return {
      stage: "rank_hypotheses",
      status: "failed",
      message: "No hypotheses found for this run. generate_hypotheses must complete first.",
    };
  }

  // ── 2. Load thesis_dependency field names (the exposure set) ──────
  const thesisFields = await db.query(
    `SELECT field_name FROM ero_profile
     WHERE run_id = $1 AND field_group = 'thesis_dependency'`,
    ProfileFieldRow,
    [runId],
    { label: "Ranking: load thesis_dependency fields" },
  );
  const thesisFieldSet = new Set(thesisFields.map((f: z.infer<typeof ProfileFieldRow>) => f.field_name.toLowerCase()));

  // ── 3. Load entity rank_signals ───────────────────────────────────
  const entityRows = await db.query(
    `SELECT entity_id, legal_name, rank_signal, registration_number
     FROM ero_entities WHERE run_id = $1`,
    EntitySignalRow,
    [runId],
    { label: "Ranking: load entity signals" },
  );
  const entityMap = new Map<
    string,
    { legal_name: string; rank_signal: any; registration_number: string | null }
  >();
  for (const e of entityRows) {
    entityMap.set(e.entity_id, {
      legal_name: e.legal_name,
      rank_signal: e.rank_signal,
      registration_number: e.registration_number,
    });
  }

  // ── 4. Compute sort key per hypothesis ────────────────────────────
  type RankedItem = {
    hypothesis_id: string;
    family: string;
    entity_id: string | null;
    thesis_link: string | null;
    question: string;
    // Computed signals
    thesisExposure: number;       // 1 = linked to thesis_dependency, 0 = not
    familyWeight: number;         // from CheckFamily.family_weight
    entityMateriality: number;    // higher = more checkable/material
    tiebreak: string;             // stable alphabetical tiebreak
    rank_reason: string;          // auditable explanation
  };

  const items: RankedItem[] = hypotheses.map((h: z.infer<typeof HypothesisRow>) => {
    // ── Signal 1: Thesis exposure ─────────────────────────────────
    // A hypothesis is thesis-linked if thesis_link is non-null AND
    // the linked value matches a thesis_dependency field_name.
    const hasThesisLink = h.thesis_link != null && h.thesis_link.trim() !== "";
    const thesisMatchesField =
      hasThesisLink && thesisFieldSet.has(h.thesis_link!.toLowerCase());
    // Even if thesis_link doesn't exactly match a field_name, having
    // any thesis_link indicates the hypothesis targets a thesis concern.
    const thesisExposure = hasThesisLink ? (thesisMatchesField ? 2 : 1) : 0;

    const thesisReasonPart =
      thesisExposure === 2
        ? `thesis-linked: ${h.thesis_link} (matches thesis_dependency)`
        : thesisExposure === 1
          ? `thesis-linked: ${h.thesis_link} (no exact field match)`
          : "no thesis_link";

    // ── Signal 2: Family weight ───────────────────────────────────
    const familyWeight = FAMILY_WEIGHT[h.family] ?? 1;
    const familyReasonPart = `family: ${h.family} (weight ${familyWeight})`;

    // ── Signal 3: Entity materiality ──────────────────────────────
    let entityMateriality = 0;
    let entityReasonPart = "no entity";

    if (h.entity_id) {
      const ent = entityMap.get(h.entity_id);
      if (ent) {
        // Base: entity exists = 1
        entityMateriality = 1;
        const reasonParts: string[] = [];

        // Registration number present = more checkable
        if (ent.registration_number) {
          entityMateriality += 2;
          reasonParts.push("reg_number present");
        }

        // rank_signal richness: count non-null keys
        if (ent.rank_signal && typeof ent.rank_signal === "object") {
          const sig = ent.rank_signal as Record<string, unknown>;
          const sigKeys = Object.keys(sig).filter(
            (k) => sig[k] != null && sig[k] !== "",
          );
          entityMateriality += sigKeys.length;
          if (sigKeys.length > 0) {
            reasonParts.push(`rank_signal keys: ${sigKeys.join(", ")}`);
          }
        }

        entityReasonPart = `entity: ${ent.legal_name}${
          reasonParts.length > 0 ? ` (${reasonParts.join("; ")})` : ""
        }`;
      } else {
        entityReasonPart = "entity: linked but not found in manifest";
      }
    }

    // ── Tiebreak: stable alphabetical ─────────────────────────────
    const entityName = h.entity_id
      ? (entityMap.get(h.entity_id)?.legal_name ?? "")
      : "";
    const tiebreak = `${entityName.toLowerCase()}|${h.question.toLowerCase()}`;

    const rank_reason = `${thesisReasonPart}; ${familyReasonPart}; ${entityReasonPart}`;

    return {
      hypothesis_id: h.hypothesis_id,
      family: h.family,
      entity_id: h.entity_id,
      thesis_link: h.thesis_link,
      question: h.question,
      thesisExposure,
      familyWeight,
      entityMateriality,
      tiebreak,
      rank_reason,
    };
  });

  // ── 5. Sort: signal 1 DESC, signal 2 DESC, signal 3 DESC, tiebreak ASC
  items.sort((a, b) => {
    // Primary: thesis exposure (higher first)
    if (a.thesisExposure !== b.thesisExposure)
      return b.thesisExposure - a.thesisExposure;
    // Secondary: family weight (higher first)
    if (a.familyWeight !== b.familyWeight)
      return b.familyWeight - a.familyWeight;
    // Tertiary: entity materiality (higher first)
    if (a.entityMateriality !== b.entityMateriality)
      return b.entityMateriality - a.entityMateriality;
    // Tiebreak: alphabetical (stable)
    return a.tiebreak.localeCompare(b.tiebreak);
  });

  // ── 6. Assign execution_rank = 1..N ───────────────────────────────
  //
  // Single atomic UPDATE via VALUES list.  One statement = one implicit
  // transaction.  Every row gets a distinct final rank in the same
  // statement, so UNIQUE(run_id, execution_rank) never sees an
  // intermediate collision.  No negative-shift phase needed.
  //
  // Re-run safe: ranks are computed purely from signals, and this
  // statement overwrites whatever execution_rank currently exists
  // (positive, negative, or already-final) in one atomic pass.

  // Two-phase rank assignment to avoid intermediate unique-constraint
  // violations.  PostgreSQL checks UNIQUE(run_id, execution_rank) row-by-row
  // within a single UPDATE, so swapping ranks (e.g. A:1→2, B:2→1) can fail
  // when one row is processed before the other.
  //
  // Phase 1: shift all ranks to negative (guaranteed unique, clears the space)
  // Phase 2: assign final positive ranks 1..N
  await db.execute(
    `UPDATE ero_hypotheses
     SET execution_rank = -execution_rank
     WHERE run_id = $1 AND execution_rank > 0`,
    [runId],
    { label: "Ranking: phase 1 — shift to negative" },
  );

  const valueParts: string[] = [];
  const params: any[] = [runId]; // $1 = runId
  let paramIdx = 2;

  for (let i = 0; i < items.length; i++) {
    valueParts.push(`($${paramIdx}::uuid, $${paramIdx + 1}::int)`);
    params.push(items[i].hypothesis_id, i + 1);
    paramIdx += 2;
  }

  await db.execute(
    `UPDATE ero_hypotheses AS h
     SET execution_rank = v.new_rank
     FROM (VALUES ${valueParts.join(", ")}) AS v(hid, new_rank)
     WHERE h.hypothesis_id = v.hid AND h.run_id = $1`,
    params,
    { label: `Ranking: phase 2 — assign final ranks 1..${items.length}` },
  );

  // ── 7. Build stageData ────────────────────────────────────────────
  const rankedList = items.map((item, idx) => ({
    execution_rank: idx + 1,
    family: item.family,
    entity_id: item.entity_id,
    thesis_link: item.thesis_link,
    question: item.question.length > 120 ? item.question.slice(0, 117) + "..." : item.question,
    rank_reason: item.rank_reason,
  }));

  const top5 = rankedList.slice(0, 5).map((r) => ({
    rank: r.execution_rank,
    family: r.family,
    reason: r.rank_reason,
    question_preview: r.question,
  }));

  // Check: programme (valuation, profile-sourced, thesis-linked) and
  // regulatory hypotheses should be in the top tier
  const programmeInTopTier = rankedList
    .filter((r) => r.family === "valuation" && r.entity_id === null)
    .some((r) => r.execution_rank <= Math.ceil(items.length * 0.3));

  const regulatoryInTopTier = rankedList
    .filter((r) => r.family === "regulatory")
    .some((r) => r.execution_rank <= Math.ceil(items.length * 0.3));

  const macroRanks = rankedList
    .filter((r) => r.family === "macro")
    .map((r) => r.execution_rank);

  // Macro invariant (absolute, not percentile):
  // No macro hypothesis may outrank any thesis-linked hypothesis.
  // Compute max rank among thesis-linked hypotheses (thesisExposure >= 1),
  // and assert min(macroRanks) > max(thesisLinkedRanks).
  const thesisLinkedRanks = items
    .map((item, idx) => ({ rank: idx + 1, thesisExposure: item.thesisExposure }))
    .filter((r) => r.thesisExposure >= 1)
    .map((r) => r.rank);

  const maxThesisLinkedRank =
    thesisLinkedRanks.length > 0 ? Math.max(...thesisLinkedRanks) : 0;
  const minMacroRank =
    macroRanks.length > 0 ? Math.min(...macroRanks) : items.length + 1;

  const macroBelowAllThesisLinked =
    macroRanks.length > 0 && thesisLinkedRanks.length > 0
      ? minMacroRank > maxThesisLinkedRank
      : true; // vacuously true if either set is empty

  return {
    stage: "rank_hypotheses",
    status: "complete",
    message: `${items.length} hypotheses ranked | programme_in_top_tier: ${programmeInTopTier} | regulatory_in_top_tier: ${regulatoryInTopTier} | macro_below_all_thesis_linked: ${macroBelowAllThesisLinked} (min_macro=${minMacroRank} > max_thesis=${maxThesisLinkedRank})`,
    stageData: {
      totalRanked: items.length,
      rankedList,
      top5,
      programmeInTopTier,
      regulatoryInTopTier,
      macroBelowAllThesisLinked,
      minMacroRank,
      maxThesisLinkedRank,
      macroRanks,
    },
  };
}
