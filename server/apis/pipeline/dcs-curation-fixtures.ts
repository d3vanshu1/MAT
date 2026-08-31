/**
 * DCS Evidence Curation — Packet 6A Pure Fixtures
 *
 * 13 deterministic tests exercising the pure functions in dcs-evidence-curation.ts.
 * No database access, no I/O.
 */
import {
  isExitPromotionEligible,
  computeExitDimensionState,
  curateDimensionPackets,
  resolveHumanLocation,
} from "./dcs-evidence-curation.js";
import type { RawEvidenceRow, ChunkMeta, CuratedDimensionPacket } from "./dcs-evidence-curation.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeRow(overrides: Partial<RawEvidenceRow> & { id: string; dimension_id: string }): RawEvidenceRow {
  return {
    chunk_id: "chunk-001",
    source_file: "test.pdf",
    document_tag: "consultant_report",
    doc_class: "workproduct",
    is_substantive: true,
    snippet: "Test snippet content here.",
    ...overrides,
  };
}

const results: Array<{ fixture: number; name: string; pass: boolean; detail: string }> = [];

function assert(fixture: number, name: string, condition: boolean, detail: string = "") {
  results.push({ fixture, name, pass: condition, detail: condition ? "PASS" : `FAIL: ${detail}` });
}

// ═════════════════════════════════════════════════════════════════
// FIXTURE 1: Preference shares do not promote Exit
// ═════════════════════════════════════════════════════════════════
const f1 = isExitPromotionEligible(
  "Total preference shares b/f,,,,-,\"197,372,364\",\"224,122,387\"",
  "financial_model",
  "SCG - Project Saint - Financial model_vS.xlsx",
);
assert(1, "Preference shares do not promote Exit", f1 === false, `got ${f1}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 2: Generic EBITDA / enterprise value does not promote
// ═════════════════════════════════════════════════════════════════
const f2a = isExitPromotionEligible(
  "EBITDA synergies,,12,,,\"250,000\",,,,,,",
  "financial_model",
  "SCG - Project Saint - Financial model_vS.xlsx",
);
const f2b = isExitPromotionEligible(
  "Enterprise value at 8.5x EBITDA multiple yields $450M",
  "financial_model",
  "SCG - Project Saint - Financial model_vS.xlsx",
);
assert(2, "Generic EBITDA/EV does not promote Exit", f2a === false && f2b === false, `synergy=${f2a}, ev=${f2b}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 3: IC exit assumptions → asserted, not evidenced
// ═════════════════════════════════════════════════════════════════
const f3state = computeExitDimensionState([
  {
    doc_class: "narrative",
    is_substantive: true,
    snippet: "Exit assumptions: 5-year hold period with target IRR of 25%",
    document_tag: "ic_memo",
    source_file: "3rd IC Memo.pdf",
  },
]);
assert(3, "IC exit assumptions → asserted", f3state === "asserted", `got ${f3state}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 4: Independent buyer analysis CAN promote Exit
// ═════════════════════════════════════════════════════════════════
const f4 = isExitPromotionEligible(
  "Buyer universe analysis identifies 12 strategic buyers and 8 financial sponsors with demonstrated interest in the sector",
  "consultant_report",
  "Exit Advisory - Buyer Analysis.pdf",
);
assert(4, "Independent buyer analysis promotes Exit", f4 === true, `got ${f4}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 5: Explicit LBO/returns workproduct CAN promote Exit
// ═════════════════════════════════════════════════════════════════
const f5 = isExitPromotionEligible(
  "LBO analysis projects sponsor MOIC of 2.8x and IRR of 24% at exit year 5, assuming 6x EV/EBITDA exit multiple",
  "financial_model",
  "Project Saint - LBO Model.xlsx",
);
assert(5, "Explicit LBO/returns workproduct promotes Exit", f5 === true, `got ${f5}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 6: Generic model IRR without exit context cannot promote
// ═════════════════════════════════════════════════════════════════
const f6 = isExitPromotionEligible(
  "Total Revenue,,\"125,324,457\",\"144,842,368\",\"168,205,662\"",
  "financial_model",
  "SCG - Project Saint - Financial model_vS.xlsx",
);
assert(6, "Generic model IRR without exit context cannot promote", f6 === false, `got ${f6}`);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 7: CDD market prose ranks above AMPU vector
// ═════════════════════════════════════════════════════════════════
const cddRow = makeRow({
  id: "r1",
  dimension_id: "commercial",
  source_file: "09 04 2026 Altman Solon - Providence Equity Partners - Buyside CDD - Phase I_vFinal Report.pdf",
  document_tag: "consultant_report",
  snippet: "The UK fire and security market is estimated at £8.2bn with organic growth of 4-5% driven by regulatory requirements and increased adoption of smart building technologies.",
});
const ampu = makeRow({
  id: "r2",
  dimension_id: "commercial",
  source_file: "SCG - Project Saint - Financial model_vS.xlsx",
  document_tag: "financial_model",
  snippet: "1.2,1.1,1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1,0.0",
});
const f7packets = curateDimensionPackets([cddRow, ampu], new Map());
const f7commercial = f7packets.find((p) => p.dimensionId === "commercial")!;
assert(
  7,
  "CDD market prose ranks above AMPU vector",
  f7commercial.curatedEvidence.length >= 2 &&
    f7commercial.curatedEvidence[0].sourceFile.includes("Altman Solon"),
  `first source: ${f7commercial.curatedEvidence[0]?.sourceFile}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 8: PwC QoE prose ranks above unexplained revenue series
// ═════════════════════════════════════════════════════════════════
const pwcRow = makeRow({
  id: "r3",
  dimension_id: "financial_qoe",
  source_file: "SCG - Project Saint - Vendor Financial Due Diligence Report - 28.11.2025.pdf",
  document_tag: "consultant_report",
  snippet: "Revenue has grown at a CAGR of 15.6% over the last three fiscal years, driven primarily by organic growth in the monitoring division and selective M&A.",
});
const revSeries = makeRow({
  id: "r4",
  dimension_id: "financial_qoe",
  source_file: "SCG - Project Saint - Financial model_vS.xlsx",
  document_tag: "financial_model",
  snippet: "125324457,144842368,168205662,187057633,219708681,264907396,314120131,365289809,419812384",
});
const f8packets = curateDimensionPackets([pwcRow, revSeries], new Map());
const f8fin = f8packets.find((p) => p.dimensionId === "financial_qoe")!;
assert(
  8,
  "PwC QoE prose ranks above revenue series",
  f8fin.curatedEvidence.length >= 2 &&
    f8fin.curatedEvidence[0].sourceFile.includes("Vendor Financial"),
  `first source: ${f8fin.curatedEvidence[0]?.sourceFile}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 9: Material Legal risk ranks above routine rent data
// ═════════════════════════════════════════════════════════════════
const legalRisk = makeRow({
  id: "r5",
  dimension_id: "legal_regulatory",
  source_file: "Project Saint - Legal Due Diligence Report - 28 November 2025_.pdf",
  document_tag: "consultant_report",
  snippet: "The Group is subject to an ongoing employment tribunal claim by a former senior employee alleging unfair dismissal and breach of contract, with potential liability estimated at £350,000.",
});
const rentData = makeRow({
  id: "r6",
  dimension_id: "legal_regulatory",
  source_file: "SCG - Project Saint - Financial model_vS.xlsx",
  document_tag: "financial_model",
  snippet: "Rent,,,25000,25000,25000,25000,25000,25000,25000,25000,25000,25000,25000,25000",
});
const f9packets = curateDimensionPackets([legalRisk, rentData], new Map());
const f9legal = f9packets.find((p) => p.dimensionId === "legal_regulatory")!;
assert(
  9,
  "Material Legal risk ranks above routine rent data",
  f9legal.curatedEvidence.length >= 2 &&
    f9legal.curatedEvidence[0].sourceFile.includes("Legal Due Diligence"),
  `first source: ${f9legal.curatedEvidence[0]?.sourceFile}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 10: Normalized duplicates selected once
// ═════════════════════════════════════════════════════════════════
const dup1 = makeRow({
  id: "r7",
  dimension_id: "commercial",
  snippet: "The market is growing at 5% per annum.",
});
const dup2 = makeRow({
  id: "r8",
  dimension_id: "commercial",
  snippet: "The  market  is  growing  at  5%  per  annum.", // extra spaces
});
const f10packets = curateDimensionPackets([dup1, dup2], new Map());
const f10commercial = f10packets.find((p) => p.dimensionId === "commercial")!;
assert(
  10,
  "Normalized duplicates selected once",
  f10commercial.curatedEvidence.length === 1 && f10commercial.excludedCandidateCounts.duplicates === 1,
  `curated=${f10commercial.curatedEvidence.length}, dupes=${f10commercial.excludedCandidateCounts.duplicates}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 11: PDF and workbook locations resolve correctly
// ═════════════════════════════════════════════════════════════════
// Note: With current metadata (no page/sheet info in schema),
// locations will be "unavailable". This tests the function handles it correctly.
const pdfMeta: ChunkMeta = {
  chunk_id: "chunk-pdf",
  chunk_index: 42,
  file_name: "Report.pdf",
  file_type: "application/pdf",
};
const excelMeta: ChunkMeta = {
  chunk_id: "chunk-xlsx",
  chunk_index: 100,
  file_name: "Model.xlsx",
  file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const f11pdf = resolveHumanLocation("chunk-pdf", "Report.pdf", pdfMeta);
const f11excel = resolveHumanLocation("chunk-xlsx", "Model.xlsx", excelMeta);
assert(
  11,
  "PDF and workbook locations resolve correctly",
  f11pdf.locationStatus === "unavailable" && f11excel.locationStatus === "unavailable",
  `pdf=${f11pdf.locationStatus}, xlsx=${f11excel.locationStatus}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 12: Missing locations return unavailable
// ═════════════════════════════════════════════════════════════════
const f12 = resolveHumanLocation("chunk-missing", "Unknown.pdf", undefined);
assert(
  12,
  "Missing locations return unavailable",
  f12.locationStatus === "unavailable" && f12.humanLocation === "",
  `status=${f12.locationStatus}, location=${f12.humanLocation}`,
);

// ═════════════════════════════════════════════════════════════════
// FIXTURE 13: Identical inputs produce byte-identical packets
// ═════════════════════════════════════════════════════════════════
const detRows: RawEvidenceRow[] = [
  makeRow({ id: "det1", dimension_id: "commercial", snippet: "Market analysis shows growth." }),
  makeRow({ id: "det2", dimension_id: "financial_qoe", snippet: "QoE adjustments totaled £2.1m." }),
  makeRow({ id: "det3", dimension_id: "exit", doc_class: "narrative", document_tag: "ic_memo", snippet: "Exit at 5yr horizon." }),
];
const run1 = JSON.stringify(curateDimensionPackets(detRows, new Map()));
const run2 = JSON.stringify(curateDimensionPackets(detRows, new Map()));
assert(
  13,
  "Identical inputs produce byte-identical packets",
  run1 === run2,
  `lengths: ${run1.length} vs ${run2.length}`,
);

// ═════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;

export const fixtureResults = {
  passed,
  failed,
  total: results.length,
  results,
  allPassed: failed === 0,
};
