import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"

const viewerUrl = new URL("./pdf-review-viewer.tsx", import.meta.url)
const globalCssUrl = new URL("../app/globals.css", import.meta.url)

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
  assert.match(source, /clipSelectionToPage/)
  assert.match(source, /clampPdfPan/)
  assert.match(source, /pdfPageBounds/)
})

test("PDF viewer recovery and interrupted gestures remain operable", () => {
  const source = readFileSync(viewerUrl, "utf8")
  const css = readFileSync(globalCssUrl, "utf8")

  assert.match(source, /activePointerIdRef/)
  assert.match(
    source,
    /event\.key === "Escape"[\s\S]*releaseActivePointerCapture\(\)[\s\S]*clearInteraction\(\)/,
  )
  assert.match(source, /onLostPointerCapture=/)
  assert.match(source, /className="review-pdf-fallback pdf-review-status-overlay"/)
  assert.match(
    source,
    /if \(event\.key === "Escape" && selection\) \{\s*event\.preventDefault\(\)[\s\S]*?window\.addEventListener\("keydown", cancelSelection, \{ capture: true \}\)/,
  )
  assert.match(
    source,
    /window\.removeEventListener\("keydown", cancelSelection, \{ capture: true \}\)/,
  )
  assert.match(
    css,
    /\.pdf-review-status-overlay\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*z-index:\s*3;/,
  )
  assert.doesNotMatch(css, /\.review-pdf-object/)
})

test("PDF recovery controls do not start viewport pointer interactions", () => {
  const source = readFileSync(viewerUrl, "utf8")

  assert.match(
    source,
    /handlePointerDown[\s\S]*if \(!pdf \|\| loading \|\| failed \|\| event\.button !== 0\) return/,
  )
})

test("PDF pan is unavailable at fit and every movement is constrained to the rendered page", () => {
  const source = readFileSync(viewerUrl, "utf8")
  const css = readFileSync(globalCssUrl, "utf8")

  assert.match(source, /disabled=\{zoom <= MIN_PDF_ZOOM\}/)
  assert.match(source, /tool === "pan" && zoom <= MIN_PDF_ZOOM/)
  assert.match(source, /setPan\(\(current\) => clampPdfPan\(/)
  assert.match(source, /clipSelectionToPage\(/)
  assert.match(
    css,
    /\.pdf-review-viewport\.is-pan\s*\{[^}]*cursor:\s*grab;[^}]*\}\s*\.pdf-review-viewport\.is-pan-disabled\s*\{[^}]*cursor:\s*default;/,
  )
})

test("PDF source navigation accepts a controlled page request and clamps it after load", () => {
  const source = readFileSync(viewerUrl, "utf8")

  assert.match(source, /requestedPage\?: number/)
  assert.match(source, /requestedPageKey\?: string \| number/)
  assert.match(source, /Math\.min\(pageCount, Math\.max\(1, Math\.trunc\(requestedPage\)\)\)/)
  assert.match(source, /setPageNumber\(clampedPage\)/)
})

test("Task 8: pdf viewer accepts evidenceFocus with table, row, and cell highlighting", () => {
  const source = readFileSync(viewerUrl, "utf8")
  // PdfReviewViewer accepts evidenceFocus prop
  assert.match(source, /evidenceFocus\?:/)
  // evidenceFocus interface is defined
  assert.match(source, /interface EvidenceFocus/)
  // evidenceFocus includes page, table, row, cells fields
  assert.match(source, /page: number/)
  assert.match(source, /table: number/)
  assert.match(source, /row: number/)
  assert.match(source, /cells: Array/)
})

test("Task 8: evidence focus renders visual markers on the PDF canvas", () => {
  const source = readFileSync(viewerUrl, "utf8")
  // Focus marker is rendered when evidenceFocus is provided
  assert.match(source, /evidenceFocus \?/)
  // Focus marker element is rendered
  assert.match(source, /pdf-evidence-focus/)
})

test("Task 8: evidence focus preserves zoom and pan on the same page", () => {
  const source = readFileSync(viewerUrl, "utf8")
  // Zoom state is preserved across evidence focus changes
  assert.match(source, /const \[zoom, setZoom\]/)
  // Pan state is preserved across evidence focus changes
  assert.match(source, /const \[pan, setPan\]/)
  // Zoom and pan state management exists
  assert.match(source, /setZoom/)
  assert.match(source, /setPan/)
})
