# Plain-language Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing screens say what BuildEstimate does and what to do next, without adding a workflow.

**Architecture:** One pure copy module owns the product sentence, page sentences, empty names, and the plain Approve warning. Pages render those values. Layout fixes stay in the screen that hides the words. No server, route, or money calculation changes.

**Tech Stack:** TypeScript, React client components, Next.js App Router, `node:test` via `tsx --test`, existing CSS tokens in `src/app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-10-24-plain-language-use-design.md`

## Global Constraints

- Product sentence, exact: `Check vendor quotes. Compare prices. Build your estimate.`
- Page sentences are the exact table in spec section 8, including the corrected Compare sentence: `See how this quote’s prices compare with your catalog.`
- Do not rename sidebar labels or routes. Do not add a wizard, tour, page, or navigation item.
- Do not change skip, accept, reject, add-to-BOQ, or AI numeric authority. Do not enable `actionableReview.stage`.
- Do not recompute approval totals. Rewrite the message the page already selected.
- Do not call a legacy document mismatch overhead. Mention overhead only when the existing quote-summary message already names it.
- Do not draw a PDF row box. Do not translate source-PDF text.
- Remove hardcoded dashboard trends. Do not invent replacement deltas.
- Preserve unrelated dirty edits. Stage only files this task changes.
- Tests are `node:test`. Overlap and clipping also need a manual look at 1280px and 390px.
- A path containing `[id]` must be tested by changing into that directory and running `npx tsx --test <file>`.

## Review Focus

- An empty project name must show `Untitled quote`, not a blank activity or table cell. Task 1 pins the helper; Task 3 and Task 4 render it.
- A legacy document mismatch must not gain the words “overhead” or “profit”. Task 1 pins the rewriter.
- A quote-subtotal message that already says “overhead and profit” must keep that phrase and its amounts. Task 1 pins it.
- Unsaved edits must say `Save this quote before approving.` and must not offer **See what’s missing**. Task 5 pins it.
- The Compare sentence must not say vendors are compared with each other. Task 2 pins it.

---

### Task 1: Copy module

**Files:**
- Create: `src/lib/plain-language.ts`
- Test: `src/lib/plain-language.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PRODUCT_SENTENCE: string`
  - `PAGE_SENTENCE: { dashboard, boqs, boqDetail, compare, catalog, estimator, settings }`
  - `displayQuoteName(project: string | null | undefined): string`
  - `displayVendorName(vendor: string | null | undefined): string`
  - `plainApprovalBlock(input: { code?: string; existingMessage: string | null; busy: "approving" | "updating" | null; invalidCosts: boolean; pendingChanges: boolean }): { text: string; action: "see-missing" | "save" | "fix-costs" | "wait" | "none" }`

- [ ] **Step 1: Write the failing test**

Assert the exact product sentence and all seven page sentences. Assert blank project and vendor become `Untitled quote` and `Unknown vendor`, while a real name passes through.

Assert `plainApprovalBlock` for:

- code `document_total_mismatch` and message `Source total ฿215,280.00; BOQ items ฿179,400.00; difference ฿35,880.00.` returns text `Cannot approve yet. The vendor total is ฿215,280.00. The checked lines add up to ฿179,400.00. ฿35,880.00 is not in those lines.` and action `see-missing`. The text does not contain `overhead`.
- code `quote_subtotal_mismatch` and a message containing `overhead and profit` and `฿35,880.00` keeps both and uses action `see-missing`.
- `pendingChanges: true` returns `Save this quote before approving.` and action `save`.
- `invalidCosts: true` returns `Fix the highlighted costs before approving.` and action `fix-costs`.
- `busy: "updating"` returns `Wait for the current save to finish.` and action `wait`.

- [ ] **Step 2: Run the test and confirm it fails because the module does not exist**

Run: `npx tsx --test src/lib/plain-language.test.ts`

- [ ] **Step 3: Implement the module**

