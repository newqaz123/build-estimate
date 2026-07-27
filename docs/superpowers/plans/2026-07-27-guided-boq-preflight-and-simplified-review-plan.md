# Guided BOQ Preflight and Simplified Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user confirm suggested BOQ PDF pages before Docling parsing, then review only safe source-backed AI recovery proposals in a simplified, session-resilient workspace.

**Architecture:** A private, expiring preflight upload owns temporary PDF assets, deterministic Thai/English page analysis, and user-confirmed page selection; only its confirmed original page list enters the existing atomic import/Docling path. Deterministic parsing remains first; bounded AI recovery may return source-cell coordinates only and the server reconstructs every proposal. A review presenter converts durable proposal state into `Needs your review` and `History`, while authenticated mutation endpoints stay authoritative.

**Tech Stack:** Next.js 16.2 App Router, React 19, TypeScript, Firebase Admin Firestore/Storage transactions, NextAuth v5 credentials/JWT, Python 3/FastAPI/Docling, Docling OCR, Node `tsx --test`, Python `unittest`.

## Global Constraints

- Suggestions never silently include pages; a user-confirmed non-empty original-page set is required before Docling starts.
- Preflight records/assets are private, uploader-bound, temporary, and separate from `Boq` and `ExtractionRun`.
- OCR is Thai-aware and English-aware; UI copy remains English.
- Existing BOQs and Firestore extraction data are never migrated, mutated, or re-extracted by deployment.
- AI runs only for unresolved, ambiguous, or unreconciled rows after deterministic extraction.
- AI may return source-cell coordinates and allowed metadata only: never descriptions, units, quantities, rates, totals, sections, or provenance values.
- Every accepted value must reconstruct from immutable retained Docling cells and pass existing provenance, numeric, arithmetic, staleness, and transactional acceptance validation.
- Recovery has at most one missing-field retry and an optional coordinate-only critic only for multiple valid mappings; never guess or retry indefinitely.
- User explicitly accepts each complete proposal. Incomplete, contradictory, or unproved data never shows Accept.
- All review mutations remain server-authenticated; 401 never triggers an automatic retry or local mutation.

---

## File structure

- Create `src/lib/boq-preflight-schema.ts`: immutable preflight/page/selection contracts and validators.
- Create `src/lib/boq-preflight-analysis.ts`: deterministic embedded-text/OCR signal scoring and safe suggestion metadata.
- Create `src/lib/boq-preflight-storage.ts`: owner-scoped Firestore/storage persistence, cleanup leases, and artifact deletion.
- Create `src/lib/boq-preflight-service.ts`: lifecycle orchestration and confirmed import handoff.
- Create `src/app/api/boqs/preflight/**`: authenticated preflight upload, metadata, preview, consume, cancel, and protected cleanup routes.
- Create `src/components/boq-preflight.tsx`: direct-select thumbnail grid and hover magnification.
- Modify `src/components/upload-modal.tsx`: transition from upload to preflight selection rather than direct import.
- Modify `src/lib/docling-client.ts`, `src/lib/boq-import-service.ts`, `src/lib/boq-extraction-run.ts`, `src/app/api/boqs/import/**`, `py-sidecar/main.py`, and `py-sidecar/Dockerfile`: validated page allowlist, Thai/English OCR configuration, original provenance, and selection fingerprint.
- Modify `src/lib/boq-extraction-ai-review.ts` and its contract/evidence tests: bounded coordinate-only recovery ladder.
- Modify extraction proposal acceptance/store/API contracts: durable skip decision alongside existing reject/undo audit behavior.
- Modify review state/UI/workspace/PDF viewer/login: two tabs, focused evidence, confirmation, and safe session recovery.

### Task 1: Preflight contracts and deterministic page analysis

**Files:**
- Create: `src/lib/boq-preflight-schema.ts`
- Create: `src/lib/boq-preflight-analysis.ts`
- Test: `src/lib/boq-preflight-schema.test.ts`
- Test: `src/lib/boq-preflight-analysis.test.ts`

**Interfaces:**
- Produces `PreflightUpload`, `PreflightPage`, `parseConfirmedPageSelection(value, pageCount)`, and `analyzePreflightPages(pages)`.
- `PreflightPage` contains only `page`, `suggested`, `confidence`, `reasons`, `textSource: 'embedded' | 'ocr' | 'unavailable'`; never OCR text or item values.

