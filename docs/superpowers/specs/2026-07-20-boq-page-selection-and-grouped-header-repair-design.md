# BOQ Page Selection and Grouped-Header Repair

**Date:** 2026-07-20
**Status:** Approved for written-spec review

## Goal

Add a human-in-the-loop page-selection step before Docling parsing and repair deterministic parsing of grouped material/labour headers. The workflow must reduce noise from drawings and photographs without losing the original PDF, changing source page references, inventing prices, or saving an empty BOQ when no reliable priced rows are found.

The motivating quotation contains nine pages. Page 2 is the priced BOQ; page 1 is a quotation summary and pages 3–9 are drawings and photographs. The current v3 parser retains the source rows correctly but produces zero priced items because grouped headers such as `Material cost / Unit/Price` are mapped to component units instead of rates. Unpriced group headings and OCR representations of blank/dash cells also create avoidable warnings.

## Product Decisions

- Use a manual thumbnail page picker before Docling parsing.
- Preselect suggested BOQ pages, while keeping every checkbox editable.
- Require explicit confirmation before parsing the selected pages.
- Retain the complete original PDF unchanged.
- Store selected original page numbers in extraction-run evidence.
- If parsing produces zero reliable priced rows, remain in the upload flow and do not save an empty canonical BOQ.
- Keep uncertain source rows intact and expose them for human or AI review.

## Upload and Page-Selection Experience

After a valid PDF is chosen, the upload modal moves to a `Review pages` stage before parsing.

The page picker shows:

- a thumbnail and original page number for every page;
- a `Suggested` badge on pages whose text and table signals resemble a BOQ;
- editable checkboxes;
- `Select all`, `Clear all`, and `Select suggested` actions;
- a selected-page count;
- a primary action labeled with the number of selected pages.

Suggestions are convenience only. They never remove pages or start parsing automatically. The initial checked state contains the suggested pages. For the motivating quotation, page 2 is suggested and selected; the summary, drawing, and photo pages are not selected.

The browser renders thumbnails from the local file before import. Page suggestion uses bounded, deterministic text signals such as `description`, `quantity`, `qty`, `unit`, `material cost`, `labour cost`, `unit price`, `total price`, `amount`, and `BOQ`. A page with insufficient text remains available but is not presented as confidently suggested. No LLM is needed for page suggestion.

## Import and Sidecar Contract

The import request accepts an optional ordered `selectedPages` list containing unique, one-based original PDF page numbers. Requests without this field preserve the existing all-page behavior.

The server validates that the list:

- contains at least one page;
- contains only finite positive integers;
- has no duplicates;
- is within the original document page count;
- stays within the existing document and request-size limits.

The original PDF bytes are saved at the existing private source path. A selected-page derivative is created only in memory for Docling processing and is never treated as the source document.

The sidecar uses a PDF page-copy dependency to construct the temporary derivative. It maintains a mapping from derivative page index to original page number and remaps all table, source-row, warning, and source-reference page fields back to the original PDF numbering before returning contract v3. The response reports the original document page count and the selected original page numbers.

The extraction run stores the selected page numbers as immutable parser evidence. Its parser configuration fingerprint includes the selection, so parsing the same file with different pages creates a distinct auditable run.

Existing contract-v2 imports and v3 payloads without page-selection evidence remain readable. Existing BOQs without saved selection re-extract all pages by default. When selection evidence exists, re-extraction reuses it unless the user explicitly opens the page picker and changes it.

## Deterministic Parser Repair

Grouped component headers are resolved from the header leaf before generic substring matching:

- `Material cost / Unit/Price` maps to `material_rate`;
- `Material cost / Total/Price` maps to `material_total`;
- `Labour cost / Unit/Price` maps to `labour_rate`;
- `Labour cost / Total/Price` maps to `labour_total`;
- shared `Q'ty` and `Unit` columns remain the quantity and unit for both components when component-specific quantity or unit columns are absent;
- a final `Total Price` column remains the aggregate amount.

Unpriced description rows are classified as group headings when they are followed by priced rows with the same table/header context. They create section context and do not become zero-priced items. They remain source evidence and keep their original page/table/row references.

OCR-only punctuation that represents a visibly blank or dash cell is treated as missing evidence only when the token contains no digits or currency value. This normalization never creates zero, copies an aggregate into a component, or infers a missing price. A row with one complete component may yield that priced component with an incomplete-component warning; a row with no complete component remains unpriced and reviewable.

All existing arithmetic rules remain authoritative:

- quantity multiplied by rate must reconcile to the component total;
- material plus labour must reconcile to the aggregate when an aggregate is present;
- values must be finite and non-negative;
- aggregate bundle prices are never allocated to children without source component prices.

## Failure and Recovery Behavior

The page picker blocks parsing when no pages are selected.

If selected-page parsing yields zero reliable priced rows:

- no canonical BOQ is created;
- no empty draft appears in the BOQ list;
- the upload modal returns to page selection;
- page-specific warnings and the selected-page list remain visible;
- the user may change the selection and retry;
- source bytes and any staged extraction evidence are cleaned up using the existing atomic-import guarantees.

If at least one reliable priced row is extracted, the draft and immutable run are saved normally. Ambiguous rows remain visible in the extraction review. Docling or LLM failure never removes the original local file from the user's browser or silently changes the selection.

## Security and Audit Requirements

- The client suggestion is untrusted; the server validates every selected page.
- The selected-page derivative is temporary and never receives a public URL.
- Original PDF storage remains private and unchanged.
- Page-selection evidence is immutable per extraction run.
- Source references always use original PDF page numbers.
- No PDF text, price, or path is written to logs beyond existing sanitized categories.
- Prompt injection in PDF text cannot change the deterministic page-selection or parser rules.

## Testing

### Page selection

- browser tests for thumbnail rendering, suggested initial state, manual edits, select-all, clear-all, and keyboard accessibility;
- request tests for missing, duplicate, non-integer, negative, zero, and out-of-range pages;
- compatibility tests for omitted selection parsing all pages;
- source-reference tests proving derivative page 1 maps back to original page 2;
- extraction identity tests proving different selections produce different parser fingerprints;
- re-extraction tests for reuse and explicit replacement of a saved selection.

### Parser repair

Add an anonymized source-row fixture derived from the motivating page-2 table. Do not commit the private PDF. Verify:

- grouped material/labour rate and total headers map correctly;
- shared quantity and unit are applied to both components;
- group headings create sections without generating priced rows;
- OCR dash-like placeholders remain missing evidence;
- complete material-only or labour-only evidence survives with an explicit warning;
- all fully priced rows reconcile to their visible totals;
- the subtotal reconciles to `396,020.00` and the quoted total remains `456,000.00` with overhead represented according to existing adjustment rules;
- no amount is fabricated.

### End to end

Run upload → page review → suggested page 2 selected → parse → extraction review → saved draft. Confirm that pages 3–9 create no warnings, original page references remain page 2, reliable rows are present, and zero-item results return to page selection without saving a BOQ.

## Acceptance Criteria

The feature passes when:

1. Users can review and edit suggested pages before parsing.
2. The original PDF remains unchanged and available in the review workspace.
3. Extraction evidence records the selected original page numbers.
4. The motivating grouped-header structure produces reliable priced items or explicit row-level uncertainty without fabricated values.
5. A zero-item parse does not save an empty BOQ.
6. Existing all-page imports and BOQs remain compatible.
