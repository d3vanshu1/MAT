/**
 * Deal Context Resolver — W0
 *
 * Centralised accessor for per-deal configuration from the `deal_config` table.
 * Fail-closed: throws `DealConfigMissingError` on a missing row or empty
 * required arrays. Never returns `[]` for `icMemoDocIds`. Never falls back
 * to another deal's values.
 *
 * One narrow fallback: if `ic_memo_doc_ids` is empty in deal_config, derive
 * from `documents WHERE document_tag = 'ic_memo'`. If that also returns
 * nothing, throw.
 *
 * Per-invocation Map cache — each API invocation resolves at most once per deal.
 */
import { z } from "@superblocksteam/sdk-api";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class DealConfigMissingError extends Error {
  constructor(dealId: string, field?: string) {
    super(
      field
        ? `deal_config row for deal ${dealId} is missing or has empty required field: ${field}. ` +
          `Seed the row before running pipelines on this deal.`
        : `No deal_config row found for deal ${dealId}. ` +
          `Run migration 048 and seed the row before running pipelines.`,
    );
    this.name = "DealConfigMissingError";
  }
}

// ---------------------------------------------------------------------------
// DealContext interface
// ---------------------------------------------------------------------------

export interface DealContext {
  dealId: string;
  dealCode: string;
  dealLabel: string;
  icMemoDocIds: string[];
  latestMemoDocIds: string[];
  priorityDocIds: string[];
  adviserWorkstreams: string[];
  dealContext: string | null;
  enterpriseValueLabel: string | null;
  baseCaseLabel: string | null;
  currencySymbol: string;
  materialityAbsFloor: number | null;
  criticalAbsThreshold: number | null;
  numericVerifyConfig: NumericVerifyConfig | null;
}

export interface NumericVerifyConfig {
  crossAgreementSheets?: string[];
  extraLabelPatterns?: string[];
  absThreshold?: number;
  materialityAbsFloor?: number;
}

/** Tiering-specific subset (W1.1) */
export interface TieringDealContext {
  prose: string;
  enterpriseValueLabel: string;
  baseCaseLabel: string;
}

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------

const DealConfigRow = z.object({
  deal_id: z.string(),
  deal_code: z.string(),
  deal_label: z.string(),
  ic_memo_doc_ids: z.array(z.string()).nullable(),
  latest_memo_doc_ids: z.array(z.string()).nullable(),
  priority_doc_ids: z.array(z.string()).nullable(),
  adviser_workstreams: z.array(z.string()).nullable(),
  deal_context: z.string().nullable(),
  enterprise_value_label: z.string().nullable(),
  base_case_label: z.string().nullable(),
  currency_symbol: z.string(),
  materiality_abs_floor: z.coerce.number().nullable(),
  critical_abs_threshold: z.coerce.number().nullable(),
  numeric_verify_config: z.any().nullable(),
});

const DocIdRow = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// DB client type (matches PipelineContext.integrations.db)
// ---------------------------------------------------------------------------

type DbClient = {
  query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
};

// ---------------------------------------------------------------------------
// Per-invocation cache
// ---------------------------------------------------------------------------

const _cache = new Map<string, DealContext>();

/** Clear the cache (useful in tests or long-lived processes). */
export function clearDealContextCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the full deal context for a given deal ID.
 * Throws DealConfigMissingError if the row is missing or required fields are empty.
 * Cached per deal ID within the same API invocation.
 */