- [ ] **Step 1: Write failing contract/analysis tests**

```ts
assert.deepEqual(
  parseConfirmedPageSelection({ pages: [3, 1, 3] }, 4),
  { pages: [1, 3] },
)
assert.throws(() => parseConfirmedPageSelection({ pages: [] }, 4), /at least one/)

const result = analyzePreflightPages([
  { page: 1, embeddedText: 'Cover letter', geometry: { tableCount: 0, numericTokenCount: 0 } },
  { page: 2, embeddedText: 'รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม', geometry: { tableCount: 1, numericTokenCount: 12 } },
])
assert.equal(result[0].suggested, false)
assert.equal(result[1].suggested, true)
assert.ok(result[1].reasons.includes('thai_boq_terms'))
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/boq-preflight-schema.test.ts src/lib/boq-preflight-analysis.test.ts`

Expected: FAIL because both modules do not exist.

- [ ] **Step 3: Implement minimal, fail-closed contracts and analysis**

```ts
export type PreflightStatus = 'uploaded' | 'analyzing' | 'ready' | 'consumed' | 'cancelled' | 'failed' | 'expired'
export interface PreflightPage { page: number; suggested: boolean; confidence: number; reasons: string[]; textSource: 'embedded' | 'ocr' | 'unavailable' }
export function parseConfirmedPageSelection(value: unknown, pageCount: number): { pages: number[] } { /* record, unique integer 1..pageCount, sorted, non-empty */ }
```

Score only normalized Thai/English terms, table count, numeric density, and quantity/rate/amount combinations. Use a named high-confidence threshold. Mark `suggested` only at or above that threshold; otherwise every page is unselected. Preserve deterministic reason codes such as `thai_boq_terms`, `english_boq_terms`, `table_layout`, and `numeric_columns`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/boq-preflight-schema.test.ts src/lib/boq-preflight-analysis.test.ts`

Expected: PASS, including no-confidence/no-selected-page, English signal, Thai signal, duplicate/out-of-range page, and unknown-key rejection cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-preflight-schema.ts src/lib/boq-preflight-schema.test.ts src/lib/boq-preflight-analysis.ts src/lib/boq-preflight-analysis.test.ts
git commit -m "feat: add deterministic BOQ preflight analysis"
```

### Task 2: Private preflight persistence and expiry cleanup

**Files:**
- Create: `src/lib/boq-preflight-storage.ts`
- Test: `src/lib/boq-preflight-storage.test.ts`
- Modify: `src/lib/firebase-admin.ts`

**Interfaces:**
- Consumes `PreflightUpload` from Task 1 and existing Firebase Admin bucket/firestore helpers.
- Produces `PreflightStore` with `create`, `getOwned`, `update`, `deleteArtifacts`, `claimExpired`, and `cleanupExpiredPreflightUploads(store, now, limit)`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
const upload = await store.create(seed('owner-a'))
assert.equal((await store.getOwned(upload.id, 'owner-a'))?.status, 'uploaded')
assert.equal(await store.getOwned(upload.id, 'owner-b'), null)
assert.equal(await cleanupExpiredPreflightUploads(store, new Date('2026-07-27T00:00:00Z'), 10), 1)
assert.deepEqual(harness.deletedPaths, [
  `preflight/owner-a/${upload.id}/source.pdf`,
  `preflight/owner-a/${upload.id}/previews/1.png`,
  `preflight/owner-a/${upload.id}/ocr/1.json`,
])
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/boq-preflight-storage.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement owner-scoped persistence**

