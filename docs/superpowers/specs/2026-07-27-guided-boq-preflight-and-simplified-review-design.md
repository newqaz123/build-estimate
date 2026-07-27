# Guided BOQ preflight and simplified extraction review

## Problem

The current BOQ import sends a PDF directly to Docling. Users cannot exclude cover letters, signatures, schedules, or irrelevant pages before parsing. This reduces extraction quality, especially for long scanned quotations.

The current extraction review also exposes technical concepts such as **Follow-up rows**, eight filter chips, and two similarly named **Recheck with AI** controls. Users do not have a clear answer to “what do I need to review now?” In addition, a rejected suggestion can surface a raw `Unauthorized` error when the session is missing or expired.

## Goals

- Let users select BOQ-relevant PDF pages before Docling parses them.
- Suggest likely BOQ pages for native and scanned Thai/English PDFs, while keeping users in control of the final selection.
- Parse only confirmed pages with Docling.
- Simplify extraction review to one pending-review queue and one history view.
- Reduce manual correction work by running narrowly scoped, source-cell-only AI recovery for rows that deterministic extraction cannot safely resolve.
- Preserve the existing source-backed safety model: AI never authors trusted values; the server reconstructs every accepted value from immutable Docling cells.
- Replace raw review-action 401 errors with a clear session-expired recovery path.

## Non-goals

- Re-extracting or changing existing BOQs automatically.
- Allowing AI to fabricate descriptions, units, quantities, rates, totals, sections, or provenance.
- Automatically applying AI-recovered items without explicit user approval.
- Sending an entire PDF to AI by default.
- Replacing Docling as the authoritative extraction engine.

## User workflow

### 1. Upload and preflight

1. User selects one PDF quotation.
2. The application creates a temporary, short-lived preflight upload. It is not a BOQ and does not create an extraction run.
3. The server renders page thumbnails and analyzes each page:
   - use embedded PDF text when available;
   - run lightweight OCR only when a page lacks usable text;
   - recognize both Thai and English BOQ signals;
   - consider table/layout density and numeric-column patterns.
4. The application ranks likely BOQ pages and preselects only high-confidence suggestions.
5. If no page reaches the confidence threshold, no page is selected. The UI clearly asks the user to choose pages.
6. The user can click any thumbnail to select or unselect it. Suggestions are visible but non-authoritative.
7. Hovering a thumbnail displays a magnified source area for detailed inspection. No separate edit mode or **Edit selection** button exists.
8. **Extract selected pages** is disabled until at least one page is selected.
9. Clicking **Extract selected pages** starts the existing BOQ import flow, with Docling restricted to the confirmed original PDF pages.

### 2. AI recovery ladder

After Docling processes only selected pages:

1. The deterministic parser processes every row first.
2. Rows with complete deterministic candidates proceed through the existing draft/approval flow without AI.
3. AI runs only for unresolved, ambiguous, or unreconciled rows.
4. The first AI pass receives minimal local evidence: the current row, table headers, nearby rows when needed, and a provider-visible allowlist of source-cell coordinates. It returns cell coordinates only.
5. The server reconstructs all values from immutable retained Docling cells and verifies source provenance, numeric grammar, arithmetic, destination state, and staleness.
6. If useful mapping evidence is incomplete, the system performs at most one targeted retry. The retry asks only for the missing field(s) and receives only relevant local page/table context.
7. A critic/comparison pass is permitted only when multiple coordinate-only mappings remain plausible. It may choose supported coordinates but cannot provide values.
8. Retries stop after the targeted attempt. Contradictory, unreadable, or unreconciled evidence becomes a concise exception rather than an endless retry or a guessed item.

A complete source-backed, reconciled recovery becomes a pending validated proposal. It never applies automatically; the user explicitly approves it.

### 3. Simplified extraction review

The review surface has two primary tabs:

- **Needs your review** — default. Contains all pending work:
  - validated source-backed suggestions awaiting explicit approval;
  - incomplete or ambiguous source-backed cases;
  - rows that still need targeted AI review;
  - concise exceptions where the PDF cannot prove a required field.
