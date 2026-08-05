# BOQ Workspace Header Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove redundant BOQ workspace navigation, embed a clearly named Edit/Compare switch in the command bar, and distinguish extraction suggestions from the overall BOQ verification workspace.

**Architecture:** Keep `BoqWorkspaceTabs` as the accessible owner of workspace-view semantics, but restyle it as an embeddable segmented control. `CanonicalBoqWorkspace` will place that control inside its existing action group, remove the workspace-specific back-link props, and retain all save, approval, blocker, and overflow behavior. Responsive CSS will wrap the switch and action group without changing route or data behavior.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, CSS custom properties, Node test runner via `tsx --test`.

## Global Constraints

- Preserve `view=review|compare` URL behavior and strict `safeCompareReturnPath` validation.
- Preserve opaque BOQ IDs, comparison loading, read-only behavior, extraction mutation rules, save behavior, approval rules, and approved-BOQ mutation protection.
- Use the exact approved labels: **Edit & Verify**, **Compare Catalog**, **Extraction Suggestions**, and **BOQ Items**.
- Keep **Save draft**, **Approve BOQ**, approval-blocker feedback, and overflow actions visible.
- Do not add a workflow progress rail or move actions into another panel.
- Preserve tab semantics, panel relationships, badge counts, keyboard focus visibility, and usable touch targets.
- Do not read, stage, or commit `Quotation example/`.
- The working tree already contains unrelated formatting edits. Never use `git add .`; on dirty files use `git add -p`, then inspect `git diff --cached` before every commit.
- Use 2-space indentation for intended changes.
- Run `npm run check` and `graphify update .` after code changes.

---

## File Map

- `src/components/boq-workspace-tabs.tsx` — accessible workspace switch markup and approved labels.
- `src/components/boq-workspace-tabs.test.tsx` — rendered semantic contract for labels, counts, and selected panels.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — BOQ command-bar composition and contextual extraction-pane labels.
- `src/app/(authenticated)/boqs/[id]/page.test.ts` — source-level composition and route-preservation contracts.
- `src/app/globals.css` — segmented-control presentation and responsive command-bar wrapping.

### Task 1: Rename and Reframe the Workspace Switch

**Files:**

- Modify: `src/components/boq-workspace-tabs.tsx:3-55`
- Test: `src/components/boq-workspace-tabs.test.tsx:1-41`

**Interfaces:**

- Consumes: `BoqWorkspaceView`, `view`, `reviewIssueCount`, `unmatchedCount`, and `onViewChange` exactly as currently defined.
- Produces: unchanged `BoqWorkspaceTabs(props): JSX.Element` API with visible labels **Edit & Verify** and **Compare Catalog**.

- [ ] **Step 1: Update the rendered-label test first**

Change the first test to require the approved copy and reject the confusing legacy copy:

```tsx
assert.match(html, /Edit &amp; Verify/)
assert.match(html, /Compare Catalog/)
assert.doesNotMatch(html, /Review Extraction/)
assert.match(html, />3</)
assert.match(html, />5</)
```

Keep the existing assertions for `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, and the absence of a progress rail.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx tsx --test src/components/boq-workspace-tabs.test.tsx
```

Expected: FAIL because the rendered HTML still contains `Review Extraction` and does not contain `Edit &amp; Verify`.

- [ ] **Step 3: Implement the approved workspace label**

In `BoqWorkspaceTabs`, change only the review-view label:

```tsx
<button
  type="button"
  role="tab"
  aria-selected={view === "review"}
  aria-controls="boq-review-panel"
  id="boq-review-tab"
  className={
    view === "review"
      ? "boq-workspace-tab boq-workspace-tab-active"
      : "boq-workspace-tab"
  }
  onClick={() => onViewChange("review")}
>
  Edit & Verify
  {reviewIssueCount > 0 ? <span>{reviewIssueCount}</span> : null}
</button>
```

