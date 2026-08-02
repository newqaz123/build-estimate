# Compare BOQ Detail Review Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route unapproved BOQs from Compare into the canonical BOQ Details matching workspace, then safely return approved BOQs to their selected catalog comparison.

**Architecture:** Centralize Compare/BOQ Details URL construction and `returnTo` validation in pure route helpers. Keep Compare responsible for selection, upload routing, and race-safe comparison loading, while BOQ Details retains all catalog mutation actions and invokes an approval-success callback for the validated return navigation.

**Tech Stack:** Next.js 16.2 App Router, React 19, TypeScript 5, Node test runner through `tsx --test`, existing Airtable-style components and CSS.

## Global Constraints

- Use test-driven development: add each failing test before its implementation.
- Use 2-space indentation in new and edited blocks; avoid unrelated whole-file formatting.
- Never read, stage, or commit `Quotation example/`.
- Do not run production migrations.
- Read and follow `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`; the Compare page must wrap `useSearchParams()` usage in `Suspense`.
- Preserve the existing Airtable-style Compare design and BOQ Details workspace.
- Keep Match, AI Suggest, Dismiss, Create New, and Exclude exclusively on BOQ Details.
- Treat Open Design compliance, budget, and deprecation examples as visual state illustrations only; preserve the existing verification/catalog blockers and do not add new business rules in this scope.
- Generated review URLs must contain a validated encoded `returnTo`.
- External, protocol-relative, malformed, duplicate, or unsupported return URLs must never reach `router.replace`.
- Preserve the existing approved comparison table, summary calculations, comparison Match modal, and responsive component rows.
- Run `graphify update .` after source changes.
- Run `npm run check` before completion.

## Edge-Case Contract

| Case | Required behavior |
| --- | --- |
| Newly uploaded draft | Close Upload and navigate directly to BOQ Details with `/compare?boq=<id>` encoded as `returnTo`. |
| Known `?boq=<id>` | Select that BOQ after the list loads. |
| Unknown `?boq=<id>` | Retain a still-valid current selection, otherwise select the first BOQ; do not crash or request comparison for the unknown ID. |
| Empty BOQ list | Keep the existing upload empty state. |
| Missing BOQ on Details | Show the existing not-found state; when a safe Compare return exists, offer “Back to comparison.” |
| BOQ list network failure | Show a BOQ-list-specific retry action that reloads the list. |
| Draft with unresolved catalog lines | Stay on BOQ Details; catalog readiness continues to disable approval. |
| Catalog resolved but review blockers remain | Stay on BOQ Details; verification blockers continue to disable approval. |
| Pending item or metadata edits | Stay on BOQ Details; require Save draft before approval. |
| Invalid component drafts | Stay on BOQ Details; keep Save and Approve disabled. |
| Approval in progress | Disable mutation controls, expose `aria-busy`, and show “Approving…”. |
| Approval API failure | Show the existing error toast, clear progress, and do not navigate. |
| Successful approval with safe `returnTo` | Apply the approved BOQ, show success, then `router.replace(returnTo)`. |
| Successful approval without safe `returnTo` | Remain on the read-only BOQ Details page. |
| Invalid/external `returnTo` | Strip it during canonicalization and never redirect to it. |
| Legacy `mode=review` | Remove `mode=review` while retaining a valid Compare `returnTo`. |
| Rapid approved-BOQ switching | Abort superseded comparison requests and ignore late responses. |
| Switching from approved to draft | Clear old comparison rows immediately and show preparation state. |
| Comparison API failure | Show comparison-specific Retry; retry only the current approved BOQ. |
| Comparison refresh after Match fails | Show the error state without a false “Comparison refreshed” toast. |
| Mobile at 390 px | Preparation CTA spans available width, toolbar and cards stack, and no horizontal page overflow is introduced. |
| Existing approved BOQ | Continue directly to the current component comparison UI without visiting Details. |

---

## File Map

### Files to Modify

- `src/lib/boq-review-route.ts` — add strict Compare URL builders and return-path validation.
- `src/lib/boq-review-route.test.ts` — cover encoding, validation, legacy mode, and malicious return values.
- `src/app/(authenticated)/compare/page.tsx` — replace ReviewPanel usage with navigation, honor the query selection, and separate race-safe load states.
- `src/app/(authenticated)/compare/compare-pricing-ui.test.ts` — assert canonical navigation, no duplicated matching UI, request cancellation, retry separation, and mobile CTA contracts.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — preserve safe return context, canonicalize legacy/invalid URLs, and return only after successful approval.
- `src/app/(authenticated)/boqs/[id]/page.test.ts` — protect blockers, progress, failure behavior, return navigation, and canonical catalog actions.

