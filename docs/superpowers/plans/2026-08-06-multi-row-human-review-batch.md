# Multi-Row Human-Review Batch Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely turn a multi-row no-draft human-review proposal into one user-confirmed BOQ item per immutable source row in one atomic action.

**Architecture:** Extend the existing manual-add endpoint with a closed single/batch request union, validate an exact one-to-one source-row set inside the proposal transaction, and sequentially build separate source-backed items on an in-memory BOQ before one write. Add a focused batch editor for one blank manual form per source row; retain the existing editor for mapped and single-row proposals.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Firebase Admin transactions, Node test runner via `tsx --test`, agent-browser CLI.

## Global Constraints

- A multi-row no-draft proposal must create exactly one BOQ item per `proposal.sourceRowId` or create nothing.
- Each resulting item may carry only its own immutable source row ID and PDF reference.
- Partial batch acceptance and per-row skip lifecycle are out of scope.
- Keep mapped `reviewDraft` and single-row evidence-only behavior unchanged.
- Keep automatic **Accept** disabled for every `needs_human_review` proposal.
- Never infer or persist values from `rawText`, `rawCells`, or provider explanations.
- Require one valid manual form for every source row before submission.
- Preserve accepted idempotency, stale-context, approved/read-only, terminal lifecycle, and immutable-evidence guards.
- Keep source-total approval reconciliation strict and catalog **Exclude** wording unchanged.
- Preserve unrelated unstaged edits; never use `git add .`.
- Never read, stage, or commit `Quotation example/`.
- Use 2-space indentation in touched TypeScript/TSX unless an existing file’s enforced format differs.
- Run `npm run check`, `npx tsc --noEmit`, `graphify update .`, LSP diagnostics, and browser QA before completion.

---

### Task 1: Add a closed single/batch request contract

**Files:**

- Modify: `src/lib/boq-user-entry.test.ts`
- Modify: `src/lib/boq-user-entry.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.ts`

**Interfaces:**

- Produces:

```ts
export interface SourceBackedBatchEntryRequest extends SourceBackedItemRequest {
  sourceRowId: string
}

export type SourceBackedManualAddRequest =
  | { mode: 'single'; value: SourceBackedItemRequest }
  | { mode: 'batch'; items: SourceBackedBatchEntryRequest[] }

export function parseSourceBackedManualAddRequest(value: unknown): SourceBackedManualAddRequest
```

- Preserves: `parseSourceBackedItemRequest(value): SourceBackedItemRequest` and the endpoint URL/response shape.

- [ ] **Step 1: Write failing parser tests**

Add tests proving the parser:

```ts
assert.deepEqual(parseSourceBackedManualAddRequest({
  sectionIndex: 0,
  item: { desc: 'Tooling', unit: 'Lot', qty: 1, materialCost: 6000, labourCost: 0 },
}), {
  mode: 'single',
  value: {
    sectionIndex: 0,
    desc: 'Tooling',
    unit: 'Lot',
    qty: 1,
    materialCost: 6000,
    labourCost: 0,
  },
})

assert.deepEqual(parseSourceBackedManualAddRequest({
  items: [
    { sourceRowId: 'row-1', sectionIndex: 0, item: { desc: 'Tooling', unit: 'Lot', qty: 1, materialCost: 6000, labourCost: 0 } },
    { sourceRowId: 'row-2', sectionIndex: 0, item: { desc: 'Expense', unit: 'Lot', qty: 1, materialCost: 61616, labourCost: 0 } },
  ],
}), {
  mode: 'batch',
  items: [
    { sourceRowId: 'row-1', sectionIndex: 0, desc: 'Tooling', unit: 'Lot', qty: 1, materialCost: 6000, labourCost: 0 },
    { sourceRowId: 'row-2', sectionIndex: 0, desc: 'Expense', unit: 'Lot', qty: 1, materialCost: 61616, labourCost: 0 },
  ],
})
```

