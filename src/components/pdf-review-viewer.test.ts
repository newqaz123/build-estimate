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
