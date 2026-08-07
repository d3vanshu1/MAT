/**
 * Pipeline Core Logic — shared between RunModulePipeline and ResumeStalePipelines.
 *
 * This is a plain exported function (not an api() wrapper) that contains the
 * full analysis → merge → complete flow with checkpointing. Both the client-driven
 * API and the background safety-net call this same code path.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * INVARIANTS — assumptions this code depends on. Breaking any one silently breaks
 * the pipeline or causes data loss. Update this list when adding new assumptions.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. EXIT-WRITE GUARD: The UPDATE at completion uses
 *    `WHERE id = $1 AND status = 'running'::module_status`
 *    so a cancelled/purged run can never be resurrected by a late-finishing pipeline.
 *
 * 2. CACHE-HIT EXCLUSION OF FAILED ENTRIES: When checking if an extraction
 *    already exists (cache hit), entries with `failed: true` MUST be excluded.
 *    Otherwise the pipeline treats a previous failure as "already done" and
 *    skips the chunk permanently.
 *
 * 3. NUMERIC MODULES REQUIRE A PERSISTED REPORT BEFORE BACKGROUND RESUME:
 *    `contradiction_check` and `model_assumptions_stress` expect a numeric report
 *    passed as input. The background runner (ResumeStalePipelines) must verify
 *    `numeric_report_json IS NOT NULL` before claiming; if absent, skip without
 *    refreshing `triggered_at` (see item 3 fix — pre-claim check).
 *
 * 4. PER-CALL TIMEOUT ON LLM REQUESTS: `callAnthropic` uses a 120s per-call
 *    timeout via Promise.race. Without this, a single hanging Anthropic call
 *    blocks the entire time budget and the pipeline never returns `in_progress`.
 *
 * 5. NO SINGLE OPERATION MAY EXCEED REMAINING PLATFORM HEADROOM: The platform
 *    hard-kills APIs at EFFECTIVE_CAP_MS (pinned to 600s; verified via
 *    DiagTimeoutProbe v2). TIME_BUDGET_MS (500s) governs the pipeline's graceful
 *    exit point but does NOT constrain long-running sub-operations like escalation
 *    retries. Those are independently clamped by extraction-phase.ts to:
 *      min(desiredBudget, EFFECTIVE_CAP_MS − elapsed − PLATFORM_HEADROOM_MS)
 *    If remaining headroom < MIN_ESCALATION_BUDGET_MS (60s), the retry is
 *    DEFERRED to the next invocation without incrementing attempt_count.
 *
 * 6. MERGE CHECKPOINT DE-DUPLICATION: When resuming, existing checkpoints for a
 *    given (run_id, round, group_index) are loaded and skipped. The pipeline must
 *    never re-process a group that already has a checkpoint row.
 *
 * 7. RESPONSE PAYLOAD CAP: `mergedText` is capped at 150K chars before returning
 *    to prevent exceeding the 4MB gRPC transport limit. FormatReport uses its own
 *    context-window truncation anyway.
 *
 * 8. FAILED EXTRACTIONS ARE PERSISTED WITH failed:true: When `universalExtract`
 *    fails after retries, the extraction is saved to `universal_extractions` WITH
 *    `failed: true` in its `extraction_json`. This enables invariant #2: the cache-
 *    hit check excludes `failed: true` entries, so failed chunks are retried on the
 *    next run rather than permanently skipped.
 *
 * 9. SAVE-DOCUMENT parsedText CAP: parsedText is capped at 3.5MB in save-document.ts
 *    to prevent a single INSERT from exceeding the 4MB gRPC limit.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { z } from "@superblocksteam/sdk-api";
import { buildMergedText, type MergedFinding } from "../modules/build-merged-text.js";
import { parseCanonicalFindings, ensureFindingIds, buildMergedFinding, FINDING_SCHEMA_VERSION } from "./canonical-finding.js";
import { parseCheckpointStatus, validateCheckpoint, isCheckpointWriteCritical, type CheckpointStatus } from "./checkpoint-state-machine.js";
import { NUMERIC_MODULES } from "../modules/constants.js";
import { SUB_AGENT_PROMPTS } from "../modules/analyze-chunk.js";
import { MERGE_PROMPTS, FINDINGS_RULE_FINAL, FINDINGS_RULE_INTERMEDIATE } from "../modules/merge-findings.js";
import { runPostCompletionAudit } from "./post-completion-audit.js";
import { validateMergeContract } from "./merge-contract-validator.js";
import { deduplicateFindings } from "./canonical-family-dedup.js";
import { runExtractionPhase } from "./extraction-phase.js";
import { runDocTablesPhase } from "./doc-tables-phase.js";
import { runNumericVerifyInline } from "./numeric-verify-inline.js";
import { runClaimsExtraction, type ClaimsLedger } from "./claims-extraction.js";
import { runReconciliation, validateSupersessionProof, type ReconciliationResult, type ReconciliationFinding, type SupersessionCandidate } from "./claims-reconciliation.js";
import { runCleanParsedTextPhase } from "./clean-parsed-text.js";
import { runWebResearchPhase } from "./web-research-phase.js";
import { upsertModuleOutput } from "../modules/upsert-module-output.js";
import { loadCheckpointStatus } from "./canonical-finalizer.js";
import { getModuleModel, SONNET_MODEL } from "./model-config.js";
import { runChecklistScan, formatCoverageMapForPrompt, type ChecklistScanResult } from "./checklist-scan-phase.js";
import { runAbsenceVerificationPhase } from "./absence-verification-phase.js";
import { getPipelineVersion } from "./pipeline-version.js";
import { parseDateFromFileName } from "./parse-date-from-filename.js";
import { callLLMWithHeadroom, HeadroomExhaustedError, type LLMResponse } from "./call-llm.js";
import { TIME_BUDGET_MS, EFFECTIVE_CAP_MS, PLATFORM_HEADROOM_MS, MIN_VIABLE_LLM_BUDGET_MS, CHECKPOINT_RESERVE_MS, ANALYSIS_WORKER_ENABLED, ANALYSIS_WORKER_BATCH_SIZE } from "./pipeline-config.js";
import type { NumericVerifyResult } from "./numeric-verify-inline.js";
import { populateWorkItems, claimBatch, completeItem, failItem, getAnalysisCounts, isAnalysisComplete, detectMismatches, isWorkerEnabledForRun, WORKER_BATCH_SIZE } from "./analysis-worker.js";
import { buildOriginMapFromRoutedArray, resolveProvenance, serializeOriginMap, deserializeOriginMap, computeOriginMapFingerprint } from "./claim-origin-map.js";
import { buildMergeRootManifest, buildLeafNodes, computeSourceFingerprint, validateManifest, deserializeManifest, type MergeRootManifest, type RoundSummary, type LeafNode, MERGE_ROOT_MANIFEST_VERSION } from "./merge-root-manifest.js";
import { buildSourceSnapshot, validateSourceSnapshot, computeSnapshotFingerprint, computeContentHash, type SourceSnapshot, type BuildSnapshotInput, SOURCE_SNAPSHOT_VERSION } from "./source-snapshot.js";
import { CONTRADICTION_CHECK_ALLOWED_TAGS, isChunkAllowedForContradictionCheck, createPolicySummary, type SourcePolicySummary } from "./source-policy.js";
import { type RoutingDiagnosticEntry, type RoutingDiagnostics } from "./replay-classifier.js";
import { runPostMergeFinalizationStages, type PostMergeFinalizationResult } from "./post-merge-finalization.js";
import { buildEngagementMap, type EngagementMapResult } from "./engagement-map.js";
import { matchAbsenceFindings, type FindingInput, type MatcherOutput } from "./absence-map-matcher.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MAX_TOKENS = 4096;
const MERGE_MAX_TOKENS = 8000;

const ANALYSIS_CONCURRENCY = 15;
const MERGE_CONCURRENCY = 5;
const MERGE_GROUP_SIZE = 4;
const MAX_MERGE_GROUP_FAILURES = 5; // Skip (use fallback) after this many error checkpoints across invocations
const MAX_PARTIAL_RETRIES = 2; // Accept truncated merge checkpoints after this many re-merges still truncate
const MERGE_NODE_TEXT_CAP = 3000; // Max chars per node's text in merge input — prevents token overflow
// TIME_BUDGET_MS is imported from pipeline-config.ts (derived from EFFECTIVE_CAP_MS - 100s, floor 120s)

// Report formatting config (inline, post-merge)
const FORMAT_REPORT_MIN_BUDGET_MS = 100_000; // Need at least 100s to attempt report formatting

// Modules that require checklist scan + absence verification
const CHECKLIST_MODULES = new Set(["omission_audit", "blind_spot_scanner", "diligence_completeness"]);

// Absence verification config (Step 5.5, between merge and format)
const ABSENCE_VERIFICATION_MIN_BUDGET_MS = 120_000; // Need at least 120s — 2 LLM calls per finding
const FORMAT_REPORT_MAX_TOKENS = 12000;
const FORMAT_REPORT_MODEL = SONNET_MODEL; // Always Sonnet — report formatting is quality-critical

/** Modules that go through the web research phase instead of direct analysis */
const WEB_RESEARCH_MODULES = new Set(["external_risk_overlay", "social_reputation"]);

// ---------------------------------------------------------------------------
// Mode-B Shared Helper: Append code-verified reconciliation findings
// ---------------------------------------------------------------------------
// Called from both main-path (post-merge) and fast-path (format-on-resume).
// Mutates finalFindings in-place: appends code-verified findings from reconciliation,
// deduplicates against LLM paraphrases (by matching £-amounts), and concatenates
// housekeeping findings. Must be called AFTER fabricated-arithmetic suppression so
// reconciliation findings bypass that filter entirely.
interface AppendReconResult {
  finalFindings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  /** Fix 11: Structured diagnostics from ID-scoped replacement */
  diagnostics: ReconReplacementDiagnostic[];
}

/** Fix 11: Structured diagnostic for reconciliation replacement operations */
export interface ReconReplacementDiagnostic {
  type: "unknown_target_id" | "replacement_applied" | "idempotent_skip";
  finding_id: string;
  message: string;
  target_ids?: string[];
  removed_ids?: string[];
  unknown_ids?: string[];
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fix 12: Typed Materiality Enforcement (shared helper — main + fast path)
// ---------------------------------------------------------------------------
// Severity is determined by verified structured_impact (preferred), with prose
// £-amount parsing only as a degraded fallback. Prose amounts NEVER escalate;
// they can only confirm or demote. numeric_unverified findings get no uplift.
//
// Priority chain:
//   1. structured_impact (role ∈ {delta, exposure, annual_impact}, verified=true)
//   2. Legal/regulatory risk markers (criminal, licence-to-operate, etc.)
//   3. Cross-version with verified delta
//   4. DEGRADED: severity_anchor/detail parsed £-amounts (not numeric_unverified)
//   5. No data → safe degraded path (demote critical → warning, never escalate)
// ---------------------------------------------------------------------------

const DEAL_EV_MILLIONS = 655;
const MATERIALITY_FLOOR_M = DEAL_EV_MILLIONS * 0.01; // £6.55m

/** Roles whose verified amounts drive the materiality threshold */
const MATERIALITY_DRIVING_ROLES = new Set(["delta", "exposure", "annual_impact"]);

/**
 * Fix 12: Extract canonical materiality figure (£millions) from structured_impact.
 * Only verified entries with a driving role are considered.
 * Returns null when no qualifying entry exists.
 */
function getStructuredMaterialityM(f: MergedFinding): number | null {
  const impacts = f.structured_impact;
  if (!impacts || impacts.length === 0) return null;

  let maxM: number | null = null;
  for (const imp of impacts) {
    if (!imp.verified) continue;
    if (!MATERIALITY_DRIVING_ROLES.has(imp.role)) continue;
    const multiplier = imp.unit_multiplier ?? 1;
    const amountM = Math.abs(imp.amount) * multiplier / 1_000_000;
    if (amountM === 0) continue; // Zero cannot drive threshold
    if (maxM === null || amountM > maxM) maxM = amountM;
  }
  return maxM;
}

/** Extract £-figures from text, returning values in millions.
 *  Fix 12: DEGRADED fallback — only used when structured_impact is absent. */
function parsePoundFiguresMillions(text: string): number[] {
  if (!text) return [];
  const results: number[] = [];
  const patterns = [
    /£([\d,.]+)\s*m(?:illion|n)?/gi,
    /£([\d,.]+)\s*bn?/gi,
    /£([\d,.]+)\s*k/gi,
    /£([\d,]+(?:\.\d+)?)\b(?!\s*[mkb])/gi,
  ];
  for (const m of text.matchAll(patterns[0])) {
    const val = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(val)) results.push(val);
  }
  for (const m of text.matchAll(patterns[1])) {
    const val = parseFloat(m[1].replace(/,/g, "")) * 1000;
    if (!isNaN(val)) results.push(val);
  }
  for (const m of text.matchAll(patterns[2])) {
    const val = parseFloat(m[1].replace(/,/g, "")) / 1000;
    if (!isNaN(val)) results.push(val);
  }
  for (const m of text.matchAll(patterns[3])) {
    const val = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(val) && val >= 1000) results.push(val / 1_000_000);
  }
  return results;
}

/** Fix 12: Legal/regulatory consequence markers that drive severity
 *  independently of £ amount (criminal, licence-to-operate, completion blocker). */
const MATERIAL_RISK_MARKERS = [
  /criminal\s+(?:offen[cs]e|exposure|liability|prosecution)/i,
  /regulatory\s+breach/i,
  /going\s+concern/i,
  /unlimited[\s/]+uncapped\s+liabilit/i,
  /uncapped\s+(material\s+)?liabilit/i,
  /unlimited\s+liabilit/i,
  /licence.to.operate/i,
  /completion.?block/i,
  /business.?continuity/i,
  /section\s+19/i,  // FCA section 19 — criminal exposure
];

function hasMaterialRiskMarker(f: MergedFinding): boolean {
  if (f.finding_kind === "source_stated_risk" && f.severity === "critical") return true;
  const text = `${f.title} ${f.detail} ${f.full_analysis} ${f.severity_anchor ?? ""}`;
  return MATERIAL_RISK_MARKERS.some(pat => pat.test(text));
}

/** Check if finding is a cross-version data_divergence.
 *  Corrective C: source-document count is NOT a cross-version signal. */
function isCrossVersionDivergence(f: MergedFinding): boolean {
  if (f.finding_kind === "cross_version") return true;
  if (f.finding_kind !== "data_divergence") return false;
  const text = `${f.title} ${f.detail} ${f.full_analysis}`;
  if (/\[CROSS_VERSION\]/i.test(text)) return true;
  return /(?:v\d+|version\s*\d+|draft|final|earlier\s+memo|later\s+memo|updated\s+memo)\s*(?:vs\.?|versus|compared\s+(?:to|with))\s*(?:v\d+|version\s*\d+|draft|final|earlier\s+memo|later\s+memo|updated\s+memo)/i.test(text);
}

interface MaterialityResult {
  findings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  demotedCount: number;
}

// ---------------------------------------------------------------------------
// Corrective F: Exported structured identity utilities for testing
// ---------------------------------------------------------------------------

/**
 * Extract deterministic identity from a finding's evidence and structured_impact.
 * Exported for unit testing — production code uses the inline closure version.
 */
export function extractFindingIdentity(finding: any): Map<string, Set<string>> {
  const identity = new Map<string, Set<string>>();

  const addValue = (key: string, value: string | undefined | null) => {
    if (!value || typeof value !== "string") return;
    const normalized = value.toLowerCase().trim();
    if (!normalized) return;
    if (!identity.has(key)) identity.set(key, new Set());
    identity.get(key)!.add(normalized);
  };

  addValue("metric", finding.metric);
  addValue("period", finding.period);
  addValue("scope", finding.scope);
  addValue("entity", finding.entity);
  addValue("currency", finding.currency);
  addValue("accounting_basis", finding.accounting_basis);
  addValue("actual_vs_forecast", finding.actual_vs_forecast);
  addValue("legal_clause", finding.legal_clause);
  addValue("legal_consequence", finding.legal_consequence);
  addValue("impact_type", finding.impact_type);
  addValue("contract_provision", finding.contract_provision);

  const evidence = finding.evidence;
  if (Array.isArray(evidence)) {
    for (const ev of evidence) {
      if (!ev || typeof ev !== "object") continue;
      addValue("metric", ev.metric);
      addValue("period", ev.period);
      addValue("scope", ev.scope);
      addValue("entity", ev.entity);
      addValue("currency", ev.currency);
      addValue("accounting_basis", ev.accounting_basis);
      addValue("actual_vs_forecast", ev.actual_or_forecast);
      addValue("sheet_or_page", ev.sheet_or_page);
      addValue("cell_coordinate", ev.cell_coordinate);
      addValue("source_doc", ev.source_doc);
      addValue("unit", ev.unit);
    }
  }

  const impacts = finding.structured_impact;
  if (Array.isArray(impacts)) {
    for (const imp of impacts) {
      if (!imp || typeof imp !== "object") continue;
      addValue("impact_type", imp.role);
      addValue("currency", imp.currency);
      addValue("source_doc", imp.source_doc);
      addValue("source_coordinate", imp.source_coordinate);
    }
  }

  addValue("finding_kind", finding.finding_kind);
  return identity;
}

/**
 * Check if two structured identities are compatible.
 * Exported for unit testing.
 */
export function findingIdentitiesAreCompatible(
  idA: Map<string, Set<string>>,
  idB: Map<string, Set<string>>,
): boolean {
  const allDims = new Set([...idA.keys(), ...idB.keys()]);
  const discriminatingDims = new Set([
    "metric", "period", "scope", "entity", "sheet_or_page",
    "cell_coordinate", "legal_clause", "legal_consequence",
    "contract_provision", "accounting_basis", "actual_vs_forecast",
  ]);

  for (const dim of allDims) {
    const setA = idA.get(dim);
    const setB = idB.get(dim);
    if ((!setA || setA.size === 0) && (!setB || setB.size === 0)) continue;
    if (setA && setA.size > 0 && setB && setB.size > 0) {
      let hasOverlap = false;
      for (const v of setA) {
        if (setB.has(v)) { hasOverlap = true; break; }
      }
      if (!hasOverlap) return false;
      continue;
    }
    if (discriminatingDims.has(dim)) {
      const populatedSet = setA && setA.size > 0 ? setA : setB;
      if (populatedSet && populatedSet.size > 0) return false;
    }
  }
  return true;
}

export function enforceMaterialityGate(
  findings: MergedFinding[],
  housekeepingFindings: MergedFinding[]
): MaterialityResult {
  let demotedCount = 0;
  const survivingFindings: MergedFinding[] = [];

  for (const f of findings) {
    // --- Fix 12: Structured impact path (preferred) ---
    const structuredM = getStructuredMaterialityM(f);
    const hasStructuredImpact = structuredM !== null;

    // --- Fix 18: Prose-driven severity escalation REMOVED ---
    // Free-form prose (severity_anchor, detail, full_analysis) may NEVER supply
    // the controlling amount for severity escalation. Only verified structured_impact
    // entries may provide the materiality figure.
    // When structured_impact is absent, the finding follows a safe degraded path
    // that records structured_impact_missing and cannot escalate numerically.
    const effectiveM = hasStructuredImpact ? structuredM : null;

    const hasRiskMarker = hasMaterialRiskMarker(f);
    const isCrossVersion = isCrossVersionDivergence(f);

    if (f.severity === "critical") {
      const hasAdequateAnchor = effectiveM !== null && effectiveM >= MATERIALITY_FLOOR_M;

      if (hasAdequateAnchor || hasRiskMarker || isCrossVersion) {
        survivingFindings.push(f);
      } else if (effectiveM !== null && effectiveM < MATERIALITY_FLOOR_M) {
        demotedCount++;
        if (effectiveM < 0.5) {
          housekeepingFindings.push({
            ...f,
            severity: "info",
            category: "housekeeping",
            materiality_rationale: `[CODE_ENFORCED] £${effectiveM < 0.01 ? (effectiveM * 1000).toFixed(0) + "k" : effectiveM.toFixed(1) + "m"} (verified structured) is ${((effectiveM / DEAL_EV_MILLIONS) * 100).toFixed(2)}% of EV — below 1% materiality threshold (£${MATERIALITY_FLOOR_M.toFixed(1)}m).`,
          });
        } else {
          survivingFindings.push({
            ...f,
            severity: "warning",
            materiality_rationale: `[CODE_ENFORCED] £${effectiveM.toFixed(1)}m (verified structured) (${((effectiveM / DEAL_EV_MILLIONS) * 100).toFixed(2)}% of EV) below critical threshold of £${MATERIALITY_FLOOR_M.toFixed(1)}m. Demoted from critical.`,
          });
        }
      } else {
        // No figure — Fix 18: safe degraded path (structured_impact_missing)
        // Cannot escalate numerically without verified structured impact.
        if (!hasRiskMarker && !isCrossVersion) {
          demotedCount++;
          survivingFindings.push({
            ...f,
            severity: "warning",
            materiality_rationale: `[CODE_ENFORCED] structured_impact_missing — no verified structured impact available. Safe degraded path: demoted from critical to warning. Prose amounts are not permitted to drive severity.`,
          });
        } else {
          survivingFindings.push(f);
        }
      }
    } else {
      // Non-critical: sub-threshold → housekeeping
      if (effectiveM !== null && effectiveM < 0.5 && f.category !== "housekeeping") {
        demotedCount++;
        housekeepingFindings.push({
          ...f,
          severity: "info",
          category: "housekeeping",
          materiality_rationale: `[CODE_ENFORCED] £${effectiveM < 0.01 ? (effectiveM * 1000).toFixed(0) + "k" : effectiveM.toFixed(1) + "m"} (verified structured) is ${((effectiveM / DEAL_EV_MILLIONS) * 100).toFixed(3)}% of EV — sub-materiality for £${DEAL_EV_MILLIONS}m transaction.`,
        });
      } else {
        survivingFindings.push(f);
      }
    }
  }

  if (demotedCount > 0) {
    console.log(`[pipeline] Materiality gate: demoted ${demotedCount} finding(s)`);
  }

  return { findings: survivingFindings, housekeepingFindings, demotedCount };
}

// ---------------------------------------------------------------------------
// Absence Verification Gate (FP-1) — Code-enforced check that demotes
// false "not disclosed in memo" findings when the topic IS retrievable from
// IC-memo document chunks. Runs after reconciliation, before materiality gate.
// ---------------------------------------------------------------------------

/** Minimum distinct memo chunks that must match to consider topic "disclosed" */
const ABSENCE_GATE_MIN_MEMO_CHUNKS = 2;
/** Minimum keywords that a SINGLE chunk must match (fallback if fewer distinct chunks) */
const ABSENCE_GATE_MIN_KEYWORDS_PER_CHUNK = 2;

/** IC memo file_name pattern */
const IC_MEMO_FILE_PATTERN = /IC[_ ]Memo|IC update/i;

/** Absence-claim detection — same regex used by RC5 defense-in-depth */
const ABSENCE_CLAIM_PATTERN = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed|not surfaced|not reflected|not mentioned|undisclosed|not flagged|not highlighted)\b/i;

/** Stopwords to strip when extracting salient keywords from finding title */
const STOPWORDS = new Set([
  "the", "a", "an", "in", "of", "on", "at", "to", "for", "is", "are", "was",
  "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "shall", "would", "could", "should", "may", "might", "can", "and",
  "or", "but", "if", "so", "not", "no", "nor", "by", "from", "with", "as",
  "this", "that", "it", "its", "ic", "memo", "memos", "disclosed", "disclose",
  "absent", "missing", "mentioned", "discussed", "addressed", "surfaced",
  "reflected", "flagged", "highlighted", "undisclosed", "confirm", "confirmed",
  "evidence", "reference", "mention",
]);

/**
 * Generic high-frequency deal terms that match too many chunks indiscriminately.
 * These are removed from the keyword set used for memo-hit matching; they may
 * still appear in log output but MUST NOT drive demotion decisions.
 */
const GENERIC_TERMS = new Set([
  "customer", "customers", "contract", "contracts", "rights", "key", "general",
  "risk", "risks", "execution", "forecast", "annual", "average", "latest",
  "material", "group", "revenue", "growth", "margin", "terms", "agreement",
  "business", "market", "value", "total", "net", "rate", "period", "year",
  "report", "analysis", "management", "company", "deal", "target", "investment",
  "portfolio", "fund", "partner", "equity", "debt", "capital", "cash", "cost",
  "costs", "performance", "operations", "operational", "financial", "strategy",
  "strategic", "plan", "planning", "due", "diligence", "review", "assessment",
  "impact", "potential", "significant", "current", "future", "expected",
  "projected", "estimated", "approximately", "based", "level", "status",
  "position", "structure", "process", "service", "services", "product",
  "products", "sector", "industry", "provider", "suppliers", "supplier",
  "unquantified", "quantified", "termination",
]);

/**
 * Minimal query-function interface so the gate can be tested without a live DB.
 */
export interface AbsenceGateQueryFn {
  (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }): Promise<any[]>;
}

const AbsenceGateChunkSchema = z.object({
  file_name: z.string(),
  chunk_index: z.coerce.number(),
  content: z.string(),
});

/**
 * Extracts 3-6 salient keywords from a finding title.
 * Strips stopwords, absence verbs, and short tokens.
 */
export function extractSalientKeywords(title: string): string[] {
  const tokens = title
    .replace(/[^a-zA-Z0-9&%/.-]/g, " ")
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  // Deduplicate and take up to 6
  const unique = [...new Set(tokens)];
  return unique.slice(0, 6);
}

/**
 * Filters keywords to only distinctive (non-generic) terms.
 * These are the terms that actually indicate topic specificity.
 * When in doubt, RETAIN the finding — if no distinctive terms survive, we cannot
 * verify the claim and must keep it.
 */
export function extractDistinctiveKeywords(allKeywords: string[]): string[] {
  return allKeywords.filter((kw) => !GENERIC_TERMS.has(kw));
}

/**
 * Determines if a finding is an absence claim.
 */
function isAbsenceClaim(f: MergedFinding): boolean {
  if (f.gap_type === "memo_omission") return true;
  const textToCheck = `${f.title ?? ""} ${f.detail ?? ""}`;
  return ABSENCE_CLAIM_PATTERN.test(textToCheck);
}

/**
 * Code-enforced absence verification gate.
 *
 * For each absence-claim finding in a CHECKLIST_MODULES run, verifies via
 * full-text search whether the claimed-absent topic is actually present in
 * IC-memo document chunks. If the memo DOES disclose the topic (meeting
 * confidence thresholds), the finding is demoted to housekeeping.
 *
 * @param queryFn - DB query function (injectable for testing)
 * @param dealId  - Deal to search
 * @param findings - Principal findings array (mutated in place for `absence_verification`)
 * @param housekeepingFindings - Housekeeping array (demoted findings appended here)
 * @param moduleId - Module type; gate only fires for CHECKLIST_MODULES
 * @returns Count of demoted findings
 */
export async function verifyAbsenceClaims(
  queryFn: AbsenceGateQueryFn,
  dealId: string,
  findings: MergedFinding[],
  housekeepingFindings: MergedFinding[],
  moduleId: string,
): Promise<{ survivingFindings: MergedFinding[]; housekeepingFindings: MergedFinding[]; demotedCount: number }> {
  // Only run for checklist modules
  if (!CHECKLIST_MODULES.has(moduleId)) {
    return { survivingFindings: findings, housekeepingFindings, demotedCount: 0 };
  }

  let demotedCount = 0;
  const survivingFindings: MergedFinding[] = [];

  for (const f of findings) {
    if (!isAbsenceClaim(f)) {
      // Non-absence findings pass through completely untouched
      survivingFindings.push(f);
      continue;
    }

    // Extract salient keywords from title, then filter to DISTINCTIVE terms only
    const allKeywords = extractSalientKeywords(f.title ?? "");
    const keywords = extractDistinctiveKeywords(allKeywords);
    if (keywords.length === 0) {
      // No distinctive keywords survive — cannot verify, RETAIN the finding
      // (bias: when in doubt, keep rather than risk suppressing a true omission)
      (f as any).absence_verification = "memo_absent_confirmed";
      survivingFindings.push(f);
      console.log(`[pipeline:absenceGate] RETAINED "${(f.title ?? "").slice(0, 80)}" — no distinctive keywords after filtering generic terms (all: ${allKeywords.join(", ")})`);
      continue;
    }

    // Build an AND-based websearch_to_tsquery query from distinctive keywords.
    // websearch_to_tsquery treats unquoted space-separated terms as AND.
    // To be explicit, join with " AND " for clarity and safety.
    const searchQuery = keywords.join(" AND ");

    // Search document_chunks for this deal
    let memoHit = false;
    let matchingMemoFiles: string[] = [];
    let matchingKeywordsForSearch = keywords;

    try {
      const hits = await queryFn(
        `SELECT dc.file_name, dc.chunk_index, dc.content
         FROM document_chunks dc,
              websearch_to_tsquery('english', $2) q
         WHERE dc.deal_id = $1
           AND dc.tsv @@ q
         ORDER BY ts_rank_cd(dc.tsv, q) DESC
         LIMIT 50`,
        AbsenceGateChunkSchema,
        [dealId, searchQuery],
        { label: `[absenceGate] verify: "${(f.title ?? "").slice(0, 60)}"` }
      );

      // Filter to IC-memo chunks only
      const memoChunks = hits.filter((h) => IC_MEMO_FILE_PATTERN.test(h.file_name));

      if (memoChunks.length >= ABSENCE_GATE_MIN_MEMO_CHUNKS) {
        // Threshold A: >= 2 distinct memo chunks match the AND query
        // The AND query already ensures all distinctive keywords co-occur,
        // so matching chunks ARE genuine topic disclosures.
        memoHit = true;
        matchingMemoFiles = [...new Set(memoChunks.map((h) => h.file_name))];
      } else if (memoChunks.length === 1) {
        // Threshold B: single chunk must match >= 2 DISTINCTIVE keywords
        const chunkContent = memoChunks[0].content.toLowerCase();
        const matchedDistinctive = keywords.filter((kw) => chunkContent.includes(kw));
        if (matchedDistinctive.length >= ABSENCE_GATE_MIN_KEYWORDS_PER_CHUNK) {
          memoHit = true;
          matchingMemoFiles = [memoChunks[0].file_name];
          matchingKeywordsForSearch = matchedDistinctive;
        }
      }
    } catch (err) {
      // On query error, leave finding in place
      console.warn(`[pipeline:absenceGate] Query error for "${(f.title ?? "").slice(0, 60)}":`, err);
      survivingFindings.push(f);
      continue;
    }

    if (memoHit) {
      // Memo DOES disclose the topic — demote the false-absence finding
      demotedCount++;
      (f as any).absence_verification = "contradicted_by_memo";
      housekeepingFindings.push({
        ...f,
        severity: "info",
        category: "housekeeping",
        absence_verification: "contradicted_by_memo" as any,
        materiality_rationale: `[CODE_ENFORCED:absenceGate] Topic disclosed in IC memo(s): ${matchingMemoFiles.join(", ")}. Keywords matched: ${matchingKeywordsForSearch.join(", ")}. Claim contradicted by evidence.`,
      });
      console.log(`[pipeline:absenceGate] DEMOTED "${(f.title ?? "").slice(0, 80)}" — disclosed in ${matchingMemoFiles.join(", ")} via ${matchingKeywordsForSearch.join(", ")}`);
    } else {
      // Topic genuinely not found in memo chunks — retain
      (f as any).absence_verification = "memo_absent_confirmed";
      survivingFindings.push(f);
    }
  }

  if (demotedCount > 0) {
    console.log(`[pipeline:absenceGate] Total demoted: ${demotedCount} false-absence finding(s)`);
  }

  return { survivingFindings, housekeepingFindings, demotedCount };
}

