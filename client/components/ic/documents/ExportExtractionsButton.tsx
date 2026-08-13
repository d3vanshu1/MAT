import { useState, useCallback, useRef } from "react";
import { Download } from "lucide-react";
import JSZip from "jszip";
import { executeApi } from "@/lib/executeApi.js";
import ICButton from "../ui/ICButton";

interface ExportExtractionsButtonProps {
  dealId: string;
  dealName: string;
}

/** 
 * Each extraction is 20-27K chars. The transport ceiling is ~28-30K serialized
 * JSON, so we fetch 1 chunk per call. Batching >1 causes isPartial truncation.
 * We compensate with parallel workers.
 */
/** Max parallel chunk fetches across all documents */
const CHUNK_CONCURRENCY = 4;

/**
 * Button that exports all document extractions for a deal as a ZIP file.
 * Each document becomes a single .md file with all chunks concatenated.
 * Downloads client-side using JSZip.
 */
export default function ExportExtractionsButton({ dealId, dealName }: ExportExtractionsButtonProps) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const abortRef = useRef(false);

  const handleExport = useCallback(async () => {
    setLoading(true);
    setProgress("Loading manifest…");
    abortRef.current = false;

    try {
      // Step 1: Get the manifest — all docs and chunk counts
      const manifest = await executeApi("GetExtractionManifest", { dealId });
      const docs = manifest.documents;

      if (!docs || docs.length === 0) {
        setProgress("No extractions found.");
        setLoading(false);
        return;
      }

      const zip = new JSZip();
      const totalChunks = docs.reduce((s: number, d: { chunkCount: number }) => s + d.chunkCount, 0);
      let chunksProcessed = 0;

      // Build a flat work queue: one task per chunk across all documents
      type ChunkTask = { docIdx: number; chunkIndex: number };
      const tasks: ChunkTask[] = [];
      const docChunks: string[][] = docs.map((doc: { chunkCount: number }) => new Array(doc.chunkCount).fill(""));

      for (let dIdx = 0; dIdx < docs.length; dIdx++) {
        for (let cIdx = 0; cIdx < docs[dIdx].chunkCount; cIdx++) {
          tasks.push({ docIdx: dIdx, chunkIndex: cIdx });
        }
      }

      // Step 2: Process all chunks with a concurrency pool
      let taskCursor = 0;
      const workers = Array.from({ length: CHUNK_CONCURRENCY }, async () => {
        while (!abortRef.current) {
          const idx = taskCursor++;
          if (idx >= tasks.length) break;
          const task = tasks[idx];
          const doc = docs[task.docIdx];

          try {
            const result = await executeApi("DiagBulkExtract", {
              dealId,
              documentId: doc.documentId,
              chunkStart: task.chunkIndex,
              chunkEnd: task.chunkIndex,
            });

            if (result.chunks && result.chunks.length > 0) {
              docChunks[task.docIdx][task.chunkIndex] = result.chunks[0].extraction;
            } else {
              docChunks[task.docIdx][task.chunkIndex] = `[Chunk ${task.chunkIndex}: empty]`;
            }
          } catch {
            docChunks[task.docIdx][task.chunkIndex] = `[Chunk ${task.chunkIndex}: fetch error]`;
          }

          chunksProcessed++;
          if (chunksProcessed % 4 === 0 || chunksProcessed === totalChunks) {
            setProgress(`${chunksProcessed}/${totalChunks} chunks`);
          }
        }
      });
      await Promise.all(workers);

      // Assemble each document into a markdown file
      for (let dIdx = 0; dIdx < docs.length; dIdx++) {
        const doc = docs[dIdx];
        const header = `# ${doc.fileName}\n\n**Document Tag:** ${doc.documentTag}\n**Chunks:** ${doc.chunkCount}\n\n---\n\n`;
        const body = docChunks[dIdx].join("\n\n---\n\n");

        const safeName = doc.fileName
          .replace(/[^a-zA-Z0-9._\-\s]/g, "")
          .replace(/\s+/g, "_")
          .replace(/\.[^.]+$/, "");

        zip.file(`${safeName}.md`, header + body);
      }

      if (abortRef.current) {
        setProgress("Cancelled.");
        setLoading(false);
        return;
      }

      // Step 3: Generate zip and trigger download
      setProgress("Generating ZIP…");
      const blob = await zip.generateAsync({ type: "blob" });

      const safeDealName = dealName
        .replace(/[^a-zA-Z0-9._\-\s]/g, "")
        .replace(/\s+/g, "_");

      // Use a link element for download
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeDealName}_extractions.zip`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();

      // Cleanup after a short delay
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);

      setProgress("Done! Check your downloads.");
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
        onClick={loading ? () => { abortRef.current = true; } : handleExport}
      >
        <Download className="w-4 h-4" />
        {loading ? "Cancel" : "Export Extractions"}
      </ICButton>
      {progress && (
        <span className="text-xs text-ic-muted font-light animate-pulse max-w-[280px] truncate">
          {progress}
        </span>
      )}
    </div>
  );
}
