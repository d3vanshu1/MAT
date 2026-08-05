/**
 * API Registry - Central export for all APIs.
 *
 * This file is the single source of truth for API definitions.
 * Add new APIs here to get full TypeScript support in the frontend.
 *
 * Usage:
 * 1. Import your API: `import MyApi from './MyApi/api.js';`
 * 2. Add it to the apis object below
 * 3. That's it! Types automatically flow to useApi via client/hooks/useApi.ts
 *
 * IMPORTANT: Use .js extension for imports (required for ESM compatibility)
 */

// AI pipeline
import AnalyzeChunk from './modules/analyze-chunk.js';
import UniversalExtract from './modules/universal-extract.js';
import MergeFindings from './modules/merge-findings.js';
import FormatReport from './modules/format-report.js';
import WebResearch from './modules/web-research.js';
import SaveModuleResult from './modules/save-module-result.js';
import LoadModuleResults from './modules/load-module-results.js';
import GetRunHistory from './modules/get-run-history.js';
import GetRunOutput from './modules/get-run-output.js';

// Server-side pipeline
import RunModulePipeline from './pipeline/run-module-pipeline.js';
import ResumeStalePipelines from './pipeline/resume-stale-pipelines.js';
import DiagnoseParsedText from './pipeline/diagnose-parsed-text.js';
import CleanParsedTextDryRun from './pipeline/clean-parsed-text-api.js';
import CountSheets from './pipeline/count-sheets.js';
import DiagnoseChunks from './pipeline/diagnose-chunks.js';
import ResetDealRun from './pipeline/reset-deal-run.js';
import ResetModuleMerge from './pipeline/reset-module-merge.js';
import DiagnoseRuns from './pipeline/diagnose-runs.js';
import DiagnoseChunkCoverage from './pipeline/diagnose-chunk-coverage.js';
import DiagnoseChunkDetail from './pipeline/diagnose-chunk-detail.js';
import DiagnoseRunEvidence from './pipeline/diagnose-run-evidence.js';
import DiagnoseFindingTrace from './pipeline/diagnose-finding-trace.js';
import DiagnoseExtractionRaw from './pipeline/diagnose-extraction-raw.js';
import RunMigration004 from './pipeline/run-migration.js';
import RunMigration005 from './pipeline/run-migration-005.js';
import RunMigration006 from './pipeline/run-migration-006.js';
import RunMigration007 from './pipeline/run-migration-007.js';
import RunMigration009 from './pipeline/run-migration-009.js';
import RunMigration010 from './pipeline/run-migration-010.js';
import RunMigration011 from './pipeline/run-migration-011.js';
import RunMigration012 from './pipeline/run-migration-012.js';
import RunMigration013 from './pipeline/run-migration-013.js';
import RunMigration014 from './pipeline/run-migration-014.js';
import DiagTimeoutProbe from './pipeline/diag-timeout-probe.js';
import ReadTimeoutProbeResult from './pipeline/read-timeout-probe-result.js';
import ListTimeoutProbes from './pipeline/list-timeout-probes.js';
import DiagMergeNodeSize from './pipeline/diag-merge-node-size.js';
import DiagRawFlagAggregate from './pipeline/diag-raw-flag-aggregate.js';
import DiagMergeFunnel from './pipeline/diag-merge-funnel.js';
import DiagPromptExport from './pipeline/diag-prompt-export.js';
import ExportFindings from './pipeline/export-findings.js';
import UnstickPool from './pipeline/unstick-pool.js';
import ExtractReportChunk from './pipeline/extract-report-chunk.js';
import DiagClaimsExtraction from './pipeline/diag-claims-extraction.js';
import DiagReconciliation from './pipeline/diag-reconciliation.js';
import DiagMergeStall from './pipeline/diag-merge-stall.js';
import RunMigration015 from './pipeline/run-migration-015.js';
import ResumeMergeRecovery from './pipeline/resume-merge-recovery.js';
import DiagnosticFinalization from './pipeline/diagnostic-finalization.js';
import ExportL3RawFindings from './pipeline/export-l3-raw-findings.js';
import ConsolidateL3Export from './pipeline/consolidate-l3-export.js';
import ReadL3ExportChunk from './pipeline/read-l3-export-chunk.js';
import GenerateL3ArtifactFiles from './pipeline/generate-l3-artifact-files.js';
import ReadArtifactChunk from './pipeline/read-artifact-chunk.js';
import AssembleExportArtifact from './pipeline/assemble-export-artifact.js';
import StreamExportArtifact from './pipeline/stream-export-artifact.js';
import DownloadDiagnosticArtifact from './pipeline/download-diagnostic-artifact.js';
import ReplayDispositionHarness from './pipeline/replay-disposition-harness.js';
import ExportReplayEvidence from './pipeline/export-replay-evidence.js';
import ReplayClaimLinkage from './pipeline/replay-claim-linkage.js';
import ReplayCanonicalIdentity from './pipeline/replay-canonical-identity.js';
import AssembleCanonicalFindings from './pipeline/assemble-canonical-findings.js';
import ReplayPopulateClaimsLedger from './pipeline/replay-populate-claims-ledger.js';
import DiagSaintReconciliation from './pipeline/diag-saint-reconciliation.js';
import GetSaintReconciliationPage from './pipeline/get-saint-reconciliation-page.js';
import DiagReconciliationFindings from './pipeline/diag-reconciliation-findings.js';
import RegenerateQ2Candidates from './pipeline/regenerate-q2-candidates.js';
import PersistAndProveQ2 from './pipeline/persist-prove-q2.js';
import ReadPersistedQ2Artifact from './pipeline/read-persisted-q2.js';
import DiagnoseSaveFailure from './pipeline/diagnose-save-failure.js';
import RunMigration016 from './pipeline/run-migration-016.js';
import FinalizePipelineOutput from './pipeline/finalize-pipeline-output.js';
import CompleteMergeTree from './pipeline/complete-merge-tree.js';
import PromoteRootFindings from './pipeline/promote-root-findings.js';
import DiagCheckpointInspect from './pipeline/diag-checkpoint-inspect.js';
import DiagPartialNodeLedger from './pipeline/diag-partial-node-ledger.js';
import FenceRun from './pipeline/fence-run.js';
import RunMigration017 from './pipeline/run-migration-017.js';
import RunMigration018 from './pipeline/run-migration-018.js';
import DiagSchemaVerify from './pipeline/diag-schema-verify.js';
import TestConcurrencyGuards from './pipeline/test-concurrency-guards.js';
import DiagClaimExpiryCheck from './pipeline/diag-claim-expiry-check.js';
import DiagOaAncestry from './pipeline/diag-oa-ancestry.js';
import DiagOaAncestryExport from './pipeline/diag-oa-ancestry-export.js';
import TestOaAncestry from './pipeline/test-oa-ancestry.js';
import TestOaMergeContract from './pipeline/test-oa-merge-contract.js';
import TestOaFamilyDedup from './pipeline/test-oa-family-dedup.js';
import TestOaEvidenceAdmissionSynthesis from './pipeline/test-oa-evidence-admission-synthesis.js';
import RecoverRun7bbeab48 from './pipeline/recover-run-7bbeab48.js';

