# BOQ Post-Parse Review Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Navigate every successful BOQ import to an embedded detail-page review workspace with immediate catalog matching, a draggable PDF/data split, left-only collapse, in-page full PDF, box zoom, and drag-to-pan.

**Architecture:** Keep the atomic import API and existing BOQ review business rules unchanged. Add small pure modules for review URLs and viewport calculations, a client-only PDF.js canvas viewer, and a reusable workspace shell; then render the existing `ReviewPanel` content either as its legacy modal or as an embedded detail-page workspace. The BOQs list and detail route share one review URL helper so post-import and later Review actions cannot diverge.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, TypeScript, PDF.js `pdfjs-dist@5.4.624`, Node test runner through `tsx --test`, CSS in `src/app/globals.css`, Playwright for browser verification.

## Global Constraints

- Follow the checked-in Next.js 16.2.10 documentation under `node_modules/next/dist/docs/`; use `useRouter` and `useSearchParams` from `next/navigation`.
- Pin `pdfjs-dist` to `5.4.624`, whose Node engine floor is compatible with Node 20.16+; do not raise the project's Node requirement to PDF.js 6.x.
- Use PDF.js's display-layer `getDocument()`, `getPage()`, `getViewport()`, and canvas `page.render()` flow documented in the [official PDF.js example](https://mozilla.github.io/pdf.js/examples/index.html).
- Keep review data state independent from PDF display state so resize, collapse, full-screen, zoom, and pan never clear unsaved BOQ edits.
- Only the left PDF pane can collapse. The right matching pane must not expose a Collapse action.
- Full PDF expands inside the current detail page; it must not navigate or open a new tab.
- Box Zoom uses a dragged rectangle, then automatically returns to Pan mode. `Escape` cancels an active selection.
- Retain **Retry preview** and **Open PDF** fallbacks when the source cannot render.
- Do not change Docling parsing, BOQ approval validation, catalog matching rules, or API payload contracts except to add Save draft using the existing BOQ `PUT` endpoint.
- Use `data-od-id` attributes for new interactive regions and controls.
- Run `graphify update .` after implementation changes.

## File Structure

- Create `src/lib/boq-review-route.ts`: canonical detail and review URLs plus review-mode parsing.
- Create `src/lib/boq-review-route.test.ts`: URL encoding and mode tests.
- Create `src/lib/pdf-review-geometry.ts`: pure split, rectangle, box-zoom, and pan calculations.
- Create `src/lib/pdf-review-geometry.test.ts`: deterministic geometry tests.
- Create `src/components/pdf-review-viewer.tsx`: authenticated PDF.js loading, page rendering, box selection, pan, page controls, and viewer fallbacks.
- Create `src/components/pdf-review-viewer.test.ts`: component contract checks that complement geometry tests.
- Create `src/components/review-workspace.tsx`: embedded/modal-agnostic split shell, accessible separator, collapse, restore, and full-PDF state.
- Create `src/components/review-workspace.test.ts`: shell contract and accessibility checks.
- Modify `src/components/review-panel.tsx`: reuse current edit/verify/match/approve logic in modal and embedded variants; add Save draft; compose the workspace and viewer.
- Modify `src/components/standardization-review.tsx`: support an initially open review and remove the dead **Review matches after save** gate.
- Modify `src/components/boq-ingestion-flow.test.ts`: assert route handoff, PDF viewer replacement, and removal of the old gate.
- Modify `src/components/review-panel-catalog-readiness.test.ts`: assert embedded review keeps matching controls and catalog blockers.
- Modify `src/app/(authenticated)/boqs/page.tsx`: navigate after import and link later Review actions to the same route.
- Modify `src/app/(authenticated)/boqs/[id]/page.tsx`: detect review mode, render the embedded workspace, and return to normal detail mode after close or approval.
- Modify `src/app/globals.css`: resizable workspace, PDF canvas, selection rectangle, pan cursors, collapsed/full states, and responsive fallback.
- Modify `package.json` and `package-lock.json`: add pinned `pdfjs-dist@5.4.624`.

---

### Task 1: Canonical BOQ Review URLs

**Files:**
- Create: `src/lib/boq-review-route.ts`
- Create: `src/lib/boq-review-route.test.ts`

**Interfaces:**
- Consumes: a server-issued BOQ `id: string` and `URLSearchParams`-compatible query input.
- Produces: `boqDetailHref(id: string): string`, `boqReviewHref(id: string): string`, and `isBoqReviewMode(searchParams: Pick<URLSearchParams, "get">): boolean`.

- [ ] **Step 1: Write the failing URL tests**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { boqDetailHref, boqReviewHref, isBoqReviewMode } from "./boq-review-route"

test("BOQ review URLs encode the server-issued identifier and set one review mode", () => {
  assert.equal(boqDetailHref("boq / 7"), "/boqs/boq%20%2F%207")
  assert.equal(boqReviewHref("boq / 7"), "/boqs/boq%20%2F%207?mode=review")
})

test("only mode=review enables the embedded review workspace", () => {
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=review")), true)
  assert.equal(isBoqReviewMode(new URLSearchParams("mode=Review")), false)
  assert.equal(isBoqReviewMode(new URLSearchParams("review=true")), false)
})
```

- [ ] **Step 2: Run the URL tests and verify RED**

Run: `npm test -- src/lib/boq-review-route.test.ts`

Expected: FAIL because `src/lib/boq-review-route.ts` does not exist.

- [ ] **Step 3: Add the minimal URL implementation**

```ts
export function boqDetailHref(id: string): string {
  return `/boqs/${encodeURIComponent(id)}`
}

export function boqReviewHref(id: string): string {
  return `${boqDetailHref(id)}?mode=review`
}

