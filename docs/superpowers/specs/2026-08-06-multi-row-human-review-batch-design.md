# Multi-row human-review batch add

## Problem

Live QA of BOQ `e262c286-8815-4617-9b96-ebd2734ed450` found one pending no-draft `needs_human_review` proposal containing five distinct quotation rows:

- TOOLS AND CONSUMABLE;
- STUB-END 6B BS4;
- EXPENSE;
- SAFETY COST; and
- STUD-BOLT M20.

The current fallback renders one `SourceBackedItemEditor` and posts one item. The store then attaches every `proposal.sourceRowId` to that single item, uses only the first row as `sourceRef`, and marks the whole proposal accepted. Saving one line would therefore claim five unrelated rows as its provenance and prevent the remaining four from being added.

The user selected a **batch editor** so each source row becomes a separate BOQ item in one explicit, atomic action.

## Goals

- Render one manual priced-item form per source row for a multi-row no-draft human-review proposal.
- Require one complete, valid entry for every proposal source row before batch submission.
- Create one BOQ item per source row with only that row’s immutable provenance.
- Save all entries atomically and advance the proposal lifecycle only after the complete batch succeeds.
- Keep mapped review drafts and single-row evidence-only proposals on their existing single-item workflow.
- Preserve idempotency, stale-context checks, approved/read-only guards, source-total reconciliation, and catalog **Exclude** wording.

## Non-goals

- Partially accepting a multi-row proposal.
- Adding per-row skip state or partial proposal lifecycle states.
- Automatically inferring financial values from raw source text or provider explanations.
- Automatically creating catalog entries.
- Changing automatic **Accept** eligibility.
- Migrating proposal records or splitting provider proposal IDs.

## Eligibility and presentation

A pending, non-stale, no-target `needs_human_review` proposal remains manually actionable when it contains one or more source row IDs.

- With `reviewDraft`: retain the existing mapped single-item editor.
- Without `reviewDraft` and exactly one source row: retain the evidence-only single-item editor.
- Without `reviewDraft` and more than one source row: render the new batch editor.

The batch editor displays one compact row form per source row, ordered by the proposal’s `sourceRowIds`. Each form shows a stable source label (`Page N · table N · row N`) and destination section selector. Description, unit, quantity, material rate, and labour rate start blank and are labeled **Manual**. The surrounding extraction card keeps the detailed source evidence visible.

The primary action reads **Add N BOQ items**. It remains disabled until every row form and destination section is valid. **Cancel** discards the in-memory batch. **Skip** remains the proposal-level alternative outside the editor.

Because partial acceptance is a non-goal, users must complete all rows or cancel/skip the proposal. This keeps lifecycle and audit semantics atomic.

## Client contract

Add a focused `EvidenceOnlyBatchItemEditor` rather than making `SourceBackedItemEditor` manage two collection shapes.

```ts
interface EvidenceOnlyBatchEntryPayload {
  sourceRowId: string
  sectionIndex: number
  item: {
    desc: string
    unit: string
    qty: number
    materialCost: number
    labourCost: number
  }
}

interface EvidenceOnlyBatchPayload {
  items: EvidenceOnlyBatchEntryPayload[]
}
```

The editor receives:

- the current `Boq`;
- the `ValidatedProposal`;
- the selected source rows narrowed to sourceRowId, section, page, table, and row;
- submit/cancel/busy/error callbacks.

It reuses the existing numeric parsing, live-total, and validation rules through exported pure helpers rather than duplicating validation logic. Section defaults match each source row’s section label to the BOQ section header and fall back to the first section.

`ExtractionReview` chooses the batch editor only when:

```ts
proposal.operation === "needs_human_review"
&& !proposal.reviewDraft
&& proposal.sourceRowIds.length > 1
```

The existing **Review & add** button remains the entry point. Automatic **Accept** remains absent.

## Server request contract

Keep the endpoint:

`POST /api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item`

Extend its parsed request into a closed union:

```ts
type SourceBackedManualAddRequest =
  | { mode: "single"; value: SourceBackedItemRequest }
  | { mode: "batch"; items: SourceBackedBatchEntryRequest[] }
```

The JSON wire shapes remain concise:

- single: existing `{ sectionIndex, item }`;
- batch: `{ items: [{ sourceRowId, sectionIndex, item }, ...] }`.

The parser rejects unknown keys, empty batches, duplicate source row IDs, malformed rows, non-finite values, negative costs, invalid precision, and oversized batches. The practical batch limit is the existing proposal source-row count; the store requires an exact one-to-one set match.

## Transactional batch behavior

Inside `BoqExtractionProposalStore.addSourceItem`:

1. Preserve authentication, immutable-context, accepted-idempotency, pending lifecycle, approved BOQ, and stale canonical fingerprint guards.
2. `reviewDraft` proposals require a single request and keep their current reconstruction path.
3. No-draft single-row proposals require a single request and keep their current path, but the server explicitly rejects that path when `proposal.sourceRowIds.length !== 1`.
4. No-draft multi-row proposals require a batch request.
5. Validate that batch `sourceRowId` values exactly equal `proposal.sourceRowIds`: no missing, duplicate, extra, or unknown rows.
6. Order entries by `proposal.sourceRowIds`, not client order.
7. Starting from the current BOQ, call `addSourceBackedBoqItem` once per entry, each time with provenance containing only that immutable row:
   - `sourceRowId: row.id`;
   - `sourceRowIds: [row.id]`;
   - its own page/table/row `sourceRef`;
   - no synthetic source costs or mapping.
8. If any entry fails, return an error and commit nothing.
9. Persist final sections/totals once, write one accepted audit covering the proposal before/after diff, and mark the proposal accepted once.
10. Preserve the existing accepted retry response so repeated requests create no duplicate items.

The audit continues to use `proposedItems: []` because all values are user-authored. Its proposal-level `sourceRowIds/sourceRefs` cover the complete batch, while each resulting BOQ item carries exactly one row’s provenance.

## Error handling

- A single request for a multi-row no-draft proposal returns `409` with a safe batch-required error.
- A batch request for a mapped draft or single-row proposal returns `409`.
- Duplicate, missing, extra, or unknown batch row IDs return `400` or `409` before mutation.
- Invalid entry fields identify the failing row without echoing source text.
- Approved, stale, skipped, rejected, undone, or superseded proposals remain blocked.
- Any transaction failure leaves the BOQ and proposal lifecycle unchanged.

## Approval and catalog behavior

Each added row is a normal user-origin BOQ item and contributes to the BOQ total. Source-total approval mismatch messaging updates from the new aggregate but stays blocking until the BOQ genuinely reconciles.

Each item enters the existing unmatched catalog workflow independently. The user may match, create, or **Exclude** each row later. **Exclude** wording and semantics remain unchanged.

## Testing

Test-first coverage includes:

- parsing valid single and multi-row requests;
- rejecting unknown keys, empty/duplicate/malformed batch entries;
- rejecting a single request for a multi-row no-draft proposal;
- atomically creating one item per source row with independent provenance;
- exact source-row set validation and deterministic proposal order;
- aggregate total and item-count updates;
- one accepted lifecycle/audit and idempotent retry;
- rollback/no mutation when one batch entry is invalid;
- mapped and single-row flows remaining unchanged;
- batch editor one-form-per-row rendering, blank/manual values, section defaults, per-row validation, live totals, and disabled submit until all rows are valid;
- `ExtractionReview` selecting batch versus single editor correctly;
- automatic **Accept** remaining absent;
- the affected five-row BOQ card rendering **Add 5 BOQ items**;
- browser QA for a complete five-row save, updated total, accepted history, reload idempotency, catalog **Exclude**, mobile usability, and strict approval blocking.

## Rollout

No stored proposal migration is required. Existing pending multi-row no-draft proposals are interpreted by source-row count at render and transaction time, so the affected BOQ receives the batch editor after reload.