Do not change IDs, `aria-controls`, count behavior, or the `onViewChange` contract.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
npx tsx --test src/components/boq-workspace-tabs.test.tsx
```

Expected: both tests PASS.

- [ ] **Step 5: Commit only Task 1**

```bash
git add src/components/boq-workspace-tabs.tsx src/components/boq-workspace-tabs.test.tsx
git diff --cached --check
git diff --cached -- src/components/boq-workspace-tabs.tsx src/components/boq-workspace-tabs.test.tsx
git commit -m "refactor: clarify BOQ workspace labels"
```

### Task 2: Integrate the Switch into the BOQ Command Bar

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:181-324,332-1624`
- Modify: `src/app/globals.css:866-912,1943-1955,2072-2077`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts:60-66,201-216`

**Interfaces:**

- Consumes: the unchanged `BoqWorkspaceTabs` API from Task 1 and existing `view`, `blockingIssues`, `catalogReadiness`, and `onViewChange` values.
- Produces: `CanonicalBoqWorkspace` without `backHref` or `backLabel` props; the workspace switch rendered inside `.boq-unified-actions`; contextual pane labels **Extraction Suggestions** and **BOQ Items**.

- [ ] **Step 1: Replace the obsolete back-link test with the new composition contract**

Remove the test named `direct BOQ Details exposes a safe Back to Compare fallback`. Add this test while retaining the existing URL-addressability test:

```ts
test("workspace command bar embeds the view switch without redundant compare navigation", () => {
  const headerStart = source.indexOf('className="review-header boq-unified-header"')
  const headerEnd = source.indexOf("</header>", headerStart)
  const header = source.slice(headerStart, headerEnd)

  assert.ok(headerStart >= 0)
  assert.ok(headerEnd > headerStart)
  assert.match(header, /<BoqWorkspaceTabs/)
  assert.match(header, /Extraction Suggestions/)
  assert.match(header, /BOQ Items/)
  assert.doesNotMatch(header, /boq-back-link/)
  assert.doesNotMatch(header, /Back to Compare|Back to comparison/)
})
```

Add or retain route assertions proving `returnTo` is still validated and propagated when changing views:

```ts
assert.match(source, /safeCompareReturnPath\(rawReturnTo\)/)
assert.match(source, /boqWorkspaceHref\(id, nextView, returnTo\)/)
assert.match(source, /href=\{returnTo \?\? "\/boqs"\}/)
```

- [ ] **Step 2: Run the page contract test and confirm RED**

Run:

```bash
npx tsx --test 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL because the header still contains `boq-back-link`, the switch is below `</header>`, and the legacy `Extraction review` label remains.

- [ ] **Step 3: Remove only the redundant visible back-link plumbing**

In `BoqDetailContent`, stop passing `backHref` and `backLabel`:

```tsx
return (
  <CanonicalBoqWorkspace
    key={boq.id}
    boq={boq}
    onBoqChange={setBoq}
    view={view}
    onViewChange={handleViewChange}
  />
)
```

Remove `backHref` and `backLabel` from `CanonicalBoqWorkspace` parameters and its inline prop type. Remove the now-unused `compareBoqHref` and `ChevronLeft` imports. Keep `Link`, `safeCompareReturnPath`, `returnTo`, and the not-found return link unchanged.

- [ ] **Step 4: Move the workspace switch into the action group**

Insert this exact element as the first child of `.review-header-actions.boq-unified-actions`, immediately before the existing `{hasSource || boq.activeExtractionRunId ? (` conditional:

```tsx
<BoqWorkspaceTabs
  view={view}
  reviewIssueCount={blockingIssues.length}
  unmatchedCount={catalogReadiness.blocking}
  onViewChange={onViewChange}
/>
```

Leave the following extraction toggle, Save draft, Approve BOQ, blocker, and overflow markup in its current order. Delete the standalone `BoqWorkspaceTabs` instance after `</header>`. Do not duplicate the switch or move any existing action into a different panel.

- [ ] **Step 5: Rename the contextual extraction-pane control**

Keep the toggle logic and icons unchanged, but replace the labels:

```tsx
{rightPaneMode === "items" ? (
  <>
    <Sparkles aria-hidden="true" />
    Extraction Suggestions
  </>
) : (
  <>
    <FileSearch aria-hidden="true" />
    BOQ Items
  </>
)}
```

