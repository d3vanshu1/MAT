import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { toast } from "sonner";
import { useApi } from "@/hooks/useApi.js";
import { useApiData } from "@/hooks/useApiData.js";
import { executeApi } from "@/lib/executeApi.js";
import { processAllFiles, extractTextFromFile, parseExcelToTables, parseCsvToTable } from "@/lib/pdfProcessor";
import type { DocumentChunk, ProcessedFileInfo, ExcludedFile, StructuredCell } from "@/lib/pdfProcessor";
import { MODULE_DEFINITIONS, MODULE_MAP, NUMERIC_MODULES } from "@/lib/moduleConfig";
import { CHUNK_CHARS, CHUNK_CONCURRENCY, EXTRACTION_MODEL, isSpreadsheetFile } from "@/lib/pipelineConfig";
import { getExtractionsForModule } from "@/lib/chunkRouting";
import type { TaggedExtraction } from "@/lib/chunkRouting";
import type { Document, DocumentTag, DocumentSource } from "@/types/document";
import type { ModuleRun, ModuleStatus, ModuleOutput, Finding } from "@/types/module";
import type { AnalysisProgress } from "@/components/ic/modules/ModuleGrid";

import Sidebar from "@/components/ic/layout/Sidebar";
import DashboardHeader from "@/components/ic/layout/DashboardHeader";
import StatsRow from "@/components/ic/stats/StatsRow";
import AlertBanner from "@/components/ic/alerts/AlertBanner";
import ModuleGrid from "@/components/ic/modules/ModuleGrid";
import RunAllModal from "@/components/ic/modules/RunAllModal";
// BSS v2 — lightweight types matching BssGetFindings API output (no UI dependency)
interface BssFinding {
  candidate_id: string;
  pass_type: string;
  failure_mode: string;
  implied_assumption: string;
  hypothesis: string;
  rationale: string | null;
  adjudicated_verdict: string | null;
  adjudication_quote: string | null;
  adjudication_reason: string | null;
  thesis_hit: boolean | null;
  latest_memo_hit: boolean | null;
  gate: string | null;
  reason: string | null;
}
interface BssFunnel {
  totalCandidates: number;
  findings: number;
  droppedCovered: number;
  droppedNotReliedUpon: number;
}

/** Convert BSS findings + funnel into the standard ModuleOutput shape used by ModuleCard / ModuleOutput. */
function bssToModuleOutput(
  findings: BssFinding[],
  funnel: BssFunnel,
  dealId: string,
): ModuleOutput {
  const findingsCount = findings.length;

  // Build executive header — mirrors tone of other modules
  const headerParts = [`Blind Spot Scan — ${funnel.totalCandidates} candidate assumptions evaluated.`];
  if (findingsCount === 0) {
    headerParts.push("No material blind spots identified.");
  } else {
    headerParts.push(`${findingsCount} blind spot${findingsCount > 1 ? "s" : ""} surfaced for IC attention.`);
  }
  headerParts.push(
    `${funnel.droppedCovered} candidates already covered in diligence; ${funnel.droppedNotReliedUpon} assessed as thesis-independent.`,
  );

  // Map BSS findings → standard Finding[]
  const standardFindings: Finding[] = findings.map((f) => {
    const analysisLines: string[] = [];
    analysisLines.push(`**Failure mode:** ${f.failure_mode}`);
    analysisLines.push(`**Hypothesis:** ${f.hypothesis}`);
    if (f.rationale) analysisLines.push(`**Rationale:** ${f.rationale}`);
    if (f.adjudicated_verdict) analysisLines.push(`**Adjudication:** ${f.adjudicated_verdict}`);
    if (f.adjudication_quote) analysisLines.push(`> ${f.adjudication_quote}`);
    if (f.adjudication_reason) analysisLines.push(`**Reason:** ${f.adjudication_reason}`);

    return {
      severity: "critical" as const,
      title: f.implied_assumption,
      detail: f.adjudicated_verdict
        ? `${f.adjudicated_verdict}${f.adjudication_quote ? " — " + f.adjudication_quote : ""}`
        : f.failure_mode,
      full_analysis: analysisLines.join("\n\n"),
      source_docs: [],
    };
  });

  // Build full-report markdown
  const reportLines: string[] = [
    "# Blind Spot Scan Report",
    "",
    `**Candidates evaluated:** ${funnel.totalCandidates}`,
    `**Findings surfaced:** ${findingsCount}`,
    `**Dropped (already covered):** ${funnel.droppedCovered}`,
    `**Dropped (thesis-independent):** ${funnel.droppedNotReliedUpon}`,
    "",
    "---",
    "",
    "> **Caveat — missing adviser workstreams:** This scan did not have access to adviser reports (e.g. EQTR, Hakluyt, Kolayo). Findings that overlap with those workstreams may be flagged here but already addressed in the full diligence package.",
    "",
    "> **Caveat — absence-based reasoning:** Some findings are based on the *absence* of discussion in the available materials. Absence does not confirm a gap; the topic may be covered in documents not provided.",
    "",
  ];
  if (findingsCount > 0) {
    reportLines.push("## Findings", "");
    findings.forEach((f, i) => {
      reportLines.push(`### ${i + 1}. ${f.implied_assumption}`);
      reportLines.push("");
      reportLines.push(`**Pass type:** ${f.pass_type}`);
      reportLines.push(`**Failure mode:** ${f.failure_mode}`);
      reportLines.push(`**Hypothesis:** ${f.hypothesis}`);
      if (f.rationale) reportLines.push(`**Rationale:** ${f.rationale}`);
      if (f.adjudicated_verdict) reportLines.push(`**Adjudication:** ${f.adjudicated_verdict}`);
      if (f.adjudication_quote) reportLines.push(`> ${f.adjudication_quote}`);
      if (f.adjudication_reason) reportLines.push(`**Reason:** ${f.adjudication_reason}`);
      reportLines.push("");
    });
  } else {
    reportLines.push("## No Findings", "", "All candidates were either already covered in the diligence materials or assessed as non-material.", "");
  }

  return {
    id: `bss-output-${dealId}`,
    module_run_id: `bss-v2-${dealId}`,
    executive_header: headerParts.join(" "),
    findings: standardFindings,
    full_report_markdown: reportLines.join("\n"),
    created_at: new Date().toISOString(),
  };
}

import RerunSuggestionModal from "@/components/ic/modules/RerunSuggestionModal";
import RunHistory from "@/components/ic/modules/RunHistory";
import QAPanel from "@/components/ic/qa/QAPanel";
import ReparseDocumentsModal from "@/components/ic/documents/ReparseDocumentsModal";

export { DealDashboardPage as Component };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MergeNode = {
  text: string;
  executiveHeader: string;
  findings: Array<{
    finding_id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    detail: string;
    full_analysis: string;
    source_docs: string[];
    claim_ids?: string[];
    merged_from_finding_ids?: string[];
    category?: "principal_finding" | "housekeeping" | "human_review_flag";
    finding_kind?: "data_divergence" | "cross_version" | "source_stated_risk" | "absence_claim" | "process_observation";
    issue_key?: string;
    severity_anchor?: string;
    structured_impact?: Array<{ amount: number; currency: "GBP" | "USD" | "EUR" | "other"; unit_multiplier: number; role: "delta" | "exposure" | "annual_impact" | "deal_value" | "threshold" | "context"; verified: boolean; source_doc?: string; source_coordinate?: string }>;
    materiality_rationale?: string;
    numeric_unverified?: boolean;
    evidence?: Array<{ figure: string; source_doc: string; verbatim_snippet: string; verified: boolean; metric?: string; period?: string }>;
    absence_confidence?: "verified_absent" | "likely_absent" | "unverified";
    gap_type?: "diligence_gap" | "memo_omission" | "open_item_acknowledged";
    evidence_docs?: string[];
    independent?: boolean;
    verification?: { status: "revised" | "upheld" | "verification_error" | "failed_retryable"; revisedDetail?: string; evidenceQuoted?: string; evidenceSource?: string; reasoning?: string; queriesRun: string[] };
  }>;
};

// Concurrency imported from @/lib/pipelineConfig

/** Combined chunk-processing result with coverage tracking */
interface CoverageResult {
  chunks: DocumentChunk[];
  totalPages: number;
  filesProcessed: ProcessedFileInfo[];
  filesExcluded: ExcludedFile[];
}

/**
 * Display labels for the CC reconciliation-path finalization stages.
 *
 * Mirrors STAGE_SEQUENCE in server/apis/pipeline/post-merge-finalization.ts.
 * The reconciliation path skips routing/analysis/merge entirely, so the
 * pipeline's numeric `progress` fields are structurally zero there and the
 * finalization stage — carried in the `phase` string as
 * `cc_reconciliation_<stage>` — is the only signal that advances.
 *
 * Order matters: the index is rendered as "step N/5".
 */
const RECON_STAGE_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "claims_ledger", label: "Building claims ledger" },
  { key: "reconciliation", label: "Reconciling claims against model" },
  { key: "post_merge", label: "Post-merge processing" },
  { key: "absence_verify", label: "Verifying absences" },
  { key: "canonical_finalize", label: "Finalizing report" },
] as const;

/**
 * Fix 3 — `diagnosticOnly` operator affordance.
 *
 * `diagnosticOnly` is threaded into RunModulePipeline so a run can be tagged in
 * `module_run_flags` at creation time (and carried forward if pipeline-core has
 * to mint a fresh run on version mismatch). It changes nothing about how the
 * pipeline executes, and — deliberately — nothing about GetRunnableRuns, which
 * stays unfiltered so a diagnostic run is still resumable like any other.
 *
 * This is NOT a product control: there is no button for it anywhere in the UI.
 * An operator opts in per-tab by loading the dashboard with `?diag=1` (alias
 * `?diagnosticOnly=1`). Every other code path defaults to `false`.
 */