// ---------------------------------------------------------------------------
// Engagement Map Absence Gate (EM-3)
// Replaces the keyword-based verifyAbsenceClaims. Uses LLM-powered engagement
// map + per-finding Sonnet matching for precise dispositions.
// ---------------------------------------------------------------------------

interface EngagementGateResult {
  survivingFindings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  demotedCount: number;
  flaggedCount: number;
  thesisDriftCount: number;
  unprocessedCount: number;
}

export async function applyEngagementAbsenceGate(
  queryFn: AbsenceGateQueryFn,
  aiFn: (req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>,
  dealId: string,
  findings: MergedFinding[],
  housekeepingFindings: MergedFinding[],
  moduleId: string,
): Promise<EngagementGateResult> {
  // Only run for checklist modules
  if (!CHECKLIST_MODULES.has(moduleId)) {
    return { survivingFindings: findings, housekeepingFindings, demotedCount: 0, flaggedCount: 0, thesisDriftCount: 0, unprocessedCount: 0 };
  }

  console.log(`[engagementGate] Starting for module=${moduleId}, deal=${dealId}, findings=${findings.length}`);

  // --- Step 1: Build engagement map ---
  const GATE_DEADLINE_MS = 180_000; // Allow up to 180s for the entire gate
  const gateStart = Date.now();
  const mapDeadline = gateStart + 120_000; // Allow 120s for map build

  let engagementMap: EngagementMapResult;
  try {
    engagementMap = await buildEngagementMap(queryFn, aiFn, dealId, mapDeadline);
  } catch (err: any) {
    console.warn(`[engagementGate] Map build FAILED: ${err?.message} — retaining all findings (no demotion)`);
    return { survivingFindings: findings, housekeepingFindings, demotedCount: 0, flaggedCount: 0, thesisDriftCount: 0, unprocessedCount: 0 };
  }

  if (!engagementMap.memos || engagementMap.memos.length === 0) {
    console.warn(`[engagementGate] No memos found — retaining all findings (no demotion)`);
    return { survivingFindings: findings, housekeepingFindings, demotedCount: 0, flaggedCount: 0, thesisDriftCount: 0, unprocessedCount: 0 };
  }

  // --- Step 2: Run matcher against all findings ---
  const matcherDeadline = gateStart + GATE_DEADLINE_MS;
  const findingsInput: FindingInput[] = findings.map(f => ({
    finding_id: f.finding_id ?? "",
    title: f.title ?? "",
    detail: f.detail ?? "",
    gap_type: (f as any).gap_type,
    finding_kind: f.finding_kind,
  }));

  let matchResult: MatcherOutput;
  try {
    matchResult = await matchAbsenceFindings(
      findingsInput, engagementMap, aiFn, dealId, "gate", matcherDeadline
    );
  } catch (err: any) {
    console.warn(`[engagementGate] Matcher FAILED: ${err?.message} — retaining all findings (no demotion)`);
    return { survivingFindings: findings, housekeepingFindings, demotedCount: 0, flaggedCount: 0, thesisDriftCount: 0, unprocessedCount: 0 };
  }

  // --- Step 3: Apply dispositions ---
  const survivingFindings: MergedFinding[] = [];
  let demotedCount = 0;
  let flaggedCount = 0;
  let thesisDriftCount = 0;
  let unprocessedCount = matchResult.partial ? (findings.length - matchResult.results.length) : 0;

  // Build lookup by finding_id
  const dispositionMap = new Map<string, typeof matchResult.results[number]>();
  for (const r of matchResult.results) {
    if (r.finding_id) dispositionMap.set(r.finding_id, r);
  }

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const fId = f.finding_id ?? "";
    const result = dispositionMap.get(fId);

    if (!result || result.disposition === "not_applicable") {
      // Non-absence finding — pass through
      survivingFindings.push(f);
      continue;
    }

    switch (result.disposition) {
      case "demote": {
        demotedCount++;
        const memoList = (result.matched_memos ?? []).join(", ");
        housekeepingFindings.push({
          ...f,
          severity: "info",
          category: "housekeeping",
          absence_verification: "contradicted_by_memo" as any,
          materiality_rationale: `[CODE_ENFORCED:engagementGate] disclosed in memo(s) ${memoList} — topic ${result.matched_topic ?? "unknown"}. ${result.reason ?? ""}`,
        });
        console.log(`[engagementGate] DEMOTED "${(f.title ?? "").slice(0, 80)}" — memos=[${memoList}], topic="${result.matched_topic}"`);
        break;
      }

      case "surface_thesis_drift": {
        thesisDriftCount++;
        const earlierMemos = (result.matched_memos ?? []).join(", ");
        (f as any).absence_verification = "thesis_drift";
        f.detail = (f.detail ?? "") + `\n\n[engagementGate:thesis_drift] Topic engaged in memo(s) ${earlierMemos}, absent from latest memo ${matchResult.latest_full_memo_order} — verify whether resolved or dropped.`;
        survivingFindings.push(f);
        break;
      }

      case "surface_omission": {
        (f as any).absence_verification = "memo_absent_confirmed";
        survivingFindings.push(f);
        break;
      }

      case "flag":
      default: {
        flaggedCount++;
        (f as any).absence_verification = "memo_disclosure_uncertain";
        f.detail = (f.detail ?? "") + `\n\n[engagementGate:uncertain] Memo may address this topic — verify. ${result.reason ?? ""}`;
        survivingFindings.push(f);
        break;
      }
    }
  }

  // Handle any unprocessed findings (partial timeout) — treat as flag/retain
  if (matchResult.partial && findings.length > matchResult.results.length) {
    // The findings beyond what was processed are already in survivingFindings
    // because the dispositionMap won't have entries for them and they pass through.
    // But we need to mark absence claims among them as flagged.
    const processedIds = new Set(matchResult.results.map(r => r.finding_id));
    for (const f of survivingFindings) {
      const fId = f.finding_id ?? "";
      if (!processedIds.has(fId) && !(f as any).absence_verification) {
        // Check if this is an absence claim that wasn't processed
        const textCheck = `${f.title ?? ""} ${f.detail ?? ""}`;
        const isAbsence = (f as any).gap_type === "memo_omission" ||
          /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i.test(textCheck);
        if (isAbsence) {
          (f as any).absence_verification = "memo_disclosure_uncertain";
          f.detail = (f.detail ?? "") + `\n\n[engagementGate:unprocessed] Time budget exhausted — retained for manual review.`;
          unprocessedCount++;
          flaggedCount++;
        }
      }
    }
  }

  console.log(`[engagementGate] demoted ${demotedCount}, thesis_drift ${thesisDriftCount}, surfaced_omission ${findings.length - demotedCount - flaggedCount - thesisDriftCount - unprocessedCount}, flagged ${flaggedCount}, unprocessed ${unprocessedCount} (retained)`);

  return { survivingFindings, housekeepingFindings, demotedCount, flaggedCount, thesisDriftCount, unprocessedCount };
}

export function appendReconciliationFindings(
  finalFindings: MergedFinding[],
  housekeepingFindings: MergedFinding[],
  claimsReconciliation: ReconciliationResult | null,
): AppendReconResult {
  const diagnostics: ReconReplacementDiagnostic[] = [];

  if (!claimsReconciliation || claimsReconciliation.findings.length === 0) {
    return { finalFindings, housekeepingFindings, diagnostics };
  }

  // --- Build existing finding ID index for idempotency and ID-scoped removal ---
  const existingById = new Map<string, MergedFinding>();
  for (const f of finalFindings) {
    if (f.finding_id) existingById.set(f.finding_id, f);
  }

  // --- Process principal reconciliation findings (data_divergence, cross_version) ---
  const principalReconFindings = claimsReconciliation.findings
    .filter(rf => rf.finding_kind === "data_divergence" || rf.finding_kind === "cross_version");

  for (const rf of principalReconFindings) {
    const supersedes = rf.supersedes_finding_ids ?? [];
    const removedIds: string[] = [];
    const unknownIds: string[] = [];

    // Fix 11: ID-scoped removal — remove ONLY findings whose exact ID is in supersedes
    if (supersedes.length > 0) {
      for (const targetId of supersedes) {
        if (existingById.has(targetId)) {
          removedIds.push(targetId);
        } else {
          unknownIds.push(targetId);
        }
      }

      if (unknownIds.length > 0) {
        // Unknown target IDs: preserve ALL existing findings, emit diagnostic, do NOT fall back
        diagnostics.push({
          type: "unknown_target_id",
          finding_id: rf.title, // will be replaced with actual UUID below
          message: `Reconciliation finding "${rf.title}" references ${unknownIds.length} unknown target ID(s). No findings removed.`,
          target_ids: supersedes,
          unknown_ids: unknownIds,
        });
        // Preserve all — no removal when any target is unknown
        removedIds.length = 0;
      }

      // Remove the explicitly identified findings
      if (removedIds.length > 0) {
        const removeSet = new Set(removedIds);
        finalFindings = finalFindings.filter(f => !removeSet.has(f.finding_id));
        for (const id of removedIds) existingById.delete(id);
      }
    }

    // Build the replacement finding
    const replacementFinding: MergedFinding = {
      finding_id: "", // ensureFindingIds will assign a stable UUID
      title: rf.title,
      severity: rf.severity,
      detail: rf.detail,
      full_analysis: rf.full_analysis,
      source_docs: rf.source_docs,
      category: "principal_finding" as const,
      numeric_unverified: false,
      finding_kind: rf.finding_kind as MergedFinding["finding_kind"],
      severity_anchor: rf.severity_anchor != null
        ? (rf.severity_anchor >= 1_000_000 ? `£${(rf.severity_anchor / 1_000_000).toFixed(1)}m` : `£${(rf.severity_anchor / 1_000).toFixed(0)}k`)
        : undefined,
      // Fix 11: Record exactly which IDs were actually superseded
      merged_from_finding_ids: removedIds.length > 0 ? removedIds : undefined,
    };

    // Assign stable ID
    const [withId] = ensureFindingIds([replacementFinding]);

    // Idempotency: if this exact finding is already present (by title dedup), skip append
    const titleKey = (withId.title || "").toLowerCase().trim().replace(/\s+/g, " ");
    const alreadyPresent = finalFindings.some(f =>
      f.finding_id === withId.finding_id ||
      (f.title || "").toLowerCase().trim().replace(/\s+/g, " ") === titleKey
    );

    if (alreadyPresent) {
      diagnostics.push({
        type: "idempotent_skip",
        finding_id: withId.finding_id,
        message: `Reconciliation finding "${rf.title}" already present — skipped (idempotent).`,
      });
    } else {
      finalFindings.push(withId);
      existingById.set(withId.finding_id, withId);

      if (removedIds.length > 0) {
        diagnostics.push({
          type: "replacement_applied",
          finding_id: withId.finding_id,
          message: `Replaced ${removedIds.length} finding(s) with code-verified "${rf.title}".`,
          target_ids: supersedes,
          removed_ids: removedIds,
        });
      }
    }
  }

  console.log(`[pipeline] Reconciliation: ${principalReconFindings.length} code-verified finding(s) processed (ID-scoped)`);
  if (diagnostics.length > 0) {
    console.log(`[pipeline] Reconciliation diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  // --- Append reconciliation housekeeping (scope_mismatch, unreconcilable) ---
  const reconHousekeeping: MergedFinding[] = ensureFindingIds(claimsReconciliation.findings
    .filter(rf => rf.finding_kind === "scope_mismatch" || rf.finding_kind === "unreconcilable")
    .map(rf => ({
      finding_id: "",
      title: rf.title,
      severity: rf.severity,
      detail: rf.detail,
      full_analysis: rf.full_analysis,
      source_docs: rf.source_docs,
      category: "housekeeping" as const,
      numeric_unverified: false,
      finding_kind: rf.finding_kind as MergedFinding["finding_kind"],
      severity_anchor: rf.severity_anchor != null
        ? (rf.severity_anchor >= 1_000_000 ? `£${(rf.severity_anchor / 1_000_000).toFixed(1)}m` : `£${(rf.severity_anchor / 1_000).toFixed(0)}k`)
        : undefined,
    })));

  if (reconHousekeeping.length > 0) {
    housekeepingFindings = [...housekeepingFindings, ...reconHousekeeping];
    const seen = new Set<string>();
    housekeepingFindings = housekeepingFindings.filter(f => {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[pipeline] Appended ${reconHousekeeping.length} reconciliation housekeeping finding(s)`);
  }

  return { finalFindings, housekeepingFindings, diagnostics };
}

