# Parsed Text Extraction Methodology

## Source
- Table: `documents`
- Column: `parsed_text`
- API: `DiagnoseParsedText` (offset/length based substring extraction)

## Constraints
- API response payload limit: ~25,000 characters per call
- Vendor FDD (e5d69a30): 351,023 chars → 15 slices
- Legal DD (e27d46c9): 870,824 chars → 35 slices

## Extraction Process
Text extracted using `SUBSTRING(parsed_text FROM <offset> FOR 25000)` via
DiagnoseParsedText API. Slices concatenated in order to produce the full
parsed_text as stored post-vision, pre-chunk.

## Files
- `e5d69a30-d768-4988-998f-bfdcb1a28058.txt` — Vendor FDD (351,023 chars)
- `e27d46c9-c384-42ed-bc8c-6f04ba8bc474.txt` — Legal DD (870,824 chars)