- **History** — accepted, rejected, skipped, and undone decisions.

Remove the main technical filter-chip row and the separate **Ready to apply** tab. Internal categories such as ambiguous, unreconciled, and AI-pending remain available to logic and diagnostics but are not primary user navigation.

Use these user-facing labels:

- Top review action: **Review all flagged rows with AI**.
- Targeted source-row action: **Review this row with AI**.
- Remaining row group: **Rows needing review**.
- Complete proposal status: **Validated suggestion — ready for your approval**.
- Incomplete proposal status: **More information needed**.

### 4. Proposal actions

#### Review source

**Review source** opens the relevant original PDF page beside the proposal. It navigates to and highlights the page/table/row/cell evidence used by the proposal where the viewer can represent it. Users can zoom and pan.

This action never changes the BOQ, proposal state, or AI-review state. It does not rerun AI.

For an exception, the evidence panel explicitly identifies the missing or contradictory source field.

#### Accept

**Accept** appears only for complete, source-backed, arithmetically valid proposals. It remains unavailable for `needs_human_review` and any incomplete/ambiguous draft. Existing transactional acceptance and immutable reconstruction safeguards remain authoritative.

Users approve each item individually; no automatic apply and no batch apply are introduced by this feature.

#### Reject

For a validated suggestion, **Reject** first requests confirmation:

> Reject this suggestion? It will not be added to the BOQ.

On confirmation, the proposal is rejected, the BOQ remains unchanged, and the decision moves to **History** with immutable evidence and audit context. A rejected proposal is not automatically retried.

**Undo rejection** returns it to **Needs your review** without re-extraction or BOQ mutation.

For an incomplete exception, use **Skip** rather than **Reject**. Skipping records the decision in history and leaves the BOQ unchanged.

### 5. Session recovery

Every mutation action — Accept, Reject, Undo rejection, and Review & add — continues to require authenticated server-side user identity.

If the review API returns 401:

1. Do not show raw `Unauthorized` text as the primary user-facing message.
2. Show a session-expired panel/message:

   > Your session has expired. Sign in again to continue reviewing this BOQ.

3. Provide **Sign in again**.
4. Preserve a validated return location containing the BOQ ID and extraction-review context. After successful login, return the user to the same BOQ review.
5. Never retry or mutate the rejected/accepted proposal automatically after login; require a new explicit user action.

The implementation must also diagnose the underlying auth/session configuration issue. The current accept/reject/undo endpoints use the same authentication boundary; a reject-only 401 must be investigated as a session/cookie/deployment-route inconsistency, not bypassed in the UI.

## Preflight architecture

### Temporary upload lifecycle

Create a preflight-upload record and protected storage object separate from `Boq` and `ExtractionRun`.

Required lifecycle states:

- `uploaded` — file saved, ready for page analysis;
- `analyzing` — thumbnails/text/OCR/ranking in progress;
- `ready` — page suggestions and preview assets available;
- `consumed` — confirmed selection transferred into import/extraction;
- `cancelled` — user cancelled;
- `failed` — preflight processing could not complete;
- `expired` — TTL elapsed.

Rules:

- Preflight objects are private and bound to the authenticated uploader/workspace.
- Cancelled, consumed, failed, and expired uploads are deleted with their previews and OCR artifacts.
- A TTL prevents abandoned uploads from accumulating.
- The source PDF is retained/renamed/moved only when the confirmed import successfully creates the BOQ according to existing transactional import semantics.
- Failure at any preflight or import stage leaves no visible BOQ or partial extraction run.

### Page analysis and ranking

Page analysis must be deterministic/local to the application's preflight services. It may use OCR, but it is not LLM extraction and cannot create BOQ data.

Signals include:

- Thai terms: `รายการ`, `จำนวน`, `หน่วย`, `ราคา`, `วัสดุ`, `ค่าแรง`, `รวม`;
- English terms: `description`, `item`, `qty`, `quantity`, `unit`, `rate`, `amount`, `material`, `labour`, `total`;
- table geometry and aligned columns;
- numeric and currency density;
- presence of quantity/rate/amount-like column combinations.

