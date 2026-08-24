# Extraction Suggestions Exception Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 14-card Extraction Suggestions stack with a one-decision exception inbox that defaults unpriced rows to Not an item and shows Add to BOQ only when the existing source-backed add gate already allows it.

**Architecture:** Pure projection helpers classify each pending proposal into one chip and a compact inbox row. `ExtractionReview` renders an Inbox / Done list with one open NOW row. Grouped unpriced dismiss calls the existing per-proposal skip POST sequentially. The page header reads the pending count through a callback. No new server resource. `actionableReview.stage` stays off.

**Tech Stack:** TypeScript, React Client Components, Next.js App Router, Node test runner via `tsx --test`, existing extraction-review skip/add endpoints, CSS.

**Spec:** `docs/superpowers/specs/2026-08-24-extraction-suggestions-exception-inbox-design.md`

## Global Constraints

- Do not enable `actionableReview.stage` (`focused` / `add_and_match` / `default`).
- Do not change `proposalCanBeAccepted`, `proposalCanBeReviewedAndAdded`, `proposalManualAddMode`, or skip/accept/add-source-item APIs.
- `needs_human_review` is never auto-accepted. AI never writes qty/rate/total.
- Overhead, profit, discount, subtotal, and payable never become Add-to-BOQ targets.
- Approved BOQs stay read-only. Unsaved draft edits still block structural mutations.
- PDF focus remains `{ page, table, row }` with empty cell geometry. No geometric cell highlight claim.
- Use strict RED → GREEN TDD. Observe the intended failure before implementing.
- Work directly on `main`. Preserve unrelated dirty edits. Stage only intended files/hunks. `page.tsx` / `page.test.ts` are often pre-dirty — stage via HEAD-style blob construction when the working tree has formatter drift.
- Never inspect, stage, or commit the customer quotation sample directory.
- New UI contract tests go in `src/components/extraction-inbox.test.ts` and `src/lib/boq-extraction-review-ui.test.ts`. Do **not** add tests to `src/components/extraction-review.test.ts`.
- The known 12 failures in `src/components/extraction-review.test.ts` may remain only if **count and test names** stay identical. Do not rename those tests. Update other *passing* source-string tests only when this work would newly break them.
- After every code task: focused tests, `npx tsc --noEmit`, `npm run check` (12 known failures unchanged), `graphify update .`, `git diff --check`.
- Remember: `npm test -- path/with/[id]/file.ts` matches zero files. `cd` into the literal directory and run `npx tsx --test page.test.ts`.

---

## File Structure

### New files

- `src/components/extraction-inbox.test.ts` — source-contract tests for inbox copy, list, actions, and grouped skip.

### Modified files

- `src/lib/boq-extraction-review-ui.ts` — chip, title, sentence, pending count, unpriced-group helpers.
- `src/lib/boq-extraction-review-ui.test.ts` — unit tests for those helpers.
- `src/components/extraction-review.tsx` — inbox / Done UI; default-collapsed details; gated Add; grouped skip.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — header **Missed rows · N** / **BOQ items**; count callback.
- `src/app/(authenticated)/boqs/[id]/page.test.ts` — header label contract.
- `src/app/globals.css` — restrained inbox styles.
- Passing tests in `src/components/extraction-review.test.ts` that assert old *passing* copy (only those that would newly fail). Leave the 12 known failing tests untouched.

Do **not** modify `src/components/actionable-extraction-review.tsx` in this plan.

---

### Task 1: Pure inbox projection

**Files:**

- Modify: `src/lib/boq-extraction-review-ui.ts`
- Test: `src/lib/boq-extraction-review-ui.test.ts`

**Interfaces:**

- Consumes: existing `proposalCanBeReviewedAndAdded`, `ValidatedProposal`, `ExtractionReviewSourceRow`.
- Produces:

```ts
export type InboxChip =
  | "quote_total"
  | "already_in_boq"
  | "missing_item"
  | "no_price"
  | "needs_a_look";

export const INBOX_CHIP_LABEL: Record<InboxChip, string> = {
  quote_total: "Quote total",
  already_in_boq: "Already in BOQ",
  missing_item: "Missing item",
  no_price: "No price",
  needs_a_look: "Needs a look",
};

export type InboxSourceRow = Pick<
  ExtractionReviewSourceRow,
  "sourceRowId" | "rawText" | "classification" | "page" | "table" | "row"
>;

export function firstInboxSentence(text: string, maxChars?: number): string;
export function isQuoteTotalProposal(
  proposal: Pick<ValidatedProposal, "explanation" | "sourceRowIds" | "sourceRowSuggestions">,
  sourceRows: readonly InboxSourceRow[],
): boolean;
export function inboxChipForProposal(
  proposal: Pick<
    ValidatedProposal,
    | "operation"
    | "reviewDraft"
    | "sourceRowIds"
    | "targetItemIds"
    | "stale"
    | "explanation"
    | "sourceRowSuggestions"
  >,
  status: "accepted" | "rejected" | "skipped" | "superseded" | "undone" | undefined,
  readOnly: boolean,
  sourceRows: readonly InboxSourceRow[],
): InboxChip;
export function inboxRowTitle(
  proposal: Pick<ValidatedProposal, "explanation" | "sourceRowIds">,
  sourceRows: readonly InboxSourceRow[],
): string;
export function inboxPendingCount(
  proposals: readonly Pick<ValidatedProposal, "id">[],
  statuses: Readonly<Record<string, { status?: string } | string | undefined>>,
): number;
export function unpricedInboxGroupIds(
  rows: readonly { id: string; chip: InboxChip }[],
): string[];
```

Chip precedence (spec clarification — **Quote total** and **Already in BOQ** beat **No price** so commercial/target rows are not mislabeled):

1. `quote_total`
2. `already_in_boq` when `targetItemIds.length > 0`
3. `missing_item` when `proposalCanBeReviewedAndAdded(proposal, status, readOnly)`
4. `no_price` when `operation === "needs_human_review"` or explanation/source text is unpriced
5. `needs_a_look`

`isQuoteTotalProposal` is true when any of:

- `sourceRowSuggestions` contains `reasonCode === "summary_or_tax"`;
- a backing row `classification === "total"`;
- explanation or backing `rawText` matches `/overhead|profit|discount|sub-?total|payable|grand total|amount in words|\bvat\b/i`.

`unpricedInboxGroupIds` returns ids whose chip is `no_price` or `quote_total`, and only when that set has length ≥ 2; otherwise `[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/boq-extraction-review-ui.test.ts` (reuse the existing `proposal()` fixture):

```ts
import {
  firstInboxSentence,
  inboxChipForProposal,
  inboxPendingCount,
  inboxRowTitle,
  unpricedInboxGroupIds,
} from "./boq-extraction-review-ui";

test("firstInboxSentence keeps the first sentence and caps length", () => {
  assert.equal(
    firstInboxSentence("No price on this row. Extra detail follows."),
    "No price on this row.",
  );
  assert.equal(firstInboxSentence("x".repeat(200)).length, 160);
});

test("inbox chips follow quote / target / add-gate / unpriced precedence", () => {
  const rows = [
    {
      sourceRowId: "row-1",
      rawText: "A.1 Concrete Curb",
      classification: "item" as const,
      page: 2,
      table: 1,
      row: 3,
    },
  ];
  const human = proposal({
    operation: "needs_human_review",
    targetItemIds: [],
    reviewDraft: undefined,
    explanation: "The row is an unpriced layer entry.",
  });
  assert.equal(inboxChipForProposal(human, undefined, false, rows), "no_price");

  assert.equal(
    inboxChipForProposal(
      proposal({
        operation: "needs_human_review",
        targetItemIds: [],
        reviewDraft: undefined,
        explanation: "Missing priced line.",
      }),
      undefined,
      false,
      rows,
    ),
    "missing_item",
  );

  assert.equal(
    inboxChipForProposal(
      { ...human, targetItemIds: ["item-1"] },
      undefined,
      false,
      rows,
    ),
    "already_in_boq",
  );

  assert.equal(
    inboxChipForProposal(
      proposal({
        operation: "needs_human_review",
        targetItemIds: [],
        explanation: "OVERHEAD & PROFIT commercial total.",
        sourceRowSuggestions: [
          {
            sourceRowId: "row-1",
            suggestedAction: "ignore",
            reasonCode: "summary_or_tax",
            reason: "summary",
            confidence: 0.9,
          },
        ],
      }),
      undefined,
      false,
      rows,
    ),
    "quote_total",
  );
});

test("inboxRowTitle prefers source rawText over the AI explanation", () => {
  assert.equal(
    inboxRowTitle(
      proposal({
        explanation: "The reviewed source row is an ordinary item label.",
        sourceRowIds: ["row-1"],
      }),
      [
        {
          sourceRowId: "row-1",
          rawText: "A.1 | Concrete Curb NaOCL Tank",
          classification: "item",
          page: 2,
          table: 1,
          row: 3,
        },
      ],
    ),
    "A.1 | Concrete Curb NaOCL Tank",
  );
});

test("inboxPendingCount counts only unresolved proposals", () => {
  assert.equal(
    inboxPendingCount(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      { b: { status: "skipped" }, c: "accepted" },
    ),
    1,
  );
});

test("unpricedInboxGroupIds requires two or more no-price or quote-total rows", () => {
  assert.deepEqual(
    unpricedInboxGroupIds([{ id: "a", chip: "no_price" }]),
    [],
  );
  assert.deepEqual(
    unpricedInboxGroupIds([
      { id: "a", chip: "no_price" },
      { id: "b", chip: "quote_total" },
      { id: "c", chip: "missing_item" },
    ]),
    ["a", "b"],
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts
```

