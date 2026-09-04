import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { getModuleModel } from "../pipeline/model-config.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const PageImageSchema = z.object({
  pageNumber: z.number(),
  text: z.string(),
  imageBase64: z.string(),
  mediaType: z.literal("image/jpeg"),
});

const ChunkSchema = z.object({
  label: z.string(),
  sourceFile: z.string(),
  text: z.string(),
  pageImages: z.array(PageImageSchema),
});

// ---------------------------------------------------------------------------
// Sub-Agent Prompts — one per module
// ---------------------------------------------------------------------------
export const DENSE_SUFFIX = `

## Output Rules

Return ONLY a valid JSON object. No text before or after.

Be precise and dense — every word should carry information:
- Each claim, data point, and flag should be a single clear statement — no filler, no restating context.
- "claim" states WHAT is claimed. "location" states WHERE. Do not repeat one in the other.
- "description" in flags states the gap directly — do not explain why it matters.
- "context" in data_points notes WHY this data point is relevant, in one phrase.
- "raw_summary": 2-3 dense sentences.

## CRITICAL: No Ad-Hoc Arithmetic

Do NOT perform any summation, reconciliation, or arithmetic verification on raw numbers in the text.
Do NOT add up periodic values (monthly, quarterly, yearly) to check against totals.
Do NOT compare computed sums to stated subtotals or variance columns.
Do NOT flag "discrepancies" based on your own calculations — LLM arithmetic is unreliable.
All numeric verification is handled by a separate deterministic system (NumericVerify).
Your role is EXTRACTION ONLY: report what the document states, not whether the numbers add up.`;

// ---------------------------------------------------------------------------
// Legal/Tax/Regulatory Scope Boundary (omission_audit only)
// Prevents findings from citing external statutes or making legal conclusions
// ---------------------------------------------------------------------------
export const LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY = `

## SCOPE BOUNDARY — LEGAL, TAX, AND REGULATORY TOPICS

You are auditing a data room for missing or unverified DOCUMENTATION, not
assessing the underlying legal, tax, or regulatory questions yourself. When a
finding touches a legal, tax, or regulatory topic:

DO:
- State what documentation, sign-off, or analysis you would expect to see
  (e.g., "a written tax counsel opinion," "an independent legal review of
  marketing claims," "confirmation from regulatory counsel") and note whether
  it's present in the reviewed materials.
- Note internal inconsistencies WITHIN the documents themselves (e.g., one
  slide hedges a claim as forthcoming while another states it in present
  tense) — this is a documentary observation, not a legal conclusion.

DO NOT:
- Cite, name, or explain external statutes, regulations, legal regimes, or
  case law (e.g., specific tax codes, named Acts, regulatory frameworks) —
  even if you are confident they are accurate. You cannot verify legal or
  regulatory facts against the data room, so do not assert them.
- State the legislative or regulatory status of any law (whether it has
  passed, when it takes effect, whether it has received assent, etc.).
- Produce your own quantified estimate of a legal, tax, or regulatory impact
  (e.g., an estimated IRR or EBITDA sensitivity to a tax outcome). If a
  sensitivity matters, recommend that the deal team run it — do not run it
  yourself.
- Conclude whether a legal, tax, or regulatory position is correct, sound, or
  compliant.

If you are unsure whether a point crosses this line, the safe fallback is:
"This raises a legal/tax/regulatory question that the data room does not
show has been independently addressed" — and stop there.`;

