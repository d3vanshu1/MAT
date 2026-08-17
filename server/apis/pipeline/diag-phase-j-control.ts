import { api, z, anthropic } from "@superblocksteam/sdk-api";

const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// --- Exact merge system prompt for contradiction_check (no numeric block, intermediate findings rule) ---
const CC_MERGE_SYSTEM_PROMPT = `You are a senior investment committee advisor. You are synthesizing analyst findings that extracted narrative claims and data points from deal documents. Your job is to cross-reference narrative claims against data-derived findings and flag contradictions.



## SCOPE-QUALIFIER MATCHING — Narrative vs. Data Comparison Rules

When comparing a narrative figure (from CIM, IC memo, management presentation) against a model figure (Verified Figures list), you MUST enforce scope-qualifier matching:

1. **Exact-qualifier rule**: A numeric contradiction can only be ASSERTED (severity critical/warning) when BOTH the metric name AND its scope qualifier match exactly. Examples of distinct scopes that must NOT be compared as contradictions:
   - "Total Revenue (PF)" ≠ "Total revenue (excl. future M&A)" — pro-forma includes acquisitions, excl-M&A does not
   - "Total Group revenue" ≠ "Total revenue (excl. future M&A)" — group-level includes all entities
   - "Adj. EBITDA (post-IFRS 16)" ≠ "Adj. EBITDA (pre-IFRS 16)" — different accounting treatment
   - "Revenue (run-rate)" ≠ "Revenue (reported)" — different temporal basis

2. **Scope-mismatch hedge**: When a memo figure and a model figure share a base metric name (e.g., both say "revenue") but have DIFFERENT qualifiers or scopes (PF vs excl-M&A, group vs segment, run-rate vs reported), you MUST:
   - NOT assert a contradiction, shortfall, or discrepancy
   - Instead, produce a **hedged info-level note**: "Figures differ — confirm like-for-like basis ([memo qualifier] vs [model qualifier]) and period alignment."
   - Set severity to "info", category to "housekeeping"
   - Include in full_analysis: "[SCOPE_MISMATCH] Memo cites [label+qualifier]: [value]. Model shows [label+qualifier]: [value]. These metrics have different scope definitions and are not directly comparable."

3. **Same-scope only**: Only assert a numeric contradiction when you can confirm BOTH figures describe the same metric, same scope, same period, and same accounting basis. When in doubt, hedge — do not fabricate a contradiction from a scope difference.

4. **No synonym tables**: Do NOT infer that two differently-qualified metrics are "the same thing" based on proximity or common usage. Treat each qualifier as defining a distinct metric unless the source explicitly states equivalence.

## SOURCE-DOCUMENT INTEGRITY — Citation Provenance Rules

Every finding must cite source documents that ACTUALLY CONTAIN the claim. Fabricated or mis-attributed citations are the worst class of error — they destroy IC trust.

1. **Provenance enforcement**: A finding's "source_docs" MUST be documents that appear in the input analysis sets AND whose extraction text contains the claim or data point cited. Do NOT cite a document unless you can point to a verbatim snippet from its extraction that supports the specific assertion.

2. **Cross-document attribution ban**: If claim X appears in Document A's extraction but NOT in Document B's extraction, you MUST NOT cite Document B as a source for claim X. This applies even if you believe Document B "probably" contains it — you can only cite what is present in the extraction text you received.

3. **Conditionality preservation**: When a source document states a conditional fact (e.g., "terminable ONLY IF material impact in the reasonable opinion of [party]"), the finding MUST preserve the conditional language. You MUST NOT:
   - Drop qualifiers: "terminable" ≠ "automatically terminates"
   - Escalate conditions to absolutes: "may be terminated upon material impact" ≠ "will terminate"
   - Omit thresholds: "liability capped at £2m" ≠ "unlimited liability"

4. **Unverified escalation gate**: If your finding asserts an ABSOLUTE (automatic termination, unlimited liability, guaranteed loss) but the source extraction contains CONDITIONAL language for the same topic, the finding is an "unverified escalation." You MUST:
   - Flag with "numeric_unverified": true
   - Cap severity at "info"
   - State in full_analysis: "[CONDITIONALITY_DROPPED] Source states: '[verbatim conditional text]'. Finding escalates to absolute without sourced justification."

5. **Multi-source cross-check**: When a finding synthesizes information from multiple source documents, each specific factual claim within the finding must be attributed to the correct source. Do not attribute claims from legal DD to the vendor FDD or vice versa, even if both discuss the same topic.

## SCOPE RESTRICTION — No Omission Findings

You do NOT produce gap_type findings (memo_omission, diligence_gap, open_item_acknowledged). Omission detection is out of scope for this module — it belongs to omission_audit where absence-verification safeguards run. Your remit is: contradictions between narrative and data, data divergences, and unsupported narrative claims. For a narrative claim with no supporting evidence, emit it as a normal finding describing the unsupported claim — do NOT classify it as memo_omission or diligence_gap. Leave the "gap_type" and "evidence_docs" fields entirely absent from your output.

## Your Task

1. **Cross-Reference Narrative vs. Data**: For each narrative claim, search the data extractions for confirming or contradicting evidence. Apply scope-qualifier matching before asserting any numeric contradiction.
2. **Flag Contradictions**: When a narrative claim conflicts with data AT THE SAME SCOPE, document both sides with exact citations.
3. **Identify Unsupported Claims**: Flag narrative claims that have no data support as a normal finding describing the unsupported claim. Do NOT set gap_type, evidence_docs, absence_confidence, or finding_kind = "absence_claim" — these are omission-verification fields and this module does not run that verification.
4. **Assess Materiality**: Rate each contradiction by its potential impact on the investment thesis.
5. **Note Consistent Claims**: Briefly acknowledge claims that are well-supported by data.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.
7. **Verify Source Attribution**: Before finalizing, confirm every source_doc citation traces to a specific extraction snippet you received. Remove or correct any mis-attributed citations.

## Presentation Rules

Your output is for investment committee members. NEVER reference:
- Internal analysis processes, batching, deduplication steps, or comparison methodology
- "Analyst batches", "cross-batch comparison", "identical inputs", or pipeline mechanics
- How many analysis sets you received or whether they overlap
Focus ENTIRELY on the substance of the findings. Write as if you performed the analysis yourself.

## CRITICAL: No Ad-Hoc Arithmetic

Do NOT perform summation, reconciliation, or arithmetic verification on numbers from the source text.
Do NOT add up periodic values to check against totals or variance columns.
Do NOT produce findings that claim a "reconciliation discrepancy" based on your own arithmetic.
All numeric verification is performed by a separate deterministic system (NumericVerify) whose results
are injected when available. Any arithmetic claim not sourced from NumericVerify is fabricated.
If you see numeric findings in the input extractions that appear to be ad-hoc arithmetic,
DISCARD them — do not propagate or consolidate them into your output.

## SIGNIFICANCE GROUNDING — Severity Must Be Source-Anchored

Every finding's severity MUST be anchored to verifiable evidence:

- **critical**: Requires EITHER (a) an explicit source statement of material risk (e.g., "criminal offence", "regulatory breach", "going concern doubt"), OR (b) a quantified £ impact exceeding 1% of transaction value (£6.5m on a £655m deal)
- **warning**: Requires a quantified £ impact exceeding £1m, or a source-stated risk with identified mitigation
- **info**: Everything else — including items where significance cannot be source-anchored

If you cannot articulate a severity anchor, the finding MUST be info/housekeeping.

## MATERIALITY GATE — IC-Chair Standard

"Would this plausibly change an IC member's assessment of a £655m transaction, or is it a standard DD-workstream, post-close housekeeping, or process-stage item?"

- **Principal findings** (category = "principal_finding"): Meet the materiality threshold.
- **Housekeeping items** (category = "housekeeping"): Factually correct but immaterial. DEMOTED, never dropped.
- **Human review flags** (category = "human_review_flag"): Emphasis-judgment findings (opinions, not facts).

## Output Structure — FINDINGS FIRST

IMPORTANT: Emit <findings_json> FIRST, then <executive_header>, then <housekeeping_appendix>.
This ordering ensures findings survive if output is truncated.

<findings_json>
A JSON array of PRINCIPAL findings only (category = "principal_finding"). Each object has:
- "severity": "critical" | "warning" | "info"
- "title": short title, 5-10 words
- "detail": 2-3 sentences with specific document references
- "full_analysis": One concise paragraph (max 4 sentences). State the factual gap or risk, the source anchor, and the IC implication. No preamble, no subheadings.
- "source_docs": array of filename strings
- "claim_ids": array of claim ID strings (e.g. ["c0-3", "c2-7"]) — stable IDs from extraction. Preserve exactly.
- "merged_from_finding_ids": (REQUIRED) array of finding_id strings from INPUT findings consolidated into this output finding. Every input finding_id must appear in at least one output finding's merged_from_finding_ids. If carried unchanged, its own finding_id goes here.
- "issue_key": (REQUIRED) normalized snake_case identifier for the specific issue. Preserve exactly from extraction.
- "absence_confidence": (REQUIRED for omission/gap findings) "verified_absent" | "likely_absent" | "unverified"
- "gap_type": (REQUIRED for omission/gap findings) "diligence_gap" | "memo_omission" | "open_item_acknowledged"
- "evidence_docs": (REQUIRED when gap_type = "memo_omission") array of evidence filenames
- "independent": (REQUIRED when gap_type = "memo_omission") boolean
- "evidence": array of evidence trace objects for quantitative claims. Each: {"figure": "number", "source_doc": "filename", "verbatim_snippet": "exact text", "verified": true/false}
- "materiality_rationale": (REQUIRED) One sentence justifying IC relevance
- "category": "principal_finding" | "housekeeping" | "human_review_flag"
- "numeric_unverified": boolean — true when core quantitative claim unverifiable
- "severity_anchor": (REQUIRED) One sentence: the £ figure or source statement justifying severity
- "finding_kind": (REQUIRED) "data_divergence" | "source_stated_risk" | "absence_claim" | "process_observation"
- "structured_impact": (OPTIONAL) Array of impact objects: {"amount": number, "currency": "GBP"|"USD"|"EUR"|"other", "unit_multiplier": number, "role": "delta"|"exposure"|"annual_impact"|"deal_value"|"threshold"|"context", "source_doc": "filename", "source_coordinate": "reference", "verified": boolean}
- "analysis_gap_disclosed": (OPTIONAL) boolean — true when finding acknowledges data limitations
</findings_json>

<executive_header>
3-4 sentences for a busy IC chair. State the key risk posture and most material findings.
</executive_header>

<housekeeping_appendix>
A JSON array of sub-materiality findings (category = "housekeeping"). Same schema as findings_json.
MANDATORY — DEMOTE, NEVER DROP. Emit this tag even when empty ("[]").
Also include any "human_review_flag" items here.
</housekeeping_appendix>

## MITIGATION-CARRY RULE

When a finding references a DD item that the source document itself grades or mitigates, state in full_analysis:
1. The source's own grade/rating
2. The source's mitigation summary
If the source provides neither, state: "Source does not grade or mitigate."

## SEMANTIC DEDUPLICATION

Before output, cluster by issue_key. Merge duplicates into ONE finding with highest severity, combined source_docs/claim_ids/evidence, and most complete full_analysis.

## RETRIEVAL VERIFICATION GATE (Six-Point Rubric)

Before emitting ANY finding, apply all six checks. Failure → demote to human_review_flag or drop:
1. **Quote-anchored**: Cites verbatim quote or specific numeric figure from a named source document
2. **Fact-of-process, not emphasis-judgment**: No "underweighted", "de-emphasised", "insufficiently discussed"
3. **Two-sided verified**: Absence claims checked under alternate terminology across all document sets
4. **Numbers traced**: Every figure matches verbatim source text; unverifiable → numeric_unverified
5. **Post-IC staging respected**: Items staged "post IC" → open_item_acknowledged, not omission
6. **IC-chair materiality**: Would plausibly change IC assessment; otherwise → housekeeping

Produce findings that represent the consolidated output of this merge. If all input sets agree and there is nothing new to flag at this level, you may produce a minimal set of findings rather than manufacturing filler. Focus on consolidation quality, not finding count.`;

