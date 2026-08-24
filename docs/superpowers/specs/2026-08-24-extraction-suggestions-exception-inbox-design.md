# Extraction Suggestions Exception Inbox — Design

**Date:** 2026-08-24

**Status:** Draft for review

**Scope:** Replace the right-pane Extraction Suggestions card stack with a one-decision-at-a-time exception inbox. Reuse existing proposal, skip, source-backed add, and PDF-focus contracts. Do not change AI authority, quote-summary rules, or catalog approval.

## 1. Problem

On a typical reviewed BOQ (example: `a743f8a7-36a0-4bd1-b544-0a5fd50ba6e7`), **Extraction Suggestions** swaps the whole right column for the legacy `ExtractionReview` list.

That surface currently shows:

- a heading **Compound-cell extraction**;
- a banner such as `14 of 14 candidate rows reviewed · 0 pending`;
- tabs **Needs your review** / **History**;
- **14 full proposal cards**, all `needs_human_review`.

Each card repeats the same chrome: confidence, a long AI explanation, Hide evidence, original source, current BOQ structure (often `0 targets`), proposed structure (often `0 items`), **Review & add**, **Skip**, and **Review this row with AI**.

Most of those 14 rows are **unpriced headers or layer labels**. The system already knows it cannot invent a price, but it still presents them as work. The reviewer cannot tell what to do next.

A later focused queue (`ActionableExtractionReview`) exists in code but is **off** (`actionableReview.stage` defaults to `off`). This spec does not turn that stage on. It redesigns the pane the reviewer actually opens today. If focused review is enabled later, it must use this same inbox chrome.

## 2. Goals

1. Show leftovers as a short inbox, not a stack of novels.
2. Make the default action for unpriced rows **Not an item**.
3. Show **Add to BOQ** only when the existing source-backed add gate passes.
4. Keep the source PDF on the left; one **Show on PDF** control highlights the selected row.
5. Rename the header control so the count is the job: **Missed rows · N**.
6. Preserve every existing safety rule: no automatic add, no invented numbers, no quote-summary items, no catalog create on add.

## 3. Non-goals

- Enabling `actionableReview.stage` (`focused` / `add_and_match` / `default`).
- Changing `proposalCanBeAccepted`, `proposalCanBeReviewedAndAdded`, or skip/accept APIs.
- Letting AI write quantities, rates, or totals.
- Putting overhead, profit, or discount into the BOQ from this pane.
- Redesigning Edit & Verify, Compare Catalog, or catalog match/exclude.
- Geometric cell highlight in the PDF (page + accessible row marker only, as today).
- Keyboard-first power-user shortcuts in v1 (may follow).

## 4. Research used

Reliable HITL extraction UIs (AWS A2I/Textract review, Rossum-style invoice queues, exception-based takeoff) share four rules:

1. Queue **exceptions**, not every extracted row.
2. Keep **one source document** visible; do not reprint it inside every card.
3. One open record, compact list of the rest.
4. Actions name the outcome: keep / discard / edit — not “review the suggestion.”

Construction takeoff products treat AI as a draft. Estimators clear disagreements. Headers, notes, and commercial totals are not priced items.

## 5. Approved direction

**Exception inbox.** Same proposals and same server decisions. New layout and copy.

| Current | Inbox |
|---|---|
| Extraction Suggestions | **Missed rows · N** |
| BOQ Items | **BOQ items** |
| Needs your review | Inbox (default) |
| History | **Done** |
| Review & add | **Add to BOQ** (only if eligible) |
| Skip | **Not an item** |
| Review this row with AI | Overflow only |
| Compound-cell extraction | Removed as a heading |
| Confidence % on every card | Hidden unless the open row is addable |

`N` is the count of **unresolved** inbox rows (pending, not skipped/accepted/rejected/stale). When `N` is 0 the button still exists, with no count or with `0`.

## 6. Layout

The workspace split does not change: PDF left, review right. Opening Missed rows still replaces the items table in the right pane. It does **not** add a third column.

