# Unified BOQ Review and Catalog Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make catalog comparison available immediately after Docling parsing inside the canonical BOQ workspace, preserve the reviewed extraction UI, and turn `/compare` into a single-vendor Comparison Inbox.

**Architecture:** `/compare` becomes a lightweight BOQ selector and selected-summary surface. `/boqs/[id]` remains the only full workspace, with URL-addressable `Review Extraction` and `Compare Catalog` tabs sharing the existing PDF pane. The comparison tab consumes the existing draft-capable comparison API through a read-only presentation boundary; all catalog mutations remain in the existing Review Extraction table.

**Tech Stack:** Next.js 16.2 App Router, React 19.2, TypeScript, Node test runner through `tsx --test`, existing BuildEstimate CSS/design system, Open Design MCP, agent-browser.

## Global Constraints

- Use 2-space indentation for new or materially rewritten code.
- Use TDD: add a failing focused test, verify the intended failure, implement minimally, then rerun the focused test.
- Run `npm run check` after code changes and `graphify update .` after the final implementation.
- Do not run production migrations locally; this feature requires no migration.
- Never read, stage, or commit `Quotation example/`.
- Preserve strict `safeCompareReturnPath` validation and opaque BOQ IDs.
- Preserve the existing reviewed Review Extraction UI and behavior; do not redesign its PDF viewer, metadata, warnings, parsed-item table, catalog column, or approval controls.
- Do not add a progress rail.
- `Compare Catalog` is read-only: no Match, Create, Exclude, AI, Dismiss, or Change-match controls.
- Catalog mutations remain exclusively in Review Extraction.
- Draft comparison is available immediately after parsing; approval finalizes and locks but does not unlock comparison.
- Successful approval remains in the BOQ workspace; Back to Compare is explicit.
- `/compare` remains single-vendor-to-catalog only; no multi-vendor bidding UI.
- Read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` and `use-router.md` before changing route/query behavior. Keep the existing Suspense boundaries required by Next.js 16.
- The approved UX/UI source of truth is Open Design project `buildestimate-compare-component-ui-da54`, artifact `unified-boq-workspace-concepts.html`, Direction A with the later locked revisions: existing Review UI unchanged, no progress rail, read-only Compare tab.
- **UI workers must use Open Design MCP:** before modifying UI, call `open_design_get_artifact` for the approved artifact; during final QA, compare browser screenshots against that artifact and document any intentional differences.
- Preserve all pre-existing unstaged edits. Before each commit, verify the staged file list and stage only task-owned semantic changes. Never use `git add .`.

---

## Planned File Structure

### New files

- `src/components/boq-workspace-tabs.tsx` — accessible Review/Compare tab shell only.
- `src/components/boq-workspace-tabs.test.tsx` — server-rendered accessibility and badge contracts.
- `src/components/boq-catalog-comparison-panel.tsx` — read-only provisional/finalized comparison states and summary.
- `src/components/boq-catalog-comparison-panel.test.tsx` — presentation-state regression tests.

### Modified files

- `src/lib/boq-review-route.ts` — safe workspace-view parsing and URL construction.
- `src/lib/boq-review-route.test.ts` — strict route/view/return tests.
- `src/components/boq-catalog-component-table.tsx` — remove mutation/action rendering and make the component intrinsically read-only.
- `src/components/boq-catalog-component-table.test.tsx` — prove comparison rendering remains complete without mutation controls.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — integrate tabs, comparison lifecycle, invalidation, and in-place finalization while preserving Review content.
- `src/app/(authenticated)/boqs/[id]/page.test.ts` — workspace routing, read-only comparison, refresh, and approval contracts.
- `src/app/(authenticated)/compare/page.tsx` — replace full comparison/preparation modes with Comparison Inbox and selected summary.
- `src/app/(authenticated)/compare/compare-pricing-ui.test.ts` — Comparison Inbox and navigation contracts.
- `src/app/globals.css` — tab shell, inbox, read-only comparison panel, and responsive styles.

### Reused without schema changes

- `src/app/api/boqs/[id]/comparison/handler.ts` — already returns comparisons for draft and approved BOQs.
- `src/lib/boq-catalog-comparison.ts` — existing comparison computation.
- `src/components/review-workspace.tsx` — existing resizable PDF/data split.
- `src/components/unified-boq-items-table.tsx` — existing Review Extraction and catalog mutation surface.

### Execution preflight

Before Task 1 changes any file, record the exact implementation base and dirty-tree inventory in the gitignored SDD workspace:

```bash
mkdir -p .superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison
git rev-parse HEAD > .superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison/feature-base
git status --short > .superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison/pre-existing-status.txt
git diff --binary > .superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison/pre-existing-working-tree.patch
```

The patch is preservation evidence only. Do not apply, stage, or commit it unless the execution supervisor verifies that a pre-existing edit was lost.

---

### Task 1: Add the Safe Workspace View URL Contract

**Files:**

- Modify: `src/lib/boq-review-route.ts`
- Modify: `src/lib/boq-review-route.test.ts`

**Interfaces:**

- Produces: `type BoqWorkspaceView = "review" | "compare"`
- Produces: `safeBoqWorkspaceView(value: string | null | undefined): BoqWorkspaceView`
- Produces: `boqWorkspaceHref(id: string, view: BoqWorkspaceView, returnTo?: string | null): string`
- Preserves: `safeCompareReturnPath`, `compareBoqHref`, and opaque-ID encoding.

- [ ] **Step 1: Add failing route tests**

Add tests equivalent to:

```ts
import {
  boqWorkspaceHref,
  safeBoqWorkspaceView,
} from "./boq-review-route"