- [ ] **Step 6: Restyle the switch as a compact segmented control**

Replace the standalone-row rules with an embeddable control using existing tokens:

```css
.boq-workspace-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: max-content;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--muted);
}

.boq-workspace-tab {
  display: inline-flex;
  min-width: 44px;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding-inline: var(--space-3);
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--muted-text);
  font-weight: 600;
  cursor: pointer;
}

.boq-workspace-tab[aria-selected="true"],
.boq-workspace-tab-active {
  background: var(--surface);
  color: var(--fg-2);
  box-shadow: var(--elev-raised);
}

.boq-workspace-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

Retain the existing badge treatment. Remove obsolete `.boq-back-link` rules.

- [ ] **Step 7: Add the approved responsive wrapping behavior**

Make the action group wrap safely, then add a constrained-width rule before the existing mobile rule:

```css
.boq-unified-actions {
  flex: 0 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 1200px) {
  .boq-unified-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .boq-unified-header .review-header-title,
  .boq-unified-actions {
    width: 100%;
  }

  .boq-unified-actions .boq-workspace-tabs {
    flex: 1 0 100%;
    order: -1;
    width: 100%;
  }

  .boq-workspace-tab {
    flex: 1;
    min-height: 44px;
  }
}
```

Keep the existing `max-width: 768px` title/vendor simplifications, but remove duplicate declarations that are fully superseded by the new `1200px` rule. Verify that no empty standalone tab-row height remains.

- [ ] **Step 8: Run focused tests and confirm GREEN**

Run:

```bash
npx tsx --test \
  src/components/boq-workspace-tabs.test.tsx \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: all workspace switch and BOQ detail page tests PASS.

- [ ] **Step 9: Check TypeScript and LSP before committing**

Run:

```bash
npx tsc --noEmit
```

Then run LSP diagnostics for:

- `src/components/boq-workspace-tabs.tsx`
- `src/app/(authenticated)/boqs/[id]/page.tsx`

Expected: no TypeScript or LSP errors.

- [ ] **Step 10: Stage only intended Task 2 hunks and commit**

Because both page files contain unrelated working-tree formatting edits, use patch staging:

```bash
git add -p 'src/app/(authenticated)/boqs/[id]/page.tsx'
git add -p 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git add src/app/globals.css
git diff --cached --check
git diff --cached -- \
  'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  src/app/globals.css
git commit -m "refactor: streamline BOQ workspace header"
```

The cached diff must contain only removal of the workspace back link, switch relocation, approved labels, tests, and responsive CSS.

### Task 3: Final Verification and Manual UI QA

**Files:**

- Verify only; no product files should change.

**Interfaces:**

- Consumes: the final Task 1 and Task 2 commits.
- Produces: verification evidence for the exact final tree.

- [ ] **Step 1: Run the full project check**

```bash
npm run check
```

Expected: ESLint exits 0, TypeScript exits 0, and the full test suite passes.

- [ ] **Step 2: Refresh the code graph**

```bash
graphify update .
```

Expected: exit 0. Dirty `graphify-out/` files are expected and must not be staged.

- [ ] **Step 3: Perform browser QA against the running development server**

Verify at 1440px desktop and 390px mobile widths:

1. no visible **Back to Compare** control appears in the BOQ workspace;
2. **Edit & Verify** and **Compare Catalog** appear in the command bar and update `view=review|compare`;
3. issue/unmatched badges remain correct;
4. **Extraction Suggestions** opens the existing suggestion panel and changes to **BOQ Items**;
5. Save draft, Approve BOQ, blocker feedback, and overflow remain visible and functional;
6. the switch and actions wrap into clean separate rows without horizontal overflow;
7. keyboard focus is visible and the active tab is announced correctly;
8. no empty row remains where the old standalone tabs were.

- [ ] **Step 4: Verify repository hygiene**

```bash
git diff --check
git diff --cached --name-only
git status --short
```

Expected: no staged files; the unrelated pre-existing working-tree edits remain unstaged; `Quotation example/` is untouched.
