# Parsed Text Status: Remaining Documents

**Run:** 461db6c0-c8a7-4073-96d6-832ff506469b  
**Deal:** c46b4129-8a16-48ae-ad3a-1da061255445

## Documents with `parsed_text` Present

| Document ID | File | Total Length | Status |
|---|---|---|---|
| `e5d69a30-d768-4988-998f-bfdcb1a28058` | Vendor FDD Report.pdf | 351,023 chars | ✅ Fully verified (15 slices) |
| `e27d46c9-c384-42ed-bc8c-6f04ba8bc474` | Legal DD Report.pdf | 870,824 chars | ✅ Verified (8 representative slices) |

## Documents with `parsed_text` = NULL / Empty (totalLength: 0)

| Document ID | File | Tag | Notes |
|---|---|---|---|
| `02f3a1cc-1b45-4101-b2e8-7e35eba8b46c` | SCG - Project Saint-IM_vF.pdf | cim | No parsed text stored |
| `3ea34aa1-6c1e-4de0-ba10-0f0e3dbb8ee9` | Project Saint - Financial model (PEP).xlsx | financial_model | XLSX — not parseable to text |
| `81758515-be47-4a1b-b1e9-a64e47b44b05` | SCG - Project Saint - Financial model (sellside).xlsx | financial_model | XLSX — not parseable to text |
| `440a86fb-8e89-4de3-b4d2-abe29e3e21d2` | SCG IC Screening Memo vS.pdf | ic_memo | No parsed text stored |
| `6197a6b2-f65e-4ddb-a4f4-c2f20aac2eff` | 2026-06-21 Saint IC update_vS.pdf | ic_memo | No parsed text stored |
| `31b3df2f-40b7-400f-b8f9-1a54f7c554f0` | 2026-06-15 SCG - 3rd IC Memo vS.pdf | ic_memo | No parsed text stored |
| `8fb7f474-3e34-479e-9730-e5f9e3b5cedc` | 2026-05-18 SCG - 2nd IC Memo vS.pdf | ic_memo | No parsed text stored |
| `7973c0b4-dd2b-4e7b-893c-bef8b2e2d773` | Altman Solon CDD Phase I.pdf | consultant_report | No parsed text stored |

## Analysis

Only 2 of 10 documents have persisted `parsed_text`:
- **Vendor FDD** (tagged `financial_model` but is actually a PDF consultant report)
- **Legal DD** (tagged `consultant_report`)

The remaining 8 documents have `totalLength: 0`, indicating:
1. **XLSX files** (2): Cannot be converted to plain text by the vision/parsing pipeline
2. **IC Memos** (4): Likely processed via a different pipeline path (inline text extraction at upload, not stored in `parsed_text` column)
3. **CIM** (1): Same as IC memos — not persisted
4. **CDD Phase I** (1): Same — not persisted

### Hypothesis

The `parsed_text` column is only populated for documents that go through the full vision-based extraction pipeline (large PDFs requiring OCR/vision processing). Smaller PDFs may have their text extracted ephemerally and fed directly to the chunking step without intermediate persistence, OR they were processed via a different code path that doesn't write to this column.

## Table/Column Checked

- **Table:** `documents`
- **Column:** `parsed_text`
- **Method:** `DiagnoseParsedText` API with `offset: 1, length: 25000`
- **Result for empty docs:** `{ sample: "", totalLength: 0 }`
