# BOQ Details Compare Return and Approval Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable direct-entry route back to Compare and make the BOQ approval control explain and correctly reflect post-match readiness without weakening approval guards.

**Architecture:** Keep route validation in `src/lib/boq-review-route.ts` and use the existing validated `returnTo` when present. BOQ Details will use `compareBoqHref(id)` only as the safe direct-entry fallback. Approval state stays local to `CanonicalBoqWorkspace`, derived from its existing mutation, draft, verification, and catalog-readiness state; the UI adds a single derived disabled reason beside the existing guarded button.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, node:test/tsx source-contract tests, existing route helpers and BOQ verification/readiness utilities.

## Global Constraints

- Work directly on the current `main` checkout; preserve the six existing unstaged formatting edits and do not stage them with this feature.
- Keep 2-space indentation in newly authored implementation/test blocks unless preserving the checkout’s existing formatting requires otherwise.
- Keep Match, AI, Dismiss, Create new, and Exclude exclusively on BOQ Details.
- Preserve strict `safeCompareReturnPath` validation and opaque BOQ IDs.
- Do not bypass pending-edit, invalid-draft, verification, or catalog-readiness approval guards.
- Do not read or stage anything under `Quotation example/`.
- Do not run production migrations.
- Run `npm run check` after code changes and `graphify update .` before completion.

---

### Task 1: Direct BOQ Details back-navigation fallback

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:20-31,292-302`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts:99-112`

**Interfaces:**

- Consumes: `compareBoqHref(id)`, `safeCompareReturnPath(returnTo)`, and the existing `CanonicalBoqWorkspace` `backHref`/`backLabel` props.
- Produces: Direct BOQ Details pages link to `/compare?boq=<id>` while Compare-origin pages preserve their validated query-specific return URL.

- [ ] **Step 1: Write the failing source-contract tests**

Add tests next to the existing Compare-origin navigation test:

```ts
test("direct BOQ Details exposes a safe Back to Compare fallback", () => {
  assert.match(source, /compareBoqHref/)
  assert.match(source, /backHref=\{returnTo \?\? compareBoqHref\(id\)\}/)
  assert.match(source, /backLabel=\{returnTo \? "Back to comparison" : "Back to Compare"\}/)
})
```

Update the existing return-navigation assertion so the validated return path remains the preferred destination and the direct fallback is only used when `returnTo` is absent.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL because the page currently imports no `compareBoqHref` and falls back to `/boqs`.

- [ ] **Step 3: Implement the minimal navigation change**

Import `compareBoqHref` from `@/lib/boq-review-route` and change the loaded Details workspace call to:

```tsx
backHref={returnTo ?? compareBoqHref(id)}
backLabel={returnTo ? "Back to comparison" : "Back to Compare"}
```

Leave invalid/missing BOQ recovery on `/boqs` unless a validated `returnTo` exists; recovery is not the loaded direct-entry workflow.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: PASS, including existing safe-return and approval-redirect tests.

- [ ] **Step 5: Commit the task**

```bash
git add 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git commit -m "feat(boq): add direct compare return from details"
```

Do not stage the pre-existing formatting edits in other files.

---

### Task 2: Explicit approval blocker state and post-match readiness contract

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:531-551,890-948,1091-1127`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts:74-97`

**Interfaces:**

- Consumes: `mutationBusy`, `invalidDraftKeys`, `pendingChanges`, `verification.hasBlockingIssues`, `catalogReadiness.blocking`, and the existing `reloadAfterManualMatch` `finally` cleanup.
- Produces: `approvalDisabledReason: string | null`, one shared `approvalDisabled` predicate for the button, and a visible/accessible blocker message tied to the Approve BOQ control.

- [ ] **Step 1: Write failing tests for the approval state contract**

Extend the existing approval tests with source assertions that the disabled state is centralized and explanatory:

```ts
test("approval exposes one disabled state and an actionable blocker message", () => {
  const approval = sourceSection(
    "const approvalDisabledReason",
    "const handleApprove",
  )
  assert.match(approval, /mutationBusy/)
  assert.match(approval, /invalidDraftKeys\.size > 0/)
  assert.match(approval, /pendingChanges > 0/)
  assert.match(approval, /verification\.hasBlockingIssues/)
  assert.match(approval, /catalogReadiness\.blocking > 0/)
  assert.match(source, /approvalDisabledReason/)
  assert.match(source, /aria-describedby=\{approvalDisabledReason/)
  assert.match(source, /data-od-id="approval-blocker"/)
})

test("manual match always releases its mutation lock", () => {
  const match = sourceSection(
    "const reloadAfterManualMatch",
    "const handleExclude",
  )
  assert.match(match, /setMatching\(false\)/)
  assert.match(match, /finally/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL because the button currently repeats inline conditions and has no blocker message contract.

- [ ] **Step 3: Derive a single approval state without changing guards**

Immediately after `pendingChanges` and the verification/readiness values are available, add:

```tsx
const approvalDisabledReason =
  mutationBusy
    ? approving
      ? "Approving BOQ…"
      : "Finish the current BOQ update before approving."
    : invalidDraftKeys.size > 0
      ? "Fix invalid component costs before approving."
      : pendingChanges > 0
        ? "Save pending BOQ changes before approving."
        : verification.hasBlockingIssues
          ? "Resolve the review blockers below before approving."
          : catalogReadiness.blocking > 0
            ? `Resolve ${catalogReadiness.blocking} catalog line${catalogReadiness.blocking === 1 ? "" : "s"} before approving.`
            : null
const approvalDisabled = approvalDisabledReason !== null
```

Use the same derived state for the button’s `disabled` prop. Keep the existing `handleApprove` guard clauses unchanged as defense in depth. The reason order must match the disabled predicate so the message names the first effective blocker.

- [ ] **Step 4: Render the blocker explanation accessibly**

Add the message adjacent to the approval button only while disabled:

```tsx
{approvalDisabledReason ? (
  <span
    id="approve-boq-blocker"
    data-od-id="approval-blocker"
    className="text-xs text-muted-foreground"
    role="status"
  >
    {approvalDisabledReason}
  </span>
) : null}
```

Set `aria-describedby={approvalDisabledReason ? "approve-boq-blocker" : undefined}` on the button. Preserve `aria-busy={approving}` and the existing `Approving…` label.

- [ ] **Step 5: Verify post-match cleanup remains explicit**

Keep the existing `reloadAfterManualMatch` `finally { setMatching(false) }` path. If implementation changes are needed to satisfy the test, ensure the GET response is reconciled before closing the modal and that both success and failure release `matching`; do not add a redirect after matching.

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: PASS with approval guards, accessible progress, blocker messaging, direct fallback, and post-match cleanup covered.

- [ ] **Step 7: Commit the task**

```bash
git add 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts'
git commit -m "fix(boq): explain approval blockers after matching"
```

Do not stage the pre-existing formatting edits in other files.

---

### Task 3: Full validation and graph refresh

**Files:**

- Modify: no additional source files
- Validate: all changed source/test files and the merged `main` checkout

**Interfaces:**

- Consumes: Task 1 and Task 2 commits.
- Produces: Passing project checks, updated graph output, and a clean feature diff excluding the six pre-existing unstaged formatting edits.

- [ ] **Step 1: Run diagnostics on edited files**

Run:

```bash
npx tsc --noEmit
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 2: Run the required project check**

Run:

```bash
npm run check
```

Expected: lint/typecheck/full test suite pass; report only known pre-existing warnings if present.

- [ ] **Step 3: Refresh the repository graph**

Run:

```bash
graphify update .
```

Expected: graph refresh completes without source-analysis errors and does not stage `graphify-out/`.

- [ ] **Step 4: Verify scope and preserved edits**

Run:

```bash
git diff --check
printf 'Feature commits:\n'
git log --oneline --max-count=3
printf 'Unstaged files:\n'
git status --short
```

Expected: no whitespace errors; the six pre-existing formatting files remain unstaged; `Quotation example/` is absent from all feature diffs.

- [ ] **Step 5: Commit validation artifacts only if tracked**

Do not stage generated `graphify-out/` output or the pre-existing formatting edits. If no tracked validation artifact changed, leave the tree with only those six known unstaged files.

---

## Self-review checklist

- **Spec coverage:** Direct-entry Compare fallback is Task 1; strict return preservation is retained; approval guards, post-match cleanup, and blocker messaging are Task 2; checks and graph refresh are Task 3.
- **Placeholder scan:** No TBD, TODO, or unspecified implementation steps remain.
- **Type consistency:** `approvalDisabledReason` is `string | null`; `approvalDisabled` is boolean; both are defined before the button and used only in the same workspace.
- **Scope:** No automatic redirect after matching, no duplicated Compare matching actions, no server validation changes, no migrations, and no `Quotation example/` access.
