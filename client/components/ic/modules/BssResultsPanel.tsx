/**
 * BssResultsPanel — renders BSS v2 findings after the orchestrator completes.
 *
 * Shows:
 * - Funnel summary: N candidates → M findings, with drop counts
 * - Each finding: assumption, adjudication verdict + quote, dependency evidence
 * - Two standing caveats:
 *   1. Suspect flag for missing adviser workstreams (EQTR, Hakluyt, Kolayo)
 *   2. Over-reported-absence caveat on all findings
 * - Collapsed drops section: how many dropped_covered and dropped_no_dependency
 */
import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  EyeOff,
  Filter,
  Quote,
  Info,
} from "lucide-react";

// ── Types (matches BssGetFindings API output) ─────────────────────────────

export interface BssFinding {
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

export interface BssFunnel {
  totalCandidates: number;
  findings: number;
  droppedCovered: number;
  droppedNoDependency: number;
}

interface BssResultsPanelProps {
  findings: BssFinding[];
  funnel: BssFunnel;
}

// ── Suspect-flag workstreams ──────────────────────────────────────────────

const SUSPECT_WORKSTREAMS = ["EQTR", "Hakluyt", "Kolayo"];

export default function BssResultsPanel({ findings, funnel }: BssResultsPanelProps) {
  const [showDrops, setShowDrops] = useState(false);

  const totalDropped = funnel.droppedCovered + funnel.droppedNoDependency;

  return (
    <div className="space-y-5">
      {/* ── Funnel summary ──────────────────────────────────────────── */}
      <div className="rounded-xl border border-ic-border bg-ic-surface p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-ic-turquoise" />
          <h3 className="text-sm font-bold text-ic-text">Blind Spot Funnel</h3>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <FunnelCell label="Candidates" value={funnel.totalCandidates} color="text-ic-muted" />
          <FunnelCell label="Findings" value={funnel.findings} color="text-ic-coral" />
          <FunnelCell label="Covered" value={funnel.droppedCovered} color="text-ic-turquoise" />
          <FunnelCell label="No dependency" value={funnel.droppedNoDependency} color="text-ic-muted" />
        </div>

        {/* Collapsed drops detail */}
        {totalDropped > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowDrops(!showDrops)}
              className="flex items-center gap-1.5 text-xs text-ic-muted hover:text-ic-turquoise transition-colors cursor-pointer"
            >
              {showDrops ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showDrops ? "Hide drops" : `Show ${totalDropped} dropped candidates`}
            </button>
            {showDrops && (
              <div className="mt-2 p-3 rounded-lg bg-ic-surface-light border border-ic-border text-xs text-ic-muted space-y-1.5">
                <p>
                  <strong className="text-ic-turquoise">{funnel.droppedCovered}</strong> dropped as{" "}
                  <em>covered</em> — the data room evidence shows these assumptions are explicitly
                  addressed in the diligence materials.
                </p>
                <p>
                  <strong className="text-ic-muted">{funnel.droppedNoDependency}</strong> dropped as{" "}
                  <em>no dependency</em> — the thesis does not depend on these assumptions being
                  true, so their absence is non-material.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Standing caveats ────────────────────────────────────────── */}
      <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-4 space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-200/80 space-y-2">
            <p>
              <strong>Over-reported-absence caveat:</strong> Blind spot analysis searches
              the uploaded data room only. An assumption may appear absent in the documents
              provided but be addressed in materials not yet uploaded (board packs, management
              presentations, working group outputs). Findings should be read as
              &ldquo;not found in the indexed evidence&rdquo; rather than &ldquo;not addressed.&rdquo;
            </p>
            <p>
              <strong>Suspect workstream flag:</strong> If adviser workstreams that are expected
              for this deal type (specifically: {SUSPECT_WORKSTREAMS.join(", ")}) have not been
              uploaded, any finding that would be addressed by those workstreams may be a
              false positive. Review those findings with additional scrutiny.
            </p>
          </div>
        </div>
      </div>

      {/* ── Findings list ───────────────────────────────────────────── */}
      {findings.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-sm font-bold text-ic-text/80">
            Findings ({findings.length})
          </h4>
          {findings.map((f) => (
            <BssFindingCard key={f.candidate_id} finding={f} />
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-ic-muted text-sm">
          No blind spots survived adjudication — all candidates were covered or non-material.
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function FunnelCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-ic-muted">{label}</div>
    </div>
  );
}

function BssFindingCard({ finding }: { finding: BssFinding }) {
  const [expanded, setExpanded] = useState(false);

  const passLabel = finding.pass_type === "blind" ? "Blind pass" : "Informed pass";

  return (
    <div className="rounded-xl border border-ic-coral/30 bg-ic-surface overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-ic-surface-light/50 transition-colors cursor-pointer"
      >
        <EyeOff className="w-4 h-4 text-ic-coral mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-ic-text leading-tight">
            {finding.implied_assumption}
          </p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-xs px-1.5 py-0.5 rounded bg-ic-coral/20 text-ic-coral font-bold">
              {finding.adjudicated_verdict ?? "—"}
            </span>
            <span className="text-xs text-ic-muted">
              {passLabel} · {finding.failure_mode}
            </span>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-ic-muted flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-ic-muted flex-shrink-0" />
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-ic-border">
          {/* Hypothesis */}
          <div className="pt-3">
            <label className="text-xs font-bold text-ic-muted uppercase tracking-wider">
              Hypothesis
            </label>
            <p className="text-sm text-ic-text/90 mt-1">{finding.hypothesis}</p>
          </div>

          {/* Adjudication quote */}
          {finding.adjudication_quote && (
            <div className="flex gap-2 p-3 rounded-lg bg-ic-surface-light border border-ic-border">
              <Quote className="w-4 h-4 text-ic-turquoise flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-ic-turquoise font-bold mb-1">Adjudication evidence</p>
                <p className="text-sm text-ic-text/80 italic">
                  &ldquo;{finding.adjudication_quote}&rdquo;
                </p>
              </div>
            </div>
          )}

          {/* Adjudication reason */}
          {finding.adjudication_reason && (
            <div>
              <label className="text-xs font-bold text-ic-muted uppercase tracking-wider">
                Reasoning
              </label>
              <p className="text-sm text-ic-text/80 mt-1">{finding.adjudication_reason}</p>
            </div>
          )}

          {/* Dependency evidence */}
          <div>
            <label className="text-xs font-bold text-ic-muted uppercase tracking-wider">
              Dependency check
            </label>
            <div className="flex items-center gap-3 mt-1 text-xs text-ic-muted">
              <DependencyBadge label="Thesis dependency" hit={finding.thesis_hit} />
              <DependencyBadge label="Memo mention" hit={finding.latest_memo_hit} />
            </div>
          </div>

          {/* Rationale (from generation) */}
          {finding.rationale && (
            <div>
              <label className="text-xs font-bold text-ic-muted uppercase tracking-wider">
                Generation rationale
              </label>
              <p className="text-sm text-ic-text/70 mt-1">{finding.rationale}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DependencyBadge({ label, hit }: { label: string; hit: boolean | null }) {
  if (hit === null) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
        hit
          ? "bg-ic-turquoise/20 text-ic-turquoise"
          : "bg-ic-coral/20 text-ic-coral"
      }`}
    >
      {hit ? "✓" : "✗"} {label}
    </span>
  );
}