// ---------------------------------------------------------------------------
// Shared post-merge pipeline: runs identically in main-path and fast-path.
// Order: suppression → Layer-1 numeric validation → consolidation →
//        reconciliation append → absence gate → independent override → materiality gate.
// ---------------------------------------------------------------------------
interface PostMergePipelineInput {
  findings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  numericReport: { figures: any[]; discrepancies: any[] } | null;
  claimsReconciliation: ReconciliationResult | null;
  fileTagMap: Map<string, string>;
  moduleId: string;
  /** DB query function — required for absence gate (optional for backward compat) */
  queryFn?: AbsenceGateQueryFn;
  /** Deal ID — required for absence gate */
  dealId?: string;
  /** AI function — required for engagement absence gate */
  aiFn?: (req: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>;
}

interface PostMergePipelineResult {
  findings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
}

async function runPostMergePipeline(input: PostMergePipelineInput): Promise<PostMergePipelineResult> {
  let { findings, housekeepingFindings } = input;
  const { numericReport, claimsReconciliation, fileTagMap, moduleId, queryFn, dealId, aiFn } = input;

  // === Stage 1: FABRICATED_ARITHMETIC suppression (Fix 19 closure: context-guarded) ===
  const { shouldSuppressArithmeticFinding } = await import("./fabricated-arithmetic-patterns.js");
  const preSuppressCount = findings.length;
  findings = findings.filter(f => !shouldSuppressArithmeticFinding(f));
  const suppressedCount = preSuppressCount - findings.length;
  if (suppressedCount > 0) {
    console.log(`[pipeline:postMerge] Suppressed ${suppressedCount} fabricated arithmetic finding(s)`);
  }

  // === Stage 2: Layer-1 Numeric Divergence Diagnostics (Fix 22/24 closure) ===
  // DEMOTED to diagnostics-only: this stage may FLAG findings with a diagnostic marker
  // but must NOT approve citations, alter severity, or change category.
  // The cited-value resolver (Stage 2.5) is the sole numeric verification authority.
  if (numericReport && numericReport.figures.length > 0) {
    const verifiedFigureLookup = new Map<string, string>();
    for (const fig of numericReport.figures as Array<Record<string, unknown>>) {
      const name = String(fig.name ?? "").toLowerCase().trim();
      const period = String(fig.period ?? "").toLowerCase().trim();
      if (name && period) {
        verifiedFigureLookup.set(`${name}|||${period}`, String(fig.value ?? ""));
      }
    }

    const normalizeNumericForLookup = (val: unknown): string | null => {
      if (val == null) return null;
      const s = String(val).replace(/[$£€%,\s]/g, "").trim();
      return s.length > 0 ? s : null;
    };

    const extractNumericFigures = (text: string): string[] => {
      const patterns = text.match(/[$£€]?\d[\d,]*\.?\d*[MmBbKk%]?/g);
      return patterns ? [...new Set(patterns)] : [];
    };

    let numDivDiagnosticCount = 0;
    findings = findings.map(f => {
      if (f.finding_kind !== "data_divergence") return f;
      if (f.numeric_unverified === false) return f;

      let citedFigures: Array<{ value: string; source_doc?: string; metric?: string; period?: string }> = [];
      if (f.evidence && f.evidence.length > 0) {
        citedFigures = f.evidence.map(e => ({
          value: e.figure,
          source_doc: e.source_doc,
          metric: (e as Record<string, unknown>).metric as string | undefined,
          period: (e as Record<string, unknown>).period as string | undefined,
        }));
      } else {
        const allText = `${f.title} ${f.detail}`;
        citedFigures = extractNumericFigures(allText).map(v => ({ value: v }));
      }

      if (citedFigures.length === 0) return f;

      let resolvedCount = 0;
      let unresolvedCount = 0;

      for (const cited of citedFigures) {
        let matched = false;

        if (cited.metric && cited.period) {
          const coordKey = `${cited.metric.toLowerCase().trim()}|||${cited.period.toLowerCase().trim()}`;
          if (verifiedFigureLookup.has(coordKey)) {
            matched = true;
            resolvedCount++;
          }
          if (!matched) { unresolvedCount++; }
          continue;
        }

        const normalizedCited = normalizeNumericForLookup(cited.value);
        if (!normalizedCited) { unresolvedCount++; continue; }

        for (const [, verifiedValue] of verifiedFigureLookup.entries()) {
          const normalizedVerified = normalizeNumericForLookup(verifiedValue);
          if (!normalizedVerified) continue;

          if (normalizedCited === normalizedVerified ||
              normalizedCited.replace(/[MmBb]$/, "000000").replace(/[Kk]$/, "000") ===
              normalizedVerified.replace(/[MmBb]$/, "000000").replace(/[Kk]$/, "000")) {
            matched = true;
            resolvedCount++;
            break;
          }
        }
        if (!matched) unresolvedCount++;
      }

      // Fix 22/24 closure: DIAGNOSTIC ONLY — do not alter severity or category.
      // Attach a diagnostic marker for downstream auditing but leave the finding intact.
      if (resolvedCount === 0) {
        numDivDiagnosticCount++;
        return {
          ...f,
          _stage2_diagnostic: "unresolved_divergence" as const,
        };
      }

      return f;
    });

    if (numDivDiagnosticCount > 0) {
      console.log(`[pipeline:postMerge] Stage 2 diagnostic: ${numDivDiagnosticCount} finding(s) flagged (no authority change)`);
    }
  }

  // === Stage 2.5: Cited-Value Verification (Fix 6) ===
  // For ALL findings (not just data_divergence), verify cited £ values against
  // the verified figure set. Findings with high unresolved/mismatched ratios
  // get the numeric_unverified flag. This catches LLM hallucinations that cite
  // specific numbers not traceable to source documents.
  if (numericReport && numericReport.figures.length > 0) {
    const { resolveCitedValues, applyVerificationToFindings, formatVerificationDiagnostic } = await import("./cited-value-resolver.js");
    const verificationResults = resolveCitedValues(findings, numericReport.figures);
    findings = applyVerificationToFindings(findings, verificationResults);
    const diagnostic = formatVerificationDiagnostic(verificationResults);
    console.log(`[pipeline:postMerge] ${diagnostic}`);
  }

  // === Stage 3: Global Semantic Consolidation (Defect 1) ===
  // OA-03: For omission_audit, delegate to canonical family dedup service
  // Preserves the full family artifact for downstream promotion
  let familyDedupArtifact: ReturnType<typeof deduplicateFindings> | null = null;
  if (moduleId === "omission_audit") {
    const preConsolidationCount = findings.length;
    familyDedupArtifact = deduplicateFindings(findings as any);
    // Keep only retained findings (representatives + ungrouped)
    const retainedIds = new Set<string>([
      ...familyDedupArtifact.ungroupedFindingIds,
      ...familyDedupArtifact.families.map(f => f.representativeFindingId),
    ]);
    findings = findings.filter(f => retainedIds.has(f.finding_id));
    const consolidatedCount = preConsolidationCount - findings.length;
    if (consolidatedCount > 0) {
      console.log(`[pipeline:postMerge][OA-03] Canonical family dedup: ${preConsolidationCount} → ${findings.length} findings (collapsed ${consolidatedCount}, families=${familyDedupArtifact.totalFamiliesCreated})`);
    }
    // Attach family artifact to findings array for downstream preservation
    (findings as any).__familyDedupArtifact = familyDedupArtifact;
  } else
  {
    const preConsolidationCount = findings.length;

    const parent: number[] = findings.map((_, i) => i);
    function find(x: number): number {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a: number, b: number): void {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    // Fix 17 + Corrective F: Compatibility gate — two findings may only merge when
    // they share a claim_id or issue_key AND have no material conflict in structured
    // identity fields. Corrective F extends this to derive identity from evidence[]
    // and structured_impact[] arrays when top-level fields are absent.

    /**
     * Extract deterministic identity from evidence and structured_impact arrays.
     * Returns a map of identity dimension → Set of canonical values.
     * Absence of a dimension returns an empty set (neutral — not blocking).
     */
    function extractStructuredIdentity(finding: any): Map<string, Set<string>> {
      const identity = new Map<string, Set<string>>();

      const addValue = (key: string, value: string | undefined | null) => {
        if (!value || typeof value !== "string") return;
        const normalized = value.toLowerCase().trim();
        if (!normalized) return;
        if (!identity.has(key)) identity.set(key, new Set());
        identity.get(key)!.add(normalized);
      };

      // Top-level fields (already checked by gate fields but also contributed to identity)
      addValue("metric", finding.metric);
      addValue("period", finding.period);
      addValue("scope", finding.scope);
      addValue("entity", finding.entity);
      addValue("currency", finding.currency);
      addValue("accounting_basis", finding.accounting_basis);
      addValue("actual_vs_forecast", finding.actual_vs_forecast);
      addValue("legal_clause", finding.legal_clause);
      addValue("legal_consequence", finding.legal_consequence);
      addValue("impact_type", finding.impact_type);
      addValue("contract_provision", finding.contract_provision);

      // Evidence array: extract metric, period, scope, sheet, cell, unit, currency, accounting_basis
      const evidence = finding.evidence;
      if (Array.isArray(evidence)) {
        for (const ev of evidence) {
          if (!ev || typeof ev !== "object") continue;
          addValue("metric", ev.metric);
          addValue("period", ev.period);
          addValue("scope", ev.scope);
          addValue("entity", ev.entity);
          addValue("currency", ev.currency);
          addValue("accounting_basis", ev.accounting_basis);
          addValue("actual_vs_forecast", ev.actual_or_forecast);
          addValue("sheet_or_page", ev.sheet_or_page);
          addValue("cell_coordinate", ev.cell_coordinate);
          addValue("source_doc", ev.source_doc);
          addValue("unit", ev.unit);
        }
      }

      // Structured impact array: extract type, currency, source coordinates
      const impacts = finding.structured_impact;
      if (Array.isArray(impacts)) {
        for (const imp of impacts) {
          if (!imp || typeof imp !== "object") continue;
          addValue("impact_type", imp.role);
          addValue("currency", imp.currency);
          addValue("source_doc", imp.source_doc);
          addValue("source_coordinate", imp.source_coordinate);
        }
      }

      // Finding kind is always top-level
      addValue("finding_kind", finding.finding_kind);

      return identity;
    }

    /**
     * Corrective F: Check if two structured identities are compatible.
     *
     * Rules:
     * - If BOTH identities have values for a dimension and those value-sets
     *   have NO overlap, they conflict → incompatible.
     * - If only ONE identity has values for a dimension (asymmetric), and
     *   the other finding has NO structured identity for that dimension at all,
     *   that finding's absence is NOT proof of compatibility when the populated
     *   identity has discriminating content. This prevents bridge merges.
     * - Absence on BOTH sides is neutral (compatible).
     */
    function identitiesAreCompatible(idA: Map<string, Set<string>>, idB: Map<string, Set<string>>): boolean {
      // Check all dimensions present in either identity
      const allDims = new Set([...idA.keys(), ...idB.keys()]);

      // Discriminating dimensions — fields that carry enough specificity to block merge
      const discriminatingDims = new Set([
        "metric", "period", "scope", "entity", "sheet_or_page",
        "cell_coordinate", "legal_clause", "legal_consequence",
        "contract_provision", "accounting_basis", "actual_vs_forecast",
      ]);

      for (const dim of allDims) {
        const setA = idA.get(dim);
        const setB = idB.get(dim);

        // Both absent → neutral
        if ((!setA || setA.size === 0) && (!setB || setB.size === 0)) continue;

        // Both present → check overlap
        if (setA && setA.size > 0 && setB && setB.size > 0) {
          // If there's ANY overlap, they're compatible on this dimension
          let hasOverlap = false;
          for (const v of setA) {
            if (setB.has(v)) { hasOverlap = true; break; }
          }
          if (!hasOverlap) return false; // Material conflict
          continue;
        }

        // Asymmetric: one has values, the other doesn't.
        // For discriminating dimensions, asymmetry with a populated identity
        // on one side is NOT compatible — prevents bridge merges where one
        // finding has specific coordinates and the other is generic.
        if (discriminatingDims.has(dim)) {
          const populatedSet = setA && setA.size > 0 ? setA : setB;
          // Only block if the populated set has genuinely discriminating content
          // (not a single generic value that everything would match)
          if (populatedSet && populatedSet.size > 0) {
            return false;
          }
        }
        // Non-discriminating dimensions (finding_kind, currency, unit, source_doc, etc.)
        // remain neutral on asymmetry
      }

      return true;
    }

    /** Consolidation incompatibility diagnostics (Corrective F) */
    const consolidationDiagnostics: Array<{
      claim_id_or_issue_key: string;
      finding_a_title: string;
      finding_b_title: string;
      reason: string;
    }> = [];

    function areCompatibleForMerge(idxA: number, idxB: number): boolean {
      const a = findings[idxA] as any;
      const b = findings[idxB] as any;

      // Gate 1: Original top-level gate fields (Fix 17)
      const gateFields: Array<{ key: string; normalize?: (v: string) => string }> = [
        { key: "finding_kind" },
        { key: "metric", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "period", normalize: (v: string) => v.toLowerCase().trim().replace(/\s+/g, "") },
        { key: "scope", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "entity", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "currency" },
        { key: "legal_clause", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "legal_consequence", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "impact_type", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "affected_asset", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "accounting_basis", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "actual_vs_forecast", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "counterparty", normalize: (v: string) => v.toLowerCase().trim() },
        { key: "contract_provision", normalize: (v: string) => v.toLowerCase().trim() },
      ];

      for (const { key, normalize } of gateFields) {
        const valA = a[key];
        const valB = b[key];
        // Only check if BOTH have a truthy value for this field
        if (!valA || !valB) continue;
        if (typeof valA !== "string" || typeof valB !== "string") continue;
        const normA = normalize ? normalize(valA) : valA;
        const normB = normalize ? normalize(valB) : valB;
        if (normA !== normB) return false; // Material conflict → incompatible
      }

      // Gate 2 (Corrective F): Derive identity from evidence/structured_impact
      // and check for structural incompatibility even when top-level fields are absent.
      const idA = extractStructuredIdentity(a);
      const idB = extractStructuredIdentity(b);

      if (!identitiesAreCompatible(idA, idB)) {
        return false;
      }

      return true; // No material conflicts → compatible
    }

    const claimToIndices = new Map<string, number[]>();
    for (let i = 0; i < findings.length; i++) {
      const cids = findings[i].claim_ids ?? [];
      for (const cid of cids) {
        const normalized = cid.toLowerCase().trim();
        if (!normalized) continue;
        const existing = claimToIndices.get(normalized);
        if (existing) { existing.push(i); } else { claimToIndices.set(normalized, [i]); }
      }
    }

    // Corrective F: Helper to check compatibility against all members of a cluster.
    // Prevents transitive bridge merges where A-B and B-C are compatible but A-C conflict.
    function isCompatibleWithEntireCluster(candidateIdx: number, clusterRoot: number): boolean {
      // Find all members currently in this cluster
      for (let j = 0; j < findings.length; j++) {
        if (find(j) === clusterRoot) {
          if (!areCompatibleForMerge(candidateIdx, j)) {
            return false;
          }
        }
      }
      return true;
    }

    for (const [claimId, indices] of claimToIndices.entries()) {
      for (let k = 1; k < indices.length; k++) {
        // Corrective F: Validate against ALL existing cluster members (not just indices[0])
        const targetRoot = find(indices[0]);
        if (isCompatibleWithEntireCluster(indices[k], targetRoot)) {
          union(indices[0], indices[k]);
        } else {
          // Emit diagnostic: shared claim_id rejected due to structural incompatibility
          consolidationDiagnostics.push({
            claim_id_or_issue_key: `claim_id:${claimId}`,
            finding_a_title: (findings[indices[0]] as any).title ?? "unknown",
            finding_b_title: (findings[indices[k]] as any).title ?? "unknown",
            reason: "Shared claim_id rejected: structured identity conflict detected in evidence/structured_impact",
          });
        }
      }
    }

    const issueKeyToIndices = new Map<string, number[]>();
    for (let i = 0; i < findings.length; i++) {
      const ik = (findings[i] as any).issue_key;
      if (!ik || typeof ik !== "string") continue;
      const normalized = ik.toLowerCase().trim().replace(/[\s-]+/g, "_");
      if (!normalized) continue;
      const existing = issueKeyToIndices.get(normalized);
      if (existing) { existing.push(i); } else { issueKeyToIndices.set(normalized, [i]); }
    }
    for (const [issueKey, indices] of issueKeyToIndices.entries()) {
      for (let k = 1; k < indices.length; k++) {
        // Corrective F: Validate against ALL existing cluster members
        const targetRoot = find(indices[0]);
        if (isCompatibleWithEntireCluster(indices[k], targetRoot)) {
          union(indices[0], indices[k]);
        } else {
          // Emit diagnostic: shared issue_key rejected due to structural incompatibility
          consolidationDiagnostics.push({
            claim_id_or_issue_key: `issue_key:${issueKey}`,
            finding_a_title: (findings[indices[0]] as any).title ?? "unknown",
            finding_b_title: (findings[indices[k]] as any).title ?? "unknown",
            reason: "Shared issue_key rejected: structured identity conflict detected in evidence/structured_impact",
          });
        }
      }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < findings.length; i++) {
      const root = find(i);
      const existing = clusters.get(root);
      if (existing) { existing.push(i); } else { clusters.set(root, [i]); }
    }

    const severityRank = { critical: 3, warning: 2, info: 1 } as const;
    const consolidated: typeof findings = [];

    for (const members of clusters.values()) {
      if (members.length === 1) {
        consolidated.push(findings[members[0]]);
        continue;
      }

      members.sort((a, b) => {
        const sa = severityRank[findings[a].severity] ?? 0;
        const sb = severityRank[findings[b].severity] ?? 0;
        if (sb !== sa) return sb - sa;
        return (findings[b].full_analysis?.length ?? 0) - (findings[a].full_analysis?.length ?? 0);
      });

      const representative = findings[members[0]];

      const allClaimIds = new Set<string>();
      const allSourceDocs = new Set<string>();
      const allEvidenceDocs = new Set<string>();
      const allEvidence: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean }> = [];
      const seenEvidenceKeys = new Set<string>();

      // Fix 15: Union structured_impact across all cluster members
      const allStructuredImpact: Array<Record<string, unknown>> = [];
      const seenImpactKeys = new Set<string>();

      // RC3: Collect merged_from_finding_ids for provenance tracking
      const mergedFromIds: string[] = [];
      for (const idx of members) {
        const f = findings[idx] as any;
        if (f.finding_id && f.finding_id !== (representative as any).finding_id) {
          mergedFromIds.push(f.finding_id);
        }
        // Also inherit any pre-existing merged_from_finding_ids from consolidated members
        if (Array.isArray(f.merged_from_finding_ids)) {
          for (const id of f.merged_from_finding_ids) { mergedFromIds.push(id); }
        }
      }

      for (const idx of members) {
        const f = findings[idx];
        for (const cid of f.claim_ids ?? []) allClaimIds.add(cid);
        for (const sd of f.source_docs ?? []) allSourceDocs.add(sd);
        for (const ed of f.evidence_docs ?? []) allEvidenceDocs.add(ed);
        for (const ev of f.evidence ?? []) {
          // Fix 15: Use figure|source_doc|verbatim_snippet as dedup key to preserve
          // coordinate-rich evidence items that share the same figure+source but have
          // different snippets/coordinates (common in multi-page documents)
          const key = `${ev.figure}|${ev.source_doc}|${(ev.verbatim_snippet ?? "").slice(0, 80)}`;
          if (!seenEvidenceKeys.has(key)) {
            seenEvidenceKeys.add(key);
            allEvidence.push(ev);
          }
        }
        // Fix 15: Collect structured_impact entries from all members
        const fAny = f as any;
        if (Array.isArray(fAny.structured_impact)) {
          for (const si of fAny.structured_impact) {
            // Dedup by amount+role+currency to prevent exact duplicates
            const siKey = `${si.amount ?? ""}|${si.role ?? ""}|${si.currency ?? ""}`;
            if (!seenImpactKeys.has(siKey)) {
              seenImpactKeys.add(siKey);
              allStructuredImpact.push(si);
            }
          }
        }
      }

      // Fix 15: Build consolidated_analyses from non-representative members
      // This preserves the full_analysis content from absorbed findings for audit trail
      const consolidatedAnalyses: string[] = [];
      for (const idx of members) {
        if (idx === members[0]) continue; // skip representative
        const f = findings[idx];
        if (f.full_analysis && f.full_analysis.length > 0) {
          consolidatedAnalyses.push(f.full_analysis);
        }
      }

      const merged: typeof representative = {
        ...representative,
        severity: representative.severity,
        claim_ids: [...allClaimIds],
        source_docs: [...allSourceDocs],
        evidence_docs: allEvidenceDocs.size > 0 ? [...allEvidenceDocs] : representative.evidence_docs,
        evidence: allEvidence.length > 0 ? allEvidence : representative.evidence,
        // Fix 15: Union structured_impact from all members
        structured_impact: allStructuredImpact.length > 0 ? allStructuredImpact as any : (representative as any).structured_impact,
        // Fix 15: Preserve non-representative analyses for audit trail
        ...(consolidatedAnalyses.length > 0 ? { consolidated_analyses: consolidatedAnalyses } : {}),
        // RC3: Track which findings were consolidated into this one
        merged_from_finding_ids: mergedFromIds.length > 0
          ? [...new Set([...(representative.merged_from_finding_ids ?? []), ...mergedFromIds])]
          : representative.merged_from_finding_ids,
      };

      consolidated.push(merged);
    }

    findings = consolidated;
    const consolidatedCount = preConsolidationCount - findings.length;
    if (consolidatedCount > 0) {
      console.log(`[pipeline:postMerge] Global consolidation: ${preConsolidationCount} → ${findings.length} findings (collapsed ${consolidatedCount} duplicates)`);
    }
    // Corrective F: Log diagnostics when claim_id or issue_key sharing was rejected
    if (consolidationDiagnostics.length > 0) {
      console.log(`[pipeline:postMerge] Consolidation rejected ${consolidationDiagnostics.length} shared key(s) due to structured identity conflict`);
      for (const d of consolidationDiagnostics) {
        console.log(`  [rejected] ${d.claim_id_or_issue_key}: "${d.finding_a_title}" vs "${d.finding_b_title}" — ${d.reason}`);
      }
    }
  }

  // === Stage 3.5: Current-Run Supersession Proof (Corrective E2) ===
  // Build candidates from the CURRENT findings array so that supersedes_finding_ids
  // contains only IDs that exist in the current run. Prior-run IDs are never used
  // as deletion targets since finding IDs are not stable across independent runs.
  if (claimsReconciliation && claimsReconciliation.findings.length > 0) {
    let supersessionDiagnosticsCount = 0;

    // Build SupersessionCandidate[] from current findings using ALL evidence entries
    const currentCandidates: SupersessionCandidate[] = [];
    for (const f of findings) {
      if (!f.finding_id || !f.evidence || f.evidence.length === 0) continue;

      // Create one candidate per evidence entry × source_doc combination
      // This evaluates ALL coordinates, not just evidence[0]
      const sourceDocs = f.source_docs && f.source_docs.length > 0 ? f.source_docs : [""];
      for (const ev of f.evidence) {
        const metric = ev.metric ?? "";
        const scope = ev.scope ?? "";
        const period = ev.period ?? "";
        // Skip entries with no useful coordinate data
        if (!metric && !scope && !period) continue;
        for (const doc of sourceDocs) {
          currentCandidates.push({
            canonical_id: f.finding_id,
            claim_metric: metric,
            claim_scope: scope,
            claim_period: period,
            claim_source_doc: doc,
          });
        }
      }
    }

    if (currentCandidates.length > 0) {
      console.log(`[pipeline:postMerge:Supersession] Built ${currentCandidates.length} candidates from ${findings.length} current-run findings`);

      for (const rf of claimsReconciliation.findings) {
        // Only data_divergence and cross_version findings are eligible
        if (rf.finding_kind !== "data_divergence" && rf.finding_kind !== "cross_version") continue;

        // Skip findings without a claim (cross_version from discrepancies lack claims)
        if (!rf.claim) continue;

        // Filter candidates from same source doc — the validator applies strict coordinate gates
        const eligibleCandidates = currentCandidates.filter(c =>
          c.claim_source_doc === rf.claim.source_doc
        );

        if (eligibleCandidates.length === 0) continue;

        // Invoke deterministic proof validator
        const proofResult = validateSupersessionProof(
          { claim: rf.claim, finding_kind: rf.finding_kind },
          eligibleCandidates,
        );

        // Always attach diagnostic when candidates were considered
        if (proofResult.diagnostic) {
          rf._supersession_diagnostic = proofResult.diagnostic;
          supersessionDiagnosticsCount++;
        }

        // Populate supersedes_finding_ids ONLY when proof is entirely proven
        if (proofResult.proven_ids.length > 0 && proofResult.ambiguous_ids.length === 0) {
          rf.supersedes_finding_ids = proofResult.proven_ids;
          console.log(
            `[pipeline:postMerge:Supersession] Finding "${rf.title}" PROVES supersession of ${proofResult.proven_ids.length} current finding(s): [${proofResult.proven_ids.join(", ")}]`
          );
        } else if (proofResult.ambiguous_ids.length > 0) {
          // Append-only: no supersession IDs assigned — fail-closed on ambiguity
          console.log(
            `[pipeline:postMerge:Supersession] Finding "${rf.title}" has AMBIGUOUS candidates (${proofResult.ambiguous_ids.length}) — append-only`
          );
        }
      }

      console.log(`[pipeline:postMerge:Supersession] Complete: ${supersessionDiagnosticsCount} diagnostic(s) emitted`);
    }
  }

  // === Stage 4: Reconciliation Append ===
  const reconResult = appendReconciliationFindings(findings, housekeepingFindings, claimsReconciliation);
  findings = reconResult.finalFindings;
  housekeepingFindings = reconResult.housekeepingFindings;

  // === Stage 4.5: Engagement Map Absence Gate (EM-3, replaces FP-1 keyword gate) ===
  // LLM-verified gate: builds per-memo engagement map, matches each absence-claim finding
  // against it via Sonnet, and demotes/annotates based on disposition.
  if (queryFn && dealId && aiFn) {
    const gateResult = await applyEngagementAbsenceGate(queryFn, aiFn, dealId, findings, housekeepingFindings, moduleId);
    findings = gateResult.survivingFindings;
    housekeepingFindings = gateResult.housekeepingFindings;
  }

  // === Stage 5: Deterministic independent override ===
  let independentOverrides = 0;
  for (const f of findings) {
    if (f.evidence_docs && f.evidence_docs.length > 0) {
      const hasNonIcMemo = f.evidence_docs.some((docName) => {
        const tag = fileTagMap.get(docName.toLowerCase());
        return tag !== "ic_memo";
      });
      const oldValue = f.independent;
      f.independent = hasNonIcMemo;
      if (oldValue !== hasNonIcMemo) independentOverrides++;
    }
  }
  if (independentOverrides > 0) {
    console.log(`[pipeline:postMerge] Deterministic independent override: corrected ${independentOverrides} finding(s)`);
  }

  // === Stage 6: Materiality Gate (Defect 2) ===
  const matResult = enforceMaterialityGate(findings, housekeepingFindings);
  findings = matResult.findings;
  housekeepingFindings = matResult.housekeepingFindings;

  // === Stage 7: RC5 Defense-in-depth correctness sweep ===
  // Final pass ensures no correctness rule was bypassed by intermediate stages.
  const ABSENCE_PATTERNS_FINAL = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;
  let rc5Caps = 0;
  for (const f of findings) {
    // Rule 1: numeric_unverified → severity ≤ info
    if (f.numeric_unverified === true && f.severity !== "info") {
      (f as any).severity = "info";
      rc5Caps++;
    }
    // Rule 2: absence without verified_absent → severity ≤ info
    const isAbsence =
      f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged" ||
      ABSENCE_PATTERNS_FINAL.test(f.full_analysis || "") || ABSENCE_PATTERNS_FINAL.test(f.detail || "");
    if (isAbsence && (f as any).absence_confidence !== "verified_absent" && f.severity !== "info") {
      (f as any).severity = "info";
      rc5Caps++;
    }
  }
  if (rc5Caps > 0) {
    console.log(`[pipeline:postMerge:RC5] Defense-in-depth: capped ${rc5Caps} finding(s) that escaped earlier enforcement`);
  }

  return { findings, housekeepingFindings };
}

// ---------------------------------------------------------------------------
// Canonical Finalizer — single entry point for all completion paths.
// Order: 1. validate final merge → 2. arithmetic suppression → 3. numeric validation →
//        4. reconciliation → 5. consolidation → 6. materiality → 7. absence verification →
//        8. final validation → 9. formatting → 10. canonical persistence → 11. completion transition.
// Stages 1-6 are delegated to runPostMergePipeline. 7-11 are handled here.
// All paths (main, fast, background) MUST call this instead of ad-hoc sequencing.
// ---------------------------------------------------------------------------
interface CanonicalFinalizeInput {
  ctx: PipelineContext;
  runId: string;
  moduleId: string;
  dealId?: string;
  findings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  executiveHeader: string;
  numericReport: { figures: any[]; discrepancies: any[] } | null;
  claimsReconciliation: ReconciliationResult | null;
  fileTagMap: Map<string, string>;
  useOpus: boolean;
  startTime: number;
  verificationPhaseErrored?: boolean;
  mergeGroupsFallenBack?: number;
}

interface CanonicalFinalizeResult {
  findings: MergedFinding[];
  housekeepingFindings: MergedFinding[];
  fullReport: string | null;
  canonicalArtifact: {
    schema_version: number;
    findings: MergedFinding[];
    housekeepingFindings: MergedFinding[];
    executiveHeader: string;
    fullReport: string | null;
    completionStatus: "complete" | "partial_format_failed";
    timestamp: string;
  };
}

export async function runPostMergeFinalization(input: CanonicalFinalizeInput): Promise<CanonicalFinalizeResult> {
  const { ctx, runId, moduleId, executiveHeader, numericReport, claimsReconciliation, fileTagMap, useOpus, startTime } = input;
  const verificationPhaseErrored = input.verificationPhaseErrored ?? false;
  const mergeGroupsFallenBack = input.mergeGroupsFallenBack ?? 0;

  // Stages 1-6: Post-merge quality pipeline
  const postMerge = await runPostMergePipeline({
    findings: input.findings,
    housekeepingFindings: input.housekeepingFindings,
    numericReport,
    claimsReconciliation,
    fileTagMap,
    moduleId,
    queryFn: ctx.integrations.db.query.bind(ctx.integrations.db),
    dealId: input.dealId,
    aiFn: ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
  });
  let { findings, housekeepingFindings } = postMerge;

  // Stage 7: Absence verification (already applied during merge via the ABSENCE_PATTERNS code backstop)
  // The inline absence cap was applied per-finding during merge. Here we do a final sweep to ensure
  // no absence claim escaped the cap after consolidation/reconciliation may have changed severity.
  const ABSENCE_PATTERNS_FINALIZE = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;
  let absenceCaps = 0;
  for (const f of findings) {
    const isDataDivergence = f.finding_kind === "data_divergence";
    if (isDataDivergence) continue;
    const isAbsence =
      f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged" ||
      ABSENCE_PATTERNS_FINALIZE.test(f.full_analysis || "") || ABSENCE_PATTERNS_FINALIZE.test(f.detail || "");
    if (isAbsence && f.absence_confidence !== "verified_absent" && f.severity !== "info") {
      (f as any).severity = "info";
      absenceCaps++;
    }
  }
  if (absenceCaps > 0) {
    console.log(`[canonicalFinalize:absenceVerify] Capped ${absenceCaps} unverified absence finding(s)`);
  }

  // Stage 8: Final validation — ensure all findings have required fields
  for (const f of findings) {
    if (!f.finding_id) (f as any).finding_id = crypto.randomUUID();
    if (!f.severity) (f as any).severity = "info";
    if (!f.title) (f as any).title = "Untitled finding";
  }

  // Stage 9: Formatting
  const formatBudget = EFFECTIVE_CAP_MS - (Date.now() - startTime);
  let fullReport: string | null = null;
  if (formatBudget > 60_000) {
    fullReport = await formatReportInline(ctx, moduleId, executiveHeader, findings, formatBudget, startTime, housekeepingFindings, verificationPhaseErrored, mergeGroupsFallenBack);
  } else {
    console.warn(`[canonicalFinalize] Insufficient budget for formatting (${Math.round(formatBudget / 1000)}s) — report deferred to next invocation`);
  }

  // Stage 10: Build canonical artifact
  const canonicalArtifact = {
    schema_version: FINDING_SCHEMA_VERSION,
    findings,
    housekeepingFindings,
    executiveHeader,
    fullReport,
    completionStatus: fullReport ? "complete" as const : "partial_format_failed" as const,
    timestamp: new Date().toISOString(),
  };

  // Stage 11 (persistence + transition) is handled by the caller since it requires
  // different mechanics for main-path vs fast-path (different INSERT patterns).
  // The caller MUST persist canonicalArtifact and transition to completed status.

  return { findings, housekeepingFindings, fullReport, canonicalArtifact };
}

// ---------------------------------------------------------------------------
// Chunk Routing — uses shared source-policy for contradiction_check
// ---------------------------------------------------------------------------
const MODULE_TAG_RELEVANCE: Record<string, Set<string>> = {
  omission_audit: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
  // Q0 SOURCE POLICY: Uses shared CONTRADICTION_CHECK_ALLOWED_TAGS from source-policy.ts
  contradiction_check: CONTRADICTION_CHECK_ALLOWED_TAGS as Set<string>,
  blind_spot_scanner: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  external_risk_overlay: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "legal", "other"]),
  social_reputation: new Set(["cim", "ic_memo", "consultant_report", "customer_data", "other"]),
  ic_challenge_mode: new Set(["cim", "ic_memo", "consultant_report", "financial_model", "other"]),
  model_assumptions_stress: new Set(["ic_memo", "financial_model", "cim", "consultant_report", "other"]),
  diligence_completeness: new Set(["cim", "ic_memo", "customer_data", "consultant_report", "financial_model", "legal", "other"]),
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const ExtractionRowSchema = z.object({
  document_id: z.string(),
  chunk_index: z.coerce.number(),
  extraction_json: z.any(),
  content_hash: z.string().nullable(),
});

const AnalysisCheckpointSchema = z.object({
  chunk_index: z.coerce.number(),
  content_identity: z.string().nullable().optional(),
});

const MergeCheckpointSchema = z.object({
  tree_level: z.coerce.number(),
  node_index: z.coerce.number(),
  merged_json: z.any(),
});

// MessageResponseSchema is imported via call-llm.ts (LLMResponse type)

const RunIdSchema = z.object({ run_id: z.string() });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Integration context required by the pipeline core */
export interface PipelineContext {
  integrations: {
    db: {
      query: (sql: string, schema: z.ZodType<any>, params: unknown[], meta?: { label: string }) => Promise<any[]>;
      execute: (sql: string, params: unknown[], meta?: { label: string }) => Promise<{ rowCount: number } | void>;
    };
    ai: {
      apiRequest: (req: { method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"; path: string; body: Record<string, unknown> }, opts: { response: z.ZodType<any> }, meta?: { label: string }) => Promise<any>;
    };
  };
}

export interface PipelineInput {
  dealId: string;
  moduleId: string;
  runId?: string | null;
  useOpus?: boolean | null;
  /** IDs of the memo(s) under review — excluded from evidence pool at all retrieval call sites. */
  subjectDocumentIds?: string[] | null;
  numericReport?: { figures: any[]; discrepancies: any[] } | null;
  numericPartial?: boolean | null;
}

export interface PipelineProgress {
  analysisTotal: number;
  analysisCompleted: number;
  mergeRound: number;
  mergeTotal: number;
  mergeGroupsDone?: number;
  mergeGroupsTotal?: number;
}

export interface PipelineResult {
  status: "completed" | "in_progress" | "failed" | "cancelled";
  runId: string;
  phase: string;
  progress: PipelineProgress;
  result: {
    executiveHeader: string;
    findings: MergedFinding[];
    mergedText: string;
    fullReport?: string | null;
  } | null;
  failedChunks?: number;
  truncatedChunks?: number; // analysis chunks where stop_reason was "max_tokens"
  truncatedMerges?: number; // merge groups where stop_reason was "max_tokens"
  mergeGroupsFallenBack?: number; // groups that exhausted retries and used unconsolidated fallback text
  firstError?: string | null;
  /** Chunks that exhausted all extraction attempts and are permanently missing from the report. */
  permanentlyFailedExtractions?: { chunkLabel: string; sourceFile: string; chunkIndex: number }[];
  extractionPassStats?: {
    attemptedThisPass: number;
    succeededThisPass: number;
    failedThisPass: number;
    skippedDueToBudget: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call Anthropic via the shared budget-aware helper.
 * This is the ONLY LLM entry point in pipeline-core.ts.
 * It clamps each attempt's timeout to remaining platform headroom and re-checks
 * headroom before every retry (unlike the old implementation which had no
 * per-attempt headroom check, allowing 120s × 3 + backoffs ≈ 366s worst case).
 */
async function callAnthropic(
  ctx: PipelineContext,
  body: Record<string, unknown>,
  label: string,
  retries = 3,
  perCallTimeoutMs = 120_000,
  pipelineStartTime: number
): Promise<LLMResponse> {
  return callLLMWithHeadroom(ctx, body, label, {
    pipelineStartTime,
    maxPerCallTimeout: perCallTimeoutMs,
    retries,
    minBudget: 30_000, // Analysis/merge can start with less headroom than extraction
  });
}

function extractTag(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Truncate a merge node's text to MERGE_NODE_TEXT_CAP chars.
 * Strategy: parse the text as JSON (bare or fenced) and progressively trim
 * low-priority fields (data_points → key_claims) while preserving flags intact.
 * Falls back to simple char truncation only if parsing fails entirely.
 */
function truncateMergeNodeText(text: string, cap: number): string {
  if (text.length <= cap) return text;

  // Try to parse as structured JSON — real sub-agent output is bare JSON (no fence)
  let obj: Record<string, unknown> | null = null;
  let prefix = ""; // any text before the JSON (e.g. "### Extraction from: ...\n\n")
  let suffix = ""; // any text after
  let jsonStr = "";

  // 1. Try bare JSON parse (text is the JSON itself or starts with it after a header)
  const jsonStart = text.indexOf("{");
  if (jsonStart !== -1) {
    const candidate = text.slice(jsonStart);
    // Find the last closing brace
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace !== -1) {
      jsonStr = candidate.slice(0, lastBrace + 1);
      try {
        obj = JSON.parse(jsonStr);
        prefix = text.slice(0, jsonStart);
        suffix = text.slice(jsonStart + lastBrace + 1);
      } catch {
        obj = null;
      }
    }
  }

  // 2. Fallback: try fenced ```json block (covers any format drift)
  if (!obj) {
    const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        obj = JSON.parse(jsonMatch[1]);
        jsonStr = jsonMatch[1];
        const matchStart = text.indexOf(jsonMatch[0]);
        prefix = text.slice(0, matchStart);
        suffix = text.slice(matchStart + jsonMatch[0].length);
      } catch {
        obj = null;
      }
    }
  }

  // If we have a parsed object, do structured trimming
  if (obj) {
    const rebuild = (o: Record<string, unknown>): string =>
      prefix + JSON.stringify(o, null, 2) + suffix;

    // Priority: flags > key_claims > raw_summary > data_points
    // Remove data_points first (usually the largest field)
    if (obj.data_points && Array.isArray(obj.data_points)) {
      const dpCount = (obj.data_points as unknown[]).length;
      // Progressively trim data_points until under cap
      for (let keep = Math.floor(dpCount / 2); keep >= 0; keep -= Math.max(1, Math.floor(dpCount / 4))) {
        const trimmed = { ...obj, data_points: (obj.data_points as unknown[]).slice(0, keep) };
        const built = rebuild(trimmed);
        if (built.length <= cap) {
          const note = keep < dpCount
            ? `\n\n[NOTE: ${dpCount - keep} data_points trimmed — flags and claims preserved in full]`
            : "";
          return built + note;
        }
      }
      // data_points fully removed, still too long — try trimming key_claims
      const withoutDp = { ...obj };
      delete withoutDp.data_points;

      if (withoutDp.key_claims && Array.isArray(withoutDp.key_claims)) {
        const claimCount = (withoutDp.key_claims as unknown[]).length;
        const keepClaims = Math.ceil(claimCount / 2);
        const trimmed = { ...withoutDp, key_claims: (withoutDp.key_claims as unknown[]).slice(0, keepClaims) };
        const built = rebuild(trimmed);
        if (built.length <= cap) {
          return built + `\n\n[NOTE: Trimmed to ${keepClaims}/${claimCount} claims, removed data_points — flags preserved]`;
        }
      }

      // Still too long — keep only flags + raw_summary (the minimum for merge synthesis)
      const minimal: Record<string, unknown> = {};
      if (obj.document_name) minimal.document_name = obj.document_name;
      if (obj.document_type) minimal.document_type = obj.document_type;
      if (obj.flags) minimal.flags = obj.flags;
      if (obj.raw_summary) minimal.raw_summary = obj.raw_summary;
      const built = rebuild(minimal);
      if (built.length <= cap) {
        return built + `\n\n[NOTE: Kept only flags + raw_summary — data_points and key_claims removed]`;
      }
    }
  }

  // Hard truncation fallback — only reached if JSON parsing failed or flags alone exceed cap
  return text.slice(0, cap) + `\n\n[...TRUNCATED from ${text.length} chars to ${cap} — full text available in extraction checkpoint]`;
}

// Exported for testing
export { truncateMergeNodeText as _truncateMergeNodeText };

// ---------------------------------------------------------------------------
// Inline Report Formatting (runs inside the pipeline after merge completes)
// ---------------------------------------------------------------------------

/**
 * Simple report formatting prompt — generates the full IC report inline.
 * Uses a condensed version of the FormatReport prompt structure.
 * The client can optionally re-format with Opus via the FormatReport API,
 * but this inline Sonnet pass eliminates the client-side timeout risk.
 */
async function formatReportInline(
  _ctx: PipelineContext,
  _moduleId: string,
  executiveHeader: string,
  findings: MergedFinding[],
  _timeRemainingMs: number,
  _pipelineStartTime: number,
  housekeepingFindings: MergedFinding[] = [],
  verificationPhaseErrored: boolean = false,
  mergeGroupsFallenBack: number = 0,
): Promise<string | null> {
  // ---------------------------------------------------------------------------
  // PURE MECHANICAL RENDERER — zero Anthropic calls.
  // Signature and budget plumbing preserved for Track 2 (chunked-LLM demo artifact).
  // Completes in milliseconds; budget machinery is trivially satisfied.
  // ---------------------------------------------------------------------------

  if (findings.length === 0) {
    return `# Diligence Report\n\n> 0 findings. No analysis output.\n`;
  }

  // Partition
  const criticals = findings.filter(f => f.severity === "critical");
  const warnings = findings.filter(f => f.severity === "warning");
  const infos = findings.filter(f => f.severity === "info");
  const totalCount = findings.length;
  const criticalCount = criticals.length;
  const warningCount = warnings.length;
  const infoCount = infos.length;

  // Count by gap_type
  const memoOmissions = findings.filter(f => f.gap_type === "memo_omission").length;
  const diligenceGaps = findings.filter(f => f.gap_type === "diligence_gap").length;
  const otherType = totalCount - memoOmissions - diligenceGaps;

  const lines: string[] = [];

  // =========================================================================
  // (a) DISCLOSURE HEADER
  // =========================================================================
  lines.push(`# Diligence Report`);
  lines.push(``);
  // Partition housekeeping by sub-category
  const housekeepingItems = housekeepingFindings.filter(f => f.category !== "human_review_flag");
  const humanReviewItems = housekeepingFindings.filter(f => f.category === "human_review_flag");
  const housekeepingCount = housekeepingItems.length;
  const humanReviewCount = humanReviewItems.length;

  lines.push(`> **${totalCount} principal findings, ${housekeepingCount} housekeeping, ${humanReviewCount} human-review flags — mechanically rendered, no LLM synthesis.**`);
  lines.push(`>`);
  lines.push(`> Severity: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info.`);
  lines.push(`> Category: ${memoOmissions} memo\_omission, ${diligenceGaps} diligence\_gap${otherType > 0 ? `, ${otherType} other` : ""}.`);
  lines.push(`>`);
  lines.push(`> All detail text reproduced verbatim from pipeline output. Zero paraphrase, zero trimming.`);
  if (verificationPhaseErrored) {
    lines.push(`>`);
    lines.push(`> ⚠️ **Absence claims in this report were not adversarially verified (phase error).**`);
  }
  if (mergeGroupsFallenBack > 0) {
    lines.push(`>`);
    lines.push(`> ⚠️ **${mergeGroupsFallenBack} merge group(s) fell back to unconsolidated text after repeated timeouts.** Findings from those groups are carried forward from sub-analysis but were not synthesized by the merge layer.`);
  }
  lines.push(``);

  // Executive header (deal context from pipeline)
  if (executiveHeader) {
    lines.push(`## Deal Context`);
    lines.push(``);
    lines.push(executiveHeader);
    lines.push(``);
  }

  // =========================================================================
  // (b) FULL INDEX — title + severity + category for every finding
  // =========================================================================
  lines.push(`## Findings Index`);
  lines.push(``);
  lines.push(`| # | Severity | Category | Title |`);
  lines.push(`|---|----------|----------|-------|`);

  // Stable ordering: category → severity → title (deterministic)
  const indexed = findings.map((f, i) => ({ ...f, _origIdx: i }));
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const categoryRank: Record<string, number> = { memo_omission: 0, diligence_gap: 1 };
  indexed.sort((a, b) => {
    const catA = categoryRank[a.gap_type ?? ""] ?? 9;
    const catB = categoryRank[b.gap_type ?? ""] ?? 9;
    if (catA !== catB) return catA - catB;
    const sevA = severityRank[a.severity] ?? 9;
    const sevB = severityRank[b.severity] ?? 9;
    if (sevA !== sevB) return sevA - sevB;
    return a.title.localeCompare(b.title);
  });

  for (let i = 0; i < indexed.length; i++) {
    const f = indexed[i];
    const cat = f.gap_type ?? "unclassified";
    // Escape pipes in titles to avoid breaking table rendering
    const safeTitle = f.title.replace(/\|/g, "\\|");
    lines.push(`| ${i + 1} | ${f.severity.toUpperCase()} | ${cat} | ${safeTitle} |`);
  }
  lines.push(``);

  // =========================================================================
  // (c) FINDINGS — grouped category → severity, verbatim detail, stable anchors
  // =========================================================================
  lines.push(`## Findings`);
  lines.push(``);

  // Group by gap_type
  const categories = new Map<string, Array<MergedFinding & { _origIdx: number }>>();
  for (const f of indexed) {
    const cat = f.gap_type ?? "unclassified";
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(f);
  }

  const categoryOrder = ["memo_omission", "diligence_gap", "unclassified"];
  const sortedCategories = [...categories.entries()].sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a[0]);
    const bIdx = categoryOrder.indexOf(b[0]);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  let globalIdx = 0;
  for (const [category, catFindings] of sortedCategories) {
    const categoryLabel = category === "memo_omission" ? "Memo Omissions"
      : category === "diligence_gap" ? "Diligence Gaps"
      : "Other";

    lines.push(`### ${categoryLabel} (${catFindings.length})`);
    lines.push(``);

    // Already sorted by severity then title from the index sort
    for (const f of catFindings) {
      globalIdx++;
      // Stable anchor ID: finding-{globalIdx}
      lines.push(`<a id="finding-${globalIdx}"></a>`);
      lines.push(``);
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Category:** ${category} | **ID:** finding-${globalIdx}`);
      lines.push(``);

      // Detail — VERBATIM, no paraphrase, no trimming
      // Only escape: bare < or > that would create unintended HTML tags
      const safeDetail = escapeMarkdownBreakers(f.detail);
      lines.push(safeDetail);
      lines.push(``);

      // Source documents — VERBATIM
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:**`);
        for (const doc of f.source_docs) {
          lines.push(`- ${doc}`);
        }
        lines.push(``);
      }

      // Evidence documents — VERBATIM
      if (f.evidence_docs && f.evidence_docs.length > 0) {
        lines.push(`**Evidence Documents:**`);
        for (const doc of f.evidence_docs) {
          lines.push(`- ${doc}`);
        }
        lines.push(``);
      }

      // Claim IDs (if present)
      if (f.claim_ids && f.claim_ids.length > 0) {
        lines.push(`**Claim IDs:** ${f.claim_ids.join(", ")}`);
        lines.push(``);
      }

      // Separator between findings
      lines.push(`---`);
      lines.push(``);
    }
  }

  // =========================================================================
  // (d) HOUSEKEEPING APPENDIX — sub-materiality items demoted per Fix 4
  // =========================================================================
  if (housekeepingItems.length > 0) {
    lines.push(`## Housekeeping Appendix`);
    lines.push(``);
    lines.push(`> ${housekeepingItems.length} sub-materiality item(s) demoted from principal findings. Standard DD workstreams, post-close admin, or process-stage items.`);
    lines.push(``);

    for (const f of housekeepingItems) {
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Demotion rationale:** ${f.materiality_rationale ?? "Sub-materiality threshold"}`);
      lines.push(``);
      lines.push(escapeMarkdownBreakers(f.detail));
      lines.push(``);
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:** ${f.source_docs.join(", ")}`);
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
  }

  // =========================================================================
  // (e) HUMAN REVIEW FLAGS — emphasis-judgment findings per rubric criterion 2
  // =========================================================================
  if (humanReviewItems.length > 0) {
    lines.push(`## Human Review Flags`);
    lines.push(``);
    lines.push(`> ${humanReviewItems.length} finding(s) flagged for human review. These assert emphasis-judgment claims ("underweighted", "de-emphasised") that failed the six-point verification rubric.`);
    lines.push(``);

    for (const f of humanReviewItems) {
      lines.push(`#### ${f.title}`);
      lines.push(``);
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Flag reason:** Emphasis-judgment — requires human assessment`);
      lines.push(``);
      lines.push(escapeMarkdownBreakers(f.detail));
      lines.push(``);
      if (f.source_docs && f.source_docs.length > 0) {
        lines.push(`**Source Documents:** ${f.source_docs.join(", ")}`);
        lines.push(``);
      }
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown Escaping — only where raw text would break markdown rendering
// ---------------------------------------------------------------------------

/**
 * Escapes characters in verbatim detail text that would break markdown rendering.
 * Does NOT paraphrase or trim — only prevents structural markdown breakage.
 */
function escapeMarkdownBreakers(text: string): string {
  // Escape bare angle brackets that look like HTML tags (not part of intentional markdown)
  // but preserve legitimate markdown syntax.
  // Only escape < when followed by a word char (looks like an HTML tag)
  return text.replace(/<(?=[a-zA-Z/])/g, "&lt;");
}

// ---------------------------------------------------------------------------
// Cancellation Gate
// ---------------------------------------------------------------------------

/** Lightweight single-row check — returns true if the run has been cancelled. */
async function checkCancelled(ctx: PipelineContext, runId: string, gate: string): Promise<boolean> {
  // Check is_cancelled boolean (post-migration-009) with fallback to status check
  try {
    const rows = await ctx.integrations.db.query(
      `SELECT COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
      z.object({ is_cancelled: z.boolean() }),
      [runId],
      { label: `Cancel gate: ${gate}` }
    );
    if (rows[0]?.is_cancelled) {
      console.log(`[pipeline:cancel-gate] Run ${runId} cancelled at gate: ${gate}`);
      return true;
    }
  } catch (err: unknown) {
    // Discriminate: 42703 = undefined_column (pre-migration) → silent legacy fallback.
    // The Superblocks platform may wrap Postgres errors into a generic
    // 'Integration "..." failed during "query"' message, so we also treat
    // that wrapped form as a likely missing-column scenario (non-fatal).
    const errMsg = err instanceof Error ? err.message : String(err);
    const isLikelyMissingColumn =
      errMsg.includes("42703") ||
      errMsg.includes("does not exist") ||
      errMsg.includes('failed during "query"');
    if (!isLikelyMissingColumn) {
      console.error(`[pipeline:cancel-gate] UNEXPECTED ERROR at gate "${gate}" for run ${runId}: ${errMsg}`);
    }
    // Pre-migration: column doesn't exist → cancellation indistinguishable server-side.
    // Client-side killedModulesRef is the real guard.
  }
  return false;
}