Store source and derived assets below `preflight/{ownerId}/{preflightId}/`. Persist a TTL `expiresAt`, lifecycle state, a cleanup lease, original file digest/name/type/size, page metadata, and no BOQ/run ID. Make cleanup claim first, then delete Firestore metadata and every known prefix artifact. A consumed/cancelled/failed/expired record must delete artifacts; a failed confirmed import must keep ready source/selection for retry.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/boq-preflight-storage.test.ts`

Expected: PASS for ownership, lifecycle transitions, cancel, consumed cleanup, one-worker expiry lease, partial preview/OCR deletion, and bounded cleanup.

- [ ] **Step 5: Commit**

```bash
git add src/lib/firebase-admin.ts src/lib/boq-preflight-storage.ts src/lib/boq-preflight-storage.test.ts
git commit -m "feat: persist expiring private BOQ preflights"
```

### Task 3: Preflight service and authenticated API

**Files:**
- Create: `src/lib/boq-preflight-service.ts`
- Create: `src/app/api/boqs/preflight/handler.ts`
- Create: `src/app/api/boqs/preflight/route.ts`
- Create: `src/app/api/boqs/preflight/[id]/handler.ts`
- Create: `src/app/api/boqs/preflight/[id]/route.ts`
- Create: `src/app/api/boqs/preflight/[id]/pages/[page]/route.ts`
- Create: `src/app/api/internal/cleanup/preflight/route.ts`
- Test: `src/lib/boq-preflight-service.test.ts`
- Test: `src/app/api/boqs/preflight/preflight-api.test.ts`
- Modify: `src/app/api/route-exports.test.ts`

**Interfaces:**
- `createPreflight(file, actorId)` validates with existing `requireSinglePdf` limits, stores source, renders/analyzes pages, then returns safe page metadata.
- `consumePreflight(id, actorId, { pages })` validates ownership/readiness and returns `{ file, pages, preflightId }` without creating a BOQ itself.

- [ ] **Step 1: Write failing API/service tests**

```ts
const response = await postPreflight(authenticatedRequest(pdf))
assert.equal(response.status, 201)
assert.deepEqual((await response.json()).pages.map((page) => page.page), [1, 2])

const forbidden = await getPreflight('other-users-id', 'owner-a')
assert.equal(forbidden.status, 404)
assert.equal((await consumePreflight(id, 'owner-a', { pages: [] })).status, 400)
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/boq-preflight-service.test.ts src/app/api/boqs/preflight/preflight-api.test.ts src/app/api/route-exports.test.ts`

Expected: FAIL because preflight service/routes are absent.

- [ ] **Step 3: Implement orchestration and routes**

Use existing import-handler dependency injection and opaque-ID response patterns. `POST /api/boqs/preflight` authenticates before reading multipart bytes. `GET /api/boqs/preflight/[id]` returns safe metadata only. The page route streams a private thumbnail only after ownership validation. `DELETE` cancels and cleans up. The internal cleanup route requires a server secret before calling `cleanupExpiredPreflightUploads`.

Render native page text first; call OCR only for pages with no usable embedded text. Configure the analysis adapter to report `textSource: 'ocr'` without exposing text. If thumbnail/OCR analysis fails, return selectable `unavailable` pages with no suggestions rather than failing manual selection.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/boq-preflight-service.test.ts src/app/api/boqs/preflight/preflight-api.test.ts src/app/api/route-exports.test.ts`

