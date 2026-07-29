# Upload Modal and PDF Magnifier Layout Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task with one worker. Steps use checkbox (`- [ ]`) syntax for tracking. Stop for a fresh reviewer gate after each implementation task.

**Goal:** Center Upload BOQ using only the shared dialog translation and render the measured, accessible PDF magnifier through `document.body` so it cannot be clipped.

**Architecture:** Keep `DialogContent` unchanged as the sole viewport-centering owner. Remove Upload BOQ from the legacy `.modal` transform contract while copying only its required visual/layout declarations into `.upload-modal`. Keep magnifier state, measurement, and placement in `BoqPreflight`, but move its visible DOM node to `document.body` with `createPortal`.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, React DOM portals, TypeScript 5, Base UI dialog, Tailwind CSS 4, Node `tsx --test`, pi-lens, real-browser geometry inspection.

## Global Constraints

- Relevant Next.js guides read before planning:
  - `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` — browser APIs, effects, and event handlers belong in the existing Client Component; guard `document.body` because Client Components are also prerendered.
  - `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` — global CSS applies across routes, so remove the broad dialog override and keep replacement rules scoped to `.upload-modal`.
- Do not modify `src/components/ui/dialog.tsx`; its `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2` classes remain the sole centering interface.
- Do not refactor the shared dialog primitive or the legacy `.modal` rules used elsewhere.
- Do not change BOQ import APIs, preflight data contracts, selection behavior, copy, or PDF parsing.
- Preserve Upload BOQ surface, radius, shadow, width, maximum height, header/body/footer spacing, inner-body scrolling, focus trap, Escape/close behavior, and responsive bounds.
- Preserve magnifier measurement through `getBoundingClientRect()`, `computeMagnifierPlacement(...)`, the 8px safe margin, responsive CSS shrinking, `role="img"`, accessible label, and `pointer-events: none`.
- Hover and focus only reveal the magnifier; click and keyboard activation remain the only selection toggles.
- Run `npm run check` after each implementation task and after any reviewer-requested code correction.
- Keep commits focused. A single worker executes sequentially, with a fresh reviewer approving Task 1 before Task 2 and Task 2 before final validation.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/components/upload-modal.tsx` | Remove the legacy `modal` class from Upload BOQ only. |
| `src/app/globals.css` | Preserve scoped Upload BOQ visual/layout declarations without `transform` or `translate`. |
| `src/styles/globals.css` | Remove the broad defensive dialog-centering override; retain magnifier styling. |
| `src/components/upload-modal-layout.test.ts` | New source-contract regression for exactly one centering owner and preserved Upload BOQ layout. |
| `src/components/boq-preflight.tsx` | Body-portal the existing measured magnifier. |
| `src/components/boq-preflight.test.ts` | Add the body-portal regression while retaining placement/accessibility assertions. |
| `test-artifacts/upload-modal-magnifier-layout/*` | Concrete browser geometry report and viewport screenshots. |

---

## Tasks

### Task 1: Remove Upload BOQ’s duplicate centering translation

**Files:**

- Create: `src/components/upload-modal-layout.test.ts`
- Modify: `src/components/upload-modal.tsx:159-163`
- Modify: `src/app/globals.css:981-984`
- Modify: `src/styles/globals.css:332-344`
- Reference only: `src/components/ui/dialog.tsx:42-60`
- Reference only: `src/app/globals.css:620-643`

**Interfaces:**

- Consumes: shared `DialogContent`, whose class list owns fixed positioning and `-50%` translation on both axes.
- Produces: `.upload-modal` as a transform-free visual/layout class with the existing surface, radius, shadow, responsive width, maximum height, flex column layout, padding, and gap.
- Does not change: `UploadModalProps`, dialog primitive behavior, modal header/body/footer class names, or any API request.

- [ ] **Step 1: Write the failing centering regression**

Create `src/components/upload-modal-layout.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const uploadSource = readFileSync(
 new URL("./upload-modal.tsx", import.meta.url),
 "utf8",
);
const dialogSource = readFileSync(
 new URL("./ui/dialog.tsx", import.meta.url),
 "utf8",
);
const appCss = readFileSync(
 new URL("../app/globals.css", import.meta.url),
 "utf8",
);
const sharedCss = readFileSync(
 new URL("../styles/globals.css", import.meta.url),
 "utf8",
);

test("Upload BOQ delegates viewport centering only to shared DialogContent", () => {
 const uploadClasses = uploadSource.match(
  /<DialogContent[\s\S]*?className="([^"]*\bupload-modal\b[^"]*)"/,
 )?.[1];
 assert.ok(uploadClasses, "Upload BOQ DialogContent classes must be present");
 assert.equal(
  uploadClasses.split(/\s+/).includes("modal"),
  false,
  "Upload BOQ must not inherit the legacy .modal transform contract",
 );

 assert.match(
  dialogSource,
  /fixed top-1\/2 left-1\/2[\s\S]*-translate-x-1\/2 -translate-y-1\/2/,
 );

 const uploadRule = appCss.match(/\.upload-modal\s*\{([^}]*)\}/s)?.[1];
 assert.ok(uploadRule, "scoped .upload-modal rule must be present");
 assert.doesNotMatch(uploadRule, /\b(?:transform|translate)\s*:/);
 assert.doesNotMatch(
  appCss,
  /\.upload-modal\[data-open\]\s*\{[^}]*\b(?:transform|translate)\s*:/s,
 );
 assert.doesNotMatch(
  sharedCss,
  /\[data-slot="dialog-content"\]\.upload-modal/,
 );
});

test("Upload BOQ keeps its existing visual and inner-scroll layout", () => {
 const uploadRule = appCss.match(/\.upload-modal\s*\{([^}]*)\}/s)?.[1] ?? "";

 assert.match(uploadRule, /background:\s*var\(--surface\)/);
 assert.match(uploadRule, /border-radius:\s*var\(--radius-lg\)/);
 assert.match(uploadRule, /box-shadow:\s*var\(--elev-raised\)/);
 assert.match(uploadRule, /width:\s*min\(520px,\s*calc\(100vw - 32px\)\)/);
 assert.match(uploadRule, /max-height:\s*min\(80vh,\s*720px\)/);
 assert.match(uploadRule, /display:\s*flex/);
 assert.match(uploadRule, /flex-direction:\s*column/);
 assert.match(uploadRule, /padding:\s*0/);
 assert.match(uploadRule, /gap:\s*0/);

 assert.match(uploadSource, /className="modal-header"/);
 assert.match(uploadSource, /className="modal-body upload-modal-body"/);
 assert.match(uploadSource, /className="modal-footer"/);
 assert.match(appCss, /\.modal-body\s*\{[^}]*overflow-y:\s*auto/s);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx tsx --test src/components/upload-modal-layout.test.ts
```

Expected: FAIL because Upload BOQ still includes the `modal` class, `.upload-modal` applies `transform`, and `src/styles/globals.css` contains a second centering override.

- [ ] **Step 3: Remove the legacy class from Upload BOQ**

In `src/components/upload-modal.tsx:159-163`, change only the class list:

```tsx
<DialogContent
 className="upload-modal max-w-[720px]"
 data-od-id="upload-modal"
 showCloseButton={!uploading}
>
```

Keep `modal-header`, `modal-body`, and `modal-footer` on their existing child elements.

- [ ] **Step 4: Preserve the required Upload BOQ visuals without a transform**

Replace `src/app/globals.css:981-983` with:

```css
.upload-modal {
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-raised), 0 8px 32px rgba(4, 14, 32, 0.12);
  width: min(520px, calc(100vw - 32px));
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  padding: 0;
  gap: 0;
}
.upload-modal .modal-header { display: block; }
```

Delete `.upload-modal[data-open]`. Do not copy `.modal`’s `transform` or transform transition.

- [ ] **Step 5: Remove the broad defensive centering override**

Delete `src/styles/globals.css:332-344` entirely:

```css
[data-slot="dialog-content"].upload-modal,
[data-slot="dialog-content"].modal {
 /* ... */
}
```

Do not replace it and do not edit the shared `DialogContent`. This leaves its individual Tailwind `translate` property as the only `-50%` centering mechanism.

- [ ] **Step 6: Verify GREEN and the existing ingestion contract**

Run:

```bash
npx tsx --test \
  src/components/upload-modal-layout.test.ts \
  src/components/boq-ingestion-flow.test.ts
