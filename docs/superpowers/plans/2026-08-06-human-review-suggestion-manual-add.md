# Human-Review Suggestion Manual Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users manually review and add source-linked missing BOQ items from `needs_human_review` suggestions that have no `reviewDraft`, while preserving strict approval reconciliation and existing catalog **Exclude** behavior.

**Architecture:** Extend the existing `add-source-item` transaction with a second, evidence-only provenance path for no-target human-review proposals. Reuse `SourceBackedItemEditor` with blank/manual initialization when no safe mapping exists, centralize UI eligibility in the extraction-review domain, and derive a precise document-total mismatch message from current BOQ totals.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Node test runner via `tsx --test`, Firebase Admin transaction abstractions, existing BOQ extraction proposal/audit contracts.

## Global Constraints

- Keep **Accept** disabled for every `needs_human_review` proposal.
- Render **Review & add** only for an existing review draft or a pending, no-target, non-stale `needs_human_review` proposal.
- Do not add a fallback insert action to target-based human-review proposals.
- Never persist provider-authored explanation text as BOQ descriptions, units, quantities, rates, or totals.
- Resolve source row IDs and PDF references only from immutable server-owned extraction rows.
- Keep approval blocked while normalized BOQ totals differ from `sourceTotal` by more than `0.01`.
- Keep the catalog action wording **Exclude** unchanged.
- Preserve approved/read-only, lifecycle, idempotency, immutable-evidence, and request-validation guards.
- Preserve all unrelated unstaged edits. Never use `git add .`; inspect and stage only intended hunks, especially in `src/app/(authenticated)/boqs/[id]/page.tsx` and its test.
- Never read, stage, or commit `Quotation example/`.
- Use 2-space indentation in touched TypeScript/TSX code.
- Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before changing route-backed behavior.
- Run `graphify update .` after code changes and `npm run check` before completion.

---

## File Structure

- `src/lib/boq-extraction-proposal-store.ts` — owns transactional validation, immutable provenance reconstruction, BOQ mutation, lifecycle advancement, and audit persistence.
- `src/lib/boq-extraction-proposal-store.test.ts` — exercises evidence-only insertion, conflict guards, provenance, audit shape, and idempotency against the in-memory Firestore harness.
- `src/components/source-backed-item-editor.tsx` — owns mapped-draft and evidence-only manual editor initialization and validation.
- `src/components/source-backed-item-editor.test.ts` — verifies mapped prefills remain unchanged and evidence-only fields stay blank/manual.
- `src/lib/boq-extraction-review-ui.ts` — owns the pure predicate deciding whether a proposal may expose **Review & add**.
- `src/lib/boq-extraction-review-ui.test.ts` — tests pending/read-only/stale/target/lifecycle eligibility without source-text assertions.
- `src/components/extraction-review.tsx` — wires the eligibility predicate, selected source rows, editor, and existing mutation endpoint.
- `src/components/extraction-review.test.ts` — confirms the component no longer requires `proposal.reviewDraft` to expose the manual path.
- `src/lib/boq-detail-state.ts` — owns the pure document-total mismatch message formatter.
- `src/lib/boq-detail-state.test.ts` — tests exact totals, tolerance, absent source totals, and absolute differences.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — selects the specific mismatch message ahead of the generic verification blocker copy.
- `src/app/(authenticated)/boqs/[id]/page.test.ts` — confirms reason precedence and wiring while preserving existing approval guards.

---

### Task 1: Accept evidence-only manual additions transactionally

**Files:**

- Modify: `src/lib/boq-extraction-proposal-store.test.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts:1095-1203`

**Interfaces:**

- Consumes: existing `SourceBackedItemRequest`, `ValidatedProposal`, immutable `BoqSourceRowV3[]`, `addSourceBackedBoqItem(...)`, and proposal lifecycle/audit helpers.
- Produces: `BoqExtractionProposalStore.addSourceItem(...)` support for a pending no-target `needs_human_review` proposal without `reviewDraft`; request and response signatures remain unchanged.

- [ ] **Step 1: Read the relevant Next.js route-handler guide and current transaction**

Run:

```bash
cat node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1095,1205p' src/lib/boq-extraction-proposal-store.ts
```

