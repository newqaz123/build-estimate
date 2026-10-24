# BuildEstimate review — 24 October 2026

**Question:** Can a construction consultant understand what the app does and finish its three jobs — check a vendor quote, compare prices, and build an estimate?

**Method:** Playwright pass at 1280×800 and 390×844 on a temporary dev server (started directly because Portly is not installed), plus code inspection. Signed in with a dev-only password override. No BOQs, estimates, or settings were changed. Screenshots: `/tmp/buildestimate-ux-2026-10-24/`. The only console errors came from the dev server disconnecting after it was stopped.

## Summary

Checking a quote is the strongest part: the source PDF sits beside the lines, and missed rows are reviewed with safe actions. The two jobs after that are where the app stops short. Compare does not compare vendors, and an estimate cannot be reliably saved or reopened. Several numbers on the first screen are wrong, which costs trust before anything else.

## 1. Numbers people see first are wrong

| Where | What happens | Evidence |
|---|---|---|
| Dashboard “Total Items” | Shows 11. It adds up only the five newest quotes. | `dashboard/page.tsx:46` fetches `/api/boqs?limit=5`; line 97 sums that list |
| Dashboard trends | “+12 this month”, “+847 this month”, “+5 this month”, “+3 this week” are hardcoded. | `dashboard/page.tsx:107-131` |
| Dashboard “Vendors” | Shows 0, although every quote names a vendor. Settings → Vendors is empty and not linked to quotes. | Settings screen: “No vendors yet” |
| Compare “Provisional material” | Shows “—” with no explanation. | Compare screen |

## 2. Estimates cannot be trusted or found again

Open since the 8 September review.

- **Save creates a new estimate every time.** The page POSTs on every save (`estimator/page.tsx:396`), and the route always makes a new ID. Only the newest estimate loads (`:195`). There is no list, so older estimates cannot be opened.
- **The server trusts totals from the browser.** `api/estimates/route.ts:45` adds up `item.total` as sent. It does not recompute quantity × rate.
- **A checked quote cannot become an estimate.** The estimator adds lines from the catalog, by hand, or from AI. It has no way to bring in lines from an approved vendor quote.

## 3. “Compare” does not compare vendors

The page is titled “Compare Quotations”, but it checks one quote against the catalog (“One vendor BOQ at a time”). Its list repeats the BOQ list. There is no view that puts two vendors’ prices for the same work side by side. That comparison is the usual reason a consultant collects several quotes.

This is a missing feature and needs its own spec. The plain-language spec only makes the page describe what it does today.

## 4. Messy lists make the app look unreliable

- **Duplicate quotes.** Concrete Curb NaOCL Tank, RECYCLE 2B BS2, and ON-OFF VALVE each appear twice. Uploading again creates a new quote. There is no revision label or duplicate warning, so a person cannot tell which copy is current.
- **Untitled quotes.** Four rows show “Untitled BOQ”. One of them is **approved** with “Unknown Vendor”, so approval does not require a project or vendor name.
- **Test data in Settings.** Units include “dasd”, “test add unit”, “plt2 a”, and “Add from boq detail”.
- **Catalog review is one line at a time.** It lists 26 unmatched lines with 0 suggestions. Duplicate quotes inflate that list.

## 5. Screens that do not explain themselves

Covered by [plain-language spec](../superpowers/specs/2026-10-24-plain-language-use-design.md) and [plan](../superpowers/plans/2026-10-24-plain-language-use.md): page purpose sentences, the blocked Approve reason, “InboxDone”, the catalog box covering Quantity, the PDF row label, and the phone layout.

Not covered yet:

- **Settings opens on developer configuration.** The first thing shown is the AI provider, model name, API key, and parser URL. Matching rules are raw JSON, and prompts are editable text. Vendors and units, which a consultant actually uses, come later. Split this into everyday workspace settings and an Advanced section.
- **Dashboard “Total Items”** should be added to Task 3 of the plan.

## 6. Scale and reliability

Open since the 8 September review.

- PDF only, one file at a time, 20 MB maximum. No Excel.
- Parsing runs inside the upload request, with a 180-second timeout.
- The BOQ list and catalog search read every quote on each request.
- One shared password. There are no named users, so nothing records who approved a quote.

## 7. Work at risk

- 73 modified and 5 untracked files. This includes today’s reviewed follow-up (14 test repairs, Reject gate, ESLint ignore) and a large older edit to `extraction-review.tsx` whose owner is unclear.
- `main` is 148 commits ahead of `origin` and has not been pushed.

## Recommended order

1. Commit today’s reviewed follow-up. Decide what to do with the older uncommitted work. Push.
2. Trust fixes: dashboard numbers, estimate save and reopen, server-side estimate totals, and an estimate list.
3. Run the plain-language plan, and add the Settings split.
4. Clean data: duplicate-quote warning with revisions, vendors linked to quotes, require project and vendor before approval, remove test units.
5. New spec: vendor-against-vendor comparison, and “use this quote in an estimate”.
6. Scale: Excel intake, background parsing, named accounts.