// ---------------------------------------------------------------------------
// Adversarial Absence Verification Protocol
// Applied to modules that assert things are "missing" or "absent"
// ---------------------------------------------------------------------------
export const ABSENCE_VERIFICATION_PROTOCOL = `

## CRITICAL: Adversarial Self-Check for Absence Claims

Before flagging ANYTHING as "missing", "absent", "not addressed", "not found", or "not mentioned":

1. **State your exact search**: What specific terms, phrases, and synonyms did you look for?
2. **Check alternate phrasings**: Try at least 2 alternate formulations. Example: "customer churn" might appear as "retention rate", "logo attrition", "client turnover", or "renewal rate".
3. **Check indirect coverage**: Could the topic be addressed implicitly through related data? (e.g., a retention table addresses churn even without the word "churn")
4. **Scope your claim**: You are reviewing ONE chunk of a larger data room. Something absent from THIS chunk may be present elsewhere. Flag gaps ONLY at the chunk level — do NOT assert deal-room-wide absence from a single chunk.
5. **Classify your finding**:
   - "not_found_in_this_chunk" — you looked, it's not here, but could be elsewhere (use this by default)
   - "verified_absent" — the document structure strongly implies this information SHOULD be here (e.g., a financial model with no revenue assumptions) AND you tried all alternate phrasings
   - "open_item_acknowledged" — the document ITSELF discloses this as an open item, pending workstream, or "results TBD". This is NOT an omission — the record explicitly acknowledges the gap. Examples: "kick off post IC", "results to be determined", "workstream to complete post-close". Do NOT flag these as missing — they are intentionally staged.

In the flags array, EVERY gap/omission flag MUST include a "verification" key (string) that states:
- The search terms you tried (at least 3)
- Whether the topic might be covered under alternate terminology
- Your classification: "not_found_in_this_chunk" or "verified_absent"

Findings that assert absence WITHOUT this verification step are FABRICATIONS and will be discarded by the merge layer.`;