Confirm the route remains a thin authenticated adapter and all new trust-boundary logic belongs in the store transaction.

- [ ] **Step 2: Write failing evidence-only insertion tests**

Add a fixture that prepares a direct provider decision rather than manufacturing a malformed stored proposal:

```ts
function evidenceOnlyReviewHarness() {
  const fixture = mappedStoreHarness()
  const prepared = prepareProviderProposalV2({
    id: 'proposal-evidence-only',
    operation: 'needs_human_review',
    sourceRowIds: ['mapped-row'],
    targetItemIds: [],
    candidateItemIds: [],
    confidence: 0.72,
    explanation: 'The source row is relevant, but its component columns remain ambiguous.',
  }, fixture.context)
  if (!prepared.ok) throw new Error('evidence-only proposal preparation failed')
  const proposal = {
    ...prepared.proposal,
    evidenceValid: true as const,
    reconciled: true as const,
    stale: false,
  }
  const userValues = parseSourceBackedItemRequest({
    sectionIndex: 0,
    item: { desc: 'Valve installation', unit: 'Lot', qty: 1, materialCost: 3000, labourCost: 3000 },
  })
  return { ...fixture, proposal, userValues }
}
```

Add tests asserting:

```ts
test('addSourceItem adds a user item from immutable evidence when a no-target human-review proposal has no draft', async () => {
  const fixture = evidenceOnlyReviewHarness()
  await fixture.store.saveValidatedProposals('boq-1', 'run-1', [fixture.proposal])

  const result = await fixture.store.addSourceItem(
    'boq-1', 'run-1', fixture.proposal.id, fixture.userValues, 'user-7',
  )

  assert.equal(result.status, 200)
  const stored = fixture.db.docs.get('boqs/boq-1') as unknown as Boq
  const added = stored.sections[0].items.at(-1) as BoqPricedItem
  assert.equal(added.entryOrigin, 'user')
  assert.deepEqual(added.sourceRowIds, ['mapped-row'])
  assert.deepEqual(added.sourceRef, { page: 1, table: 0, row: 1 })
  assert.equal(added.rate, 6000)
  assert.equal(added.total, 6000)

  const audit = fixture.db.docs.get(`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`)!
  assert.equal(audit.status, 'accepted')
  assert.equal(audit.reviewDraft, undefined)
  assert.deepEqual(audit.proposedItems, [])
})
```

Use the fixture’s actual immutable source reference if `mappedStoreHarness()` defines a different page/table/row tuple; assert the exact fixture value, not a loose truthy check.

Add separate tests that:

- retrying the accepted evidence-only proposal returns `{ idempotent: true }` without a second item;
- a no-draft `needs_human_review` proposal with a target item returns `409`;
- a changed canonical section fingerprint or `stale: true` returns `409`;
- an approved BOQ and terminal skipped/rejected lifecycle remain blocked.

Retain the existing test that rejects ordinary non-review proposals without a source-backed draft; rename it to state that target/non-human operations remain unsupported.

