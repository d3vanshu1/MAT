import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const LEGAL_DD_DOC = "e27d46c9-c384-42ed-bc8c-6f04ba8bc474";

const CountSchema = z.object({ cnt: z.coerce.number() });

const ExtractionRow = z.object({
  chunk_index: z.number(),
  extraction_json: z.any(),
});

const FactMatchRow = z.object({
  fact_id: z.string(),
  chunk_index: z.number(),
  predicate: z.string(),
});

const SeverityDistSchema = z.object({
  adviser_severity: z.string(),
  cnt: z.coerce.number(),
});

/**
 * RunMigration026 — Restore genuine adviser_severity on Legal DD facts
 * from the raw extraction source (universal_extractions.extraction_json).
 *
 * Method: Match source flags to oa_facts by predicate text (= description).
 * Two strategies tested:
 *   (a) Strict: (document_id, chunk_index, predicate) — may miss deduped facts
 *       whose surviving chunk_index differs from the chunk carrying the rating.
 *   (b) Relaxed: (document_id, predicate) alone — catches deduped cases where
 *       the genuine rating lives on a later chunk instance.
 *
 * Dry run reports both; the strategy with higher coverage is used for the write.
 *
 * The normalization bug `f.adviser_severity || f.severity` stored general
 * severity values into adviser_severity for ALL facts, including Legal DD.
 * This migration:
 *   Step 1: NULLs adviser_severity on ALL Legal DD facts (clean slate)
 *   Step 2: Restores genuine values from raw extraction
 *   Step 3: Reports restored count and distribution (expect ~61: 6h/7m/48l)
 */
