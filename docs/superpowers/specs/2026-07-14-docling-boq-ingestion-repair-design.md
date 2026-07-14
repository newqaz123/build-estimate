# Docling BOQ Ingestion Repair — Design Spec

## Purpose

Repair the BOQ upload and review flow so it shows the uploaded source PDF, extracts trustworthy metadata and line items from real Southeast Asian construction quotations, removes the unhelpful Code and Type fields from review, and remains useful when LLM verification is unavailable.

## Scope

This work covers:

- authenticated PDF upload and source retention;
- Docling extraction and deterministic normalization;
- metadata extraction for vendor, project, work type, and document date;
- review-panel source preview and editable line items;
- LLM verification error handling and deterministic fallback checks;
- regression coverage using the supplied real quotations.

It does not redesign the Standard Catalog, estimate builder, comparison workflow, or historical approved BOQs beyond backward-compatible schema handling needed by ingestion.

## Observed Failures and Root Causes

1. The review panel renders a hardcoded HTML quotation instead of the uploaded PDF.
2. The Docling sidecar returns only a filename and normalized sections. The upload client therefore substitutes the filename, `Unknown Vendor`, `Structural`, and today's date.
3. The parser assumes one flat `Description / Unit / Qty / Rate / Total` header. Real quotations contain multi-row headers, separate material and labour costs, amount-only rows, cover pages, drawings, notes, and subtotal rows.
4. The visible Code field is populated from row numbers or synthetic parser codes and adds no review value.
5. LLM verification uses process environment defaults instead of workspace AI settings, hides upstream error details, and provides no non-LLM verification path.

## Representative Source Variants

The supplied documents establish these required cases:

- Eastern Group quotations (`ayt001.pdf`, `ayt074.pdf`): material and labour can have different quantities and units within one source row.
- Surasak Engineering quotations: a single lump-sum description and amount with no explicit quantity, unit, or rate.
- N.P. Civil BOQs: cover page followed by a BOQ page with one shared quantity/unit and separate material and labour unit costs; later pages may be drawings or photographs.
- English and Thai/English bilingual labels, with dates in long English, `DD/MM/YYYY`, and two-digit-year formats.

## Architecture

### Unified import operation

Add an authenticated multipart import endpoint that owns the complete transaction:

1. Validate the PDF type and 20 MB size limit.
2. Allocate a BOQ draft ID.
3. Store the exact PDF under a BOQ-scoped path in Firebase Storage.
4. Send the same bytes to the configured Docling sidecar.
5. Normalize Docling tables and document text into metadata, sections, items, and warnings.
6. Persist the draft BOQ with source-document metadata.
7. Return the draft to the client for review.

If parsing fails before a useful draft can be produced, delete the just-uploaded storage object and return an actionable error. Database creation must not succeed without its referenced source PDF.

The existing `/api/docling/parse` proxy may remain as an internal boundary, but the client must call only the unified import operation so storage, parsing, and draft creation cannot drift apart.

### Authenticated source preview

Add a BOQ source route that authenticates the user, locates the BOQ's storage object, and streams the PDF inline with `Content-Type: application/pdf`. The review panel embeds this route and uses the browser PDF viewer for page navigation and zoom. It no longer generates quotation content from parsed rows.

### Sidecar extraction contract

Extend the sidecar response with:

- document name;
- page count;
- extracted document text with page boundaries;
- raw table cells with page numbers and multi-row headers preserved;
- normalized sections and items;
- extracted metadata candidates;
- warnings and confidence indicators.

The Next.js layer validates this response before persistence. Invalid or incomplete sidecar responses become explicit import errors rather than silently receiving defaults.

## Normalization Rules

Normalization is deterministic and testable. LLM output is not required to create line items.

### Row classification

Rows are classified before item conversion:

- line item;
- section heading;
- detail/note continuation;
- subtotal, VAT, discount, or grand total;
- amount-in-words footer;
- empty/decorative row.

Only line-item rows become `BoqItem` records. Section headings label their following items. Detail rows may be appended to the preceding item's source description but never become priced items on their own.

### Cost-shape handling

1. **Flat table:** Preserve the source unit, quantity, rate, and total. Derive a missing total from quantity times rate only when both inputs are present.
2. **Shared quantity with material and labour rates:** When both components use the same row-level quantity and unit, store one item whose rate is material rate plus labour rate and whose total is the source Amount. Preserve component values as source-cost metadata for audit.
3. **Different material and labour quantities or units:** Emit separate Material and Labour items. Each keeps its own quantity, unit, rate, and component total. Use a `costComponent` field instead of modifying the human description with a suffix.
4. **Single component:** Emit one line item from whichever material or labour component is present.
5. **Amount-only quotation:** Emit one lump-sum item with quantity `1`, unit `L/S`, rate equal to the amount, and total equal to the amount.

Rows that cannot satisfy a reliable cost shape remain visible as review warnings and are not silently coerced into zero-valued items.

### Totals

The normalized sum is checked against the source subtotal or final pre-VAT amount when identifiable. VAT and discounts are captured as document-level validation context, not ordinary line items. A mismatch produces a review warning with both values.

## Metadata Extraction

Metadata extraction uses labeled document text, table headings, and stable layout-independent patterns.

- **Vendor:** seller/company identity from the quotation header or explicit contractor field; never the `To`, owner, or customer company.
- **Project:** explicit Project or Subject value; otherwise the primary priced section heading or sole lump-sum description.
- **Document date:** labeled Date or Doc. Date normalized to `YYYY-MM-DD`. Two-digit years use the document's century context.
- **Work type:** deterministic keyword classification into MEP, Structural, or Finishing. Pump, valve, piping, electrical, and mechanical terms map to MEP; concrete, steel, earthwork, and civil terms map to Structural; architectural finishes map to Finishing.