// Database setup
import SetupSchema from './db/setup-schema.js';
import RunCheckpointMigration from './db/run-checkpoint-migration.js';
import CreatePipelineTable from './db/create-pipeline-table.js';
import CheckSchemaHealth from './db/check-schema-health.js';
import AddConcurrentRunIndex from './db/add-concurrent-run-index.js';

// Deals CRUD
import ListDeals from './deals/list-deals.js';
import GetDeal from './deals/get-deal.js';
import CreateDeal from './deals/create-deal.js';
import UpdateDeal from './deals/update-deal.js';
import DeleteDeal from './deals/delete-deal.js';

// Documents
import ListDocuments from './documents/list-documents.js';
import SaveDocument from './documents/save-document.js';
import UpdateDocument from './documents/update-document.js';
import DeleteDocument from './documents/delete-document.js';
import GetDocumentTexts from './documents/get-document-texts.js';
import SaveDocTables from './documents/save-doc-tables.js';
import GetDocTables from './documents/get-doc-tables.js';
import BackfillDocTablesFromText from './documents/backfill-doc-tables-from-text.js';
import GetDocTablesSummary from './documents/get-doc-tables-summary.js';
import UpdateParsedText from './documents/update-parsed-text.js';
import ClearParsedText from './documents/clear-parsed-text.js';

// Numeric verification
import NumericVerify from './numeric/numeric-verify.js';
import GetNumericReport from './numeric/get-numeric-report.js';
import InspectColHeaders from './numeric/inspect-col-headers.js';
import InspectEnrichedHeaders from './numeric/inspect-enriched-headers.js';
import InspectRowLabels from './numeric/inspect-row-labels.js';
import InspectCellValues from './numeric/inspect-cell-values.js';
import SearchNumericFindings from './numeric/search-numeric-findings.js';
import DiagSharedFormulas from './numeric/diag-shared-formulas.js';
import DiagFormulaExtraction from './numeric/diag-formula-extraction.js';

// Q&A
import IndexDocumentChunks from './qa/index-document-chunks.js';
import SearchChunks from './qa/search-chunks.js';
import AskDataRoom from './qa/ask-data-room.js';

