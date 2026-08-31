/**
 * DCS Compute Dimension Rationales — Packet 6B
 *
 * For each DCS dimension, produces a concise, readable explanation of
 * its coverage status grounded in curated evidence from Packet 6A.
 *
 * The model may explain evidence but never changes verdicts, scores, or citations.
 * Zero database writes in both live and verification modes.
 *
 * Model calls:
 *   - One draft call per dimension
 *   - One support-verification call per dimension
 *   - At most one correction call per dimension (if draft fails validation)
 *   - At most one re-verification call for a corrected draft
 *
 * Transport retries inside callLLMWithHeadroom are separate from these semantic limits.
 */
import { api, z, postgres, anthropic } from "@superblocksteam/sdk-api";
import { DCS_DIMENSIONS } from "./dcs-rubric.js";
import { getModuleModel } from "./model-config.js";
import { callLLMWithHeadroom } from "./call-llm.js";
import type { PipelineContext } from "./pipeline-config.js";
import type { CuratedDimensionPacket, CuratedEvidence } from "./dcs-evidence-curation.js";
import {
  validateRationaleDraft,
  validateSupportResults,
  computeCoverageDepth,
  assembleValidatedRationale,
} from "./dcs-dimension-rationale-validator.js";
import type {
  RationaleDraftCandidate,
  DimensionRationale,
  ValidationMetadata,
  SupportVerificationResult,
  Citation,
} from "./dcs-dimension-rationale-validator.js";

// ── Integration IDs ──────────────────────────────────────────────
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ── Constants ────────────────────────────────────────────────────
const STAGGER_MS = 50;
const PLATFORM_HEADROOM_RESERVE_MS = 60_000;
const MAX_DRAFT_TOKENS = 6144;
const MAX_VERIFY_TOKENS = 2048;

// ═══════════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════════

const InputSchema = z.object({
  dealId: z.string().uuid(),
  runId: z.string().uuid(),
  mode: z.enum(["live", "verification"]),
  concurrency: z.number().int().min(1).max(4).default(3),
  debug: z.boolean().default(false),
  verificationCandidates: z.any().optional(),
});

const TelemetrySchema = z.object({
  dimensionsProcessed: z.number(),
  draftCalls: z.number(),
  verificationCalls: z.number(),
  correctionAttempts: z.number(),
  correctionRecoveries: z.number(),
  configuredConcurrency: z.number(),
  maxObservedConcurrency: z.number(),
  elapsedMs: z.number(),
});

const OutputSchema = z.object({
  runId: z.string(),
  mode: z.string(),
  rationales: z.any(), // DimensionRationale[] — validated by code, not z.any() for size
  telemetry: TelemetrySchema,
});

// ═══════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Deliverable 3 drafting rules
// ═══════════════════════════════════════════════════════════════════

const DRAFT_SYSTEM_PROMPT = `You are a diligence analyst producing a grounded explanation of evidence coverage for one dimension of an investment committee due diligence completeness review.

You receive:
- The dimension name and its fixed coverage status
- Coverage questions for this dimension
- Up to four curated evidence anchors with exact snippets and source files
- Scope notes and readability warnings where applicable

You must produce a JSON object with this exact structure:
{
  "dimensionId": "<dimension_id>",
  "whyStatus": { "text": "<1-2 sentences explaining why this coverage status applies>", "citationIds": ["<evidence_ids>"] },
  "questionAssessments": [
    { "questionId": "q1", "question": "<exact question text>", "status": "established|partial|not_established", "explanation": "<1-2 sentences>", "citationIds": ["<evidence_ids>"] }
  ],
  "establishedPoints": [
    { "claimId": "ep1", "text": "<decision-relevant proposition>", "citationIds": ["<evidence_ids>"] }
  ],
  "remainingGaps": [
    { "gapId": "g1", "text": "<material limitation>", "basisType": "coverage_question|scope_note|evidence_limitation", "basisIds": ["<question_ids or scope note references>"], "citationIds": ["<evidence_ids or empty>"] }
  ],
  "icImplication": { "text": "<why evidence or gaps matter for underwriting>", "citationIds": ["<evidence_ids>"], "isInference": true },
  "citations": [
    { "evidenceId": "<id>", "sourceFile": "<exact filename>", "humanLocation": "<location or empty>", "docClass": "<narrative|workproduct>", "exactSnippet": "<exact snippet text>" }
  ]
}

RULES:
- Write in plain English. No Markdown headings, bullets, bold, tables, or code blocks.
- No raw CSV number vectors or chunk UUIDs in explanatory text.
- No score values (1.0, 0.5, 0), evidence row counts, or headline score references.
- No claim that "evidenced" means comprehensive or risk-free.
- No approval or rejection recommendation.
- No invented documents, facts, dates, or numbers.
- No generic filler such as "the IC should satisfy itself."
- Every number you write must appear in a cited snippet.
- Every positive factual claim must cite at least one evidence ID.
- Absence statements must say "not established in the supplied corpus" rather than claiming work does not exist.
- For narrative-only dimensions, distinguish sponsor/IC assertions from independent workproduct.
- Citations must use the exact evidenceId, sourceFile, humanLocation, docClass, and snippet provided to you.
- Produce exactly one assessment for every coverage question provided.
- Maximum 1-4 established points, 1-3 remaining gaps.
- Maximum approximately 250 words total across all text fields.
- Return valid JSON only, no surrounding text.`;