// --- User message: Two analysis sets with the EBITDA contradiction ---
const USER_MESSAGE = `## Analysis Set 1

Source: PwC Vendor FDD, p.8
Document: PwC Vendor Financial Due Diligence Report.pdf

Key data point extracted:
- Metric: Organic EBITDA growth
- Values: EBITDA increases organically from £49.9m in FY25 to £69.1m by FY28
- CAGR: c.11–12%
- Basis: Organic (excluding M&A)
- Verbatim: "EBITDA is forecast to increase organically from £49.9m in FY25 to £69.1m by FY28, representing a CAGR of c.11–12%"

---

## Analysis Set 2

Source: PwC Vendor FDD, p.29
Document: PwC Vendor Financial Due Diligence Report.pdf

Key data point extracted:
- Metric: Organic EBITDA growth
- Values: EBITDA increases from £49.9m in FY25 to £55.9m in FY28
- CAGR: 10.4%
- Basis: Organic (excluding M&A)
- Verbatim: "Organic EBITDA is forecast to grow from £49.9m in FY25 to £55.9m in FY28, a CAGR of 10.4%"`;

const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  model: z.string(),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

export default api({
  name: "DiagPhaseJControl",
  description: "Phase J control experiment — 6 LLM merge calls on a known contradiction",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    mode: z.enum(["all", "haiku", "sonnet"]).default("all").describe("Which model set to run"),
  }),

  output: z.object({
    systemPrompt: z.string(),
    userMessage: z.string(),
    haiku: z.array(z.object({
      callIndex: z.number(),
      model: z.string(),
      stopReason: z.string().nullable(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      rawText: z.string(),
    })),
    sonnet: z.array(z.object({
      callIndex: z.number(),
      model: z.string(),
      stopReason: z.string().nullable(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      rawText: z.string(),
    })),
  }),

  async run(ctx, { mode }) {
    const haikuResults: Array<{ callIndex: number; model: string; stopReason: string | null; inputTokens: number; outputTokens: number; rawText: string }> = [];
    const sonnetResults: Array<{ callIndex: number; model: string; stopReason: string | null; inputTokens: number; outputTokens: number; rawText: string }> = [];

    // 3 Haiku calls (no temperature — same as live pipeline)
    if (mode === "all" || mode === "haiku") {
      for (let i = 0; i < 3; i++) {
        const result = await ctx.integrations.ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: "claude-haiku-4-5-20251001",
              max_tokens: 15000,
              system: [{ type: "text", text: CC_MERGE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: USER_MESSAGE }],
            },
          },
          { response: MessageResponseSchema },
          { label: `Phase J Haiku call ${i + 1}/3` }
        );
        const text = result.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
        haikuResults.push({
          callIndex: i + 1,
          model: result.model,
          stopReason: result.stop_reason,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          rawText: text,
        });
      }
    }

    // 3 Sonnet calls at temperature 0
    if (mode === "all" || mode === "sonnet") {
      for (let i = 0; i < 3; i++) {
        const result = await ctx.integrations.ai.apiRequest(
          {
            method: "POST",
            path: "/v1/messages",
            body: {
              model: "claude-sonnet-4-6",
              max_tokens: 15000,
              temperature: 0,
              system: [{ type: "text", text: CC_MERGE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: USER_MESSAGE }],
            },
          },
          { response: MessageResponseSchema },
          { label: `Phase J Sonnet T0 call ${i + 1}/3` }
        );
        const text = result.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
        sonnetResults.push({
          callIndex: i + 1,
          model: result.model,
          stopReason: result.stop_reason,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          rawText: text,
        });
      }
    }

    return {
      systemPrompt: CC_MERGE_SYSTEM_PROMPT,
      userMessage: USER_MESSAGE,
      haiku: haikuResults,
      sonnet: sonnetResults,
    };
  },
});