export function isBoqReviewMode(
  searchParams: Pick<URLSearchParams, "get">,
): boolean {
  return searchParams.get("mode") === "review"
}
```

- [ ] **Step 4: Run the URL tests and verify GREEN**

Run: `npm test -- src/lib/boq-review-route.test.ts`

Expected: 2 tests PASS with no warnings.

- [ ] **Step 5: Commit the URL contract**

```bash
git add src/lib/boq-review-route.ts src/lib/boq-review-route.test.ts
git commit -m "test: define BOQ review routes"
```

---

### Task 2: Split, Box-Zoom, and Pan Geometry

**Files:**
- Create: `src/lib/pdf-review-geometry.ts`
- Create: `src/lib/pdf-review-geometry.test.ts`

**Interfaces:**
- Consumes: pointer coordinates local to a viewport, split-container bounds, zoom, and pan state.
- Produces: `clampReviewSplit`, `reviewSplitFromPointer`, `reviewSplitFromKey`, `normalizeSelection`, `deriveBoxZoom`, and `panPdf`.

- [ ] **Step 1: Write failing pure geometry tests**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  clampReviewSplit,
  deriveBoxZoom,
  normalizeSelection,
  panPdf,
  reviewSplitFromKey,
  reviewSplitFromPointer,
} from "./pdf-review-geometry"

test("review split clamps pointer and keyboard changes to usable panes", () => {
  assert.equal(clampReviewSplit(10), 25)
  assert.equal(clampReviewSplit(82), 75)
  assert.equal(reviewSplitFromPointer(500, { left: 100, width: 800 }), 50)
  assert.equal(reviewSplitFromKey(50, "ArrowLeft"), 45)
  assert.equal(reviewSplitFromKey(74, "ArrowRight"), 75)
  assert.equal(reviewSplitFromKey(50, "Enter"), 50)
})

test("selection rectangles normalize reverse drags", () => {
  assert.deepEqual(
    normalizeSelection({ x: 180, y: 140 }, { x: 40, y: 20 }),
    { x: 40, y: 20, width: 140, height: 120 },
  )
})

test("box zoom centers a selected area and clamps zoom", () => {
  assert.deepEqual(
    deriveBoxZoom({
      selection: { x: 100, y: 100, width: 200, height: 100 },
      viewport: { width: 800, height: 600 },
      zoom: 1,
      pan: { x: 0, y: 0 },
    }),
    { zoom: 4, pan: { x: -400, y: -300 } },
  )
  assert.equal(
    deriveBoxZoom({
      selection: { x: 10, y: 10, width: 4, height: 4 },
      viewport: { width: 800, height: 600 },
      zoom: 1,
      pan: { x: 0, y: 0 },
    }),
    null,
  )
})

test("pan adds pointer deltas without changing zoom", () => {
  assert.deepEqual(panPdf({ x: -20, y: 12 }, { x: 35, y: -8 }), { x: 15, y: 4 })
})
```

- [ ] **Step 2: Run the geometry tests and verify RED**

Run: `npm test -- src/lib/pdf-review-geometry.test.ts`

Expected: FAIL because `src/lib/pdf-review-geometry.ts` does not exist.

- [ ] **Step 3: Implement the pure geometry module**

```ts
export interface PdfPoint { x: number; y: number }
export interface PdfSize { width: number; height: number }
export interface PdfRect extends PdfPoint, PdfSize {}

export const MIN_REVIEW_SPLIT = 25
export const MAX_REVIEW_SPLIT = 75
export const MIN_BOX_SELECTION = 8
export const MIN_PDF_ZOOM = 1
export const MAX_PDF_ZOOM = 8

export function clampReviewSplit(value: number): number {
  return Math.min(MAX_REVIEW_SPLIT, Math.max(MIN_REVIEW_SPLIT, value))
}

export function reviewSplitFromPointer(
  clientX: number,
  bounds: { left: number; width: number },
): number {
  if (bounds.width <= 0) return 50
  return clampReviewSplit(((clientX - bounds.left) / bounds.width) * 100)
}

export function reviewSplitFromKey(current: number, key: string): number {
  if (key === "ArrowLeft") return clampReviewSplit(current - 5)
  if (key === "ArrowRight") return clampReviewSplit(current + 5)
  if (key === "Home") return MIN_REVIEW_SPLIT
  if (key === "End") return MAX_REVIEW_SPLIT
  return current
}

export function normalizeSelection(start: PdfPoint, end: PdfPoint): PdfRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

export function deriveBoxZoom({
  selection,
  viewport,
  zoom,
  pan,
}: {
  selection: PdfRect
  viewport: PdfSize
  zoom: number
  pan: PdfPoint
}): { zoom: number; pan: PdfPoint } | null {
  if (selection.width < MIN_BOX_SELECTION || selection.height < MIN_BOX_SELECTION) return null
  const requestedFactor = Math.min(
    viewport.width / selection.width,
    viewport.height / selection.height,
  )
  const nextZoom = Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, zoom * requestedFactor))
  const appliedFactor = nextZoom / zoom
  const centerX = selection.x + selection.width / 2
  const centerY = selection.y + selection.height / 2
  return {
    zoom: nextZoom,
    pan: {
      x: viewport.width / 2 - (centerX - pan.x) * appliedFactor,
      y: viewport.height / 2 - (centerY - pan.y) * appliedFactor,
    },
  }
}

export function panPdf(current: PdfPoint, delta: PdfPoint): PdfPoint {
  return { x: current.x + delta.x, y: current.y + delta.y }
}
```

- [ ] **Step 4: Run geometry tests and verify GREEN**

Run: `npm test -- src/lib/pdf-review-geometry.test.ts`

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the geometry contract**

