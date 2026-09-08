/**
 * Migration 048 — deal_config table.
 *
 * Centralises per-deal parameters that were previously hardcoded as module-level
 * constants scoped to the SCG / Project Saint deal.
 *
 * Seeds the SCG row with the exact values removed in W1/W2 so SCG behaviour is
 * unchanged after the refactor.
 *
 * Follows the precedent of migration 047 / oa_deal_config.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "RunMigration048",
  description: "Create deal_config table and seed SCG row",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dryRun: z.boolean().default(true),
  }),

  output: z.object({
    tableCreated: z.boolean(),
    scgSeeded: z.boolean(),
    dryRun: z.boolean(),
  }),

  async run(ctx, { dryRun }) {
    const db = ctx.integrations.db;

    if (dryRun) {
      console.log("[Migration048] DRY RUN — no changes will be made.");
      return { tableCreated: false, scgSeeded: false, dryRun: true };
    }

    // ── Create table ─────────────────────────────────────────────────────
    await db.execute(
      `CREATE TABLE IF NOT EXISTS deal_config (
        deal_id                UUID PRIMARY KEY,
        deal_code              TEXT NOT NULL,
        deal_label             TEXT NOT NULL,
        ic_memo_doc_ids        UUID[] NOT NULL DEFAULT '{}',
        latest_memo_doc_ids    UUID[] NOT NULL DEFAULT '{}',
        priority_doc_ids       UUID[] NOT NULL DEFAULT '{}',
        adviser_workstreams    TEXT[] NOT NULL DEFAULT '{}',
        deal_context           TEXT NULL,
        enterprise_value_label TEXT NULL,
        base_case_label        TEXT NULL,
        currency_symbol        TEXT NOT NULL DEFAULT '$',
        materiality_abs_floor  BIGINT NULL,
        critical_abs_threshold BIGINT NULL,
        numeric_verify_config  JSONB NULL,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      [],
      { label: "Create deal_config table" },
    );

    await db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS deal_config_code_uniq ON deal_config (upper(deal_code))`,
      [],
      { label: "Create deal_code unique index" },
    );

    // ── Seed SCG row ─────────────────────────────────────────────────────
    // Values are the exact constants removed from each W1/W2 file.
    await db.execute(
      `INSERT INTO deal_config (
        deal_id, deal_code, deal_label,
        ic_memo_doc_ids, latest_memo_doc_ids, priority_doc_ids,
        adviser_workstreams,
        deal_context,
        enterprise_value_label, base_case_label,
        currency_symbol,
        materiality_abs_floor, critical_abs_threshold,
        numeric_verify_config
      ) VALUES (
        $1::uuid, $2, $3,
        $4::uuid[], $5::uuid[], $6::uuid[],
        $7::text[],
        $8,
        $9, $10,
        $11,
        $12, $13,
        $14::jsonb
      ) ON CONFLICT (deal_id) DO NOTHING`,
      [
        // deal_id
        "c46b4129-8a16-48ae-ad3a-1da061255445",
        // deal_code, deal_label
        "SCG", "Project Saint / SCG",
        // ic_memo_doc_ids (W1.2 lines 46-49)
        "{8fb7f474-9adf-4c02-b991-e180359812ea,31b3df2f-1653-42e5-8ad1-e58ab74e0399,6197a6b2-a26c-423a-84b3-2766b0710b10,440a86fb-93d6-4fd6-8d42-32f7047f8958}",
        // latest_memo_doc_ids (W1.2 lines 52-53)
        "{31b3df2f-1653-42e5-8ad1-e58ab74e0399,6197a6b2-a26c-423a-84b3-2766b0710b10}",
        // priority_doc_ids (W2.4 lines 390-392)
        "{5c0e0060-0d36-4971-88e9-3bc440041897,989537e9-cad0-4588-b7d0-5391d29a44d8,b5ae5ba1-ef41-4947-a706-7c888c896e6a}",
        // adviser_workstreams (W2.1)
        "{EQTR,Hakluyt,Kolayo}",
        // deal_context (W1.1 line 66 verbatim)
        "Project Saint / SCG. Enterprise Value £655m (11.6x LTM Sep-26 Cash EBITDA), plus £85m earn-out above 2.5x MoM. PEP base case: 23.0% IRR / 2.8x MoM; 6x opening leverage. Thesis: (1) verticalisation — own-IP platforms Surgery Connect (55% GP share) and Evonex growing ~30%; (2) vendor-agnostic SME comms one-stop-shop, 35k+ customers, ~7% churn; (3) industrialised M&A, ~50 acquisitions, £6m EBITDA near-term pipeline; (4) re-rating as own-IP mix grows 30%→43%; (5) backable management. Key return drivers: retention holding, M&A continuing, AI ancillary upsell into Surgery Connect, education vertical for Evonex.",
        // enterprise_value_label, base_case_label (W1.1)
        "£655m EV", "23% IRR / 2.8x MoM",
        // currency_symbol
        "£",
        // materiality_abs_floor, critical_abs_threshold (W1.3)
        2000000, 10000000,
        // numeric_verify_config (W1.4)
        JSON.stringify({
          crossAgreementSheets: ["FS Summary", "FS Summary (hardcoded)"],
          extraLabelPatterns: ["^Surgery\\\\s+Intellect\\\\s+GP"],
          absThreshold: 1000,
          materialityAbsFloor: 500000,
        }),
      ],
      { label: "Seed SCG deal_config row" },
    );

    console.log("[Migration048] deal_config table created, SCG row seeded.");

    return { tableCreated: true, scgSeeded: true, dryRun: false };
  },
});
