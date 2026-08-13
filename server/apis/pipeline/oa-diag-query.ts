import { api, z, postgres } from "@superblocksteam/sdk-api";

const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ScopeCoverageSchema = z.object({
  total_data_points: z.coerce.number(),
  exact_none_stated: z.coerce.number(),
  contaminated: z.coerce.number(),
  exact_unscoped: z.coerce.number(),
  invented_variants: z.coerce.number(),
});

const AdviserSeverityDistSchema = z.object({
  document_id: z.string(),
  file_name: z.string(),
  adviser_severity: z.string().nullable(),
  count: z.coerce.number(),
});

const FactByTopicSchema = z.object({
  fact_id: z.string(),
  predicate: z.string(),
  object_value: z.string().nullable(),
  confidence: z.string().nullable(),
  source_document_id: z.string().nullable(),
  source_chunk_index: z.coerce.number().nullable(),
  created_at: z.string().nullable(),
});

const FactByPredicateSchema = z.object({
  fact_id: z.string(),
  predicate: z.string(),
  object_value: z.string().nullable(),
  confidence: z.string().nullable(),
  source_document_id: z.string().nullable(),
  source_chunk_index: z.coerce.number().nullable(),
  topic_id: z.string().nullable(),
});

const FindingSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  materiality_tier: z.string().nullable(),
  gap_kind: z.string().nullable(),
  created_at: z.string().nullable(),
});