```bash
git add src/lib/pdf-review-geometry.ts src/lib/pdf-review-geometry.test.ts
git commit -m "feat: add PDF review viewport geometry"
```

---

### Task 3: Authenticated PDF.js Canvas Viewer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/pdf-review-viewer.tsx`
- Create: `src/components/pdf-review-viewer.test.ts`
- Modify: `src/app/globals.css:1008-1017`

**Interfaces:**
- Consumes: `sourceUrl: string`, `sourceFileName: string`, and `resetKey: string`.
- Produces: `<PdfReviewViewer sourceUrl sourceFileName resetKey />`, with page navigation, Box Zoom, Pan, Zoom Out, Fit Page, Reset, zoom percentage, retry, and external-source fallback.

- [ ] **Step 1: Write the failing component contract test**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const viewerUrl = new URL("./pdf-review-viewer.tsx", import.meta.url)

test("PDF review viewer owns canvas rendering, box zoom, pan, and recovery controls", () => {
  assert.equal(existsSync(viewerUrl), true)
  if (!existsSync(viewerUrl)) return
  const source = readFileSync(viewerUrl, "utf8")
  assert.match(source, /pdfjs-dist\/webpack\.mjs/)
  assert.match(source, /getDocument\(\{\s*url: sourceUrl,\s*withCredentials: true/)
  assert.match(source, /<canvas/)
  assert.match(source, /Box Zoom/)
  assert.match(source, /Fit Page/)
  assert.match(source, /Reset/)
  assert.match(source, /deriveBoxZoom/)
  assert.match(source, /panPdf/)
  assert.match(source, /event\.key === "Escape"/)
  assert.match(source, /Retry preview/)
  assert.match(source, /Open PDF/)
})
```

- [ ] **Step 2: Run the viewer test and verify RED**

Run: `npm test -- src/components/pdf-review-viewer.test.ts`

Expected: FAIL because the viewer file does not exist.

- [ ] **Step 3: Install the pinned PDF.js display layer**

Run: `npm install --save-exact pdfjs-dist@5.4.624`

Expected: `package.json` contains `"pdfjs-dist": "5.4.624"`; `package-lock.json` records the same release without peer-dependency errors.

- [ ] **Step 4: Implement document loading and canvas rendering**

Create `src/components/pdf-review-viewer.tsx` as a client component with these exact state boundaries:

```tsx
"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { BoxSelect, ChevronLeft, ChevronRight, ExternalLink, Hand, Loader2, RotateCcw, Scan, ZoomOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  deriveBoxZoom,
  normalizeSelection,
  panPdf,
  type PdfPoint,
  type PdfRect,
} from "@/lib/pdf-review-geometry"

type PdfTool = "pan" | "box-zoom"

interface PdfReviewViewerProps {
  sourceUrl: string
  sourceFileName: string
  resetKey: string
}

async function loadPdf(sourceUrl: string) {
  const pdfjs = await import("pdfjs-dist/webpack.mjs")
  return pdfjs.getDocument({ url: sourceUrl, withCredentials: true }).promise
}

export function PdfReviewViewer({ sourceUrl, sourceFileName, resetKey }: PdfReviewViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragStartRef = useRef<PdfPoint | null>(null)
  const lastPointerRef = useRef<PdfPoint | null>(null)
  const renderGenerationRef = useRef(0)
  const [pdf, setPdf] = useState<Awaited<ReturnType<typeof loadPdf>> | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<PdfPoint>({ x: 0, y: 0 })
  const [tool, setTool] = useState<PdfTool>("pan")
  const [selection, setSelection] = useState<PdfRect | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let disposed = false
    let loadedDocument: Awaited<ReturnType<typeof loadPdf>> | null = null
    setLoading(true)
    setFailed(false)
    setPdf(null)
    setPageNumber(1)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    void loadPdf(sourceUrl).then((document) => {
      if (disposed) return document.destroy()
      loadedDocument = document
      setPdf(document)
      setPageCount(document.numPages)
      setLoading(false)
    }).catch(() => {
      if (!disposed) {
        setFailed(true)
        setLoading(false)
      }
    })
    return () => {
      disposed = true
      void loadedDocument?.destroy()
    }
  }, [attempt, resetKey, sourceUrl])
```

Use a `ResizeObserver` on `viewportRef`, fetch `pdf.getPage(pageNumber)`, compute `fitScale = Math.min((width - 32) / base.width, (height - 32) / base.height)`, render `page.getViewport({ scale: fitScale * zoom })` to the canvas at `window.devicePixelRatio`, and cancel stale renders with `renderGenerationRef`.

- [ ] **Step 5: Implement Box Zoom, Pan, page controls, and fallbacks**

Use pointer capture on the viewport. In Box Zoom mode, normalize start/end coordinates and call `deriveBoxZoom`; on a valid result set zoom/pan and switch to `pan`. In Pan mode, add pointer deltas with `panPdf`. Add this keyboard cancellation effect:

```tsx
useEffect(() => {
  const cancelSelection = (event: KeyboardEvent) => {
    if (event.key === "Escape" && selection) {
      event.preventDefault()
      dragStartRef.current = null
      setSelection(null)
      setTool("pan")
    }
  }
  window.addEventListener("keydown", cancelSelection)
  return () => window.removeEventListener("keydown", cancelSelection)
}, [selection])
```

Position the rendered canvas from the viewport centre and apply pan in CSS pixels:

```tsx
<canvas
  ref={canvasRef}
  className="pdf-review-canvas"
  style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))` }}
/>
{selection ? <div className="pdf-review-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} /> : null}
```

Render the control bar with accessible labels and pressed state:

