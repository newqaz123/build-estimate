# BOQ Import Reliability & UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "import saved but shows error" bug and apply six targeted UX/UI fixes (page-preview magnifier, upload-modal centering, optional exclude reason, confirm-only delete, pi-lens diagnostics).

**Architecture:** Backend change (Task 1) decouples the already-succeeded BOQ import from best-effort post-import cleanup. Tasks 2–5 are isolated frontend component/CSS/handler edits. Task 6 is lint/diagnostic hygiene. Each task is independently testable and revertable.

**Tech Stack:** Next.js 16 (App Router, React 19, base-ui dialog), TypeScript, node:test + tsx, Tailwind v4 + CSS custom properties, Firestore/GCS sidecar state.

## Global Constraints

- Run `npm run check` (eslint + tsc + `tsx --test`) after every code change; the suite must stay green.
- Run `cd py-sidecar && ../.venv-docling/bin/python -m unittest test_main -v` after any Python change.
- No new runtime dependencies. No production data migrations locally.
- Preserve existing accessible labels (`aria-label`, `aria-pressed`, `role`); do not regress `boq-preflight.test.ts` / `boq-ingestion-flow.test.ts` source-contract assertions.
- Keep the three-layer review/accept/skip invariants in `boq-extraction-*` untouched.

## File Structure

| File | Responsibility | Touched by |
| ------ | ---------------- | ----------- |
| `src/lib/boq-preflight-service.ts` | `consumePreflight` orchestration; make post-import consumed-cleanup best-effort | Task 1 |
| `src/lib/boq-preflight-service.test.ts` | unit tests for consumePreflight cleanup | Task 1 |
| `src/components/boq-preflight.tsx` | page-selection UI; mouse-following magnifier, no clip | Task 2 |
| `src/components/boq-preflight.test.ts` | source-contract tests for magnifier | Task 2 |
| `src/styles/globals.css` | `.preflight-magnifier` positioning + dialog centering | Tasks 2, 3 |
| `src/components/ui/dialog.tsx` | `DialogContent` centering guarantee | Task 3 |
| `src/components/upload-modal.tsx` | upload modal wrapper | Task 3 |
| `src/app/(authenticated)/boqs/[id]/page.tsx` | `handleExclude` (optional reason), delete handler | Tasks 4, 5 |
| `src/app/(authenticated)/boqs/page.tsx` | `handleDeleteBoq` (confirm-only) | Task 5 |
| `src/components/pdf-review-viewer.tsx` | nested `<a>` lint fix | Task 6 |
| `pyrightconfig.json` (new) / `.pi-lens` dismissal | py-sidecar env resolution + stale dismissals | Task 6 |

---

### Task 1: Best-effort post-import cleanup so a successful import never returns 500

**Files:**

- Modify: `src/lib/boq-preflight-service.ts` (the `consumePreflight` method, ~line 263-281)
- Test: `src/lib/boq-preflight-service.test.ts`

**Root cause:** `consumePreflight` runs `operation(context)` (which calls `importPdf` and saves the BOQ) **before** it calls `store.update({status:'consumed'})`. The Firestore store's `update` runs `deleteArtifacts()` for any terminal status, and `deleteArtifacts` deletes GCS blobs + the Firestore doc. If **any** step of that cleanup throws (missing blob, transient GCS error, doc race), the error propagates out of `consumePreflight`, the catch block restores the record to `ready`, re-throws, and the import handler returns `500 "The BOQ import could not be saved. Try again."` — even though the BOQ was already written by `importPdf`. This matches the reported symptom exactly.

**Interfaces:**