### New Files

- `src/lib/compare-boq-selection.ts` — pure preferred/current/fallback BOQ selection resolver.
- `src/lib/compare-boq-selection.test.ts` — known, unknown, removed, stale, and empty selection cases.

## Tasks

### Task 1: Safe Compare Review Route Contracts

**Files:**

- Modify: `src/lib/boq-review-route.ts:1-13`
- Modify: `src/lib/boq-review-route.test.ts:1-18`

**Interfaces:**

- Produces: `compareBoqHref(id: string): string`
- Produces: `safeCompareReturnPath(value: string | null | undefined): string | null`
- Produces: `boqDetailReturnHref(id: string, returnTo: string | null | undefined): string`
- Produces: `boqComparisonReviewHref(id: string): string`
- Preserves: `boqDetailHref`, `boqReviewHref`, and `isBoqReviewMode`

- [ ] **Step 1: Add failing route tests**

Replace the imports in `src/lib/boq-review-route.test.ts` and add these cases:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  boqComparisonReviewHref,
  boqDetailHref,
  boqDetailReturnHref,
  boqReviewHref,
  compareBoqHref,
  isBoqReviewMode,
  safeCompareReturnPath,
} from "./boq-review-route"

test("BOQ detail and legacy review helpers resolve to one canonical encoded URL", () => {
  assert.equal(boqDetailHref("boq / 7"), "/boqs/boq%20%2F%207")
  assert.equal(boqReviewHref("boq / 7"), boqDetailHref("boq / 7"))
  assert.equal(boqReviewHref("boq / 7").includes("?"), false)
})

test("compare review URLs preserve opaque BOQ ids through nested encoding", () => {
  const compareHref = compareBoqHref("boq / 7")
  const reviewHref = boqComparisonReviewHref("boq / 7")
  const parsed = new URL(reviewHref, "https://buildestimate.local")

  assert.equal(compareHref, "/compare?boq=boq+%2F+7")
  assert.equal(parsed.pathname, "/boqs/boq%20%2F%207")
  assert.equal(parsed.searchParams.get("returnTo"), compareHref)
  assert.equal(safeCompareReturnPath(parsed.searchParams.get("returnTo")), compareHref)
})

test("safe compare returns accept only the compare route and one optional boq id", () => {
  assert.equal(safeCompareReturnPath("/compare"), "/compare")
  assert.equal(
    safeCompareReturnPath("/compare?boq=boq+%2F+7"),
    "/compare?boq=boq+%2F+7",
  )
  assert.equal(
    boqDetailReturnHref("boq / 7", "/compare?boq=boq+%2F+7"),
    "/boqs/boq%20%2F%207?returnTo=%2Fcompare%3Fboq%3Dboq%2B%252F%2B7",
  )
})

test("safe compare returns reject external, malformed, and unsupported destinations", () => {
  const invalidValues = [
    null,
    undefined,
    "",
    "https://attacker.example/compare?boq=1",
    "//attacker.example/compare?boq=1",
    "javascript:alert(1)",
    "/compare-extra?boq=1",
    "/compare/?boq=1",
    "/compare?",
    "/compare?boq=",
    "/compare?boq=%20",
    "/compare?boq=1&boq=2",
    "/compare?boq=1&admin=true",
    "/compare?boq=1#fragment",
    "/boqs/1",
    "/dashboard",
    "/%2e%2e/compare?boq=1",
    "/compare?boq=%E0%A4%A",
  ]

  for (const value of invalidValues) {
    assert.equal(safeCompareReturnPath(value), null)
    assert.equal(boqDetailReturnHref("boq-1", value), "/boqs/boq-1")
  }
})