Use the exact strings from the test. For a mismatch, prefix `Cannot approve yet.` and keep every `฿` amount from `existingMessage` in order. Do not parse or calculate new amounts. Busy, invalid costs, and pending changes win over a mismatch, in that order.

- [ ] **Step 4: Run the test and confirm it passes**

- [ ] **Step 5: Commit only the two new files**

```bash
git add src/lib/plain-language.ts src/lib/plain-language.test.ts
git commit -m "feat: add plain-language copy for the existing screens"
```

### Task 2: Page sentences

**Files:**
- Modify: `src/app/(public)/page.tsx`
- Modify: `src/app/(authenticated)/dashboard/page.tsx`
- Modify: `src/app/(authenticated)/boqs/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/compare/page.tsx`
- Modify: `src/app/(authenticated)/catalog/page.tsx`
- Modify: `src/app/(authenticated)/estimator/page.tsx`
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Test: the existing page test next to each file, or `src/lib/plain-language.test.ts` plus one source-contract test per page if that page has no test

**Interfaces:**
- Consumes: `PRODUCT_SENTENCE`, `PAGE_SENTENCE`
- Produces: one visible sentence under each page title

- [ ] **Step 1: Write failing source-contract tests**

Each test reads the page source and asserts it renders the exact sentence from `PAGE_SENTENCE` once. The sign-in test asserts `PRODUCT_SENTENCE`. The Compare test asserts the catalog sentence and `doesNotMatch` `/which vendor is higher/`.

- [ ] **Step 2: Run those tests and confirm they fail**

- [ ] **Step 3: Render each sentence once, under the existing title, in the current muted text style**

Do not add the sentence to the sidebar. On Compare and Catalog, give any icon-only control a visible word. Do not change its action.

- [ ] **Step 4: Run the focused tests and confirm they pass**

- [ ] **Step 5: Commit only the sentence files**

### Task 3: Honest dashboard

**Files:**
- Modify: `src/app/(authenticated)/dashboard/page.tsx`
- Test: `src/app/(authenticated)/dashboard/page.tsx` source contract, or the nearest dashboard test

**Interfaces:**
- Consumes: `displayQuoteName`, `displayVendorName`
- Produces: no hardcoded trend; draft and estimate counts; activity links

- [ ] **Step 1: Write a failing test**

Assert the dashboard source does not contain `+12 this month`, `+847 this month`, `+5 this month`, or `+3 this week`. Assert it does not contain `Comparison Match Rate` or `Data Coverage`. Assert it links each activity row to its quote and uses `displayQuoteName`.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Remove the trend lines and the two empty Quick Stats**

Show **Quotes still in draft** from loaded BOQs whose status is not `approved`, and **Estimates started** from the existing estimate count. Make each activity row a link to `/boqs/${id}`.

- [ ] **Step 4: Run the focused test and confirm it passes**

- [ ] **Step 5: Commit only the dashboard files**

### Task 4: BOQ list stays readable

**Files:**
- Modify: `src/app/(authenticated)/boqs/page.tsx`
- Modify: `src/app/globals.css`
- Test: the BOQ list test if present; otherwise a source-contract test beside `page.tsx`

**Interfaces:**
- Consumes: `displayQuoteName`, `displayVendorName`
- Produces: visible `N of M matched` and Actions at 1280px

- [ ] **Step 1: Write a failing test**

Assert the standardization cell renders `` `${matched} of ${total} matched` `` and the source uses `displayQuoteName(boq.project)`.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Replace the bare dot count with those words**

Allow the project and vendor to wrap. Do not remove a column. Adjust the table CSS so Actions fit at 1280px without horizontal scrolling.

- [ ] **Step 4: Run the focused test**

- [ ] **Step 5: Commit only these files**

### Task 5: Plain blocked approval