const VERIFY_SYSTEM_PROMPT = `You are a verification analyst. For each claim, determine whether the cited evidence snippet supports the claim text.

You receive an array of claims, each with:
- claimId
- text (the claim)
- citedSnippets (array of { evidenceId, snippet })
- isInference (boolean, true for IC implications)

Return a JSON array of verification results:
[
  {
    "claimId": "<id>",
    "supported": true|false,
    "supportingCitationIds": ["<evidence_ids that support>"],
    "reasonCode": "SUPPORTED|NOT_SUPPORTED|CITATION_MISMATCH|OVERSTATED_SCOPE|NUMERIC_MISMATCH|UNSUPPORTED_INFERENCE"
  }
]

Rules:
- SUPPORTED: the claim is directly supported by or reasonably inferred from the cited snippet content
- NOT_SUPPORTED: the claim has no basis in the cited snippets
- CITATION_MISMATCH: the claim references a different fact than what the snippet describes
- OVERSTATED_SCOPE: the claim goes beyond what the snippet establishes
- NUMERIC_MISMATCH: numbers in the claim differ from the snippet
- UNSUPPORTED_INFERENCE: an inference with NO logical connection to the evidence

IMPORTANT for claims marked isInference=true (IC implications):
- These are EXPECTED to be inferences drawn from the evidence
- Mark as SUPPORTED if the inference is a reasonable logical conclusion from the cited evidence
- Only mark as UNSUPPORTED_INFERENCE if the inference has absolutely no connection to the evidence
- An inference that follows from the evidence is valid even if the evidence does not state the conclusion explicitly

Return valid JSON only, no surrounding text.`;

const CORRECTION_SYSTEM_PROMPT = `You are re-drafting a dimension rationale that failed validation. You receive the same curated evidence packet and a list of specific validation errors.

IMPORTANT: Produce a COMPLETE rationale JSON from scratch, not a partial fix. The entire previous draft is discarded.

Follow exactly the same JSON structure and rules as the original drafting instructions. Pay special attention to:
- Include ALL coverage questions (one assessment each)
- Every positive claim needs citation IDs
- Citations must exactly match the provided evidence (evidenceId, sourceFile, humanLocation, docClass, snippet)
- No Markdown, no UUIDs in text, no score values
- 1-4 established points, 1-3 remaining gaps

Return valid JSON only, no surrounding text.`;

// ═══════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════════

function buildDraftUserPrompt(packet: CuratedDimensionPacket): string {
  const evidenceSection = packet.curatedEvidence
    .map((e, i) => {
      const locStr = e.locationStatus === "resolved" ? e.humanLocation : "";
      const warning = e.readabilityWarning ? `\n  [Readability warning: ${e.readabilityWarning}]` : "";
      return `Evidence ${i + 1}:
  evidenceId: ${e.evidenceId}
  sourceFile: ${e.sourceFile}
  humanLocation: ${locStr}
  docClass: ${e.docClass}
  isSubstantive: ${e.isSubstantive}
  snippet: ${e.snippet}${warning}`;
    })
    .join("\n\n");

  const questionsSection = packet.coverageQuestions
    .map((q, i) => `  q${i + 1}: ${q}`)
    .join("\n");

  const scopeNotes = packet.scopeNotes.length > 0
    ? `\nScope notes:\n${packet.scopeNotes.map((n) => `  - ${n}`).join("\n")}`
    : "";

  return `DIMENSION: ${packet.dimensionId} (${packet.label})
FIXED COVERAGE STATUS: ${packet.coverageLabel}
DETERMINISTIC STATE: ${packet.deterministicState}

COVERAGE QUESTIONS:
${questionsSection}

CURATED EVIDENCE ANCHORS:
${evidenceSection}
${scopeNotes}

Produce the rationale JSON for this dimension.`;
}

function buildVerifyUserPrompt(
  claims: Array<{ claimId: string; text: string; citedSnippets: Array<{ evidenceId: string; snippet: string }> }>,
): string {
  return `CLAIMS TO VERIFY:
${JSON.stringify(claims, null, 2)}

Verify each claim against its cited snippets and return the verification results JSON array.`;
}