npm run check
git diff --check
git status --short
```

Expected: both focused tests and the full check pass; no whitespace errors; only the new test and the three scoped implementation files are changed.

- [ ] **Step 7: Commit the independently reviewable centering fix**

```bash
git add \
  src/components/upload-modal-layout.test.ts \
  src/components/upload-modal.tsx \
  src/app/globals.css \
  src/styles/globals.css
git commit -m "fix: center Upload BOQ with one translation owner"
```

- [ ] **Step 8: Stop for the fresh Task 1 reviewer gate**

Provide the reviewer with:

```bash
git show --stat --oneline HEAD
git show --check HEAD
npx tsx --test src/components/upload-modal-layout.test.ts src/components/boq-ingestion-flow.test.ts
```

Do not begin Task 2 until the reviewer confirms the shared dialog stayed untouched, visual declarations were preserved, and no Upload BOQ transform remains. Apply any findings in a focused follow-up commit and rerun `npm run check`.

---

### Task 2: Portal the measured magnifier to `document.body`

**Files:**

- Modify: `src/components/boq-preflight.test.ts:51-83`
- Modify: `src/components/boq-preflight.tsx:3-12,75-120,146-158,239-273`
- Reference only: `src/lib/preflight-magnifier-position.ts:26-77`
- Test without modification: `src/lib/preflight-magnifier-position.test.ts:10-101`
- Reference only: `src/styles/globals.css:225-255`

**Interfaces:**

- Consumes: `createPortal(children, container)` from `react-dom`, `document.body`, `magnifierRef`, `magnifierStyle`, and `computeMagnifierPlacement(...)`.
- Produces: a `ReactPortal` whose visible `.preflight-magnifier` DOM element is a direct child of `document.body`.
- Retains: `MagnifierPlacement`, `Point`, measured popup dimensions, 8px `MAGNIFIER_PADDING`, 16px `MAGNIFIER_GAP`, viewport clamping, mouse/focus events, semantic label, and noninteractive pointer behavior.

- [ ] **Step 1: Add the failing portal regression**

Add this separate test to `src/components/boq-preflight.test.ts` after the existing magnifier-placement test:

```ts
test("BoqPreflight body-portals the magnifier outside modal clipping ancestors", () => {
 assert.match(
  preflightSource,
  /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/,
 );
 assert.match(
  preflightSource,
  /typeof document !== "undefined"[\s\S]*createPortal\([\s\S]*className="preflight-magnifier"[\s\S]*document\.body/,
 );
 assert.doesNotMatch(
  preflightSource,
  /\{isMagnified && magnifierStyle && \(\s*<div\s+ref=\{magnifierRef\}/,
 );

 // Accessibility and event ownership remain in BoqPreflight.
 assert.match(preflightSource, /role="img"/);
 assert.match(
  preflightSource,
  /aria-label=\{`Magnified Page \$\{pageInfo\.page\}`\}/,
 );
 assert.match(preflightSource, /onClick=\{\(\) => toggleSelection\(pageInfo\.page\)\}/);

 const css = readFileSync(globalCssPath, "utf8");
 assert.match(
  css,
  /\.preflight-magnifier\s*\{[^}]*pointer-events:\s*none/s,
 );
});
```

Retain the existing assertions for `getBoundingClientRect`, `window.innerWidth`, `window.innerHeight`, `computeMagnifierPlacement`, `position: fixed`, responsive maximum dimensions, and `object-fit: contain`.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx tsx --test src/components/boq-preflight.test.ts
```

Expected: FAIL because the magnifier is still emitted as a normal descendant of `.preflight-page-item` and `createPortal` is not imported.

- [ ] **Step 3: Import React’s portal API**

At `src/components/boq-preflight.tsx:3-4`, add:

```ts
import { createPortal } from "react-dom";
```

Keep the file’s existing `"use client"` directive first.

- [ ] **Step 4: Body-portal only the visible magnifier wrapper**

Replace the magnifier render at `src/components/boq-preflight.tsx:239-273` with:

```tsx
{isMagnified &&
 magnifierStyle &&
 typeof document !== "undefined" &&
 createPortal(
  <div
   ref={magnifierRef}
   role="img"
   aria-label={`Magnified Page ${pageInfo.page}`}
   className="preflight-magnifier"
   style={{ left: magnifierStyle.left, top: magnifierStyle.top }}
  >
   {previewSrc ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
     src={previewSrc}
     alt={`Magnified preview of page ${pageInfo.page}`}
     className="preflight-magnifier-image"
    />
   ) : (
    <div className="preflight-magnifier-empty">
     Preview unavailable for page {pageInfo.page}
    </div>
   )}
   <div className="preflight-magnifier-info">
    <span className="preflight-magnifier-icon">
     <ZoomIn size={16} />
    </span>
    <span>Page {pageInfo.page}</span>
    {pageInfo.suggested && (
     <span className="preflight-magnifier-badge">
      Suggested
     </span>
    )}
   </div>
  </div>,
  document.body,
 )}
```

Do not move state or handlers out of `BoqPreflight`. Do not replace the measured helper with guessed dimensions or dialog-local coordinates.

- [ ] **Step 5: Verify GREEN, placement edges, and ingestion behavior**

Run:

```bash
npx tsx --test \
  src/components/boq-preflight.test.ts \
  src/lib/preflight-magnifier-position.test.ts \
  src/components/boq-ingestion-flow.test.ts
npm run check
git diff --check
git status --short
```

Expected: all focused and full checks pass. The pure tests continue covering narrow viewports, left/right flip, top/bottom clamp, and oversized popup fallback.

- [ ] **Step 6: Run pi-lens on the changed implementation and test files**

Use the pi-lens tools:

```text
lsp_diagnostics({
  paths: [
    "src/components/boq-preflight.tsx",
    "src/components/boq-preflight.test.ts",
    "src/components/upload-modal.tsx",
    "src/components/upload-modal-layout.test.ts"
  ],
  severity: "all",
  waitMs: 1000
})

lens_diagnostics({ mode: "all" })
```

Expected: no new diagnostics in changed files. Fix in-scope findings and rerun the focused tests plus `npm run check`; do not suppress or broadly clean unrelated findings.

- [ ] **Step 7: Commit the independently reviewable portal fix**

```bash
git add \
  src/components/boq-preflight.tsx \
  src/components/boq-preflight.test.ts
git commit -m "fix: body-portal the BOQ page magnifier"
```

- [ ] **Step 8: Stop for the fresh Task 2 reviewer gate**

Provide:

```bash
git show --stat --oneline HEAD
git show --check HEAD
npx tsx --test src/components/boq-preflight.test.ts src/lib/preflight-magnifier-position.test.ts
```

The reviewer must confirm the portal target is `document.body`, the guard prevents server access to `document`, measured viewport placement remains intact, and selection/accessibility handlers did not change.

---

### Task 3: Produce real-browser geometry evidence

**Files:**

- Create: `test-artifacts/upload-modal-magnifier-layout/geometry-validation.md`
- Create: `test-artifacts/upload-modal-magnifier-layout/1440x900.png`
- Create: `test-artifacts/upload-modal-magnifier-layout/768x900.png`
- Create: `test-artifacts/upload-modal-magnifier-layout/320x600.png`

**Interfaces:**

- Consumes: the two reviewed implementation commits, a real Chromium browser, an authenticated `/boqs` session, and browser request interception.
- Produces: an independently reviewable Markdown report containing measured geometry, intersection/clipping evidence, selection counts, scrolling/focus/close results, command outputs, commit IDs, and three screenshots.
- Does not alter: application source, APIs, test fixtures, or production data.

- [ ] **Step 1: Generate an untracked nine-page PDF for browser-only validation**

```bash
.venv-docling/bin/python - <<'PY'
from pypdf import PdfWriter

writer = PdfWriter()
for _ in range(9):
    writer.add_blank_page(width=612, height=792)

with open("/tmp/buildestimate-preflight-9-pages.pdf", "wb") as output:
    writer.write(output)
PY
```

Expected: `/tmp/buildestimate-preflight-9-pages.pdf` exists and is not added to Git.

- [ ] **Step 2: Start the app and prepare deterministic preflight metadata**

Run `npm run dev` in a separate terminal, authenticate using the configured local `ADMIN_PASSWORD`, and open `/boqs`.

In the real-browser bridge, intercept only `POST /api/boqs/preflight` and fulfill it with:

```json
{
  "id": "layout-validation",
  "fileName": "buildestimate-preflight-9-pages.pdf",
  "pageCount": 9,
  "status": "ready",
  "pages": [
    { "page": 1, "suggested": true,  "confidence": 1, "reasons": ["fixture"], "textSource": "embedded" },
    { "page": 2, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 3, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 4, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 5, "suggested": true,  "confidence": 1, "reasons": ["fixture"], "textSource": "embedded" },
    { "page": 6, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 7, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 8, "suggested": false, "confidence": 0, "reasons": [], "textSource": "embedded" },
    { "page": 9, "suggested": true,  "confidence": 1, "reasons": ["fixture"], "textSource": "embedded" }
  ],
  "confirmedPages": null
}
```

Upload the temporary PDF and click **Continue**. This exercises the real component and PDF.js rendering without writing Firebase or invoking Docling.

- [ ] **Step 3: Collect geometry with clipping-aware evidence**

At each viewport—`1440x900`, `768x900`, and `320x600`—wait at least 200ms after opening the dialog, then evaluate:

```js
async function captureLayoutGeometry() {
  const dialog = document.querySelector('[data-od-id="upload-modal"]');
  const magnifier = document.querySelector(".preflight-magnifier");
  const info = magnifier?.querySelector(".preflight-magnifier-info");
  if (!(dialog instanceof HTMLElement) || !(magnifier instanceof HTMLElement)) {
    throw new Error("Expected dialog and magnifier to be visible");
  }

  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const dialogRect = dialog.getBoundingClientRect();
  const magnifierRect = magnifier.getBoundingClientRect();
  const infoRect = info?.getBoundingClientRect();
  const dialogStyle = getComputedStyle(dialog);
  const magnifierStyle = getComputedStyle(magnifier);

  const intersection = await new Promise((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve({
        ratio: entry.intersectionRatio,
        intersectionRect: entry.intersectionRect.toJSON(),
        rootBounds: entry.rootBounds?.toJSON() ?? null,
      });
    }, { threshold: [1] });
    observer.observe(magnifier);
  });

  return {
    viewport: { viewportLeft, viewportTop, viewportWidth, viewportHeight },
    dialog: {
      rect: dialogRect.toJSON(),
      centerErrorX: Math.abs(
        dialogRect.left + dialogRect.width / 2 -
        (viewportLeft + viewportWidth / 2),
      ),
      centerErrorY: Math.abs(
        dialogRect.top + dialogRect.height / 2 -
        (viewportTop + viewportHeight / 2),
      ),
      position: dialogStyle.position,
      translate: dialogStyle.translate,
      transform: dialogStyle.transform,
    },
    magnifier: {
      rect: magnifierRect.toJSON(),
      parentIsBody: magnifier.parentElement === document.body,
      insideDialog: dialog.contains(magnifier),
      safeInsets: {
        left: magnifierRect.left - viewportLeft,
        top: magnifierRect.top - viewportTop,
        right: viewportLeft + viewportWidth - magnifierRect.right,
        bottom: viewportTop + viewportHeight - magnifierRect.bottom,
      },
      borders: {
        top: magnifierStyle.borderTopWidth,
        right: magnifierStyle.borderRightWidth,
        bottom: magnifierStyle.borderBottomWidth,
        left: magnifierStyle.borderLeftWidth,
      },
      infoContained:
        Boolean(infoRect) &&
        infoRect.left >= magnifierRect.left &&
        infoRect.top >= magnifierRect.top &&
        infoRect.right <= magnifierRect.right &&
        infoRect.bottom <= magnifierRect.bottom,
      intersection,
    },
  };
}
```

Acceptance for every recorded sample:

- `centerErrorX <= 1` and `centerErrorY <= 1`.
- `position === "fixed"`.
- The dialog does not have both a non-`none` `transform` and non-`none` individual `translate`.
- `parentIsBody === true` and `insideDialog === false`.
- `intersection.ratio === 1`, proving ancestor/viewport clipping is absent.
- All four borders are nonzero and `infoContained === true`.
- Every safe inset is at least 8px when the viewport can contain the responsive popup.

- [ ] **Step 4: Exercise all anchors and interaction invariants at every viewport**

For pages 1, 5, and 9:

1. Record the count of `.preflight-thumbnail[aria-pressed="true"]`.
2. Hover each thumbnail and capture geometry.
3. Keyboard-focus each thumbnail and capture geometry.
4. Confirm the selected count is unchanged after all hover/focus operations.
5. Click page 1 and verify the count changes by one.
6. Focus page 5 and press Space or Enter; verify the count changes by one.

While a thumbnail remains focused, dispatch `mousemove` on it with `clientX/clientY` near `(1,1)`, `(viewportWidth-1,1)`, `(1,viewportHeight-1)`, and `(viewportWidth-1,viewportHeight-1)`. After each React update, run `captureLayoutGeometry()` and record safe insets plus intersection ratio.

Also verify:

- `.modal-body` has `scrollHeight > clientHeight`, setting `scrollTop` moves it, and the magnifier remains fully visible.
- Repeated Tab/Shift+Tab keeps `document.activeElement` inside the dialog.
- Escape closes the dialog.
- Reopen it and verify the close button closes it.
- No new browser console errors appear.

- [ ] **Step 5: Write the concrete validation report and capture screenshots**

Create `test-artifacts/upload-modal-magnifier-layout/geometry-validation.md` with:

```md
# Upload Modal and Magnifier Geometry Validation

- Implementation commits:
- Browser/version:
- Temporary fixture:
- Preflight interception:
- `npm run check`:
- Focused tests:
- pi-lens:

| Viewport | Dialog center error X/Y | Computed translate | Computed transform | Portal outside dialog | Minimum safe inset | Intersection ratio | Hover/focus selection stable | Activation toggles | Inner scroll | Focus trap/Escape/close |
|---|---:|---|---|---|---:|---:|---|---|---|---|
| 1440x900 | | | | | | | | | | |
| 768x900 | | | | | | | | | | |
| 320x600 | | | | | | | | | | |

## First/Middle/Last Page Checks

## Four-Edge Anchor Measurements

## Console and Residual Notes
```

Capture one screenshot with the complete magnifier visible at each required viewport using the exact filenames declared above.

- [ ] **Step 6: Run final automated and repository validation**

```bash
npx tsx --test \
  src/components/upload-modal-layout.test.ts \
  src/components/boq-preflight.test.ts \
  src/lib/preflight-magnifier-position.test.ts \
  src/components/boq-ingestion-flow.test.ts
npm run check
git diff --check
git status --short
```

Rerun:

```text
lsp_diagnostics({
  paths: [
    "src/components/boq-preflight.tsx",
    "src/components/boq-preflight.test.ts",
    "src/components/upload-modal.tsx",
    "src/components/upload-modal-layout.test.ts"
  ],
  severity: "all",
  waitMs: 1000
})

lens_diagnostics({ mode: "all" })
```

Expected: all tests/checks pass; no changed-file pi-lens findings; only the four validation artifacts remain uncommitted.

- [ ] **Step 7: Commit the concrete validation deliverable**

```bash
git add test-artifacts/upload-modal-magnifier-layout
git commit -m "test: record Upload BOQ layout geometry"
git diff --cached --name-only
git status --short
```

Expected: `git diff --cached --name-only` is empty after the commit. Preserve any unrelated pre-existing working-tree changes without staging them.

- [ ] **Step 8: Request the final fresh acceptance review**

The reviewer must inspect both implementation commits, the validation report, all three screenshots, focused/full command results, and pi-lens output. Block acceptance if any geometry threshold is missing, inferred only from a rectangle without intersection evidence, or measured before the dialog animation settles.

## Files to Modify

- `src/components/upload-modal.tsx` — remove only the legacy `modal` class.
- `src/app/globals.css` — retain Upload BOQ visuals/layout without centering transforms.
- `src/styles/globals.css` — remove the broad defensive dialog-centering block.
- `src/components/boq-preflight.tsx` — portal the existing magnifier to `document.body`.
- `src/components/boq-preflight.test.ts` — add portal/accessibility regression coverage.

## New Files

- `src/components/upload-modal-layout.test.ts` — regression for exactly one centering owner and preserved visuals.
- `test-artifacts/upload-modal-magnifier-layout/geometry-validation.md` — measured validation record.
- `test-artifacts/upload-modal-magnifier-layout/1440x900.png` — desktop evidence.
- `test-artifacts/upload-modal-magnifier-layout/768x900.png` — narrow-tablet evidence.
- `test-artifacts/upload-modal-magnifier-layout/320x600.png` — mobile evidence.

## Dependencies

- Task 1 and Task 2 are logically independent and separately reviewable, but the single worker executes them sequentially.
- Task 2 begins only after Task 1’s fresh reviewer gate.
- Task 3 depends on both reviewed implementation commits and produces the final acceptance evidence.
- Browser validation depends on a working authenticated local session and request interception; it does not depend on Firebase or Docling because the preflight response is fulfilled locally.

## Risks

- Source-contract tests prove intended composition but not browser clipping; Task 3’s `IntersectionObserver`, portal-parent check, and screenshots close that gap.
- Tailwind dialog animation can temporarily affect geometry. Wait at least 200ms before measuring.
- `visualViewport` can have offsets on mobile; measurements must use its offsets rather than assuming `(0,0)`.
- Removing `.modal` without copying its flex/surface declarations would alter Upload BOQ appearance or scrolling; the new test explicitly guards those properties.
- Do not “fix” the issue by editing shared `DialogContent`, adding z-index alone, or converting viewport coordinates to dialog-local coordinates.

## Self-Review

- **Spec coverage:** Task 1 removes the double translation while preserving visuals and full-viewport centering. Task 2 body-portals the measured accessible magnifier. Task 3 validates every required viewport, edge, interaction, scrolling, and close behavior.
- **Placeholder scan:** No implementation steps require unspecified code or tests.
- **Type consistency:** `createPortal` adds no public interface; placement inputs and `UploadModalProps` remain unchanged.
- **Scope:** No API, shared-dialog, parsing, selection, or unrelated formatting changes.

## Execution Handoff

Plan prepared for `docs/superpowers/plans/2026-07-29-upload-modal-magnifier-layout-fixes-plan.md`. Execute sequentially with one worker and fresh reviewer gates after Tasks 1 and 2. Unresolved decisions: none.
