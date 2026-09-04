import { api, z, anthropic } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "./build-merged-text.js";
import { NUMERIC_MODULES } from "./constants.js";
import { getModuleModel } from "../pipeline/model-config.js";
import { LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY } from "./analyze-chunk.js";
import { parseCanonicalFindings, type CanonicalFinding } from "../pipeline/canonical-finding.js";
import { enforceNarrativeBoundary } from "../pipeline/narrative-enforcement.js";
import { extractFindingsJsonTolerant } from "../pipeline/extract-findings-tolerant.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MERGE_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ExtractionSchema = z.object({
  label: z.string(),
  extraction: z.string(),
  chunkIndex: z.number(),
});

// ---------------------------------------------------------------------------
// Merge Prompts — one per module
// ---------------------------------------------------------------------------
export const MERGE_OUTPUT_STRUCTURE = `

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

{{FINDINGS_REQUIREMENT}}`;

export const FINDINGS_RULE_FINAL = `You MUST produce findings. Every analysis has findings — if the documents are adequate, produce info-level findings confirming coverage. If the documents are inadequate, produce critical findings for every gap. An empty findings array is NEVER acceptable.`;

export const FINDINGS_RULE_INTERMEDIATE = `Produce findings that represent the consolidated output of this merge. If all input sets agree and there is nothing new to flag at this level, you may produce a minimal set of findings rather than manufacturing filler. Focus on consolidation quality, not finding count.`;

