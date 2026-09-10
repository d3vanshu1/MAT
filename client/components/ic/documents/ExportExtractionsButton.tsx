import { useState, useCallback } from "react";
import { Download } from "lucide-react";
import JSZip from "jszip";
import { executeApi } from "@/lib/executeApi.js";
import ICButton from "../ui/ICButton";

interface ExportExtractionsButtonProps {
  dealId: string;
  dealName: string;
}

/**
 * TEMPORARY: Rewired to export ERO report markdown + findings JSON.
 * Original extractions export preserved below as comments.
 */
export default function ExportExtractionsButton({ dealId, dealName }: ExportExtractionsButtonProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");

  const handleExport = useCallback(async () => {
    setLoading(true);
    setProgress("Fetching ERO report + findings…");

    try {
      const result = await executeApi("DumpEroReport", {
        runId: dealId === "d3b3dd69-b58e-4943-a49d-24e9099e2da5"
          ? "aa3f75d0-93a6-4e48-bf2d-a7ac76fa33bf"   // CheckedUp
          : "def0f8e5-3b79-43bb-9821-a8552940645e",   // SCG
      });

      const zip = new JSZip();
      zip.file("ero_report.md", result.reportMarkdown);
      zip.file("ero_findings.json", JSON.stringify(result.findings, null, 2));

      setProgress("Generating ZIP…");
      const blob = await zip.generateAsync({ type: "blob" });

      const safeDealName = dealName
        .replace(/[^a-zA-Z0-9._\-\s]/g, "")
        .replace(/\s+/g, "_");

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeDealName}_ero_export.zip`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);

      setProgress(`Done! ${result.findings.length} findings exported.`);
      setTimeout(() => setProgress(""), 4000);
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
      setProgress(`Error: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [dealId, dealName]);

  return (
    <div className="flex items-center gap-2">
      <ICButton
        variant="secondary"
        size="md"
        loading={loading}
        onClick={handleExport}
      >
        <Download className="w-4 h-4" />
        {loading ? "Exporting…" : "Export ERO Report"}
      </ICButton>
      {progress && (
        <span className="text-xs text-ic-muted font-light animate-pulse max-w-[280px] truncate">
          {progress}
        </span>
      )}
    </div>
  );
}