test("workspace view accepts only review and compare", () => {
  assert.equal(safeBoqWorkspaceView("review"), "review")
  assert.equal(safeBoqWorkspaceView("compare"), "compare")
  assert.equal(safeBoqWorkspaceView("javascript:alert(1)"), "review")
  assert.equal(safeBoqWorkspaceView(null), "review")
})

test("workspace href preserves only a validated compare return path", () => {
  assert.equal(
    boqWorkspaceHref("boq/id ?#", "compare", "/compare?boq=boq%2Fid+%3F%23"),
    "/boqs/boq%2Fid%20%3F%23?view=compare&returnTo=%2Fcompare%3Fboq%3Dboq%252Fid%2B%253F%2523",
  )
  assert.equal(
    boqWorkspaceHref("opaque", "review", "https://evil.example/compare"),
    "/boqs/opaque?view=review",
  )
})
```

Also retain and rerun all existing strict return-path tests.

- [ ] **Step 2: Verify the tests fail for missing exports**

Run:

```bash
npx tsx --test src/lib/boq-review-route.test.ts
```

Expected: FAIL because `boqWorkspaceHref` and `safeBoqWorkspaceView` do not exist.

- [ ] **Step 3: Implement the minimal helpers**

Use explicit accepted values and `URLSearchParams`:

```ts
export type BoqWorkspaceView = "review" | "compare"

export function safeBoqWorkspaceView(
  value: string | null | undefined,
): BoqWorkspaceView {
  return value === "compare" ? "compare" : "review"
}

export function boqWorkspaceHref(
  id: string,
  view: BoqWorkspaceView,
  returnTo?: string | null,
): string {
  const query = new URLSearchParams({ view })
  const safeReturnTo = safeCompareReturnPath(returnTo)
  if (safeReturnTo) query.set("returnTo", safeReturnTo)
  return `${boqDetailHref(id)}?${query.toString()}`
}
```

Do not loosen `safeCompareReturnPath` or accept arbitrary query keys.

- [ ] **Step 4: Rerun focused route tests**

Run:

```bash
npx tsx --test src/lib/boq-review-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only the route contract**

```bash
git add -p -- src/lib/boq-review-route.ts src/lib/boq-review-route.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(boq): add workspace view routes"
```