export const SUB_AGENT_PROMPTS: Record<string, string> = {
  // ---- Omission Audit ----
  omission_audit: `You are a senior private equity due diligence analyst. Analyze this document chunk from a deal data room and identify what information is MISSING — data, sections, time periods, benchmarks, or risk factors that should be present but are absent.

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Analysis Framework

Identify omissions in these categories:
1. **Missing Data**: Metrics referenced but never substantiated with figures.
2. **Missing Sections**: Standard sections for this document type that are absent.
3. **Missing Timeframes**: Historical periods or forward projections that should be included.
4. **Missing Benchmarks**: Industry comparables that would contextualize performance.
5. **Missing Risk Factors**: Risks unaddressed given sector, deal size, or business model.

## PE Diligence Checklist

Cross-reference against: customer concentration, churn/retention, key man risk, revenue recognition, regulatory exposure, competitive response, management incentives, exit assumptions, QoE items, capex requirements.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${ABSENCE_VERIFICATION_PROTOCOL}
${DENSE_SUFFIX}

Required keys:
- "document_name" (string)
- "document_type" (string): CIM, IC_MEMO, CUSTOMER_DATA, CONSULTANT_REPORT, FINANCIAL_MODEL, LEGAL, or OTHER
- "key_claims" (array): each with "claim" (string), "location" (string), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "context" (string)
- "flags" (array): each with "type" ("risk"|"gap"|"contradiction"|"assumption"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "fca_authorisation_risk", "customer_concentration"), "verification" (string — REQUIRED for gap/risk flags that assert absence)
- "raw_summary" (string)`,

  // ---- Contradiction Check ----
  contradiction_check: `You are a senior private equity analyst specializing in data integrity. Analyze this document chunk and extract all claims and data points, tagging each by whether it is a NARRATIVE claim (qualitative assertion from management, CIM, or IC memo) or a DATA point (quantitative evidence from financial data, customer data, or consultant reports).

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Analysis Framework

For each claim or data point found:
1. Extract the exact claim or metric with its value
2. Tag the source type: "narrative" (CIM, IC memo, management presentation) or "data" (financial model, customer data, consultant report, QoE)
3. Note the location within the document (section, page, table name)
4. Assess confidence in the accuracy of your extraction

Focus especially on: Revenue growth rates (stated vs. calculated), customer metrics (count, retention, concentration), margin claims vs. actual margin data, market size and share assertions, competitive positioning claims, management track record claims, projection assumptions vs. historical actuals.
${DENSE_SUFFIX}

Required keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "key_claims" (array): each with "claim" (string), "source_type" ("narrative"|"data"), "location" (string), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "period" (string, e.g. "FY2024", "Q3 2023", "LTM Jun-24"), "verbatim_snippet" (string, ≤80 chars from source text containing the value), "context" (string)
- "flags" (array): each with "type" ("contradiction"|"assumption"|"risk"|"gap"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "revenue_growth_mismatch", "margin_claim_vs_actual")
- "raw_summary" (string)`,

  // ---- Blind Spot Scanner ----
  blind_spot_scanner: `You are a senior private equity analyst. Analyze this document chunk and extract the stated investment thesis, all explicit assumptions, and any implicit assumptions that the document relies upon without stating.

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Analysis Framework

1. **Investment Thesis Extraction**: Identify the core thesis — why is this a good investment? What are the stated value creation levers?
2. **Explicit Assumptions**: List every assumption the document explicitly states (e.g., "assuming 15% annual growth", "management will stay post-close").
3. **Implicit Assumptions**: Infer what MUST be true for the document's claims to hold, even if never stated. Examples: If the CIM projects 20% growth, it implicitly assumes the market can absorb that growth. If the model shows margin expansion, it implicitly assumes no competitive pricing pressure.
4. **Flag Unaddressed Risks**: Note scenarios that would invalidate key assumptions but are never discussed.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${ABSENCE_VERIFICATION_PROTOCOL}
${DENSE_SUFFIX}

Required keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "key_claims" (array): each with "claim" (string), "claim_type" ("thesis"|"explicit_assumption"|"implicit_assumption"), "location" (string), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "context" (string)
- "flags" (array): each with "type" ("assumption"|"risk"|"gap"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "implicit_churn_assumption", "market_size_unaddressed"), "verification" (string — REQUIRED for gap/risk flags that assert absence)
- "raw_summary" (string)`,

  // ---- IC Challenge Mode ----
  ic_challenge_mode: `You are a veteran IC member known for asking the hardest questions in the room. Analyze this document chunk and extract the deal team's core thesis claims, stated risks, key assumptions, and any areas where the argument feels weakest.

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Analysis Framework

1. **Thesis Claims**: Extract the explicit investment thesis and value creation plan
2. **Stated Risks and Mitigants**: What risks does the deal team acknowledge? How do they propose to mitigate them?
3. **Key Assumptions**: What must be true for the thesis to work?
4. **Weak Points**: Where is the argument least convincing? Where is the evidence thinnest?
5. **What's Conspicuously Absent**: What would you expect to see in this document that isn't there?
${DENSE_SUFFIX}

Required keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "key_claims" (array): each with "claim" (string), "claim_type" ("thesis"|"risk_mitigant"|"assumption"|"weak_point"), "location" (string), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "context" (string)
- "flags" (array): each with "type" ("risk"|"gap"|"contradiction"|"assumption"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "thesis_drift_pricing", "single_customer_dependency")
- "raw_summary" (string)`,

  // ---- Model Assumptions Stress Test ----
  model_assumptions_stress: `You are a senior financial analyst specializing in PE model review. Analyze this document chunk and extract all quantitative assumptions that reflect the deal team's underwriting model — growth rates, margin targets, churn assumptions, capex projections, working capital, entry/exit multiples, return assumptions, and any other financial model inputs.

You will receive BOTH page images AND extracted text. Use both for thorough analysis.

## Important Context

You are extracting the deal team's model, not management's projections. The deal team builds their own financial model to underwrite the investment. The key source is the IC memo. When a document appears to be management's projections (e.g., labeled "Management Case" or from a CIM), extract the numbers but flag them clearly as management figures.

## Analysis Framework

Extract every quantitative assumption organized by category:
1. Revenue Assumptions: Growth rates, pricing, volume, mix shifts
2. Margin Assumptions: Gross margin, EBITDA margin, expansion targets
3. Customer Assumptions: Churn/retention, NRR, CAC
4. Cost Assumptions: Headcount growth, compensation escalation, operating leverage
5. Capital Assumptions: Capex % of revenue, working capital days
6. Financing Assumptions: Leverage levels, interest rates, debt paydown
7. Entry/Exit Assumptions: Entry multiple, exit multiple, exit year
8. Return Assumptions: IRR target, MOIC target, equity check size

Note whether each is STATED EXPLICITLY or DERIVED, and whether it is the deal team's view or management's view.
${DENSE_SUFFIX}

Required keys:
- "document_name" (string)
- "document_type" (string): CIM | IC_MEMO | CUSTOMER_DATA | CONSULTANT_REPORT | FINANCIAL_MODEL | LEGAL | OTHER
- "source_perspective" ("deal_team"|"management"|"unclear")
- "key_claims" (array): each with "claim" (string), "claim_type" ("stated"|"derived"), "perspective" ("deal_team"|"management"|"unclear"), "category" ("revenue"|"margin"|"customer"|"cost"|"capital"|"financing"|"entry_exit"|"returns"), "location" (string), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "context" (string)
- "flags" (array): each with "type" ("assumption"|"risk"|"contradiction"|"gap"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "exit_multiple_sensitivity", "revenue_growth_assumption")
- "raw_summary" (string)`,

  // ---- Diligence Completeness ----
  // REMOVED — DCS rebuild (Packet 5B): diligence_completeness now uses DcsRunPipeline,
  // not the generic AnalyzeChunk → MergeFindings → FormatReport path.

  // ---- Executive Summary (processes prior module outputs, not documents) ----
  executive_summary: `You are a senior PE professional preparing input for the executive summary. Extract the most important findings, themes, and action items from a completed analysis module's output.

## Analysis Framework

From the module output provided:
1. Key Findings: Extract the 3-5 most important findings
2. Severity Assessment: Note the distribution of critical/warning/info findings
3. Action Items: List any recommended actions or follow-up items
4. Cross-Module Relevance: Note any findings that likely connect to other analysis dimensions
${DENSE_SUFFIX}

Required keys:
- "document_name" (string — module name)
- "document_type" ("OTHER")
- "key_claims" (array): each with "claim" (string), "location" (string — module name), "confidence" ("high"|"medium"|"low")
- "data_points" (array): each with "metric" (string), "value" (string), "context" (string)
- "flags" (array): each with "type" ("risk"|"gap"|"contradiction"|"assumption"), "description" (string), "severity" ("critical"|"moderate"|"low"), "issue_key" (string, snake_case identifier for the specific issue, e.g. "key_finding_revenue", "action_item_legal_dd")
- "raw_summary" (string)`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize dynamic text so the Superblocks orchestrator doesn't interpret
 * curly braces as template-binding delimiters.
 */
function sanitizeBraces(text: string): string {
  if (!text) return text;
  return text.replace(/\{/g, "\uFE5B").replace(/\}/g, "\uFE5C");
}

/**
 * Build a multimodal content array for one chunk.
 * Includes both page images and extracted text.
 */
function buildMultimodalContent(
  chunk: z.infer<typeof ChunkSchema>
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const page of chunk.pageImages) {
    if (page.imageBase64) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: page.mediaType,
          data: page.imageBase64,
        },
      });
    }
  }

  if (chunk.text) {
    blocks.push({
      type: "text",
      text: `--- Extracted text from "${sanitizeBraces(chunk.label)}" ---\n\n${sanitizeBraces(chunk.text)}`,
    });
  }

  blocks.push({
    type: "text",
    text: `The above is "${sanitizeBraces(chunk.label)}" (source: ${sanitizeBraces(chunk.sourceFile)}). Analyze it now using both the page images and the extracted text.`,
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    })
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// API — Analyze a single chunk via sub-agent
// ---------------------------------------------------------------------------
export default api({
  name: "AnalyzeChunk",
  description: "Analyzes a single PDF chunk via Anthropic sub-agent",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.string(),
    chunkIndex: z.number(),
    totalChunks: z.number(),
    chunk: ChunkSchema,
  }),

  output: z.object({
    label: z.string(),
    extraction: z.string(),
    chunkIndex: z.number(),
  }),

  async run(ctx, { moduleId, chunkIndex, totalChunks, chunk }) {
    const subAgentPrompt = SUB_AGENT_PROMPTS[moduleId];
    if (!subAgentPrompt) {
      throw new Error(`Module "${moduleId}" sub-agent prompt not configured.`);
    }

    const content = buildMultimodalContent(chunk);
    const label = `Sub-agent: ${sanitizeBraces(chunk.label)} (${chunkIndex + 1}/${totalChunks})`;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: getModuleModel(moduleId),
          max_tokens: SUB_AGENT_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: subAgentPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content }],
        },
      },
      { response: MessageResponseSchema },
      { label }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`No text content in Anthropic response for chunk ${chunkIndex}`);
    }

    const extraction = `### Extraction from: ${sanitizeBraces(chunk.label)}\n\n${sanitizeBraces(textBlock.text)}`;

    return {
      label: sanitizeBraces(chunk.label),
      extraction,
      chunkIndex,
    };
  },
});
