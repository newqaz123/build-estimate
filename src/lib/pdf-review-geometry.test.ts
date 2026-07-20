import assert from "node:assert/strict"
import test from "node:test"
import {
  clampPdfPan,
  clipSelectionToPage,
  clampReviewSplit,
  deriveBoxZoom,
  pdfPageBounds,
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
    { zoom: 4, pan: { x: 800, y: 600 } },
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

test("box zoom preserves the selected source area with existing pan and a zoom ceiling", () => {
  assert.deepEqual(
    deriveBoxZoom({
      selection: { x: 300, y: 200, width: 200, height: 200 },
      viewport: { width: 800, height: 600 },
      zoom: 2,
      pan: { x: 30, y: -20 },
    }),
    { zoom: 6, pan: { x: 90, y: -60 } },
  )

  assert.deepEqual(
    deriveBoxZoom({
      selection: { x: 100, y: 100, width: 100, height: 100 },
      viewport: { width: 800, height: 600 },
      zoom: 7,
      pan: { x: 0, y: 0 },
    }),
    { zoom: 8, pan: { x: 2000 / 7, y: 1200 / 7 } },
  )
})

test("pan adds pointer deltas without changing zoom", () => {
  assert.deepEqual(panPdf({ x: -20, y: 12 }, { x: 35, y: -8 }), { x: 15, y: 4 })
})

test("PDF pan stays centered at fit and clamps extreme movement at high zoom", () => {
  assert.deepEqual(
    clampPdfPan({ x: 500, y: -500 }, { width: 760, height: 560 }, { width: 800, height: 600 }),
    { x: 0, y: 0 },
  )
  assert.deepEqual(
    clampPdfPan({ x: 5_000, y: -5_000 }, { width: 1_600, height: 1_200 }, { width: 800, height: 600 }),
    { x: 400, y: -300 },
  )
})

test("PDF pan re-clamps when the viewport grows", () => {
  assert.deepEqual(
    clampPdfPan({ x: 400, y: -300 }, { width: 1_600, height: 1_200 }, { width: 1_200, height: 900 }),
    { x: 200, y: -150 },
  )
})

test("box selections are clipped to the centered rendered page and blank drags are ignored", () => {
  const page = pdfPageBounds(
    { width: 800, height: 600 },
    { width: 600, height: 500 },
    { x: 0, y: 0 },
  )
  assert.deepEqual(page, { x: 100, y: 50, width: 600, height: 500 })
  assert.deepEqual(
    clipSelectionToPage({ x: 50, y: 20, width: 200, height: 100 }, page),
    { x: 100, y: 50, width: 150, height: 70 },
  )
  assert.equal(
    clipSelectionToPage({ x: 0, y: 0, width: 80, height: 40 }, page),
    null,
  )
})