---

### Task 2: Make the Component Comparison Table Intrinsically Read-only

**Files:**

- Modify: `src/components/boq-catalog-component-table.tsx`
- Modify: `src/components/boq-catalog-component-table.test.tsx`

**Interfaces:**

- Produces: `BoqCatalogComponentTable({ rows }: { rows: BoqCatalogComparisonRow[] })`
- Removes: `onMatch` prop, `matchButton()`, action cells, Action header, and `compare-component-match` controls.
- Preserves: summary calculations, material/labour sub-rows, mobile labels, historical ranges, variance, lump sums, and composition percentages.

- [ ] **Step 1: Rewrite the focused tests to require read-only output**

Replace action-count assertions with explicit absence checks:

```ts
function renderTable(rows: BoqCatalogComparisonRow[]): string {
  return renderToStaticMarkup(
    createElement(BoqCatalogComponentTable, { rows }),
  )
}

test("comparison table is read-only", () => {
  const html = renderTable([row()])
  assert.doesNotMatch(html, /compare-component-match/)
  assert.doesNotMatch(html, /Change match|>Match</)
  assert.doesNotMatch(html, /data-label="Action"/)
  assert.doesNotMatch(html, /<th[^>]*>Action<\/th>/)
  assert.match(html, /Material/)
  assert.match(html, /Labour/)
  assert.match(html, /Line total ฿36,864/)
})
```

Update row/column-span assertions from eight columns to seven.

- [ ] **Step 2: Verify the read-only tests fail**

Run:

```bash
npx tsx --test src/components/boq-catalog-component-table.test.tsx
```

Expected: FAIL because action controls still render.

- [ ] **Step 3: Remove mutation rendering from the table**

Delete the matching callback from component props and all render helpers. Change the table header to:

```tsx
<thead>
  <tr>
    <th>BOQ item</th>
    <th>Component</th>
    <th className="num-col">Qty</th>
    <th>Unit</th>
    <th className="num-col">BOQ rate</th>
    <th className="num-col">Catalog average</th>
    <th>Variance</th>
  </tr>
</thead>
```

Keep unmatched/no-history information in candidate and benchmark text; do not add mutation links as replacements.

- [ ] **Step 4: Rerun component tests**

Run:

```bash
npx tsx --test src/components/boq-catalog-component-table.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the read-only boundary**

```bash
git add -p -- src/components/boq-catalog-component-table.tsx src/components/boq-catalog-component-table.test.tsx
git diff --cached --check
git commit -m "refactor(compare): make catalog table read only"
```

---

### Task 3: Build Accessible Workspace Tabs and Comparison Presentation

**Files:**

- Create: `src/components/boq-workspace-tabs.tsx`
- Create: `src/components/boq-workspace-tabs.test.tsx`
- Create: `src/components/boq-catalog-comparison-panel.tsx`
- Create: `src/components/boq-catalog-comparison-panel.test.tsx`

**Interfaces:**

- Consumes: `BoqWorkspaceView`, `BoqCatalogComparisonRow`, and `BoqCatalogComponentTable`.
- Produces: `BoqWorkspaceTabs` with explicit selected view, counts, and callbacks.
- Produces: `BoqCatalogComparisonPanel` with loading, loaded, stale, error, provisional, and finalized presentation states.

- [ ] **Step 1: Use Open Design before writing UI code**

The task worker must call:

```text
open_design_get_artifact(
  project="buildestimate-compare-component-ui-da54",
  entry="unified-boq-workspace-concepts.html",
  include="shallow"
)
```

Record in the task report that Direction A is used with these overrides: existing Review UI unchanged, no progress rail, and no mutation controls in Compare.

- [ ] **Step 2: Add failing tab accessibility tests**

Create server-rendered tests equivalent to:

```ts
const html = renderToStaticMarkup(
  <BoqWorkspaceTabs
    view="review"
    reviewIssueCount={3}
    unmatchedCount={5}
    onViewChange={() => undefined}
  />,
)

