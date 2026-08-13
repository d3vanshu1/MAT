# CORRECTION: Previous version of this file was WRONG — based on fabricated document UUIDs

The prior version reported 8 documents with `totalLength: 0`. That was caused by
querying non-existent document IDs (correct first-segment prefix, fabricated UUID suffix).
`COALESCE(LENGTH(parsed_text), 0)` returns 0 when WHERE matches no row — not evidence
of empty text. Corrected below using the TRUE IDs from `DiagnoseChunks` (which JOINs
documents via deal_id, returning real rows).

---

# Parsed Text Status: All Documents in Deal c46b4129

**Run:** 461db6c0-c8a7-4073-96d6-832ff506469b  
**Deal:** c46b4129-8a16-48ae-ad3a-1da061255445  
**Source:** `DiagnoseChunks` API (serial execution, 2026-08-13)

## All 10 Documents — TRUE parsed_text Lengths

| Document ID (CORRECT) | File | Tag | parsed_text LENGTH | extraction_chunks | qa_chunks |
|---|---|---|---|---|---|
| `e27d46c9-c384-42ed-bc8c-6f04ba8bc474` | Legal DD Report | consultant_report | 870,824 | 175 | 484 |
| `e5d69a30-d768-4988-998f-bfdcb1a28058` | Vendor FDD Report | financial_model | 351,023 | 71 | 195 |
| `7973c0b4-3ba5-4d1f-98e6-39202ab70c80` | Altman Solon CDD Phase I | consultant_report | 194,903 | 39 | 109 |
| `02f3a1cc-0118-43aa-9371-249e65a96786` | SCG - Project Saint-IM_vF.pdf (CIM) | cim | 150,550 | 31 | 84 |
| `8fb7f474-9adf-4c02-b991-e180359812ea` | 2026-05-18 SCG - 2nd IC Memo vS.pdf | ic_memo | 123,962 | 25 | 69 |
| `31b3df2f-1653-42e5-8ad1-e58ab74e0399` | 2026-06-15 SCG - 3rd IC Memo vS.pdf | ic_memo | 118,060 | 24 | 66 |
| `440a86fb-93d6-4fd6-8d42-32f7047f8958` | SCG IC Screening Memo vS.pdf | ic_memo | 57,171 | 12 | 32 |
| `6197a6b2-a26c-423a-84b3-2766b0710b10` | 2026-06-21 Saint IC update_vS.pdf | ic_memo | 15,947 | 4 | 9 |
| `81758515-7905-4cb8-b72c-1d40e66d75e2` | SCG - Financial model (sellside).xlsx | financial_model | 2,871,247 | 0 | 1,598 |
| `3ea34aa1-6617-4d95-ae3c-5225d3da0387` | Financial model (PEP).xlsx | financial_model | 2,188,539 | 0 | 1,232 |

## Summary

- **ALL 8 PDF documents** have substantial parsed_text (15K–870K chars) and were fully chunked + extracted.
- **ALL 4 IC memos** have parsed_text and extraction_chunks. None are empty.
- **Both Excel files** have very large parsed_text (2.1M–2.8M, likely tabular dumps) but 0 extraction_chunks. They DO have QA chunks (1,232 / 1,598).
- **Total extraction_chunks across deal:** 381

## Previously-Used WRONG IDs (for reference — do NOT use)

| Short prefix | WRONG ID used before | CORRECT ID |
|---|---|---|
| 440a86fb | 440a86fb-8e89-4de3-b4d2-abe29e3e21d2 | 440a86fb-93d6-4fd6-8d42-32f7047f8958 |
| 31b3df2f | 31b3df2f-40b7-400f-b8f9-1a54f7c554f0 | 31b3df2f-1653-42e5-8ad1-e58ab74e0399 |
| 8fb7f474 | 8fb7f474-3e34-479e-9730-e5f9e3b5cedc | 8fb7f474-9adf-4c02-b991-e180359812ea |
| 6197a6b2 | 6197a6b2-f65e-4ddb-a4f4-c2f20aac2eff | 6197a6b2-a26c-423a-84b3-2766b0710b10 |
| 02f3a1cc | 02f3a1cc-1b45-4101-b2e8-7e35eba8b46c | 02f3a1cc-0118-43aa-9371-249e65a96786 |
| 7973c0b4 | 7973c0b4-dd2b-4e7b-893c-bef8b2e2d773 | 7973c0b4-3ba5-4d1f-98e6-39202ab70c80 |
| 3ea34aa1 | 3ea34aa1-6c1e-4de0-ba10-0f0e3dbb8ee9 | 3ea34aa1-6617-4d95-ae3c-5225d3da0387 |
| 81758515 | 81758515-be47-4a1b-b1e9-a64e47b44b05 | 81758515-7905-4cb8-b72c-1d40e66d75e2 |

## Method

- `DiagnoseChunks` API: JOINs `documents d LEFT JOIN universal_extractions ue ON ue.document_id = d.id WHERE d.deal_id = $1`
- Returns real document rows via deal_id FK — no fabrication risk.
- Individual verification: `DiagnoseParsedText` with correct ID `440a86fb-93d6-4fd6-8d42-32f7047f8958` returned `totalLength: 57171` and sample text starting "IC Screening Memo\n20 January 2026\nDeal Team:..."