function readDiagnosticOnlyFromUrl(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("diag") ?? params.get("diagnosticOnly");
    if (raw === null) return false;
    return raw === "" || /^(1|true|yes|on)$/i.test(raw);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DealDashboardPage() {
  const { dealId } = useParams<{ dealId: string }>();
  const navigate = useNavigate();

  // --- Live data from database ---
  const { data: dealData, loading: dealLoading, isError: dealError } = useApiData(
    "GetDeal",
    { dealId: dealId ?? "" },
    { enabled: !!dealId }
  );
  const deal = (dealData?.deal as import("@/types/deal").Deal | undefined) ?? null;

  const { data: docsData, refetch: refetchDocs } = useApiData(
    "ListDocuments",
    { dealId: dealId ?? "" },
    { enabled: !!dealId }
  );

  const { data: moduleData, refetch: refetchModules } = useApiData(
    "LoadModuleResults",
    { dealId: dealId ?? "" },
    { enabled: !!dealId, staleTime: 30_000, refetchOnWindowFocus: false }
  );

  const [docs, setDocs] = useState<Document[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ModuleStatus>>({});
  const [runningModules, setRunningModules] = useState<Set<string>>(new Set());
  const [showRunAll, setShowRunAll] = useState(false);
  const [historyModule, setHistoryModule] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, AnalysisProgress>>({});
  const [rerunModal, setRerunModal] = useState<{ fileNames: string[]; suggestedIds: string[] } | null>(null);
  const [useOpus, setUseOpus] = useState(false);
  const [showReparseModal, setShowReparseModal] = useState(false);
  // Subject memo selection — IDs of ic_memo docs chosen as "memo(s) under review"
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);

  // Sync DB docs into local state — only on initial load
  const docsInitialized = useRef(false);
  useEffect(() => {
    if (docsData?.documents && !docsInitialized.current) {
      docsInitialized.current = true;
      const mappedDocs = docsData.documents.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deal_id: d.deal_id as string,
        file_name: d.file_name as string,
        file_type: d.file_type as string,
        document_tag: (d.document_tag ?? "other") as DocumentTag,
        document_source: (d.document_source ?? "sellside") as DocumentSource,
        uploaded_at: d.uploaded_at as string,
      }));
      setDocs(mappedDocs);
      // Auto-preselect all IC memo docs on initial load (user can untick)
      const icMemoIds = mappedDocs
        .filter((d) => d.document_tag === "ic_memo")
        .map((d) => d.id);
      if (icMemoIds.length > 0 && selectedSubjectIds.length === 0) {
        setSelectedSubjectIds(icMemoIds);
      }
    }
  }, [docsData]);

  // Sync DB module results into local state
  useEffect(() => {
    if (moduleData?.modules && moduleData.modules.length > 0) {
      const loaded: Record<string, ModuleStatus> = {};
      for (const m of moduleData.modules) {
        loaded[m.moduleId] = {
          moduleId: m.moduleId,
          latestRun: m.latestRun
            ? {
                id: m.latestRun.id,
                deal_id: dealId!,
                module_id: m.moduleId,
                status: m.latestRun.status as ModuleRun["status"],
                triggered_at: m.latestRun.triggeredAt,
                completed_at: m.latestRun.completedAt,
                documents_included: [],
                findings_count: m.latestOutput?.findings?.length ?? 0,
                critical_count: m.latestOutput?.findings?.filter((f: Record<string, unknown>) => f.severity === "critical").length ?? 0,
              }
            : null,
          latestOutput: m.latestOutput
            ? {
                id: crypto.randomUUID(),
                module_run_id: m.latestRun?.id ?? "",
                executive_header: m.latestOutput.executiveHeader,
                findings: m.latestOutput.findings,
                full_report_markdown: m.latestOutput.fullReport,
                created_at: m.latestOutput.createdAt,
              }
            : null,
        };
      }

      // CRITICAL: Do NOT overwrite modules that are actively being driven by
      // the pipeline polling loop. Their local state (progress, "running" status)
      // is authoritative. Overwriting with DB state causes premature "complete"
      // flicker when LoadModuleResults refetches (e.g., after tab focus or when
      // another module finishes and triggers refetchModules()).
      setStatuses((prev) => {
        const merged = { ...prev };
        for (const [id, status] of Object.entries(loaded)) {
          if (runningModules.has(id) && pipelinePollingActive.current.has(id)) {
            // This module is actively being polled by the pipeline loop — skip DB overwrite.
            // Exception: if DB also says "running", allow the update (keeps run ID in sync).
            if (status.latestRun?.status !== "running") continue;
          }
          // BSS v2 uses its own data path (bss_* tables → BssGetFindings → bssResults).
          // LoadModuleResults returns BSS with latestOutput=null because BSS doesn't
          // publish to module_outputs. If we already have BSS results client-side,
          // don't overwrite them with the empty DB row on refetch.
          if (id === "blind_spot_scanner" && prev.blind_spot_scanner?.latestOutput != null) {
            continue;
          }
          merged[id] = status;
        }
        return merged;
      });

      // If any module has a "running" status in DB, reflect it in the UI immediately
      // so the card shows progress state even before the resume logic kicks in
      const dbRunningModuleIds = Object.entries(loaded)
        .filter(([, s]) => s.latestRun?.status === "running")
        .map(([id]) => id)
        .filter((id) => !killedModulesRef.current.has(id));
      if (dbRunningModuleIds.length > 0) {
        setRunningModules((prev) => {
          // Only create a new Set if there are actually new IDs to add
          const hasNew = dbRunningModuleIds.some((id) => !prev.has(id));
          if (!hasNew) return prev; // no-op — preserve reference identity
          const next = new Set(prev);
          dbRunningModuleIds.forEach((id) => next.add(id));
          return next;
        });
        // Set a generic progress message until the resume loop provides real data
        setProgressMap((prev) => {
          const updated = { ...prev };
          for (const id of dbRunningModuleIds) {
            if (!updated[id]) {
              updated[id] = { message: "Running (server-side)…", detail: null, chunkErrors: [] };
            }
          }
          return updated;
        });
      }
    }
  // NOTE: runningModules intentionally excluded — reading it inside setStatuses
  // callback. Including it causes infinite loop because setRunningModules below
  // creates a new Set reference on every call → effect re-fires → infinite depth.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleData, dealId]);

  // Cached chunks so we only process PDFs once even when multiple modules run
  const chunksCache = useRef<CoverageResult | null>(null);
  const chunksCacheKey = useRef<string>("");

  // Tracks document IDs for which structured tables have been saved (keyed by cacheKey)
  const docTablesCacheKey = useRef<string>("");
  const docIdsForVerification = useRef<string[]>([]);

  // Coverage manifest — populated after chunk processing, read by all module runs
  const coverageRef = useRef<{
    filesProcessed: ProcessedFileInfo[];
    filesExcluded: ExcludedFile[];
    chunkCount: number;
    pagesProcessed: number;
  } | null>(null);

  // Shared universal extraction cache — extract once, reuse across all modules
  const universalExtractionsCache = useRef<TaggedExtraction[] | null>(null);
  const universalExtractionsCacheKey = useRef<string>("");

  const { run: analyzeChunk } = useApi("AnalyzeChunk");
  const { run: universalExtract } = useApi("UniversalExtract");
  const { run: mergeFindings } = useApi("MergeFindings");
  const { run: formatReport } = useApi("FormatReport");
  const { run: saveModuleResultApi } = useApi("SaveModuleResult");
  const { run: saveDocumentApi } = useApi("SaveDocument");
  const { run: updateDocumentApi } = useApi("UpdateDocument");
  const { run: deleteDocumentApi } = useApi("DeleteDocument");
  const { run: getRunHistoryApi } = useApi("GetRunHistory");
  const { run: indexDocumentChunks } = useApi("IndexDocumentChunks");
  const { run: getDocumentTexts } = useApi("GetDocumentTexts");

  // Checkpoint APIs (crash-recovery)
  const { run: saveExtractionsApi } = useApi("SaveExtractions");
  const { run: loadExtractionsApi } = useApi("LoadExtractions");
  const { run: saveMergeCheckpointApi } = useApi("SaveMergeCheckpoint");
  const { run: loadMergeCheckpointsApi } = useApi("LoadMergeCheckpoints");
  const { run: updateRunStatusApi } = useApi("UpdateRunStatus");
  const { run: getRunProgressApi } = useApi("GetRunProgress");
  const { run: saveRunCoverageApi } = useApi("SaveRunCoverage");
  const { run: loadRunCoverageApi } = useApi("LoadRunCoverage");
  const { run: saveDocTablesApi } = useApi("SaveDocTables");
  const { run: numericVerifyApi } = useApi("NumericVerify");
  const { run: cancelModuleRunApi } = useApi("CancelModuleRun");
  const { run: checkRunCancelledApi } = useApi("CheckRunCancelled");
  const { run: backfillDocTablesApi } = useApi("BackfillDocTablesFromText");
  const { run: getDocTablesSummaryApi } = useApi("GetDocTablesSummary");
  const { run: runModulePipelineApi } = useApi("RunModulePipeline");
  // GetRunnableRuns removed — the watchdog now uses GetRunProgress exclusively
  // BSS v2 orchestrator
  const { run: bssRunPipelineApi } = useApi("BssRunPipeline");
  const { run: bssGetFindingsApi } = useApi("BssGetFindings");
  // ERO v2 orchestrator
  const { run: eroRunPipelineApi } = useApi("EroRunPipeline");
  const { run: publishEroApi } = useApi("PublishEroToModuleOutputs");
  // DCS rebuild orchestrator
  const { run: dcsRunPipelineApi } = useApi("DcsRunPipeline");
  // MAST v2 orchestrator
  const { run: mastRunPipelineApi } = useApi("MastRunPipeline");
  const { run: mastPublishApi } = useApi("MastPublish");

  // Cancellation tracking — stores run IDs that have been cancelled
  const cancelledRunsRef = useRef<Set<string>>(new Set());
  // Maps moduleId → active runId so we know what to cancel
  const activeRunIdRef = useRef<Record<string, string>>({});
  // Modules permanently killed this session — never auto-resume
  const killedModulesRef = useRef<Set<string>>(new Set());
  // Track consecutive resume failures per module — kill after threshold
  const resumeFailureCountRef = useRef<Record<string, number>>({});
  // Last-known checkpoint count per module — used to detect server progress
  // despite client-side fetch timeouts. If checkpoints advance between resume
  // attempts, the server is working and we should NOT count the timeout as a failure.
  const lastKnownCheckpointsRef = useRef<Record<string, number>>({});
  // Consecutive progress poll failures (persists across effect re-runs)
  const pollFailureCountRef = useRef(0);
  // Fix 3 — operator-only diagnostic flag, resolved once per tab from the URL.
  // Default false. Not surfaced as a product control.
  const diagnosticOnlyRef = useRef<boolean>(readDiagnosticOnlyFromUrl());
  // BSS v2 — owner token minted once per run, reused across all poll invocations
  const bssOwnerTokenRef = useRef<string | null>(null);
  // DCS rebuild — stable owner token for CAS across poll invocations
  const dcsOwnerTokenRef = useRef<string | null>(null);
  // BSS v2 — mutable override set by the poll loop on completion; cleared on re-run
  const [bssOverride, setBssOverride] = useState<{ findings: BssFinding[]; funnel: BssFunnel } | null>(null);

  // BSS v2 — load findings from DB on mount (survives refresh, HMR, tab switch)
  const { data: bssCachedData, refetch: refetchBssFindings } = useApiData(
    "BssGetFindings",
    { dealId: dealId ?? "" },
    { enabled: !!dealId, staleTime: 60_000, retry: 1 },
  );

  // Derive bssResults: poll-loop override wins, else cached query data
  const bssResults = useMemo(() => {
    if (bssOverride) return bssOverride;
    if (!bssCachedData) return null;
    const funnel = bssCachedData.funnel as BssFunnel;
    if (funnel.totalCandidates === 0) return null; // pipeline never ran
    return { findings: bssCachedData.findings as BssFinding[], funnel };
  }, [bssOverride, bssCachedData]);

  // Sync module status when bssResults becomes available — populate standard latestOutput
  useEffect(() => {
    if (!dealId || !bssResults) return;
    setStatuses((prev) => {
      if (prev.blind_spot_scanner?.latestRun?.status === "completed") return prev;
      const output = bssToModuleOutput(bssResults.findings, bssResults.funnel, dealId);
      return {
        ...prev,
        blind_spot_scanner: {
          moduleId: "blind_spot_scanner",
          latestRun: {
            id: `bss-v2-${dealId}`,
            deal_id: dealId,
            module_id: "blind_spot_scanner",
            status: "completed",
            triggered_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            documents_included: [],
            findings_count: bssResults.findings.length,
            critical_count: bssResults.findings.length,
          },
          latestOutput: output,
        },
      };
    });
  }, [dealId, bssResults, setStatuses]);

  const completedModules = useMemo(
    () =>
      Object.entries(statuses)
        .filter(([, s]) => s.latestRun?.status === "completed" && s.latestOutput != null)
        .map(([id]) => id),
    [statuses]
  );

  const stats = useMemo(() => {
    const totalFindings = Object.values(statuses).reduce(
      (sum, s) => sum + (s.latestOutput?.findings.length ?? 0),
      0
    );
    const criticalFindings = Object.values(statuses).reduce(
      (sum, s) =>
        sum +
        (s.latestOutput?.findings.filter((f) => f.severity === "critical").length ?? 0),
      0
    );
    return {
      documents: docs.length,
      modulesComplete: completedModules.length,
      totalModules: MODULE_DEFINITIONS.length,
      totalFindings,
      criticalFindings,
    };
  }, [docs, statuses, completedModules]);

  // --- Run gate: both subject and evidence pools must be non-empty ---
  const evidenceDocs = useMemo(
    () => docs.filter((d) => !selectedSubjectIds.includes(d.id)),
    [docs, selectedSubjectIds]
  );
  const canRunAnalysis = selectedSubjectIds.length > 0 && evidenceDocs.length > 0;
  const runDisabledReason = !canRunAnalysis
    ? "Select the memo under review and upload at least one reference document to run modules."
    : undefined;

  // ---------------------------------------------------------------------------
  // Progress helpers — scoped per module
  // ---------------------------------------------------------------------------

  const setModuleProgress = useCallback(
    (moduleId: string, update: Partial<AnalysisProgress>) => {
      setProgressMap((prev) => ({
        ...prev,
        [moduleId]: {
          message: prev[moduleId]?.message ?? null,
          detail: prev[moduleId]?.detail ?? null,
          chunkErrors: prev[moduleId]?.chunkErrors ?? [],
          ...update,
        },
      }));
    },
    []
  );

  const clearModuleProgress = useCallback((moduleId: string) => {
    setProgressMap((prev) => {
      const next = { ...prev };
      delete next[moduleId];
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Chunk processing — shared across modules
  // ---------------------------------------------------------------------------

  /**
   * Build text-only chunks from database-stored parsed_text.
   * Accepts an optional set of file names to skip (already covered by fresh uploads).
   */
  const buildChunksFromDbText = useCallback(
    async (moduleId: string, skipFileNames?: Set<string>): Promise<CoverageResult> => {
      if (!dealId) return { chunks: [], totalPages: 0, filesProcessed: [], filesExcluded: [] };

      setModuleProgress(moduleId, {
        message: "Loading stored documents from database…",
      });

      const result = await getDocumentTexts({ dealId });
      const dbDocs = result?.documents;
      const loadWarnings = (result as any)?.warnings as string[] | undefined;
      if (loadWarnings && loadWarnings.length > 0) {
        console.warn("[doc-load]", loadWarnings.join("; "));
      }

      if (!dbDocs || dbDocs.length === 0) {
        return { chunks: [], totalPages: 0, filesProcessed: [], filesExcluded: [] };
      }

      // CHUNK_CHARS imported from @/lib/pipelineConfig
      const chunks: DocumentChunk[] = [];
      const dbFilesProcessed: ProcessedFileInfo[] = [];
      const dbFilesExcluded: ExcludedFile[] = [];

      for (const doc of dbDocs) {
        // Skip if a fresh upload with the same name already exists
        if (skipFileNames && skipFileNames.has(doc.file_name)) {
          dbFilesExcluded.push({ fileName: doc.file_name, reason: "superseded", detail: "Replaced by a fresh upload" });
          continue;
        }

        // Skip spreadsheet files — their data goes through doc_tables/NumericVerify, not LLM extraction
        if (isSpreadsheetFile(doc.file_name)) {
          dbFilesExcluded.push({ fileName: doc.file_name, reason: "spreadsheet", detail: "Routed to doc_tables/NumericVerify (no LLM extraction needed)" });
          continue;
        }

        const text = doc.parsed_text;
        if (!text || text.trim().length === 0) {
          // Use skip_reason from API if available, otherwise default to parse_failure
          const reason = (doc as any).skip_reason === "too_large" ? "too_large" as const
            : (doc as any).skip_reason === "load_error" ? "parse_failure" as const
            : "parse_failure" as const;
          const detail = reason === "too_large"
            ? "Document exceeds 50MB size limit"
            : "Empty or missing parsed text";
          dbFilesExcluded.push({ fileName: doc.file_name, reason, detail });
          continue;
        }

        if (text.length <= CHUNK_CHARS) {
          chunks.push({
            label: doc.file_name,
            sourceFile: doc.file_name,
            text,
            pageImages: [],
          });
        } else {
          // Split into multiple chunks
          let start = 0;
          let chunkIdx = 1;
          while (start < text.length) {
            const end = Math.min(start + CHUNK_CHARS, text.length);
            chunks.push({
              label: `${doc.file_name} (part ${chunkIdx})`,
              sourceFile: doc.file_name,
              text: text.slice(start, end),
              pageImages: [],
            });
            start = end;
            chunkIdx++;
          }
        }

        const chunkCountForDoc = text.length <= CHUNK_CHARS ? 1 : Math.ceil(text.length / CHUNK_CHARS);
        dbFilesProcessed.push({ fileName: doc.file_name, chunkCount: chunkCountForDoc, pageCount: chunkCountForDoc });
      }

      return { chunks, totalPages: chunks.length, filesProcessed: dbFilesProcessed, filesExcluded: dbFilesExcluded };
    },
    [dealId, getDocumentTexts, setModuleProgress]
  );

  const getOrProcessChunks = useCallback(
    async (moduleId: string) => {
      // Build a combined cache key from both sources
      const uploadKey = uploadedFiles.map((f) => f.name + f.size).join("|");
      const dbKey = docs.map((d) => d.id).sort().join(",");
      const cacheKey = `${uploadKey}||${dbKey}`;

      if (chunksCache.current && chunksCacheKey.current === cacheKey) {
        return chunksCache.current;
      }

      let uploadedChunks: DocumentChunk[] = [];
      let uploadFilesProcessed: ProcessedFileInfo[] = [];
      let uploadFilesExcluded: ExcludedFile[] = [];

      // Process fresh File objects with the full PDF rendering pipeline
      if (uploadedFiles.length > 0) {
        setModuleProgress(moduleId, {
          message: "Processing uploaded documents — rendering pages...",
        });

        const result = await processAllFiles(uploadedFiles, (info) => {
          if (info.phase === "rendering" && info.currentPage % 5 === 0) {
            setModuleProgress(moduleId, {
              message: `Rendering ${info.file}: page ${info.currentPage}/${info.totalPages}`,
            });
          }
        });

        uploadedChunks = result.chunks;
        uploadFilesProcessed = result.filesProcessed;
        uploadFilesExcluded = result.filesExcluded;
      }

      // Build a set of file names covered by fresh uploads
      const uploadedFileNames = new Set(uploadedFiles.map((f) => f.name));

      // Fetch DB documents, skipping any that share a name with a fresh upload
      const dbResult = await buildChunksFromDbText(moduleId, uploadedFileNames);

      // Combine both sources — no cap; process everything
      const allChunks = [...uploadedChunks, ...dbResult.chunks];
      const allFilesProcessed = [...uploadFilesProcessed, ...dbResult.filesProcessed];
      const allFilesExcluded = [...uploadFilesExcluded, ...dbResult.filesExcluded];

      if (allFilesExcluded.length > 0) {
        const reasons = allFilesExcluded.filter(f => f.reason !== "superseded");
        if (reasons.length > 0) {
          toast.warning(
            `${reasons.length} file(s) excluded from analysis. Check the coverage manifest for details.`
          );
        }
      }

      const totalPages = allFilesProcessed.reduce((sum, f) => sum + f.pageCount, 0);
      const combined: CoverageResult = { chunks: allChunks, totalPages, filesProcessed: allFilesProcessed, filesExcluded: allFilesExcluded };
      chunksCache.current = combined;
      chunksCacheKey.current = cacheKey;

      // Persist coverage manifest ref for downstream module runs
      coverageRef.current = {
        filesProcessed: allFilesProcessed,
        filesExcluded: allFilesExcluded,
        chunkCount: allChunks.length,
        pagesProcessed: totalPages,
      };

      // Extract and save structured tables from Excel/CSV files (async, non-blocking)
      if (cacheKey !== docTablesCacheKey.current) {
        docTablesCacheKey.current = cacheKey;
        const docIdByName: Record<string, string> = {};
        for (const doc of docs) docIdByName[doc.file_name] = doc.id;

        const tablesPayload: Array<{ documentId: string; sheetOrPage: string; caption: string | null; data: { row_headers: string[]; col_headers: string[]; cells: StructuredCell[] } }> = [];
        const docsWithTables: string[] = [];

        for (const file of uploadedFiles) {
          const docId = docIdByName[file.name];
          if (!docId) continue; // not yet in DB — skip
          const lower = file.name.toLowerCase();
          if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
            try {
              const buf = await file.arrayBuffer();
              const tables = parseExcelToTables(buf, file.name);
              for (const t of tables) {
                tablesPayload.push({
                  documentId: docId,
                  sheetOrPage: t.sheetOrPage,
                  caption: t.caption,
                  data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
                });
              }
              if (tables.length > 0 && !docsWithTables.includes(docId)) docsWithTables.push(docId);
            } catch (err) {
              console.warn(`[doc_tables] Failed to parse ${file.name}:`, err);
            }
          } else if (lower.endsWith(".csv")) {
            try {
              const buf = await file.arrayBuffer();
              const csvText = new TextDecoder("utf-8").decode(buf);
              const t = parseCsvToTable(csvText, file.name);
              if (t) {
                tablesPayload.push({
                  documentId: docId,
                  sheetOrPage: t.sheetOrPage,
                  caption: t.caption,
                  data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
                });
                if (!docsWithTables.includes(docId)) docsWithTables.push(docId);
              }
            } catch (err) {
              console.warn(`[doc_tables] Failed to parse ${file.name}:`, err);
            }
          }
        }

        if (tablesPayload.length > 0) {
          docIdsForVerification.current = docsWithTables;
          // Await the save so doc_tables are persisted BEFORE NumericVerify runs.
          // Previously this was fire-and-forget, causing a race where NumericVerify
          // could query doc_tables before the INSERT completed — or worse, the save
          // could fail silently and NumericVerify would find nothing.
          try {
            await saveDocTablesApi({ tables: tablesPayload });
          } catch (err) {
            console.error("[doc_tables] Failed to save structured tables:", err);
            // Clear the doc IDs so NumericVerify doesn't run against empty tables
            docIdsForVerification.current = [];
          }
        } else {
          // No fresh uploads — check if stored spreadsheet docs have doc_tables,
          // and backfill if missing. Never assume doc_tables is pre-populated.
          const storedSpreadsheetDocs = docs.filter((d) =>
            /\.(xlsx|xls|xlsm|csv)$/i.test(d.file_name)
          );
          if (storedSpreadsheetDocs.length > 0 && dealId) {
            try {
              setModuleProgress(moduleId, { message: "Checking structured table data…" });
              const summary = await getDocTablesSummaryApi({ dealId });
              if (summary && summary.totalRows > 0) {
                // doc_tables already populated — use those document IDs
                const docIdsWithTables = [...new Set(summary.sheets.map((s) => s.documentId))];
                docIdsForVerification.current = docIdsWithTables;
              } else {
                // No doc_tables — run backfill
                setModuleProgress(moduleId, { message: "Backfilling structured tables from stored spreadsheets…" });
                const backfillResult = await backfillDocTablesApi({ dealId });
                if (backfillResult && backfillResult.totalTables > 0) {
                  docIdsForVerification.current = backfillResult.perDocument.map((d) => d.documentId);
                  toast.info(`Backfilled ${backfillResult.totalTables} table(s) from ${backfillResult.perDocument.length} spreadsheet(s).`);
                } else {
                  console.warn("[doc_tables] Backfill returned no tables — spreadsheets may lack parseable content.");
                  docIdsForVerification.current = [];
                }
              }
            } catch (err) {
              console.error("[doc_tables] Check/backfill failed:", err);
              docIdsForVerification.current = storedSpreadsheetDocs.map((d) => d.id);
            }
          }
        }
      }

      return combined;
    },
    [uploadedFiles, docs, dealId, setModuleProgress, buildChunksFromDbText, saveDocTablesApi, getDocTablesSummaryApi, backfillDocTablesApi]
  );

  // ---------------------------------------------------------------------------
  // Universal extraction — extract all chunks once, reuse across modules
  // ---------------------------------------------------------------------------

  /**
   * Build a map from sourceFile (filename) → documentTag using the
   * docs state. Chunks carry sourceFile which matches doc.file_name.
   */
  const getDocTagMap = useCallback((): Record<string, DocumentTag> => {
    const tagMap: Record<string, DocumentTag> = {};
    for (const doc of docs) {
      tagMap[doc.file_name] = doc.document_tag;
    }
    return tagMap;
  }, [docs]);

  /**
   * Simple hash for chunk content — used to detect when a chunk has changed
   * so cached extractions can be invalidated. Uses djb2 algorithm (fast, no crypto needed).
   */
  function computeContentHash(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /**
   * Run universal extraction on all chunks in parallel.
   * Results are cached in memory AND persisted to the universal_extractions
   * table. On subsequent runs with unchanged content, extractions are loaded
   * from the DB — zero new LLM calls.
   */
  const getOrRunUniversalExtractions = useCallback(
    async (progressLabel: string): Promise<TaggedExtraction[]> => {
      // Build combined cache key from both fresh uploads and DB docs
      const uploadKey = uploadedFiles.map((f) => f.name + f.size).join("|");
      const dbKey = docs.map((d) => d.id).sort().join(",");
      const cacheKey = `${uploadKey}||${dbKey}`;

      // Return in-memory cached extractions if files haven't changed
      if (
        universalExtractionsCache.current &&
        universalExtractionsCacheKey.current === cacheKey
      ) {
        return universalExtractionsCache.current;
      }

      // Step 1: Get or process raw chunks (PDF rendering etc.)
      const { chunks } = await getOrProcessChunks(progressLabel);
      if (chunks.length === 0) return [];

      // Step 2: Load cached extractions from DB
      const tagMap = getDocTagMap();
      // Build a lookup: documentId by filename
      const docIdByName: Record<string, string> = {};
      for (const doc of docs) {
        docIdByName[doc.file_name] = doc.id;
      }

      let cachedByKey: Record<string, { contentHash: string; extraction: TaggedExtraction }> = {};
      if (dealId) {
        try {
          setModuleProgress(progressLabel, {
            message: "Checking for cached extractions…",
          });
          const cached = await loadExtractionsApi({ dealId });
          for (const row of (cached?.extractions ?? [])) {
            const key = `${row.documentId}:${row.chunkIndex}`;
            cachedByKey[key] = {
              contentHash: row.contentHash,
              extraction: {
                label: row.extraction.label,
                extraction: row.extraction.extraction,
                chunkIndex: row.extraction.chunkIndex,
                sourceFile: row.extraction.sourceFile,
                documentTag: row.extraction.documentTag as DocumentTag,
                ...(row.extraction.failed ? { failed: true } : {}),
              },
            };
          }
        } catch {
          // Ignore load errors — just re-extract everything
          cachedByKey = {};
        }
      }

      // Step 3: Determine which chunks need extraction vs. can be served from cache
      const extractions: TaggedExtraction[] = new Array(chunks.length);
      const chunksToExtract: Array<{ index: number; chunk: DocumentChunk; docId: string; hash: string }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const docId = docIdByName[chunk.sourceFile] ?? "";
        const hash = computeContentHash(chunk.text);
        const cacheHit = cachedByKey[`${docId}:${i}`];

        if (cacheHit && cacheHit.contentHash === hash && !cacheHit.extraction.failed) {
          // Cache hit — use stored extraction, apply current tag (skip failed entries)
          const tag = tagMap[chunk.sourceFile] ?? "other";
          extractions[i] = { ...cacheHit.extraction, documentTag: tag };
        } else {
          chunksToExtract.push({ index: i, chunk, docId, hash });
        }
      }

      const cachedCount = chunks.length - chunksToExtract.length;
      if (cachedCount > 0) {
        toast.info(`${cachedCount} chunk(s) loaded from cache — ${chunksToExtract.length} need extraction.`);
      }

      if (chunksToExtract.length === 0) {
        const validExtractions = extractions.filter(Boolean);
        universalExtractionsCache.current = validExtractions;
        universalExtractionsCacheKey.current = cacheKey;
        return validExtractions;
      }

      // Step 4: Run extraction only on chunks that need it
      const errors: string[] = [];
      let completed = 0;
      const totalToExtract = chunksToExtract.length;

      setModuleProgress(progressLabel, {
        message: `Extracting 0/${totalToExtract} chunks (${cachedCount} cached)…`,
        detail: { current: 0, total: totalToExtract, phase: "analyzing" },
      });

      // Accumulate newly extracted results for bulk save
      const newExtractions: Array<{
        documentId: string;
        chunkIndex: number;
        contentHash: string;
        extraction: TaggedExtraction;
      }> = [];

      for (let batchStart = 0; batchStart < chunksToExtract.length; batchStart += CHUNK_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CHUNK_CONCURRENCY, chunksToExtract.length);
        const batch = chunksToExtract.slice(batchStart, batchEnd);

        const batchPromises = batch.map(async ({ index: i, chunk, docId, hash }) => {
          try {
            // Fix #1: Retry extraction with exponential backoff (same as callAnthropic / withRetry)
            const result = await withRetry(
              () => universalExtract({
                chunkIndex: i,
                totalChunks: chunks.length,
                chunk,
                model: EXTRACTION_MODEL,
                documentId: docId,
              }),
              `extract-chunk-${i}`
            );
            const tag = tagMap[chunk.sourceFile] ?? "other";
            const tagged: TaggedExtraction = {
              label: result?.label ?? chunk.label,
              extraction: result?.extraction ?? "",
              chunkIndex: result?.chunkIndex ?? i,
              sourceFile: result?.sourceFile ?? chunk.sourceFile,
              documentTag: tag,
            };
            extractions[i] = tagged;

            // Queue for DB persistence
            if (docId) {
              newExtractions.push({ documentId: docId, chunkIndex: i, contentHash: hash, extraction: tagged });
            }
          } catch (err) {
            // Fix #2: Mark failed extractions — do NOT bake error text into extraction content
            // and do NOT cache them as valid (failed: true excluded from cache-hit check)
            const msg =
              err && typeof err === "object" && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err);
            errors.push(`Chunk "${chunk.label}": ${msg}`);
            const tag = tagMap[chunk.sourceFile] ?? "other";
            extractions[i] = {
              label: chunk.label,
              extraction: "",
              chunkIndex: i,
              sourceFile: chunk.sourceFile,
              documentTag: tag,
              failed: true,
            };
          } finally {
            completed++;
            setModuleProgress(progressLabel, {
              message: `Extracting ${completed}/${totalToExtract} chunks (${cachedCount} cached)…`,
              detail: { current: completed, total: totalToExtract, phase: "analyzing" },
            });
          }
        });

        await Promise.all(batchPromises);

        // Check for cancellation after each batch
        if (cancelledRunsRef.current.size > 0) {
          // If any active run for the current progressLabel (moduleId) was cancelled, abort
          const activeRunId = activeRunIdRef.current[progressLabel];
          if (activeRunId && cancelledRunsRef.current.has(activeRunId)) {
            toast.info("Run cancelled — stopping extraction.");
            break;
          }
        }

        // Fix #3: Await the extraction checkpoint save and surface failures via toast
        if (dealId && newExtractions.length > 0) {
          const batchToSave = newExtractions.splice(0, newExtractions.length);
          try {
            await saveExtractionsApi({
              dealId,
              extractions: batchToSave.map((e) => ({
                documentId: e.documentId,
                chunkIndex: e.chunkIndex,
                contentHash: e.contentHash,
                extraction: {
                  label: e.extraction.label,
                  extraction: e.extraction.extraction,
                  chunkIndex: e.extraction.chunkIndex,
                  sourceFile: e.extraction.sourceFile,
                  documentTag: e.extraction.documentTag,
                  ...(e.extraction.failed ? { failed: true } : {}),
                },
              })),
            });
          } catch (err: unknown) {
            const errMsg = err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err);
            console.error("Failed to save extraction checkpoint:", err);
            toast.error(`Extraction checkpoint save failed: ${errMsg}`);
          }
        }
      }

      if (errors.length > 0) {
        toast.warning(
          `${errors.length} chunk(s) had extraction errors — partial results will be used.`
        );
      }

      // Cache the results in memory
      const validExtractions = extractions.filter(Boolean);
      universalExtractionsCache.current = validExtractions;
      universalExtractionsCacheKey.current = cacheKey;
      return validExtractions;
    },
    [uploadedFiles, docs, dealId, getOrProcessChunks, getDocTagMap, universalExtract, setModuleProgress, loadExtractionsApi, saveExtractionsApi]
  );

  // ---------------------------------------------------------------------------
  // Tree-reduce merge (shared across all modules)
  // ---------------------------------------------------------------------------

  const MERGE_CONCURRENCY = 10;
  const MERGE_GROUP_SIZE = 4;
  const MAX_RETRIES = 3;

  /** Retry helper — retries on 503/rate-limit/connection errors with exponential backoff */
  async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries = MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        const isRetryable = /503|429|rate.?limit|service.?unavailable|connection.?termination|overloaded/i.test(msg);
        if (!isRetryable || attempt === retries) {
          throw err;
        }
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000); // 2s, 4s, 8s... max 15s
        console.warn(`[${label}] Attempt ${attempt}/${retries} failed (${msg}), retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("Unreachable");
  }

  const treeMerge = useCallback(
    async (
      moduleId: string,
      extractions: Array<{ label: string; extraction: string; chunkIndex: number }>,
      moduleRunId?: string,
      numericReport?: { figures: unknown[]; discrepancies: unknown[] } | null,
      numericPartial?: boolean
    ) => {
      let nodes: MergeNode[] = extractions.map((e) => ({
        text: e.extraction,
        executiveHeader: "",
        findings: [],
      }));

      if (nodes.length === 1) {
        nodes.push({ ...nodes[0] });
      }

      // Load existing merge checkpoints so we can skip completed nodes
      let existingCheckpoints: Record<string, MergeNode> = {};
      if (moduleRunId) {
        try {
          const loaded = await loadMergeCheckpointsApi({ moduleRunId });
          const checkpoints = loaded?.checkpoints ?? [];
          for (const cp of checkpoints) {
            // Skip error checkpoints — they need to be re-run
            if (cp.mergedNode.error) continue;
            const key = `${cp.treeLevel}:${cp.nodeIndex}`;
            existingCheckpoints[key] = {
              text: cp.mergedNode.text ?? "",
              executiveHeader: cp.mergedNode.executiveHeader ?? "",
              findings: cp.mergedNode.findings ?? [],
            };
          }
          if (checkpoints.length > 0) {
            toast.info(`Resuming merge — ${checkpoints.length} node(s) already completed.`);
          }
        } catch {
          existingCheckpoints = {};
        }
      }

      const totalMergeRounds = Math.ceil(Math.log(Math.max(nodes.length, 2)) / Math.log(MERGE_GROUP_SIZE));
      let currentRound = 0;

      while (nodes.length > 1) {
        currentRound++;
        const groups: Array<{ idx: number; members: MergeNode[] }> = [];
        for (let g = 0; g < Math.ceil(nodes.length / MERGE_GROUP_SIZE); g++) {
          const members = nodes.slice(g * MERGE_GROUP_SIZE, (g + 1) * MERGE_GROUP_SIZE);
          groups.push({ idx: g, members });
        }

        // Separate singletons (groups with 1 member) from real groups needing merge
        const singletons = groups.filter((g) => g.members.length === 1);
        const realGroups = groups.filter((g) => g.members.length > 1);
        const nextNodes: MergeNode[] = new Array(groups.length);

        // Pass through singletons immediately
        for (const s of singletons) {
          nextNodes[s.idx] = s.members[0];
        }

        setModuleProgress(moduleId, {
          message: `Merging findings (round ${currentRound}/${totalMergeRounds}, ${realGroups.length} groups in parallel)…`,
          detail: {
            current: currentRound,
            total: totalMergeRounds + 1,
            phase: "synthesizing",
          },
        });

        // Process real groups in parallel with bounded concurrency
        let completed = 0;
        for (let bStart = 0; bStart < realGroups.length; bStart += MERGE_CONCURRENCY) {
          const batch = realGroups.slice(bStart, bStart + MERGE_CONCURRENCY);

          const batchPromises = batch.map(async (group) => {
            // Check if this node is already checkpointed
            const cpKey = `${currentRound}:${group.idx}`;
            if (existingCheckpoints[cpKey]) {
              nextNodes[group.idx] = existingCheckpoints[cpKey];
              completed++;
              return;
            }

            try {
              // Pass numericReport on EVERY merge round for numeric modules,
              // so early rounds can cross-reference against verified figures too.
              // The report is small (capped at 30 figures) — negligible token impact.
              const mergeNumericReport = (NUMERIC_MODULES.has(moduleId) && numericReport) ? numericReport : undefined;

              const merged = await withRetry(
                () => mergeFindings({
                  moduleId,
                  batches: group.members.map((m) => m.text),
                  roundLabel: `Round ${currentRound}, group ${group.idx + 1}/${groups.length}`,
                  useOpus,
                  isFinalRound: currentRound === totalMergeRounds,
                  ...(mergeNumericReport ? { numericReport: mergeNumericReport, numericPartial: numericPartial || undefined } : {}),
                }),
                `Merge R${currentRound} G${group.idx + 1}`
              );

              const node: MergeNode = {
                text: merged?.mergedText ?? "",
                executiveHeader: merged?.executiveHeader ?? "",
                findings: merged?.findings ?? [],
              };
              nextNodes[group.idx] = node;

              // Persist checkpoint
              if (moduleRunId) {
                saveMergeCheckpointApi({
                  moduleRunId,
                  treeLevel: currentRound,
                  nodeIndex: group.idx,
                  mergedNode: node,
                }).catch((err: unknown) =>
                  console.error("Failed to save merge checkpoint:", err)
                );
              }
            } catch (err) {
              const msg =
                err && typeof err === "object" && "message" in err
                  ? String((err as { message: unknown }).message)
                  : String(err);
              toast.error(`[${MODULE_MAP[moduleId]?.displayName}] Merge failed: ${msg}`);
              // Fallback: concatenate all members in the group
              nextNodes[group.idx] = {
                text: group.members.map((m) => m.text).join("\n\n---\n\n"),
                executiveHeader: group.members.find((m) => m.executiveHeader)?.executiveHeader ?? "",
                findings: group.members.flatMap((m) => m.findings),
              };
            } finally {
              completed++;
              setModuleProgress(moduleId, {
                message: `Merging findings (round ${currentRound}/${totalMergeRounds}, ${completed}/${realGroups.length} done)…`,
                detail: {
                  current: currentRound,
                  total: totalMergeRounds + 1,
                  phase: "synthesizing",
                },
              });
            }
          });

          await Promise.all(batchPromises);
        }

        nodes = nextNodes.filter(Boolean);
      }

      return nodes[0];
    },
    [mergeFindings, setModuleProgress, useOpus, loadMergeCheckpointsApi, saveMergeCheckpointApi]
  );

  // ---------------------------------------------------------------------------
  // Coverage line builder
  // ---------------------------------------------------------------------------

  function buildCoverageLine(): string {
    const cov = coverageRef.current;
    if (!cov) return "";
    const incCount = cov.filesProcessed.length;
    const excCount = cov.filesExcluded.length;
    const totalDocs = incCount + excCount;
    let line = `Analyzed ${incCount} of ${totalDocs} documents (${cov.pagesProcessed} pages, ${cov.chunkCount} chunks).`;
    if (excCount > 0) {
      const excSummary = cov.filesExcluded
        .map((f) => `${f.fileName} (${f.reason}${f.detail ? ": " + f.detail : ""})`)
        .join("; ");
      line += ` Excluded: ${excSummary}.`;
    }
    return line;
  }

  // ---------------------------------------------------------------------------
  // Format report (shared across all modules)
  // ---------------------------------------------------------------------------

  const generateReport = useCallback(
    async (
      moduleId: string,
      finalMerge: MergeNode,
      totalSteps: number,
      coverageLine?: string,
      numericReport?: { figures: unknown[]; discrepancies: unknown[] } | null
    ) => {
      setModuleProgress(moduleId, {
        message: "Formatting final report…",
        detail: { current: totalSteps, total: totalSteps, phase: "synthesizing" },
      });

      const report = await withRetry(
        () => formatReport({
          moduleId,
          executiveHeader: finalMerge.executiveHeader,
          findings: finalMerge.findings,
          useOpus,
          coverageLine: coverageLine ?? null,
          ...(numericReport ? { numericReport } : {}),
        }),
        `FormatReport ${moduleId}`
      );

      return report?.fullReport ?? "";
    },
    [formatReport, setModuleProgress, useOpus]
  );

  // ---------------------------------------------------------------------------
  // Save module result
  // ---------------------------------------------------------------------------

  const saveModuleResult = useCallback(
    async (
      moduleId: string,
      result: {
        executiveHeader: string;
        findings: MergeNode["findings"];
        fullReport: string;
      },
      /** When provided, attaches output to this existing run (server-pipeline path). */
      existingRunId?: string
    ) => {
      // Update local state immediately for instant UI feedback
      setStatuses((prev) => ({
        ...prev,
        [moduleId]: {
          moduleId,
          latestRun: {
            id: existingRunId ?? crypto.randomUUID(),
            deal_id: dealId!,
            module_id: moduleId,
            status: "completed",
            triggered_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            documents_included: uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.name)
              : docs.map((d) => d.file_name),
            findings_count: result.findings.length,
            critical_count: result.findings.filter(
              (f) => f.severity === "critical"
            ).length,
          },
          latestOutput: {
            id: crypto.randomUUID(),
            module_run_id: existingRunId ?? crypto.randomUUID(),
            executive_header: result.executiveHeader,
            findings: result.findings,
            full_report_markdown: result.fullReport,
            created_at: new Date().toISOString(),
          },
        },
      }));

      // Persist to database in background
      if (dealId) {
        try {
          await saveModuleResultApi({
            dealId,
            moduleId,
            executiveHeader: result.executiveHeader,
            findings: result.findings,
            fullReport: result.fullReport,
            documentsIncluded: uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.name)
              : docs.map((d) => d.file_name),
            runId: existingRunId ?? null,
          });
        } catch (err) {
          console.error("Failed to persist module result:", err);
          // Don't toast — local state is already updated, user sees results
        }
      }
    },
    [dealId, uploadedFiles, docs, saveModuleResultApi]
  );

  // ---------------------------------------------------------------------------
  // Standard module pipeline: chunk → analyze → tree-merge → report
  // ---------------------------------------------------------------------------

  /**
   * Analyze chunks in parallel with bounded concurrency.
   * Returns extractions array (in chunk order) and any errors.
   */
  const analyzeChunksParallel = useCallback(
    async (
      moduleId: string,
      chunks: Array<{ label: string; sourceFile: string; text: string; pageImages: Array<{ pageNumber: number; text: string; imageBase64: string; mediaType: "image/jpeg" }> }>,
      progressPrefix = "Analyzing"
    ) => {
      const extractions: Array<{ label: string; extraction: string; chunkIndex: number }> = new Array(chunks.length);
      const errors: string[] = [];
      let completed = 0;

      setModuleProgress(moduleId, {
        message: `${progressPrefix} 0/${chunks.length} chunks…`,
        detail: { current: 0, total: chunks.length, phase: "analyzing" },
      });

      // Process in batches of CHUNK_CONCURRENCY
      for (let batchStart = 0; batchStart < chunks.length; batchStart += CHUNK_CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CHUNK_CONCURRENCY, chunks.length);
        const batch = chunks.slice(batchStart, batchEnd);

        const batchPromises = batch.map(async (chunk, batchIdx) => {
          const i = batchStart + batchIdx;
          try {
            const result = await analyzeChunk({
              moduleId,
              chunkIndex: i,
              totalChunks: chunks.length,
              chunk,
            });
            extractions[i] = result ?? { label: chunk.label, extraction: "", chunkIndex: i };
          } catch (err) {
            const msg =
              err && typeof err === "object" && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err);
            errors.push(`Chunk "${chunk.label}": ${msg}`);
            extractions[i] = {
              label: chunk.label,
              extraction: `### Extraction from: ${chunk.label}\n\n[Error: ${msg}]`,
              chunkIndex: i,
            };
          } finally {
            completed++;
            setModuleProgress(moduleId, {
              message: `${progressPrefix} ${completed}/${chunks.length} chunks…`,
              detail: { current: completed, total: chunks.length, phase: "analyzing" },
            });
          }
        });

        await Promise.all(batchPromises);
      }

      return { extractions, errors };
    },
    [analyzeChunk, setModuleProgress]
  );

  const runStandardModule = useCallback(
    async (moduleId: string, existingRunId?: string) => {
      const docsIncluded = uploadedFiles.length > 0
        ? uploadedFiles.map((f) => f.name)
        : docs.map((d) => d.file_name);

      // Create or reuse a run record with status "running"
      let runId = existingRunId;
      if (!runId && dealId) {
        try {
          const res = await updateRunStatusApi({
            runId: null,
            dealId,
            moduleId,
            status: "running",
            documentsIncluded: docsIncluded,
          });
          runId = res?.runId;
        } catch {
          // Non-fatal — continue without checkpointing
        }
      }

      // Track active run for cancellation
      if (runId) {
        activeRunIdRef.current[moduleId] = runId;
      }

      // Phase 1: Get or run universal extractions (shared across all modules)
      const allExtractions = await getOrRunUniversalExtractions(moduleId);

      // Check cancellation after extraction (may have been cancelled during batch loop)
      if (runId && cancelledRunsRef.current.has(runId)) {
        return; // Already cleaned up by handleCancelModule
      }

      if (allExtractions.length === 0) {
        toast.error("No processable content found. Check your files.");
        if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "failed" }).catch(() => {});
        return;
      }

      // Phase 2: Route — only send relevant chunks to this module
      const routed = getExtractionsForModule(allExtractions, moduleId);
      if (routed.length === 0) {
        toast.warning(
          `[${MODULE_MAP[moduleId]?.displayName}] No relevant document types found for this module. Tag your documents appropriately or tag as "Other" to include them.`
        );
        if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "failed" }).catch(() => {});
        return;
      }

      const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;
      setModuleProgress(moduleId, {
        message: `${routed.length} of ${allExtractions.length} chunks routed to ${displayName}…`,
      });

      // Convert TaggedExtraction[] to the format treeMerge expects
      const extractions = routed.map((ext) => ({
        label: ext.label,
        extraction: ext.extraction,
        chunkIndex: ext.chunkIndex,
      }));

      // Phase 3: Numeric Verification (numeric-eligible modules only)
      let numericReport: { figures: unknown[]; discrepancies: unknown[] } | null = null;
      let numericPartialFlag = false;
      if (NUMERIC_MODULES.has(moduleId) && docIdsForVerification.current.length > 0 && runId) {
        try {
          setModuleProgress(moduleId, { message: "Running deterministic numeric verification…" });
          const verifyResult = await numericVerifyApi({
            moduleRunId: runId,
            documentIds: docIdsForVerification.current,
          });
          if (verifyResult && (verifyResult.figureCount > 0 || verifyResult.discrepancyCount > 0)) {
            numericReport = {
              figures: verifyResult.figures ?? [],
              discrepancies: verifyResult.discrepancies ?? [],
            };
            numericPartialFlag = verifyResult.partial ?? false;
            if (verifyResult.criticalCount > 0) {
              toast.warning(
                `Numeric verification: ${verifyResult.criticalCount} critical discrepancy(ies) found — will be reported as findings.`
              );
            } else if (verifyResult.discrepancyCount > 0) {
              toast.info(`Numeric verification: ${verifyResult.discrepancyCount} discrepancy(ies) flagged.`);
            }
          } else {
            // No doc_tables data found — NumericVerify had nothing to verify.
            // This means the LLM will NOT receive any code-verified figures,
            // and the prompt guard will prevent it from hallucinating [Code-Verified] labels.
            console.warn(
              `[NumericVerify] Returned empty for ${docIdsForVerification.current.length} document(s). ` +
              `No structured tables found in doc_tables. Re-upload Excel/CSV files to enable numeric verification.`
            );
          }
        } catch (err) {
          // Non-fatal — log and continue without numeric report
          console.warn("[NumericVerify] Verification failed, continuing without:", err);
        }
      }

      // Phase 4: Tree-reduce merge (with checkpoint support)
      const finalMerge = await treeMerge(moduleId, extractions, runId, numericReport, numericPartialFlag);

      // Phase 3.5: Save coverage manifest and build coverage line
      const coverageLine = buildCoverageLine();
      if (runId && coverageRef.current) {
        saveRunCoverageApi({
          moduleRunId: runId,
          documentsIncluded: coverageRef.current.filesProcessed,
          documentsExcluded: coverageRef.current.filesExcluded,
          chunkCount: coverageRef.current.chunkCount,
          pagesProcessed: coverageRef.current.pagesProcessed,
        }).catch((err: unknown) => console.error("Failed to save coverage manifest:", err));
      }

      // Phase 5: Format report (with coverage line and numeric report)
      const totalMergeRounds = Math.ceil(Math.log2(Math.max(extractions.length, 2)));
      const fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine, numericReport);

      await saveModuleResult(moduleId, {
        executiveHeader: finalMerge.executiveHeader,
        findings: finalMerge.findings,
        fullReport,
      });

      // Mark run completed
      if (runId) updateRunStatusApi({ runId, dealId: dealId!, moduleId, status: "completed" }).catch(() => {});

      toast.success(`${displayName} complete!`);
    },
    [dealId, uploadedFiles, docs, getOrRunUniversalExtractions, treeMerge, generateReport, saveModuleResult, setModuleProgress, updateRunStatusApi, saveRunCoverageApi, numericVerifyApi]
  );

  // ---------------------------------------------------------------------------
  // Executive Summary pipeline: uses prior module outputs
  // ---------------------------------------------------------------------------

  const runExecutiveSummary = useCallback(async () => {
    const moduleId = "executive_summary";

    // Gather completed module outputs (excluding executive_summary itself)
    const priorModules = Object.entries(statuses).filter(
      ([id, s]) => id !== "executive_summary" && s.latestRun?.status === "completed" && s.latestOutput
    );

    if (priorModules.length === 0) {
      toast.error("Run at least one analysis module before generating the Executive Summary.");
      return;
    }

    // Build chunks from prior module outputs
    const execChunks = priorModules.map(([id, s]) => {
      const displayName = MODULE_MAP[id]?.displayName ?? id;
      const output = s.latestOutput!;
      return {
        label: displayName,
        sourceFile: `Module: ${displayName}`,
        text: `Module: ${displayName}\n\nExecutive Header: ${output.executive_header}\n\nFindings (${output.findings.length}):\n${output.findings
          .map(
            (f: { severity: string; title: string; detail: string }, fi: number) =>
              `${fi + 1}. [${f.severity}] ${f.title}: ${f.detail}`
          )
          .join("\n")}\n\nFull Report:\n${output.full_report_markdown}`,
        pageImages: [] as Array<{ pageNumber: number; text: string; imageBase64: string; mediaType: "image/jpeg" }>,
      };
    });

    // Analyze all module outputs in parallel
    const { extractions } = await analyzeChunksParallel(
      moduleId,
      execChunks,
      "Synthesizing module outputs"
    );

    // Tree-reduce merge
    const finalMerge = await treeMerge(moduleId, extractions);

    // Format report (with coverage line if available from prior runs)
    const coverageLine = buildCoverageLine();
    const totalMergeRounds = Math.ceil(Math.log2(Math.max(extractions.length, 2)));
    const fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine || undefined);

    await saveModuleResult(moduleId, {
      executiveHeader: finalMerge.executiveHeader,
      findings: finalMerge.findings,
      fullReport,
    });

    toast.success("Executive Summary complete!");
  }, [statuses, analyzeChunksParallel, treeMerge, generateReport, saveModuleResult, setModuleProgress]);

  // ---------------------------------------------------------------------------
  // Server-side pipeline: kick-off → poll → format report
  // The pipeline runs entirely on the server and survives browser tab closure.
  // ---------------------------------------------------------------------------

  const runServerPipeline = useCallback(
    async (moduleId: string, resumeRunId?: string) => {
      const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;

      // Fix 3 — resolved once per tab from the URL; false unless an operator opted in.
      const diagnosticOnly = diagnosticOnlyRef.current;
      if (diagnosticOnly) {
        console.warn(`[pipeline] diagnosticOnly=true for ${moduleId} (operator URL flag)`);
      }

      // Ensure universal extractions exist on the server
      // (they were saved during previous client-side runs or bulk-extract)
      setModuleProgress(moduleId, { message: "Preparing server-side pipeline…" });

      // Numeric verification (client-side, fast — needs doc_tables)
      let numericReport: { figures: unknown[]; discrepancies: unknown[] } | null = null;
      let numericPartial = false;
      if (NUMERIC_MODULES.has(moduleId) && docIdsForVerification.current.length > 0) {
        try {
          setModuleProgress(moduleId, { message: "Running deterministic numeric verification…" });
          const verifyResult = await numericVerifyApi({
            moduleRunId: crypto.randomUUID(), // placeholder — server creates real run
            documentIds: docIdsForVerification.current,
          });
          if (verifyResult && (verifyResult.figureCount > 0 || verifyResult.discrepancyCount > 0)) {
            numericReport = {
              figures: verifyResult.figures ?? [],
              discrepancies: verifyResult.discrepancies ?? [],
            };
            numericPartial = verifyResult.partial ?? false;
          }
        } catch (err) {
          console.warn("[NumericVerify] Verification failed, continuing without:", err);
        }
      }

      // Kick off server pipeline (or resume an existing one)
      setModuleProgress(moduleId, {
        message: resumeRunId ? "Resuming server-side analysis…" : "Starting server-side analysis…",
      });

      // Helper: call RunModulePipeline with network-error retries
      // The server pipeline runs independently — a fetch timeout doesn't mean it failed
      // B2 FIX — capture the owner token from the first response and pass it on resumes
      let pipelineOwnerToken: string | undefined;

      const callPipelineWithRetry = async (runIdArg?: string, diagnosticOnly: boolean = false) => {
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            return await runModulePipelineApi({
              dealId: dealId!,
              moduleId,
              runId: runIdArg ?? undefined,
              useOpus: useOpus || undefined,
              subjectDocumentIds: selectedSubjectIds.length > 0 ? selectedSubjectIds : undefined,
              numericReport,
              numericPartial: numericPartial || undefined,
              diagnosticOnly: diagnosticOnly || undefined,
              ownerToken: pipelineOwnerToken ?? undefined,
            });
          } catch (err) {
            const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
            const isNetworkError = /failed to fetch|network|timeout|abort|NETWORK_ERROR/i.test(msg);
            if (!isNetworkError || attempt === MAX_RETRIES - 1) throw err;
            // Wait before retry — server pipeline keeps running
            setModuleProgress(moduleId, { message: `Connection interrupted, retrying (${attempt + 2}/${MAX_RETRIES})…` });
            await new Promise(r => setTimeout(r, 10_000));
          }
        }
      };

      let pipelineResult = await callPipelineWithRetry(resumeRunId, diagnosticOnly);

      if (!pipelineResult) throw new Error("Pipeline returned no result");

      // B2 FIX — capture owner token from first response
      if ((pipelineResult as any).ownerToken) {
        pipelineOwnerToken = (pipelineResult as any).ownerToken;
      }

      const runId = pipelineResult.runId;
      activeRunIdRef.current[moduleId] = runId;

      // Poll loop: re-invoke pipeline if it returned in_progress (time budget)
      const POLL_INTERVAL_MS = 5_000;
      const MAX_POLLS = 120; // 10 min max polling (5s × 120)
      let pollCount = 0;

      // Mark that the pipeline polling loop is now active — the progress-poll
      // effect should stop overwriting progress messages for this module
      if (pipelineResult.status === "in_progress" || pipelineResult.status === "completed") {
        pipelinePollingActive.current.add(moduleId);
      }

      while (pipelineResult.status === "in_progress" && pollCount < MAX_POLLS) {
        // Update progress UI
        const prog = pipelineResult.progress;
        const phase = pipelineResult.phase;
        const failInfo = (pipelineResult as { failedChunks?: number; firstError?: string | null }).failedChunks
          ? ` (${(pipelineResult as { failedChunks?: number }).failedChunks} failed)`
          : "";
        if (phase === "cleanup") {
          setModuleProgress(moduleId, {
            message: `Cleaning documents… ${prog.analysisCompleted}/${prog.analysisTotal}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "extraction") {
          setModuleProgress(moduleId, {
            message: `Extracting documents… ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "web_research") {
          setModuleProgress(moduleId, {
            message: `Web research… iteration ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "researching" },
          });
        } else if (phase === "analysis") {
          setModuleProgress(moduleId, {
            message: `Analyzing chunks (server)… ${prog.analysisCompleted}/${prog.analysisTotal}${failInfo}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        } else if (phase === "merge") {
          const groupInfo = prog.mergeGroupsTotal
            ? ` — ${prog.mergeGroupsDone ?? 0}/${prog.mergeGroupsTotal} groups`
            : "";
          setModuleProgress(moduleId, {
            message: `Merging findings (server)… round ${prog.mergeRound}/${prog.mergeTotal}${groupInfo}`,
            detail: { current: prog.mergeRound, total: prog.mergeTotal, phase: "synthesizing" },
          });
        } else if (phase.startsWith("cc_reconciliation")) {
          // CC reconciliation path. Server emits `cc_reconciliation_<stage>`, where
          // <stage> is a STAGE_SEQUENCE member (or "init" before the first stage is
          // entered). The numeric `progress` fields are all zero on this path by
          // construction — routing/analysis/merge never run — so the stage index is
          // what we render. Deliberately NOT written to lastKnownCheckpointsRef: that
          // ref is compared against DB checkpoint counts (hundreds), and mixing a
          // 0–5 stage index into it would make the stall detector read false progress.
          const stageKey = phase.slice("cc_reconciliation_".length);
          const stageIdx = RECON_STAGE_LABELS.findIndex((s) => s.key === stageKey);
          const total = RECON_STAGE_LABELS.length;
          if (stageIdx >= 0) {
            setModuleProgress(moduleId, {
              message: `${RECON_STAGE_LABELS[stageIdx].label}… (step ${stageIdx + 1}/${total})`,
              detail: { current: stageIdx + 1, total, phase: "synthesizing" },
            });
          } else {
            // "init", or a stage added server-side that this list doesn't know yet.
            setModuleProgress(moduleId, {
              message: "Starting reconciliation…",
              detail: { current: 0, total, phase: "synthesizing" },
            });
          }
        } else {
          // Fallback so an unrecognized phase can never freeze the progress UI.
          // Before this branch existed, any phase outside the known set left the
          // last message on screen indefinitely, which reads as a hang.
          setModuleProgress(moduleId, {
            message: `Working (server)… ${phase}`,
            detail: { current: prog.analysisCompleted, total: prog.analysisTotal, phase: "analyzing" },
          });
        }

        // Check cancellation
        if (cancelledRunsRef.current.has(runId)) return;

        // Wait before re-invoking
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        pollCount++;

        // Check cancellation again after sleep
        if (cancelledRunsRef.current.has(runId)) return;

        // Re-invoke pipeline to continue from checkpoints
        const pollResult = await callPipelineWithRetry(runId, diagnosticOnly);

        if (!pollResult) throw new Error("Pipeline continuation returned no result");
        pipelineResult = pollResult;

        // Track checkpoint progress so the resume-failure handler knows if the server advanced
        if (pipelineResult.progress) {
          const prog = pipelineResult.progress;
          const total = (prog.analysisCompleted ?? 0) + (prog.mergeRound ?? 0);
          if (total > 0) lastKnownCheckpointsRef.current[moduleId] = total;
        }
      }

      if (pipelineResult.status === "cancelled") {
        // Server confirmed cancellation — exit cleanly without error toast
        console.log(`[pipeline] Run ${runId} confirmed cancelled at gate: ${pipelineResult.phase}`);
        return;
      }

      if (pipelineResult.status === "in_progress") {
        throw new Error("Pipeline timed out after maximum poll attempts");
      }

      if (pipelineResult.status === "failed") {
        const errDetail = (pipelineResult as { firstError?: string | null }).firstError;
        throw new Error(
          `Server pipeline failed during ${pipelineResult.phase}${errDetail ? `: ${errDetail}` : ""}`
        );
      }

      // Pipeline completed — format report
      const finalResult = pipelineResult.result;
      if (!finalResult) {
        // The server returns result:null when the run was already completed (synthetic response).
        // Fall back to loading the persisted output from module_outputs via GetRunOutput.
        console.log("[pipeline] result:null on completed — loading from GetRunOutput");
        const stored = await executeApi("GetRunOutput", { runId: pipelineResult.runId });
        if (!stored?.output) {
          throw new Error("Pipeline completed but no result returned and no persisted output found");
        }
        // MAT-F06 §4: Server-pipeline runs are already persisted by the canonical finalizer.
        // Just update local UI state — do NOT call SaveModuleResult (eliminates second-save).
        const storedOutput = stored.output!;
        setStatuses((prev) => ({
          ...prev,
          [moduleId]: {
            moduleId,
            latestRun: {
              id: pipelineResult.runId,
              deal_id: dealId!,
              module_id: moduleId,
              status: "completed",
              triggered_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              documents_included: uploadedFiles.length > 0
                ? uploadedFiles.map((f) => f.name)
                : docs.map((d) => d.file_name),
              findings_count: storedOutput.findings.length,
              critical_count: storedOutput.findings.filter(
                (f: any) => f.severity === "critical"
              ).length,
            },
            latestOutput: {
              id: crypto.randomUUID(),
              module_run_id: pipelineResult.runId,
              executive_header: storedOutput.executiveHeader,
              findings: storedOutput.findings as MergeNode["findings"],
              full_report_markdown: storedOutput.fullReport,
              created_at: new Date().toISOString(),
            },
          },
        }));
        toast.success(`${displayName} complete!`);
        return;
      }

      const finalMerge: MergeNode = {
        text: finalResult.mergedText,
        executiveHeader: finalResult.executiveHeader,
        findings: finalResult.findings as MergeNode["findings"],
      };

      // Use server-side formatted report if available (eliminates client-side FormatReport timeout).
      // Fall back to client-side formatting only when the pipeline didn't produce one.
      let fullReport: string;
      if (finalResult.fullReport) {
        console.log("[pipeline] Using server-side formatted report");
        fullReport = finalResult.fullReport;
      } else {
        const coverageLine = buildCoverageLine();
        const totalMergeRounds = pipelineResult.progress.mergeTotal;
        fullReport = await generateReport(moduleId, finalMerge, totalMergeRounds + 1, coverageLine, numericReport);
      }

      // MAT-F06 §4: Server-pipeline runs are already persisted by the canonical finalizer.
      // Just update local UI state — do NOT call SaveModuleResult (eliminates second-save).
      setStatuses((prev) => ({
        ...prev,
        [moduleId]: {
          moduleId,
          latestRun: {
            id: runId,
            deal_id: dealId!,
            module_id: moduleId,
            status: "completed",
            triggered_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            documents_included: uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.name)
              : docs.map((d) => d.file_name),
            findings_count: finalMerge.findings.length,
            critical_count: finalMerge.findings.filter(
              (f) => f.severity === "critical"
            ).length,
          },
          latestOutput: {
            id: crypto.randomUUID(),
            module_run_id: runId,
            executive_header: finalMerge.executiveHeader,
            findings: finalMerge.findings,
            full_report_markdown: fullReport,
            created_at: new Date().toISOString(),
          },
        },
      }));

      toast.success(`${displayName} complete!`);
    },
    [dealId, useOpus, selectedSubjectIds, numericVerifyApi, runModulePipelineApi, getRunProgressApi, generateReport, setModuleProgress, uploadedFiles, docs, setStatuses]
  );

  // ---------------------------------------------------------------------------
  // BSS v2 — orchestrator poll loop
  // ---------------------------------------------------------------------------

  /** Human-readable stage labels for BSS progress display */
  const BSS_STAGE_LABELS: Record<string, string> = {
    structural_profile: "Building structural profile",
    thesis_profile: "Building thesis profile",
    blind_pass: "Generating blind-pass candidates",
    informed_pass: "Generating informed-pass candidates",
    coverage_sweep: "Sweeping coverage",
    adjudication: "Adjudicating candidates",
  };

  /** Human-readable stage labels for ERO progress display */
  const ERO_STAGE_LABELS: Record<string, string> = {
    build_entity_manifest: "Building entity manifest",
    build_deal_profile: "Analyzing deal profile",
    generate_hypotheses: "Generating hypotheses",
    rank_hypotheses: "Ranking hypotheses",
    research_execution: "Researching external evidence",
    adjudicate_findings: "Adjudicating findings",
    corpus_confrontation: "Corpus confrontation",
    render: "Rendering report",
  };

  /** Human-readable stage labels for DCS progress display */
  const DCS_STAGE_LABELS: Record<string, string> = {
    extract: "Extracting evidence",
    verdicts: "Computing dimension verdicts",
    summary: "Computing headline score",
    rationales: "Generating dimension rationales",
    overlay: "Analyzing materiality overlay", // legacy fallback
    render: "Rendering IC-facing report",
    complete: "Publishing results",
  };

  const runBssPipeline = useCallback(
    async () => {
      if (!dealId) return;

      // Mint owner token ONCE per run — held in ref, reused across all poll invocations
      const ownerToken = crypto.randomUUID();
      bssOwnerTokenRef.current = ownerToken;
      setBssOverride(null);

      pipelinePollingActive.current.add("blind_spot_scanner");

      const BSS_POLL_INTERVAL_MS = 3_000;
      const BSS_MAX_POLLS = 200; // 200 × 3s = 10 min ceiling
      let pollCount = 0;
      let terminal = false;

      while (!terminal && pollCount < BSS_MAX_POLLS) {
        // Always use the SAME ownerToken minted at the start — never re-mint
        const token = bssOwnerTokenRef.current!;

        let result: {
          status: string;
          stage: string | null;
          nextStage: string | null;
          itemsDone: number | null;
          itemsTotal: number | null;
          error: string | null;
          elapsedMs: number;
        };

        try {
          const raw = await bssRunPipelineApi({ dealId, ownerToken: token });
          if (!raw) throw new Error("BssRunPipeline returned no result");
          result = raw;
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
          const isNetwork = /failed to fetch|network|timeout|abort/i.test(msg);
          if (isNetwork && pollCount < BSS_MAX_POLLS - 1) {
            // Transient network error — retry after interval
            setModuleProgress("blind_spot_scanner", {
              message: `Connection interrupted, retrying… (${pollCount + 1})`,
            });
            await new Promise(r => setTimeout(r, BSS_POLL_INTERVAL_MS));
            pollCount++;
            continue;
          }
          throw err;
        }

        switch (result.status) {
          case "advanced": {
            const stageLabel = result.stage ? (BSS_STAGE_LABELS[result.stage] ?? result.stage) : "—";
            const nextLabel = result.nextStage ? (BSS_STAGE_LABELS[result.nextStage] ?? result.nextStage) : "finishing";
            setModuleProgress("blind_spot_scanner", {
              message: `${stageLabel} ✓ — next: ${nextLabel}`,
              detail: result.itemsDone != null && result.itemsTotal != null
                ? { current: result.itemsDone, total: result.itemsTotal, phase: "analyzing" }
                : null,
            });
            break;
          }

          case "stage_partial": {
            const stageLabel = result.stage ? (BSS_STAGE_LABELS[result.stage] ?? result.stage) : "—";
            setModuleProgress("blind_spot_scanner", {
              message: `${stageLabel}… ${result.itemsDone ?? 0}/${result.itemsTotal ?? "?"}`,
              detail: result.itemsDone != null && result.itemsTotal != null
                ? { current: result.itemsDone, total: result.itemsTotal, phase: "analyzing" }
                : null,
            });
            break;
          }

          case "owned_elsewhere": {
            // Another tab/user owns this run — STOP, do not fight for the claim
            terminal = true;
            toast.warning("Blind Spot Scanner is already running in another tab or by another user.");
            setModuleProgress("blind_spot_scanner", {
              message: "Run owned by another session — stopped.",
            });
            // Mark as not running so the card doesn't show a spinner
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete("blind_spot_scanner");
              return next;
            });
            pipelinePollingActive.current.delete("blind_spot_scanner");
            return; // Exit without throw — this is not an error
          }

          case "failed": {
            terminal = true;
            const stageLabel = result.stage ? (BSS_STAGE_LABELS[result.stage] ?? result.stage) : "unknown";
            throw new Error(`BSS pipeline failed at ${stageLabel}: ${result.error ?? "unknown error"}`);
          }

          case "done": {
            terminal = true;
            setModuleProgress("blind_spot_scanner", {
              message: "Loading findings…",
            });
            // Fetch findings and funnel
            const findingsData = await bssGetFindingsApi({ dealId });
            if (!findingsData) throw new Error("BssGetFindings returned no result");
            const bssFindings = findingsData.findings as BssFinding[];
            const bssFunnel = findingsData.funnel as BssFunnel;
            setBssOverride({ findings: bssFindings, funnel: bssFunnel });
            // Update module status to completed — populate standard latestOutput
            const bssOutput = bssToModuleOutput(bssFindings, bssFunnel, dealId);
            setStatuses((prev) => ({
              ...prev,
              blind_spot_scanner: {
                moduleId: "blind_spot_scanner",
                latestRun: {
                  id: `bss-v2-${dealId}`,
                  deal_id: dealId,
                  module_id: "blind_spot_scanner",
                  status: "completed",
                  triggered_at: new Date().toISOString(),
                  completed_at: new Date().toISOString(),
                  documents_included: docs.map((d) => d.file_name),
                  findings_count: bssFindings.length,
                  critical_count: bssFindings.length, // all BSS findings are critical-tier
                },
                latestOutput: bssOutput,
              },
            }));
            toast.success("Blind Spot Scanner complete!");
            break;
          }

          default: {
            console.warn(`[BSS] Unexpected status: ${result.status}`);
            break;
          }
        }

        if (!terminal) {
          await new Promise(r => setTimeout(r, BSS_POLL_INTERVAL_MS));
          pollCount++;
        }
      }

      if (!terminal) {
        throw new Error("BSS pipeline timed out after maximum poll attempts");
      }
    },
    [dealId, bssRunPipelineApi, bssGetFindingsApi, setModuleProgress, setStatuses, docs],
  );

  // ---------------------------------------------------------------------------
  // ERO v2 — poll-loop orchestrator
  // ---------------------------------------------------------------------------

  const runEroPipeline = useCallback(
    async (resumeRunId?: string) => {
      if (!dealId) return;

      pipelinePollingActive.current.add("external_risk_overlay");

      const ERO_POLL_INTERVAL_MS = 3_000;
      const ERO_BACKOFF_MAX_MS = 30_000;    // max wait between retries on timeout
      const ERO_MAX_POLLS = 300;
      let pollCount = 0;
      let consecutiveTimeouts = 0;          // tracks sequential network errors for backoff
      let eroRunId: string | null = resumeRunId ?? null;

      if (!eroRunId) {
        // ── 1. Create the run ──────────────────────────────────────
        setModuleProgress("external_risk_overlay", {
          message: "Creating ERO run…",
        });

        try {
          const createResult = await eroRunPipelineApi({ dealId, runId: null });
          if (!createResult) throw new Error("EroRunPipeline returned no result");
          eroRunId = createResult.runId;
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
          throw new Error(`ERO: failed to create run — ${msg}`);
        }
      } else {
        // Resuming an existing run — show progress immediately
        setModuleProgress("external_risk_overlay", {
          message: "Resuming ERO pipeline…",
        });
      }

      // ── 2. Poll loop ───────────────────────────────────────────────
      let terminal = false;
      while (!terminal && pollCount < ERO_MAX_POLLS) {
        let result: {
          runId: string;
          stage: string;
          status: string;
          invocationCount: number;
          message: string;
          stageData: Record<string, unknown> | null;
        };

        try {
          const raw = await eroRunPipelineApi({ dealId, runId: eroRunId });
          if (!raw) throw new Error("EroRunPipeline returned no result");
          result = raw;
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
          const isNetwork = /failed to fetch|network|timeout|abort/i.test(msg);
          if (isNetwork && pollCount < ERO_MAX_POLLS - 1) {
            consecutiveTimeouts++;
            // Exponential backoff: 3s → 6s → 12s → 24s → 30s cap
            // Gives the server time to finish the in-flight stage
            const backoff = Math.min(
              ERO_POLL_INTERVAL_MS * Math.pow(2, consecutiveTimeouts - 1),
              ERO_BACKOFF_MAX_MS,
            );
            setModuleProgress("external_risk_overlay", {
              message: `Connection interrupted, retrying in ${Math.round(backoff / 1000)}s… (attempt ${consecutiveTimeouts})`,
            });
            await new Promise(r => setTimeout(r, backoff));
            pollCount++;
            continue;
          }
          throw err;
        }

        // Successful response — reset backoff counter
        consecutiveTimeouts = 0;

        const stageLabel = ERO_STAGE_LABELS[result.stage] ?? result.stage;

        switch (result.status) {
          case "complete": {
            // "complete" means the CURRENT STAGE finished. The pipeline is only
            // truly done when the last stage ("render") returns complete.
            if (result.stage === "render") {
              // Pipeline fully done — publish to module_outputs then refresh dashboard
              terminal = true;
              setModuleProgress("external_risk_overlay", {
                message: "Publishing ERO results…",
              });
              try {
                await publishEroApi({ runId: eroRunId });
              } catch (pubErr) {
                console.error("[ERO] Publish failed:", pubErr);
              }
              await refetchModules();
              toast.success("External Risk Overlay complete!");
            } else {
              // Intermediate stage completed — show progress, keep polling
              const stageIdx = [
                "build_entity_manifest", "build_deal_profile", "generate_hypotheses",
                "rank_hypotheses", "research_execution", "adjudicate_findings",
                "corpus_confrontation", "render",
              ].indexOf(result.stage);
              setModuleProgress("external_risk_overlay", {
                message: `${stageLabel} ✓`,
                detail: { current: stageIdx + 1, total: 8, phase: "researching" },
              });
            }
            break;
          }

          case "in_progress":
          case "pending": {
            setModuleProgress("external_risk_overlay", {
              message: `${stageLabel}…`,
              detail: { current: result.invocationCount, total: 8, phase: "researching" },
            });
            break;
          }

          case "failed": {
            terminal = true;
            throw new Error(`ERO pipeline failed at ${stageLabel}: ${result.message}`);
          }

          default: {
            // "not_implemented" or any other transitional status — keep polling
            setModuleProgress("external_risk_overlay", {
              message: `${stageLabel}… (${result.status})`,
            });
            break;
          }
        }

        if (!terminal) {
          await new Promise(r => setTimeout(r, ERO_POLL_INTERVAL_MS));
          pollCount++;
        }
      }

      if (!terminal) {
        throw new Error("ERO pipeline timed out after maximum poll attempts");
      }
    },
    [dealId, eroRunPipelineApi, publishEroApi, setModuleProgress, refetchModules],
  );

  // ---------------------------------------------------------------------------
  // Auto-resume ERO polling on mount / HMR
  // ---------------------------------------------------------------------------
  // If there's an active (non-terminal) ERO run when the component mounts
  // (e.g. after HMR, page navigation, or tab reload), automatically start
  // the poll loop so the UI shows progress without the user re-clicking Run.
  useEffect(() => {
    if (!dealId) return;
    // Guard: if an ERO poll loop is already active, skip
    if (pipelinePollingActive.current.has("external_risk_overlay")) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      // Re-check after timeout in case a user-initiated run started
      if (pipelinePollingActive.current.has("external_risk_overlay")) return;

      try {
        const result = await executeApi("EroGetActiveRun", { dealId });
        if (cancelled || !result?.activeRun) return;

        const { runId, stageStatus } = result.activeRun;
        // Only resume if the run is actively in progress
        if (stageStatus === "running" || stageStatus === "pending" || stageStatus === "complete") {
          // Double-check: still no poll loop running?
          if (pipelinePollingActive.current.has("external_risk_overlay")) return;
          // Mark as running in the module set so the UI shows the progress card
          setRunningModules((prev) => new Set(prev).add("external_risk_overlay"));
          // Launch the poll loop with the existing runId (skips run creation)
          runEroPipeline(runId).catch((err) => {
            console.error("[ERO auto-resume] poll loop error:", err);
          }).finally(() => {
            if (cancelled) return;
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete("external_risk_overlay");
              return next;
            });
            clearModuleProgress("external_risk_overlay");
            pipelinePollingActive.current.delete("external_risk_overlay");
          });
        }
      } catch {
        // Silent — don't block page load for a resume check failure
      }
    }, 500); // Brief delay to let user-initiated runs claim the slot first

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dealId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // DCS rebuild — orchestrator poll loop
  // ---------------------------------------------------------------------------

  const runDcsPipeline = useCallback(
    async () => {
      if (!dealId) return;

      // Mint owner token ONCE per run — held in ref, reused across all poll invocations
      const ownerToken = crypto.randomUUID();
      dcsOwnerTokenRef.current = ownerToken;

      pipelinePollingActive.current.add("diligence_completeness");

      const DCS_POLL_INTERVAL_MS = 3_000;
      const DCS_BACKOFF_MAX_MS = 30_000;
      // No fixed poll ceiling — DCS corpus runs can take hours (extract stage iterates
      // over thousands of chunks). The poll loop runs until a terminal status.
      let pollCount = 0;
      let consecutiveTimeouts = 0;
      let terminal = false;
      let dcsRunId: string | null = null;

      while (!terminal) {
        const token = dcsOwnerTokenRef.current!;

        let result: {
          runId: string;
          ownerToken: string;
          status: string;
          stage: string | null;
          nextStage: string | null;
          resumeRequired: boolean;
          savedCursor: string | null;
          remainingChunks: number | null;
          elapsedMs: number;
          error: string | null;
          reportOverride: string | null;
          headerOverride: string | null;
          reportHash: string | null;
          headlineScore: number | null;
        };

        try {
          const raw = await dcsRunPipelineApi({
            dealId,
            runId: dcsRunId,
            ownerToken: token,
            batchSize: 32,
            concurrency: 4,
          });
          if (!raw) throw new Error("DcsRunPipeline returned no result");
          result = raw;
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
          const isNetwork = /failed to fetch|network|timeout|abort/i.test(msg);
          if (isNetwork) {
            consecutiveTimeouts++;
            const backoff = Math.min(
              DCS_POLL_INTERVAL_MS * Math.pow(2, consecutiveTimeouts - 1),
              DCS_BACKOFF_MAX_MS,
            );
            setModuleProgress("diligence_completeness", {
              message: `Connection interrupted, retrying in ${Math.round(backoff / 1000)}s… (attempt ${consecutiveTimeouts})`,
            });
            await new Promise(r => setTimeout(r, backoff));
            pollCount++;
            continue;
          }
          throw err;
        }

        // Successful response — reset backoff counter
        consecutiveTimeouts = 0;

        // Capture runId from first response
        if (!dcsRunId && result.runId) {
          dcsRunId = result.runId;
        }

        const stageLabel = result.stage ? (DCS_STAGE_LABELS[result.stage] ?? result.stage) : "—";

        switch (result.status) {
          case "created": {
            // Run just created — save runId, continue polling
            dcsRunId = result.runId;
            setModuleProgress("diligence_completeness", {
              message: "Pipeline created — starting extraction…",
            });
            break;
          }

          case "advanced": {
            const nextLabel = result.nextStage
              ? (DCS_STAGE_LABELS[result.nextStage] ?? result.nextStage)
              : "finishing";
            setModuleProgress("diligence_completeness", {
              message: `${stageLabel} ✓ — next: ${nextLabel}`,
            detail: result.headlineScore != null
              ? { current: Math.round(result.headlineScore), total: 100, phase: "analyzing" }
              : null,
            });
            break;
          }

          case "stage_partial": {
            // Extract stage partial — show chunk progress
            const remaining = result.remainingChunks ?? 0;
            setModuleProgress("diligence_completeness", {
              message: `${stageLabel}… ${remaining > 0 ? `${remaining} chunks remaining` : "processing"}`,
            detail: remaining > 0
              ? { current: 0, total: remaining, phase: "analyzing" }
              : null,
            });
            break;
          }

          case "in_progress": {
            // Another invocation is already working — wait and retry
            setModuleProgress("diligence_completeness", {
              message: `${stageLabel}… waiting for in-flight invocation`,
            });
            break;
          }

          case "owned_elsewhere": {
            terminal = true;
            toast.warning("Diligence Completeness is already running in another tab or by another user.");
            setModuleProgress("diligence_completeness", {
              message: "Run owned by another session — stopped.",
            });
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete("diligence_completeness");
              return next;
            });
            pipelinePollingActive.current.delete("diligence_completeness");
            dcsOwnerTokenRef.current = null;
            return; // Non-error exit
          }

          case "failed": {
            terminal = true;
            dcsOwnerTokenRef.current = null;
            throw new Error(
              `DCS pipeline failed at ${stageLabel}: ${result.error ?? "unknown error"}`,
            );
          }

          case "done": {
            terminal = true;
            dcsOwnerTokenRef.current = null;
            setModuleProgress("diligence_completeness", {
              message: "Refreshing results…",
            });
            // Refresh module results from DB — module_outputs was published server-side
            await refetchModules();
            toast.success("Diligence Completeness report complete!");
            break;
          }

          default: {
            console.warn(`[DCS] Unexpected status: ${result.status}`);
            break;
          }
        }

        if (!terminal) {
          await new Promise(r => setTimeout(r, DCS_POLL_INTERVAL_MS));
          pollCount++;
        }
      }
    },
    [dealId, dcsRunPipelineApi, setModuleProgress, refetchModules],
  );

  // ---------------------------------------------------------------------------
  // MAST v2 stage labels
  // ---------------------------------------------------------------------------

  const MAST_STAGE_LABELS: Record<string, string> = {
    register_model_drivers: "Extracting model drivers",
    register_silent: "Detecting silent assumptions",
    register_memo: "Scanning memo",
    register_assemble: "Assembling register",
    propositionalize: "Rewriting propositions",
    reliance_links: "Linking reliance",
    inheritance: "Checking inheritance",
    emergent: "Detecting emergent patterns",
    support_search: "Sweeping corpus for support",
    forecast_recursion: "Recursing forecasts",
    lineage: "Tracing lineage",
    dependence: "Scoring dependence",
    severity: "Computing severity",
    fragility: "Generating falsification conditions",
    render: "Rendering report",
  };

  // ---------------------------------------------------------------------------
  // MAST v2 — poll-loop orchestrator
  // ---------------------------------------------------------------------------

  const runMastPipeline = useCallback(
    async (resumeRunId?: string) => {
      if (!dealId) return;

      pipelinePollingActive.current.add("model_assumptions_stress");

      const MAST_POLL_INTERVAL_MS = 3_000;
      const MAST_MAX_OWNED_ELSEWHERE = 5;
      let consecutiveOwnedElsewhere = 0;

      setModuleProgress("model_assumptions_stress", {
        message: "Starting MAST v2 pipeline…",
      });

      let terminal = false;

      while (!terminal) {
        let result: {
          status: string;
          stage: string | null;
          resumePosition: number;
          itemsTotal: number;
          message: string;
          runId: string;
        };

        try {
          const raw = await mastRunPipelineApi({ dealId, runId: resumeRunId ?? undefined });
          if (!raw) throw new Error("MastRunPipeline returned no result");
          result = raw;
          // Capture runId for resume after first call
          if (!resumeRunId && result.runId) {
            resumeRunId = result.runId;
            activeRunIdRef.current["model_assumptions_stress"] = result.runId;
          }
        } catch (err) {
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
          const isNetwork = /failed to fetch|network|timeout|abort/i.test(msg);
          if (isNetwork) {
            setModuleProgress("model_assumptions_stress", {
              message: "Connection interrupted, retrying…",
            });
            await new Promise(r => setTimeout(r, MAST_POLL_INTERVAL_MS * 2));
            continue;
          }
          throw err;
        }

        const stageLabel = result.stage
          ? (MAST_STAGE_LABELS[result.stage] ?? result.stage)
          : "initializing";

        switch (result.status) {
          case "done": {
            terminal = true;
            setModuleProgress("model_assumptions_stress", {
              message: "MAST complete — refreshing…",
            });
            await refetchModules();
            toast.success("Model Assumptions Stress Test complete!");
            break;
          }

          case "advanced":
          case "stage_partial": {
            consecutiveOwnedElsewhere = 0;
            const progress = result.resumePosition > 0 && result.itemsTotal > 0
              ? ` (${result.resumePosition}/${result.itemsTotal})`
              : "";
            setModuleProgress("model_assumptions_stress", {
              message: `${stageLabel}${progress}…`,
            });
            break;
          }

          case "failed": {
            terminal = true;
            throw new Error(`MAST pipeline failed at ${stageLabel}: ${result.message}`);
          }

          case "owned_elsewhere": {
            consecutiveOwnedElsewhere++;
            console.log(
              `[MAST-POLL] OWNED_ELSEWHERE consecutive=${consecutiveOwnedElsewhere} of ${MAST_MAX_OWNED_ELSEWHERE}`,
            );
            if (consecutiveOwnedElsewhere >= MAST_MAX_OWNED_ELSEWHERE) {
              terminal = true;
              setModuleProgress("model_assumptions_stress", {
                message: "A MAST run is already in progress from another session.",
              });
              toast.warning("A MAST run is already in progress. Please wait for it to complete.");
              break;
            }
            setModuleProgress("model_assumptions_stress", {
              message: "Waiting for lock…",
            });
            await new Promise(r => setTimeout(r, MAST_POLL_INTERVAL_MS * 3));
            continue; // skip the normal poll delay
          }

          default: {
            consecutiveOwnedElsewhere = 0;
            setModuleProgress("model_assumptions_stress", {
              message: `${stageLabel}… (${result.status})`,
            });
            break;
          }
        }

        if (!terminal) {
          await new Promise(r => setTimeout(r, MAST_POLL_INTERVAL_MS));
        }
      }
    },
    [dealId, mastRunPipelineApi, setModuleProgress, refetchModules],
  );

  // ---------------------------------------------------------------------------
  // Run single module
  // ---------------------------------------------------------------------------

  const handleRunModule = useCallback(
    async (moduleId: string, resumeRunId?: string) => {
      // Hard kill — never resume a module that was explicitly killed this session
      if (killedModulesRef.current.has(moduleId)) {
        console.warn(`[handleRunModule] ${moduleId} is killed — ignoring`);
        return;
      }

      // Skip the "already running" guard when resuming — we're reconnecting to an existing run
      if (!resumeRunId && runningModules.has(moduleId)) {
        toast.info("This module is already running.");
        return;
      }

      // Executive Summary — special handling
      if (moduleId === "executive_summary") {
        const priorCompleted = Object.entries(statuses).filter(
          ([id, s]) => id !== "executive_summary" && s.latestRun?.status === "completed"
        );
        if (priorCompleted.length === 0) {
          toast.warning("Run at least one other module first before generating the Executive Summary.");
          return;
        }
      } else if (!resumeRunId && uploadedFiles.length === 0 && docs.length === 0) {
        toast.warning("Upload at least one document before running analysis.");
        return;
      }

      setRunningModules((prev) => new Set(prev).add(moduleId));
      // Also update statuses so the progress poll effect includes this module
      // in dbRunningIds (otherwise a prior cancel leaves status as "failed")
      setStatuses((prev) => {
        const current = prev[moduleId];
        return {
          ...prev,
          [moduleId]: {
            ...current,
            latestRun: current?.latestRun
              ? { ...current.latestRun, status: "running" as const }
              : { id: "", deal_id: dealId ?? "", module_id: moduleId, status: "running" as const, triggered_at: new Date().toISOString(), completed_at: null, documents_included: [], findings_count: 0, critical_count: 0 },
          },
        };
      });
      setProgressMap((prev) => ({
        ...prev,
        [moduleId]: { message: "Starting…", detail: null, chunkErrors: [] },
      }));

      // NOTE: PurgeStaleRuns is deliberately NOT called here any more.
      //
      // It used to fire-and-forget on every run start with
      // `excludeModuleId: moduleId`. That exclusion means it could never clear
      // the only thing that actually blocks the module being started — the
      // run-creation CTE guard in pipeline-core keys on
      // (deal_id, module_id, status='running') for the SAME module, which the
      // exclusion skips by construction. So the call provided zero benefit to
      // the run it was attached to, and its only observable effect was marking
      // OTHER modules' long-running rows as 'failed' as a side effect of
      // pressing Run on an unrelated module.
      //
      // Zombie cleanup is a deliberate operator action, not a side effect of
      // starting a run. The PurgeStaleRuns API still exists server-side for
      // that purpose.

      let exitedEarlyForResume = false;

      try {
        if (moduleId === "executive_summary") {
          await runExecutiveSummary();
        } else if (moduleId === "blind_spot_scanner" && dealId) {
          // BSS v2 divert — uses BssRunPipeline orchestrator instead of v1
          await runBssPipeline();
        } else if (moduleId === "external_risk_overlay" && dealId) {
          // ERO v2 divert — uses EroRunPipeline orchestrator instead of v1
          await runEroPipeline();
        } else if (moduleId === "diligence_completeness" && dealId) {
          // DCS rebuild — uses DcsRunPipeline orchestrator instead of v1
          await runDcsPipeline();
        } else if (moduleId === "model_assumptions_stress" && dealId) {
          // MAST v2 divert — uses MastRunPipeline orchestrator instead of v1
          await runMastPipeline(resumeRunId);
        } else if (dealId) {
          // Server-side pipeline: survives tab closure, checkpointed
          // (web research modules now use the same server pipeline path)
          await runServerPipeline(moduleId, resumeRunId);
        } else {
          // Fallback: client-side pipeline (no-deal edge case)
          await runStandardModule(moduleId, resumeRunId);
        }
      } catch (err) {
        const message =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        const isTimeoutOrNetwork = /timeout|timed out|abort|cancel|failed to fetch|network/i.test(message);
        const displayName = MODULE_MAP[moduleId]?.displayName ?? moduleId;

        if (resumeRunId && isTimeoutOrNetwork && dealId) {
          // Before counting as a failure, check if the server actually made progress
          // (wrote new checkpoints). If it did, the server is working — the fetch just
          // timed out at the platform's 300s limit. Reset the counter and let heartbeat retry.
          let serverMadeProgress = false;
          try {
            const progress = await getRunProgressApi({ dealId });
            const runs = progress?.runs ?? [];
            const run = runs.find((r: { moduleId: string }) => r.moduleId === moduleId);
            if (run) {
              // Sum all three signals. Analysis and merge counts are structurally
              // zero on the CC reconciliation path (both phases are skipped), where
              // stage checkpoints are the only thing that advances. All three counts
              // are non-decreasing, so ANY one of them increasing increases the sum.
              const currentCheckpoints =
                (run.analysisCheckpointCount ?? 0) +
                (run.mergeCheckpointCount ?? 0) +
                (run.stageCheckpointCount ?? 0);
              const lastKnown = lastKnownCheckpointsRef.current[moduleId] ?? 0;
              if (currentCheckpoints > lastKnown) {
                serverMadeProgress = true;
                lastKnownCheckpointsRef.current[moduleId] = currentCheckpoints;
              }
            }
          } catch {
            // GetRunProgress failed too — can't determine progress, fall through to failure logic
          }

          if (serverMadeProgress) {
            // Server IS working (checkpoints advanced) — reset failure counter, let heartbeat retry
            resumeFailureCountRef.current[moduleId] = 0;
            console.log(`[handleRunModule] ${moduleId}: fetch timed out but server made progress (checkpoints advanced) — will retry`);
            toast.info(`[${displayName}] Server pipeline is making progress. Reconnecting…`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;
            return;
          }

          // Server did NOT advance — count as a genuine failure
          const count = (resumeFailureCountRef.current[moduleId] ?? 0) + 1;
          resumeFailureCountRef.current[moduleId] = count;

          if (count >= 5) {
            // Five consecutive failures with no checkpoint progress — enter backoff-and-retry
            // (Freeze Exception #4): instead of permanently killing, wait 2 minutes and try
            // one last resume. ResumeStalePipelines is idempotent and safe to call speculatively.
            console.warn(`[handleRunModule] ${moduleId}: ${count} consecutive resume failures with no progress — entering 2-min backoff`);
            toast.warning(`[${displayName}] Server appears stalled after ${count} attempts with no progress. Waiting 2 minutes before final retry…`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;

            // Fire-and-forget: backoff then one last attempt
            setTimeout(async () => {
              try {
                // Check progress one more time after the 2-min wait
                let progressAfterWait = false;
                try {
                  const progress = await getRunProgressApi({ dealId: dealId! });
                  const runs = progress?.runs ?? [];
                  const run = runs.find((r: { moduleId: string }) => r.moduleId === moduleId);
                  if (run) {
                    // Same three-signal sum as the first-pass check above.
                    const currentCp =
                      (run.analysisCheckpointCount ?? 0) +
                      (run.mergeCheckpointCount ?? 0) +
                      (run.stageCheckpointCount ?? 0);
                    const lastKnown = lastKnownCheckpointsRef.current[moduleId] ?? 0;
                    if (currentCp > lastKnown) {
                      progressAfterWait = true;
                      lastKnownCheckpointsRef.current[moduleId] = currentCp;
                    }
                  }
                } catch { /* ignore */ }

                if (progressAfterWait) {
                  // Server recovered during backoff — reset and let heartbeat continue
                  resumeFailureCountRef.current[moduleId] = 0;
                  console.log(`[handleRunModule] ${moduleId}: progress detected during backoff — recovered`);
                  toast.success(`[${MODULE_MAP[moduleId]?.displayName ?? moduleId}] Server recovered — resuming.`);
                  return;
                }

                // No progress during backoff — attempt one final resume
                console.log(`[handleRunModule] ${moduleId}: backoff complete, attempting final resume`);
                resumeFailureCountRef.current[moduleId] = 0; // Reset for the last attempt
                await handleRunModule(moduleId, resumeRunId);

                // If handleRunModule returned without throw, it's either running or heartbeat handles it
              } catch (backoffErr) {
                // Final attempt also failed — now permanently kill
                console.error(`[handleRunModule] ${moduleId}: post-backoff resume also failed — permanently killing`, backoffErr);
                killedModulesRef.current.add(moduleId);
                toast.error(`[${MODULE_MAP[moduleId]?.displayName ?? moduleId}] Server stalled after backoff retry — stopped. Refresh to retry.`);
                setRunningModules((prev) => {
                  const next = new Set(prev);
                  next.delete(moduleId);
                  return next;
                });
                clearModuleProgress(moduleId);
                pipelinePollingActive.current.delete(moduleId);
              }
            }, 120_000); // 2-minute backoff

            return;
          } else {
            // Not yet at kill threshold — give it another chance
            toast.info(`[${displayName}] Connection to server pipeline timed out. The analysis continues server-side — progress will update automatically.`);
            pipelinePollingActive.current.delete(moduleId);
            exitedEarlyForResume = true;
            return;
          }
        }

        const hint = isTimeoutOrNetwork ? " Try with fewer or smaller files." : "";
        toast.error(`[${displayName}] Analysis failed: ${message}${hint}`);
      } finally {
        if (!exitedEarlyForResume) {
          setRunningModules((prev) => {
            const next = new Set(prev);
            next.delete(moduleId);
            return next;
          });
          clearModuleProgress(moduleId);
          pipelinePollingActive.current.delete(moduleId);
          // Reset resume failure counter on clean exit (success or non-network error)
          delete resumeFailureCountRef.current[moduleId];
          // Clean up cancellation tracking
          const finishedRunId = activeRunIdRef.current[moduleId];
          if (finishedRunId) {
            cancelledRunsRef.current.delete(finishedRunId);
            delete activeRunIdRef.current[moduleId];
          }
        }
      }
    },
    [
      runningModules,
      uploadedFiles,
      docs,
      statuses,
      dealId,
      runStandardModule,
      runServerPipeline,
      runBssPipeline,
      runEroPipeline,
      runExecutiveSummary,
      clearModuleProgress,
      getRunProgressApi,
    ]
  );

  // ---------------------------------------------------------------------------
  // Cancel a running module
  // ---------------------------------------------------------------------------

  const handleCancelModule = useCallback(
    async (moduleId: string) => {
      // Try activeRunIdRef first (set during live pipeline execution),
      // then fall back to the DB-reported running run ID from statuses
      let runId = activeRunIdRef.current[moduleId];
      if (!runId) {
        const dbRun = statuses[moduleId]?.latestRun;
        if (dbRun?.status === "running") {
          runId = dbRun.id;
        }
      }
      if (!runId) {
        toast.warning("No active run to cancel.");
        return;
      }

      // Mark cancelled locally (immediate — extraction loop checks this ref)
      cancelledRunsRef.current.add(runId);
      // Permanently kill — prevent auto-resume from re-triggering
      killedModulesRef.current.add(moduleId);

      // Mark cancelled server-side (module-scoped: cancels all running/pending for this module)
      try {
        await cancelModuleRunApi({ dealId: dealId ?? undefined, moduleId, runId });
        toast.info(`${MODULE_MAP[moduleId]?.displayName ?? moduleId} cancelled.`);
      } catch (err) {
        console.error("Failed to cancel run in DB:", err);
        toast.error("Cancel request failed — the run may still stop on next batch.");
      }

      // Clean up local state — update statuses so isRunning flips immediately
      // cancelledRunsRef is UX-only for instant button feedback.
      setStatuses((prev) => {
        const current = prev[moduleId];
        if (!current?.latestRun) return prev;
        return {
          ...prev,
          [moduleId]: {
            ...current,
            latestRun: { ...current.latestRun, status: "failed" as const },
          },
        };
      });
      setRunningModules((prev) => {
        const next = new Set(prev);
        next.delete(moduleId);
        return next;
      });
      clearModuleProgress(moduleId);
      pipelinePollingActive.current.delete(moduleId);
      delete activeRunIdRef.current[moduleId];
    },
    [cancelModuleRunApi, clearModuleProgress, statuses, dealId]
  );

  // ---------------------------------------------------------------------------
  // Run All — launches all modules simultaneously, exec summary last
  // ---------------------------------------------------------------------------

  const handleRunAll = useCallback(async () => {
    setShowRunAll(false);

    if (uploadedFiles.length === 0 && docs.length === 0) {
      toast.warning("Upload at least one document before running analysis.");
      return;
    }

    // Launch all non-executive-summary modules simultaneously
    const modulesToRun = MODULE_DEFINITIONS.filter(
      (m) => m.id !== "executive_summary" && !runningModules.has(m.id)
    );

    if (modulesToRun.length === 0) {
      toast.info("All modules are already running.");
      return;
    }

    toast.info(`Launching ${modulesToRun.length} modules simultaneously…`);

    // Run all modules in parallel
    const promises = modulesToRun.map((m) => handleRunModule(m.id));
    await Promise.allSettled(promises);

    // After all complete, run Executive Summary automatically
    // Re-check statuses to see what completed (use a timeout to let state settle)
    setTimeout(() => {
      handleRunModule("executive_summary");
    }, 500);
  }, [uploadedFiles, docs, runningModules, handleRunModule]);

  // ---------------------------------------------------------------------------
  // Resume interrupted runs on deal load
  // ---------------------------------------------------------------------------
  const resumeChecked = useRef(false);
  // Track whether the pipeline polling loop has taken over progress updates
  const pipelinePollingActive = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!dealId || resumeChecked.current || !docsInitialized.current) return;
    if (docs.length === 0) return;
    resumeChecked.current = true;
    (async () => {
      try {
        const progress = await getRunProgressApi({ dealId });
        const runs = progress?.runs ?? [];
        const inProgressRuns = runs.filter((r: { status: string }) => r.status === "running");
        if (inProgressRuns.length === 0) return;
        toast.info(`Resuming ${inProgressRuns.length} interrupted run(s)…`);
        for (const run of inProgressRuns) {
          if (run.moduleId === "executive_summary") continue;
          if (killedModulesRef.current.has(run.moduleId)) continue;
          handleRunModule(run.moduleId, run.runId);
        }
      } catch (err) {
        console.error("Failed to check for interrupted runs:", err);
      }
    })();
  }, [dealId, docs, handleRunModule, getRunProgressApi]);

  // ---------------------------------------------------------------------------
  // Auto-resume: re-invokes orphaned pipelines (no active polling loop) when
  // the tab regains focus OR periodically via heartbeat. Covers:
  //   - Tab switch (visibilitychange hidden→visible)
  //   - Laptop sleep/wake (visibilitychange in most browsers)
  //   - Long-running foreground tab where the loop died silently (heartbeat)
  //
  // Guards against double-fire:
  //   - resumingModules ref tracks which modules are currently being resumed
  //   - pipelinePollingActive check before invoking (set by handleRunModule)
  //   - Modules removed from resumingModules only after handleRunModule settles
  //
  // This is a CLIENT-SIDE improvement. The permanent browser-independent fix
  // is a Superblocks Workflow (server-side cron) — this is complementary UX.
  // ---------------------------------------------------------------------------
  const resumingModulesRef = useRef<Set<string>>(new Set());

  // ── Progress-aware resume tracking ────────────────────────────────────────
  // Instead of a blind attempt counter, we track the last-known "progress
  // fingerprint" (evidence count for DCS, checkpoint sum for other modules).
  // When progress advances → counter resets → resume is always allowed.
  // When progress is flat → counter increments → after N flat attempts, kill.
  // This means build-finalize cycles are harmless (evidence keeps growing,
  // counter keeps resetting) and genuine stalls are caught in ~5 minutes.
  const resumeAttemptCountRef = useRef<Record<string, number>>({});
  const lastKnownProgressRef = useRef<Record<string, number>>({});
  const MAX_FLAT_RESUME_ATTEMPTS = 5;

  // ---------------------------------------------------------------------------
  // Visibility-based resume: when the tab regains focus after sleep/switch,
  // immediately trigger the watchdog (which handles all resume logic).
  // The separate 30s heartbeat is removed — the watchdog interval (60s) plus
  // this visibility handler cover all scenarios.
  // ---------------------------------------------------------------------------
  const watchdogTriggerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && watchdogTriggerRef.current) {
        // Small delay to let browser connections stabilize after wake
        setTimeout(() => watchdogTriggerRef.current?.(), 1_000);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // ---------------------------------------------------------------------------
  // Progress polling for DB-running modules
  // Keeps UI updated independently of the RunModulePipeline call (which can
  // take up to 200s to return). Polls GetRunProgress every 15s and shows
  // checkpoint-based progress until the pipeline polling loop takes over.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!dealId) return;

    // Find modules that are marked running from DB but not yet driven by
    // the pipeline polling loop (which sets real progress messages)
    const dbRunningIds = Object.entries(statuses)
      .filter(([, s]) => s.latestRun?.status === "running")
      .map(([id]) => id)
      .filter((id) => !killedModulesRef.current.has(id));

    if (dbRunningIds.length === 0) return;

    // Bail immediately if the poll has already been killed (ref persists across re-runs)
    if (pollFailureCountRef.current >= 4) return;

    let cancelled = false;

    const pollProgress = async () => {
      if (cancelled) return;
      try {
        const progress = await getRunProgressApi({ dealId });
        if (cancelled) return;
        pollFailureCountRef.current = 0; // reset on success
        const runs = progress?.runs ?? [];
        const extractionCount = progress?.extractionCount ?? 0;
        const dcsEvidenceCount = progress?.dcsEvidenceCount ?? 0;

        for (const moduleId of dbRunningIds) {
          // Skip if the pipeline polling loop is now providing real-time progress
          if (pipelinePollingActive.current.has(moduleId)) continue;

          const run = runs.find((r: { moduleId: string; status: string; analysisCheckpointCount?: number; mergeCheckpointCount?: number }) => r.moduleId === moduleId && r.status === "running");
          if (!run) {
            // Run is no longer "running" in DB — it completed or failed while
            // we were polling. Refetch module results to get the final output.
            refetchModules();
            setRunningModules((prev) => {
              const next = new Set(prev);
              next.delete(moduleId);
              return next;
            });
            setProgressMap((prev) => {
              const updated = { ...prev };
              delete updated[moduleId];
              return updated;
            });
            continue;
          }

          // Derive progress from checkpoint counts
          let message: string;
          if (run.mergeCheckpointCount && run.mergeCheckpointCount > 0) {
            message = `Merge phase: ${run.mergeCheckpointCount} nodes merged (server-side)…`;
          } else if (run.analysisCheckpointCount && run.analysisCheckpointCount > 0) {
            message = `Analysis phase: ${run.analysisCheckpointCount} chunks completed (server-side)…`;
          } else if (moduleId === "diligence_completeness" && dcsEvidenceCount > 0) {
            message = `DCS extraction: ${dcsEvidenceCount} evidence rows written…`;
          } else if (extractionCount > 0) {
            message = `Preparing analysis: ${extractionCount} extractions available (server-side)…`;
          } else {
            message = "Running (server-side)…";
          }

          setProgressMap((prev) => {
            return { ...prev, [moduleId]: { message, detail: null, chunkErrors: [] } };
          });
        }
      } catch {
        pollFailureCountRef.current++;
        if (pollFailureCountRef.current >= 4) {
          // Server unreachable after 4 consecutive failures — reload the tab
          // to re-trigger the full initialization flow (docs, modules, resume)
          console.warn(`[progress-poll] 4 consecutive failures — reloading tab`);
          cancelled = true;
          window.location.reload();
        }
      }
    };

    // Initial poll immediately
    pollProgress();
    // Then every 15s
    const interval = setInterval(pollProgress, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dealId, statuses, getRunProgressApi, refetchModules]);

  // ---------------------------------------------------------------------------
  // Watchdog: single progress-aware resume driver
  //
  // Every 60s (+ on tab focus via watchdogTriggerRef), queries GetRunProgress
  // for DB-running modules. For each orphaned module (DB-running, no client
  // polling loop):
  //
  //   1. Compute a "progress fingerprint":
  //      - DCS: dcsEvidenceCount
  //      - Other modules: analysisCheckpointCount + mergeCheckpointCount + stageCheckpointCount
  //
  //   2. Compare to lastKnownProgressRef:
  //      - If fingerprint advanced → server is working. Reset attempt counter
  //        to 0 and resume (reconnect the client driver).
  //      - If fingerprint unchanged → server may be stuck. Increment attempt
  //        counter. After MAX_FLAT_RESUME_ATTEMPTS flat attempts, kill the
  //        module and notify.
  //
  // This replaces the old triple-mechanism approach (auto-resume heartbeat,
  // watchdog, stall-detector reload) with one clean loop.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!dealId) return;

    const WATCHDOG_INTERVAL_MS = 60_000;

    const watchdog = async () => {
      if (document.visibilityState !== "visible") return;

      // Gate: Do NOT resume until docs are loaded and selectedSubjectIds is populated.
      if (!docsInitialized.current) {
        console.log("[watchdog] Skipping — docs not yet loaded");
        return;
      }

      try {
        const progress = await getRunProgressApi({ dealId });
        const runs = progress?.runs ?? [];
        const dcsEvidenceCount = progress?.dcsEvidenceCount ?? 0;
        const dbRunning = runs.filter(
          (r: { status: string }) => r.status === "running"
        );

        // Clean up progress tracking for modules that are no longer running
        for (const moduleId of Object.keys(lastKnownProgressRef.current)) {
          if (!dbRunning.some((r: { moduleId: string }) => r.moduleId === moduleId)) {
            delete lastKnownProgressRef.current[moduleId];
            delete resumeAttemptCountRef.current[moduleId];
          }
        }

        for (const run of dbRunning) {
          const { moduleId, runId } = run as {
            moduleId: string;
            runId: string;
            analysisCheckpointCount?: number;
            mergeCheckpointCount?: number;
            stageCheckpointCount?: number;
          };
          if (moduleId === "executive_summary") continue;
          if (killedModulesRef.current.has(moduleId)) continue;

          // Skip modules that already have an active client driver
          const hasActivePolling = pipelinePollingActive.current.has(moduleId);
          const isResuming = resumingModulesRef.current.has(moduleId);
          if (hasActivePolling || isResuming) continue;

          // ── Compute progress fingerprint ────────────────────────────────
          let currentProgress: number;
          if (moduleId === "diligence_completeness") {
            currentProgress = dcsEvidenceCount;
          } else {
            currentProgress =
              (run.analysisCheckpointCount ?? 0) +
              (run.mergeCheckpointCount ?? 0) +
              (run.stageCheckpointCount ?? 0);
          }

          const lastKnown = lastKnownProgressRef.current[moduleId] ?? -1;

          if (currentProgress > lastKnown) {
            // Progress is advancing — reset flat-attempt counter
            lastKnownProgressRef.current[moduleId] = currentProgress;
            resumeAttemptCountRef.current[moduleId] = 0;
            console.log(
              `[watchdog] ${moduleId}: progress advancing (${lastKnown} → ${currentProgress}) — resuming (run ${runId})`
            );
          } else {
            // Progress flat — increment counter
            const flatAttempts = (resumeAttemptCountRef.current[moduleId] ?? 0) + 1;
            resumeAttemptCountRef.current[moduleId] = flatAttempts;
            lastKnownProgressRef.current[moduleId] = currentProgress;

            if (flatAttempts > MAX_FLAT_RESUME_ATTEMPTS) {
              console.warn(
                `[watchdog] ${moduleId}: ${flatAttempts} flat-progress attempts — pipeline appears genuinely stalled. Stopping.`
              );
              killedModulesRef.current.add(moduleId);
              setRunningModules((prev) => {
                const next = new Set(prev);
                next.delete(moduleId);
                return next;
              });
              toast.error(
                `[${MODULE_MAP[moduleId]?.displayName ?? moduleId}] Pipeline stalled (no progress for ~${flatAttempts} minutes). Refresh to retry.`
              );
              continue;
            }

            console.log(
              `[watchdog] ${moduleId}: progress flat at ${currentProgress} — attempt ${flatAttempts}/${MAX_FLAT_RESUME_ATTEMPTS} (run ${runId})`
            );
          }

          // Resume: fire handleRunModule to reconnect the client driver
          resumingModulesRef.current.add(moduleId);
          handleRunModule(moduleId, runId).finally(() => {
            resumingModulesRef.current.delete(moduleId);
          });
        }
      } catch {
        // Watchdog failure is non-fatal — next interval will retry
      }
    };

    // Expose watchdog for visibility-change trigger
    watchdogTriggerRef.current = watchdog;

    // Run immediately on mount (catches orphaned runs after build finalize)
    watchdog();

    const interval = setInterval(watchdog, WATCHDOG_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      watchdogTriggerRef.current = null;
    };
  }, [dealId, handleRunModule, getRunProgressApi]);

  // ---------------------------------------------------------------------------
  // Document management
  // ---------------------------------------------------------------------------

  const handleUpload = useCallback(
    async (files: File[]) => {
      // Deduplicate: separate files that already exist in this deal (by filename)
      // from genuinely new files. Existing files still get added to uploadedFiles
      // so doc_tables extraction runs, but they skip the DB insert.
      const existingFileNames = new Set(docs.map((d) => d.file_name));
      const newFiles = files.filter((f) => !existingFileNames.has(f.name));
      const reuploadedFiles = files.filter((f) => existingFileNames.has(f.name));

      setUploadedFiles((prev) => [...prev, ...files]); // all files for extraction
      // Invalidate caches since files changed
      chunksCache.current = null;
      chunksCacheKey.current = "";
      coverageRef.current = null;
      universalExtractionsCache.current = null;
      universalExtractionsCacheKey.current = "";
      docTablesCacheKey.current = "";
      docIdsForVerification.current = [];

      // Only add genuinely new docs to UI state — skip duplicates
      if (newFiles.length > 0) {
        const newDocs: Document[] = newFiles.map((f) => ({
          id: crypto.randomUUID(),
          deal_id: dealId!,
          file_name: f.name,
          file_type: f.type || "application/octet-stream",
          document_tag: "other" as DocumentTag,
          document_source: "sellside" as DocumentSource,
          uploaded_at: new Date().toISOString(),
        }));
        setDocs((prev) => [...prev, ...newDocs]);
      }

      // User feedback
      if (reuploadedFiles.length > 0 && newFiles.length === 0) {
        toast.info(
          `Re-processing ${reuploadedFiles.length} existing file${reuploadedFiles.length > 1 ? "s" : ""} for structured table extraction (no duplicates created).`
        );
      } else if (reuploadedFiles.length > 0 && newFiles.length > 0) {
        toast.success(
          `Uploaded ${newFiles.length} new document${newFiles.length > 1 ? "s" : ""}. ` +
          `Re-processing ${reuploadedFiles.length} existing file${reuploadedFiles.length > 1 ? "s" : ""} (no duplicates).`
        );
      } else {
        toast.success(`Uploaded ${files.length} document${files.length > 1 ? "s" : ""}`);
      }

      // If there are already completed modules, prompt user to re-run
      if (completedModules.length > 0) {
        setRerunModal({
          fileNames: files.map((f) => f.name),
          suggestedIds: completedModules.filter((id) => id !== "executive_summary"),
        });
      }

      // Persist genuinely new files to database and index for Q&A.
      // Re-uploaded files are skipped — they already exist in the DB
      // and their doc_tables will be extracted via the normal chunk-building path.
      // Track real DB IDs for doc_tables extraction below.
      const savedDbIds: Record<string, string> = {};
      if (dealId) {
        for (const f of newFiles) {
          try {
            // Extract text for Q&A indexing (fast — no image rendering)
            const parsedText = await extractTextFromFile(f);

            const result = await saveDocumentApi({
              dealId,
              fileName: f.name,
              fileType: f.type || "application/octet-stream",
              documentTag: "other",
              documentSource: "sellside",
              parsedText: parsedText || null,
            });

            // Store the real DB ID for doc_tables extraction
            if (result?.document?.id) {
              savedDbIds[f.name] = result.document.id;
              // Update docs state with the real DB ID (replace client-side UUID)
              setDocs((prev) =>
                prev.map((d) =>
                  d.file_name === f.name && !d.uploaded_at.startsWith("20")
                    ? { ...d, id: result.document.id }
                    : d
                )
              );
            }

            // Index chunks for full-text search
            if (parsedText && result?.document?.id) {
              indexDocumentChunks({
                documentId: result.document.id,
                dealId,
                fileName: f.name,
                parsedText,
              }).catch((err: unknown) =>
                console.error("Failed to index document chunks:", err)
              );
            }
          } catch (err) {
            console.error("Failed to save document:", err);
          }
        }
      }

      // Eagerly extract and save structured tables for all uploaded Excel/CSV files.
      // This ensures doc_tables is populated immediately at upload time, not deferred
      // to the module run. Covers both new uploads and re-uploads of existing files.
      // Build docIdByName from: (1) real DB IDs for newly saved files, (2) existing docs for re-uploads
      const docIdByName: Record<string, string> = {};
      // First, map existing docs (covers re-uploaded files)
      for (const doc of docs) docIdByName[doc.file_name] = doc.id;
      // Then, overlay with real DB IDs from the persist loop (overrides client-side UUIDs)
      Object.assign(docIdByName, savedDbIds);

      const tablesPayload: Array<{
        documentId: string;
        sheetOrPage: string;
        caption: string | null;
        data: { row_headers: string[]; col_headers: string[]; cells: StructuredCell[] };
      }> = [];

      for (const f of files) {
        const docId = docIdByName[f.name];
        if (!docId) continue;
        const lower = f.name.toLowerCase();
        if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm")) {
          try {
            const buf = await f.arrayBuffer();
            const tables = parseExcelToTables(buf, f.name);
            for (const t of tables) {
              tablesPayload.push({
                documentId: docId,
                sheetOrPage: t.sheetOrPage,
                caption: t.caption,
                data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
              });
            }
          } catch (err) {
            console.warn(`[doc_tables] Failed to parse ${f.name} at upload:`, err);
          }
        } else if (lower.endsWith(".csv")) {
          try {
            const buf = await f.arrayBuffer();
            const csvText = new TextDecoder("utf-8").decode(buf);
            const t = parseCsvToTable(csvText, f.name);
            if (t) {
              tablesPayload.push({
                documentId: docId,
                sheetOrPage: t.sheetOrPage,
                caption: t.caption,
                data: { row_headers: t.rowHeaders, col_headers: t.colHeaders, cells: t.cells },
              });
            }
          } catch (err) {
            console.warn(`[doc_tables] Failed to parse ${f.name} at upload:`, err);
          }
        }
      }

      console.info(`[doc_tables] docIdByName keys: ${Object.keys(docIdByName).join(", ")}; files: ${files.map(f=>f.name).join(", ")}; tablesPayload count: ${tablesPayload.length}`);
      if (tablesPayload.length > 0) {
        try {
          await saveDocTablesApi({ tables: tablesPayload });
          console.info(`[doc_tables] Saved ${tablesPayload.length} table(s) at upload time for doc IDs: ${[...new Set(tablesPayload.map(t=>t.documentId))].join(", ")}`);
        } catch (err) {
          console.error("[doc_tables] Failed to save structured tables at upload:", err);
        }
      } else {
        console.warn(`[doc_tables] No tables extracted. Excel/CSV files found: ${files.filter(f => /\.(xlsx|xls|xlsm|csv)$/i.test(f.name)).map(f=>f.name).join(", ") || "none"}`);
      }
    },
    [dealId, docs, saveDocumentApi, saveDocTablesApi, indexDocumentChunks]
  );

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setDocs((prev) => {
      const doc = prev.find((d) => d.id === docId);
      if (doc) {
        setUploadedFiles((uf) => {
          const idx = uf.findIndex((f) => f.name === doc.file_name);
          if (idx >= 0) return uf.filter((_, i) => i !== idx);
          return uf;
        });
      }
      return prev.filter((d) => d.id !== docId);
    });
    // Invalidate caches
    chunksCache.current = null;
    chunksCacheKey.current = "";
    coverageRef.current = null;
    universalExtractionsCache.current = null;
    universalExtractionsCacheKey.current = "";
    docTablesCacheKey.current = "";
    docIdsForVerification.current = [];

    try {
      await deleteDocumentApi({ documentId: docId });
    } catch (err) {
      console.error("Failed to delete document:", err);
    }
    toast.success("Document deleted");
  }, [deleteDocumentApi]);

  const handleUpdateDocTag = useCallback(
    (docId: string, tag: DocumentTag) => {
      setDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, document_tag: tag } : d))
      );
    // Re-tag cached universal extractions so routing picks up the new tag
    // (No need to re-extract — only the tag assignment changes)
    if (universalExtractionsCache.current) {
      const updatedDoc = docs.find((d) => d.id === docId);
      if (updatedDoc) {
        universalExtractionsCache.current = universalExtractionsCache.current.map((ext) =>
          ext.sourceFile === updatedDoc.file_name
            ? { ...ext, documentTag: tag }
            : ext
        );
      }
    }
    // Persist to DB — find current source to pass along
    const doc = docs.find((d) => d.id === docId);
    updateDocumentApi({
      documentId: docId,
      documentTag: tag,
      documentSource: doc?.document_source ?? "sellside",
    }).catch((err: unknown) =>
      console.error("Failed to update document tag:", err)
    );
    },
    [updateDocumentApi, docs]
  );

  const handleUpdateDocSource = useCallback(
    (docId: string, source: DocumentSource) => {
      setDocs((prev) =>
        prev.map((d) => (d.id === docId ? { ...d, document_source: source } : d))
      );
      // Persist to DB — find current tag to pass along
      const doc = docs.find((d) => d.id === docId);
      updateDocumentApi({
        documentId: docId,
        documentTag: doc?.document_tag ?? "other",
        documentSource: source,
      }).catch((err: unknown) =>
        console.error("Failed to update document source:", err)
      );
    },
    [updateDocumentApi, docs]
  );

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  const historyModuleDef = useMemo(
    () =>
      historyModule
        ? MODULE_DEFINITIONS.find((m) => m.id === historyModule)
        : undefined,
    [historyModule]
  );

  const [historyRuns, setHistoryRuns] = useState<Array<{
    id: string;
    module_id: string;
    status: string;
    triggered_at: string;
    completed_at: string | null;
    finding_count: number;
    critical_count: number;
  }>>([]);

  useEffect(() => {
    if (historyModule && dealId) {
      getRunHistoryApi({ dealId }).then((result) => {
        if (result) {
          setHistoryRuns(
            result.runs
              .filter((r: { module_id: string }) => r.module_id === historyModule)
              .map((r: Record<string, unknown>) => ({
                ...r,
              })) as typeof historyRuns
          );
        }
      }).catch(() => setHistoryRuns([]));
    } else {
      setHistoryRuns([]);
    }
  }, [historyModule, dealId, getRunHistoryApi]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (dealLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-ic-dark">
        <div className="w-8 h-8 border-2 border-ic-turquoise border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!deal || dealError) {
    return (
      <div className="flex items-center justify-center h-full bg-ic-dark">
        <div className="text-center">
          <p className="text-ic-muted text-sm mb-4">Deal not found</p>
          <button
            onClick={() => navigate("/")}
            className="text-ic-turquoise text-sm hover:underline cursor-pointer"
          >
            Back to deals
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-screen bg-ic-dark overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        deal={deal}
        documents={docs}
        completedModules={completedModules}
        totalModules={MODULE_DEFINITIONS.length}
        selectedSubjectIds={selectedSubjectIds}
        onSubjectSelectionChange={setSelectedSubjectIds}
        onUpload={handleUpload}
        onDeleteDoc={handleDeleteDoc}
        onUpdateTag={handleUpdateDocTag}
        onUpdateSource={handleUpdateDocSource}
        onBack={() => navigate("/")}
        onReparse={() => setShowReparseModal(true)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-auto">
        <DashboardHeader
          dealId={dealId!}
          dealName={deal.name}
          status={deal.status}
          useOpus={useOpus}
          onToggleOpus={setUseOpus}
          onRunAll={() => setShowRunAll(true)}
          onBack={() => navigate("/")}
          disableRunAll={!canRunAnalysis}
          disableReason={runDisabledReason}
        />

        <div className="flex-1 px-8 py-8 space-y-8">
          <StatsRow
            documentCount={stats.documents}
            modulesComplete={stats.modulesComplete}
            totalModules={stats.totalModules}
            totalFindings={stats.totalFindings}
            criticalFindings={stats.criticalFindings}
          />

          {stats.criticalFindings > 0 && (
            <AlertBanner count={stats.criticalFindings} />
          )}

          <ModuleGrid
            moduleStatuses={statuses}
            runningModules={runningModules}
            analysisProgressMap={progressMap}
            onRunModule={handleRunModule}
            onCancelModule={handleCancelModule}
            onViewHistory={setHistoryModule}
            disableAnalysis={!canRunAnalysis}
            disableReason={runDisabledReason}
          />

          <QAPanel
            dealId={dealId!}
            dealName={deal.name}
            dealSector={deal.sector ?? null}
            hasDocuments={docs.length > 0}
          />
        </div>
      </div>

      {/* Modals */}
      <RunAllModal
        open={showRunAll}
        onClose={() => setShowRunAll(false)}
        onConfirm={handleRunAll}
        completedModules={completedModules}
      />

      {historyModule && historyModuleDef && (
        <RunHistory
          open
          onClose={() => setHistoryModule(null)}
          moduleTitle={historyModuleDef.displayName}
          runs={historyRuns as unknown as import("@/types/module").ModuleRun[]}
        />
      )}

      {rerunModal && (
        <RerunSuggestionModal
          open
          onClose={() => setRerunModal(null)}
          suggestedModuleIds={rerunModal.suggestedIds}
          uploadedFileNames={rerunModal.fileNames}
          onConfirm={(selectedIds) => {
            setRerunModal(null);
            for (const moduleId of selectedIds) {
              handleRunModule(moduleId);
            }
          }}
        />
      )}

      <ReparseDocumentsModal
        open={showReparseModal}
        onClose={() => setShowReparseModal(false)}
        dealId={dealId ?? ""}
        existingDocuments={docs.map((d) => ({ id: d.id, file_name: d.file_name }))}
        onCommitComplete={() => refetchDocs()}
      />
    </div>
  );
}