assert.match(html, /role="tablist"/)
assert.match(html, /role="tab"/)
assert.match(html, /aria-selected="true"/)
assert.match(html, /aria-controls="boq-review-panel"/)
assert.match(html, /Review Extraction/)
assert.match(html, /Compare Catalog/)
assert.match(html, />3</)
assert.match(html, />5</)
assert.doesNotMatch(html, /Parse.*Review.*Compare.*Finalize/)
```

- [ ] **Step 3: Add failing comparison-panel state tests**

Use a discriminated state prop:

```ts
export type BoqComparisonPanelState =
  | { status: "idle" | "loading"; rows: BoqCatalogComparisonRow[] }
  | { status: "loaded"; rows: BoqCatalogComparisonRow[] }
  | { status: "error"; rows: BoqCatalogComparisonRow[]; message: string }
```

Test:

```ts
assert.match(draftHtml, /Provisional/)
assert.match(approvedHtml, /Finalized/)
assert.match(staleHtml, /Save draft to refresh this comparison/)
assert.match(errorHtml, /Retry comparison/)
assert.doesNotMatch(draftHtml, /Match|Create|Exclude|Dismiss|AI/)
```

- [ ] **Step 4: Verify both new test files fail**

Run:

```bash
npx tsx --test \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 5: Implement `BoqWorkspaceTabs`**

Use buttons, not links, because the parent owns URL replacement:

```tsx
export function BoqWorkspaceTabs({
  view,
  reviewIssueCount,
  unmatchedCount,
  onViewChange,
}: {
  view: BoqWorkspaceView
  reviewIssueCount: number
  unmatchedCount: number
  onViewChange: (view: BoqWorkspaceView) => void
}) {
  return (
    <div className="boq-workspace-tabs" role="tablist" aria-label="BOQ workspace view">
      <button
        type="button"
        role="tab"
        aria-selected={view === "review"}
        aria-controls="boq-review-panel"
        id="boq-review-tab"
        onClick={() => onViewChange("review")}
      >
        Review Extraction
        {reviewIssueCount > 0 ? <span>{reviewIssueCount}</span> : null}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "compare"}
        aria-controls="boq-compare-panel"
        id="boq-compare-tab"
        onClick={() => onViewChange("compare")}
      >
        Compare Catalog
        {unmatchedCount > 0 ? <span>{unmatchedCount}</span> : null}
      </button>
    </div>
  )
}
```

Do not add a progress rail.

- [ ] **Step 6: Implement `BoqCatalogComparisonPanel`**

Required props:

```ts
interface BoqCatalogComparisonPanelProps {
  boq: Boq
  state: BoqComparisonPanelState
  hasUnsavedChanges: boolean
  onRetry: () => void
  onOpenReview: () => void
}
```

Render summary through `summarizeComponentComparison()`, a draft `Provisional · read-only` banner, an approved `Finalized · read-only` banner, and `BoqCatalogComponentTable` without callbacks. Unmatched lines show status through row data/table text only. The only navigation affordance is `Open Review Extraction`.

- [ ] **Step 7: Rerun new component tests**

Run:

```bash
npx tsx --test \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx \
  src/components/boq-catalog-component-table.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit the presentation components**

```bash
git add -- \
  src/components/boq-workspace-tabs.tsx \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx
git diff --cached --check
git commit -m "feat(boq): add review and comparison tabs"
```

---

### Task 4: Integrate Draft Comparison Into the Canonical BOQ Workspace

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts`

**Interfaces:**

- Consumes: `safeBoqWorkspaceView`, `boqWorkspaceHref`, `BoqWorkspaceTabs`, and `BoqCatalogComparisonPanel`.
- Produces: URL-addressable Review/Compare tabs, revision-aware comparison refresh, and in-place approval finalization.
- Preserves: the existing Review Extraction subtree and every existing approval guard.