Expected: FAIL — `inboxChipForProposal` is not exported.

- [ ] **Step 3: Implement the helpers** in `src/lib/boq-extraction-review-ui.ts`. Import `ExtractionReviewSourceRow` type only. Reuse `proposalCanBeReviewedAndAdded` for `missing_item`. Unpriced text detector: `/unpriced|incomplete pricing|no priced candidate|no numeric|lacks deterministic candidate/i`.

- [ ] **Step 4: Re-run the suite**

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-extraction-review-ui.ts src/lib/boq-extraction-review-ui.test.ts
git commit -m "feat: classify extraction leftovers into inbox chips"
```

---

### Task 2: Header becomes Missed rows · N

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx` (header button ~1356; `ExtractionReview` mount)
- Modify: `src/components/extraction-review.tsx` (new optional callback prop)
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Test: `src/components/extraction-inbox.test.ts` (create)

**Interfaces:**

- Consumes: `inboxPendingCount` from Task 1.
- Produces:

```ts
// ExtractionReviewProps
onInboxCountChange?: (count: number) => void;
```

Page state: `const [missedRowCount, setMissedRowCount] = useState(0)`.

Button copy:

```tsx
{rightPaneMode === "items" ? (
  <>
    <Sparkles aria-hidden="true" />
    {missedRowCount > 0 ? `Missed rows · ${missedRowCount}` : "Missed rows"}
  </>
) : (
  <>
    <FileSearch aria-hidden="true" />
    BOQ items
  </>
)}
```

`ExtractionReview` calls `onInboxCountChange?.(inboxPendingCount(review.proposals, statuses))` whenever `review` or `statuses` change. If there is no review yet, report `0`.

- [ ] **Step 1: Write failing tests**

`src/components/extraction-inbox.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const review = readFileSync(new URL("./extraction-review.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url),
  "utf8",
);

test("extraction review reports pending inbox count to the page", () => {
  assert.match(review, /onInboxCountChange\?/);
  assert.match(review, /inboxPendingCount\(/);
});

test("page header uses Missed rows and BOQ items", () => {
  assert.match(page, /Missed rows/);
  assert.match(page, /BOQ items/);
  assert.doesNotMatch(page, /Extraction Suggestions/);
});
```

In `page.test.ts`, change the existing header assertion:

```ts
assert.match(header, /Missed rows/);
assert.match(header, /BOQ items/);
assert.doesNotMatch(header, /Extraction Suggestions/);
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/components/extraction-inbox.test.ts
cd "src/app/(authenticated)/boqs/[id]" && npx tsx --test page.test.ts
```

Expected: FAIL — `Extraction Suggestions` still present; `onInboxCountChange` missing.

- [ ] **Step 3: Wire the callback and rename the button.** Do not restyle the inbox list yet.

- [ ] **Step 4: Re-run tests + `npx tsc --noEmit`.** Expected: PASS for the new/updated tests. Known 12 failures unchanged.

- [ ] **Step 5: Commit** (HEAD-style stage `page.tsx` / `page.test.ts` if they carry formatter drift).

```bash
git commit -m "feat: rename extraction suggestions to missed rows"
```

---

### Task 3: Inbox list and Done tab

**Files:**

- Modify: `src/components/extraction-review.tsx` (tabs + proposal list ~1282–1570)
- Modify: `src/app/globals.css`
- Test: `src/components/extraction-inbox.test.ts`

**Interfaces:**

- Consumes: `inboxChipForProposal`, `INBOX_CHIP_LABEL`, `inboxRowTitle`, `firstInboxSentence`, `unpricedInboxGroupIds`.
- Produces: one selected proposal id (`selectedInboxId` state, default first pending). Tabs labeled **Inbox** and **Done** (still `selectReviewTab` values `"needs-review"` | `"history"`).