Add separate rejection tests for unknown top-level keys, empty `items`, duplicate/blank `sourceRowId`, unknown entry keys, and malformed values. The batch parser must reuse `parseSourceBackedItemRequest` for each entry’s `sectionIndex/item` validation.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npm test -- src/lib/boq-user-entry.test.ts`

Expected: import/export failure for `parseSourceBackedManualAddRequest`.

- [ ] **Step 3: Implement the parser and tagged union**

Use exact-key allowlists. Treat a top-level own `items` key as batch shape; otherwise parse the existing single shape. Reject batches larger than 100 entries before mapping. Return flattened validated batch entries; never retain the client `item` wrapper internally.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `npm test -- src/lib/boq-user-entry.test.ts`

- [ ] **Step 5: Write failing API delegation tests**

Update the API dependency contract so `addSourceItem(...)` accepts `SourceBackedManualAddRequest`. Assert a batch request reaches the dependency as `{ mode: 'batch', items: [...] }`, and malformed/duplicate batches return `400` without calling the dependency.

Run: `npm test -- 'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts'`

Expected: batch request returns `400` or the dependency receives the old single type.

- [ ] **Step 6: Wire the API parser and verify GREEN**

Replace `parseSourceBackedItemRequest(body)` with `parseSourceBackedManualAddRequest(body)` in `addSourceItem`. Preserve authentication, path validation, JSON errors, and response delegation.

Run:

```bash
npm test -- src/lib/boq-user-entry.test.ts 'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts'
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/boq-user-entry.ts src/lib/boq-user-entry.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.ts' \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts'
git diff --cached --check
git commit -m "feat: add batch source-item request contract"
```

---

### Task 2: Persist one item per source row atomically

**Files:**

- Modify: `src/lib/boq-extraction-proposal-store.test.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts`

**Interfaces:**

- Consumes: Task 1 `SourceBackedManualAddRequest`.
- Produces: unchanged `addSourceItem(boqId, runId, proposalId, request, actorId)` response shape with atomic batch behavior.

- [ ] **Step 1: Write a two-row failing store fixture and success test**

Build a valid no-target `needs_human_review` proposal with `sourceRowIds: ['mapped-row', 'mapped-row-2']` and two immutable rows. Submit:

```ts
{
  mode: 'batch',
  items: [
    { sourceRowId: 'mapped-row-2', sectionIndex: 0, desc: 'Expense', unit: 'Lot', qty: 1, materialCost: 61616, labourCost: 0 },
    { sourceRowId: 'mapped-row', sectionIndex: 0, desc: 'Tooling', unit: 'Lot', qty: 1, materialCost: 6000, labourCost: 0 },
  ],
}
```

Assert the store:

- creates two items ordered by `proposal.sourceRowIds`, not request order;
- gives first item only `['mapped-row']` and its own sourceRef;
- gives second item only `['mapped-row-2']` and its own sourceRef;
- increments item count by 2 and total by `67_616`;
- writes one accepted audit/lifecycle; and
- an identical retry returns idempotent without duplicates.

- [ ] **Step 2: Write failing rejection/rollback tests**

Assert:

- a single request for a two-row proposal returns `409 batch_required`;
- a batch for a one-row proposal or mapped draft returns `409 single_required`;
- duplicate, missing, extra, or unknown row IDs return `400`/`409` and mutate nothing;
- an invalid second entry rolls back the first entry and leaves lifecycle pending;
- approved/stale/skipped guards still block batches.

- [ ] **Step 3: Run store tests and verify RED**

Run: `npm test -- src/lib/boq-extraction-proposal-store.test.ts`

Expected: multi-row batch returns `409` or does not create two independent items.

- [ ] **Step 4: Implement request-mode and exact-set validation**

After accepted-idempotency and existing safety guards:

- mapped draft: require `request.mode === 'single'` and preserve reconstruction;
- no-draft one-row: require single mode and preserve existing evidence-only behavior;
- no-draft multi-row: require batch mode;
- validate `new Set(request.items.map(sourceRowId))` exactly equals `new Set(proposal.sourceRowIds)` and every row exists in `immutable.sourceRows`.

Build a map by sourceRowId, then iterate `proposal.sourceRowIds`. For each entry:

```ts
const result = addSourceBackedBoqItem({
  boq: updatedBoq,
  validatedSourceMapping: {
    sourceRowId: row.id,
    sourceRowIds: [row.id],
    sourceRef: { page: row.page, table: row.table, row: row.row },
  },
  userValues: entry,
  itemId: `user-${randomUUID()}`,
})
updatedBoq = result.boq
```

Do not issue transaction writes inside the loop. Persist final sections/totals, one audit, and one accepted lifecycle only after all entries succeed.

- [ ] **Step 5: Run store tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-extraction-proposal-store.test.ts
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/boq-extraction-proposal-store.ts src/lib/boq-extraction-proposal-store.test.ts
git diff --cached --check
git commit -m "fix: add multi-row suggestions without collapsing provenance"
```