export async function resolveDealContext(
  db: DbClient,
  dealId: string,
): Promise<DealContext> {
  const cached = _cache.get(dealId);
  if (cached) return cached;

  const rows = await db.query(
    `SELECT deal_id::text, deal_code, deal_label,
            ic_memo_doc_ids::text[], latest_memo_doc_ids::text[],
            priority_doc_ids::text[], adviser_workstreams,
            deal_context, enterprise_value_label, base_case_label,
            currency_symbol,
            materiality_abs_floor, critical_abs_threshold,
            numeric_verify_config
     FROM deal_config
     WHERE deal_id = $1::uuid
     LIMIT 1`,
    DealConfigRow,
    [dealId],
    { label: "Resolve deal_config" },
  );

  if (rows.length === 0) {
    throw new DealConfigMissingError(dealId);
  }

  const row = rows[0];
  let icMemoDocIds = row.ic_memo_doc_ids ?? [];

  // Narrow fallback: derive from documents table if deal_config has empty array
  if (icMemoDocIds.length === 0) {
    const docRows = await db.query(
      `SELECT id::text FROM documents
       WHERE deal_id = $1::uuid AND document_tag = 'ic_memo'
       ORDER BY file_name`,
      DocIdRow,
      [dealId],
      { label: "Fallback: resolve IC memo doc IDs from documents table" },
    );
    icMemoDocIds = docRows.map((r: z.infer<typeof DocIdRow>) => r.id);

    if (icMemoDocIds.length === 0) {
      throw new DealConfigMissingError(dealId, "ic_memo_doc_ids (and no ic_memo documents found in documents table)");
    }

    console.warn(
      `[DealContext] ic_memo_doc_ids empty in deal_config for ${dealId}; ` +
      `derived ${icMemoDocIds.length} from documents table: ${icMemoDocIds.join(", ")}`,
    );
  }

  const ctx: DealContext = {
    dealId: row.deal_id,
    dealCode: row.deal_code,
    dealLabel: row.deal_label,
    icMemoDocIds,
    latestMemoDocIds: row.latest_memo_doc_ids ?? [],
    priorityDocIds: row.priority_doc_ids ?? [],
    adviserWorkstreams: row.adviser_workstreams ?? [],
    dealContext: row.deal_context,
    enterpriseValueLabel: row.enterprise_value_label,
    baseCaseLabel: row.base_case_label,
    currencySymbol: row.currency_symbol,
    materialityAbsFloor: row.materiality_abs_floor,
    criticalAbsThreshold: row.critical_abs_threshold,
    numericVerifyConfig: row.numeric_verify_config
      ? (typeof row.numeric_verify_config === "string"
        ? JSON.parse(row.numeric_verify_config)
        : row.numeric_verify_config) as NumericVerifyConfig
      : null,
  };

  _cache.set(dealId, ctx);
  return ctx;
}

/**
 * W1.1: Load the tiering-specific subset. Throws if deal_context,
 * enterprise_value_label or base_case_label is null.
 */
export async function loadTieringDealContext(
  db: DbClient,
  dealId: string,
): Promise<TieringDealContext> {
  const ctx = await resolveDealContext(db, dealId);

  if (!ctx.dealContext) {
    throw new DealConfigMissingError(dealId, "deal_context (required for materiality tiering)");
  }
  if (!ctx.enterpriseValueLabel) {
    throw new DealConfigMissingError(dealId, "enterprise_value_label (required for materiality tiering)");
  }
  if (!ctx.baseCaseLabel) {
    throw new DealConfigMissingError(dealId, "base_case_label (required for materiality tiering)");
  }

  return {
    prose: ctx.dealContext,
    enterpriseValueLabel: ctx.enterpriseValueLabel,
    baseCaseLabel: ctx.baseCaseLabel,
  };
}

/**
 * W2.2: Resolve deal_id and deal_label from a module_run_id.
 * Returns null values when lookup fails (honest null > wrong id).
 */
export async function resolveDealFromRun(
  db: DbClient,
  runId: string,
): Promise<{ dealId: string | null; dealLabel: string | null }> {
  try {
    const rows = await db.query(
      `SELECT mr.deal_id::text, dc.deal_label
       FROM module_runs mr
       LEFT JOIN deal_config dc ON dc.deal_id = mr.deal_id
       WHERE mr.id = $1::uuid
       LIMIT 1`,
      z.object({ deal_id: z.string().nullable(), deal_label: z.string().nullable() }),
      [runId],
      { label: "Resolve deal from module_run" },
    );
    if (rows.length === 0) return { dealId: null, dealLabel: null };
    return { dealId: rows[0].deal_id, dealLabel: rows[0].deal_label };
  } catch {
    return { dealId: null, dealLabel: null };
  }
}