List rules:

- Inbox tab renders compact buttons, not expanded `.extraction-proposal` cards.
- Selected row is labeled **NOW**; others sit under **NEXT**.
- Each row: title, `p.{page}`, chip label. No confidence %, no “0 targets”, no “0 items”, no “Compound-cell extraction” heading.
- Heading becomes **Missed rows**. Subtitle: `{N} source lines are not in this BOQ yet.` Empty: **No missed rows.**
- Open row shows first sentence of `explanation` (max 160). **Details** `<details>` wraps today’s evidence grid and is **closed by default**.
- Selecting a row calls existing `onNavigateToEvidence` with that row’s first source ref.
- Banner: do not show `selectExtractionReviewProgress().progressText` in the default view. If a status line remains, use `{resolved} of {total} leftovers cleared` where `total = proposals.length` and `resolved = total - pending`.

- [ ] **Step 1: Write failing tests** in `extraction-inbox.test.ts`:

```ts
test("inbox uses Inbox/Done labels and a compact NOW/NEXT list", () => {
  assert.match(review, />Inbox</);
  assert.match(review, />Done</);
  assert.match(review, /NOW/);
  assert.match(review, /NEXT/);
  assert.match(review, /Missed rows/);
  assert.doesNotMatch(review, /Compound-cell extraction/);
  assert.match(review, /source lines are not in this BOQ yet/);
});

test("proposal evidence grid is behind a closed Details disclosure", () => {
  assert.match(review, /<details/);
  assert.match(review, />Details</);
  assert.doesNotMatch(review, /Hide evidence/);
});
```

Update any *passing* `extraction-review.test.ts` that still requires `Needs your review` / `Hide evidence` / `Compound-cell` **only if that test currently passes**. Do not edit the 12 known failing tests.

- [ ] **Step 2: Run**

```bash
npm test -- src/components/extraction-inbox.test.ts
```

Expected: FAIL on missing Inbox/NOW markup.

- [ ] **Step 3: Implement the list.** Keep `executeAction`, `submitSourceBackedItem`, and editors mounted only in Task 4; for this task the open row may still show the old action row so skip/add keep working.

- [ ] **Step 4: Add CSS** under existing review tokens:

```css
.extraction-inbox { display: grid; gap: var(--space-2); }
.extraction-inbox-item { display: grid; gap: 2px; width: 100%; text-align: left; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
.extraction-inbox-item.is-now { border-color: color-mix(in oklab, var(--accent) 40%, var(--border)); }
.extraction-inbox-meta { color: var(--muted-text); font-size: 11px; }
@media (max-width: 480px) {
  .extraction-inbox-item { min-height: 44px; }
}
```

No new overflow-x hidden. No gradient cards.

- [ ] **Step 5: Re-run focused tests + `tsc` + `npm run check`.** Confirm the 12 known failure **names** are unchanged.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: render extraction leftovers as an inbox list"
```

---

### Task 4: Actions — Not an item, gated Add, grouped skip

**Files:**

- Modify: `src/components/extraction-review.tsx` (open-row actions + `skipUnpricedGroup`)
- Test: `src/components/extraction-inbox.test.ts`

**Interfaces:**

- Consumes: existing `executeAction(proposal, "skip")` and `proposalCanBeReviewedAndAdded` / `proposalManualAddMode`.
- Produces: `skipUnpricedGroup()` that skips only ids from `unpricedInboxGroupIds`. Sequential existing POSTs. Stop on first failure. Do not invent a batch skip API.

Open-row actions:

| Chip | Controls |
|---|---|
| `missing_item` | **Show on PDF**, **Not an item**, **Add to BOQ** (existing editor) |
| `no_price` / `quote_total` | **Show on PDF**, **Not an item**. No editor. Copy: `This source line has no usable price. Mark it as not an item, or type numbers only if you can see them on the PDF.` |
| `already_in_boq` | **Show on PDF**, **Not an item**. No Add. |
| `needs_a_look` | **Show on PDF**, **Not an item**. Add only if `proposalCanBeReviewedAndAdded`. |

**Show on PDF** is the existing evidence navigation (today’s “Review source” / `onNavigateToEvidence`). It must not fetch AI.

**Add to BOQ** is the existing Review & add submit label. Do not render a control whose visible text is `Review & add` or `Skip`.

**Recheck with AI** (was “Review all flagged rows with AI”) is outline/secondary in the inbox header. Per-row “Review this row with AI” moves inside **Details**.

When `unpricedInboxGroupIds` is non-empty, render:

```tsx
<button type="button" data-od-id="inbox-mark-unpriced">
  Mark all as not items