export default api({
  name: "RunMigration026",
  description: "Restores genuine adviser_severity on Legal DD facts from raw extraction source",
  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },
  input: z.object({
    dealId: z.string(),
    dryRun: z.boolean().default(true),
  }),
  output: z.object({
    step1_nulled: z.number(),
    step2_source_flags_with_severity: z.number(),
    match_a_strict: z.object({
      matched_facts: z.number(),
      unique_predicates_matched: z.number(),
    }),
    match_b_relaxed: z.object({
      matched_facts: z.number(),
      unique_predicates_matched: z.number(),
    }),
    orphaned_source_flags: z.object({
      count: z.number(),
      samples: z.array(z.string()),
    }),
    severity_conflicts: z.array(z.string()),
    step3_distribution: z.array(SeverityDistSchema),
    step3_restored_count: z.number(),
    chosen_strategy: z.string(),
    dryRun: z.boolean(),
    warnings: z.array(z.string()),
  }),
  async run(ctx, { dealId, dryRun }) {
    const warnings: string[] = [];

    // ─── Step 1: Count (and optionally NULL) all Legal DD adviser_severity ───
    const [{ cnt: totalLegalDDWithSeverity }] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM oa_facts
       WHERE deal_id = $1
         AND document_id = $2
         AND adviser_severity IS NOT NULL`,
      CountSchema,
      [dealId, LEGAL_DD_DOC],
      { label: "Count Legal DD facts with adviser_severity" }
    );

    // ─── Step 2: Parse raw extractions → find flags with genuine adviser_severity ───
    const extractions = await ctx.integrations.db.query(
      `SELECT chunk_index, extraction_json
       FROM universal_extractions
       WHERE deal_id = $1 AND document_id = $2
       ORDER BY chunk_index`,
      ExtractionRow,
      [dealId, LEGAL_DD_DOC],
      { label: "Load Legal DD raw extractions" }
    );

    interface SourceFlag {
      chunk_index: number;
      description: string;
      adviser_severity: string;
    }
    const sourceFlags: SourceFlag[] = [];

    for (const ext of extractions) {
      const wrapper = typeof ext.extraction_json === "string"
        ? JSON.parse(ext.extraction_json)
        : ext.extraction_json;

      if (wrapper?.failed || wrapper?.error || wrapper?.__failed) continue;

      const rawExtractionStr = wrapper?.extraction;
      if (!rawExtractionStr || typeof rawExtractionStr !== "string") continue;

      // Desanitize braces: ﹛ (U+FE5B) → { and ﹜ (U+FE5C) → }
      const desanitized = rawExtractionStr.replace(/\uFE5B/g, "{").replace(/\uFE5C/g, "}");

      const jsonStart = desanitized.indexOf("{");
      if (jsonStart === -1) continue;

      let extraction: any;
      try {
        extraction = JSON.parse(desanitized.slice(jsonStart));
      } catch {
        warnings.push(`JSON parse failed for chunk ${ext.chunk_index}`);
        continue;
      }

      const flags = extraction.flags;
      if (!Array.isArray(flags)) continue;

      for (const f of flags) {
        const rawSeverity = f.adviser_severity;
        if (!rawSeverity) continue;
        const normalized = rawSeverity.toLowerCase().trim();
        if (!["high", "medium", "low"].includes(normalized)) continue;

        if (f.description) {
          sourceFlags.push({
            chunk_index: ext.chunk_index,
            description: f.description,
            adviser_severity: normalized,
          });
        }
      }
    }

    // ─── Build the predicate→severity map for strategy (b) ───
    // For each unique description, collect all severity values across chunks.
    // If a description appears in multiple chunks with different severities, flag conflict.
    const predicateSeverityMap = new Map<string, { severity: string; chunks: number[] }>();
    const severityConflicts: string[] = [];

    for (const sf of sourceFlags) {
      const existing = predicateSeverityMap.get(sf.description);
      if (!existing) {
        predicateSeverityMap.set(sf.description, {
          severity: sf.adviser_severity,
          chunks: [sf.chunk_index],
        });
      } else {
        existing.chunks.push(sf.chunk_index);
        if (existing.severity !== sf.adviser_severity) {
          severityConflicts.push(
            `"${sf.description.slice(0, 70)}..." → chunks [${existing.chunks.join(",")}] have conflicting severities: ${existing.severity} vs ${sf.adviser_severity}`
          );
          // Keep the higher severity in conflict (high > medium > low)
          const rank = (s: string) => s === "high" ? 3 : s === "medium" ? 2 : 1;
          if (rank(sf.adviser_severity) > rank(existing.severity)) {
            existing.severity = sf.adviser_severity;
          }
        }
      }
    }

    // ─── Strategy (a): strict match on (document_id, chunk_index, predicate) ───
    let matchA_facts = 0;
    let matchA_predicates = 0;
    const matchA_found = new Set<string>();

    for (const sf of sourceFlags) {
      const key = `${sf.chunk_index}:${sf.description}`;
      if (matchA_found.has(key)) continue; // don't double-count same chunk+pred

      const matches = await ctx.integrations.db.query(
        `SELECT fact_id, chunk_index, predicate
         FROM oa_facts
         WHERE deal_id = $1
           AND document_id = $2
           AND chunk_index = $3
           AND fact_type = 'flag'
           AND predicate = $4
         LIMIT 2`,
        FactMatchRow,
        [dealId, LEGAL_DD_DOC, sf.chunk_index, sf.description],
        { label: `Match(a) chunk ${sf.chunk_index}` }
      );

      if (matches.length > 0) {
        matchA_found.add(key);
        matchA_facts += matches.length;
        matchA_predicates++;
      }
    }

    // ─── Strategy (b): relaxed match on (document_id, predicate) alone ───
    let matchB_facts = 0;
    let matchB_predicates = 0;
    const orphanedSamples: string[] = [];
    const matchedPredicateSet = new Set<string>(); // track which predicates matched

    // For each unique predicate in the source, try matching without chunk_index
    for (const [description, entry] of predicateSeverityMap) {
      const matches = await ctx.integrations.db.query(
        `SELECT fact_id, chunk_index, predicate
         FROM oa_facts
         WHERE deal_id = $1
           AND document_id = $2
           AND fact_type = 'flag'
           AND predicate = $3
         LIMIT 2`,
        FactMatchRow,
        [dealId, LEGAL_DD_DOC, description],
        { label: `Match(b) pred` }
      );

      if (matches.length > 0) {
        matchB_facts += matches.length;
        matchB_predicates++;
        matchedPredicateSet.add(description);
      } else {
        // Orphan: source flag has genuine severity but no fact exists
        orphanedSamples.push(
          `[${entry.severity}] chunks=[${entry.chunks.join(",")}]: "${description.slice(0, 80)}..."`
        );
      }
    }

    const orphanCount = predicateSeverityMap.size - matchB_predicates;

    // ─── Determine which strategy to use ───
    const chosenStrategy = matchB_facts > matchA_facts ? "b_relaxed" : "a_strict";

    // ─── Compute distribution from MATCHED predicates only (strategy b) ───
    const distMapB: Record<string, number> = {};
    for (const [description, entry] of predicateSeverityMap) {
      if (matchedPredicateSet.has(description)) {
        distMapB[entry.severity] = (distMapB[entry.severity] || 0) + 1;
      }
    }
    const distributionAll = Object.entries(distMapB).map(([s, c]) => ({
      adviser_severity: s,
      cnt: c,
    }));

    // ─── If not dry run: execute the write using chosen strategy ───
    let restoredCount = 0;
    if (!dryRun) {
      // Step 1 write: NULL all
      await ctx.integrations.db.execute(
        `UPDATE oa_facts
         SET adviser_severity = NULL
         WHERE deal_id = $1
           AND document_id = $2
           AND adviser_severity IS NOT NULL`,
        [dealId, LEGAL_DD_DOC],
        { label: "Step 1: NULL all Legal DD adviser_severity" }
      );

      // Step 2 write: restore using strategy (b) — relaxed predicate match
      for (const [description, entry] of predicateSeverityMap) {
        const matches = await ctx.integrations.db.query(
          `SELECT fact_id, chunk_index, predicate
           FROM oa_facts
           WHERE deal_id = $1
             AND document_id = $2
             AND fact_type = 'flag'
             AND predicate = $3
           LIMIT 2`,
          FactMatchRow,
          [dealId, LEGAL_DD_DOC, description],
          { label: `Restore match` }
        );

        for (const m of matches) {
          await ctx.integrations.db.execute(
            `UPDATE oa_facts
             SET adviser_severity = $1
             WHERE fact_id = $2`,
            [entry.severity, m.fact_id],
            { label: `Restore: ${m.fact_id}` }
          );
          restoredCount++;
        }
      }
    } else {
      // Dry run: restored count = matched facts from chosen strategy
      restoredCount = chosenStrategy === "b_relaxed" ? matchB_facts : matchA_facts;
    }

    return {
      step1_nulled: totalLegalDDWithSeverity,
      step2_source_flags_with_severity: sourceFlags.length,
      match_a_strict: {
        matched_facts: matchA_facts,
        unique_predicates_matched: matchA_predicates,
      },
      match_b_relaxed: {
        matched_facts: matchB_facts,
        unique_predicates_matched: matchB_predicates,
      },
      orphaned_source_flags: {
        count: orphanCount,
        samples: orphanedSamples.slice(0, 15),
      },
      severity_conflicts: severityConflicts.slice(0, 10),
      step3_distribution: distributionAll,
      step3_restored_count: restoredCount,
      chosen_strategy: chosenStrategy,
      dryRun,
      warnings,
    };
  },
});