---

### Task 3: Build the multi-row batch editor

**Files:**

- Create: `src/components/evidence-only-batch-item-editor.tsx`
- Create: `src/components/evidence-only-batch-item-editor.test.tsx`

**Interfaces:**

- Consumes: `validateSourceBackedForm`, `computeSourceBackedLiveTotal`, `SourceBackedEditableFields`, and current BOQ sections.
- Produces:

```ts
export interface EvidenceOnlyBatchSourceRow {
  sourceRowId: string
  section: string | null
  page: number
  table: number
  row: number
}

export interface EvidenceOnlyBatchPayload {
  items: Array<{
    sourceRowId: string
    sectionIndex: number
    item: SourceBackedEditableFields
  }>
}
```

- [ ] **Step 1: Write failing pure-state and render tests**

Test:

- one blank/manual form is initialized per proposal source row in proposal order;
- section labels match case-insensitively, otherwise default to index 0;
- all numeric values start `NaN` and text values blank;
- `buildEvidenceOnlyBatchPayload` emits every source row exactly once in proposal order;
- `validateEvidenceOnlyBatch` is false until every form and section is valid;
- live totals calculate independently;
- rendered forms use unique accessible labels containing source reference;
- submit reads **Add 2 BOQ items** and is disabled for blank or partially valid batches.

- [ ] **Step 2: Run editor tests and verify RED**

Run: `npm test -- src/components/evidence-only-batch-item-editor.test.tsx`

Expected: module/import missing.

- [ ] **Step 3: Implement the focused component**

Use state keyed by `sourceRowId`, but always render/build payload using `proposal.sourceRowIds`. Reuse shared form validation and live-total helpers. Do not import server reconstruction logic or inspect `rawText/rawCells/explanation`. Render compact field groups, a destination select per row, inline errors after submit attempt, **Cancel**, and **Add N BOQ items**.

- [ ] **Step 4: Run editor tests and verify GREEN**

Run:

```bash
npm test -- src/components/evidence-only-batch-item-editor.test.tsx src/components/source-backed-item-editor.test.ts
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/components/evidence-only-batch-item-editor.tsx src/components/evidence-only-batch-item-editor.test.tsx
git diff --cached --check
git commit -m "feat: add multi-row extraction batch editor"
```

---

### Task 4: Wire batch versus single review editors

**Files:**

- Modify: `src/components/extraction-review.test.ts`
- Modify: `src/components/extraction-review.tsx`
- Modify: `src/lib/boq-extraction-review-ui.test.ts`
- Modify: `src/lib/boq-extraction-review-ui.ts`

**Interfaces:**

- Consumes: Task 3 `EvidenceOnlyBatchItemEditor` and existing single editor.
- Produces: one **Review & add** entry action choosing batch mode only for no-draft proposals with more than one source row; `submitSourceBackedItem(proposal, payload: SourceBackedItemPayload | EvidenceOnlyBatchPayload)` posts either wire shape unchanged.