- [ ] **Step 1: Add failing page contracts**

Add source-scoped assertions that prove:

```ts
assert.match(source, /searchParams\.get\("view"\)/)
assert.match(source, /safeBoqWorkspaceView/)
assert.match(source, /BoqWorkspaceTabs/)
assert.match(source, /BoqCatalogComparisonPanel/)
assert.match(source, /\/comparison/)
assert.match(source, /router\.replace\(boqWorkspaceHref/)
```

Scope the Compare panel section and assert it does not contain `CatalogMatchModal`, `onMatch`, `onFindMatch`, `onExclude`, `onAiSuggest`, or `onDismissSuggestion`.

Change the approval test to assert:

```ts
assert.doesNotMatch(approvalSuccessBranch, /router\.(push|replace)/)
assert.match(approvalSuccessBranch, /applyMutationBoq\(approved\)/)
```

Add a refresh contract requiring comparison state to be keyed by `canonicalRevisionKey` and requiring pending changes to feed the stale banner.

- [ ] **Step 2: Verify the page tests fail**

Run:

```bash
npx tsx --test 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL because tabs/comparison integration and in-place approval are absent.

- [ ] **Step 3: Parse and canonicalize the workspace view**

In `BoqDetailContent`:

```ts
const view = safeBoqWorkspaceView(searchParams.get("view"))

const handleViewChange = (nextView: BoqWorkspaceView) => {
  router.replace(boqWorkspaceHref(id, nextView, returnTo), { scroll: false })
}
```

Extend URL canonicalization so invalid/legacy view values become `view=review` while valid `returnTo` survives. Continue wrapping `useSearchParams` under the existing Suspense boundary.

- [ ] **Step 4: Add revision-aware comparison loading**

Inside `CanonicalBoqWorkspace`, track:

```ts
const [comparisonState, setComparisonState] = useState<BoqComparisonPanelState>({
  status: "idle",
  rows: [],
})
const [comparisonRevisionKey, setComparisonRevisionKey] = useState<string | null>(null)
const comparisonRequestRef = useRef<AbortController | null>(null)
```

Implement `loadComparison()` using `/api/boqs/${encodeURIComponent(boq.id)}/comparison`. Abort stale requests, retain prior rows on refresh failure, and set `comparisonRevisionKey` only after a successful response.

Load when `view === "compare"` and either no comparison exists or `comparisonRevisionKey !== canonicalRevisionKey`. Abort on unmount and BOQ change.

- [ ] **Step 5: Render tabs around, not inside, the reviewed interface**

Place `BoqWorkspaceTabs` after the existing header and before `ReviewWorkspace`.

Within the existing `ReviewWorkspace` data pane:

```tsx
<div
  id="boq-review-panel"
  role="tabpanel"
  aria-labelledby="boq-review-tab"
  hidden={view !== "review"}
>
  {/* existing Review Extraction content, unchanged */}
</div>
<div
  id="boq-compare-panel"
  role="tabpanel"
  aria-labelledby="boq-compare-tab"
  hidden={view !== "compare"}
>
  <BoqCatalogComparisonPanel ... />
</div>
```

Do not move catalog matching callbacks into the Compare panel.

- [ ] **Step 6: Preserve unsaved-edit truthfulness**

Pass `pendingChanges > 0 || invalidDraftKeys.size > 0` as `hasUnsavedChanges`. The comparison continues to represent the last saved canonical BOQ and shows `Save draft to refresh this comparison` until save succeeds.

Every successful canonical mutation already calls `applyMutationBoq`; the changed `canonicalRevisionKey` invalidates the comparison naturally.

- [ ] **Step 7: Keep approval in place**

Remove the success redirect callback. The successful branch remains:

```ts
const approved = (await response.json()) as Boq
applyMutationBoq(approved)
toast.success("BOQ approved and linked to the Standard Catalog")
```

All existing client guards and server guards remain unchanged. The updated `boq.status` makes both tabs read-only and the panel finalized.

- [ ] **Step 8: Rerun focused workspace tests**

Run:

```bash
npx tsx --test \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Run TypeScript diagnostics before committing**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 10: Commit only semantic workspace changes**