The ranking result must include a confidence/reason summary sufficient for the UI to label a page as suggested. It does not need to expose OCR text verbatim.

### Parse handoff and provenance

The confirmed original page numbers are passed to Docling as an allowlisted page set/range. The service must preserve original PDF page numbering in source references, regardless of whether parsing internally materializes a reduced PDF.

The confirmed page set must be included in the parser configuration identity/fingerprint used by extraction runs. Different selections must never collide with or reuse a run/evidence fingerprint from a different page selection.

## Data safety and validation

- Page selection is user-confirmed before parsing. Suggestions never silently include pages.
- A zero-page selection cannot start extraction.
- The preflight analysis never creates trusted item values.
- The AI recovery ladder returns only immutable source-cell coordinates and uses the same server-side source mapping, arithmetic, staleness, and acceptance safeguards as the existing source-backed recovery design.
- Complete validated AI-recovered items remain pending until the user chooses Accept.
- Incomplete or contradictory evidence never becomes an Accept-able proposal and never receives guessed values.
- Existing BOQs and Firestore extraction data are not migrated or re-extracted by deployment.

## Components and boundaries

- **Preflight upload service**: stores private temporary PDF and lifecycle metadata; owns cleanup.
- **Preflight analysis service**: creates thumbnails, obtains embedded text/OCR, ranks pages, and exposes safe preview metadata.
- **Page-selection client step**: shows suggestions, direct click selection, hover magnification, zero-selection validation, and starts confirmed import.
- **Docling page-selection contract**: validates confirmed original pages and limits parsing to them while preserving original provenance.
- **AI recovery orchestrator**: applies the deterministic-first, narrow-context, bounded retry/critic ladder.
- **Review-state presenter**: maps internal proposal/run states to the two-tab user workflow and plain-language labels.
- **Session-recovery handler**: maps 401 responses to sign-in recovery while maintaining backend auth enforcement.

## Error handling

- Preflight upload invalid/expired/not owned: show a recoverable message and return to upload.
- Thumbnail/OCR failure on a page: still show a selectable page thumbnail or placeholder; do not block manual selection.
- Page analysis unavailable: default to no pages selected and ask the user to select manually.
- Docling rejects selected-page processing: retain the preflight selection so the user can retry or adjust it.
- AI recovery timeout/failure: deterministic extraction remains unchanged; render only the affected rows as concise exceptions.
- 401 review action: show session recovery; do not mutate locally or claim an action succeeded.

## Testing

### Preflight and selection

- native-text PDF suggests BOQ pages from English signals;
- scanned Thai/English PDF uses OCR and recognizes both language signal sets;
- low-confidence analysis selects no pages;
- user can select non-suggested pages and unselect suggested pages;
- zero selection disables extraction;
- confirmed page list reaches Docling and only those pages are parsed;
- original page/table/row provenance remains correct;
- selected-page configuration changes extraction-run identity;
- temporary upload ownership, cancellation, consumption, failure cleanup, and expiry cleanup are enforced.

### Recovery and review

- deterministic success never invokes AI;
- unresolved rows invoke AI with only local allowlisted context;
- AI output containing values or unrecognized fields is rejected;
- targeted retry is bounded to one and only receives missing-field context;
- complete recovered items appear in Needs your review and require explicit Accept;
- incomplete rows never show Accept;
- Review source navigates/opens evidence without mutation;
- Reject confirmation preserves BOQ and moves decision to History;
- Undo rejection returns the item to Needs your review;
- the simplified two-tab state correctly groups every pending/history lifecycle state;
- 401 renders session-expired recovery and preserves the safe return context.

## Rollout

Deploy code and tests only. Existing BOQs retain their current extraction evidence and review state. The guided preflight page selector is used for new imports/re-extractions only after the user explicitly starts a new extraction flow.
