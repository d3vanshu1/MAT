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
import GetRunnableRuns from './modules/get-runnable-runs.js';
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
import DiagMergeMetrics from './pipeline/diag-merge-metrics.js';
import DiagConsolidationFailure from './pipeline/diag-consolidation-failure.js';
import DiagConsolidationDryrun from './pipeline/diag-consolidation-dryrun.js';
import DiagOaIdentityFit from './pipeline/diag-oa-identity-fit.js';
import DiagModelGrouper from './pipeline/diag-model-grouper.js';
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
import DiagMergeEmissionBudget from './pipeline/diag-merge-emission-budget.js';
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
import RunMigration019 from './pipeline/run-migration-019.js';
import RunMigration020 from './pipeline/run-migration-020.js';
import RunMigration021 from './pipeline/run-migration-021.js';
import OaPreconditionCheck from './pipeline/oa-precondition-check.js';
import ReadDiagTrace from './pipeline/read-diag-trace.js';
import ResetMergeTruncation from './pipeline/reset-merge-truncation.js';
import AdaptiveMergeRecovery from './pipeline/adaptive-merge-recovery.js';
import ValidateTreeRoot from './pipeline/validate-tree-root.js';
import FindingReductionGate from './pipeline/finding-reduction-gate.js';
import ScgClonedStatePreflight from './pipeline/scg-cloned-state-preflight.js';
import DiagChecklistCoverage from './pipeline/diag-checklist-coverage.js';
import DiagEngagementMap from './pipeline/diag-engagement-map.js';
import DiagAbsenceMatcher from './pipeline/diag-absence-matcher.js';
import DiagConsolidationEngine from './pipeline/diag-consolidation-engine.js';
import DiagMateriality from './pipeline/diag-materiality.js';
import DiagNode17State from './pipeline/diag-node17-state.js';
import DiagFinalizationState from './pipeline/diag-finalization-state.js';
import DiagResumeCcRun from './pipeline/diag-resume-cc-run.js';
import DiagDeleteCheckpointRow from './pipeline/diag-delete-checkpoint-row.js';
import DiagTestResumeQuery from './pipeline/diag-test-resume-query.js';
import DiagSuppressedFindings from './pipeline/diag-suppressed-findings.js';
import DiagDumpAnalysisRows from './pipeline/diag-dump-analysis-rows.js';
import DiagExportIndexMap from './pipeline/diag-export-index-map.js';
import DiagExportExtraction from './pipeline/diag-export-extraction.js';
import DiagExportFinding from './pipeline/diag-export-finding.js';
import DiagBulkExtract from './pipeline/diag-bulk-extract.js';
import GetExtractionManifest from './pipeline/get-extraction-manifest.js';
import OaDiagQuery from './pipeline/oa-diag-query.js';
import DiagD1Documents from './pipeline/diag-d1-documents.js';
import DiagD1ClaimsLedger from './pipeline/diag-d1-claims-ledger.js';
import DiagD1Query from './pipeline/diag-d1-query.js';
import DiagSnippetMatchHarness from './pipeline/diag-snippet-match-harness.js';
import DiagCoordCollisions from './pipeline/diag-coord-collisions.js';
import DiagReconcilerKeys from './pipeline/diag-reconciler-keys.js';
import DiagReconcileOnly from './pipeline/diag-reconcile-only.js';
import DiagPhaseJControl from './pipeline/diag-phase-j-control.js';
import RunMigration022 from './pipeline/run-migration-022.js';
import RunMigration023 from './pipeline/run-migration-023.js';
import RunMigration024 from './pipeline/run-migration-024.js';
import RunMigration025 from './pipeline/run-migration-025.js';
import RunMigration026 from './pipeline/run-migration-026.js';
import RunMigration027 from './pipeline/run-migration-027.js';
import RunMigration028 from './pipeline/run-migration-028.js';
import RunMigration029 from './pipeline/run-migration-029.js';
import RunMigration030 from './pipeline/run-migration-030.js';
import RunMigration031 from './pipeline/run-migration-031.js';
import RunMigration032 from './pipeline/run-migration-032.js';
import RunMigration033 from './pipeline/run-migration-033.js';
import RunMigration034 from './pipeline/run-migration-034.js';
import RunMigration035 from './pipeline/run-migration-035.js';
import RunMigration036 from './pipeline/run-migration-036.js';
import RunMigration037 from './pipeline/run-migration-037.js';
import RunMigration038 from './pipeline/run-migration-038.js';
import RunMigration039 from './pipeline/run-migration-039.js';
import MastRunPipeline from './pipeline/mast-run-pipeline.js';
import MastResetPipeline from './pipeline/mast-reset-pipeline.js';
import MastDiagFormulaCoverage from './pipeline/mast-diag-formula-coverage.js';
import MastDiagRetrievalProbe from './pipeline/mast-diag-retrieval-probe.js';
import MastDiagSweepProbe from './pipeline/mast-diag-sweep-probe.js';
import MastPublish from './pipeline/mast-publish.js';
import MastRegisterRowsProbe from './pipeline/mast-register-rows.js';
import BssRunPipeline from './pipeline/bss-run-pipeline.js';
import EroGetActiveRun from './pipeline/ero-get-active-run.js';
import EroRunPipeline from './pipeline/ero-run-pipeline.js';
import EroDiagState from './pipeline/ero-diag-state.js';
import EroTestAdvance from './pipeline/ero-test-advance.js';
import EroTestEntityManifest from './pipeline/ero-test-entity-manifest.js';
import EroTestDealProfile from './pipeline/ero-test-deal-profile.js';
import EroDiagPhase2Export from './pipeline/ero-diag-phase2-export.js';
import EroPurgeDealState from './pipeline/ero-purge-deal-state.js';
import EroTestHypotheses from './pipeline/ero-test-hypotheses.js';
import EroTestRanking from './pipeline/ero-test-ranking.js';
import EroTestSourceTiers from './pipeline/ero-test-source-tiers.js';
import EroTestResearch from './pipeline/ero-test-research.js';
import EroTestAdjudication from './pipeline/ero-test-adjudication.js';
import EroTestConfrontation from './pipeline/ero-test-confrontation.js';
import EroTestRender from './pipeline/ero-test-render.js';
import EroTestDedup from './pipeline/ero-test-dedup.js';
import DcsExtractPresence from './pipeline/dcs-extract-presence.js';
import DcsComputeVerdicts from './pipeline/dcs-compute-verdicts.js';
import DcsComputeSummary from './pipeline/dcs-compute-summary.js';
import DcsRenderReport from './pipeline/dcs-render-report.js';
import DcsComputeMaterialityOverlay from './pipeline/dcs-compute-materiality-overlay.js';
import DcsRunPipeline from './pipeline/dcs-run-pipeline.js';
import DcsPreflightDiagnostic from './pipeline/dcs-preflight-diagnostic.js';
import RunCurationFixtures from './pipeline/run-curation-fixtures.js';
import DcsComputeDimensionRationales from './pipeline/dcs-compute-dimension-rationales.js';
import DcsPersistRationalesOneshot from './pipeline/dcs-persist-rationales-oneshot.js';
import DcsRepublishV2 from './pipeline/dcs-republish-v2.js';
import PublishEroToModuleOutputs from './pipeline/publish-ero-to-module-outputs.js';
import EroTestPublish from './pipeline/ero-test-publish.js';
import BssGetFindings from './pipeline/bss-get-findings.js';
import PromoteClaimsLedger from './pipeline/promote-claims-ledger.js';
import BuildStructuralProfile from './pipeline/bss-profile.js';
import BssAbsenceSweep from './pipeline/bss-absence-sweep.js';
import BssGenerateBlindCandidates from './pipeline/bss-generate.js';
import BssLlmAdjudication from './pipeline/bss-llm-adjudication.js';
import Stage5ExtractReferenceFigures from './pipeline/stage5-extract-reference-figures.js';
import ResetStageCheckpoints from './pipeline/reset-stage-checkpoints.js';
import OaFactNormalization from './pipeline/oa-fact-normalization.js';
import OaNormalizationReport from './pipeline/oa-normalization-report.js';
import OaTopicAssignment from './pipeline/oa-topic-assignment.js';
import OaIndexAssembly from './pipeline/oa-index-assembly.js';
import OaAbsenceProbe from './pipeline/oa-absence-probe.js';
import OaGapComparison from './pipeline/oa-gap-comparison.js';
import OaMateriality from './pipeline/oa-materiality.js';
import DiagP4Checkpoints from './pipeline/diag-p4-checkpoints.js';
import OaFindingAssembly from './pipeline/oa-finding-assembly.js';
import OaRender from './pipeline/oa-render.js';
import OaAcceptanceTests from './pipeline/oa-acceptance-tests.js';
import PublishOaToModuleOutputs from './pipeline/publish-oa-to-module-outputs.js';
import TestVerificationGate from './pipeline/test-verification-gate.js';
import PreserveArtifactSnapshot from './pipeline/preserve-artifact-snapshot.js';
// import PurgeDealPipelineState from './pipeline/purge-deal-pipeline-state.js';

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
import ResetFailedChunks from './checkpoints/reset-failed-chunks.js';