Because this file may have pre-existing formatting edits, inspect normal and whitespace-ignored diffs before staging:

```bash
git diff -- 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff -w -- 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git add -p -- 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff --cached --check
git commit -m "feat(boq): add provisional catalog comparison tab"
```

---

### Task 5: Replace `/compare` With the Direction A Comparison Inbox

**Files:**

- Modify: `src/app/(authenticated)/compare/page.tsx`
- Modify: `src/app/(authenticated)/compare/compare-pricing-ui.test.ts`

**Interfaces:**

- Consumes: `compareBoqHref`, `boqWorkspaceHref`, `resolveCompareBoqId`, `getBoqCatalogReadiness`, and `summarizeComponentComparison`.
- Produces: recent BOQ list, selected provisional summary, `Open comparison`, `Review issues`, and upload-to-review navigation.
- Removes: full comparison table, preparation card, `CatalogMatchModal`, and matching state from `/compare`.

- [ ] **Step 1: Use Open Design before changing `/compare`**

The UI worker must load the approved artifact through Open Design MCP and inspect the Direction A `Comparison Inbox` screen. Preserve the app’s current dark navy sidebar and existing page shell rather than copying the artifact’s shell literally.

- [ ] **Step 2: Add failing Comparison Inbox tests**

Replace obsolete page contracts with:

```ts
assert.match(source, /Comparison Inbox/)
assert.match(source, /Open comparison/)
assert.match(source, /Review issues/)
assert.match(source, /boqWorkspaceHref\([^,]+,\s*"compare"/)
assert.match(source, /boqWorkspaceHref\([^,]+,\s*"review"/)
assert.match(source, /summarizeComponentComparison/)
assert.doesNotMatch(source, /BoqCatalogComponentTable/)
assert.doesNotMatch(source, /CatalogMatchModal/)
assert.doesNotMatch(source, /Review, match & approve/)
assert.doesNotMatch(source, /selected\.status !== "approved"/)
```

Retain tests for `resolveCompareBoqId`, separate BOQ/comparison failures, request cancellation, and narrow-screen actions.

- [ ] **Step 3: Verify the page test fails**

Run:

```bash
npx tsx --test 'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
```

Expected: FAIL because the current page still gates the full table on approval.

- [ ] **Step 4: Remove duplicate comparison and matching ownership**

Remove:

- `BoqCatalogComponentTable` rendering;
- `CatalogMatchModal` and `matchTarget` state;
- approval-only comparison load condition;
- draft preparation card;
- match refresh callback.

Keep the existing abortable selected-comparison request and allow it for any selected draft or approved BOQ.

- [ ] **Step 5: Build the inbox list and selected snapshot**

Render recent BOQs with:

```tsx
<button
  type="button"
  className={selected.id === boq.id ? "is-selected" : undefined}
  onClick={() => handleSelectionChange(boq.id)}
>
  <strong>{boq.project || "Untitled BOQ"}</strong>
  <span>{boq.vendor}</span>
  <ProtoBadge status={boq.status} />
  <span>{getBoqCatalogReadiness(boq).blocking} unmatched</span>
</button>
```

The selected snapshot uses the existing loaded comparison and `summarizeComponentComparison()`. Do not fetch comparisons for every list row.

- [ ] **Step 6: Add explicit workspace links**

For an existing selected BOQ:

```tsx
<Link
  href={boqWorkspaceHref(
    selected.id,
    "compare",
    compareBoqHref(selected.id),
  )}
>
  Open comparison
</Link>
```

When review or catalog issues exist, render a secondary `Review issues` link with `view="review"`.

On upload completion:

```ts
router.push(
  boqWorkspaceHref(boq.id, "review", compareBoqHref(boq.id)),
)
```