test("only legacy mode=review links request one-time canonicalization", () => {
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=review")), true)
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=Review")), false)
  assert.equal(isBoqReviewMode(new URLSearchParams("review=true")), false)
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- src/lib/boq-review-route.test.ts
```

Expected: FAIL because the four new route helpers are not exported.

- [ ] **Step 3: Implement the strict route helpers**

Add the following implementation to `src/lib/boq-review-route.ts`, retaining the existing helpers:

```ts
const INTERNAL_ORIGIN = "https://buildestimate.local"
const COMPARE_PATH = "/compare"

export function boqDetailHref(id: string): string {
  return `/boqs/${encodeURIComponent(id)}`
}

export function boqReviewHref(id: string): string {
  return boqDetailHref(id)
}

export function compareBoqHref(id: string): string {
  return `${COMPARE_PATH}?${new URLSearchParams({ boq: id }).toString()}`
}

export function safeCompareReturnPath(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (
    trimmed !== COMPARE_PATH
    && !trimmed.startsWith(`${COMPARE_PATH}?`)
  ) {
    return null
  }

  try {
    decodeURIComponent(trimmed)
  } catch {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed, INTERNAL_ORIGIN)
  } catch {
    return null
  }

  if (
    parsed.origin !== INTERNAL_ORIGIN
    || parsed.pathname !== COMPARE_PATH
    || parsed.hash
  ) {
    return null
  }

  if (!parsed.search) return COMPARE_PATH

  const keys = Array.from(parsed.searchParams.keys())
  const boqValues = parsed.searchParams.getAll("boq")
  if (
    keys.length !== 1
    || keys[0] !== "boq"
    || boqValues.length !== 1
  ) {
    return null
  }

  const boqId = boqValues[0]?.trim()
  if (!boqId) return null

  return compareBoqHref(boqId)
}

export function boqDetailReturnHref(
  id: string,
  returnTo: string | null | undefined,
): string {
  const safeReturnTo = safeCompareReturnPath(returnTo)
  if (!safeReturnTo) return boqDetailHref(id)

  const query = new URLSearchParams({ returnTo: safeReturnTo })
  return `${boqDetailHref(id)}?${query.toString()}`
}

export function boqComparisonReviewHref(id: string): string {
  return boqDetailReturnHref(id, compareBoqHref(id))
}

export function isBoqReviewMode(
  searchParams: Pick<URLSearchParams, "get">,
): boolean {
  return searchParams.get("mode") === "review"
}
```

- [ ] **Step 4: Re-run the route tests**

Run:

```bash
npm test -- src/lib/boq-review-route.test.ts
```

Expected: PASS for encoded opaque IDs, valid Compare destinations, invalid destinations, and legacy review detection.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/boq-review-route.ts src/lib/boq-review-route.test.ts
git commit -m "feat(navigation): add safe compare review routes"
```

### Task 2: Query Selection and Compare-to-Details Navigation

**Files:**

- Create: `src/lib/compare-boq-selection.ts`
- Create: `src/lib/compare-boq-selection.test.ts`
- Modify: `src/app/(authenticated)/compare/page.tsx:1-143`
- Modify: `src/app/(authenticated)/compare/compare-pricing-ui.test.ts:1-120`

**Interfaces:**

- Consumes: `boqComparisonReviewHref(id: string): string` from Task 1
- Produces: `resolveCompareBoqId(boqs, preferredId, currentId): string`
- Internal contract: `loadComparison(boqId: string): Promise<boolean>`
- Preserves: `BoqCatalogComponentTable`, summary cards, approved-row Match modal, and existing responsive CSS

- [ ] **Step 1: Create failing selection resolver tests**

Create `src/lib/compare-boq-selection.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { resolveCompareBoqId } from "./compare-boq-selection"

const boqs = [{ id: "first" }, { id: "preferred" }, { id: "current" }]

test("query selection wins when the requested BOQ exists", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "preferred", "current"),
    "preferred",
  )
})

test("an unknown query retains a current selection that still exists", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "missing", "current"),
    "current",
  )
})

test("an unknown query falls back to the first BOQ when current is stale", () => {
  assert.equal(
    resolveCompareBoqId(boqs, "missing", "removed"),
    "first",
  )
})

test("a removed current BOQ falls back safely without a query", () => {
  assert.equal(resolveCompareBoqId(boqs, null, "removed"), "first")
})

test("an empty BOQ list resolves to no selection", () => {
  assert.equal(resolveCompareBoqId([], "missing", "current"), "")
})
```

- [ ] **Step 2: Add failing Compare page wiring assertions**

Extend `src/app/(authenticated)/compare/compare-pricing-ui.test.ts` with:

```ts
test("unapproved BOQs use canonical Details navigation instead of ReviewPanel", () => {
  assert.match(source, /useSearchParams/)
  assert.match(source, /boqComparisonReviewHref/)
  assert.match(source, /resolveCompareBoqId/)
  assert.match(source, /router\.push\(boqComparisonReviewHref\(boq\.id\)\)/)
  assert.match(source, /href=\{boqComparisonReviewHref\(selected\.id\)\}/)
  assert.doesNotMatch(source, /ReviewPanel/)
  assert.doesNotMatch(source, /setReviewBoq|reviewBoq/)
})

test("compare separates BOQ-list and comparison failures", () => {
  assert.match(source, /boqLoadState/)
  assert.match(source, /comparisonLoadState/)
  assert.match(source, /Couldn&apos;t load BOQs/)
  assert.match(source, /Couldn&apos;t load this comparison/)
  assert.match(source, /loadBoqs\(\)/)
  assert.match(source, /loadComparison\(selectedId\)/)
})

test("compare cancels stale comparison work and suppresses false refresh success", () => {
  assert.match(source, /comparisonRequestRef/)
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /controller\.signal\.aborted/)
  assert.match(source, /comparisonRequestRef\.current !== controller/)
  assert.match(source, /if \(await loadComparison\(selected\.id\)\)/)
})

test("compare keeps matching actions on BOQ Details only", () => {
  assert.doesNotMatch(source, />AI suggest</)
  assert.doesNotMatch(source, />Dismiss</)
  assert.doesNotMatch(source, /Create and link item/)
  assert.match(source, /BoqCatalogComponentTable/)
  assert.match(source, /CatalogMatchModal/)
})

test("the preparation action remains usable on narrow screens", () => {
  assert.match(
    source,
    /data-od-id="compare-review-match"[^>]*className="[^"]*w-full[^"]*sm:w-auto/,
  )
  assert.match(source, /flex flex-wrap items-start justify-between/)
})
```

- [ ] **Step 3: Run both focused tests and verify failure**

Run:

```bash
npm test -- \
  src/lib/compare-boq-selection.test.ts \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
```

Expected: FAIL because the selection module and new navigation/load-state contracts do not exist.

- [ ] **Step 4: Implement the selection resolver**

Create `src/lib/compare-boq-selection.ts`:

```ts
import type { Boq } from "@/lib/boq-schema"

export function resolveCompareBoqId(
  boqs: readonly Pick<Boq, "id">[],
  preferredId: string | null | undefined,
  currentId: string,
): string {
  if (preferredId && boqs.some((boq) => boq.id === preferredId)) {
    return preferredId
  }

  if (currentId && boqs.some((boq) => boq.id === currentId)) {
    return currentId
  }

  return boqs[0]?.id ?? ""
}
```

- [ ] **Step 5: Replace the Compare ReviewPanel flow with router navigation**

In `src/app/(authenticated)/compare/page.tsx`:

1. Import `Suspense`, `useRef`, `useRouter`, `useSearchParams`, `Link`, `resolveCompareBoqId`, and `boqComparisonReviewHref`.
2. Remove the `ReviewPanel` import, `reviewBoq` state, and ReviewPanel JSX.
3. Wrap the query-reading content in `Suspense`:

```tsx
export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="proto-loading-state compare-state" role="status">
          <div>
            <span className="proto-spinner" aria-hidden="true" />
            Loading comparison workspace…
          </div>
        </div>
      }
    >
      <ComparePageContent />
    </Suspense>
  )
}

function ComparePageContent() {
```

1. Add distinct load-state types and abort detection:

```ts
type BoqLoadState = "loading" | "loaded" | "error"
type ComparisonLoadState = "idle" | "loading" | "loaded" | "error"

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
```

1. Replace the shared `loading` and `loadError` state with:

```ts
const router = useRouter()
const searchParams = useSearchParams()
const preferredBoqId = searchParams.get("boq")
const [boqLoadState, setBoqLoadState] =
  useState<BoqLoadState>("loading")
const [comparisonLoadState, setComparisonLoadState] =
  useState<ComparisonLoadState>("idle")
const boqRequestRef = useRef<AbortController | null>(null)
const comparisonRequestRef = useRef<AbortController | null>(null)
```

1. Make BOQ-list loading choose through the pure resolver and ignore superseded responses:

```ts
const loadBoqs = useCallback(async (preferredId?: string | null) => {
  boqRequestRef.current?.abort()
  comparisonRequestRef.current?.abort()

  const controller = new AbortController()
  boqRequestRef.current = controller
  setBoqLoadState("loading")
  setComparison(null)
  setComparisonLoadState("idle")

  try {
    const response = await fetch("/api/boqs?limit=1000", {
      signal: controller.signal,
    })
    if (!response.ok) throw new Error("BOQs could not be loaded")

    const data = await response.json() as { boqs?: Boq[] }
    if (
      controller.signal.aborted
      || boqRequestRef.current !== controller
    ) {
      return
    }

    const next = data.boqs ?? []
    setBoqs(next)
    setSelectedId((current) =>
      resolveCompareBoqId(next, preferredId, current),
    )
    setBoqLoadState("loaded")
  } catch (error) {
    if (
      controller.signal.aborted
      || boqRequestRef.current !== controller
      || isAbortError(error)
    ) {
      return
    }

    setBoqLoadState("error")
  }
}, [])

useEffect(() => {
  void loadBoqs(preferredBoqId)
  return () => {
    boqRequestRef.current?.abort()
  }
}, [loadBoqs, preferredBoqId])
```

1. Make comparison loading clear old rows, return success/failure, and ignore late responses:

```ts
const loadComparison = useCallback(
  async (boqId: string): Promise<boolean> => {
    comparisonRequestRef.current?.abort()

    if (!boqId) {
      setComparison(null)
      setComparisonLoadState("idle")
      return false
    }

    const controller = new AbortController()
    comparisonRequestRef.current = controller
    setComparison(null)
    setComparisonLoadState("loading")

    try {
      const response = await fetch(
        `/api/boqs/${encodeURIComponent(boqId)}/comparison`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        throw new Error("Comparison could not be loaded")
      }

      const next = await response.json() as ComparisonResponse
      if (
        controller.signal.aborted
        || comparisonRequestRef.current !== controller
      ) {
        return false
      }

      setComparison(next)
      setComparisonLoadState("loaded")
      return true
    } catch (error) {
      if (
        controller.signal.aborted
        || comparisonRequestRef.current !== controller
        || isAbortError(error)
      ) {
        return false
      }

      setComparison(null)
      setComparisonLoadState("error")
      return false
    }
  },
  [],
)
```

1. Retain the approved-only comparison effect and abort on cleanup:

```ts
useEffect(() => {
  if (
    boqLoadState !== "loaded"
    || !selected
    || selected.status !== "approved"
  ) {
    comparisonRequestRef.current?.abort()
    return
  }

  void loadComparison(selected.id)
  return () => {
    comparisonRequestRef.current?.abort()
  }
}, [boqLoadState, loadComparison, selected])
```

1. Clear stale comparison state immediately when the user selects another BOQ:

```ts
const handleSelectionChange = (nextId: string) => {
  comparisonRequestRef.current?.abort()
  setSelectedId(nextId)
  setComparison(null)
  setComparisonLoadState("idle")
}
```

 1. Route a newly uploaded BOQ to Details:

```ts
const handleUploadComplete = (boq: Boq) => {
  setUploadOpen(false)
  router.push(boqComparisonReviewHref(boq.id))
}
```

 1. Replace the preparation button with a responsive `Link`:

```tsx
<Link
  href={boqComparisonReviewHref(selected.id)}
  className="btn btn-primary w-full sm:w-auto"
  data-od-id="compare-review-match"
>
  Review, match &amp; approve
</Link>
```

 1. Render list and comparison states independently:
    - `boqLoadState === "loading"`: “Loading BOQs…”
    - `boqLoadState === "error"`: “Couldn’t load BOQs” with `loadBoqs(preferredBoqId)`
    - loaded empty list: existing Upload BOQ state
    - loaded draft: preparation card
    - loaded approved plus `comparisonLoadState === "loading"`: “Comparing BOQ to catalog…”
    - loaded approved plus `comparisonLoadState === "error"`: existing comparison error with `loadComparison(selectedId)`
    - loaded approved plus rows: existing `BoqCatalogComponentTable`

 2. Preserve the approved comparison Match modal but only toast after a successful refresh:

```tsx
onMatch={async () => {
  setMatchTarget(null)
  if (await loadComparison(selected.id)) {
    toast.success("Comparison refreshed")
  }
}}
```

- [ ] **Step 6: Re-run the Compare-focused tests**

Run:

```bash
npm test -- \
  src/lib/compare-boq-selection.test.ts \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
```

Expected: PASS, including existing grouped-component and mobile table contracts.

- [ ] **Step 7: Commit Task 2**

```bash
git add \
  src/lib/compare-boq-selection.ts \
  src/lib/compare-boq-selection.test.ts \
  'src/app/(authenticated)/compare/page.tsx' \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts'
git commit -m "feat(compare): route draft BOQs through details"
```

### Task 3: BOQ Details Approval Return and Blocker Preservation

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:168-284`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:292-310`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:863-893`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:1015-1095`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts:1-40`

**Interfaces:**

- Consumes: `safeCompareReturnPath` and `boqDetailReturnHref` from Task 1
- Extends internal `CanonicalBoqWorkspace` props with:
  - `backHref: string`
  - `backLabel: string`
  - `onApproved: (approved: Boq) => void`
- Preserves all existing BOQ mutation and catalog-action handlers

- [ ] **Step 1: Add failing BOQ Details source-contract tests**

Extend `src/app/(authenticated)/boqs/[id]/page.test.ts`:

```ts
function sourceSection(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  assert.ok(startIndex >= 0, `missing source marker: ${start}`)
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test("validates compare returnTo and preserves it while removing legacy mode", () => {
  assert.match(source, /safeCompareReturnPath/)
  assert.match(source, /searchParams\.get\("returnTo"\)/)
  assert.match(source, /boqDetailReturnHref\(id,\s*returnTo\)/)
  assert.match(source, /router\.replace\(returnTo/)
})

test("approval redirects only from the successful response branch", () => {
  const approval = sourceSection(
    "const handleApprove",
    "const reloadAfterManualMatch",
  )
  const responseCheck = approval.indexOf("if (!response.ok)")
  const approvedCallback = approval.indexOf("onApproved(approved)")
  const catchBlock = approval.indexOf("catch (error)")

  assert.ok(responseCheck >= 0)
  assert.ok(approvedCallback > responseCheck)
  assert.ok(catchBlock > approvedCallback)
  assert.doesNotMatch(approval.slice(catchBlock), /onApproved/)
})

test("every existing approval blocker remains before the approval request", () => {
  const approval = sourceSection(
    "const handleApprove",
    "const reloadAfterManualMatch",
  )
  const requestIndex = approval.indexOf("await fetch")

  for (const guard of [
    "invalidDraftRef.current.size > 0",
    "pendingChanges > 0",
    "verification.hasBlockingIssues",
    "catalogReadiness.blocking > 0",
  ]) {
    const guardIndex = approval.indexOf(guard)
    assert.ok(guardIndex >= 0, `missing approval guard: ${guard}`)
    assert.ok(guardIndex < requestIndex, `${guard} must run before fetch`)
  }
})

test("approval exposes progress and disables duplicate mutations", () => {
  assert.match(source, /aria-busy=\{approving\}/)
  assert.match(source, /approving \? "Approving…" : "Approve BOQ"/)
  assert.match(source, /const mutationBusy[\s\S]*approving/)
})

test("compare-origin Details navigation has a safe manual recovery path", () => {
  assert.match(source, /backHref=\{returnTo \?\? "\/boqs"\}/)
  assert.match(source, /returnTo \? "Back to comparison" : "Back to BOQs"/)
  assert.match(source, /href=\{backHref\}/)
})

test("BOQ Details remains the canonical catalog action workspace", () => {
  assert.match(source, /onAiSuggest=/)
  assert.match(source, /onDismissSuggestion=/)
  assert.match(source, /onFindMatch=/)
  assert.match(source, /onExclude=/)
  assert.match(source, /CatalogMatchModal/)
  assert.match(source, /catalogReadiness\.blocking/)
})

test("load and approval failures stay on Details with recovery controls", () => {
  assert.match(source, /Couldn’t load this BOQ/)
  assert.match(source, /onClick=\{\(\) => void fetchBoq\(\)\}/)
  assert.match(source, /Failed to approve BOQ/)
  assert.match(source, /setApproving\(false\)/)
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL because safe return wiring, approval callback, progress copy, and Compare recovery links do not exist.

- [ ] **Step 3: Read and validate the return context in `BoqDetailContent`**

Import `boqDetailReturnHref` and `safeCompareReturnPath`, then derive:

```ts
const rawReturnTo = searchParams.get("returnTo")
const returnTo = safeCompareReturnPath(rawReturnTo)
const legacyReviewMode = isBoqReviewMode(searchParams)
const shouldCanonicalizeUrl =
  legacyReviewMode
  || (rawReturnTo !== null && returnTo === null)
```

Replace the legacy canonicalization effect with:

```ts
useEffect(() => {
  if (!shouldCanonicalizeUrl) return
  router.replace(boqDetailReturnHref(id, returnTo), { scroll: false })
}, [id, returnTo, router, shouldCanonicalizeUrl])
```

This produces the following exact outcomes:

- `mode=review&returnTo=<valid>` → canonical Details URL retaining `returnTo`
- `mode=review&returnTo=<invalid>` → canonical Details URL without query
- invalid `returnTo` without legacy mode → canonical Details URL without query
- valid `returnTo` without legacy mode → URL remains unchanged

- [ ] **Step 4: Add safe recovery navigation and approval callback props**

For the not-found state, use:

```tsx
<Link
  href={returnTo ?? "/boqs"}
  className="btn btn-secondary"
>
  {returnTo ? "Back to comparison" : "Back to BOQs"}
</Link>
```

Pass explicit navigation props to the workspace:

```tsx
return (
  <CanonicalBoqWorkspace
    key={boq.id}
    boq={boq}
    onBoqChange={setBoq}
    backHref={returnTo ?? "/boqs"}
    backLabel={returnTo ? "Back to comparison" : "Back to BOQs"}
    onApproved={() => {
      if (returnTo) {
        router.replace(returnTo, { scroll: false })
      }
    }}
  />
)
```

Extend the workspace signature:

```ts
function CanonicalBoqWorkspace({
  boq,
  onBoqChange,
  backHref,
  backLabel,
  onApproved,
}: {
  boq: Boq
  onBoqChange: (next: Boq) => void
  backHref: string
  backLabel: string
  onApproved: (approved: Boq) => void
}) {
```

Replace the fixed header link with:

```tsx
<Link href={backHref} className="boq-back-link">
  <ChevronLeft aria-hidden="true" />
  {backLabel}
</Link>
```

- [ ] **Step 5: Invoke return navigation only after successful approval**

Replace the successful portion of `handleApprove` with:

```ts
if (!response.ok) {
  throw new Error(await readError(response, "Failed to approve BOQ"))
}

const approved = await response.json() as Boq
applyMutationBoq(approved)
toast.success("BOQ approved and linked to the Standard Catalog")
onApproved(approved)
```

Do not call `onApproved` from guards, `catch`, or `finally`. Without a safe return path, the parent callback is a no-op and the newly approved BOQ remains visible read-only.

- [ ] **Step 6: Make approval progress explicit and accessible**

On the Approve button, add:

```tsx
aria-busy={approving}
```

Replace its fixed label with:

```tsx
{approving ? "Approving…" : "Approve BOQ"}
```

Keep the current spinner, `mutationBusy`, invalid draft, pending change, review blocker, and catalog readiness disabling conditions unchanged.

- [ ] **Step 7: Re-run route and Details tests**

Run:

```bash
npm test -- \
  src/lib/boq-review-route.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  src/components/inline-catalog-cell.test.ts \
  src/components/unified-boq-items-table.test.ts
```

Expected: PASS. The inline catalog tests confirm AI Suggest, Find Match, Dismiss, Exclude, and catalog-modal entry points remain in the canonical Details workflow.

- [ ] **Step 8: Commit Task 3**

```bash
git add \
  'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
git commit -m "feat(boqs): return approved reviews to compare"
```

### Task 4: Integrated Validation and Browser Edge-State QA

**Files:**

- Verify only; do not add production code unless a failing check identifies a defect within this plan’s scope.

**Dependencies:**

- Requires Tasks 1–3.

- [ ] **Step 1: Run all focused navigation and UI tests**

```bash
npm test -- \
  src/lib/boq-review-route.test.ts \
  src/lib/compare-boq-selection.test.ts \
  'src/app/(authenticated)/compare/compare-pricing-ui.test.ts' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  src/components/inline-catalog-cell.test.ts \
  src/components/unified-boq-items-table.test.ts \
  'src/app/api/boqs/[id]/comparison/comparison-api.test.ts'
```

Expected: all selected tests pass.

- [ ] **Step 2: Run the complete project check**

```bash
npm run check
```

Expected: ESLint, `tsc --noEmit`, and the complete Node test suite pass.

- [ ] **Step 3: Update the repository graph**

```bash
graphify update .
```

Expected: graph update completes without source-analysis errors.

- [ ] **Step 4: Check whitespace and repository scope**

```bash
git diff --check
git status --short
```

Expected:

- No whitespace errors.
- Only files named in this plan and expected `graphify-out/` updates are changed.
- `Quotation example/` is neither read nor staged.

- [ ] **Step 5: Start local browser QA**

```bash
npm run dev
```

Use local development data or mocked API responses. Do not use production data or files from `Quotation example/`.

- [ ] **Step 6: Validate desktop flow at 1440 px**

1. Open `/compare?boq=<known-draft-id>`.
2. Confirm the requested draft is selected.
3. Confirm Compare shows preparation status but none of AI Suggest, Dismiss, Create New, or Exclude.
4. Activate **Review, match & approve**.
5. Confirm the destination is `/boqs/<encoded-id>?returnTo=<encoded-compare-url>`.
6. Confirm BOQ Details exposes Find Match, AI Suggest, Dismiss after a suggestion, Exclude, and Create New inside the Match modal.
7. With unresolved catalog lines, confirm Approve remains disabled.
8. Resolve catalog lines but retain a verification blocker; confirm Approve remains disabled.
9. Create an unsaved field edit; confirm approval remains blocked until Save draft.
10. Enter an invalid component cost draft; confirm Save and Approve remain disabled.
11. During approval, confirm the spinner, “Approving…”, and disabled mutation controls.
12. Complete approval and confirm automatic return to `/compare?boq=<id>`.
13. Confirm the same approved BOQ is selected and its comparison loads.

- [ ] **Step 7: Validate URL and failure edges**

1. Open `/compare?boq=missing-id`; confirm a valid current BOQ or the first BOQ is selected.
2. Open a missing Details ID with a valid Compare `returnTo`; confirm BOQ not found and **Back to comparison**.
3. Open Details with an encoded external `returnTo`; confirm it is removed and never navigated.
4. Open Details with `mode=review` plus a valid Compare `returnTo`; confirm only `mode=review` is removed.
5. Simulate offline mode before approval; confirm the failure toast, progress reset, and no redirect.
6. Simulate comparison API failure after returning; confirm comparison-specific Retry.
7. Restore connectivity and activate Retry; confirm the current approved BOQ loads.
8. Switch quickly between two approved BOQs; confirm rows from the first never appear under the second.
9. Switch from an approved BOQ to a draft while loading; confirm old comparison rows disappear immediately.
10. Fail a Match-triggered comparison refresh; confirm no false “Comparison refreshed” toast.

- [ ] **Step 8: Validate mobile flow at 390 px**

1. Open draft preparation on Compare.
2. Confirm summary cards and toolbar stack.
3. Confirm the preparation CTA spans available width.
4. Confirm no horizontal page overflow.
5. Navigate to Details and confirm existing matching actions remain usable.
6. Approve and return to Compare.
7. Confirm the approved component comparison retains its established mobile card layout and labels.

- [ ] **Step 9: Compare against Open Design**

Review the latest **BuildEstimate Compare Component UI** Open Design artifact:

- Preserve its light Airtable-style hierarchy, spacing, badge treatment, and action emphasis.
- Apply only localized class or copy corrections needed to match the approved navigation states.
- Do not add matching actions to Compare or introduce a second review workspace.

- [ ] **Step 10: Record final evidence**

Capture:

```bash
git log -3 --oneline
git status --short
```

Record focused test results, full `npm run check` result, desktop/mobile screenshots, graph update result, and final commit hashes in the implementation handoff.

## Dependencies

1. Task 1 must complete before Tasks 2 and 3 because both consume the new route helpers.
2. Task 2 and Task 3 are logically independent after Task 1 but should execute sequentially in one worktree to preserve the single-writer rule.
3. Task 4 requires all implementation commits.
4. Open Design review may refine classes or copy only; it must not alter the approved route architecture.

## Risks

- `useSearchParams()` can fail production builds without the planned `Suspense` boundary.
- Nested query encoding can accidentally double-decode opaque BOQ IDs; route-helper tests must remain exact.
- A late comparison response can overwrite the selected BOQ unless both abort and request-identity checks are retained.
- The existing tests use source-contract assertions for page wiring; browser QA remains necessary for navigation timing and responsive behavior.
- `page.tsx` for BOQ Details is large. Limit edits to named blocks and avoid formatter-driven whole-file churn.
- Strict return validation intentionally rejects additional Compare query parameters. Expand the allowlist only through a later explicit product decision.
- Open Design output may suggest visual polish after this plan. Such polish is acceptable only when it does not duplicate Details actions or widen workflow scope.

## Plan Self-Review

- Spec coverage: every approved navigation, validation, canonical action, error, and responsive requirement maps to Tasks 1–4.
- Type consistency: route helper and selection resolver signatures are identical across producer and consumer tasks.
- Scope: no API schema, persistence, parser, catalog matching, or comparison pricing changes are included.
- Validation: focused tests, full checks, graph update, desktop QA, mobile QA, and malicious URL cases are explicit.
