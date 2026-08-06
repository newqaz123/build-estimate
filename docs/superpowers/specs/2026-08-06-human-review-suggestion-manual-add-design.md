# Human-review suggestion manual add

## Problem

The extraction reviewer can return a valid `needs_human_review` proposal without a `reviewDraft`. This happens when the provider can identify a relevant source row but cannot safely map enough immutable cells into a complete BOQ item.

The current UI disables **Accept**, correctly, but only renders **Review & add** when `proposal.reviewDraft` exists. A direct `needs_human_review` proposal therefore leaves **Skip** as the only action even when a user can read the source evidence and enter the missing line accurately.

This dead end contributes to BOQs whose normalized line-item total is far below the source quotation total. For BOQ `e262c286-8815-4617-9b96-ebd2734ed450`, the source total is ฿478,000 while the current BOQ items total ฿80,584.

Catalog reuse and BOQ completeness are separate concerns. A line must exist in the BOQ to represent the quotation, but it does not need to become a reusable catalog entry.

## Goals

- Give source-backed, missing-item `needs_human_review` proposals a **Review & add** path even when no `reviewDraft` exists.
- Keep **Accept** disabled for `needs_human_review`; user entry remains an explicit manual correction.
- Preserve immutable extraction-run source row IDs and PDF references on the added BOQ item.
- Reuse the existing source-backed editor, request schema, transactional lifecycle, and audit trail.
- Keep source-total reconciliation as an approval blocker until the BOQ items genuinely reconcile.
- Show the exact source total, current BOQ total, and difference when approval is blocked by `document_total_mismatch`.
- Keep the existing catalog action wording **Exclude** unchanged.

## Non-goals

- Automatically accepting ambiguous AI output.
- Allowing the provider to author financial values.
- Weakening or bypassing source-total reconciliation.
- Automatically creating catalog entries from manually added BOQ lines.
- Renaming **Exclude** or changing catalog matching semantics.
- Implementing manual replacement of an existing target item from a target-based `needs_human_review` proposal.
- Migrating or rewriting existing BOQs.

## Decisions

### BOQ storage and catalog storage remain separate

Every quotation line needed for reconciliation is stored in the BOQ. Catalog storage remains optional. After a user adds a missing BOQ line, the existing catalog workflow may match it, create a reusable entry, or mark it **Exclude**. An excluded catalog match still remains a priced BOQ line and contributes to the BOQ total.

### Automatic acceptance remains strict

`needs_human_review` is never treated as an actionable acceptance operation. The UI does not enable **Accept**, and the proposal acceptance API does not change.

The new path is **Review & add**, which records values as user-authored corrections. AI confidence does not authorize insertion.

### Only missing-item proposals get the fallback add action

A pending proposal qualifies for fallback manual insertion when:

- `operation === "needs_human_review"`;
- `targetItemIds.length === 0`;
- source row IDs are present and still belong to the immutable extraction run;
- the proposal is not stale, skipped, rejected, accepted, undone, or superseded; and
- the BOQ is not approved.

A human-review proposal that targets an existing BOQ item is not converted into an add operation because doing so could create a duplicate. Existing review drafts continue using their current behavior.

## User experience

### Extraction suggestion card

For a qualifying direct `needs_human_review` proposal, the footer shows:

- **Review & add** as the primary available action;
- **Skip** as the secondary action; and
- the existing disabled-acceptance explanation so users understand why automatic acceptance is unavailable.

The card’s source evidence remains visible while the editor is open.

### Manual editor

The existing `SourceBackedItemEditor` supports two initialization modes:

1. **Mapped review draft** — retain current source-backed prefills and source/missing badges.
2. **Evidence-only proposal** — initialize editable priced fields blank because the server has no safe cell mapping. Default the destination section by matching the first selected source row’s section label to a BOQ section header; otherwise use the first BOQ section.

Evidence-only mode must not present blank fields as AI-derived or source-mapped. The user enters and confirms:

- description;
- unit;
- quantity;
- material cost;
- labour cost; and
- destination section.

The existing live total, finite-number, non-negative, cents-precision, non-empty description/unit, and positive-quantity validation remains authoritative.

After saving:

- the item appears in the BOQ with `entryOrigin: "user"`;
- the proposal lifecycle becomes accepted;
- the BOQ total updates immediately;
- the suggestion moves to history using the existing status flow; and
- catalog status follows the existing unmatched workflow, where the user may later match, create, or **Exclude** it.