- [ ] **Step 3: Run the store tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-proposal-store.test.ts
```

Expected: the evidence-only insertion test fails with `409` and `Proposal is not a source-backed review draft`; existing tests remain green.

- [ ] **Step 4: Implement the evidence-only provenance branch**

Inside the transaction, preserve the current `reviewDraft` reconstruction branch. Replace the unconditional missing-draft conflict with two branches equivalent to:

```ts
let validatedSourceMapping: ValidatedSourceMapping
if (proposal.reviewDraft) {
  const reconstruction = reconstructSourceMappedItem({
    mapping: proposal.reviewDraft.mapping,
    targetItemIds: proposal.targetItemIds,
    sourceRows: immutable.sourceRows,
    allowedSourceRowIds: new Set(proposal.sourceRowIds),
    sections: boq.sections,
    targetItems,
  })
  if (reconstruction.kind === 'invalid') return { status: 400, body: { error: reconstruction.code } }
  if (reconstruction.kind === 'candidate') {
    return { status: 409, body: { error: 'Proposal already resolves to a complete mapping' } }
  }
  const draft = reconstruction.draft
  validatedSourceMapping = {
    sourceRowId: draft.sourceRowIds[0] ?? '',
    sourceRowIds: [...draft.sourceRowIds],
    ...(draft.sourceRefs[0] ? { sourceRef: { ...draft.sourceRefs[0] } } : {}),
  }
  const sourceCosts = sourceCostsFromResolvedValues(draft.resolvedValues)
  if (sourceCosts) validatedSourceMapping.sourceCosts = sourceCosts
} else {
  if (proposal.operation !== 'needs_human_review' || proposal.targetItemIds.length !== 0) {
    return { status: 409, body: { error: 'Proposal is not eligible for manual insertion' } }
  }
  const rowsById = new Map(immutable.sourceRows.map((row) => [row.id, row]))
  const sourceRows = proposal.sourceRowIds.map((id) => rowsById.get(id))
  if (sourceRows.length === 0 || sourceRows.some((row) => row === undefined)) {
    return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
  }
  const first = sourceRows[0]!
  validatedSourceMapping = {
    sourceRowId: first.id,
    sourceRowIds: [...proposal.sourceRowIds],
    sourceRef: { page: first.page, table: first.table, row: first.row },
  }
}
```

Do not create a synthetic `reviewDraft`, source mapping, or source cost allocation for the evidence-only path.

Before either branch mutates the BOQ, reject stale canonical context using the existing proposal fingerprint:

```ts
if (proposal.stale === true
  || proposal.baseSectionsFingerprint !== fingerprintCanonicalSections(boq.sections)) {
  return { status: 409, body: { error: 'Canonical BOQ changed; recheck the proposal' } }
}
```

Keep this guard after accepted-idempotency handling so a retry of an already accepted action still returns its pinned result.

- [ ] **Step 5: Run the store tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-extraction-proposal-store.test.ts
```

Expected: all proposal-store tests pass, including the evidence-only, target-based conflict, stale-context, approved, lifecycle, and idempotency cases.

- [ ] **Step 6: Run LSP diagnostics and commit only the intended files**

Run LSP diagnostics on both files, then:

```bash
git diff --check -- src/lib/boq-extraction-proposal-store.ts src/lib/boq-extraction-proposal-store.test.ts
git add src/lib/boq-extraction-proposal-store.ts src/lib/boq-extraction-proposal-store.test.ts
git diff --cached --check
git commit -m "feat: add evidence-only extraction suggestions"
```

---

### Task 2: Support an evidence-only manual editor

**Files:**

- Modify: `src/components/source-backed-item-editor.test.ts`
- Modify: `src/components/source-backed-item-editor.tsx`

**Interfaces:**

- Consumes: `ValidatedProposal`, `Boq`, and selected source rows structurally narrowed to `SourceBackedEditorSourceRow[]` by Task 3.
- Produces: `SourceBackedItemEditor` prop `sourceRows?: readonly SourceBackedEditorSourceRow[]`; `deriveInitialSourceBackedForm(draft?: SourceBackedReviewDraft)`; `defaultSourceBackedSectionIndex(...)`.

- [ ] **Step 1: Write failing initialization and render tests**

Update the test render helper to accept `sourceRows`. Add:

```ts
test('evidence-only initialization leaves every priced field blank and manual', () => {
  const values = deriveInitialSourceBackedForm(undefined)
  assert.equal(values.desc, '')
  assert.equal(values.unit, '')
  assert.equal(Number.isNaN(values.qty), true)
  assert.equal(Number.isNaN(values.materialCost), true)
  assert.equal(Number.isNaN(values.labourCost), true)
  assert.equal(values.isSingleRate, false)
  assert.deepEqual(values.missingFields, [
    'description', 'unit', 'quantity', 'materialRate', 'labourRate', 'amount',
  ])
})
```

Add section-selection tests:

```ts
test('evidence-only editor defaults to the source section and otherwise the first BOQ section', () => {
  const sections = boq().sections
  assert.equal(defaultSourceBackedSectionIndex(undefined, [{ section: 'Finishing' }], sections), 1)
  assert.equal(defaultSourceBackedSectionIndex(undefined, [{ section: 'Unknown' }], sections), 0)
  assert.equal(defaultSourceBackedSectionIndex(draft({ section: null }), [], sections), null)
})
```