// Checkpoints (crash-recovery)
import SaveExtractions from './checkpoints/save-extractions.js';
import LoadExtractions from './checkpoints/load-extractions.js';
import SaveMergeCheckpoint from './checkpoints/save-merge-checkpoint.js';
import LoadMergeCheckpoints from './checkpoints/load-merge-checkpoints.js';
import UpdateRunStatus from './checkpoints/update-run-status.js';
import GetRunProgress from './checkpoints/get-run-progress.js';
import SaveRunCoverage from './checkpoints/save-run-coverage.js';
import LoadRunCoverage from './checkpoints/load-run-coverage.js';
import CancelModuleRun from './checkpoints/cancel-module-run.js';
import CheckRunCancelled from './checkpoints/check-run-cancelled.js';
import PurgeStaleRuns from './checkpoints/purge-stale-runs.js';
import ResurrectModuleRun from './checkpoints/resurrect-module-run.js';
import ReconcileFindings from './checkpoints/reconcile-findings.js';
import GetExtractionStatus from './checkpoints/get-extraction-status.js';
import PurgeExtractions from './checkpoints/purge-extractions.js';
import PurgeDocumentExtractions from './checkpoints/purge-document-extractions.js';
import PurgeDealHistory from './checkpoints/purge-deal-history.js';
import PurgePipelineCheckpoints from './checkpoints/purge-pipeline-checkpoints.js';
import ResumeCompletedRun from './checkpoints/resume-completed-run.js';
import DiagFailedExtractions from './checkpoints/diag-failed-extractions.js';

// Audit
import ExtractReportSnippets from './audit/extract-report-snippets.js';
import FramingPatternAudit from './audit/framing-pattern-audit.js';

const apis = {
  // AI pipeline
  AnalyzeChunk, UniversalExtract, MergeFindings, FormatReport, WebResearch,
  SaveModuleResult, LoadModuleResults, GetRunHistory, GetRunOutput,
  // Server-side pipeline
  RunModulePipeline, ResumeStalePipelines, DiagnoseParsedText, CleanParsedTextDryRun, CountSheets, DiagnoseChunks, DiagnoseRuns, DiagnoseChunkCoverage, DiagnoseChunkDetail, DiagnoseRunEvidence, DiagnoseFindingTrace, DiagnoseExtractionRaw, ResetDealRun, ResetModuleMerge, RunMigration004, RunMigration005, RunMigration006, RunMigration007, RunMigration009, RunMigration010, RunMigration011, RunMigration012, RunMigration013, RunMigration014, RunMigration015, DiagTimeoutProbe, ReadTimeoutProbeResult, ListTimeoutProbes, DiagMergeNodeSize, DiagRawFlagAggregate, DiagMergeFunnel, DiagPromptExport, ExportFindings, UnstickPool, ExtractReportChunk, DiagClaimsExtraction, DiagReconciliation, DiagMergeStall,     ResumeMergeRecovery, DiagnosticFinalization, ExportL3RawFindings, ConsolidateL3Export, ReadL3ExportChunk, GenerateL3ArtifactFiles, ReadArtifactChunk, AssembleExportArtifact, StreamExportArtifact, DownloadDiagnosticArtifact,
  ReplayDispositionHarness, ExportReplayEvidence, ReplayClaimLinkage, ReplayCanonicalIdentity, AssembleCanonicalFindings, ReplayPopulateClaimsLedger, DiagSaintReconciliation, GetSaintReconciliationPage, DiagReconciliationFindings,
  RegenerateQ2Candidates, PersistAndProveQ2, ReadPersistedQ2Artifact, DiagnoseSaveFailure, RunMigration016, FinalizePipelineOutput, CompleteMergeTree, PromoteRootFindings,
  DiagCheckpointInspect, DiagPartialNodeLedger, FenceRun, RunMigration017, RunMigration018, DiagSchemaVerify, TestConcurrencyGuards, DiagClaimExpiryCheck,
  DiagOaAncestry, DiagOaAncestryExport, TestOaAncestry, TestOaMergeContract, TestOaFamilyDedup, TestOaEvidenceAdmissionSynthesis,
  RecoverRun7bbeab48,
  // DB setup
  SetupSchema, RunCheckpointMigration, CreatePipelineTable, CheckSchemaHealth, AddConcurrentRunIndex,
  // Deals
  ListDeals, GetDeal, CreateDeal, UpdateDeal, DeleteDeal,
  // Documents
  ListDocuments, SaveDocument, UpdateDocument, DeleteDocument, GetDocumentTexts,
  SaveDocTables, GetDocTables, BackfillDocTablesFromText, GetDocTablesSummary, UpdateParsedText, ClearParsedText,
  // Numeric verification
  NumericVerify, GetNumericReport, SearchNumericFindings, DiagSharedFormulas, DiagFormulaExtraction, InspectColHeaders, InspectEnrichedHeaders, InspectRowLabels, InspectCellValues,
  // Q&A
  IndexDocumentChunks, SearchChunks, AskDataRoom,
  // Checkpoints
  SaveExtractions, LoadExtractions, SaveMergeCheckpoint, LoadMergeCheckpoints,
  UpdateRunStatus, GetRunProgress, SaveRunCoverage, LoadRunCoverage,
  CancelModuleRun, CheckRunCancelled, PurgeStaleRuns, ResurrectModuleRun, ReconcileFindings, GetExtractionStatus, PurgeExtractions, PurgeDocumentExtractions, PurgeDealHistory, PurgePipelineCheckpoints, DiagFailedExtractions, ResumeCompletedRun,
  // Audit
  ExtractReportSnippets, FramingPatternAudit,
} as const;


export default apis;

/** Type for useApi inference - exported for client type-only imports */
export type ApiRegistry = typeof apis;