```tsx
<div className="pdf-review-toolbar" aria-label="PDF review controls">
  <Button type="button" size="sm" variant={tool === "box-zoom" ? "default" : "outline"} aria-pressed={tool === "box-zoom"} onClick={() => setTool("box-zoom")}><BoxSelect />Box Zoom</Button>
  <Button type="button" size="sm" variant={tool === "pan" ? "default" : "outline"} aria-pressed={tool === "pan"} onClick={() => setTool("pan")}><Hand />Pan</Button>
  <Button type="button" size="icon-sm" variant="outline" aria-label="Zoom out" onClick={() => { setZoom((value) => Math.max(1, value - 0.25)); setPan({ x: 0, y: 0 }) }}><ZoomOut /></Button>
  <Button type="button" size="sm" variant="outline" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}><Scan />Fit Page</Button>
  <Button type="button" size="sm" variant="ghost" onClick={() => { setPageNumber(1); setZoom(1); setPan({ x: 0, y: 0 }); setTool("pan") }}><RotateCcw />Reset</Button>
  <span aria-live="polite">{Math.round(zoom * 100)}%</span>
  <Button type="button" size="icon-sm" variant="ghost" aria-label="Previous PDF page" disabled={pageNumber <= 1} onClick={() => { setPageNumber((page) => page - 1); setZoom(1); setPan({ x: 0, y: 0 }) }}><ChevronLeft /></Button>
  <span>Page {pageNumber} of {pageCount}</span>
  <Button type="button" size="icon-sm" variant="ghost" aria-label="Next PDF page" disabled={pageNumber >= pageCount} onClick={() => { setPageNumber((page) => page + 1); setZoom(1); setPan({ x: 0, y: 0 }) }}><ChevronRight /></Button>
</div>
```

For loading, show `Loader2` and “Loading source PDF…”. For failure, render **Retry preview** as `setAttempt(value => value + 1)` and `<a href={sourceUrl} target="_blank" rel="noreferrer">Open PDF <ExternalLink /></a>`.

- [ ] **Step 6: Add viewer CSS**

Replace the old `.review-pdf-object` rule with canvas-viewer rules:

```css
.pdf-review-viewer { height: calc(100% - 34px); min-height: 280px; display: flex; min-width: 0; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background: color-mix(in oklab, var(--border) 28%, var(--surface)); box-shadow: var(--elev-raised); }
.pdf-review-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); padding: var(--space-2); border-bottom: 1px solid var(--border); background: var(--surface); }
.pdf-review-toolbar svg { width: 13px; height: 13px; }
.pdf-review-viewport { position: relative; flex: 1; min-height: 0; overflow: hidden; touch-action: none; user-select: none; }
.pdf-review-canvas { position: absolute; left: 50%; top: 50%; display: block; transform-origin: center; box-shadow: var(--elev-raised); }
.pdf-review-viewport.is-pan { cursor: grab; }
.pdf-review-viewport.is-panning { cursor: grabbing; }
.pdf-review-viewport.is-box-zoom { cursor: crosshair; }
.pdf-review-selection { position: absolute; z-index: 2; border: 2px solid var(--accent); background: color-mix(in oklab, var(--accent) 15%, transparent); pointer-events: none; }
```

- [ ] **Step 7: Run focused tests and build**

Run: `npm test -- src/lib/pdf-review-geometry.test.ts src/components/pdf-review-viewer.test.ts`

Expected: geometry and component-contract tests PASS.

Run: `npm run build`

Expected: Next.js production build succeeds and resolves `pdfjs-dist/webpack.mjs` without worker or WASM errors.

- [ ] **Step 8: Commit the PDF viewer**

```bash
git add package.json package-lock.json src/components/pdf-review-viewer.tsx src/components/pdf-review-viewer.test.ts src/app/globals.css
git commit -m "feat: add box-zoom PDF review viewer"
```

---

### Task 4: Resizable Review Workspace Shell

**Files:**
- Create: `src/components/review-workspace.tsx`
- Create: `src/components/review-workspace.test.ts`
- Modify: `src/app/globals.css:998-1065`

**Interfaces:**
- Consumes: `pdf: ReactNode`, `children: ReactNode`, and `sourceFileName: string`.
- Produces: `<ReviewWorkspace />` with split, `pdf-collapsed`, and `pdf-full` modes.
- Uses: Task 2's `reviewSplitFromPointer` and `reviewSplitFromKey`.

- [ ] **Step 1: Write the failing shell contract test**

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const workspaceUrl = new URL("./review-workspace.tsx", import.meta.url)

test("review workspace exposes one PDF collapse control and an accessible resizer", () => {
  assert.equal(existsSync(workspaceUrl), true)
  if (!existsSync(workspaceUrl)) return
  const source = readFileSync(workspaceUrl, "utf8")
  assert.match(source, /role="separator"/)
  assert.match(source, /aria-valuemin=\{MIN_REVIEW_SPLIT\}/)
  assert.match(source, /aria-valuemax=\{MAX_REVIEW_SPLIT\}/)
  assert.match(source, /Collapse<\/Button>/)
  assert.match(source, /Show PDF<\/Button>/)
  assert.match(source, /Full PDF/)
  assert.match(source, /Exit full PDF/)
  assert.equal((source.match(/Collapse<\/Button>/g) ?? []).length, 1)
})
```

- [ ] **Step 2: Run the shell test and verify RED**

Run: `npm test -- src/components/review-workspace.test.ts`

Expected: FAIL because the workspace component does not exist.

- [ ] **Step 3: Implement workspace mode and resizer state**

```tsx
"use client"

import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChevronsLeft, Expand, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  MAX_REVIEW_SPLIT,
  MIN_REVIEW_SPLIT,
  reviewSplitFromKey,
  reviewSplitFromPointer,
} from "@/lib/pdf-review-geometry"