When work type cannot be inferred confidently, the draft stores it as unclassified and requires the reviewer to select a value before approval. The system must not default unknown work to Structural.

Each extracted field carries `source`, `confidence`, and optional warning metadata so the UI can distinguish confident values from values needing review.

## Data Model

Extend `Boq` with optional backward-compatible source fields:

- `sourceFileName`;
- `sourceStoragePath`;
- `sourcePageCount`;
- `extractionWarnings`;
- `metadataConfidence`;
- an unclassified draft work-type state.

Extend `BoqItem` with optional ingestion fields:

- internal `id` generated by the importer;
- `costComponent: material | labour | combined | lump_sum`;
- source page/table/row references;
- optional original material and labour component values;
- item-level extraction warnings.

The legacy `code` property remains optional for approved historical data and downstream compatibility, but it is not generated for new imports or shown in the review interface. Components that currently use code as a React key or mutation locator move to the internal item ID with a compatibility fallback for legacy BOQs.

The legacy `type` property remains internal for backward compatibility and calculations that distinguish unit-priced and lump-sum records. It is derived by the importer and is not shown or editable in the review interface. New review behavior is driven by the visible quantity, unit, rate, and total rather than asking the user to classify a row.

## Review Interface

The left pane displays the authenticated source PDF without reconstructed content. Loading and preview failures show an inline message with a retry action and the filename.

The right pane:

- shows extracted metadata with confidence/warning indicators;
- removes the Code and Type columns;
- keeps Description, Unit, Qty, Rate, Total, and standardization status;
- visually groups material/labour items produced from one source row;
- keeps numeric editing and recalculates totals consistently;
- blocks approval when required metadata is missing or a numeric value is invalid;
- allows approval with non-blocking extraction warnings after explicit human review.

The existing BuildEstimate navy, Haas Swiss, blue-shadow design system remains unchanged. This is a data-correctness and clarity repair, not a visual rebrand.

## LLM Verification and Fallback

LLM verification reads the workspace provider/model settings and uses the existing provider abstraction. The request contains normalized metadata, line items, extraction warnings, and relevant source text. It returns structured findings rather than a blanket success message.

Before any LLM call, and whenever the call fails, the client receives deterministic verification results for:

- missing or unclassified metadata;
- empty descriptions or units;
- non-finite, negative, or suspicious zero quantities/rates;
- `qty × rate` versus total mismatches;
- normalized item sum versus source total mismatch;
- rows omitted because their shape was ambiguous.

Failures are categorized and explained:

- AI provider not configured;
- invalid credential or provider rejection;
- quota/rate limit;
- timeout or network failure;
- malformed AI response.

The UI states, for example, `AI verification unavailable. Local checks completed: 2 issues found.` It provides a Retry action and never reports the BOQ as LLM-verified when only fallback checks ran.

LLM verification is advisory. Approval depends on required metadata and deterministic data validity, not AI availability.

## Error Handling

- Invalid file: explain accepted format and size.
- Docling unreachable: identify the configured endpoint as unavailable and direct the user to Settings.
- No usable table: explain that no priced BOQ rows were found; do not create zero-valued rows from headers or footers.
- Partial extraction: open review with highlighted warnings when at least one reliable priced row exists.
- Source storage failure: abort import before draft creation.
- Preview failure: retain parsed review data and provide retry without losing edits.
- Save failure: preserve all local review edits and show the server-provided error.

## Testing Strategy

### Parser fixtures

Create sanitized table/text fixtures derived from every supplied quotation. Expected assertions include:

- Eastern Group vendor, date, MEP classification, section heading, and dual-cost row splitting;
- Eastern Group material-only and labour-only rows;
- Surasak vendor, date, project, and amount-only lump-sum conversion;
- N.P. Civil vendor, subject/project, Structural classification, BOQ-page selection, shared-quantity combined rates, and exclusion of cover/drawing/photo content;
- omission of subtotal, VAT, discount, grand-total, and amount-in-words rows;
- total reconciliation and warning generation.

### API tests

Test authentication, PDF validation, storage/parse rollback, sidecar error mapping, draft persistence, source streaming authorization, and workspace LLM-setting propagation.

### Component tests

Test that the review panel embeds the BOQ source route, contains no Code or Type column/input, renders confidence and fallback states, blocks invalid approval, retains edits after save failure, and distinguishes LLM verification from local verification.

### Browser verification

Run the complete upload flow with representative Eastern Group, Surasak, and N.P. Civil PDFs. Confirm the displayed source is byte-for-byte the chosen file, extracted values match the visible quotation, totals reconcile, the review layout remains usable at desktop and narrow widths, and LLM failure produces actionable fallback results.

## Compatibility and Migration

Existing BOQs without source files continue to render everywhere outside the upload review. If an older BOQ is opened in a source-dependent review, show `Original PDF was not retained for this BOQ` instead of a generated preview. Legacy item codes remain readable by APIs during migration but are no longer required for new imports.

## Acceptance Criteria

The repair is complete when:

1. The review pane shows the exact uploaded PDF.
2. All supplied quotation variants produce correct vendor, project, date, and work type or an explicit unclassified warning.
3. Unit, quantity, rate, and total preserve the source's cost structure without column shifts or synthetic zero rows.
4. Code and Type are absent from the review UI and new-import workflow.
5. LLM failure explains the cause, runs deterministic checks, and leaves the user able to review and approve valid data.
6. Automated regression tests and browser upload tests pass.
7. The project knowledge graph is updated after implementation.