Expected: PASS for auth-before-I/O, ownership, expiry, no BOQ/run creation, failed analysis fallback, preview authorization, cancellation, and cleanup-secret rejection.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-preflight-service.ts src/lib/boq-preflight-service.test.ts src/app/api/boqs/preflight src/app/api/internal/cleanup/preflight src/app/api/route-exports.test.ts
git commit -m "feat: expose authenticated BOQ preflight workflow"
```

### Task 4: Confirmed pages through Docling and immutable run identity

**Files:**
- Modify: `src/lib/docling-client.ts`
- Modify: `src/lib/boq-import-service.ts`
- Modify: `src/lib/boq-extraction-run.ts`
- Modify: `src/app/api/boqs/import/handler.ts`
- Modify: `py-sidecar/main.py`
- Modify: `py-sidecar/Dockerfile`
- Create: `src/lib/docling-client.test.ts`
- Test: `src/lib/boq-extraction-run.test.ts`
- Test: `src/app/api/boqs/import/import-api.test.ts`
- Create: `py-sidecar/test_main.py`

**Interfaces:**
- Extend the Docling request to `parsePdfWithDocling(file, endpoint, signal, { pages: readonly number[] })`.
- Extend atomic import with `selection: { preflightId: string; pages: number[] }`.
- Preserve original 1-based `page/table/row` source references in `BoqSourceRowV3`.

- [ ] **Step 1: Write failing selected-page/provenance tests**

```ts
await parsePdfWithDocling(pdf, endpoint, undefined, { pages: [1, 3] })
assert.equal(request.formData.get('pages'), '[1,3]')
assert.notEqual(
  fingerprintParserConfig({ contractVersion: 3, selectedPages: [1] }),
  fingerprintParserConfig({ contractVersion: 3, selectedPages: [2] }),
)
```

```python
response = await parse_pdf(pdf_file, pages='[2, 4]')
assert {row.page for row in response.sourceRows} <= {2, 4}
assert 1 not in {row.page for row in response.sourceRows}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/lib/docling-client.test.ts src/lib/boq-extraction-run.test.ts src/app/api/boqs/import/import-api.test.ts
.venv-docling/bin/python -m unittest py-sidecar.test_main -v
```

Expected: FAIL because selected pages are not accepted or fingerprinted.

- [ ] **Step 3: Implement validated handoff**

Send the sorted JSON page allowlist as multipart `pages`. The sidecar rejects malformed, duplicate, non-positive, or unavailable page values before conversion. Configure `PdfPipelineOptions` with OCR enabled and `TesseractOcrOptions(lang=['eng', 'tha'])`; update the image to include Tesseract plus English/Thai language data. Process only selected original pages and carry an original-page map into `build_parse_response`, so no filtered-page index leaks into source provenance.

On successful final import, consume/delete preflight artifacts only after the existing BOQ/run finalization succeeds. On Docling/import failure, leave a ready preflight selection untouched. Fingerprint `{ contractVersion: 3, selectedPages, pageSelectionContract: 1 }` with existing parser configuration.

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
npm test -- src/lib/docling-client.test.ts src/lib/boq-extraction-run.test.ts src/app/api/boqs/import/import-api.test.ts
.venv-docling/bin/python -m unittest discover -s py-sidecar -p 'test_*.py'
```

Expected: PASS; tests prove only selected pages parse, original page numbers remain stable, selection changes identity, and failed import preserves preflight.

- [ ] **Step 5: Commit**

```bash
git add src/lib/docling-client.ts src/lib/docling-client.test.ts src/lib/boq-import-service.ts src/lib/boq-extraction-run.ts src/lib/boq-extraction-run.test.ts src/app/api/boqs/import py-sidecar/main.py py-sidecar/Dockerfile py-sidecar/test_main.py
git commit -m "feat: parse confirmed BOQ pages with Docling"
```

### Task 5: Page-selection UI and browser validation

**Files:**
- Create: `src/components/boq-preflight.tsx`
- Create: `src/components/boq-preflight.test.ts`
- Modify: `src/components/upload-modal.tsx`
- Modify: `src/components/boq-ingestion-flow.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**
- `BoqPreflight({ preflight, onExtract, onCancel })` accepts safe Task-3 metadata and emits only `pages: number[]`.
- A thumbnail click toggles its page. Hover displays a magnified image; no edit-mode action exists.

- [ ] **Step 1: Write failing component tests**

```tsx
render(<BoqPreflight preflight={readyPreflight} onExtract={extract} onCancel={cancel} />)
await user.click(screen.getByRole('button', { name: 'Page 2, suggested, selected' }))
assert.equal(screen.getByRole('button', { name: /Extract 1 selected page/ }).hasAttribute('disabled'), false)
await user.hover(screen.getByRole('button', { name: /Page 2/ }))
assert.ok(screen.getByRole('img', { name: 'Magnified Page 2' }))
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/components/boq-preflight.test.ts src/components/boq-ingestion-flow.test.ts`

Expected: FAIL because direct import is still the only upload path.

- [ ] **Step 3: Implement direct confirmation UX**

After a file validates, `UploadModal` posts it to preflight and displays `BoqPreflight`. Suggested high-confidence pages begin selected; all low-confidence/unavailable pages begin unselected. Use buttons with selected/suggested state in their accessible labels. Disable extraction with `Select at least one page to continue.` Hover or keyboard focus opens a magnifier backed by the authenticated preview endpoint; clicking the thumbnail still toggles selection. Submit confirmed pages to the consume/import handoff and preserve the selector when import fails.

- [ ] **Step 4: Verify GREEN and browser behavior**

Run: `npm test -- src/components/boq-preflight.test.ts src/components/boq-ingestion-flow.test.ts`

Then start `npm run dev`, open the upload flow, and verify: suggested page selection; manual select/unselect; zero-selection disabled state; hover magnification; and a successful selected-page extraction. Record any unavailable live services as a test limitation rather than claiming browser success.

- [ ] **Step 5: Commit**

```bash
git add src/components/boq-preflight.tsx src/components/boq-preflight.test.ts src/components/upload-modal.tsx src/components/boq-ingestion-flow.test.ts src/app/globals.css
git commit -m "feat: let users confirm BOQ pages before extraction"
```

### Task 6: Bounded coordinate-only AI recovery ladder

**Files:**
- Modify: `src/lib/boq-extraction-ai-review.ts`
- Modify: `src/lib/boq-extraction-proposal-contract.ts`
- Modify: `src/lib/boq-extraction-evidence.ts`
- Test: `src/lib/boq-extraction-ai-review.test.ts`
- Test: `src/lib/boq-extraction-proposal-contract.test.ts`
- Test: `src/lib/boq-extraction-evidence.test.ts`

**Interfaces:**
- Add internal recovery attempt context `{ attempt: 1 | 2; missingFields?: SourceReviewMissingField[] }`.
- Reuse `prepareProviderProposalV2` and `resolveSourceCellMapping`; no new trusted model-value DTO is allowed.

- [ ] **Step 1: Write failing recovery tests**

```ts
await executeExtractionReview(contextWithDeterministicCandidate, deps)
assert.equal(provider.calls.length, 0)