</button>
```

Toast after grouped skip: `{n} source labels marked as not items` or the existing single-skip toast if `n === 1`.

- [ ] **Step 1: Write failing tests**

```ts
test("Add to BOQ is gated by proposalCanBeReviewedAndAdded and Skip is labeled Not an item", () => {
  assert.match(review, /Add to BOQ/);
  assert.match(review, /Not an item/);
  assert.match(review, /Mark all as not items/);
  assert.match(review, /unpricedInboxGroupIds/);
  assert.match(review, /This source line has no usable price/);
  assert.doesNotMatch(review, />Skip</);
  assert.doesNotMatch(review, /Review & add/);
});

test("grouped not-an-item uses sequential existing skip posts", () => {
  assert.match(review, /executeAction\([^,]+,\s*"skip"\)/);
  assert.doesNotMatch(review, /skip-batch/);
});
```

Update passing tests that require the literal `Review & add` / `>Skip<` **only if they currently pass**. Leave known failures alone.

- [ ] **Step 2: Run** — expected FAIL on new copy.

- [ ] **Step 3: Implement actions.** Keep Accept on `proposalCanBeAccepted` rows (validated high-confidence) with existing Accept/Reject. Those rows are rare in the 14-card document.

- [ ] **Step 4: Re-run inbox tests, `boq-extraction-review-ui.test.ts`, page tests, `tsc`, `npm run check`.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: gate inbox add and group unpriced dismissals"
```

---

### Task 5: Empty states, mobile pane, verification

**Files:**

- Modify: `src/components/extraction-review.tsx` (empty copy, `inboxPane` for ≤480px)
- Modify: `src/app/globals.css`
- Test: `src/components/extraction-inbox.test.ts`
- Create only if QA runs: `.superpowers/sdd/2026-08-24-extraction-inbox/browser-qa-report.md` (gitignored unless force-added; do not force-add unless asked)

**Interfaces:**

- Mobile: `const [inboxPane, setInboxPane] = useState<"list" | "detail">("list")`. Selecting a row sets `"detail"`. A **Back to list** control sets `"list"`. CSS:

```css
@media (max-width: 480px) {
  .extraction-inbox[data-pane="list"] .extraction-inbox-detail { display: none; }
  .extraction-inbox[data-pane="detail"] .extraction-inbox-list { display: none; }
}
```

Empty inbox: **No missed rows.** `Every leftover source line is marked not an item or already represented.`

- [ ] **Step 1: Write failing tests** asserting `data-pane`, `Back to list`, and the empty copy.

- [ ] **Step 2: Run** — expected FAIL.

- [ ] **Step 3: Implement empty + mobile pane.**

- [ ] **Step 4: Verify**

```bash
npm test -- src/lib/boq-extraction-review-ui.test.ts src/components/extraction-inbox.test.ts
cd "src/app/(authenticated)/boqs/[id]" && npx tsx --test page.test.ts
npx tsc --noEmit
npm run check
graphify update .
git diff --check
```

Confirm exactly 12 failures, same names as Task 3 of source-quote-summary (`extraction-review.test.ts`).

Browser QA (sanitized fixtures only; record BLOCKED if auth/fixtures missing):

1. Missed rows opens one NOW row + compact NEXT — not 14 expanded cards.
2. Unpriced NOW row: Not an item visible, Add to BOQ absent.
3. Show on PDF moves the existing row marker.
4. Mark all as not items drops N.
5. Add-eligible row still mounts the source-backed editor and does not auto-submit.
6. 1280×800 and 390×844: no horizontal overflow.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: finish missed-rows inbox empty and mobile states"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| §5 rename Missed rows / BOQ items | 2 |
| §6 layout PDF left, inbox right | 3 (existing split unchanged) |
| §7.1–7.2 chips + titles | 1 |
| §7.3 open row + Details | 3, 4 |
| §7.4 grouped unpriced dismiss | 4 |
| §7.5 Done | 3 |
| §8 header / empty / banner / Recheck | 2, 3, 4, 5 |
| §9 preserved APIs | all (no API edits) |
| §10 copy table | 3, 4 |
| §11 files | this plan |
| §12 tests + known 12 | each task + Task 5 gate |
| §13 no stage rollout | Global Constraints |
| Quote-total never addable | 1, 4 |

## Placeholder scan

No TBD/TODO. Types and function names are defined in Task 1 and reused later. Grouped skip is sequential existing POSTs, not a new endpoint.