// Audit
import ExtractReportSnippets from './audit/extract-report-snippets.js';
import FramingPatternAudit from './audit/framing-pattern-audit.js';

const apis = {
  // AI pipeline
  AnalyzeChunk, UniversalExtract, MergeFindings, FormatReport, WebResearch,
  SaveModuleResult, LoadModuleResults, GetRunnableRuns, GetRunHistory, GetRunOutput,
  // Server-side pipeline
  RunModulePipeline, ResumeStalePipelines, DiagnoseParsedText, CleanParsedTextDryRun, CountSheets, DiagnoseChunks, DiagnoseRuns, DiagnoseChunkCoverage, DiagnoseChunkDetail, DiagnoseRunEvidence, DiagnoseFindingTrace, DiagnoseExtractionRaw, ResetDealRun, ResetModuleMerge, RunMigration004, RunMigration005, RunMigration006, RunMigration007, RunMigration009, RunMigration010, RunMigration011, RunMigration012, RunMigration013, RunMigration014, RunMigration015, DiagTimeoutProbe, ReadTimeoutProbeResult, ListTimeoutProbes, DiagMergeNodeSize, DiagRawFlagAggregate, DiagMergeFunnel, DiagMergeMetrics, DiagConsolidationFailure, DiagConsolidationDryrun, DiagOaIdentityFit, DiagModelGrouper, DiagPromptExport, ExportFindings, UnstickPool, ExtractReportChunk, DiagClaimsExtraction, DiagReconciliation, DiagMergeStall,     ResumeMergeRecovery, DiagnosticFinalization, ExportL3RawFindings, ConsolidateL3Export, ReadL3ExportChunk, GenerateL3ArtifactFiles, ReadArtifactChunk, AssembleExportArtifact, StreamExportArtifact, DownloadDiagnosticArtifact,
  ReplayDispositionHarness, ExportReplayEvidence, ReplayClaimLinkage, ReplayCanonicalIdentity, AssembleCanonicalFindings, ReplayPopulateClaimsLedger, DiagSaintReconciliation, GetSaintReconciliationPage, DiagReconciliationFindings,
  RegenerateQ2Candidates, PersistAndProveQ2, ReadPersistedQ2Artifact, DiagnoseSaveFailure, RunMigration016, FinalizePipelineOutput, CompleteMergeTree, PromoteRootFindings,
  DiagCheckpointInspect, DiagPartialNodeLedger, DiagMergeEmissionBudget, FenceRun, RunMigration017, RunMigration018, DiagSchemaVerify, TestConcurrencyGuards, DiagClaimExpiryCheck,
  DiagOaAncestry, DiagOaAncestryExport, TestOaAncestry, TestOaMergeContract, TestOaFamilyDedup, TestOaEvidenceAdmissionSynthesis,
  RunMigration019, RunMigration020, RunMigration021, OaPreconditionCheck, ReadDiagTrace, ResetMergeTruncation, RecoverRun7bbeab48, AdaptiveMergeRecovery, ValidateTreeRoot, FindingReductionGate, ScgClonedStatePreflight, DiagChecklistCoverage, DiagEngagementMap, DiagAbsenceMatcher, DiagConsolidationEngine, DiagMateriality, DiagNode17State, DiagFinalizationState, DiagSuppressedFindings, DiagDumpAnalysisRows,
  DiagExportIndexMap, DiagExportExtraction, DiagExportFinding, DiagBulkExtract, GetExtractionManifest, OaDiagQuery, DiagD1Documents, DiagD1ClaimsLedger, DiagD1Query, DiagSnippetMatchHarness,   DiagCoordCollisions, DiagReconcilerKeys, DiagReconcileOnly, DiagPhaseJControl, RunMigration022, RunMigration023, RunMigration024, RunMigration025, RunMigration026, RunMigration027, RunMigration028, RunMigration029, RunMigration030, RunMigration031, RunMigration032,   RunMigration033, RunMigration034, RunMigration035, RunMigration036, RunMigration037, RunMigration038, RunMigration039, PromoteClaimsLedger, BssRunPipeline, BssGetFindings, BuildStructuralProfile, BssGenerateBlindCandidates, BssAbsenceSweep, BssLlmAdjudication, Stage5ExtractReferenceFigures, ResetStageCheckpoints, OaFactNormalization, OaNormalizationReport, OaTopicAssignment, OaIndexAssembly, OaAbsenceProbe, OaGapComparison, OaMateriality, DiagP4Checkpoints, OaFindingAssembly, OaRender, OaAcceptanceTests, PublishOaToModuleOutputs, TestVerificationGate, DiagResumeCcRun, DiagTestResumeQuery, DiagDeleteCheckpointRow, PreserveArtifactSnapshot,
  // ERO v2 pipeline
  EroGetActiveRun, EroRunPipeline, EroDiagState, EroTestAdvance, EroTestEntityManifest, EroTestDealProfile, EroDiagPhase2Export, EroPurgeDealState, EroTestHypotheses, EroTestRanking, EroTestSourceTiers, EroTestResearch, EroTestAdjudication, EroTestConfrontation, EroTestRender, PublishEroToModuleOutputs, EroTestPublish, EroTestDedup,
  // DCS rebuild
  DcsExtractPresence, DcsComputeVerdicts, DcsComputeSummary, DcsRenderReport, DcsComputeMaterialityOverlay, DcsRunPipeline, DcsPreflightDiagnostic, RunCurationFixtures, DcsComputeDimensionRationales, DcsPersistRationalesOneshot, DcsRepublishV2,
  // MAST v2 pipeline
  MastRunPipeline, MastResetPipeline, MastDiagFormulaCoverage, MastDiagRetrievalProbe, MastDiagSweepProbe, MastPublish, MastRegisterRowsProbe,
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
  CancelModuleRun, CheckRunCancelled, PurgeStaleRuns, ResurrectModuleRun, ReconcileFindings, GetExtractionStatus, PurgeExtractions, PurgeDocumentExtractions, PurgeDealHistory, PurgePipelineCheckpoints, DiagFailedExtractions, ResetFailedChunks, ResumeCompletedRun,
  // Audit
  ExtractReportSnippets, FramingPatternAudit,
} as const;


export default apis;

/** Type for useApi inference - exported for client type-only imports */
export type ApiRegistry = typeof apis;