- Produces: `consumePreflight` still returns `PreflightImportContext & { operationResult }`; the consumed-transition/cleanup failure must no longer abort a successful import.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/boq-preflight-service.test.ts`:

```ts
test('consumePreflight returns operationResult even when the consumed cleanup throws', async () => {
  const record = mockPreflightRecord({ status: 'ready', pageCount: 2 })
  let consumeUpdateCalled = false
  const store = {
    create: async () => record,
    getOwned: async () => ({ ...record }),
    update: async (_id: string, _ownerId: string, patch: PreflightUpdatePatch, conditions?: PreflightUpdateConditions) => {
      // reserve: ready -> analyzing
      if (patch.status === 'analyzing') return { ...record, ...patch, status: 'analyzing' as const }
      // consumed transition: simulate cleanup failure (GCS delete error)
      if (patch.status === 'consumed') {
        consumeUpdateCalled = true
        throw new Error('GCS delete failed: source.pdf not found')
      }
      return { ...record, ...patch }
    },
    deleteArtifacts: async () => false,
    claimExpired: async () => [],
  } as unknown as Parameters<typeof createPreflightService>[0]['store']

  const imported = { id: 'boq-saved', project: 'Saved' }
  const service = createPreflightService({
    store,
    storageAdapter: {
      saveSource: async () => 'source.pdf',
      loadSource: async () => new File([Buffer.from('%PDF')], 'source.pdf', { type: 'application/pdf' }),
    },
    analysisAdapter: { analyzePdf: async () => [] },
    requireSinglePdf: (file) => file,
    createId: () => 'preflight-1',
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  })

  const result = await service.consumePreflight(
    'preflight-1', 'user-1', { pages: [1] },
    async () => imported,
  )

  assert.equal(consumeUpdateCalled, true, 'consumed transition must still be attempted')
  assert.equal(result.operationResult, imported, 'import result must be returned despite cleanup failure')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/boq-preflight-service.test.ts`
Expected: FAIL — `consumePreflight` throws `'GCS delete failed...'` instead of returning `operationResult`.

- [ ] **Step 3: Implement the fix**

In `src/lib/boq-preflight-service.ts`, inside `consumePreflight`, change the post-operation block so the consumed transition is best-effort. Replace:

```ts
        const operationResult = await operation(context);
        await store.update(
          id,
          actorId,
          {
            status: "consumed",
            confirmedPages: validated.pages,
            importReservationToken: null,
            importReservationLeaseExpiresAt: null,
          },
          {
            expectedStatus: "analyzing",
            expectedReservationToken: reservationToken,
            expectedReservationLeaseExpiresAt: reservationLeaseExpiresAt,
          },
        );
        return { ...context, operationResult };
```

with:

```ts
        const operationResult = await operation(context);
        // The import already succeeded. The consumed transition + artifact cleanup
        // is best-effort: a GCS/Firestore cleanup failure must NOT turn a saved BOQ
        // into a 500. Log and continue so the client receives its saved BOQ.
        try {
          await store.update(
            id,
            actorId,
            {
              status: "consumed",
              confirmedPages: validated.pages,
              importReservationToken: null,
              importReservationLeaseExpiresAt: null,
            },
            {
              expectedStatus: "analyzing",
              expectedReservationToken: reservationToken,
              expectedReservationLeaseExpiresAt: reservationLeaseExpiresAt,
            },
          );
        } catch (cleanupError) {
          console.error("Preflight post-import cleanup failed", cleanupError);
        }
        return { ...context, operationResult };
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsx --test src/lib/boq-preflight-service.test.ts`
Expected: PASS (all, including the new test and the existing concurrent-import test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-preflight-service.ts src/lib/boq-preflight-service.test.ts
git commit -m "fix: keep successful BOQ import from failing on best-effort cleanup"
```

---

### Task 2: Page-preview magnifier follows the cursor and is never clipped

**Files:**

- Modify: `src/components/boq-preflight.tsx` (magnifier render + mouse tracking)
- Modify: `src/styles/globals.css` (`.preflight-magnifier` → viewport-anchored, edge-aware)
- Test: `src/components/boq-preflight.test.ts`

**Root cause:** `.preflight-magnifier` is `position:absolute; top:50%; left:50%; transform:translate(-50%,-50%)` — centered over the thumbnail. Inside the modal (which has its own stacking/overflow), it renders centered and is clipped at the modal edges, so only part of the preview shows. Requirement: show next to the mouse, not center, and never clip.

**Interfaces:**

- Produces: magnifier tracks pointer via `onMouseMove` on the thumbnail button; popup uses `position:fixed` with edge-flip so it stays fully on-screen.

- [ ] **Step 1: Write the failing source-contract test**

In `src/components/boq-preflight.test.ts`, update/replace the magnifier test:

```ts
test('BoqPreflight magnifier follows the pointer and avoids center/clip', () => {
  const source = readFileSync(preflightSourcePath, "utf8")
  // Tracks pointer coordinates from the thumbnail, not centered.
  assert.match(source, /onMouseMove=/)
  assert.match(source, /setMagnifierPos|magnifierPos|pointer/)
  // Popup must be viewport-anchored (fixed) so it never clips inside the modal.
  assert.match(source, /preflight-magnifier/)
  // CSS assertion: the class is no longer hard-centered over the thumbnail.
  const css = readFileSync(globalCssPath, "utf8")
  assert.doesNotMatch(css, /\.preflight-magnifier\s*\{[^}]*top:\s*50%[^}]*left:\s*50%[^}]*transform:\s*translate\(-50%,\s*-50%\)/s)
})
```

(Add `const globalCssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "globals.css")` near the top if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/boq-preflight.test.ts`
Expected: FAIL — current code centers (no `onMouseMove` pointer tracking).

- [ ] **Step 3: Implement pointer tracking in the component**

In `src/components/boq-preflight.tsx`:

- Add state `const [magnifierPos, setMagnifierPos] = useState<{ x: number; y: number } | null>(null)`
- On each thumbnail button, add `onMouseMove={(e) => setMagnifierPos({ x: e.clientX, y: e.clientY })}`, keep existing `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur` for `magnifiedPage`.
- Render the magnifier with an inline `style` computed from `magnifierPos` that flips left/up when near the right/bottom viewport edge, e.g.:

```tsx
{isMagnified && magnifierPos && (
  <div
    role="img"
    aria-label={`Magnified Page ${pageInfo.page}`}
    className="preflight-magnifier"
    style={{
      top: magnifierPos.y,
      left: magnifierPos.x + (magnifierPos.x > window.innerWidth - 360 ? -340 : 20),
      transform: magnifierPos.x > window.innerWidth - 360 ? "translate(0,-50%)" : "translate(0,-50%)",
    }}
  >
    {/* existing image / empty / info children */}
  </div>
)}
```

(Keep the existing image/empty/info inner markup; only the positioning wrapper changes.)

- [ ] **Step 4: Update CSS so the popup is viewport-anchored and not clipped**

In `src/styles/globals.css`, change `.preflight-magnifier`:

```css
.preflight-magnifier {
  position: fixed;
  z-index: 1000;
  width: 320px;
  transform: translate(0, -50%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-raised);
  overflow: hidden;
  pointer-events: none;
}
```

(Delete the old `top:50%; left:50%; transform:translate(-50%,-50%)` rule. The component now supplies `top`/`left`.)

- [ ] **Step 5: Run tests + browser check**

Run: `npx tsx --test src/components/boq-preflight.test.ts src/components/boq-ingestion-flow.test.ts`
Expected: PASS. Manual: hover a thumbnail — popup appears beside the cursor, flips when near the right edge, never clipped by the modal.

- [ ] **Step 6: Commit**

```bash
git add src/components/boq-preflight.tsx src/components/boq-preflight.test.ts src/styles/globals.css
git commit -m "fix: page-preview magnifier follows cursor and never clips inside modal"
```

---

### Task 3: Center the upload modal (not top-left)

**Files:**

- Modify: `src/components/ui/dialog.tsx` (`DialogContent`)
- Modify: `src/styles/globals.css` (defensive centering rule)
- Test: manual + existing `boq-ingestion-flow.test.ts` stays green

**Root cause:** `DialogContent` already passes `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`, but the modal renders top-left in practice. The base-ui `DialogPrimitive.Popup` can apply its own positioning that overrides Tailwind translate utilities (transform collision), and there is no defensive CSS rule pinning the center.

- [ ] **Step 1: Add a defensive centered rule in CSS**

In `src/styles/globals.css` (after the preflight block), add:

```css
/* Guarantee dialog centering even when base-ui popup overrides Tailwind transforms. */
[data-slot="dialog-content"].upload-modal,
[data-slot="dialog-content"].modal {
  position: fixed !important;
  top: 50% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) !important;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
}
```

- [ ] **Step 2: Verify the dialog still composes its classes**

Read `src/components/ui/dialog.tsx` — confirm `DialogContent` keeps `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2` and `data-slot="dialog-content"`. No change needed unless the slot is missing; if missing, add `data-slot="dialog-content"` (it is already present).

- [ ] **Step 3: Run tests + manual check**

Run: `npx tsx --test src/components/boq-ingestion-flow.test.ts src/components/boq-preflight.test.ts`
Expected: PASS. Manual: open the upload modal — it is centered, scrollable on small screens.

- [ ] **Step 4: Commit**

```bash
git add src/styles/globals.css src/components/ui/dialog.tsx
git commit -m "fix: center upload modal on viewport"
```

---

### Task 4: Make the exclude reason optional

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx` (`handleExclude` guard + button `disabled`)

**Root cause:** `handleExclude` guards on `!excludeReason.trim()` and the Exclude button is `disabled={!excludeReason.trim() || matching}`, forcing a non-empty reason.

- [ ] **Step 1: Update the handler guard**

In `handleExclude`, change the first guard from:

```ts
if (!excludeTarget || !exclusionReason.trim() || isReadOnly || mutationBusy) return
```

to:

```ts
if (!excludeTarget || isReadOnly || mutationBusy) return
```

- [ ] **Step 2: Send reason only when provided**

In the same handler, in the PATCH body item, change:

```ts
stdExclusionReason: excludeReason.trim(),
```

to:

```ts
...(excludeReason.trim() ? { stdExclusionReason: excludeReason.trim() } : {}),
```

- [ ] **Step 3: Enable the button without a reason**

Change the Exclude button `disabled` from `!excludeReason.trim() || matching` to `matching`.

- [ ] **Step 4: Update the dialog copy to signal optional**

In the exclude `DialogDescription`, append `(optional)`, and change the reason `placeholder` to e.g. `"Optional — reason this line should not use catalog pricing"`. Keep `autoFocus`.

- [ ] **Step 5: Run tests + manual**

Run: `npm run check`
Expected: PASS. Manual: open a BOQ, click Exclude on a row — dialog opens with reason optional; submit with empty reason succeeds.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/boqs/[id]/page.tsx"
git commit -m "ux: make exclude reason optional"
```

---

### Task 5: Delete BOQ via confirm only (no typed project name)

**Files:**

- Modify: `src/app/(authenticated)/boqs/page.tsx` (`handleDeleteBoq`)
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx` (`handleDeleteBoq`)

**Root cause:** Both delete handlers use `window.prompt` and require the typed project name to match before deleting. Requirement: a simple confirm dialog only.

- [ ] **Step 1: Replace prompt with confirm in `boqs/page.tsx`**

Change `handleDeleteBoq` to:

```ts
const handleDeleteBoq = async (boq: Boq) => {
  const confirmed = window.confirm(
    `Delete the entire BOQ “${boq.project}” and its source PDF? This cannot be undone.`,
  )
  if (!confirmed) return
  const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, { method: "DELETE" })
  if (!response.ok) {
    toast.error("The BOQ could not be deleted")
    return
  }
  toast.success("BOQ deleted")
  void fetchBoqs()
}
```

- [ ] **Step 2: Replace prompt with confirm in `boqs/[id]/page.tsx`**

Change `handleDeleteBoq`'s prompt block:

```ts
const confirmation = window.prompt(`Delete the entire BOQ and source PDF? Type “${boq.project}” to confirm.`)
if (confirmation !== boq.project) return
```

to:

```ts
const confirmed = window.confirm(
  `Delete the entire BOQ “${boq.project}” and its source PDF? This cannot be undone.`,
)
if (!confirmed) return
```

- [ ] **Step 3: Run tests + manual**

Run: `npm run check`
Expected: PASS. Manual: delete from the BOQ list and from the detail page — both show a confirm dialog (no typing); Cancel aborts, OK deletes.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(authenticated)/boqs/page.tsx" "src/app/(authenticated)/boqs/[id]/page.tsx"
git commit -m "ux: delete BOQ via confirm dialog without typing project name"
```

---

### Task 6: Resolve pi-lens diagnostics (30E / 23W)

**Files:**

- Modify: `src/components/pdf-review-viewer.tsx` (nested `<a>` → remove nesting)
- Create: `pyrightconfig.json` (venv path so py-sidecar imports resolve)
- Verify/dismiss: `src/lib/boq-preflight-analysis-adapter.ts` stale `pdf.worker.mjs` error

**Triage of the 30 errors / 23 warnings:**

- **REAL — fix:** `pdf-review-viewer.tsx` L373/L399/L420 `ast-grep:no-nested-links` (a `<Button render={<a>}>` containing another link). Break the nesting.
- **STALE — verify & dismiss:** `boq-preflight-analysis-adapter.ts` L63 `Could not find declaration for 'pdfjs-dist/legacy/build/pdf.worker.mjs'`. `src/types/pdfjs-dist-worker.d.ts` already declares it and `tsc --noEmit` is clean → the lens cache is stale. Dismiss via `lens_diagnostic_mark` (false-positive) after confirming.
- **ENV (not code) — config:** the ~24 `py-sidecar/*.py` `reportMissingImports` (fastapi/pydantic/docling/pypdf) are pyright using the wrong interpreter. Add a `pyrightconfig.json` pointing at `.venv-docling`.
- **ACCEPTABLE — dismiss:** `console.error` server-logging warnings in `boq-preflight-api.ts` (intentional), `missing-error-propagation` (HTTP handlers return `Response`, not throw). Mark as defer/false-positive.
- **DEFER (out of scope, file issue later):** cyclomatic-complexity / fan-out warnings on `PdfReviewViewer`, `createPreflightService`, `BoqPreflight`.

- [ ] **Step 1: Inspect and fix nested links in pdf-review-viewer.tsx**

Run: `npx ast-grep --pattern '<a $$$BODY</a>' src/components/pdf-review-viewer.tsx` (or read L365–425). Identify where a `<Button render={<a href=...>}>` wraps another `<a>` (likely the "Open PDF"/"Retry preview" links). Replace the outer `render={<a>}` with a plain `<Button asChild>`/`<a>` so no `<a>` nests another `<a>`. If the inner element is an icon-only link, convert the inner to a `<span>` and keep the single outer `<a>`.

- [ ] **Step 2: Add pyright config for py-sidecar**

Create `pyrightconfig.json`:

```json
{
  "include": ["py-sidecar"],
  "exclude": ["**/__pycache__", "**/node_modules", ".venv-docling"],
  "venvPath": ".",
  "venv": ".venv-docling",
  "reportMissingImports": "none",
  "typeCheckingMode": "basic"
}
```

(Setting `reportMissingImports: "none"` silences false env-resolution errors; real import bugs still surface at `unittest` runtime.)

- [ ] **Step 3: Verify the stale pdfjs declaration**

Run: `npx tsc --noEmit`
Expected: clean (no pdfjs errors). Then mark the lens finding false-positive via the situational tool:

Run: `pi_lens_activate_tools` is not needed; use `lens_diagnostic_mark` on `src/lib/boq-preflight-analysis-adapter.ts:63` → `false-positive`.

- [ ] **Step 4: Run full check + lens**

Run: `npm run check` and `cd py-sidecar && ../.venv-docling/bin/python -m unittest test_main -v`
Expected: both green. Run `lens_diagnostics mode=all` and confirm only the accepted/deferred warnings remain (no real errors).

- [ ] **Step 5: Commit**

```bash
git add src/components/pdf-review-viewer.tsx pyrightconfig.json
git commit -m "chore: fix nested links and configure pyright for py-sidecar venv"
```

---

## Self-Review

**1. Spec coverage:**

- "import saved but shows error" → Task 1 ✓
- "magnifier clipped, show beside mouse not center" → Task 2 ✓
- "center upload window" → Task 3 ✓
- "check pi-lens 30E 23W" → Task 6 ✓
- "exclude optional comment" → Task 4 ✓
- "delete BOQ confirm only" → Task 5 ✓

**2. Placeholder scan:** No TBD/TODO/vague steps; each code step contains real code.

**3. Type consistency:** `consumePreflight` return shape unchanged (`PreflightImportContext & { operationResult? }`); `stdExclusionReason` made conditional but field name unchanged; `Dialog`/`DialogContent` slots unchanged.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-import-ux-fixes-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