export const MERGE_PROMPTS: Record<string, string> = {
  omission_audit: `You are a senior investment committee advisor conducting a deal data room omission audit. You are synthesizing analyst findings into a comprehensive assessment of what information is missing from the deal materials.

## Document Role Context (derived at prompt time, not stored)

The evidence pool contains ALL deal documents EXCEPT the subject document(s) (excluded by ID). This includes:
- **Objective sources** (document_tag ∈ financial_model, customer_data, consultant_report, legal, other with document_source = 'pep'): Treat as factual ground truth.
- **Narrative sources** (document_tag ∈ cim, im, OR document_source = 'sellside'): These are ADVOCACY documents. They may contain spin, selective emphasis, or omissions of their own. Scrutinize narrative-source claims against objective-source data rather than treating them as authoritative. A claim made ONLY in a narrative source without objective backing is NOT confirmed evidence.

The "independent" field on findings is determined by code post-merge — you do NOT need to set it. Focus on classifying gap_type and listing evidence_docs accurately.

## Multi-Version Memo Handling (union-subject model)

When the subject comprises multiple IC memo versions (chronological record):
- **(a) Supersession rule**: When memo versions state different values for the same metric or claim, the LATEST memo governs. Do NOT flag superseded figures as contradictions of the current thesis. You MAY note a revision if the magnitude is material (e.g., "revenue projection revised from $50M to $38M between Memo 2 and Memo 3") at severity "info".
- **(b) Thesis drift**: A risk, topic, or commitment discussed in an EARLIER memo that is ABSENT from the LATEST memo is a reportable finding. Classify this as a distinct finding type — it represents thesis drift (the team quietly dropped or de-emphasized something), which is different from memo_omission (information in evidence but never mentioned in any memo version).

## Your Task

1. **Consolidate Findings**: Combine all analyst observations into a unified set of findings. Where multiple analysts flagged the same gap, combine into one finding with the higher severity and all source docs.
2. **Classify Each Gap**: For every omission finding, determine:
   - **memo_omission** — the information IS present in evidence documents but absent from the subject memo (the memo failed to mention it). MUST include "evidence_docs" listing which files contain the evidence, and "independent" indicating whether at least one non-ic_memo source corroborates.
   - **diligence_gap** — the information is absent from BOTH the subject memo AND all evidence documents (a true gap in the data room).
3. **Checklist Comparison**: Ensure coverage against: customer concentration, churn/retention, key man risk, revenue recognition, regulatory, competitive response, management incentives, exit assumptions, QoE items, capex requirements.
4. **Identify Additional Gaps**: Based on the full body of evidence, flag any omissions the analysts may have missed.
5. **Prioritize**: Rank all findings by potential impact on investment decision.

## CRITICAL: Adversarial Re-Verification of Absence Claims

You are the gatekeeper against fabricated omission findings. Before including ANY finding that asserts something is "missing" or "absent" from the data room:

1. **Cross-chunk check**: Did ANY analyst extraction mention this topic, even tangentially? Search all input sets for related terms. If found anywhere, the claim is FALSE — downgrade or discard.
2. **Verify the "verification" field**: Each analyst flag should include a "verification" field explaining what search terms they tried. If a flag has NO verification field, treat it as UNVERIFIED and either discard it or downgrade to info severity with a note: "Unverified absence claim — requires manual confirmation."
3. **Check for alternate terminology**: Could the gap be addressed under different wording? (e.g., "no churn data" when retention rates ARE present)
4. **Classify each absence finding**:
   - **"verified_absent"**: Multiple analysts checked, alternate phrasings tried, genuinely not in the reviewed materials
   - **"likely_absent"**: One analyst flagged with verification, not contradicted by others
   - **"unverified"**: No verification evidence, or contradicted by another extraction
5. **Include classification in output**: Add an "absence_confidence" field to every gap/omission finding: "verified_absent" | "likely_absent" | "unverified"

Findings classified as "unverified" MUST be severity "info" regardless of the analyst's original severity rating. Do NOT promote unverified absence claims to critical or warning.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${MERGE_OUTPUT_STRUCTURE}`,

  contradiction_check: `You are a senior investment committee advisor. You are synthesizing analyst findings that extracted narrative claims and data points from deal documents. Your job is to cross-reference narrative claims against data-derived findings and flag contradictions.

{{NUMERIC_VERIFICATION_BLOCK}}

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

1. {{NUMERIC_TASK_STEP_1}}**Cross-Reference Narrative vs. Data**: For each narrative claim, search the data extractions for confirming or contradicting evidence. Apply scope-qualifier matching before asserting any numeric contradiction.
2. **Flag Contradictions**: When a narrative claim conflicts with data AT THE SAME SCOPE, document both sides with exact citations.
3. **Identify Unsupported Claims**: Flag narrative claims that have no data support as a normal finding describing the unsupported claim. Do NOT set gap_type, evidence_docs, absence_confidence, or finding_kind = "absence_claim" — these are omission-verification fields and this module does not run that verification.
4. **Assess Materiality**: Rate each contradiction by its potential impact on the investment thesis.
5. **Note Consistent Claims**: Briefly acknowledge claims that are well-supported by data.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.
7. **Verify Source Attribution**: Before finalizing, confirm every source_doc citation traces to a specific extraction snippet you received. Remove or correct any mis-attributed citations.
${MERGE_OUTPUT_STRUCTURE}`,

  blind_spot_scanner: `You are a senior investment committee advisor and contrarian thinker. You are synthesizing analyst findings that extracted the investment thesis, explicit assumptions, and implicit assumptions from deal documents. Your job is to identify blind spots.

## Multi-Version Memo Handling (union-subject model)

When the subject comprises multiple IC memo versions (chronological record):
- **(a) Supersession rule**: When memo versions state different values for the same metric or claim, the LATEST memo governs. Do NOT flag superseded figures as contradictions of the current thesis. You MAY note a revision if the magnitude is material at severity "info".
- **(b) Thesis drift**: A risk, topic, or commitment discussed in an EARLIER memo that is ABSENT from the LATEST memo is a reportable finding. Classify this as thesis drift — the team quietly dropped or de-emphasized something. This is distinct from a standard blind spot (assumption never addressed anywhere).

## Your Task

1. **Reconstruct the Full Thesis**: Combine thesis elements from all documents.
2. **Map the Assumption Chain**: Build a dependency tree — which assumptions depend on other assumptions?
3. **Find the Gaps**: For each implicit assumption, check whether ANY document addresses it. If not, it's a blind spot.
4. **Stress Test**: For each blind spot, describe what happens to the thesis if that assumption proves wrong.
5. **Generate Diligence Questions**: For each critical blind spot, provide the specific question the deal team should answer.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.

## CRITICAL: Adversarial Re-Verification of Absence Claims

Before asserting that a risk is "unaddressed" or an assumption is "never discussed":

1. **Cross-check all input sets**: Search every analyst extraction for related terms, synonyms, and indirect coverage.
2. **Require verification evidence**: Only promote a blind spot to critical/warning if the analyst included a "verification" field showing what they searched for. Unverified claims → info severity with note.
3. **Distinguish scope**: "Not found in reviewed chunks" ≠ "not addressed in the deal". Use precise language.
4. **Add "absence_confidence"**: "verified_absent" | "likely_absent" | "unverified" to every finding asserting something is missing.
${LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY}
${MERGE_OUTPUT_STRUCTURE}`,

  ic_challenge_mode: `You are the toughest IC chair in private equity. You are synthesizing analyst findings that extracted thesis claims, risks, assumptions, and weak points from deal documents. Your job is to generate the 8 hardest questions for the IC meeting.

## Your Task

1. **Identify Vulnerabilities**: Find the 8 most vulnerable aspects of the deal team's thesis across all findings.
2. **Craft Targeted Questions**: Each question must be grounded in a specific document finding, not generic.
3. **Provide Context**: For each question, explain why it matters, what a strong answer looks like, and what a weak answer looks like.
4. **Order by Impact**: Put the most thesis-threatening question first.
5. **Consolidate**: Combine overlapping concerns into single, sharper questions.
${MERGE_OUTPUT_STRUCTURE}`,

  model_assumptions_stress: `You are a senior PE operating partner and financial model reviewer. You are synthesizing analyst findings that extracted quantitative model assumptions from deal documents. Your job is to stress-test the deal team's underwriting model.

{{NUMERIC_VERIFICATION_BLOCK}}

## Your Task

1. {{NUMERIC_TASK_STEP_1}}**Compare to Historical Actuals**: Does the assumption align with the company's own historical performance?
2. **Test Internal Consistency**: Do assumptions across documents agree?
3. **Compare Deal Team vs. Management**: Where the deal team has diverged from management's projections, assess whether the haircut is sufficient.
4. **Rate Each Assumption**: Score as Aggressive / Reasonable / Conservative.
5. **Sensitivity Analysis**: For each critical assumption, describe what happens to returns if it is 20% worse.
6. **Consolidate**: Combine overlapping observations into single, stronger findings.
${MERGE_OUTPUT_STRUCTURE}`,

  // diligence_completeness: REMOVED — DCS rebuild (Packet 5B) uses DcsRunPipeline.

  executive_summary: `You are the senior-most investment professional preparing the final IC briefing document. You are synthesizing all module outputs into a cohesive executive summary.

## Your Task

1. Open with an overall investment risk assessment (1-2 sentences)
2. Highlight the 3-5 most important findings across ALL modules
3. Identify patterns or themes that emerge when viewing all modules together
4. Provide a clear recommendation on IC readiness
5. List specific items that must be addressed before IC approval
6. Synthesize and connect findings — do not simply list them
7. Call out contradictions BETWEEN module findings
8. Weight findings by their impact on the investment thesis
${MERGE_OUTPUT_STRUCTURE}`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
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
// API — Pair-merge findings (called iteratively for tree-reduce)
// ---------------------------------------------------------------------------
export default api({
  name: "MergeFindings",
  description: "Synthesizes analyst extractions into consolidated IC-ready findings",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    moduleId: z.string(),
    batches: z.array(z.string()).min(2).max(4),
    roundLabel: z.string(),
    isFinalRound: z.boolean().nullable().optional(),
    useOpus: z.boolean().nullable().optional(),
    numericReport: z.object({
      figures: z.array(z.any()),
      discrepancies: z.array(z.any()),
    }).nullable().optional(),
    numericPartial: z.boolean().nullable().optional(),
  }),

  output: z.object({
    executiveHeader: z.string(),
    findings: z.array(z.any()),
    housekeepingFindings: z.array(z.any()).optional(),
    mergedText: z.string(),
  }),

  async run(ctx, { moduleId, batches, roundLabel, isFinalRound, useOpus, numericReport, numericPartial }) {
    const rawPrompt = MERGE_PROMPTS[moduleId];
    if (!rawPrompt) {
      throw new Error(`Module "${moduleId}" merge prompt not configured.`);
    }

    // Swap in the appropriate findings requirement based on round
    const findingsRule = isFinalRound ? FINDINGS_RULE_FINAL : FINDINGS_RULE_INTERMEDIATE;
    let mergePrompt = rawPrompt.replace("{{FINDINGS_REQUIREMENT}}", findingsRule);

    // Determine whether real numeric verification data is available
    const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

    // Conditionally strip or inject numeric verification instructions.
    // Aligned with pipeline-core.ts: hedged framing ("trustworthy values," not
    // "AUTHORITATIVE GROUND TRUTH"). Cross-version divergences are not asserted
    // errors — they're flagged for analyst confirmation.
    if (hasNumericData) {
      const numericVerificationInstructions = `## NUMERIC VERIFICATION — TRUSTWORTHY VALUES

A "## Numeric Verification Report" section appears in the input below. It contains cell values read directly from the financial model by code — NOT by AI inference. You MUST:
- Treat every "Verified Figure" as a trustworthy cell value from the model
- Flag where NARRATIVE claims (from CIM, IC memo, management presentations) disagree with these values — that is a potential contradiction
- "Cross-Version Divergences" compare the live model to a frozen reference; frame these as "confirm intentional revision vs stale reference," not as asserted errors
- Never invent or re-derive figures — only cite values that appear in the Verified Figures list
- Do NOT treat absence from the list as evidence of a problem — the list covers configured metrics only${numericPartial ? `

⚠️ PARTIAL COVERAGE: The engine ran out of time before processing all tables. Verified Figures are correct for what was analyzed, but coverage is incomplete.` : ""}`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerificationInstructions);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
        "**Cross-Version Divergences First**: If the Numeric Verification Report contains cross-version divergences, assess each cluster and report as findings where they indicate stale references or contradictions (not merely intentional updates).\n");
    } else {
      // Guard: no numeric data available — prevent LLM from hallucinating code-verified labels
      const noNumericGuard = `## IMPORTANT — NO CODE-VERIFIED DATA AVAILABLE

No deterministic numeric verification was performed for this analysis. All figures you cite are derived from AI text interpretation, which is inherently non-deterministic. You MUST:
- NEVER use the phrases "code-verified", "[Code-Verified]", "confirmed by code", or "deterministic verification" in your output
- NEVER label any figure as "confirmed" unless you are comparing two figures explicitly stated in different source documents
- When citing a specific number, state the source document and acknowledge it is "as stated in [document]" or "per [document]"
- Qualify numerical claims appropriately: use "approximately", "as reported", or "per the model" rather than implying independent verification`;
      mergePrompt = mergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", noNumericGuard);
      mergePrompt = mergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
    }

    // Build numeric report block if applicable
    // Aligned with pipeline-core.ts: uses new schema fields (value, period, source_cell)
    // and frames cross-agreement as "divergences to confirm," not "asserted errors."
    let numericBlock = "";
    if (numericReport && NUMERIC_MODULES.has(moduleId) &&
        (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0)) {

      numericBlock =
        `\n\n## Numeric Verification Report\n` +
        `*Source: deterministic cell-value reads from the financial model*\n\n`;

      // Cross-agreement discrepancies (the ONLY discrepancy source)
      if (numericReport.discrepancies.length > 0) {
        numericBlock += `### Cross-Version Divergences\n`;
        numericBlock += `*These are differences between the live model and a frozen reference. Confirm whether each reflects an intentional update or a stale/contradictory reference.*\n\n`;
        for (const d of numericReport.discrepancies) {
          const disc = d as Record<string, unknown>;
          numericBlock += `- **[${String(disc.severity).toUpperCase()}]** ${String(disc.description)}\n`;
        }
        numericBlock += `\n`;
      }

      // Verified figures — trustworthy values for narrative comparison
      if (numericReport.figures.length > 0) {
        numericBlock += `### Verified Figures (Trustworthy Cell Values)\n`;
        numericBlock += `*Flag where narrative claims disagree with these code-read values.*\n\n`;
        const MAX_FIG_DISPLAY = 200;
        const figuresArr = numericReport.figures as Array<Record<string, unknown>>;
        if (figuresArr.length > MAX_FIG_DISPLAY) {
          console.warn(`[merge-findings] numeric figures capped at ${MAX_FIG_DISPLAY} (had ${figuresArr.length})`);
        }
        for (const fig of figuresArr.slice(0, MAX_FIG_DISPLAY)) {
          numericBlock += `- **${String(fig.name)}** (${String(fig.period ?? "")}): ${fig.value} @ ${String(fig.source_cell)}\n`;
        }
      }
    }

    // Build input from analysis sets — dynamically generates headers for 2-4 batches
    const setBlocks = batches.map(
      (text, i) => `## Analysis Set ${i + 1}\n\n${text}`
    );
    const mergeInput = setBlocks.join("\n\n---\n\n") + numericBlock;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: getModuleModel(moduleId, useOpus),
          max_tokens: MERGE_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: mergePrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: mergeInput }],
        },
      },
      { response: MessageResponseSchema },
      { label: `Group-merge (${batches.length}-way): ${roundLabel}` }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in merge response");
    }

    const output = textBlock.text;

    // Parse XML output
    const executiveHeader =
      extractTag(output, "executive_header") ||
      "Analysis complete. See findings below.";

    const findingsRaw = extractFindingsJsonTolerant(output);

    // Determine if LLM output was truncated (max_tokens reached)
    const wasTruncated = result.stop_reason === "max_tokens";

    let findings: CanonicalFinding[] = [];

    if (findingsRaw) {
      try {
        const parsed = JSON.parse(findingsRaw);
        const parseResult = parseCanonicalFindings(parsed, {
          mode: "fresh",
          source: "merge-findings",
          truncated: wasTruncated,
        });
        findings = parseResult.findings;

        if (parseResult.invalid.length > 0) {
          console.warn(`[merge] ${parseResult.invalid.length} findings had field issues (kept with defaults)`);
        }
        if (parseResult.malformed_count > 0) {
          console.error(`[merge] ${parseResult.malformed_count} findings were irrecoverably malformed`);
        }

        // Business rule: numeric_unverified findings capped at info severity
        for (const f of findings) {
          if (f.numeric_unverified === true && f.severity !== "info") {
            const original = f.severity;
            (f as any).severity = "info";
            console.log(`[Merge][NumCap] numeric_unverified cap: "${f.title}" | ${original} → info`);
          }
        }

        // CODE BACKSTOP: absence-verification gate — gates on claim shape,
        // not gap_type alone. Any finding asserting absence without verified
        // confidence is capped at info severity.
        const ABSENCE_PATTERNS = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;

        for (const f of findings) {
          const hasAbsenceGapType = f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged";
          const assertsAbsence = !hasAbsenceGapType &&
            (ABSENCE_PATTERNS.test(f.full_analysis || "") || ABSENCE_PATTERNS.test(f.detail || ""));

          if ((hasAbsenceGapType || assertsAbsence) && f.absence_confidence !== "verified_absent") {
            if (!f.absence_confidence) {
              (f as any).absence_confidence = "unverified";
            }
            if (f.severity === "critical" || f.severity === "warning") {
              const original = f.severity;
              (f as any).severity = "info";
              console.log(`[Merge][FixA] Absence cap applied: "${f.title}" | ${original} → info`);
            }
          }
        }
      } catch {
        findings = [{
          finding_id: "", // Will be assigned below by ensureFindingIds-like logic in parseCanonicalFindings
          severity: "info" as const,
          title: "Analysis Complete",
          detail: findingsRaw.slice(0, 300),
          full_analysis: findingsRaw,
          source_docs: [],
        }] as unknown as CanonicalFinding[];
        // Re-parse the single fallback item through canonical parser for UUID assignment
        const fallbackResult = parseCanonicalFindings(
          [{ severity: "info", title: "Analysis Complete", detail: findingsRaw.slice(0, 300), full_analysis: findingsRaw, source_docs: [] }],
          { mode: "fresh", source: "merge-findings-fallback" }
        );
        findings = fallbackResult.findings;
      }
    }

    // Fix 6: Parse housekeeping appendix (sub-materiality + human_review_flag items)
    const housekeepingRaw = extractTag(output, "housekeeping_appendix");
    let housekeepingFindings: CanonicalFinding[] = [];
    if (housekeepingRaw) {
      try {
        const parsed = JSON.parse(housekeepingRaw);
        const hkResult = parseCanonicalFindings(parsed, {
          mode: "fresh",
          source: "merge-findings-housekeeping",
        });
        housekeepingFindings = hkResult.findings;
        // Ensure housekeeping items get category assigned if LLM omitted it
        for (const f of housekeepingFindings) {
          if (!f.category) {
            (f as any).category = "housekeeping";
          }
        }
      } catch {
        // Non-fatal: housekeeping parse failure doesn't break the pipeline
        console.warn("[merge] Failed to parse housekeeping_appendix JSON");
      }
    }

    // MAT-F05: Full narrative enforcement sequence
    // Process-object exclusion → canonical-record lookup → processNarration → authority gate
    // Note: merge-findings operates without a Q3 checkpoint (it IS the merge step).
    // Canonical record map is undefined here — findings without canonical linkage
    // are demoted to non-reportable per F05 rules.
    const preGateCount = findings.length;
    const enforcement = enforceNarrativeBoundary(findings, undefined);
    findings = enforcement.findings as CanonicalFinding[];
    if (findings.length < preGateCount) {
      console.log(`[Merge][F05] Enforcement: ${preGateCount} → ${findings.length} findings (process_excluded=${enforcement.counts.process_excluded}, no_canonical=${enforcement.counts.no_canonical_rejected}, narrative_rejected=${enforcement.counts.narrative_rejected})`);
    }

    // Build a merged text representation for the next round of tree-reduce.
    // Uses the shared buildMergedText() so checkpoint-resumed merges produce
    // byte-identical output.
    const mergedText = buildMergedText(executiveHeader, findings as MergedFinding[]);

    return JSON.parse(JSON.stringify({
      executiveHeader,
      findings,
      housekeepingFindings: housekeepingFindings.length > 0 ? housekeepingFindings : undefined,
      mergedText,
    }));
  },
});
