# Unified BOQ Review and Catalog Comparison Workspace — Design

**Date:** 2026-08-03
**Status:** Approved visual direction; ready for implementation planning after written-spec review
**Visual source:** Open Design project `BuildEstimate Compare Component UI`, artifact `unified-boq-workspace-concepts.html`
**Scope:** Make catalog comparison available immediately after parsing, preserve the existing reviewed extraction UI, and turn `/compare` into a one-vendor Comparison Inbox.

## 1. Goal

A newly uploaded vendor BOQ should become useful as soon as Docling finishes parsing. Users must be able to:

1. correct extraction mistakes against the source PDF;
2. inspect a provisional BOQ-to-catalog comparison before approval;
3. resolve catalog matching only in the existing review interface; and
4. approve only after all review and matching blockers are resolved.

Approval finalizes and locks the BOQ. It does not unlock comparison.

## 2. Locked product decisions

1. **Direction A: Comparison Inbox.** `/compare` is a focused entry page for recent single-vendor BOQs, not a multi-vendor bid matrix and not a second editing surface.
2. **One canonical BOQ workspace.** Full review and comparison live at `/boqs/[id]`.
3. **Two primary tabs.** The BOQ workspace exposes `Review Extraction` and `Compare Catalog`.
4. **Review UI is locked.** The existing side-by-side PDF, metadata, extraction notes, editable parsed-items table, catalog column, warnings, readiness, save, and approval controls are preserved. The feature adds a tab shell around this UI; it does not redesign it.
5. **No progress rail.** The approved revision explicitly removes `Parse → Review → Compare → Finalize` from the workspace.
6. **Comparison is provisional and read-only.** `Compare Catalog` is available after parsing for draft BOQs. It displays comparison results but contains no Match, Create, Exclude, AI, Dismiss, or Change-match actions.
7. **Matching stays in Review Extraction.** All catalog mutation actions remain exclusively in the existing Review Extraction item table.
8. **Existing BOQs opened from `/compare` default to Compare Catalog.** A newly uploaded BOQ defaults to Review Extraction.
9. **Approval stays in the workspace.** Successful approval updates the current BOQ to finalized/read-only without automatically navigating away. `Back to Compare` remains explicit navigation.
10. **Single vendor only.** Multi-vendor bidding and BOQ-to-BOQ comparison remain out of scope.

## 3. Current state

- `/compare` currently loads the full comparison only when `selected.status === "approved"`.
- Drafts show a preparation card that sends the user to BOQ Details.
- `/boqs/[id]` already provides the reviewed side-by-side PDF and editable BOQ interface.
- Catalog matching already exists in the Review Extraction item table through `useInlineCatalogMatching`, `CatalogMatchModal`, and exclusion actions.
- `GET /api/boqs/[id]/comparison` already accepts draft BOQs; the approval-only restriction is in the `/compare` client UI.
- `compareBoqToCatalog()` already excludes the target BOQ from its benchmark and builds history from approved BOQs, so provisional comparison does not contaminate catalog history.
- `BoqCatalogComponentTable` already renders material/labour rows, historical ranges, variance, composition percentages, lump sums, and no-history states. Its current action column must become optional for the read-only workspace view.

## 4. Information architecture

### 4.1 `/compare` — Comparison Inbox

`/compare` becomes the entry and triage page for one vendor BOQ at a time.

The page contains:

- `Upload BOQ` primary action;
- recent BOQ list, newest first;
- BOQ identity: project, vendor, date, status, and total;
- parse state and line count;
- extraction issue count;
- catalog readiness: resolved/total and unmatched count;
- a selected-BOQ provisional snapshot containing material variance, labour variance, component coverage, and BOQ total;
- `Open comparison` primary action for the selected BOQ;
- `Review issues` secondary action when extraction or matching issues exist.

The list does not render the full comparison table. It selects a BOQ, lazily loads its existing comparison endpoint, and shows only the summary snapshot.

Navigation:

- `Open comparison` → `/boqs/[id]?view=compare&returnTo=<validated /compare?boq=[id]>`
- `Review issues` → `/boqs/[id]?view=review&returnTo=<validated /compare?boq=[id]>`
- successful upload → `/boqs/[id]?view=review&returnTo=<validated /compare?boq=[id]>`

### 4.2 `/boqs/[id]` — Unified BOQ Workspace

The existing BOQ header remains, followed by the two primary tabs:

- `Review Extraction` with an issue-count badge;
- `Compare Catalog` with an unmatched-count badge.

The current split-pane workspace remains beneath the tabs.

Desktop:

- left pane: source PDF, unchanged in both tabs;
- right pane: existing Review Extraction UI or read-only Compare Catalog UI.

Approved BOQs display both tabs read-only. The Compare tab changes its label from `Provisional` to `Finalized`.

## 5. URL and navigation contract

Introduce a narrow workspace-view contract:

```ts
export type BoqWorkspaceView = "review" | "compare"
```

Rules:

- `/boqs/[id]` defaults to `review` for backward compatibility.
- `view=review` and `view=compare` are the only accepted values.
- Invalid values canonicalize to `review` without discarding a valid `returnTo`.
- Switching tabs uses `router.replace(..., { scroll: false })` and preserves validated `returnTo`.
- `safeCompareReturnPath` remains strict and unchanged in security behavior: only internal `/compare` or `/compare?boq=<single opaque id>` values are accepted.
- Opaque BOQ IDs remain URL-encoded through `URLSearchParams` or `encodeURIComponent`.
- Successful approval does not consume `returnTo`; the explicit Back control uses it.

Suggested helper boundary:

```ts
boqWorkspaceHref(id, view, returnTo?)
safeBoqWorkspaceView(value)
```

## 6. Tab behavior

### 6.1 Review Extraction

The rendered content is the existing reviewed interface. No visual or functional redesign is in scope.

It retains:

- PDF viewer and evidence navigation;
- metadata and confidence labels;
- extraction warnings and extraction-review mode;
- editable parsed items;
- Add missing item and delete/undo;
- workspace units;
- catalog suggestion, Match, AI, Dismiss, Create new, Change, Include, and Exclude actions;
- catalog readiness;
- verification warnings and blockers;
- Save draft and Approve BOQ.

### 6.2 Compare Catalog

The tab loads the existing comparison API for both draft and approved BOQs.

It renders:

- `Provisional` banner for drafts;
- `Finalized` banner for approved BOQs;
- material weighted variance;
- labour weighted variance;
- component-line coverage;
- BOQ total;
- yesterday’s approved material/labour split-row comparison table;
- matched/unmatched/no-history status;
- line totals and material/labour composition percentages.

It does **not** render mutation controls. The Action column is hidden. Unresolved rows display status only, such as `Unmatched` or `Needs review`.

A single informational affordance may switch the user back to `Review Extraction`; it must not perform matching from the Compare tab.

## 7. Saved-state and refresh behavior

Comparison must never silently represent unsaved edits as canonical data.

- Opening Compare with no pending changes fetches the current canonical comparison.
- Saving edits, applying extraction corrections, matching, creating, excluding, including, or deleting marks comparison data stale.
- The next Compare-tab activation refetches comparison.
- If Compare is already active after a canonical mutation, it refetches after the mutation succeeds.
- If Review contains unsaved edits, Compare remains accessible but shows `Save draft to refresh this comparison` and continues to represent the last saved BOQ.
- A `Save and refresh` action may call the existing save path and then reload comparison. This is not a catalog-matching action.
- Failed comparison reloads keep the last successful comparison visible when available and show a retry message. They do not discard Review edits or navigate away.

## 8. Component boundaries

### 8.1 Comparison Inbox

A focused `/compare` page owns:

- BOQ list loading and selection;
- selected BOQ query synchronization;
- readiness summary;
- selected comparison-summary loading;
- upload flow;
- links into the canonical workspace.

It no longer owns `CatalogMatchModal` or catalog mutation callbacks.

### 8.2 BOQ workspace tab shell

The BOQ page owns:

- safe view parsing and URL canonicalization;
- tab state;
- comparison loading/invalidation state;
- current BOQ mutation state;
- approval/finalization state.

The existing Review Extraction subtree remains intact.

### 8.3 Read-only comparison presentation

Refactor the current comparison table behind an explicit read-only boundary. Acceptable implementation shapes are:

- `BoqCatalogComponentTable` with an explicit `mode: "read-only" | "matching"`; or
- a shared table core plus separate read-only and matching wrappers.

For this feature, the workspace always uses read-only mode. The component must not infer mutability from a missing callback; the mode should be explicit and testable.

## 9. Data flow

```text
Upload PDF
  → Docling parse/import
  → canonical BOQ draft saved
  → /boqs/[id]?view=review

Review Extraction
  → edit/save/correct/match/exclude
  → canonical BOQ mutation succeeds
  → mark comparison stale

Compare Catalog
  → GET /api/boqs/[id]/comparison
  → compare target draft against active catalog + approved historical BOQs
  → render provisional read-only summary and component table

Approve BOQ
  → existing client guards
  → existing server verification/catalog-readiness guards
  → status becomes approved
  → stay in workspace
  → both tabs become finalized/read-only
```

No production migration is required.

## 10. Approval and integrity

Approval remains guarded by:

- no active mutation;
- no invalid component drafts;
- no unsaved changes;
- no blocking extraction/verification issues;
- catalog readiness when required.

The server remains authoritative. Existing approved-BOQ mutation guards, including the catalog-match API conflict response, must remain intact.

Approval does not create the comparison. It:

- marks the BOQ approved;
- locks Review mutations;
- changes comparison state from provisional to finalized;
- contributes the BOQ to future historical catalog benchmarks.

## 11. Loading, empty, and error states

### Comparison Inbox

- BOQ loading skeleton/status;
- empty state with `Upload BOQ`;
- list-load error with retry;
- selected-summary loading without blocking the BOQ list;
- selected-summary error with retry and no data mutation;
- missing/stale `?boq=` selection falls back through the existing selection resolver.

