# Plain-language use — Design

**Date:** 2026-10-24

**Status:** Draft for review

**Scope:** Make the existing BuildEstimate screens say, in plain words, what the app does and what to do next. Fix only the layout bugs that hide those words. Do not add a new workflow.

## 1. Intent

A construction consultant should understand the product in one minute, and should never have to guess why a button is dead or what a number means.

The product already does three jobs: check a vendor quote, compare prices, and build an estimate. The screens exist. They fail because they use shorthand, show numbers that are not real, and sometimes cover the control the person needs.

Chosen approach: **plain words on the screens already built.** A first-visit wizard and a single combined work screen were rejected. A wizard adds steps for someone who will use this every day. A combined screen throws away pages that already match the three jobs.

## 2. The sentence

On the sign-in page, under the product name, show this and nothing longer:

> Check vendor quotes. Compare prices. Build your estimate.

This is the product sentence. Page sentences below are shorter reminders of the same three jobs. Do not invent a second slogan.

## 3. Goals

1. Every main page says, in one sentence under the title, what this page is for.
2. A blocked action says why it is blocked and names the next thing to do.
3. Numbers on screen are real. If a number cannot be calculated, do not show a fake one.
4. The words needed to finish a task are visible. They are not covered by a menu, clipped by the sidebar, or glued into the next word.
5. A person can still do the same jobs as today: upload a quote, check lines, compare vendors, and build an estimate.

## 4. Non-goals

- No first-run wizard, coach marks, or product tour.
- No new pages, routes, or navigation items.
- No change to skip, accept, reject, or add-to-BOQ server rules.
- No change to AI authority. AI still does not write quantity, rate, or total.
- Do not turn on `actionableReview.stage`.
- Do not translate Thai text that came from a source PDF.
- Do not claim the PDF viewer can draw a box around a source row. It only knows page, table, and row numbers.

## 5. Anti-goals

- A screen that sounds friendly but hides the money difference.
- An Approve button that looks available when the quote still does not add up.
- A green “success” trend that is hardcoded.
- Renaming BOQ, Catalog, or Estimator into clever marketing words. Those are the words this user already uses. Explain them; do not replace them.

## 6. Constraints

- Next.js App Router client screens and `src/app/globals.css`. Read the installed Next.js guide before editing framework code. This work should not need a framework change.
- Keep the current visual system: navy sidebar, existing buttons, badges, and type.
- Tests stay in the repo’s `node:test` style. Do not add a Playwright test runner to the repo for this work.
- Preserve unrelated uncommitted edits. Stage only the files this work changes.
- Dev servers, when needed, go through Portly. If Portly is not installed, do not start a second long-running server unless the operator says so.

## 7. Approaches considered

| Approach | What it trades |
|---|---|
| Plain words on current screens | Smallest change. Keeps the three jobs separate. Does not teach by walking someone through a demo. **Chosen.** |
| First-visit guide | Easier once, then in the way every later visit. |
| One combined work screen | Clearest map, but replaces the pages already built. |

## 8. Page sentences

Show each sentence once, directly under the page title, in the existing muted text style. Do not repeat it in the sidebar.

| Page | Sentence |
|---|---|
| Sign in | Check vendor quotes. Compare prices. Build your estimate. |
| Dashboard | Start with a quote that still needs a check. |
| Bills of Quantities | Each row is one vendor quote. Open it to check the lines. |
| BOQ detail | Check this vendor’s lines against the source PDF. |
| Compare | See how this quote’s prices compare with your catalog. |
| Catalog | Your standard descriptions and prices, used when a quote line matches. |
| Estimator | Build the price you will send. |
| Settings | People, vendors, and the rules for this workspace. |

Sidebar labels stay: Dashboard, BOQs, Compare, Catalog, Estimator, Settings. The sign-out control must show the full words “Sign out”. Do not clip them.

## 9. Honest numbers

### Dashboard

Remove the four trend lines (`+12 this month`, `+847 this month`, `+5 this month`, `+3 this week`). They are hardcoded. Do not replace them with another invented delta.

Replace the two Quick Stats that always show “—” (`Comparison Match Rate`, `Data Coverage`) with counts the page already has:

- **Quotes still in draft:** count of loaded BOQs whose status is not approved.
- **Estimates started:** the same estimate count already shown in the top card.

If a project or vendor name is empty, show “Untitled quote” or “Unknown vendor”. Do not show a blank title. Each activity row opens that quote. Today the row is not a link.

### BOQ list

The standardization column already has a count (`matched/total`) and a color dot. The count is clipped off the right edge at a normal desktop width. Show the words “3 of 7 matched” and keep Actions on screen without a horizontal scroll at 1280px. A color dot alone is not the label.

Empty project or vendor uses the same “Untitled quote” / “Unknown vendor” words.

## 10. A blocked Approve button

When Approve is disabled, keep the reason the page already chose. Do not calculate a new pair of totals.