```
[ Edit & Verify | Compare ]   [Missed rows · 14] [Save] [Approve]

┌──────── PDF ────────┐  ┌──────── Missed rows ────────┐
│ page 2, row marker  │  │ 14 left · unpriced grouped  │
│                     │  │                             │
│                     │  │ NOW                         │
│                     │  │ Concrete Curb NaOCL Tank    │
│                     │  │ No price — cannot add       │
│                     │  │ [Show on PDF] [Not an item] │
│                     │  │                             │
│                     │  │ NEXT                        │
│                     │  │ 12 unpriced source labels   │
│                     │  │ [Mark all as not items]     │
│                     │  │ Dam Cancrete 0.10×0.20m     │
└─────────────────────┘  └─────────────────────────────┘
```

At `390px` the right pane shows one layer at a time: list → open row. Back returns to the list. PDF remains available through **Show on PDF** (existing viewer).

## 7. Inbox model

Every current pending proposal that today appears under **Needs your review** becomes an inbox row. No new proposal type.

### 7.1 Row projection

Each row shows:

- source description (first backing source row text, else proposal explanation first clause);
- compact location `p.{page}` (table/row stay in the open detail / PDF marker);
- one reason chip from §7.2;
- selection state.

Do not show confidence, operation enum, “0 targets”, or “0 items” in the list.

### 7.2 Reason chips

Assign exactly one chip, first match wins:

| Chip | When |
|---|---|
| **No price** | `needs_human_review` and `proposalCanBeReviewedAndAdded` is false, or explanation/validation says unpriced / incomplete pricing / no numeric evidence |
| **Missing item** | `proposalCanBeReviewedAndAdded` is true |
| **Already in BOQ** | proposal has `targetItemIds.length > 0` |
| **Quote total** | source row is overhead, profit, discount, subtotal, or payable (must not be added; treat like **No price**) |
| **Needs a look** | anything else still pending |

**Add to BOQ** renders only for **Missing item**.

**Not an item** renders for every pending row.

**Already in BOQ** rows offer **Not an item** (skip) only. They must not create a duplicate add.

### 7.3 Open row

Selecting a row:

1. marks it **NOW**;
2. calls the existing `onNavigateToEvidence` with that row’s source ref;
3. shows the short reason in one sentence (existing `explanation`, trimmed to the first sentence, max ~160 characters);
4. shows actions from §7.2.

The open **Missing item** row mounts the existing source-backed editor (`SourceBackedItemEditor` or batch editor via `proposalManualAddMode`). Label the submit control **Add to BOQ**. Keep Accept disabled for `needs_human_review`.

The open **No price** / **Quote total** row does **not** mount the add editor. Copy:

> This source line has no usable price. Mark it as not an item, or type numbers only if you can see them on the PDF.

No “Review & add” control in that state.

Collapsed evidence (original cell dump, current structure, proposed structure) stays behind a **Details** disclosure, closed by default.

### 7.4 Grouped unpriced dismiss

When two or more pending rows share chip **No price** or **Quote total**, the list may show one group:

```
12 source labels with no price
[Mark all as not items]
```

That control skips each grouped proposal with the existing skip endpoint, one atomic batch if a batch skip already exists, otherwise sequential existing skips. It must not skip **Missing item** rows.

This is the action that turns the current 14-card document into a short inbox.

### 7.5 Done

**Done** lists skipped, accepted, rejected, and undone proposals (today’s History set). Each skipped row can be restored with the existing undo/restore path if one exists; if undo is not available for skip, say so in the empty restore slot rather than inventing a new API in v1.

## 8. Header and empty states

### 8.1 Header control

| Right pane | Button label | Icon |
|---|---|---|
| Items table visible | `Missed rows · {N}` if N > 0, else `Missed rows` | keep Sparkles |
| Inbox visible | `BOQ items` | keep FileSearch |

`aria-controls` stays on the two existing panel ids.

### 8.2 Inbox header

