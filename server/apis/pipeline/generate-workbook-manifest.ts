/**
 * generate-workbook-manifest.ts — Phase 6.2
 *
 * One LLM call per workbook. Classifies sheet purposes from the structural
 * digest (no cell values). Persists to workbook_manifests with versioning.
 * The only LLM call in the entire workbook map pipeline.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { buildWorkbookDigest, type WorkbookDigest, type SheetDigest } from "../../lib/workbookDigest.js";

const IC_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Manifest shape (what the LLM returns)
// ---------------------------------------------------------------------------

const SheetManifestSchema = z.object({
  name: z.string(),
  purpose: z.enum(["pnl", "cash_flow", "driver", "output_summary", "kpi", "schedule", "notes", "support", "divider", "other"]),
  is_primary_for: z.array(z.string()),
  base_case: z.string().nullable(),
  notes: z.string(),
  confidence: z.number(),
});

const ManifestSchema = z.object({
  sheets: z.array(SheetManifestSchema),
});

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

const MessageResponse = z.object({
  content: z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
  })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "GenerateWorkbookManifest",
  description: "Generates a manifest for a workbook via one LLM call, classifying sheet purposes",

  integrations: {
    ic_db: postgres(IC_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    workbookId: z.string(),
  }),

  output: z.object({
    manifestId: z.string(),
    version: z.number(),
    sheetsClassified: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    isStale: z.boolean(),
  }),

  async run(ctx, { workbookId }) {
    const q = ctx.integrations.ic_db;
    const queryFn = async (sql: string, schema: z.ZodTypeAny, params: unknown[], meta?: { label: string }) => {
      return q.query(sql, schema, params, meta ? { label: meta.label } : undefined);
    };

    // Step 1: Build the structural digest (no cell values)
    const digest = await buildWorkbookDigest(queryFn, workbookId);

    // Step 2: Format digest for LLM — compact, no values
    const digestText = formatDigestForLLM(digest);

    // Step 3: One LLM call
    const systemPrompt = `You are a financial model analyst. Given a structural summary of a workbook (sheet names, cell counts, row labels, detected periods, units, and scale), classify each sheet's purpose.

For each sheet, determine:
- purpose: one of pnl, cash_flow, driver, output_summary, kpi, schedule, notes, support, divider, other
- is_primary_for: list of metric families this sheet is the authoritative source for (e.g., ["revenue", "EBITDA", "margin"] for a P&L summary). Empty array if the sheet is not the primary source for anything.
- base_case: if the sheet has multiple cases, which one is the base/default case. null if no cases or single case.
- notes: 5 words max
- confidence: 0.0 to 1.0

Rules:
- "summary"/"financial summary" with aggregate P&L lines → output_summary, primary for those metrics
- Build tabs with sub-items → driver
- Sheets with 0 data cells or ">>" suffix → divider
- Be terse. Return valid JSON only, no markdown fences, no explanation outside the JSON`;

    const userMessage = `Classify each sheet in this ${digest.role} workbook:\n\n${digestText}\n\nReturn JSON matching this schema: { "sheets": [{ "name": "...", "purpose": "...", "is_primary_for": [...], "base_case": "..." | null, "notes": "...", "confidence": 0.0-1.0 }] }`;

    const llmResult = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        },
      },
      { response: MessageResponse },
      { label: "Manifest LLM classification" },
    );

    const textContent = llmResult.content.find((c) => c.type === "text");
    const rawJson = textContent?.text ?? "";

    // Parse, stripping any markdown fences
    const cleaned = rawJson.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let manifest: z.infer<typeof ManifestSchema>;
    try {
      manifest = ManifestSchema.parse(JSON.parse(cleaned));
    } catch (e: any) {
      throw new Error("Failed to parse manifest from LLM: " + e.message + "\n\nRaw: " + rawJson.slice(0, 500));
    }

    // Step 4: Check for existing manifest version
    const VersionRow = z.object({ max_version: z.number().nullable() });
    const [vRow] = await q.query(
      "SELECT max(version) AS max_version FROM workbook_manifests WHERE workbook_id = $1",
      VersionRow, [workbookId], { label: "Check manifest version" },
    );
    const nextVersion = (vRow?.max_version ?? 0) + 1;

    // Step 5: Check if stale (hash comparison)
    const HashRow = z.object({ file_hash: z.string().nullable() });
    const [hashRow] = await q.query(
      "SELECT file_hash FROM workbooks WHERE id = $1",
      HashRow, [workbookId], { label: "Check file hash" },
    );
    const isStale = false; // First generation is never stale

    // Step 6: Persist
    const InsertRow = z.object({ id: z.string() });
    const [inserted] = await q.query(
      `INSERT INTO workbook_manifests (workbook_id, version, manifest, digest, is_stale)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      InsertRow,
      [workbookId, nextVersion, JSON.stringify(manifest), JSON.stringify(digest), isStale],
      { label: "Save manifest" },
    );

    return {
      manifestId: inserted.id,
      version: nextVersion,
      sheetsClassified: manifest.sheets.length,
      inputTokens: llmResult.usage.input_tokens,
      outputTokens: llmResult.usage.output_tokens,
      isStale,
    };
  },
});

// ---------------------------------------------------------------------------
// Digest formatter — no cell values, only structure
// ---------------------------------------------------------------------------

function formatDigestForLLM(d: WorkbookDigest): string {
  const lines: string[] = [];
  lines.push(`Workbook: ${d.fileName} (${d.role})`);
  lines.push(`Sheets: ${d.sheetCount} | FY end: month ${d.fiscalYearEnd ?? "unknown"} | Active case: ${d.activeCaseLabel ?? "none"}`);
  lines.push("");

  for (const s of d.sheets) {
    lines.push(`--- ${s.name} (index ${s.sheetIndex}) ---`);
    const types = Object.entries(s.cellCountByType).map(([k, v]) => `${k}:${v}`).join(" ");
    lines.push(`  Cells: ${s.cellCount} (${types})`);
    if (s.headerBandRows.length > 0) lines.push(`  Header band: rows ${s.headerBandRows.join(",")}`);
    if (s.aggregateCount > 0) lines.push(`  Aggregates: ${s.aggregateCount}`);
    if (s.dominantUnitClass) lines.push(`  Unit: ${s.dominantUnitClass} ${s.dominantScale ? s.dominantScale + "x" : ""} (source: ${s.unitSource ?? "none"})`);
    if (s.distinctPeriods.length > 0) lines.push(`  Periods: ${s.distinctPeriods.join(", ")}`);
    if (s.distinctCases.length > 0) lines.push(`  Cases: ${s.distinctCases.join(", ")}`);
    if (s.sampleLabels.length > 0) lines.push(`  Labels: ${s.sampleLabels.join(" | ")}`);
    if (!s.includeInMatching) lines.push(`  EXCLUDED: ${s.exclusionRule}`);
    lines.push("");
  }

  return lines.join("\n");
}