### Compare Catalog tab

- comparison loading state confined to the right pane;
- no priced lines: explain that parsed priced items are required;
- no historical benchmark: `No prior approved rates`;
- unmatched line: `Needs review` status only;
- missing PDF: comparison expands without fabricating a source preview;
- API failure: preserve Review tab and canonical BOQ state; offer retry;
- stale due to unsaved edits: visible saved-state warning.

## 12. Responsive behavior

Desktop preserves the current 50/50-style review workspace proportions unless existing responsive CSS specifies otherwise.

Mobile:

- primary tabs remain visible and horizontally safe;
- one panel is shown at a time using the existing `PDF / Data` control pattern;
- Review Extraction uses the existing mobile behavior;
- Compare Catalog uses yesterday’s stacked component cards;
- summary metrics use a two-column grid;
- no matching mutation controls appear in Compare cards;
- tab selection and PDF/Data selection are keyboard and screen-reader accessible.

## 13. Accessibility

- Tabs use `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and associated tab panels.
- Issue badges supplement labels; color is never the only signal.
- Provisional/finalized state is expressed in text.
- The comparison region remains keyboard-scrollable with an accessible label.
- Focus remains predictable after tab switching and comparison retry.
- Existing approval `aria-describedby` blocker behavior is preserved.
- Reduced-motion preferences are respected; no new decorative animation is required.

## 14. Testing strategy

### Route and URL helpers

- valid `view=review` and `view=compare`;
- invalid view canonicalization;
- preservation of strict validated `returnTo`;
- opaque BOQ IDs;
- tab switching preserves return navigation.

### `/compare`

- drafts and approved BOQs both appear;
- selected BOQ loads provisional summary without approval gating;
- existing BOQ `Open comparison` targets `view=compare`;
- upload completion targets `view=review`;
- Review issues targets `view=review`;
- full comparison table and `CatalogMatchModal` are absent;
- list, summary, empty, retry, and stale-query states.

### BOQ workspace

- direct URL defaults to Review;
- explicit Compare URL loads the comparison for a draft;
- existing Review subtree remains rendered and functional;
- Compare table is read-only and has no mutation actions/action column;
- tab badges reflect verification and catalog readiness;
- pending edits produce a stale comparison warning;
- successful canonical mutations invalidate/refetch comparison;
- comparison failure does not damage Review state;
- successful approval stays in the workspace and locks both tabs.

### Comparison presentation

- material/labour split rows;
- different units;
- material-only and labour-only lines;
- lump-sum fallback;
- no-history state;
- composition percentages;
- provisional versus finalized labels;
- desktop and mobile read-only rendering.

Run focused tests during implementation, then `npm run check` and `graphify update .`.

## 15. Scope

### In scope

- Direction A Comparison Inbox on `/compare`;
- selected-BOQ provisional summary;
- Review Extraction / Compare Catalog tabs on BOQ Details;
- draft comparison availability;
- read-only comparison table in BOQ Details;
- comparison invalidation/refetch after canonical saves and matches;
- in-place approval finalization;
- responsive and accessible tab behavior;
- tests for routes, state, rendering, and integrity.

### Out of scope

- redesigning Review Extraction;
- catalog mutation actions in Compare Catalog;
- progress rail;
- multi-vendor comparison or bidding;
- BOQ-to-BOQ comparison;
- inline editing in Compare Catalog;
- new catalog schemas or production migrations;
- automatic correction of Docling output without user review;
- persistence of per-component historical summaries beyond current computation.

## 16. Risks and mitigations

1. **Stale comparison after unsaved edits.** Show an explicit saved-state warning and only compute from canonical saved data.
2. **Large BOQ lists.** Lazy-load comparison only for the selected inbox row; do not fetch a full comparison for every BOQ.
3. **Large BOQ Details component.** Keep the new comparison loader and read-only presentation bounded; avoid unrelated page refactors.
4. **Accidental matching from Compare.** Enforce an explicit read-only table mode and test the absence of mutation controls.
5. **Regression to reviewed extraction UI.** Treat the Review subtree as locked; tests should assert that the existing controls and workflows remain present.
6. **Draft benchmark misunderstanding.** Label draft results `Provisional` and explain that only approved historical BOQs form the baseline.

## 17. Acceptance criteria

The feature is complete when:

1. a newly parsed BOQ opens Review Extraction without requiring approval;
2. the user can switch to Compare Catalog immediately;
3. the existing reviewed extraction UI remains unchanged;
4. comparison uses the saved draft and approved historical catalog data;
5. Compare Catalog contains no Match/Create/Exclude/AI/Dismiss controls;
6. matching actions remain available in Review Extraction;
7. existing BOQs opened from `/compare` land on Compare Catalog;
8. approval finalizes in place and locks the workspace;
9. `/compare` acts as a responsive Comparison Inbox rather than duplicating the full table; and
10. focused tests, the full project check, and Graphify update pass.