- Title: **Missed rows**
- Subtitle: `{N} source lines are not in this BOQ yet.`
- When N = 0: **No missed rows.** `Every leftover source line is marked not an item or already represented.`
- Secondary: **Recheck with AI** (today’s “Review all flagged rows with AI”), outline, not primary.
- **Accept all validated high-confidence** remains available only when `proposalCanBeAccepted` rows exist. It is never shown as a way to bulk-add `needs_human_review`.

### 8.3 Banner

Remove or demote the contradictory `14 of 14 candidate rows reviewed · 0 pending` line from the default view. Progress, if shown, is `{resolved} of {total} leftovers cleared`.

## 9. Behavior preserved

- `needs_human_review` cannot be auto-accepted.
- Source-backed add still posts the existing single/batch payload union.
- Skip still records `skipped` and keeps source evidence.
- Approved BOQs stay read-only.
- Unsaved draft edits still block structural extraction mutations.
- Quote summary amounts never become inbox add targets.
- PDF focus remains `{ page, table, row }` with empty cell geometry.

## 10. Copy rules

Write for the construction consultant, not the parser.

| Do not use in the default view | Use instead |
|---|---|
| Compound-cell extraction | Missed rows |
| Extraction Suggestions | Missed rows |
| Needs human review | No price / Missing item |
| Validated suggestion | (only on Accept-eligible rows) |
| Review & add | Add to BOQ |
| Skip | Not an item |
| Review this row with AI | Recheck this line (details only) |
| Current BOQ structure / Proposed structure | Details |

Do not mention conversion rules, fingerprints, or immutable evidence in the inbox list.

## 11. Components and files (expected)

No new server resource. Likely presentation changes:

- `src/components/extraction-review.tsx` — list → inbox; default-collapsed details; grouped unpriced skip.
- `src/lib/boq-extraction-review-ui.ts` — row chip helper + inbox count helper (pure, tested).
- `src/app/(authenticated)/boqs/[id]/page.tsx` — button label **Missed rows · N**.
- `src/app/globals.css` — restrained inbox styles inside the existing review tokens (no new card gradient).
- Tests beside those files, plus page source tests for the new label.

`ActionableExtractionReview` is out of v1 unless a later task enables the rollout stage; that task must then reuse the chip/copy/inbox rules in this spec.

## 12. Testing

### 12.1 Automated

- Chip assignment: unpriced `needs_human_review` → **No price** and no Add; add-eligible → **Missing item** and Add; targeted proposal → **Already in BOQ** and no Add.
- Inbox count `N` equals pending proposals only.
- Grouped **Mark all as not items** skips only **No price** / **Quote total** rows.
- Page header uses **Missed rows** / **BOQ items**; it no longer requires the exact string `Extraction Suggestions` except in a migration note in old docs.
- Existing skip, source-backed add, session-expiry, and stale-proposal tests stay green.
- `npm run check` may retain the known 12 unrelated `extraction-review.test.ts` UI failures **only if** their names and count stay identical. New inbox tests must not be added to that failing suite in a way that hides the baseline.

### 12.2 Browser QA

Sanitized fixture only. Never the customer quotation sample directory.

1. Open Missed rows: one NOW row, compact NEXT list, no 14 expanded cards.
2. Unpriced row: **Not an item** visible, **Add to BOQ** absent.
3. **Show on PDF** moves the existing row marker.
4. Grouped mark-all clears the unpriced group; N drops.
5. Add-eligible row still opens the source-backed editor and does not auto-submit.
6. `1280×800` and `390×844`: no horizontal overflow; mobile uses list → detail.

## 13. Rollout

Ship as a visual/interaction change of the existing extraction pane. No settings flag required: this pane is already the default when `actionableReview.stage === off`.

Do not silently rewrite stored proposals. Existing skipped/accepted history appears under **Done**.

## 14. Success

A reviewer opening Missed rows on the example BOQ can:

1. see why Approve is unrelated to these 14 cards (catalog is a different job);
2. mark the unpriced labels as not items in one grouped action;
3. add at most the rows that actually have (or can be given) a price;
4. return to BOQ items without reading 14 repeated evidence grids.