/** Build a terminal cancelled result. */
function cancelledResult(runId: string, gate: string): PipelineResult {
  return {
    status: "cancelled",
    runId,
    phase: `cancelled_at_${gate}`,
    progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
    result: null,
    failedChunks: 0,
    truncatedChunks: 0,
    truncatedMerges: 0,
    firstError: "Cancelled by user",
  };
}

// ---------------------------------------------------------------------------
// Error Capture — persists error details to module_runs for post-mortem.
// Uses IF NOT EXISTS-style try/catch so the column can be added lazily.
// ---------------------------------------------------------------------------

/**
 * Marks a run as failed and persists the error message + phase into the DB.
 * Falls back gracefully if the error_message/error_phase columns don't exist yet.
 * Also writes to integration-owned `pipeline_errors` table for post-mortem.
 */
async function markRunFailed(
  db: PipelineContext["integrations"]["db"],
  runId: string,
  errorMessage: string,
  errorPhase: string,
  dealId?: string,
  moduleId?: string
): Promise<void> {
  try {
    await db.execute(
      `UPDATE module_runs
       SET status = 'failed'::module_status,
           completed_at = now(),
           error_message = $2,
           error_phase = $3
       WHERE id = $1 AND status = 'running'::module_status`,
      [runId, errorMessage, errorPhase],
      { label: `Mark run failed — ${errorPhase}` }
    );
  } catch {
    // error_message/error_phase columns may not exist yet — fall back to status-only
    await db.execute(
      `UPDATE module_runs SET status = 'failed'::module_status, completed_at = now() WHERE id = $1 AND status = 'running'::module_status`,
      [runId],
      { label: `Mark run failed (legacy) — ${errorPhase}` }
    );
  }

  // Persist to integration-owned pipeline_errors table (best-effort)
  try {
    await db.execute(
      `INSERT INTO pipeline_errors (run_id, deal_id, module_id, error_phase, error_message, error_stack)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        runId,
        dealId ?? "00000000-0000-0000-0000-000000000000",
        moduleId ?? "unknown",
        errorPhase,
        errorMessage.slice(0, 4000),
        new Error().stack?.slice(0, 2000) ?? null,
      ],
      { label: `Persist error to pipeline_errors — ${errorPhase}` }
    );
  } catch {
    // pipeline_errors table may not exist yet — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Core Pipeline Function
// ---------------------------------------------------------------------------
export async function runPipelineCore(ctx: PipelineContext, input: PipelineInput): Promise<PipelineResult> {
  const startTime = Date.now();
  const timeRemaining = () => TIME_BUDGET_MS - (Date.now() - startTime);
  const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // --- Structured Diagnostic Logger ---
  // Emits machine-parseable JSON lines for every phase transition and return point.
  const phaseLog: Array<{phase: string; entered: number; exited?: number; duration_ms?: number; exit_status?: string; exit_reason?: string; counters?: Record<string, number>}> = [];
  let currentPhase: {phase: string; entered: number} | null = null;

  const enterPhase = (phase: string) => {
    if (currentPhase) {
      const entry = phaseLog.find(p => p.phase === currentPhase!.phase && !p.exited);
      if (entry) { entry.exited = Date.now(); entry.duration_ms = entry.exited - entry.entered; entry.exit_status = "passed"; }
    }
    currentPhase = { phase, entered: Date.now() };
    phaseLog.push({ phase, entered: Date.now() });
  };

  const exitPhase = (exit_status: string, exit_reason?: string, counters?: Record<string, number>) => {
    const entry = phaseLog.find(p => p.phase === currentPhase?.phase && !p.exited);
    if (entry) {
      entry.exited = Date.now();
      entry.duration_ms = entry.exited - entry.entered;
      entry.exit_status = exit_status;
      if (exit_reason) entry.exit_reason = exit_reason;
      if (counters) entry.counters = counters;
    }
  };

  const logReturn = (status: string, phase: string, reason: string, counters?: Record<string, number>) => {
    exitPhase(status, reason, counters);
    console.log(`[PIPELINE_TRACE] ${JSON.stringify({
      invocation_id: invocationId,
      run_id: input.runId ?? "new",
      module_id: input.moduleId,
      status,
      return_phase: phase,
      return_reason: reason,
      elapsed_ms: Date.now() - startTime,
      remaining_budget_ms: timeRemaining(),
      phase_timeline: phaseLog,
      counters: counters ?? {},
    })}`);
  };

  // Invocation-start log
  console.log(`[PIPELINE_TRACE] ${JSON.stringify({
    event: "invocation_start",
    invocation_id: invocationId,
    run_id: input.runId ?? "new",
    module_id: input.moduleId,
    deal_id: input.dealId,
    started_at: new Date(startTime).toISOString(),
    time_budget_ms: TIME_BUDGET_MS,
    effective_cap_ms: EFFECTIVE_CAP_MS,
    has_numeric_report: !!input.numericReport,
  })}`);

  const { dealId, moduleId, useOpus } = input;
  // numericReport and numericPartial are mutable — they get recomputed by Step 0.7
  // (inline numeric verification) after doc_tables backfill, closing the two-run bug.
  let numericReport = input.numericReport ?? null;
  let numericPartial = input.numericPartial ?? null;

  // Look up prompts for this module
  const subAgentPrompt = SUB_AGENT_PROMPTS[moduleId];
  if (!subAgentPrompt) {
    throw new Error(`Module "${moduleId}" sub-agent prompt not configured.`);
  }

  const rawMergePrompt = MERGE_PROMPTS[moduleId];
  if (!rawMergePrompt) {
    throw new Error(`Module "${moduleId}" merge prompt not configured.`);
  }

  // --- Step 0: Create or resume run ---
  let runId: string = input.runId ?? "";
  if (!runId) {
    // Guard: prevent concurrent runs of the same module for the same deal.
    // Uses a CTE with an existence check so the INSERT only fires when no
    // running row exists. This is the app-level equivalent of a partial
    // unique index (deal_id, module_id) WHERE status = 'running'.
    let newRunRows: Array<{ run_id: string }>;
    try {
      newRunRows = await ctx.integrations.db.query(
        `WITH guard AS (
           SELECT 1 FROM module_runs
           WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
           LIMIT 1
         )
         INSERT INTO module_runs (deal_id, module_id, status, numeric_report_json)
         SELECT $1, $2, 'running'::module_status, $3::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM guard)
         RETURNING id AS run_id`,
        RunIdSchema,
        [dealId, moduleId, numericReport ? JSON.stringify(numericReport) : null],
        { label: "Create pipeline run (guarded, with numeric report)" }
      );
    } catch {
      // Column doesn't exist yet — insert without numeric_report_json
      newRunRows = await ctx.integrations.db.query(
        `WITH guard AS (
           SELECT 1 FROM module_runs
           WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
           LIMIT 1
         )
         INSERT INTO module_runs (deal_id, module_id, status)
         SELECT $1, $2, 'running'::module_status
         WHERE NOT EXISTS (SELECT 1 FROM guard)
         RETURNING id AS run_id`,
        RunIdSchema,
        [dealId, moduleId],
        { label: "Create pipeline run (guarded, legacy)" }
      );
    }

    if (newRunRows.length === 0) {
      // A running row already exists — return the existing run's ID so the
      // caller can poll progress instead of starting a parallel run.
      const existingRun = await ctx.integrations.db.query(
        `SELECT id AS run_id FROM module_runs
         WHERE deal_id = $1 AND module_id = $2 AND status = 'running'::module_status
         ORDER BY triggered_at DESC LIMIT 1`,
        RunIdSchema,
        [dealId, moduleId],
        { label: "Find existing running run (concurrent guard)" }
      );
      if (existingRun.length > 0) {
        runId = existingRun[0].run_id;
      } else {
        // Race: the other run just completed between our check and this query.
        // Retry with a plain insert (no guard needed anymore).
        const retryRows = await ctx.integrations.db.query(
          `INSERT INTO module_runs (deal_id, module_id, status)
           VALUES ($1, $2, 'running'::module_status)
           RETURNING id AS run_id`,
          RunIdSchema,
          [dealId, moduleId],
          { label: "Create pipeline run (retry after guard race)" }
        );
        runId = retryRows[0].run_id;
      }
    } else {
      runId = newRunRows[0].run_id;
    }
  } else {
    // Only resume runs that are still in 'running' status.
    // Completed or failed runs must NOT be resurrected — that causes the
    // "zombie run" bug where terminated runs get re-opened.
    let status: string;
    let isCancelled: boolean;

    try {
      const currentStatus = await ctx.integrations.db.query(
        `SELECT status, COALESCE(is_cancelled, FALSE) AS is_cancelled FROM module_runs WHERE id = $1 LIMIT 1`,
        z.object({ status: z.string(), is_cancelled: z.boolean() }),
        [runId],
        { label: "Check run status before resume" }
      );

      if (currentStatus.length === 0) {
        throw new Error(`Run ${runId} not found`);
      }

      status = currentStatus[0].status;
      isCancelled = currentStatus[0].is_cancelled;
    } catch (err: unknown) {
      // Dump full error structure — SDK errors strip Postgres detail; we need to
      // learn where the platform actually hides it for future hardening.
      const errDetail = (() => {
        try {
          return JSON.stringify(err, Object.getOwnPropertyNames(err as object));
        } catch {
          return String(err);
        }
      })();
      console.error(`[pipeline:resume-status-check] ERROR for run ${runId}. Full structure: ${errDetail}`);

      // Fallback-probe: status-only query references no missing column.
      // Succeeds → failure was column-related (pre-migration or SDK stripping detail); proceed.
      // Fails → integration genuinely down; rethrow original.
      try {
        const fallbackRows = await ctx.integrations.db.query(
          `SELECT status FROM module_runs WHERE id = $1 LIMIT 1`,
          z.object({ status: z.string() }),
          [runId],
          { label: "Check run status before resume (fallback-probe)" }
        );

        if (fallbackRows.length === 0) {
          throw new Error(`Run ${runId} not found`);
        }

        status = fallbackRows[0].status;
        isCancelled = false;
      } catch (fallbackErr: unknown) {
        // Fallback also failed — integration is genuinely unreachable; rethrow original
        console.error(`[pipeline:resume-status-check] Fallback-probe ALSO FAILED for run ${runId}. Rethrowing original.`);
        throw err;
      }
    }
    if (status === "completed") {
      // Already done — return immediately with a synthetic completed result
      // so the caller knows not to keep polling.
      return {
        status: "completed",
        runId,
        phase: "done",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null, // Caller should load output from module_outputs
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: null,
      };
    }

    if (status === "failed" || isCancelled) {
      // Terminated — don't resurrect. Return the terminal state.
      return {
        status: isCancelled ? "cancelled" : "failed",
        runId,
        phase: "terminated",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null,
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: `Run was already ${status} — cannot resume`,
      };
    }

    // Status is 'running' — refresh triggered_at to claim ownership
    // Also persist numeric report if provided (so background job can use it)
    try {
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now(), numeric_report_json = COALESCE($2::jsonb, numeric_report_json) WHERE id = $1`,
        [runId, numericReport ? JSON.stringify(numericReport) : null],
        { label: "Resume run — refresh triggered_at + persist numeric report" }
      );
    } catch {
      // numeric_report_json column may not exist yet — fallback to plain heartbeat
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Resume run — refresh triggered_at (legacy)" }
      );
    }
  }

  // --- Step 0.3.5: Load filename→tag map for deterministic independent flag ---
  // Used in two places:
  //   1. Injected into the merge prompt so the model has authoritative tag info
  //   2. Post-merge pass overrides `independent` based on actual tags
  // Loaded early so the fast-path (checkpoint resume → format) also has access.
  const DocTagRow = z.object({ id: z.string(), file_name: z.string(), document_tag: z.string() });
  const docTagRows = await ctx.integrations.db.query(
    `SELECT id, file_name, document_tag FROM documents WHERE deal_id = $1`,
    DocTagRow,
    [dealId],
    { label: "Load filename→tag map for independent flag" }
  );
  /** Maps lowercase filename → document_tag (e.g. "ic_memo", "cim", "financial_model") */
  const fileTagMap = new Map<string, string>();
  /** Maps document ID → filename (for subject identity resolution) */
  const idToFileName = new Map<string, string>();
  for (const row of docTagRows) {
    fileTagMap.set(row.file_name.toLowerCase(), row.document_tag);
    idToFileName.set(row.id, row.file_name);
  }

  // --- Fast-Path: Skip to formatting when merge tree is already complete ---
  // When a prior invocation completed all analysis + merge but timed out during
  // formatting (or formatting returned null), re-running the full pipeline wastes
  // ~170s on redundant heavyweight steps (extraction, doc tables, numeric verify,
  // merge loop). Instead, detect that the final merge node exists + no output saved,
  // and jump straight to formatting with the full time budget available.
  if (runId) {
    // Fast-path check: fetch the top checkpoint WITHOUT the potentially huge `text`
    // field. We use jsonb operators to extract only the fields we need for the check,
    // then reconstruct `text` from findings via buildMergedText() (avoids 4MB gRPC breach).
    const FastPathCheckSchema = z.object({
      tree_level: z.coerce.number(),
      node_index: z.coerce.number(),
      executive_header: z.string(),
      findings_json: z.string(), // JSON-encoded findings array
      is_truncated: z.boolean(),
      has_error: z.boolean(),
    });
    const [topCheckpoint] = await ctx.integrations.db.query(
      `SELECT tree_level, node_index,
              COALESCE(merged_json->>'executiveHeader', '') AS executive_header,
              COALESCE(merged_json->'findings', '[]'::jsonb)::text AS findings_json,
              COALESCE((merged_json->>'truncated')::boolean, false) AS is_truncated,
              jsonb_exists(merged_json, 'error') AS has_error
       FROM merge_checkpoints
       WHERE module_run_id = $1
         AND COALESCE(status, 'complete') = 'complete'
       ORDER BY tree_level DESC, node_index ASC
       LIMIT 1`,
      FastPathCheckSchema,
      [runId],
      { label: "Fast-path: check for final merge node (lightweight, status=complete only)" }
    );

    if (topCheckpoint) {
      // Only fast-path if: (a) it's a real success node (not error), (b) it's the
      // sole node at its level (node_index=0 and no siblings), (c) no output saved yet
      // FIX 2: Require an explicit, validated root-completion manifest. The singleton
      // sibling-count heuristic is removed — it cannot prove all branches reached root.
      if (!topCheckpoint.has_error && topCheckpoint.node_index === 0) {
        // Load the root-completion manifest (node_index = -2, distinguished from round manifests at -1)
        let isFinalNode = false;
        const [rootManifestRow] = await ctx.integrations.db.query(
          `SELECT merged_json FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = -2 AND status = 'root_manifest' LIMIT 1`,
          z.object({ merged_json: z.any() }),
          [runId, topCheckpoint.tree_level],
          { label: "Fast-path: load root-completion manifest" }
        );

        if (rootManifestRow?.merged_json) {
          const rawManifest = typeof rootManifestRow.merged_json === "string"
            ? JSON.parse(rootManifestRow.merged_json)
            : rootManifestRow.merged_json;
          const manifest = deserializeManifest(rawManifest);
          if (manifest) {
            // Fix 8D: Full manifest validation on fast path.
            // Check: rootCheckpointId, pipelineVersion, AND sourceFingerprint.
            // Also validate the manifest's source fingerprint against the persisted
            // source snapshot (if available). A stale manifest from a different
            // extraction set must NOT engage the fast path.
            let manifestValid = true;
            let rejectReason = "";

            // 1. Root identity
            if (manifest.rootCheckpointId !== `${topCheckpoint.tree_level}:0`) {
              manifestValid = false;
              rejectReason = `rootCheckpointId mismatch: ${manifest.rootCheckpointId} vs ${topCheckpoint.tree_level}:0`;
            }
            // 2. Pipeline version
            else if (manifest.pipelineVersion !== getPipelineVersion()) {
              manifestValid = false;
              rejectReason = `pipelineVersion mismatch: ${manifest.pipelineVersion.slice(0, 8)} vs ${getPipelineVersion().slice(0, 8)}`;
            }
            // 3. Source fingerprint — validate against persisted source snapshot
            else {
              try {
                const [snapshotCp] = await ctx.integrations.db.query(
                  `SELECT payload FROM pipeline_checkpoints
                   WHERE module_run_id = $1 AND checkpoint_key = 'source_snapshot' AND status = 'complete'
                   LIMIT 1`,
                  z.object({ payload: z.any() }),
                  [runId],
                  { label: "Fast-path Fix8D: load source snapshot for manifest validation" }
                );
                if (snapshotCp?.payload) {
                  const snap = typeof snapshotCp.payload === "string" ? JSON.parse(snapshotCp.payload) : snapshotCp.payload;
                  // The source snapshot contains a fingerprint that represents the current doc set.
                  // The manifest's sourceFingerprint should have been built from the same extraction set.
                  // Cross-check: if the snapshot has changed since the manifest was created, reject.
                  const snapshotFingerprint = snap.fingerprint;
                  if (snapshotFingerprint && manifest.sourceFingerprint) {
                    // Validate current document set hasn't changed by loading fresh doc hashes
                    const freshDocMeta = await ctx.integrations.db.query(
                      `SELECT id, md5(COALESCE(parsed_text, '')) AS content_md5
                       FROM documents WHERE deal_id = $1 ORDER BY file_name`,
                      z.object({ id: z.string(), content_md5: z.string() }),
                      [dealId],
                      { label: "Fast-path Fix8D: verify source docs unchanged" }
                    );
                    // Rebuild fingerprint from current docs and compare to stored snapshot
                    const currentDocHash = freshDocMeta.map(d => `${d.id}:${d.content_md5}`).sort().join("|");
                    const storedDocHash = (snap.documents ?? []).map((d: any) => `${d.documentId}:${d.contentHash}`).sort().join("|");
                    if (currentDocHash !== storedDocHash) {
                      manifestValid = false;
                      rejectReason = `source docs changed since snapshot (${freshDocMeta.length} current docs vs ${(snap.documents ?? []).length} snapshot docs)`;
                    }
                  }
                }
              } catch {
                // Source snapshot unavailable — cannot validate source fingerprint.
                // Conservative: reject the fast path to avoid formatting stale content.
                manifestValid = false;
                rejectReason = "source snapshot unavailable for cross-validation";
              }
            }
            // 4. Leaf count sanity (must be > 0)
            if (manifestValid && manifest.expectedLeafCount === 0) {
              manifestValid = false;
              rejectReason = "expectedLeafCount is 0 — invalid manifest";
            }

            if (manifestValid) {
              isFinalNode = true;
              console.log(`[pipeline:fast-path] Root manifest VALIDATED (Fix8D full): ${manifest.expectedLeafCount} leaves, gen=${manifest.completionGeneration}, srcFp=${manifest.sourceFingerprint.slice(0, 8)}`);
            } else {
              console.warn(
                `[pipeline:fast-path] Root manifest REJECTED (Fix8D): ${rejectReason} — falling through to rebuild`
              );
            }
          } else {
            console.warn(`[pipeline:fast-path] Root manifest failed deserialization — falling through to rebuild`);
          }
        } else {
          // No root-completion manifest: legacy checkpoint without manifest.
          // FIX 2: Legacy checkpoints use recovery (resume/rebuild) rather than inferred completion.
          // Do NOT fall back to sibling-count heuristic.
          console.warn(`[pipeline:fast-path] No root-completion manifest found at level ${topCheckpoint.tree_level} — legacy checkpoint, falling through to recovery path`);
        }

        if (isFinalNode) {
          // Check if output already exists (if so, skip — run should have been marked completed)
          // Exclude invalidated partial artifacts (prefixed with [INVALIDATED_PARTIAL]) — these
          // are leftovers from recovery and must be replaced by a fresh finalization pass.
          const [outputCheck] = await ctx.integrations.db.query(
            `SELECT 1 AS exists FROM module_outputs
             WHERE module_run_id = $1
               AND executive_header NOT LIKE '[INVALIDATED_PARTIAL]%'
             LIMIT 1`,
            z.object({ exists: z.coerce.number() }),
            [runId],
            { label: "Fast-path: check module_outputs (excl. invalidated)" }
          );

          if (!outputCheck) {
            // ✅ Fast-path engaged: final merge node complete, no output yet → format directly
            console.log(`[pipeline:fast-path] Final merge node found at level ${topCheckpoint.tree_level}, skipping to formatting`);

            // Reconstruct findings from checkpoint — RC1: use canonical parser (mode=reload preserves UUIDs)
            const fpRaw = JSON.parse(topCheckpoint.findings_json);
            const fpParseResult = parseCanonicalFindings(fpRaw, {
              mode: "reload",
              source: `fast-path checkpoint L${topCheckpoint.tree_level}:N0 findings_json`,
            });

            // RC3: Fail closed — do NOT proceed to formatting/persistence with a reduced set.
            // If any persisted finding has identity corruption (malformed or invalid), abort
            // the fast path and let the pipeline fall through to the normal merge path.
            if (fpParseResult.malformed_count > 0 || fpParseResult.invalid.length > 0) {
              const malformedMsg = fpParseResult.malformed_count > 0
                ? `${fpParseResult.malformed_count} malformed`
                : "";
              const invalidMsg = fpParseResult.invalid.length > 0
                ? `${fpParseResult.invalid.length} identity-invalid`
                : "";
              const detail = [malformedMsg, invalidMsg].filter(Boolean).join(", ");
              console.error(`[pipeline:fast-path] ABORT: checkpoint findings have corruption (${detail}) — cannot produce valid output from reduced set. Falling through to normal merge path.`);
              // Fall through — do NOT use the corrupt checkpoint.
              // The code below this if-block won't execute; we skip to normal pipeline.
            } else {
            const findings = fpParseResult.findings;

            // ── Pre-check: verify quality-stage prerequisites exist before fast-path finalization ──
            // The fast-path skips quality stages (Q3 evidence admission, claims, reconciliation).
            // If these haven't been run yet (e.g. after recovery clears tree_level>=1), we must
            // fall through to the normal path which runs them. Without this check, the fast-path
            // would loop forever: detect complete tree → try finalize → prerequisites_missing → in_progress → repeat.
            const fpPrereqCheck = await loadCheckpointStatus(
              ctx.integrations.db, runId, moduleId, findings.length > 0
            );
            const fpMissingPrereqs = fpPrereqCheck.filter(s => !s.present).map(s => s.key);
            let fastPathPrereqAbort = false;
            if (fpMissingPrereqs.length > 0) {
              console.warn(`[pipeline:fast-path] Quality-stage prerequisites missing: ${fpMissingPrereqs.join(", ")} — falling through to normal path to run quality stages`);
              fastPathPrereqAbort = true;
            }

            // Reconstruct housekeeping findings from checkpoint merged_json if available
            let fastPathHousekeeping: MergedFinding[] = [];
            let fastPathHousekeepingAbort = false;
            {
              try {
                const [cpRow] = await ctx.integrations.db.query(
                  `SELECT merged_json->'housekeepingFindings' AS hk FROM merge_checkpoints WHERE module_run_id = $1 AND tree_level = $2 AND node_index = 0 LIMIT 1`,
                  z.object({ hk: z.any().nullable() }),
                  [runId, topCheckpoint.tree_level],
                  { label: "Fast-path: load housekeeping from checkpoint" }
                );
                if (cpRow?.hk && Array.isArray(cpRow.hk)) {
                  // RC1: canonical parser for housekeeping reload
                  const hkReloadResult = parseCanonicalFindings(cpRow.hk, {
                    mode: "reload",
                    source: `fast-path checkpoint L${topCheckpoint.tree_level}:N0 housekeepingFindings`,
                  });
                  // RC3-corrective: Fail closed — corrupt housekeeping ABORTS the fast path.
                  // Do NOT zero out and continue — that produces a completed report with
                  // housekeeping silently erased, violating the fail-closed invariant.
                  if (hkReloadResult.malformed_count > 0 || hkReloadResult.invalid.length > 0) {
                    console.error(`[pipeline:fast-path] ABORT: housekeeping findings have corruption (${hkReloadResult.invalid.length} invalid, ${hkReloadResult.malformed_count} malformed) — cannot produce valid output with housekeeping silently removed. Falling through to normal merge path.`);
                    fastPathHousekeepingAbort = true;
                  } else {
                    fastPathHousekeeping = hkReloadResult.findings;
                  }
                }
              } catch (hkErr: any) {
                // Load failure (DB error, unexpected shape) — also abort fast path.
                // A missing housekeeping column (cpRow.hk is null) does NOT reach here
                // because it's handled by the if-guard above; this catches genuine errors.
                console.error(`[pipeline:fast-path] ABORT: failed to load housekeeping (${hkErr.message}) — cannot verify housekeeping integrity. Falling through to normal merge path.`);
                fastPathHousekeepingAbort = true;
              }
            }

            // All fast-path cases route through the shared post-merge finalization runner.
            // The runner handles claims, reconciliation, post-merge, absence verification,
            // and canonical finalization as a single resumable state machine.
            console.log(`[pipeline:fast-path] Routing to shared post-merge finalization runner (prereqAbort=${fastPathPrereqAbort}, hkAbort=${fastPathHousekeepingAbort})`);
              const finalizationResult = await runPostMergeFinalizationStages({
                ctx,
                runId,
                dealId,
                moduleId,
                naturalRootTreeLevel: topCheckpoint.tree_level,
                naturalRootNodeIndex: 0,
                canonicalRootFindings: findings,
                executiveHeader: topCheckpoint.executive_header,
                startTime,
                timeRemaining,
                callerPath: "fast_path",
                housekeepingFindings: fastPathHousekeeping,
                housekeepingValidated: !fastPathHousekeepingAbort,
                fileTagMap,
                sourceManifestHash: topCheckpoint.source_manifest_hash ?? null,
                runPostMergePipeline,
                runAbsenceVerificationPhase,
              });
              // Translate PostMergeFinalizationResult → pipeline return type
              if (finalizationResult.status === "complete" && finalizationResult.artifact) {
                const MAX_MERGED_TEXT_CHARS = 150_000;
                let mergedText = finalizationResult.artifact.report?.markdown ?? "";
                if (mergedText.length > MAX_MERGED_TEXT_CHARS) {
                  mergedText = mergedText.slice(0, MAX_MERGED_TEXT_CHARS) + "\n\n[…truncated for transport]";
                }
                return {
                  status: "completed",
                  runId,
                  phase: "done",
                  progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
                  result: {
                    executiveHeader: finalizationResult.artifact.report?.executive_header ?? topCheckpoint.executive_header,
                    findings: (finalizationResult.artifact.canonical_findings ?? findings) as MergedFinding[],
                    mergedText,
                    fullReport: finalizationResult.artifact.report?.markdown ?? "",
                  },
                  failedChunks: 0,
                  truncatedChunks: 0,
                  truncatedMerges: 0,
                  firstError: null,
                };
              }
              // In-progress, blocked, or failed — return in_progress for pipeline scheduler to retry
              return {
                status: "in_progress",
                runId,
                phase: `post_merge_finalization_${finalizationResult.currentStage ?? "init"}`,
                progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
                result: null,
                failedChunks: 0,
                truncatedChunks: 0,
                truncatedMerges: 0,
                firstError: finalizationResult.blockingReasons.length > 0
                  ? finalizationResult.blockingReasons.join("; ")
                  : null,
              };
            } // end fast-path findings valid
          }
        }
      }
    }
  }

  // --- Subject & Evidence Pool Guard (resume-aware) ---
  // ALL analysis modules (everything routed through pipeline-core) require:
  //   1. At least one subject document ID — the memo(s) under review
  //   2. At least one evidence document — reference material beyond the subject
  // Executive Summary is NOT routed through pipeline-core so is unaffected.
  //
  // RESUME-AWARENESS: If the run already has analysis checkpoints, the subject
  // was validated on the original invocation. Don't kill a multi-hour run because
  // a resume call arrived with empty subject IDs (auto-resume race condition).
  let subjectIds = input.subjectDocumentIds ?? [];
  if (subjectIds.length === 0 && runId) {
    // Attempt to reconstruct subject IDs: IC memo documents for this deal
    // (same logic as the frontend auto-preselect)
    const icMemoRows = await ctx.integrations.db.query(
      `SELECT id FROM documents WHERE deal_id = $1 AND document_tag = 'ic_memo'`,
      z.object({ id: z.string() }),
      [dealId],
      { label: "Reconstruct subjectIds from ic_memo docs (resume fallback)" }
    );
    if (icMemoRows.length > 0) {
      subjectIds = icMemoRows.map(r => r.id);
      console.log(`[pipeline] Reconstructed subjectIds from ${icMemoRows.length} ic_memo doc(s) (resume fallback)`);
    }
  }
  if (subjectIds.length === 0 && runId) {
    // Even reconstruction failed — check if the run already has checkpoints.
    // If so, skip the guard (subject was validated on first invocation).
    const [existingCp] = await ctx.integrations.db.query(
      `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ cnt: z.coerce.number() }),
      [runId],
      { label: "Check existing checkpoints for resume guard bypass" }
    );
    if (existingCp && existingCp.cnt > 0) {
      console.warn(`[pipeline] Subject guard bypass: run ${runId} has ${existingCp.cnt} analysis checkpoints but empty subjectIds on resume — proceeding without subject exclusion`);
      // Proceed with empty subjectIds — extraction routing already encoded subject/evidence split
    } else {
      // True fresh start with no checkpoints and no subject — fail
      const errMsg = "Cannot run this module without selecting a subject memo. Please choose the 'Memo(s) under review' before running.";
      await markRunFailed(ctx.integrations.db, runId, errMsg, "no_subject_document", dealId, moduleId);
      return {
        status: "failed",
        runId,
        phase: "no_subject_document",
        progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
        result: null,
        failedChunks: 0,
        truncatedChunks: 0,
        truncatedMerges: 0,
        firstError: errMsg,
      };
    }
  } else if (subjectIds.length === 0) {
    // No runId (shouldn't happen in practice) — original guard
    const errMsg = "Cannot run this module without selecting a subject memo. Please choose the 'Memo(s) under review' before running.";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "no_subject_document", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "no_subject_document",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: errMsg,
    };
  }

  // Check that the evidence pool (deal docs minus subject IDs) has at least one document
  // with indexed chunks. A document that exists but produced zero chunks (parse failure,
  // unsupported type) means FTS has nothing to search — treat as empty evidence pool.
  const evidenceCountRows = await ctx.integrations.db.query(
    `SELECT COUNT(DISTINCT d.id)::int AS cnt
     FROM documents d
     WHERE d.deal_id = $1
       AND d.id != ALL($2::uuid[])
       AND EXISTS (SELECT 1 FROM document_chunks dc WHERE dc.document_id = d.id)`,
    z.object({ cnt: z.number() }),
    [dealId, subjectIds],
    { label: "Check evidence pool has chunked documents" }
  );
  const evidenceCount = evidenceCountRows[0]?.cnt ?? 0;
  if (evidenceCount === 0) {
    const errMsg = "Cannot run this module without at least one reference document in the evidence pool. Upload documents beyond the subject memo before running.";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "no_evidence_documents", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "no_evidence_documents",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: errMsg,
    };
  }

  // --- Fix 10C: Persist canonical subject IDs for resume ---
  // After all guard logic and reconstruction, persist the final subject set so that
  // the fast path (and future resume calls) can load it without re-deriving.
  if (subjectIds.length > 0 && runId) {
    try {
      await ctx.integrations.db.execute(
        `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
         VALUES ($1, 'canonical_subject_ids', $2::jsonb, 'complete', $3)
         ON CONFLICT (module_run_id, checkpoint_key)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete'`,
        [runId, JSON.stringify(subjectIds), getPipelineVersion()],
        { label: "Fix10C: Persist canonical subject IDs" }
      );
    } catch { /* non-fatal — derivation fallback covers it */ }
  }

  // --- Step 0.4: Clean corrupted parsed_text (phantom columns from old parser) ---
  enterPhase("cleanup");
  // Detects and trims phantom columns from spreadsheet documents whose parsed_text
  // was generated by the pre-used-range-fix parser. Idempotent: clean docs are no-ops.
  // Backs up original text to parsed_text_backups table before any writes.
  // TIME-BUDGET AWARE: Will stop between documents and return partial if budget exceeded.
  const cleanResult = await runCleanParsedTextPhase(ctx.integrations.db, {
    dealId,
    dryRun: false,
    startTime,
    timeBudgetMs: TIME_BUDGET_MS,
  });
  if (cleanResult.corruptedCount > 0) {
    console.log(`[Step 0.4] Cleaned ${cleanResult.corruptedCount} document(s), saved ${(cleanResult.totalBytesSaved / 1_000_000).toFixed(1)}MB`);
  }
  if (cleanResult.partial) {
    // Time budget consumed by cleanup — return in_progress so caller re-invokes.
    // Naturally resumable: cleaned docs won't be detected as corrupted next time.
    return {
      status: "in_progress",
      runId,
      phase: "cleanup",
      progress: {
        analysisTotal: cleanResult.documentsTotal,
        analysisCompleted: cleanResult.documentsProcessed,
        mergeRound: 0,
        mergeTotal: 0,
      },
      result: null,
      failedChunks: 0,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: null,
    };
  }

  // --- Step 0.5: Ensure extractions exist (self-sufficient extraction phase) ---
  enterPhase("extraction");
  // ALWAYS run extraction gap-fill regardless of analysis state.
  // Requirement: full extraction data must exist before merge proceeds.
  const extractionResult = await runExtractionPhase(ctx, dealId, startTime, runId);
  if (extractionResult.needed && !extractionResult.completed) {
    // Time budget consumed by extraction — return in_progress so caller re-invokes
    return {
      status: "in_progress",
      runId,
      phase: "extraction",
      progress: {
        analysisTotal: extractionResult.totalChunks,
        analysisCompleted: extractionResult.extractedSoFar,
        mergeRound: 0,
        mergeTotal: 0,
      },
      result: null,
      failedChunks: extractionResult.failedChunks,
      truncatedChunks: 0,
      truncatedMerges: 0,
      firstError: extractionResult.firstError,
      extractionPassStats: extractionResult.passStats,
    };
  }

  // === CANCEL GATE: post-extraction ===
  if (await checkCancelled(ctx, runId, "post_extraction")) return cancelledResult(runId, "post_extraction");

  // --- Step 0.5.5: Build or validate Source Snapshot (Fix 5) ---
  // After extraction is complete, build a unified snapshot of all source documents
  // and their processing metadata. This is the single authority for downstream
  // checkpoint validation (doc_tables, numeric, merge manifest, origin map).
  //
  // On resume: load persisted snapshot and validate against current document set.
  // If invalid (doc changed, version drift): invalidate is logged but we proceed
  // with a fresh snapshot (downstream phases handle their own invalidation).
  let sourceSnapshot: SourceSnapshot | null = null;
  try {
    // Load existing snapshot from checkpoint
    const [snapshotRow] = await ctx.integrations.db.query(
      `SELECT payload FROM pipeline_checkpoints
       WHERE module_run_id = $1 AND checkpoint_key = 'source_snapshot' AND status = 'complete'
       LIMIT 1`,
      z.object({ payload: z.any() }),
      [runId],
      { label: "Load source snapshot checkpoint" }
    );

    if (snapshotRow?.payload) {
      const raw = typeof snapshotRow.payload === "string" ? JSON.parse(snapshotRow.payload) : snapshotRow.payload;
      // Build current document metadata for validation
      const currentDocMeta = await ctx.integrations.db.query(
        `SELECT id, COALESCE(length(parsed_text), 0) AS text_length,
                file_name, document_tag,
                md5(COALESCE(parsed_text, '')) AS content_md5
         FROM documents WHERE deal_id = $1
         ORDER BY file_name`,
        z.object({ id: z.string(), text_length: z.coerce.number(), file_name: z.string(), document_tag: z.string().nullable(), content_md5: z.string() }),
        [dealId],
        { label: "Load doc metadata for snapshot validation" }
      );
      const currentDocs: BuildSnapshotInput["documents"] = currentDocMeta.map(d => ({
        id: d.id,
        contentHash: d.content_md5,
        documentType: d.file_name.split(".").pop() ?? "unknown",
        sourceTag: d.document_tag,
        chunkCount: Math.ceil(d.text_length / 5000), // CHUNK_CHARS
      }));

      const validation = validateSourceSnapshot(raw, currentDocs);
      if (validation.valid) {
        sourceSnapshot = validation.snapshot;
        console.log(`[SourceSnapshot] Loaded valid snapshot: fingerprint=${sourceSnapshot.fingerprint.slice(0, 8)}, ${sourceSnapshot.documents.length} docs`);
      } else {
        console.log(`[SourceSnapshot] Stored snapshot invalid (${validation.reason}) — rebuilding`);
      }
    }
  } catch (snapshotErr) {
    // pipeline_checkpoints may not exist; non-fatal for loading
    console.log(`[SourceSnapshot] Could not load checkpoint: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`);
  }

  if (!sourceSnapshot) {
    // Build fresh snapshot from current document state
    const docMetaForSnapshot = await ctx.integrations.db.query(
      `SELECT id, COALESCE(length(parsed_text), 0) AS text_length,
              file_name, document_tag,
              md5(COALESCE(parsed_text, '')) AS content_md5
       FROM documents WHERE deal_id = $1
       ORDER BY file_name`,
      z.object({ id: z.string(), text_length: z.coerce.number(), file_name: z.string(), document_tag: z.string().nullable(), content_md5: z.string() }),
      [dealId],
      { label: "Load doc metadata for fresh snapshot" }
    );
    const snapshotInput: BuildSnapshotInput = {
      documents: docMetaForSnapshot.map(d => ({
        id: d.id,
        contentHash: d.content_md5,
        documentType: d.file_name.split(".").pop() ?? "unknown",
        sourceTag: d.document_tag,
        chunkCount: Math.ceil(d.text_length / 5000),
      })),
    };
    sourceSnapshot = buildSourceSnapshot(snapshotInput);
    console.log(`[SourceSnapshot] Built fresh: fingerprint=${sourceSnapshot.fingerprint.slice(0, 8)}, ${sourceSnapshot.documents.length} docs`);

    // Persist the snapshot checkpoint (fail-closed: must succeed for provenance integrity)
    await ctx.integrations.db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
       VALUES ($1, 'source_snapshot', $2::jsonb, 'complete', $3)
       ON CONFLICT (module_run_id, checkpoint_key)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = EXCLUDED.version_hash`,
      [runId, JSON.stringify(sourceSnapshot), getPipelineVersion()],
      { label: "Persist source snapshot checkpoint" }
    );
  }

  // --- Step 0.6: Ensure doc_tables is populated for spreadsheet documents ---
  enterPhase("doc_tables");
  // Same self-sufficiency pattern as extraction phase. Pure CPU (no LLM calls),
  // completes in seconds. If doc_tables is already populated, this is a no-op.
  const docTablesResult = await runDocTablesPhase(ctx, dealId);
  if (docTablesResult.needed && docTablesResult.warnings.length > 0) {
    console.log(`[DocTablesPhase] Warnings: ${docTablesResult.warnings.join("; ")}`);
  }

  // --- Step 0.7: Inline numeric verification (recomputes after backfill) ---
  enterPhase("numeric_verification");
  // For numeric modules, run the arithmetic engine NOW — after doc_tables is
  // guaranteed populated — and use the fresh result regardless of what the
  // client may have passed in. This closes the two-run bug where client-side
  // NumericVerify ran before backfill and found nothing.
  //
  // CHECKPOINT-RESUME: If a complete numeric report is already persisted for this
  // run (from a prior invocation), reload it and skip re-running the engine.
  // If the engine returns partial=true (budget exhaustion), return in_progress.
  if (NUMERIC_MODULES.has(moduleId)) {
    // --- FIX 4: Resumable numeric verification with durable checkpoint ---
    // Load any existing checkpoint (complete OR partial) from prior invocation.
    // Pass partial checkpoints to runNumericVerifyInline so it resumes from cursor.
    let numericCheckpointLoaded = false;
    let loadedCheckpointPayload: unknown | null = null;
    let loadedCheckpointStatus: string | null = null;
    try {
      const cpRows = await ctx.integrations.db.query(
        `SELECT payload, status FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'numeric_report'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        z.object({ payload: z.any(), status: z.string().nullable() }),
        [runId],
        { label: "Load numeric checkpoint (any status)" }
      );
      if (cpRows.length > 0 && cpRows[0].payload) {
        loadedCheckpointPayload = cpRows[0].payload;
        loadedCheckpointStatus = cpRows[0].status ?? "complete";
        const saved = cpRows[0].payload as { figures?: unknown[]; discrepancies?: unknown[]; status?: string };
        // Fix 8E: Complete checkpoints are NOT trusted solely on row status.
        // They must pass the same structural validation as partial checkpoints.
        // This is delegated to runNumericVerifyInline which calls validateNumericCheckpoint.
        // Only short-circuit if the checkpoint passes validation inside the engine.
        if (loadedCheckpointStatus === "complete" && saved.figures && saved.discrepancies) {
          // Pass to engine for validation rather than trusting row status alone.
          // The engine will validate (schema version, config version, doc universe, prefix tables)
          // and either return the cached result or invalidate and rebuild.
          console.log(
            `[NumericInline:Fix8E] Loaded complete checkpoint (${(saved.figures as any[]).length} figures) — ` +
            `delegating to engine for structural validation before trusting`
          );
        } else {
          console.log(
            `[NumericInline] Loaded ${loadedCheckpointStatus} checkpoint — will pass to engine for resume`
          );
        }
      }
    } catch {
      // pipeline_checkpoints may not exist yet — proceed to run fresh
    }

    if (!numericCheckpointLoaded) {
      // Time budget for numeric: give it up to 60s from whatever remains,
      // but never less than 15s (at which point it's not worth starting).
      const numericTimeBudget = Math.min(60_000, Math.max(0, timeRemaining() - 60_000));
      if (numericTimeBudget >= 15_000) {
        try {
          const inlineResult = await runNumericVerifyInline(
            ctx.integrations.db,
            dealId,
            numericTimeBudget,
            loadedCheckpointPayload, // Pass existing checkpoint for resume
          );

          // Replace the input-provided report with the fresh server-side result
          if (inlineResult.figures.length > 0 || inlineResult.discrepancies.length > 0) {
            numericReport = {
              figures: inlineResult.figures,
              discrepancies: inlineResult.discrepancies,
            };
            numericPartial = inlineResult.partial;
            console.log(
              `[NumericInline] Engine result: ${inlineResult.figures.length} figures, ` +
              `${inlineResult.discrepancies.length} discrepancies, partial=${inlineResult.partial}`
            );
          } else if (!numericReport) {
            numericReport = null;
            numericPartial = null;
            console.log(`[NumericInline] No numeric data found for this deal.`);
          }

          // Persist checkpoint regardless of status (partial OR complete)
          // so the next resume invocation can pick up where this one left off.
          // FIX 4 CORRECTIVE: A failed partial-checkpoint write MUST NOT allow
          // processing to continue as though the cursor were durable.
          if (inlineResult.checkpoint) {
            const cpStatus = inlineResult.partial ? "partial" : "complete";
            try {
              await ctx.integrations.db.execute(
                `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
                 VALUES ($1, 'numeric_report', $2::jsonb, $3, $4)
                 ON CONFLICT (module_run_id, checkpoint_key)
                 DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(),
                              status = EXCLUDED.status, version_hash = EXCLUDED.version_hash`,
                [runId, JSON.stringify(inlineResult.checkpoint), cpStatus, getPipelineVersion()],
                { label: `Persist numeric checkpoint (${cpStatus})` }
              );
              console.log(`[NumericInline] Persisted ${cpStatus} checkpoint`);
            } catch (cpErr) {
              if (inlineResult.partial) {
                // FAIL-LOUD: partial checkpoint write failure means the cursor is NOT durable.
                // If we return in_progress without persisting, the next invocation will redo
                // the same work (livelock). Throw so the caller sees the failure.
                const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
                throw new Error(
                  `[NumericInline] FATAL: Failed to persist partial numeric checkpoint. ` +
                  `Cursor is not durable — cannot guarantee forward progress. ` +
                  `Underlying error: ${cpMsg}`
                );
              }
              // For complete results, non-fatal — the result is still usable this invocation
              console.warn(`[NumericInline] Failed to persist complete checkpoint (non-fatal): ${cpErr instanceof Error ? cpErr.message : String(cpErr)}`);
            }
          }

          // COMPLETION GATE: if numeric is partial, return in_progress — do NOT proceed to merge
          if (inlineResult.partial) {
            console.log(`[NumericInline] Partial result — returning in_progress for resume`);
            return {
              status: "in_progress",
              runId: runId!,
              phase: "numeric_verify",
              progress: {
                analysisTotal: 0,
                analysisCompleted: 0,
                mergeRound: 0,
                mergeTotal: 0,
              },
              result: null,
              failedChunks: 0,
              truncatedChunks: 0,
              truncatedMerges: 0,
              firstError: null,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[NumericInline] Failed (non-fatal, keeping client report if any): ${msg}`);
          // Keep whatever numericReport the client provided as fallback
        }
      } else {
        // Insufficient budget to even start numeric — return in_progress for resume
        console.log(`[NumericInline] Insufficient time budget (${numericTimeBudget}ms) — returning in_progress for resume`);
        return {
          status: "in_progress",
          runId: runId!,
          phase: "numeric_verify",
          progress: {
            analysisTotal: 0,
            analysisCompleted: 0,
            mergeRound: 0,
            mergeTotal: 0,
          },
          result: null,
          failedChunks: 0,
          truncatedChunks: 0,
          truncatedMerges: 0,
          firstError: null,
        };
      }
    }
  }

  // --- Step 0.8: Claims-Reconciliation (contradiction_check only) ---
  enterPhase("claims_reconciliation");
  // ARCHITECTURE (post-livelock fix):
  //   - Claims extraction advances through a persisted document/chunk cursor.
  //   - Completed claims are retained across invocations (never reset/deleted).
  //   - Insufficient budget causes a checkpointed yield, NOT a skip.
  //   - Reconciliation resumes from durable work state.
  //   - Analysis may start independently, but canonical finalization waits on claims.
  //   - Zero-progress retries emit a no_progress diagnostic and halve work units.
  //   - Permanent failures produce explicit "degraded" status in the final report.
  //
  // LLM classifies scope; CODE computes delta. No LLM-computed numbers.
  let claimsReconciliation: ReconciliationResult | null = null;
  /** When true, claims/reconciliation are not yet complete but analysis can proceed */
  let claimsPending = false;
  /** When true, claims permanently failed — report must disclose degraded state */
  let claimsDegraded = false;
  /** Maximum consecutive no-progress invocations before declaring degraded */
  const CLAIMS_MAX_NO_PROGRESS = 5;

  if (moduleId === "contradiction_check") {
    // --- Load persisted reconciliation result (if already complete) ---
    let reconCheckpointLoaded = false;
    try {
      const reconCpRows = await ctx.integrations.db.query(
        `SELECT payload FROM pipeline_checkpoints
         WHERE module_run_id = $1 AND checkpoint_key = 'reconciliation'
           AND COALESCE(status, 'complete') = 'complete'`,
        z.object({ payload: z.any() }),
        [runId],
        { label: "Load reconciliation checkpoint" }
      );
      if (reconCpRows.length > 0 && reconCpRows[0].payload) {
        claimsReconciliation = reconCpRows[0].payload as ReconciliationResult;
        reconCheckpointLoaded = true;
        console.log(
          `[ClaimsReconciliation] Loaded checkpoint: ${claimsReconciliation.findings.length} findings ` +
          `(${claimsReconciliation.reconciled_count} reconciled, ` +
          `${claimsReconciliation.unreconcilable_count} unreconcilable)`
        );
      }
    } catch {
      // pipeline_checkpoints may not exist yet
    }

    if (!reconCheckpointLoaded) {
      // --- Load or initialize claims ledger ---
      let claimsLedger: ClaimsLedger | null = null;
      try {
        const ledgerCpRows = await ctx.integrations.db.query(
          `SELECT payload FROM pipeline_checkpoints
           WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'`,
          z.object({ payload: z.any() }),
          [runId],
          { label: "Load claims ledger checkpoint (any status)" }
        );
        if (ledgerCpRows.length > 0 && ledgerCpRows[0].payload) {
          claimsLedger = ledgerCpRows[0].payload as ClaimsLedger;
          if (claimsLedger.complete && (claimsLedger.extraction_metadata?.pending ?? 0) === 0) {
            console.log(
              `[ClaimsExtraction] Loaded COMPLETE checkpoint: ${claimsLedger.claims.length} claims ` +
              `(${claimsLedger.extraction_metadata.operating_metric_claims} operating_metric)`
            );
          } else {
            console.log(
              `[ClaimsExtraction] Loaded PARTIAL checkpoint: ${claimsLedger.claims.length} claims retained, ` +
              `${claimsLedger.extraction_metadata?.pending ?? 0} pending, ` +
              `consecutive_no_progress=${claimsLedger.extraction_metadata?.consecutive_no_progress ?? 0}`
            );
          }
        }
      } catch {
        // pipeline_checkpoints may not exist yet
      }

      // --- Check for permanent failure (degraded state) ---
      const priorNoProgress = claimsLedger?.extraction_metadata?.consecutive_no_progress ?? 0;
      if (priorNoProgress >= CLAIMS_MAX_NO_PROGRESS) {
        console.warn(
          `[ClaimsExtraction] DEGRADED: ${priorNoProgress} consecutive zero-progress invocations. ` +
          `Declaring permanent failure — analysis will proceed without claims.`
        );
        claimsDegraded = true;
        // Mark checkpoint as degraded so future invocations don't retry
        try {
          await ctx.integrations.db.execute(
            `UPDATE pipeline_checkpoints
             SET status = 'degraded', updated_at = now()
             WHERE module_run_id = $1 AND checkpoint_key = 'claims_ledger'`,
            [runId],
            { label: "Mark claims ledger as degraded" }
          );
        } catch { /* non-fatal */ }
      }

      // --- Step 0.8a: Incremental claims extraction ---
      if (!claimsDegraded && !(claimsLedger?.complete)) {
        // Compute available time budget — use whatever remains, minimum 15s to do any work
        const claimsTimeBudget = Math.min(120_000, Math.max(0, timeRemaining() - 15_000));
        if (claimsTimeBudget >= 15_000) {
          try {
            // Adaptive work-unit sizing: halve units on consecutive no-progress
            const maxWorkUnits = priorNoProgress > 0
              ? Math.max(1, Math.ceil(10 / Math.pow(2, priorNoProgress)))
              : undefined; // No cap on first attempt or after progress

            claimsLedger = await runClaimsExtraction(
              ctx, dealId, startTime, claimsTimeBudget * 0.6,
              { priorLedger: claimsLedger ?? undefined, maxWorkUnits },
            );

            // --- No-progress detection ---
            const completedThisInvocation = claimsLedger.extraction_metadata.completed_this_invocation ?? 0;
            if (completedThisInvocation === 0 && !claimsLedger.complete) {
              const newNoProgress = priorNoProgress + 1;
              claimsLedger.extraction_metadata.consecutive_no_progress = newNoProgress;
              console.warn(
                `[ClaimsExtraction] NO PROGRESS: 0 memos processed this invocation ` +
                `(consecutive_no_progress=${newNoProgress}/${CLAIMS_MAX_NO_PROGRESS}). ` +
                `Next invocation will use smaller work unit.`
              );
              if (newNoProgress >= 2) {
                console.error(`[PIPELINE_NO_PROGRESS] ${JSON.stringify({
                  invocation_id: invocationId,
                  run_id: runId,
                  blocking_phase: "claims_extraction",
                  consecutive_no_progress: newNoProgress,
                  max_no_progress: CLAIMS_MAX_NO_PROGRESS,
                  memos_pending: claimsLedger.extraction_metadata.pending,
                  memos_completed: claimsLedger.extraction_metadata.docs_processed,
                  time_budget_used_ms: claimsTimeBudget,
                  will_degrade_at: CLAIMS_MAX_NO_PROGRESS,
                })}`);
              }
            } else {
              // Progress made — reset no-progress counter
              claimsLedger.extraction_metadata.consecutive_no_progress = 0;
            }

            // Persist ledger — status reflects completion state. NEVER delete completed claims.
            const cpStatus = claimsLedger.complete ? "complete" : "partial";
            try {
              await ctx.integrations.db.execute(
                `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
                 VALUES ($1, 'claims_ledger', $2::jsonb, $3, $4)
                 ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = $3, version_hash = $4`,
                [runId, JSON.stringify(claimsLedger), cpStatus, getPipelineVersion()],
                { label: `Persist claims ledger checkpoint (${cpStatus})` }
              );
            } catch {
              // pipeline_checkpoints table may not exist yet — non-fatal
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[ClaimsExtraction] Error (non-fatal, analysis proceeds): ${msg}`);
          }
        } else {
          // Budget too low even for minimal work — yield. Analysis still proceeds.
          console.log(`[ClaimsExtraction] Budget too low (${claimsTimeBudget}ms) — yielding. Analysis proceeds independently.`);
        }
      }

      // --- Step 0.8b: Reconciliation (only when claims fully complete) ---
      if (claimsLedger?.complete && claimsLedger.claims.length > 0 && numericReport && !claimsDegraded) {
        const reconTimeBudget = Math.min(90_000, Math.max(0, timeRemaining() - 15_000));
        if (reconTimeBudget >= 15_000) {
          try {
            claimsReconciliation = await runReconciliation(
              ctx,
              claimsLedger,
              numericReport.figures ?? [],
              numericReport.discrepancies ?? [],
              startTime,
              reconTimeBudget,
            );
            console.log(
              `[ClaimsReconciliation] ${claimsReconciliation.findings.length} findings ` +
              `(${claimsReconciliation.reconciled_count} reconciled, ` +
              `${claimsReconciliation.within_tolerance_count} within tolerance, ` +
              `${claimsReconciliation.unreconcilable_count} unreconcilable)`
            );
            // Persist reconciliation result
            try {
              await ctx.integrations.db.execute(
                `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
                 VALUES ($1, 'reconciliation', $2::jsonb, 'complete', $3)
                 ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
                [runId, JSON.stringify(claimsReconciliation), getPipelineVersion()],
                { label: "Persist reconciliation checkpoint" }
              );
            } catch {
              // pipeline_checkpoints table may not exist yet — non-fatal
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[ClaimsReconciliation] Failed (non-fatal): ${msg}`);
          }
        } else {
          // Budget insufficient for reconciliation — yield. Next invocation will complete.
          console.log(`[ClaimsReconciliation] Budget insufficient (${reconTimeBudget}ms) — yielding for next invocation.`);
        }
      } else if (claimsLedger && !claimsLedger.complete && !claimsDegraded) {
        // Claims still pending — flag for canonical finalization gate
        claimsPending = true;
        console.log(
          `[ClaimsReconciliation] Claims still pending (${claimsLedger.extraction_metadata.pending} memos) — ` +
          `analysis proceeds independently, canonical finalization will gate on completion.`
        );
      } else if (claimsDegraded) {
        console.log(`[ClaimsReconciliation] Claims degraded — reconciliation skipped. Final report will disclose.`);
      } else if (claimsLedger?.claims.length === 0) {
        console.log(`[ClaimsReconciliation] No claims extracted — reconciliation not needed.`);
      }
    }
  }

  // --- Step 1: Load universal extractions + route ---
  enterPhase("analysis_preparation");
  // Page sizes tuned per table to stay under the 4MB gRPC response limit.
  // Row payload varies significantly: extraction_json ~2-4KB, result_json ~3-6KB,
  // merged_json ~8-20KB for intermediate nodes BUT up to 2MB+ for final-round nodes
  // (which accumulate ALL findings from the full run). Page sizes MUST account for
  // the worst-case row in each table, not just the average.
  const EXTRACTION_PAGE_SIZE = 200;  // ~2-4KB/row → ~400-800KB/page
  const ANALYSIS_PAGE_SIZE = 150;    // ~3-6KB/row → ~450-900KB/page
  const MERGE_CP_PAGE_SIZE = 20;     // Reduced from 75: final-round nodes can be 200KB-2MB each
                                       // (381 findings × 3-10KB/finding + mergedText). At 20 rows/page,
                                       // worst case = ~2-3MB/page, safely under 4MB gRPC limit.
  const allExtractions: Array<{ document_id: string; chunk_index: number; extraction_json: any; content_hash: string | null }> = [];
  let offset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT document_id, chunk_index, extraction_json, content_hash
       FROM universal_extractions
       WHERE deal_id = $1
       ORDER BY document_id, chunk_index
       LIMIT ${EXTRACTION_PAGE_SIZE} OFFSET ${offset}`,
      ExtractionRowSchema,
      [dealId],
      { label: `Load extractions (offset ${offset})` }
    );
    allExtractions.push(...page);
    if (page.length < EXTRACTION_PAGE_SIZE) break;
    offset += EXTRACTION_PAGE_SIZE;
  }

  const relevantTags = MODULE_TAG_RELEVANCE[moduleId] ?? new Set(["other"]);
  const routingDiagnostics: RoutingDiagnosticEntry[] = [];
  const routed = allExtractions.filter(row => {
    const ext = typeof row.extraction_json === "string"
      ? JSON.parse(row.extraction_json)
      : row.extraction_json;
    // Never analyze failed extractions — they contain no usable text.
    // (Defense-in-depth: the extraction gate should prevent reaching here with
    // failed chunks, but this filter protects against stale DB state or reruns.)
    if (ext.failed) return false;
    const tag = String(ext.documentTag ?? "other");

    // For contradiction_check: use metadata-aware source policy
    if (moduleId === "contradiction_check") {
      const filename = idToFileName.get(row.document_id) ?? ext.sourceFile ?? "";
      const decision = isChunkAllowedForContradictionCheck(tag, {
        title: ext.documentTitle ?? filename,
        filename,
        doc_type: ext.doc_type ?? undefined,
        document_category: ext.document_category ?? undefined,
      });
      routingDiagnostics.push({
        document_id: row.document_id,
        document_title: filename,
        chunk_index: row.chunk_index,
        tag,
        actual_source_type: decision.actual_source_type ?? tag,
        allowed: decision.allowed,
        reason: decision.reason ?? "allowed",
      });
      return decision.allowed;
    }

    return relevantTags.has(tag);
  });

  if (routed.length === 0) {
    const errMsg = "No extraction chunks matched this module's document tags (check document tagging)";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "routing", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "routing",
      progress: { analysisTotal: 0, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      firstError: errMsg,
    };
  }

  // Persist routing diagnostics for contradiction_check
  if (moduleId === "contradiction_check" && routingDiagnostics.length > 0) {
    const diagnosticPayload = JSON.stringify({
      total_chunks_considered: routingDiagnostics.length,
      chunks_routed: routingDiagnostics.filter(e => e.allowed).length,
      chunks_excluded: routingDiagnostics.filter(e => !e.allowed).length,
      by_source_type: routingDiagnostics.reduce((acc, e) => {
        const key = e.actual_source_type;
        if (!acc[key]) acc[key] = { routed: 0, excluded: 0 };
        if (e.allowed) acc[key].routed++; else acc[key].excluded++;
        return acc;
      }, {} as Record<string, { routed: number; excluded: number }>),
      entries: routingDiagnostics,
      timestamp: new Date().toISOString(),
    });
    await ctx.integrations.db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, status, payload, created_at)
       VALUES ($1, 'routing_diagnostics', 'complete', $2::jsonb, now())
       ON CONFLICT (module_run_id, checkpoint_key) WHERE checkpoint_key = 'routing_diagnostics'
       DO UPDATE SET payload = $2::jsonb, status = 'complete'`,
      [runId, diagnosticPayload],
      { label: "Persist routing diagnostics" }
    );
    console.log(`[RoutingDiagnostics] ${routingDiagnostics.filter(e => e.allowed).length} routed, ${routingDiagnostics.filter(e => !e.allowed).length} excluded`);
  }

  // --- Step 1.1: Load or Build Claim Origin Map (explicit provenance) ---
  // Replaces the old approach of parsing "c{N}-{M}" into the routed array.
  // The origin map resolves claim_ids to source documents deterministically.
  //
  // CHECKPOINT HANDLING (fail-closed):
  //   - No row → first-run: build from routed array and persist.
  //   - Row found, valid + fingerprint matches → use it (resume path).
  //   - Row found, corrupt/parse failure → HARD ERROR (do not rebuild silently).
  //   - Row found, fingerprint mismatch → HARD ERROR (stale map from different extraction).
  let claimOriginMap;
  let originMapPersistedThisRun = false;

  // Compute current fingerprint BEFORE attempting load — this is the authoritative
  // description of what the map SHOULD contain.
  const currentFingerprint = computeOriginMapFingerprint(routed, getPipelineVersion());

  // Try loading persisted origin map first
  const cpResult = await ctx.integrations.db.query(
    `SELECT payload FROM pipeline_checkpoints
     WHERE module_run_id = $1 AND checkpoint_key = 'claim_origin_map' AND status = 'complete'
     LIMIT 1`,
    z.object({ payload: z.any() }),
    [runId],
    { label: "Load persisted claim origin map" }
  );

  if (cpResult.length > 0) {
    // Row exists — parse and validate. ANY failure here is a hard error.
    let rawPayload: unknown;
    try {
      rawPayload = typeof cpResult[0].payload === "string"
        ? JSON.parse(cpResult[0].payload)
        : cpResult[0].payload;
    } catch (jsonErr) {
      throw new Error(
        `[ClaimOriginMap] CORRUPT checkpoint: payload is not valid JSON. ` +
        `This indicates data corruption in pipeline_checkpoints. ` +
        `Parse error: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`
      );
    }

    // Deserialize with fingerprint verification — throws on mismatch or schema issues
    claimOriginMap = deserializeOriginMap(rawPayload, currentFingerprint);
    originMapPersistedThisRun = true;
    console.log(`[ClaimOriginMap] Loaded persisted map (${claimOriginMap.entries.size} entries, ${claimOriginMap.ambiguousLegacyIds.size} ambiguous)`);
  }

  if (!claimOriginMap) {
    // No checkpoint row — first-time construction from routed array
    claimOriginMap = buildOriginMapFromRoutedArray(routed, idToFileName);
    console.log(`[ClaimOriginMap] Built from routed array (${claimOriginMap.entries.size} entries, ${claimOriginMap.ambiguousLegacyIds.size} ambiguous)`);

    // Persist the origin map for future resume (with fingerprint)
    // FIX 5: Write failure MUST throw — an unpersisted origin map means resume
    // will silently rebuild with potentially different extraction order, breaking
    // provenance continuity. Fail-closed: no silent data loss.
    const serialized = serializeOriginMap(claimOriginMap, currentFingerprint);
    await ctx.integrations.db.execute(
      `INSERT INTO pipeline_checkpoints (module_run_id, checkpoint_key, payload, status, version_hash)
       VALUES ($1, 'claim_origin_map', $2::jsonb, 'complete', $3)
       ON CONFLICT (module_run_id, checkpoint_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now(), status = 'complete', version_hash = $3`,
      [runId, JSON.stringify(serialized), getPipelineVersion()],
      { label: "Persist claim origin map checkpoint" }
    );
    originMapPersistedThisRun = true;
  }

  // --- Step 1.5: Web Research Phase (for web research modules only) ---
  // Runs the iterative web search loop server-side with checkpointing.
  // If incomplete (budget exhausted), returns in_progress with phase "web_research".
  // If complete, iterations are loaded later and converted to analysis-compatible format.
  if (WEB_RESEARCH_MODULES.has(moduleId)) {
    const webResearchResult = await runWebResearchPhase(
      ctx,
      dealId,
      moduleId,
      runId,
      startTime,
      TIME_BUDGET_MS,
      routed
    );

    if (webResearchResult.needed && !webResearchResult.completed) {
      // Time budget consumed — return in_progress so caller re-invokes
      return {
        status: "in_progress",
        runId,
        phase: "web_research",
        progress: {
          analysisTotal: webResearchResult.totalIterations,
          analysisCompleted: webResearchResult.iterationCount,
          mergeRound: 0,
          mergeTotal: 0,
        },
        result: null,
        firstError: webResearchResult.firstError,
      };
    }
    // If completed, fall through — inject iterations as synthetic analysis checkpoints
    // so the merge step picks them up identically to normal analysis results.
    const iterRows = await ctx.integrations.db.query(
      `SELECT iteration, query, finding, confidence, platform, category, sources, materiality
       FROM web_research_iterations
       WHERE run_id = $1 AND status = 'completed'
       ORDER BY iteration`,
      z.object({
        iteration: z.coerce.number(),
        query: z.string().nullable(),
        finding: z.string().nullable(),
        confidence: z.coerce.number().nullable(),
        platform: z.string().nullable(),
        category: z.string().nullable(),
        sources: z.any().nullable(),
        materiality: z.string().nullable(),
      }),
      [runId],
      { label: "Load completed iterations for merge injection" }
    );

    // Check if analysis checkpoints already exist (idempotent resume)
    const existingAnalysis = await ctx.integrations.db.query(
      `SELECT chunk_index FROM pipeline_analysis WHERE run_id = $1 LIMIT 1`,
      z.object({ chunk_index: z.coerce.number() }),
      [runId],
      { label: "Check if iteration analysis already injected" }
    );

    if (existingAnalysis.length === 0 && iterRows.length > 0) {
      // Inject each iteration as a synthetic analysis checkpoint
      for (const row of iterRows) {
        const label = `${moduleId} iteration ${row.iteration}: ${row.query ?? "research"}`;
        const extraction = [
          `### Web Research Finding (Iteration ${row.iteration})`,
          "",
          `**Query:** ${row.query ?? "research"}`,
          row.category ? `**Category:** ${row.category}` : (row.platform ? `**Platform:** ${row.platform}` : ""),
          row.materiality ? `**Materiality:** ${row.materiality}` : "",
          `**Confidence:** ${row.confidence ?? 0}/10`,
          row.sources ? `**Sources:** ${(Array.isArray(row.sources) ? row.sources : []).join(", ")}` : "",
          "",
          row.finding ?? "No finding recorded",
        ].filter(Boolean).join("\n");

        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (run_id, chunk_index) DO UPDATE SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
          [runId, row.iteration - 1, JSON.stringify({ label, extraction, chunkIndex: row.iteration - 1 }), getModuleModel(moduleId), getPipelineVersion()],
          { label: `Inject iteration ${row.iteration} as analysis` }
        );
      }
      console.log(`[WebResearch] Injected ${iterRows.length} iterations as analysis checkpoints`);
    }
  }

  // --- Step 2: Sub-agent analysis (with checkpointing) ---
  enterPhase("analysis_execution");
  // For web research modules, iterations have already been injected as analysis
  // checkpoints above — this step will see them all as "already analyzed" and skip.
  const currentVersion = getPipelineVersion();
  const analyzedRows = await ctx.integrations.db.query(
    `SELECT chunk_index,
            result_json->>'content_identity' AS content_identity
     FROM pipeline_analysis
     WHERE run_id = $1 AND prompt_version = $2
     ORDER BY chunk_index`,
    AnalysisCheckpointSchema,
    [runId, currentVersion],
    { label: "Load analysis checkpoints (version-matched)" }
  );

  // Version mismatch detection: check if there are ANY rows for this run with a
  // DIFFERENT prompt_version OR null (pre-versioning = stale by definition).
  const staleRows = await ctx.integrations.db.query(
    `SELECT COUNT(*)::int AS cnt FROM pipeline_analysis
     WHERE run_id = $1 AND (prompt_version IS NULL OR prompt_version != $2)`,
    z.object({ cnt: z.coerce.number() }),
    [runId, currentVersion],
    { label: "Check for stale analysis checkpoints" }
  );

  if (staleRows.length > 0 && staleRows[0].cnt > 0) {
    // Stale checkpoints detected — cannot resume this run. Create a new run_id.
    const errMsg = `VERSION MISMATCH: ${staleRows[0].cnt} analysis rows have a different prompt_version than current (${currentVersion}). Starting fresh run.`;
    console.error(`[pipeline] ${errMsg}`);

    // Create a brand new run instead of reusing this stale one
    const freshRunRows = await ctx.integrations.db.query(
      `INSERT INTO module_runs (deal_id, module_id, status)
       VALUES ($1, $2, 'running'::module_status)
       RETURNING id AS run_id`,
      RunIdSchema,
      [dealId, moduleId],
      { label: "Create fresh run (version mismatch)" }
    );
    const freshRunId = freshRunRows[0].run_id;
    console.log(`[pipeline] Created fresh run ${freshRunId} (replacing stale ${runId})`);

    // Mark the old run as failed with error capture
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "version_mismatch", dealId, moduleId);

    // Recurse with the new run_id (this is safe — it will enter the fresh-start path)
    return runPipelineCore(ctx, { ...input, runId: freshRunId });
  }

  // CORRECTIVE A + Fix 8A: Validate analysis checkpoints against current routed array.
  // A checkpoint at globalIdx N is valid only if routed[N]'s content identity matches.
  // This prevents stale checkpoints from being reused when documents change/reorder.
  // Fix 8A: Uses the authoritative content_hash from the DB column (not ext.contentHash
  // from inside extraction_json which may be empty). Legacy checkpoints with null identity
  // are REJECTED (rerun) — they cannot prove they match the current extraction content.
  const analyzedSet = new Set<number>();
  let legacyCheckpointsRejected = 0;
  for (const row of analyzedRows) {
    const idx = row.chunk_index;
    if (idx >= routed.length) continue; // out of range — stale checkpoint
    const routedItem = routed[idx];
    // Use the DB-level content_hash (authoritative) rather than ext.contentHash (inline, may be stale/empty)
    const dbContentHash = routedItem.content_hash ?? "";
    const currentIdentity = `${routedItem.document_id}:${routedItem.chunk_index}:${dbContentHash}`;
    const storedIdentity = row.content_identity;
    // Fix 8A: Legacy checkpoints without content hash identity must be invalidated.
    // A null/empty stored identity cannot prove it matches the current extraction content.
    if (!storedIdentity) {
      legacyCheckpointsRejected++;
      continue;
    }
    if (storedIdentity !== currentIdentity) {
      // Mismatched — routed array changed or content changed; this checkpoint is stale
      continue;
    }
    analyzedSet.add(idx);
  }
  if (legacyCheckpointsRejected > 0) {
    console.log(`[pipeline:Fix8A] Rejected ${legacyCheckpointsRejected} legacy analysis checkpoint(s) without content hash identity — will rerun`);
  }

  // For web research modules, analysis is synthetic (injected from iterations).
  // Skip the normal sub-agent loop entirely — pendingChunks is empty.
  const pendingChunks = WEB_RESEARCH_MODULES.has(moduleId)
    ? []
    : routed.filter((_, i) => !analyzedSet.has(i));
  let analysisCompleted = analyzedSet.size;
  let failedChunks = 0;
  let truncatedChunks = 0;
  let truncatedMerges = 0;
  let mergeGroupsFallenBack = 0; // groups that exhausted MAX_MERGE_GROUP_FAILURES and used fallback text

  // Analysis-entry diagnostics (after variables are declared)
  console.log(`[PIPELINE_TRACE] ${JSON.stringify({
    event: "analysis_entry",
    invocation_id: invocationId,
    run_id: runId,
    total_chunks: routed.length,
    completed_chunks: analyzedSet.size,
    pending_chunks: pendingChunks.length,
    legacy_rejected: legacyCheckpointsRejected,
    remaining_budget_ms: timeRemaining(),
    platform_remaining_ms: EFFECTIVE_CAP_MS - (Date.now() - startTime),
  })}`);

  let firstError: string | null = null;

  // --- Checklist Coverage Scan (runs once, before analysis) ---
  // Exhaustive full-text search across ALL document chunks for each
  // diligence checklist category. Produces authoritative coverage map
  // Modules with checklist-based analysis use a coverage map to prevent fabrication
  let coverageMapBlock = "";
  let dealProcessContextBlock = "";
  if (CHECKLIST_MODULES.has(moduleId)) {
    try {
      const scanResult = await runChecklistScan(ctx, dealId, subjectIds); // FIX 3: use reconstructed subject IDs
      coverageMapBlock = "\n\n" + formatCoverageMapForPrompt(scanResult);
      console.log(`[pipeline] Checklist scan complete: ${scanResult.coveredCount} covered, ${scanResult.notFoundCount} not found (${scanResult.scanDurationMs}ms, ${scanResult.totalQueries} queries)`);
    } catch (scanErr) {
      console.warn("[pipeline] Checklist scan failed (non-fatal, proceeding without coverage map):", scanErr);
    }

    // Fix 5: Extract deal-process context (DD/adviser table with post-IC staging)
    // Search for workstreams explicitly staged "post IC" or "kick off post IC" in the deal documents.
    // These are ground truth: work the record stages post-IC is open_item_acknowledged, never an omission.
    try {
      const processRows = await ctx.integrations.db.query(
        `SELECT dc.file_name, dc.chunk_text
         FROM document_chunks dc
         JOIN deal_documents dd ON dd.id = dc.document_id
         WHERE dd.deal_id = $1
           AND dc.chunk_text_search @@ to_tsquery('english', 'adviser | advisor | workstream | "kick off" | "post IC" | "due diligence" & provider')
         ORDER BY ts_rank_cd(dc.chunk_text_search, to_tsquery('english', 'adviser | advisor | workstream | "kick off" | "post IC"')) DESC
         LIMIT 5`,
        z.object({ file_name: z.string(), chunk_text: z.string() }),
        [dealId],
        { label: "Fix 5: Extract DD/adviser table context" }
      );
      if (processRows.length > 0) {
        const contextLines = [
          "\n\n## DEAL-PROCESS CONTEXT — Staged Workstreams (Ground Truth)",
          "",
          "The following excerpts from the deal's own documents describe workstreams explicitly",
          "staged for post-IC or post-close completion. These are OPEN ITEMS by design, NOT omissions.",
          "Any finding that flags an item listed here as 'missing' or 'absent' MUST be reclassified",
          "as gap_type = 'open_item_acknowledged' — the record itself discloses these as pending.",
          "",
        ];
        for (const row of processRows) {
          contextLines.push(`### From: ${row.file_name}`);
          contextLines.push(`> ${row.chunk_text.slice(0, 500)}`);
          contextLines.push("");
        }
        dealProcessContextBlock = contextLines.join("\n");
      }
    } catch (processErr) {
      console.warn("[pipeline] Deal-process context extraction failed (non-fatal):", processErr);
    }
  }

  // Helper: return in_progress checkpoint
  const returnInProgress = (phase: "analysis" | "merge", mergeRound = 0, mergeGroupsDone = 0, mergeGroupsTotal = 0): PipelineResult => ({
    status: "in_progress",
    runId: runId!,
    phase,
    progress: {
      analysisTotal: routed.length,
      analysisCompleted,
      mergeRound,
      mergeTotal: Math.ceil(Math.log(Math.max(routed.length, 2)) / Math.log(MERGE_GROUP_SIZE)),
      mergeGroupsDone,
      mergeGroupsTotal,
    },
    result: null,
    failedChunks,
    truncatedChunks,
    truncatedMerges,
    firstError,
  });

  // Process pending chunks with dynamic batch sizing
  // ─── WORKER PATH (Commit 1): bounded, lease-based analysis ───────────────
  // Uses analysis_work_items for coordination; dual-writes to pipeline_analysis.
  // Gated by: ANALYSIS_WORKER_ENABLED flag AND per-run opt-in in pipeline_run_config.
  // Legacy path below remains for existing in-progress runs (fail-closed: if
  // pipeline_run_config is missing or errors, always falls through to legacy).
  const useWorkerPath = ANALYSIS_WORKER_ENABLED && await isWorkerEnabledForRun(ctx, runId!);

  if (useWorkerPath) {
    enterPhase("analysis_worker");

    // Population: every invocation reconciles the full expected identity set (resumable)
    const routedForWorker = routed.map((row, idx) => ({
      document_id: String(row.document_id ?? ""),
      chunk_index: idx,
      content_hash: String(row.content_hash ?? ""),
    }));
    const analysisVersion = getPipelineVersion();
    const popResult = await populateWorkItems(ctx, runId!, routedForWorker, analysisVersion);
    console.log(
      `[analysis-worker] Population: ${popResult.inserted} inserted, ` +
      `${popResult.skippedDuplicate} skipped, ${popResult.seededFromExisting} seeded, ` +
      `${popResult.presentCount}/${popResult.expectedCount} present (missing: ${popResult.missingCount})`
    );
    const generationId = popResult.generationId;

    // If population is incomplete, return in_progress to retry next invocation
    if (popResult.missingCount > 0) {
      logReturn("in_progress", "analysis", "population_incomplete", {
        present: popResult.presentCount,
        expected: popResult.expectedCount,
        missing: popResult.missingCount,
      });
      exitPhase("analysis_worker");
      return returnInProgress("analysis");
    }

    // Budget gate: need at least 130s for a meaningful analysis batch
    const WORKER_BUDGET_GATE_MS = 130_000;
    const workerBudgetRemaining = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (workerBudgetRemaining < WORKER_BUDGET_GATE_MS) {
      logReturn("in_progress", "analysis", "worker_budget_insufficient", {
        remaining_ms: Math.round(workerBudgetRemaining),
        gate_ms: WORKER_BUDGET_GATE_MS,
      });
      exitPhase("analysis_worker");
      return returnInProgress("analysis");
    }

    // Claim a bounded batch (fenced)
    const workerInvocationId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const batchSize = Math.min(ANALYSIS_WORKER_BATCH_SIZE, WORKER_BATCH_SIZE);
    const { claimed, recovered } = await claimBatch(ctx, runId!, workerInvocationId, batchSize, generationId);

    if (recovered > 0) {
      console.log(`[analysis-worker] Recovered ${recovered} expired lease(s)`);
    }

    if (claimed.length === 0) {
      // No claimable items — either all complete or all permanently failed
      const counts = await getAnalysisCounts(ctx, runId!, generationId, popResult.expectedCount);
      console.log(
        `[analysis-worker] No claimable items: ` +
        `complete=${counts.complete}, failed_permanent=${counts.failed_permanent}, ` +
        `pending=${counts.pending}, claimed=${counts.claimed}, missing=${counts.missingFromQueue}`
      );

      // Check for dual-write mismatches (diagnostic visibility)
      const { mismatches } = await detectMismatches(ctx, runId!, generationId);
      if (mismatches.length > 0) {
        console.warn(
          `[analysis-worker] ⚠️  ${mismatches.length} dual-write mismatch(es) detected:`,
          JSON.stringify(mismatches)
        );
      }

      if (await isAnalysisComplete(ctx, runId!, generationId, popResult.expectedCount)) {
        // All work items are terminal — analysis phase complete
        analysisCompleted = counts.complete;
        failedChunks = counts.failed_permanent;
        exitPhase("analysis_worker");
        // Fall through to merge phase below
      } else {
        // Items are claimed by other workers — wait for them
        exitPhase("analysis_worker");
        return returnInProgress("analysis");
      }
    } else {
      // Process claimed items
      console.log(`[analysis-worker] Claimed ${claimed.length} item(s) for processing`);

      const workerResults = await Promise.allSettled(
        claimed.map(async (item) => {
          const row = routed[item.chunk_index];
          if (!row) {
            throw new Error(`Work item chunk_index ${item.chunk_index} exceeds routed array length ${routed.length}`);
          }

          const ext = typeof row.extraction_json === "string"
            ? JSON.parse(row.extraction_json)
            : row.extraction_json;

          const chunkText = String(ext.extraction ?? ext.text ?? "");
          const chunkLabel = String(ext.label ?? `Chunk ${item.chunk_index}`);

          const userContent = `--- Extracted text from "${chunkLabel}" ---\n\n${chunkText}\n\nAnalyze this chunk now.${coverageMapBlock}`;

          const result = await callAnthropic(
            ctx,
            {
              model: getModuleModel(moduleId),
              max_tokens: SUB_AGENT_MAX_TOKENS,
              system: [{ type: "text", text: subAgentPrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: userContent }],
            },
            `Worker: ${chunkLabel} (${item.chunk_index + 1}/${routed.length})`,
            3,
            120_000,
            startTime
          );

          const textBlock = result.content.find((c: { type: string }) => c.type === "text");
          const extraction = `### Extraction from: ${chunkLabel}\n\n${textBlock?.text ?? ""}`;
          const truncated = result.stop_reason === "max_tokens";

          // Content identity as JSON object (not string) per Corrective C1.1 requirement
          const contentIdentity = {
            document_id: String(row.document_id ?? ""),
            chunk_index: item.chunk_index,
            chunk_hash: String(row.content_hash ?? ""),
          };

          // Fenced dual-write: pipeline_analysis + mark work item complete
          const { accepted } = await completeItem(ctx, item, {
            label: chunkLabel,
            extraction,
            chunkIndex: item.chunk_index,
            truncated,
            content_identity: contentIdentity,
          }, getModuleModel(moduleId), workerInvocationId);

          return { label: chunkLabel, chunkIndex: item.chunk_index, truncated, accepted };
        })
      );

      // Process results — derive durable progress from queue counts (not promises)
      for (let i = 0; i < workerResults.length; i++) {
        const r = workerResults[i];
        if (r.status === "fulfilled") {
          // Only count as progress if the completion was accepted
          if (r.value.accepted) {
            // Durable progress — will be confirmed by queue counts below
          } else {
            console.warn(`[analysis-worker] Chunk ${r.value.chunkIndex} completion rejected (stale worker)`);
          }
          if (r.value.truncated) truncatedChunks++;
        } else {
          // Mark item as failed in the work queue (fenced)
          await failItem(ctx, claimed[i], r.reason, workerInvocationId);
          const errMsg = r.reason?.message ?? String(r.reason ?? "Unknown error");
          console.error(`[analysis-worker] Chunk ${claimed[i].chunk_index} failed: ${errMsg.slice(0, 200)}`);
          if (!firstError) firstError = errMsg;
        }
      }

      // Heartbeat
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Refresh triggered_at (worker heartbeat)" }
      );

      // Cancel gate
      if (await checkCancelled(ctx, runId, "analysis_worker_batch")) {
        exitPhase("analysis_worker");
        return cancelledResult(runId!, "analysis_worker_batch");
      }

      // Derive durable progress from queue counts (not from fulfilled promise count)
      const postBatchCounts = await getAnalysisCounts(ctx, runId!, generationId, popResult.expectedCount);
      analysisCompleted = postBatchCounts.complete;
      failedChunks = postBatchCounts.failed_permanent;

      // Check if more work remains
      if (!(await isAnalysisComplete(ctx, runId!, generationId, popResult.expectedCount))) {
        exitPhase("analysis_worker");
        return returnInProgress("analysis");
      }

      exitPhase("analysis_worker");
      // Fall through to merge phase
    }
  } else {
  // ─── LEGACY PATH: inline analysis loop ─────────────────────────────────────
  for (let bStart = 0; bStart < pendingChunks.length; ) {
    // Batch-aware graceful exit: don't launch if the real platform clock can't
    // accommodate worst-case batch (1 full attempt + checkpoint I/O reserve).
    // FE4's HeadroomExhaustedError already gates any second attempt dynamically
    // at retry-time — this pre-batch check only guarantees room for ONE attempt.
    const ANALYSIS_CALL_TIMEOUT = 120_000;
    const analysisBatchWorstCase = ANALYSIS_CALL_TIMEOUT + CHECKPOINT_RESERVE_MS; // 160s
    const platformDeadlineAnalysis = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (platformDeadlineAnalysis < analysisBatchWorstCase) {
      logReturn("in_progress", "analysis", "analysis_budget_insufficient", {
        platform_deadline_ms: Math.round(platformDeadlineAnalysis),
        batch_worst_case_ms: Math.round(analysisBatchWorstCase),
        pending_chunks: pendingChunks.length - bStart,
        completed_chunks: analysisCompleted,
      });
      console.log(`[pipeline:graceful-exit] Analysis phase — platformDeadline=${Math.round(platformDeadlineAnalysis / 1000)}s < batchWorstCase=${Math.round(analysisBatchWorstCase / 1000)}s — returning in_progress`);
      return returnInProgress("analysis");
    }

    const batchSize = platformDeadlineAnalysis < 90_000 ? 5 : ANALYSIS_CONCURRENCY;
    const batch = pendingChunks.slice(bStart, bStart + batchSize);
    bStart += batchSize;

    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const ext = typeof row.extraction_json === "string"
          ? JSON.parse(row.extraction_json)
          : row.extraction_json;

        const chunkText = String(ext.extraction ?? ext.text ?? "");
        const chunkLabel = String(ext.label ?? `Chunk ${row.chunk_index}`);
        const globalIdx = routed.indexOf(row);

        const userContent = `--- Extracted text from "${chunkLabel}" ---\n\n${chunkText}\n\nAnalyze this chunk now.${coverageMapBlock}`;

        const result = await callAnthropic(
          ctx,
          {
            model: getModuleModel(moduleId),
            max_tokens: SUB_AGENT_MAX_TOKENS,
            system: [{ type: "text", text: subAgentPrompt, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: userContent }],
          },
          `Sub-agent: ${chunkLabel} (${globalIdx + 1}/${routed.length})`,
          3,
          120_000,
          startTime
        );

        const textBlock = result.content.find((c: { type: string }) => c.type === "text");
        const extraction = `### Extraction from: ${chunkLabel}\n\n${textBlock?.text ?? ""}`;
        const truncated = result.stop_reason === "max_tokens";

        // Save checkpoint with content_identity for Fix 8A validation on resume.
        // Uses the DB-level content_hash (authoritative) rather than ext.contentHash (inline).
        const dbContentHash = row.content_hash ?? "";
        const contentIdentity = `${row.document_id}:${row.chunk_index}:${dbContentHash}`;
        await ctx.integrations.db.execute(
          `INSERT INTO pipeline_analysis (run_id, chunk_index, result_json, model_used, prompt_version)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (run_id, chunk_index) DO UPDATE SET result_json = $3::jsonb, model_used = $4, prompt_version = $5`,
          [runId, globalIdx, JSON.stringify({ label: chunkLabel, extraction, chunkIndex: globalIdx, truncated, content_identity: contentIdentity }), getModuleModel(moduleId), currentVersion],
          { label: `Save analysis checkpoint ${globalIdx}` }
        );

        return { label: chunkLabel, extraction, chunkIndex: globalIdx, truncated };
      })
    );

    // Count successes and track failures
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        analysisCompleted++;
        if (r.value.truncated) truncatedChunks++;
      } else {
        failedChunks++;
        const failedRow = batch[i];
        const failedLabel = (() => {
          try {
            const ext = typeof failedRow.extraction_json === "string" ? JSON.parse(failedRow.extraction_json) : failedRow.extraction_json;
            return ext.label ?? `Chunk ${routed.indexOf(failedRow)}`;
          } catch { return `Chunk (batch index ${i})`; }
        })();
        const errMsg = r.reason?.message ?? String(r.reason ?? "Unknown error");
        console.error(`[ANALYSIS FAILED] ${failedLabel} | error: ${errMsg}`);
        if (!firstError) firstError = errMsg;
      }
    }

    // Refresh triggered_at so long multi-pass runs aren't purged as stale
    await ctx.integrations.db.execute(
      `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
      [runId],
      { label: "Refresh triggered_at (checkpoint heartbeat)" }
    );

    // === CANCEL GATE: between analysis batches ===
    if (await checkCancelled(ctx, runId, "analysis_batch")) return cancelledResult(runId, "analysis_batch");

    // Post-batch graceful exit (redundant with top-of-loop, but catches batches
    // that completed faster than worst-case — allows immediate exit without re-entering loop header)
    const postBatchDeadlineAnalysis = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (postBatchDeadlineAnalysis < analysisBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Analysis post-batch — platformDeadline=${Math.round(postBatchDeadlineAnalysis / 1000)}s — returning in_progress`);
      return returnInProgress("analysis");
    }
  }
  } // end else: legacy analysis path

  // --- Chunk Coverage Log (per-document in vs. processed) ---
  {
    const docCoverage = new Map<string, { total: number; analyzed: number }>();
    for (const row of routed) {
      const ext = typeof row.extraction_json === "string" ? JSON.parse(row.extraction_json) : row.extraction_json;
      const label = String(ext.label ?? "unknown").replace(/ \(part \d+\)$/, "");
      if (!docCoverage.has(label)) docCoverage.set(label, { total: 0, analyzed: 0 });
      docCoverage.get(label)!.total++;
    }
    // Count analyzed from DB (already stored checkpoint rows)
    const analyzedIndicesNow = await ctx.integrations.db.query(
      `SELECT chunk_index FROM pipeline_analysis WHERE run_id = $1`,
      z.object({ chunk_index: z.coerce.number() }),
      [runId],
      { label: "Coverage log: count analyzed rows" }
    );
    const analyzedSetNow = new Set(analyzedIndicesNow.map(r => r.chunk_index));
    for (let i = 0; i < routed.length; i++) {
      const ext = typeof routed[i].extraction_json === "string" ? JSON.parse(routed[i].extraction_json) : routed[i].extraction_json;
      const label = String(ext.label ?? "unknown").replace(/ \(part \d+\)$/, "");
      if (analyzedSetNow.has(i)) docCoverage.get(label)!.analyzed++;
    }
    const lines = [`[CHUNK COVERAGE] run=${runId} module=${moduleId}`];
    for (const [doc, counts] of docCoverage) {
      const status = counts.analyzed === counts.total ? "✓" : "⚠ DROPPED";
      lines.push(`  ${status} ${doc}: ${counts.analyzed}/${counts.total} chunks analyzed`);
    }
    lines.push(`  TOTAL: ${analyzedSetNow.size}/${routed.length} (${failedChunks} failed this invocation)`);
    console.log(lines.join("\n"));
  }

  // === CANCEL GATE: post-analysis ===
  if (await checkCancelled(ctx, runId, "post_analysis")) return cancelledResult(runId, "post_analysis");

  // --- Step 3: Load all analysis results for merge ---
  // Paginated: result_json holds full chunk analysis text (~3-6KB/row)
  const allAnalysis: Array<{ chunk_index: number; result_json: any }> = [];
  let analysisOffset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT chunk_index, result_json FROM pipeline_analysis
       WHERE run_id = $1
       ORDER BY chunk_index
       LIMIT ${ANALYSIS_PAGE_SIZE} OFFSET ${analysisOffset}`,
      z.object({ chunk_index: z.coerce.number(), result_json: z.any() }),
      [runId],
      { label: `Load analysis for merge (offset ${analysisOffset})` }
    );
    allAnalysis.push(...page);
    if (page.length < ANALYSIS_PAGE_SIZE) break;
    analysisOffset += ANALYSIS_PAGE_SIZE;
  }

  interface AnalysisNode {
    label: string;
    extraction: string;
    chunkIndex: number;
  }

  const analysisResults: AnalysisNode[] = allAnalysis.map(row => {
    const r = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return { label: String(r.label), extraction: String(r.extraction), chunkIndex: row.chunk_index };
  });

  if (analysisResults.length === 0) {
    const errMsg = firstError ?? "All chunks failed or no analysis results produced";
    await markRunFailed(ctx.integrations.db, runId!, errMsg, "analysis", dealId, moduleId);
    return {
      status: "failed",
      runId: runId!,
      phase: "analysis",
      progress: { analysisTotal: routed.length, analysisCompleted: 0, mergeRound: 0, mergeTotal: 0 },
      result: null,
      failedChunks,
      firstError: errMsg,
    };
  }

  // --- Step 4: Tree-reduce merge (with checkpointing) ---
  interface MergeNode {
    text: string;
    executiveHeader: string;
    findings: MergedFinding[];
    housekeepingFindings?: MergedFinding[];
    truncated?: boolean; // true when stop_reason was "max_tokens" — findings may be thin
  }

  // Load existing merge checkpoints (paginated).
  // CRITICAL: Strip `text` field from merged_json using `- 'text'` to prevent
  // the final-round node (which accumulates ALL findings → can be >4MB) from
  // breaching the gRPC 4MB response limit. `text` is reconstructable from
  // findings via buildMergedText() and is only needed for the final output.
  const mergeCheckpoints: Array<{ tree_level: number; node_index: number; merged_json: any; prompt_version?: string; status?: string }> = [];
  let mcOffset = 0;
  while (true) {
    const page = await ctx.integrations.db.query(
      `SELECT tree_level, node_index, (merged_json - 'text') AS merged_json, prompt_version, COALESCE(status, 'complete') AS status
       FROM merge_checkpoints
       WHERE module_run_id = $1
       ORDER BY tree_level, node_index
       LIMIT ${MERGE_CP_PAGE_SIZE} OFFSET ${mcOffset}`,
      z.object({ tree_level: z.coerce.number(), node_index: z.coerce.number(), merged_json: z.any(), prompt_version: z.string().nullable().optional(), status: z.string().optional() }),
      [runId],
      { label: `Load merge checkpoints (offset ${mcOffset})` }
    );
    mergeCheckpoints.push(...page);
    if (page.length < MERGE_CP_PAGE_SIZE) break;
    mcOffset += MERGE_CP_PAGE_SIZE;
  }

  // RC9: Stale checkpoint detection — warn if checkpoints were written by a different pipeline version
  if (mergeCheckpoints.length > 0) {
    const currentVersion = getPipelineVersion();
    const staleCount = mergeCheckpoints.filter(cp => cp.prompt_version && cp.prompt_version !== currentVersion).length;
    if (staleCount > 0) {
      console.warn(
        `[pipeline:RC9] ${staleCount}/${mergeCheckpoints.length} merge checkpoints written by a prior pipeline version ` +
        `(current=${currentVersion}). Results from stale checkpoints may not reflect latest prompt improvements. ` +
        `Consider starting a fresh run for full fidelity.`
      );
    }
  }

  const checkpointMap = new Map<string, MergeNode>();
  // Tracks persisted failure count per group — stored inside the error checkpoint JSON
  // itself (not row count, since ON CONFLICT DO UPDATE means only 1 row exists per group).
  const errorCountMap = new Map<string, number>();
  const errorMessageMap = new Map<string, string>(); // Preserves last error for diagnostics
  // Tracks truncation retries for partial checkpoints — prevents livelock when
  // round 2+ inputs exceed max_tokens and ALWAYS produce truncated responses.
  const truncationCountMap = new Map<string, number>();
  for (const cp of mergeCheckpoints) {
    const data = typeof cp.merged_json === "string" ? JSON.parse(cp.merged_json) : cp.merged_json;
    const cpKey = `${cp.tree_level}:${cp.node_index}`;

    // Skip manifest entries (node_index = -1, used for round-level state)
    if (cp.node_index < 0) continue;

    // RC12: Use checkpoint state machine for reuse validation
    const cpStatus = parseCheckpointStatus(cp.status);
    if (data.error || cpStatus === "failed_retryable") {
      const count = typeof data.failureCount === "number" ? data.failureCount : 1;
      errorCountMap.set(cpKey, count);
      errorMessageMap.set(cpKey, String(data.error ?? "unknown error"));
      continue;
    }

    const validation = validateCheckpoint({
      status: cpStatus,
      promptVersion: cp.prompt_version ?? null,
      currentPromptVersion: currentVersion,
      truncated: data.truncated === true,
    });

    if (!validation.reusable) {
      // FIX: Partial checkpoints that have been retried MAX_PARTIAL_RETRIES times
      // should be accepted as-is. The findings are preserved (Fix 16 ensures no
      // data loss via carry-forward), only the narrative text may be incomplete.
      // Without this, truncated responses at higher merge rounds cause infinite
      // livelock: partial → retry → truncate again → partial → retry → ...
      if (cpStatus === "partial" && data.truncated) {
        const truncCount = typeof data.truncation_count === "number" ? data.truncation_count : 1;
        truncationCountMap.set(cpKey, truncCount);

        if (truncCount >= MAX_PARTIAL_RETRIES) {
          // Accept partial checkpoint — findings are intact, narrative may be cut short
          console.log(
            `[pipeline:RC12] Accepting partial checkpoint ${cpKey} after ${truncCount} truncation(s) ` +
            `(MAX_PARTIAL_RETRIES=${MAX_PARTIAL_RETRIES}). Findings count: ${(data.findings ?? []).length}`
          );
          const findings = (data.findings ?? []) as MergedFinding[];
          const executiveHeader = String(data.executiveHeader ?? "");
          checkpointMap.set(cpKey, {
            text: data.text ? String(data.text) : buildMergedText(executiveHeader, findings),
            executiveHeader,
            findings,
            truncated: true,
          });
          continue;
        }
      }

      // Partial or invalid checkpoint — treat as needing retry
      if (validation.suggestedAction === "retry") {
        console.log(`[pipeline:RC12] Checkpoint ${cpKey} not reusable: ${validation.reason} — will retry (truncation_count=${truncationCountMap.get(cpKey) ?? 0}/${MAX_PARTIAL_RETRIES})`);
        continue; // Skip this checkpoint, group will be re-merged
      }
      if (validation.suggestedAction === "fail") {
        console.error(`[pipeline:RC12] Checkpoint ${cpKey} terminal failure: ${validation.reason}`);
        errorCountMap.set(cpKey, 999); // Prevent retry
        errorMessageMap.set(cpKey, validation.reason);
        continue;
      }
    }

    // `text` is stripped from the query (gRPC 4MB safety) — reconstruct from findings
    const findings = (data.findings ?? []) as MergedFinding[];
    const executiveHeader = String(data.executiveHeader ?? "");
    checkpointMap.set(cpKey, {
      text: data.text ? String(data.text) : buildMergedText(executiveHeader, findings),
      executiveHeader,
      findings,
      truncated: data.truncated === true,
    });
  }

  // Initialize nodes from analysis results
  let nodes: MergeNode[] = analysisResults.map(a => ({
    text: a.extraction,
    executiveHeader: "",
    findings: [],
  }));

  // RC11: If only one analysis node exists, it IS the final merge result — skip merge entirely
  // (Previously duplicated the node which caused double-counting in findings)
  if (nodes.length === 1) {
    const soleNode = nodes[0];
    // Skip the merge loop — this node is the root
    const finalNode = soleNode;
    console.log(`[pipeline] Single analysis node — skipping merge, proceeding to format`);
    // Jump to step 5 using this as finalNode
    // We set nodes = [soleNode] and let the while(nodes.length > 1) condition skip naturally
  }

  const totalMergeRounds = Math.ceil(Math.log(Math.max(nodes.length, 2)) / Math.log(MERGE_GROUP_SIZE));
  let currentRound = 0;

  // Findings accumulator — collects all findings across all rounds.
  // This is the safety net: even if higher rounds fail to re-extract findings,
  // we have the full set from intermediate rounds to fall back on.
  let accumulatedFindings: MergedFinding[] = [];
  let accumulatedHousekeeping: MergedFinding[] = [];

  // FIX 2: Track round summaries for root-completion manifest
  const mergeRoundSummaries: RoundSummary[] = [];

  // Build numeric block for merge
  // Architecture: figures = trustworthy cell values (flag where narrative disagrees);
  //               discrepancies = cross-agreement only (live vs frozen reference sheet).
  const hasNumericData = !!(numericReport && NUMERIC_MODULES.has(moduleId) &&
    (numericReport.figures.length > 0 || numericReport.discrepancies.length > 0));

  let numericBlock = "";
  if (hasNumericData && numericReport) {
    numericBlock = `\n\n## Numeric Verification Report\n*Source: deterministic cell-value reads from the financial model*\n\n`;

    // Cross-agreement discrepancies — inject ONLY the rolled-up per-period summary.
    // Each discrepancy.description contains the headline + material-tier lines (bounded).
    // The full detail (all 90+ metrics) is stored in .metrics[] for the tiered report UI
    // but NOT dumped into the merge prompt (would bloat it and cause line-item contradictions).
    if (numericReport.discrepancies.length > 0) {
      numericBlock += `### Cross-Version Divergences\n`;
      numericBlock += `*These are differences between the live model and a frozen reference. Confirm whether each reflects an intentional update or a stale/contradictory reference.*\n\n`;
      for (const d of numericReport.discrepancies) {
        const disc = d as Record<string, unknown>;
        // Prefer the headline (compact one-liner) when available; fall back to description
        const headline = disc.headline as string | undefined;
        if (headline) {
          numericBlock += `**${String(disc.period ?? "Unknown")}:** ${headline}\n\n`;
        }
        // Material movements summary (already bounded to tier-2 lines in description)
        numericBlock += `${String(disc.description)}\n\n`;
      }
    }

    // Verified figures — trustworthy values for narrative comparison
    if (numericReport.figures.length > 0) {
      numericBlock += `### Verified Figures (Trustworthy Cell Values)\n`;
      numericBlock += `*Flag where narrative claims disagree with these code-read values.*\n\n`;
      const MAX_FIG_DISPLAY = 200;
      const figuresArr = numericReport.figures as Array<Record<string, unknown>>;
      if (figuresArr.length > MAX_FIG_DISPLAY) {
        console.warn(`[pipeline-core] numeric figures capped at ${MAX_FIG_DISPLAY} (had ${figuresArr.length})`);
      }
      for (const fig of figuresArr.slice(0, MAX_FIG_DISPLAY)) {
        numericBlock += `- **${String(fig.name)}** (${String(fig.period ?? "")}): ${fig.value} @ ${String(fig.source_cell)}\n`;
      }
    }
  }

  // Prepare base merge prompt (numeric blocks are static, findings rule varies per round)
  let baseMergePrompt = rawMergePrompt;
  if (hasNumericData) {
    const numericVerifInst = `## NUMERIC VERIFICATION — TRUSTWORTHY VALUES

A "## Numeric Verification Report" section appears in the input below. It contains cell values read directly from the financial model by code — NOT by AI inference. You MUST:
- Treat every "Verified Figure" as a trustworthy cell value from the model
- Flag where NARRATIVE claims (from CIM, IC memo, management presentations) disagree with these values — that is a potential contradiction ONLY IF same metric + same scope + same period
- "Cross-Version Divergences" compare the live model to a frozen reference; frame these as "confirm intentional revision vs stale reference," not as asserted errors
- Never invent or re-derive figures — only cite values that appear in the Verified Figures list
- Do NOT treat absence from the list as evidence of a problem — the list covers configured metrics only
- SCOPE RULE: A narrative figure (e.g., "Total Revenue (PF) £194m") contradicts a model figure ONLY if the scope qualifiers match exactly. "Total Revenue (PF)" and "Total revenue (excl. future M&A)" are DIFFERENT metrics — flag as a hedged scope-mismatch note, not a contradiction${numericPartial ? `

⚠️ PARTIAL COVERAGE: The engine ran out of time before processing all tables. Verified Figures are correct for what was analyzed, but coverage is incomplete.` : ""}`;
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", numericVerifInst);
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}",
      "**Cross-Version Divergences First**: If the Numeric Verification Report contains cross-version divergences, assess each cluster and report as findings where they indicate stale references or contradictions (not merely intentional updates).\n");
  } else {
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_VERIFICATION_BLOCK}}", "");
    baseMergePrompt = baseMergePrompt.replace("{{NUMERIC_TASK_STEP_1}}", "");
  }

  // Inject authoritative filename→tag reference so the model uses real tags
  // rather than guessing from filenames when classifying gap_type and evidence_docs.
  // This is appended to the system prompt for all merge rounds.
  const tagMapLines = Array.from(fileTagMap.entries())
    .map(([fn, tag]) => `  "${fn}" → ${tag}`)
    .join("\n");
  const tagMapBlock = tagMapLines.length > 0
    ? `\n\n## Document Tag Reference (authoritative — do NOT infer tags from filenames)\n\n${tagMapLines}\n\nUse these tags to classify evidence_docs accurately. A document is an IC memo ONLY if its tag is "ic_memo".`
    : "";
  baseMergePrompt += tagMapBlock;

  // --- Inject subject identity block: chronologically ordered IC memo record ---
  // FIX 3: Use reconstructed subjectIds (accounts for resume scenarios)
  const subjectDocumentIds: string[] = subjectIds;
  const subjectFiles = subjectDocumentIds
    .map((id) => ({ id, fileName: idToFileName.get(id) ?? id }))
    .map(({ id, fileName }) => {
      const date = parseDateFromFileName(fileName);
      return { id, fileName, date };
    });

  // Sort: undated first (treated as earliest), then by date ascending. LATEST = max dated.
  subjectFiles.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return -1;
    if (!b.date) return 1;
    return a.date.localeCompare(b.date);
  });

  const subjectIdentityBlock = subjectFiles.length > 0
    ? `\n\n## Subject Under Review — The IC Memo Record

The following document(s) collectively constitute the IC memo record under review, listed chronologically (earliest to latest):

${subjectFiles.map((f, i) => `  ${i + 1}. "${f.fileName}"${f.date ? ` (date: ${f.date})` : " (undated \u2014 treated as earliest)"}`).join("\n")}

The LATEST memo is authoritative for the team's CURRENT claims and thesis. Earlier memos establish what was previously disclosed, asserted, or committed to.`
    : "";
  baseMergePrompt += subjectIdentityBlock;

  // Hierarchical merge loop — collapses N nodes → 1 across multiple rounds.
  // STALENESS SAFETY: triggered_at is refreshed after each batch (see line below
  // "Refresh triggered_at (merge batch heartbeat)"). Under STALENESS_THRESHOLD_MINUTES=12
  // and a 600s cap, the worst-case inter-heartbeat gap is ~1 merge batch (~30-60s),
  // well within the 12-minute threshold. If the cap is raised further, the per-batch
  // heartbeat still fires often enough — unless a single merge call exceeds 12 min,
  // which would require re-visiting the threshold derivation.
  while (nodes.length > 1) {
    currentRound++;

    // === CANCEL GATE: between merge rounds ===
    if (await checkCancelled(ctx, runId, "merge_round")) return cancelledResult(runId, "merge_round");

    // Batch-aware graceful exit: use the real platform clock, not TIME_BUDGET.
    // Merge: timeoutCap varies by round. Worst case = 1× timeoutCap + checkpoint reserve.
    // FE4's HeadroomExhaustedError gates retries dynamically — no need to pre-provision 2×.
    const roundTimeoutCap = currentRound >= 2 ? 180_000 : 165_000;
    const mergeBatchWorstCase = roundTimeoutCap + CHECKPOINT_RESERVE_MS;
    const platformDeadlineMergeRound = EFFECTIVE_CAP_MS - (Date.now() - startTime);
    if (platformDeadlineMergeRound < mergeBatchWorstCase) {
      console.log(`[pipeline:graceful-exit] Merge between-rounds — platformDeadline=${Math.round(platformDeadlineMergeRound / 1000)}s < batchWorstCase=${Math.round(mergeBatchWorstCase / 1000)}s (R${currentRound}, cap=${roundTimeoutCap / 1000}s) — returning in_progress`);
      return returnInProgress("merge", currentRound - 1, 0, 0);
    }

    const groups: Array<{ idx: number; members: MergeNode[] }> = [];
    for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
      groups.push({ idx: g, members: nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE) });
    }

    // Determine if this is the final round (will produce 1 node)
    const isFinalRound = groups.length === 1 || currentRound === totalMergeRounds;
    const findingsRule = isFinalRound ? FINDINGS_RULE_FINAL : FINDINGS_RULE_INTERMEDIATE;
    const mergePrompt = baseMergePrompt.replace("{{FINDINGS_REQUIREMENT}}", findingsRule);

    const nextNodes: MergeNode[] = new Array(groups.length);
    const totalGroupsThisRound = groups.length;
    let groupsDone = 0;
    let mergeFailedGroups = 0;
    let mergeFirstError: string | null = null;

    // Separate trivial groups (single member or already checkpointed) from groups needing AI merge
    const pendingGroups: Array<{ idx: number; members: MergeNode[] }> = [];
    for (const group of groups) {
      if (group.members.length === 1) {
        // Singleton carry-forward: persist checkpoint so resume can reconstruct this level
        const singletonNode = group.members[0];
        nextNodes[group.idx] = singletonNode;
        groupsDone++;
        const singletonCpKey = `${currentRound}:${group.idx}`;
        if (!checkpointMap.has(singletonCpKey)) {
          // Persist singleton as a pass-through checkpoint (idempotent via ON CONFLICT)
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
             VALUES ($1, $2, $3, $4::jsonb, 'singleton_carry', $5, 'complete')
             ON CONFLICT (module_run_id, tree_level, node_index) DO NOTHING`,
            [runId, currentRound, group.idx, JSON.stringify({ text: singletonNode.text?.slice(0, 500_000), executiveHeader: singletonNode.executiveHeader, findings: singletonNode.findings, housekeepingFindings: singletonNode.housekeepingFindings, singletonCarry: true }), currentVersion],
            { label: `Persist singleton carry R${currentRound}:G${group.idx}` }
          );
          checkpointMap.set(singletonCpKey, singletonNode);
        }
        continue;
      }
      const cpKey = `${currentRound}:${group.idx}`;
      if (checkpointMap.has(cpKey)) {
        nextNodes[group.idx] = checkpointMap.get(cpKey)!;
        groupsDone++;
        continue;
      }
      // Skip groups that have failed too many times — use fallback immediately
      const priorFailures = errorCountMap.get(cpKey) ?? 0;
      if (priorFailures >= MAX_MERGE_GROUP_FAILURES) {
        const lastError = errorMessageMap.get(cpKey) ?? "unknown";
        console.warn(`[pipeline] Skipping group R${currentRound}:G${group.idx} — ${priorFailures} prior failures (last: ${lastError.slice(0, 120)}), using fallback`);
        mergeGroupsFallenBack++;
        const memberFindings = group.members.flatMap(m => m.findings ?? []);
        accumulatedFindings.push(...memberFindings);
        const fallback: MergeNode = { text: group.members[0].text, executiveHeader: "Merge skipped (repeated failures)", findings: memberFindings };
        nextNodes[group.idx] = fallback;
        groupsDone++;
        // Save a non-error checkpoint so the group is permanently resolved
        await ctx.integrations.db.execute(
          `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'complete')
           ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6, status = 'complete'`,
          [runId, currentRound, group.idx, JSON.stringify({ text: fallback.text, executiveHeader: fallback.executiveHeader, findings: fallback.findings, skippedAfterFailures: priorFailures, lastError }), getModuleModel(moduleId, useOpus), currentVersion],
          { label: `Save fallback checkpoint R${currentRound}:G${group.idx} (skipped after ${priorFailures} failures)` }
        );
        continue;
      }
      pendingGroups.push(group);
    }

    // Process pending groups in batches (parallel within batch, sequential across batches)
    for (let bStart = 0; bStart < pendingGroups.length; ) {
      // Batch-aware graceful exit: real platform clock against worst-case batch duration
      const platformDeadlineMergeBatch = EFFECTIVE_CAP_MS - (Date.now() - startTime);
      if (platformDeadlineMergeBatch < mergeBatchWorstCase) {
        console.log(`[pipeline:graceful-exit] Merge between-batches — platformDeadline=${Math.round(platformDeadlineMergeBatch / 1000)}s < batchWorstCase=${Math.round(mergeBatchWorstCase / 1000)}s (R${currentRound}, done=${groupsDone}/${totalGroupsThisRound}) — returning in_progress`);
        return returnInProgress("merge", currentRound - 1, groupsDone, totalGroupsThisRound);
      }

      const batchSize = platformDeadlineMergeBatch < 90_000 ? Math.min(3, MERGE_CONCURRENCY) : MERGE_CONCURRENCY;
      const batch = pendingGroups.slice(bStart, bStart + batchSize);
      bStart += batchSize;

      const results = await Promise.allSettled(
        batch.map(async (group) => {
          // Build structured findings block so the model can reference input finding_ids
          const inputFindingIds: string[] = [];
          const structuredFindingsBlocks = group.members.map((m, i) => {
            if (!m.findings || m.findings.length === 0) return "";
            const ids = m.findings.map(f => f.finding_id).filter(Boolean);
            inputFindingIds.push(...ids);
            const compact = m.findings.map(f => ({
              finding_id: f.finding_id,
              severity: f.severity,
              title: f.title,
              issue_key: (f as any).issue_key,
              claim_ids: f.claim_ids,
            }));
            return `\n\n### Structured Findings from Set ${i + 1} (reference by finding_id in merged_from_finding_ids)\n\`\`\`json\n${JSON.stringify(compact)}\n\`\`\``;
          }).join("");

          const setBlocks = group.members.map((m, i) => `## Analysis Set ${i + 1}\n\n${truncateMergeNodeText(m.text, MERGE_NODE_TEXT_CAP)}`);
          const mergeInput = setBlocks.join("\n\n---\n\n") + structuredFindingsBlocks + numericBlock + coverageMapBlock + dealProcessContextBlock;

          // Dynamic timeout: later rounds have much larger payloads and need more time.
          // Round 0-1: cap at 165s (raised from 120s — Freeze Exception #3, prompt growth).
          // Round 2+: cap at 180s (final merge can be very large).
          // Merge calls run in parallel within a batch (MERGE_CONCURRENCY=5),
          // so a batch takes ~maxTimeout wall-clock, not N×maxTimeout.
          const timeoutCap = currentRound >= 2 ? 180_000 : 165_000;
          const perCallTimeout = Math.min(timeoutCap, Math.max(30_000, timeRemaining() - 30_000));
          console.log(`[pipeline:merge] R${currentRound}:G${group.idx + 1}/${totalGroupsThisRound} — timeout=${Math.round(perCallTimeout / 1000)}s, budget=${Math.round(timeRemaining() / 1000)}s, inputLen=${setBlocks.join("").length}`);
          const mergeResult = await callAnthropic(
            ctx,
            {
              model: getModuleModel(moduleId, useOpus),
              max_tokens: MERGE_MAX_TOKENS,
              system: [{ type: "text", text: mergePrompt, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: mergeInput }],
            },
            `Merge R${currentRound} G${group.idx + 1}/${totalGroupsThisRound}`,
            2, // 2 attempts, 1 retry
            perCallTimeout,
            startTime
          );

          const mergeText = mergeResult.content.find((c: { type: string }) => c.type === "text")?.text ?? "";
          const truncated = mergeResult.stop_reason === "max_tokens";
          const executiveHeader = extractTag(mergeText, "executive_header") || "Analysis complete.";
          const findingsRaw = extractTag(mergeText, "findings_json");

          let findings: MergedFinding[] = [];
          if (findingsRaw) {
            try {
              const parsed = JSON.parse(findingsRaw);
              // RC1: use canonical parser — preserves ALL fields including finding_kind,
              // severity_anchor, issue_key, structured_impact that the old .map() dropped.
              const parseResult = parseCanonicalFindings(parsed, {
                mode: "fresh",
                source: `merge R${currentRound}:G${group.idx} findings_json`,
                truncated,
              });
              findings = parseResult.findings;
              if (parseResult.malformed_count > 0) {
                console.warn(`[Merge][canonical-parser] ${parseResult.malformed_count} malformed findings at R${currentRound}:G${group.idx}`);
              }
              if (parseResult.invalid.length > 0) {
                console.warn(`[Merge][canonical-parser] ${parseResult.invalid.length} findings with field issues: ${parseResult.invalid.map(x => x.issues.join("; ")).join(" | ")}`);
              }
    } catch { /* parse failure — use empty findings */ }
          }

          // Fix #3: Code-derived source_docs from claim_id provenance.
          // Uses the explicit ClaimOriginMap for deterministic resolution.
          // UNION with existing source_docs — never overwrite or narrow.
          // Legacy IDs that cannot be resolved receive no fabricated provenance.
          for (const f of findings) {
            if (!f.claim_ids || f.claim_ids.length === 0) continue;
            const resolution = resolveProvenance(f.claim_ids, claimOriginMap);
            if (resolution.derivedSources.size > 0) {
              const existingSources = new Set(f.source_docs ?? []);
              for (const src of resolution.derivedSources) existingSources.add(src);
              const merged = Array.from(existingSources);
              const original = f.source_docs?.join(", ") ?? "(none)";
              (f as any).source_docs = merged;
              if (original !== merged.join(", ")) {
                console.log(`[Merge][Provenance] "${f.title}" source_docs updated: ${original} → ${merged.join(", ")}`);
              }
            }
            if (resolution.unresolvedLegacy.length > 0) {
              console.warn(`[Merge][Provenance] "${f.title}" has ${resolution.unresolvedLegacy.length} unresolved legacy claim ID(s): ${resolution.unresolvedLegacy.join(", ")} — no fabricated provenance applied`);
            }
          }

          // CODE BACKSTOP: absence-verification gate — any finding asserting
          // something is missing/absent/not-confirmed must carry verified absence
          // confidence or be capped at info. Gates on claim shape, not gap_type alone.
          const ABSENCE_PATTERNS = /\b(does not confirm|does not disclose|absent|not disclosed|missing|no mention|fails to address|not addressed|not confirmed|no evidence of|no reference to|omits?|silent on|does not discuss|not discussed)\b/i;

          // Fix #2 (tightened): Data-divergence findings are exempt from the absence cap.
          // Exemption requires EITHER:
          //   (a) finding_kind === "data_divergence" (LLM-tagged at source), OR
          //   (b) severity_anchor carries a delta signature: two currency values,
          //       a signed delta (−£1.8m), or comparison words (vs/differs/higher/lower).
          // A bare "£5.3m" does NOT qualify — it must show a comparison.
          const DELTA_SIGNATURE_PATTERN = /([£$€][\d.,]+[kmbn]*\s*(vs|versus|\/|→|to)\s*[£$€][\d.,]+|[−\-–][£$€]\s*[\d.,]+|[£$€]\s*[−\-–]\s*[\d.,]+|\b(differs? by|lower than|higher than|exceeds.*by|shortfall of|gap of|delta of|revision of|decline of|increase of)\b.*[£$€])/i;

          for (const f of findings) {
            // Exemption: data_divergence finding_kind OR delta signature in anchor
            const isDataDivergence = (f as any).finding_kind === "data_divergence";
            const hasDeltaSignature = typeof (f as any).severity_anchor === "string" &&
              DELTA_SIGNATURE_PATTERN.test((f as any).severity_anchor);
            if (isDataDivergence || hasDeltaSignature) continue;

            // Original gap_type gate (backward compat)
            const hasAbsenceGapType = f.gap_type === "memo_omission" || f.gap_type === "open_item_acknowledged";
            // Broadened: claim-shape detection on any module's findings
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

          // Parse housekeeping appendix (demoted findings — Fix 4/6)
          const housekeepingRaw = extractTag(mergeText, "housekeeping_appendix");
          let housekeepingFindings: MergedFinding[] = [];
          if (housekeepingRaw) {
            try {
              const parsed = JSON.parse(housekeepingRaw);
              // RC1: canonical parser for housekeeping — same full schema, all fields preserved
              const hkParseResult = parseCanonicalFindings(parsed, {
                mode: "fresh",
                source: `merge R${currentRound}:G${group.idx} housekeeping_appendix`,
                truncated,
              });
              // Ensure all housekeeping findings have category set
              housekeepingFindings = hkParseResult.findings.map(f =>
                f.category ? f : { ...f, category: "housekeeping" as const }
              );
            } catch { /* non-fatal */ }
          }

          // Fix #3: Provenance for housekeeping findings (same origin-map approach)
          for (const f of housekeepingFindings) {
            const hkClaimIds = (f as any).claim_ids as string[] | undefined;
            if (!hkClaimIds || hkClaimIds.length === 0) continue;
            const resolution = resolveProvenance(hkClaimIds, claimOriginMap);
            if (resolution.derivedSources.size > 0) {
              const existingSources = new Set((f as any).source_docs ?? []);
              for (const src of resolution.derivedSources) existingSources.add(src);
              (f as any).source_docs = Array.from(existingSources);
            }
          }

          // --- Observability: Fix 2 (scope-mismatch) + Fix 3 (severity anchors) ---
          // (placed after housekeeping parse so allMergeFindings includes both sets)
          const allMergeFindings = [...findings, ...housekeepingFindings];
          const scopeMismatches = allMergeFindings.filter(f =>
            f.full_analysis?.includes("[SCOPE_MISMATCH]")
          );
          if (scopeMismatches.length > 0) {
            console.log(`[Merge][Fix2] Scope-qualifier mismatches downgraded (${scopeMismatches.length}):`);
            for (const sm of scopeMismatches) {
              console.log(`  → "${sm.title}" | severity=${sm.severity} | ${sm.detail?.slice(0, 120)}`);
            }
          }
          for (const f of allMergeFindings) {
            if ((f as any).severity_anchor) {
              console.log(`[Merge][Fix3] severity_anchor | "${f.title}" [${f.severity}]: ${(f as any).severity_anchor}`);
            }
          }
          // --- End observability ---

          // OA-02: Merge contract enforcement (omission_audit only)
          if (moduleId === "omission_audit" && findings.length > 0) {
            const inputFindingsForContract = group.members.flatMap(m => m.findings ?? []);
            if (inputFindingsForContract.length > 0) {
              const contractResult = validateMergeContract(inputFindingsForContract, findings);
              if (!contractResult.valid) {
                console.warn(`[pipeline][OA-02] Merge contract REJECTED at R${currentRound}:G${group.idx}: ${contractResult.violationCodes.join(",")}. Preserving ${inputFindingsForContract.length} input findings.`);
                findings = contractResult.acceptedFindings as MergedFinding[];
              } else {
                console.log(`[pipeline][OA-02] Merge contract passed for R${currentRound}:G${group.idx} (${findings.length} findings).`);
              }
            }
          }

          // Fallback: if findings are empty (model failed to extract), union input
          // members' findings — degrades to unconsolidated duplicates rather than
          // erasing everything below this node in the tree
          if (findings.length === 0) {
            findings = group.members.flatMap(m => m.findings ?? []);
          }

          // Fix 16: Zero-tolerance merge accounting — every input finding ID must be
          // accounted for by exactly one of: (1) retained as output finding_id,
          // (2) referenced in output merged_from_finding_ids, (3) carried forward with
          // failure metadata. Zero unaccounted findings are permitted.
          if (inputFindingIds.length > 0) {
            const outputFindingIds = new Set(
              [...findings, ...housekeepingFindings].flatMap(f => {
                const fAny = f as any;
                const ids: string[] = [];
                if (fAny.finding_id) ids.push(fAny.finding_id);
                if (Array.isArray(fAny.merged_from_finding_ids)) ids.push(...fAny.merged_from_finding_ids);
                return ids;
              })
            );
            const missingIds = inputFindingIds.filter(id => !outputFindingIds.has(id));
            if (missingIds.length > 0) {
              const reason = truncated
                ? "response truncated"
                : `model omitted ${missingIds.length}/${inputFindingIds.length} input findings without provenance`;

              console.warn(
                `[Merge][Fix16] Zero-tolerance accounting failure: ${missingIds.length} unaccounted input(s) in R${currentRound}:G${group.idx} (${reason})`
              );

              // Always carry forward — no tolerance for unaccounted findings
              const allInputFindings = group.members.flatMap(m => m.findings ?? []);
              const missingSet = new Set(missingIds);
              const carriedForward = allInputFindings.filter(f => missingSet.has(f.finding_id));

              // Tag carried-forward findings with accounting metadata
              for (const cf of carriedForward) {
                (cf as any)._merge_accounting = {
                  status: "carried_forward",
                  reason,
                  round: currentRound,
                  group_idx: group.idx,
                  timestamp: new Date().toISOString(),
                };
              }

              findings.push(...carriedForward);
              console.log(`[Merge][Fix16] Carried forward ${carriedForward.length} unaccounted findings with failure metadata`);
            }
          }

          // Accumulate findings across all rounds so we never lose data
          accumulatedFindings.push(...findings);
          if (housekeepingFindings.length > 0) accumulatedHousekeeping.push(...housekeepingFindings);

          const mergedTextForNode = buildMergedText(executiveHeader, findings);
          const node: MergeNode = { text: mergedTextForNode, executiveHeader, findings, housekeepingFindings: housekeepingFindings.length > 0 ? housekeepingFindings : undefined, truncated };

          return { group, node };
        })
      );

      // Process results: checkpoint successes, track failures
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const group = batch[i];

        if (result.status === "fulfilled") {
          const { node } = result.value;
          nextNodes[group.idx] = node;
          if (node.truncated) truncatedMerges++;
          groupsDone++;

          // Save merge checkpoint
          // Cap `text` in checkpoint to prevent single-row gRPC breach (4MB limit).
          // `text` is reconstructable from findings via buildMergedText() on read-back.
          const MAX_CHECKPOINT_TEXT = 500_000; // ~500KB text cap
          const cpText = node.text.length > MAX_CHECKPOINT_TEXT
            ? node.text.slice(0, MAX_CHECKPOINT_TEXT) + "\n[…checkpoint text truncated]"
            : node.text;
          // RC11: Truncated responses are marked 'partial' — they should not be treated
          // as authoritative in recovery/export paths without re-merge
          const cpStatus = node.truncated ? "partial" : "complete";
          // Track truncation count: increment if this group was previously truncated too
          const successCpKey = `${currentRound}:${group.idx}`;
          const priorTruncCount = truncationCountMap.get(successCpKey) ?? 0;
          const newTruncCount = node.truncated ? priorTruncCount + 1 : 0;
          if (node.truncated) {
            truncationCountMap.set(successCpKey, newTruncCount);
          }

          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6, status = $7
               WHERE merge_checkpoints.status <> 'complete'`,
            [runId, currentRound, group.idx, JSON.stringify({
              text: cpText,
              executiveHeader: node.executiveHeader,
              findings: node.findings,
              housekeepingFindings: node.housekeepingFindings,
              truncated: node.truncated ?? false,
              // Livelock prevention: persist truncation count so resume knows when to accept partial
              truncation_count: node.truncated ? newTruncCount : undefined,
              // Fix 16: Persist accounting metadata for resume/recovery verification
              _accounting: {
                inputFindingCount: group.members.reduce((sum, m) => sum + (m.findings?.length ?? 0), 0),
                outputFindingCount: node.findings.length,
                carriedForwardCount: node.findings.filter((f: any) => f._merge_accounting?.status === "carried_forward").length,
              },
            }), getModuleModel(moduleId, useOpus), currentVersion, cpStatus],
            { label: `Save merge checkpoint R${currentRound}:G${group.idx} (status=${cpStatus})` }
          );
        } else {
          // Merge call failed — use a placeholder so the tree can still reduce
          mergeFailedGroups++;
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.warn(`[pipeline:merge] Group R${currentRound}:G${group.idx} failed: ${errMsg.slice(0, 200)}`);
          if (!mergeFirstError) {
            mergeFirstError = errMsg;
          }
          // Use first member's text as fallback so tree reduction can continue
          // Preserve input members' findings so they aren't lost
          const memberFindings = group.members.flatMap(m => m.findings ?? []);
          accumulatedFindings.push(...memberFindings);
          const fallback: MergeNode = { text: group.members[0].text, executiveHeader: "Merge failed", findings: memberFindings };
          nextNodes[group.idx] = fallback;
          groupsDone++;

          // Save error checkpoint with incremented failureCount.
          // ON CONFLICT DO UPDATE overwrites the single row — failureCount inside the JSON
          // is the durable cross-invocation counter (not row count).
          const errCpKey = `${currentRound}:${group.idx}`;
          const prevFailures = errorCountMap.get(errCpKey) ?? 0;
          const newFailureCount = prevFailures + 1;
          errorCountMap.set(errCpKey, newFailureCount); // update in-memory for same-invocation re-encounters
          errorMessageMap.set(errCpKey, errMsg); // preserve latest error message
          await ctx.integrations.db.execute(
            `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'error')
             ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $4::jsonb, model_used = $5, prompt_version = $6, status = 'error'
               WHERE merge_checkpoints.status <> 'complete'`,
            [runId, currentRound, group.idx, JSON.stringify({ error: errMsg, failureCount: newFailureCount, timestamp: new Date().toISOString() }), getModuleModel(moduleId, useOpus), currentVersion],
            { label: `Save merge error checkpoint R${currentRound}:G${group.idx} (failure #${newFailureCount})` }
          );
        }
      }

      // Refresh heartbeat after each batch
      await ctx.integrations.db.execute(
        `UPDATE module_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
        { label: "Refresh triggered_at (merge batch heartbeat)" }
      );
    }

    // Track merge failures in overall counters
    failedChunks += mergeFailedGroups;
    if (!firstError && mergeFirstError) firstError = mergeFirstError;

    // FIX 2: Record round summary for root-completion manifest
    mergeRoundSummaries.push({
      round: currentRound,
      inputNodes: nodes.length,
      outputNodes: groups.length,
      singletonCarries: groups.filter(g => g.members.length === 1).length,
      failedGroups: mergeFailedGroups,
    });

    // Persist merge-round manifest: records expected vs actual state for this round
    // so that resume/recovery can verify completeness without "highest node_index=0" heuristics
    const roundManifest = {
      round: currentRound,
      totalRounds: totalMergeRounds,
      inputNodeCount: nodes.length,
      groupCount: groups.length,
      completedGroups: groupsDone,
      failedGroups: mergeFailedGroups,
      singletonCarries: groups.filter(g => g.members.length === 1).length,
      expectedNextLevelCount: groups.length,
      isFinalRound,
      roundStatus: mergeFailedGroups === 0 ? "complete" : "complete_with_failures",
      finalRootId: isFinalRound && groups.length === 1 ? `${currentRound}:0` : null,
      timestamp: new Date().toISOString(),
    };
    await ctx.integrations.db.execute(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
       VALUES ($1, $2, -1, $3::jsonb, 'manifest', $4, 'manifest')
       ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $3::jsonb, prompt_version = $4, status = 'manifest'`,
      [runId, currentRound, JSON.stringify(roundManifest), currentVersion],
      { label: `Save merge-round manifest R${currentRound}` }
    );

    nodes = nextNodes;
  }

  // --- FIX 2: Persist root-completion manifest after merge tree fully reduces ---
  // Only persisted when the tree reduced normally (nodes.length <= 1 after loop).
  // Single-node trees (nodes.length === 1 before loop) get a trivial manifest.
  if (nodes.length === 1 && analysisResults.length > 1) {
    // Build leaf nodes from the analysis results that fed the merge tree
    // Map chunk_index → document_id from the routed array
    const leafNodes = buildLeafNodes(analysisResults.map(a => ({
      documentId: routed[a.chunkIndex]?.document_id ?? `unknown-${a.chunkIndex}`,
      chunkIndex: a.chunkIndex,
      extraction: a.extraction,
    })));
    const extractions = analysisResults.map(a => ({
      documentId: routed[a.chunkIndex]?.document_id ?? `unknown-${a.chunkIndex}`,
      chunkIndex: a.chunkIndex,
    }));

    // Determine completion generation (monotonically increasing per run)
    let completionGeneration = 1;
    try {
      const [genRow] = await ctx.integrations.db.query(
        `SELECT MAX((merged_json->>'completionGeneration')::int) AS gen
         FROM merge_checkpoints
         WHERE module_run_id = $1 AND node_index = -2 AND status = 'root_manifest'`,
        z.object({ gen: z.coerce.number().nullable() }),
        [runId],
        { label: "Load max completionGeneration for root manifest" }
      );
      if (genRow?.gen) completionGeneration = genRow.gen + 1;
    } catch { /* table may not have existing manifests — use 1 */ }

    const rootManifest = buildMergeRootManifest({
      leafNodes,
      extractions,
      rootLevel: currentRound,
      rootNodeIndex: 0,
      completionGeneration,
      roundSummary: mergeRoundSummaries,
    });

    await ctx.integrations.db.execute(
      `INSERT INTO merge_checkpoints (module_run_id, tree_level, node_index, merged_json, model_used, prompt_version, status)
       VALUES ($1, $2, -2, $3::jsonb, 'manifest', $4, 'root_manifest')
       ON CONFLICT (module_run_id, tree_level, node_index) DO UPDATE SET merged_json = $3::jsonb, prompt_version = $4, status = 'root_manifest'`,
      [runId, currentRound, JSON.stringify(rootManifest), currentVersion],
      { label: `Persist root-completion manifest (gen=${completionGeneration}, leaves=${leafNodes.length})` }
    );
    console.log(`[pipeline] Root-completion manifest persisted: ${leafNodes.length} leaves, round=${currentRound}, gen=${completionGeneration}`);
  }

  // --- Step 5: Complete ---
  const finalNode = nodes[0];

  // If the final node lost its findings (common in deep trees where the last
  // merge round produces narrative prose but fails to re-extract structured JSON),
  // fall back to the de-duplicated accumulated set from all rounds.
  let finalFindings: MergedFinding[];
  if (finalNode.findings && finalNode.findings.length > 0) {
    finalFindings = finalNode.findings;
  } else {
    // Dedup accumulatedFindings by normalized title to remove overlapping entries
    // from multiple rounds that the fallback path collected
    const seen = new Set<string>();
    const deduped: MergedFinding[] = [];
    for (const f of accumulatedFindings) {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(f);
    }
    finalFindings = deduped;
  }

  // Housekeeping findings: concatenate LLM output + accumulated (includes reconciliation)
  // then dedup. The old `?? accumulatedHousekeeping` dropped reconciliation housekeeping
  // (scope_mismatch, unreconcilable) whenever the merge LLM returned any housekeeping.
  let finalHousekeepingFindings: MergedFinding[] = [
    ...(finalNode.housekeepingFindings ?? []),
    ...accumulatedHousekeeping,
  ];
  {
    const seen = new Set<string>();
    finalHousekeepingFindings = finalHousekeepingFindings.filter(f => {
      const key = (f.title || "").toLowerCase().trim().replace(/\s+/g, " ");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // --- Post-merge pipeline: shared sequence (suppression → L1 → consolidation → recon → independent → materiality) ---
  // Uses the shared helper so main-path and fast-path execute identical logic in identical order.
  const postMergeMainResult = await runPostMergePipeline({
    findings: finalFindings,
    housekeepingFindings: finalHousekeepingFindings,
    numericReport,
    claimsReconciliation,
    fileTagMap,
    moduleId,
    queryFn: ctx.integrations.db.query.bind(ctx.integrations.db),
    dealId,
    aiFn: ctx.integrations.ai.apiRequest.bind(ctx.integrations.ai),
  });
  finalFindings = postMergeMainResult.findings;
  finalHousekeepingFindings = postMergeMainResult.housekeepingFindings;

  // === CANCEL GATE: pre-absence-verification ===
  if (await checkCancelled(ctx, runId, "pre_absence_verification")) return cancelledResult(runId, "pre_absence_verification");

  // --- Step 5.5: Absence Verification Phase ---
  // For omission_audit / blind_spot_scanner / diligence_completeness, run adversarial
  // verification on any finding with absence_confidence set. Two LLM calls per finding:
  //   Call A: generate alternate search queries
  //   Call B: retrieve evidence and issue REVISED/UPHELD verdict
  // Findings without absence_confidence pass through untouched.
  let verificationPhaseErrored = false;
  if (CHECKLIST_MODULES.has(moduleId)) {
    const verifyBudget = timeRemaining();
    if (verifyBudget >= ABSENCE_VERIFICATION_MIN_BUDGET_MS) {
      console.log(`[pipeline] Running absence verification phase (${Math.round(verifyBudget / 1000)}s budget)`);
      try {
        const verifyResult = await runAbsenceVerificationPhase(
          ctx,
          dealId,
          runId!,
          finalFindings,
          moduleId,
          useOpus,
          subjectIds, // FIX 3: use reconstructed subject IDs, not raw input
          timeRemaining,
          startTime
        );
        finalFindings = verifyResult.findings;
        const revised = verifyResult.verificationLog.filter(v => v.verdict.verdict === "REVISED").length;
        const upheld = verifyResult.verificationLog.filter(v => v.verdict.verdict === "UPHELD").length;
        console.log(`[pipeline] Absence verification: ${revised} revised, ${upheld} upheld, completed=${verifyResult.completed}`);

        // If the phase broke early due to budget, return in_progress so next invocation resumes
        if (!verifyResult.completed) {
          return {
            status: "in_progress",
            runId: runId!,
            phase: "absence_verification",
            progress: {
              analysisTotal: routed.length,
              analysisCompleted: routed.length,
              mergeRound: totalMergeRounds,
              mergeTotal: totalMergeRounds,
            },
            result: null,
            failedChunks,
            truncatedChunks,
            truncatedMerges,
            firstError,
          };
        }
      } catch (verifyErr) {
        const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        console.error(`[pipeline] Absence verification phase failed (non-fatal, findings unchanged): ${msg}`);
        verificationPhaseErrored = true;
      }
    } else {
      console.warn(`[pipeline] Insufficient time for absence verification (${Math.round(verifyBudget / 1000)}s < ${ABSENCE_VERIFICATION_MIN_BUDGET_MS / 1000}s needed) — deferring to next invocation`);
      return {
        status: "in_progress",
        runId: runId!,
        phase: "absence_verification",
        progress: {
          analysisTotal: routed.length,
          analysisCompleted: routed.length,
          mergeRound: totalMergeRounds,
          mergeTotal: totalMergeRounds,
        },
        result: null,
        failedChunks,
        truncatedChunks,
        truncatedMerges,
        firstError,
      };
    }
  }

  // === CANCEL GATE: pre-formatting ===
  if (await checkCancelled(ctx, runId, "pre_formatting")) return cancelledResult(runId, "pre_formatting");

  // --- Step 6: Inline Report Formatting ---
  // Attempt to format the full report server-side so the client doesn't need a separate
  // FormatReport call (which was hitting the 300s platform timeout for large reports).
  // If insufficient time budget remains, return in_progress so the next invocation picks it up.
  let fullReport: string | null = null;
  const formatBudget = timeRemaining();

  if (formatBudget >= FORMAT_REPORT_MIN_BUDGET_MS) {
    console.log(`[pipeline] Formatting report inline (${Math.round(formatBudget / 1000)}s budget)`);
    fullReport = await formatReportInline(ctx, moduleId, finalNode.executiveHeader, finalFindings, formatBudget, startTime, finalHousekeepingFindings, verificationPhaseErrored, mergeGroupsFallenBack);
  } else {
    console.warn(`[pipeline] Insufficient time for inline formatting (${Math.round(formatBudget / 1000)}s < ${FORMAT_REPORT_MIN_BUDGET_MS / 1000}s needed) — deferring to next invocation`);
    // Return in_progress so the client re-invokes with a fresh time budget
    return {
      status: "in_progress",
      runId,
      phase: "formatting",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError,
    };
  }

  // RULE: "Completed = Report". A run is only marked completed when a formatted
  // report has been successfully generated AND saved to module_outputs.
  // If formatting failed (fullReport is null), return in_progress so the next
  // invocation retries with a fresh time budget. This prevents the silent-failure
  // scenario where a run shows "completed" with no output.
  if (!fullReport) {
    console.warn(`[pipeline] formatReportInline returned null — NOT marking completed (completed = report). Will retry on next invocation.`);
    return {
      status: "in_progress",
      runId,
      phase: "formatting_retry",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError: "Report formatting failed — will retry on next invocation",
    };
  }

  // --- Surface permanently_failed extractions BEFORE saving the report ---
  // Query for chunks that exhausted all extraction attempts. If any exist,
  // inject a disclosure section into the report so the user is informed.
  const PermFailedSchema = z.object({
    chunk_index: z.coerce.number(),
    label: z.string(),
    source_file: z.string(),
  });
  let permanentlyFailedExtractions: { chunkLabel: string; sourceFile: string; chunkIndex: number }[] = [];
  try {
    const permFailed = await ctx.integrations.db.query(
      `SELECT
         ue.chunk_index,
         COALESCE(ue.extraction_json->>'label', 'Chunk ' || ue.chunk_index) AS label,
         COALESCE(ue.extraction_json->>'sourceFile', d.file_name, 'unknown') AS source_file
       FROM universal_extractions ue
       LEFT JOIN documents d ON d.id = ue.document_id
       WHERE ue.deal_id = $1
         AND (ue.extraction_json->>'permanently_failed')::boolean = true
       ORDER BY ue.chunk_index`,
      PermFailedSchema,
      [dealId],
      { label: "Query permanently_failed extractions" }
    );
    permanentlyFailedExtractions = permFailed.map(r => ({
      chunkLabel: r.label,
      sourceFile: r.source_file,
      chunkIndex: r.chunk_index,
    }));
    if (permanentlyFailedExtractions.length > 0) {
      console.warn(
        `[pipeline] ⚠️  ${permanentlyFailedExtractions.length} permanently_failed extraction(s) — ` +
        `these sections are MISSING from the report: ` +
        permanentlyFailedExtractions.map(e => `"${e.chunkLabel}" (${e.sourceFile})`).join(", ")
      );
      // Inject disclosure into the report
      const disclosureLines = permanentlyFailedExtractions.map(
        e => `  • ${e.chunkLabel} — source: ${e.sourceFile}`
      );
      const disclosureSection =
        `\n\n---\n\n⚠️ **Extraction Gaps — ${permanentlyFailedExtractions.length} section(s) could not be extracted:**\n\n` +
        disclosureLines.join("\n") +
        `\n\nThese sections were omitted from the analysis after exhausting all retry attempts. ` +
        `Content from these source documents is NOT reflected in the findings above.`;
      fullReport = fullReport + disclosureSection;
    }
  } catch (pfErr) {
    console.warn("[pipeline] Failed to query permanently_failed extractions:", pfErr);
  }

  // ─── Route through shared post-merge finalization runner (OA-04 + F06) ───
  // At this point: post-merge pipeline done, absence verification done, report formatted.
  // The shared runner handles evidence_admission synthesis + canonical finalization.
  const normalPathFinalizationResult = await runPostMergeFinalizationStages({
    ctx,
    runId: runId!,
    dealId,
    moduleId,
    naturalRootTreeLevel: currentRound,
    naturalRootNodeIndex: 0,
    canonicalRootFindings: finalFindings,
    executiveHeader: finalNode.executiveHeader,
    startTime,
    timeRemaining,
    callerPath: "normal_path",
    housekeepingFindings: finalHousekeepingFindings,
    housekeepingValidated: true,
    fileTagMap,
    sourceManifestHash: null,
    runPostMergePipeline,
    runAbsenceVerificationPhase,
  });

  // Post-completion framing audit (only on successful finalization)
  if (normalPathFinalizationResult.status === "complete" && normalPathFinalizationResult.artifact) {
    try {
      const auditReportText = normalPathFinalizationResult.artifact.report?.markdown ?? "";
      const auditFindings = (normalPathFinalizationResult.artifact.canonical_findings ?? []) as MergedFinding[];
      const auditResult = await Promise.race([
        Promise.resolve(runPostCompletionAudit({
          runId: runId!,
          moduleId,
          reportText: auditReportText,
          findings: auditFindings,
        })),
        new Promise<{ flagged: boolean; warnings: string[] }>((resolve) =>
          setTimeout(() => resolve({ flagged: false, warnings: [] }), 10_000)
        ),
      ]);
      if (auditResult.flagged) {
        console.warn(`[pipeline] Post-completion audit flagged ${auditResult.warnings.length} pattern(s)`);
      }
    } catch (auditErr) {
      console.warn(`[pipeline] Post-completion audit failed (non-fatal):`, auditErr);
    }
  }

  // Translate shared runner result → pipeline return type
  // Handle non-complete outcomes first
  if (normalPathFinalizationResult.status !== "complete" || !normalPathFinalizationResult.artifact) {
    const phase = `post_merge_finalization_${normalPathFinalizationResult.currentStage ?? "unknown"}`;
    const firstErrMsg = normalPathFinalizationResult.blockingReasons.length > 0
      ? normalPathFinalizationResult.blockingReasons.join("; ")
      : `Finalization ${normalPathFinalizationResult.status}: stage=${normalPathFinalizationResult.currentStage}`;
    console.warn(`[pipeline] Shared finalization runner returned ${normalPathFinalizationResult.status} — ${firstErrMsg}`);
    return {
      status: "in_progress",
      runId: runId!,
      phase,
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError: firstErrMsg,
    };
  }

  // Finalization complete — derive mergedText from the shared runner's artifact
  const artifactResult = normalPathFinalizationResult.artifact;
  console.log(`[pipeline] Shared finalization runner: complete — findings=${(artifactResult.canonical_findings ?? []).length}`);
  finalFindings = (artifactResult.canonical_findings ?? []) as MergedFinding[];
  fullReport = artifactResult.report?.markdown ?? "";

  const MAX_MERGED_TEXT_CHARS = 150_000;
  let mergedText: string = fullReport;
  if (mergedText.length > MAX_MERGED_TEXT_CHARS) {
    console.warn(`[pipeline] mergedText ${mergedText.length} chars exceeds ${MAX_MERGED_TEXT_CHARS} cap — truncating`);
    mergedText = mergedText.slice(0, MAX_MERGED_TEXT_CHARS) + "\n\n[…truncated for transport — full content available in DB checkpoints]";
  }

  // --- CANONICAL FINALIZATION GATE ---
  // Analysis may start independently of claims, but the final output cannot be
  // committed as "completed" while required claims/reconciliation remain pending.
  // This prevents data loss from premature finalization.
  if (claimsPending && moduleId === "contradiction_check") {
    logReturn("in_progress", "claims_pending_finalization", "claims_pending_finalization", {
      analysis_total: routed.length,
      analysis_completed: routed.length,
      merge_rounds_done: totalMergeRounds,
    });
    console.log(
      `[pipeline] CANONICAL FINALIZATION GATE: claims still pending — ` +
      `returning in_progress with analysis complete. Next invocation will ` +
      `complete claims/reconciliation and then finalize.`
    );
    return {
      status: "in_progress",
      runId,
      phase: "claims_pending_finalization",
      progress: {
        analysisTotal: routed.length,
        analysisCompleted: routed.length,
        mergeRound: totalMergeRounds,
        mergeTotal: totalMergeRounds,
      },
      result: null,
      failedChunks,
      truncatedChunks,
      truncatedMerges,
      firstError: null,
    };
  }

  // --- DEGRADED DISCLOSURE ---
  // If claims extraction permanently failed, append a disclosure to the report
  // so the final output transparently communicates reduced coverage.
  if (claimsDegraded && moduleId === "contradiction_check") {
    const degradedNotice = "\n\n---\n\n**⚠️ CLAIMS RECONCILIATION DISCLOSURE**\n\n" +
      "Claims extraction from IC memos could not be completed after multiple attempts. " +
      "This report's contradiction analysis is based solely on numeric verification " +
      "and cross-version comparison. IC memo claims were NOT reconciled against the " +
      "operating model figures. This represents reduced analytical coverage.\n";
    mergedText += degradedNotice;
    if (fullReport) fullReport += degradedNotice;
    console.warn(`[pipeline] Degraded claims disclosure appended to final report.`);
  }

  logReturn("completed", "done", "pipeline_complete", {
    analysis_total: routed.length,
    analysis_completed: routed.length,
    merge_rounds: totalMergeRounds,
    failed_chunks: failedChunks,
    claims_degraded: claimsDegraded ? 1 : 0,
  });

  return {
    status: "completed",
    runId,
    phase: "done",
    progress: {
      analysisTotal: routed.length,
      analysisCompleted: routed.length,
      mergeRound: totalMergeRounds,
      mergeTotal: totalMergeRounds,
    },
    result: {
      executiveHeader: finalNode.executiveHeader,
      findings: finalFindings,
      mergedText,
      fullReport: fullReport ?? "",
    },
    failedChunks,
    truncatedChunks,
    truncatedMerges,
    mergeGroupsFallenBack: mergeGroupsFallenBack > 0 ? mergeGroupsFallenBack : undefined,
    firstError,
    permanentlyFailedExtractions: permanentlyFailedExtractions.length > 0 ? permanentlyFailedExtractions : undefined,
  };
}
