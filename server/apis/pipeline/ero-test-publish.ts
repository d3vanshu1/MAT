/**
 * ERO v2 — Test harness for Publish step
 *
 * Runs PublishEroToModuleOutputs, then reads back the published
 * module_runs + module_outputs rows and returns RAW diagnostics.
 *
 * Checks:
 *   - findings count matches ero_findings count
 *   - every published finding's full_analysis contains its evidence URLs
 *   - module_run status is 'completed'
 *   - executive_header contains classification counts
 *   - full_report_markdown is non-empty
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ── Schemas ─────────────────────────────────────────────────────────

const PipelineStateRow = z.object({
  run_id: z.string(),
  deal_id: z.string(),
});

const ModuleRunRow = z.object({
  id: z.string(),
  deal_id: z.string(),
  module_id: z.string(),
  status: z.string(),
  triggered_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const ModuleOutputRow = z.object({
  id: z.string(),
  module_run_id: z.string(),
  executive_header: z.string().nullable(),
  findings: z.any(),
  full_report_markdown: z.string().nullable(),
});

const EroFindingCountRow = z.object({
  cnt: z.coerce.number(),
});

const EvidenceUrlRow = z.object({
  finding_id: z.string(),
  url: z.string(),
});

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "EroTestPublish",
  description: "Test harness for ERO publish — verifies module_outputs",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    runId: z.string(),
  }),

  output: z.object({
    runId: z.string(),
    dealId: z.string(),
    publishResult: z.any(),
    // Read-back
    moduleRun: z.any(),
    moduleOutput: z.object({
      id: z.string(),
      executiveHeader: z.string().nullable(),
      findingsCount: z.number(),
      fullReportMarkdownLength: z.number(),
      // Sample: first 3 findings showing URLs survived
      sampleFindings: z.array(z.any()),
    }).nullable(),
    // Checks
    checks: z.object({
      eroFindingsCount: z.number(),
      publishedFindingsCount: z.number(),
      countsMatch: z.boolean(),
      moduleRunStatusCompleted: z.boolean(),
      everyFindingHasUrlsInFullAnalysis: z.boolean(),
      findingsMissingUrls: z.array(z.string()),
      executiveHeaderHasClassifications: z.boolean(),
      fullReportNonEmpty: z.boolean(),
    }),
  }),

  async run(ctx, { runId }) {
    const db = ctx.integrations.db;

    // ── 1. Load pipeline state ──────────────────────────────────────
    const stateRows = await db.query(
      `SELECT run_id, deal_id FROM ero_pipeline_state WHERE run_id = $1`,
      PipelineStateRow,
      [runId],
      { label: "TestPublish: load pipeline state" },
    );

    if (stateRows.length === 0) {
      throw new Error(`ERO run not found: ${runId}`);
    }

    const dealId = stateRows[0].deal_id;

    // ── 2. Run publish ──────────────────────────────────────────────
    // Import and call the publish function inline
    const { default: PublishApi } = await import(
      "./publish-ero-to-module-outputs.js"
    );
    const publishResult = await PublishApi.run(ctx, { runId });

    // ── 3. Read back module_runs ────────────────────────────────────
    const moduleRuns = await db.query(
      `SELECT id, deal_id, module_id, status,
              triggered_at::text AS triggered_at,
              completed_at::text AS completed_at
       FROM module_runs WHERE id = $1::uuid LIMIT 1`,
      ModuleRunRow,
      [runId],
      { label: "TestPublish: read back module_run" },
    );

    const moduleRun = moduleRuns[0] ?? null;

    // ── 4. Read back module_outputs ─────────────────────────────────
    const outputs = await db.query(
      `SELECT id, module_run_id, executive_header, findings,
              full_report_markdown
       FROM module_outputs WHERE module_run_id = $1::uuid LIMIT 1`,
      ModuleOutputRow,
      [runId],
      { label: "TestPublish: read back module_output" },
    );

    const output = outputs[0] ?? null;

    // ── 5. Get ERO findings count ───────────────────────────────────
    const countRows = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM ero_findings f
       JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
       WHERE h.run_id = $1`,
      EroFindingCountRow,
      [runId],
      { label: "TestPublish: count ero_findings" },
    );

    const eroFindingsCount = countRows[0]?.cnt ?? 0;

    // ── 6. Get evidence URLs per finding ────────────────────────────
    const evidenceUrls = await db.query(
      `SELECT DISTINCT f.finding_id, e.url
       FROM ero_findings f
       JOIN ero_hypotheses h ON h.hypothesis_id = f.hypothesis_id
       JOIN ero_evidence e ON e.hypothesis_id = f.hypothesis_id
       WHERE h.run_id = $1`,
      EvidenceUrlRow,
      [runId],
      { label: "TestPublish: load evidence URLs for check" },
    );

    // Group URLs by finding_id
    const urlsByFinding = new Map<string, string[]>();
    for (const row of evidenceUrls) {
      const arr = urlsByFinding.get(row.finding_id) ?? [];
      arr.push(row.url);
      urlsByFinding.set(row.finding_id, arr);
    }

    // ── 7. Structural checks ────────────────────────────────────────

    const publishedFindings: any[] = output
      ? Array.isArray(output.findings)
        ? output.findings
        : typeof output.findings === "string"
          ? JSON.parse(output.findings)
          : []
      : [];

    const publishedFindingsCount = publishedFindings.length;
    const countsMatch = publishedFindingsCount === eroFindingsCount;

    const moduleRunStatusCompleted =
      moduleRun?.status === "completed";

    // Check: every finding's full_analysis contains its evidence URLs
    const findingsMissingUrls: string[] = [];
    for (const pf of publishedFindings) {
      const fa: string = pf.full_analysis ?? "";
      const urls = urlsByFinding.get(pf.finding_id) ?? [];
      for (const url of urls) {
        if (!fa.includes(url)) {
          findingsMissingUrls.push(
            `${pf.finding_id}: missing ${url.slice(0, 60)}`,
          );
          break; // one miss per finding is enough
        }
      }
    }

    const everyFindingHasUrlsInFullAnalysis =
      findingsMissingUrls.length === 0;

    // Check: executive_header mentions classification terms
    const eh = output?.executive_header ?? "";
    const executiveHeaderHasClassifications =
      eh.includes("Understated") &&
      eh.includes("Unknown") &&
      eh.includes("Known");

    const fullReportNonEmpty =
      (output?.full_report_markdown ?? "").length > 100;

    return {
      runId,
      dealId,
      publishResult,
      moduleRun,
      moduleOutput: output
        ? {
            id: output.id,
            executiveHeader: output.executive_header,
            findingsCount: publishedFindingsCount,
            fullReportMarkdownLength: (
              output.full_report_markdown ?? ""
            ).length,
            sampleFindings: publishedFindings.slice(0, 3),
          }
        : null,
      checks: {
        eroFindingsCount,
        publishedFindingsCount,
        countsMatch,
        moduleRunStatusCompleted,
        everyFindingHasUrlsInFullAnalysis,
        findingsMissingUrls: findingsMissingUrls.slice(0, 10),
        executiveHeaderHasClassifications,
        fullReportNonEmpty,
      },
    };
  },
});