const response = await executeExtractionReview(unresolvedContext, retryingDeps)
assert.equal(provider.calls.length, 2)
assert.match(provider.calls[1].messages[1].content, /missing fields only/i)
assert.doesNotMatch(provider.calls[1].messages[1].content, /unrelated-row-id/)
assert.equal(response.proposals[0].operation, 'map_source_item')
```

Add cases that reject `qty`, `unit`, `total`, unknown keys, a second retry, and a critic response with values.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/boq-extraction-ai-review.test.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-evidence.test.ts`

Expected: FAIL because recovery has one broad provider call and no bounded retry/critic policy.

- [ ] **Step 3: Implement ladder without weakening source safety**

Run deterministic candidates first. For unresolved rows, build a local evidence packet containing the row, headers, only needed neighboring rows, and allowlisted cell coordinates. Attempt one mapping pass. Only when the server reconstruction returns explicit missing fields, make exactly one retry with those fields and the same bounded local context. Permit a critic only when two or more server-valid coordinate mappings exist; its schema contains candidate mapping IDs/coordinates only. Enforce a request deadline and return a concise exception state after timeout, malformed output, contradiction, or exhausted retry. Never auto-accept or emit client-authored values.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/boq-extraction-ai-review.test.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-evidence.test.ts src/lib/boq-extraction-cell-mapping.test.ts`

Expected: PASS, proving one retry maximum, local evidence, injected-value rejection, and complete-only candidate creation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-extraction-ai-review.ts src/lib/boq-extraction-proposal-contract.ts src/lib/boq-extraction-evidence.ts src/lib/boq-extraction-ai-review.test.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-evidence.test.ts
git commit -m "feat: add bounded source-backed AI recovery"
```

### Task 7: Durable skip lifecycle and two-tab review state

**Files:**
- Modify: `src/lib/boq-extraction-acceptance.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/skip/route.ts`
- Modify: `src/lib/boq-extraction-review-state.ts`
- Modify: `src/lib/boq-extraction-review-ui.ts`
- Test: `src/lib/boq-extraction-proposal-store.test.ts`
- Test: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts`
- Test: `src/lib/boq-extraction-review-state.test.ts`
- Test: `src/lib/boq-extraction-review-ui.test.ts`

**Interfaces:**
- Extend durable status with `skipped`; audit it append-only and undo it back to `pending` without BOQ mutation.
- Replace `ExtractionReviewFilter` UI navigation with `ReviewTab = 'needs-review' | 'history'` while retaining internal diagnostics.

- [ ] **Step 1: Write failing lifecycle/presenter tests**

```ts
const skipped = await store.skipProposal(boqId, runId, proposalId, actorId)
assert.equal(skipped.proposal.status, 'skipped')
assert.equal(skipped.boq.grandTotal, original.grandTotal)