function buildCorrectionUserPrompt(
  packet: CuratedDimensionPacket,
  errors: string[],
): string {
  const draftPrompt = buildDraftUserPrompt(packet);
  const errorList = errors.slice(0, 15).map((e) => `  - ${e}`).join("\n");
  return `${draftPrompt}

PREVIOUS DRAFT FAILED VALIDATION. Errors:
${errorList}

Produce a COMPLETE, corrected rationale JSON from scratch addressing all errors above.`;
}

// ═══════════════════════════════════════════════════════════════════
// JSON EXTRACTION HELPER
// ═══════════════════════════════════════════════════════════════════

function extractJson(raw: string): string {
  let text = raw.trim();

  // Strip ```json ... ``` wrapper if present
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*)\n\s*```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else if (text.startsWith("```")) {
    const lines = text.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    text = lines.join("\n").trim();
  }

  // Fix common JSON issues from LLM output:
  // 1. Trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");
  // 2. Single-quoted strings → double-quoted (only simple cases)
  // 3. Strip JS-style comments
  text = text.replace(/\/\/[^\n]*/g, "");

  return text;
}

function safeJsonParse(raw: string, label: string): any {
  const text = extractJson(raw);
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try to find the first { or [ and last } or ]
    const firstBrace = text.indexOf("{");
    const firstBracket = text.indexOf("[");
    const start = firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)
      ? firstBrace : firstBracket;
    if (start >= 0) {
      const isObj = text[start] === "{";
      const closer = isObj ? "}" : "]";
      const lastClose = text.lastIndexOf(closer);
      if (lastClose > start) {
        let extracted = text.slice(start, lastClose + 1);
        extracted = extracted.replace(/,\s*([}\]])/g, "$1");
        try {
          return JSON.parse(extracted);
        } catch {
          // fall through
        }
      }
    }
    throw new Error(`Failed to parse ${label} JSON: ${(e as Error).message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PARSE MODEL RESPONSE INTO CANDIDATE
// ═══════════════════════════════════════════════════════════════════

function parseDraftResponse(raw: string, dimensionId: string): RationaleDraftCandidate {
  const json = safeJsonParse(raw, `draft:${dimensionId}`);

  return {
    dimensionId: json.dimensionId ?? dimensionId,
    whyStatus: {
      text: String(json.whyStatus?.text ?? ""),
      citationIds: Array.isArray(json.whyStatus?.citationIds) ? json.whyStatus.citationIds : [],
    },
    questionAssessments: Array.isArray(json.questionAssessments)
      ? json.questionAssessments.map((qa: any) => ({
          questionId: String(qa.questionId ?? ""),
          question: String(qa.question ?? ""),
          status: qa.status ?? "not_established",
          explanation: String(qa.explanation ?? ""),
          citationIds: Array.isArray(qa.citationIds) ? qa.citationIds : [],
        }))
      : [],
    establishedPoints: Array.isArray(json.establishedPoints)
      ? json.establishedPoints.map((ep: any) => ({
          claimId: String(ep.claimId ?? ""),
          text: String(ep.text ?? ""),
          citationIds: Array.isArray(ep.citationIds) ? ep.citationIds : [],
        }))
      : [],
    remainingGaps: Array.isArray(json.remainingGaps)
      ? json.remainingGaps.map((g: any) => ({
          gapId: String(g.gapId ?? ""),
          text: String(g.text ?? ""),
          basisType: g.basisType ?? "evidence_limitation",
          basisIds: Array.isArray(g.basisIds) ? g.basisIds : [],
          citationIds: Array.isArray(g.citationIds) ? g.citationIds : [],
        }))
      : [],
    icImplication: {
      text: String(json.icImplication?.text ?? ""),
      citationIds: Array.isArray(json.icImplication?.citationIds) ? json.icImplication.citationIds : [],
      isInference: true as const,
    },
    citations: Array.isArray(json.citations)
      ? json.citations.map((c: any) => ({
          evidenceId: String(c.evidenceId ?? ""),
          sourceFile: String(c.sourceFile ?? ""),
          humanLocation: String(c.humanLocation ?? ""),
          docClass: String(c.docClass ?? ""),
          exactSnippet: String(c.exactSnippet ?? ""),
        }))
      : [],
  };
}

function parseSupportResponse(raw: string): SupportVerificationResult[] {
  const json = safeJsonParse(raw, "supportVerification");
  if (!Array.isArray(json)) throw new Error("Support response is not an array");
  return json.map((r: any) => ({
    claimId: String(r.claimId ?? ""),
    supported: Boolean(r.supported),
    supportingCitationIds: Array.isArray(r.supportingCitationIds) ? r.supportingCitationIds : [],
    reasonCode: r.reasonCode ?? "NOT_SUPPORTED",
  }));
}

// ═══════════════════════════════════════════════════════════════════
// CITATION SANITIZER — strip hallucinated evidence IDs before validation
// ═══════════════════════════════════════════════════════════════════

function stripHallucinatedCitations(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
): { cleaned: RationaleDraftCandidate; droppedCount: number } {
  // Step 1: Remove citations referencing evidence IDs not in the curated packet
  const validIds = new Set(packet.curatedEvidence.map((e) => e.evidenceId));
  const validCitations = candidate.citations.filter((c) => validIds.has(c.evidenceId));
  const droppedCount = candidate.citations.length - validCitations.length;

  // Step 2: Build set of IDs that actually exist in the (possibly filtered) citations array.
  // This also catches citationIds referencing evidence the model forgot to include in citations.
  const keptIds = new Set(validCitations.map((c) => c.evidenceId));

  // Step 3: Filter citationIds in ALL sections that reference citation IDs
  const filterIds = (ids: string[]) => ids.filter((id) => keptIds.has(id));

  const cleanWhyStatus = {
    ...candidate.whyStatus,
    citationIds: filterIds(candidate.whyStatus.citationIds),
  };
  const cleanQAs = candidate.questionAssessments.map((qa) => ({
    ...qa,
    citationIds: filterIds(qa.citationIds),
  }));
  const filteredEPs = candidate.establishedPoints.map((ep) => ({
    ...ep,
    citationIds: filterIds(ep.citationIds),
  }));
  // Demote EPs that lost all citations to remaining gaps
  const cleanEPs = filteredEPs.filter((ep) => ep.citationIds.length > 0);
  const demotedFromSanitize = filteredEPs
    .filter((ep) => ep.citationIds.length === 0)
    .map((ep) => ({
      gapId: `sanitized_${ep.claimId}`,
      text: ep.text,
      basisType: "evidence_limitation" as const,
      basisIds: [] as string[],
      citationIds: [] as string[],
    }));
  const baseGaps = candidate.remainingGaps.map((g) => ({
    ...g,
    citationIds: filterIds(g.citationIds),
  }));
  // Only add demoted items if under the max gap limit (3)
  const MAX_REMAINING_GAPS = 3;
  const slotsForDemoted = Math.max(0, MAX_REMAINING_GAPS - baseGaps.length);
  const cleanGaps = [...baseGaps, ...demotedFromSanitize.slice(0, slotsForDemoted)];
  const cleanIcImplication = candidate.icImplication
    ? {
        ...candidate.icImplication,
        citationIds: filterIds(candidate.icImplication.citationIds),
      }
    : candidate.icImplication;

  return {
    cleaned: {
      ...candidate,
      citations: validCitations,
      whyStatus: cleanWhyStatus,
      questionAssessments: cleanQAs,
      establishedPoints: cleanEPs,
      remainingGaps: cleanGaps,
      icImplication: cleanIcImplication,
    },
    droppedCount,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SUPPORT DEGRADATION — demote unsupported claims to remaining gaps
// ═══════════════════════════════════════════════════════════════════

function demoteUnsupportedClaims(
  candidate: RationaleDraftCandidate,
  supportResults: SupportVerificationResult[],
): RationaleDraftCandidate {
  const unsupportedIds = new Set(
    supportResults
      .filter((r) => !r.supported && r.claimId !== "icImplication")
      .map((r) => r.claimId),
  );
  if (unsupportedIds.size === 0) return candidate;

  const keptEPs: typeof candidate.establishedPoints = [];
  const demotedGaps: typeof candidate.remainingGaps = [];

  for (const ep of candidate.establishedPoints) {
    if (unsupportedIds.has(ep.claimId)) {
      demotedGaps.push({
        gapId: `demoted_${ep.claimId}`,
        text: ep.text,
        basisType: "evidence_limitation",
        basisIds: [],
        citationIds: ep.citationIds,
      });
    } else {
      keptEPs.push(ep);
    }
  }

  // Cap total remaining gaps at 3 to stay within validator limits
  const MAX_REMAINING_GAPS_DEMOTE = 3;
  const demoteSlotsAvailable = Math.max(0, MAX_REMAINING_GAPS_DEMOTE - candidate.remainingGaps.length);
  const cappedDemotedGaps = demotedGaps.slice(0, demoteSlotsAvailable);

  return {
    ...candidate,
    establishedPoints: keptEPs,
    remainingGaps: [...candidate.remainingGaps, ...cappedDemotedGaps],
  };
}

// ═══════════════════════════════════════════════════════════════════
// DIMENSION PROCESSOR
// ═══════════════════════════════════════════════════════════════════

interface DimensionProcessResult {
  rationale: DimensionRationale;
  draftCalls: number;
  verificationCalls: number;
  correctionAttempted: boolean;
  correctionRecovered: boolean;
}

async function processDimension(
  pipelineCtx: PipelineContext,
  packet: CuratedDimensionPacket,
  model: string,
  pipelineStartTime: number,
): Promise<DimensionProcessResult> {
  let draftCalls = 0;
  let verificationCalls = 0;
  let correctionAttempted = false;
  let correctionRecovered = false;
  let supportDegraded = false;

  // ── Step 1: Draft call ──
  const draftPrompt = buildDraftUserPrompt(packet);
  draftCalls++;

  const draftResponse = await callLLMWithHeadroom(
    pipelineCtx,
    {
      model,
      max_tokens: MAX_DRAFT_TOKENS,
      system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT }],
      messages: [{ role: "user", content: draftPrompt }],
    },
    `DcsRationale:draft:${packet.dimensionId}`,
    {
      pipelineStartTime,
      maxPerCallTimeout: 60_000,
      retries: 2,
      minBudget: PLATFORM_HEADROOM_RESERVE_MS,
    },
  );

  if (draftResponse.stop_reason === "max_tokens") {
    throw new Error(`Dimension ${packet.dimensionId}: draft truncated by max_tokens (${MAX_DRAFT_TOKENS})`);
  }
  const draftRaw = draftResponse.content[0]?.text ?? "";
  let candidate = parseDraftResponse(draftRaw, packet.dimensionId);

  // Strip any hallucinated citation IDs before validation
  const draftSanitize = stripHallucinatedCitations(candidate, packet);
  candidate = draftSanitize.cleaned;

  // ── Step 2: Deterministic validation ──
  let validation = validateRationaleDraft(candidate, packet);

  // ── Step 3: If validation fails, try one correction ──
  if (!validation.valid) {
    correctionAttempted = true;

    const correctionPrompt = buildCorrectionUserPrompt(packet, validation.errors);
    draftCalls++;

    const correctionResponse = await callLLMWithHeadroom(
      pipelineCtx,
      {
        model,
        max_tokens: MAX_DRAFT_TOKENS,
        system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: correctionPrompt }],
      },
      `DcsRationale:correction:${packet.dimensionId}`,
      {
        pipelineStartTime,
        maxPerCallTimeout: 60_000,
        retries: 2,
        minBudget: PLATFORM_HEADROOM_RESERVE_MS,
      },
    );

    if (correctionResponse.stop_reason === "max_tokens") {
      throw new Error(`Dimension ${packet.dimensionId}: correction truncated by max_tokens`);
    }
    const correctionRaw = correctionResponse.content[0]?.text ?? "";
    candidate = parseDraftResponse(correctionRaw, packet.dimensionId);

    // Strip any hallucinated citation IDs before re-validation
    const correctionSanitize = stripHallucinatedCitations(candidate, packet);
    candidate = correctionSanitize.cleaned;

    validation = validateRationaleDraft(candidate, packet);

    if (!validation.valid) {
      throw new Error(
        `Dimension ${packet.dimensionId}: correction failed validation: ${validation.errors.join("; ")}`,
      );
    }
    correctionRecovered = true;
  }

  // ── Step 4: Support verification ──
  const claimsToVerify: Array<{
    claimId: string;
    text: string;
    isInference: boolean;
    citedSnippets: Array<{ evidenceId: string; snippet: string }>;
  }> = [];

  // Build snippet lookup from citations
  const snippetMap = new Map<string, string>();
  for (const cit of candidate.citations) {
    snippetMap.set(cit.evidenceId, cit.exactSnippet);
  }

  // Established points
  for (const ep of candidate.establishedPoints) {
    claimsToVerify.push({
      claimId: ep.claimId,
      text: ep.text,
      isInference: false,
      citedSnippets: ep.citationIds.map((id) => ({
        evidenceId: id,
        snippet: snippetMap.get(id) ?? "",
      })),
    });
  }

  // IC implication
  claimsToVerify.push({
    claimId: "icImplication",
    text: candidate.icImplication.text,
    isInference: true,
    citedSnippets: candidate.icImplication.citationIds.map((id) => ({
      evidenceId: id,
      snippet: snippetMap.get(id) ?? "",
    })),
  });

  const verifyPrompt = buildVerifyUserPrompt(claimsToVerify);
  verificationCalls++;

  const verifyResponse = await callLLMWithHeadroom(
    pipelineCtx,
    {
      model,
      max_tokens: MAX_VERIFY_TOKENS,
      system: [{ type: "text", text: VERIFY_SYSTEM_PROMPT }],
      messages: [{ role: "user", content: verifyPrompt }],
    },
    `DcsRationale:verify:${packet.dimensionId}`,
    {
      pipelineStartTime,
      maxPerCallTimeout: 60_000,
      retries: 2,
      minBudget: PLATFORM_HEADROOM_RESERVE_MS,
    },
  );

  const verifyRaw = verifyResponse.content[0]?.text ?? "";
  let supportResults = parseSupportResponse(verifyRaw);
  let supportErrors = validateSupportResults(candidate, supportResults);

  // ── Step 5: If support verification fails and no correction yet, try correction ──
  if (supportErrors.length > 0 && !correctionAttempted) {
    correctionAttempted = true;

    const supportFailErrors = supportResults
      .filter((r) => !r.supported)
      .map((r) => `Claim "${r.claimId}" failed support: ${r.reasonCode}`);

    if (supportFailErrors.length > 0) {
      const correctionPrompt = buildCorrectionUserPrompt(packet, supportFailErrors);
      draftCalls++;

      const correctionResponse = await callLLMWithHeadroom(
        pipelineCtx,
        {
          model,
          max_tokens: MAX_DRAFT_TOKENS,
          system: [{ type: "text", text: DRAFT_SYSTEM_PROMPT }],
          messages: [{ role: "user", content: correctionPrompt }],
        },
        `DcsRationale:correction:${packet.dimensionId}`,
        {
          pipelineStartTime,
          maxPerCallTimeout: 60_000,
          retries: 2,
          minBudget: PLATFORM_HEADROOM_RESERVE_MS,
        },
      );

      if (correctionResponse.stop_reason === "max_tokens") {
        throw new Error(`Dimension ${packet.dimensionId}: support correction truncated by max_tokens`);
      }
      const correctionRaw = correctionResponse.content[0]?.text ?? "";
      candidate = parseDraftResponse(correctionRaw, packet.dimensionId);

      // Strip hallucinated citations before re-validation
      const supportCorrSanitize = stripHallucinatedCitations(candidate, packet);
      candidate = supportCorrSanitize.cleaned;

      // Re-validate schema/citations/numerics
      validation = validateRationaleDraft(candidate, packet);
      if (!validation.valid) {
        throw new Error(
          `Dimension ${packet.dimensionId}: post-support correction failed validation: ${validation.errors.join("; ")}`,
        );
      }

      // Re-verify support
      const reVerifyClaimsToVerify: typeof claimsToVerify = [];
      const reSnippetMap = new Map<string, string>();
      for (const cit of candidate.citations) {
        reSnippetMap.set(cit.evidenceId, cit.exactSnippet);
      }
      for (const ep of candidate.establishedPoints) {
        reVerifyClaimsToVerify.push({
          claimId: ep.claimId,
          text: ep.text,
          isInference: false,
          citedSnippets: ep.citationIds.map((id) => ({
            evidenceId: id,
            snippet: reSnippetMap.get(id) ?? "",
          })),
        });
      }
      reVerifyClaimsToVerify.push({
        claimId: "icImplication",
        text: candidate.icImplication.text,
        isInference: true,
        citedSnippets: candidate.icImplication.citationIds.map((id) => ({
          evidenceId: id,
          snippet: reSnippetMap.get(id) ?? "",
        })),
      });

      verificationCalls++;
      const reVerifyResponse = await callLLMWithHeadroom(
        pipelineCtx,
        {
          model,
          max_tokens: MAX_VERIFY_TOKENS,
          system: [{ type: "text", text: VERIFY_SYSTEM_PROMPT }],
          messages: [{ role: "user", content: buildVerifyUserPrompt(reVerifyClaimsToVerify) }],
        },
        `DcsRationale:re-verify:${packet.dimensionId}`,
        {
          pipelineStartTime,
          maxPerCallTimeout: 60_000,
          retries: 2,
          minBudget: PLATFORM_HEADROOM_RESERVE_MS,
        },
      );

      const reVerifyRaw = reVerifyResponse.content[0]?.text ?? "";
      supportResults = parseSupportResponse(reVerifyRaw);
      supportErrors = validateSupportResults(candidate, supportResults);

      if (supportErrors.length > 0) {
        // Graceful degradation: demote unsupported established points to remaining gaps
        candidate = demoteUnsupportedClaims(candidate, supportResults);
        supportDegraded = true;
      } else {
        correctionRecovered = true;
      }
    } else {
      // Graceful degradation: demote unsupported established points to remaining gaps
      candidate = demoteUnsupportedClaims(candidate, supportResults);
      supportDegraded = true;
    }
  } else if (supportErrors.length > 0) {
    // Already attempted correction earlier — demote rather than throw
    candidate = demoteUnsupportedClaims(candidate, supportResults);
    supportDegraded = true;
  }

  // ── Step 6: Assemble validated rationale ──
  const validationMetadata: ValidationMetadata = {
    schemaValidated: true,
    citationsValidated: true,
    numbersValidated: true,
    supportVerified: !supportDegraded,
    correctionAttempted,
    correctionRecovered,
  };

  const rationale = assembleValidatedRationale(candidate, packet, validationMetadata);

  return {
    rationale,
    draftCalls,
    verificationCalls,
    correctionAttempted,
    correctionRecovered,
  };
}

// ═══════════════════════════════════════════════════════════════════
// VERIFICATION CANDIDATE PROCESSOR (no model calls)
// ═══════════════════════════════════════════════════════════════════

function processVerificationCandidate(
  candidate: RationaleDraftCandidate,
  packet: CuratedDimensionPacket,
  supportResults: SupportVerificationResult[],
): DimensionRationale {
  // Run full deterministic validation
  const validation = validateRationaleDraft(candidate, packet);
  if (!validation.valid) {
    throw new Error(
      `Verification candidate for ${packet.dimensionId} failed validation: ${validation.errors.join("; ")}`,
    );
  }

  // Run support verification
  const supportErrors = validateSupportResults(candidate, supportResults);
  if (supportErrors.length > 0) {
    throw new Error(
      `Verification candidate for ${packet.dimensionId} failed support: ${supportErrors.join("; ")}`,
    );
  }

  const validationMetadata: ValidationMetadata = {
    schemaValidated: true,
    citationsValidated: true,
    numbersValidated: true,
    supportVerified: true,
    correctionAttempted: false,
    correctionRecovered: false,
  };

  return assembleValidatedRationale(candidate, packet, validationMetadata);
}

// ═══════════════════════════════════════════════════════════════════
// CONCURRENCY LIMITER
// ═══════════════════════════════════════════════════════════════════

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number,
  staggerMs: number,
): Promise<{ results: T[]; maxObservedConcurrency: number }> {
  const results: T[] = new Array(tasks.length);
  let maxObserved = 0;
  let currentActive = 0;
  let nextIndex = 0;

  return new Promise((resolve, reject) => {
    let completed = 0;
    let hasRejected = false;

    function startNext(): void {
      if (hasRejected) return;
      if (nextIndex >= tasks.length) return;

      const idx = nextIndex++;
      currentActive++;
      maxObserved = Math.max(maxObserved, currentActive);

      tasks[idx]()
        .then((result) => {
          if (hasRejected) return;
          results[idx] = result;
          currentActive--;
          completed++;

          if (completed === tasks.length) {
            resolve({ results, maxObservedConcurrency: maxObserved });
          } else {
            startNext();
          }
        })
        .catch((err) => {
          if (!hasRejected) {
            hasRejected = true;
            reject(err);
          }
        });
    }

    // Launch initial batch with stagger
    const initialBatch = Math.min(maxConcurrency, tasks.length);
    for (let i = 0; i < initialBatch; i++) {
      setTimeout(() => startNext(), i * staggerMs);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// API DEFINITION — Deliverable 9
// ═══════════════════════════════════════════════════════════════════

export default api({
  name: "DcsComputeDimensionRationales",
  description: "Produces grounded dimension rationales from curated 6A evidence",

  integrations: {
    ic_diligence_db: postgres(IC_DILIGENCE_DB),
    ai: anthropic(ANTHROPIC_ID),
  },

  input: InputSchema,
  output: OutputSchema,

  async run(ctx, input) {
    const pipelineStartTime = Date.now();
    const db = ctx.integrations.ic_diligence_db;

    // ── Build pipeline context ──
    const pipelineCtx: PipelineContext = {
      integrations: {
        db: ctx.integrations.ic_diligence_db,
        ai: ctx.integrations.ai,
      },
    };

    // ── Validate mode constraints ──
    if (input.mode === "live" && input.verificationCandidates !== undefined) {
      throw new Error("verificationCandidates are not permitted in live mode.");
    }

    // ── 1. Validate deal/run ownership ──
    const runCheck = await db.query(
      `SELECT id FROM module_runs
       WHERE id = $1::uuid AND deal_id = $2::uuid AND module_id = 'diligence_completeness'
       LIMIT 1`,
      z.object({ id: z.string() }),
      [input.runId, input.dealId],
      { label: "DcsRationales: validate module_runs" },
    );
    if (runCheck.length === 0) {
      throw new Error(
        `No module_runs row for runId=${input.runId} with dealId=${input.dealId} and module_id=diligence_completeness`,
      );
    }

    // ── 2. Require extract status done ──
    const extractState = await db.query(
      `SELECT status FROM dcs_pipeline_state
       WHERE run_id = $1::uuid AND stage = 'extract'
       LIMIT 1`,
      z.object({ status: z.string() }),
      [input.runId],
      { label: "DcsRationales: check extract status" },
    );
    if (extractState.length === 0 || extractState[0].status !== "done") {
      throw new Error(
        `Extract stage not done (status=${extractState[0]?.status ?? "missing"}).`,
      );
    }

    // ── 3. Call DcsComputeVerdicts verification path ──
    // Instead of calling the API, we inline the same DB reads for the curated packets.
    // This avoids a nested API call and uses the same verified data path.

    // We need the curated packets from DcsComputeVerdicts. To avoid circular dependency,
    // we'll import and call the curation functions directly since they're pure.
    const { curateDimensionPackets, computeExitDimensionState } = await import("./dcs-evidence-curation.js");
    const { computeDimensionState, SCORE_VALUES } = await import("./dcs-rubric.js");
    const type_imports = await import("./dcs-evidence-curation.js");

    const EvidenceRowSchema = z.object({
      id: z.string(),
      dimension_id: z.string(),
      chunk_id: z.string(),
      source_file: z.string(),
      document_tag: z.string(),
      doc_class: z.enum(["narrative", "workproduct"]),
      is_substantive: z.boolean(),
      snippet: z.string(),
    });

    const ChunkMetaSchema = z.object({
      chunk_id: z.string(),
      chunk_index: z.number(),
      file_name: z.string(),
      file_type: z.string(),
    });

    const evidenceRows = await db.query(
      `SELECT id, dimension_id, chunk_id, source_file, document_tag, doc_class, is_substantive, snippet
       FROM dcs_evidence
       WHERE run_id = $1::uuid
       ORDER BY dimension_id, chunk_id, source_file`,
      EvidenceRowSchema,
      [input.runId],
      { label: "DcsRationales: read all evidence" },
    );

    // Load chunk metadata
    const distinctChunkIds = [...new Set(evidenceRows.map((r) => r.chunk_id))];
    const chunkMetaMap = new Map<string, { chunk_id: string; chunk_index: number; file_name: string; file_type: string }>();

    if (distinctChunkIds.length > 0) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < distinctChunkIds.length; i += BATCH_SIZE) {
        const batch = distinctChunkIds.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map((_, idx) => `$${idx + 1}::uuid`).join(",");
        const chunkMetas = await db.query(
          `SELECT dc.id AS chunk_id, dc.chunk_index, dc.file_name,
                  COALESCE(d.file_type, 'unknown') AS file_type
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE dc.id IN (${placeholders})
           LIMIT ${BATCH_SIZE}`,
          ChunkMetaSchema,
          batch,
          { label: `DcsRationales: chunk metadata batch ${Math.floor(i / BATCH_SIZE) + 1}` },
        );
        for (const cm of chunkMetas) {
          chunkMetaMap.set(cm.chunk_id, cm);
        }
      }
    }

    // Build curated packets
    const rawEvidenceForCurator = evidenceRows.map((r) => ({
      id: r.id,
      dimension_id: r.dimension_id,
      chunk_id: r.chunk_id,
      source_file: r.source_file,
      document_tag: r.document_tag,
      doc_class: r.doc_class as "narrative" | "workproduct",
      is_substantive: r.is_substantive,
      snippet: r.snippet,
    }));

    const curatedPackets = curateDimensionPackets(rawEvidenceForCurator, chunkMetaMap);

    // ── 4. Require exactly ten packets ──
    if (curatedPackets.length !== 10) {
      throw new Error(`Expected 10 curated packets, got ${curatedPackets.length}`);
    }

    // ── 5. Process dimensions ──
    const model = getModuleModel("diligence_completeness");
    const telemetry = {
      dimensionsProcessed: 0,
      draftCalls: 0,
      verificationCalls: 0,
      correctionAttempts: 0,
      correctionRecoveries: 0,
      configuredConcurrency: input.concurrency,
      maxObservedConcurrency: 0,
      elapsedMs: 0,
    };

    let rationales: DimensionRationale[];

    if (input.verificationCandidates !== undefined) {
      // ── Verification candidate path: zero model calls ──
      const candidates = input.verificationCandidates as Array<{
        candidate: RationaleDraftCandidate;
        supportResults: SupportVerificationResult[];
      }>;

      if (!Array.isArray(candidates) || candidates.length !== 10) {
        throw new Error(`verificationCandidates must be an array of 10 items, got ${Array.isArray(candidates) ? candidates.length : "non-array"}`);
      }

      rationales = [];
      for (let i = 0; i < 10; i++) {
        const vc = candidates[i];
        const packet = curatedPackets[i];
        rationales.push(processVerificationCandidate(vc.candidate, packet, vc.supportResults));
      }

      telemetry.dimensionsProcessed = 10;
      telemetry.maxObservedConcurrency = 0;
    } else {
      // ── Live model path ──
      const tasks = curatedPackets.map(
        (packet) => () => processDimension(pipelineCtx, packet, model, pipelineStartTime),
      );

      const { results, maxObservedConcurrency } = await runWithConcurrency(
        tasks,
        input.concurrency,
        STAGGER_MS,
      );

      rationales = results.map((r) => r.rationale);
      telemetry.dimensionsProcessed = results.length;
      telemetry.maxObservedConcurrency = maxObservedConcurrency;

      for (const r of results) {
        telemetry.draftCalls += r.draftCalls;
        telemetry.verificationCalls += r.verificationCalls;
        if (r.correctionAttempted) telemetry.correctionAttempts++;
        if (r.correctionRecovered) telemetry.correctionRecoveries++;
      }
    }

    // ── 6. Require all 10 rationales ──
    if (rationales.length !== 10) {
      throw new Error(`Expected 10 rationales, got ${rationales.length}`);
    }

    telemetry.elapsedMs = Date.now() - pipelineStartTime;

    return {
      runId: input.runId,
      mode: input.mode,
      rationales,
      telemetry,
    };
  },
});