Add this client-safe structural type next to the editor props and use it in the test fixture:

```ts
export interface SourceBackedEditorSourceRow {
  section: string | null
}
```

Do not import `boq-extraction-ai-review.ts` into the client component; the full review rows passed by `ExtractionReview` satisfy this narrow structural contract.

Add a render test with `proposal({ reviewDraft: undefined })` asserting:

- the editor heading is present;
- the old `This proposal has no source-backed review draft.` alert is absent;
- description, unit, quantity, material, and labour inputs are blank;
- **Save BOQ item** remains disabled until valid values exist;
- destination section options render; and
- no blank field carries a `Source` badge.

Keep every existing mapped-draft prefill and single-rate test unchanged.

- [ ] **Step 2: Run the editor tests and verify RED**

Run:

```bash
npm test -- src/components/source-backed-item-editor.test.ts
```

Expected: the new helper signature/exports are missing and the no-draft render still shows the alert.

- [ ] **Step 3: Implement optional-draft initialization**

Change the pure initializer to accept an optional draft:

```ts
export function deriveInitialSourceBackedForm(
  draft?: SourceBackedReviewDraft,
): SourceBackedFieldValues {
  if (!draft) {
    return {
      desc: '',
      unit: '',
      qty: EMPTY_NUMERIC,
      materialCost: EMPTY_NUMERIC,
      labourCost: EMPTY_NUMERIC,
      isSingleRate: false,
      singleRate: null,
      missingFields: ['description', 'unit', 'quantity', 'materialRate', 'labourRate', 'amount'],
    }
  }
  const resolved = draft.resolvedValues
  const hasComponentPrices = resolved.materialRate !== undefined || resolved.labourRate !== undefined
  const hasGenericPrice = resolved.rate !== undefined || resolved.total !== undefined
  const isSingleRate = !hasComponentPrices && hasGenericPrice
  const singleRate = isFiniteNonNegative(resolved.rate) ? resolved.rate : null
  return {
    desc: typeof resolved.description === 'string' && resolved.description.trim() !== '' ? resolved.description : '',
    unit: typeof resolved.unit === 'string' && resolved.unit.trim() !== '' ? resolved.unit : '',
    qty: isFiniteNonNegative(resolved.quantity) ? resolved.quantity : EMPTY_NUMERIC,
    materialCost: hasComponentPrices
      ? (isFiniteNonNegative(resolved.materialRate) ? resolved.materialRate : EMPTY_NUMERIC)
      : isSingleRate && singleRate !== null
        ? singleRate
        : EMPTY_NUMERIC,
    labourCost: hasComponentPrices
      ? (isFiniteNonNegative(resolved.labourRate) ? resolved.labourRate : EMPTY_NUMERIC)
      : 0,
    isSingleRate,
    singleRate,
    missingFields: [...draft.missingFields],
  }
}
```

Add a pure section helper with this contract:

```ts
export function defaultSourceBackedSectionIndex(
  draft: SourceBackedReviewDraft | undefined,
  sourceRows: readonly SourceBackedEditorSourceRow[],
  sections: readonly Pick<Boq['sections'][number], 'header'>[],
): number | null
```

Behavior:

- mapped draft with section: return its valid index;
- mapped draft with `section: null`: return `null` to preserve explicit user selection;
- no draft: case-insensitively match the first non-empty source-row section to a BOQ header;
- no match: return `0` when the BOQ has sections, otherwise `null`.

Update `SourceBackedItemEditorProps` with optional `sourceRows`, initialize values for both modes, remove the no-draft alert, and set:

```ts
const needsSectionSelect = !draft || draft.section === null
const sourceBadgeFor = (field: SourceReviewMissingField) => Boolean(draft) && !fieldIsMissing(field)
```

Do not parse `rawText`, `rawCells`, or `proposal.explanation` into editable values.

- [ ] **Step 4: Run the editor tests and verify GREEN**

Run:

```bash
npm test -- src/components/source-backed-item-editor.test.ts
```

Expected: all mapped and evidence-only editor tests pass.

- [ ] **Step 5: Run LSP diagnostics and commit**

Run LSP diagnostics on both files, then:

```bash
git diff --check -- src/components/source-backed-item-editor.tsx src/components/source-backed-item-editor.test.ts
git add src/components/source-backed-item-editor.tsx src/components/source-backed-item-editor.test.ts
git diff --cached --check
git commit -m "feat: enable evidence-only BOQ item review"
```

---

### Task 3: Expose Review & add for eligible human-review suggestions

**Files:**

- Modify: `src/lib/boq-extraction-review-ui.test.ts`
- Modify: `src/lib/boq-extraction-review-ui.ts`
- Modify: `src/components/extraction-review.test.ts`
- Modify: `src/components/extraction-review.tsx:600-635`

**Interfaces:**

- Consumes: Task 2’s optional-draft editor and selected source rows; existing `ExtractionProposalStatus` values.
- Produces: `proposalCanBeReviewedAndAdded(proposal, status, readOnly): boolean`; component wiring to the existing `submitSourceBackedItem(...)` endpoint.

- [ ] **Step 1: Write failing pure eligibility tests**

Import and test `proposalCanBeReviewedAndAdded`:

```ts
test('manual add is available for a pending no-target human-review proposal without a draft', () => {
  assert.equal(proposalCanBeReviewedAndAdded(proposal({
    operation: 'needs_human_review',
    targetItemIds: [],
    reviewDraft: undefined,
    stale: false,
  }), undefined, false), true)
})

test('manual add rejects target-based, stale, terminal, and read-only proposals', () => {
  const base = proposal({ operation: 'needs_human_review', targetItemIds: [], reviewDraft: undefined })
  assert.equal(proposalCanBeReviewedAndAdded({ ...base, targetItemIds: ['item-1'] }, undefined, false), false)
  assert.equal(proposalCanBeReviewedAndAdded({ ...base, stale: true }, undefined, false), false)
  assert.equal(proposalCanBeReviewedAndAdded(base, 'skipped', false), false)
  assert.equal(proposalCanBeReviewedAndAdded(base, undefined, true), false)
})
```

Also assert an existing non-stale `reviewDraft` remains eligible under its current no-target shape.

- [ ] **Step 2: Run the review UI tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts
```

Expected: import/export failure for the new eligibility helper.

- [ ] **Step 3: Implement the pure eligibility predicate**

Add a local lifecycle union and a proposal shape containing only the required validated fields:

```ts
type ProposalReviewLifecycleStatus = 'accepted' | 'rejected' | 'skipped' | 'superseded' | 'undone'

type ReviewAddProposal = Pick<
  ValidatedProposal,
  'operation' | 'reviewDraft' | 'sourceRowIds' | 'targetItemIds' | 'stale'
>

export function proposalCanBeReviewedAndAdded(
  proposal: ReviewAddProposal,
  status: ProposalReviewLifecycleStatus | undefined,
  readOnly: boolean,
): boolean {
  if (readOnly || status !== undefined || proposal.stale === true) return false
  if (proposal.reviewDraft) return proposal.operation === 'needs_human_review'
  return proposal.operation === 'needs_human_review'
    && proposal.targetItemIds.length === 0
    && proposal.sourceRowIds.length > 0
}
```

Do not broaden eligibility to other operations.

- [ ] **Step 4: Add failing component wiring assertions**

In `src/components/extraction-review.test.ts`, add a focused source-contract test asserting the component:

- imports/calls `proposalCanBeReviewedAndAdded`;
- does not gate **Review & add** or the editor mount on `proposal.reviewDraft`;
- passes `sourceRows={sourceRows}` to `SourceBackedItemEditor`;
- still labels automatic acceptance as disabled; and
- still calls `submitSourceBackedItem(proposal, payload)`.

Use bounded source sections around the proposal footer/editor so unrelated `reviewDraft` references elsewhere do not make the assertion brittle.

- [ ] **Step 5: Run the component test and verify RED**

Run:

```bash
npm test -- src/components/extraction-review.test.ts
```

Expected: assertions fail because both button and editor currently require `proposal.reviewDraft`.

- [ ] **Step 6: Wire the predicate and selected source rows**

Within the proposal render loop:

```ts
const canReviewAndAdd = proposalCanBeReviewedAndAdded(proposal, status, readOnly)
```

Replace both `proposal.reviewDraft` gates with `canReviewAndAdd`. Pass the already selected rows:

```tsx
<SourceBackedItemEditor
  boq={boq}
  proposal={proposal}
  sourceRows={sourceRows}
  busy={action === 'adding'}
  serverError={sourceBackedError}
  onCancel={() => { setEditingProposalId(null); setSourceBackedError(null) }}
  onSubmit={(payload) => submitSourceBackedItem(proposal, payload)}