- [ ] **Step 7: Rerun focused Compare tests**

Run:

```bash
npx tsx --test \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  src/lib/compare-boq-selection.test.ts \
  src/lib/boq-review-route.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the Comparison Inbox**

```bash
git diff -w -- \
  'src/app/(authenticated)/compare/page.tsx' \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
git add -p -- \
  'src/app/(authenticated)/compare/page.tsx' \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
git diff --cached --check
git commit -m "feat(compare): add single-BOQ comparison inbox"
```

---

### Task 6: Apply Responsive Styling Without Redesigning Review Extraction

**Files:**

- Modify: `src/app/globals.css`
- Modify: `src/app/(authenticated)/compare/compare-pricing-ui.test.ts`
- Modify: `src/components/boq-catalog-component-table.test.tsx`

**Interfaces:**

- Consumes: CSS class names introduced in Tasks 3–5.
- Produces: desktop Direction A layout, keyboard-visible tabs, mobile PDF/Data compatibility, and stacked read-only comparison cards.
- Preserves: existing `.review-*`, `.boq-unified-*`, PDF viewer, resizer, and Review table behavior.

- [ ] **Step 1: Add failing CSS contracts**

Add source tests for:

```ts
assert.match(styles, /\.boq-workspace-tabs\s*\{/)
assert.match(styles, /\.compare-inbox-list\s*\{/)
assert.match(styles, /\.boq-comparison-panel\s*\{/)
assert.match(styles, /@media \(max-width: 920px\)/)
assert.match(styles, /\.boq-workspace-tab:focus-visible/)
assert.doesNotMatch(styles, /boq-workspace-progress/)
```

Retain current mobile component-card assertions.

- [ ] **Step 2: Verify style contracts fail**

Run:

```bash
npx tsx --test \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  src/components/boq-catalog-component-table.test.tsx
```

Expected: FAIL for missing new classes.

- [ ] **Step 3: Add restrained Direction A styles**

Add only feature-scoped classes:

```css
.boq-workspace-tabs {
  display: flex;
  min-height: 52px;
  align-items: flex-end;
  gap: var(--space-5);
  padding-inline: var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.boq-workspace-tab {
  min-height: 44px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted-text);
  font-weight: 600;
}

.boq-workspace-tab[aria-selected="true"] {
  border-bottom-color: var(--accent);
  color: var(--fg-2);
}

.boq-workspace-tab-badge {
  margin-left: var(--space-2);
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: color-mix(in oklab, var(--color-brand-warn) 16%, transparent);
}

.boq-comparison-panel {
  min-width: 0;
  padding: var(--space-4);
}

.boq-comparison-state {
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.compare-inbox {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.8fr);
  gap: var(--space-4);
}

.compare-inbox-list {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.compare-inbox-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  gap: var(--space-3);
  align-items: center;
  width: 100%;
  padding: var(--space-4);
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  text-align: left;
}

.compare-inbox-row.is-selected {
  background: color-mix(in oklab, var(--accent) 7%, var(--surface));
}

.compare-inbox-snapshot {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}
```

Use existing tokens and keep current Review Extraction selectors unchanged.

At `max-width: 920px`, preserve existing Review mobile behavior and make inbox rows stack. At `max-width: 560px`, make tab labels/counts wrap safely and keep comparison cards single-column. Do not introduce animation beyond existing motion tokens.

- [ ] **Step 4: Rerun focused UI tests**

Run:

```bash
npx tsx --test \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  src/components/boq-catalog-component-table.test.tsx \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run proactive diagnostics**

Run `lsp_diagnostics` on all changed TypeScript/TSX files, then:

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit scoped styles**

```bash
git add -p -- src/app/globals.css \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  src/components/boq-catalog-component-table.test.tsx
git diff --cached --check
git commit -m "style(boq): polish comparison workspace"
```

---

### Task 7: Browser QA, Open Design Fidelity Review, and Final Validation

**Files:**

- Create: `.superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison/browser-qa-report.md` during execution only; keep it gitignored.
- Modify source only if QA reveals a verified defect; use a focused test-first fix and separate commit.

**Interfaces:**

- Verifies the complete user flow without broadening scope.

- [ ] **Step 1: Run all focused tests**

```bash
npx tsx --test \
  src/lib/boq-review-route.test.ts \
  src/components/boq-catalog-component-table.test.tsx \
  src/components/boq-workspace-tabs.test.tsx \
  src/components/boq-catalog-comparison-panel.test.tsx \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  src/app/api/boqs/[id]/comparison/comparison-api.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run the full project check**

```bash
npm run check
```

Expected: lint, TypeScript, and all tests pass.

- [ ] **Step 3: Refresh the code graph**

```bash
graphify update .
```

Expected: exit 0. Do not stage generated graph files.

- [ ] **Step 4: Start the app and test the desktop flow with agent-browser**

At 1440px:

1. Sign in.
2. Open `/compare`.
3. Verify the Comparison Inbox lists draft and approved BOQs.
4. Select a draft and verify provisional summary loads before approval.
5. Click `Open comparison`; verify `/boqs/[id]?view=compare...`.
6. Verify PDF remains visible and Compare Catalog has no mutation controls.
7. Switch to Review Extraction; verify the existing reviewed UI and matching controls remain.
8. Save a correction; switch back and verify comparison refreshes.
9. Approve after blockers clear; verify the page stays in place and becomes read-only/finalized.
10. Use Back to Compare and verify selection is preserved.

Capture screenshots of `/compare`, Review Extraction, and Compare Catalog.

- [ ] **Step 5: Test mobile behavior**

At 390px:

1. Verify tabs remain reachable.
2. Verify the existing Review mobile PDF/data layout is unchanged and no new PDF/Data switch appears.
3. Verify Compare renders the responsive PDF pane followed by stacked material/labour cards.
4. Verify no mutation controls appear in Compare.
5. Verify keyboard focus and accessible names for both tabs.

- [ ] **Step 6: Perform the required Open Design fidelity review**

Use Open Design MCP to reopen:

```text
project: buildestimate-compare-component-ui-da54
entry: unified-boq-workspace-concepts.html
```

Compare the browser screenshots against Direction A. Record:

- `/compare` hierarchy and selected-row emphasis;
- tab position and count badges;
- unchanged Review Extraction surface;
- PDF persistence in Compare;
- provisional/finalized banners;
- read-only table and mobile cards;
- intentional difference: no progress rail and no Compare mutation actions.

Any visual fix must preserve existing functionality and receive a focused regression test when testable.

- [ ] **Step 7: Verify scope and working tree**

```bash
FEATURE_BASE=$(cat .superpowers/sdd/2026-08-03-unified-boq-review-catalog-comparison/feature-base)
git diff --check
git diff --name-only "$FEATURE_BASE"..HEAD
git status --short
git diff --cached --name-only
```

Expected:

- no staged files;
- only planned source/test files in the feature commit range;
- pre-existing unstaged edits remain unstaged;
- `Quotation example/` is absent from every diff;
- no production migration files.

- [ ] **Step 8: Request final code review**

Use the Superpowers `requesting-code-review` workflow against the feature-base-to-HEAD review package. Block completion on Critical or Important findings. Document deferred Minor findings explicitly.

---

## Execution Notes

- Recommended execution: Superpowers subagent-driven development with one fresh worker and one fresh reviewer per task.
- Task 3, Task 5, and Task 7 are UI tasks; their workers must have Open Design MCP available. If a worker cannot access the MCP tool, stop that task and have the parent attach the approved artifact before continuing rather than inventing UI.
- Keep one writer on the main checkout at a time. Reviewers are read-only.
- Because the checkout has pre-existing unstaged formatting edits, every task report must include staged-file evidence and a whitespace-ignored diff review for dirty target files.
