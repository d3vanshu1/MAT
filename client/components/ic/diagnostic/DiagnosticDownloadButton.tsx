/**
 * DiagnosticDownloadButton
 *
 * Temporary UI component for downloading the complete L3 diagnostic corpus
 * directly from the application. Triggers a server-side ZIP generation and
 * browser download — no model-mediated chunk transfer.
 */
import { useState, useCallback } from "react";
import { useApi } from "@/hooks/useApi.js";
import { toast } from "sonner";

interface DiagnosticDownloadButtonProps {
  runId: string;
  moduleId?: string;
}

interface FileDetail {
  name: string;
  bytes: number;
  sha256: string;
  record_count: number;
}

interface DownloadResult {
  filename: string;
  content_base64: string;
  content_type: string;
  byte_size: number;
  bundle_sha256: string;
  generated_at: string;
  validation: {
    raw_finding_count: number;
    unique_raw_finding_ids: number;
    mapping_record_count: number;
    raw_ids_missing_from_mapping: number;
    mapping_ids_absent_from_raw: number;
    all_nodes_reconcile: boolean;
    json_valid: boolean;
    no_synthetic_records: boolean;
    no_truncation: boolean;
  };
  file_details: FileDetail[];
}

export default function DiagnosticDownloadButton({ runId, moduleId = "contradiction_check" }: DiagnosticDownloadButtonProps) {
  const { run: downloadArtifact, loading } = useApi("DownloadDiagnosticArtifact");
  const [lastResult, setLastResult] = useState<DownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    setError(null);
    setLastResult(null);

    try {
      const result = await downloadArtifact({
        runId,
        moduleId,
        artifact_type: "diagnostic_bundle",
      }) as DownloadResult | undefined;

      if (!result) {
        setError("No response from server");
        return;
      }

      // Trigger browser download immediately — do not hold in state
      const binaryString = atob(result.content_base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: result.content_type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Store metadata (not the content) for display
      setLastResult({ ...result, content_base64: "" });
      toast.success(`Downloaded ${result.filename} (${formatBytes(result.byte_size)})`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setError(msg);
      toast.error("Download failed: " + msg);
    }
  }, [runId, moduleId, downloadArtifact]);

  return (
    <div className="bg-[#0a1628] border border-[#1e3a5f] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-white" style={{ fontFamily: "Codec Pro, sans-serif" }}>
            Download Saint Diagnostic Corpus
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Complete L3 findings, mapping, and manifest as validated ZIP
          </p>
        </div>
        <button
          onClick={handleDownload}
          disabled={loading}
          className="px-4 py-2 rounded text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            fontFamily: "Codec Pro, sans-serif",
            backgroundColor: loading ? "#1e3a5f" : "#00b8c1",
            color: loading ? "#6b7280" : "#061f42",
          }}
        >
          {loading ? "Generating…" : "Download ZIP"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-[#e06448] bg-[#e0644810] border border-[#e0644840] rounded p-2">
          {error}
        </div>
      )}

      {lastResult && (
        <div className="text-xs space-y-2 border-t border-[#1e3a5f] pt-3">
          {/* Status summary */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-gray-300">
            <span className="text-gray-500">Status:</span>
            <span className={lastResult.validation.json_valid ? "text-green-400" : "text-[#e06448]"}>
              {lastResult.validation.json_valid ? "✓ Valid" : "✗ Validation failed"}
            </span>

            <span className="text-gray-500">File size:</span>
            <span>{formatBytes(lastResult.byte_size)}</span>

            <span className="text-gray-500">Raw findings:</span>
            <span>{lastResult.validation.raw_finding_count}</span>

            <span className="text-gray-500">Unique IDs:</span>
            <span>{lastResult.validation.unique_raw_finding_ids}</span>

            <span className="text-gray-500">Mapping records:</span>
            <span>{lastResult.validation.mapping_record_count}</span>

            <span className="text-gray-500">Reconciliation:</span>
            <span className={lastResult.validation.all_nodes_reconcile ? "text-green-400" : "text-[#e06448]"}>
              {lastResult.validation.all_nodes_reconcile ? "✓ All nodes match" : "✗ Mismatch"}
            </span>

            <span className="text-gray-500">Bundle SHA-256:</span>
            <span className="font-mono text-[10px] break-all">{lastResult.bundle_sha256}</span>

            <span className="text-gray-500">Generated:</span>
            <span>{formatTimestamp(lastResult.generated_at)}</span>
          </div>

          {/* Per-file details */}
          {lastResult.file_details.length > 0 && (
            <div className="mt-2">
              <span className="text-gray-500 text-[10px] uppercase tracking-wide">Files in bundle:</span>
              <div className="mt-1 space-y-1">
                {lastResult.file_details.map((f) => (
                  <div key={f.name} className="flex items-center gap-2 text-gray-400">
                    <span className="font-mono text-[10px] truncate flex-1">{f.name}</span>
                    <span className="text-[10px] whitespace-nowrap">{formatBytes(f.bytes)}</span>
                    {f.record_count > 0 && (
                      <span className="text-[10px] whitespace-nowrap text-gray-500">({f.record_count} records)</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}