type ReviewWorkspaceMode = "split" | "pdf-collapsed" | "pdf-full"

export function ReviewWorkspace({ pdf, children, sourceFileName }: {
  pdf: ReactNode
  children: ReactNode
  sourceFileName: string
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const showPdfRef = useRef<HTMLButtonElement>(null)
  const fullPdfRef = useRef<HTMLButtonElement>(null)
  const exitFullPdfRef = useRef<HTMLButtonElement>(null)
  const [split, setSplit] = useState(50)
  const [mode, setMode] = useState<ReviewWorkspaceMode>("split")

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = bodyRef.current?.getBoundingClientRect()
    if (bounds) setSplit(reviewSplitFromPointer(event.clientX, bounds))
  }

  const handleSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = reviewSplitFromKey(split, event.key)
    if (next !== split) {
      event.preventDefault()
      setSplit(next)
    }
  }

  return (
    <div ref={bodyRef} className={`review-body review-workspace-${mode}`} style={mode === "split" ? { gridTemplateColumns: `minmax(0, ${split}fr) 8px minmax(0, ${100 - split}fr)` } : undefined}>
      {mode === "pdf-collapsed" ? <Button ref={showPdfRef} className="review-show-pdf" onClick={() => { setMode("split"); requestAnimationFrame(() => collapseRef.current?.focus()) }}><FileText />Show PDF</Button> : null}
      <section className="review-pdf-col" data-od-id="review-pdf-panel" aria-label="Original BOQ PDF" hidden={mode === "pdf-collapsed"}>
          <div className="review-panel-toolbar">
            <span className="review-source-filename" title={sourceFileName}>{sourceFileName}</span>
            <span className="review-pdf-display-actions">
              {mode === "pdf-full" ? <Button ref={exitFullPdfRef} size="sm" variant="outline" onClick={() => { setMode("split"); requestAnimationFrame(() => fullPdfRef.current?.focus()) }}>Exit full PDF</Button> : <>
                <Button ref={collapseRef} size="sm" variant="ghost" onClick={() => { setMode("pdf-collapsed"); requestAnimationFrame(() => showPdfRef.current?.focus()) }}><ChevronsLeft />Collapse</Button>
                <Button ref={fullPdfRef} size="sm" variant="outline" onClick={() => { setMode("pdf-full"); requestAnimationFrame(() => exitFullPdfRef.current?.focus()) }}><Expand />Full PDF</Button>
              </>}
            </span>
          </div>
          {pdf}
      </section>
      {mode === "split" ? <div className="review-resize-handle" role="separator" tabIndex={0} aria-label="Resize PDF and matching panels" aria-orientation="vertical" aria-valuemin={MIN_REVIEW_SPLIT} aria-valuemax={MAX_REVIEW_SPLIT} aria-valuenow={Math.round(split)} onKeyDown={handleSeparatorKey} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); resize(event) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event) }} onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}><span /></div> : null}
      <section className="review-data-col" data-od-id="review-data-panel" hidden={mode === "pdf-full"}>{children}</section>
    </div>
  )
}
```

- [ ] **Step 4: Add split, collapsed, full-PDF, and responsive CSS**

```css
.review-workspace-pdf-collapsed { position: relative; grid-template-columns: minmax(0, 1fr); padding-left: 42px; }
.review-workspace-pdf-full { grid-template-columns: minmax(0, 1fr); }
.review-show-pdf { position: absolute; z-index: 3; left: 0; top: var(--space-3); writing-mode: vertical-rl; }
.review-pdf-display-actions { display: inline-flex; align-items: center; gap: var(--space-1); }
.review-resize-handle { display: grid; place-items: center; background: var(--border-soft); cursor: col-resize; outline: none; }
.review-resize-handle:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.review-resize-handle span { width: 2px; height: 36px; border-radius: 2px; background: var(--border); }

@media (max-width: 768px) {
  .review-body { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: minmax(280px, 42%) minmax(0, 58%); }
  .review-resize-handle { display: none; }
  .review-workspace-pdf-full { grid-template-rows: minmax(0, 1fr); }
  .review-workspace-pdf-collapsed { grid-template-rows: minmax(0, 1fr); padding-left: 36px; }
}
```

- [ ] **Step 5: Run shell and geometry tests**

Run: `npm test -- src/lib/pdf-review-geometry.test.ts src/components/review-workspace.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit the workspace shell**

```bash
git add src/components/review-workspace.tsx src/components/review-workspace.test.ts src/app/globals.css
git commit -m "feat: add resizable BOQ review workspace"
```

---

### Task 5: Reuse Review State in Embedded Mode

**Files:**
- Modify: `src/components/review-panel.tsx:35-550`
- Modify: `src/components/standardization-review.tsx:11-263`
- Modify: `src/components/boq-ingestion-flow.test.ts:5-103`
- Modify: `src/components/review-panel-catalog-readiness.test.ts:5-17`
- Modify: `src/app/globals.css:998-1047`

**Interfaces:**
- Extends `ReviewPanelProps` with `variant?: "dialog" | "embedded"` and `onSaved?: (boq: Boq) => void`.
- Extends `StandardizationReviewProps` with `defaultOpen?: boolean`.
- Uses: `<ReviewWorkspace />` and `<PdfReviewViewer />` from Tasks 3 and 4.

- [ ] **Step 1: Update tests first for embedded review, immediate matching, and Save draft**

Add these assertions to `src/components/boq-ingestion-flow.test.ts`:

```ts
const pdfViewerSource = readFileSync(new URL("./pdf-review-viewer.tsx", import.meta.url), "utf8")

test("review renders the authenticated source through the application PDF viewer", () => {
  assert.match(reviewSource, /`\/api\/boqs\/\$\{encodeURIComponent\(boq\.id\)\}\/source`/)
  assert.match(reviewSource, /<PdfReviewViewer/)
  assert.match(pdfViewerSource, /Retry preview/)
  assert.match(pdfViewerSource, /Open PDF/)
  assert.match(reviewSource, /No source PDF is available for this legacy BOQ/)
  assert.doesNotMatch(reviewSource, /<object/)
  assert.doesNotMatch(reviewSource, /Sino-Thai|Ratchaphruek|GRAND TOTAL|Prepared by/)
})

test("embedded review uses the application PDF viewer and immediate matching", () => {
  assert.match(reviewSource, /variant\?: "dialog" \| "embedded"/)
  assert.match(reviewSource, /<ReviewWorkspace/)
  assert.match(reviewSource, /<PdfReviewViewer/)
  assert.match(reviewSource, /defaultOpen=\{variant === "embedded"\}/)
  assert.match(reviewSource, /Save draft/)
  assert.doesNotMatch(reviewSource, /<object/)
  assert.doesNotMatch(standardizationSource, /Review matches after save/)
  assert.match(pdfViewerSource, /Box Zoom/)
})
```

This replaces the existing `review embeds the authenticated source PDF` test at lines 50-58; do not leave its `<object>` expectation in the file.

Add these assertions to `src/components/review-panel-catalog-readiness.test.ts`:

```ts
assert.match(reviewSource, /variant === "embedded"/)
assert.match(reviewSource, /requireCatalogReadiness/)
assert.match(standardizationSource, /defaultOpen\?: boolean/)
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/components/boq-ingestion-flow.test.ts src/components/review-panel-catalog-readiness.test.ts`

Expected: FAIL on missing embedded props, old `<object>`, old review gate, and missing Save draft.

- [ ] **Step 3: Add embedded props and separate dialog-only focus behavior**

```ts
interface ReviewPanelProps {
  boq: Boq
  onClose: () => void
  onApproved: (boq: Boq) => void
  onSaved?: (boq: Boq) => void
  primaryActionLabel?: string
  requireCatalogReadiness?: boolean
  variant?: "dialog" | "embedded"
}
```

Default `variant = "dialog"`. Guard the focus capture, focus trap, and dialog-level `Escape` close effects with `if (variant !== "dialog") return`. Keep Box Zoom's `Escape` cancellation in `PdfReviewViewer`, where it prevents propagation only while a selection exists.

- [ ] **Step 4: Add one persistence function for Save draft and approval**

Replace `handleApprove` with:

```ts
const persistReview = async (status: Boq["status"]): Promise<Boq | null> => {
  if (status === "approved" && verification.hasBlockingIssues) return null
  setApproveLoading(true)
  setSaveError(null)
  try {
    const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, vendor, workType, date, status, sections: reviewSections }),
    })
    if (!response.ok) throw new Error(await readError(response, "The BOQ could not be saved. Try again."))
    return await response.json() as Boq
  } catch (error) {
    const message = error instanceof Error ? error.message : "The BOQ could not be saved. Try again."
    setSaveError(message)
    toast.error(message)
    return null
  } finally {
    setApproveLoading(false)
  }
}

const handleSaveDraft = async () => {
  const updated = await persistReview(boq.status === "approved" ? "approved" : "review")
  if (!updated) return
  onSaved?.(updated)
  toast.success("Review draft saved")
}

const handleApprove = async () => {
  const updated = await persistReview("approved")
  if (!updated) return
  const reviewCount = items.filter((item) => item.stdStatus !== "matched").length
  toast.success(reviewCount > 0 ? `BOQ approved · ${reviewCount} ${reviewCount === 1 ? "item" : "items"} sent to Catalog review` : "BOQ approved and linked to the Standard Catalog")
  onApproved(updated)
  onClose()
}
```

Render **Save draft** in embedded mode and keep the existing approval blockers on the approval button:

```tsx
{variant === "embedded" ? (
  <Button type="button" variant="outline" size="sm" onClick={() => void handleSaveDraft()} disabled={busy}>
    {approveLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
    Save draft
  </Button>
) : null}
```

- [ ] **Step 5: Compose the workspace and PDF viewer**

Replace the current hard-coded `.review-body` and PDF `<object>` with this `ReviewWorkspace` opening. Keep the current metadata, item table, matching, warnings, verification, and action JSX as the component's children; remove only its old `.review-data-col` wrapper.

```tsx
<ReviewWorkspace
  sourceFileName={boq.sourceFileName || "source.pdf"}
  pdf={hasSource ? (
    <PdfReviewViewer sourceUrl={sourceUrl} sourceFileName={boq.sourceFileName || "source.pdf"} resetKey={boq.id} />
  ) : (
    <div className="review-pdf-fallback" role="alert">
      <TriangleAlert aria-hidden="true" />
      <strong>No source PDF is available for this legacy BOQ.</strong>
      <span>The BOQ was created before source files were retained.</span>
    </div>
  )}
>
```

After that opening tag, the first child is the current `<div className="review-metadata">` block at line 369 and the last child is the current `<div className="review-actions">` block ending at line 514. Close the shell immediately after the actions:

```tsx
</ReviewWorkspace>
```

This is a mechanical reparenting of the current JSX. Do not create replacement components or duplicate the review logic.

The outer wrapper must be conditional:

```tsx
<div className={variant === "dialog" ? "modal-overlay review-overlay open" : "review-embedded"} data-od-id={variant === "dialog" ? "review-modal" : "review-workspace"} role={variant === "dialog" ? "dialog" : undefined} aria-modal={variant === "dialog" ? true : undefined} aria-labelledby="review-dialog-title">
```