/>
```

Keep **Accept** controlled exclusively by `proposalCanBeAccepted`. Keep **Skip**, lifecycle history, and read-only behavior unchanged. Do not rename **Exclude** anywhere.

- [ ] **Step 7: Run focused review tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts src/components/extraction-review.test.ts src/components/source-backed-item-editor.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 8: Run LSP diagnostics and commit**

Run LSP diagnostics on all four files, then:

```bash
git diff --check -- src/lib/boq-extraction-review-ui.ts src/lib/boq-extraction-review-ui.test.ts src/components/extraction-review.tsx src/components/extraction-review.test.ts
git add src/lib/boq-extraction-review-ui.ts src/lib/boq-extraction-review-ui.test.ts src/components/extraction-review.tsx src/components/extraction-review.test.ts
git diff --cached --check
git commit -m "feat: expose manual add for human review suggestions"
```

---

### Task 4: Show exact document-total approval blockers

**Files:**

- Modify: `src/lib/boq-detail-state.test.ts`
- Modify: `src/lib/boq-detail-state.ts`
- Modify intended hunks only: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify intended hunks only: `src/app/(authenticated)/boqs/[id]/page.tsx:622-663`

**Interfaces:**

- Consumes: current `displayBoq.sourceTotal`, calculated `grandTotal`, and verification issue code `document_total_mismatch`.
- Produces: `documentTotalMismatchMessage(sourceTotal, itemTotal): string | null` and approval reason precedence using the specific message before the generic verification fallback.

- [ ] **Step 1: Write failing formatter tests**

Add to `src/lib/boq-detail-state.test.ts`:

```ts
test('documentTotalMismatchMessage reports source, BOQ, and absolute difference', () => {
  assert.equal(
    documentTotalMismatchMessage(478000, 80584),
    'Source total ฿478,000.00; BOQ items ฿80,584.00; difference ฿397,416.00.',
  )
})

test('documentTotalMismatchMessage returns null without a meaningful mismatch', () => {
  assert.equal(documentTotalMismatchMessage(undefined, 80584), null)
  assert.equal(documentTotalMismatchMessage(100, 100.009), null)
  assert.equal(documentTotalMismatchMessage(80, 100), 'Source total ฿80.00; BOQ items ฿100.00; difference ฿20.00.')
})
```

- [ ] **Step 2: Run the state tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-detail-state.test.ts
```

Expected: import/export failure for `documentTotalMismatchMessage`.

- [ ] **Step 3: Implement the formatter**

Add a pure helper using the same `0.01` tolerance as local verification:

```ts
const DOCUMENT_TOTAL_TOLERANCE = 0.01

function formatBaht(value: number): string {
  return `฿${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function documentTotalMismatchMessage(
  sourceTotal: number | undefined,
  itemTotal: number,
): string | null {
  if (sourceTotal === undefined || !Number.isFinite(sourceTotal) || !Number.isFinite(itemTotal)) return null
  const difference = Math.abs(sourceTotal - itemTotal)
  if (difference <= DOCUMENT_TOTAL_TOLERANCE) return null
  return `Source total ${formatBaht(sourceTotal)}; BOQ items ${formatBaht(itemTotal)}; difference ${formatBaht(difference)}.`
}
```

- [ ] **Step 4: Run the state tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-detail-state.test.ts
```

Expected: all detail-state tests pass.

- [ ] **Step 5: Add a failing page wiring test**

Extend the existing approval-disabled-state test to assert:

```ts
assert.match(source, /documentTotalMismatchMessage/)
assert.match(source, /issue\.code === "document_total_mismatch"/)
assert.match(source, /documentMismatchReason \?\? "Resolve the review blockers below before approving\."/)
```

Preserve the current reason precedence: busy → invalid component drafts → pending edits → verification → catalog readiness.

- [ ] **Step 6: Run the page test and verify RED**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: the new mismatch-message wiring assertions fail while existing approval-order assertions pass.

- [ ] **Step 7: Wire the specific message into approval state**

Import `documentTotalMismatchMessage`. Immediately before `approvalDisabledReason`, derive:

```ts
const documentMismatchReason = verification.issues.some(
  (issue) => issue.code === 'document_total_mismatch',
)
  ? documentTotalMismatchMessage(displayBoq.sourceTotal, grandTotal)
  : null
```

Change only the verification reason branch:

```ts
: verification.hasBlockingIssues
  ? documentMismatchReason ?? 'Resolve the review blockers below before approving.'
```

Do not change any approval guard or catalog-readiness condition.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-detail-state.test.ts 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: all focused tests pass with the exact ฿478,000 / ฿80,584 / ฿397,416 copy.

- [ ] **Step 9: Stage only intended hunks and commit**

Because the page files already contain unrelated unstaged edits, inspect and stage interactively:

```bash
git diff -- src/lib/boq-detail-state.ts src/lib/boq-detail-state.test.ts 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git add src/lib/boq-detail-state.ts src/lib/boq-detail-state.test.ts
git add -p 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff --cached --check
git diff --cached
git commit -m "fix: explain BOQ source total mismatches"
```

Confirm no pre-existing formatting hunks entered the staged diff.

---

### Task 5: Integrated verification and browser QA

**Files:**

- No production changes expected.
- Create: `.superpowers/sdd/2026-08-06-human-review-suggestion-manual-add/browser-qa-report.md`

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces: verified automated checks, updated Graphify graph, and manual evidence for the affected BOQ flow.

- [ ] **Step 1: Run proactive diagnostics**

Run LSP diagnostics on:

```text
src/lib/boq-extraction-proposal-store.ts
src/components/source-backed-item-editor.tsx
src/lib/boq-extraction-review-ui.ts
src/components/extraction-review.tsx
src/lib/boq-detail-state.ts
src/app/(authenticated)/boqs/[id]/page.tsx
```

Fix every new error before continuing.

- [ ] **Step 2: Run the complete automated verification**

Run:

```bash
npx tsc --noEmit
npm run check
graphify update .
```

Expected: TypeScript passes, lint passes, the full test suite passes, and Graphify exits `0`.

- [ ] **Step 3: Verify no catalog wording changed**

Run:

```bash
git diff HEAD~4..HEAD -- src | grep -n "Exclude" || true
```

Inspect the diff and confirm no intended or accidental rename of catalog **Exclude** occurred.

- [ ] **Step 4: Browser-test the affected BOQ**

Using the agent-browser skill against:

```text
http://localhost:3000/boqs/e262c286-8815-4617-9b96-ebd2734ed450?view=review
```

Verify:

1. The approval blocker shows source ฿478,000.00, current BOQ total, and the exact difference.
2. A pending no-target **Needs human review** card without `reviewDraft` shows **Review & add** and **Skip**, but not **Accept**.
3. Opening **Review & add** keeps source evidence visible and shows blank/manual priced fields plus a destination section.
4. Invalid or incomplete values cannot save.
5. A valid manual item saves, appears in BOQ Items, updates the grand total, and moves the proposal to accepted history.
6. The added line enters the existing catalog workflow and still offers **Exclude** with unchanged wording.
7. Reloading does not duplicate the item.
8. Approved/read-only BOQs do not expose the mutation action.
9. At a mobile viewport, the evidence card and editor remain usable without horizontal page overflow.

Do not force approval unless the full BOQ genuinely reconciles to ฿478,000 and all catalog blockers are resolved. Record each scenario, viewport, result, and screenshot path in `.superpowers/sdd/2026-08-06-human-review-suggestion-manual-add/browser-qa-report.md`.

- [ ] **Step 5: Run final repository checks**

Run:

```bash
git status --short
git diff --check
git log --oneline -5
```

Confirm `Quotation example/` was never read or staged, unrelated pre-existing edits remain unstaged, and only task-specific commits were created.