**Files:**
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`

**Interfaces:**
- Consumes: `plainApprovalBlock`
- Produces: the warning and **See what’s missing** only for mismatch actions

- [ ] **Step 1: Write a failing test**

Assert the detail page calls `plainApprovalBlock` with the existing selected message and code. Assert action `see-missing` renders `See what’s missing` and opens the existing missed-rows control. Assert action `save` does not render that button.

- [ ] **Step 2: Run it from the `[id]` directory and confirm failure**

- [ ] **Step 3: Replace the raw blocker string with `plainApprovalBlock(...).text`**

Wire the one action from the returned `action`. Do not enable Approve and do not calculate totals.

- [ ] **Step 4: Run the detail test and confirm it passes**

- [ ] **Step 5: Commit only the detail files**

### Task 6: Two obvious review tabs

**Files:**
- Modify: `src/components/extraction-review.tsx`
- Test: `src/components/extraction-inbox.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: tab labels `To check` and `Done`

- [ ] **Step 1: Write a failing test**

Assert the source contains `>To check<` and `>Done<`, contains `Next`, and does not contain `leftovers cleared`. Assert the open row title is not also rendered as the NOW list title.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Split the tabs visually and use the new labels**

Keep **Missed rows · N**, the current action gates, and the selected-tab styling. Label the other waiting rows **Next**.

- [ ] **Step 4: Run the inbox test and confirm it passes**

- [ ] **Step 5: Commit only these files**

### Task 7: PDF label outside the page

**Files:**
- Modify: `src/components/pdf-review-viewer.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/pdf-review-viewer.test.ts`

**Interfaces:**
- Consumes: existing `evidenceFocus`
- Produces: the existing status text in the toolbar, not over the canvas

- [ ] **Step 1: Write a failing test**

Assert the status element is outside the canvas viewport element and the CSS does not position `.pdf-evidence-focus` over the canvas. Assert the two existing sentences remain: `Source row · table` and `Source row is on page`.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Move the status into the toolbar row**

Do not add a page box.

- [ ] **Step 4: Run the viewer test and confirm it passes**

- [ ] **Step 5: Commit only these files**

### Task 8: Estimator can be read and filled

**Files:**
- Modify: `src/app/(authenticated)/estimator/page.tsx`
- Modify: `src/app/globals.css`
- Test: `src/app/(authenticated)/estimator/estimator-page.test.ts`

**Interfaces:**
- Consumes: `PAGE_SENTENCE.estimator`
- Produces: column headings and an in-flow catalog confirmation

- [ ] **Step 1: Write a failing test**

Assert headings `Description`, `Qty`, `Rate`, and `Total`. Assert the selected-catalog confirmation is not inside `.desc-suggest` and the source contains `No saved price yet. Enter the rate.` Assert the chat button is not positioned over the total bar.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Add the headings and move the confirmation into normal flow**

Keep suggestions inside the dialog without covering Quantity or the buttons. Keep the rate editable when there is no saved price.

- [ ] **Step 4: Run the estimator test and confirm it passes**

- [ ] **Step 5: Commit only these files**

### Task 9: Sign out and narrow width

**Files:**
- Modify: `src/components/sidebar.tsx`
- Modify: `src/app/globals.css`
- Test: a source-contract test beside the sidebar, or the app-shell test if one exists

**Interfaces:**
- Consumes: nothing
- Produces: full `Sign out` text; sidebar collapsed by default at 390px

- [ ] **Step 1: Write a failing test**

Assert the sign-out control text is `Sign out` and is not clipped by a fixed narrow footer. Assert a `max-width: 390px` rule collapses the sidebar.

- [ ] **Step 2: Run it and confirm failure**

- [ ] **Step 3: Make the label fully visible and collapse the sidebar at 390px**

Do not invent a new navigation pattern.

- [ ] **Step 4: Run the focused test**

- [ ] **Step 5: Run `npx tsc --noEmit` and `npm test`**

Expected: TypeScript passes. The full suite passes except any failures already present before this plan. Record those names if any remain.

- [ ] **Step 6: Manual check at 1280px and 390px**

Check spec acceptance items 5, 6, 9, 10, and 11 by eye. Do not claim them from source tests alone.

- [ ] **Step 7: Commit only the sidebar and CSS files**