Do not duplicate the metadata/items/matching JSX. Move the existing block once between the `ReviewWorkspace` tags. Remove `sourceAttempt`, `sourcePreviewFailed`, and `retrySourcePreview`; retry state now belongs only to `PdfReviewViewer`, and `sourceUrl` is the stable authenticated source endpoint.

- [ ] **Step 6: Open standardization immediately and remove the dead gate**

Change the prop and state initialization:

```tsx
interface StandardizationReviewProps {
  items: BoqItem[]
  onItemsChange: (items: BoqItem[]) => void
  onMatchRequest?: (item: BoqItem, index: number) => void
  onExcludeRequest?: (item: BoqItem, index: number, reason: string) => Promise<boolean>
  catalogBusyIndex?: number | null
  defaultOpen?: boolean
}

export function StandardizationReview({ items, onItemsChange, onMatchRequest, onExcludeRequest, catalogBusyIndex, defaultOpen = false }: StandardizationReviewProps) {
  const [open, setOpen] = useState(defaultOpen)
```

Delete `acceptAll` and the **Review matches after save** button. Keep **Run LLM on Unmatched**. Pass `defaultOpen={variant === "embedded"}` from `ReviewPanel`.

- [ ] **Step 7: Add embedded-height CSS**

```css
.review-embedded { height: calc(100dvh - var(--topbar-h) - var(--space-6) - var(--space-12)); min-height: 560px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--elev-raised); }
.review-embedded .review-panel { height: 100%; }

@media (max-width: 768px) {
  .review-embedded { height: calc(100dvh - var(--topbar-h) - (2 * var(--space-4))); min-height: 480px; }
}
```

- [ ] **Step 8: Run focused review tests and the full suite**

Run: `npm test -- src/components/boq-ingestion-flow.test.ts src/components/review-panel-catalog-readiness.test.ts src/components/pdf-review-viewer.test.ts src/components/review-workspace.test.ts`

Expected: all focused tests PASS.

Run: `npm test`

Expected: full suite PASS with no unhandled rejections.

- [ ] **Step 9: Commit the reusable review workspace**

```bash
git add src/components/review-panel.tsx src/components/standardization-review.tsx src/components/boq-ingestion-flow.test.ts src/components/review-panel-catalog-readiness.test.ts src/app/globals.css
git commit -m "feat: embed BOQ matching review workspace"
```

---

### Task 6: Post-Parse Navigation and Detail Review Mode

**Files:**
- Modify: `src/app/(authenticated)/boqs/page.tsx:3-93,255-296`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:3-15,95-175,590-641,1008-1014`
- Modify: `src/components/boq-ingestion-flow.test.ts`

**Interfaces:**
- Uses: `boqReviewHref`, `boqDetailHref`, and `isBoqReviewMode` from Task 1.
- Uses: `ReviewPanel variant="embedded"` from Task 5.
- Produces: successful import and later Review links target the same canonical URL.

- [ ] **Step 1: Add failing navigation assertions**

Extend `src/components/boq-ingestion-flow.test.ts`:

```ts
const detailPageSource = readFileSync(new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url), "utf8")

test("successful import and later Review use the canonical detail review route", () => {
  assert.match(boqsPageSource, /useRouter\(\)/)
  assert.match(boqsPageSource, /router\.push\(boqReviewHref\(boq\.id\)\)/)
  assert.match(boqsPageSource, /href=\{boqReviewHref\(boq\.id\)\}/)
  assert.doesNotMatch(boqsPageSource, /setReviewBoq/)
  assert.doesNotMatch(boqsPageSource, /<ReviewPanel/)
  assert.match(detailPageSource, /isBoqReviewMode\(searchParams\)/)
  assert.match(detailPageSource, /variant="embedded"/)
  assert.match(detailPageSource, /requireCatalogReadiness/)
})
```

- [ ] **Step 2: Run the navigation test and verify RED**

Run: `npm test -- src/components/boq-ingestion-flow.test.ts`

Expected: FAIL because the list still opens local modal state and the detail page does not read `mode=review`.

- [ ] **Step 3: Navigate from the BOQs page after import**

In `src/app/(authenticated)/boqs/page.tsx`, import `useRouter` from `next/navigation` and `boqReviewHref`. Remove the `ReviewPanel` import and `reviewBoq` state. Add:

```tsx
const router = useRouter()

const handleUploadComplete = (boq: Boq) => {
  router.push(boqReviewHref(boq.id))
}
```

Replace the row Review button with:

```tsx
<Link href={boqReviewHref(boq.id)} className="btn btn-ghost btn-xs">
  <Eye className="w-3.5 h-3.5" /> Review
</Link>
```

Delete the list-page `<ReviewPanel>` block. Leave `UploadModal` responsible for closing itself after invoking `onUploadComplete`; failed imports never call the callback and therefore never navigate.

- [ ] **Step 4: Read review mode safely in the client detail route**

Import `Suspense`, `useRouter`, `useSearchParams`, and the route helpers. Wrap the existing client content so `useSearchParams` has the production-required Suspense boundary:

```tsx
export default function BoqDetailPage() {
  return (
    <Suspense fallback={<div className="proto-loading-state"><div><Loader2 className="animate-spin" />Loading BOQ…</div></div>}>
      <BoqDetailContent />
    </Suspense>
  )
}

function BoqDetailContent() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string
  const reviewMode = isBoqReviewMode(searchParams)