- If the selected reason is a quote-summary issue (`quote_direct_total_mismatch`, `quote_subtotal_mismatch`, or `quote_payable_total_mismatch`), rewrite that issue’s existing message in plain words. Keep its amounts and its layer: direct work, subtotal, or payable. Mention overhead and profit only when that existing message already names it.
- If the selected reason is the legacy document mismatch, rewrite `documentTotalMismatchMessage` in plain words. The amounts stay source total, checked-line total, and the difference. Do not call that difference overhead.
- For the other existing disabled reasons, use these words:
  - unsaved edits: “Save this quote before approving.”
  - invalid component costs: “Fix the highlighted costs before approving.”
  - an update in progress: “Wait for the current save to finish.”

The warning has one action when the reason is a total mismatch: **See what’s missing.** It opens the existing missed-rows review. It does not approve, skip, or change money. The other reasons use the action named in the sentence. Do not enable Approve.

## 11. Missed-rows review

The two tabs must look like two choices. Today they render as the single word “InboxDone”.

- Labels: **To check** and **Done**.
- The selected tab has the existing active-tab treatment and a visible gap from the other tab.
- The open decision is shown once, in the detail card.
- Other waiting rows are labeled **Next**, not a second copy of the open title.
- Keep the header control **Missed rows · N**.
- Keep the current actions and their current gates: Show on PDF, Add to BOQ, Not an item, Accept, Reject. Do not add a new action.
- Replace “2 of 17 leftovers cleared” with “2 of 17 lines checked”. Do not say “leftovers”.

## 12. PDF focus

**Show on PDF** may change the page and must say, outside the page image:

> Source row · table 1 · row 3

If the focused row is on another page, say “Source row is on page 2” and do not cover the current page with that label. The label sits in the toolbar row, not over the PDF canvas. Do not draw a box on the page.

## 13. Estimator

Under the page sentence, the item list has column headings: **Description**, **Qty**, **Rate**, **Total**.

The New Item dialog:

- Catalog suggestions stay inside the dialog. They must not cover Quantity, Unit price, Unit, or the buttons, and they must not be clipped.
- After a catalog match, the confirmation is in normal document flow above the quantity fields: “Using the catalog item 1B BS1.” It does not overlap the quantity.
- If the matched item has no approved price, the rate field stays editable and the hint says “No saved price yet. Enter the rate.” Do not leave a silent ฿0 with no explanation.
- The chat button must not cover the estimated total or the last item row. Place it above the total bar.

## 14. Compare and Catalog

No new comparison math. The page sentence is the change, plus any control whose label is only an icon gets a visible word (not only a tooltip).

Catalog keeps its current search and edit behavior. The page sentence is the change.

## 15. What the builder decides

- Exact CSS, as long as it uses the existing tokens and the words above stay visible at 1280px and 390px.
- Whether the page sentence is a `<p>` or an existing muted class.
- How to wrap the BOQ table so Actions stay visible. Stacking the project and vendor is allowed. Removing a column is not.
- The component that renders the Approve warning, as long as the words and the one action match this spec.

## 16. Acceptance

A reviewer who has not seen the code can check these in the running app:

1. Sign in shows the product sentence.
2. Each page in the table in section 8 shows its sentence once.
3. Dashboard has no “+12 this month” or other hardcoded trend.
4. An activity row with a missing project says “Untitled quote” and opens the quote.
5. At 1280px, the BOQ table shows “N of M matched” and the Actions control without horizontal scrolling.
6. “Sign out” is fully visible.
7. A blocked Approve button shows a plain-language rewrite of the reason the page already selected, with the same amounts. A total mismatch offers **See what’s missing** and opens missed rows.
8. Missed rows shows **To check** and **Done** as separate tabs. The open row title appears once.
9. Show on PDF shows the table/row label outside the page image.
10. In New Item, searching “1B” shows suggestions without covering Quantity. Choosing one shows the catalog confirmation without covering Quantity.
11. Estimator column headings are visible.
12. No server rule, route, or AI numeric authority changed.

Focused `node:test` coverage must fail if the product sentence, the Approve warning, the tab labels, or the dialog confirmation are absent. A manual look at 1280px and 390px is required for the overlap and clipping checks. Do not claim those from a source-string test alone.

## 17. Calls made after review

These were not chosen by the operator. They are fixed here so the words match the screens.

- Compare already compares one quote with catalog prices. The page sentence says that. It does not promise a vendor-against-vendor comparison, because that screen does not do it.
- The Approve warning does not invent a vendor-total versus line-item story. It rewrites the blocking message the approval gate already selected.

## 18. Out of scope for the first build

- Rewriting dashboard analytics for real month-over-month trends.
- Highlighting a geometric PDF cell.
- Mobile sidebar redesign beyond keeping “Sign out” and the page sentence readable. If the 390px sidebar still covers the page title, collapse it by default at that width. That is allowed. A new navigation pattern is not.
