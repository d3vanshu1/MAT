/**
 * OA Normalization Report — R1–R10
 *
 * Lightweight read-only queries against oa_facts, oa_chunk_map, and
 * universal_extractions to verify the P2 STEP 1 normalization.
 */
import { api, z, postgres } from "@superblocksteam/sdk-api";
import { CHUNK_CHARS } from "./extraction-prompt.js";

const DB_ID = "ba09e2b9-2715-4460-8131-896f50b0c414";

export default api({
  name: "OaNormalizationReport",
  description: "Delivers R1-R10 verification reports for OA fact normalization.",
  integrations: {
    db: postgres(DB_ID),
  },
  input: z.object({
    dealId: z.string(),
    report: z.enum([
      "R1_per_document",
      "R2_by_fact_type",
      "R3_by_document_role",
      "R4_expected_vs_actual_chunks",
      "R5_scope_qualifier_dist",
      "R6_adviser_severity_by_doc",
      "R7_churn_facts",
      "R8_offset_verification",
      "R9_chunk_map_count",
      "R10_verbatim_snippet_check",
    ]),
  }),
  output: z.object({
    report: z.string(),
    rows: z.array(z.any()),
    rowCount: z.number(),
  }),
  async run(ctx, { dealId, report }) {
    switch (report) {
      // R1: Per document summary
      case "R1_per_document": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            document_name,
            COUNT(DISTINCT chunk_index) as chunks_processed,
            COUNT(*) as facts_emitted
          FROM oa_facts
          WHERE deal_id = $1::uuid
          GROUP BY document_name
          ORDER BY document_name
          LIMIT 10`,
          z.object({ document_name: z.string(), chunks_processed: z.coerce.number(), facts_emitted: z.coerce.number() }),
          [dealId],
          { label: "R1: per document" }
        );
        return { report: "R1_per_document", rows, rowCount: rows.length };
      }

      // R2: Fact count by fact_type
      case "R2_by_fact_type": {
        const rows = await ctx.integrations.db.query(
          `SELECT fact_type, COUNT(*) as count
           FROM oa_facts WHERE deal_id = $1::uuid
           GROUP BY fact_type ORDER BY count DESC LIMIT 10`,
          z.object({ fact_type: z.string(), count: z.coerce.number() }),
          [dealId],
          { label: "R2: by fact_type" }
        );
        return { report: "R2_by_fact_type", rows, rowCount: rows.length };
      }

      // R3: Fact count by document_role
      case "R3_by_document_role": {
        const rows = await ctx.integrations.db.query(
          `SELECT document_role, COUNT(*) as count
           FROM oa_facts WHERE deal_id = $1::uuid
           GROUP BY document_role ORDER BY count DESC LIMIT 10`,
          z.object({ document_role: z.string(), count: z.coerce.number() }),
          [dealId],
          { label: "R3: by document_role" }
        );
        return { report: "R3_by_document_role", rows, rowCount: rows.length };
      }

      // R4: Expected vs actual chunk count per document
      case "R4_expected_vs_actual_chunks": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            d.file_name,
            CEIL(LENGTH(d.parsed_text)::float / ${CHUNK_CHARS})::int as expected_chunks,
            COALESCE(ue.actual_chunks, 0) as actual_extracted_chunks,
            COALESCE(cm.chunk_map_rows, 0) as chunk_map_rows
          FROM documents d
          LEFT JOIN (
            SELECT document_id, COUNT(*) as actual_chunks
            FROM universal_extractions WHERE deal_id = $1
            GROUP BY document_id
          ) ue ON ue.document_id = d.id
          LEFT JOIN (
            SELECT document_id, COUNT(*) as chunk_map_rows
            FROM oa_chunk_map WHERE deal_id = $1::uuid
            GROUP BY document_id
          ) cm ON cm.document_id = d.id
          WHERE d.deal_id = $1 AND d.parsed_text IS NOT NULL
          ORDER BY d.file_name
          LIMIT 10`,
          z.object({
            file_name: z.string(),
            expected_chunks: z.coerce.number(),
            actual_extracted_chunks: z.coerce.number(),
            chunk_map_rows: z.coerce.number(),
          }),
          [dealId],
          { label: "R4: expected vs actual chunks" }
        );
        return { report: "R4_expected_vs_actual_chunks", rows, rowCount: rows.length };
      }

      // R5: scope_qualifier distribution
      case "R5_scope_qualifier_dist": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            COUNT(*) as total_facts,
            COUNT(*) FILTER (WHERE scope_qualifier = 'NONE_STATED') as exact_none_stated,
            COUNT(*) FILTER (WHERE scope_qualifier = 'UNSCOPED_BY_NATURE') as exact_unscoped,
            COUNT(*) FILTER (WHERE scope_qualifier LIKE '%NONE_STATED%' AND scope_qualifier != 'NONE_STATED') as contaminated,
            COUNT(*) FILTER (WHERE scope_qualifier != 'NONE_STATED' AND scope_qualifier != 'UNSCOPED_BY_NATURE') as populated,
            COUNT(*) FILTER (WHERE scope_qualifier IS NULL) as null_count
          FROM oa_facts WHERE deal_id = $1::uuid
          LIMIT 1`,
          z.object({
            total_facts: z.coerce.number(),
            exact_none_stated: z.coerce.number(),
            exact_unscoped: z.coerce.number(),
            contaminated: z.coerce.number(),
            populated: z.coerce.number(),
            null_count: z.coerce.number(),
          }),
          [dealId],
          { label: "R5: scope_qualifier dist" }
        );
        return { report: "R5_scope_qualifier_dist", rows, rowCount: rows.length };
      }

      // R6: adviser_severity by document
      case "R6_adviser_severity_by_doc": {
        const rows = await ctx.integrations.db.query(
          `SELECT document_name, adviser_severity, COUNT(*) as count
           FROM oa_facts WHERE deal_id = $1::uuid AND adviser_severity IS NOT NULL
           GROUP BY document_name, adviser_severity
           ORDER BY document_name, adviser_severity
           LIMIT 10`,
          z.object({ document_name: z.string(), adviser_severity: z.string(), count: z.coerce.number() }),
          [dealId],
          { label: "R6: adviser_severity by doc" }
        );
        return { report: "R6_adviser_severity_by_doc", rows, rowCount: rows.length };
      }

      // R7: CHURN VERIFICATION — all facts where predicate or subject_entity relates to churn
      case "R7_churn_facts": {
        const rows = await ctx.integrations.db.query(
          `SELECT fact_id, document_name, document_role, fact_type, subject_entity, predicate, value, unit, period, scope_qualifier, adviser_severity, stated_or_derived, memo_order, chunk_index
           FROM oa_facts
           WHERE deal_id = $1::uuid
             AND (
               predicate ILIKE '%churn%'
               OR subject_entity ILIKE '%churn%'
               OR predicate ILIKE '%retention%'
               OR subject_entity ILIKE '%retention%'
               OR predicate ILIKE '%attrition%'
               OR subject_entity ILIKE '%attrition%'
             )
           ORDER BY document_name, chunk_index
           LIMIT 10`,
          z.object({
            fact_id: z.string(),
            document_name: z.string(),
            document_role: z.string(),
            fact_type: z.string(),
            subject_entity: z.string().nullable(),
            predicate: z.string().nullable(),
            value: z.string().nullable(),
            unit: z.string().nullable(),
            period: z.string().nullable(),
            scope_qualifier: z.string(),
            adviser_severity: z.string().nullable(),
            stated_or_derived: z.string(),
            memo_order: z.number().nullable(),
            chunk_index: z.number(),
          }),
          [dealId],
          { label: "R7: churn facts" }
        );
        return { report: "R7_churn_facts", rows, rowCount: rows.length };
      }

      // R8: Offset verification (already done during normalization, report from chunk_map)
      case "R8_offset_verification": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            COUNT(*) as total_chunks_in_map,
            COUNT(*) FILTER (WHERE content_hash IS NOT NULL) as with_hash
          FROM oa_chunk_map WHERE deal_id = $1::uuid
          LIMIT 1`,
          z.object({ total_chunks_in_map: z.coerce.number(), with_hash: z.coerce.number() }),
          [dealId],
          { label: "R8: offset verification" }
        );
        return { report: "R8_offset_verification", rows, rowCount: rows.length };
      }

      // R9: oa_chunk_map row count
      case "R9_chunk_map_count": {
        const rows = await ctx.integrations.db.query(
          `SELECT COUNT(*) as chunk_map_rows FROM oa_chunk_map WHERE deal_id = $1::uuid LIMIT 1`,
          z.object({ chunk_map_rows: z.coerce.number() }),
          [dealId],
          { label: "R9: chunk_map count" }
        );
        return { report: "R9_chunk_map_count", rows, rowCount: rows.length };
      }

      // R10: Confirm zero synthesized verbatim_snippet values
      case "R10_verbatim_snippet_check": {
        const rows = await ctx.integrations.db.query(
          `SELECT
            COUNT(*) as total_facts,
            COUNT(*) FILTER (WHERE verbatim_snippet IS NOT NULL) as non_null_snippets
          FROM oa_facts WHERE deal_id = $1::uuid
          LIMIT 1`,
          z.object({ total_facts: z.coerce.number(), non_null_snippets: z.coerce.number() }),
          [dealId],
          { label: "R10: verbatim_snippet check" }
        );
        return { report: "R10_verbatim_snippet_check", rows, rowCount: rows.length };
      }

      default:
        return { report: "unknown", rows: [], rowCount: 0 };
    }
  },
});