assert.deepEqual(selectReviewTab(state, 'needs-review').proposalIds, ['pending-complete', 'needs-human-review'])
assert.deepEqual(selectReviewTab(state, 'history').proposalIds, ['accepted', 'rejected', 'skipped', 'undone', 'superseded'])
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/boq-extraction-proposal-store.test.ts src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts src/lib/boq-extraction-review-state.test.ts src/lib/boq-extraction-review-ui.test.ts`

Expected: FAIL because skip and the two-tab selector do not exist.

- [ ] **Step 3: Implement durable skip and presentation model**

Use the existing transaction/audit/undo conventions. Skip is valid only for incomplete/exception proposals and cannot alter BOQ sections/totals. Reject remains for complete validated suggestions. The tab selector includes all pending work in `needs-review`; `history` includes accepted, rejected, skipped, undone, and superseded states explicitly. Keep server-derived `proposalCanBeAccepted` unchanged: only complete source-backed reconciled non-stale proposals are actionable.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command.

Expected: PASS for audit idempotency, authorized skip, undo, no BOQ mutation, every durable status, and no Accept for incomplete rows.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-extraction-acceptance.ts src/lib/boq-extraction-proposal-store.ts src/app/api/boqs/[id]/extraction-runs/[runId]/proposals src/lib/boq-extraction-review-state.ts src/lib/boq-extraction-review-ui.ts src/lib/boq-extraction-proposal-store.test.ts src/lib/boq-extraction-review-state.test.ts src/lib/boq-extraction-review-ui.test.ts
git commit -m "feat: simplify extraction review lifecycle"
```

### Task 8: Evidence-focused review UI and proposal actions

**Files:**
- Modify: `src/components/extraction-review.tsx`
- Modify: `src/components/review-workspace.tsx`
- Modify: `src/components/pdf-review-viewer.tsx`
- Modify: `src/components/extraction-review.test.ts`
- Modify: `src/components/review-workspace.test.ts`
- Modify: `src/components/pdf-review-viewer.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**
- `onNavigateToEvidence({ page, table, row, cells? })` replaces page-only navigation.
- Display tabs exactly `Needs your review` and `History`.

- [ ] **Step 1: Write failing UI tests**

```tsx
await user.click(screen.getByRole('button', { name: 'Reject suggestion' }))
assert.ok(screen.getByText('Reject this suggestion? It will not be added to the BOQ.'))
await user.click(screen.getByRole('button', { name: 'Confirm reject' }))
assert.ok(screen.getByRole('tab', { name: /History/ }))

await user.click(screen.getByRole('button', { name: 'Review source' }))
assert.deepEqual(viewer.focus, { page: 2, table: 1, row: 4, cells: [3, 4] })
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/components/extraction-review.test.ts src/components/review-workspace.test.ts src/components/pdf-review-viewer.test.ts`

Expected: FAIL because existing UI still has chips, page-only focus, and immediate rejection.

- [ ] **Step 3: Implement plain-language review interactions**

Remove the primary filter-chip row and the Ready-to-apply tab. Render pending complete cards as `Validated suggestion — ready for your approval` with Review source, Accept, Reject. Render incomplete cards as `More information needed` with Review source and Skip; never Accept. Rename global recheck to `Review all flagged rows with AI`, row action to `Review this row with AI`, and remaining group to `Rows needing review`.

Make Review source a pure viewer state change: navigate page, table/row/cell focus marker, and preserve zoom/pan. Reject opens confirmation; confirmed reject/skip uses the durable Task-7 endpoint. Undo moves the durable item back to Needs your review only after the server response.

- [ ] **Step 4: Verify GREEN and browser behavior**

Run the Step 2 command. Then use the browser against `npm run dev` to verify both tabs, reject confirmation, skip, undo, Review source page focus, zoom/pan, and that opening source does not issue an AI/mutation request.

- [ ] **Step 5: Commit**

```bash
git add src/components/extraction-review.tsx src/components/review-workspace.tsx src/components/pdf-review-viewer.tsx src/components/extraction-review.test.ts src/components/review-workspace.test.ts src/components/pdf-review-viewer.test.ts src/app/globals.css
git commit -m "feat: streamline BOQ extraction review"
```

### Task 9: Session-expired recovery without backend bypass

**Files:**
- Modify: `src/components/extraction-review.tsx`
- Modify: `src/app/(public)/page.tsx`
- Create: `src/lib/auth-return-url.ts`
- Create: `src/lib/auth-return-url.test.ts`
- Modify: `src/components/extraction-review.test.ts`
- Create: `src/app/(public)/page.test.tsx`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts`