### Approval blocker detail

When local verification contains `document_total_mismatch`, the approval area shows a specific message using current BOQ data:

- source quotation total;
- normalized BOQ item total; and
- absolute difference.

For the affected BOQ, this reads equivalently to:

`Source total ฿478,000.00; BOQ items ฿80,584.00; difference ฿397,416.00.`

The existing generic blocker summary may remain for other blocking issue types. Approval stays disabled until the mismatch is resolved.

## Client architecture

### Review action eligibility

Add a focused helper in the extraction review UI domain, for example:

```ts
proposalCanBeReviewedAndAdded(proposal, status, readOnly): boolean
```

It returns true for an existing `reviewDraft` under current rules or for a pending evidence-only missing-item `needs_human_review` proposal. The helper must reject target-based proposals, stale proposals, terminal lifecycle states, and read-only BOQs.

`ExtractionReview` uses the helper to render **Review & add** rather than checking only `proposal.reviewDraft`.

### Editor input

`SourceBackedItemEditor` accepts the proposal plus the proposal’s selected `ExtractionReviewSourceRow[]`. Its initial-form helper treats `reviewDraft` as optional:

- with a draft, preserve the current prefilled values and source badges;
- without a draft, return blank editable values and a safe default section;
- never infer financial values from `rawText` or from the provider explanation.

This keeps model-authored narrative outside the persisted financial boundary.

## Server architecture

The existing endpoint remains:

`POST /api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item`

The request schema remains `SourceBackedItemRequest`; no client-provided source provenance is accepted.

Inside `BoqExtractionProposalStore.addSourceItem`:

1. Preserve all current authentication, path, immutable-context, lifecycle, approved-BOQ, idempotency, and request validation.
2. If `proposal.reviewDraft` exists, preserve the current reconstruction path exactly.
3. If no `reviewDraft` exists, require a missing-item `needs_human_review` proposal with no targets.
4. Resolve every proposal source row ID against `immutable.sourceRows` inside the transaction.
5. Reject missing, changed, or out-of-scope source rows.
6. Build server-owned provenance from those immutable rows: all source row IDs plus the first stable PDF source reference. Do not claim source cost mappings when none exist.
7. Pass the user-entered priced values and server-owned provenance to `addSourceBackedBoqItem`.
8. Recalculate totals, persist the BOQ, advance the proposal lifecycle, and write the existing manual-entry audit.

The audit keeps `proposedItems: []`. When no `reviewDraft` existed, the audit omits it and the resulting BOQ diff records the user-authored values. This accurately distinguishes source association from source-mapped financial fields.

## Error handling and safety

- Direct `needs_human_review` proposals with target items return a conflict rather than inserting a duplicate.
- Missing immutable source rows return a conflict requiring the user to refresh or rerun extraction.
- Approved BOQs remain read-only.
- Terminal proposal lifecycle states remain non-mutable and idempotent accepted requests retain current behavior.
- Server validation rejects invalid descriptions, units, quantities, costs, or section indexes.
- Client prefills never use provider-authored explanation text as financial data.
- The source-total approval guard remains unchanged; manually adding lines only removes the blocker when totals actually reconcile.

## Testing

Test-first coverage must include:

- UI eligibility for a pending no-target `needs_human_review` proposal without `reviewDraft`;
- no fallback add action for target-based human-review proposals;
- no action for stale, terminal, approved, or read-only states;
- evidence-only editor initialization with blank priced fields and section matching;
- existing mapped-review-draft prefills remaining unchanged;
- API/store insertion from immutable source rows when `reviewDraft` is absent;
- preservation of all source row IDs and PDF source reference;
- audit output omitting `reviewDraft` while recording the user-authored BOQ diff;
- rejection of target-based, stale-evidence, approved-BOQ, and terminal-lifecycle attempts;
- idempotent retry behavior;
- exact source-total mismatch copy and values;
- no changes to catalog **Exclude** wording or behavior; and
- the existing extraction review, source-backed editor, proposal-store, BOQ page, TypeScript, and full project checks.

## Rollout

This is a code-only change. Existing stored proposals do not require migration because eligibility is computed from their current operation, target IDs, lifecycle state, and immutable extraction rows. Reloading an existing BOQ exposes **Review & add** for qualifying pending suggestions immediately.