- [ ] **Step 1: Write failing mode-selection tests**

Add this pure mode-selection helper:

```ts
export function proposalManualAddMode(proposal: ReviewAddProposal): 'single' | 'batch' | null
```

Expected:

- mapped draft → `single`;
- no-draft one row → `single`;
- no-draft multiple rows → `batch`;
- non-human-review or empty rows → `null`.

Keep `proposalCanBeReviewedAndAdded` lifecycle/read-only/stale gating unchanged and derive eligibility from non-null mode.

- [ ] **Step 2: Run helper tests and verify RED**

Run: `npm test -- src/lib/boq-extraction-review-ui.test.ts`

- [ ] **Step 3: Add failing component wiring assertions**

Assert `ExtractionReview` mounts `EvidenceOnlyBatchItemEditor` for `manualAddMode === 'batch'`, mounts `SourceBackedItemEditor` otherwise, passes selected source rows, and uses the same `submitSourceBackedItem` POST. Automatic Accept/Skip/history remain unchanged.

- [ ] **Step 4: Implement wiring**

Within each proposal card derive `manualAddMode`. Keep one editing proposal ID. Render the batch editor only for batch mode. Its `onSubmit` passes the batch payload unchanged to the existing fetch function. Do not duplicate endpoint logic.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts src/components/extraction-review.test.ts \
  src/components/evidence-only-batch-item-editor.test.tsx src/components/source-backed-item-editor.test.ts
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/boq-extraction-review-ui.ts src/lib/boq-extraction-review-ui.test.ts \
  src/components/extraction-review.tsx src/components/extraction-review.test.ts
git diff --cached --check
git commit -m "feat: route multi-row suggestions through batch review"
```

---

### Task 5: Full verification and affected-BOQ browser QA

**Files:**

- Create: `.superpowers/sdd/2026-08-06-multi-row-human-review-batch/browser-qa-report.md`

- [ ] **Step 1: Run diagnostics and automated verification**

Run:

```bash
npx tsc --noEmit
npm run check
graphify update .
```

Run LSP diagnostics on every changed source file. Confirm no source diff changes catalog **Exclude** copy.

- [ ] **Step 2: Browser-test the affected proposal without initial mutation**

Using agent-browser at `390×844` and `1280×800`, verify the current five-row card opens five blank/manual forms, distinct source labels, section selectors, no automatic Accept, no page-level overflow, and **Add 5 BOQ items** disabled until all forms are valid.

- [ ] **Step 3: Complete one authorized live batch save**

Use only these immutable source values already verified from the card; do not read another plan’s SDD workspace:

| Description | Unit | Qty | Material rate | Labour rate | Line total |
| --- | ---: | ---: | ---: | ---: | ---: |
| TOOLS AND CONSUMABLE | Lot | 1 | 6,000 | 0 | 6,000 |
| STUB-END 6B BS4 | Pcs. | 8 | 2,808 | 1,800 | 36,864 |
| EXPENSE | Lot | 1 | 61,616 | 0 | 61,616 |
| SAFETY COST | Lot | 1 | 7,000 | 0 | 7,000 |
| STUD-BOLT M20 | Pcs. | 80 | 275 | 0 | 22,000 |

The expected batch total is ฿133,480, moving the BOQ from ฿80,584 to ฿214,064 and leaving an approval difference of ฿263,936. Before submit, record all form values and calculated totals. Submit once and verify:

- five separate BOQ items appear;
- each item corresponds to one source row;
- grand total increases by the sum of the five lines;
- proposal moves to accepted history;
- approval stays blocked with an updated exact difference;
- each new item enters unmatched catalog handling with **Exclude** unchanged; and
- reload does not duplicate the five items.

Do not approve the BOQ.

- [ ] **Step 4: Record evidence and final repository state**

Use DOM/snapshot evidence if screenshot capture still fails; report the tooling failure explicitly. Confirm no staged files, unrelated edits remain unstaged, `git diff --check` is clean, and `Quotation example/` was untouched.