**Interfaces:**
- `safeReviewReturnPath(value: string | null): string` accepts only an internal `/boqs/{opaque-id}` path with an optional review query; otherwise returns `/dashboard`.

- [ ] **Step 1: Write failing 401/return-path tests**

```ts
assert.equal(safeReviewReturnPath('/boqs/a1?reviewRun=r1'), '/boqs/a1?reviewRun=r1')
assert.equal(safeReviewReturnPath('https://attacker.example'), '/dashboard')

server.use(rejectProposal.respondWith(401, { error: 'Unauthorized' }))
await user.click(screen.getByRole('button', { name: 'Reject suggestion' }))
assert.ok(screen.getByText('Your session has expired. Sign in again to continue reviewing this BOQ.'))
assert.equal(reducerState.proposals[id].status, 'pending')
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/auth-return-url.test.ts src/components/extraction-review.test.ts src/app/(public)/page.test.tsx src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts`

Expected: FAIL because raw Unauthorized is displayed and login always routes to dashboard.

- [ ] **Step 3: Implement session recovery**

Before parsing API error text, detect 401 in all review mutation and review-AI fetch paths. Set a session-expired state and render the exact message plus `Sign in again`. Its link uses `/?returnTo=` with `safeReviewReturnPath` validation on the login page. After successful credentials sign-in, route only to that validated path; do not replay requests or apply optimistic state. Keep all route handlers returning 401 and requiring `session.user.id`; add a diagnostic log category/coverage proving auth executes before proposal access.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command.

Expected: PASS for 401 no-mutation behavior, accepted internal return path, rejected external/invalid return path, and unchanged backend authentication.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-return-url.ts src/lib/auth-return-url.test.ts src/components/extraction-review.tsx src/components/extraction-review.test.ts src/app/(public)/page.tsx src/app/(public)/page.test.tsx src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts
git commit -m "fix: recover BOQ review after session expiry"
```

### Task 10: Full verification and regression review

**Files:**
- Modify only if verification exposes a reproducible defect.

- [ ] **Step 1: Run all automated checks**

```bash
npm run check
.venv-docling/bin/python -m unittest discover -s py-sidecar -p 'test_*.py'
git diff --check
git status --short
```

Expected: all TypeScript/lint/test checks and every Python test PASS; no whitespace errors; clean tree after committed changes.

- [ ] **Step 2: Run browser golden path and edge cases**

Start `npm run dev` and verify: upload → suggestions → direct page toggling → hover magnification → selected-page extraction → Needs your review → Review source → Accept/Reject/Skip/Undo → History; force a 401 in the authenticated review action and confirm Sign in again preserves the review return path. Check browser console for errors.

- [ ] **Step 3: Review source-backed invariants**

Verify in the final diff that provider messages/DTOs never accept model values; retry count cannot exceed one; critic cannot return a value; only source-cell reconstruction enables Accept; cleanup cannot touch BOQ source paths; and selected-page fingerprints differ for distinct sets.

- [ ] **Step 4: Commit any verification fix**

```bash
git add <specific-fixed-files>
git commit -m "fix: address guided extraction regression"
```

Only create this commit when a test-backed defect was fixed; otherwise do not create an empty commit.

## Self-review

- **Spec coverage:** Tasks 1–5 implement temporary private preflight, Thai/English OCR suggestions, direct page selection, hover zoom, selected-page Docling parsing, provenance, fingerprints, and cleanup. Task 6 implements deterministic-first bounded AI recovery. Tasks 7–8 implement two tabs, actions, durable history, and evidence source view. Task 9 implements 401 sign-in recovery. Task 10 validates all constraints and browser behavior.
- **No automatic mutation:** Tasks 4, 6, 7, and 9 explicitly retain existing transactions/authentication and prohibit automatic apply/retry.
- **Type consistency:** Page selections use sorted 1-based `pages: number[]` from preflight through client, import, Docling, and fingerprint. Proposal durable status extensions are deliberately reflected in storage, API, and presenter before UI usage.
- **Scope:** Every task delivers independently testable behavior; no task changes existing BOQs or reruns extraction.
