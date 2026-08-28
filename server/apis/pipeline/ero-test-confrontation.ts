/**
 * ERO v2 — Test harness for Corpus Confrontation (Phase 5)
 *
 * Confronts the top-N findings for a given run against the deal's
 * document corpus. Returns RAW per-finding data:
 *   - finding title/severity
 *   - every corpus query run with hit_count and best hit (receipts)
 *   - model's classification
 *   - downgrade flag if the magnitude rule fired
 *   - for understated: both-figures pair
 *
 * Plus checks:
 *   - classification distribution
 *   - count of understated that were downgraded for missing figures
 *   - consistency assertion: every unknown_to_deal_team finding has
 *     corpus_checks rows showing genuinely low hit counts
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { corpusConfrontation } from "./ero-corpus-confrontation.js";

// ── Integration ─────────────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── DB row schemas ──────────────────────────────────────────────────
const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
  current_stage: z.string(),
  stage_status: z.string(),
});

const FindingRow = z.object({
  finding_id: z.string(),
  title: z.string(),
  severity: z.string(),
  verdict: z.string(),
});

const CountRow = z.object({ cnt: z.coerce.number() });

const CorpusCheckRow = z.object({
  check_id: z.string(),
  finding_id: z.string(),
  query_text: z.string(),
  hit_count: z.coerce.number(),
  best_hit_snippet: z.string().nullable(),
  best_hit_document_id: z.string().nullable(),
  classification: z.string().nullable(),
});

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "EroTestConfrontation",
  description: "Test harness for ERO corpus confrontation stage",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    claude: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    runId: z.string(),
    maxFindings: z.number().optional(),
    targetFindingId: z.string().optional(),
  }),

  output: z.object({
    runId: z.string(),
    dealId: z.string(),
    stageResult: z.object({
      stage: z.string(),
      status: z.string(),
      message: z.string(),
      stageData: z.record(z.unknown()).nullable(),
    }),
    // Per-finding detail
    findingDetails: z.array(
      z.object({
        finding_id: z.string(),
        title: z.string(),
        severity: z.string(),
        classification: z.string(),
        magnitude_downgrade: z.boolean(),
        boilerplate_downgrade: z.boolean(),
        absence_flag: z.boolean(),
        corpus_quote: z.string().nullable(),
        corpus_quoted_value: z.string().nullable(),
        external_quoted_value: z.string().nullable(),
        reasoning: z.string(),
        queries: z.array(
          z.object({
            query_text: z.string(),
            hit_count: z.number(),
            best_hit_snippet: z.string().nullable(),
            best_hit_document_id: z.string().nullable(),
          }),
        ),
      }),
    ),
    // Summary checks
    checks: z.object({
      totalFindings: z.number(),
      findingsConfronted: z.number(),
      classificationDistribution: z.record(z.number()),
      understatedDowngradedCount: z.number(),
      boilerplateDowngradedCount: z.number(),
      unknownWithHighHits: z.number(),
      consistencyPassed: z.boolean(),
      consistencyDetails: z.array(z.string()),
    }),
  }),

  async run(ctx, { runId, maxFindings, targetFindingId }) {
    const db = ctx.integrations.ic_diligence_db;
    const cap = maxFindings ?? 3;

    // ── 1. Load pipeline state ──────────────────────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id, current_stage, stage_status
       FROM ero_pipeline_state
       WHERE run_id = $1`,
      PipelineStateRow,
      [runId],
      { label: "TestConfrontation: load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(`ERO run not found: ${runId}`);
    }

    const dealId = stateRows[0].deal_id;

    // ── 2. Load all findings for this run ───────────────────────────
    const allFindings = await db.query(
      `SELECT f.finding_id, f.title, f.severity, f.verdict
       FROM ero_findings f
       JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
       WHERE h.run_id = $1
       ORDER BY f.created_at ASC`,
      FindingRow,
      [runId],
      { label: "TestConfrontation: load all findings" },
    );

    const totalFindings = allFindings.length;

    // ── 2b. Scope findings: targetFindingId or maxFindings cap ──────
    // Delete corpus_checks for findings OUTSIDE the scope so the
    // handler's NOT EXISTS resume guard processes only the scoped set.
    let scopeDeletedCount = 0;

    if (targetFindingId) {
      // Single-finding mode: delete corpus_checks for every finding
      // in this run EXCEPT the target, so only it gets processed.
      const othersIds = allFindings
        .filter((f) => f.finding_id !== targetFindingId)
        .map((f) => f.finding_id);

      if (othersIds.length > 0) {
        // Also delete existing checks for the TARGET so it re-runs
        await db.execute(
          `DELETE FROM ero_corpus_checks
           WHERE finding_id = $1`,
          [targetFindingId],
          { label: "TestConfrontation: clear target finding checks for re-run" },
        );
      }

      // Insert sentinel corpus_checks for all OTHER findings so the
      // handler's NOT EXISTS guard skips them.
      for (const otherId of othersIds) {
        // Check if this finding already has corpus_checks
        const existing = await db.query(
          `SELECT count(*)::int AS cnt FROM ero_corpus_checks WHERE finding_id = $1`,
          CountRow,
          [otherId],
          { label: `TestConfrontation: check existing for ${otherId.slice(0, 8)}` },
        );
        if (existing[0].cnt === 0) {
          // Insert a placeholder so NOT EXISTS skips this finding
          await db.execute(
            `INSERT INTO ero_corpus_checks
               (finding_id, query_text, hit_count, best_hit_snippet,
                best_hit_document_id, classification)
             VALUES ($1, '[scoped-out]', 0, NULL, NULL, 'scoped_out')`,
            [otherId],
            { label: `TestConfrontation: sentinel for scoped-out ${otherId.slice(0, 8)}` },
          );
          scopeDeletedCount++;
        }
      }
    } else if (allFindings.length > cap) {
      // Cap mode: keep the first `cap` findings, delete corpus_checks
      // for all findings beyond the cap, and insert sentinels for the
      // beyond-cap findings so the handler skips them.
      const keptIds = new Set(
        allFindings.slice(0, cap).map((f) => f.finding_id),
      );
      const beyondCap = allFindings.filter(
        (f) => !keptIds.has(f.finding_id),
      );

      for (const f of beyondCap) {
        // Delete any existing checks for beyond-cap findings
        await db.execute(
          `DELETE FROM ero_corpus_checks WHERE finding_id = $1`,
          [f.finding_id],
          { label: `TestConfrontation: delete beyond-cap ${f.finding_id.slice(0, 8)}` },
        );
        // Insert sentinel so NOT EXISTS skips them
        await db.execute(
          `INSERT INTO ero_corpus_checks
             (finding_id, query_text, hit_count, best_hit_snippet,
              best_hit_document_id, classification)
           VALUES ($1, '[capped-out]', 0, NULL, NULL, 'capped_out')`,
          [f.finding_id],
          { label: `TestConfrontation: sentinel for capped-out ${f.finding_id.slice(0, 8)}` },
        );
        scopeDeletedCount++;
      }

      // Also clear checks for kept findings so they re-run
      for (const f of allFindings.slice(0, cap)) {
        await db.execute(
          `DELETE FROM ero_corpus_checks WHERE finding_id = $1`,
          [f.finding_id],
          { label: `TestConfrontation: clear kept finding ${f.finding_id.slice(0, 8)} for re-run` },
        );
      }
    }

    // ── 3. Run confrontation ────────────────────────────────────────
    const result = await corpusConfrontation(ctx, runId, dealId);

    // ── 4. Load corpus_checks for all findings in this run ──────────
    const corpusChecks = await db.query(
      `SELECT cc.check_id, cc.finding_id, cc.query_text, cc.hit_count,
              cc.best_hit_snippet, cc.best_hit_document_id, cc.classification
       FROM ero_corpus_checks cc
       JOIN ero_findings f ON f.finding_id = cc.finding_id
       JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
       WHERE h.run_id = $1
       ORDER BY cc.finding_id, cc.checked_at ASC`,
      CorpusCheckRow,
      [runId],
      { label: "TestConfrontation: load all corpus checks" },
    );

    // ── 5. Build per-finding detail from stageData ──────────────────
    const outcomes = (result.stageData as any)?.outcomes ?? [];
    const findingDetails = outcomes.map((o: any) => ({
      finding_id: o.finding_id,
      title: o.title,
      severity: o.severity,
      classification: o.classification,
      magnitude_downgrade: o.magnitude_downgrade,
      boilerplate_downgrade: o.boilerplate_downgrade ?? false,
      absence_flag: o.absence_flag,
      corpus_quote: o.corpus_quote ?? null,
      corpus_quoted_value: o.corpus_quoted_value ?? null,
      external_quoted_value: o.external_quoted_value ?? null,
      reasoning: o.reasoning,
      queries: o.queries,
    }));

    // ── 6. Compute summary checks ───────────────────────────────────
    // Classification distribution
    const distribution: Record<string, number> = {};
    for (const o of outcomes) {
      const cls = o.classification as string;
      distribution[cls] = (distribution[cls] ?? 0) + 1;
    }

    // Understated downgrades
    const understatedDowngradedCount = outcomes.filter(
      (o: any) => o.magnitude_downgrade === true,
    ).length;

    // Boilerplate downgrades
    const boilerplateDowngradedCount = outcomes.filter(
      (o: any) => o.boilerplate_downgrade === true,
    ).length;

    // Unknown with high hits — consistency check
    // For every finding classified as unknown_to_deal_team, check
    // that its corpus_checks rows show genuinely low hit counts.
    const consistencyDetails: string[] = [];
    let unknownWithHighHits = 0;

    for (const o of outcomes) {
      if (o.classification === "unknown_to_deal_team") {
        const findingChecks = corpusChecks.filter(
          (cc: z.infer<typeof CorpusCheckRow>) =>
            cc.finding_id === o.finding_id,
        );
        const totalHitsForFinding = findingChecks.reduce(
          (sum: number, cc: z.infer<typeof CorpusCheckRow>) =>
            sum + cc.hit_count,
          0,
        );

        if (totalHitsForFinding >= 3) {
          unknownWithHighHits++;
          consistencyDetails.push(
            `Finding "${o.title}" classified unknown_to_deal_team but ` +
              `corpus queries returned ${totalHitsForFinding} total hits ` +
              `across ${findingChecks.length} queries — inspect manually.`,
          );
        }
      }
    }

    const consistencyPassed = unknownWithHighHits === 0;

    return {
      runId,
      dealId,
      stageResult: {
        stage: result.stage,
        status: result.status,
        message: result.message,
        stageData: result.stageData ?? null,
      },
      findingDetails,
      checks: {
        totalFindings,
        findingsConfronted: outcomes.length,
        classificationDistribution: distribution,
        understatedDowngradedCount,
        boilerplateDowngradedCount,
        unknownWithHighHits,
        consistencyPassed,
        consistencyDetails,
      },
    };
  },
});
