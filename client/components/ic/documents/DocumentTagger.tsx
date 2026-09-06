import { useState, useCallback } from "react";
import { X, Save, FileText, Tag } from "lucide-react";
import type { Document, DocumentTag } from "@/types/document";
import { DOCUMENT_TAG_LABELS } from "@/types/document";

const TAG_OPTIONS: DocumentTag[] = [
  "ic_memo",
  "cim",
  "consultant_report",
  "financial_model",
  "customer_data",
  "legal",
  "other",
];

const TAG_COLORS: Record<DocumentTag, string> = {
  ic_memo: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  cim: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  consultant_report: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  financial_model: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  customer_data: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  legal: "bg-red-500/20 text-red-300 border-red-500/30",
  other: "bg-gray-500/20 text-gray-300 border-gray-500/30",
};

interface DocumentTaggerProps {
  open: boolean;
  onClose: () => void;
  documents: Document[];
  onSave: (changes: Array<{ docId: string; tag: DocumentTag }>) => void;
}

export default function DocumentTagger({ open, onClose, documents, onSave }: DocumentTaggerProps) {
  const [localTags, setLocalTags] = useState<Record<string, DocumentTag>>(() => {
    const map: Record<string, DocumentTag> = {};
    for (const doc of documents) {
      map[doc.id] = doc.document_tag;
    }
    return map;
  });

  const [saving, setSaving] = useState(false);

  const changedCount = documents.filter(
    (d) => localTags[d.id] !== d.document_tag
  ).length;

  const handleTagChange = useCallback((docId: string, tag: DocumentTag) => {
    setLocalTags((prev) => ({ ...prev, [docId]: tag }));
  }, []);

  const handleSave = useCallback(async () => {
    const changes = documents
      .filter((d) => localTags[d.id] !== d.document_tag)
      .map((d) => ({ docId: d.id, tag: localTags[d.id] }));
    if (changes.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    onSave(changes);
    setSaving(false);
    onClose();
  }, [documents, localTags, onSave, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0a1628] border border-[#1e3a5f] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e3a5f]">
          <div className="flex items-center gap-3">
            <Tag className="w-5 h-5 text-[#00b8c1]" />
            <h2 className="text-base font-bold text-white" style={{ fontFamily: "Codec Pro, sans-serif" }}>
              Tag Documents
            </h2>
            <span className="text-xs text-gray-400 font-light">
              {documents.length} document{documents.length !== 1 ? "s" : ""}
            </span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* Document list */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b border-[#1e3a5f]">
                <th className="text-left py-2 font-bold">Document</th>
                <th className="text-left py-2 font-bold w-48">Type</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const currentTag = localTags[doc.id] ?? doc.document_tag;
                const isChanged = currentTag !== doc.document_tag;
                return (
                  <tr
                    key={doc.id}
                    className={"border-b border-[#1e3a5f]/50 hover:bg-white/[0.02] transition-colors" + (isChanged ? " bg-[#00b8c1]/[0.04]" : "")}
                  >
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                        <span className="text-sm text-gray-200 font-light truncate" title={doc.file_name}>
                          {doc.file_name}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <select
                        value={currentTag}
                        onChange={(e) => handleTagChange(doc.id, e.target.value as DocumentTag)}
                        className={
                          "w-full px-2.5 py-1.5 rounded-lg text-xs font-bold border cursor-pointer " +
                          "focus:outline-none focus:ring-2 focus:ring-[#00b8c1]/40 " +
                          "appearance-none bg-no-repeat bg-[length:12px] bg-[center_right_8px] " +
                          TAG_COLORS[currentTag]
                        }
                        style={{
                          backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
                        }}
                      >
                        {TAG_OPTIONS.map((t) => (
                          <option key={t} value={t}>
                            {DOCUMENT_TAG_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#1e3a5f]">
          <span className="text-xs text-gray-500 font-light">
            {changedCount > 0
              ? changedCount + " change" + (changedCount !== 1 ? "s" : "") + " pending"
              : "No changes"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs text-gray-400 hover:text-white border border-[#1e3a5f] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={changedCount === 0 || saving}
              className={
                "flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg transition-colors " +
                (changedCount > 0
                  ? "bg-[#00b8c1] text-white hover:bg-[#00a0a8] cursor-pointer"
                  : "bg-gray-700 text-gray-500 cursor-not-allowed")
              }
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? "Saving…" : "Save Tags"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