const FieldProbeSchema = z.object({
  field_value: z.string().nullable(),
  count: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Query type discriminated union
// ---------------------------------------------------------------------------
const QueryInput = z.discriminatedUnion("query", [
  z.object({
    query: z.literal("scope_coverage"),
    dealId: z.string(),
  }),
  z.object({
    query: z.literal("adviser_severity_dist"),
    dealId: z.string(),
  }),
  z.object({
    query: z.literal("facts_by_topic"),
    runId: z.string(),
    topicId: z.string(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    query: z.literal("facts_by_predicate"),
    dealId: z.string(),
    predicateLike: z.string(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    query: z.literal("findings_for_run"),
    runId: z.string(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    query: z.literal("extraction_field_probe"),
    dealId: z.string(),
    fieldName: z.string(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  }),
]);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export default api({
  name: "OaDiagQuery",
  description: "Fixed parameterised diagnostic queries for extraction and OA tables (SELECT only)",

  integrations: {
    db: postgres(IC_DILIGENCE_DB),
  },

  input: QueryInput,

  output: z.object({
    rows: z.array(z.any()),
    rowCount: z.number(),
  }),

  async run(ctx, input) {
    switch (input.query) {
      // -----------------------------------------------------------------------
      // scope_coverage: aggregate scope_qualifier values across a deal's data_points
      // -----------------------------------------------------------------------
      case "scope_coverage": {
        // The extraction field stores JSON with sanitized braces (﹛﹜ instead of {}).
        // We reverse the sanitization, strip the markdown header, and parse as jsonb.
        const rows = await ctx.integrations.db.query(
          `WITH raw AS (
            SELECT extraction_json->>'extraction' AS ext_text
            FROM universal_extractions
            WHERE deal_id = $1
              AND COALESCE((extraction_json->>'failed')::boolean, false) = false
              AND COALESCE((extraction_json->>'truncated')::boolean, false) = false
              AND extraction_json->>'extraction' IS NOT NULL
          ),
          desanitized AS (
            SELECT REPLACE(REPLACE(ext_text, E'\\uFE5B', '{'), E'\\uFE5C', '}') AS clean_text
            FROM raw
          ),
          parsed AS (
            SELECT (SUBSTRING(clean_text FROM POSITION('{' IN clean_text)))::jsonb AS ext_json
            FROM desanitized
            WHERE clean_text LIKE '%{%'
          ),
          dp AS (
            SELECT jsonb_array_elements(COALESCE(ext_json->'data_points', '[]'::jsonb)) AS dp
            FROM parsed
            WHERE ext_json->'data_points' IS NOT NULL
          )
          SELECT
            COUNT(*)::int AS total_data_points,
            COUNT(*) FILTER (WHERE dp->>'scope_qualifier' = 'NONE_STATED')::int AS exact_none_stated,
            COUNT(*) FILTER (
              WHERE dp->>'scope_qualifier' LIKE '%NONE_STATED%'
                AND dp->>'scope_qualifier' != 'NONE_STATED'
            )::int AS contaminated,
            COUNT(*) FILTER (WHERE dp->>'scope_qualifier' = 'UNSCOPED_BY_NATURE')::int AS exact_unscoped,
            COUNT(*) FILTER (
              WHERE dp->>'scope_qualifier' LIKE 'NONE_STATED%'
                AND dp->>'scope_qualifier' != 'NONE_STATED'
            )::int AS invented_variants
          FROM dp`,
          ScopeCoverageSchema,
          [input.dealId],
          { label: "scope_coverage aggregate" }
        );
        return { rows, rowCount: rows.length };
      }

      // -----------------------------------------------------------------------
      // adviser_severity_dist: count flags by adviser_severity grouped by document
      // -----------------------------------------------------------------------
      case "adviser_severity_dist": {
        const rows = await ctx.integrations.db.query(
          `WITH raw AS (
            SELECT
              ue.document_id,
              d.file_name,
              ue.extraction_json->>'extraction' AS ext_text
            FROM universal_extractions ue
            JOIN documents d ON d.id = ue.document_id
            WHERE ue.deal_id = $1
              AND COALESCE((ue.extraction_json->>'failed')::boolean, false) = false
              AND COALESCE((ue.extraction_json->>'truncated')::boolean, false) = false
              AND ue.extraction_json->>'extraction' IS NOT NULL
          ),
          desanitized AS (
            SELECT
              document_id,
              file_name,
              REPLACE(REPLACE(ext_text, E'\\uFE5B', '{'), E'\\uFE5C', '}') AS clean_text
            FROM raw
          ),
          parsed AS (
            SELECT
              document_id,
              file_name,
              (SUBSTRING(clean_text FROM POSITION('{' IN clean_text)))::jsonb AS ext_json
            FROM desanitized
            WHERE clean_text LIKE '%{%'
          ),
          fl AS (
            SELECT
              document_id,
              file_name,
              jsonb_array_elements(COALESCE(ext_json->'flags', '[]'::jsonb)) AS flag
            FROM parsed
            WHERE ext_json->'flags' IS NOT NULL
          )
          SELECT
            document_id,
            file_name,
            flag->>'adviser_severity' AS adviser_severity,
            COUNT(*)::int AS count
          FROM fl
          GROUP BY document_id, file_name, flag->>'adviser_severity'
          ORDER BY file_name, adviser_severity NULLS LAST`,
          AdviserSeverityDistSchema,
          [input.dealId],
          { label: "adviser_severity distribution" }
        );
        return { rows, rowCount: rows.length };
      }

      // -----------------------------------------------------------------------
      // facts_by_topic: oa_topic_facts joined to oa_facts, filtered by topic_id
      // -----------------------------------------------------------------------
      case "facts_by_topic": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            f.id AS fact_id,
            f.predicate,
            f.object_value,
            f.confidence,
            f.source_document_id,
            f.source_chunk_index,
            f.created_at::text
          FROM oa_topic_facts tf
          JOIN oa_facts f ON f.id = tf.fact_id
          WHERE tf.run_id = $1
            AND tf.topic_id = $2
          ORDER BY f.predicate
          LIMIT $3 OFFSET $4`,
          FactByTopicSchema,
          [input.runId, input.topicId, input.limit, input.offset],
          { label: `facts_by_topic (topic=${input.topicId}, offset=${input.offset})` }
        );
        return { rows, rowCount: rows.length };
      }

      // -----------------------------------------------------------------------
      // facts_by_predicate: oa_facts matching a predicate LIKE pattern
      // -----------------------------------------------------------------------
      case "facts_by_predicate": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            f.id AS fact_id,
            f.predicate,
            f.object_value,
            f.confidence,
            f.source_document_id,
            f.source_chunk_index,
            tf.topic_id
          FROM oa_facts f
          LEFT JOIN oa_topic_facts tf ON tf.fact_id = f.id AND tf.run_id IN (
            SELECT id FROM module_runs WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1
          )
          WHERE f.run_id IN (
            SELECT id FROM module_runs WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1
          )
            AND f.predicate ILIKE $2
          ORDER BY f.predicate
          LIMIT $3 OFFSET $4`,
          FactByPredicateSchema,
          [input.dealId, input.predicateLike, input.limit, input.offset],
          { label: `facts_by_predicate (pattern=${input.predicateLike}, offset=${input.offset})` }
        );
        return { rows, rowCount: rows.length };
      }

      // -----------------------------------------------------------------------
      // findings_for_run: oa_findings with materiality_tier and gap_kind
      // -----------------------------------------------------------------------
      case "findings_for_run": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            id,
            title,
            body,
            materiality_tier,
            gap_kind,
            created_at::text
          FROM oa_findings
          WHERE run_id = $1
          ORDER BY materiality_tier, gap_kind, title
          LIMIT $2 OFFSET $3`,
          FindingSchema,
          [input.runId, input.limit, input.offset],
          { label: `findings_for_run (offset=${input.offset})` }
        );
        return { rows, rowCount: rows.length };
      }

      // -----------------------------------------------------------------------
      // extraction_field_probe: distinct values of a JSON field in data_points with counts
      // -----------------------------------------------------------------------
      case "extraction_field_probe": {
        // Validate field_name to prevent injection (only allow alphanumeric + underscore)
        if (!/^[a-z_][a-z0-9_]*$/i.test(input.fieldName)) {
          throw new Error(`Invalid field_name: must be alphanumeric/underscore, got "${input.fieldName}"`);
        }

        const rows = await ctx.integrations.db.query(
          `WITH raw AS (
            SELECT extraction_json->>'extraction' AS ext_text
            FROM universal_extractions
            WHERE deal_id = $1
              AND COALESCE((extraction_json->>'failed')::boolean, false) = false
              AND COALESCE((extraction_json->>'truncated')::boolean, false) = false
              AND extraction_json->>'extraction' IS NOT NULL
          ),
          desanitized AS (
            SELECT REPLACE(REPLACE(ext_text, E'\\uFE5B', '{'), E'\\uFE5C', '}') AS clean_text
            FROM raw
          ),
          parsed AS (
            SELECT (SUBSTRING(clean_text FROM POSITION('{' IN clean_text)))::jsonb AS ext_json
            FROM desanitized
            WHERE clean_text LIKE '%{%'
          ),
          dp AS (
            SELECT jsonb_array_elements(COALESCE(ext_json->'data_points', '[]'::jsonb)) AS dp
            FROM parsed
            WHERE ext_json->'data_points' IS NOT NULL
          )
          SELECT
            dp->>'${input.fieldName}' AS field_value,
            COUNT(*)::int AS count
          FROM dp
          GROUP BY dp->>'${input.fieldName}'
          ORDER BY count DESC
          LIMIT $2 OFFSET $3`,
          FieldProbeSchema,
          [input.dealId, input.limit, input.offset],
          { label: `extraction_field_probe (field=${input.fieldName}, offset=${input.offset})` }
        );
        return { rows, rowCount: rows.length };
      }

      default: {
        const _exhaustive: never = input;
        throw new Error(`Unknown query: ${(input as { query: string }).query}`);
      }
    }
  },
});