```

Keep all existing detail state and handlers inside `BoqDetailContent`.

- [ ] **Step 5: Render embedded review after canonical BOQ load**

After loading/not-found guards and before the normal detail return, add:

```tsx
if (reviewMode && boq.status !== "approved" && boq.sourceAvailable) {
  return (
    <ReviewPanel
      boq={boq}
      variant="embedded"
      requireCatalogReadiness
      primaryActionLabel="Approve BOQ"
      onSaved={setBoq}
      onApproved={(updated) => {
        setBoq(updated)
        router.replace(boqDetailHref(updated.id))
      }}
      onClose={() => router.replace(boqDetailHref(boq.id))}
    />
  )
}
```

Replace the normal detail-page **Review source** button with a `Link` to `boqReviewHref(boq.id)`. Remove `reviewOpen`, `setReviewOpen`, and the old modal block at the bottom of the page.

- [ ] **Step 6: Run navigation and route tests**

Run: `npm test -- src/lib/boq-review-route.test.ts src/components/boq-ingestion-flow.test.ts`

Expected: URL helper and integration contract tests PASS.

Run: `npm run lint`

Expected: ESLint exits 0 with no new hook dependency or accessibility errors.

Run: `npm run build`

Expected: Next.js production build succeeds; the detail route has a valid Suspense boundary for `useSearchParams`.

- [ ] **Step 7: Commit post-parse routing**

```bash
git add 'src/app/(authenticated)/boqs/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.tsx' src/components/boq-ingestion-flow.test.ts
git commit -m "feat: open parsed BOQs in detail review mode"
```

---

### Task 7: Full Regression and Browser Verification

**Files:**
- Modify only if verification exposes a defect in files already listed above.
- Update: `graphify-out/` through the required graph refresh command.

**Interfaces:**
- Consumes: the completed implementation from Tasks 1-6.
- Produces: verified upload-to-review behavior and a current project knowledge graph.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run lint`

Expected: ESLint exits 0.

Run: `npm run build`

Expected: Next.js 16.2.10 production build exits 0 without PDF worker, Suspense, type, or route errors.

- [ ] **Step 2: Start the app and Docling services**

Run in separate terminals:

```bash
npm run dev
npm run dev:docling
```

Expected: Next.js serves the authenticated app and Docling health is available on its configured local endpoint.

- [ ] **Step 3: Verify the successful import handoff in a browser**

Use an existing small PDF from `test-artifacts/` or a user-approved fixture. Verify:

1. Open `/boqs`, select **Upload BOQ**, choose the PDF, and click **Upload & Parse**.
2. Wait for parsing to complete.
3. Confirm the URL becomes `/boqs/{encoded-id}?mode=review` without another Review click.
4. Confirm the source PDF appears left and BOQ details, parsed items, and open Standardization matching appear right.
5. Confirm **Review matches after save** is absent.

Expected: the saved BOQ is loaded from its detail API and review controls are immediately usable.

- [ ] **Step 4: Verify split, collapse, and full PDF**

1. Drag the separator to both extremes and confirm it stops at 25% and 75%.
2. Focus the separator and use Arrow Left/Right, Home, and End.
3. Click **Collapse** and confirm only the PDF hides; click **Show PDF** and confirm the previous ratio returns.
4. Click **Full PDF** and confirm the matching panel hides inside the same route; click **Exit full PDF** and confirm the previous ratio returns.

Expected: no form value changes during any display operation.

- [ ] **Step 5: Verify Box Zoom and Pan**

1. Click **Box Zoom** and drag a rectangle around a specific PDF table row.
2. Confirm that region fills the viewport and the tool switches to Pan.
3. Click-drag the zoomed PDF and confirm the visible area moves.
4. Activate Box Zoom, begin a selection, press `Escape`, and confirm the selection disappears without changing zoom.
5. Drag a rectangle smaller than 8×8 CSS pixels and confirm it is ignored.
6. Confirm **Zoom Out**, **Fit Page**, **Reset**, previous/next page, Collapse, and Full PDF preserve or reset state according to the specification.

Expected: the viewer remains recoverable and matching edits remain untouched.

- [ ] **Step 6: Verify failure and save paths**

1. Use browser request blocking for the source endpoint; confirm **Retry preview** and **Open PDF** appear while matching remains usable.
2. Enter metadata and item edits, trigger a failed save using request blocking, and confirm every edit remains.
3. Restore the request, click **Save draft**, reload review mode, and confirm the saved data returns.
4. Resolve required blockers, approve, and confirm the route returns to `/boqs/{id}` with approved data.
5. Return to the BOQ list and confirm a later Review action opens the same detail review route for an eligible BOQ.

Expected: errors never clear review data or PDF display state.

- [ ] **Step 7: Refresh the project knowledge graph**

Run: `graphify update .`

Expected: AST refresh completes successfully and `graphify-out/GRAPH_REPORT.md` reflects the new viewer, workspace, route helper, and relationships. Treat currently untracked `graphify-out/` files as workspace context and do not stage them without separate user authorization.

- [ ] **Step 8: Commit any verification-only fixes and graph refresh**

If Steps 1-7 required code corrections, rerun the affected failing test first, apply the minimal fix, rerun the full verification set, inspect `git diff --name-only`, then stage only these implementation paths (Git ignores listed paths without changes):

```bash
git add src/lib/boq-review-route.ts src/lib/boq-review-route.test.ts src/lib/pdf-review-geometry.ts src/lib/pdf-review-geometry.test.ts src/components/pdf-review-viewer.tsx src/components/pdf-review-viewer.test.ts src/components/review-workspace.tsx src/components/review-workspace.test.ts src/components/review-panel.tsx src/components/standardization-review.tsx src/components/boq-ingestion-flow.test.ts src/components/review-panel-catalog-readiness.test.ts 'src/app/(authenticated)/boqs/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.tsx' src/app/globals.css package.json package-lock.json
git commit -m "fix: complete BOQ review workspace verification"
```

If no corrections were needed, do not create an empty commit. Do not stage unrelated dirty-worktree files or untracked graph outputs.
